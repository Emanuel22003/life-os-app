// LIFE/OS — 03 // Habits: weekday-planned protocols. The page pins the LIFE-index
// trading chart (habits.ticker.js) above three tabs: TODAY (day-first check-ins),
// WEEK PLAN (habits.plan.js) and INSIGHTS (habits.insights.js). Pure rules live in
// habits.logic.js / habits.stats.js (unit-tested); this file owns the store, the
// read-only `source` the other views share, and the mutations they all go through.

import {
  h,
  icon,
  pageHeader,
  emptyState,
  checkButton,
  setChecked,
  ring,
  toast,
  confirmDialog,
  todayKey,
  formatDay,
  relativeDay,
  onDayChange,
  idx,
  num,
  term,
  skin,
  plural,
  isTyping,
  modalOpen,
  WEEKDAYS_SHORT,
  WEEKDAYS_MIN,
  MONTHS_SHORT,
  reducedMotion,
} from '../ui.js';
import { createStore } from '../store.js';
import * as L from './habits.logic.js';
import * as S from './habits.stats.js';
import { mountPlan, openHabitModal, replay, prose, dayNames, WEEKDAYS_LONG } from './habits.plan.js';
import { mountInsights } from './habits.insights.js';
import { mountTradingChart, mountTicker } from './habits.ticker.js';
import { registerContextProvider } from '../contextmenu.js';
import { copyName, pasteName, insertAfter } from '../contextmenu.logic.js';

const TABS = Object.freeze([
  { id: 'today', label: 'Today', icon: 'sun' },
  { id: 'plan', label: 'Week plan', icon: 'calendar' },
  { id: 'insights', label: 'Insights', icon: 'activity' },
]);
const TAB_IDS = TABS.map((t) => t.id);
const HABITS_ROUTE = /^#\/habits(?![\w-])/;
const METER_MAX = 8; // segments in a day-selector meter

const SUGGESTIONS = [
  { name: 'Drink water', days: L.ALL_DAYS, hint: 'Daily' },
  { name: 'Move 30 min', days: [1, 2, 3, 4, 5], hint: 'Weekdays' },
  { name: 'Read 20 min', days: [1, 3, 5], hint: 'Mon · Wed · Fri' },
  { name: 'Plan the week', days: [0], hint: 'Sundays' },
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

// Caption under the big check
const CHECK_CAPTION = { done: 'Done', pending: 'Today', miss: 'Missed', future: 'Planned' };

const ALT_KEY = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '') ? '⌥' : 'Alt';

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

/* ==========================================================================
   State — one store shared by the page, the nav badge, the ticker and the charts
   ========================================================================== */

const store = createStore('habits', { items: [], view: 'week' });

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
// v1 stored the card toggle as `view`; it migrates to `cardView` on the first change.
const cardViewOf = (s) => (L.VIEWS.includes(s.cardView) ? s.cardView : L.VIEWS.includes(s.view) ? s.view : L.VIEWS[0]);

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

function setCardView(view) {
  commit((s) => (cardViewOf(s) === view ? s : { ...s, cardView: view }));
}

/** fn() on habit-data changes only: UI prefs (open tab, card view) share the store but don't fire it. */
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

/** For the Calendar: the shared read-only source plus check-ins. */
export const habitsApi = Object.freeze({ source, setLog: setLogFromApi });

