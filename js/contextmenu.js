// LIFE/OS — the right-click menu: the module's own actions, then Edit… · Rename · Duplicate · Copy ·
// Paste, the colors, and Delete last behind a line, for every module.
//
// The shell installs it once (installContextMenu(main) in js/app.js). It opens on a right-click
// over an item or a blank part of the page; text fields, links and selected text keep the
// browser's own menu. Shift + F10 or the ContextMenu key opens it at the focused item. The same
// actions run from the keyboard on a focused item: ⌘/Ctrl + C · V · D and Delete / Backspace
// (only when the module hasn't used that key itself).
//
// Modules say what is under the pointer and how to act on it. Register on mount, unregister in
// the cleanup:
//
//   const off = registerContextProvider('tasks', (el, { x, y, keyboard }) => target | null);
//
//   target = {
//     kind: 'task' | 'note' | 'habit' | 'event' | null,   // what was right-clicked; null: a blank area
//     id, label,                // the item's id; the menu's accessible name ('Task: Buy milk')
//     el,                       // the item's element (where a keyboard-opened menu appears)
//     accepts: ['task'],        // clipboard kinds paste(clip) takes
//     copy()    -> { kind, snapshot, text } | null       // enables Copy
//     paste(clip)               // an in-app copy whose kind is in `accepts`
//     pasteText(text)           // plain text from the system clipboard (Tasks, Notes)
//     remove()                  // the module's own delete (confirmation, Undo)
//     duplicate()               // copy + paste next to the original
//     edit()                    // optional: open the item's own editor ("Edit…")
//     rename()                  // optional: change its name in place or in a small dialog ("Rename")
//     can: { copy, paste, delete, duplicate }             // false greys out an action it has
//     color: { kind, value, set(id | null) }               // optional: a row of color swatches
//                                                          // (shown while that kind's colors are on)
//     actions: [                // optional: the module's own actions, listed FIRST (Complete,
//       { id, label,            //   Today, Priority ▸, Move to ▸ …)
//         icon?, kbd?,          //   a ui.js icon name; a key hint shown on the right ('Space')
//         run(),                //   what it does (the module's own write, toast and Undo)
//         disabled?,            //   greyed out
//         checked?,             //   true / false: a choice that shows a ✓ (Priority ▸ High)
//         children?: [ … ] },   //   the same shape: a submenu (opens on hover, →, Enter or a tap)
//       { separator: true },    //   a line between groups of actions
//     ],
//   }
//
// The order is fixed (contextmenu.logic.js menuEntries): the module's actions, Edit… · Rename,
// Duplicate · Copy · Paste, the colors, then Delete last behind a line. Submenu keys: → (or Enter)
// opens one on its first item, ← or Esc closes it again, ↑ ↓ Home End and first letters move inside.
//
// Providers are asked newest first; the first target wins. Every mutation stays in the module
// (its store helpers, normalization, Undo toast): this file only routes the action and keeps the
// in-app clipboard ({ kind, snapshot, text } in memory and sessionStorage, so it survives a
// route change), plus the plain text on the system clipboard.

import { h, icon, registerIcon, toast, isTyping, modalOpen, reducedMotion, uid } from './ui.js';
import { colorPicker } from './colors.js';
import { menuPosition, submenuPosition, menuEntries, normalizeActions, stepIndex, shortcutLabels, actionForKey, isMenuKey, makeClip, readClip, pasteMode, sameText } from './contextmenu.logic.js';

