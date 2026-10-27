// LIFE/OS — the guided tours (Quick tutorial, Tutorial): coach marks over the real pages. A
// spotlight rings the control a step is about and the rest of the page dims, but stays usable
// (clicks go through; nothing waits on the tour). Beside it a bubble says what it is, with "Step
// 3 of 8", Back · Next · Skip (End on the last step) and, in the full tutorial, its chapter.
// The steps, their words and the geometry are pure (js/tour.logic.js). Started by the first-run
// choice (js/welcome.js, via app.js) and Settings → About → Tutorial. Styles: css/tour.css.
//
// The tour never creates, changes or deletes anything by itself: it opens pages (location.hash),
// points, and "Try it" puts the cursor in a field. Its only writes are its own place
// (settings.tours, this device) and the tab bar's pages when you tick them in its picker step.

import { h, icon, isTyping, menuOpen, reducedMotion, toast, uid } from './ui.js';
import { settings, readSaved } from './store.js';
import { shell } from './shell.js';
import { TOUR_KINDS, tourSteps, chapterOf, progressText, normalizeTours, recordTour, resumeIndex, continueInfo, placeBubble, spotRect, visiblePart } from './tour.logic.js';
import { tabPicker } from './welcome.js';

// A phone: the tab bar and More instead of the sidebar (css/shell.css, 640px)
const phoneQuery = matchMedia('(max-width: 640px)');
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
// How long a step waits for its control to show up: at most WAIT_MS in all (its page drawing),
// and SETTLE_MS once its page is on screen (a control that comes a moment later), in ms
const WAIT_MS = 2000;
const SETTLE_MS = 600;
// The spotlight's room around its control; the bubble's gap to it and to the window's edges
const PAD = 6;
const GAP = 14;
const MARGIN = 12;
// A step whose control went (or the page moved on) is looked for again this often
const RECHECK_MS = 500;

/** The tour on screen, or null. */
let run = null;

// (a look picked in the welcome leaves out the quick tour's "Pick a look", settings.lookPicked)
const stepsFor = (kind) => tourSteps(kind, { phone: phoneQuery.matches, mac: IS_MAC, lookPicked: settings.get().lookPicked === true });
// A dialog is open (More, Search, an editor): the tour steps aside until it closes
const dialogUp = () => !!document.querySelector('.modal-root:not(.is-leaving)');
// The page on screen (the router's .view), so a step waits for its own page
const pageNow = () => document.querySelector('#main > .view')?.dataset.feature ?? null;

/** True while a tour is on screen. */
export function tourRunning() {
  return !!run;
}

/**
 * Where the tours stand on this device, for Settings → About → Tutorial and More: the one on
 * screen, for each tour whether it can continue ({ index, n, of } at the step it was left on) or
 * null, and how many steps each has on this screen (steps: { quick, full }).
 */
export function tutorialState() {
  const tours = normalizeTours(settings.get().tours);
  const quick = stepsFor('quick');
  const full = stepsFor('full');
  return {
    running: run?.kind ?? null,
    quick: continueInfo(quick, tours.quick),
    full: continueInfo(full, tours.full),
    steps: { quick: quick.length, full: full.length },
  };
}

/** For checking a tour by hand (and the browser tests): where it is and what it skipped. */
export function tourDebug() {
  if (!run) return null;
  const step = run.steps[run.index];
  return { kind: run.kind, index: run.index, total: run.steps.length, id: step?.id ?? null, target: run.match?.sel ?? null, skipped: [...run.skipped], away: run.away };
}

/**
 * Start tour `kind` ('quick' | 'full'), from its first step or (resume) where it was left on
 * this device. A tour already on screen ends first, quietly.
 */
