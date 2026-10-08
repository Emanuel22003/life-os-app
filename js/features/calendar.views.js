// LIFE/OS — 04 // Calendar: view builders (month grid, week + day timelines, phone agenda,
// Unscheduled tray). Pure DOM out of a render context; no listeners here: calendar.js
// handles every click, key and drag by delegation through these data attributes:
//   data-act      click action: zoom-week · zoom-day · event · add-event · add-allday ·
//                 task-check · task-open · task-schedule · more · habit-check · layer-on
//   data-drag     'task' | 'event' (month / all-day bars); data-tl='event' + data-tl-resize
//   data-tl-day   a timeline column; data-drop-day / data-drop-tray: drop targets
//   data-zoom     'week:<monday>' | 'day:<key>': what a zoom transition grows from / into
//   data-fid      focus id, so focus survives a re-render
//
// Visual language (grayscale): EVENTS are filled bars and blocks in one of four looks
// (solid · outline · hatched · ink); TASKS are outlined chips with a square check; HABITS
// are round dots and a done / planned readout, never squares.

import { h, icon, registerIcon, idx, term, plural, weekday, WEEKDAYS_SHORT, MONTHS_SHORT } from '../ui.js';
import {
  WEEK_ORDER,
  STYLES,
  STYLE_LABEL,
  monthGrid,
  weekKeys,
  isoWeek,
  layoutSpans,
  layoutTimed,
  parseTime,
  laneCount,
  viewTitle,
  timeLabel,
  durationLabel,
  daysBetween,
  formatTime,
} from './calendar.logic.js';

registerIcon('repeat', '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>');
registerIcon('map-pin', '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>');

// One letter on every chip (H / M / L), styled like the Tasks module: high inverted, medium
// outlined, low dashed. The full word is in the tooltip and the accessible label.
export const PRIORITY_TAG = {
  high: { text: 'High', letter: 'H', cls: 'tag--solid' },
  med: { text: 'Medium', letter: 'M', cls: '' },
  low: { text: 'Low', letter: 'L', cls: 'tag--dashed' },
};

/** The H / M / L badge, or null for no priority. */
export function priorityBadge(priority, { hidden = true } = {}) {
  const pri = PRIORITY_TAG[priority];
  if (!pri) return null;
  return h('span', { class: ['tag', 'cal-pri', `cal-pri--${priority}`, pri.cls], title: `${pri.text} priority`, 'aria-hidden': hidden ? 'true' : null }, pri.letter);
}
const HABIT_STATE = { done: 'Done', pending: 'Due', miss: 'Missed', future: 'Planned', bonus: 'Bonus' };
const MIN_BLOCK_PX = 18;

const pad2 = (n) => String(n).padStart(2, '0');
const longDay = (key) => viewTitle('day', key);
const shortDay = (key) => viewTitle('day', key, { short: true });

/* ==========================================================================
   Atoms
   ========================================================================== */

function occTooltip(occ) {
  const parts = [occ.title, occ.allDay ? (occ.spanDays > 1 ? `All day · ${occ.spanDays} days` : 'All day') : timeLabel(occ)];
  if (occ.location) parts.push(occ.location);
  if (occ.recurring) parts.push('Repeats');
  return parts.join(' · ');
}

/** Screen-reader name: type, title, date, time (the date matters: a week shows a repeat many times). */
export function occLabel(occ) {
  const when = occ.allDay
    ? occ.spanDays > 1
      ? `all day, ${shortDay(occ.start)} to ${shortDay(occ.end)}`
      : `all day, ${longDay(occ.start)}`
    : `${longDay(occ.start)}, ${occ.startTime} to ${occ.endTime}`;
  return `Event: ${occ.title}, ${when}${occ.location ? `, ${occ.location}` : ''}${occ.recurring ? ', repeats' : ''}`;
}

/** 'Task: Call bank, due Monday 5 October 2026, high priority, overdue' (no "Task:" with bare). */
function taskLabel(task, ctx, { bare = false } = {}) {
  const parts = [bare ? task.title : `Task: ${task.title}`, task.due ? `due ${longDay(task.due)}` : 'no due date'];
  if (PRIORITY_TAG[task.priority]) parts.push(`${PRIORITY_TAG[task.priority].text.toLowerCase()} priority`);
  if (task.done) parts.push('done');
  else if (task.due && task.due < ctx.today) parts.push('overdue');
  return parts.join(', ');
}

const isPastOcc = (occ, ctx) => occ.end < ctx.today || (occ.end === ctx.today && !occ.allDay && occ.endMin <= ctx.nowMin);

/**
 * A bar for an all-day span or a one-line timed event (month cells, all-day lanes, lists).
 * opts: { prefix (focus id scope), tab (tabindex), cl / cr (continues left / right), drag, extra }
 */
export function eventBar(occ, ctx, { prefix = 'm', tab = '-1', cl = false, cr = false, drag = true, extra = null, glyph = true } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: ['cal-ev', `cal-ev--${occ.style}`, occ.allDay ? 'is-allday' : 'is-timed', cl && 'cont-l', cr && 'cont-r', isPastOcc(occ, ctx) && 'is-past'],
      tabindex: tab,
      'aria-label': occLabel(occ),
      dataset: { act: 'event', occ: occ.occId, drag: drag ? 'event' : null, fid: `ev:${prefix}:${occ.occId}` },
    },
    occ.allDay ? null : h('span', { class: 'cal-ev-time' }, occ.startTime),
    // The tooltip sits on the text, so it isn't read again as the button's description
    h('span', { class: 'cal-ev-title', title: occTooltip(occ) }, occ.title),
    extra,
    glyph && occ.recurring ? h('span', { class: 'cal-ev-rep', 'aria-hidden': 'true' }, icon('repeat', { size: 10, stroke: 2 })) : null,
  );
}

