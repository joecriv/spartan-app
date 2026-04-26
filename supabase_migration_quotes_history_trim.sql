-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: 1 history row per quote (replaces multi-row archive)
-- Run ONCE in the shared Supabase SQL Editor.
--
-- Previous behaviour: every UPDATE on quotes created a NEW row in
-- quotes_history. Over time this accumulated thousands of rows and
-- exhausted the project's Disk IO budget.
--
-- New behaviour: at most one history row per quote_id. Each save
-- UPSERTs (INSERT ... ON CONFLICT DO UPDATE) so the row is replaced
-- in place. No accumulation, fixed IO cost per save.
-- ═══════════════════════════════════════════════════════════════

-- 1. Backfill: keep only the most recent history row per quote_id.
delete from quotes_history
where history_id not in (
    select history_id from (
        select history_id,
               row_number() over (partition by quote_id order by snapshot_at desc) as rn
        from quotes_history
    ) ranked
    where rn = 1
);

-- 2. Strip embedded slab base64 from the surviving rows so they're small.
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

-- 3. Reclaim the freed disk space immediately.
vacuum (full, analyze) quotes_history;

-- 4. Add UNIQUE constraint so we can ON CONFLICT upsert.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'quotes_history_quote_id_unique'
    ) then
        alter table quotes_history
            add constraint quotes_history_quote_id_unique unique (quote_id);
    end if;
end $$;

-- 5. Replace the trigger function so each save UPSERTs the single
--    history row instead of inserting a new one.
create or replace function snapshot_quote_history() returns trigger as $$
declare
    trimmed_quote_data jsonb;
begin
    -- Strip embedded slab base64 (same as before — keeps rows small).
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

    -- UPSERT: replace existing history row for this quote, or insert if none.
    insert into quotes_history (
        quote_id, shop_id, order_number, job_name, client_name, address,
        status, quote_data, form_data, pricing_data,
        created_by, created_by_email, created_at, updated_at, deleted_at,
        snapshot_at
    ) values (
        OLD.id, OLD.shop_id, OLD.order_number, OLD.job_name, OLD.client_name, OLD.address,
        OLD.status, trimmed_quote_data, OLD.form_data, OLD.pricing_data,
        OLD.created_by, OLD.created_by_email, OLD.created_at, OLD.updated_at, OLD.deleted_at,
        now()
    )
    on conflict (quote_id) do update set
        shop_id          = excluded.shop_id,
        order_number     = excluded.order_number,
        job_name         = excluded.job_name,
        client_name      = excluded.client_name,
        address          = excluded.address,
        status           = excluded.status,
        quote_data       = excluded.quote_data,
        form_data        = excluded.form_data,
        pricing_data     = excluded.pricing_data,
        created_by       = excluded.created_by,
        created_by_email = excluded.created_by_email,
        created_at       = excluded.created_at,
        updated_at       = excluded.updated_at,
        deleted_at       = excluded.deleted_at,
        snapshot_at      = excluded.snapshot_at;

    return NEW;
end;
$$ language plpgsql security definer
   set search_path = public;  -- silence Function Search Path Mutable warning

-- ═══════════════════════════════════════════════════════════════
-- DONE. quotes_history now holds exactly one row per quote, replaced
-- in place on every save. Disk usage drops immediately and IO per
-- save is cut roughly in half.
-- ═══════════════════════════════════════════════════════════════
