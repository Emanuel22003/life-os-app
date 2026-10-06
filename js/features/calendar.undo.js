// LIFE/OS — 04 // Calendar: Undo for calendar writes (the toast button and ⌘/Ctrl + Z).
//
// - undoToast(message, undo): a toast with Undo. The same undo also runs from ⌘/Ctrl + Z on the
//   Calendar page for a minute, at most once (a 6 s toast is hard to reach from the keyboard).
// - snapshot(ids) + revertEvents(before, after): put events back exactly as they were, but only
//   when none of them changed since our own write (in this window or another). Undo never
//   overwrites a newer edit: it changes nothing and says so instead.

import { toast } from '../ui.js';
import { getEvents, replaceEvents } from './calendar.store.js';

const UNDO_MS = 60000;
let last = null; // { run, expires }

/** Toast with an Undo button; `undo()` returns false when it refused (it toasts why itself). */
export function undoToast(message, undo) {
  let used = false;
  const run = () => {
    if (used) return false;
    used = true;
    if (last?.run === run) last = null;
    return undo() !== false;
  };
  last = { run, expires: Date.now() + UNDO_MS };
  toast(message, { action: { label: 'Undo', onClick: run } });
}

/** ⌘/Ctrl + Z: run the latest calendar Undo if it is recent. False when there is none. */
export function undoLast() {
  if (!last || Date.now() > last.expires) {
    last = null;
    return false;
  }
  if (last.run()) toast('Undone');
  return true;
}

/** The events with these ids as stored now (null: no such event), plus their positions. */
export function snapshot(ids) {
  const list = getEvents();
  const events = new Map();
  const index = new Map();
  for (const id of ids) {
    const at = list.findIndex((e) => e.id === id);
    events.set(id, at >= 0 ? list[at] : null);
    if (at >= 0) index.set(id, at);
  }
  return { events, index };
}

const fingerprint = (e) => (e ? JSON.stringify(e) : null);

/**
 * Undo of a write: `before` = snapshot(ids) taken before it, `after` = snapshot(ids) right after.
 * Restores `before` in one store write when every one of those events still equals `after`;
 * otherwise writes nothing, toasts, and returns false.
 */
export function revertEvents(before, after, what = 'the event') {
  const now = getEvents();
  for (const [id, wrote] of after.events) {
    const cur = now.find((e) => e.id === id) ?? null;
    if (fingerprint(cur) !== fingerprint(wrote)) {
      toast(`Nothing undone: ${what} changed since.`);
      return false;
    }
  }
  const list = [...now];
  for (const [id, old] of before.events) {
    const at = list.findIndex((e) => e.id === id);
    if (!old) {
      if (at >= 0) list.splice(at, 1);
    } else if (at >= 0) {
      list[at] = old;
    } else {
      list.splice(Math.min(before.index.get(id) ?? list.length, list.length), 0, old);
    }
  }
  replaceEvents(list);
  return true;
}