/** Outlined task chip with a tiny square check (month cells, all-day lanes, agenda, tray). */
export function taskChip(task, ctx, { prefix = 'm', tab = '-1', schedule = false } = {}) {
  const overdue = !task.done && task.due && task.due < ctx.today;
  const pri = PRIORITY_TAG[task.priority];
  const tip = `Task: ${task.title}${task.priority !== 'none' ? ` · ${pri.text} priority` : ''}${task.due ? ` · due ${shortDay(task.due)}` : ''}`;
  return h(
    'div',
    {
      class: ['cal-task', task.done && 'is-done', `pri-${task.priority}`, overdue && 'is-overdue'],
      dataset: { drag: 'task', task: task.id },
    },
    h(
      'button',
      {
        type: 'button',
        class: 'cal-task-check',
        role: 'checkbox',
        tabindex: tab,
        'aria-checked': String(!!task.done),
        'aria-label': `${task.done ? 'Reopen' : 'Complete'} task ${task.title}, ${task.due ? `due ${shortDay(task.due)}` : 'no due date'}`,
        dataset: { act: 'task-check', task: task.id, fid: `tc:${prefix}:${task.id}` },
      },
      icon('check', { size: 9, stroke: 3 }),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'cal-task-title',
        tabindex: tab,
        'aria-label': `${taskLabel(task, ctx)}${task.time ? `, at ${task.time}` : ''}. Open to schedule`,
        dataset: { act: 'task-open', task: task.id, fid: `tt:${prefix}:${task.id}` },
      },
      task.time ? h('span', { class: 'cal-task-time tnum' }, task.time) : null,
      h('span', { class: 'cal-task-name', title: tip }, task.title),
    ),
    priorityBadge(task.priority),
    schedule
      ? h(
          'button',
          {
            type: 'button',
            class: 'cal-task-sched',
            tabindex: tab,
            title: 'Schedule…',
            'aria-label': `Schedule ${task.title}, ${task.due ? `due ${shortDay(task.due)}` : 'no due date'}`,
            dataset: { act: 'task-schedule', task: task.id, fid: `ts:${prefix}:${task.id}` },
          },
          icon('calendar', { size: 13 }),
        )
      : null,
  );
}

/** Round habit dots + done / planned readout for one day (null when nothing is planned or logged). */
export function habitMeter(info, { max = 5, readout = true } = {}) {
  if (!info || (!info.planned && !info.bonus.length)) return null;
  const future = info.scheduled.length > 0 && info.scheduled.every((s) => s.status === 'future');
  const perfect = info.planned > 0 && info.done === info.planned;
  const bonus = info.bonus.length ? `${info.planned ? ', ' : ''}${info.bonus.length} bonus` : '';
  const label = future ? `Habits: ${info.planned} planned` : `Habits: ${info.planned ? `${info.done} of ${info.planned} done` : ''}${bonus}`;
  const dots = info.scheduled.length <= max ? info.scheduled : null;
  const el = h('span', { class: ['cal-hb', perfect && 'is-perfect', future && 'is-future', !dots && 'is-count'], title: label, role: 'img', 'aria-label': label });
  if (dots) for (const s of dots) el.append(h('span', { class: ['cal-hb-dot', `is-${s.status}`] }));
  else el.append(h('span', { class: ['cal-hb-dot', info.done ? 'is-done' : future ? 'is-future' : 'is-pending'] }));
  if (dots) info.bonus.slice(0, 2).forEach(() => el.append(h('span', { class: 'cal-hb-dot is-bonus' })));
  if (readout && info.planned && (!future || !dots)) el.append(h('span', { class: 'cal-hb-n tnum' }, future ? String(info.planned) : `${info.done}/${info.planned}`));
  return el;
}

/** The live "now" line on a timeline column. */
export function nowLine(nowMin, hourH) {
  return h(
    'div',
    { class: 'cal-now', style: { top: `${(nowMin / 60) * hourH}px` }, dataset: { now: '' }, 'aria-hidden': 'true' },
    h('span', { class: 'cal-now-label tnum' }, formatTime(nowMin)),
  );
}

/* ==========================================================================
   Month
   ========================================================================== */

/** 'A, B, C and 2 more' for a cell's label (screen readers hear titles, not only counts). */
function names(list, max = 4) {
  if (!list.length) return '';
  const shown = list.slice(0, max).join('; ');
  return list.length > max ? `${shown}; and ${list.length - max} more` : shown;
}

function cellLabel(ctx, key, occs, tasks, info) {
  const parts = [longDay(key)];
  if (key === ctx.today) parts.push('today');
  if (ctx.layers.events) parts.push(`${plural(occs.length, 'event')}${occs.length ? `: ${names(occs.map((o) => (o.allDay ? o.title : `${o.startTime} ${o.title}`)))}` : ''}`);
  if (ctx.layers.tasks) {
    const open = tasks.filter((t) => !t.done);
    parts.push(`${plural(open.length, 'open task')}${open.length ? `: ${names(open.map((t) => t.title))}` : ''}`);
  }
  if (ctx.layers.habits && info?.planned) parts.push(`habits ${info.done} of ${info.planned}`);
  return parts.join(', ');
}

/** Month grid, Monday-first, ISO week numbers in the gutter. Rebuilt on every render. */
export function monthView(ctx) {
  const grid = monthGrid(ctx.cursor, { today: ctx.today });
  const compact = ctx.phone;
  const el = h('div', {
    class: ['cal-month', compact && 'is-compact'],
    role: 'grid',
    'aria-label': `${grid.title}. Arrow keys move between days, Enter opens a day.`,
  });
  el.style.setProperty('--cal-slots', String(ctx.slots));
  el.append(
    h(
      'div',
      { class: 'cal-mhead', role: 'row' },
      h('div', { class: 'cal-mhead-wk label', role: 'columnheader', 'aria-label': 'Week number' }, 'Wk'),
      WEEK_ORDER.map((wd) => h('div', { class: ['cal-mhead-day label', wd === 0 || wd === 6 ? 'is-weekend' : null], role: 'columnheader', 'aria-label': WEEKDAYS_SHORT[wd] }, compact ? WEEKDAYS_SHORT[wd][0] : WEEKDAYS_SHORT[wd])),
    ),
  );
  for (const week of grid.weeks) el.append(compact ? weekRowCompact(ctx, week) : weekRow(ctx, week));
  if (!compact) return el;
  // Phones have no room for the full legend: a one-line key for the cell markers
  const key = h(
    'p',
    { class: 'cal-minilegend label', 'aria-hidden': 'true' },
    ctx.layers.events ? h('span', null, h('span', { class: 'cal-mark-ev cal-ev--solid' }), 'Event') : null,
    ctx.layers.tasks ? h('span', null, h('span', { class: 'cal-mark-task' }), 'Task') : null,
    ctx.layers.habits ? h('span', null, h('span', { class: 'cal-hbar cal-minilegend-hb' }, h('span', { class: 'cal-hbar-fill', style: { width: '66%' } })), 'Habits done') : null,
  );
  return h('div', { class: 'cal-month-wrap' }, el, key);
}

/**
 * The week-number button zooms into its row's week. Its target day stays inside the month on
 * screen (the cursor if it is in that row, else the row's first day of this month), so zooming
 * back out returns to the same month, not the previous one.
 */
