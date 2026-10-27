// LIFE/OS — service worker: offline copy of the app, always fresh while the server runs.
//
// Strategy
// - App files (same origin, GET): network first, revalidated with the server on every load
//   (`cache: 'no-cache'`). When the server is not running the request fails at once and the
//   offline copy is served; a navigation falls back to the copy's index.html. So edits apply
//   on the next load, and the installed app still opens offline. Responses reach the page
//   marked `no-cache`, so Chrome's in-memory cache can't skip this worker on a reload.
// - The typefaces (fonts/: one stylesheet per template + the woff2 files, the app's own copies):
//   cache first in a cache of their own, so every template a window has shown keeps its fonts
//   offline, the active one at least. A stylesheet is refreshed in the background; a font file
//   never changes under its name (an updated one gets a new name). They stay out of the
//   snapshots, which would otherwise copy 1.1 MB of mostly unused files on every load.
// - Everything else (other origins, non-GET, other schemes) is left to the browser. The app
//   itself asks other hosts for nothing but GitHub's API, and only with Sync on (js/sync.js).
// - This worker never reads or writes localStorage: app data is not its business.
// - The timer's notifications are shown through it (js/features/pomodoro.js; phone browsers only
//   allow that kind), so a click on one lands here: see notificationclick at the end.
//
// The offline copy is a snapshot: one cache holding one matching set of the app's files.
// - A snapshot is written whole or not at all. Every file is fetched from the server into a
//   fresh cache, and only when all of them arrived (200, or a 4xx for a file that was removed)
//   does one pointer entry switch to it. A failed, timed-out, 5xx or foreign answer discards
//   the attempt and the previous snapshot stays live. An unchanged set writes nothing.
// - Snapshots are taken (a) at install: the core files plus every file the last snapshot held;
//   if that fails the install fails and the old worker keeps serving, and (b) after each page
//   load that came from the server with every module loaded: the page posts the URLs it loaded
//   (performance entries, incl. the lazily imported feature modules). (b) also covers the first
//   visit, which isn't controlled yet, so no precache list has to be maintained by hand. The one
//   short list is LEGAL: the pages Settings → Legal opens, which the app itself never loads.
// - The page is stored once, under the scope URL (never per query string), and only when it is
//   LIFE/OS: index.html's application-name meta tag (APP_PAGE_MARK). Another server on this
//   port can neither replace it nor be shown instead of it while a copy exists.
//
// One page load never mixes old and new modules:
// - A page that came from the server takes all its files from the server. A file that fails
//   fails the load visibly (index.html or the module panel says so) instead of being filled in
//   from an older snapshot, and that load posts no snapshot.
// - A page that came from a snapshot (server down, hung for NETWORK_TIMEOUT_MS, or not
//   LIFE/OS) takes all its files from that same snapshot, even if a newer one goes live
//   meanwhile: the previous snapshot is kept until the next switch.
// - Requests from a page this worker didn't serve (first visit, or right after this worker
//   replaced an older one) go network first and fall back to the live snapshot.
// - CACHE_VERSION is only for a change to this cache layout. App edits never need it.

const CACHE_VERSION = 2;
// Separate, so an app cache bump keeps the offline typefaces. v1 held Google Fonts' files (before
// the app served its own); activate deletes it like any cache that isn't current.
const FONT_CACHE_VERSION = 2;
const PREFIX = 'lifeos-';
const APP_PREFIX = `${PREFIX}app-`;
const SNAPSHOT_PREFIX = `${APP_PREFIX}v${CACHE_VERSION}-`; // + creation time: one cache per snapshot
const META_CACHE = `${PREFIX}meta`;
const FONT_CACHE = `${PREFIX}fonts-v${FONT_CACHE_VERSION}`;
const NETWORK_TIMEOUT_MS = 3000;
const SNAPSHOT_FILE_TIMEOUT_MS = 15000;
const SNAPSHOT_FILL_GRACE_MS = 60000; // a younger snapshot cache may still be filling: never prune it
const SCOPE = self.registration.scope;
const FONT_PATH = new URL('fonts/', SCOPE).pathname;
const PAGE_KEY = SCOPE;
const PAGE_PATHS = [new URL(SCOPE).pathname, new URL('index.html', SCOPE).pathname];
const APP_PAGE_MARK = 'name="application-name" content="LIFE/OS"';
// The deploy marker (never cached): declared before CORE, whose keyFor() calls read it
const VERSION_PATH = new URL('version.json', SCOPE).pathname;
// META_CACHE entry naming the live snapshot (and the one before it)
const LIVE_POINTER = new URL(`__lifeos-live-snapshot-v${CACHE_VERSION}`, SCOPE).href;

