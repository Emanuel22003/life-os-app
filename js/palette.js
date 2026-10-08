// LIFE/OS — your own colors, the page part: putting them on <html> (or a preview), and the
// editor (a color swatch per main color, and Reset) in the Appearance dialog and in Settings.
// The rules are in palette.logic.js; css/palette.css derives the rest of the template's colors.

import { h } from './ui.js';
import { settings } from './store.js';
import { normalizeSkin, skinInfo } from './skins.js';
import { slotsFor, paletteFor, paletteStyle, withPaletteColor, resetPalette, normalizeHex } from './palette.logic.js';

const VARS = ['--u-bg', '--u-text', '--u-accent', '--u-accent-ink'];

/** Put your colors for `skin` in `theme` on `el` (the page by default, or a picker preview). */
export function applyPalette(s, el = document.documentElement, skin = el.dataset.skin, theme = el.dataset.theme) {
  const { attr, vars } = paletteStyle(paletteFor(s?.palettes, normalizeSkin(skin), theme));
  for (const v of VARS) {
    if (vars[v]) el.style.setProperty(v, vars[v]);
    else el.style.removeProperty(v);
  }
  if (attr) el.dataset.palette = attr;
  else delete el.dataset.palette;
}

/* ---- Reading what a template shows now, as '#rrggbb' (the native color picker needs it) ---- */

let ctx = null;
function toHex(color) {
  if (!color) return null;
  ctx ??= document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#010203';
  ctx.fillStyle = color;
  const out = ctx.fillStyle;
  if (out === '#010203' && color.trim().toLowerCase() !== '#010203') return null;
  if (out.startsWith('#')) return out;
  const m = out.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  return m ? `#${[m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('')}` : null;
}

function shownHex(cssVar) {
  return toHex(getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()) ?? '#888888';
}

/**
 * The editor: one swatch per main color of the template showing, in the mode showing, and Reset.
 * Picking a color applies it at once (and saves it); Reset brings the template's own back.
 * Returns { el, destroy }.
 */
export function paletteEditor() {
  const el = h('div', { class: 'pal-editor', role: 'group', 'aria-label': 'Colors' });
  let sig = '';
  let inputs = new Map();
  let reset = null;
  let note = null;
  let frame = 0;
  let queued = null;

  const where = () => {
    const s = settings.get();
    return { s, skin: normalizeSkin(s.skin), theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' };
  };

  // While a picker is dragged, save at most once a frame
  function save(skin, theme, key, hex) {
    queued = { skin, theme, key, hex };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const q = queued;
      queued = null;
      if (q) settings.update({ palettes: withPaletteColor(settings.get().palettes, q.skin, q.theme, q.key, q.hex) });
    });
  }

  function build() {
    const { s, skin, theme } = where();
    const custom = paletteFor(s.palettes, skin, theme);
    sig = `${skin}:${theme}`;
    inputs = new Map();
    const slots = slotsFor(skin).map((slot) => {
      const input = h('input', { type: 'color', class: 'pal-swatch', value: custom[slot.key] ?? shownHex(slot.cssVar), 'aria-label': `${slot.label} color` });
      input.addEventListener('input', () => save(skin, theme, slot.key, input.value));
      const label = h('label', { class: ['pal-slot', custom[slot.key] && 'is-custom'], title: `Change the ${slot.label.toLowerCase()} color` }, input, h('span', { class: 'pal-slot-name' }, slot.label));
      inputs.set(slot.key, { input, label, slot });
      return label;
    });
    reset = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--sm pal-reset',
        title: 'Back to the template’s own colors',
        onClick: () => {
          const w = where();
          settings.update({ palettes: resetPalette(w.s.palettes, w.skin, w.theme) });
        },
      },
      'Reset',
    );
    note = h('p', { class: 'pal-note' });
    el.replaceChildren(...slots, reset, note);
    paint();
  }

  // Same template and mode: update in place (rebuilding would close an open color picker)
  function paint() {
    const { s, skin, theme } = where();
    const custom = paletteFor(s.palettes, skin, theme);
    for (const [key, { input, label, slot }] of inputs) {
      label.classList.toggle('is-custom', !!custom[key]);
      const value = custom[key] ?? shownHex(slot.cssVar);
      if (document.activeElement !== input && normalizeHex(input.value) !== value) input.value = value;
    }
    const changed = Object.keys(custom).length;
    reset.disabled = !changed;
    note.textContent = `${skinInfo(skin).name}, ${theme} mode: ${changed ? 'your colors' : 'the template’s own colors'}. Each template and mode keeps its own.`;
  }

  function refresh() {
    const { skin, theme } = where();
    if (`${skin}:${theme}` !== sig) build();
    else paint();
  }

  build();
  // After the page has applied the change (the shell listens to settings too)
  const off = settings.subscribe(() => requestAnimationFrame(refresh));
  return {
    el,
    destroy() {
      off();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
