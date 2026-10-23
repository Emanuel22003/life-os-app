// LIFE/OS — 03 // Habits: weekday-planned habits. Three tabs: CHECK IN (tick them off, as one
// day's list, a habits × days week matrix, or habits × the last weeks), PLAN (habits.plan.js)
// and INSIGHTS (habits.insights.js), with the LIFE-index trading chart (habits.ticker.js) under
// them. Pure rules live in habits.logic.js / habits.stats.js (unit-tested); this file owns the
// store, the read-only `source` the other views share, and the mutations they all go through.

import {
  h,
  icon,
  pageHeader,
  tip,
  tipHidden,
  dismissTip,
  dropdown,
  menuOpen,
  emptyState,
  checkButton,
  setChecked,
  toast,
  confirmDialog,
  todayKey,
  formatDay,
  relativeDay,
  onDayChange,
  idx,
  num,
  term,
  plural,
  clamp,
  isTyping,
  modalOpen,
  WEEKDAYS_SHORT,
  MONTHS_SHORT,
} from '../ui.js';
import { createStore } from '../store.js';
import * as L from './habits.logic.js';
import * as S from './habits.stats.js';
import { mountPlan, openHabitModal, replay, prose, dayNames, habitBadge, WEEKDAYS_LONG } from './habits.plan.js';
import { mountInsights } from './habits.insights.js';
import { mountTradingChart, mountTicker } from './habits.ticker.js';
import { registerContextProvider } from '../contextmenu.js';
import { copyName, pasteName, insertAfter } from '../contextmenu.logic.js';

// The app's shared icon words: a tick to check in, a week = columns, trends = a graph line.
// The ids stay as they were stored ('today' is the Check in tab; Home opens it by that name).
const TABS = Object.freeze([
  { id: 'today', label: 'Check in', icon: 'check-circle' },
  { id: 'plan', label: 'Plan', icon: 'columns' },
  { id: 'insights', label: 'Insights', icon: 'activity' },
]);
const TAB_IDS = TABS.map((t) => t.id);
const HABITS_ROUTE = /^#\/habits(?![\w-])/;

// The Check in tab's overviews (the `view` preference, kept per device), a segmented switch
const VIEW_ITEMS = Object.freeze([
  { value: 'day', label: 'Day', icon: 'rows', hint: 'One day, listed', key: 'D' },
  { value: 'week', label: 'Week', icon: 'columns', hint: 'Every habit × every day of the week', key: 'W' },
  { value: 'history', label: 'History', icon: 'activity', hint: 'Every habit × the last weeks', key: 'H' },
]);
const VIEW_KEYS = Object.freeze({ d: 'day', w: 'week', h: 'history' });

// A touch screen opens on the Day list until a view is picked (L.pickView); a phone's History
// shows fewer, tappable weeks
const COARSE = globalThis.matchMedia?.('(pointer: coarse)');
const PHONE = globalThis.matchMedia?.('(max-width: 640px)');

/** term() text with its {placeholders} filled in ('“{name}” added · {plan}.'). */
function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

// Starter habits, each with its icon ("Move" suggests none, so it says which)
const SUGGESTIONS = [
  { name: 'Drink water', days: L.ALL_DAYS, hint: 'Daily', icon: 'droplet' },
  { name: 'Move 30 min', days: [1, 2, 3, 4, 5], hint: 'Weekdays', icon: 'walk' },
  { name: 'Read 20 min', days: [1, 3, 5], hint: 'Mon · Wed · Fri', icon: 'book' },
  { name: 'Plan the week', days: [0], hint: 'Sundays', icon: 'target' },
];

// Day state -> words (tooltips, aria labels)
const STATE_COPY = {
  done: 'Done',
  miss: 'Missed',
  pending: 'Due today',
  bonus: 'Bonus (not planned)',
  rest: 'Not planned',
  pre: 'Before start',
  future: 'Upcoming',
  archived: 'Archived',
};

// Keyboard hints in menus only where there is a keyboard to speak of
const KEY_HINTS = !globalThis.matchMedia?.('(hover: none)').matches;

const ALT_KEY = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '') ? '⌥' : 'Alt';

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

/* ==========================================================================
   State — one store shared by the page, the nav badge, the ticker and the charts
   ========================================================================== */

// No `view` by default: until one is picked, the device decides (L.pickView)
const store = createStore('habits', { items: [] });

let memo = { raw: null, today: '', state: null };

/** Normalized store value, memoized per stored object and day (normalization keeps valid objects as-is). */
function getState() {
  const raw = store.get();
  const today = todayKey();
  if (raw !== memo.raw || today !== memo.today || !memo.state) memo = { raw, today, state: L.normalizeState(raw, today) };
  return memo.state;
}

const getItems = () => getState().items;
const tabOf = (s) => (TAB_IDS.includes(s.tab) ? s.tab : TAB_IDS[0]);
// The Check in tab's overview lives in `view`, which stays on this device (Sync leaves it out).
// The old card toggle (`cardView`, which synced) is no longer read.
const viewOf = (s) => L.pickView(s.view, { coarse: !!COARSE?.matches });

function commit(fn) {
  const prev = getState();
  const next = fn(prev);
  if (next !== prev) store.set(next);
}

/** Replace the items via fn(items); skips the write when fn returns the same array. */
function updateItems(fn) {
  commit((s) => {
    const items = fn(s.items);
    return items === s.items ? s : { ...s, items };
  });
}

/** Replace one habit via fn(habit); skips the write when fn returns the same object. */
function updateHabit(id, fn) {
  updateItems((items) => {
    let changed = false;
    const next = items.map((it) => {
      if (it.id !== id) return it;
      const out = fn(it);
      if (out !== it) changed = true;
      return out;
    });
    return changed ? next : items;
  });
}

function findHabit(id) {
  return getItems().find((it) => it.id === id) ?? null;
}

function setView(view) {
  if (!L.VIEWS.includes(view)) return;
  commit((s) => (s.view === view ? s : { ...s, view }));
}

/** fn() on habit-data changes only: UI prefs (open tab, overview) share the store but don't fire it. */
function subscribe(fn) {
  let last = getItems();
  return store.subscribe(() => {
    const items = getItems();
    if (items === last) return;
    last = items;
    fn();
  });
}

// The open tab belongs to this window: it is saved for the next visit, but another
// browser tab switching views never yanks this one away (with whatever is being typed).
let localTab = null;
let refreshPage = null; // the mounted page's render(), if any

const currentTab = () => localTab ?? tabOf(getState());

/** Switch the page tab (persisted) and bring the Habits page up when another route is showing. */
function openTab(name) {
  if (!TAB_IDS.includes(name)) return;
  localTab = name;
  const before = store.get();
  commit((s) => (tabOf(s) === name ? s : { ...s, tab: name }));
  // No write (the stored tab already matched, e.g. set from another window) means no store event.
  if (store.get() === before) refreshPage?.();
  if (!HABITS_ROUTE.test(location.hash)) location.hash = '#/habits';
}

/** Read-only view of the habits data for the trading chart, ticker and insights. */
const source = Object.freeze({ getItems, today: todayKey, subscribe, openTab });

// Day states the Today tab lets you check in on: planned days (done / due / missed) and
// unplanned ones (bonus). Future days, days before the start and archived days stay locked.
const LOGGABLE = new Set(['done', 'pending', 'miss', 'bonus', 'rest']);

/** Check in / undo one habit on one day, through the Today tab's write path. True when the log changed. */
function setLogFromApi(id, key, done) {
  if (typeof done !== 'boolean' || !L.isValidKey(key)) return false;
  const today = todayKey();
  if (key > today) return false;
  const hb = findHabit(id);
  if (!hb || !LOGGABLE.has(L.dayStatus(hb, key, today))) return false;
  const before = store.get();
  updateHabit(id, (it) => L.setLog(it, key, done));
  return store.get() !== before;
}

/* ---- What other pages ask of this one (Search, Home's Start card): a habit shown, the editor
   opened. The request waits here while another page is showing; the Habits page acts on it once
   it has drawn (now, or when it mounts). ---- */

const ASK_TTL_MS = 10000; // a request no Habits page picked up by then is stale
let pendingAsk = null; // { kind: 'reveal', id } | { kind: 'editor', starters }, plus `at`
let askInView = null; // set while the page is mounted, so a request there acts at once

function askPage(ask) {
  pendingAsk = { ...ask, at: Date.now() };
  if (askInView) askInView();
  else if (!HABITS_ROUTE.test(location.hash)) location.hash = '#/habits';
}

function takeAsk() {
  const a = pendingAsk;
  pendingAsk = null;
  return a && Date.now() - a.at < ASK_TTL_MS ? a : null;
}

/**
 * Show a habit on the Habits page: on a tab that lists it (the open one when it does: Check in
 * or Plan; Plan for an archived one), scrolled to, focused and flashed. False when there is no
 * such habit.
 */
function apiReveal(id) {
  const hb = findHabit(id);
  if (!hb) return false;
  const tab = L.isArchived(hb, todayKey()) ? 'plan' : currentTab() === 'plan' ? 'plan' : 'today';
  // (switching tabs is saved, so only when the open one doesn't list it)
  if (currentTab() !== tab) {
    pendingAsk = { kind: 'reveal', id, at: Date.now() };
    openTab(tab);
    if (askInView) askInView();
  } else askPage({ kind: 'reveal', id });
  return true;
}

/**
 * The new-habit editor on the Habits page. `starters: true` (Home's Start card): with no habits
 * yet it opens on Check in, and the starter habits sit under the form, one tap each. True.
 */
