// LIFE/OS — 07 // Training: log workouts (lifts as sets × reps × weight, runs as distance and
// time, time-only cardio, sprint times over a fixed distance) and watch every exercise improve.
//
// Two tabs: Log (workouts, newest first; click one to edit) and Progress (each exercise's graph
// on the metric that shows getting better: est. 1RM, pace, best time…, with personal bests and
// a history table). The workout dialog starts each exercise from last time, so the next session
// can go a little further. Store 'training' (shape in training.logic.js); it syncs, the view doesn't.

import { h, icon, registerIcon, pageHeader, emptyState, toast, openModal, confirmDialog, todayKey, formatDay, relativeDay, uid, onDayChange, isTyping, modalOpen, plural, clamp, skin } from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import {
  DEFAULT_STATE,
  KINDS,
  KIND_LABEL,
  KIND_SHORT,
  PRESETS,
  NAME_MAX,
  TITLE_MAX,
  RANGES,
  normalizeState,
  sortWorkouts,
  parseNumber,
  parseDuration,
  parseSeconds,
  parseKm,
  formatDuration,
  formatKm,
  formatPace,
  formatMeters,
  metricsFor,
  defaultMetric,
  history,
  series,
  rangeStart,
  progressSummary,
  recordsIn,
  entrySummary,
  nextTarget,
  weekStats,
  hasData,
  addExercise,
  niceTicks,
} from './training.logic.js';
import { cleanTitle } from './tasks.logic.js';

registerIcon('tr-trophy', '<path d="M8 4h8v4.5a4 4 0 0 1-8 0Z"/><path d="M8 6H5.5v1.5A3 3 0 0 0 8.5 10.5M16 6h2.5v1.5a3 3 0 0 1-3 3M12 12.5V16M8.5 20h7M10 16h4v4h-4Z"/>');

const RANGE_LABEL = { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1Y', all: 'All' };
const LOG_PAGE = 20;

/* ==========================================================================
   Store
   ========================================================================== */

const store = createStore('training', DEFAULT_STATE);
let cacheRaw = null;
let cacheState = null;

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheState = normalizeState(raw, todayKey());
  }
  return cacheState;
}

function commit(next) {
  cacheRaw = next;
  cacheState = next;
  store.set(next);
}

function setView(patch) {
  const s = getState();
  if (Object.keys(patch).every((k) => s.view[k] === patch[k])) return;
  commit({ ...s, view: { ...s.view, ...patch } });
}

// Upgrade older / hand-edited data once, so every reader sees the same shape
if (JSON.stringify(store.get()) !== JSON.stringify(getState())) commit(getState());

const exerciseOf = (id) => getState().exercises.find((x) => x.id === id) ?? null;

/** The latest logged entry of an exercise, outside workout `exceptId`: { date, entry } | null */
function lastEntry(exerciseId, exceptId = null) {
  const all = history(getState().workouts, exerciseId).filter((x) => x.workout.id !== exceptId);
  return all.length ? all[all.length - 1] : null;
}

function deleteWorkout(id) {
  const s = getState();
  const at = s.workouts.findIndex((w) => w.id === id);
  if (at === -1) return;
  const removed = s.workouts[at];
  commit({ ...s, workouts: s.workouts.filter((w) => w.id !== id) });
  toast(`Workout of ${formatDay(removed.date)} deleted.`, {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: () => {
        const cur = getState();
        if (!cur.workouts.some((w) => w.id === id)) commit({ ...cur, workouts: sortWorkouts([...cur.workouts, removed]) });
      },
    },
  });
}

/** The same exercises again, today, as a new workout (Duplicate in the right-click menu). */
function repeatWorkout(id) {
  const s = getState();
  const w = s.workouts.find((x) => x.id === id);
  if (!w) return;
  const now = Date.now();
  const copy = { ...structuredClone(w), id: uid(), date: todayKey(), createdAt: now, updatedAt: now, entries: w.entries.map((e) => ({ ...structuredClone(e), id: uid() })) };
  commit({ ...s, workouts: sortWorkouts([...s.workouts, copy]) });
  toast(`Copied to today${w.title ? `: ${w.title}` : ''}.`, {
    duration: 6000,
    action: { label: 'Undo', onClick: () => commit({ ...getState(), workouts: getState().workouts.filter((x) => x.id !== copy.id) }) },
  });
}

/* ==========================================================================
   Small builders
   ========================================================================== */

const btn = (label, onClick, { iconName, primary = false, ghost = false, small = true, title, aria } = {}) =>
  h(
    'button',
    { type: 'button', class: ['btn', small && 'btn--sm', primary && 'btn--primary', ghost && 'btn--ghost', !label && 'btn--icon'], title: title ?? null, 'aria-label': aria ?? null, onClick },
    iconName ? icon(iconName, { size: 14 }) : null,
    label || null,
  );

function seg(label, options, value, onChange, className) {
  return h(
    'div',
    { class: ['seg', className], role: 'group', 'aria-label': label },
    options.map((o) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(o.value === value), onClick: () => onChange(o.value) }, o.label)),
  );
}

const dayLabel = (key) => {
  const rel = relativeDay(key, todayKey());
  return rel === formatDay(key) ? formatDay(key, 'long') : `${rel} · ${formatDay(key)}`;
};

