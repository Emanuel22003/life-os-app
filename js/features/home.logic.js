// LIFE/OS — 01 // Home: pure helpers for the overview page (greeting, what's next, the week,
// the to-do list, the habit graph). DOM-free, so tools/tests/home.test.js runs them in JavaScriptCore.
// Home stores nothing of its own except per-device preferences (store 'home': { quickNoteSection,
// layout, calendar }).

/** 'Good morning' (5–11) · 'Good afternoon' (12–16) · 'Good evening' (17–4). */
export function greeting(hour) {
  const h = Number(hour);
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}

const startsBefore = (a, b) => (a.start !== b.start ? (a.start < b.start ? -1 : 1) : Number(!a.allDay) - Number(!b.allDay) || (a.startMin ?? 0) - (b.startMin ?? 0) || String(a.title).localeCompare(String(b.title)));

/**
 * What the header announces, from occurrences (calendar.logic occurrencesInRange) of today and
 * the days after it:
 *   { kind: 'now', occ }    a timed event under way today
 *   { kind: 'today', occ }  the next timed event later today
 *   { kind: 'allday', occ } nothing timed left today, but an all-day event covers today
 *   { kind: 'later', occ }  the first event of a later day
 *   null                    nothing scheduled
 */
export function nextUp(occs, today, nowMin) {
  const list = Array.isArray(occs) ? occs : [];
  const timedToday = list.filter((o) => !o.allDay && o.start === today);
  const current = timedToday.filter((o) => o.startMin <= nowMin && nowMin < o.endMin).sort(startsBefore)[0];
  if (current) return { kind: 'now', occ: current };
  const later = timedToday.filter((o) => o.startMin > nowMin).sort(startsBefore)[0];
  if (later) return { kind: 'today', occ: later };
  const allDay = list.filter((o) => o.allDay && o.start <= today && o.end >= today).sort(startsBefore)[0];
  if (allDay) return { kind: 'allday', occ: allDay };
  const future = list.filter((o) => o.start > today).sort(startsBefore)[0];
  return future ? { kind: 'later', occ: future } : null;
}

/**
 * The week strip: one entry per key (Monday … Sunday) with the events touching that day
 * (all-day first, then by start time) and its open tasks (as grouped by calendar.logic
 * tasksByDay: highest priority first).
 * -> [{ key, isToday, isPast, isWeekend, events, tasks }]
 */
export function weekDays(keys, occs, tasksByKey, today) {
  const list = Array.isArray(occs) ? occs : [];
  return (Array.isArray(keys) ? keys : []).map((key, i) => ({
    key,
    isToday: key === today,
    isPast: key < today,
    isWeekend: i % 7 >= 5,
    events: list.filter((o) => o.start <= key && o.end >= key).sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || (a.startMin ?? 0) - (b.startMin ?? 0) || String(a.title).localeCompare(String(b.title))),
    tasks: tasksByKey?.get?.(key) ?? [],
  }));
}

/** At most `max` items of a day, and how many more there are. */
export function clipItems(items, max) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= max) return { shown: list, more: 0 };
  return { shown: list.slice(0, Math.max(0, max - 1)), more: list.length - Math.max(0, max - 1) };
}

/**
 * The to-do list: open tasks overdue (oldest due first), then those due today (highest
 * priority first), each once. -> [{ task, overdueDays }]
 */
export function todoList(overdue, dueToday, today, daysBetween) {
  const seen = new Set();
  const out = [];
  for (const t of [...(Array.isArray(overdue) ? overdue : []), ...(Array.isArray(dueToday) ? dueToday : [])]) {
    if (!t || t.done || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ task: t, overdueDays: t.due && t.due < today ? daysBetween(t.due, today) : 0 });
  }
  return out;
}

/**
 * Bars for the habit graph from habits.stats dailySeries():
 * [{ key, weekday, kind, rate, done, planned }] where kind is
 *   'day'   a finished day with habits planned (rate 0..1)
 *   'today' today, still in progress (rate so far)
 *   'rest'  nothing planned (a gap, not a zero)
 *   'none'  before any habit existed
 * plus the average completion of the finished days (done ÷ planned over them; null if none).
 */
export function graphBars(series) {
  const days = Array.isArray(series) ? series : [];
  let done = 0;
  let planned = 0;
  const bars = days
    .filter((d) => !d.future)
    .map((d) => {
      let kind = 'day';
      if (!d.active && !d.planned) kind = 'none';
      else if (!d.planned) kind = 'rest';
      else if (d.pending) kind = 'today';
      if (kind === 'day') {
        done += d.done;
        planned += d.planned;
      }
      return { key: d.key, weekday: d.weekday, kind, rate: d.planned ? d.done / d.planned : null, done: d.done, planned: d.planned };
    });
  return { bars, average: planned ? done / planned : null };
}

