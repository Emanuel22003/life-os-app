// LIFE/OS — shell: layout, hash router, nav badges, clock, appearance (template + light/dark).
//
// Feature contract (js/features/<id>.js, default export):
//   {
//     id: 'tasks',              // route #/tasks
//     title: 'Tasks',           // nav label + page title
//     icon: 'list',             // ui.icon() name
//     badge() { return '3' },   // optional; short string ('' hides it). Re-read on every store change.
//     badgeLabel: 'workout in progress', // optional; what a badge that is a mark, not a count
//                               // ('●'), is called in the link's name: "Training (workout in progress)"
//     mount(root) {             // render into `root` (a fresh .view div each time)
//       return () => {}         // cleanup: remove global listeners, timers, subscriptions
//     },
//     topbar(slot) {}           // optional; persistent widget in the top bar, visible on every
//                               // route. Mounted once at boot and never unmounted.
//     topbarCenter(slot) {}     // optional; the one widget centred in the top bar (the first
//                               // feature that has one). Docked above the tab bar on phones.
//     windowTitle() { return '' } // optional; non-empty text stands in for the page name in the
//                               // window title ("12:34 · Focus — LIFE/OS"). Dispatch a
//                               // `lifeos:title` window event when it changes.
//   }
// A badge that changes without a store change (a running timer) dispatches `lifeos:badge`.

import { h, icon, iconBadge, registerIcon, brandMark, dayMonth, dateFormat, unitSystem, emptyState, isTyping, modalOpen, openModal, closeAllModals, onDayChange, toast, ensureToastRegion, skin, num, term, WEEKDAYS_SHORT, useSettings, gateTips, checkButton, reducedMotion, uid } from './ui.js';
import { settings } from './store.js';
// The shared icon set (habits, sections, the ideas every page uses): before any page draws
import './icons.js';
import './command.js';

// The tips (ui.tip, page explanations) keep their "✓ Got it" in settings.tips
useSettings(settings);
import { DEFAULT_SKIN, SKIN_BOOT, normalizeSkin, resolveTheme, isPlainSkin } from './skins.js';
import { applyPalette } from './palette.js';
import { applyColorPrefs } from './colors.js';
import { openAppearance, loadSkinFonts } from './appearance.js';
import { installContextMenu } from './contextmenu.js';
import { LOCAL_ORIGIN, isRealCopy } from './origin.js';
import { startSync, syncStatus, onSyncStatus } from './sync.js';
import { openSyncPanel, syncLabel } from './sync.panel.js';
import { provideShell, normalizeTabs, toggleTab, moveTab, tabBarFit, TAB_FIT_W, TAB_MIN_W, welcomeOnStart } from './shell.js';
import { openWelcome } from './welcome.js';
import { startTour, tutorialState } from './tour.js';
import { isNewerVersion, startPage, LEGAL_LINKS } from './features/settings.logic.js';
import { startReminders } from './reminders.js';

const VERSION = 'v0.36.1';

// Read before any feature module can seed data: tells a first-ever run from an upgrade
const hadSavedData = hasSavedData();

