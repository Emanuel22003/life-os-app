// LIFE/OS — Health: your weight. One weight a day, typed in kg or lb (always kept in kg), a graph
// of the daily weights with a smoothed trend line (and your goal, dashed), the changes over 7, 30
// and 90 days, the lowest and highest, and every weight by month. Pure rules live in
// health.logic.js; store 'health' (synced, except view: the graph's range stays on this device).
//
// Neutral by design: a change is a signed number, never colored or worded as good or bad, and a
// goal can point either way.

import { h, icon, registerIcon, pageHeader, emptyState, dismissTip, toast, openModal, todayKey, formatDay, diffDays, shiftKey, onDayChange, isTyping, modalOpen, menuOpen, uid, plural, clamp, WEEKDAYS_SHORT } from '../ui.js';
import { createStore, settings } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import * as H from './health.logic.js';
import { normalizeUnits, weightUnitFor } from '../formats.js';

// The heart (the page's icon) is registered by the shell (js/app.js); this is a bathroom scale,
// for the empty page and Home's Weight widget
registerIcon('hl-scale', '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M7.5 11a4.5 4.5 0 0 1 9 0"/><path d="M12 11l1.6-2.4"/>');

const TIP_ID = 'health.weight';
// The history shows this many weights at first; "Show older" adds more
const ROWS_STEP = 45;

/* ==========================================================================
   Store
   ========================================================================== */

const store = createStore('health', H.DEFAULT_STATE);
let cacheRaw = null;
let cacheState = null;

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    // (no unit chosen yet: this device's units, Settings → Dates & units; kg by default)
    cacheState = H.normalizeState(raw, { defaultUnit: weightUnitFor(settings.get().units) });
  }
  return cacheState;
}

function commit(next) {
  cacheRaw = next;
  cacheState = next;
  store.set(next);
}

const findWeight = (id) => getState().weights.find((w) => w.id === id) ?? null;

function setWeights(weights) {
  const s = getState();
  if (weights !== s.weights) commit({ ...s, weights });
}

function setView(patch) {
  const s = getState();
  if (Object.keys(patch).every((k) => s.view[k] === patch[k])) return;
  commit({ ...s, view: { ...s.view, ...patch } });
}

/** kg or lb: how every weight is shown and typed (synced, so the phone shows the same). */
function setUnit(unit) {
  const s = getState();
  const next = H.unitOf(unit);
  if (s.unit !== next) commit({ ...s, unit: next });
}

// Units changed (Settings → Dates & units, or the first run's Your formats): weights follow
// (kg for Metric, lb for US). The kg / lb switch on the page changes Health alone.
let unitsSeen = normalizeUnits(settings.get().units);
settings.subscribe((s) => {
  const units = normalizeUnits(s.units);
  if (units === unitsSeen) return;
  unitsSeen = units;
  setUnit(weightUnitFor(units));
});

function setGoal(goal) {
  commit({ ...getState(), goal });
}

/* ==========================================================================
   Words and small builders
   ========================================================================== */

const unitNow = () => getState().unit;
const wt = (kg) => H.weightText(kg, unitNow());
const dayWords = (date) => (date === todayKey() ? 'today' : formatDay(date));

/** 'Today' · 'Yesterday' · 'Mon 26' within a month's list */
function dayShort(date, today) {
  const n = diffDays(date, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  return `${WEEKDAYS_SHORT[new Date(`${date}T12:00`).getDay()]} ${Number(date.slice(8))}`;
}

/** A choice of buttons (aria-pressed), as Finance draws its ranges. */
function seg(label, options, value, onChange, className) {
  const buttons = options.map((o) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(o.value === value), 'aria-label': o.aria ?? null, dataset: o.focus ? { value: o.value, hlFocus: o.focus } : { value: o.value }, onClick: () => onChange(o.value) }, o.label));
  const el = h('div', { class: ['seg', className], role: 'group', 'aria-label': label }, buttons);
  return { el, set: (v) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v))) };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/* ==========================================================================
   Page
   ========================================================================== */

// Search's "Log weight" and Home's widget: put the keyboard in the weight field once the page is up
let pendingAdd = false;

