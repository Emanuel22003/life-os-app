// LIFE/OS — persistence.
// Every feature owns one store, created once at module level so the page view
// and the nav badge read the same state. Data lives in localStorage under
// `lifeos:v1:<key>`; bump the prefix only with a migration.

const PREFIX = 'lifeos:v1:';
const registry = new Map();

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return structuredClone(fallback);
    const parsed = JSON.parse(raw);
    // Shallow-merge plain objects so new default fields appear for old data
    if (isPlainObject(fallback) && isPlainObject(parsed)) return { ...structuredClone(fallback), ...parsed };
    return parsed;
  } catch {
    return structuredClone(fallback);
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[store] could not persist "${key}"`, err);
    window.dispatchEvent(new CustomEvent('lifeos:persist-error', { detail: { key, error: err } }));
    return false;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * createStore(key, defaults) -> { get, set, update, subscribe, reset }
 *
 * - get()            current state (treat as immutable; always replace via set/update)
 * - set(next)        replace state; `next` may be a value or (prev) => value. Returns false if
 *                    the change could not be saved (also fires `lifeos:persist-error`).
 * - update(patch)    shallow-merge an object patch (object stores only)
 * - subscribe(fn)    fn(state) on every change, incl. changes from other tabs; returns unsubscribe
 * - reset()          restore defaults
 *
 * Every change also dispatches a `lifeos:change` window event ({ detail: { key, source } })
 * which the shell uses to refresh nav badges. source: 'local' (this tab changed it), 'tab'
 * (another tab of this app did) or 'sync' (another device, via replaceSaved).
 */
export function createStore(key, defaults) {
  if (registry.has(key)) return registry.get(key);

  let state = read(key, defaults);
  const subs = new Set();

  const notify = (source = 'local') => {
    subs.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.error(`[store] subscriber for "${key}" failed`, err);
      }
    });
    window.dispatchEvent(new CustomEvent('lifeos:change', { detail: { key, source } }));
  };

  const store = {
    key,
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? next(state) : next;
      const saved = write(key, state);
      notify();
      return saved;
    },
    update(patch) {
      return store.set((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    reset() {
      store.set(structuredClone(defaults));
    },
    /** Re-read the saved value (written by another tab, or by sync) and tell subscribers. */
    reload(source = 'tab') {
      state = read(key, defaults);
      notify(source);
    },
  };

  // Keep multiple open tabs in sync
  window.addEventListener('storage', (e) => {
    if (e.key !== PREFIX + key || e.storageArea !== localStorage) return;
    store.reload('tab');
  });

  registry.set(key, store);
  return store;
}

/* ---- Sync (js/sync.js): another device's data, written from outside the feature ---- */

/** The saved value of store `key` as stored (no defaults filled in), or undefined if never saved. */
export function readSaved(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Save `value` as store `key` and let its feature re-read it, exactly as when another tab
 * changed it (features already handle that). Returns false if it could not be saved.
 */
export function replaceSaved(key, value) {
  const saved = write(key, value);
  if (saved) registry.get(key)?.reload('sync');
  return saved;
}

/** App-wide preferences (theme etc.). */
export const settings = createStore('settings', { theme: 'dark' });