function weekNumberButton(ctx, week) {
  const key = week.start <= ctx.cursor && ctx.cursor <= week.end ? ctx.cursor : (week.days.find((d) => d.inMonth) ?? week.days[0]).key;
  return h(
    'div',
    { class: 'cal-wkhead', role: 'rowheader', 'aria-label': `Week ${week.isoWeek}` },
    h(
      'button',
      {
        type: 'button',
        class: 'cal-wknum',
        tabindex: '-1',
        title: `Open week ${week.isoWeek}`,
        'aria-label': `Open week ${week.isoWeek}`,
        dataset: { act: 'zoom-week', key },
      },
      h('span', { class: 'cal-wknum-n tnum' }, idx(week.isoWeek)),
      h('span', { class: 'cal-wknum-go', 'aria-hidden': 'true' }, icon('chevron-right', { size: 11, stroke: 2 })),
    ),
  );
}

function dateText(day, compact) {
  if (day.date === 1 && !compact) return `${day.date} ${MONTHS_SHORT[Number(day.key.slice(5, 7)) - 1]}`;
  return String(day.date);
}

function cellClasses(ctx, day) {
  return [
    'cal-cell',
    !day.inMonth && 'is-out',
    day.isToday && 'is-today',
    day.isWeekend && 'is-weekend',
    day.key === ctx.cursor && 'is-selected',
    day.key < ctx.today && 'is-past',
  ];
}

function weekRow(ctx, week) {
  const keys = week.days.map((d) => d.key);
  const slots = ctx.slots;
  const row = h('div', { class: 'cal-wrow', role: 'row', dataset: { zoom: `week:${week.start}` } });
  row.append(weekNumberButton(ctx, week));

  const weekOccs = ctx.layers.events ? ctx.occs.filter((o) => o.start <= week.end && o.end >= week.start) : [];
  const spans = layoutSpans(weekOccs, keys, { includeTimed: true });
  const dayTasks = keys.map((k) => (ctx.layers.tasks ? ctx.tasksByDay.get(k) ?? [] : []));
  // A day with tasks keeps its last row for them: events alone can never push every task of a
  // day (the high-priority one first) into "+N more"
  const evRows = dayTasks.map((t) => (t.length ? Math.max(1, slots - 1) : slots));
  const used = keys.map(() => new Array(slots).fill(false));
  const hiddenEv = keys.map(() => 0);
  const hiddenTask = keys.map(() => 0);
  const dayOccs = keys.map(() => []);
  const items = [];

  const place = (s, a, b) => {
    for (let c = a; c <= b; c++) used[c][s.lane] = true;
    const bar = eventBar(s.occ, ctx, { prefix: `m${week.start}`, cl: a === s.startCol ? s.continuesLeft : true, cr: b === s.endCol ? s.continuesRight : true, glyph: false });
    bar.style.gridColumn = `${a + 2} / ${b + 3}`;
    bar.style.gridRow = String(s.lane + 2);
    items.push(bar);
  };
  for (const s of spans) {
    // Draw the bar over the columns where its lane is still open; it is cut (and counted in
    // "+N more") where a day's last row is kept for tasks
    let from = -1;
    for (let c = s.startCol; c <= s.endCol; c++) {
      dayOccs[c].push(s.occ);
      const open = s.lane < evRows[c];
      if (!open) hiddenEv[c]++;
      if (open && from < 0) from = c;
      if (!open && from >= 0) {
        place(s, from, c - 1);
        from = -1;
      }
    }
    if (from >= 0) place(s, from, s.endCol);
  }

  dayTasks.forEach((tasks, c) => {
    let r = 0;
    for (const t of tasks) {
      while (r < slots && used[c][r]) r++;
      if (r >= slots) {
        hiddenTask[c]++;
        continue;
      }
      used[c][r] = true;
      const chip = taskChip(t, ctx, { prefix: 'm' });
      chip.style.gridColumn = String(c + 2);
      chip.style.gridRow = String(r + 2);
      items.push(chip);
      r++;
    }
  });

  week.days.forEach((day, c) => {
    const info = ctx.layers.habits ? ctx.habits?.get(day.key) : null;
    const tasks = dayTasks[c];
    const cell = h(
      'div',
      {
        class: cellClasses(ctx, day),
        role: 'gridcell',
        tabindex: day.key === ctx.cursor ? '0' : '-1',
        'aria-selected': String(day.key === ctx.cursor),
        'aria-current': day.isToday ? 'date' : null,
        'aria-label': cellLabel(ctx, day.key, dayOccs[c], tasks, info),
        style: { gridColumn: String(c + 2) },
        dataset: { key: day.key, dropDay: day.key, zoom: `day:${day.key}`, fid: `cell:${day.key}`, cell: '' },
      },
      h(
        'div',
        { class: 'cal-cell-head' },
        h(
          'button',
          { type: 'button', class: 'cal-date tnum', tabindex: '-1', title: `Open ${shortDay(day.key)}`, 'aria-label': `Open ${longDay(day.key)}`, dataset: { act: 'zoom-day', key: day.key } },
          dateText(day, false),
        ),
        habitMeter(info, { max: 4 }),
      ),
      h(
        'button',
        { type: 'button', class: 'cal-cell-add', tabindex: '-1', title: 'New event', 'aria-label': `New event on ${longDay(day.key)}`, dataset: { act: 'add-event', key: day.key } },
        icon('plus', { size: 12, stroke: 2 }),
      ),
    );
    row.append(cell);
    const ev = hiddenEv[c];
    const tk = hiddenTask[c];
    if (ev || tk) {
      // Typed overflow: hidden tasks show as a hollow square count, so they are never invisible
      const more = h(
        'button',
        {
          type: 'button',
          class: 'cal-more label',
          tabindex: '-1',
          title: `${[ev ? plural(ev, 'more event') : '', tk ? plural(tk, 'more task') : ''].filter(Boolean).join(' · ')} · open ${shortDay(day.key)}`,
          dataset: { act: 'more', key: day.key },
        },
        h('span', { class: 'cal-more-n tnum' }, `+${ev + tk}`),
        h('span', { class: 'cal-more-word' }, 'more'),
        tk ? h('span', { class: 'cal-more-task tnum' }, h('span', { class: 'cal-more-box' }), String(tk)) : null,
      );
      more.style.gridColumn = String(c + 2);
      more.style.gridRow = String(slots + 2);
      items.push(more);
    }
  });

  // Bars and chips overlay the cells; each cell's label already lists its day, and Enter opens it
  for (const it of items) it.setAttribute('aria-hidden', 'true');
  row.append(...items);
  return row;
}

