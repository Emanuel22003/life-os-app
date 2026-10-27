// LIFE/OS — reminders: the engine. js/app.js starts it once (startReminders()).
//
// It reads tasks (tasksApi) and calendar events (calendar.store.js) and never writes them, except
// when you ask it to from a reminder (Done on a task, which goes through tasksApi.complete). It
// plans the next PLAN_DAYS days of moments (js/reminders.plan.js: every reminder of every open
// task with a date and every event date, repeats expanded), keeps one timer for the next one and
// plans again on any change of tasks, events or Settings → Reminders, when the window comes back,
// on a new day, and at least every minute (a computer that slept doesn't run timers).
//
// Firing a reminder, once per device:
// - a notification (through the service worker, the only kind phones show; its click is
//   notificationclick in sw.js, which brings LIFE/OS to the front on the item, or opens it there),
//   with Snooze 10 min (and Done for a task) where the browser shows buttons. Not while you're
//   looking at LIFE/OS: the banner and the sound say it then.
// - its sound, played here (js/sounds.js). The notification is silent when the sound played, so it
//   never rings twice.
// - a banner in the app: the name, when, Open · Snooze · Done. It stays until you close it.
// Several windows: each reminder is claimed under a lock in the fired log, so one window fires it.
//
// The honest limit: there is no server, so a reminder fires only while LIFE/OS is open on the
// device (any window or tab, in the background too; the installed app counts). One that came due
// while it was closed (or asleep) shows when it opens, in one calm "Missed reminders" list (the
// last 24 hours, the task still open, the event not long over), never as a burst of notifications.
//
// On this device only (localStorage, never synced, not in backups):
//   lifeos:reminders-fired    { since, keys: { [reminder key]: firedAt } }, pruned after 30 days
//   lifeos:reminders-snoozed  [{ key, at, base, kind, id, occurrence, before, sound }]

import { h, icon, toast, onDayChange, plural } from './ui.js';
import { settings, savingAllowed } from './store.js';
import { isRealAddress } from './origin.js';
import {
  PLAN_DAYS,
  MISSED_WINDOW_MS,
  SNOOZE_MINUTES,
  planMoments,
  sortOut,
  isFired,
  readFiredLog,
  pruneFired,
  addSnooze,
  pruneSnoozes,
  baseKey,
  describeMoment,
  missedList,
  stillRelevant,
  groupForFiring,
  targetOf,
  reminderQuery,
  readReminderQuery,
  withoutReminderQuery,
  dayKeyOf,
} from './reminders.plan.js';
import { play, prime, canPlay } from './sounds.js';
import { reminderSettings } from './reminders.ui.js';

const FIRED_KEY = 'lifeos:reminders-fired';
const SNOOZE_KEY = 'lifeos:reminders-snoozed';
const LOCK_NAME = 'lifeos-reminders';
const GUARD_MS = 60_000; // plan again at least this often
const DAY_MS = 86_400_000;
const MAX_CARDS = 3;
const TEST_DELAY_MS = 4000;

let tasksApi = null;
let calendarApi = null;
let getEvents = () => [];
let started = false;
let timer = 0;
let pending = 0;
let clockOffset = 0; // test copies only: shift the engine's clock (window.lifeosReminders)
let lastOn = null;

const now = () => Date.now() + clockOffset;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ==========================================================================
   Device-only storage: the fired log and the snoozes
   ========================================================================== */

// When localStorage can't be used at all (blocked site data): this window's own memory
const memory = new Map();

/** A stored value (undefined: none). Falls back to this window's memory only when storage fails. */
function readJson(key) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return memory.get(key);
  }
  try {
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(key, value) {
  // After Delete all my data nothing is written again (store.js stopSaving)
  if (!savingAllowed()) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    memory.set(key, value);
    return false;
  }
}

/** The fired log, cleaned; a device without one starts keeping reminders now (saved at once). */
function loadLog(at = now()) {
  const raw = readJson(FIRED_KEY);
  const log = readFiredLog(raw, at);
  if (!raw || raw.since !== log.since) saveLog(log);
  return log;
}

