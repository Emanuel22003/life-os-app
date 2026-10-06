// LIFE/OS — habits: pure, DOM-free logic (normalization, per-day plans, streaks, stats, views).
//
// Day math runs on integer day numbers (days since 1970-01-01) derived from the
// local 'YYYY-MM-DD' keys via Date.UTC, so DST and time-zone offsets can never
// shift or duplicate a day. Every function below expects normalized habits
// (see normalizeHabit); `today` is always passed in so results are testable.
//
// Data model (v2)
//   { id, name, createdAt: key, archivedAt: key | null,
//     plan: [{ from: key, days: number[] }], schedule: number[], log: { [key]: true }, order }
// - `plan` is the source of truth. Each entry lists the weekdays (0 = Sun … 6 = Sat)
//   the habit is planned on from `from` until the next entry; the first entry
//   starts at createdAt. A plan edit made today starts (or replaces) today's entry
//   and never touches earlier ones, so every past day keeps the plan it really had.
// - `schedule` is DERIVED (the plan in effect today) for convenience and compat.
//   Never write it directly: normalization re-derives it from `plan`.
// - A habit is active on createdAt <= day < archivedAt.
//
// Rules
// - A day counts for a habit only if the habit is active that day and the plan in
//   effect that day includes its weekday ("scheduled").
// - A scheduled today that is not done yet is PENDING: it never breaks a streak.
// - Unscheduled days are skipped (neither break nor extend a streak). Completions
//   logged on them are kept and shown as "bonus", but are neutral for stats.

import { uid, dateKey, MONTHS_SHORT, WEEKDAYS_SHORT } from '../ui.js';

export const ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
/** Monday-first display order of weekdays (values are still 0 = Sun … 6 = Sat). */
export const WEEK_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
export const PRESETS = Object.freeze([
  { id: 'daily', label: 'Every day', days: ALL_DAYS },
  { id: 'weekdays', label: 'Weekdays', days: Object.freeze([1, 2, 3, 4, 5]) },
  { id: 'weekends', label: 'Weekends', days: Object.freeze([0, 6]) },
]);
export const VIEWS = Object.freeze(['week', 'history']);
export const NAME_MAX = 80;
export const RATE_WINDOW = 30;
export const HEAT_WEEKS = 16;

/* ==========================================================================
   Day numbers
   ========================================================================== */

const DAY_MS = 86400000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n) => String(n).padStart(2, '0');

/** True for a real calendar date written as 'YYYY-MM-DD' (1970 or later). */
export function isValidKey(key) {
  if (typeof key !== 'string') return false;
  const m = KEY_RE.exec(key);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export function toDayNum(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNum(n) {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOf(n) {
  return (((n + 4) % 7) + 7) % 7;
}

/** Weekday of a 'YYYY-MM-DD' key (0 = Sunday … 6 = Saturday). */
export function weekdayOfKey(key) {
  return weekdayOf(toDayNum(key));
}

/** Monday of the week containing `key`. */
export function weekStart(key) {
  const n = toDayNum(key);
  return fromDayNum(n - ((weekdayOf(n) + 6) % 7));
}

/** The 7 keys Monday … Sunday of the week containing `key`. */
export function weekDays(key) {
  const start = toDayNum(weekStart(key));
  return Array.from({ length: 7 }, (_, i) => fromDayNum(start + i));
}

/* ==========================================================================
   Normalization — tolerate missing / malformed fields from any older data
   ========================================================================== */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWeekday = (d) => Number.isInteger(d) && d >= 0 && d <= 6;

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Accepts 'YYYY-MM-DD' or an ISO timestamp string; anything else -> null. */
function toKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.slice(0, 10);
  return isValidKey(key) ? key : null;
}

/** Trim, collapse whitespace, cap length. Returns '' for nothing usable. */
export function cleanName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/** v1 schedule rules: sorted, de-duplicated weekdays 0..6; anything invalid or empty -> every day. */
export function normalizeSchedule(raw) {
  if (!Array.isArray(raw)) return [...ALL_DAYS];
  const days = normalizeDays(raw);
  return days.length ? days : [...ALL_DAYS];
}

/** Plan-entry days: sorted, de-duplicated weekdays 0..6. Empty is allowed ("planned on no day"). */
export function normalizeDays(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isWeekday))].sort((a, b) => a - b);
}