/** Phone month: short bars (events), hollow squares (tasks) and a habit meter per day; a tap opens the day. */
function weekRowCompact(ctx, week) {
  const row = h('div', { class: 'cal-wrow', role: 'row', dataset: { zoom: `week:${week.start}` } });
  row.append(weekNumberButton(ctx, week));
  for (const day of week.days) {
    const occs = ctx.layers.events ? ctx.occs.filter((o) => o.start <= day.key && o.end >= day.key) : [];
    const tasks = ctx.layers.tasks ? ctx.tasksByDay.get(day.key) ?? [] : [];
    const info = ctx.layers.habits ? ctx.habits?.get(day.key) : null;
    const marks = h('span', { class: 'cal-marks', 'aria-hidden': 'true' });
    occs.slice(0, 3).forEach((o) => marks.append(h('span', { class: ['cal-mark-ev', `cal-ev--${o.style}`] })));
    tasks.slice(0, 3).forEach((t) => marks.append(h('span', { class: ['cal-mark-task', t.done && 'is-done', t.priority === 'high' && 'is-high', `pri-${t.priority}`] })));
    const extra = Math.max(0, occs.length - 3) + Math.max(0, tasks.length - 3);
    if (extra) marks.append(h('span', { class: 'cal-mark-more tnum' }, `+${extra}`));
    const meter =
      info && info.planned
        ? h(
            'span',
            { class: ['cal-hbar', info.done === info.planned && 'is-perfect'], 'aria-hidden': 'true' },
            h('span', { class: 'cal-hbar-fill', style: { width: `${Math.round((info.done / info.planned) * 100)}%` } }),
          )
        : null;
    row.append(
      h(
        'div',
        {
          class: cellClasses(ctx, day),
          role: 'gridcell',
          tabindex: day.key === ctx.cursor ? '0' : '-1',
          'aria-selected': String(day.key === ctx.cursor),
          'aria-current': day.isToday ? 'date' : null,
          'aria-label': cellLabel(ctx, day.key, occs, tasks, info),
          dataset: { key: day.key, dropDay: day.key, zoom: `day:${day.key}`, fid: `cell:${day.key}`, cell: '', act: 'zoom-day' },
        },
        h('span', { class: 'cal-date tnum' }, dateText(day, true)),
        marks,
        meter,
      ),
    );
  }
  return row;
}

/* ==========================================================================
   Timelines (week + day)
   ========================================================================== */

/** Hour labels + one positioned column per key, with timed event blocks and the now line. */
function fillTimeline(tl, ctx, keys) {
  const H = ctx.hourH;
  tl.style.setProperty('--cal-hour', `${H}px`);
  tl.style.setProperty('--cal-cols', String(keys.length));
  const hours = h(
    'div',
    { class: 'cal-tl-hours', 'aria-hidden': 'true' },
    Array.from({ length: 24 }, (_, hr) => h('span', { class: 'cal-tl-hour tnum', style: { top: `${hr * H}px` } }, hr ? `${pad2(hr)}:00` : '')),
  );
  const cols = keys.map((key) => {
    const col = h('div', {
      class: ['cal-tl-col', key === ctx.today && 'is-today', key < ctx.today && 'is-past', key === ctx.cursor && keys.length > 1 && 'is-selected'],
      role: 'group',
      'aria-label': `Timeline for ${longDay(key)}`,
      dataset: { tlDay: key, dropDay: key, zoom: keys.length > 1 ? `day:${key}` : null },
    });
    // Timed events and tasks with a time share the column, side by side when they overlap
    const items = ctx.layers.events ? ctx.occs.filter((o) => !o.allDay && o.start === key) : [];
    if (ctx.layers.tasks) items.push(...timedTasks(ctx.tasksByDay.get(key)));
    for (const b of layoutTimed(items)) col.append(b.occ.task ? taskBlock(b, ctx, keys.length === 1) : timedBlock(b, ctx, keys.length === 1));
    if (key === ctx.today) col.append(nowLine(ctx.nowMin, H));
    return col;
  });
  tl.replaceChildren(hours, ...cols);
}

/** A day's tasks that have a time, as timeline items { occId, startMin, endMin, task }. */
function timedTasks(tasks) {
  const out = [];
  for (const t of tasks ?? []) {
    const s = t.time ? parseTime(t.time) : null;
    if (s === null) continue;
    out.push({ occId: `task:${t.id}`, allDay: false, startMin: s, endMin: Math.min(1439, s + (t.minutes || 30)), task: t });
  }
  return out;
}

/** A task with a time on the timeline: check box, time, title, priority; drag to move or resize. */
function taskBlock(b, ctx, wide) {
  const { task } = b.occ;
  const H = ctx.hourH;
  const height = Math.max((b.height / 60) * H, MIN_BLOCK_PX);
  const short = height < 40;
  const narrow = !wide && b.colSpan / b.cols < 0.6;
  const end = formatTime(b.occ.endMin);
  const overdue = !task.done && (task.due < ctx.today || (task.due === ctx.today && b.occ.endMin <= ctx.nowMin));
  return h(
    'div',
    {
      class: ['cal-tltask', task.done && 'is-done', `pri-${task.priority}`, short && 'is-short', narrow && 'is-narrow', wide && 'is-wide', overdue && 'is-past'],
      style: { top: `${(b.top / 60) * H}px`, height: `${height}px`, left: `calc(${(b.col / b.cols) * 100}% + 2px)`, width: `calc(${(b.colSpan / b.cols) * 100}% - 4px)` },
      dataset: { tl: 'task', task: task.id },
    },
    h(
      'button',
      {
        type: 'button',
        class: 'cal-task-check',
        role: 'checkbox',
        'aria-checked': String(!!task.done),
        'aria-label': `${task.done ? 'Reopen' : 'Complete'} task ${task.title}`,
        dataset: { act: 'task-check', task: task.id, fid: `tlc:${task.id}` },
      },
      icon('check', { size: 9, stroke: 3 }),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'cal-tltask-body',
        'aria-label': `${taskLabel(task, ctx)}, ${task.time} to ${end}. Open to schedule; drag to move`,
        dataset: { act: 'task-open', task: task.id, fid: `tlt:${task.id}` },
      },
      h('span', { class: 'cal-tlev-time tnum' }, short || narrow ? task.time : `${task.time}–${end}`),
      h('span', { class: 'cal-tlev-title', title: `Task: ${task.title}` }, task.title),
    ),
    priorityBadge(task.priority),
    h('span', { class: 'cal-tlev-resize', dataset: { tlResize: '' }, 'aria-hidden': 'true' }),
  );
}

// Line boxes of a timed block (px), so the title clamps to whole lines that really fit
const TL_PAD = 8; // 3 + 3 padding, 1 + 1 border
const TL_TIME = 13; // time row incl. the 1px gap
const TL_LOC = 14;

