// LIFE/OS — Recovery: pure helpers (no DOM, no store), tested in tools/tests/recovery.test.js.
//
// Store shape ('recovery'):
//   { items: [{
//       id, name,                     // 'Smoking'
//       icon,                         // an icon picked for it (js/icons.logic.js) or null: the
//                                     // name suggests one ('Alcohol' -> a glass), else the leaf
//       start,                        // 'YYYY-MM-DD': the first day you stayed away
//       relapses: ['YYYY-MM-DD', …],  // the days you relapsed: sorted, each once, none before start
//       archived,                     // true: kept with its history, out of the way
//       createdAt }],                 // ms
//     view: { selectedId, month } }   // per device (not synced): the tracker shown, 'YYYY-MM'
//
// How the days are counted (local calendar days, keys 'YYYY-MM-DD'):
// - Every day from `start` through today is either a clean day or a relapse day.
// - A clean run is clean days in a row. The first one starts on `start`, each later one on the day
//   after a relapse; the newest one goes on through today (it is "ongoing").
// - Days clean (the page's big number) = the days of the ongoing run, today included: the day you
//   start is day 1. A relapse today isn't a clean day, so it shows 0, and tomorrow is day 1 again.
// - Days before the start never count, and neither do days after today. A relapse saved for a later
//   day (a device whose clock or time zone is ahead) is kept and counts once that day comes; only
//   marking one by hand is refused.
// - A relapse before the start means nothing, so it is dropped (moving the start later drops the
//   relapses before it; the page offers Undo).

import { dateKey, shiftKey, diffDays, weekday, formatDay, plural } from '../ui.js';
import { cleanIcon, suggestIcon } from '../icons.logic.js';

export const NAME_MAX = 60;
export const DEFAULT_VIEW = Object.freeze({ selectedId: null, month: null });
export const DEFAULT_STATE = Object.freeze({ items: Object.freeze([]), view: DEFAULT_VIEW });
/** The page's own icon: a tracker whose name suggests none shows it. */
export const TRACKER_ICON = 'leaf';
/** Milestones in days; after a year, every year. */
export const MILESTONES = Object.freeze([1, 3, 7, 14, 30, 60, 90, 180, 365]);
/** The chart shows this many runs at most (the newest). */
export const CHART_MAX = 24;
export const MONTHS_LONG = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
// Monday first, like the Calendar (ISO weeks)
export const WEEK_HEADS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

/** Quick starts on the empty page: a name each (the name suggests its icon). */
export const STARTERS = Object.freeze(['Smoking', 'Vaping', 'Alcohol', 'Social media', 'Sugar']);

/* ==========================================================================
   Reading input
   ========================================================================== */

/** A real local day 'YYYY-MM-DD' (no 31 Feb). */
export const isKey = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
};

/** 'YYYY-MM' with a real month. */
export const isMonth = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

export const monthOf = (key) => key.slice(0, 7);

export function cleanName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/** A stored icon name: kept even when this version doesn't know it (a newer one may), else null. */
const iconName = (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : null);

/** The icon to draw: the one picked (if this version has it), else the one the name suggests. */
export function trackerIcon(t) {
  return cleanIcon(t?.icon) ?? suggestIcon(t?.name, TRACKER_ICON);
}

/** Days as a list: sorted, each once, real days only, none before `start`. */
export function cleanDays(list, start = null) {
  const keys = (Array.isArray(list) ? list : []).filter((d) => isKey(d) && (!start || d >= start));
  return [...new Set(keys)].sort();
}

/* ==========================================================================
   Normalization: tolerate missing or malformed fields; keep what a newer version adds
   ========================================================================== */

const fallbackId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A valid tracker, or null (no name). Fields this version doesn't know are kept. */
export function normalizeTracker(raw, { now = Date.now(), makeId = fallbackId } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : typeof raw.id === 'number' ? String(raw.id) : String(makeId());
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  // No start saved: the day it was made
  const start = isKey(raw.start) ? raw.start : dateKey(new Date(createdAt));
  return {
    ...raw,
    id,
    name,
    icon: iconName(raw.icon),
    start,
    relapses: cleanDays(raw.relapses, start),
    archived: raw.archived === true,
    createdAt,
  };
}