/** { key: true } with only valid date keys. Also accepts an array of keys. */
export function normalizeLog(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const k of raw) if (isValidKey(k)) out[k] = true;
  } else if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v && isValidKey(k)) out[k] = true;
  }
  return out;
}

function sameLog(clean, raw) {
  if (!isObject(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length === Object.keys(clean).length && keys.every((k) => raw[k] === true && clean[k] === true);
}

/** Earliest key of a normalized log ('YYYY-MM-DD' sorts lexically), or null. */
function firstLogKey(log) {
  let first = null;
  for (const k in log) if (first === null || k < first) first = k;
  return first;
}

/** Earliest valid `from` in a raw plan, or null. */
function firstPlanKey(rawPlan) {
  let first = null;
  if (!Array.isArray(rawPlan)) return first;
  for (const e of rawPlan) {
    const k = isObject(e) ? toKey(e.from) : null;
    if (k && (first === null || k < first)) first = k;
  }
  return first;
}

function normalizeCreatedAt(raw, log, rawPlan, today) {
  const key = toKey(raw);
  if (key) return key;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const k = dateKey(new Date(raw));
    if (isValidKey(k)) return k;
  }
  // Infer from the earliest log / plan entry, but never into the future: a derived
  // start after today would lock the habit in the "not started" state.
  const candidates = [firstLogKey(log), firstPlanKey(rawPlan)].filter(Boolean).sort();
  const first = candidates[0] ?? null;
  return first && first < today ? first : today;
}

/**
 * Canonical plan: valid entries only (from = valid key, days = array), sorted by
 * `from`, later duplicates of a `from` win, anchored so the first entry starts
 * exactly at createdAt (the entry in effect that day; earlier ones are dropped),
 * and consecutive entries with identical days collapsed. No valid entry ->
 * [{ from: createdAt, days: fallbackDays }].
 */
export function normalizePlan(raw, createdAt, fallbackDays = [...ALL_DAYS]) {
  const byFrom = new Map();
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (!isObject(e) || !Array.isArray(e.days)) continue;
      const from = toKey(e.from);
      if (from) byFrom.set(from, normalizeDays(e.days));
    }
  }
  const sorted = [...byFrom.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!sorted.length) return [{ from: createdAt, days: normalizeDays(fallbackDays) }];

  let first = 0;
  for (let i = 0; i < sorted.length && sorted[i][0] <= createdAt; i++) first = i;
  const plan = [{ from: createdAt, days: sorted[first][1] }];
  for (let i = first + 1; i < sorted.length; i++) {
    const [from, days] = sorted[i];
    if (from > createdAt && !sameArray(days, plan[plan.length - 1].days)) plan.push({ from, days });
  }
  return plan;
}

function samePlan(clean, raw) {
  return (
    Array.isArray(raw) &&
    raw.length === clean.length &&
    raw.every((e, i) => isObject(e) && Object.keys(e).length === 2 && e.from === clean[i].from && sameArray(e.days, clean[i].days))
  );
}

/** The habit's plan; tolerates v1-shaped objects (schedule only) by treating them as one entry. */
function plansOf(habit) {
  if (Array.isArray(habit.plan) && habit.plan.length) return habit.plan;
  return [{ from: habit.createdAt, days: Array.isArray(habit.schedule) ? habit.schedule : ALL_DAYS }];
}

/** Days of the entry with the greatest from <= key (the first entry if key precedes all). */
function daysOn(plan, key) {
  let days = plan[0].days;
  for (const p of plan) {
    if (p.from <= key) days = p.days;
    else break;
  }
  return days;
}