function timedBlock(b, ctx, wide) {
  const { occ } = b;
  const H = ctx.hourH;
  const top = (b.top / 60) * H;
  const height = Math.max((b.height / 60) * H, MIN_BLOCK_PX);
  const left = (b.col / b.cols) * 100;
  const width = (b.colSpan / b.cols) * 100;
  const short = height < 40;
  // A block squeezed into part of a week column shows its start time only
  const narrow = !wide && b.colSpan / b.cols < 0.6;
  // Only a block that is both tiny and squeezed drops its time; a wide short one reads '09:00 Standup'
  const tiny = height < 26 && narrow;
  const lineH = wide ? 16 : narrow ? 13 : 14;
  let lines = 1;
  let showLoc = false;
  if (!short) {
    lines = Math.floor((height - TL_PAD - TL_TIME) / lineH);
    showLoc = !narrow && !!occ.location && Math.floor((height - TL_PAD - TL_TIME - TL_LOC) / lineH) >= 2;
    if (showLoc) lines = Math.floor((height - TL_PAD - TL_TIME - TL_LOC) / lineH);
    lines = Math.max(1, Math.min(6, lines));
  }
  const block = h(
    'button',
    {
      type: 'button',
      class: ['cal-tlev', `cal-ev--${occ.style}`, short && 'is-short', tiny && 'is-tiny', narrow && 'is-narrow', isPastOcc(occ, ctx) && 'is-past', wide && 'is-wide'],
      style: { top: `${top}px`, height: `${height}px`, left: `calc(${left}% + 2px)`, width: `calc(${width}% - 4px)` },
      'aria-label': occLabel(occ),
      dataset: { act: 'event', occ: occ.occId, tl: 'event', fid: `tl:${occ.occId}` },
    },
    h('span', { class: 'cal-tlev-time tnum' }, short || narrow ? occ.startTime : `${occ.startTime}–${occ.endTime}`),
    h('span', { class: 'cal-tlev-title', title: occTooltip(occ) }, occ.title),
    showLoc ? h('span', { class: 'cal-tlev-loc' }, icon('map-pin', { size: 10 }), occ.location) : null,
    occ.recurring && !short && !narrow ? h('span', { class: 'cal-ev-rep', 'aria-hidden': 'true' }, icon('repeat', { size: 10, stroke: 2 })) : null,
    h('span', { class: 'cal-tlev-resize', dataset: { tlResize: '' }, 'aria-hidden': 'true' }),
  );
  block.style.setProperty('--cal-lines', String(lines));
  return block;
}

/**
 * "▲ 3 earlier" / "▼ 1 later" chips pinned to a timeline scroller's edges, one per column whose
 * timed events are all out of view above or below. `view` = { from, to } in minutes. Each chip
 * says where to scroll (data-scroll-min): the nearest hidden event.
 */
export function fillEdges(top, bottom, ctx, keys, view) {
  const H = ctx.hourH;
  // Blocks are at least MIN_BLOCK_PX tall, so a short event's visible end is later than its end
  const end = (o) => Math.max(o.endMin, o.startMin + (MIN_BLOCK_PX / H) * 60);
  const cols = keys.map((key) => {
    const timed = ctx.layers.events ? ctx.occs.filter((o) => !o.allDay && o.start === key) : [];
    const up = timed.filter((o) => end(o) <= view.from);
    const down = timed.filter((o) => o.startMin >= view.to);
    // The nearest hidden one: the latest above, the earliest below
    const nearUp = up.reduce((a, o) => (!a || o.startMin > a.startMin ? o : a), null);
    const nearDown = down.reduce((a, o) => (!a || o.startMin < a.startMin ? o : a), null);
    return { key, up, down, nearUp, nearDown };
  });
  // Scrolling calls this every frame: touch the DOM only when a chip changes
  const sig = JSON.stringify(cols.map((c) => [c.key, c.up.length, c.nearUp?.occId, c.down.length, c.nearDown?.occId]));
  if (top.dataset.sig === sig) return;
  top.dataset.sig = sig;
  const make = (dir, c) => {
    const list = dir === 'up' ? c.up : c.down;
    const near = dir === 'up' ? c.nearUp : c.nearDown;
    return h(
      'button',
      {
        type: 'button',
        class: ['cal-edge', `cal-edge--${dir}`],
        'aria-label': `${plural(list.length, dir === 'up' ? 'earlier event' : 'later event')} on ${shortDay(c.key)}, show ${near.title}`,
        title: list.map((o) => `${o.startTime} ${o.title}`).join('\n'),
        dataset: { act: 'tl-edge', scrollMin: String(near.startMin), occ: near.occId },
      },
      h('span', { class: 'cal-edge-arrow', 'aria-hidden': 'true' }, dir === 'up' ? '▲' : '▼'),
      h('span', { class: 'tnum' }, String(list.length)),
      h('span', { class: 'cal-edge-word' }, dir === 'up' ? 'earlier' : 'later'),
    );
  };
  const cells = (dir) =>
    cols.map((c, i) => {
      const slot = h('div', { class: 'cal-edge-cell', style: { gridColumn: String(i + 2) } });
      if ((dir === 'up' ? c.up : c.down).length) slot.append(make(dir, c));
      return slot;
    });
  top.style.setProperty('--cal-cols', String(keys.length));
  bottom.style.setProperty('--cal-cols', String(keys.length));
  top.replaceChildren(...cells('up'));
  bottom.replaceChildren(...cells('down'));
}

