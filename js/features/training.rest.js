// LIFE/OS — Training's rest timer: one countdown between sets, there whether a workout is going or
// not. Pick a length (2:00 …), press Start, and it counts down on every page: the pill in the top
// bar, or on a phone a chip floating above the tab bar. When the rest is over it rings (watch
// beeps, js/sounds.js), a phone buzzes, a message says so on any page, and a notification comes
// when you are in another app or tab. Ticking a set in a workout starts it too.
//
// Pure rules in training.rest.logic.js. Store 'training-rest' stays on this device (Sync leaves
// it alone: you rest on the phone in your hand); every window of LIFE/OS on it shares the timer,
// and exactly one of them rings and notifies (the claim below, as the Pomodoro does).
//
//   restControl()    the control on the Training page (and in a workout's bar) -> { el, destroy }
//   startRestNow()   start it with the length picked (a ticked set)
//   watchRest()      the alarm, once per window (Training's top-bar widget starts it)
//   restSnapshot()   { phase, left, sec } for the pill

import { h, icon, registerIcon, toast, dropdown, promptDialog } from '../ui.js';
import { createStore } from '../store.js';
import { play, prime, canPlay } from '../sounds.js';
import { notificationState, askPermission } from '../reminders.js';
import * as R from './training.rest.logic.js';

registerIcon('tr-stop', '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>');

const store = createStore('training-rest', R.DEFAULT_REST);
const ROUTE = '#/training';
const ALERT_KEY = 'lifeos:rest-alert';
const SOUND = 'digital';

export const restState = () => R.normalizeRest(store.get());
export const subscribeRest = (fn) => store.subscribe(fn);

function change(fn) {
  const cur = restState();
  const next = fn(cur, Date.now());
  if (next !== cur) store.set(next);
}

/** Start now (sound is allowed from here on: this runs in a click, a key press or a tick). */
export function startRestNow(sec) {
  prime();
  change((r, now) => R.startRest(r, now, sec));
}

export const stopRestNow = () => change((r) => R.stopRest(r));
export const nudgeRestNow = (delta) => change((r, now) => R.nudgeRest(r, delta, now));
const setLength = (sec) => change((r) => R.setRestLength(r, sec));
const setSound = (sound) => change((r) => ({ ...r, sound }));

/** What the pill and the control show now. */
export function restSnapshot(now = Date.now()) {
  const r = restState();
  return { phase: R.restPhase(r, now), left: R.restLeft(r, now), sec: r.sec, sound: r.sound };
}

/* ==========================================================================
   The alarm: once per rest, in exactly one window
   ========================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for the first window to claim `what` for this rest (under a lock, so only one ever does). */
async function claim(what, id, wait) {
  if (wait) await sleep(wait);
  const take = () => {
    const key = `${ALERT_KEY}:${what}`;
    try {
      if (localStorage.getItem(key) === id) return false;
      localStorage.setItem(key, id);
    } catch {
      // No storage: this window rings; the lock still keeps the others in line meanwhile
    }
    return true;
  };
  try {
    if (navigator.locks?.request) return await navigator.locks.request(ALERT_KEY, take);
  } catch {
    // Locks refused (site data blocked): fall through
  }
  return take();
}

/**
 * Shown through the service worker when there is one (phones only show that kind; its click is
 * sw.js's, which brings LIFE/OS to the front and says so: the listener below opens Training).
 */
async function notify(silent) {
  if (notificationState() !== 'granted') return;
  // Someone is looking at LIFE/OS: the message and the beeps already said it
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const iconUrl = new URL('icons/icon-192.png', document.baseURI).href;
  const options = { body: 'Time for the next set.', tag: 'lifeos-rest', renotify: true, icon: iconUrl, badge: iconUrl, silent, vibrate: [200, 100, 200], data: { route: ROUTE } };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.active) {
      await registration.showNotification('Rest is over', options);
      return;
    }
  } catch (err) {
    console.warn('[training] rest notification through the service worker failed', err);
  }
  try {
    const { renotify: _r, vibrate: _v, ...plain } = options;
    const n = new Notification('Rest is over', plain);
    n.onclick = () => {
      window.focus();
      location.hash = ROUTE;
      n.close();
    };
  } catch (err) {
    console.warn('[training] rest notification failed', err);
  }
}

