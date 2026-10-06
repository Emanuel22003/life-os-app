// LIFE/OS — Calendar: pure, DOM-free logic (events, recurrence, layout, grids, planning).
//
// Day math runs on integer day numbers from habits.logic (derived via Date.UTC), so DST
// and time-zone offsets can never shift or duplicate a day. Keys are LOCAL calendar days
// 'YYYY-MM-DD'; times are LOCAL wall-clock minutes since midnight shown as 24-hour 'HH:MM'.
// Every function takes `today` / `now` / `makeId` from the caller so results are testable.
//
// Store value (key 'calendar')
//   { events: Event[], view: 'month' | 'week' | 'day',
//     layers: { tasks, habits, events, completed }, seeded? }
//   Event = { id, title, allDay, start, end, startTime, endTime, location, notes, style,
//             repeat: null | { freq, interval, days, until }, exdates, createdAt, updatedAt }
//
// Event rules
// - `end` is inclusive (equals `start` for one day). Only all-day events span days.
// - Timed events are single-day with startTime < endTime <= 23:59 (default length 1 h).
//   All-day events have startTime = endTime = null.
// - style: 'solid' | 'outline' | 'hatched' | 'ink' — four grayscale looks the user picks.
//
// Recurrence (counted from `start`)
// - daily:   every `interval` days.
// - weekly:  every `interval` weeks (Monday-first weeks counted from the week of `start`)
//            on `days` (0 = Sun … 6 = Sat). Days are matched strictly: the start date is an
//            occurrence only when its weekday is listed (the editor pre-selects it).
// - monthly: every `interval` months on start's day of the month. Months without that day
//            are skipped (a series on the 31st skips 30-day months and February).
// - yearly:  every `interval` years on start's month and day (29 Feb only in leap years).
// - `until` (inclusive) bounds occurrence START dates; `exdates` lists occurrence start
//   dates removed from the series ("delete only this event"). A multi-day all-day series
//   repeats its whole span from each start date.
// - Moving a whole series by k days (shiftEvent / updateSeries / splitSeries) keeps every date
//   + k exactly, or is refused (null / SHIFT_REFUSED): an every-2+-weeks weekly rule can't
//   follow a move that puts some of its weekdays into the next or previous week and not
//   others (shiftFits). Callers then offer "only this event".
// - "This and following" needs a real date before it (hasOccurrenceBefore): a series' start
//   isn't always one of its dates.
//
// Grids
// - Weeks are Monday-first; week numbers are ISO-8601.
// - monthGrid holds exactly the weeks that touch the month (4–6 rows), or 6 rows with
//   { rows: 6 }. viewRange('month') covers the same days as the default grid.

import { uid, MONTHS_SHORT, WEEKDAYS_SHORT } from '../ui.js';
import { isValidKey, toDayNum, fromDayNum, weekdayOf, normalizeDays, compileHabit, scheduledAt, activeAt } from './habits.logic.js';

/* ==========================================================================
   Vocabulary
   ========================================================================== */

