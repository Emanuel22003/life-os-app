// LIFE/OS — Appearance picker: four templates (skins) as live mini previews, plus light/dark.
//
// Each preview is a tiny page built from the shared kit (pageHeader, .panel .hud, .check, .tag,
// .btn, .seg) inside its own shadow root with the app's shared stylesheets and every skin file,
// under <div data-skin="<id>" data-theme="<mode>">. The shadow boundary keeps the page's active
// skin rules ([data-skin="brutalist"] .btn …) from reaching the other previews, so every skin
// is written with plain ancestor selectors and still renders correctly in its own card.

import { h, icon, registerIcon, openModal, pageHeader, uid } from './ui.js';
import { settings } from './store.js';
import { SKINS, SKIN_BOOT, normalizeSkin, THEMES, resolveTheme } from './skins.js';

registerIcon('monitor', '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>');

const PREVIEW_W = 400; // design width of a preview page; cards scale it to fit

/** Add a skin's Google Fonts stylesheet once (offline, the system fallbacks in its tokens apply). */
export function loadSkinFonts(id) {
  const href = SKIN_BOOT[id]?.font;
  if (!href || document.head.querySelector(`link[data-skin-font="${id}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href, dataset: { skinFont: id } }));
}

// The page's own app stylesheets minus the feature ones: tokens, base, shell, components, the
// picker's and every skin file. Read from index.html so a new skin file is picked up by itself.
function previewSheets() {
  return [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((link) => link.href)
    .filter((href) => {
      try {
        const url = new URL(href);
        return url.origin === location.origin && !url.pathname.includes('/css/features/');
      } catch {
        return false;
      }
    });
}

function previewCheck(checked) {
  return h('span', { class: 'check', 'aria-checked': String(checked) }, icon('check', { size: 13, stroke: 2.5 }));
}

// What every template has to show off: a page title, a list with a done and an open item,
// a tag, a primary button and a segmented filter
function previewPage() {
  return h(
    'div',
    { class: 'skin-preview lo-page' },
    pageHeader({ index: '01', title: 'Tasks' }),
    h(
      'div',
      { class: 'panel hud skin-preview-list' },
      h('div', { class: 'skin-preview-row is-done' }, previewCheck(true), h('span', { class: 'skin-preview-text' }, 'Morning run'), h('span', { class: 'tag tag--solid' }, 'Done')),
      h('div', { class: 'skin-preview-row' }, previewCheck(false), h('span', { class: 'skin-preview-text' }, 'Call the dentist'), h('span', { class: 'tag' }, 'Today')),
    ),
    h(
      'div',
      { class: 'skin-preview-actions' },
      h('span', { class: 'btn btn--primary btn--sm' }, icon('plus', { size: 14 }), 'Add task'),
      h('span', { class: 'seg' }, h('span', { class: 'seg-btn', 'aria-pressed': 'true' }, 'All'), h('span', { class: 'seg-btn' }, 'Today'), h('span', { class: 'seg-btn' }, 'Done')),
    ),
  );
}

function buildPreview(id, theme, sheets) {
  // Decorative and out of reach: the card around it is the control
  const host = h('div', { class: 'skin-card-preview', 'aria-hidden': 'true', inert: true });
  const shadow = host.attachShadow({ mode: 'open' });
  const scope = h('div', { class: 'skin-scope', dataset: { skin: id, theme } }, previewPage());
  let pending = sheets.length;
  const settle = () => {
    pending -= 1;
    if (pending <= 0) host.classList.add('is-ready');
  };
  const links = sheets.map((href) => h('link', { rel: 'stylesheet', href, onLoad: settle, onError: settle }));
  shadow.append(...links, scope);
  if (!sheets.length) host.classList.add('is-ready');
  // Scale the fixed-size page to the card's width
  const fit = () => {
    const w = host.clientWidth;
    if (w) scope.style.zoom = String(w / PREVIEW_W);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(host);
  return { host, scope, disconnect: () => observer.disconnect() };
}

/**
 * openAppearance({ onClose }) — the Appearance dialog. A template or mode applies (and is saved)
 * the moment it is picked; settings changes from elsewhere (quick toggle, other tabs) show here too.
 */
export function openAppearance({ onClose } = {}) {
  const sheets = previewSheets();
  // Every preview needs its own typefaces
  SKINS.forEach((s) => loadSkinFonts(s.id));

  const current = () => normalizeSkin(settings.get().skin);
  // The saved mode ('system' too) for the buttons; what it resolves to for the previews
  const mode = () => (THEMES.includes(settings.get().theme) ? settings.get().theme : 'dark');
  const shownMode = () => resolveTheme(settings.get().theme, globalThis.matchMedia?.('(prefers-color-scheme: light)').matches);
  const choose = (id) => {
    if (current() !== id) settings.update({ skin: id });
  };

  const previews = [];
  const cards = SKINS.map((s) => {
    const preview = buildPreview(s.id, shownMode(), sheets);
    previews.push(preview);
    const nameId = `skin-name-${uid()}`;
    const descId = `skin-desc-${uid()}`;
    return h(
      'div',
      {
        class: 'skin-card',
        role: 'radio',
        'aria-checked': 'false',
        'aria-labelledby': nameId,
        'aria-describedby': descId,
        tabindex: '-1',
        dataset: { skinId: s.id },
        onClick: () => choose(s.id),
      },
      preview.host,
      h(
        'div',
        { class: 'skin-card-text' },
        h('span', { class: 'skin-card-name', id: nameId }, s.name),
        h('span', { class: 'skin-card-desc', id: descId }, s.description),
      ),
      h('span', { class: 'skin-card-mark', 'aria-hidden': 'true' }, icon('check', { size: 14, stroke: 2.5 })),
    );
  });

  // Radio group: arrows move the choice (and focus), Space/Enter picks the focused card
  const onGroupKey = (e) => {
    const at = cards.indexOf(document.activeElement);
    if (at === -1) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % cards.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + cards.length) % cards.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = cards.length - 1;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      choose(cards[at].dataset.skinId);
      return;
    } else return;
    e.preventDefault();
    choose(cards[next].dataset.skinId);
    cards[next].focus();
  };
  const group = h('div', { class: 'skin-grid', role: 'radiogroup', 'aria-label': 'Template', onKeydown: onGroupKey }, cards);

  const MODE_LOOK = { light: ['sun', 'Light'], dark: ['moon', 'Dark'], system: ['monitor', 'System'] };
  const modeButtons = THEMES.map((m) =>
    h(
      'button',
      { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { mode: m }, title: m === 'system' ? 'Follow the computer’s light or dark mode' : null, onClick: () => settings.update({ theme: m }) },
      icon(MODE_LOOK[m][0], { size: 14 }),
      MODE_LOOK[m][1],
    ),
  );
  const modeLabelId = `appearance-mode-${uid()}`;
  const modeRow = h(
    'div',
    { class: 'appearance-mode' },
    h('span', { class: 'label', id: modeLabelId }, 'Mode'),
    h('div', { class: 'seg', role: 'group', 'aria-labelledby': modeLabelId }, modeButtons),
  );

  const sync = () => {
    const id = current();
    const m = mode();
    cards.forEach((card) => {
      const on = card.dataset.skinId === id;
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = on ? 0 : -1;
    });
    modeButtons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.mode === m)));
    const shown = shownMode();
    previews.forEach((p) => (p.scope.dataset.theme = shown));
  };
  sync();
  const unsubscribe = settings.subscribe(sync);

  const m = openModal({
    title: 'Appearance',
    size: 'lg',
    className: 'appearance-modal',
    body: [
      h('p', { class: 'muted appearance-intro' }, 'Pick a template. It only changes how LIFE/OS looks: your tasks, notes, habits and events stay exactly as they are.'),
      group,
      modeRow,
    ],
    footer: [h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Done')],
    initialFocus: cards.find((card) => card.dataset.skinId === current()),
    onClose: () => {
      unsubscribe();
      previews.forEach((p) => p.disconnect());
      onClose?.();
    },
  });
  return m;
}
