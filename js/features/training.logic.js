// LIFE/OS — 07 // Training: pure logic (DOM-free, unit-tested with jsc in tools/tests/training.test.js).
//
// Store shape ('training'):
//   { exercises: [{ id, name, kind, distanceM?, createdAt }],
//     workouts:  [{ id, date: 'YYYY-MM-DD', title, note, entries: [Entry], createdAt, updatedAt }],
//     view: { tab: 'log' | 'progress', exerciseId, metric, range } }      // per device (never syncs)
//   Entry = { id, exerciseId, sets: [{ reps, weight }], distanceKm, durationSec, times: [seconds] }
//   An entry uses the fields of its exercise's kind; the rest stay empty:
//     strength  sets (weight in kg; 0 = body weight)
//     distance  distanceKm + durationSec (running, cycling, swimming …)
//     duration  durationSec (cardio, plank …)
//     sprint    times (attempts at the exercise's fixed distanceM: 100 m in 12.9 s)
// Fields this version doesn't know are kept, so an older window never strips a newer one's data.

import { isDateKey, cleanTitle } from './tasks.logic.js';
import { uid } from '../ui.js';

export const KINDS = Object.freeze(['strength', 'distance', 'duration', 'sprint']);
export const KIND_LABEL = Object.freeze({ strength: 'Sets × reps × weight', distance: 'Distance and time', duration: 'Time', sprint: 'Timed distance' });
export const KIND_SHORT = Object.freeze({ strength: 'Strength', distance: 'Distance', duration: 'Time', sprint: 'Sprint' });

/** One click to the usual exercises, by kind. */
export const PRESETS = Object.freeze([
  { name: 'Bench press', kind: 'strength' },
  { name: 'Squat', kind: 'strength' },
  { name: 'Deadlift', kind: 'strength' },
  { name: 'Overhead press', kind: 'strength' },
  { name: 'Barbell row', kind: 'strength' },
  { name: 'Pull-ups', kind: 'strength' },
  { name: 'Push-ups', kind: 'strength' },
  { name: 'Running', kind: 'distance' },
  { name: 'Cycling', kind: 'distance' },
  { name: 'Swimming', kind: 'distance' },
  { name: 'Rowing', kind: 'distance' },
  { name: 'Cardio', kind: 'duration' },
  { name: 'Plank', kind: 'duration' },
  { name: '100 m sprint', kind: 'sprint', distanceM: 100 },
  { name: '200 m sprint', kind: 'sprint', distanceM: 200 },
  { name: '400 m', kind: 'sprint', distanceM: 400 },
]);

export const NAME_MAX = 40;
export const TITLE_MAX = 60;
export const RANGES = Object.freeze(['1M', '3M', '6M', '1Y', 'all']);
export const TABS = Object.freeze(['log', 'progress']);
export const DEFAULT_VIEW = Object.freeze({ tab: 'log', exerciseId: null, metric: null, range: '3M' });
export const DEFAULT_STATE = Object.freeze({ exercises: Object.freeze([]), workouts: Object.freeze([]), view: DEFAULT_VIEW });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toId = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && v ? v : null);
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const round = (v, step) => Math.round(v / step) * step;

/* ==========================================================================
   Normalization
   ========================================================================== */

export function normalizeExercise(raw) {
  if (!isObject(raw)) return null;
  const id = toId(raw.id);
  const name = cleanTitle(raw.name).slice(0, NAME_MAX).trim();
  if (!id || !name) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'strength';
  const out = { ...raw, id, name, kind, createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0 };
  if (kind === 'sprint') out.distanceM = num(raw.distanceM, 1, 100000) ?? 100;
  return out;
}

function normalizeSet(raw) {
  if (!isObject(raw)) return null;
  const reps = num(raw.reps, 0, 10000);
  if (reps == null) return null;
  return { ...raw, reps: Math.round(reps), weight: num(raw.weight, 0, 5000) ?? 0 };
}

export function normalizeEntry(raw) {
  if (!isObject(raw)) return null;
  const exerciseId = toId(raw.exerciseId);
  if (!exerciseId) return null;
  return {
    ...raw,
    id: toId(raw.id) ?? uid(),
    exerciseId,
    sets: (Array.isArray(raw.sets) ? raw.sets : []).map(normalizeSet).filter(Boolean),
    distanceKm: num(raw.distanceKm, 0, 100000),
    durationSec: num(raw.durationSec, 0, 10 * 86400),
    times: (Array.isArray(raw.times) ? raw.times : []).filter((t) => num(t, 0.001, 86400) != null),
  };
}

