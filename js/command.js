// LIFE/OS — Search (⌘K): one field that finds anything and goes there, plus the keyboard
// shortcuts sheet (?).
//
// Opens on ⌘/Ctrl + K (in a text field too; again closes it) and on a `lifeos:command` window event
// (the shell's Search buttons; detail.query fills the field). `?` outside a text field, a
// `lifeos:shortcuts` event or the Search footer opens the shortcuts sheet. app.js imports this file
// for its side effects; it links css/command.css itself (before the templates, so they can restyle
// every .cmd-* class).
//
// It only reads. Each page's data comes through that page's own api (tasksApi, notesApi, …), loaded
// when the search opens: app.js has loaded every page by then, and one that failed only drops its
// results. Choosing a result opens it through the same api (a task's details, a note in Notes, an
// event's day); "New …" goes to the page and presses its N, then types what was searched for into
// the field that opened. Matching and ranking: js/command.logic.js (tested).

import { h, icon, iconBadge, registerIcon, hasIcon, openModal, closeAllModals, isTyping, menuOpen, todayKey, shiftKey, diffDays, formatDay, relativeDay, timeAgo, debounce, term } from './ui.js';
import { readSaved } from './store.js';
import { shell } from './shell.js';
import { rank, runs, snippet, nearness, queryTerms, scoreEntry } from './command.logic.js';

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

if (!hasIcon('keyboard')) registerIcon('keyboard', '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>');
if (!hasIcon('cmd-doc')) registerIcon('cmd-doc', '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>');
if (!hasIcon('cmd-enter')) registerIcon('cmd-enter', '<path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/>');

/* ==========================================================================
   Stylesheet: linked once, before the templates (index.html may link it itself one day)
   ========================================================================== */

function linkStyles() {
  if (document.querySelector('link[data-cmd-css], link[href$="css/command.css"]')) return;
  const link = h('link', { rel: 'stylesheet', href: new URL('../css/command.css', import.meta.url).href, dataset: { cmdCss: '' } });
  const firstSkin = document.querySelector('link[rel="stylesheet"][href*="css/skins/"]');
  if (firstSkin) firstSkin.before(link);
  else document.head.append(link);
}

// Now, so the stylesheet is there (and cached for offline use) long before the first ⌘K
linkStyles();

/* ==========================================================================
   The pages' apis, loaded on first use (already in memory: app.js imported them)
   ========================================================================== */

const MODULES = {
  tasks: () => import('./features/tasks.js'),
  notes: () => import('./features/notes.js'),
  notesLogic: () => import('./features/notes.logic.js'),
  calendar: () => import('./features/calendar.js'),
  calendarStore: () => import('./features/calendar.store.js'),
  calendarLogic: () => import('./features/calendar.logic.js'),
  habits: () => import('./features/habits.js'),
  habitsLogic: () => import('./features/habits.logic.js'),
  finance: () => import('./features/finance.js'),
  financeLogic: () => import('./features/finance.logic.js'),
  pomodoro: () => import('./features/pomodoro.js'),
  training: () => import('./features/training.js'),
  recovery: () => import('./features/recovery.js'),
  recoveryLogic: () => import('./features/recovery.logic.js'),
  health: () => import('./features/health.js'),
  settingsLogic: () => import('./features/settings.logic.js'),
  syncPanel: () => import('./sync.panel.js'),
};

let modsPromise = null;
let mods = {};

function loadModules() {
  modsPromise ??= Promise.all(
    Object.entries(MODULES).map(([name, load]) =>
      load().then(
        (m) => [name, m],
        (err) => {
          console.warn(`[life-os] search: "${name}" unavailable`, err);
          return [name, null];
        },
      ),
    ),
  ).then((list) => (mods = Object.fromEntries(list)));
  return modsPromise;
}

/* ==========================================================================
   Going places: wait for the search to be gone and the page to be up, then act
   ========================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** test() until it returns something truthy (that value), or null after `ms`. */
async function waitFor(test, ms = 1500) {
  const until = Date.now() + ms;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > until) return null;
    await sleep(25);
  }
}

const shownPage = () => document.querySelector('#main > .view')?.dataset.feature ?? null;

/** Pages ignore their keys while any dialog is in the document (a closing one too). */
const dialogsGone = () => waitFor(() => !document.querySelector('.modal-root'), 1000);

/** Show page `id` (if it isn't showing) once the dialogs are gone. -> its view, or null. */
async function go(id) {
  await dialogsGone();
  if (shownPage() !== id) location.hash = `#/${id}`;
  return waitFor(() => document.querySelector(`#main > .view[data-feature="${id}"]`), 1500);
}

/** A key press on the page, as if typed (every page's N listens on the document). */
function press(key, target = document.body) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '', bubbles: true, cancelable: true }));
}

const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type)));

/** Type `text` into the empty field that gets the focus next (the add field N opened). */
async function fillFocused(text) {
  const field = await waitFor(() => {
    const el = document.activeElement;
    return isTextField(el) && !el.value ? el : null;
  }, 900);
  if (!field) return;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.setSelectionRange?.(text.length, text.length);
}

/** "New …": page `id`'s own add flow (its N), with the search text typed in. */
async function newOnPage(id, text = '') {
  if (!(await go(id))) return;
  // The field the focus went back to (where ⌘K was pressed) must not take the text: only the one N opens
  if (isTextField(document.activeElement)) document.activeElement.blur();
  press('n');
  if (text) await fillFocused(text);
}

/** A task's details: tasksApi.reveal(id, { details: true }); a Tasks page that doesn't open them
 *  itself gets its E pressed on the revealed row (E = Details). */