export function normalizeView(raw) {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    selectedId: typeof v.selectedId === 'string' && v.selectedId ? v.selectedId : null,
    month: isMonth(v.month) ? v.month : null,
  };
}

/** The whole store value, repaired: junk dropped, ids unique, view filled in, other keys kept. */
export function normalizeState(raw, opts = {}) {
  const src = Array.isArray(raw) ? { items: raw } : raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(src.items) ? src.items : []) {
    const t = normalizeTracker(entry, opts);
    if (!t) continue;
    const base = t.id;
    for (let n = 2; seen.has(t.id); n++) t.id = `${base}-${n}`;
    seen.add(t.id);
    items.push(t);
  }
  return { ...src, items, view: normalizeView(src.view) };
}

/** Active trackers first, then the archived ones; each group in the order they were made. */
export function orderedTrackers(items) {
  const list = Array.isArray(items) ? items : [];
  return [...list.filter((t) => !t.archived), ...list.filter((t) => t.archived)];
}

/** The tracker to show: the one picked on this device, else the first active one (else any). */
export function selectedTracker(state) {
  const items = state?.items ?? [];
  return items.find((t) => t.id === state?.view?.selectedId) ?? items.find((t) => !t.archived) ?? items[0] ?? null;
}

/* ==========================================================================
   Edits
   ========================================================================== */

/**
 * Check the dialog's fields { name, start, icon }. `keepStart`: a tracker's own start, accepted as
 * it is even if it lies after today (saved by a device ahead in time) -> { fields } | { error, field }
 */
function validate(f, today, keepStart = null) {
  const name = cleanName(f.name);
  if (!name) return { error: 'Give it a name, like Smoking.', field: 'name' };
  if (!isKey(f.start)) return { error: 'Pick the day you started.', field: 'start' };
  if (f.start > today && f.start !== keepStart) return { error: 'The start can’t be after today.', field: 'start' };
  return { fields: { name, start: f.start, icon: iconName(f.icon) } };
}

/** A new tracker from { name, start, icon } -> { tracker } | { error, field }. */
export function createTracker(fields, { today, now = Date.now(), makeId = fallbackId } = {}) {
  const v = validate(fields ?? {}, today ?? dateKey(new Date(now)));
  if (v.error) return v;
  return { tracker: normalizeTracker({ id: String(makeId()), ...v.fields, relapses: [], archived: false, createdAt: now }, { now, makeId }) };
}

/**
 * The tracker with { name, start, icon } changed -> { tracker, dropped } | { error, field }.
 * dropped: relapses that fell before a later start (gone with it).
 */
export function updateTracker(tracker, fields, { today } = {}) {
  const v = validate({ ...tracker, ...fields }, today ?? dateKey(new Date()), tracker.start);
  if (v.error) return v;
  const next = normalizeTracker({ ...tracker, ...v.fields });
  return { tracker: next, dropped: tracker.relapses.length - next.relapses.length };
}

/** Whether `day` can be marked or unmarked as a relapse: from the start through today. */
export function canMark(tracker, day, today) {
  return !!tracker && isKey(day) && day >= tracker.start && day <= today;
}

/**
 * Mark (on) or unmark (off) `day` as a relapse -> { tracker, changed } | { error }.
 * Days after today and before the start are refused; asking for what is already so changes nothing.
 */
export function setRelapse(tracker, day, on, today) {
  if (!isKey(day)) return { error: 'That isn’t a day.' };
  if (day > today) return { error: 'That day hasn’t come yet.' };
  if (day < tracker.start) return { error: 'That’s before you started.' };
  const has = tracker.relapses.includes(day);
  if (has === !!on) return { tracker, changed: false };
  const relapses = on ? cleanDays([...tracker.relapses, day], tracker.start) : tracker.relapses.filter((d) => d !== day);
  return { tracker: { ...tracker, relapses }, changed: true };
}

