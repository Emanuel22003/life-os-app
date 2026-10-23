// LIFE/OS — UI kit: DOM builder, icons, shared widgets, dates, helpers, skin-aware text.
// Features import from here instead of re-implementing. Keep it dependency-free (skins.js is pure).

import { DEFAULT_SKIN, normalizeSkin, formatIndex, formatCount, termFor, isPlainSkin } from './skins.js';

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
   Many basic shapes match Feather (MIT, (c) 2013-2023 Cole Bemis) and Lucide (ISC, (c) Lucide
   Icons and Contributors); their notices are in legal/credits.html.
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
  tip: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2v.2h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3Z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
};

/** Add an icon at runtime (from a feature file). `inner` is trusted SVG child markup on a 24px grid. */
export function registerIcon(name, inner) {
  ICONS[name] = inner;
}

export function hasIcon(name) {
  return Object.hasOwn(ICONS, name);
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

/**
 * Standard page header used by every feature. Returns the <header>: one row of the page's icon
 * and title, its live status and its buttons (css/compact.css), then whatever the heading holds.
 * stat: a short live status on the title row ('3 today · 2 overdue', 'kr 338/mo'): a string or a
 *   node; change it later with header.setStat(value) ('' or null hides it). It is a status, not a
 *   number strip: keep it to a few words.
 * tipId: the subtitle explains the page (a tip): it carries a ✓ that hides it for good
 *   (settings.tips), and it shows only until then (and while no other tip of the page shows,
 *   gateTips). Every page should pass one. A subtitle without a tipId is a plain line (Home's date).
 * Action buttons get their text as their name and tooltip, so a phone can show them as icons only.
 */
export function pageHeader({ index, title, subtitle, actions = [], tipId = null, stat = null }) {
  for (const a of actions) {
    if (!(a instanceof HTMLElement) || !a.matches('button, a')) continue;
    const text = [...a.children].filter((c) => c.tagName === 'SPAN' && !c.classList.contains('kbd')).map((c) => c.textContent.trim()).join(' ').trim();
    if (!text) continue;
    if (!a.hasAttribute('aria-label')) a.setAttribute('aria-label', text);
    if (!a.title) a.title = text;
  }
  // The live status: a quiet line beside the title (on a phone too, cut short when the row is full)
  const statEl = h('p', { class: 'page-stat' });
  const setStat = (value) => {
    const empty = value == null || value === false || (typeof value === 'string' && !value.trim());
    statEl.replaceChildren(...(empty ? [] : [value instanceof Node ? value : String(value)]));
    statEl.hidden = empty;
  };
  setStat(stat);
  let sub = null;
  if (subtitle && !(tipId && tipHidden(tipId))) {
    sub = h('p', { class: ['page-subtitle', tipId && 'page-tip'], dataset: tipId ? { tipId } : null }, h('span', null, subtitle));
    if (tipId) {
      sub.append(
        h(
          'button',
          {
            type: 'button',
            class: 'page-tip-ok',
            title: 'Got it: hide this explanation',
            'aria-label': 'Got it, hide this explanation',
            onClick: () => {
              dismissTip(tipId);
              hideTip(sub);
            },
          },
          icon('check', { size: 12, stroke: 2 }),
          h('span', null, 'Got it'),
        ),
      );
    }
  }
  const header = h(
    'header',
    { class: 'page-header' },
    h(
      'div',
      { class: 'page-heading' },
      // The kicker ("01 // TASKS") repeats the title: pages hide it (css/compact.css), only the
      // Appearance previews show it
      h('div', { class: 'page-kicker label lo-deco' }, index ? h('span', null, index) : null, index ? h('span', { class: 'crumb-sep' }, '//') : null, h('span', null, title)),
      h('h1', { class: 'page-title' }, title),
      statEl,
      sub,
    ),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null,
  );
  header.setStat = setStat;
  return header;
}

/* ---- Icon badges and the icon picker ---- */

/**
 * An icon in a small tinted square. tone: a page id ('tasks', 'habits' …) whose color it takes
 * (css/icons.css: --mod-<tone>, while Color coding → Pages is on), or none for the plain gray.
 * size: the icon's px; the square is a bit larger (--ib-box in CSS, or the `box` option).
 */
export function iconBadge(name, { tone = null, size = 15, box = null, className = '', label = null } = {}) {
  return h(
    'span',
    {
      class: ['ib', className],
      dataset: tone ? { tone } : null,
      style: box ? { '--ib-box': `${box}px` } : null,
      role: label ? 'img' : null,
      'aria-label': label,
      'aria-hidden': label ? null : 'true',
    },
    icon(name, { size }),
  );
}

/**
 * A grid of icons to pick one from (a radio group: arrow keys move, Enter or Space picks).
 * choices: [{ name, label }]. auto: the icon a name suggests, offered first as "Auto" (picking it
 * stores null, so the icon keeps following the name). onChange(name | null).
 * Returns { el, set(value), setAuto(name) }.
 */
export function iconPicker({ choices = [], value = null, auto = null, onChange = () => {}, labelledBy = null } = {}) {
  const el = h('div', { class: 'ip', role: 'radiogroup', 'aria-labelledby': labelledBy });
  let current = value;
  let autoName = auto;
  const autoBtn = auto !== undefined && auto !== false;
  const buttons = [];

  function make(name, label, isAuto = false) {
    const b = h(
      'button',
      { type: 'button', class: ['ip-btn', isAuto && 'ip-auto'], role: 'radio', title: label, 'aria-label': label, dataset: { name: isAuto ? '' : name } },
      icon(isAuto ? autoName || 'circle' : name, { size: 18 }),
      isAuto ? h('span', { class: 'ip-auto-tag' }, 'Auto') : null,
    );
    b.addEventListener('click', () => pick(isAuto ? null : name, b));
    buttons.push(b);
    return b;
  }

  function paint() {
    for (const b of buttons) {
      const on = (b.dataset.name || null) === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!buttons.some((b) => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
  }

  function pick(name, b) {
    current = name;
    paint();
    b?.focus({ preventScroll: true });
    onChange(name);
  }

  const autoLabel = () => `Auto (follows the name)${autoName ? `: ${choices.find((c) => c.name === autoName)?.label ?? autoName}` : ''}`;
  if (autoBtn) el.append(make(null, autoLabel(), true));
  for (const c of choices) el.append(make(c.name, c.label));

  el.addEventListener('keydown', (e) => {
    const at = buttons.indexOf(document.activeElement);
    if (at === -1) return;
    const cols = Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').length);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: buttons.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const b = buttons[Math.max(0, Math.min(buttons.length - 1, to))];
    pick(b.dataset.name || null, b);
  });

  paint();
  return {
    el,
    set(next) {
      current = next ?? null;
      paint();
    },
    /** The name changed: the Auto button shows its new suggestion. */
    setAuto(name) {
      autoName = name;
      const b = buttons.find((x) => x.classList.contains('ip-auto'));
      b?.querySelector('svg')?.replaceWith(icon(name || 'circle', { size: 18 }));
      if (b) {
        b.title = autoLabel();
        b.setAttribute('aria-label', autoLabel());
      }
    },
  };
}

/* ---- Tips: short explanations with a ✓ that hides each one for good (settings.tips) ----
   The settings store lives in store.js, which needs a browser; ui.js stays importable without
   one (the tests), so app.js hands the store over at start-up (useSettings). */

let settingsStore = null;

export function useSettings(store) {
  settingsStore = store;
}


export function tipHidden(id) {
  return !!settingsStore?.get().tips?.[id];
}

/**
 * Hide tip `id` for good on this device. Pages call it themselves once the person has done what a
 * tip explains (ticked a habit, dragged a card): any copy of it on screen goes at once, and the
 * page's next tip may show (gateTips).
 */
export function dismissTip(id) {
  if (!settingsStore || id == null) return;
  const s = settingsStore.get();
  if (!s.tips?.[id]) settingsStore.update({ tips: { ...(s.tips ?? {}), [id]: true } });
  if (typeof document === 'undefined') return;
  for (const el of document.querySelectorAll('[data-tip-id]')) if (el.dataset.tipId === String(id) && el.isConnected) hideTip(el);
}

/** How many tips are hidden on this device. */
export function hiddenTipCount() {
  return Object.values(settingsStore?.get().tips ?? {}).filter(Boolean).length;
}

export function resetTips() {
  settingsStore?.update({ tips: {} });
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Hide a tip and, if focus was on its button, move it to whatever comes next on the page. */
function hideTip(box) {
  const hadFocus = box.contains(document.activeElement);
  const next = hadFocus ? [...document.querySelectorAll(FOCUSABLE)].find((n) => !box.contains(n) && box.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING && n.getClientRects().length) : null;
  if (box.matches('.page-tip')) box.remove();
  else box.hidden = true;
  next?.focus({ preventScroll: true });
}

/**
 * A tip box: a short explanation and "✓ Got it", which hides it for good on this device.
 * Returns the element (hidden already when it was dismissed before), so callers can always
 * append it. text: a string or nodes.
 */
export function tip({ id, text, className = '' } = {}) {
  const el = h('div', { class: ['tip', className], role: 'note', hidden: tipHidden(id), dataset: id == null ? null : { tipId: String(id) } });
  el.append(
    h('span', { class: 'tip-icon', 'aria-hidden': 'true' }, icon('tip', { size: 15 })),
    h('p', { class: 'tip-text' }, text),
    h(
      'button',
      {
        type: 'button',
        class: 'tip-ok',
        title: 'Got it: hide this tip',
        'aria-label': 'Got it, hide this tip',
        onClick: () => {
          dismissTip(id);
          hideTip(el);
        },
      },
      icon('check', { size: 13, stroke: 2 }),
      h('span', null, 'Got it'),
    ),
  );
  return el;
}

/**
 * One tip at a time: inside each page (a `.view` under `scope`, the shell's <main>), only the first
 * tip on screen shows (a page's explanation under its title comes first); the others wait
 * (data-tip-wait, hidden by css/components.css) until it is dismissed, hidden or gone. Tips in
 * dialogs are left alone. Re-checked when a change in the page touches a tip (one added, removed or
 * hidden, or a box holding one shown or hidden) and when the window resizes. Returns stop().
 */
export function gateTips(scope) {
  const TIPS = '.page-tip, .tip';
  const holdsTip = (node) => node?.nodeType === 1 && (node.matches(TIPS) || !!node.querySelector(TIPS));
  // A ticking clock or a drag changes the page many times a second: only a change that can show
  // or hide a tip measures the page again (measuring lays it out)
  const touchesTips = (records) =>
    records.some((r) => (r.type === 'attributes' ? holdsTip(r.target) : [...r.addedNodes, ...r.removedNodes].some(holdsTip)));
  const sync = () => {
    for (const view of scope.querySelectorAll(':scope > .view')) {
      const tips = [...view.querySelectorAll('.page-tip, .tip')];
      if (!tips.length) continue;
      // Measured with none waiting: what would be on screen (not hidden, not in a closed tab or
      // a template that leaves tips out)
      tips.forEach((t) => t.removeAttribute('data-tip-wait'));
      let shown = false;
      for (const t of tips) {
        if (t.hidden || !t.getClientRects().length) continue;
        if (shown) t.setAttribute('data-tip-wait', '');
        shown = true;
      }
    }
  };
  // Only what can show or hide a tip: added or removed nodes, `hidden` and classes (data-tip-wait
  // itself is left out, so this never wakes itself up)
  const observer = new MutationObserver((records) => {
    if (touchesTips(records)) sync();
  });
  observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  // A narrower or wider window can hide a tip's box (a phone layout): once per frame
  let frame = 0;
  const onResize = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };
  window.addEventListener('resize', onResize);
  sync();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', onResize);
    cancelAnimationFrame(frame);
  };
}

/* ---- Dropdown menus ---- */

let openMenu = null;

/** Whether a dropdown menu is open (page shortcuts stay quiet meanwhile). */
export function menuOpen() {
  return !!openMenu;
}

/**
 * A dropdown: a compact button that opens a short menu under it.
 *   dropdown({ label, icon, items, value, onSelect, multi, align, className, title, showValue })
 * items: [{ value, label, icon?, hint?, checked?, disabled?, danger?, action?, separator? }]
 * - Pick one (default): `value` is the current one; the button shows `label: <its label>` (or
 *   just its label without `label`); onSelect(value) closes the menu.
 * - multi: true: each item is a checkbox (`checked`); onSelect(value, checked) keeps it open.
 *   The button shows `label` and how many are on.
 * - An item with `action` is a command (New section…); `separator: true` draws a line.
 * ariaLabel: the button's name, a string or ({ label, value, picked, on }) => string, so it can
 * follow the value ('Calendar view: Week'); menuLabel: the open menu's name (default: label).
 * Returns { el, button, update({ items, value, label, ariaLabel }), open(), close() }.
 */
export function dropdown({ label = '', icon: iconName = null, items = [], value = null, onSelect = () => {}, multi = false, align = 'start', className = '', title = '', showValue = true, ariaLabel = '', menuLabel = '' } = {}) {
  const state = { items, value, label, ariaLabel };
  const labelEl = h('span', { class: 'dd-label' });
  const countEl = h('span', { class: 'dd-count tnum' });
  const button = h(
    'button',
    { type: 'button', class: ['btn btn--sm dd-btn', className], 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: title || null },
    iconName ? icon(iconName, { size: 14 }) : null,
    labelEl,
    countEl,
    icon('chevron-down', { size: 13, className: 'dd-chev' }),
  );
  const el = h('div', { class: 'dd' }, button);
  let menu = null;

  function paint() {
    const picked = state.items.find((it) => !it.action && !it.separator && it.value === state.value);
    let text = state.label;
    if (!multi && showValue && picked) text = state.label ? `${state.label}: ${picked.label}` : picked.label;
    labelEl.textContent = text;
    labelEl.hidden = !text;
    const on = multi ? state.items.filter((it) => !it.action && !it.separator && it.checked && !it.disabled).length : 0;
    countEl.textContent = multi ? String(on) : '';
    countEl.hidden = !multi;
    const named = typeof state.ariaLabel === 'function' ? state.ariaLabel({ label: state.label, value: state.value, picked, on }) : state.ariaLabel;
    button.setAttribute('aria-label', named || (multi ? `${state.label}: ${on} on` : text || title || 'Menu'));
  }

  function itemEl(it, i) {
    if (it.separator) return h('div', { class: 'dd-sep', role: 'separator' });
    const role = it.action ? 'menuitem' : multi ? 'menuitemcheckbox' : 'menuitemradio';
    const checked = it.action ? null : multi ? !!it.checked : it.value === state.value;
    return h(
      'button',
      {
        type: 'button',
        class: ['dd-item', it.danger && 'is-danger'],
        role,
        tabindex: '-1',
        disabled: !!it.disabled,
        'aria-checked': checked === null ? null : String(checked),
        dataset: { i: String(i) },
        onClick: () => choose(it),
      },
      h('span', { class: 'dd-mark', 'aria-hidden': 'true' }, checked ? icon('check', { size: 13, stroke: 2 }) : null),
      it.icon ? icon(it.icon, { size: 14 }) : null,
      h('span', { class: 'dd-item-label' }, it.label),
      it.hint ? h('span', { class: 'dd-hint' }, it.hint) : null,
    );
  }

  function choose(it) {
    if (it.disabled) return;
    if (it.action) {
      close(true);
      it.action();
      return;
    }
    if (multi) {
      it.checked = !it.checked;
      onSelect(it.value, it.checked);
      if (menu) {
        const fresh = menu.querySelector(`[data-i="${state.items.indexOf(it)}"]`);
        fresh?.setAttribute('aria-checked', String(!!it.checked));
        fresh?.querySelector('.dd-mark')?.replaceChildren(...(it.checked ? [icon('check', { size: 13, stroke: 2 })] : []));
      }
      paint();
      return;
    }
    state.value = it.value;
    paint();
    close(true);
    onSelect(it.value);
  }

  function place() {
    if (!menu) return;
    const r = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    menu.style.minWidth = `${Math.max(r.width, 180)}px`;
    menu.style.maxHeight = `${Math.max(160, vh - r.bottom - 16)}px`;
    const w = menu.offsetWidth;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.bottom + 4;
    // Not enough room below: open upwards
    if (top + menu.offsetHeight > vh - 8 && r.top - menu.offsetHeight - 4 > 8) top = r.top - menu.offsetHeight - 4;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  const onDocDown = (e) => {
    if (menu && !menu.contains(e.target) && !button.contains(e.target)) close(false);
  };
  // Also bound to window 'resize', whose target is window (not a Node): that closes it too
  const onScroll = (e) => {
    if (menu && !(e.target instanceof Node && menu.contains(e.target))) close(false);
  };

  function items_() {
    return menu ? [...menu.querySelectorAll('.dd-item:not(:disabled)')] : [];
  }

  function open() {
    if (menu) return;
    if (openMenu && openMenu !== api) openMenu.close(false);
    menu = h('div', { class: 'dd-menu', role: 'menu', 'aria-label': menuLabel || state.label || title || 'Menu' }, state.items.map(itemEl));
    menu.addEventListener('keydown', (e) => {
      const list = items_();
      const at = list.indexOf(document.activeElement);
      let to = null;
      if (e.key === 'ArrowDown') to = list[(at + 1) % list.length];
      else if (e.key === 'ArrowUp') to = list[(at - 1 + list.length) % list.length];
      else if (e.key === 'Home') to = list[0];
      else if (e.key === 'End') to = list[list.length - 1];
      else if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Tab') close(true); // back on its button, so Tab goes on from there
      if (to) {
        e.preventDefault();
        to.focus();
      }
      // Keys pressed in the menu are the menu's: page shortcuts don't fire
      e.stopPropagation();
    });
    document.body.append(menu);
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('is-open');
    openMenu = api;
    place();
    const list = items_();
    (list.find((b) => b.getAttribute('aria-checked') === 'true') ?? list[0])?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onDocDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }

  function close(refocus = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (openMenu === api) openMenu = null;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('is-open');
    document.removeEventListener('pointerdown', onDocDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    if (refocus && button.isConnected) button.focus({ preventScroll: true });
  }

  button.addEventListener('click', () => (menu ? close(true) : open()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !menu) {
      e.preventDefault();
      open();
    }
  });

  const api = {
    el,
    button,
    open,
    close,
    /** New items, value or label (the open menu is rebuilt). */
    update({ items: nextItems, value: nextValue, label: nextLabel, ariaLabel: nextName } = {}) {
      if (nextItems) state.items = nextItems;
      if (nextValue !== undefined) state.value = nextValue;
      if (nextLabel !== undefined) state.label = nextLabel;
      if (nextName !== undefined) state.ariaLabel = nextName;
      paint();
      if (menu) {
        // Rebuilt while open: the keyboard stays on the same entry
        const at = menu.contains(document.activeElement) ? document.activeElement.dataset.i : null;
        menu.replaceChildren(...state.items.map(itemEl));
        if (at != null) (menu.querySelector(`[data-i="${at}"]:not(:disabled)`) ?? items_()[0])?.focus({ preventScroll: true });
      }
    },
  };
  paint();
  return api;
}

/**
 * THE empty state, on every page: an icon, a short title, a sentence and at most one action. It
 * spans the whole content width (a grid's every column too; css/components.css). Its action is
 * never a second copy of the page header's main button: leave `action` out then, or offer the
 * next step instead (Import, Use a starter).
 */
export function emptyState({ icon: iconName = 'inbox', title, text, action, className = '' } = {}) {
  return h(
    'div',
    { class: ['empty', className] },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 20 })),
    title ? h('div', { class: 'empty-title' }, title) : null,
    text ? h('div', { class: 'empty-text' }, text) : null,
    action ?? null,
  );
}