async function openTask(id) {
  const api = mods.tasks?.tasksApi;
  if (!api) return go('tasks');
  await dialogsGone();
  if (!api.reveal(id, { details: true })) return go('tasks');
  const row = await waitFor(() => {
    const el = document.activeElement;
    return el?.dataset?.id === id && el.closest?.('#main') ? el : null;
  }, 1500);
  if (row && !document.querySelector('.modal-root')) press('e', row);
}

/** For a page with no reveal of its own: its item's row (`selector` in the page) scrolled into
 *  view and focused (or the first control in it, when the row itself takes no focus), so Enter
 *  or Tab goes on from there. -> whether the row was there. */
async function spotlight(selector, ms = 800) {
  const shown = (n) => n.getClientRects().length > 0;
  // (the first one on screen: a page may keep another view's copy of the row, hidden)
  const el = await waitFor(() => [...document.querySelectorAll(`#main > .view ${selector}`)].find(shown), ms);
  if (!el) return false;
  // (its name or Edit rather than its tick box or Delete: Enter there would tick or delete it)
  const controls = el.tabIndex >= 0 ? [el] : [...el.querySelectorAll('a[href], button, input, select, [tabindex]')].filter((n) => n.tabIndex >= 0 && !n.disabled && shown(n));
  const risky = '.check, [role="checkbox"], [role="switch"], [aria-pressed], input[type="checkbox"], .btn--danger, [aria-label^="Delete"], [aria-label^="Remove"]';
  const target = controls.find((n) => !n.matches(risky));
  el.scrollIntoView({ block: 'center' });
  target?.focus({ preventScroll: true });
  return true;
}

const byId = (attr, id) => `[data-${attr}="${CSS.escape(String(id))}"]`;

/* ==========================================================================
   What it finds
   ========================================================================== */

// Group order: with nothing typed, then for equal matches (a page before the action: 'money' is
// more likely Finance than New subscription). And their headings
const IDLE_ORDER = ['actions', 'pages'];
const ORDER = ['pages', 'actions', 'tasks', 'notes', 'events', 'habits', 'subscriptions', 'training', 'recovery', 'create'];
const GROUP_LABEL = {
  actions: 'Actions',
  pages: 'Go to',
  tasks: 'Tasks',
  notes: 'Notes',
  events: 'Events',
  habits: 'Habits',
  subscriptions: 'Subscriptions',
  training: 'Training',
  recovery: 'Recovery',
  create: 'Create',
};
// "Show all 12 …"
const GROUP_NOUN = { actions: 'actions', pages: 'pages', tasks: 'tasks', notes: 'notes', events: 'events', habits: 'habits', subscriptions: 'subscriptions', training: 'workouts and routines', recovery: 'trackers' };

// The pages' icons (the nav's) and the other words that find them
const PAGE_INFO = {
  home: { icon: 'home', keywords: 'start overview today dashboard' },
  tasks: { icon: 'list', keywords: 'todo to-do to do' },
  notes: { icon: 'note', keywords: 'write ideas journal' },
  habits: { icon: 'target', keywords: 'streaks check-in routine' },
  calendar: { icon: 'calendar', keywords: 'events schedule agenda week month day' },
  pomodoro: { icon: 'timer', keywords: 'focus timer break' },
  training: { icon: 'dumbbell', keywords: 'workout gym exercise lifting running' },
  finance: { icon: 'wallet', keywords: 'money subscriptions payments bills' },
  recovery: { icon: 'leaf', keywords: 'addiction quit stop sober clean days relapse smoking alcohol' },
  health: { icon: 'heart', keywords: 'weight weigh scale body kg lb pounds kilos trend goal' },
  settings: { icon: 'gear', keywords: 'preferences options backup export import data delete' },
};

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const safeIcon = (name, fallback) => (name && hasIcon(name) ? name : fallback);

function timerAction() {
  const snap = (() => {
    try {
      return mods.pomodoro?.pomodoroApi?.snapshot() ?? null;
    } catch {
      return null;
    }
  })();
  const running = snap?.status === 'running';
  const title = running ? 'Open the timer' : snap?.status === 'paused' ? 'Resume the timer' : snap && snap.phase !== 'focus' ? 'Start the break' : 'Start focus';
  return {
    id: 'act:focus',
    group: 'actions',
    title,
    meta: running ? `${snap.clock} left` : 'Pomodoro',
    keywords: 'pomodoro timer focus start break',
    icon: 'timer',
    tone: 'pomodoro',
    idle: true,
    run: async () => {
      if (!(await go('pomodoro'))) return;
      const api = mods.pomodoro?.pomodoroApi;
      if (api && api.snapshot().status !== 'running') api.start();
    },
  };
}

// The Create rows (something typed): a task, a note, an event, a habit, and first what the page
// you are on makes ("New note “…”" on Notes, "New subscription “…”" on Finance)
const CREATE = ['task', 'note', 'event', 'habit'];
const CREATE_HERE = { notes: 'note', calendar: 'event', habits: 'habit', finance: 'subscription', recovery: 'tracker' };

