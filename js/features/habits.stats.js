// LIFE/OS — habits: productivity series and the LIFE index (pure, DOM-free).
//
// Everything derives from normalized habits (habits.logic.js) and their
// HISTORICAL plan: a day counts for a habit only when that day's plan scheduled
// it. Adding, archiving or re-planning a habit therefore moves the graphs from
// that day on, never rewriting the past.
//
// Conventions
// - Keys are local 'YYYY-MM-DD' days; `today` is always passed in.
// - A PENDING today (scheduled habits not all done yet) is excluded from every
//   average, so an unfinished morning never drags a chart down.
// - Rates are fractions 0..1 (null = nothing to measure); deltas are percentage points.
// - Nothing is rounded here; formatting belongs to the UI.

import { WEEK_ORDER, isValidKey, toDayNum, fromDayNum, weekdayOf, weekStart, compileHabit, scheduledAt, activeAt, currentStreak, isArchived } from './habits.logic.js';

export const RANGES = Object.freeze([
  { id: '7d', label: '7D', days: 7 },
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: 'all', label: 'ALL', days: null },
]);
export const MIN_ALL_DAYS = 7;
export const LIFE_ALPHA = 0.2;
export const LIFE_BASE = 50;

const validRange = (from, to, today) => isValidKey(from) && isValidKey(to) && isValidKey(today) && from <= to;

/** Inputs from the UI are arrays; anything else reads as "no data" instead of throwing. */
const list = (v) => (Array.isArray(v) ? v : []);

/** Usable habits only (an object with a valid createdAt), so one bad row can't poison a whole chart. */
const usable = (items) => list(items).filter((hb) => hb && isValidKey(hb.createdAt));

/** Habits sorted by order, compiled once for day-number queries. */
function compileAll(items) {
  return usable(items)
    .sort((a, b) => a.order - b.order)
    .map((habit) => ({ habit, name: habit.name, c: compileHabit(habit) }));
}

/** Map key -> names for every key produced by keysOf(habit). */
function namesByKey(hs, keysOf) {
  const map = new Map();
  for (const { habit, name } of hs) {
    for (const key of keysOf(habit)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(name);
    }
  }
  return map;
}

/** Counts toward averages: not today-in-progress, not future, something planned. */
const measured = (d) => !d.pending && !d.future && d.planned > 0;

/* ==========================================================================
   Ranges & daily series
   ========================================================================== */

/**
 * { from, to, days } for '7d' | '30d' | '90d' | 'all' (unknown -> '30d'); to = today.
 * 'all' starts at the earliest createdAt and spans at least MIN_ALL_DAYS days.
 */
export function rangeBounds(range, items, today) {
  const t = toDayNum(today);
  const preset = RANGES.find((r) => r.id === range) ?? RANGES[1];
  let from = t - (preset.days ?? MIN_ALL_DAYS) + 1;
  if (!preset.days) {
    for (const hb of usable(items)) from = Math.min(from, toDayNum(hb.createdAt));
  }
  return { from: fromDayNum(from), to: today, days: t - from + 1 };
}

/**
 * One entry per day in [from, to]:
 * { key, weekday, planned, done, bonus, rate, pending, future, active,
 *   added, planChanged, archived, missed, doneNames, bonusNames }
 * - planned: habits scheduled that day (historical plan, active habits only).
 * - active: habits that existed that day (createdAt <= day < archivedAt), planned or not.
 *   0 = before the first habit / after every habit was archived: not a "rest day".
 * - done: scheduled AND logged. bonus: logged on an active but unscheduled day (not in rate).
 * - rate: done / planned; null when planned is 0 or the day is in the future.
 *   Today's rate is live; `pending` (today && done < planned) tells averages to skip it.
 * - added / planChanged / archived: names created / re-planned (not creation) / archived that day.
 * - missed: scheduled but not done; empty for a pending today and for future days.
 */
export function dailySeries(items, from, to, today) {
  if (!validRange(from, to, today)) return [];
  const t = toDayNum(today);
  const hs = compileAll(items);
  const notes = {
    added: namesByKey(hs, (hb) => [hb.createdAt]),
    planChanged: namesByKey(hs, (hb) => (hb.plan ?? []).map((p) => p.from).filter((k) => k !== hb.createdAt)),
    archived: namesByKey(hs, (hb) => (hb.archivedAt ? [hb.archivedAt] : [])),
  };
  const out = [];
  for (let n = toDayNum(from), end = toDayNum(to); n <= end; n++) out.push(dayEntry(hs, n, t, notes));
  return out;
}

