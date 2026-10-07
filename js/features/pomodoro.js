// LIFE/OS — 06 // Pomodoro: focus rounds and breaks. The page (#/pomodoro) runs and sets up the
// timer; a mini timer sits in the middle of the top bar on every page (topbarCenter), and Home
// shows a widget through pomodoroApi. The rules are pure, in pomodoro.logic.js (unit-tested).
//
// One timer for every window. The state lives in the store ('lifeos:v1:pomodoro', synced across
// browser tabs and the installed app) and time left is always computed from endsAt, so a reload,
// a route change, sleep or a throttled background tab never drifts it. Each window keeps a 1 s
// clock only for its own display. When a phase ends, the windows record it under a Web Lock with
// a fresh read of the store (so it lands once), and exactly one window plays the chime and shows
// the desktop notification: the first to claim that session's id under the same lock.

import { h, icon, registerIcon, pageHeader, toast, isTyping, modalOpen, uid, num, term, skin, onSkinChange, onDayChange, plural } from '../ui.js';
import { createStore } from '../store.js';
import * as P from './pomodoro.logic.js';
import { tasksApi } from './tasks.js';

registerIcon('focus', '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>');
registerIcon('coffee', '<path d="M4 9h12v4.5A5.5 5.5 0 0 1 10.5 19h-1A5.5 5.5 0 0 1 4 13.5Z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M12 3.5v2.5M3 21h14"/>');
registerIcon('play', '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z"/>');
registerIcon('pause', '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>');
registerIcon('skip', '<path d="M5 5.2v13.6a.7.7 0 0 0 1.1.6l9.4-6.8a.7.7 0 0 0 0-1.2L6.1 4.6a.7.7 0 0 0-1.1.6Z"/><path d="M19 5v14"/>');
registerIcon('reset', '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>');
registerIcon('bell', '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"/><path d="M10 21h4"/>');
registerIcon('volume', '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>');

const STORAGE_KEY = 'lifeos:v1:pomodoro';
const LOCK_NAME = 'lifeos:pomodoro';
// + ':chime' / ':notice': the session id whose end that window announced (one window each)
const ALERT_KEY = 'lifeos:pomodoro-alert';
const ROUTE = /^#\/pomodoro(?![\w-])/;
const LOG_MAX = 8; // today's sessions listed on the page

const PHASE_ICON = { focus: 'focus', short: 'coffee', long: 'coffee' };
// The mini timer and Home's widget: one short word each
const PHASE_SHORT = { focus: 'Focus', short: 'Break', long: 'Long break' };

/* ==========================================================================
   State: one store shared by the page, the mini timer, the nav badge and Home
   ========================================================================== */

const store = createStore('pomodoro', {});

let memo = { raw: undefined, doc: null };

/** The normalized store value, memoized on the stored object. */
function getDoc() {
  const raw = store.get();
  if (raw !== memo.raw || !memo.doc) memo = { raw, doc: P.normalizePomodoro(raw, Date.now()) };
  return memo.doc;
}

function commit(doc) {
  memo = { raw: doc, doc };
  store.set(doc);
}

/** The store as saved right now: another window's write may not have reached this one yet. */
function readFresh() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text == null ? getDoc() : P.normalizePomodoro(JSON.parse(text), Date.now());
  } catch {
    return getDoc();
  }
}

/** fn() alone across every window of LIFE/OS (a Web Lock), else straight away. -> Promise of fn's result */
function exclusive(fn) {
  const run = () => {
    try {
      return fn();
    } catch (err) {
      console.error('[pomodoro]', err);
      return undefined;
    }
  };
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request(LOCK_NAME, run).catch((err) => console.error('[pomodoro] lock failed', err));
  return Promise.resolve(run());
}

// Who is writing, for the store subscriber below ('boot': the end of a phase found when this window opened)
let writing = null;

/**
 * Apply fn(doc, now) -> doc to the freshest state, after recording any phase that has already
 * ended (so an action never lands on a stale phase). -> Promise<{ before, after }>
 */
function mutate(fn) {
  return exclusive(() => {
    const now = Date.now();
    const base = readFresh();
    const before = P.settle(base, now).doc;
    const after = fn(before, now);
    if (after !== base) commit(after);
    return { before, after };
  });
}

/** Record the current phase if its end has passed (every window tries; the first one writes). */
function settleNow(mode = null) {
  return exclusive(() => {
    const now = Date.now();
    const raw = (() => {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY));
      } catch {
        return undefined;
      }
    })();
    const base = raw == null ? getDoc() : P.normalizePomodoro(raw, now);
    const { doc, completed } = P.settle(base, now);
    // On boot, stored junk is repaired once too (only when something is stored at all)
    const repair = mode === 'boot' && raw != null && JSON.stringify(raw) !== JSON.stringify(base);
    if (!completed && !repair) return;
    writing = mode;
    try {
      commit(doc);
    } finally {
      writing = null;
    }
  });
}

/* ==========================================================================
   The clock: a display tick per window, a precise end timer, and what happens at an end
   ========================================================================== */

const listeners = new Set();
let service = false;
let seen = new Set(); // history ids this window already knows about
let tickTimer = 0;
let endTimer = 0;
let hop = null;
let shownBadge = '';
let shownTitle = '';