function apiOpenEditor({ starters = false } = {}) {
  const ask = { kind: 'editor', starters: !!starters };
  if (ask.starters && currentTab() !== 'today' && !getItems().some((it) => !L.isArchived(it, todayKey()))) {
    pendingAsk = { ...ask, at: Date.now() };
    openTab('today');
    if (askInView) askInView();
  } else askPage(ask);
  return true;
}

/** For the Calendar: the shared read-only source plus check-ins; for Search and Home: reveal, openEditor. */
export const habitsApi = Object.freeze({ source, setLog: setLogFromApi, reveal: apiReveal, openEditor: apiOpenEditor });

/** The nav badge: only what needs you today, the habits planned today and not done yet. */
function badge() {
  const left = L.todaySummary(getItems(), todayKey()).remaining;
  return left ? String(left) : '';
}

/** The header's live line: what today still asks ('9 to go today', as Home's habits card says). */
function statText(items, today) {
  const sum = L.todaySummary(items, today);
  if (!sum.total) return '';
  if (!sum.scheduled) return 'Nothing planned today';
  if (sum.complete) return 'All done today';
  return `${num(sum.remaining)} to go today`;
}

/** Weekday -> ids planned on it from today (snapshot for undoing a copy / clear). */
function membersByDay(items, today) {
  return new Map(L.weekPlan(items, today).map((d) => [d.weekday, d.habits.map((it) => it.id)]));
}

function restoreMembers(byDay, days) {
  updateItems((items) => days.reduce((acc, wd) => L.setDayMembers(acc, wd, byDay.get(wd) ?? [], todayKey()), items));
}

/** Put a deleted habit back at its old position (undo). */
function restoreHabit(habit, index) {
  updateItems((items) => {
    if (items.some((it) => it.id === habit.id)) return items;
    const next = [...items];
    next.splice(Math.min(index, next.length), 0, habit);
    return L.reindex(next);
  });
}

/* ==========================================================================
   Small helpers
   ========================================================================== */

const pct = (rate) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);
const sameDays = (a, b) => a.join() === b.join();
const monthOf = (key) => MONTHS_SHORT[Number(key.slice(5, 7)) - 1];

function kbd(text) {
  return h('span', { class: 'kbd' }, text);
}

/** Day of the month as the template prints it: '05' (Mission Control) or '5' (Simple). */
const dayOf = (key) => idx(Number(key.slice(8)));

/** '05 – 11 Oct 2026' | '28 Sep – 04 Oct 2026' | '29 Dec 2025 – 04 Jan 2026' */
function rangeLabel(from, to) {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(5, 7) === to.slice(5, 7);
  const start = [dayOf(from), sameMonth ? null : monthOf(from), sameYear ? null : from.slice(0, 4)].filter(Boolean).join(' ');
  return `${start} – ${dayOf(to)} ${monthOf(to)} ${to.slice(0, 4)}`;
}

function weekRelLabel(weeks) {
  if (weeks === 0) return 'This week';
  if (weeks === -1) return 'Last week';
  if (weeks === 1) return 'Next week';
  return weeks < 0 ? `${-weeks} weeks ago` : `In ${weeks} weeks`;
}

/** '12 – 18 Oct' | '28 Sep – 04 Oct': the bar's week, with the year only when it isn't this one. */
function shortRange(from, to, today) {
  const year = today.slice(0, 4);
  if (from.slice(0, 4) !== year || to.slice(0, 4) !== year) return rangeLabel(from, to);
  return `${dayOf(from)}${from.slice(5, 7) === to.slice(5, 7) ? '' : ` ${monthOf(from)}`} – ${dayOf(to)} ${monthOf(to)}`;
}

/** 'Saturday 17 Oct' (+ year when it isn't the current one). */
function longDate(key, today) {
  const year = key.slice(0, 4);
  return `${WEEKDAYS_LONG[L.weekdayOfKey(key)]} ${dayOf(key)} ${monthOf(key)}${year === today.slice(0, 4) ? '' : ` ${year}`}`;
}

const cellCopy = (d) => (d.state === 'future' ? (d.scheduled ? 'Planned' : 'Not planned') : STATE_COPY[d.state]);

/** A habit's days under its name, only when they aren't every day (most are: the rows say it). */
const planNote = (days) => (days.length === 7 ? '' : L.scheduleLabel(days));

/** Text that only changes when it differs: a live region re-reads a rewrite, even of the same words. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** A view's tip (its id lets doneTips in mount hide it once the user does what it says). */
function tipEl(id, text) {
  return tip({ id, className: 'hb-tip', text });
}

/** Run a sibling module's mount without letting its crash take the page down. */
function guard(name, fn, fallbackEl) {
  try {
    const off = fn();
    return typeof off === 'function' ? off : null;
  } catch (err) {
    console.error(`[habits] ${name} failed`, err);
    fallbackEl?.replaceChildren(emptyState({ icon: 'zap', title: `${name} offline`, text: String(err?.message ?? err) }));
    return null;
  }
}

function safely(name, fn) {
  try {
    fn?.();
  } catch (err) {
    console.error(`[habits] ${name} cleanup failed`, err);
  }
}

/* ==========================================================================
   Mount
   ========================================================================== */