/* ==========================================================================
   Your own Home: which widgets, where, at which size (store 'home'.layout, per device)

   The board has four columns. A widget is one to four of them wide (its size) and sits in the
   column you put it in (col: the leftmost one it covers), under whatever is above it there:
   widgets keep their own height and fall up as far as they can, like stacked cards. So a short
   widget leaves room under it for another one. Narrower pages and phones have two columns
   (small widgets take one, half the width, the rest both, and the calendar always both); only a
   very narrow one has one.
   ========================================================================== */

/** Every widget Home can show, in the order the Add shelf lists them. */
export const WIDGETS = Object.freeze(
  [
    { id: 'week', name: 'Calendar', text: 'Your day, week or month, with the events, tasks and habits you pick.', size: 'l' },
    { id: 'pomodoro', name: 'Focus timer', text: 'Start, pause and skip Pomodoro rounds.', size: 's' },
    { id: 'todo', name: 'To do', text: 'Today’s and overdue tasks, with a quick add.', size: 'm' },
    { id: 'habits', name: 'Habits today', text: 'Tick off the habits planned for today.', size: 's' },
    { id: 'graph', name: 'Habit graph', text: 'How the last two weeks of habits went.', size: 'm' },
    { id: 'note', name: 'Quick note', text: 'Write a note fast; your latest notes.', size: 's' },
    { id: 'clock', name: 'Clock', text: 'The time and date, large.', size: 's' },
    { id: 'agenda', name: 'Agenda', text: 'Your next events, day by day.', size: 's' },
    { id: 'payments', name: 'Payments', text: 'Subscriptions due soon and what they cost a month.', size: 's' },
    { id: 'training', name: 'Training', text: 'Start a routine, or get back to the workout in progress.', size: 's' },
  ].map((w) => Object.freeze(w)),
);

export const WIDGET_IDS = Object.freeze(WIDGETS.map((w) => w.id));

/** Widths on Home's four-column board: a quarter, a half, three quarters, all of it. */
export const SIZES = Object.freeze(['s', 'm', 'l', 'xl']);
export const SIZE_LABEL = Object.freeze({ s: 'Small', m: 'Medium', l: 'Large', xl: 'Full width' });
export const COLUMNS = 4;
const SPAN = Object.freeze({ s: 1, m: 2, l: 3, xl: 4 });

/** The Home everyone starts with (the six widgets Home always had). */
export const DEFAULT_LAYOUT = Object.freeze(
  [
    { id: 'week', size: 'l', col: 0 },
    { id: 'pomodoro', size: 's', col: 3 },
    { id: 'todo', size: 'm', col: 0 },
    { id: 'habits', size: 's', col: 2 },
    { id: 'note', size: 's', col: 3 },
    { id: 'graph', size: 'm', col: 0 },
  ].map((w) => Object.freeze(w)),
);

const defaultSize = (id) => WIDGETS.find((w) => w.id === id)?.size ?? 's';

/** A widget's column, kept on the board (a size too wide for it moves it left); none -> undefined. */
function fitColumn(col, size) {
  if (!Number.isInteger(col)) return undefined;
  return Math.max(0, Math.min(col, COLUMNS - SPAN[size]));
}

const entry = (id, size, col) => (col === undefined ? { id, size } : { id, size, col });

/**
 * A stored layout, repaired: known widgets once each, known sizes, columns on the board. A
 * widget without a column finds the highest spot it fits. No layout yet -> the default.
 */