/**
 * Square checkbox button. Toggle state with setChecked(el, bool).
 * Its .check-hit child is the finger-sized target (44px on touch screens, css/compact.css): an
 * element of its own, so a template drawing on the check's ::before / ::after can't shrink it.
 */
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
    h('span', { class: 'check-hit', 'aria-hidden': 'true' }),
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

/**
 * toast('Task deleted', { action: { label: 'Undo', onClick }, duration, key }) -> { dismiss, el }.
 * Default 3.8s. With an action (Undo) at least 6s, whatever `duration` says, so there is time to
 * reach the button. The one way to confirm a change you can take back (single delete, complete,
 * move): do it at once and offer Undo here; ask first (confirmDialog) only for bulk or permanent ones.
 * `key`: a toast with the same key takes the place of the one still showing (five quick ticks are
 * one toast, with the latest one's Undo, not five covering a phone's list). Toasts without a key,
 * or with another one (a delete's Undo), are never touched.
 */
export function toast(message, { action, duration = 3800, key = null } = {}) {
  if (action) duration = Math.max(Number(duration) || 0, 6000);
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
    { class: 'toast', dataset: key ? { key: String(key) } : null },
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
  // The same key: in the place of the one showing (its own timer then finds it gone)
  const before = key ? [...toastStack.children].find((n) => n.dataset.key === String(key) && !n.classList.contains('is-leaving')) : null;
  if (before) before.replaceWith(el);
  else toastStack.append(el);
  // keep at most 4 visible
  while (toastStack.children.length > 4) toastStack.firstElementChild.remove();
  // The clock stops while the pointer is over it or the keyboard is on it (Tab reaches Undo), and
  // runs on after with what was left, at least 1.6s (WCAG 2.2.1)
  let left = duration;
  let started = Date.now();
  const holds = new Set();
  const hold = (why) => {
    if (!holds.size) {
      clearTimeout(timer);
      left = Math.max(0, left - (Date.now() - started));
    }
    holds.add(why);
  };
  const release = (why) => {
    if (!holds.delete(why) || holds.size) return;
    left = Math.max(left, 1600);
    started = Date.now();
    timer = setTimeout(dismiss, left);
  };
  timer = setTimeout(dismiss, duration);
  el.addEventListener('pointerenter', () => hold('pointer'));
  el.addEventListener('pointerleave', () => release('pointer'));
  el.addEventListener('focusin', () => hold('focus'));
  el.addEventListener('focusout', (e) => {
    if (!el.contains(e.relatedTarget)) release('focus');
  });
  return { dismiss, el };
}

