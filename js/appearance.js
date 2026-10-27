// LIFE/OS — Appearance picker: the templates (skins) as live mini previews, light/dark, and your
// own colors for the template showing (js/palette.js). Also the first run's richer demos (buildDemo,
// for the welcome's look picker in js/welcome.js).
//
// Each preview is a tiny page built from the shared kit (pageHeader, .panel .hud, .check, .tag,
// .btn, .seg) inside its own shadow root with the app's shared stylesheets and every skin file,
// under <div data-skin="<id>" data-theme="<mode>">. The shadow boundary keeps the page's active
// skin rules ([data-skin="brutalist"] .btn …) from reaching the other previews, so every skin
// is written with plain ancestor selectors and still renders correctly in its own card.

import { h, icon, iconBadge, registerIcon, openModal, pageHeader, uid, formatDay, dateKey } from './ui.js';
import { settings } from './store.js';
import { SKINS, SKIN_BOOT, normalizeSkin, THEMES, resolveTheme, isPlainSkin } from './skins.js';
import { applyPalette, paletteEditor } from './palette.js';
import { colorClasses } from './colors.logic.js';
import { LOOK_DEMO, demoAverage, demoTotal } from './welcome.logic.js';
import { greeting } from './features/home.logic.js';

registerIcon('monitor', '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>');

const PREVIEW_W = 400; // design width of a preview page; cards scale it to fit
// The first run's demo: a small Home (design size; css/appearance.css .look-demo, the same numbers)
export const DEMO_W = 440;
export const DEMO_H = 420;

/**
 * Add a skin's fonts stylesheet once: fonts/<id>.css, the app's own copy of the typefaces (never
 * Google's servers, so a preview sends nothing anywhere). Its font files download only when text
 * needs them; without them (offline, not cached yet) the system fallbacks in its tokens apply.
 */
