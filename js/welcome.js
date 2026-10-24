// LIFE/OS — the welcome sheet. The first time LIFE/OS opens on a device with nothing saved, it
// shows every page in a line (what LIFE/OS can do) with a tick for the ones the phone's tab bar
// shows. Settings → About → Welcome opens it again. app.js decides when (shell.js welcomeOnStart);
// the rules it uses (PAGE_INTROS, normalizeTabs, toggleTab) are in js/shell.js. Styles:
// css/shell.css (.wl-*). A dialog: a sheet from the bottom on a phone (css/components.css).

import { h, openModal, checkButton, iconBadge, uid } from './ui.js';
import { settings } from './store.js';
import { normalizeTabs, toggleTab, PAGE_INTROS } from './shell.js';

/** "Home, Tasks and More" */
const listWords = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

// Wider than a phone: the sidebar shows and lists every page (css/shell.css, 640px)
const wideQuery = matchMedia('(min-width: 641px)');

/**
 * Open the welcome sheet. pages: the nav's pages [{ id, title, icon }] (not Settings, not ideas);
 * again: opened from Settings (the main button says Done, and nothing changes unless it is
 * pressed). Its words follow the window: where the sidebar shows (a computer), the tab bar only
 * matters in a narrow window.
 * Start (or Done) saves the ticked pages as settings.tabs, in the order ticked; Skip, Esc or ✕ keep
 * the tab bar as it is. Either answer sets settings.welcomed. onClose({ saved, keyboard }) after.
 */
export function openWelcome({ pages = [], again = false, onClose } = {}) {
  const ids = pages.map((p) => p.id);
  let tabs = normalizeTabs(settings.get().tabs, ids);
  let saved = false;
  const howId = `wl-${uid()}`;
  const barLine = h('p', { class: 'wl-bar', role: 'status' });
  const howLine = h('p', { class: 'wl-how', id: howId });
  const laterLine = h('p', { class: 'wl-later' });
  const note = h('span', { class: 'wl-note' });

  const checks = new Map();
  const rows = pages.map((p) => {
    const descId = `wl-${uid()}`;
    const check = checkButton({ checked: tabs.includes(p.id), label: p.title, onToggle: () => pick(p.id) });
    check.setAttribute('aria-describedby', descId);
    checks.set(p.id, check);
    const intro = PAGE_INTROS[p.id];
    return h(
      'li',
      // The whole row ticks (the check is the keyboard's way in)
      { class: 'wl-page', dataset: { id: p.id }, onClick: (e) => check.contains(e.target) || pick(p.id) },
      iconBadge(p.icon, { tone: p.id, size: 18, box: 36, className: 'wl-page-ib' }),
      h('span', { class: 'wl-page-text' }, h('span', { class: 'wl-page-name' }, p.title), intro ? h('span', { class: 'wl-page-desc', id: descId }, intro) : null),
      check,
    );
  });

  const paint = () => {
    for (const row of rows) {
      const on = tabs.includes(row.dataset.id);
      row.classList.toggle('is-on', on);
      checks.get(row.dataset.id).setAttribute('aria-checked', String(on));
    }
    const wide = wideQuery.matches;
    const names = tabs.map((id) => pages.find((p) => p.id === id)?.title).filter(Boolean);
    barLine.replaceChildren(h('span', { class: 'wl-bar-head' }, wide ? 'Tab bar in a narrow window: ' : 'Your tab bar: '), `${listWords([...names, 'More'])}.`, ' ', note);
    howLine.textContent = wide
      ? 'The menu on the left always lists every page. Tick the ones for the tab bar, which shows when the window is as narrow as a phone; the rest go in More there.'
      : 'Tick the pages you want in the tab bar at the bottom. The rest are always one tap away in More.';
    laterLine.textContent = wide ? 'Change it any time in Settings → About, or in More → Edit tabs.' : 'Change it any time in More → Edit tabs.';
  };

  const pick = (id) => {
    const res = toggleTab(tabs, id, ids);
    note.textContent = res.reason === 'last' ? 'It keeps at least one page.' : '';
    if (!res.changed) return;
    tabs = res.tabs;
    paint();
  };

  // Closed from the keyboard (Enter on a button, Esc) or not: the caller may hand the focus on.
  // Heard before the dialog's own Esc handler (registered first, on the same capture phase).
  let keyboard = false;
  const onKey = () => (keyboard = true);
  const onPointer = () => (keyboard = false);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);

  const footer = [
    h('button', { type: 'button', class: 'btn btn--ghost wl-skip', onClick: () => m.close() }, again ? 'Cancel' : 'Skip'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary wl-start',
        onClick: () => {
          saved = true;
          m.close();
        },
      },
      again ? 'Done' : 'Start',
    ),
  ];

  const m = openModal({
    title: 'Welcome to LIFE/OS',
    className: 'welcome-sheet',
    body: [
      h('p', { class: 'wl-lead' }, 'Your day in one place: plan, write, track and focus. Here’s what each page does.'),
      howLine,
      h('ul', { class: 'wl-pages', 'aria-labelledby': howId }, rows),
      barLine,
      laterLine,
    ],
    footer,
    initialFocus: checks.get(ids[0]) ?? null,
    onClose: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      wideQuery.removeEventListener?.('change', paint);
      if (saved) settings.update({ tabs, welcomed: true });
      else if (settings.get().welcomed !== true) settings.update({ welcomed: true });
      onClose?.({ saved, keyboard });
    },
  });
  paint();
  // A window made narrow or wide while it's open: the words follow
  wideQuery.addEventListener?.('change', paint);
  return m;
}