function dayEntry(hs, n, t, notes) {
  const key = fromDayNum(n);
  const future = n > t;
  const missed = [];
  const doneNames = [];
  const bonusNames = [];
  let planned = 0;
  let active = 0;
  for (const { c, name } of hs) {
    if (!activeAt(c, n)) continue;
    active++;
    const logged = !future && !!c.log[key];
    if (scheduledAt(c, n)) {
      planned++;
      (logged ? doneNames : missed).push(name);
    } else if (logged) {
      bonusNames.push(name);
    }
  }
  const done = doneNames.length;
  const pending = n === t && done < planned;
  return {
    key,
    weekday: weekdayOf(n),
    planned,
    done,
    bonus: bonusNames.length,
    rate: planned && !future ? done / planned : null,
    pending,
    future,
    active,
    added: [...(notes.added.get(key) ?? [])],
    planChanged: [...(notes.planChanged.get(key) ?? [])],
    archived: [...(notes.archived.get(key) ?? [])],
    missed: pending || future ? [] : missed,
    doneNames,
    bonusNames,
  };
}

/**
 * Trailing `window`-day completion, aligned with `series`: sum(done) / sum(planned)
 * over the last `window` calendar entries, skipping rest days and excluding a
 * pending today (and future days) entirely. null when nothing was planned in the window.
 */
export function rollingRate(series, window = 7) {
  series = list(series);
  const w = Math.max(1, Math.floor(window) || 1);
  const out = [];
  let done = 0;
  let planned = 0;
  for (let i = 0; i < series.length; i++) {
    if (measured(series[i])) {
      done += series[i].done;
      planned += series[i].planned;
    }
    const drop = series[i - w];
    if (drop && measured(drop)) {
      done -= drop.done;
      planned -= drop.planned;
    }
    out.push(planned ? done / planned : null);
  }
  return out;
}

/**
 * Totals of a daily series (or any slice of it):
 * { avgRate, done, planned, checkIns, bonus, daysMeasured, perfectDays, restDays, bestDay }
 * - avgRate = done / planned over measured days (pending today and future excluded); null if none.
 * - checkIns = every scheduled completion incl. today's (pending or not).
 * - restDays = non-future days with nothing planned while at least one habit existed
 *   (days before the first habit, or after every habit was archived, are not rest).
 * - bestDay = { key, rate, done, planned } — highest rate, then most planned, then most recent.
 */
export function summarize(series) {
  series = list(series);
  let done = 0;
  let planned = 0;
  let checkIns = 0;
  let bonus = 0;
  let daysMeasured = 0;
  let perfectDays = 0;
  let restDays = 0;
  let bestDay = null;
  for (const d of series) {
    if (d.future) continue;
    checkIns += d.done;
    bonus += d.bonus ?? 0;
    if (!d.planned) {
      if (d.active !== 0) restDays++;
      continue;
    }
    if (d.pending) continue;
    daysMeasured++;
    done += d.done;
    planned += d.planned;
    if (d.done === d.planned) perfectDays++;
    const rate = d.done / d.planned;
    if (!bestDay || rate > bestDay.rate || (rate === bestDay.rate && d.planned >= bestDay.planned)) {
      bestDay = { key: d.key, rate, done: d.done, planned: d.planned };
    }
  }
  return { avgRate: planned ? done / planned : null, done, planned, checkIns, bonus, daysMeasured, perfectDays, restDays, bestDay };
}

/**
 * Summary of [from, to] vs the equally long window right before it.
 * -> { current, previous, deltaPts, previousRange: { from, to } }
 * deltaPts = (current.avgRate - previous.avgRate) * 100, null unless both are measurable.
 */
export function compareToPrevious(items, from, to, today) {
  if (!validRange(from, to, today)) {
    const empty = summarize([]);
    return { current: empty, previous: { ...empty }, deltaPts: null, previousRange: { from: null, to: null } };
  }
  const lo = toDayNum(from);
  const len = toDayNum(to) - lo + 1;
  const previousRange = { from: fromDayNum(lo - len), to: fromDayNum(lo - 1) };
  const current = summarize(dailySeries(items, from, to, today));
  const previous = summarize(dailySeries(items, previousRange.from, previousRange.to, today));
  const deltaPts = current.avgRate != null && previous.avgRate != null ? (current.avgRate - previous.avgRate) * 100 : null;
  return { current, previous, deltaPts, previousRange };
}

/**
 * Per weekday in WEEK_ORDER (Mon … Sun):
 * { weekday, avgRate, avgPlanned, days, activeDays, measured, done, planned }
 * - days: calendar days of that weekday in range up to today (today included).
 * - activeDays: those days on which at least one habit existed.
 * - avgPlanned = mean planned over activeDays (0 if none), so days before the first
 *   habit never dilute the load of a young account.
 * - avgRate = done / planned over measured days of that weekday (null if none).
 */
