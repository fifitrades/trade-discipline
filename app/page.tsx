'use client';

import { ChangeEvent, FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ImportedTrade, parseTradeReport, splitDuplicates } from './importer';
import { bookedDate, bookedTime, exitProblem, holdLabel } from './trades';
import { chunkWeeks, weekSummary } from './calendar';
import { dayStartBalance as computeDayStart, goalReached, goalTarget, runningPeak } from './goal';
import { afterGreenVsRed, byHoldTime, byHour, byTradeNumber, formatMinutes, holdWinnersVsLosers, Bucket, DayGroup, HoldSummary, MIN_SAMPLE } from './patterns';

type Trade = {
  id: string; user_id: string; trade_date: string; trade_time?: string | null; exit_date?: string | null; exit_time?: string | null; symbol: string; direction: 'Long' | 'Short';
  pnl: number; setup_valid: boolean; confirmation_waited: boolean; emotion: string; notes: string;
  contracts?: number | null; size_rule_broken?: boolean | null;
  created_at: string;
};
type GoalMode = 'none' | 'amount' | 'percent';
type Profile = { id: string; daily_loss_limit: number; max_trades: number; current_equity?: number; base_contracts?: number; goal_mode?: GoalMode; goal_value?: number };
type CashMovement = { id: string; user_id: string; movement_date: string; movement_type: 'deposit' | 'withdrawal'; amount: number; notes: string; after_loss_day?: boolean | null; created_at: string };

// Capital-protection rules. Change these numbers to tune the guard.
const MAX_CONSECUTIVE_LOSSES = 2;   // stop for the day after this many losses in a row
const COOLDOWN_MINUTES = 30;        // mandatory pause after every losing trade
const GIVE_BACK_FRACTION = 0.5;     // stop if you give back this share of the day's peak profit
const COMPOUND_PERCENT = 30;        // percent offered as the starting suggestion when someone picks compounding
const MAX_TRADES_ALLOWED = 3;       // the daily trade cap can be set from 1 to this number
type CompoundingDay = { id: string; user_id: string; trading_date: string; starting_balance: number; target_percent: number; closing_balance: number | null };