/** The "New …" actions; with `text`, as the Create rows ("New task “text”"). */
function newActions(text = '') {
  const live = (() => {
    try {
      return !!mods.training?.trainingApi?.getState().session;
    } catch {
      return false;
    }
  })();
  const list = [
    { id: 'task', page: 'tasks', title: 'New task', keywords: 'add todo to-do', icon: 'list', idle: true },
    { id: 'note', page: 'notes', title: 'New note', keywords: 'add write', icon: 'note', idle: true },
    { id: 'event', page: 'calendar', title: 'New event', keywords: 'add calendar appointment meeting', icon: 'calendar', idle: true },
    { id: 'habit', page: 'habits', title: 'New habit', keywords: 'add routine', icon: 'target', idle: true },
    { id: 'subscription', page: 'finance', title: 'New subscription', keywords: 'add payment money finance', icon: 'wallet', add: () => mods.finance?.financeApi?.add },
    { id: 'tracker', page: 'recovery', title: 'New tracker', keywords: 'add recovery addiction quit stop sober', icon: 'leaf', add: () => mods.recovery?.recoveryApi?.add },
    // (the Health page's weight field, in focus)
    { id: 'weight', page: 'health', title: 'Log weight', keywords: 'add health weigh weight scale body kg lb', icon: 'heart', noText: true, add: () => mods.health?.healthApi?.focusAdd },
    // (N on Training starts one; while one is going, it is there to open)
    { id: 'workout', page: 'training', title: live ? 'Open the workout' : 'Start a workout', keywords: 'training gym log exercise new', icon: 'dumbbell', noText: true, add: () => (live ? null : mods.training?.trainingApi?.startSession) },
  ];
  const here = CREATE_HERE[shownPage()];
  const ids = text ? [...new Set([here ?? 'task', ...CREATE])] : list.map((a) => a.id);
  return ids
    .map((id) => list.find((a) => a.id === id))
    .map((a) => ({
      id: `${text ? 'create' : 'act'}:${a.id}`,
      group: text ? 'create' : 'actions',
      title: text ? `${a.title} “${text}”` : a.title,
      plainTitle: !!text,
      keywords: a.keywords,
      icon: text ? 'plus' : a.icon,
      tone: a.page,
      idle: a.idle,
      run: async () => {
        // The page's own api when it has one (Finance's editor, Training's workout), else its N
        const add = text ? null : a.add?.();
        if (typeof add === 'function') {
          if (!(await go(a.page))) return;
          add();
        } else if (a.id === 'workout' && live) await go(a.page);
        else await newOnPage(a.page, a.noText ? '' : text);
      },
    }));
}

function pageEntries() {
  const current = shownPage();
  const nav = shell.pages?.length ? shell.pages : [];
  const out = nav.map((p, i) => ({
    id: `page:${p.id}`,
    group: 'pages',
    title: p.title,
    meta: p.id === current ? 'You are here' : '',
    keywords: PAGE_INFO[p.id]?.keywords ?? '',
    icon: PAGE_INFO[p.id]?.icon ?? 'circle',
    tone: p.id,
    key: i < 9 ? String(i + 1) : '',
    // Going somewhere is what most searches are for: a page wins a tie with a fresh item
    boost: 1,
    idle: true,
    run: () => go(p.id),
  }));
  out.push(
    { id: 'page:settings', group: 'pages', title: 'Settings', meta: current === 'settings' ? 'You are here' : '', keywords: PAGE_INFO.settings.keywords, icon: 'gear', tone: 'settings', boost: 1, idle: true, run: () => go('settings') },
    {
      id: 'page:appearance',
      group: 'pages',
      title: 'Appearance',
      meta: 'Template, light or dark',
      keywords: 'theme template look dark light mode colors colours skin style',
      icon: 'palette',
      idle: true,
      run: async () => {
        await dialogsGone();
        shell.openAppearance();
      },
    },
    {
      id: 'page:shortcuts',
      group: 'pages',
      title: 'Keyboard shortcuts',
      meta: '?',
      keywords: 'keys hotkeys help ?',
      icon: 'keyboard',
      run: async () => {
        await dialogsGone();
        openShortcuts();
      },
    },
  );
  const sync = mods.syncPanel?.openSyncPanel;
  if (sync) {
    out.push({
      id: 'page:sync',
      group: 'pages',
      title: 'Sync',
      meta: 'Keep your computers the same (GitHub)',
      keywords: 'github backup computers devices',
      icon: safeIcon('sync', 'repeat'),
      run: async () => {
        await dialogsGone();
        sync();
      },
    });
  }
  for (const doc of mods.settingsLogic?.LEGAL_LINKS ?? []) {
    out.push({
      id: `page:legal-${doc.id}`,
      group: 'pages',
      title: doc.label,
      meta: 'Opens in a new tab',
      keywords: 'legal',
      icon: 'cmd-doc',
      run: () => window.open(doc.href, '_blank', 'noopener'),
    });
  }
  return out;
}

function dueText(t, today) {
  if (!t.due) return 'No date';
  const days = diffDays(today, t.due);
  const at = t.time ? ` ${t.time}` : '';
  if (days < 0) return `Overdue · ${formatDay(t.due)}`;
  return `${relativeDay(t.due, today)}${at}`;
}

function taskEntries(today) {
  const api = mods.tasks?.tasksApi;
  if (!api) return [];
  const saved = readSaved('tasks')?.sections;
  const sections = new Map((Array.isArray(saved) ? saved : []).filter((s) => s && s.id).map((s) => [s.id, clean(s.name)]));
  return api.getItems().map((t) => {
    const days = t.due ? diffDays(today, t.due) : null;
    const when = t.done ? 'Done' : dueText(t, today);
    const notes = clean(t.notes);
    return {
      id: `task:${t.id}`,
      group: 'tasks',
      title: clean(t.title) || 'Untitled task',
      text: notes,
      snippet: notes,
      lead: when,
      meta: [when, sections.get(t.sectionId), !t.done && t.priority === 'high' ? 'High priority' : ''].filter(Boolean).join(' · '),
      icon: t.done ? 'check-circle' : days !== null && days < 0 ? 'alert' : 'list',
      tone: 'tasks',
      later: !!t.done,
      // Overdue and today first, then the soonest; no date sits in between
      boost: t.done ? 0 : days === null ? 0.2 : days <= 0 ? 1 : nearness(days, 5),
      run: () => openTask(t.id),
    };
  });
}

