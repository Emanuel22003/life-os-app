// LIFE/OS — 03 // Habits: the LIFE index. A trading-style chart pinned at the
// top of the Habits page and a compact live ticker in the app top bar.
// Every number comes from habits.stats.js (lifeIndexSeries, lifeQuote,
// bucketCandles, sma); this file only lays them out and handles interaction.
//
//   mountTradingChart(container, source) -> cleanup
//   mountTicker(slot, source) -> cleanup
//   source = { getItems(), today(), subscribe(fn) -> unsub, openTab(name) }

import { h, icon, registerIcon, openModal, onDayChange, uid, clamp, formatDay, WEEKDAYS_SHORT, MONTHS_SHORT } from '../ui.js';
import { createStore } from '../store.js';
import { toDayNum, fromDayNum, weekdayOfKey, isActiveOn, isArchived } from './habits.logic.js';
import * as S from './habits.stats.js';

registerIcon('hbt-line', '<path d="M3 17 8.5 11.5l4 3.5L21 6"/><path d="M3 21h18"/>');
registerIcon('hbt-candles', '<path d="M7 3v3M7 16v5M17 5v4M17 17v3"/><rect x="5" y="6" width="4" height="10" rx="1"/><rect x="15" y="9" width="4" height="8" rx="1"/>');
registerIcon('hbt-help', '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.6-2.4 2.2-2.4 3.7"/><path d="M12 17.2h.01"/>');

/* ==========================================================================
   Constants & preferences
   ========================================================================== */

const RANGES = Object.freeze([
  { id: '1W', days: 7, name: '1 week' },
  { id: '1M', days: 30, name: '1 month' },
  { id: '3M', days: 90, name: '3 months' },
  { id: '6M', days: 180, name: '6 months' },
  { id: '1Y', days: 365, name: '1 year' },
  { id: 'ALL', days: null, name: 'all time' },
]);

const TYPES = Object.freeze([
  { id: 'line', label: 'Line', icon: 'hbt-line' },
  { id: 'candles', label: 'Candles', icon: 'hbt-candles' },
]);

const MA_N = 20; // moving-average window, in periods of the shown interval
const MIN_SLOTS = 7; // a young index never stretches two points across the whole plot
const WEEKLY_OVER = 120; // long ranges switch to weekly candles past this many days
const SPARK_DAYS = 30;
const COMPACT_W = 560; // stage width below which the chart uses its phone geometry
const CHAR_W = 6.6; // advance of one 10px mono glyph incl. letter-spacing (pill sizing)

const prefs = createStore('habits-ticker', { range: '1M', type: 'line', collapsed: false });

function readPrefs() {
  const p = prefs.get() ?? {};
  return {
    range: RANGES.some((r) => r.id === p.range) ? p.range : '1M',
    type: TYPES.some((t) => t.id === p.type) ? p.type : 'line',
    collapsed: p.collapsed === true,
  };
}

/* ==========================================================================
   Data — one LIFE pass shared by the chart and the ticker
   ========================================================================== */

let memo = { items: null, today: null, daily: [], quote: null, activeToday: false, hasHabits: false };

/** Daily candles + latest quote, memoized on (items, today). */
function lifeData(source) {
  const items = source.getItems();
  const today = source.today();
  if (items !== memo.items || today !== memo.today) {
    const list = Array.isArray(items) ? items.filter((it) => it && typeof it === 'object') : [];
    const daily = S.lifeIndexSeries(list, today);
    memo = {
      items,
      today,
      daily,
      quote: S.lifeQuote(daily),
      // Nothing planned today reads as a rest day only while some habit exists today; else the market is closed
      activeToday: list.some((it) => isActiveOn(it, today)),
      hasHabits: list.some((it) => !isArchived(it, today)),
    };
  }
  return memo;
}

/** What the chart shows for a range: daily or weekly points, MA aligned with them. */
function viewModel({ daily, today }, { range, type }, plotW) {
  const r = RANGES.find((x) => x.id === range);
  const fromKey = r.days ? fromDayNum(toDayNum(today) - r.days + 1) : '';
  const start = Math.max(0, daily.findIndex((c) => c.key >= fromKey));
  const days = daily.length - start;
  const longRange = !r.days || r.days >= 365;
  // Long ranges go weekly past WEEKLY_OVER days; candles also go weekly once a daily body would be a hairline
  const weekly = (longRange && days > WEEKLY_OVER) || (type === 'candles' && days > 60 && plotW / days < 4);
  const series = weekly ? S.bucketCandles(daily, 'week') : daily;
  // MA over the whole history so the line is already defined at the window's left edge
  const ma = S.sma(series, MA_N);
  const from = weekly ? Math.max(0, series.findIndex((c) => c.to >= fromKey)) : start;
  return { range: r, weekly, candles: type === 'candles', points: series.slice(from), ma: ma.slice(from) };
}

/* ==========================================================================
   Formatting
   ========================================================================== */

const MINUS = '−';
const GLYPH = { up: '▲', down: '▼', flat: '■' };
const WORD = { up: 'up', down: 'down', flat: 'unchanged' };
const MON = MONTHS_SHORT.map((m) => m.toUpperCase());
const WD = WEEKDAYS_SHORT.map((d) => d.toUpperCase());

