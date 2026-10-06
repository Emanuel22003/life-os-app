// LIFE/OS — Notes: sections (folders) UI.
//
// Rendering only: the sections rail (wide workspace), the chip strip (narrow
// workspace), the move menu and the section dialogs. Every change is reported
// through callbacks; notes.js owns the store, the selection and the autosave.

import { h, icon, registerIcon, openModal, num, plural, clamp } from '../ui.js';
import {
  VIEW_ALL,
  VIEW_UNSORTED,
  SECTION_NAME_MAX,
  SECTION_ICONS,
  SECTION_ICON_LABELS,
  cleanSectionName,
  validateSectionName,
  sectionIcon,
  availableSuggestions,
  findSection,
  clip,
} from './notes.logic.js';

const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
export const ALT_KEY = IS_MAC ? '⌥' : 'Alt';

const DRAG_THRESHOLD = 5;
// Dragging a note near the rail's top or bottom edge scrolls it (px band, px per frame).
const EDGE_BAND = 36;
const EDGE_SPEED = 12;
// Phones get the move menu as a small dialog instead of a popover.
const SHEET_QUERY = '(max-width: 640px)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/* ==========================================================================
   Icons (24px grid, 1.5 stroke, same drawing style as ui.js)
   Registered under an nt- prefix so they never replace an app-wide icon of the
   same name; stored section icons stay unprefixed ('video') and map via sectionGlyph().
   ========================================================================== */

const SECTION_SVGS = {
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
  play: '<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
};

for (const [name, svg] of Object.entries(SECTION_SVGS)) registerIcon(`nt-${name}`, svg);
// Module glyphs: "All notes" (a stack) and "Manage sections" (sliders)
registerIcon('nt-all', '<path d="m12 3 9 4.5-9 4.5-9-4.5Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>');
registerIcon('nt-sliders', '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>');

/** The icon to draw for a stored section icon value: 'video' -> 'nt-video'; ui.js names ('note', 'flag') pass through. */
export function sectionGlyph(name) {
  return Object.hasOwn(SECTION_SVGS, name) ? `nt-${name}` : name;
}

/** The icon to draw for a section (its own icon, or the default folder). */
export function glyphOf(section) {
  return sectionGlyph(sectionIcon(section));
}

/* ==========================================================================
   Small helpers
   ========================================================================== */

let seq = 0;
const nextId = (prefix) => `${prefix}-${(seq += 1)}`;

export function hint(keys, label) {
  return h('span', { class: 'nt-hint lo-hint' }, keys.map((k) => h('span', { class: 'kbd' }, k)), h('span', null, label));
}

/** The glyph for a view: a stack for All notes, an inbox for Unsorted, else the section's icon. */
export function viewIconName(sections, view) {
  if (view === VIEW_ALL) return 'nt-all';
  if (view === VIEW_UNSORTED) return 'inbox';
  return glyphOf(findSection(sections, view));
}

/** Code points of the name as it would be saved before the 40-symbol cut (the counter). */
const nameLength = (raw) => [...cleanSectionName(raw, { max: Infinity })].length;
const TOO_LONG = `Names stop at ${SECTION_NAME_MAX} characters. The rest is cut off.`;

function iconButton(name, label, onClick, className = '') {
  return h(
    'button',
    { type: 'button', class: ['btn btn--ghost btn--icon btn--sm', className], 'aria-label': label, title: label, onClick },
    icon(name),
  );
}

function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const scrollBehavior = () => (window.matchMedia(REDUCED_MOTION).matches ? 'auto' : 'smooth');

/** Scroll `box` just enough to show `el` (axis 'x' or 'y'); `instant` skips the smooth scroll. */
function scrollIntoBox(box, el, axis, instant = false) {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  // Horizontally, clear the strip's 28px edge fade.
  const pad = axis === 'x' ? 40 : 16;
  const [start, end, size] = axis === 'x' ? ['left', 'right', 'width'] : ['top', 'bottom', 'height'];
  if (!b[size]) return;
  let delta = 0;
  if (r[start] < b[start] + pad) delta = r[start] - b[start] - pad;
  else if (r[end] > b[end] - pad) delta = r[end] - b[end] + pad;
  if (delta) box.scrollBy({ [axis === 'x' ? 'left' : 'top']: delta, behavior: instant ? 'auto' : scrollBehavior() });
}

/** Arrow / Home / End focus movement across `items`. True when the key was handled. */
function arrowFocus(e, items, { prev = 'ArrowUp', next = 'ArrowDown', wrap = false } = {}) {
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement);
  const last = items.length - 1;
  let to;
  if (e.key === next) to = i === -1 ? 0 : i === last ? (wrap ? 0 : last) : i + 1;
  else if (e.key === prev) to = i === -1 ? last : i === 0 ? (wrap ? last : 0) : i - 1;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = last;
  else return false;
  e.preventDefault();
  items[to].focus();
  return true;
}

/** One-click starter sections. `verb` prefixes each chip's accessible name. */
function suggestionChips(list, onPick, { verb, stack = false, custom = null } = {}) {
  return h(
    'div',
    { class: ['nt-suggest', stack && 'nt-suggest--stack'], role: 'group', 'aria-label': 'Suggested sections' },
    list.map((s) =>
      h(
        'button',
        { type: 'button', class: 'nt-suggest-chip', 'aria-label': `${verb} “${s.name}”`, onClick: () => onPick(s) },
        icon(sectionGlyph(s.icon), { size: 14 }),
        h('span', { class: 'nt-suggest-name' }, s.name),
        stack ? icon('plus', { size: 12, className: 'nt-suggest-plus' }) : null,
      ),
    ),
    custom
      ? h('button', { type: 'button', class: 'nt-suggest-chip is-custom', onClick: custom }, icon('plus', { size: 14 }), h('span', { class: 'nt-suggest-name' }, 'Custom…'))
      : null,
  );
}

/* ==========================================================================
   Rail (wide workspace) + chip strip (narrow workspace)
   ========================================================================== */

/**
 * ctx: { onView(view), onCreate(), onSuggest({ name, icon }), onManage(), onEdit(id),
 *        onDelete(id), onRename(id, name) -> error | null, onRenameRefused(id, error),
 *        onReorder(id, index), onMoveBy(id, delta) }
 */
