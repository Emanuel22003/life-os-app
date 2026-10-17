// LIFE/OS — 04 // Calendar: month, week and day views over events, tasks and habits.
//
// - Events live in the calendar's own store (calendar.store.js). Tasks and habits are read
//   live from tasksApi / habitsApi and written only through them (same rules as their pages).
// - The shown period (cursor + zoom level) belongs to this window: it is kept in memory for
//   the session, starts at today, and another tab never moves it. The zoom level is also
//   saved as the store's `view` for the next visit; layer toggles are saved and shared.
// - Views are built by calendar.views.js; this file owns state, rendering, every click / key /
//   drag (by delegation), the zoom transitions and the timelines' fit to the screen (the hour
//   height that shows the whole day without scrolling).
// - Which day-plan lists are open is a preference of this device ('calendar-prefs', not synced).

import { h, icon, pageHeader, term, toast, openModal, isTyping, modalOpen, menuOpen, todayKey, onDayChange, debounce, weekday, uid, MONTHS_SHORT, reducedMotion, plainSkin, promptDialog, dropdown, tip, tipHidden } from '../ui.js';
import { createStore } from '../store.js';
import { tasksApi } from './tasks.js';
import { habitsApi } from './habits.js';
import * as L from './calendar.logic.js';
import { getCalendar, getEvents, getEvent, saveEvent, replaceEvents, setView as saveView, setLayer, subscribeCalendar, isNewerFormat, getDayColors, setDayColor } from './calendar.store.js';
import { openEventEditor, askScope, deleteEvent, NEWER_COPY, SPLIT_NOTE } from './calendar.editor.js';
import { monthView, weekView, dayView, agendaView, trayView, legend, fillEdges, priorityBadge } from './calendar.views.js';
import { parseQuickAdd } from './tasks.logic.js';
import { undoToast, undoLast, snapshot, revertEvents } from './calendar.undo.js';
import { trackPointer, dropTargetAt, ghostOf, edgeScroller, cancelDrag, isDragging } from './calendar.drag.js';
import { registerContextProvider } from '../contextmenu.js';
import { clipText, slotMinute } from '../contextmenu.logic.js';

const DEPTH = { month: 0, week: 1, day: 2 };
// The Show menu: each layer with the app's own icon for it (L.LAYER_ICON), so it reads at a glance
const LAYER_UI = [
  { id: 'events', label: 'Events' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'habits', label: 'Habits' },
  { id: 'completed', label: 'Done' },
];

const PHONE_QUERY = '(max-width: 640px)';
// The day view puts its Tasks / Habits lists under the timeline below this calendar width
// (calendar.css); wider, they are a side column
const STACK_W = 620;
const HOUR_H = 48;
const HOUR_H_PHONE = 44;
// Fitting a timeline to the screen: the readable floor and the ceiling of an hour (px), the room
// above the first hour line and below the last (half each), and the margin kept at the bottom
const FIT = Object.freeze({ min: 18, max: 96, pad: 18, margin: 12 });

// View preferences of this device (never synced): which day-plan lists are open
const prefs = createStore('calendar-prefs', { dayPanels: null });

const clip = (s, n = 36) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortDay = (key) => L.viewTitle('day', key, { short: true });
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

// Per-window view state: survives route changes, never synced across tabs
let memCursor = null;
let memView = null;
let memTrayOpen = false;
let openInView = null; // set while the Calendar view is mounted (calendarApi.open)