export function normalizeWorkout(raw, today) {
  if (!isObject(raw)) return null;
  const id = toId(raw.id);
  if (!id) return null;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  return {
    ...raw,
    id,
    date: isDateKey(raw.date) ? raw.date : today,
    title: cleanTitle(raw.title).slice(0, TITLE_MAX),
    note: typeof raw.note === 'string' ? raw.note : '',
    entries: (Array.isArray(raw.entries) ? raw.entries : []).map(normalizeEntry).filter(Boolean),
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

export function normalizeView(raw, exerciseIds = new Set()) {
  const v = isObject(raw) ? raw : {};
  return {
    tab: TABS.includes(v.tab) ? v.tab : DEFAULT_VIEW.tab,
    exerciseId: typeof v.exerciseId === 'string' && exerciseIds.has(v.exerciseId) ? v.exerciseId : null,
    metric: typeof v.metric === 'string' ? v.metric : null,
    range: RANGES.includes(v.range) ? v.range : DEFAULT_VIEW.range,
  };
}

/** A fresh, valid state: unique ids; workouts newest first. */
export function normalizeState(raw, today) {
  const src = isObject(raw) ? raw : {};
  const exercises = [];
  const exIds = new Set();
  for (const r of Array.isArray(src.exercises) ? src.exercises : []) {
    const ex = normalizeExercise(r);
    if (!ex || exIds.has(ex.id)) continue;
    exIds.add(ex.id);
    exercises.push(ex);
  }
  const workouts = [];
  const wIds = new Set();
  for (const r of Array.isArray(src.workouts) ? src.workouts : []) {
    const w = normalizeWorkout(r, today);
    if (!w || wIds.has(w.id)) continue;
    wIds.add(w.id);
    workouts.push(w);
  }
  return { exercises, workouts: sortWorkouts(workouts), view: normalizeView(src.view, exIds) };
}

/** Newest first: by date, then by when it was logged. */
export function sortWorkouts(workouts) {
  return [...workouts].sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
}

/* ==========================================================================
   Typing numbers and times (a comma works as the decimal mark: 82,5)
   ========================================================================== */

/** '82,5' -> 82.5; '' -> null (empty); anything else unreadable -> NaN */
export function parseNumber(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return NaN;
  return Number(t);
}

/**
 * A duration in seconds: '27:30' (m:ss), '1:05:00' (h:mm:ss), '45' (minutes), '1h 30m', '90 min',
 * '40s', '1,5h'. '' -> null; unreadable -> NaN.
 */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/,/g, '.');
  if (!t) return null;
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) {
    const parts = t.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const unit = /^(\d*\.?\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)?$/;
  const words = t.split(/\s+(?=\d)/);
  let total = 0;
  for (const w of words) {
    const m = unit.exec(w.trim());
    if (!m) return NaN;
    const v = Number(m[1]);
    const u = m[2] ?? (words.length === 1 ? 'm' : '');
    if (!u) return NaN;
    total += u.startsWith('h') ? v * 3600 : u.startsWith('s') ? v : v * 60;
  }
  return total;
}

/** A sprint time in seconds: '12.9', '12,9', '1:02.5', '58s'. '' -> null; unreadable -> NaN. */
export function parseSeconds(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(',', '.').replace(/\s*(s|sec|secs|seconds)$/, '');
  if (!t) return null;
  if (/^\d+:\d{1,2}(\.\d+)?$/.test(t)) {
    const [m, s] = t.split(':').map(Number);
    return s >= 60 ? NaN : m * 60 + s;
  }
  const n = parseNumber(t);
  return n === 0 ? NaN : n;
}

/** A distance in km: '5.2', '5,2 km', '800 m'. '' -> null; unreadable -> NaN. */
export function parseKm(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  const m = /^(\d*\.?\d+)\s*(km|k|m)?$/.exec(t);
  if (!m) return NaN;
  return m[2] === 'm' ? Number(m[1]) / 1000 : Number(m[1]);
}

/* ==========================================================================
   Formatting
   ========================================================================== */

const trim = (n, digits) => String(Number(n.toFixed(digits)));

/** 1650 -> '27:30', 3725 -> '1:02:05' */
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

