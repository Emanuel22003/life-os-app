// LIFE/OS — reminders: the pure rules (no DOM, tested in tools/tests/reminders.test.js).
//
// A reminder is "this long before the moment": { id, before, sound }
//   before  minutes before the item's moment (0 = at the moment), whole minutes, at most a year
//   sound   one of SOUNDS (its id), or null = the default sound from Settings → Reminders
//
// On an item (a calendar event or a task) the list sits in `reminders`:
//   undefined / null  follow the defaults for that kind of item (Settings → Reminders)
//   []                no reminders for this item
//   [ … ]             these, sorted soonest-to-the-moment last (largest `before` first), at most
//                     MAX_REMINDERS, one per `before`
//
// The moment a reminder counts back from (anchorMs):
//   an event with a time        its start date + start time
//   an all-day event            its start date at the all-day time (Settings, default 09:00)
//   a task with a time          its due date + time
//   a task with only a date     its due date at the all-day time
//   a task without a due date   none: it has nothing to be reminded of
//
// Planning which moments come next, what was missed and snoozes is js/reminders.plan.js; firing
// them (notifications, sounds, the in-app banner) is js/reminders.js; the editor is
// js/reminders.ui.js.
//
// The settings (`settings.reminders`, device-only like the rest of the settings store):
//   { on, sound, allDayTime, event, timedTask, dateTask }
//   on          reminders on this device at all
//   sound       the default sound
//   allDayTime  'HH:MM' for items without a time
//   event / timedTask / dateTask   the default reminder lists ([{ before, sound }]) per kind

export const MAX_REMINDERS = 10;
export const MAX_BEFORE = 365 * 24 * 60; // a year, in minutes

/** The quick choices, in minutes before the moment. */
export const REMINDER_PRESETS = Object.freeze([0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]);

/** The sounds a reminder can play (drawn with Web Audio by js/sounds.js; 'none' = silent). */
export const SOUNDS = Object.freeze([
  Object.freeze({ id: 'chime', label: 'Chime' }),
  Object.freeze({ id: 'bell', label: 'Bell' }),
  Object.freeze({ id: 'digital', label: 'Digital' }),
  Object.freeze({ id: 'soft', label: 'Soft' }),
  Object.freeze({ id: 'alarm', label: 'Alarm' }),
  Object.freeze({ id: 'none', label: 'Silent' }),
]);
const SOUND_IDS = new Set(SOUNDS.map((s) => s.id));

/** The units a custom reminder can be typed in, in minutes. */
export const UNITS = Object.freeze([
  Object.freeze({ id: 'minutes', label: 'minutes', one: 'minute', min: 1 }),
  Object.freeze({ id: 'hours', label: 'hours', one: 'hour', min: 60 }),
  Object.freeze({ id: 'days', label: 'days', one: 'day', min: 1440 }),
  Object.freeze({ id: 'weeks', label: 'weeks', one: 'week', min: 10080 }),
]);

