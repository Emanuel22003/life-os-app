// LIFE/OS — reminders: planning, the pure part of the engine (js/reminders.js). No DOM, no
// storage and no clock of its own: everything comes in as arguments, so
// tools/tests/reminders.plan.test.js runs it in JavaScriptCore.
//
// A moment is one reminder of one item (or one date of a repeating event), ready to fire:
//   { key, at, before, sound, kind: 'task' | 'event', id, occurrence, anchor, title, location,
//     timed, time, end }
//   key         remindersFor's key (`event:<id>:<date>:<before>`; a snoozed one adds `~<at>`)
//   at          when it fires (ms); anchor: the moment it counts back from (ms)
//   occurrence  the event's date ('YYYY-MM-DD') or the task's due date
//   timed       the item has a time of day (else: all day, at the all-day time)
//   end         an event's end (ms), so a missed one stops counting once it is long over
//
// The engine keeps, on this device only (localStorage, never synced):
//   fired    { since, keys: { [key]: firedAtMs } }: what this device already showed, and since
//            when it keeps reminders (nothing from before that counts as missed)
//   snoozes  [{ key, at, base, kind, id, occurrence, before, sound }]

import { remindersFor, effectiveReminders, normalizeSettings, formatBefore, localMs } from './reminders.logic.js';
import { occurrencesInRange, occurrenceOf } from './features/calendar.logic.js';
import { dateKey, shiftKey, formatDay, diffDays } from './ui.js';

export const PLAN_DAYS = 14; // how far ahead the engine plans
export const LATE_MS = 5 * 60_000; // later than this (asleep, closed): missed, not fired
export const MISSED_WINDOW_MS = 24 * 3600_000; // a missed reminder shows for this long
export const FIRED_KEEP_MS = 30 * 24 * 3600_000; // the fired log forgets after this
export const EVENT_GRACE_MS = 3600_000; // an event over for longer than this: its missed reminders go quietly
export const SNOOZE_MINUTES = 10;
export const GROUP_AT = 4; // this many at once: one notification for all of them

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (ms) => dateKey(new Date(ms));

/** The end of an event's occurrence in ms (a timed one at its end time, an all-day one at midnight after its last day). */
function occurrenceEnd(o) {
  if (!o.allDay && o.endTime) return localMs(o.end, o.endTime);
  return localMs(shiftKey(o.end, 1), '00:00');
}

/** The moments of one event date (every reminder it has). */
function eventMoments(ev, o, s) {
  const item = { id: ev.id, start: o.start, startTime: o.startTime, allDay: o.allDay, reminders: ev.reminders };
  return remindersFor(item, 'event', s, { occurrence: o.start }).map((m) => ({
    ...m,
    kind: 'event',
    id: ev.id,
    occurrence: o.start,
    anchor: m.at + m.before * 60_000,
    title: o.title || 'Untitled event',
    location: o.location || '',
    timed: !o.allDay,
    time: o.allDay ? null : o.startTime,
    end: occurrenceEnd(o),
  }));
}

/** The moments of one task (none once it is done, or without a due date). */
function taskMoments(t, s) {
  if (!isObject(t) || t.done || t.archived || typeof t.id !== 'string' || !t.due) return [];
  return remindersFor(t, 'task', s).map((m) => ({
    ...m,
    kind: 'task',
    id: t.id,
    occurrence: t.due,
    anchor: m.at + m.before * 60_000,
    title: t.title || 'Untitled task',
    location: '',
    timed: !!(t.time && /^\d{2}:\d{2}$/.test(t.time)),
    time: t.time ?? null,
    end: null,
  }));
}

/**
 * Every moment that fires in [from, to) (ms), oldest first: tasks not done with a due date, and
 * calendar events (each date of a repeating one, its removed dates and end respected).
 * Snoozes in that window come in too, under their own keys, while their reminder still exists
 * (a task done meanwhile, a deleted event or a removed reminder drops its snooze).
 */