/**
 * Returns a valid v2 habit, or null when `raw` is not an object.
 * v1 data ({ schedule } and no plan) migrates to plan [{ from: createdAt, days: schedule }].
 * A habit that is already valid is returned as the SAME object, so the view
 * can skip re-rendering cards whose data did not change.
 */
export function normalizeHabit(raw, fallbackOrder, today) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : Number.isFinite(raw.id) ? String(raw.id) : uid();
  const name = cleanName(typeof raw.name === 'string' || typeof raw.name === 'number' ? raw.name : '') || 'Untitled habit';
  const log = normalizeLog(raw.log);
  const createdAt = normalizeCreatedAt(raw.createdAt, log, raw.plan, today);
  const archivedAt = toKey(raw.archivedAt);
  const plan = normalizePlan(raw.plan, createdAt, normalizeSchedule(raw.schedule));
  const schedule = daysOn(plan, today);
  const order = Number.isFinite(raw.order) ? raw.order : fallbackOrder;
  const keepPlan = samePlan(plan, raw.plan);
  const unchanged =
    id === raw.id &&
    name === raw.name &&
    createdAt === raw.createdAt &&
    archivedAt === raw.archivedAt &&
    keepPlan &&
    sameArray(schedule, raw.schedule) &&
    sameLog(log, raw.log) &&
    order === raw.order;
  if (unchanged) return raw;
  return { ...raw, id, name, createdAt, archivedAt, plan: keepPlan ? raw.plan : plan, schedule: [...schedule], log, order };
}

/** Reassign `order` to match array position (copies only items that change). */
export function reindex(items) {
  return items.map((it, i) => (it.order === i ? it : { ...it, order: i }));
}

/**
 * Normalize the whole store value: { items: Habit[] sorted by order, view }.
 * Returns `raw` itself when nothing needed fixing.
 */
export function normalizeState(raw, today) {
  const src = Array.isArray(raw) ? { items: raw } : isObject(raw) ? raw : {};
  const list = Array.isArray(src.items) ? src.items : [];
  let changed = src !== raw || list !== src.items;

  const seen = new Set();
  const items = [];
  list.forEach((it, i) => {
    let habit = normalizeHabit(it, i, today);
    if (!habit) {
      changed = true;
      return;
    }
    if (seen.has(habit.id)) habit = { ...habit, id: uid() };
    seen.add(habit.id);
    if (habit !== it) changed = true;
    items.push(habit);
  });

  const sorted = reindex(
    items
      .map((it, i) => [it, i])
      .sort((a, b) => a[0].order - b[0].order || a[1] - b[1])
      .map(([it]) => it),
  );
  if (sorted.some((it, i) => it !== items[i])) changed = true;

  const view = VIEWS.includes(src.view) ? src.view : VIEWS[0];
  if (view !== src.view) changed = true;

  return changed ? { ...src, items: sorted, view } : raw;
}

/* ==========================================================================
   Plan & lifecycle queries
   ========================================================================== */

/** Weekdays planned on `key` by the plan in effect that day (first entry if key precedes all). */
export function planOn(habit, key) {
  return daysOn(plansOf(habit), key);
}

/** createdAt <= key < archivedAt. */
export function isActiveOn(habit, key) {
  return habit.createdAt <= key && (!habit.archivedAt || key < habit.archivedAt);
}

/** Active that day AND planned on that weekday by the plan in effect then. */
export function isScheduledOn(habit, key) {
  return isActiveOn(habit, key) && planOn(habit, key).includes(weekdayOfKey(key));
}

/** True once the archive date has been reached (archivedAt <= today). */
export function isArchived(habit, today) {
  return !!habit.archivedAt && habit.archivedAt <= today;
}

/** Habits scheduled on `key`, ordered by `order`. */
export function habitsForDay(items, key) {
  return items.filter((it) => isScheduledOn(it, key)).sort((a, b) => a.order - b.order);
}

export function plannedCount(items, key) {
  let n = 0;
  for (const it of items) if (isScheduledOn(it, key)) n++;
  return n;
}