export function startTour(kind, { resume = false } = {}) {
  if (!TOUR_KINDS.includes(kind)) return;
  if (run) finish('left', { quiet: true });
  const steps = stepsFor(kind);
  const index = resume ? resumeIndex(steps, normalizeTours(settings.get().tours)[kind]) : 0;
  const parts = build(kind);
  run = {
    kind,
    steps,
    // The kind of screen its steps are for (a phone or a computer)
    phone: phoneQuery.matches,
    index: -1,
    shown: false,
    token: 0,
    ...parts,
    match: null,
    away: false,
    keyboard: false,
    queued: false,
    // Where the focus goes back to at the end (if it is still there)
    returnTo: document.activeElement,
    focusWanted: 'next',
    skipped: [],
    picker: null,
    offWatch: null,
    timers: new Set(),
    ro: new ResizeObserver(() => schedule()),
    mo: new MutationObserver(() => checkAway()),
  };
  document.body.append(run.layer);
  run.mo.observe(document.body, { childList: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('hashchange', schedule);
  window.addEventListener('keydown', onWindowKey);
  document.addEventListener('keydown', onAnyKey, true);
  document.addEventListener('pointerdown', onAnyPointer, true);
  phoneQuery.addEventListener?.('change', onViewport);
  run.interval = setInterval(() => {
    checkAway();
    schedule();
  }, RECHECK_MS);
  checkAway();
  go(index, 1);
}

/** End the tour on screen, as Skip does (its place is kept, so it can continue). */
export function endTour() {
  if (run) finish('left', { quiet: true });
}

/* ---- Drawing ---- */

function build(kind) {
  const titleId = `tour-${uid()}`;
  const textId = `tour-${uid()}`;
  const els = {
    chapter: h('p', { class: 'tour-chapter label' }),
    title: h('h2', { class: 'modal-title tour-title', id: titleId }),
    text: h('p', { class: 'tour-text', id: textId }),
    done: h('p', { class: 'tour-done', hidden: true }, icon('check', { size: 14, stroke: 2.5 }), h('span', null, 'Done. On to the next step.')),
    extra: h('div', { class: 'tour-extra' }),
    count: h('span', { class: 'tour-count' }),
    fill: h('span', { class: 'tour-bar-fill' }),
    arrow: h('span', { class: 'tour-arrow', 'aria-hidden': 'true' }),
    live: h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }),
  };
  els.close = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm tour-close', 'aria-label': 'Close the tour', title: 'Close the tour (Esc)', onClick: () => leave() }, icon('x'));
  els.skip = h('button', { type: 'button', class: 'btn btn--ghost tour-skip', onClick: () => leave() }, 'Skip');
  els.tryBtn = h('button', { type: 'button', class: 'btn tour-try', hidden: true, onClick: tryIt }, 'Try it');
  els.back = h('button', { type: 'button', class: 'btn tour-back', onClick: () => back() }, 'Back');
  els.next = h('button', { type: 'button', class: 'btn btn--primary tour-next', onClick: () => next() }, 'Next');
  const bubble = h(
    'div',
    { class: 'modal hud tour-bubble', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, 'aria-describedby': textId, tabindex: '-1', onKeydown: onBubbleKey },
    els.arrow,
    h('div', { class: 'modal-head tour-head' }, h('div', { class: 'tour-head-text' }, els.chapter, els.title), els.close),
    h('div', { class: 'modal-body tour-body' }, els.text, els.done, els.extra, h('p', { class: 'sr-only' }, 'F6 moves between the tour and the page.')),
    // Where you are stays in view over the buttons, also while a long step's words scroll
    h(
      'div',
      { class: 'modal-foot tour-foot' },
      h('div', { class: 'tour-progress' }, els.count, h('span', { class: 'tour-bar', 'aria-hidden': 'true' }, els.fill)),
      els.skip,
      els.tryBtn,
      els.back,
      els.next,
    ),
  );
  const spot = h('div', { class: 'tour-spot is-none', 'aria-hidden': 'true' });
  const layer = h('div', { class: 'tour', dataset: { kind } }, spot, bubble, els.live);
  return { layer, spot, bubble, els };
}