function badge() {
  const sum = L.todaySummary(getItems(), todayKey());
  return sum.scheduled ? `${sum.done}/${sum.scheduled}` : '';
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

/** 'Mon 05 Oct' (+ year when it isn't the current one). */
function shortDate(key, today) {
  const year = key.slice(0, 4);
  return `${WEEKDAYS_SHORT[L.weekdayOfKey(key)]} ${dayOf(key)} ${monthOf(key)}${year === today.slice(0, 4) ? '' : ` ${year}`}`;
}

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

/** [text, 'solid' | 'dashed' | ''] for the selected day's badge. */
function dayBadge(day, isToday, future) {
  if (!day.planned && day.active === 0 && !future) return ['No habits', 'dashed'];
  if (!day.planned) return ['Rest day', 'dashed'];
  if (future) return ['Planned', 'dashed'];
  if (day.done === day.planned) return [isToday ? 'All complete' : 'Perfect day', 'solid'];
  if (isToday) return [day.done ? `${day.planned - day.done} pending` : 'Standby', ''];
  return [`${day.planned - day.done} missed`, ''];
}

function dayStatusLine(day, { isToday, future, perfect }) {
  if (skin() === 'simple') return plainStatusLine(day, { isToday, future });
  const left = day.planned - day.done;
  if (!day.planned) {
    if (future) return 'Nothing planned yet — a rest day, unless you give it a lineup.';
    if (day.active === 0) return isToday ? 'No habit has started yet — plans begin on their start date.' : 'No habit was active on this day — nothing to track.';
    if (day.bonus) return `Rest day — ${plural(day.bonus, 'bonus session')} logged. Streaks are safe.`;
    return isToday ? 'Rest day. Nothing planned, streaks are safe. Recover, or log a bonus session below.' : 'Rest day — nothing was planned.';
  }
  if (future) return `${plural(day.planned, 'habit')} planned. Check-ins open on the day.`;
  if (isToday) {
    if (!left) return perfect > 1 ? `Every protocol executed. Perfect-day streak extended to ${perfect}.` : 'Every protocol executed. Perfect day secured.';
    if (!day.done) return `${plural(day.planned, 'protocol')} queued for today. Start with the easiest one.`;
    return perfect ? `${left} to go — finish to extend your ${perfect}-day perfect run.` : `${left} to go — keep the chain alive.`;
  }
  if (!left) return 'Perfect day — every planned habit was done.';
  return `${day.done} of ${day.planned} done, ${left} missed. Check one off below to correct the record.`;
}

/** Simple's wording for the selected day: everyday words, no streak maths. */
function plainStatusLine(day, { isToday, future }) {
  const left = day.planned - day.done;
  if (!day.planned) {
    if (day.active === 0) return future ? 'Nothing planned for this day.' : 'No habits yet on this day.';
    if (future) return 'Nothing planned for this day.';
    if (day.bonus) return 'A rest day, with an extra check-in.';
    return isToday ? 'Nothing planned today. Enjoy the rest.' : 'Nothing was planned this day.';
  }
  if (future) return 'You can check these off on the day.';
  if (isToday) {
    if (!left) return 'All done for today. Nice work!';
    if (!day.done) return 'Tick a habit below once you have done it.';
    return `${left} to go.`;
  }
  return left ? 'You can still tick off a missed habit below.' : 'Everything was done this day.';
}

/** Simple's headline for the selected day: "2 of 5 done today". */
function plainDayTitle(day, key, today) {
  const isToday = key === today;
  const when = isToday ? 'today' : `on ${shortDate(key, today)}`;
  if (!day.planned) return day.active === 0 && key <= today ? `No habits ${when}` : `Rest day ${when}`;
  if (key > today) return `${plural(day.planned, 'habit')} planned ${when}`;
  return `${day.done} of ${day.planned} done ${when}`;
}

/** Card state line for the selected day. */
function stateLine(hb, status, { key, today }) {
  const fresh = hb.createdAt === key ? 'New · ' : '';
  if (status === 'done') return `${fresh}${key === today ? 'Complete today' : `Done · ${formatDay(key)}`}`;
  if (status === 'pending') return `${fresh}Due today`;
  if (status === 'miss') return `${fresh}Missed · ${formatDay(key)}`;
  if (status === 'future') return `${fresh}Planned · ${relativeDay(key, today)}`;
  return STATE_COPY[status] ?? '';
}

const cellCopy = (d) => (d.state === 'future' ? (d.scheduled ? 'Planned' : 'Not planned') : STATE_COPY[d.state]);

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
  // notPlannedOpen: null = automatic (open only on a day with nothing planned)
  const ui = { key: lastToday, followToday: true, notPlannedOpen: null };

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

  function create({ name, days, createdAt } = {}) {
    const habit = L.createHabit({ name, days, createdAt }, getItems().length, todayKey());
    updateItems((items) => [...items, { ...habit, order: items.length }]);
    toast(prose(`“${habit.name}” is online · ${L.scheduleLabel(habit.plan[0].days)}.`), {
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
    todayView?.pop(id, key);
    if (key !== today) return;
    const after = L.todaySummary(getItems(), today);
    if (after.complete && !before.complete) {
      todayView?.celebrate();
      toast(term('habits.allDone', `All protocols complete. Perfect-day streak: ${num(L.perfectDayStreak(getItems(), today))}.`));
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

  /** Confirm, then erase the habit and its history. -> true (deleted) | false (cancelled) | null (gone). */
  async function remove(id) {
    const hb = findHabit(id);
    if (!hb) {
      toast('That habit no longer exists.');
      return null;
    }
    const logged = Object.keys(hb.log).length;
    const confirmed = await confirmDialog({
      title: 'Delete forever?',
      message: prose(
        `“${hb.name}” and its entire history (${plural(logged, 'logged day')}) will be erased from every graph — streaks, insights and the LIFE index. Archive it instead to keep the history.`,
      ),
      confirmLabel: 'Delete forever',
      danger: true,
    });
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

  /** What a copy carries: the name and the weekdays planned from today on (never the check-ins). */
  function habitSnapshot(hb) {
    return { name: hb.name, days: L.planOn(hb, todayKey()) };
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
    const habit = L.createHabit({ name, days }, items.length, today);
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

  /** The right-click menu: a Today card, a not-planned row, a Week plan row, or anywhere else (paste at the end). */
  function contextTarget(el) {
    if (!mounted || !root.contains(el)) return null;
    const itemEl = el.closest('.hb-card[data-id], .hb-np-row[data-id], .hb-plan-row[data-id]');
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
    };
  }

  /** Move by `delta`, counted among `visible` ids when given (the Today list or the plan rows). */
  function move(id, delta, visible = null) {
    todayView?.prepareFlip();
    updateItems((items) => L.moveHabitWithin(items, id, delta, visible ?? undefined));
    todayView?.cancelFlip();
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
    move,
  };
  const ctx = { actions, ui, later, select };

  /* ---- Layout: header, pinned LIFE-index chart, tab bar, tab panel ---- */

  const addBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary hb-add', 'aria-keyshortcuts': 'N', onClick: () => openEditor() },
    icon('plus'),
    h('span', null, 'New habit'),
    h('span', { class: 'kbd hb-add-kbd lo-hint', 'aria-hidden': 'true' }, 'N'),
  );
  const header = pageHeader({
    index: '04',
    title: 'Habits',
    subtitle: term('habits.subtitle', 'Plan each weekday. Check in daily. Watch your LIFE index compound.'),
    actions: [addBtn],
  });

  // The LIFE index is a trading readout: Simple leaves it out (.lo-deco), the tabs below do everything
  const chartSlot = h('div', { class: 'hb-chart-slot lo-deco' });

  const panelId = `${n}-panel`;
  const tabEls = TABS.map((t) => {
    const count = h('span', { class: 'seg-count tnum hb-tab-count lo-deco' });
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
      icon(t.icon, { size: 12 }),
      h('span', null, t.label),
      count,
    );
    return { ...t, btn, count };
  });
  const tablist = h('div', { class: 'seg hb-tabs', role: 'tablist', 'aria-label': 'Habits views', onKeydown: onTabKey }, tabEls.map((t) => t.btn));
  const panel = h('div', { class: 'hb-panel', id: panelId, role: 'tabpanel' });

  root.append(header, chartSlot, tablist, panel);

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

  function paintTabCounts(items, today) {
    const sum = L.todaySummary(items, today);
    tabEls[0].count.textContent = sum.scheduled ? `${sum.done}/${sum.scheduled}` : '';
    tabEls[1].count.textContent = sum.total ? num(sum.total) : '';
  }

  function render() {
    if (!mounted) return;
    syncDay();
    const state = getState();
    showTab(currentTab());
    paintTabCounts(state.items, todayKey());
    todayView?.render();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e) || modalOpen()) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openEditor();
    }
  }

  const offChart = guard('LIFE index', () => mountTradingChart(chartSlot, source), chartSlot);
  localTab ??= tabOf(getState());
  refreshPage = render;
  render();

  const unsubscribe = store.subscribe(render);
  const offDayChange = onDayChange(render);
  const offMenu = registerContextProvider('habits', contextTarget);
  document.addEventListener('keydown', onKey);

  return () => {
    mounted = false;
    if (refreshPage === render) refreshPage = null;
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
   TODAY tab — day selector + progress, the selected day's habits, the rest
   ========================================================================== */

function createTodayView(ctx) {
  const { actions, ui } = ctx;
  const cards = new Map();
  let visible = [];
  let lastKey = null;
  let flipFrom = null;
  let emptySig = '';
  let firstRunSig = '';

  const dayConsole = createConsole(ctx);
  const toolbar = createToolbar();
  const grid = h('ul', { class: 'hb-grid', 'aria-label': 'Habits planned for the selected day' });
  const dayEmpty = h('div', { class: 'hb-day-empty' });
  const notPlanned = createNotPlanned(ctx);
  const main = h('div', { class: 'hb-today' }, dayConsole.el, toolbar.el, grid, dayEmpty, notPlanned.el);
  const firstRun = h('div', { class: 'hb-empty', hidden: true });
  const el = h('div', { class: 'hb-today-wrap' }, main, firstRun);

  const moveCard = (id, delta) => actions.move(id, delta, visible);

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
      clearCards();
      return;
    }
    if (firstRunSig) {
      firstRunSig = '';
      firstRun.replaceChildren();
    }

    const key = ui.key;
    const view = cardViewOf(state);
    const week = L.weekDays(key);
    const series = S.dailySeries(items, week[0], week[6], today);
    const dayHabits = L.habitsForDay(items, key);
    visible = dayHabits.map((it) => it.id);

    const day = series[week.indexOf(key)];
    dayConsole.update({ items, today, key, series, day });
    toolbar.update(view, dayHabits.length);
    paintCards(dayHabits, { today, key, week, view });
    paintDayEmpty(key, today, dayHabits.length ? null : day);
    notPlanned.update(items, key, today, new Set(visible));
    lastKey = key;
  }

  function paintCards(list, c) {
    const active = document.activeElement;
    const before = flipFrom;
    const stagger = lastKey === null || lastKey !== c.key;
    flipFrom = null;

    const ids = new Set(list.map((it) => it.id));
    for (const [id, card] of cards) {
      if (ids.has(id)) continue;
      card.el.remove();
      cards.delete(id);
    }
    list.forEach((it, i) => {
      let card = cards.get(it.id);
      if (!card) {
        card = createCard(ctx, it.id, moveCard);
        card.enter(stagger ? i : 0);
        cards.set(it.id, card);
      }
      card.update(it, { ...c, index: i, count: list.length });
      if (grid.children[i] !== card.el) grid.insertBefore(card.el, grid.children[i] ?? null);
    });

    if (before) flip(before);
    // Moving a card in the DOM drops focus; put it back where the user was.
    if (active instanceof HTMLElement && active !== document.activeElement && active.isConnected) active.focus({ preventScroll: true });
  }

  function clearCards() {
    cards.forEach((card) => card.el.remove());
    cards.clear();
  }

  /** FLIP: slide cards from their old position to the new one. */
  function flip(before) {
    if (reducedMotion()) return;
    for (const [id, card] of cards) {
      const a = before.get(id);
      if (!a || typeof card.el.animate !== 'function') continue;
      const b = card.el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (!dx && !dy) continue;
      card.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 340, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }
  }

  /** Empty-day state; `day` is the selected day's series entry, or null when it has habits. */
  function paintDayEmpty(key, today, day) {
    dayEmpty.hidden = !day;
    const past = key < today;
    const idle = past && day?.active === 0; // before the first habit, or after all were archived
    const sig = day ? `${key}|${past}|${idle}` : '';
    if (sig === emptySig) return;
    emptySig = sig;
    if (!day) {
      dayEmpty.replaceChildren();
      return;
    }
    const wd = L.weekdayOfKey(key);
    const name = WEEKDAYS_LONG[wd];
    const text = idle
      ? `No habit was active on ${formatDay(key)} — nothing to track. Plans you add now apply from today.`
      : past
        ? `No habits were planned on ${formatDay(key)}, so it counted as a rest day. Plans you add now apply from today.`
        : `Enjoy the rest — or give ${name}s a lineup of their own.`;
    dayEmpty.replaceChildren(
      emptyState({
        icon: 'calendar',
        title: `Nothing planned for ${name}`,
        text,
        action: h(
          'div',
          { class: 'hb-day-empty-actions' },
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', onClick: () => actions.openEditor(null, { weekday: wd }) }, icon('plus', { size: 14 }), `Add habit to ${name}`),
          h('button', { type: 'button', class: 'btn btn--sm', onClick: () => actions.openTab('plan') }, icon('calendar', { size: 14 }), 'Open week plan'),
        ),
      }),
    );
  }

  return {
    el,
    render,
    reveal(id) {
      const card = cards.get(id);
      if (!card) return;
      card.el.scrollIntoView({ block: 'nearest' });
      card.focusCheck();
    },
    /** The control the user just used went away: follow the habit to its card, else stay in the list. */
    handoff(id) {
      if (el.contains(document.activeElement)) return;
      const card = cards.get(id);
      if (card) {
        card.el.scrollIntoView({ block: 'nearest' });
        card.focusMain();
      } else {
        notPlanned.focus();
      }
    },
    pop: (id, key) => cards.get(id)?.pop(key),
    celebrate: () => dayConsole.celebrate(),
    prepareFlip() {
      flipFrom = new Map([...cards].map(([id, card]) => [id, card.el.getBoundingClientRect()]));
    },
    cancelFlip() {
      flipFrom = null;
    },
    destroy: () => dayConsole.destroy(),
  };
}

