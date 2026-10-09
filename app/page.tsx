'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Trade = {
  id: string; user_id: string; trade_date: string; symbol: string; direction: 'Long' | 'Short';
  pnl: number; setup_valid: boolean; confirmation_waited: boolean; emotion: string; notes: string;
  created_at: string;
};
type Profile = { id: string; daily_loss_limit: number; max_trades: number };

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
    const [tradeRes, profileRes] = await Promise.all([
      supabase.from('trades').select('*').order('trade_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000),
      supabase.from('profiles').select('*').eq('id', sessionUser.id).maybeSingle(),
    ]);
    if (tradeRes.error) setStatus(`Could not load trades: ${tradeRes.error.message}`);
    else setTrades((tradeRes.data ?? []) as Trade[]);
    if (profileRes.data) {
      const p = profileRes.data as Profile;
      setProfile(p); setDailyLimit(String(p.daily_loss_limit)); setMaxTrades(String(p.max_trades));
    } else {
      const inserted = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: 300, max_trades: 2 }).select().maybeSingle();
      if (inserted.data) setProfile(inserted.data as Profile);
    }
    setLoading(false);
  }, [supabase, sessionUser]);

  useEffect(() => { void loadData(); }, [loadData]);

  const todayTrades = useMemo(() => trades.filter(t => t.trade_date === todayLocal()), [trades]);
  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const limit = Number(profile?.daily_loss_limit ?? dailyLimit ?? 300);
  const tradeCap = Number(profile?.max_trades ?? maxTrades ?? 2);
  const guardrailHit = todayPnl <= -Math.abs(limit) || todayTrades.length >= tradeCap;
  const compliant = (t: Trade) => t.setup_valid && t.confirmation_waited;
  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) < 0);
  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
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
    <section className="main-content"><header className="topbar"><div><p className="eyebrow">PERSONAL LIVE ACCOUNT</p><h1>Your trading cockpit</h1></div><div className="topbar-right"><span className="date-pill">{new Date().toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}</span><button className="button primary" onClick={() => setShowForm(v => !v)}>＋ Log a trade</button></div></header>
      {status && <div className="status-banner" role="status">{status}<button onClick={() => setStatus('')} aria-label="Dismiss">×</button></div>}
      <div className={`guardrail ${guardrailHit ? 'danger' : 'safe'}`}><div className="guardrail-icon">{guardrailHit ? '!' : '✓'}</div><div><strong>{guardrailHit ? 'Journal guardrail reached — stop this session' : 'Session guardrail'}</strong><p>{todayTrades.length} of {tradeCap} trades logged today · Daily P&L {money(todayPnl)} · Loss limit {money(Math.abs(limit))}</p></div><span className="guardrail-tag">{guardrailHit ? 'STOP' : 'ACTIVE'}</span></div>
      <section id="overview" className="metric-grid"><Metric label="Net P&L · all logged trades" value={money(totalPnl)} tone={totalPnl >= 0 ? 'positive' : 'negative'} note={`${trades.length} trades recorded`}/><Metric label="Green / red days" value={`${winDays} / ${redDays}`} note="Days with a non-zero net result"/><Metric label="Average winning trade" value={money(avgWin)} tone="positive" note={`${wins.length} winning trades`}/><Metric label="Average losing trade" value={money(avgLoss)} tone="negative" note={`${losses.length} losing trades`}/></section>
      {showForm && <section className="panel form-panel"><div className="panel-heading"><div><p className="eyebrow">JOURNAL ENTRY</p><h2>Log a trade</h2></div><button className="icon-button" onClick={() => setShowForm(false)}>×</button></div>{guardrailHit && <div className="notice danger-text">Your session guardrail is reached. Do not place another trade. If you already took a trade, still log it below so the analysis stays complete.</div>}<form onSubmit={addTrade} className="trade-form"><label>Date<input type="date" value={form.trade_date} onChange={e => setForm({ ...form, trade_date: e.target.value })} required/></label><label>Symbol<input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })} required/></label><label>Direction<select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value as 'Long' | 'Short' })}><option>Long</option><option>Short</option></select></label><label>Net P&L (CAD)<input type="number" step="0.01" value={form.pnl} onChange={e => setForm({ ...form, pnl: e.target.value })} placeholder="e.g. -125.50" required/></label><label>Emotion at entry<select value={form.emotion} onChange={e => setForm({ ...form, emotion: e.target.value })}><option>Calm</option><option>FOMO</option><option>Impatient</option><option>Frustrated</option><option>Revenge / recovery</option><option>Overconfident</option><option>Bored</option><option>Anxious</option></select></label><div className="toggle-row"><label className="check-label"><input type="checkbox" checked={form.setup_valid} onChange={e => setForm({ ...form, setup_valid: e.target.checked })}/> My setup was valid</label><label className="check-label"><input type="checkbox" checked={form.confirmation_waited} onChange={e => setForm({ ...form, confirmation_waited: e.target.checked })}/> I waited for confirmation</label></div><label className="wide">Notes / what happened<textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="What did you see? What were you feeling? Did you follow the plan?"/></label><div className="form-actions wide"><p className="tiny muted">Log each trade honestly, including rule-breaking trades. This journal does not connect to your broker.</p><button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Save trade'}</button></div></form></section>}
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
