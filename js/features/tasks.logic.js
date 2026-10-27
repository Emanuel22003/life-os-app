// LIFE/OS — Tasks: pure state logic (DOM-free, unit-tested with jsc).
// Everything here takes plain data and returns new data; nothing is mutated.

import { dateKey, parseKey, shiftKey, weekday, clamp, uid } from '../ui.js';
import { colorKey, withColor } from '../colors.logic.js';
import { cleanIcon, iconOf } from '../icons.logic.js';
import { cleanItemReminders } from '../reminders.logic.js';

/* ==========================================================================
   Vocabulary
   ========================================================================== */

export const PRIORITIES = ['none', 'low', 'med', 'high'];
export const PRIORITY_RANK = { none: 0, low: 1, med: 2, high: 3 };
export const PRIORITY_LABEL = { none: 'None', low: 'Low', med: 'Med', high: 'High' };

export const FILTERS = ['all', 'today', 'upcoming', 'done'];
export const FILTER_LABEL = { all: 'All', today: 'Today', upcoming: 'Upcoming', done: 'Done' };

// 'smart' groups the open tasks by when they are due: Overdue · Today · Upcoming · No date
export const SORTS = ['smart', 'manual', 'due', 'priority'];
export const SORT_LABEL = { smart: 'Smart', manual: 'Manual', due: 'Due', priority: 'Priority' };

// view.section: 'all' or the id of the section being shown (per device: it never syncs).
// view.sortPicked: the sort was chosen in the menu. A view that never chose one gets Smart, also
// one saved before Smart existed (it says 'manual' only because that was the default then).
export const DEFAULT_VIEW = Object.freeze({ filter: 'all', sort: 'smart', sortPicked: false, completedOpen: false, section: 'all' });
export const DEFAULT_STATE = Object.freeze({ items: [], sections: Object.freeze([]), view: DEFAULT_VIEW });

/**
 * Sections split the list (Work, Life …): [{ id, name, icon? }] in display order; a task's
 * sectionId points at one or is null. `icon` is one the user picked (js/icons.logic.js); without
 * one a section shows the icon its name suggests ('Work' -> a briefcase), else a folder.
 */
export const SECTION_NAME_MAX = 40;
// A stored icon is kept when it looks like an icon name, even one this version doesn't draw: a
// newer device may have offered it, and stripping it here would sync the strip back there.
const ICON_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A task with a due date can also get a time of day ('HH:MM') and a length in minutes: the
 * calendar then places it on its timeline (drag it up and down). Without a time it is a task
 * for the whole day, as before.
 */
export const DEFAULT_TASK_MINUTES = 30;
export const TASK_MINUTES_MAX = 12 * 60;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTimeOfDay = (v) => typeof v === 'string' && TIME_OF_DAY.test(v);
const taskMinutes = (v) => (Number.isFinite(v) && v >= 5 && v <= TASK_MINUTES_MAX ? Math.round(v) : DEFAULT_TASK_MINUTES);

// Older / hand-edited data may spell priorities differently. Maps, not object
// literals, so words like "constructor" never resolve to Object.prototype members.
const PRIORITY_ALIASES = new Map([
  ['medium', 'med'],
  ['m', 'med'],
  ['normal', 'med'],
  ['h', 'high'],
  ['l', 'low'],
  ['', 'none'],
]);

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day in 'YYYY-MM-DD' form. */
export function isDateKey(v) {
  return typeof v === 'string' && KEY_RE.test(v) && dateKey(parseKey(v)) === v;
}