const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '--.--');
const dirOf = (change) => (!Number.isFinite(change) || Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down');

/** Direction, sign and magnitudes of a lifeQuote() change. */
function delta(q) {
  const dir = dirOf(q.change);
  const flat = dir === 'flat';
  return {
    dir,
    sign: dir === 'up' ? '+' : dir === 'down' ? MINUS : '',
    abs: flat ? 0 : Math.abs(q.change),
    pct: flat || q.changePct == null ? 0 : Math.abs(q.changePct),
  };
}

const moveWords = (d) => (d.dir === 'flat' ? 'unchanged' : `${WORD[d.dir]} ${d.abs.toFixed(2)}`);
const habitsWord = (n) => (n === 1 ? 'habit' : 'habits');

/** '04 OCT' */
const axisDate = (key) => `${key.slice(8)} ${MON[Number(key.slice(5, 7)) - 1]}`;
/** "OCT '26" — axis labels of ranges that span more than a year's worth of months */
const monthYear = (key) => `${MON[Number(key.slice(5, 7)) - 1]} '${key.slice(2, 4)}`;
const LONG_SPAN_DAYS = 300;

/** 'SUN 04 OCT' | 'TODAY' | 'WK 28 SEP' (+ " '25" outside the current year) */
function pointDate(p, weekly, today) {
  const year = p.key.slice(0, 4) !== today.slice(0, 4) ? ` '${p.key.slice(2, 4)}` : '';
  if (weekly) return `WK ${axisDate(p.key)}${year}`;
  if (p.key === today) return 'TODAY';
  return `${WD[weekdayOfKey(p.key)]} ${axisDate(p.key)}${year}`;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** Re-trigger the price flash (brighten + scale; dims on a drop). */
function flash(el, dir) {
  el.classList.remove('is-flash-up', 'is-flash-down');
  void el.offsetWidth;
  el.classList.add(dir === 'down' ? 'is-flash-down' : 'is-flash-up');
}

function flashable(el) {
  el.addEventListener('animationend', () => el.classList.remove('is-flash-up', 'is-flash-down'));
  return el;
}

/** Polite live region that speaks at most once per `ms` (trailing edge). */
function announcer(el, ms = 800) {
  let timer = 0;
  let next = '';
  const say = (text) => {
    next = text;
    if (!timer) {
      timer = setTimeout(() => {
        timer = 0;
        setText(el, next);
      }, ms);
    }
  };
  say.cancel = () => clearTimeout(timer);
  return say;
}

/* ==========================================================================
   SVG primitives
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Like h() for SVG: strings become text nodes, null/false children and attrs are skipped. */
function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    el.setAttribute(k, k === 'class' && Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** replaceChildren() minus skipped marks: the DOM would turn null / '' into stray text nodes. */
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c instanceof Node));
}

function attrs(el, values) {
  for (const [k, v] of Object.entries(values)) el.setAttribute(k, String(v));
}

const show = (el, on) => {
  el.style.display = on ? '' : 'none';
};
const r1 = (v) => Math.round(v * 10) / 10;
const crisp = (v) => Math.round(v) + 0.5; // centre a 1px hairline on a pixel row

/** Sparkline of closes into an existing <svg>; the last point is marked. */
function drawSpark(svg, closes, w, ht) {
  attrs(svg, { width: w, height: ht, viewBox: `0 0 ${w} ${ht}` });
  if (!closes.length) {
    fill(svg, s('line', { class: 'hbt-spark-flat', x1: 0, x2: w, y1: ht / 2, y2: ht / 2 }));
    return;
  }
  let lo = Math.min(...closes);
  let hi = Math.max(...closes);
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  const pad = 2.5;
  const n = closes.length;
  const x = (i) => (n === 1 ? w - pad : pad + (i / (n - 1)) * (w - 2 * pad));
  const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (ht - 2 * pad);
  const d = closes.map((v, i) => `${i ? 'L' : 'M'}${r1(x(i))},${r1(y(v))}`).join('');
  fill(
    svg,
    n > 1 ? s('path', { class: 'hbt-spark-line', d }) : null,
    s('circle', { class: 'hbt-spark-dot', cx: r1(x(n - 1)), cy: r1(y(closes[n - 1])), r: 2 }),
  );
}

/* ==========================================================================
   Chart geometry & scales
   ========================================================================== */

const axisWidth = (width) => (width < COMPACT_W ? 48 : 56);

/**
 * Price pane, volume pane (~22% of the chart) and an x-axis band, all inside
 * one SVG whose height includes the labels (no nested scrolling).
 * Points sit in equal slots; a young index fills the right-most slots.
 */
function layout(width, n) {
  const compact = width < COMPACT_W;
  const priceH = compact ? 170 : 220;
  const volH = Math.round(priceH * 0.28);
  const top = 14;
  const gap = 10;
  const axisW = axisWidth(width);
  const plotL = compact ? 2 : 6;
  const plotR = Math.max(plotL + 40, width - axisW);
  const priceBottom = top + priceH;
  const volTop = priceBottom + gap;
  const volBottom = volTop + volH;
  const slots = Math.max(n, MIN_SLOTS);
  return {
    width,
    height: volBottom + 26,
    compact,
    axisW,
    plotL,
    plotR,
    top,
    priceBottom,
    sepY: priceBottom + gap / 2,
    volTop,
    volBottom,
    slots,
    sw: (plotR - plotL) / slots,
    offset: slots - n,
  };
}

const xAt = (g, i) => g.plotL + (g.offset + i + 0.5) * g.sw;

/** Odd pixel widths keep a 1px wick centred on its body; capped at 12px with a 2px gap. */
function bodyWidth(sw) {
  const w = clamp(Math.min(sw * 0.66, sw - 2), 1, 12);
  return w < 3 ? Math.max(1, Math.round(w)) : 2 * Math.floor((w - 1) / 2) + 1;
}

/** 3–5 round ticks inside [lo, hi]; the step picks the label decimals. */
function niceTicks(lo, hi) {
  const span = hi - lo;
  const exp = Math.floor(Math.log10(span / 4));
  let best = null;
  for (let e = exp - 1; e <= exp + 1; e++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** e;
      const first = Math.ceil(lo / step - 1e-9) * step;
      const count = Math.floor((hi - first) / step + 1e-9) + 1;
      if (count < 3 || count > 5) continue;
      const score = Math.abs(count - 4);
      if (!best || score < best.score || (score === best.score && step > best.step)) best = { step, first, count, score };
    }
  }
  if (!best) best = { step: span / 2, first: lo, count: 3 };
  let decimals = 0;
  while (decimals < 2 && Math.abs(best.step * 10 ** decimals - Math.round(best.step * 10 ** decimals)) > 1e-6) decimals++;
  const ticks = [];
  for (let i = 0; i < best.count; i++) {
    const v = Number((best.first + i * best.step).toFixed(6));
    if (v >= 0 && v <= 100) ticks.push(v);
  }
  return { ticks, decimals };
}

