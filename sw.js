// LIFE/OS — service worker: offline copy of the app, always fresh while the server runs.
//
// Strategy
// - App files (same origin, GET): network first, revalidated with the server on every load
//   (`cache: 'no-cache'`). When the server is not running the request fails at once and the
//   offline copy is served; a navigation falls back to the copy's index.html. So edits apply
//   on the next load, and the installed app still opens offline. Responses reach the page
//   marked `no-cache`, so Chrome's in-memory cache can't skip this worker on a reload.
// - Google Fonts (stylesheet + font files): cache first, so the typefaces work offline. The
//   stylesheet is refreshed in the background; font files are immutable.
// - Everything else (other origins, non-GET, other schemes) is left to the browser.
// - This worker never reads or writes localStorage: app data is not its business.
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
//   visit, which isn't controlled yet, so no precache list has to be maintained by hand.
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
const FONT_CACHE_VERSION = 1; // separate, so an app cache bump keeps the offline typefaces
const PREFIX = 'lifeos-';
const APP_PREFIX = `${PREFIX}app-`;
const SNAPSHOT_PREFIX = `${APP_PREFIX}v${CACHE_VERSION}-`; // + creation time: one cache per snapshot
const META_CACHE = `${PREFIX}meta`;
const FONT_CACHE = `${PREFIX}fonts-v${FONT_CACHE_VERSION}`;
const NETWORK_TIMEOUT_MS = 3000;
const SNAPSHOT_FILE_TIMEOUT_MS = 15000;
const SNAPSHOT_FILL_GRACE_MS = 60000; // a younger snapshot cache may still be filling: never prune it
const FONT_CSS_ORIGIN = 'https://fonts.googleapis.com';
const FONT_FILE_ORIGIN = 'https://fonts.gstatic.com';
const FONT_ORIGINS = [FONT_CSS_ORIGIN, FONT_FILE_ORIGIN];
const SCOPE = self.registration.scope;
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
  'js/store.js',
  'js/skins.js',
  'js/appearance.js',
  'js/contextmenu.js',
  'js/contextmenu.logic.js',
  'js/origin.js',
  'js/shell.js',
  'js/sync.js',
  'js/sync.logic.js',
  'js/sync.panel.js',
  'js/colors.js',
  'js/colors.logic.js',
  'css/tokens.css',
  'css/base.css',
  'css/shell.css',
  'css/components.css',
  'css/appearance.css',
  'css/sync.css',
  'css/skins/simple.css',
  'css/skins/brutalist.css',
  'css/skins/terminal.css',
  'css/skins/oldmoney.css',
  'css/skins/oldmoney-horse.png',
  'css/colors.css',
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

  if (url.origin === self.location.origin) {
    if (!keyFor(request.url) || request.headers.has('range')) return;
    event.respondWith(fromApp(event));
  } else if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(fromFonts(event));
  }
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
  // Offline, any navigation in scope opens the app
  if (hit || !isPage) return hit;
  return caches.match(PAGE_KEY, { cacheName: name });
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
  const keys = [...new Set([...CORE, ...urls.map(keyFor).filter(Boolean)])];
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

/* ---- Fonts ---- */

async function fromFonts(event) {
  const { request } = event;
  const cache = await caches.open(FONT_CACHE);
  const later = (work) => event.waitUntil(work.catch(() => {}));
  const hit = await cache.match(request.url, { ignoreVary: true });
  if (hit) {
    // Font files are immutable; the stylesheet may move on to newer ones
    if (new URL(request.url).origin === FONT_CSS_ORIGIN) later(fetchFont(request, cache, later));
    return hit;
  }
  return fetchFont(request, cache, later);
}

// CORS (the Fonts origins allow it) so the status is readable and errors are never cached.
// `defer` decides whether the stylesheet's font files are awaited or finished in the background.
async function fetchFont(request, cache, defer = (work) => work) {
  let response;
  try {
    response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  } catch {
    return fetch(request);
  }
  if (response.ok) {
    await cache.put(request.url, response.clone());
    // The page never lists Google's font files (cross-origin stylesheet), so take them from the CSS
    if (new URL(request.url).origin === FONT_CSS_ORIGIN) await defer(response.clone().text().then((css) => cacheFontFiles(css, cache)));
  }
  return response;
}

async function cacheFontFiles(css, cache) {
  const urls = new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)'"\s]+)\)/g)].map((m) => m[1]));
  await Promise.all(
    [...urls].map(async (url) => {
      if (await cache.match(url, { ignoreVary: true })) return;
      try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (response.ok) await cache.put(url, response);
      } catch {
        // offline: the next online load tries again
      }
    }),
  );
}

// The first visit loads the fonts before this worker controls the page: cache them from its list
async function cacheFonts(urls) {
  const fonts = await caches.open(FONT_CACHE);
  await Promise.all(
    urls.map(async (raw) => {
      let url;
      try {
        url = new URL(raw);
      } catch {
        return;
      }
      url.hash = '';
      if (!FONT_ORIGINS.includes(url.origin) || (await fonts.match(url.href, { ignoreVary: true }))) return;
      await fetchFont(new Request(url.href), fonts).catch(() => {});
    }),
  );
}
