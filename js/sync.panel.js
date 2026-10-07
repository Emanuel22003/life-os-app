// LIFE/OS — the Sync dialog: connect this computer to your private GitHub data repository, see
// how sync is doing, sync now or turn it off here. The engine is js/sync.js. syncLabel() is the
// short status the shell shows in the sidebar.

import { h, icon, registerIcon, openModal, confirmDialog, toast, timeAgo, uid } from './ui.js';
import { LOCAL_ORIGIN, SITE_ORIGIN } from './origin.js';
import { syncAvailable, syncConfig, syncStatus, onSyncStatus, syncNow, checkKey, inspect, connect, disconnect, replaceKey, DEVICE } from './sync.js';
import { parseRepo, cleanToken, describeCounts, firstSyncPlan } from './sync.logic.js';

registerIcon('sync', '<path d="M19.5 12a7.5 7.5 0 0 1-13.4 4.6M4.5 12a7.5 7.5 0 0 1 13.4-4.6"/><path d="M18.4 3.8v3.9h-3.9M5.6 20.2v-3.9h3.9"/>');
registerIcon('external', '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');

const DATA_REPO = 'life-os-data';

// What went wrong, in words, and what to do about it
const PROBLEMS = {
  offline: ['You’re offline', 'Your changes stay on this computer and sync when you’re back online.'],
  network: ['Can’t reach GitHub', 'Your changes stay on this computer. Sync tries again every minute.'],
  server: ['GitHub isn’t answering', 'Your changes stay on this computer. Sync tries again every minute.'],
  rate: ['GitHub asked to slow down', 'Sync carries on by itself in a few minutes.'],
  auth: ['The sync key stopped working', 'Keys expire after a year, or this one was deleted on GitHub. Make a new one and paste it below.'],
  access: ['The key can’t save to the repository', `On GitHub, edit the key: under Repository access pick ${DATA_REPO}, and give Contents Read and write.`],
  'not-found': ['Can’t find the repository', `Check that the key can see ${DATA_REPO}: on GitHub, edit the key and pick it under Repository access.`],
  storage: ['This computer’s storage is full', 'Free some space for LIFE/OS in the browser, then sync again.'],
  conflict: ['Another computer kept saving at the same time', 'Sync tries again shortly.'],
  'bad-data': ['A file on GitHub couldn’t be read', 'If it was edited by hand, restore it from the repository’s history.'],
  'other-account': ['That key belongs to another GitHub account', 'Make the key while signed in to the account this computer syncs with.'],
  unknown: ['Sync hit a problem', 'It tries again by itself. If this stays, turn sync off and on again.'],
};

const problem = (kind) => PROBLEMS[kind] ?? PROBLEMS.unknown;

// "On this Mac", "On this PC", "On this phone"
const DEVICE_NAMES = { Mac: 'Mac', Windows: 'PC', iPhone: 'iPhone', iPad: 'iPad', Android: 'phone', Linux: 'computer' };
const deviceName = () => DEVICE_NAMES[DEVICE] ?? 'device';
const isComputer = () => ['Mac', 'Windows', 'Linux'].includes(DEVICE);

/** The sidebar's status words, or null while sync is off (the shell shows its own then). */
export function syncLabel(s = syncStatus()) {
  if (s.state === 'off') return null;
  if (s.state === 'syncing') return 'Syncing…';
  if (s.state === 'error') {
    if (s.error?.kind === 'offline' || s.error?.kind === 'network') return 'Offline · will sync';
    if (s.error?.kind === 'auth') return 'Sync key expired';
    if (['server', 'rate', 'conflict'].includes(s.error?.kind)) return 'Sync waiting';
    return 'Sync needs you';
  }
  if (s.pending) return 'Sync in a moment';
  return s.lastSync ? `Synced · ${timeAgo(s.lastSync)}` : 'Sync on';
}