// Every snapshot must hold these
const CORE = [
  './',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/ui.js',
  'js/icons.js',
  'js/icons.logic.js',
  'js/store.js',
  'js/skins.js',
  'js/appearance.js',
  'js/contextmenu.js',
  'js/contextmenu.logic.js',
  'js/origin.js',
  'js/shell.js',
  'js/welcome.js',
  'js/welcome.logic.js',
  'js/tour.js',
  'js/tour.logic.js',
  'js/sync.js',
  'js/sync.logic.js',
  'js/sync.panel.js',
  'js/colors.js',
  'js/colors.logic.js',
  'js/palette.js',
  'js/palette.logic.js',
  'js/command.js',
  'js/command.logic.js',
  'css/tokens.css',
  'css/base.css',
  'css/shell.css',
  'css/components.css',
  'css/appearance.css',
  'css/sync.css',
  'css/command.css',
  'css/tour.css',
  'css/welcome.css',
  'css/skins/simple.css',
  'css/skins/hud.css',
  'css/skins/brutalist.css',
  'css/skins/terminal.css',
  'css/skins/oldmoney.css',
  'css/skins/oldmoney-horse.png',
  'css/skins/coquette.css',
  'css/skins/y2k.css',
  'css/skins/minimal.css',
  'css/palette.css',
  'css/colors.css',
  'css/icons.css',
  'css/compact.css',
].map(keyFor);

// The legal pages (legal/, opened from Settings → Legal; about 90 KB in all) go in every snapshot
// too, so they open offline. Unlike CORE, one the server no longer has is simply left out.
const LEGAL = [
  'legal/privacy.html',
  'legal/terms.html',
  'legal/cookies.html',
  'legal/refunds.html',
  'legal/business.html',
  'legal/credits.html',
  'legal/legal.css',
  'legal/legal.js',
  'legal/business.js',
].map(keyFor);

// Where each open page's document came from: 'network', or the snapshot cache that served it.
// In memory only: after a worker restart a page is unknown again (network first + fallback).
const pageSources = new Map();

/* ---- Lifecycle ---- */

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Throws when incomplete: the install fails and the old worker keeps its snapshot
  event.waitUntil(queueSnapshot(async () => takeSnapshot([...CORE, ...(await knownUrls())])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Other versions' caches and pointers; app snapshots are pruned like after any switch
      const names = await caches.keys();
      const stale = names.filter((name) => name.startsWith(PREFIX) && !name.startsWith(APP_PREFIX) && name !== FONT_CACHE && name !== META_CACHE);
      await Promise.all(stale.map((name) => caches.delete(name)));
      const meta = await caches.open(META_CACHE);
      await Promise.all((await meta.keys()).filter((request) => request.url !== LIVE_POINTER).map((request) => meta.delete(request)));
      await pruneSnapshots();
      await self.clients.claim();
    })(),
  );
});

/* ---- Requests ---- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // DevTools quirk: this combination throws when re-fetched
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  if (url.origin !== self.location.origin || request.headers.has('range')) return;
  if (isFont(url)) event.respondWith(fromFonts(event));
  else if (keyFor(request.url)) event.respondWith(fromApp(event));
});

async function fromApp(event) {
  return revalidating(await respondApp(event));
}

// http.server sends no Cache-Control, so Chrome would reuse old files from its in-memory cache
// on the next load (a reload only revalidates the page itself) without asking this worker.
// Marked no-cache, every load asks the worker again, and so the server.
function revalidating(response) {
  if (response.status !== 200 || response.redirected || (response.type !== 'basic' && response.type !== 'default')) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function respondApp(event) {
  const { request } = event;
  const key = keyFor(request.url);
  const isPage = request.mode === 'navigate';
  const isAppNavigation = isPage && key === PAGE_KEY;
  const source = isPage ? undefined : pageSources.get(event.clientId);

  if (source && source !== 'network') {
    const hit = await caches.match(key, { cacheName: source });
    if (hit) return hit;
  }

  // Revalidate with the server; a navigation keeps its manual redirect mode
  const network = fetch(request.url, {
    cache: 'no-cache',
    credentials: 'same-origin',
    redirect: isPage ? 'manual' : 'follow',
  });
  // A page from the server (or a snapshot without this file) has no other matching copy:
  // if the server fails, the load fails as it would without this worker
  if (source) return network;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, null);
  });
  const outcome = await Promise.race([
    network.then(
      async (response) => (isAppNavigation && !(await isAppPage(response)) ? { foreign: response } : { response }),
      () => null,
    ),
    timeout,
  ]);
  clearTimeout(timer);
  // The server is the source of truth, errors included; only a page that isn't LIFE/OS is not
  if (outcome?.response) {
    if (isPage) rememberSource(event.resultingClientId, 'network');
    return outcome.response;
  }

  const { live } = await readPointer();
  const cached = live ? await matchSnapshot(live, key, isPage) : undefined;
  if (cached) {
    if (isPage) rememberSource(event.resultingClientId, live);
    return cached;
  }
  // No copy: show what the server answered, or keep waiting for it (or fail like the browser)
  return outcome?.foreign ?? network;
}

async function matchSnapshot(name, key, isPage) {
  const hit = await caches.match(key, { cacheName: name });
  // Offline, any navigation in the app's own folder opens the app. A page in a sub-folder that
  // isn't in the snapshot (legal/… is, see LEGAL) doesn't: index.html's relative links would
  // point into that folder and the app would load broken, so it fails like the browser instead.
  if (hit || !isPage || !inScopeFolder(key)) return hit;
  return caches.match(PAGE_KEY, { cacheName: name });
}

function inScopeFolder(key) {
  return !new URL(key).pathname.slice(new URL(SCOPE).pathname.length).includes('/');
}

function rememberSource(clientId, source) {
  if (!clientId) return;
  pageSources.delete(clientId);
  pageSources.set(clientId, source);
  // Bounded: closed windows never tell us they're gone
  if (pageSources.size > 32) pageSources.delete(pageSources.keys().next().value);
}

/* ---- Snapshots ---- */

