// LIFE/OS — 07 // Training: log workouts (lifts as sets × reps × weight, runs as distance and
// time, time-only cardio, sprint times over a fixed distance) and watch every exercise improve.
//
// Routines (Push day …) start a workout with their exercises and last time's numbers in gray, so
// only what changed is typed. Two tabs: Log (routines, then workouts newest first; click one to
// edit) and Progress (each exercise's graph
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
  normalizeRoutine,
  routineFromWorkout,
  lastDone,
  ghostSets,
  readSetRow,
} from './training.logic.js';
import { cleanTitle } from './tasks.logic.js';

registerIcon('tr-routine', '<path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-3.6-6 3.6v-16a1 1 0 0 1 1-1Z"/><path d="M9.5 8.5h5M9.5 11.5h3"/>');
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

const kindText = (x) => (x.kind === 'sprint' ? formatMeters(x.distanceM) : KIND_SHORT[x.kind]);

/**
 * "Add an exercise…": pick one, or make one (one-click presets, or a name + what to log). Shared
 * by the workout and routine dialogs. exercises() is the dialog's working list (a new exercise
 * stays in it until that dialog saves); used() the ids already in the dialog.
 */
function exercisePicker({ exercises, setExercises, used, onPick, say }) {
  const select = h('select', { class: 'select tr-picker', 'aria-label': 'Add an exercise' });
  let newKind = 'strength';
  const newName = h('input', { class: 'input', type: 'text', maxlength: String(NAME_MAX), placeholder: 'Exercise name', 'aria-label': 'New exercise name', autocomplete: 'off' });
  const newDist = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: '100', 'aria-label': 'Distance in meters' });
  const distField = h('label', { class: 'tr-inline', hidden: true }, 'Distance', newDist, 'm');
  const kindSeg = h('div', { class: 'seg tr-kind-seg', role: 'group', 'aria-label': 'What you log' });
  const paintKinds = () =>
    kindSeg.replaceChildren(
      ...KINDS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: 'seg-btn',
            'aria-pressed': String(k === newKind),
            title: KIND_LABEL[k],
            onClick: () => {
              newKind = k;
              distField.hidden = k !== 'sprint';
              paintKinds();
            },
          },
          KIND_SHORT[k],
        ),
      ),
    );
  paintKinds();
  const presetsEl = h('div', { class: 'tr-presets' });
  const create = (spec) => {
    const res = addExercise(exercises(), { ...spec, distanceM: Number.isFinite(spec.distanceM) && spec.distanceM > 0 ? spec.distanceM : 100 });
    if (res.error) {
      say(res.error === 'taken' ? `There is already an exercise called “${cleanTitle(spec.name)}”: pick it in the list.` : 'Give the exercise a name.');
      return;
    }
    say('');
    setExercises(res.exercises);
    newForm.hidden = true;
    newName.value = '';
    onPick(res.exercise);
    refresh();
  };
  const createTyped = () => create({ name: newName.value, kind: newKind, distanceM: parseNumber(newDist.value) });
  const newForm = h(
    'div',
    { class: 'tr-newex', hidden: true },
    h('div', { class: 'label' }, 'Quick add'),
    presetsEl,
    h('div', { class: 'label' }, 'Or make your own'),
    h('div', { class: 'tr-newex-row' }, newName, kindSeg, distField, btn('Add', createTyped, { iconName: 'plus' }), btn('', () => ((newForm.hidden = true), select.focus()), { iconName: 'x', ghost: true, aria: 'Close' })),
  );
  newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createTyped();
    }
  });

  function refresh() {
    const taken = used();
    const groups = KINDS.map((kind) => {
      const list = exercises()
        .filter((x) => x.kind === kind && !taken.has(x.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      return list.length ? h('optgroup', { label: KIND_SHORT[kind] }, list.map((x) => h('option', { value: x.id }, x.name))) : null;
    });
    select.replaceChildren(h('option', { value: '' }, 'Add an exercise…'), ...groups.filter(Boolean), h('option', { value: '__new' }, '＋ New exercise…'));
    select.value = '';
  }
  select.addEventListener('change', () => {
    const v = select.value;
    select.value = '';
    if (v === '__new') {
      const names = new Set(exercises().map((x) => x.name.toLowerCase()));
      presetsEl.replaceChildren(...PRESETS.filter((p) => !names.has(p.name.toLowerCase())).map((p) => btn(p.name, () => create(p), { iconName: 'plus', ghost: true, title: KIND_LABEL[p.kind] })));
      presetsEl.hidden = !presetsEl.childElementCount;
      newForm.hidden = false;
      newName.focus();
    } else if (v) {
      onPick(exercises().find((x) => x.id === v));
      refresh();
    }
  });
  refresh();
  return { el: h('div', { class: 'tr-add' }, select, newForm), refresh, focus: () => select.focus() };
}

/**
 * Log a workout (no `existing`), start one from a routine, or edit one. Each exercise shows last
 * time's numbers faintly where you type: type what changed, and once you type in an exercise its
 * empty fields count as last time (sprint times excepted: those are always typed).
 */
function openEditor(existing = null, { routine = null } = {}) {
  if (editorOpen) return;
  const start = getState();
  const isNew = !existing;
  const now0 = Date.now();
  const draft = existing ? structuredClone(existing) : { id: uid(), date: todayKey(), title: routine?.name ?? '', note: '', entries: [], createdAt: now0, updatedAt: now0, ...(routine ? { routineId: routine.id } : {}) };
  let exercises = [...start.exercises];
  const editors = [];

  const dateIn = h('input', { class: 'input tr-date', type: 'date', value: draft.date, max: '9999-12-31', 'aria-label': 'Date' });
  const titleIn = h('input', { class: 'input', type: 'text', value: draft.title, maxlength: String(TITLE_MAX), placeholder: 'Name it (optional): Push day, Long run…', 'aria-label': 'Workout name', autocomplete: 'off' });
  const entriesEl = h('div', { class: 'tr-entries' });
  const noteIn = h('textarea', { class: 'textarea tr-note', rows: '2', placeholder: 'Notes (optional): how it felt, the weather…', 'aria-label': 'Notes' });
  noteIn.value = draft.note;
  const err = h('p', { class: 'tr-err', role: 'alert' });
  const ghostHint = h('p', { class: 'tr-ghost-hint', hidden: true }, 'Gray numbers are last time’s. Type only what changed: once you type in an exercise, its empty fields count as last time. “Same as last time” fills them all in.');
  const syncHint = () => (ghostHint.hidden = !editors.some((ed) => ed.ghosted));

  const picker = exercisePicker({
    exercises: () => exercises,
    setExercises: (list) => (exercises = list),
    used: () => new Set(editors.map((ed) => ed.exercise.id)),
    onPick: (x) => addEditor(x, null, { focus: true }),
    say: (t) => (err.textContent = t),
  });

  // A new, empty workout can start from a routine
  const routinesRow =
    isNew && !routine && start.routines.length
      ? h('div', { class: 'tr-start-from' }, h('span', { class: 'label' }, 'Start from'), start.routines.map((r) => btn(r.name, () => applyRoutine(r), { iconName: 'tr-routine', ghost: true })))
      : null;
  function applyRoutine(r) {
    draft.routineId = r.id;
    if (!titleIn.value.trim()) titleIn.value = r.name;
    for (const it of r.items) {
      const x = exercises.find((e) => e.id === it.exerciseId);
      if (x && !editors.some((ed) => ed.exercise.id === x.id)) addEditor(x, null, { setCount: it.sets });
    }
    routinesRow?.remove();
    if (saveAsRoutine) saveAsRoutine.hidden = true;
    entriesEl.querySelector('input')?.focus();
  }
  const saveAsRoutine =
    isNew && !routine
      ? h('label', { class: 'tr-check' }, h('input', { type: 'checkbox', class: 'tr-check-box' }), 'Also save these exercises as a routine, named after the workout')
      : null;

  /* ---- one exercise in the workout ---- */
  function addEditor(exercise, entry, { focus = false, setCount = null } = {}) {
    if (!exercise) return;
    const last = lastEntry(exercise.id, draft.id);
    const fresh = !entry;
    const e = entry ?? { id: uid(), exerciseId: exercise.id, sets: [], distanceKm: null, durationSec: null, times: [] };
    const ed = { exercise, entry: e, fresh, touched: false, ghosted: false, read: null, repeat: null };
    const body = h('div', { class: 'tr-entry-body' });
    const touch = () => {
      if (ed.touched) return;
      ed.touched = true;
      el.classList.add('is-touched');
    };
    const repeatBtn =
      fresh && last && exercise.kind !== 'sprint'
        ? btn('Same as last time', () => {
            ed.repeat?.();
            touch();
          }, { iconName: 'reset', ghost: true, title: 'Fill in last time’s numbers' })
        : null;
    const lastText = last ? `Last time (${formatDay(last.date)}): ${entrySummary(last.entry, exercise)}. ${nextTarget(last.entry, exercise)}` : fresh ? 'First time: whatever you log becomes the baseline.' : '';
    const el = h(
      'section',
      { class: 'tr-entry', 'aria-label': exercise.name },
      h(
        'div',
        { class: 'tr-entry-head' },
        h('div', { class: 'tr-entry-name' }, exercise.name, h('span', { class: 'tr-kind label' }, kindText(exercise))),
        repeatBtn,
        btn('', () => {
          editors.splice(editors.indexOf(ed), 1);
          el.remove();
          picker.refresh();
          syncHint();
          picker.focus();
        }, { iconName: 'x', ghost: true, aria: `Remove ${exercise.name}`, title: 'Remove from this workout' }),
      ),
      lastText ? h('p', { class: 'tr-last' }, lastText) : null,
      body,
    );
    el.addEventListener('input', touch);

    if (exercise.kind === 'strength') {
      const lastSets = (last?.entry.sets ?? []).filter((s) => s.reps > 0);
      const count = e.sets.length || setCount || lastSets.length || 1;
      const ghosts = fresh ? ghostSets(lastSets, count) : [];
      ed.ghosted = ghosts.length > 0;
      const rows = h('div', { class: 'tr-sets' });
      const rowEls = [];
      const number = () => rowEls.forEach((r, i) => (r.n.textContent = `Set ${i + 1}`));
      const addSet = ({ value = null, ghost = null } = {}, focusIt = false) => {
        const reps = h('input', { class: 'input tr-num', type: 'text', inputmode: 'numeric', value: value?.reps ?? '', placeholder: ghost ? String(ghost.reps) : 'reps', 'aria-label': ghost ? `Reps (last time ${ghost.reps})` : 'Reps', autocomplete: 'off' });
        const kg = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: value?.weight ? String(value.weight) : '', placeholder: ghost?.weight > 0 ? String(ghost.weight) : 'kg', 'aria-label': ghost?.weight > 0 ? `Weight in kg (last time ${ghost.weight})` : 'Weight in kg (empty for body weight)', autocomplete: 'off' });
        const n = h('span', { class: 'tr-set-n label' });
        const row = h('div', { class: 'tr-set' }, n, reps, h('span', { class: 'tr-x', 'aria-hidden': 'true' }, '×'), kg, h('span', { class: 'tr-unit' }, 'kg'));
        const item = { row, reps, kg, n, ghost };
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
      if (e.sets.length) e.sets.forEach((s) => addSet({ value: s }));
      else Array.from({ length: count }, (_, i) => addSet({ ghost: ghosts[i] ?? null }));
      body.append(
        rows,
        btn('Add set', () => {
          // The new row's gray numbers: the row above, as typed or as last time had it
          const prev = rowEls[rowEls.length - 1];
          const reps = parseNumber(prev?.reps.value) || prev?.ghost?.reps || null;
          const kgTyped = parseNumber(prev?.kg.value);
          const weight = Number.isFinite(kgTyped) ? kgTyped : prev?.ghost?.weight ?? 0;
          addSet({ ghost: reps ? { reps, weight } : null }, true);
        }, { iconName: 'plus', ghost: true }),
      );
      ed.read = () => {
        const useGhost = ed.fresh && ed.touched;
        const sets = [];
        for (const r of rowEls) {
          const res = readSetRow(r.reps.value, r.kg.value, r.ghost, useGhost);
          if (res.skip) continue;
          if (res.error === 'reps') return { error: 'Reps are whole numbers, like 8.', field: r.reps };
          if (res.error) return { error: 'Weight is a number of kg, like 82.5 (leave it empty for body weight).', field: r.kg };
          sets.push(res.set);
        }
        return { entry: { ...e, sets } };
      };
      ed.repeat = () => {
        while (rowEls.length < lastSets.length) addSet({ ghost: lastSets[rowEls.length] });
        for (const r of rowEls) {
          if (!r.ghost) continue;
          if (!r.reps.value) r.reps.value = String(r.ghost.reps);
          if (!r.kg.value && r.ghost.weight > 0) r.kg.value = String(r.ghost.weight);
        }
      };
    } else if (exercise.kind === 'distance' || exercise.kind === 'duration') {
      const lastE = fresh ? last?.entry : null;
      const kmGhost = lastE?.distanceKm > 0 ? String(lastE.distanceKm) : '';
      const timeGhost = lastE?.durationSec > 0 ? formatDuration(lastE.durationSec) : '';
      ed.ghosted = !!(kmGhost || timeGhost);
      const km = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: e.distanceKm ?? '', placeholder: kmGhost || 'km', 'aria-label': kmGhost ? `Distance in km (last time ${kmGhost})` : 'Distance in km', autocomplete: 'off' });
      const time = h('input', { class: 'input tr-time', type: 'text', value: e.durationSec ? formatDuration(e.durationSec) : '', placeholder: timeGhost || 'm:ss', 'aria-label': `Time (m:ss or h:mm:ss; a plain number is minutes)${timeGhost ? `, last time ${timeGhost}` : ''}`, autocomplete: 'off' });
      const pace = h('span', { class: 'tr-pace label' });
      const value = (input, ghost) => input.value.trim() || (ed.fresh && ed.touched ? ghost : '');
      const paintPace = () => {
        const k = parseKm(value(km, kmGhost));
        const t = parseDuration(value(time, timeGhost));
        pace.textContent = k > 0 && t > 0 ? `Pace ${formatPace(t / k)}` : '';
      };
      el.addEventListener('input', paintPace);
      paintPace();
      if (exercise.kind === 'distance') body.append(h('div', { class: 'tr-fields' }, h('label', { class: 'tr-inline' }, km, 'km'), h('label', { class: 'tr-inline' }, 'in', time), pace));
      else body.append(h('div', { class: 'tr-fields' }, h('label', { class: 'tr-inline' }, 'Time', time)));
      ed.read = () => {
        const k = exercise.kind === 'distance' ? parseKm(value(km, kmGhost)) : null;
        const t = parseDuration(value(time, timeGhost));
        if (Number.isNaN(k)) return { error: 'Distance is a number of km, like 5.2 (or 800 m).', field: km };
        if (Number.isNaN(t)) return { error: 'Time looks like 27:30 or 1:05:00 (a plain number is minutes).', field: time };
        return { entry: { ...e, distanceKm: k, durationSec: t } };
      };
      ed.repeat = () => {
        if (!km.value && kmGhost && exercise.kind === 'distance') km.value = kmGhost;
        if (!time.value && timeGhost) time.value = timeGhost;
        paintPace();
      };
    } else {
      // Sprint times are results: always typed (last time's best is in the line above)
      const list = h('div', { class: 'tr-times' });
      const inputs = [];
      const addTime = (sec, focusIt = false) => {
        const input = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: sec ? String(sec) : '', placeholder: 'sec', 'aria-label': `Attempt ${inputs.length + 1} in seconds`, autocomplete: 'off' });
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
    picker.refresh();
    syncHint();
    if (focus) (el.querySelector('input') ?? picker).focus();
  }

  for (const entry of draft.entries) {
    const x = exercises.find((e) => e.id === entry.exerciseId);
    if (x) addEditor(x, entry);
  }
  if (routine) for (const it of routine.items) addEditor(exercises.find((x) => x.id === it.exerciseId), null, { setCount: it.sets });

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
      err.textContent = editors.length ? 'Type at least one number, or press “Same as last time”.' : 'Add an exercise first.';
      (editors.length ? entriesEl.querySelector('input') : picker)?.focus();
      return;
    }
    const cur = getState();
    if (!isNew && !cur.workouts.some((w) => w.id === draft.id)) {
      m.close();
      toast('That workout was deleted meanwhile.');
      return;
    }
    const title = cleanTitle(titleIn.value).slice(0, TITLE_MAX);
    const wantRoutine = !!saveAsRoutine?.querySelector('input').checked && !saveAsRoutine.hidden;
    if (wantRoutine && !title) {
      err.textContent = 'Name the workout (like Push day) to save it as a routine.';
      titleIn.focus();
      return;
    }
    if (wantRoutine && cur.routines.some((r) => r.name.toLowerCase() === title.toLowerCase())) {
      err.textContent = `There is already a routine called “${title}”. Pick another name, or untick the box.`;
      titleIn.focus();
      return;
    }
    // Keep only the new exercises this workout uses; ones made here and removed again go
    const known = new Set(cur.exercises.map((x) => x.id));
    const usedIds = new Set(entries.map((e) => e.exerciseId));
    const allExercises = [...cur.exercises, ...exercises.filter((x) => !known.has(x.id) && usedIds.has(x.id))];
    const now = Date.now();
    const workout = { ...draft, date, title, note: noteIn.value.replace(/\s+$/, ''), entries, updatedAt: now };
    const newRoutine = wantRoutine ? routineFromWorkout(workout, allExercises, title) : null;
    if (newRoutine) workout.routineId = newRoutine.id;
    const next = {
      ...cur,
      exercises: allExercises,
      workouts: sortWorkouts([...cur.workouts.filter((w) => w.id !== draft.id), workout]),
      routines: newRoutine ? [...cur.routines, newRoutine] : cur.routines,
    };
    commit(next);
    m.close();
    const records = recordsIn(next, workout.id);
    const saved = newRoutine ? ` Saved as routine “${newRoutine.name}”.` : '';
    if (records.length) {
      const words = records.slice(0, 2).map((r) => {
        const ex = next.exercises.find((x) => x.id === r.exerciseId);
        const metric = metricsFor(ex.kind).find((x) => x.id === r.metricId);
        return `${ex.name}: ${metric.label} ${metric.format(r.value)}`;
      });
      toast(`New personal best: ${words.join(' · ')}${records.length > 2 ? ` and ${records.length - 2} more` : ''}!${saved}`, { duration: 8000 });
    } else toast(`${isNew ? `Workout logged: ${plural(entries.length, 'exercise')}.` : 'Workout saved.'}${saved}`);
  }

  const body = [
    h('div', { class: 'tr-ed-top' }, h('label', { class: 'tr-inline' }, 'Date', dateIn), titleIn),
    routinesRow,
    ghostHint,
    entriesEl,
    picker.el,
    noteIn,
    saveAsRoutine,
    err,
  ];
  const footer = [
    isNew
      ? null
      : h(
          'button',
          {
            type: 'button',
            class: 'btn btn--danger tr-ed-delete',
            onClick: () => {
              m.close();
              deleteWorkout(draft.id);
            },
          },
          icon('trash', { size: 14 }),
          'Delete',
        ),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, isNew ? 'Log workout' : 'Save'),
  ];
  const m = openModal({
    title: routine ? routine.name : isNew ? 'Log a workout' : 'Edit workout',
    body,
    footer,
    size: 'lg',
    className: 'tr-modal',
    initialFocus: editors.length ? entriesEl.querySelector('input') : picker.el.querySelector('select'),
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
   Routines: make, edit, delete
   ========================================================================== */

function deleteRoutine(id) {
  const s = getState();
  const r = s.routines.find((x) => x.id === id);
  if (!r) return;
  commit({ ...s, routines: s.routines.filter((x) => x.id !== id) });
  toast(`Routine “${r.name}” deleted. Its logged workouts stay.`, {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: () => {
        const cur = getState();
        if (!cur.routines.some((x) => x.id === id)) commit({ ...cur, routines: [...cur.routines, r] });
      },
    },
  });
}

/** A routine from a logged workout, named after it (a unique name). */
function saveWorkoutAsRoutine(id) {
  const s = getState();
  const w = s.workouts.find((x) => x.id === id);
  if (!w) return;
  const base = w.title || `Workout ${formatDay(w.date)}`;
  const taken = new Set(s.routines.map((r) => r.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  const routine = routineFromWorkout(w, s.exercises, name);
  if (!routine.items.length) return;
  commit({ ...s, routines: [...s.routines, routine], workouts: s.workouts.map((x) => (x.id === id && !x.routineId ? { ...x, routineId: routine.id } : x)) });
  toast(`Saved as routine “${routine.name}”.`, { duration: 6000, action: { label: 'Edit', onClick: () => openRoutineEditor(getState().routines.find((r) => r.id === routine.id)) } });
}

function openRoutineEditor(routine = null) {
  if (editorOpen) return;
  const start = getState();
  let exercises = [...start.exercises];
  const items = routine ? routine.items.map((it) => ({ ...it })) : [];
  const nameIn = h('input', { class: 'input', type: 'text', value: routine?.name ?? '', maxlength: String(NAME_MAX), placeholder: 'Push day, Legs, Long run…', 'aria-label': 'Routine name', autocomplete: 'off' });
  const listEl = h('ol', { class: 'tr-rlist' });
  const err = h('p', { class: 'tr-err', role: 'alert' });

  function move(i, by) {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    paint();
    listEl.children[j]?.querySelectorAll('button')[by < 0 ? 0 : 1]?.focus();
  }
  function paint() {
    listEl.replaceChildren(
      ...items.map((it, i) => {
        const x = exercises.find((e) => e.id === it.exerciseId);
        if (!x) return null;
        const setsIn =
          x.kind === 'strength'
            ? h('input', {
                class: 'input tr-num',
                type: 'number',
                min: '1',
                max: '20',
                value: String(it.sets),
                'aria-label': `Sets of ${x.name}`,
                onChange: (e) => {
                  const n = Math.round(Number(e.target.value));
                  it.sets = clamp(Number.isFinite(n) && n > 0 ? n : 3, 1, 20);
                  e.target.value = String(it.sets);
                },
              })
            : null;
        const up = btn('', () => move(i, -1), { iconName: 'arrow-up', ghost: true, aria: `Move ${x.name} up` });
        const down = btn('', () => move(i, 1), { iconName: 'arrow-down', ghost: true, aria: `Move ${x.name} down` });
        up.disabled = i === 0;
        down.disabled = i === items.length - 1;
        return h(
          'li',
          { class: 'tr-ritem' },
          h('span', { class: 'tr-ritem-name' }, x.name, h('span', { class: 'tr-kind label' }, kindText(x))),
          setsIn ? h('label', { class: 'tr-inline' }, setsIn, 'sets') : h('span'),
          up,
          down,
          btn('', () => {
            items.splice(i, 1);
            paint();
            picker.refresh();
          }, { iconName: 'x', ghost: true, aria: `Remove ${x.name}` }),
        );
      }),
    );
    listEl.hidden = !items.length;
  }
  const picker = exercisePicker({
    exercises: () => exercises,
    setExercises: (list) => (exercises = list),
    used: () => new Set(items.map((it) => it.exerciseId)),
    onPick: (x) => {
      items.push({ exerciseId: x.id, sets: 3 });
      paint();
    },
    say: (t) => (err.textContent = t),
  });
  paint();

  function save() {
    err.textContent = '';
    const name = cleanTitle(nameIn.value).slice(0, NAME_MAX).trim();
    const cur = getState();
    if (!name) {
      err.textContent = 'Give the routine a name, like Push day.';
      nameIn.focus();
      return;
    }
    if (cur.routines.some((r) => r.id !== routine?.id && r.name.toLowerCase() === name.toLowerCase())) {
      err.textContent = `There is already a routine called “${name}”.`;
      nameIn.focus();
      return;
    }
    if (!items.length) {
      err.textContent = 'Add the exercises this routine has.';
      picker.focus();
      return;
    }
    const known = new Set(cur.exercises.map((x) => x.id));
    const usedIds = new Set(items.map((it) => it.exerciseId));
    const now = Date.now();
    const next = normalizeRoutine({ ...(routine ?? { id: uid(), createdAt: now }), name, items, updatedAt: now });
    commit({
      ...cur,
      exercises: [...cur.exercises, ...exercises.filter((x) => !known.has(x.id) && usedIds.has(x.id))],
      routines: routine && cur.routines.some((r) => r.id === routine.id) ? cur.routines.map((r) => (r.id === routine.id ? next : r)) : [...cur.routines, next],
    });
    m.close();
    toast(routine ? `Routine “${name}” saved.` : `Routine “${name}” is ready: press Start to log it.`);
  }

  const m = openModal({
    title: routine ? 'Edit routine' : 'New routine',
    className: 'tr-modal',
    body: [
      nameIn,
      h('p', { class: 'tr-last' }, 'The exercises you do together, in order. Starting the routine opens them with last time’s numbers ready.'),
      listEl,
      picker.el,
      err,
    ],
    footer: [
      routine
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn--danger',
              onClick: () => {
                m.close();
                deleteRoutine(routine.id);
              },
            },
            icon('trash', { size: 14 }),
            'Delete',
          )
        : null,
      h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, 'Save routine'),
    ],
    initialFocus: nameIn,
    onClose: () => (editorOpen = null),
  });
  editorOpen = m;
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) save();
      else picker.focus();
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

  /* ---- Routines (Push day …): start one, edit one, make one ---- */
  function routinesView(s) {
    const exById = new Map(s.exercises.map((x) => [x.id, x]));
    const today = todayKey();
    const when = (key) => {
      const rel = relativeDay(key, today);
      return /^(Today|Yesterday)$/.test(rel) ? rel.toLowerCase() : /ago$/.test(rel) ? rel : `on ${rel}`;
    };
    const cards = s.routines.map((r) => {
      const done = lastDone(s.workouts, r.id);
      const names = r.items.map((it) => exById.get(it.exerciseId)?.name).filter(Boolean);
      return h(
        'article',
        { class: 'tr-routine panel', 'aria-label': `Routine ${r.name}` },
        h(
          'div',
          { class: 'tr-routine-head' },
          h('h3', { class: 'tr-routine-name' }, icon('tr-routine', { size: 14 }), r.name),
          btn('', () => openRoutineEditor(r), { iconName: 'edit', ghost: true, aria: `Edit routine ${r.name}`, title: 'Edit routine' }),
        ),
        h('p', { class: 'tr-routine-list' }, names.length ? names.join(' · ') : 'No exercises yet'),
        h(
          'div',
          { class: 'tr-routine-foot' },
          h('span', { class: 'tr-routine-meta label' }, done ? `Last done ${when(done.date)}` : 'Not done yet'),
          btn('Start', () => openEditor(null, { routine: r }), { iconName: 'play', primary: true, aria: `Start ${r.name}` }),
        ),
      );
    });
    return h(
      'section',
      { class: 'tr-routines', 'aria-label': 'Routines' },
      h('div', { class: 'tr-routines-head' }, h('h2', { class: 'tr-section-title label' }, 'Routines'), btn('New routine', () => openRoutineEditor(), { iconName: 'plus', ghost: true })),
      cards.length
        ? h('div', { class: 'tr-routine-grid' }, cards)
        : h('p', { class: 'tr-routines-empty' }, 'Save the exercises you repeat as a routine, like Push day. Start it in one click with last time’s numbers ready, and type only what changed.'),
    );
  }

  /* ---- Log ---- */
  function logView(s) {
    const routines = routinesView(s);
    if (!s.workouts.length) {
      return h('div', { class: 'tr-log' }, routines, emptyState({
        icon: 'dumbbell',
        title: 'No workouts yet',
        text: 'Log lifts with sets, reps and weight, runs with distance and time, cardio, or sprint times. Every exercise gets its own progress graph.',
        action: btn('Log your first workout', () => openEditor(), { iconName: 'plus', primary: true, small: false }),
      }));
    }
    const exById = new Map(s.exercises.map((x) => [x.id, x]));
    const routineIds = new Set(s.routines.map((r) => r.id));
    const list = h('div', { class: 'tr-log' }, routines, h('h2', { class: 'tr-section-title label' }, 'Workouts'));
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
          h(
            'div',
            { class: 'row-actions tr-card-actions' },
            routineIds.has(w.routineId) ? null : btn('', () => saveWorkoutAsRoutine(w.id), { iconName: 'tr-routine', ghost: true, aria: 'Save as a routine', title: 'Save as a routine (repeat it in one click)' }),
            btn('', () => openEditor(w), { iconName: 'edit', ghost: true, aria: 'Edit workout', title: 'Edit' }),
            btn('', () => deleteWorkout(w.id), { iconName: 'trash', ghost: true, aria: 'Delete workout', title: 'Delete' }),
          ),
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
      message: `This deletes its ${plural(sessions, 'logged session')} and its graph${emptied ? `, and ${plural(emptied, 'workout')} with nothing else in it` : ''}, and takes it out of your routines. It can’t be undone (a backup in Settings keeps a copy).`,
      confirmLabel: 'Delete exercise',
    });
    if (!ok) return;
    const cur = getState();
    const workouts = cur.workouts.map((w) => ({ ...w, entries: w.entries.filter((e) => e.exerciseId !== x.id) })).filter((w) => w.entries.length);
    const routines = cur.routines.map((r) => ({ ...r, items: r.items.filter((it) => it.exerciseId !== x.id) }));
    commit({ ...cur, exercises: cur.exercises.filter((o) => o.id !== x.id), workouts, routines, view: { ...cur.view, exerciseId: null, metric: null } });
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