// A note's plain text, kept while the note is unchanged (flattening markdown is the slow part)
const plainCache = new Map();
const BODY_MAX = 20000;

function plainBody(note) {
  const hit = plainCache.get(note.id);
  if (hit && hit.updatedAt === note.updatedAt) return hit.text;
  const toPlain = mods.notesLogic?.toPlainText;
  const body = String(note.body ?? '').slice(0, BODY_MAX);
  const text = toPlain ? toPlain(body, { separator: ' · ' }) : body.replace(/\s+/g, ' ');
  plainCache.set(note.id, { updatedAt: note.updatedAt, text });
  return text;
}

function noteEntries() {
  const api = mods.notes?.notesApi;
  if (!api) return [];
  const sections = new Map(api.getSections().map((s) => [s.id, clean(s.name)]));
  const now = Date.now();
  return api.recent(Infinity).map((n) => {
    const body = plainBody(n);
    const section = sections.get(n.sectionId) ?? 'Unsorted';
    const title = clean(n.title) || body.split(' · ')[0].slice(0, 80) || 'Untitled';
    return {
      id: `note:${n.id}`,
      group: 'notes',
      title,
      // The section's name finds its notes too (as weakly as the text)
      text: `${body} · ${section}`,
      snippet: body,
      lead: section,
      meta: [section, timeAgo(n.updatedAt, now)].join(' · '),
      icon: n.pinned ? 'pin' : 'note',
      tone: 'notes',
      boost: nearness((now - n.updatedAt) / 86400000, 14) + (n.pinned ? 0.2 : 0),
      run: async () => {
        await dialogsGone();
        if (!api.reveal(n.id)) go('notes');
      },
    };
  });
}

function eventEntries(today) {
  const events = mods.calendarStore?.getEvents?.();
  const L = mods.calendarLogic;
  const cal = mods.calendar?.calendarApi;
  if (!events?.length || !L) return [];
  // Each event's next date (a whole year ahead); one with none left, its last date (two years back)
  const next = new Map();
  for (const o of L.occurrencesInRange(events, today, shiftKey(today, 366))) if (!next.has(o.eventId)) next.set(o.eventId, o);
  const gone = events.filter((e) => !next.has(e.id));
  const last = new Map();
  if (gone.length) for (const o of L.occurrencesInRange(gone, shiftKey(today, -730), shiftKey(today, -1))) last.set(o.eventId, o);
  const out = [];
  for (const ev of events) {
    const occ = next.get(ev.id) ?? last.get(ev.id);
    if (!occ) continue;
    const day = occ.start < today && occ.end >= today ? today : occ.start;
    const days = diffDays(today, day);
    const past = occ.end < today;
    const when = `${relativeDay(day, today)}${occ.allDay ? '' : ` ${occ.startTime}`}`;
    out.push({
      id: `event:${ev.id}`,
      group: 'events',
      title: clean(ev.title) || 'Untitled event',
      text: [clean(ev.location), clean(ev.notes)].filter(Boolean).join(' · '),
      snippet: clean(ev.notes),
      lead: when,
      meta: [when, occ.recurring ? 'Repeats' : '', clean(ev.location)].filter(Boolean).join(' · '),
      icon: occ.recurring ? 'repeat' : 'calendar',
      tone: 'calendar',
      later: past,
      boost: past ? 0 : nearness(days, 7),
      run: async () => {
        await dialogsGone();
        if (!cal?.open(day, 'day')) return go('calendar');
        // The event on that day, in focus (Enter opens it), once the day view is up: until then
        // the page left behind (Home's agenda) or the Calendar's last view (zooming to the day)
        // still shows a copy of it, which goes with that view and takes the focus along
        if (await go('calendar')) spotlight(`.cal-day ${byId('occ', occ.occId)}`);
      },
    });
  }
  return out;
}

function habitEntries(today) {
  const api = mods.habits?.habitsApi;
  const L = mods.habitsLogic;
  if (!api || !L) return [];
  return api.source.getItems().map((hb) => {
    const archived = L.isArchived(hb, today);
    const status = archived ? 'archived' : L.dayStatus(hb, today, today);
    const meta = archived ? 'Archived' : [L.scheduleLabel(hb.schedule ?? []), status === 'done' ? 'Done today' : status === 'pending' ? 'To do today' : ''].filter(Boolean).join(' · ');
    return {
      id: `habit:${hb.id}`,
      group: 'habits',
      title: clean(hb.name) || 'Untitled habit',
      meta,
      icon: safeIcon(L.habitIcon?.(hb), 'target'),
      tone: 'habits',
      later: archived,
      boost: status === 'pending' ? 0.6 : 0,
      run: async () => {
        await dialogsGone();
        if (typeof api.reveal === 'function' && api.reveal(hb.id)) return;
        // Its row on the tab that shows; else the tab that lists it (Check in, or Plan for an
        // archived one: switching tabs is saved, so only when needed)
        if (!(await go('habits'))) return;
        if (await spotlight(byId('id', hb.id), 200)) return;
        api.source.openTab?.(archived ? 'plan' : 'today');
        spotlight(byId('id', hb.id));
      },
    };
  });
}

