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
  reducedMotion,
  dropdown,
  tip,
  tipHidden,
  menuOpen,
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
import { getEvents, subscribeCalendar, getDayColors } from './calendar.store.js';
import { paintColor } from '../colors.js';
import { calendarApi } from './calendar.js';
import { occurrencesInRange, weekKeys, mondayOf, periodHeading, viewRange, shiftCursor, monthGrid, layoutTimed, tasksByDay, overdueTasks, habitsByDay, daysBetween } from './calendar.logic.js';
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
const MONTH_ITEMS = 3; // per day in the month
const DAY_SPLIT = 520; // px: a widget this wide shows the day's schedule beside its habits
const DAY_FROM = 8; // the day's hours run 8:00 to 20:00 at least
const DAY_TO = 20;
const HOUR_H = 34; // px per hour in the day's schedule
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

/** A card's header: its icon and title (`short`: the title a small card shows), then `extra`. */
function cardHead(id, iconName, title, extra = null, short = null) {
  const name = short ? [h('span', { class: 'hm-title-long' }, title), h('span', { class: 'hm-title-short' }, short)] : h('span', null, title);
  return h('header', { class: 'hm-card-head' }, h('h2', { class: 'hm-card-title', id }, icon(iconName, { size: 15 }), name), extra);
}