const isDayKey = (k) => {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/**
 * For Home: show the Calendar on `key` ('YYYY-MM-DD') in `view` ('day' by default, 'week',
 * 'month'). Like zooming in this window; the saved default view is left alone. False when the
 * day or view is not valid.
 */
function apiOpen(key, view = 'day') {
  if (!L.VIEWS.includes(view) || !isDayKey(key)) return false;
  if (openInView) {
    openInView(view, key);
    return true;
  }
  memView = view;
  memCursor = key;
  location.hash = '#/calendar';
  return true;
}

export const calendarApi = Object.freeze({ open: apiOpen });

/* ==========================================================================
   Nav badge: events today
   ========================================================================== */

let badgeMemo = { events: null, today: '', value: '' };

function badge() {
  const events = getEvents();
  const today = todayKey();
  if (events !== badgeMemo.events || today !== badgeMemo.today) {
    const n = L.occurrencesOn(events, today).length;
    badgeMemo = { events, today, value: n ? String(n) : '' };
  }
  return badgeMemo.value;
}

/* ==========================================================================
   Event writes: one atomic store write each, with Undo that reverts only those ids
   ========================================================================== */

/** One store write; Undo puts those events back unless one of them changed since. */
function commitEvents({ save = [], remove = [] }, message, what) {
  const ids = [...new Set([...remove, ...save.map((e) => e.id)])];
  const before = snapshot(ids);
  const list = getEvents().filter((e) => !remove.includes(e.id));
  for (const ev of save) {
    const i = list.findIndex((e) => e.id === ev.id);
    if (i >= 0) list[i] = ev;
    else list.push(ev);
  }
  if (!replaceEvents(list)) return false;
  if (message) {
    const after = snapshot(ids);
    undoToast(message, () => revertEvents(before, after, what));
  }
  return true;
}

const refuse = (message) => {
  toast(message);
  return false;
};

/** Where a drag put an occurrence, in words: 'Thu 8 Oct, 09:00' · 'Thu 8 Oct' · '09:00–10:30'. */
function whereTo(changes) {
  if (!changes.start) return `${changes.startTime}–${changes.endTime}`;
  return changes.startTime ? `${shortDay(changes.start)}, ${changes.startTime}` : shortDay(changes.start);
}

/** Apply `changes` to one occurrence (drag move / resize). Repeating events ask which dates change. */
async function changeOccurrence(occ, changes, verb) {
  const ev = getEvent(occ.eventId);
  if (!ev) return false;
  if (isNewerFormat(ev.id)) return refuse(NEWER_COPY);
  const name = clip(ev.title);
  const what = `“${name}”`;
  if (!ev.repeat) {
    const r = L.updateEvent(ev, changes);
    if (r.error) return refuse(r.error);
    return commitEvents({ save: [r.event] }, `${verb} ${what} to ${whereTo(changes)}`, what);
  }
  // Every-N-weeks rules can't always move as a whole (shiftFits); "following" needs an earlier date
  const fits = L.shiftFits(ev, changes.start ? L.daysBetween(occ.start, changes.start) : 0);
  const options = ['only'];
  if (fits && L.hasOccurrenceBefore(ev, occ.start)) options.push('following');
  if (fits) options.push('all');
  const scope = await askScope({ mode: 'save', key: occ.start, title: ev.title, options, note: fits ? '' : SPLIT_NOTE });
  // Re-read: another tab may have changed the series while the question was open
  const fresh = getEvent(occ.eventId);
  if (!scope || !fresh) return false;
  if (isNewerFormat(fresh.id)) return refuse(NEWER_COPY);
  if (!fresh.repeat || !L.occursOn(fresh, occ.start)) return refuse('That date is no longer part of the series, so nothing changed.');
  if (scope === 'only') {
    const r = L.detachOccurrence(fresh, occ.start, changes);
    if (r.error) return refuse(r.error);
    return commitEvents({ save: [r.series, r.single] }, `${verb} ${what} on ${shortDay(occ.start)} to ${whereTo(changes)}`, what);
  }
  if (scope === 'following') {
    const r = L.splitSeries(fresh, occ.start, changes);
    if (r.error) return refuse(r.error);
    return commitEvents(r.series ? { save: [r.series, r.next] } : { save: [r.next], remove: [fresh.id] }, `${verb} ${what} from ${shortDay(occ.start)} on`, what);
  }
  const r = L.updateSeries(fresh, occ.start, changes);
  if (r.error) return refuse(r.error);
  return commitEvents({ save: [r.event] }, `${verb} every ${what}`, what);
}

/* ==========================================================================
   Tasks: due-date changes with Undo, the schedule sheet, the add-task dialog
   ========================================================================== */

const findTask = (id) => tasksApi.getItems().find((t) => t.id === id) ?? null;

function applyDue(id, key) {
  const task = findTask(id);
  if (!task) return false;
  const prev = task.due;
  if (!tasksApi.setDue(id, key)) return false;
  const what = `“${clip(task.title)}”`;
  undoToast(key ? `${what} ${prev ? 'moved' : 'scheduled'} to ${shortDay(key)}` : `${what} unscheduled`, () => {
    // Undo only this change: a date set again since (here or in Tasks) stays
    if (findTask(id)?.due !== key) return refuse(`Nothing undone: ${what} changed since.`);
    tasksApi.setDue(id, prev);
    return true;
  });
  return true;
}

/** Change when a task happens ({ due, time, minutes }), with Undo. */
function applySchedule(id, next) {
  const task = findTask(id);
  if (!task) return false;
  const prev = { due: task.due, time: task.time ?? null, minutes: task.minutes ?? null };
  if (!tasksApi.setSchedule(id, next)) return false;
  const now = findTask(id);
  const what = `“${clip(task.title)}”`;
  const when = !now?.due
    ? 'unscheduled'
    : now.time
      ? `${shortDay(now.due)}, ${now.time}–${L.formatTime(L.parseTime(now.time) + (now.minutes || 30))}`
      : `${shortDay(now.due)}, all day`;
  undoToast(`${what} ${when}`, () => {
    const cur = findTask(id);
    if (!cur || cur.due !== now?.due || (cur.time ?? null) !== (now?.time ?? null) || (cur.minutes ?? null) !== (now?.minutes ?? null)) return refuse(`Nothing undone: ${what} changed since.`);
    tasksApi.setSchedule(id, prev);
    return true;
  });
  return true;
}

function toggleTaskDone(id) {
  const task = findTask(id);
  if (!task) return;
  const done = !task.done;
  if (!tasksApi.setDone(id, done)) return;
  const what = `“${clip(task.title)}”`;
  undoToast(done ? `Done: ${what}` : `Reopened ${what}`, () => {
    if (findTask(id)?.done !== done) return refuse(`Nothing undone: ${what} changed since.`);
    tasksApi.setDone(id, !done);
    return true;
  });
}

function nextMonday(today) {
  return L.shiftDays(today, (8 - weekday(today)) % 7 || 7);
}

/** Schedule… sheet for one task: quick dates, a date field, done toggle, open in Tasks. */
async function renameTaskPrompt(task) {
  const title = await promptDialog({ title: 'Rename task', value: task.title, maxLength: 500 });
  if (title !== null) tasksApi.rename(task.id, title);
}

function openTaskSheet(id, cursor, onClose) {
  const task = findTask(id);
  if (!task) return;
  const today = todayKey();
  const tomorrow = L.shiftDays(today, 1);
  const choices = [
    ['Today', today],
    ['Tomorrow', tomorrow],
    cursor !== today && cursor !== tomorrow ? [shortDay(cursor), cursor] : null,
    ['Next Monday', nextMonday(today)],
  ].filter(Boolean);
  /** A label with its icon in front (a date is a calendar, a time a clock). */
  const lab = (iconName, text, id) => h('label', { class: 'label cal-lab', for: id }, icon(iconName, { size: 13 }), h('span', null, text));
  let m;
  const set = (key) => {
    m.close();
    if (task.due !== key) applyDue(id, key);
  };
  const dateId = `cal-sheet-date-${id}`;
  const dateIn = h('input', { type: 'date', class: 'input', id: dateId, value: task.due ?? cursor, min: '1970-01-01', max: '9999-12-31' });
  // Optional time of day: the task then sits on the timeline at that time
  const timeId = `cal-sheet-time-${id}`;
  const timeIn = h('input', { type: 'time', class: 'input', id: timeId, step: '300', value: task.time ?? '' });
  const length = task.minutes ?? 30;
  const lengthSel = h(
    'select',
    { class: 'select', 'aria-label': 'How long' },
    [...new Set([15, 30, 45, 60, 90, 120, 180, 240, length])].sort((a, b) => a - b).map((n) => h('option', { value: String(n) }, n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}`)),
  );
  lengthSel.value = String(length);
  const setWhen = () => {
    if (!dateIn.value) return;
    m.close();
    applySchedule(id, { due: dateIn.value, time: timeIn.value || null, minutes: Number(lengthSel.value) });
  };
  const quick = h(
    'div',
    { class: 'cal-sheet-quick', role: 'group', 'aria-label': 'Quick dates' },
    // Each day with its icon (☀ today, sunrise tomorrow, a calendar for later; no date: ⊘)
    // A day named by a word also shows its date ("Tomorrow 18 Oct"; phones leave it out)
    choices.map(([label, key]) =>
      h(
        'button',
        { type: 'button', class: ['btn btn--sm', task.due === key && 'is-current'], 'aria-pressed': String(task.due === key), title: L.viewTitle('day', key), onClick: () => set(key) },
        icon(L.dayIcon(key, today), { size: 14 }),
        h('span', { class: 'cal-sheet-word' }, label),
        label === shortDay(key) ? null : h('span', { class: 'cal-sheet-date label tnum' }, `${Number(key.slice(8))} ${MONTHS_SHORT[Number(key.slice(5, 7)) - 1]}`),
      ),
    ),
    task.due ? h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onClick: () => set(null) }, icon('circle-slash', { size: 14 }), h('span', null, 'No date')) : null,
  );
  const setBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--primary',
      onClick: (e) => {
        e.preventDefault();
        setWhen();
      },
    },
    'Set',
  );
  const pri = priorityBadge(task.priority, { hidden: false, flag: true });
  const late = L.dueIcon(task, today) === 'alert';
  m = openModal({
    title: task.due ? 'Reschedule task' : 'Schedule task',
    className: 'cal-sheet',
    body: [
      h('div', { class: 'cal-sheet-task' }, h('span', { class: ['cal-sheet-box', task.done && 'is-done'], 'aria-hidden': 'true' }), h('span', { class: 'cal-sheet-title cal-wrap' }, task.title), pri),
      // Its due day with the day's icon; a late one says so, in the alert color (⚠ Overdue: …)
      h(
        'p',
        { class: ['label cal-lab cal-sheet-due', late && 'is-alert'] },
        icon(L.dueIcon(task, today), { size: 13 }),
        h('span', null, task.due ? `${late ? 'Overdue: was due' : 'Due'} ${L.viewTitle('day', task.due)}${task.time ? `, ${task.time}` : ''}` : 'No due date yet'),
      ),
      quick,
      h(
        'form',
        {
          class: 'cal-sheet-pick',
          onSubmit: (e) => {
            e.preventDefault();
            setWhen();
          },
        },
        lab('calendar', 'Pick a date', dateId),
        dateIn,
        lab('clock', 'Time (optional)', timeId),
        h('div', { class: 'cal-sheet-time' }, timeIn, lengthSel),
        h('button', { type: 'submit', hidden: true, tabindex: '-1' }),
      ),
    ],
    footer: [
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost',
          onClick: () => {
            m.close();
            tasksApi.reveal(id);
          },
        },
        'Open in Tasks',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onClick: () => {
            m.close();
            toggleTaskDone(id);
          },
        },
        task.done ? 'Reopen' : 'Mark done',
      ),
      setBtn,
    ],
    initialFocus: dateIn,
    onClose,
  });
}

/** Header "Add task": a title, a priority and the selected day as due date. */
function openAddTask(day, onClose) {
  let priority = 'none';
  let m;
  const input = h('input', { class: 'input', type: 'text', maxlength: '500', placeholder: 'What needs doing?', 'aria-label': 'Task title', autocomplete: 'off' });
  const dateIn = h('input', { type: 'date', class: 'input', value: day, 'aria-label': 'Due date', min: '1970-01-01', max: '9999-12-31' });
  const error = h('p', { class: 'cal-field-error', role: 'alert' });
  const pris = [
    ['none', '—'],
    ['low', 'Low'],
    ['med', 'Med'],
    ['high', 'High'],
  ];
  const priBtns = pris.map(([v, label]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': String(v === priority),
        'aria-label': v === 'none' ? 'No priority' : `${label} priority`,
        onClick: () => {
          priority = v;
          priBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(pris[i][0] === v)));
        },
      },
      label,
    ),
  );
  const submit = () => {
    const title = input.value.trim();
    if (!title) {
      error.textContent = 'Give the task a title.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    const due = dateIn.value || null;
    const task = tasksApi.addTask({ title, due, priority });
    if (!task) return;
    m.close();
    if (!getCalendar().layers.tasks) setLayer('tasks', true);
    toast(`Task added${task.due ? ` for ${shortDay(task.due)}` : ''}`, { action: { label: 'Open', onClick: () => tasksApi.reveal(task.id) } });
  };
  const form = h(
    'form',
    {
      class: 'cal-form',
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
    },
    // Labels with the shared icons: a task, its due date, its priority flag
    h('label', { class: 'field' }, h('span', { class: 'label cal-lab' }, icon(L.LAYER_ICON.tasks, { size: 13 }), 'Task'), input),
    error,
    h(
      'div',
      { class: 'cal-form-row' },
      h('label', { class: 'field' }, h('span', { class: 'label cal-lab' }, icon('calendar', { size: 13 }), 'Due'), dateIn),
      h('div', { class: 'field' }, h('span', { class: 'label cal-lab' }, icon('flag', { size: 13 }), 'Priority'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Priority' }, priBtns)),
    ),
  );
  input.addEventListener('input', () => {
    error.textContent = '';
    input.removeAttribute('aria-invalid');
  });
  m = openModal({
    title: 'Add task',
    className: 'cal-addtask',
    body: form,
    footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn btn--primary', onClick: submit }, 'Add task')],
    initialFocus: input,
    onClose,
  });
}

/* ==========================================================================
   Page
   ========================================================================== */

function mount(root) {
  root.classList.add('cal-page');
  const phoneMq = matchMedia(PHONE_QUERY);
  const coarseMq = matchMedia('(pointer: coarse)');
  const state = {
    view: memView ?? getCalendar().view,
    cursor: memCursor ?? todayKey(),
    today: todayKey(),
    trayOpen: memTrayOpen,
  };
  let bodyView = null; // { kind, el, update?, scroller?, addInput? }
  let rangeShown = ''; // the period the timeline was last scrolled for
  const fitted = {}; // view kind -> the fit last applied to it ({ hourH, height, fits, from })
  let raf = 0;
  let pendingRender = false;
  let pendingFocus = null; // a data-fid to focus after the next render
  let pendingFocusCtx = null; // where focus was when a dialog opened (see returnFocusAfter)
  let lastCtx = null;
  let lastMinute = -1;
  let vt = null;
  let vtFlush = null;
  let flips = [];
  let alive = true; // false after unmount: a late view-transition callback must not write

  const remember = () => {
    memCursor = state.cursor;
    memView = state.view;
    memTrayOpen = state.trayOpen;
  };

  /* ---- header ---- */
  const newBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary cal-new', 'aria-keyshortcuts': 'N', onClick: () => newEvent() },
    icon('plus'),
    h('span', null, 'New event'),
    h('span', { class: 'kbd cal-kbd lo-hint', 'aria-hidden': 'true' }, 'N'),
  );
  // A task's icon (a checked square), the same as the Tasks layer and the day's Tasks row
  const addTaskBtn = h('button', { type: 'button', class: 'btn cal-addtask-btn', onClick: () => openAddTask(state.cursor, returnFocusAfter()) }, icon('check-square'), h('span', null, 'Add task'));
  // The subtitle explains the page: a tip with its own ✓, gone for good once read
  const header = pageHeader({ index: '05', title: 'Calendar', subtitle: term('calendar.subtitle', 'Month, week and day: events, tasks and habits on one timeline.'), actions: [addTaskBtn, newBtn], tipId: 'calendar.intro' });

  /* ---- toolbar ---- */
  // The month first, large (with its year), then the exact week or day: easy to find in every view
  const titleMonth = h('span', { class: 'cal-title-month' });
  const titleYear = h('span', { class: 'cal-title-year' });
  const titleSub = h('span', { class: 'cal-title-sub' });
  const title = h(
    'h2',
    { class: 'cal-title', 'aria-live': 'polite', tabindex: '-1', dataset: { fid: 'title' } },
    h('span', { class: 'cal-title-main' }, titleMonth, ' ', titleYear),
    h('span', { class: 'sr-only' }, ', '),
    titleSub,
  );
  const prevBtn = h('button', { type: 'button', class: 'btn btn--icon btn--sm', onClick: () => step(-1) }, icon('chevron-left'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--icon btn--sm', onClick: () => step(1) }, icon('chevron-right'));
  const todayBtn = h('button', { type: 'button', class: 'btn btn--sm cal-today-btn', 'aria-keyshortcuts': 'T', title: 'Today (T)', onClick: () => goToday() }, icon('sun', { size: 14 }), h('span', null, 'Today'));
  // Each view with its icon: a month is a grid, a week columns, a day rows
  const zoomBtns = new Map(
    L.VIEWS.map((v) => [
      v,
      h(
        'button',
        { type: 'button', class: 'seg-btn cal-zoom-btn', 'aria-keyshortcuts': v[0].toUpperCase(), title: `${L.VIEW_LABEL[v]} view (${v[0].toUpperCase()})`, onClick: () => zoomTo(v) },
        icon(L.VIEW_ICON[v], { size: 14 }),
        h('span', null, L.VIEW_LABEL[v]),
      ),
    ]),
  );
  // A narrow calendar (a phone) picks the view from a menu instead (CSS shows one or the other);
  // its button carries the current view's icon (setViewIcon)
  const viewDd = dropdown({
    icon: L.VIEW_ICON[state.view],
    items: L.VIEWS.map((v) => ({ value: v, label: L.VIEW_LABEL[v], icon: L.VIEW_ICON[v] })),
    value: state.view,
    title: 'View: month, week or day',
    className: 'cal-view-btn',
    onSelect: (v) => {
      // The menu names its button by the picked label alone; keep "View: …" (see updateToolbar)
      viewDd.button.setAttribute('aria-label', `View: ${L.VIEW_LABEL[v]}`);
      zoomTo(v);
    },
  });
  viewDd.el.classList.add('cal-view-dd');
  let viewShown = state.view;
  /** The view menu's button shows the icon of the view on screen. */
  const setViewIcon = (v) => viewDd.button.querySelector('.icon:not(.dd-chev)')?.replaceWith(icon(L.VIEW_ICON[v], { size: 14 }));
  // Events · Tasks · Habits · Done: one menu (each with the period's count), so the toolbar stays one row
  const showDd = dropdown({
    label: 'Show',
    icon: 'eye',
    multi: true,
    items: [],
    title: 'What the calendar shows',
    className: 'cal-show-btn',
    onSelect: (id, on) => setLayer(id, on),
  });
  showDd.el.classList.add('cal-show-dd');
  let showSig = '';
  const trayCount = h('span', { class: 'seg-count tnum' });
  const trayToggle = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--sm cal-tray-toggle',
      'aria-controls': 'cal-tray',
      title: 'Unscheduled tasks',
      onClick: () => {
        state.trayOpen = !state.trayOpen;
        remember();
        // Opening it shows the tray above the calendar: take focus there, not 20 tabs later
        if (state.trayOpen) pendingFocus = 'tray-head';
        render();
      },
    },
    icon('inbox', { size: 14 }),
    h('span', { class: 'cal-tray-word' }, 'Unscheduled'),
    trayCount,
  );
  const toolbar = h(
    'div',
    { class: 'cal-toolbar' },
    h('div', { class: 'cal-nav' }, prevBtn, nextBtn, todayBtn, title),
    h(
      'div',
      { class: 'cal-controls' },
      h('div', { class: 'seg cal-zoom', role: 'group', 'aria-label': 'Zoom' }, [...zoomBtns.values()]),
      viewDd.el,
      showDd.el,
      trayToggle,
    ),
  );
  // Explanations are tips with their own ✓: how to start (while there are no events) and the
  // look key (wide calendars; Simple leaves it out with the other decoration, .lo-deco)
  const legendEl = legend();
  const legendHabits = legendEl.querySelector('.cal-legend-group--hb');
  const legendTip = tip({ id: 'calendar.legend', text: legendEl, className: 'cal-legend-tip lo-deco' });
  let howTip = null;
  const tips = h('div', { class: 'cal-tips' }, legendTip);

  const body = h('div', { class: 'cal-body' });
  const tray = trayView();
  tray.el.id = 'cal-tray';
  const layout = h('div', { class: 'cal-layout' }, body, tray.el);
  const cal = h('div', { class: 'cal' }, toolbar, tips, layout);
  root.append(header, cal);

  /* ---- context for the builders ---- */
  function buildCtx() {
    const calState = getCalendar();
    const layers = calState.layers;
    const phone = phoneMq.matches;
    const today = state.today;
    const range = L.viewRange(state.view, state.cursor);
    const occs = L.occurrencesInRange(calState.events, range.from, range.to);
    const tasks = tasksApi.getItems();
    const dayTasks = new Map();
    const kind = state.view === 'month' ? (phone ? 'month-c' : 'month') : state.view === 'week' ? (phone ? 'agenda' : 'week') : 'day';
    const stacked = isStacked();
    return {
      view: state.view,
      kind,
      cursor: state.cursor,
      today,
      phone,
      coarse: coarseMq.matches,
      // Day view: Tasks / Habits under the timeline (narrow) or beside it, and which are open
      stacked,
      dayPanels: L.normalizeDayPanels(prefs.get().dayPanels)[stacked ? 'narrow' : 'wide'],
      layers,
      range,
      slots: monthSlots(),
      // The last height that fitted this view to the screen (fitTimeline corrects it)
      hourH: fitted[kind]?.hourH ?? (phone ? HOUR_H_PHONE : HOUR_H),
      tlFits: false,
      tlFrom: L.FIT_FROM_HOUR,
      nowMin: nowMinutes(),
      occs,
      occById: new Map(occs.map((o) => [o.occId, o])),
      tasks,
      tasksByDay: L.tasksByDay(tasks, range.from, range.to, { includeCompleted: layers.completed }),
      tasksForDay(key) {
        if (!dayTasks.has(key)) dayTasks.set(key, tasks.filter((t) => t.due === key).sort(L.compareTasks));
        return dayTasks.get(key);
      },
      overdue: L.overdueTasks(tasks, today),
      unscheduled: L.unscheduledTasks(tasks),
      habits: layers.habits ? L.habitsByDay(habitsApi.source.getItems(), range.from, range.to, today) : null,
      events: calState.events,
      eventCount: calState.events.length,
      // Color coding: day colors, and each task section's color (a task without its own shows it)
      dayColors: getDayColors(),
      secColors: tasksApi.sectionColors(),
    };
  }

  /** Color coding: set or clear an event's color (the whole series). */
  function setEventColor(id, color) {
    const ev = getEvent(id);
    if (!ev || isNewerFormat(id)) return;
    if ((ev.color ?? null) === (color ?? null)) return;
    const res = L.updateEvent(ev, { color: color ?? null });
    if (res.event) saveEvent(res.event);
  }

  /** Distance from the top of the scrolled page to `el` (stable while .main scrolls). */
  function pageTop(el) {
    const main = root.closest('.main') ?? document.scrollingElement;
    return el.getBoundingClientRect().top + (main?.scrollTop ?? 0);
  }

  /** Month cells hold as many item rows as the window height allows (2–6). */
  function monthSlots() {
    const rows = L.monthGrid(state.cursor).weeks.length;
    const avail = window.innerHeight - (body.isConnected ? pageTop(body) : 320) - 30 - 32;
    return Math.max(2, Math.min(6, Math.floor((avail / rows - 44) / 20)));
  }

  /** The day view's lists go under its timeline (a phone, a narrow window) rather than beside it. */
  function isStacked() {
    return cal.clientWidth > 0 && cal.clientWidth <= STACK_W;
  }

  /** Where the visible page ends: above the phone's tab bar and a docked timer. */
  function viewportBottom() {
    const main = root.closest('.main');
    let bottom = Math.min(window.innerHeight, main ? main.getBoundingClientRect().bottom : window.innerHeight);
    // On a phone the timer docks over the page, just above the tab bar (css/shell.css)
    const dock = document.querySelector('.shell > .topbar-center');
    if (dock && getComputedStyle(dock).position === 'fixed') {
      const widget = [...dock.children].find((c) => !c.hidden && c.getClientRects().length);
      if (widget) bottom = Math.min(bottom, widget.getBoundingClientRect().top - 8);
    }
    return bottom;
  }

  /** The timed items a timeline shows (visible layers only), for the hours it must fit. */
  function timedItems(ctx, keys) {
    // Today, the current time counts too: late at night or early in the morning the now line stays in view
    const items = keys.includes(ctx.today) ? [{ startMin: ctx.nowMin, endMin: ctx.nowMin }] : [];
    for (const key of keys) {
      if (ctx.layers.events) for (const o of ctx.occs) if (!o.allDay && o.start === key) items.push(o);
      if (!ctx.layers.tasks) continue;
      for (const t of ctx.tasksByDay.get(key) ?? []) {
        const s = t.time ? L.parseTime(t.time) : null;
        if (s !== null) items.push({ startMin: s, endMin: s + (t.minutes || 30) });
      }
    }
    return items;
  }

  /**
   * How the shown timeline fits the screen: its hours (07:00–22:00, or wider for an early or late
   * item) in the room between its top and the bottom of the screen (minus the folded Tasks /
   * Habits rows under a stacked day). -> { hourH, height (of the scroller), fits, from } | null.
   * The day view never goes below FIT.min px an hour (it scrolls instead); the week view keeps its
   * classic 48px hours and scrolls when its working day can't fit at a readable size.
   */
  function measureFit(ctx) {
    const v = bodyView;
    const sc = v?.scroller;
    if (!sc?.isConnected || !sc.getClientRects().length) return null;
    const span = L.timelineSpan(timedItems(ctx, v.keys(ctx)));
    const hours = span.to - span.from;
    const panel = sc.closest('.panel');
    const below = panel ? Math.max(0, panel.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom) : 0;
    let reserve = 0;
    if (v.kind === 'day' && ctx.stacked) {
      const gap = v.panel.getBoundingClientRect().top - (panel ?? sc).getBoundingClientRect().bottom;
      reserve = Math.max(0, gap) + v.foldedHeight();
    }
    const room = viewportBottom() - FIT.margin - pageTop(sc) - below - reserve;
    const fit = L.fitHourHeight(hours, room - FIT.pad, { min: FIT.min, max: FIT.max });
    if (!fit.fits && v.kind === 'week') return { hourH: HOUR_H, height: Math.round(Math.max(360, Math.min(1180, room))), fits: false, from: span.from };
    const height = fit.fits ? hours * fit.hourH + FIT.pad : Math.round(Math.max(240, room));
    return { hourH: fit.hourH, height, fits: fit.fits, from: span.from };
  }

  /** Apply a fit: the scroller's height, and beside a wide day the plan column no taller than it. */
  function applyFit(m) {
    const v = bodyView;
    v.scroller.style.height = `${m.height}px`;
    if (v.kind !== 'day') return;
    const tl = v.scroller.closest('.cal-day-tl');
    v.panel.style.maxHeight = lastCtx?.stacked || !tl ? '' : `${tl.offsetHeight}px`;
  }

  /**
   * Timelines fit the screen: the hour height is chosen so the whole span shows without
   * scrolling. Re-runs the view once when the height changes (the layout above it doesn't).
   */
  function fitTimeline(ctx) {
    const v = bodyView;
    if (!v?.scroller) return;
    // While the Show menu is open (a layer just toggled), keep the fit: moving the timeline
    // would scroll it, and a scroll closes the menu. It fits again when the menu closes.
    let m = menuOpen() ? fitted[v.kind] : null;
    if (!m || m.hourH !== ctx.hourH) m = measureFit(ctx);
    if (!m) return;
    if (m.hourH !== ctx.hourH) {
      ctx.hourH = m.hourH;
      v.update(ctx);
      m = measureFit(ctx) ?? m;
    }
    fitted[v.kind] = m;
    ctx.tlFits = m.fits;
    ctx.tlFrom = m.from;
    applyFit(m);
  }

  /** The phone's month grid fills the screen: taller day cells instead of empty space under it. */
  function sizeMonth() {
    if (bodyView?.kind !== 'month-c' || !bodyView.el?.isConnected) return;
    const grid = bodyView.el.querySelector('.cal-month');
    if (!grid) return;
    const rows = grid.querySelectorAll('.cal-wrow').length || 6;
    const head = grid.querySelector('.cal-mhead')?.offsetHeight ?? 26;
    const key = bodyView.el.querySelector('.cal-minilegend');
    const keyH = key ? key.offsetHeight + (parseFloat(getComputedStyle(key).marginTop) || 0) : 0;
    const room = viewportBottom() - FIT.margin - pageTop(grid) - head - keyH - 2;
    grid.style.setProperty('--cal-cell-h', `${Math.max(58, Math.min(96, Math.floor((room - rows) / rows)))}px`);
  }

  /** After a resize or a change above the view (a tip closed, the toolbar wrapped): fit again. */
  function refit() {
    if (!lastCtx || !alive || !root.isConnected || isDragging() || menuOpen()) return;
    if (isStacked() !== lastCtx.stacked) return render();
    if (bodyView?.scroller) {
      const m = measureFit(lastCtx);
      if (!m) return;
      if (m.hourH !== lastCtx.hourH || m.fits !== lastCtx.tlFits || m.from !== lastCtx.tlFrom) return render();
      applyFit(m);
      updateEdges();
      return;
    }
    if (lastCtx.kind === 'month' && monthSlots() !== lastCtx.slots) return render();
    sizeMonth();
  }

  /* ---- render ---- */
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(render);
  }

  function render() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (!root.isConnected) return;
    if (isDragging()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    state.today = todayKey();
    const ctx = buildCtx();
    lastCtx = ctx;
    lastMinute = ctx.nowMin;

    const active = document.activeElement;
    const target = pendingFocus;
    const fc = active && root.contains(active) ? captureFocus(active) : pendingFocusCtx;
    pendingFocus = null;
    pendingFocusCtx = null;

    updateToolbar(ctx);
    updateTips(ctx);
    // The tray can sit above the view (narrow, open): drawn before the view is fitted under it
    tray.update(ctx);

    const { kind } = ctx;
    if (!bodyView || bodyView.kind !== kind) {
      if (kind === 'week') bodyView = { kind, ...weekView() };
      else if (kind === 'day') bodyView = { kind, ...dayView({ onAddTask: addTaskInline }) };
      else bodyView = { kind, el: null };
      rangeShown = '';
    }
    if (bodyView.update) {
      bodyView.update(ctx);
      if (body.firstElementChild !== bodyView.el) body.replaceChildren(bodyView.el);
    } else {
      bodyView.el = kind === 'agenda' ? agendaView(ctx) : monthView(ctx);
      body.replaceChildren(bodyView.el);
    }
    bodyView.el.classList.add('cal-view');

    fitTimeline(ctx);
    sizeMonth();
    // A new period, or a new fit (the hours or their height changed): scroll to its first hour
    const shown = `${kind}:${ctx.range.from}${ctx.tlFits ? `:${ctx.hourH}:${ctx.tlFrom}` : ''}`;
    if (bodyView.scroller && shown !== rangeShown) scrollTimeline(ctx);
    else updateEdges();
    rangeShown = shown;

    // Focus: an explicit target, else keep it where it was; never let it fall to <body>. A
    // closing dialog (still fading out) doesn't count: its focus has already come back here.
    if (target) focusFid(target);
    else if (fc && !document.querySelector('.modal-root:not(.is-leaving)') && (!document.activeElement || document.activeElement === document.body)) restoreFocus(fc);
  }

  /* ---- focus ---- */
  // Focus ids (data-fid) are '<kind>:...:<item>'. Tasks: rc rt tc tt ts + task id; events: tl ev + occId.
  const TASK_KINDS = new Set(['rc', 'rt', 'tc', 'tt', 'ts']);
  const kindOf = (fid) => fid.split(':')[0];
  /** The task / event / thing a focus id stands for, so it can be found again in another place. */
  function itemOf(fid) {
    const parts = fid.split(':');
    const last = parts[parts.length - 1];
    if (TASK_KINDS.has(parts[0])) return `task:${last}`;
    if (parts[0] === 'tl' || parts[0] === 'ev') return `event:${last.split('@')[0]}`;
    return fid;
  }
  const NEAR_BOX = '.cal-plan-list, .cal-tray-list, .cal-wk-allday, .cal-tl-col, .cal-ag-day, .cal-plan-sec, .cal-wk-head, .cal-agenda';
  const focusable = (el) => el && !el.closest('[aria-hidden="true"], [hidden]') && el.isConnected;
  const byFid = (fid) => {
    const el = fid ? root.querySelector(`[data-fid="${CSS.escape(fid)}"]`) : null;
    return focusable(el) ? el : null;
  };

  /** Where focus is, and where it could go if that element leaves the view. */
  function captureFocus(el) {
    const own = el?.closest?.('[data-fid]');
    if (!own || !root.contains(own)) return null;
    const fid = own.dataset.fid;
    const near = [];
    const box = own.closest(NEAR_BOX);
    if (box) {
      const all = [...box.querySelectorAll('[data-fid]')].map((n) => n.dataset.fid);
      const at = all.indexOf(fid);
      const other = (f) => itemOf(f) !== itemOf(fid);
      const after = all.slice(at + 1).filter(other);
      const before = all.slice(0, Math.max(0, at)).filter(other).reverse();
      const same = (f) => kindOf(f) === kindOf(fid);
      near.push(...after.filter(same), ...before.filter(same), ...after.filter((f) => !same(f)), ...before.filter((f) => !same(f)));
    }
    const day = own.closest('[data-tl-day]')?.dataset.tlDay ?? own.closest('[data-drop-day]')?.dataset.dropDay ?? null;
    return { fid, near, day };
  }

  const viewAnchor = () => (state.view === 'month' ? `cell:${state.cursor}` : state.view === 'day' ? 'day-tl' : phoneMq.matches ? `ag:${state.cursor}` : `dh:${state.cursor}`);

  function focusEl(el) {
    el.focus({ preventScroll: true });
    if (el.dataset.fid?.startsWith('cell:') || el.dataset.fid?.startsWith('plan-')) el.scrollIntoView({ block: 'nearest' });
  }

  /** Focus a fid, falling back to the view's anchor, then the period title. */
  function focusFid(fid) {
    focusEl(byFid(fid) ?? byFid(viewAnchor()) ?? title);
  }

  /** Same element, else the same task / event elsewhere, its neighbours, its day, the view, the title. */
  function restoreFocus(fc) {
    let el = byFid(fc.fid);
    if (!el) {
      const item = itemOf(fc.fid);
      if (item !== fc.fid) {
        const cands = [...root.querySelectorAll('[data-fid]')].filter((n) => itemOf(n.dataset.fid) === item && focusable(n));
        el = cands.find((n) => kindOf(n.dataset.fid) === kindOf(fc.fid)) ?? cands[0] ?? null;
      }
    }
    for (const f of fc.near) {
      if (el) break;
      el = byFid(f);
    }
    if (!el && fc.day) el = byFid(`dh:${fc.day}`) ?? byFid(`ag:${fc.day}`) ?? byFid(`cell:${fc.day}`);
    focusEl(el ?? byFid(viewAnchor()) ?? title);
  }

  /**
   * Call before opening a dialog; call the returned function when it closes. If focus is lost
   * by then (the control it came from was re-rendered or removed), the next render brings it back.
   */
  function returnFocusAfter() {
    const fc = captureFocus(document.activeElement);
    return () => {
      if (!fc || !alive) return;
      pendingFocusCtx = fc;
      scheduleRender();
    };
  }

  function updateToolbar(ctx) {
    // The title is a live region: rewrite it only when it changes, or it is announced again
    // Simple leaves the week number out of the title (the tooltip keeps it)
    const head = L.periodHeading(state.view, state.cursor, { short: ctx.phone, weekNumber: !plainSkin() });
    const text = `${head.month} ${head.year}|${head.sub}`;
    if (title.dataset.text !== text) {
      title.dataset.text = text;
      titleMonth.textContent = head.month;
      titleYear.textContent = head.year;
      titleSub.textContent = head.sub;
      titleSub.hidden = !head.sub;
    }
    const long = L.viewTitle(state.view, state.cursor);
    if (title.title !== long) title.title = long;
    const unit = state.view === 'month' ? 'month' : state.view === 'week' ? 'week' : 'day';
    prevBtn.setAttribute('aria-label', `Previous ${unit}`);
    prevBtn.title = `Previous ${unit} (←)`;
    nextBtn.setAttribute('aria-label', `Next ${unit}`);
    nextBtn.title = `Next ${unit} (→)`;
    const inRange = ctx.range.from <= ctx.today && ctx.today <= ctx.range.to;
    todayBtn.classList.toggle('is-here', inRange);
    for (const [v, btn] of zoomBtns) btn.setAttribute('aria-pressed', String(v === state.view));
    if (viewShown !== state.view) {
      viewShown = state.view;
      updateMenu(viewDd, { value: state.view });
      setViewIcon(state.view);
    }
    // The button shows only the view's name; its accessible name says what it picks
    viewDd.button.setAttribute('aria-label', `View: ${L.VIEW_LABEL[state.view]}`);
    const items = layerItems(ctx);
    const sig = JSON.stringify(items.map((it) => [it.value, it.checked, it.hint]));
    if (sig !== showSig) {
      showSig = sig;
      updateMenu(showDd, { items });
    }
    trayCount.textContent = ctx.unscheduled.length ? String(ctx.unscheduled.length) : '';
    trayToggle.setAttribute('aria-expanded', String(state.trayOpen));
    trayToggle.setAttribute('aria-label', `Unscheduled tasks, ${ctx.unscheduled.length}`);
    cal.dataset.view = state.view;
    cal.classList.toggle('is-tray-open', state.trayOpen);
    cal.classList.toggle('is-phone', ctx.phone);
  }

  /**
   * The Show menu's items: each layer with its icon, whether it's on, and the shown period's
   * count (events, open tasks, habits done so far, done tasks): the totals the old stats bar had.
   */
  function layerItems(ctx) {
    const { from, to } = ctx.range;
    let open = 0;
    let doneTasks = 0;
    for (const t of ctx.tasks) {
      if (!t.due || t.due < from || t.due > to) continue;
      if (t.done) doneTasks++;
      else open++;
    }
    let done = 0;
    let planned = 0;
    for (const [key, info] of ctx.habits ?? []) {
      if (key > ctx.today) continue;
      done += info.done;
      planned += info.planned;
    }
    const hints = {
      events: String(new Set(ctx.occs.map((o) => o.occId)).size),
      tasks: String(open),
      habits: ctx.habits && from <= ctx.today ? (planned ? `${Math.round((done / planned) * 100)}%` : '—') : '',
      completed: String(doneTasks),
    };
    return LAYER_UI.map((l) => ({ value: l.id, label: l.label, icon: L.LAYER_ICON[l.id], hint: hints[l.id] || null, checked: !!ctx.layers[l.id] }));
  }

  /** dropdown.update(), keeping keyboard focus on the same item when its menu is open. */
  function updateMenu(dd, opts) {
    const item = document.activeElement?.closest?.('.dd-menu .dd-item');
    const at = dd.button.getAttribute('aria-expanded') === 'true' && item ? item.dataset.i : null;
    dd.update(opts);
    if (at !== null) document.querySelector(`.dd-menu .dd-item[data-i="${at}"]`)?.focus({ preventScroll: true });
  }

  /** How to start, in the terms of the view on screen: a timeline adds by its hours, a grid by its days. */
  function howToText(ctx) {
    const touch = ctx.phone || ctx.coarse;
    if (ctx.kind === 'day' || ctx.kind === 'week') {
      const add = touch ? 'Tap an empty hour to add an event there.' : 'Click an empty hour (or drag across a few) to add an event there, or press N.';
      return ctx.kind === 'week' ? `${add} Drag tasks from Unscheduled to plan them.` : add;
    }
    if (ctx.phone) return 'Tap a day to open it. New event adds one.';
    if (ctx.coarse) return 'Tap a day, then tap it again to open it. + adds an event; Schedule… plans a task.';
    return 'Double-click a day (or press N) to add an event. Drag tasks from Unscheduled to plan them.';
  }

  /** The tips row: how to start (only while there are no events) and the look key. */
  function updateTips(ctx) {
    const text = howToText(ctx);
    if (howTip?.dataset.text !== text) {
      const next = tip({ id: 'calendar.howto', text, className: 'cal-howto-tip' });
      next.dataset.text = text;
      if (howTip) howTip.replaceWith(next);
      else tips.prepend(next);
      howTip = next;
    }
    howTip.hidden = tipHidden('calendar.howto') || ctx.eventCount > 0;
    legendHabits.hidden = !ctx.layers.habits;
    // No empty row (and no gap for it) once every tip is read or doesn't apply here
    tips.hidden = false;
    tips.hidden = ![...tips.children].some((t) => !t.hidden && t.getClientRects().length);
  }

  function scrollTimeline(ctx) {
    const sc = bodyView.scroller;
    if (!sc) return;
    const H = ctx.hourH;
    const timed = ctx.occs.filter((o) => !o.allDay);
    const earliest = timed.length ? Math.min(...timed.map((o) => o.startMin)) : 7 * 60;
    const target = Math.min(7 * 60, Math.floor(earliest / 60) * 60);
    const showsToday = ctx.range.from <= ctx.today && ctx.today <= ctx.range.to;
    // Today's first event that hasn't ended yet (the one on now, or the next)
    const pending = timed.filter((o) => o.start === ctx.today && o.endMin > ctx.nowMin);
    const nextMin = pending.length ? Math.min(...pending.map((o) => o.startMin)) : null;
    const fits = ctx.tlFits;
    const fromPx = (ctx.tlFrom * H) - FIT.pad / 2;
    requestAnimationFrame(() => {
      if (!alive || bodyView?.scroller !== sc) return;
      // Fitted to the screen: the whole span shows from its first hour, nothing to look for
      if (fits) {
        sc.scrollTop = Math.max(0, fromPx);
        updateEdges();
        return;
      }
      const visible = sc.clientHeight || 480;
      let top = (target / 60) * H - 8;
      // On today, keep the current time on screen when 07:00 can't show it, and prefer showing
      // the current or next unfinished event over empty hours (the ▲ / ▼ chips cover the rest)
      const nowPx = (ctx.nowMin / 60) * H;
      if (showsToday && nowPx > top + visible - 24) {
        top = nowPx - visible * 0.4;
        if (nextMin !== null) top = Math.min(top, (nextMin / 60) * H - 8);
        top = Math.max(top, nowPx - visible + 24);
      }
      sc.scrollTop = Math.max(0, top);
      updateEdges();
    });
  }

  /** ▲ / ▼ chips for each column's events above or below the visible hours. */
  function updateEdges() {
    const v = bodyView;
    if (!v?.edges || !v.scroller || !lastCtx) return;
    const sc = v.scroller;
    const H = lastCtx.hourH;
    // A classic scrollbar takes width from the scroller: keep the chips over their columns
    const bar = `${sc.offsetWidth - sc.clientWidth}px`;
    v.edges.top.style.right = bar;
    v.edges.bottom.style.right = bar;
    fillEdges(v.edges.top, v.edges.bottom, lastCtx, v.keys(lastCtx), { from: (sc.scrollTop / H) * 60, to: ((sc.scrollTop + sc.clientHeight) / H) * 60 });
  }

  let edgeRaf = 0;
  const onTlScroll = (e) => {
    if (e.target !== bodyView?.scroller || edgeRaf) return;
    edgeRaf = requestAnimationFrame(() => {
      edgeRaf = 0;
      updateEdges();
    });
  };

  /** A ▲ / ▼ chip: scroll to the nearest hidden event and focus it. */
  function revealEdge(chip) {
    const sc = bodyView?.scroller;
    if (!sc || !lastCtx) return;
    const top = Math.max(0, (Number(chip.dataset.scrollMin) / 60) * lastCtx.hourH - 8);
    sc.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
    const block = byFid(`tl:${chip.dataset.occ}`);
    if (block) block.focus({ preventScroll: true });
  }

  /* ---- navigation ---- */
  function setCursor(key, { focusCell = false } = {}) {
    if (!L.VIEWS.includes(state.view) || !key) return;
    // Same day: no rebuild (a double-click's second press must land on the same cell)
    if (key === state.cursor) {
      if (focusCell) body.querySelector(`[data-fid="cell:${key}"]`)?.focus({ preventScroll: true });
      return;
    }
    state.cursor = key;
    remember();
    if (focusCell) pendingFocus = `cell:${key}`;
    render();
  }

  function step(delta) {
    setCursor(L.shiftCursor(state.view, state.cursor, delta), { focusCell: isGridFocused() });
  }

  function goToday() {
    setCursor(todayKey(), { focusCell: isGridFocused() });
  }

  const isGridFocused = () => !!document.activeElement?.closest?.('[data-cell]') && root.contains(document.activeElement);

  /* ---- zoom (with a view transition growing from / shrinking into the clicked element) ---- */
  function zoomTo(view, key = state.cursor, source = null, { focus = false } = {}) {
    if (!L.VIEWS.includes(view)) return;
    vtFlush?.();
    const from = state.view;
    const prevKey = state.cursor;
    if (view === from && key === prevKey) return;
    // Focus inside the old view would be lost with it: move it to the new view's own anchor
    // (month: the day's cell · week: its day header · day: its timeline). Focus elsewhere
    // (the toolbar's zoom buttons) stays where it is.
    const moveFocus = focus || body.contains(document.activeElement);
    const apply = () => {
      if (!alive) return;
      state.view = view;
      state.cursor = key;
      remember();
      saveView(view);
      if (moveFocus) pendingFocus = view === 'month' ? `cell:${key}` : view === 'day' ? 'day-tl' : phoneMq.matches ? `ag:${key}` : `dh:${key}`;
      render();
    };
    const zoomIn = DEPTH[view] > DEPTH[from];
    const zoomOut = DEPTH[view] < DEPTH[from];
    if ((!zoomIn && !zoomOut) || reducedMotion()) return apply();

    const zoomSel = (v, k) => (v === 'week' ? `[data-zoom="week:${L.mondayOf(k)}"]` : `[data-zoom="day:${k}"]`);
    if (zoomIn) {
      const src = source?.closest?.('[data-zoom]') ?? body.querySelector(zoomSel(view, key));
      return runZoom(apply, src, () => bodyView?.el, true);
    }
    // Zooming out: the whole view shrinks into the week row / day it came from
    return runZoom(apply, bodyView?.el, () => body.querySelector(zoomSel(from, prevKey)) ?? body.querySelector(zoomSel('day', prevKey)), false);
  }

  /**
   * Zoom animation. The live new view always grows out of (or settles back from) the clicked
   * element's box with Web Animations, so it takes clicks from the first frame. Where View
   * Transitions exist, a snapshot of the departing element (only that one is named, never the
   * new view, which would stop taking pointer input while captured) flies to the new box and
   * fades. A newer zoom skips the running one; reduced motion skips both (see zoomTo).
   */
  function runZoom(apply, oldEl, getNewEl, growing) {
    vt?.skipTransition();
    for (const a of flips) a.cancel();
    flips = [];
    for (const el of root.querySelectorAll('.cal-vt-name')) {
      el.style.viewTransitionName = '';
      el.classList.remove('cal-vt-name');
    }
    if (!oldEl || !oldEl.isConnected) return apply();

    let applied = false;
    const applyOnce = () => {
      if (applied) return;
      applied = true;
      if (vtFlush === applyOnce) vtFlush = null;
      apply();
    };
    const r0 = oldEl.getBoundingClientRect();
    const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

    // The live view: from the old box to its own (zoom in), or a soft settle (zoom out)
    const animateLive = () => {
      const el = growing ? bodyView?.el : getNewEl();
      if (!el?.animate || !el.isConnected) return null;
      const r1 = el.getBoundingClientRect();
      if (!r1.width || !r1.height) return null;
      if (growing) {
        // One scale factor for both axes (text never squashes), centred on the clicked element
        const ox = Math.min(Math.max(r0.left + r0.width / 2 - r1.left, 0), r1.width);
        const oy = Math.min(Math.max(r0.top + r0.height / 2 - r1.top, 0), r1.height);
        flips.push(
          el.animate(
            [
              { transformOrigin: `${ox}px ${oy}px`, transform: 'scale(0.94)', opacity: 0.2 },
              { transformOrigin: `${ox}px ${oy}px`, transform: 'none', opacity: 1 },
            ],
            { duration: 280, easing: EASE },
          ),
        );
      } else {
        flips.push(bodyView.el.animate([{ opacity: 0.25, transform: 'scale(1.03)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE }));
        flips.push(el.animate([{ boxShadow: 'inset 0 0 0 1px var(--accent), 0 0 24px var(--accent-soft)' }, { boxShadow: 'inset 0 0 0 1px transparent' }], { duration: 700, easing: 'ease-out' }));
      }
      return r1;
    };

    if (typeof document.startViewTransition !== 'function') {
      applyOnce();
      animateLive();
      return undefined;
    }

    const html = document.documentElement;
    oldEl.style.viewTransitionName = 'cal-zoom';
    oldEl.classList.add('cal-vt-name');
    html.classList.add('cal-vt');
    vtFlush = applyOnce;
    let t;
    try {
      t = document.startViewTransition(() => {
        oldEl.style.viewTransitionName = '';
        oldEl.classList.remove('cal-vt-name');
        applyOnce();
      });
    } catch {
      oldEl.style.viewTransitionName = '';
      oldEl.classList.remove('cal-vt-name');
      html.classList.remove('cal-vt');
      applyOnce();
      animateLive();
      return undefined;
    }
    vt = t;
    t.ready
      .then(() => {
        if (vt !== t || !alive) return;
        const r1 = animateLive();
        if (!r1) return;
        // The departing snapshot flies to where the new view (or the target row) now is
        html.animate(
          [
            { transform: `translate(${r0.left}px, ${r0.top}px)`, width: `${r0.width}px`, height: `${r0.height}px` },
            { transform: `translate(${r1.left}px, ${r1.top}px)`, width: `${r1.width}px`, height: `${r1.height}px` },
          ],
          { duration: 280, easing: EASE, pseudoElement: '::view-transition-group(cal-zoom)' },
        );
      })
      .catch(() => {});
    const done = () => {
      if (vt !== t) return;
      vt = null;
      html.classList.remove('cal-vt');
    };
    t.finished.then(done, done);
    return undefined;
  }

  /* ---- creating ---- */
  // New event (button / N): the next whole hour today, 09:00 on other days. A month cell's
  // double-click or + makes an all-day event instead.
  function defaultSlot(key) {
    let s = 9 * 60;
    if (key === todayKey()) s = Math.min(22 * 60, (Math.floor(nowMinutes() / 60) + 1) * 60);
    return { start: key, end: key, allDay: false, startTime: L.formatTime(s), endTime: L.formatTime(Math.min(s + 60, L.LAST_MINUTE)) };
  }

  /** After the editor: show what was saved (layer on, period that holds it). */
  function followResult(res) {
    if (!res || (res.action !== 'created' && res.action !== 'updated')) return;
    if (!getCalendar().layers.events) setLayer('events', true);
    if (!root.isConnected || !res.key || !L.VIEWS.includes(state.view)) return;
    const { from, to } = L.viewRange(state.view, state.cursor);
    if (res.key < from || res.key > to) setCursor(res.key);
  }

  function openEditor(opts) {
    const back = returnFocusAfter();
    try {
      openEventEditor({
        ...opts,
        onDone: (res) => {
          followResult(res);
          back();
        },
      });
    } catch (err) {
      console.error('[calendar] editor failed', err);
      toast('The event editor could not open.');
    }
  }

  function newEvent(defaults = defaultSlot(state.cursor)) {
    openEditor({ defaults });
  }

  function editOccurrence(occId) {
    const occ = lastCtx?.occById.get(occId);
    const event = occ && getEvent(occ.eventId);
    if (event) openEditor({ event, occurrenceKey: occ.start });
  }

  function deleteOccurrenceAt(occId) {
    const occ = lastCtx?.occById.get(occId);
    if (!occ || !getEvent(occ.eventId)) return;
    const back = returnFocusAfter();
    deleteEvent({ event: occ, occurrenceKey: occ.start })
      .catch((err) => console.error('[calendar] delete failed', err))
      .finally(back);
  }

  /* ---- Copy, paste, duplicate (the right-click menu) ---- */

  /**
   * Paste a copied event or task onto a day (`minute`: a time slot on a timeline, else null).
   * A task gets that due date. An event lands on that day (at that time on a slot), keeping its
   * length; a repeating one starts a new series there with the same rule (the copied date and
   * the ones after it, moved together), or a single event when the rule can't follow the move.
   */
  function pasteOnDay(c, key, minute = null) {
    if (c.kind === 'task') return pasteTask(c.snapshot, key);
    if (c.kind !== 'event') return false;
    const snap = c.snapshot ?? {};
    const startTime = minute !== null ? L.formatTime(slotMinute(minute, L.SNAP_MINUTES)) : null;
    const res = L.pasteEventCopy(snap.event, snap.occurrence, { day: key, startTime });
    if (res.error) return refuse(res.error);
    const { event: made, single } = res;
    if (!getCalendar().layers.events) setLayer('events', true);
    const what = `“${clip(made.title)}”`;
    const when = `${shortDay(made.start)}${made.allDay ? '' : `, ${made.startTime}`}`;
    return commitEvents({ save: [made] }, single ? `Pasted one date of ${what} on ${when}` : `Pasted ${what} on ${when}`, what);
  }

  /** A copied task onto a day (null: the Unscheduled tray), after `afterId` in Tasks' own order. */
  function pasteTask(snap, key, { afterId = null, verb = 'Pasted' } = {}) {
    const task = tasksApi.insertCopy(snap, { afterId, due: key });
    if (!task) return refuse('That copy can’t be pasted.');
    if (!getCalendar().layers.tasks) setLayer('tasks', true);
    undoToast(`${verb} “${clip(task.title)}”${key ? ` on ${shortDay(key)}` : ' to Unscheduled'}`, () => tasksApi.removeCopy(task));
    return true;
  }

  /** The whole event (every date of a series) once more, same dates and times, new id. */
  function duplicateEvent(id) {
    const ev = getEvent(id);
    if (!ev) return false;
    if (isNewerFormat(id)) return refuse(NEWER_COPY);
    const now = Date.now();
    const copy = { ...ev, id: String(uid()), createdAt: now, updatedAt: now };
    const what = `“${clip(ev.title)}”`;
    return commitEvents({ save: [copy] }, ev.repeat ? `Duplicated every ${what}` : `Duplicated ${what}`, what);
  }

  /** The day under `el`: a cell, a timeline column, an all-day lane, an agenda day; else the shown day. */
  function dayAt(el) {
    return el.closest('[data-drop-day]')?.dataset.dropDay ?? el.closest('[data-key]')?.dataset.key ?? el.closest('.cal-dh')?.querySelector('[data-key]')?.dataset.key ?? state.cursor;
  }

  /**
   * The right-click menu: an event (any view), a task chip or row, or a paste target: a time slot
   * (the minute under the pointer), a day, the Unscheduled tray, or anywhere else (the shown day).
   */
  function contextTarget(el, { y, keyboard } = {}) {
    if (!root.contains(el) || !lastCtx) return null;
    const accepts = ['event', 'task'];
    const evEl = el.closest('[data-act="event"][data-occ]');
    const occ = evEl && cal.contains(evEl) ? lastCtx.occById.get(evEl.dataset.occ) : null;
    const ev = occ ? getEvent(occ.eventId) : null;
    if (ev) {
      const newer = isNewerFormat(ev.id);
      return {
        kind: 'event',
        id: ev.id,
        label: `Event: ${ev.title}`,
        el: evEl,
        accepts,
        paste: (c) => pasteOnDay(c, occ.start),
        copy: () => {
          const cur = getEvent(ev.id);
          if (!cur || isNewerFormat(cur.id)) return null;
          const snapshot = { event: cur, occurrence: occ.start };
          return { kind: 'event', snapshot, text: clipText('event', { event: cur, occurrence: { start: occ.start, end: occ.end, allDay: occ.allDay, startTime: occ.startTime, endTime: occ.endTime } }) };
        },
        remove: () => deleteOccurrenceAt(occ.occId),
        duplicate: () => duplicateEvent(ev.id),
        edit: newer ? undefined : () => editOccurrence(occ.occId),
        can: { copy: !newer, duplicate: !newer },
        color: newer ? null : { kind: 'events', value: ev.color ?? null, set: (c) => setEventColor(ev.id, c) },
      };
    }
    const taskEl = el.closest('[data-task]');
    const task = taskEl && cal.contains(taskEl) ? findTask(taskEl.dataset.task) : null;
    const inTray = !!el.closest('[data-drop-tray]');
    if (task) {
      const id = task.id;
      const key = inTray ? null : dayAt(el);
      return {
        kind: 'task',
        id,
        label: `Task: ${task.title}`,
        el: taskEl.closest('[data-drag="task"]')?.querySelector('[data-act="task-open"]') ?? taskEl,
        accepts: key ? accepts : ['task'],
        paste: (c) => (c.kind === 'task' ? pasteTask(c.snapshot, key, { afterId: id }) : pasteOnDay(c, key)),
        copy: () => {
          const snapshot = tasksApi.snapshot(id);
          return snapshot ? { kind: 'task', snapshot, text: snapshot.title } : null;
        },
        remove: () => tasksApi.remove(id),
        duplicate: () => {
          const snapshot = tasksApi.snapshot(id);
          if (snapshot) pasteTask(snapshot, findTask(id)?.due ?? null, { afterId: id, verb: 'Duplicated' });
        },
        edit: () => openTaskSheet(id, state.cursor, returnFocusAfter()),
        rename: () => renameTaskPrompt(task),
        color: { kind: 'tasks', value: task.color ?? null, set: (c) => tasksApi.setColor(id, c) },
      };
    }
    if (inTray) return { kind: null, id: null, label: 'Unscheduled tasks', el: null, accepts: ['task'], paste: (c) => pasteTask(c.snapshot, null) };
    const key = dayAt(el);
    // A time slot: the minute under the pointer (a keyboard paste uses the editor's default slot)
    const col = el.closest('[data-tl-day]');
    let minute = null;
    if (col && cal.contains(col)) minute = keyboard || !Number.isFinite(y) ? L.parseTime(defaultSlot(key).startTime) : minuteAt(col, y);
    return {
      kind: null,
      id: null,
      label: `Calendar: ${shortDay(key)}${minute !== null ? `, ${L.formatTime(slotMinute(minute, L.SNAP_MINUTES))}` : ''}`,
      el: null,
      accepts,
      paste: (c) => pasteOnDay(c, key, c.kind === 'event' ? minute : null),
      // A day (cell, header, timeline column): its color
      color: el.closest('[data-drop-day], [data-key], .cal-dh') ? { kind: 'days', value: getDayColors()[key] ?? null, set: (c) => setDayColor(key, c) } : null,
    };
  }

  function addTaskInline(text) {
    // Same priority tokens as Tasks' quick-add (!h / !m / !l); the day itself is the due date
    const parsed = parseQuickAdd(text, todayKey(), new Set(['due']));
    const task = tasksApi.addTask({ title: parsed.title || text, due: state.cursor, priority: parsed.priority ?? 'none' });
    if (!task) return false;
    if (!getCalendar().layers.tasks) setLayer('tasks', true);
    toast(`Task added for ${shortDay(state.cursor)}`);
    return true;
  }

  function checkHabit(btn) {
    const { habit, key, done } = btn.dataset;
    const ok = habitsApi.setLog(habit, key, done !== 'true');
    if (!ok && key > todayKey()) toast('Future days can’t be checked in yet.');
  }

  /* ---- clicks (delegated) ---- */
  function onClick(e) {
    const actEl = e.target.closest('[data-act]');
    if (actEl && cal.contains(actEl)) {
      const a = actEl.dataset;
      switch (a.act) {
        case 'zoom-week':
          return zoomTo('week', a.key, actEl);
        case 'zoom-day':
          return zoomTo('day', a.key, actEl);
        case 'more':
          return zoomTo('day', a.key);
        case 'event':
          return editOccurrence(a.occ);
        case 'add-event':
          return newEvent(state.view === 'month' ? defaultSlotMonth(a.key) : defaultSlot(a.key));
        case 'add-allday':
          // The lane itself only when its empty part is hit; its button (the day's "All day +") always
          if (e.target !== actEl && !actEl.matches('button')) return undefined;
          return newEvent(defaultSlotMonth(a.key));
        case 'plan-toggle':
          return toggleDayPanel(a.panel);
        case 'task-check':
          return toggleTaskDone(a.task);
        case 'task-open':
        case 'task-schedule':
          return openTaskSheet(a.task, state.cursor, returnFocusAfter());
        case 'habit-check':
          return checkHabit(actEl);
        case 'layer-on':
          // The link goes away with the change: focus lands on what it revealed
          if (a.focus) pendingFocus = a.focus;
          if (!setLayer(a.layer, true)) pendingFocus = null;
          return undefined;
        case 'tl-edge':
          return revealEdge(actEl);
        default:
          return undefined;
      }
    }
    // A plain click on a month cell selects that day (on touch, tapping the selected day again
    // opens it: its date button is small); on a timeline it adds an event there
    const cell = e.target.closest('[data-cell]');
    if (cell && body.contains(cell)) {
      if (lastCtx?.coarse && cell.dataset.key === state.cursor) return zoomTo('day', cell.dataset.key, cell);
      return setCursor(cell.dataset.key, { focusCell: true });
    }
    const col = e.target.closest('[data-tl-day]');
    if (col && body.contains(col) && e.target === col) {
      const min = minuteAt(col, e.clientY);
      const s = Math.min(Math.floor(min / 30) * 30, L.LAST_MINUTE - 30);
      return newEvent({ start: col.dataset.tlDay, end: col.dataset.tlDay, allDay: false, startTime: L.formatTime(s), endTime: L.formatTime(Math.min(s + 60, L.LAST_MINUTE)) });
    }
    return undefined;
  }

  const defaultSlotMonth = (key) => ({ start: key, end: key, allDay: true, startTime: null, endTime: null });

  /** Open or fold the day's Tasks / Habits list; remembered on this device, per layout. */
  function toggleDayPanel(panel) {
    if (!L.DAY_PANELS.includes(panel)) return;
    const layout = lastCtx?.stacked ? 'narrow' : 'wide';
    const cur = L.normalizeDayPanels(prefs.get().dayPanels);
    const open = !cur[layout][panel];
    prefs.update({ dayPanels: L.setDayPanel(cur, layout, panel, open) });
    render();
    // Under the timeline the list opens below the screen's edge: bring as much of it as fits into view
    if (open && layout === 'narrow') body.querySelector(`.cal-plan-${panel}`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function onDblClick(e) {
    // Touch: a double tap is "select, then open" (see onClick); + adds events there
    if (lastCtx?.coarse) return;
    const cell = e.target.closest('[data-cell]');
    if (!cell || !body.contains(cell) || e.target.closest('[data-act]')) return;
    newEvent(defaultSlotMonth(cell.dataset.key));
  }

  /* ---- drags ---- */
  const minuteAt = (col, y) => Math.max(0, Math.min(L.DAY_MINUTES - 1, ((y - col.getBoundingClientRect().top) / (lastCtx?.hourH ?? HOUR_H)) * 60));

  function onPointerDown(e) {
    if (e.button !== 0 || !lastCtx) return;
    const t = e.target;
    if (t.closest('.cal-task-check, .cal-trow-check, .cal-task-sched, .cal-hcheck, .cal-cell-add, .cal-date, .cal-wknum, .cal-more, input, form')) return;
    const block = t.closest('[data-tl="event"]');
    if (block && cal.contains(block)) return dragTimed(e, block, !!t.closest('[data-tl-resize]'));
    const taskBlock = t.closest('[data-tl="task"]');
    if (taskBlock && cal.contains(taskBlock)) return dragTimedTask(e, taskBlock, !!t.closest('[data-tl-resize]'));
    const chip = t.closest('[data-drag="task"]');
    if (chip && cal.contains(chip)) return dragTask(e, chip);
    const bar = t.closest('[data-drag="event"]');
    if (bar && cal.contains(bar)) return dragEventDays(e, bar);
    const col = t.closest('[data-tl-day]');
    if (col && body.contains(col) && t === col) return dragCreate(e, col);
    return undefined;
  }

  function setDropHighlight(prev, next) {
    if (prev?.el === next?.el) return next;
    prev?.el.classList.remove('is-drop');
    next?.el.classList.add('is-drop');
    return next;
  }

  function dragTask(e, chip) {
    const id = chip.dataset.task;
    let ghost = null;
    let target = null;
    trackPointer(e, {
      onStart: (ev) => {
        ghost = ghostOf(chip, ev.clientX, ev.clientY);
        chip.classList.add('is-lifted');
      },
      onMove: (ev) => {
        ghost.move(ev.clientX, ev.clientY);
        target = setDropHighlight(target, dropTargetAt(ev.clientX, ev.clientY));
      },
      onEnd: (ev) => {
        const drop = target;
        cleanup();
        if (drop?.tray) applyDue(id, null);
        else if (drop?.el.hasAttribute('data-tl-day')) {
          // On a timeline: that day, at the time under the pointer
          const start = Math.min(L.snapMinutes(minuteAt(drop.el, ev.clientY)), L.DAY_MINUTES - L.SNAP_MINUTES);
          applySchedule(id, { due: drop.day, time: L.formatTime(start) });
        } else if (drop?.day) applyDue(id, drop.day);
        scheduleRender();
      },
      onCancel: () => {
        cleanup();
        scheduleRender();
      },
    });
    function cleanup() {
      ghost?.remove();
      chip.classList.remove('is-lifted');
      target = setDropHighlight(target, null);
    }
  }

  function dragEventDays(e, bar) {
    const occ = lastCtx.occById.get(bar.dataset.occ);
    if (!occ) return;
    const grab = dropTargetAt(e.clientX, e.clientY)?.day ?? occ.start;
    let ghost = null;
    let target = null;
    trackPointer(e, {
      onStart: (ev) => {
        ghost = ghostOf(bar, ev.clientX, ev.clientY);
        bar.classList.add('is-lifted');
      },
      onMove: (ev) => {
        ghost.move(ev.clientX, ev.clientY);
        const at = dropTargetAt(ev.clientX, ev.clientY);
        target = setDropHighlight(target, at && !at.tray ? at : null);
      },
      onEnd: () => {
        const day = target?.day;
        cleanup();
        scheduleRender();
        if (!day) return;
        const delta = L.daysBetween(grab, day);
        if (!delta) return;
        const start = L.shiftDays(occ.start, delta);
        changeOccurrence(occ, { start, end: occ.allDay ? L.shiftDays(occ.end, delta) : start }, 'Moved');
      },
      onCancel: () => {
        cleanup();
        scheduleRender();
      },
    });
    function cleanup() {
      ghost?.remove();
      bar.classList.remove('is-lifted');
      target = setDropHighlight(target, null);
    }
  }

  function dragTimed(e, block, resize) {
    const occ = lastCtx.occById.get(block.dataset.occ);
    if (!occ) return;
    const H = lastCtx.hourH;
    const cols = [...body.querySelectorAll('[data-tl-day]')];
    const timeEl = block.querySelector('.cal-tlev-time');
    // Minutes are read from the pointer's place on the grid, so scrolling mid-drag stays exact
    const anchor = minuteAt(block.parentElement, e.clientY);
    let slot = { startMin: occ.startMin, endMin: occ.endMin, startTime: occ.startTime, endTime: occ.endTime };
    let col = block.parentElement;
    let px = e.clientX;
    let py = e.clientY;
    const colAt = (x) => {
      for (const c of cols) {
        const r = c.getBoundingClientRect();
        if (x >= r.left && x < r.right) return c;
      }
      return x < cols[0].getBoundingClientRect().left ? cols[0] : cols[cols.length - 1];
    };
    const follow = () => {
      const delta = minuteAt(col, py) - anchor;
      if (resize) {
        slot = L.resizeTimed(occ.startMin, occ.endMin + delta);
      } else {
        slot = L.moveTimed(occ.startMin, occ.endMin, delta);
        const next = colAt(px);
        if (next !== col) {
          col = next;
          col.append(block);
        }
      }
      block.style.top = `${(slot.startMin / 60) * H}px`;
      block.style.height = `${Math.max(((slot.endMin - slot.startMin) / 60) * H, 18)}px`;
      if (timeEl) timeEl.textContent = `${slot.startTime}–${slot.endTime}`;
    };
    const edge = edgeScroller(bodyView.scroller, follow);
    trackPointer(e, {
      onStart: () => {
        block.classList.add('is-dragging');
        Object.assign(block.style, { left: '2px', width: 'calc(100% - 4px)' });
      },
      onMove: (ev) => {
        px = ev.clientX;
        py = ev.clientY;
        follow();
        edge.update(py);
      },
      onEnd: () => {
        edge.stop();
        block.classList.remove('is-dragging');
        const day = col.dataset.tlDay;
        scheduleRender();
        if (day === occ.start && slot.startMin === occ.startMin && slot.endMin === occ.endMin) return;
        if (resize) changeOccurrence(occ, { startTime: slot.startTime, endTime: slot.endTime }, 'Resized');
        else changeOccurrence(occ, { start: day, end: day, startTime: slot.startTime, endTime: slot.endTime }, 'Moved');
      },
      onCancel: () => {
        edge.stop();
        block.classList.remove('is-dragging');
        scheduleRender();
      },
    });
  }

  function dragTimedTask(e, block, resize) {
    const id = block.dataset.task;
    const task = findTask(id);
    const s0 = task?.time ? L.parseTime(task.time) : null;
    if (s0 === null) return;
    const e0 = Math.min(L.DAY_MINUTES - 1, s0 + (task.minutes || 30));
    const H = lastCtx.hourH;
    const cols = [...body.querySelectorAll('[data-tl-day]')];
    const timeEl = block.querySelector('.cal-tlev-time');
    const anchor = minuteAt(block.parentElement, e.clientY);
    let slot = { startMin: s0, endMin: e0, startTime: task.time };
    let col = block.parentElement;
    let px = e.clientX;
    let py = e.clientY;
    let lane = null; // the all-day lane or the tray under the pointer: a whole-day task again
    const colAt = (x) => {
      for (const c of cols) {
        const r = c.getBoundingClientRect();
        if (x >= r.left && x < r.right) return c;
      }
      return x < cols[0].getBoundingClientRect().left ? cols[0] : cols[cols.length - 1];
    };
    const follow = () => {
      const delta = minuteAt(col, py) - anchor;
      if (resize) slot = L.resizeTimed(s0, e0 + delta);
      else {
        slot = L.moveTimed(s0, e0, delta);
        const next = colAt(px);
        if (next !== col) {
          col = next;
          col.append(block);
        }
      }
      block.style.top = `${(slot.startMin / 60) * H}px`;
      block.style.height = `${Math.max(((slot.endMin - slot.startMin) / 60) * H, 18)}px`;
      if (timeEl) timeEl.textContent = `${slot.startTime}–${slot.endTime}`;
    };
    const edge = edgeScroller(bodyView.scroller, follow);
    trackPointer(e, {
      onStart: () => {
        block.classList.add('is-dragging');
        Object.assign(block.style, { left: '2px', width: 'calc(100% - 4px)' });
      },
      onMove: (ev) => {
        px = ev.clientX;
        py = ev.clientY;
        const over = resize ? null : dropTargetAt(px, py);
        const nextLane = over && !over.el.hasAttribute('data-tl-day') ? over : null;
        lane = setDropHighlight(lane, nextLane);
        block.classList.toggle('is-leaving', !!lane);
        if (!lane) {
          follow();
          edge.update(py);
        }
      },
      onEnd: () => {
        edge.stop();
        block.classList.remove('is-dragging', 'is-leaving');
        const drop = lane;
        lane = setDropHighlight(lane, null);
        scheduleRender();
        if (drop?.tray) return applySchedule(id, { due: null, time: null });
        if (drop?.day) return applySchedule(id, { due: drop.day, time: null });
        const day = col.dataset.tlDay;
        if (day === task.due && slot.startMin === s0 && slot.endMin === e0) return;
        applySchedule(id, { due: day, time: slot.startTime, minutes: slot.endMin - slot.startMin });
      },
      onCancel: () => {
        edge.stop();
        block.classList.remove('is-dragging', 'is-leaving');
        lane = setDropHighlight(lane, null);
        scheduleRender();
      },
    });
  }

  function dragCreate(e, col) {
    const H = lastCtx.hourH;
    const anchor = minuteAt(col, e.clientY);
    let ghost = null;
    let slot = null;
    let py = e.clientY;
    const follow = () => {
      if (!ghost) return;
      slot = L.slotFromDrag(anchor, minuteAt(col, py));
      ghost.style.top = `${(slot.startMin / 60) * H}px`;
      ghost.style.height = `${((slot.endMin - slot.startMin) / 60) * H}px`;
      ghost.firstChild.textContent = `${slot.startTime}–${slot.endTime} · ${L.durationLabel(slot.startMin, slot.endMin)}`;
    };
    const edge = edgeScroller(bodyView.scroller, follow);
    trackPointer(e, {
      onStart: () => {
        ghost = h('div', { class: 'cal-tl-ghost', 'aria-hidden': 'true' }, h('span', { class: 'cal-tlev-time tnum' }));
        col.append(ghost);
      },
      onMove: (ev) => {
        py = ev.clientY;
        follow();
        edge.update(py);
      },
      onEnd: () => {
        edge.stop();
        ghost?.remove();
        scheduleRender();
        if (!slot) return;
        const day = col.dataset.tlDay;
        newEvent({ start: day, end: day, allDay: false, startTime: slot.startTime, endTime: slot.endTime });
      },
      onCancel: () => {
        edge.stop();
        ghost?.remove();
        scheduleRender();
      },
    });
  }

  /* ---- keyboard ---- */
  function onGridKey(e, cell) {
    const key = cell.dataset.key;
    let next = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = L.shiftDays(key, -1);
        break;
      case 'ArrowRight':
        next = L.shiftDays(key, 1);
        break;
      case 'ArrowUp':
        next = L.shiftDays(key, -7);
        break;
      case 'ArrowDown':
        next = L.shiftDays(key, 7);
        break;
      case 'Home':
        next = L.mondayOf(key);
        break;
      case 'End':
        next = L.shiftDays(L.mondayOf(key), 6);
        break;
      case 'PageUp':
        next = L.shiftCursor('month', key, -1);
        break;
      case 'PageDown':
        next = L.shiftCursor('month', key, 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        zoomTo('day', key, cell, { focus: true });
        return true;
      default:
        return false;
    }
    e.preventDefault();
    if (next && next >= '1970-01-01' && next <= '9999-12-31') setCursor(next, { focusCell: true });
    return true;
  }

  function onKeydown(e) {
    if (e.defaultPrevented || isTyping(e) || modalOpen() || menuOpen() || !root.isConnected) return;
    // ⌘/Ctrl + Z: the latest calendar Undo (the toast may be long gone for keyboard users)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      if (undoLast()) e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cell = e.target.closest?.('[data-cell]');
    if (cell && body.contains(cell) && onGridKey(e, cell)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const inControl = e.target.closest?.('button, [role="checkbox"], a') && !cell;
    switch (k) {
      case 'm':
        e.preventDefault();
        return zoomTo('month');
      case 'w':
        e.preventDefault();
        return zoomTo('week');
      case 'd':
        e.preventDefault();
        return zoomTo('day');
      case 't':
        e.preventDefault();
        return goToday();
      case 'n':
        e.preventDefault();
        return newEvent();
      case 'ArrowLeft':
      case 'ArrowRight':
        if (e.shiftKey || (inControl && e.target.closest('.seg'))) return undefined;
        e.preventDefault();
        return step(k === 'ArrowLeft' ? -1 : 1);
      case 'Delete':
      case 'Backspace': {
        const ev = e.target.closest?.('[data-act="event"]');
        if (!ev || !cal.contains(ev)) return undefined;
        e.preventDefault();
        return deleteOccurrenceAt(ev.dataset.occ);
      }
      case 'Escape':
        // In the narrow layout's open tray, Escape closes it and returns to its toggle
        if (state.trayOpen && tray.el.contains(e.target) && trayToggle.offsetParent) {
          e.preventDefault();
          state.trayOpen = false;
          remember();
          render();
          trayToggle.focus();
          return undefined;
        }
        if (state.view === 'month') return undefined;
        e.preventDefault();
        return zoomTo(state.view === 'day' ? 'week' : 'month', state.cursor, null, { focus: true });
      default:
        return undefined;
    }
  }

  /* ---- live updates ---- */
  // Saving the zoom level is a store write too; only events and layers need a new frame
  const offCal = subscribeCalendar((s) => {
    if (lastCtx && s.events === lastCtx.events && s.layers === lastCtx.layers && (s.dayColors ?? lastCtx.dayColors) === lastCtx.dayColors) return;
    scheduleRender();
  });
  const offTasks = tasksApi.subscribe(scheduleRender);
  const offHabits = habitsApi.source.subscribe(scheduleRender);
  const offDay = onDayChange((today) => {
    if (state.cursor === state.today) state.cursor = today;
    remember();
    scheduleRender();
  });
  const clock = setInterval(() => {
    const m = nowMinutes();
    if (m === lastMinute || !lastCtx) return;
    lastMinute = m;
    // Every 5 minutes, redraw timelines so finished events dim
    if (m % 5 === 0 && state.view !== 'month') scheduleRender();
    const H = lastCtx.hourH;
    for (const line of root.querySelectorAll('[data-now]')) {
      line.style.top = `${(m / 60) * H}px`;
      line.firstChild.textContent = L.formatTime(m);
    }
  }, 10000);
  const onResize = debounce(refit, 150);
  // What sits above the view changing size (a tip read, the page's explanation closed, the
  // toolbar wrapping, the tray opening above it, the phone's timer docking) moves the view:
  // fit it again on the next frame
  let fitRaf = 0;
  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (fitRaf) return;
          fitRaf = requestAnimationFrame(() => {
            fitRaf = 0;
            refit();
          });
        })
      : null;
  for (const el of [header, toolbar, tips, tray.el, document.querySelector('.shell > .topbar-center')]) if (el) ro?.observe(el);
  // The fit waits while a toolbar menu is open (fitTimeline): catch up when it closes
  const menuWatch = new MutationObserver(() => {
    if (viewDd.button.getAttribute('aria-expanded') === 'false' && showDd.button.getAttribute('aria-expanded') === 'false') requestAnimationFrame(refit);
  });
  for (const b of [viewDd.button, showDd.button]) menuWatch.observe(b, { attributes: true, attributeFilter: ['aria-expanded'] });
  // A tip's ✓ hides it: the row may go, and the view gets that room
  const onTipDone = (e) => {
    if (!e.target.closest?.('.tip-ok') || !lastCtx) return;
    requestAnimationFrame(() => {
      if (alive && lastCtx) updateTips(lastCtx);
    });
  };
  const onMq = () => render();
  // Releasing a drag runs any render that was held back meanwhile
  const onPointerUp = () => {
    if (pendingRender) scheduleRender();
  };

  const offMenu = registerContextProvider('calendar', contextTarget);
  cal.addEventListener('click', onClick);
  cal.addEventListener('dblclick', onDblClick);
  // Scroll doesn't bubble; a capturing listener sees the timeline scroller's
  cal.addEventListener('scroll', onTlScroll, { capture: true, passive: true });
  cal.addEventListener('pointerdown', onPointerDown);
  tips.addEventListener('click', onTipDone);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);
  phoneMq.addEventListener('change', onMq);
  coarseMq.addEventListener('change', onMq);

  render();

  // calendarApi.open() while this view is up: zoom straight to the requested day / week
  const openHere = (view, key) => zoomTo(view, key);
  openInView = openHere;

  return () => {
    alive = false;
    if (openInView === openHere) openInView = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (edgeRaf) cancelAnimationFrame(edgeRaf);
    edgeRaf = 0;
    cancelDrag();
    vt?.skipTransition();
    for (const a of flips) a.cancel();
    document.documentElement.classList.remove('cal-vt');
    offMenu();
    offCal();
    offTasks();
    offHabits();
    offDay();
    clearInterval(clock);
    onResize.cancel();
    ro?.disconnect();
    menuWatch.disconnect();
    if (fitRaf) cancelAnimationFrame(fitRaf);
    showDd.close();
    viewDd.close();
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('resize', onResize);
    phoneMq.removeEventListener('change', onMq);
    coarseMq.removeEventListener('change', onMq);
    remember();
  };
}

export default {
  id: 'calendar',
  title: 'Calendar',
  icon: 'calendar',
  badge,
  mount,
};
