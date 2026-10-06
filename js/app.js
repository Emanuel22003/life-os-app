// LIFE/OS — shell: layout, hash router, nav badges, clock, appearance (template + light/dark).
//
// Feature contract (js/features/<id>.js, default export):
//   {
//     id: 'tasks',              // route #/tasks
//     title: 'Tasks',           // nav label + page title
//     icon: 'list',             // ui.icon() name
//     badge() { return '3' },   // optional; short string ('' hides it). Re-read on every store change.
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

import { h, icon, registerIcon, brandMark, emptyState, isTyping, modalOpen, openModal, closeAllModals, onDayChange, toast, ensureToastRegion, skin, num, term, WEEKDAYS_SHORT, MONTHS_SHORT } from './ui.js';
import { settings } from './store.js';
import { DEFAULT_SKIN, SKIN_BOOT, normalizeSkin } from './skins.js';
import { openAppearance, loadSkinFonts } from './appearance.js';
import { installContextMenu } from './contextmenu.js';
import { LOCAL_ORIGIN, isRealCopy } from './origin.js';
import { startSync, syncStatus, onSyncStatus } from './sync.js';
import { openSyncPanel, syncLabel } from './sync.panel.js';

const VERSION = 'v0.9';

// Read before any feature module can seed data: tells a first-ever run from an upgrade
const hadSavedData = hasSavedData();

registerIcon('install', '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M12 7v5.5M9.5 10l2.5 2.5 2.5-2.5"/>');
registerIcon('open-app', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M10 16l5-5M11 11h4v4"/>');
// Nav icons live here, so the nav draws them even if their module fails to load
registerIcon('home', '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>');
registerIcon('timer', '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5M12 2.5V6M18.5 6.5l1.5-1.5"/>');

// Order = nav order and number keys (1 Home … 6 Pomodoro). `short`: the phone tab bar's label.
const MANIFEST = [
  { id: 'home', title: 'Home', icon: 'home' },
  { id: 'tasks', title: 'Tasks', icon: 'list' },
  { id: 'notes', title: 'Notes', icon: 'note' },
  { id: 'habits', title: 'Habits', icon: 'target' },
  { id: 'calendar', title: 'Calendar', icon: 'calendar' },
  { id: 'pomodoro', title: 'Pomodoro', icon: 'timer', short: 'Timer' },
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

/* ---- Appearance: template (settings.skin) + light/dark (settings.theme) ----
   Cosmetic only. index.html's head script applies both before the first paint; this keeps
   them in step with settings (the picker, the quick toggle, other tabs). */

const themeButtons = [];
const installButtons = [];
let shownSkin = null; // the template the current page was rendered with

function applyAppearance(s) {
  const root = document.documentElement;
  const next = normalizeSkin(s.skin);
  const theme = s.theme === 'light' ? 'light' : 'dark';
  const previous = root.dataset.skin;
  root.dataset.skin = next;
  root.dataset.theme = theme;
  loadSkinFonts(next);
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
}

const toggleTheme = () => settings.update({ theme: settings.get().theme === 'light' ? 'dark' : 'light' });

// Pages print numbers and words for the template they were rendered with (ui.idx/num/term):
// re-render the page, keeping its scroll. A dialog stays open, so the page waits until it closes
// (the picker re-renders on close; any other dialog leaves it to the next navigation).
function refreshForSkin() {
  syncShellCopy();
  if (!modalOpen()) remountView();
}

function remountView() {
  const top = main.scrollTop;
  render(true);
  main.scrollTop = top;
}

function openPicker() {
  openAppearance({
    onClose: () => {
      if (shownSkin !== skin()) remountView();
    },
  });
}

// The sidebar's status, mirrored in the top bar where the sidebar is hidden (phones, narrow app windows)
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

const badgeEls = new Map(FEATURES.map((f) => [f.id, []]));
const navLinks = [];

const badge = (id) => {
  const el = h('span', { class: 'nav-badge mono', 'aria-hidden': 'true' });
  badgeEls.get(id).push(el);
  return el;
};

const navHeading = h('div', { class: 'nav-heading label' });

// Wording that depends on the template (Simple speaks plainly)
function syncShellCopy() {
  navHeading.textContent = term('shell.nav', 'Modules');
  const sync = syncStatus();
  sysText.textContent = syncLabel(sync) ?? (isRealCopy ? term('shell.status', 'Local · Saved') : 'Test copy');
  sysStatus.dataset.sync = sync.state;
}

const sidebar = h(
  'aside',
  { class: 'sidebar' },
  h('div', { class: 'brand' }, brandMark(), h('span', { class: 'brand-name' }, 'LIFE/OS'), h('span', { class: 'brand-version' }, VERSION)),
  h(
    'nav',
    { class: 'nav', 'aria-label': 'Modules' },
    navHeading,
    FEATURES.map((f, i) => {
      const a = h(
        'a',
        { class: 'nav-item', href: `#/${f.id}`, dataset: { id: f.id }, title: `${f.title} (${i + 1})` },
        h('span', { class: 'nav-index lo-deco' }, String(i + 1).padStart(2, '0')),
        icon(f.icon),
        h('span', { class: 'nav-label' }, f.title),
        badge(f.id),
      );
      navLinks.push(a);
      return a;
    }),
  ),
  h(
    'div',
    { class: 'sidebar-foot' },
    sysStatus,
    h('button', {
      type: 'button',
      class: 'btn btn--sm install-btn',
      hidden: true,
      ref: (el) => installButtons.push(el),
      onClick: onInstallClick,
    }),
    h(
      'div',
      { class: 'appearance-row' },
      h(
        'button',
        { type: 'button', class: 'btn btn--sm btn--ghost appearance-btn', 'aria-label': 'Appearance', title: 'Appearance: template and light or dark mode', onClick: openPicker },
        icon('palette'),
        h('span', { class: 'appearance-label' }, 'Appearance'),
      ),
      h('button', {
        type: 'button',
        class: 'btn btn--sm btn--ghost btn--icon theme-toggle',
        ref: (el) => themeButtons.push(el),
        onClick: toggleTheme,
      }),
    ),
  ),
);

const crumbCurrent = h('span', { class: 'crumb-current' });
const topbarWidgets = h('div', { class: 'topbar-widgets' });
// The centre of the top bar (the Pomodoro mini timer); on phones it docks above the tab bar
const topbarCenter = h('div', { class: 'topbar-center' });
const clockDate = h('span', { class: 'label topbar-date' });
const clockTime = h('span', { class: 'clock' });

const topbar = h(
  'header',
  { class: 'topbar' },
  h('div', { class: 'crumbs label' }, h('span', null, 'LIFE/OS'), h('span', { class: 'crumb-sep' }, '/'), crumbCurrent),
  topbarCenter,
  h(
    'div',
    { class: 'topbar-end' },
    topbarWidgets,
    h(
      'div',
      { class: 'topbar-meta' },
      testCopyTag,
      topbarStatus,
      clockDate,
      clockTime,
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--icon btn--sm install-toggle-mobile',
        hidden: true,
        ref: (el) => installButtons.push(el),
        onClick: onInstallClick,
      }),
      h(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--icon btn--sm sync-toggle-mobile', 'aria-label': 'Sync', title: 'Sync', onClick: openSyncPanel },
        icon('sync'),
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--icon btn--sm appearance-toggle-mobile', 'aria-label': 'Appearance', title: 'Appearance', onClick: openPicker },
        icon('palette'),
      ),
      h('button', {
        type: 'button',
        class: 'btn btn--ghost btn--icon btn--sm theme-toggle-mobile',
        ref: (el) => themeButtons.push(el),
        onClick: toggleTheme,
      }),
    ),
  ),
);

