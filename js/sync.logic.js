// LIFE/OS — sync: the pure parts. No DOM, network or storage, so tools/tests/sync.test.js runs
// them in JavaScriptCore. js/sync.js talks to GitHub and saves; js/sync.panel.js is the dialog.

import { WELCOME_NOTE } from './features/notes.logic.js';

/**
 * The stores that sync, each with the fields that stay on this device: what's on screen (the open
 * note, list or board, folded columns, a calendar zoom, which layers show) and a running timer. Every other store (appearance,
 * chart preferences) is per device too. A new field syncs unless it is listed here.
 */
export const SYNCED = Object.freeze({
  tasks: Object.freeze(['view']),
  notes: Object.freeze(['view', 'selectedId', 'layout', 'boardCollapsed']),
  habits: Object.freeze(['view']),
  calendar: Object.freeze(['view', 'layers']),
  pomodoro: Object.freeze(['state']),
  training: Object.freeze(['view']),
});
export const SYNCED_KEYS = Object.freeze(Object.keys(SYNCED));

/** How each store is named in the repo's history ("Notes · Mac"). */
export const STORE_LABELS = Object.freeze({ tasks: 'Tasks', notes: 'Notes', habits: 'Habits', calendar: 'Calendar', pomodoro: 'Pomodoro', training: 'Training' });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The part of a saved store value that syncs: all of it except this device's own fields. */
export function syncedPart(key, value) {
  if (!isObject(value)) return value;
  const own = SYNCED[key] ?? [];
  const out = {};
  for (const k of Object.keys(value)) if (!own.includes(k)) out[k] = value[k];
  return out;
}

/** A synced value with this device's own fields put back from `current` (its saved value). */
export function withDevicePart(key, synced, current) {
  if (!isObject(synced) || !isObject(current)) return synced;
  const out = { ...synced };
  for (const k of SYNCED[key] ?? []) if (hasOwn(current, k)) out[k] = current[k];
  return out;
}

/** Equality of JSON values; key order doesn't matter. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

/* ---- Three-way merge ---- */

const isRecord = (v) => isObject(v) && (typeof v.id === 'string' || typeof v.id === 'number');
const uniqueIds = (list) => new Set(list.map((r) => r.id)).size === list.length;
const recordList = (v) => Array.isArray(v) && v.every(isRecord) && uniqueIds(v);