export const VIEWS = Object.freeze(['month', 'week', 'day']);
export const VIEW_LABEL = Object.freeze({ month: 'Month', week: 'Week', day: 'Day' });
export const STYLES = Object.freeze(['solid', 'outline', 'hatched', 'ink']);
export const STYLE_LABEL = Object.freeze({ solid: 'Solid', outline: 'Outline', hatched: 'Hatched', ink: 'Ink' });
export const FREQS = Object.freeze(['daily', 'weekly', 'monthly', 'yearly']);
export const FREQ_LABEL = Object.freeze({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' });
export const LAYERS = Object.freeze(['events', 'tasks', 'habits', 'completed']);
export const DEFAULT_LAYERS = Object.freeze({ tasks: true, habits: true, events: true, completed: false });
export const DEFAULT_STATE = Object.freeze({ events: Object.freeze([]), view: 'month', layers: DEFAULT_LAYERS });

/** A fresh, mutable copy of the default store value. */
export function defaultState() {
  return { events: [], view: 'month', layers: { ...DEFAULT_LAYERS } };
}

export const TITLE_MAX = 120;
export const LOCATION_MAX = 200;
export const NOTES_MAX = 10000;
export const INTERVAL_MAX = 999;
export const DAY_MINUTES = 1440;
/** Latest end time of a timed event (23:59). */
export const LAST_MINUTE = 1439;
export const DEFAULT_DURATION = 60;
export const SNAP_MINUTES = 15;

export const MONTHS_LONG = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
export const WEEKDAYS_LONG = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
/** Monday-first display order of weekdays (values are still 0 = Sun … 6 = Sat). */
export const WEEK_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

const PRIORITY_RANK = new Map([
  ['none', 0],
  ['low', 1],
  ['med', 2],
  ['high', 3],
]);

/* ==========================================================================
   Small helpers
   ========================================================================== */

const DAY_MS = 86400000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');
const clampNum = (n, min, max) => Math.min(max, Math.max(min, n));
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (y, m0) => (m0 === 1 && isLeap(y) ? 29 : MONTH_DAYS[m0]);
const dayNumOf = (y, m0, d) => Math.floor(Date.UTC(y, m0, d) / DAY_MS);
/** Monday = 0 … Sunday = 6 for a day number. */
const isoDow = (n) => (weekdayOf(n) + 6) % 7;
const ymd = (key) => key.split('-').map(Number);
const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

/** Case-insensitive text order with a case-sensitive tiebreak, so sorting is deterministic. */
function cmpText(a, b) {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Accepts 'YYYY-MM-DD' or an ISO timestamp string; anything else -> null. */
function toKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().slice(0, 10);
  return isValidKey(key) ? key : null;
}

/** Single-line text: collapse whitespace, trim, cap. Only strings and numbers count. */
function cleanLine(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** shiftDays('2026-10-05', -1) -> '2026-10-04' (pure key math). */
export function shiftDays(key, n) {
  return fromDayNum(toDayNum(key) + n);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  return toDayNum(b) - toDayNum(a);
}

/** Every key from `from` to `to` inclusive ([] when to < from or a key is invalid). */
export function rangeKeys(from, to) {
  if (!isValidKey(from) || !isValidKey(to)) return [];
  const out = [];
  for (let n = toDayNum(from), last = toDayNum(to); n <= last; n++) out.push(fromDayNum(n));
  return out;
}

/* ==========================================================================
   Time of day
   ========================================================================== */

const TIME_RE = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** 'HH:MM' (also 'H:MM', seconds ignored) -> minutes since midnight 0..1439, else null. */
export function parseTime(value) {
  if (typeof value !== 'string') return null;
  const m = TIME_RE.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes -> 'HH:MM'. Clamped to 00:00..23:59, so the end of the day (1440) reads 23:59. */
export function formatTime(minutes) {
  const m = clampNum(Math.round(Number.isFinite(minutes) ? minutes : 0), 0, LAST_MINUTE);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** '45m' | '1h' | '1h 30m' ('0m' when end <= start). */
export function durationLabel(startMin, endMin) {
  const d = Math.max(0, Math.round(endMin - startMin)) || 0;
  const h = Math.floor(d / 60);
  const m = d % 60;
  if (h && m) return `${h}h ${m}m`;
  return h ? `${h}h` : `${m}m`;
}

/** Nearest multiple of `step`, clamped to 0..1440. */
export function snapMinutes(minutes, step = SNAP_MINUTES) {
  const s = step > 0 ? step : SNAP_MINUTES;
  return clampNum(Math.round((Number(minutes) || 0) / s) * s, 0, DAY_MINUTES);
}

/** A valid timed slot { startMin, endMin, startTime, endTime } with 0 <= start < end <= 23:59. */
function timedSlot(s, e) {
  const start = clampNum(Math.round(s), 0, LAST_MINUTE - 1);
  const end = clampNum(Math.round(e), start + 1, LAST_MINUTE);
  return { startMin: start, endMin: end, startTime: formatTime(start), endTime: formatTime(end) };
}

/**
 * Slot for a click or drag between two timeline positions (either order): the start snaps
 * down and the end snaps up to `step`, at least one step long, inside the day.
 */
export function slotFromDrag(aMin, bMin, step = SNAP_MINUTES) {
  const s = step > 0 ? step : SNAP_MINUTES;
  const lo = clampNum(Math.floor(Math.min(aMin, bMin) / s) * s, 0, DAY_MINUTES - s);
  let hi = clampNum(Math.ceil(Math.max(aMin, bMin) / s) * s, 0, DAY_MINUTES);
  if (hi - lo < s) hi = lo + s;
  return timedSlot(lo, hi);
}

/** Move a timed block by `deltaMin` (snapped), keeping its length and staying inside the day. */
export function moveTimed(startMin, endMin, deltaMin, step = SNAP_MINUTES) {
  const dur = clampNum(Math.round(endMin - startMin), 1, LAST_MINUTE);
  const s = clampNum(snapMinutes(startMin + deltaMin, step), 0, LAST_MINUTE - dur);
  return timedSlot(s, s + dur);
}

/** Resize a timed block's end to `endMin` (snapped), at least one step long. */
export function resizeTimed(startMin, endMin, step = SNAP_MINUTES) {
  const s = step > 0 ? step : SNAP_MINUTES;
  return timedSlot(startMin, Math.max(snapMinutes(endMin, s), startMin + s));
}

/** 'All day' | '09:00–10:30' for an occurrence or event. */
export function timeLabel(item) {
  if (!item || item.allDay) return 'All day';
  return `${item.startTime}–${item.endTime}`;
}

/* ==========================================================================
   Normalization — junk tolerant, idempotent, same object when already valid
   ========================================================================== */

/** Weekday list from raw input; numeric strings are accepted. */
function cleanDays(raw) {
  if (!Array.isArray(raw)) return [];
  return normalizeDays(raw.map((d) => (typeof d === 'string' && d.trim() !== '' ? Number(d) : d)));
}

/**
 * Canonical repeat rule for an event starting on `start`, or null.
 * Accepts a freq string ('weekly') as shorthand. Weekly with no valid days falls back to
 * start's weekday; days are [] for other frequencies. until < start -> null (no repeat).
 */
export function normalizeRepeat(raw, start) {
  const src = typeof raw === 'string' ? { freq: raw } : raw;
  if (!isObject(src) || !isValidKey(start)) return null;
  const freq = typeof src.freq === 'string' ? src.freq.trim().toLowerCase() : '';
  if (!FREQS.includes(freq)) return null;
  const n = Math.floor(Number(src.interval));
  const interval = Number.isFinite(n) && n >= 1 ? Math.min(n, INTERVAL_MAX) : 1;
  let days = [];
  if (freq === 'weekly') {
    days = cleanDays(src.days);
    if (!days.length) days = [weekdayOf(toDayNum(start))];
  }
  const until = toKey(src.until);
  if (until && until < start) return null;
  return { freq, interval, days, until };
}

/** Same rule (both null, or identical normalized fields). */
export function sameRepeat(a, b) {
  if (!a || !b) return !a && !b;
  return a.freq === b.freq && a.interval === b.interval && sameArray(a.days, b.days) && (a.until ?? null) === (b.until ?? null);
}

/** Raw repeat already in canonical shape (exactly the four fields). */
function isCanonicalRepeat(raw, clean) {
  if (!clean) return raw === null;
  return isObject(raw) && Object.keys(raw).length === 4 && sameRepeat(raw, clean) && raw.until === clean.until;
}

function normalizeExdates(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isValidKey))].sort();
}

/**
 * A valid Event, or null when `raw` is not an object or has no usable date.
 * Fixes rather than drops: missing title -> 'Untitled event'; a timed event with a broken
 * start time becomes all-day; end < start -> end = start; timed events are forced onto one
 * day with end > start (default +1 h, at most 23:59). Unknown extra fields are kept.
 * Returns `raw` itself when it is already valid.
 */
export function normalizeEvent(raw, { now = Date.now(), makeId = uid } = {}) {
  if (!isObject(raw)) return null;
  const endRaw = toKey(raw.end);
  const start = toKey(raw.start) ?? endRaw;
  if (!start) return null;

  const id = typeof raw.id === 'string' && raw.id ? raw.id : Number.isFinite(raw.id) ? String(raw.id) : String(makeId());
  const title = cleanLine(raw.title ?? raw.name, TITLE_MAX) || 'Untitled event';
  let startMin = parseTime(raw.startTime);
  const allDay = startMin === null ? true : typeof raw.allDay === 'boolean' ? raw.allDay : false;

  let end = start;
  let startTime = null;
  let endTime = null;
  if (allDay) {
    if (endRaw && endRaw > start) end = endRaw;
  } else {
    startMin = Math.min(startMin, LAST_MINUTE - 1);
    let endMin = parseTime(raw.endTime);
    if (endMin === null || endMin <= startMin) endMin = Math.min(startMin + DEFAULT_DURATION, LAST_MINUTE);
    startTime = formatTime(startMin);
    endTime = formatTime(endMin);
  }

  const repeat = normalizeRepeat(raw.repeat, start);
  const exdates = repeat ? normalizeExdates(raw.exdates) : [];
  const location = cleanLine(raw.location, LOCATION_MAX);
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, NOTES_MAX) : '';
  const style = STYLES.includes(raw.style) ? raw.style : 'solid';
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;

  const unchanged =
    id === raw.id &&
    title === raw.title &&
    allDay === raw.allDay &&
    start === raw.start &&
    end === raw.end &&
    startTime === raw.startTime &&
    endTime === raw.endTime &&
    location === raw.location &&
    notes === raw.notes &&
    style === raw.style &&
    isCanonicalRepeat(raw.repeat, repeat) &&
    sameArray(exdates, raw.exdates) &&
    createdAt === raw.createdAt &&
    updatedAt === raw.updatedAt;
  if (unchanged) return raw;
  return { ...raw, id, title, allDay, start, end, startTime, endTime, location, notes, style, repeat, exdates, createdAt, updatedAt };
}

const REPEAT_KEYS = new Set(['freq', 'interval', 'days', 'until']);

/**
 * True when a stored event carries data this version can't represent: a repeat rule with an
 * unknown frequency or extra fields, or an unknown look. normalizeEvent would drop that data
 * (the rule becomes "no repeat", the look 'solid'), so the store writes such an event back
 * exactly as stored until it is edited, and the page treats it as read-only (an older window
 * left open next to a newer LIFE/OS must never strip what the newer one saved).
 */
export function isForeignEvent(raw) {
  if (!isObject(raw)) return false;
  if (typeof raw.style === 'string' && raw.style.trim() !== '' && !STYLES.includes(raw.style.trim().toLowerCase())) return true;
  const r = raw.repeat;
  if (!isObject(r)) return false;
  if (typeof r.freq === 'string' && r.freq.trim() !== '' && !FREQS.includes(r.freq.trim().toLowerCase())) return true;
  return Object.keys(r).some((k) => !REPEAT_KEYS.has(k));
}

function normalizeLayers(raw) {
  const src = isObject(raw) ? raw : {};
  const out = {};
  for (const k of LAYERS) out[k] = typeof src[k] === 'boolean' ? src[k] : DEFAULT_LAYERS[k];
  const same = isObject(raw) && Object.keys(raw).length === LAYERS.length && LAYERS.every((k) => raw[k] === out[k]);
  return same ? raw : out;
}

/**
 * Normalize the whole store value -> { ...extras, events, view, layers, seeded? }.
 * Accepts a bare events array too. Events that cannot be repaired are dropped; duplicate
 * ids get fresh ones (generated ids never collide with ids already in the data). Event
 * order is kept. Returns `raw` itself when nothing needed fixing.
 */
export function normalizeCalendar(raw, { now = Date.now(), makeId = uid } = {}) {
  const src = Array.isArray(raw) ? { events: raw } : isObject(raw) ? raw : {};
  const list = Array.isArray(src.events) ? src.events : [];
  let changed = src !== raw || list !== src.events;

  const reserved = new Set();
  for (const it of list) if (isObject(it) && typeof it.id === 'string' && it.id) reserved.add(it.id);
  const seen = new Set();
  const fresh = () => {
    const base = String(makeId());
    let id = base;
    for (let k = 1; reserved.has(id) || seen.has(id); k++) id = `${base}-${k}`;
    reserved.add(id);
    return id;
  };

  const events = [];
  for (const it of list) {
    let ev = normalizeEvent(it, { now, makeId: fresh });
    if (!ev) {
      changed = true;
      continue;
    }
    if (seen.has(ev.id)) ev = { ...ev, id: fresh() };
    seen.add(ev.id);
    if (ev !== it) changed = true;
    events.push(ev);
  }

  const view = VIEWS.includes(src.view) ? src.view : DEFAULT_STATE.view;
  const layers = normalizeLayers(src.layers);
  if (view !== src.view || layers !== src.layers) changed = true;
  const fixSeeded = has(src, 'seeded') && typeof src.seeded !== 'boolean';
  if (fixSeeded) changed = true;
  if (!changed) return raw;
  const out = { ...src, events, view, layers };
  if (fixSeeded) out.seeded = !!src.seeded;
  return out;
}

/* ==========================================================================
   Create / edit / validate
   ========================================================================== */

const fail = (field, error) => ({ ok: false, field, error });
const blank = (v) => v === undefined || v === null || v === '';

/** All-day unless allDay is explicitly false or a valid start time is given without allDay. */
function resolveAllDay(src) {
  return typeof src.allDay === 'boolean' ? src.allDay : parseTime(src.startTime) === null;
}

/**
 * Check form-like input: { title, allDay, start, end?, startTime?, endTime?, repeat? }.
 * -> { ok: true } | { ok: false, field, error } with field one of
 *    'title' | 'start' | 'end' | 'startTime' | 'endTime' | 'repeat' | 'interval' | 'days' | 'until'
 * (first problem in form order). A blank endTime is fine (it defaults to start + 1 h).
 */
export function validateEvent(input) {
  const src = isObject(input) ? input : {};
  if (!cleanLine(src.title, TITLE_MAX)) return fail('title', 'Give the event a title.');
  if (!isValidKey(src.start)) return fail('start', 'Pick a valid start date.');
  if (resolveAllDay(src)) {
    if (!blank(src.end) && !isValidKey(src.end)) return fail('end', 'Pick a valid end date.');
    if (isValidKey(src.end) && src.end < src.start) return fail('end', 'The end date can’t be before the start date.');
  } else {
    const s = parseTime(src.startTime);
    if (s === null) return fail('startTime', 'Use 24-hour time, like 09:30.');
    if (!blank(src.endTime)) {
      const e = parseTime(src.endTime);
      if (e === null) return fail('endTime', 'Use 24-hour time, like 10:30.');
      if (e <= s) return fail('endTime', 'The end time must be after the start time.');
    } else if (s >= LAST_MINUTE) {
      return fail('endTime', 'Pick an end time.');
    }
  }

  const rep = src.repeat;
  if (!blank(rep) && rep !== 'none') {
    const r = typeof rep === 'string' ? { freq: rep } : rep;
    if (!isObject(r) || !FREQS.includes(r.freq)) return fail('repeat', 'Choose how often it repeats.');
    if (!blank(r.interval)) {
      const k = Number(r.interval);
      if (!Number.isInteger(k) || k < 1 || k > INTERVAL_MAX) return fail('interval', `Repeat every 1 to ${INTERVAL_MAX}.`);
    }
    if (r.freq === 'weekly' && Array.isArray(r.days) && !cleanDays(r.days).length) return fail('days', 'Pick at least one weekday.');
    if (!blank(r.until)) {
      if (!isValidKey(r.until)) return fail('until', 'Pick a valid date for the repeat to end.');
      if (r.until < src.start) return fail('until', 'The repeat can’t end before the event starts.');
      const candidate = { start: src.start, end: src.start, allDay: true, repeat: normalizeRepeat(r, src.start), exdates: [] };
      if (isEmptySeries(candidate)) return fail('until', 'No events fall before the repeat ends.');
    }
  }
  return { ok: true };
}

/** Fill the defaults a form may leave out (end date, end time). */
function withDefaults(input) {
  const src = isObject(input) ? { ...input } : {};
  const allDay = resolveAllDay(src);
  src.allDay = allDay;
  if (allDay) {
    if (blank(src.end)) src.end = src.start;
    src.startTime = null;
    src.endTime = null;
  } else {
    src.end = src.start;
    const s = parseTime(src.startTime);
    if (s !== null && blank(src.endTime)) src.endTime = formatTime(Math.min(s + DEFAULT_DURATION, LAST_MINUTE));
  }
  if (src.repeat === 'none' || src.repeat === '') src.repeat = null;
  return src;
}

/**
 * New event from form-like input -> { event } | { error, field }.
 * input: { title, allDay?, start, end?, startTime?, endTime?, location?, notes?, style?, repeat? }
 */
export function createEvent(input, { now = Date.now(), makeId = uid } = {}) {
  const src = withDefaults(input);
  const v = validateEvent(src);
  if (!v.ok) return { error: v.error, field: v.field };
  const event = normalizeEvent(
    {
      id: String(makeId()),
      title: src.title,
      allDay: src.allDay,
      start: src.start,
      end: src.end,
      startTime: src.startTime,
      endTime: src.endTime,
      location: src.location,
      notes: src.notes,
      style: src.style,
      repeat: src.repeat ?? null,
      exdates: [],
      createdAt: now,
      updatedAt: now,
    },
    { now, makeId },
  );
  return { event };
}

const EDITABLE = ['title', 'allDay', 'start', 'end', 'startTime', 'endTime', 'location', 'notes', 'style', 'repeat', 'exdates'];

/**
 * Apply a patch to an event's editable fields, keeping what the user did not touch:
 * - all-day start moved without an end -> the span moves with it;
 * - timed start moved without an end time -> the length is kept (clamped to 23:59);
 * - switching to timed without times -> 09:00–10:00; switching to all-day drops the times.
 */
function mergePatch(base, patch) {
  const p = isObject(patch) ? patch : {};
  const d = {};
  for (const k of EDITABLE) d[k] = base[k];
  for (const k of EDITABLE) if (has(p, k) && p[k] !== undefined) d[k] = p[k];
  if (d.repeat === 'none' || d.repeat === '') d.repeat = null;
  const allDay = resolveAllDay(d);
  d.allDay = allDay;

  if (allDay) {
    if (has(p, 'start') && !has(p, 'end') && base.allDay && isValidKey(d.start) && isValidKey(base.start) && isValidKey(base.end)) {
      d.end = shiftDays(d.start, Math.max(0, daysBetween(base.start, base.end)));
    } else if (!base.allDay && !has(p, 'end')) {
      d.end = d.start;
    }
    if (blank(d.end)) d.end = d.start;
    d.startTime = null;
    d.endTime = null;
  } else {
    d.end = d.start;
    // Only fill a time the patch left out; a time the user cleared stays blank and fails validation.
    if (blank(d.startTime) && (!has(p, 'startTime') || p.startTime === undefined)) {
      d.startTime = '09:00';
      if (!has(p, 'endTime')) d.endTime = null;
    }
    const s = parseTime(d.startTime);
    const bs = parseTime(base.startTime);
    const be = parseTime(base.endTime);
    if (s !== null && has(p, 'startTime') && !has(p, 'endTime') && !base.allDay && bs !== null && be !== null && be > bs) {
      d.endTime = formatTime(Math.min(s + (be - bs), LAST_MINUTE));
    }
    if (s !== null && blank(d.endTime)) d.endTime = formatTime(Math.min(s + DEFAULT_DURATION, LAST_MINUTE));
  }
  return d;
}

/**
 * Patch an event -> { event } | { error, field }. id and createdAt are kept, updatedAt = now.
 * exdates are left as they are (use shiftEvent / updateSeries to move a whole series).
 */
export function updateEvent(event, patch, { now = Date.now() } = {}) {
  if (!isObject(event)) return { error: 'That event no longer exists.', field: null };
  const d = mergePatch(event, patch);
  const v = validateEvent(d);
  if (!v.ok) return { error: v.error, field: v.field };
  const next = normalizeEvent({ ...event, ...d, id: event.id, createdAt: event.createdAt, updatedAt: now }, { now });
  return { event: next };
}

/** Why a whole-series move was refused (see shiftFits). */
export const SHIFT_REFUSED = 'An every-2+-weeks series can’t move its dates across a week boundary as a whole. Move only this date, or change its weekdays.';

/**
 * Can every occurrence of `event` move `delta` days and still be described by one rule?
 * Always true, except for a weekly rule every 2+ weeks whose weekdays would end up in
 * different week phases: e.g. every 2 weeks on Mon + Fri moved one day earlier turns the
 * Mondays into Sundays of the PREVIOUS Monday-first week while the Thursdays stay in their
 * week, and no single every-2-weeks rule has both. Callers refuse such a move (offer "only
 * this event") instead of silently writing a rule that lands on other dates.
 */
export function shiftFits(event, delta) {
  const k = Math.trunc(Number(delta)) || 0;
  if (!k || !isObject(event) || !isValidKey(event.start)) return true;
  const r = normalizeRepeat(event.repeat, event.start);
  if (!r || r.freq !== 'weekly' || r.interval < 2) return true;
  const phase = (d) => {
    const weeks = Math.floor((((d + 6) % 7) + k) / 7);
    return ((weeks % r.interval) + r.interval) % r.interval;
  };
  return new Set(r.days.map(phase)).size <= 1;
}

/** First date the rule produces (exdates ignored, until respected), or null. */
function firstRuleDay(event) {
  if (!usable(event)) return null;
  const c = compileEvent(event);
  if (!c.repeat) return null;
  const top = Math.min(c.until, c.s + 7 * (c.repeat.interval + 1));
  const n = startsIn({ ...c, ex: null }, c.s, top, 1)[0];
  return n === undefined ? null : fromDayNum(n);
}

/** Shift dates by k days; `rotate` turns a weekly rule's weekdays with them. */
function shiftCore(event, k, now, rotate) {
  const r = event.repeat;
  // Every N weeks counts weeks from the start's week: anchor on the first real date, so the
  // shifted start's week has the same phase as the shifted dates (a start that isn't itself
  // a date, e.g. a Sunday start for a Wednesday rule, would otherwise flip the phase).
  let from = event.start;
  if (rotate && isObject(r) && r.freq === 'weekly' && Number(r.interval) > 1) from = firstRuleDay(event) ?? event.start;
  const start = shiftDays(from, k);
  if (!isValidKey(start)) return event;
  const sh = (key) => shiftDays(key, k);
  const span = isValidKey(event.end) ? Math.max(0, daysBetween(event.start, event.end)) : 0;
  const next = {
    ...event,
    start,
    end: shiftDays(start, span),
    repeat: r
      ? {
          ...r,
          days: rotate && r.freq === 'weekly' ? normalizeDays((r.days ?? []).map((d) => (((d + k) % 7) + 7) % 7)) : r.days,
          until: isValidKey(r.until) ? sh(r.until) : null,
        }
      : null,
    exdates: Array.isArray(event.exdates) ? event.exdates.filter(isValidKey).map(sh) : [],
  };
  if (Number.isFinite(now)) next.updatedAt = now;
  return next;
}

/**
 * Move a whole event (or series) by `delta` days: start, end, until and exdates shift, and a
 * weekly rule's weekdays rotate with it, so every occurrence lands `delta` days later.
 * Returns the same event for delta 0 or a shift before 1970, and null when the move can't
 * be one rule (shiftFits is false); nothing is ever written for null.
 */
export function shiftEvent(event, delta, { now } = {}) {
  const k = Math.trunc(Number(delta)) || 0;
  if (!k || !isObject(event) || !isValidKey(event.start)) return event;
  if (!shiftFits(event, k)) return null;
  return shiftCore(event, k, now, true);
}

/**
 * "All events" edit made from one occurrence (the form shows that occurrence's dates).
 * A date change in `changes` moves the whole series by the same number of days
 * (shiftEvent); an all-day span change applies to every occurrence; other fields apply
 * as given. A `repeat` equal to the series' rule counts as untouched (so it shifts with the
 * series); a changed rule is taken as written. Turning repeat off (repeat: null) leaves one
 * event on the dates shown in the form. Non-recurring events -> updateEvent.
 * -> { event } | { error, field }
 */
export function updateSeries(series, occurrenceKey, changes, { now = Date.now() } = {}) {
  const p = isObject(changes) ? { ...changes } : {};
  if (!isObject(series) || !series.repeat || !isValidKey(occurrenceKey)) return updateEvent(series, p, { now });
  if (has(p, 'repeat') && p.repeat !== undefined) {
    const off = p.repeat === null || p.repeat === 'none' || p.repeat === '';
    if (off) {
      const occ = occurrenceOf(series, occurrenceKey);
      const single = { ...p, repeat: null };
      if (!has(p, 'start') || p.start === undefined) single.start = occurrenceKey;
      if ((!has(p, 'end') || p.end === undefined) && occ) single.end = shiftDays(single.start, Math.max(0, occ.spanDays - 1));
      return updateEvent(series, single, { now });
    }
    if (sameRepeat(normalizeRepeat(p.repeat, series.start), series.repeat)) delete p.repeat;
  }
  if (has(p, 'start') && p.start !== undefined && !isValidKey(p.start)) return updateEvent(series, p, { now });

  const delta = isValidKey(p.start) ? daysBetween(occurrenceKey, p.start) : 0;
  let base = shiftEvent(series, delta);
  if (!base) {
    // The rule can't follow the move; fine only when the form replaces the rule anyway
    if (!has(p, 'repeat') || p.repeat === undefined) return { error: SHIFT_REFUSED, field: 'start' };
    base = shiftCore(series, delta, undefined, false);
  }
  const patch = { ...p };
  delete patch.start;
  delete patch.end;
  if (has(p, 'start') || has(p, 'end')) {
    patch.start = base.start;
    if (has(p, 'end') && isValidKey(p.end)) {
      const from = isValidKey(p.start) ? p.start : occurrenceKey;
      patch.end = shiftDays(base.start, daysBetween(from, p.end));
    } else if (has(p, 'end')) {
      patch.end = p.end;
    }
  }
  return updateEvent(base, patch, { now });
}

/* ==========================================================================
   Recurrence expansion
   ========================================================================== */

/** Day-number view of an event, built once per query. Tolerates unnormalized input. */
function compileEvent(ev) {
  const s = toDayNum(ev.start);
  const timed = ev.allDay === false && parseTime(ev.startTime) !== null;
  const e = !timed && isValidKey(ev.end) ? toDayNum(ev.end) : s;
  const repeat = normalizeRepeat(ev.repeat, ev.start);
  return {
    ev,
    s,
    span: Math.max(1, e - s + 1),
    timed,
    repeat,
    until: repeat && repeat.until ? toDayNum(repeat.until) : Infinity,
    ex: repeat && Array.isArray(ev.exdates) && ev.exdates.length ? new Set(ev.exdates) : null,
  };
}

/**
 * Occurrence start day numbers in [lo, hi] (ascending, at most `limit`, exdates skipped).
 * Each rule jumps straight to the first candidate at or after `lo`, so the cost depends on
 * the size of the window, never on how long ago the series started.
 */
function startsIn(c, lo, hi, limit = Infinity) {
  const out = [];
  const bottom = Math.max(lo, c.s);
  const top = Math.min(hi, c.until);
  if (!(bottom <= top) || !Number.isFinite(top)) return out;
  const push = (n) => {
    if (!c.ex || !c.ex.has(fromDayNum(n))) out.push(n);
    return out.length < limit;
  };
  const r = c.repeat;
  if (!r) {
    if (c.s >= bottom && c.s <= top) push(c.s);
    return out;
  }
  const k = r.interval;
  if (r.freq === 'daily') {
    for (let n = c.s + Math.ceil((bottom - c.s) / k) * k; n <= top; n += k) if (!push(n)) break;
  } else if (r.freq === 'weekly') {
    const w0 = c.s - isoDow(c.s);
    const offsets = r.days.map((d) => (d + 6) % 7).sort((a, b) => a - b);
    outer: for (let w = Math.ceil(Math.floor((bottom - w0) / 7) / k) * k; w0 + w * 7 <= top; w += k) {
      for (const o of offsets) {
        const n = w0 + w * 7 + o;
        if (n < bottom) continue;
        if (n > top || !push(n)) break outer;
      }
    }
  } else if (r.freq === 'monthly') {
    const [sy, sm, sd] = ymd(fromDayNum(c.s));
    const m0 = sy * 12 + sm - 1;
    const [by, bm] = ymd(fromDayNum(bottom));
    const [ty, tm] = ymd(fromDayNum(top));
    const last = ty * 12 + tm - 1;
    for (let M = m0 + Math.ceil(Math.max(0, by * 12 + bm - 1 - m0) / k) * k; M <= last; M += k) {
      const y = Math.floor(M / 12);
      const mo = M - y * 12;
      if (sd > daysInMonth(y, mo)) continue;
      const n = dayNumOf(y, mo, sd);
      if (n < bottom) continue;
      if (n > top || !push(n)) break;
    }
  } else if (r.freq === 'yearly') {
    const [sy, sm, sd] = ymd(fromDayNum(c.s));
    const by = ymd(fromDayNum(bottom))[0];
    const ty = ymd(fromDayNum(top))[0];
    for (let y = sy + Math.ceil(Math.max(0, by - sy) / k) * k; y <= ty; y += k) {
      if (sd > daysInMonth(y, sm - 1)) continue;
      const n = dayNumOf(y, sm - 1, sd);
      if (n < bottom) continue;
      if (n > top || !push(n)) break;
    }
  }
  return out;
}

function makeOcc(c, n) {
  const ev = c.ev;
  const start = fromDayNum(n);
  const startMin = c.timed ? parseTime(ev.startTime) : null;
  let endMin = c.timed ? parseTime(ev.endTime) : null;
  if (c.timed && (endMin === null || endMin <= startMin)) endMin = Math.min(startMin + DEFAULT_DURATION, LAST_MINUTE);
  return {
    occId: `${ev.id}@${start}`,
    eventId: ev.id,
    start,
    end: fromDayNum(n + c.span - 1),
    startTime: c.timed ? formatTime(startMin) : null,
    endTime: c.timed ? formatTime(endMin) : null,
    startMin,
    endMin,
    allDay: !c.timed,
    title: typeof ev.title === 'string' ? ev.title : '',
    style: STYLES.includes(ev.style) ? ev.style : 'solid',
    location: typeof ev.location === 'string' ? ev.location : '',
    recurring: !!c.repeat,
    spanDays: c.span,
  };
}

/** Day order: all-day before timed; longer spans first; then by time, title, id. */
function compareOcc(a, b) {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.allDay) {
    if (a.spanDays !== b.spanDays) return b.spanDays - a.spanDays;
  } else {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return b.endMin - a.endMin;
  }
  return cmpText(a.title, b.title) || cmpText(a.occId, b.occId);
}

