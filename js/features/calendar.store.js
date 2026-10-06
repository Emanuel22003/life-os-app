// LIFE/OS — 04 // Calendar: the calendar store and its mutations.
//
// One store (localStorage 'lifeos:v1:calendar') shared by the page, the nav badge and the
// event editor. Readers get the NORMALIZED state (other tabs or older versions may have
// written anything); every write goes through normalizeEvent / normalizeCalendar, so the
// stored value always has the documented shape. Unknown extra fields are kept.
//
// API (used by calendar.js and calendar.editor.js)
//   calendarStore                 the raw createStore('calendar', DEFAULT_STATE) instance
//   getCalendar()                 normalized { events, view, layers, ... } (memoized; treat as immutable)
//   getEvents() / getEvent(id)    normalized events / one event or null
//   saveEvent(event, { index? })  insert (append, or at `index`) or replace by id -> stored Event | null
//   removeEvent(id)               -> the removed Event (keep it for Undo) | null
//   restoreEvent(event, index)    put a removed event back at its old position (Undo) -> Event | null
//   replaceEvents(list)           replace every event (normalized) -> boolean (false: nothing changed)
//   setView(view) / setLayer(name, on) / toggleLayer(name)   persisted view + layer toggles
//   subscribeCalendar(fn)         fn(state) after any calendar change (this tab or another) -> unsubscribe
//   isNewerFormat(id)             the event holds data from a newer LIFE/OS (read-only here)
//
// Forward compatibility: an event this version can't fully represent (isForeignEvent: a repeat
// rule with an unknown frequency or extra fields, an unknown look) is shown normalized but
// written back exactly as it was stored, on every write, until this window edits it; and the
// page refuses to edit it (reload to get the newer version). So an old window left open next to
// a newer one never strips what the newer one saved, even when it only saves a zoom level.

import { createStore } from '../store.js';
import { DEFAULT_STATE, LAYERS, VIEWS, normalizeCalendar, normalizeEvent, isForeignEvent } from './calendar.logic.js';

export const calendarStore = createStore('calendar', DEFAULT_STATE);

let memo = { raw: null, state: null };
// Normalized event -> its stored original, for foreign events (see above)
const originals = new WeakMap();

/** Remember the stored original of every foreign event whose id is unambiguous. */
function trackOriginals(raw, state) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : [];
  const foreign = list.filter(isForeignEvent);
  if (!foreign.length) return;
  const seen = new Map();
  for (const e of list) if (e && typeof e.id === 'string') seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  for (const r of foreign) {
    if (typeof r.id !== 'string' || seen.get(r.id) !== 1) continue;
    const n = state.events.find((e) => e.id === r.id);
    if (n && n !== r) originals.set(n, r);
  }
}

/** Normalized store value, memoized on the raw object. */
export function getCalendar() {
  const raw = calendarStore.get();
  if (raw !== memo.raw || !memo.state) {
    const state = normalizeCalendar(raw);
    trackOriginals(raw, state);
    memo = { raw, state };
  }
  return memo.state;
}

/** What goes to storage for a normalized state: untouched foreign events as they were stored. */
function toStored(next) {
  if (!next.events.some((e) => originals.has(e))) return next;
  return { ...next, events: next.events.map((e) => originals.get(e) ?? e) };
}

function commit(next) {
  const stored = toStored(next);
  memo = { raw: stored, state: next };
  calendarStore.set(stored);
}

/** True when `id` is an event saved by a newer LIFE/OS: this window must not edit it. */
export function isNewerFormat(id) {
  const ev = getEvents().find((e) => e.id === id);
  return !!ev && originals.has(ev);
}

/** Same stored value (every key and every event identical): no write needed. */
function sameStored(a, b) {
  if (a === b) return true;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => (k === 'events' ? Array.isArray(b.events) && a.events.length === b.events.length && a.events.every((e, i) => e === b.events[i]) : a[k] === b[k]));
}

// Upgrade older / malformed stored data once, so every reader sees the same shape. Nothing is
// written when the key does not exist yet or the data is already clean (foreign events stay
// as stored, so they never count as "needs an upgrade").
try {
  if (localStorage.getItem('lifeos:v1:calendar') !== null) {
    const s = getCalendar();
    if (!sameStored(toStored(s), calendarStore.get())) commit(s);
  }
} catch {
  /* storage unavailable: readers still get normalized state */
}

export const getEvents = () => getCalendar().events;

export function getEvent(id) {
  return getEvents().find((e) => e.id === id) ?? null;
}

/** Insert or replace (matched by id). Returns the stored, normalized event, or null when it is unusable. */
export function saveEvent(event, { index } = {}) {
  const clean = normalizeEvent(event);
  if (!clean) return null;
  const s = getCalendar();
  const at = s.events.findIndex((e) => e.id === clean.id);
  let events;
  if (at >= 0) {
    if (s.events[at] === clean) return clean;
    events = s.events.slice();
    events[at] = clean;
  } else {
    events = s.events.slice();
    const i = Number.isInteger(index) ? Math.max(0, Math.min(index, events.length)) : events.length;
    events.splice(i, 0, clean);
  }
  commit({ ...s, events });
  return clean;
}

// Where removeEvent took each event from, so Undo can put it back in place
const removedAt = new WeakMap();

/** Remove an event (a whole series). Returns the removed event, or null when there is none. */
export function removeEvent(id) {
  const s = getCalendar();
  const at = s.events.findIndex((e) => e.id === id);
  if (at < 0) return null;
  const removed = s.events[at];
  commit({ ...s, events: s.events.filter((_, i) => i !== at) });
  removedAt.set(removed, at);
  return removed;
}

/** Undo of removeEvent: re-insert at the old position (or `index`). */
export function restoreEvent(event, index) {
  if (!event) return null;
  return saveEvent(event, { index: Number.isInteger(index) ? index : removedAt.get(event) });
}

/** Replace the whole event list. False when nothing changed. */
export function replaceEvents(list) {
  const s = getCalendar();
  const next = normalizeCalendar({ ...s, events: Array.isArray(list) ? list : [] });
  if (next.events.length === s.events.length && next.events.every((e, i) => e === s.events[i])) return false;
  commit(next);
  return true;
}

export function setView(view) {
  const s = getCalendar();
  if (!VIEWS.includes(view) || s.view === view) return false;
  commit({ ...s, view });
  return true;
}

export function setLayer(name, on) {
  const s = getCalendar();
  if (!LAYERS.includes(name) || typeof on !== 'boolean' || s.layers[name] === on) return false;
  commit({ ...s, layers: { ...s.layers, [name]: on } });
  return true;
}

export function toggleLayer(name) {
  return LAYERS.includes(name) ? setLayer(name, !getCalendar().layers[name]) : false;
}

/** fn(normalizedState) after every calendar change, from this tab or another. */
export function subscribeCalendar(fn) {
  return calendarStore.subscribe(() => fn(getCalendar()));
}