/**
 * Current weekly plan (as of today), Monday first:
 * [{ weekday, habits: non-archived habits whose current plan includes that weekday }].
 */
export function weekPlan(items, today) {
  const live = items.filter((it) => !isArchived(it, today)).sort((a, b) => a.order - b.order);
  return WEEK_ORDER.map((weekday) => ({ weekday, habits: live.filter((it) => planOn(it, today).includes(weekday)) }));
}

/* ==========================================================================
   Mutations (immutable)
   ========================================================================== */

/**
 * New habit planned on `days` (v2, may be empty) or `schedule` (v1 rules: empty/invalid
 * -> every day) from createdAt (defaults to today).
 */
export function createHabit({ name, schedule, days, createdAt } = {}, order, today) {
  const start = isValidKey(createdAt) ? createdAt : today;
  const planDays = Array.isArray(days) ? normalizeDays(days) : normalizeSchedule(schedule);
  return {
    id: uid(),
    name: cleanName(name) || 'Untitled habit',
    createdAt: start,
    archivedAt: null,
    plan: [{ from: start, days: planDays }],
    schedule: [...planDays],
    log: {},
    order,
  };
}

/** Same habit when plan and derived schedule are unchanged, else a copy with both. */
function withPlan(habit, plan, today) {
  const schedule = daysOn(plan, today);
  if (samePlan(plan, habit.plan) && sameArray(schedule, habit.schedule)) return habit;
  return { ...habit, plan, schedule: [...schedule] };
}

/**
 * Plan `days` from today on. Replaces today's entry if one exists, else appends
 * { from: today, days }; an entry equal to the previous one is dropped. Entries
 * before today are never altered, so past days keep the plan they had. A habit
 * that has not started yet (createdAt > today) simply gets its first entry replaced.
 */
export function setPlanDays(habit, days, today) {
  const next = normalizeDays(days);
  const kept = plansOf(habit).filter((p) => p.from <= today);
  return withPlan(habit, normalizePlan([...kept, { from: today, days: next }], habit.createdAt, next), today);
}

/** Flip one weekday in the plan in effect today (empty plans are allowed). */
export function toggleDayInPlan(habit, weekday, today) {
  if (!isWeekday(weekday)) return habit;
  const cur = planOn(habit, today);
  return setPlanDays(habit, cur.includes(weekday) ? cur.filter((d) => d !== weekday) : [...cur, weekday], today);
}

/** Apply fn(habit) to every non-archived habit; same array when nothing changes. */
function mapLive(items, today, fn) {
  let changed = false;
  const next = items.map((it) => {
    if (isArchived(it, today)) return it;
    const out = fn(it);
    if (out !== it) changed = true;
    return out;
  });
  return changed ? next : items;
}

/** Set membership of `weekday` for one habit (true = planned that weekday). */
function setDay(habit, weekday, on, today) {
  const cur = planOn(habit, today);
  if (cur.includes(weekday) === on) return habit;
  return setPlanDays(habit, on ? [...cur, weekday] : cur.filter((d) => d !== weekday), today);
}

/**
 * Make each target weekday's lineup a copy of `fromWeekday`'s: for every non-archived
 * habit, membership on each target := membership on the source (from today on).
 * `toWeekdays` may be a number or an array. Same array when nothing changes.
 */
export function copyDayPlan(items, fromWeekday, toWeekdays, today) {
  if (!isWeekday(fromWeekday)) return items;
  const targets = normalizeDays(Array.isArray(toWeekdays) ? toWeekdays : [toWeekdays]).filter((d) => d !== fromWeekday);
  if (!targets.length) return items;
  return mapLive(items, today, (it) => {
    const on = planOn(it, today).includes(fromWeekday);
    const set = new Set(planOn(it, today));
    for (const d of targets) {
      if (on) set.add(d);
      else set.delete(d);
    }
    return setPlanDays(it, [...set], today);
  });
}