/** Everything a view needs at `now`. */
function snapshot(now = Date.now()) {
  const doc = getDoc();
  const { state, settings } = doc;
  const left = P.timeLeft(doc, now);
  const total = P.phaseMs(settings, state.phase);
  return Object.freeze({
    doc,
    settings,
    state,
    phase: state.phase,
    status: state.status,
    round: state.round,
    rounds: settings.roundsBeforeLong,
    left,
    total,
    fraction: total ? left / total : 0,
    clock: P.formatClock(left),
    next: P.nextPhase(state.phase, state.round, settings),
    now,
  });
}

/** fn(snapshot) now, on every change and every second while running. -> unsubscribe */
function subscribeTimer(fn) {
  ensureService();
  listeners.add(fn);
  try {
    fn(snapshot());
  } catch (err) {
    console.error('[pomodoro] view failed', err);
  }
  return () => listeners.delete(fn);
}

function emit() {
  const v = snapshot();
  for (const fn of [...listeners]) {
    try {
      fn(v);
    } catch (err) {
      console.error('[pomodoro] view failed', err);
    }
  }
  // The shell re-reads the nav badge and the window title when they change
  const badge = P.badgeText(v.doc, v.now);
  if (badge !== shownBadge) {
    shownBadge = badge;
    window.dispatchEvent(new CustomEvent('lifeos:badge'));
  }
  const title = P.titleText(v.doc, v.now);
  if (title !== shownTitle) {
    shownTitle = title;
    window.dispatchEvent(new CustomEvent('lifeos:title'));
  }
}

/** The display clock: wakes just after each whole second of the countdown, only while running. */
function scheduleTick() {
  clearTimeout(tickTimer);
  tickTimer = 0;
  const doc = getDoc();
  if (doc.state.status !== 'running') return;
  const left = P.timeLeft(doc, Date.now());
  tickTimer = setTimeout(onTick, (left % 1000 || 1000) + 20);
}

function onTick() {
  tickTimer = 0;
  if (P.isOverdue(getDoc(), Date.now())) settleNow();
  emit();
  scheduleTick();
}

/**
 * The end of the running phase, as its own timer. It is armed from a message event rather than
 * from inside another timer, so a background window's long chain of ticks can't get it
 * throttled to once a minute: the chime comes on time even when no LIFE/OS window is visible.
 */
function armEnd() {
  if (!hop && typeof MessageChannel === 'function') {
    hop = new MessageChannel();
    hop.port1.onmessage = setEndTimer;
  }
  if (hop) hop.port2.postMessage(0);
  else setEndTimer();
}

function setEndTimer() {
  clearTimeout(endTimer);
  endTimer = 0;
  const doc = getDoc();
  if (doc.state.status !== 'running') return;
  endTimer = setTimeout(() => {
    endTimer = 0;
    settleNow();
  }, Math.max(0, doc.state.endsAt - Date.now()) + 25);
}

function onStoreChange() {
  const doc = getDoc();
  const fresh = [];
  for (const e of doc.history) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }
  const done = fresh.filter((e) => e.completed);
  if (done.length) phaseEnded(done[done.length - 1], doc, { boot: writing === 'boot' });
  armEnd();
  scheduleTick();
  emit();
}

function onVisibility() {
  if (document.hidden) return;
  // Timers may have slept: catch up and repaint at once
  settleNow();
  emit();
  scheduleTick();
}

/** Start the clock for this window (once). Every entry point calls it. */
function ensureService() {
  if (service || typeof document === 'undefined') return;
  service = true;
  seen = new Set(getDoc().history.map((e) => e.id));
  store.subscribe(onStoreChange);
  document.addEventListener('visibilitychange', onVisibility);
  // A phase that ended while no window was open counts as finished while you were away
  settleNow('boot');
  armEnd();
  scheduleTick();
}

/* ==========================================================================
   A phase ended: the toast (each visible window), the chime + notification (one window)
   ========================================================================== */

function nextCopy(entry, doc) {
  const s = doc.state;
  const rounds = doc.settings.roundsBeforeLong;
  const len = P.minutesOf(doc.settings, s.phase);
  const running = s.status === 'running';
  if (entry.phase === 'focus') {
    const what = P.PHASE_LABEL[s.phase].toLowerCase();
    return {
      title: 'Focus done',
      text: running ? `Focus done. ${P.PHASE_LABEL[s.phase]} started (${len} min).` : `Focus done. Time for a ${what} (${len} min).`,
      body: running ? `${P.PHASE_LABEL[s.phase]} started: ${len} min.` : `Time for a ${what}: ${len} min.`,
    };
  }
  return {
    title: 'Break over',
    text: running ? `Break over. Focus started, round ${s.round} of ${rounds}.` : `Break over. Ready to focus? Round ${s.round} of ${rounds}.`,
    body: running ? `Focus started: round ${s.round} of ${rounds}.` : `Ready to focus? Round ${s.round} of ${rounds}.`,
  };
}

