// LIFE/OS — Google Calendar: the pure parts. No DOM, network or storage, so
// tools/tests/google.test.js runs them in JavaScriptCore. js/google.js signs in and fetches;
// Settings (js/features/settings.js) connects it; the calendar and Home show what it brings.
//
// Store value (key 'google', this device only: not synced, not in backups)
//   { connected, account, calendars: [{ id, name, primary, on }], events: Event[],
//     from, to, updatedAt, show }
//   events are LIFE/OS calendar events (calendar.logic.js), one per Google event, read-only:
//   { id: 'g:…', title, allDay, start, end, startTime, endTime, location, notes, style: 'outline',
//     repeat: null, exdates: [], reminders: [], source: 'google', calendarId, link }
//   from / to: the days fetched (inclusive keys); updatedAt: when (ms), 0 = never.
//
// Google sends each date of a repeating event on its own (singleEvents), with times in any time
// zone: they become this computer's local days and times. A timed event that runs past midnight
// becomes its first evening, the whole days between (one all-day span) and its last morning, as
// a LIFE/OS timed event is one day long.

import { dateKey, shiftKey } from './ui.js';
import { isValidKey } from './features/habits.logic.js';
import { formatTime, LAST_MINUTE, TITLE_MAX, LOCATION_MAX } from './features/calendar.logic.js';

export const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const API = 'https://www.googleapis.com/calendar/v3';
export const GIS_SRC = 'https://accounts.google.com/gsi/client';
// The days fetched around today: last month and the next six
export const BEHIND = 31;
export const AHEAD = 186;
// The most a fetch covers, when a far-off month is shown too
export const MAX_SPAN = 400;
// Older than this, the events are fetched again (when Google's access is still there)
export const STALE_MS = 10 * 60 * 1000;
export const NOTES_MAX = 4000;

export const DEFAULT_GOOGLE = Object.freeze({ connected: false, account: '', calendars: Object.freeze([]), events: Object.freeze([]), from: null, to: null, updatedAt: 0, show: true });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The stored value in its documented shape (anything else: not connected). */
export function normalizeGoogle(raw) {
  if (!isObject(raw)) return { ...DEFAULT_GOOGLE };
  const calendars = Array.isArray(raw.calendars)
    ? raw.calendars.filter((c) => isObject(c) && typeof c.id === 'string' && c.id).map((c) => ({ id: c.id, name: line(c.name, TITLE_MAX) || c.id, primary: c.primary === true, on: c.on !== false }))
    : [];
  const events = Array.isArray(raw.events) ? raw.events.filter((e) => isObject(e) && typeof e.id === 'string' && e.source === 'google' && isValidKey(e.start)) : [];
  return {
    connected: raw.connected === true,
    account: typeof raw.account === 'string' ? raw.account : '',
    calendars,
    events,
    from: isValidKey(raw.from) ? raw.from : null,
    to: isValidKey(raw.to) ? raw.to : null,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    show: raw.show !== false,
  };
}

/* ---- Calendars ---- */

/**
 * The account's calendars from Google's calendarList, primary first, then by name. Each keeps the
 * choice made here before (`prev`); a new one shows when it is the primary one or ticked in
 * Google Calendar itself.
 */
