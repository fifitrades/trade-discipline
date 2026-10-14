# Trade Discipline — private trading journal

A mobile-friendly trading journal MVP built with Next.js, TypeScript, and Supabase. It focuses on P&L, entry confirmation, FOMO, rule violations, and pre-committed risk limits.

## Features

- Email/password sign-up and sign-in via Supabase Auth
- Private, user-scoped trade journal with Row Level Security
- Log date, symbol, direction, net P&L, emotion, valid setup, confirmation followed, and notes
- Dashboard P&L, average winning/losing trade, green/red days
- Behavioral breakdown of compliant versus rule-breaking trades
- FOMO, invalid setup, revenge/recovery, and trade-number signals
- Configurable daily loss limit and daily trade cap
- Responsive black and champagne-gold styling
- Entry and exit date/time on every trade, with time held; profit or loss is booked on the exit date
- Optional daily goal: none, a fixed amount, or compounding (a percent of your live balance), set by each user in their risk guardrails
- Capital-protection rules (position size in lots, decimals like 0.80 allowed): size can only go down after a loss, session locks after 2 losses in a row, at the daily target, or after giving back half of the day's peak profit, 30-minute cooldown after every loss, oversized trades flagged automatically
- Status banner (GO / WAIT / DONE / STOP) pinned to the very top of the app, so a reached target or a lockout is the first thing you see
- Import trades: upload a broker history CSV (MetaTrader-style columns), review a preview, and save to your own login only. Duplicates are skipped, so re-importing is safe
- Equity is calculated automatically (deposits − withdrawals + all logged trades), with nothing to type in
- Deposit friction: depositing on a losing day needs an acknowledgement and is tracked ("Deposited after red days")

## Important limitation

This is a journal and behavioral support tool, not a broker connection. Its guardrails are client-side prompts and form checks; they **cannot stop orders on your brokerage platform**. Configure any broker-side risk controls available and do not rely on this app as a financial safety lock. P&L fields are manually entered; currency display currently uses CAD.

## Setup

### 1. Create a Supabase project

Create a project at https://supabase.com. In **Project Settings → API** (or the project's Connect/API section), copy the project URL and publishable/anon key.

### 2. Create the database tables

In Supabase, open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and run it. This creates the `profiles`, `trades`, `cash_movements` and `compounding_days` tables with Row Level Security policies. It is safe to re-run on a database that already has some of them.

**Upgrading an existing database?** Run `supabase/capital-protection-migration.sql` in the SQL Editor *before* deploying the new app code. It adds the columns the size guard and deposit tracking need.

### 3. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your project URL and publishable/anon key:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

Never put a Supabase service-role key in a browser app or commit real secrets to GitHub.

### 4. Run locally

Install Node.js LTS (if it is not installed), then in this folder run:

```bash
npm install
npm run dev
```

Open http://localhost:3000.

### 5. Deploy

1. Push this project to a private GitHub repository.
2. In Vercel, import that repository.
3. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel's Environment Variables.
4. Deploy.
5. In Supabase Auth settings, configure the site URL and allowed redirect URLs for your deployed Vercel domain.

## How to use the journal

1. Log every trade, including trades that broke your rules.
2. Set the daily loss limit and maximum trades before the session. The default is $300 and two trades, but these are placeholders—not personalized financial advice. Choose a limit based on account equity, affordable risk, instrument/contract value, and your own rules.
3. Mark “My setup was valid” and “I waited for confirmation” honestly.
4. Use the Behavior Analysis section to compare P&L on compliant trades versus trades where either rule was broken.
5. Review weekly, not while emotionally activated after a loss.

## Current scope / next upgrades

- Add edit/delete trade controls and CSV export
- Add end-of-day review and pre-market commitment
- Add daily P&L chart, best trading time, and performance by trade number
- Add optional screenshots
- Add server-side enforcement/audit logic for journal limits (still cannot enforce broker orders without broker-side support)
- Add automated imports only if the broker offers a safe, supported export/API flow

### Exporting data for analysis

Use **Export CSV** in Trade History to download your logged trades. You can upload that CSV into ChatGPT for a weekly or monthly review. The app does not automatically share your Supabase data with ChatGPT; you choose when to export and share it.