registerIcon('install', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M12 7v5.5M9.5 10l2.5 2.5 2.5-2.5"/>');
registerIcon('open-app', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M10 16l5-5M11 11h4v4"/>');
// Nav icons live here, so the nav draws them even if their module fails to load
registerIcon('home', '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>');
registerIcon('gear', '<path d="M19.08 9.84 21.45 10.33 21.45 13.67 19.08 14.16 18.53 15.47 19.86 17.51 17.51 19.86 15.47 18.53 14.16 19.08 13.67 21.45 10.33 21.45 9.84 19.08 8.53 18.53 6.49 19.86 4.14 17.51 5.47 15.47 4.92 14.16 2.55 13.67 2.55 10.33 4.92 9.84 5.47 8.53 4.14 6.49 6.49 4.14 8.53 5.47 9.84 4.92 10.33 2.55 13.67 2.55 14.16 4.92 15.47 5.47 17.51 4.14 19.86 6.49 18.53 8.53Z"/><circle cx="12" cy="12" r="3"/>');
registerIcon('dumbbell', '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>');
registerIcon('wallet', '<path d="M4 7.5V18a2 2 0 0 0 2 2h14V9.5H6a2 2 0 0 1-2-2Zm0 0A2 2 0 0 1 6 5.5h11V9.5"/><circle cx="16.5" cy="14.75" r="1.1" fill="currentColor" stroke="none"/>');
registerIcon('heart', '<path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z"/>');
registerIcon('timer', '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5M12 2.5V6M18.5 6.5l1.5-1.5"/>');
// Recovery: a leaf, for growing back (also the icon of a tracker whose name suggests none)
registerIcon('leaf', '<path d="M8.6 15.4C6.9 9.1 11.3 4.6 19.8 4.2c.4 8.5-4.2 13-11.2 11.2Z"/><path d="M4.2 19.8c3-3.4 6.3-6.5 10.3-9.3"/>');

// Order = nav order and number keys (1 Home … 8 Finance, 9 Recovery; the keys stop at 9, so a
// tenth page, Health, has none). The phone tab bar shows the ones picked (settings.tabs: Edit tabs
// in More, or the tours' tab picker) under their own names, and More lists the rest. A new page
// also needs its line in PAGE_INTROS (js/shell.js, the picker) and, in the full tutorial, a
// chapter of its own (js/tour.logic.js).
// `hidden`: a page outside the module nav (Settings: its own entry in the sidebar foot and in More).
const MANIFEST = [
  { id: 'home', title: 'Home', icon: 'home' },
  { id: 'tasks', title: 'Tasks', icon: 'list' },
  { id: 'notes', title: 'Notes', icon: 'note' },
  { id: 'habits', title: 'Habits', icon: 'target' },
  { id: 'calendar', title: 'Calendar', icon: 'calendar' },
  { id: 'pomodoro', title: 'Pomodoro', icon: 'timer' },
  { id: 'training', title: 'Training', icon: 'dumbbell' },
  { id: 'finance', title: 'Finance', icon: 'wallet' },
  { id: 'recovery', title: 'Recovery', icon: 'leaf' },
  { id: 'health', title: 'Health', icon: 'heart' },
  { id: 'settings', title: 'Settings', icon: 'gear', hidden: true },
];

// Load each feature independently so one broken module can't blank the app.
const loaded = await Promise.allSettled(MANIFEST.map((m) => import(`./features/${m.id}.js`)));
// Only a load with every module is worth keeping as the offline copy
const allModulesLoaded = loaded.every((res) => res.status === 'fulfilled');
const FEATURES = MANIFEST.map((m, i) => {
  const res = loaded[i];
  if (res.status === 'fulfilled' && res.value?.default?.mount) return { ...m, ...res.value.default };
  console.error(`[life-os] feature "${m.id}" failed to load`, res.reason ?? res.value);
  return {
    ...m,
    mount(root) {
      root.append(
        emptyState({
          icon: 'zap',
          title: `${m.title} module offline`,
          text: String(res.reason?.message ?? 'The module did not export a mount() function.'),
        }),
      );
    },
  };
});
// The modules: nav, phone tabs, number keys (the first nine) and start pages
const NAV = FEATURES.filter((f) => !f.hidden);
const KEYED = 9;

/* ---- Appearance: template (settings.skin) + light/dark (settings.theme) ----
   Cosmetic only. index.html's head script applies both before the first paint; this keeps
   them in step with settings (the picker, the quick toggle, other tabs). */

const themeButtons = [];
const installButtons = [];
let shownSkin = null; // the template the current page was rendered with
let shownFormats = null; // and the date format and units ('dmy|metric')
const formatsNow = () => `${dateFormat()}|${unitSystem()}`;

const prefersLight = matchMedia('(prefers-color-scheme: light)');

function applyAppearance(s) {
  const root = document.documentElement;
  const next = normalizeSkin(s.skin);
  const theme = resolveTheme(s.theme, prefersLight.matches);
  const previous = root.dataset.skin;
  root.dataset.skin = next;
  root.dataset.theme = theme;
  // Plain templates are Simple underneath (css/skins/simple.css is scoped to [data-plain])
  if (isPlainSkin(next)) root.dataset.plain = '';
  else delete root.dataset.plain;
  // Your own colors for this template and mode (Appearance → Colors)
  applyPalette(s, root, next, theme);
  // Settings → Reduce animations (the computer's own setting is honoured by CSS either way)
  if (s.motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
  loadSkinFonts(next);
  // Color coding switches (settings.colors): classes on <html>, read by css/colors.css
  applyColorPrefs(s.colors);
  // Title bar of the installed app: the template's own background in this mode
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || SKIN_BOOT[next][theme]);
  themeButtons.forEach((btn) => {
    const label = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    btn.replaceChildren(icon(theme === 'light' ? 'moon' : 'sun'), h('span', { class: 'sr-only' }, label));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  });
  if (previous !== next) window.dispatchEvent(new CustomEvent('lifeos:skin', { detail: { skin: next, previous: normalizeSkin(previous) } }));
  if (shownSkin && shownSkin !== next) refreshForSkin();
  // The tab names' widths are the template's: the bar may fit them now, or need to scroll
  if (previous !== next) fitTabs();
}

// The quick toggle flips what is showing (leaving System for an explicit mode)
const toggleTheme = () => settings.update({ theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' });
// System: follow the computer when it switches, and check again on coming back to the window
const followSystemTheme = () => {
  if (settings.get().theme === 'system') applyAppearance(settings.get());
};
prefersLight.addEventListener('change', followSystemTheme);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) followSystemTheme();
});

// Pages print numbers and words for the template they were rendered with (ui.idx/num/term):
// re-render the page, keeping its scroll. A dialog stays open, so the page waits until it closes
// (the picker re-renders on close; any other dialog leaves it to the next navigation).
function refreshForSkin() {
  syncShellCopy();
  if (!modalOpen()) remountView();
}

// Dates and measures read as this device chose (Settings → Dates & units, the welcome's Your
// formats): the page shown is drawn again in them, once no dialog is open over it
let formatsTimer = 0;
function refreshForFormats() {
  clearTimeout(formatsTimer);
  if (!shownFormats || shownFormats === formatsNow()) return;
  // (Settings paints its own example as you pick; drawn again, it would drop the focus)
  if (activeId === 'settings') return void (shownFormats = formatsNow());
  if (modalOpen()) formatsTimer = setTimeout(refreshForFormats, 300);
  else remountView();
}
settings.subscribe(refreshForFormats);

function remountView() {
  const top = main.scrollTop;
  render(true);
  main.scrollTop = top;
}

function openPicker() {
  // Home's Start card ticks "Pick a look" however Appearance was opened (the card, a tour, the sidebar)
  window.dispatchEvent(new CustomEvent('lifeos:appearance-open'));
  openAppearance({
    onClose: () => {
      if (shownSkin !== skin()) remountView();
    },
  });
}

// The sidebar's status, mirrored in the top bar (its APP tag and storage note) and, on a phone, at
// the end of More
const appMarkers = [h('span', { class: 'sys-app', hidden: true }, 'App'), h('span', { class: 'sys-app', hidden: true }, 'App')];
const storageNotes = [h('span', { class: 'sr-only' }), h('span', { class: 'sr-only' })];
const sysText = h('span');
// The status line opens Sync, and says how sync is doing while it's on
const sysStatus = h('button', { type: 'button', class: 'sys-status sync-status label', onClick: openSyncPanel }, h('span', { class: 'sys-dot' }), sysText, appMarkers[0], storageNotes[0]);
const testCopyTag = isRealCopy
  ? null
  : h('span', { class: 'tag tag--dashed test-copy-tag', title: `Test copy with its own storage. Your LIFE/OS is at ${LOCAL_ORIGIN}` }, 'Test', h('span', { class: 'test-copy-more' }, ' copy'));
const topbarStatus = h('span', { class: 'topbar-sys label' }, appMarkers[1], storageNotes[1]);

/* ---- Shell ---- */

// What needs you today, per page (each page's badge(), C6 in the README): a count in the desktop
// sidebar (.nav-badge), a dot on the icon rail, the phone tab bar and in More (.nav-dot); the
// count is then in the link's name and tooltip
// value: what the badge shows; spoken: what the links' names say (a mark such as '●' in words)
const marks = new Map(FEATURES.map((f) => [f.id, { counts: [], dots: [], links: [], value: '', spoken: '' }]));
const navLinks = [];
let activeId = null; // the page showing (render())

const badge = (id) => {
  const el = h('span', { class: 'nav-badge mono', 'aria-hidden': 'true' });
  marks.get(id).counts.push(el);
  return el;
};

const dot = (id) => {
  const el = h('span', { class: 'nav-dot', 'aria-hidden': 'true', hidden: true });
  marks.get(id).dots.push(el);
  return el;
};

/** A page link whose name and tooltip follow its badge ("Tasks (3)"). */
function markLink(id, el, name) {
  const entry = { el, name };
  marks.get(id).links.push(entry);
  nameLink(entry, marks.get(id).spoken);
  return el;
}

/** A badge in words: a count or '12m' as it is, a mark with no letter or digit ('●') as the
 *  page's badgeLabel, so no link is named "Training (●)". */
function spokenBadge(f, value) {
  if (!value || /[\p{L}\p{N}]/u.test(value)) return value;
  return String(f.badgeLabel ?? '').trim() || 'needs you';
}

function nameLink({ el, name }, value) {
  const label = value ? `${name} (${value})` : name;
  if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  el.title = label;
}

const navHeading = h('div', { class: 'nav-heading label' });

// Privacy and Business details, one click away on every page (the law asks for both to be easy
// to find): small print at the end of the sidebar, and at the end of every page where the
// sidebar is an icon rail or gone (css/shell.css shows one or the other). Each opens in a new
// tab, so the app stays where it was. The same documents are listed in Settings → Legal.
function legalLinks(className) {
  const link = (id, text) => {
    const doc = LEGAL_LINKS.find((d) => d.id === id);
    return h('a', { href: doc.href, target: '_blank', rel: 'noopener', title: doc.hint, 'aria-label': `${doc.label} (new tab)` }, text);
  };
  return h('nav', { class: ['legal-links', className], 'aria-label': 'Legal' }, link('privacy', 'Privacy'), h('span', { 'aria-hidden': 'true' }, '·'), link('business', 'Business details'));
}
// The page's own copy: render() puts it after each page
const pageLegal = legalLinks('page-legal');

// Wording that depends on the template (Simple speaks plainly)
function syncShellCopy() {
  navHeading.textContent = term('shell.nav', 'Modules');
  const sync = syncStatus();
  sysText.textContent = syncLabel(sync) ?? (isRealCopy ? term('shell.status', 'Local · Saved') : 'Test copy');
  sysStatus.dataset.sync = sync.state;
}

// Search (⌘K): js/command.js opens it on the `lifeos:command` event
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const SEARCH_KEY = IS_MAC ? '⌘K' : 'Ctrl K';
const openSearch = () => window.dispatchEvent(new CustomEvent('lifeos:command'));

const sidebarSearch = h(
  'button',
  { type: 'button', class: 'sidebar-search', 'aria-label': 'Search', 'aria-keyshortcuts': IS_MAC ? 'Meta+K' : 'Control+K', title: `Search pages, tasks, notes and more (${SEARCH_KEY})`, onClick: openSearch },
  icon('search'),
  h('span', { class: 'sidebar-search-label' }, 'Search'),
  h('span', { class: 'kbd sidebar-search-kbd', 'aria-hidden': 'true' }, SEARCH_KEY),
);

const sidebar = h(
  'aside',
  { class: 'sidebar' },
  h('div', { class: 'brand' }, brandMark(), h('span', { class: 'brand-name' }, 'LIFE/OS'), h('span', { class: 'brand-version' }, VERSION)),
  sidebarSearch,
  h(
    'nav',
    { class: 'nav', 'aria-label': 'Modules' },
    navHeading,
    NAV.map((f, i) => {
      const a = h(
        'a',
        { class: 'nav-item', href: `#/${f.id}`, dataset: { id: f.id }, 'aria-keyshortcuts': i < KEYED ? String(i + 1) : null },
        h('span', { class: 'nav-index lo-deco' }, String(i + 1).padStart(2, '0')),
        icon(f.icon),
        h('span', { class: 'nav-label' }, f.title),
        badge(f.id),
        dot(f.id),
      );
      navLinks.push(a);
      return markLink(f.id, a, f.title);
    }),
  ),
  h(
    'div',
    { class: 'sidebar-foot' },
    sysStatus,
    h('button', {
      type: 'button',
      class: 'btn btn--sm sidebar-link install-btn',
      hidden: true,
      ref: (el) => installButtons.push(el),
      onClick: onInstallClick,
    }),
    // Settings, named (not only a gear), then Appearance with the light / dark switch beside it
    h(
      'a',
      { class: 'btn btn--sm btn--ghost sidebar-link settings-btn', href: '#/settings', dataset: { id: 'settings' }, 'aria-label': 'Settings', title: 'Settings', ref: (el) => navLinks.push(el) },
      icon('gear'),
      h('span', { class: 'sidebar-link-label settings-label' }, 'Settings'),
    ),
    h(
      'div',
      { class: 'appearance-row' },
      h(
        'button',
        { type: 'button', class: 'btn btn--sm btn--ghost sidebar-link appearance-btn', 'aria-label': 'Appearance', title: 'Appearance: template and light or dark mode', onClick: openPicker },
        icon('palette'),
        h('span', { class: 'sidebar-link-label appearance-label' }, 'Appearance'),
      ),
      h('button', {
        type: 'button',
        class: 'btn btn--sm btn--ghost btn--icon theme-toggle',
        ref: (el) => themeButtons.push(el),
        onClick: toggleTheme,
      }),
    ),
    legalLinks('sidebar-legal'),
  ),
);

const crumbCurrent = h('span', { class: 'crumb-current' });
const topbarWidgets = h('div', { class: 'topbar-widgets' });
// The centre of the top bar (the Pomodoro mini timer); on phones it docks above the tab bar
const topbarCenter = h('div', { class: 'topbar-center' });
const clockDate = h('span', { class: 'label topbar-date' });
const clockTime = h('span', { class: 'clock' });

// The page's name is the sidebar's highlight and the page's own title: the crumbs repeat it, so
// css/shell.css keeps them out of sight (a template may bring them back as part of its look).
// On a phone the bar shows only a top-bar widget (Mission Control's LIFE ticker) and steps out
// of the way when there is none; its buttons live in More.
const topbar = h(
  'header',
  { class: 'topbar' },
  h('div', { class: 'crumbs label', 'aria-hidden': 'true' }, h('span', null, 'LIFE/OS'), h('span', { class: 'crumb-sep' }, '/'), crumbCurrent),
  topbarCenter,
  h('div', { class: 'topbar-end' }, topbarWidgets, h('div', { class: 'topbar-meta' }, testCopyTag, topbarStatus, clockDate, clockTime)),
);

const main = h('main', { class: 'main', id: 'main' });

// "Skip to content": the first Tab stop on every page, so a keyboard user can jump past the menu
// and the top bar (WCAG 2.4.1). Shown only while it has focus (css/shell.css). A plain #main link
// would change the address's #/page part, which is the router's, so it moves the focus itself.
// The page only takes focus for that moment: a page that can always be focused would also take it
// on every click on an empty spot, and the pages read "nothing focused" as the body.
const skipLink = h(
  'a',
  {
    class: 'skip-link',
    href: '#main',
    onClick: (e) => {
      e.preventDefault();
      main.setAttribute('tabindex', '-1');
      main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
      main.focus({ preventScroll: true });
    },
  },
  'Skip to content',
);

/* ---- Phone tab bar: the pages of your choice (settings.tabs), then More ----
   As many as you like. When they don't all fit, the pages scroll sideways (a tab at a time, half
   of the next one in view, a soft fade on the side that has more) and More stays at the right
   end; the open page's tab scrolls into view, and the arrow keys move along the bar. */

const tabEls = new Map(
  NAV.map((f) => {
    const a = h('a', { class: 'tab', href: `#/${f.id}`, dataset: { id: f.id } }, icon(f.icon, { size: 22 }), h('span', { class: 'tab-label' }, f.title), dot(f.id));
    navLinks.push(a);
    return [f.id, markLink(f.id, a, f.title)];
  }),
);
const moreDot = h('span', { class: 'nav-dot', 'aria-hidden': 'true', hidden: true });
const moreBtn = h(
  'button',
  { type: 'button', class: 'tab tab--more', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: () => openMore() },
  icon('more', { size: 22, stroke: 2 }),
  h('span', { class: 'tab-label' }, 'More'),
  moreDot,
);
// The pages' tabs scroll inside .tabbar-scroll; More sits after it, outside, so it never scrolls away
const tabScroll = h('div', { class: 'tabbar-scroll' });
const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Pages', onKeydown: onTabKey }, tabScroll, moreBtn);

const pinnedTabs = () => normalizeTabs(settings.get().tabs, NAV.map((f) => f.id));

function renderTabs() {
  const next = pinnedTabs().map((id) => tabEls.get(id));
  if (next.length !== tabScroll.children.length || next.some((el, i) => tabScroll.children[i] !== el)) {
    tabScroll.replaceChildren(...next);
    tabbar.style.setProperty('--tabs', String(next.length + 1));
    fitTabs();
  }
  syncMore();
}

// How the tabs share the bar (shell.js tabBarFit): evenly while each gets enough room, as always;
// else the pages scroll, each --tab-w wide, More too. Enough room is also the widest name's (a
// template's capitals can be wide: Old Money's POMODORO), so no name is cut short. Again whenever
// the tabs change, the bar changes width (a phone turned, the window made narrow) or the template
// does (and when its fonts arrive); a new layout brings the open page's tab into view.
let shownFit = '';
function fitTabs() {
  const width = tabbar.getBoundingClientRect().width;
  if (!width) return; // hidden: the window is wider than a phone
  const need = labelRoom();
  const { scroll, tab } = tabBarFit(width, tabScroll.children.length + 1, { fit: Math.max(TAB_FIT_W, need), min: Math.max(TAB_MIN_W, need) });
  const fit = `${tabScroll.children.length}:${scroll}:${tab}`;
  if (fit !== shownFit) {
    shownFit = fit;
    tabbar.classList.toggle('is-scroll', scroll);
    if (scroll) tabbar.style.setProperty('--tab-w', `${tab}px`);
    else tabbar.style.removeProperty('--tab-w');
    revealTab();
  }
  syncTabFade();
}

// The widest name in the bar, as it is drawn (its 2px sides included; 1px to spare for rounding),
// at most 96px (a longer one is cut with …). Minimal shows icons only: no names to fit.
function labelRoom() {
  let need = 0;
  for (const el of [...tabScroll.children, moreBtn]) {
    const label = el.querySelector('.tab-label');
    if (!label || getComputedStyle(label).position === 'absolute') continue;
    need = Math.max(need, label.scrollWidth - 1);
  }
  return Math.min(need, 96);
}

// The fade goes on the side that has more to scroll to
function syncTabFade() {
  const scroll = tabbar.classList.contains('is-scroll');
  const left = tabScroll.scrollLeft;
  const max = tabScroll.scrollWidth - tabScroll.clientWidth;
  tabScroll.classList.toggle('has-more-start', scroll && left > 1);
  tabScroll.classList.toggle('has-more-end', scroll && left < max - 1);
}

let fadeQueued = false;
tabScroll.addEventListener(
  'scroll',
  () => {
    if (fadeQueued) return;
    fadeQueued = true;
    requestAnimationFrame(() => {
      fadeQueued = false;
      syncTabFade();
    });
  },
  { passive: true },
);
new ResizeObserver(() => fitTabs()).observe(tabbar);
document.fonts?.addEventListener?.('loadingdone', () => fitTabs());

/**
 * Scroll the bar so `tab` shows whole, clear of the fades: the open page's after a navigation, a
 * tab the keyboard reached. One to the left lines up at the start, one to the right becomes the
 * last whole tab (both where the bar snaps to).
 */
function revealTab(tab = tabScroll.querySelector('.tab[aria-current="page"]'), smooth = false) {
  if (!tab || tab.parentElement !== tabScroll || !tabbar.classList.contains('is-scroll')) return;
  const w = tab.offsetWidth;
  const view = tabScroll.clientWidth;
  const left = tabScroll.scrollLeft;
  const start = tab.offsetLeft;
  let to = null;
  if (start < left - 1) to = start;
  else if (start + w > left + view + 1) to = start - (Math.max(1, Math.floor(view / w + 0.01)) - 1) * w;
  if (to === null || !w) return;
  tabScroll.scrollTo({ left: Math.max(0, to), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

// Tab (the key) reaching a tab half out of view brings it in
tabScroll.addEventListener('focusin', (e) => revealTab(e.target.closest?.('.tab'), true));

// ← → move along the bar, Home / End to its ends (Tab still stops at every tab)
function onTabKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const all = [...tabScroll.children, moreBtn];
  const at = all.indexOf(document.activeElement);
  const to = at < 0 ? undefined : { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: all.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  // (a page's tab brings itself into view: focusin above)
  all[Math.max(0, Math.min(all.length - 1, to))].focus({ preventScroll: true });
}

/** More stands for the pages it holds: it is "current" on one of them, and dotted when one needs you. */
function syncMore() {
  const ids = pinnedTabs();
  const inMore = (id) => !ids.includes(id);
  const here = activeId && activeId !== 'settings' && inMore(activeId) ? FEATURES.find((f) => f.id === activeId) : null;
  moreBtn.classList.toggle('is-current', !!(here || activeId === 'settings'));
  const waiting = NAV.filter((f) => inMore(f.id) && marks.get(f.id).value);
  moreDot.hidden = !waiting.length;
  const parts = [here || activeId === 'settings' ? `you are on ${here?.title ?? 'Settings'}` : null, waiting.length ? waiting.map((f) => `${f.title} (${marks.get(f.id).spoken})`).join(', ') : null].filter(Boolean);
  const label = parts.length ? `More pages: ${parts.join('; ')}` : 'More pages, Settings and Search';
  moreBtn.setAttribute('aria-label', label);
  moreBtn.title = label;
}

/* ---- More: every other page, Search, Settings, Appearance, light / dark, Edit tabs, and
   under Help the two tutorials ----
   A dialog (a sheet from the bottom on a phone, css/components.css). Its pages are links, so
   choosing one navigates and the shell closes the dialog. */

let moreDialog = null;

// The page already open (no route change, so nothing would close the sheet): just close it
const stayOnPage = (e) => {
  if (e.currentTarget.dataset.id !== activeId) return;
  e.preventDefault();
  moreDialog?.close();
};

function moreRow({ iconName, label, hint = null, onClick = null, href = null, id = null, current = false, className = '', extra = null, dataset = null }) {
  const content = [h('span', { class: 'more-row-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 18 })), h('span', { class: 'more-row-label' }, label), hint ? h('span', { class: 'more-row-hint' }, hint) : null, extra];
  return href
    ? h('a', { class: ['more-row', className], href, dataset: id ? { id } : null, 'aria-current': current ? 'page' : null, onClick: stayOnPage }, content)
    : h('button', { type: 'button', class: ['more-row', className], dataset, onClick }, content);
}

function morePages() {
  const ids = pinnedTabs();
  const pages = NAV.filter((f) => !ids.includes(f.id));
  const tile = (f) => {
    const value = marks.get(f.id).value;
    const name = value ? `${f.title} (${marks.get(f.id).spoken})` : f.title;
    return h(
      'a',
      { class: 'more-page', href: `#/${f.id}`, dataset: { id: f.id }, 'aria-current': activeId === f.id ? 'page' : null, 'aria-label': name, onClick: stayOnPage },
      iconBadge(f.icon, { tone: f.id, size: 18, box: 34 }),
      h('span', { class: 'more-page-label' }, f.title),
      value ? h('span', { class: 'more-page-count nav-badge mono', 'aria-hidden': 'true' }, value) : null,
    );
  };
  return h('div', { class: 'more-pages' }, pages.map((f) => tile(f)));
}

/** The sheet's main view. sheet: { body, foot, title, close } (openMore). */
function moreMain(sheet) {
  const { body, close } = sheet;
  sheet.title.textContent = 'More';
  sheet.foot.replaceChildren();
  const dark = document.documentElement.dataset.theme !== 'light';
  const mode = installMode();
  const install = mode ? INSTALL_MODES[mode] : null;
  body.replaceChildren(
    morePages(),
    h(
      'div',
      { class: 'more-list' },
      moreRow({
        iconName: 'search',
        label: 'Search',
        hint: 'Pages, tasks, notes and more',
        onClick: () => {
          close();
          // After the sheet's own focus has gone back, so the search keeps it
          setTimeout(openSearch, 0);
        },
      }),
      moreRow({ iconName: 'gear', label: 'Settings', href: '#/settings', id: 'settings', current: activeId === 'settings' }),
      moreRow({
        iconName: 'palette',
        label: 'Appearance',
        hint: 'Template and colors',
        onClick: () => {
          close();
          setTimeout(openPicker, 0);
        },
      }),
      moreRow({
        iconName: dark ? 'sun' : 'moon',
        label: dark ? 'Light mode' : 'Dark mode',
        onClick: () => {
          toggleTheme();
          moreMain(sheet);
          body.querySelector('.more-theme')?.focus();
        },
        className: 'more-theme',
      }),
      install
        ? moreRow({
            iconName: install.icon,
            label: install.text,
            onClick: () => {
              close();
              onInstallClick();
            },
          })
        : null,
      moreRow({ iconName: 'edit', label: 'Edit tabs', hint: 'Pick pages and their order', onClick: () => moreEditTabs(sheet), className: 'more-edit' }),
    ),
    moreHelp(close),
    // How your data is doing (the sidebar's status line): opens Sync
    h(
      'button',
      { type: 'button', class: 'more-status', onClick: () => (close(), setTimeout(openSyncPanel, 0)) },
      h('span', { class: 'sys-dot', 'aria-hidden': 'true' }),
      h('span', null, sysText.textContent),
      isStandalone() ? h('span', { class: 'sys-app' }, 'App') : null,
    ),
  );
}

/**
 * Help: the two tutorials, as Settings → About → Tutorial has them (js/tour.js). The quick one
 * and the full one, each with its length; after the full one was left part-way, Continue (14 of
 * 33) and Start over instead. A tour starts once More has closed (the tour steps aside while a
 * dialog is open).
 */
function moreHelp(close) {
  const state = tutorialState();
  // (while the full tour is on screen it isn't "left" anywhere)
  const full = state.running === 'full' ? null : state.full;
  const begin = (kind, resume = false) => () => {
    close();
    setTimeout(() => startTour(kind, { resume }), 0);
  };
  const headId = `more-help-${uid()}`;
  return h(
    'section',
    { class: 'more-help', 'aria-labelledby': headId },
    h('h3', { class: 'more-head', id: headId }, 'Help'),
    h(
      'div',
      { class: 'more-list' },
      moreRow({ iconName: 'wl-quick', label: 'Quick tutorial', hint: `${state.steps.quick} steps · 1 min`, onClick: begin('quick'), className: 'more-tour', dataset: { tour: 'quick' } }),
      ...(full
        ? [
            moreRow({ iconName: 'play', label: `Continue tutorial (${full.n} of ${full.of})`, onClick: begin('full', true), className: 'more-tour', dataset: { tour: 'continue' } }),
            moreRow({ iconName: 'wl-map', label: 'Start tutorial over', hint: 'Every page · 10 min', onClick: begin('full'), className: 'more-tour', dataset: { tour: 'full' } }),
          ]
        : [moreRow({ iconName: 'wl-map', label: 'Tutorial', hint: 'Every page · 10 min', onClick: begin('full'), className: 'more-tour', dataset: { tour: 'full' } })]),
    ),
  );
}

/**
 * Edit tabs: tick the pages for the bar, as many as you like, and put them in order. The bar's
 * pages come first, in its order, each with ↑ ↓ (up = further left); then the ones in More. A tick
 * moves a page between the two lists, and the focus goes with it. Done goes back to the main view.
 */
function moreEditTabs(sheet) {
  const { body } = sheet;
  sheet.title.textContent = 'Tab bar';
  const ids = NAV.map((f) => f.id);
  const byId = (id) => NAV.find((f) => f.id === id);
  const note = h('p', { class: 'more-tabs-note', role: 'status' });
  const inId = `more-tabs-${uid()}`;
  const outId = `more-tabs-${uid()}`;
  const headIn = h('h3', { class: 'more-tabs-head', id: inId });
  const headOut = h('h3', { class: 'more-tabs-head', id: outId }, 'In More');
  const inBar = h('div', { class: 'more-tabs', role: 'group', 'aria-labelledby': inId });
  const inMore = h('div', { class: 'more-tabs', role: 'group', 'aria-labelledby': outId });

  const row = (f, tabs) => {
    const at = tabs.indexOf(f.id);
    const check = checkButton({ checked: at >= 0, label: f.title, onToggle: () => pick(f.id) });
    const move = (by, iconName, word) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost btn--icon btn--sm more-tab-move',
          dataset: { move: String(by) },
          'aria-label': `Move ${f.title} ${word}`,
          title: `Move ${word}`,
          disabled: by < 0 ? at === 0 : at === tabs.length - 1,
          onClick: () => shift(f.id, by),
        },
        icon(iconName, { size: 16 }),
      );
    return h(
      'div',
      // The whole row ticks; its buttons (the check, the arrows) do their own thing
      { class: ['more-tab', at >= 0 && 'is-on'], dataset: { id: f.id }, onClick: (e) => e.target.closest('button') || pick(f.id) },
      check,
      iconBadge(f.icon, { tone: f.id, size: 16, box: 30 }),
      h('span', { class: 'more-tab-label' }, f.title),
      at >= 0 ? h('span', { class: 'more-tab-moves' }, move(-1, 'arrow-up', 'up'), move(1, 'arrow-down', 'down')) : null,
    );
  };

  // focus: { id, what: 'check' | '-1' | '1' }: the control to focus again in the redrawn row
  const paint = (focus = null) => {
    const tabs = pinnedTabs();
    headIn.textContent = `In the tab bar (${tabs.length})`;
    inBar.replaceChildren(...tabs.map((id) => row(byId(id), tabs)));
    inMore.replaceChildren(...NAV.filter((f) => !tabs.includes(f.id)).map((f) => row(f, tabs)));
    headOut.hidden = inMore.hidden = !inMore.children.length;
    if (!focus) return;
    const r = body.querySelector(`.more-tab[data-id="${focus.id}"]`);
    const target = (focus.what === 'check' ? null : r?.querySelector(`[data-move="${focus.what}"]:not(:disabled)`) ?? r?.querySelector('.more-tab-move:not(:disabled)')) ?? r?.querySelector('.check');
    target?.focus();
  };
  const hadFocus = () => body.contains(document.activeElement);
  const pick = (id) => {
    const res = toggleTab(settings.get().tabs, id, ids);
    if (res.reason === 'last') note.textContent = 'The bar keeps at least one page.';
    if (!res.changed) return;
    const focus = hadFocus() ? { id, what: 'check' } : null;
    settings.update({ tabs: res.tabs });
    paint(focus);
    note.textContent = res.tabs.includes(id) ? `${byId(id).title} is in the tab bar, at the end.` : `${byId(id).title} is in More.`;
  };
  const shift = (id, by) => {
    const res = moveTab(settings.get().tabs, id, by, ids);
    if (!res.changed) return;
    const focus = hadFocus() ? { id, what: String(by) } : null;
    settings.update({ tabs: res.tabs });
    paint(focus);
    note.textContent = `${byId(id).title}: ${res.tabs.indexOf(id) + 1} of ${res.tabs.length} in the bar.`;
  };

  body.replaceChildren(
    h('p', { class: 'more-tabs-lead' }, 'Tick as many pages as you like. The arrows set their order: the top one is first, on the left. When they don’t all fit, the bar scrolls sideways.'),
    headIn,
    inBar,
    headOut,
    inMore,
    note,
  );
  sheet.foot.replaceChildren(
    h('button', { type: 'button', class: 'btn btn--primary', onClick: () => (moreMain(sheet), body.querySelector('.more-edit')?.focus()) }, 'Done'),
  );
  paint();
  inBar.querySelector('.check')?.focus();
}

function openMore() {
  if (moreDialog) return;
  // The title and the footer change with the view (More · Tab bar); an empty footer is hidden
  const title = h('span', null, 'More');
  const sheet = { body: h('div', { class: 'more-body' }), foot: h('div', { class: 'more-foot' }), title, close: () => moreDialog?.close() };
  moreMain(sheet);
  moreBtn.setAttribute('aria-expanded', 'true');
  moreDialog = openModal({
    title,
    className: 'more-sheet',
    body: sheet.body,
    footer: sheet.foot,
    initialFocus: sheet.body.querySelector('.more-page, .more-row'),
    onClose: () => {
      moreDialog = null;
      moreBtn.setAttribute('aria-expanded', 'false');
    },
  });
}

const shell = h('div', { class: 'shell' }, skipLink, sidebar, topbar, main, tabbar);
document.getElementById('app').replaceChildren(shell);
renderTabs();
settings.subscribe(() => renderTabs());
// Right-click menu (the module's actions, Copy · Paste · Delete …) over every module's items and blank areas
installContextMenu(main);
ensureToastRegion();
// One tip at a time on a page: the first one on screen shows, the rest wait their turn
gateTips(main);

syncShellCopy();
onSyncStatus(syncShellCopy);
applyAppearance(settings.get());
settings.subscribe((s) => applyAppearance(s));

/* ---- Persistent top-bar widgets ---- */

for (const f of FEATURES) {
  if (typeof f.topbar !== 'function') continue;
  const slot = h('div', { class: 'topbar-widget', dataset: { feature: f.id } });
  topbarWidgets.append(slot);
  try {
    f.topbar(slot);
  } catch (err) {
    console.error(`[life-os] top-bar widget for "${f.id}" failed`, err);
    slot.remove();
  }
}

// The centred widget: one feature's (the first that has one)
const centerFeature = FEATURES.find((f) => typeof f.topbarCenter === 'function');
if (centerFeature) {
  topbarCenter.dataset.feature = centerFeature.id;
  try {
    centerFeature.topbarCenter(topbarCenter);
  } catch (err) {
    console.error(`[life-os] centre widget for "${centerFeature.id}" failed`, err);
    topbarCenter.replaceChildren();
  }
}

// Phones have no room for it in the top bar: it floats above the tab bar instead (moved, not
// re-mounted, so it keeps its state). The top bar's blur would trap a fixed child, hence the move.
const phoneQuery = matchMedia('(max-width: 640px)');
function placeCenter() {
  if (phoneQuery.matches) {
    if (topbarCenter.parentElement !== shell) shell.append(topbarCenter);
  } else if (topbarCenter.parentElement !== topbar) {
    topbar.insertBefore(topbarCenter, topbar.querySelector('.topbar-end'));
  }
}
placeCenter();
phoneQuery.addEventListener?.('change', placeCenter);

/* ---- Router ---- */

let cleanup = null;

function routeId() {
  const m = location.hash.match(/^#\/([\w-]+)/);
  if (m && FEATURES.some((f) => f.id === m[1])) return m[1];
  // The app opens without a page (manifest start_url is ./): Settings → Open on
  return startPage(settings.get().startPage, NAV.map((f) => f.id));
}

function render(force = false) {
  const id = routeId();
  if (id === activeId && !force) return;
  const firstRender = activeId === null;

  try {
    cleanup?.();
  } catch (err) {
    console.error('[life-os] cleanup failed', err);
  }
  cleanup = null;
  activeId = id;

  // A dialog belongs to the page that opened it
  closeAllModals();

  const feature = FEATURES.find((f) => f.id === id);
  const view = h('div', { class: 'view is-entering', dataset: { feature: id } });
  main.replaceChildren(view, pageLegal);
  main.scrollTop = 0;

  try {
    const ret = feature.mount(view);
    cleanup = typeof ret === 'function' ? ret : null;
  } catch (err) {
    console.error(`[life-os] "${id}" failed to render`, err);
    view.replaceChildren(emptyState({ icon: 'zap', title: `${feature.title} crashed`, text: String(err?.message ?? err) }));
  }

  // Every page's title carries its icon, in the page's color: you see at once where you are
  // (Home's title is a greeting and draws its own; Training keeps its header in .tr-normal)
  const pageTitle = id !== 'home' ? view.querySelector(':scope > .page-header .page-title, :scope > .tr-normal > .page-header .page-title') : null;
  if (pageTitle && !pageTitle.querySelector('.ib')) pageTitle.prepend(iconBadge(feature.icon, { tone: id, size: 18, className: 'page-ib' }));

  shownSkin = skin();
  shownFormats = formatsNow();
  navLinks.forEach((a) => (a.dataset.id === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  // A bar that scrolls: the open page's tab comes into view (it glides there after a tap)
  revealTab(undefined, !firstRender);
  crumbCurrent.textContent = feature.title;
  syncMore();
  syncTitle();
  if (!location.hash.startsWith(`#/${id}`)) history.replaceState(null, '', `#/${id}`);
}

window.addEventListener('hashchange', () => render());

/* ---- Window title: the page's name, or what a feature puts first (a running timer) ---- */

function syncTitle() {
  let lead = '';
  for (const f of FEATURES) {
    if (typeof f.windowTitle !== 'function') continue;
    try {
      lead = String(f.windowTitle() ?? '');
    } catch (err) {
      console.error(`[life-os] window title for "${f.id}" failed`, err);
    }
    if (lead) break;
  }
  const page = FEATURES.find((f) => f.id === activeId)?.title ?? '';
  const next = `${lead || page} — LIFE/OS`;
  if (document.title !== next) document.title = next;
}

window.addEventListener('lifeos:title', syncTitle);

/* ---- Nav badges ---- */

function refreshBadges() {
  for (const f of FEATURES) {
    let value = '';
    try {
      value = f.badge ? String(f.badge() ?? '').trim() : '';
    } catch (err) {
      console.error(`[life-os] badge for "${f.id}" failed`, err);
    }
    const m = marks.get(f.id);
    m.value = value;
    m.spoken = spokenBadge(f, value);
    m.counts.forEach((el) => {
      if (el.textContent !== value) el.textContent = value;
    });
    m.dots.forEach((el) => (el.hidden = !value));
    m.links.forEach((link) => nameLink(link, m.spoken));
  }
  syncMore();
}

window.addEventListener('lifeos:change', refreshBadges);
// A badge that moves on its own (the Pomodoro minutes left) asks for a refresh
window.addEventListener('lifeos:badge', refreshBadges);

/* ---- Storage failures (quota full, private mode) ---- */

let lastPersistWarning = 0;
window.addEventListener('lifeos:persist-error', () => {
  const now = performance.now();
  if (now - lastPersistWarning < 10000) return;
  lastPersistWarning = now;
  toast('Storage is full or blocked — recent changes may not be saved.', { duration: 6000 });
});
onDayChange(refreshBadges);

/* ---- Clock ---- */

const pad = (n) => String(n).padStart(2, '0');

function tick() {
  const d = new Date();
  // (in this device's date format; the template's own digits for the day)
  clockDate.textContent = `${WEEKDAYS_SHORT[d.getDay()]} ${dayMonth(d.getFullYear(), d.getMonth() + 1, num(d.getDate()), { year: true })}`;
  clockTime.replaceChildren(`${pad(d.getHours())}:${pad(d.getMinutes())}`, h('span', { class: 'clock-seconds lo-deco' }, `:${pad(d.getSeconds())}`));
}

tick();
setInterval(tick, 1000);

/* ---- Global shortcuts: 1..9 switch modules (a page after the ninth has no key) ---- */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= Math.min(KEYED, NAV.length)) {
    e.preventDefault();
    location.hash = `#/${NAV[n - 1].id}`;
  }
});

/* ---- Install as an app ---- */

const standaloneQuery = matchMedia('(display-mode: standalone)');
const isStandalone = () => standaloneQuery.matches || navigator.standalone === true;

let installPrompt = null; // Chrome's beforeinstallprompt event, usable once
let helpReady = false; // offer help only after Chrome had a moment to offer its prompt
// The Mac's own copy (start.command's background service) may speak of the Dock and Launchpad;
// the website can be open on any computer or phone, so its words stay general
const onMac = location.origin === LOCAL_ORIGIN;

// Remembered (settings.appInstalled), so a browser tab knows the app exists: Chrome never offers
// to install an installed app, and only offers it again once the app is removed
function markInstalled(installed) {
  if (Boolean(settings.get().appInstalled) !== installed) settings.update({ appInstalled: installed });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  markInstalled(false);
  syncInstallUi();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  markInstalled(true);
  syncInstallUi();
  toast(onMac ? 'LIFE/OS is installed. Open it from the Dock, Launchpad or Spotlight.' : 'LIFE/OS is installed. Open it like your other apps.', { duration: 6000 });
  // Chrome usually grants installed apps persistent storage
  requestPersistence({ ask: true });
});

standaloneQuery.addEventListener?.('change', () => {
  if (isStandalone()) {
    markInstalled(true);
    requestPersistence({ ask: true });
  }
  syncInstallUi();
  syncStorageNote();
});

// The app window may record the install while this tab is open
settings.subscribe(() => syncInstallUi());

const INSTALL_MODES = {
  real: { text: 'Open real app', icon: 'open-app', title: `This is a test copy with its own storage. Your LIFE/OS is at ${LOCAL_ORIGIN}` },
  prompt: { text: 'Install app', icon: 'install', title: 'Install LIFE/OS as an app: its own window, and it opens without internet after the first visit' },
  help: { text: 'How to install', icon: 'install', title: 'How to install LIFE/OS as an app' },
  open: { text: 'Open in app', icon: 'open-app', title: 'LIFE/OS is installed on this computer: open the app instead of this tab' },
};

function installMode() {
  if (!isRealCopy) return 'real';
  if (isStandalone()) return null;
  if (installPrompt) return 'prompt';
  if (!helpReady) return null;
  return settings.get().appInstalled ? 'open' : 'help';
}

function syncInstallUi() {
  const mode = installMode();
  for (const btn of installButtons) {
    btn.hidden = !mode;
    if (!mode) continue;
    const { text, icon: iconName, title } = INSTALL_MODES[mode];
    if (btn.dataset.mode === mode) continue;
    btn.dataset.mode = mode;
    // Chrome's own prompt is the one worth a solid button; the fallbacks stay quiet (on a phone
    // the same choice is a row in More, built when it opens)
    btn.classList.toggle('btn--ghost', mode !== 'prompt');
    btn.replaceChildren(icon(iconName), h('span', { class: 'install-label' }, text));
    // The accessible name is the visible text (also when only the icon shows: the icon rail)
    btn.setAttribute('aria-label', text);
    btn.title = title;
  }
  appMarkers.forEach((el) => (el.hidden = !isStandalone()));
}

function onInstallClick() {
  if (!isRealCopy) window.open(`${LOCAL_ORIGIN}/`, '_blank', 'noopener');
  else if (installPrompt) promptInstall();
  else if (settings.get().appInstalled) openAppHelp();
  else openInstallHelp();
}

async function promptInstall() {
  const prompt = installPrompt;
  installPrompt = null;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice?.outcome === 'accepted') markInstalled(true);
  } catch (err) {
    console.warn('[life-os] install prompt failed', err);
    openInstallHelp();
  }
  syncInstallUi();
}

function browserKind() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand).join(' ') ?? '';
  const ua = navigator.userAgent;
  // iPhone and iPad (an iPad's Safari calls itself a Mac, one with a touch screen)
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Chrom|Edge|Opera|Brave/.test(brands) || /Chrome\/|Edg\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua) && !/Android/.test(ua)) return 'safari';
  return 'other';
}