export function normalizeLayout(raw) {
  if (!Array.isArray(raw)) return DEFAULT_LAYOUT.map((w) => ({ ...w }));
  const seen = new Set();
  const out = [];
  for (const it of raw) {
    const id = typeof it === 'string' ? it : it?.id;
    if (!WIDGET_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const size = SIZES.includes(it?.size) ? it.size : defaultSize(id);
    out.push(entry(id, size, fitColumn(it?.col, size)));
  }
  return out;
}

/** The widgets not on Home, in catalog order. */
export function hiddenWidgets(layout) {
  const shown = new Set(normalizeLayout(layout).map((w) => w.id));
  return WIDGETS.filter((w) => !shown.has(w.id));
}

/** The layout with `id` moved to position `to` in the order (clamped). */
export function moveWidget(layout, id, to) {
  const list = normalizeLayout(layout);
  const from = list.findIndex((w) => w.id === id);
  if (from === -1) return list;
  const [item] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
  return list;
}

export function resizeWidget(layout, id, size) {
  return normalizeLayout(normalizeLayout(layout).map((w) => (w.id === id && SIZES.includes(size) ? { ...w, size } : w)));
}

export function removeWidget(layout, id) {
  return normalizeLayout(layout).filter((w) => w.id !== id);
}

/** Put a widget on Home (at its usual size, where it fits highest); a widget already there stays put. */
export function addWidget(layout, id, size = null) {
  const list = normalizeLayout(layout);
  if (!WIDGET_IDS.includes(id) || list.some((w) => w.id === id)) return list;
  return [...list, { id, size: SIZES.includes(size) ? size : defaultSize(id) }];
}

/* ---- Placing the widgets ---- */

/**
 * How many columns a board this wide (px) has: four on a wide one, two on a narrower one and
 * on a phone (so two small widgets sit side by side there), one only below 300px.
 */
export function columnsFor(width) {
  const w = Number(width) || 0;
  if (w >= 820) return COLUMNS;
  return w >= 300 ? 2 : 1;
}

/** How many columns a widget takes on a board of `cols` (4, 2 or 1). */
export function spanOf(size, cols = COLUMNS) {
  if (cols >= COLUMNS) return SPAN[size] ?? 1;
  if (cols <= 1) return 1;
  return size === 's' ? 1 : cols;
}

/**
 * Widgets that need more than half a phone: a calendar 160px wide shows its days as slivers
 * and its menus as empty boxes. On two columns they take both, whatever their size.
 */
export const ROOMY = Object.freeze(['week']);

/** How many columns widget `it` ({ id, size }) takes on a board of `cols`. */
export function widgetSpan(it, cols = COLUMNS) {
  return cols === 2 && ROOMY.includes(it.id) ? 2 : spanOf(it.size, cols);
}

/** Where a stored column (of four) lands on a board of `cols`; no column stays null. */
export function columnOn(col, span, cols = COLUMNS) {
  if (!Number.isInteger(col)) return null;
  const c = cols >= COLUMNS ? col : Math.floor((col * cols) / COLUMNS);
  return Math.max(0, Math.min(c, cols - span));
}

/** On a two-column board, a difference this tall (px) between the columns is a hole to fill. */
export const HOLE = 48;

/**
 * Lay the board out. Each widget, in order, goes into its columns as high as it fits, under
 * what is already there; one without a column takes the spot where it sits highest (leftmost
 * first). heights: { id: px }. Returns { items: [{ id, x, w, y, h }], height } in px and columns.
 *
 * Two columns (a phone) keep the board dense, so you see more at once:
 * - a small widget keeps its column only while the columns are about even; when the other one
 *   is clearly shorter, it goes there (a layout made on four columns often has every small
 *   widget on the right, which would leave the left side empty);
 * - a wide widget goes under both columns, so a lone small widget above it would leave a hole
 *   beside it: the following small widgets move up first (as many, in order, as even the
 *   columns out best).
 * Four columns keep the order and the columns exactly.
 */
export function placeWidgets(layout, { cols = COLUMNS, heights = {}, gap = 0 } = {}) {
  const tops = new Array(cols).fill(0);
  const items = [];
  const heightOf = (id) => Math.max(0, Number(heights[id]) || 0);
  const two = cols === 2;
  // Where a small widget goes on two columns, given the columns' bottoms `t`
  const smallColumn = (it, t) => {
    const x = columnOn(it.col, 1, cols);
    if (x !== null && t[1 - x] > t[x] - HOLE) return x;
    return t[1] < t[0] ? 1 : 0;
  };
  const put = (it, x, w) => {
    const y = Math.max(...tops.slice(x, x + w));
    const h = heightOf(it.id);
    for (let c = x; c < x + w; c++) tops[c] = y + h + gap;
    items.push({ id: it.id, x, w, y, h });
  };
  const queue = [...layout];
  while (queue.length) {
    const it = queue.shift();
    const w = widgetSpan(it, cols);
    if (two && w === 1) {
      put(it, smallColumn(it, tops), 1);
      continue;
    }
    if (two && Math.abs(tops[0] - tops[1]) >= HOLE) {
      // Try moving up the next one, two, … small widgets; keep the count that evens out best
      const smalls = queue.filter((q) => widgetSpan(q, cols) === 1);
      const t = [...tops];
      let best = 0;
      let bestHole = Math.abs(t[0] - t[1]);
      for (let k = 0; k < smalls.length && bestHole >= HOLE; k++) {
        t[smallColumn(smalls[k], t)] += heightOf(smalls[k].id) + gap;
        const hole = Math.abs(t[0] - t[1]);
        if (hole < bestHole) {
          best = k + 1;
          bestHole = hole;
        }
      }
      for (const small of smalls.slice(0, best)) {
        queue.splice(queue.indexOf(small), 1);
        put(small, smallColumn(small, tops), 1);
      }
    }
    let x = columnOn(it.col, w, cols);
    if (x === null) {
      const at = (c) => Math.max(...tops.slice(c, c + w));
      x = 0;
      for (let c = 1; c <= cols - w; c++) if (at(c) < at(x)) x = c;
    }
    put(it, x, w);
  }
  return { items, height: items.length ? Math.max(...tops) - gap : 0 };
}

/** The column to store (of four) for a widget `span` columns wide, shown in column `x` of `cols`. */
function storedColumn(x, prev, span, cols) {
  if (cols >= COLUMNS) return x;
  if (cols <= 1) return Number.isInteger(prev) ? prev : undefined;
  if (Number.isInteger(prev) && columnOn(prev, span, cols) === x) return prev;
  return Math.round((x * COLUMNS) / cols);
}

/**
 * The layout as placed: every widget's column written down and the order made top to bottom,
 * left to right (reading order). The board looks the same, at this width and wider ones.
 */
export function settleLayout(layout, placed, cols = COLUMNS) {
  const at = new Map(placed.items.map((p) => [p.id, p]));
  const list = normalizeLayout(layout).map((it) => {
    const p = at.get(it.id);
    return p ? entry(it.id, it.size, fitColumn(storedColumn(p.x, it.col, widgetSpan(it, cols), cols), it.size)) : it;
  });
  const rank = (id) => at.get(id) ?? { y: Infinity, x: 0 };
  return list.sort((a, b) => rank(a.id).y - rank(b.id).y || rank(a.id).x - rank(b.id).x);
}

/** Every place `id` can take in column `x`: [{ layout, placed, x, y, col, index }] (one per slot in the order). */
function slotsIn(layout, id, x, opts) {
  const cols = opts.cols ?? COLUMNS;
  const list = normalizeLayout(layout);
  const from = list.findIndex((w) => w.id === id);
  if (from === -1) return [];
  const item = list[from];
  const rest = list.filter((_, i) => i !== from);
  const span = widgetSpan(item, cols);
  const col = Math.max(0, Math.min(x, cols - span));
  const moved = entry(item.id, item.size, fitColumn(storedColumn(col, item.col, span, cols), item.size));
  const out = [];
  for (let i = 0; i <= rest.length; i++) {
    const cand = [...rest.slice(0, i), moved, ...rest.slice(i)];
    const placed = placeWidgets(cand, opts);
    const at = placed.items.find((p) => p.id === id);
    out.push({ layout: cand, placed, x: at.x, y: at.y, col, index: i, from });
  }
  return out;
}

/**
 * Where a dragged widget lands: in column `x` (of opts.cols), at the place whose top is nearest
 * `top` (px); on a tie, the place nearest where it was. On two columns a small widget can end up
 * in the shorter column instead: the places where it really is in column `x` come first.
 * Returns { layout, placed }.
 */
export function dropLayout(layout, id, { x, top, ...opts }) {
  const slots = slotsIn(layout, id, x, opts);
  const inColumn = slots.filter((s) => s.x === s.col);
  let best = null;
  for (const s of inColumn.length ? inColumn : slots) {
    const score = Math.abs(s.y - top);
    const tie = Math.abs(s.index - s.from);
    if (!best || score < best.score - 0.5 || (Math.abs(score - best.score) <= 0.5 && tie < best.tie)) best = { ...s, score, tie };
  }
  if (!best) {
    const list = normalizeLayout(layout);
    return { layout: list, placed: placeWidgets(list, opts) };
  }
  return { layout: best.layout, placed: best.placed };
}

/**
 * The keyboard's move: 'left' / 'right' one column (keeping its height as near as it can),
 * 'up' / 'down' past the widget above / below it, 'top' / 'bottom' of its column.
 * Returns { layout, placed }, or null when it can't go that way.
 */
export function nudgeLayout(layout, id, dir, opts = {}) {
  const cols = opts.cols ?? COLUMNS;
  const now = placeWidgets(normalizeLayout(layout), opts).items.find((p) => p.id === id);
  if (!now) return null;
  if (dir === 'left' || dir === 'right') {
    const x = now.x + (dir === 'left' ? -1 : 1);
    if (x < 0 || x + now.w > cols) return null;
    const moved = dropLayout(layout, id, { ...opts, x, top: now.y });
    // Two columns keep a small widget in the shorter one: then it can't go that way
    return moved.placed.items.find((p) => p.id === id).x === now.x ? null : moved;
  }
  let pick = null;
  for (const s of slotsIn(layout, id, now.x, opts)) {
    if (Math.abs(s.y - now.y) < 0.5) continue;
    const better =
      (dir === 'up' && s.y < now.y && (!pick || s.y > pick.y)) ||
      (dir === 'down' && s.y > now.y && (!pick || s.y < pick.y)) ||
      (dir === 'top' && s.y < now.y && (!pick || s.y < pick.y)) ||
      (dir === 'bottom' && s.y > now.y && (!pick || s.y > pick.y));
    if (better) pick = s;
  }
  return pick ? { layout: pick.layout, placed: pick.placed } : null;
}

/** Where a placed widget is, in words: its column and how far down it is in it ("column 2 of 4, second"). */
export function placeOf(placed, id, cols = COLUMNS) {
  const me = placed.items.find((p) => p.id === id);
  if (!me) return '';
  const above = placed.items.filter((p) => p !== me && p.y < me.y && p.x < me.x + me.w && me.x < p.x + p.w).length;
  const nth = ['at the top', 'second', 'third', 'fourth', 'fifth'][above] ?? `${above + 1}th from the top`;
  return cols > 1 ? `column ${me.x + 1} of ${cols}, ${nth}` : nth;
}

/* ==========================================================================
   The calendar widget: a day, the week or the month, and what it shows
   (store 'home'.calendar, per device: { view, layers })
   ========================================================================== */

export const CAL_VIEWS = Object.freeze(['day', 'week', 'month']);
export const CAL_VIEW_LABEL = Object.freeze({ day: 'Day', week: 'Week', month: 'Month' });
export const CAL_NOW_LABEL = Object.freeze({ day: 'Today', week: 'This week', month: 'This month' });
export const CAL_LAYERS = Object.freeze(['events', 'tasks', 'habits', 'completed']);
export const CAL_LAYER_LABEL = Object.freeze({ events: 'Events', tasks: 'Tasks', habits: 'Habits', completed: 'Done tasks' });
export const DEFAULT_CAL = Object.freeze({ view: 'week', layers: Object.freeze({ events: true, tasks: true, habits: true, completed: false }) });

/** The widget's settings, repaired: a known view, every layer on or off (the default where unset). */
export function normalizeCalView(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const layers = {};
  for (const k of CAL_LAYERS) layers[k] = typeof src.layers?.[k] === 'boolean' ? src.layers[k] : DEFAULT_CAL.layers[k];
  return { view: CAL_VIEWS.includes(src.view) ? src.view : DEFAULT_CAL.view, layers };
}

/** The settings with `patch` applied ({ view } and/or { layers: { name: bool } }). */
export function withCalView(raw, patch = {}) {
  const cur = normalizeCalView(raw);
  return normalizeCalView({ view: patch.view ?? cur.view, layers: { ...cur.layers, ...(patch.layers ?? {}) } });
}

/**
 * The calendar's "Show" menu: a checkbox per layer. Done tasks can only show with the tasks, so
 * it is greyed out while Tasks is off (and doesn't count as on).
 */
export function calLayerItems(layers) {
  const on = normalizeCalView({ layers }).layers;
  return CAL_LAYERS.map((k) => {
    const off = k === 'completed' && !on.tasks;
    return { value: k, label: CAL_LAYER_LABEL[k], checked: on[k], disabled: off, hint: off ? 'needs Tasks' : null };
  });
}

/** Whether `cursor` is in the period that holds `today` (same day, ISO week or month). */
export function isCurrentPeriod(view, cursor, today, mondayOf) {
  if (view === 'day') return cursor === today;
  if (view === 'week') return mondayOf(cursor) === mondayOf(today);
  return String(cursor).slice(0, 7) === String(today).slice(0, 7);
}

/** What to say when a period shows nothing. */
export function calEmptyText(view, layers) {
  if (!layers.events && !layers.tasks && !layers.habits) return 'Everything is switched off. Turn on Events, Tasks or Habits in the Show menu.';
  return `Nothing planned ${view === 'day' ? 'this day' : view === 'week' ? 'this week' : 'this month'}.`;
}