registerIcon('ctx-copy', '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>');
registerIcon('ctx-paste', '<path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 13h6M9 17h4"/>');
registerIcon('ctx-edit', '<path d="M4 6h10M4 12h7M4 18h5"/><path d="M15.2 19.6 21 13.8a1.6 1.6 0 0 0-2.3-2.3l-5.8 5.8-.6 2.9Z"/>');
registerIcon('ctx-rename', '<path d="M4 7V5h11v2M9.5 5v14M7.5 19h4"/><path d="M17 9v10M15.5 9h3M15.5 19h3"/>');
registerIcon('ctx-duplicate', '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11M14.5 11.5v6M11.5 14.5h6"/>');

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
const KEYS = shortcutLabels(IS_MAC);
// The built-in actions (their order and grouping: menuEntries in contextmenu.logic.js). Edit and
// Rename show only on items that have them; the others are always listed, greyed out when unavailable.
const BUILTINS = Object.freeze({
  edit: { label: 'Edit…', icon: 'ctx-edit' },
  rename: { label: 'Rename', icon: 'ctx-rename' },
  duplicate: { label: 'Duplicate', icon: 'ctx-duplicate' },
  copy: { label: 'Copy', icon: 'ctx-copy' },
  paste: { label: 'Paste', icon: 'ctx-paste' },
  delete: { label: 'Delete', icon: 'trash' },
});
// A pointer resting on an item opens its submenu, or closes another one, after this long (so a
// diagonal move into an open submenu doesn't close it on the way)
const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 260;
const CLIP_KEY = 'lifeos:clipboard';
// Right-clicks here keep the browser's menu: text fields (spellcheck, copy / paste text), links
const NATIVE = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"]), a[href]';

/* ==========================================================================
   Providers
   ========================================================================== */

const providers = new Map(); // id -> resolve(el, info)

/** Say what a right-click over `el` means in a module. Returns the unregister function. */
export function registerContextProvider(id, resolve) {
  providers.delete(id);
  providers.set(id, resolve);
  return () => {
    if (providers.get(id) === resolve) providers.delete(id);
    if (menu?.providerId === id) closeMenu();
  };
}

/** The target under `el` (newest provider first), with the shell's view of what it can do. */
function resolveTarget(el, info) {
  for (const [id, resolve] of [...providers].reverse()) {
    let t = null;
    try {
      t = resolve(el, info);
    } catch (err) {
      console.error(`[contextmenu] provider "${id}" failed`, err);
    }
    if (t && typeof t === 'object') return { ...t, providerId: id };
  }
  return null;
}

/** Which actions are available on `t` now (Paste depends on the clipboard). */
function abilities(t) {
  const can = t.can ?? {};
  const mode = pasteMode(getClip(), { accepts: t.paste ? t.accepts ?? [] : [], text: typeof t.pasteText === 'function' });
  return {
    copy: typeof t.copy === 'function' && can.copy !== false,
    paste: mode !== null && can.paste !== false,
    delete: typeof t.remove === 'function' && can.delete !== false,
    duplicate: typeof t.duplicate === 'function' && can.duplicate !== false,
    edit: typeof t.edit === 'function',
    rename: typeof t.rename === 'function',
  };
}

/* ==========================================================================
   Clipboard: the in-app copy (kind + snapshot) and its plain text on the system clipboard
   ========================================================================== */

let clip; // undefined until read from sessionStorage

/** The in-app clipboard { kind, snapshot, text, at } or null. */
export function getClip() {
  if (clip === undefined) {
    try {
      clip = readClip(JSON.parse(sessionStorage.getItem(CLIP_KEY) ?? 'null'));
    } catch {
      clip = null;
    }
  }
  return clip;
}

