// LIFE/OS — Health: pure helpers (no DOM, no store), tested in tools/tests/health.test.js.
//
// Store shape ('health'):
//   { weights: [{
//       id,
//       date,                          // 'YYYY-MM-DD': the day it was weighed (one weight a day)
//       kg,                            // always kilograms, one decimal (82.4); pounds are worked out
//       note,                          // '' or a few words ('after the holidays')
//       createdAt, updatedAt }],       // ms
//     goal: { kg, updatedAt } | null,  // a weight to aim for, kg with two decimals (so a goal
//                                      // typed in pounds reads back as typed); synced
//     unit: 'kg' | 'lb',               // how weights are shown and typed (synced)
//     view: { range } }                // per device (not synced): the graph's time range
//
// One weight a day: logging a day that has one replaces it (same id, so Sync merges it as an
// edit). Two devices that each logged the same day before syncing end up with two records for
// it; normalizeState keeps the one edited last (the same one on both devices).
//
// The trend: an exponentially smoothed average that moves 10% of the way to each new weight per
// day (TREND_ALPHA; a gap of n days moves it 1 − 0.9ⁿ of the way, so a long gap catches up). Its
// half-life is about a week, so one heavy or light morning barely moves it. Changes over 7, 30
// and 90 days are read from the trend, up to the latest weight, never from two single mornings.
//
// Words stay neutral: a change is a signed number ('−1.2 kg', '+0.4 kg'), never good or bad.

import { dateKey, shiftKey, diffDays, formatDay, plural } from '../ui.js';

export const UNITS = Object.freeze(['kg', 'lb']);
/** Pounds per kilogram, as the page shows them (lb = kg × 2.20462). */
export const LB_PER_KG = 2.20462;
/** What a weight can be, in kg (a typo like 8240 is refused, a baby's weight is not). */
export const KG_MIN = 1;
export const KG_MAX = 500;
export const NOTE_MAX = 200;
/** The trend's daily smoothing (see the top of this file). */
export const TREND_ALPHA = 0.1;
/** The changes the page lists, in days. */
export const CHANGE_SPANS = Object.freeze([7, 30, 90]);
/** The graph's time ranges: the last `days` days up to today (null: since the first weight). */
export const RANGES = Object.freeze(
  [
    { id: '30D', days: 30, name: '30 days' },
    { id: '90D', days: 90, name: '90 days' },
    { id: '1Y', days: 365, name: 'year' },
    { id: 'ALL', days: null, name: 'all time' },
  ].map((r) => Object.freeze(r)),
);
const RANGE_IDS = RANGES.map((r) => r.id);
export const DEFAULT_VIEW = Object.freeze({ range: '90D' });
export const DEFAULT_STATE = Object.freeze({ weights: Object.freeze([]), goal: null, unit: 'kg', view: DEFAULT_VIEW });
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MINUS = '−';
const NBSP = ' ';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A real local day 'YYYY-MM-DD' (no 31 Feb). */
export const isKey = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
};

/* ==========================================================================
   Numbers and units
   ========================================================================== */

/** One decimal, the same way on both sides of 0 (−0 is 0). */
export function round1(n) {
  const r = (Math.sign(n) * Math.round(Math.abs(n) * 10)) / 10;
  return r === 0 ? 0 : r;
}

/** Two decimals (a goal's kg). */
const round2 = (n) => Math.round(n * 100) / 100;

export const unitOf = (unit) => (unit === 'lb' ? 'lb' : 'kg');
/** kg -> the unit shown (not rounded). */
export const toUnit = (kg, unit) => (unitOf(unit) === 'lb' ? kg * LB_PER_KG : kg);
/** A number in `unit` -> kg (not rounded). */
export const toKg = (value, unit) => (unitOf(unit) === 'lb' ? value / LB_PER_KG : value);

/**
 * A typed number -> a number, or NaN. A comma or a dot for the decimals, the unit may follow:
 * '82.4' · '82,4' · ' 82 ' · '181.6 lb' · '82kg'. No minus, no thousands separators.
 */
export function parseNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : NaN;
  const s = String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/(kgs?|kilos?|lbs?|pounds?)$/i, '');
  if (!/^\d+(?:[.,]\d*)?$/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
}