export const formatKg = (kg) => `${trim(kg, 2)} kg`;
export const formatKm = (km) => `${trim(km, 2)} km`;
export const formatPace = (secPerKm) => `${formatDuration(secPerKm)} /km`;
/** 12.9 -> '12.9 s', 62.5 -> '1:02.5' */
export function formatSprint(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 60) return `${trim(sec, 2)} s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${trim(s, 2)}`;
}
export const formatMeters = (m) => (m >= 1000 && m % 100 === 0 ? `${trim(m / 1000, 1)} km` : `${trim(m, 1)} m`);

/* ==========================================================================
   Measures: what a session's entry is worth on a metric
   ========================================================================== */

/** Estimated one-rep max (Epley), rounded to 0.5 kg. One rep is the weight itself. */
export function e1rm(weight, reps) {
  if (!(weight > 0) || !(reps > 0)) return 0;
  return reps === 1 ? weight : round(weight * (1 + reps / 30), 0.5);
}

const setsWithReps = (e) => e.sets.filter((s) => s.reps > 0);
const loaded = (e) => setsWithReps(e).filter((s) => s.weight > 0);

/**
 * The metrics an exercise kind offers: [{ id, label, unit, better: 'higher' | 'lower', format, of(entry) }].
 * of() returns null when the entry has nothing for that metric.
 */
export function metricsFor(kind) {
  switch (kind) {
    case 'strength':
      return [
        { id: 'e1rm', label: 'Est. 1RM', better: 'higher', format: formatKg, of: (e) => (loaded(e).length ? Math.max(...loaded(e).map((s) => e1rm(s.weight, s.reps))) : null) },
        { id: 'weight', label: 'Top weight', better: 'higher', format: formatKg, of: (e) => (loaded(e).length ? Math.max(...loaded(e).map((s) => s.weight)) : null) },
        { id: 'volume', label: 'Volume', better: 'higher', format: formatKg, of: (e) => (loaded(e).length ? loaded(e).reduce((acc, s) => acc + s.reps * s.weight, 0) : null) },
        { id: 'reps', label: 'Best set', better: 'higher', format: (n) => `${n} reps`, of: (e) => (setsWithReps(e).length ? Math.max(...setsWithReps(e).map((s) => s.reps)) : null) },
        { id: 'totalReps', label: 'Total reps', better: 'higher', format: (n) => `${n} reps`, of: (e) => (setsWithReps(e).length ? setsWithReps(e).reduce((acc, s) => acc + s.reps, 0) : null) },
      ];
    case 'distance':
      return [
        { id: 'pace', label: 'Pace', better: 'lower', format: formatPace, of: (e) => (e.distanceKm > 0 && e.durationSec > 0 ? e.durationSec / e.distanceKm : null) },
        { id: 'distance', label: 'Distance', better: 'higher', format: formatKm, of: (e) => (e.distanceKm > 0 ? e.distanceKm : null) },
        { id: 'duration', label: 'Time', better: 'higher', format: formatDuration, of: (e) => (e.durationSec > 0 ? e.durationSec : null) },
      ];
    case 'duration':
      return [{ id: 'duration', label: 'Time', better: 'higher', format: formatDuration, of: (e) => (e.durationSec > 0 ? e.durationSec : null) }];
    case 'sprint':
      return [{ id: 'best', label: 'Best time', better: 'lower', format: formatSprint, of: (e) => (e.times.length ? Math.min(...e.times) : null) }];
    default:
      return [];
  }
}

/** The metric a chart starts on: est. 1RM once a lift has weight (reps for body weight), pace once a run has a time. */
export function defaultMetric(exercise, entries) {
  const metrics = metricsFor(exercise.kind);
  const has = (id) => entries.some((e) => metrics.find((m) => m.id === id)?.of(e) != null);
  if (exercise.kind === 'strength') return has('e1rm') ? 'e1rm' : 'reps';
  if (exercise.kind === 'distance') return has('pace') ? 'pace' : 'distance';
  return metrics[0]?.id ?? null;
}

const better = (metric, a, b) => (metric.better === 'lower' ? a < b : a > b);

/** Every entry of an exercise with its workout's date, oldest first: [{ date, workout, entry }]. */
export function history(workouts, exerciseId) {
  const out = [];
  for (const w of workouts) for (const e of w.entries) if (e.exerciseId === exerciseId) out.push({ date: w.date, workout: w, entry: e });
  return out.sort((a, b) => (a.date === b.date ? a.workout.createdAt - b.workout.createdAt : a.date < b.date ? -1 : 1));
}

