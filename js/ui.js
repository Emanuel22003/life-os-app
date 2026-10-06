// LIFE/OS — UI kit: DOM builder, icons, shared widgets, dates, helpers, skin-aware text.
// Features import from here instead of re-implementing. Keep it dependency-free (skins.js is pure).

import { DEFAULT_SKIN, normalizeSkin, formatIndex, formatCount, termFor } from './skins.js';

/* ==========================================================================
   DOM builder
   ========================================================================== */

// Keys assigned as DOM properties rather than attributes
const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'readOnly', 'required', 'indeterminate', 'textContent']);

/**
 * h('button', { class: 'btn', onClick: fn, 'aria-label': 'Add' }, icon('plus'), 'Add')
 *
 * props: class (string | array), style (object | string), dataset (object),
 *        ref (el => void), on<Event> (listener), aria-* (false is kept as "false"),
 *        anything else -> attribute. null/undefined/false skip the prop.
 * children: nodes, strings, numbers, arrays (flattened); null/false/true are skipped.
 * Strings are always inserted as text, never parsed as HTML.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (v === false && !k.startsWith('aria-')) continue;
      if (k === 'class' || k === 'className') {
        el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k === 'ref' && typeof v === 'function') {
        v(el);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (PROPS.has(k)) {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/* ==========================================================================
   Icons — 24px grid, 1.5 stroke, currentColor. Trusted static markup only.
   ========================================================================== */

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4Z"/>',
  flame: '<path d="M12 22c3.9 0 7-2.9 7-6.8 0-3.6-2.6-6-4.2-9.2-1.4 1.5-2.3 3.4-2.3 5.3-1-.7-2-2-2.3-3.8C8.3 9.4 5 12.2 5 15.2 5 19.1 8.1 22 12 22Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  sort: '<path d="M3 6h18M6 12h12M10 18h4"/>',
  filter: '<path d="M3 4h18l-7 9v6l-4 2v-8Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9Z"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
  activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3Z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
};

/** Add an icon at runtime (from a feature file). `inner` is trusted SVG child markup on a 24px grid. */
export function registerIcon(name, inner) {
  ICONS[name] = inner;
}

export function icon(name, { size = 16, stroke = 1.5, className = '' } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="icon ${className}">${ICONS[name] ?? ICONS.circle}</svg>`;
  return tpl.content.firstElementChild;
}

export function brandMark(size = 26) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" class="brand-mark"><path d="M2 9V2h7M23 2h7v7M30 23v7h-7M9 30H2v-7"/><path d="M10 22 22 10"/><circle cx="16" cy="16" r="2.5" fill="currentColor" stroke="none"/></svg>`;
  return tpl.content.firstElementChild;
}

/* ==========================================================================
   Shared widgets
   ========================================================================== */

/** Standard page header used by every feature. Returns the <header>. */
export function pageHeader({ index, title, subtitle, actions = [] }) {
  return h(
    'header',
    { class: 'page-header' },
    h(
      'div',
      { class: 'page-heading' },
      // The kicker ("01 // TASKS") is decoration: the Simple template hides it (.lo-deco)
      h('div', { class: 'page-kicker label lo-deco' }, index ? h('span', null, index) : null, index ? h('span', { class: 'crumb-sep' }, '//') : null, h('span', null, title)),
      h('h1', { class: 'page-title' }, title),
      subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null,
    ),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

/** Dashed, hatched empty state. */
export function emptyState({ icon: iconName = 'inbox', title, text, action } = {}) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 20 })),
    title ? h('div', { class: 'empty-title' }, title) : null,
    text ? h('div', { class: 'empty-text' }, text) : null,
    action ?? null,
  );
}

/** Square checkbox button. Toggle state with setChecked(el, bool). */
export function checkButton({ checked = false, label, onToggle, size } = {}) {
  const btn = h(
    'button',
    {
      type: 'button',
      class: ['check', size === 'lg' && 'check--lg'],
      role: 'checkbox',
      'aria-checked': String(!!checked),
      'aria-label': label,
      onClick: (e) => {
        e.stopPropagation();
        onToggle?.(btn.getAttribute('aria-checked') !== 'true', e);
      },
    },
    icon('check', { size: size === 'lg' ? 16 : 13, stroke: 2.5 }),
  );
  return btn;
}

export function setChecked(el, checked) {
  el.setAttribute('aria-checked', String(!!checked));
}

