// LIFE/OS — Notes board: one column per section, cards you move between them.
//
// Rendering and input only: columns, cards, the column pager, the pointer drag (mouse and pen
// at once, touch after a long press so a swipe still scrolls), keyboard moves. Every change is
// reported through ctx callbacks; notes.js owns the store, the selection, the editor and Undo.
// Cards keep the list's order (pinned first, then most recently edited): a drop only
// changes a note's section, so the marker shows where that order puts the card.
//
// The pager (a chip per column, in the board's toolbar) shows which columns are in view and
// jumps to one. While a card is lifted it becomes the drop dock: every column, Unsorted
// included, is one short move away even when it is scrolled out of sight.

import { h, icon, registerIcon, num, plural, timeAgo, clamp } from '../ui.js';
import { VIEW_UNSORTED, excerpt, highlight, clip, findSection } from './notes.logic.js';
import {
  boardColumns,
  boardFocusTarget,
  adjacentColumn,
  landingIndex,
  columnOf,
  moveOrder,
  columnAtX,
  clampEdgeScroll,
  columnsInView,
} from './notes.board.logic.js';
import { glyphOf, ALT_KEY } from './notes.sections.js';

const DRAG_THRESHOLD = 5; // px a mouse or pen moves before a press becomes a drag
const LONG_PRESS_MS = 300; // touch: hold this long to pick a card up
const TOUCH_SLOP = 8; // px a finger may wander during the hold (more is a scroll)
const EDGE_BAND = 56; // px from the board's (or a column's) edge where a drag scrolls it
const EDGE_SPEED = 14; // px per frame at the very edge
const EDGE_PAD = 12; // edge scrolling stops once the first / last column is this far inside
const BODY_REACH = 64; // px above / below a column's cards that still scroll them (header, New row)
const EDGE_SLACK = 48; // px past the board's side a pointer (a finger at the screen's edge) still counts as that edge
const LIFT_GAP = 28; // touch: the lifted card floats this far above the finger
const FADE = 28; // px of the pager's edge fade, kept clear when a chip is brought into view
const SLOT_DWELL_MS = 220; // a column scrolls to the drop slot once the card rests over it this long
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

// Board glyphs: the layout toggle's columns and a column's fold control
registerIcon('nt-board', '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/>');
registerIcon('nt-fold', '<path d="m14 6-6 6 6 6"/><path d="M19 5v14"/>');
registerIcon('nt-unfold', '<path d="m10 6 6 6-6 6"/><path d="M5 5v14"/>');

let seq = 0;
const nextId = (prefix) => `${prefix}-${(seq += 1)}`;

const reducedMotion = () => window.matchMedia(REDUCED_MOTION).matches;
const scrollBehavior = () => (reducedMotion() ? 'auto' : 'smooth');

function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function marked(text, terms) {
  return highlight(text, terms).map((seg) => (seg.hit ? h('mark', { class: 'nt-hit' }, seg.text) : seg.text));
}

function syncChildren(parent, nodes) {
  const current = parent.children;
  if (current.length === nodes.length && nodes.every((node, i) => current[i] === node)) return;
  parent.replaceChildren(...nodes);
}

/**
 * Eat the click that follows a drag on `area`, so dropping a card does not also open it.
 * A drop that moved the card gets no click at all, and the timer that disarms this can run
 * late after input: so only a click inside `area` is eaten, and the next press disarms it.
 */