// One cache key per file: no fragment, and the page (scope root or index.html, any query)
// under the scope URL. Null for anything outside the app.
function keyFor(raw) {
  let url;
  try {
    url = new URL(String(raw), SCOPE);
  } catch {
    return null;
  }
  url.hash = '';
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return null;
  // The deploy marker must come from the server or not at all: a cached one would hide updates
  if (url.pathname === VERSION_PATH) return null;
  // The typefaces have a cache of their own (below)
  if (isFont(url)) return null;
  return PAGE_PATHS.includes(url.pathname) ? PAGE_KEY : url.href;
}

let snapshotQueue = Promise.resolve();

// One snapshot at a time per worker
function queueSnapshot(task) {
  const run = snapshotQueue.then(task);
  snapshotQueue = run.catch(() => {});
  return run;
}

// Fetch every file from the server, then switch to the new set in one step.
// Resolves 'saved' or 'unchanged'; rejects (nothing written) if any file didn't arrive.
async function takeSnapshot(urls) {
  const keys = [...new Set([...CORE, ...LEGAL, ...urls.map(keyFor).filter(Boolean)])];
  const results = await Promise.all(keys.map(fetchForSnapshot));
  const missing = results.filter((r) => r.status === 'failed' || (r.status === 'gone' && CORE.includes(r.key)));
  if (missing.length) throw new Error(`[sw] offline copy not updated, ${missing.length} file(s) unavailable: ${missing.map((r) => r.key).join(', ')}`);

  const files = results.filter((r) => r.status === 'saved');
  const { live } = await readPointer();
  if (live && (await sameAsSnapshot(live, files))) return 'unchanged';

  const name = `${SNAPSHOT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const cache = await caches.open(name);
    await Promise.all(files.map(({ key, body, headers }) => cache.put(key, new Response(body, { status: 200, statusText: 'OK', headers }))));
  } catch (err) {
    await caches.delete(name);
    throw err;
  }
  await setLive(name, live);
  return 'saved';
}

// 'saved' with the whole body in memory; 'gone' when the server says it no longer has that
// file (404, other 4xx, a redirect); 'failed' when there is no usable answer (network error,
// timeout, 5xx, 408/429, a page that isn't LIFE/OS)
async function fetchForSnapshot(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_FILE_TIMEOUT_MS);
  try {
    const response = await fetch(key, { cache: 'no-cache', credentials: 'same-origin', signal: controller.signal });
    if (response.status >= 500 || response.status === 408 || response.status === 429) return { key, status: 'failed' };
    if (!isCacheable(response)) return { key, status: 'gone' };
    if (key === PAGE_KEY && !(await isAppPage(response))) return { key, status: 'failed' };
    const body = await response.arrayBuffer();
    return { key, status: 'saved', body, headers: response.headers };
  } catch {
    return { key, status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function sameAsSnapshot(name, files) {
  const cache = await caches.open(name);
  if ((await cache.keys()).length !== files.length) return false;
  for (const { key, body } of files) {
    const old = await cache.match(key);
    if (!old || !sameBytes(await old.arrayBuffer(), body)) return false;
  }
  return true;
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// The pointer entry is the single switch between snapshots
async function readPointer() {
  try {
    const entry = await (await caches.open(META_CACHE)).match(LIVE_POINTER);
    const pointer = entry ? await entry.json() : {};
    const valid = async (name) => (typeof name === 'string' && name.startsWith(SNAPSHOT_PREFIX) && (await caches.has(name)) ? name : null);
    return { live: await valid(pointer.live), previous: await valid(pointer.previous) };
  } catch {
    return { live: null, previous: null };
  }
}

async function setLive(name, previous) {
  const meta = await caches.open(META_CACHE);
  const body = JSON.stringify({ live: name, previous: previous ?? null });
  await meta.put(LIVE_POINTER, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
}

// Keep the live snapshot, the one before it (a page may still be loading from it) and any
// that may still be filling; drop the rest, including older versions' app caches
async function pruneSnapshots() {
  const { live, previous } = await readPointer();
  const now = Date.now();
  const filling = (name) => name.startsWith(SNAPSHOT_PREFIX) && now - Number.parseInt(name.slice(SNAPSHOT_PREFIX.length), 10) < SNAPSHOT_FILL_GRACE_MS;
  const names = (await caches.keys()).filter((name) => name.startsWith(APP_PREFIX) && name !== live && name !== previous && !filling(name));
  await Promise.all(names.map((name) => caches.delete(name)));
}

// Every file any app cache holds (older versions' too), so a new snapshot is as complete as the last
async function knownUrls() {
  const names = (await caches.keys()).filter((name) => name.startsWith(APP_PREFIX));
  const lists = await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)));
  return lists.flat();
}

function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic' && !response.redirected;
}

// LIFE/OS's own index.html, not some other server's page on this port
async function isAppPage(response) {
  if (!isCacheable(response) || !(response.headers.get('content-type') ?? '').includes('text/html')) return false;
  try {
    return (await response.clone().text()).includes(APP_PAGE_MARK);
  } catch {
    return false;
  }
}

/* ---- After a load: snapshot what the page loaded ---- */

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type !== 'lifeos:cache-urls' || data.complete !== true || !Array.isArray(data.urls)) return;
  const urls = data.urls.slice(0, 500).map(String);
  const source = event.source?.id ? pageSources.get(event.source.id) : undefined;
  // A page served from a snapshot has nothing newer to add (its fonts may still be missing)
  const snapshot = source && source !== 'network' ? null : queueSnapshot(() => snapshotFromPage(urls));
  event.waitUntil(Promise.all([snapshot?.catch((err) => console.warn(err.message)), cacheFonts(urls)]));
});

async function snapshotFromPage(urls) {
  const result = await takeSnapshot([...(await knownUrls()), ...urls]);
  if (result === 'saved') await pruneSnapshots();
  return result;
}

/* ---- Fonts (fonts/: the app's own typefaces) ---- */

function isFont(url) {
  return url.origin === self.location.origin && url.pathname.startsWith(FONT_PATH);
}

// One entry per file, whatever query or fragment asked for it
function fontKey(url) {
  const key = new URL(url);
  key.search = '';
  key.hash = '';
  return key.href;
}

async function fromFonts(event) {
  const key = fontKey(event.request.url);
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(key);
  if (hit) {
    // A template's stylesheet may move on to new files; the files themselves never change
    if (key.endsWith('.css')) event.waitUntil(fetchFont(key, cache).catch(() => {}));
    return hit;
  }
  // Not cached yet: from the server (offline, it fails like the browser and the system's
  // fonts stand in until the next online load)
  return fetchFont(key, cache);
}

async function fetchFont(key, cache) {
  const response = await fetch(key, { cache: 'no-cache', credentials: 'same-origin' });
  if (isCacheable(response)) await cache.put(key, response.clone());
  return response;
}

// The first visit loads its fonts before this worker controls the page: cache them from its list
async function cacheFonts(urls) {
  const cache = await caches.open(FONT_CACHE);
  const keys = new Set();
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (isFont(url)) keys.add(fontKey(url));
    } catch {}
  }
  await Promise.all(
    [...keys].map(async (key) => {
      if (await cache.match(key)) return;
      await fetchFont(key, cache).catch(() => {}); // offline: the next online load tries again
    }),
  );
}

/* ---- A click on a notification (the timer's, js/features/pomodoro.js) ---- */

// Brings LIFE/OS's window to the front on the page the notification names (the timer), or opens
// the app there when no window is open. Only the app's own page counts: on the website other
// GitHub Pages sites of the account share this origin, and a legal page isn't the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const asked = event.notification.data?.route;
  const route = typeof asked === 'string' && /^#\/[a-z-]+$/.test(asked) ? asked : '';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = windows.find((client) => PAGE_PATHS.includes(new URL(client.url).pathname));
      if (app) {
        if (route) app.postMessage({ type: 'lifeos:notification-click', route });
        try {
          await app.focus();
          return;
        } catch {
          // Not allowed to focus it (rare): a new window instead
        }
      }
      await self.clients.openWindow(new URL(route, SCOPE).href);
    })(),
  );
});