/** On screen and big enough to point at (not hidden, not in the tour itself). */
function shown(el) {
  if (!el?.isConnected || el.closest('.tour')) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1 && getComputedStyle(el).visibility !== 'hidden';
}

/** The step's control: the first of its targets on screen. -> { el, sel, title, text } | null */
function findTarget(step) {
  for (const t of step.targets) {
    let list = [];
    try {
      list = document.querySelectorAll(t.sel);
    } catch {
      continue;
    }
    for (const el of list) if (shown(el)) return { el, sel: t.sel, title: t.title, text: t.text };
  }
  return null;
}

/**
 * fn() until it answers (anything but undefined; null: nothing), for at most `ms` (also in a tab
 * that paints no frames).
 */
function waitFor(fn, ms) {
  return new Promise((resolve) => {
    const until = Date.now() + ms;
    const poll = () => {
      const got = run ? fn() : null;
      if (got !== undefined || !run || Date.now() >= until) resolve(got ?? null);
      else setTimeout(poll, 60);
    };
    poll();
  });
}

/** The step's control once its page is on screen; null once it has had a moment to show. */
function targetOnce(step) {
  let readyAt = 0;
  return () => {
    if (step.page && pageNow() !== step.page) return undefined;
    readyAt ||= Date.now();
    return findTarget(step) ?? (Date.now() - readyAt >= SETTLE_MS ? null : undefined);
  };
}

/**
 * Show step `index`: open its page, wait for its control, then point at it. A step whose control
 * isn't there is centred without a pointer, or left out (ifMissing 'skip', going on in `dir`).
 */
async function go(index, dir = 1) {
  if (!run) return;
  const token = ++run.token;
  let i = Math.max(0, index);
  for (;;) {
    if (i >= run.steps.length) return finish('done');
    const step = run.steps[i];
    if (step.page && pageNow() !== step.page) location.hash = `#/${step.page}`;
    const match = step.targets.length ? await waitFor(targetOnce(step), WAIT_MS) : null;
    if (!run || token !== run.token) return;
    if (!match && step.targets.length && step.ifMissing === 'skip') {
      console.info(`[life-os] tour: step "${step.id}" left out (nothing on screen for it)`);
      if (!run.skipped.includes(step.id)) run.skipped.push(step.id);
      // Back past the first step: go forward from it instead
      if (i + dir < 0) dir = 1;
      i += dir;
      continue;
    }
    render(i, match);
    return;
  }
}

function render(index, match) {
  const { steps, els, kind, bubble } = run;
  const step = steps[index];
  const first = !run.shown;
  run.shown = true;
  run.index = index;
  run.match = match;
  save('open');

  const chapter = kind === 'full' ? chapterOf(steps, index) : null;
  els.chapter.hidden = !chapter;
  els.chapter.textContent = chapter ? `${chapter.title} · ${chapter.n} of ${chapter.of}` : '';
  paintWords(step, match);
  els.done.hidden = true;
  els.count.textContent = progressText(index, steps.length);
  els.fill.style.width = `${((index + 1) / steps.length) * 100}%`;

  // The tab picker lives in its step's bubble
  run.picker?.destroy();
  run.picker = null;
  els.extra.replaceChildren();
  if (step.picker) {
    run.picker = tabPicker({ pages: shell.pages.filter((p) => p.icon) });
    els.extra.append(run.picker.el);
  }
  bubble.classList.toggle('is-wide', step.picker);

  const last = index === steps.length - 1;
  els.back.hidden = index === 0;
  els.skip.hidden = last;
  els.next.textContent = last ? 'End' : 'Next';
  syncTry(step);
  watch(step);

  if (match) reveal(match.el);
  observeTarget(match?.el);
  // From one step to the next the spotlight glides to its new place (not on the first one, and
  // not while the page scrolls under it)
  if (!first) {
    run.layer.classList.add('is-moving');
    later(() => run?.layer.classList.remove('is-moving'), 420);
  }
  place();

  // Screen readers: the first step is the dialog's own name and description (the focus goes in);
  // each later one is announced
  if (!first) announce(`${els.count.textContent}. ${els.title.textContent}. ${els.text.textContent}`);
  const want = run.focusWanted;
  run.focusWanted = null;
  if (want) (want === 'back' && !els.back.hidden ? els.back : els.next).focus({ preventScroll: true });
}

