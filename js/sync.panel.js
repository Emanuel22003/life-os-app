// LIFE/OS — the Sync dialog: connect this computer to your own private life-os-data repository on
// GitHub (with a key that lets LIFE/OS read and write it), see how sync is doing, sync now or turn
// it off here. The engine is js/sync.js. syncLabel() is the short status the shell shows in the
// sidebar.

import { h, icon, registerIcon, openModal, confirmDialog, toast, timeAgo, uid } from './ui.js';
import { LOCAL_ORIGIN } from './origin.js';
import { syncAvailable, syncConfig, syncStatus, onSyncStatus, syncNow, checkKey, inspect, connect, disconnect, replaceKey, DEVICE } from './sync.js';
import { parseRepo, cleanToken, describeCounts, firstSyncPlan } from './sync.logic.js';

registerIcon('sync', '<path d="M19.5 12a7.5 7.5 0 0 1-13.4 4.6M4.5 12a7.5 7.5 0 0 1 13.4-4.6"/><path d="M18.4 3.8v3.9h-3.9M5.6 20.2v-3.9h3.9"/>');
registerIcon('external', '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');

const DATA_REPO = 'life-os-data';
// GitHub's form for a new repository, filled in: the name and Private (docs.github.com → "Creating
// a new repository": name and visibility are URL parameters)
const NEW_REPO_URL = `https://github.com/new?name=${DATA_REPO}&visibility=private`;
// GitHub keeps the synced data under its own terms (Connect says so before anything is sent)
const GITHUB_TERMS = 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service';
const GITHUB_PRIVACY = 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement';
const PRIVACY_POLICY = 'legal/privacy.html';

