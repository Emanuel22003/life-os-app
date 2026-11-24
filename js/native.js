// LIFE/OS — the iPhone app (Capacitor, in ../life-os-ios): what only the app can do. The same files
// run on the web, where everything here does nothing (isNative is false there).
//
// - Alarms while LIFE/OS is closed: the rest timer, the Pomodoro and reminders hand their coming
//   alerts to scheduleNative(kind, items), and the phone shows them at their time, with the app
//   closed or the screen locked. While the app is open the phone stays quiet (capacitor.config
//   presentationOptions: []): the app's own message and sound say it, never both.
// - A tap on one opens the page it belongs to.
// - The app's web view has no Notification: a stand-in answers `Notification.permission` and
//   `requestPermission()` with the app's own permission, so Settings, the Pomodoro and reminders
//   offer and show notifications as on the web. Shown at once it is nothing: every alert the app
//   gives is scheduled ahead (above), and the web's way would only come twice.
// - The clock and battery over the page (the status bar) are drawn light on a dark look and dark on
//   a light one: setStatusBar(theme), called whenever the look is applied (js/app.js).
// - A small tap in the hand (haptic) when you switch tabs, tick a box or flip a switch, and a
//   stronger one when a timer ends: haptic(kind).
// Imported first by js/app.js, so the stand-in is there before any module asks.

const cap = globalThis.Capacitor;

/** Running as the iPhone app. */
export const isNative = !!cap?.isNativePlatform?.();

const LN = isNative ? cap.Plugins?.LocalNotifications ?? null : null;
const PERM_KEY = 'lifeos:native-notify';
// One id range per kind (the system wants whole numbers): the rest timer and the Pomodoro have one
// alert each, reminders up to MAX_REMINDERS
const IDS = { rest: [1, 1], pomodoro: [2, 2], reminders: [1000, 999_999] };
// iOS keeps at most 64 waiting; the rest timer and the Pomodoro need room too
const MAX_REMINDERS = 50;

let permission = (() => {
  try {
    return localStorage.getItem(PERM_KEY) || 'default';
  } catch {
    return 'default';
  }
})();

function setPermission(p) {
  permission = p;
  try {
    localStorage.setItem(PERM_KEY, p);
  } catch {
    // (asked again next time)
  }
}

const fromNative = (display) => (display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'default');

/** Ask the phone (the first time it shows its question). -> 'granted' | 'denied' | 'default' | 'unsupported' */
export async function askNative() {
  if (!LN) return 'unsupported';
  try {
    setPermission(fromNative((await LN.requestPermissions()).display));
  } catch (err) {
    console.warn('[native] could not ask for notifications', err);
  }
  return permission;
}

if (LN && typeof globalThis.Notification === 'undefined') {
  globalThis.Notification = class AppNotification {
    constructor() {
      this.onclick = null;
    }

    close() {}

    static get permission() {
      return permission;
    }

    static get maxActions() {
      return 0;
    }

    static requestPermission(done) {
      return askNative().then((p) => {
        done?.(p);
        return p;
      });
    }
  };
  LN.checkPermissions()
    .then((r) => setPermission(fromNative(r.display)))
    .catch(() => {});
}

/** A stable whole number for `key` in `kind`'s range. */
function idFor(kind, key) {
  const [lo, hi] = IDS[kind];
  if (lo === hi) return lo;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return lo + (Math.abs(hash) % (hi - lo + 1));
}

const sent = new Map(); // kind -> what was last handed to the phone
let queue = Promise.resolve();

/**
 * The coming alerts of one kind ('rest' | 'pomodoro' | 'reminders'), replacing what was there:
 * items [{ key, at (ms), title, body, route ('#/training') }]. Past ones are left out. Asks for
 * permission the first time there is something to schedule.
 */
export function scheduleNative(kind, items = []) {
  if (!LN || !IDS[kind]) return Promise.resolve();
  const soon = Date.now() + 1000;
  const future = items
    .filter((i) => Number.isFinite(i.at) && i.at > soon)
    .sort((a, b) => a.at - b.at)
    .slice(0, kind === 'reminders' ? MAX_REMINDERS : 1);
  const sig = JSON.stringify(future.map((i) => [i.key, i.at, i.title, i.body]));
  if (sent.get(kind) === sig) return queue;
  sent.set(kind, sig);
  queue = queue
    .then(async () => {
      const { notifications = [] } = await LN.getPending();
      const mine = notifications.filter((n) => n.extra?.kind === kind || (IDS[kind][0] === IDS[kind][1] && n.id === IDS[kind][0]));
      if (mine.length) await LN.cancel({ notifications: mine.map((n) => ({ id: n.id })) });
      if (!future.length) return;
      if (permission !== 'granted' && (await askNative()) !== 'granted') return;
      await LN.schedule({
        notifications: future.map((i) => ({
          id: idFor(kind, i.key),
          title: i.title,
          body: i.body || '',
          schedule: { at: new Date(i.at), allowWhileIdle: true },
          extra: { kind, key: i.key, route: i.route || '' },
        })),
      });
    })
    .catch((err) => {
      sent.delete(kind);
      console.warn(`[native] could not schedule ${kind}`, err);
    });
  return queue;
}

// A tap on one: LIFE/OS opens (the phone does that) on the page it belongs to
if (LN) {
  LN.addListener?.('localNotificationActionPerformed', ({ notification }) => {
    const route = notification?.extra?.route;
    if (typeof route === 'string' && /^#\/[a-z-]+$/.test(route) && location.hash !== route) location.hash = route;
  });
}

/* ---- The status bar: its text follows the look, not the phone's own light or dark ---- */

const SB = isNative ? cap.Plugins?.StatusBar ?? null : null;
let barStyle = null;

/** `theme` 'light' | 'dark': the look showing. Dark text over a light page, light over a dark one. */
export function setStatusBar(theme) {
  if (!SB) return;
  // Capacitor's names say the page, not the text: DARK = a dark page (light text)
  const style = theme === 'light' ? 'LIGHT' : 'DARK';
  if (style === barStyle) return;
  barStyle = style;
  SB.setStyle({ style }).catch(() => {
    barStyle = null;
  });
}

/* ---- Haptics: the phone's small taps ---- */

const HP = isNative ? cap.Plugins?.Haptics ?? null : null;
const HAPTICS = {
  tap: () => HP.impact({ style: 'LIGHT' }),
  press: () => HP.impact({ style: 'MEDIUM' }),
  done: () => HP.notification({ type: 'SUCCESS' }),
  warn: () => HP.notification({ type: 'WARNING' }),
};

/** 'tap' (a tick, a tab), 'press' (a long press, a drag picked up), 'done' (a timer over), 'warn'. Nothing on the web. */
export function haptic(kind = 'tap') {
  if (!HP || !HAPTICS[kind]) return;
  try {
    HAPTICS[kind]().catch(() => {});
  } catch {
    // (a phone without the motor: nothing to do)
  }
}

// Every tab, tick box and switch answers the finger, wherever a page draws one
const TAPPED = '.tab, [role="checkbox"], [role="switch"], input[type="checkbox"], input[type="radio"], [role="menuitemcheckbox"], [role="menuitemradio"]';
if (HP) {
  document.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && e.target instanceof Element && e.target.closest(TAPPED)) haptic('tap');
    },
    { capture: true, passive: true },
  );
}
