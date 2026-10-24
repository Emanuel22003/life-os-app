// LIFE/OS — Settings (#/settings, the gear at the bottom of the sidebar): sound and notifications,
// appearance, the start page, sync and backups (and deleting all your data), version, the legal
// documents. Every control writes where its setting
// already lives: the timer's sound, notifications and mini timer in the Pomodoro store (they
// sync with your other computers); appearance, motion and the start page in `settings` (this
// computer only). Changes made elsewhere (the Pomodoro page, another window) show here at once.

import { h, icon, pageHeader, dropdown, toast, confirmDialog, openModal, formatDay, dateKey, uid, hiddenTipCount, resetTips, reducedMotion } from '../ui.js';
import { settings, stopSaving } from '../store.js';
import { deleteAllFiles } from '../files.js';
import { SKINS, normalizeSkin, THEMES } from '../skins.js';
import { COLOR_KINDS, normalizeColorPrefs } from '../colors.logic.js';
import { paletteEditor } from '../palette.js';
import { shell } from '../shell.js';
import { SITE_URL } from '../origin.js';
import { syncConfig, syncStatus, onSyncStatus, disconnect } from '../sync.js';
import { openSyncPanel, syncLabel } from '../sync.panel.js';
import { describeCounts } from '../sync.logic.js';
import { pomodoroApi } from './pomodoro.js';
import { buildBackup, parseBackup, backupFileName, startPage, isNewerVersion, isDataKey, keysToDelete, cachesToDelete, storageKeys, pruneBackups, LEGAL_LINKS, SETTINGS_SECTIONS, sectionAt } from './settings.logic.js';

const STORAGE_TEXT = {
  checking: 'Checking how the browser keeps your data…',
  persistent: 'Persistent: the browser won’t clear it to free up space.',
  'best-effort': 'Best effort: the browser may clear it if the disk gets full. Installing the app usually makes it persistent.',
  unsupported: 'Kept in this browser’s storage.',
};

const BACKUP_ERRORS = {
  'not-json': 'That file isn’t a LIFE/OS backup (it can’t be read).',
  'not-lifeos': 'That file isn’t a LIFE/OS backup.',
  newer: 'That backup was made by a newer LIFE/OS. Update this one first (Settings → Check for updates).',
  empty: 'That backup has no LIFE/OS data in it.',
};

/* ---- Small builders ---- */

/**
 * A settings row: title + explanation on the left, the control on the right (on a phone too,
 * on the title's line; `stack` puts a wide control, like a three-way choice, under the text
 * there). Styling hooks only (no behavior): a hint that reports how things are (Sync's status,
 * the version, storage, blocked notifications) rather than explaining the row carries
 * st-row-hint--state (`state`, or per update), so a template that hides explanations (Minimal)
 * keeps it; `key` names the row (data-row) for a template's own rules.
 */
function row({ title, hint, control, state = false, key = null, stack = false }) {
  const id = `st-${uid()}`;
  const hintEl = h('p', { class: ['st-row-hint', state && 'st-row-hint--state'] }, hint ?? '');
  hintEl.hidden = !hint;
  const controlEl = h('div', { class: 'st-row-control' }, typeof control === 'function' ? control(id) : control);
  const el = h(
    'div',
    { class: ['st-row', stack && 'st-row--stack'], dataset: key ? { row: key } : null },
    h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-title', id }, title), hintEl),
    controlEl,
  );
  describeByTitle(controlEl, id);
  return {
    el,
    id,
    hint(text, { state: isState } = {}) {
      hintEl.textContent = text ?? '';
      hintEl.hidden = !text;
      if (isState !== undefined) hintEl.classList.toggle('st-row-hint--state', isState);
    },
  };
}

/**
 * A row's buttons and links are named by their own words ("Delete…"); the row's title describes
 * them, so a screen reader says "Delete…, Delete all my data". Not one that already names itself
 * from the title (a switch, a choice group), sits in a group of its own (the color editor), has its
 * own full name (aria-label) or its own description (title).
 */
function describeByTitle(container, titleId) {
  for (const el of container.querySelectorAll('button, a[href]')) {
    if (el.closest('[aria-labelledby], [role="group"]') || el.hasAttribute('aria-label') || el.hasAttribute('aria-describedby') || el.title) continue;
    el.setAttribute('aria-describedby', titleId);
  }
}