function mount(root) {
  let mounted = true;
  let activeModal = null;
  let activeTab = null;
  let closeTabFn = null;
  let todayView = null;
  let lastToday = todayKey();
  const timers = new Set();
  const n = nextId('hb');
  // key: the selected day (the week shown, the day listed); it follows today until moved
  const ui = { key: lastToday, followToday: true };

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  /** Catch a missed rollover (onDayChange polls every 30s). A selection that followed today moves on. */
  function syncDay() {
    const now = todayKey();
    if (now === lastToday) return false;
    if (ui.followToday || ui.key === lastToday) {
      ui.key = now;
      ui.followToday = true;
    }
    lastToday = now;
    return true;
  }

  /* ---- Actions: every write from every tab goes through these ---- */

  /** The user just did what these tips explain: they go for good, wherever they show (C2). */
  function doneTips(...ids) {
    for (const id of ids) if (!tipHidden(id)) dismissTip(id);
  }

  function create({ name, days, createdAt, icon: picked } = {}) {
    const habit = L.createHabit({ name, days, createdAt, icon: picked }, getItems().length, todayKey());
    updateItems((items) => [...items, { ...habit, order: items.length }]);
    toast(prose(fill(term('habits.added', '“{name}” added · {plan}.'), { name: habit.name, plan: L.scheduleLabel(habit.plan[0].days) })), {
      action: { label: 'Undo', onClick: () => updateItems((items) => (items.some((it) => it.id === habit.id) ? L.removeHabit(items, habit.id) : items)) },
    });
    todayView?.reveal(habit.id);
    return habit;
  }

  function edit(id, patch) {
    const before = findHabit(id);
    if (!before) return;
    const today = todayKey();
    updateHabit(id, (it) => L.editHabit(it, patch, today));
    const after = findHabit(id);
    if (after && !sameDays(L.planOn(before, today), L.planOn(after, today))) toast('Plan updated from today — past days keep their plan.');
  }

  function log(id, key, done) {
    const shown = ui.key;
    const rolled = syncDay();
    // Midnight passed unnoticed: record the day the user was looking at (never a
    // different date than the one on screen) and keep that day selected.
    if (rolled && key === shown) {
      ui.key = key;
      ui.followToday = false;
    }
    const today = todayKey();
    const before = L.todaySummary(getItems(), today);
    updateHabit(id, (it) => L.setLog(it, key, done));
    if (rolled) render();
    if (!done) return;
    // Ticking is what the page's explanations are about
    doneTips('habits.intro', 'habits.legend', 'habits.day');
    todayView?.pop(id, key);
    if (key !== today) return;
    const after = L.todaySummary(getItems(), today);
    if (after.complete && !before.complete) {
      todayView?.celebrate();
      toast(fill(term('habits.allDone.toast', 'All habits done for today. Nice work!'), { n: num(L.perfectDayStreak(getItems(), today)) }));
    }
  }

  function toggleDay(id, weekday) {
    updateHabit(id, (it) => L.toggleDayInPlan(it, weekday, todayKey()));
  }

  /** Plan a habit on `weekday` from today on (no-op when it already is). */
  function addDay(id, weekday) {
    const hb = findHabit(id);
    if (!hb || L.planOn(hb, todayKey()).includes(weekday)) return;
    updateHabit(id, (it) => L.toggleDayInPlan(it, weekday, todayKey()));
    const undo = () => updateHabit(id, (it) => (L.planOn(it, todayKey()).includes(weekday) ? L.toggleDayInPlan(it, weekday, todayKey()) : it));
    toast(prose(`“${hb.name}” planned on ${WEEKDAYS_LONG[weekday]}s from today.`), { action: { label: 'Undo', onClick: undo } });
    // Its "Add" button just disappeared (the habit moved into the day's list, or now shows a note).
    todayView?.handoff(id);
  }

  function copyDay(from, targets) {
    const today = todayKey();
    const days = L.normalizeDays(targets).filter((d) => d !== from);
    if (!days.length) return;
    const before = membersByDay(getItems(), today);
    updateItems((items) => L.copyDayPlan(items, from, days, today));
    toast(`${WEEKDAYS_LONG[from]}'s lineup copied to ${dayNames(days)}.`, { action: { label: 'Undo', onClick: () => restoreMembers(before, days) } });
  }

  function clearDay(weekday) {
    const before = membersByDay(getItems(), todayKey());
    const count = before.get(weekday)?.length ?? 0;
    if (!count) return;
    updateItems((items) => L.clearDayPlan(items, weekday, todayKey()));
    toast(`${WEEKDAYS_LONG[weekday]} cleared — ${plural(count, 'habit')} unplanned from today.`, {
      action: { label: 'Undo', onClick: () => restoreMembers(before, [weekday]) },
    });
  }

  function archive(id) {
    const hb = findHabit(id);
    if (!hb || L.isArchived(hb, todayKey())) return;
    updateHabit(id, (it) => L.archiveHabit(it, todayKey()));
    toast(prose(`“${hb.name}” archived — its history stays in your graphs.`), {
      action: { label: 'Undo', onClick: () => updateHabit(id, (it) => L.unarchiveHabit(it, todayKey())) },
    });
    refocus();
  }

  function unarchive(id) {
    const hb = findHabit(id);
    if (!hb?.archivedAt) return;
    updateHabit(id, (it) => L.unarchiveHabit(it, todayKey()));
    toast(prose(`“${hb.name}” restored from today.`));
    refocus();
  }

  /**
   * Erase the habit (Undo in the toast). One with check-ins asks first, since that erases its
   * history from every graph. -> true (deleted) | false (cancelled) | null (gone).
   */
  async function remove(id) {
    const hb = findHabit(id);
    if (!hb) {
      toast('That habit no longer exists.');
      return null;
    }
    const logged = Object.keys(hb.log).length;
    const confirmed =
      !logged ||
      (await confirmDialog({
        title: 'Delete forever?',
        message: prose(
          `“${hb.name}” and its entire history (${plural(logged, 'logged day')}) will be erased from every graph — streaks, insights and the LIFE index. Archive it instead to keep the history.`,
        ),
        confirmLabel: 'Delete forever',
        danger: true,
      }));
    if (!confirmed) return false;
    // Honour an explicit confirmation even if the page was left meanwhile (e.g. browser Back).
    const index = getItems().findIndex((it) => it.id === id);
    if (index < 0) return null;
    const current = getItems()[index];
    updateItems((items) => L.removeHabit(items, id));
    toast(prose(`“${current.name}” deleted.`), { action: { label: 'Undo', onClick: () => restoreHabit(current, index) } });
    refocus();
    return true;
  }

  /* ---- Copy, paste, duplicate (the right-click menu) ---- */

  /** What a copy carries: the name, a picked icon and the weekdays planned from today on (never the check-ins). */
  function habitSnapshot(hb) {
    return { name: hb.name, days: L.planOn(hb, todayKey()), icon: hb.icon ?? null };
  }

  /**
   * A new habit from `snap`, right after `afterId` (last without one): planned from today on the
   * copied weekdays, no history. Undo removes it while it has no check-ins and is unchanged.
   */
  function insertCopy(snap, afterId, { verb = 'Pasted', naming = pasteName } = {}) {
    const src = snap && typeof snap === 'object' ? snap : {};
    const today = todayKey();
    const items = getItems();
    const name = naming(String(src.name ?? ''), items.map((it) => it.name), { max: L.NAME_MAX, fallback: 'Untitled habit' }) || 'Untitled habit';
    const days = Array.isArray(src.days) ? src.days : [...L.ALL_DAYS];
    const habit = L.createHabit({ name, days, icon: src.icon }, items.length, today);
    updateItems((list) => L.reindex(insertAfter(list, habit, afterId, { fallback: 'end' })));
    const made = findHabit(habit.id);
    if (!made) return;
    toast(prose(`${verb} “${made.name}” · ${L.scheduleLabel(L.planOn(made, today))}.`), {
      action: { label: 'Undo', onClick: () => removeCopy(made) },
    });
    todayView?.reveal(made.id);
  }

  function removeCopy(created) {
    const cur = findHabit(created.id);
    if (!cur) {
      toast('Nothing undone: the copy was deleted since.');
      return;
    }
    const same = (a) => JSON.stringify({ ...a, order: 0 });
    if (Object.keys(cur.log).length || same(cur) !== same(created)) {
      toast(prose(`Nothing undone: “${cur.name}” changed since.`));
      return;
    }
    updateItems((list) => L.removeHabit(list, created.id));
    refocus();
  }

  function duplicate(id) {
    const hb = findHabit(id);
    if (hb) insertCopy(habitSnapshot(hb), id, { verb: 'Duplicated', naming: copyName });
  }

  /** The right-click menu: a habit's row in any overview or the Week plan, or anywhere else (paste at the end). */
  function contextTarget(el) {
    if (!mounted || !root.contains(el)) return null;
    const itemEl = el.closest('.hb-mx-row[data-id], .hb-row[data-id], .hb-plan-row[data-id]');
    const hb = itemEl ? findHabit(itemEl.dataset.id) : null;
    const afterId = hb?.id ?? null;
    const paste = { accepts: ['habit'], paste: (c) => insertCopy(c.snapshot, afterId) };
    if (!hb) return { kind: null, id: null, label: 'Habits', el: null, ...paste };
    const id = hb.id;
    return {
      kind: 'habit',
      id,
      label: `Habit: ${hb.name}`,
      el: itemEl,
      ...paste,
      copy: () => {
        const cur = findHabit(id);
        return cur ? { kind: 'habit', snapshot: habitSnapshot(cur), text: cur.name } : null;
      },
      remove: () => remove(id),
      duplicate: () => duplicate(id),
      edit: () => openEditor(id),
    };
  }

  /** Move by `delta`, counted among `visible` ids when given (the rows on screen). */
  function move(id, delta, visible = null) {
    updateItems((items) => L.moveHabitWithin(items, id, delta, visible ?? undefined));
  }

  function openEditor(id = null, { weekday = null, draft = null } = {}) {
    if (!mounted) return;
    const habit = id ? findHabit(id) : null;
    if (id && !habit) {
      toast('That habit no longer exists.');
      return;
    }
    activeModal?.close();
    const m = openHabitModal({
      habit,
      weekday,
      draft,
      actions,
      onClose: () => {
        if (activeModal === m) activeModal = null;
      },
    });
    activeModal = m;
  }

  function select(key) {
    if (!L.isValidKey(key)) return;
    syncDay();
    ui.key = key;
    ui.followToday = key === todayKey();
    todayView?.render();
  }

  /** Switch the Today tab's overview, and show `key` in it when given (a day, or a day of a week). */
  function show(view, key = null) {
    if (key) select(key);
    setView(view);
    todayView?.focusView();
  }

  /** A removed row takes focus with it; land on the page's primary action instead of <body>. */
  function refocus() {
    if (mounted && !root.contains(document.activeElement)) addBtn.focus({ preventScroll: true });
  }

  const actions = {
    today: todayKey,
    find: findHabit,
    isMounted: () => mounted,
    openEditor,
    openTab,
    create,
    edit,
    log,
    toggleDay,
    addDay,
    copyDay,
    clearDay,
    archive,
    unarchive,
    remove,
    duplicate,
    move,
  };
  const ctx = { actions, ui, later, select, show, doneTips };

  /* ---- Layout: header, pinned LIFE-index chart, tab bar, tab panel ---- */

  const addBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary hb-add', 'aria-keyshortcuts': 'N', onClick: () => openEditor() },
    icon('plus'),
    h('span', null, 'New habit'),
    h('span', { class: 'kbd hb-add-kbd lo-hint', 'aria-hidden': 'true' }, 'N'),
  );
  // Today's check-ins on the title row (C1), kept current by render()
  let shownStat = null;
  const header = pageHeader({
    index: '04',
    title: 'Habits',
    // Says what the page does, not what it does for you: no promised outcome (markedsføringsloven §§ 3, 7)
    subtitle: term('habits.subtitle', 'Small things you do on chosen days. Tick them off as you go.'),
    tipId: 'habits.intro',
    stat: statText(getItems(), todayKey()),
    actions: [addBtn],
  });

  // The LIFE index is a trading readout: Simple leaves it out (.lo-deco), the tabs do everything.
  // It sits under the tabs' content, so your habits come first on the screen.
  const chartSlot = h('div', { class: 'hb-chart-slot lo-deco' });

  const panelId = `${n}-panel`;
  const tabEls = TABS.map((t) => {
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `${n}-tab-${t.id}`,
        class: 'seg-btn hb-tab',
        'aria-selected': 'false',
        'aria-controls': panelId,
        tabindex: '-1',
        onClick: () => openTab(t.id),
      },
      icon(t.icon, { size: 14 }),
      h('span', null, t.label),
    );
    return { ...t, btn };
  });
  const tablist = h('div', { class: 'seg hb-tabs', role: 'tablist', 'aria-label': 'Habits views', onKeydown: onTabKey }, tabEls.map((t) => t.btn));
  const panel = h('div', { class: 'hb-panel', id: panelId, role: 'tabpanel' });

  root.append(header, tablist, panel, chartSlot);

  /* ---- Tabs ---- */

  function showTab(tab) {
    if (tab === activeTab) return;
    const hadFocus = panel.contains(document.activeElement);
    closeTab();
    activeTab = tab;
    const current = tabEls.find((t) => t.id === tab);
    tabEls.forEach((t) => {
      t.btn.setAttribute('aria-selected', String(t === current));
      t.btn.tabIndex = t === current ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', current.btn.id);
    panel.dataset.tab = tab;
    if (tab === 'today') {
      todayView = createTodayView(ctx);
      panel.append(todayView.el);
      const view = todayView;
      closeTabFn = () => view.destroy();
    } else if (tab === 'plan') {
      closeTabFn = guard('Week plan', () => mountPlan(panel, source, actions), panel);
    } else {
      closeTabFn = guard('Insights', () => mountInsights(panel, source), panel);
    }
    // The control that switched tabs (e.g. "Open week plan") was just removed.
    if (hadFocus) current.btn.focus({ preventScroll: true });
  }

  function closeTab() {
    safely(activeTab ?? 'tab', closeTabFn);
    closeTabFn = null;
    todayView = null;
    panel.replaceChildren();
  }

  /** Arrow keys / Home / End move between tabs (automatic activation). */
  function onTabKey(e) {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const i = TAB_IDS.indexOf(activeTab);
    const last = TAB_IDS.length - 1;
    const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    openTab(TAB_IDS[next]);
    tabEls[next].btn.focus();
  }

  function paintStat(items, today) {
    const text = statText(items, today);
    if (text === shownStat) return;
    shownStat = text;
    header.setStat?.(text);
  }

  function render() {
    if (!mounted) return;
    syncDay();
    const state = getState();
    showTab(currentTab());
    paintStat(state.items, todayKey());
    todayView?.render();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e) || modalOpen() || menuOpen()) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openEditor();
      return;
    }
    // Today tab: D · W · H pick the overview, T goes back to today, ← → move a week
    if (activeTab !== 'today' || !todayView || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (VIEW_KEYS[key]) {
      e.preventDefault();
      show(VIEW_KEYS[key]);
    } else if (key === 't') {
      e.preventDefault();
      select(todayKey());
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && viewOf(getState()) !== 'history') {
      e.preventDefault();
      select(L.fromDayNum(L.toDayNum(ui.key) + (e.key === 'ArrowLeft' ? -7 : 7)));
    }
  }

  /* ---- habitsApi.reveal / openEditor, acted on once the page has drawn ---- */

  /** The habit's row on the open tab: scrolled to, focused (its name or today's cell) and flashed. */
  function revealHabit(id) {
    const hb = findHabit(id);
    if (!hb) return;
    let row = null;
    if (activeTab === 'today' && todayView) {
      todayView.reveal(id);
      row = document.activeElement?.closest?.('.hb-row, .hb-mx-row');
      // On its name, as Search's other finds: not its tick box or today's cell (Enter there ticks)
      row?.querySelector('.hb-row-name, .hb-mx-name')?.focus({ preventScroll: true });
    } else if (activeTab === 'plan') {
      row = [...panel.querySelectorAll(`.hb-plan-row[data-id="${CSS.escape(id)}"]`)].find((n) => n.getClientRects().length) ?? null;
      if (!row && hb.archivedAt) row = archivedRow(hb);
      row?.scrollIntoView({ block: 'center' });
      (row?.querySelector('.hb-plan-name') ?? row)?.focus({ preventScroll: true });
    }
    if (row && panel.contains(row)) {
      replay(row, 'lo-found');
      later(() => row.classList.remove('lo-found'), 1600);
    }
  }

  /** An archived habit in the Plan tab's Archived list (opened when folded), found by its name. */
  function archivedRow(hb) {
    const fold = panel.querySelector('.hb-arch .hb-fold');
    if (fold?.getAttribute('aria-expanded') === 'false') fold.click();
    const li = [...panel.querySelectorAll('.hb-arch-row')].find((n) => n.querySelector('.hb-arch-name')?.textContent === hb.name);
    if (li) li.tabIndex = -1; // focusable for the reveal (Tab goes on to Restore)
    return li ?? fold ?? null;
  }

  /** The new-habit editor; with `starters` and no habits yet, the starter habits under its form. */
  function openNew({ starters = false } = {}) {
    openEditor();
    const m = activeModal;
    if (!m || !starters || getItems().some((it) => !L.isArchived(it, todayKey()))) return;
    m.el.querySelector('.modal-body')?.append(
      suggestionsEl((s) => {
        m.close();
        actions.create(starterHabit(s));
      }),
    );
  }

  let askFrame = 0;
  let askTimer = 0;
  const runAsk = () => {
    cancelAnimationFrame(askFrame);
    clearTimeout(askTimer);
    const ask = takeAsk();
    if (!ask || !mounted) return;
    if (ask.kind === 'editor') openNew(ask);
    else revealHabit(ask.id);
  };
  // After the next frame (the tab drawn); the timer backs it up in a tab that paints no frames
  const queueAsk = () => {
    cancelAnimationFrame(askFrame);
    clearTimeout(askTimer);
    askFrame = requestAnimationFrame(runAsk);
    askTimer = setTimeout(runAsk, 120);
  };

  const offChart = guard('LIFE index', () => mountTradingChart(chartSlot, source), chartSlot);
  localTab ??= tabOf(getState());
  refreshPage = render;
  render();
  askInView = queueAsk;
  if (pendingAsk) queueAsk();

  const unsubscribe = store.subscribe(render);
  const offDayChange = onDayChange(render);
  const offMenu = registerContextProvider('habits', contextTarget);
  document.addEventListener('keydown', onKey);

  return () => {
    mounted = false;
    if (refreshPage === render) refreshPage = null;
    if (askInView === queueAsk) askInView = null;
    cancelAnimationFrame(askFrame);
    clearTimeout(askTimer);
    offMenu();
    unsubscribe();
    offDayChange();
    document.removeEventListener('keydown', onKey);
    timers.forEach(clearTimeout);
    timers.clear();
    closeTab();
    safely('LIFE index', offChart);
    activeModal?.close();
  };
}