/** A weight typed in `unit` -> kg with one decimal, or NaN. */
export function parseWeight(text, unit = 'kg') {
  const n = parseNumber(text);
  return Number.isFinite(n) ? round1(toKg(n, unit)) : NaN;
}

/** '82.4' (kg) or '181.7' (lb): the number alone, one decimal (for a field's value). */
export function numberText(kg, unit = 'kg') {
  return round1(toUnit(kg, unit)).toFixed(1);
}

/** '82.4 kg' · '181.7 lb' (a no-break space, so it never wraps between the two). */
export function weightText(kg, unit = 'kg') {
  return `${numberText(kg, unit)}${NBSP}${unitOf(unit)}`;
}

/** A change, signed: '−1.2 kg' · '+0.4 kg' · '0.0 kg' (rounded in the unit shown first). */
export function changeText(deltaKg, unit = 'kg') {
  const v = round1(toUnit(deltaKg, unit));
  const sign = v > 0 ? '+' : v < 0 ? MINUS : '';
  return `${sign}${Math.abs(v).toFixed(1)}${NBSP}${unitOf(unit)}`;
}

/** What a weight can be, in words for `unit`: '1 and 500 kg' · '2.2 and 1102.3 lb'. */
function limitsText(unit) {
  const u = unitOf(unit);
  const lo = u === 'kg' ? String(KG_MIN) : numberText(KG_MIN, u);
  const hi = u === 'kg' ? String(KG_MAX) : numberText(KG_MAX, u);
  return `${lo} and ${hi} ${u}`;
}

/* ==========================================================================
   Normalization: tolerate missing or malformed fields; keep what a newer version adds
   ========================================================================== */

const fallbackId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** One weight, or null (no real day, or no weight a person can have). Unknown fields are kept. */
export function normalizeWeight(raw, { now = Date.now(), makeId = fallbackId } = {}) {
  if (!isObject(raw) || !isKey(raw.date)) return null;
  const kg = parseNumber(raw.kg);
  if (!Number.isFinite(kg) || kg < KG_MIN || kg > KG_MAX) return null;
  const createdAt = finite(raw.createdAt) ?? now;
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id ? raw.id : typeof raw.id === 'number' ? String(raw.id) : String(makeId()),
    date: raw.date,
    kg: round1(kg),
    note: typeof raw.note === 'string' ? raw.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : '',
    createdAt,
    updatedAt: finite(raw.updatedAt) ?? createdAt,
  };
}

/** The goal, or null (none, or not a weight). */
export function normalizeGoal(raw) {
  if (!isObject(raw)) return null;
  const kg = parseNumber(raw.kg);
  if (!Number.isFinite(kg) || kg < KG_MIN || kg > KG_MAX) return null;
  return { ...raw, kg: round2(kg), updatedAt: finite(raw.updatedAt) ?? 0 };
}

export function normalizeView(raw) {
  const v = isObject(raw) ? raw : {};
  return { ...v, range: RANGE_IDS.includes(v.range) ? v.range : DEFAULT_VIEW.range };
}