/** On/off switch (the Pomodoro page's, so every template styles it the same). */
function switchControl(labelledBy, onChange) {
  const btn = h(
    'button',
    { type: 'button', class: 'pm-switch st-switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': labelledBy, onClick: () => onChange(btn.getAttribute('aria-checked') !== 'true') },
    h('span', { class: 'pm-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'pm-switch-thumb' })),
  );
  return {
    el: btn,
    set(on, { disabled = false } = {}) {
      btn.setAttribute('aria-checked', String(!!on));
      btn.disabled = disabled;
    },
  };
}

/** Segmented choice: options [{ value, label, icon? }]. */
function segControl(labelledBy, options, onChange) {
  const buttons = options.map((o) =>
    h(
      'button',
      { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { value: o.value }, title: o.title ?? null, onClick: () => onChange(o.value) },
      o.icon ? icon(o.icon, { size: 14 }) : null,
      o.label,
    ),
  );
  return {
    el: h('div', { class: 'seg', role: 'group', 'aria-labelledby': labelledBy }, buttons),
    set(value) {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    },
  };
}

/** A section's card (SETTINGS_SECTIONS: id, title, icon), named by its heading. The heading takes
 *  the focus when the index jumps to it (tabindex -1: reachable that way, not by Tab). */
function card(section, rows) {
  const titleId = `st-sec-${section.id}-title`;
  return h(
    'section',
    { class: 'st-card panel hud', id: `st-sec-${section.id}`, dataset: { section: section.id }, 'aria-labelledby': titleId },
    h('h2', { class: 'st-card-title', id: titleId, tabindex: '-1' }, icon(section.icon, { size: 16 }), h('span', null, section.title)),
    rows.map((r) => r.el),
  );
}

const button = (label, onClick, { iconName, primary = false } = {}) =>
  h('button', { type: 'button', class: ['btn', 'btn--sm', primary && 'btn--primary'], onClick }, iconName ? icon(iconName, { size: 14 }) : null, label);

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---- Backups ---- */

function dataPairs() {
  const pairs = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (isDataKey(key)) pairs.push([key, localStorage.getItem(key)]);
  }
  return pairs;
}

function downloadBackup() {
  const name = backupFileName();
  const doc = buildBackup(dataPairs(), { version: shell.version });
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' }));
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Backup saved to your Downloads: ${name}`, { duration: 6000 });
}

async function restoreBackup(file) {
  let parsed;
  try {
    parsed = parseBackup(await file.text());
  } catch {
    parsed = { error: 'not-json' };
  }
  if (parsed.error) {
    toast(BACKUP_ERRORS[parsed.error] ?? BACKUP_ERRORS['not-lifeos'], { duration: 7000 });
    return;
  }
  const made = parsed.exportedAt && !Number.isNaN(Date.parse(parsed.exportedAt)) ? ` from ${formatDay(dateKey(new Date(parsed.exportedAt)), 'long')}` : '';
  const ok = await confirmDialog({
    title: 'Restore this backup?',
    message: `It has ${describeCounts(parsed.counts)}${made}. It replaces the data on this computer${syncConfig() ? ', and Sync then brings it to your other computers too' : ''}. What’s here now is kept as a backup first.`,
    confirmLabel: 'Restore',
  });
  if (!ok) return;

  // What's here now, kept like the backups Sync makes (lifeos:backup:…)
  const current = Object.fromEntries(dataPairs());
  try {
    localStorage.setItem(`lifeos:backup:before-restore:${new Date().toISOString()}`, JSON.stringify({ reason: 'before restoring a backup file', createdAt: Date.now(), data: current }));
    // Only the newest few backups stay (each is a whole copy of the data)
    pruneBackups(localStorage);
  } catch {
    toast('Not restored: there’s no room to keep a copy of your current data first.', { duration: 7000 });
    return;
  }
  const written = [];
  try {
    for (const [key, value] of parsed.pairs) {
      localStorage.setItem(key, value);
      written.push(key);
    }
  } catch {
    // Half a restore is worse than none: put back what was replaced
    for (const key of written) {
      try {
        if (key in current) localStorage.setItem(key, current[key]);
        else localStorage.removeItem(key);
      } catch {}
    }
    toast('Not restored: the backup doesn’t fit in this browser’s storage. Your data is unchanged.', { duration: 7000 });
    return;
  }
  // Every page re-reads it from scratch
  location.reload();
}

/* ---- Delete all my data (this device) ---- */

// Every open window of LIFE/OS (tabs, the installed app) hears a deletion, stops saving and starts
// again empty, so none of them writes its copy back. Same address only, nothing leaves the device.
const wipeChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('lifeos:delete-all') : null;
wipeChannel?.addEventListener('message', (e) => {
  if (e.data?.type !== 'deleted') return;
  stopSaving();
  // This tab's own sessionStorage (the in-app clipboard): each tab has its own, out of the deleting
  // window's reach. Never localStorage here: a tab that hears this late (one the browser had
  // frozen) would delete what was saved after the deletion
  removeLifeosKeys(['sessionStorage']);
  restartEmpty();
});

// The app's front page, as on a first visit (a reload alone would keep #/settings)
function restartEmpty() {
  history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

// Every lifeos:* key in these storages (by name: reading a blocked one throws, and is skipped)
function removeLifeosKeys(names = ['localStorage', 'sessionStorage']) {
  for (const name of names) {
    try {
      const storage = globalThis[name];
      for (const key of keysToDelete(storageKeys(storage))) storage.removeItem(key);
    } catch {}
  }
}

/**
 * Everything LIFE/OS keeps in this browser: every lifeos:* key (data, settings, the safety
 * backups, the sync key and state, the timer's announcements; the session's clipboard), the
 * pictures in task pages and its offline caches. Then a fresh start. A copy in the person's own GitHub repository is theirs to
 * delete there (the dialog says how); the app can't and shouldn't reach it from here.
 */
async function deleteAllData() {
  stopSaving();
  wipeChannel?.postMessage({ type: 'deleted' });
  disconnect();
  removeLifeosKeys();
  // Pictures in task pages live in their own database (js/files.js)
  await deleteAllFiles();
  try {
    if (globalThis.caches) await Promise.all(cachesToDelete(await caches.keys()).map((name) => caches.delete(name)));
  } catch {}
  // A write already under way (a sync answer, a timer's announcement) may land after the first
  // pass: a second one catches it
  await new Promise((resolve) => setTimeout(resolve, 300));
  removeLifeosKeys();
  restartEmpty();
}

function openDeleteAll() {
  const config = syncConfig();
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const repo = config ? link(`https://github.com/${config.repo}/settings`, config.repo) : h('code', null, 'life-os-data');
  let busy = false;
  const cancelBtn = h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel');
  const deleteBtn = h(
    'button',
    {
      type: 'button',
      // The dialog's main button, filled like every danger confirm (ui.confirmDialog); Cancel has the focus
      class: 'btn btn--danger btn--danger-fill',
      onClick: async () => {
        if (busy) return;
        busy = true;
        deleteBtn.disabled = true;
        cancelBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';
        await deleteAllData();
      },
    },
    'Delete everything',
  );
  const m = openModal({
    title: 'Delete all your LIFE/OS data?',
    className: 'st-delete-modal',
    body: [
      h('p', { class: 'st-delete-lead' }, 'This removes everything LIFE/OS keeps in this browser on this device, then opens it again empty. It can’t be undone.'),
      h('h3', { class: 'st-delete-head' }, 'Deleted from this device'),
      h(
        'ul',
        { class: 'st-delete-list' },
        h('li', null, 'Your tasks, notes, habits, calendar events, focus sessions, workouts, subscriptions, recovery trackers and settings.'),
        h('li', null, 'The safety backups LIFE/OS keeps here (made before a restore or a first sync).'),
        h('li', null, config ? 'Your sync key and sync state: Sync turns off on this device.' : 'Sync’s key and state, if this device was ever connected.'),
        h('li', null, 'The offline copy of the app. It downloads again the next time LIFE/OS opens online.'),
      ),
      h('h3', { class: 'st-delete-head' }, 'Not deleted'),
      h(
        'ul',
        { class: 'st-delete-list' },
        h('li', null, 'The copy in your own GitHub repository, if you used Sync. To delete it, on GitHub open ', repo, ' → Settings → Danger Zone → Delete this repository. (GitHub may be able to restore it for up to 90 days.)'),
        h('li', null, 'Your LIFE/OS sync key on GitHub: delete it at ', link('https://github.com/settings/personal-access-tokens', 'github.com/settings/personal-access-tokens'), '.'),
        h('li', null, 'LIFE/OS on your other computers and browsers: delete it there with this same button.'),
        h('li', null, 'Backup files you downloaded.'),
        h('li', null, 'What you allowed the browser, like notifications: change it in the browser’s site settings.'),
      ),
    ],
    footer: [
      h('button', { type: 'button', class: 'btn st-delete-backup', onClick: downloadBackup }, icon('arrow-down', { size: 14 }), 'Download a backup first'),
      cancelBtn,
      deleteBtn,
    ],
    initialFocus: cancelBtn,
  });
}

/* ---- The page ---- */

function mount(root) {
  root.classList.add('st-root');
  const cleanups = [];

  const header = pageHeader({ index: '00', title: 'Settings', subtitle: 'How LIFE/OS looks, sound and notifications, where it opens, and your data.', tipId: 'settings.intro' });

  /* Sound & notifications (the timer's; they sync) */
  let sound;
  const soundRow = row({
    title: 'Sound',
    hint: 'A soft bell when a focus session or a break ends.',
    control: (id) => {
      sound = switchControl(id, (on) => pomodoroApi.setSettings({ sound: on }));
      return [button('Test', () => {
        if (!pomodoroApi.testSound()) toast('This browser can’t play the sound.');
      }, { iconName: 'volume' }), sound.el];
    },
  });

  let notify;
  const notifyRow = row({
    title: 'Notifications',
    hint: '',
    control: (id) => {
      notify = switchControl(id, async (on) => {
        if (!on) return pomodoroApi.setSettings({ notify: false });
        const perm = await pomodoroApi.enableNotifications();
        if (perm === 'granted') toast('Notifications are on.');
        else if (perm === 'denied') toast('Notifications are blocked for LIFE/OS. Allow them in the browser’s site settings.', { duration: 7000 });
        paintTimer();
      });
      return notify.el;
    },
  });

  let mini;
  const miniRow = row({
    title: 'Mini timer',
    hint: 'The small timer that stays in view on every page.',
    stack: true,
    control: (id) => {
      mini = segControl(id, [{ value: 'active', label: 'While running' }, { value: 'always', label: 'Always' }], (v) => pomodoroApi.setSettings({ showMini: v }));
      return mini.el;
    },
  });

  function paintTimer() {
    const s = pomodoroApi.settings();
    const perm = pomodoroApi.notificationState();
    sound.set(s.sound);
    mini.set(s.showMini);
    notify.set(s.notify && perm === 'granted', { disabled: perm === 'unsupported' });
    // No way to show one in this browser: no switch, just the line that says so
    notify.el.hidden = perm === 'unsupported';
    notifyRow.hint(
      perm === 'unsupported'
        ? 'This browser can’t show notifications.'
        : perm === 'denied'
          ? 'Blocked by the browser. Allow notifications for this site in its site settings, then switch them on here.'
          : 'A notification when a timer ends while LIFE/OS is open but you’re in another app or tab.',
      { state: perm === 'unsupported' || perm === 'denied' },
    );
  }

  /* Appearance (this computer). The button names the template in use and opens the Appearance
     dialog (every template shows the name, Minimal too, which hides the explanations) */
  const templateName = h('span', { class: 'st-value' });
  const templateBtn = h('button', { type: 'button', class: 'btn btn--sm st-template-btn', 'aria-label': 'Change the template…', onClick: () => shell.openAppearance() }, icon('palette', { size: 14 }), templateName, icon('chevron-right', { size: 14, className: 'st-chev' }));
  const templateRow = row({ title: 'Template', hint: '', control: templateBtn });

  let theme;
  const themeRow = row({
    title: 'Light or dark',
    hint: 'System follows your computer’s setting.',
    stack: true,
    control: (id) => {
      theme = segControl(
        id,
        THEMES.map((t) => ({ value: t, label: { light: 'Light', dark: 'Dark', system: 'System' }[t], icon: { light: 'sun', dark: 'moon', system: 'monitor' }[t] })),
        (t) => settings.update({ theme: t }),
      );
      return theme.el;
    },
  });

  let motion;
  const motionRow = row({
    title: 'Reduce animations',
    hint: 'Turns off sliding, fading and pulsing. If your computer asks for less motion, LIFE/OS already follows it.',
    control: (id) => {
      motion = switchControl(id, (on) => settings.update({ motion: on ? 'reduced' : 'system' }));
      return motion.el;
    },
  });

  /* Tips: the short explanations on each page, and their "✓ Got it" */
  const tipsBtn = h('button', { type: 'button', class: 'btn btn--sm', onClick: () => { resetTips(); toast('The tips are back on every page.'); } }, 'Show them again');
  const tipsRow = row({
    key: 'tips',
    title: 'Tips',
    hint: 'Short explanations on the pages. “✓ Got it” hides one for good on this device.',
    control: tipsBtn,
  });
  const paintTips = () => {
    const n = hiddenTipCount();
    tipsBtn.disabled = !n;
    tipsRow.hint(n ? `${n} hidden on this device. “✓ Got it” hides one for good.` : 'Short explanations on the pages. “✓ Got it” hides one for good on this device.');
  };

  /* Your own colors for the template showing (with Reset) */
  const palette = paletteEditor();
  const paletteRow = row({
    title: 'Colors',
    hint: 'Change the template’s two or three main colors. Reset brings its own back.',
    control: palette.el,
  });
  paletteRow.el.classList.add('st-row--wide');

  /* Color coding (this computer): one master switch, then one per kind */
  const colorSwitches = new Map();
  const setColorPref = (key, on) => settings.update({ colors: { ...normalizeColorPrefs(settings.get().colors), [key]: on } });
  const colorsRow = row({
    title: 'Color coding',
    hint: 'Give sections, tasks, notes, events and days a color, from their right-click menu or their edit dialog. Off shows everything in the template’s own colors; your colors are kept.',
    control: (id) => {
      const sw = switchControl(id, (on) => setColorPref('on', on));
      colorSwitches.set('on', sw);
      return sw.el;
    },
  });
  const colorKindRows = COLOR_KINDS.map((k) => {
    const r = row({
      key: `color-${k.id}`,
      title: k.name,
      hint: k.hint,
      control: (id) => {
        const sw = switchControl(id, (on) => setColorPref(k.id, on));
        colorSwitches.set(k.id, sw);
        return sw.el;
      },
    });
    r.el.classList.add('st-row--sub');
    return r;
  });

  /* Start-up (this computer) */
  const pageIds = shell.pages.map((p) => p.id);
  let startSelect;
  const startRow = row({
    title: 'Open on',
    hint: 'The page LIFE/OS shows when it starts.',
    control: (id) => {
      startSelect = h(
        'select',
        { class: 'select st-select', 'aria-labelledby': id, onChange: () => settings.update({ startPage: startSelect.value }) },
        shell.pages.map((p) => h('option', { value: p.id }, p.title)),
      );
      return startSelect;
    },
  });

  function paintSettings() {
    const s = settings.get();
    const current = SKINS.find((k) => k.id === normalizeSkin(s.skin));
    templateName.textContent = current?.name ?? 'Change…';
    templateBtn.setAttribute('aria-label', current ? `Template: ${current.name}. Change…` : 'Change the template…');
    templateRow.hint(current?.description ?? '');
    theme.set(THEMES.includes(s.theme) ? s.theme : 'dark');
    motion.set(s.motion === 'reduced');
    const colors = normalizeColorPrefs(s.colors);
    colorSwitches.forEach((sw, key) => sw.set(colors[key], { disabled: key !== 'on' && !colors.on }));
    if (pageIds.length && document.activeElement !== startSelect) startSelect.value = startPage(s.startPage, pageIds);
  }

  /* Sync & backup */
  const syncRow = row({ title: 'Sync', hint: '', state: true, control: button('Open Sync', () => openSyncPanel(), { iconName: 'sync' }) });
  const paintSync = () => syncRow.hint(syncLabel(syncStatus()) ?? 'Off: your data stays on this computer. Turn it on to use LIFE/OS on your other computers too.');

  const backupRow = row({
    title: 'Download a backup',
    hint: 'One file with all your tasks, notes, habits, events, workouts, subscriptions, recovery trackers, timer history and settings. Keep it somewhere safe.',
    control: button('Download', downloadBackup, { iconName: 'arrow-down' }),
  });

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onChange: () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) restoreBackup(file);
    },
  });
  const restoreRow = row({
    title: 'Restore a backup',
    hint: 'Replaces this computer’s data with a backup file. What’s here now is kept as a backup first.',
    control: [button('Choose file…', () => fileInput.click(), { iconName: 'arrow-up' }), fileInput],
  });

  const storageRow = row({ title: 'Storage', hint: STORAGE_TEXT.checking, state: true, control: [] });

  const deleteRow = row({
    key: 'delete-all',
    title: 'Delete all my data',
    hint: 'Removes everything LIFE/OS keeps on this device. It asks first and offers a backup.',
    control: h('button', { type: 'button', class: 'btn btn--sm btn--danger', onClick: openDeleteAll }, icon('trash', { size: 14 }), 'Delete…'),
  });
  async function paintStorage() {
    // The browser answers the persistence question shortly after start-up
    for (let i = 0; i < 20 && shell.storageState() === 'checking'; i++) await new Promise((r) => setTimeout(r, 250));
    let used = '';
    try {
      const { usage } = (await navigator.storage?.estimate?.()) ?? {};
      if (Number.isFinite(usage)) used = ` ${formatBytes(usage)} used, including the offline copy of the app.`;
    } catch {}
    if (root.isConnected) storageRow.hint(`${STORAGE_TEXT[shell.storageState()] ?? STORAGE_TEXT.unsupported}${used}`);
  }

  /* About */
  const versionRow = row({ title: 'Version', hint: `LIFE/OS ${shell.version}`, state: true, control: [] });
  const versionControl = versionRow.el.querySelector('.st-row-control');
  const checkBtn = button('Check for updates', checkUpdates, { iconName: 'sync' });
  versionControl.append(checkBtn);
  describeByTitle(versionControl, versionRow.id);
  async function checkUpdates() {
    checkBtn.disabled = true;
    versionRow.hint(`LIFE/OS ${shell.version} · Checking…`);
    const latest = await shell.latestVersion();
    if (!root.isConnected) return;
    checkBtn.disabled = false;
    if (!latest) {
      versionRow.hint(`LIFE/OS ${shell.version} · Couldn’t check right now (offline?).`);
    } else if (isNewerVersion(latest, shell.version)) {
      versionRow.hint(`LIFE/OS ${shell.version} · ${latest} is ready.`);
      versionControl.replaceChildren(button(`Reload to ${latest}`, () => location.reload(), { iconName: 'sync', primary: true }));
      describeByTitle(versionControl, versionRow.id);
    } else {
      versionRow.hint(`LIFE/OS ${shell.version} · You have the latest version.`);
    }
  }

  // The welcome sheet a new device opens with (js/welcome.js): every page in a line, and the tab
  // bar's pages (also More → Edit tabs on a phone)
  const welcomeRow = row({
    key: 'welcome',
    title: 'Welcome',
    hint: 'What each page does, and which ones the tab bar shows on a phone-sized screen.',
    control: button('Show again', () => shell.openWelcome(), { iconName: 'sparkles' }),
  });

  const elsewhereRow = row({
    title: 'Use it on another computer',
    hint: `Open ${SITE_URL.replace(/^https:\/\//, '')} in Chrome or Edge, install it, then turn on Sync there.`,
    control: [
      button('Copy link', async () => {
        try {
          await navigator.clipboard.writeText(SITE_URL);
          toast('Link copied.');
        } catch {
          toast(SITE_URL, { duration: 8000 });
        }
      }, { iconName: 'ctx-copy' }),
    ],
  });

  /* Legal: the documents next to the app (legal/), each in a new tab */
  const legalRows = LEGAL_LINKS.map((doc) =>
    row({
      key: `legal-${doc.id}`,
      title: doc.label,
      hint: doc.hint,
      control: h('a', { class: 'btn btn--sm', href: doc.href, target: '_blank', rel: 'noopener', 'aria-label': `Open ${doc.label} (new tab)` }, 'Open', icon('external', { size: 14 })),
    }),
  );

  const rowsOf = {
    appearance: [templateRow, themeRow, paletteRow, motionRow, tipsRow],
    colors: [colorsRow, ...colorKindRows],
    sound: [soundRow, notifyRow, miniRow],
    startup: [startRow],
    sync: [syncRow, backupRow, restoreRow, storageRow, deleteRow],
    about: [versionRow, welcomeRow, elsewhereRow],
    legal: legalRows,
  };
  const cards = new Map(SETTINGS_SECTIONS.map((sec) => [sec.id, card(sec, rowsOf[sec.id])]));

  /* The index: a column of the sections beside the cards on wide screens, one jump menu at the
     top on narrower ones (css/features/settings.css picks one). Both mark where you are. */
  let current = SETTINGS_SECTIONS[0].id;
  let pinnedUntil = 0; // after a jump: the section jumped to stays marked while the page glides there
  const indexLinks = SETTINGS_SECTIONS.map((sec) =>
    h(
      'li',
      null,
      h('button', { type: 'button', class: 'st-index-link', dataset: { id: sec.id }, onClick: () => jump(sec.id) }, icon(sec.icon, { size: 15 }), h('span', null, sec.title)),
    ),
  );
  const jumpMenu = dropdown({
    icon: 'list',
    items: SETTINGS_SECTIONS.map((sec) => ({ value: sec.id, label: sec.title, icon: sec.icon })),
    value: current,
    onSelect: (id) => jump(id),
    className: 'st-jump-btn',
    menuLabel: 'Settings sections',
    ariaLabel: ({ picked }) => `Go to a section (now: ${picked?.label ?? ''})`,
  });
  const index = h(
    'nav',
    { class: 'st-index', 'aria-label': 'Settings sections' },
    h('ul', { class: 'st-index-list' }, indexLinks),
    h('div', { class: 'st-jump' }, jumpMenu.el),
  );

  function mark(id) {
    if (!id || id === current) return;
    current = id;
    for (const li of indexLinks) {
      const link = li.firstChild;
      if (link.dataset.id === id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
    jumpMenu.update({ value: id });
  }
  indexLinks[0].firstChild.setAttribute('aria-current', 'location');

  function jump(id) {
    const sec = cards.get(id);
    if (!sec) return;
    sec.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    sec.querySelector('.st-card-title')?.focus({ preventScroll: true });
    pinnedUntil = Date.now() + 900;
    mark(id);
  }

  // Which section is in view: the page's scroll area is the shell's (.main), so any scroll is
  // heard (capture) and measured once a frame
  let spyFrame = 0;
  const spy = () => {
    spyFrame = 0;
    if (!root.isConnected || Date.now() < pinnedUntil) return;
    const scroller = root.closest('.main') ?? document.scrollingElement;
    const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const stickyJump = index.querySelector('.st-jump')?.getClientRects().length ? index.offsetHeight : 0;
    const tops = [...cards].map(([id, el]) => ({ id, top: el.getBoundingClientRect().top - top }));
    const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    mark(sectionAt(tops, { line: stickyJump + 96, atEnd }));
  };
  const onScroll = () => {
    if (!spyFrame) spyFrame = requestAnimationFrame(spy);
  };
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  cleanups.push(() => {
    window.removeEventListener('scroll', onScroll, { capture: true });
    if (spyFrame) cancelAnimationFrame(spyFrame);
  });

  root.append(header, h('div', { class: 'st-layout' }, index, h('div', { class: 'st-cards' }, [...cards.values()])));

  // Live: the timer's settings (Pomodoro page, other windows), this computer's settings, sync
  let timerSig = '';
  cleanups.push(
    pomodoroApi.subscribe((snap) => {
      const sig = JSON.stringify(snap.settings);
      if (sig === timerSig) return;
      timerSig = sig;
      paintTimer();
    }),
  );
  paintSettings();
  cleanups.push(settings.subscribe(paintSettings));
  paintTips();
  cleanups.push(settings.subscribe(paintTips));
  cleanups.push(() => palette.destroy());
  paintSync();
  cleanups.push(onSyncStatus(paintSync));
  paintStorage();
  // A permission changed in the browser's own settings while LIFE/OS was in the background
  const onVisible = () => {
    if (!document.hidden) paintTimer();
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));

  return () => cleanups.forEach((off) => off());
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'gear',
  mount,
};
