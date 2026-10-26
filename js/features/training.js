// LIFE/OS — 07 // Training: log workouts (lifts as sets × reps × weight, runs as distance and
// time, time-only cardio, sprint times over a fixed distance) and watch every exercise improve.
//
// Routines (Push day …) start a workout with their exercises and last time's numbers in gray, so
// only what changed is typed. Two tabs: Log (routines, then workouts newest first; click one to
// edit) and Progress (each exercise's graph
// on the metric that shows getting better: est. 1RM, pace, best time…, with personal bests and
// a history table). The workout dialog starts each exercise from last time, so the next session
// can go a little further. Store 'training' (shape in training.logic.js); it syncs, the view doesn't.

import { h, icon, registerIcon, pageHeader, emptyState, tip, dismissTip, dropdown, checkButton, setChecked, toast, openModal, confirmDialog, promptDialog, todayKey, formatDay, relativeDay, uid, onDayChange, isTyping, modalOpen, num, plural, clamp } from '../ui.js';
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
  REST_MIN,
  REST_MAX,
  sessionItem,
  itemHasData,
  sessionElapsed,
  restLeft,
  sessionGhosts,
  readSession,
  workoutFromSession,
  workoutLength,
} from './training.logic.js';
import { cleanTitle } from './tasks.logic.js';

registerIcon('tr-routine', '<path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-3.6-6 3.6v-16a1 1 0 0 1 1-1Z"/><path d="M9.5 8.5h5M9.5 11.5h3"/>');
registerIcon('tr-rest', '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2 1.5M9.5 2.5h5"/>');
registerIcon('tr-skip', '<path d="M5 5.2v13.6a.7.7 0 0 0 1.1.6l9.4-6.8a.7.7 0 0 0 0-1.2L6.1 4.6a.7.7 0 0 0-1.1.6Z"/><path d="M19 5v14"/>');
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
    // The words in their own span, as on every page: a phone's page top shows header buttons as icons
    label ? h('span', null, label) : null,
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

// The quick-add chips for someone who has made few exercises: the usual ones, a few of each kind
const STARTERS = ['Bench press', 'Squat', 'Deadlift', 'Pull-ups', 'Running', 'Cycling', 'Plank', '100 m sprint', 'Overhead press', 'Barbell row', 'Push-ups', 'Swimming', 'Rowing', 'Cardio', '200 m sprint', '400 m'];
const CHIP_MAX = 8;
const MATCH_MAX = 8;
let pickSeq = 0;

/** Exercises by the day they were last logged, newest first (never logged: after, A–Z). */
function byRecent(list) {
  const last = new Map();
  for (const w of getState().workouts) for (const e of w.entries) if ((last.get(e.exerciseId) ?? '') < w.date) last.set(e.exerciseId, w.date);
  return [...list].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? '') || a.name.localeCompare(b.name));
}

/**
 * "Add an exercise": type its name (the matches drop down, the first one lit: Enter takes the lit
 * one, ↑ ↓ light another, or a click), or tap one of the chips under the field (your latest
 * exercises, then the usual ones). A name that matches nothing has one match, "New exercise":
 * Enter asks what it logs (Strength, Distance, Time, Sprint). Shared
 * by the live workout, the workout dialog and the routine dialog. exercises() is the working list
 * (a new exercise stays in it until that place saves); used() the ids already added. With
 * onUnpick (the routine dialog), the chips are toggles: a pressed one is in, a tap takes it out.
 * The field stays open after each pick, so several go in one after the other.
 */
