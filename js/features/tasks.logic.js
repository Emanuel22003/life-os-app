// LIFE/OS — Tasks: pure state logic (DOM-free, unit-tested with jsc).
// Everything here takes plain data and returns new data; nothing is mutated.

import { dateKey, parseKey, shiftKey, weekday, clamp, uid } from '../ui.js';

/* ==========================================================================
   Vocabulary
   ========================================================================== */

export const PRIORITIES = ['none', 'low', 'med', 'high'];
export const PRIORITY_RANK = { none: 0, low: 1, med: 2, high: 3 };
export const PRIORITY_LABEL = { none: 'None', low: 'Low', med: 'Med', high: 'High' };

export const FILTERS = ['all', 'today', 'upcoming', 'done'];
export const FILTER_LABEL = { all: 'All', today: 'Today', upcoming: 'Upcoming', done: 'Done' };

export const SORTS = ['manual', 'due', 'priority'];
export const SORT_LABEL = { manual: 'Manual', due: 'Due', priority: 'Priority' };

// view.section: 'all' or the id of the section being shown (per device: it never syncs)
export const DEFAULT_VIEW = Object.freeze({ filter: 'all', sort: 'manual', completedOpen: false, section: 'all' });
export const DEFAULT_STATE = Object.freeze({ items: [], sections: Object.freeze([]), view: DEFAULT_VIEW });

/** Sections split the list (Work, Life …): [{ id, name }] in display order; a task's sectionId points at one or is null. */
export const SECTION_NAME_MAX = 40;

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

  return {
    ...extra,
    id,
    title,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    done,
    priority,
    due: isDateKey(raw.due) ? raw.due : null,
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
  return { ...raw, id, name };
}

export function normalizeView(raw, sectionIds = new Set()) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    filter: FILTERS.includes(v.filter) ? v.filter : DEFAULT_VIEW.filter,
    sort: SORTS.includes(v.sort) ? v.sort : DEFAULT_VIEW.sort,
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

/* ==========================================================================
   Sorting
   ========================================================================== */

const cmpOrder = (a, b) => a.order - b.order;
// Undated tasks sink below dated ones
const cmpDue = (a, b) => (a.due === b.due ? 0 : !a.due ? 1 : !b.due ? -1 : a.due < b.due ? -1 : 1);
const cmpPriority = (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
const cmpCompleted = (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0);

const COMPARATORS = {
  manual: cmpOrder,
  due: (a, b) => cmpDue(a, b) || cmpPriority(a, b) || cmpOrder(a, b),
  priority: (a, b) => cmpPriority(a, b) || cmpDue(a, b) || cmpOrder(a, b),
  completed: (a, b) => cmpCompleted(a, b) || cmpOrder(a, b),
};

const comparator = (sort) => (Object.prototype.hasOwnProperty.call(COMPARATORS, sort) ? COMPARATORS[sort] : cmpOrder);

/** sort: 'manual' | 'due' | 'priority' | 'completed' (most recently completed first). Returns a new array. */
export function sortTasks(tasks, sort = 'manual') {
  return [...tasks].sort(comparator(sort));
}

const byManual = (items) => sortTasks(items, 'manual');

/**
 * What the list shows for a view: { main, completed }.
 * - main: the primary list (open tasks for all/today/upcoming, done tasks for 'done')
 * - completed: the collapsible "Completed" section (only in 'all')
 *
 * `linger` maps id -> { done, completedAt } as they were before a toggle, so a
 * just-checked row holds its place for a beat while its animation plays.
 */
export function viewSections(items, view, today, linger) {
  const pairs = items.map((t) => {
    const snap = linger?.get(t.id);
    return { t, ref: snap ? { ...t, done: snap.done, completedAt: snap.completedAt } : t };
  });
  const take = (pred, sort) => {
    const cmp = comparator(sort);
    return pairs
      .filter(({ ref }) => pred(ref))
      .sort((a, b) => cmp(a.ref, b.ref))
      .map(({ t }) => t);
  };

  if (view.filter === 'done') return { main: take((r) => r.done, 'completed'), completed: [] };
  return {
    main: take((r) => !r.done && matchesFilter(r, view.filter, today), view.sort),
    completed: view.filter === 'all' ? take((r) => r.done, 'completed') : [],
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

export function createTask({ title, priority = 'none', due = null, notes = '', sectionId = null } = {}, now = Date.now()) {
  return {
    id: uid(),
    title: cleanTitle(title),
    notes: typeof notes === 'string' ? notes : '',
    done: false,
    priority: PRIORITIES.includes(priority) ? priority : 'none',
    due: isDateKey(due) ? due : null,
    createdAt: now,
    completedAt: null,
    order: 0,
    sectionId: typeof sectionId === 'string' && sectionId ? sectionId : null,
  };
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

/** Patch title / notes / priority / due / sectionId. Invalid values are ignored; an empty title keeps the old one. */
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
    if ('sectionId' in patch) next.sectionId = typeof patch.sectionId === 'string' && patch.sectionId ? patch.sectionId : null;
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

/** First non-empty line of a note, for the one-line preview under a task. */
export function notePreview(notes, max = 90) {
  const line = String(notes ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
