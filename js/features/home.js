// LIFE/OS — 01 // Home: the start page, today at a glance. A greeting with what's next, and a
// board of widgets you arrange yourself (Customize): the week, the Pomodoro timer, today's habits,
// the to-do list, a quick note, the habit graph, a clock, the agenda, payments and training.
// Drag a widget by its handle (or move it with the arrow keys), pick its size, remove it, or add
// one from the shelf; the layout is per device (store 'home'.layout, rules in home.logic.js).
//
// Home keeps no data of its own (only its layout and the quick note's last section): it reads
// and writes through the other modules' APIs (tasksApi, habitsApi, notesApi, calendarApi,
// pomodoroApi), so their pages, nav badges and other windows stay in sync. Pure helpers live in
// home.logic.js (unit-tested).

import {
  h,
  icon,
  registerIcon,
  pageHeader,
  checkButton,
  setChecked,
  toast,
  openModal,
  todayKey,
  shiftKey,
  parseKey,
  formatDay,
  timeAgo,
  onDayChange,
  num,
  term,
  plural,
  isTyping,
  modalOpen,
  WEEKDAYS_SHORT,
  WEEKDAYS_MIN,
  plainSkin,
  promptDialog,
} from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import { splitText } from '../contextmenu.logic.js';
import { tasksApi } from './tasks.js';
import { parseQuickAdd } from './tasks.logic.js';
import { habitsApi } from './habits.js';
import { habitsForDay } from './habits.logic.js';
import { dailySeries } from './habits.stats.js';
import { notesApi } from './notes.js';
import { getEvents, subscribeCalendar } from './calendar.store.js';
import { calendarApi } from './calendar.js';
import { occurrencesInRange, weekKeys, mondayOf, viewTitle, tasksByDay, overdueTasks, habitsByDay, daysBetween } from './calendar.logic.js';
import { eventBar, taskChip, habitMeter, priorityBadge, PRIORITY_TAG } from './calendar.views.js';
import { pomodoroApi, roundText } from './pomodoro.js';
import { financeApi } from './finance.js';
import { upcoming as upcomingPayments, totals as paymentTotals } from './finance.logic.js';
import { trainingApi } from './training.js';
import { weekStats, lastDone, sessionElapsed, restLeft, formatDuration } from './training.logic.js';
import { PHASE_LABEL } from './pomodoro.logic.js';
import * as HM from './home.logic.js';

const prefs = createStore('home', { quickNoteSection: null });

registerIcon('hm-layout', '<rect x="3.5" y="3.5" width="7.5" height="9" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="5" rx="1.5"/><rect x="13" y="10.5" width="7.5" height="10" rx="1.5"/><rect x="3.5" y="14.5" width="7.5" height="6" rx="1.5"/>');

/** The icon each widget has in its header and on the Add shelf. */
const WIDGET_ICON = { week: 'calendar', pomodoro: 'timer', todo: 'list', habits: 'target', graph: 'activity', note: 'note', clock: 'clock', agenda: 'calendar', payments: 'wallet', training: 'dumbbell' };
const AGENDA_MAX = 8;
const PAY_MAX = 5;

const DAY_ITEMS = 5; // per day in the week before "+N more"
const TODO_MAX = 7;
const GRAPH_DAYS = 14;
const AHEAD_DAYS = 14; // how far "Next:" looks
const LINGER_MS = 900; // a checked to-do keeps its row for a beat
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

// The quick note being written: kept if the dialog closes unsaved, until the window closes
let draft = { title: '', body: '' };