export function planMoments({ tasks = [], events = [], settings, snoozes = [], from, to }) {
  const s = normalizeSettings(settings);
  const out = [];
  const inWindow = (m) => m.at >= from && m.at < to;
  for (const t of Array.isArray(tasks) ? tasks : []) for (const m of taskMoments(t, s)) if (inWindow(m)) out.push(m);
  const fromKey = keyOf(from);
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isObject(ev)) continue;
    const list = effectiveReminders(ev.reminders, 'event', s);
    if (!list.length) continue;
    // The furthest reminder decides how far ahead an occurrence can be and still remind now
    const reach = Math.max(...list.map((r) => r.before)) * 60_000;
    for (const o of occurrencesInRange([ev], fromKey, keyOf(to + reach))) {
      if (o.start < fromKey) continue;
      for (const m of eventMoments(ev, o, s)) if (inWindow(m)) out.push(m);
    }
  }
  for (const sn of Array.isArray(snoozes) ? snoozes : []) {
    if (!isObject(sn) || !(sn.at >= from && sn.at < to)) continue;
    const m = snoozedMoment(sn, { tasks, events, settings: s });
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A snooze as a moment, from the item as it is now; null when its reminder is gone. */
export function snoozedMoment(sn, { tasks = [], events = [], settings } = {}) {
  const s = normalizeSettings(settings);
  let moments = [];
  if (sn.kind === 'task') {
    moments = taskMoments((tasks ?? []).find((t) => isObject(t) && t.id === sn.id), s);
  } else if (sn.kind === 'event') {
    const ev = (events ?? []).find((e) => isObject(e) && e.id === sn.id);
    const o = ev ? occurrenceOf(ev, sn.occurrence) : null;
    if (o) moments = eventMoments(ev, o, s);
  }
  const m = moments.find((x) => x.key === sn.base);
  return m ? { ...m, key: sn.key, at: sn.at, sound: typeof sn.sound === 'string' ? sn.sound : m.sound, snoozed: true } : null;
}

/** Whether a missed reminder is still worth showing: a task not done (planMoments drops done ones), an event not long over. */
export function stillRelevant(m, now) {
  if (m.kind !== 'event') return true;
  return (m.end ?? m.anchor) > now - EVENT_GRACE_MS;
}

/**
 * Whether this device already showed moment `m`: its key is in the fired log, from when it was
 * due or later. A task or event moved to a later time the same day keeps its key, but its new
 * time comes after the one that rang, so it rings again then.
 */
export function isFired(keys, m) {
  const at = isObject(keys) && Object.prototype.hasOwnProperty.call(keys, m.key) ? keys[m.key] : undefined;
  return Number.isFinite(at) && at >= m.at;
}

/**
 * What to do now with planned moments:
 *   fire    due now (at most LATE_MS late) and not fired on this device: notify + sound + banner
 *   missed  due earlier, inside the missed window, after `since`, not fired, still relevant: one
 *           calm list in the app, no burst of notifications
 *   next    when the next one is due (ms), or null
 * Nothing from before `since` (when this device started keeping reminders) counts.
 */
export function sortOut(moments, { fired = {}, now, since = 0, lateMs = LATE_MS, windowMs = MISSED_WINDOW_MS } = {}) {
  const done = isObject(fired) ? fired : {};
  const fire = [];
  const missed = [];
  let next = null;
  for (const m of moments) {
    if (isFired(done, m)) continue;
    if (m.at > now) {
      if (next === null || m.at < next) next = m.at;
      continue;
    }
    if (m.at < since) continue;
    if (m.at > now - lateMs) fire.push(m);
    else if (m.at >= now - windowMs && stillRelevant(m, now)) missed.push(m);
  }
  return { fire, missed, next };
}

/** The fired log without what is older than `keepMs` (and without anything that isn't a time). */
export function pruneFired(keys, now, keepMs = FIRED_KEEP_MS) {
  const out = {};
  if (!isObject(keys)) return out;
  for (const [k, v] of Object.entries(keys)) if (Number.isFinite(v) && v > now - keepMs) out[k] = v;
  return out;
}

/** The fired log as stored, cleaned: { since, keys } (a new device starts keeping reminders now). */
export function readFiredLog(raw, now) {
  const src = isObject(raw) ? raw : {};
  const since = Number.isFinite(src.since) && src.since <= now ? src.since : now;
  return { since, keys: pruneFired(src.keys, now) };
}

/** The reminder a snooze (or a snooze of a snooze) came from. */
export const baseKey = (key) => String(key).split('~')[0];

/**
 * Snooze a moment for `minutes` (device-only): the list with that reminder's snooze replaced.
 * Its key is the reminder's own plus `~<at>`, so it fires once, like any reminder.
 */
export function addSnooze(snoozes, m, now, minutes = SNOOZE_MINUTES) {
  const base = baseKey(m.key);
  const at = now + Math.max(1, Math.round(minutes)) * 60_000;
  const entry = { key: `${base}~${at}`, at, base, kind: m.kind, id: m.id, occurrence: m.occurrence, before: m.before, sound: m.sound ?? null };
  return [...(Array.isArray(snoozes) ? snoozes : []).filter((s) => isObject(s) && s.base !== base), entry];
}

/** Snoozes still to come or not yet fired, none older than the fired log keeps. */
export function pruneSnoozes(snoozes, fired, now, keepMs = FIRED_KEEP_MS) {
  return (Array.isArray(snoozes) ? snoozes : []).filter((s) => isObject(s) && typeof s.key === 'string' && Number.isFinite(s.at) && !isFired(fired, s) && s.at > now - keepMs);
}

/** '1 hour 30 minutes' for a span in ms (whole minutes, at least one). */
function span(ms) {
  return formatBefore(Math.max(1, Math.round(ms / 60_000))).replace(/ before$/, '');
}

/** 'Today' · 'Tomorrow' · 'Yesterday' · 'Fri 31 Oct' */
function dayWord(key, today) {
  const n = diffDays(today, key);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return formatDay(key);
}

/**
 * A notification's line under the item's name: 'In 1 hour · 14:00 · Office', 'Now · 09:00',
 * 'Tomorrow at 09:30', '5 minutes ago · 14:00', 'Due today', 'Tomorrow · all day'.
 */
export function describeMoment(m, now) {
  const today = keyOf(now);
  const day = keyOf(m.anchor);
  const parts = [];
  if (m.timed) {
    const d = m.anchor - now;
    if (Math.abs(d) < 60_000) parts.push('Now', m.time);
    else if (d > 0 && d < 2 * 3600_000) parts.push(`In ${span(d)}`, m.time);
    else if (d < 0 && d > -2 * 3600_000) parts.push(`${span(-d)} ago`, m.time);
    else parts.push(`${dayWord(day, today)} at ${m.time}`);
  } else if (m.kind === 'task') {
    const n = diffDays(today, day);
    if (n === 0) parts.push('Due today');
    else if (n === 1) parts.push('Due tomorrow');
    else if (n === -1) parts.push('Was due yesterday');
    else parts.push(`${n < 0 ? 'Was due' : 'Due'} ${formatDay(day)}`);
  } else {
    parts.push(`${dayWord(day, today)} · all day`);
  }
  if (m.location) parts.push(m.location);
  return parts.join(' · ');
}

/** Missed reminders, one per item (the latest of each), newest first, for the in-app list. */
export function missedList(moments) {
  const byItem = new Map();
  for (const m of moments) {
    const k = `${m.kind}:${m.id}:${m.occurrence}`;
    const was = byItem.get(k);
    if (!was || m.at > was.at) byItem.set(k, m);
  }
  return [...byItem.values()].sort((a, b) => b.at - a.at);
}

/**
 * How a batch due at once is shown: up to GROUP_AT - 1 of them each with its own notification;
 * more at once (a morning with many tasks due) as ONE notification that names them.
 * -> { singles: [moment], group: null | { title, body, moments } }
 */
export function groupForFiring(moments, groupAt = GROUP_AT) {
  if (moments.length < groupAt) return { singles: moments, group: null };
  const names = moments.map((m) => m.title);
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  return { singles: [], group: { title: `${moments.length} reminders`, body: rest > 0 ? `${shown} and ${rest} more` : shown, moments } };
}

/** Where a click on a reminder takes you: an event's day in the Calendar, or the task's page. */
export function targetOf(m) {
  return m.kind === 'event' ? { kind: 'event', id: m.id, day: m.occurrence } : { kind: 'task', id: m.id, day: m.occurrence };
}

/**
 * A reminder's target and action as a query the app reads on start (a notification clicked, or
 * one of its buttons, while no LIFE/OS window was open): '?reminder=open&kind=task&id=…&key=…'.
 */
export function reminderQuery({ act = 'open', kind, id, day = '', key = '' } = {}) {
  const pairs = [['reminder', act], ['kind', kind ?? ''], ['id', id ?? '']];
  if (day) pairs.push(['day', day]);
  if (key) pairs.push(['key', key]);
  return `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
}

/** reminderQuery read back: { act, kind, id, day, key } or null (not one of ours, or broken). */
export function readReminderQuery(search) {
  const q = new Map();
  for (const part of String(search ?? '').replace(/^\?/, '').split('&')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    try {
      q.set(part.slice(0, at), decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' ')));
    } catch {
      return null;
    }
  }
  const act = q.get('reminder');
  const kind = q.get('kind');
  const id = q.get('id');
  if (!['open', 'snooze', 'done'].includes(act) || !['task', 'event'].includes(kind) || !id) return null;
  const day = q.get('day') ?? '';
  return { act, kind, id, day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '', key: q.get('key') ?? '' };
}

/** The address without reminderQuery's parts (the others, like ?treat-as-real, stay). */
export function withoutReminderQuery(search) {
  const keep = String(search ?? '')
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part && !['reminder', 'kind', 'id', 'day', 'key'].includes(part.split('=')[0]));
  return keep.length ? `?${keep.join('&')}` : '';
}

export { keyOf as dayKeyOf };