function mount(root) {
  root.classList.add('hl-root');
  const cleanups = [];

  const goalBtn = h(
    'button',
    { type: 'button', class: 'btn hl-goal-btn', onClick: () => openGoalEditor() },
    icon('flag', { size: 14 }),
    h('span', null, 'Goal'),
  );
  const header = pageHeader({
    index: '10',
    title: 'Health',
    subtitle: 'Log your weight, one a day. The graph’s trend line evens out the day-to-day ups and downs, so one morning matters less.',
    tipId: TIP_ID,
    actions: [goalBtn],
  });
  goalBtn.title = 'Set, change or clear a goal weight';
  goalBtn.setAttribute('aria-label', 'Goal weight');
  const qa = quickAdd();
  const bodyEl = h('div', { class: 'hl-body' });
  const later = h('p', { class: 'hl-later' }, 'Weight only, for now. Ideas for later, not a promise: sleep, water, steps and mood.');
  root.append(header, qa.el, bodyEl, later);

  let chart = null;
  let rowsLimit = ROWS_STEP;

  /** Where the keyboard was, so a redraw puts it back (a deleted row: the one now in its place). */
  function focusKey() {
    const a = document.activeElement;
    if (!a || !bodyEl.contains(a)) return null;
    const keyed = a.closest('[data-hl-focus]');
    if (keyed) return { sel: `[data-hl-focus="${CSS.escape(keyed.dataset.hlFocus)}"]` };
    const row = a.closest('[data-id]');
    if (row) return { sel: `.hl-row[data-id="${CSS.escape(row.dataset.id)}"]`, at: [...bodyEl.querySelectorAll('.hl-row')].indexOf(row) };
    if (a.closest('.hl-ch')) return { sel: '.hl-ch' };
    return null;
  }

  function restoreFocus(key) {
    if (!key) return;
    let el = bodyEl.querySelector(key.sel);
    if (!el && key.at != null) {
      const rows = bodyEl.querySelectorAll('.hl-row');
      el = rows[Math.min(key.at, rows.length - 1)] ?? null;
    }
    el?.focus({ preventScroll: true });
  }

  function render() {
    const s = getState();
    const today = todayKey();
    const focus = focusKey();
    chart?.destroy();
    chart = null;
    header.setStat(H.statusText(s));
    qa.update(s, today);
    if (!s.weights.length) {
      const empty = emptyState({
        icon: 'hl-scale',
        title: 'No weights yet',
        text: 'Type your weight above and press Enter. Once a day is plenty: the graph draws a smoothed trend, so a heavy or a light morning matters less.',
      });
      empty.classList.add('hl-empty');
      bodyEl.replaceChildren(empty);
      return;
    }
    const series = H.trendSeries(s.weights);
    bodyEl.replaceChildren(
      h('div', { class: 'hl-main' }, chartPanel(s, series, today), historyPanel(s, today)),
      h('div', { class: 'hl-side' }, statsPanel(s, series, today)),
    );
    restoreFocus(focus);
  }

  /* ---- The graph: the range, the daily weights as dots, the trend, the goal ---- */

  function chartPanel(s, series, today) {
    const unit = s.unit;
    const range = H.RANGES.find((r) => r.id === s.view.range) ?? H.RANGES[1];
    const from = H.rangeStart(range.id, today, s.weights);
    const to = s.weights[s.weights.length - 1].date > today ? s.weights[s.weights.length - 1].date : today;
    const points = H.chartPoints(series, from, to, unit);
    const rangeSeg = seg(
      'Time range',
      H.RANGES.map((r) => ({ value: r.id, label: r.id === 'ALL' ? 'All' : r.id, aria: r.days ? `Last ${r.name}` : 'All time', focus: `range-${r.id}` })),
      range.id,
      (v) => setView({ range: v }),
      'hl-range-seg',
    );
    const when = range.days ? `the last ${range.name}` : `since ${formatDay(from)}`;
    const goalValue = s.goal ? H.toUnit(s.goal.kg, unit) : NaN;
    let plot;
    let goalWhere = null;
    if (points.length) {
      const fit = H.chartRange(points.flatMap((p) => [p.value, p.trend]), goalValue, { near: unit === 'lb' ? 4.4 : 2 });
      goalWhere = fit.goal;
      const scale = H.weightScale(fit.lo, fit.hi, { pad: unit === 'lb' ? 1 : 0.5 });
      const first = points[0];
      const last = points[points.length - 1];
      const label = `Weight, ${when}: ${plural(points.length, 'weight')}, from ${H.weightText(H.toKg(first.value, unit), unit)} on ${formatDay(first.date)} to ${H.weightText(H.toKg(last.value, unit), unit)} on ${formatDay(last.date)}`;
      chart = weightChart({ points, scale, n: diffDays(from, to) + 1, from, unit, goal: goalWhere === 'shown' ? goalValue : null, label });
      plot = chart.el;
    } else {
      plot = h('p', { class: 'hl-none' }, `No weights in ${when}. Pick a longer range.`);
    }
    const goalKey = s.goal
      ? h(
          'span',
          { class: 'hl-key-item' },
          h('span', { class: 'hl-key hl-key--goal' }),
          `Goal ${H.weightText(s.goal.kg, unit)}${goalWhere === 'below' ? ' (below this view)' : goalWhere === 'above' ? ' (above this view)' : ''}`,
        )
      : null;
    return h(
      'section',
      { class: 'panel hl-panel hl-ch-panel', 'aria-labelledby': 'hl-ch-title' },
      h('div', { class: 'panel-head hl-panel-head' }, h('h2', { class: 'hl-panel-title', id: 'hl-ch-title' }, 'Weight'), rangeSeg.el),
      plot,
      h(
        'p',
        { class: 'hl-ch-key' },
        h('span', { class: 'hl-key-item' }, h('span', { class: 'hl-key hl-key--dot' }), 'Daily weight'),
        h('span', { class: 'hl-key-item' }, h('span', { class: 'hl-key hl-key--line' }), 'Trend'),
        goalKey,
      ),
    );
  }

  /* ---- The numbers ---- */

  function statsPanel(s, series, today) {
    const unit = s.unit;
    const latest = series[series.length - 1];
    const range = H.RANGES.find((r) => r.id === s.view.range) ?? H.RANGES[1];
    const from = H.rangeStart(range.id, today, s.weights);
    const st = H.rangeStats(series, from, today > latest.date ? today : latest.date);
    const inRange = range.days ? range.name : 'all time';
    const tile = (label, value, sub = null, extra = {}) =>
      h('div', { class: ['hl-stat', extra.className] }, h('dt', { class: 'hl-stat-label' }, label), h('dd', { class: 'hl-stat-value stat-value' }, value), sub ? h('dd', { class: 'hl-stat-sub' }, sub) : null);
    const changes = H.CHANGE_SPANS.map((days) => {
      const c = H.trendChange(series, days);
      if (c?.full) return tile(`${days} days`, H.changeText(c.delta, unit), 'Change in the trend');
      return tile(`${days} days`, '—', series.length < 2 ? 'After a second weight' : `Not ${days} days yet`);
    });
    const progress = H.goalProgress(s.weights, s.goal);
    const goalTile = s.goal
      ? h(
          'div',
          { class: 'hl-stat hl-stat--goal' },
          h('dt', { class: 'hl-stat-label' }, 'Goal'),
          h(
            'dd',
            { class: 'hl-stat-value' },
            h(
              'button',
              { type: 'button', class: 'hl-goal-link stat-value', dataset: { hlFocus: 'goal' }, title: 'Change or clear the goal', 'aria-label': `Goal ${wt(s.goal.kg)}: ${H.goalText(progress, unit)}. Change or clear the goal`, onClick: () => openGoalEditor() },
              H.goalText(progress, unit),
            ),
          ),
          h('dd', { class: 'hl-stat-sub' }, `Goal ${wt(s.goal.kg)}`),
        )
      : null;
    return h(
      'section',
      { class: 'panel hl-panel hl-stats', 'aria-labelledby': 'hl-stats-title' },
      h('div', { class: 'panel-head hl-panel-head' }, h('h2', { class: 'hl-panel-title', id: 'hl-stats-title' }, 'Your numbers')),
      h(
        'dl',
        { class: 'hl-stat-list' },
        tile('Now', wt(latest.kg), latest.date === today ? 'Today' : formatDay(latest.date)),
        goalTile,
        ...changes,
        tile(`Lowest · ${inRange}`, st.low ? wt(st.low.kg) : '—', st.low ? formatDay(st.low.date) : 'No weights in this range'),
        tile(`Highest · ${inRange}`, st.high ? wt(st.high.kg) : '—', st.high ? formatDay(st.high.date) : 'No weights in this range'),
        tile('A week, on average', st.perWeek == null ? '—' : H.changeText(st.perWeek, unit), st.perWeek == null ? 'Needs a week of weights in this range' : `Trend, over ${inRange}`),
      ),
    );
  }

  /* ---- Every weight, newest first, by month ---- */

  function historyPanel(s, today) {
    const unit = s.unit;
    const months = H.historyMonths(s.weights);
    const count = s.weights.length;
    let left = rowsLimit;
    const blocks = [];
    for (const m of months) {
      if (left <= 0) break;
      const shown = m.items.slice(0, left);
      left -= shown.length;
      blocks.push(
        h(
          'section',
          { class: 'hl-month', 'aria-labelledby': `hl-m-${m.month}` },
          h('h3', { class: 'hl-month-head', id: `hl-m-${m.month}` }, H.monthName(m.month)),
          h('ul', { class: 'hl-rows', role: 'list' }, shown.map((r) => weightRow(r, unit, today))),
        ),
      );
    }
    return h(
      'section',
      { class: 'panel hl-panel hl-history', 'aria-labelledby': 'hl-history-title' },
      h('div', { class: 'panel-head hl-panel-head' }, h('h2', { class: 'hl-panel-title', id: 'hl-history-title' }, 'Every weight'), h('span', { class: 'hl-due' }, plural(count, 'weight'))),
      blocks,
      count > rowsLimit
        ? h(
            'button',
            {
              type: 'button',
              class: 'hl-more',
              dataset: { hlFocus: 'more' },
              onClick: () => {
                rowsLimit += ROWS_STEP * 2;
                render();
              },
            },
            icon('chevron-down', { size: 14 }),
            h('span', null, `Show older weights (${count - rowsLimit} more)`),
          )
        : null,
    );
  }

  // A weight's row: the day, the weight, the change from the one before it, the note
  function weightRow({ entry, change }, unit, today) {
    const open = () => openEditor(entry.id);
    const changeWords = change == null ? 'the first weight' : `${H.changeText(change, unit)} from the one before`;
    return h(
      'li',
      {
        class: 'hl-row',
        tabindex: '0',
        dataset: { id: entry.id },
        'aria-label': `${formatDay(entry.date, 'long')}: ${H.weightText(entry.kg, unit)}, ${changeWords}${entry.note ? `. ${entry.note}` : ''}. Enter to edit`,
        onClick: open,
        onKeydown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        },
      },
      h('span', { class: ['hl-row-date', entry.date === today && 'is-today'] }, dayShort(entry.date, today)),
      h('span', { class: 'hl-row-kg' }, H.weightText(entry.kg, unit)),
      h('span', { class: 'hl-row-change' }, change == null ? '' : H.changeText(change, unit)),
      entry.note ? h('span', { class: 'hl-row-note' }, entry.note) : h('span', { class: 'hl-row-note', 'aria-hidden': 'true' }),
    );
  }

  /* ---- Right-click (or a long press) on a weight: Edit…, Delete ---- */

  cleanups.push(
    registerContextProvider('health', (el) => {
      if (!root.contains(el)) return null;
      const row = el.closest('.hl-row[data-id]');
      const entry = row ? findWeight(row.dataset.id) : null;
      if (!entry) return null;
      return {
        kind: 'weight',
        id: entry.id,
        label: `Weight: ${wt(entry.kg)} on ${formatDay(entry.date)}`,
        el: row,
        edit: () => openEditor(entry.id),
        remove: () => deleteWeight(entry.id),
      };
    }),
  );

  // N: the weight field (like N for a new task)
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || menuOpen() || e.defaultPrevented) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      qa.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  render();
  cleanups.push(store.subscribe(render));
  cleanups.push(onDayChange(render));
  cleanups.push(() => chart?.destroy());
  if (pendingAdd) {
    pendingAdd = false;
    requestAnimationFrame(() => qa.focus());
  }
  return () => cleanups.forEach((off) => off());
}

