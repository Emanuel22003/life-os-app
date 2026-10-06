// LIFE/OS — Notes board: pure helpers for the board layout (columns, keyboard targets,
// drop positions). DOM-free and store-free, tested in tools/tests/notes.board.test.js.
//
// A column is 'unsorted' or a section id, the same values a view uses. Cards keep the
// list's order inside a column (pinned first, then most recently edited): the board has
// no manual order, so a note dropped into a column lands where that order puts it.

import { VIEW_UNSORTED, compareNotes, findSection, matchesTerms, queryTerms, sortNotes } from './notes.logic.js';

/** The column a note belongs to: its section, or 'unsorted' (also for a section that no longer exists). */
export function columnOf(note, sections) {
  const id = note?.sectionId ?? null;
  return id !== null && findSection(sections, id) ? id : VIEW_UNSORTED;
}

/** The section a column files notes under: null for Unsorted. */
export function columnSection(column) {
  return column == null || column === VIEW_UNSORTED ? null : column;
}

/**
 * The board's columns, left to right: Unsorted (only while it holds notes, unless
 * `withUnsorted`), then every section in its order.
 *   [{ id, section (null for Unsorted), notes: [matching notes, sorted], total, collapsed }]
 * `query` is the search text or terms from queryTerms(); `total` counts every note of the
 * column, `notes` only the matches. `collapsed` lists folded column ids.
 */
export function boardColumns(items, sections, { query = '', collapsed = [], withUnsorted = false } = {}) {
  const terms = Array.isArray(query) ? query : queryTerms(query);
  const list = Array.isArray(sections) ? sections : [];
  const folded = new Set(Array.isArray(collapsed) ? collapsed : []);
  const buckets = new Map([[VIEW_UNSORTED, []], ...list.map((s) => [s.id, []])]);
  for (const note of Array.isArray(items) ? items : []) buckets.get(columnOf(note, list)).push(note);
  const column = (id, section) => {
    const all = buckets.get(id);
    return { id, section, notes: sortNotes(terms.length ? all.filter((n) => matchesTerms(n, terms)) : all), total: all.length, collapsed: folded.has(id) };
  };
  const out = list.map((s) => column(s.id, s));
  if (withUnsorted || buckets.get(VIEW_UNSORTED).length) out.unshift(column(VIEW_UNSORTED, null));
  return out;
}

/** The column `delta` places from `from` in `order` (ids, left to right); null past either end. */
export function adjacentColumn(order, from, delta) {
  const list = Array.isArray(order) ? order : [];
  const at = list.indexOf(from);
  const step = Math.trunc(Number(delta)) || 0;
  if (at === -1 || !step) return null;
  return list[at + step] ?? null;
}

/**
 * Where keyboard focus goes from the card at { col, row } of `grid` (one array of card ids
 * per column, empty for a folded or empty column):
 *   ArrowUp / ArrowDown   previous / next card in the column (stops at the ends)
 *   Home / End            first / last card in the column
 *   ArrowLeft / Right     the nearest column with cards on that side, same row or its last card
 * Returns { col, row } or null when there is nowhere to go.
 */
export function boardFocusTarget(grid, pos, key) {
  const cols = Array.isArray(grid) ? grid : [];
  const col = pos?.col;
  const row = pos?.row;
  const cards = cols[col];
  if (!Array.isArray(cards) || !cards.length || !Number.isInteger(row)) return null;
  const at = Math.max(0, Math.min(row, cards.length - 1));
  const stay = (r) => (r === row ? null : { col, row: r });
  if (key === 'ArrowUp') return at > 0 ? stay(at - 1) : null;
  if (key === 'ArrowDown') return at < cards.length - 1 ? stay(at + 1) : null;
  if (key === 'Home') return stay(0);
  if (key === 'End') return stay(cards.length - 1);
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const step = key === 'ArrowLeft' ? -1 : 1;
  for (let c = col + step; c >= 0 && c < cols.length; c += step) {
    const other = cols[c];
    if (Array.isArray(other) && other.length) return { col: c, row: Math.min(at, other.length - 1) };
  }
  return null;
}

/**
 * Where `note` would land among a column's cards (`notes`, already in board order, without
 * it): the number of cards that come before it. That slot is where a drop shows its marker.
 */
export function landingIndex(notes, note) {
  if (!note) return 0;
  let n = 0;
  for (const other of Array.isArray(notes) ? notes : []) {
    if (other.id !== note.id && compareNotes(other, note) < 0) n += 1;
  }
  return n;
}

/**
 * The columns Alt+←/→ walks: the displayed ones, with Unsorted in front when it is hidden
 * (it shows only while it holds notes, yet is always somewhere a note can go).
 */
export function moveOrder(order) {
  const list = Array.isArray(order) ? order : [];
  return list.includes(VIEW_UNSORTED) ? list.slice() : [VIEW_UNSORTED, ...list];
}

const isSpan = (s) => !!s && Number.isFinite(s.left) && Number.isFinite(s.right);

/**
 * The column a dragged card at `x` is over, from the columns' screen spans ({ id, left,
 * right }, left to right). Only x counts, so the gaps between columns and the strip below
 * them are never dead: a gap belongs to the nearer column, the room before the first column
 * to it and the room after the last (the + Section strip, the end padding) to the last.
 * `left` / `right` bound the part of the board that shows; outside it, null.
 */
export function columnAtX(spans, x, { left = -Infinity, right = Infinity } = {}) {
  const list = (Array.isArray(spans) ? spans : []).filter(isSpan);
  if (!list.length || !Number.isFinite(x) || x < left || x > right) return null;
  if (x < list[0].left) return list[0].id;
  for (let i = 0; i < list.length; i += 1) {
    const span = list[i];
    const next = list[i + 1];
    if (x <= span.right) return span.id;
    if (next && x < next.left) return x - span.right <= next.left - x ? span.id : next.id;
  }
  return list[list.length - 1].id;
}

/**
 * How far an edge scroll may move the board this frame: `delta` (px; positive moves the
 * content left) clamped so the last column stops `pad` inside the visible end `hi` and the
 * first column stops `pad` inside the visible start `lo`. Nothing past them is a drop target.
 */
export function clampEdgeScroll(delta, { first = null, last = null, lo = -Infinity, hi = Infinity, pad = 0 } = {}) {
  const step = Number(delta) || 0;
  if (step > 0 && isSpan(last)) return Math.max(0, Math.min(step, last.right - (hi - pad)));
  if (step < 0 && isSpan(first)) return Math.min(0, Math.max(step, first.left - (lo + pad)));
  return step;
}

/**
 * Ids of the columns that show between `lo` and `hi` (screen px): at least `share` of the
 * column, or of the visible width for a column wider than it.
 */
export function columnsInView(spans, lo, hi, share = 0.5) {
  const width = hi - lo;
  if (!(width > 0)) return [];
  return (Array.isArray(spans) ? spans : [])
    .filter((s) => {
      if (!isSpan(s) || s.right <= s.left) return false;
      const seen = Math.min(s.right, hi) - Math.max(s.left, lo);
      return seen > 0 && seen >= Math.min(s.right - s.left, width) * share;
    })
    .map((s) => s.id);
}