/** Remove `weekday` from every non-archived habit's plan (from today on). */
export function clearDayPlan(items, weekday, today) {
  if (!isWeekday(weekday)) return items;
  return mapLive(items, today, (it) => setDay(it, weekday, false, today));
}

/**
 * Exactly the habits in `ids` are planned on `weekday` (non-archived habits only, from today on).
 * `ids` must be an array (an empty one clears the day); anything else is ignored, so a bad
 * call can never wipe a day's lineup.
 */
export function setDayMembers(items, weekday, ids, today) {
  if (!isWeekday(weekday) || !Array.isArray(ids)) return items;
  const want = new Set(ids);
  return mapLive(items, today, (it) => setDay(it, weekday, want.has(it.id), today));
}

/** Archive from today: it stops counting today; history before stays. Same habit if already archived. */
export function archiveHabit(habit, today) {
  if (isArchived(habit, today)) return habit;
  return { ...habit, archivedAt: today };
}

/**
 * Bring an archived habit back from today with its latest plan. The archived
 * stretch [archivedAt, today) becomes a "planned on no day" entry, so those days
 * read as rest, never as misses.
 */
export function unarchiveHabit(habit, today) {
  const at = habit.archivedAt;
  if (!at) return habit;
  if (at > today) return { ...habit, archivedAt: null };
  const restore = planOn(habit, today);
  const gapStart = at < habit.createdAt ? habit.createdAt : at;
  const raw = plansOf(habit).filter((p) => p.from < gapStart);
  if (gapStart < today) raw.push({ from: gapStart, days: [] });
  raw.push({ from: today, days: restore });
  return withPlan({ ...habit, archivedAt: null }, normalizePlan(raw, habit.createdAt, restore), today);
}

/**
 * Move the start date. The plan is re-anchored: moving earlier extends the first
 * entry back; moving later keeps the entry in effect on the new start.
 */
export function setCreatedAt(habit, key, today) {
  if (!isValidKey(key) || key === habit.createdAt) return habit;
  const plan = normalizePlan(plansOf(habit), key, planOn(habit, key));
  return withPlan({ ...habit, createdAt: key }, plan, today);
}

/**
 * Edit from a form: { name?, createdAt?, days? } (also accepts v1 `schedule` for days).
 * Days go through setPlanDays (history-safe). Same habit when nothing changes.
 */
export function editHabit(habit, { name, createdAt, days, schedule } = {}, today) {
  let next = habit;
  if (name !== undefined) {
    const clean = cleanName(name);
    if (clean && clean !== next.name) next = { ...next, name: clean };
  }
  if (createdAt !== undefined) next = setCreatedAt(next, createdAt, today);
  const planDays = days ?? schedule;
  if (Array.isArray(planDays)) next = setPlanDays(next, planDays, today);
  return next;
}

/** Mark `key` done / not done. Returns the same habit when nothing changes. */
export function setLog(habit, key, done) {
  if (!!habit.log[key] === !!done) return habit;
  const log = { ...habit.log };
  if (done) log[key] = true;
  else delete log[key];
  return { ...habit, log };
}

/** Move a habit by `delta` positions. Returns the same array when it cannot move. */
export function moveHabit(items, id, delta) {
  const from = items.findIndex((it) => it.id === id);
  const to = from + delta;
  if (from < 0 || delta === 0 || to < 0 || to >= items.length) return items;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return reindex(next);
}

/**
 * Move a habit `delta` steps among the habits whose ids are in `ids` (the list the
 * user is looking at, e.g. habitsForDay), skipping hidden ones: moving up lands it
 * just before the visible neighbour, moving down just after. `items` must be in
 * order (normalized state is). Same array when it cannot move. Without `ids` this
 * is moveHabit.
 */