/** The chart's points: one per day (the day's best), oldest first: [{ date, value, workoutId }]. */
export function series(workouts, exercise, metricId, { from = null } = {}) {
  const metric = metricsFor(exercise.kind).find((m) => m.id === metricId);
  if (!metric) return [];
  const byDay = new Map();
  for (const { date, workout, entry } of history(workouts, exercise.id)) {
    if (from && date < from) continue;
    const value = metric.of(entry);
    if (value == null) continue;
    const prev = byDay.get(date);
    if (!prev || better(metric, value, prev.value)) byDay.set(date, { date, value, workoutId: workout.id });
  }
  return [...byDay.values()];
}

/** First day of a range ending today ('3M' -> 3 months back), or null for all of it. */
export function rangeStart(range, today) {
  const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range];
  if (!months) return null;
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(y, m - 1 - months, d);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
}

/** Over a series: { first, last, best, change, changePct, improved } (change is last − first; improved follows `better`). */
export function progressSummary(points, betterWay = 'higher') {
  if (!points.length) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const best = points.reduce((b, p) => ((betterWay === 'lower' ? p.value < b.value : p.value > b.value) ? p : b), points[0]);
  const change = last.value - first.value;
  const changePct = first.value ? (change / first.value) * 100 : null;
  const improved = points.length > 1 && change !== 0 ? (betterWay === 'lower' ? change < 0 : change > 0) : null;
  return { first, last, best, change, changePct, improved };
}

/**
 * The personal bests a workout set: [{ exerciseId, metricId, value, previous }] for each entry whose
 * main metric beats every earlier day (a first-ever session isn't a record yet).
 */
export function recordsIn(state, workoutId) {
  const workout = state.workouts.find((w) => w.id === workoutId);
  if (!workout) return [];
  const out = [];
  const seen = new Set();
  for (const entry of workout.entries) {
    const exercise = state.exercises.find((x) => x.id === entry.exerciseId);
    if (!exercise || seen.has(exercise.id)) continue;
    seen.add(exercise.id);
    const all = history(state.workouts, exercise.id);
    const metricId = defaultMetric(exercise, all.map((h) => h.entry));
    const metric = metricsFor(exercise.kind).find((m) => m.id === metricId);
    if (!metric) continue;
    const mine = workout.entries.filter((e) => e.exerciseId === exercise.id).map(metric.of).filter((v) => v != null);
    if (!mine.length) continue;
    const value = mine.reduce((b, v) => (better(metric, v, b) ? v : b));
    // Earlier = an earlier day, or the same day logged before this workout
    const earlier = all
      .filter((h) => h.workout.id !== workout.id && (h.date < workout.date || (h.date === workout.date && h.workout.createdAt < workout.createdAt)))
      .map((h) => metric.of(h.entry))
      .filter((v) => v != null);
    if (!earlier.length) continue;
    const previous = earlier.reduce((b, v) => (better(metric, v, b) ? v : b));
    if (better(metric, value, previous)) out.push({ exerciseId: exercise.id, metricId, value, previous });
  }
  return out;
}

/* ==========================================================================
   Words for one entry, and the next target
   ========================================================================== */

/** 'Bench press' entry -> '3 × 8 @ 80 kg' · '8 @ 80, 6 @ 85 kg' · '3 × 12' (body weight) · '5.2 km in 27:30 · 5:17 /km' · '12.9 s (best of 3)' */
export function entrySummary(entry, exercise) {
  if (!exercise) return '';
  switch (exercise.kind) {
    case 'strength': {
      const sets = setsWithReps(entry);
      if (!sets.length) return 'No sets';
      const same = sets.every((s) => s.reps === sets[0].reps && s.weight === sets[0].weight);
      if (same) return sets[0].weight > 0 ? `${sets.length} × ${sets[0].reps} @ ${formatKg(sets[0].weight)}` : `${sets.length} × ${sets[0].reps}`;
      if (sets.every((s) => !(s.weight > 0))) return sets.map((s) => s.reps).join(', ') + ' reps';
      return `${sets.map((s) => (s.weight > 0 ? `${s.reps} @ ${trim(s.weight, 2)}` : `${s.reps}`)).join(', ')} kg`;
    }
    case 'distance': {
      const parts = [];
      if (entry.distanceKm > 0) parts.push(formatKm(entry.distanceKm));
      if (entry.durationSec > 0) parts.push(parts.length ? `in ${formatDuration(entry.durationSec)}` : formatDuration(entry.durationSec));
      const pace = entry.distanceKm > 0 && entry.durationSec > 0 ? ` · ${formatPace(entry.durationSec / entry.distanceKm)}` : '';
      return parts.length ? parts.join(' ') + pace : 'Nothing logged';
    }
    case 'duration':
      return entry.durationSec > 0 ? formatDuration(entry.durationSec) : 'Nothing logged';
    case 'sprint': {
      if (!entry.times.length) return 'No times';
      const best = Math.min(...entry.times);
      return entry.times.length > 1 ? `${formatSprint(best)} (best of ${entry.times.length})` : formatSprint(best);
    }
    default:
      return '';
  }
}

