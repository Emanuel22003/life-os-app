// LIFE/OS — Diary, the pure parts: one entry a day (its id is its date, so two devices writing
// the same day merge into one entry in a sync), counts, the streak and the search. No DOM or
// storage, so tools/tests/diary.test.js runs them in JavaScriptCore.
//
// Store 'diary': { entries: [{ id, date, body, createdAt, updatedAt }], view: { day } }
// - entries: newest day first, one per date, never an empty one (clearing a day's text removes it)
// - view.day: the day open on this device (null: today); it doesn't sync

export const BODY_MAX = 100_000;
export const DEFAULT_VIEW = Object.freeze({ day: null });
export const DEFAULT_STATE = Object.freeze({ entries: Object.freeze([]), view: DEFAULT_VIEW });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (v) => (Number.isFinite(v) ? v : 0);

/** A real calendar day 'YYYY-MM-DD'. */
export function isDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Nothing but spaces and line breaks. */
export const isBlank = (text) => typeof text !== 'string' || !text.trim();

/** One entry as stored, or null (no valid day, or nothing written). */
export function normalizeEntry(raw) {
  if (!isObject(raw)) return null;
  const date = isDay(raw.date) ? raw.date : isDay(raw.id) ? raw.id : null;
  if (!date || isBlank(raw.body)) return null;
  const body = raw.body.length > BODY_MAX ? raw.body.slice(0, BODY_MAX) : raw.body;
  const createdAt = time(raw.createdAt) || time(raw.updatedAt);
  return { id: date, date, body, createdAt, updatedAt: Math.max(time(raw.updatedAt), createdAt) };
}

/** Two entries for one day (from an old copy, a hand edit): both texts kept, older first. */
function joinSameDay(a, b) {
  if (a.body.trim() === b.body.trim()) return a.updatedAt >= b.updatedAt ? a : b;
  const [first, second] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
  return {
    ...first,
    body: `${first.body.replace(/\s+$/, '')}\n\n${second.body.replace(/^\s+/, '')}`.slice(0, BODY_MAX),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

export function normalizeView(raw) {
  return { day: isObject(raw) && isDay(raw.day) ? raw.day : null };
}

export function normalizeState(raw) {
  const src = isObject(raw) ? raw : {};
  const byDay = new Map();
  for (const item of Array.isArray(src.entries) ? src.entries : []) {
    const e = normalizeEntry(item);
    if (!e) continue;
    byDay.set(e.date, byDay.has(e.date) ? joinSameDay(byDay.get(e.date), e) : e);
  }
  const entries = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { ...src, entries, view: normalizeView(src.view) };
}

/** The entry of `date`, or null. */
export function entryFor(state, date) {
  return state.entries.find((e) => e.date === date) ?? null;
}

/**
 * `date`'s text set to `body` (blank: the day's entry goes). -> the new state, or `state` itself
 * when nothing changed.
 */
export function setEntry(state, date, body, now) {
  if (!isDay(date)) return state;
  const text = typeof body === 'string' ? body.slice(0, BODY_MAX) : '';
  const cur = entryFor(state, date);
  if (isBlank(text)) return cur ? { ...state, entries: state.entries.filter((e) => e.date !== date) } : state;
  if (cur && cur.body === text) return state;
  const next = cur ? { ...cur, body: text, updatedAt: now } : { id: date, date, body: text, createdAt: now, updatedAt: now };
  const others = state.entries.filter((e) => e.date !== date);
  const at = others.findIndex((e) => e.date < date);
  others.splice(at === -1 ? others.length : at, 0, next);
  return { ...state, entries: others };
}

/** Put a removed entry back (Undo). */
export function restoreEntry(state, entry) {
  const e = normalizeEntry(entry);
  if (!e || entryFor(state, e.date)) return state;
  return normalizeState({ ...state, entries: [...state.entries, e] });
}

/** Words in a text ('it's' is one, '—' none). */
export function wordCount(text) {
  if (typeof text !== 'string') return 0;
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** The start of an entry on one line, cut at a word near `max` characters. */
export function preview(body, max = 120) {
  const line = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?–—-]+$/, '')}…`;
}

const dayNumber = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/**
 * Days written in a row, up to today: today counts once it's written, and an unwritten today
 * doesn't break yesterday's run (the day isn't over yet).
 */
export function streak(entries, today) {
  if (!isDay(today)) return 0;
  const days = new Set(entries.map((e) => dayNumber(e.date)));
  let at = dayNumber(today);
  if (!days.has(at)) at -= 1;
  let n = 0;
  while (days.has(at)) {
    n++;
    at -= 1;
  }
  return n;
}

/** The page's line beside the title: '' before the first entry. */
export function statusText(state, today) {
  const n = state.entries.length;
  if (!n) return '';
  const run = streak(state.entries, today);
  const written = entryFor(state, today) ? 'Written today' : 'Not written today yet';
  const days = `${n.toLocaleString('en')} ${n === 1 ? 'day' : 'days'} written`;
  return run >= 2 ? `${written} · ${run} days in a row` : `${written} · ${days}`;
}

/** Lowercase, without accents, so 'cafe' finds 'Café'. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** The entries that hold every word of `query` (in any order), newest first. */
export function searchEntries(entries, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((e) => {
    const text = fold(e.body);
    return words.every((w) => text.includes(w));
  });
}

/** Where the first word of `query` is in `body`, with some text around it, for a search result. */
export function searchSnippet(body, query, around = 60) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!words.length) return preview(flat, around * 2);
  const at = fold(flat).indexOf(words[0]);
  if (at === -1) return preview(flat, around * 2);
  let from = Math.max(0, at - around);
  let to = Math.min(flat.length, at + words[0].length + around);
  // Whole words at both ends
  if (from > 0) from = flat.indexOf(' ', from) + 1 || at;
  if (to < flat.length) to = Math.max(flat.lastIndexOf(' ', to), at + words[0].length);
  return `${from > 0 ? '…' : ''}${flat.slice(Math.min(from, at), to).trim()}${to < flat.length ? '…' : ''}`;
}