function saveLog(log) {
  writeJson(FIRED_KEY, log);
}

function loadSnoozes(at = now(), keys = loadLog(at).keys) {
  return pruneSnoozes(readJson(SNOOZE_KEY), keys, at);
}

function saveSnoozes(list) {
  writeJson(SNOOZE_KEY, list);
}

/** Run fn alone among every LIFE/OS window of this device (Web Locks; without them, at once). */
function exclusive(fn) {
  const run = () => {
    try {
      return fn();
    } catch (err) {
      console.error('[reminders]', err);
      return undefined;
    }
  };
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request(LOCK_NAME, run).catch((err) => console.error('[reminders] lock failed', err));
  return Promise.resolve(run());
}

/** Of these moments, the ones this window gets to show: marked fired under the lock, so no other window shows them. */
async function claim(moments, wait) {
  if (wait) await sleep(wait);
  const mine = await exclusive(() => {
    const at = now();
    const log = loadLog(at);
    const out = moments.filter((m) => !isFired(log.keys, m));
    if (!out.length) return out;
    for (const m of out) log.keys[m.key] = at;
    log.keys = pruneFired(log.keys, at);
    saveLog(log);
    return out;
  });
  return mine ?? [];
}

/* ==========================================================================
   Planning and the timer
   ========================================================================== */

function snapshotData() {
  let tasks = [];
  let events = [];
  try {
    tasks = tasksApi?.getItems() ?? [];
  } catch (err) {
    console.error('[reminders] tasks unavailable', err);
  }
  try {
    events = getEvents() ?? [];
  } catch (err) {
    console.error('[reminders] events unavailable', err);
  }
  return { tasks, events };
}

/** Every moment from the missed window to PLAN_DAYS ahead, as things are now. */
function plan(at = now()) {
  const s = reminderSettings();
  const { tasks, events } = snapshotData();
  return planMoments({ tasks, events, settings: s, snoozes: loadSnoozes(at), from: at - MISSED_WINDOW_MS, to: at + PLAN_DAYS * DAY_MS });
}

/** Plan soon (changes come in bursts: a drag, a sync): one check for all of them. */
function soon() {
  if (!started || pending) return;
  pending = setTimeout(() => {
    pending = 0;
    check();
  }, 60);
}

let checking = false;
let again = false; // a change came in while checking: check once more after

/** Fire what is due, show what was missed, set the timer for the next one. */
async function check() {
  if (!started) return;
  if (checking) {
    again = true;
    return;
  }
  checking = true;
  again = false;
  try {
    const s = reminderSettings();
    // Delete all my data: this window reloads in a moment, empty; it fires nothing meanwhile
    if (!savingAllowed()) return;
    if (lastOn === false && s.on) {
      // Switched back on: the time it was off doesn't count as missed
      const log = loadLog();
      saveLog({ ...log, since: now() });
    }
    lastOn = s.on;
    clearTimeout(timer);
    timer = 0;
    if (!s.on) {
      clearCards();
      return;
    }
    const at = now();
    const log = loadLog(at);
    const moments = plan(at);
    const { fire, missed, next } = sortOut(moments, { fired: log.keys, now: at, since: log.since });
    refreshCards(at);
    if (fire.length || missed.length) {
      const visible = document.visibilityState === 'visible';
      // A window someone is looking at goes first; a hidden one that can play sound before one that can't
      const wait = visible ? 0 : canPlay() ? 300 : 700;
      const [fired, gone] = await Promise.all([fire.length ? claim(fire, wait) : [], missed.length ? claim(missed, wait + 50) : []]);
      if (fired.length) fireNow(fired, at);
      if (gone.length) showMissed(gone);
    }
    const wait = next === null ? GUARD_MS : Math.max(250, Math.min(GUARD_MS, next - now() + 50));
    timer = setTimeout(check, wait);
  } catch (err) {
    console.error('[reminders] check failed', err);
    timer = setTimeout(check, GUARD_MS);
  } finally {
    checking = false;
    if (again) soon();
  }
}

