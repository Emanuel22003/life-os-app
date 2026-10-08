// LIFE/OS — color coding, the page part: tagging elements, the swatch picker and its pop-up.
// The data rules live in colors.logic.js; the look in css/colors.css.
//
// An element that can show a color is tagged with paintColor(el, kind, own, section):
//   data-cc-kind="tasks"   what it is (sections · tasks · notes · events · days)
//   data-cc="red"          its own color
//   data-cc-sec="blue"     the color of the section it is in (shown when it has none of its own)
// css/colors.css turns that into --cc only while <html> has the matching cc-<kind> class
// (applyColorPrefs, from settings.colors), so the switches work without re-rendering a page.

import { h, icon } from './ui.js';
import { COLORS, colorKey, colorName, colorClasses, normalizeColorPrefs } from './colors.logic.js';

export { COLORS, colorKey, colorName };

/** Put the switches on <html> (the shell calls this whenever settings change). */
export function applyColorPrefs(prefs) {
  const root = document.documentElement;
  const wanted = new Set(colorClasses(prefs));
  for (const c of [...root.classList]) if (c.startsWith('cc-') && !wanted.has(c)) root.classList.remove(c);
  for (const c of wanted) root.classList.add(c);
}

/** True while color coding is on (pickers only show then). */
export function colorsOn() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('cc-on');
}

export { normalizeColorPrefs };

/** Tag `el` (see the top of this file). Returns `el`. */
export function paintColor(el, kind, own = null, section = null) {
  if (!el) return el;
  el.dataset.ccKind = kind;
  const o = colorKey(own);
  const s = colorKey(section);
  if (o) el.dataset.cc = o;
  else delete el.dataset.cc;
  if (s) el.dataset.ccSec = s;
  else delete el.dataset.ccSec;
  return el;
}

/** A small round dot in the element's color (hidden by CSS while it shows none). */
export function colorDot() {
  return h('span', { class: 'cc-dot', 'aria-hidden': 'true' });
}

/**
 * A row of swatches: No color + the palette. onChange(id | null).
 * Returns { el, get, set }. Arrow keys move between swatches (one Tab stop).
 */
export function colorPicker({ value = null, onChange, label = 'Color', compact = false } = {}) {
  let current = colorKey(value);
  const options = [{ id: null, name: 'No color' }, ...COLORS];
  const buttons = options.map((c) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        class: ['cc-swatch', !c.id && 'cc-swatch--none'],
        dataset: { swatch: c.id ?? 'none' },
        title: c.name,
        'aria-label': c.name,
        onClick: () => pick(c.id, true),
      },
      c.id ? null : icon('x', { size: 11, stroke: 2 }),
    ),
  );
  const el = h('div', { class: ['cc-picker', compact && 'cc-picker--compact'], role: 'radiogroup', 'aria-label': label }, buttons);
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (e.key === 'Home' || e.key === 'End' || step) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + step + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });

  function paint() {
    buttons.forEach((b, i) => {
      const on = (options[i].id ?? null) === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  function pick(id, user = false) {
    current = colorKey(id);
    paint();
    if (user) onChange?.(current);
  }
  paint();
  return { el, get: () => current, set: (id) => pick(id), buttons };
}

/* ==========================================================================
   The pop-up picker: openColorMenu({ anchor, value, onPick, title })
   ========================================================================== */

let open = null;

export function closeColorMenu({ restore = false } = {}) {
  const m = open;
  if (!m) return;
  open = null;
  m.cleanup();
  m.el.remove();
  if (restore && m.anchor?.isConnected) m.anchor.focus({ preventScroll: true });
}

/** A small floating swatch row under `anchor`. Picking closes it; Esc or a click outside cancels. */
export function openColorMenu({ anchor, value = null, onPick, title = 'Color' } = {}) {
  closeColorMenu();
  const picker = colorPicker({
    value,
    label: title,
    onChange: (id) => {
      closeColorMenu({ restore: true });
      onPick?.(id);
    },
  });
  const el = h('div', { class: 'ctx-menu hud cc-pop', role: 'dialog', 'aria-label': title }, h('div', { class: 'cc-pop-title label' }, title), picker.el);
  el.style.visibility = 'hidden';
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, vw - w - 8));
  const top = r.bottom + 6 + ht > vh - 8 ? Math.max(8, r.top - 6 - ht) : r.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.visibility = '';

  // Window capture: ahead of an open dialog's own Esc handler, so Esc closes only this
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeColorMenu({ restore: true });
    } else if (e.key === 'Tab') {
      closeColorMenu();
    }
  };
  const onDown = (e) => {
    if (!el.contains(e.target)) closeColorMenu();
  };
  const onScroll = (e) => {
    if (!el.contains(e.target)) closeColorMenu();
  };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onDown);
  window.addEventListener('hashchange', onDown);
  open = {
    el,
    anchor,
    cleanup() {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onDown);
      window.removeEventListener('hashchange', onDown);
    },
  };
  (picker.buttons.find((b) => b.tabIndex === 0) ?? picker.buttons[0]).focus({ preventScroll: true });
  return el;
}

/** A small button showing a color that opens the pop-up (Sections dialog rows, note editor). */
export function colorButton({ value = null, title = 'Color', onPick, className = '' } = {}) {
  let current = colorKey(value);
  const btn = h('button', {
    type: 'button',
    class: ['btn btn--ghost btn--icon btn--sm cc-btn', className],
    onClick: () => openColorMenu({ anchor: btn, value: current, title, onPick: (id) => onPick?.(id) }),
  });
  const set = (id) => {
    current = colorKey(id);
    paintColor(btn, 'any', current);
    btn.replaceChildren(h('span', { class: ['cc-btn-dot', !current && 'is-none'], 'aria-hidden': 'true' }));
    btn.title = `${title}: ${colorName(current)}`;
    btn.setAttribute('aria-label', `${title}: ${colorName(current)}`);
  };
  set(current);
  return { el: btn, set };
}