export function moveHabitWithin(items, id, delta, ids) {
  if (!Array.isArray(ids)) return moveHabit(items, id, delta);
  const shown = new Set(ids);
  const visible = items.filter((it) => it.id === id || shown.has(it.id));
  const vi = visible.findIndex((it) => it.id === id);
  const target = visible[vi + delta];
  if (vi < 0 || !delta || !target) return items;
  const next = items.slice();
  const [it] = next.splice(items.indexOf(visible[vi]), 1);
  // After the removal, inserting at the target's original index lands before it when
  // moving up and right after it when moving down.
  next.splice(items.indexOf(target), 0, it);
  return reindex(next);
}

/** Permanent delete (history included). */
export function removeHabit(items, id) {
  return reindex(items.filter((it) => it.id !== id));
}

/** Toggle one weekday in a schedule. Refuses to remove the last day (returns the same array). */
export function toggleScheduleDay(schedule, day) {
  if (schedule.includes(day)) {
    return schedule.length > 1 ? schedule.filter((d) => d !== day) : schedule;
  }
  return [...schedule, day].sort((a, b) => a - b);
}

/* ==========================================================================
   Schedule helpers
   ========================================================================== */

export function presetOf(schedule) {
  return PRESETS.find((p) => sameArray(p.days, schedule)) ?? null;
}

/** 'Every day' | 'Weekdays' | 'Weekends' | 'Mon · Wed · Fri' | 'Tue · Sun' (Monday first) | 'No days' */
export function scheduleLabel(schedule) {
  if (!schedule.length) return 'No days';
  return presetOf(schedule)?.label ?? WEEK_ORDER.filter((d) => schedule.includes(d)).map((d) => WEEKDAYS_SHORT[d]).join(' · ');
}

/* ==========================================================================
   Compiled habits — day-number fast path shared with habits.stats.js
   ========================================================================== */

/**
 * { start, end, segs: [{ from, days: bool[7] }], log } with day numbers;
 * end = Infinity when not archived. Build once per habit, then query many days.
 */
export function compileHabit(habit) {
  const segs = plansOf(habit).map((p) => {
    const days = [false, false, false, false, false, false, false];
    for (const d of p.days) if (isWeekday(d)) days[d] = true;
    return { from: toDayNum(p.from), days };
  });
  return {
    start: toDayNum(habit.createdAt),
    end: habit.archivedAt ? toDayNum(habit.archivedAt) : Infinity,
    segs,
    log: isObject(habit.log) ? habit.log : {},
  };
}

/** Day number `n` is active (createdAt <= n < archivedAt). */
export function activeAt(c, n) {
  return n >= c.start && n < c.end;
}

/** Day number `n` is scheduled by the plan in effect that day (and active). */
export function scheduledAt(c, n) {
  if (n < c.start || n >= c.end) return false;
  const wd = weekdayOf(n);
  for (let i = c.segs.length - 1; i > 0; i--) if (n >= c.segs[i].from) return c.segs[i].days[wd];
  return c.segs[0].days[wd];
}

/* ==========================================================================
   Day status
   ========================================================================== */

/** 'future' | 'pre' (before createdAt) | 'archived' (on/after archivedAt) | 'done' | 'pending' (today) | 'miss' | 'bonus' | 'rest' */
function stateAt(c, n, t) {
  if (n > t) return 'future';
  if (n < c.start) return 'pre';
  if (n >= c.end) return 'archived';
  const done = !!c.log[fromDayNum(n)];
  if (scheduledAt(c, n)) {
    if (done) return 'done';
    return n === t ? 'pending' : 'miss';
  }
  return done ? 'bonus' : 'rest';
}

/** First day a run can start: no completed day exists before the earliest log entry. */
function runStart(c) {
  const first = firstLogKey(c.log);
  return first ? Math.max(c.start, toDayNum(first)) : Infinity;
}

/** Last day that can count: today, or the day before the archive date. */
const lastDay = (c, t) => Math.min(t, c.end - 1);

export function dayStatus(habit, key, today) {
  return stateAt(compileHabit(habit), toDayNum(key), toDayNum(today));
}

/** States that read as "logged" in the UI (bonus counts as checked, but is neutral for stats). */
export const isLogged = (state) => state === 'done' || state === 'bonus';