/* ==========================================================================
   Firing: sound, notification, banner
   ========================================================================== */

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notificationState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Ask the browser (call it from a click). -> the permission afterwards */
export async function askPermission() {
  if (notificationState() === 'unsupported') return 'unsupported';
  try {
    const asked = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    return asked;
  } catch {
    return Notification.permission;
  }
}

const iconUrl = () => new URL('icons/icon-192.png', document.baseURI).href;
const routeOf = (target) => (target?.kind === 'event' ? '#/calendar' : target?.kind === 'task' ? '#/tasks' : '#/home');

/** What a notification click or button needs to act on the reminder (a plain object: it goes through the worker). */
function noticeData(m, { test = false } = {}) {
  const target = test ? null : targetOf(m);
  return {
    reminder: true,
    key: m.key,
    target,
    moment: test ? null : { key: m.key, kind: m.kind, id: m.id, occurrence: m.occurrence, before: m.before, sound: m.sound ?? null },
    // Where a click opens LIFE/OS when no window of it is open
    url: target ? `${reminderQuery({ act: 'open', kind: target.kind, id: target.id, day: target.day, key: m.key })}${routeOf(target)}` : routeOf(null),
  };
}

/**
 * Shown through the service worker when there is one (phones only show that kind; its click is
 * sw.js's), else the page's own. `force`: also while someone is looking at LIFE/OS (the test).
 */
async function showNotice(title, { body, tag, data, silent, actions = [] }, { force = false } = {}) {
  if (notificationState() !== 'granted') return false;
  if (!force && document.visibilityState === 'visible' && document.hasFocus()) return false;
  const withButtons = actions.length && (globalThis.Notification?.maxActions ?? 0) > 0;
  const options = { body, tag, icon: iconUrl(), badge: iconUrl(), silent, data, renotify: false, ...(withButtons ? { actions: actions.slice(0, Notification.maxActions) } : {}) };
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.active) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch (err) {
    console.warn('[reminders] notification through the service worker failed', err);
  }
  try {
    const { actions: _a, ...plain } = options;
    const n = new Notification(title, plain);
    n.onclick = () => {
      window.focus();
      if (data?.reminder) handleAction('open', data);
      n.close();
    };
    return true;
  } catch (err) {
    console.warn('[reminders] notification failed', err);
    return false;
  }
}

/** One batch due now: one sound, a notification each (or one for many), a banner each. */
function fireNow(moments, at) {
  const sound = moments.find((m) => m.sound && m.sound !== 'none')?.sound ?? 'none';
  const played = sound !== 'none' && play(sound);
  // Silent when the app rang (or the reminder is meant to be silent): one sound, never two
  const silent = played || sound === 'none';
  const { singles, group } = groupForFiring(moments);
  for (const m of singles) {
    const actions = [{ action: 'snooze', title: `Snooze ${SNOOZE_MINUTES} min` }];
    if (m.kind === 'task') actions.push({ action: 'done', title: 'Done' });
    showNotice(m.title, { body: describeMoment(m, at), tag: baseKey(m.key), data: noticeData(m), silent, actions });
  }
  if (group) {
    const first = group.moments[0];
    showNotice(group.title, { body: group.body, tag: `reminders:${first.key}`, data: { ...noticeData(first), group: true, url: routeOf(null), target: null }, silent });
  }
  if (group) showList(group.moments, { title: group.title, sub: 'Now', kind: 'group' });
  else for (const m of moments) addCard(m);
  window.dispatchEvent(new CustomEvent('lifeos:reminders-fired', { detail: { keys: moments.map((m) => m.key), played } }));
}

/* ==========================================================================
   Banners (in the app): one card per reminder, one for what was missed
   ========================================================================== */

let stack = null;
const cards = new Map(); // key -> { el, moment, sub }
let missedCard = null;

