// LIFE/OS — the right-click menu: pure helpers (no DOM, no storage), used by js/contextmenu.js
// and the feature modules' menu providers. Tested in tools/tests/contextmenu.test.js.
//
// - menuPosition()      where the menu goes: at the pointer, flipped near the right / bottom edge,
//                       always inside the viewport
// - stepIndex()         arrow keys / Home / End over the menu items, skipping disabled ones
// - actionForKey()      ⌘/Ctrl + C · V · D and Delete / Backspace -> the menu action they stand for
// - makeClip() / readClip() / pasteMode()   the in-app clipboard and what a paste target does with it
// - clipText() / eventText()                the plain-text version written to the system clipboard
// - splitText()         pasted plain text -> a title line and the rest
// - copyName() / pasteName()                "Run (copy)", "Run (copy 2)" …
// - insertAfter()       a new item right after another one, by id

export const ACTIONS = Object.freeze(['copy', 'paste', 'delete', 'duplicate']);
export const KINDS = Object.freeze(['task', 'note', 'habit', 'event', 'subscription']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);

/* ==========================================================================
   Placement
   ========================================================================== */

/** One axis: `start` (the pointer) if the menu fits after it, else ending at `alt`, else pinned inside. */
function place(start, alt, size, view, margin) {
  const max = view - margin;
  if (size >= view - 2 * margin) return { pos: margin, flipped: false };
  if (start + size <= max) return { pos: Math.max(margin, start), flipped: false };
  if (alt - size >= margin) return { pos: Math.min(alt, max) - size, flipped: true };
  return { pos: Math.max(margin, max - size), flipped: true };
}

/**
 * Where the menu's top-left corner goes, in viewport pixels.
 *   x, y          the pointer (or the anchor's bottom-left for a keyboard open)
 *   width, height the menu's size
 *   viewW, viewH  the viewport
 *   altX, altY    where the menu ENDS when it flips (default: the pointer itself; for an anchor
 *                 element, its right / top edge, so a flipped menu never covers it)
 * -> { left, top, flipX, flipY }
 */
export function menuPosition({ x, y, width, height, viewW, viewH, margin = 8, altX = x, altY = y } = {}) {
  const w = Math.max(0, finite(width));
  const hgt = Math.max(0, finite(height));
  const h = place(finite(x), finite(altX, finite(x)), w, finite(viewW), margin);
  const v = place(finite(y), finite(altY, finite(y)), hgt, finite(viewH), margin);
  return { left: Math.round(h.pos), top: Math.round(v.pos), flipX: h.flipped, flipY: v.flipped };
}

/* ==========================================================================
   Keyboard
   ========================================================================== */

/**
 * The item to focus after `key`: ArrowDown / ArrowUp move to the next / previous enabled item
 * (wrapping), Home / End to the first / last. `from` is the focused index (-1: none yet).
 * -> index, or -1 when no item is enabled (or the key isn't a navigation key).
 */
export function stepIndex(enabled, from, key) {
  const list = Array.isArray(enabled) ? enabled : [];
  const n = list.length;
  if (!n || !list.some(Boolean)) return -1;
  if (key === 'Home') return list.findIndex(Boolean);
  if (key === 'End') {
    for (let i = n - 1; i >= 0; i--) if (list[i]) return i;
    return -1;
  }
  const d = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!d) return -1;
  let i = Number.isInteger(from) && from >= 0 && from < n ? from : d > 0 ? -1 : n;
  for (let step = 0; step < n; step++) {
    i = (i + d + n) % n;
    if (list[i]) return i;
  }
  return -1;
}

/** The menu's shortcut hints: ⌘C ⌘V ⌫ ⌘D on a Mac, Ctrl+C … elsewhere. */
export function shortcutLabels(mac) {
  return mac
    ? { copy: '⌘C', paste: '⌘V', delete: '⌫', duplicate: '⌘D' }
    : { copy: 'Ctrl+C', paste: 'Ctrl+V', delete: 'Del', duplicate: 'Ctrl+D' };
}

/**
 * The menu action a key press stands for: ⌘C / ⌘V / ⌘D (Ctrl on other systems) and Delete /
 * Backspace without modifiers. -> 'copy' | 'paste' | 'duplicate' | 'delete' | null
 */
export function actionForKey(e, mac) {
  if (!e || typeof e.key !== 'string') return null;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod && !e.altKey && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'c') return 'copy';
    if (k === 'v') return 'paste';
    if (k === 'd') return 'duplicate';
    return null;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) return 'delete';
  return null;
}

/** The ContextMenu key or Shift + F10: open the menu for the focused item. */
export function isMenuKey(e) {
  return !!e && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey));
}

/* ==========================================================================
   Clipboard
   ========================================================================== */

export const TEXT_MAX = 20000;

/** A clipboard entry { kind, snapshot, text, at }, or null when `kind` / `snapshot` are unusable. */
export function makeClip(kind, snapshot, text = '', at = Date.now()) {
  if (!KINDS.includes(kind) || !isObject(snapshot)) return null;
  return { kind, snapshot, text: typeof text === 'string' ? text.slice(0, TEXT_MAX) : '', at: finite(at) };
}

/** A clipboard entry read back from storage (anything may be there) -> a valid entry or null. */
export function readClip(raw) {
  if (!isObject(raw)) return null;
  return makeClip(raw.kind, raw.snapshot, raw.text, raw.at);
}