export function createSectionNav(ctx) {
  let model = { sections: [], view: VIEW_ALL, counts: { all: 0, unsorted: 0, bySection: Object.create(null) } };
  let renaming = null; // { id, input, msg }
  let drag = null; // a section row being reordered by pointer
  let stripSig = '';
  let fresh = false; // rows created after the first update animate in
  let tabView = null; // the rail row in the Tab order: the last one focused, else the open view

  /* ---- Rail ---- */

  const totalEl = h('span', { class: 'label nt-rail-total' });
  const fixedRows = new Map([VIEW_ALL, VIEW_UNSORTED].map((view) => [view, createRow(view, true)]));
  const rows = new Map(); // section id -> row
  const sectionList = h('ul', { class: 'nt-rail-list', role: 'list', 'aria-label': 'Your sections' });
  const railEmpty = h('div', { class: 'nt-rail-empty', hidden: true });
  const railBody = h(
    'div',
    { class: 'nt-rail-body', onKeydown: onRailKey, onFocusin: onRailFocus },
    h('ul', { class: 'nt-rail-list', role: 'list' }, [...fixedRows.values()].map((r) => r.li)),
    h('div', { class: 'nt-rail-sep', 'aria-hidden': 'true' }),
    sectionList,
    railEmpty,
  );
  const rail = h(
    'section',
    { class: 'panel hud nt-rail', 'aria-label': 'Sections' },
    h(
      'div',
      { class: 'nt-rail-head' },
      h('span', { class: 'label' }, 'Sections'),
      totalEl,
      h('span', { class: 'spacer' }),
      iconButton('nt-sliders', 'Manage sections', () => ctx.onManage()),
      iconButton('plus', 'New section', () => ctx.onCreate()),
    ),
    railBody,
    // One line, so its rule lines up with the list and editor footers; row keys live in the row tooltips.
    h('div', { class: 'nt-foot nt-hints label' }, hint(['[', ']'], 'Switch')),
  );

  function createRow(view, fixed = false) {
    const row = { view, sig: '' };
    row.iconEl = h('span', { class: 'nt-rail-icon', 'aria-hidden': 'true' });
    row.nameEl = h('span', { class: 'nt-rail-name' });
    row.srEl = h('span', { class: 'sr-only' });
    row.countEl = h('span', { class: 'nt-rail-count', 'aria-hidden': 'true' });
    row.btn = h(
      'button',
      {
        type: 'button',
        class: 'nt-rail-item',
        dataset: { view },
        tabindex: '-1',
        'aria-keyshortcuts': fixed ? null : 'F2 Delete Alt+ArrowUp Alt+ArrowDown',
        onClick: () => ctx.onView(view),
        onDblclick: fixed ? null : () => startRename(view),
      },
      row.iconEl,
      row.nameEl,
      row.srEl,
      row.countEl,
    );
    row.li = h('li', { class: ['nt-srow', fixed && 'nt-srow--fixed', !fixed && fresh && 'is-new'], dataset: { view } }, row.btn);
    row.li.addEventListener('animationend', () => row.li.classList.remove('is-new', 'is-pulse'));
    // Notes can be dropped on Unsorted and on any section, not on All notes.
    if (view !== VIEW_ALL) row.li.dataset.drop = view;
    if (fixed) return row;

    // Pointer-only affordance over the icon (keyboard users reorder with Alt+arrows).
    const grip = h('span', { class: 'nt-sgrip', 'aria-hidden': 'true', title: 'Drag to reorder', onPointerdown: (e) => startDrag(e, view) }, icon('grip', { size: 14 }));
    row.edit = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', tabindex: '-1', onClick: () => ctx.onEdit(view) }, icon('edit', { size: 14 }));
    row.del = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', tabindex: '-1', onClick: () => ctx.onDelete(view) }, icon('trash', { size: 14 }));
    row.li.prepend(grip);
    row.li.append(h('div', { class: 'row-actions nt-srow-actions' }, row.edit, row.del));
    return row;
  }

  function paint(row, { name, iconName, count, selected }) {
    const sig = [name, iconName, count, selected].join('\u0001');
    if (row.sig === sig) return;
    row.sig = sig;
    row.iconEl.replaceChildren(icon(iconName));
    row.nameEl.textContent = name;
    row.srEl.textContent = `, ${plural(count, 'note')}`;
    row.countEl.textContent = num(count);
    if (selected) row.btn.setAttribute('aria-current', 'true');
    else row.btn.removeAttribute('aria-current');
    row.li.classList.toggle('is-current', selected);
    if (!row.edit) return;
    // The full name when the row truncates it, plus the row's keys.
    row.btn.title = `${name}\nF2 rename · Del delete · ${ALT_KEY}+↑↓ reorder`;
    row.edit.setAttribute('aria-label', `Edit ${name}`);
    row.edit.title = 'Edit section';
    row.del.setAttribute('aria-label', `Delete ${name}`);
    row.del.title = 'Delete section';
  }

  function update(next) {
    const viewChanged = next.view !== model.view;
    model = next;
    const { sections, view, counts } = next;
    totalEl.textContent = num(sections.length);
    paint(fixedRows.get(VIEW_ALL), { name: 'All notes', iconName: 'nt-all', count: counts.all, selected: view === VIEW_ALL });
    paint(fixedRows.get(VIEW_UNSORTED), { name: 'Unsorted', iconName: 'inbox', count: counts.unsorted, selected: view === VIEW_UNSORTED });

    const live = new Set(sections.map((s) => s.id));
    for (const id of [...rows.keys()]) {
      if (live.has(id)) continue;
      if (drag?.id === id) cancelDrag();
      if (renaming?.id === id) renaming = null;
      rows.delete(id);
    }
    const nodes = sections.map((s) => {
      let row = rows.get(s.id);
      if (!row) {
        row = createRow(s.id);
        rows.set(s.id, row);
      }
      paint(row, { name: s.name, iconName: glyphOf(s), count: counts.bySection[s.id] ?? 0, selected: s.id === view });
      return row.li;
    });
    if (!drag) placeRows(nodes);
    railBody.classList.toggle('has-sections', sections.length > 0);
    renderSuggestions(sections);
    if (viewChanged) tabView = null;
    syncTabStops();
    renderStrip();
    // The first paint jumps straight to the view; later changes glide.
    if (viewChanged) revealView(view, { instant: !fresh });
    fresh = true;
  }

  /** Put the section rows in order without losing keyboard focus. */
  function placeRows(nodes) {
    const kids = sectionList.children;
    if (kids.length === nodes.length && nodes.every((n, i) => kids[i] === n)) return;
    const active = document.activeElement;
    const keep = active instanceof HTMLElement && sectionList.contains(active) ? active : null;
    sectionList.replaceChildren(...nodes);
    if (keep?.isConnected && document.activeElement !== keep) keep.focus({ preventScroll: true });
  }

  /**
   * Roving Tab stop: the rail is one stop (the last focused row, else the open view)
   * plus that row's Edit / Delete; arrow keys move between rows.
   */
  function syncTabStops() {
    const stop = rowFor(tabView) ? tabView : model.view;
    for (const row of [...fixedRows.values(), ...rows.values()]) {
      const on = row.view === stop;
      row.btn.tabIndex = on ? 0 : -1;
      if (row.edit) {
        row.edit.tabIndex = on ? 0 : -1;
        row.del.tabIndex = on ? 0 : -1;
      }
    }
  }

  function onRailFocus(e) {
    const btn = e.target instanceof Element ? e.target.closest('.nt-rail-item') : null;
    if (!btn || btn.dataset.view === tabView) return;
    tabView = btn.dataset.view;
    syncTabStops();
  }

  function renderSuggestions(sections) {
    railEmpty.hidden = sections.length > 0;
    if (sections.length || railEmpty.firstChild) return;
    railEmpty.append(
      h('p', { class: 'nt-rail-hint' }, 'Keep notes apart: one section per stream of ideas.'),
      suggestionChips(availableSuggestions([]), (s) => ctx.onSuggest(s), { verb: 'Create section', stack: true, custom: () => ctx.onCreate() }),
    );
  }

  function onRailKey(e) {
    const btn = e.target instanceof Element ? e.target.closest('.nt-rail-item') : null;
    if (!btn || renaming) return;
    const view = btn.dataset.view;
    const isSection = rows.has(view);
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (isSection && !drag) ctx.onMoveBy(view, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (isSection && e.key === 'F2') {
      e.preventDefault();
      startRename(view);
    } else if (isSection && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      ctx.onDelete(view);
    } else {
      arrowFocus(e, [...railBody.querySelectorAll('.nt-rail-item')]);
    }
  }

  /* ---- Inline rename (F2 / double-click): Enter saves, Esc cancels ---- */

  function startRename(id) {
    const row = rows.get(id);
    const section = findSection(model.sections, id);
    if (!row || !section || drag) return;
    if (renaming) finishRename({ save: false });
    const msg = h('div', { class: 'nt-srow-msg', id: nextId('nt-rename-msg'), 'aria-live': 'polite' });
    // No maxlength: it counts UTF-16 units (an emoji is two), the name rule counts symbols.
    const input = h('input', {
      class: 'nt-rename',
      type: 'text',
      value: section.name,
      'aria-label': `Rename section ${section.name}`,
      'aria-describedby': msg.id,
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
      onInput: () => checkRename(false),
      onKeydown: onRenameKey,
      onBlur: () => {
        // Switching to another window is not leaving the field: it is still focused on return.
        if (!document.hasFocus() && document.activeElement === input) return;
        finishRename({ save: true, quiet: true });
      },
    });
    renaming = { id, input, msg };
    row.li.classList.add('is-renaming');
    row.btn.after(input);
    row.li.append(msg);
    input.focus();
    input.select();
  }

  /** Live check: duplicates and built-in names show right away, emptiness only on save. */
  function checkRename(strict) {
    const r = renaming;
    if (!r) return null;
    const v = validateSectionName(r.input.value, model.sections, r.id);
    const show = !v.ok && (strict || v.code !== 'empty');
    r.msg.textContent = show ? v.error : nameLength(r.input.value) > SECTION_NAME_MAX ? TOO_LONG : '';
    r.input.setAttribute('aria-invalid', String(show));
    return v;
  }

  function onRenameKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRename({ save: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishRename({ save: false });
    }
  }

  /**
   * save: try the new name. An invalid name keeps the field open with the reason,
   * unless `quiet` (focus left the field): then the edit is dropped and the reason
   * reported through ctx.onRenameRefused, since the inline message leaves with the field.
   */
  function finishRename({ save, quiet = false }) {
    const r = renaming;
    if (!r) return;
    if (save) {
      const v = checkRename(true);
      const error = v?.ok ? ctx.onRename(r.id, v.name) : v?.error;
      if (error && !quiet) {
        r.msg.textContent = error;
        r.input.setAttribute('aria-invalid', 'true');
        replay(r.input, 'is-shake');
        return;
      }
      if (error) ctx.onRenameRefused?.(r.id, error);
    }
    renaming = null;
    const row = rows.get(r.id);
    const hadFocus = document.activeElement === r.input;
    if (row) {
      row.li.classList.remove('is-renaming');
      if (hadFocus) row.btn.focus({ preventScroll: true });
    }
    r.input.remove();
    r.msg.remove();
  }

  /* ---- Pointer drag to reorder (rows sort live under the pointer) ---- */

  function startDrag(e, id) {
    if (drag || renaming || e.button !== 0) return;
    const row = rows.get(id);
    if (!row) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety; the window listeners track the pointer either way
    }
    drag = { id, row, pointerId: e.pointerId, startY: e.clientY, from: [...sectionList.children].indexOf(row.li), active: false };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('keydown', onDragKey, true);
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.row.li.classList.add('is-dragging');
      rail.classList.add('is-sorting');
    }
    const others = [...sectionList.children].filter((li) => li !== drag.row.li);
    const at = others.findIndex((li) => {
      const r = li.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    const before = at === -1 ? null : others[at];
    if (drag.row.li.nextElementSibling !== before || (before === null && sectionList.lastElementChild !== drag.row.li)) {
      sectionList.insertBefore(drag.row.li, before);
    }
    scrollIntoBox(railBody, drag.row.li, 'y');
  }

  function onDragKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
  }

  function releaseDrag() {
    const d = drag;
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', cancelDrag);
    window.removeEventListener('blur', cancelDrag);
    window.removeEventListener('keydown', onDragKey, true);
    d.row.li.classList.remove('is-dragging');
    rail.classList.remove('is-sorting');
    return d;
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = releaseDrag();
    if (!d.active) {
      // A press without movement on the icon area still opens the section.
      ctx.onView(d.id);
      d.row.btn.focus({ preventScroll: true });
      return;
    }
    const to = [...sectionList.children].indexOf(d.row.li);
    if (to !== -1 && to !== d.from) ctx.onReorder(d.id, to);
    else update(model); // put the rows back where the state says
    d.row.btn.focus({ preventScroll: true });
  }

  function cancelDrag(e) {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    releaseDrag();
    update(model);
  }

  /* ---- Chip strip ---- */

  const chips = h('div', { class: 'nt-chips', role: 'group', 'aria-label': 'Sections', onScroll: updateFades, onKeydown: onChipKey });
  const chipsWrap = h('div', { class: 'nt-chips-wrap' }, chips);
  // One node for the life of the strip, so focus can return to it after the dialog it opens.
  const addChip = h(
    'button',
    { type: 'button', class: 'nt-chip nt-chip--add', dataset: { view: '+' }, 'aria-label': 'New section', onClick: () => ctx.onCreate() },
    icon('plus', { size: 12 }),
    h('span', { class: 'nt-chip-name' }, 'Section'),
  );
  const strip = h(
    'div',
    { class: 'nt-strip' },
    chipsWrap,
    h('span', { class: 'nt-strip-hint label' }, hint(['[', ']'], 'Switch')),
    iconButton('nt-sliders', 'Manage sections', () => ctx.onManage(), 'nt-strip-manage'),
  );
  // The edge fades depend on the strip's width, which changes with the layout.
  const resizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateFades()) : null;
  resizeWatch?.observe(chips);

  // Only the open view's chip is a Tab stop; arrow keys reach the others.
  function chip(view, name, iconName, count) {
    const current = view === model.view;
    return h(
      'button',
      { type: 'button', class: 'nt-chip', dataset: { view }, tabindex: current ? '0' : '-1', 'aria-current': current ? 'true' : null, title: name, onClick: () => ctx.onView(view) },
      icon(iconName, { size: 12 }),
      h('span', { class: 'nt-chip-name' }, name),
      h('span', { class: 'nt-chip-count', 'aria-hidden': 'true' }, num(count)),
      h('span', { class: 'sr-only' }, `, ${plural(count, 'note')}`),
    );
  }

  /** A one-click starter ("TikTok ideas +") while there are no sections yet. */
  function starterChip(s) {
    return h(
      'button',
      { type: 'button', class: 'nt-chip nt-chip--suggest', dataset: { view: `+${s.name}` }, tabindex: '-1', 'aria-label': `Create section “${s.name}”`, title: `Create “${s.name}”`, onClick: () => ctx.onSuggest(s) },
      icon(sectionGlyph(s.icon), { size: 12 }),
      h('span', { class: 'nt-chip-name' }, s.name),
      icon('plus', { size: 12, className: 'nt-chip-plus' }),
    );
  }

  function renderStrip() {
    const { sections, view, counts } = model;
    const sig = JSON.stringify([view, counts.all, counts.unsorted, sections.map((s) => [s.id, s.name, s.icon, counts.bySection[s.id] ?? 0])]);
    if (sig === stripSig) return;
    stripSig = sig;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && chips.contains(active) ? active.dataset.view : null;
    chips.replaceChildren(
      chip(VIEW_ALL, 'All', 'nt-all', counts.all),
      chip(VIEW_UNSORTED, 'Unsorted', 'inbox', counts.unsorted),
      ...sections.map((s) => chip(s.id, s.name, glyphOf(s), counts.bySection[s.id] ?? 0)),
      ...(sections.length ? [] : availableSuggestions([]).map(starterChip)),
      addChip,
    );
    if (focused) chips.querySelector(`[data-view="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    updateFades();
  }

  function onChipKey(e) {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    arrowFocus(e, [...chips.children], { prev: 'ArrowLeft', next: 'ArrowRight' });
  }

  /** Fade the strip's edges only on the sides that have more chips to scroll to. */
  function updateFades() {
    const max = chips.scrollWidth - chips.clientWidth;
    const fade = [chips.scrollLeft > 2 && 'start', chips.scrollLeft < max - 2 && 'end'].filter(Boolean).join(' ');
    if (chipsWrap.dataset.fade !== fade) chipsWrap.dataset.fade = fade;
  }

  /* ---- Shared ---- */

  const railVisible = () => rail.offsetParent !== null;
  const rowFor = (view) => (view == null ? null : fixedRows.get(view) ?? rows.get(view) ?? null);
  const chipFor = (view) => chips.querySelector(`[data-view="${CSS.escape(view)}"]`);

  /** Bring the view's rail row and chip into sight (after '[' / ']' or a new section). */
  function revealView(view, { instant = false } = {}) {
    const chipEl = chipFor(view);
    if (chipEl && strip.offsetParent !== null) {
      scrollIntoBox(chips, chipEl, 'x', instant);
      updateFades();
    }
    const row = rowFor(view);
    if (row && railVisible()) scrollIntoBox(railBody, row.li, 'y', instant);
  }

  /** The rail's box while it shows (the note drag parks its ghost beside it), else null. */
  function railBox() {
    return railVisible() ? rail.getBoundingClientRect() : null;
  }

  /** The drop value ('unsorted' or a section id) of the rail row under the pointer. */
  function dropTargetAt(x, y) {
    if (!railVisible()) return null;
    const el = document.elementFromPoint(x, y);
    const li = el instanceof Element ? el.closest('.nt-srow[data-drop]') : null;
    return li && rail.contains(li) ? li.dataset.drop : null;
  }

  /**
   * A dragged note held near the rail's top or bottom edge scrolls the rail, so sections
   * below the fold are reachable. Scrolls one step; true when the rail moved.
   */
  function edgeScroll(x, y) {
    if (!railVisible()) return false;
    const r = railBody.getBoundingClientRect();
    if (x < r.left || x > r.right) return false;
    let step = 0;
    if (y < r.top + EDGE_BAND) step = -Math.min(1, (r.top + EDGE_BAND - y) / EDGE_BAND);
    else if (y > r.bottom - EDGE_BAND) step = Math.min(1, (y - r.bottom + EDGE_BAND) / EDGE_BAND);
    if (!step) return false;
    const before = railBody.scrollTop;
    railBody.scrollTop = before + (Math.round(step * EDGE_SPEED) || Math.sign(step));
    return railBody.scrollTop !== before;
  }

  function setDropTarget(view) {
    for (const row of [...fixedRows.values(), ...rows.values()]) row.li.classList.toggle('is-drop', row.li.dataset.drop === view && view != null);
  }

  function setDropzone(on) {
    rail.classList.toggle('is-dropzone', on);
  }

  /** Brief glow on the view's row and chip (a note just landed there). */
  function pulse(view) {
    const row = rowFor(view);
    if (row) replay(row.li, 'is-pulse');
    const chipEl = chipFor(view);
    if (chipEl) replay(chipEl, 'is-pulse');
  }

  /** Focus the view's rail row (wide) or chip (narrow). */
  function focusView(view) {
    const target = railVisible() ? rowFor(view)?.btn : chipFor(view);
    target?.focus({ preventScroll: true });
  }

  /** After a delete: focus the section now at `index`, else the last one, else the open view. */
  function focusSectionAt(index) {
    const { sections } = model;
    const next = sections[Math.max(0, Math.min(index, sections.length - 1))];
    focusView(next ? next.id : model.view);
  }

  /** True when keyboard focus is somewhere in the rail or the strip. */
  function hasFocus() {
    const active = document.activeElement;
    return active instanceof Node && (rail.contains(active) || strip.contains(active));
  }

  function destroy() {
    if (drag) releaseDrag();
    renaming = null;
    resizeWatch?.disconnect();
  }

  return {
    rail,
    strip,
    update,
    revealView,
    railVisible,
    railBox,
    dropTargetAt,
    edgeScroll,
    setDropTarget,
    setDropzone,
    pulse,
    focusView,
    focusSectionAt,
    hasFocus,
    destroy,
  };
}

/* ==========================================================================
   Note drag: drop a list row onto a rail row (wide workspace, mouse and pen)
   ========================================================================== */

/**
 * Eat the click that follows a drag, so dropping a note does not also open it. The timer that
 * disarms this can run late after input, so the next press disarms it too: a drop that got no
 * click must never eat the next one (the toast's Undo).
 */
function swallowClick() {
  const disarm = () => {
    window.removeEventListener('click', stop, true);
    window.removeEventListener('pointerdown', disarm, true);
  };
  const stop = (e) => {
    disarm();
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', stop, true);
  window.addEventListener('pointerdown', disarm, true);
  // The click (if any) is dispatched in the same task as the pointerup.
  setTimeout(disarm, 0);
}

/**
 * createNoteDrag({ nav, host, titleOf(id), homeOf(id), labelOf(view), onDrop(id, view) })
 * -> { onPointerDown(e), destroy() }
 *
 * Touch keeps scrolling the list (the move menu covers touch). homeOf(id) is the
 * note's own drop value ('unsorted' or its section id): dropping there is a no-op,
 * so that row is never lit. Escape cancels; the click after any drag is swallowed.
 * Over the rail the ghost parks beside it so it never hides the rows being aimed at,
 * and holding the pointer near the rail's top or bottom edge scrolls the rail.
 */
export function createNoteDrag({ nav, host, titleOf, homeOf, labelOf, onDrop }) {
  let drag = null;

  function onPointerDown(e) {
    const btn = e.target instanceof Element ? e.target.closest('.nt-item') : null;
    if (!btn?.dataset.id || drag || e.button !== 0 || e.pointerType === 'touch') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !nav.railVisible()) return;
    drag = { id: btn.dataset.id, btn, pointerId: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, active: false, cancelled: false, over: undefined, target: null, raf: 0 };
    listen(true);
  }

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('pointermove', onMove);
    window[method]('pointerup', onUp);
    window[method]('pointercancel', onCancel);
    window[method]('blur', onCancel);
    window[method]('keydown', onKey, true);
    document[method]('selectstart', onSelectStart);
  }

  function begin() {
    drag.active = true;
    drag.toEl = h('span', { class: 'nt-drag-to' });
    drag.ghost = h(
      'div',
      { class: 'nt-drag-ghost', 'aria-hidden': 'true' },
      h('span', { class: 'nt-drag-title' }, icon('note', { size: 14 }), h('span', { class: 'nt-drag-name' }, titleOf(drag.id))),
      drag.toEl,
    );
    document.body.append(drag.ghost);
    drag.ghostW = drag.ghost.offsetWidth;
    drag.ghostH = drag.ghost.offsetHeight;
    drag.btn.closest('li')?.classList.add('is-drag-source');
    host.classList.add('nt-is-dragging');
    nav.setDropzone(true);
    window.getSelection()?.removeAllRanges();
    try {
      drag.btn.setPointerCapture(drag.pointerId);
    } catch {
      // capture only keeps events flowing outside the window; the drag works without it
    }
  }

  function onMove(e) {
    if (!drag || drag.cancelled || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      begin();
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    placeGhost(e.clientX, e.clientY);
    aim(e.clientX, e.clientY);
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
  }

  /** Beside the rail while over it (rows stay readable), else up and to the right of the pointer. */
  function placeGhost(x, y) {
    const box = nav.railBox();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let left = x + 16;
    let top = y - drag.ghostH - 10;
    if (box && x >= box.left && x <= box.right) {
      left = box.right + 12;
      top = y - drag.ghostH / 2;
    }
    left = clamp(left, 4, Math.max(4, vw - drag.ghostW - 4));
    top = clamp(top, 4, Math.max(4, vh - drag.ghostH - 4));
    drag.ghost.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Light the row under the pointer (never the note's own section). */
  function aim(x, y) {
    const over = nav.dropTargetAt(x, y);
    if (over === drag.over) return;
    drag.over = over;
    drag.target = over && over !== homeOf(drag.id) ? over : null;
    nav.setDropTarget(drag.target);
    drag.ghost.classList.toggle('is-armed', !!drag.target);
    drag.toEl.textContent = drag.target ? `Move to ${clip(labelOf(drag.target), 32)}` : over ? 'Already here' : 'Drop on a section';
  }

  /** While the pointer rests near the rail's edge, keep scrolling; rows move under it, so re-aim. */
  function autoScroll() {
    if (!drag) return;
    drag.raf = 0;
    if (!drag.active || drag.cancelled || !nav.edgeScroll(drag.lastX, drag.lastY)) return;
    aim(drag.lastX, drag.lastY);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = end();
    if (!d.active) return;
    swallowClick();
    if (!d.cancelled && d.target) onDrop(d.id, d.target);
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !drag?.active || drag.cancelled) return;
    e.preventDefault();
    e.stopPropagation();
    // Keep tracking until the button is released so its click can be swallowed.
    drag.cancelled = true;
    clearVisuals(drag);
  }

  function onCancel(e) {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    end();
  }

  function onSelectStart(e) {
    if (drag?.active) e.preventDefault();
  }

  function clearVisuals(d) {
    d.ghost?.remove();
    d.ghost = null;
    d.btn.closest('li')?.classList.remove('is-drag-source');
    host.classList.remove('nt-is-dragging');
    nav.setDropzone(false);
    nav.setDropTarget(null);
  }

  function end() {
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    listen(false);
    clearVisuals(d);
    return d;
  }

  return {
    onPointerDown,
    destroy() {
      if (drag) end();
    },
  };
}

/* ==========================================================================
   Move menu: the editor's section picker (popover, or a small dialog on phones)
   ========================================================================== */

/**
 * openSectionMenu({ anchor, sections, current, onPick(sectionId | null), onCreate(), onClose() })
 * -> { close }
 */
export function openSectionMenu({ anchor, sections, current, onPick, onCreate, onClose }) {
  const sheet = window.matchMedia(SHEET_QUERY).matches;
  const entries = [{ id: null, name: 'Unsorted', icon: 'inbox' }, ...sections.map((s) => ({ id: s.id, name: s.name, icon: glyphOf(s) }))];
  let closed = false;
  let modal = null;

  const items = entries.map((entry) =>
    h(
      'button',
      {
        type: 'button',
        class: 'nt-menu-item',
        role: 'menuitemradio',
        'aria-checked': String(entry.id === current),
        tabindex: sheet ? null : '-1',
        title: entry.name,
        onClick: () => finish(() => onPick(entry.id)),
      },
      h('span', { class: 'nt-menu-icon' }, icon(entry.icon, { size: 14 })),
      h('span', { class: 'nt-menu-name' }, entry.name),
      h('span', { class: 'nt-menu-check' }, icon('check', { size: 14, stroke: 2 })),
    ),
  );
  const createItem = h(
    'button',
    { type: 'button', class: 'nt-menu-item nt-menu-new', role: 'menuitem', tabindex: sheet ? null : '-1', onClick: () => finish(onCreate) },
    h('span', { class: 'nt-menu-icon' }, icon('plus', { size: 14 })),
    h('span', { class: 'nt-menu-name' }, 'New section…'),
  );
  const focusables = [...items, createItem];
  const checked = items[Math.max(0, entries.findIndex((e) => e.id === current))];

  const menu = h(
    'div',
    { class: ['nt-menu', sheet ? 'nt-menu--sheet' : 'hud'], role: 'menu', 'aria-label': 'Move note to section', onKeydown: onKey },
    sheet ? null : h('div', { class: 'nt-menu-head label', 'aria-hidden': 'true' }, 'Move to'),
    h('div', { class: 'nt-menu-list' }, items),
    h('div', { class: 'nt-menu-sep', role: 'separator' }),
    createItem,
  );

  function onKey(e) {
    if (arrowFocus(e, focusables, { wrap: true })) return;
    if (sheet) return; // the dialog handles Escape and Tab
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close({ restore: true });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close({ restore: true });
    }
  }

  function finish(fn) {
    close({ restore: true });
    fn?.();
  }

  function close({ restore = false } = {}) {
    if (closed) return;
    closed = true;
    if (modal) {
      modal.close();
    } else {
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
      const hadFocus = menu.contains(document.activeElement);
      menu.remove();
      if (restore || hadFocus) anchor.focus({ preventScroll: true });
    }
    onClose?.();
  }

  if (sheet) {
    modal = openModal({
      title: 'Move to section',
      body: menu,
      className: 'nt-modal nt-menu-modal',
      initialFocus: checked,
      onClose: () => {
        if (closed) return;
        closed = true;
        onClose?.();
      },
    });
    return { close };
  }

  // The anchor's own click toggles the menu, so a press on it is not "outside".
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onDismiss = (e) => {
    if (e?.type === 'scroll' && menu.contains(e.target)) return;
    close();
  };

  document.body.append(menu);
  place();
  checked.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('scroll', onDismiss, true);

  function place() {
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const gap = 6;
    const below = vh - r.bottom - gap - 8;
    const above = r.top - gap - 8;
    const openUp = menu.offsetHeight > below && above > below;
    menu.style.maxHeight = `${Math.max(160, openUp ? above : below)}px`;
    const left = clamp(r.left, 8, Math.max(8, vw - menu.offsetWidth - 8));
    menu.style.left = `${left}px`;
    menu.style.top = openUp ? `${Math.max(8, r.top - gap - menu.offsetHeight)}px` : `${r.bottom + gap}px`;
  }

  return { close };
}

/* ==========================================================================
   Section editor dialog (new / edit): name + icon
   ========================================================================== */

function iconPicker({ value, labelledBy, onChange }) {
  let current = value;
  const buttons = SECTION_ICONS.map((name) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        class: 'nt-icon-opt',
        dataset: { icon: name },
        'aria-checked': String(name === current),
        'aria-label': SECTION_ICON_LABELS[name],
        title: SECTION_ICON_LABELS[name],
        tabindex: name === current ? '0' : '-1',
        onClick: () => select(name),
      },
      icon(sectionGlyph(name), { size: 18 }),
    ),
  );

  function select(name, { focus = false } = {}) {
    current = name;
    buttons.forEach((b) => {
      const on = b.dataset.icon === name;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    onChange(name);
  }

  // Radio group: arrow keys move the selection (from the focused option), Home / End jump to the ends.
  function onKeydown(e) {
    const focused = buttons.indexOf(document.activeElement);
    const i = focused !== -1 ? focused : SECTION_ICONS.indexOf(current);
    const last = SECTION_ICONS.length - 1;
    let to = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = i === 0 ? last : i - 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = last;
    if (to === null) return;
    e.preventDefault();
    select(SECTION_ICONS[to], { focus: true });
  }

  const el = h('div', { class: 'nt-icon-grid', role: 'radiogroup', 'aria-labelledby': labelledBy, onKeydown }, buttons);
  return { el, select };
}

/**
 * openSectionEditor({ section, getSections, onSubmit({ name, icon }) -> { error? }, onClose(stranded) })
 * section null = create. The dialog stays open while onSubmit returns an error.
 * onClose runs after the dialog has put focus back; `stranded` is true when that failed
 * (the control that opened it was rebuilt or hidden meanwhile) so the caller can place it.
 */
export function openSectionEditor({ section = null, getSections, onSubmit, onClose = null }) {
  const editing = !!section;
  let iconName = editing ? sectionIcon(section) : 'folder';
  const nameId = nextId('nt-sx-name');
  const msgId = nextId('nt-sx-msg');
  const iconLabelId = nextId('nt-sx-icon');

  const counter = h('span', { class: 'label nt-sx-counter', 'aria-hidden': 'true' });
  const msg = h('p', { class: 'nt-sx-msg', id: msgId, 'aria-live': 'polite' });
  // No maxlength: it counts UTF-16 units (an emoji is two) while names count symbols.
  const input = h('input', {
    class: 'input nt-sx-input',
    id: nameId,
    type: 'text',
    value: section?.name ?? '',
    placeholder: 'e.g. TikTok ideas',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    'aria-describedby': msgId,
    onInput: () => check(false),
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    },
  });
  const picker = iconPicker({ value: iconName, labelledBy: iconLabelId, onChange: (name) => (iconName = name) });

  const suggestions = editing ? [] : availableSuggestions(getSections());
  const useSuggestion = (s) => {
    input.value = s.name;
    picker.select(s.icon);
    check(false);
    input.focus();
  };

  const submitBtn = h('button', { type: 'button', class: 'btn btn--primary', onClick: () => submit() }, icon(editing ? 'check' : 'plus'), editing ? 'Save' : 'Create section');

  const body = [
    h(
      'div',
      { class: 'field' },
      h('div', { class: 'nt-sx-top' }, h('label', { class: 'label', for: nameId }, 'Name'), counter),
      input,
      msg,
    ),
    h('div', { class: 'field' }, h('span', { class: 'label', id: iconLabelId }, 'Icon'), picker.el),
    suggestions.length
      ? h('div', { class: 'field' }, h('span', { class: 'label' }, 'Suggestions'), suggestionChips(suggestions, useSuggestion, { verb: 'Use' }))
      : null,
  ];

  function check(strict) {
    const v = validateSectionName(input.value, getSections(), section?.id ?? null);
    const length = nameLength(input.value);
    const over = length > SECTION_NAME_MAX;
    counter.textContent = `${length}/${SECTION_NAME_MAX}`;
    counter.classList.toggle('is-over', over);
    const show = !v.ok && (strict || v.code !== 'empty');
    // Too long is a heads-up, not an error: the name is saved cut to the limit.
    msg.textContent = show ? v.error : over ? TOO_LONG : '';
    input.setAttribute('aria-invalid', String(show));
    return v;
  }

  function fail(text) {
    msg.textContent = text;
    input.setAttribute('aria-invalid', 'true');
    replay(input, 'is-shake');
    input.focus();
  }

  function submit() {
    const v = check(true);
    if (!v.ok) {
      fail(v.error);
      return;
    }
    const result = onSubmit({ name: v.name, icon: iconName });
    if (result?.error) {
      fail(result.error);
      return;
    }
    m.close();
  }

  const m = openModal({
    title: editing ? 'Edit section' : 'New section',
    body,
    footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), submitBtn],
    className: 'nt-modal nt-sx-modal',
    initialFocus: input,
    onClose: () => {
      const active = document.activeElement;
      onClose?.(!active || active === document.body || !active.isConnected || m.el.contains(active));
    },
  });
  check(false);
  // Select an existing name so typing replaces it.
  requestAnimationFrame(() => {
    if (editing && document.activeElement === input) input.select();
  });
  return m;
}

/* ==========================================================================
   Delete section dialog: move the notes to Unsorted (default) or delete them
   ========================================================================== */

/** openDeleteSection({ section, count, onConfirm(mode: 'move' | 'delete') }) */
export function openDeleteSection({ section, count, onConfirm }) {
  let mode = 'move';
  let result = null;
  const name = clip(section.name, 40);
  const groupName = nextId('nt-dx');
  const notes = plural(count, 'note');

  const confirmBtn = h('button', { type: 'button', class: 'btn btn--danger', onClick: () => confirm() }, icon('trash'), 'Delete section');

  function choice(value, title, sub, danger = false) {
    const input = h('input', {
      type: 'radio',
      class: 'nt-choice-input',
      name: groupName,
      value,
      checked: value === mode,
      onChange: () => {
        mode = value;
        confirmBtn.lastChild.textContent = mode === 'delete' ? `Delete section and ${notes}` : 'Delete section';
      },
    });
    return h(
      'label',
      { class: ['nt-choice', danger && 'nt-choice--danger'] },
      input,
      h('span', { class: 'nt-choice-text' }, h('span', { class: 'nt-choice-title' }, title), h('span', { class: 'nt-choice-sub' }, sub)),
    );
  }

  const body = count
    ? [
        h('p', { class: 'muted' }, '“', h('bdi', null, name), `” holds ${notes}. What should happen to ${count === 1 ? 'it' : 'them'}?`),
        h(
          'fieldset',
          { class: 'nt-dx-choices' },
          h('legend', { class: 'sr-only' }, 'What happens to its notes'),
          choice('move', `Move its ${notes} to Unsorted`, 'The notes stay. Only the section goes.'),
          choice('delete', `Delete the section and its ${notes}`, 'Removed from this device. You can undo right after.', true),
        ),
      ]
    : h('p', { class: 'muted' }, '“', h('bdi', null, name), '” is empty, so no notes are affected. You can undo right after.');

  function confirm() {
    result = mode;
    m.close();
  }

  const m = openModal({
    title: 'Delete section?',
    body,
    footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), confirmBtn],
    className: 'nt-modal nt-dx-modal',
    initialFocus: confirmBtn,
    onClose: () => {
      if (result) onConfirm(result);
    },
  });
  return m;
}

/* ==========================================================================
   Manage sections dialog: rename / icon (via the editor), reorder, delete
   ========================================================================== */

/**
 * openManageSections({ getState, subscribe, counts(state), onCreate(), onSuggest(s),
 *                      onEdit(id), onDelete(id), onMoveBy(id, delta) })
 */
export function openManageSections({ getState, subscribe, counts, onCreate, onSuggest, onEdit, onDelete, onMoveBy }) {
  const rows = new Map(); // section id -> row
  const list = h('ol', { class: 'nt-mg-list', role: 'list', 'aria-label': 'Sections' });
  const empty = h('div', { class: 'nt-mg-empty' });
  const newBtn = h('button', { type: 'button', class: 'btn', onClick: () => onCreate() }, icon('plus'), 'New section');
  const doneBtn = h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Done');
  let emptySig = null;

  function actionBtn(act, iconName, onClick) {
    return h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', dataset: { act }, onClick }, icon(iconName, { size: 14 }));
  }

  function createRow(id) {
    const row = { id, sig: '' };
    row.iconEl = h('span', { class: 'nt-mg-icon', 'aria-hidden': 'true' });
    row.nameEl = h('span', { class: 'nt-mg-name' });
    row.subEl = h('span', { class: 'label nt-mg-sub' });
    row.up = actionBtn('up', 'arrow-up', () => onMoveBy(id, -1));
    row.down = actionBtn('down', 'arrow-down', () => onMoveBy(id, 1));
    row.edit = actionBtn('edit', 'edit', () => onEdit(id));
    row.delete = actionBtn('delete', 'trash', () => onDelete(id));
    row.li = h(
      'li',
      { class: 'nt-mg-row', dataset: { id } },
      row.iconEl,
      h('span', { class: 'nt-mg-text' }, row.nameEl, row.subEl),
      h('span', { class: 'nt-mg-actions' }, row.up, row.down, row.edit, row.delete),
    );
    return row;
  }

  function paintRow(row, section, count, first, last) {
    const sig = [section.name, section.icon, count, first, last].join('\u0001');
    if (row.sig === sig) return;
    row.sig = sig;
    const name = section.name;
    row.iconEl.replaceChildren(icon(glyphOf(section)));
    row.nameEl.textContent = name;
    row.nameEl.title = name;
    row.subEl.textContent = plural(count, 'note');
    const label = (btn, text, tip) => {
      btn.setAttribute('aria-label', text);
      btn.title = tip;
    };
    label(row.up, `Move ${name} up`, 'Move up');
    label(row.down, `Move ${name} down`, 'Move down');
    label(row.edit, `Edit ${name}`, 'Rename or change icon');
    label(row.delete, `Delete ${name}`, 'Delete section');
    row.up.disabled = first;
    row.down.disabled = last;
  }

  function render() {
    if (!list.isConnected && rows.size) return;
    const s = getState();
    const c = counts(s);
    const active = document.activeElement;
    const focusLi = active instanceof HTMLElement && list.contains(active) ? active.closest('li') : null;
    const memo = focusLi ? { id: focusLi.dataset.id, act: active.dataset.act, at: [...list.children].indexOf(focusLi) } : null;
    const fromEmpty = active instanceof HTMLElement && empty.contains(active);

    const live = new Set(s.sections.map((x) => x.id));
    for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);
    const nodes = s.sections.map((section, i) => {
      let row = rows.get(section.id);
      if (!row) {
        row = createRow(section.id);
        rows.set(section.id, row);
      }
      paintRow(row, section, c.bySection[section.id] ?? 0, i === 0, i === s.sections.length - 1);
      return row.li;
    });
    const kids = list.children;
    if (kids.length !== nodes.length || nodes.some((n, i) => kids[i] !== n)) list.replaceChildren(...nodes);
    list.hidden = !nodes.length;
    renderEmpty(s.sections);
    if (memo) restoreFocus(memo);
    // A suggestion chip just turned into the first section: follow it into the list.
    else if (fromEmpty && empty.hidden) (rows.get(s.sections[0]?.id)?.edit ?? newBtn).focus({ preventScroll: true });
  }

  /** Keep focus on the same control after a reorder, or on a neighbour after a delete. */
  function restoreFocus({ id, act, at }) {
    const row = rows.get(id);
    let target;
    if (row) {
      target = row[act] ?? row.edit;
      if (target.disabled) target = act === 'up' ? row.down : row.up;
      if (target.disabled) target = row.edit;
    } else {
      const li = list.children[Math.min(at, list.children.length - 1)];
      target = li ? rows.get(li.dataset.id)?.edit : newBtn;
    }
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  }

  function renderEmpty(sections) {
    empty.hidden = sections.length > 0;
    if (sections.length) return;
    const list2 = availableSuggestions(sections);
    const sig = list2.map((x) => x.name).join('\u0001');
    if (sig === emptySig) return;
    emptySig = sig;
    empty.replaceChildren(
      h('p', { class: 'muted' }, 'No sections yet. A section is a folder for one stream of ideas.'),
      suggestionChips(list2, (x) => onSuggest(x), { verb: 'Create section' }),
    );
  }

  const unsubscribe = subscribe(render);
  const m = openModal({
    title: 'Manage sections',
    body: [h('p', { class: 'nt-mg-intro' }, 'Rename, reorder or delete. Deleting a section can keep its notes in Unsorted.'), list, empty],
    footer: [newBtn, h('span', { class: 'spacer' }), doneBtn],
    className: 'nt-modal nt-mg-modal',
    initialFocus: doneBtn,
    onClose: () => unsubscribe(),
  });
  render();
  return m;
}
