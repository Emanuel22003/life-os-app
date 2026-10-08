// LIFE/OS — your own colors for a template, the pure part (tools/tests/palette.test.js).
//
// Every template names its two or three main colors (PALETTE_SLOTS): its background, its text
// and, in most, an accent (Old Money's brass, Brutalist's highlight, Coquette's ribbon …).
// You can change them per template and per mode, and Reset brings the template's own back:
//   settings.palettes = { 'oldmoney:light': { bg: '#f2eee5', accent: '#9a7a3d' }, … }
// Only the colors you changed are kept (per device, like the rest of settings). The page gets
// them as --u-bg / --u-text / --u-accent on <html>, with data-palette="bg accent" naming which
// are set; css/palette.css works out the template's other colors from them.

export const PALETTE_KEYS = Object.freeze(['bg', 'text', 'accent']);

const slot = (key, label, cssVar) => Object.freeze({ key, label, cssVar });

/** Per template: the colors you can change, in order. cssVar: where its own value is read. */
export const PALETTE_SLOTS = Object.freeze({
  simple: Object.freeze([slot('bg', 'Background', '--bg'), slot('text', 'Text', '--text'), slot('accent', 'Accent', '--accent')]),
  hud: Object.freeze([slot('bg', 'Background', '--bg'), slot('text', 'Signal', '--text')]),
  brutalist: Object.freeze([slot('bg', 'Paper', '--bg'), slot('text', 'Ink', '--text'), slot('accent', 'Highlight', '--bru-hi')]),
  terminal: Object.freeze([slot('bg', 'Screen', '--bg'), slot('text', 'Phosphor', '--text')]),
  oldmoney: Object.freeze([slot('bg', 'Paper', '--bg'), slot('text', 'Ink', '--text'), slot('accent', 'Brass', '--om-brass')]),
  coquette: Object.freeze([slot('bg', 'Background', '--bg'), slot('text', 'Ink', '--text'), slot('accent', 'Ribbon', '--accent')]),
  y2k: Object.freeze([slot('bg', 'Background', '--bg'), slot('text', 'Text', '--text'), slot('accent', 'Glitter', '--accent')]),
});

export function slotsFor(skin) {
  return PALETTE_SLOTS[skin] ?? PALETTE_SLOTS.simple;
}

/** '#ABC' / '#aabbcc' -> '#aabbcc'; anything else -> null. */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
}

export const paletteKey = (skin, theme) => `${skin}:${theme === 'light' ? 'light' : 'dark'}`;

/** settings.palettes, repaired: only valid entries, valid keys and colors. */
export function normalizePalettes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (!/^[a-z0-9-]+:(light|dark)$/.test(key) || !entry || typeof entry !== 'object') continue;
    const clean = {};
    for (const k of PALETTE_KEYS) {
      const hex = normalizeHex(entry[k]);
      if (hex) clean[k] = hex;
    }
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

/** The colors you set for this template and mode (only its own slots): { bg?, text?, accent? }. */
export function paletteFor(palettes, skin, theme) {
  const entry = normalizePalettes(palettes)[paletteKey(skin, theme)] ?? {};
  const allowed = new Set(slotsFor(skin).map((s) => s.key));
  return Object.fromEntries(Object.entries(entry).filter(([k]) => allowed.has(k)));
}

/** palettes with one color set (a hex) or cleared (null). */
export function withPaletteColor(palettes, skin, theme, key, hex) {
  const all = normalizePalettes(palettes);
  const id = paletteKey(skin, theme);
  const entry = { ...(all[id] ?? {}) };
  const clean = normalizeHex(hex);
  if (clean && PALETTE_KEYS.includes(key)) entry[key] = clean;
  else delete entry[key];
  if (Object.keys(entry).length) all[id] = entry;
  else delete all[id];
  return all;
}

/** palettes without this template's colors in this mode (Reset). */
export function resetPalette(palettes, skin, theme) {
  const all = normalizePalettes(palettes);
  delete all[paletteKey(skin, theme)];
  return all;
}

/** WCAG relative luminance of a '#rrggbb' color (0 black … 1 white). */
export function luminance(hex) {
  const h = normalizeHex(hex) ?? '#000000';
  const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Readable text on a color: near-black or white, whichever stands out more. */
export function inkFor(hex) {
  return contrast(hex, '#111111') >= contrast(hex, '#ffffff') ? '#111111' : '#ffffff';
}

/**
 * What <html> needs for a set of colors: data-palette (the keys, '' when none) and the
 * custom properties (--u-bg, --u-text, --u-accent, --u-accent-ink).
 */
export function paletteStyle(entry) {
  const keys = PALETTE_KEYS.filter((k) => normalizeHex(entry?.[k]));
  const vars = {};
  for (const k of keys) vars[`--u-${k}`] = normalizeHex(entry[k]);
  if (vars['--u-accent']) vars['--u-accent-ink'] = inkFor(vars['--u-accent']);
  return { attr: keys.join(' '), vars };
}
