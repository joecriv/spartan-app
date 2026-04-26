-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: trim quotes_history to reduce Disk IO + storage
-- Runs ONCE in the shared Supabase SQL Editor for all three shops.
--
-- Two changes vs. the original trigger:
--   1. Strip embedded slab base64 (slabDefs[i].bgImage) before archiving.
--      These are the biggest space hogs in each row and are recoverable
--      from the live quotes row, not from history.
--   2. Cap quotes_history at 50 rows per quote_id. Older snapshots are
--      pruned at the end of each trigger run.
-- ═══════════════════════════════════════════════════════════════

create or replace function snapshot_quote_history() returns trigger as $$
declare
    trimmed_quote_data jsonb;
    new_history_id uuid;
begin
    -- Deep-copy quote_data and strip large base64 fields from each slab.
    -- The path is quote_data.slabDefs[*].bgImage. We rebuild slabDefs
    -- with bgImage replaced by null when it's a string longer than ~1KB.
    trimmed_quote_data := OLD.quote_data;
    if trimmed_quote_data is not null and trimmed_quote_data ? 'slabDefs' then
        trimmed_quote_data := jsonb_set(
            trimmed_quote_data,
            '{slabDefs}',
            (
                select coalesce(jsonb_agg(
                    case
                        when (sd ? 'bgImage')
                            and jsonb_typeof(sd->'bgImage') = 'string'
                            and length(sd->>'bgImage') > 1024
                        then jsonb_set(sd, '{bgImage}', 'null'::jsonb)
                        else sd
                    end
                ), '[]'::jsonb)
                from jsonb_array_elements(trimmed_quote_data->'slabDefs') sd
            ),
            false
        );
    end if;

    insert into quotes_history (
        quote_id, shop_id, order_number, job_name, client_name, address,
        status, quote_data, form_data, pricing_data,
        created_by, created_by_email, created_at, updated_at, deleted_at
    ) values (
        OLD.id, OLD.shop_id, OLD.order_number, OLD.job_name, OLD.client_name, OLD.address,
        OLD.status, trimmed_quote_data, OLD.form_data, OLD.pricing_data,
        OLD.created_by, OLD.created_by_email, OLD.created_at, OLD.updated_at, OLD.deleted_at
    ) returning history_id into new_history_id;

    -- Cap retention: keep only the 50 most recent snapshots per quote_id.
    delete from quotes_history
    where quote_id = OLD.id
      and history_id not in (
          select history_id
          from quotes_history
          where quote_id = OLD.id
          order by snapshot_at desc
          limit 50
      );

    return NEW;
end;
$$ language plpgsql security definer;

-- Trigger binding stays the same (BEFORE UPDATE on quotes) — function
-- replaced above so existing trigger picks up the new logic on next save.

-- ═══════════════════════════════════════════════════════════════
-- One-time backfill: strip base64 from existing history rows so the
-- benefit applies retroactively to old snapshots.
-- ═══════════════════════════════════════════════════════════════
update quotes_history
set quote_data = jsonb_set(
    quote_data,
    '{slabDefs}',
    (
        select coalesce(jsonb_agg(
            case
                when (sd ? 'bgImage')
                    and jsonb_typeof(sd->'bgImage') = 'string'
                    and length(sd->>'bgImage') > 1024
                then jsonb_set(sd, '{bgImage}', 'null'::jsonb)
                else sd
            end
        ), '[]'::jsonb)
        from jsonb_array_elements(quote_data->'slabDefs') sd
    ),
    false
)
where quote_data is not null
  and quote_data ? 'slabDefs'
  and exists (
      select 1
      from jsonb_array_elements(quote_data->'slabDefs') sd
      where sd ? 'bgImage'
        and jsonb_typeof(sd->'bgImage') = 'string'
        and length(sd->>'bgImage') > 1024
  );

-- ═══════════════════════════════════════════════════════════════
-- One-time retention prune: cap each existing quote at 50 history rows.
-- ═══════════════════════════════════════════════════════════════
delete from quotes_history
where history_id not in (
    select history_id from (
        select history_id,
               row_number() over (partition by quote_id order by snapshot_at desc) as rn
        from quotes_history
    ) ranked
    where rn <= 50
);

-- ═══════════════════════════════════════════════════════════════
-- DONE. Future saves archive trimmed data (no embedded slab base64),
-- and history is auto-capped at 50 snapshots per quote. Existing rows
-- have been backfilled so disk usage drops immediately.
-- ═══════════════════════════════════════════════════════════════