/** Which of two records for one day stays: the one edited last (then made last, then the larger id). */
function newer(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/**
 * The whole store value, repaired: junk dropped, ids unique, one weight a day (oldest first).
 * A unit missing or unknown is `defaultUnit` (kg unless the page passes this device's units: lb
 * for US units).
 */
export function normalizeState(raw, { defaultUnit = 'kg', ...opts } = {}) {
  const src = Array.isArray(raw) ? { weights: raw } : isObject(raw) ? raw : {};
  const seen = new Set();
  const days = new Map();
  for (const entry of Array.isArray(src.weights) ? src.weights : []) {
    const w = normalizeWeight(entry, opts);
    if (!w) continue;
    const base = w.id;
    for (let n = 2; seen.has(w.id); n++) w.id = `${base}-${n}`;
    seen.add(w.id);
    const had = days.get(w.date);
    if (!had || newer(w, had)) days.set(w.date, w);
  }
  return {
    ...src,
    weights: [...days.values()].sort(byDate),
    goal: normalizeGoal(src.goal),
    unit: UNITS.includes(src.unit) ? src.unit : unitOf(defaultUnit),
    view: normalizeView(src.view),
  };
}

/* ==========================================================================
   Edits (each returns a new list; the page writes it, with Undo)
   ========================================================================== */

const example = (unit) => (unitOf(unit) === 'lb' ? '160.5' : '72.5');

/** A typed weight -> { kg } | { error } (in the unit it was typed in). */
function checkWeight(value, unit) {
  const kg = parseWeight(value, unit);
  if (!Number.isFinite(kg)) return { error: `Type a number, like ${example(unit)}.` };
  if (kg < KG_MIN || kg > KG_MAX) return { error: `Type a weight between ${limitsText(unit)}.` };
  return { kg };
}

/**
 * Check { date, value (typed in `unit`), note } -> { fields: { date, kg, note } } | { error, field }.
 * today: no weights for days still to come (left out when an edit keeps a day that is ahead).
 */
export function validateEntry(f, { unit = 'kg', today = null } = {}) {
  if (!isKey(f?.date)) return { error: 'Pick a day.', field: 'date' };
  if (today && f.date > today) return { error: 'Pick today or a day before it.', field: 'date' };
  const w = checkWeight(f.value, unit);
  if (w.error) return { error: w.error, field: 'value' };
  return { fields: { date: f.date, kg: w.kg, note: String(f.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) } };
}

/**
 * Log a weight: a new day is added, a day that has one is replaced (its id and, without a new
 * note, its note stay). -> { weights, entry, previous } | { error, field }
 * previous: the weight it replaced (null when the day was new), for Undo.
 */
export function logWeight(weights, fields, { unit = 'kg', today = null, now = Date.now(), makeId = fallbackId } = {}) {
  const v = validateEntry(fields, { unit, today });
  if (v.error) return v;
  const list = Array.isArray(weights) ? weights : [];
  const had = list.find((w) => w.date === v.fields.date) ?? null;
  if (had) {
    const entry = { ...had, kg: v.fields.kg, note: v.fields.note || had.note, updatedAt: now };
    return { weights: list.map((w) => (w.id === had.id ? entry : w)), entry, previous: had };
  }
  const entry = normalizeWeight({ id: String(makeId()), ...v.fields, createdAt: now, updatedAt: now }, { now, makeId });
  return { weights: [...list, entry].sort(byDate), entry, previous: null };
}

/**
 * Change weight `id` (day, weight, note). Another day that already has a weight is refused: edit
 * that one. A day ahead of `today` may stay when it was already the weight's own day.
 * -> { weights, entry, previous } | { error, field }
 */
export function editWeight(weights, id, fields, { unit = 'kg', today = null, now = Date.now() } = {}) {
  const list = Array.isArray(weights) ? weights : [];
  const cur = list.find((w) => w.id === id);
  if (!cur) return { error: 'That weight is no longer there.', field: null };
  const v = validateEntry(fields, { unit, today: fields?.date === cur.date ? null : today });
  if (v.error) return v;
  const clash = list.find((w) => w.id !== id && w.date === v.fields.date);
  if (clash) return { error: `${formatDay(v.fields.date)} already has a weight (${weightText(clash.kg, unit)}). Edit that one, or pick another day.`, field: 'date' };
  const entry = { ...cur, ...v.fields, updatedAt: now };
  return { weights: list.map((w) => (w.id === id ? entry : w)).sort(byDate), entry, previous: cur };
}

/** Take weight `id` out -> { weights, removed, index } (removed null when it wasn't there). */
export function removeWeight(weights, id) {
  const list = Array.isArray(weights) ? weights : [];
  const index = list.findIndex((w) => w.id === id);
  if (index < 0) return { weights: list, removed: null, index: -1 };
  return { weights: list.filter((w) => w.id !== id), removed: list[index], index };
}

/** Put a weight back (Undo): in its day's place, replacing whatever that day has now. */
export function restoreWeight(weights, entry) {
  const list = (Array.isArray(weights) ? weights : []).filter((w) => w.id !== entry.id && w.date !== entry.date);
  return [...list, entry].sort(byDate);
}

/** A goal typed in `unit` -> { goal } | { error } (kg with two decimals: 176 lb reads back as 176.0). */
export function makeGoal(value, { unit = 'kg', now = Date.now() } = {}) {
  const w = checkWeight(value, unit);
  if (w.error) return { error: w.error };
  return { goal: { kg: round2(toKg(parseNumber(value), unit)), updatedAt: now } };
}

/* ==========================================================================
   The trend and the numbers
   ========================================================================== */

/** The weights oldest first, each with its trend: [{ id, date, kg, note, trend }]. */
export function trendSeries(weights, alpha = TREND_ALPHA) {
  const list = (Array.isArray(weights) ? weights : []).slice().sort(byDate);
  const out = [];
  let trend = null;
  let prev = null;
  for (const w of list) {
    if (trend == null) trend = w.kg;
    else {
      const gap = Math.max(1, diffDays(prev, w.date));
      trend += (1 - (1 - alpha) ** gap) * (w.kg - trend);
    }
    prev = w.date;
    out.push({ id: w.id, date: w.date, kg: w.kg, note: w.note ?? '', trend });
  }
  return out;
}

/** The trend on `day`: as it stood after the last weight on or before it (null before the first). */
export function trendOn(series, day) {
  let found = null;
  for (const p of series) {
    if (p.date > day) break;
    found = p;
  }
  return found ? found.trend : null;
}

/**
 * How the trend moved over the `days` days up to the latest weight:
 * { delta, from, to, full } | null (fewer than two weights). `full`: the weights reach back that
 * far; otherwise `from` is the first weight (the change so far).
 */
export function trendChange(series, days) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = series[series.length - 1];
  const start = shiftKey(last.date, -days);
  let from = null;
  for (const p of series) {
    if (p.date > start) break;
    from = p;
  }
  const full = !!from;
  if (!from) from = series[0];
  return { delta: last.trend - from.trend, from: from.date, to: last.date, full };
}