function ensureStack() {
  if (!stack || !stack.isConnected) {
    stack = h('section', { class: 'rm-stack', 'aria-label': 'Reminders', 'aria-live': 'polite' });
    document.body.append(stack);
  }
  return stack;
}

function cardButton(label, onClick, { primary = false, iconName = null, aria = null } = {}) {
  return h('button', { type: 'button', class: ['toast-action', 'rm-act', primary && 'rm-act--main'], 'aria-label': aria, onClick }, iconName ? icon(iconName, { size: 12 }) : null, label);
}

function addCard(m) {
  ensureStack();
  if (cards.has(m.key)) return;
  // A snoozed reminder takes the place of its earlier card
  for (const [k, c] of cards) if (baseKey(k) === baseKey(m.key)) removeCard(k);
  const sub = h('span', { class: 'rm-card-sub' }, describeMoment(m, now()));
  const name = `“${m.title}”`;
  const el = h(
    'div',
    { class: 'toast rm-card', role: 'group', 'aria-label': `Reminder: ${m.title}`, dataset: { key: m.key } },
    h('span', { class: 'rm-card-icon', 'aria-hidden': 'true' }, icon('bell', { size: 15 })),
    h('div', { class: 'toast-msg rm-card-msg' }, h('strong', { class: 'rm-card-title' }, m.title), sub),
    h(
      'div',
      { class: 'rm-card-acts' },
      cardButton('Open', () => {
        removeCard(m.key);
        openTarget(targetOf(m));
      }, { primary: true, aria: `Open ${name}` }),
      cardButton('Snooze', () => {
        removeCard(m.key);
        snooze(m);
      }, { aria: `Snooze ${name} for ${SNOOZE_MINUTES} minutes` }),
      m.kind === 'task'
        ? cardButton('Done', () => {
            removeCard(m.key);
            tasksApi?.complete(m.id, true);
          }, { aria: `Mark ${name} as done` })
        : null,
    ),
    h('button', { type: 'button', class: 'rm-card-x', 'aria-label': `Close the reminder for ${name}`, title: 'Close', onClick: () => removeCard(m.key) }, icon('x', { size: 13 })),
  );
  cards.set(m.key, { el, moment: m, sub });
  stack.append(el);
  // At most a few at once: the oldest go (their notifications said it already)
  while (cards.size > MAX_CARDS) removeCard(cards.keys().next().value);
  placeMissed();
}

function removeCard(key) {
  const c = cards.get(key);
  if (!c) return;
  cards.delete(key);
  const back = c.el.contains(document.activeElement);
  c.el.classList.add('is-leaving');
  setTimeout(() => c.el.remove(), 200);
  // The keyboard goes to the next card's first button, or back to the page
  if (back) (stack?.querySelector('.rm-card:not(.is-leaving) .rm-act') ?? document.querySelector('#main, main'))?.focus?.({ preventScroll: true });
}

function clearCards() {
  for (const key of [...cards.keys()]) removeCard(key);
  missedCard?.remove();
  missedCard = null;
}

/** Every card says when as of now ('In 14 minutes'); it goes once its task is done, its event long over or its item gone. */
function refreshCards(at) {
  if (!cards.size) return;
  const { tasks, events } = snapshotData();
  for (const [key, c] of cards) {
    const m = c.moment;
    if (m.kind === 'test' || m.kind === 'group') continue;
    const alive = m.kind === 'task' ? tasks.some((t) => t.id === m.id && !t.done) : events.some((e) => e.id === m.id) && stillRelevant(m, at);
    if (!alive) removeCard(key);
    else c.sub.textContent = describeMoment(m, at);
  }
}

/**
 * A card that lists reminders, each a button that opens its item: what was missed, or many that
 * came at once. -> the card (its list in `_moments`)
 */