/** Y scale auto-fitted to what is visible (closes or wicks, plus the MA) with padding. */
function priceScale(points, ma, candles, g) {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (v) => {
    if (!Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  take(points[0].open);
  for (const p of points) {
    if (candles) {
      take(p.low);
      take(p.high);
    } else {
      take(p.close);
    }
  }
  ma.forEach(take);
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = mid - 2;
    hi = mid + 2;
  }
  const pad = (hi - lo) * 0.12;
  lo = Math.max(0, lo - pad);
  hi = Math.min(100, hi + pad);
  const span = hi - lo;
  const ph = g.priceBottom - g.top;
  return {
    y: (v) => g.priceBottom - ((v - lo) / span) * ph,
    value: (y) => lo + ((g.priceBottom - y) / ph) * span,
    ...niceTicks(lo, hi),
  };
}

/* ==========================================================================
   Chart marks
   ========================================================================== */

function defs(ids) {
  return s(
    'defs',
    null,
    s('linearGradient', { id: ids.grad, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, class: 'hbt-stop-a' }), s('stop', { offset: 1, class: 'hbt-stop-b' })),
    s('pattern', { id: ids.hatch, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { class: 'hbt-hatch-ink', width: 1.5, height: 4 })),
  );
}

/** Pane separator, x-axis baseline, right price-axis rule, volume caption. */
function frame(g, volLabel = 'VOL') {
  return [
    s('line', { class: 'hbt-rule', x1: g.plotL, x2: g.width, y1: crisp(g.sepY), y2: crisp(g.sepY) }),
    s('line', { class: 'hbt-rule', x1: g.plotL, x2: g.width, y1: crisp(g.volBottom), y2: crisp(g.volBottom) }),
    s('line', { class: 'hbt-rule', x1: crisp(g.plotR), x2: crisp(g.plotR), y1: g.top - 8, y2: g.volBottom }),
    s('text', { class: 'hbt-tick', x: g.plotR + 7, y: g.volTop + 6, dy: '0.35em' }, volLabel),
  ];
}

/** Gridlines + right-axis tick labels (a label under the last-price tag is skipped). */
function grid(g, sc, tagY) {
  const out = [];
  for (const t of sc.ticks) {
    const y = sc.y(t);
    if (y < g.top - 0.5 || y > g.priceBottom + 0.5) continue;
    out.push(s('line', { class: 'hbt-grid', x1: g.plotL, x2: g.plotR, y1: crisp(y), y2: crisp(y) }));
    if (Math.abs(y - tagY) > 16) out.push(s('text', { class: 'hbt-tick', x: g.plotR + 7, y: r1(y), dy: '0.35em' }, t.toFixed(sc.decimals)));
  }
  return out;
}

/** Column with a 4px rounded data-end and a square baseline. */
function colPath(x, w, yTop, yBase) {
  const ht = yBase - yTop;
  if (ht <= 0) return '';
  const r = Math.min(4, w / 2, ht);
  return `M${x},${yBase}V${r1(yTop + r)}Q${x},${r1(yTop)} ${r1(x + r)},${r1(yTop)}H${r1(x + w - r)}Q${x + w},${r1(yTop)} ${x + w},${r1(yTop + r)}V${yBase}Z`;
}

const DENSE_SW = 8; // narrower slots aggregate the volume pane by calendar week (month for weekly points)

/**
 * Volume columns: one per point, or one per calendar week / month when daily
 * columns would be hairlines (per-weekday plans make daily volume spiky).
 * -> { cols: [{ i0, i1, x, w, planned, volume }], dense, y(n) }
 */
function volumeColumns(g, points, weekly) {
  const dense = g.sw < DENSE_SW;
  const groups = dense ? S.bucketCandles(points, weekly ? 'month' : 'week') : points.map((p) => ({ ...p, days: 1 }));
  const cols = [];
  let i0 = 0;
  for (const b of groups) {
    const i1 = i0 + b.days - 1;
    const span = (i1 - i0 + 1) * g.sw;
    const w = dense ? Math.max(1, Math.min(24, span - 2)) : bodyWidth(g.sw);
    const x = dense ? r1(g.plotL + (g.offset + i0) * g.sw + (span - w) / 2) : Math.round(xAt(g, i0)) - Math.floor(w / 2);
    cols.push({ i0, i1, x, w, planned: b.planned, volume: b.volume });
    i0 = i1 + 1;
  }
  let max = 1;
  for (const c of cols) if (c.planned > max) max = c.planned;
  const ph = (g.volBottom - g.volTop) * 0.9; // the busiest column fills 90% of the pane
  return { cols, dense, y: (n) => g.volBottom - (n / max) * ph };
}

/** Done in front of planned: capacity grows as habits are added; nothing planned = a gap. */
function volumeMarks(g, vol) {
  let plan = '';
  let done = '';
  for (const c of vol.cols) {
    if (!c.planned) continue;
    plan += colPath(c.x, c.w, vol.y(c.planned), g.volBottom);
    if (c.volume) done += colPath(c.x, c.w, vol.y(c.volume), g.volBottom);
  }
  return [plan && s('path', { class: 'hbt-vol-plan', d: plan }), done && s('path', { class: 'hbt-vol-done', d: done })];
}

/** Line vertices; a young index starts from the base price one slot before day one. */
function linePoints(g, sc, points) {
  const pts = points.map((p, i) => [r1(xAt(g, i)), r1(sc.y(p.close))]);
  if (g.offset) pts.unshift([r1(xAt(g, -1)), r1(sc.y(points[0].open))]);
  return pts;
}

const polyline = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');

/** Faint base-price line across the empty slots before the index existed. */
function prelisting(g, sc, first) {
  const y = crisp(sc.y(first.open));
  return s('path', { class: 'hbt-pre', d: `M${g.plotL},${y}H${r1(xAt(g, -1))}` });
}

function areaMark(g, sc, points, ids) {
  const pts = linePoints(g, sc, points);
  if (pts.length < 2) return null;
  const d = `${polyline(pts)}L${pts[pts.length - 1][0]},${g.priceBottom}L${pts[0][0]},${g.priceBottom}Z`;
  return s('path', { class: 'hbt-area', d, fill: `url(#${ids.grad})` });
}

function lineMarks(g, sc, points, pulse) {
  const pts = linePoints(g, sc, points);
  const [ex, ey] = pts[pts.length - 1];
  return [
    pts.length > 1 ? s('path', { class: 'hbt-line', d: polyline(pts) }) : null,
    pulse ? s('circle', { class: 'hbt-halo', cx: ex, cy: ey, r: 4 }) : null,
    s('circle', { class: 'hbt-end', cx: ex, cy: ey, r: 4 }),
  ];
}