function phaseEnded(entry, doc, { boot = false } = {}) {
  const now = Date.now();
  const visible = document.visibilityState === 'visible';
  if (boot || P.endedWhileAway(entry.endedAt, now)) {
    // No chime for the past; just say so where someone can read it
    const label = entry.phase === 'focus' ? 'Focus session finished' : `${P.PHASE_LABEL[entry.phase]} ended`;
    if (visible || boot) setTimeout(() => toast(`${label} while you were away.`, { duration: 8000 }), boot ? 900 : 0);
    return;
  }
  if (visible) {
    const copy = nextCopy(entry, doc);
    const idle = doc.state.status === 'idle';
    const startLabel = doc.state.phase === 'focus' ? 'Start focus' : 'Start break';
    toast(copy.text, idle ? { duration: 9000, action: { label: startLabel, onClick: () => act('start') } } : { duration: 6000 });
  }
  alertOnce(entry, doc);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for the first window to claim `what` for this session (under the lock, so only one ever does). */
async function claim(what, id, wait) {
  if (wait) await sleep(wait);
  return exclusive(() => {
    const key = `${ALERT_KEY}:${what}`;
    try {
      if (localStorage.getItem(key) === id) return false;
      localStorage.setItem(key, id);
    } catch {
      // No storage: this window announces it; the lock still keeps the others in line meanwhile
    }
    return true;
  });
}

/**
 * Chime + desktop notification for one ended session, each in exactly one window. Only a window
 * that can play sound competes for the chime (so a window without it never takes it from one
 * with it); a visible window goes first, a hidden one gives it a moment.
 */
async function alertOnce(entry, doc) {
  const { sound, notify } = doc.settings;
  const visible = document.visibilityState === 'visible';
  if (sound && canPlay()) {
    claim('chime', entry.id, visible ? 0 : 400).then((won) => {
      if (won) chime(entry.phase === 'focus' ? 'break' : 'focus');
    });
  }
  if (notify) {
    claim('notice', entry.id, visible ? 0 : 600).then((won) => {
      // With the chime on, the notification stays silent: one sound, not two
      if (won) showNotification(nextCopy(entry, doc), { silent: sound });
    });
  }
}

function notificationState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

function showNotification({ title, body }, { silent }) {
  if (notificationState() !== 'granted') return;
  // Someone is looking at LIFE/OS: the toast and the chime already said it
  if (document.hasFocus()) return;
  try {
    const n = new Notification(title, { body, tag: 'lifeos-pomodoro', icon: 'icons/icon-192.png', silent });
    n.onclick = () => {
      window.focus();
      if (!ROUTE.test(location.hash)) location.hash = '#/pomodoro';
      n.close();
    };
  } catch (err) {
    console.warn('[pomodoro] notification failed', err);
  }
}

/* ---- Sound: a soft bell made with Web Audio on the spot (no audio files) ---- */

const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
let audioCtx = null;

/** Set up sound during a click or key press (browsers only allow it then). */
function primeAudio() {
  if (!AudioCtor) return null;
  try {
    if (!audioCtx) audioCtx = new AudioCtor();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch (err) {
    console.warn('[pomodoro] sound unavailable', err);
    audioCtx = null;
  }
  return audioCtx;
}

const canPlay = () => !!AudioCtor && ((audioCtx && audioCtx.state === 'running') || !!globalThis.navigator?.userActivation?.hasBeenActive);

/** Three bell notes: falling after a focus session ('break'), rising after a break ('focus'). */
function chime(kind = 'break') {
  const ctx = audioCtx ?? (globalThis.navigator?.userActivation?.hasBeenActive ? primeAudio() : null);
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const notes = kind === 'focus' ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25];
    const t0 = ctx.currentTime + 0.05;
    notes.forEach((freq, i) => bell(ctx, freq, t0 + i * 0.24, i === notes.length - 1 ? 1.8 : 1));
    return true;
  } catch (err) {
    console.warn('[pomodoro] chime failed', err);
    return false;
  }
}

function bell(ctx, freq, at, length) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(0.2, at + 0.015);
  out.gain.exponentialRampToValueAtTime(0.0001, at + length);
  out.connect(ctx.destination);
  // A sine with two quiet overtones reads as a bell rather than a beep
  for (const [mult, level] of [
    [1, 1],
    [2.01, 0.2],
    [3.02, 0.07],
  ]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mult, at);
    gain.gain.setValueAtTime(level, at);
    osc.connect(gain);
    gain.connect(out);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

/* ==========================================================================
   Actions (the page, the mini timer, Home, keys)
   ========================================================================== */

const labelOf = (phase) => P.PHASE_LABEL[phase];

/** Undo of reset / skip / a phase switch: puts the timer back while it is still as that action left it. */
function offerUndo(message, { before, after }) {
  const added = after.history.filter((e) => !before.history.some((b) => b.id === e.id)).map((e) => e.id);
  const made = JSON.stringify(after.state);
  toast(message, {
    action: {
      label: 'Undo',
      onClick: () =>
        mutate((doc) => {
          if (JSON.stringify(doc.state) !== made) {
            toast('Nothing undone: the timer changed since.');
            return doc;
          }
          return { ...P.withoutEntries(doc, added), state: before.state };
        }),
    },
  });
}

