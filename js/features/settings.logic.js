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