function setClip(next) {
  clip = next;
  try {
    if (next) sessionStorage.setItem(CLIP_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(CLIP_KEY);
  } catch {
    /* private mode / quota: the copy still lives in memory for this page */
  }
}

/** Run the target's copy(); keep the result. -> its plain text, or null when there was nothing to copy. */
function takeCopy(t) {
  let data = null;
  try {
    data = t.copy?.();
  } catch (err) {
    console.error('[contextmenu] copy failed', err);
  }
  const entry = data ? makeClip(data.kind ?? t.kind, data.snapshot, data.text) : null;
  if (!entry) {
    toast('Nothing to copy.');
    return null;
  }
  setClip(entry);
  return entry.text;
}

/** Read text from the system clipboard. -> { text } | { error: 'empty' | 'blocked' } */
async function readSystemText() {
  try {
    if (!navigator.clipboard?.readText) return { error: 'blocked' };
    const text = await navigator.clipboard.readText();
    return text && text.trim() ? { text } : { error: 'empty' };
  } catch {
    return { error: 'blocked' };
  }
}

/** True when reading the clipboard won't prompt (permission already granted). */
async function canReadSilently() {
  try {
    const status = await navigator.permissions?.query({ name: 'clipboard-read' });
    return status?.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Paste into `t`. `systemText` is the system clipboard's text when the browser handed it over
 * (⌘V); otherwise it is read here when needed. An in-app copy wins unless the system clipboard
 * holds something newer (other text, copied after it) and the target takes text.
 */
async function pasteInto(t, systemText) {
  const c = getClip();
  const takesText = typeof t.pasteText === 'function';
  const mode = pasteMode(c, { accepts: t.paste ? t.accepts ?? [] : [], text: takesText });
  if (!mode) return;
  if (mode === 'item') {
    let text = systemText;
    if (text === undefined && takesText && (await canReadSilently())) text = (await readSystemText()).text;
    if (takesText && text && text.trim() && !sameText(text, c.text)) return t.pasteText(text);
    return t.paste(c);
  }
  const res = systemText !== undefined ? (systemText.trim() ? { text: systemText } : { error: 'empty' }) : await readSystemText();
  if (res.text) return t.pasteText(res.text);
  toast(res.error === 'empty' ? 'Nothing to paste.' : `LIFE/OS can’t read the clipboard here. Allow clipboard access for this site, or select the item and press ${KEYS.paste}.`, {
    duration: res.error === 'empty' ? 3800 : 7000,
  });
}

/** Run one action on a target (menu click, menu key, or a shortcut). */
async function run(t, action) {
  try {
    if (action === 'copy') {
      const text = takeCopy(t);
      if (text === null) return;
      toast('Copied');
      // Plain text too, for pasting outside LIFE/OS (best effort: the page may lack focus)
      navigator.clipboard?.writeText(text).catch(() => {});
    } else if (action === 'paste') {
      await pasteInto(t);
    } else if (action === 'delete') {
      await t.remove?.();
    } else if (action === 'duplicate') {
      await t.duplicate?.();
    } else if (action === 'edit') {
      await t.edit?.();
    } else if (action === 'rename') {
      await t.rename?.();
    }
  } catch (err) {
    console.error(`[contextmenu] ${action} failed`, err);
    toast('That didn’t work. Nothing was changed.');
  }
}

/* ==========================================================================
   The menu
   A menu is a stack of panels: the menu itself and, while one is open, the submenu of one of its
   items (and that one's, a level deeper). Each panel is { el, items, parent, parentItem, sub }.
   ========================================================================== */

let scope = null; // the element right-clicks are handled in (the shell's <main>)
let menu = null; // { el, root, target, providerId, returnTo, cleanup, contains(node) }
let swallowUntil = 0; // a keyboard open: ignore the browser's own contextmenu event right after

/** Run one of the module's own actions (closing the menu first, as the built-ins do). */
async function runAction(action) {
  try {
    await action.run?.();
  } catch (err) {
    console.error(`[contextmenu] "${action.id}" failed`, err);
    toast('That didn’t work. Nothing was changed.');
  }
}

/** One row of a panel: an icon, the label, a key hint or a ▸ for a submenu. */
function itemButton({ cls, label, iconName, kbd, keys, enabled, checked = null, sub = false }) {
  const role = checked === null ? 'menuitem' : 'menuitemradio';
  return h(
    'button',
    {
      type: 'button',
      role,
      class: ['ctx-item', cls, sub && 'ctx-item--sub', checked && 'is-checked'],
      tabindex: '-1',
      'aria-disabled': enabled ? null : 'true',
      'aria-checked': checked === null ? null : String(checked),
      'aria-haspopup': sub ? 'menu' : null,
      'aria-expanded': sub ? 'false' : null,
      'aria-keyshortcuts': keys ?? null,
    },
    h('span', { class: 'ctx-icon', 'aria-hidden': 'true' }, checked ? icon('check', { size: 14, stroke: 2 }) : iconName ? icon(iconName, { size: 15 }) : null),
    h('span', { class: 'ctx-label' }, label),
    sub
      ? h('span', { class: 'ctx-sub-mark', 'aria-hidden': 'true' }, icon('chevron-right', { size: 13 }))
      : kbd
        ? h('span', { class: 'kbd ctx-kbd lo-hint', 'aria-hidden': 'true' }, kbd)
        : null,
  );
}

/** A panel's element and items for a list of module actions (a submenu, or the menu's first group). */
function actionItems(actions, el) {
  const items = [];
  for (const a of actions) {
    if (a.separator) {
      el.append(h('div', { class: 'ctx-sep', role: 'separator' }));
      continue;
    }
    const btn = itemButton({ cls: 'ctx-item--own', label: a.label, iconName: a.icon, kbd: a.kbd, enabled: !a.disabled, checked: a.checked, sub: !!a.children });
    el.append(btn);
    items.push({ kind: 'own', action: a, label: a.label, enabled: !a.disabled, btn, children: a.children });
  }
  return items;
}

function openMenu(t, at, { keyboard = false } = {}) {
  closeMenu({ restore: false });
  const can = abilities(t);
  const returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const actions = normalizeActions(t.actions);
  // Color coding: a row of swatches before Delete (arrow keys reach them too)
  const color = t.color && document.documentElement.classList.contains(`cc-${t.color.kind}`) ? t.color : null;

  const el = h('div', {
    class: ['ctx-menu', 'hud', reducedMotion() && 'is-still'],
    role: 'menu',
    tabindex: '-1',
    'aria-label': t.label ? `Actions: ${t.label}` : 'Actions',
    'aria-orientation': 'vertical',
  });
  const items = [];
  // The module's own actions come first, one entry each (their own separators included): build
  // them together, then the rest of the entries after them
  const entries = menuEntries({ actions, can, colors: !!color });
  if (actions.length) items.push(...actionItems(actions, el));
  for (const entry of entries.slice(actions.length)) {
    if (entry.type === 'sep') {
      el.append(h('div', { class: 'ctx-sep', role: 'separator' }));
    } else if (entry.type === 'builtin') {
      const spec = BUILTINS[entry.id];
      const enabled = can[entry.id];
      const btn = itemButton({ cls: `ctx-item--${entry.id}`, label: spec.label, iconName: spec.icon, kbd: KEYS[entry.id], keys: ariaKeys(entry.id), enabled });
      btn.dataset.action = entry.id;
      el.append(btn);
      items.push({ kind: 'builtin', action: entry.id, label: spec.label, enabled, btn });
    } else if (entry.type === 'colors') {
      const picker = colorPicker({ value: color.value, label: 'Color', compact: true });
      const checked = picker.buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? picker.buttons[0];
      picker.buttons.forEach((btn) => {
        btn.setAttribute('role', 'menuitemradio');
        btn.tabIndex = -1;
        // ↑ ↓ treat the row as one stop (its picked swatch); ← → move along it (colorPicker)
        items.push({ kind: 'color', label: btn.title, enabled: true, stop: btn === checked, btn, color: btn.dataset.swatch === 'none' ? null : btn.dataset.swatch });
      });
      el.append(h('div', { class: 'ctx-colors', role: 'group', 'aria-label': 'Color' }, picker.el));
    }
  }
  const root = { el, items, parent: null, parentItem: null, sub: null };

  el.style.visibility = 'hidden';
  document.body.append(el);
  // Place it (measured while hidden, by layout size: the opening animation scales it): at the
  // pointer, flipped near the edges, inside the window
  const pos = menuPosition({ ...at, width: el.offsetWidth, height: el.offsetHeight, viewW: document.documentElement.clientWidth || window.innerWidth, viewH: document.documentElement.clientHeight || window.innerHeight });
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.classList.toggle('is-flip-x', pos.flipX);
  el.classList.toggle('is-flip-y', pos.flipY);
  el.style.visibility = '';

  const panels = () => {
    const out = [];
    for (let p = root; p; p = p.sub) out.push(p);
    return out;
  };
  const state = {
    el,
    root,
    target: t,
    providerId: t.providerId,
    returnTo,
    cleanup: null,
    contains: (node) => panels().some((p) => p.el.contains(node)),
    panels,
  };
  menu = state;

  let hoverTimer = 0;
  let hoverFor = null; // what the pending timer is for: an item (to open its submenu) or 'close'
  const clearHover = () => {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
  };
  const later = (fn, ms) => {
    clearHover();
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      fn();
    }, ms);
  };

  // Up / Down stop at each enabled item; the color row counts once (its picked swatch)
  const stops = (panel) => panel.items.map((it) => it.enabled && (it.kind !== 'color' || it.stop));
  const current = (panel) => panel.items.findIndex((it) => it.btn === document.activeElement);
  const focusItem = (it) => it?.btn.focus({ preventScroll: true });

  /** Close `panel`'s open submenu (and anything under it). */
  function closeSub(panel) {
    const sub = panel.sub;
    if (!sub) return;
    closeSub(sub);
    panel.sub = null;
    sub.el.remove();
    sub.parentItem.btn.setAttribute('aria-expanded', 'false');
    sub.parentItem.btn.removeAttribute('aria-controls');
    sub.parentItem.btn.classList.remove('is-open');
  }

  /** Open the submenu of `item` (in `panel`); `focus`: onto its first item (keyboard, a tap). */
  function openSub(panel, item, { focus = false } = {}) {
    if (!item?.enabled || !item.children) return;
    if (panel.sub?.parentItem === item) {
      if (focus) focusItem(panel.sub.items[stepIndex(stops(panel.sub), -1, 'Home')]);
      return;
    }
    closeSub(panel);
    const id = `ctx-sub-${uid()}`;
    const subEl = h('div', {
      class: ['ctx-menu', 'ctx-submenu', 'hud', 'is-still'],
      id,
      role: 'menu',
      tabindex: '-1',
      'aria-label': item.label,
      'aria-orientation': 'vertical',
    });
    const sub = { el: subEl, items: actionItems(item.children, subEl), parent: panel, parentItem: item, sub: null };
    item.btn.setAttribute('aria-expanded', 'true');
    item.btn.setAttribute('aria-controls', id);
    item.btn.classList.add('is-open');
    subEl.style.visibility = 'hidden';
    document.body.append(subEl);
    const r = item.btn.getBoundingClientRect();
    const m = panel.el.getBoundingClientRect();
    const p = submenuPosition({
      item: { top: r.top, bottom: r.bottom },
      menu: { left: m.left, right: m.right },
      width: subEl.offsetWidth,
      height: subEl.offsetHeight,
      viewW: document.documentElement.clientWidth || window.innerWidth,
      viewH: document.documentElement.clientHeight || window.innerHeight,
      pad: parseFloat(getComputedStyle(subEl).paddingTop) || 4,
    });
    subEl.style.left = `${p.left}px`;
    subEl.style.top = `${p.top}px`;
    subEl.style.visibility = '';
    panel.sub = sub;
    wire(sub);
    if (focus) focusItem(sub.items[stepIndex(stops(sub), -1, 'Home')]);
  }

  function activate(panel, it) {
    if (!it?.enabled) return;
    if (it.children) {
      openSub(panel, it, { focus: true });
      return;
    }
    const target = state.target;
    closeMenu();
    if (it.kind === 'color') {
      try {
        target.color.set(it.color);
      } catch (err) {
        console.error('[contextmenu] color failed', err);
        toast('That didn’t work. Nothing was changed.');
      }
    } else if (it.kind === 'own') {
      runAction(it.action);
    } else {
      run(target, it.action);
    }
  }

  /** Back from a submenu to the item that opened it. */
  function backTo(panel) {
    const parent = panel.parent;
    if (!parent) return false;
    const item = panel.parentItem;
    closeSub(parent);
    focusItem(item);
    return true;
  }

  function onKeydown(panel, e) {
    // Everything typed while the menu is open is the menu's: no page shortcut fires behind it
    e.stopPropagation();
    if (e.isComposing) return;
    const at = current(panel);
    const onSwatch = panel.items[at]?.kind === 'color';
    // The swatch row moves with ← → Home End itself (colorPicker); ↑ ↓ leave it
    if (onSwatch && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      // From inside the color row, step from its stop
      const from = onSwatch ? panel.items.findIndex((it) => it.kind === 'color' && it.stop) : at;
      const nav = stepIndex(stops(panel), from, e.key);
      if (nav >= 0) focusItem(panel.items[nav]);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (panel.items[at]?.children) openSub(panel, panel.items[at], { focus: true });
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      backTo(panel);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!backTo(panel)) closeMenu();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(panel, panel.items[at]);
      return;
    }
    if (isMenuKey(e)) {
      e.preventDefault();
      return;
    }
    // ⌘C · ⌘V · ⌘D · Delete: the built-ins, from the menu itself (not from a submenu)
    const shortcut = panel === root ? actionForKey(e, IS_MAC) : null;
    if (shortcut) {
      e.preventDefault();
      activate(panel, panel.items.find((it) => it.kind === 'builtin' && it.action === shortcut));
      return;
    }
    // Typeahead: the first enabled item whose label starts with the letter (repeats cycle)
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const n = panel.items.length;
      for (let step = 1; step <= n; step++) {
        const it = panel.items[(at + step + n) % n];
        if (it.enabled && it.kind !== 'color' && it.label.toLowerCase().startsWith(ch)) {
          e.preventDefault();
          focusItem(it);
          return;
        }
      }
    }
  }

  /** Keys, clicks and the pointer for one panel. */
  function wire(panel) {
    const find = (target) => {
      const btn = target.closest?.('.ctx-item, .cc-swatch');
      return btn ? panel.items.find((x) => x.btn === btn) : null;
    };
    panel.el.addEventListener('keydown', (e) => onKeydown(panel, e));
    panel.el.addEventListener('click', (e) => {
      const it = find(e.target);
      if (!it) return;
      clearHover();
      // A tap on an open submenu's item closes it again
      if (it.children && panel.sub?.parentItem === it) closeSub(panel);
      else activate(panel, it);
    });
    // The pointer and the keyboard share one highlight: hovering an item focuses it. Resting on an
    // item with a submenu opens it; resting on another closes the open one.
    panel.el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const it = find(e.target);
      if (it?.enabled && document.activeElement !== it.btn) focusItem(it);
      else if (it && !it.enabled && document.activeElement !== panel.el) panel.el.focus({ preventScroll: true });
      if (!it) return;
      if (it.children && panel.sub?.parentItem !== it) {
        if (hoverFor !== it) later(() => openSub(panel, it), HOVER_OPEN_MS);
        hoverFor = it;
      } else if (!it.children && panel.sub) {
        if (hoverFor !== 'close') later(() => closeSub(panel), HOVER_CLOSE_MS);
        hoverFor = 'close';
      } else {
        clearHover();
        hoverFor = null;
      }
    });
    panel.el.addEventListener('pointerenter', () => {
      // Arrived in the submenu: keep it open
      if (panel.parent) {
        clearHover();
        hoverFor = null;
      }
    });
    panel.el.addEventListener('pointerleave', (e) => {
      if (panel.el.contains(document.activeElement) && document.activeElement !== panel.el && !state.contains(e.relatedTarget)) panel.el.focus({ preventScroll: true });
    });
    panel.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  wire(root);

  // Close on a press outside, scroll, resize, leaving the window or the page
  const onPointerDown = (e) => {
    if (!state.contains(e.target)) closeMenu({ restore: false });
  };
  // A scroll event already on its way when the menu opened (the frame after a wheel or a
  // scrollIntoView) is not a reason to close it
  const openedAt = performance.now();
  const onScroll = (e) => {
    if (!state.contains(e.target) && performance.now() - openedAt > 150) closeMenu({ restore: false });
  };
  const onResize = () => closeMenu({ restore: false });
  const onBlur = () => closeMenu({ restore: false });
  const onRoute = () => closeMenu({ restore: false });
  const onFocusIn = (e) => {
    if (!state.contains(e.target)) closeMenu({ restore: false });
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onBlur);
  window.addEventListener('hashchange', onRoute);
  window.addEventListener('lifeos:skin', onRoute);
  document.addEventListener('focusin', onFocusIn);
  state.cleanup = () => {
    clearHover();
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('hashchange', onRoute);
    window.removeEventListener('lifeos:skin', onRoute);
    document.removeEventListener('focusin', onFocusIn);
  };

  // Keyboard: straight onto the first action. Pointer: the menu itself (arrows start from there)
  const first = stepIndex(stops(root), -1, 'Home');
  if (keyboard && first >= 0) focusItem(items[first]);
  else el.focus({ preventScroll: true });
}