export function toggleRelapse(tracker, day, today) {
  return setRelapse(tracker, day, !tracker.relapses.includes(day), today);
}

/* ==========================================================================
   Counting
   ========================================================================== */

/** The relapses that count today: from the start through today, sorted, each once. */
export function countedRelapses(tracker, today) {
  return cleanDays(tracker?.relapses, tracker?.start).filter((d) => d <= today);
}

/**
 * The clean runs, oldest first: [{ from, to, days, ongoing, endedOn }]. `endedOn` is the relapse
 * that ended a run (null for the ongoing one). Empty stretches (two relapses in a row, a relapse on
 * the start day or today) are no run. Nothing before the start is reached.
 */
export function cleanRuns(tracker, today) {
  if (!tracker || !isKey(tracker.start) || !isKey(today) || tracker.start > today) return [];
  const runs = [];
  let from = tracker.start;
  for (const r of countedRelapses(tracker, today)) {
    if (r > from) runs.push({ from, to: shiftKey(r, -1), days: diffDays(from, r), ongoing: false, endedOn: r });
    from = shiftKey(r, 1);
  }
  if (from <= today) runs.push({ from, to: today, days: diffDays(from, today) + 1, ongoing: true, endedOn: null });
  return runs;
}

/** Days clean now: the ongoing run's days, today included (0 when today is a relapse). */
export function daysClean(tracker, today) {
  const last = cleanRuns(tracker, today).at(-1);
  return last?.ongoing ? last.days : 0;
}

/**
 * The next milestone above `days`: { next, reached, toGo, progress }. reached: the last one at or
 * under it (0 before day 1); progress: days / next, 0..1.
 */
export function nextMilestone(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  const next = MILESTONES.find((m) => m > d) ?? (Math.floor(d / 365) + 1) * 365;
  const reached = d >= 365 ? Math.floor(d / 365) * 365 : [...MILESTONES].reverse().find((m) => m <= d) ?? 0;
  return { next, reached, toGo: next - d, progress: d / next };
}

/** A milestone in words: '1 day', '1 week', '2 weeks', '1 month', '6 months', '1 year', '2 years'. */
export function milestoneLabel(n) {
  if (n >= 365 && n % 365 === 0) return plural(n / 365, 'year');
  if ([30, 60, 90, 180].includes(n)) return plural(n / 30, 'month');
  if (n === 7 || n === 14) return plural(n / 7, 'week');
  return plural(n, 'day');
}

/**
 * Everything the page shows about a tracker on `today`:
 * { started, totalDays, cleanDays, relapseCount, relapses30, relapsedToday, lastRelapse, runs,
 *   current, currentFrom, best, average, cleanRatio, milestone }
 * - totalDays: days from the start through today; cleanDays: those that aren't a relapse
 * - relapses30: relapses in the last 30 days, today included
 * - average: clean days per run (null without one); cleanRatio: cleanDays / totalDays (null before day 1)
 */
export function stats(tracker, today) {
  const started = !!tracker && isKey(tracker.start) && tracker.start <= today;
  const relapses = started ? countedRelapses(tracker, today) : [];
  const runs = cleanRuns(tracker, today);
  const totalDays = started ? diffDays(tracker.start, today) + 1 : 0;
  const clean = totalDays - relapses.length;
  const last = runs.at(-1);
  const current = last?.ongoing ? last.days : 0;
  const since = shiftKey(today, -29);
  return {
    started,
    totalDays,
    cleanDays: clean,
    relapseCount: relapses.length,
    relapses30: relapses.filter((d) => d >= since).length,
    relapsedToday: relapses.at(-1) === today,
    lastRelapse: relapses.at(-1) ?? null,
    runs,
    current,
    currentFrom: last?.ongoing ? last.from : null,
    best: runs.reduce((m, r) => Math.max(m, r.days), 0),
    average: runs.length ? clean / runs.length : null,
    cleanRatio: totalDays ? clean / totalDays : null,
    milestone: nextMilestone(current),
  };
}