// A step may be null (one that doesn't apply on this copy)
const helpSteps = (...items) => h('ol', { class: 'install-steps' }, items.filter(Boolean).map((item) => h('li', null, h('span', null, item))));
const helpStrong = (text) => h('strong', null, text);
const helpNote = (...content) => h('p', { class: 'install-note' }, content);
const chromeMenuPath = () => [h('span', { class: 'kbd' }, '⋮'), ' → ', helpStrong('Cast, save, and share'), ' → ', helpStrong('Install LIFE/OS…'), ' (or ', helpStrong('Install page as app…'), ')'];
const uninstallNote = () =>
  helpNote(helpStrong('Uninstalling later? '), 'Leave ', helpStrong('Also delete data from Chrome'), ' unticked. Ticking it erases all your tasks, notes, habits and events.');

function openInstallHelp() {
  const kind = browserKind();

  const chrome = [
    helpSteps(
      ['Click the ', helpStrong('Install'), ' icon at the right end of the address bar, or open ', ...chromeMenuPath(), '.'],
      onMac ? ['Confirm. LIFE/OS opens in its own window, with a Dock icon, a place in Launchpad and in ⌘ Tab.'] : ['Confirm. LIFE/OS opens in its own window, like your other apps.'],
      onMac ? ['To keep it in the Dock: right-click its icon → Options → Keep in Dock.'] : null,
    ),
    helpNote('Same data as this tab: the app reads the same storage, nothing is copied or reset.', onMac ? ' It also opens when start.command isn’t running.' : null),
    uninstallNote(),
  ];
  const safari = [
    helpSteps([helpStrong('File → Add to Dock…'), ' (macOS Sonoma or later).'], ['Confirm the name, then click ', helpStrong('Add'), '. LIFE/OS appears in the Dock and Launchpad.']),
    helpNote(helpStrong('Your data won’t come along: '), 'a Safari web app keeps its own website data, separate from every browser. Install from the browser that holds your data, or back it up first (Settings → Download a backup).'),
  ];
  const ios = [
    helpSteps(['Tap ', helpStrong('Share'), ', then ', helpStrong('Add to Home Screen'), '.'], ['Tap ', helpStrong('Add'), '. LIFE/OS opens from its icon on the Home Screen.']),
    helpNote(helpStrong('Your data won’t come along: '), 'the Home Screen app keeps its own website data, separate from the browser. Back it up first (Settings → Download a backup), then restore it in the app.'),
  ];
  const other = [
    h('p', { class: 'muted' }, 'This browser can’t install web apps. Open ', h('span', { class: 'mono' }, location.origin), ' in Chrome and install it there.'),
    helpNote('Each browser keeps its own LIFE/OS data, so a different browser starts empty.'),
  ];

  const footer = [];
  let m;
  if (installPrompt) {
    footer.push(h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Not now'));
    const install = () => {
      m.close();
      promptInstall();
    };
    footer.push(h('button', { type: 'button', class: 'btn btn--primary', onClick: install }, icon('install'), 'Install'));
  } else {
    footer.push(h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Got it'));
  }

  m = openModal({
    title: 'Install LIFE/OS as an app',
    className: 'install-modal',
    body: [
      h('p', { class: 'muted' }, 'Run LIFE/OS in its own window, like your other apps, without a browser tab.'),
      ...(kind === 'chromium' ? chrome : kind === 'safari' ? safari : kind === 'ios' ? ios : other),
    ],
    footer,
  });
}

// A browser tab of an app that is already installed
function openAppHelp() {
  const m = openModal({
    title: 'LIFE/OS is installed',
    className: 'install-modal',
    body: [
      h('p', { class: 'muted' }, 'You’re in a browser tab. The app is the same LIFE/OS with the same data, in its own window.'),
      helpSteps(
        onMac ? ['Open it from the Dock, Launchpad or Spotlight (type ', helpStrong('LIFE/OS'), ').'] : ['Open it like your other apps (search for ', helpStrong('LIFE/OS'), ').'],
        ['Or click the ', helpStrong('Open in LIFE/OS'), ' icon at the right end of Chrome’s address bar.'],
      ),
      helpNote('Removed the app? Chrome offers to install it again here, or use ', ...chromeMenuPath(), '.'),
      uninstallNote(),
    ],
    footer: [h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Got it')],
  });
}

/* ---- Storage: ask Chrome not to evict this app's data under disk pressure ---- */

let storageState = 'checking';

const STORAGE_NOTES = {
  checking: 'Storage: checking',
  persistent: 'Storage: persistent. The browser won’t clear it to free up disk space.',
  'best-effort': 'Storage: best effort. The browser may clear it if the disk is nearly full.',
  unsupported: 'Storage: standard',
};

function syncStorageNote() {
  const standalone = isStandalone();
  const hint = storageState === 'best-effort' && !standalone ? ' Installing the app usually makes it persistent.' : '';
  const text = `${standalone ? 'Installed app' : 'Browser tab'} · Data saved on this device · ${STORAGE_NOTES[storageState]}${hint}`;
  sysStatus.title = text;
  topbarStatus.title = text;
  storageNotes.forEach((el) => (el.textContent = text));
}

// Asking (persist()) is silent in Chromium (Chrome, Edge: they have navigator.userAgentData) and
// in Safari and every other WebKit browser (Apple's vendor string): they decide by themselves.
// Firefox and the rest may show a permission popup every time, so a boot there only reads the
// state; they are asked once the app is installed or runs in its own window (`ask`), where
// keeping the data is clearly wanted. The Mac's Chrome is asked on every boot, as before.
const asksSilently = Boolean(navigator.userAgentData) || navigator.vendor === 'Apple Computer, Inc.';

async function requestPersistence({ ask = asksSilently || isStandalone() } = {}) {
  const storage = navigator.storage;
  try {
    if (!storage?.persist || !storage.persisted) storageState = 'unsupported';
    else if (await storage.persisted()) storageState = 'persistent';
    else if (ask) storageState = (await storage.persist()) ? 'persistent' : 'best-effort';
    else storageState = 'best-effort';
  } catch (err) {
    console.warn('[life-os] persistent storage request failed', err);
    storageState = 'unsupported';
  }
  syncStorageNote();
}

/* ---- Version notice ---- */

function hasSavedData() {
  try {
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith('lifeos:v1:')) return true;
  } catch {}
  return false;
}

function noteVersion() {
  const seen = settings.get().seenVersion;
  // Same version, or an older copy (served from cache) after a newer one: stay quiet
  if (seen && !isNewerVersion(VERSION, seen)) return;
  // A first-ever run has nothing to announce; data without a seen version predates v0.3.
  // Later than boot, so screen readers have registered the toast region and announce it.
  if (seen || hadSavedData) setTimeout(() => toast(`LIFE/OS updated to ${VERSION}`, { duration: 5000 }), 800);
  settings.update({ seenVersion: VERSION });
}

// v0.6 made Simple the default look. People who used LIFE/OS before hear it once, with the way
// back; a first run just starts in Simple. A skin from a newer version is left as stored.
function noteNewLook() {
  if (settings.get().skin !== undefined) return;
  if (hadSavedData) {
    setTimeout(
      () =>
        toast('New look: Simple. Prefer the previous one? Open Appearance → Mission Control.', {
          duration: 12000,
          action: { label: 'Appearance', onClick: openPicker },
        }),
      1600,
    );
  }
  settings.update({ skin: DEFAULT_SKIN });
}

/* ---- First run: the welcome sheet (js/welcome.js) ----
   The first time LIFE/OS opens on a device with nothing saved: Pick your look, then No tutorial,
   Quick tutorial or Tutorial. Once answered (settings.welcomed) it doesn't come back by itself; a
   device that already had data never sees it. Settings → About → Tutorial (and More → Help on a
   phone) starts either tour again. */

function noteWelcome() {
  const { show, mark } = welcomeOnStart(settings.get().welcomed, hadSavedData);
  if (mark) settings.update({ welcomed: true });
  if (!show) return;
  // Shown but not answered yet (the window closed meanwhile): it shows again next time
  if (settings.get().welcomed !== false) settings.update({ welcomed: false });
  if (modalOpen()) closeAllModals();
  openWelcome({
    onChoose: ({ choice, keyboard }) => {
      // A look picked in the welcome: the page behind it waited (a dialog was open), now it draws
      // in it (its numbers and words are the template's)
      if (shownSkin !== skin()) remountView();
      if (choice === 'quick' || choice === 'full') startTour(choice);
      // No tutorial: Home's Start card takes it from here (js/features/home.js); answered from the
      // keyboard, its next step gets the focus
      window.dispatchEvent(new CustomEvent('lifeos:welcome-closed', { detail: { choice, keyboard } }));
    },
  });
}

/* ---- Update check: a newer version was deployed while this window is open ---- */

const UPDATE_CHECK_MS = 10 * 60 * 1000;
let offered = null; // { version, toast } of the notice last shown

// Each version is offered once per window: once its notice has gone, it doesn't come back (no
// nagging every 10 minutes). A newer version, or a restart (the page loads again), shows one.
/** The newest deployed version, or null (offline, no version file: a test copy). */
async function fetchLatestVersion() {
  try {
    // Straight from the server (the worker never caches version.json); offline it fails
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const { version } = await res.json();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  if (!isRealCopy || document.hidden) return;
  try {
    const version = await fetchLatestVersion();
    if (!version || !isNewerVersion(version, VERSION)) return;
    // Still showing, or gone by its own clock or Reload (is-leaving): not again. One that newer
    // messages pushed out early (at most 4 show) wasn't really seen, so it comes back.
    const notice = offered?.toast.el;
    if (offered && !isNewerVersion(version, offered.version) && (notice.isConnected || notice.classList.contains('is-leaving'))) return;
    offered?.toast.dismiss();
    offered = {
      version,
      toast: toast(`LIFE/OS ${version} is ready`, { duration: UPDATE_CHECK_MS, action: { label: 'Reload', onClick: () => location.reload() } }),
    };
  } catch {
    // No service running or no version file: keep running this version quietly
  }
}

/* ---- Offline copy (service worker) ---- */

function startOfflineSupport() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('./sw.js')
    .then(() => Promise.all([navigator.serviceWorker.ready, document.fonts?.ready]))
    .then(([registration]) => {
      // A partial load (a module failed) must not become the offline copy
      if (allModulesLoaded) registration.active?.postMessage({ type: 'lifeos:cache-urls', complete: true, urls: loadedUrls() });
    })
    .catch((err) => console.warn('[life-os] offline support unavailable', err));
}

// Everything this page loaded: the worker snapshots that set (and so caches a first visit whole)
function loadedUrls() {
  const entries = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
  return [location.href, ...entries.map((e) => e.name)];
}

// Installed app: a Dock shortcut (#/notes …) re-targets the open window instead of a new one
window.launchQueue?.setConsumer((params) => {
  try {
    const target = params?.targetURL ? new URL(params.targetURL) : null;
    if (target?.origin === location.origin && target.hash && target.hash !== location.hash) location.hash = target.hash;
  } catch (err) {
    console.warn('[life-os] launch target ignored', err);
  }
});

/* ---- Boot ---- */

provideShell({
  version: VERSION,
  pages: NAV.map(({ id, title, icon: iconName }) => ({ id, title, icon: iconName })),
  openAppearance: openPicker,
  latestVersion: fetchLatestVersion,
  storageState: () => storageState,
});

if (isStandalone()) markInstalled(true);
startSync();
syncInstallUi();
syncStorageNote();
render(true);
refreshBadges();
noteVersion();
noteNewLook();
noteWelcome();
requestPersistence();
// Reminders for events and tasks (js/reminders.js): they fire while LIFE/OS is open on this device
startReminders().catch((err) => console.error('[life-os] reminders unavailable', err));

if (document.readyState === 'complete') startOfflineSupport();
else window.addEventListener('load', startOfflineSupport, { once: true });

setTimeout(() => {
  helpReady = true;
  syncInstallUi();
}, 1500);

setTimeout(() => checkForUpdate(), 3000);
setInterval(() => checkForUpdate(), UPDATE_CHECK_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate();
});
