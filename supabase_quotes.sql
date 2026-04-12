-- ═══════════════════════════════════════════════════════════
--  Quote Registry — run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════

-- Named quotes table — one row per quote, shared within a shop
create table quotes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references shops(id) on delete cascade not null,
  created_by text not null,          -- clerk_user_id of creator
  created_by_email text,
  order_number text,
  job_name text,
  client_name text,
  address text,
  status text not null default 'draft',  -- draft, sent, approved, completed, cancelled
  quote_data jsonb,                  -- pages, shapes, measurements, slab layout
  form_data jsonb,                   -- materials, phones, notes
  pricing_data jsonb,                -- rates, cost items
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for fast search
create index idx_quotes_shop on quotes(shop_id);
create index idx_quotes_client on quotes(shop_id, client_name);
create index idx_quotes_job on quotes(shop_id, job_name);
create index idx_quotes_order on quotes(shop_id, order_number);
create index idx_quotes_status on quotes(shop_id, status);
create index idx_quotes_updated on quotes(shop_id, updated_at desc);

-- RLS — users can read/write quotes in their shop
alter table quotes enable row level security;
create policy "quotes_select" on quotes for select using (true);
create policy "quotes_insert" on quotes for insert with check (true);
create policy "quotes_update" on quotes for update using (true);
create policy "quotes_delete" on quotes for delete using (true);