/* ---- Day console: week navigation, day selector strip, selected-day progress ---- */

function createConsole(ctx) {
  const { ui, actions, later } = ctx;

  const step = (days) => ctx.select(L.fromDayNum(L.toDayNum(ui.key) + days));
  const rangeEl = h('span', { class: 'label tnum hb-week-range' });
  const relEl = h('span', { class: 'tag hb-week-rel' });
  const prevBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hb-week-step', 'aria-label': 'Previous week', title: 'Previous week', onClick: () => step(-7) }, icon('chevron-left'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hb-week-step', 'aria-label': 'Next week', title: 'Next week', onClick: () => step(7) }, icon('chevron-right'));
  const todayBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--sm hb-week-today',
      onClick: () => {
        ctx.select(todayKey());
        focusSelected();
      },
    },
    icon('target', { size: 14 }),
    'Today',
  );

  const days = Array.from({ length: 7 }, () => {
    const d = { key: null, segs: -1 };
    d.wd = h('span', { class: 'hb-sel-wd' });
    d.date = h('span', { class: 'hb-sel-date mono tnum' });
    d.meter = h('span', { class: 'hb-sel-meter', 'aria-hidden': 'true' });
    d.count = h('span', { class: 'hb-sel-count mono tnum lo-deco' });
    d.btn = h('button', { type: 'button', role: 'radio', class: 'hb-sel', tabindex: '-1', 'aria-checked': 'false', onClick: () => ctx.select(d.key) }, d.wd, d.date, d.meter, d.count);
    return d;
  });
  const strip = h('div', { class: 'hb-sel-strip', role: 'radiogroup', 'aria-label': 'Day', onKeydown: onStripKey }, days.map((d) => d.btn));

  /* -- progress: compact ring + readouts for the selected day -- */

  const ringEl = ring({ value: 0, size: 84, stroke: 4 });
  // Size is driven by CSS so the dial can shrink on phones.
  ringEl.style.width = '';
  ringEl.style.height = '';
  ringEl.classList.add('hb-ring');
  const fracDone = h('span', { class: 'hb-ring-done' });
  const fracSlash = h('span', { class: 'hb-ring-slash' }, '/');
  const fracTotal = h('span', { class: 'hb-ring-total' });
  const ringSub = h('span', { class: 'hb-ring-sub lo-deco' });
  ringEl.setLabel(h('div', { class: 'hb-ring-readout' }, h('div', { class: 'hb-ring-frac mono tnum' }, fracDone, fracSlash, fracTotal), ringSub));

  // ring() animates to its initial value on the next frame; apply ours one frame
  // later so the fill sweeps in from zero.
  let ringValue = 0;
  let ringLive = false;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      ringLive = true;
      ringEl.setValue(ringValue);
    }),
  );

  const dial = h('div', { class: 'hb-dial', role: 'img' }, h('span', { class: 'hb-dial-ticks', 'aria-hidden': 'true' }), ringEl);
  const titleEl = h('h2', { class: 'hb-dayline label tnum' });
  const badgeEl = h('span', { class: 'tag hb-day-badge lo-deco' });
  const addLabel = h('span');
  const addBtn = h('button', { type: 'button', class: 'btn btn--sm hb-day-add', onClick: () => actions.openEditor(null, { weekday: L.weekdayOfKey(ui.key) }) }, icon('plus', { size: 14 }), addLabel);
  const statusEl = h('p', { class: 'hb-status', 'aria-live': 'polite' });

  const readout = (label) => {
    const value = h('dd', { class: 'hb-readout-value mono tnum' });
    const sub = h('dd', { class: 'hb-readout-sub' });
    return { el: h('div', { class: 'hb-readout' }, h('dt', { class: 'label' }, label), value, sub), value, sub };
  };
  const rPerfect = readout('Perfect days');
  const rTop = readout('Top streak');
  const rRate = readout('30-day rate');
  const rateTicks = Array.from({ length: 10 }, () => h('span', { class: 'meter-tick' }));
  rRate.el.append(h('dd', { class: 'hb-readout-meter', 'aria-hidden': 'true' }, h('div', { class: 'meter' }, rateTicks)));

  const cycleTicks = Array.from({ length: 24 }, () => h('span', { class: 'meter-tick' }));
  const cycleLeft = h('span', { class: 'label tnum hb-cycle-left' });
  const cycle = h('div', { class: 'hb-cycle lo-deco' }, h('span', { class: 'label' }, 'Day cycle'), h('div', { class: 'meter hb-cycle-meter', 'aria-hidden': 'true' }, cycleTicks), cycleLeft);

  const el = h(
    'section',
    { class: 'panel hud hb-console', 'aria-label': 'Day selector and progress' },
    h('div', { class: 'hb-weeknav' }, prevBtn, h('div', { class: 'hb-week-meta' }, rangeEl, relEl), nextBtn, h('span', { class: 'spacer' }), todayBtn),
    strip,
    h(
      'div',
      { class: 'hb-dayhead' },
      dial,
      h(
        'div',
        { class: 'hb-dayhead-main' },
        h('div', { class: 'hb-dayhead-top' }, titleEl, badgeEl, addBtn),
        statusEl,
        h('dl', { class: 'hb-readouts lo-deco' }, rPerfect.el, rTop.el, rRate.el),
        cycle,
      ),
    ),
  );

  function focusSelected() {
    days.find((d) => d.key === ui.key)?.btn.focus();
  }

  /** Arrows move a day (crossing weeks), PageUp/PageDown a week, Home/End to Mon/Sun. Selection follows focus. */
  function onStripKey(e) {
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

  function paintMeter(d, entry) {
    const segs = Math.max(1, Math.min(entry.planned, METER_MAX));
    if (segs !== d.segs) {
      d.meter.replaceChildren(...Array.from({ length: segs }, () => h('span', { class: 'hb-sel-seg' })));
      d.segs = segs;
    }
    const lit = entry.future || !entry.planned ? 0 : entry.planned <= METER_MAX ? entry.done : Math.round((entry.done / entry.planned) * METER_MAX);
    [...d.meter.children].forEach((s, i) => s.classList.toggle('is-on', i < lit));
    d.meter.dataset.mode = !entry.planned ? 'rest' : entry.future ? 'future' : 'past';
  }

  function paintDay(d, entry, key, today) {
    const isToday = entry.key === today;
    const selected = entry.key === key;
    const perfect = !entry.future && !entry.pending && entry.planned > 0 && entry.done === entry.planned;
    d.key = entry.key;
    d.wd.textContent = WEEKDAYS_SHORT[entry.weekday];
    d.date.textContent = dayOf(entry.key);
    d.count.textContent = !entry.planned ? '—' : entry.future ? String(entry.planned) : `${entry.done}/${entry.planned}`;
    d.btn.setAttribute('aria-checked', String(selected));
    d.btn.tabIndex = selected ? 0 : -1;
    d.btn.classList.toggle('is-today', isToday);
    d.btn.classList.toggle('is-future', entry.future);
    d.btn.classList.toggle('is-rest', !entry.planned);
    d.btn.classList.toggle('is-perfect', perfect);
    const counts = !entry.planned ? 'nothing planned' : entry.future ? `${plural(entry.planned, 'habit')} planned` : `${entry.done} of ${entry.planned} done`;
    d.btn.setAttribute('aria-label', `${formatDay(entry.key, 'long')}${isToday ? ', today' : ''}: ${counts}`);
    d.btn.title = `${formatDay(entry.key)} · ${counts}`;
    paintMeter(d, entry);
  }

  function paintHead(items, today, key, day) {
    const wd = L.weekdayOfKey(key);
    const isToday = key === today;
    const future = key > today;
    const resting = !day.planned;
    const idle = resting && !future && day.active === 0; // no habit existed that day
    const complete = !resting && !future && day.done === day.planned;
    const perfect = L.perfectDayStreak(items, today);
    const top = L.topStreak(items, today);
    const rate = L.overallRate(items, today);

    titleEl.textContent =
      skin() === 'simple'
        ? plainDayTitle(day, key, today)
        : [shortDate(key, today), idle ? 'No habits' : resting ? 'Rest day' : plural(day.planned, 'habit'), resting ? null : future ? 'Planned' : `${day.done}/${day.planned} done`]
            .filter(Boolean)
            .join(' · ');
    addLabel.textContent = `Add habit to ${WEEKDAYS_LONG[wd]}`;

    ringValue = resting || future ? 0 : day.done / day.planned;
    if (ringLive) ringEl.setValue(ringValue);
    fracDone.textContent = resting || future ? '—' : String(day.done);
    fracSlash.hidden = resting;
    fracTotal.textContent = resting ? '' : String(day.planned);
    ringSub.textContent = idle ? 'Idle' : resting ? 'Rest' : future ? 'Planned' : complete ? 'Complete' : pct(ringValue);
    dial.setAttribute('aria-label', resting ? 'Nothing planned' : future ? `${plural(day.planned, 'habit')} planned` : `${day.done} of ${day.planned} done`);

    el.classList.toggle('is-complete', complete);
    el.classList.toggle('is-rest', resting);
    el.classList.toggle('is-future', future);
    el.classList.toggle('is-active', isToday && !resting && !complete && day.done > 0);

    const [text, style] = dayBadge(day, isToday, future);
    badgeEl.className = ['tag', 'hb-day-badge', 'lo-deco', style && `tag--${style}`].filter(Boolean).join(' ');
    badgeEl.textContent = text;
    statusEl.textContent = dayStatusLine(day, { isToday, future, perfect });

    rPerfect.value.textContent = num(perfect);
    rPerfect.sub.textContent = perfect === 1 ? 'day in a row' : 'days in a row';
    rTop.value.textContent = num(top.value);
    rTop.sub.textContent = top.habit ? top.habit.name : 'No active chain';
    rTop.sub.title = top.habit ? top.habit.name : '';
    rRate.value.textContent = pct(rate.rate);
    rRate.sub.textContent = rate.total ? `${rate.done}/${rate.total} planned days` : 'No data yet';
    const lit = Math.round((rate.rate ?? 0) * rateTicks.length);
    rateTicks.forEach((t, i) => t.classList.toggle('is-on', i < lit));

    cycle.hidden = !isToday;
    if (isToday) tick();
  }

  function tick() {
    const now = new Date();
    const hour = now.getHours();
    const left = 24 * 60 - (hour * 60 + now.getMinutes());
    cycleTicks.forEach((t, i) => {
      t.classList.toggle('is-on', i < hour);
      t.classList.toggle('is-now', i === hour);
    });
    cycleLeft.textContent = `${num(Math.floor(left / 60))}h ${num(left % 60)}m left`;
  }

  const clock = setInterval(() => {
    if (!cycle.hidden) tick();
  }, 30000);

  return {
    el,
    update({ items, today, key, series, day }) {
      const weeks = Math.round((L.toDayNum(series[0].key) - L.toDayNum(L.weekStart(today))) / 7);
      rangeEl.textContent = rangeLabel(series[0].key, series[6].key);
      relEl.textContent = weekRelLabel(weeks);
      relEl.classList.toggle('tag--solid', weeks === 0);
      todayBtn.disabled = key === today;
      series.forEach((entry, i) => paintDay(days[i], entry, key, today));
      paintHead(items, today, key, day);
    },
    celebrate() {
      replay(el, 'is-celebrating');
      later(() => el.classList.remove('is-celebrating'), 1600);
    },
    destroy() {
      clearInterval(clock);
    },
  };
}

