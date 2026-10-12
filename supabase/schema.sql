-- Run this entire file in Supabase Dashboard > SQL Editor.
-- It is safe to run more than once, and safe to run on a database that already
-- has some of these tables: every statement is "create if not exists" or
-- "add column if not exists".
-- Each user can read and modify only their own rows.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  daily_loss_limit numeric(12,2) not null default 300 check (daily_loss_limit > 0),
  max_trades integer not null default 2 check (max_trades between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists current_equity numeric(14,2) not null default 0;
-- Normal position size in LOTS (decimals allowed, e.g. 0.80). The size guard steps DOWN from this after a loss.
-- The column keeps its original name, base_contracts, but stores lots.
alter table public.profiles add column if not exists base_contracts numeric(10,2) not null default 1;
alter table public.profiles drop constraint if exists profiles_base_contracts_check;
alter table public.profiles alter column base_contracts type numeric(10,2) using base_contracts::numeric;
alter table public.profiles add constraint profiles_base_contracts_check check (base_contracts >= 0.01 and base_contracts <= 100);

-- Optional daily goal: none, a fixed amount, or a percent of balance (compounding).
alter table public.profiles add column if not exists goal_mode text;
alter table public.profiles add column if not exists goal_value numeric(14,2);
update public.profiles set goal_mode = 'percent', goal_value = 30 where goal_mode is null;
update public.profiles set goal_value = 0 where goal_value is null;
alter table public.profiles alter column goal_mode set default 'none';
alter table public.profiles alter column goal_mode set not null;
alter table public.profiles alter column goal_value set default 0;
alter table public.profiles alter column goal_value set not null;
alter table public.profiles drop constraint if exists profiles_goal_mode_check;
alter table public.profiles add constraint profiles_goal_mode_check check (goal_mode in ('none','amount','percent'));
alter table public.profiles drop constraint if exists profiles_goal_value_check;
alter table public.profiles add constraint profiles_goal_value_check check (goal_value >= 0 and (goal_mode <> 'percent' or goal_value <= 100));

-- ---------------------------------------------------------------------------
-- trades
-- ---------------------------------------------------------------------------
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
alter table public.trades add column if not exists trade_time time;
-- Exit date and time (optional), for trades held past the entry day or just to record when you got out.
-- A trade's profit or loss is booked on its exit date when one is logged.
alter table public.trades add column if not exists exit_date date;
alter table public.trades add column if not exists exit_time time;
alter table public.trades drop constraint if exists trades_exit_after_entry_check;
alter table public.trades add constraint trades_exit_after_entry_check check (exit_date is null or exit_date >= trade_date);
-- Position size actually used, in LOTS (decimals allowed), and whether it broke the size guard when logged.
-- The column keeps its original name, contracts, but stores lots.
alter table public.trades add column if not exists contracts numeric(10,2);
alter table public.trades drop constraint if exists trades_contracts_check;
alter table public.trades alter column contracts type numeric(10,2) using contracts::numeric;
alter table public.trades add constraint trades_contracts_check check (contracts is null or contracts >= 0.01);
alter table public.trades add column if not exists size_rule_broken boolean not null default false;

create index if not exists trades_user_date_idx on public.trades(user_id, trade_date desc);
create index if not exists trades_user_created_idx on public.trades(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- cash_movements (deposits / withdrawals)
-- NOTE: reconstructed from how the app uses this table. "if not exists" means
-- it will not touch a table you already created.
-- ---------------------------------------------------------------------------
create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  movement_date date not null default current_date,
  movement_type text not null check (movement_type in ('deposit','withdrawal')),
  amount numeric(14,2) not null check (amount > 0),
  notes text not null default '',
  created_at timestamptz not null default now()
);
-- True when a deposit was made on a day that was net negative at the time.
alter table public.cash_movements add column if not exists after_loss_day boolean not null default false;
create index if not exists cash_movements_user_date_idx on public.cash_movements(user_id, movement_date desc);

-- ---------------------------------------------------------------------------
-- compounding_days
-- NOTE: reconstructed from how the app uses this table.
-- ---------------------------------------------------------------------------
create table if not exists public.compounding_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_date date not null,
  starting_balance numeric(14,2) not null,
  target_percent numeric(6,2) not null default 30,
  closing_balance numeric(14,2),
  created_at timestamptz not null default now(),
  unique (user_id, trading_date)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.trades enable row level security;
alter table public.cash_movements enable row level security;
alter table public.compounding_days enable row level security;

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

drop policy if exists "Users can view their own cash movements" on public.cash_movements;
create policy "Users can view their own cash movements" on public.cash_movements for select using (auth.uid() = user_id);
drop policy if exists "Users can insert their own cash movements" on public.cash_movements;
create policy "Users can insert their own cash movements" on public.cash_movements for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own cash movements" on public.cash_movements;
create policy "Users can update their own cash movements" on public.cash_movements for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can delete their own cash movements" on public.cash_movements;
create policy "Users can delete their own cash movements" on public.cash_movements for delete using (auth.uid() = user_id);

drop policy if exists "Users can view their own compounding days" on public.compounding_days;
create policy "Users can view their own compounding days" on public.compounding_days for select using (auth.uid() = user_id);
drop policy if exists "Users can insert their own compounding days" on public.compounding_days;
create policy "Users can insert their own compounding days" on public.compounding_days for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own compounding days" on public.compounding_days;
create policy "Users can update their own compounding days" on public.compounding_days for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