/* ==========================================================================
   Streaks & rates
   ========================================================================== */

/** Consecutive completed scheduled days, walking back from today (pending today is skipped). Frozen once archived. */
export function currentStreak(habit, today) {
  const c = compileHabit(habit);
  const t = toDayNum(today);
  let streak = 0;
  for (let n = lastDay(c, t); n >= c.start; n--) {
    if (!scheduledAt(c, n)) continue;
    if (c.log[fromDayNum(n)]) streak++;
    else if (n !== t) break;
  }
  return streak;
}

/** Longest run of completed scheduled days in the habit's whole history (up to today). */
export function bestStreak(habit, today) {
  const c = compileHabit(habit);
  const t = toDayNum(today);
  let best = 0;
  let run = 0;
  for (let n = runStart(c), last = lastDay(c, t); n <= last; n++) {
    if (!scheduledAt(c, n)) continue;
    if (c.log[fromDayNum(n)]) {
      run++;
      if (run > best) best = run;
    } else if (n !== t) {
      run = 0;
    }
  }
  return best;
}

/**
 * Completion over the last `window` days: done scheduled days / scheduled days in
 * [max(createdAt, today - window + 1), min(today, archivedAt - 1)]; today is only
 * counted once done. -> { done, total, rate } with rate null when nothing to measure.
 */
export function completionRate(habit, today, window = RATE_WINDOW) {
  const c = compileHabit(habit);
  const t = toDayNum(today);
  let done = 0;
  let total = 0;
  for (let n = Math.max(c.start, t - window + 1), last = lastDay(c, t); n <= last; n++) {
    if (!scheduledAt(c, n)) continue;
    const ok = !!c.log[fromDayNum(n)];
    if (n === t && !ok) continue;
    total++;
    if (ok) done++;
  }
  return { done, total, rate: total ? done / total : null };
}

/** Aggregate completion rate across habits (sum of done / sum of scheduled). Archived habits count up to their archive date. */
export function overallRate(items, today, window = RATE_WINDOW) {
  let done = 0;
  let total = 0;
  for (const habit of items) {
    const r = completionRate(habit, today, window);
    done += r.done;
    total += r.total;
  }
  return { done, total, rate: total ? done / total : null };
}

/**
 * Consecutive days (back from today) on which every habit scheduled that day was
 * completed. Days with nothing scheduled are skipped; a partial today is pending.
 */
export function perfectDayStreak(items, today) {
  if (!items.length) return 0;
  const cs = items.map(compileHabit);
  const t = toDayNum(today);
  const first = Math.min(...cs.map((c) => c.start));
  let streak = 0;
  for (let n = t; n >= first; n--) {
    const key = fromDayNum(n);
    let any = false;
    let all = true;
    for (const c of cs) {
      if (!scheduledAt(c, n)) continue;
      any = true;
      if (!c.log[key]) {
        all = false;
        break;
      }
    }
    if (!any) continue;
    if (all) streak++;
    else if (n !== t) break;
  }
  return streak;
}

/** Highest current streak across non-archived habits -> { value, habit } (first habit wins ties). */
export function topStreak(items, today) {
  let value = 0;
  let habit = null;
  for (const it of items) {
    if (isArchived(it, today)) continue;
    const s = currentStreak(it, today);
    if (s > value) {
      value = s;
      habit = it;
    }
  }
  return { value, habit };
}

/**
 * Today's protocol count: scheduled habits, how many are done, plus bonus logs on
 * rest days. total = habits not archived as of today.
 */
export function todaySummary(items, today) {
  let total = 0;
  let scheduled = 0;
  let done = 0;
  let bonus = 0;
  for (const habit of items) {
    if (!isArchived(habit, today)) total++;
    const s = dayStatus(habit, today, today);
    if (s === 'done') {
      scheduled++;
      done++;
    } else if (s === 'pending') {
      scheduled++;
    } else if (s === 'bonus') {
      bonus++;
    }
  }
  return {
    total,
    scheduled,
    done,
    remaining: scheduled - done,
    bonus,
    complete: scheduled > 0 && done === scheduled,
  };
}