const usable = (ev) => isObject(ev) && isValidKey(ev.start) && (typeof ev.id === 'string' || Number.isFinite(ev.id));

/**
 * Every occurrence overlapping [from, to] (inclusive keys), sorted (compareOcc):
 * [{ occId: eventId + '@' + start, eventId, start, end, startTime, endTime, startMin,
 *    endMin, allDay, title, style, location, recurring, spanDays }]
 * startMin / endMin are minutes for timed occurrences, null for all-day ones.
 */
export function occurrencesInRange(events, from, to) {
  if (!Array.isArray(events) || !isValidKey(from) || !isValidKey(to) || to < from) return [];
  const lo = toDayNum(from);
  const hi = toDayNum(to);
  const out = [];
  for (const ev of events) {
    if (!usable(ev)) continue;
    const c = compileEvent(ev);
    for (const n of startsIn(c, lo - c.span + 1, hi)) out.push(makeOcc(c, n));
  }
  return out.sort(compareOcc);
}

/** Occurrences touching one day (multi-day spans included). */
export function occurrencesOn(events, key) {
  return occurrencesInRange(events, key, key);
}

/** True when the event has an occurrence STARTING on `key`. */
export function occursOn(event, key) {
  if (!usable(event) || !isValidKey(key)) return false;
  const n = toDayNum(key);
  return startsIn(compileEvent(event), n, n, 1).length > 0;
}