/** A share as a percentage that never rounds a relapse away: '100%' only with none, '0%' only with no clean day. */
export function percentText(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  if (ratio >= 1) return '100%';
  if (ratio <= 0) return '0%';
  return `${Math.min(99, Math.max(1, Math.round(ratio * 100)))}%`;
}

/** An average in days: '8 days', '6.5 days', '1 day'. */
export function averageText(avg) {
  if (avg == null || !Number.isFinite(avg)) return '—';
  const v = Math.round(avg * 10) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${v === 1 ? 'day' : 'days'}`;
}

export const dayCount = (n) => plural(n, 'day');

/** The page-top status: '12 days clean', 'A new start tomorrow', 'Starts Mon 26 Oct'. */
export function statusText(tracker, today) {
  if (!tracker) return '';
  const s = stats(tracker, today);
  if (!s.started) return `Starts ${formatDay(tracker.start)}`;
  if (s.relapsedToday) return 'A new start tomorrow';
  return `${dayCount(s.current)} clean`;
}

/** A run's days in words: 'Tue 13 Oct – today', 'Mon 5 Oct – Sun 11 Oct', 'Mon 12 Oct' (one day). */
export function runRange(run, today) {
  const to = run.to === today ? 'today' : formatDay(run.to);
  return run.from === run.to ? (run.to === today ? 'Today' : formatDay(run.from)) : `${formatDay(run.from)} – ${to}`;
}

/* ==========================================================================
   Calendar and chart
   ========================================================================== */

export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

export function monthTitle(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

/** The months a tracker's calendar can show: its start's month through today's (or today's alone). */
export function monthRange(tracker, today) {
  const last = monthOf(today);
  const first = tracker && isKey(tracker.start) && tracker.start < today ? monthOf(tracker.start) : last;
  return { first, last };
}

/** `month` (or today's, when there is none) kept inside the tracker's months. */
export function clampMonth(month, tracker, today) {
  const { first, last } = monthRange(tracker, today);
  const m = isMonth(month) ? month : last;
  return m < first ? first : m > last ? last : m;
}

/** Month 'YYYY-MM' as weeks, Monday first: [[key | null × 7], …] (null: a day of another month). */
export function monthWeeks(month) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const days = new Date(y, m, 0).getDate();
  const cells = Array((weekday(first) + 6) % 7).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * A calendar day: { kind, relapse }. kind: 'before' (before the start), 'future' (after today),
 * 'relapse' or 'clean'. `relapse` is also true on a later day saved as one (shown, not counted).
 */
export function dayState(tracker, day, today) {
  const relapse = !!tracker?.relapses.includes(day);
  if (!tracker || day < tracker.start) return { kind: 'before', relapse: false };
  if (day > today) return { kind: 'future', relapse };
  return { kind: relapse ? 'relapse' : 'clean', relapse };
}

/** The chart's bars: the newest CHART_MAX runs, oldest first. */
export function chartRuns(runs, max = CHART_MAX) {
  return runs.slice(-max);
}

/** A y axis from 0 that fits `max`: { top, ticks } with 1–4 steps of 1, 2 or 5 × 10ⁿ. */
export function axisTicks(max) {
  const m = Math.max(1, Math.ceil(Number(max) || 0));
  let step = 1;
  for (let p = 1; ; p *= 10) {
    const s = [1, 2, 5].map((k) => k * p).find((k) => m / k <= 4);
    if (s) {
      step = s;
      break;
    }
  }
  const top = Math.ceil(m / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

/** A tracker in words for Search and the Home widget: 'Smoking: 12 days clean'. */
export function trackerText(tracker, today) {
  return `${tracker.name}: ${statusText(tracker, today).replace(/^A new/, 'a new').replace(/^Starts/, 'starts')}`;
}