function swallowClick(area) {
  const disarm = () => {
    window.removeEventListener('click', stop, true);
    window.removeEventListener('pointerdown', disarm, true);
  };
  const stop = (e) => {
    disarm();
    if (!(e.target instanceof Node) || !area.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', stop, true);
  window.addEventListener('pointerdown', disarm, true);
  // The click (if any) is dispatched in the same task as the pointerup.
  setTimeout(disarm, 0);
}

/**
 * Scroll `box` just enough to show `rect` on one axis. `inset` keeps a strip at the end
 * free (the editor panel covering the board's right side).
 */
function showInBox(box, rect, axis, { instant = false, inset = 0, pad = 12 } = {}) {
  const b = box.getBoundingClientRect();
  const [start, end, size] = axis === 'x' ? ['left', 'right', 'width'] : ['top', 'bottom', 'height'];
  if (!b[size]) return;
  const lo = b[start] + pad;
  const hi = Math.max(lo + 1, b[end] - inset - pad);
  let delta = 0;
  if (rect[start] < lo) delta = rect[start] - lo;
  // Too big to fit: line up its start rather than its end
  else if (rect[end] > hi) delta = Math.min(rect[end] - hi, rect[start] - lo);
  if (delta) box.scrollBy({ [axis === 'x' ? 'left' : 'top']: delta, behavior: instant ? 'auto' : scrollBehavior() });
}

/** A short buzz when a long press picks a card up (where the device and the page allow it). */
function buzz() {
  try {
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
  } catch {
    // vibration is a nicety
  }
}

/**
 * createBoard(ctx) -> board
 *
 * ctx: {
 *   host,                                 element that gets nt-is-dragging while a card is lifted
 *   onOpen(id, { keyboard }),             open the note in the editor panel
 *   onMove(id, column, { via }),          file the note under 'unsorted' or a section id
 *   onMenu(id, anchor, { keyboard }),     the Move to… picker for a card
 *   onNew(column),                        a new note in that column
 *   onNewSection(),                       the trailing "+ Section" strip
 *   onToggleCollapse(column),             fold / unfold a column
 *   onPick(column),                       a pager chip was used: that column is where the user is
 *   onAnnounce(text),                     polite live-region message
 *   coverLeft() -> number | null,         left edge of the editor panel over the board, if open
 * }
 */
export function createBoard(ctx) {
  let model = { items: [], sections: [], terms: [], collapsed: [], openId: null };
  let columns = []; // the last rendered boardColumns()
  let grid = []; // card ids per column (empty while folded), for the arrow keys
  let order = []; // column ids, left to right
  let tabId = null; // the card in the Tab order: the last one focused
  let chipTab = null; // the pager chip in the Tab order
  let carry = null; // a card Alt+→ just filed in a folded column: its strip takes the next Alt+arrow
  let drag = null;
  let pending = false; // a render held back while a card is lifted
  let fresh = false; // cards created after the first render animate in
  let viewRaf = 0;
  let inView = '';
  let lastFolded = '';
  const cardCache = new Map(); // note id -> card
  const colCache = new Map(); // column id -> column
  const chipCache = new Map(); // column id -> pager chip

  // Read by screen readers on every card: how to move it without a pointer.
  const helpId = nextId('nt-board-help');
  const help = h(
    'span',
    { class: 'sr-only', id: helpId },
    `Arrow keys move between cards. ${ALT_KEY === '⌥' ? 'Option' : 'Alt'} plus Left or Right moves this card to the previous or next column. M opens Move to.`,
  );

  // The trailing "+ Section" strip: as slim as a folded column, so it never pushes one out of view.
  const ghost = h(
    'div',
    { class: 'nt-col nt-col--ghost' },
    h(
      'button',
      { type: 'button', class: 'nt-col-addsection', 'aria-label': 'New section', title: 'New section', onClick: () => ctx.onNewSection() },
      icon('plus', { size: 14 }),
      h('span', { class: 'nt-col-addsection-label', 'aria-hidden': 'true' }, 'Section'),
    ),
  );
  const colsEl = h('div', { class: 'nt-board-cols' });
  const scroller = h(
    'div',
    {
      class: 'nt-board-scroll',
      onPointerdown: onPointerDown,
      onKeydown: onKey,
      onFocusin: onFocusIn,
      onScroll: onBoardScroll,
      onContextmenu: (e) => {
        // A long press on a card belongs to the drag, not the browser's menu.
        if (drag?.touch) e.preventDefault();
      },
    },
    colsEl,
    help,
  );
  // Once a card is lifted by touch the finger moves the card, not the page. Non-passive so it
  // may cancel the scroll; before the long press completes it never does, so swipes scroll.
  const onTouchMove = (e) => {
    if (drag?.active && drag.touch && e.cancelable) e.preventDefault();
  };
  scroller.addEventListener('touchmove', onTouchMove, { passive: false });

  /* ---- Pager: a chip per column (jump there); the drop dock while a card is lifted ---- */

  const pagerChips = h('div', { class: 'nt-chips nt-pager-chips', role: 'group', 'aria-label': 'Columns', onKeydown: onPagerKey, onScroll: updatePagerFades });
  const pager = h('div', { class: 'nt-chips-wrap nt-pager' }, h('span', { class: 'nt-pager-label label', 'aria-hidden': 'true' }, 'Move to'), pagerChips);

  const resizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleView()) : null;
  resizeWatch?.observe(scroller);
  resizeWatch?.observe(pagerChips);

  function createChip(id) {
    const chip = { id, sig: '' };
    chip.iconEl = h('span', { class: 'nt-chip-icon', 'aria-hidden': 'true' });
    chip.nameEl = h('span', { class: 'nt-chip-name' });
    chip.countEl = h('span', { class: 'nt-chip-count', 'aria-hidden': 'true' });
    chip.btn = h(
      'button',
      { type: 'button', class: 'nt-chip nt-pager-chip', dataset: { col: id }, tabindex: '-1', onClick: (e) => pickColumn(id, { keyboard: e.detail === 0 }) },
      chip.iconEl,
      chip.nameEl,
      chip.countEl,
    );
    return chip;
  }

  function paintChip(chip, { name, iconName, total, shown, searching, onBoard }) {
    const sig = [name, iconName, total, shown, searching, onBoard].join('\u0001');
    if (chip.sig === sig) return;
    chip.sig = sig;
    chip.iconEl.replaceChildren(icon(iconName, { size: 12 }));
    chip.nameEl.textContent = name;
    chip.countEl.textContent = searching ? `${num(shown)}/${num(total)}` : num(total);
    // Unsorted without notes has no column: its chip only shows in the dock, as a drop target.
    chip.btn.classList.toggle('is-dockonly', !onBoard);
    chip.btn.setAttribute('aria-label', `${name}, ${searching ? `${shown} of ${plural(total, 'note')} match` : plural(total, 'note')}`);
    chip.btn.title = onBoard ? `Go to ${name}` : name;
  }

  function renderPager() {
    const shownIds = new Set(columns.map((c) => c.id));
    const searching = model.terms.length > 0;
    const live = new Set([VIEW_UNSORTED, ...model.sections.map((s) => s.id)]);
    for (const id of [...chipCache.keys()]) if (!live.has(id)) chipCache.delete(id);
    const unsortedCol = columns.find((c) => c.id === VIEW_UNSORTED);
    const chipOf = (id) => {
      let chip = chipCache.get(id);
      if (!chip) {
        chip = createChip(id);
        chipCache.set(id, chip);
      }
      return chip;
    };
    const unsorted = chipOf(VIEW_UNSORTED);
    paintChip(unsorted, { name: 'Unsorted', iconName: 'inbox', total: unsortedCol?.total ?? 0, shown: unsortedCol?.notes.length ?? 0, searching, onBoard: !!unsortedCol });
    const nodes = [unsorted.btn];
    for (const c of columns) {
      if (!c.section) continue;
      const chip = chipOf(c.id);
      paintChip(chip, { name: c.section.name, iconName: glyphOf(c.section), total: c.total, shown: c.notes.length, searching, onBoard: shownIds.has(c.id) });
      nodes.push(chip.btn);
    }
    syncChildren(pagerChips, nodes);
    pager.hidden = !columns.length;
    syncChipTab();
  }

  /** One chip is a Tab stop: the last one used, else the first column in view. */
  function syncChipTab() {
    const usable = (id) => !!id && order.includes(id);
    if (!usable(chipTab)) chipTab = [...chipCache.values()].find((c) => c.btn.classList.contains('is-inview'))?.id ?? order[0] ?? null;
    for (const chip of chipCache.values()) chip.btn.tabIndex = chip.id === chipTab ? 0 : -1;
  }

  function onPagerKey(e) {
    if (e.altKey || e.metaKey || e.ctrlKey || drag) return;
    const chips = [...pagerChips.children].filter((el) => !el.classList.contains('is-dockonly'));
    const at = chips.indexOf(e.target);
    if (at === -1) return;
    let next = null;
    if (e.key === 'ArrowLeft') next = chips[at - 1];
    else if (e.key === 'ArrowRight') next = chips[at + 1];
    else if (e.key === 'Home') next = chips[0];
    else if (e.key === 'End') next = chips[chips.length - 1];
    else return;
    e.preventDefault();
    if (!next) return;
    chipTab = next.dataset.col;
    syncChipTab();
    next.focus();
    showInBox(pagerChips, next.getBoundingClientRect(), 'x', { pad: FADE });
  }

  /** A chip: bring its column into view and light it; from the keyboard, focus goes into it. */
  function pickColumn(id, { keyboard = false } = {}) {
    if (drag) return;
    chipTab = id;
    syncChipTab();
    ctx.onPick?.(id);
    if (keyboard) focusColumn(id);
    else revealColumn(id);
    pulse(id);
  }

  /** Fade the pager's edges only on the sides with more chips. */
  function updatePagerFades() {
    const max = pagerChips.scrollWidth - pagerChips.clientWidth;
    const fade = [pagerChips.scrollLeft > 2 && 'start', pagerChips.scrollLeft < max - 2 && 'end'].filter(Boolean).join(' ');
    if (pager.dataset.fade !== fade) pager.dataset.fade = fade;
  }

  /* ---- What shows: lit chips for the columns in view, board fades toward hidden ones ---- */

  function onBoardScroll() {
    scheduleView();
    // Wheel, trackpad or edge scrolling moved the columns under a lifted card: aim again.
    if (drag?.active && !drag.cancelled && !drag.aimRaf) {
      drag.aimRaf = requestAnimationFrame(() => {
        if (!drag) return;
        drag.aimRaf = 0;
        aim();
      });
    }
  }

  function scheduleView() {
    if (!viewRaf) viewRaf = requestAnimationFrame(updateView);
  }

  function spanOf(id) {
    const col = colCache.get(id);
    if (!col?.el.isConnected) return null;
    const r = col.el.getBoundingClientRect();
    return { id, left: r.left, right: r.right };
  }

  function updateView() {
    viewRaf = 0;
    updatePagerFades();
    if (!visible()) return;
    const cover = covered();
    const sr = scroller.getBoundingClientRect();
    const lo = sr.left;
    const hi = sr.right - cover;
    const spans = order.map(spanOf).filter(Boolean);
    const lit = columnsInView(spans, lo, hi);
    // The board fades toward columns that are out of sight (left, or right of the panel).
    const fade = [spans.length && spans[0].left < lo - 2 && 'start', spans.length && spans[spans.length - 1].right > hi + 2 && 'end'].filter(Boolean).join(' ');
    if (scroller.dataset.fade !== fade) scroller.dataset.fade = fade;
    scroller.style.setProperty('--nt-cover', `${Math.round(cover)}px`);
    const sig = lit.join('\u0001');
    if (sig === inView) return;
    inView = sig;
    const set = new Set(lit);
    for (const chip of chipCache.values()) chip.btn.classList.toggle('is-inview', set.has(chip.id));
    // Keep the first column in view in sight in the pager (phones swipe one column at a time).
    const first = lit.length ? chipCache.get(lit[0]) : null;
    if (first?.btn.isConnected && !drag && pagerChips.scrollWidth > pagerChips.clientWidth) {
      showInBox(pagerChips, first.btn.getBoundingClientRect(), 'x', { pad: FADE });
    }
    if (!pagerChips.contains(document.activeElement)) {
      chipTab = null;
      syncChipTab();
    }
  }

  /* ---- Columns ---- */

  function iconBtn(name, onClick, className) {
    return h('button', { type: 'button', class: ['btn btn--ghost btn--icon btn--sm', className], onClick }, icon(name, { size: 14 }));
  }

  function createColumn(id) {
    const col = { id, sig: '' };
    const nameId = nextId('nt-col-name');
    const countId = nextId('nt-col-count');
    col.iconEl = h('span', { class: 'nt-col-icon', 'aria-hidden': 'true' });
    col.nameEl = h('span', { class: 'nt-col-name', id: nameId });
    col.countEl = h('span', { class: 'nt-col-count', 'aria-hidden': 'true' });
    col.srEl = h('span', { class: 'sr-only', id: countId });
    col.addBtn = iconBtn('plus', () => ctx.onNew(id), 'nt-col-plus');
    col.foldBtn = iconBtn('nt-fold', () => ctx.onToggleCollapse(id), 'nt-col-fold');
    col.foldBtn.setAttribute('aria-expanded', 'true');
    col.head = h('div', { class: 'nt-col-head' }, col.iconEl, h('span', { class: 'nt-col-title' }, col.nameEl, col.srEl), col.countEl, col.addBtn, col.foldBtn);
    // The group says "TikTok ideas, 22 notes"; the list inside it needs no second name.
    col.list = h('ul', { class: 'nt-col-list', role: 'list' });
    col.emptyEl = h('div', { class: 'nt-col-empty' });
    // Never a Tab stop of its own (Chrome makes a scroller without focusable children one): the cards are.
    col.body = h('div', { class: 'nt-col-body', tabindex: '-1' }, col.list, col.emptyEl);
    col.newBtn = h('button', { type: 'button', class: 'nt-col-new', tabindex: '-1', onClick: () => ctx.onNew(id) }, icon('plus', { size: 12 }), h('span', null, 'New'));
    // Folded: the whole strip is one button that unfolds the column (and still takes drops).
    col.stripCount = h('span', { class: 'nt-col-count', 'aria-hidden': 'true' });
    col.stripName = h('span', { class: 'nt-col-stripname' });
    col.stripIcon = h('span', { class: 'nt-col-icon', 'aria-hidden': 'true' });
    col.strip = h(
      'button',
      { type: 'button', class: 'nt-col-strip', 'aria-expanded': 'false', 'aria-keyshortcuts': 'ArrowLeft ArrowRight', onClick: () => ctx.onToggleCollapse(id) },
      col.stripIcon,
      col.stripCount,
      col.stripName,
    );
    col.el = h('div', { class: 'nt-col', role: 'group', 'aria-labelledby': `${nameId} ${countId}`, dataset: { col: id } }, col.strip, col.head, col.body, col.newBtn);
    col.el.addEventListener('animationend', () => col.el.classList.remove('is-pulse'));
    return col;
  }

  function paintColumn(col, c) {
    const name = c.section ? c.section.name : 'Unsorted';
    const iconName = c.section ? glyphOf(c.section) : 'inbox';
    const searching = model.terms.length > 0;
    const shown = c.notes.length;
    const sig = [name, iconName, c.total, shown, searching, c.collapsed].join('\u0001');
    if (col.sig === sig) return;
    col.sig = sig;
    col.name = name;
    col.collapsed = c.collapsed;
    col.el.classList.toggle('is-collapsed', c.collapsed);
    col.el.classList.toggle('is-unsorted', !c.section);
    col.iconEl.replaceChildren(icon(iconName, { size: 14 }));
    col.stripIcon.replaceChildren(icon(iconName, { size: 14 }));
    col.nameEl.textContent = name;
    col.stripName.textContent = name;
    const count = searching ? `${num(shown)}/${num(c.total)}` : num(c.total);
    col.countEl.textContent = count;
    col.stripCount.textContent = searching ? num(shown) : num(c.total);
    col.srEl.textContent = searching ? `, ${shown} of ${plural(c.total, 'note')} match` : `, ${plural(c.total, 'note')}`;
    col.head.title = name;
    col.addBtn.setAttribute('aria-label', `New note in ${name}`);
    col.addBtn.title = `New note in ${name}`;
    col.foldBtn.setAttribute('aria-label', `Collapse ${name}`);
    col.foldBtn.title = 'Collapse column';
    col.strip.setAttribute('aria-label', `${name}, ${searching ? `${shown} of ${plural(c.total, 'note')} match` : plural(c.total, 'note')}. Expand column`);
    col.strip.title = `${name} · Expand`;
    col.newBtn.setAttribute('aria-label', `New note in ${name}`);
    col.emptyEl.textContent = c.total ? 'No matches' : 'No notes yet';
    col.emptyEl.hidden = shown > 0;
  }

  /* ---- Cards ---- */

  function createCard(id) {
    const card = { id };
    card.btn = h('button', {
      type: 'button',
      class: 'nt-card',
      dataset: { id },
      tabindex: '-1',
      'aria-describedby': helpId,
      'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight M',
      onClick: (e) => ctx.onOpen(id, { keyboard: e.detail === 0 }),
    });
    card.menu = h(
      'button',
      { type: 'button', class: 'btn btn--ghost btn--icon btn--sm nt-card-menu', tabindex: '-1', 'aria-haspopup': 'menu', title: 'Move to…', onClick: (e) => ctx.onMenu(id, card.menu, { keyboard: e.detail === 0 }) },
      icon('more', { size: 14 }),
    );
    card.li = h('li', { class: ['nt-card-row', fresh && 'is-new'], dataset: { id } }, card.btn, card.menu);
    card.li.addEventListener('animationend', () => card.li.classList.remove('is-new', 'is-landed'));
    return card;
  }

  function fillCard(card, note, terms) {
    const title = note.title.trim();
    const preview = excerpt(note.body, { terms, skip: title, length: 110 });
    // replaceChildren would print a null as text: leave the excerpt out instead.
    card.btn.replaceChildren(
      h('span', { class: ['nt-card-title', !title && 'is-untitled'] }, title ? marked(title, terms) : 'Untitled'),
      ...(preview ? [h('span', { class: 'nt-card-excerpt' }, marked(preview, terms))] : []),
      h(
        'span',
        { class: 'nt-card-foot' },
        h('span', { class: 'nt-card-grip', 'aria-hidden': 'true' }, icon('grip', { size: 12 })),
        h('span', { class: 'nt-card-time label', dataset: { ts: String(note.updatedAt) } }, timeAgo(note.updatedAt)),
        note.pinned ? h('span', { class: 'nt-card-pin label', title: 'Pinned' }, icon('pin', { size: 11 }), h('span', null, 'Pinned')) : null,
      ),
    );
    const name = clip(title, 40) || 'Untitled';
    card.menu.setAttribute('aria-label', `Move “${name}” to…`);
  }

  function cardFor(note, terms, termsKey) {
    let card = cardCache.get(note.id);
    if (!card) {
      card = createCard(note.id);
      cardCache.set(note.id, card);
    }
    if (card.dirty || card.note !== note || card.termsKey !== termsKey) {
      card.note = note;
      card.termsKey = termsKey;
      card.dirty = false;
      fillCard(card, note, terms);
    }
    const open = note.id === model.openId;
    if (open) card.btn.setAttribute('aria-current', 'true');
    else card.btn.removeAttribute('aria-current');
    return card.li;
  }

  /** Mirror an edit that has not been saved yet into its card (live typing). */
  function updateCard(note) {
    const card = cardCache.get(note?.id);
    if (!card?.note) return;
    fillCard(card, note, model.terms);
    card.dirty = true;
  }

  /* ---- Render ---- */

  /** model: { items, sections, terms, collapsed, openId } */
  function update(next) {
    model = { ...model, ...next };
    if (drag?.active) {
      // The lifted card was deleted (another tab): drop the drag, then draw.
      if (!model.items.some((n) => n.id === drag.id)) cancelDrag();
      else {
        // Held back until the drop, but aimed against the new data: another tab may have
        // moved this note or deleted the column under the pointer.
        pending = true;
        drag.home = columnOfId(drag.id) ?? drag.home;
        if (!drag.cancelled) {
          drag.over = undefined;
          aim();
        }
        return;
      }
    }
    render();
  }

  function render() {
    const { items, sections, terms, collapsed } = model;
    const termsKey = terms.join('\u0001');
    const active = document.activeElement;
    const focusEl = active instanceof HTMLElement && scroller.contains(active) ? active : null;
    const focusRow = focusEl?.closest('.nt-card-row');
    const focusId = focusRow?.dataset.id ?? null;
    const focusOnMenu = !!focusEl?.classList.contains('nt-card-menu');
    const focusPos = focusId ? positionOf(focusId) : null;
    const focusCol = focusEl?.closest('.nt-col')?.dataset.col ?? null;

    columns = boardColumns(items, sections, { query: terms, collapsed });
    const live = new Set(columns.map((c) => c.id));
    for (const id of [...colCache.keys()]) if (!live.has(id)) colCache.delete(id);
    const nodes = columns.map((c) => {
      let col = colCache.get(c.id);
      if (!col) {
        col = createColumn(c.id);
        colCache.set(c.id, col);
      }
      paintColumn(col, c);
      syncChildren(col.list, c.collapsed ? [] : c.notes.map((note) => cardFor(note, terms, termsKey)));
      return col.el;
    });
    syncChildren(colsEl, [...nodes, ghost]);

    if (cardCache.size > items.length) {
      const ids = new Set(items.map((n) => n.id));
      for (const id of cardCache.keys()) if (!ids.has(id)) cardCache.delete(id);
    }
    const before = order.join('\u0001');
    order = columns.map((c) => c.id);
    grid = columns.map((c) => (c.collapsed ? [] : c.notes.map((n) => n.id)));
    syncTabStop();
    renderPager();
    // Columns came, went or folded: light the chips again.
    if (order.join('\u0001') !== before || collapsed.join('\u0001') !== lastFolded) inView = '';
    lastFolded = collapsed.join('\u0001');
    scheduleView();
    fresh = true;

    // Re-ordering detaches nodes, which drops focus: put it back on the same card (it may
    // have changed column), else on the card now in its place, else on its column.
    if (!focusEl) return;
    const card = focusId ? cardCache.get(focusId) : null;
    if (card?.btn.isConnected) {
      const target = focusOnMenu ? card.menu : card.btn;
      if (document.activeElement !== target) target.focus({ preventScroll: true });
    } else if (!focusEl.isConnected || document.activeElement !== focusEl) {
      if (focusPos) focusNear(focusPos);
      else if (focusCol) focusColumn(focusCol);
    }
  }

  /** Focus the card at (or just above) a position that just emptied, else that column. */
  function focusNear({ col, row }) {
    const ids = grid[col] ?? [];
    const id = ids[Math.min(row, ids.length - 1)];
    if (id) focusCard(id);
    else if (order[col]) focusColumn(order[col]);
    else focusFallback();
  }

  function positionOf(id) {
    for (let col = 0; col < grid.length; col += 1) {
      const row = grid[col].indexOf(id);
      if (row !== -1) return { col, row };
    }
    return null;
  }

  /** One card is a Tab stop (with its menu button): the last one focused, else the first. */
  function syncTabStop() {
    if (!tabId || !positionOf(tabId)) tabId = grid.find((ids) => ids.length)?.[0] ?? null;
    for (const card of cardCache.values()) {
      const on = card.id === tabId;
      card.btn.tabIndex = on ? 0 : -1;
      card.menu.tabIndex = on ? 0 : -1;
    }
  }

  function onFocusIn(e) {
    const target = e.target instanceof Element ? e.target : null;
    // Tab / Shift+Tab can land on a control under the editor panel: bring its column out
    // from under it. Keyboard focus only: a click never scrolls what it is clicking.
    const colEl = target?.closest('.nt-col');
    if (colEl && visible() && covered() && target.matches(':focus-visible')) {
      showInBox(scroller, colEl.getBoundingClientRect(), 'x', { instant: true, inset: covered() });
    }
    const row = target?.closest('.nt-card-row');
    if (!row) return;
    if (carry && carry !== row.dataset.id) carry = null;
    if (row.dataset.id === tabId) return;
    tabId = row.dataset.id;
    syncTabStop();
  }

  /* ---- Focus & scrolling ---- */

  const visible = () => scroller.offsetParent !== null;

  /** Width of the board hidden under the editor panel (its right side). */
  function covered() {
    const left = ctx.coverLeft?.();
    if (left == null) return 0;
    return Math.max(0, scroller.getBoundingClientRect().right - left);
  }

  function revealCard(id, { instant = false } = {}) {
    const card = cardCache.get(id);
    if (!card?.li.isConnected || !visible()) return;
    const col = card.li.closest('.nt-col');
    if (col) showInBox(scroller, col.getBoundingClientRect(), 'x', { instant, inset: covered() });
    const body = card.li.closest('.nt-col-body');
    if (body) showInBox(body, card.li.getBoundingClientRect(), 'y', { instant, pad: 8 });
  }

  /** Scroll a column into view (and glow it briefly). */
  function revealColumn(id, { instant = false, glow = false } = {}) {
    const col = colCache.get(id);
    if (!col?.el.isConnected || !visible()) return;
    showInBox(scroller, col.el.getBoundingClientRect(), 'x', { instant, inset: covered() });
    if (glow) pulse(id);
  }

  function focusCard(id, { reveal = true } = {}) {
    const card = cardCache.get(id);
    if (!card?.btn.isConnected) return false;
    tabId = id;
    syncTabStop();
    card.btn.focus({ preventScroll: true });
    if (reveal) revealCard(id);
    return true;
  }

  /** A column's first card (the carried one, after a keyboard move into it), else its + button (its strip while folded). */
  function focusColumn(id) {
    const col = colCache.get(id);
    if (!col) return false;
    if (carry && columnOfId(carry) === id && !col.collapsed && focusCard(carry)) return true;
    const first = grid[order.indexOf(id)]?.[0];
    if (first) return focusCard(first);
    const target = col.collapsed ? col.strip : col.addBtn;
    target.focus({ preventScroll: true });
    revealColumn(id);
    return true;
  }

  /** Somewhere sensible when focus lost its element: the Tab-stop card, a column, the + Section strip. */
  function focusFallback() {
    if (tabId && focusCard(tabId)) return;
    if (order[0] && focusColumn(order[0])) return;
    ghost.querySelector('button')?.focus({ preventScroll: true });
  }

  /** The column holding keyboard focus, if any. */
  function focusedColumn() {
    const active = document.activeElement;
    if (!(active instanceof Element) || !scroller.contains(active)) return null;
    return active.closest('.nt-col[data-col]')?.dataset.col ?? null;
  }

  /** The card holding keyboard focus (or its menu button), if any. */
  function focusedId() {
    const active = document.activeElement;
    if (!(active instanceof Element) || !scroller.contains(active)) return null;
    return active.closest('.nt-card-row')?.dataset.id ?? null;
  }

  /** '[' / ']': focus the previous / next column (from the focused one, else the Tab-stop card's). */
  function stepColumn(delta) {
    const from = focusedColumn() ?? (tabId ? columnOfId(tabId) : null);
    const target = from ? adjacentColumn(order, from, delta) : order[delta < 0 ? order.length - 1 : 0];
    if (target) focusColumn(target);
    return target;
  }

  function pulse(id) {
    const col = colCache.get(id);
    if (col) replay(col.el, 'is-pulse');
  }

  /** A card just arrived in its column: scroll the column to it (recency order may put it far down) and glow it. */
  function landed(id) {
    const card = cardCache.get(id);
    if (!card?.li.isConnected) return;
    const body = card.li.closest('.nt-col-body');
    if (body && visible()) showInBox(body, card.li.getBoundingClientRect(), 'y', { pad: 8 });
    replay(card.li, 'is-landed');
  }

  function setOpen(id) {
    // The panel opened or closed: what shows of the board changed.
    scheduleView();
    if (model.openId === id) return;
    model = { ...model, openId: id };
    for (const card of cardCache.values()) {
      if (card.id === id) card.btn.setAttribute('aria-current', 'true');
      else card.btn.removeAttribute('aria-current');
    }
  }

  const noteById = (id) => model.items.find((n) => n.id === id) ?? null;
  const columnOfId = (id) => {
    const note = noteById(id);
    return note ? columnOf(note, model.sections) : null;
  };
  const labelOf = (column) => (column === VIEW_UNSORTED ? 'Unsorted' : findSection(model.sections, column)?.name ?? 'Unsorted');
  const columnExists = (column) => column === VIEW_UNSORTED || !!findSection(model.sections, column);

  /* ---- Keyboard ---- */

  function onKey(e) {
    if (drag || e.isComposing) return;
    const strip = e.target instanceof Element ? e.target.closest('.nt-col-strip') : null;
    if (strip) {
      onStripKey(e, strip);
      return;
    }
    const row = e.target instanceof Element ? e.target.closest('.nt-card-row') : null;
    if (!row) return;
    const id = row.dataset.id;
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        moveBy(id, e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        ctx.onAnnounce('Cards stay newest first in a column. Alt plus Left or Right moves a card to another column.');
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      const card = cardCache.get(id);
      if (card) ctx.onMenu(id, card.btn, { keyboard: true });
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    // Arrows never scroll the board under the focus, even at an edge.
    e.preventDefault();
    const pos = positionOf(id);
    const to = pos ? boardFocusTarget(grid, pos, e.key) : null;
    if (to) focusCard(grid[to.col][to.row]);
  }

  /**
   * A folded column's strip: ←/→ go on to the neighbouring column; Alt+←/→ carry on moving
   * the card a keyboard move just filed here, so TikTok → Done never stops at a folded column.
   */
  function onStripKey(e, strip) {
    const column = strip.closest('.nt-col[data-col]')?.dataset.col;
    if (!column || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' ? -1 : 1;
    if (!e.altKey) {
      stepColumn(delta);
      return;
    }
    if (carry && columnOfId(carry) === column) moveBy(carry, delta);
    else ctx.onAnnounce(`${labelOf(column)} is collapsed. Press Enter to expand it.`);
  }

  /** Alt+←/→: file the card under the neighbouring column (Unsorted included); focus follows it. */
  function moveBy(id, delta) {
    const from = columnOfId(id);
    const to = from ? adjacentColumn(moveOrder(order), from, delta) : null;
    if (!to) {
      ctx.onAnnounce(delta < 0 ? 'Already in the first column.' : 'Already in the last column.');
      return;
    }
    ctx.onMove(id, to, { via: 'keyboard' });
    if (columnOfId(id) !== to) return; // refused (the section went meanwhile)
    carry = null;
    if (!focusCard(id)) {
      // Folded there: its strip holds the card, and the next Alt+arrow carries it on.
      const col = colCache.get(to);
      if (col?.collapsed) {
        carry = id;
        col.strip.focus({ preventScroll: true });
      }
    }
    revealColumn(to);
  }

  /* ---- Pointer drag ---- */

  function onPointerDown(e) {
    if (drag || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const btn = e.target instanceof Element ? e.target.closest('.nt-card') : null;
    if (!btn || !scroller.contains(btn)) return;
    // Only the card itself is a handle: never a link or control inside it.
    const control = e.target.closest('a, button, input, textarea, select, label, [contenteditable="true"]');
    if (control && control !== btn) return;
    const id = btn.dataset.id;
    const home = columnOfId(id);
    if (!home) return;
    drag = {
      id,
      btn,
      li: btn.closest('.nt-card-row'),
      home,
      pointerId: e.pointerId,
      touch: e.pointerType === 'touch',
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      cancelled: false,
      over: undefined,
      via: null,
      target: null,
      slotCol: null,
      timer: 0,
      raf: 0,
      aimRaf: 0,
      slotTimer: 0,
      scrolled: new Map(), // column body -> scrollTop before it showed the slot
    };
    if (drag.touch) {
      // The card sinks a little while the finger holds it: it is about to lift.
      btn.classList.add('is-pressing');
      drag.timer = setTimeout(lift, LONG_PRESS_MS);
    }
    listen(true);
  }

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('pointermove', onMove);
    window[method]('pointerup', onUp);
    window[method]('pointercancel', onCancel);
    window[method]('blur', onCancel);
    window[method]('keydown', onDragKey, true);
    document[method]('selectstart', onSelectStart);
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      const dist = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
      if (drag.touch) {
        // Moving before the long press completes is a swipe: let the board scroll.
        if (dist > TOUCH_SLOP) end();
        return;
      }
      if (dist < DRAG_THRESHOLD) return;
      lift();
      if (!drag?.active) return;
    }
    if (drag.cancelled) return;
    placeLift();
    aim();
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
  }

  /**
   * Pick the card up: a copy follows the pointer (by touch, a compact title above the finger,
   * so the column under it stays in sight), the original stays as a dashed outline, and the
   * pager turns into the drop dock.
   */
  function lift() {
    const d = drag;
    if (!d || d.active) return;
    clearTimeout(d.timer);
    d.timer = 0;
    d.btn.classList.remove('is-pressing');
    if (!d.btn.isConnected) {
      end();
      return;
    }
    d.active = true;
    const r = d.btn.getBoundingClientRect();
    d.offX = clamp(d.x0 - r.left, 0, r.width);
    d.offY = clamp(d.y0 - r.top, 0, r.height);
    d.toEl = h('span', { class: 'nt-lift-to' });
    if (d.touch) {
      const title = clip(noteById(d.id)?.title ?? '', 60) || 'Untitled';
      d.liftEl = h(
        'div',
        { class: 'nt-lift is-touch', 'aria-hidden': 'true' },
        h('span', { class: 'nt-lift-pill' }, icon('grip', { size: 12 }), h('span', { class: 'nt-lift-title' }, title)),
        d.toEl,
      );
    } else {
      const copy = d.btn.cloneNode(true);
      copy.removeAttribute('tabindex');
      copy.removeAttribute('aria-current');
      copy.removeAttribute('aria-describedby');
      d.liftEl = h('div', { class: 'nt-lift', 'aria-hidden': 'true', style: { width: `${Math.round(r.width)}px` } }, copy, d.toEl);
    }
    document.body.append(d.liftEl);
    d.liftW = d.liftEl.offsetWidth;
    d.liftH = d.liftEl.offsetHeight;
    d.slot = h('li', { class: 'nt-card-slot', 'aria-hidden': 'true', style: { height: `${Math.round(r.height)}px` } });
    d.li.classList.add('is-drag-source');
    scroller.classList.add('is-dragging');
    pager.classList.add('is-docking');
    chipCache.get(d.home)?.btn.classList.add('is-home');
    ctx.host?.classList.add('nt-is-dragging');
    window.getSelection()?.removeAllRanges();
    try {
      d.btn.setPointerCapture(d.pointerId);
    } catch {
      // capture only keeps events coming outside the window; the drag works without it
    }
    if (d.touch) buzz();
    placeLift();
    aim();
  }

  function placeLift() {
    const d = drag;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let left;
    let top;
    if (d.touch) {
      left = clamp(d.x - d.liftW / 2, 4, Math.max(4, vw - d.liftW - 4));
      top = clamp(d.y - d.liftH - LIFT_GAP, 4, Math.max(4, vh - d.liftH - 4));
    } else {
      left = clamp(d.x - d.offX, 4 - d.liftW / 2, vw - d.liftW / 2);
      top = clamp(d.y - d.offY, 4 - d.liftH / 2, vh - d.liftH / 2);
    }
    d.liftEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /**
   * The column a lifted card is over: a dock chip, else the column under the pointer's x
   * anywhere from the board's top to its footer (gaps and the strip below count).
   */
  function overAt(x, y) {
    const d = drag;
    d.via = null;
    const el = document.elementFromPoint(x, y);
    const chip = el instanceof Element ? el.closest('.nt-pager-chip') : null;
    if (chip && pager.contains(chip)) {
      d.via = 'dock';
      return chip.dataset.col;
    }
    if (!visible()) return null;
    const sr = scroller.getBoundingClientRect();
    const bottom = Math.max(sr.bottom, scroller.parentElement?.getBoundingClientRect().bottom ?? 0);
    if (y < sr.top || y > bottom) return null;
    const cover = covered();
    const right = sr.right - cover;
    // Just past the board's side (a phone's gutter, the screen edge) is that edge; never over the editor panel.
    let at = x;
    if (x < sr.left && x >= sr.left - EDGE_SLACK) at = sr.left;
    else if (!cover && x > right && x <= right + EDGE_SLACK) at = right;
    const id = columnAtX(order.map(spanOf).filter(Boolean), at, { left: sr.left, right });
    if (id) d.via = 'board';
    return id;
  }

  /** Light the column (and dock chip) under the pointer and show where the card would land. */
  function aim() {
    const d = drag;
    if (!d?.active || d.cancelled || !d.liftEl) return;
    const over = overAt(d.x, d.y);
    if (over === d.over) return;
    d.over = over;
    // A column deleted in another tab (its render is held back until the drop) takes nothing.
    const gone = over != null && !columnExists(over);
    d.target = over && over !== d.home && !gone ? over : null;
    for (const col of colCache.values()) {
      col.el.classList.toggle('is-drop', col.id === d.target);
      col.el.classList.toggle('is-home', col.id === d.home && over === d.home);
      col.el.classList.toggle('is-gone', gone && col.id === over);
    }
    for (const chip of chipCache.values()) {
      chip.btn.classList.toggle('is-drop', chip.id === d.target);
      chip.btn.classList.toggle('is-home', chip.id === d.home);
    }
    d.liftEl.classList.toggle('is-armed', !!d.target);
    d.toEl.textContent = d.target ? `Move to ${clip(labelOf(d.target), 28)}` : gone ? 'Section deleted' : over ? 'Already here' : 'Drop on a column';
    placeSlot();
  }

  /**
   * The marker sits where recency order will put the card (no manual order inside a column),
   * and the target column scrolls to it, so a card that lands far down never seems to vanish.
   */
  function placeSlot() {
    const d = drag;
    const col = d.target ? colCache.get(d.target) : null;
    if (!col || col.collapsed) {
      d.slot.remove();
      d.slotCol = null;
      for (const c of colCache.values()) c.el.classList.remove('has-slot');
      return;
    }
    if (d.slotCol === d.target) return;
    d.slotCol = d.target;
    for (const c of colCache.values()) c.el.classList.toggle('has-slot', c === col);
    const shown = columns.find((c) => c.id === d.target)?.notes ?? [];
    const at = landingIndex(shown, noteById(d.id));
    d.slot.remove();
    col.list.insertBefore(d.slot, col.list.children[at] ?? null);
    clearTimeout(d.slotTimer);
    d.slotTimer = setTimeout(() => revealSlot(col), SLOT_DWELL_MS);
  }

  /** Scroll the target column to its slot, remembering where it was (a column only passed over is put back). */
  function revealSlot(col) {
    const d = drag;
    if (!d?.active || d.cancelled || d.slotCol !== col.id || !d.slot.isConnected) return;
    if (!d.scrolled.has(col.body)) d.scrolled.set(col.body, col.body.scrollTop);
    showInBox(col.body, d.slot.getBoundingClientRect(), 'y', { pad: 8 });
  }

  /** Columns scrolled to show a slot go back to where they were, except the one the card landed in. */
  function restoreScroll(d, keep) {
    for (const [body, top] of d.scrolled) {
      if (body !== keep && body.isConnected) body.scrollTo({ top, behavior: 'auto' });
    }
    d.scrolled.clear();
  }

  /**
   * Held near an edge, the board (sideways) or the column (up / down) keeps scrolling. The
   * board stops once the last (or first) column is fully in view: past it is no drop target.
   */
  function autoScroll() {
    const d = drag;
    if (!d) return;
    d.raf = 0;
    if (!d.active || d.cancelled) return;
    let moved = false;
    const step = (pos, lo, hi, band) => {
      if (pos < lo + band) return -Math.min(1, (lo + band - pos) / band);
      if (pos > hi - band) return Math.min(1, (pos - hi + band) / band);
      return 0;
    };
    const pixels = (s) => (s ? Math.round(s * EDGE_SPEED) || Math.sign(s) : 0);
    if (d.via === 'board') {
      const r = scroller.getBoundingClientRect();
      const right = r.right - covered();
      const want = pixels(step(d.x, r.left, right, Math.min(EDGE_BAND, (right - r.left) / 4)));
      const px = clampEdgeScroll(want, { first: spanOf(order[0]), last: spanOf(order[order.length - 1]), lo: r.left, hi: right, pad: EDGE_PAD });
      if (px) {
        const before = scroller.scrollLeft;
        scroller.scrollLeft = before + px;
        if (scroller.scrollLeft !== before) moved = true;
      }
      const body = d.over ? colCache.get(d.over)?.body : null;
      if (body?.isConnected && body.offsetParent !== null) {
        const b = body.getBoundingClientRect();
        if (d.x >= b.left && d.x <= b.right && d.y >= b.top - BODY_REACH && d.y <= b.bottom + BODY_REACH) {
          const dy = pixels(step(d.y, b.top, b.bottom, Math.min(EDGE_BAND, b.height / 4)));
          const before = body.scrollTop;
          if (dy) body.scrollTop = before + dy;
          if (body.scrollTop !== before) moved = true;
        }
      }
    }
    if (!moved) return;
    // Columns moved under a resting pointer: aim again.
    aim();
    d.raf = requestAnimationFrame(autoScroll);
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // Aim from where the button came up: the board may have scrolled since the last move.
    if (drag.active && !drag.cancelled) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.over = undefined;
      aim();
    }
    const missed = drag.active && !drag.cancelled && !drag.target;
    const d = end({ fly: missed });
    // No drag happened: the card's own click opens the note.
    if (!d.active) return;
    swallowClick(scroller);
    if (d.cancelled) return;
    if (d.target) ctx.onMove(d.id, d.target, { via: 'pointer' });
    else ctx.onAnnounce('Not moved.');
  }

  function onDragKey(e) {
    if (e.key !== 'Escape' || !drag?.active || drag.cancelled) return;
    e.preventDefault();
    e.stopPropagation();
    // Keep tracking until the button is released so its click can be swallowed.
    drag.cancelled = true;
    clearVisuals(drag, { fly: true });
    ctx.onAnnounce('Move cancelled.');
  }

  function onCancel(e) {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    end({ fly: drag.active && !drag.cancelled });
  }

  function onSelectStart(e) {
    if (drag?.active) e.preventDefault();
  }

  /** A card dropped nowhere (or cancelled) glides back to where it came from. */
  function flyBack(d) {
    const el = d.liftEl;
    d.liftEl = null;
    if (!el) return;
    const home = d.li?.isConnected ? d.li.getBoundingClientRect() : null;
    if (!home?.width || reducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('is-returning');
    el.style.transform = `translate(${Math.round(home.left)}px, ${Math.round(home.top)}px)`;
    setTimeout(() => el.remove(), 220);
  }

  function clearVisuals(d, { fly = false } = {}) {
    if (fly) flyBack(d);
    else d.liftEl?.remove();
    d.liftEl = null;
    d.slot?.remove();
    d.li?.classList.remove('is-drag-source');
    d.btn?.classList.remove('is-pressing');
    scroller.classList.remove('is-dragging');
    pager.classList.remove('is-docking');
    ctx.host?.classList.remove('nt-is-dragging');
    for (const col of colCache.values()) col.el.classList.remove('is-drop', 'is-home', 'has-slot', 'is-gone');
    for (const chip of chipCache.values()) chip.btn.classList.remove('is-drop', 'is-home');
  }

  function end({ fly = false } = {}) {
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    clearTimeout(d.slotTimer);
    cancelAnimationFrame(d.raf);
    cancelAnimationFrame(d.aimRaf);
    listen(false);
    const dropped = d.active && !d.cancelled && d.target ? colCache.get(d.target)?.body : null;
    restoreScroll(d, dropped);
    clearVisuals(d, { fly });
    if (pending) {
      pending = false;
      render();
    }
    return d;
  }

  /** Drop any drag in progress, putting everything back. */
  function cancelDrag() {
    if (drag) end();
  }

  function destroy() {
    cancelDrag();
    cancelAnimationFrame(viewRaf);
    resizeWatch?.disconnect();
    scroller.removeEventListener('touchmove', onTouchMove);
  }

  return {
    el: scroller,
    pager,
    update,
    updateCard,
    setOpen,
    focusCard,
    focusColumn,
    focusFallback,
    focusedColumn,
    focusedId,
    stepColumn,
    revealCard,
    revealColumn,
    pulse,
    landed,
    hasFocus: () => {
      const active = document.activeElement;
      return active instanceof Node && scroller.contains(active);
    },
    columnOrder: () => order.slice(),
    firstCard: () => grid.find((ids) => ids.length)?.[0] ?? null,
    dragging: () => !!drag?.active,
    cancelDrag,
    destroy,
  };
}
