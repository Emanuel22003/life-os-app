// LIFE/OS — Google Calendar: the connection (read-only). Off until someone presses Connect in
// Settings → Google Calendar; nothing here talks to Google before that. The pure parts are in
// google.logic.js.
//
// - Sign-in: Google's own script (accounts.google.com/gsi/client) opens Google's window and
//   hands back an access token for "See your calendars". It loads on Connect, and on later starts
//   once connected (so a tap can open Google's window at once).
// - The token lasts about an hour and lives in memory only, never in storage. When it has run
//   out, a tap gets a new one (Refresh on the calendar, or opening the Calendar page): Google's
//   window opens and closes by itself once access was given. Without a tap a browser blocks the
//   window, so the calendar then offers Refresh and shows the events it has.
// - Events are read with Google's Calendar API straight from this browser (www.googleapis.com),
//   for the months around today and any period the calendar shows, and saved in the store
//   'google' on this device only: not synced, not in backups (Delete all my data clears it).
// - Disconnect revokes the token (when there is one) and forgets everything here.
//
// API
//   googleReady()                  a client ID is set (js/google.config.js)
//   googleState()                  the normalized store value
//   googleEvents()                 the events to show (connected, shown, calendars ticked)
//   googleEvent(id)                one of them, or null
//   googleStatus()                 { state: 'idle' | 'busy' | 'signin' | 'error', problem }
//   subscribeGoogle(fn)            fn() after any change (store or status) -> unsubscribe
//   connectGoogle()                from a tap: sign in, then fetch -> true when connected
//   refreshGoogle({ tap, range })  fetch again (tap: may open Google's window) -> boolean
//   wantGoogle(range)              a page shows `range`: fetch when stale or not covered
//   setGoogleShown(on) / setCalendarOn(id, on) / disconnectGoogle()
//   startGoogle()                  at start-up (js/app.js): keeps the events fresh while open

import { createStore } from './store.js';
import { todayKey, shiftKey } from './ui.js';
import { GOOGLE_CLIENT_ID } from './google.config.js';
import * as G from './google.logic.js';

export const googleStore = createStore('google', G.DEFAULT_GOOGLE);

let token = null; // { value, until }
let client = null;
let pending = null;
let gis = null;
let busy = null;
let connecting = false;
let status = { state: 'idle', problem: null };
const statusSubs = new Set();
let memo = { raw: null, state: null, shown: null };

export const googleReady = () => typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com');

export function googleState() {
  const raw = googleStore.get();
  if (raw !== memo.raw) memo = { raw, state: G.normalizeGoogle(raw), shown: null };
  return memo.state;
}

export function googleEvents() {
  const s = googleState();
  if (!s.connected || !s.show) return [];
  if (!memo.shown) memo.shown = G.shownEvents(s);
  return memo.shown;
}

export function googleEvent(id) {
  return googleState().events.find((e) => e.id === id) ?? null;
}

export const googleStatus = () => status;

export function subscribeGoogle(fn) {
  const off = googleStore.subscribe(() => fn());
  statusSubs.add(fn);
  return () => {
    off();
    statusSubs.delete(fn);
  };
}

function setStatus(state, problem = null) {
  if (status.state === state && status.problem === problem) return;
  status = { state, problem };
  statusSubs.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[google] subscriber failed', err);
    }
  });
}

const fail = (code) => Object.assign(new Error(code), { code });

/* ---- Sign-in ---- */

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gis) {
    gis = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = G.GIS_SRC;
      s.async = true;
      s.onload = () => (window.google?.accounts?.oauth2 ? resolve() : reject(fail('offline')));
      s.onerror = () => {
        gis = null;
        s.remove();
        reject(fail('offline'));
      };
      document.head.append(s);
    });
  }
  return gis;
}

const tokenValid = () => !!token && Date.now() < token.until;

/** Google's window for a token. ask: the first time (choose an account, give access). */
function requestToken({ ask = false } = {}) {
  return new Promise((resolve, reject) => {
    pending?.reject(fail('popup_closed'));
    pending = { resolve, reject };
    const oauth = window.google.accounts.oauth2;
    if (!client) {
      client = oauth.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: G.SCOPE,
        callback: (resp) => {
          const p = pending;
          pending = null;
          if (!resp || resp.error) return p?.reject(fail(resp?.error === 'access_denied' ? 'access_denied' : 'auth'));
          if (!oauth.hasGrantedAllScopes(resp, G.SCOPE)) return p?.reject(fail('scope'));
          token = { value: resp.access_token, until: Date.now() + Math.max(60, (Number(resp.expires_in) || 3600) - 120) * 1000 };
          return p?.resolve();
        },
        error_callback: (err) => {
          const p = pending;
          pending = null;
          p?.reject(fail(err?.type === 'popup_failed_to_open' ? 'popup_failed_to_open' : 'popup_closed'));
        },
      });
    }
    const hint = googleState().account;
    client.requestAccessToken({ prompt: ask ? 'select_account' : '', ...(hint ? { login_hint: hint } : {}) });
  });
}

/* ---- Google's Calendar API ---- */