/** Titles are single-line: collapse whitespace runs and trim. */
export function cleanTitle(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/* ==========================================================================
   Normalization — tolerate missing / malformed fields from older versions
   ========================================================================== */

/**
 * A valid task, or null. Fields this version doesn't know are kept as they are, so a window
 * running an older LIFE/OS (or one device in sync with a newer one) never strips them.
 */
export function normalizeTask(raw, i = 0, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanTitle(raw.title ?? raw.text ?? raw.name);
  if (!title) return null;

  const done = !!(raw.done ?? raw.completed);
  const rawPriority = typeof raw.priority === 'string' ? raw.priority.toLowerCase() : '';
  const priority = PRIORITIES.includes(rawPriority) ? rawPriority : PRIORITY_ALIASES.get(rawPriority) ?? 'none';
  let id = typeof raw.id === 'number' ? String(raw.id) : raw.id;
  if (typeof id !== 'string' || !id) id = uid();
  // Legacy spellings of title / done are read above, not kept
  const { text: _text, name: _name, completed: _completed, ...extra } = raw;

  const due = isDateKey(raw.due) ? raw.due : null;
  const time = due && isTimeOfDay(raw.time) ? raw.time : null;
  // Reminders (js/reminders.logic.js): absent / null = the defaults for tasks, [] = none, or
  // [{ id, before, sound }]; a list is cleaned, anything else (a newer shape) stays as it is
  if (Array.isArray(extra.reminders)) extra.reminders = cleanItemReminders(extra.reminders);
  return {
    ...extra,
    id,
    title,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    done,
    priority,
    due,
    time,
    minutes: time ? taskMinutes(raw.minutes) : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    completedAt: done && Number.isFinite(raw.completedAt) ? raw.completedAt : null,
    order: Number.isFinite(raw.order) ? raw.order : i,
    sectionId: typeof raw.sectionId === 'string' && raw.sectionId ? raw.sectionId : null,
  };
}

/** A valid section ({ id, name } + any fields a newer version added), or null. */
export function normalizeSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanTitle(raw.name).slice(0, SECTION_NAME_MAX).trim();
  const id = typeof raw.id === 'number' ? String(raw.id) : raw.id;
  if (typeof id !== 'string' || !id || !name) return null;
  const out = { ...raw, id, name };
  // No icon (or a broken one) means: follow the name
  if ('icon' in out && !(typeof out.icon === 'string' && ICON_SHAPE.test(out.icon))) delete out.icon;
  return out;
}

export function normalizeView(raw, sectionIds = new Set()) {
  const v = raw && typeof raw === 'object' ? raw : {};
  // A sort counts as chosen when the menu said so, or when it is one no default ever was
  const picked = SORTS.includes(v.sort) && (v.sortPicked === true || (v.sort !== 'manual' && v.sort !== DEFAULT_VIEW.sort));
  return {
    filter: FILTERS.includes(v.filter) ? v.filter : DEFAULT_VIEW.filter,
    sort: picked ? v.sort : DEFAULT_VIEW.sort,
    sortPicked: picked,
    completedOpen: typeof v.completedOpen === 'boolean' ? v.completedOpen : DEFAULT_VIEW.completedOpen,
    // A section deleted (here, or on another computer) falls back to All
    section: typeof v.section === 'string' && sectionIds.has(v.section) ? v.section : 'all',
  };
}

/**
 * Returns a fresh, fully valid state. Items come back sorted by order with order === index.
 * Also accepts a bare array of tasks or a { tasks: [] } object (early / hand-made data).
 */
export function normalizeState(raw, now = Date.now()) {
  const src = Array.isArray(raw) ? { items: raw } : raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.items) ? src.items : Array.isArray(src.tasks) ? src.tasks : [];
  const sections = [];
  const sectionIds = new Set();
  for (const r of Array.isArray(src.sections) ? src.sections : []) {
    const sec = normalizeSection(r);
    if (!sec || sectionIds.has(sec.id)) continue;
    sectionIds.add(sec.id);
    sections.push(sec);
  }
  const seen = new Set();
  const items = [];
  list.forEach((r, i) => {
    const t = normalizeTask(r, i, now);
    if (!t) return;
    while (seen.has(t.id)) t.id = uid();
    seen.add(t.id);
    // Its section was deleted: the task stays, without a section
    if (t.sectionId && !sectionIds.has(t.sectionId)) t.sectionId = null;
    items.push(t);
  });
  return { items: reindex(byManual(items)), sections, view: normalizeView(src.view, sectionIds) };
}

/** order := index, reusing objects whose order is already right. */
export function reindex(items) {
  return items.map((t, i) => (t.order === i ? t : { ...t, order: i }));
}

/* ==========================================================================
   Predicates, filters, counts
   ========================================================================== */

// 'YYYY-MM-DD' keys compare correctly as strings
export function isOverdue(t, today) {
  return !t.done && !!t.due && t.due < today;
}

export function isDueToday(t, today) {
  return !t.done && t.due === today;
}

/** The tasks a section shows: all of them for 'all'. */
export function inSection(items, section) {
  return section === 'all' ? items : items.filter((t) => t.sectionId === section);
}

