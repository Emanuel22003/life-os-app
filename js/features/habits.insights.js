// LIFE/OS — 03 // Habits · INSIGHTS: productivity graphs.
//
// Every number comes from habits.stats.js, which reads each day against the
// plan that was in effect THAT day, so adding or re-planning a habit moves the
// graphs from that day on and never rewrites the past. This file only lays the
// numbers out: stat tiles, a hand-built responsive SVG of daily completion, a
// weekday profile and a habit ranking, each with a hover / keyboard readout and
// a table twin.
//
// Contract: mountInsights(container, source) -> cleanup
//   source = { getItems(), today(), subscribe(fn) -> unsub, openTab(name) }

import { h, icon, emptyState, formatDay, onDayChange, plural, idx, clamp, MONTHS_SHORT, WEEKDAYS_SHORT, plainSkin } from '../ui.js';
import { createStore } from '../store.js';
import * as L from './habits.logic.js';
import * as S from './habits.stats.js';

/* ==========================================================================
   Preferences — this tab's own store, separate from the habit data
   ========================================================================== */

const METRICS = [
  { id: 'pct', label: '%', name: 'Percent', title: 'Completion rate' },
  { id: 'count', label: 'Count', name: null, title: 'Habits done vs planned' },
];

const prefs = createStore('habits-insights', { range: '30d', metric: 'pct', table: false });

/** Axis and tile captions: 'SAT' in the readout templates, 'Sat' in Simple (sentence case throughout). */
const caps = (text) => (plainSkin() ? text : text.toUpperCase());
/** Day of the month on an axis: '07' or '7' (Simple), by the template's number rules. */
const dayNum = (key) => idx(Number(key.slice(8)));

function readPrefs() {
  const p = prefs.get() ?? {};
  return {
    range: S.RANGES.some((r) => r.id === p.range) ? p.range : '30d',
    metric: METRICS.some((m) => m.id === p.metric) ? p.metric : 'pct',
    table: p.table === true,
  };
}

function setPrefs(patch) {
  const prev = readPrefs();
  const next = { ...prev, ...patch };
  if (next.range !== prev.range || next.metric !== prev.metric || next.table !== prev.table) prefs.set(next);
}

/* ==========================================================================
   Constants & formatting
   ========================================================================== */

const COLUMN_MAX_POINTS = 31; // up to a month: one column per day; beyond: line + area
const WEEKLY_AFTER_DAYS = 120; // ALL longer than this is bucketed by week
const TREND_DAYS = 7;
const TREND_WEEKS = 4;
const COL_MAX_W = 24;
const COL_GAP = 2;
const CHAR_W = 6.6; // JetBrains Mono at 10px + 0.06em tracking: label collision math
const LIST_MAX = 4;
const NOTES_MAX = 3;

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RANGE_COPY = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', all: 'All time' };

let seq = 0;

const cls = (...names) => names.filter(Boolean).join(' ');
/** Whole percent that never rounds a miss up to 100 or a check-in down to 0. */
const pctNum = (rate) => (rate >= 1 ? 100 : rate <= 0 ? 0 : clamp(Math.round(rate * 100), 1, 99));
const pct = (rate) => (rate == null ? '—' : `${pctNum(rate)}%`);
const r1 = (n) => Math.round(n * 10) / 10;
const fx = (n) => Math.round(n * 100) / 100; // compact SVG coordinates
const crisp = (v) => Math.round(v) + 0.5; // 1px hairlines on the pixel grid
const monthOf = (key) => MONTHS_SHORT[Number(key.slice(5, 7)) - 1];
const habitsAvg = (n) => plural(r1(n), 'habit');
const hasChange = (p) => p.added.length > 0 || p.planChanged.length > 0 || p.archived.length > 0;

/** '5 Sep' — with the year only when it differs from `refKey`'s. */
function shortDate(key, refKey) {
  const year = key.slice(0, 4);
  return `${Number(key.slice(8, 10))} ${monthOf(key)}${year !== refKey.slice(0, 4) ? ` ${year}` : ''}`;
}

function listNames(names, max = LIST_MAX) {
  return names.length > max ? `${names.slice(0, max).join(', ')}, …` : names.join(', ');
}

/** 'Read ×3', 'Stretch' — a week's repeated names folded with a count, first-seen order. */
function foldNames(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
}

/** '+ Read added' / 'Δ Stretch re-planned' / '− Journal archived', capped. */
function changeNotes(p) {
  const uniq = (names) => [...new Set(names)];
  const notes = [
    ...uniq(p.added).map((n) => `+ ${n} added`),
    ...uniq(p.planChanged).map((n) => `Δ ${n} re-planned`),
    ...uniq(p.archived).map((n) => `− ${n} archived`),
  ];
  return notes.length > NOTES_MAX ? [...notes.slice(0, NOTES_MAX - 1), `+ ${notes.length - NOTES_MAX + 1} more changes`] : notes;
}