/* ==========================================================================
   View models
   ========================================================================== */

function dayCell(c, n, t) {
  const key = fromDayNum(n);
  return { key, weekday: weekdayOf(n), date: Number(key.slice(8)), isToday: n === t, state: stateAt(c, n, t), scheduled: scheduledAt(c, n) };
}

/**
 * The `days` days ending today: [{ key, weekday, date, isToday, state, scheduled }] oldest first.
 * `scheduled` is also filled for future days (from the plan in effect).
 */
export function weekStrip(habit, today, days = 7) {
  const c = compileHabit(habit);
  const t = toDayNum(today);
  const out = [];
  for (let n = t - days + 1; n <= t; n++) out.push(dayCell(c, n, t));
  return out;
}

/** The calendar week containing today, Monday … Sunday, same cell shape as weekStrip. */
export function weekRow(habit, today) {
  const c = compileHabit(habit);
  const t = toDayNum(today);
  const start = toDayNum(weekStart(today));
  return Array.from({ length: 7 }, (_, i) => dayCell(c, start + i, t));
}

/** Heat level 0..4 for a cell; done days glow brighter as the chain grows. null = no fill. */
function levelFor(state, run) {
  if (state === 'done') return run >= 7 ? 4 : run >= 3 ? 3 : 2;
  if (state === 'bonus') return 1;
  if (state === 'miss' || state === 'pending') return 0;
  return null;
}

/**
 * Contribution grid: `weeks` columns (at least 1), the last one holding today. Columns
 * start on Sunday by default, or on any weekday with { weekStart } (1 = Monday).
 * -> { columns: [{ month: 'Oct' | null, cells: [{ key, weekday, state, level, isToday }] }],
 *      done, total }   (done/total = scheduled days in the window, today only once done)
 */
export function heatmap(habit, today, weeks = HEAT_WEEKS, options = {}) {
  const ws = Number(options?.weekStart ?? 0);
  const firstWeekday = isWeekday(ws) ? ws : 0;
  weeks = Number.isFinite(weeks) ? Math.max(1, Math.floor(weeks)) : HEAT_WEEKS;
  const c = compileHabit(habit);
  const t = toDayNum(today);
  const first = t - ((weekdayOf(t) - firstWeekday + 7) % 7) - 7 * (weeks - 1);

  // Running streak length on each completed day, carried in from before the window.
  const runs = new Map();
  let run = 0;
  for (let n = runStart(c), last = lastDay(c, t); n <= last; n++) {
    if (!scheduledAt(c, n)) continue;
    if (c.log[fromDayNum(n)]) {
      run++;
      if (n >= first) runs.set(n, run);
    } else if (n !== t) {
      run = 0;
    }
  }

  let done = 0;
  let total = 0;
  const columns = [];
  for (let w = 0; w < weeks; w++) {
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const n = first + w * 7 + i;
      const state = stateAt(c, n, t);
      if (state === 'done') {
        done++;
        total++;
      } else if (state === 'miss') {
        total++;
      }
      cells.push({ key: fromDayNum(n), weekday: weekdayOf(n), state, level: levelFor(state, runs.get(n) ?? 0), isToday: n === t });
    }
    columns.push({ month: null, cells });
  }

  // Month labels where a column's first day enters a new month; the first column is
  // labelled too unless a label right next to it would collide.
  const monthOf = (w) => Number(fromDayNum(first + w * 7).slice(5, 7)) - 1;
  for (let w = 1; w < weeks; w++) {
    if (monthOf(w) !== monthOf(w - 1)) columns[w].month = MONTHS_SHORT[monthOf(w)];
  }
  if (!columns[1]?.month && !columns[2]?.month) columns[0].month = MONTHS_SHORT[monthOf(0)];

  return { columns, done, total };
}