export function calendarsFrom(items, prev = []) {
  const was = new Map((prev ?? []).map((c) => [c.id, c.on]));
  return (Array.isArray(items) ? items : [])
    .filter((c) => isObject(c) && typeof c.id === 'string' && c.id && c.deleted !== true)
    .map((c) => ({
      id: c.id,
      name: line(c.summaryOverride, TITLE_MAX) || line(c.summary, TITLE_MAX) || c.id,
      primary: c.primary === true,
      on: was.has(c.id) ? was.get(c.id) !== false : c.primary === true || c.selected === true,
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** The account's address: its primary calendar's id (Google names it after the address). */
export function accountOf(calendars) {
  return calendars.find((c) => c.primary)?.id ?? '';
}

/* ---- Events ---- */

/** A short, stable tag for a calendar id (ids are addresses: no '@' in event ids). */
export function calendarTag(id) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Google's description as plain text: its HTML (line breaks, links, entities) taken out. */
export function plainText(html) {
  if (typeof html !== 'string' || !html) return '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, NOTES_MAX);
}

/** The event's page in Google Calendar, when it is one (nothing else is linked). */
export function safeLink(url) {
  return typeof url === 'string' && /^https:\/\/(www|calendar)\.google\.com\/[^\s"<>]*$/.test(url) ? url : '';
}

/** A moment as this computer's local day and minute of the day. */
function localParts(date) {
  return { key: dateKey(date), min: date.getHours() * 60 + date.getMinutes() };
}

/**
 * One Google event (an events.list item) as LIFE/OS calendar events: none (cancelled, declined,
 * a working-location note, unreadable), one, or the pieces of a timed event that runs past
 * midnight. `cal` = { id } of the calendar it came from.
 */
export function eventsFrom(item, cal) {
  if (!isObject(item) || typeof item.id !== 'string' || !isObject(item.start) || !isObject(item.end)) return [];
  if (item.status === 'cancelled' || item.eventType === 'workingLocation') return [];
  if (Array.isArray(item.attendees) && item.attendees.some((a) => isObject(a) && a.self === true && a.responseStatus === 'declined')) return [];
  const base = {
    title: line(item.summary, TITLE_MAX) || '(No title)',
    location: line(item.location, LOCATION_MAX),
    notes: plainText(item.description),
    style: 'outline',
    repeat: null,
    exdates: [],
    reminders: [],
    createdAt: 0,
    updatedAt: 0,
    source: 'google',
    calendarId: cal.id,
    link: safeLink(item.htmlLink),
    recurring: typeof item.recurringEventId === 'string',
  };
  const id = `g:${calendarTag(cal.id)}:${item.id}`;
  const allDay = (start, end, part = '') => ({ ...base, id: id + part, allDay: true, start, end: end > start ? end : start, startTime: null, endTime: null });
  const timed = (day, from, to, part = '') => ({ ...base, id: id + part, allDay: false, start: day, end: day, startTime: formatTime(from), endTime: formatTime(Math.max(from + 1, to)) });

  if (isValidKey(item.start.date)) {
    // All day: Google's end date is the day after
    const end = isValidKey(item.end.date) ? shiftKey(item.end.date, -1) : item.start.date;
    return [allDay(item.start.date, end)];
  }
  const s = new Date(item.start.dateTime);
  let e = new Date(item.end.dateTime);
  if (Number.isNaN(s.getTime())) return [];
  if (Number.isNaN(e.getTime()) || e <= s) e = new Date(s.getTime() + 60000);
  const a = localParts(s);
  const b = localParts(e);
  const startMin = Math.min(a.min, LAST_MINUTE - 1);
  if (a.key === b.key) return [timed(a.key, startMin, b.min)];
  // Ends at midnight: it belongs to the day it started
  if (b.min === 0 && shiftKey(a.key, 1) === b.key) return [timed(a.key, startMin, LAST_MINUTE)];
  const out = [];
  // The whole days between: from the day after it starts (the start day itself at 00:00) to the day before it ends
  const lastFull = shiftKey(b.key, -1);
  const firstFull = a.min === 0 ? a.key : shiftKey(a.key, 1);
  if (a.min > 0) out.push(timed(a.key, startMin, LAST_MINUTE, '#1'));
  if (firstFull <= lastFull) out.push(allDay(firstFull, lastFull, '#2'));
  if (b.min > 0) out.push(timed(b.key, 0, b.min, '#3'));
  return out;
}

/** Every event of the calendars ticked here, in the store's order. */
export function shownEvents(state) {
  const on = new Set(state.calendars.filter((c) => c.on).map((c) => c.id));
  return state.events.filter((e) => on.has(e.calendarId));
}

/* ---- What to fetch, and when ---- */

/** The days fetched around `today`. */
export function windowAround(today) {
  return { from: shiftKey(today, -BEHIND), to: shiftKey(today, AHEAD) };
}

/** True when the fetched days hold [from, to]. */
export function covers(state, from, to) {
  return !!state.from && !!state.to && state.from <= from && state.to >= to;
}

/**
 * The days the next fetch covers: the usual months around today, stretched to a period being
 * looked at (`range` { from, to }, e.g. a month the calendar shows). A period far from today is
 * fetched with a month on each side instead, so one fetch never covers more than MAX_SPAN days.
 */
export function windowFor(today, range = null) {
  const usual = windowAround(today);
  if (!range || !isValidKey(range.from) || !isValidKey(range.to)) return usual;
  const from = range.from < usual.from ? range.from : usual.from;
  const to = range.to > usual.to ? range.to : usual.to;
  if (daysApart(from, to) <= MAX_SPAN) return { from, to };
  return { from: shiftKey(range.from, -BEHIND), to: shiftKey(range.to, BEHIND) };
}

function daysApart(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** The start of a local day as Google wants it (RFC 3339, in UTC). */
export function dayStartIso(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

/** True when the events are older than STALE_MS (or were never fetched). */
export function isStale(state, now = Date.now()) {
  return !state.updatedAt || now - state.updatedAt > STALE_MS;
}

/* ---- Words ---- */

/** "Updated 5 min ago" / "Updated at 14:05" / "Not updated yet". */
export function updatedText(updatedAt, now = Date.now()) {
  if (!updatedAt) return 'Not updated yet';
  const mins = Math.floor((now - updatedAt) / 60000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  const d = new Date(updatedAt);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return dateKey(d) === dateKey(new Date(now)) ? `Updated at ${time}` : `Updated ${dateKey(d)} ${time}`;
}

/** What went wrong, in words, from an error's code (js/google.js sets them). */
export const PROBLEMS = Object.freeze({
  popup_failed_to_open: 'The browser blocked Google’s window. Press the button again.',
  popup_closed: 'Google’s window was closed before it finished.',
  access_denied: 'Google wasn’t given access to the calendar.',
  scope: 'Tick “See your calendars” in Google’s window, so LIFE/OS can read them.',
  offline: 'Couldn’t reach Google. Are you online?',
  auth: 'Google asks you to sign in again.',
  http: 'Google didn’t answer as expected. Try again in a moment.',
});

export const problemText = (code) => PROBLEMS[code] ?? PROBLEMS.http;
