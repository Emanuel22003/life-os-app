// LIFE/OS — the first run: the welcome sheet. The first time LIFE/OS opens on a device with
// nothing saved, one sheet in two steps: "Pick your look" (the eight templates as live demos in a
// carousel, light or dark), then three ways in: No tutorial (straight in), Quick tutorial (about a
// minute) or Tutorial (every page). app.js decides when (shell.js welcomeOnStart) and starts the
// tour picked (js/tour.js); the choices' words are WELCOME_CHOICES in js/tour.logic.js, the steps
// and the carousel's rules js/welcome.logic.js, and each demo is appearance.js buildDemo.
// Also the tab picker: every page in a line with a tick for the phone's tab bar, one of the
// tours' steps (its rules, PAGE_INTROS, normalizeTabs and toggleTab, are in js/shell.js).
// Styles: css/shell.css (.wl-*: the choices, the tab picker) and css/welcome.css (the looks). The
// sheet is a dialog: from the bottom on a phone.

import { h, icon, openModal, checkButton, iconBadge, registerIcon, reducedMotion, uid } from './ui.js';
import { settings } from './store.js';
import { normalizeTabs, toggleTab, PAGE_INTROS } from './shell.js';
import { welcomeChoices } from './tour.logic.js';
import { SKINS, resolveTheme } from './skins.js';
import { buildDemo, loadSkinFonts } from './appearance.js';
import { welcomeStart, demoMode, lookPatch, nearestCard, cardForKey, cardsNear, positionText, startCard } from './welcome.logic.js';

// The three ways in: straight in (an arrow), quick (a stopwatch), the whole tour (a map)
registerIcon('wl-go', '<path d="M4 12h15M13 6l6 6-6 6"/>');
registerIcon('wl-quick', '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5 15 10.5M10 2.5h4M12 2.5V6"/>');
registerIcon('wl-map', '<path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5Z"/><path d="M9 4v13.5M15 6.5V20"/>');

/** "Home, Tasks and More" */
const listWords = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

// Wider than a phone: the sidebar shows and lists every page (css/shell.css, 640px)
const wideQuery = matchMedia('(min-width: 641px)');
const prefersLight = matchMedia('(prefers-color-scheme: light)');

/**
 * Open the welcome sheet. First "Pick your look" (lookPicker below): Use this look applies the
 * template and its mode (settings, via the app's own appearance path) and goes on; Skip keeps the
 * look as it is. Then the three big choices, each with a line on what you get and how long it
 * takes, with Back to the looks. Picking one closes the sheet; Esc and ✕ (on either step) are No
 * tutorial and keep the look in use. Either way settings.welcomed is set. A look picked earlier
 * (the window closed on the second step) opens it on the choices.
 * onChoose({ choice: 'none' | 'quick' | 'full', keyboard }) after it has closed (keyboard: it was
 * answered from the keyboard, so the caller hands the focus on).
 */