async function withUndo(fn, message) {
  const r = await mutate(fn);
  if (r && r.after !== r.before) offerUndo(typeof message === 'function' ? message(r.after) : message, r);
  return r;
}

/** 'toggle' | 'start' | 'pause' | 'skip' | 'reset'. Call from a click or key press. */
function act(kind) {
  ensureService();
  // A user gesture is when the browser lets a page set up sound for later
  if (kind !== 'pause' && getDoc().settings.sound) primeAudio();
  switch (kind) {
    case 'toggle':
      return mutate((d, now) => P.toggle(d, now, { id: uid() }));
    case 'start':
      return mutate((d, now) => P.start(d, now, { id: uid() }));
    case 'pause':
      return mutate((d, now) => P.pause(d, now));
    case 'skip':
      return withUndo((d, now) => P.skip(d, now, { id: uid() }), (doc) => `Skipped to ${labelOf(doc.state.phase)}.`);
    case 'reset':
      return withUndo(
        (d, now) => (d.state.status === 'idle' ? P.resetCycle(d, now) : P.reset(d, now)),
        (doc) => (doc.state.phase === 'focus' && doc.state.round === 1 && doc.state.status === 'idle' ? 'Timer reset to round 1.' : 'Timer reset.'),
      );
    default:
      return Promise.resolve();
  }
}

function switchTo(phase) {
  if (getDoc().state.phase === phase && getDoc().state.status === 'idle') return;
  return withUndo((d, now) => P.switchPhase(d, phase, now), `Switched to ${labelOf(phase)}.`);
}

function changeSettings(patch) {
  return mutate((d, now) => P.updateSettings(d, patch, now));
}

/**
 * Desktop notifications on, asking the browser first (call it from a click: browsers only ask
 * then). -> the permission afterwards: 'granted' (and notify is on) | 'denied' | 'default' | 'unsupported'
 */
function enableNotifications() {
  if (notificationState() === 'unsupported') return Promise.resolve('unsupported');
  const asked = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
  return Promise.resolve(asked)
    .catch(() => Notification.permission)
    .then((perm) => (perm === 'granted' ? changeSettings({ notify: true }).then(() => perm) : perm));
}

/** For Home, Settings and the shell: the same timer as the page. */
export const pomodoroApi = Object.freeze({
  subscribe: subscribeTimer,
  snapshot: () => {
    ensureService();
    return snapshot();
  },
  toggle: () => act('toggle'),
  start: () => act('start'),
  pause: () => act('pause'),
  skip: () => act('skip'),
  reset: () => act('reset'),
  /** The timer's settings: { focusMin, …, sound, notify, showMini } */
  settings: () => getDoc().settings,
  /** Change some settings (invalid values are ignored). -> Promise */
  setSettings: (patch) => changeSettings(patch),
  /** The end-of-focus bell, now (call it from a click). -> played? */
  testSound: () => {
    primeAudio();
    return chime('break');
  },
  notificationState,
  enableNotifications,
});

/* ==========================================================================
   Shared bits of view
   ========================================================================== */

/** 'Round 2 of 4' (Simple) or 'Round 02/04'. */
export function roundText(round, rounds) {
  return skin() === 'simple' ? `Round ${round} of ${rounds}` : `Round ${num(round)}/${num(rounds)}`;
}