function subscriptionEntries(today) {
  const api = mods.finance?.financeApi;
  const F = mods.financeLogic;
  if (!api || !F) return [];
  return api.subscriptions().map((s) => {
    const next = F.nextPayment(s, today);
    const price = `${api.money(s.amount, s.currency)} ${F.cycleShort(s)}`;
    const days = next ? diffDays(today, next) : null;
    const when = days === null ? F.STATUS_LABEL?.[s.status] ?? '' : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : days < 7 ? `Due in ${days} days` : `Next ${formatDay(next)}`;
    return {
      id: `sub:${s.id}`,
      group: 'subscriptions',
      title: clean(s.name) || 'Subscription',
      text: [F.categoryName(s.category), clean(s.note)].filter(Boolean).join(' · '),
      meta: [price, when].filter(Boolean).join(' · '),
      icon: safeIcon(F.categoryIcon(s.category), 'wallet'),
      tone: 'finance',
      later: s.status === 'cancelled',
      boost: days === null ? 0 : nearness(days, 7),
      run: async () => {
        if (!(await go('finance'))) return;
        // Its row first, so closing its dialog lands there; then the dialog (Edit)
        await spotlight(byId('id', s.id));
        if (typeof api.edit === 'function') api.edit(s.id);
      },
    };
  });
}

function trainingEntries(today) {
  // trainingApi's state is the upgraded one (workouts newest first); the saved data if it failed to load
  const saved = mods.training?.trainingApi?.getState() ?? readSaved('training');
  if (!saved || typeof saved !== 'object') return [];
  const names = new Map((Array.isArray(saved.exercises) ? saved.exercises : []).filter((x) => x && x.id).map((x) => [x.id, clean(x.name)]));
  const out = [];
  for (const r of Array.isArray(saved.routines) ? saved.routines : []) {
    if (!r || !r.id || !clean(r.name)) continue;
    const ex = (Array.isArray(r.items) ? r.items : []).map((it) => names.get(it?.exerciseId)).filter(Boolean);
    out.push({
      id: `routine:${r.id}`,
      group: 'training',
      title: clean(r.name),
      text: ex.join(' · '),
      meta: `Routine · ${ex.length} ${ex.length === 1 ? 'exercise' : 'exercises'}`,
      icon: safeIcon('tr-routine', 'dumbbell'),
      tone: 'training',
      boost: 0.3,
      run: async () => (await go('training')) && spotlight(byId('id', r.id)),
    });
  }
  const workouts = (Array.isArray(saved.workouts) ? saved.workouts : []).filter((w) => w && w.id && /^\d{4}-\d{2}-\d{2}$/.test(w.date));
  for (const w of workouts.slice(0, 300)) {
    const ex = [...new Set((Array.isArray(w.entries) ? w.entries : []).map((e) => names.get(e?.exerciseId)).filter(Boolean))];
    out.push({
      id: `workout:${w.id}`,
      group: 'training',
      title: clean(w.title) || `Workout ${formatDay(w.date)}`,
      text: [ex.join(' · '), clean(w.note)].filter(Boolean).join(' · '),
      meta: [relativeDay(w.date, today), ex.slice(0, 3).join(', ')].filter(Boolean).join(' · '),
      icon: 'dumbbell',
      tone: 'training',
      boost: nearness(diffDays(w.date, today), 14),
      run: async () => {
        if (!(await go('training'))) return;
        // Its card first (when the log shows it), so closing its dialog lands there; then the dialog
        await spotlight(byId('id', w.id), 400);
        mods.training?.trainingApi?.openWorkout?.(w.id);
      },
    });
  }
  return out;
}

function recoveryEntries(today) {
  const api = mods.recovery?.recoveryApi;
  const R = mods.recoveryLogic;
  if (!api || !R) return [];
  return R.orderedTrackers(api.trackers()).map((t) => ({
    id: `tracker:${t.id}`,
    group: 'recovery',
    title: clean(t.name) || 'Tracker',
    meta: [R.statusText(t, today), t.archived ? 'Archived' : ''].filter(Boolean).join(' · '),
    icon: safeIcon(R.trackerIcon(t), 'leaf'),
    tone: 'recovery',
    later: t.archived,
    run: async () => {
      // Shown on its page (this device's choice), its card in focus
      api.select(t.id);
      if (!(await go('recovery'))) return;
      await waitFor(() => document.querySelector('#main > .view[data-feature="recovery"] .rc-hero'), 800);
      api.reveal(t.id);
    },
  }));
}

/** Everything searchable right now. Each source on its own: one that throws only drops its part. */
function buildEntries() {
  const today = todayKey();
  const out = [];
  const take = (name, fn) => {
    try {
      out.push(...fn());
    } catch (err) {
      console.error(`[life-os] search: ${name} skipped`, err);
    }
  };
  take('actions', () => [...newActions().slice(0, 4), timerAction(), ...newActions().slice(4)]);
  take('pages', pageEntries);
  take('tasks', () => taskEntries(today));
  take('notes', noteEntries);
  take('events', () => eventEntries(today));
  take('habits', () => habitEntries(today));
  take('subscriptions', () => subscriptionEntries(today));
  take('training', () => trainingEntries(today));
  take('recovery', () => recoveryEntries(today));
  return out;
}

/* ==========================================================================
   The search dialog
   ========================================================================== */

let palette = null; // { close, input, setQuery } while the search shows
let seq = 0;

function textRuns(text, hits) {
  return runs(text, hits).map((r) => (r.hit ? h('mark', { class: 'cmd-hit' }, r.text) : r.text));
}