/** All-day lane above the week timeline: span bars, then each day's tasks. */
function fillAllday(el, ctx, keys) {
  const allDay = ctx.layers.events ? ctx.occs.filter((o) => o.allDay) : [];
  const spans = layoutSpans(allDay, keys);
  const lanes = laneCount(spans);
  const items = [];
  for (const s of spans) {
    const bar = eventBar(s.occ, ctx, { prefix: 'ad', tab: '0', cl: s.continuesLeft, cr: s.continuesRight });
    bar.style.gridColumn = `${s.startCol + 2} / ${s.endCol + 3}`;
    bar.style.gridRow = String(s.lane + 1);
    items.push(bar);
  }
  // Each day's tasks start under that day's own bars, so a span elsewhere wastes no rows
  const top = keys.map(() => 0);
  for (const s of spans) for (let c = s.startCol; c <= s.endCol; c++) top[c] = Math.max(top[c], s.lane + 1);
  let rowsUsed = lanes;
  keys.forEach((key, c) => {
    // Tasks with a time are on the timeline below
    const tasks = ctx.layers.tasks ? (ctx.tasksByDay.get(key) ?? []).filter((t) => !t.time) : [];
    tasks.forEach((t, i) => {
      const chip = taskChip(t, ctx, { prefix: 'ad', tab: '0' });
      chip.style.gridColumn = String(c + 2);
      chip.style.gridRow = String(top[c] + i + 1);
      items.push(chip);
    });
    rowsUsed = Math.max(rowsUsed, top[c] + tasks.length);
  });
  const rows = Math.max(1, rowsUsed);
  el.style.setProperty('--cal-cols', String(keys.length));
  el.style.gridTemplateRows = `repeat(${rows}, var(--cal-slot))`;
  el.replaceChildren(
    h('div', { class: 'cal-ad-label label', style: { gridRow: `1 / ${rows + 1}` } }, 'All day'),
    ...keys.map((key, c) =>
      h('div', {
        class: ['cal-ad-col', key === ctx.today && 'is-today'],
        style: { gridColumn: String(c + 2), gridRow: `1 / ${rows + 1}` },
        title: 'Click to add an all-day event',
        dataset: { dropDay: key, act: 'add-allday', key },
      }),
    ),
    ...items,
  );
}

function dayHeader(ctx, key, { link = true } = {}) {
  const wd = weekday(key);
  const info = ctx.layers.habits ? ctx.habits?.get(key) : null;
  const inner = [h('span', { class: 'cal-dh-dow label' }, WEEKDAYS_SHORT[wd]), h('span', { class: 'cal-dh-num tnum' }, idx(Number(key.slice(8))))];
  return h(
    'div',
    { class: ['cal-dh', key === ctx.today && 'is-today', key === ctx.cursor && 'is-selected', key < ctx.today && 'is-past', info?.planned && 'has-hb'] },
    link
      ? h(
          'button',
          { type: 'button', class: 'cal-dh-btn', title: `Open ${shortDay(key)}`, 'aria-label': `Open ${longDay(key)}`, 'aria-current': key === ctx.today ? 'date' : null, dataset: { act: 'zoom-day', key, fid: `dh:${key}` } },
          inner,
        )
      : h('span', { class: 'cal-dh-btn' }, inner),
    habitMeter(info, { max: 5 }),
  );
}

/** Week view: day headers, all-day lane and a 24-hour timeline. The scroller survives updates. */
export function weekView() {
  const head = h('div', { class: 'cal-wk-head' });
  const allday = h('div', { class: 'cal-wk-allday' });
  const tl = h('div', { class: 'cal-tl' });
  const scroller = h('div', { class: 'cal-tl-scroll' }, tl);
  const edgeTop = h('div', { class: 'cal-edges cal-edges--top' });
  const edgeBottom = h('div', { class: 'cal-edges cal-edges--bottom' });
  const el = h('div', { class: 'cal-week panel' }, head, allday, h('div', { class: 'cal-tl-wrap' }, scroller, edgeTop, edgeBottom));
  return {
    el,
    scroller,
    edges: { top: edgeTop, bottom: edgeBottom },
    keys: (ctx) => weekKeys(ctx.cursor),
    update(ctx) {
      const keys = weekKeys(ctx.cursor);
      head.style.setProperty('--cal-cols', '7');
      head.replaceChildren(
        h('div', { class: 'cal-wk-gutter label tnum', title: `ISO week ${isoWeek(keys[0])}` }, `W${idx(isoWeek(keys[0]))}`),
        ...keys.map((k) => dayHeader(ctx, k)),
      );
      fillAllday(allday, ctx, keys);
      fillTimeline(tl, ctx, keys);
    },
  };
}

/* ==========================================================================
   Day
   ========================================================================== */

function taskRow(task, ctx, { prefix, showDue = false }) {
  const overdue = !task.done && task.due && task.due < ctx.today;
  return h(
    'div',
    { class: ['cal-trow', task.done && 'is-done', `pri-${task.priority}`, overdue && 'is-overdue'], dataset: { drag: 'task', task: task.id } },
    h(
      'button',
      {
        type: 'button',
        class: 'check cal-trow-check',
        role: 'checkbox',
        'aria-checked': String(!!task.done),
        'aria-label': `${task.done ? 'Reopen' : 'Complete'} task ${task.title}, ${task.due ? `due ${shortDay(task.due)}` : 'no due date'}`,
        dataset: { act: 'task-check', task: task.id, fid: `rc:${prefix}:${task.id}` },
      },
      icon('check', { size: 13, stroke: 2.5 }),
    ),
    h(
      'button',
      { type: 'button', class: 'cal-trow-title', 'aria-label': `${taskLabel(task, ctx)}. Open to schedule`, dataset: { act: 'task-open', task: task.id, fid: `rt:${prefix}:${task.id}` } },
      task.title,
    ),
    task.time ? h('span', { class: 'cal-trow-due label tnum', title: `${task.time}–${formatTime(parseTime(task.time) + (task.minutes || 30))}` }, task.time) : null,
    showDue && task.due ? h('span', { class: 'cal-trow-due label tnum' }, shortDay(task.due)) : null,
    priorityBadge(task.priority),
  );
}

function habitRow(item, key, ctx) {
  const future = item.status === 'future';
  return h(
    'div',
    { class: ['cal-hrow', `is-${item.status}`] },
    h(
      'button',
      {
        type: 'button',
        class: 'cal-hcheck',
        role: 'checkbox',
        'aria-checked': String(!!item.done),
        'aria-label': future ? `${item.name}: planned for ${longDay(key)}` : `${item.name}, ${longDay(key)}: ${item.done ? 'done, undo' : 'mark done'}`,
        disabled: future,
        title: future ? 'Check in on the day' : item.done ? 'Undo check-in' : 'Check in',
        dataset: { act: 'habit-check', habit: item.id, key, done: String(!!item.done), fid: `hb:${item.id}` },
      },
      icon('check', { size: 12, stroke: 2.5 }),
    ),
    h('span', { class: 'cal-hrow-name' }, item.name),
    h('span', { class: 'cal-hrow-state label' }, HABIT_STATE[item.status] ?? ''),
  );
}

/** A plan section: its heading is a focus anchor (data-fid), e.g. after zooming into the day. */
function section(fid, title, count, ...body) {
  const head = h(
    'div',
    { class: 'cal-plan-head' },
    h('h3', { class: 'cal-plan-title label', tabindex: '-1', dataset: { fid } }, title),
    count != null ? h('span', { class: 'cal-plan-count tnum' }, count) : null,
  );
  return [head, ...body.flat().filter(Boolean)];
}