/* ==========================================================================
   CHECK IN tab — one slim bar (week, back to today, Day · Week · History), then one overview:
   DAY    one day as a list: what was planned first, then the rest (bonus ticks); a touch
          screen's first view
   WEEK   every habit × the seven days, a tap ticks a day (a mouse's first view)
   HISTORY every habit × the last weeks, shaded by how much of each week got done
   ========================================================================== */

function createTodayView(ctx) {
  const { ui } = ctx;
  // "Today" hides itself once pressed: focus goes on to today in the overview
  const bar = createBar(ctx, { onToday: () => shown?.focusStart() });
  const views = { week: createWeekView(ctx), day: createDayView(ctx), history: createHistoryView(ctx) };
  const main = h('div', { class: 'hb-today' }, bar.el, views.week.el, views.day.el, views.history.el);
  const firstRun = h('div', { class: 'hb-empty', hidden: true });
  const el = h('div', { class: 'hb-today-wrap' }, main, firstRun);
  let firstRunSig = '';
  let shown = null;
  // A phone shows fewer weeks of History: turning the window across that width redraws it
  const onWidth = () => render();
  PHONE?.addEventListener?.('change', onWidth);

  function render() {
    const today = todayKey();
    const state = getState();
    const { items } = state;
    const live = items.filter((it) => !L.isArchived(it, today));

    main.hidden = !live.length;
    firstRun.hidden = !!live.length;
    if (!live.length) {
      const sig = `archived:${items.length}`;
      if (sig !== firstRunSig) {
        firstRunSig = sig;
        firstRun.replaceChildren(...buildFirstRun(ctx, items.length));
      }
      return;
    }
    if (firstRunSig) {
      firstRunSig = '';
      firstRun.replaceChildren();
    }

    const view = viewOf(state);
    const weeks = L.historyWeeks(items, today, PHONE?.matches ? L.HISTORY_WEEKS_PHONE : L.HISTORY_WEEKS);
    bar.update({ key: ui.key, today, view, weeksShown: weeks });
    for (const [name, v] of Object.entries(views)) v.el.hidden = name !== view;
    shown = views[view];
    // Rows move in the DOM when the order changes, which drops focus: put it back.
    const active = document.activeElement;
    shown.update({ items, today, key: ui.key, weeks });
    if (active instanceof HTMLElement && active !== document.activeElement && active.isConnected) active.focus({ preventScroll: true });
  }

  return {
    el,
    render,
    /** A new or pasted habit: bring its row into view and focus it. */
    reveal: (id) => shown?.focusHabit(id),
    /** The control the user just used went away: follow the habit to its row. */
    handoff(id) {
      if (!el.contains(document.activeElement)) shown?.focusHabit(id);
    },
    /** After switching the overview: focus lands in the new one, not on <body>. */
    focusView() {
      if (!el.contains(document.activeElement) || document.activeElement.closest('[hidden]')) shown?.focusStart();
    },
    pop: (id, key) => shown?.pop(id, key),
    celebrate: () => shown?.celebrate(),
    destroy() {
      PHONE?.removeEventListener?.('change', onWidth);
    },
  };
}

/* ---- The bar: ‹ week › · Today · Day | Week | History ---- */

