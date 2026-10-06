// LIFE/OS — sync: keeps your computers' data in step through a private GitHub repository
// (<you>/life-os-data). Off until it is connected in the Sync dialog (js/sync.panel.js), and only
// the real copies ever sync (js/origin.js); a test copy can sync only with a local mock API.
//
// How
// - The repo holds one file per synced store, stores/<key>.json (SYNCED in sync.logic.js says
//   what syncs; what's on screen, like the open note or a running timer, stays per device).
// - A sync lists stores/ (one request, answered from the browser's cache when nothing changed),
//   downloads only files that changed since the last sync, merges three ways (merge3 in
//   sync.logic.js, with the last synced version as the base, so additions, edits and deletions
//   from both sides survive), saves the result here and uploads what GitHub doesn't have yet.
//   Every upload is a commit, so the repo's history keeps every synced version.
// - An upload names the file version it replaces: if another computer saved in between, GitHub
//   refuses and the sync starts over with the newer data. If this window changes the data while
//   a sync is downloading, the sync starts over too, so it never overwrites a fresh edit.
// - When: 10 s after the last change (at most 60 s), when the window is hidden (right away) or
//   shown again, every minute while it's visible, and when the connection comes back. One sync
//   at a time across every open window of this copy (Web Locks).
// - The sync key (a fine-grained GitHub token limited to that one repo) stays on this device:
//   it's never synced, exported or shown again.

import { readSaved, replaceSaved } from './store.js';
import { isRealAddress } from './origin.js';
import { SYNCED_KEYS, STORE_LABELS, syncedPart, withDevicePart, deepEqual, mergeStore, countData, hasData, deviceKind } from './sync.logic.js';

const CONFIG_KEY = 'lifeos:sync:config'; // { token, repo, login, connectedAt }
const STATE_KEY = 'lifeos:sync:state'; // { base: { key: { sha, data } }, lastSync, mode?, recent: [{ key, sha, at }] }
const BACKUP_PREFIX = 'lifeos:backup:';
const QUIET_MS = 10_000;
const MAX_WAIT_MS = 60_000;
const POLL_MS = 60_000;
const REFOCUS_MS = 15_000;
const ECHO_MS = 120_000;
const MAX_PASSES = 4;
const STOP_KINDS = new Set(['auth', 'access', 'not-found']); // wait for the person, don't retry by itself

// A test copy may point sync at a local mock of the GitHub API (?sync-api=http://127.0.0.1:PORT),
// never at GitHub itself: test data must not reach the real repo.
const TEST_API = (() => {
  if (isRealAddress) return null;
  try {
    const m = /[?&]sync-api=([^&#]+)/.exec(location.search);
    if (m) sessionStorage.setItem('lifeos:sync-api', decodeURIComponent(m[1]));
    const api = sessionStorage.getItem('lifeos:sync-api');
    return api && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(api) ? api : null;
  } catch {
    return null;
  }
})();
const API = TEST_API ?? 'https://api.github.com';

/** Sync can run on this copy (the real app, or a test copy wired to a mock API). */
export const syncAvailable = isRealAddress || TEST_API !== null;

export const DEVICE = deviceKind(navigator.userAgentData?.platform ?? navigator.platform ?? '', navigator.userAgent ?? '');

/* ---- Saved config and state (this device only) ---- */

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The connection ({ token, repo, login }) or null when sync is off. */
export function syncConfig() {
  const c = syncAvailable ? readJson(CONFIG_KEY) : null;
  return c && typeof c.token === 'string' && typeof c.repo === 'string' ? c : null;
}

function readState() {
  const s = readJson(STATE_KEY);
  return { base: {}, recent: [], ...(s && typeof s === 'object' ? s : {}) };
}

function writeState(state) {
  if (!writeJson(STATE_KEY, state)) throw syncError('storage');
}

/* ---- Status ---- */

// state: 'off' | 'idle' | 'syncing' | 'synced' | 'error'; error: { kind, detail } while state is 'error'
let status = initialStatus();
const listeners = new Set();

function initialStatus() {
  const config = syncConfig();
  return config ? { state: 'idle', repo: config.repo, login: config.login, lastSync: readState().lastSync ?? null, error: null, pending: false } : { state: 'off' };
}

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of listeners) {
    try {
      fn(status);
    } catch (err) {
      console.error('[sync] status listener failed', err);
    }
  }
}

export const syncStatus = () => status;

/** fn(status) on every change (and every 30 s, so "2m ago" stays true). Returns unsubscribe. */
export function onSyncStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---- GitHub REST API ---- */

function syncError(kind, detail = '') {
  const err = new Error(`sync: ${kind}${detail ? ` (${detail})` : ''}`);
  err.kind = kind;
  err.detail = detail;
  return err;
}

