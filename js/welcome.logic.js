// LIFE/OS — the first run: the pure parts of the welcome sheet (js/welcome.js). Its three steps
// (Pick your look, Your formats, then the three ways in), the step it opens on, what "Use this
// look" and the formats save, the
// look picker's demo (fake data, never yours) and which card of the carousel is in the middle.
// No DOM: tested in tools/tests/welcome.test.js. The demo is drawn by js/appearance.js (buildDemo).

import { SKIN_IDS, normalizeSkin } from './skins.js';
import { DATE_FORMAT_CHOICES, UNIT_CHOICES, normalizeDateFormat, normalizeUnits, dateFormatExample } from './formats.js';

/* ---- The steps ---- */

/**
 * The welcome's three steps, in order: the looks, your formats (date format and units), then No
 * tutorial / Quick tutorial / Tutorial.
 */
export const WELCOME_STEPS = Object.freeze(['look', 'formats', 'choice']);

/**
 * The step the welcome opens on: the looks, unless a look was picked there already (the window
 * closed on a later step, so the sheet shows again): then the formats, or once those were saved
 * (formatsPicked) the three ways in; Back goes the other way.
 */
export function welcomeStart({ lookPicked = false, formatsPicked = false } = {}) {
  if (lookPicked !== true) return 'look';
  return formatsPicked === true ? 'choice' : 'formats';
}

/** The step after `step` (null after the last) and the one before it (null before the first). */
export function stepAfter(step) {
  const i = WELCOME_STEPS.indexOf(step);
  return i >= 0 && i < WELCOME_STEPS.length - 1 ? WELCOME_STEPS[i + 1] : null;
}

export function stepBefore(step) {
  const i = WELCOME_STEPS.indexOf(step);
  return i > 0 ? WELCOME_STEPS[i - 1] : null;
}

/* ---- Your formats ---- */

/**
 * The formats step's choices with today as their example: { dates: [{ id, label, example }],
 * units: [{ id, label, example }] } ('27/10/2026 · Tue 27 Oct'; 'kg, km').
 */
export function formatChoices(today) {
  return {
    dates: DATE_FORMAT_CHOICES.map((c) => ({ id: c.id, label: c.label, example: dateFormatExample(c.id, today) })),
    units: UNIT_CHOICES.map((c) => ({ id: c.id, label: c.label, example: c.hint })),
  };
}

/** What Next on the formats step saves (this device only): the two choices, and that they were made. */
export function formatsPatch(dateFormat, units) {
  return { dateFormat: normalizeDateFormat(dateFormat), units: normalizeUnits(units), formatsPicked: true };
}

/**
 * The demos' mode at first: the computer's light or dark, or `picked`, the mode of a look picked
 * here before ('light' | 'dark'; the sheet came back on its second step and Back was pressed).
 */
export function demoMode(prefersLight = false, picked = null) {
  if (picked === 'light' || picked === 'dark') return picked;
  return prefersLight ? 'light' : 'dark';
}

/**
 * What "Use this look" saves in settings (this device only): the template, the mode its demo was
 * shown in, and lookPicked, so the Quick tutorial leaves out its "Pick a look" step and Home's
 * Start card counts that step as done.
 */
export function lookPatch(id, mode) {
  return { skin: normalizeSkin(id), theme: mode === 'light' ? 'light' : 'dark', lookPicked: true };
}

/* ---- The carousel ---- */