/** Close the open menu. `restore`: focus goes back where it was (Esc, an action). */
function closeMenu({ restore = true } = {}) {
  const m = menu;
  if (!m) return;
  menu = null;
  m.cleanup?.();
  const panels = m.panels();
  const hadFocus = panels.some((p) => p.el.contains(document.activeElement));
  panels.forEach((p) => p.el.remove());
  if (restore || hadFocus) {
    const back = m.returnTo?.isConnected ? m.returnTo : m.target.el?.isConnected && m.target.el.tabIndex >= 0 ? m.target.el : null;
    if (back && (restore || document.activeElement === document.body)) back.focus({ preventScroll: true });
  }
}

function ariaKeys(action) {
  const mod = IS_MAC ? 'Meta' : 'Control';
  return { copy: `${mod}+C`, paste: `${mod}+V`, delete: 'Delete', duplicate: `${mod}+D` }[action];
}

/* ==========================================================================
   Wiring: right-click, the menu keys, and the same actions as shortcuts
   ========================================================================== */

/** True where the browser's own menu is more useful: text fields, links, selected text. */
function wantsNativeMenu(el, x, y) {
  if (el.closest(NATIVE)) return true;
  const sel = document.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of sel.getRangeAt(i).getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
  }
  return false;
}

/** The point a keyboard-opened menu hangs from: below the item's start, flipping above it. */
function anchorOf(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(16, r.width / 2);
  return { x, y: r.bottom + 2, altX: r.right, altY: r.top - 2 };
}