/**
 * Monochrome OHLC: up = solid signal body, down = hollow outline, rest = flat tick,
 * live = hatched open body. Wicks stop at the body so hollow bodies stay hollow.
 */
function candleMarks(g, sc, points, ids) {
  const w = bodyWidth(g.sw);
  const thin = w < 3;
  const d = { wickUp: '', wickDown: '', up: '', down: '', downFill: '', rest: '' };
  const live = [];
  points.forEach((p, i) => {
    const cx = Math.round(xAt(g, i));
    const bx = cx - Math.floor(w / 2);
    if (p.rest) {
      d.rest += `M${bx},${crisp(sc.y(p.close))}h${w}`;
      return;
    }
    const yo = sc.y(p.open);
    const yc = sc.y(p.close);
    const top = Math.round(Math.min(yo, yc));
    const bh = Math.max(1, Math.round(Math.max(yo, yc)) - top);
    const up = p.close >= p.open;
    const wx = cx + 0.5;
    const wick = `M${wx},${r1(sc.y(p.high))}V${top}M${wx},${top + bh}V${r1(sc.y(p.low))}`;
    if (up || p.live) d.wickUp += wick;
    else d.wickDown += wick;
    const box = `M${bx},${top}h${w}v${bh}h${-w}Z`;
    if (p.live) live.push({ bx, top, bh });
    else if (up) d.up += box;
    else if (thin || bh < 3) d.downFill += box;
    else d.down += `M${bx + 0.5},${top + 0.5}h${w - 1}v${bh - 1}h${1 - w}Z`;
  });
  return [
    d.rest && s('path', { class: 'hbt-rest', d: d.rest }),
    d.wickDown && s('path', { class: 'hbt-wick-down', d: d.wickDown }),
    d.wickUp && s('path', { class: 'hbt-wick-up', d: d.wickUp }),
    d.down && s('path', { class: 'hbt-body-down', d: d.down }),
    d.downFill && s('path', { class: 'hbt-body-down-fill', d: d.downFill }),
    d.up && s('path', { class: 'hbt-body-up', d: d.up }),
    ...live.map(({ bx, top, bh }) =>
      thin
        ? s('rect', { class: 'hbt-body-up', x: bx, y: top, width: w, height: Math.max(bh, 2) })
        : s('rect', { class: 'hbt-body-live', x: bx + 0.5, y: top + 0.5, width: w - 1, height: Math.max(bh, 3) - 1, fill: `url(#${ids.hatch})` }),
    ),
  ];
}