// Lot sizes show up to 2 decimals and drop trailing zeros (0.80 -> 0.8, 1.00 -> 1).
const lots = (n: number) => String(Number(Number(n).toFixed(2)));
const SIZE_TOLERANCE = 0.0001;
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
  const [goalMode, setGoalMode] = useState<GoalMode>('none');
  const [goalValue, setGoalValue] = useState('');
  const [depositAck, setDepositAck] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [importPreview, setImportPreview] = useState<{ fileName: string; fresh: ImportedTrade[]; duplicates: number; skipped: number; problems: string[] } | null>(null);
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'compliant' | 'rulebreak'>('all');
  const [form, setForm] = useState({ trade_date: todayLocal(), trade_time: '09:30', symbol: 'XAUUSD', direction: 'Long' as 'Long' | 'Short', contracts: '', exit_date: '', exit_time: '', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });

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
      setProfile(p); setDailyLimit(String(p.daily_loss_limit)); setMaxTrades(String(p.max_trades)); setBaseContracts(String(p.base_contracts ?? 1)); setGoalMode((p.goal_mode ?? 'none') as GoalMode); setGoalValue(p.goal_value ? String(p.goal_value) : '');
    } else {
      const inserted = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: 300, max_trades: 2, current_equity: 0 }).select().maybeSingle();
      if (inserted.data) { setProfile(inserted.data as Profile);  }
    }
    // Each day starts from the equity the app calculates: deposits minus withdrawals plus the results of all trades booked before today.
    // The starting balance is locked once the day's row exists, so trading during the day never moves today's target.
    const day = todayLocal();
    const contributed = ((cashRes.data ?? []) as CashMovement[]).reduce((s, m) => s + (m.movement_type === 'deposit' ? 1 : -1) * Number(m.amount), 0);
    const pnlBeforeToday = ((tradeRes.data ?? []) as Trade[]).filter(t => (t.exit_date ?? t.trade_date) < day).reduce((sum, t) => sum + Number(t.pnl), 0);
    const equityNow = Math.max(0, contributed + pnlBeforeToday);
    const savedProfile = profileRes.data as Profile | null;
    const profileGoalPercent = savedProfile?.goal_mode === 'percent' && Number(savedProfile.goal_value) > 0 ? Number(savedProfile.goal_value) : COMPOUND_PERCENT;
    const existingDay = await supabase.from('compounding_days').select('*').eq('user_id', sessionUser.id).eq('trading_date', day).maybeSingle();
    if (existingDay.error) setStatus(`Compounding tracker needs its database migration: ${existingDay.error.message}`);
    else if (existingDay.data) setCompoundingDay(existingDay.data as CompoundingDay);
    else if (equityNow > 0) {
      const created = await supabase.from('compounding_days').insert({ user_id: sessionUser.id, trading_date: day, starting_balance: equityNow, target_percent: profileGoalPercent }).select().single();
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

  // P&L is booked on the day you GOT OUT (the exit date), so a swing trade's loss lands on the day you took it.
  // A trade with no exit date is booked on its entry day, exactly as before.
  const bookedTrades = useMemo(() => trades.map(t => ({ ...t, trade_date: bookedDate(t), trade_time: bookedTime(t) })), [trades]);
  const todayTrades = useMemo(() => bookedTrades.filter(t => t.trade_date === todayLocal()), [bookedTrades]);
  // The daily trade cap counts trades you ENTERED today.
  const todayEntryCount = trades.filter(t => t.trade_date === todayLocal()).length;
  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const limit = Number(profile?.daily_loss_limit ?? dailyLimit ?? 300);
  const tradeCap = Math.min(MAX_TRADES_ALLOWED, Math.max(1, Number(profile?.max_trades ?? maxTrades ?? 2)));
  // Live balance: everything deposited minus withdrawn, plus every logged trade. Because this is computed
  // from the current lists, it recalculates the moment a trade (or deposit) is logged, edited or deleted.
  const contributedNow = cashMovements.reduce((s, m) => s + (m.movement_type === 'deposit' ? 1 : -1) * Number(m.amount), 0);
  const liveBalance = Math.max(0, contributedNow + trades.reduce((s, t) => s + Number(t.pnl), 0));
  // With no deposits recorded yet, fall back to the saved day snapshot (built from saved equity).
  const startBalance = contributedNow > 0 ? liveBalance : Number(compoundingDay?.starting_balance ?? 0);
  // Daily goal is chosen in the risk settings: none, a fixed amount, or a percent of the live balance (compounding).
  const activeGoalMode: GoalMode = profile?.goal_mode ?? 'none';
  const activeGoalValue = Math.max(0, Number(profile?.goal_value ?? 0));
  // The goal is locked to the balance you STARTED today with, so winning today does not raise today's target.
  // Tomorrow it is recalculated from your new balance.
  const dayStartBalance = computeDayStart(cashMovements, bookedTrades, todayLocal(), Number(compoundingDay?.starting_balance ?? 0));
  const dailyTarget = goalTarget(activeGoalMode, activeGoalValue, dayStartBalance);
  const dailyLossHit = todayPnl <= -Math.abs(limit);
  const tradeCountHit = todayEntryCount >= tradeCap;

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
  const dayPeak = runningPeak(todaySorted.map(t => Number(t.pnl)));
  // Once today's goal has been touched it stays reached for the rest of the day, even if a later trade takes P&L back below it.
  const targetReached = goalReached(dailyTarget, dayPeak);
  const targetProgress = targetReached ? 100 : dailyTarget > 0 ? Math.max(0, Math.min(100, todayPnl / dailyTarget * 100)) : 0;
  // The give-back rule only starts once the day has a meaningful peak: 10% of the goal, or 25% of the loss limit when there is no goal.
  const peakFloor = dailyTarget > 0 ? dailyTarget * 0.1 : Math.abs(limit) * 0.25;
  const giveBackHit = dayPeak >= Math.max(1, peakFloor) && todayPnl <= dayPeak * (1 - GIVE_BACK_FRACTION);
  const guardrailHit = dailyLossHit || tradeCountHit || lossStreakHit || giveBackHit;
  const sessionLocked = guardrailHit || targetReached;
  // Size can only go DOWN after a loss: never above half of normal size, and never above the trade that just lost.
  const normalSize = Math.max(0.01, Math.round((Number(profile?.base_contracts ?? baseContracts) || 1) * 100) / 100);
  const sizeAfterLoss = Math.max(0.01, Math.round(normalSize / 2 * 100) / 100);
  const lastSize = Number(lastTodayTrade?.contracts ?? 0);
  const allowedContracts = sessionLocked ? 0 : lastLoss ? Math.min(sizeAfterLoss, lastSize > 0 ? lastSize : sizeAfterLoss) : normalSize;
  const stopReasons = [
    dailyLossHit && `Daily loss limit reached (${money(Math.abs(limit))})`,
    tradeCountHit && `Trade cap reached (${tradeCap} trades)`,
    lossStreakHit && `${consecutiveLosses} losses in a row`,
    giveBackHit && `You gave back ${Math.round(GIVE_BACK_FRACTION * 100)}% of today's peak profit (${money(dayPeak)} peak)`,
    targetReached && 'Daily target reached',
  ].filter(Boolean) as string[];
  // Single status for the banner at the top of the cockpit.
  const goState: 'stop' | 'done' | 'wait' | 'go' = guardrailHit ? 'stop' : targetReached ? 'done' : cooldownMinutesLeft > 0 ? 'wait' : 'go';
  const tradesLeft = Math.max(0, tradeCap - todayEntryCount);
  const lossRoom = Math.max(0, Math.abs(limit) + todayPnl); // how much more you can lose before the daily loss limit
  const formContracts = Number(form.contracts);
  const formOversized = Number.isFinite(formContracts) && formContracts > 0 && formContracts > allowedContracts + SIZE_TOLERANCE;
  // Depositing on a day that is currently red is the "top it up to keep going" pattern.
  const redDayDeposit = cashForm.movement_type === 'deposit' && cashForm.movement_date === todayLocal() && todayPnl < 0;
  const compliant = (t: Trade) => t.setup_valid && t.confirmation_waited && !t.size_rule_broken;
  const wins = trades.filter(t => Number(t.pnl) > 0);
  const losses = trades.filter(t => Number(t.pnl) < 0);
  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const totalDeposited = cashMovements.filter(m => m.movement_type === 'deposit').reduce((sum, m) => sum + Number(m.amount), 0);
  const totalWithdrawn = cashMovements.filter(m => m.movement_type === 'withdrawal').reduce((sum, m) => sum + Number(m.amount), 0);
  const netContributions = totalDeposited - totalWithdrawn;
  // Overall equity as the app sees it: money put in, minus money taken out, plus every logged trade result.
  const overallEquity = netContributions + totalPnl;
  const depositsAfterLoss = cashMovements.filter(m => m.movement_type === 'deposit' && m.after_loss_day);
  const depositedAfterLoss = depositsAfterLoss.reduce((sum, m) => sum + Number(m.amount), 0);
  const depositsAfterLossCount = depositsAfterLoss.length;
  const equityValue = overallEquity;
  const netResultVsCapital = equityValue - netContributions;
  const monthKey = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
  const monthTrades = bookedTrades.filter(t => t.trade_date.startsWith(monthKey));
  const monthPnl = monthTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const selectedDayTrades = bookedTrades.filter(t => t.trade_date === selectedDay);
  const calendarCells = useMemo(() => { const year = calendarMonth.getFullYear(); const month = calendarMonth.getMonth(); const first = new Date(year, month, 1); const start = first.getDay(); const count = new Date(year, month + 1, 0).getDate(); return [...Array(start).fill(null), ...Array.from({ length: count }, (_, i) => `${year}-${String(month + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`)]; }, [calendarMonth]);
  const calendarWeeks = useMemo(() => chunkWeeks(calendarCells), [calendarCells]);
  const dayPnl = (day: string) => bookedTrades.filter(t => t.trade_date === day).reduce((sum, t) => sum + Number(t.pnl), 0);
  const winDays = useMemo(() => {
    const days = new Map<string, number>();
    bookedTrades.forEach(t => days.set(t.trade_date, (days.get(t.trade_date) ?? 0) + Number(t.pnl)));
    return [...days.values()].filter(n => n > 0).length;
  }, [trades]);
  const redDays = useMemo(() => {
    const days = new Map<string, number>();
    bookedTrades.forEach(t => days.set(t.trade_date, (days.get(t.trade_date) ?? 0) + Number(t.pnl)));
    return [...days.values()].filter(n => n < 0).length;
  }, [trades]);
  const ruleBreakTrades = trades.filter(t => !compliant(t));
  const ruleBreakPnl = ruleBreakTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const compliantTrades = trades.filter(compliant);
  const compliantPnl = compliantTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + Number(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + Number(t.pnl), 0) / losses.length) : 0;
  const hourReport = useMemo(() => byHour(trades), [trades]);
  const tradeNumberReport = useMemo(() => byTradeNumber(bookedTrades), [bookedTrades]);
  const holdReport = useMemo(() => byHoldTime(trades), [trades]);
  const holdCompare = useMemo(() => holdWinnersVsLosers(trades), [trades]);
  const dayAfterReport = useMemo(() => afterGreenVsRed(bookedTrades), [bookedTrades]);
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
      exit_date: trade.exit_date ?? '',
      exit_time: trade.exit_time ? trade.exit_time.slice(0, 5) : '',
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
    setForm({ trade_date: todayLocal(), trade_time: '09:30', symbol: 'XAUUSD', direction: 'Long', contracts: '', exit_date: '', exit_time: '', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });
    setShowForm(false);
  }

  async function addTrade(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    if (!form.pnl.trim() || !Number.isFinite(Number(form.pnl))) { setStatus('Enter a valid trade P&L.'); return; }
    const exitMsg = exitProblem(form.trade_date, form.trade_time, form.exit_date, form.exit_time);
    if (exitMsg) { setStatus(exitMsg); return; }
    const contractsUsed = Number(form.contracts);
    if (!form.contracts.trim() || !Number.isFinite(contractsUsed) || contractsUsed < 0.01 || Math.abs(contractsUsed * 100 - Math.round(contractsUsed * 100)) > 1e-6) { setStatus('Enter your lot size as a number with up to 2 decimals, at least 0.01 (for example 0.80).'); return; }
    setSaving(true); setStatus('');
    const tradeValues = {
      user_id: sessionUser.id, trade_date: form.trade_date, trade_time: form.trade_time || null, exit_date: form.exit_date || (form.exit_time ? form.trade_date : null), exit_time: form.exit_time || null, symbol: form.symbol.trim().toUpperCase(), direction: form.direction,
      contracts: contractsUsed,
      pnl: Number(form.pnl), setup_valid: form.setup_valid, confirmation_waited: form.confirmation_waited,
      emotion: form.emotion, notes: form.notes.trim(),
    };
    // The size check runs only when a NEW trade is logged for today, against the rules as they stood before this trade.
    // Back-dated trades and edits are not re-judged.
    const oversizedAtEntry = !editingTradeId && form.trade_date === todayLocal() && contractsUsed > allowedContracts + SIZE_TOLERANCE;
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
      setStatus(editingTradeId ? 'Trade updated. Equity, daily P&L and target progress refreshed.' : oversizedAtEntry ? `Trade saved and marked OVERSIZED: you traded ${lots(contractsUsed)} lots and the guard allowed ${lots(allowedContracts)}. It counts as a rule break. Equity is now ${money(overallEquity + Number(tradeValues.pnl))}.` : `Trade saved. Equity is now ${money(overallEquity + Number(tradeValues.pnl))}.`);
      setEditingTradeId(null);
      setForm({ trade_date: todayLocal(), trade_time: '09:30', symbol: 'XAUUSD', direction: 'Long', contracts: '', exit_date: '', exit_time: '', pnl: '', setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: '' });
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
      setStatus(`Trade deleted. Equity is now ${money(overallEquity - Number(trade.pnl))}.`);
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

  async function saveSettings(e: FormEvent) {
    e.preventDefault(); if (!supabase || !sessionUser) return;
    const l = Number(dailyLimit), c = Number(maxTrades), b = Number(baseContracts);
    const g = goalMode === 'none' ? 0 : Number(goalValue);
    if (goalMode !== 'none' && (!Number.isFinite(g) || g <= 0 || (goalMode === 'percent' && g > 100))) { setStatus(goalMode === 'percent' ? 'Enter a daily goal between 0 and 100 percent of your balance.' : 'Enter a daily goal amount greater than 0.'); return; }
    if (!Number.isFinite(l) || l <= 0 || !Number.isInteger(c) || c < 1 || c > MAX_TRADES_ALLOWED) { setStatus(`Use a positive loss limit and a whole-number trade cap between 1 and ${MAX_TRADES_ALLOWED}.`); return; }
    if (!Number.isFinite(b) || b < 0.01 || b > 100 || Math.abs(b * 100 - Math.round(b * 100)) > 1e-6) { setStatus('Use a lot size between 0.01 and 100, with up to 2 decimals, for your normal size.'); return; }
    setSaving(true);
    const { data, error } = await supabase.from('profiles').upsert({ id: sessionUser.id, daily_loss_limit: l, max_trades: c, base_contracts: b, goal_mode: goalMode, goal_value: g }).select().single();
    if (error) setStatus(`Could not save settings: ${error.message}`);
    else { setProfile(data as Profile); setStatus('Risk settings saved. These are journal guardrails, not a broker lockout.'); }
    setSaving(false);
  }

  function exportCSV() {
    const headers = ['trade_date','trade_time','exit_date','exit_time','symbol','direction','lots','pnl_cad','setup_valid','confirmation_waited','size_rule_broken','emotion','notes','created_at'];
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = trades.map(t => [t.trade_date, t.trade_time ?? '', t.exit_date ?? '', t.exit_time ?? '', t.symbol, t.direction, t.contracts ?? '', Number(t.pnl), t.setup_valid, t.confirmation_waited, Boolean(t.size_rule_broken), t.emotion, t.notes, t.created_at]);
    const csv = [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `trade-discipline-${todayLocal()}.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  async function chooseImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 5_000_000) { setStatus('That file is too big for an import (limit 5 MB). Export a shorter date range.'); return; }
    const parsed = parseTradeReport(await file.text());
    const { fresh, duplicates } = splitDuplicates(parsed.trades, trades);
    setImportPreview({ fileName: file.name, fresh, duplicates, skipped: parsed.skipped, problems: parsed.problems });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function confirmImport() {
    if (!supabase || !sessionUser || !importPreview || importPreview.fresh.length === 0) return;
    setSaving(true); setStatus('');
    const rows = importPreview.fresh.map(t => ({ ...t, user_id: sessionUser.id, setup_valid: true, confirmation_waited: true, emotion: 'Calm', notes: 'Imported from broker report', size_rule_broken: false }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('trades').insert(rows.slice(i, i + 200));
      if (error) { setStatus(`Import stopped after ${i} trades: ${error.message}. Nothing after that was saved, so you can fix it and import again; trades already saved are skipped as duplicates.`); setSaving(false); void loadData(); return; }
    }
    setStatus(`Imported ${rows.length} trade${rows.length === 1 ? '' : 's'} into your journal. The calendar and totals are updated.`);
    setImportPreview(null); setSaving(false); void loadData();
  }

  async function signOut() { await supabase?.auth.signOut(); setTrades([]); setProfile(null); }

  if (!configured) return <main className="setup-page"><div className="setup-card"><div className="brand-mark">TD</div><p className="eyebrow">YOUR PRIVATE TRADING JOURNAL</p><h1>Let's connect your journal.</h1><p className="muted">Add your Supabase project URL and publishable/anon key to a local <code>.env.local</code> file. Then run the SQL in <code>supabase/schema.sql</code>. Full setup instructions are in README.md.</p><pre>NEXT_PUBLIC_SUPABASE_URL=...{`\n`}NEXT_PUBLIC_SUPABASE_ANON_KEY=...</pre></div></main>;
  if (loading && !sessionUser) return <main className="setup-page"><div className="loading-dot"/><p className="muted">Opening your journal…</p></main>;
  if (!sessionUser) return <main className="setup-page"><div className="auth-card"><div className="brand-mark">TD</div><p className="eyebrow">TRADE DISCIPLINE</p><h1>Trade the plan.<br/><em>Protect the account.</em></h1><p className="muted">A private trading journal built around execution, risk and emotional patterns.</p><form onSubmit={handleAuth} className="stack"><label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com"/></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} placeholder="At least 6 characters"/></label><button className="button primary full" disabled={saving}>{saving ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</button></form>{authMessage && <p className="notice">{authMessage}</p>}<p className="auth-switch">{authMode === 'signin' ? 'New here?' : 'Already have an account?'} <button className="text-button" onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthMessage(''); }}>{authMode === 'signin' ? 'Create an account' : 'Sign in'}</button></p><p className="tiny muted">Your journal is private to your account. Do not store broker passwords or API keys here.</p></div></main>;

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand-row"><div className="brand-mark small">TD</div><div><strong>TRADE</strong><span>DISCIPLINE</span></div></div><div className="side-label">WORKSPACE</div><a className="nav-item" href="#risk">⛨ <span>Risk controls</span></a><a className="nav-item active" href="#overview">◈ <span>Overview</span></a><a className="nav-item" href="#journal">▤ <span>Trade journal</span></a><a className="nav-item" href="#analysis">⌁ <span>Behavior analysis</span></a><a className="nav-item" href="#patterns">◔ <span>Pattern reports</span></a><div className="sidebar-bottom"><div className="profile-dot">{(sessionUser.email ?? 'T').slice(0,1).toUpperCase()}</div><div className="profile-email">{sessionUser.email}<span>Personal live account</span></div><button className="icon-button" title="Sign out" onClick={signOut}>↗</button></div></aside>
    <section className="main-content">
<div className={`go-banner go-${goState}`} role="status"><div className="go-word">{goState === 'stop' ? 'STOP' : goState === 'done' ? 'DONE' : goState === 'wait' ? 'WAIT' : 'GO'}</div><div className="go-detail"><strong>{goState === 'stop' ? 'No more trades today' : goState === 'done' ? 'Target reached. You are done for today.' : goState === 'wait' ? `Cooldown: about ${cooldownMinutesLeft} min left` : 'You can trade. Stick to your plan.'}</strong><p>{goState === 'stop' ? stopReasons.join(' · ') + '. Close the platform and leave the room.' : goState === 'done' ? 'Close the platform. Do not size up to make more.' : goState === 'wait' ? `Step away from the screen. When it ends, your max size is ${lots(allowedContracts)} ${allowedContracts === 1 ? 'lot' : 'lots'}.` : `Max size ${lots(allowedContracts)} ${allowedContracts === 1 ? 'lot' : 'lots'} · ${tradesLeft} ${tradesLeft === 1 ? 'trade' : 'trades'} left · ${money(lossRoom)} of room before your loss limit`}</p><p className="tiny">{todayEntryCount} of {tradeCap} trades today · Daily P&amp;L {money(todayPnl)}. This is a journal warning, not a broker lockout.</p></div></div>
<header className="topbar"><div><p className="eyebrow">PERSONAL LIVE ACCOUNT</p><h1>Your trading cockpit</h1></div><div className="summary-strip" aria-label="Account summary"><div className="summary-chip" title="Deposited − withdrawn + all logged trade P&L. Matches your broker only if every trade and cash movement is logged."><span>Equity</span><strong className={overallEquity >= 0 ? '' : 'negative-text'}>{money(overallEquity)}</strong></div><div className="summary-chip"><span>Deposited</span><strong>{money(totalDeposited)}</strong></div><div className="summary-chip"><span>Withdrawn</span><strong>{money(totalWithdrawn)}</strong></div><div className="summary-chip" title="All-time total of every logged trade"><span>Overall P&amp;L</span><strong className={totalPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(totalPnl)}</strong></div></div><div className="topbar-right"><span className="date-pill">{new Date().toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}</span><button type="button" className="button primary" onClick={() => setShowForm(true)}>{sessionLocked ? 'Session over · log a trade already taken' : '＋ Log a trade'}</button></div></header>
      {showForm && <section className="panel form-panel"><div className="panel-heading"><div><p className="eyebrow">JOURNAL ENTRY</p><h2>{editingTradeId ? "Edit trade" : "Log a trade"}</h2></div><button type="button" className="icon-button" onClick={cancelTradeEdit}>×</button></div>{sessionLocked && <div className="notice danger-text">Your session is locked: {stopReasons.join(' · ')}. Do not place another trade. If you already took a trade, still log it below so the analysis stays complete.</div>}{!sessionLocked && cooldownMinutesLeft > 0 && <div className="notice warning">Cooldown: about {cooldownMinutesLeft} min left after your last loss. Step away from the screen.</div>}<form onSubmit={addTrade} className="trade-form"><label>Date<input type="date" value={form.trade_date} onChange={e => setForm({ ...form, trade_date: e.target.value })} required/></label><label>Trade time<input type="time" value={form.trade_time} onChange={e => setForm({ ...form, trade_time: e.target.value })} required/></label><label>Exit date (optional)<input type="date" value={form.exit_date} min={form.trade_date} onChange={e => setForm({ ...form, exit_date: e.target.value })}/></label><label>Exit time (optional)<input type="time" value={form.exit_time} onChange={e => setForm({ ...form, exit_time: e.target.value })}/></label><label>Symbol<input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })} required/></label><label>Direction<select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value as 'Long' | 'Short' })}><option>Long</option><option>Short</option></select></label><label>Lots traded<input type="number" min="0.01" step="0.01" value={form.contracts} onChange={e => setForm({ ...form, contracts: e.target.value })} placeholder={`Allowed now: ${lots(allowedContracts)}`} required/></label><label>Net P&L (CAD)<input type="number" step="0.01" value={form.pnl} onChange={e => setForm({ ...form, pnl: e.target.value })} placeholder="e.g. -125.50" required/></label>{formOversized && !editingTradeId && form.trade_date === todayLocal() && <p className="notice danger-text wide"><strong>Oversized.</strong> The size guard allows {lots(allowedContracts)} {allowedContracts === 1 ? 'lot' : 'lots'} right now{allowedContracts === 0 ? ' (session is locked)' : ''}. If you traded {lots(formContracts)}, this will be saved as a rule break.</p>}<label>Emotion at entry<select value={form.emotion} onChange={e => setForm({ ...form, emotion: e.target.value })}><option>Calm</option><option>FOMO</option><option>Impatient</option><option>Frustrated</option><option>Revenge / recovery</option><option>Overconfident</option><option>Bored</option><option>Anxious</option></select></label><div className="toggle-row"><label className="check-label"><input type="checkbox" checked={form.setup_valid} onChange={e => setForm({ ...form, setup_valid: e.target.checked })}/> My setup was valid</label><label className="check-label"><input type="checkbox" checked={form.confirmation_waited} onChange={e => setForm({ ...form, confirmation_waited: e.target.checked })}/> I waited for confirmation</label></div><label className="wide">Notes / what happened<textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="What did you see? What were you feeling? Did you follow the plan?"/></label><div className="form-actions wide"><p className="tiny muted">Log each trade honestly, including rule-breaking trades. This journal does not connect to your broker.</p><div className="button-row"><button type="submit" className="button primary" disabled={saving}>{saving ? 'Saving…' : editingTradeId ? 'Update trade' : 'Save trade'}</button>{editingTradeId && <button type="button" className="button secondary" onClick={cancelTradeEdit}>Cancel edit</button>}</div></div></form></section>}
      {importPreview && <section className="panel import-panel"><div className="panel-heading"><div><p className="eyebrow">IMPORT</p><h2>Review before importing</h2><p className="muted tiny">{importPreview.fileName}</p></div><button type="button" className="icon-button" onClick={() => setImportPreview(null)} aria-label="Cancel import">×</button></div><div className="import-stats"><div><strong>{importPreview.fresh.length}</strong><span>new trades</span></div><div><strong>{importPreview.duplicates}</strong><span>already in journal</span></div><div><strong>{importPreview.skipped}</strong><span>rows skipped</span></div><div><strong className={importPreview.fresh.reduce((a, t) => a + t.pnl, 0) >= 0 ? 'positive-text' : 'negative-text'}>{money(importPreview.fresh.reduce((a, t) => a + t.pnl, 0))}</strong><span>net P&amp;L to add</span></div></div>{importPreview.problems.length > 0 && <div className="notice danger-text">{importPreview.problems.slice(0, 5).map((m, i) => <p key={i}>{m}</p>)}</div>}{importPreview.fresh.length > 0 && <div className="table-wrap"><table><thead><tr><th>Entry</th><th>Exit</th><th>Symbol</th><th>Side</th><th>Lots</th><th>P&amp;L</th></tr></thead><tbody>{importPreview.fresh.slice(0, 8).map((t, i) => <tr key={i}><td>{t.trade_date} {t.trade_time ?? ''}</td><td>{t.exit_date ?? '—'} {t.exit_time ?? ''}</td><td>{t.symbol}</td><td>{t.direction}</td><td>{lots(t.contracts)}</td><td className={t.pnl >= 0 ? 'positive-text' : 'negative-text'}>{money(t.pnl)}</td></tr>)}</tbody></table></div>}{importPreview.fresh.length > 8 && <p className="muted tiny">Showing the first 8 of {importPreview.fresh.length}.</p>}<p className="muted tiny">Imported trades are saved to your login only. They are marked as valid setups with calm emotion, so edit any you want to judge honestly. Imports do not trigger the oversize flag.</p><div className="import-actions"><button className="button" onClick={confirmImport} disabled={saving || importPreview.fresh.length === 0}>{saving ? 'Importing…' : `Import ${importPreview.fresh.length} trade${importPreview.fresh.length === 1 ? '' : 's'}`}</button><button className="button secondary" onClick={() => setImportPreview(null)}>Cancel</button></div></section>}
      {status && <div className="status-banner" role="status">{status}<button onClick={() => setStatus('')} aria-label="Dismiss">×</button></div>}
      <section id="risk" className="panel settings-panel"><div className="panel-heading"><div><p className="eyebrow">PRE-COMMITMENT</p><h2>Your risk guardrails</h2><p className="muted">Set your limits and goal for the day before you trade.</p></div><span className="panel-icon">⛨</span></div><form className="settings-form" onSubmit={saveSettings}><label>Maximum daily loss (CAD)<input type="number" min="1" step="1" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} required/></label><label>Maximum trades per day (1–{MAX_TRADES_ALLOWED})<input type="number" min="1" max={MAX_TRADES_ALLOWED} step="1" value={maxTrades} onChange={e => setMaxTrades(e.target.value)} required/></label><label>Normal size (lots)<input type="number" min="0.01" max="100" step="0.01" value={baseContracts} onChange={e => setBaseContracts(e.target.value)} required/></label><label>Daily goal<select value={goalMode} onChange={e => { const m = e.target.value as GoalMode; setGoalMode(m); if (m === 'percent' && !goalValue) setGoalValue(String(COMPOUND_PERCENT)); }}><option value="none">No daily goal</option><option value="amount">Fixed amount per day</option><option value="percent">Compounding: % of my balance</option></select></label>{goalMode !== 'none' && <label>{goalMode === 'percent' ? 'Daily goal (% of balance)' : 'Daily goal (CAD)'}<input type="number" min="0.01" max={goalMode === 'percent' ? 100 : undefined} step="0.01" value={goalValue} onChange={e => setGoalValue(e.target.value)} placeholder={goalMode === 'percent' ? 'e.g. 5' : 'e.g. 150'} required/></label>}<button className="button secondary" disabled={saving}>{saving ? 'Saving…' : 'Save my limits'}</button></form>{goalMode === 'percent' && Number(goalValue) > 10 && <p className="notice warning"><strong>That is a high daily goal.</strong> Compounding at {Number(goalValue)}% a day is very hard to sustain, and chasing a big target is a common reason people size up and break their rules. Most traders set a much smaller goal. It is your choice.</p>}<p className="tiny muted">Daily goal: choose none, a fixed amount you type in, or compounding (a percent of your live balance, so the goal grows as the account does). When you hit the goal, the session locks and the banner says DONE. Compounding is optional, and the percent is up to you.</p><p className="tiny muted">Size rules: after a loss your size can only go down (to half of normal, and never above the trade that just lost). {MAX_CONSECUTIVE_LOSSES} losses in a row, hitting your target, or giving back {Math.round(GIVE_BACK_FRACTION * 100)}% of the day&apos;s peak profit locks the session. A {COOLDOWN_MINUTES}-minute cooldown follows every loss.</p><p className="notice warning"><strong>Important:</strong> These are journal-side warnings and entry-form guardrails, not a broker-level lockout. They cannot prevent you from placing trades in your trading platform. For stronger protection, configure any available broker-side limits and stop live trading if you cannot reliably stop.</p></section>
      {activeGoalMode !== 'none' && <section id="compounding" className="panel compounding-panel"><div className="panel-heading"><div><p className="eyebrow">DAILY GOAL</p><h2>Today’s plan</h2><p className="muted tiny">{todayLocal()} · {activeGoalMode === 'percent' ? `Your goal is ${activeGoalValue}% of the balance you started today with. It stays fixed for the day, and tomorrow it is recalculated from your new balance.` : activeGoalMode === 'amount' ? `Your daily goal is a fixed ${money(activeGoalValue)}.` : 'You have no daily goal set. Choose one in your risk guardrails if you want one.'} You are done for the day when you hit your goal or your trade cap, whichever comes first.</p></div><span className="panel-icon">↗</span></div>{activeGoalMode === 'percent' && dayStartBalance <= 0 && <p className="notice warning"><strong>Compounding has no starting balance yet.</strong> Log your initial deposit in Deposits &amp; withdrawals below. Compounding starts from it automatically.</p>}<div className="account-summary-grid"><div className="account-stat"><span>Starting balance today</span><strong>{money(dayStartBalance)}</strong><small>Locked for the day. Tomorrow starts from your new balance.</small></div><div className="account-stat"><span>Balance now</span><strong>{money(overallEquity)}</strong><small>Updates after every trade you log</small></div><div className="account-stat"><span>{activeGoalMode === 'percent' ? `${activeGoalValue}% goal` : 'Daily goal'}</span><strong>{money(dailyTarget)}</strong><small>{activeGoalMode === 'percent' ? 'Based on today’s starting balance' : 'The fixed amount you entered'}</small></div><div className="account-stat"><span>Actual daily P&amp;L</span><strong className={todayPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(todayPnl)}</strong><small>{todayEntryCount} of {tradeCap} trades used</small></div></div>{dailyTarget > 0 && <><div className="progress-label"><span>Progress toward target ({money(todayPnl)} of {money(dailyTarget)})</span><strong>{Math.round(targetProgress)}%</strong></div><div className="bar-track compounding-progress"><div className="bar-fill gold-fill" style={{width:`${targetProgress}%`}} /></div></>}{targetReached && <div className="notice warning"><strong>Target reached.</strong> Your goal is complete for today. Do not increase size or keep trading just to make more.</div>}{guardrailHit && <div className="notice danger-text"><strong>STOP TRADING.</strong> {stopReasons.filter(r => r !== 'Daily target reached').join(' · ')}. Close the platform and leave the room. This is a journal warning, not a broker lockout.</div>}</section>}
      <section id="riskcheck" className="panel compounding-panel"><div className="panel-heading"><div><p className="eyebrow">BEFORE YOU ENTER</p><h2>Pre-trade risk check</h2></div><span className="panel-icon">⛨</span></div><div className="compounding-risk-row"><label>Planned loss if this trade fails (CAD)<input type="number" min="0" step="0.01" value={plannedRisk} onChange={e => setPlannedRisk(e.target.value)} /></label><label>Planned leverage (optional)<input type="number" min="1" step="1" value={plannedLeverage} onChange={e => setPlannedLeverage(e.target.value)} placeholder="e.g. 100" /></label></div><p className={`notice ${Number(plannedRisk) > startBalance * 0.01 ? 'warning' : ''}`}><strong>Risk check:</strong> {Number(plannedRisk) > startBalance * 0.01 ? `This planned loss is more than 1% of your current balance (${money(startBalance * 0.01)}). Consider reducing risk or skipping the trade.` : `Planned loss is within 1% of your current balance (${money(startBalance * 0.01)}).`}{plannedLeverage && Number(plannedLeverage) > 100 ? ' High leverage entered: recheck position size and stop distance before trading.' : ''}</p><p className="tiny muted">{startBalance > 0 ? `At a ${money(startBalance)} starting balance, your ${money(Math.abs(limit))} daily loss limit is about ${(Math.abs(limit) / startBalance * 100).toFixed(1)}% of the account. ` : ''}Leverage alone does not determine risk; position size and stop distance matter too.</p></section>
      <section className="account-summary panel"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT PERFORMANCE</p><h2>Capital & cash flow</h2></div></div><div className="account-summary-grid"><div className="account-stat"><span>Trading P&amp;L</span><strong className={totalPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(totalPnl)}</strong><small>Sum of logged trade results</small></div><div className="account-stat"><span>Total deposited</span><strong>{money(totalDeposited)}</strong><small>All recorded deposits</small></div><div className="account-stat"><span>Total withdrawn</span><strong>{money(totalWithdrawn)}</strong><small>All recorded withdrawals</small></div><div className="account-stat"><span>Deposited after red days</span><strong className={depositedAfterLoss > 0 ? 'negative-text' : ''}>{money(depositedAfterLoss)}</strong><small>{depositsAfterLossCount} {depositsAfterLossCount === 1 ? 'deposit' : 'deposits'} made on a losing day</small></div><div className="account-stat"><span>Net contributions</span><strong>{money(netContributions)}</strong><small>Deposits minus withdrawals</small></div><div className="account-stat"><span>Current account equity</span><strong>{money(equityValue)}</strong><small>Deposits − withdrawals + logged trades</small></div><div className="account-stat"><span>Net result vs. capital</span><strong className={netResultVsCapital >= 0 ? 'positive-text' : 'negative-text'}>{money(netResultVsCapital)}</strong><small>Equity minus net contributions (your trading P&amp;L)</small></div></div><p className="tiny muted">Equity is calculated for you: deposits, minus withdrawals, plus every logged trade. It matches your broker balance as long as every trade and cash movement is logged (importing your trade report fills the gaps).</p></section>
      <section id="calendar" className="panel calendar-panel"><div className="panel-heading calendar-heading"><div><p className="eyebrow">DAILY PERFORMANCE</p><h2>Trading calendar</h2><p className="muted tiny">Monthly P&amp;L: <strong className={monthPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(monthPnl)}</strong> · {monthTrades.length} trades</p></div><div className="calendar-controls"><button type="button" className="button secondary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>‹</button><strong>{calendarMonth.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</strong><button type="button" className="button secondary" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>›</button></div></div><div className="calendar-grid">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat','Week'].map(d => <div key={d} className="calendar-weekday">{d}</div>)}{calendarWeeks.map((week, w) => { const ws = weekSummary(week, bookedTrades); return <Fragment key={`week-${w}`}>{week.map((day, i) => day ? <button type="button" key={day} onClick={() => setSelectedDay(day)} className={`calendar-day ${selectedDay === day ? 'selected' : ''} ${bookedTrades.some(t => t.trade_date === day) ? (dayPnl(day) >= 0 ? 'profit-day' : 'loss-day') : ''}`}><span>{Number(day.slice(-2))}</span>{bookedTrades.some(t => t.trade_date === day) && <strong>{money(dayPnl(day))}</strong>}</button> : <div key={`blank-${w}-${i}`} className="calendar-empty" />)}<div className={`calendar-week ${ws.trades ? (ws.pnl >= 0 ? 'profit-day' : 'loss-day') : ''}`}><span>Week {w + 1}</span>{ws.trades > 0 ? <><strong>{money(ws.pnl)}</strong><small>{ws.trades} {ws.trades === 1 ? 'trade' : 'trades'} · {ws.tradedDays} {ws.tradedDays === 1 ? 'day' : 'days'}</small></> : <small>No trades</small>}</div></Fragment>; })}</div><div className="selected-day-detail"><h3>{new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>{selectedDayTrades.length ? <><p className={dayPnl(selectedDay) >= 0 ? 'positive-text' : 'negative-text'}>Daily P&amp;L: <strong>{money(dayPnl(selectedDay))}</strong></p><ul>{selectedDayTrades.map(t => <li key={t.id}>{t.trade_time ? `${t.trade_time.slice(0, 5)} · ` : ''}{t.symbol} · {t.direction} · <strong className={Number(t.pnl) >= 0 ? 'positive-text' : 'negative-text'}>{money(Number(t.pnl))}</strong> · {t.emotion}</li>)}</ul></> : <p className="muted tiny">No trades logged for this date.</p>}</div></section>
      <section className="panel cash-panel"><div className="panel-heading"><div><p className="eyebrow">ACCOUNT ACTIVITY</p><h2>Deposits &amp; withdrawals</h2></div></div><form className="cash-form" onSubmit={saveCashMovement}><label>Type<select value={cashForm.movement_type} onChange={e => setCashForm({ ...cashForm, movement_type: e.target.value as 'deposit' | 'withdrawal' })}><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label><label>Date<input type="date" value={cashForm.movement_date} onChange={e => setCashForm({ ...cashForm, movement_date: e.target.value })} required /></label><label>Amount (CAD)<input type="number" min="0.01" step="0.01" value={cashForm.amount} onChange={e => setCashForm({ ...cashForm, amount: e.target.value })} placeholder="0.00" required /></label><label>Notes (optional)<input value={cashForm.notes} onChange={e => setCashForm({ ...cashForm, notes: e.target.value })} placeholder="e.g. monthly funding" /></label>{redDayDeposit && <div className="notice danger-text wide"><strong>Pause. Today is {money(todayPnl)}.</strong> Money added to chase back a losing day is the pattern this app is here to break. Money in the account does not change the market, and the bills still need paying. Walk away for {COOLDOWN_MINUTES} minutes before depositing.<label className="check-label"><input type="checkbox" checked={depositAck} onChange={e => setDepositAck(e.target.checked)} /> I understand this will be logged as a deposit after a losing day</label></div>}<button className="button primary" disabled={saving}>{saving ? 'Saving…' : 'Add movement'}</button></form><div className="cash-table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead><tbody>{cashMovements.length ? cashMovements.map(m => <tr key={m.id}><td>{dateLabel(m.movement_date)}</td><td>{m.movement_type === 'deposit' ? 'Deposit' : 'Withdrawal'}</td><td className={m.movement_type === 'deposit' ? 'positive-text' : 'negative-text'}>{m.movement_type === 'deposit' ? '+' : '−'}{money(Number(m.amount))}</td><td>{m.notes || '—'}</td></tr>) : <tr><td colSpan={4} className="muted">No deposits or withdrawals recorded yet.</td></tr>}</tbody></table></div></section>
      <section id="overview" className="metric-grid"><Metric label="Net P&L · all logged trades" value={money(totalPnl)} tone={totalPnl >= 0 ? 'positive' : 'negative'} note={`${trades.length} trades recorded`}/><Metric label="Green / red days" value={`${winDays} / ${redDays}`} note="Days with a non-zero net result"/><Metric label="Average winning trade" value={money(avgWin)} tone="positive" note={`${wins.length} winning trades`}/><Metric label="Average losing trade" value={money(avgLoss)} tone="negative" note={`${losses.length} losing trades`}/></section>
      <section id="analysis" className="analysis-grid"><div className="panel"><div className="panel-heading"><div><p className="eyebrow">PROCESS OVER P&L</p><h2>Rule-following breakdown</h2></div><span className="panel-icon">⌁</span></div><div className="comparison"><div className="comparison-row"><div><span className="legend-dot gold"/> <span>Compliant trades</span></div><strong className={compliantPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(compliantPnl)}</strong></div><div className="bar-track"><div className="bar-fill gold-fill" style={{ width: `${trades.length ? compliantTrades.length / trades.length * 100 : 0}%` }}/></div><p className="muted tiny">{compliantTrades.length} trades where setup was valid and confirmation was respected</p><div className="comparison-row"><div><span className="legend-dot red"/> <span>Rule-breaking trades</span></div><strong className={ruleBreakPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(ruleBreakPnl)}</strong></div><div className="bar-track"><div className="bar-fill red-fill" style={{ width: `${trades.length ? ruleBreakTrades.length / trades.length * 100 : 0}%` }}/></div><p className="muted tiny">{ruleBreakTrades.length} trades with an invalid setup, missing confirmation, or oversized entry</p></div><div className="insight-box"><span className="insight-star">✦</span><p>{trades.length ? `You have logged ${trades.length} trades. Keep logging every trade so we can compare compliant execution with impulsive entries over time.` : 'Your first goal is to build a complete record. Log wins, losses, and rule-breaking trades—not just the memorable ones.'}</p></div></div>
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">BEHAVIORAL SIGNALS</p><h2>What may be costing you</h2></div><span className="panel-icon">◎</span></div><div className="signal-list"><Signal label="FOMO / early entry" value={trades.filter(t => t.emotion === 'FOMO' || !t.confirmation_waited).length} total={trades.length} color="red"/><Signal label="Invalid setup" value={trades.filter(t => !t.setup_valid).length} total={trades.length} color="gold"/><Signal label="Oversized trades" value={trades.filter(t => t.size_rule_broken).length} total={trades.length} color="red"/><Signal label="Recovery / revenge" value={trades.filter(t => t.emotion === 'Revenge / recovery').length} total={trades.length} color="red"/><Signal label="Trades beyond first two" value={trades.filter(t => { const sameDay = trades.filter(x => x.trade_date === t.trade_date).sort((a,b) => a.created_at.localeCompare(b.created_at)); return sameDay.findIndex(x => x.id === t.id) >= 2; }).length} total={trades.length} color="gold"/></div><p className="tiny muted signal-foot">These are descriptive counts, not diagnoses or proof of causation. More complete logging improves the analysis.</p></div></section>
      <section id="patterns" className="panel patterns-panel"><div className="panel-heading"><div><p className="eyebrow">WHEN AND WHY IT GOES WRONG</p><h2>Pattern reports</h2><p className="muted tiny">Built from your logged trades. Rows with fewer than {MIN_SAMPLE} trades are marked low sample: treat them as a hint, not a rule.</p></div><span className="panel-icon">◔</span></div>{trades.length === 0 ? <p className="muted">Log some trades and your patterns will show up here.</p> : <><div className="report-grid"><BucketTable title="By time of day" rows={hourReport.buckets} note={hourReport.untimed > 0 ? `${hourReport.untimed} ${hourReport.untimed === 1 ? 'trade has' : 'trades have'} no time and ${hourReport.untimed === 1 ? 'is' : 'are'} left out.` : undefined} /><BucketTable title="By trade number in the day" rows={tradeNumberReport} /></div><h3 className="report-subtitle">How long you hold trades</h3>{holdReport.buckets.length === 0 ? <p className="muted tiny">Log an exit date and time on your trades to see how holding time affects your results.</p> : <><div className="report-grid"><BucketTable title="By time held" rows={holdReport.buckets} note={holdReport.missing > 0 ? `${holdReport.missing} ${holdReport.missing === 1 ? 'trade has' : 'trades have'} no exit logged and ${holdReport.missing === 1 ? 'is' : 'are'} left out.` : undefined} /><HoldCompareCard winners={holdCompare.winners} losers={holdCompare.losers} /></div></>}<h3 className="report-subtitle">After a green day vs after a red day</h3><div className="report-grid"><DayAfterCard group={dayAfterReport.afterGreen} /><DayAfterCard group={dayAfterReport.afterRed} /></div><p className="tiny muted signal-foot">{dayAfterReport.afterGreen.days >= MIN_SAMPLE && dayAfterReport.afterRed.days >= MIN_SAMPLE ? (dayAfterReport.afterGreen.avgDayPnl < dayAfterReport.afterRed.avgDayPnl ? 'Your average day after a green day is lower than after a red day. That fits the pattern of giving wins back, but it is a description of your history, not proof of why.' : 'Your average day after a green day is not lower than after a red day so far.') : `Needs at least ${MIN_SAMPLE} days in each group before this comparison means much.`} A flat day counts as neither.</p></>}</section>
      <section id="journal" className="panel journal-panel"><div className="panel-heading journal-heading"><div><p className="eyebrow">YOUR RECORD</p><h2>Trade history</h2></div><div className="journal-actions"><label className="button secondary export-button import-button">Import trades<input type="file" accept=".csv,.txt,text/csv" onChange={chooseImportFile} hidden/></label><button className="button secondary export-button" onClick={exportCSV} disabled={trades.length === 0}>Export CSV</button><div className="filter-tabs"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'compliant' ? 'selected' : ''} onClick={() => setFilter('compliant')}>Compliant</button><button className={filter === 'rulebreak' ? 'selected' : ''} onClick={() => setFilter('rulebreak')}>Rule breaks</button></div></div></div>{loading ? <p className="muted">Loading trades…</p> : shownTrades.length === 0 ? <div className="empty-state"><div className="empty-icon">▤</div><h3>No trades here yet</h3><p>Once you log trades, this table will help you identify patterns.</p></div> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Exit</th><th>Held</th><th>Symbol</th><th>Direction</th><th>Lots</th><th>P&L</th><th>Emotion</th><th>Execution</th><th>Notes</th><th>Actions</th></tr></thead><tbody>{shownTrades.map(t => <tr key={t.id}><td>{dateLabel(t.trade_date)}</td><td>{t.trade_time ? t.trade_time.slice(0, 5) : '—'}</td><td>{t.exit_date ? `${dateLabel(t.exit_date)}${t.exit_time ? ' ' + t.exit_time.slice(0, 5) : ''}` : '—'}</td><td>{holdLabel(t)}</td><td className="symbol-cell">{t.symbol}</td><td>{t.direction}</td><td>{t.contracts != null ? lots(Number(t.contracts)) : '—'}</td><td className={Number(t.pnl) >= 0 ? 'positive-text' : 'negative-text'}>{money(Number(t.pnl))}</td><td><span className={`emotion-chip ${t.emotion === 'FOMO' || t.emotion === 'Revenge / recovery' ? 'emotion-risk' : ''}`}>{t.emotion}</span></td><td><span className={`execution-pill ${compliant(t) ? 'execution-good' : 'execution-bad'}`}>{compliant(t) ? 'Followed' : t.size_rule_broken && t.setup_valid && t.confirmation_waited ? 'Oversized' : 'Rule break'}</span></td><td className="notes-cell" title={t.notes}>{t.notes || '—'}</td><td><button type="button" className="button secondary" onClick={() => editTrade(t)}>Edit</button> <button type="button" className="button secondary" disabled={saving} onClick={() => deleteTrade(t)}>Delete</button></td></tr>)}</tbody></table></div>}</section>
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

function BucketTable({ title, rows, note }: { title: string; rows: Bucket[]; note?: string }) {
  const solid = rows.filter(r => r.trades >= MIN_SAMPLE);
  const best = solid.length > 1 ? solid.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
  const worst = solid.length > 1 ? solid.reduce((a, b) => (b.avg < a.avg ? b : a)) : null;
  return <div className="report-block"><h3 className="report-subtitle">{title}</h3>{rows.length === 0 ? <p className="muted tiny">Nothing to show yet.</p> : <div className="table-wrap"><table className="report-table"><thead><tr><th>Group</th><th>Trades</th><th>Win rate</th><th>Avg / trade</th><th>Total</th></tr></thead><tbody>{rows.map(r => <tr key={r.label}><td>{r.label}{r.trades < MIN_SAMPLE && <span className="low-sample">low sample</span>}</td><td>{r.trades}</td><td>{Math.round(r.winRate)}%</td><td className={r.avg >= 0 ? 'positive-text' : 'negative-text'}>{money(r.avg)}</td><td className={r.pnl >= 0 ? 'positive-text' : 'negative-text'}>{money(r.pnl)}</td></tr>)}</tbody></table></div>}<p className="tiny muted">{best && worst && best !== worst ? `Best so far: ${best.label} (${money(best.avg)} per trade). Weakest: ${worst.label} (${money(worst.avg)} per trade).` : rows.length ? `Needs at least ${MIN_SAMPLE} trades in two or more rows before it picks a best and a weakest.` : ''} {note}</p></div>;
}
function DayAfterCard({ group }: { group: DayGroup }) {
  return <div className="report-block"><h3 className="report-subtitle">{group.label}</h3>{group.days === 0 ? <p className="muted tiny">No days to compare yet.</p> : <div className="account-summary-grid report-stats"><div className="account-stat"><span>Days</span><strong>{group.days}</strong><small>{group.greenDays} finished green</small></div><div className="account-stat"><span>Avg day P&amp;L</span><strong className={group.avgDayPnl >= 0 ? 'positive-text' : 'negative-text'}>{money(group.avgDayPnl)}</strong><small>Total {money(group.totalPnl)}</small></div><div className="account-stat"><span>Avg trades / day</span><strong>{group.avgTrades.toFixed(1)}</strong><small>{group.days < MIN_SAMPLE ? 'low sample' : 'enough days to compare'}</small></div></div>}</div>;
}

function HoldCompareCard({ winners, losers }: { winners: HoldSummary; losers: HoldSummary }) {
  const enough = winners.n >= MIN_SAMPLE && losers.n >= MIN_SAMPLE;
  let verdict = `Needs at least ${MIN_SAMPLE} winning and ${MIN_SAMPLE} losing trades with an exit logged before this means much.`;
  if (enough) {
    if (losers.avgMinutes > winners.avgMinutes * 1.25) verdict = `You hold losing trades longer than winning ones (${formatMinutes(losers.avgMinutes)} vs ${formatMinutes(winners.avgMinutes)} on average). Holding losers while cutting winners short is a common pattern. This describes your history, not why it happens.`;
    else if (winners.avgMinutes > losers.avgMinutes * 1.25) verdict = `You hold winning trades longer than losing ones (${formatMinutes(winners.avgMinutes)} vs ${formatMinutes(losers.avgMinutes)} on average), so you are cutting losers faster than winners. That is generally considered a good habit.`;
    else verdict = `You hold winners and losers for about the same time (${formatMinutes(winners.avgMinutes)} vs ${formatMinutes(losers.avgMinutes)} on average).`;
  }
  return <div className="report-block"><h3 className="report-subtitle">Winners vs losers: time held</h3><div className="account-summary-grid report-stats"><div className="account-stat"><span>Winning trades</span><strong className="positive-text">{winners.n ? formatMinutes(winners.avgMinutes) : '—'}</strong><small>{winners.n} trades · median {winners.n ? formatMinutes(winners.medianMinutes) : '—'}</small></div><div className="account-stat"><span>Losing trades</span><strong className="negative-text">{losers.n ? formatMinutes(losers.avgMinutes) : '—'}</strong><small>{losers.n} trades · median {losers.n ? formatMinutes(losers.medianMinutes) : '—'}</small></div></div><p className="tiny muted">{verdict}</p></div>;
}