export function openWelcome({ onChoose } = {}) {
  let choice = 'none';
  let step = welcomeStart({ lookPicked: settings.get().lookPicked });
  let m = null;
  const leadId = `wl-${uid()}`;

  // Closed from the keyboard (Enter on a choice, Esc) or not: the caller may hand the focus on.
  // Heard before the dialog's own Esc handler (registered first, on the same capture phase).
  let keyboard = false;
  const onKey = () => (keyboard = true);
  const onPointer = () => (keyboard = false);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);

  /* ---- Step 2: the three ways in ---- */

  const options = welcomeChoices({ lookPicked: settings.get().lookPicked }).map((c) => {
    const descId = `wl-${uid()}`;
    return h(
      'button',
      {
        type: 'button',
        class: 'wl-option',
        dataset: { choice: c.id },
        'aria-describedby': descId,
        onClick: () => {
          choice = c.id;
          m.close();
        },
      },
      iconBadge(c.icon, { tone: 'home', size: 18, box: 38, className: 'wl-option-ib' }),
      h('span', { class: 'wl-option-text' }, h('span', { class: 'wl-option-name' }, c.title), h('span', { class: 'wl-option-desc', id: descId }, c.text)),
      icon('chevron-right', { size: 16, className: 'wl-option-go' }),
    );
  });
  // The quick one's step count follows the look: picked here, its "Pick a look" step goes
  const syncCounts = () => {
    const quick = welcomeChoices({ lookPicked: settings.get().lookPicked }).find((c) => c.id === 'quick');
    const desc = options.find((o) => o.dataset.choice === 'quick')?.querySelector('.wl-option-desc');
    if (desc && quick) desc.textContent = quick.text;
  };
  // ↑ ↓ move between the three as well as Tab
  const onArrow = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const at = options.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    options[(at + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus();
  };
  const choicePanel = h(
    'div',
    { class: 'wl-step wl-step--choice' },
    h('p', { class: 'wl-lead', id: leadId }, 'Your day in one place: plan, write, track and focus. How would you like to start?'),
    h('div', { class: 'wl-options', role: 'group', 'aria-labelledby': leadId, onKeydown: onArrow }, options),
  );

  /* ---- Step 1: the looks (built the first time it shows) ---- */

  let looks = null;
  const lookPanel = h('div', { class: 'wl-step wl-step--look' });

  /* ---- The footer: Skip · Use this look, or Back ---- */

  const skipBtn = h('button', { type: 'button', class: 'btn btn--ghost wl-skip', title: 'Keep the look as it is', onClick: () => show('choice') }, 'Skip');
  const useBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--primary wl-use',
      onClick: () => {
        // The app's own appearance path (app.js applyAppearance hears settings): data-skin and
        // data-theme on the page, the template's fonts, the title-bar color
        settings.update(lookPatch(looks.picked(), looks.mode()));
        syncCounts();
        show('choice');
      },
    },
    'Use this look',
  );
  const backBtn = h('button', { type: 'button', class: 'btn btn--ghost wl-back', onClick: () => show('look') }, icon('chevron-left', { size: 16 }), h('span', null, 'Back'));
  const foot = h('div', { class: 'wl-foot' }, backBtn, skipBtn, useBtn);
  const title = h('span');

  function show(next, { focus = true } = {}) {
    step = next;
    const isLook = next === 'look';
    if (isLook && !looks) {
      looks = lookPicker({ onUse: () => useBtn.click() });
      lookPanel.append(looks.el);
    }
    title.textContent = isLook ? 'Pick your look' : 'Welcome to LIFE/OS';
    lookPanel.hidden = !isLook;
    choicePanel.hidden = isLook;
    skipBtn.hidden = useBtn.hidden = !isLook;
    backBtn.hidden = isLook;
    m?.el.classList.toggle('is-look', isLook);
    if (isLook && m) looks.reveal();
    if (focus && m) focusTarget().focus({ preventScroll: true });
  }
  const focusTarget = () => (step === 'look' ? looks.card() : options[0]);

  show(step, { focus: false });
  m = openModal({
    title,
    className: ['welcome-sheet', 'wl-choice', step === 'look' && 'is-look'].filter(Boolean).join(' '),
    body: [lookPanel, choicePanel],
    footer: foot,
    initialFocus: focusTarget(),
    onClose: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      looks?.destroy();
      if (settings.get().welcomed !== true) settings.update({ welcomed: true });
      onChoose?.({ choice, keyboard });
    },
  });
  if (step === 'look') looks.reveal();
  return m;
}

/**
 * "Pick your look": the eight templates in SKINS order as a carousel, one big card at a time with
 * its neighbours peeking in at the sides. A card: the template's live demo (appearance.js
 * buildDemo: a small Home with the graph, the clock, To do and Payments, in that template) over
 * its name and line. Swipe or scroll (it snaps), the arrows beside it, ← → (Home, End) or a dot;
 * the card in the middle is the pick. A Light / Dark switch above flips every demo (it starts as
 * the computer's mode). For a screen reader it is a radio group of the looks (the demo is
 * decorative). Only the cards near the one showing are drawn at once, the rest a moment later.
 * onUse(): Enter on a card, as Use this look.
 * -> { el, picked() (its id), mode(), card() (the one in the middle), reveal(), destroy() }
 */