function createBar(ctx, { onToday }) {
  const { ui } = ctx;
  const step = (days) => ctx.select(L.fromDayNum(L.toDayNum(ui.key) + days));
  const prevBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hb-bar-step', 'aria-label': 'Previous week', title: 'Previous week (←)', onClick: () => step(-7) }, icon('chevron-left'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hb-bar-step', 'aria-label': 'Next week', title: 'Next week (→)', onClick: () => step(7) }, icon('chevron-right'));
  const rangeEl = h('span', { class: 'hb-bar-range tnum' });
  const relEl = h('span', { class: 'tag hb-bar-rel' });
  const todayBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--sm hb-bar-today',
      // Phones show the icon only, so the name can't come from the hidden word
      'aria-label': 'Back to today',
      'aria-keyshortcuts': 'T',
      title: 'Back to today (T)',
      onClick: () => {
        ctx.select(todayKey());
        onToday();
      },
    },
    icon('sun', { size: 14 }),
    h('span', null, 'Today'),
  );
  // The overviews side by side, one tap each (the open one pressed)
  const viewBtns = VIEW_ITEMS.map((v) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn hb-view-btn',
        'aria-pressed': 'false',
        'aria-keyshortcuts': v.key,
        title: `${v.hint} (${v.key})`,
        dataset: { view: v.value },
        onClick: () => ctx.show(v.value),
      },
      icon(v.icon, { size: 14 }),
      h('span', null, v.label),
    ),
  );
  const viewSeg = h('div', { class: 'seg hb-view-seg', role: 'group', 'aria-label': 'Overview' }, viewBtns);
  const nav = h('div', { class: 'hb-bar-nav' }, prevBtn, h('div', { class: 'hb-bar-when', 'aria-live': 'polite' }, rangeEl, relEl), nextBtn, todayBtn);
  const el = h('div', { class: 'hb-bar' }, viewSeg, nav);

  return {
    el,
    update({ key, today, view, weeksShown = L.HISTORY_WEEKS }) {
      const history = view === 'history';
      prevBtn.hidden = history;
      nextBtn.hidden = history;
      relEl.hidden = history;
      // Every check-in repaints the bar; the live week label only speaks when the week changes
      if (history) {
        setText(rangeEl, `Last ${plural(weeksShown, 'week')}`);
      } else {
        const week = L.weekDays(key);
        const weeks = Math.round((L.toDayNum(week[0]) - L.toDayNum(L.weekStart(today))) / 7);
        setText(rangeEl, shortRange(week[0], week[6], today));
        setText(relEl, weekRelLabel(weeks));
        relEl.classList.toggle('tag--solid', weeks === 0);
      }
      // Only while away from today (History always ends with this week)
      todayBtn.hidden = history || key === today;
      el.classList.toggle('is-away', !todayBtn.hidden);
      viewBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    },
  };
}

/* ---- Small readout: ✓ done / planned for one day, 🔥 the best streak running, the day ---- */

function createReadout(ctx) {
  // Icons say what each number is, so the words can go: a tick for done, a flame for a streak.
  // A day still ahead shows an open circle (its number is what's planned, nothing is done yet),
  // a day with nothing planned a crossed circle.
  const doneIcon = h('span', { class: 'hb-ro-ic' });
  let doneIconName = null;
  const frac = h('span', { class: 'hb-ro-frac mono tnum' });
  const streakNum = h('span', { class: 'tnum' });
  const streak = h('span', { class: 'hb-ro-streak' }, icon('flame', { size: 12 }), streakNum);
  const cap = h('span', { class: 'hb-ro-cap label' });
  const el = h(
    'div',
    { class: 'hb-ro', role: 'img' },
    h('span', { class: 'hb-ro-text', 'aria-hidden': 'true' }, h('span', { class: 'hb-ro-main' }, h('span', { class: 'hb-ro-done' }, doneIcon, frac), streak), cap),
  );
  return {
    el,
    /**
     * `day`: the day's habits.stats dailySeries entry. `best`: L.topStreak as of today (the
     * longest streak running now, whichever day is shown).
     */
    update(day, key, today, best = { value: 0, habit: null }) {
      const future = key > today;
      const complete = !!day.planned && !future && day.done === day.planned;
      frac.textContent = !day.planned ? '—' : future ? String(day.planned) : `${day.done}/${day.planned}`;
      const iconName = !day.planned ? 'circle-slash' : future ? 'circle' : 'check-circle';
      if (iconName !== doneIconName) {
        doneIconName = iconName;
        doneIcon.replaceChildren(icon(iconName, { size: 15, stroke: 1.75 }));
      }
      cap.textContent = key === today ? 'Today' : `${WEEKDAYS_SHORT[day.weekday]} ${dayOf(key)}`;
      streak.hidden = !best.value;
      streakNum.textContent = num(best.value);
      const counts = !day.planned ? 'nothing planned' : future ? `${plural(day.planned, 'habit')} planned` : `${day.done} of ${day.planned} done`;
      const run = best.value ? `. Best streak: ${best.habit.name}, ${plural(best.value, 'day')} in a row` : '';
      const label = `${key === today ? 'Today' : formatDay(key)}: ${counts}${run}`;
      el.setAttribute('aria-label', label);
      el.title = label;
      el.classList.toggle('is-complete', complete);
      el.classList.toggle('is-started', !future && day.done > 0);
      el.classList.toggle('is-rest', !day.planned);
    },
    celebrate() {
      replay(el, 'is-celebrating');
      ctx.later(() => el.classList.remove('is-celebrating'), 1600);
    },
  };
}

/* ---- Shared by the week and history tables ---- */

/** Name button (its icon + name; opens the editor) + streak, for a habit's row header. */
function createRowHead(ctx, id) {
  const badge = habitBadge();
  const nameText = h('span', { class: 'hb-mx-name-text' });
  const sub = h('span', { class: 'hb-mx-sub label' });
  const name = h('button', { type: 'button', class: 'hb-mx-name', onClick: () => ctx.actions.openEditor(id) }, badge.el, h('span', { class: 'hb-mx-ident' }, nameText, sub));
  const streakNum = h('span');
  const streak = h('span', { class: 'hb-mx-streak tnum' }, icon('flame', { size: 12 }), h('span', { class: 'sr-only' }, 'streak '), streakNum);
  const rowin = h('div', { class: 'hb-mx-rowin' }, name, streak);
  const th = h('th', { scope: 'row', class: 'hb-mx-rowhead' }, rowin);
  return {
    th,
    name,
    update(hb, today, archived) {
      const s = L.currentStreak(hb, today);
      badge.update(hb);
      nameText.textContent = hb.name;
      sub.textContent = archived ? `Archived ${formatDay(hb.archivedAt)}` : hb.createdAt > today ? `Starts ${formatDay(hb.createdAt)}` : planNote(L.planOn(hb, today));
      sub.hidden = !sub.textContent;
      name.title = `${hb.name} · ${sub.textContent || L.scheduleLabel(L.planOn(hb, today))} — edit (${ALT_KEY} ↑ ↓ reorders)`;
      name.setAttribute('aria-label', `${hb.name}${archived ? ' (archived)' : ''}, edit`);
      streak.hidden = s === 0;
      // Phones put the streak under the name (habits.css), which then moves up to make room
      rowin.classList.toggle('has-streak', s !== 0);
      streakNum.textContent = num(s);
      streak.title = `${plural(s, 'day')} in a row`;
    },
  };
}

/**
 * Keyboard for a table of habit rows × columns of buttons: one tab stop that the arrow keys
 * move (Home / End: first / last column), and Alt + ↑ ↓ (anywhere in a row) reorders the habit.
 */
function gridNav({ ids, cellsOf, onMove }) {
  let cursor = { id: null, col: 0 };

  function sync() {
    const order = ids();
    if (!order.includes(cursor.id)) cursor = { id: order[0] ?? null, col: cursor.col };
    for (const id of order) cellsOf(id).forEach((btn, col) => (btn.tabIndex = id === cursor.id && col === cursor.col ? 0 : -1));
  }

  function focus(id, col) {
    const cells = cellsOf(id);
    if (!cells.length) return;
    cursor = { id, col: clamp(col, 0, cells.length - 1) };
    sync();
    cells[cursor.col].focus();
  }

  function onKeydown(e) {
    const tr = e.target instanceof Element ? e.target.closest('tr[data-id]') : null;
    const order = ids();
    if (!tr || !order.includes(tr.dataset.id)) return;
    const id = tr.dataset.id;
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onMove(id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    const btn = e.target.closest('button[data-col]');
    if (!btn || e.altKey || e.metaKey || e.ctrlKey) return;
    let row = order.indexOf(id);
    let col = Number(btn.dataset.col);
    if (e.key === 'ArrowLeft') col--;
    else if (e.key === 'ArrowRight') col++;
    else if (e.key === 'ArrowUp') row--;
    else if (e.key === 'ArrowDown') row++;
    else if (e.key === 'Home') col = 0;
    else if (e.key === 'End') col = Infinity;
    else return;
    e.preventDefault();
    focus(order[clamp(row, 0, order.length - 1)], col);
  }

  return {
    sync,
    focus,
    onKeydown,
    onFocus(id, col) {
      cursor = { id, col };
      sync();
    },
    /** Tabbing in lands on column `col` (e.g. the selected day); call it while focus is elsewhere. */
    park(col) {
      cursor = { id: cursor.id, col };
    },
  };
}

/** Keep `tbody`'s rows (from `rows`, keyed by habit id) in the order of `ids`; drop the others. */
function placeRows(tbody, rows, ids) {
  const keep = new Set(ids);
  for (const [id, row] of rows) {
    if (keep.has(id)) continue;
    row.tr.remove();
    rows.delete(id);
  }
  ids.forEach((id, i) => {
    const tr = rows.get(id).tr;
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] ?? null);
  });
}

/**
 * What the week matrix's squares mean: one quiet line under the table (it costs no room above it).
 * Short words ("Off", as in the Week plan) keep it to one line on a phone.
 */
function weekLegend() {
  const sw = (state, text) => h('span', { class: 'hb-legend-item label' }, h('span', { class: 'hb-swatch', dataset: { s: state } }), text);
  return h('div', { class: 'hb-legend hb-mx-legend', 'aria-hidden': 'true' }, sw('done', 'Done'), sw('miss', 'Missed'), sw('planned', 'Planned'), sw('rest', 'Off'), sw('bonus', 'Bonus'));
}

/* ---- WEEK: habits × Mon … Sun ---- */