/** Open tasks per section id (and 'all'), for the section tabs. */
export function sectionCounts(items) {
  const c = new Map([['all', 0]]);
  for (const t of items) {
    if (t.done) continue;
    c.set('all', c.get('all') + 1);
    if (t.sectionId) c.set(t.sectionId, (c.get(t.sectionId) ?? 0) + 1);
  }
  return c;
}

/** sections + a new one named `name` -> { sections, section } | { error: 'empty' | 'taken' } */
export function addSection(sections, name, id = uid()) {
  const clean = cleanTitle(name).slice(0, SECTION_NAME_MAX).trim();
  if (!clean) return { error: 'empty' };
  if (sections.some((s) => s.name.toLowerCase() === clean.toLowerCase())) return { error: 'taken' };
  const section = { id, name: clean };
  return { sections: [...sections, section], section };
}

/** Rename section `id` -> { sections } (same array when nothing changes) | { error: 'empty' | 'taken' } */
export function renameSection(sections, id, name) {
  const clean = cleanTitle(name).slice(0, SECTION_NAME_MAX).trim();
  if (!clean) return { error: 'empty' };
  const current = sections.find((s) => s.id === id);
  if (!current || current.name === clean) return { sections };
  if (sections.some((s) => s.id !== id && s.name.toLowerCase() === clean.toLowerCase())) return { error: 'taken' };
  return { sections: sections.map((s) => (s.id === id ? { ...s, name: clean } : s)) };
}

/** Delete section `id`: its tasks stay, without a section. -> the new { items, sections } */
export function removeSection(items, sections, id) {
  return {
    sections: sections.filter((s) => s.id !== id),
    items: items.map((t) => (t.sectionId === id ? { ...t, sectionId: null } : t)),
  };
}

export function matchesFilter(t, filter, today) {
  switch (filter) {
    case 'today':
      return !t.done && !!t.due && t.due <= today;
    case 'upcoming':
      return !t.done && !!t.due && t.due > today;
    case 'done':
      return t.done;
    default:
      return true;
  }
}

/** Counts shown on the filter tabs. "All" counts open tasks (completed ones live in their own section). */
export function filterCounts(items, today) {
  const c = { all: 0, today: 0, upcoming: 0, done: 0 };
  for (const t of items) {
    if (t.done) {
      c.done++;
      continue;
    }
    c.all++;
    if (t.due && t.due <= today) c.today++;
    else if (t.due) c.upcoming++;
  }
  return c;
}

export function openCount(items) {
  let n = 0;
  for (const t of items) if (!t.done) n++;
  return n;
}

/**
 * What needs doing today: open tasks due today or overdue. The page's badge, and the same tasks
 * Home's To do card lists ("to do today").
 */
export function attentionCount(items, today) {
  let n = 0;
  for (const t of items) if (!t.done && t.due && t.due <= today) n++;
  return n;
}

/** The Monday after today ("Next week" in the right-click menu, as to-do apps mean it). */
export function nextWeek(today) {
  return shiftKey(today, (8 - weekday(today)) % 7 || 7);
}

/* ==========================================================================
   Sorting
   ========================================================================== */