function focusVisible(el) {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/* ==========================================================================
   Chart data — one "point" shape for daily and weekly views
   ========================================================================== */

/**
 * Daily points for [from, to]. The series starts 6 days earlier so the 7-day
 * trend is already a full week on the first visible day.
 */
function dailyPoints(items, from, to, today, earliest) {
  const leadKey = L.fromDayNum(L.toDayNum(from) - (TREND_DAYS - 1));
  const lead = L.isValidKey(leadKey) ? leadKey : from;
  const ext = S.dailySeries(items, lead, to, today);
  const trend = S.rollingRate(ext, TREND_DAYS);
  const skip = L.toDayNum(from) - L.toDayNum(lead);
  return ext.slice(skip).map((d, i) => ({
    key: d.key,
    from: d.key,
    to: d.key,
    days: 1,
    weekly: false,
    planned: d.planned,
    done: d.done,
    bonus: d.bonus,
    rate: d.rate,
    pending: d.pending,
    rest: d.planned === 0,
    idle: d.active === 0,
    beforeStart: d.key < earliest,
    isToday: d.key === today,
    // no trend where no habit exists (e.g. after every habit was archived)
    trend: d.active === 0 ? null : trend[i + skip],
    added: d.added,
    planChanged: d.planChanged,
    archived: d.archived,
    missed: d.missed,
  }));
}

/**
 * Monday-start weekly points. `rate` follows bucketWeekly (pending today
 * excluded); planned / done are the week's live totals, today included.
 */
function weeklyPoints(items, from, to, today) {
  const series = S.dailySeries(items, from, to, today);
  const buckets = S.bucketWeekly(series);
  let k = 0;
  const points = buckets.map((b) => {
    let planned = 0;
    let done = 0;
    let active = 0;
    for (; k < series.length && series[k].key <= b.to; k++) {
      if (series[k].future) continue;
      planned += series[k].planned;
      done += series[k].done;
      active += series[k].active;
    }
    return {
      key: b.key,
      from: b.from,
      to: b.to,
      days: b.days,
      weekly: true,
      planned,
      done,
      bonus: b.bonus,
      // a week whose only planned day is a pending today still reads live
      rate: b.rate ?? (b.pending && planned ? done / planned : null),
      pending: b.pending,
      rest: planned === 0,
      idle: active === 0,
      beforeStart: false,
      isToday: false,
      trend: null,
      added: b.added,
      planChanged: b.planChanged,
      archived: b.archived,
      missed: b.missed,
    };
  });
  // 4-week trend from the buckets' measured sums
  points.forEach((p, i) => {
    let d = 0;
    let n = 0;
    for (let j = Math.max(0, i - TREND_WEEKS + 1); j <= i; j++) {
      d += buckets[j].done;
      n += buckets[j].planned;
    }
    p.trend = n && !p.idle ? d / n : null;
  });
  return points;
}

function bestWeekday(breakdown) {
  let best = null;
  for (const r of breakdown) {
    if (r.avgRate == null) continue;
    if (!best || r.avgRate > best.avgRate || (r.avgRate === best.avgRate && r.measured > best.measured)) best = r;
  }
  return best;
}

/* ==========================================================================
   SVG building blocks
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG twin of h(): attributes only, strings become text nodes. */
function sv(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== false && v !== '') el.setAttribute(k, String(v));
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** Column with a 4px rounded data-end and a square baseline. */
function columnPath(x, w, yTop, yBase) {
  const hgt = yBase - yTop;
  if (!(hgt > 0.25) || !(w > 0)) return null;
  const r = fx(Math.min(4, w / 2, hgt));
  return `M${fx(x)} ${fx(yBase)}V${fx(yTop + r)}A${r} ${r} 0 0 1 ${fx(x + r)} ${fx(yTop)}H${fx(x + w - r)}A${r} ${r} 0 0 1 ${fx(x + w)} ${fx(yTop + r)}V${fx(yBase)}Z`;
}

/** A column, or a 2px floor stub when the value is zero (measured, not a gap). */
function columnOrStub(x, w, yTop, yBase, pending) {
  const d = columnPath(x, w, yTop, yBase);
  return d
    ? sv('path', { class: cls('hbi-col', pending && 'is-pending'), d })
    : sv('rect', { class: cls('hbi-zero', pending && 'is-pending'), x: fx(x), y: yBase - 2, width: fx(w), height: 2 });
}

/** Faint tick through the baseline: a day with nothing planned (a gap, not a zero). */
function restTick(x, yBase) {
  return sv('line', { class: 'hbi-rest', x1: fx(x), x2: fx(x), y1: yBase - 3, y2: yBase + 3 });
}

/** Split [{x, y} | null] into runs of consecutive points; nulls are gaps. */
function runs(pts) {
  const out = [];
  let cur = null;
  for (const p of pts) {
    if (!p) {
      cur = null;
      continue;
    }
    if (!cur) out.push((cur = []));
    cur.push(p);
  }
  return out;
}

const linePath = (rs) =>
  rs
    .filter((r) => r.length > 1)
    .map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${fx(p.x)} ${fx(p.y)}`).join(''))
    .join('');

const areaPath = (rs, yBase) =>
  rs
    .filter((r) => r.length > 1)
    .map((r) => `M${fx(r[0].x)} ${fx(yBase)}${r.map((p) => `L${fx(p.x)} ${fx(p.y)}`).join('')}L${fx(r[r.length - 1].x)} ${fx(yBase)}Z`)
    .join('');

/** Stepped envelope: each point holds its value across its whole slot (p.l .. p.r). */
const stepPath = (rs) => rs.map((r) => r.map((p, i) => `${i ? `V${fx(p.y)}` : `M${fx(p.l)} ${fx(p.y)}`}H${fx(p.r)}`).join('')).join('');

const stepAreaPath = (rs, yBase) => rs.map((r) => `M${fx(r[0].l)} ${fx(yBase)}${r.map((p) => `V${fx(p.y)}H${fx(p.r)}`).join('')}V${fx(yBase)}Z`).join('');

/** Clean integer ticks from 0 to at least `max`, at most 6 of them. */
function countTicks(max) {
  const m = Math.max(1, Math.ceil(max));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => Math.ceil(m / s) <= 5) ?? Math.ceil(m / 5);
  const out = [];
  for (let t = 0; t <= Math.ceil(m / step) * step; t += step) out.push(t);
  return out;
}

/**
 * Indices of x labels that fit without colliding: a regular stride counted
 * back from the last point (today), always keeping the last and the first.
 * `calm` spaces dates ~36px apart; a week of weekday names keeps every one that fits.
 */
function pickLabels(n, slotW, widthOf, { gap = 8, calm = true } = {}) {
  if (n <= 0) return [];
  const fits = (i, j) => (j - i) * slotW >= (widthOf(i) + widthOf(j)) / 2 + gap;
  const step = calm ? Math.max(1, Math.ceil((3 * CHAR_W + 2 * gap) / slotW)) : 1;
  const kept = [n - 1];
  for (let i = n - 1 - step; i >= 0; i -= step) if (fits(i, kept[0])) kept.unshift(i);
  if (kept[0] !== 0) {
    // the first day joins the stride, or takes the place of a label at most half a stride away
    const near = kept.length > 1 && kept[0] * 2 <= step;
    if (!near && fits(0, kept[0])) kept.unshift(0);
    else if (kept.length > 1 && fits(0, kept[1])) kept[0] = 0;
  }
  return kept;
}

/** Horizontal gridlines + y tick labels (the zero line is drawn later as the baseline). */
function yAxis(geo, ticks, text) {
  const g = sv('g', { class: 'hbi-grid', 'aria-hidden': 'true' });
  for (const t of ticks) {
    const y = geo.yAt(t);
    if (t) g.append(sv('line', { x1: geo.left, x2: geo.W - geo.right, y1: crisp(y), y2: crisp(y) }));
    g.append(sv('text', { class: 'hbi-axis', x: geo.left - 8, y: fx(y), dy: '0.32em', 'text-anchor': 'end' }, text(t)));
  }
  return g;
}

function baseline(geo) {
  return sv('line', { class: 'hbi-baseline', x1: geo.left, x2: geo.W - geo.right, y1: crisp(geo.base), y2: crisp(geo.base) });
}

/** Two-line x labels ({ a, b, today }), nudged inside the svg at the edges. */
function xAxis(geo, labels, keep, y1, y2) {
  const g = sv('g', { class: 'hbi-xaxis', 'aria-hidden': 'true' });
  for (const i of keep) {
    const { a, b, today } = labels[i];
    const w = Math.max(a.length, (b ?? '').length) * CHAR_W;
    const x = fx(clamp(geo.xAt(i), w / 2, geo.W - w / 2));
    g.append(sv('text', { class: cls('hbi-axis', today && 'is-today'), x, y: y1, 'text-anchor': 'middle' }, a));
    if (b) g.append(sv('text', { class: 'hbi-axis hbi-axis--sub', x, y: y2, 'text-anchor': 'middle' }, b));
  }
  return g;
}

/** ▲ under the axis on days a habit was added, re-planned or archived. */
function changeMarkers(points, geo) {
  const g = sv('g', { class: 'hbi-markers', 'aria-hidden': 'true' });
  const half = Math.min(3.5, Math.max(2, geo.slotW / 2));
  points.forEach((p, i) => {
    if (!hasChange(p)) return;
    const x = geo.xAt(i);
    const y = geo.base + 6;
    g.append(sv('path', { class: 'hbi-marker', d: `M${fx(x - half)} ${y + 6}L${fx(x)} ${y}L${fx(x + half)} ${y + 6}Z` }));
  });
  return g;
}

/** Transparent hit layer: the whole slot column (plot, gap, markers, labels) is the target. */
function hitRect(geo) {
  return sv('rect', { class: 'hbi-hit', x: geo.left, y: 0, width: fx(Math.max(1, geo.W - geo.left - geo.right)), height: fx(geo.H) });
}

/* ==========================================================================
   Tooltip copy — shared by hover, keyboard (live region) and nothing else;
   every value is also in the table view
   ========================================================================== */

function pointInfo(p, c) {
  const date = p.weekly
    ? `Week of ${formatDay(p.from)}${p.days < 7 ? ` · ${plural(p.days, 'day')}` : ''}`
    : `${formatDay(p.key, 'long')}${p.isToday ? ' · Today' : ''}`;
  const changes = changeNotes(p);
  if (p.idle) {
    return { value: '—', sub: p.beforeStart ? 'Before tracking began' : 'No active habits', date, rows: [], notes: changes };
  }
  const bonus = p.bonus ? [`+${plural(p.bonus, 'bonus check-in')}`] : [];
  if (p.rest) {
    return { value: 'Rest', sub: p.weekly ? 'Rest week — nothing planned' : 'Rest day — nothing planned', date, rows: [], notes: [...bonus, ...changes] };
  }
  const isPct = c.metric === 'pct';
  const of = p.weekly ? `${p.done} of ${plural(p.planned, 'check-in')}` : `${p.done} of ${plural(p.planned, 'habit')}`;
  const notes = [];
  if (p.isToday && p.pending && c.remaining.length) notes.push(`To do: ${listNames(c.remaining)}`);
  if (p.missed.length) notes.push(`Missed: ${listNames(p.weekly ? foldNames(p.missed) : p.missed)}`);
  notes.push(...bonus, ...changes);
  return {
    value: isPct ? pct(p.rate) : `${p.done} / ${p.planned}`,
    sub: `${of}${p.pending ? ' · in progress' : ''}`,
    date,
    rows: isPct
      ? [
          { key: c.columns ? 'col' : 'line', label: p.weekly ? 'Weekly' : 'Daily', value: pct(p.rate) },
          { key: 'trend', label: p.weekly ? '4-week trend' : '7-day trend', value: pct(p.trend) },
        ]
      : [
          { key: c.columns ? 'col' : 'line', label: 'Done', value: String(p.done) },
          { key: 'planned', label: 'Planned', value: String(p.planned) },
        ],
    notes,
  };
}

function weekdayInfo(r) {
  const name = WEEKDAYS_LONG[r.weekday];
  const notes = [];
  if (r.measured) notes.push(`${r.done} of ${r.planned} done over ${plural(r.measured, name)}`);
  else if (r.avgPlanned) notes.push(`No finished ${name} yet`);
  return {
    value: r.avgRate != null ? pct(r.avgRate) : r.avgPlanned || !r.activeDays ? '—' : 'Rest',
    sub: r.avgPlanned ? `avg ${habitsAvg(r.avgPlanned)} planned` : r.activeDays ? 'Rest day — nothing planned' : 'No active habits yet',
    date: name,
    rows: [],
    notes,
  };
}

function tipNodes(info) {
  const nodes = [
    h('div', { class: 'hbi-tip-value' }, info.value),
    info.sub ? h('div', { class: 'hbi-tip-sub' }, info.sub) : null,
    h('div', { class: 'hbi-tip-date label' }, info.date),
    info.rows.length
      ? h(
          'div',
          { class: 'hbi-tip-rows' },
          info.rows.map((r) =>
            h('div', { class: 'hbi-tip-row' }, h('span', { class: `hbi-key hbi-key--${r.key}` }), h('span', { class: 'hbi-tip-name' }, r.label), h('span', { class: 'hbi-tip-num' }, r.value)),
          ),
        )
      : null,
    ...info.notes.map((t) => h('div', { class: 'hbi-tip-note' }, t)),
  ];
  return nodes.filter(Boolean);
}

function speakText(info) {
  const rows = info.rows.filter((r) => r.value !== info.value).map((r) => `${r.label} ${r.value}`);
  return [info.date, info.value, info.sub, ...rows, ...info.notes].filter(Boolean).join('. ');
}

/* ==========================================================================
   Interactive plot: svg + one tooltip + keyboard readout
   ========================================================================== */

/**
 * The plot owns hover, focus and keys; each render hands it a model:
 * { geo, count, initial, summary, highlight(i | null), info(i) }.
 */
function createPlot(label) {
  const svg = sv('svg', { class: 'hbi-svg', role: 'img', focusable: 'false' });
  const tip = h('div', { class: 'hbi-tip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const el = h('div', { class: 'hbi-plot', tabindex: '0', role: 'group', 'aria-label': `${label}. Use the left and right arrow keys to read each point.` }, svg, tip, live);
  let model = null;
  let active = null;
  let byKey = false;
  let scroller; // nearest scrolling ancestor, found on first use

  function findScroller() {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
    }
    return null;
  }

  /** Beside the slot (right, else left), at the plot's top, kept inside the visible viewport. */
  function place(i) {
    const { geo } = model;
    const rect = svg.getBoundingClientRect();
    const sx = rect.width ? rect.width / geo.W : 1;
    const x = geo.xAt(i) * sx;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const room = el.clientWidth;
    let left = x + 14;
    if (left + tw > room) left = x - 14 - tw;
    left = clamp(left, 0, Math.max(0, room - tw));
    if (scroller === undefined && el.isConnected) scroller = findScroller();
    // the visible band is the scroll area (the mobile tab bar sits below it), within the window
    const box = scroller?.getBoundingClientRect();
    const visibleTop = Math.max(0, box?.top ?? 0) + 8;
    const visibleBottom = Math.min(window.innerHeight, box?.bottom ?? Infinity) - 8;
    const minY = visibleTop - rect.top;
    const maxY = visibleBottom - th - rect.top;
    let y = geo.top * sx;
    if (y < minY) y = minY;
    if (y > maxY) y = Math.max(minY, maxY);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(y)}px)`;
  }

  function show(i) {
    if (!model?.count) return hide();
    active = clamp(i, 0, model.count - 1);
    tip.replaceChildren(...tipNodes(model.info(active)));
    tip.classList.add('is-on');
    place(active);
    model.highlight(active);
  }

  function hide() {
    active = null;
    tip.classList.remove('is-on');
    model?.highlight(null);
  }

  function onPointer(e) {
    if (!model?.count) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const x = (e.clientX - rect.left) * (model.geo.W / rect.width);
    const i = clamp(Math.floor((x - model.geo.left) / model.geo.slotW), 0, model.count - 1);
    byKey = false;
    if (i !== active) show(i);
  }

  function onKey(e) {
    const n = model?.count;
    if (!n || e.altKey || e.metaKey || e.ctrlKey) return;
    let i = active ?? model.initial ?? n - 1;
    if (e.key === 'ArrowLeft') i -= active == null ? 0 : 1;
    else if (e.key === 'ArrowRight') i += active == null ? 0 : 1;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'Escape' && active != null) {
      e.preventDefault();
      hide();
      return;
    } else return;
    e.preventDefault();
    byKey = true;
    show(i);
    live.textContent = speakText(model.info(active));
  }

  svg.addEventListener('pointermove', onPointer);
  svg.addEventListener('pointerdown', onPointer);
  svg.addEventListener('pointerleave', (e) => {
    // a lifted finger also "leaves"; touch readouts stay until focus moves away
    if (e.pointerType !== 'touch' && !byKey) hide();
  });
  el.addEventListener('keydown', onKey);
  el.addEventListener('focus', () => {
    if (!model?.count || !focusVisible(el)) return;
    byKey = true;
    show(active ?? model.initial ?? model.count - 1);
  });
  el.addEventListener('blur', () => {
    byKey = false;
    hide();
  });

  return {
    el,
    svg,
    width: () => el.clientWidth,
    set(next) {
      model = next;
      svg.setAttribute('viewBox', `0 0 ${next.geo.W} ${fx(next.geo.H)}`);
      svg.setAttribute('height', String(Math.ceil(next.geo.H)));
      svg.setAttribute('aria-label', next.summary);
      if (active == null) return;
      if (active < next.count) show(active);
      else hide();
    },
    reset() {
      byKey = false;
      hide();
    },
  };
}