/** MA as a thin reference line, broken where it is not defined yet. */
function maMark(g, sc, ma) {
  let d = '';
  let pen = false;
  ma.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${r1(xAt(g, i))},${r1(sc.y(v))}`;
    pen = true;
  });
  return d.includes('L') ? s('path', { class: 'hbt-ma', d }) : null;
}

/** Hairline at the current price + an inverted price tag on the right axis. */
function lastTag(g, price, y) {
  const yy = crisp(y);
  return [
    s('line', { class: 'hbt-last-line', x1: g.plotL, x2: g.plotR, y1: yy, y2: yy }),
    s(
      'g',
      { class: 'hbt-tag' },
      s('rect', { x: g.plotR + 2, y: r1(y - 8), width: g.axisW - 3, height: 16, rx: 2 }),
      s('text', { x: g.plotR + 7, y: r1(y), dy: '0.35em' }, fmt(price)),
    ),
  ];
}

/**
 * Thinned date labels that never collide; the latest (today) is always kept, the first when it fits.
 * Ranges longer than ~10 months switch to month + year so labels from different years never read alike.
 */
function xLabels(g, points, weekly, today) {
  const n = points.length;
  const longSpan = toDayNum(points[n - 1].key) - toDayNum(points[0].key) > LONG_SPAN_DAYS;
  const minGap = g.compact ? 64 : 76;
  const k = Math.max(1, Math.ceil(minGap / g.sw));
  const picks = [n - 1];
  for (let i = n - 1 - k; i * g.sw >= minGap; i -= k) picks.push(i);
  if (n > 1 && picks[picks.length - 1] * g.sw >= minGap) picks.push(0);
  const out = [];
  let prev = '';
  for (const i of picks) {
    const p = points[i];
    const isToday = !weekly && p.key === today;
    const text = isToday ? 'TODAY' : longSpan ? monthYear(p.key) : axisDate(p.key);
    if (text === prev) continue; // two picks in one month on a month-year axis
    prev = text;
    const half = (text.length * CHAR_W) / 2;
    const x = clamp(xAt(g, i), half + 1, g.width - half - 1);
    out.push(s('text', { class: ['hbt-xlabel', isToday && 'is-today'], x: r1(x), y: g.volBottom + 14, dy: '0.35em', 'text-anchor': 'middle' }, text));
  }
  return out;
}

/** Crosshair layer (hidden until a day is hovered or scrubbed); positioned per move. */
function crosshair(g) {
  const pillY = g.volBottom + 6;
  const parts = {
    hot: s('path', { class: 'hbt-vol-hot' }),
    v: s('line', { class: 'hbt-xh-line', y1: g.top - 8, y2: g.volBottom }),
    hl: s('line', { class: 'hbt-xh-line', x1: g.plotL, x2: g.plotR }),
    dot: s('circle', { class: 'hbt-xh-dot', r: 4 }),
    dateBg: s('rect', { class: 'hbt-pill-bg', y: pillY, height: 16, rx: 2 }),
    dateText: s('text', { class: 'hbt-pill-text', y: pillY + 8, dy: '0.35em', 'text-anchor': 'middle' }),
    priceBg: s('rect', { class: 'hbt-pill-bg', x: g.plotR + 2, width: g.axisW - 3, height: 16, rx: 2 }),
    priceText: s('text', { class: 'hbt-pill-text', x: g.plotR + 7, dy: '0.35em' }),
  };
  parts.grp = s('g', { class: 'hbt-xh' }, Object.values(parts));
  return parts;
}

/** Screen-reader summary of the visible range. */
function summary(model, data) {
  const { quote, activeToday } = data;
  const pts = model.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const extremes = S.lifeQuote(pts);
  const move = moveWords(delta({ change: last.close - first.open, changePct: null }));
  const interval = model.weekly ? (model.candles ? ' in weekly candles' : ', weekly') : '';
  const today = !quote.rest
    ? ` Today so far: ${quote.volume} of ${quote.planned} ${habitsWord(quote.planned)} done.`
    : activeToday
      ? ' Today is a rest day.'
      : ' No habit is active today.';
  return (
    `LIFE index, ${model.range.name}${interval}: ${fmt(last.close)}, ${move} from ${fmt(first.open)}. ` +
    `Lowest close ${fmt(extremes.allTimeLow)}, highest ${fmt(extremes.allTimeHigh)}.${today}`
  );
}

/* ==========================================================================
   Trading chart — pinned at the top of the Habits page
   ========================================================================== */

export function mountTradingChart(container, source) {
  let alive = true;
  let data = lifeData(source);
  let model = null; // view model of the current drawing (null when collapsed/empty)
  let geo = null;
  let scale = null;
  let vol = null;
  let xh = null;
  let tickLabels = [];
  let activeKey = null; // hovered/scrubbed point; null = live
  let pointerY = null; // mouse y for the horizontal hairline; null = snap to the close
  let scrubbing = false;
  let drawnWidth = 0;
  let maShown = false; // whether the MA line is on screen (its legend key follows)
  let raf = 0;
  let modal = null;
  const tag = uid().replace(/[^\w]/g, '').slice(0, 10);
  const ids = { body: `hbt-body-${tag}`, grad: `hbt-grad-${tag}`, hatch: `hbt-hatch-${tag}` };

  /* ---- DOM ---- */

  const priceEl = flashable(h('span', { class: 'hbt-price' }, '—'));
  const chgMain = h('span', { class: 'hbt-chg-main' });
  const chgPct = h('span', { class: 'hbt-chg-pct' });
  const chgEl = h('span', { class: 'hbt-chg', dataset: { dir: 'flat' } }, chgMain, chgPct);
  const statusText = h('span', { class: 'hbt-status-t' });
  const statusEl = h('span', { class: 'tag hbt-status' }, statusText);
  // 'Index · ' drops on phone widths (CSS) so the line never truncates; the interval follows the drawing
  const subInterval = h('span');
  const subEl = h('span', { class: 'hbt-sub label' }, h('span', { class: 'hbt-sub-k' }, 'Index · '), '0–100', subInterval);
  const stripSpark = s('svg', { class: 'hbt-strip-spark', 'aria-hidden': 'true', focusable: 'false' });

  const infoBtn = h(
    'button',
    { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hbt-info-btn', 'aria-label': 'About the LIFE index', title: 'About the LIFE index', onClick: openInfo },
    icon('hbt-help'),
  );
  const collapseBtn = h(
    'button',
    { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hbt-collapse', 'aria-controls': ids.body, onClick: () => prefs.update({ collapsed: !readPrefs().collapsed }) },
    icon('chevron-up'),
  );

  const head = h(
    'div',
    { class: 'hbt-head' },
    h(
      'div',
      { class: 'hbt-id' },
      h('span', { class: 'hbt-sym' }, 'LIFE'),
      h('div', { class: 'hbt-ident' }, h('span', { class: 'hbt-name' }, 'Habit Momentum Index'), subEl),
    ),
    h('div', { class: 'hbt-quote' }, priceEl, chgEl, statusEl),
    h('div', { class: 'hbt-strip' }, stripSpark),
    h('div', { class: 'hbt-actions' }, infoBtn, collapseBtn),
  );

  const cells = {};
  const cell = (key, label, sep = false) => {
    cells[key] = h('span', { class: 'hbt-ro-v' }, '—');
    return h('span', { class: ['hbt-ro', sep && 'is-sep'] }, h('span', { class: 'hbt-ro-k' }, label), cells[key]);
  };
  // Hidden while the MA has no line on screen (fewer than MA_N periods), like its legend key
  const maCell = cell('ma', `MA${MA_N}`);
  // Two unbreakable groups: on a narrow panel the readout wraps between them, never mid-group
  const readout = h(
    'div',
    { class: 'hbt-readout' },
    h('span', { class: 'hbt-ro-group' }, cell('o', 'O'), cell('h', 'H'), cell('l', 'L'), cell('c', 'C')),
    h('span', { class: 'hbt-ro-group is-extra' }, maCell, cell('vol', 'VOL', true)),
  );

  const rangeBtns = new Map(
    RANGES.map((r) => [
      r.id,
      h('button', { type: 'button', class: 'seg-btn', title: `Range: ${r.name}`, 'aria-pressed': 'false', onClick: () => prefs.update({ range: r.id }) }, r.id),
    ]),
  );
  const typeBtns = new Map(
    TYPES.map((t) => [
      t.id,
      h(
        'button',
        { type: 'button', class: 'seg-btn hbt-type', title: `${t.label} chart`, 'aria-pressed': 'false', onClick: () => prefs.update({ type: t.id }) },
        icon(t.icon, { size: 14 }),
        h('span', { class: 'hbt-type-label' }, t.label),
      ),
    ]),
  );
  const controls = h(
    'div',
    { class: 'hbt-controls' },
    h('div', { class: 'seg hbt-seg', role: 'group', 'aria-label': 'Chart range' }, [...rangeBtns.values()]),
    h('div', { class: 'seg hbt-seg', role: 'group', 'aria-label': 'Chart type' }, [...typeBtns.values()]),
  );

  const svg = s('svg', { class: 'hbt-svg', role: 'img', 'aria-label': 'LIFE index chart' });
  const closedText = h('p', { class: 'hbt-closed-t' });
  const closedAction = h('span');
  const closedEl = h(
    'div',
    { class: 'hbt-closed', hidden: true },
    h(
      'div',
      { class: 'hbt-closed-card' },
      h('span', { class: 'label hbt-closed-k' }, 'Market closed'),
      closedText,
      h('button', { type: 'button', class: 'btn btn--sm btn--primary', onClick: () => source.openTab('plan') }, icon('calendar'), closedAction),
    ),
  );
  const stage = h(
    'div',
    {
      class: 'hbt-stage',
      tabindex: '0',
      role: 'group',
      'aria-roledescription': 'chart',
      'aria-label': 'LIFE index chart. Left and right arrow keys move through days, Home and End jump, Escape returns to today.',
    },
    svg,
    closedEl,
  );

  const legend = h('div', { class: 'hbt-legend' });
  const note = h('span', { class: 'hbt-note label' });
  const srLive = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const announce = announcer(srLive);

  const body = h('div', { class: 'hbt-body', id: ids.body }, h('div', { class: 'hbt-bar' }, readout, controls), stage, h('div', { class: 'hbt-foot' }, legend, note));
  const root = h('section', { class: 'hbt-chart panel hud', 'aria-label': 'LIFE index' }, head, body, srLive);
  container.append(root);

  /* ---- Render ---- */

  function syncControls(p) {
    rangeBtns.forEach((btn, id) => btn.setAttribute('aria-pressed', String(id === p.range)));
    typeBtns.forEach((btn, id) => btn.setAttribute('aria-pressed', String(id === p.type)));
    const label = p.collapsed ? 'Expand LIFE chart' : 'Collapse LIFE chart';
    collapseBtn.setAttribute('aria-expanded', String(!p.collapsed));
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.title = label;
  }

  function render() {
    if (!alive) return;
    const p = readPrefs();
    const empty = !data.daily.length;
    syncControls(p);
    root.classList.toggle('is-empty', empty);
    root.classList.toggle('is-collapsed', p.collapsed);
    body.hidden = p.collapsed;
    stage.tabIndex = empty ? -1 : 0; // nothing to scrub while the market is closed
    renderNote();

    if (p.collapsed) {
      model = null;
      xh = null;
      tickLabels = [];
      activeKey = null;
      drawSpark(stripSpark, data.daily.slice(-SPARK_DAYS).map((c) => c.close), 88, 24);
    } else {
      const width = Math.round(stage.clientWidth);
      if (width) {
        drawnWidth = width;
        closedEl.hidden = !empty;
        if (empty) drawClosed(width);
        else drawMarket(width, p);
        stage.classList.add('is-drawn');
      }
    }
    renderLegend(p.type, maShown);
    updateReadout();
    drawCrosshair();
  }

  function drawMarket(width, p) {
    const m = viewModel(data, p, width - axisWidth(width));
    const g = layout(width, m.points.length);
    const sc = priceScale(m.points, m.ma, m.candles, g);
    const v = volumeColumns(g, m.points, m.weekly);
    const q = data.quote;
    const tagY = clamp(sc.y(q.price), g.top, g.priceBottom);
    const gridNodes = grid(g, sc, tagY);
    const maNode = maMark(g, sc, m.ma);
    tickLabels = gridNodes.filter((el) => el.localName === 'text').map((el) => ({ el, y: Number(el.getAttribute('y')) }));
    xh = crosshair(g);
    fill(
      svg,
      defs(ids),
      ...frame(g, v.dense ? `VOL·${m.weekly ? 'M' : 'W'}` : 'VOL'),
      ...gridNodes,
      ...volumeMarks(g, v),
      g.offset ? prelisting(g, sc, m.points[0]) : null,
      m.candles ? null : areaMark(g, sc, m.points, ids),
      maNode,
      ...(m.candles ? candleMarks(g, sc, m.points, ids) : lineMarks(g, sc, m.points, q.live && !q.rest)),
      ...lastTag(g, q.price, tagY),
      ...xLabels(g, m.points, m.weekly, data.today),
      xh.grp,
    );
    attrs(svg, { width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, 'aria-label': summary(m, data) });
    // Interval in words: "1W" would read as the 1W range button
    setText(subInterval, ` · ${m.weekly ? 'Weekly' : 'Daily'}`);
    maShown = !!maNode;
    model = m;
    geo = g;
    scale = sc;
    vol = v;
  }

  /** Market closed: a flat dim baseline at the base price, no marks. */
  function drawClosed(width) {
    const g = layout(width, MIN_SLOTS);
    const y = (g.top + g.priceBottom) / 2;
    model = null;
    xh = null;
    tickLabels = [];
    fill(
      svg,
      ...frame(g),
      s('line', { class: 'hbt-flat', x1: g.plotL, x2: g.plotR, y1: crisp(y), y2: crisp(y) }),
      s(
        'g',
        { class: 'hbt-tag is-closed' },
        s('rect', { x: g.plotR + 2.5, y: r1(y - 7.5), width: g.axisW - 4, height: 15, rx: 2 }),
        s('text', { x: g.plotR + 7, y: r1(y), dy: '0.35em' }, fmt(S.LIFE_BASE)),
      ),
    );
    // A habit that exists but is not planned yet (or starts later) opens the market on its first planned day
    const waiting = data.hasHabits;
    setText(closedText, waiting ? 'The LIFE index opens on the first day a habit is planned.' : 'Plan your first habit to start the LIFE index.');
    setText(closedAction, waiting ? 'Open week plan' : 'Plan habits');
    const label = waiting ? 'LIFE index: market closed until the first planned day.' : 'LIFE index: market closed. No habit has been planned yet.';
    attrs(svg, { width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, 'aria-label': label });
    setText(subInterval, '');
    maShown = false;
    geo = g;
  }

  function renderLegend(type, withMa) {
    const sig = `${type}:${withMa}`;
    if (legend.dataset.sig === sig) return;
    legend.dataset.sig = sig;
    const key = (kind, text) => h('span', { class: 'hbt-key' }, h('span', { class: `hbt-swatch is-${kind}`, 'aria-hidden': 'true' }), text);
    fill(
      legend,
      ...(type === 'candles' ? [key('up', 'Up'), key('down', 'Down'), key('live', 'Live')] : [key('line', 'LIFE')]),
      withMa ? key('ma', `MA${MA_N}`) : null,
      key('done', 'Done'),
      key('plan', 'Planned'),
    );
  }

  function renderNote() {
    const q = data.quote;
    setText(note, !q ? '' : data.daily.length < 3 ? 'Index builds as you check off habits' : `ATH ${fmt(q.allTimeHigh)} · ATL ${fmt(q.allTimeLow)}`);
  }

  function setStatus(kind, text) {
    const cls = `tag hbt-status is-${kind}`;
    if (statusEl.className !== cls) statusEl.className = cls;
    setText(statusText, text);
  }

  function activeIndex() {
    if (activeKey == null || !model) return -1;
    const i = model.points.findIndex((p) => p.key === activeKey);
    if (i < 0) activeKey = null;
    return i;
  }

  /** Header + OHLC readout: the hovered/scrubbed point, else the latest day. */
  function updateReadout() {
    const q = data.quote;
    maCell.hidden = !maShown;
    if (!q) {
      setText(priceEl, '--.--');
      setText(chgMain, `${GLYPH.flat} 0.00`);
      setText(chgPct, ' (0.00%)');
      chgEl.dataset.dir = 'flat';
      setStatus('closed', 'Market closed');
      Object.values(cells).forEach((el) => setText(el, '—'));
      return;
    }
    const i = activeIndex();
    const p = i >= 0 ? model.points[i] : data.daily[data.daily.length - 1];
    const pq = i >= 0 ? S.lifeQuote([p]) : q;
    const d = delta(pq);
    setText(priceEl, fmt(pq.price));
    setText(chgMain, `${GLYPH[d.dir]} ${d.sign}${d.abs.toFixed(2)}`);
    setText(chgPct, ` (${d.sign}${d.pct.toFixed(2)}%)`);
    chgEl.dataset.dir = d.dir;
    if (i >= 0) setStatus('date', p.live && !model.weekly ? `Today · ${p.rest ? 'rest' : 'live'}` : pointDate(p, model.weekly, data.today));
    else if (!q.rest) setStatus('live', 'Live');
    else if (data.activeToday) setStatus('rest', 'Rest day');
    else setStatus('closed', 'Market closed'); // every habit archived: the price is frozen
    setText(cells.o, fmt(pq.open));
    setText(cells.h, fmt(pq.high));
    setText(cells.l, fmt(pq.low));
    setText(cells.c, fmt(pq.price));
    const ma = model ? model.ma[i >= 0 ? i : model.ma.length - 1] : null;
    setText(cells.ma, ma == null ? '—' : fmt(ma));
    setText(cells.vol, p.rest ? 'REST' : `${p.volume}/${p.planned}`);
  }

  function drawCrosshair() {
    if (!xh) {
      stage.classList.remove('is-scrubbing');
      return;
    }
    const i = activeIndex();
    xh.grp.classList.toggle('is-on', i >= 0);
    stage.classList.toggle('is-scrubbing', i >= 0);
    if (i < 0) {
      tickLabels.forEach((t) => show(t.el, true));
      return;
    }
    const g = geo;
    const p = model.points[i];
    const cx = xAt(g, i);
    const vx = crisp(cx);
    attrs(xh.v, { x1: vx, x2: vx });

    // Mouse: the horizontal hairline follows the pointer inside the price pane.
    // Keyboard/touch: it snaps to the close of the active day.
    const inPrice = pointerY != null && pointerY >= g.top && pointerY <= g.priceBottom;
    const y = pointerY == null ? scale.y(p.close) : inPrice ? pointerY : null;
    show(xh.hl, y != null);
    show(xh.priceBg, y != null);
    show(xh.priceText, y != null);
    const pillY = y == null ? null : clamp(y, g.top, g.priceBottom);
    tickLabels.forEach((t) => show(t.el, pillY == null || Math.abs(t.y - pillY) > 13));
    if (y != null) {
      const yy = crisp(y);
      attrs(xh.hl, { y1: yy, y2: yy });
      attrs(xh.priceBg, { y: r1(pillY - 8) });
      attrs(xh.priceText, { y: r1(pillY) });
      setText(xh.priceText, fmt(scale.value(y)));
    }

    show(xh.dot, !model.candles);
    attrs(xh.dot, { cx: r1(cx), cy: r1(scale.y(p.close)) });

    const col = vol.cols.find((c) => i >= c.i0 && i <= c.i1);
    attrs(xh.hot, { d: col?.volume ? colPath(col.x, col.w, vol.y(col.volume), g.volBottom) : 'M0,0' });

    const text = pointDate(p, model.weekly, data.today);
    const pw = text.length * CHAR_W + 12;
    const px = clamp(cx, pw / 2 + 1, g.width - pw / 2 - 1);
    attrs(xh.dateBg, { x: r1(px - pw / 2), width: r1(pw) });
    attrs(xh.dateText, { x: r1(px) });
    setText(xh.dateText, text);
  }

  /* ---- Interaction ---- */

  function setActive(key, y) {
    if (key === activeKey && y === pointerY) return;
    activeKey = key;
    pointerY = y;
    drawCrosshair();
    updateReadout();
  }

  function release() {
    setActive(null, null);
  }

  function scrubTo(e, followY) {
    if (!model || !geo) return;
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (geo.width / (rect.width || geo.width));
    const y = (e.clientY - rect.top) * (geo.height / (rect.height || geo.height));
    const i = clamp(Math.floor((x - geo.plotL) / geo.sw) - geo.offset, 0, model.points.length - 1);
    setActive(model.points[i].key, followY ? r1(y) : null);
  }

  // Mouse/pen hover tracks the pointer; touch scrubs only while pressed (Robinhood style).
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || scrubbing) scrubTo(e, e.pointerType !== 'touch');
  });
  svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    scrubbing = true;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    scrubTo(e, false);
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    release();
  };
  svg.addEventListener('pointerup', endScrub);
  svg.addEventListener('pointercancel', endScrub);
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') release();
  });

  stage.addEventListener('keydown', (e) => {
    if (e.target !== stage || !model || e.altKey || e.ctrlKey || e.metaKey) return;
    const n = model.points.length;
    const cur = activeIndex();
    const step = e.shiftKey ? 7 : 1;
    let next;
    if (e.key === 'ArrowLeft') next = cur < 0 ? Math.max(0, n - 1 - step) : Math.max(0, cur - step);
    else if (e.key === 'ArrowRight') next = cur < 0 ? n - 1 : Math.min(n - 1, cur + step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape' && cur >= 0) {
      e.preventDefault();
      release();
      announce(liveSpeech());
      return;
    } else return;
    e.preventDefault();
    setActive(model.points[next].key, null);
    announce(pointSpeech(model.points[next]));
  });
  stage.addEventListener('blur', () => {
    if (!scrubbing) release();
  });

  function pointSpeech(p) {
    const q = S.lifeQuote([p]);
    const when = model.weekly ? `Week of ${formatDay(p.key)}` : p.live ? 'Today' : formatDay(p.key);
    const load = p.rest ? 'Rest day' : `${p.volume} of ${p.planned} ${habitsWord(p.planned)} done`;
    return `${when}: ${fmt(q.price)}, ${moveWords(delta(q))}. Open ${fmt(q.open)}, high ${fmt(q.high)}, low ${fmt(q.low)}. ${load}.`;
  }

  function liveSpeech() {
    const q = data.quote;
    return q ? `LIFE index ${fmt(q.price)}, ${moveWords(delta(q))} today.` : 'LIFE index: market closed.';
  }

  function openInfo() {
    const item = (term, text) => [h('dt', { class: 'label' }, term), h('dd', null, text)];
    const m = openModal({
      title: 'LIFE index',
      className: 'hbt-modal',
      body: h(
        'div',
        { class: 'hbt-info' },
        h('p', { class: 'muted' }, 'A 0–100 momentum score for your habits, drawn like a stock. It starts at 50 on the first day you plan a habit.'),
        h(
          'dl',
          { class: 'hbt-info-list' },
          item('Daily move', "Each day moves the price 20% of the way toward that day's completion: a perfect day takes 50 to 60, a zero day takes 50 to 40."),
          item('Live today', 'Every check-off pushes today up right away. Misses only settle at day close, so an unfinished morning never drags it down.'),
          item('Rest days', 'Days with nothing planned keep the price flat. With every habit archived the market stays closed.'),
          item('Volume', 'Bars under the chart are habits done; the lighter bars behind are habits planned, so capacity grows as you add habits. On long ranges each bar sums a week (VOL·W) or a month (VOL·M).'),
          item(`MA${MA_N}`, `Average of the last ${MA_N} closes, rest days skipped (weeks when the chart switches to weekly). It appears once ${MA_N} closes exist.`),
          item('Candles', "Solid = up, hollow = down, hatched = today, still open. Wicks span the day's possible range: a perfect day on top, a zero day at the bottom."),
          item('Keyboard', 'Focus the chart, then use ← → to move through days (Shift for a week), Home / End to jump, Esc to return to today.'),
        ),
      ),
      footer: [h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Got it')],
      onClose: () => {
        if (modal === m) modal = null;
      },
    });
    modal = m;
  }

  /* ---- Live data, day rollover, resize ---- */

  function refresh() {
    if (!alive) return;
    const next = lifeData(source);
    if (next === data) return; // same items, same day: nothing moved
    const before = data.quote?.price;
    data = next;
    const after = data.quote?.price;
    render();
    if (before != null && after != null && Math.abs(after - before) > 1e-9) {
      // While a past day is scrubbed the header shows that day, so only the ticker flashes
      if (activeIndex() < 0) flash(priceEl, after > before ? 'up' : 'down');
      announce(liveSpeech());
    }
  }

  const schedule = () => {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        render();
      });
    }
  };

  let resizeObs = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (Math.round(stage.clientWidth) !== drawnWidth) schedule();
    });
    resizeObs.observe(stage);
  } else {
    window.addEventListener('resize', schedule);
  }

  const unsubData = source.subscribe(refresh);
  const unsubPrefs = prefs.subscribe(() => render());
  const offDay = onDayChange(refresh);
  render();

  return () => {
    alive = false;
    if (typeof unsubData === 'function') unsubData();
    unsubPrefs();
    offDay();
    resizeObs?.disconnect();
    window.removeEventListener('resize', schedule);
    cancelAnimationFrame(raf);
    announce.cancel();
    modal?.close();
    root.remove();
  };
}

/* ==========================================================================
   Top-bar ticker — visible on every route
   ========================================================================== */

export function mountTicker(slot, source) {
  let shown = null; // the lifeData() snapshot on screen
  let prevPrice = null;

  const long = (cls) => h('span', { class: ['hbt-tk-long', cls] });
  const short = (cls) => h('span', { class: ['hbt-tk-short', cls] });
  const priceLong = long();
  const priceShort = short();
  const chgLong = long();
  const chgShort = short();
  const price = flashable(h('span', { class: 'hbt-tk-price' }, priceLong, priceShort));
  const chg = h('span', { class: 'hbt-tk-chg', dataset: { dir: 'flat' } }, chgLong, chgShort);
  const spark = s('svg', { class: 'hbt-tk-spark', 'aria-hidden': 'true', focusable: 'false' });

  const link = h(
    'a',
    {
      class: 'hbt-ticker',
      href: '#/habits',
      onClick: (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        source.openTab('today');
      },
    },
    h('span', { class: 'hbt-tk-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'hbt-tk-sym', 'aria-hidden': 'true' }, 'LIFE'),
    price,
    chg,
    spark,
  );
  slot.append(link);

  function update() {
    const data = lifeData(source);
    if (data === shown) return;
    shown = data;
    const { daily, quote: q } = data;
    link.classList.toggle('is-empty', !q);
    link.classList.toggle('is-live', !!q && q.live && !q.rest);
    if (!q) {
      setText(priceLong, '--.--');
      setText(priceShort, '--.-');
      setText(chgLong, '');
      setText(chgShort, '');
      chg.dataset.dir = 'flat';
      drawSpark(spark, [], 64, 18);
      link.setAttribute('aria-label', 'LIFE index: no data yet. Open Habits');
      prevPrice = null;
      return;
    }
    const d = delta(q);
    setText(priceLong, fmt(q.price));
    setText(priceShort, fmt(q.price, 1));
    setText(chgLong, `${GLYPH[d.dir]} ${d.sign}${d.abs.toFixed(2)}`);
    setText(chgShort, `${GLYPH[d.dir]}${d.abs.toFixed(1)}`);
    chg.dataset.dir = d.dir;
    drawSpark(spark, daily.slice(-SPARK_DAYS).map((c) => c.close), 64, 18);
    link.setAttribute('aria-label', `LIFE index ${fmt(q.price)}, ${moveWords(d)} today. Open Habits`);
    if (prevPrice != null && Math.abs(q.price - prevPrice) > 1e-9) flash(price, q.price > prevPrice ? 'up' : 'down');
    prevPrice = q.price;
  }

  update();
  const unsub = source.subscribe(update);
  const offDay = onDayChange(update);

  return () => {
    if (typeof unsub === 'function') unsub();
    offDay();
    link.remove();
  };
}