const cmpOrder = (a, b) => a.order - b.order;
// Undated tasks sink below dated ones
const cmpDue = (a, b) => (a.due === b.due ? 0 : !a.due ? 1 : !b.due ? -1 : a.due < b.due ? -1 : 1);
const cmpPriority = (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
const cmpCompleted = (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0);
// A time of day comes first, earliest first; a task for the whole day after them
const cmpTime = (a, b) => (a.time === b.time ? 0 : !a.time ? 1 : !b.time ? -1 : a.time < b.time ? -1 : 1);

/**
 * Smart order: the groups Overdue · Today · Upcoming · No date (as Home's To do lists them:
 * the late ones first, oldest first), then inside each group what matters most first.
 */
export const SMART_GROUPS = Object.freeze(['overdue', 'today', 'upcoming', 'nodate']);
export const SMART_GROUP_LABEL = Object.freeze({ overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', nodate: 'No date' });

/** The Smart group a task sits in: 'overdue' | 'today' | 'upcoming' | 'nodate'. */
export function smartGroup(t, today) {
  if (!t?.due) return 'nodate';
  if (t.due < today) return 'overdue';
  return t.due === today ? 'today' : 'upcoming';
}

const SMART_WITHIN = {
  overdue: (a, b) => cmpDue(a, b) || cmpPriority(a, b) || cmpTime(a, b) || cmpOrder(a, b),
  today: (a, b) => cmpPriority(a, b) || cmpTime(a, b) || cmpOrder(a, b),
  upcoming: (a, b) => cmpDue(a, b) || cmpTime(a, b) || cmpPriority(a, b) || cmpOrder(a, b),
  nodate: (a, b) => cmpPriority(a, b) || cmpOrder(a, b),
};

function cmpSmart(today) {
  return (a, b) => {
    const ga = smartGroup(a, today);
    const gb = smartGroup(b, today);
    return ga === gb ? SMART_WITHIN[ga](a, b) : SMART_GROUPS.indexOf(ga) - SMART_GROUPS.indexOf(gb);
  };
}

const COMPARATORS = {
  manual: cmpOrder,
  due: (a, b) => cmpDue(a, b) || cmpPriority(a, b) || cmpOrder(a, b),
  priority: (a, b) => cmpPriority(a, b) || cmpDue(a, b) || cmpOrder(a, b),
  completed: (a, b) => cmpCompleted(a, b) || cmpOrder(a, b),
};

const comparator = (sort, today = dateKey()) => (sort === 'smart' ? cmpSmart(today) : Object.prototype.hasOwnProperty.call(COMPARATORS, sort) ? COMPARATORS[sort] : cmpOrder);

/**
 * sort: 'smart' (by group, as of `today`) | 'manual' | 'due' | 'priority' | 'completed' (most
 * recently completed first). Returns a new array.
 */
export function sortTasks(tasks, sort = 'manual', today = dateKey()) {
  return [...tasks].sort(comparator(sort, today));
}

const byManual = (items) => sortTasks(items, 'manual');

/**
 * What the list shows for a view: { main, completed, groups }.
 * - main: the primary list (open tasks for all/today/upcoming, done tasks for 'done')
 * - completed: the collapsible "Completed" section (only in 'all')
 * - groups: in Smart order, main split under its headings: [{ key, tasks }] (the empty ones left
 *   out); null in every other order and in Done
 *
 * `linger` maps id -> { done, completedAt } as they were before a toggle, so a
 * just-checked row holds its place for a beat while its animation plays.
 */
export function viewSections(items, view, today, linger) {
  const pairs = items.map((t) => {
    const snap = linger?.get(t.id);
    return { t, ref: snap ? { ...t, done: snap.done, completedAt: snap.completedAt } : t };
  });
  const pick = (pred, sort) => {
    const cmp = comparator(sort, today);
    return pairs.filter(({ ref }) => pred(ref)).sort((a, b) => cmp(a.ref, b.ref));
  };
  const tasksOf = (list) => list.map(({ t }) => t);

  if (view.filter === 'done') return { main: tasksOf(pick((r) => r.done, 'completed')), completed: [], groups: null };
  const main = pick((r) => !r.done && matchesFilter(r, view.filter, today), view.sort);
  let groups = null;
  if (view.sort === 'smart') {
    groups = SMART_GROUPS.map((key) => ({ key, tasks: tasksOf(main.filter(({ ref }) => smartGroup(ref, today) === key)) })).filter((g) => g.tasks.length);
  }
  return {
    main: tasksOf(main),
    completed: view.filter === 'all' ? tasksOf(pick((r) => r.done, 'completed')) : [],
    groups,
  };
}

/* ==========================================================================
   Stats
   ========================================================================== */

/**
 * Today's plate = open tasks due today or overdue + tasks completed today.
 * todayProgress = completed today / today's plate.
 */
export function computeStats(items, today) {
  let open = 0;
  let done = 0;
  let doneToday = 0;
  let overdue = 0;
  let dueToday = 0;
  for (const t of items) {
    if (t.done) {
      done++;
      if (t.completedAt != null && dateKey(new Date(t.completedAt)) === today) doneToday++;
    } else {
      open++;
      if (t.due && t.due < today) overdue++;
      else if (t.due === today) dueToday++;
    }
  }
  const todayTotal = doneToday + dueToday + overdue;
  const total = items.length;
  return {
    open,
    done,
    total,
    doneToday,
    dueToday,
    overdue,
    todayTotal,
    todayProgress: todayTotal ? doneToday / todayTotal : 0,
    overallProgress: total ? done / total : 0,
  };
}

/* ==========================================================================
   Mutations (pure: items in, items out)
   ========================================================================== */

export function createTask({ title, priority = 'none', due = null, notes = '', sectionId = null, time = null, minutes = null, color = null, reminders = null } = {}, now = Date.now()) {
  const day = isDateKey(due) ? due : null;
  const at = day && isTimeOfDay(time) ? time : null;
  const task = {
    id: uid(),
    title: cleanTitle(title),
    notes: typeof notes === 'string' ? notes : '',
    done: false,
    priority: PRIORITIES.includes(priority) ? priority : 'none',
    due: day,
    time: at,
    minutes: at ? taskMinutes(minutes) : null,
    createdAt: now,
    completedAt: null,
    order: 0,
    sectionId: typeof sectionId === 'string' && sectionId ? sectionId : null,
  };
  // A copy keeps the reminders of the task it was made from
  if (Array.isArray(reminders)) task.reminders = cleanItemReminders(reminders);
  return colorKey(color) ? { ...task, color: colorKey(color) } : task;
}

/** New tasks land at the top of the manual order, right under the command bar. */
export function addTask(items, task) {
  return reindex([task, ...byManual(items)]);
}

/** A pasted / duplicated task lands right after `afterId` in the manual order (first without one). */
export function insertTaskAfter(items, task, afterId) {
  const ordered = byManual(items);
  const at = afterId == null ? -1 : ordered.findIndex((t) => t.id === afterId);
  return reindex([...ordered.slice(0, at + 1), task, ...ordered.slice(at + 1)]);
}

export function toggleTask(items, id, done, now = Date.now()) {
  return items.map((t) => (t.id === id && t.done !== done ? { ...t, done, completedAt: done ? now : null } : t));
}

/**
 * Patch title / notes / priority / due / time / minutes / sectionId / reminders. Invalid values
 * are ignored; an empty title keeps the old one. A task without a due date has no time either; a
 * new time without a length gets the default length.
 */
export function updateTask(items, id, patch = {}) {
  return items.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t };
    if ('title' in patch) {
      const title = cleanTitle(patch.title);
      if (title) next.title = title;
    }
    if ('notes' in patch) next.notes = typeof patch.notes === 'string' ? patch.notes : '';
    if ('priority' in patch && PRIORITIES.includes(patch.priority)) next.priority = patch.priority;
    if ('due' in patch) next.due = isDateKey(patch.due) ? patch.due : null;
    if ('time' in patch) next.time = isTimeOfDay(patch.time) ? patch.time : null;
    if ('minutes' in patch && next.time) next.minutes = taskMinutes(patch.minutes);
    if (!next.due) next.time = null;
    next.minutes = next.time ? taskMinutes(next.minutes) : null;
    if ('sectionId' in patch) next.sectionId = typeof patch.sectionId === 'string' && patch.sectionId ? patch.sectionId : null;
    // Reminders: a list (cleaned), [] for none, or null: back to the defaults (no field)
    if ('reminders' in patch) {
      if (Array.isArray(patch.reminders)) next.reminders = cleanItemReminders(patch.reminders);
      else if (patch.reminders === null) delete next.reminders;
    }
    // Color coding: a palette id, or null to clear it (the field is then left out)
    if ('color' in patch) return withColor(next, patch.color);
    return next;
  });
}