/* ---- Cards toolbar: count, legend, Week / History toggle ---- */

function createToolbar() {
  const countEl = h('span', { class: 'label tnum hb-sec-count lo-deco' });
  const swatch = (state, text) => h('span', { class: 'hb-legend-item label' }, h('span', { class: 'hb-swatch', dataset: { s: state } }), text);
  const weekLegend = h('div', { class: 'hb-legend', 'aria-hidden': 'true' }, swatch('done', 'Done'), swatch('miss', 'Missed'), swatch('planned', 'Planned'), swatch('rest', 'Off'), swatch('bonus', 'Bonus'));
  const heatLegend = h(
    'div',
    { class: 'hb-legend', 'aria-hidden': 'true' },
    h('span', { class: 'label' }, 'Less'),
    [0, 2, 3, 4].map((l) => h('span', { class: 'hb-swatch', dataset: { s: l ? 'done' : 'miss', l } })),
    h('span', { class: 'label' }, 'More'),
    h('span', { class: 'hb-legend-gap' }),
    swatch('rest', 'Off'),
  );
  const segBtn = (value, iconName, label) =>
    h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { v: value }, onClick: () => setCardView(value) }, icon(iconName, { size: 12 }), label);
  const segBtns = [segBtn('week', 'calendar', 'Week'), segBtn('history', 'activity', 'History')];
  const hint = h('span', { class: 'hb-sec-hint label lo-hint' }, kbd(ALT_KEY), kbd('↑'), kbd('↓'), h('span', null, 'Reorder'));
  const el = h(
    'div',
    { class: 'hb-sec-head' },
    h('h3', { class: 'label hb-sec-title' }, term('habits.section', 'Protocols')),
    countEl,
    h('span', { class: 'hb-rule', 'aria-hidden': 'true' }),
    weekLegend,
    heatLegend,
    hint,
    h('div', { class: 'seg hb-view-seg', role: 'group', 'aria-label': 'Card view' }, segBtns),
  );
  return {
    el,
    update(view, count) {
      el.hidden = !count;
      countEl.textContent = num(count);
      weekLegend.hidden = view !== 'week';
      heatLegend.hidden = view !== 'history';
      segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === view)));
    },
  };
}

