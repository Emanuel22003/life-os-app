// LIFE/OS — 01 // Tasks
// Sections (Work, Life …), quick-add command bar, live stats, filters + sort, and a keyed task
// list with inline edit, details modal, drag-to-reorder and undoable deletes.

import {
  h,
  icon,
  pageHeader,
  emptyState,
  checkButton,
  setChecked,
  toast,
  openModal,
  confirmDialog,
  dateKey,
  todayKey,
  shiftKey,
  formatDay,
  relativeDay,
  timeAgo,
  onDayChange,
  idx,
  num,
  term,
  skin,
  plural,
  clamp,
  isTyping,
  modalOpen,
} from '../ui.js';
import { createStore } from '../store.js';
import {
  DEFAULT_STATE,
  PRIORITY_LABEL,
  FILTERS,
  FILTER_LABEL,
  SORTS,
  SORT_LABEL,
  normalizeState,
  isDateKey,
  isOverdue,
  matchesFilter,
  filterCounts,
  openCount,
  viewSections,
  computeStats,
  createTask,
  addTask,
  toggleTask,
  updateTask,
  moveTo,
  removeTasks,
  restoreTasks,
  insertTaskAfter,
  parseQuickAdd,
  notePreview,
  cleanTitle,
  inSection,
  sectionCounts,
  addSection,
  renameSection,
  removeSection,
  SECTION_NAME_MAX,
  isTimeOfDay,
  DEFAULT_TASK_MINUTES,
} from './tasks.logic.js';
import { registerContextProvider } from '../contextmenu.js';
import { splitText } from '../contextmenu.logic.js';

const LINGER_MS = 900; // how long a just-toggled row holds its place
const DRAG_THRESHOLD = 4;
const METER_TICKS = 20;
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? '');
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';
const ALT_KEY = IS_MAC ? '⌥' : 'Alt';

/* ==========================================================================
   Store (module singleton: shared by mount() and badge())
   ========================================================================== */

const store = createStore('tasks', DEFAULT_STATE);

let cacheRaw = null;
let cacheState = null;

/** Normalized state, memoized on the raw store object (other tabs may write anything). */
/** Simple's one-line summary of today, in place of the stats strip ("3 to do today"). */
function friendlySummary(s) {
  const toDo = s.dueToday + s.overdue;
  if (toDo) return `${toDo} to do today${s.doneToday ? `, ${s.doneToday} done so far` : ''}.`;
  if (s.doneToday) return 'All done for today. Nice work!';
  if (s.open) return 'Nothing due today.';
  return s.total ? 'Every task is done.' : 'Type a task below and press Enter to add it.';
}

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheState = normalizeState(raw);
  }
  return cacheState;
}

function commit(next) {
  cacheRaw = next;
  cacheState = next;
  store.set(next);
}

/** Apply fn to the items. Returns false (and writes nothing) when fn returns the same array. */
function setItems(fn) {
  const s = getState();
  const items = fn(s.items);
  if (items === s.items) return false;
  commit({ ...s, items });
  return true;
}

function setView(patch) {
  const s = getState();
  if (Object.keys(patch).every((k) => s.view[k] === patch[k])) return;
  commit({ ...s, view: { ...s.view, ...patch } });
}

const findTask = (id) => getState().items.find((t) => t.id === id);

// Upgrade older / malformed data in place once, so every reader sees the same shape.
if (JSON.stringify(store.get()) !== JSON.stringify(getState())) commit(getState());

// tasksApi.reveal() (bottom of file): the task the next Tasks view should bring into view
const REVEAL_TTL_MS = 10000; // a request no Tasks view picked up by then is stale
let pendingReveal = null; // { id, at }
let revealInView = null; // set while the Tasks view is mounted, so a reveal there acts at once

/* ==========================================================================
   Copy, paste, duplicate, delete: shared by the right-click menu here and in the Calendar
   (tasksApi). Every write goes through setItems / commit, so it is normalized and synced.
   ========================================================================== */

const TITLE_MAX = 500; // the quick-add input's maxlength

/** What a copy of a task carries. The copy is a new, open task: done state and dates stay behind. */
function taskSnapshot(t) {
  return { title: t.title, notes: t.notes, priority: t.priority, due: t.due, sectionId: t.sectionId };
}

/** Same task, field by field (its position aside). */
function sameTask(a, b) {
  const { order: _a, ...x } = a;
  const { order: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
}

/**
 * A new task from `snap` right after `afterId` in the manual order (first without one); `due`
 * and `sectionId` override the snapshot's. -> the stored task | null
 */
function insertCopy(snap, { afterId = null, due, sectionId } = {}) {
  const src = snap && typeof snap === 'object' ? snap : {};
  const title = cleanTitle(cleanTitle(src.title).slice(0, TITLE_MAX));
  if (!title) return null;
  const wanted = sectionId !== undefined ? sectionId : src.sectionId;
  const section = getState().sections.some((sec) => sec.id === wanted) ? wanted : null;
  const task = createTask({ title, notes: src.notes, priority: src.priority, due: due !== undefined ? due : src.due, sectionId: section });
  setItems((items) => insertTaskAfter(items, task, afterId));
  return findTask(task.id) ?? null;
}

/** Undo of a paste / duplicate: remove the copy, but only while it is exactly as it was made. */
function removeCopy(created) {
  const cur = created ? findTask(created.id) : null;
  if (!cur) {
    toast('Nothing undone: the copy was deleted since.');
    return false;
  }
  if (!sameTask(cur, created)) {
    toast(`Nothing undone: “${clip(cur.title, 28)}” changed since.`);
    return false;
  }
  setItems((items) => removeTasks(items, [created.id]).items);
  return true;
}

/** The Tasks delete: gone at once, Undo in the toast puts it back in its place. `onUndo(id)` runs first. */
function deleteWithUndo(id, { onUndo } = {}) {
  const s = getState();
  const task = s.items.find((t) => t.id === id);
  if (!task) return false;
  const { items, snapshots } = removeTasks(s.items, [id]);
  commit({ ...s, items });
  toast(`“${clip(task.title)}” deleted.`, {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: () => {
        onUndo?.(id);
        setItems((cur) => restoreTasks(cur, snapshots));
      },
    },
  });
  return true;
}

/* ==========================================================================
   Small builders
   ========================================================================== */

const clip = (s, n = 42) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const kbd = (k) => h('span', { class: 'kbd' }, k);
// Safari reports the Enter that commits an IME composition with isComposing=false but keyCode 229
const isComposing = (e) => e.isComposing || e.keyCode === 229;
// Row keys that act once per press: holding them must not machine-gun deletes / toggles
const ONCE_KEYS = new Set(['Enter', 'F2', ' ', 'x', 'X', 'e', 'E', 'Delete', 'Backspace']);

/** .seg toggle group. options: [{ value, label, aria?, count? }] */
function segGroup({ label, options, value, onChange, className }) {
  const buttons = new Map();
  const counts = new Map();
  const el = h(
    'div',
    { class: ['seg', className], role: 'group', 'aria-label': label },
    options.map((o) => {
      const count = o.count ? h('span', { class: 'seg-count tnum' }) : null;
      if (count) counts.set(o.value, count);
      const btn = h(
        'button',
        { type: 'button', class: 'seg-btn', 'aria-pressed': String(o.value === value), 'aria-label': o.aria, title: o.aria, onClick: () => onChange(o.value) },
        o.label,
        count,
      );
      buttons.set(o.value, btn);
      return btn;
    }),
  );
  return {
    el,
    set(v) {
      buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === v)));
    },
    count(k, text) {
      const c = counts.get(k);
      if (c && c.textContent !== text) c.textContent = text;
    },
  };
}

const PRIORITY_OPTIONS = [
  { value: 'none', label: '—', aria: 'No priority' },
  { value: 'low', label: 'Low', aria: 'Low priority' },
  { value: 'med', label: 'Med', aria: 'Medium priority' },
  { value: 'high', label: 'High', aria: 'High priority' },
];

function priorityPicker(initial = 'none') {
  let value = initial;
  const seg = segGroup({
    label: 'Priority',
    options: PRIORITY_OPTIONS.map((o) => ({ ...o, label: term(`tasks.priority.${o.value}`, o.label) })),
    value,
    className: 'tk-pri-seg',
    onChange: (v) => set(v),
  });
  function set(v) {
    value = v;
    seg.set(v);
  }
  return { el: seg.el, get: () => value, set };
}