/* ==========================================================================
   The quick add: a weight in one line (Enter adds), the unit beside it
   ========================================================================== */

function quickAdd() {
  const fid = (n) => `hl-qa-${n}`;
  const today0 = todayKey();
  let unitShown = unitNow();
  const weightIn = h('input', { id: fid('weight'), class: 'input hl-qa-weight', type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': fid('hint') });
  const unitSeg = seg('Unit', [{ value: 'kg', label: 'kg', aria: 'Kilograms' }, { value: 'lb', label: 'lb', aria: 'Pounds' }], unitShown, (v) => setUnit(v), 'hl-unit-seg');
  const dateIn = h('input', { id: fid('date'), class: 'input hl-qa-date', type: 'date', value: today0, max: today0, dataset: { today: today0 } });
  const noteIn = h('input', { id: fid('note'), class: 'input hl-qa-note', type: 'text', placeholder: 'After a run, new scale…', maxlength: String(H.NOTE_MAX), autocomplete: 'off', enterkeyhint: 'done' });
  const addLabel = h('span', null, 'Add');
  const addBtn = h('button', { type: 'submit', class: 'btn btn--primary hl-qa-add' }, icon('plus', { size: 14 }), addLabel);
  const hint = h('p', { class: 'hl-qa-hint', id: fid('hint'), 'aria-live': 'polite' });
  const err = h('p', { class: 'hl-qa-error', role: 'alert', hidden: true });

  // A day that has a weight already: say that adding replaces it (Undo in the message after)
  function paintHint() {
    const had = getState().weights.find((w) => w.date === dateIn.value);
    hint.textContent = had ? `${dayWords(dateIn.value) === 'today' ? 'Today' : formatDay(dateIn.value)} has ${wt(had.kg)}. Adding replaces it.` : '';
    hint.hidden = !had;
    addLabel.textContent = had ? 'Replace' : 'Add';
  }
  dateIn.addEventListener('input', paintHint);
  dateIn.addEventListener('change', paintHint);
  weightIn.addEventListener('input', () => {
    weightIn.removeAttribute('aria-invalid');
    err.hidden = true;
  });

  function add() {
    [dateIn, weightIn].forEach((x) => x.removeAttribute('aria-invalid'));
    err.hidden = true;
    const s = getState();
    const res = H.logWeight(s.weights, { date: dateIn.value, value: weightIn.value, note: noteIn.value }, { unit: s.unit, today: todayKey(), now: Date.now(), makeId: uid });
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      const field = res.field === 'date' ? dateIn : weightIn;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    setWeights(res.weights);
    dismissTip(TIP_ID);
    const { entry, previous } = res;
    const day = dayWords(entry.date);
    if (previous) {
      toast(`${day === 'today' ? 'Today' : day}: ${wt(entry.kg)} now (it was ${wt(previous.kg)}).`, {
        key: 'hl-log',
        action: { label: 'Undo', onClick: () => setWeights(H.restoreWeight(getState().weights, { ...previous, updatedAt: Date.now() })) },
      });
    } else {
      toast(`Logged ${wt(entry.kg)} for ${day}.`, {
        key: 'hl-log',
        action: { label: 'Undo', onClick: () => setWeights(getState().weights.filter((w) => w.id !== entry.id)) },
      });
    }
    weightIn.value = '';
    noteIn.value = '';
    // Back to today (a past day was a one-off; the next one would replace it)
    dateIn.value = todayKey();
    paintHint();
    weightIn.focus();
  }

  const el = h(
    'form',
    {
      class: 'panel hl-qa',
      'aria-label': 'Log a weight',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        add();
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input')) {
          e.preventDefault();
          add();
        }
      },
    },
    h(
      'div',
      { class: 'hl-qa-grid' },
      h('div', { class: 'field hl-qa-f-weight' }, h('label', { class: 'label', for: weightIn.id }, 'Weight'), h('div', { class: 'hl-qa-pair' }, weightIn, unitSeg.el)),
      h('div', { class: 'field hl-qa-f-date' }, h('label', { class: 'label', for: dateIn.id }, 'Day'), dateIn),
      h('div', { class: 'field hl-qa-f-note' }, h('label', { class: 'label', for: noteIn.id }, 'Note (if you like)'), noteIn),
      addBtn,
    ),
    hint,
    err,
  );

  /** The unit, the placeholder (the latest weight), the day (a new day moves it on), the hint. */
  function update(s, today) {
    unitSeg.set(s.unit);
    // A number typed before the unit changed is the same weight in the new unit
    if (s.unit !== unitShown) {
      const kg = H.parseWeight(weightIn.value, unitShown);
      if (Number.isFinite(kg) && weightIn.value.trim()) weightIn.value = H.numberText(kg, s.unit);
      unitShown = s.unit;
    }
    const latest = s.weights[s.weights.length - 1];
    weightIn.placeholder = latest ? H.numberText(latest.kg, s.unit) : s.unit === 'lb' ? '160.5' : '72.5';
    if (dateIn.value === dateIn.dataset.today && today !== dateIn.dataset.today) dateIn.value = today;
    dateIn.dataset.today = today;
    dateIn.max = today;
    paintHint();
  }

  return {
    el,
    update,
    focus: () => {
      weightIn.scrollIntoView?.({ block: 'nearest' });
      weightIn.focus();
    },
  };
}