/** Short y-axis numbers: units live in the chart's title. */
function axisLabel(metricId, v) {
  if (metricId === 'pace' || metricId === 'duration') return formatDuration(v);
  if (metricId === 'best') return String(Number(v.toFixed(2)));
  return String(Number(v.toFixed(2)));
}

const metricTitle = (m) => ({ e1rm: 'Estimated 1-rep max (kg)', weight: 'Top weight (kg)', volume: 'Volume: reps × kg', reps: 'Most reps in a set', totalReps: 'Total reps', pace: 'Pace (min per km)', distance: 'Distance (km)', duration: 'Time', best: 'Best time' })[m.id] ?? m.label;

/* ==========================================================================
   Chart: one series, time on x; "better" is always up (lower-is-better metrics flip the axis)
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const dayNumber = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

function chart({ points, metric, records, describe }) {
  // Drawn at the plot's real width (redrawn when it changes), so labels stay at their true size
  const H = 240;
  const pad = { l: 52, r: 16, t: 16, b: 28 };
  const values = points.map((p) => p.value);
  const scale = niceTicks(Math.min(...values), Math.max(...values), 4);
  const lowerBetter = metric.better === 'lower';
  const d0 = dayNumber(points[0].date);
  const span = Math.max(1, dayNumber(points[points.length - 1].date) - d0);
  let W = 0;
  let xAt = () => 0;
  let yAt = () => 0;
  let cross = null;
  let dots = [];

  const svg = sv('svg', { class: 'tr-svg', role: 'img', 'aria-label': `${metricTitle(metric)} over time` });
  const tip = h('div', { class: 'tr-tip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const el = h('div', { class: 'tr-plot', tabindex: '0', role: 'group', 'aria-label': `${metricTitle(metric)}. Left and right arrow keys read each session.` }, svg, tip, live);
  let active = null;

  function draw(width) {
    W = Math.max(260, Math.round(width));
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    yAt = (v) => {
      const f = (v - scale.min) / (scale.max - scale.min || 1);
      return pad.t + (lowerBetter ? f : 1 - f) * ph;
    };
    xAt = (p) => (points.length === 1 ? pad.l + pw / 2 : pad.l + ((dayNumber(p.date) - d0) / span) * pw);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.replaceChildren();
    const grid = sv('g', { class: 'tr-grid' });
    for (const t of scale.ticks) {
      const y = yAt(t);
      grid.append(sv('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }), sv('text', { class: 'tr-axis', x: pad.l - 8, y: y + 4, 'text-anchor': 'end' }, axisLabel(metric.id, t)));
    }
    svg.append(grid);
    // First and last day on x, and the middle one when there is room
    const xs = points.length > 2 ? [points[0], points[points.length - 1], points[Math.floor(points.length / 2)]] : points;
    const used = [];
    for (const p of xs) {
      const x = xAt(p);
      if (used.some((u) => Math.abs(u - x) < 90)) continue;
      used.push(x);
      const anchor = points.length === 1 ? 'middle' : x < pad.l + 40 ? 'start' : x > W - pad.r - 40 ? 'end' : 'middle';
      svg.append(sv('text', { class: 'tr-axis', x, y: H - 8, 'text-anchor': anchor }, formatDay(p.date)));
    }
    if (points.length > 1) svg.append(sv('path', { class: 'tr-line', d: points.map((p, i) => `${i ? 'L' : 'M'}${xAt(p).toFixed(1)} ${yAt(p.value).toFixed(1)}`).join(' ') }));
    cross = sv('line', { class: 'tr-cross', x1: 0, x2: 0, y1: pad.t, y2: pad.t + ph, visibility: 'hidden' });
    svg.append(cross);
    dots = points.map((p) => {
      const isRecord = records.has(p.date);
      const dot = sv('circle', { class: ['tr-dot', isRecord && 'is-record'].filter(Boolean).join(' '), cx: xAt(p), cy: yAt(p.value), r: isRecord ? 5.5 : 4 });
      svg.append(dot);
      return dot;
    });
    if (active != null) show(active);
  }

  const show = (i) => {
    active = clamp(i, 0, points.length - 1);
    const p = points[active];
    const x = xAt(p);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    dots.forEach((d, j) => d.classList.toggle('is-active', j === active));
    const lines = describe(p);
    tip.replaceChildren(...lines.map((t, j) => h('div', { class: j ? 'tr-tip-sub' : 'tr-tip-main' }, t)));
    tip.classList.add('is-on');
    const left = x + 14 + tip.offsetWidth > el.clientWidth ? x - 14 - tip.offsetWidth : x + 14;
    tip.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${pad.t}px)`;
    live.textContent = lines.join('. ');
  };
  const hide = () => {
    active = null;
    cross?.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.classList.remove('is-active'));
    tip.classList.remove('is-on');
  };
  el.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(xAt(p) - x) < Math.abs(xAt(points[best]) - x)) best = i;
    });
    if (best !== active) show(best);
  });
  el.addEventListener('pointerleave', hide);
  el.addEventListener('blur', hide);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(active == null ? points.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : points.length - 1);
    } else if (e.key === 'Escape' && active != null) {
      e.stopPropagation();
      hide();
    }
  });

  draw(560);
  const ro = new ResizeObserver(([entry]) => {
    if (!el.isConnected) return ro.disconnect();
    const width = entry.contentRect.width;
    if (width && Math.abs(Math.max(260, Math.round(width)) - W) > 1) draw(width);
  });
  ro.observe(el);
  return el;
}

/* ==========================================================================
   The workout dialog
   ========================================================================== */

