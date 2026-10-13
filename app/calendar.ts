// Calendar week helpers. Pure functions, no React or Supabase.

/** Splits the month's cells (null = blank cell) into rows of 7, padding the last row with blanks. */
export function chunkWeeks(cells: (string | null)[]): (string | null)[][] {
  const padded = [...cells];
  while (padded.length % 7 !== 0) padded.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
  return weeks;
}

export type WeekSummary = { pnl: number; trades: number; tradedDays: number };

/**
 * Total P&L, number of trades and number of trading days for the dates in one calendar row.
 * Only dates shown in that row count, so a week that runs into the next month shows just the days in this month.
 */
export function weekSummary(week: (string | null)[], trades: { trade_date: string; pnl: number | string }[]): WeekSummary {
  const days = new Set(week.filter((d): d is string => Boolean(d)));
  const inWeek = trades.filter(t => days.has(t.trade_date));
  return {
    pnl: inWeek.reduce((s, t) => s + Number(t.pnl), 0),
    trades: inWeek.length,
    tradedDays: new Set(inWeek.map(t => t.trade_date)).size,
  };
}