/** The occurrence of `event` starting on `key`, or null. */
export function occurrenceOf(event, key) {
  if (!usable(event) || !isValidKey(key)) return null;
  const c = compileEvent(event);
  const n = toDayNum(key);
  return startsIn(c, n, n, 1).length ? makeOcc(c, n) : null;
}

/** A recurring event with an end date and no occurrence left (every one deleted or none matches). */
export function isEmptySeries(event) {
  if (!isObject(event) || !isValidKey(event.start)) return false;
  const c = compileEvent(event);
  if (!c.repeat || !Number.isFinite(c.until)) return false;
  return startsIn(c, c.s, c.until, 1).length === 0;
}

/* ==========================================================================
   Occurrence edits
   ========================================================================== */

/** Remove one occurrence (by start key) from a series; the series stays. Same event if nothing changes. */
export function deleteOccurrence(event, key, { now } = {}) {
  if (!isObject(event) || !event.repeat || !isValidKey(key)) return event;
  const exdates = Array.isArray(event.exdates) ? event.exdates : [];
  if (exdates.includes(key)) return event;
  const next = { ...event, exdates: [...exdates, key].sort() };
  if (Number.isFinite(now)) next.updatedAt = now;
  return next;
}

/** Form-like fields of one occurrence, as a standalone (non-repeating) event. */
function occurrenceFields(series, key) {
  const occ = occurrenceOf(series, key);
  return {
    title: series.title,
    allDay: occ.allDay,
    start: occ.start,
    end: occ.end,
    startTime: occ.startTime,
    endTime: occ.endTime,
    location: series.location,
    notes: series.notes,
    style: series.style,
    repeat: null,
    exdates: [],
  };
}

