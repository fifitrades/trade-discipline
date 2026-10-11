// Pattern reports for the journal. Pure functions: they take the logged trades and return summaries,
// so they are easy to test and have no dependency on React or Supabase.

export type PatternTrade = {
  trade_date: string;          // YYYY-MM-DD
  trade_time?: string | null;  // HH:MM or HH:MM:SS
  pnl: number | string;
  created_at: string;
};

export type Bucket = {
  label: string;
  trades: number;
  pnl: number;       // total P&L in this bucket
  avg: number;       // average P&L per trade
  winRate: number;   // 0-100
};

/** Below this many trades in a row of a report, treat the numbers as too thin to draw conclusions from. */
export const MIN_SAMPLE = 5;

const orderInDay = (a: PatternTrade, b: PatternTrade) =>
  (a.trade_time ?? '').localeCompare(b.trade_time ?? '') || a.created_at.localeCompare(b.created_at);

function makeBucket(label: string, group: PatternTrade[]): Bucket {
  const pnls = group.map(t => Number(t.pnl));
  const total = pnls.reduce((s, n) => s + n, 0);
  const wins = pnls.filter(n => n > 0).length;
  return {
    label,
    trades: group.length,
    pnl: total,
    avg: group.length ? total / group.length : 0,
    winRate: group.length ? (wins / group.length) * 100 : 0,
  };
}

const hourLabel = (h: number) => {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${suffix}`;
};

/** Trades grouped by the hour they were taken. Trades with no time are counted separately. */
export function byHour(trades: PatternTrade[]): { buckets: Bucket[]; untimed: number } {
  const groups = new Map<number, PatternTrade[]>();
  let untimed = 0;
  for (const t of trades) {
    const h = t.trade_time ? parseInt(t.trade_time.slice(0, 2), 10) : NaN;
    if (!Number.isFinite(h) || h < 0 || h > 23) { untimed++; continue; }
    groups.set(h, [...(groups.get(h) ?? []), t]);
  }
  const buckets = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([h, g]) => makeBucket(hourLabel(h), g));
  return { buckets, untimed };
}

/** Trades grouped by their position in the day: 1st, 2nd, 3rd, and 4th-or-later. */
export function byTradeNumber(trades: PatternTrade[]): Bucket[] {
  const days = new Map<string, PatternTrade[]>();
  for (const t of trades) days.set(t.trade_date, [...(days.get(t.trade_date) ?? []), t]);
  const slots: PatternTrade[][] = [[], [], [], []];
  for (const dayTrades of days.values()) {
    [...dayTrades].sort(orderInDay).forEach((t, i) => slots[Math.min(i, 3)].push(t));
  }
  const labels = ['Trade 1', 'Trade 2', 'Trade 3', 'Trade 4+'];
  return slots.map((g, i) => makeBucket(labels[i], g)).filter(b => b.trades > 0);
}

export type DayGroup = {
  label: string;
  days: number;
  totalPnl: number;      // summed day P&L
  avgDayPnl: number;     // average P&L per day
  avgTrades: number;     // average number of trades per day
  greenDays: number;     // how many of these days finished positive
};

/**
 * Looks at each trading day and asks what happened the day before (the previous day that had trades):
 * was it green or red? Then compares how today went. The very first trading day has no "before", so it is left out.
 */
export function afterGreenVsRed(trades: PatternTrade[]): { afterGreen: DayGroup; afterRed: DayGroup } {
  const days = new Map<string, PatternTrade[]>();
  for (const t of trades) days.set(t.trade_date, [...(days.get(t.trade_date) ?? []), t]);
  const ordered = [...days.keys()].sort();
  const groups: Record<'green' | 'red', { pnl: number[]; counts: number[] }> = { green: { pnl: [], counts: [] }, red: { pnl: [], counts: [] } };
  for (let i = 1; i < ordered.length; i++) {
    const prevNet = days.get(ordered[i - 1])!.reduce((s, t) => s + Number(t.pnl), 0);
    if (prevNet === 0) continue; // a flat day is neither green nor red
    const today = days.get(ordered[i])!;
    const key = prevNet > 0 ? 'green' : 'red';
    groups[key].pnl.push(today.reduce((s, t) => s + Number(t.pnl), 0));
    groups[key].counts.push(today.length);
  }
  const summarize = (label: string, g: { pnl: number[]; counts: number[] }): DayGroup => {
    const n = g.pnl.length;
    const total = g.pnl.reduce((s, x) => s + x, 0);
    return {
      label,
      days: n,
      totalPnl: total,
      avgDayPnl: n ? total / n : 0,
      avgTrades: n ? g.counts.reduce((s, x) => s + x, 0) / n : 0,
      greenDays: g.pnl.filter(x => x > 0).length,
    };
  };
  return { afterGreen: summarize('Day after a green day', groups.green), afterRed: summarize('Day after a red day', groups.red) };
}