/** The item keyboard focus is on (inside the page), as a target. */
function focusedTarget() {
  const el = document.activeElement;
  if (!(el instanceof Element) || !scope?.contains(el) || el.closest(NATIVE)) return null;
  return resolveTarget(el, { keyboard: true });
}

function onContextMenu(e) {
  if (menu?.contains(e.target)) return;
  // A page claimed this press for itself (the Notes board lifting a card by a long press)
  if (e.defaultPrevented) return;
  if (performance.now() < swallowUntil) {
    e.preventDefault();
    return;
  }
  const el = e.target instanceof Element ? e.target : e.target?.parentElement;
  if (!el || !scope?.contains(el) || modalOpen() || wantsNativeMenu(el, e.clientX, e.clientY)) {
    closeMenu({ restore: false });
    return;
  }
  // Some browsers send the ContextMenu key as a contextmenu event at (0, 0): anchor to the item
  const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
  const t = resolveTarget(el, { x: e.clientX, y: e.clientY, keyboard });
  if (!t) {
    closeMenu({ restore: false });
    return;
  }
  e.preventDefault();
  openMenu(t, keyboard ? anchorOf(t.el ?? el) : { x: e.clientX, y: e.clientY }, { keyboard });
}

function onKeydown(e) {
  if (menu || modalOpen()) return;
  if (isMenuKey(e)) {
    if (isTyping(e)) return;
    const t = focusedTarget();
    if (!t) return;
    e.preventDefault();
    swallowUntil = performance.now() + 400;
    openMenu(t, anchorOf(document.activeElement), { keyboard: true });
    return;
  }
  // ⌘/Ctrl + D and Delete / Backspace on a focused item (a module that handles the key itself,
  // like Tasks' Delete, has already called preventDefault). Copy / paste use the clipboard events.
  if (e.defaultPrevented || e.repeat || isTyping(e)) return;
  const action = actionForKey(e, IS_MAC);
  if (action !== 'duplicate' && action !== 'delete') return;
  const t = focusedTarget();
  if (!t?.kind || !abilities(t)[action]) return;
  e.preventDefault();
  run(t, action);
}