export function weekdayBreakdown(items, from, to, today) {
  const acc = new Map(WEEK_ORDER.map((weekday) => [weekday, { days: 0, activeDays: 0, plannedAll: 0, measured: 0, done: 0, planned: 0 }]));
  for (const d of dailySeries(items, from, to, today)) {
    if (d.future) continue;
    const a = acc.get(d.weekday);
    a.days++;
    if (d.active) {
      a.activeDays++;
      a.plannedAll += d.planned;
    }
    if (measured(d)) {
      a.measured++;
      a.done += d.done;
      a.planned += d.planned;
    }
  }
  return WEEK_ORDER.map((weekday) => {
    const a = acc.get(weekday);
    return {
      weekday,
      avgRate: a.planned ? a.done / a.planned : null,
      avgPlanned: a.activeDays ? a.plannedAll / a.activeDays : 0,
      days: a.days,
      activeDays: a.activeDays,
      measured: a.measured,
      done: a.done,
      planned: a.planned,
    };
  });
}

function byRate(a, b) {
  if (a.rate !== b.rate) {
    if (a.rate == null) return 1;
    if (b.rate == null) return -1;
    return b.rate - a.rate;
  }
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.order - b.order;
}

/**
 * Every habit (archived too) over [from, to]:
 * [{ id, name, archived, planned, done, rate, currentStreak, order }]
 * planned/done count scheduled days in range (today only once done); rate null if nothing planned.
 * Sorted by rate desc (nulls last), then name, then order.
 */
export function habitLeaderboard(items, from, to, today) {
  if (!validRange(from, to, today)) return [];
  const t = toDayNum(today);
  const lo = toDayNum(from);
  const hi = Math.min(toDayNum(to), t);
  return usable(items)
    .map((habit) => {
      const c = compileHabit(habit);
      let planned = 0;
      let done = 0;
      for (let n = Math.max(lo, c.start), last = Math.min(hi, c.end - 1); n <= last; n++) {
        if (!scheduledAt(c, n)) continue;
        const ok = !!c.log[fromDayNum(n)];
        if (n === t && !ok) continue;
        planned++;
        if (ok) done++;
      }
      return {
        id: habit.id,
        name: habit.name,
        archived: isArchived(habit, today),
        planned,
        done,
        rate: planned ? done / planned : null,
        currentStreak: currentStreak(habit, today),
        order: habit.order,
      };
    })
    .sort(byRate);
}

/**
 * Monday-start weekly buckets of a daily series:
 * [{ key (Monday), from, to, days, rate, pending, future, ...summarize(days in bucket),
 *    added, planChanged, archived, missed, doneNames, bonusNames }]
 * rate = the bucket's avgRate (pending today excluded); name lists are concatenated
 * in day order; partial weeks at the range edges have days < 7.
 */
export function bucketWeekly(series) {
  const groups = [];
  for (const d of list(series)) {
    const key = weekStart(d.key);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, days: [] });
    groups[groups.length - 1].days.push(d);
  }
  const concat = (days, field) => days.flatMap((d) => d[field] ?? []);
  return groups.map(({ key, days }) => {
    const sum = summarize(days);
    return {
      key,
      from: days[0].key,
      to: days[days.length - 1].key,
      days: days.length,
      ...sum,
      rate: sum.avgRate,
      pending: days.some((d) => d.pending),
      future: days.every((d) => d.future),
      added: concat(days, 'added'),
      planChanged: concat(days, 'planChanged'),
      archived: concat(days, 'archived'),
      missed: concat(days, 'missed'),
      doneNames: concat(days, 'doneNames'),
      bonusNames: concat(days, 'bonusNames'),
    };
  });
}

/* ==========================================================================
   LIFE index — a 0..100 momentum "price" that compounds habit completion
   ========================================================================== */

/**
 * Daily candles from the first day that had >= 1 planned habit through today
 * ([] if nothing was ever planned up to today). Price starts at `base` the day before.
 * Closed day (t < today), planned > 0, r = done / planned:
 *   open = prevClose, close = open + alpha * (100 r - open),
 *   high = open + alpha * (100 - open), low = open * (1 - alpha).
 * Today (live): close = open + alpha * r * (100 - open) — check-offs only push it up;
 *   misses settle when the day closes. Rest days (planned 0): price flat, rest: true.
 * -> [{ key, open, high, low, close, volume (= done), planned, plannedVolume (= planned),
 *       rate, rest, live }]
 * Options outside their meaningful range fall back so the price always stays in 0..100:
 * alpha must be in (0, 1] (else LIFE_ALPHA); base is clamped to 0..100 (non-numbers -> LIFE_BASE).
 */
