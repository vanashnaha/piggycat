-- =====================================================================
-- Piggycat — Supabase schema
-- ---------------------------------------------------------------------
-- Run this whole file once in your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run.
--
-- Model:
--   profiles  one row per signed-up user (created by trigger below)
--   pets      ONE Piggycat per user — user_id is UNIQUE, so a second
--             Piggycat for the same person is impossible at the
--             database level, exactly like the app's "one Piggycat,
--             one person, for life" rule. The pet's full game state
--             (needs, bond, personality, chat, MEMORIES, milestones,
--             wardrobe mirror) lives in pets.state jsonb — messages and
--             memories intentionally live inside that jsonb rather than
--             their own tables in v1: they are only ever read/written
--             as part of the whole pet. name + genome are also broken
--             out into real columns for easy querying.
--   coats     every coat rolled by the server function (and Super Rare
--             coats registered for trading). `serial` is the unique
--             client-facing coat ID (e.g. COAT-XXXXXX-YYYY).
--   trades    Super Rare coat trades between users. A trade moves a
--             COAT — never a pet. pets rows never change owner.
--
-- Security: Row Level Security is ON for every table. A signed-in user
-- can only see/touch their own rows (auth.uid()). The Netlify
-- Functions use the SERVICE ROLE key, which bypasses RLS — that is how
-- they enforce the weekly roll cooldown and move coats between users,
-- and why that key must never be shipped to the browser.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- updated_at helper ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);
comment on table public.profiles is 'One profile per signed-up user; created automatically on signup.';

-- ---------- pets (exactly one Piggycat per user) ----------
create table if not exists public.pets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users (id) on delete cascade,
  name          text not null default 'Piggycat',
  genome        jsonb not null default '[]'::jsonb,  -- permanent 8-locus genome; never trades, never changes
  state         jsonb not null default '{}'::jsonb, -- full game state mirror: needs, bond, personality, memories, chat, wardrobe, milestones
  last_roll_at  timestamptz,                          -- server-authoritative weekly Randomize cooldown
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.pets is 'Exactly one Piggycat per user (user_id UNIQUE). Bonded for life; this row NEVER transfers between users.';
comment on column public.pets.state is 'Whole-pet jsonb state, mirroring the client save. Messages/memories live in here by design (v1).';

-- ---------- coats ----------
create table if not exists public.coats (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  tier          text not null check (tier in ('Standard','Uncommon','Rare','Epic','Legendary','Super Rare')),
  coat          jsonb not null,                       -- full coat object in the client's coat shape
  is_super_rare boolean not null default false,
  serial        text not null unique,                 -- unique coat serial = client coat ID
  trade_status  text not null default 'owned' check (trade_status in ('owned','listed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.coats is 'Individual coats. Only Super Rare coats (is_super_rare) may be traded, via the trades table.';

-- ---------- trades ----------
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,                   -- PC-TRADE-… code the giver shares
  coat_id     uuid not null references public.coats (id) on delete cascade,
  from_user   uuid not null references auth.users (id) on delete cascade,
  to_user     uuid references auth.users (id) on delete set null,
  status      text not null default 'open' check (status in ('open','redeemed','cancelled')),
  created_at  timestamptz not null default now(),
  redeemed_at timestamptz
);
comment on table public.trades is 'Super Rare coat trades between two users. Moves a coat row only — never a Piggycat.';

-- ---------- indexes ----------
create index if not exists pets_user_idx      on public.pets (user_id);
create index if not exists coats_owner_idx    on public.coats (owner_id);
create index if not exists coats_serial_idx   on public.coats (serial);
create index if not exists trades_code_idx    on public.trades (code);
create index if not exists trades_status_idx  on public.trades (status);
create index if not exists trades_coat_idx    on public.trades (coat_id);
create index if not exists trades_from_idx    on public.trades (from_user);

-- ---------- updated_at triggers ----------
drop trigger if exists pets_set_updated_at on public.pets;
create trigger pets_set_updated_at
  before update on public.pets
  for each row execute function public.set_updated_at();

drop trigger if exists coats_set_updated_at on public.coats;
create trigger coats_set_updated_at
  before update on public.coats
  for each row execute function public.set_updated_at();

-- ---------- profile on signup ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- Row Level Security — owner-only for everything.
-- The service role key (Netlify Functions) bypasses RLS automatically;
-- no policy below grants it anything, and none is needed.
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.pets     enable row level security;
alter table public.coats    enable row level security;
alter table public.trades   enable row level security;

-- profiles: you can read/update only your own profile.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- (no insert/delete policy for users: the signup trigger creates rows)

-- pets: full CRUD on your own one Piggycat, nothing on anyone else's.
drop policy if exists "pets_select_own" on public.pets;
create policy "pets_select_own" on public.pets
  for select using (auth.uid() = user_id);
drop policy if exists "pets_insert_own" on public.pets;
create policy "pets_insert_own" on public.pets
  for insert with check (auth.uid() = user_id);
drop policy if exists "pets_update_own" on public.pets;
create policy "pets_update_own" on public.pets
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "pets_delete_own" on public.pets;
create policy "pets_delete_own" on public.pets
  for delete using (auth.uid() = user_id);

-- coats: you own your coats; you cannot see another user's wardrobe.
drop policy if exists "coats_select_own" on public.coats;
create policy "coats_select_own" on public.coats
  for select using (auth.uid() = owner_id);
drop policy if exists "coats_insert_own" on public.coats;
create policy "coats_insert_own" on public.coats
  for insert with check (auth.uid() = owner_id);
drop policy if exists "coats_update_own" on public.coats;
create policy "coats_update_own" on public.coats
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "coats_delete_own" on public.coats;
create policy "coats_delete_own" on public.coats
  for delete using (auth.uid() = owner_id);

-- trades: you can see trades you gave or received, and create trades
-- for yourself. The actual create/redeem flow runs through the
-- Netlify Function with the service role, so these policies are a
-- read/back-office convenience, not the transfer mechanism.
drop policy if exists "trades_select_party" on public.trades;
create policy "trades_select_party" on public.trades
  for select using (auth.uid() = from_user or auth.uid() = to_user);
drop policy if exists "trades_insert_own" on public.trades;
create policy "trades_insert_own" on public.trades
  for insert with check (auth.uid() = from_user);
drop policy if exists "trades_update_party" on public.trades;
create policy "trades_update_party" on public.trades
  for update using (auth.uid() = from_user or auth.uid() = to_user)
  with check (auth.uid() = from_user or auth.uid() = to_user);
