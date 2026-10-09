-- Run this entire file in Supabase Dashboard > SQL Editor.
-- Each user can read and modify only their own profile and trades.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  daily_loss_limit numeric(12,2) not null default 300 check (daily_loss_limit > 0),
  max_trades integer not null default 2 check (max_trades between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_date date not null default current_date,
  symbol text not null default 'XAUUSD',
  direction text not null check (direction in ('Long','Short')),
  pnl numeric(12,2) not null,
  setup_valid boolean not null default true,
  confirmation_waited boolean not null default true,
  emotion text not null default 'Calm',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists trades_user_date_idx on public.trades(user_id, trade_date desc);
create index if not exists trades_user_created_idx on public.trades(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.trades enable row level security;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile" on public.profiles for insert with check (auth.uid() = id);
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "Users can view their own trades" on public.trades;
create policy "Users can view their own trades" on public.trades for select using (auth.uid() = user_id);
drop policy if exists "Users can insert their own trades" on public.trades;
create policy "Users can insert their own trades" on public.trades for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own trades" on public.trades;
create policy "Users can update their own trades" on public.trades for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can delete their own trades" on public.trades;
create policy "Users can delete their own trades" on public.trades for delete using (auth.uid() = user_id);