// What went wrong, in words, and what to do about it
const PROBLEMS = {
  offline: ['You’re offline', 'Your changes stay on this computer and sync when you’re back online.'],
  network: ['Can’t reach GitHub', 'Your changes stay on this computer. Sync tries again every minute.'],
  server: ['GitHub isn’t answering', 'Your changes stay on this computer. Sync tries again every minute.'],
  rate: ['GitHub asked to slow down', 'Sync carries on by itself in a few minutes.'],
  auth: ['The sync key stopped working', 'Keys expire after a year, or this one was deleted on GitHub. Make a new one and paste it below.'],
  access: ['The key can’t save to the repository', `On GitHub, edit the key: under Repository access pick ${DATA_REPO}, and give Contents Read and write.`],
  'not-found': ['Can’t find the repository', `Check that the key can see ${DATA_REPO}: on GitHub, edit the key and pick it under Repository access.`],
  // sync.js ensurePrivate: nothing is sent to a repository anyone can read
  public: ['The repository isn’t private', `Anyone could read your data there, so LIFE/OS sends nothing to it. On GitHub open ${DATA_REPO} → Settings → Danger Zone → Change visibility → Private, then try again.`],
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

/**
 * GitHub's form for a new fine-grained key, filled in: name, purpose, a year, Contents read + write.
 * `owner` only from a key already checked (a new key for the same account); otherwise GitHub
 * picks the signed-in account itself, so nobody else's name is ever filled in for a visitor.
 */
function keyFormUrl(owner) {
  const params = [
    ['name', 'LIFE/OS sync'],
    ['description', `Lets LIFE/OS read and write your ${DATA_REPO} repository.`],
    ['expires_in', '366'],
    ['contents', 'write'],
  ];
  if (owner) params.push(['target_name', owner]);
  return `https://github.com/settings/personal-access-tokens/new?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

const externalLink = (href, label, cls = 'btn btn--sm') => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', { size: 14 }));
const inlineLink = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);

/**
 * A field's own error line, right under it: shown with the field marked invalid (aria-invalid,
 * described by the message), focused and scrolled into view; typing in the field clears it.
 * Returns { el, show(text), clear() }.
 */
function fieldError(input) {
  const el = h('p', { class: 'sync-field-error', id: `${input.id}-error`, role: 'alert', hidden: true });
  const clear = () => {
    if (el.hidden) return;
    el.hidden = true;
    el.textContent = '';
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  };
  input.addEventListener('input', clear);
  return {
    el,
    clear,
    show(text) {
      el.textContent = text;
      el.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', el.id);
      input.focus({ preventScroll: true });
      // The field and its message, together in view (a phone's dialog scrolls)
      (input.closest('li, .field') ?? input).scrollIntoView({ block: 'nearest', behavior: 'auto' });
      el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    },
  };
}

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
    // Focus moves into the new content (the old focused button may be gone): the first field, else
    // the main button (the first-connect question's is Combine both, the one that loses nothing).
    // The new content shows from its top: on a short phone the key field sits below the fold, and
    // scrolling to it would hide step 1 (openModal's own first focus scrolls too: undone here)
    requestAnimationFrame(() => {
      (body.querySelector('input:not([type=hidden])') ?? body.querySelector('.btn--primary') ?? foot.querySelector('.btn--primary') ?? foot.querySelector('button'))?.focus({ preventScroll: true });
      body.parentElement.scrollTop = 0;
    });
  };

  if (syncConfig()) showConnected();
  else showSetup();

  /* ---- Not connected: make a key, paste it ---- */

  function showSetup() {
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
      // Empty: Connect uses the key's own account (checkKey), <login>/life-os-data
      placeholder: `your-name/${DATA_REPO}`,
    });
    // A field's problem shows right under it (not at the end of a long dialog, out of sight)
    const keyError = fieldError(keyInput);
    const repoError = fieldError(repoInput);
    const more = h('details', { class: 'sync-more' }, h('summary', null, 'Different repository'), h('div', { class: 'field' }, h('label', { class: 'label', for: repoInput.id }, 'GitHub repository'), repoInput, repoError.el));
    const message = h('p', { class: 'sync-msg', role: 'status', 'aria-live': 'polite' });
    const say = (text) => {
      message.textContent = text;
      if (text) message.scrollIntoView({ block: 'nearest' });
    };
    const connectBtn = h('button', { type: 'button', class: 'btn btn--primary', onClick: onConnect }, 'Connect');

    show(
      [
        h('p', { class: 'sync-lead' }, `Keep LIFE/OS the same on all your computers. Your data goes to a private repository called ${DATA_REPO} in your own GitHub account, and every sync is kept there as a version. Only you, and anyone you give access, can see it.`),
        h('p', { class: 'sync-hint' }, 'No GitHub account yet? It’s free: ', inlineLink('./install.html#github', 'how to make one'), ', then come back here.'),
        h(
          'ol',
          { class: 'sync-steps' },
          h(
            'li',
            null,
            h('div', { class: 'sync-step-title' }, 'Create a private repository named ', h('code', null, DATA_REPO)),
            h('p', { class: 'sync-hint' }, 'The name and ', h('b', null, 'Private'), ' are filled in. Click ', h('b', null, 'Create repository'), '. Already have it? Skip this.'),
            h('div', null, externalLink(NEW_REPO_URL, 'New repository on GitHub')),
          ),
          h(
            'li',
            null,
            h('div', { class: 'sync-step-title' }, 'Make a sync key on GitHub'),
            h('p', { class: 'sync-hint' }, 'Under ', h('b', null, 'Repository access'), ' choose ', h('b', null, 'Only select repositories'), ' and pick ', h('code', null, DATA_REPO), '. Everything else is filled in. Click ', h('b', null, 'Generate token'), ' and copy the key.'),
            h('div', null, externalLink(keyFormUrl(null), 'New key on GitHub')),
          ),
          h(
            'li',
            null,
            h('label', { class: 'sync-step-title', for: keyInput.id }, 'Paste the key here'),
            keyInput,
            keyError.el,
            h('p', { class: 'sync-hint' }, `It’s saved in this browser on this ${isComputer() ? 'computer' : 'device'} and only ever sent to GitHub. With `,h('b', null, 'Only select repositories'), ' → ', h('code', null, DATA_REPO), ', it can open only that repository.'),
          ),
        ),
        more,
        // What Connect sends where, said before it is clicked (nothing is sent until then)
        h(
          'p',
          { class: 'sync-consent' },
          'Connect sends your LIFE/OS data (tasks, notes, habits, events, focus sessions, workouts, subscriptions, recovery trackers and weights, each version named after the kind of device, like “Mac”) from this device to your own private GitHub repository, where GitHub keeps it under its ',
          inlineLink(GITHUB_TERMS, 'Terms of Service'),
          ' and ',
          inlineLink(GITHUB_PRIVACY, 'Privacy Statement'),
          '; the maker of LIFE/OS never receives it. ',
          inlineLink(PRIVACY_POLICY, 'Privacy policy'),
        ),
        message,
      ],
      [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => modal.close() }, 'Cancel'), connectBtn],
    );

    let busy = false;
    async function onConnect() {
      if (busy) return;
      const token = cleanToken(keyInput.value);
      say('');
      if (!token) return keyError.show(keyInput.value.trim() ? 'That doesn’t look like a GitHub key. It starts with github_pat_.' : 'Paste the key from GitHub first.');
      const typedRepo = repoInput.value.trim();
      if (typedRepo && !parseRepo(typedRepo)) {
        more.open = true;
        return repoError.show('Write the repository as name/repository, for example you/life-os-data.');
      }
      busy = true;
      connectBtn.disabled = true;
      try {
        say('Checking the key…');
        const { login } = await checkKey(token);
        const repo = parseRepo(typedRepo)?.full ?? `${login}/${DATA_REPO}`;
        say('Looking at your repository…');
        const counts = await inspect({ token, repo });
        const plan = firstSyncPlan(counts.local, counts.remote);
        if (plan === 'ask') showChoice({ token, repo, login, counts });
        else await finish({ token, repo, login, mode: plan, counts });
      } catch (err) {
        if (err.kind === 'auth') {
          say('');
          keyError.show('GitHub doesn’t accept this key. Copy it again, or make a new one.');
        } else say(problem(err.kind).join('. '));
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
    // Combine first: it keeps both sides' records (the safe choice); the other two replace one side
    const buttons = [
      choice('combine', 'Combine both', 'Keeps everything from both. Anything on both sides is merged.', true),
      choice('download', 'Use the data from GitHub', 'Replaces what’s on this computer. A backup of it stays on this computer.'),
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
        h('p', { class: 'sync-hint' }, 'What syncs: tasks, notes, habits, calendar events, focus sessions, workouts, subscriptions, recovery trackers and weights. Each computer keeps its own appearance and what’s on screen. Changes upload a few seconds after you make them.'),
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
      const input = h('input', { class: 'input sync-key', id: `sync-rekey-${uid()}`, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'New key: github_pat_…', 'aria-label': 'New sync key' });
      const inputError = fieldError(input);
      const message = h('p', { class: 'sync-msg', role: 'status', 'aria-live': 'polite' });
      const save = async () => {
        const token = cleanToken(input.value);
        message.textContent = '';
        if (!token) return inputError.show(input.value.trim() ? 'That doesn’t look like a GitHub key. It starts with github_pat_.' : 'Paste the new key from GitHub first.');
        message.textContent = 'Checking the key…';
        try {
          await replaceKey(token);
          message.textContent = '';
        } catch (err) {
          message.textContent = '';
          if (err.kind === 'auth') inputError.show('GitHub doesn’t accept this key either.');
          else message.textContent = problem(err.kind).join('. ');
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
      });
      nodes.push(
        h('div', { class: 'sync-rekey' }, externalLink(keyFormUrl(config?.login), 'Make a new key'), input, h('button', { type: 'button', class: 'btn btn--sm', onClick: save }, 'Save key'), inputError.el),
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