/** Day view: that day's timeline and a planning panel (tasks, habits, all-day events). */
export function dayView({ onAddTask }) {
  const tl = h('div', { class: 'cal-tl cal-tl--day' });
  const scroller = h('div', { class: 'cal-tl-scroll' }, tl);
  const edgeTop = h('div', { class: 'cal-edges cal-edges--top' });
  const edgeBottom = h('div', { class: 'cal-edges cal-edges--bottom' });
  const tlHead = h('div', { class: 'cal-day-head' });
  const timeline = h('section', { class: 'cal-day-tl panel', 'aria-label': 'Timeline' }, tlHead, h('div', { class: 'cal-tl-wrap' }, scroller, edgeTop, edgeBottom));

  // The add-task field is built once, so a re-render never steals its text or focus
  const addInput = h('input', {
    class: 'input cal-add-input',
    type: 'text',
    maxlength: '500',
    placeholder: term('calendar.addTask', 'Add a task for this day…  !h !m !l'),
    'aria-label': 'New task for this day',
    autocomplete: 'off',
  });
  const addForm = h(
    'form',
    {
      class: 'cal-add-form',
      onSubmit: (e) => {
        e.preventDefault();
        if (onAddTask(addInput.value)) addInput.value = '';
      },
    },
    addInput,
    h('button', { type: 'submit', class: 'btn btn--sm cal-add-btn' }, 'Add'),
  );
  const tasksBody = h('div', { class: 'cal-plan-body' });
  const tasksSec = h('section', { class: 'cal-plan-sec cal-plan-tasks', 'aria-label': 'Tasks' }, tasksBody, addForm);
  const habitsSec = h('section', { class: 'cal-plan-sec cal-plan-habits', 'aria-label': 'Habits' });
  const alldaySec = h('section', { class: 'cal-plan-sec cal-plan-allday', 'aria-label': 'All-day events' });
  const panel = h('aside', { class: 'cal-plan panel hud', 'aria-label': 'Day plan' }, tasksSec, habitsSec, alldaySec);
  const el = h('div', { class: 'cal-day' }, timeline, panel);

  return {
    el,
    scroller,
    addInput,
    edges: { top: edgeTop, bottom: edgeBottom },
    keys: (ctx) => [ctx.cursor],
    update(ctx) {
      const key = ctx.cursor;
      const isToday = key === ctx.today;
      const timed = ctx.layers.events ? ctx.occs.filter((o) => !o.allDay && o.start === key) : [];
      const booked = timed.reduce((n, o) => n + (o.endMin - o.startMin), 0);
      tlHead.replaceChildren(
        h('span', { class: 'label' }, isToday ? 'Today' : daysBetween(ctx.today, key) === 1 ? 'Tomorrow' : daysBetween(ctx.today, key) === -1 ? 'Yesterday' : WEEKDAYS_SHORT[weekday(key)]),
        h('span', { class: 'cal-day-head-sep', 'aria-hidden': 'true' }, term('calendar.sep', '//')),
        h('span', { class: 'label' }, ctx.layers.events ? `${plural(timed.length, 'timed event')}${booked ? ` · ${durationLabel(0, booked)} booked` : ''}` : 'Events hidden'),
      );
      fillTimeline(tl, ctx, [key]);

      // Tasks
      const all = ctx.tasksForDay(key);
      // Tasks with a time first, in time order; then the rest as before
      const open = all.filter((t) => !t.done).sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || (a.time && b.time ? (a.time < b.time ? -1 : a.time > b.time ? 1 : 0) : 0));
      const done = all.filter((t) => t.done);
      const overdue = isToday ? ctx.overdue : [];
      const tasksTitle = isToday ? 'Tasks · due today' : `Tasks · due ${shortDay(key)}`;
      if (!ctx.layers.tasks) {
        tasksBody.replaceChildren(
          ...section('plan-tasks', tasksTitle, null, h('p', { class: 'cal-plan-note' }, 'The Tasks layer is off. ', h('button', { type: 'button', class: 'cal-link', dataset: { act: 'layer-on', layer: 'tasks', fid: 'link:tasks', focus: 'plan-tasks' } }, 'Show tasks'))),
        );
      } else {
        const body = [];
        if (overdue.length) {
          body.push(h('div', { class: 'cal-plan-sub label' }, `Overdue · ${overdue.length}`));
          body.push(h('div', { class: 'cal-plan-list is-overdue' }, overdue.map((t) => taskRow(t, ctx, { prefix: 'od', showDue: true }))));
        }
        if (overdue.length && open.length) body.push(h('div', { class: 'cal-plan-sub label' }, isToday ? 'Due today' : 'Due'));
        if (open.length) body.push(h('div', { class: 'cal-plan-list' }, open.map((t) => taskRow(t, ctx, { prefix: 'dy' }))));
        if (!open.length && !overdue.length) {
          body.push(h('p', { class: 'cal-plan-note' }, done.length ? 'Everything due is done.' : 'Nothing due. Add a task below or drag one here from Unscheduled.'));
        }
        if (done.length) {
          if (ctx.layers.completed) {
            body.push(h('div', { class: 'cal-plan-sub label', tabindex: '-1', dataset: { fid: 'plan-done' } }, `Done · ${done.length}`));
            body.push(h('div', { class: 'cal-plan-list' }, done.map((t) => taskRow(t, ctx, { prefix: 'dd' }))));
          } else {
            body.push(h('button', { type: 'button', class: 'cal-link cal-plan-donelink label', dataset: { act: 'layer-on', layer: 'completed', fid: 'link:done', focus: 'plan-done' } }, `${done.length} done · show`));
          }
        }
        tasksBody.replaceChildren(...section('plan-tasks', tasksTitle, open.length + overdue.length || null, ...body));
      }

      // Habits
      const info = ctx.layers.habits ? ctx.habits?.get(key) : null;
      habitsSec.hidden = !ctx.layers.habits;
      if (ctx.layers.habits) {
        const rows = info ? [...info.scheduled, ...info.bonus] : [];
        const future = key > ctx.today;
        habitsSec.replaceChildren(
          ...section(
            'plan-habits',
            'Habits',
            info?.planned ? (future ? `${info.planned} planned` : `${info.done}/${info.planned}`) : null,
            rows.length
              ? h('div', { class: 'cal-plan-list' }, rows.map((it) => habitRow(it, key, ctx)))
              : h('p', { class: 'cal-plan-note' }, 'No habits planned for this day.'),
            future && rows.length ? h('p', { class: 'cal-plan-note' }, 'Planned. Check in on the day.') : null,
          ),
        );
      }

      // All-day events
      const allDay = ctx.layers.events ? ctx.occs.filter((o) => o.allDay && o.start <= key && o.end >= key) : [];
      if (!ctx.layers.events) {
        alldaySec.replaceChildren(
          ...section('plan-allday', 'All-day events', null, h('p', { class: 'cal-plan-note' }, 'The Events layer is off. ', h('button', { type: 'button', class: 'cal-link', dataset: { act: 'layer-on', layer: 'events', fid: 'link:events', focus: 'plan-allday' } }, 'Show events'))),
        );
      } else {
        alldaySec.replaceChildren(
          ...section(
            'plan-allday',
            'All-day events',
            allDay.length || null,
            allDay.length
              ? h(
                  'div',
                  { class: 'cal-plan-list cal-plan-evs' },
                  allDay.map((o) =>
                    eventBar(o, ctx, {
                      prefix: 'pd',
                      tab: '0',
                      drag: false,
                      extra: o.spanDays > 1 ? h('span', { class: 'cal-ev-span tnum' }, `${daysBetween(o.start, key) + 1}/${o.spanDays}`) : null,
                    }),
                  ),
                )
              : null,
            h(
              'button',
              { type: 'button', class: 'cal-link cal-plan-addev label', dataset: { act: 'add-allday', key, fid: 'link:addev' } },
              icon('plus', { size: 12, stroke: 2 }),
              'All-day event',
            ),
          ),
        );
      }
    },
  };
}