/** True when text is selected on the page: ⌘C then copies that text, as usual. */
function hasTextSelection() {
  const sel = document.getSelection?.();
  return !!sel && !sel.isCollapsed && String(sel).trim() !== '';
}

/** True when a text field has a selection: ⌘C / ⌘X there copies text. */
function fieldSelection() {
  const el = document.activeElement;
  try {
    return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.selectionStart !== el.selectionEnd;
  } catch {
    return false; // input types without a selection API
  }
}

function onCopy(e) {
  if (e.defaultPrevented || modalOpen()) return;
  if (isTyping(e) || hasTextSelection() || document.activeElement?.closest?.(NATIVE)) {
    // A text copy replaces what is on the clipboard: an older in-app copy must not paste over it
    if (hasTextSelection() || fieldSelection()) setClip(null);
    return;
  }
  const t = focusedTarget();
  if (!t?.kind || !abilities(t).copy) return;
  const text = takeCopy(t);
  if (text === null) return;
  e.preventDefault();
  e.clipboardData?.setData('text/plain', text);
  toast('Copied');
}

function onCut(e) {
  if (!e.defaultPrevented && (hasTextSelection() || fieldSelection())) setClip(null);
}

function onPaste(e) {
  if (e.defaultPrevented || modalOpen() || isTyping(e) || document.activeElement?.closest?.(NATIVE)) return;
  const t = focusedTarget() ?? blankTarget();
  if (!t || !abilities(t).paste) return;
  e.preventDefault();
  pasteInto(t, e.clipboardData?.getData('text/plain') ?? '').catch((err) => console.error('[contextmenu] paste failed', err));
}