export function loadSkinFonts(id) {
  const href = SKIN_BOOT[id]?.font;
  if (!href || document.head.querySelector(`link[data-skin-font="${id}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href, dataset: { skinFont: id } }));
}

// The page's own app stylesheets minus the feature ones: tokens, base, shell, components, the
// picker's and every skin file. Read from index.html so a new skin file is picked up by itself.
// The fonts stylesheets stay out: @font-face only counts in the document (a shadow root ignores
// it), and the document's faces already reach every preview. `features`: the feature stylesheets
// to keep too (their names, 'home'), in the page's own order, so the skins still come after them.
function previewSheets(features = []) {
  const keep = features.map((id) => `/css/features/${id}.css`);
  return [...document.querySelectorAll('link[rel="stylesheet"]:not([data-skin-font])')]
    .map((link) => link.href)
    .filter((href) => {
      try {
        const url = new URL(href);
        return url.origin === location.origin && (!url.pathname.includes('/css/features/') || keep.some((k) => url.pathname.endsWith(k)));
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

/**
 * A page drawn in template `id` and `theme` inside its own shadow root (with `sheets`), scaled to
 * its host's width from its design `width`. The host is decorative and out of reach: the card
 * around it is the control. It fades in once its stylesheets are in (.is-ready), so it never
 * flashes unstyled. -> { host, scope, disconnect() }
 */
function shadowScene({ id, theme, sheets, page, width, className }) {
  const host = h('div', { class: className, 'aria-hidden': 'true', inert: true });
  const shadow = host.attachShadow({ mode: 'open' });
  // Color coding (Settings: Pages, on by default) colors the widgets' badges as on the real page
  const scope = h('div', { class: ['skin-scope', ...colorClasses(settings.get().colors)], style: { width: `${width}px` }, dataset: isPlainSkin(id) ? { skin: id, theme, plain: '' } : { skin: id, theme } }, page);
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
    if (w) scope.style.zoom = String(w / width);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(host);
  return { host, scope, disconnect: () => observer.disconnect() };
}

function buildPreview(id, theme, sheets) {
  return shadowScene({ id, theme, sheets, page: previewPage(), width: PREVIEW_W, className: 'skin-card-preview' });
}

/* ---- The first run's demo (js/welcome.js, the look picker) ----
   A small Home in the template: the greeting, then four of Home's own widgets on a 2 × 2 board,
   with Home's own markup and stylesheet (css/features/home.css), so each template draws them as it
   draws the real ones: To do (three tasks, one done), the habit graph (two weeks, a rest day,
   today still going), the clock and Payments (what the subscriptions cost a month). Made-up data
   (LOOK_DEMO in js/welcome.logic.js); only the time is the computer's. */

const DEMO_WIDGETS = {
  todo: { icon: 'list', tone: 'tasks' },
  graph: { icon: 'activity', tone: 'habits' },
  clock: { icon: 'clock', tone: 'home' },
  payments: { icon: 'coins', tone: 'finance' },
};

const demoBadge = (widget, size = 14) => iconBadge(DEMO_WIDGETS[widget].icon, { tone: DEMO_WIDGETS[widget].tone, size, className: 'hm-ib' });

/** One of Home's cards in its board slot (.hm-widget is the container its small-card rules ask). */
function demoCard(kind, widget, title, ...body) {
  const head = title ? h('header', { class: 'hm-card-head' }, h('h2', { class: 'hm-card-title' }, demoBadge(widget), h('span', { class: 'hm-card-name' }, title))) : null;
  return h('div', { class: 'hm-widget look-demo-slot', dataset: { widget } }, h('section', { class: ['panel', 'hm-card', `hm-${kind}`] }, head, ...body));
}

const demoMoney = (n) => `${LOOK_DEMO.currency} ${n}`;

function demoPage(id) {
  const plain = isPlainSkin(id);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  const tasks = h(
    'ul',
    { class: 'hm-tasks' },
    LOOK_DEMO.tasks.map((t) =>
      h(
        'li',
        { class: ['hm-task', t.done && 'is-done', `pri-${t.priority ?? 'none'}`] },
        previewCheck(!!t.done),
        h('span', { class: 'hm-task-title' }, t.title),
        t.priority === 'high' ? h('span', { class: 'hm-pri is-high' }, icon('flag', { size: 13 })) : null,
      ),
    ),
  );

  const last = LOOK_DEMO.bars.length - 1;
  const bars = h(
    'div',
    { class: 'hm-bars' },
    LOOK_DEMO.bars.map((rate, i) => {
      const kind = rate == null ? 'rest' : i === last ? 'today' : 'day';
      return h(
        'div',
        { class: ['hm-bar', `is-${kind}`, i === last && 'is-now'] },
        h('span', { class: 'hm-bar-track' }, rate == null ? null : h('span', { class: 'hm-bar-fill', style: { height: `${Math.round(rate * 100)}%` } })),
        h('span', { class: 'hm-bar-day' }, LOOK_DEMO.days[i]),
      );
    }),
  );
  const avg = Math.round(demoAverage() * 100);

  const pay = LOOK_DEMO.payments.slice(0, 1);
  return h(
    'div',
    // .hm-page: Home's own page class, which the templates' Home rules start from
    { class: 'look-demo hm-page lo-page' },
    pageHeader({ index: '01', title: greeting(now.getHours()) }),
    h(
      'div',
      { class: 'look-demo-board' },
      demoCard('todo', 'todo', 'To do', tasks),
      demoCard('graph', 'graph', plain ? 'Habit graph' : 'Habits · 14D', h('div', { class: 'hm-graph-body' }, bars, h('p', { class: 'hm-graph-note' }, h('span', { class: 'hm-graph-avg' }, plain ? `About ${avg}% done` : `Avg ${avg}%`)))),
      demoCard(
        'clock',
        'clock',
        null,
        h('div', { class: 'hm-clock-time tnum' }, `${pad(now.getHours())}:${pad(now.getMinutes())}`),
        // (a small card shows the short date, as Home's does: home.css)
        h('div', { class: 'hm-clock-foot' }, demoBadge('clock', 12), h('div', { class: 'hm-clock-date' }, h('span', { class: 'hm-date-long' }, formatDay(dateKey(now), 'long')), h('span', { class: 'hm-date-short' }, formatDay(dateKey(now))))),
      ),
      demoCard(
        'pay',
        'payments',
        'Payments',
        h(
          'div',
          { class: 'hm-pay-body' },
          h('p', { class: 'hm-pay-total' }, h('span', { class: 'stat-value hm-pay-sum' }, demoMoney(demoTotal())), h('span', { class: 'hm-pay-per' }, ' a month')),
          h(
            'ul',
            { class: 'hm-pay-list' },
            pay.map((p, i) => h('li', { class: ['hm-pay-row', i === 0 && 'is-soon'] }, h('span', { class: 'hm-pay-when' }, p.when), h('span', { class: 'hm-pay-name' }, p.name), h('span', { class: 'hm-pay-amount tnum' }, demoMoney(p.amount)))),
          ),
        ),
      ),
    ),
  );
}

/**
 * buildDemo(id, theme): a live demo of template `id` in `theme` ('light' | 'dark'), for the first
 * run's look picker: a small Home with four of its widgets, drawn by Home's own stylesheet and the
 * template's, in the person's own colors for it if any. Decorative (aria-hidden, inert).
 * -> { host, scope, setTheme(theme), disconnect() }
 */
export function buildDemo(id, theme) {
  const scene = shadowScene({ id, theme, sheets: previewSheets(['home']), page: demoPage(id), width: DEMO_W, className: 'look-demo-host' });
  // A picture of the app, not the app: its words are part of the picture (WCAG 1.4.3 exempts
  // them; tools/a11y-scan.js skips them, as it does the Appearance previews)
  scene.host.dataset.a11yIncidental = '';
  const setTheme = (mode) => {
    scene.scope.dataset.theme = mode;
    applyPalette(settings.get(), scene.scope, id, mode);
  };
  setTheme(theme);
  return { ...scene, setTheme };
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
        // "In use" in words on the chosen card, not only its ring and tick (shown by CSS while
        // the card is checked; the radio's own state says it to a screen reader)
        h('span', { class: 'skin-card-head' }, h('span', { class: 'skin-card-name', id: nameId }, s.name), h('span', { class: 'skin-card-current', 'aria-hidden': 'true' }, 'In use')),
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
    previews.forEach((p) => {
      p.scope.dataset.theme = shown;
      // Each preview in your own colors for it, if you set some
      applyPalette(settings.get(), p.scope, p.scope.dataset.skin, shown);
    });
  };
  sync();
  const unsubscribe = settings.subscribe(sync);

  // Your own colors for the template and mode showing, with Reset
  const colors = paletteEditor();
  const colorsLabelId = `appearance-colors-${uid()}`;
  colors.el.setAttribute('aria-labelledby', colorsLabelId);
  const colorsRow = h('div', { class: 'appearance-colors' }, h('span', { class: 'label', id: colorsLabelId }, 'Colors'), colors.el);

  const m = openModal({
    title: 'Appearance',
    size: 'lg',
    className: 'appearance-modal',
    body: [
      h('p', { class: 'muted appearance-intro' }, 'Pick a template. It only changes how LIFE/OS looks: your tasks, notes, habits and events stay exactly as they are.'),
      group,
      modeRow,
      colorsRow,
    ],
    footer: [h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Done')],
    initialFocus: cards.find((card) => card.dataset.skinId === current()),
    onClose: () => {
      unsubscribe();
      colors.destroy();
      previews.forEach((p) => p.disconnect());
      onClose?.();
    },
  });
  return m;
}