/** The first day a range shows: 30D is today and the 29 days before; ALL starts at the first weight. */
export function rangeStart(rangeId, today, weights = []) {
  const r = RANGES.find((x) => x.id === rangeId) ?? RANGES.find((x) => x.id === DEFAULT_VIEW.range);
  if (r.days) return shiftKey(today, -(r.days - 1));
  const first = (Array.isArray(weights) ? weights : []).reduce((m, w) => (!m || w.date < m ? w.date : m), null);
  return first && first < today ? first : today;
}

/**
 * The numbers over a range: { count, low, high, perWeek } — low and high are weights ({ kg, date },
 * the latest on a tie); perWeek is the trend's average change a week, once the range's weights
 * span a week or more (else null).
 */
export function rangeStats(series, from, to) {
  const inRange = series.filter((p) => p.date >= from && p.date <= to);
  if (!inRange.length) return { count: 0, low: null, high: null, perWeek: null };
  let low = inRange[0];
  let high = inRange[0];
  for (const p of inRange) {
    if (p.kg <= low.kg) low = p;
    if (p.kg >= high.kg) high = p;
  }
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  const span = diffDays(first.date, last.date);
  return {
    count: inRange.length,
    low: { kg: low.kg, date: low.date },
    high: { kg: high.kg, date: high.date },
    perWeek: span >= 7 ? ((last.trend - first.trend) / span) * 7 : null,
  };
}

/**
 * Where the latest weight stands against the goal: { toGo (kg, 0 once reached), reached, direction }
 * | null (no goal, or no weight yet). direction: 'down' or 'up' from the weight when the goal was
 * set (the last one on or before that day, else the first), 'none' when it was the same; it
 * decides when the goal counts as reached (at it, or past it that way).
 */
export function goalProgress(weights, goal) {
  const list = (Array.isArray(weights) ? weights : []).slice().sort(byDate);
  if (!goal || !Number.isFinite(goal.kg) || !list.length) return null;
  const latest = list[list.length - 1].kg;
  const setOn = goal.updatedAt ? dateKey(new Date(goal.updatedAt)) : null;
  const before = setOn ? list.filter((w) => w.date <= setOn) : [];
  const baseline = (before.length ? before[before.length - 1] : list[0]).kg;
  const direction = goal.kg < baseline ? 'down' : goal.kg > baseline ? 'up' : 'none';
  const diff = round1(latest - goal.kg);
  const reached = diff === 0 || (direction === 'down' && diff < 0) || (direction === 'up' && diff > 0);
  return { toGo: reached ? 0 : Math.abs(diff), reached, direction };
}