function listCard({ list, title, sub, iconName, when, onItem, onDismiss, name }) {
  const shown = list.slice(0, 5);
  const titleId = `rm-list-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const card = h(
    'div',
    { class: 'toast rm-card rm-card--list', role: 'group', 'aria-labelledby': titleId },
    h('span', { class: 'rm-card-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 15 })),
    h(
      'div',
      { class: 'toast-msg rm-card-msg' },
      h('strong', { class: 'rm-card-title', id: titleId }, title),
      h('span', { class: 'rm-card-sub' }, sub),
      h(
        'ul',
        { class: 'rm-missed-list' },
        shown.map((m) =>
          h(
            'li',
            null,
            h('button', { type: 'button', class: 'rm-missed-item', onClick: () => onItem(m) }, h('span', { class: 'rm-missed-name' }, m.title), h('span', { class: 'rm-missed-when tnum' }, when(m))),
          ),
        ),
        list.length > shown.length ? h('li', { class: 'rm-missed-more' }, `and ${plural(list.length - shown.length, 'more')}`) : null,
      ),
    ),
    h('div', { class: 'rm-card-acts' }, cardButton('Dismiss', onDismiss, { aria: `Dismiss the ${name}` })),
    h('button', { type: 'button', class: 'rm-card-x', 'aria-label': `Close the ${name}`, title: 'Close', onClick: onDismiss }, icon('x', { size: 13 })),
  );
  card._moments = list;
  return card;
}

/** Many at once (a morning with many tasks due): one card that lists them. */
function showList(moments, { title, sub }) {
  ensureStack();
  const key = `group:${moments[0].key}`;
  const at = now();
  const el = listCard({
    list: moments,
    title,
    sub,
    iconName: 'bell',
    name: 'reminders',
    when: (m) => describeMoment(m, at),
    onItem: (m) => {
      removeCard(key);
      openTarget(targetOf(m));
    },
    onDismiss: () => removeCard(key),
  });
  el.dataset.key = key;
  cards.set(key, { el, moment: { kind: 'group' }, sub: null });
  stack.append(el);
  while (cards.size > MAX_CARDS) removeCard(cards.keys().next().value);
  placeMissed();
}

/** One calm card for what came due while LIFE/OS was closed (or the computer asleep). */
function showMissed(moments) {
  ensureStack();
  const prior = missedCard?._moments ?? [];
  const list = missedList([...prior, ...moments]);
  missedCard?.remove();
  const at = now();
  const today = dayKeyOf(at);
  const when = (m) => {
    const day = dayKeyOf(m.anchor);
    const d = day === today ? 'today' : day === dayKeyOf(at - DAY_MS) ? 'yesterday' : day === dayKeyOf(at + DAY_MS) ? 'tomorrow' : day;
    return m.timed ? `${m.time} ${d}` : m.kind === 'task' ? `due ${d}` : `${d}, all day`;
  };
  missedCard = listCard({
    list,
    title: list.length === 1 ? 'Missed reminder' : `${list.length} missed reminders`,
    sub: 'While LIFE/OS was closed or the computer slept',
    iconName: 'clock',
    name: 'missed reminders',
    when,
    onItem: (m) => {
      openTarget(targetOf(m));
      dropMissed(m);
    },
    onDismiss: () => dismissMissed(),
  });
  missedCard.classList.add('rm-card--missed');
  placeMissed();
}

function placeMissed() {
  if (missedCard) ensureStack().prepend(missedCard);
}

function dropMissed(m) {
  if (!missedCard) return;
  const rest = missedCard._moments.filter((x) => x.key !== m.key);
  missedCard.remove();
  missedCard = null;
  if (rest.length) showMissed(rest);
}

function dismissMissed() {
  const back = missedCard?.contains(document.activeElement);
  missedCard?.remove();
  missedCard = null;
  if (back) stack?.querySelector('.rm-act')?.focus({ preventScroll: true });
}

/* ==========================================================================
   Acting on a reminder: open, snooze, done
   ========================================================================== */

/** Show the item: an event's day in the Calendar, a task's page. */
export function openTarget(target) {
  if (!target) return;
  if (target.kind === 'event') {
    if (!getEvents().some((e) => e.id === target.id)) {
      toast('That event no longer exists.');
      return;
    }
    calendarApi?.open(target.day, 'day');
  } else if (target.kind === 'task') {
    if (!tasksApi?.reveal(target.id, { page: true })) toast('That task no longer exists.');
  }
}

/** Snooze a reminder (device-only) for SNOOZE_MINUTES, with Undo. */
function snooze(m, { quiet = false } = {}) {
  const at = now();
  const before = loadSnoozes(at);
  const next = addSnooze(before, m, at, SNOOZE_MINUTES);
  saveSnoozes(next);
  soon();
  if (quiet) return;
  const made = next[next.length - 1];
  toast(`Snoozed “${m.title}” for ${SNOOZE_MINUTES} minutes.`, {
    action: {
      label: 'Undo',
      onClick: () => {
        saveSnoozes(loadSnoozes().filter((s) => s.key !== made.key));
        soon();
      },
    },
  });
}

/** A reminder's moment from a notification's data or the start-up query (its key says the rest). */
function momentFrom(data) {
  const m = data?.moment;
  if (m && typeof m.key === 'string') return { ...m, title: titleOf(m) };
  const key = typeof data?.key === 'string' ? data.key : '';
  const parts = baseKey(key).split(':');
  if (parts.length < 4) return null;
  const before = Number(parts[parts.length - 1]);
  const occurrence = parts[parts.length - 2];
  const kind = parts[0];
  const id = parts.slice(1, -2).join(':');
  if (!Number.isFinite(before) || !['task', 'event'].includes(kind)) return null;
  return { key, kind, id, occurrence, before, sound: null, title: titleOf({ kind, id }) };
}

function titleOf({ kind, id }) {
  if (kind === 'task') return tasksApi?.getItems().find((t) => t.id === id)?.title ?? 'Task';
  return getEvents().find((e) => e.id === id)?.title ?? 'Event';
}

/** A notification's click or button (from sw.js, or the start-up query): 'open' | 'snooze' | 'done'. */
function handleAction(act, data) {
  const key = data?.key;
  if (key) removeCard(key);
  if (data?.group) {
    stack?.querySelector('.rm-act')?.focus({ preventScroll: true });
    return;
  }
  if (act === 'snooze') {
    const m = momentFrom(data);
    if (m) snooze(m);
  } else if (act === 'done') {
    const id = data?.target?.id ?? data?.moment?.id;
    if (id && !tasksApi?.complete(id, true)) toast('That task is already done.');
  } else {
    openTarget(data?.target ?? null);
  }
}

/* ==========================================================================
   Settings → Reminders: the test
   ========================================================================== */

/** A real reminder in a few seconds: the notification (also while you look), the sound, the banner. */
export function sendTestReminder() {
  prime();
  const s = reminderSettings();
  const at = now() + TEST_DELAY_MS;
  setTimeout(() => {
    const m = { key: `test:${at}`, kind: 'test', id: 'test', title: 'Test reminder', anchor: at, timed: true, time: '', location: '', sound: s.sound, before: 0 };
    const played = s.sound !== 'none' && play(s.sound);
    showNotice('Test reminder', { body: 'Reminders work on this device.', tag: 'lifeos-reminder-test', data: { reminder: true, key: m.key, target: null, url: '#/settings' }, silent: played || s.sound === 'none' }, { force: true });
    ensureStack();
    const el = h(
      'div',
      { class: 'toast rm-card', role: 'group', 'aria-label': 'Reminder: Test reminder', dataset: { key: m.key } },
      h('span', { class: 'rm-card-icon', 'aria-hidden': 'true' }, icon('bell', { size: 15 })),
      h('div', { class: 'toast-msg rm-card-msg' }, h('strong', { class: 'rm-card-title' }, 'Test reminder'), h('span', { class: 'rm-card-sub' }, notificationState() === 'granted' ? 'Reminders work on this device.' : 'Sound and this banner work. Allow notifications to get them outside the app too.')),
      h('div', { class: 'rm-card-acts' }, cardButton('OK', () => removeCard(m.key), { primary: true })),
      h('button', { type: 'button', class: 'rm-card-x', 'aria-label': 'Close the test reminder', title: 'Close', onClick: () => removeCard(m.key) }, icon('x', { size: 13 })),
    );
    cards.set(m.key, { el, moment: { ...m, kind: 'test' }, sub: el.querySelector('.rm-card-sub') });
    stack.append(el);
  }, TEST_DELAY_MS);
  return TEST_DELAY_MS;
}

/* ==========================================================================
   Start
   ========================================================================== */

/** A click on a notification while no LIFE/OS window was open: the address says what to do. */
function takeStartQuery() {
  const q = readReminderQuery(location.search);
  if (!q) return;
  try {
    history.replaceState(history.state, '', `${location.pathname}${withoutReminderQuery(location.search)}${location.hash}`);
  } catch {
    // The address keeps its query; acting on it once is what matters
  }
  const data = { reminder: true, key: q.key, target: { kind: q.kind, id: q.id, day: q.day || (q.key ? baseKey(q.key).split(':').slice(-2, -1)[0] : '') } };
  // After the page has drawn (the item's page opens over it)
  setTimeout(() => handleAction(q.act, data), 400);
}

/** Start the engine (js/app.js, once, after the pages are loaded). */
export async function startReminders() {
  if (started) return;
  const [tasksMod, storeMod, calMod] = await Promise.allSettled([import('./features/tasks.js'), import('./features/calendar.store.js'), import('./features/calendar.js')]);
  tasksApi = tasksMod.status === 'fulfilled' ? tasksMod.value.tasksApi : null;
  if (storeMod.status === 'fulfilled') getEvents = storeMod.value.getEvents;
  calendarApi = calMod.status === 'fulfilled' ? calMod.value.calendarApi : null;
  started = true;

  // Sound needs a click or key press first: the first one in this window sets it up
  const unlock = () => prime();
  document.addEventListener('pointerdown', unlock, { capture: true, once: true });
  document.addEventListener('keydown', unlock, { capture: true, once: true });

  tasksApi?.subscribe(soon);
  if (storeMod.status === 'fulfilled') storeMod.value.subscribeCalendar(soon);
  let seen = JSON.stringify(settings.get()?.reminders ?? null);
  settings.subscribe((s) => {
    const next = JSON.stringify(s?.reminders ?? null);
    if (next === seen) return;
    seen = next;
    soon();
  });
  // Snoozes and fired reminders written by another window
  window.addEventListener('storage', (e) => {
    if (e.key === SNOOZE_KEY || e.key === FIRED_KEY) soon();
  });
  document.addEventListener('visibilitychange', soon);
  window.addEventListener('focus', soon);
  window.addEventListener('online', soon);
  onDayChange(soon);

  // sw.js: a reminder notification was clicked (or one of its buttons) and this window got it
  try {
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'lifeos:reminder') handleAction(e.data.act, e.data.data);
    });
  } catch {
    // No service workers here: the page's own notifications handle their clicks
  }

  takeStartQuery();
  lastOn = reminderSettings().on;
  loadLog();
  check();

  // A test copy can move the engine's clock, to try reminders without waiting (never the real app)
  if (!isRealAddress) {
    window.lifeosReminders = {
      check,
      plan: () => plan(),
      setClock: (ms) => {
        clockOffset = Number(ms) - Date.now();
        return check();
      },
      resetClock: () => {
        clockOffset = 0;
        return check();
      },
      fired: () => loadLog(),
      snoozes: () => loadSnoozes(),
      handleAction,
    };
  }
}

/** For Settings: the permission, asking, the test. */
export const remindersApi = Object.freeze({
  notificationState,
  askPermission,
  sendTestReminder,
  check: () => soon(),
});