/** The task being focused on, from Tasks (null when none or it's gone). */
function focusTask(id) {
  return id ? tasksApi.getItems().find((t) => t.id === id) ?? null : null;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function dayBounds(date = new Date()) {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return { from, to };
}

function minutesText(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/* ==========================================================================
   Mini timer: centred in the top bar on every page (docked above the tab bar on phones)
   ========================================================================== */

function mountMini(slot) {
  ensureService();
  const iconEl = h('span', { class: 'pm-mini-icon', 'aria-hidden': 'true' });
  const phaseEl = h('span', { class: 'pm-mini-phase' });
  const digits = h('span', { class: 'pm-mini-digits tnum' });
  const link = h('a', { class: 'pm-mini-link', href: '#/pomodoro' }, iconEl, phaseEl, digits);
  const btn = h('button', { type: 'button', class: 'pm-mini-btn', onClick: () => act('toggle') });
  const el = h('div', { class: 'pm-mini', hidden: true, role: 'group', 'aria-label': 'Pomodoro timer' }, link, btn);
  slot.append(el);

  let shown = { phase: null, status: null, minute: null, skin: null };

  const paint = (v) => {
    const visible = v.status !== 'idle' || v.settings.showMini === 'always';
    el.hidden = !visible;
    if (!visible) return;
    if (digits.textContent !== v.clock) digits.textContent = v.clock;
    const minute = Math.ceil(v.left / 60000);
    const sk = skin();
    if (shown.phase === v.phase && shown.status === v.status && shown.minute === minute && shown.skin === sk) return;
    shown = { phase: v.phase, status: v.status, minute, skin: sk };
    el.dataset.phase = v.phase;
    el.dataset.status = v.status;
    iconEl.replaceChildren(icon(PHASE_ICON[v.phase], { size: 14 }));
    // Paused: the word says so, the icon still tells the phase
    phaseEl.textContent = v.status === 'paused' ? 'Paused' : PHASE_SHORT[v.phase];
    const left = minute === 1 ? 'under a minute left' : `${minute} minutes left`;
    const what = v.status === 'idle' ? `${P.PHASE_LABEL[v.phase]}, ${P.minutesOf(v.settings, v.phase)} minutes, not started` : `${P.PHASE_LABEL[v.phase]}${v.status === 'paused' ? ', paused' : ''}, ${left}`;
    link.setAttribute('aria-label', `${what}. Open the timer`);
    link.title = 'Open the Pomodoro timer';
    const verb = v.status === 'running' ? 'Pause' : v.status === 'paused' ? 'Resume' : `Start ${P.PHASE_LABEL[v.phase].toLowerCase()}`;
    btn.replaceChildren(icon(v.status === 'running' ? 'pause' : 'play', { size: 14 }));
    btn.setAttribute('aria-label', verb);
    btn.title = verb;
  };

  const off = subscribeTimer(paint);
  const offSkin = onSkinChange(() => {
    shown = { ...shown, skin: null };
    paint(snapshot());
  });
  return () => {
    off();
    offSkin();
    el.remove();
  };
}

/* ==========================================================================
   The page
   ========================================================================== */

function stepper({ key, label, unit, min, max, hint }) {
  const id = `pm-set-${key}`;
  const input = h('input', { class: 'input pm-step-input tnum', id, type: 'number', inputmode: 'numeric', min: String(min), max: String(max), step: '1', 'aria-describedby': `${id}-unit` });
  const apply = (value) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return false;
    changeSettings({ [key]: Math.min(max, Math.max(min, n)) });
    return true;
  };
  input.addEventListener('change', () => {
    if (!apply(input.value)) input.value = String(getDoc().settings[key]);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  const nudge = (d) => apply(getDoc().settings[key] + d);
  const less = h('button', { type: 'button', class: 'btn btn--sm btn--icon pm-step-btn', 'aria-label': `Less: ${label}`, title: 'Less', onClick: () => nudge(-1) }, icon('minus', { size: 14 }));
  const more = h('button', { type: 'button', class: 'btn btn--sm btn--icon pm-step-btn', 'aria-label': `More: ${label}`, title: 'More', onClick: () => nudge(1) }, icon('plus', { size: 14 }));
  const row = h(
    'div',
    { class: 'pm-step', dataset: { key } },
    h('label', { class: 'pm-step-label', for: id }, label, hint ? h('span', { class: 'pm-step-hint' }, hint) : null),
    h('div', { class: 'pm-step-ctl' }, less, input, h('span', { class: 'pm-step-unit', id: `${id}-unit` }, unit), more),
  );
  return {
    row,
    paint(settings) {
      const v = settings[key];
      if (document.activeElement !== input && input.value !== String(v)) input.value = String(v);
      less.disabled = v <= min;
      more.disabled = v >= max;
    },
  };
}

function switchRow({ label, hint, onToggle }) {
  const btn = h(
    'button',
    { type: 'button', class: 'pm-switch', role: 'switch', 'aria-checked': 'false', onClick: () => onToggle(btn.getAttribute('aria-checked') !== 'true') },
    h('span', { class: 'pm-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'pm-switch-thumb' })),
    h('span', { class: 'pm-switch-text' }, h('span', { class: 'pm-switch-label' }, label), hint ? h('span', { class: 'pm-switch-hint' }, hint) : null),
  );
  return {
    el: btn,
    set(on) {
      btn.setAttribute('aria-checked', String(!!on));
    },
  };
}

function mount(root) {
  ensureService();
  root.classList.add('pm-page');
  const simple = skin() === 'simple';

  const header = pageHeader({
    index: '06',
    title: 'Pomodoro',
    subtitle: term('pomodoro.subtitle', 'Focus in rounds, rest in between. One timer for every window, running on every page.'),
  });

  /* ---- Timer ---- */

  const phaseBtns = P.PHASES.map((phase) =>
    h('button', { type: 'button', class: 'seg-btn pm-phase-btn', 'aria-pressed': 'false', dataset: { phase }, onClick: () => switchTo(phase) }, P.PHASE_LABEL[phase]),
  );
  const phaseSeg = h('div', { class: 'seg pm-phases', role: 'group', 'aria-label': 'Phase' }, phaseBtns);

  const ticks = h('div', { class: 'pm-ticks lo-deco', 'aria-hidden': 'true' });
  for (let i = 0; i < 60; i++) ticks.append(h('span', { class: ['pm-tick', i % 5 === 0 && 'is-major'], style: { transform: `rotate(${i * 6}deg)` } }));
  const ringEl = ringOf();
  const dialPhase = h('div', { class: 'pm-dial-phase label' });
  const digits = h('div', { class: 'pm-digits tnum', role: 'timer', 'aria-atomic': 'true' });
  const dialRound = h('div', { class: 'pm-dial-round' });
  const dial = h('div', { class: 'pm-dial' }, ticks, ringEl, h('div', { class: 'pm-dial-center' }, dialPhase, digits, dialRound));

  const resetBtn = h('button', { type: 'button', class: 'btn pm-ctl pm-reset', 'aria-label': 'Reset', 'aria-keyshortcuts': 'R', onClick: () => act('reset') }, icon('reset'), h('span', null, 'Reset'));
  const mainBtn = h('button', { type: 'button', class: 'btn btn--primary pm-ctl pm-main', 'aria-keyshortcuts': 'Space', onClick: () => act('toggle') });
  const skipBtn = h('button', { type: 'button', class: 'btn pm-ctl pm-skip', 'aria-keyshortcuts': 'S', onClick: () => act('skip') }, icon('skip'), h('span', null, 'Skip'));
  const hints = h(
    'div',
    { class: 'pm-hints lo-hint', 'aria-hidden': 'true' },
    h('span', null, h('span', { class: 'kbd' }, 'Space'), ' start / pause'),
    h('span', null, h('span', { class: 'kbd' }, 'R'), ' reset'),
    h('span', null, h('span', { class: 'kbd' }, 'S'), ' skip'),
  );

  const taskSelect = h('select', { class: 'select pm-task-select', id: 'pm-task' });
  taskSelect.addEventListener('change', () => mutate((d) => P.setTask(d, taskSelect.value || null)));
  const taskField = h('div', { class: 'field pm-task' }, h('label', { class: 'label', for: 'pm-task' }, 'Focusing on'), taskSelect);

  const timerCard = h(
    'section',
    { class: 'panel hud pm-timer', 'aria-label': 'Timer' },
    phaseSeg,
    dial,
    h('div', { class: 'pm-controls' }, resetBtn, mainBtn, skipBtn),
    hints,
    taskField,
  );

  /* ---- Today ---- */

  const todayBody = h('div', { class: 'pm-today-body' });
  const todayCard = h('section', { class: 'panel pm-today', 'aria-labelledby': 'pm-today-title' }, h('h2', { class: 'pm-card-title', id: 'pm-today-title' }, 'Today'), todayBody);

  /* ---- Settings ---- */

  const presetBtns = [...P.PRESETS, { id: 'custom', label: 'Custom' }].map((p) =>
    h(
      'button',
      {
        type: 'button',
        class: 'pm-preset',
        'aria-pressed': 'false',
        dataset: { preset: p.id },
        onClick: () => (p.id === 'custom' ? steppers[0].row.querySelector('input').focus() : mutate((d, now) => P.applyPreset(d, p.id, now))),
      },
      h('span', { class: 'pm-preset-name' }, p.label),
      p.id === 'custom' ? h('span', { class: 'pm-preset-sub' }, 'Your own') : h('span', { class: 'pm-preset-sub tnum' }, `${p.focusMin} · ${p.shortMin} · ${p.longMin} ×${p.roundsBeforeLong}`),
    ),
  );
  const steppers = [
    stepper({ key: 'focusMin', label: 'Focus', unit: 'min', min: P.MIN_MINUTES, max: P.MAX_MINUTES }),
    stepper({ key: 'shortMin', label: 'Short break', unit: 'min', min: P.MIN_MINUTES, max: P.MAX_MINUTES }),
    stepper({ key: 'longMin', label: 'Long break', unit: 'min', min: P.MIN_MINUTES, max: P.MAX_MINUTES }),
    stepper({ key: 'roundsBeforeLong', label: 'Long break after', unit: 'rounds', min: P.MIN_ROUNDS, max: P.MAX_ROUNDS }),
  ];
  const autoBreaks = switchRow({ label: 'Start breaks by themselves', hint: 'When a focus session ends', onToggle: (on) => changeSettings({ autoStartBreaks: on }) });
  const autoFocus = switchRow({ label: 'Start focus by itself', hint: 'When a break ends', onToggle: (on) => changeSettings({ autoStartFocus: on }) });
  const soundSw = switchRow({
    label: 'Sound',
    hint: 'A soft chime when a phase ends',
    onToggle: (on) => {
      if (on) primeAudio();
      changeSettings({ sound: on });
    },
  });
  const testBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--sm pm-test',
      onClick: () => {
        primeAudio();
        if (!chime('break')) toast('This browser can’t play the chime.');
      },
    },
    icon('volume', { size: 14 }),
    'Test sound',
  );
  const notifyText = h('p', { class: 'pm-notify-text' });
  const notifyBtn = h('button', { type: 'button', class: 'btn btn--sm pm-notify-btn', onClick: () => onNotifyClick() });
  const miniBtns = P.MINI_MODES.map((mode) =>
    h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { mode }, onClick: () => changeSettings({ showMini: mode }) }, mode === 'active' ? 'While running' : 'Always'),
  );

  const settingsCard = h(
    'section',
    { class: 'panel pm-settings', 'aria-labelledby': 'pm-settings-title' },
    h('h2', { class: 'pm-card-title', id: 'pm-settings-title' }, simple ? 'Set up your timer' : 'Timer settings'),
    h('div', { class: 'pm-presets', role: 'group', 'aria-label': 'Presets' }, presetBtns),
    h('div', { class: 'pm-steps' }, steppers.map((s) => s.row)),
    h('div', { class: 'pm-switches' }, autoBreaks.el, autoFocus.el),
    h('div', { class: 'pm-sound' }, soundSw.el, testBtn),
    h('div', { class: 'pm-notify' }, h('div', { class: 'pm-notify-head' }, icon('bell', { size: 16 }), h('span', { class: 'pm-switch-label' }, 'Desktop notifications')), notifyText, notifyBtn),
    h('div', { class: 'pm-mini-pref' }, h('span', { class: 'pm-switch-label', id: 'pm-mini-label' }, 'Mini timer in the top bar'), h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'pm-mini-label' }, miniBtns)),
  );

  root.append(header, h('div', { class: 'pm-layout' }, h('div', { class: 'pm-stack' }, timerCard, todayCard), settingsCard));

  /* ---- Painting ---- */

  let shownDoc = null;
  let shownDay = '';

  function paintTimer(v) {
    root.dataset.phase = v.phase;
    root.dataset.status = v.status;
    timerCard.dataset.phase = v.phase;
    timerCard.dataset.status = v.status;
    phaseBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.phase === v.phase)));
    ringEl.setValue(v.fraction);
    if (digits.textContent !== v.clock) digits.textContent = v.clock;
    const left = Math.ceil(v.left / 60000);
    digits.setAttribute('aria-label', `${left} ${left === 1 ? 'minute' : 'minutes'} left`);
    dialPhase.textContent = v.status === 'paused' ? `${P.PHASE_LABEL[v.phase]} · Paused` : P.PHASE_LABEL[v.phase];
    dialRound.textContent = roundText(v.round, v.rounds);
    const verb = v.status === 'running' ? 'Pause' : v.status === 'paused' ? 'Resume' : 'Start';
    if (mainBtn.dataset.verb !== verb) {
      mainBtn.dataset.verb = verb;
      mainBtn.replaceChildren(icon(v.status === 'running' ? 'pause' : 'play', { size: 18 }), h('span', null, verb));
    }
    const atStart = v.status === 'idle' && v.phase === 'focus' && v.round === 1;
    resetBtn.disabled = atStart;
    resetBtn.title = v.status === 'idle' ? 'Back to round 1 (R)' : 'Put this phase back to its full length (R)';
    skipBtn.title = `Skip to ${P.PHASE_LABEL[v.next.phase]} (S)`;
    skipBtn.setAttribute('aria-label', `Skip to ${P.PHASE_LABEL[v.next.phase]}`);
  }

  function paintTasks(doc = getDoc()) {
    const current = doc.state.taskId;
    const open = tasksApi.getItems().filter((t) => !t.done);
    const options = [h('option', { value: '' }, 'Nothing in particular')];
    for (const t of open) options.push(h('option', { value: t.id }, t.title));
    const cur = current && !open.some((t) => t.id === current) ? focusTask(current) : null;
    if (current && !open.some((t) => t.id === current)) options.push(h('option', { value: current }, cur ? `✓ ${cur.title}` : 'A deleted task'));
    taskSelect.replaceChildren(...options);
    taskSelect.value = current ?? '';
  }

  function paintSettings(doc) {
    const s = doc.settings;
    const preset = P.presetOf(s);
    presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
    steppers.forEach((st) => st.paint(s));
    autoBreaks.set(s.autoStartBreaks);
    autoFocus.set(s.autoStartFocus);
    soundSw.set(s.sound);
    testBtn.disabled = !AudioCtor;
    miniBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === s.showMini)));
    paintNotify(s);
  }

  function paintNotify(s = getDoc().settings) {
    const state = notificationState();
    let text;
    let btn = null;
    if (state === 'unsupported') text = 'This browser can’t show desktop notifications.';
    else if (state === 'denied') text = 'Blocked in the browser. Allow notifications for this site in the browser’s settings, then come back.';
    else if (s.notify && state === 'granted') {
      text = 'On: a notification when a phase ends while you’re in another app.';
      btn = 'Turn off';
    } else {
      text = 'Get a notification when a phase ends while you’re in another app.';
      btn = 'Enable desktop notifications';
    }
    notifyText.textContent = text;
    notifyBtn.hidden = !btn;
    if (btn) notifyBtn.replaceChildren(icon('bell', { size: 14 }), btn);
  }

  function onNotifyClick() {
    const s = getDoc().settings;
    if (s.notify && notificationState() === 'granted') {
      changeSettings({ notify: false }).then(() => paintNotify());
      return;
    }
    if (notificationState() === 'unsupported') return;
    // Ask only here, from this click
    const asked = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    Promise.resolve(asked)
      .catch(() => Notification.permission)
      .then((perm) => {
        if (perm === 'granted') {
          changeSettings({ notify: true }).then(() => paintNotify());
          toast('Desktop notifications are on.');
        } else {
          if (perm === 'denied') toast('Notifications are blocked for LIFE/OS. Allow them in the browser’s site settings.', { duration: 7000 });
          paintNotify();
        }
      });
  }

  function paintToday(doc) {
    const { from, to } = dayBounds();
    const stats = P.focusStats(doc.history, from, to);
    const entries = [...stats.entries].reverse();
    const body = [];
    if (simple) {
      body.push(
        h(
          'p',
          { class: 'pm-today-line' },
          stats.sessions
            ? `You finished ${plural(stats.sessions, 'focus session')} today, ${minutesText(stats.minutes)} in all.`
            : stats.minutes
              ? `${minutesText(stats.minutes)} of focus today so far.`
              : 'No focus sessions yet today. Press Start when you’re ready.',
        ),
      );
    } else {
      body.push(
        h(
          'div',
          { class: 'pm-today-stats' },
          h('div', { class: 'stat' }, h('span', { class: 'stat-value tnum' }, num(stats.sessions)), h('span', { class: 'label' }, stats.sessions === 1 ? 'Session done' : 'Sessions done')),
          h('div', { class: 'stat' }, h('span', { class: 'stat-value tnum' }, num(Math.round(stats.minutes))), h('span', { class: 'label' }, 'Focus minutes')),
        ),
      );
      if (!entries.length) body.push(h('p', { class: 'pm-today-empty' }, 'No focus sessions yet today.'));
    }
    if (entries.length) {
      const shown = entries.slice(0, LOG_MAX);
      body.push(
        h(
          'ol',
          { class: 'pm-log', 'aria-label': 'Focus sessions today, newest first' },
          shown.map((e) => {
            const task = focusTask(e.taskId);
            return h(
              'li',
              { class: ['pm-log-row', !e.completed && 'is-partial'] },
              h('span', { class: 'pm-log-time tnum' }, e.startedAt ? `${hhmm(e.startedAt)}–${hhmm(e.endedAt)}` : hhmm(e.endedAt)),
              h('span', { class: 'pm-log-what' }, task ? task.title : 'Focus', !e.completed ? h('span', { class: 'pm-log-tag' }, 'stopped early') : null),
              h('span', { class: 'pm-log-min tnum' }, minutesText(e.minutes)),
            );
          }),
        ),
      );
      if (entries.length > shown.length) body.push(h('p', { class: 'pm-today-more' }, `and ${plural(entries.length - shown.length, 'earlier session')}`));
    }
    todayBody.replaceChildren(...body);
  }

  const offTimer = subscribeTimer((v) => {
    paintTimer(v);
    const day = new Date().toDateString();
    if (v.doc !== shownDoc || day !== shownDay) {
      const settingsChanged = !shownDoc || v.doc.settings !== shownDoc.settings;
      const historyChanged = !shownDoc || v.doc.history !== shownDoc.history || day !== shownDay;
      const taskChanged = !shownDoc || v.doc.state.taskId !== shownDoc.state.taskId;
      shownDoc = v.doc;
      shownDay = day;
      if (settingsChanged) paintSettings(v.doc);
      if (historyChanged) paintToday(v.doc);
      if (taskChanged) paintTasks(v.doc);
    }
  });
  const offTasks = tasksApi.subscribe(() => {
    paintTasks();
    paintToday(getDoc());
  });
  const offDay = onDayChange(() => paintToday(getDoc()));
  // Permission can change in the browser's settings meanwhile
  const onFocus = () => paintNotify();
  window.addEventListener('focus', onFocus);

  function onKeydown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
    if (e.target instanceof Element && e.target.closest('.ctx-menu')) return;
    const key = e.key.toLowerCase();
    if (key === ' ' || e.code === 'Space') {
      // A focused button or link takes Space itself
      if (e.target instanceof Element && e.target.closest('button, a[href], select, [role="switch"]')) return;
      e.preventDefault();
      act('toggle');
    } else if (key === 'r' && !e.shiftKey) {
      e.preventDefault();
      act('reset');
    } else if (key === 's' && !e.shiftKey) {
      e.preventDefault();
      act('skip');
    }
  }
  document.addEventListener('keydown', onKeydown);

  return () => {
    offTimer();
    offTasks();
    offDay();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('keydown', onKeydown);
  };
}