/* ---- Habit card (one per habit planned on the selected day) ---- */

function actionBtn(iconName, onClick) {
  return h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hb-act', onClick }, icon(iconName, { size: 14 }));
}

function stat(label, ...values) {
  return h('div', { class: 'hb-stat' }, h('dt', { class: 'label' }, label), values.map((v) => h('dd', { class: 'hb-stat-value' }, v)));
}

function createCard(ctx, id, onMove) {
  const { actions, later } = ctx;
  const nameId = nextId('hb-card');
  let habit = null;
  let last = {};
  let strip = null; // { el, cells } while the week view is shown
  let focusIdx = 0; // roving tab stop inside the strip

  const indexEl = h('span', { class: 'hb-card-index mono lo-deco' });
  const schedEl = h('span', { class: 'hb-card-sched label' });
  const upBtn = actionBtn('arrow-up', () => onMove(id, -1));
  const downBtn = actionBtn('arrow-down', () => onMove(id, 1));
  const editBtn = actionBtn('edit', () => actions.openEditor(id));
  upBtn.title = 'Move up';
  downBtn.title = 'Move down';
  editBtn.title = 'Edit';

  const nameEl = h('h3', { class: 'hb-card-name', id: nameId });
  const stateEl = h('p', { class: 'hb-card-state label' });
  const check = checkButton({ size: 'lg', onToggle: (next) => actions.log(id, last.key, next) });
  check.classList.add('hb-check');
  const checkCap = h('span', { class: 'hb-check-cap label', 'aria-hidden': 'true' });

  const flame = h('span', { class: 'hb-flame' }, icon('flame', { size: 14 }));
  const streakVal = h('span', { class: 'hb-stat-num' });
  const bestVal = h('span', { class: 'hb-stat-num' });
  const rateVal = h('span', { class: 'hb-stat-num' });
  const rateFill = h('div', { class: 'progress-fill' });
  const rateStat = stat('30D', rateVal, h('div', { class: 'progress hb-rate-bar', 'aria-hidden': 'true' }, rateFill));
  const bestStat = stat('Best', bestVal);
  // Simple keeps the streak only
  rateStat.classList.add('lo-deco');
  bestStat.classList.add('lo-deco');
  const track = h('div', { class: 'hb-track' });

  const el = h(
    'li',
    {
      class: 'panel hud hb-card',
      dataset: { id },
      'aria-labelledby': nameId,
      onKeydown: onCardKey,
      onAnimationend: (e) => {
        if (e.target === el && e.animationName === 'lo-rise') el.classList.remove('is-entering');
      },
    },
    h('div', { class: 'hb-card-fx', 'aria-hidden': 'true' }, h('span', { class: 'hb-card-scan' })),
    h(
      'div',
      { class: 'hb-card-meta' },
      indexEl,
      h('span', { class: 'hb-card-dot lo-deco', 'aria-hidden': 'true' }),
      schedEl,
      h('span', { class: 'spacer' }),
      h('div', { class: 'row-actions hb-card-actions' }, upBtn, downBtn, editBtn),
    ),
    h('div', { class: 'hb-card-main' }, h('div', { class: 'hb-card-title' }, nameEl, stateEl), h('div', { class: 'hb-check-wrap' }, check, checkCap)),
    h('dl', { class: 'hb-stats' }, stat('Streak', h('span', { class: 'hb-streak' }, flame, streakVal)), bestStat, rateStat),
    track,
  );

  function onCardKey(e) {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    onMove(id, e.key === 'ArrowUp' ? -1 : 1);
  }

  /* -- week strip: the displayed Mon..Sun, patched in place so keyboard focus survives -- */

  function buildStrip() {
    const cells = Array.from({ length: 7 }, (_, i) => {
      const wd = h('span', { class: 'hb-day-wd', 'aria-hidden': 'true' });
      const btn = h('button', {
        type: 'button',
        class: 'hb-day',
        tabindex: '-1',
        onClick: () => onDayClick(i),
        onFocus: () => {
          focusIdx = i;
          syncRoving();
        },
      });
      return { col: h('div', { class: 'hb-day-col' }, wd, btn), wd, btn, data: null };
    });
    return { el: h('div', { class: 'hb-strip', role: 'group', onKeydown: onStripKey }, cells.map((c) => c.col)), cells };
  }

  function paintDay(cell, d, name) {
    const when = `${formatDay(d.key)}${d.isToday ? ' (today)' : ''}`;
    const copy = cellCopy(d);
    cell.data = d;
    cell.wd.textContent = WEEKDAYS_MIN[d.weekday];
    cell.btn.textContent = String(d.date);
    cell.btn.dataset.state = d.state;
    cell.btn.dataset.planned = String(d.scheduled);
    cell.btn.disabled = d.state === 'pre' || d.state === 'future' || d.state === 'archived';
    cell.btn.setAttribute('aria-pressed', String(L.isLogged(d.state)));
    cell.btn.setAttribute('aria-label', `${name}, ${when}: ${copy}`);
    cell.btn.title = `${when} · ${copy}`;
    cell.btn.classList.toggle('is-today', d.isToday);
    cell.col.classList.toggle('is-today', d.isToday);
    cell.col.classList.toggle('is-selected', d.isSelected);
  }

  function onDayClick(i) {
    const d = strip?.cells[i]?.data;
    if (!d || d.state === 'pre' || d.state === 'future' || d.state === 'archived') return;
    actions.log(id, d.key, !L.isLogged(d.state));
  }

  function syncRoving() {
    if (!strip) return;
    const { cells } = strip;
    if (cells[focusIdx].btn.disabled) {
      const fallback = cells.findLastIndex((c) => !c.btn.disabled);
      focusIdx = fallback < 0 ? 0 : fallback;
    }
    cells.forEach((c, i) => (c.btn.tabIndex = i === focusIdx ? 0 : -1));
  }

  function onStripKey(e) {
    if (!strip || e.altKey || e.metaKey || e.ctrlKey) return;
    const enabled = strip.cells.map((c, i) => (c.btn.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!enabled.length) return;
    const pos = Math.max(0, enabled.indexOf(focusIdx));
    let next;
    if (e.key === 'ArrowLeft') next = enabled[Math.max(0, pos - 1)];
    else if (e.key === 'ArrowRight') next = enabled[Math.min(enabled.length - 1, pos + 1)];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    else return;
    e.preventDefault();
    focusIdx = next;
    syncRoving();
    strip.cells[next].btn.focus();
  }

  function paintTrack(hb, c, keyChanged) {
    if (c.view === 'history') {
      strip = null;
      track.replaceChildren(buildHeatmap(hb, c.today));
      return;
    }
    if (!strip) {
      strip = buildStrip();
      track.replaceChildren(strip.el);
      keyChanged = true;
    }
    if (keyChanged) focusIdx = Math.max(0, c.week.indexOf(c.key));
    strip.el.setAttribute('aria-label', `${hb.name}: week of ${formatDay(c.week[0])}`);
    c.week.forEach((key, i) => {
      const d = { key, weekday: L.weekdayOfKey(key), date: Number(key.slice(8)), isToday: key === c.today, isSelected: key === c.key, state: L.dayStatus(hb, key, c.today), scheduled: L.isScheduledOn(hb, key) };
      paintDay(strip.cells[i], d, hb.name);
    });
    syncRoving();
  }

  /* -- everything except the track -- */

  function paint(hb, c) {
    const status = L.dayStatus(hb, c.key, c.today);
    const streak = L.currentStreak(hb, c.today);
    const best = L.bestStreak(hb, c.today);
    const rate = L.completionRate(hb, c.today);
    const archived = L.isArchived(hb, c.today);
    const locked = status === 'future' || status === 'pre' || status === 'archived';
    const day = c.key === c.today ? 'today' : `on ${formatDay(c.key)}`;

    nameEl.textContent = hb.name;
    nameEl.title = hb.name;
    schedEl.textContent = archived ? `Archived ${formatDay(hb.archivedAt)}` : L.scheduleLabel(L.planOn(hb, c.today));
    upBtn.setAttribute('aria-label', `Move “${hb.name}” up`);
    downBtn.setAttribute('aria-label', `Move “${hb.name}” down`);
    editBtn.setAttribute('aria-label', `Edit “${hb.name}”`);

    setChecked(check, L.isLogged(status));
    check.disabled = locked;
    check.setAttribute('aria-label', status === 'future' ? `${hb.name}: planned for ${formatDay(c.key)}` : `${hb.name}: done ${day}`);
    checkCap.textContent = CHECK_CAPTION[status] ?? '';
    stateEl.textContent = stateLine(hb, status, c);

    el.classList.toggle('is-done', status === 'done');
    el.classList.toggle('is-pending', status === 'pending');
    el.classList.toggle('is-miss', status === 'miss');
    el.classList.toggle('is-future', status === 'future');
    el.classList.toggle('is-archived', archived);

    const prevStreak = streakVal.dataset.v == null ? streak : Number(streakVal.dataset.v);
    streakVal.textContent = num(streak);
    streakVal.dataset.v = String(streak);
    if (streak > prevStreak) {
      replay(streakVal, 'is-bump');
      later(() => streakVal.classList.remove('is-bump'), 700);
    }
    flame.classList.toggle('is-lit', streak > 0);
    bestVal.textContent = num(best);
    rateVal.textContent = pct(rate.rate);
    rateFill.style.width = `${Math.round((rate.rate ?? 0) * 100)}%`;
    rateStat.title = rate.total ? `${rate.done} of ${rate.total} planned days in the last ${L.RATE_WINDOW}` : 'No planned days measured yet';
  }

  function update(next, c) {
    const sig = `${c.today}|${c.key}|${c.view}`;
    const changed = next !== habit || sig !== last.sig;
    if (c.index !== last.index || c.count !== last.count) {
      indexEl.textContent = idx(c.index + 1);
      upBtn.setAttribute('aria-disabled', String(c.index === 0));
      downBtn.setAttribute('aria-disabled', String(c.index === c.count - 1));
    }
    if (changed) {
      paint(next, c);
      paintTrack(next, c, c.key !== last.key);
    }
    habit = next;
    last = { sig, key: c.key, index: c.index, count: c.count };
  }

  /** One-shot feedback after logging `key`. */
  function pop(key) {
    if (key === last.key) {
      replay(el, 'is-popping');
      later(() => el.classList.remove('is-popping'), 900);
    }
    const cell = strip?.cells.find((c) => c.data?.key === key);
    if (cell) {
      replay(cell.btn, 'is-popping');
      later(() => cell.btn.classList.remove('is-popping'), 600);
    }
  }

  function enter(delayIndex) {
    // Cap the stagger so long lists don't outlast the 1.5s safety cleanup below.
    el.style.setProperty('--hb-i', String(Math.min(delayIndex, 12)));
    el.classList.add('is-entering');
    later(() => el.classList.remove('is-entering'), 1500);
  }

  return {
    el,
    update,
    pop,
    enter,
    focusCheck: () => check.focus(),
    // The check is disabled on future days; the edit button always takes focus.
    focusMain: () => (check.disabled ? editBtn : check).focus(),
  };
}

/* ---- History heatmap (display only; rebuilt when the habit changes) ---- */

function buildHeatmap(hb, today) {
  const data = L.heatmap(hb, today, L.HEAT_WEEKS, { weekStart: 1 });
  const grid = h('div', {
    class: 'hb-heat',
    role: 'img',
    'aria-label': `${hb.name}: ${data.done} of ${data.total} planned days completed in the last ${L.HEAT_WEEKS} weeks`,
  });
  grid.append(h('span', { class: 'hb-heat-month' }));
  L.WEEK_ORDER.forEach((wd, row) => grid.append(h('span', { class: 'hb-heat-wd' }, row % 2 ? '' : WEEKDAYS_MIN[wd])));
  for (const col of data.columns) {
    grid.append(h('span', { class: 'hb-heat-month' }, col.month ?? ''));
    for (const c of col.cells) {
      grid.append(
        h('span', {
          class: ['hb-heat-cell', c.isToday && 'is-today'],
          dataset: { s: c.state, l: c.level ?? '' },
          title: c.state === 'future' ? null : `${formatDay(c.key)} · ${STATE_COPY[c.state]}`,
        }),
      );
    }
  }
  return h(
    'div',
    { class: 'hb-heat-wrap' },
    grid,
    h(
      'div',
      { class: 'hb-heat-foot' },
      h('span', { class: 'label' }, `Last ${L.HEAT_WEEKS} weeks`),
      h('span', { class: 'label tnum' }, `${num(data.done)}/${num(data.total)} · ${pct(data.total ? data.done / data.total : null)}`),
    ),
  );
}

/* ---- "Not planned for <day>": quick add to that weekday, optional bonus log ---- */

function createNotPlanned(ctx) {
  const { ui } = ctx;
  const rows = new Map();
  const listId = nextId('hb-np');
  const titleEl = h('span', { class: 'label hb-fold-title' });
  const countEl = h('span', { class: 'label tnum' });
  const list = h('ul', { id: listId, class: 'hb-np-list' });
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'hb-fold',
      'aria-expanded': 'false',
      'aria-controls': listId,
      onClick: () => {
        ui.notPlannedOpen = !isOpen();
        paintOpen();
      },
    },
    h('span', { class: 'hb-fold-icon', 'aria-hidden': 'true' }, icon('chevron-right', { size: 14 })),
    titleEl,
    countEl,
  );
  const el = h('section', { class: 'hb-np', 'aria-labelledby': `${listId}-t` }, toggle, list);
  titleEl.id = `${listId}-t`;
  let autoOpen = false;

  const isOpen = () => ui.notPlannedOpen ?? autoOpen;

  function paintOpen() {
    toggle.setAttribute('aria-expanded', String(isOpen()));
    list.hidden = !isOpen();
  }

  function update(items, key, today, plannedIds) {
    const wd = L.weekdayOfKey(key);
    autoOpen = plannedIds.size === 0;
    const others = items.filter((it) => !L.isArchived(it, today) && !plannedIds.has(it.id));
    el.hidden = !others.length;
    titleEl.textContent = `Not planned for ${WEEKDAYS_LONG[wd]}`;
    countEl.textContent = `(${others.length})`;
    list.classList.toggle('is-future', key > today);
    const keep = new Set(others.map((it) => it.id));
    for (const [id, row] of rows) {
      if (keep.has(id)) continue;
      row.li.remove();
      rows.delete(id);
    }
    others.forEach((it, i) => {
      let row = rows.get(it.id);
      if (!row) {
        row = createNpRow(ctx, it.id);
        rows.set(it.id, row);
      }
      row.update(it, key, today, wd);
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
    });
    paintOpen();
  }

  return { el, update, focus: () => (el.hidden ? null : toggle.focus()) };
}

