// LIFE/OS — the right-click menu: Copy · Paste · Delete · Duplicate, for every module.
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
//     can: { copy, paste, delete, duplicate }             // false greys out an action it has
//   }
//
// Providers are asked newest first; the first target wins. Every mutation stays in the module
// (its store helpers, normalization, Undo toast): this file only routes the action and keeps the
// in-app clipboard ({ kind, snapshot, text } in memory and sessionStorage, so it survives a
// route change), plus the plain text on the system clipboard.

import { h, icon, registerIcon, toast, isTyping, modalOpen, reducedMotion } from './ui.js';
import { menuPosition, stepIndex, shortcutLabels, actionForKey, isMenuKey, makeClip, readClip, pasteMode, sameText } from './contextmenu.logic.js';

registerIcon('ctx-copy', '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>');
registerIcon('ctx-paste', '<path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 13h6M9 17h4"/>');
registerIcon('ctx-duplicate', '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11M14.5 11.5v6M11.5 14.5h6"/>');

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
const KEYS = shortcutLabels(IS_MAC);
const ITEMS = Object.freeze([
  { action: 'copy', label: 'Copy', icon: 'ctx-copy' },
  { action: 'paste', label: 'Paste', icon: 'ctx-paste' },
  { action: 'delete', label: 'Delete', icon: 'trash' },
  { action: 'duplicate', label: 'Duplicate', icon: 'ctx-duplicate' },
]);
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
    }
  } catch (err) {
    console.error(`[contextmenu] ${action} failed`, err);
    toast('That didn’t work. Nothing was changed.');
  }
}

/* ==========================================================================
   The menu
   ========================================================================== */

let scope = null; // the element right-clicks are handled in (the shell's <main>)
let menu = null; // { el, items, target, providerId, returnTo, cleanup }
let swallowUntil = 0; // a keyboard open: ignore the browser's own contextmenu event right after


function openMenu(t, at, { keyboard = false } = {}) {
  closeMenu({ restore: false });
  const can = abilities(t);
  const returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

  const items = ITEMS.map((spec) => {
    const enabled = can[spec.action];
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: ['ctx-item', `ctx-item--${spec.action}`],
        tabindex: '-1',
        'aria-disabled': enabled ? null : 'true',
        'aria-keyshortcuts': ariaKeys(spec.action),
        dataset: { action: spec.action },
      },
      h('span', { class: 'ctx-icon', 'aria-hidden': 'true' }, icon(spec.icon, { size: 15 })),
      h('span', { class: 'ctx-label' }, spec.label),
      h('span', { class: 'kbd ctx-kbd lo-hint', 'aria-hidden': 'true' }, KEYS[spec.action]),
    );
    return { ...spec, enabled, btn };
  });

  const el = h('div', {
    class: ['ctx-menu', 'hud', reducedMotion() && 'is-still'],
    role: 'menu',
    tabindex: '-1',
    'aria-label': t.label ? `Actions: ${t.label}` : 'Actions',
    'aria-orientation': 'vertical',
  });
  el.append(...items.map((it) => it.btn));
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

  const state = { el, items, target: t, providerId: t.providerId, returnTo, cleanup: null };
  menu = state;

  const focusAt = (i) => {
    const it = items[i];
    if (it) it.btn.focus({ preventScroll: true });
  };
  const current = () => items.findIndex((it) => it.btn === document.activeElement);

  function activate(it) {
    if (!it?.enabled) return;
    const target = state.target;
    closeMenu();
    run(target, it.action);
  }

  function onKeydown(e) {
    // Everything typed while the menu is open is the menu's: no page shortcut fires behind it
    e.stopPropagation();
    if (e.isComposing) return;
    const nav = stepIndex(
      items.map((it) => it.enabled),
      current(),
      e.key,
    );
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      if (nav >= 0) focusAt(nav);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(items[current()]);
      return;
    }
    if (isMenuKey(e)) {
      e.preventDefault();
      return;
    }
    const shortcut = actionForKey(e, IS_MAC);
    if (shortcut) {
      e.preventDefault();
      activate(items.find((it) => it.action === shortcut));
      return;
    }
    // Typeahead: the first enabled item whose label starts with the letter (repeats cycle)
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const from = current();
      for (let step = 1; step <= items.length; step++) {
        const it = items[(from + step + items.length) % items.length];
        if (it.enabled && it.label.toLowerCase().startsWith(ch)) {
          e.preventDefault();
          it.btn.focus({ preventScroll: true });
          return;
        }
      }
    }
  }

  el.addEventListener('keydown', onKeydown);
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.ctx-item');
    const it = btn && items.find((x) => x.btn === btn);
    if (it) activate(it);
  });
  // The pointer and the keyboard share one highlight: hovering an item focuses it
  el.addEventListener('pointermove', (e) => {
    const btn = e.target.closest('.ctx-item');
    const it = btn && items.find((x) => x.btn === btn);
    if (it?.enabled && document.activeElement !== btn) btn.focus({ preventScroll: true });
    else if (it && !it.enabled && document.activeElement !== el) el.focus({ preventScroll: true });
  });
  el.addEventListener('pointerleave', () => {
    if (el.contains(document.activeElement) && document.activeElement !== el) el.focus({ preventScroll: true });
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  // Close on a press outside, scroll, resize, leaving the window or the page
  const onPointerDown = (e) => {
    if (!el.contains(e.target)) closeMenu({ restore: false });
  };
  // A scroll event already on its way when the menu opened (the frame after a wheel or a
  // scrollIntoView) is not a reason to close it
  const openedAt = performance.now();
  const onScroll = (e) => {
    if (!el.contains(e.target) && performance.now() - openedAt > 150) closeMenu({ restore: false });
  };
  const onResize = () => closeMenu({ restore: false });
  const onBlur = () => closeMenu({ restore: false });
  const onRoute = () => closeMenu({ restore: false });
  const onFocusIn = (e) => {
    if (!el.contains(e.target)) closeMenu({ restore: false });
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onBlur);
  window.addEventListener('hashchange', onRoute);
  window.addEventListener('lifeos:skin', onRoute);
  document.addEventListener('focusin', onFocusIn);
  state.cleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('hashchange', onRoute);
    window.removeEventListener('lifeos:skin', onRoute);
    document.removeEventListener('focusin', onFocusIn);
  };

  // Keyboard: straight onto the first action. Pointer: the menu itself (arrows start from there)
  const first = stepIndex(
    items.map((it) => it.enabled),
    -1,
    'Home',
  );
  if (keyboard && first >= 0) focusAt(first);
  else el.focus({ preventScroll: true });
}

/** Close the open menu. `restore`: focus goes back where it was (Esc, an action). */
function closeMenu({ restore = true } = {}) {
  const m = menu;
  if (!m) return;
  menu = null;
  m.cleanup?.();
  const hadFocus = m.el.contains(document.activeElement);
  m.el.remove();
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
  if (menu?.el.contains(e.target)) return;
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

/** Install the menu for right-clicks inside `root` (the shell's <main>). Once. */
export function installContextMenu(root) {
  if (scope) return;
  scope = root;
  document.addEventListener('contextmenu', onContextMenu);
  // Bubble phase on window: every module's own key handler has run (and maybe claimed the key)
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
}

