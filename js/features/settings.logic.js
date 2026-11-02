// LIFE/OS — Settings: the pure parts (backup files, start page, version compare, the page's
// search). DOM-free, so tools/tests/settings.test.js runs them in JavaScriptCore.

import { countData } from '../sync.logic.js';
import { fold, normalize, queryTerms, scoreEntry, mergeRanges } from '../command.logic.js';

export const BACKUP_FORMAT = 1;
const DATA_PREFIX = 'lifeos:v1:';

// Copies of someone else's data, fetched again when needed: Google Calendar's events (js/google.js)
const CACHE_KEYS = Object.freeze(['lifeos:v1:google']);

/**
 * A key that belongs in a backup: app data and preferences, never the sync key, older backups or
 * Google Calendar's copied events (they stay in Google; a device fetches its own).
 */
export const isDataKey = (key) => typeof key === 'string' && key.startsWith(DATA_PREFIX) && key.length > DATA_PREFIX.length && !CACHE_KEYS.includes(key);

/**
 * A backup file's content from [[key, rawValue]] pairs as localStorage holds them. Values that are
 * JSON go in as JSON (readable, and diffable in a text editor); anything else as its text.
 */
export function buildBackup(pairs, { version = '', now = Date.now() } = {}) {
  const data = {};
  for (const [key, raw] of pairs) {
    if (!isDataKey(key) || typeof raw !== 'string') continue;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw;
    }
  }
  return { app: 'LIFE/OS', format: BACKUP_FORMAT, version, exportedAt: new Date(now).toISOString(), data };
}

/**
 * Read a backup file's text -> { pairs: [[key, rawValue]], exportedAt, version, counts } or
 * { error: 'not-json' | 'not-lifeos' | 'newer' | 'empty' }. Also takes the older console backup
 * from the README: a plain object of 'lifeos:…' keys with string values.
 */