export const DEFAULT_SETTINGS = Object.freeze({
  on: true,
  sound: 'chime',
  allDayTime: '09:00',
  event: Object.freeze([Object.freeze({ before: 15, sound: null })]),
  timedTask: Object.freeze([Object.freeze({ before: 0, sound: null })]),
  dateTask: Object.freeze([Object.freeze({ before: 0, sound: null })]),
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let seq = 0;
const makeId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A sound id, or null (= the default sound). */
export function cleanSound(value) {
  return typeof value === 'string' && SOUND_IDS.has(value) ? value : null;
}

/** One reminder, cleaned; null when it can't be one. */
export function normalizeReminder(raw, { id = makeId } = {}) {
  const before = typeof raw === 'number' ? raw : isObject(raw) ? Number(raw.before) : NaN;
  if (!Number.isFinite(before) || before < 0) return null;
  const minutes = Math.min(MAX_BEFORE, Math.round(before));
  const keepId = isObject(raw) && typeof raw.id === 'string' && raw.id ? raw.id : id();
  return { id: keepId, before: minutes, sound: isObject(raw) ? cleanSound(raw.sound) : null };
}

/**
 * An item's reminder list: null (follow the defaults) stays null; anything else becomes a clean
 * list, one per `before` (the later one wins), largest `before` first, at most MAX_REMINDERS.
 */
export function normalizeReminders(list, opts) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return null;
  const byBefore = new Map();
  for (const raw of list) {
    const r = normalizeReminder(raw, opts);
    if (r) byBefore.set(r.before, r);
  }
  return [...byBefore.values()].sort((a, b) => b.before - a.before).slice(0, MAX_REMINDERS);
}

/**
 * An item's stored list, cleaned for saving (normalizeTask in tasks.logic.js, normalizeEvent in
 * calendar.logic.js). undefined / null stay as they are (follow the defaults), and so does a value
 * that isn't a list (a newer version's shape: kept, read as the defaults here). A list becomes
 * normalizeReminders' list, except that a reminder without an id gets a stable one (`r<before>`,
 * so cleaning twice gives the same list), a sound this version doesn't know is kept (it plays the
 * default sound here) and fields a newer version added to a reminder stay.
 */
export function cleanItemReminders(list) {
  if (!Array.isArray(list)) return list;
  const byBefore = new Map();
  for (const raw of list) {
    const r = normalizeReminder(raw, { id: () => '' });
    if (!r) continue;
    const id = r.id || `r${r.before}`;
    const sound = isObject(raw) && typeof raw.sound === 'string' && raw.sound ? raw.sound : null;
    const { id: _i, before: _b, sound: _s, ...extra } = isObject(raw) ? raw : {};
    byBefore.set(r.before, { id, before: r.before, sound, ...extra });
  }
  return [...byBefore.values()].sort((a, b) => b.before - a.before).slice(0, MAX_REMINDERS);
}

/** Same stored reminder list (cleanItemReminders' output compared with what was stored). */
export function sameReminders(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True when an item has reminders of its own (the quiet bell on rows, chips and the agenda). */
export function hasOwnReminders(item) {
  return isObject(item) && Array.isArray(item.reminders) && item.reminders.some((r) => normalizeReminder(r, { id: () => 'x' }));
}

/** '1 day before, at the time': a list's times in words, largest first. */
export function listBefore(list) {
  return list.map((r, i) => (i ? formatBefore(r.before).replace(/^At/, 'at') : formatBefore(r.before))).join(', ');
}

/** 'Default: 15 minutes before' · '1 day before, 1 hour before' · 'No reminders' (for a chip or a row). */
export function remindersSummary(itemReminders, kind, settings) {
  const own = normalizeReminders(itemReminders);
  const list = own ?? effectiveReminders(null, kind, settings);
  const words = list.length ? listBefore(list) : 'No reminders';
  if (own) return own.length ? words : 'No reminders';
  return `Default: ${list.length ? words : 'none'}`;
}

/** settings.reminders, cleaned (missing or broken parts fall back to DEFAULT_SETTINGS). */
export function normalizeSettings(raw) {
  const s = isObject(raw) ? raw : {};
  const list = (v, d) => {
    const out = normalizeReminders(v, { id: () => 'd' });
    return (out ?? d).map((r) => ({ before: r.before, sound: r.sound ?? null }));
  };
  return {
    on: typeof s.on === 'boolean' ? s.on : DEFAULT_SETTINGS.on,
    sound: cleanSound(s.sound) ?? DEFAULT_SETTINGS.sound,
    allDayTime: typeof s.allDayTime === 'string' && TIME_RE.test(s.allDayTime) ? s.allDayTime : DEFAULT_SETTINGS.allDayTime,
    event: list(s.event, DEFAULT_SETTINGS.event),
    timedTask: list(s.timedTask, DEFAULT_SETTINGS.timedTask),
    dateTask: list(s.dateTask, DEFAULT_SETTINGS.dateTask),
  };
}

/** The reminders that apply to an item: its own list, or the defaults for its kind. */
export function effectiveReminders(itemReminders, kind, settings) {
  const s = normalizeSettings(settings);
  const own = normalizeReminders(itemReminders);
  if (own) return own;
  const defaults = kind === 'event' ? s.event : kind === 'timedTask' ? s.timedTask : s.dateTask;
  return defaults.map((r, i) => ({ id: `default-${i}`, before: r.before, sound: r.sound }));
}

/** 'minutes' | 'hours' | 'days' | 'weeks' and a count, for the custom field (largest whole unit). */
export function splitBefore(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m === 0) return { n: 0, unit: 'minutes' };
  for (const u of [...UNITS].reverse()) if (m % u.min === 0) return { n: m / u.min, unit: u.id };
  return { n: m, unit: 'minutes' };
}

/** A count in a unit, in minutes (null when not a usable number). */
export function joinBefore(n, unit) {
  const u = UNITS.find((x) => x.id === unit);
  const count = Number(n);
  if (!u || !Number.isFinite(count) || count < 0) return null;
  return Math.min(MAX_BEFORE, Math.round(count * u.min));
}

/** '1 hour before', '2 days before', 'At the time', '1 hour 30 minutes before'. */
export function formatBefore(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m === 0) return 'At the time';
  const parts = [];
  let rest = m;
  for (const u of [...UNITS].reverse()) {
    if (rest >= u.min) {
      const n = Math.floor(rest / u.min);
      rest -= n * u.min;
      parts.push(`${n} ${n === 1 ? u.one : u.label}`);
    }
    if (parts.length === 2) break;
  }
  return `${parts.join(' ')} before`;
}