function createWeekView(ctx) {
  const { actions, ui } = ctx;
  const rows = new Map();
  let order = []; // habit ids, top to bottom
  let week = [];
  const nav = gridNav({ ids: () => order, cellsOf: (id) => rows.get(id)?.cells.map((c) => c.btn) ?? [], onMove: (id, delta) => actions.move(id, delta, order) });

  const readout = createReadout(ctx);
  const heads = Array.from({ length: 7 }, (_, col) => {
    const wd = h('span', { class: 'hb-mx-wd' });
    const date = h('span', { class: 'hb-mx-date tnum' });
    const btn = h('button', { type: 'button', class: 'hb-mx-colbtn', onClick: () => ctx.show('day', week[col]) }, wd, date);
    return { th: h('th', { scope: 'col', class: 'hb-mx-th' }, btn), btn, wd, date };
  });
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'hb-mx', onKeydown: nav.onKeydown },
    h('colgroup', null, h('col', { class: 'hb-mx-namecol' }), heads.map(() => h('col')), h('col', { class: 'hb-mx-sumcol' })),
    h(
      'thead',
      null,
      h('tr', null, h('th', { scope: 'col', class: 'hb-mx-corner' }, readout.el), heads.map((c) => c.th), h('th', { scope: 'col', class: 'hb-mx-sumth' }, h('span', { class: 'label' }, 'Week'))),
    ),
    tbody,
  );
  const el = h(
    'section',
    { class: 'hb-view hb-week', 'aria-label': 'Week' },
    tipEl('habits.legend', 'Tap a square to tick that day off.'),
    h('div', { class: 'panel hud hb-mx-panel' }, h('div', { class: 'hb-mx-scroll' }, table), weekLegend()),
  );

  function createRow(id) {
    const head = createRowHead(ctx, id);
    const cells = Array.from({ length: 7 }, (_, col) => {
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'hb-day hb-mx-cell',
          tabindex: '-1',
          dataset: { col: String(col) },
          onClick: () => onCell(id, col),
          onFocus: () => nav.onFocus(id, col),
        },
        icon('check', { size: 14, stroke: 2.5 }),
      );
      return { btn, td: h('td', { class: 'hb-mx-td' }, btn), data: null };
    });
    const sum = h('td', { class: 'hb-mx-sum mono tnum' });
    const tr = h('tr', { class: 'hb-mx-row', dataset: { id } }, head.th, cells.map((c) => c.td), sum);
    return { tr, head, cells, sum };
  }

  function onCell(id, col) {
    const d = rows.get(id)?.cells[col].data;
    if (!d || !LOGGABLE.has(d.state)) return;
    actions.log(id, d.key, !L.isLogged(d.state));
  }

  function paintRow(row, r, { today, key }) {
    const hb = r.habit;
    row.head.update(hb, today, r.archived);
    row.tr.classList.toggle('is-archived', r.archived);
    r.cells.forEach((d, col) => {
      const c = row.cells[col];
      const isToday = d.key === today;
      const when = `${formatDay(d.key)}${isToday ? ' (today)' : ''}`;
      const copy = cellCopy(d);
      c.data = d;
      c.btn.dataset.state = d.state;
      c.btn.dataset.planned = String(d.scheduled);
      c.btn.setAttribute('aria-pressed', String(L.isLogged(d.state)));
      c.btn.setAttribute('aria-disabled', String(!LOGGABLE.has(d.state)));
      c.btn.setAttribute('aria-label', `${hb.name}, ${when}: ${copy}`);
      c.btn.title = `${hb.name} · ${when} · ${copy}`;
      c.td.classList.toggle('is-today', isToday);
      c.td.classList.toggle('is-selected', d.key === key && !isToday);
    });
    row.sum.textContent = r.due ? `${r.done}/${r.due}` : '—';
    row.sum.title = r.due ? `${r.done} of ${r.due} planned days done this week so far` : 'Nothing due yet this week';
  }

  function paintHeads(series, key, today) {
    series.forEach((d, i) => {
      const hd = heads[i];
      const isToday = d.key === today;
      const counts = !d.planned ? 'nothing planned' : d.future ? `${plural(d.planned, 'habit')} planned` : `${d.done} of ${d.planned} done`;
      hd.wd.textContent = WEEKDAYS_SHORT[d.weekday];
      hd.date.textContent = dayOf(d.key);
      hd.th.classList.toggle('is-today', isToday);
      hd.th.classList.toggle('is-selected', d.key === key && !isToday);
      hd.th.classList.toggle('is-perfect', !d.future && !d.pending && d.planned > 0 && d.done === d.planned);
      hd.btn.setAttribute('aria-label', `${formatDay(d.key, 'long')}${isToday ? ', today' : ''}: ${counts}. Show as a list`);
      hd.btn.title = `${formatDay(d.key)} · ${counts} — show as a list`;
    });
  }

  return {
    el,
    update({ items, today, key }) {
      week = L.weekDays(key);
      const series = S.dailySeries(items, week[0], week[6], today);
      paintHeads(series, key, today);
      readout.update(series[week.indexOf(key)], key, today, L.topStreak(items, today));
      table.setAttribute('aria-label', `Habits, week of ${formatDay(week[0])}`);
      const list = L.weekRows(items, key, today);
      for (const r of list) {
        let row = rows.get(r.habit.id);
        if (!row) {
          row = createRow(r.habit.id);
          rows.set(r.habit.id, row);
        }
        paintRow(row, r, { today, key });
      }
      order = list.map((r) => r.habit.id);
      placeRows(tbody, rows, order);
      if (!table.contains(document.activeElement)) nav.park(Math.max(0, week.indexOf(key)));
      nav.sync();
    },
    focusHabit(id) {
      const row = rows.get(id);
      if (!row) return;
      row.tr.scrollIntoView({ block: 'nearest' });
      const col = week.indexOf(todayKey());
      if (col >= 0) nav.focus(id, col);
      else row.head.name.focus();
    },
    focusStart() {
      const first = order[0];
      if (first) nav.focus(first, Math.max(0, week.indexOf(ui.key)));
    },
    pop(id, key) {
      const cell = rows.get(id)?.cells.find((c) => c.data?.key === key);
      if (!cell) return;
      replay(cell.btn, 'is-popping');
      ctx.later(() => cell.btn.classList.remove('is-popping'), 600);
    },
    celebrate: () => readout.celebrate(),
  };
}

/* ---- DAY: a strip of the week's days, then the day's habits as a list ---- */

function createDayView(ctx) {
  const { actions, ui } = ctx;
  const strip = createDayStrip(ctx);
  const readout = createReadout(ctx);
  const rows = new Map(); // id -> row (one per habit, moved between the two lists)
  let groups = { planned: [], other: [] }; // ids per list, top to bottom

  const titleIcon = h('span', { class: 'hb-dl-title-ic', 'aria-hidden': 'true' });
  const titleText = h('span', { class: 'hb-dl-title-text' });
  const titleEl = h('h2', { class: 'hb-dl-title' }, titleIcon, titleText);
  let titleIconName = null;
  const addLabel = h('span');
  const addBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm hb-dl-add', onClick: () => actions.openEditor(null, { weekday: L.weekdayOfKey(ui.key) }) }, icon('plus', { size: 14 }), addLabel);
  const plannedList = h('ul', { class: 'hb-dl' });
  const emptyEl = h('p', { class: 'hb-dl-empty' });
  const otherCount = h('span', { class: 'tnum' });
  const otherTitle = h('h3', { class: 'label hb-dl-sub' }, icon('circle-slash', { size: 13 }), h('span', null, 'Not planned'), otherCount);
  const otherList = h('ul', { class: 'hb-dl is-other' });
  const otherSec = h('section', { class: 'hb-dl-more' }, otherTitle, otherList);
  const el = h(
    'section',
    { class: 'hb-view hb-dayview', 'aria-label': 'Day' },
    tipEl('habits.day', "Tick a habit once you've done it."),
    strip.el,
    // The day first (where you are), its numbers at the end of the line, then "add"
    h('div', { class: 'panel hud hb-dl-panel' }, h('div', { class: 'hb-dl-head' }, titleEl, h('span', { class: 'spacer' }), readout.el, addBtn), plannedList, emptyEl, otherSec),
  );

  function fill(list, entries, group, c) {
    const ids = entries.map((e) => e.habit.id);
    entries.forEach((e, i) => {
      let row = rows.get(e.habit.id);
      if (!row) {
        row = createDayRow(ctx, e.habit.id, (id, delta) => actions.move(id, delta, groups[rows.get(id)?.group] ?? null));
        rows.set(e.habit.id, row);
      }
      row.group = group;
      row.update(e, { ...c, group, index: i, count: entries.length });
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
    });
    // Rows that left this list (moved to the other one, or gone)
    for (const li of [...list.children]) if (!ids.includes(li.dataset.id)) li.remove();
    return ids;
  }

  return {
    el,
    update({ items, today, key }) {
      const week = L.weekDays(key);
      const series = S.dailySeries(items, week[0], week[6], today);
      const day = series[week.indexOf(key)];
      const wd = L.weekdayOfKey(key);
      strip.update(series, key, today);
      readout.update(day, key, today, L.topStreak(items, today));
      const near = Math.abs(L.toDayNum(key) - L.toDayNum(today)) <= 1;
      titleText.textContent = near ? `${relativeDay(key, today)} · ${formatDay(key)}` : longDate(key, today);
      // A sun for today, a sunrise for tomorrow, a calendar for any other day (the app's icon words)
      const dayIcon = key === today ? 'sun' : L.toDayNum(key) - L.toDayNum(today) === 1 ? 'sunrise' : 'calendar';
      if (dayIcon !== titleIconName) {
        titleIconName = dayIcon;
        titleIcon.replaceChildren(icon(dayIcon, { size: 15 }));
      }
      addLabel.textContent = `Add to ${WEEKDAYS_LONG[wd]}`;
      addBtn.setAttribute('aria-label', `New habit on ${WEEKDAYS_LONG[wd]}s`);
      addBtn.title = `New habit on ${WEEKDAYS_LONG[wd]}s`;

      const { planned, other } = L.dayRows(items, key, today);
      const c = { today, key, wd };
      groups = { planned: fill(plannedList, planned, 'planned', c), other: fill(otherList, other, 'other', c) };
      const live = new Set([...groups.planned, ...groups.other]);
      for (const id of [...rows.keys()]) if (!live.has(id)) rows.delete(id);

      plannedList.setAttribute('aria-label', `Planned on ${formatDay(key)}`);
      plannedList.hidden = !planned.length;
      emptyEl.hidden = !!planned.length;
      emptyEl.textContent =
        day.active === 0 && key <= today
          ? `No habit was active on ${formatDay(key)}.`
          : key < today
            ? `Nothing was planned on ${formatDay(key)}: a rest day.`
            : `Nothing planned for ${WEEKDAYS_LONG[wd]}: a rest day.`;
      otherSec.hidden = !other.length;
      otherCount.textContent = `· ${other.length}`;
      otherTitle.title = 'A tick here counts as a bonus: logged, but neutral for streaks';
      otherList.setAttribute('aria-label', `Not planned on ${formatDay(key)}`);
    },
    focusHabit(id) {
      const row = rows.get(id);
      if (!row) return;
      row.li.scrollIntoView({ block: 'nearest' });
      row.focus();
    },
    focusStart: () => strip.focusSelected(),
    pop: (id, key) => (key === ui.key ? rows.get(id)?.pop() : null),
    celebrate: () => readout.celebrate(),
  };
}