/** With focus on the page itself (nothing focused), ⌘V pastes into the open module's blank area. */
function blankTarget() {
  const active = document.activeElement;
  if (active && active !== document.body) return null;
  const view = scope?.firstElementChild;
  return view ? resolveTarget(view, { keyboard: true }) : null;
}

/* ---- iPhone and iPad: a long press opens the menu ----
   iOS sends no contextmenu event for a long press (Android does). After a still press we send one
   ourselves, so the same code runs as on Android: a page that claims the press cancels it (the
   Notes board lifting a card), anything else opens this menu. The click iOS sends when the finger
   lifts is swallowed, so it neither opens the item under it nor picks the menu entry under it.
   window.LIFEOS_LONGPRESS = true turns this on in other browsers, for testing with touch events. */

const IOS = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const LONG_PRESS_MS = 520;
const LONG_PRESS_SLOP = 10; // px the finger may wander and still count as still
let press = null; // { id, x, y, el, timer, fired }
let swallowClickUntil = 0;

function onTouchDown(e) {
  if (e.pointerType !== 'touch' || !e.isPrimary || !(IOS || window.LIFEOS_LONGPRESS)) return;
  const el = e.target instanceof Element ? e.target : null;
  cancelPress();
  if (!el || !scope?.contains(el) || el.closest(NATIVE) || menu || modalOpen()) return;
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, el, fired: false, timer: setTimeout(firePress, LONG_PRESS_MS) };
}