/**
 * "Only this event": the series gets `key` in its exdates and a new standalone event takes
 * that occurrence with `changes` applied (any repeat in `changes` is ignored).
 * -> { series, single } | { error, field }
 */
export function detachOccurrence(series, key, changes, { now = Date.now(), makeId = uid } = {}) {
  if (!isObject(series) || !series.repeat) return { error: 'This event doesn’t repeat.', field: null };
  if (!occursOn(series, key)) return { error: 'That day isn’t part of this series.', field: 'start' };
  const base = occurrenceFields(series, key);
  const p = isObject(changes) ? { ...changes } : {};
  delete p.repeat;
  delete p.exdates;
  const d = mergePatch(base, p);
  d.repeat = null;
  const v = validateEvent(d);
  if (!v.ok) return { error: v.error, field: v.field };
  const single = normalizeEvent({ ...d, id: String(makeId()), exdates: [], createdAt: now, updatedAt: now }, { now, makeId });
  return { series: deleteOccurrence(series, key, { now }), single };
}

/**
 * True when the event has an occurrence starting before `key` (exdates respected). A series'
 * `start` isn't always a date of it (weekly days are matched strictly; early dates can be
 * deleted), so "This and following" is offered only when this is true.
 */
export function hasOccurrenceBefore(event, key) {
  if (!usable(event) || !isValidKey(key)) return false;
  const c = compileEvent(event);
  const n = toDayNum(key);
  return n > c.s && startsIn(c, c.s, n - 1, 1).length > 0;
}