let editorOpen = null;

/** Log a workout (no `existing`) or edit one. */
function openEditor(existing = null) {
  if (editorOpen) return;
  const start = getState();
  const isNew = !existing;
  const draft = existing ? structuredClone(existing) : { id: uid(), date: todayKey(), title: '', note: '', entries: [], createdAt: Date.now(), updatedAt: Date.now() };
  // Exercises made in this dialog are saved with the workout (and dropped on Cancel)
  let exercises = [...start.exercises];
  const editors = [];

  const dateIn = h('input', { class: 'input tr-date', type: 'date', value: draft.date, max: '9999-12-31', 'aria-label': 'Date' });
  const titleIn = h('input', { class: 'input', type: 'text', value: draft.title, maxlength: String(TITLE_MAX), placeholder: 'Name it (optional): Push day, Long run…', 'aria-label': 'Workout name', autocomplete: 'off' });
  const entriesEl = h('div', { class: 'tr-entries' });
  const noteIn = h('textarea', { class: 'textarea tr-note', rows: '2', placeholder: 'Notes (optional): how it felt, the weather…', 'aria-label': 'Notes' });
  noteIn.value = draft.note;
  const err = h('p', { class: 'tr-err', role: 'alert' });

  /* ---- adding an exercise ---- */
  const picker = h('select', { class: 'select tr-picker', 'aria-label': 'Add an exercise' });
  function paintPicker() {
    const used = new Set(editors.map((ed) => ed.exercise.id));
    const groups = KINDS.map((kind) => {
      const list = exercises.filter((x) => x.kind === kind && !used.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
      return list.length ? h('optgroup', { label: KIND_SHORT[kind] }, list.map((x) => h('option', { value: x.id }, x.name))) : null;
    });
    picker.replaceChildren(h('option', { value: '' }, 'Add an exercise…'), ...groups.filter(Boolean), h('option', { value: '__new' }, '＋ New exercise…'));
    picker.value = '';
  }
  picker.addEventListener('change', () => {
    const v = picker.value;
    picker.value = '';
    if (v === '__new') showNewForm();
    else if (v) addEditor(exercises.find((x) => x.id === v), null, { focus: true });
  });

  // New exercise: presets, or a name + what to log
  let newKind = 'strength';
  const newName = h('input', { class: 'input', type: 'text', maxlength: String(NAME_MAX), placeholder: 'Exercise name', 'aria-label': 'New exercise name', autocomplete: 'off' });
  const newDist = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: '100', 'aria-label': 'Distance in meters' });
  const distField = h('label', { class: 'tr-inline', hidden: true }, 'Distance', newDist, 'm');
  const kindSeg = h('div', { class: 'seg tr-kind-seg', role: 'group', 'aria-label': 'What you log' });
  const paintKinds = () =>
    kindSeg.replaceChildren(
      ...KINDS.map((k) =>
        h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(k === newKind), title: KIND_LABEL[k], onClick: () => ((newKind = k), paintKinds(), (distField.hidden = k !== 'sprint')) }, KIND_SHORT[k]),
      ),
    );
  paintKinds();
  const presetsEl = h('div', { class: 'tr-presets' });
  const newForm = h(
    'div',
    { class: 'tr-newex', hidden: true },
    h('div', { class: 'label' }, 'Quick add'),
    presetsEl,
    h('div', { class: 'label' }, 'Or make your own'),
    h('div', { class: 'tr-newex-row' }, newName, kindSeg, distField, btn('Add', () => createExercise({ name: newName.value, kind: newKind, distanceM: parseNumber(newDist.value) }), { iconName: 'plus' }), btn('', hideNewForm, { iconName: 'x', ghost: true, aria: 'Close' })),
  );
  newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createExercise({ name: newName.value, kind: newKind, distanceM: parseNumber(newDist.value) });
    }
  });
  function showNewForm() {
    const names = new Set(exercises.map((x) => x.name.toLowerCase()));
    presetsEl.replaceChildren(
      ...PRESETS.filter((p) => !names.has(p.name.toLowerCase())).map((p) => btn(p.name, () => createExercise(p), { iconName: 'plus', ghost: true, title: KIND_LABEL[p.kind] })),
    );
    presetsEl.hidden = !presetsEl.childElementCount;
    newForm.hidden = false;
    newName.focus();
  }
  function hideNewForm() {
    newForm.hidden = true;
    newName.value = '';
    picker.focus();
  }
  function createExercise(spec) {
    const res = addExercise(exercises, { ...spec, distanceM: Number.isFinite(spec.distanceM) && spec.distanceM > 0 ? spec.distanceM : 100 });
    if (res.error) {
      err.textContent = res.error === 'taken' ? `There is already an exercise called “${cleanTitle(spec.name)}”: pick it in the list.` : 'Give the exercise a name.';
      return;
    }
    err.textContent = '';
    exercises = res.exercises;
    newForm.hidden = true;
    newName.value = '';
    addEditor(res.exercise, null, { focus: true });
  }

  /* ---- one exercise in the workout ---- */
  function addEditor(exercise, entry, { focus = false } = {}) {
    if (!exercise) return;
    const last = lastEntry(exercise.id, draft.id);
    const fresh = !entry;
    // A new strength entry starts from last time's sets: change what you beat
    const e = entry ?? { id: uid(), exerciseId: exercise.id, sets: exercise.kind === 'strength' && last ? structuredClone(last.entry.sets) : [], distanceKm: null, durationSec: null, times: [] };
    const body = h('div', { class: 'tr-entry-body' });
    const ed = { exercise, entry: e, read: null };
    const lastText = last ? `Last time (${formatDay(last.date)}): ${entrySummary(last.entry, exercise)}. ${nextTarget(last.entry, exercise)}` : 'First time: whatever you log becomes the baseline.';
    const el = h(
      'section',
      { class: 'tr-entry', 'aria-label': exercise.name },
      h(
        'div',
        { class: 'tr-entry-head' },
        h('div', { class: 'tr-entry-name' }, exercise.name, h('span', { class: 'tr-kind label' }, exercise.kind === 'sprint' ? formatMeters(exercise.distanceM) : KIND_SHORT[exercise.kind])),
        btn('', () => {
          editors.splice(editors.indexOf(ed), 1);
          el.remove();
          paintPicker();
          picker.focus();
        }, { iconName: 'x', ghost: true, aria: `Remove ${exercise.name}`, title: 'Remove from this workout' }),
      ),
      h('p', { class: 'tr-last' }, lastText),
      body,
    );
    ed.el = el;

    if (exercise.kind === 'strength') {
      const rows = h('div', { class: 'tr-sets' });
      const rowEls = [];
      const addSet = (s = {}, focusIt = false) => {
        const reps = h('input', { class: 'input tr-num', type: 'text', inputmode: 'numeric', value: s.reps ?? '', placeholder: 'reps', 'aria-label': 'Reps', autocomplete: 'off' });
        const kg = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: s.weight ? String(s.weight) : '', placeholder: 'kg', 'aria-label': 'Weight in kg (empty for body weight)', autocomplete: 'off' });
        const row = h('div', { class: 'tr-set' }, h('span', { class: 'tr-set-n label' }), reps, h('span', { class: 'tr-x', 'aria-hidden': 'true' }, '×'), kg, h('span', { class: 'tr-unit' }, 'kg'));
        const item = { row, reps, kg };
        row.append(
          btn('', () => {
            rowEls.splice(rowEls.indexOf(item), 1);
            row.remove();
            number();
          }, { iconName: 'x', ghost: true, aria: 'Remove set' }),
        );
        rowEls.push(item);
        rows.append(row);
        number();
        if (focusIt) reps.focus();
      };
      const number = () => rowEls.forEach((r, i) => (r.row.querySelector('.tr-set-n').textContent = `Set ${i + 1}`));
      (e.sets.length ? e.sets : [{}]).forEach((s) => addSet(s));
      body.append(
        rows,
        btn('Add set', () => {
          const lastRow = rowEls[rowEls.length - 1];
          addSet({ reps: lastRow?.reps.value ?? '', weight: parseNumber(lastRow?.kg.value) || 0 }, true);
        }, { iconName: 'plus', ghost: true }),
      );
      ed.read = () => {
        const sets = [];
        for (const r of rowEls) {
          const reps = parseNumber(r.reps.value);
          const kg = parseNumber(r.kg.value);
          if (reps == null && kg == null) continue;
          if (reps == null || Number.isNaN(reps) || !Number.isInteger(reps)) return { error: 'Reps are whole numbers, like 8.', field: r.reps };
          if (Number.isNaN(kg)) return { error: 'Weight is a number of kg, like 82.5 (leave it empty for body weight).', field: r.kg };
          sets.push({ reps, weight: kg ?? 0 });
        }
        return { entry: { ...e, sets } };
      };
    } else if (exercise.kind === 'distance' || exercise.kind === 'duration') {
      const lastE = last?.entry;
      const km = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: e.distanceKm ?? '', placeholder: lastE?.distanceKm ? String(lastE.distanceKm) : '5', 'aria-label': 'Distance in km', autocomplete: 'off' });
      const time = h('input', { class: 'input tr-time', type: 'text', value: e.durationSec ? formatDuration(e.durationSec) : '', placeholder: lastE?.durationSec ? formatDuration(lastE.durationSec) : exercise.kind === 'distance' ? '27:30' : '30:00', 'aria-label': 'Time (m:ss or h:mm:ss; a plain number is minutes)', autocomplete: 'off' });
      const pace = h('span', { class: 'tr-pace label' });
      const paintPace = () => {
        const k = parseKm(km.value);
        const t = parseDuration(time.value);
        pace.textContent = k > 0 && t > 0 ? `Pace ${formatPace(t / k)}` : '';
      };
      km.addEventListener('input', paintPace);
      time.addEventListener('input', paintPace);
      paintPace();
      if (exercise.kind === 'distance') body.append(h('div', { class: 'tr-fields' }, h('label', { class: 'tr-inline' }, km, 'km'), h('label', { class: 'tr-inline' }, 'in', time), pace));
      else body.append(h('div', { class: 'tr-fields' }, h('label', { class: 'tr-inline' }, 'Time', time)));
      ed.read = () => {
        const k = exercise.kind === 'distance' ? parseKm(km.value) : null;
        const t = parseDuration(time.value);
        if (Number.isNaN(k)) return { error: 'Distance is a number of km, like 5.2 (or 800 m).', field: km };
        if (Number.isNaN(t)) return { error: 'Time looks like 27:30 or 1:05:00 (a plain number is minutes).', field: time };
        return { entry: { ...e, distanceKm: k, durationSec: t } };
      };
    } else {
      const list = h('div', { class: 'tr-times' });
      const inputs = [];
      const addTime = (sec, focusIt = false) => {
        const input = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: sec ? String(sec) : '', placeholder: last ? String(Math.min(...last.entry.times)) : '12.9', 'aria-label': `Attempt ${inputs.length + 1} in seconds`, autocomplete: 'off' });
        inputs.push(input);
        list.append(h('label', { class: 'tr-inline' }, input, 's'));
        if (focusIt) input.focus();
      };
      (e.times.length ? e.times : [null]).forEach((t) => addTime(t));
      body.append(list, btn('Add attempt', () => addTime(null, true), { iconName: 'plus', ghost: true }));
      ed.read = () => {
        const times = [];
        for (const input of inputs) {
          const t = parseSeconds(input.value);
          if (t == null) continue;
          if (Number.isNaN(t)) return { error: 'A time looks like 12.9 (seconds) or 1:02.5.', field: input };
          times.push(t);
        }
        return { entry: { ...e, times } };
      };
    }

    editors.push(ed);
    entriesEl.append(el);
    paintPicker();
    if (focus) (el.querySelector('input') ?? picker).focus();
    if (fresh && exercise.kind === 'strength' && last) el.querySelector('.tr-set .tr-num')?.select?.();
  }

  for (const entry of draft.entries) {
    const ex = exercises.find((x) => x.id === entry.exerciseId);
    if (ex) addEditor(ex, entry);
  }
  paintPicker();

  /* ---- save ---- */
  function save() {
    err.textContent = '';
    const date = dateIn.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      err.textContent = 'Pick the date of the workout.';
      dateIn.focus();
      return;
    }
    const entries = [];
    for (const ed of editors) {
      const res = ed.read();
      if (res.error) {
        err.textContent = `${ed.exercise.name}: ${res.error}`;
        res.field?.focus();
        return;
      }
      if (hasData(res.entry, ed.exercise)) entries.push(res.entry);
    }
    if (!entries.length) {
      err.textContent = editors.length ? 'Log at least one set, distance, time or attempt.' : 'Add an exercise first.';
      (editors.length ? entriesEl.querySelector('input') : picker)?.focus();
      return;
    }
    const cur = getState();
    if (!isNew && !cur.workouts.some((w) => w.id === draft.id)) {
      m.close();
      toast('That workout was deleted meanwhile.');
      return;
    }
    // Keep only the new exercises this workout uses; ones made here and removed again go
    const known = new Set(cur.exercises.map((x) => x.id));
    const usedIds = new Set(entries.map((e) => e.exerciseId));
    const added = exercises.filter((x) => !known.has(x.id) && usedIds.has(x.id));
    const now = Date.now();
    const workout = { ...draft, date, title: cleanTitle(titleIn.value).slice(0, TITLE_MAX), note: noteIn.value.replace(/\s+$/, ''), entries, updatedAt: now };
    const next = { ...cur, exercises: [...cur.exercises, ...added], workouts: sortWorkouts([...cur.workouts.filter((w) => w.id !== draft.id), workout]) };
    commit(next);
    m.close();
    const records = recordsIn(next, workout.id);
    if (records.length) {
      const words = records.slice(0, 2).map((r) => {
        const ex = next.exercises.find((x) => x.id === r.exerciseId);
        const metric = metricsFor(ex.kind).find((x) => x.id === r.metricId);
        return `${ex.name} ${metric.label.toLowerCase()} ${metric.format(r.value)}`;
      });
      toast(`New personal best: ${words.join(' · ')}${records.length > 2 ? ` and ${records.length - 2} more` : ''}!`, { duration: 8000 });
    } else toast(isNew ? `Workout logged: ${plural(entries.length, 'exercise')}.` : 'Workout saved.');
  }

  const body = [
    h('div', { class: 'tr-ed-top' }, h('label', { class: 'tr-inline' }, 'Date', dateIn), titleIn),
    entriesEl,
    h('div', { class: 'tr-add' }, picker),
    newForm,
    noteIn,
    err,
  ];
  const footer = [
    isNew
      ? null
      : h('button', { type: 'button', class: 'btn btn--danger tr-ed-delete', onClick: () => (m.close(), deleteWorkout(draft.id)) }, icon('trash', { size: 14 }), 'Delete'),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, isNew ? 'Log workout' : 'Save'),
  ];
  const m = openModal({
    title: isNew ? 'Log a workout' : 'Edit workout',
    body,
    footer,
    size: 'lg',
    className: 'tr-modal',
    initialFocus: editors.length ? undefined : picker,
    onClose: () => (editorOpen = null),
  });
  editorOpen = m;
  m.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });
}

