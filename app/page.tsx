'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Trade = {
  id: string; user_id: string; trade_date: string; symbol: string; direction: 'Long' | 'Short';
  pnl: number; setup_valid: boolean; confirmation_waited: boolean; emotion: string; notes: string;
  created_at: string;
};
type Profile = { id: string; daily_loss_limit: number; max_trades: number; current_equity?: number };
type CashMovement = { id: string; user_id: string; movement_date: string; movement_type: 'deposit' | 'withdrawal'; amount: number; notes: string; created_at: string };
type CompoundingDay = { id: string; user_id: string; trading_date: string; starting_balance: number; target_percent: number; closing_balance: number | null };

const money = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n);
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateLabel = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });

export default function Home() {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [configured, setConfigured] = useState(true);
  const [sessionUser, setSessionUser] = useState<{ id: string; email?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [cashMovements, setCashMovements] = useState<CashMovement[]>([]);
  const [currentEquity, setCurrentEquity] = useState('0');
  const [compoundingDay, setCompoundingDay] = useState<CompoundingDay | null>(null);
  const [plannedRisk, setPlannedRisk] = useState('10');
  const [plannedLeverage, setPlannedLeverage] = useState('');
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(todayLocal());
  const [cashForm, setCashForm] = useState({ movement_date: todayLocal(), movement_type: 'deposit' as 'deposit' | 'withdrawal', amount: '', notes: '' });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [dailyLimit, setDailyLimit] = useState('300');
  const [maxTrades, setMaxTrades] = useState('2');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<'all' | 'compliant' | 'rulebreak'>('all');
  const [form, setForm] = useState({ trade_date: todayLocal(), symbol: 'XAUUSD', direction: 'Long' as 'Long' | 'Short', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) { setConfigured(false); setLoading(false); return; }
    const client = createClient(url, key);
    setSupabase(client);
    client.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      setSessionUser(user ? { id: user.id, email: user.email } : null);
      setLoading(false);
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      setSessionUser(user ? { id: user.id, email: user.email } : null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const loadData = useCallback(async () => {
    if (!supabase || !sessionUser) return;
    setLoading(true);
    const [tradeRes, profileRes, cashRes] = await Promise.all([
      supabase.from('trades').select('*').order('trade_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000),
      supabase.from('profiles').select('*').eq('id', sessionUser.id).maybeSingle(),
      supabase.from('cash_movements').select('*').order('movement_date', { ascending: false }).order('created_at', { ascending: false }).limit(2000),
    ]);
    if (tradeRes.error) setStatus(`Could not load trades: ${tradeRes.error.message}`);
    else setTrades((tradeRes.data ?? []) as Trade[]);
    if (cashRes.error) setStatus(`Could not load deposits/withdrawals: ${cashRes.error.message}`);
    else setCashMovements((cashRes.data ?? []) as CashMovement[]);
    if (profileRes.data) {
      const p = profileRes.data as Profile;
      setProfile(p); setDailyLimit(String(p.daily_loss_limit)); setMaxTrades(String(p.max_trades)); setCurrentEquity(String(p.current_equity ?? 0));
    } else {
      const inserted = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: 300, max_trades: 2, current_equity: 0 }).select().maybeSingle();
      if (inserted.data) { setProfile(inserted.data as Profile); setCurrentEquity(String((inserted.data as Profile).current_equity ?? 0)); }
    }
    // Keep one saved compounding snapshot per local calendar day. A new day starts
    // from yesterday's saved closing balance; first use starts from CAD 1,000.
    const day = todayLocal();
    const dayRes = await supabase.from('compounding_days').select('*').eq('user_id', sessionUser.id).eq('trading_date', day).maybeSingle();
    if (dayRes.data) {
      setCompoundingDay(dayRes.data as CompoundingDay);
    } else {
      const previous = await supabase.from('compounding_days').select('*').eq('user_id', sessionUser.id).lt('trading_date', day).order('trading_date', { ascending: false }).limit(1).maybeSingle();
      const previousRow = previous.data as CompoundingDay | null;
      const fallbackEquity = Number(profileRes.data?.current_equity ?? 0);
      const openingBalance = previousRow?.closing_balance != null ? Number(previousRow.closing_balance) : (fallbackEquity > 0 ? fallbackEquity : 1000);
      const created = await supabase.from('compounding_days').upsert({ user_id: sessionUser.id, trading_date: day, starting_balance: openingBalance, target_percent: 2 }, { onConflict: 'user_id,trading_date' }).select().single();
      if (created.data) setCompoundingDay(created.data as CompoundingDay);
      if (created.error) setStatus(`Compounding tracker needs its database migration: ${created.error.message}`);
    }
    setLoading(false);
  }, [supabase, sessionUser]);

  useEffect(() => { void loadData(); }, [loadData]);

  const todayTrades = useMemo(() => trades.filter(t => t.trade_date === todayLocal()), [trades]);
  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const limit = Number(profile?.daily_loss_limit ?? dailyLimit ?? 300);
  const tradeCap = Number(profile?.max_trades ?? maxTrades ?? 2);
  const dailyTarget = Math.max(0, Number(compoundingDay?.starting_balance ?? 1000) * Number(compoundingDay?.target_percent ?? 2) / 100);
  const targetProgress = dailyTarget > 0 ? Math.max(0, Math.min(100, todayPnl / dailyTarget * 100)) : 0;
  const dailyLossHit = todayPnl <= -Math.abs(limit);
  const tradeCountHit = todayTrades.length >= tradeCap;
  const targetReached = todayPnl >= dailyTarget && dailyTarget > 0;
  const guardrailHit = dailyLossHit || tradeCountHit;
  const compliant = (t: Trade) => t.setup_valid && t.confirmation_waited;
  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) < 0);
  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const totalDeposited = cashMovements.filter(m => m.movement_type === 'deposit').reduce((sum, m) => sum + Number(m.amount), 0);
  const totalWithdrawn = cashMovements.filter(m => m.movement_type === 'withdrawal').reduce((sum, m) => sum + Number(m.amount), 0);
  const netContributions = totalDeposited - totalWithdrawn;
  const equityValue = Number(profile?.current_equity ?? currentEquity ?? 0);
  const netResultVsCapital = equityValue - netContributions;
  const monthKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  const monthTrades = trades.filter(t => t.trade_date.startsWith(monthKey));
  const monthPnl = monthTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const selectedDayTrades = trades.filter(t => t.trade_date === selectedDay);
  const calendarCells = useMemo(() => { const year = calendarMonth.getFullYear(); const month = calendarMonth.getMonth(); const first = new Date(year, month, 1); const start = (first.getDay() + 6) % 7; const count = new Date(year, month + 1, 0).getDate(); return [...Array(start).fill(null), ...Array.from({ length: count }, (_, i) => `${year}-${String(month + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`)]; }, [calendarMonth]);
  const dayPnl = (day: string) => trades.filter(t => t.trade_date === day).reduce((sum, t) => sum + Number(t.pnl), 0);
  const winDays = useMemo(() => {
    const days = new Map<string, number>();
    trades.forEach(t => days.set(t.trade_date, (days.get(t.trade_date) ?? 0) + Number(t.pnl)));
    return [...days.values()].filter(n => n > 0).length;
  }, [trades]);
  const redDays = useMemo(() => {
    const days = new Map<string, number>();
    trades.forEach(t => days.set(t.trade_date, (days.get(t.trade_date) ?? 0) + Number(t.pnl)));
    return [...days.values()].filter(n => n < 0).length;
  }, [trades]);
  const ruleBreakTrades = trades.filter(t => !compliant(t));
  const ruleBreakPnl = ruleBreakTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const compliantTrades = trades.filter(compliant);
  const compliantPnl = compliantTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + Number(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + Number(t.pnl), 0) / losses.length) : 0;
  const shownTrades = trades.filter(t => filter === 'all' ? true : filter === 'compliant' ? compliant(t) : !compliant(t));

  async function handleAuth(e: FormEvent) {
    e.preventDefault(); if (!supabase) return;
    setAuthMessage(''); setSaving(true);
    const result = authMode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (result.error) setAuthMessage(result.error.message);
    else if (authMode === 'signup' && !result.data.session) setAuthMessage('Account created. Check your email to confirm, then sign in.');
    else setAuthMessage('');
    setSaving(false);
  }

  async function addTrade(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    if (!form.pnl.trim() || !Number.isFinite(Number(form.pnl))) { setStatus('Enter a valid trade P&L.'); return; }
    setSaving(true); setStatus('');
    const { error } = await supabase.from('trades').insert({
      user_id: sessionUser.id, trade_date: form.trade_date, symbol: form.symbol.trim().toUpperCase(), direction: form.direction,
      pnl: Number(form.pnl), setup_valid: form.setup_valid, confirmation_waited: form.confirmation_waited,
      emotion: form.emotion, notes: form.notes.trim(),
    });
    if (error) setStatus(`Could not save trade: ${error.message}`);
    else {
      setStatus('Trade saved. Review the rule-following fields honestly.');
      setForm(f => ({ ...f, pnl: '', notes: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', trade_date: todayLocal() }));
      setShowForm(false); await loadData();
    }
    setSaving(false);
  }

  async function saveCashMovement(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    const amount = Number(cashForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) { setStatus('Enter a positive amount for the deposit or withdrawal.'); return; }
    setSaving(true); setStatus('');
    const { data, error } = await supabase.from('cash_movements').insert({ user_id: sessionUser.id, movement_date: cashForm.movement_date, movement_type: cashForm.movement_type, amount, notes: cashForm.notes.trim() }).select().single();
    if (error) setStatus(`Could not save cash movement: ${error.message}`);
    else { setCashMovements(items => [data as CashMovement, ...items]); setCashForm(f => ({ ...f, amount: '', notes: '' })); setStatus('Deposit/withdrawal saved.'); }
    setSaving(false);
  }

  async function saveCurrentEquity(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    const amount = Number(currentEquity);
    if (!Number.isFinite(amount) || amount < 0) { setStatus('Enter a valid current account equity amount.'); return; }
    setSaving(true); setStatus('');
    const { data, error } = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: Number(profile?.daily_loss_limit ?? dailyLimit), max_trades: Number(profile?.max_trades ?? maxTrades), current_equity: amount }).select().single();
    if (error) setStatus(`Could not save current equity: ${error.message}`);
    else {
      setProfile(data as Profile); setCurrentEquity(String(amount));
      if (compoundingDay) {
        const { data: dayData, error: dayError } = await supabase.from('compounding_days').update({ closing_balance: amount }).eq('id', compoundingDay.id).select().single();
        if (dayError) setStatus(`Equity saved, but compounding close could not be saved: ${dayError.message}`);
        else setCompoundingDay(dayData as CompoundingDay);
      }
      setStatus('Current equity saved. It will become the next trading day’s compounding base.');
    }
    setSaving(false);
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    const l = Number(dailyLimit), c = Number(maxTrades);
    if (!Number.isFinite(l) || l <= 0 || !Number.isInteger(c) || c < 1 || c > 10) { setStatus('Use a positive loss limit and a whole-number trade cap between 1 and 10.'); return; }
    setSaving(true);
    const { data, error } = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: l, max_trades: c }).select().single();
    if (error) setStatus(`Could not save settings: ${error.message}`);
    else { setProfile(data as Profile); setStatus('Risk settings saved. These are journal guardrails, not a broker lockout.'); }
    setSaving(false);
  }

  function exportCSV() {
    const headers = ['trade_date','symbol','direction','pnl_cad','setup_valid','confirmation_waited','emotion','notes','created_at'];
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = trades.map(t => [t.trade_date, t.symbol, t.direction, Number(t.pnl), t.setup_valid, t.confirmation_waited, t.emotion, t.notes, t.created_at]);
    const csv = [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `trade-discipline-${todayLocal()}.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  async function signOut() { await supabase?.auth.signOut(); setTrades([]); setProfile(null); }

  if (!configured) return <main className="setup-page"><div className="setup-card"><div className="brand-mark">TD</div><p className="eyebrow">YOUR PRIVATE TRADING JOURNAL</p><h1>Let's connect your journal.</h1><p className="muted">Add your Supabase project URL and publishable/anon key to a local <code>.env.local</code> file. Then run the SQL in <code>supabase/schema.sql</code>. Full setup instructions are in README.md.</p><pre>NEXT_PUBLIC_SUPABASE_URL=...{`\n`}NEXT_PUBLIC_SUPABASE_ANON_KEY=...</pre></div></main>;
  if (loading && !sessionUser) return <main className="setup-page"><div className="loading-dot"/><p className="muted">Opening your journal…</p></main>;
  if (!sessionUser) return <main className="setup-page"><div className="auth-card"><div className="brand-mark">TD</div><p className="eyebrow">TRADE DISCIPLINE</p><h1>Trade the plan.<br/><em>Protect the account.</em></h1><p className="muted">A private trading journal built around execution, risk and emotional patterns.</p><form onSubmit={handleAuth} className="stack"><label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com"/></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} placeholder="At least 6 characters"/></label><button className="button primary full" disabled={saving}>{saving ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</button></form>{authMessage && <p className="notice">{authMessage}</p>}<p className="auth-switch">{authMode === 'signin' ? 'New here?' : 'Already have an account?'} <button className="text-button" onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthMessage(''); }}>{authMode === 'signin' ? 'Create an account' : 'Sign in'}</button></p><p className="tiny muted">Your journal is private to your account. Do not store broker passwords or API keys here.</p></div></main>;

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand-row"><div className="brand-mark small">TD</div><div><strong>TRADE</strong><span>DISCIPLINE</span></div></div><div className="side-label">WORKSPACE</div><a className="nav-item active" href="#overview">◈ <span>Overview</span></a><a className="nav-item" href="#journal">▤ <span>Trade journal</span></a><a className="nav-item" href="#analysis">⌁ <span>Behavior analysis</span></a><a className="nav-item" href="#risk">⛨ <span>Risk controls</span></a><div className="sidebar-bottom"><div className="profile-dot">{(sessionUser.email ?? 'T').slice(0,1).toUpperCase()}</div><div className="profile-email">{sessionUser.email}<span>Personal live account</span></div><button className="icon-button" title="Sign out" onClick={signOut}>↗</button></div></aside>
    <section className="main-content"><header className="topbar"><div><p className="eyebrow">PERSONAL LIVE ACCOUNT</p><h1>Your trading cockpit</h1></div><div className="topbar-right"><span className="date-pill">{new Date().toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}</span><button type="button" className="button primary" onClick={() => setShowForm(true)}>＋ Log a trade</button></div></header>
      {showForm && <section className="panel form-panel"><div className="panel-heading"><div><p className="eyebrow">JOURNAL ENTRY</p><h2>Log a trade</h2></div><button className="icon-button" onClick={() => setShowForm(false)}>×</button></div>{guardrailHit && <div className="notice danger-text">Your session guardrail is reached. Do not place another trade. If you already took a trade, still log it below so the analysis stays complete.</div>}<form onSubmit={addTrade} className="trade-form"><label>Date<input type="date" value={form.trade_date} onChange={e => setForm({ ...form, trade_date: e.target.value })} required/></label><label>Symbol<input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })} required/></label><label>Direction<select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value as 'Long' | 'Short' })}><option>Long</option><option>Short</option></select></label><label>Net P&L (CAD)<input type="number" step="0.01" value={form.pnl} onChange={e => setForm({ ...form, pnl: e.target.value })} placeholder="e.g. -125.50" required/></label><label>Emotion at entry<select value={form.emotion} onChange={e => setForm({ ...form, emotion: e.target.value })}><option>Calm</option><option>FOMO</option><option>Impatient</option><option>Frustrated</option><option>Revenge / recovery</option><option>Overconfident</option><option>Bored</option><option>Anxious</option></select></label><div className="toggle-row"><label className="check-label"><input type="checkbox" checked={form.setup_valid} onChange={e => setForm({ ...form, setup_valid: e.target.checked })}/> My setup was valid</label><label className="check-label"><input type="checkbox" checked={form.confirmation_waited} onChange={e => setForm({ ...form, confirmation_waited: e.target.checked })}/> I waited for confirmation</label></div><label className="wide">Notes / what happened<textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="What did you see? What were you feeling? Did you follow the plan?"/></label><div className="form-actions wide"><p className="tiny muted">Log each trade honestly, including rule-breaking trades. This journal does not connect to your broker.</p><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save trade'}</button></div></form></section>}
      {status && <div className="status-banner" role="status">{status}<button onClick={() => setStatus('')} aria-label="Dismiss">×</button></div>}
      <div className={`guardrail ${guardrailHit ? 'danger' : 'safe'}`}><div className="guardrail-icon">{guardrailHit ? '!' : '✓'}</div><div><strong>{guardrailHit ? 'Journal guardrail reached — stop this session' : 'Session guardrail'}</strong><p>{todayTrades.length} of {tradeCap} trades logged today · Daily P&L {money(todayPnl)} · Loss limit {money(Math.abs(limit))}</p></div><span className="guardrail-tag">{guardrailHit ? 'STOP' : 'ACTIVE'}</span></div>
      <section id="compounding" className="panel compounding-panel"><div className="panel-heading"><div><p className="eyebrow">DAILY COMPOUNDING & DISCIPLINE</p><h2>Today’s plan</h2><p className="muted tiny">{todayLocal()} · The daily target resets with the local calendar date.</p></div><span className="panel-icon">↗</span></div><div className="account-summary-grid"><div className="account-stat"><span>Starting balance today</span><strong>{money(Number(compoundingDay?.starting_balance ?? 1000))}</strong><small>First day defaults to $1,000 CAD</small></div><div className="account-stat"><span>2% target</span><strong>{money(dailyTarget)}</strong><small>Calculated from today’s starting balance</small></div><div className="account-stat"><span>Actual daily P&amp;L</span><strong className={todayPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(todayPnl)}</strong><small>{todayTrades.length} of {tradeCap} trades used</small></div></div><div className="progress-label"><span>Progress toward target</span><strong>{Math.round(targetProgress)}%</strong></div><div className="bar-track compounding-progress"><div className="bar-fill gold-fill" style={{width:`${targetProgress}%`}} /></div>{targetReached && <div className="notice warning"><strong>Target reached.</strong> Your goal is complete for today. Do not increase size or keep trading just to make more.</div>}{guardrailHit && <div className="notice danger-text"><strong>STOP TRADING.</strong> {dailyLossHit ? 'Your maximum daily loss has been reached.' : ''} {tradeCountHit ? 'You have reached your daily trade limit.' : ''} This is a journal warning, not a broker lockout.</div>}<div className="compounding-risk-row"><label>Planned loss if this trade fails (CAD)<input type="number" min="0" step="0.01" value={plannedRisk} onChange={e => setPlannedRisk(e.target.value)} /></label><label>Planned leverage (optional)<input type="number" min="1" step="1" value={plannedLeverage} onChange={e => setPlannedLeverage(e.target.value)} placeholder="e.g. 100" /></label></div><p className={`notice ${Number(plannedRisk) > Number(compoundingDay?.starting_balance ?? 1000) * 0.01 ? 'warning' : ''}`}><strong>Risk check:</strong> {Number(plannedRisk) > Number(compoundingDay?.starting_balance ?? 1000) * 0.01 ? `This planned loss is more than 1% of today's starting balance (${money(Number(compoundingDay?.starting_balance ?? 1000) * 0.01)}). Consider reducing risk or skipping the trade.` : `Planned loss is within 1% of today's starting balance (${money(Number(compoundingDay?.starting_balance ?? 1000) * 0.01)}).`}{plannedLeverage && Number(plannedLeverage) > 100 ? ' High leverage entered: recheck position size and stop distance before trading.' : ''}</p><p className="tiny muted">At $1,000, a $300 daily loss limit equals 30% of the account. The tracker keeps your chosen limit but flags the account-level risk. Leverage alone does not determine risk; position size and stop distance matter too.</p></section>
      <section className="account-summary panel"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT PERFORMANCE</p><h2>Capital & cash flow</h2></div></div><div className="account-summary-grid"><div className="account-stat"><span>Trading P&amp;L</span><strong className={totalPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(totalPnl)}</strong><small>Sum of logged trade results</small></div><div className="account-stat"><span>Total deposited</span><strong>{money(totalDeposited)}</strong><small>All recorded deposits</small></div><div className="account-stat"><span>Total withdrawn</span><strong>{money(totalWithdrawn)}</strong><small>All recorded withdrawals</small></div><div className="account-stat"><span>Net contributions</span><strong>{money(netContributions)}</strong><small>Deposits minus withdrawals</small></div><div className="account-stat"><span>Current account equity</span><strong>{money(equityValue)}</strong><small>Manually entered balance/equity</small></div><div className="account-stat"><span>Net result vs. capital</span><strong className={netResultVsCapital >= 0 ? 'positive-text' : 'negative-text'}>{money(netResultVsCapital)}</strong><small>Equity minus net contributions</small></div></div><form className="equity-form" onSubmit={saveCurrentEquity}><label>Update current account equity (CAD)<input type="number" min="0" step="0.01" value={currentEquity} onChange={e => setCurrentEquity(e.target.value)} required /></label><button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Save equity'}</button></form><p className="tiny muted">Net result vs. capital is an estimate based on the equity you enter and recorded deposits/withdrawals. Include all relevant transfers and adjustments for an accurate figure. Trading P&amp;L is calculated separately from your logged trades.</p></section>
      <section id="calendar" className="panel calendar-panel"><div className="panel-heading calendar-heading"><div><p className="eyebrow">DAILY PERFORMANCE</p><h2>Trading calendar</h2><p className="muted tiny">Monthly P&amp;L: <strong className={monthPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(monthPnl)}</strong> · {monthTrades.length} trades</p></div><div className="calendar-controls"><button type="button" className="button secondary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>‹</button><strong>{calendarMonth.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</strong><button type="button" className="button secondary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>›</button></div></div><div className="calendar-grid">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => <div key={d} className="calendar-weekday">{d}</div>)}{calendarCells.map((day, i) => day ? <button type="button" key={day} onClick={() => setSelectedDay(day)} className={`calendar-day ${selectedDay === day ? 'selected' : ''} ${trades.some(t => t.trade_date === day) ? (dayPnl(day) >= 0 ? 'profit-day' : 'loss-day') : ''}`}><span>{Number(day.slice(-2))}</span>{trades.some(t => t.trade_date === day) && <strong>{money(dayPnl(day))}</strong>}</button> : <div key={`blank-${i}`} className="calendar-empty" />)}</div><div className="selected-day-detail"><h3>{new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>{selectedDayTrades.length ? <><p className={dayPnl(selectedDay) >= 0 ? 'positive-text' : 'negative-text'}>Daily P&amp;L: <strong>{money(dayPnl(selectedDay))}</strong></p><ul>{selectedDayTrades.map(t => <li key={t.id}>{t.symbol} · {t.direction} · <strong className={Number(t.pnl) >= 0 ? 'positive-text' : 'negative-text'}>{money(Number(t.pnl))}</strong> · {t.emotion}</li>)}</ul></> : <p className="muted tiny">No trades logged for this date.</p>}</div></section>
      <section className="panel cash-panel"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT ACTIVITY</p><h2>Deposits &amp; withdrawals</h2></div></div><form className="cash-form" onSubmit={saveCashMovement}><label>Type<select value={cashForm.movement_type} onChange={e => setCashForm({ ...cashForm, movement_type: e.target.value as 'deposit' | 'withdrawal' })}><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label><label>Date<input type="date" value={cashForm.movement_date} onChange={e => setCashForm({ ...cashForm, movement_date: e.target.value })} required /></label><label>Amount (CAD)<input type="number" min="0.01" step="0.01" value={cashForm.amount} onChange={e => setCashForm({ ...cashForm, amount: e.target.value })} placeholder="0.00" required /></label><label>Notes (optional)<input value={cashForm.notes} onChange={e => setCashForm({ ...cashForm, notes: e.target.value })} placeholder="e.g. monthly funding" /></label><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Add movement'}</button></form><div className="cash-table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead><tbody>{cashMovements.length ? cashMovements.map(m => <tr key={m.id}><td>{dateLabel(m.movement_date)}</td><td>{m.movement_type === 'deposit' ? 'Deposit' : 'Withdrawal'}</td><td className={m.movement_type === 'deposit' ? 'positive-text' : 'negative-text'}>{m.movement_type === 'deposit' ? '+' : '−'}{money(Number(m.amount))}</td><td>{m.notes || '—'}</td></tr>) : <tr><td colSpan={4} className="muted">No deposits or withdrawals recorded yet.</td></tr>}</tbody></table></div></section>
      <section id="overview" className="metric-grid"><Metric label="Net P&L · all logged trades" value={money(totalPnl)} tone={totalPnl >= 0 ? 'positive' : 'negative'} note={`${trades.length} trades recorded`}/><Metric label="Green / red days" value={`${winDays} / ${redDays}`} note="Days with a non-zero net result"/><Metric label="Average winning trade" value={money(avgWin)} tone="positive" note={`${wins.length} winning trades`}/><Metric label="Average losing trade" value={money(avgLoss)} tone="negative" note={`${losses.length} losing trades`}/></section>
      <section id="analysis" className="analysis-grid"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">PROCESS OVER P&L</p><h2>Rule-following breakdown</h2></div><span className="panel-icon">⌁</span></div><div className="comparison"><div className="comparison-row"><div><span className="legend-dot gold"/> <span>Compliant trades</span></div><strong className={compliantPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(compliantPnl)}</strong></div><div className="bar-track"><div className="bar-fill gold-fill" style={{ width: `${trades.length ? compliantTrades.length / trades.length * 100 : 0}%` }}/></div><p className="muted tiny">{compliantTrades.length} trades where setup was valid and confirmation was respected</p><div className="comparison-row"><div><span className="legend-dot red"/> <span>Rule-breaking trades</span></div><strong className={ruleBreakPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(ruleBreakPnl)}</strong></div><div className="bar-track"><div className="bar-fill red-fill" style={{ width: `${trades.length ? ruleBreakTrades.length / trades.length * 100 : 0}%` }}/></div><p className="muted tiny">{ruleBreakTrades.length} trades with an invalid setup or missing confirmation</p></div><div className="insight-box"><span className="insight-star">✦</span><p>{trades.length ? `You have logged ${trades.length} trades. Keep logging every trade so we can compare compliant execution with impulsive entries over time.` : 'Your first goal is to build a complete record. Log wins, losses, and rule-breaking trades—not just the memorable ones.'}</p></div></div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">BEHAVIORAL SIGNALS</p><h2>What may be costing you</h2></div><span className="panel-icon">◎</span></div><div className="signal-list"><Signal label="FOMO / early entry" value={trades.filter(t => t.emotion === 'FOMO' || !t.confirmation_waited).length} total={trades.length} color="red"/><Signal label="Invalid setup" value={trades.filter(t => !t.setup_valid).length} total={trades.length} color="gold"/><Signal label="Recovery / revenge" value={trades.filter(t => t.emotion === 'Revenge / recovery').length} total={trades.length} color="red"/><Signal label="Trades beyond first two" value={trades.filter(t => { const sameDay = trades.filter(x => x.trade_date === t.trade_date).sort((a,b) => a.created_at.localeCompare(b.created_at)); return sameDay.findIndex(x => x.id === t.id) >= 2; }).length} total={trades.length} color="gold"/></div><p className="tiny muted signal-foot">These are descriptive counts, not diagnoses or proof of causation. More complete logging improves the analysis.</p></div></section>
      <section id="risk" className="panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">PRE-COMMITMENT</p><h2>Your risk guardrails</h2><p className="muted">Choose limits before your next session.</p></div><span className="panel-icon">⛨</span></div><form className="settings-form" onSubmit={saveSettings}><label>Maximum daily loss (CAD)<input type="number" min="1" step="1" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} required/></label><label>Maximum trades per day<input type="number" min="1" max="10" step="1" value={maxTrades} onChange={e => setMaxTrades(e.target.value)} required/></label><button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Save my limits'}</button></form><p className="notice warning"><strong>Important:</strong> These are journal-side warnings and entry-form guardrails, not a broker-level lockout. They cannot prevent you from placing trades in your trading platform. For stronger protection, configure any available broker-side limits and stop live trading if you cannot reliably stop.</p></section>
      <section id="journal" className="panel journal-panel"><div className="panel-heading journal-heading"><div><p className="eyebrow">YOUR RECORD</p><h2>Trade history</h2></div><div className="journal-actions"><button className="button secondary export-button" onClick={exportCSV} disabled={trades.length === 0}>Export CSV</button><div className="filter-tabs"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'compliant' ? 'selected' : ''} onClick={() => setFilter('compliant')}>Compliant</button><button className={filter === 'rulebreak' ? 'selected' : ''} onClick={() => setFilter('rulebreak')}>Rule breaks</button></div></div></div>{loading ? <p className="muted">Loading trades…</p> : shownTrades.length === 0 ? <div className="empty-state"><div className="empty-icon">▤</div><h3>No trades here yet</h3><p>Once you log trades, this table will help you identify patterns.</p></div> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Symbol</th><th>Direction</th><th>P&L</th><th>Emotion</th><th>Execution</th><th>Notes</th></tr></thead><tbody>{shownTrades.map(t => <tr key={t.id}><td>{dateLabel(t.trade_date)}</td><td className="symbol-cell">{t.symbol}</td><td>{t.direction}</td><td className={Number(t.pnl) >= 0 ? 'positive-text' : 'negative-text'}>{money(Number(t.pnl))}</td><td><span className={`emotion-chip ${t.emotion === 'FOMO' || t.emotion === 'Revenge / recovery' ? 'emotion-risk' : ''}`}>{t.emotion}</span></td><td><span className={`execution-pill ${compliant(t) ? 'execution-good' : 'execution-bad'}`}>{compliant(t) ? 'Followed' : 'Rule break'}</span></td><td className="notes-cell" title={t.notes}>{t.notes || '—'}</td></tr>)}</tbody></table></div>}</section>
      <footer className="footer-note">TRADE DISCIPLINE <span>·</span> Process first. Risk always.</footer>
    </section>
  </main>;
}

function Metric({ label, value, tone, note }: { label: string; value: string; tone?: 'positive' | 'negative'; note: string }) {
  return <div className="metric-card"><p>{label}</p><strong className={tone === 'positive' ? 'positive-text' : tone === 'negative' ? 'negative-text' : ''}>{value}</strong><span>{note}</span></div>;
}
function Signal({ label, value, total, color }: { label: string; value: number; total: number; color: 'red' | 'gold' }) {
  return <div className="signal"><div className="signal-top"><span>{label}</span><strong>{value}</strong></div><div className="bar-track"><div className={`bar-fill ${color === 'red' ? 'red-fill' : 'gold-fill'}`} style={{ width: `${total ? Math.min(100, value / total * 100) : 0}%` }}/></div></div>;
}