/**
 * End a series just before `key` ("this and following" delete): until = the day before,
 * later exdates dropped. Returns null when no date would remain (no occurrence before `key`,
 * e.g. key <= start, or every earlier date deleted); a non-recurring event comes back unchanged.
 */
export function endSeriesBefore(series, key, { now } = {}) {
  if (!isObject(series) || !series.repeat || !isValidKey(key)) return series;
  if (key <= series.start || !hasOccurrenceBefore(series, key)) return null;
  const dayBefore = shiftDays(key, -1);
  const until = series.repeat.until && series.repeat.until < dayBefore ? series.repeat.until : dayBefore;
  const next = {
    ...series,
    repeat: { ...series.repeat, until },
    exdates: (Array.isArray(series.exdates) ? series.exdates : []).filter((d) => d < key),
  };
  if (Number.isFinite(now)) next.updatedAt = now;
  return next;
}

/**
 * "This and following events": the series ends before `key` and a new series starts at the
 * occurrence on `key` with `changes` applied (series-relative, like updateSeries). The new
 * series keeps the rule, its until and the exdates from `key` on.
 * -> { series: ended series | null (nothing left before key), next } | { error, field }
 */
export function splitSeries(series, key, changes, { now = Date.now(), makeId = uid } = {}) {
  if (!isObject(series) || !series.repeat) return { error: 'This event doesn’t repeat.', field: null };
  if (!occursOn(series, key)) return { error: 'That day isn’t part of this series.', field: 'start' };
  const occ = occurrenceOf(series, key);
  const tail = {
    ...series,
    id: String(makeId()),
    start: key,
    end: occ.end,
    exdates: (Array.isArray(series.exdates) ? series.exdates : []).filter((d) => d >= key),
    createdAt: now,
    updatedAt: now,
  };
  const res = updateSeries(tail, key, changes, { now });
  if (res.error) return res;
  return { series: endSeriesBefore(series, key, { now }), next: res.event };
}

/**
 * A pasted copy of `event` (right-click menu): the copied date `occurrenceKey` lands on `day`, at
 * `startTime` when given (a time slot: an all-day event becomes a timed one), keeping its length.
 * A repeating event starts a new series there with the same rule: the copied date and the ones
 * after it, moved together (weekly weekdays turn with them). When the rule can't follow the move
 * (shiftFits), only that date is pasted (`single`). Always a new id; the original is untouched.
 * -> { event, single } | { error }
 */
export function pasteEventCopy(event, occurrenceKey, { day, startTime = null } = {}, { now = Date.now(), makeId = uid } = {}) {
  const src = normalizeEvent(event, { now, makeId });
  if (!src) return { error: 'That copy can’t be pasted.' };
  if (!isValidKey(day)) return { error: 'Pick a valid day.' };
  const patch = { start: day };
  if (startTime !== null && startTime !== undefined) Object.assign(patch, { allDay: false, startTime });
  if (src.repeat && occursOn(src, occurrenceKey)) {
    const r = splitSeries(src, occurrenceKey, patch, { now, makeId });
    if (!r.error) return { event: r.next, single: false };
    const d = detachOccurrence(src, occurrenceKey, patch, { now, makeId });
    return d.error ? { error: d.error } : { event: d.single, single: true };
  }
  const fresh = { ...src, id: String(makeId()), repeat: null, exdates: [], createdAt: now, updatedAt: now };
  const r = updateEvent(fresh, patch, { now });
  return r.error ? { error: r.error } : { event: r.event, single: false };
}

/** 'Every day' · 'Every 2 weeks on Mon · Wed' · 'Monthly on day 31 · skips shorter months' · '… · until 5 Oct 2026'. */
export function describeRepeat(repeat, start) {
  const r = isValidKey(start) ? normalizeRepeat(repeat, start) : null;
  if (!r) return 'Does not repeat';
  const k = r.interval;
  const [, m, d] = ymd(start);
  let text;
  if (r.freq === 'daily') text = k === 1 ? 'Every day' : `Every ${k} days`;
  else if (r.freq === 'weekly') {
    const days = WEEK_ORDER.filter((w) => r.days.includes(w)).map((w) => WEEKDAYS_SHORT[w]).join(' · ');
    text = `${k === 1 ? 'Weekly' : `Every ${k} weeks`} on ${days}`;
  } else if (r.freq === 'monthly') {
    text = `${k === 1 ? 'Monthly' : `Every ${k} months`} on day ${d}${d > 28 ? ' · skips shorter months' : ''}`;
  } else {
    text = `${k === 1 ? 'Yearly' : `Every ${k} years`} on ${d} ${MONTHS_SHORT[m - 1]}${m === 2 && d === 29 ? ' · leap years only' : ''}`;
  }
  if (r.until) {
    const [uy, um, ud] = ymd(r.until);
    text += ` · until ${ud} ${MONTHS_SHORT[um - 1]} ${uy}`;
  }
  return text;
}

/* ==========================================================================
   Layout
   ========================================================================== */

/**
 * Timed occurrences of ONE day -> [{ occ, top, height, col, cols, colSpan }] where top =
 * start minute and height = length in minutes. Overlapping events share a group and sit
 * side by side: `col` is the column (0-based), `cols` the group's column count and
 * `colSpan` how many columns the block may widen into (free columns to its right).
 * Events shorter than `minMinutes` collide as if they were that long (they render at a
 * minimum height). All-day occurrences are ignored. Deterministic.
 */