/** The goal in words: 'Goal reached' · '3.2 kg to go'. */
export function goalText(progress, unit = 'kg') {
  if (!progress) return '';
  return progress.reached ? 'Goal reached' : `${weightText(progress.toGo, unit)} to go`;
}

/** The change in words for the page top and Home: '−1.2 kg in 30 days' · '+0.4 kg since Mon 12 Oct'. */
export function changeWords(change, days, unit = 'kg') {
  if (!change) return '';
  return `${changeText(change.delta, unit)} ${change.full ? `in ${plural(days, 'day')}` : `since ${formatDay(change.from)}`}`;
}

/** The page-top status: '82.4 kg · −1.2 kg in 30 days', '82.4 kg', or 'Log your first weight'. */
export function statusText(state) {
  const weights = state?.weights ?? [];
  if (!weights.length) return 'Log your first weight';
  const unit = unitOf(state.unit);
  const series = trendSeries(weights);
  const latest = series[series.length - 1];
  const change = changeWords(trendChange(series, 30), 30, unit);
  return change ? `${weightText(latest.kg, unit)} · ${change}` : weightText(latest.kg, unit);
}

/* ==========================================================================
   The graph
   ========================================================================== */

/**
 * The graph's points from `from` to `to` in the unit shown: [{ i, date, value, trend, note, id }],
 * i: the day's place from `from` (0 …). Trend values are the whole history's (a range starts
 * mid-way with the trend as it stood, not afresh).
 */
export function chartPoints(series, from, to, unit = 'kg') {
  return series
    .filter((p) => p.date >= from && p.date <= to)
    .map((p) => ({ i: diffDays(from, p.date), date: p.date, value: toUnit(p.kg, unit), trend: toUnit(p.trend, unit), note: p.note, id: p.id }));
}

/**
 * A y axis around lo … hi with room above and below, never forced down to 0:
 * { min, max, step, ticks }. pad: the least room on each side (in the unit shown).
 */
export function weightScale(lo, hi, { pad = 0.5, count = 4 } = {}) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi < lo) [lo, hi] = [hi, lo];
  const room = Math.max(pad, (hi - lo) * 0.1);
  const a = lo - room;
  const b = hi + room;
  const raw = (b - a) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * mag;
  const min = Math.floor(a / step + 1e-9) * step;
  const max = Math.ceil(b / step - 1e-9) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** An axis label: '82' on whole steps, '82.5' on smaller ones. */
export function tickText(v, step) {
  return step < 1 ? v.toFixed(1) : String(Math.round(v));
}

/**
 * Whether the goal line fits the graph: it is drawn when it lies within the weights' own span
 * again above or below them (at least `near` either way), so a far goal never flattens the line.
 * -> { lo, hi, goal: 'shown' | 'above' | 'below' | null }
 */
export function chartRange(values, goalValue, { near = 2 } = {}) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (!Number.isFinite(goalValue)) return { lo, hi, goal: null };
  const reach = Math.max(near, hi - lo);
  if (goalValue < lo - reach) return { lo, hi, goal: 'below' };
  if (goalValue > hi + reach) return { lo, hi, goal: 'above' };
  lo = Math.min(lo, goalValue);
  hi = Math.max(hi, goalValue);
  return { lo, hi, goal: 'shown' };
}

/* ==========================================================================
   The history list
   ========================================================================== */

/** 'October 2026' for '2026-10' */
export function monthName(month) {
  const [y, m] = String(month).split('-').map(Number);
  return MONTH_NAMES[m - 1] ? `${MONTH_NAMES[m - 1]} ${y}` : String(month);
}

/**
 * The weights newest first, by month: [{ month: 'YYYY-MM', items: [{ entry, change }] }].
 * change: kg against the weight before it (null for the first one ever).
 */
export function historyMonths(weights) {
  const list = (Array.isArray(weights) ? weights : []).slice().sort(byDate);
  const rows = list.map((entry, i) => ({ entry, change: i ? round1(entry.kg - list[i - 1].kg) : null })).reverse();
  const months = [];
  for (const row of rows) {
    const month = row.entry.date.slice(0, 7);
    let g = months[months.length - 1];
    if (!g || g.month !== month) months.push((g = { month, items: [] }));
    g.items.push(row);
  }
  return months;
}
