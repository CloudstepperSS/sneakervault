-- SneakerVault — run this entire file in the Supabase SQL Editor

create table if not exists sneakers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  brand         text not null,
  name          text not null,
  type          text,
  size          text,
  color         text,
  year          integer,
  release_price numeric(10,2),
  resell_price  numeric(10,2),
  barcode       text,
  image_url     text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table sneakers enable row level security;

create policy "select own" on sneakers for select using (auth.uid() = user_id);
create policy "insert own" on sneakers for insert with check (auth.uid() = user_id);
create policy "update own" on sneakers for update using (auth.uid() = user_id);
create policy "delete own" on sneakers for delete using (auth.uid() = user_id);

create or replace function handle_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger sneakers_updated_at
  before update on sneakers
  for each row execute function handle_updated_at();