export function lifeIndexSeries(items, today, options = {}) {
  const { alpha, base } = lifeOptions(options);
  const cs = usable(items).map(compileHabit);
  if (!isValidKey(today) || !cs.length) return [];
  const t = toDayNum(today);
  let first = Infinity;
  for (const c of cs) if (c.start < first) first = c.start;
  const out = [];
  let prev = base;
  for (let n = first; n <= t; n++) {
    const key = fromDayNum(n);
    let planned = 0;
    let done = 0;
    for (const c of cs) {
      if (!scheduledAt(c, n)) continue;
      planned++;
      if (c.log[key]) done++;
    }
    if (!out.length && !planned) continue;
    const candle = candleFor(key, prev, planned, done, n === t, alpha);
    out.push(candle);
    prev = candle.close;
  }
  return out;
}

function lifeOptions(options) {
  const { alpha, base } = options ?? {};
  return {
    alpha: Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : LIFE_ALPHA,
    base: Number.isFinite(base) ? Math.min(100, Math.max(0, base)) : LIFE_BASE,
  };
}

function candleFor(key, open, planned, done, live, alpha) {
  if (!planned) {
    return { key, open, high: open, low: open, close: open, volume: 0, planned: 0, plannedVolume: 0, rate: null, rest: true, live };
  }
  const rate = done / planned;
  const close = live ? open + alpha * rate * (100 - open) : open + alpha * (100 * rate - open);
  return {
    key,
    open,
    high: open + alpha * (100 - open),
    low: open * (1 - alpha),
    close,
    volume: done,
    planned,
    plannedVolume: planned,
    rate,
    rest: false,
    live,
  };
}

/**
 * Quote for the latest candle, or null for an empty series:
 * { key, price, prevClose, change, changePct, open, high, low, live, rest, volume, planned,
 *   allTimeHigh, allTimeLow }   (changePct in percent, e.g. 2.5 = +2.5%; null if prevClose is 0;
 *   all-time extremes are over closes)
 */
export function lifeQuote(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const last = series[series.length - 1];
  const prevClose = last.open;
  const change = last.close - prevClose;
  let allTimeHigh = -Infinity;
  let allTimeLow = Infinity;
  for (const c of series) {
    if (c.close > allTimeHigh) allTimeHigh = c.close;
    if (c.close < allTimeLow) allTimeLow = c.close;
  }
  return {
    key: last.key,
    price: last.close,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : null,
    open: last.open,
    high: last.high,
    low: last.low,
    live: last.live,
    rest: last.rest,
    volume: last.volume,
    planned: last.planned,
    allTimeHigh,
    allTimeLow,
  };
}

/**
 * Aggregate candles by 'week' (Monday key, default), 'month' ('YYYY-MM-01') or 'day':
 * { key, from, to, days, open (first), close (last), high (max), low (min),
 *   volume (sum), planned (sum), plannedVolume, rate, rest (all rest), live (any live) }
 */
export function bucketCandles(series, period = 'week') {
  const keyOf = period === 'month' ? (k) => `${k.slice(0, 7)}-01` : period === 'day' ? (k) => k : weekStart;
  const out = [];
  let cur = null;
  for (const c of list(series)) {
    const key = keyOf(c.key);
    if (!cur || cur.key !== key) {
      cur = { key, from: c.key, to: c.key, days: 0, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0, planned: 0, plannedVolume: 0, rate: null, rest: true, live: false };
      out.push(cur);
    }
    cur.to = c.key;
    cur.days++;
    cur.close = c.close;
    cur.high = Math.max(cur.high, c.high);
    cur.low = Math.min(cur.low, c.low);
    cur.volume += c.volume;
    cur.planned += c.planned;
    cur.plannedVolume = cur.planned;
    cur.rate = cur.planned ? cur.volume / cur.planned : null;
    cur.rest = cur.rest && c.rest;
    cur.live = cur.live || c.live;
  }
  return out;
}

/**
 * Simple moving average of the last `n` non-rest closes, aligned with `series`.
 * null until `n` non-rest candles exist; a rest day repeats the previous value
 * (its price is unchanged too). A live today counts with its live close.
 */
export function sma(series, n) {
  const w = Math.max(1, Math.floor(n) || 1);
  const win = [];
  const out = [];
  let last = null;
  for (const c of list(series)) {
    if (!c.rest) {
      win.push(c.close);
      if (win.length > w) win.shift();
      last = win.length === w ? win.reduce((a, b) => a + b, 0) / w : null;
    }
    out.push(last);
  }
  return out;
}