function ring(r) {
  const id = String(r.endsAt);
  const visible = document.visibilityState === 'visible';
  if (visible) {
    toast('Rest is over: time for the next set.', { duration: 6000, key: 'tr-rest-over', action: { label: 'Rest again', onClick: () => startRestNow() } });
    navigator.vibrate?.([200, 100, 200]);
  }
  // Only a window that can play sound competes for the beeps; a visible one goes first
  const beeps = r.sound && canPlay();
  if (beeps) {
    claim('sound', id, visible ? 0 : 400).then((won) => {
      if (won) play(SOUND);
    });
  }
  claim('notice', id, visible ? 0 : 600).then((won) => {
    if (won) notify(beeps);
  });
}

let watching = false;

/** Ring when a rest ends: started once per window, whatever page it shows. */
export function watchRest() {
  if (watching) return;
  watching = true;
  // A rest that was already over when this window opened (a reload, LIFE/OS opened later) is
  // not rung again
  let rung = restState().endsAt && restState().endsAt <= Date.now() ? restState().endsAt : null;
  const check = () => {
    const r = restState();
    const now = Date.now();
    if (!r.endsAt || r.endsAt > now || rung === r.endsAt) return;
    rung = r.endsAt;
    if (now - r.endsAt < R.LATE_MS) ring(r);
  };
  setInterval(check, 500);
  // Back from the background (a phone may have paused this window): check at once
  document.addEventListener('visibilitychange', check);
  store.subscribe(check);
}

// sw.js says the rest notification was clicked and this window is the one it brought forward
try {
  globalThis.navigator?.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'lifeos:notification-click' && e.data.route === ROUTE && !location.hash.startsWith(ROUTE)) location.hash = ROUTE;
  });
} catch {
  // No service workers here: the page's own notification handles its click
}

/* ==========================================================================
   The control: pick a length and start · the countdown with −15 s, +15 s and Stop
   ========================================================================== */

const iconBtn = (iconName, label, onClick, extra = {}) =>
  h('button', { type: 'button', class: ['btn btn--sm btn--ghost tr-rest-btn', extra.className], title: label, 'aria-label': label, onClick }, icon(iconName, { size: 14 }), extra.text ? h('span', null, extra.text) : null);

function noticeItem() {
  const state = notificationState();
  if (state === 'granted' || state === 'unsupported') return null;
  if (state === 'denied') return { label: 'Notifications are blocked: allow them for LIFE/OS in the browser’s site settings', action: () => {}, disabled: true };
  return {
    label: 'Notify me when rest is over',
    action: () =>
      askPermission().then((perm) => {
        if (perm === 'granted') toast('Done: a notification comes when rest is over and you’re in another app or tab.');
        else if (perm === 'denied') toast('The browser blocked notifications. Allow them for LIFE/OS in its site settings.', { duration: 7000 });
      }),
  };
}

function customLength() {
  const r = restState();
  promptDialog({
    title: 'Rest length',
    label: 'Minutes:seconds, like 2:30 (or 90s, 3 min)',
    value: R.lengthText(r.sec),
    confirmLabel: 'Set',
    maxLength: 12,
    validate: (v) => (R.parseLength(v) == null ? 'Type a length from 0:15 to 10:00, like 2:30.' : ''),
  }).then((v) => {
    const sec = v == null ? null : R.parseLength(v);
    if (sec != null) setLength(sec);
  });
}

/**
 * The rest timer as a row: [Rest] [2:00 ▾] [Start] when ready; [Rest] 1:43 [−15] [+15] [Stop] while
 * it counts down; [Rest over] Go! [Rest again] for a moment after. -> { el, destroy }
 */
