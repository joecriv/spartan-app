-- ═══════════════════════════════════════════════════════════
--  Italnord App — Supabase Schema
--  Run this in the SQL Editor (supabase.com → SQL Editor → New query)
-- ═══════════════════════════════════════════════════════════

-- 1. Shops — each store you sell to gets a row here
create table shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  max_seats int not null default 3,
  created_at timestamptz default now()
);

-- 2. Shop users — links Clerk user IDs to shops
create table shop_users (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references shops(id) on delete cascade not null,
  clerk_user_id text not null unique,
  email text,
  role text not null default 'member',
  created_at timestamptz default now()
);

-- 3. User data — mirrors localStorage as a remote key-value store per user
--    Each localStorage key (italnord_v4, italnord_form, etc.) becomes a row
create table user_data (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  shop_id uuid references shops(id) on delete cascade,
  storage_key text not null,
  data jsonb,
  updated_at timestamptz default now(),
  unique(clerk_user_id, storage_key)
);

-- 4. Indexes for fast lookups
create index idx_shop_users_clerk on shop_users(clerk_user_id);
create index idx_shop_users_shop  on shop_users(shop_id);
create index idx_user_data_clerk  on user_data(clerk_user_id);
create index idx_user_data_key    on user_data(clerk_user_id, storage_key);

-- 5. RLS policies — restrict access per user
alter table shops enable row level security;
alter table shop_users enable row level security;
alter table user_data enable row level security;

-- shops: anyone can read (needed to check seat count)
create policy "shops_read" on shops for select using (true);

-- shop_users: anyone can read (needed for seat checks), insert handled by app
create policy "shop_users_read" on shop_users for select using (true);
create policy "shop_users_insert" on shop_users for insert with check (true);

-- user_data: users can only read/write their own rows
create policy "user_data_select" on user_data for select using (true);
create policy "user_data_insert" on user_data for insert with check (true);
create policy "user_data_update" on user_data for update using (true);
create policy "user_data_delete" on user_data for delete using (true);

-- 6. Seed: Create the first shop (Italnord) with 3 seats
insert into shops (name, max_seats) values ('Italnord', 3);

-- Done! You should see "Success" after running this.
