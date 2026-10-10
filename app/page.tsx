'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Trade = {
  id: string; user_id: string; trade_date: string; trade_time?: string | null; symbol: string; direction: 'Long' | 'Short';
  pnl: number; setup_valid: boolean; confirmation_waited: boolean; emotion: string; notes: string;
  contracts?: number | null; size_rule_broken?: boolean | null;
  created_at: string;
};
type Profile = { id: string; daily_loss_limit: number; max_trades: number; current_equity?: number; base_contracts?: number };
type CashMovement = { id: string; user_id: string; movement_date: string; movement_type: 'deposit' | 'withdrawal'; amount: number; notes: string; after_loss_day?: boolean | null; created_at: string };

// Capital-protection rules. Change these numbers to tune the guard.
const MAX_CONSECUTIVE_LOSSES = 2;   // stop for the day after this many losses in a row
const COOLDOWN_MINUTES = 30;        // mandatory pause after every losing trade
const GIVE_BACK_FRACTION = 0.5;     // stop if you give back this share of the day's peak profit
const COMPOUND_PERCENT = 30;        // daily target as a percent of the day's starting balance
const MAX_TRADES_ALLOWED = 3;       // the daily trade cap can be set from 1 to this number
type CompoundingDay = { id: string; user_id: string; trading_date: string; starting_balance: number; target_percent: number; closing_balance: number | null };