function openSearch({ query = '' } = {}) {
  if (palette) {
    if (query) palette.setQuery(query);
    palette.input.focus();
    return;
  }
  const listId = `cmd-list-${++seq}`;
  let entries = buildEntries();
  let rows = []; // [{ el, entry }] in list order
  let active = 0;
  const expanded = new Set();

  const input = h('input', {
    class: 'cmd-input',
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-label': 'Search LIFE/OS',
    // (a phone's field is narrow: the short one)
    placeholder: matchMedia('(max-width: 640px)').matches ? 'Search everything' : 'Search tasks, notes, events, pages…',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    value: query,
  });
  const list = h('div', { class: 'cmd-list', id: listId, role: 'listbox', 'aria-label': 'Results' });
  // (outside the listbox, which may hold only groups and options)
  const none = h('p', { class: 'cmd-none', hidden: true });
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost btn--sm cmd-cancel', onClick: () => m.close() }, 'Cancel');
  const field = h(
    'div',
    { class: 'cmd-field' },
    h('span', { class: 'cmd-field-icon', 'aria-hidden': 'true' }, icon('search', { size: 18 })),
    input,
    h('span', { class: 'kbd cmd-esc lo-hint', 'aria-hidden': 'true' }, 'esc'),
    cancel,
  );
  const hint = (keys, text) => h('span', { class: 'cmd-hint' }, keys.map((k) => h('span', { class: 'kbd' }, k)), h('span', null, text));
  const foot = h(
    'div',
    { class: 'cmd-foot' },
    h('span', { class: 'cmd-hints lo-hint', 'aria-hidden': 'true' }, hint(['↑', '↓'], 'Move'), hint(['↵'], 'Open'), hint([`${MOD} K`], 'Close')),
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--sm cmd-keys-btn',
        onClick: () => {
          closeAllModals();
          openShortcuts();
        },
      },
      icon('keyboard'),
      h('span', null, 'Shortcuts'),
      h('span', { class: 'kbd lo-hint', 'aria-hidden': 'true' }, '?'),
    ),
  );

  const announce = debounce((text) => (status.textContent = text), 350);

  function setActive(i, { scroll = true } = {}) {
    if (!rows.length) {
      active = 0;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.el.setAttribute('aria-selected', String(k === active)));
    const el = rows[active].el;
    input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function row(entry, hits, terms) {
    const i = rows.length;
    let meta = entry.meta ? [entry.meta] : [];
    // A match only in the text (a note's body, a task's or an event's notes): show where, after
    // the row's first fact (the section, the day)
    if (terms.length && entry.snippet && !scoreEntry({ title: entry.title }, terms)) {
      const piece = snippet(entry.snippet, terms, 90);
      if (piece) meta = [entry.lead ? `${entry.lead} · ` : '', ...textRuns(piece.text, piece.hits)];
    }
    const el = h(
      'div',
      { class: ['cmd-item', entry.later && 'is-later', entry.more && 'is-more'], id: `${listId}-${i}`, role: 'option', 'aria-selected': 'false', dataset: { i: String(i) } },
      iconBadge(entry.icon ?? 'circle', { tone: entry.tone ?? null, size: 15, className: 'cmd-ib' }),
      h('span', { class: 'cmd-text' }, h('span', { class: 'cmd-title' }, entry.plainTitle ? entry.title : textRuns(entry.title, hits)), meta.length ? h('span', { class: 'cmd-meta' }, meta) : null),
      entry.key ? h('span', { class: 'kbd cmd-key lo-hint', 'aria-hidden': 'true' }, entry.key) : null,
      h('span', { class: 'cmd-enter', 'aria-hidden': 'true' }, icon('cmd-enter', { size: 14 })),
    );
    rows.push({ el, entry });
    return el;
  }

  function render({ keep = false, at = null } = {}) {
    const q = input.value;
    const terms = queryTerms(q);
    const groups = rank(entries, q, { order: terms.length ? ORDER : IDLE_ORDER, limit: 5, expanded: [...expanded] });
    // Something typed that no action covers: offer to make it
    const text = q.replace(/\s+/g, ' ').trim();
    const found = groups.reduce((n, g) => n + g.total, 0);
    // (one row when something was found, all of them when nothing was)
    if (text && !groups.some((g) => g.group === 'actions')) {
      const create = newActions(text).slice(0, found ? 1 : undefined);
      groups.push({ group: 'create', items: create.map((entry) => ({ entry, hits: [] })), total: create.length });
    }
    const before = keep ? rows[active]?.entry.id : null;
    rows = [];
    const nodes = [];
    none.hidden = !(text && !found);
    none.textContent = none.hidden ? '' : `Nothing found for “${text}”.`;
    for (const g of groups) {
      const headId = `${listId}-g-${g.group}`;
      const items = g.items.map((it) => row(it.entry, it.hits, terms));
      if (g.total > g.items.length) {
        const label = `Show all ${g.total} ${GROUP_NOUN[g.group] ?? GROUP_LABEL[g.group].toLowerCase()}`;
        items.push(row({ id: `more:${g.group}`, more: g.group, title: label, plainTitle: true, icon: 'more' }, [], []));
      }
      nodes.push(h('div', { class: 'cmd-section', role: 'group', 'aria-labelledby': headId }, h('div', { class: 'cmd-group label', id: headId }, GROUP_LABEL[g.group]), items));
    }
    list.replaceChildren(...nodes);
    const again = at ?? (before ? rows.findIndex((r) => r.entry.id === before) : -1);
    setActive(again >= 0 ? again : 0, { scroll: false });
    // Scrolled on the next frame: no forced layout while typing
    requestAnimationFrame(() => {
      if (!list.isConnected) return;
      if (keep) rows[active]?.el.scrollIntoView({ block: 'nearest' });
      else list.scrollTop = 0;
    });
    announce(text ? (found ? `${found} ${found === 1 ? 'result' : 'results'}` : 'No results') : '');
  }

  function choose(i) {
    const picked = rows[i]?.entry;
    if (!picked) return;
    if (picked.more) {
      // The group opens in place; the first item it adds is lit (where "Show all" was)
      expanded.add(picked.more);
      render({ keep: true, at: i });
      input.focus();
      return;
    }
    // The search (and a sheet it was opened from) goes; then the page acts
    closeAllModals();
    Promise.resolve()
      .then(() => picked.run?.())
      .catch((err) => console.error('[life-os] search: opening the result failed', err));
  }

  input.addEventListener('input', () => {
    expanded.clear();
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const emacs = IS_MAC && e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'ArrowDown' || (emacs && e.key === 'n')) {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp' || (emacs && e.key === 'p')) {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const step = e.key === 'PageDown' ? 5 : -5;
      setActive(Math.max(0, Math.min(rows.length - 1, active + step)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  });
  // The pointer lights what it moves over (not what scrolls under a still one) and picks on click;
  // the field keeps the focus
  list.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('.cmd-item');
    if (el && Number(el.dataset.i) !== active) setActive(Number(el.dataset.i), { scroll: false });
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const el = e.target.closest?.('.cmd-item');
    if (el) choose(Number(el.dataset.i));
  });

  // Phones: the sheet ends above the on-screen keyboard
  const vv = window.visualViewport;
  const fit = () => m.el.style.setProperty('--cmd-vh', `${Math.round(vv.height)}px`);

  const m = openModal({
    title: 'Search',
    className: 'cmd-modal',
    body: [field, none, list, status, foot],
    initialFocus: input,
    onClose: () => {
      palette = null;
      announce.cancel();
      vv?.removeEventListener('resize', fit);
    },
  });
  m.el.parentElement?.classList.add('cmd-root');
  // The field takes the keys at once (openModal focuses on the next frame: a quick typist's
  // first letters would be lost)
  input.focus({ preventScroll: true });
  // (on resize only: reading the height now would force a layout of the whole page)
  vv?.addEventListener('resize', fit);
  palette = {
    close: () => m.close(),
    input,
    setQuery(q) {
      input.value = q;
      expanded.clear();
      render();
    },
  };
  render();
  if (query) input.select();
  // The pages' data (in memory already): fill in the results as soon as it is there
  if (!modsPromise || !Object.keys(mods).length) {
    loadModules().then(() => {
      if (!palette || palette.input !== input) return;
      entries = buildEntries();
      render({ keep: true });
    });
  }
}