/* ---- Modal ---- */

const modalStack = [];

// While a dialog is open, everything behind it is inert (no clicks, no Tab, out of the screen
// reader's way): the app (#app) and any dialog under the top one (an editor under its confirm).
// Menus, toasts and the right-click menu live outside #app, at the end of <body>, so they keep
// working. #app gets its own state back when the last dialog closes.
let appHeld = false;
let appWasInert = false;

function syncInert() {
  const top = modalStack[modalStack.length - 1];
  for (const r of modalStack) r.inert = r !== top;
  const app = document.getElementById('app');
  if (!app) return;
  if (top && !appHeld) {
    appHeld = true;
    appWasInert = app.inert;
    app.inert = true;
  } else if (!top && appHeld) {
    appHeld = false;
    app.inert = appWasInert;
  }
}

/** What Tab can reach inside `box`, in order. */
function tabbables(box) {
  return [...box.querySelectorAll(`${FOCUSABLE}, [contenteditable]:not([contenteditable="false"])`)].filter(
    (n) => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden',
  );
}

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
    root.inert = true;
    setTimeout(() => root.remove(), 140);
    // What was behind it wakes up first, so the focus can go back there
    syncInert();
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
      // Something open inside the dialog closes first, the dialog on the next Esc: a handler that
      // already took this Esc (preventDefault), a menu it opened (on <body>: a dropdown's list, a
      // right-click menu, which close themselves), a combobox or menu button showing its list
      if (e.defaultPrevented) return;
      const active = document.activeElement;
      if (active && !root.contains(active) && active.closest?.('.dd-menu, .ctx-menu, [role="menu"], [role="listbox"]')) return;
      if (openMenu) {
        // (a dropdown still open with the focus elsewhere: closed from here)
        e.preventDefault();
        e.stopPropagation();
        openMenu.close(true);
        return;
      }
      if (active && root.contains(active) && active.matches?.('[aria-expanded="true"]:is([role="combobox"], [aria-haspopup]:not([aria-haspopup="false"]))')) {
        // Its own handler hears this Esc after this one (capturing): the dialog closes only when
        // that left its list open. Search's list is always open (it is the dialog): Esc closes it.
        const after = (ev) => {
          document.removeEventListener('keydown', after);
          if (ev !== e || e.defaultPrevented || active.getAttribute('aria-expanded') !== 'true' || !root.isConnected) return;
          close();
        };
        document.addEventListener('keydown', after);
        // (a handler that stopped the Esc took it: the listener goes with this task)
        setTimeout(() => document.removeEventListener('keydown', after), 0);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const active = document.activeElement;
      // A menu this dialog opened (a dropdown's list, added to <body> after it) handles its own Tab
      if (active && !root.contains(active) && root.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING && !active.closest('.modal-root, .toast-stack')) return;
      const focusables = tabbables(modal);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first) {
        e.preventDefault();
        return;
      }
      // The focus got out (a click on the page's edge, a toast, an element that went away):
      // Tab brings it back in, at the start (Shift + Tab: the end)
      if (!modal.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  document.addEventListener('keydown', onKey, true);
  root.closeModal = close;
  modalStack.push(root);
  document.body.append(root);
  syncInert();
  // The first field (or the main button) gets the focus once the dialog is drawn. A tab that
  // paints no frames (in the background) never runs requestAnimationFrame: the timer backs it up.
  let focused = false;
  const focusInitial = () => {
    if (focused || !root.isConnected || root.inert) return;
    focused = true;
    const target =
      initialFocus ??
      modal.querySelector('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), .btn--primary:not(:disabled)') ??
      modal.querySelector('button:not(:disabled)');
    target?.focus();
  };
  requestAnimationFrame(focusInitial);
  setTimeout(focusInitial, 100);

  return { el: modal, close };
}