/** The week's days as a radio strip: tap a day to list it. */
function createDayStrip(ctx) {
  const { ui } = ctx;
  const days = Array.from({ length: 7 }, () => {
    const d = { key: null };
    d.wd = h('span', { class: 'hb-sel-wd' });
    d.date = h('span', { class: 'hb-sel-date tnum' });
    d.fill = h('span', { class: 'hb-sel-fill' });
    d.btn = h('button', { type: 'button', role: 'radio', class: 'hb-sel', tabindex: '-1', 'aria-checked': 'false', onClick: () => ctx.select(d.key) }, d.wd, d.date, h('span', { class: 'hb-sel-bar', 'aria-hidden': 'true' }, d.fill));
    return d;
  });
  const el = h('div', { class: 'hb-sel-strip', role: 'radiogroup', 'aria-label': 'Day', onKeydown }, days.map((d) => d.btn));

  function focusSelected() {
    days.find((d) => d.key === ui.key)?.btn.focus();
  }

  /** Arrows move a day (crossing weeks), PageUp/PageDown a week, Home/End to Mon/Sun. Selection follows focus. */
  function onKeydown(e) {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1, PageUp: -7, PageDown: 7 }[e.key];
    const monday = L.toDayNum(L.weekStart(ui.key));
    let target = null;
    if (typeof delta === 'number') target = L.fromDayNum(L.toDayNum(ui.key) + delta);
    else if (e.key === 'Home') target = L.fromDayNum(monday);
    else if (e.key === 'End') target = L.fromDayNum(monday + 6);
    if (!target) return;
    e.preventDefault();
    ctx.select(target);
    focusSelected();
  }

  return {
    el,
    focusSelected,
    update(series, key, today) {
      series.forEach((entry, i) => {
        const d = days[i];
        const isToday = entry.key === today;
        const selected = entry.key === key;
        const counts = !entry.planned ? 'nothing planned' : entry.future ? `${plural(entry.planned, 'habit')} planned` : `${entry.done} of ${entry.planned} done`;
        d.key = entry.key;
        d.wd.textContent = WEEKDAYS_SHORT[entry.weekday];
        d.date.textContent = dayOf(entry.key);
        d.fill.style.width = entry.planned && !entry.future ? `${Math.round((entry.done / entry.planned) * 100)}%` : '0%';
        d.btn.setAttribute('aria-checked', String(selected));
        d.btn.tabIndex = selected ? 0 : -1;
        d.btn.classList.toggle('is-today', isToday);
        d.btn.classList.toggle('is-future', entry.future);
        d.btn.classList.toggle('is-rest', !entry.planned);
        d.btn.classList.toggle('is-perfect', !entry.future && !entry.pending && entry.planned > 0 && entry.done === entry.planned);
        d.btn.setAttribute('aria-label', `${formatDay(entry.key, 'long')}${isToday ? ', today' : ''}: ${counts}`);
        d.btn.title = `${formatDay(entry.key)} · ${counts}`;
      });
    },
  };
}

/** One habit in the day list: check · name (opens the editor) · streak · ⋯ menu. */
function createDayRow(ctx, id, onMove) {
  const { actions } = ctx;
  let cur = { key: null, wd: null };
  const check = checkButton({ onToggle: (next) => actions.log(id, cur.key, next) });
  check.classList.add('hb-row-check');
  const badge = habitBadge('hb-row-ib');
  const nameText = h('span', { class: 'hb-row-name-text' });
  const name = h('button', { type: 'button', class: 'hb-row-name', onClick: () => actions.openEditor(id) }, nameText);
  const sub = h('span', { class: 'hb-row-sub label' });
  const streakNum = h('span');
  const streak = h('span', { class: 'hb-mx-streak hb-row-streak tnum' }, icon('flame', { size: 12 }), h('span', { class: 'sr-only' }, 'streak '), streakNum);
  const more = dropdown({ icon: 'more', items: [], showValue: false, align: 'end', className: 'btn--ghost btn--icon hb-row-more', title: 'More' });
  // A tap anywhere on the row that isn't one of its buttons ticks it (the whole row is the target)
  const onRowClick = (e) => {
    if (e.target instanceof Element && e.target.closest('button, a, input, .dd')) return;
    if (!check.disabled) check.click();
  };
  const li = h('li', { class: 'hb-row', dataset: { id }, onKeydown: onRowKey, onClick: onRowClick }, check, badge.el, h('div', { class: 'hb-row-ident' }, name, sub), streak, more.el);
  const row = { li, group: 'planned', update, focus, pop };

  function onRowKey(e) {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    onMove(id, e.key === 'ArrowUp' ? -1 : 1);
  }

  function menuItems(hb, { group, index, count, wd, today, plannedNow }) {
    const items = [
      { value: 'edit', label: 'Edit…', icon: 'edit', action: () => actions.openEditor(id) },
      { value: 'up', label: 'Move up', icon: 'arrow-up', hint: KEY_HINTS ? `${ALT_KEY}↑` : null, disabled: index === 0, action: () => onMove(id, -1) },
      { value: 'down', label: 'Move down', icon: 'arrow-down', hint: KEY_HINTS ? `${ALT_KEY}↓` : null, disabled: index === count - 1, action: () => onMove(id, 1) },
      { separator: true },
    ];
    if (group === 'other' && !plannedNow && !L.isArchived(hb, today)) {
      items.push({ value: 'plan', label: `Plan on ${WEEKDAYS_LONG[wd]}s`, icon: 'calendar', action: () => actions.addDay(id, wd) });
    }
    items.push(
      { value: 'duplicate', label: 'Duplicate', icon: 'ctx-duplicate', action: () => actions.duplicate(id) },
      L.isArchived(hb, today)
        ? { value: 'restore', label: 'Restore', icon: 'undo', action: () => actions.unarchive(id) }
        : { value: 'archive', label: 'Archive', icon: 'archive', action: () => actions.archive(id) },
      { value: 'delete', label: 'Delete…', icon: 'trash', danger: true, action: () => actions.remove(id) },
    );
    return items;
  }

  function subText(hb, state, { group, today, key, plannedNow }) {
    if (L.isArchived(hb, today)) return `Archived ${formatDay(hb.archivedAt)}`;
    // Its days only when they aren't every day
    const plan = planNote(L.planOn(hb, today));
    const join = (...parts) => parts.filter(Boolean).join(' · ');
    if (group === 'other') {
      if (state === 'bonus') return join('Bonus', plan);
      if (plannedNow) return hb.createdAt > key ? `Starts ${formatDay(hb.createdAt)}` : 'Planned from today';
      return hb.createdAt > today ? join(`Starts ${formatDay(hb.createdAt)}`, plan) : plan;
    }
    return state === 'miss' ? join('Missed', plan) : plan;
  }

  function update(entry, c) {
    const { habit: hb, state } = entry;
    const { today, key, wd, group } = c;
    const canLog = LOGGABLE.has(state);
    const when = key === today ? 'today' : `on ${formatDay(key)}`;
    cur = { key, wd };
    setChecked(check, L.isLogged(state));
    check.disabled = !canLog;
    check.setAttribute('aria-label', group === 'planned' ? `${hb.name}: done ${when}` : `${hb.name}: bonus session ${when}`);
    check.title = !canLog ? (state === 'future' ? 'Check-ins open on the day' : '') : group === 'other' ? 'Bonus: logged, but neutral for streaks' : '';
    badge.update(hb);
    nameText.textContent = hb.name;
    name.title = `${hb.name} — edit`;
    sub.textContent = subText(hb, state, { ...c, plannedNow: entry.plannedNow });
    sub.hidden = !sub.textContent;
    const s = L.currentStreak(hb, today);
    streak.hidden = s === 0;
    streakNum.textContent = num(s);
    streak.title = `${plural(s, 'day')} in a row`;
    li.classList.toggle('is-done', state === 'done');
    li.classList.toggle('is-bonus', state === 'bonus');
    li.classList.toggle('is-miss', state === 'miss');
    li.classList.toggle('is-locked', !canLog);
    more.update({ items: menuItems(hb, { ...c, plannedNow: entry.plannedNow }) });
    more.button.setAttribute('aria-label', `More for “${hb.name}”`);
  }

  function focus() {
    (check.disabled ? name : check).focus();
  }

  function pop() {
    replay(check, 'is-popping');
    ctx.later(() => check.classList.remove('is-popping'), 600);
  }

  return row;
}

