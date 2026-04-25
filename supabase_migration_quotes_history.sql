-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: quote history (auto-recovery on accidental overwrite)
-- Runs ONCE in the shared Supabase SQL Editor for all three shops.
--
-- Creates a quotes_history table and a BEFORE UPDATE trigger so
-- every save snapshots the previous version of the quote. If a quote
-- ever gets overwritten with the wrong data (the "Finchley problem"),
-- the original row is recoverable from history — no paid backups
-- required.
-- ═══════════════════════════════════════════════════════════════

-- 1. History table — one row per UPDATE on quotes (the OLD version).
create table if not exists quotes_history (
    history_id        uuid primary key default gen_random_uuid(),
    quote_id          uuid not null,
    shop_id           uuid not null,
    snapshot_at       timestamptz not null default now(),
    -- snapshot of the row BEFORE the update:
    order_number      text,
    job_name          text,
    client_name       text,
    address           text,
    status            text,
    quote_data        jsonb,
    form_data         jsonb,
    pricing_data      jsonb,
    created_by        text,
    created_by_email  text,
    created_at        timestamptz,
    updated_at        timestamptz,
    deleted_at        timestamptz
);

create index if not exists idx_quotes_history_quote on quotes_history(quote_id, snapshot_at desc);
create index if not exists idx_quotes_history_shop  on quotes_history(shop_id,  snapshot_at desc);
create index if not exists idx_quotes_history_job   on quotes_history(shop_id,  job_name);
create index if not exists idx_quotes_history_client on quotes_history(shop_id, client_name);

-- 2. Trigger function — snapshots the OLD row before any UPDATE.
create or replace function snapshot_quote_history() returns trigger as $$
begin
    insert into quotes_history (
        quote_id, shop_id, order_number, job_name, client_name, address,
        status, quote_data, form_data, pricing_data,
        created_by, created_by_email, created_at, updated_at, deleted_at
    ) values (
        OLD.id, OLD.shop_id, OLD.order_number, OLD.job_name, OLD.client_name, OLD.address,
        OLD.status, OLD.quote_data, OLD.form_data, OLD.pricing_data,
        OLD.created_by, OLD.created_by_email, OLD.created_at, OLD.updated_at, OLD.deleted_at
    );
    return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_quotes_history on quotes;
create trigger trg_quotes_history
before update on quotes
for each row execute function snapshot_quote_history();

-- 3. RLS — anon key can READ history (for the recovery UI), but cannot
--    INSERT/UPDATE/DELETE history rows directly. Only the trigger writes,
--    and it runs with security definer so it bypasses RLS.
alter table quotes_history enable row level security;
drop policy if exists "quotes_history_select" on quotes_history;
create policy "quotes_history_select" on quotes_history for select using (true);

-- ═══════════════════════════════════════════════════════════════
-- DONE. Every save to the quotes table now writes the previous
-- version to quotes_history. Disk usage grows slowly — each snapshot
-- is one row of jsonb, the same size as the live row.
--
-- Optional future cleanup (run manually or via pg_cron):
--   delete from quotes_history where snapshot_at < now() - interval '90 days';
-- ═══════════════════════════════════════════════════════════════