/** The step's title and words: a match's own, or the step's (missingText when nothing is pointed at). */
function paintWords(step, match) {
  run.els.title.textContent = match?.title ?? step.title;
  run.els.text.textContent = match ? match.text ?? step.text : step.missingText;
}

function announce(text) {
  const live = run.els.live;
  live.textContent = '';
  later(() => {
    if (run?.els.live === live) live.textContent = text;
  }, 60);
}

/** Bring the control into view: in the middle of the window, or its top when it is tall. */
function reveal(el) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  if (r.top >= MARGIN && r.bottom <= vh - MARGIN && r.left >= 0 && r.right <= document.documentElement.clientWidth) return;
  el.scrollIntoView({ block: r.height > vh * 0.6 ? 'start' : 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function observeTarget(el) {
  run.ro.disconnect();
  run.ro.observe(run.bubble);
  if (el) run.ro.observe(el);
}

/** Once per frame at most (and by a timer too, for a window that paints no frames). */
function schedule() {
  if (!run || run.queued) return;
  run.queued = true;
  const placeNow = () => {
    if (!run?.queued) return;
    run.queued = false;
    place();
  };
  requestAnimationFrame(placeNow);
  setTimeout(placeNow, 120);
}

/** Put the spotlight on the control and the bubble beside it, inside the window. */
function place() {
  if (!run || run.away || run.index < 0) return;
  // The window became a phone or a computer (heard here too: a resize may come before the media
  // query's own change event)
  if (phoneQuery.matches !== run.phone) return onViewport();
  const { spot, bubble, els } = run;
  const step = run.steps[run.index];
  // The page drew its control again, or it went (you opened another page): look again
  if (step.targets.length && !(run.match && shown(run.match.el)) && (!step.page || pageNow() === step.page)) {
    const again = findTarget(step);
    if (again?.el !== run.match?.el) {
      run.match = again;
      paintWords(step, again);
      observeTarget(again?.el);
      syncTry(step);
    }
  }
  if (run.match && !shown(run.match.el)) run.match = null;

  const view = { width: document.documentElement.clientWidth, height: window.innerHeight };
  const rect = run.match ? visiblePart(run.match.el.getBoundingClientRect(), view) : null;
  const hole = rect ? spotRect(rect, view, PAD) : null;
  spot.classList.toggle('is-none', !hole);
  if (hole) Object.assign(spot.style, { left: `${hole.left}px`, top: `${hole.top}px`, width: `${hole.width}px`, height: `${hole.height}px` });
  else spot.removeAttribute('style');

  // On the side the step asks for (the tab picker above the tab bar), the bubble takes the room
  // there and its list scrolls, rather than covering the bar
  bubble.style.maxHeight = '';
  if (hole && (step.place === 'top' || step.place === 'bottom')) {
    const room = step.place === 'top' ? hole.top - GAP - MARGIN : view.height - MARGIN - (hole.top + hole.height + GAP);
    if (room >= 240) bubble.style.maxHeight = `${Math.floor(room)}px`;
  }
  const at = placeBubble(hole, { width: bubble.offsetWidth, height: bubble.offsetHeight }, view, { prefer: step.place, gap: GAP, margin: MARGIN });
  bubble.style.left = `${Math.round(at.left)}px`;
  bubble.style.top = `${Math.round(at.top)}px`;
  bubble.dataset.side = at.side;
  if (at.arrow != null) bubble.style.setProperty('--tour-arrow', `${Math.round(at.arrow)}px`);
  els.arrow.hidden = at.arrow == null;
}

/** A dialog opened over the page (More, Search, an editor): the tour waits behind it, out of sight. */
function checkAway() {
  if (!run) return;
  const away = dialogUp();
  if (away === run.away) return;
  run.away = away;
  run.layer.hidden = away;
  if (!away) schedule();
}

/* ---- Moving through the steps ---- */

function next() {
  if (!run) return;
  if (run.bubble.contains(document.activeElement) && !run.focusWanted) run.focusWanted = 'next';
  if (run.index >= run.steps.length - 1) return finish('done');
  go(run.index + 1, 1);
}

function back() {
  if (!run || run.index <= 0) return;
  if (run.bubble.contains(document.activeElement) && !run.focusWanted) run.focusWanted = 'back';
  go(run.index - 1, -1);
}

/** Skip, ✕ or Esc: the tour ends, and keeps its place so it can continue later. */
function leave() {
  finish('left');
}

/** "Try it": the cursor goes into the step's field (a task's box). */
function tryIt() {
  const field = tryField(run?.steps[run.index]);
  if (!field) return;
  field.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  field.focus({ preventScroll: true });
}

const tryField = (step) => {
  if (!step?.tryIt) return null;
  const el = document.querySelector(step.tryIt);
  return el && shown(el) ? el : null;
};

function syncTry(step) {
  run.els.tryBtn.hidden = !tryField(step);
}

/**
 * A step that waits for you (add a task): once its list grew it says so and moves on after a
 * moment. The tour only listens; you do the adding.
 */
function watch(step) {
  run.offWatch?.();
  run.offWatch = null;
  if (!step.advanceOn) return;
  const { store, list } = step.advanceOn;
  const count = () => {
    const value = readSaved(store);
    return Array.isArray(value?.[list]) ? value[list].length : 0;
  };
  const before = count();
  const onChange = (e) => {
    if (e.detail?.key !== store || !run || run.steps[run.index] !== step || count() <= before) return;
    run.offWatch?.();
    run.offWatch = null;
    run.els.done.hidden = false;
    schedule();
    // You did it from the field (or the page drew it again and the focus fell out): the focus
    // comes back to the tour, which goes on from here
    const active = document.activeElement;
    const inStep = !active || active === document.body || run.bubble.contains(active) || !!run.match?.el.contains(active) || !!(step.tryIt && active.matches?.(step.tryIt));
    later(() => {
      if (!run || run.steps[run.index] !== step) return;
      if (inStep) run.focusWanted = 'next';
      next();
    }, 1200);
  };
  window.addEventListener('lifeos:change', onChange);
  run.offWatch = () => window.removeEventListener('lifeos:change', onChange);
}

/** The window became a phone or a computer: its own steps, from the same one where it has it. */
function onViewport() {
  if (!run || phoneQuery.matches === run.phone) return;
  run.phone = phoneQuery.matches;
  const id = run.steps[run.index]?.id;
  run.steps = stepsFor(run.kind);
  const at = run.steps.findIndex((s) => s.id === id);
  if (run.bubble.contains(document.activeElement)) run.focusWanted = 'next';
  go(at >= 0 ? at : Math.min(Math.max(0, run.index), run.steps.length - 1), 1);
}

/* ---- Keys ---- */

function onBubbleKey(e) {
  if (!run) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    leave();
    return;
  }
  // ← → on the bubble's own buttons: Back and Next
  const onControls = e.target === run.bubble || !!e.target.closest?.('.tour-head, .tour-foot');
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && onControls && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    run.focusWanted = e.key === 'ArrowRight' ? 'next' : 'back';
    if (e.key === 'ArrowRight') next();
    else back();
    return;
  }
  // The bubble's own keys never reach the page's shortcuts (Space on Next would start the timer)
  if (['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Backspace'].includes(e.key)) e.stopPropagation();
}