/** Close every open dialog (topmost first) — the shell calls this on navigation. */
export function closeAllModals() {
  for (const root of [...modalStack].reverse()) root.closeModal?.();
}

/**
 * confirmDialog({ title, message, confirmLabel, danger }) -> Promise<boolean>
 * For bulk or permanent actions only (Clear completed, Delete all my data): a single item is
 * deleted at once with Undo in the toast. A danger confirm is the dialog's main button, filled in
 * the "late" color (.btn--danger-fill), and Cancel takes the focus first.
 */
export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const confirmBtn = h(
      'button',
      {
        type: 'button',
        class: ['btn', danger ? 'btn--danger btn--danger-fill' : 'btn--primary'],
        onClick: () => {
          result = true;
          m.close();
        },
      },
      confirmLabel,
    );
    const cancelBtn = h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, cancelLabel);
    const m = openModal({
      title,
      body: message ? h('p', { class: 'muted' }, message) : null,
      footer: [cancelBtn, confirmBtn],
      // Deleting takes a deliberate move: Enter right away keeps everything (Cancel has the focus)
      initialFocus: danger ? cancelBtn : confirmBtn,
      onClose: () => resolve(result),
    });
  });
}

/**
 * Ask for a name (Rename in the right-click menus). Resolves to the trimmed text, or null when
 * cancelled. validate(text) may return a message, which keeps the dialog open.
 */