/** GitHub's form for a new fine-grained key, filled in: name, purpose, a year, Contents read + write. */
function keyFormUrl(owner) {
  const params = [
    ['name', 'LIFE/OS sync'],
    ['description', `Lets the LIFE/OS app keep your data in your private ${DATA_REPO} repository.`],
    ['expires_in', '366'],
    ['contents', 'write'],
  ];
  if (owner) params.push(['target_name', owner]);
  return `https://github.com/settings/personal-access-tokens/new?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// The website lives at <owner>.github.io: the repo owner is known before any key
const siteOwner = () => (location.origin === SITE_ORIGIN ? location.hostname.split('.')[0] : null);

const externalLink = (href, label, cls = 'btn btn--sm') => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', { size: 14 }));

/* ---- The dialog ---- */

let open = null; // the dialog while it's showing: one at a time

export function openSyncPanel() {
  if (open) return;
  if (!syncAvailable) {
    const m = openModal({
      title: 'Sync',
      className: 'sync-modal',
      body: [
        h('p', { class: 'sync-lead' }, 'This is a test copy with its own storage, so it never syncs. Sync lives in your real LIFE/OS.'),
      ],
      footer: [
        h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Close'),
        h('a', { class: 'btn btn--primary', href: `${LOCAL_ORIGIN}/`, target: '_blank', rel: 'noopener' }, 'Open real app'),
      ],
    });
    return;
  }

  const body = h('div', { class: 'sync-body' });
  const foot = h('div', { class: 'sync-foot' });
  let unsubscribe = null;
  const modal = openModal({
    title: 'Sync',
    className: 'sync-modal',
    body,
    footer: foot,
    onClose: () => {
      unsubscribe?.();
      open = null;
    },
  });
  open = modal;

  const show = (nodes, buttons) => {
    unsubscribe?.();
    unsubscribe = null;
    body.replaceChildren(...nodes);
    foot.replaceChildren(...buttons);
    // Focus moves into the new content (the old focused button may be gone)
    requestAnimationFrame(() => (body.querySelector('input:not([type=hidden])') ?? foot.querySelector('.btn--primary') ?? foot.querySelector('button'))?.focus());
  };

  if (syncConfig()) showConnected();
  else showSetup();

  /* ---- Not connected: make a key, paste it ---- */

  function showSetup() {
    const owner = siteOwner();
    const keyInput = h('input', {
      class: 'input sync-key',
      id: `sync-key-${uid()}`,
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'github_pat_…',
      onKeydown: (e) => {
        if (e.key === 'Enter') onConnect();
      },
    });
    const repoInput = h('input', {
      class: 'input',
      id: `sync-repo-${uid()}`,
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: `${owner ?? 'your-name'}/${DATA_REPO}`,
      value: owner ? `${owner}/${DATA_REPO}` : '',
    });
    const message = h('p', { class: 'sync-msg', role: 'status', 'aria-live': 'polite' });
    const connectBtn = h('button', { type: 'button', class: 'btn btn--primary', onClick: onConnect }, 'Connect');

    show(
      [
        h('p', { class: 'sync-lead' }, 'Keep LIFE/OS the same on all your computers. Your data goes to a private GitHub repository that only you can see, and every sync is kept there as a version.'),
        h(
          'ol',
          { class: 'sync-steps' },
          h(
            'li',
            null,
            h('div', { class: 'sync-step-title' }, 'Make a sync key on GitHub'),
            h('p', { class: 'sync-hint' }, 'Under ', h('b', null, 'Repository access'), ' choose ', h('b', null, 'Only select repositories'), ' and pick ', h('code', null, DATA_REPO), '. Everything else is filled in. Click ', h('b', null, 'Generate token'), ' and copy the key.'),
            h('div', null, externalLink(keyFormUrl(owner), 'Open GitHub')),
          ),
          h(
            'li',
            null,
            h('label', { class: 'sync-step-title', for: keyInput.id }, 'Paste the key here'),
            keyInput,
            h('p', { class: 'sync-hint' }, 'It stays on this computer and can only open that one repository.'),
          ),
        ),
        h('details', { class: 'sync-more' }, h('summary', null, 'Different repository'), h('div', { class: 'field' }, h('label', { class: 'label', for: repoInput.id }, 'GitHub repository'), repoInput)),
        message,
      ],
      [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => modal.close() }, 'Cancel'), connectBtn],
    );

    let busy = false;
    async function onConnect() {
      if (busy) return;
      const token = cleanToken(keyInput.value);
      if (!token) {
        message.textContent = keyInput.value.trim() ? 'That doesn’t look like a GitHub key. It starts with github_pat_.' : 'Paste the key from GitHub first.';
        keyInput.focus();
        return;
      }
      const typedRepo = repoInput.value.trim();
      if (typedRepo && !parseRepo(typedRepo)) {
        message.textContent = 'Write the repository as name/repository, for example you/life-os-data.';
        return;
      }
      busy = true;
      connectBtn.disabled = true;
      try {
        message.textContent = 'Checking the key…';
        const { login } = await checkKey(token);
        const repo = parseRepo(typedRepo)?.full ?? `${login}/${DATA_REPO}`;
        message.textContent = 'Looking at your repository…';
        const counts = await inspect({ token, repo });
        const plan = firstSyncPlan(counts.local, counts.remote);
        if (plan === 'ask') showChoice({ token, repo, login, counts });
        else await finish({ token, repo, login, mode: plan, counts });
      } catch (err) {
        message.textContent = err.kind === 'auth' ? 'GitHub doesn’t accept this key. Copy it again, or make a new one.' : problem(err.kind).join('. ');
      } finally {
        busy = false;
        if (connectBtn.isConnected) connectBtn.disabled = false;
      }
    }
  }

  /* ---- Both sides have data: which wins? ---- */

  function showChoice({ token, repo, login, counts }) {
    const message = h('p', { class: 'sync-msg', role: 'status', 'aria-live': 'polite' });
    const choice = (mode, title, text, primary = false) =>
      h(
        'button',
        { type: 'button', class: ['btn', 'sync-choice-btn', primary && 'btn--primary'], onClick: () => pick(mode) },
        h('span', { class: 'sync-choice-title' }, title),
        h('span', { class: 'sync-choice-text' }, text),
      );
    const buttons = [
      choice('download', 'Use the data from GitHub', 'Replaces what’s on this computer. A backup of it stays on this computer.', true),
      choice('combine', 'Combine both', 'Keeps everything from both. Anything on both sides is merged.'),
      choice('upload', 'Use this computer’s data', 'Replaces the copy on GitHub. The old one stays in its history.'),
    ];
    show(
      [
        h('p', { class: 'sync-lead' }, 'GitHub already has LIFE/OS data, and so does this computer. Which should both have from now on?'),
        h(
          'div',
          { class: 'sync-compare' },
          h('div', { class: 'sync-side' }, h('div', { class: 'label' }, 'On GitHub'), h('div', { class: 'sync-side-counts' }, describeCounts(counts.remote))),
          h('div', { class: 'sync-side' }, h('div', { class: 'label' }, `On this ${deviceName()}`), h('div', { class: 'sync-side-counts' }, describeCounts(counts.local))),
        ),
        h('div', { class: 'sync-choice' }, buttons),
        message,
      ],
      [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => modal.close() }, 'Cancel')],
    );

    let busy = false;
    async function pick(mode) {
      if (busy) return;
      busy = true;
      buttons.forEach((b) => (b.disabled = true));
      try {
        await finish({ token, repo, login, mode, counts });
      } catch (err) {
        message.textContent = problem(err.kind).join('. ');
        buttons.forEach((b) => (b.disabled = false));
      } finally {
        busy = false;
      }
    }
  }

  async function finish({ token, repo, login, mode, counts }) {
    const s = await connect({ token, repo, login, mode });
    if (s.state === 'synced') {
      const what = mode === 'upload' ? `Your data is on GitHub now: ${describeCounts(counts.local)}.` : mode === 'download' ? `Your data is here now: ${describeCounts(counts.remote)}.` : 'Both sides are combined.';
      toast(`Sync is on. ${what}`, { duration: 7000 });
    }
    if (open === modal) showConnected();
  }

  /* ---- Connected ---- */

  function showConnected() {
    const config = syncConfig();
    if (!config) return showSetup();
    const stateLine = h('div', { class: 'sync-state' });
    const problemBox = h('div', { class: 'sync-problem' });
    const syncBtn = h('button', { type: 'button', class: 'btn btn--primary', onClick: () => syncNow() }, icon('sync', { size: 15 }), 'Sync now');
    const offBtn = h('button', { type: 'button', class: 'btn btn--ghost', onClick: onDisconnect }, 'Turn off sync');
    const repoUrl = `https://github.com/${config.repo}`;

    show(
      [
        stateLine,
        problemBox,
        h(
          'dl',
          { class: 'sync-facts' },
          h('dt', null, 'Repository'),
          h('dd', null, h('a', { href: repoUrl, target: '_blank', rel: 'noopener noreferrer' }, config.repo), ' · ', h('a', { href: `${repoUrl}/commits`, target: '_blank', rel: 'noopener noreferrer' }, 'History')),
          h('dt', null, isComputer() ? 'This computer' : 'This device'),
          h('dd', null, DEVICE === 'Browser' ? 'This browser' : DEVICE),
        ),
        h('p', { class: 'sync-hint' }, 'What syncs: tasks, notes, habits, calendar events, focus sessions and workouts. Each computer keeps its own appearance and what’s on screen. Changes upload a few seconds after you make them.'),
      ],
      [offBtn, syncBtn],
    );

    let shownKind = null;
    const render = (s) => {
      if (!syncConfig()) return showSetup();
      stateLine.replaceChildren(
        h('span', { class: ['sync-dot', `is-${s.state}`] }),
        h('span', null, s.state === 'syncing' ? 'Syncing…' : s.state === 'error' ? problem(s.error?.kind)[0] : s.lastSync ? `Synced ${timeAgo(s.lastSync)}` : 'Waiting for the first sync'),
      );
      syncBtn.disabled = s.state === 'syncing';
      const kind = s.state === 'error' ? s.error?.kind : null;
      if (kind === shownKind) return; // keep a half-typed key while the status ticks
      shownKind = kind;
      problemBox.replaceChildren(...(kind ? problemNodes(kind) : []));
    };
    render(syncStatus());
    unsubscribe = onSyncStatus(render);
  }

  function problemNodes(kind) {
    const [, text] = problem(kind);
    const nodes = [h('p', { class: 'sync-hint' }, text)];
    if (kind === 'auth' || kind === 'other-account') {
      const config = syncConfig();
      const input = h('input', { class: 'input sync-key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'New key: github_pat_…', 'aria-label': 'New sync key' });
      const message = h('p', { class: 'sync-msg', role: 'status', 'aria-live': 'polite' });
      const save = async () => {
        const token = cleanToken(input.value);
        if (!token) {
          message.textContent = 'That doesn’t look like a GitHub key. It starts with github_pat_.';
          return;
        }
        message.textContent = 'Checking the key…';
        try {
          await replaceKey(token);
          message.textContent = '';
        } catch (err) {
          message.textContent = err.kind === 'auth' ? 'GitHub doesn’t accept this key either.' : problem(err.kind).join('. ');
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
      });
      nodes.push(
        h('div', { class: 'sync-rekey' }, externalLink(keyFormUrl(config?.login ?? siteOwner()), 'Make a new key'), input, h('button', { type: 'button', class: 'btn btn--sm', onClick: save }, 'Save key')),
        message,
      );
    } else if (kind === 'access' || kind === 'not-found') {
      nodes.push(h('div', null, externalLink('https://github.com/settings/personal-access-tokens', 'Your keys on GitHub')));
    }
    return nodes;
  }

  async function onDisconnect() {
    const ok = await confirmDialog({
      title: 'Turn off sync on this computer?',
      message: 'Your data stays here and on GitHub, and other computers keep syncing. To sync this one again, paste a key again.',
      confirmLabel: 'Turn off',
    });
    if (!ok) return;
    disconnect();
    toast('Sync is off on this computer.');
    if (open === modal) showSetup();
  }
}