// After the page's own handlers (window, bubbling): an Esc the page didn't use ends the tour;
// F6 moves between the tour and the page (the control it points at, else the page)
function onWindowKey(e) {
  if (!run || run.away) return;
  if (e.key === 'F6' && !e.altKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (run.bubble.contains(document.activeElement)) focusPage(run.match?.el);
    else (run.els.next.hidden ? run.bubble : run.els.next).focus();
    return;
  }
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || menuOpen() || isTyping(e)) return;
  leave();
}

// The last way in (keys or pointer) decides where the focus goes when the tour ends
function onAnyKey(e) {
  if (run && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) run.keyboard = true;
}

function onAnyPointer() {
  if (run) run.keyboard = false;
}

/** The focus onto `el` if it takes it, else the page's title (for that moment only, as Skip to content does). */
function focusPage(el) {
  const focusable = el?.matches?.('a[href], button, input, select, textarea, [tabindex]') ? el : el?.querySelector?.('a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])');
  if (focusable && shown(focusable)) {
    focusable.focus({ preventScroll: true });
    return;
  }
  const title = document.querySelector('#main > .view .page-title') ?? document.getElementById('main');
  if (!title) return;
  if (!title.hasAttribute('tabindex')) {
    title.setAttribute('tabindex', '-1');
    title.addEventListener('blur', () => title.removeAttribute('tabindex'), { once: true });
  }
  title.focus({ preventScroll: true });
}