/* ==========================================================================
   Phone week: a vertical agenda of 7 days
   ========================================================================== */

export function agendaView(ctx) {
  const keys = weekKeys(ctx.cursor);
  return h(
    'div',
    { class: 'cal-agenda' },
    keys.map((key) => {
      const occs = ctx.layers.events ? ctx.occs.filter((o) => o.start <= key && o.end >= key) : [];
      const tasks = ctx.layers.tasks ? ctx.tasksByDay.get(key) ?? [] : [];
      const info = ctx.layers.habits ? ctx.habits?.get(key) : null;
      const items = [
        ...occs.map((o) => eventBar(o, ctx, { prefix: `ag${key}`, tab: '0', drag: false })),
        ...tasks.map((t) => taskChip(t, ctx, { prefix: `ag${key}`, tab: '0' })),
      ];
      return h(
        'section',
        {
          class: ['cal-ag-day panel', key === ctx.today && 'is-today', key === ctx.cursor && 'is-selected', key < ctx.today && 'is-past'],
          'aria-label': longDay(key),
          dataset: { dropDay: key, zoom: `day:${key}` },
        },
        h(
          'div',
          { class: 'cal-ag-head' },
          h(
            'button',
            { type: 'button', class: 'cal-ag-date', 'aria-label': `Open ${longDay(key)}`, dataset: { act: 'zoom-day', key, fid: `ag:${key}` } },
            h('span', { class: 'cal-dh-dow label' }, WEEKDAYS_SHORT[weekday(key)]),
            h('span', { class: 'cal-dh-num tnum' }, idx(Number(key.slice(8)))),
            key === ctx.today ? h('span', { class: 'tag tag--solid cal-ag-today' }, 'Today') : null,
          ),
          habitMeter(info, { max: 5 }),
          h(
            'button',
            { type: 'button', class: 'btn btn--ghost btn--icon btn--sm cal-ag-add', title: 'New event', 'aria-label': `New event on ${longDay(key)}`, dataset: { act: 'add-event', key } },
            icon('plus', { size: 14 }),
          ),
        ),
        items.length ? h('div', { class: 'cal-ag-items' }, items) : h('p', { class: 'cal-ag-empty label' }, 'Nothing planned'),
      );
    }),
  );
}

/* ==========================================================================
   Unscheduled tray
   ========================================================================== */

export function trayView() {
  const count = h('span', { class: 'cal-tray-count tnum' });
  const body = h('div', { class: 'cal-tray-body' });
  const el = h(
    'aside',
    { class: 'cal-tray panel hud', 'aria-label': 'Unscheduled tasks', dataset: { dropTray: '' } },
    h('div', { class: 'cal-tray-head' }, icon('inbox', { size: 14 }), h('h3', { class: 'label cal-tray-title', tabindex: '-1', dataset: { fid: 'tray-head' } }, 'Unscheduled'), count),
    body,
  );
  return {
    el,
    update(ctx) {
      const list = ctx.unscheduled;
      count.textContent = list.length ? String(list.length) : '';
      if (!ctx.layers.tasks) {
        body.replaceChildren(h('p', { class: 'cal-plan-note' }, 'The Tasks layer is off. ', h('button', { type: 'button', class: 'cal-link', dataset: { act: 'layer-on', layer: 'tasks', fid: 'link:tray-tasks', focus: 'tray-head' } }, 'Show tasks')));
        return;
      }
      if (!list.length) {
        const anyOpen = ctx.tasks.some((t) => !t.done);
        body.replaceChildren(h('p', { class: 'cal-tray-empty' }, anyOpen ? 'Every open task has a date. Drop a task here to unschedule it.' : 'No open tasks yet. Use Add task to plan one.'));
        return;
      }
      body.replaceChildren(
        h('p', { class: 'cal-tray-hint label' }, ctx.coarse ? 'Tap the calendar icon to schedule' : 'Drag onto a day · or Schedule…'),
        h('div', { class: 'cal-tray-list' }, list.map((t) => taskChip(t, ctx, { prefix: 'tray', tab: '0', schedule: true }))),
      );
    },
  };
}

/* ==========================================================================
   Legend
   ========================================================================== */

export function legend() {
  return h(
    'div',
    { class: 'cal-legend', role: 'group', 'aria-label': 'Legend' },
    h(
      'span',
      { class: 'cal-legend-group' },
      h('span', { class: 'label' }, 'Events'),
      STYLES.map((s) => h('span', { class: ['cal-legend-ev', `cal-ev--${s}`], title: `${STYLE_LABEL[s]} event` }, STYLE_LABEL[s])),
    ),
    h(
      'span',
      { class: 'cal-legend-group' },
      h('span', { class: 'label' }, 'Task'),
      h('span', { class: 'cal-legend-task' }, h('span', { class: 'cal-legend-box' }), 'Square check'),
    ),
    h(
      'span',
      { class: 'cal-legend-group cal-legend-group--hb' },
      h('span', { class: 'label' }, 'Habits'),
      h('span', { class: 'cal-hb cal-legend-hb' }, h('span', { class: 'cal-hb-dot is-done' }), h('span', { class: 'cal-hb-dot is-done' }), h('span', { class: 'cal-hb-dot is-pending' }), h('span', { class: 'cal-hb-n tnum' }, '2/3')),
    ),
  );
}