/** A sound's name ('Default (Chime)' for null). */
export function soundLabel(id, defaultId = DEFAULT_SETTINGS.sound) {
  const found = SOUNDS.find((s) => s.id === id);
  if (found) return found.label;
  const d = SOUNDS.find((s) => s.id === defaultId) ?? SOUNDS[0];
  return `Default (${d.label})`;
}

/** Local time in ms for a date key ('YYYY-MM-DD') and 'HH:MM'; null when either is malformed. */
export function localMs(dateKey, time) {
  if (typeof dateKey !== 'string' || !DATE_RE.test(dateKey) || typeof time !== 'string' || !TIME_RE.test(time)) return null;
  const [y, mo, d] = dateKey.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  // Reject dates that rolled over (31 Feb)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/**
 * The moment a reminder counts back from, and the kind of defaults that apply.
 * item: an event occurrence ({ start, startTime, allDay }) or a task ({ due, time }).
 * Returns { at, kind } or null (a task without a due date, broken dates).
 */
export function anchorOf(item, type, settings) {
  const s = normalizeSettings(settings);
  if (!isObject(item)) return null;
  if (type === 'event') {
    const timed = !item.allDay && typeof item.startTime === 'string' && TIME_RE.test(item.startTime);
    const at = localMs(item.start, timed ? item.startTime : s.allDayTime);
    return at === null ? null : { at, kind: 'event' };
  }
  if (type === 'task') {
    if (!item.due) return null;
    const timed = typeof item.time === 'string' && TIME_RE.test(item.time);
    const at = localMs(item.due, timed ? item.time : s.allDayTime);
    return at === null ? null : { at, kind: timed ? 'timedTask' : 'dateTask' };
  }
  return null;
}

/**
 * The reminders of one item (or one occurrence) as moments to fire:
 * [{ key, at, before, sound }] with `sound` resolved (never null), oldest first.
 * key = `${type}:${id}:${occurrence}:${before}` — the same reminder always gets the same key, so
 * a device fires it once (js/reminders.js keeps the keys it fired).
 */
export function remindersFor(item, type, settings, { occurrence = '' } = {}) {
  const s = normalizeSettings(settings);
  const anchor = anchorOf(item, type, s);
  if (!anchor) return [];
  const list = effectiveReminders(item.reminders, anchor.kind, s);
  const occ = occurrence || (type === 'event' ? item.start : item.due) || '';
  return list
    .map((r) => ({
      key: `${type}:${item.id}:${occ}:${r.before}`,
      at: anchor.at - r.before * 60_000,
      before: r.before,
      sound: r.sound ?? s.sound,
    }))
    .sort((a, b) => a.at - b.at);
}

/** The moments due in [from, to) from a list built with remindersFor (oldest first). */
export function dueBetween(moments, from, to) {
  return moments.filter((m) => m.at >= from && m.at < to).sort((a, b) => a.at - b.at);
}
