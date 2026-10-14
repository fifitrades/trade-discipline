// Trade report importer. Pure functions: CSV text in, trade rows out. No React or Supabase here.
// Built for broker history exports (MetaTrader-style: Ticket, Open Time, Type, Size, Symbol, Close Time, Profit ...),
// but it matches columns by name so other reports with similar headers work too.

export type ImportedTrade = {
  trade_date: string;        // YYYY-MM-DD
  trade_time: string | null; // HH:MM
  exit_date: string | null;
  exit_time: string | null;
  symbol: string;
  direction: 'Long' | 'Short';
  contracts: number;         // lots
  pnl: number;               // net of commission, swap and taxes when those columns exist
};

export type ImportResult = { trades: ImportedTrade[]; skipped: number; problems: string[] };

/** Splits CSV text into rows of cells. Handles quotes, commas, semicolons and tabs. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/).find(l => l.trim()) ?? '';
  const counts: [string, number][] = [',', ';', '\t'].map(d => [d, firstLine.split(d).length - 1]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') { if (clean[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  return rows.map(r => r.map(x => x.trim()));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Reads "2026.10.09 14:30:05", "2026-10-09T14:30", "10/09/2026 2:30 PM" into date and HH:MM. */
export function parseDateTime(raw: string): { date: string; time: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  let y = '', mo = '', d = '', rest = '';
  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T]+(.*))?$/);
  if (m) { [, y, mo, d] = m; rest = m[4] ?? ''; }
  else {
    m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T]+(.*))?$/);
    if (!m) return null;
    // Day-first only when the first number cannot be a month; otherwise month-first (North American).
    const a = Number(m[1]); const b = Number(m[2]);
    if (a > 12) { d = m[1]; mo = m[2]; } else { mo = m[1]; d = m[2]; }
    if (a <= 12 && b > 12) { mo = m[1]; d = m[2]; }
    y = m[3]; rest = m[4] ?? '';
  }
  const month = Number(mo); const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let time: string | null = null;
  const t = rest.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (t) {
    let h = Number(t[1]);
    const ap = t[3]?.toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    if (h <= 23) time = `${String(h).padStart(2, '0')}:${t[2]}`;
  }
  return { date, time };
}

const toNum = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const s = raw.replace(/[\s$€£]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!s || s === '-') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

const NAMES = {
  open: ['opentime', 'opendate', 'entrytime', 'entrydate', 'opened', 'timeopen', 'time', 'date'],
  close: ['closetime', 'closedate', 'exittime', 'exitdate', 'closed', 'timeclose'],
  symbol: ['symbol', 'item', 'instrument', 'product', 'market', 'pair'],
  type: ['type', 'side', 'direction', 'action', 'buysell'],
  size: ['size', 'lots', 'lot', 'volume', 'quantity', 'qty', 'contracts'],
  profit: ['profit', 'pnl', 'pl', 'netprofit', 'netpnl', 'realizedpnl', 'result', 'profitloss'],
  commission: ['commission', 'commissions', 'fee', 'fees'],
  swap: ['swap', 'rollover'],
  taxes: ['taxes', 'tax'],
};

/** Finds the header row (first row that names a profit column and a symbol/type column) and maps column positions. */
function mapColumns(rows: string[][]) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const h = rows[r].map(norm);
    const find = (names: string[]) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
    const profit = find(NAMES.profit);
    const symbol = find(NAMES.symbol);
    const open = find(NAMES.open);
    if (profit < 0 || open < 0 || symbol < 0) continue;
    let close = find(NAMES.close);
    // MetaTrader prints "Time" twice (open, close): the second one is the close.
    if (close < 0) { const second = h.indexOf('time', open + 1); if (second > open) close = second; }
    return { header: r, open, close, symbol, type: find(NAMES.type), size: find(NAMES.size), profit,
      commission: find(NAMES.commission), swap: find(NAMES.swap), taxes: find(NAMES.taxes) };
  }
  return null;
}

export function parseTradeReport(text: string): ImportResult {
  const rows = parseCsv(text);
  const cols = mapColumns(rows);
  if (!cols) return { trades: [], skipped: 0, problems: ['Could not find the columns. The file needs at least an open time, a symbol and a profit column. Export the trade history as CSV and try again.'] };
  const trades: ImportedTrade[] = [];
  const problems: string[] = [];
  let skipped = 0;
  for (let i = cols.header + 1; i < rows.length; i++) {
    const r = rows[i];
    const typeRaw = cols.type >= 0 ? (r[cols.type] ?? '').toLowerCase() : '';
    const isBuy = /^(buy|long|b)\b/.test(typeRaw);
    const isSell = /^(sell|short|s)\b/.test(typeRaw);
    if (cols.type >= 0 && !isBuy && !isSell) { skipped++; continue; } // balance, credit, summary rows
    const open = parseDateTime(r[cols.open] ?? '');
    const profit = toNum(r[cols.profit]);
    if (!open || profit === null) { skipped++; continue; }
    const close = cols.close >= 0 ? parseDateTime(r[cols.close] ?? '') : null;
    const extra = [cols.commission, cols.swap, cols.taxes].reduce((s, c) => s + (c >= 0 ? toNum(r[c]) ?? 0 : 0), 0);
    const pnl = Math.round((profit + extra) * 100) / 100;
    const size = cols.size >= 0 ? toNum(r[cols.size]) : null;
    const symbol = (r[cols.symbol] ?? '').trim().toUpperCase();
    if (!symbol) { skipped++; continue; }
    if (close && (close.date < open.date || (close.date === open.date && close.time && open.time && close.time < open.time))) {
      problems.push(`Row ${i + 1}: exit is before entry, exit left blank.`);
    }
    const badExit = !close || close.date < open.date || (close.date === open.date && !!close.time && !!open.time && close.time < open.time);
    trades.push({
      trade_date: open.date, trade_time: open.time,
      exit_date: badExit ? null : close!.date, exit_time: badExit ? null : close!.time,
      symbol, direction: isSell ? 'Short' : 'Long',
      contracts: size && size >= 0.01 ? Math.round(size * 100) / 100 : 0.01,
      pnl,
    });
  }
  if (!trades.length && !problems.length) problems.push('No trades found in that file.');
  return { trades, skipped, problems };
}

/** A fingerprint used to skip trades that are already in the journal. */
export const tradeKey = (t: { symbol: string; trade_date: string; trade_time?: string | null; exit_date?: string | null; exit_time?: string | null; pnl: number | string; contracts?: number | string | null }) =>
  [t.symbol.toUpperCase(), t.trade_date, (t.trade_time ?? '').slice(0, 5), t.exit_date ?? '', (t.exit_time ?? '').slice(0, 5), Number(t.pnl).toFixed(2), Number(t.contracts ?? 0).toFixed(2)].join('|');

/** Splits parsed trades into new ones and ones already in the journal. Counts matter: two identical trades in the file
 * are both new unless the journal already holds that many. Re-importing the same file adds nothing. */
export function splitDuplicates(parsed: ImportedTrade[], existing: Parameters<typeof tradeKey>[0][]) {
  const have = new Map<string, number>();
  for (const e of existing) have.set(tradeKey(e), (have.get(tradeKey(e)) ?? 0) + 1);
  const fresh: ImportedTrade[] = []; let duplicates = 0;
  for (const t of parsed) {
    const k = tradeKey(t);
    const n = have.get(k) ?? 0;
    if (n > 0) { have.set(k, n - 1); duplicates++; } else fresh.push(t);
  }
  return { fresh, duplicates };
}
