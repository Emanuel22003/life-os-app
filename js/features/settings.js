// LIFE/OS — Settings (#/settings, the gear at the bottom of the sidebar): sound and notifications,
// appearance, the start page, sync and backups, version. Every control writes where its setting
// already lives: the timer's sound, notifications and mini timer in the Pomodoro store (they
// sync with your other computers); appearance, motion and the start page in `settings` (this
// computer only). Changes made elsewhere (the Pomodoro page, another window) show here at once.

import { h, icon, pageHeader, toast, confirmDialog, formatDay, dateKey, uid } from '../ui.js';
import { settings } from '../store.js';
import { SKINS, normalizeSkin, THEMES } from '../skins.js';
import { COLOR_KINDS, normalizeColorPrefs } from '../colors.logic.js';
import { paletteEditor } from '../palette.js';
import { shell } from '../shell.js';
import { SITE_URL } from '../origin.js';
import { syncConfig, syncStatus, onSyncStatus } from '../sync.js';
import { openSyncPanel, syncLabel } from '../sync.panel.js';
import { describeCounts } from '../sync.logic.js';
import { pomodoroApi } from './pomodoro.js';
import { buildBackup, parseBackup, backupFileName, startPage, isNewerVersion, isDataKey } from './settings.logic.js';

const PROJECT_URL = 'https://github.com/Emanuel22003/life-os';

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

/** A settings row: title + explanation on the left, the control on the right. */
function row({ title, hint, control }) {
  const id = `st-${uid()}`;
  const hintEl = h('p', { class: 'st-row-hint' }, hint ?? '');
  hintEl.hidden = !hint;
  const el = h(
    'div',
    { class: 'st-row' },
    h('div', { class: 'st-row-text' }, h('div', { class: 'st-row-title', id }, title), hintEl),
    h('div', { class: 'st-row-control' }, typeof control === 'function' ? control(id) : control),
  );
  return {
    el,
    id,
    hint(text) {
      hintEl.textContent = text ?? '';
      hintEl.hidden = !text;
    },
  };
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

const card = (title, rows) => h('section', { class: 'st-card panel hud', 'aria-label': title }, h('h2', { class: 'st-card-title label' }, title), rows.map((r) => r.el));

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

/* ---- The page ---- */

function mount(root) {
  root.classList.add('st-root');
  const cleanups = [];

  const header = pageHeader({ index: '00', title: 'Settings', subtitle: 'Sound and notifications, how LIFE/OS looks, where it opens, and your data.' });

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
    hint: 'The small timer in the middle of the top bar.',
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
    notifyRow.hint(
      perm === 'unsupported'
        ? 'This browser can’t show notifications.'
        : perm === 'denied'
          ? 'Blocked by the browser. Allow notifications for this site in its site settings, then switch them on here.'
          : 'A notification when a timer ends while you’re in another app.',
    );
  }

  /* Appearance (this computer) */
  const templateRow = row({ title: 'Template', hint: '', control: button('Change…', () => shell.openAppearance(), { iconName: 'palette' }) });

  let theme;
  const themeRow = row({
    title: 'Light or dark',
    hint: 'System follows your computer’s setting.',
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
    templateRow.hint(current ? `${current.name}: ${current.description}` : '');
    theme.set(THEMES.includes(s.theme) ? s.theme : 'dark');
    motion.set(s.motion === 'reduced');
    const colors = normalizeColorPrefs(s.colors);
    colorSwitches.forEach((sw, key) => sw.set(colors[key], { disabled: key !== 'on' && !colors.on }));
    if (pageIds.length && document.activeElement !== startSelect) startSelect.value = startPage(s.startPage, pageIds);
  }

  /* Sync & backup */
  const syncRow = row({ title: 'Sync', hint: '', control: button('Open Sync', () => openSyncPanel(), { iconName: 'sync' }) });
  const paintSync = () => syncRow.hint(syncLabel(syncStatus()) ?? 'Off: your data stays on this computer. Turn it on to use LIFE/OS on your other computers too.');

  const backupRow = row({
    title: 'Download a backup',
    hint: 'One file with all your tasks, notes, habits, events, workouts and timer history. Keep it somewhere safe.',
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

  const storageRow = row({ title: 'Storage', hint: STORAGE_TEXT.checking, control: [] });
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
  const versionRow = row({ title: 'Version', hint: `LIFE/OS ${shell.version}`, control: [] });
  const versionControl = versionRow.el.querySelector('.st-row-control');
  const checkBtn = button('Check for updates', checkUpdates, { iconName: 'sync' });
  versionControl.append(checkBtn);
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
    } else {
      versionRow.hint(`LIFE/OS ${shell.version} · You have the latest version.`);
    }
  }

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

  const projectRow = row({
    title: 'Project',
    hint: 'The source and every version, on GitHub (private).',
    control: h('a', { class: 'btn btn--sm', href: PROJECT_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub', icon('external', { size: 14 })),
  });

  root.append(
    header,
    h(
      'div',
      { class: 'st-cards' },
      card('Sound & notifications', [soundRow, notifyRow, miniRow]),
      card('Appearance', [templateRow, themeRow, paletteRow, motionRow]),
      card('Color coding', [colorsRow, ...colorKindRows]),
      card('Start-up', [startRow]),
      card('Sync & backup', [syncRow, backupRow, restoreRow, storageRow]),
      card('About', [versionRow, elsewhereRow, projectRow]),
    ),
  );

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
