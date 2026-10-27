// LIFE/OS — Settings: the pure parts (backup files, start page, version compare). DOM-free, so
// tools/tests/settings.test.js runs them in JavaScriptCore.

import { countData } from '../sync.logic.js';

export const BACKUP_FORMAT = 1;
const DATA_PREFIX = 'lifeos:v1:';

/** A key that belongs in a backup: app data and preferences, never the sync key or older backups. */
export const isDataKey = (key) => typeof key === 'string' && key.startsWith(DATA_PREFIX) && key.length > DATA_PREFIX.length;

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
    { id: 'colors', title: 'Color coding', icon: 'tag' },
    { id: 'sound', title: 'Sound & notifications', icon: 'volume' },
    { id: 'reminders', title: 'Reminders', icon: 'bell' },
    { id: 'startup', title: 'Start-up', icon: 'home' },
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
    { id: 'privacy', label: 'Privacy policy', href: 'legal/privacy.html', hint: 'What LIFE/OS stores, where, and your rights.' },
    { id: 'terms', label: 'Terms', href: 'legal/terms.html', hint: 'The rules for using LIFE/OS.' },
    { id: 'cookies', label: 'Cookies and storage', href: 'legal/cookies.html', hint: 'No cookies: what it keeps in your browser instead, and why.' },
    { id: 'refunds', label: 'Refunds', href: 'legal/refunds.html', hint: 'LIFE/OS is free today; how refunds would work for a paid plan.' },
    { id: 'business', label: 'Business details', href: 'legal/business.html', hint: 'Who makes LIFE/OS and how to reach them.' },
    { id: 'credits', label: 'Credits', href: 'legal/credits.html', hint: 'The typefaces, images and their licenses.' },
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