/* ==========================================================================
   Mount
   ========================================================================== */

export function mountInsights(container, source) {
  let alive = true;
  let frame = 0;
  let dataDirty = true;
  let ctx = null;
  let entrance = true; // grow the marks on first draw and whenever a filter changes
  let viewKey = '';
  const drawn = { main: -1, day: -1 }; // widths the charts were last drawn at

  /* ---- Filter row: one row above everything it scopes ---- */

  const rangeBtns = S.RANGES.map((r) =>
    h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', title: RANGE_COPY[r.id], onClick: () => setPrefs({ range: r.id }) }, r.label),
  );
  const metricBtns = METRICS.map((m) =>
    h('button', { type: 'button', class: 'seg-btn hbi-metric-btn', 'aria-pressed': 'false', 'aria-label': m.name, title: m.title, onClick: () => setPrefs({ metric: m.id }) }, m.label),
  );
  const tableBtn = h(
    'button',
    { type: 'button', class: 'btn btn--sm hbi-table-btn', 'aria-pressed': 'false', title: 'Show the numbers as tables', onClick: () => setPrefs({ table: !readPrefs().table }) },
    icon('list', { size: 14 }),
    h('span', { class: 'hbi-table-btn-text' }, 'Table'),
  );
  const filters = h(
    'div',
    { class: 'hbi-filters' },
    h('div', { class: 'seg hbi-seg', role: 'group', 'aria-label': 'Date range' }, rangeBtns),
    h('div', { class: 'seg hbi-seg', role: 'group', 'aria-label': 'Measure' }, metricBtns),
    h('span', { class: 'spacer' }),
    tableBtn,
  );

  /* ---- Stat tiles ---- */

  function tile(label) {
    const value = h('div', { class: 'hbi-tile-value' });
    const sub = h('div', { class: 'hbi-tile-sub label' });
    const el = h('div', { class: 'panel hbi-tile' }, h('div', { class: 'hbi-tile-label label' }, label), value, sub);
    return { el, value, sub };
  }

  const tCompletion = tile('Completion');
  const tChange = tile('Change');
  const tCheckins = tile('Check-ins');
  const tBest = tile('Best weekday');
  const meterTicks = Array.from({ length: 20 }, () => h('span', { class: 'meter-tick' }));
  tCompletion.el.append(h('div', { class: 'meter hbi-tile-meter', 'aria-hidden': 'true' }, meterTicks));
  const tiles = h('div', { class: 'hbi-tiles' }, tCompletion.el, tChange.el, tCheckins.el, tBest.el);

  /* ---- Cards ---- */

  function card(index, title) {
    const id = `hbi-card-${++seq}`;
    const titleEl = h('span', null, title);
    const sub = h('span', { class: 'label hbi-card-sub' });
    const legend = h('div', { class: 'hbi-legend' });
    const body = h('div', { class: 'hbi-card-body' });
    const el = h(
      'section',
      { class: 'panel hud hbi-card', 'aria-labelledby': id },
      h(
        'header',
        { class: 'hbi-card-head' },
        h('div', { class: 'hbi-card-titles' }, h('h2', { class: 'hbi-card-title', id }, h('span', { class: 'hbi-card-index lo-deco', 'aria-hidden': 'true' }, index), titleEl), sub),
        legend,
      ),
      body,
    );
    return { el, titleEl, sub, legend, body };
  }

  const mainCard = card('01', 'Daily completion');
  const mainPlot = createPlot('Daily completion chart');
  const mainTable = h('div', { class: 'hbi-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Daily completion table', hidden: true });
  const note = h('p', { class: 'hbi-note', hidden: true }, icon('activity', { size: 14 }), h('span', null, 'Your graph fills in as you check off habits.'));
  mainCard.body.append(mainPlot.el, mainTable);
  mainCard.el.append(note);

  const dayCard = card('02', 'By weekday');
  const dayPlot = createPlot('Completion by weekday chart');
  const dayTable = h('div', { class: 'hbi-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Completion by weekday table', hidden: true });
  dayCard.body.append(dayPlot.el, dayTable);

  const rankCard = card('03', 'Habit ranking');
  const rankList = h('ol', { class: 'hbi-rank-list' });
  rankCard.body.append(
    h(
      'div',
      { class: 'hbi-rank' },
      h('div', { class: 'hbi-rank-head label', 'aria-hidden': 'true' }, h('span', null, '#'), h('span', null, 'Habit'), h('span', { class: 'hbi-num' }, 'Done'), h('span', null, 'Rate'), h('span', { class: 'hbi-num' }, 'Streak')),
      rankList,
    ),
  );

  const content = h('div', { class: 'hbi-content' }, tiles, mainCard.el, h('div', { class: 'hbi-split' }, dayCard.el, rankCard.el));
  const emptyWrap = h('div', { class: 'hbi-empty', hidden: true });
  const root = h('div', { class: 'hbi' }, filters, content, emptyWrap);
  container.append(root);

  /* ---- Data ---- */

  function compute() {
    const p = readPrefs();
    const raw = source.getItems?.();
    const items = (Array.isArray(raw) ? raw : []).filter((hb) => hb && L.isValidKey(hb.createdAt));
    if (!items.length) return { empty: true, prefs: p };
    const today = source.today();
    const { from, to, days } = S.rangeBounds(p.range, items, today);
    const earliest = items.reduce((m, hb) => (hb.createdAt < m ? hb.createdAt : m), items[0].createdAt);
    const weekly = p.range === 'all' && days > WEEKLY_AFTER_DAYS;
    const points = weekly ? weeklyPoints(items, from, to, today) : dailyPoints(items, from, to, today, earliest);
    const breakdown = S.weekdayBreakdown(items, from, to, today);
    return {
      empty: false,
      prefs: p,
      range: p.range,
      metric: p.metric,
      today,
      from,
      to,
      weekly,
      columns: !weekly && points.length <= COLUMN_MAX_POINTS,
      points,
      maxPlanned: points.reduce((m, pt) => Math.max(m, pt.planned), 1),
      cmp: S.compareToPrevious(items, from, to, today),
      breakdown,
      best: bestWeekday(breakdown),
      board: S.habitLeaderboard(items, from, to, today),
      remaining: L.habitsForDay(items, today)
        .filter((hb) => !hb.log?.[today])
        .map((hb) => hb.name),
    };
  }

  /* ---- Static parts (everything except the two SVGs) ---- */

  function paint(c) {
    rangeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(S.RANGES[i].id === c.prefs.range)));
    metricBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(METRICS[i].id === c.prefs.metric)));
    tableBtn.setAttribute('aria-pressed', String(c.prefs.table));

    filters.hidden = c.empty;
    content.hidden = c.empty;
    emptyWrap.hidden = !c.empty;
    if (c.empty) {
      mainPlot.reset();
      dayPlot.reset();
      if (!emptyWrap.firstChild) emptyWrap.append(buildEmpty());
      return;
    }

    paintTiles(c);
    paintHeads(c);
    rankList.replaceChildren(...c.board.map(rankRow));

    const table = c.prefs.table;
    mainPlot.el.hidden = table;
    dayPlot.el.hidden = table;
    mainTable.hidden = !table;
    dayTable.hidden = !table;
    if (table) {
      mainPlot.reset();
      dayPlot.reset();
      mainTable.replaceChildren(buildMainTable(c));
      dayTable.replaceChildren(buildDayTable(c));
    } else {
      mainTable.replaceChildren();
      dayTable.replaceChildren();
    }
    note.hidden = c.cmp.current.daysMeasured >= 2;
  }

  function bigValue(text, unit) {
    return unit ? [h('span', null, text), h('span', { class: 'hbi-tile-unit' }, unit)] : [h('span', null, text)];
  }

  function paintTiles(c) {
    const cur = c.cmp.current;
    const short = S.RANGES.find((r) => r.id === c.range)?.label ?? '';

    tCompletion.value.replaceChildren(...(cur.avgRate == null ? bigValue('—') : bigValue(String(pctNum(cur.avgRate)), '%')));
    tCompletion.sub.textContent = cur.planned ? `${cur.done} of ${cur.planned} planned` : 'Nothing measured yet';
    const lit = Math.round((cur.avgRate ?? 0) * meterTicks.length);
    meterTicks.forEach((t, i) => t.classList.toggle('is-on', i < lit));

    const delta = c.cmp.deltaPts;
    const v = delta == null ? null : Math.round(delta);
    if (v == null) {
      tChange.value.replaceChildren(...bigValue('—'));
    } else {
      const [glyph, word] = v > 0 ? ['▲', 'up'] : v < 0 ? ['▼', 'down'] : ['■', 'no change,'];
      tChange.value.replaceChildren(
        h('span', { class: 'hbi-dir', 'aria-hidden': 'true' }, glyph),
        h('span', { class: 'sr-only' }, `${word} `),
        ...bigValue(String(Math.abs(v)), 'pts'),
      );
    }
    tChange.el.classList.toggle('is-up', v > 0);
    tChange.el.classList.toggle('is-down', v < 0);
    tChange.sub.textContent = c.range === 'all' ? (v == null ? 'No earlier period' : 'vs prev period') : v == null ? `No data in prev ${short}` : `vs prev ${short}`;

    tCheckins.value.replaceChildren(...bigValue(cur.checkIns.toLocaleString()));
    tCheckins.sub.textContent = [plural(cur.perfectDays, 'perfect day'), cur.bonus ? `+${cur.bonus} bonus` : ''].filter(Boolean).join(' · ');

    const best = c.best;
    tBest.value.replaceChildren(...(best ? bigValue(caps(WEEKDAYS_SHORT[best.weekday]), `· ${pct(best.avgRate)}`) : bigValue('—')));
    tBest.sub.textContent = best ? `avg ${habitsAvg(best.avgPlanned)} planned` : 'Not enough data yet';
  }

  function legendItem(key, text) {
    return h('span', { class: 'hbi-legend-item' }, h('span', { class: `hbi-swatch hbi-swatch--${key}`, 'aria-hidden': 'true' }), text);
  }

  function mainTitle(c) {
    if (c.metric === 'pct') return c.weekly ? 'Weekly completion' : 'Daily completion';
    return c.weekly ? 'Done vs planned · weekly' : 'Done vs planned';
  }

  function paintHeads(c) {
    const isPct = c.metric === 'pct';
    mainCard.titleEl.textContent = mainTitle(c);
    mainCard.sub.textContent = `${RANGE_COPY[c.range]} · ${shortDate(c.from, c.to)} → ${shortDate(c.to, c.to)}${c.weekly ? ' · by week' : ''}`;
    mainCard.legend.hidden = c.prefs.table;
    // only series that are actually drawn (a brand-new account has no trend yet)
    const hasTrend = c.points.some((p) => p.trend != null);
    const legend = isPct
      ? [legendItem(c.columns ? 'col' : 'area', c.weekly ? 'Weekly' : 'Daily'), hasTrend && legendItem('trend', c.weekly ? '4-week trend' : '7-day trend')]
      : [legendItem(c.columns ? 'col' : 'line', 'Done'), legendItem(c.columns ? 'planned' : 'step', 'Planned')];
    if (c.points.some(hasChange)) legend.push(legendItem('marker', 'Habit change'));
    mainCard.legend.replaceChildren(...legend.filter(Boolean));
    dayCard.sub.textContent = `${RANGE_COPY[c.range]} · avg completion · habits planned per day`;
    rankCard.sub.textContent = `${RANGE_COPY[c.range]} · on planned days`;
  }

  /* ---- Main chart ---- */

  /** Axis labels per point; a week is labelled by its first day in range (p.from), not a Monday before it. */
  function mainLabels(c) {
    const { points, weekly } = c;
    const short = !weekly && points.length <= 7;
    const labels = points.map((p) => {
      if (p.isToday) return { a: caps('Today'), b: short ? dayNum(p.from) : null, today: true };
      if (short) return { a: caps(WEEKDAYS_SHORT[L.weekdayOfKey(p.from)]), b: dayNum(p.from) };
      return { a: dayNum(p.from), b: null };
    });
    return { labels, short };
  }

  /**
   * Second label line on longer ranges: the month where it changes. The weekly
   * (multi-month) view shows the year instead where the year changes; daily
   * ranges keep months, and the card subtitle carries the years.
   */
  function addMonths(points, labels, keep, weekly) {
    const multiYear = weekly && points[0].from.slice(0, 4) !== points[points.length - 1].from.slice(0, 4);
    let prev = null;
    for (const i of keep) {
      const key = points[i].from;
      if (multiYear && (!prev || prev.slice(0, 4) !== key.slice(0, 4))) labels[i].b = key.slice(0, 4);
      else if (!prev || prev.slice(0, 7) !== key.slice(0, 7)) labels[i].b = caps(monthOf(key));
      prev = key;
    }
  }

  function drawColumns(marks, band, points, geo, isPct) {
    const { xAt, yAt, base, slotW, left } = geo;
    const w = Math.min(COL_MAX_W, Math.max(1, slotW - COL_GAP));
    const slots = points.map((p, i) => {
      const slot = sv('g', { class: 'hbi-slot', style: `--i:${i}` });
      const x = xAt(i) - w / 2;
      if (p.idle) {
        // before the first habit / after every archive: nothing to draw
      } else if (p.rest) {
        slot.append(restTick(xAt(i), base));
      } else if (isPct) {
        slot.append(columnOrStub(x, w, yAt(p.rate * 100), base, p.pending));
      } else {
        const planned = columnPath(x, w, yAt(p.planned), base);
        const done = columnPath(x, w, yAt(p.done), base);
        if (planned) slot.append(sv('path', { class: 'hbi-col hbi-col--planned', d: planned }));
        if (done) slot.append(sv('path', { class: cls('hbi-col', p.pending && 'is-pending'), d: done }));
      }
      marks.append(slot);
      return slot;
    });
    return (i) => {
      marks.classList.toggle('has-hot', i != null);
      slots.forEach((s, j) => s.classList.toggle('is-hot', j === i));
      band.classList.toggle('is-on', i != null);
      if (i != null) band.setAttribute('x', fx(left + i * slotW));
    };
  }

  function drawLines(marks, dots, hover, points, geo, isPct) {
    const { xAt, yAt, base, top, left, slotW } = geo;
    const value = isPct ? (p) => (p.rest || p.rate == null ? null : p.rate * 100) : (p) => (p.rest ? null : p.done);
    const at = (i, v) => ({ x: xAt(i), y: yAt(v) });
    // Settled points only; an in-progress day/week is drawn separately, hollow
    const settled = points.map((p, i) => {
      const v = value(p);
      return v == null || p.pending ? null : at(i, v);
    });
    const rs = runs(settled);

    if (isPct) {
      marks.append(sv('path', { class: 'hbi-area', d: areaPath(rs, base) }));
    } else {
      const env = runs(points.map((p, i) => (p.rest ? null : { l: left + i * slotW, r: left + (i + 1) * slotW, y: yAt(p.planned) })));
      marks.append(sv('path', { class: 'hbi-area hbi-area--planned', d: stepAreaPath(env, base) }), sv('path', { class: 'hbi-line hbi-line--planned', d: stepPath(env), pathLength: 1 }));
    }
    marks.append(sv('path', { class: 'hbi-line', d: linePath(rs), pathLength: 1 }));
    for (const r of rs) if (r.length === 1) dots.append(sv('circle', { class: 'hbi-pt', cx: fx(r[0].x), cy: fx(r[0].y), r: 2.5 }));

    // The line ends on the last settled point. An in-progress day / week is a
    // hollow "so far" marker that is never joined to it, so an unfinished
    // morning cannot read as a plunge.
    const j = settled.findLastIndex(Boolean);
    if (j >= 0) dots.append(sv('circle', { class: 'hbi-dot', cx: fx(settled[j].x), cy: fx(settled[j].y), r: 4 }));
    const last = points.length - 1;
    const tailValue = points[last]?.pending ? value(points[last]) : null;
    if (tailValue != null) {
      const end = at(last, tailValue);
      dots.append(sv('circle', { class: 'hbi-dot hbi-dot--live', cx: fx(end.x), cy: fx(end.y), r: 4 }));
    }

    const series = isPct
      ? [
          { cls: 'hbi-dot hbi-dot--trend', v: (p) => (p.trend == null ? null : p.trend * 100) },
          { cls: 'hbi-dot', v: value },
        ]
      : [
          { cls: 'hbi-dot hbi-dot--planned', v: (p) => (p.rest ? null : p.planned) },
          { cls: 'hbi-dot', v: value },
        ];
    return (i) => {
      hover.replaceChildren();
      if (i == null) return;
      const x = xAt(i);
      hover.append(sv('line', { class: 'hbi-cross', x1: crisp(x), x2: crisp(x), y1: top, y2: base }));
      for (const s of series) {
        const v = s.v(points[i]);
        if (v != null) hover.append(sv('circle', { class: s.cls, cx: fx(x), cy: fx(yAt(v)), r: 4 }));
      }
    };
  }

  function drawTrend(marks, dots, points, geo, end) {
    const pts = points.map((p, i) => (p.trend == null ? null : { x: geo.xAt(i), y: geo.yAt(p.trend * 100) }));
    const d = linePath(runs(pts));
    // a surface-colored halo keeps the trend legible where it crosses columns
    marks.append(sv('path', { class: 'hbi-halo', d }), sv('path', { class: 'hbi-line hbi-line--trend', d, pathLength: 1 }));
    const e = pts[end];
    dots.append(sv('circle', { class: 'hbi-dot hbi-dot--trend', cx: fx(e.x), cy: fx(e.y), r: 4 }));
    marks.append(sv('text', { class: 'hbi-end', x: fx(geo.W - geo.right + 8), y: fx(e.y), dy: '0.32em' }, pct(points[end].trend)));
  }

  function mainSummary(c) {
    const cur = c.cmp.current;
    const span = RANGE_COPY[c.range].toLowerCase();
    if (c.metric === 'count') {
      return `${mainTitle(c)}, ${span}: ${plural(cur.checkIns, 'check-in')}; ${cur.done} of ${cur.planned} planned habits done on measured days.`;
    }
    const trend = c.points.findLast((p) => p.trend != null)?.trend;
    const parts = [`${mainTitle(c)}, ${span}: average ${pct(cur.avgRate)} over ${plural(cur.daysMeasured, 'measured day')}`];
    if (trend != null) parts.push(`${c.weekly ? '4-week' : '7-day'} trend ${pct(trend)}`);
    if (cur.bestDay) parts.push(`best day ${formatDay(cur.bestDay.key)} at ${pct(cur.bestDay.rate)}`);
    return `${parts.join('; ')}.`;
  }

  function drawMain(c, W, anim) {
    const { points, columns } = c;
    const isPct = c.metric === 'pct';
    const n = points.length;
    const plotH = W < 520 ? 160 : 210;
    const ticks = isPct ? (plotH >= 180 ? [0, 25, 50, 75, 100] : [0, 50, 100]) : countTicks(c.maxPlanned);
    const yMax = ticks[ticks.length - 1];
    const tickText = (t) => (isPct ? `${t}%` : String(t));
    const trendEnd = isPct ? points.findLastIndex((p) => p.trend != null) : -1;
    const left = Math.ceil(tickText(yMax).length * CHAR_W) + 10;
    const right = trendEnd >= 0 ? 44 : 14;
    const top = 10;
    const base = top + plotH;
    const slotW = Math.max(1, W - left - right) / Math.max(1, n);
    const geo = {
      W,
      H: base + 42, // marker band + two label lines live inside the svg
      left,
      right,
      top,
      base,
      slotW,
      xAt: (i) => left + (i + 0.5) * slotW,
      yAt: (v) => base - (clamp(v, 0, yMax) / yMax) * plotH,
    };

    const band = sv('rect', { class: 'hbi-band', x: left, y: top, width: fx(slotW), height: plotH });
    const marks = sv('g', { class: cls('hbi-marks', anim && 'is-entering') });
    const dots = sv('g', { class: 'hbi-dots' });
    const hover = sv('g', { class: 'hbi-hover', 'aria-hidden': 'true' });
    const highlight = columns ? drawColumns(marks, band, points, geo, isPct) : drawLines(marks, dots, hover, points, geo, isPct);
    if (trendEnd >= 0) drawTrend(marks, dots, points, geo, trendEnd);
    marks.append(dots);

    const { labels, short } = mainLabels(c);
    const keep = pickLabels(n, slotW, (i) => Math.max(labels[i].a.length, 3) * CHAR_W, { calm: !short });
    if (!short && n) addMonths(points, labels, keep, c.weekly);

    mainPlot.svg.replaceChildren(
      yAxis(geo, ticks, tickText),
      band,
      marks,
      baseline(geo),
      changeMarkers(points, geo),
      xAxis(geo, labels, keep, base + 25, base + 37),
      hover,
      hitRect(geo),
    );
    mainPlot.set({
      geo,
      count: n,
      initial: n - 1,
      summary: mainSummary(c),
      highlight,
      info: (i) => pointInfo(points[i], c),
    });
  }

  /* ---- Weekday chart ---- */

  function drawDay(c, W, anim) {
    const rows = c.breakdown;
    const n = rows.length;
    const plotH = W < 520 ? 110 : 140;
    const left = Math.ceil(4 * CHAR_W) + 10;
    const right = 8;
    const top = 18; // room for the best day's value above a full column
    const base = top + plotH;
    const slotW = Math.max(1, W - left - right) / Math.max(1, n);
    const geo = {
      W,
      H: base + 34,
      left,
      right,
      top,
      base,
      slotW,
      xAt: (i) => left + (i + 0.5) * slotW,
      yAt: (v) => base - (clamp(v, 0, 100) / 100) * plotH,
    };
    const w = Math.min(COL_MAX_W, Math.max(1, slotW - COL_GAP));
    const band = sv('rect', { class: 'hbi-band', x: left, y: top, width: fx(slotW), height: plotH });
    const marks = sv('g', { class: cls('hbi-marks', anim && 'is-entering') });
    const slots = rows.map((r, i) => {
      const slot = sv('g', { class: 'hbi-slot', style: `--i:${i}` });
      if (r.avgRate != null) slot.append(columnOrStub(geo.xAt(i) - w / 2, w, geo.yAt(r.avgRate * 100), base, false));
      else if (r.activeDays && !r.avgPlanned) slot.append(restTick(geo.xAt(i), base));
      marks.append(slot);
      return slot;
    });
    const best = c.best;
    if (best) {
      const i = rows.indexOf(best);
      marks.append(sv('text', { class: 'hbi-val', x: fx(geo.xAt(i)), y: fx(geo.yAt(best.avgRate * 100) - 7), 'text-anchor': 'middle' }, pct(best.avgRate)));
    }

    // "MON" over the average number of habits planned that weekday
    const todayWd = L.weekdayOfKey(c.today);
    const full = rows.map((r) => habitsAvg(r.avgPlanned));
    const compact = Math.max(...full.map((t) => t.length)) * CHAR_W > slotW - 4;
    const labels = rows.map((r, i) => ({ a: caps(WEEKDAYS_SHORT[r.weekday]), b: compact ? String(r1(r.avgPlanned)) : full[i], today: r.weekday === todayWd }));

    dayPlot.svg.replaceChildren(
      yAxis(geo, [0, 50, 100], (t) => `${t}%`),
      band,
      marks,
      baseline(geo),
      xAxis(geo, labels, rows.map((_, i) => i), base + 15, base + 28),
      hitRect(geo),
    );
    const summary = rows.map((r) => `${WEEKDAYS_SHORT[r.weekday]} ${pct(r.avgRate)}, ${habitsAvg(r.avgPlanned)}`).join('; ');
    dayPlot.set({
      geo,
      count: n,
      initial: Math.max(0, rows.findIndex((r) => r.weekday === todayWd)),
      summary: `Average completion by weekday, ${RANGE_COPY[c.range].toLowerCase()}: ${summary}.`,
      highlight: (i) => {
        marks.classList.toggle('has-hot', i != null);
        slots.forEach((s, j) => s.classList.toggle('is-hot', j === i));
        band.classList.toggle('is-on', i != null);
        if (i != null) band.setAttribute('x', fx(left + i * slotW));
      },
      info: (i) => weekdayInfo(rows[i]),
    });
  }

  /* ---- Tables (the accessible twin of each chart) ---- */

  function th(text, num) {
    return h('th', { scope: 'col', class: num ? 'hbi-num' : null }, text);
  }

  function buildMainTable(c) {
    const rows = [...c.points].reverse().filter((p) => !p.idle);
    const trendHead = h('abbr', { title: c.weekly ? '4-week trend' : '7-day trend' }, 'Trend');
    return h(
      'table',
      { class: 'hbi-table' },
      h('caption', { class: 'sr-only' }, `${mainTitle(c)}, ${RANGE_COPY[c.range].toLowerCase()}, newest first`),
      h('thead', null, h('tr', null, th(c.weekly ? 'Week of' : 'Date'), th('Planned', true), th('Done', true), th('Rate', true), th(trendHead, true))),
      h(
        'tbody',
        null,
        rows.map((p) =>
          h(
            'tr',
            { class: cls(p.rest && 'is-rest', p.pending && 'is-live') },
            h(
              'th',
              { scope: 'row' },
              formatDay(p.from),
              p.isToday ? h('span', { class: 'tag hbi-table-tag' }, 'Today') : null,
              hasChange(p) ? [h('span', { class: 'hbi-table-mark', title: changeNotes(p).join('\n'), 'aria-hidden': 'true' }, '▲'), h('span', { class: 'sr-only' }, `. ${changeNotes(p).join(', ')}`)] : null,
            ),
            h('td', { class: 'hbi-num' }, String(p.planned)),
            h('td', { class: 'hbi-num' }, String(p.done)),
            h('td', { class: 'hbi-num' }, p.rest ? 'Rest' : pct(p.rate), p.pending ? h('span', { class: 'sr-only' }, ' so far, in progress') : null),
            h('td', { class: 'hbi-num' }, pct(p.trend)),
          ),
        ),
      ),
    );
  }

  function buildDayTable(c) {
    return h(
      'table',
      { class: 'hbi-table' },
      h('caption', { class: 'sr-only' }, `Average completion by weekday, ${RANGE_COPY[c.range].toLowerCase()}`),
      h('thead', null, h('tr', null, th('Day'), th('Avg planned', true), th('Done', true), th('Rate', true))),
      h(
        'tbody',
        null,
        c.breakdown.map((r) =>
          h(
            'tr',
            { class: cls(r.avgRate == null && 'is-rest') },
            h('th', { scope: 'row' }, WEEKDAYS_LONG[r.weekday]),
            h('td', { class: 'hbi-num' }, String(r1(r.avgPlanned))),
            h('td', { class: 'hbi-num' }, r.planned ? `${r.done} / ${r.planned}` : '—'),
            h('td', { class: 'hbi-num' }, pct(r.avgRate)),
          ),
        ),
      ),
    );
  }

  /* ---- Habit ranking ---- */

  function rankRow(r, i) {
    const width = Math.round((r.rate ?? 0) * 100);
    return h(
      'li',
      { class: cls('hbi-rank-row', r.archived && 'is-archived') },
      h('span', { class: 'hbi-rank-pos', 'aria-hidden': 'true' }, idx(i + 1)),
      h(
        'span',
        { class: 'hbi-rank-name' },
        h('span', { class: 'hbi-rank-text', title: r.name }, r.name),
        r.archived ? h('span', { class: 'tag hbi-rank-tag' }, 'Archived') : null,
      ),
      h('span', { class: 'hbi-rank-count hbi-num' }, r.planned ? `${r.done}/${r.planned}` : '—', h('span', { class: 'sr-only' }, r.planned ? ' planned days done' : ' nothing planned in range')),
      h(
        'span',
        { class: 'hbi-rank-rate' },
        h('span', { class: 'hbi-rank-pct' }, pct(r.rate)),
        h('span', { class: 'progress hbi-rank-bar', 'aria-hidden': 'true' }, h('span', { class: 'progress-fill', style: { width: `${width}%` } })),
      ),
      h(
        'span',
        { class: cls('hbi-rank-streak', r.currentStreak > 0 && 'is-lit'), title: 'Current streak' },
        icon('flame', { size: 13 }),
        h('span', null, idx(r.currentStreak)),
        h('span', { class: 'sr-only' }, ` day streak`),
      ),
    );
  }

  /* ---- Empty state ---- */

  function buildEmpty() {
    return emptyState({
      icon: 'activity',
      title: 'No data to chart yet',
      text: 'Add habits and plan the days they run. Every check-off feeds these graphs, and they re-shape themselves as your habit set grows.',
      action: h('button', { type: 'button', class: 'btn btn--primary', onClick: () => source.openTab?.('plan') }, icon('calendar'), 'Plan your habits'),
    });
  }

  /* ---- Render loop ---- */

  function drawCharts() {
    if (!ctx || ctx.empty || ctx.prefs.table) return;
    const wm = Math.round(mainPlot.width());
    const wd = Math.round(dayPlot.width());
    let did = false;
    if (wm && wm !== drawn.main) {
      drawMain(ctx, wm, entrance);
      drawn.main = wm;
      did = true;
    }
    if (wd && wd !== drawn.day) {
      drawDay(ctx, wd, entrance);
      drawn.day = wd;
      did = true;
    }
    if (did) entrance = false;
  }

  function flush() {
    frame = 0;
    if (!alive) return;
    if (dataDirty) {
      dataDirty = false;
      ctx = compute();
      const key = ctx.empty ? 'empty' : `${ctx.prefs.range}|${ctx.prefs.metric}|${ctx.prefs.table}`;
      if (key !== viewKey) {
        viewKey = key;
        entrance = true;
      }
      paint(ctx);
      drawn.main = -1;
      drawn.day = -1;
    }
    drawCharts();
  }

  const queue = () => {
    if (alive && !frame) frame = requestAnimationFrame(flush);
  };
  const invalidate = () => {
    dataDirty = true;
    queue();
  };
  const onResize = () => {
    if (ctx && !ctx.empty && !ctx.prefs.table && (Math.round(mainPlot.width()) !== drawn.main || Math.round(dayPlot.width()) !== drawn.day)) queue();
  };

  flush();

  const unsubs = [source.subscribe?.(invalidate), prefs.subscribe(invalidate), onDayChange(invalidate)];
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(onResize);
    ro.observe(mainPlot.el);
    ro.observe(dayPlot.el);
  } else {
    window.addEventListener('resize', onResize);
  }

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    frame = 0;
    unsubs.forEach((off) => typeof off === 'function' && off());
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', onResize);
    root.remove();
  };
}