/** The dial's ring: the shared ui ring look (track + fill), sized by CSS. */
function ringOf() {
  const size = 300;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const circle = (cls) => {
    const el = document.createElementNS(ns, 'circle');
    el.setAttribute('class', cls);
    el.setAttribute('cx', String(size / 2));
    el.setAttribute('cy', String(size / 2));
    el.setAttribute('r', String(r));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', String(stroke));
    return el;
  };
  const track = circle('ring-track');
  const fill = circle('ring-fill pm-ring-fill');
  fill.setAttribute('stroke-dasharray', String(c));
  fill.setAttribute('stroke-dashoffset', String(c));
  svg.append(track, fill);
  const el = h('div', { class: 'ring pm-ring' });
  el.append(svg);
  let shown = -1;
  el.setValue = (v) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    if (Math.abs(clamped - shown) < 1e-4) return;
    shown = clamped;
    fill.style.strokeDashoffset = String(c * (1 - clamped));
    fill.style.opacity = clamped === 0 ? '0' : '1';
  };
  return el;
}

// The clock runs from the moment the app loads, whichever page opens first
if (typeof document !== 'undefined') ensureService();

export default {
  id: 'pomodoro',
  title: 'Pomodoro',
  icon: 'timer',
  badge() {
    return P.badgeText(getDoc(), Date.now());
  },
  windowTitle() {
    return P.titleText(getDoc(), Date.now());
  },
  mount,
  topbarCenter(slot) {
    return mountMini(slot);
  },
};