const clip = (text, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/** Repaint a part of the page and give focus back to the control it had (by data-fid). */
function keepFocus(container, paint) {
  const active = document.activeElement;
  const fid = active instanceof HTMLElement && container.contains(active) ? active.dataset.fid : null;
  paint();
  if (fid) container.querySelector(`[data-fid="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
}

function cardHead(id, iconName, title, extra = null) {
  return h('header', { class: 'hm-card-head' }, h('h2', { class: 'hm-card-title', id }, icon(iconName, { size: 15 }), h('span', null, title)), extra);
}

function moreLink({ href, label, onClick }) {
  return h(
    'a',
    {
      class: 'hm-more',
      href,
      onClick: onClick
        ? (e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onClick();
          }
        : null,
    },
    h('span', null, label),
    icon('chevron-right', { size: 14 }),
  );
}

/* ==========================================================================
   Quick note
   ========================================================================== */

function openQuickNote() {
  if (modalOpen()) return;
  const sections = notesApi.getSections();
  const last = prefs.get().quickNoteSection;
  const titleIn = h('input', { class: 'input hm-qn-title', id: 'hm-qn-title', type: 'text', placeholder: 'Title', autocomplete: 'off', value: draft.title });
  const bodyIn = h('textarea', { class: 'textarea hm-qn-body', id: 'hm-qn-body', rows: '6', placeholder: 'Write it down…', value: draft.body });
  const select = h(
    'select',
    { class: 'select hm-qn-section', id: 'hm-qn-section' },
    h('option', { value: '' }, 'Unsorted'),
    sections.map((s) => h('option', { value: s.id }, s.name)),
  );
  select.value = sections.some((s) => s.id === last) ? last : '';
  let saved = false;
  let m;

  const save = () => {
    const sectionId = select.value || null;
    const note = notesApi.addNote({ title: titleIn.value, body: bodyIn.value, sectionId });
    if (!note) {
      toast('Write something first.');
      titleIn.focus();
      return;
    }
    saved = true;
    draft = { title: '', body: '' };
    if ((prefs.get().quickNoteSection ?? null) !== sectionId) prefs.update({ quickNoteSection: sectionId });
    m.close();
    const where = sectionId ? sections.find((s) => s.id === sectionId)?.name ?? 'Notes' : 'Unsorted';
    toast(`Note saved to ${where}.`, { action: { label: 'Open', onClick: () => notesApi.reveal(note.id) } });
  };

  titleIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      bodyIn.focus();
    }
  });

  m = openModal({
    title: 'Quick note',
    className: 'hm-qn',
    body: [
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'hm-qn-title' }, 'Title'), titleIn),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'hm-qn-body' }, 'Note'), bodyIn),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'hm-qn-section' }, 'Save to'), select),
    ],
    footer: [
      h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', 'aria-keyshortcuts': IS_MAC ? 'Meta+Enter' : 'Control+Enter', onClick: save },
        icon('check'),
        'Save',
        h('span', { class: 'kbd hm-qn-kbd lo-hint', 'aria-hidden': 'true' }, IS_MAC ? '⌘↵' : 'Ctrl+↵'),
      ),
    ],
    initialFocus: titleIn,
    onClose: () => {
      if (!saved) draft = { title: titleIn.value, body: bodyIn.value };
    },
  });
  m.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });
}

/* ==========================================================================
   Page
   ========================================================================== */

function mount(root) {
  root.classList.add('hm-page');
  const simple = plainSkin();
  const state = { today: todayKey(), week: mondayOf(todayKey()) };
  let todoHoldUntil = 0;
  let todoTimer = 0;

  /* ---- Header: greeting, today's date, what's next ---- */

  const quickBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary hm-quick', 'aria-keyshortcuts': 'Q', onClick: () => openQuickNote() },
    icon('edit'),
    h('span', null, 'Quick note'),
    h('span', { class: 'kbd hm-kbd lo-hint', 'aria-hidden': 'true' }, 'Q'),
  );
  // Customize: arrange the widgets (Done leaves it)
  const customizeBtn = h('button', { type: 'button', class: 'btn hm-customize', 'aria-pressed': 'false', onClick: () => setEditing(!editing) });
  const header = pageHeader({ index: '01', title: HM.greeting(new Date().getHours()), subtitle: formatDay(state.today, 'long'), actions: [customizeBtn, quickBtn] });
  const titleEl = header.querySelector('.page-title');
  const subEl = header.querySelector('.page-subtitle');
  const nextEl = h('button', { type: 'button', class: 'hm-next' });
  header.querySelector('.page-heading').append(nextEl);
  let nextDay = null;
  nextEl.addEventListener('click', () => calendarApi.open(nextDay ?? state.today, 'day'));

  function nextText(up) {
    if (!up) return 'Nothing scheduled';
    const o = up.occ;
    if (up.kind === 'now') return `Now: ${o.title}, until ${o.endTime}`;
    if (up.kind === 'today') return `Next: ${o.startTime} ${o.title}`;
    if (up.kind === 'allday') return `Today: ${o.title}`;
    const day = o.start === shiftKey(state.today, 1) ? 'Tomorrow' : formatDay(o.start);
    return o.allDay ? `Next: ${day}, ${o.title}` : `Next: ${day} ${o.startTime}, ${o.title}`;
  }

  function paintHeader() {
    titleEl.textContent = HM.greeting(new Date().getHours());
    subEl.textContent = formatDay(state.today, 'long');
    const occs = occurrencesInRange(getEvents(), state.today, shiftKey(state.today, AHEAD_DAYS));
    const up = HM.nextUp(occs, state.today, nowMinutes());
    nextDay = up ? (up.occ.start > state.today ? up.occ.start : state.today) : null;
    nextEl.replaceChildren(icon(up?.kind === 'now' ? 'activity' : 'clock', { size: 14 }), h('span', null, nextText(up)));
    nextEl.classList.toggle('is-empty', !up);
    nextEl.title = up ? 'Open this day in the Calendar' : 'Open today in the Calendar';
  }

  /* ---- Week overview ---- */

  const weekTitle = h('h2', { class: 'hm-week-title', id: 'hm-week-title', 'aria-live': 'polite' });
  const prevBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Previous week', title: 'Previous week (←)', onClick: () => moveWeek(-1) }, icon('chevron-left'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', 'aria-label': 'Next week', title: 'Next week (→)', onClick: () => moveWeek(1) }, icon('chevron-right'));
  const thisWeekBtn = h('button', { type: 'button', class: 'btn btn--sm hm-week-now', title: 'Back to this week (T)', onClick: () => goWeek(mondayOf(state.today)) }, 'This week');
  const daysEl = h('div', { class: 'hm-days' });
  const weekEmpty = h(
    'div',
    { class: 'hm-week-empty', hidden: true },
    h('span', null, 'Nothing planned this week.'),
    h('button', { type: 'button', class: 'btn btn--sm', onClick: () => calendarApi.open(state.week === mondayOf(state.today) ? state.today : state.week, 'week') }, icon('calendar', { size: 14 }), 'Plan the week'),
  );
  const weekCard = h(
    'section',
    { class: 'panel hud hm-card hm-week', 'aria-labelledby': 'hm-week-title' },
    h(
      'header',
      { class: 'hm-week-head' },
      h('div', { class: 'hm-week-kicker label lo-deco' }, 'Week'),
      weekTitle,
      h('div', { class: 'hm-week-nav' }, thisWeekBtn, prevBtn, nextBtn, moreLink({ href: '#/calendar', label: simple ? 'Calendar' : 'Open calendar' })),
    ),
    daysEl,
    weekEmpty,
  );

  function goWeek(monday) {
    if (monday === state.week) return;
    state.week = monday;
    paintWeek();
  }

  const moveWeek = (delta) => goWeek(shiftKey(state.week, 7 * delta));

  function dayCell(d, ctx, info) {
    const items = [...d.events.map((occ) => ({ occ })), ...d.tasks.map((task) => ({ task }))];
    const { shown, more } = HM.clipItems(items, DAY_ITEMS);
    const date = parseKey(d.key);
    const openTasks = d.tasks.length;
    const label = `${formatDay(d.key, 'long')}${d.isToday ? ', today' : ''}: ${plural(d.events.length, 'event')}, ${plural(openTasks, 'open task')}. Open in the Calendar`;
    return h(
      'div',
      { class: ['hm-day', d.isToday && 'is-today', d.isPast && 'is-past', d.isWeekend && 'is-weekend'], dataset: { key: d.key } },
      h(
        'button',
        { type: 'button', class: 'hm-day-head', 'aria-label': label, dataset: { fid: `day:${d.key}` } },
        h('span', { class: 'hm-day-wd' }, WEEKDAYS_SHORT[date.getDay()]),
        h('span', { class: 'hm-day-num tnum' }, String(date.getDate())),
        d.isToday ? h('span', { class: 'hm-day-tag' }, 'Today') : null,
      ),
      h(
        'div',
        { class: 'hm-day-items' },
        shown.map((it) => (it.occ ? eventBar(it.occ, ctx, { prefix: 'hm', tab: '-1', drag: false, glyph: false }) : taskChip(it.task, ctx, { prefix: 'hm', tab: '-1' }))),
        more ? h('span', { class: 'hm-day-more' }, `+${more} more`) : null,
        items.length ? null : h('span', { class: 'hm-day-free' }, d.isPast ? '—' : simple ? 'Free' : 'Clear'),
      ),
      habitMeter(info, { max: 5, readout: !simple }),
    );
  }

  function paintWeek() {
    const keys = weekKeys(state.week);
    const from = keys[0];
    const to = keys[6];
    const occs = occurrencesInRange(getEvents(), from, to);
    const byDay = tasksByDay(tasksApi.getItems(), from, to);
    const habits = habitsByDay(habitsApi.source.getItems(), from, to, state.today);
    const days = HM.weekDays(keys, occs, byDay, state.today);
    const ctx = { today: state.today, nowMin: nowMinutes() };
    weekTitle.textContent = viewTitle('week', state.week, { weekNumber: !simple });
    thisWeekBtn.hidden = state.week === mondayOf(state.today);
    keepFocus(daysEl, () => daysEl.replaceChildren(...days.map((d) => dayCell(d, ctx, habits.get(d.key)))));
    const quiet = days.every((d) => !d.events.length && !d.tasks.length);
    daysEl.classList.toggle('is-quiet', quiet);
    weekEmpty.hidden = !quiet;
  }

  daysEl.addEventListener('click', (e) => {
    const check = e.target.closest('[data-act="task-check"]');
    if (check) {
      const id = check.dataset.task;
      const done = check.getAttribute('aria-checked') === 'true';
      if (done) tasksApi.setDone(id, false);
      else completeTask(id);
      return;
    }
    const day = e.target.closest('.hm-day');
    if (day && daysEl.contains(day)) calendarApi.open(day.dataset.key, 'day');
  });

  /* ---- Pomodoro ---- */

  const pomo = (() => {
    const phaseEl = h('span', { class: 'hm-pomo-phase' });
    const roundEl = h('span', { class: 'hm-pomo-round' });
    const digits = h('div', { class: 'hm-pomo-digits tnum', role: 'timer', 'aria-atomic': 'true' });
    const fill = h('div', { class: 'progress-fill hm-pomo-fill' });
    const bar = h('div', { class: 'progress hm-pomo-bar', 'aria-hidden': 'true' }, fill);
    const mainBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm hm-pomo-main', onClick: () => pomodoroApi.toggle() });
    const skipBtn = h('button', { type: 'button', class: 'btn btn--sm hm-pomo-skip', onClick: () => pomodoroApi.skip() }, icon('skip', { size: 14 }), h('span', null, 'Skip'));
    const taskEl = h('p', { class: 'hm-pomo-task' });
    const card = h(
      'section',
      { class: 'panel hm-card hm-pomo', 'aria-labelledby': 'hm-pomo-title' },
      cardHead('hm-pomo-title', 'timer', simple ? 'Focus timer' : 'Pomodoro', moreLink({ href: '#/pomodoro', label: 'Open timer' })),
      h('div', { class: 'hm-pomo-body' }, h('div', { class: 'hm-pomo-meta' }, phaseEl, roundEl), digits, bar, h('div', { class: 'hm-pomo-ctl' }, mainBtn, skipBtn), taskEl),
    );
    let verb = '';
    const paint = (v) => {
      card.dataset.phase = v.phase;
      card.dataset.status = v.status;
      phaseEl.textContent = v.status === 'paused' ? `${PHASE_LABEL[v.phase]} · Paused` : PHASE_LABEL[v.phase];
      roundEl.textContent = roundText(v.round, v.rounds);
      if (digits.textContent !== v.clock) digits.textContent = v.clock;
      const left = Math.ceil(v.left / 60000);
      digits.setAttribute('aria-label', `${PHASE_LABEL[v.phase]}: ${left} ${left === 1 ? 'minute' : 'minutes'} left`);
      fill.style.width = `${Math.round(v.fraction * 1000) / 10}%`;
      const nextVerb = v.status === 'running' ? 'Pause' : v.status === 'paused' ? 'Resume' : 'Start';
      if (nextVerb !== verb) {
        verb = nextVerb;
        mainBtn.replaceChildren(icon(v.status === 'running' ? 'pause' : 'play', { size: 14 }), h('span', null, verb));
      }
      skipBtn.title = `Skip to ${PHASE_LABEL[v.next.phase]}`;
      skipBtn.setAttribute('aria-label', `Skip to ${PHASE_LABEL[v.next.phase]}`);
      const task = v.state.taskId ? tasksApi.getItems().find((t) => t.id === v.state.taskId) : null;
      taskEl.hidden = !task;
      if (task) taskEl.replaceChildren(h('span', { class: 'hm-pomo-task-label' }, 'Focusing on'), ' ', h('span', { class: 'hm-pomo-task-name' }, task.title));
    };
    return { card, paint };
  })();

  /* ---- Habits today ---- */

  const habitsBody = h('div', { class: 'hm-habits-body' });
  const habitsCount = h('span', { class: 'hm-count tnum' });
  const habitsCard = h(
    'section',
    { class: 'panel hm-card hm-habits', 'aria-labelledby': 'hm-habits-title' },
    cardHead('hm-habits-title', 'target', simple ? 'Habits today' : 'Habits · today', h('div', { class: 'hm-card-tools' }, habitsCount, moreLink({ href: '#/habits', label: 'Habits', onClick: () => habitsApi.source.openTab('today') }))),
    habitsBody,
  );

  function miniEmpty({ iconName, title, text, action }) {
    return h('div', { class: 'hm-empty' }, h('span', { class: 'hm-empty-icon' }, icon(iconName, { size: 18 })), h('div', { class: 'hm-empty-text' }, h('strong', null, title), text ? h('span', null, text) : null), action ?? null);
  }

  function paintHabits() {
    const items = habitsApi.source.getItems();
    const today = state.today;
    const planned = habitsForDay(items, today);
    const done = planned.filter((hb) => hb.log?.[today]).length;
    habitsCount.textContent = planned.length ? `${num(done)}/${num(planned.length)}` : '';
    if (!items.some((hb) => !hb.archivedAt || hb.archivedAt > today)) {
      habitsBody.replaceChildren(
        miniEmpty({
          iconName: 'target',
          title: 'No habits yet',
          text: 'Small things you do on chosen days, like a walk or reading.',
          action: h('button', { type: 'button', class: 'btn btn--sm', onClick: () => (location.hash = '#/habits') }, icon('plus', { size: 14 }), 'Add a habit'),
        }),
      );
      return;
    }
    if (!planned.length) {
      habitsBody.replaceChildren(
        miniEmpty({
          iconName: 'sun',
          title: 'Nothing planned today',
          text: 'A rest day. Enjoy it.',
          action: h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onClick: () => habitsApi.source.openTab('plan') }, 'Week plan'),
        }),
      );
      return;
    }
    const pct = planned.length ? done / planned.length : 0;
    const ring = ringEl(pct, `${done}/${planned.length}`);
    const rows = planned.map((hb) => {
      const isDone = !!hb.log?.[today];
      const check = checkButton({ checked: isDone, label: `${hb.name}: done today`, onToggle: (next) => habitsApi.setLog(hb.id, today, next) });
      check.dataset.fid = `hb:${hb.id}`;
      return h('li', { class: ['hm-habit', isDone && 'is-done'] }, check, h('span', { class: 'hm-habit-name' }, hb.name));
    });
    keepFocus(habitsBody, () =>
      habitsBody.replaceChildren(
        h(
          'div',
          { class: 'hm-habits-sum' },
          ring,
          h('p', { class: 'hm-habits-line' }, done === planned.length ? term('habits.allDone', 'All done for today.') : `${planned.length - done} to go today`),
        ),
        h('ul', { class: 'hm-habit-list', 'aria-label': 'Habits planned today' }, rows),
      ),
    );
  }

  /** A small progress ring with a done / planned readout. */
  function ringEl(value, text) {
    const size = 56;
    const stroke = 4;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    for (const cls of ['ring-track', 'ring-fill']) {
      const el = document.createElementNS(ns, 'circle');
      el.setAttribute('class', cls);
      el.setAttribute('cx', String(size / 2));
      el.setAttribute('cy', String(size / 2));
      el.setAttribute('r', String(r));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-width', String(stroke));
      if (cls === 'ring-fill') {
        el.setAttribute('stroke-dasharray', String(c));
        el.style.strokeDashoffset = String(c * (1 - value));
        if (!value) el.style.opacity = '0';
      }
      svg.append(el);
    }
    return h('div', { class: 'ring hm-ring', role: 'img', 'aria-label': `${text} habits done` }, svg, h('div', { class: 'ring-label hm-ring-label tnum', 'aria-hidden': 'true' }, text));
  }

  /* ---- To do ---- */

  const todoList = h('ul', { class: 'hm-tasks', 'aria-label': 'To do today' });
  const todoFoot = h('div', { class: 'hm-todo-foot' });
  const todoCount = h('span', { class: 'hm-count tnum' });
  const addInput = h('input', {
    class: 'input hm-add-input',
    type: 'text',
    maxlength: '500',
    autocomplete: 'off',
    enterkeyhint: 'done',
    placeholder: simple ? 'Add a task for today' : 'Add a task for today…  !h high',
    'aria-label': 'Add a task for today (priority: !h, !m, !l)',
    'aria-keyshortcuts': 'N',
  });
  const addForm = h(
    'form',
    {
      class: 'hm-add',
      onSubmit: (e) => {
        e.preventDefault();
        addTask();
      },
    },
    h('span', { class: 'hm-add-icon', 'aria-hidden': 'true' }, icon('plus', { size: 14 })),
    addInput,
    h('button', { type: 'submit', class: 'btn btn--sm hm-add-btn' }, 'Add'),
  );
  const todoCard = h(
    'section',
    { class: 'panel hm-card hm-todo', 'aria-labelledby': 'hm-todo-title' },
    cardHead('hm-todo-title', 'list', 'To do', h('div', { class: 'hm-card-tools' }, todoCount, moreLink({ href: '#/tasks', label: 'All tasks' }))),
    addForm,
    todoList,
    todoFoot,
  );

  function addTask() {
    const text = addInput.value.trim();
    if (!text) {
      addInput.focus();
      return;
    }
    const parsed = parseQuickAdd(text, state.today);
    const due = parsed.due ?? state.today;
    const task = tasksApi.addTask({ title: parsed.title || text, due, priority: parsed.priority ?? 'none' });
    if (!task) return;
    addInput.value = '';
    if (due !== state.today) {
      const when = due === shiftKey(state.today, 1) ? 'tomorrow' : formatDay(due);
      toast(`Added “${clip(task.title)}” for ${when}.`, { action: { label: 'Show', onClick: () => tasksApi.reveal(task.id) } });
    }
  }

  function completeTask(id, row = null) {
    const task = tasksApi.getItems().find((t) => t.id === id);
    if (!task || task.done) return;
    // The row stays a moment, checked, so it doesn't jump out from under the pointer
    todoHoldUntil = Date.now() + LINGER_MS;
    if (row) {
      row.classList.add('is-done');
      const check = row.querySelector('.check');
      if (check) setChecked(check, true);
    }
    if (!tasksApi.setDone(id, true)) return;
    toast(`Completed “${clip(task.title)}”.`, { action: { label: 'Undo', onClick: () => tasksApi.setDone(id, false) } });
  }

  function taskRow({ task, overdueDays }) {
    const pri = PRIORITY_TAG[task.priority];
    const row = h('li', { class: ['hm-task', overdueDays && 'is-overdue', `pri-${task.priority}`], dataset: { task: task.id } });
    const check = checkButton({
      checked: false,
      label: `Complete ${task.title}${pri ? `, ${pri.text.toLowerCase()} priority` : ''}${overdueDays ? ', overdue' : ''}`,
      onToggle: (next) => (next ? completeTask(task.id, row) : tasksApi.setDone(task.id, false)),
    });
    check.dataset.fid = `todo:${task.id}`;
    // Native append() would print a null as "null": only the parts this task has
    const parts = [
      check,
      h('button', { type: 'button', class: 'hm-task-title', title: 'Show in Tasks', dataset: { fid: `todo-t:${task.id}` }, onClick: () => tasksApi.reveal(task.id) }, task.title),
      overdueDays ? h('span', { class: 'tag tag--dashed hm-task-late' }, overdueDays === 1 ? 'Yesterday' : `${overdueDays} days late`) : null,
      priorityBadge(task.priority),
    ];
    row.append(...parts.filter(Boolean));
    return row;
  }

  function paintTodo() {
    const wait = todoHoldUntil - Date.now();
    if (wait > 0) {
      clearTimeout(todoTimer);
      todoTimer = setTimeout(paintTodo, wait + 10);
      return;
    }
    const tasks = tasksApi.getItems();
    const overdue = overdueTasks(tasks, state.today);
    const dueToday = tasksByDay(tasks, state.today, state.today).get(state.today) ?? [];
    const rows = HM.todoList(overdue, dueToday, state.today, daysBetween);
    todoCount.textContent = rows.length ? num(rows.length) : '';
    keepFocus(todoCard, () => {
      todoList.replaceChildren(...rows.slice(0, TODO_MAX).map(taskRow));
      todoList.hidden = !rows.length;
      const foot = [];
      if (!rows.length) {
        const open = tasks.filter((t) => !t.done).length;
        foot.push(miniEmpty({ iconName: 'check', title: 'Nothing due today', text: open ? `${plural(open, 'open task')} for later. Add one for today above.` : 'Add one above, or plan the week in Tasks.' }));
      } else if (rows.length > TODO_MAX) {
        foot.push(moreLink({ href: '#/tasks', label: `${rows.length - TODO_MAX} more in Tasks` }));
      }
      todoFoot.replaceChildren(...foot);
    });
  }

  /* ---- Quick note ---- */

  const recentList = h('ul', { class: 'hm-recent', 'aria-label': 'Recent notes' });
  const noteCard = h(
    'section',
    { class: 'panel hm-card hm-note', 'aria-labelledby': 'hm-note-title' },
    cardHead('hm-note-title', 'note', 'Quick note', moreLink({ href: '#/notes', label: 'Notes' })),
    h(
      'button',
      { type: 'button', class: 'btn hm-note-btn', 'aria-keyshortcuts': 'Q', onClick: () => openQuickNote() },
      icon('edit'),
      h('span', { class: 'hm-note-btn-text' }, simple ? 'Write a quick note' : 'New quick note'),
      h('span', { class: 'kbd hm-kbd lo-hint', 'aria-hidden': 'true' }, 'Q'),
    ),
    recentList,
  );

  function paintRecent() {
    const notes = notesApi.recent(3);
    recentList.hidden = !notes.length;
    keepFocus(recentList, () =>
      recentList.replaceChildren(
        ...notes.map((n) => {
          const title = n.title.trim() || n.body.trim().split('\n')[0].slice(0, 80) || 'Untitled';
          return h(
            'li',
            null,
            h('button', { type: 'button', class: 'hm-recent-item', dataset: { fid: `note:${n.id}` }, onClick: () => notesApi.reveal(n.id) }, h('span', { class: 'hm-recent-title' }, title), h('span', { class: 'hm-recent-time' }, timeAgo(n.updatedAt))),
          );
        }),
      ),
    );
  }

  /* ---- Habit graph ---- */

  const graphBody = h('div', { class: 'hm-graph-body' });
  const graphCard = h(
    'section',
    { class: 'panel hm-card hm-graph', 'aria-labelledby': 'hm-graph-title' },
    cardHead('hm-graph-title', 'activity', simple ? 'Habits, last two weeks' : 'Habit completion · 14D', moreLink({ href: '#/habits', label: 'Insights', onClick: () => habitsApi.source.openTab('insights') })),
    graphBody,
  );

  function paintGraph() {
    const items = habitsApi.source.getItems();
    const to = state.today;
    const from = shiftKey(to, -(GRAPH_DAYS - 1));
    const { bars, average } = HM.graphBars(dailySeries(items, from, to, to));
    if (!bars.some((b) => b.kind !== 'none')) {
      graphBody.replaceChildren(miniEmpty({ iconName: 'activity', title: 'No habit history yet', text: 'Tick off habits and the last two weeks show up here.' }));
      return;
    }
    const avgText = average == null ? 'No finished days yet' : simple ? `About ${Math.round(average * 100)}% of planned habits done` : `Avg ${Math.round(average * 100)}%`;
    const todayBar = bars[bars.length - 1];
    const summary = `Habit completion over the last ${GRAPH_DAYS} days: ${average == null ? 'no finished days yet' : `${Math.round(average * 100)}% on average`}${todayBar?.planned ? `; today ${todayBar.done} of ${todayBar.planned} so far` : ''}. Rest days are gaps.`;
    const cols = bars.map((b) => {
      const pct = b.rate == null ? 0 : Math.round(b.rate * 100);
      const tip = `${formatDay(b.key)}: ${b.kind === 'rest' ? 'rest day' : b.kind === 'none' ? 'no habits yet' : `${b.done} of ${b.planned} done${b.kind === 'today' ? ' so far' : ''}`}`;
      return h(
        'div',
        { class: ['hm-bar', `is-${b.kind}`, b.key === to && 'is-now'], title: tip },
        h('span', { class: 'hm-bar-track' }, b.kind === 'day' || b.kind === 'today' ? h('span', { class: 'hm-bar-fill', style: { height: `${Math.max(pct, b.done ? 4 : 0)}%` } }) : null),
        h('span', { class: 'hm-bar-day', 'aria-hidden': 'true' }, WEEKDAYS_MIN[b.weekday]),
      );
    });
    graphBody.replaceChildren(
      h('div', { class: 'hm-bars', role: 'img', 'aria-label': summary }, cols),
      h('p', { class: 'hm-graph-note' }, h('span', { class: 'hm-graph-avg' }, avgText), h('span', { class: 'hm-graph-key' }, 'Gaps are rest days')),
    );
  }

  /* ---- Clock ---- */

  const clockTime = h('div', { class: 'hm-clock-time tnum', role: 'timer', 'aria-live': 'off' });
  const clockDate = h('div', { class: 'hm-clock-date' });
  const clockCard = h('section', { class: 'panel hm-card hm-clock', 'aria-label': 'Clock' }, clockTime, clockDate);
  let clockShown = '';

  function paintClock() {
    // 24-hour, like the clock in the top bar
    const d = new Date();
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (t !== clockShown) {
      clockShown = t;
      clockTime.textContent = t;
      clockDate.textContent = formatDay(state.today, 'long');
    }
  }

  /* ---- Agenda: the next events, day by day ---- */

  const agendaBody = h('div', { class: 'hm-agenda-body' });
  const agendaCard = h(
    'section',
    { class: 'panel hm-card hm-agenda', 'aria-labelledby': 'hm-agenda-title' },
    cardHead('hm-agenda-title', 'calendar', 'Agenda', moreLink({ href: '#/calendar', label: 'Calendar' })),
    agendaBody,
  );

  function paintAgenda() {
    const now = nowMinutes();
    const occs = occurrencesInRange(getEvents(), state.today, shiftKey(state.today, 13))
      .filter((o) => !(o.start === state.today && !o.allDay && o.endMin <= now))
      .map((o) => ({ o, day: o.start < state.today ? state.today : o.start }))
      .sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : Number(!a.o.allDay) - Number(!b.o.allDay) || (a.o.startMin ?? 0) - (b.o.startMin ?? 0)))
      .slice(0, AGENDA_MAX);
    if (!occs.length) {
      agendaBody.replaceChildren(miniEmpty({ iconName: 'calendar', title: 'Nothing coming up', text: 'Events of the next two weeks show up here.' }));
      return;
    }
    const groups = [];
    for (const it of occs) {
      if (groups[groups.length - 1]?.day !== it.day) groups.push({ day: it.day, items: [] });
      groups[groups.length - 1].items.push(it.o);
    }
    const dayName = (key) => (key === state.today ? 'Today' : key === shiftKey(state.today, 1) ? 'Tomorrow' : formatDay(key));
    keepFocus(agendaBody, () =>
      agendaBody.replaceChildren(
        ...groups.map((g) =>
          h(
            'div',
            { class: 'hm-agenda-day' },
            h('h3', { class: 'hm-agenda-when label' }, dayName(g.day)),
            h(
              'ul',
              { class: 'hm-agenda-list' },
              g.items.map((o) =>
                h(
                  'li',
                  null,
                  h(
                    'button',
                    { type: 'button', class: 'hm-agenda-item', dataset: { fid: `ag:${o.occId}` }, title: 'Open this day in the Calendar', onClick: () => calendarApi.open(g.day, 'day') },
                    h('span', { class: 'hm-agenda-time tnum' }, o.allDay ? 'All day' : o.startTime),
                    h('span', { class: 'hm-agenda-title' }, o.title),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /* ---- Payments: subscriptions due soon ---- */

  const payBody = h('div', { class: 'hm-pay-body' });
  const payCard = h(
    'section',
    { class: 'panel hm-card hm-pay', 'aria-labelledby': 'hm-pay-title' },
    cardHead('hm-pay-title', 'wallet', 'Payments', moreLink({ href: '#/finance', label: 'Finance' })),
    payBody,
  );

  function paintPayments() {
    const subs = financeApi.subscriptions();
    if (!subs.length) {
      payBody.replaceChildren(
        miniEmpty({
          iconName: 'wallet',
          title: 'No subscriptions yet',
          text: 'Add what you pay every month or year.',
          action: h('button', { type: 'button', class: 'btn btn--sm', onClick: () => financeApi.add() }, icon('plus', { size: 14 }), 'Add one'),
        }),
      );
      return;
    }
    const month = paymentTotals(subs).month;
    const list = upcomingPayments(subs, state.today, 30).slice(0, PAY_MAX);
    const when = (d) => (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d < 7 ? `In ${d} days` : null);
    payBody.replaceChildren(
      h(
        'p',
        { class: 'hm-pay-total' },
        h('span', { class: 'stat-value hm-pay-sum' }, month.length ? financeApi.money(month[0].amount, month[0].currency, { round: true }) : '—'),
        h('span', { class: 'hm-pay-per' }, month.length > 1 ? ` a month + ${month.slice(1).map((m) => financeApi.money(m.amount, m.currency, { round: true })).join(' + ')}` : ' a month'),
      ),
      list.length
        ? h(
            'ul',
            { class: 'hm-pay-list', 'aria-label': 'Next payments' },
            list.map((u) =>
              h(
                'li',
                { class: ['hm-pay-row', u.inDays <= 3 && 'is-soon'] },
                h('span', { class: 'hm-pay-when' }, when(u.inDays) ?? formatDay(u.date)),
                h('span', { class: 'hm-pay-name' }, u.sub.name, u.trialEnd ? h('span', { class: 'hm-pay-trial' }, ' · trial ends') : null),
                h('span', { class: 'hm-pay-amount tnum' }, financeApi.money(u.sub.amount, u.sub.currency)),
              ),
            ),
          )
        : h('p', { class: 'hm-pay-none' }, 'Nothing to pay in the next 30 days.'),
    );
  }

  /* ---- Training: start a routine, or get back to the workout going on ---- */

  const trainBody = h('div', { class: 'hm-train-body' });
  const trainCard = h(
    'section',
    { class: 'panel hm-card hm-train', 'aria-labelledby': 'hm-train-title' },
    cardHead('hm-train-title', 'dumbbell', 'Training', moreLink({ href: '#/training', label: 'Training' })),
    trainBody,
  );
  let trainSig = '';

  function paintTraining() {
    const s = trainingApi.getState();
    if (s.session) {
      const rest = restLeft(s.session);
      const sig = `live:${s.session.id}:${s.session.title}:${rest ? `r${rest}` : formatDuration(sessionElapsed(s.session))}`;
      if (sig === trainSig) return;
      trainSig = sig;
      keepFocus(trainBody, () =>
        trainBody.replaceChildren(
          h(
            'a',
            { class: 'hm-train-live', href: '#/training', dataset: { fid: 'train-live' } },
            h('span', { class: 'tr-live-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'hm-train-live-text' }, h('strong', null, s.session.title || 'Workout'), h('span', null, 'in progress')),
            h('span', { class: 'hm-train-live-time tnum' }, rest ? `Rest ${formatDuration(rest)}` : formatDuration(sessionElapsed(s.session))),
            h('span', { class: 'hm-train-go' }, 'Continue', icon('chevron-right', { size: 14 })),
          ),
        ),
      );
      return;
    }
    const w = weekStats(s, state.today);
    const routines = s.routines.slice(0, 4);
    const sig = `idle:${state.today}:${w.workouts}:${routines.map((r) => `${r.id}${r.name}${lastDone(s.workouts, r.id)?.date ?? ''}`).join(',')}`;
    if (sig === trainSig) return;
    trainSig = sig;
    keepFocus(trainBody, () =>
      trainBody.replaceChildren(
        h('p', { class: 'hm-train-week' }, h('span', { class: 'stat-value hm-train-count' }, String(w.workouts)), h('span', null, w.workouts === 1 ? ' workout this week' : ' workouts this week')),
        routines.length
          ? h(
              'ul',
              { class: 'hm-train-list', 'aria-label': 'Routines' },
              routines.map((r) => {
                const done = lastDone(s.workouts, r.id);
                return h(
                  'li',
                  { class: 'hm-train-row' },
                  h('span', { class: 'hm-train-name' }, r.name, h('span', { class: 'hm-train-last' }, done ? `Last ${formatDay(done.date)}` : 'Not done yet')),
                  h('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { fid: `train:${r.id}` }, 'aria-label': `Start ${r.name}`, onClick: () => trainingApi.startSession({ routine: r }) }, icon('play', { size: 13 }), 'Start'),
                );
              }),
            )
          : null,
        h('button', { type: 'button', class: 'btn btn--sm hm-train-start', dataset: { fid: 'train-start' }, onClick: () => trainingApi.startSession() }, icon('plus', { size: 14 }), routines.length ? 'Empty workout' : 'Start a workout'),
      ),
    );
  }

  /* ---- Your own Home: the board of widgets ----
     Each widget sits in a wrapper on a four-column board (css/features/home.css) at its size.
     Customize shows a bar on each (drag handle, size, remove) and the Add shelf below; the
     widgets themselves are inert meanwhile, so a drag never presses a button inside them. */

  const CARDS = { week: weekCard, pomodoro: pomo.card, todo: todoCard, habits: habitsCard, graph: graphCard, note: noteCard, clock: clockCard, agenda: agendaCard, payments: payCard, training: trainCard };
  const board = h('div', { class: 'hm-board' });
  const announce = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const editHint = h(
    'p',
    { class: 'hm-edit-hint', hidden: true },
    'Drag a widget by its handle (or focus the handle and use the arrow keys) to move it. Pick a size, remove what you don’t need, and add widgets from the shelf below. Press Done when it looks right.',
    h('span', { class: 'hm-hint-phone' }, ' On a phone every widget is full width; sizes show on a bigger screen.'),
  );
  const wraps = new Map();
  let editing = false;

  const layoutNow = () => HM.normalizeLayout(prefs.get().layout);
  const saveLayout = (layout) => prefs.update({ layout });
  const nameOf = (id) => HM.WIDGETS.find((w) => w.id === id)?.name ?? id;

  function setEditing(on) {
    editing = on;
    customizeBtn.setAttribute('aria-pressed', String(on));
    customizeBtn.classList.toggle('btn--primary', on);
    customizeBtn.replaceChildren(icon(on ? 'check' : 'hm-layout'), h('span', null, on ? 'Done' : 'Customize'));
    customizeBtn.title = on ? 'Finish arranging Home' : 'Choose and arrange the widgets on Home';
    quickBtn.hidden = on;
    editHint.hidden = !on;
    renderBoard();
    if (on) board.querySelector('.hm-wgrip')?.focus({ preventScroll: true });
  }

  function widgetBar(item) {
    const name = nameOf(item.id);
    const grip = h(
      'button',
      { type: 'button', class: 'hm-wgrip', 'aria-label': `Move ${name}: drag, or use the arrow keys`, title: 'Drag to move (or arrow keys)', onPointerdown: (e) => startDrag(e, item.id), onKeydown: (e) => gripKey(e, item.id) },
      icon('grip', { size: 16 }),
    );
    const sizes = h(
      'div',
      { class: 'seg hm-wsizes', role: 'group', 'aria-label': `Size of ${name}` },
      HM.SIZES.map((sz) =>
        h(
          'button',
          {
            type: 'button',
            class: 'seg-btn',
            'aria-pressed': String(item.size === sz),
            title: HM.SIZE_LABEL[sz],
            'aria-label': HM.SIZE_LABEL[sz],
            onClick: () => {
              saveLayout(HM.resizeWidget(layoutNow(), item.id, sz));
              announce.textContent = `${name}: ${HM.SIZE_LABEL[sz]}.`;
            },
          },
          sz === 'xl' ? 'Full' : sz.toUpperCase(),
        ),
      ),
    );
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--icon btn--sm hm-wremove',
        'aria-label': `Remove ${name} from Home`,
        title: 'Remove from Home',
        onClick: () => {
          saveLayout(HM.removeWidget(layoutNow(), item.id));
          announce.textContent = `${name} removed. Add it back from the shelf.`;
        },
      },
      icon('x', { size: 14 }),
    );
    return h('div', { class: 'hm-wbar' }, grip, h('span', { class: 'hm-wname' }, icon(WIDGET_ICON[item.id], { size: 14 }), name), sizes, remove);
  }

  function addShelf() {
    const hidden = HM.hiddenWidgets(layoutNow());
    return h(
      'section',
      { class: 'panel hm-shelf', 'aria-labelledby': 'hm-shelf-title' },
      h(
        'header',
        { class: 'hm-card-head' },
        h('h2', { class: 'hm-card-title', id: 'hm-shelf-title' }, icon('plus', { size: 15 }), h('span', null, 'Add widgets')),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost', onClick: () => resetLayout() }, 'Reset to default'),
      ),
      hidden.length
        ? h(
            'ul',
            { class: 'hm-shelf-list' },
            hidden.map((w) =>
              h(
                'li',
                { class: 'hm-shelf-item' },
                h('span', { class: 'hm-shelf-icon', 'aria-hidden': 'true' }, icon(WIDGET_ICON[w.id], { size: 18 })),
                h('span', { class: 'hm-shelf-text' }, h('strong', null, w.name), h('span', null, w.text)),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn--sm',
                    'aria-label': `Add ${w.name}`,
                    onClick: () => {
                      saveLayout(HM.addWidget(layoutNow(), w.id));
                      announce.textContent = `${w.name} added at the end.`;
                    },
                  },
                  icon('plus', { size: 14 }),
                  'Add',
                ),
              ),
            ),
          )
        : h('p', { class: 'hm-shelf-none' }, 'Every widget is on your Home.'),
    );
  }

  function resetLayout() {
    const before = layoutNow();
    saveLayout(HM.DEFAULT_LAYOUT.map((w) => ({ ...w })));
    toast('Home has its usual widgets again.', { action: { label: 'Undo', onClick: () => saveLayout(before) } });
  }

  function renderBoard() {
    const layout = layoutNow();
    const active = document.activeElement;
    const focusWidget = active instanceof Element && active.classList.contains('hm-wgrip') ? active.closest('.hm-widget')?.dataset.widget : null;
    const nodes = layout.map((item) => {
      let wrap = wraps.get(item.id);
      if (!wrap) {
        wrap = h('div', { class: 'hm-widget', dataset: { widget: item.id } });
        wraps.set(item.id, wrap);
      }
      wrap.dataset.size = item.size;
      wrap.classList.toggle('is-editing', editing);
      const card = CARDS[item.id];
      card.inert = editing;
      if (editing) wrap.replaceChildren(widgetBar(item), card);
      else if (wrap.childNodes.length !== 1 || wrap.firstChild !== card) wrap.replaceChildren(card);
      return wrap;
    });
    if (editing) nodes.push(addShelf());
    else if (!layout.length) {
      nodes.push(
        h(
          'div',
          { class: 'panel hm-board-empty' },
          miniEmpty({
            iconName: 'hm-layout',
            title: 'Your Home is empty',
            text: 'Pick the widgets you want here.',
            action: h('button', { type: 'button', class: 'btn btn--sm btn--primary', onClick: () => setEditing(true) }, 'Customize'),
          }),
        ),
      );
    }
    const same = nodes.length === board.children.length && nodes.every((n, i) => board.children[i] === n);
    if (!same) board.replaceChildren(...nodes);
    board.classList.toggle('is-editing', editing);
    if (focusWidget) wraps.get(focusWidget)?.querySelector('.hm-wgrip')?.focus({ preventScroll: true });
  }

  /** Arrow keys on a handle move the widget one place earlier or later (Home / End: first, last). */
  function gripKey(e, id) {
    const layout = layoutNow();
    const at = layout.findIndex((w) => w.id === id);
    const to = { ArrowLeft: at - 1, ArrowUp: at - 1, ArrowRight: at + 1, ArrowDown: at + 1, Home: 0, End: layout.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    if (to < 0 || to >= layout.length || to === at) return;
    saveLayout(HM.moveWidget(layout, id, to));
    announce.textContent = `${nameOf(id)}: place ${to + 1} of ${layout.length}.`;
  }

  /** Drag a widget by its handle: the others make room as it passes over them. */
  function startDrag(e, id) {
    if (!editing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const pointerId = e.pointerId;
    const wrap = wraps.get(id);
    const start = layoutNow();
    const order = start.map((w) => w.id);
    const scroller = root.closest('.main') ?? document.scrollingElement;
    let x = e.clientX;
    let y = e.clientY;
    let lastSwap = { x, y };
    let frame = 0;
    wrap.classList.add('is-dragging');
    board.classList.add('is-sorting');

    const aim = () => {
      if (Math.hypot(x - lastSwap.x, y - lastSwap.y) < 16) return;
      const over = document.elementFromPoint(x, y)?.closest('.hm-widget');
      if (!over || over === wrap || !board.contains(over)) return;
      const from = order.indexOf(id);
      const to = order.indexOf(over.dataset.widget);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, id);
      board.insertBefore(wrap, from < to ? over.nextSibling : over);
      lastSwap = { x, y };
    };
    // Near the top or bottom edge, the page scrolls along
    const loop = () => {
      const r = scroller.getBoundingClientRect();
      if (y < r.top + 56) scroller.scrollTop -= 14;
      else if (y > r.bottom - 56) scroller.scrollTop += 14;
      aim();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    // On the window, not the handle: moving the widget in the page would drop a pointer capture
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
    };
    const end = (ev) => {
      if (ev && ev.pointerId !== pointerId) return;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      wrap.classList.remove('is-dragging');
      board.classList.remove('is-sorting');
      if (order.join() !== start.map((w) => w.id).join()) {
        saveLayout(order.map((wid) => start.find((w) => w.id === wid)));
        announce.textContent = `${nameOf(id)} moved.`;
      }
      grip.focus({ preventScroll: true });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  root.append(header, editHint, board, announce);
  setEditing(false);

  function paintAll() {
    paintHeader();
    paintWeek();
    paintHabits();
    paintTodo();
    paintRecent();
    paintGraph();
    paintClock();
    paintAgenda();
    paintPayments();
    paintTraining();
  }
  paintAll();

  /* ---- Right-click: tasks on Home (the to-do list and the week) ---- */

  function pasteTask(snap, { afterId = null, due = state.today, verb = 'Pasted' } = {}) {
    const task = tasksApi.insertCopy(snap, { afterId, due });
    if (!task) {
      toast('That copy can’t be pasted.');
      return false;
    }
    toast(`${verb} “${clip(task.title)}”.`, { action: { label: 'Undo', onClick: () => tasksApi.removeCopy(task) } });
    return true;
  }

  const offMenu = registerContextProvider('home', (el) => {
    if (!root.contains(el)) return null;
    const row = el.closest('[data-task]');
    const id = row?.dataset.task;
    const task = id ? tasksApi.getItems().find((t) => t.id === id) : null;
    if (task) {
      return {
        kind: 'task',
        id,
        label: `Task: ${task.title}`,
        el: row.querySelector('.hm-task-title, [data-act="task-open"]') ?? row,
        accepts: ['task'],
        copy: () => {
          const snapshot = tasksApi.snapshot(id);
          return snapshot ? { kind: 'task', snapshot, text: snapshot.title } : null;
        },
        paste: (c) => pasteTask(c.snapshot, { afterId: id, due: task.due ?? state.today }),
        remove: () => tasksApi.remove(id),
        duplicate: () => {
          const snapshot = tasksApi.snapshot(id);
          if (snapshot) pasteTask(snapshot, { afterId: id, due: task.due, verb: 'Duplicated' });
        },
        rename: async () => {
          const title = await promptDialog({ title: 'Rename task', value: task.title, maxLength: 500 });
          if (title !== null) tasksApi.rename(id, title);
        },
        edit: () => tasksApi.reveal(id),
      };
    }
    if (el.closest('.hm-todo')) {
      return {
        kind: null,
        id: null,
        label: 'To do today',
        el: null,
        accepts: ['task'],
        paste: (c) => pasteTask(c.snapshot),
        pasteText: (text) => {
          const { title, rest } = splitText(text);
          if (!title) return;
          const added = tasksApi.addTask({ title, notes: rest, due: state.today });
          if (added) toast(`Pasted “${clip(added.title)}”.`, { action: { label: 'Undo', onClick: () => tasksApi.removeCopy(added) } });
        },
      };
    }
    return null;
  });

  /* ---- Live updates ---- */

  const offs = [
    tasksApi.subscribe(() => {
      paintTodo();
      paintWeek();
      paintHeader();
    }),
    habitsApi.source.subscribe(() => {
      paintHabits();
      paintGraph();
      paintWeek();
    }),
    subscribeCalendar(() => {
      paintWeek();
      paintHeader();
      paintAgenda();
    }),
    financeApi.subscribe(() => paintPayments()),
    trainingApi.subscribe(() => paintTraining()),
    // The layout changed (here, or in another window)
    prefs.subscribe(() => renderBoard()),
    notesApi.subscribe(() => paintRecent()),
    pomodoroApi.subscribe((v) => pomo.paint(v)),
    onDayChange(() => {
      const onCurrent = state.week === mondayOf(state.today);
      state.today = todayKey();
      if (onCurrent) state.week = mondayOf(state.today);
      paintAll();
    }),
  ];
  // The greeting and "Now / Next" follow the clock; the week dims what has passed now and then
  let ticks = 0;
  const clock = setInterval(() => {
    paintHeader();
    paintAgenda();
    if (++ticks % 10 === 0) paintWeek();
  }, 30000);
  // The clock widget and a workout's running time tick every second
  const seconds = setInterval(() => {
    paintClock();
    if (trainingApi.getState().session) paintTraining();
  }, 1000);

  function onKeydown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
    if (e.target instanceof Element && e.target.closest('.ctx-menu')) return;
    const key = e.key;
    if (editing) {
      if (key === 'Escape') {
        e.preventDefault();
        setEditing(false);
      }
      return;
    }
    if (key === 'q' || key === 'Q') {
      e.preventDefault();
      openQuickNote();
    } else if (key === 'n' || key === 'N' || key === '/') {
      e.preventDefault();
      addInput.focus();
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      moveWeek(key === 'ArrowLeft' ? -1 : 1);
    } else if (key === 't' || key === 'T') {
      e.preventDefault();
      goWeek(mondayOf(state.today));
    }
  }
  document.addEventListener('keydown', onKeydown);

  return () => {
    offs.forEach((off) => off());
    offMenu();
    clearInterval(clock);
    clearInterval(seconds);
    clearTimeout(todoTimer);
    document.removeEventListener('keydown', onKeydown);
  };
}

export default {
  id: 'home',
  title: 'Home',
  icon: 'home',
  badge() {
    return '';
  },
  mount,
};