/** The card whose middle is nearest the middle of the view. centers: each card's middle (px). */
export function nearestCard(centers, middle) {
  let best = 0;
  let gap = Infinity;
  (centers ?? []).forEach((c, i) => {
    const d = Math.abs(c - middle);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

/**
 * Where a key moves the carousel from card `index` of `count`: ← → one card (it stops at the
 * ends, as the swipe does), Home and End the first and the last. Null for any other key.
 */
export function cardForKey(index, key, count) {
  if (count < 1) return null;
  const last = count - 1;
  const at = Math.max(0, Math.min(last, Math.trunc(index) || 0));
  if (key === 'ArrowRight') return Math.min(last, at + 1);
  if (key === 'ArrowLeft') return Math.max(0, at - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/** The cards to draw now: the one in the middle and its neighbours, in the order to build them. */
export function cardsNear(index, count, reach = 1) {
  const out = [];
  if (index >= 0 && index < count) out.push(index);
  for (let d = 1; d <= reach; d++) {
    if (index + d < count) out.push(index + d);
    if (index - d >= 0) out.push(index - d);
  }
  return out;
}

/** "3 of 8" */
export function positionText(index, count) {
  return `${Math.max(1, Math.min(count, Math.trunc(index) + 1))} of ${count}`;
}

/** The card a template starts on: the one in use (any unknown id: Simple, the first). */
export function startCard(skin) {
  return Math.max(0, SKIN_IDS.indexOf(normalizeSkin(skin)));
}

/* ---- The demo: what each card shows, made up ----
   Home's own widgets in small, in each template: the habit graph, the clock, To do and Payments.
   Never the person's data (a first run has none anyway); the time is the computer's. */

export const LOOK_DEMO = Object.freeze({
  tasks: Object.freeze(
    [
      { title: 'Morning run', done: true },
      { title: 'Call the dentist', priority: 'high' },
      { title: 'Buy groceries' },
    ].map((t) => Object.freeze(t)),
  ),
  // The last two weeks of habits, one rate (0–1) a day, today last (still going); null is a rest
  // day (nothing planned: a gap, as on Home)
  bars: Object.freeze([0.6, 0.8, 1, null, 0.7, 1, 0.8, 0.5, 1, 0.9, null, 0.8, 1, 0.4]),
  // Monday first, so today (the last bar) is a Sunday
  days: Object.freeze(['M', 'T', 'W', 'T', 'F', 'S', 'S', 'M', 'T', 'W', 'T', 'F', 'S', 'S']),
  currency: 'kr',
  payments: Object.freeze(
    [
      { when: 'Tomorrow', name: 'Music', amount: 129 },
      { when: 'In 5 days', name: 'Films & series', amount: 149 },
      { when: '12 Nov', name: 'Cloud storage', amount: 60 },
    ].map((p) => Object.freeze(p)),
  ),
});

/** The graph's average: the finished days only (not today, not rest days), 0–1, or null. */
export function demoAverage(bars = LOOK_DEMO.bars) {
  const done = bars.slice(0, -1).filter((r) => typeof r === 'number');
  return done.length ? done.reduce((a, b) => a + b, 0) / done.length : null;
}

/** What the payments cost a month, in all. */
export function demoTotal(payments = LOOK_DEMO.payments) {
  return payments.reduce((sum, p) => sum + p.amount, 0);
}

/* ---- One link: on a phone's browser, get the app first ---- */

/**
 * Which phone this browser is on: 'ios' (iPhone and iPad: an iPad's Safari calls itself a Mac
 * with a touch screen) or 'android'; null on a computer.
 */
export function phoneKind(ua = '', touchPoints = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

/**
 * Where an iPhone's Share button is: 'safari' (its bar), 'chrome' (the address bar, iOS 16.4 or
 * later) or 'elsewhere': a browser inside another app (Instagram, TikTok, Facebook…) or one
 * without Add to Home Screen, so the page opens in Safari first.
 */
export function iosBrowser(ua = '') {
  if (/FBAN|FBAV|FB_IAB|Instagram|TikTok|BytedanceWebview|musical_ly|Snapchat|LinkedInApp|Line\/|GSA\//.test(ua)) return 'elsewhere';
  if (/CriOS/.test(ua)) return 'chrome';
  if (/FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua)) return 'elsewhere';
  return 'safari';
}

/**
 * Before the welcome: add LIFE/OS to the Home Screen. Only in a phone's browser on a real copy
 * (the one link people are sent): an iPhone's Home Screen app keeps its own data, apart from
 * Safari, so a welcome answered in Safari would be asked again in the app. Not in the installed
 * app, nor on a computer (the tab and the app share their data there, and the sidebar offers
 * Install).
 */
export function getAppFirst({ phone = null, standalone = false, realCopy = false } = {}) {
  return Boolean(phone) && !standalone && realCopy;
}