async function api(path, params) {
  const url = new URL(G.API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` }, cache: 'no-store' });
  } catch {
    throw fail('offline');
  }
  if (res.status === 401) {
    token = null;
    throw fail('auth');
  }
  if (!res.ok) throw fail('http');
  return res.json();
}

/** Every page of a list (at most 20 pages). */
async function listAll(path, params) {
  const items = [];
  let pageToken;
  for (let i = 0; i < 20; i++) {
    const page = await api(path, { ...params, pageToken });
    if (Array.isArray(page.items)) items.push(...page.items);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

/* ---- Fetching ---- */

/** Calendars and events for the window, saved in one write. */
async function fetchAll(range) {
  const st = googleState();
  const calendars = G.calendarsFrom(await listAll('/users/me/calendarList', { minAccessRole: 'freeBusyReader', maxResults: 250 }), st.calendars);
  const win = G.windowFor(todayKey(), range);
  const lists = await Promise.all(
    calendars
      .filter((c) => c.on)
      .map((c) =>
        listAll(`/calendars/${encodeURIComponent(c.id)}/events`, {
          timeMin: G.dayStartIso(win.from),
          timeMax: G.dayStartIso(shiftKey(win.to, 1)),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
        }).then((items) => items.flatMap((item) => G.eventsFrom(item, c))),
      ),
  );
  // Disconnected meanwhile (another window, or Disconnect pressed): nothing comes back
  if (!googleState().connected && !connecting) return false;
  googleStore.set({ ...googleStore.get(), connected: true, account: G.accountOf(calendars) || st.account, calendars, events: lists.flat(), from: win.from, to: win.to, updatedAt: Date.now() });
  return true;
}

/**
 * Fetch again. tap: this runs from a tap (or just after one), so Google's window may open for a
 * new token; without one an expired token leaves the 'signin' status (the calendar's Refresh).
 */
export function refreshGoogle({ tap = false, range = null, ask = false } = {}) {
  if (!googleReady() || (!googleState().connected && !connecting)) return Promise.resolve(false);
  if (busy) return busy;
  busy = (async () => {
    setStatus('busy');
    try {
      if (!tokenValid()) {
        const canAsk = tap || navigator.userActivation?.isActive === true;
        if (!canAsk) {
          setStatus('signin');
          return false;
        }
        await loadGis();
        await requestToken({ ask });
      }
      const ok = await fetchAll(range);
      setStatus('idle');
      return ok;
    } catch (err) {
      const code = err?.code ?? 'http';
      if (code !== 'http' && code !== 'offline') console.info('[google]', code);
      else console.warn('[google] fetch failed', err);
      setStatus(code === 'auth' || code === 'popup_closed' || code === 'popup_failed_to_open' ? 'signin' : 'error', code);
      return false;
    } finally {
      busy = null;
    }
  })();
  return busy;
}

/** Settings → Connect (a tap): Google's window to pick the account and give access, then a fetch. */
export async function connectGoogle() {
  if (!googleReady()) return false;
  connecting = true;
  try {
    token = null;
    return await refreshGoogle({ tap: true, ask: true });
  } finally {
    connecting = false;
  }
}

/** A page shows `range` ({ from, to }): fetch when the events are stale or don't cover it. */
export function wantGoogle(range = null) {
  const s = googleState();
  if (!s.connected || !googleReady() || busy) return;
  const outside = range && !G.covers(s, range.from, range.to);
  if (!outside && !G.isStale(s)) return;
  // An expired token and no tap: say so (Refresh) rather than asking again on every redraw
  if (!tokenValid() && status.state === 'signin' && !navigator.userActivation?.isActive) return;
  refreshGoogle({ range }).catch(() => {});
}

export function setGoogleShown(on) {
  const s = googleState();
  if (s.show === !!on) return false;
  googleStore.set({ ...googleStore.get(), show: !!on });
  return true;
}

/** Show or hide one calendar; one shown for the first time is fetched (this is a tap). */
export function setCalendarOn(id, on) {
  const s = googleState();
  const calendars = s.calendars.map((c) => (c.id === id ? { ...c, on: !!on } : c));
  googleStore.set({ ...googleStore.get(), calendars });
  if (on && !s.events.some((e) => e.calendarId === id)) refreshGoogle({ tap: true }).catch(() => {});
}

/** Forget the connection here, and give the access back to Google when this window has it. */
export function disconnectGoogle() {
  const value = token?.value;
  token = null;
  pending?.reject(fail('popup_closed'));
  pending = null;
  if (value && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(value, () => {});
    } catch {}
  }
  googleStore.set({ ...G.DEFAULT_GOOGLE, calendars: [], events: [] });
  setStatus('idle');
}

/** At start-up: once connected, Google's script loads (for taps later) and the events stay fresh. */
export function startGoogle() {
  const tick = () => {
    const s = googleState();
    if (!s.connected || !googleReady() || document.hidden) return;
    loadGis().catch(() => {});
    if (tokenValid() && G.isStale(s)) refreshGoogle().catch(() => {});
  };
  tick();
  setInterval(tick, 60 * 1000);
  document.addEventListener('visibilitychange', tick);
  googleStore.subscribe(() => {
    if (googleState().connected) loadGis().catch(() => {});
  });
}