function createNpRow(ctx, id) {
  const { actions } = ctx;
  let cur = { key: null, wd: null };
  const name = h('span', { class: 'hb-np-name' });
  const meta = h('span', { class: 'label hb-np-meta' });
  const note = h('span', { class: 'tag tag--dashed hb-np-note' });
  const addDay = h('span', { class: 'hb-np-addday' });
  const addBtn = h('button', { type: 'button', class: 'btn btn--sm hb-np-add', onClick: () => actions.addDay(id, cur.wd) }, icon('plus', { size: 14 }), h('span', null, 'Add'), addDay);
  const check = checkButton({ onToggle: (next) => actions.log(id, cur.key, next) });
  check.classList.add('hb-np-check');
  const li = h('li', { class: 'hb-np-row', dataset: { id } }, check, h('div', { class: 'hb-np-ident' }, name, meta), note, addBtn);

  return {
    li,
    update(it, key, today, wd) {
      cur = { key, wd };
      const plan = L.planOn(it, today);
      const status = L.dayStatus(it, key, today); // 'rest' | 'bonus' | 'pre' | 'future'
      const canLog = status === 'rest' || status === 'bonus';
      const plannedNow = plan.includes(wd);
      const when = key === today ? 'today' : `on ${formatDay(key)}`;

      name.textContent = it.name;
      name.title = it.name;
      meta.textContent = it.createdAt > today ? `Starts ${formatDay(it.createdAt)} · ${L.scheduleLabel(plan)}` : L.scheduleLabel(plan);
      setChecked(check, status === 'bonus');
      check.disabled = !canLog;
      check.classList.toggle('is-void', !canLog);
      check.setAttribute('aria-label', `${it.name}: log a bonus session ${when}`);
      check.title = canLog ? 'Bonus — logged, but neutral for streaks' : '';
      addBtn.hidden = plannedNow;
      addDay.textContent = ` to ${WEEKDAYS_LONG[wd]}`;
      addBtn.setAttribute('aria-label', `Plan “${it.name}” on ${WEEKDAYS_LONG[wd]}s from today`);
      // Planned on this weekday now, but not on this date (it was in the past, or the habit hadn't started).
      note.hidden = !plannedNow;
      note.textContent = it.createdAt > key ? `Starts ${formatDay(it.createdAt)}` : 'Planned from today';
      li.classList.toggle('is-bonus', status === 'bonus');
    },
  };
}