export function promptDialog({ title = 'Rename', label = 'Name', value = '', confirmLabel = 'Save', maxLength = 120, validate = null } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const inputId = `prompt-${uid()}`;
    const input = h('input', { class: 'input', id: inputId, type: 'text', value, maxlength: String(maxLength), autocomplete: 'off', spellcheck: 'false' });
    const err = h('p', { class: 'prompt-error', role: 'alert', hidden: true });
    const submit = () => {
      const text = input.value.replace(/\s+/g, ' ').trim();
      const problem = text ? validate?.(text) : 'Type a name.';
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      result = text;
      m.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
    const m = openModal({
      title,
      body: h('div', { class: 'field' }, h('label', { class: 'label', for: inputId }, label), input, err),
      footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn btn--primary', onClick: submit }, confirmLabel)],
      initialFocus: input,
      onClose: () => resolve(result),
    });
    requestAnimationFrame(() => input.select());
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

/** The active template: 'simple' | 'hud' | 'brutalist' | 'terminal' | 'oldmoney' (from <html data-skin>). */
export function skin() {
  if (typeof document === 'undefined') return DEFAULT_SKIN;
  return normalizeSkin(document.documentElement.dataset.skin);
}

/** True in a plain template (Simple, Old Money): everyday words, fewer numbers (skins.js PLAIN_SKINS). */
export function plainSkin() {
  return isPlainSkin(skin());
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

/** Motion should be kept to a minimum: the computer asks for it, or Settings → Reduce animations. */
export function reducedMotion() {
  if (globalThis.document?.documentElement?.dataset.motion === 'reduced') return true;
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** True while any modal dialog is open (features should ignore global shortcuts then). */
export function modalOpen() {
  return !!document.querySelector('.modal-root');
}