export function layoutTimed(occurrences, { minMinutes = SNAP_MINUTES } = {}) {
  const items = [];
  for (const o of Array.isArray(occurrences) ? occurrences : []) {
    if (!o || o.allDay) continue;
    const s = Number.isFinite(o.startMin) ? o.startMin : parseTime(o.startTime);
    const e = Number.isFinite(o.endMin) ? o.endMin : parseTime(o.endTime);
    if (s === null || e === null) continue;
    items.push({ occ: o, s, real: Math.max(0, e - s), e: Math.max(e, s + minMinutes), col: 0, cols: 1, colSpan: 1 });
  }
  items.sort((a, b) => a.s - b.s || b.e - a.e || cmpText(a.occ.occId, b.occ.occId));

  const out = [];
  let group = [];
  let colEnds = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const cols = colEnds.length;
    for (const it of group) {
      it.cols = cols;
      let span = 1;
      for (let c = it.col + 1; c < cols; c++) {
        if (group.some((o) => o.col === c && o.s < it.e && it.s < o.e)) break;
        span++;
      }
      it.colSpan = span;
      out.push({ occ: it.occ, top: it.s, height: it.real, col: it.col, cols, colSpan: span });
    }
    group = [];
    colEnds = [];
    groupEnd = -Infinity;
  };
  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    let col = colEnds.findIndex((end) => end <= it.s);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(it.e);
    } else {
      colEnds[col] = it.e;
    }
    it.col = col;
    group.push(it);
    groupEnd = Math.max(groupEnd, it.e);
  }
  if (group.length) flush();
  return out;
}

/**
 * Bars for all-day / multi-day occurrences across a row of consecutive day keys (a week:
 * Mon..Sun; any length works, e.g. [key] for a day's all-day lane):
 * [{ occ, lane, startCol, endCol, continuesLeft, continuesRight }], columns inclusive and
 * clipped to the row; continuesLeft/Right flag bars that run past the row's edges.
 * Lanes are assigned greedily: earlier start first, then longer bars, so a bar keeps one
 * lane across its whole width. { includeTimed: true } also lays out timed occurrences as
 * one-day items (month cells). Sorted by assignment order (startCol, then length).
 */
export function layoutSpans(occurrences, keys, { includeTimed = false } = {}) {
  if (!Array.isArray(keys) || !keys.length || !keys.every(isValidKey)) return [];
  const first = toDayNum(keys[0]);
  const cols = keys.length;
  const last = first + cols - 1;
  const rows = [];
  for (const o of Array.isArray(occurrences) ? occurrences : []) {
    if (!o || !isValidKey(o.start) || (!o.allDay && !includeTimed)) continue;
    const s = toDayNum(o.start);
    const e = o.allDay && isValidKey(o.end) ? Math.max(s, toDayNum(o.end)) : s;
    if (e < first || s > last) continue;
    rows.push({ occ: o, lane: 0, startCol: Math.max(0, s - first), endCol: Math.min(cols - 1, e - first), continuesLeft: s < first, continuesRight: e > last });
  }
  rows.sort(
    (a, b) =>
      a.startCol - b.startCol ||
      b.endCol - b.startCol - (a.endCol - a.startCol) ||
      (a.occ.allDay === b.occ.allDay ? 0 : a.occ.allDay ? -1 : 1) ||
      (a.occ.startMin ?? -1) - (b.occ.startMin ?? -1) ||
      cmpText(a.occ.title, b.occ.title) ||
      cmpText(a.occ.occId, b.occ.occId),
  );
  const lanes = [];
  for (const row of rows) {
    let lane = 0;
    for (; lane < lanes.length; lane++) {
      let free = true;
      for (let c = row.startCol; c <= row.endCol && free; c++) if (lanes[lane][c]) free = false;
      if (free) break;
    }
    if (lane === lanes.length) lanes.push(new Array(cols).fill(false));
    for (let c = row.startCol; c <= row.endCol; c++) lanes[lane][c] = true;
    row.lane = lane;
  }
  return rows;
}

/** Number of lanes a layoutSpans result uses. */
export function laneCount(spans) {
  let n = 0;
  for (const s of spans ?? []) if (s.lane + 1 > n) n = s.lane + 1;
  return n;
}

/** Per column: how many bars sit in lanes >= maxLanes there (the "+N more" counts). */
export function overflowCounts(spans, cols, maxLanes) {
  const out = new Array(Math.max(0, cols | 0)).fill(0);
  for (const s of spans ?? []) {
    if (s.lane < maxLanes) continue;
    for (let c = s.startCol; c <= s.endCol && c < out.length; c++) out[c]++;
  }
  return out;
}

/* ==========================================================================
   Weeks, months, views
   ========================================================================== */

/** ISO-8601 week of a key -> { week: 1..53, year } (the week's Thursday decides the year). */
export function isoWeekInfo(key) {
  const n = toDayNum(key);
  const thursday = n - isoDow(n) + 3;
  const year = ymd(fromDayNum(thursday))[0];
  return { week: Math.floor((thursday - dayNumOf(year, 0, 1)) / 7) + 1, year };
}

/** ISO-8601 week number (1..53). */
export function isoWeek(key) {
  return isoWeekInfo(key).week;
}

/** Monday of the week containing `key`. */
export function mondayOf(key) {
  const n = toDayNum(key);
  return fromDayNum(n - isoDow(n));
}

/** The 7 keys Monday … Sunday of the week containing `key`. */
export function weekKeys(key) {
  const start = toDayNum(mondayOf(key));
  return Array.from({ length: 7 }, (_, i) => fromDayNum(start + i));
}

/**
 * Monday-first month grid for the month containing `cursorKey`.
 * opts: { today?, rows? } (a string is taken as today). rows: 'fit' (default: only the weeks
 * that touch the month, 4–6) or 6 (always six weeks).
 * -> { title: 'October 2026', month: '2026-10', from, to,
 *      weeks: [{ isoWeek, isoYear, start, end, days: [{ key, date, weekday, inMonth, isToday, isWeekend }] }] }
 */
export function monthGrid(cursorKey, opts = {}) {
  const o = typeof opts === 'string' ? { today: opts } : isObject(opts) ? opts : {};
  const [y, m] = ymd(cursorKey);
  const firstN = dayNumOf(y, m - 1, 1);
  const lastN = dayNumOf(y, m - 1, daysInMonth(y, m - 1));
  const gridStart = firstN - isoDow(firstN);
  const count = o.rows === 6 ? 6 : Math.ceil((lastN - gridStart + 1) / 7);
  const t = isValidKey(o.today) ? toDayNum(o.today) : null;
  const weeks = [];
  for (let w = 0; w < count; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const n = gridStart + w * 7 + i;
      const key = fromDayNum(n);
      days.push({ key, date: Number(key.slice(8)), weekday: weekdayOf(n), inMonth: n >= firstN && n <= lastN, isToday: n === t, isWeekend: i >= 5 });
    }
    const info = isoWeekInfo(days[0].key);
    weeks.push({ isoWeek: info.week, isoYear: info.year, start: days[0].key, end: days[6].key, days });
  }
  return { title: `${MONTHS_LONG[m - 1]} ${y}`, month: `${y}-${pad2(m)}`, from: weeks[0].start, to: weeks[weeks.length - 1].end, weeks };
}

/**
 * Keys a view shows -> { from, to }: month = its grid (same `rows` option as monthGrid),
 * week = Monday..Sunday, day = the cursor.
 */
export function viewRange(view, cursor, opts = {}) {
  if (view === 'day') return { from: cursor, to: cursor };
  if (view === 'week') {
    const keys = weekKeys(cursor);
    return { from: keys[0], to: keys[6] };
  }
  const g = monthGrid(cursor, opts);
  return { from: g.from, to: g.to };
}