const main = h('main', { class: 'main', id: 'main' });

const tabbar = h(
  'nav',
  { class: 'tabbar', 'aria-label': 'Modules' },
  FEATURES.map((f) => {
    const a = h(
      'a',
      { class: 'tab', href: `#/${f.id}`, dataset: { id: f.id }, title: f.short ? f.title : null },
      icon(f.icon, { size: 20 }),
      h('span', { class: 'tab-label' }, f.short ?? f.title),
      badge(f.id),
    );
    navLinks.push(a);
    return a;
  }),
);

const shell = h('div', { class: 'shell' }, sidebar, topbar, main, tabbar);
document.getElementById('app').replaceChildren(shell);
// Right-click menu (Copy · Paste · Delete · Duplicate) over every module's items and blank areas
installContextMenu(main);
ensureToastRegion();

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

let activeId = null;
let cleanup = null;

function routeId() {
  const m = location.hash.match(/^#\/([\w-]+)/);
  return m && FEATURES.some((f) => f.id === m[1]) ? m[1] : FEATURES[0].id;
}

function render(force = false) {
  const id = routeId();
  if (id === activeId && !force) return;

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
  main.replaceChildren(view);
  main.scrollTop = 0;

  try {
    const ret = feature.mount(view);
    cleanup = typeof ret === 'function' ? ret : null;
  } catch (err) {
    console.error(`[life-os] "${id}" failed to render`, err);
    view.replaceChildren(emptyState({ icon: 'zap', title: `${feature.title} crashed`, text: String(err?.message ?? err) }));
  }

  shownSkin = skin();
  navLinks.forEach((a) => (a.dataset.id === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  crumbCurrent.textContent = feature.title;
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
      value = f.badge ? String(f.badge() ?? '') : '';
    } catch (err) {
      console.error(`[life-os] badge for "${f.id}" failed`, err);
    }
    badgeEls.get(f.id).forEach((el) => {
      if (el.textContent !== value) el.textContent = value;
    });
  }
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
  clockDate.textContent = `${WEEKDAYS_SHORT[d.getDay()]} ${num(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  clockTime.replaceChildren(`${pad(d.getHours())}:${pad(d.getMinutes())}`, h('span', { class: 'clock-seconds lo-deco' }, `:${pad(d.getSeconds())}`));
}

tick();
setInterval(tick, 1000);

/* ---- Global shortcuts: 1..n switch modules ---- */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= FEATURES.length) {
    e.preventDefault();
    location.hash = `#/${FEATURES[n - 1].id}`;
  }
});