/* ---- First run (no active habits) ---- */

function buildFirstRun(ctx, archivedCount) {
  const { actions } = ctx;
  const create = h('button', { type: 'button', class: 'btn btn--primary', onClick: () => actions.openEditor() }, icon('plus'), 'Create your first habit');
  const restore = archivedCount
    ? h('button', { type: 'button', class: 'btn', onClick: () => actions.openTab('plan') }, icon('archive'), `Restore from archive (${archivedCount})`)
    : null;
  const suggestions = h(
    'div',
    { class: 'hb-suggest' },
    h('span', { class: 'label' }, term('habits.starter', 'Or deploy a starter protocol')),
    h(
      'div',
      { class: 'hb-suggest-list' },
      SUGGESTIONS.map((s) =>
        h(
          'button',
          { type: 'button', class: 'btn btn--sm hb-suggest-btn', 'aria-label': `Add “${s.name}” (${s.hint})`, onClick: () => actions.create({ name: s.name, days: s.days }) },
          icon('plus', { size: 14 }),
          h('span', null, s.name),
          h('span', { class: 'hb-suggest-hint', 'aria-hidden': 'true' }, s.hint),
        ),
      ),
    ),
    h('p', { class: 'hb-empty-kbd label lo-hint' }, 'Press ', kbd('N'), ' anytime to add a habit'),
  );
  const steps = [
    [idx(1), 'Plan', 'Give every weekday its own lineup — Monday can differ from Tuesday.'],
    [idx(2), term('habits.step2', 'Execute'), 'Check habits off each day. Fix past days from the week strip.'],
    [idx(3), term('habits.step3', 'Compound'), term('habits.step3.text', 'Streaks, insights and your LIFE index move with every check-in.')],
  ];
  return [
    emptyState({
      icon: 'target',
      title: archivedCount ? term('habits.empty.archived', 'All protocols archived') : term('habits.empty.title', 'No protocols online'),
      text: archivedCount
        ? 'Every habit is archived — their history still feeds your graphs. Restore one or start something new.'
        : term('habits.empty.text', 'Habits are small actions you plan on chosen weekdays. Check them off daily and LIFE/OS tracks streaks, completion and your LIFE index.'),
      action: h('div', { class: 'hb-empty-actions' }, h('div', { class: 'hb-empty-buttons' }, create, restore), suggestions),
    }),
    h(
      'ol',
      { class: 'hb-howto' },
      steps.map(([num, title, text]) =>
        h('li', { class: 'panel hud hb-howto-step' }, h('span', { class: 'label' }, num), h('span', { class: 'hb-howto-title' }, title), h('p', { class: 'hb-howto-text' }, text)),
      ),
    ),
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