/**
 * Move task `id` so it sits at `toIndex` of `visibleIds` (the list as currently shown).
 * Tasks hidden by the filter keep their relative order: moving down lands right after the
 * new visible predecessor, moving up right before the new visible successor.
 * Returns the same array when nothing moves.
 */
export function moveTo(items, id, visibleIds, toIndex) {
  const from = visibleIds.indexOf(id);
  if (from === -1 || visibleIds.length < 2) return items;
  const target = clamp(Math.round(toIndex), 0, visibleIds.length - 1);
  if (target === from) return items;

  const ordered = byManual(items);
  const moving = ordered.find((t) => t.id === id);
  if (!moving) return items;
  const rest = ordered.filter((t) => t.id !== id);
  const restVisible = visibleIds.filter((v) => v !== id);

  let at;
  if (target > from) {
    const prev = rest.findIndex((t) => t.id === restVisible[target - 1]);
    at = prev === -1 ? -1 : prev + 1;
  } else {
    at = rest.findIndex((t) => t.id === restVisible[target]);
  }
  if (at === -1) at = rest.length;
  rest.splice(at, 0, moving);
  return reindex(rest);
}

/**
 * Remove tasks, keeping enough context to put each one back exactly where it was.
 * -> { items, snapshots: [{ task, prevId, nextId, index }] }
 */