async function api(token, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      // Revalidate with GitHub every time: an unchanged answer costs a 304, never a stale read
      cache: 'no-cache',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw syncError(navigator.onLine === false ? 'offline' : 'network');
  }
  if (res.ok) return res.status === 204 ? null : res.json();
  let detail = '';
  try {
    detail = String((await res.json())?.message ?? '');
  } catch {}
  if (res.status === 401) throw syncError('auth', detail);
  if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)))) throw syncError('rate', detail);
  if (res.status === 403) throw syncError('access', detail);
  if (res.status === 404) throw syncError('not-found', detail);
  if (res.status === 409 || (res.status === 422 && /sha/i.test(detail))) throw syncError('conflict', detail);
  if (res.status >= 500) throw syncError('server', detail);
  throw syncError('unknown', `${res.status} ${detail}`.trim());
}

const repoPath = (repo) => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** stores/ on GitHub -> Map(key -> blob sha); empty when nothing was synced yet. */
async function listRemote(token, repo) {
  let entries;
  try {
    entries = await api(token, `${repoPath(repo)}/contents/stores`);
  } catch (err) {
    if (err.kind !== 'not-found') throw err;
    await api(token, repoPath(repo)); // the repo itself missing (or not shared with the key) stays an error
    return new Map();
  }
  const files = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = e?.type === 'file' && /^([a-z-]+)\.json$/.exec(e.name ?? '')?.[1];
    if (key && SYNCED_KEYS.includes(key) && typeof e.sha === 'string') files.set(key, e.sha);
  }
  return files;
}

async function download(token, repo, key, sha) {
  const blob = await api(token, `${repoPath(repo)}/git/blobs/${encodeURIComponent(sha)}`);
  try {
    return JSON.parse(fromBase64(blob.content));
  } catch {
    throw syncError('bad-data', `stores/${key}.json`);
  }
}

async function upload(token, repo, key, doc, sha) {
  const res = await api(token, `${repoPath(repo)}/contents/stores/${key}.json`, {
    method: 'PUT',
    body: {
      message: `${STORE_LABELS[key] ?? key} · ${DEVICE}`,
      content: toBase64(`${JSON.stringify(doc, null, 2)}\n`),
      ...(sha ? { sha } : {}),
    },
  });
  const next = res?.content?.sha;
  if (typeof next !== 'string') throw syncError('unknown', 'no file version in GitHub’s answer');
  return next;
}

/* ---- Local data ---- */

function localDoc(key) {
  const saved = readSaved(key);
  return saved === undefined ? undefined : syncedPart(key, saved);
}

/** What this device holds, as the first-connect question counts it. */
export function localCounts() {
  return countData(Object.fromEntries(SYNCED_KEYS.map((k) => [k, localDoc(k)])));
}

// A copy of every store before another device's data replaces or joins this one's
function backupLocal() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('lifeos:v1:')) data[k] = localStorage.getItem(k);
  }
  return writeJson(`${BACKUP_PREFIX}before-sync:${new Date().toISOString()}`, { reason: 'before the first sync on this device', createdAt: Date.now(), data });
}

/* ---- One sync ---- */

// A listing can briefly still show the file version an upload from here just replaced: skip it
function isEcho(state, key, sha) {
  return state.base[key]?.sha !== sha && state.recent.some((r) => r.key === key && r.sha === sha && Date.now() - r.at < ECHO_MS);
}

async function pass(config) {
  const { token, repo } = config;
  const state = readState();
  state.recent = state.recent.filter((r) => Date.now() - r.at < ECHO_MS);
  const files = await listRemote(token, repo);
  for (const key of SYNCED_KEYS) {
    const entry = state.base[key];
    const sha = files.get(key) ?? null;
    if (sha && isEcho(state, key, sha)) continue;
    const local = localDoc(key);
    const remote = !sha ? undefined : entry?.sha === sha ? entry.data : await download(token, repo, key, sha);
    const merged = mergeStore(entry, local, remote, state.mode);
    if (merged === undefined) continue;

    if (!deepEqual(merged, local)) {
      // Changed here while this pass was waiting on GitHub: start over rather than overwrite it
      if (!deepEqual(localDoc(key), local)) throw syncError('local-changed');
      if (!replaceSaved(key, withDevicePart(key, merged, readSaved(key)))) throw syncError('storage');
    }
    if (sha && deepEqual(merged, remote)) {
      state.base[key] = { sha, data: merged };
    } else {
      const next = await upload(token, repo, key, merged, sha);
      if (sha) state.recent.push({ key, sha, at: Date.now() });
      state.base[key] = { sha: next, data: merged };
    }
    writeState(state);
  }
  delete state.mode;
  state.lastSync = Date.now();
  writeState(state);
  return state.lastSync;
}

async function withLock(fn) {
  return navigator.locks?.request ? navigator.locks.request('lifeos-sync', fn) : fn();
}

async function runSync() {
  const config = syncConfig();
  if (!config) return;
  setStatus({ state: 'syncing', pending: false });
  try {
    const lastSync = await withLock(async () => {
      for (let i = 1; ; i++) {
        try {
          return await pass(config);
        } catch (err) {
          if ((err.kind === 'conflict' || err.kind === 'local-changed') && i < MAX_PASSES) continue;
          throw err;
        }
      }
    });
    if (syncConfig()) setStatus({ state: 'synced', lastSync, error: null });
  } catch (err) {
    if (!syncConfig()) return;
    // Still being edited here on every try: not a problem, just later
    if (err.kind === 'local-changed') {
      setStatus({ state: status.lastSync ? 'synced' : 'idle' });
      schedule();
      return;
    }
    if (!err.kind) console.error('[sync] failed', err);
    setStatus({ state: 'error', error: { kind: err.kind ?? 'unknown', detail: err.detail ?? '' } });
  }
}