/* ==========================================================================
   The page
   ========================================================================== */

function mount(root) {
  root.classList.add('tr-root');
  const simple = skin() === 'simple';
  let shown = LOG_PAGE;
  const cleanups = [];

  const header = pageHeader({
    index: '07',
    title: 'Training',
    subtitle: 'Log every workout. Watch each lift, run and sprint get better.',
    actions: [btn('Log workout', () => openEditor(), { iconName: 'plus', primary: true, small: false })],
  });
  const weekEl = h('section', { class: 'tr-week', 'aria-label': 'This week' });
  const tabsEl = h('div', { class: 'tr-tabs' });
  const bodyEl = h('div', { class: 'tr-body' });
  root.append(header, weekEl, tabsEl, bodyEl);

  function render() {
    const s = getState();
    const focusId = document.activeElement?.closest?.('[data-tr-focus]')?.dataset.trFocus;
    paintWeek(s);
    tabsEl.replaceChildren(seg('View', [{ value: 'log', label: 'Log' }, { value: 'progress', label: 'Progress' }], s.view.tab, (tab) => setView({ tab }), 'tr-tab-seg'));
    bodyEl.replaceChildren(s.view.tab === 'progress' ? progressView(s) : logView(s));
    if (focusId) bodyEl.querySelector(`[data-tr-focus="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  }

  function paintWeek(s) {
    const w = weekStats(s, todayKey());
    if (simple) {
      const parts = [plural(w.workouts, 'workout')];
      if (w.volumeKg) parts.push(`${Math.round(w.volumeKg).toLocaleString('en')} kg lifted`);
      if (w.km) parts.push(`${formatKm(w.km)} covered`);
      weekEl.replaceChildren(h('p', { class: 'tr-week-line' }, `This week: ${parts.join(', ')}.`));
      return;
    }
    const cell = (label, value) => h('div', { class: 'tr-stat panel' }, h('span', { class: 'label' }, label), h('span', { class: 'stat-value tr-stat-value' }, value));
    weekEl.replaceChildren(
      cell('Workouts this week', String(w.workouts)),
      cell('Sets', String(w.sets)),
      cell('Lifted', w.volumeKg ? `${Math.round(w.volumeKg).toLocaleString('en')} kg` : '—'),
      cell('Distance', w.km ? formatKm(w.km) : '—'),
    );
  }

  /* ---- Log ---- */
  function logView(s) {
    if (!s.workouts.length) {
      return emptyState({
        icon: 'dumbbell',
        title: 'No workouts yet',
        text: 'Log lifts with sets, reps and weight, runs with distance and time, cardio, or sprint times. Every exercise gets its own progress graph.',
        action: btn('Log your first workout', () => openEditor(), { iconName: 'plus', primary: true, small: false }),
      });
    }
    const exById = new Map(s.exercises.map((x) => [x.id, x]));
    const list = h('div', { class: 'tr-log' });
    for (const w of s.workouts.slice(0, shown)) {
      const records = new Set(recordsIn(s, w.id).map((r) => r.exerciseId));
      const card = h(
        'article',
        {
          class: 'tr-card panel',
          tabindex: '0',
          dataset: { id: w.id, trFocus: `w-${w.id}` },
          'aria-label': `${w.title || 'Workout'}, ${formatDay(w.date, 'long')}`,
          onClick: (e) => {
            if (!e.target.closest('button, a')) openEditor(w);
          },
          onKeydown: (e) => {
            if (e.target !== card || isTyping(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              openEditor(w);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              deleteWorkout(w.id);
            }
          },
        },
        h(
          'header',
          { class: 'tr-card-head' },
          h('div', { class: 'tr-card-when' }, h('span', { class: 'label' }, dayLabel(w.date)), w.title ? h('h3', { class: 'tr-card-title' }, w.title) : null),
          records.size ? h('span', { class: 'tag tag--solid tr-pr', title: 'Personal best in this workout' }, icon('tr-trophy', { size: 12 }), records.size > 1 ? `${records.size} PRs` : 'PR') : null,
          h('div', { class: 'row-actions tr-card-actions' }, btn('', () => openEditor(w), { iconName: 'edit', ghost: true, aria: 'Edit workout', title: 'Edit' }), btn('', () => deleteWorkout(w.id), { iconName: 'trash', ghost: true, aria: 'Delete workout', title: 'Delete' })),
        ),
        h(
          'ul',
          { class: 'tr-card-entries' },
          w.entries.map((e) => {
            const ex = exById.get(e.exerciseId);
            return h('li', null, h('span', { class: 'tr-card-ex' }, ex?.name ?? 'Unknown exercise', records.has(e.exerciseId) ? h('span', { class: 'tr-pr-dot', title: 'Personal best' }, icon('tr-trophy', { size: 11 })) : null), h('span', { class: 'tr-card-sum' }, entrySummary(e, ex)));
          }),
        ),
        w.note ? h('p', { class: 'tr-card-note' }, w.note.split('\n')[0]) : null,
      );
      list.append(card);
    }
    if (s.workouts.length > shown) {
      list.append(btn(`Show ${Math.min(LOG_PAGE, s.workouts.length - shown)} more`, () => ((shown += LOG_PAGE), render()), { ghost: true }));
    }
    return list;
  }

  /* ---- Progress ---- */
  function progressView(s) {
    const trained = s.exercises
      .map((x) => ({ x, h: history(s.workouts, x.id) }))
      .filter((r) => r.h.length)
      .sort((a, b) => (a.h[a.h.length - 1].date < b.h[b.h.length - 1].date ? 1 : -1));
    if (!trained.length) {
      return emptyState({ icon: 'activity', title: 'No progress to show yet', text: 'Log a workout and each exercise in it gets a graph here.', action: btn('Log workout', () => openEditor(), { iconName: 'plus', primary: true }) });
    }
    const selected = trained.find((r) => r.x.id === s.view.exerciseId) ?? trained[0];
    const today = todayKey();

    const list = h(
      'nav',
      { class: 'tr-exlist', 'aria-label': 'Exercises' },
      trained.map(({ x, h: hist }) => {
        const metricId = defaultMetric(x, hist.map((r) => r.entry));
        const metric = metricsFor(x.kind).find((m) => m.id === metricId);
        const pts = series(s.workouts, x, metricId);
        const sum = progressSummary(pts, metric.better);
        const trend = sum?.improved === true ? '▲' : sum?.improved === false ? '▼' : '';
        return h(
          'button',
          { type: 'button', class: 'tr-ex', 'aria-pressed': String(x.id === selected.x.id), dataset: { trFocus: `x-${x.id}` }, onClick: () => setView({ exerciseId: x.id, metric: null }) },
          h('span', { class: 'tr-ex-name' }, x.name),
          h('span', { class: 'tr-ex-meta label' }, `${plural(hist.length, 'session')}`),
          h('span', { class: 'tr-ex-value' }, sum ? metric.format(sum.last.value) : '', trend ? h('span', { class: 'tr-trend', title: sum.improved ? 'Better than the first session' : 'Below the first session' }, ` ${trend}`) : null),
        );
      }),
    );

    const x = selected.x;
    const entries = selected.h.map((r) => r.entry);
    const metrics = metricsFor(x.kind).filter((m) => entries.some((e) => m.of(e) != null));
    const metric = metrics.find((m) => m.id === s.view.metric) ?? metrics.find((m) => m.id === defaultMetric(x, entries)) ?? metrics[0];
    if (!metric) return h('div', { class: 'tr-progress' }, list, h('p', { class: 'tr-nodata' }, `Nothing to chart for ${x.name} yet.`));
    const from = rangeStart(s.view.range, today);
    const pts = series(s.workouts, x, metric.id, { from });
    const all = series(s.workouts, x, metric.id);
    const sum = progressSummary(pts, metric.better);
    const allBest = progressSummary(all, metric.better)?.best;
    // Days that set a new best at the time (the running record)
    const records = new Set();
    let run = null;
    for (const p of all) {
      if (run != null && (metric.better === 'lower' ? p.value < run : p.value > run)) records.add(p.date);
      if (run == null || (metric.better === 'lower' ? p.value < run : p.value > run)) run = p.value;
    }

    const changeText = (() => {
      if (!sum || pts.length < 2) return 'Log it again to see the change.';
      const d = sum.change;
      const abs = Math.abs(d);
      const shownAbs = ['pace', 'duration'].includes(metric.id) ? formatDuration(abs) : metric.id === 'best' ? `${Number(abs.toFixed(2))} s` : metric.format(abs);
      const pct = sum.changePct != null ? ` (${d >= 0 ? '+' : '−'}${Math.abs(sum.changePct).toFixed(1)}%)` : '';
      const way = metric.better === 'lower' ? (d < 0 ? 'faster' : d > 0 ? 'slower' : '') : '';
      return d === 0 ? 'No change yet' : `${d > 0 ? '+' : '−'}${shownAbs}${pct}${way ? `, ${way}` : ''} since ${formatDay(sum.first.date)}`;
    })();

    const stat = (label, value, sub) => h('div', { class: 'tr-kpi' }, h('span', { class: 'label' }, label), h('span', { class: 'tr-kpi-value' }, value), sub ? h('span', { class: 'tr-kpi-sub' }, sub) : null);
    const byDate = new Map(selected.h.map((r) => [r.date, r]));
    const describe = (p) => {
      const r = byDate.get(p.date);
      const lines = [`${formatDay(p.date, 'long')}: ${metric.format(p.value)}${records.has(p.date) ? ' · personal best' : ''}`];
      if (r) lines.push(entrySummary(r.entry, x));
      return lines;
    };

    const rows = [...selected.h].reverse().slice(0, 30);
    const detail = h(
      'section',
      { class: 'tr-detail panel hud', 'aria-label': `${x.name} progress` },
      h(
        'header',
        { class: 'tr-detail-head' },
        h('div', null, h('h2', { class: 'tr-detail-title' }, x.name), h('p', { class: 'tr-detail-kind label' }, x.kind === 'sprint' ? `${formatMeters(x.distanceM)} · lower time is better` : KIND_LABEL[x.kind])),
        h('div', { class: 'tr-detail-actions' }, btn('', () => renameExercise(x), { iconName: 'edit', ghost: true, aria: `Rename ${x.name}`, title: 'Rename' }), btn('', () => removeExercise(x), { iconName: 'trash', ghost: true, aria: `Delete ${x.name}`, title: 'Delete exercise' })),
      ),
      h(
        'div',
        { class: 'tr-controls' },
        metrics.length > 1 ? seg('Measure', metrics.map((m) => ({ value: m.id, label: m.label })), metric.id, (id) => setView({ metric: id }), 'tr-metric-seg') : h('span', { class: 'label' }, metric.label),
        seg('Time range', RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] })), s.view.range, (range) => setView({ range }), 'tr-range-seg'),
      ),
      h(
        'div',
        { class: 'tr-kpis' },
        stat('Latest', sum ? metric.format(sum.last.value) : '—', sum ? formatDay(sum.last.date) : 'none in this range'),
        stat('Best ever', allBest ? metric.format(allBest.value) : '—', allBest ? formatDay(allBest.date) : ''),
        stat('Change', sum && pts.length > 1 ? (sum.improved ? 'Improving' : sum.improved === false ? 'Below start' : 'Steady') : '—', changeText),
      ),
      pts.length
        ? h('figure', { class: 'tr-figure' }, h('figcaption', { class: 'tr-caption label' }, metricTitle(metric), metric.better === 'lower' ? ' · higher on the graph is faster' : ''), chart({ points: pts, metric, records, describe }))
        : h('p', { class: 'tr-nodata' }, `Nothing logged in the last ${RANGE_LABEL[s.view.range]}. Pick a longer range.`),
      h(
        'table',
        { class: 'tr-table' },
        h('caption', { class: 'sr-only' }, `${x.name}: every session`),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, metric.label), h('th', { scope: 'col' }, 'Logged'))),
        h(
          'tbody',
          null,
          rows.map((r) => {
            const v = metric.of(r.entry);
            return h(
              'tr',
              null,
              h('td', null, formatDay(r.date)),
              h('td', { class: 'tr-td-num' }, v != null ? metric.format(v) : '—', records.has(r.date) && all.find((p) => p.date === r.date)?.value === v ? h('span', { class: 'tr-pr-dot', title: 'Personal best' }, ' ', icon('tr-trophy', { size: 11 })) : null),
              h('td', { class: 'tr-td-sum' }, entrySummary(r.entry, x)),
            );
          }),
        ),
      ),
      selected.h.length > rows.length ? h('p', { class: 'tr-more label' }, `Showing the latest ${rows.length} of ${selected.h.length} sessions.`) : null,
    );

    return h('div', { class: 'tr-progress' }, list, detail);
  }

  function renameExercise(x) {
    const input = h('input', { class: 'input', type: 'text', value: x.name, maxlength: String(NAME_MAX), 'aria-label': 'Exercise name', autocomplete: 'off' });
    const msg = h('p', { class: 'tr-err', role: 'alert' });
    const save = () => {
      const name = cleanTitle(input.value).slice(0, NAME_MAX).trim();
      const s = getState();
      if (!name) return void (msg.textContent = 'Give it a name.');
      if (s.exercises.some((o) => o.id !== x.id && o.name.toLowerCase() === name.toLowerCase())) return void (msg.textContent = `There is already an exercise called “${name}”.`);
      commit({ ...s, exercises: s.exercises.map((o) => (o.id === x.id ? { ...o, name } : o)) });
      m.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    const m = openModal({
      title: 'Rename exercise',
      body: [input, msg],
      footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, 'Save')],
      initialFocus: input,
    });
  }

  async function removeExercise(x) {
    const s = getState();
    const sessions = history(s.workouts, x.id).length;
    const emptied = s.workouts.filter((w) => w.entries.length && w.entries.every((e) => e.exerciseId === x.id)).length;
    const ok = await confirmDialog({
      title: `Delete “${x.name}”?`,
      message: `This deletes its ${plural(sessions, 'logged session')} and its graph${emptied ? `, and ${plural(emptied, 'workout')} with nothing else in it` : ''}. It can’t be undone (a backup in Settings keeps a copy).`,
      confirmLabel: 'Delete exercise',
    });
    if (!ok) return;
    const cur = getState();
    const workouts = cur.workouts.map((w) => ({ ...w, entries: w.entries.filter((e) => e.exerciseId !== x.id) })).filter((w) => w.entries.length);
    commit({ ...cur, exercises: cur.exercises.filter((o) => o.id !== x.id), workouts, view: { ...cur.view, exerciseId: null, metric: null } });
    toast(`“${x.name}” deleted.`);
  }

  // N: log a workout (like N for a new task)
  const onKey = (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
    e.preventDefault();
    openEditor();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  // Right-click a workout: Delete, or Duplicate = the same workout again today
  cleanups.push(
    registerContextProvider('training', (el) => {
      if (!root.contains(el)) return null;
      const card = el.closest('.tr-card[data-id]');
      const w = card ? getState().workouts.find((x) => x.id === card.dataset.id) : null;
      if (!w) return null;
      return { kind: 'workout', id: w.id, label: `Workout: ${w.title || formatDay(w.date)}`, el: card, remove: () => deleteWorkout(w.id), duplicate: () => repeatWorkout(w.id), can: { copy: false, paste: false } };
    }),
  );

  render();
  cleanups.push(store.subscribe(render));
  cleanups.push(onDayChange(render));
  return () => cleanups.forEach((off) => off());
}

/** This week's workouts, on the nav (empty when none). */
function badge() {
  const n = weekStats(getState(), todayKey()).workouts;
  return n ? String(n) : '';
}

export default {
  id: 'training',
  title: 'Training',
  icon: 'dumbbell',
  badge,
  mount,
};