export function removeTasks(items, ids) {
  const drop = new Set(ids);
  const ordered = byManual(items);
  const snapshots = [];
  ordered.forEach((t, i) => {
    if (!drop.has(t.id)) return;
    snapshots.push({ task: t, prevId: i > 0 ? ordered[i - 1].id : null, nextId: ordered[i + 1]?.id ?? null, index: i });
  });
  return { items: reindex(ordered.filter((t) => !drop.has(t.id))), snapshots };
}

/** Undo for removeTasks: re-insert each task after its old predecessor (or before its old successor). */
export function restoreTasks(items, snapshots) {
  let list = byManual(items);
  const sorted = [...snapshots].sort((a, b) => a.index - b.index);
  for (const s of sorted) {
    if (list.some((t) => t.id === s.task.id)) continue;
    let at;
    if (s.prevId === null) {
      at = 0;
    } else {
      const p = list.findIndex((t) => t.id === s.prevId);
      if (p !== -1) at = p + 1;
      else {
        const n = s.nextId ? list.findIndex((t) => t.id === s.nextId) : -1;
        at = n !== -1 ? n : Math.min(s.index, list.length);
      }
    }
    list = [...list.slice(0, at), s.task, ...list.slice(at)];
  }
  return reindex(list);
}

/* ==========================================================================
   Quick-add parsing
   Tokens are whole words only, so ordinary titles are never touched:
     priority  !h !high  !m !med !medium  !l !low
     due       @today @tonight @tomorrow @tmr @tmrw @mon…@sun @monday… @+3 @3d @2026-10-12
               (no short forms that read as names, e.g. @tom / @tod stay literal mentions)
     trailing  a bare last word "today" / "tonight" / "tomorrow" (only if a title remains)
   One token of each kind applies (the last one typed); repeats stay in the title as text.
   ========================================================================== */

const PRIORITY_WORDS = new Map([
  ['!h', 'high'],
  ['!hi', 'high'],
  ['!high', 'high'],
  ['!m', 'med'],
  ['!med', 'med'],
  ['!medium', 'med'],
  ['!l', 'low'],
  ['!lo', 'low'],
  ['!low', 'low'],
]);

const WEEKDAY_WORDS = [
  ['sun', 'sunday'],
  ['mon', 'monday'],
  ['tue', 'tues', 'tuesday'],
  ['wed', 'weds', 'wednesday'],
  ['thu', 'thur', 'thurs', 'thursday'],
  ['fri', 'friday'],
  ['sat', 'saturday'],
];

const TRAILING_WORDS = new Set(['today', 'tonight', 'tomorrow']);

/** Resolve a due word (without the @) to a date key, or null. Weekdays mean the next one after today. */
export function resolveDueWord(word, today) {
  const w = String(word).toLowerCase();
  if (w === 'today' || w === 'tonight') return today;
  if (w === 'tomorrow' || w === 'tmr' || w === 'tmrw') return shiftKey(today, 1);
  const dow = WEEKDAY_WORDS.findIndex((names) => names.includes(w));
  if (dow !== -1) return shiftKey(today, (dow - weekday(today) + 7) % 7 || 7);
  const rel = /^\+?(\d{1,3})d$|^\+(\d{1,3})$/.exec(w);
  if (rel) return shiftKey(today, Number(rel[1] ?? rel[2]));
  if (isDateKey(w)) return w;
  return null;
}

/**
 * parseQuickAdd('Call mom !h @fri', today) ->
 *   { title: 'Call mom', priority: 'high', due: '2026-10-09', tokens: { priority: {raw, value}, due: {raw, value} } }
 * `ignore` (Set of 'priority' | 'due') keeps those tokens as literal title text.
 * Two tokens of one kind ('a !l b !h'): the last one applies and the earlier ones stay in
 * the title as plain text. They are listed in that token's `kept` array (present only
 * when non-empty) so the quick-add preview can say so instead of dropping them silently.
 */