/**
 * What a paste target does with the clipboard:
 *   'item'  the in-app copy (its kind is one the target `accepts`)
 *   'text'  plain text from the system clipboard (targets that take text: Tasks, Notes)
 *   null    nothing to paste here (Paste is greyed out)
 */
export function pasteMode(clip, { accepts = [], text = false } = {}) {
  if (clip && Array.isArray(accepts) && accepts.includes(clip.kind)) return 'item';
  return text ? 'text' : null;
}

/** Same text, give or take line endings and the whitespace around it. */
export function sameText(a, b) {
  const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
  return norm(a) === norm(b);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'Tue 6 Oct 2026' for '2026-10-06'; '' for anything else. */
export function dayText(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) return '';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 'Dentist — Tue 6 Oct 2026, 09:00–10:00' · 'Trip — Tue 6 Oct 2026 – Thu 8 Oct 2026' · 'Gym — Tue 6 Oct 2026'. */
export function eventText({ title, start, end, allDay, startTime, endTime } = {}) {
  const name = String(title ?? '').trim() || 'Untitled event';
  const from = dayText(start);
  if (!from) return name;
  let when = from;
  if (!allDay && startTime) when += `, ${startTime}${endTime ? `–${endTime}` : ''}`;
  else if (end && end > start && dayText(end)) when += ` – ${dayText(end)}`;
  return `${name} — ${when}`;
}

/** The plain-text version of a copied item, for the system clipboard. */
export function clipText(kind, snapshot) {
  const s = isObject(snapshot) ? snapshot : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  switch (kind) {
    case 'task':
      return str(s.title).trim();
    case 'habit':
      return str(s.name).trim();
    case 'note':
      return [str(s.title).trim(), str(s.body).trim()].filter(Boolean).join('\n\n');
    case 'event':
      return eventText(isObject(s.occurrence) ? { ...s.event, ...s.occurrence } : s.event);
    default:
      return '';
  }
}

/**
 * Pasted plain text -> { title, rest }: the first non-empty line is the title and the lines after
 * it the rest. A first line longer than `max` is cut for the title and the whole text kept in
 * `rest`, so nothing pasted is lost. Empty text -> { title: '', rest: '' }.
 */
export function splitText(text, max = 200) {
  const all = String(text ?? '').replace(/\r\n?/g, '\n').slice(0, TEXT_MAX).trim();
  if (!all) return { title: '', rest: '' };
  const lines = all.split('\n');
  const i = lines.findIndex((l) => l.trim());
  const first = lines[i].replace(/\s+/g, ' ').trim();
  if (first.length > max) return { title: `${first.slice(0, max - 1).trimEnd()}…`, rest: all };
  return { title: first, rest: lines.slice(i + 1).join('\n').trim() };
}

/* ==========================================================================
   Names and positions
   ========================================================================== */

const COPY_SUFFIX = / \(copy(?: (\d+))?\)$/;
const key = (s) => String(s ?? '').trim().toLowerCase();

/**
 * The name of a duplicate: 'Run' -> 'Run (copy)', then 'Run (copy 2)' … whichever is not in
 * `taken` (case-insensitive). Duplicating 'Run (copy)' gives 'Run (copy 2)', not
 * 'Run (copy) (copy)'. The base is shortened so the result fits `max`; an empty name uses
 * `fallback` ('Untitled').
 */
export function copyName(name, taken = [], { max = Infinity, fallback = 'Untitled' } = {}) {
  const raw = String(name ?? '').replace(/\s+/g, ' ').trim() || fallback;
  const base = raw.replace(COPY_SUFFIX, '').trim() || raw;
  const used = new Set((Array.isArray(taken) ? taken : []).map(key));
  for (let n = 1; n < 10000; n++) {
    const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
    const room = Math.max(1, max - suffix.length);
    const candidate = `${base.length > room ? base.slice(0, room).trimEnd() : base}${suffix}`;
    if (!used.has(key(candidate))) return candidate;
  }
  return `${base} (copy)`;
}

/** The name of a pasted copy: unchanged, unless that name is already taken there (then as copyName). */
export function pasteName(name, taken = [], opts = {}) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const used = new Set((Array.isArray(taken) ? taken : []).map(key));
  const max = opts.max ?? Infinity;
  const fitted = clean.length > max ? clean.slice(0, max).trimEnd() : clean;
  return used.has(key(fitted)) ? copyName(fitted, taken, opts) : fitted;
}

/**
 * A new list with `item` right after the element whose id is `afterId`. Without such an element
 * it goes first (`fallback: 'start'`) or last ('end'). The input list is never changed.
 */
export function insertAfter(list, item, afterId, { fallback = 'end' } = {}) {
  const src = Array.isArray(list) ? list : [];
  const at = afterId == null ? -1 : src.findIndex((x) => x && x.id === afterId);
  if (at >= 0) return [...src.slice(0, at + 1), item, ...src.slice(at + 1)];
  return fallback === 'start' ? [item, ...src] : [...src, item];
}

/** Floor a minute of the day to the grid step; the last slot starts one step before midnight. */
export function slotMinute(minute, step = 15, dayMinutes = 1440) {
  const m = Math.max(0, Math.min(dayMinutes - 1, finite(minute)));
  return Math.min(Math.floor(m / step) * step, dayMinutes - step);
}