// Which side wins a field both changed: the record edited last, when both say when
function preferFor(local, remote, prefer) {
  const l = local.updatedAt;
  const r = remote.updatedAt;
  const comparable = (typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string');
  if (comparable && l !== r) return r > l ? 'remote' : 'local';
  return prefer;
}

/**
 * merge3(base, local, remote, prefer?) -> the merged JSON value (undefined: deleted / absent).
 * base is the last version both sides had (undefined: none, e.g. combining two devices' data).
 * - Whatever only one side changed since base is taken from that side.
 * - Objects merge key by key. A key one side deleted stays deleted, unless the other side
 *   changed it: an edit beats a delete, so nothing anyone wrote is lost.
 * - Lists of records with ids (tasks, notes, events, habits, sessions) merge record by record by
 *   the same rules. Order follows `local`; records new from `remote` follow, in remote's order.
 * - A value both changed differently (a title, a plain list): the record with the later updatedAt
 *   wins when both have one, otherwise `prefer` ('local' or 'remote').
 */
export function merge3(base, local, remote, prefer = 'local') {
  if (deepEqual(local, remote)) return local;
  if (deepEqual(base, local)) return remote;
  if (deepEqual(base, remote)) return local;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (isObject(local) && isObject(remote)) return mergeObjects(isObject(base) ? base : undefined, local, remote, preferFor(local, remote, prefer));
  const records = [base, local, remote].filter(Array.isArray);
  if (records.length >= 2 && Array.isArray(local) && Array.isArray(remote) && records.every(recordList) && records.some((l) => l.length)) {
    return mergeRecords(Array.isArray(base) ? base : [], local, remote, prefer);
  }
  return prefer === 'remote' ? remote : local;
}

function mergeObjects(base, local, remote, prefer) {
  const out = {};
  const keys = [...Object.keys(local), ...Object.keys(remote).filter((k) => !hasOwn(local, k))];
  for (const k of keys) {
    const v = merge3(base && hasOwn(base, k) ? base[k] : undefined, hasOwn(local, k) ? local[k] : undefined, hasOwn(remote, k) ? remote[k] : undefined, prefer);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function mergeRecords(base, local, remote, prefer) {
  const byId = (list) => new Map(list.map((r) => [r.id, r]));
  const b = byId(base);
  const l = byId(local);
  const r = byId(remote);
  const out = [];
  for (const rec of local) {
    const v = merge3(b.get(rec.id), rec, r.get(rec.id), prefer);
    if (v !== undefined) out.push(v);
  }
  for (const rec of remote) {
    if (l.has(rec.id)) continue;
    const v = merge3(b.get(rec.id), undefined, rec, prefer);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * One store's merge in a sync. entry: { data } as of the last sync (undefined: never synced it).
 * mode decides a store's FIRST sync: 'upload' keeps this device's, 'download' takes GitHub's,
 * 'combine' merges both. A store missing on GitHub is (re)uploaded; one missing here is taken.
 */
export function mergeStore(entry, local, remote, mode = 'combine') {
  if (remote === undefined) return local;
  if (local === undefined) return remote;
  if (entry) return merge3(entry.data, local, remote);
  if (mode === 'upload') return local;
  if (mode === 'download') return remote;
  return merge3(undefined, local, remote);
}

/* ---- First connect: what each side holds ---- */

const list = (v) => (Array.isArray(v) ? v : []);

/** docs: { tasks, notes, … } (synced parts) -> what they hold. The untouched welcome note doesn't count. */
export function countData(docs = {}) {
  return {
    tasks: list(docs.tasks?.items).length,
    notes: list(docs.notes?.items).filter((n) => !(isObject(n) && n.title === WELCOME_NOTE.title && n.body === WELCOME_NOTE.body)).length,
    sections: list(docs.notes?.sections).length,
    habits: list(docs.habits?.items).length,
    events: list(docs.calendar?.events).length,
    sessions: list(docs.pomodoro?.history).length,
    workouts: list(docs.training?.workouts).length,
  };
}

export const hasData = (counts) => Object.values(counts).some((n) => n > 0);

const COUNT_WORDS = [
  ['tasks', 'task'],
  ['notes', 'note'],
  ['habits', 'habit'],
  ['events', 'event'],
  ['sessions', 'focus session'],
  ['workouts', 'workout'],
];

/** '88 tasks · 61 notes · 9 habits' (what there is; sections go with notes) or 'nothing yet' */
export function describeCounts(counts) {
  const parts = COUNT_WORDS.filter(([k]) => counts[k] > 0).map(([k, word]) => `${counts[k]} ${word}${counts[k] === 1 ? '' : 's'}`);
  if (!parts.length && counts.sections > 0) parts.push(`${counts.sections} note section${counts.sections === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'nothing yet';
}

/**
 * The first sync on this device: 'upload' (GitHub has nothing yet), 'download' (this device has
 * nothing yet) or 'ask' (both have data: the person chooses download, combine or upload).
 */
export function firstSyncPlan(localCounts, remoteCounts) {
  if (!hasData(remoteCounts)) return 'upload';
  if (!hasData(localCounts)) return 'download';
  return 'ask';
}

/* ---- Small helpers ---- */

/** 'owner/name', or a github.com URL of the repo -> { owner, name, full } | null */
export function parseRepo(text) {
  const t = String(text ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(t);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

/** A GitHub token's shape: fine-grained (github_pat_…) or classic (ghp_…). Whitespace trimmed. */
export function cleanToken(text) {
  const t = String(text ?? '').trim();
  return /^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})$/.test(t) ? t : null;
}

/** The device's kind, for the repo's history: 'Mac' | 'Windows' | 'iPhone' | 'iPad' | 'Android' | 'Linux' | 'Browser' */
export function deviceKind(platform = '', userAgent = '') {
  const p = `${platform} ${userAgent}`.toLowerCase();
  if (p.includes('iphone')) return 'iPhone';
  if (p.includes('ipad')) return 'iPad';
  if (p.includes('android')) return 'Android';
  if (p.includes('mac')) return 'Mac';
  if (p.includes('win')) return 'Windows';
  if (p.includes('linux') || p.includes('cros')) return 'Linux';
  return 'Browser';
}