export function parseQuickAdd(text, today, ignore = new Set()) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const found = { priority: [], due: [] }; // [{ i, raw, value }] in typing order

  words.forEach((w, i) => {
    const lw = w.toLowerCase();
    if (!ignore.has('priority') && PRIORITY_WORDS.has(lw)) {
      found.priority.push({ i, raw: w, value: PRIORITY_WORDS.get(lw) });
    } else if (!ignore.has('due') && lw.length > 1 && lw[0] === '@') {
      const due = resolveDueWord(lw.slice(1), today);
      if (due) found.due.push({ i, raw: w, value: due });
    }
  });

  const tokens = { priority: null, due: null };
  const applied = new Set();
  for (const kind of ['priority', 'due']) {
    const list = found[kind];
    if (!list.length) continue;
    const last = list[list.length - 1];
    applied.add(last.i);
    tokens[kind] = { raw: last.raw, value: last.value };
    if (list.length > 1) tokens[kind].kept = list.slice(0, -1).map((t) => t.raw);
  }
  const kept = words.filter((_, i) => !applied.has(i));

  if (!ignore.has('due') && !tokens.due && kept.length > 1 && TRAILING_WORDS.has(kept[kept.length - 1].toLowerCase())) {
    const raw = kept.pop();
    tokens.due = { raw, value: resolveDueWord(raw, today) };
  }

  return {
    title: kept.join(' '),
    priority: tokens.priority?.value ?? null,
    due: tokens.due?.value ?? null,
    tokens,
  };
}

/* ==========================================================================
   Stepped quick-add: the title first, then one small question at a time
   (Priority → When → Section), so the add box is a single line at rest.
   A token typed in the title answers its own step, which is then skipped.
   ========================================================================== */

export const ADD_STEPS = Object.freeze(['priority', 'due', 'section']);

const stepRank = (s) => ADD_STEPS.indexOf(s);
const hasKey = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/**
 * The steps asked after the title, in order: Priority and When unless a token in the title
 * already set them (parseQuickAdd's result), Section only when there are sections to pick from.
 */
export function addSteps(parsed, sectionCount = 0) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  return ADD_STEPS.filter((s) => (s === 'section' ? sectionCount > 0 : !p[s]));
}

/**
 * The step after `current` (null = the title): the next one still asked, or 'done' (add the
 * task). A current step that is no longer asked (a token typed meanwhile answered it) still
 * moves on to the one after it.
 */
export function nextAddStep(steps, current = null) {
  const from = current === null ? -1 : stepRank(current);
  return steps.find((s) => stepRank(s) > from) ?? 'done';
}

/** The step before `current`: the previous one asked, or null (back to the title). */
export function prevAddStep(steps, current) {
  const from = current === 'done' ? ADD_STEPS.length : stepRank(current);
  if (from === -1) return null;
  return [...steps].reverse().find((s) => stepRank(s) < from) ?? null;
}

/**
 * The task the stepped quick-add makes -> { title, priority, due, sectionId }. A token in the
 * title wins, then what was picked on a step, then the default (the open section, Today in the
 * Today view …). In `picks` and `defaults` a key that is there counts even when it is null (No
 * date, No section). A picked section that no longer exists (`sectionIds`) counts as none.
 */
export function resolveAdd(parsed, picks = {}, defaults = {}, sectionIds = null) {
  const choice = (k, fallback) => (hasKey(picks, k) ? picks[k] : hasKey(defaults, k) ? defaults[k] : fallback);
  const priority = parsed?.priority ?? choice('priority', 'none');
  const due = parsed?.due ?? choice('due', null);
  const section = choice('section', null);
  return {
    title: cleanTitle(parsed?.title),
    priority: PRIORITIES.includes(priority) ? priority : 'none',
    due: isDateKey(due) ? due : null,
    sectionId: typeof section === 'string' && section && (!sectionIds || sectionIds.has(section)) ? section : null,
  };
}

/** Which When choice a due date is: 'today' | 'tomorrow' | 'none' | 'date' (any other day). */
export function dueChoice(due, today) {
  if (!isDateKey(due)) return 'none';
  if (due === today) return 'today';
  if (due === shiftKey(today, 1)) return 'tomorrow';
  return 'date';
}