/* ---- Install as an app ---- */

const standaloneQuery = matchMedia('(display-mode: standalone)');
const isStandalone = () => standaloneQuery.matches || navigator.standalone === true;

let installPrompt = null; // Chrome's beforeinstallprompt event, usable once
let helpReady = false; // offer help only after Chrome had a moment to offer its prompt

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
  toast('LIFE/OS is installed. Open it from the Dock, Launchpad or Spotlight.', { duration: 6000 });
  // Chrome usually grants installed apps persistent storage
  requestPersistence();
});

standaloneQuery.addEventListener?.('change', () => {
  if (isStandalone()) markInstalled(true);
  syncInstallUi();
  syncStorageNote();
});

// The app window may record the install while this tab is open
settings.subscribe(() => syncInstallUi());

const INSTALL_MODES = {
  real: { text: 'Open real app', icon: 'open-app', title: `This is a test copy with its own storage. Your LIFE/OS is at ${LOCAL_ORIGIN}` },
  prompt: { text: 'Install app', icon: 'install', title: 'Install LIFE/OS as a Mac app: its own window and Dock icon, works offline' },
  help: { text: 'How to install', icon: 'install', title: 'How to install LIFE/OS as a Mac app' },
  open: { text: 'Open in app', icon: 'open-app', title: 'LIFE/OS is installed on this Mac: open the app instead of this tab' },
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
    const iconOnly = btn.classList.contains('install-toggle-mobile');
    if (btn.dataset.mode === mode) continue;
    btn.dataset.mode = mode;
    // Chrome's own prompt is the one worth a solid button; the fallbacks stay quiet
    if (!iconOnly) btn.classList.toggle('btn--ghost', mode !== 'prompt');
    btn.replaceChildren(icon(iconName), h('span', { class: iconOnly ? 'install-label sr-only' : 'install-label' }, text));
    // The accessible name is the visible text (also when only the icon shows)
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
  if (/Chrom|Edge|Opera|Brave/.test(brands) || /Chrome\/|Edg\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua) && !/Android/.test(ua)) return 'safari';
  return 'other';
}

const helpSteps = (...items) => h('ol', { class: 'install-steps' }, items.map((item) => h('li', null, h('span', null, item))));
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
      ['Confirm. LIFE/OS opens in its own window, with a Dock icon, a place in Launchpad and in ⌘ Tab.'],
      ['To keep it in the Dock: right-click its icon → Options → Keep in Dock.'],
    ),
    helpNote('Same data as this tab: the app reads the same storage, nothing is copied or reset. It also opens when start.command isn’t running.'),
    uninstallNote(),
  ];
  const safari = [
    helpSteps([helpStrong('File → Add to Dock…'), ' (macOS Sonoma or later).'], ['Confirm the name, then click ', helpStrong('Add'), '. LIFE/OS appears in the Dock and Launchpad.']),
    helpNote(helpStrong('Your data won’t come along: '), 'a Safari web app keeps its own website data, separate from every browser. Install from the browser that holds your data, or back it up first (README → Where your data lives).'),
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
      h('p', { class: 'muted' }, 'Run LIFE/OS like a Mac app: its own window and Dock icon, no browser tabs.'),
      ...(kind === 'chromium' ? chrome : kind === 'safari' ? safari : other),
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
        ['Open it from the Dock, Launchpad or Spotlight (type ', helpStrong('LIFE/OS'), ').'],
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

async function requestPersistence() {
  const storage = navigator.storage;
  try {
    if (!storage?.persist || !storage.persisted) storageState = 'unsupported';
    else if (await storage.persisted()) storageState = 'persistent';
    else storageState = (await storage.persist()) ? 'persistent' : 'best-effort';
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

function isNewerVersion(a, b) {
  const parts = (v) => String(v ?? '').replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
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

/* ---- Update check: a newer version was deployed while this window is open ---- */

const UPDATE_CHECK_MS = 10 * 60 * 1000;
let offered = null; // { version, toast } of the notice last shown

// periodic: the 10-minute poll may bring back a notice that was dismissed; coming back to the
// window only shows one for a version not offered yet (no nagging on every focus)
async function checkForUpdate({ periodic = false } = {}) {
  if (!isRealCopy || document.hidden) return;
  try {
    // Straight from the local service (the worker never caches version.json); offline it fails
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (typeof version !== 'string' || !isNewerVersion(version, VERSION)) return;
    if (offered?.version === version && (offered.toast.el.isConnected || !periodic)) return;
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

if (isStandalone()) markInstalled(true);
startSync();
syncInstallUi();
syncStorageNote();
render(true);
refreshBadges();
noteVersion();
noteNewLook();
requestPersistence();

if (document.readyState === 'complete') startOfflineSupport();
else window.addEventListener('load', startOfflineSupport, { once: true });

setTimeout(() => {
  helpReady = true;
  syncInstallUi();
}, 1500);

setTimeout(() => checkForUpdate(), 3000);
setInterval(() => checkForUpdate({ periodic: true }), UPDATE_CHECK_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate();
});
