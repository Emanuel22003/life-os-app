// LIFE/OS — 01 // Home: pure helpers for the overview page (greeting, what's next, the week,
// the to-do list, the habit graph). DOM-free, so tools/tests/home.test.js runs them in JavaScriptCore.
// Home stores nothing of its own except a preference (store 'home': { quickNoteSection }).

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
    isWeekend: i >= 5,
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