let running = null;
let again = false;

/** Sync now (joins a running sync, which then runs once more). Resolves with the status. */
export function syncNow() {
  if (!syncConfig()) return Promise.resolve(status);
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await runSync();
      } while (again && syncConfig());
    } finally {
      running = null;
    }
    return status;
  })();
  return running;
}

/* ---- When to sync ---- */

let timer = null;
let firstChange = 0;
let lastAuto = 0;

function schedule() {
  const now = Date.now();
  if (!firstChange) firstChange = now;
  clearTimeout(timer);
  timer = setTimeout(fire, Math.min(QUIET_MS, Math.max(0, firstChange + MAX_WAIT_MS - now)));
  if (!status.pending) setStatus({ pending: true });
}

function fire() {
  clearTimeout(timer);
  timer = null;
  firstChange = 0;
  autoSync({ force: true });
}

function flush() {
  if (timer) fire();
}

// Automatic syncs pause after an error only the person can fix (an expired or wrong key)
function autoSync({ force = false } = {}) {
  if (!syncConfig() || (status.state === 'error' && STOP_KINDS.has(status.error?.kind))) return;
  if (!force && Date.now() - lastAuto < REFOCUS_MS) return;
  lastAuto = Date.now();
  syncNow();
}

let started = false;

/** Boot: wire the triggers and sync once if connected. Called by the shell. */
export function startSync() {
  if (started || !syncAvailable) return;
  started = true;

  window.addEventListener('lifeos:change', (e) => {
    const { key, source } = e.detail ?? {};
    if (source !== 'local' || !SYNCED_KEYS.includes(key) || !syncConfig()) return;
    // Only a change to what syncs (not the open note or the timer) needs an upload
    if (deepEqual(localDoc(key), readState().base[key]?.data)) return;
    schedule();
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? flush() : autoSync()));
  window.addEventListener('pagehide', flush);
  window.addEventListener('online', () => autoSync({ force: true }));
  // Connected or disconnected in another window of this copy
  window.addEventListener('storage', (e) => {
    if (e.key === CONFIG_KEY) {
      status = initialStatus();
      setStatus({});
      autoSync({ force: true });
    } else if (e.key === STATE_KEY && syncConfig() && status.state !== 'error') {
      // Another window of this copy synced
      const lastSync = readState().lastSync;
      if (lastSync && lastSync !== status.lastSync) setStatus({ state: 'synced', lastSync });
    }
  });
  setInterval(() => {
    if (!document.hidden) autoSync({ force: true });
  }, POLL_MS);
  setInterval(() => setStatus({}), 30_000);

  if (syncConfig()) setTimeout(() => autoSync({ force: true }), 1200);
}

/* ---- Connect / disconnect (the Sync dialog) ---- */

/** The key's GitHub account: { login }. Throws a sync error ('auth' for a key that doesn't work). */
export async function checkKey(token) {
  const user = await api(token, '/user');
  if (typeof user?.login !== 'string') throw syncError('unknown', 'no account in GitHub’s answer');
  return { login: user.login };
}

/** What the repo and this device hold, to choose the first sync: { remote, local } counts. */
export async function inspect({ token, repo }) {
  const files = await listRemote(token, repo);
  const docs = {};
  for (const [key, sha] of files) docs[key] = await download(token, repo, key, sha);
  return { remote: countData(docs), local: localCounts() };
}

/**
 * Connect this device and run its first sync. mode: 'upload' | 'download' | 'combine' (see
 * mergeStore). Before GitHub's data replaces or joins data here, a backup of it is kept here.
 * Resolves with the status after that sync.
 */
export async function connect({ token, repo, login, mode }) {
  if (mode !== 'upload' && hasData(localCounts()) && !backupLocal()) {
    throw syncError('storage', 'no room for a backup of this computer’s data');
  }
  if (!writeJson(CONFIG_KEY, { token, repo, login, connectedAt: Date.now() })) throw syncError('storage');
  writeJson(STATE_KEY, { base: {}, recent: [], mode });
  status = initialStatus();
  setStatus({});
  return syncNow();
}

/** Forget the key and the sync state on this device. The data here stays as it is. */
export function disconnect() {
  clearTimeout(timer);
  timer = null;
  firstChange = 0;
  try {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(STATE_KEY);
  } catch {}
  status = { state: 'off' };
  setStatus({});
}

/** Replace an expired key (same account and repo), then sync. */
export async function replaceKey(token) {
  const config = syncConfig();
  if (!config) return status;
  const { login } = await checkKey(token);
  if (config.login && login.toLowerCase() !== config.login.toLowerCase()) throw syncError('other-account', login);
  if (!writeJson(CONFIG_KEY, { ...config, token, login })) throw syncError('storage');
  setStatus({ state: 'idle', error: null });
  return syncNow();
}