/** First non-empty line of a note, for the one-line preview under a task. */
export function notePreview(notes, max = 90) {
  const line = String(notes ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/* ---- Links in a task's notes ---- */

// http(s) only: anything else (javascript:, file:, mailto:) stays plain text
const LINK_RE = /https?:\/\/[^\s<>"'`]+/gi;
// What ends the sentence around a link rather than the link: the dot in 'see <link>.', the bracket in '(<link>)'
const LINK_TRAIL = /[.,;:!?'"*_~]$/;
const LINK_PAIRS = { ')': '(', ']': '[', '}': '{' };
const countOf = (s, ch) => s.split(ch).length - 1;

function trimLink(raw) {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    if (LINK_TRAIL.test(last)) url = url.slice(0, -1);
    else if (LINK_PAIRS[last] && countOf(url, last) > countOf(url, LINK_PAIRS[last])) url = url.slice(0, -1);
    else return url;
  }
}

/** Text as plain parts and http(s) links, in order: [{ text } | { url }]. Joined back, they are the text. */
export function linkParts(text) {
  const s = String(text ?? '');
  const parts = [];
  let at = 0;
  for (const m of s.matchAll(LINK_RE)) {
    const url = trimLink(m[0]);
    // 'https://' with no site after it is not a link
    if (!/^https?:\/\/[^/?#]+/i.test(url)) continue;
    if (m.index > at) parts.push({ text: s.slice(at, m.index) });
    parts.push({ url });
    at = m.index + url.length;
  }
  if (at < s.length) parts.push({ text: s.slice(at) });
  return parts;
}

/** Every http(s) link in a task's notes, each once, in the order written (at most `max`). */
export function noteLinks(notes, max = 20) {
  const out = [];
  for (const p of linkParts(notes)) {
    if (out.length >= max) break;
    if (p.url && !out.includes(p.url)) out.push(p.url);
  }
  return out;
}

/** A link as people read it: no https://, no www., no trailing slash; cut to `max` characters with '…'. */
export function linkLabel(url, max = 60) {
  const s = String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The icon a section shows: the one picked, else what its name suggests, else a folder. */
export function sectionIcon(section) {
  return iconOf(section, 'folder');
}

/**
 * Sections with one section's icon picked (an icon name from the choices), or back to following
 * its name (null: the field goes). The same list when nothing changes or the name isn't an icon.
 */
export function withSectionIcon(sections, id, icon) {
  const next = icon === null ? null : cleanIcon(icon);
  if (icon !== null && !next) return sections;
  let changed = false;
  const out = sections.map((sec) => {
    if (sec.id !== id) return sec;
    if (next === null ? !Object.prototype.hasOwnProperty.call(sec, 'icon') : sec.icon === next) return sec;
    changed = true;
    if (next !== null) return { ...sec, icon: next };
    const { icon: _old, ...rest } = sec;
    return rest;
  });
  return changed ? out : sections;
}

/* ==========================================================================
   Icons: one vocabulary for the whole page (and the app): what each view, order, priority and
   kind of due date looks like, so a row reads at a glance without its words.
   ========================================================================== */

export const VIEW_ICON = Object.freeze({ all: 'list', today: 'sun', upcoming: 'calendar', done: 'check-circle' });
export const SORT_ICON = Object.freeze({ smart: 'zap', manual: 'grip', due: 'calendar', priority: 'flag' });
// None is "no flag"; Low, Medium and High share the flag and differ in weight (tasks.css)
export const PRIORITY_ICON = Object.freeze({ none: 'circle-slash', low: 'flag', med: 'flag', high: 'flag' });
export const DUE_ICON = Object.freeze({ overdue: 'alert', today: 'sun', tomorrow: 'sunrise', date: 'calendar', none: 'circle-slash' });

/**
 * Which kind of day a task is due, for its chip: 'overdue' (open and past), 'today', 'tomorrow',
 * 'date' (any other day, a done task's past one too) or null without a due date.
 */
export function dueKind(t, today) {
  if (!t || !isDateKey(t.due)) return null;
  if (isOverdue(t, today)) return 'overdue';
  return dueChoice(t.due, today);
}

/** Sections with one section's color set (null clears it): the same list when nothing changes. */
export function recolorSection(sections, id, color) {
  let changed = false;
  const next = sections.map((sec) => {
    if (sec.id !== id) return sec;
    const out = withColor(sec, color);
    changed = out !== sec;
    return out;
  });
  return changed ? next : sections;
}