/** Due-date picker: quick chips + native date input + clear. */
function duePicker(initial = null, { extended = false } = {}) {
  let value = initial;
  const chips = [
    { label: 'Today', key: () => todayKey() },
    { label: 'Tomorrow', key: () => shiftKey(todayKey(), 1) },
    extended && { label: '+1 week', aria: 'In one week', key: () => shiftKey(todayKey(), 7) },
  ].filter(Boolean);

  const chipEls = chips.map((c) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': 'false',
        'aria-label': c.aria ? `Due ${c.aria.toLowerCase()}` : `Due ${c.label.toLowerCase()}`,
        onClick: () => set(value === c.key() ? null : c.key()),
      },
      c.label,
    ),
  );
  const dateInput = h('input', {
    type: 'date',
    class: 'input tk-date',
    'aria-label': 'Due date',
    onChange: () => set(isDateKey(dateInput.value) ? dateInput.value : null),
  });
  const clearBtn = h(
    'button',
    { type: 'button', class: 'btn btn--ghost btn--icon btn--sm tk-due-clear', 'aria-label': 'Clear due date', title: 'Clear due date', onClick: () => set(null) },
    icon('x', { size: 14 }),
  );

  function set(v) {
    value = isDateKey(v) ? v : null;
    chipEls.forEach((b, i) => b.setAttribute('aria-pressed', String(value !== null && value === chips[i].key())));
    if (dateInput.value !== (value ?? '')) dateInput.value = value ?? '';
    clearBtn.hidden = !value;
  }
  set(initial);

  const el = h('div', { class: 'tk-due', role: 'group', 'aria-label': 'Due date' }, h('div', { class: 'seg tk-due-chips' }, chipEls), dateInput, clearBtn);
  return { el, get: () => value, set, refresh: () => set(value) };
}

/* ==========================================================================
   Feature
   ========================================================================== */