/** A card's link ("Open timer ›"). A narrow card shows only the arrow: the words stay its name. */
function moreLink({ href, label, onClick }) {
  return h(
    'a',
    {
      class: 'hm-more',
      href,
      title: label,
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
  const state = { today: todayKey(), cursor: todayKey() };
  let todoHoldUntil = 0;
  let todoTimer = 0;

  /* ---- Header: greeting, then today's date and what's next on one line ----
     A phone shows the short date ("Sat 17 Oct") and both buttons as icons (css/compact.css,
     home.css), so the greeting keeps its whole width. */

  const quickBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary hm-quick', 'aria-keyshortcuts': 'Q', onClick: () => openQuickNote() },
    icon('edit'),
    h('span', null, 'Quick note'),
    h('span', { class: 'kbd hm-kbd lo-hint', 'aria-hidden': 'true' }, 'Q'),
  );
  // Customize: arrange the widgets (Done leaves it)
  const customizeBtn = h('button', { type: 'button', class: 'btn hm-customize', 'aria-pressed': 'false', onClick: () => setEditing(!editing) });
  const header = pageHeader({ index: '01', title: HM.greeting(new Date().getHours()), subtitle: ' ', actions: [customizeBtn, quickBtn] });
  const titleEl = header.querySelector('.page-title');
  const dateLong = h('span', { class: 'hm-date-long' });
  const dateShort = h('span', { class: 'hm-date-short' });
  const nextEl = h('button', { type: 'button', class: 'hm-next' });
  const subEl = header.querySelector('.page-subtitle');
  subEl.classList.add('hm-sub');
  subEl.replaceChildren(h('span', { class: 'hm-date' }, dateLong, dateShort), h('span', { class: 'hm-sub-sep', 'aria-hidden': 'true' }, '·'), nextEl);
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
    dateLong.textContent = formatDay(state.today, 'long');
    dateShort.textContent = formatDay(state.today);
    const occs = occurrencesInRange(getEvents(), state.today, shiftKey(state.today, AHEAD_DAYS));
    const up = HM.nextUp(occs, state.today, nowMinutes());
    nextDay = up ? (up.occ.start > state.today ? up.occ.start : state.today) : null;
    nextEl.replaceChildren(icon(up?.kind === 'now' ? 'activity' : 'clock', { size: 14 }), h('span', null, nextText(up)));
    nextEl.classList.toggle('is-empty', !up);
    nextEl.title = up ? 'Open this day in the Calendar' : 'Open today in the Calendar';
  }

  /* ---- Calendar: a day, the week or the month ----
     Two small menus on the widget pick the view (Day · Week · Month) and what it shows (Events ·
     Tasks · Habits · Done tasks); both are kept per device in prefs.calendar. ‹ › move a period,
     the "Today / This week / This month" button comes back. A day opens in the Calendar. A wide
     widget has it all on one row; a narrow one (a phone) on two: the title and ‹ ›, then the
     menus and the way back (home.css). */

  const calNow = () => HM.normalizeCalView(prefs.get().calendar);
  const setCal = (patch) => prefs.update({ calendar: HM.withCalView(prefs.get().calendar, patch) });
  const isCurrent = (view) => HM.isCurrentPeriod(view, state.cursor, state.today, mondayOf);

  const weekKicker = h('div', { class: 'hm-week-kicker label lo-deco' }, 'Week');
  // The month first (with its year), then the exact week or day, as on the Calendar page
  const wtMonth = h('span', { class: 'hm-wt-month' });
  const wtYear = h('span', { class: 'hm-wt-year' });
  const wtSub = h('span', { class: 'hm-wt-sub' });
  const weekTitle = h('h2', { class: 'hm-week-title', id: 'hm-week-title', 'aria-live': 'polite' }, h('span', { class: 'hm-wt-main' }, wtMonth, ' ', wtYear), h('span', { class: 'sr-only' }, ', '), wtSub);
  const prevBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', onClick: () => movePeriod(-1) }, icon('chevron-left'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm', onClick: () => movePeriod(1) }, icon('chevron-right'));
  const thisWeekBtn = h('button', { type: 'button', class: 'btn btn--sm hm-week-now', onClick: () => goTo(state.today) }, 'This week');
  // The view menu also opens the period in the Calendar (a narrow widget hides the link)
  const viewDD = dropdown({
    className: 'hm-cal-view',
    title: 'Day, week or month (D, W, M)',
    items: [
      ...HM.CAL_VIEWS.map((v) => ({ value: v, label: HM.CAL_VIEW_LABEL[v] })),
      { separator: true },
      { value: 'open', label: 'Open in the Calendar', icon: 'calendar', action: () => calendarApi.open(state.cursor, calNow().view) },
    ],
    value: calNow().view,
    onSelect: (v) => setCal({ view: v }),
  });
  const showDD = dropdown({
    label: 'Show',
    multi: true,
    className: 'hm-cal-show',
    title: 'What the calendar shows',
    items: HM.calLayerItems(calNow().layers),
    onSelect: (k, on) => setCal({ layers: { [k]: on } }),
  });
  let showSig = '';
  const calBar = h('div', { class: 'hm-cal-bar' }, viewDD.el, showDD.el);
  const calLink = moreLink({ href: '#/calendar', label: simple ? 'Calendar' : 'Open calendar' });
  calLink.classList.add('hm-week-link');
  const daysEl = h('div', { class: 'hm-days' });
  const emptyText = h('span');
  const weekEmpty = h(
    'div',
    { class: 'hm-week-empty', hidden: true },
    emptyText,
    h('button', { type: 'button', class: 'btn btn--sm', onClick: () => calendarApi.open(state.cursor, calNow().view) }, icon('calendar', { size: 14 }), 'Plan in the Calendar'),
  );
  const weekCard = h(
    'section',
    { class: 'panel hud hm-card hm-week', 'aria-labelledby': 'hm-week-title' },
    h(
      'header',
      { class: 'hm-week-head' },
      weekKicker,
      weekTitle,
      calBar,
      thisWeekBtn,
      h('div', { class: 'hm-week-nav' }, prevBtn, nextBtn),
      calLink,
    ),
    daysEl,
    weekEmpty,
  );

  function goTo(key) {
    if (key === state.cursor) return;
    state.cursor = key;
    paintWeek();
  }

  const movePeriod = (delta) => goTo(shiftCursor(calNow().view, state.cursor, delta));

  /** New items for a dropdown; an open menu is rebuilt, so the item that had focus gets it back. */
  function updateMenu(dd, opts) {
    const active = document.activeElement;
    const at = dd.button.getAttribute('aria-expanded') === 'true' && active?.closest?.('.dd-menu') ? active.dataset.i : null;
    dd.update(opts);
    if (at != null) document.querySelector(`.dd-menu [data-i="${CSS.escape(at)}"]`)?.focus({ preventScroll: true });
  }

  function dayCell(d, ctx, info, color) {
    const items = [...d.events.map((occ) => ({ occ })), ...d.tasks.map((task) => ({ task }))];
    const { shown, more } = HM.clipItems(items, DAY_ITEMS);
    const date = parseKey(d.key);
    const label = `${formatDay(d.key, 'long')}${d.isToday ? ', today' : ''}: ${plural(d.events.length, 'event')}, ${plural(d.tasks.length, 'task')}. Open in the Calendar`;
    return paintColor(
      h(
        'div',
        // A day with no events or tasks is "free": the narrow week (a list) shows it as one thin row
        { class: ['hm-day', d.isToday && 'is-today', d.isPast && 'is-past', d.isWeekend && 'is-weekend', !items.length && 'is-free'], dataset: { key: d.key, open: d.key } },
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
      ),
      'days',
      color,
    );
  }

  /**
   * The day's schedule: all-day events on top, then the hours (8:00 to 20:00, wider when an
   * event or now falls outside) with each timed event placed at its time, side by side when
   * they overlap, and the now line on today.
   */
  function schedule(d, ctx) {
    const timed = d.events.filter((o) => !o.allDay);
    const allDay = d.events.filter((o) => o.allDay);
    const now = d.isToday ? ctx.nowMin : null;
    let from = Math.min(DAY_FROM, ...timed.map((o) => Math.floor(o.startMin / 60)), now === null ? 24 : Math.floor(now / 60));
    let to = Math.max(DAY_TO, ...timed.map((o) => Math.ceil(o.endMin / 60)), now === null ? 0 : Math.ceil((now + 1) / 60));
    from = Math.max(0, from);
    to = Math.min(24, Math.max(to, from + 1));
    const top = (min) => ((min - from * 60) / 60) * HOUR_H;
    const hours = [];
    for (let hr = from; hr <= to; hr++) hours.push(h('div', { class: 'hm-tl-h', style: { top: `${(hr - from) * HOUR_H}px` } }, h('span', { class: 'tnum' }, `${String(hr % 24).padStart(2, '0')}:00`)));
    const blocks = layoutTimed(timed).map((b) => {
      const o = b.occ;
      const height = Math.max((b.height / 60) * HOUR_H, 22);
      const short = height < 40;
      const past = d.isPast || (now !== null && o.endMin <= now);
      const block = h(
        'button',
        {
          type: 'button',
          class: ['cal-tlev', `cal-ev--${o.style}`, 'is-wide', short && 'is-short', past && 'is-past'],
          style: { top: `${top(b.top)}px`, height: `${height}px`, left: `calc(${(b.col / b.cols) * 100}% + 2px)`, width: `calc(${(b.colSpan / b.cols) * 100}% - 4px)` },
          'aria-label': `${o.startTime} to ${o.endTime}, ${o.title}${o.location ? `, ${o.location}` : ''}. Open the day in the Calendar`,
          dataset: { open: d.key, fid: `tl:${o.occId}` },
        },
        h('span', { class: 'cal-tlev-time tnum' }, short ? o.startTime : `${o.startTime}–${o.endTime}`),
        h('span', { class: 'cal-tlev-title', title: `${o.startTime}–${o.endTime} ${o.title}${o.location ? ` · ${o.location}` : ''}` }, o.title),
        o.location && height >= 58 ? h('span', { class: 'cal-tlev-loc' }, icon('map-pin', { size: 10 }), o.location) : null,
      );
      return paintColor(block, 'events', o.color);
    });
    return h(
      'div',
      { class: 'hm-sched' },
      allDay.length ? h('div', { class: 'hm-dv-allday' }, h('span', { class: 'hm-dv-allday-label' }, 'All day'), allDay.map((o) => {
        const bar = eventBar(o, ctx, { prefix: 'hm', tab: '0', drag: false, glyph: false });
        bar.dataset.open = d.key;
        return bar;
      })) : null,
      h(
        'div',
        { class: 'hm-tl', style: { height: `${(to - from) * HOUR_H}px` } },
        hours,
        h('div', { class: 'hm-tl-col' }, blocks, now !== null && now >= from * 60 && now <= to * 60 ? h('div', { class: 'cal-now', style: { top: `${top(now)}px` }, 'aria-hidden': 'true' }) : null),
        timed.length ? null : h('p', { class: 'hm-tl-free' }, allDay.length ? 'Nothing at a set time.' : d.isPast ? 'Nothing was planned.' : 'Free all day.'),
      ),
    );
  }

  /**
   * One day: its events, its tasks (tick them here) and its habits (tick them up to today).
   * A medium or large widget (wide) splits it: the day's schedule and tasks on the left, the
   * habits on the right. A small one lists everything.
   */
  function dayList(d, ctx, info, layers, color, wide) {
    const group = (title, rows, kind = null) => h('section', { class: 'hm-dv-group' }, h('h3', { class: 'hm-dv-title label' }, title), h('div', { class: ['hm-dv-rows', kind] }, rows));
    const groups = [];
    if (layers.events && wide) {
      groups.push(h('section', { class: 'hm-dv-group' }, h('h3', { class: 'hm-dv-title label' }, 'Schedule'), schedule(d, ctx)));
    } else if (layers.events && d.events.length) {
      groups.push(group('Events', d.events.map((occ) => {
        const bar = eventBar(occ, ctx, { prefix: 'hm', tab: '0', drag: false, glyph: false, extra: occ.location ? h('span', { class: 'hm-dv-where' }, occ.location) : null });
        bar.dataset.open = d.key;
        return bar;
      })));
    }
    if (layers.tasks && d.tasks.length) {
      groups.push(group('Tasks', d.tasks.map((task) => {
        const chip = taskChip(task, ctx, { prefix: 'hm', tab: '0' });
        chip.dataset.open = d.key;
        return chip;
      })));
    }
    const habits = info ? [...info.scheduled, ...info.bonus] : [];
    if (layers.habits && habits.length) {
      groups.push(group(info.planned ? `Habits · ${info.done} of ${info.planned}` : 'Habits', habits.map((hb) => {
        const canLog = d.key <= state.today;
        const check = canLog
          ? checkButton({ checked: hb.done, label: `${hb.name}: done ${d.isToday ? 'today' : formatDay(d.key)}`, onToggle: (next) => habitsApi.setLog(hb.id, d.key, next) })
          : h('span', { class: 'hm-dv-planned', 'aria-hidden': 'true' });
        if (canLog) check.dataset.fid = `dv-hb:${hb.id}`;
        return h('div', { class: ['hm-dv-habit', `is-${hb.status}`] }, check, h('span', { class: 'hm-dv-habit-name' }, hb.name), hb.status === 'bonus' ? h('span', { class: 'hm-dv-tag' }, 'Extra') : !canLog ? h('span', { class: 'hm-dv-tag' }, 'Planned') : null);
      }), 'is-habits'));
    }
    // The habits went last: on a wide widget they take the right-hand column
    const split = wide && groups.length > 1 && layers.habits && habits.length;
    const body = split ? [h('div', { class: 'hm-dv-main' }, groups.slice(0, -1)), h('div', { class: 'hm-dv-side' }, groups.at(-1))] : groups;
    return paintColor(h('div', { class: ['hm-dayview', d.isToday && 'is-today', wide && 'is-wide', split && 'is-split'], dataset: { key: d.key } }, body), 'days', color);
  }

  /** The month: a cell a day (its first items, or dots when the widget is narrow), and a habit bar. */
  function monthCells(grid, occs, byDay, habits, colors) {
    const head = h('div', { class: 'hm-mhead', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5, 6, 0].map((wd) => h('span', null, WEEKDAYS_SHORT[wd])));
    const cells = grid.weeks.flatMap((w) =>
      HM.weekDays(w.days.map((x) => x.key), occs, byDay, state.today).map((d, i) => {
        const day = w.days[i];
        const items = [...d.events.map((occ) => ({ occ })), ...d.tasks.map((task) => ({ task }))];
        const { shown, more } = HM.clipItems(items, MONTH_ITEMS);
        const info = habits.get(d.key);
        const habitsText = info?.planned ? `, habits ${info.done} of ${info.planned}` : '';
        const label = `${formatDay(d.key, 'long')}${d.isToday ? ', today' : ''}: ${plural(d.events.length, 'event')}, ${plural(d.tasks.length, 'task')}${habitsText}. Open in the Calendar`;
        const marks = shown.map((it) =>
          it.occ
            ? paintColor(h('span', { class: ['hm-mi', 'hm-mi--ev', `is-${it.occ.style}`] }, it.occ.allDay ? it.occ.title : `${it.occ.startTime} ${it.occ.title}`), 'events', it.occ.color)
            : paintColor(h('span', { class: ['hm-mi', 'hm-mi--task', it.task.done && 'is-done', `pri-${it.task.priority}`] }, it.task.title), 'tasks', it.task.color),
        );
        const bar = info?.planned
          ? h('span', { class: ['hm-mhab', info.done === info.planned && 'is-perfect', d.key > state.today && 'is-future'] }, h('span', { class: 'hm-mhab-fill', style: { width: `${Math.round((info.done / info.planned) * 100)}%` } }))
          : null;
        return paintColor(
          h(
            'button',
            {
              type: 'button',
              class: ['hm-mcell', !day.inMonth && 'is-out', d.isToday && 'is-today', d.isPast && 'is-past', d.isWeekend && 'is-weekend'],
              tabindex: d.key === focusKeyIn(grid) ? '0' : '-1',
              'aria-label': label,
              'aria-current': d.isToday ? 'date' : null,
              dataset: { open: d.key, key: d.key, fid: `m:${d.key}` },
            },
            h('span', { class: 'hm-mnum tnum' }, String(day.date)),
            h('span', { class: 'hm-mitems', 'aria-hidden': 'true' }, marks, more ? h('span', { class: 'hm-mmore tnum' }, `+${more}`) : null),
            bar,
          ),
          'days',
          colors[d.key],
        );
      }),
    );
    return [head, h('div', { class: 'hm-mgrid', role: 'group', 'aria-label': grid.title }, cells)];
  }

  // The day view splits in two from this width of the widget (a medium one and up)
  let dayWide = null;
  const dayResize = new ResizeObserver(() => {
    if (calNow().view !== 'day' || (weekCard.clientWidth >= DAY_SPLIT) === dayWide) return;
    requestAnimationFrame(() => paintWeek());
  });
  dayResize.observe(weekCard);

  // The cell that takes Tab in the month: today, or the first day of the month
  const focusKeyIn = (grid) => (state.today.startsWith(grid.month) ? state.today : `${grid.month}-01`);

  function paintWeek() {
    const { view, layers } = calNow();
    const { from, to } = viewRange(view, state.cursor);
    const occs = layers.events ? occurrencesInRange(getEvents(), from, to) : [];
    const byDay = layers.tasks ? tasksByDay(tasksApi.getItems(), from, to, { includeCompleted: layers.completed }) : new Map();
    const habits = layers.habits ? habitsByDay(habitsApi.source.getItems(), from, to, state.today) : new Map();
    const colors = getDayColors();
    const ctx = { today: state.today, nowMin: nowMinutes() };
    const unit = view === 'day' ? 'day' : view === 'week' ? 'week' : 'month';

    weekKicker.textContent = HM.CAL_VIEW_LABEL[view];
    const head = periodHeading(view, state.cursor, { weekNumber: !simple });
    const headText = `${head.month} ${head.year}|${head.sub}`;
    if (weekTitle.dataset.text !== headText) {
      weekTitle.dataset.text = headText;
      wtMonth.textContent = head.month;
      wtYear.textContent = head.year;
      wtSub.textContent = head.sub;
      wtSub.hidden = !head.sub;
    }
    thisWeekBtn.textContent = HM.CAL_NOW_LABEL[view];
    thisWeekBtn.title = `Back to ${HM.CAL_NOW_LABEL[view].toLowerCase()} (T)`;
    thisWeekBtn.hidden = isCurrent(view);
    prevBtn.setAttribute('aria-label', `Previous ${unit}`);
    prevBtn.title = `Previous ${unit} (←)`;
    nextBtn.setAttribute('aria-label', `Next ${unit}`);
    nextBtn.title = `Next ${unit} (→)`;
    // Only a new view rebuilds the menu: this runs every half minute on today's day view, and an
    // open menu rebuilt under the keyboard would lose its place
    if (viewDD.button.dataset.view !== view) {
      viewDD.button.dataset.view = view;
      updateMenu(viewDD, { value: view });
    }
    viewDD.button.setAttribute('aria-label', `Calendar view: ${HM.CAL_VIEW_LABEL[view]}`);
    // Done tasks only show with the tasks: the menu greys it out while Tasks is off
    const showItems = HM.calLayerItems(layers);
    const sig = JSON.stringify(showItems);
    if (sig !== showSig) {
      showSig = sig;
      updateMenu(showDD, { items: showItems });
    }
    weekCard.dataset.view = view;
    daysEl.dataset.view = view;

    let quiet;
    if (view === 'month') {
      const grid = monthGrid(state.cursor, { today: state.today });
      keepFocus(daysEl, () => daysEl.replaceChildren(...monthCells(grid, occs, byDay, habits, colors)));
      quiet = !layers.events && !layers.tasks && !layers.habits;
    } else {
      const days = HM.weekDays(view === 'day' ? [state.cursor] : weekKeys(state.cursor), occs, byDay, state.today);
      if (view === 'day') {
        const d = days[0];
        const info = habits.get(d.key);
        dayWide = weekCard.clientWidth >= DAY_SPLIT;
        keepFocus(daysEl, () => daysEl.replaceChildren(dayList(d, ctx, info, layers, colors[d.key], dayWide)));
        // A wide day always shows its hours, so it is never "empty" while events are on
        quiet = !(dayWide && layers.events) && !d.events.length && !d.tasks.length && !(info && (info.scheduled.length || info.bonus.length));
      } else {
        keepFocus(daysEl, () => daysEl.replaceChildren(...days.map((d) => dayCell(d, ctx, habits.get(d.key), colors[d.key]))));
        quiet = days.every((d) => !d.events.length && !d.tasks.length);
      }
    }
    daysEl.classList.toggle('is-quiet', quiet);
    emptyText.textContent = HM.calEmptyText(view, layers);
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
    const day = e.target.closest('[data-open]');
    if (day && daysEl.contains(day)) calendarApi.open(day.dataset.open, 'day');
  });

  // Arrow keys move between the month's days (the page's ← → would move the month)
  daysEl.addEventListener('keydown', (e) => {
    const cell = e.target.closest?.('.hm-mcell');
    if (!cell || e.metaKey || e.ctrlKey || e.altKey) return;
    const cells = [...daysEl.querySelectorAll('.hm-mcell')];
    const at = cells.indexOf(cell);
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, ArrowUp: at - 7, ArrowDown: at + 7, Home: at - (at % 7), End: at - (at % 7) + 6 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = cells[Math.max(0, Math.min(cells.length - 1, to))];
    for (const c of cells) c.tabIndex = c === next ? 0 : -1;
    next.focus();
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
        // A narrow card shows the icon only
        mainBtn.setAttribute('aria-label', verb);
        mainBtn.title = `${verb} the timer`;
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
    cardHead('hm-habits-title', 'target', simple ? 'Habits today' : 'Habits · today', h('div', { class: 'hm-card-tools' }, habitsCount, moreLink({ href: '#/habits', label: 'Habits', onClick: () => habitsApi.source.openTab('today') })), 'Habits'),
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
      return h('li', { class: ['hm-habit', isDone && 'is-done'] }, check, h('span', { class: 'hm-habit-name', title: hb.name }, hb.name));
    });
    // A narrow card drops the ring (the count is in its header) but keeps "All done"
    habitsBody.classList.toggle('is-complete', done === planned.length);
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
      h('span', { class: 'hm-note-btn-short' }, 'New note'),
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
            h('button', { type: 'button', class: 'hm-recent-item', title, dataset: { fid: `note:${n.id}` }, onClick: () => notesApi.reveal(n.id) }, h('span', { class: 'hm-recent-title' }, title), h('span', { class: 'hm-recent-time' }, timeAgo(n.updatedAt))),
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
  // What a gap means is a tip (its ✓ hides it for good), shown only while the two weeks have one
  const graphTip = tip({ id: 'home.graph-gaps', className: 'hm-graph-tip', text: 'A gap is a rest day: no habits were planned that day.' });

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
      h('p', { class: 'hm-graph-note' }, h('span', { class: 'hm-graph-avg' }, avgText)),
      ...(bars.some((b) => b.kind === 'rest') ? [graphTip] : []),
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
      // A small card shows the short date (home.css)
      clockDate.replaceChildren(h('span', { class: 'hm-date-long' }, formatDay(state.today, 'long')), h('span', { class: 'hm-date-short' }, formatDay(state.today)));
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
    // Native replaceChildren() would print a null as "null": only the parts there are
    keepFocus(trainBody, () =>
      trainBody.replaceChildren(
        ...[
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
                    h('button', { type: 'button', class: 'btn btn--sm btn--primary hm-train-go-btn', dataset: { fid: `train:${r.id}` }, 'aria-label': `Start ${r.name}`, title: `Start ${r.name}`, onClick: () => trainingApi.startSession({ routine: r }) }, icon('play', { size: 13 }), h('span', null, 'Start')),
                  );
                }),
              )
            : null,
          h('button', { type: 'button', class: 'btn btn--sm hm-train-start', dataset: { fid: 'train-start' }, onClick: () => trainingApi.startSession() }, icon('plus', { size: 14 }), routines.length ? 'Empty workout' : 'Start a workout'),
        ].filter(Boolean),
      ),
    );
  }

  /* ---- Your own Home: the board of widgets ----
     home.logic.js places the widgets (placeWidgets): each in its columns, as high as it fits,
     at its own height, so a short widget leaves room under it. The board sizes and measures
     them and moves them into place, again whenever its width or a widget's height changes.
     Customize shows a bar on each (drag handle, size, remove) and the Add shelf below; the
     widgets themselves are inert meanwhile, so a drag never presses a button inside them. */

  const CARDS = { week: weekCard, pomodoro: pomo.card, todo: todoCard, habits: habitsCard, graph: graphCard, note: noteCard, clock: clockCard, agenda: agendaCard, payments: payCard, training: trainCard };
  const board = h('div', { class: 'hm-board' });
  const below = h('div', { class: 'hm-below' });
  const announce = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  // How Customize works: a tip with its own ✓, shown while arranging until it is dismissed
  const TIP_ID = 'home.customize';
  const editHint = tip({
    id: TIP_ID,
    className: 'hm-edit-hint',
    text: [
      'Drag a widget by its handle (or use the arrow keys on it), pick its size, remove it with ×, or add more from the shelf below.',
      h('span', { class: 'hm-hint-narrow' }, ' Here Small is half the width, the others full.'),
    ],
  });
  editHint.hidden = true;
  const wraps = new Map();
  let editing = false;
  let metrics = null; // { width, gap, cols, step } of the board
  let placed = null; // where the widgets are now: { items: [{ id, x, w, y, h }], height }
  let dragging = null; // the widget being dragged
  let stopDrag = null;

  const layoutNow = () => HM.normalizeLayout(prefs.get().layout);
  const saveLayout = (layout) => prefs.update({ layout });
  const nameOf = (id) => HM.WIDGETS.find((w) => w.id === id)?.name ?? id;

  // Four columns on a wide board, two on a narrower one and on a phone (HM.columnsFor)
  function measure() {
    const width = board.clientWidth;
    const gap = parseFloat(getComputedStyle(board).rowGap) || 0;
    const cols = HM.columnsFor(width);
    return { width, gap, cols, step: (width + gap) / cols };
  }

  const heightsOf = (layout) => Object.fromEntries(layout.map((it) => [it.id, wraps.get(it.id)?.offsetHeight ?? 0]));

  /** Size each widget for its columns, measure it, and move it into its place. */
  function layoutBoard(layout = layoutNow()) {
    metrics = measure();
    if (!metrics.width) return;
    const { cols, step, gap } = metrics;
    root.dataset.cols = String(cols);
    for (const it of layout) {
      const wrap = wraps.get(it.id);
      if (wrap) wrap.style.width = `${HM.widgetSpan(it, cols) * step - gap}px`;
    }
    placed = HM.placeWidgets(layout, { cols, heights: heightsOf(layout), gap });
    paintPlaces(placed);
  }

  /** Put the widgets where `result` says (all but `skip`, the one under the pointer). */
  function paintPlaces(result, skip = null) {
    const { step } = metrics;
    for (const p of result.items) {
      const wrap = wraps.get(p.id);
      if (!wrap || p.id === skip) continue;
      wrap.style.transform = `translate(${Math.round(p.x * step)}px, ${Math.round(p.y)}px)`;
      // A widget just put on the board appears in its place; after that, it glides
      if (!wrap.dataset.placed) {
        wrap.style.transition = 'none';
        void wrap.offsetWidth;
        wrap.style.transition = '';
        wrap.dataset.placed = '1';
      }
    }
    board.style.height = `${Math.ceil(result.height)}px`;
    if (!board.classList.contains('is-placed')) requestAnimationFrame(() => board.classList.add('is-placed'));
  }

  // The board's width or a widget's height changed: place them again, before the page paints
  const resizes = new ResizeObserver(() => {
    if (!dragging) layoutBoard();
  });
  resizes.observe(board);

  function setEditing(on) {
    editing = on;
    customizeBtn.setAttribute('aria-pressed', String(on));
    customizeBtn.classList.toggle('btn--primary', on);
    customizeBtn.replaceChildren(icon(on ? 'check' : 'hm-layout'), h('span', null, on ? 'Done' : 'Customize'));
    // Its name stays when a phone shows the icon only
    customizeBtn.setAttribute('aria-label', on ? 'Done' : 'Customize');
    customizeBtn.title = on ? 'Finish arranging Home' : 'Choose and arrange the widgets on Home';
    quickBtn.hidden = on;
    editHint.hidden = !on || tipHidden(TIP_ID);
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
            dataset: { size: sz },
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
    return h('div', { class: 'hm-wbar' }, grip, h('span', { class: 'hm-wname' }, icon(WIDGET_ICON[item.id], { size: 14 }), h('span', null, name)), sizes, remove);
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
                      announce.textContent = `${w.name} added where there was room.`;
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

  function emptyBoard() {
    return h(
      'div',
      { class: 'panel hm-board-empty' },
      miniEmpty({
        iconName: 'hm-layout',
        title: 'Your Home is empty',
        text: 'Pick the widgets you want here.',
        action: h('button', { type: 'button', class: 'btn btn--sm btn--primary', onClick: () => setEditing(true) }, 'Customize'),
      }),
    );
  }

  function resetLayout() {
    const before = layoutNow();
    saveLayout(HM.DEFAULT_LAYOUT.map((w) => ({ ...w })));
    toast('Home has its usual widgets again.', { action: { label: 'Undo', onClick: () => saveLayout(before) } });
  }

  function renderBoard() {
    if (dragging) return;
    const layout = layoutNow();
    const active = document.activeElement;
    const focusWidget = active instanceof Element && active.classList.contains('hm-wgrip') ? active.closest('.hm-widget')?.dataset.widget : null;
    const nodes = layout.map((item) => {
      let wrap = wraps.get(item.id);
      if (!wrap) {
        wrap = h('div', { class: 'hm-widget', dataset: { widget: item.id } });
        wraps.set(item.id, wrap);
        resizes.observe(wrap);
      }
      wrap.dataset.size = item.size;
      wrap.classList.toggle('is-editing', editing);
      const card = CARDS[item.id];
      card.inert = editing;
      if (editing) wrap.replaceChildren(widgetBar(item), card);
      else if (wrap.childNodes.length !== 1 || wrap.firstChild !== card) wrap.replaceChildren(card);
      return wrap;
    });
    // Widgets taken off forget their place, so they appear in the new one when added back
    for (const [id, wrap] of wraps) if (!layout.some((w) => w.id === id)) delete wrap.dataset.placed;
    const same = nodes.length === board.children.length && nodes.every((n, i) => board.children[i] === n);
    if (!same) board.replaceChildren(...nodes);
    board.classList.toggle('is-editing', editing);
    below.replaceChildren(...(editing ? [addShelf()] : layout.length ? [] : [emptyBoard()]));
    layoutBoard(layout);
    if (focusWidget) wraps.get(focusWidget)?.querySelector('.hm-wgrip')?.focus({ preventScroll: true });
  }

  const KEY_MOVES = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'top', End: 'bottom' };

  /** Arrow keys on a handle: a column left or right, past the widget above or below (Home / End: top, bottom). */
  function gripKey(e, id) {
    const dir = KEY_MOVES[e.key];
    if (!dir) return;
    e.preventDefault();
    if (!placed || !metrics?.width) return;
    const { cols, gap } = metrics;
    const layout = layoutNow();
    const next = HM.nudgeLayout(HM.settleLayout(layout, placed, cols), id, dir, { cols, heights: heightsOf(layout), gap });
    if (!next) {
      announce.textContent = `${nameOf(id)} can’t move further that way.`;
      return;
    }
    saveLayout(HM.settleLayout(next.layout, next.placed, cols));
    announce.textContent = `${nameOf(id)}: ${HM.placeOf(next.placed, id, cols)}.`;
    const wrap = wraps.get(id);
    setTimeout(() => wrap?.isConnected && wrap.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }), 240);
  }

  /**
   * Drag a widget by its handle: it follows the pointer, the dashed slot shows where it will
   * land (the column under it, at the height nearest the pointer) and the others make room.
   */
  function startDrag(e, id) {
    if (!editing || dragging || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const wrap = wraps.get(id);
    const me = placed?.items.find((p) => p.id === id);
    if (!wrap || !me || !metrics?.width) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const pointerId = e.pointerId;
    const { cols, gap, step } = metrics;
    const layout = layoutNow();
    const heights = heightsOf(layout);
    const base = HM.settleLayout(layout, placed, cols);
    const box = board.getBoundingClientRect();
    const grab = { x: e.clientX - box.left - me.x * step, y: e.clientY - box.top - me.y };
    const scroller = root.closest('.main') ?? document.scrollingElement;
    const slot = h('div', { class: 'hm-drop', 'aria-hidden': 'true' });
    let x = e.clientX;
    let y = e.clientY;
    let current = { layout: base, placed: HM.placeWidgets(base, { cols, heights, gap }) };
    let sig = '';
    let frame = 0;
    dragging = id;
    wrap.classList.add('is-dragging');
    board.classList.add('is-sorting');
    board.append(slot);

    const show = (result) => {
      paintPlaces(result, id);
      const p = result.items.find((q) => q.id === id);
      slot.style.width = `${p.w * step - gap}px`;
      slot.style.height = `${p.h}px`;
      slot.style.transform = `translate(${Math.round(p.x * step)}px, ${Math.round(p.y)}px)`;
    };
    const aim = () => {
      const r = board.getBoundingClientRect();
      const left = x - r.left - grab.x;
      const top = y - r.top - grab.y;
      wrap.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      const next = HM.dropLayout(base, id, { x: Math.round(left / step), top, cols, heights, gap });
      const s = next.layout.map((w) => `${w.id}:${w.col ?? ''}`).join();
      if (s === sig) return;
      sig = s;
      current = next;
      show(next.placed);
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
    // On the window, not the handle: re-rendering the board would drop a pointer capture
    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
    };
    const end = (ev, cancel = false) => {
      if (ev && ev.pointerId !== pointerId) return;
      cancelAnimationFrame(frame);
      // Where the pointer let go (a quick drag can end before the next frame)
      if (ev && !cancel) {
        x = ev.clientX;
        y = ev.clientY;
        aim();
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      dragging = null;
      stopDrag = null;
      slot.remove();
      wrap.classList.remove('is-dragging');
      board.classList.remove('is-sorting');
      const settled = HM.settleLayout(current.layout, current.placed, cols);
      if (!cancel && JSON.stringify(settled) !== JSON.stringify(layout)) {
        saveLayout(settled);
        announce.textContent = `${nameOf(id)}: ${HM.placeOf(current.placed, id, cols)}.`;
      } else renderBoard();
      if (grip.isConnected) grip.focus({ preventScroll: true });
    };
    stopDrag = (cancel) => end(null, cancel);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  root.append(header, editHint, board, below, announce);
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
  // Now that the widgets have their content, place them by their real heights
  layoutBoard();

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
    // The layout or the calendar's view changed (here, or in another window)
    prefs.subscribe(() => {
      renderBoard();
      paintWeek();
    }),
    notesApi.subscribe(() => paintRecent()),
    pomodoroApi.subscribe((v) => pomo.paint(v)),
    onDayChange(() => {
      const onCurrent = isCurrent(calNow().view);
      state.today = todayKey();
      if (onCurrent) state.cursor = state.today;
      paintAll();
    }),
  ];
  // The greeting and "Now / Next" follow the clock; the week dims what has passed now and then
  let ticks = 0;
  const clock = setInterval(() => {
    paintHeader();
    paintAgenda();
    // The week and month every five minutes; today's schedule (its now line) every tick
    if (++ticks % 10 === 0 || (calNow().view === 'day' && state.cursor === state.today)) paintWeek();
  }, 30000);
  // The clock widget and a workout's running time tick every second
  const seconds = setInterval(() => {
    paintClock();
    if (trainingApi.getState().session) paintTraining();
  }, 1000);

  function onKeydown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || menuOpen()) return;
    if (e.target instanceof Element && e.target.closest('.ctx-menu')) return;
    const key = e.key;
    if (editing) {
      if (key === 'Escape') {
        e.preventDefault();
        if (stopDrag) stopDrag(true);
        else setEditing(false);
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
      movePeriod(key === 'ArrowLeft' ? -1 : 1);
    } else if (key === 't' || key === 'T') {
      e.preventDefault();
      goTo(state.today);
    } else if (/^[dwm]$/i.test(key)) {
      e.preventDefault();
      setCal({ view: { d: 'day', w: 'week', m: 'month' }[key.toLowerCase()] });
    }
  }
  document.addEventListener('keydown', onKeydown);

  return () => {
    stopDrag?.(true);
    // A menu lives on <body>: it goes with the page
    viewDD.close();
    showDD.close();
    resizes.disconnect();
    dayResize.disconnect();
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