/** Progress ring. value 0..1. Update later with ring.setValue(v). */
export function ring({ value = 0, size = 64, stroke = 4, label } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/><circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${c}"/></svg>`;
  const svg = tpl.content.firstElementChild;
  const fill = svg.querySelector('.ring-fill');
  const labelEl = h('div', { class: 'ring-label' }, label ?? null);
  const el = h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } }, svg, labelEl);
  const apply = (v) => {
    const clamped = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    fill.style.strokeDashoffset = String(c * (1 - clamped));
    // hide the round cap dot at 0
    fill.style.opacity = clamped === 0 ? '0' : '1';
  };
  let touched = false;
  el.setValue = (v) => {
    touched = true;
    apply(v);
  };
  el.setLabel = (node) => labelEl.replaceChildren(node ?? '');
  // Animate in from 0 on the next frame, unless the caller already set a newer value
  requestAnimationFrame(() => {
    if (!touched) apply(value);
  });
  return el;
}

/* ---- Toasts ---- */

let toastStack;

/** Create the (empty) toast live region. The shell calls this at boot so screen readers
 *  register it before the first message; toast() also calls it lazily. */
export function ensureToastRegion() {
  if (!toastStack || !toastStack.isConnected) {
    toastStack = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  return toastStack;
}

/** toast('Task deleted', { action: { label: 'Undo', onClick }, duration }) -> { dismiss, el }. Default 3.8s, 6s with an action. */
export function toast(message, { action, duration = action ? 6000 : 3800 } = {}) {
  // Toasts with an action (Undo) stay longer so there is time to reach the button
  ensureToastRegion();
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 240);
  };
  const el = h(
    'div',
    { class: 'toast' },
    h('span', { class: 'toast-msg' }, message),
    action
      ? h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onClick: () => {
              action.onClick?.();
              dismiss();
            },
          },
          action.label,
        )
      : null,
  );
  toastStack.append(el);
  // keep at most 4 visible
  while (toastStack.children.length > 4) toastStack.firstElementChild.remove();
  timer = setTimeout(dismiss, duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => (timer = setTimeout(dismiss, 1600)));
  return { dismiss, el };
}

/* ---- Modal ---- */

const modalStack = [];

/**
 * openModal({ title, body, footer, size: 'lg', className, onClose, initialFocus })
 * body/footer: node(s). Escape and scrim click close it. Focus is trapped
 * inside and restored on close. Stacked dialogs: only the topmost one reacts
 * to keys. Returns { el, close }.
 */
export function openModal({ title, body, footer, size, className, onClose, initialFocus } = {}) {
  const previous = document.activeElement;
  const titleId = `modal-title-${uid()}`;

  const close = (result) => {
    if (!root.isConnected) return;
    document.removeEventListener('keydown', onKey, true);
    const at = modalStack.indexOf(root);
    if (at !== -1) modalStack.splice(at, 1);
    root.classList.add('is-leaving');
    setTimeout(() => root.remove(), 140);
    if (previous && typeof previous.focus === 'function') previous.focus();
    onClose?.(result);
  };

  const modal = h(
    'div',
    { class: ['modal', 'hud', size === 'lg' && 'modal--lg', className], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'modal-head' },
      h('h2', { class: 'modal-title', id: titleId }, title ?? ''),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Close', onClick: () => close() }, icon('x')),
    ),
    h('div', { class: 'modal-body' }, body ?? null),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );

  let downOnScrim = false;
  const root = h('div', {
    class: 'modal-root',
    onPointerdown: (e) => {
      downOnScrim = e.target === root;
    },
    onClick: (e) => {
      if (downOnScrim && e.target === root) close();
      downOnScrim = false;
    },
  }, modal);

  const onKey = (e) => {
    if (modalStack[modalStack.length - 1] !== root) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const focusables = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (n) => !n.disabled && n.offsetParent !== null,
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  document.addEventListener('keydown', onKey, true);
  root.closeModal = close;
  modalStack.push(root);
  document.body.append(root);
  requestAnimationFrame(() => {
    const target =
      initialFocus ??
      modal.querySelector('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), .btn--primary:not(:disabled)') ??
      modal.querySelector('button:not(:disabled)');
    target?.focus();
  });

  return { el: modal, close };
}

/** Close every open dialog (topmost first) — the shell calls this on navigation. */
export function closeAllModals() {
  for (const root of [...modalStack].reverse()) root.closeModal?.();
}