function lookPicker({ onUse }) {
  // Every demo needs its own typefaces (each file downloads only once a demo uses it)
  SKINS.forEach((s) => loadSkinFonts(s.id));
  const count = SKINS.length;
  const saved = settings.get();
  let index = startCard(saved.skin);
  // The computer's mode, or the one of a look picked here before (the sheet came back)
  let modeTouched = saved.lookPicked === true;
  let mode = demoMode(prefersLight.matches, modeTouched ? resolveTheme(saved.theme, prefersLight.matches) : null);
  let alive = true;
  // A card the carousel is gliding to (arrows, keys, a dot): the scroll doesn't change the pick
  // on the way; it settles once the scrolling has stopped for a moment
  let target = null;
  let settleTimer = 0;
  // The pick a screen reader heard last
  let said = index;

  const demos = new Map();
  const frames = [];
  const cards = SKINS.map((s, i) => {
    const nameId = `wl-${uid()}`;
    const descId = `wl-${uid()}`;
    const frame = h('div', { class: 'wl-look-frame' });
    frames.push(frame);
    return h(
      'div',
      {
        class: 'wl-look',
        role: 'radio',
        'aria-checked': 'false',
        'aria-labelledby': nameId,
        'aria-describedby': descId,
        tabindex: '-1',
        dataset: { skinId: s.id },
        // A neighbour peeking in: bring it to the middle
        onClick: () => select(i),
      },
      frame,
      h('div', { class: 'wl-look-text' }, h('span', { class: 'wl-look-name', id: nameId }, s.name), h('span', { class: 'wl-look-desc', id: descId }, s.description)),
    );
  });

  const draw = (i) => {
    if (demos.has(i) || !alive) return;
    const demo = buildDemo(SKINS[i].id, mode);
    demos.set(i, demo);
    frames[i].append(demo.host);
  };
  // The rest, nearest first, one at a time while the browser is idle (and not while the row
  // moves: a demo's first styling would cost a swipe a frame)
  const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 150));
  let movedAt = 0;
  const drawRest = () => {
    if (!alive) return;
    if (Date.now() - movedAt < 400) {
      setTimeout(() => idle(drawRest, { timeout: 800 }), 400);
      return;
    }
    const next = cardsNear(index, count, count).find((i) => !demos.has(i));
    if (next == null) return;
    draw(next);
    idle(drawRest, { timeout: 800 });
  };

  const track = h('div', { class: 'wl-track', role: 'radiogroup', 'aria-label': 'Looks', onKeydown: onTrackKey }, cards);
  const prev = h('button', { type: 'button', class: 'btn btn--icon wl-arrow wl-arrow--prev', 'aria-label': 'Previous look', title: 'Previous look (←)', onClick: () => move(-1) }, icon('chevron-left', { size: 20 }));
  const next = h('button', { type: 'button', class: 'btn btn--icon wl-arrow wl-arrow--next', 'aria-label': 'Next look', title: 'Next look (→)', onClick: () => move(1) }, icon('chevron-right', { size: 20 }));
  const dots = SKINS.map((s, i) => h('span', { class: 'wl-dot', title: s.name, onClick: () => select(i) }));
  const pos = h('span', { class: 'wl-pos tnum' });
  const live = h('p', { class: 'sr-only', role: 'status' });

  const modeBtns = ['light', 'dark'].map((m) =>
    h(
      'button',
      { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { mode: m }, onClick: () => setMode(m, true) },
      icon(m === 'light' ? 'sun' : 'moon', { size: 14 }),
      m === 'light' ? 'Light' : 'Dark',
    ),
  );
  const el = h(
    'div',
    { class: 'wl-looks', onKeydown: onPanelKey },
    h(
      'div',
      { class: 'wl-looks-top' },
      h('p', { class: 'wl-lead' }, 'LIFE/OS comes in eight looks. Pick one to start with; you can change it any time in Appearance.'),
      h('div', { class: 'seg wl-mode', role: 'group', 'aria-label': 'Light or dark' }, modeBtns),
    ),
    h('div', { class: 'wl-stage' }, track, prev, next),
    h('div', { class: 'wl-where' }, h('span', { class: 'wl-dots', 'aria-hidden': 'true' }, dots), pos),
    live,
  );

  function setMode(m, touched = false) {
    mode = m;
    if (touched) modeTouched = true;
    modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    demos.forEach((d) => d.setTheme(m));
  }
  // The computer switched light / dark while the sheet is open: follow it, until you picked one
  const onSystem = () => modeTouched || setMode(demoMode(prefersLight.matches));
  prefersLight.addEventListener?.('change', onSystem);

  /** The pick is card `i`: its radio, the dots, "3 of 8", the arrows, and the cards near it drawn. */
  function setIndex(i, { say = false } = {}) {
    index = i;
    cards.forEach((c, j) => {
      c.setAttribute('aria-checked', String(j === i));
      c.tabIndex = j === i ? 0 : -1;
      c.classList.toggle('is-current', j === i);
    });
    dots.forEach((d, j) => d.classList.toggle('is-on', j === i));
    pos.textContent = positionText(i, count);
    prev.setAttribute('aria-disabled', String(i === 0));
    next.setAttribute('aria-disabled', String(i === count - 1));
    cardsNear(i, count, 1).forEach(draw);
    if (say) announce();
  }

  // A screen reader hears the new pick (a card with the focus says itself; the arrows, a dot or a
  // swipe that came to rest are said here)
  function announce() {
    if (index === said) return;
    said = index;
    if (cards.includes(document.activeElement)) return;
    live.textContent = '';
    setTimeout(() => alive && (live.textContent = `${SKINS[index].name}, ${positionText(index, count)}`), 60);
  }

  const middleCard = () => nearestCard(cards.map((c) => c.offsetLeft + c.offsetWidth / 2), track.scrollLeft + track.clientWidth / 2);

  // The scrolling stopped: the card in the middle is the pick. A glide that didn't get there (a
  // window that paints no frames) jumps the rest of the way: the pick it was going to stays.
  function settle() {
    if (!alive || !track.clientWidth) return;
    if (target != null) {
      const to = target;
      target = null;
      if (middleCard() !== to) center(to, false);
      return;
    }
    const at = middleCard();
    if (at !== index) setIndex(at);
    announce();
  }
  const settleSoon = (ms) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, ms);
  };

  /** Card `i` to the middle (gliding, unless motion is reduced). */
  function center(i, smooth = true) {
    const c = cards[i];
    if (!c || !track.clientWidth) return;
    const left = c.offsetLeft + c.offsetWidth / 2 - track.clientWidth / 2;
    const glide = smooth && !reducedMotion();
    if (glide) {
      target = i;
      // (no scrolling at all: it is there already)
      settleSoon(400);
    }
    track.scrollTo({ left, behavior: glide ? 'smooth' : 'auto' });
  }

  function select(i, { focus = false } = {}) {
    const at = Math.max(0, Math.min(count - 1, i));
    setIndex(at, { say: true });
    center(at);
    if (focus) cards[at].focus({ preventScroll: true });
  }

  const move = (by) => select(index + by);

  // The card in the middle while the carousel moves (a swipe, a scroll, the trackpad): the ring
  // and the dots follow at once, a screen reader hears it once it rests
  let queued = false;
  const onScroll = () => {
    movedAt = Date.now();
    settleSoon(160);
    if (queued || target != null) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!alive || !track.clientWidth || target != null) return;
      const at = middleCard();
      if (at !== index) setIndex(at);
    });
  };
  track.addEventListener('scroll', onScroll, { passive: true });
  // A finger, the wheel or a trackpad takes over from a glide under way
  const takeOver = () => (target = null);
  track.addEventListener('pointerdown', takeOver, { passive: true });
  track.addEventListener('wheel', takeOver, { passive: true });

  // The width changed (a resize, the sheet opening): the card stays in the middle
  let shownWidth = 0;
  const ro = new ResizeObserver(() => {
    if (track.clientWidth === shownWidth) return;
    shownWidth = track.clientWidth;
    center(index, false);
  });
  ro.observe(track);

  // On a card: ← → Home End move (the focus goes along), Enter or Space is Use this look
  function onTrackKey(e) {
    const at = cards.indexOf(document.activeElement);
    if (at < 0 || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onUse();
      return;
    }
    const to = cardForKey(index, e.key === 'ArrowDown' ? 'ArrowRight' : e.key === 'ArrowUp' ? 'ArrowLeft' : e.key, count);
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    select(to, { focus: true });
  }

  // Anywhere else in the picker (the arrows, Light / Dark): ← → move the carousel, the focus stays
  function onPanelKey(e) {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    move(e.key === 'ArrowRight' ? 1 : -1);
  }

  setMode(mode);
  setIndex(index);
  idle(drawRest, { timeout: 800 });

  return {
    el,
    picked: () => SKINS[index].id,
    mode: () => mode,
    card: () => cards[index],
    // Once in the page: the pick in the middle, at once (a timer backs up a frame that may not
    // come, in a window in the background)
    reveal: () => {
      requestAnimationFrame(() => center(index, false));
      setTimeout(() => alive && center(index, false), 60);
    },
    destroy() {
      alive = false;
      clearTimeout(settleTimer);
      ro.disconnect();
      prefersLight.removeEventListener?.('change', onSystem);
      demos.forEach((d) => d.disconnect());
    },
  };
}