function mount(root) {
  /* ---- view-local state ---- */
  const rows = new Map(); // id -> { row, grip, idxEl, check, title, titleWrap, meta, details, del, input, sig }
  const linger = new Map(); // id -> { snap: { done, completedAt }, timer }
  const justAdded = new Set(); // ids that should play the entrance animation
  const ignoreTokens = new Set(); // quick-add token kinds the user chose to keep as text
  let editingId = null;
  let drag = null;
  let detailsModal = null;
  let rendering = false;
  let pendingRender = false;
  let firstRender = true;
  let mainIds = []; // ids in the main list, in display order (for reorder)
  let emptyKey = '';
  let readoutKey = '';
  let lastDoneCount = -1;
  let lastViewKey = '';
  let swapTimer = 0;

  /* ---- header ---- */
  // Same voice as Notes and Habits: a short static tagline. The live counts are in the stats strip.
  const header = pageHeader({ index: '02', title: 'Tasks', subtitle: 'Capture in one line. Sort by what matters. Clear the queue.' });
  // Simple has no stats strip: its subtitle says, in one line, what today holds instead
  const summaryEl = skin() === 'simple' ? header.querySelector('.page-subtitle') : null;

  /* ---- sections: All · Work · Life … (tabs; the open one scopes the whole page) ---- */
  const sectionBar = h('div', { class: 'tk-sections' });
  let sectionSeg = null;
  let sectionSig = null;

  /* ---- command bar ---- */
  // Screen-reader instructions sit on the controls that actually take focus (the add input
  // and every row); aria-describedby on a non-focusable <ol> is ignored by many readers.
  const addHelp = h(
    'p',
    { class: 'sr-only', id: 'tk-add-help' },
    'Type !h, !m or !l to set a priority and @today, @tomorrow or a weekday such as @fri to set a due date. When the field is empty, Down arrow moves to your tasks.',
  );
  const addInput = h('input', {
    class: 'tk-add-input',
    type: 'text',
    placeholder: 'Add a task…',
    'aria-label': 'New task',
    'aria-describedby': 'tk-add-help',
    autocomplete: 'off',
    enterkeyhint: 'enter',
    maxlength: '500',
    onInput: () => {
      if (!addInput.value.trim()) ignoreTokens.clear();
      renderReadout();
    },
    onKeydown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        addInput.blur();
      } else if (e.key === 'ArrowDown' && !addInput.value) {
        const first = root.querySelector('.tk-row');
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    },
  });
  const priPick = priorityPicker('none');
  const duePick = duePicker(null);
  const readout = h('div', { class: 'tk-readout', 'aria-live': 'polite' });

  const form = h(
    'form',
    {
      class: 'tk-command panel hud',
      'aria-label': 'Add a task',
      onSubmit: (e) => {
        e.preventDefault();
        addFromInput();
      },
    },
    h(
      'div',
      { class: 'tk-command-main' },
      h('span', { class: 'tk-prompt', 'aria-hidden': 'true' }, '›'),
      addInput,
      h('span', { class: 'tk-key-hint label lo-hint', 'aria-hidden': 'true' }, 'Press', kbd('N')),
      h('button', { type: 'submit', class: 'btn btn--primary btn--sm tk-add-btn', 'aria-label': 'Add task' }, icon('plus', { size: 14, stroke: 2 }), h('span', { class: 'tk-add-label' }, 'Add'), h('span', { class: 'kbd tk-add-kbd lo-hint', 'aria-hidden': 'true' }, '⏎')),
    ),
    h(
      'div',
      { class: 'tk-command-tools' },
      h('div', { class: 'tk-tool' }, h('span', { class: 'label tk-tool-label', 'aria-hidden': 'true' }, term('tasks.priority', 'Pri')), priPick.el),
      h('div', { class: 'tk-tool' }, h('span', { class: 'label tk-tool-label', 'aria-hidden': 'true' }, 'Due'), duePick.el),
      readout,
    ),
  );

  /* ---- stats strip ---- */
  function statCell(n, label, onClick) {
    const value = h('span', { class: 'stat-value tk-stat-value' }, '00');
    const sub = h('span', { class: 'tk-stat-sub' });
    const el = h(
      onClick ? 'button' : 'div',
      { class: 'tk-stat panel', type: onClick ? 'button' : null, onClick },
      h('span', { class: 'label tk-stat-label' }, h('span', { class: 'tk-stat-idx' }, n), label),
      value,
      sub,
    );
    return { el, value, sub };
  }

  const stOpen = statCell('01', 'Open', () => setFilter('all'));
  const stDone = statCell('02', 'Done today', () => setFilter('done'));
  const stOver = statCell('03', 'Overdue', () => setFilter('today'));

  const progValue = h('span', { class: 'stat-value tk-stat-value' }, '—');
  const progRatio = h('span', { class: 'tk-prog-ratio mono tnum' });
  const progFill = h('div', { class: 'progress-fill' });
  const progBar = h('div', { class: 'progress tk-progress', role: 'progressbar', 'aria-label': "Today's progress", 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progFill);
  const meterTicks = Array.from({ length: METER_TICKS }, () => h('span', { class: 'meter-tick' }));
  const overallPct = h('span', { class: 'mono tnum tk-overall-pct' });
  const stProg = h(
    'div',
    { class: 'tk-stat tk-stat--progress panel' },
    h('span', { class: 'label tk-stat-label' }, h('span', { class: 'tk-stat-idx' }, '04'), "Today's progress", h('span', { class: 'spacer' }), progRatio),
    progValue,
    progBar,
    h('div', { class: 'tk-overall' }, h('span', { class: 'label' }, 'All'), h('div', { class: 'meter tk-meter', 'aria-hidden': 'true' }, meterTicks), overallPct),
  );
  const statsEl = h('section', { class: 'tk-stats lo-deco', 'aria-label': 'Task summary' }, stOpen.el, stDone.el, stOver.el, stProg);

  /* ---- toolbar ---- */
  const filterSeg = segGroup({
    label: 'Filter tasks',
    options: FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f], count: true })),
    value: getState().view.filter,
    className: 'tk-filters',
    onChange: (f) => setFilter(f),
  });
  const sortSeg = segGroup({
    label: 'Sort tasks',
    options: SORTS.map((s) => ({ value: s, label: term(`tasks.sort.${s}`, SORT_LABEL[s]) })),
    value: getState().view.sort,
    onChange: (s) => setView({ sort: s }),
  });
  const sortWrap = h('div', { class: 'tk-sort' }, h('span', { class: 'label', 'aria-hidden': 'true' }, 'Sort'), sortSeg.el);
  const clearDoneBtn = h('button', { type: 'button', class: 'btn btn--danger btn--sm', onClick: clearCompleted }, icon('trash', { size: 14 }), 'Clear completed');
  const toolbar = h('div', { class: 'tk-toolbar' }, filterSeg.el, h('span', { class: 'spacer' }), sortWrap, clearDoneBtn);

  /* ---- lists ---- */
  // Referenced by every row (see createRow), the element that receives focus.
  const kbdHelp = h(
    'p',
    { class: 'sr-only', id: 'tk-kbd-help' },
    'Arrow keys move between tasks. Enter renames, Space toggles done, E opens details, Alt plus Up or Down reorders, Delete removes.',
  );
  const mainList = h('ol', { class: 'tk-list', 'aria-label': 'Tasks' });
  const mainPanel = h('div', { class: 'tk-panel panel' }, mainList);
  const emptyHost = h('div', { class: 'tk-empty-host' });

  const doneCount = h('span', { class: 'tk-done-count mono tnum' });
  const doneToggle = h(
    'button',
    {
      type: 'button',
      class: 'tk-done-toggle',
      'aria-expanded': 'false',
      'aria-controls': 'tk-done-list',
      onClick: () => setView({ completedOpen: !getState().view.completedOpen }),
    },
    icon('chevron-right', { size: 14 }),
    h('span', { class: 'label' }, 'Completed'),
    doneCount,
  );
  const doneList = h('ol', { class: 'tk-list tk-list--done', id: 'tk-done-list', 'aria-label': 'Completed tasks' });
  const donePanel = h('div', { class: 'tk-panel tk-panel--done panel' }, doneList);
  // Same destructive variant as the toolbar's "Clear completed" (and Habits' "Clear <day>").
  const doneClearBtn = h(
    'button',
    { type: 'button', class: 'btn btn--danger btn--sm', 'aria-label': 'Clear completed tasks', onClick: clearCompleted },
    icon('trash', { size: 14 }),
    'Clear',
  );
  const doneSection = h(
    'section',
    { class: 'tk-done', 'aria-label': 'Completed tasks' },
    h('div', { class: 'tk-done-head' }, doneToggle, h('span', { class: 'tk-done-rule', 'aria-hidden': 'true' }), doneClearBtn),
    donePanel,
  );

  // One .kbd per key, as in the Notes and Habits hint bars
  const hint = (keys, text) => h('span', { class: 'tk-hint' }, keys.map(kbd), h('span', null, text));
  const hints = h(
    'div',
    { class: 'tk-hints label lo-hint', 'aria-hidden': 'true' },
    hint(['N'], 'New'),
    hint(['↑', '↓'], 'Select'),
    hint(['⏎'], 'Rename'),
    hint(['Space'], 'Done'),
    hint(['E'], 'Details'),
    hint([ALT_KEY, '↑', '↓'], 'Reorder'),
    hint(['Del'], 'Delete'),
  );

  root.classList.add('tk-root');
  root.append(header, sectionBar, form, statsEl, toolbar, mainPanel, emptyHost, doneSection, hints, addHelp, kbdHelp);
  root.addEventListener('keydown', onRowKeydown);

  /* ==========================================================================
     Rendering
     ========================================================================== */

  function render() {
    if (drag) {
      pendingRender = true;
      return;
    }
    if (rendering) {
      pendingRender = true;
      return;
    }
    rendering = true;
    pendingRender = false;
    try {
      paint();
    } finally {
      rendering = false;
      firstRender = false;
    }
    if (pendingRender) render();
  }

  function paint() {
    const { items, sections, view } = getState();
    const today = todayKey();
    // The open section scopes the stats, the filter counts and the lists
    const scoped = inSection(items, view.section);
    const counts = filterCounts(scoped, today);
    const stats = computeStats(scoped, today);
    const snaps = new Map([...linger].map(([id, l]) => [id, l.snap]));
    const { main, completed } = viewSections(scoped, view, today, snaps);
    const manual = view.sort === 'manual' && view.filter !== 'done';
    const focus = captureFocus();
    const sectionName = sections.find((sec) => sec.id === view.section)?.name ?? null;
    // In All, each row says which section it's in
    const names = view.section === 'all' && sections.length ? new Map(sections.map((sec) => [sec.id, sec.name])) : null;

    paintSections(sections, sectionCounts(items), view.section);
    paintStats(stats);

    // toolbar
    filterSeg.set(view.filter);
    FILTERS.forEach((f) => filterSeg.count(f, String(counts[f])));
    sortSeg.set(view.sort);
    sortWrap.hidden = view.filter === 'done';
    clearDoneBtn.hidden = view.filter !== 'done' || counts.done === 0;
    addInput.placeholder = sectionName
      ? `Add a task to ${sectionName}${view.filter === 'today' ? ' for today' : ''}…`
      : view.filter === 'today'
        ? 'Add a task for today…'
        : 'Add a task…';

    // main list
    const used = new Set();
    reconcile(mainList, main, used, (t, i) => ({ index: i, today, draggable: manual && !t.done, section: names?.get(t.sectionId) ?? null }));
    mainIds = main.map((t) => t.id);
    mainPanel.hidden = main.length === 0;
    paintEmpty(main.length === 0 ? emptyKind(view.filter, counts, sectionName) : '', sectionName ?? '');

    // a short staggered fade when the section, filter or sort changes
    const viewKey = `${view.section}:${view.filter}:${view.sort}`;
    if (lastViewKey && viewKey !== lastViewKey) {
      bump(mainList, 'tk-list--swap');
      clearTimeout(swapTimer);
      swapTimer = setTimeout(() => mainList.classList.remove('tk-list--swap'), 700);
    }
    lastViewKey = viewKey;

    // completed section (All view only)
    const showDone = view.filter === 'all' && completed.length > 0;
    doneSection.hidden = !showDone;
    doneToggle.setAttribute('aria-expanded', String(view.completedOpen));
    donePanel.hidden = !view.completedOpen;
    const doneText = num(completed.length);
    if (doneCount.textContent !== doneText) {
      if (showDone && lastDoneCount >= 0 && completed.length > lastDoneCount) bump(doneCount);
      doneCount.textContent = doneText;
    }
    lastDoneCount = view.filter === 'all' ? completed.length : -1;
    reconcile(doneList, showDone && view.completedOpen ? completed : [], used, (t, i) => ({ index: i, today, draggable: false, section: names?.get(t.sectionId) ?? null }));

    // The row being renamed left the view (a change from another tab filtered it out
    // or completed it into a collapsed section): keep what was typed rather than drop it.
    if (editingId && !used.has(editingId)) {
      const input = rows.get(editingId)?.input;
      if (input && cleanTitle(input.value)) commitEdit();
      else cancelEdit();
    }

    for (const [id, r] of rows) {
      if (!used.has(id)) {
        r.row.remove();
        rows.delete(id);
      }
    }
    restoreFocus(focus);
  }

  function paintStats(s) {
    if (summaryEl) summaryEl.textContent = friendlySummary(s);
    setStat(stOpen, s.open, `of ${s.total} total`);
    setStat(stDone, s.doneToday, `${s.done} all time`);
    setStat(stOver, s.overdue, s.overdue ? 'Needs attention' : 'All on schedule');
    stOver.el.classList.toggle('is-alert', s.overdue > 0);
    stOpen.el.setAttribute('aria-label', `${s.open} open tasks. Show all.`);
    stDone.el.setAttribute('aria-label', `${s.doneToday} done today. Show completed.`);
    stOver.el.setAttribute('aria-label', `${s.overdue} overdue. Show today.`);

    const pct = Math.round(s.todayProgress * 100);
    tick(progValue, s.todayTotal ? `${pct}%` : '—');
    progRatio.textContent = `${num(s.doneToday)}/${num(s.todayTotal)}`;
    progFill.style.width = `${s.todayTotal ? pct : 0}%`;
    progBar.setAttribute('aria-valuenow', String(pct));
    stProg.classList.toggle('is-complete', s.todayTotal > 0 && s.doneToday === s.todayTotal);
    const lit = Math.round(s.overallProgress * METER_TICKS);
    meterTicks.forEach((t, i) => t.classList.toggle('is-on', i < lit));
    overallPct.textContent = `${Math.round(s.overallProgress * 100)}%`;
  }

  function setStat(cell, n, sub) {
    tick(cell.value, num(n));
    cell.el.classList.toggle('is-zero', n === 0);
    if (cell.sub.textContent !== sub) cell.sub.textContent = sub;
  }

  /** Set text; when it changes after the first paint, replay the tick animation. */
  function tick(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!firstRender) bump(el, 'is-ticking');
  }

  function bump(el, cls = 'is-bump') {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
  }

  /* ---- empty states ---- */

  /** The section tabs: rebuilt when sections change, counts and the open tab updated every paint. */
  function paintSections(sections, counts, active) {
    const sig = sections.map((sec) => `${sec.id}\u241f${sec.name}`).join('\u241e');
    if (sig !== sectionSig) {
      sectionSig = sig;
      if (sections.length) {
        sectionSeg = segGroup({
          label: 'Sections',
          options: [{ value: 'all', label: 'All', count: true }, ...sections.map((sec) => ({ value: sec.id, label: sec.name, count: true }))],
          value: active,
          className: 'tk-sec-seg',
          onChange: (id) => setSection(id),
        });
        sectionBar.replaceChildren(
          sectionSeg.el,
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm tk-sec-btn', title: 'New section', onClick: () => openSections({ adding: true }) }, icon('plus', { size: 14 }), h('span', { class: 'tk-sec-btn-label' }, 'Section')),
          h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Edit sections', title: 'Rename or delete sections', onClick: () => openSections() }, icon('edit', { size: 14 })),
        );
      } else {
        sectionSeg = null;
        // None yet: one click makes the usual ones, or any other
        const suggest = (label, onClick) => h('button', { type: 'button', class: 'btn btn--ghost btn--sm tk-sec-btn', onClick }, icon('plus', { size: 14 }), label);
        sectionBar.replaceChildren(
          h('span', { class: 'label tk-sec-label' }, 'Sections'),
          suggest('Work', () => createSection('Work', { open: true })),
          suggest('Life', () => createSection('Life', { open: true })),
          suggest('Other…', () => openSections({ adding: true })),
        );
      }
    }
    if (sectionSeg) {
      sectionSeg.set(active);
      sectionSeg.count('all', String(counts.get('all') ?? 0));
      for (const sec of sections) sectionSeg.count(sec.id, String(counts.get(sec.id) ?? 0));
    }
  }

  function emptyKind(filter, counts, sectionName) {
    if (filter !== 'all') return filter;
    if (counts.done > 0) return 'clear';
    return sectionName ? 'section' : 'fresh';
  }

  function paintEmpty(kind, detail = '') {
    emptyHost.hidden = !kind;
    const key = `${kind}\u241f${detail}`;
    if (key === emptyKey) return;
    emptyKey = key;
    emptyHost.replaceChildren(kind ? buildEmpty(kind, detail) : '');
  }

  function buildEmpty(kind, detail = '') {
    // Shared pattern (Notes, Habits): contextual empty states get a small button, primary
    // for "create", secondary for "go elsewhere"; the first-run state gets a full-size one.
    const action = (label, onClick, iconName = 'plus', { large = false, primary = true } = {}) =>
      h(
        'button',
        { type: 'button', class: ['btn tk-empty-action', primary && 'btn--primary', !large && 'btn--sm'], onClick },
        icon(iconName, { size: large ? 16 : 14 }),
        label,
      );
    switch (kind) {
      case 'today':
        return emptyState({
          icon: 'sun',
          title: 'Nothing due today',
          text: 'No tasks due today and nothing overdue. Clear runway.',
          action: action('Add a task for today', () => focusAdd({ due: todayKey() })),
        });
      case 'upcoming':
        return emptyState({
          icon: 'calendar',
          title: 'Nothing scheduled',
          text: term('tasks.empty.upcoming', 'Tasks with a future due date land here. Try typing @fri or @tomorrow.'),
          action: action('Schedule for tomorrow', () => focusAdd({ due: shiftKey(todayKey(), 1) })),
        });
      case 'done':
        return emptyState({
          icon: 'check',
          title: 'Nothing completed yet',
          text: 'Check off a task and it shows up here.',
          action: action('View all tasks', () => setFilter('all'), 'list', { primary: false }),
        });
      case 'clear':
        return emptyState({
          icon: 'zap',
          title: 'All clear',
          text: 'Every task is done. Add the next one when you are ready.',
          action: action('Add a task', () => focusAdd()),
        });
      case 'section':
        return emptyState({
          icon: 'list',
          title: `Nothing in ${clip(detail, 32)} yet`,
          text: 'Tasks you add while this section is open go here.',
          action: action('Add a task', () => focusAdd()),
        });
      default:
        return emptyState({
          icon: 'list',
          title: 'No tasks yet',
          text: term('tasks.empty.first', 'Capture anything on your mind. Press N from anywhere on this page to start typing.'),
          action: action('Add your first task', () => focusAdd(), 'plus', { large: true }),
        });
    }
  }

  /* ---- keyed list reconciliation ---- */

  function reconcile(list, tasks, used, ctxFor) {
    // Drop rows that no longer belong here first. Otherwise every survivor after a
    // removed row would be re-inserted around it, which detaches focused rows / the
    // inline-edit input (firing blur) and restarts running check-off animations.
    const wanted = new Set(tasks.map((t) => t.id));
    for (const el of [...list.children]) {
      if (!wanted.has(el.dataset.id)) el.remove();
    }
    let cursor = list.firstElementChild;
    tasks.forEach((t, i) => {
      let r = rows.get(t.id);
      if (!r) {
        r = createRow(t.id);
        rows.set(t.id, r);
        if (justAdded.has(t.id) && !firstRender) r.row.classList.add('tk-row--enter');
      }
      justAdded.delete(t.id);
      used.add(t.id);
      updateRow(r, t, ctxFor(t, i));
      if (r.row === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(r.row, cursor);
    });
    // every wanted row now sits before the cursor; whatever follows no longer belongs here
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  function createRow(id) {
    const row = h('li', { class: 'tk-row', tabindex: '0', 'aria-describedby': 'tk-kbd-help', dataset: { id } });
    const idxEl = h('span', { class: 'tk-idx mono tnum lo-deco' });
    // Pointer-only affordance (keyboard users reorder with Alt+arrows), so it stays out
    // of the accessibility tree instead of announcing "Drag to reorder" on every row.
    const grip = h(
      'button',
      { type: 'button', class: 'tk-grip', tabindex: '-1', 'aria-hidden': 'true', title: 'Drag to reorder', onPointerdown: (e) => startDrag(e, id) },
      h('span', { class: 'tk-grip-inner' }, idxEl, icon('grip', { size: 14, className: 'tk-grip-icon' })),
    );
    const check = checkButton({ label: 'Mark done', onToggle: (checked) => toggleDone(id, checked) });
    check.classList.add('tk-check');
    const title = h('span', { class: 'tk-title', onClick: () => startEdit(id) });
    const titleWrap = h('div', { class: 'tk-title-line' }, title);
    const meta = h('div', { class: 'tk-meta' });
    const details = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', title: 'Details (E)', onClick: () => openDetails(id) }, icon('edit', { size: 15 }));
    const del = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--icon btn--sm',
        title: 'Delete (Del)',
        // The 2nd click of a double-click lands on the next row's trash as rows shift up
        onClick: (e) => {
          if (e.detail < 2) deleteTask(id);
        },
      },
      icon('trash', { size: 15 }),
    );
    row.append(grip, check, h('div', { class: 'tk-body' }, titleWrap, meta), h('div', { class: 'row-actions tk-actions' }, details, del));
    // One-shot animation classes must go once played, or re-inserting the row
    // (e.g. into the Completed list) would replay them.
    row.addEventListener('animationend', (e) => {
      if (e.animationName === 'tk-enter') row.classList.remove('tk-row--enter');
      else if (e.animationName === 'tk-sweep' || e.animationName === 'tk-unsweep') row.classList.remove('is-completing', 'is-reopening');
    });
    return { row, grip, idxEl, check, title, titleWrap, meta, details, del, input: null, sig: '' };
  }

  function updateRow(r, t, { index, today, draggable, section = null }) {
    const overdue = isOverdue(t, today);
    const doneAgo = t.done && t.completedAt ? timeAgo(t.completedAt) : '';
    const sig = [t.title, t.done, t.priority, t.due, t.time, t.notes, doneAgo, today, index, draggable, editingId === t.id, section].join('␟');
    if (r.sig === sig) return;
    r.sig = sig;

    const { row } = r;
    row.classList.toggle('is-done', t.done);
    row.classList.toggle('is-overdue', overdue);
    row.classList.toggle('is-draggable', draggable);
    row.dataset.priority = t.priority;

    r.idxEl.textContent = idx(index + 1);
    row.style.setProperty('--tk-i', String(Math.min(index, 14)));
    r.grip.disabled = !draggable;
    setChecked(r.check, t.done);
    r.check.setAttribute('aria-label', t.done ? `Mark “${t.title}” as not done` : `Mark “${t.title}” as done`);
    if (editingId !== t.id) r.title.textContent = t.title;
    r.details.setAttribute('aria-label', `Details for “${t.title}”`);
    r.del.setAttribute('aria-label', `Delete “${t.title}”`);

    const meta = metaNodes(t, today, overdue, doneAgo, section);
    r.meta.replaceChildren(...meta);
    r.meta.hidden = meta.length === 0;
  }

  function metaNodes(t, today, overdue, doneAgo, section) {
    const out = [];
    if (section) out.push(h('span', { class: 'tag tk-sec-tag', title: `Section: ${section}` }, h('span', { class: 'sr-only' }, 'Section: '), section));
    if (t.priority !== 'none') {
      out.push(
        h(
          'span',
          { class: ['tag', 'tk-pri', t.priority === 'high' && 'tag--solid', t.priority === 'low' && 'tag--dashed'] },
          h('span', { class: 'sr-only' }, 'Priority: '),
          term(`tasks.priority.${t.priority}`, PRIORITY_LABEL[t.priority]),
        ),
      );
    }
    if (t.due) {
      // A timed task says when: 'Today · 17:30'
      const rel = t.time ? `${relativeDay(t.due, today)} · ${t.time}` : relativeDay(t.due, today);
      const long = formatDay(t.due, 'long');
      if (overdue) {
        out.push(
          h(
            'span',
            { class: 'tag tk-due-tag tk-due-tag--overdue', title: `Was due ${long}` },
            h('span', { class: 'tk-blink', 'aria-hidden': 'true' }),
            h('strong', null, 'Overdue'),
            h('span', { class: 'tk-sep', 'aria-hidden': 'true' }, '/'),
            rel,
          ),
        );
      } else {
        out.push(
          h(
            'span',
            { class: ['tag', 'tk-due-tag', !t.done && t.due === today && 'tk-due-tag--today'], title: `Due ${long}` },
            icon('calendar', { size: 11 }),
            h('span', { class: 'sr-only' }, 'Due: '),
            rel,
          ),
        );
      }
    }
    if (doneAgo) out.push(h('span', { class: 'tk-done-ago label' }, icon('check', { size: 11, stroke: 2 }), `Done ${doneAgo}`));
    const preview = notePreview(t.notes);
    if (preview) {
      out.push(h('span', { class: 'tk-note', title: preview }, icon('note', { size: 12 }), h('span', { class: 'sr-only' }, 'Note: '), h('span', { class: 'tk-note-text truncate' }, preview)));
    }
    return out;
  }

  /* ---- focus preservation across re-renders ---- */

  function captureFocus() {
    const el = document.activeElement;
    if (!el || el === document.body || !root.contains(el)) return null;
    const rowEl = el.closest('.tk-row');
    if (!rowEl) return { el };
    const list = rowEl.parentElement;
    const sel = el.tagName === 'INPUT' ? [el.selectionStart, el.selectionEnd] : null;
    return { el, rowId: rowEl.dataset.id, list, index: [...list.children].indexOf(rowEl), sel };
  }

  const isShown = (el) => el.isConnected && el.offsetParent !== null;

  function restoreFocus(f) {
    if (!f) return;
    if (document.activeElement === f.el && isShown(f.el)) return;
    if (f.rowId) {
      const r = rows.get(f.rowId);
      // Same list, or the inline-edit input wherever its row went: put focus + caret back
      if (r && isShown(f.el) && (r.row.parentElement === f.list || (r.input && f.el === r.input))) {
        f.el.focus({ preventScroll: true });
        if (f.sel && typeof f.el.setSelectionRange === 'function') f.el.setSelectionRange(f.sel[0], f.sel[1]);
        return;
      }
      // The row left this list (completed, deleted, filtered out): keep the keyboard
      // user in place by focusing whatever now sits at its old index.
      const siblings = f.list.querySelectorAll(':scope > .tk-row');
      const target = siblings[Math.min(f.index, siblings.length - 1)];
      if (target && isShown(target)) {
        target.focus();
        return;
      }
    } else if (isShown(f.el)) {
      f.el.focus({ preventScroll: true });
      return;
    }
    // The focused control vanished (e.g. "Clear" after clearing): land somewhere sensible.
    const fallback = (!emptyHost.hidden && emptyHost.querySelector('button')) || root.querySelector('.tk-row') || addInput;
    fallback.focus({ preventScroll: true });
  }

  /* ==========================================================================
     Actions
     ========================================================================== */

  function focusAdd({ due } = {}) {
    if (due !== undefined) duePick.set(due);
    addInput.focus();
  }

  function addFromInput() {
    const today = todayKey();
    const parsed = parseQuickAdd(addInput.value, today, ignoreTokens);
    if (!parsed.title) {
      if (addInput.value.trim()) bump(form, 'is-rejected');
      addInput.focus();
      return;
    }
    const { view } = getState();
    const task = createTask({
      title: parsed.title,
      priority: parsed.priority ?? priPick.get(),
      due: parsed.due ?? duePick.get() ?? (view.filter === 'today' ? today : null),
      sectionId: view.section !== 'all' ? view.section : null,
    });
    justAdded.add(task.id);
    setItems((items) => addTask(items, task));

    addInput.value = '';
    ignoreTokens.clear();
    priPick.set('none');
    duePick.set(null);
    renderReadout();
    addInput.focus();

    if (!(view.filter === 'all' || matchesFilter(task, view.filter, today))) {
      toast(`“${clip(task.title, 28)}” added — not shown in ${FILTER_LABEL[view.filter]}.`, {
        action: { label: 'Show', onClick: () => setFilter('all') },
      });
    }
  }

  function renderReadout() {
    const today = todayKey();
    const { tokens } = parseQuickAdd(addInput.value, today, ignoreTokens);
    const key = JSON.stringify(tokens);
    if (key === readoutKey) return;
    readoutKey = key;

    const chip = (kind, text, raw) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tag tk-token',
          title: `Keep “${raw}” as text`,
          'aria-label': `${text}. Keep “${raw}” as plain text instead`,
          onClick: () => {
            ignoreTokens.add(kind);
            renderReadout();
            addInput.focus();
          },
        },
        text,
        icon('x', { size: 10, stroke: 2 }),
      );

    const chips = [];
    if (tokens.priority) chips.push(chip('priority', `${term(`tasks.priority.${tokens.priority.value}`, PRIORITY_LABEL[tokens.priority.value])} priority`, tokens.priority.raw));
    if (tokens.due) chips.push(chip('due', `Due ${relativeDay(tokens.due.value, today)}`, tokens.due.raw));
    // A second token of the same kind: only the last one applies; say so instead of
    // letting the earlier one land in the title unannounced.
    const kept = [...(tokens.priority?.kept ?? []), ...(tokens.due?.kept ?? [])];
    if (kept.length) {
      chips.push(h('span', { class: 'label tk-kept', title: 'Only the last priority and due token apply. The others stay in the title.' }, 'Kept as text', kept.map(kbd)));
    }

    readout.classList.toggle('is-idle', !chips.length);
    if (chips.length) readout.replaceChildren(h('span', { class: 'label tk-readout-label' }, term('tasks.parsed', 'Parsed')), ...chips);
    else readout.replaceChildren(h('span', { class: 'label tk-tip lo-hint' }, 'Tip', kbd('!h'), kbd('@tomorrow'), kbd('@fri')));
  }

  function toggleDone(id, done) {
    const task = findTask(id);
    if (!task || task.done === done) return;
    const before = computeStats(getState().items, todayKey());

    // Hold the row in place for a beat so the check-off reads before it moves.
    const prev = linger.get(id);
    if (prev) clearTimeout(prev.timer);
    linger.set(id, {
      snap: prev ? prev.snap : { done: task.done, completedAt: task.completedAt },
      timer: setTimeout(() => {
        linger.delete(id);
        rows.get(id)?.row.classList.remove('is-completing', 'is-reopening');
        render();
      }, LINGER_MS),
    });
    const r = rows.get(id);
    if (r) {
      r.row.classList.remove('is-completing', 'is-reopening');
      bump(r.row, done ? 'is-completing' : 'is-reopening');
    }

    setItems((items) => toggleTask(items, id, done));

    const after = computeStats(getState().items, todayKey());
    if (done && before.dueToday + before.overdue > 0 && after.dueToday + after.overdue === 0) {
      toast("Today's queue is clear. Nice work.");
    }
  }

  function settleLinger() {
    linger.forEach((l) => clearTimeout(l.timer));
    linger.clear();
  }

  function setFilter(filter) {
    settleLinger();
    if (getState().view.filter !== filter) setView({ filter });
    else render();
  }

  function setSection(section) {
    settleLinger();
    if (editingId) commitEdit();
    if (getState().view.section !== section) setView({ section });
    else render();
  }

  /** Make a section (opening it when `open`). -> null, or why not: 'empty' | 'taken' */
  function createSection(name, { open = false } = {}) {
    const s = getState();
    const res = addSection(s.sections, name);
    if (res.error) return res.error;
    if (open) settleLinger();
    commit({ ...s, sections: res.sections, view: open ? { ...s.view, section: res.section.id } : s.view });
    return null;
  }

  /** Delete a section after asking when it has tasks; they stay, without a section. -> deleted? */
  async function deleteSection(id) {
    const s = getState();
    const sec = s.sections.find((x) => x.id === id);
    if (!sec) return false;
    const n = s.items.filter((t) => t.sectionId === id).length;
    if (n) {
      const ok = await confirmDialog({
        title: `Delete “${clip(sec.name, 28)}”?`,
        message: `Its ${plural(n, 'task')} ${n === 1 ? 'stays' : 'stay'} in All, without a section.`,
        confirmLabel: 'Delete section',
      });
      if (!ok) return false;
    }
    const cur = getState();
    if (!cur.sections.some((x) => x.id === id)) return false;
    const next = removeSection(cur.items, cur.sections, id);
    settleLinger();
    commit({ ...cur, ...next, view: cur.view.section === id ? { ...cur.view, section: 'all' } : cur.view });
    toast(`Section “${clip(sec.name, 28)}” deleted.`);
    return true;
  }

  /** The Sections dialog: add, rename and delete. `adding` puts the cursor in the new-section field. */
  function openSections({ adding = false } = {}) {
    if (editingId) commitEdit();
    const list = h('ul', { class: 'tk-secs' });
    const msg = h('p', { class: 'tk-secs-msg', role: 'status', 'aria-live': 'polite' });
    const addIn = h('input', {
      class: 'input',
      type: 'text',
      maxlength: String(SECTION_NAME_MAX),
      placeholder: 'New section, e.g. Work',
      'aria-label': 'New section name',
      autocomplete: 'off',
    });
    const say = (text) => (msg.textContent = text);
    const problem = (err, name) => (err === 'taken' ? `There is already a section called “${clip(cleanTitle(name), 28)}”.` : 'Give the section a name.');

    const add = () => {
      const err = createSection(addIn.value);
      if (err) {
        say(problem(err, addIn.value));
        addIn.focus();
        return;
      }
      addIn.value = '';
      say('');
      paintList();
      addIn.focus();
    };
    addIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isComposing(e)) {
        e.preventDefault();
        add();
      }
    });

    function paintList() {
      const { items, sections } = getState();
      list.hidden = sections.length === 0;
      list.replaceChildren(
        ...sections.map((sec) => {
          const nameIn = h('input', { class: 'input tk-secs-name', type: 'text', value: sec.name, maxlength: String(SECTION_NAME_MAX), 'aria-label': `Name of section ${sec.name}`, autocomplete: 'off' });
          nameIn.addEventListener('change', () => {
            const cur = getState();
            const res = renameSection(cur.sections, sec.id, nameIn.value);
            if (res.error) {
              say(problem(res.error, nameIn.value));
              nameIn.value = cur.sections.find((x) => x.id === sec.id)?.name ?? sec.name;
              return;
            }
            say('');
            if (res.sections !== cur.sections) commit({ ...cur, sections: res.sections });
          });
          nameIn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !isComposing(e)) {
              e.preventDefault();
              nameIn.blur();
            }
          });
          const n = items.filter((t) => t.sectionId === sec.id).length;
          return h(
            'li',
            { class: 'tk-secs-row' },
            nameIn,
            h('span', { class: 'tk-secs-count label' }, plural(n, 'task')),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn--ghost btn--icon btn--sm',
                'aria-label': `Delete section ${sec.name}`,
                title: 'Delete section',
                onClick: async () => {
                  if (await deleteSection(sec.id)) paintList();
                },
              },
              icon('trash', { size: 14 }),
            ),
          );
        }),
      );
    }

    const m = openModal({
      title: 'Sections',
      className: 'tk-secs-modal',
      body: [
        h('p', { class: 'tk-secs-lead' }, 'Split your tasks, like Work and Life. Open a section to see only its tasks; new tasks go into the open one.'),
        list,
        h('div', { class: 'tk-secs-add' }, addIn, h('button', { type: 'button', class: 'btn btn--sm', onClick: add }, icon('plus', { size: 14 }), 'Add')),
        msg,
      ],
      footer: [h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Done')],
      initialFocus: adding || !getState().sections.length ? addIn : undefined,
    });
    paintList();
  }

  function dropLinger(id) {
    const l = linger.get(id);
    if (l) clearTimeout(l.timer);
    linger.delete(id);
  }

  function deleteTask(id) {
    if (!findTask(id)) return;
    if (editingId === id) editingId = null;
    dropLinger(id);
    deleteWithUndo(id, { onUndo: (restored) => justAdded.add(restored) });
  }

  /** Paste (or duplicate) a copy after `afterId`; it animates in, takes focus, and Undo takes it back. */
  function pasteTask(snap, afterId, { verb = 'Pasted', due, sectionId } = {}) {
    if (drag) cancelDrag();
    if (editingId) commitEdit();
    const task = insertCopy(snap, { afterId, due, sectionId });
    if (!task) {
      toast('Nothing to paste.');
      return;
    }
    justAdded.add(task.id);
    render();
    const { view } = getState();
    const hidden = !(view.filter === 'all' || matchesFilter(task, view.filter, todayKey()));
    if (!hidden) rows.get(task.id)?.row.focus({ preventScroll: true });
    rows.get(task.id)?.row.scrollIntoView?.({ block: 'nearest' });
    toast(`${verb} “${clip(task.title, 28)}”${hidden ? ` — not shown in ${FILTER_LABEL[view.filter]}` : ''}.`, {
      duration: 6000,
      action: { label: 'Undo', onClick: () => removeCopy(task) },
    });
  }

  /** Plain text from the clipboard: the first line is the title, the rest its notes. In Today it is due today. */
  function pasteText(text, afterId) {
    const { title, rest } = splitText(text, TITLE_MAX);
    if (!title) {
      toast('Nothing to paste.');
      return;
    }
    const due = getState().view.filter === 'today' ? todayKey() : null;
    pasteTask({ title, notes: rest, priority: 'none', due }, afterId, { sectionId: openSection() ?? null });
  }

  /** The open section's id, or undefined in All (a paste there keeps the copy's own section). */
  function openSection() {
    const { section } = getState().view;
    return section === 'all' ? undefined : section;
  }

  function duplicateTask(id) {
    const task = findTask(id);
    if (task) pasteTask(taskSnapshot(task), id, { verb: 'Duplicated' });
  }

  /** The right-click menu: a task row, or anywhere else on the page (a paste target). */
  function contextTarget(el) {
    if (!root.contains(el)) return null;
    const rowEl = el.closest('.tk-row[data-id]');
    const task = rowEl ? findTask(rowEl.dataset.id) : null;
    const afterId = task?.id ?? null;
    const paste = {
      accepts: ['task'],
      paste: (c) => pasteTask(c.snapshot, afterId, { sectionId: openSection() }),
      pasteText: (text) => pasteText(text, afterId),
    };
    if (!task) return { kind: null, id: null, label: 'Tasks', el: null, ...paste };
    const id = task.id;
    return {
      kind: 'task',
      id,
      label: `Task: ${task.title}`,
      el: rowEl,
      ...paste,
      copy: () => {
        const t = findTask(id);
        return t ? { kind: 'task', snapshot: taskSnapshot(t), text: t.title } : null;
      },
      remove: () => deleteTask(id),
      duplicate: () => duplicateTask(id),
    };
  }

  async function clearCompleted() {
    const n = getState().items.filter((t) => t.done).length;
    if (!n) return;
    const ok = await confirmDialog({
      title: 'Clear completed tasks?',
      message: `${plural(n, 'completed task')} will be removed. You can undo right after.`,
      confirmLabel: 'Clear completed',
    });
    if (!ok) return;
    const s = getState();
    const doneIds = s.items.filter((t) => t.done).map((t) => t.id);
    if (!doneIds.length) return;
    doneIds.forEach(dropLinger);
    const { items, snapshots } = removeTasks(s.items, doneIds);
    commit({ ...s, items });
    toast(`${plural(doneIds.length, 'completed task')} cleared.`, {
      duration: 6000,
      action: { label: 'Undo', onClick: () => setItems((cur) => restoreTasks(cur, snapshots)) },
    });
  }

  /** tasksApi.reveal(): show the requested task (switching filter if it is hidden), scroll to it, focus and flash it. */
  function revealPending() {
    const id = takePendingReveal();
    const task = id ? findTask(id) : null;
    if (!task) return;
    if (editingId) commitEdit();
    if (drag) cancelDrag();
    if (!rows.get(id)?.row.isConnected) {
      settleLinger();
      if (!task.done) setView({ filter: 'all' });
      else if (getState().view.filter !== 'done') setView({ filter: 'all', completedOpen: true });
      render();
    }
    const r = rows.get(id);
    if (!r?.row.isConnected) return;
    r.row.scrollIntoView({ block: 'center' });
    r.row.focus({ preventScroll: true });
    bump(r.row, 'tk-row--enter');
  }

  function moveByKeyboard(id, delta, repeat = false) {
    const { view } = getState();
    if (view.sort !== 'manual' || view.filter === 'done') {
      if (repeat) return; // one explanation per press, not one per auto-repeat
      toast(view.filter === 'done' ? 'Completed tasks keep their completion order.' : 'Switch to Manual sort to reorder.', {
        action: view.filter === 'done' ? undefined : { label: 'Manual', onClick: () => setView({ sort: 'manual' }) },
      });
      return;
    }
    const from = mainIds.indexOf(id);
    if (from === -1) {
      if (!repeat) toast('Completed tasks keep their completion order.');
      return;
    }
    setItems((items) => moveTo(items, id, mainIds, from + delta));
    rows.get(id)?.row.focus();
  }

  /* ---- inline edit ---- */

  function startEdit(id) {
    const task = findTask(id);
    const r = rows.get(id);
    if (!task || !r || drag) return;
    if (editingId === id) {
      r.input?.focus();
      return;
    }
    if (editingId) commitEdit();
    editingId = id;
    const input = h('input', {
      class: 'tk-edit-input',
      type: 'text',
      value: task.title,
      'aria-label': 'Task title',
      autocomplete: 'off',
      maxlength: '500',
      onKeydown: (e) => {
        if (isComposing(e)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commitEdit({ refocus: true });
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancelEdit({ refocus: true });
        }
      },
      // A re-render can briefly detach the row (some browsers fire blur on that);
      // restoreFocus() puts the caret back, so only a real blur commits.
      onBlur: () => {
        if (!rendering) commitEdit();
      },
    });
    r.input = input;
    r.row.classList.add('is-editing');
    r.titleWrap.replaceChildren(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function endEdit(id, refocus) {
    const r = rows.get(id);
    if (!r) return '';
    const value = r.input ? r.input.value : '';
    r.input = null;
    r.sig = ''; // force a fresh paint of the title
    r.row.classList.remove('is-editing');
    r.title.textContent = findTask(id)?.title ?? r.title.textContent;
    r.titleWrap.replaceChildren(r.title);
    if (refocus) r.row.focus();
    return value;
  }

  function commitEdit({ refocus = false } = {}) {
    if (!editingId) return;
    const id = editingId;
    editingId = null; // first: removing the input fires blur, which re-enters here
    const value = cleanTitle(endEdit(id, refocus));
    const task = findTask(id);
    if (!task) return;
    if (!value) deleteTask(id);
    else if (value !== task.title) setItems((items) => updateTask(items, id, { title: value }));
  }

  function cancelEdit({ refocus = false } = {}) {
    if (!editingId) return;
    const id = editingId;
    editingId = null;
    endEdit(id, refocus);
  }

  /* ---- details modal ---- */

  function openDetails(id) {
    const task = findTask(id);
    if (!task) return;
    if (editingId) commitEdit();

    const titleIn = h('input', { class: 'input tk-field-title', id: 'tk-d-title', type: 'text', value: task.title, maxlength: '500', autocomplete: 'off', 'aria-describedby': 'tk-d-err' });
    const notesIn = h('textarea', { class: 'textarea tk-field-notes', id: 'tk-d-notes', rows: '6', placeholder: 'Context, links, sub-steps…' });
    notesIn.value = task.notes;
    const pri = priorityPicker(task.priority);
    const due = duePicker(task.due, { extended: true });
    // Optional time of day: the calendar then shows the task on its timeline
    const timeIn = h('input', { class: 'input tk-field-time', id: 'tk-d-time', type: 'time', step: '300', value: task.time ?? '' });
    const lengthSel = h(
      'select',
      { class: 'select tk-field-length', id: 'tk-d-length', 'aria-label': 'How long' },
      [15, 30, 45, 60, 90, 120, 180, 240].map((n) => h('option', { value: String(n) }, n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}`)),
    );
    const length = task.minutes ?? DEFAULT_TASK_MINUTES;
    // A length set by dragging on the calendar (say 75 min) gets its own option
    if (![...lengthSel.options].some((o) => o.value === String(length))) lengthSel.append(h('option', { value: String(length) }, `${length} min`));
    lengthSel.value = String(length);
    const timeHint = h('p', { class: 'tk-field-hint label' });
    const paintTime = () => {
      const hasDate = !!due.get();
      timeIn.disabled = !hasDate;
      lengthSel.disabled = !hasDate || !timeIn.value;
      timeHint.textContent = hasDate ? (timeIn.value ? 'Shown at this time in the Calendar.' : 'Optional: a time puts it on the Calendar’s timeline.') : 'Pick a due date first.';
    };
    timeIn.addEventListener('input', paintTime);
    // The due picker has no change hook: re-check after any click or edit in it
    due.el.addEventListener('click', () => setTimeout(paintTime));
    due.el.addEventListener('change', () => setTimeout(paintTime));
    paintTime();
    const { sections } = getState();
    const secSel = sections.length
      ? h('select', { class: 'select tk-field-section', id: 'tk-d-section' }, h('option', { value: '' }, 'No section'), sections.map((sec) => h('option', { value: sec.id }, sec.name)))
      : null;
    if (secSel) secSel.value = task.sectionId ?? '';
    const err = h('p', { class: 'tk-field-error label', id: 'tk-d-err', hidden: true }, 'A task needs a title');

    const created = `Created ${formatDay(dateKey(new Date(task.createdAt)))}`;
    const meta = h('p', { class: 'label tk-detail-meta' }, task.done && task.completedAt ? `${created} · Completed ${timeAgo(task.completedAt)}` : created);

    const save = () => {
      const title = cleanTitle(titleIn.value);
      if (!title) {
        err.hidden = false;
        titleIn.setAttribute('aria-invalid', 'true');
        titleIn.focus();
        return;
      }
      if (!findTask(id)) {
        m.close();
        toast('That task no longer exists.');
        return;
      }
      // A section deleted while the dialog was open counts as none
      const sectionId = secSel && getState().sections.some((sec) => sec.id === secSel.value) ? secSel.value : null;
      const time = due.get() && isTimeOfDay(timeIn.value) ? timeIn.value : null;
      setItems((items) => updateTask(items, id, { title, notes: notesIn.value.replace(/\s+$/, ''), priority: pri.get(), due: due.get(), time, minutes: Number(lengthSel.value), ...(secSel ? { sectionId } : {}) }));
      m.close();
    };

    titleIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isComposing(e)) {
        e.preventDefault();
        save();
      }
    });
    titleIn.addEventListener('input', () => {
      if (err.hidden) return;
      err.hidden = true;
      titleIn.removeAttribute('aria-invalid');
    });

    const body = [
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'tk-d-title' }, 'Title'), titleIn, err),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'tk-d-notes' }, 'Notes'), notesIn),
      h(
        'div',
        { class: 'tk-detail-grid' },
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Priority'), pri.el),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Due'), due.el),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'tk-d-time' }, 'Time'), h('div', { class: 'tk-time-row' }, timeIn, lengthSel), timeHint),
        secSel ? h('div', { class: 'field' }, h('label', { class: 'label', for: 'tk-d-section' }, 'Section'), secSel) : null,
      ),
      h('div', { class: 'tk-detail-foot' }, meta, h('span', { class: 'tk-detail-keys label lo-hint' }, kbd(MOD_KEY), kbd('⏎'), 'Save')),
    ];
    const footer = [
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--danger tk-modal-delete',
          onClick: () => {
            m.close();
            deleteTask(id);
          },
        },
        icon('trash', { size: 14 }),
        'Delete',
      ),
      h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, 'Save'),
    ];

    const m = openModal({
      title: 'Task details',
      body,
      footer,
      size: 'lg',
      initialFocus: titleIn,
      onClose: () => {
        if (detailsModal === m) detailsModal = null;
      },
    });
    m.el.classList.add('tk-modal');
    m.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isComposing(e)) {
        e.preventDefault();
        save();
      }
    });
    detailsModal = m;
  }

  /* ==========================================================================
     Drag to reorder (pointer events: mouse, pen and touch)
     ========================================================================== */

  const scroller = () => root.closest('.main') ?? document.scrollingElement;

  function startDrag(e, id) {
    if (drag || e.button !== 0) return;
    const r = rows.get(id);
    if (!r || !r.row.classList.contains('is-draggable') || r.row.parentElement !== mainList) return;
    e.preventDefault();
    const grip = e.currentTarget;
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety; window listeners below track the pointer either way
    }
    drag = { id, row: r.row, grip, pointerId: e.pointerId, startY: e.clientY, y: e.clientY, active: false, raf: 0, scrollEl: scroller() };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', cancelDrag);
    // Alt-tab / a system dialog mid-drag never delivers pointerup: don't leave the row stuck
    window.addEventListener('blur', onDragBlur);
  }

  function onDragBlur() {
    cancelDrag();
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      activateDrag();
    }
    positionDrag();
    autoScroll();
  }

  function activateDrag() {
    if (editingId) commitEdit();
    const { row } = drag;
    const listRect = mainList.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    drag.active = true;
    drag.offset = drag.startY - rowRect.top;
    drag.height = rowRect.height;
    drag.placeholder = h('li', { class: 'tk-placeholder', 'aria-hidden': 'true', style: { height: `${rowRect.height}px` } });
    row.before(drag.placeholder);
    row.classList.add('is-dragging');
    row.style.width = `${rowRect.width}px`;
    row.style.top = `${rowRect.top - listRect.top}px`;
    root.classList.add('tk-is-sorting');
    drag.scrollEl.addEventListener('scroll', positionDrag, { passive: true });
  }

  function nextSlot(el) {
    let n = el.nextElementSibling;
    while (n === drag.row) n = n.nextElementSibling;
    return n;
  }

  function positionDrag() {
    if (!drag?.active) return;
    const { row, placeholder, offset, height } = drag;
    const listRect = mainList.getBoundingClientRect();
    const top = clamp(drag.y - offset - listRect.top, -height / 2, listRect.height - height / 2);
    row.style.top = `${top}px`;
    // Drop slot: before the first row whose midpoint sits below the dragged row's centre
    const center = listRect.top + top + height / 2;
    let before = null;
    for (const el of mainList.children) {
      if (el === row || el === placeholder) continue;
      const rect = el.getBoundingClientRect();
      if (center < rect.top + rect.height / 2) {
        before = el;
        break;
      }
    }
    if (nextSlot(placeholder) !== before) mainList.insertBefore(placeholder, before);
  }

  function autoScroll() {
    if (!drag?.active || drag.raf) return;
    const step = () => {
      if (!drag?.active) return;
      drag.raf = 0;
      const el = drag.scrollEl;
      const rect = el === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : el.getBoundingClientRect();
      const edge = 56;
      let dy = 0;
      if (drag.y < rect.top + edge) dy = -Math.ceil((rect.top + edge - drag.y) / 4);
      else if (drag.y > rect.bottom - edge) dy = Math.ceil((drag.y - (rect.bottom - edge)) / 4);
      if (!dy) return;
      el.scrollBy({ top: dy, behavior: 'instant' });
      positionDrag();
      drag.raf = requestAnimationFrame(step);
    };
    drag.raf = requestAnimationFrame(step);
  }

  function releaseDrag(d) {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', cancelDrag);
    window.removeEventListener('blur', onDragBlur);
    if (d.grip.hasPointerCapture?.(d.pointerId)) d.grip.releasePointerCapture(d.pointerId);
    cancelAnimationFrame(d.raf);
    d.scrollEl.removeEventListener('scroll', positionDrag);
    root.classList.remove('tk-is-sorting');
    d.row.classList.remove('is-dragging');
    d.row.style.width = '';
    d.row.style.top = '';
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    releaseDrag(d);
    if (!d.active) {
      render();
      return;
    }
    const toIndex = [...mainList.children].filter((el) => el !== d.row).indexOf(d.placeholder);
    d.placeholder.replaceWith(d.row);
    const changed = toIndex !== -1 && setItems((items) => moveTo(items, d.id, mainIds, toIndex));
    if (!changed) render();
    d.row.focus({ preventScroll: true });
  }

  function cancelDrag(e) {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    const d = drag;
    drag = null;
    releaseDrag(d);
    d.placeholder?.remove();
    render();
  }

  /* ==========================================================================
     Keyboard
     ========================================================================== */

  function onRowKeydown(e) {
    const rowEl = e.target.closest?.('.tk-row');
    if (!rowEl || e.target.classList.contains('tk-edit-input')) return;
    const id = rowEl.dataset.id;
    const task = findTask(id);
    if (!task) return;

    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!drag) moveByKeyboard(id, e.key === 'ArrowUp' ? -1 : 1, e.repeat);
      return;
    }
    if (e.target !== rowEl || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.repeat && ONCE_KEYS.has(e.key)) {
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case 'Enter':
      case 'F2':
        e.preventDefault();
        startEdit(id);
        break;
      case ' ':
      case 'x':
      case 'X':
        e.preventDefault();
        toggleDone(id, !task.done);
        break;
      case 'e':
      case 'E':
        e.preventDefault();
        openDetails(id);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        deleteTask(id);
        break;
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        focusSibling(rowEl, 1);
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        focusSibling(rowEl, -1);
        break;
      case 'Home':
        e.preventDefault();
        root.querySelector('.tk-row')?.focus();
        break;
      case 'End': {
        e.preventDefault();
        const all = root.querySelectorAll('.tk-row');
        all[all.length - 1]?.focus();
        break;
      }
      default:
    }
  }

  function focusSibling(rowEl, delta) {
    const all = [...root.querySelectorAll('.tk-row')];
    const i = all.indexOf(rowEl) + delta;
    if (i < 0) addInput.focus();
    else all[Math.min(i, all.length - 1)]?.focus();
  }

  function onDocKeydown(e) {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      cancelDrag();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
    if (e.key === 'n' || e.key === 'N' || e.key === '/') {
      e.preventDefault();
      focusAdd();
    }
  }

  /* ==========================================================================
     Wiring
     ========================================================================== */

  document.addEventListener('keydown', onDocKeydown);
  const offMenu = registerContextProvider('tasks', contextTarget);
  const unsubscribe = store.subscribe(() => render());
  const offDay = onDayChange(() => {
    duePick.refresh();
    readoutKey = '';
    renderReadout();
    render();
  });
  const minuteTimer = setInterval(render, 60000); // keeps "Done 5m ago" honest

  renderReadout();
  render();

  // Reveal once the view has laid out (it may arrive with this mount, or while it is open)
  let revealFrame = 0;
  const queueReveal = () => {
    cancelAnimationFrame(revealFrame);
    revealFrame = requestAnimationFrame(revealPending);
  };
  revealInView = queueReveal;
  if (pendingReveal) queueReveal();

  return () => {
    if (revealInView === queueReveal) revealInView = null;
    cancelAnimationFrame(revealFrame);
    if (editingId) commitEdit();
    if (drag) cancelDrag();
    settleLinger();
    offMenu();
    unsubscribe();
    offDay();
    clearInterval(minuteTimer);
    clearTimeout(swapTimer);
    document.removeEventListener('keydown', onDocKeydown);
    root.removeEventListener('keydown', onRowKeydown);
    detailsModal?.close();
  };
}

/* ==========================================================================
   Cross-module API (the Calendar plans with tasks). Every write goes through the
   same pure mutations and commit() as the Tasks view: normalized, persisted and
   picked up by other tabs. Readers get frozen copies, so nothing outside this
   module can edit a task in place.
   ========================================================================== */

const API_TITLE_MAX = TITLE_MAX;

const freezeTask = (t) => Object.freeze({ ...t });

let apiMemo = { items: null, frozen: Object.freeze([]) };

/** Every task (open and done) in manual order; the same array until the tasks change. */
function apiGetItems() {
  const { items } = getState();
  if (apiMemo.items !== items) apiMemo = { items, frozen: Object.freeze(items.map(freezeTask)) };
  return apiMemo.frozen;
}

/** fn() after the tasks change (here or in another tab). Filter / sort changes made in the Tasks view don't fire it. */
function apiSubscribe(fn) {
  let last = getState().items;
  return store.subscribe(() => {
    const { items } = getState();
    if (items === last) return;
    last = items;
    fn();
  });
}

/** Set ('YYYY-MM-DD') or clear (null) a due date; every other field stays. True when it changed. */
function apiSetDue(id, key) {
  if (key !== null && !isDateKey(key)) return false;
  const task = findTask(id);
  if (!task || task.due === key) return false;
  return setItems((items) => updateTask(items, id, { due: key }));
}

/**
 * When a task happens: { due, time, minutes } (any of them; time null = the whole day). The
 * calendar's timeline drags use it. True when something changed.
 */
function apiSetSchedule(id, { due, time, minutes } = {}) {
  if (due !== undefined && due !== null && !isDateKey(due)) return false;
  if (time !== undefined && time !== null && !isTimeOfDay(time)) return false;
  const task = findTask(id);
  if (!task) return false;
  const patch = {};
  if (due !== undefined) patch.due = due;
  if (time !== undefined) patch.time = time;
  if (minutes !== undefined) patch.minutes = minutes;
  return setItems((items) => {
    const next = updateTask(items, id, patch);
    const a = items.find((t) => t.id === id);
    const b = next.find((t) => t.id === id);
    return a.due === b.due && a.time === b.time && a.minutes === b.minutes ? items : next;
  });
}

/** Complete / reopen with the Tasks view's bookkeeping (completedAt set / cleared). True when it changed. */
function apiSetDone(id, done) {
  if (typeof done !== 'boolean') return false;
  const task = findTask(id);
  if (!task || task.done === done) return false;
  return setItems((items) => toggleTask(items, id, done));
}

/** Quick-add without the tokens: the title is taken literally. Lands at the top of the manual order. */
function apiAddTask({ title, due = null, priority = 'none', notes = '' } = {}) {
  const clean = typeof title === 'string' ? cleanTitle(cleanTitle(title).slice(0, API_TITLE_MAX)) : '';
  if (!clean) return null;
  const task = createTask({ title: clean, due, priority, notes });
  setItems((items) => addTask(items, task));
  return freezeTask(findTask(task.id) ?? task);
}

/** Open the Tasks page with this task in view, focused and flashed. False when there is no such task. */
function apiReveal(id) {
  if (!findTask(id)) return false;
  pendingReveal = { id, at: Date.now() };
  if (revealInView) revealInView();
  else location.hash = '#/tasks';
  return true;
}

/** What a copy of the task carries ({ title, notes, priority, due }), for the right-click menu. Null when there is no such task. */
function apiSnapshot(id) {
  const task = findTask(id);
  return task ? taskSnapshot(task) : null;
}

/** Paste / duplicate: a new task from a snapshot after `afterId` (top without one); `due` overrides the snapshot's. -> frozen task | null */
function apiInsertCopy(snap, { afterId = null, due } = {}) {
  if (due !== undefined && due !== null && !isDateKey(due)) return null;
  const task = insertCopy(snap, { afterId, due });
  return task ? freezeTask(task) : null;
}

/** Undo of apiInsertCopy: removes the task only while it is unchanged (else it says why). True when removed. */
function apiRemoveCopy(task) {
  return removeCopy(task);
}

/** Delete with the Tasks page's Undo toast. True when the task existed. */
function apiRemove(id) {
  return deleteWithUndo(id);
}

function takePendingReveal() {
  const p = pendingReveal;
  pendingReveal = null;
  return p && Date.now() - p.at < REVEAL_TTL_MS ? p.id : null;
}

export const tasksApi = Object.freeze({
  getItems: apiGetItems,
  subscribe: apiSubscribe,
  setDue: apiSetDue,
  setSchedule: apiSetSchedule,
  setDone: apiSetDone,
  addTask: apiAddTask,
  reveal: apiReveal,
  snapshot: apiSnapshot,
  insertCopy: apiInsertCopy,
  removeCopy: apiRemoveCopy,
  remove: apiRemove,
});

export default {
  id: 'tasks',
  title: 'Tasks',
  icon: 'list',
  badge() {
    const n = openCount(getState().items);
    return n ? String(n) : '';
  },
  mount,
};