/** confirmDialog({ title, message, confirmLabel, danger }) -> Promise<boolean> */
export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const confirmBtn = h(
      'button',
      {
        type: 'button',
        class: ['btn', danger ? 'btn--danger' : 'btn--primary'],
        onClick: () => {
          result = true;
          m.close();
        },
      },
      confirmLabel,
    );
    const m = openModal({
      title,
      body: message ? h('p', { class: 'muted' }, message) : null,
      footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, cancelLabel), confirmBtn],
      initialFocus: confirmBtn,
      onClose: () => resolve(result),
    });
  });
}

/* ==========================================================================
   Dates — all keys are LOCAL calendar days as 'YYYY-MM-DD'
   ========================================================================== */

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_MIN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayKey() {
  return dateKey(new Date());
}

/** 'YYYY-MM-DD' -> Date at local midnight */
export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

/** shiftKey('2026-10-04', -1) -> '2026-10-03' */
export function shiftKey(key, n) {
  return dateKey(addDays(parseKey(key), n));
}

/** Whole days from a to b (b - a). DST-safe. */
export function diffDays(aKey, bKey) {
  const [ay, am, ad] = aKey.split('-').map(Number);
  const [by, bm, bd] = bKey.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(key) {
  return parseKey(key).getDay();
}

/** formatDay(key) -> 'Sun 4 Oct'; formatDay(key, 'long') -> 'Sunday 4 October 2026' */
export function formatDay(key, style = 'short') {
  const d = parseKey(key);
  if (style === 'long') {
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

/** 'Today' | 'Tomorrow' | 'Yesterday' | 'In 3 days' | '3 days ago' | 'Sun 4 Oct' */
export function relativeDay(key, today = todayKey()) {
  const n = diffDays(today, key);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return `In ${n} days`;
  if (n < -1 && n > -7) return `${-n} days ago`;
  return formatDay(key);
}

/** Timestamp (ms) -> 'just now' | '5m ago' | '3h ago' | 'Yesterday' | 'Sun 4 Oct' */
export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hrs = Math.round(m / 60);
  const dayDelta = diffDays(dateKey(new Date(ts)), dateKey(new Date(now)));
  if (dayDelta === 0) return `${hrs}h ago`;
  if (dayDelta === 1) return 'Yesterday';
  return formatDay(dateKey(new Date(ts)));
}

/**
 * onDayChange(cb) — calls cb(newKey) when the local date rolls over
 * (checked every 30s and whenever the tab regains focus). Returns unsubscribe.
 */
export function onDayChange(cb) {
  let last = todayKey();
  const check = () => {
    const now = todayKey();
    if (now !== last) {
      last = now;
      cb(now);
    }
  };
  const timer = setInterval(check, 30000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}

/* ==========================================================================
   Helpers
   ========================================================================== */

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/* ==========================================================================
   Skin-aware text — the active template decides how numbers and some words read
   ========================================================================== */

/** The active template: 'simple' | 'hud' | 'brutalist' | 'terminal' (from <html data-skin>). */
export function skin() {
  if (typeof document === 'undefined') return DEFAULT_SKIN;
  return normalizeSkin(document.documentElement.dataset.skin);
}

/** Index label: idx(3) -> '03' (Mission Control, Brutalist, Terminal) or '3' (Simple). */
export function idx(n, width = 2) {
  return formatIndex(n, width, skin());
}

/** Count in a readout: num(7) -> '07' or '7', by the same per-skin rules (skins.js SKIN_NUMBERS). */
export function num(n, width = 2) {
  return formatCount(n, width, skin());
}

/** Skin-specific wording: term('shell.status', 'Local · Synced') -> 'Saved on this device' in Simple. */
export function term(key, fallback) {
  return termFor(skin(), key, fallback);
}

/**
 * onSkinChange(cb) -> unsubscribe. cb({ skin, previous }) after the template changed (picker or
 * another tab). The shell re-mounts the current page by itself; persistent widgets (topbar())
 * that print idx()/num()/term() text listen here.
 */
export function onSkinChange(cb) {
  const handler = (e) => cb(e.detail);
  window.addEventListener('lifeos:skin', handler);
  return () => window.removeEventListener('lifeos:skin', handler);
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** debounce(fn, ms) with .flush() and .cancel() */
export function debounce(fn, ms = 300) {
  let timer = null;
  let lastArgs = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return debounced;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** True when a keyboard event originates from a text-entry control (skip global shortcuts). */
export function isTyping(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'INPUT') return !NON_TEXT_INPUTS.has(t.type);
  return t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

/** True while any modal dialog is open (features should ignore global shortcuts then). */
export function modalOpen() {
  return !!document.querySelector('.modal-root');
}