/** The nudge for next time (progressive overload), from the last entry. */
export function nextTarget(entry, exercise) {
  if (!entry || !exercise) return '';
  switch (exercise.kind) {
    case 'strength': {
      const sets = setsWithReps(entry);
      if (!sets.length) return '';
      const top = Math.max(...sets.map((s) => s.weight));
      if (top > 0) return `Next: try ${formatKg(top + 2.5)}, or one more rep per set.`;
      return `Next: try ${Math.max(...sets.map((s) => s.reps)) + 1} reps.`;
    }
    case 'distance':
      if (entry.distanceKm > 0 && entry.durationSec > 0) return `Next: beat ${formatPace(entry.durationSec / entry.distanceKm)}, or go a bit further.`;
      return entry.distanceKm > 0 ? `Next: try ${formatKm(round(entry.distanceKm * 1.1, 0.1))}.` : '';
    case 'duration':
      return entry.durationSec > 0 ? `Next: try ${formatDuration(entry.durationSec + 60)}.` : '';
    case 'sprint':
      return entry.times.length ? `Next: beat ${formatSprint(Math.min(...entry.times))}.` : '';
    default:
      return '';
  }
}

/* ==========================================================================
   Summaries
   ========================================================================== */

/** Monday of the week that holds `key` (weeks start on Monday). */
export function weekStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
}

/** This week (Mon–Sun) in numbers: { workouts, sets, volumeKg, km, seconds }. */
export function weekStats(state, today) {
  const from = weekStart(today);
  const kinds = new Map(state.exercises.map((x) => [x.id, x.kind]));
  const out = { workouts: 0, sets: 0, volumeKg: 0, km: 0, seconds: 0 };
  for (const w of state.workouts) {
    if (w.date < from || w.date > today) continue;
    out.workouts++;
    for (const e of w.entries) {
      const kind = kinds.get(e.exerciseId);
      if (kind === 'strength') {
        const sets = setsWithReps(e);
        out.sets += sets.length;
        out.volumeKg += sets.reduce((acc, s) => acc + s.reps * s.weight, 0);
      } else if (kind === 'distance' || kind === 'duration') {
        if (kind === 'distance' && e.distanceKm > 0) out.km += e.distanceKm;
        if (e.durationSec > 0) out.seconds += e.durationSec;
      }
    }
  }
  out.km = Math.round(out.km * 100) / 100;
  return out;
}

/** An entry worth saving: something logged in it. */
export function hasData(entry, exercise) {
  if (!exercise) return false;
  if (exercise.kind === 'strength') return setsWithReps(entry).length > 0;
  if (exercise.kind === 'distance') return entry.distanceKm > 0 || entry.durationSec > 0;
  if (exercise.kind === 'duration') return entry.durationSec > 0;
  return entry.times.length > 0;
}

/** New exercise from a name and kind -> { exercises, exercise } | { error: 'empty' | 'taken' } */
export function addExercise(exercises, { name, kind = 'strength', distanceM } = {}, id = uid(), now = Date.now()) {
  const clean = cleanTitle(name).slice(0, NAME_MAX).trim();
  if (!clean) return { error: 'empty' };
  if (exercises.some((x) => x.name.toLowerCase() === clean.toLowerCase())) return { error: 'taken' };
  const exercise = normalizeExercise({ id, name: clean, kind: KINDS.includes(kind) ? kind : 'strength', distanceM, createdAt: now });
  return { exercises: [...exercises, exercise], exercise };
}

/* ==========================================================================
   Chart scale
   ========================================================================== */

/** About `count` round tick values covering [min, max]: { min, max, step, ticks }. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { min: lo, max: hi, step, ticks };
}
