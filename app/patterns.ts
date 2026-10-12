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

// ---------------------------------------------------------------------------
// Time held
// ---------------------------------------------------------------------------

export type HoldTrade = PatternTrade & { exit_date?: string | null; exit_time?: string | null };

/** Minutes between entry and exit, or null if the exit (date and time) or entry time was not logged. */
export function holdMinutes(t: HoldTrade): number | null {
  if (!t.exit_date || !t.exit_time || !t.trade_time) return null;
  const start = new Date(`${t.trade_date}T${t.trade_time.slice(0, 5)}:00`).getTime();
  const end = new Date(`${t.exit_date}T${t.exit_time.slice(0, 5)}:00`).getTime();
  const mins = Math.round((end - start) / 60000);
  return Number.isFinite(mins) && mins >= 0 ? mins : null;
}

/** "45 min", "3h 10m", "2d 4h". */
export function formatMinutes(mins: number): string {
  const m = Math.round(mins);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const r = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${r}m`;
  return `${r} min`;
}

const HOLD_EDGES: { label: string; from: number; to: number }[] = [
  { label: 'Under 5 min', from: 0, to: 5 },
  { label: '5 to 15 min', from: 5, to: 15 },
  { label: '15 to 60 min', from: 15, to: 60 },
  { label: '1 to 4 hours', from: 60, to: 240 },
  { label: '4 hours to 1 day', from: 240, to: 1440 },
  { label: 'Over 1 day', from: 1440, to: Infinity },
];

/** Trades grouped by how long they were held. Trades with no logged exit are counted separately. */
export function byHoldTime(trades: HoldTrade[]): { buckets: Bucket[]; missing: number } {
  const groups: HoldTrade[][] = HOLD_EDGES.map(() => []);
  let missing = 0;
  for (const t of trades) {
    const mins = holdMinutes(t);
    if (mins === null) { missing++; continue; }
    const i = HOLD_EDGES.findIndex(e => mins >= e.from && mins < e.to);
    if (i >= 0) groups[i].push(t);
  }
  const buckets = HOLD_EDGES.map((e, i) => makeBucket(e.label, groups[i])).filter(b => b.trades > 0);
  return { buckets, missing };
}

export type HoldSummary = { n: number; avgMinutes: number; medianMinutes: number };

const summarizeHold = (mins: number[]): HoldSummary => {
  const n = mins.length;
  if (!n) return { n: 0, avgMinutes: 0, medianMinutes: 0 };
  const sorted = [...mins].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n, avgMinutes: mins.reduce((s, x) => s + x, 0) / n, medianMinutes: median };
};

/** How long you hold winners versus losers. Break-even trades are left out. */
export function holdWinnersVsLosers(trades: HoldTrade[]): { winners: HoldSummary; losers: HoldSummary; missing: number } {
  const w: number[] = [];
  const l: number[] = [];
  let missing = 0;
  for (const t of trades) {
    const mins = holdMinutes(t);
    if (mins === null) { missing++; continue; }
    const p = Number(t.pnl);
    if (p > 0) w.push(mins);
    else if (p < 0) l.push(mins);
  }
  return { winners: summarizeHold(w), losers: summarizeHold(l), missing };
}
