// LIFE/OS — the first run: "Welcome to LIFE/OS". The first time LIFE/OS opens on a device with
// nothing saved, a short sheet offers three ways in: No tutorial (straight in), Quick tutorial
// (about a minute) or Tutorial (every page). app.js decides when (shell.js welcomeOnStart) and
// starts the tour picked (js/tour.js); the choices' words are WELCOME_CHOICES in js/tour.logic.js.
// Also the tab picker: every page in a line with a tick for the phone's tab bar, one of the
// tours' steps (its rules, PAGE_INTROS, normalizeTabs and toggleTab, are in js/shell.js).
// Styles: css/shell.css (.wl-*). The sheet is a dialog: from the bottom on a phone.

import { h, icon, openModal, checkButton, iconBadge, registerIcon, uid } from './ui.js';
import { settings } from './store.js';
import { normalizeTabs, toggleTab, PAGE_INTROS } from './shell.js';
import { WELCOME_CHOICES } from './tour.logic.js';

// The three ways in: straight in (an arrow), quick (a stopwatch), the whole tour (a map)
registerIcon('wl-go', '<path d="M4 12h15M13 6l6 6-6 6"/>');
registerIcon('wl-quick', '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5 15 10.5M10 2.5h4M12 2.5V6"/>');
registerIcon('wl-map', '<path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5Z"/><path d="M9 4v13.5M15 6.5V20"/>');

/** "Home, Tasks and More" */
const listWords = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

// Wider than a phone: the sidebar shows and lists every page (css/shell.css, 640px)
const wideQuery = matchMedia('(min-width: 641px)');

/**
 * Open the welcome sheet: three big choices, each with a line on what you get and how long it
 * takes. Picking one closes it; Esc and ✕ are No tutorial. Either way settings.welcomed is set.
 * onChoose({ choice: 'none' | 'quick' | 'full', keyboard }) after it has closed (keyboard: it was
 * answered from the keyboard, so the caller hands the focus on).
 */
export function openWelcome({ onChoose } = {}) {
  let choice = 'none';
  const leadId = `wl-${uid()}`;

  // Closed from the keyboard (Enter on a choice, Esc) or not: the caller may hand the focus on.
  // Heard before the dialog's own Esc handler (registered first, on the same capture phase).
  let keyboard = false;
  const onKey = () => (keyboard = true);
  const onPointer = () => (keyboard = false);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);

  const options = WELCOME_CHOICES.map((c) => {
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
  // ↑ ↓ move between the three as well as Tab
  const onArrow = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const at = options.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    options[(at + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus();
  };

  const m = openModal({
    title: 'Welcome to LIFE/OS',
    className: 'welcome-sheet wl-choice',
    body: [
      h('p', { class: 'wl-lead', id: leadId }, 'Your day in one place: plan, write, track and focus. How would you like to start?'),
      h('div', { class: 'wl-options', role: 'group', 'aria-labelledby': leadId, onKeydown: onArrow }, options),
    ],
    initialFocus: options[0],
    onClose: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      if (settings.get().welcomed !== true) settings.update({ welcomed: true });
      onChoose?.({ choice, keyboard });
    },
  });
  return m;
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
