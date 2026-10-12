// Entry/exit time helpers. Pure functions, no React or Supabase, so they are easy to test.

export type TradeTimes = {
  trade_date: string;          // entry date, YYYY-MM-DD
  trade_time?: string | null;  // entry time, HH:MM or HH:MM:SS
  exit_date?: string | null;
  exit_time?: string | null;
};

/** The day a trade's profit or loss is booked: the day you got out, or the entry day if no exit date was logged. */
export const bookedDate = (t: TradeTimes): string => t.exit_date ?? t.trade_date;

/** The time of day it is booked: the exit time if there is one, otherwise the entry time for a same-day trade. */
export const bookedTime = (t: TradeTimes): string | null => {
  if (t.exit_time) return t.exit_time;
  return bookedDate(t) === t.trade_date ? (t.trade_time ?? null) : null;
};

const toMs = (date: string, time: string) => new Date(`${date}T${time.slice(0, 5)}:00`).getTime();

/** How long the trade was held, e.g. "45 min", "3h 10m", "2d 4h". Dash when the exit is not fully logged. */
export function holdLabel(t: TradeTimes): string {
  if (!t.exit_date || !t.exit_time || !t.trade_time) return '—';
  const mins = Math.round((toMs(t.exit_date, t.exit_time) - toMs(t.trade_date, t.trade_time)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '—';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

/** Returns a message if the exit comes before the entry, otherwise null. Both exit fields are optional. */
export function exitProblem(entryDate: string, entryTime: string, exitDate: string, exitTime: string): string | null {
  if (!exitDate && !exitTime) return null;
  const day = exitDate || entryDate;
  if (day < entryDate) return 'The exit date cannot be before the entry date.';
  if (day === entryDate && exitTime && entryTime && exitTime.slice(0, 5) < entryTime.slice(0, 5)) return 'The exit time cannot be before the entry time on the same day.';
  return null;
}
