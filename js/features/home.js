// LIFE/OS — 01 // Home: the start page, today at a glance. A greeting with what's next, the week
// (events and dated tasks, as in the Calendar), and widgets: the Pomodoro timer, today's habits,
// the to-do list with a quick add, a quick note and the habit graph.
//
// Home keeps no data of its own (only the quick note's last section, in store 'home'): it reads
// and writes through the other modules' APIs (tasksApi, habitsApi, notesApi, calendarApi,
// pomodoroApi), so their pages, nav badges and other windows stay in sync. Pure helpers live in
// home.logic.js (unit-tested).

import {
  h,
  icon,
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
  skin,
  plural,
  isTyping,
  modalOpen,
  WEEKDAYS_SHORT,
  WEEKDAYS_MIN,
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
import { PHASE_LABEL } from './pomodoro.logic.js';
import * as HM from './home.logic.js';

const prefs = createStore('home', { quickNoteSection: null });

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
  const simple = skin() === 'simple';
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
  const header = pageHeader({ index: '01', title: HM.greeting(new Date().getHours()), subtitle: formatDay(state.today, 'long'), actions: [quickBtn] });
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

  /* ---- Layout: wide windows put the week, the graph and the quick note beside the timer, habits
     and to-do (two columns of about the same height); tablets and phones place every card by
     grid area (css/features/home.css), phones with the widgets first ---- */

  root.append(
    header,
    h('div', { class: 'hm-grid' }, h('div', { class: 'hm-side' }, pomo.card, habitsCard, todoCard), h('div', { class: 'hm-main' }, weekCard, graphCard, noteCard)),
  );

  function paintAll() {
    paintHeader();
    paintWeek();
    paintHabits();
    paintTodo();
    paintRecent();
    paintGraph();
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
    }),
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
    if (++ticks % 10 === 0) paintWeek();
  }, 30000);

  function onKeydown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
    if (e.target instanceof Element && e.target.closest('.ctx-menu')) return;
    const key = e.key;
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