function onTouchMove(e) {
  if (press && !press.fired && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP) cancelPress();
}

function onTouchUp(e) {
  if (!press || e.pointerId !== press.id) return;
  if (press.fired) swallowClickUntil = performance.now() + 450;
  cancelPress();
}

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function firePress() {
  const p = press;
  if (!p || !p.el.isConnected) return;
  p.fired = true;
  p.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 2, view: window }));
  // The menu is open: drop the word iOS selected under the finger
  if (menu) window.getSelection?.()?.removeAllRanges();
}

function onClickAfterPress(e) {
  if (!swallowClickUntil) return;
  const now = performance.now();
  if (now < swallowClickUntil) {
    e.preventDefault();
    e.stopPropagation();
  }
  swallowClickUntil = 0;
}

/** Install the menu for right-clicks inside `root` (the shell's <main>). Once. */
export function installContextMenu(root) {
  if (scope) return;
  scope = root;
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerdown', onTouchDown, true);
  document.addEventListener('pointermove', onTouchMove, true);
  document.addEventListener('pointerup', onTouchUp, true);
  document.addEventListener('pointercancel', onTouchUp, true);
  window.addEventListener('scroll', cancelPress, true);
  window.addEventListener('click', onClickAfterPress, true);
  // Bubble phase on window: every module's own key handler has run (and maybe claimed the key)
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
}