function exercisePicker({ exercises, setExercises, used, onPick, onUnpick = null, say, placeholder = 'Add an exercise: type its name…' }) {
  const n = ++pickSeq;
  const listId = `tr-pick-${n}`;
  let options = []; // [{ id, label, sub, run }]
  let active = -1;

  const input = h('input', {
    class: 'input tr-pick-input',
    type: 'text',
    maxlength: String(NAME_MAX),
    placeholder,
    autocomplete: 'off',
    enterkeyhint: 'done',
    role: 'combobox',
    'aria-label': 'Add an exercise',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
  });
  const listEl = h('ul', { class: 'tr-pick-list', id: listId, role: 'listbox', 'aria-label': 'Exercises', hidden: true });
  const chipsEl = h('div', { class: 'tr-chips', role: 'group', 'aria-label': 'Quick add' });

  /* ---- a new exercise: what it logs ---- */
  let newKind = 'strength';
  let newName = '';
  const newTitle = h('span', { class: 'tr-newex-title' });
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
              kindSeg.querySelector('[aria-pressed="true"]')?.focus();
            },
          },
          KIND_SHORT[k],
        ),
      ),
    );
  const closeNew = () => {
    newForm.hidden = true;
    syncEsc();
    input.focus();
  };
  const newForm = h(
    'div',
    { class: 'tr-newex', hidden: true, role: 'group', 'aria-label': 'New exercise' },
    newTitle,
    h('div', { class: 'tr-newex-row' }, kindSeg, distField, btn('Add', () => create({ name: newName, kind: newKind, distanceM: parseNumber(newDist.value) }), { iconName: 'plus', primary: true }), btn('Cancel', closeNew, { ghost: true })),
  );
  newDist.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create({ name: newName, kind: newKind, distanceM: parseNumber(newDist.value) });
    }
  });

  function askKind(name) {
    newName = cleanTitle(name).slice(0, NAME_MAX);
    if (!newName) return;
    newTitle.textContent = `New exercise “${newName}”: what do you log?`;
    newForm.hidden = false;
    paintKinds();
    closeList();
    syncEsc();
    kindSeg.querySelector('[aria-pressed="true"]')?.focus();
  }

  function create(spec) {
    const res = addExercise(exercises(), { ...spec, distanceM: Number.isFinite(spec.distanceM) && spec.distanceM > 0 ? spec.distanceM : 100 });
    if (res.error) {
      say(res.error === 'taken' ? `There is already an exercise called “${cleanTitle(spec.name)}”: pick it in the list.` : 'Give the exercise a name.');
      return;
    }
    say('');
    setExercises(res.exercises);
    newForm.hidden = true;
    pick(res.exercise);
  }

  function pick(x) {
    if (!x) return;
    input.value = '';
    closeList();
    onPick(x);
    refresh();
  }

  /* ---- the matches under the field ---- */
  const presetsLeft = () => {
    const names = new Set(exercises().map((x) => x.name.toLowerCase()));
    return PRESETS.filter((p) => !names.has(p.name.toLowerCase()));
  };

  function matches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const taken = used();
    const rank = (name) => (name.toLowerCase().startsWith(q) ? 0 : 1);
    const own = byRecent(exercises())
      .filter((x) => !taken.has(x.id) && x.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((x) => ({ label: x.name, sub: kindText(x), run: () => pick(x) }));
    const usual = presetsLeft()
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((p) => ({ label: p.name, sub: `New · ${KIND_SHORT[p.kind]}`, run: () => create(p) }));
    // The exact name first (Enter takes the first match), then yours, then the usual ones
    const list = [...own, ...usual].sort((a, b) => (b.label.toLowerCase() === q) - (a.label.toLowerCase() === q)).slice(0, MATCH_MAX);
    const exact = exercises().some((x) => x.name.toLowerCase() === q) || presetsLeft().some((p) => p.name.toLowerCase() === q);
    if (!exact) list.push({ label: `New exercise “${cleanTitle(query).slice(0, NAME_MAX)}”…`, sub: 'Pick what it logs', run: () => askKind(query), isNew: true });
    return list;
  }

  function paintList() {
    options = matches(input.value);
    if (active >= options.length) active = options.length - 1;
    listEl.replaceChildren(
      ...options.map((o, i) =>
        h(
          'li',
          {
            id: `${listId}-${i}`,
            class: ['tr-pick-opt', o.isNew && 'is-new'],
            role: 'option',
            'aria-selected': String(i === active),
            onPointerdown: (e) => e.preventDefault(),
            onClick: () => o.run(),
          },
          h('span', { class: 'tr-pick-name' }, o.label),
          h('span', { class: 'tr-pick-sub label' }, o.sub),
        ),
      ),
    );
    const open = options.length > 0;
    listEl.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
    syncEsc();
  }

  function closeList() {
    active = -1;
    options = [];
    listEl.hidden = true;
    listEl.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    syncEsc();
  }

  /* Escape closes the matches or the new-exercise question, not the dialog around them:
     ui.openModal hears Escape first (on document, capturing), so while one of them is open the
     picker listens before it, on window */
  function onEscape(e) {
    if (e.key !== 'Escape' || e.isComposing) return;
    if (!input.isConnected) return syncEsc(true);
    if (!listEl.hidden && document.activeElement === input) closeList();
    else if (!newForm.hidden && newForm.contains(document.activeElement)) closeNew();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function syncEsc(off = false) {
    if (!off && (!listEl.hidden || !newForm.hidden)) window.addEventListener('keydown', onEscape, true);
    else window.removeEventListener('keydown', onEscape, true);
  }

  input.addEventListener('input', () => {
    // The first match is lit: Enter takes it ("ben" + Enter = Bench press, not a new "ben")
    active = 0;
    say('');
    newForm.hidden = true;
    paintList();
  });
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && closeList(), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) paintList();
      if (!options.length) return;
      e.preventDefault();
      active = e.key === 'ArrowDown' ? (active + 1) % options.length : active <= 0 ? options.length - 1 : active - 1;
      paintList();
      listEl.children[active]?.scrollIntoView?.({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const q = input.value.trim().toLowerCase();
      if (!q) return;
      if (active >= 0 && options[active]) return options[active].run();
      // The exact name: that exercise (or that usual one); anything else is a new one
      const known = exercises().find((x) => x.name.toLowerCase() === q && !used().has(x.id));
      if (known) return pick(known);
      const usual = presetsLeft().find((p) => p.name.toLowerCase() === q);
      if (usual) return create(usual);
      if (exercises().some((x) => x.name.toLowerCase() === q)) return say(`“${cleanTitle(input.value)}” is in already.`);
      askKind(input.value);
    }
  });

  /* ---- the chips: your latest exercises, then the usual ones you haven't made ---- */
  function refresh() {
    const taken = used();
    const own = byRecent(exercises()).filter((x) => onUnpick || !taken.has(x.id));
    const ownChips = own.slice(0, CHIP_MAX).map((x) => {
      const on = taken.has(x.id);
      return h(
        'button',
        {
          type: 'button',
          class: 'btn btn--sm tr-chip',
          'aria-pressed': onUnpick ? String(on) : null,
          title: on ? `${x.name}: take it out` : `Add ${x.name}`,
          onClick: () => {
            if (on) onUnpick(x);
            else onPick(x);
            refresh();
          },
        },
        icon(on ? 'check' : 'plus', { size: 13 }),
        h('span', null, x.name),
      );
    });
    const left = presetsLeft();
    const usual = STARTERS.map((name) => left.find((p) => p.name === name))
      .filter(Boolean)
      .slice(0, Math.max(0, CHIP_MAX - ownChips.length))
      .map((p) => h('button', { type: 'button', class: 'btn btn--sm btn--ghost tr-chip is-new', title: `New: ${p.name} (${KIND_LABEL[p.kind]})`, onClick: () => create(p) }, icon('plus', { size: 13 }), h('span', null, p.name)));
    chipsEl.replaceChildren(...ownChips, ...usual);
    chipsEl.hidden = !chipsEl.childElementCount;
    if (!listEl.hidden) paintList();
  }

  refresh();
  return {
    el: h('div', { class: 'tr-add' }, h('div', { class: 'tr-pick' }, icon('search', { size: 15, className: 'tr-pick-ic' }), input, listEl), chipsEl, newForm),
    refresh,
    focus: () => input.focus(),
    input,
  };
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
        h(
          'div',
          { class: 'tr-entry-acts' },
          repeatBtn,
          btn('', () => {
            editors.splice(editors.indexOf(ed), 1);
            el.remove();
            picker.refresh();
            syncHint();
            picker.focus();
          }, { iconName: 'x', ghost: true, aria: `Remove ${exercise.name}`, title: 'Remove from this workout' }),
        ),
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
        // Last time's numbers in gray, or a dash: the unit stays after the field, said once
        const reps = h('input', { class: 'input tr-num', type: 'text', inputmode: 'numeric', value: value?.reps ?? '', placeholder: ghost ? String(ghost.reps) : '–', 'aria-label': ghost ? `Reps (last time ${ghost.reps})` : 'Reps', autocomplete: 'off' });
        const kg = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: value?.weight ? String(value.weight) : '', placeholder: ghost?.weight > 0 ? String(ghost.weight) : '–', 'aria-label': ghost?.weight > 0 ? `Weight in kg (last time ${ghost.weight})` : 'Weight in kg (empty for body weight)', autocomplete: 'off' });
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
      const km = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: e.distanceKm ?? '', placeholder: kmGhost || '–', 'aria-label': kmGhost ? `Distance in km (last time ${kmGhost})` : 'Distance in km', autocomplete: 'off' });
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
        const input = h('input', { class: 'input tr-num', type: 'text', inputmode: 'decimal', value: sec ? String(sec) : '', placeholder: '–', 'aria-label': `Attempt ${inputs.length + 1} in seconds`, autocomplete: 'off' });
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
    // A workout logged: the page's explanation has done its job
    if (isNew) dismissTip('training.intro');
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
    initialFocus: editors.length ? entriesEl.querySelector('input') : picker.input,
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
  const nameId = `tr-rname-${++pickSeq}`;
  const nameIn = h('input', { id: nameId, class: 'input', type: 'text', value: routine?.name ?? '', maxlength: String(NAME_MAX), placeholder: 'Push day, Legs, Long run…', autocomplete: 'off' });
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
  // Tap as many chips as the routine has (each one goes in, tap again to take it out), or type
  const picker = exercisePicker({
    exercises: () => exercises,
    setExercises: (list) => (exercises = list),
    used: () => new Set(items.map((it) => it.exerciseId)),
    onPick: (x) => {
      if (items.some((it) => it.exerciseId === x.id)) return;
      items.push({ exerciseId: x.id, sets: 3 });
      paint();
    },
    onUnpick: (x) => {
      const at = items.findIndex((it) => it.exerciseId === x.id);
      if (at === -1) return;
      items.splice(at, 1);
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
      h('div', { class: 'field' }, h('label', { class: 'label', for: nameId }, 'Routine name'), nameIn),
      h(
        'div',
        { class: 'field tr-rfield' },
        h('span', { class: 'label' }, 'Exercises'),
        h('p', { class: 'tr-last' }, 'The exercises you do together, in order. Starting the routine opens them with last time’s numbers ready.'),
        listEl,
        picker.el,
      ),
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
   The live session: a workout being done now, on a page of its own
   ========================================================================== */
//
// Start (a routine, or an empty workout) puts a session in the store (per device: sync leaves it
// alone). The Training page then shows only the session, everything typed is saved as it is
// typed, and it stays until Finish (it becomes a workout) or Discard, whatever else you open in
// the meantime, even after closing the app. A pill in the top bar leads back to it from any page.

const clockText = (sec) => formatDuration(sec);

/** Start a workout now: from a routine (its exercises, with last time's set counts) or empty. */
function startSession({ routine = null } = {}) {
  const s = getState();
  if (s.session) {
    toast('A workout is already going: finish or discard it first.');
    location.hash = '#/training';
    return;
  }
  const items = [];
  for (const it of routine?.items ?? []) {
    const x = exerciseOf(it.exerciseId);
    if (!x) continue;
    const last = lastEntry(x.id);
    const sets = x.kind === 'strength' ? it.sets || last?.entry.sets.length || 3 : 1;
    items.push(sessionItem(x.id, { sets }));
  }
  const now = Date.now();
  commit({ ...s, session: { id: uid(), startedAt: now, date: todayKey(), title: routine?.name ?? '', note: '', routineId: routine?.id ?? null, items, newExercises: [], restSec: 90, restEndsAt: null } });
  location.hash = '#/training';
}

/**
 * Throw the workout going on away. With nothing in it yet it goes at once (Undo in the toast);
 * with sets or numbers in it, after asking: those are gone for good.
 */
async function discardSession() {
  const s = getState().session;
  if (!s) return;
  if (s.note.trim() || s.items.some(itemHasData)) {
    const ok = await confirmDialog({
      title: 'Discard this workout?',
      message: 'What you logged in it is not saved. Your earlier workouts stay as they are.',
      confirmLabel: 'Discard workout',
    });
    if (ok && getState().session?.id === s.id) commit({ ...getState(), session: null });
    return;
  }
  commit({ ...getState(), session: null });
  toast('Workout discarded.', {
    action: {
      label: 'Undo',
      onClick: () => {
        const cur = getState();
        if (cur.session) return;
        commit({ ...cur, session: s });
        location.hash = '#/training';
      },
    },
  });
}

/**
 * The session page in `host`. The working copy (`live`) takes every keystroke and is saved a
 * moment later; adding or removing exercises, sets and attempts saves at once and redraws.
 * One bar stays in view at the bottom: the rest timer (once a set is ticked), Finish, Discard.
 * Returns { flush, destroy }.
 */
function sessionPage(host) {
  let live = structuredClone(getState().session);
  let saveTimer = 0;
  let alive = true;
  const refs = new Map(); // `${key}:${row}:${field}` -> input
  const exercisesNow = () => {
    const known = getState().exercises;
    const ids = new Set(known.map((x) => x.id));
    return [...known, ...live.newExercises.filter((x) => !ids.has(x.id))];
  };
  const exById = (id) => exercisesNow().find((x) => x.id === id) ?? null;
  const item = (key) => live.items.find((it) => it.key === key);
  const mine = () => alive && getState().session?.id === live.id;

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const cur = getState();
    if (cur.session?.id === live.id) commit({ ...cur, session: live });
  }
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  };

  /* ---- head: that it's going on, its name, the clock ---- */
  const titleIn = h('input', { class: 'input tr-sess-title', type: 'text', maxlength: String(TITLE_MAX), placeholder: 'Name this workout', 'aria-label': 'Workout name', autocomplete: 'off' });
  titleIn.addEventListener('input', () => {
    live.title = titleIn.value;
    saveSoon();
  });
  const clock = h('span', { class: 'stat-value tr-sess-clock tnum', 'aria-label': 'Time so far' });
  const head = h(
    'header',
    { class: 'tr-sess-head panel' },
    h('div', { class: 'tr-sess-id' }, h('span', { class: 'tr-sess-live label' }, h('span', { class: 'tr-live-dot', 'aria-hidden': 'true' }), 'Workout in progress'), titleIn),
    h('div', { class: 'tr-sess-timebox' }, h('span', { class: 'label' }, 'Time'), clock),
  );

  /* ---- the bar at the bottom: rest (from the first ticked set), Finish, Discard ---- */
  const restText = h('span', { class: 'tr-rest-time tnum' });
  const restLabel = h('span', { class: 'label tr-rest-label' }, 'Rest');
  const setRest = (sec) => {
    live.restSec = clamp(sec, REST_MIN, REST_MAX);
    flush();
    tick();
  };
  const restEl = h(
    'div',
    { class: 'tr-rest', role: 'timer', 'aria-live': 'off', hidden: true },
    icon('tr-rest', { size: 16 }),
    restLabel,
    restText,
    h(
      'div',
      { class: 'tr-rest-ctl' },
      btn('', () => {
        if (live.restEndsAt && live.restEndsAt > Date.now()) live.restEndsAt -= 15000;
        setRest(live.restSec - 15);
      }, { iconName: 'minus', ghost: true, aria: '15 seconds less rest', title: '−15 s' }),
      btn('', () => {
        if (live.restEndsAt && live.restEndsAt > Date.now()) live.restEndsAt += 15000;
        setRest(live.restSec + 15);
      }, { iconName: 'plus', ghost: true, aria: '15 seconds more rest', title: '+15 s' }),
      btn('', () => {
        live.restEndsAt = null;
        flush();
        tick();
      }, { iconName: 'tr-skip', ghost: true, aria: 'Skip the rest', title: 'Skip the rest' }),
    ),
  );
  const err = h('p', { class: 'tr-err tr-sess-err', role: 'alert' });
  const bar = h(
    'div',
    { class: 'tr-sess-bar panel' },
    restEl,
    h(
      'div',
      { class: 'tr-sess-actions' },
      btn('Finish workout', () => finish(), { iconName: 'check', primary: true, small: false }),
      btn('Discard', () => {
        flush();
        discardSession();
      }, { iconName: 'trash', ghost: true, small: false, title: 'Throw this workout away', aria: 'Discard this workout' }),
    ),
  );

  const hint = tip({ id: 'training.session', className: 'tr-sess-hint', text: 'Gray numbers are last time’s. Tick a set when it’s done (or press Enter in it): empty fields take last time’s numbers and the rest timer starts. Everything saves as you go; the workout stays open until you press Finish.' });
  const itemsEl = h('div', { class: 'tr-sess-items' });
  const picker = exercisePicker({
    exercises: exercisesNow,
    setExercises: (list) => {
      const known = new Set(getState().exercises.map((x) => x.id));
      live.newExercises = list.filter((x) => !known.has(x.id));
    },
    used: () => new Set(live.items.map((it) => it.exerciseId)),
    onPick: (x) => {
      const last = lastEntry(x.id);
      live.items.push(sessionItem(x.id, { sets: x.kind === 'strength' ? last?.entry.sets.length || 3 : 1 }));
      flush();
      build({ focus: `${live.items[live.items.length - 1].key}:0:${x.kind === 'strength' ? 'reps' : x.kind === 'sprint' ? 'times' : x.kind === 'distance' ? 'km' : 'time'}` });
    },
    say: (t) => (err.textContent = t),
  });
  const noteIn = h('textarea', { class: 'textarea tr-note', rows: '2', placeholder: 'Notes (optional): how it felt, the weather…', 'aria-label': 'Notes' });
  noteIn.addEventListener('input', () => {
    live.note = noteIn.value;
    saveSoon();
  });
  host.replaceChildren(head, hint, itemsEl, h('div', { class: 'tr-sess-add panel' }, picker.el), noteIn, err, bar);

  /* ---- one exercise ---- */
  function input(key, row, field, value, attrs, onInput) {
    const el = h('input', { class: 'input tr-num', type: 'text', autocomplete: 'off', value, dataset: { ref: `${key}:${row}:${field}` }, ...attrs });
    el.addEventListener('input', () => {
      onInput(el.value);
      const it = item(key);
      if (it) it.touched = true;
      err.textContent = '';
      saveSoon();
    });
    refs.set(`${key}:${row}:${field}`, el);
    return el;
  }

  /** Put back an exercise or a set row taken out a moment ago (the toast's Undo). */
  function undoable(message, put) {
    toast(message, {
      action: {
        label: 'Undo',
        onClick: () => {
          if (!mine()) return;
          put();
          flush();
          build();
        },
      },
    });
  }

  function exerciseEl(it, ghosts) {
    const x = exById(it.exerciseId);
    if (!x) return null;
    const g = ghosts.get(it.key);
    const last = lastEntry(x.id);
    const body = h('div', { class: 'tr-entry-body' });
    const structural = (fn, focus = null) => {
      fn();
      flush();
      build({ focus });
    };
    const sameAsLast =
      last && x.kind !== 'sprint'
        ? btn('Same as last time', () => {
            if (x.kind === 'strength') {
              const lastSets = last.entry.sets.filter((st) => st.reps > 0);
              while (it.sets.length < lastSets.length) it.sets.push({ reps: '', kg: '', done: false });
              it.sets.forEach((row, i) => {
                const gs = lastSets[Math.min(i, lastSets.length - 1)];
                if (!row.reps) row.reps = String(gs.reps);
                if (!row.kg && gs.weight > 0) row.kg = String(gs.weight);
              });
            } else {
              if (!it.km && g.km) it.km = g.km;
              if (!it.time && g.time) it.time = g.time;
            }
            it.touched = true;
            structural(() => {});
          }, { iconName: 'reset', ghost: true, title: 'Fill in last time’s numbers' })
        : null;
    // Taken out at once; with something in it, Undo puts it back where it was
    const removeItem = () => {
      const at = live.items.indexOf(it);
      if (at === -1) return;
      const had = itemHasData(it);
      structural(() => live.items.splice(at, 1));
      if (had) undoable(`${x.name} taken out of the workout.`, () => !item(it.key) && live.items.splice(Math.min(at, live.items.length), 0, it));
    };
    const el = h(
      'section',
      { class: 'tr-entry tr-sess-ex panel', 'aria-label': x.name, dataset: { key: it.key } },
      h(
        'div',
        { class: 'tr-entry-head' },
        h('div', { class: 'tr-entry-name' }, x.name, h('span', { class: 'tr-kind label' }, kindText(x))),
        h('div', { class: 'tr-entry-acts' }, sameAsLast, btn('', removeItem, { iconName: 'x', ghost: true, aria: `Remove ${x.name}`, title: 'Remove from this workout' })),
      ),
      h('p', { class: 'tr-last' }, last ? `Last time (${formatDay(last.date)}): ${entrySummary(last.entry, x)}. ${nextTarget(last.entry, x)}` : 'First time: whatever you log becomes the baseline.'),
      body,
    );

    if (x.kind === 'strength') {
      const rows = h('div', { class: 'tr-sets' });
      it.sets.forEach((row, i) => {
        const gs = g.sets[i] ?? null;
        // Last time's numbers in gray, or a dash; the unit follows the field, once
        const reps = input(it.key, i, 'reps', row.reps, { inputmode: 'numeric', enterkeyhint: 'next', placeholder: gs ? String(gs.reps) : '–', 'aria-label': `Set ${i + 1} reps${gs ? ` (last time ${gs.reps})` : ''}` }, (v) => (row.reps = v));
        const kg = input(it.key, i, 'kg', row.kg, { inputmode: 'decimal', enterkeyhint: 'next', placeholder: gs?.weight > 0 ? String(gs.weight) : '–', 'aria-label': `Set ${i + 1} weight in kg${gs?.weight > 0 ? ` (last time ${gs.weight})` : ''}` }, (v) => (row.kg = v));
        const setEl = h('div', { class: ['tr-set', 'tr-sess-set', row.done && 'is-done'] });
        /** Tick (or untick) the set: an empty field takes last time's number, and the rest starts. */
        const mark = (on) => {
          if (on && !row.done) {
            if (!row.reps.trim()) {
              if (!gs) {
                err.textContent = `${x.name}, set ${i + 1}: type the reps first.`;
                reps.focus();
                setChecked(done, false);
                return false;
              }
              row.reps = String(gs.reps);
              reps.value = row.reps;
            }
            if (!row.kg.trim() && gs?.weight > 0) {
              row.kg = String(gs.weight);
              kg.value = row.kg;
            }
            row.done = true;
            it.touched = true;
            live.restEndsAt = Date.now() + live.restSec * 1000;
            // The session tip explains ticking: done once, it goes (C2)
            dismissTip('training.session');
          } else if (!on) row.done = false;
          err.textContent = '';
          setEl.classList.toggle('is-done', row.done);
          setChecked(done, row.done);
          done.title = row.done ? 'Done (click to undo)' : 'Mark this set done';
          flush();
          tick();
          return true;
        };
        const done = checkButton({ checked: row.done, label: `Set ${i + 1} done`, size: 'lg', onToggle: (next) => mark(next) });
        done.classList.add('tr-done');
        done.title = row.done ? 'Done (click to undo)' : 'Mark this set done';
        // Enter ticks the set and goes on to the next one (the next set, or the next exercise)
        const onEnter = (e) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault();
          if (!row.done && !mark(true)) return;
          // (after the last exercise: the field that adds one)
          const next = refs.get(`${it.key}:${i + 1}:reps`) ?? el.nextElementSibling?.querySelector('input') ?? picker.input;
          next?.focus();
        };
        reps.addEventListener('keydown', onEnter);
        kg.addEventListener('keydown', onEnter);
        const removeSet = () => {
          const had = row.done || row.reps.trim() || row.kg.trim();
          structural(() => it.sets.splice(i, 1));
          if (had) undoable(`Set ${i + 1} of ${x.name} removed.`, () => !it.sets.includes(row) && it.sets.splice(Math.min(i, it.sets.length), 0, row));
        };
        setEl.append(
          h('span', { class: 'tr-set-n label' }, `Set ${i + 1}`),
          reps,
          h('span', { class: 'tr-x', 'aria-hidden': 'true' }, '×'),
          kg,
          h('span', { class: 'tr-unit' }, 'kg'),
          done,
          btn('', removeSet, { iconName: 'x', ghost: true, aria: `Remove set ${i + 1}` }),
        );
        rows.append(setEl);
      });
      body.append(rows, btn('Add set', () => structural(() => it.sets.push({ reps: '', kg: '', done: false }), `${it.key}:${it.sets.length}:reps`), { iconName: 'plus', ghost: true }));
    } else if (x.kind === 'sprint') {
      const list = h('div', { class: 'tr-times' });
      it.times.forEach((t, i) => list.append(h('label', { class: 'tr-inline' }, input(it.key, i, 'times', t, { inputmode: 'decimal', placeholder: '–', 'aria-label': `Attempt ${i + 1} in seconds` }, (v) => (it.times[i] = v)), 's')));
      body.append(list, btn('Add attempt', () => structural(() => it.times.push(''), `${it.key}:${it.times.length}:times`), { iconName: 'plus', ghost: true }));
    } else {
      const km = x.kind === 'distance' ? input(it.key, 0, 'km', it.km, { inputmode: 'decimal', placeholder: g.km || '–', 'aria-label': g.km ? `Distance in km (last time ${g.km})` : 'Distance in km' }, (v) => (it.km = v)) : null;
      const time = input(it.key, 0, 'time', it.time, { class: 'input tr-time', placeholder: g.time || 'm:ss', 'aria-label': `Time${g.time ? `, last time ${g.time}` : ''}` }, (v) => (it.time = v));
      body.append(h('div', { class: 'tr-fields' }, km ? h('label', { class: 'tr-inline' }, km, 'km') : null, h('label', { class: 'tr-inline' }, km ? 'in' : 'Time', time)));
    }
    return el;
  }

  /** Draw the session from `live` (keeps the scroll; focus goes to `focus` or stays where it was). */
  function build({ focus = null } = {}) {
    const keep = focus ?? document.activeElement?.dataset?.ref ?? null;
    refs.clear();
    titleIn.value = live.title;
    noteIn.value = live.note;
    const ghosts = sessionGhosts(live, getState().workouts);
    itemsEl.replaceChildren(...live.items.map((it) => exerciseEl(it, ghosts)).filter(Boolean));
    itemsEl.hidden = !itemsEl.childElementCount;
    picker.refresh();
    if (keep) refs.get(keep)?.focus({ preventScroll: !focus });
    tick();
  }

  /* ---- clock and rest timer ---- */
  function tick() {
    clock.textContent = clockText(sessionElapsed(live));
    const left = restLeft(live);
    const over = live.restEndsAt && live.restEndsAt <= Date.now() && Date.now() - live.restEndsAt < 8000;
    // The rest timer comes in with the first ticked set
    restEl.hidden = !live.restEndsAt && !live.items.some((it) => it.sets.some((x) => x.done));
    restEl.classList.toggle('is-running', left > 0);
    restEl.classList.toggle('is-over', !!over);
    restText.textContent = left > 0 ? clockText(left) : over ? 'Go!' : clockText(live.restSec);
    restLabel.textContent = over && !left ? 'Rest over' : 'Rest';
    restEl.title = left > 0 || over ? '' : 'Starts when you tick a set';
  }

  /* ---- finish ---- */
  function finish() {
    flush();
    const cur = getState();
    if (cur.session?.id !== live.id) return;
    const exercises = exercisesNow();
    const res = readSession(live, exercises, cur.workouts);
    if (res.error) {
      const x = exById(item(res.key)?.exerciseId);
      err.textContent = `${x?.name ?? 'Exercise'}: ${res.error}`;
      refs.get(`${res.key}:${res.row}:${res.field}`)?.focus();
      return;
    }
    if (!res.entries.length) {
      err.textContent = live.items.length ? 'Log at least one set (tick it, or type its numbers) before you finish. Or discard the workout.' : 'Add an exercise first, or discard the workout.';
      (live.items.length ? itemsEl.querySelector('input') : picker.input)?.focus();
      return;
    }
    const workout = workoutFromSession(live, res.entries);
    const known = new Set(cur.exercises.map((x) => x.id));
    const used = new Set(res.entries.map((e) => e.exerciseId));
    const next = {
      ...cur,
      exercises: [...cur.exercises, ...live.newExercises.filter((x) => !known.has(x.id) && used.has(x.id))],
      workouts: sortWorkouts([...cur.workouts, workout]),
      session: null,
    };
    commit(next);
    dismissTip('training.intro');
    const records = recordsIn(next, workout.id);
    const length = workoutLength(workout);
    const words = records.slice(0, 2).map((r) => {
      const ex = next.exercises.find((x) => x.id === r.exerciseId);
      const metric = metricsFor(ex.kind).find((m) => m.id === r.metricId);
      return `${ex.name}: ${metric.label} ${metric.format(r.value)}`;
    });
    toast(records.length ? `Workout done${length ? ` in ${length}` : ''}. New personal best: ${words.join(' · ')}!` : `Workout done${length ? ` in ${length}` : ''}: ${plural(res.entries.length, 'exercise')} logged.`, { duration: 8000 });
  }

  build();
  const timer = setInterval(tick, 1000);
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  if (!live.items.length) requestAnimationFrame(() => picker.focus());
  return {
    id: live.id,
    flush,
    destroy() {
      flush();
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    },
  };
}

