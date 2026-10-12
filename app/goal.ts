// Daily goal maths. Pure functions, no React or Supabase, so they are easy to test.

export type GoalMode = 'none' | 'amount' | 'percent';

type Money = { movement_date: string; movement_type: 'deposit' | 'withdrawal'; amount: number | string };
type Pnl = { trade_date: string; pnl: number | string };

const signed = (m: Money) => (m.movement_type === 'deposit' ? 1 : -1) * Number(m.amount);

/**
 * The balance the day STARTED with: everything deposited minus withdrawn before today, plus the P&L of trades
 * before today. Deposits made today are not counted, so adding money mid-day cannot raise today's target.
 * Exception: on a brand-new account whose only money arrived today, today's deposits count so there is a base to work from.
 * If no deposits are recorded at all, the saved snapshot (built from saved equity) is used instead.
 */
export function dayStartBalance(cash: Money[], trades: Pnl[], today: string, snapshot: number): number {
  const hasDeposits = cash.some(m => m.movement_type === 'deposit');
  if (!hasDeposits) return Math.max(0, snapshot);
  const pnlBefore = trades.filter(t => t.trade_date < today).reduce((s, t) => s + Number(t.pnl), 0);
  const before = cash.filter(m => m.movement_date < today).reduce((s, m) => s + signed(m), 0) + pnlBefore;
  if (before > 0) return before;
  const through = cash.filter(m => m.movement_date <= today).reduce((s, m) => s + signed(m), 0) + pnlBefore;
  return Math.max(0, through);
}

/** Today's target in money. Zero means "no goal today". */
export function goalTarget(mode: GoalMode, value: number, startBalance: number): number {
  if (mode === 'amount') return Math.max(0, value);
  if (mode === 'percent') return Math.max(0, (startBalance * Math.max(0, value)) / 100);
  return 0;
}

/** Highest running P&L reached at any point today, in trade order. Never below zero. */
export function runningPeak(pnlsInOrder: number[]): number {
  let run = 0;
  let peak = 0;
  for (const p of pnlsInOrder) {
    run += p;
    if (run > peak) peak = run;
  }
  return peak;
}

/**
 * The goal counts as reached once the day's running P&L has touched the target at any point, and it STAYS reached
 * for the rest of the day, even if a later trade takes P&L back below it. Tomorrow it is recalculated.
 */
export function goalReached(target: number, peak: number): boolean {
  return target > 0 && peak >= target;
}