export function parseBackup(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch {
    return { error: 'not-json' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'not-lifeos' };

  let entries;
  let meta = {};
  if (doc.app === 'LIFE/OS') {
    if (Number.isFinite(doc.format) && doc.format > BACKUP_FORMAT) return { error: 'newer' };
    if (!doc.data || typeof doc.data !== 'object' || Array.isArray(doc.data)) return { error: 'not-lifeos' };
    entries = Object.entries(doc.data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
    meta = { exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : null, version: typeof doc.version === 'string' ? doc.version : null };
  } else if (Object.keys(doc).some((k) => k.startsWith('lifeos:'))) {
    entries = Object.entries(doc).filter(([, v]) => typeof v === 'string');
  } else {
    return { error: 'not-lifeos' };
  }

  const pairs = entries.filter(([k, v]) => isDataKey(k) && typeof v === 'string');
  if (!pairs.length) return { error: 'empty' };
  const docs = {};
  for (const [k, v] of pairs) {
    try {
      docs[k.slice(DATA_PREFIX.length)] = JSON.parse(v);
    } catch {}
  }
  return { pairs, exportedAt: meta.exportedAt ?? null, version: meta.version ?? null, counts: countData(docs) };
}

/** 'life-os-backup-2026-10-07.json' (the local date) */
export function backupFileName(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `life-os-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** The start page to open: the saved one when it is a page that exists, else the first. */
export function startPage(saved, pageIds) {
  return typeof saved === 'string' && pageIds.includes(saved) ? saved : pageIds[0];
}

/**
 * The page's sections, in order: the cards and the index beside them (a jump menu on narrower
 * screens). "Delete all my data" stays under Sync & backup: the privacy policy and the cookies
 * page (legal/) send people there by that path.
 */
export const SETTINGS_SECTIONS = Object.freeze(
  [
    { id: 'appearance', title: 'Appearance', icon: 'palette' },
    { id: 'formats', title: 'Dates & units', icon: 'calendar' },
    { id: 'colors', title: 'Color coding', icon: 'tag' },
    { id: 'sound', title: 'Sound & notifications', icon: 'volume' },
    { id: 'reminders', title: 'Reminders', icon: 'bell' },
    { id: 'startup', title: 'Start-up', icon: 'home' },
    { id: 'google', title: 'Google Calendar', icon: 'calendar' },
    { id: 'sync', title: 'Sync & backup', icon: 'sync' },
    { id: 'about', title: 'About', icon: 'tip' },
    { id: 'legal', title: 'Legal', icon: 'note' },
  ].map((s) => Object.freeze(s)),
);

/**
 * The section the index marks while the page scrolls: the last one whose top has reached `line`
 * (px below the top of the visible area), else the first. Scrolled to the very end, the last one
 * (a short last section can't reach the line). tops: [{ id, top }] in page order, each top
 * relative to the visible area's top. null when there are none.
 */
export function sectionAt(tops, { line = 96, atEnd = false } = {}) {
  if (!tops.length) return null;
  if (atEnd) return tops[tops.length - 1].id;
  let current = tops[0].id;
  for (const t of tops) if (t.top <= line) current = t.id;
  return current;
}

/* ---- Search (the field above the index): which rows show for what's typed ---- */

// Words a question wraps around the thing looked for ("how do I turn off the sound"): left out
// while another word is typed, so that one decides
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'off', 'at', 'for', 'and', 'or', 'with', 'my', 'me', 'i', 'it', 'is', 'are', 'be', 'how', 'do', 'does', 'can', 'where', 'what', 'which', 'want', 'change', 'set', 'turn', 'make', 'find', 'see', 'get', 'please', 'settings', 'setting']);

/** The words that count in a query: folded (case and accents), without the question's words. */
export function searchTerms(query) {
  // (a question mark or a comma typed after a word isn't part of it)
  const terms = [...new Set(queryTerms(query).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean))];
  const meaningful = terms.filter((t) => !STOP_WORDS.has(t));
  return meaningful.length ? meaningful : terms;
}

/**
 * The rows that show for `query` (Settings → Search), or null when nothing is typed.
 * rows: [{ id, section (its card's title), title, hint, keywords, hidden, via }] in page order:
 *   keywords  other words that find it ('dark mode', 'export'); the card's title finds every row
 *   hidden    the page hides it right now (Reminders off: their sound, times, defaults)
 *   via       the row that brings a hidden one back, which shows in its place
 * Every word must match a row (as in ⌘K Search: title, then keywords, then the explanation).
 * When no row has them all, a word of 5 letters or more may be one typo off a word of the row's
 * title, card or keywords (`typo` true: 'notifcations'); failing that, the rows with the most of
 * the words show (`exact` and `typo` false).
 * -> { terms, exact, typo, ids: Set (hidden ones too, so they show if the page shows them), count (shown) }
 */
export function searchRows(rows, query) {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id != null && typeof r.title === 'string');
  const found = list.map((r) => {
    const entry = { title: r.title, keywords: [r.section, r.keywords].filter(Boolean).join(' '), text: r.hint ?? '' };
    return { r, hit: terms.filter((t) => scoreEntry(entry, [t])) };
  });
  const best = Math.max(0, ...found.map((f) => f.hit.length));
  const exact = best > 0 && best === terms.length;
  // No row has every word: the rows with the most of them, when one of those is longer than two letters
  let shown = exact ? found.filter((f) => f.hit.length === best) : [];
  // Then every word, a longer one maybe one typo off a word of the row's title, card or keywords
  let typo = false;
  if (!shown.length && terms.some((t) => t.length >= TYPO_MIN)) {
    shown = found.filter((f) => {
      const words = normalize([f.r.title, f.r.section, f.r.keywords].filter(Boolean).join(' ')).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      return terms.every((t) => f.hit.includes(t) || nearWord(t, words));
    });
    typo = shown.length > 0;
  }
  // Then the rows with the most of the words, when one of those is longer than two letters
  if (!shown.length && terms.length > 1 && best > 0) shown = found.filter((f) => f.hit.length === best && f.hit.some((t) => t.length > 2));
  const ids = new Set(shown.map((f) => f.r.id));
  const byId = new Map(list.map((r) => [r.id, r]));
  for (const f of shown) if (f.r.hidden && f.r.via != null && byId.has(f.r.via)) ids.add(f.r.via);
  const count = list.filter((r) => ids.has(r.id) && !r.hidden).length;
  return { terms, exact, typo, ids, count };
}

const TYPO_MIN = 5;

/** One letter added, left out or changed, or two side by side swapped ('notifcations', 'exprot'). */
function oneTypoApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.slice(i) === long.slice(i + 1);
}

/** A typed word (5 letters or more) one typo off one of `words`, or off the start of one (still typing it). */
function nearWord(term, words) {
  if (term.length < TYPO_MIN) return false;
  return words.some((w) => [term.length - 1, term.length, term.length + 1].some((n) => n >= TYPO_MIN - 1 && n <= w.length && oneTypoApart(term, w.slice(0, n))));
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Where the words sit in `text`, to highlight: [[start, end]] in the original's offsets, merged.
 * At the start of a word always; inside a word only from `inner` letters ('ark' in 'dark' for a
 * title, 2; in an explanation only from 4, as Search matches them).
 */
export function textHits(text, terms, { inner = 4 } = {}) {
  const f = fold(text);
  const out = [];
  for (const term of terms ?? []) {
    if (!term) continue;
    for (let i = f.text.indexOf(term); i !== -1; i = f.text.indexOf(term, i + 1)) {
      const atStart = i === 0 || !WORD_CHAR.test(f.text[i - 1]);
      if (!atStart && (term.length < inner || term.length < 2)) continue;
      out.push([f.start[i], f.end[i + term.length - 1]]);
    }
  }
  return mergeRanges(out);
}

/** 'v0.10' is newer than 'v0.9': versions compare part by part as numbers. */
export function isNewerVersion(a, b) {
  const parts = (v) => String(v ?? '').replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/* ---- Your data on this device: backups kept, and deleting all of it ---- */

/** Everything LIFE/OS keeps in the browser's storage starts with this (lifeos:v1:…, lifeos:sync:…,
 *  lifeos:backup:…, lifeos:pomodoro-alert:…; in sessionStorage lifeos:clipboard and test switches). */
export const STORAGE_PREFIX = 'lifeos:';
/** …and its offline caches (sw.js) with this. */
export const CACHE_PREFIX = 'lifeos-';
export const BACKUP_PREFIX = 'lifeos:backup:';
/** Safety copies kept in the browser (before a restore, before the first sync): the newest few. */
export const KEEP_BACKUPS = 3;

/**
 * The storage keys "Delete all my data" removes: every LIFE/OS key, and nothing else. On the
 * website the browser's storage belongs to the whole <name>.github.io address, which other
 * GitHub Pages sites of that account share, so their keys must survive.
 */
export function keysToDelete(keys) {
  return [...new Set(keys)].filter((k) => typeof k === 'string' && k.startsWith(STORAGE_PREFIX));
}

/** The offline caches to delete with it (LIFE/OS's own, for the same reason). */
export function cachesToDelete(names) {
  return [...new Set(names)].filter((n) => typeof n === 'string' && n.startsWith(CACHE_PREFIX));
}

// 'lifeos:backup:before-restore:2026-10-07T12:00:00.000Z' -> its time in ms (the time holds colons)
function backupTime(key) {
  const rest = key.slice(BACKUP_PREFIX.length);
  const at = rest.indexOf(':');
  return at > 0 ? Date.parse(rest.slice(at + 1)) : Number.NaN;
}

/**
 * The backup keys to remove so only the newest `keep` stay. A backup is a whole copy of the data,
 * so a pile of them would fill the browser's storage (about 5 MB) and stop LIFE/OS saving.
 * A key whose time can't be read (a format from another version) is never removed here.
 */
export function backupsToPrune(keys, keep = KEEP_BACKUPS) {
  const dated = [...new Set(keys)]
    .filter((k) => typeof k === 'string' && k.startsWith(BACKUP_PREFIX))
    .map((key) => ({ key, at: backupTime(key) }))
    .filter((b) => Number.isFinite(b.at))
    .sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
  return dated.slice(Math.max(0, keep)).map((b) => b.key);
}

/**
 * Settings → Legal: the documents next to the app (legal/, written for the release), opened in
 * a new tab. Relative, so the Mac's copy and the website (a sub-folder) both find them.
 */
export const LEGAL_LINKS = Object.freeze(
  [
    { id: 'privacy', label: 'Privacy policy', href: 'legal/privacy.html', hint: 'What LIFE/OS stores, where, and your rights.', keywords: 'gdpr personal data' },
    { id: 'terms', label: 'Terms', href: 'legal/terms.html', hint: 'The rules for using LIFE/OS.', keywords: 'conditions terms of service tos' },
    { id: 'cookies', label: 'Cookies and storage', href: 'legal/cookies.html', hint: 'No cookies: what it keeps in your browser instead, and why.', keywords: 'tracking' },
    { id: 'refunds', label: 'Refunds', href: 'legal/refunds.html', hint: 'LIFE/OS is free today; how refunds would work for a paid plan.', keywords: 'money back payment price' },
    { id: 'business', label: 'Business details', href: 'legal/business.html', hint: 'Who makes LIFE/OS and how to reach them.', keywords: 'contact company owner address email' },
    { id: 'credits', label: 'Credits', href: 'legal/credits.html', hint: 'The typefaces, images and their licenses.', keywords: 'fonts licences attribution' },
  ].map((link) => Object.freeze(link)),
);

/** Every key a Storage (localStorage, sessionStorage, or a test stand-in) holds. */
export function storageKeys(storage) {
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key != null) keys.push(key);
  }
  return keys;
}

/** Keep only the newest backups in `storage` (called after writing one). Returns the removed keys. */
export function pruneBackups(storage, keep = KEEP_BACKUPS) {
  const gone = backupsToPrune(storageKeys(storage), keep);
  for (const key of gone) {
    try {
      storage.removeItem(key);
    } catch {}
  }
  return gone;
}