/** The pill in the top bar (every page but Training): the workout going on, its time or rest. */
function mountLivePill(slot) {
  const pill = h('a', { class: 'tr-live', href: '#/training', hidden: true, title: 'Back to the workout in progress' });
  slot.append(pill);
  let toldRestEnd = null;
  const paint = () => {
    const s = getState().session;
    if (!s) {
      pill.hidden = true;
      return;
    }
    const now = Date.now();
    // The rest is over: say so once, wherever you are in the app
    if (s.restEndsAt && s.restEndsAt <= now && toldRestEnd !== s.restEndsAt) {
      toldRestEnd = s.restEndsAt;
      if (now - s.restEndsAt < 4000) {
        toast('Rest is over: time for the next set.');
        navigator.vibrate?.(200);
      }
    }
    pill.hidden = /^#\/training\b/.test(location.hash);
    const rest = restLeft(s, now);
    pill.replaceChildren(
      h('span', { class: 'tr-live-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'tr-live-name' }, s.title || 'Workout'),
      h('span', { class: 'tr-live-time tnum' }, rest ? `Rest ${clockText(rest)}` : clockText(sessionElapsed(s, now))),
    );
    pill.setAttribute('aria-label', `Workout in progress: ${s.title || 'Workout'}. Back to it`);
  };
  setInterval(paint, 1000);
  store.subscribe(paint);
  window.addEventListener('hashchange', paint);
  paint();
}

/* ==========================================================================
   The page
   ========================================================================== */

/** This week on the page's title row, in a few words: 'This week: 2 workouts · 4,200 kg' ('' before the first one). */
function weekStat(s) {
  if (!s.workouts.length) return '';
  const w = weekStats(s, todayKey());
  if (!w.workouts) return 'No workouts yet this week';
  const parts = [`This week: ${num(w.workouts)} ${w.workouts === 1 ? 'workout' : 'workouts'}`];
  if (w.volumeKg) parts.push(`${Math.round(w.volumeKg).toLocaleString('en')} kg`);
  else if (w.km) parts.push(formatKm(w.km));
  return parts.join(' · ');
}

/** A section's title, like a card's on the other pages: its icon, its name, then its buttons. */
function sectionHead(iconName, title, ...extra) {
  return h('div', { class: 'tr-section-head' }, h('h2', { class: 'tr-section-title' }, icon(iconName, { size: 15 }), h('span', null, title)), ...extra);
}

function mount(root) {
  root.classList.add('tr-root');
  let shown = LOG_PAGE;
  const cleanups = [];

  // "Start workout"; a phone's title row says "Start" (the name stays "Start workout"). data-tour:
  // the full tutorial points at it (js/tour.logic.js)
  const startBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary', dataset: { tour: 'training-start' }, onClick: () => startSession() },
    icon('play', { size: 14 }),
    h('span', null, 'Start', h('span', { class: 'tr-start-more' }, ' workout')),
  );
  const header = pageHeader({
    index: '07',
    title: 'Training',
    // What the page shows, not a promised result: whether you get better is up to the training
    subtitle: 'Log every workout. See how each lift, run and sprint changes over time.',
    tipId: 'training.intro',
    stat: weekStat(getState()),
    actions: [
      btn('Log past workout', () => openEditor(), { iconName: 'edit', ghost: true, small: false, title: 'Log a workout you already did, on any date' }),
      startBtn,
    ],
  });
  const tabsEl = h('div', { class: 'tr-tabs' });
  const bodyEl = h('div', { class: 'tr-body' });
  // The page shows either the usual view or, while a workout is going, only that workout. The
  // header is the page's own (its first child), like every page's, so it gets the page's icon.
  const normalEl = h('div', { class: 'tr-normal' }, tabsEl, bodyEl);
  const sessionEl = h('div', { class: 'tr-session', hidden: true });
  // While a workout is going the header steps aside: the page keeps its h1 for screen readers
  const sessionTitle = h('h1', { class: 'sr-only', hidden: true }, 'Training: workout in progress');
  root.append(header, sessionTitle, normalEl, sessionEl);
  let sessionCtl = null;
  let shownStat = null;

  function render() {
    const s = getState();
    header.hidden = !!s.session;
    sessionTitle.hidden = !s.session;
    if (s.session) {
      if (sessionCtl?.id !== s.session.id) {
        sessionCtl?.destroy();
        sessionCtl = sessionPage(sessionEl);
      }
      normalEl.hidden = true;
      sessionEl.hidden = false;
      return;
    }
    if (sessionCtl) {
      sessionCtl.destroy();
      sessionCtl = null;
      sessionEl.replaceChildren();
    }
    sessionEl.hidden = true;
    normalEl.hidden = false;
    const stat = weekStat(s);
    if (stat !== shownStat) {
      shownStat = stat;
      header.setStat?.(stat);
    }
    const focusId = document.activeElement?.closest?.('[data-tr-focus]')?.dataset.trFocus;
    tabsEl.replaceChildren(seg('View', [{ value: 'log', label: 'Log' }, { value: 'progress', label: 'Progress' }], s.view.tab, (tab) => setView({ tab }), 'tr-tab-seg'));
    bodyEl.replaceChildren(s.view.tab === 'progress' ? progressView(s) : logView(s));
    if (focusId) bodyEl.querySelector(`[data-tr-focus="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
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
        { class: 'tr-routine panel', 'aria-label': `Routine ${r.name}`, dataset: { id: r.id } },
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
          btn('Start', () => startSession({ routine: r }), { iconName: 'play', primary: true, aria: `Start ${r.name}` }),
        ),
      );
    });
    return h(
      'section',
      { class: 'tr-section tr-routines', 'aria-label': 'Routines' },
      sectionHead('tr-routine', 'Routines', btn('New routine', () => openRoutineEditor(), { iconName: 'plus', ghost: true })),
      cards.length
        ? h('div', { class: 'tr-routine-grid' }, cards)
        : emptyState({
            icon: 'tr-routine',
            title: 'No routines yet',
            text: 'Save the exercises you repeat as a routine, like Push day: start it in one click with last time’s numbers ready.',
            className: 'tr-empty-sm',
          }),
    );
  }

  /* ---- Log ---- */
  function logView(s) {
    // Nothing at all yet: one empty state (Start is at the top; a routine is the other way in)
    if (!s.workouts.length && !s.routines.length) {
      return h(
        'div',
        { class: 'tr-log' },
        emptyState({
          icon: 'dumbbell',
          title: 'No workouts yet',
          text: 'Press Start when you train: lifts with sets, reps and weight, runs with distance and time, cardio or sprint times. Every exercise gets its own progress graph.',
          action: btn('Make a routine', () => openRoutineEditor(), { iconName: 'tr-routine', small: false, title: 'Save the exercises you repeat, like Push day' }),
        }),
      );
    }
    const routines = routinesView(s);
    if (!s.workouts.length) {
      return h(
        'div',
        { class: 'tr-log' },
        routines,
        h('section', { class: 'tr-section', 'aria-label': 'Workouts' }, sectionHead('list', 'Workouts'), emptyState({ icon: 'dumbbell', title: 'No workouts yet', text: 'Start a routine, or press Start at the top. Finished workouts show up here.', className: 'tr-empty-sm' })),
      );
    }
    const exById = new Map(s.exercises.map((x) => [x.id, x]));
    const routineIds = new Set(s.routines.map((r) => r.id));
    const list = h('section', { class: 'tr-section tr-workouts', 'aria-label': 'Workouts' }, sectionHead('list', 'Workouts'));
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
          h('div', { class: 'tr-card-when' }, h('span', { class: 'label' }, dayLabel(w.date), workoutLength(w) ? ` · ${workoutLength(w)}` : ''), w.title ? h('h3', { class: 'tr-card-title' }, w.title) : null),
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
    return h('div', { class: 'tr-log' }, routines, list);
  }

  /* ---- Progress ---- */
  function progressView(s) {
    const trained = s.exercises
      .map((x) => ({ x, h: history(s.workouts, x.id) }))
      .filter((r) => r.h.length)
      .sort((a, b) => (a.h[a.h.length - 1].date < b.h[b.h.length - 1].date ? 1 : -1));
    if (!trained.length) {
      return emptyState({ icon: 'activity', title: 'No progress to show yet', text: 'Finish a workout (or log a past one) and each exercise in it gets a graph here.' });
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
        // A phone gets the measures as a menu: five of them don't fit its width
        metrics.length > 1
          ? h(
              'div',
              { class: 'tr-metric-menu' },
              dropdown({ items: metrics.map((m) => ({ value: m.id, label: m.label })), value: metric.id, className: 'tr-metric-dd', ariaLabel: ({ picked }) => `Measure: ${picked?.label ?? ''}`, onSelect: (id) => setView({ metric: id }) }).el,
            )
          : null,
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
      message: `This deletes its ${plural(sessions, 'logged session')} and its graph${emptied ? `, and ${plural(emptied, 'workout')} with nothing else in it` : ''}, and takes it out of your routines. It can’t be undone. To keep a copy, first use Download a backup in Settings.`,
      confirmLabel: 'Delete exercise',
    });
    if (!ok) return;
    const cur = getState();
    const workouts = cur.workouts.map((w) => ({ ...w, entries: w.entries.filter((e) => e.exerciseId !== x.id) })).filter((w) => w.entries.length);
    const routines = cur.routines.map((r) => ({ ...r, items: r.items.filter((it) => it.exerciseId !== x.id) }));
    commit({ ...cur, exercises: cur.exercises.filter((o) => o.id !== x.id), workouts, routines, view: { ...cur.view, exerciseId: null, metric: null } });
    toast(`“${x.name}” deleted.`);
  }

  // N: start a workout (like N for a new task); while one is going, N does nothing here
  const onKey = (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || getState().session) return;
    e.preventDefault();
    startSession();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  // Right-click a workout: Delete, or Duplicate = the same workout again today
  cleanups.push(
    registerContextProvider('training', (el) => {
      if (!root.contains(el)) return null;
      const routineEl = el.closest('.tr-routine[data-id]');
      const r = routineEl ? getState().routines.find((x) => x.id === routineEl.dataset.id) : null;
      if (r) {
        return {
          kind: 'routine',
          id: r.id,
          label: `Routine: ${r.name}`,
          el: routineEl,
          edit: () => openRoutineEditor(r),
          rename: () => renameRoutine(r.id),
          remove: () => deleteRoutine(r.id),
          can: { copy: false, paste: false },
        };
      }
      const card = el.closest('.tr-card[data-id]');
      const w = card ? getState().workouts.find((x) => x.id === card.dataset.id) : null;
      if (!w) return null;
      return {
        kind: 'workout',
        id: w.id,
        label: `Workout: ${w.title || formatDay(w.date)}`,
        el: card,
        edit: () => openEditor(w),
        rename: () => renameWorkout(w.id),
        remove: () => deleteWorkout(w.id),
        duplicate: () => repeatWorkout(w.id),
        can: { copy: false, paste: false },
      };
    }),
  );

  render();
  cleanups.push(store.subscribe(render));
  cleanups.push(onDayChange(render));
  cleanups.push(() => sessionCtl?.destroy());
  return () => cleanups.forEach((off) => off());
}

/** For Home's Training widget: the data, its changes, and starting a workout; for Search: a
 *  logged workout's dialog (openWorkout: false when there is no such workout). */
export const trainingApi = Object.freeze({
  getState: () => getState(),
  subscribe: (fn) => store.subscribe(fn),
  startSession,
  openWorkout: (id) => {
    const w = getState().workouts.find((x) => x.id === id);
    if (!w) return false;
    openEditor(w);
    return true;
  },
});

/* ---- Rename (right-click menus) ---- */

async function renameWorkout(id) {
  const w = getState().workouts.find((x) => x.id === id);
  if (!w) return;
  const title = await promptDialog({ title: 'Rename workout', value: w.title, maxLength: TITLE_MAX });
  if (title === null) return;
  const cur = getState();
  commit({ ...cur, workouts: cur.workouts.map((x) => (x.id === id ? { ...x, title: cleanTitle(title).slice(0, TITLE_MAX), updatedAt: Date.now() } : x)) });
}

async function renameRoutine(id) {
  const r = getState().routines.find((x) => x.id === id);
  if (!r) return;
  const name = await promptDialog({
    title: 'Rename routine',
    value: r.name,
    maxLength: NAME_MAX,
    validate: (text) => (getState().routines.some((x) => x.id !== id && x.name.toLowerCase() === text.toLowerCase()) ? `There is already a routine called “${text}”.` : null),
  });
  if (name === null) return;
  const cur = getState();
  commit({ ...cur, routines: cur.routines.map((x) => (x.id === id ? { ...x, name: cleanTitle(name).slice(0, NAME_MAX), updatedAt: Date.now() } : x)) });
}

/** The nav shows only what's going on now: a dot while a workout is live (C6). */
function badge() {
  return getState().session ? '●' : '';
}

export default {
  id: 'training',
  title: 'Training',
  icon: 'dumbbell',
  badge,
  // The dot in words, in the links' names: "Training (workout in progress)"
  badgeLabel: 'workout in progress',
  mount,
  topbar: mountLivePill,
};