/* ==========================================================================
   The keyboard shortcuts sheet (?)
   ========================================================================== */

/** [keys, what] rows; keys: an array of key groups ('⌘ K' is one key chord). */
function everywhere() {
  const pages = shell.pages?.length ? shell.pages : [];
  return [
    [[`${MOD} K`], 'Search, and go anywhere (writing in a task’s page: a link)'],
    [['?'], 'This list'],
    pages.length ? [['1', '…', String(Math.min(9, pages.length))], 'Go to a page (its number in the menu)'] : null,
    [['N'], 'New item on the page you are on (task, note, habit, event…)'],
    [['Esc'], 'Close a dialog, menu or the editor'],
    [['Shift F10'], 'The right-click menu of the item in focus'],
    [[`${MOD} C`, `${MOD} V`, `${MOD} D`], 'Copy, paste or duplicate the item in focus'],
    [['Delete'], 'Delete the item in focus'],
  ].filter(Boolean);
}

// Each page's own keys (the README's tables, short), as the page names things in this template
const pageKeys = () => ({
  home: [
    [['Q'], 'Quick note'],
    [['N', '/'], 'Add a to-do'],
    [['←', '→'], 'Previous / next day, week or month (the calendar)'],
    [['T'], 'Back to today'],
    [['D', 'W', 'M'], 'The calendar shows a day, the week or the month'],
  ],
  tasks: [
    [['N', '/'], 'Add a task'],
    [['Enter'], 'In the add bar: next step (priority, when, section), or add'],
    [[`${MOD} Enter`], 'In the add bar: add now'],
    [['↑', '↓'], 'Move between tasks (also J and K)'],
    [['Space', 'X'], 'Done / not done'],
    [['Enter', 'F2'], 'Rename'],
    [['E'], 'Details'],
    [['O'], 'Open the task’s page (Esc closes it)'],
    [[`${MOD} B`, `${MOD} K`], 'Writing in a task’s page: bold, link'],
    [[`${ALT} ↑`, `${ALT} ↓`], `Move up / down (sort: ${term('tasks.sort.manual', 'Manual')})`],
    [[`${MOD} Z`], 'Undo the latest change'],
  ],
  notes: [
    [['N'], 'New note'],
    [['/'], 'Search the notes'],
    [['E'], 'Write in the open note'],
    [['[', ']'], 'Previous / next section'],
    [['B'], 'List or Board'],
    [[`${MOD} S`], 'Save now'],
    [[`${MOD} E`], 'Edit or Preview'],
    [[`${MOD} Z`], 'Undo the latest move or delete'],
    [['Esc'], 'Leave the editor'],
  ],
  habits: [
    [['N'], 'New habit'],
    [['D', 'W', 'H'], 'Check in: Day, Week or History view'],
    [['T'], 'Check in: back to today'],
    [['←', '→'], 'Check in: previous / next week'],
    [['Space'], 'Tick the square in focus'],
    [[`${ALT} ↑`, `${ALT} ↓`], 'Move a habit up / down'],
  ],
  calendar: [
    [['N'], 'New event'],
    [['M', 'W', 'D'], 'Month, week or day'],
    [['T'], 'Today'],
    [['←', '→'], 'Previous / next'],
    [['Esc'], 'Zoom out: day, week, month'],
    [[`${MOD} Z`], 'Undo the latest change'],
  ],
  pomodoro: [
    [['Space'], 'Start, pause or resume'],
    [['R'], 'Reset'],
    [['S'], 'Skip to the next phase'],
  ],
  training: [[['N'], 'Start a workout']],
  finance: [[['N'], 'New subscription']],
  recovery: [
    [['N'], 'New tracker'],
    [['T'], 'The calendar: back to this month'],
    [['←', '→', '↑', '↓'], 'The calendar: move between days (PageUp / PageDown: a month)'],
    [['Enter', 'Space'], 'The calendar: mark or remove a relapse on that day'],
  ],
  health: [
    [['N'], 'Log a weight (the weight field)'],
    [['Enter'], 'In the add line: add (a day that has a weight: replace it)'],
    [['←', '→', 'Home', 'End'], 'The graph: read each weight · the first / last'],
    [['Enter'], 'On a weight in the list: edit it'],
  ],
});