/* ==========================================================================
   The graph: daily weights as dots, the trend as a line, the goal dashed
   ========================================================================== */

/**
 * points: chartPoints() (the unit shown), placed by day over `n` days from `from`. Hover, tap or
 * the arrow keys read a weight; nothing is colored by which way it went. -> { el, destroy }
 */
function weightChart({ points, scale, n, from, unit, goal, label }) {
  const H_ = 240;
  const pad = { l: 46, r: 16, t: 14, b: 26 };
  let W = 0;
  let xAt = () => 0;
  let yAt = () => 0;
  let dots = [];
  let cross = null;
  let active = null;

  const svg = sv('svg', { class: 'hl-ch-svg', 'aria-hidden': 'true', focusable: 'false' });
  const tipEl = h('div', { class: 'hl-ch-tip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const el = h('div', { class: 'hl-ch', tabindex: '0', role: 'group', 'aria-label': `${label}. Left and right arrow keys read each weight.` }, svg, tipEl, live);
  const kgOf = (v) => H.toKg(v, unit);

  const describe = (p) => [formatDay(p.date, 'long'), H.weightText(kgOf(p.value), unit), `Trend ${H.weightText(kgOf(p.trend), unit)}`, p.note || null].filter(Boolean);

  function draw(width) {
    W = Math.max(260, Math.round(width));
    const pw = W - pad.l - pad.r;
    const ph = H_ - pad.t - pad.b;
    xAt = (i) => pad.l + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
    yAt = (v) => pad.t + (1 - (v - scale.min) / (scale.max - scale.min || 1)) * ph;
    svg.setAttribute('viewBox', `0 0 ${W} ${H_}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H_);
    svg.replaceChildren();

    const grid = sv('g', { class: 'hl-ch-grid' });
    for (const t of scale.ticks) {
      const y = Math.round(yAt(t)) + 0.5;
      grid.append(sv('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }), sv('text', { class: 'hl-ch-axis', x: pad.l - 8, y: y + 4, 'text-anchor': 'end' }, H.tickText(t, scale.step)));
    }
    svg.append(grid);

    // The goal: a dashed line across, named at its right end
    if (goal != null) {
      const y = yAt(goal);
      svg.append(sv('line', { class: 'hl-ch-goal', x1: pad.l, x2: W - pad.r, y1: y.toFixed(1), y2: y.toFixed(1) }));
      const above = y - pad.t > 14;
      svg.append(sv('text', { class: 'hl-ch-goal-label', x: W - pad.r, y: (above ? y - 5 : y + 13).toFixed(1), 'text-anchor': 'end' }, 'Goal'));
    }

    // The first and last day on x, and the middle one when there is room
    const used = [];
    for (const i of n > 2 ? [0, n - 1, Math.floor((n - 1) / 2)] : n > 1 ? [0, n - 1] : [0]) {
      const x = xAt(i);
      if (used.some((u) => Math.abs(u - x) < 96)) continue;
      used.push(x);
      const anchor = n === 1 ? 'middle' : x < pad.l + 44 ? 'start' : x > W - pad.r - 44 ? 'end' : 'middle';
      svg.append(sv('text', { class: 'hl-ch-axis', x: anchor === 'start' ? pad.l : anchor === 'end' ? W - pad.r : x, y: H_ - 6, 'text-anchor': anchor }, formatDay(shiftKey(from, i))));
    }

    cross = sv('line', { class: 'hl-ch-cross', x1: 0, x2: 0, y1: pad.t, y2: pad.t + ph, visibility: 'hidden' });
    svg.append(cross);

    // The trend under the dots, so every weight stays in sight
    if (points.length > 1) svg.append(sv('path', { class: 'hl-ch-trend', d: points.map((p, j) => `${j ? 'L' : 'M'}${xAt(p.i).toFixed(1)} ${yAt(p.trend).toFixed(1)}`).join(' ') }));
    const r = points.length > 120 ? 2.25 : 3.25;
    const dotsG = sv('g', { class: 'hl-ch-dots' });
    dots = points.map((p) => {
      const c = sv('circle', { class: 'hl-ch-dot', cx: xAt(p.i).toFixed(1), cy: yAt(p.value).toFixed(1), r });
      dotsG.append(c);
      return c;
    });
    svg.append(dotsG);
    if (active != null) show(active);
  }

  const show = (j) => {
    active = clamp(j, 0, points.length - 1);
    const p = points[active];
    const x = xAt(p.i);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    dots.forEach((d, k) => d.classList.toggle('is-active', k === active));
    const lines = describe(p);
    tipEl.replaceChildren(...lines.map((t, k) => h('div', { class: k === 1 ? 'hl-ch-tip-main' : 'hl-ch-tip-sub' }, t)));
    tipEl.classList.add('is-on');
    const w = tipEl.offsetWidth;
    const left = x + 14 + w > el.clientWidth ? x - 14 - w : x + 14;
    tipEl.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${pad.t}px)`;
    live.textContent = lines.join('. ');
  };
  const hide = () => {
    active = null;
    cross?.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.classList.remove('is-active'));
    tipEl.classList.remove('is-on');
  };
  /** The weight nearest the pointer's x. */
  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    const x = ((clientX - rect.left) / rect.width) * W;
    let best = null;
    let dist = Infinity;
    points.forEach((p, j) => {
      const d = Math.abs(xAt(p.i) - x);
      if (d < dist) {
        dist = d;
        best = j;
      }
    });
    return best;
  };
  el.addEventListener('pointermove', (e) => {
    const j = nearest(e.clientX);
    if (j != null && j !== active) show(j);
  });
  // A tap shows the weight (and keeps it until the next tap or the focus leaves)
  el.addEventListener('pointerdown', (e) => {
    const j = nearest(e.clientX);
    if (j != null) show(j);
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  el.addEventListener('blur', hide);
  el.addEventListener('keydown', (e) => {
    let to = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') to = active == null ? points.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = points.length - 1;
    else if (e.key === 'Escape' && active != null) {
      e.stopPropagation();
      hide();
      return;
    }
    if (to == null) return;
    e.preventDefault();
    show(to);
  });

  draw(640);
  // Drawn at the plot's real width (again when it changes), so the labels keep their true size
  const ro = new ResizeObserver(([entry]) => {
    if (!el.isConnected) return;
    const width = entry.contentRect.width;
    if (width && Math.abs(Math.max(260, Math.round(width)) - W) > 1) draw(width);
  });
  ro.observe(el);
  return { el, destroy: () => ro.disconnect() };
}

/* ==========================================================================
   Edits with Undo, and the dialogs
   ========================================================================== */

function deleteWeight(id) {
  const res = H.removeWeight(getState().weights, id);
  if (!res.removed) return;
  setWeights(res.weights);
  const gone = res.removed;
  toast(`${wt(gone.kg)} on ${formatDay(gone.date)} deleted.`, {
    action: {
      label: 'Undo',
      onClick: () => {
        const now = getState().weights;
        // (a new weight logged for that day meanwhile stays)
        if (now.some((w) => w.date === gone.date)) return;
        setWeights(H.restoreWeight(now, gone));
      },
    },
  });
}

/** A dialog opened from a row hands the keyboard back to that row (redrawn meanwhile: its new copy). */
function backToRow(id) {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !a.closest('.modal-root')) return;
  document.querySelector(`.hl-root .hl-row[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function openEditor(id) {
  const existing = findWeight(id);
  if (!existing) return;
  const unit = unitNow();
  const today = todayKey();
  const n = `hl-ed-${uid()}`;
  const err = h('p', { class: 'hl-ed-error', role: 'alert', hidden: true });
  const dateIn = h('input', { id: `${n}-date`, class: 'input', type: 'date', value: existing.date, max: existing.date > today ? existing.date : today });
  const weightIn = h('input', { id: `${n}-weight`, class: 'input hl-ed-weight', type: 'text', inputmode: 'decimal', value: H.numberText(existing.kg, unit), autocomplete: 'off', enterkeyhint: 'done' });
  const noteIn = h('input', { id: `${n}-note`, class: 'input', type: 'text', value: existing.note, maxlength: String(H.NOTE_MAX), placeholder: 'After a run, new scale…', autocomplete: 'off', enterkeyhint: 'done' });

  function save() {
    [dateIn, weightIn].forEach((x) => x.removeAttribute('aria-invalid'));
    const s = getState();
    const res = H.editWeight(s.weights, id, { date: dateIn.value, value: weightIn.value, note: noteIn.value }, { unit: s.unit, today: todayKey(), now: Date.now() });
    if (res.error) {
      if (res.field === null) {
        m.close();
        toast(res.error);
        return;
      }
      err.textContent = res.error;
      err.hidden = false;
      const field = res.field === 'date' ? dateIn : weightIn;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    setWeights(res.weights);
    const before = res.previous;
    m.close();
    toast(`Saved: ${wt(res.entry.kg)} on ${formatDay(res.entry.date)}.`, {
      action: {
        label: 'Undo',
        onClick: () => {
          const now = getState().weights;
          if (!now.some((w) => w.id === id)) return;
          setWeights(H.restoreWeight(now.filter((w) => w.id !== id), { ...before, updatedAt: Date.now() }));
        },
      },
    });
  }

  const body = h(
    'div',
    {
      class: 'hl-ed',
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          save();
        }
      },
    },
    h('div', { class: 'hl-ed-grid' }, h('div', { class: 'field' }, h('label', { class: 'label', for: dateIn.id }, 'Day'), dateIn), h('div', { class: 'field' }, h('label', { class: 'label', for: weightIn.id }, `Weight (${unit})`), weightIn)),
    h('div', { class: 'field' }, h('label', { class: 'label', for: noteIn.id }, 'Note'), noteIn),
    err,
  );
  const footer = [
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--danger hl-ed-delete',
        onClick: () => {
          m.close();
          deleteWeight(id);
        },
      },
      icon('trash', { size: 14 }),
      'Delete',
    ),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), 'Save'),
  ];
  const m = openModal({ title: `Weight · ${formatDay(existing.date)}`, body, footer, className: 'hl-modal', initialFocus: weightIn, onClose: () => backToRow(id) });
}

/** The goal: a weight to aim for (either way), drawn as a dashed line; Clear takes it away (with Undo). */
function openGoalEditor() {
  const s = getState();
  const unit = s.unit;
  const n = `hl-goal-${uid()}`;
  const err = h('p', { class: 'hl-ed-error', role: 'alert', hidden: true });
  const latest = s.weights[s.weights.length - 1];
  const valueIn = h('input', { id: `${n}-kg`, class: 'input hl-ed-weight', type: 'text', inputmode: 'decimal', value: s.goal ? H.numberText(s.goal.kg, unit) : '', placeholder: latest ? H.numberText(latest.kg, unit) : unit === 'lb' ? '160.5' : '72.5', autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': `${n}-hint` });

  function save() {
    valueIn.removeAttribute('aria-invalid');
    const res = H.makeGoal(valueIn.value, { unit: getState().unit, now: Date.now() });
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      valueIn.setAttribute('aria-invalid', 'true');
      valueIn.focus();
      return;
    }
    const before = getState().goal;
    setGoal(res.goal);
    m.close();
    toast(`Goal: ${wt(res.goal.kg)}.`, { action: before ? { label: 'Undo', onClick: () => setGoal({ ...before, updatedAt: Date.now() }) } : { label: 'Undo', onClick: () => setGoal(null) } });
  }

  function clearGoal() {
    const before = getState().goal;
    if (!before) return;
    setGoal(null);
    m.close();
    toast('Goal cleared.', { action: { label: 'Undo', onClick: () => setGoal({ ...before, updatedAt: Date.now() }) } });
  }

  const body = h(
    'div',
    {
      class: 'hl-ed',
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target === valueIn) {
          e.preventDefault();
          save();
        }
      },
    },
    h('div', { class: 'field' }, h('label', { class: 'label', for: valueIn.id }, `Goal weight (${unit})`), valueIn, h('p', { class: 'hl-ed-hint', id: `${n}-hint` }, 'A weight to aim for, up or down. The graph draws it as a dashed line and Your numbers say how far it is.')),
    err,
  );
  const footer = [
    s.goal ? h('button', { type: 'button', class: 'btn btn--ghost hl-goal-clear', onClick: clearGoal }, icon('x', { size: 14 }), 'Clear goal') : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), 'Save'),
  ];
  // (cleared from the goal's own figure, which went with it: the keyboard lands on Goal at the top)
  const onClose = () => {
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected || a.classList.contains('lo-page')) document.querySelector('.hl-root .hl-goal-btn')?.focus({ preventScroll: true });
  };
  const m = openModal({ title: s.goal ? 'Your goal' : 'Set a goal', body, footer, className: 'hl-modal', initialFocus: valueIn, onClose });
}

/* ==========================================================================
   Feature
   ========================================================================== */

/** For Home's Weight widget and Search: the weights, their changes, and the way in. */
export const healthApi = Object.freeze({
  /** The whole state, normalized (treat as read-only). */
  state: () => getState(),
  subscribe: (fn) => store.subscribe(fn),
  /** The Health page's weight field in focus (the page opens first when it isn't shown). */
  focusAdd: () => {
    const field = document.querySelector('#main > .view[data-feature="health"] .hl-qa-weight');
    if (field) {
      field.scrollIntoView?.({ block: 'nearest' });
      field.focus();
      return true;
    }
    pendingAdd = true;
    location.hash = '#/health';
    return false;
  },
});

export default {
  id: 'health',
  title: 'Health',
  icon: 'heart',
  mount,
};