/**
 * The tab picker: every page in a line (its icon, name and what it does) with a tick for the
 * phone's tab bar, and under the list the bar as it is now. A tick saves at once (settings.tabs,
 * this device), as Edit tabs in More does, so the bar changes under it; the bar keeps one page.
 * Its words follow the window: where the sidebar shows (a computer), the bar is for a window as
 * narrow as a phone. pages: the nav's pages [{ id, title, icon }] (not Settings, not ideas).
 * -> { el, destroy() }
 */
export function tabPicker({ pages = [] } = {}) {
  const ids = pages.map((p) => p.id);
  const listId = `wl-${uid()}`;
  const barLine = h('p', { class: 'wl-bar', role: 'status' });
  const laterLine = h('p', { class: 'wl-later' });
  const note = h('span', { class: 'wl-note' });

  const checks = new Map();
  const rows = pages.map((p) => {
    const descId = `wl-${uid()}`;
    const check = checkButton({ checked: false, label: p.title, onToggle: () => pick(p.id) });
    check.setAttribute('aria-describedby', descId);
    checks.set(p.id, check);
    const intro = PAGE_INTROS[p.id];
    return h(
      'li',
      // The whole row ticks (the check is the keyboard's way in)
      { class: 'wl-page', dataset: { id: p.id }, onClick: (e) => check.contains(e.target) || pick(p.id) },
      iconBadge(p.icon, { tone: p.id, size: 18, box: 34, className: 'wl-page-ib' }),
      h('span', { class: 'wl-page-text' }, h('span', { class: 'wl-page-name' }, p.title), intro ? h('span', { class: 'wl-page-desc', id: descId }, intro) : null),
      check,
    );
  });

  const current = () => normalizeTabs(settings.get().tabs, ids);
  const paint = () => {
    const tabs = current();
    for (const row of rows) {
      const on = tabs.includes(row.dataset.id);
      row.classList.toggle('is-on', on);
      checks.get(row.dataset.id).setAttribute('aria-checked', String(on));
    }
    const wide = wideQuery.matches;
    const names = tabs.map((id) => pages.find((p) => p.id === id)?.title).filter(Boolean);
    barLine.replaceChildren(h('span', { class: 'wl-bar-head' }, wide ? 'Tab bar in a narrow window: ' : 'Your tab bar: '), `${listWords([...names, 'More'])}.`, ' ', note);
    laterLine.textContent = 'Change it any time in More → Edit tabs.';
  };

  const pick = (id) => {
    const res = toggleTab(settings.get().tabs, id, ids);
    note.textContent = res.reason === 'last' ? 'It keeps at least one page.' : '';
    if (!res.changed) return;
    settings.update({ tabs: res.tabs });
  };

  const el = h('div', { class: 'wl-picker' }, h('ul', { class: 'wl-pages', id: listId, 'aria-label': 'Pages for the tab bar' }, rows), barLine, laterLine);
  paint();
  // Edit tabs, another window or this list changed the bar; a window made narrow or wide
  const offSettings = settings.subscribe(paint);
  wideQuery.addEventListener?.('change', paint);
  return {
    el,
    destroy() {
      offSettings();
      wideQuery.removeEventListener?.('change', paint);
    },
  };
}