function keyList(rows) {
  return h(
    'dl',
    { class: 'cmd-keys' },
    rows.map(([keys, text]) =>
      h(
        'div',
        { class: 'cmd-keys-row' },
        h(
          'dt',
          { class: 'cmd-keys-keys' },
          keys.map((k, i) => {
            if (k === '…') return h('span', { class: 'cmd-keys-to' }, h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, ' to '));
            // Several keys side by side are alternatives ("N or /")
            const or = i && keys[i - 1] !== '…' ? h('span', { class: 'sr-only' }, ' or ') : null;
            return [or, h('kbd', { class: 'kbd' }, k)];
          }),
        ),
        h('dd', { class: 'cmd-keys-text' }, text),
      ),
    ),
  );
}

function openShortcuts() {
  if (document.querySelector('.cmd-keys-modal')) return;
  const keys = pageKeys();
  const pages = shell.pages?.length ? shell.pages : Object.keys(keys).map((id) => ({ id, title: id }));
  const here = shownPage();
  // The page you are on first and open; the others folded
  const listed = pages.filter((p) => keys[p.id]).sort((a, b) => Number(b.id === here) - Number(a.id === here));
  const body = [
    h('p', { class: 'cmd-keys-note muted' }, 'They work when you are not typing in a field. On a phone, press and hold an item for its menu.'),
    h('section', { class: 'cmd-keys-block' }, h('h3', { class: 'cmd-keys-head' }, 'Everywhere'), keyList(everywhere())),
    ...listed.map((p) => h('details', { class: 'cmd-keys-block cmd-keys-page', open: p.id === here }, h('summary', { class: 'cmd-keys-head' }, p.title, p.id === here ? h('span', { class: 'cmd-keys-here' }, ' · this page') : null), keyList(keys[p.id]))),
  ];
  const m = openModal({
    title: 'Keyboard shortcuts',
    size: 'lg',
    className: 'cmd-keys-modal',
    body,
    footer: [h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Done')],
  });
  m.el.parentElement?.classList.add('cmd-keys-root');
}

/* ==========================================================================
   Wiring
   ========================================================================== */

// ⌘K on a Mac (Ctrl + K there deletes to the end of the line in a text field), Ctrl + K elsewhere
const isSearchKey = (e) =>
  (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K' || (e.code === 'KeyK' && !/^[a-z]$/i.test(e.key)));
// A dialog of a page has the keyboard (its own ⌘K, if any); one that is closing doesn't count
const otherDialog = () => [...document.querySelectorAll('.modal-root:not(.is-leaving)')].some((r) => !r.matches('.cmd-root, .cmd-keys-root'));

// Capture: ⌘K means Search on every page, before a page's own handler sees it
window.addEventListener(
  'keydown',
  (e) => {
    if (!isSearchKey(e) || e.isComposing || e.repeat) return;
    // A text field that makes ⌘K its own (a task's page: a link) keeps it while Search is shut
    if (!palette && e.target instanceof Element && e.target.closest('[data-mod-k="own"]')) return;
    if (palette) {
      e.preventDefault();
      e.stopPropagation();
      palette.close();
      return;
    }
    const sheet = document.querySelector('.cmd-keys-root:not(.is-leaving)');
    if (sheet) sheet.closeModal?.();
    else if (otherDialog() || menuOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    // A right-click menu closes first (its Esc), so the focus goes back to its item, and from
    // there Search returns it there too
    for (let i = 0; i < 3 && document.activeElement?.closest?.('.ctx-menu'); i++) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
    openSearch();
  },
  true,
);

document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTyping(e)) return;
  if (document.querySelector('.modal-root') || menuOpen()) return;
  e.preventDefault();
  openShortcuts();
});

window.addEventListener('lifeos:command', (e) => openSearch({ query: typeof e.detail?.query === 'string' ? e.detail.query : '' }));
window.addEventListener('lifeos:shortcuts', () => {
  if (palette) closeAllModals();
  openShortcuts();
});

// Warm up after the first paint, so the first ⌘K shows everything at once
setTimeout(loadModules, 1500);