/* ---- HISTORY: habits × the last weeks (from the oldest habit's week: at least 4, at most 12,
   8 on a phone, so the squares stay big enough to tap) ---- */

function createHistoryView(ctx) {
  const { actions } = ctx;
  const rows = new Map();
  let order = [];
  let weeks = []; // the Mondays shown
  let heads = [];
  const nav = gridNav({ ids: () => order, cellsOf: (id) => rows.get(id)?.cells.map((c) => c.btn) ?? [], onMove: (id, delta) => actions.move(id, delta, order) });

  const colgroup = h('colgroup');
  const headRow = h('tr');
  const sumLabel = h('span', { class: 'label' }, 'Rate');
  const tbody = h('tbody');
  const table = h('table', { class: 'hb-mx hb-hi', onKeydown: nav.onKeydown }, colgroup, h('thead', null, headRow), tbody);
  const el = h(
    'section',
    { class: 'hb-view hb-history', 'aria-label': 'History' },
    tipEl('habits.history', 'A square per week, darker the more got done. Tap one to open that week.'),
    h('div', { class: 'panel hud hb-mx-panel' }, h('div', { class: 'hb-mx-scroll' }, table)),
  );

  /** Columns for `count` weeks; the rows are made again for them. */
  function setColumns(count) {
    if (heads.length === count) return;
    heads = Array.from({ length: count }, () => {
      const month = h('span', { class: 'hb-hi-month' });
      const date = h('span', { class: 'hb-hi-date tnum' });
      return { th: h('th', { scope: 'col', class: 'hb-hi-th' }, month, date), month, date };
    });
    colgroup.replaceChildren(h('col', { class: 'hb-mx-namecol' }), ...heads.map(() => h('col')), h('col', { class: 'hb-mx-sumcol' }));
    headRow.replaceChildren(h('th', { scope: 'col', class: 'hb-mx-corner' }, h('span', { class: 'label' }, 'Week of')), ...heads.map((c) => c.th), h('th', { scope: 'col', class: 'hb-mx-sumth' }, sumLabel));
    table.setAttribute('aria-label', `Habits, last ${plural(count, 'week')}`);
    for (const row of rows.values()) row.tr.remove();
    rows.clear();
  }

  function createRow(id) {
    const head = createRowHead(ctx, id);
    const cells = heads.map((_, col) => {
      const btn = h('button', { type: 'button', class: 'hb-wk', tabindex: '-1', dataset: { col: String(col) }, onClick: () => openWeek(id, col), onFocus: () => nav.onFocus(id, col) });
      return { btn, td: h('td', { class: 'hb-mx-td' }, btn), data: null };
    });
    const sum = h('td', { class: 'hb-mx-sum mono tnum' });
    const tr = h('tr', { class: 'hb-mx-row', dataset: { id } }, head.th, cells.map((c) => c.td), sum);
    return { tr, head, cells, sum };
  }

  /** Open that week in the week matrix (this week opens on today). */
  function openWeek(id, col) {
    const w = rows.get(id)?.cells[col].data;
    if (!w) return;
    ctx.doneTips('habits.history');
    ctx.show('week', w.isCurrent ? todayKey() : w.key);
  }

  function paintRow(row, hb, list, today, archived) {
    row.head.update(hb, today, archived);
    row.tr.classList.toggle('is-archived', archived);
    let done = 0;
    let due = 0;
    list.forEach((w, col) => {
      const c = row.cells[col];
      done += w.done;
      due += w.due;
      const words = !w.active
        ? 'not active'
        : w.due
          ? `${w.done} of ${w.due} planned days done${w.isCurrent ? ' so far' : ''}`
          : w.isCurrent
            ? 'nothing due yet'
            : 'nothing planned';
      const bonus = w.bonus ? ` · ${plural(w.bonus, 'bonus day')}` : '';
      c.data = w;
      c.btn.dataset.l = w.level ?? '';
      c.btn.dataset.active = String(w.active);
      c.btn.classList.toggle('is-current', w.isCurrent);
      c.btn.setAttribute('aria-label', `${hb.name}, week of ${formatDay(w.key)}: ${words}${bonus}. Open the week`);
      c.btn.title = `${hb.name} · week of ${formatDay(w.key)} · ${words}${bonus}`;
      c.td.classList.toggle('is-today', w.isCurrent);
    });
    row.sum.textContent = due ? pct(done / due) : '—';
    row.sum.title = due ? `${done} of ${due} planned days done in the last ${plural(list.length, 'week')}` : 'Nothing due in these weeks';
  }

  return {
    el,
    update({ items, today, weeks: count = L.HISTORY_WEEKS }) {
      setColumns(count);
      const current = L.toDayNum(L.weekStart(today));
      weeks = heads.map((_, i) => L.fromDayNum(current - 7 * (count - 1 - i)));
      heads.forEach((hd, i) => {
        const key = weeks[i];
        const prev = weeks[i - 1];
        // The month where a new one starts (and on the first column)
        hd.month.textContent = !prev || prev.slice(5, 7) !== key.slice(5, 7) ? monthOf(key) : '';
        hd.date.textContent = dayOf(key);
        hd.th.classList.toggle('is-today', i === heads.length - 1);
        hd.th.title = `Week of ${formatDay(key)}`;
      });
      sumLabel.parentElement.title = `Done of planned in the last ${plural(count, 'week')}`;
      const shown = [];
      for (const hb of items) {
        const archived = L.isArchived(hb, today);
        const list = L.weekHistory(hb, today, count);
        if (archived && !list.some((w) => w.active)) continue;
        let row = rows.get(hb.id);
        if (!row) {
          row = createRow(hb.id);
          rows.set(hb.id, row);
        }
        paintRow(row, hb, list, today, archived);
        shown.push(hb.id);
      }
      order = shown;
      placeRows(tbody, rows, order);
      if (!table.contains(document.activeElement)) nav.park(heads.length - 1);
      nav.sync();
    },
    focusHabit(id) {
      const row = rows.get(id);
      if (!row) return;
      row.tr.scrollIntoView({ block: 'nearest' });
      nav.focus(id, heads.length - 1);
    },
    focusStart() {
      if (order[0]) nav.focus(order[0], heads.length - 1);
    },
    pop() {},
    celebrate() {},
  };
}

/* ---- First run (no active habits): what a habit is, then one tap to add a starter one. The
   header's New habit is the way to make your own, so the empty state doesn't repeat it (C3). ---- */

/** A starter habit as actions.create takes it. Its icon is stored only when the name wouldn't
 *  suggest it, so a rename can still move the icon. */
function starterHabit(s) {
  return { name: s.name, days: s.days, icon: L.habitIcon({ name: s.name }) === s.icon ? null : s.icon };
}

/** "Or start with one of these" and the starter habits, one tap each (the first run, and the new-habit editor from Home). */
function suggestionsEl(onPick, ...more) {
  return h(
    'div',
    { class: 'hb-suggest' },
    h('span', { class: 'label' }, term('habits.starter', 'Or start with one of these')),
    h(
      'div',
      { class: 'hb-suggest-list' },
      SUGGESTIONS.map((s) =>
        h(
          'button',
          { type: 'button', class: 'btn btn--sm hb-suggest-btn', 'aria-label': `Add “${s.name}” (${s.hint})`, onClick: () => onPick(s) },
          icon(s.icon, { size: 14 }),
          h('span', null, s.name),
          h('span', { class: 'hb-suggest-hint', 'aria-hidden': 'true' }, s.hint),
        ),
      ),
    ),
    ...more,
  );
}

function buildFirstRun(ctx, archivedCount) {
  const { actions } = ctx;
  const restore = archivedCount
    ? h('button', { type: 'button', class: 'btn', onClick: () => actions.openTab('plan') }, icon('archive'), `Restore from archive (${archivedCount})`)
    : null;
  const suggestions = suggestionsEl((s) => actions.create(starterHabit(s)), h('p', { class: 'hb-empty-kbd label lo-hint' }, 'Press ', kbd('N'), ' anytime to add a habit'));
  return [
    emptyState({
      icon: 'target',
      title: archivedCount ? term('habits.empty.archived', 'All habits are archived') : term('habits.empty.title', 'No habits yet'),
      text: archivedCount
        ? 'Every habit is archived: their history still feeds your graphs. Restore one, or add a new one with New habit.'
        : term('habits.empty.text', 'A habit is something small you do on chosen days, like a walk or reading. Add one with New habit, tick it off when it is done, and LIFE/OS keeps your streak.'),
      action: h('div', { class: 'hb-empty-actions' }, restore ? h('div', { class: 'hb-empty-buttons' }, restore) : null, suggestions),
    }),
  ];
}

export default {
  id: 'habits',
  title: 'Habits',
  icon: 'target',
  badge,
  mount,
  topbar(slot) {
    return mountTicker(slot, source);
  },
};