export function restControl() {
  const labelEl = h('span', { class: 'label tr-rest-label' }, 'Rest');
  const timeEl = h('span', { class: 'tr-rest-time tnum', 'aria-hidden': 'true' });
  const ctl = h('div', { class: 'tr-rest-ctl' });
  // Read out on a change of phase (started, over), not every second
  const said = h('span', { class: 'sr-only', role: 'status' });
  const el = h('div', { class: 'tr-rest', role: 'group', 'aria-label': 'Rest timer' }, icon('tr-rest', { size: 16 }), labelEl, timeEl, ctl, said);
  let shownPhase = null;
  let shownKey = '';

  function controls(snap) {
    if (snap.phase === 'running') {
      return [
        iconBtn('minus', '15 seconds less rest', () => nudgeRestNow(-15)),
        iconBtn('plus', '15 seconds more rest', () => nudgeRestNow(15)),
        iconBtn('tr-stop', 'Stop the rest', () => stopRestNow(), { className: 'tr-rest-main' }),
      ];
    }
    if (snap.phase === 'over') return [iconBtn('undo', 'Rest again', () => startRestNow(), { className: 'tr-rest-main', text: 'Again' })];
    const notice = noticeItem();
    const picker = dropdown({
      items: [
        ...R.REST_PRESETS.map((sec) => ({ value: sec, label: R.lengthWords(sec) })),
        ...(R.REST_PRESETS.includes(snap.sec) ? [] : [{ value: snap.sec, label: `${R.lengthWords(snap.sec)} (yours)` }]),
        { separator: true },
        { label: 'Other length…', action: customLength },
        { label: snap.sound ? 'Sound at the end: on (turn off)' : 'Sound at the end: off (turn on)', action: () => setSound(!snap.sound) },
        ...(notice ? [notice] : []),
      ],
      value: snap.sec,
      onSelect: (sec) => setLength(sec),
      showValue: false,
      label: R.lengthText(snap.sec),
      className: 'tr-rest-len',
      title: 'How long to rest',
      ariaLabel: () => `Rest length: ${R.lengthWords(restState().sec)}. Change it`,
      menuLabel: 'Rest length',
    });
    const start = h(
      'button',
      { type: 'button', class: 'btn btn--sm btn--primary tr-rest-start tr-rest-main', title: `Start ${R.lengthWords(snap.sec)} of rest`, 'aria-label': `Start ${R.lengthWords(snap.sec)} of rest`, onClick: () => startRestNow() },
      icon('play', { size: 13 }),
      h('span', null, 'Start'),
    );
    return [picker.el, start];
  }

  function paint() {
    const snap = restSnapshot();
    el.classList.toggle('is-running', snap.phase === 'running');
    el.classList.toggle('is-over', snap.phase === 'over');
    el.classList.toggle('is-idle', snap.phase === 'idle');
    labelEl.textContent = snap.phase === 'over' ? 'Rest over' : 'Rest';
    timeEl.textContent = snap.phase === 'running' ? R.lengthText(snap.left) : snap.phase === 'over' ? 'Go!' : '';
    timeEl.hidden = snap.phase === 'idle';
    // Rebuilt only when what it offers changes, so a button in use keeps the keyboard
    const key = `${snap.phase}:${snap.phase === 'idle' ? `${snap.sec}:${snap.sound}:${notificationState()}` : ''}`;
    if (key === shownKey) return;
    const hadFocus = ctl.contains(document.activeElement);
    shownKey = key;
    ctl.replaceChildren(...controls(snap));
    if (hadFocus) ctl.querySelector('.tr-rest-main')?.focus({ preventScroll: true });
    if (shownPhase !== null && shownPhase !== snap.phase) {
      said.textContent = snap.phase === 'running' ? `Rest started: ${R.lengthWords(snap.left)}.` : snap.phase === 'over' ? 'Rest is over.' : '';
    }
    shownPhase = snap.phase;
  }

  paint();
  const timer = setInterval(paint, 250);
  const off = subscribeRest(paint);
  return {
    el,
    destroy() {
      clearInterval(timer);
      off();
    },
  };
}