/* ---- The end ---- */

function later(fn, ms) {
  if (!run) return;
  const timers = run.timers;
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

/** This tour's place on this device (settings.tours): the step on screen and how it stands. */
function save(status) {
  const step = run.steps[run.index];
  const before = normalizeTours(settings.get().tours)[run.kind];
  if (before?.step === step?.id && before?.status === status) return;
  settings.update({ tours: recordTour(settings.get().tours, run.kind, step?.id ?? null, status) });
}

/**
 * End the tour: 'done' (End, after the last step) or 'left' (Skip, ✕, Esc: its place is kept, so
 * Settings offers to continue). The focus goes back where it was before the tour if that is still
 * on screen, else to the page; `lifeos:tour-ended` ({ kind, status, keyboard }) tells Home, whose
 * Start card may take it from there.
 */
function finish(status, { quiet = false } = {}) {
  if (!run) return;
  const r = run;
  if (r.index >= 0) save(status);
  const active = document.activeElement;
  const hadFocus = !active || active === document.body || r.layer.contains(active);
  r.token++;
  r.offWatch?.();
  r.picker?.destroy();
  r.timers.forEach((t) => clearTimeout(t));
  clearInterval(r.interval);
  r.ro.disconnect();
  r.mo.disconnect();
  window.removeEventListener('resize', schedule);
  window.removeEventListener('scroll', schedule, { capture: true });
  window.removeEventListener('hashchange', schedule);
  window.removeEventListener('keydown', onWindowKey);
  document.removeEventListener('keydown', onAnyKey, true);
  document.removeEventListener('pointerdown', onAnyPointer, true);
  phoneQuery.removeEventListener?.('change', onViewport);
  run = null;
  r.layer.remove();
  if (hadFocus && !quiet) {
    const back = r.returnTo;
    if (back && back !== document.body && shown(back)) back.focus({ preventScroll: true });
    else focusPage(null);
  }
  if (status === 'left' && !quiet && r.index >= 0) {
    const where = phoneQuery.matches ? 'More' : 'Settings → About → Tutorial';
    if (r.kind === 'full' && r.index > 0) {
      toast(`Tutorial paused at step ${r.index + 1} of ${r.steps.length}. Continue any time in ${where}.`, {
        duration: 8000,
        action: { label: 'Continue', onClick: () => startTour('full', { resume: true }) },
      });
    } else {
      toast(`Tour closed. Take it again any time in ${where}.`, { duration: 6000 });
    }
  }
  if (!quiet) window.dispatchEvent(new CustomEvent('lifeos:tour-ended', { detail: { kind: r.kind, status, keyboard: r.keyboard } }));
}