const money = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n);
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateLabel = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
// Chronological order within a day: by trade time first, then by when it was logged.
const byTradeOrder = (a: Trade, b: Trade) => (a.trade_time ?? '').localeCompare(b.trade_time ?? '') || a.created_at.localeCompare(b.created_at);
// When a trade happened, as a Date (falls back to the time it was logged).
const tradeMoment = (t: Trade) => (t.trade_time ? new Date(`${t.trade_date}T${t.trade_time.slice(0, 5)}:00`) : new Date(t.created_at));

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
  const [baseContracts, setBaseContracts] = useState('1');
  const [depositAck, setDepositAck] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'compliant' | 'rulebreak'>('all');
  const [form, setForm] = useState({ trade_date: todayLocal(), trade_time: '09:30', symbol: 'XAUUSD', direction: 'Long' as 'Long' | 'Short', contracts: '', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });

  // Ticks every 20 seconds so the cooldown countdown stays current.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(id);
  }, []);

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
      setProfile(p); setDailyLimit(String(p.daily_loss_limit)); setMaxTrades(String(p.max_trades)); setCurrentEquity(String(p.current_equity ?? 0)); setBaseContracts(String(p.base_contracts ?? 1));
    } else {
      const inserted = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: 300, max_trades: 2, current_equity: 0 }).select().maybeSingle();
      if (inserted.data) { setProfile(inserted.data as Profile); setCurrentEquity(String((inserted.data as Profile).current_equity ?? 0)); }
    }
    // Compounding: each day starts from your "Current account equity" number (which already
    // includes deposits, withdrawals and past results) and aims for COMPOUND_PERCENT of it.
    // The starting balance is locked once the day's row exists, so saving your equity after
    // trading does not move today's target. Tomorrow starts from the equity you save tonight.
    const day = todayLocal();
    const equitySaved = profileRes.data ? Number((profileRes.data as Profile).current_equity ?? 0) : 0;
    // A new account has no saved equity yet, so it starts from what was deposited (deposits minus withdrawals).
    const contributed = ((cashRes.data ?? []) as CashMovement[]).reduce((s, m) => s + (m.movement_type === 'deposit' ? 1 : -1) * Number(m.amount), 0);
    const equityNow = equitySaved > 0 ? equitySaved : Math.max(0, contributed);
    const existingDay = await supabase.from('compounding_days').select('*').eq('user_id', sessionUser.id).eq('trading_date', day).maybeSingle();
    if (existingDay.error) setStatus(`Compounding tracker needs its database migration: ${existingDay.error.message}`);
    else if (existingDay.data) setCompoundingDay(existingDay.data as CompoundingDay);
    else if (equityNow > 0) {
      const created = await supabase.from('compounding_days').insert({ user_id: sessionUser.id, trading_date: day, starting_balance: equityNow, target_percent: COMPOUND_PERCENT }).select().single();
      if (created.data) setCompoundingDay(created.data as CompoundingDay);
      else {
        // A parallel load may have created today's row first; read it back.
        const again = await supabase.from('compounding_days').select('*').eq('user_id', sessionUser.id).eq('trading_date', day).maybeSingle();
        if (again.data) setCompoundingDay(again.data as CompoundingDay);
        else if (created.error) setStatus(`Compounding tracker needs its database migration: ${created.error.message}`);
      }
    } else setCompoundingDay(null);
    setLoading(false);
  }, [supabase, sessionUser]);

  useEffect(() => { void loadData(); }, [loadData]);

  const todayTrades = useMemo(() => trades.filter(t => t.trade_date === todayLocal()), [trades]);
  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const limit = Number(profile?.daily_loss_limit ?? dailyLimit ?? 300);
  const tradeCap = Math.min(MAX_TRADES_ALLOWED, Math.max(1, Number(profile?.max_trades ?? maxTrades ?? 2)));
  // Live balance: everything deposited minus withdrawn, plus every logged trade. Because this is computed
  // from the current lists, it recalculates the moment a trade (or deposit) is logged, edited or deleted.
  const contributedNow = cashMovements.reduce((s, m) => s + (m.movement_type === 'deposit' ? 1 : -1) * Number(m.amount), 0);
  const liveBalance = Math.max(0, contributedNow + trades.reduce((s, t) => s + Number(t.pnl), 0));
  // With no deposits recorded yet, fall back to the saved day snapshot (built from saved equity).
  const startBalance = contributedNow > 0 ? liveBalance : Number(compoundingDay?.starting_balance ?? 0);
  const dailyTarget = Math.max(0, startBalance * Number(compoundingDay?.target_percent ?? COMPOUND_PERCENT) / 100);
  const targetProgress = dailyTarget > 0 ? Math.max(0, Math.min(100, todayPnl / dailyTarget * 100)) : 0;
  const dailyLossHit = todayPnl <= -Math.abs(limit);
  const tradeCountHit = todayTrades.length >= tradeCap;
  const targetReached = todayPnl >= dailyTarget && dailyTarget > 0;

  // ---- Capital-protection rules ------------------------------------------
  const todaySorted = useMemo(() => [...todayTrades].sort(byTradeOrder), [todayTrades]);
  const lastTodayTrade = todaySorted[todaySorted.length - 1];
  const lastLoss = lastTodayTrade && Number(lastTodayTrade.pnl) < 0 ? lastTodayTrade : null;
  const consecutiveLosses = (() => { let n = 0; for (let i = todaySorted.length - 1; i >= 0; i--) { if (Number(todaySorted[i].pnl) < 0) n++; else break; } return n; })();
  const lossStreakHit = consecutiveLosses >= MAX_CONSECUTIVE_LOSSES;
  // Cooldown after a losing trade, capped at the configured length in case a trade time was typed in wrong.
  const cooldownEndsAt = lastLoss ? tradeMoment(lastLoss).getTime() + COOLDOWN_MINUTES * 60000 : 0;
  const cooldownMinutesLeft = cooldownEndsAt > now ? Math.min(COOLDOWN_MINUTES, Math.ceil((cooldownEndsAt - now) / 60000)) : 0;
  // Give-back limit: the best running P&L reached today versus where you are now.
  const dayPeak = (() => { let run = 0, peak = 0; todaySorted.forEach(t => { run += Number(t.pnl); if (run > peak) peak = run; }); return peak; })();
  const giveBackHit = dayPeak >= Math.max(1, dailyTarget * 0.1) && todayPnl <= dayPeak * (1 - GIVE_BACK_FRACTION);
  const guardrailHit = dailyLossHit || tradeCountHit || lossStreakHit || giveBackHit;
  const sessionLocked = guardrailHit || targetReached;
  // Size can only go DOWN after a loss: never above half of normal size, and never above the trade that just lost.
  const normalSize = Math.max(1, Math.floor(Number(profile?.base_contracts ?? baseContracts) || 1));
  const sizeAfterLoss = Math.max(1, Math.floor(normalSize / 2));
  const lastSize = Number(lastTodayTrade?.contracts ?? 0);
  const allowedContracts = sessionLocked ? 0 : lastLoss ? Math.min(sizeAfterLoss, lastSize > 0 ? lastSize : sizeAfterLoss) : normalSize;
  const stopReasons = [
    dailyLossHit && `Daily loss limit reached (${money(Math.abs(limit))})`,
    tradeCountHit && `Trade cap reached (${tradeCap} trades)`,
    lossStreakHit && `${consecutiveLosses} losses in a row`,
    giveBackHit && `You gave back ${Math.round(GIVE_BACK_FRACTION * 100)}% of today's peak profit (${money(dayPeak)} peak)`,
    targetReached && 'Daily target reached',
  ].filter(Boolean) as string[];
  const formContracts = Number(form.contracts);
  const formOversized = Number.isFinite(formContracts) && formContracts > 0 && formContracts > allowedContracts;
  // Depositing on a day that is currently red is the "top it up to keep going" pattern.
  const redDayDeposit = cashForm.movement_type === 'deposit' && cashForm.movement_date === todayLocal() && todayPnl < 0;
  const compliant = (t: Trade) => t.setup_valid && t.confirmation_waited && !t.size_rule_broken;
  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) < 0);
  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const totalDeposited = cashMovements.filter(m => m.movement_type === 'deposit').reduce((sum, m) => sum + Number(m.amount), 0);
  const totalWithdrawn = cashMovements.filter(m => m.movement_type === 'withdrawal').reduce((sum, m) => sum + Number(m.amount), 0);
  const netContributions = totalDeposited - totalWithdrawn;
  const depositsAfterLoss = cashMovements.filter(m => m.movement_type === 'deposit' && m.after_loss_day);
  const depositedAfterLoss = depositsAfterLoss.reduce((sum, m) => sum + Number(m.amount), 0);
  const depositsAfterLossCount = depositsAfterLoss.length;
  const equityValue = Number(profile?.current_equity ?? currentEquity ?? 0);
  const netResultVsCapital = equityValue - netContributions;
  // What "restart compounding" starts from: your saved equity, or the amount deposited if no equity is saved yet.
  const restartBase = equityValue > 0 ? equityValue : Math.max(0, netContributions);
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

  function editTrade(trade: Trade) {
    setEditingTradeId(trade.id);
    setForm({
      trade_date: trade.trade_date,
      trade_time: trade.trade_time ?? '',
      symbol: trade.symbol,
      direction: trade.direction,
      contracts: trade.contracts != null ? String(trade.contracts) : '',
      pnl: String(trade.pnl),
      setup_valid: trade.setup_valid,
      confirmation_waited: trade.confirmation_waited,
      emotion: trade.emotion,
      notes: trade.notes ?? '',
    });
    setStatus('');
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelTradeEdit() {
    setEditingTradeId(null);
    setForm({ trade_date: todayLocal(), trade_time: '09:30', symbol: 'XAUUSD', direction: 'Long', contracts: '', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });
    setShowForm(false);
  }

  async function addTrade(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    if (!form.pnl.trim() || !Number.isFinite(Number(form.pnl))) { setStatus('Enter a valid trade P&L.'); return; }
    const contractsUsed = Number(form.contracts);
    if (!form.contracts.trim() || !Number.isInteger(contractsUsed) || contractsUsed < 1) { setStatus('Enter how many contracts you traded (a whole number, 1 or more).'); return; }
    setSaving(true); setStatus('');
    const tradeValues = {
      user_id: sessionUser.id, trade_date: form.trade_date, trade_time: form.trade_time || null, symbol: form.symbol.trim().toUpperCase(), direction: form.direction,
      contracts: contractsUsed,
      pnl: Number(form.pnl), setup_valid: form.setup_valid, confirmation_waited: form.confirmation_waited,
      emotion: form.emotion, notes: form.notes.trim(),
    };
    // The size check runs only when a NEW trade is logged for today, against the rules as they stood before this trade.
    // Back-dated trades and edits are not re-judged.
    const oversizedAtEntry = !editingTradeId && form.trade_date === todayLocal() && contractsUsed > allowedContracts;
    const result = editingTradeId
      ? await supabase.from('trades').update(tradeValues).eq('id', editingTradeId).eq('user_id', sessionUser.id).select().single()
      : await supabase.from('trades').insert({ ...tradeValues, size_rule_broken: oversizedAtEntry }).select().single();
    if (result.error) {
      setStatus(`Could not ${editingTradeId ? 'update' : 'save'} trade: ${result.error.message}`);
    } else if (result.data) {
      const savedTrade = result.data as Trade;
      setTrades(current => {
        const withoutEdited = current.filter(t => t.id !== savedTrade.id);
        return [savedTrade, ...withoutEdited].sort((a, b) =>
          b.trade_date.localeCompare(a.trade_date) ||
          (b.trade_time ?? '').localeCompare(a.trade_time ?? '') ||
          b.created_at.localeCompare(a.created_at)
        );
      });
      setStatus(editingTradeId ? 'Trade updated. Daily P&L and target progress refreshed.' : oversizedAtEntry ? `Trade saved and marked OVERSIZED: you traded ${contractsUsed} and the guard allowed ${allowedContracts}. It counts as a rule break.` : 'Trade saved. Daily P&L and target progress refreshed.');
      setEditingTradeId(null);
      setForm({ trade_date: todayLocal(), trade_time: '09:30', symbol: 'XAUUSD', direction: 'Long', contracts: '', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });
      setShowForm(false);
      // Refresh the saved compounding snapshot in the background without relying
      // on a second trades fetch for the visible progress bar to update.
      void loadData();
    }
    setSaving(false);
  }


  async function deleteTrade(trade: Trade) {
    if (!supabase || !sessionUser) return;
    const confirmed = window.confirm(`Delete the ${trade.symbol} trade from ${trade.trade_date} with P&L ${money(Number(trade.pnl))}? This cannot be undone.`);
    if (!confirmed) return;
    setSaving(true);
    setStatus('');
    const { error } = await supabase.from('trades').delete().eq('id', trade.id).eq('user_id', sessionUser.id);
    if (error) {
      setStatus(`Could not delete trade: ${error.message}`);
    } else {
      setTrades(items => items.filter(item => item.id !== trade.id));
      setStatus('Trade deleted.');
      if (editingTradeId === trade.id) cancelTradeEdit();
    }
    setSaving(false);
  }

  async function saveCashMovement(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    const amount = Number(cashForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) { setStatus('Enter a positive amount for the deposit or withdrawal.'); return; }
    if (redDayDeposit && !depositAck) { setStatus(`Today is ${money(todayPnl)}. Read the warning above the button and tick the box if you still want to record this deposit.`); return; }
    setSaving(true); setStatus('');
    const { data, error } = await supabase.from('cash_movements').insert({ user_id: sessionUser.id, movement_date: cashForm.movement_date, movement_type: cashForm.movement_type, amount, notes: cashForm.notes.trim(), after_loss_day: redDayDeposit }).select().single();
    if (error) setStatus(`Could not save cash movement: ${error.message}`);
    else { setCashMovements(items => [data as CashMovement, ...items]); setCashForm(f => ({ ...f, amount: '', notes: '' })); setDepositAck(false); void loadData(); setStatus(redDayDeposit ? 'Deposit saved and marked as made after a losing day.' : 'Deposit/withdrawal saved.'); }
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

  async function restartCompounding() {
    if (!supabase || !sessionUser) return;
    const equity = restartBase;
    if (!(equity > 0)) { setStatus('Log your initial deposit (or save your current account equity) first, then restart compounding from it.'); return; }
    const confirmed = window.confirm(`Restart today's compounding from ${money(equity)}? Today's ${COMPOUND_PERCENT}% target will be recalculated from that balance. Use the balance from before today's trades.`);
    if (!confirmed) return;
    setSaving(true); setStatus('');
    const { data, error } = await supabase.from('compounding_days').upsert({ user_id: sessionUser.id, trading_date: todayLocal(), starting_balance: equity, target_percent: COMPOUND_PERCENT }, { onConflict: 'user_id,trading_date' }).select().single();
    if (error) setStatus(`Could not restart compounding: ${error.message}`);
    else { setCompoundingDay(data as CompoundingDay); setStatus(`Compounding restarted from ${money(equity)}. Today's target is now ${money(equity * COMPOUND_PERCENT / 100)}.`); }
    setSaving(false);
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    const l = Number(dailyLimit), c = Number(maxTrades), b = Number(baseContracts);
    if (!Number.isFinite(l) || l <= 0 || !Number.isInteger(c) || c < 1 || c > MAX_TRADES_ALLOWED) { setStatus(`Use a positive loss limit and a whole-number trade cap between 1 and ${MAX_TRADES_ALLOWED}.`); return; }
    if (!Number.isInteger(b) || b < 1 || b > 100) { setStatus('Use a whole number of contracts between 1 and 100 for your normal size.'); return; }
    setSaving(true);
    const { data, error } = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: l, max_trades: c, base_contracts: b }).select().single();
    if (error) setStatus(`Could not save settings: ${error.message}`);
    else { setProfile(data as Profile); setStatus('Risk settings saved. These are journal guardrails, not a broker lockout.'); }
    setSaving(false);
  }

  function exportCSV() {
    const headers = ['trade_date','trade_time','symbol','direction','contracts','pnl_cad','setup_valid','confirmation_waited','size_rule_broken','emotion','notes','created_at'];
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = trades.map(t => [t.trade_date, t.trade_time ?? '', t.symbol, t.direction, t.contracts ?? '', Number(t.pnl), t.setup_valid, t.confirmation_waited, Boolean(t.size_rule_broken), t.emotion, t.notes, t.created_at]);
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
    <section className="main-content"><header className="topbar"><div><p className="eyebrow">PERSONAL LIVE ACCOUNT</p><h1>Your trading cockpit</h1></div><div className="topbar-right"><span className="date-pill">{new Date().toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}</span><button type="button" className="button primary" onClick={() => setShowForm(true)}>{sessionLocked ? 'Session over · log a trade already taken' : '＋ Log a trade'}</button></div></header>
      {showForm && <section className="panel form-panel"><div className="panel-heading"><div><p className="eyebrow">JOURNAL ENTRY</p><h2>{editingTradeId ? "Edit trade" : "Log a trade"}</h2></div><button type="button" className="icon-button" onClick={cancelTradeEdit}>×</button></div>{sessionLocked && <div className="notice danger-text">Your session is locked: {stopReasons.join(' · ')}. Do not place another trade. If you already took a trade, still log it below so the analysis stays complete.</div>}{!sessionLocked && cooldownMinutesLeft > 0 && <div className="notice warning">Cooldown: about {cooldownMinutesLeft} min left after your last loss. Step away from the screen.</div>}<form onSubmit={addTrade} className="trade-form"><label>Date<input type="date" value={form.trade_date} onChange={e => setForm({ ...form, trade_date: e.target.value })} required/></label><label>Trade time<input type="time" value={form.trade_time} onChange={e => setForm({ ...form, trade_time: e.target.value })} required/></label><label>Symbol<input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })} required/></label><label>Direction<select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value as 'Long' | 'Short' })}><option>Long</option><option>Short</option></select></label><label>Contracts traded<input type="number" min="1" step="1" value={form.contracts} onChange={e => setForm({ ...form, contracts: e.target.value })} placeholder={`Allowed now: ${allowedContracts}`} required/></label><label>Net P&L (CAD)<input type="number" step="0.01" value={form.pnl} onChange={e => setForm({ ...form, pnl: e.target.value })} placeholder="e.g. -125.50" required/></label>{formOversized && !editingTradeId && form.trade_date === todayLocal() && <p className="notice danger-text wide"><strong>Oversized.</strong> The size guard allows {allowedContracts} {allowedContracts === 1 ? 'contract' : 'contracts'} right now{allowedContracts === 0 ? ' (session is locked)' : ''}. If you traded {formContracts}, this will be saved as a rule break.</p>}<label>Emotion at entry<select value={form.emotion} onChange={e => setForm({ ...form, emotion: e.target.value })}><option>Calm</option><option>FOMO</option><option>Impatient</option><option>Frustrated</option><option>Revenge / recovery</option><option>Overconfident</option><option>Bored</option><option>Anxious</option></select></label><div className="toggle-row"><label className="check-label"><input type="checkbox" checked={form.setup_valid} onChange={e => setForm({ ...form, setup_valid: e.target.checked })}/> My setup was valid</label><label className="check-label"><input type="checkbox" checked={form.confirmation_waited} onChange={e => setForm({ ...form, confirmation_waited: e.target.checked })}/> I waited for confirmation</label></div><label className="wide">Notes / what happened<textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="What did you see? What were you feeling? Did you follow the plan?"/></label><div className="form-actions wide"><p className="tiny muted">Log each trade honestly, including rule-breaking trades. This journal does not connect to your broker.</p><div className="button-row"><button type="submit" className="button primary" disabled={saving}>{saving ? 'Saving…' : editingTradeId ? 'Update trade' : 'Save trade'}</button>{editingTradeId && <button type="button" className="button secondary" onClick={cancelTradeEdit}>Cancel edit</button>}</div></div></form></section>}
      {status && <div className="status-banner" role="status">{status}<button onClick={() => setStatus('')} aria-label="Dismiss">×</button></div>}
      <div className={`guardrail ${guardrailHit ? 'danger' : 'safe'}`}><div className="guardrail-icon">{guardrailHit ? '!' : '✓'}</div><div><strong>{guardrailHit ? 'Journal guardrail reached — stop this session' : targetReached ? 'Target reached — you are done for today' : 'Session guardrail'}</strong><p>{todayTrades.length} of {tradeCap} trades logged today · Daily P&L {money(todayPnl)} · Loss limit {money(Math.abs(limit))} · Max size now: {allowedContracts === 0 ? 'none (locked)' : `${allowedContracts} ${allowedContracts === 1 ? 'contract' : 'contracts'}`}{cooldownMinutesLeft > 0 && !sessionLocked ? ` · Cooldown ~${cooldownMinutesLeft} min` : ''}</p>{stopReasons.length > 0 && <p className="tiny">{stopReasons.join(' · ')}</p>}</div><span className="guardrail-tag">{guardrailHit ? 'STOP' : targetReached ? 'DONE' : 'ACTIVE'}</span></div>
      <section id="compounding" className="panel compounding-panel"><div className="panel-heading"><div><p className="eyebrow">DAILY COMPOUNDING & DISCIPLINE</p><h2>Today’s plan</h2><p className="muted tiny">{todayLocal()} · Each day starts from your account equity and aims for {COMPOUND_PERCENT}% of it. You are done for the day when you hit the target or your trade cap, whichever comes first.</p></div><span className="panel-icon">↗</span></div>{startBalance <= 0 && <p className="notice warning"><strong>Compounding has no starting balance yet.</strong> Log your initial deposit in Deposits &amp; withdrawals below (or save your current account equity). Compounding starts from it automatically.</p>}<div className="button-row"><button type="button" className="button secondary" onClick={restartCompounding} disabled={saving || !(restartBase > 0)}>Restart compounding from my {equityValue > 0 ? 'current equity' : 'initial deposit'} ({money(restartBase)})</button></div><div className="account-summary-grid"><div className="account-stat"><span>Starting balance today</span><strong>{money(startBalance)}</strong><small>Your account equity when today began</small></div><div className="account-stat"><span>{COMPOUND_PERCENT}% target</span><strong>{money(dailyTarget)}</strong><small>Calculated from today’s starting balance</small></div><div className="account-stat"><span>Actual daily P&amp;L</span><strong className={todayPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(todayPnl)}</strong><small>{todayTrades.length} of {tradeCap} trades used</small></div></div><div className="progress-label"><span>Progress toward target ({money(todayPnl)} of {money(dailyTarget)})</span><strong>{Math.round(targetProgress)}%</strong></div><div className="bar-track compounding-progress"><div className="bar-fill gold-fill" style={{width:`${targetProgress}%`}} /></div>{targetReached && <div className="notice warning"><strong>Target reached.</strong> Your goal is complete for today. Do not increase size or keep trading just to make more.</div>}{guardrailHit && <div className="notice danger-text"><strong>STOP TRADING.</strong> {stopReasons.filter(r => r !== 'Daily target reached').join(' · ')}. Close the platform and leave the room. This is a journal warning, not a broker lockout.</div>}<div className="compounding-risk-row"><label>Planned loss if this trade fails (CAD)<input type="number" min="0" step="0.01" value={plannedRisk} onChange={e => setPlannedRisk(e.target.value)} /></label><label>Planned leverage (optional)<input type="number" min="1" step="1" value={plannedLeverage} onChange={e => setPlannedLeverage(e.target.value)} placeholder="e.g. 100" /></label></div><p className={`notice ${Number(plannedRisk) > startBalance * 0.01 ? 'warning' : ''}`}><strong>Risk check:</strong> {Number(plannedRisk) > startBalance * 0.01 ? `This planned loss is more than 1% of today's starting balance (${money(startBalance * 0.01)}). Consider reducing risk or skipping the trade.` : `Planned loss is within 1% of today's starting balance (${money(startBalance * 0.01)}).`}{plannedLeverage && Number(plannedLeverage) > 100 ? ' High leverage entered: recheck position size and stop distance before trading.' : ''}</p><p className="tiny muted">{startBalance > 0 ? `At a ${money(startBalance)} starting balance, your ${money(Math.abs(limit))} daily loss limit is about ${(Math.abs(limit) / startBalance * 100).toFixed(1)}% of the account. ` : ''}Leverage alone does not determine risk; position size and stop distance matter too.</p></section>
      <section className="account-summary panel"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT PERFORMANCE</p><h2>Capital & cash flow</h2></div></div><div className="account-summary-grid"><div className="account-stat"><span>Trading P&amp;L</span><strong className={totalPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(totalPnl)}</strong><small>Sum of logged trade results</small></div><div className="account-stat"><span>Total deposited</span><strong>{money(totalDeposited)}</strong><small>All recorded deposits</small></div><div className="account-stat"><span>Total withdrawn</span><strong>{money(totalWithdrawn)}</strong><small>All recorded withdrawals</small></div><div className="account-stat"><span>Deposited after red days</span><strong className={depositedAfterLoss > 0 ? 'negative-text' : ''}>{money(depositedAfterLoss)}</strong><small>{depositsAfterLossCount} {depositsAfterLossCount === 1 ? 'deposit' : 'deposits'} made on a losing day</small></div><div className="account-stat"><span>Net contributions</span><strong>{money(netContributions)}</strong><small>Deposits minus withdrawals</small></div><div className="account-stat"><span>Current account equity</span><strong>{money(equityValue)}</strong><small>Manually entered balance/equity</small></div><div className="account-stat"><span>Net result vs. capital</span><strong className={netResultVsCapital >= 0 ? 'positive-text' : 'negative-text'}>{money(netResultVsCapital)}</strong><small>Equity minus net contributions</small></div></div><form className="equity-form" onSubmit={saveCurrentEquity}><label>Update current account equity (CAD)<input type="number" min="0" step="0.01" value={currentEquity} onChange={e => setCurrentEquity(e.target.value)} required /></label><button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Save equity'}</button></form><p className="tiny muted">Net result vs. capital is an estimate based on the equity you enter and recorded deposits/withdrawals. Include all relevant transfers and adjustments for an accurate figure. Trading P&amp;L is calculated separately from your logged trades.</p></section>
      <section id="calendar" className="panel calendar-panel"><div className="panel-heading calendar-heading"><div><p className="eyebrow">DAILY PERFORMANCE</p><h2>Trading calendar</h2><p className="muted tiny">Monthly P&amp;L: <strong className={monthPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(monthPnl)}</strong> · {monthTrades.length} trades</p></div><div className="calendar-controls"><button type="button" className="button secondary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>‹</button><strong>{calendarMonth.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</strong><button type="button" className="button secondary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>›</button></div></div><div className="calendar-grid">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => <div key={d} className="calendar-weekday">{d}</div>)}{calendarCells.map((day, i) => day ? <button type="button" key={day} onClick={() => setSelectedDay(day)} className={`calendar-day ${selectedDay === day ? 'selected' : ''} ${trades.some(t => t.trade_date === day) ? (dayPnl(day) >= 0 ? 'profit-day' : 'loss-day') : ''}`}><span>{Number(day.slice(-2))}</span>{trades.some(t => t.trade_date === day) && <strong>{money(dayPnl(day))}</strong>}</button> : <div key={`blank-${i}`} className="calendar-empty" />)}</div><div className="selected-day-detail"><h3>{new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>{selectedDayTrades.length ? <><p className={dayPnl(selectedDay) >= 0 ? 'positive-text' : 'negative-text'}>Daily P&amp;L: <strong>{money(dayPnl(selectedDay))}</strong></p><ul>{selectedDayTrades.map(t => <li key={t.id}>{t.trade_time ? `${t.trade_time.slice(0, 5)} · ` : ''}{t.symbol} · {t.direction} · <strong className={Number(t.pnl) >= 0 ? 'positive-text' : 'negative-text'}>{money(Number(t.pnl))}</strong> · {t.emotion}</li>)}</ul></> : <p className="muted tiny">No trades logged for this date.</p>}</div></section>
      <section className="panel cash-panel"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT ACTIVITY</p><h2>Deposits &amp; withdrawals</h2></div></div><form className="cash-form" onSubmit={saveCashMovement}><label>Type<select value={cashForm.movement_type} onChange={e => setCashForm({ ...cashForm, movement_type: e.target.value as 'deposit' | 'withdrawal' })}><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label><label>Date<input type="date" value={cashForm.movement_date} onChange={e => setCashForm({ ...cashForm, movement_date: e.target.value })} required /></label><label>Amount (CAD)<input type="number" min="0.01" step="0.01" value={cashForm.amount} onChange={e => setCashForm({ ...cashForm, amount: e.target.value })} placeholder="0.00" required /></label><label>Notes (optional)<input value={cashForm.notes} onChange={e => setCashForm({ ...cashForm, notes: e.target.value })} placeholder="e.g. monthly funding" /></label>{redDayDeposit && <div className="notice danger-text wide"><strong>Pause. Today is {money(todayPnl)}.</strong> Money added to chase back a losing day is the pattern this app is here to break. Money in the account does not change the market, and the bills still need paying. Walk away for {COOLDOWN_MINUTES} minutes before depositing.<label className="check-label"><input type="checkbox" checked={depositAck} onChange={e => setDepositAck(e.target.checked)} /> I understand this will be logged as a deposit after a losing day</label></div>}<button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Add movement'}</button></form><div className="cash-table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead><tbody>{cashMovements.length ? cashMovements.map(m => <tr key={m.id}><td>{dateLabel(m.movement_date)}</td><td>{m.movement_type === 'deposit' ? 'Deposit' : 'Withdrawal'}</td><td className={m.movement_type === 'deposit' ? 'positive-text' : 'negative-text'}>{m.movement_type === 'deposit' ? '+' : '−'}{money(Number(m.amount))}</td><td>{m.notes || '—'}</td></tr>) : <tr><td colSpan={4} className="muted">No deposits or withdrawals recorded yet.</td></tr>}</tbody></table></div></section>
      <section id="overview" className="metric-grid"><Metric label="Net P&L · all logged trades" value={money(totalPnl)} tone={totalPnl >= 0 ? 'positive' : 'negative'} note={`${trades.length} trades recorded`}/><Metric label="Green / red days" value={`${winDays} / ${redDays}`} note="Days with a non-zero net result"/><Metric label="Average winning trade" value={money(avgWin)} tone="positive" note={`${wins.length} winning trades`}/><Metric label="Average losing trade" value={money(avgLoss)} tone="negative" note={`${losses.length} losing trades`}/></section>
      <section id="analysis" className="analysis-grid"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">PROCESS OVER P&L</p><h2>Rule-following breakdown</h2></div><span className="panel-icon">⌁</span></div><div className="comparison"><div className="comparison-row"><div><span className="legend-dot gold"/> <span>Compliant trades</span></div><strong className={compliantPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(compliantPnl)}</strong></div><div className="bar-track"><div className="bar-fill gold-fill" style={{ width: `${trades.length ? compliantTrades.length / trades.length * 100 : 0}%` }}/></div><p className="muted tiny">{compliantTrades.length} trades where setup was valid and confirmation was respected</p><div className="comparison-row"><div><span className="legend-dot red"/> <span>Rule-breaking trades</span></div><strong className={ruleBreakPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(ruleBreakPnl)}</strong></div><div className="bar-track"><div className="bar-fill red-fill" style={{ width: `${trades.length ? ruleBreakTrades.length / trades.length * 100 : 0}%` }}/></div><p className="muted tiny">{ruleBreakTrades.length} trades with an invalid setup, missing confirmation, or oversized entry</p></div><div className="insight-box"><span className="insight-star">✦</span><p>{trades.length ? `You have logged ${trades.length} trades. Keep logging every trade so we can compare compliant execution with impulsive entries over time.` : 'Your first goal is to build a complete record. Log wins, losses, and rule-breaking trades—not just the memorable ones.'}</p></div></div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">BEHAVIORAL SIGNALS</p><h2>What may be costing you</h2></div><span className="panel-icon">◎</span></div><div className="signal-list"><Signal label="FOMO / early entry" value={trades.filter(t => t.emotion === 'FOMO' || !t.confirmation_waited).length} total={trades.length} color="red"/><Signal label="Invalid setup" value={trades.filter(t => !t.setup_valid).length} total={trades.length} color="gold"/><Signal label="Oversized trades" value={trades.filter(t => t.size_rule_broken).length} total={trades.length} color="red"/><Signal label="Recovery / revenge" value={trades.filter(t => t.emotion === 'Revenge / recovery').length} total={trades.length} color="red"/><Signal label="Trades beyond first two" value={trades.filter(t => { const sameDay = trades.filter(x => x.trade_date === t.trade_date).sort((a,b) => a.created_at.localeCompare(b.created_at)); return sameDay.findIndex(x => x.id === t.id) >= 2; }).length} total={trades.length} color="gold"/></div><p className="tiny muted signal-foot">These are descriptive counts, not diagnoses or proof of causation. More complete logging improves the analysis.</p></div></section>
      <section id="risk" className="panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">PRE-COMMITMENT</p><h2>Your risk guardrails</h2><p className="muted">Choose limits before your next session.</p></div><span className="panel-icon">⛨</span></div><form className="settings-form" onSubmit={saveSettings}><label>Maximum daily loss (CAD)<input type="number" min="1" step="1" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} required/></label><label>Maximum trades per day (1–{MAX_TRADES_ALLOWED})<input type="number" min="1" max={MAX_TRADES_ALLOWED} step="1" value={maxTrades} onChange={e => setMaxTrades(e.target.value)} required/></label><label>Normal size (contracts)<input type="number" min="1" max="100" step="1" value={baseContracts} onChange={e => setBaseContracts(e.target.value)} required/></label><button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Save my limits'}</button></form><p className="tiny muted">Size rules: after a loss your size can only go down (to half of normal, and never above the trade that just lost). {MAX_CONSECUTIVE_LOSSES} losses in a row, hitting your target, or giving back {Math.round(GIVE_BACK_FRACTION * 100)}% of the day&apos;s peak profit locks the session. A {COOLDOWN_MINUTES}-minute cooldown follows every loss.</p><p className="notice warning"><strong>Important:</strong> These are journal-side warnings and entry-form guardrails, not a broker-level lockout. They cannot prevent you from placing trades in your trading platform. For stronger protection, configure any available broker-side limits and stop live trading if you cannot reliably stop.</p></section>
      <section id="journal" className="panel journal-panel"><div className="panel-heading journal-heading"><div><p className="eyebrow">YOUR RECORD</p><h2>Trade history</h2></div><div className="journal-actions"><button className="button secondary export-button" onClick={exportCSV} disabled={trades.length === 0}>Export CSV</button><div className="filter-tabs"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'compliant' ? 'selected' : ''} onClick={() => setFilter('compliant')}>Compliant</button><button className={filter === 'rulebreak' ? 'selected' : ''} onClick={() => setFilter('rulebreak')}>Rule breaks</button></div></div></div>{loading ? <p className="muted">Loading trades…</p> : shownTrades.length === 0 ? <div className="empty-state"><div className="empty-icon">▤</div><h3>No trades here yet</h3><p>Once you log trades, this table will help you identify patterns.</p></div> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Symbol</th><th>Direction</th><th>Size</th><th>P&L</th><th>Emotion</th><th>Execution</th><th>Notes</th><th>Actions</th></tr></thead><tbody>{shownTrades.map(t => <tr key={t.id}><td>{dateLabel(t.trade_date)}</td><td>{t.trade_time ? t.trade_time.slice(0, 5) : '—'}</td><td className="symbol-cell">{t.symbol}</td><td>{t.direction}</td><td>{t.contracts ?? '—'}</td><td className={Number(t.pnl) >= 0 ? 'positive-text' : 'negative-text'}>{money(Number(t.pnl))}</td><td><span className={`emotion-chip ${t.emotion === 'FOMO' || t.emotion === 'Revenge / recovery' ? 'emotion-risk' : ''}`}>{t.emotion}</span></td><td><span className={`execution-pill ${compliant(t) ? 'execution-good' : 'execution-bad'}`}>{compliant(t) ? 'Followed' : t.size_rule_broken && t.setup_valid && t.confirmation_waited ? 'Oversized' : 'Rule break'}</span></td><td className="notes-cell" title={t.notes}>{t.notes || '—'}</td><td><button type="button" className="button secondary" onClick={() => editTrade(t)}>Edit</button> <button type="button" className="button secondary" disabled={saving} onClick={() => deleteTrade(t)}>Delete</button></td></tr>)}</tbody></table></div>}</section>
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