/**
 * Move the cursor `delta` periods: days, weeks (same weekday) or months (same day of the
 * month, clamped: 31 Jan + 1 month -> 28/29 Feb). A move outside 1970..9999 keeps the cursor.
 */
export function shiftCursor(view, cursor, delta) {
  const k = Math.trunc(Number(delta)) || 0;
  if (!isValidKey(cursor) || !k) return cursor;
  let next;
  if (view === 'day') next = shiftDays(cursor, k);
  else if (view === 'week') next = shiftDays(cursor, 7 * k);
  else {
    const [y, m, d] = ymd(cursor);
    const M = y * 12 + (m - 1) + k;
    const ny = Math.floor(M / 12);
    const nm = M - ny * 12;
    next = `${String(ny).padStart(4, '0')}-${pad2(nm + 1)}-${pad2(Math.min(d, daysInMonth(ny, nm)))}`;
  }
  return isValidKey(next) ? next : cursor;
}

/**
 * Period title. Long: 'October 2026' · 'Week 41 · 5–11 Oct 2026' (or '26 Oct – 1 Nov 2026',
 * '28 Dec 2026 – 3 Jan 2027') · 'Monday 5 October 2026'.
 * { short: true }: 'Oct 2026' · 'W41 · 5–11 Oct' · 'Mon 5 Oct'.
 * { weekNumber: false }: the week title without its number: '5–11 Oct 2026' (the Simple template).
 */
export function viewTitle(view, cursor, { short = false, weekNumber = true } = {}) {
  const [y, m, d] = ymd(cursor);
  if (view === 'day') {
    const wd = weekdayOf(toDayNum(cursor));
    return short ? `${WEEKDAYS_SHORT[wd]} ${d} ${MONTHS_SHORT[m - 1]}` : `${WEEKDAYS_LONG[wd]} ${d} ${MONTHS_LONG[m - 1]} ${y}`;
  }
  if (view === 'week') {
    const keys = weekKeys(cursor);
    const [ay, am, ad] = ymd(keys[0]);
    const [by, bm, bd] = ymd(keys[6]);
    const w = isoWeek(keys[0]);
    let range;
    if (am === bm) range = `${ad}–${bd} ${MONTHS_SHORT[bm - 1]}${short ? '' : ` ${by}`}`;
    else if (ay === by || short) range = `${ad} ${MONTHS_SHORT[am - 1]} – ${bd} ${MONTHS_SHORT[bm - 1]}${short ? '' : ` ${by}`}`;
    else range = `${ad} ${MONTHS_SHORT[am - 1]} ${ay} – ${bd} ${MONTHS_SHORT[bm - 1]} ${by}`;
    if (!weekNumber) return range;
    return short ? `W${w} · ${range}` : `Week ${w} · ${range}`;
  }
  return short ? `${MONTHS_SHORT[m - 1]} ${y}` : `${MONTHS_LONG[m - 1]} ${y}`;
}

/* ==========================================================================
   Planning: tasks and habits per day
   ========================================================================== */

const rankOf = (t) => PRIORITY_RANK.get(t.priority) ?? 0;
const isTask = (t) => isObject(t) && typeof t.title === 'string';

/** Open before done, then higher priority, then title, then manual order. */
export function compareTasks(a, b) {
  return (
    Number(!!a.done) - Number(!!b.done) ||
    rankOf(b) - rankOf(a) ||
    cmpText(a.title, b.title) ||
    (Number(a.order) || 0) - (Number(b.order) || 0) ||
    cmpText(String(a.id ?? ''), String(b.id ?? ''))
  );
}

/**
 * Tasks due inside [from, to] grouped by due key -> Map(key -> tasks sorted by compareTasks),
 * keys ascending, only days that have tasks. Done tasks only with includeCompleted.
 * Options may also carry `today` (accepted for symmetry with the other planners; grouping is
 * by due date only, overdue tasks come from overdueTasks).
 */
export function tasksByDay(tasks, from, to, { includeCompleted = false } = {}) {
  const out = new Map();
  if (!Array.isArray(tasks) || !isValidKey(from) || !isValidKey(to) || to < from) return out;
  const groups = new Map();
  for (const t of tasks) {
    if (!isTask(t) || !isValidKey(t.due) || t.due < from || t.due > to) continue;
    if (t.done && !includeCompleted) continue;
    if (!groups.has(t.due)) groups.set(t.due, []);
    groups.get(t.due).push(t);
  }
  for (const key of [...groups.keys()].sort()) out.set(key, groups.get(key).sort(compareTasks));
  return out;
}

/** Open tasks due before today, oldest due first (then compareTasks). */
export function overdueTasks(tasks, today) {
  if (!Array.isArray(tasks) || !isValidKey(today)) return [];
  return tasks
    .filter((t) => isTask(t) && !t.done && isValidKey(t.due) && t.due < today)
    .sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : compareTasks(a, b)));
}

/** Open tasks without a due date (the Unscheduled tray): higher priority first, then manual order. */
export function unscheduledTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => isTask(t) && !t.done && !isValidKey(t.due))
    .sort((a, b) => rankOf(b) - rankOf(a) || (Number(a.order) || 0) - (Number(b.order) || 0) || cmpText(a.title, b.title));
}

/**
 * Habits per day for [from, to] -> Map(key -> { scheduled, bonus, done, planned, rate }) with
 * an entry for EVERY day in the range:
 * - scheduled: [{ id, name, done, status }] habits planned that day by the plan in effect
 *   THAT day (history-safe; archived habits stop on their archive date), in habit order.
 *   status: 'done' | 'pending' (today, not done) | 'miss' (past, not done) | 'future'.
 * - bonus: [{ id, name, done: true, status: 'bonus' }] check-ins on unplanned days.
 * - done / planned: scheduled habits done / planned; rate = done / planned or null.
 * Matches habits.logic dayStatus. Meant for view ranges (a few weeks).
 * Invalid keys -> empty Map.
 */
export function habitsByDay(habits, from, to, today) {
  const out = new Map();
  if (!isValidKey(from) || !isValidKey(to) || !isValidKey(today) || to < from) return out;
  const compiled = [];
  const list = (Array.isArray(habits) ? habits : [])
    .filter((h) => isObject(h) && isValidKey(h.createdAt))
    .map((h, i) => [h, i])
    .sort((a, b) => (Number(a[0].order) || 0) - (Number(b[0].order) || 0) || a[1] - b[1])
    .map(([h]) => h);
  for (const h of list) {
    try {
      compiled.push({ h, c: compileHabit(h) });
    } catch {
      // A habit with a broken plan is skipped here; the Habits module repairs it on load.
    }
  }
  const t = toDayNum(today);
  for (let n = toDayNum(from), last = toDayNum(to); n <= last; n++) {
    const key = fromDayNum(n);
    const scheduled = [];
    const bonus = [];
    let done = 0;
    for (const { h, c } of compiled) {
      const logged = n <= t && !!c.log[key];
      if (scheduledAt(c, n)) {
        if (logged) done++;
        scheduled.push({ id: h.id, name: h.name, done: logged, status: n > t ? 'future' : logged ? 'done' : n === t ? 'pending' : 'miss' });
      } else if (logged && activeAt(c, n)) {
        bonus.push({ id: h.id, name: h.name, done: true, status: 'bonus' });
      }
    }
    out.set(key, { scheduled, bonus, done, planned: scheduled.length, rate: scheduled.length ? done / scheduled.length : null });
  }
  return out;
}
