// LIFE/OS — Search (⌘K): pure matching and ranking for js/command.js (DOM-free, unit-tested with
// jsc in tools/tests/command.test.js).
//
// An entry is a plain object; command.js adds whatever it needs to show and open it:
//   { id, group, title, keywords?, text?, boost?, later?, idle? }
//   title     what the row says, and what matches best
//   keywords  other words that find it nearly as well (Pomodoro: 'focus timer'); inside a word
//             only from 4 letters typed
//   text      more text that finds it, weaker (a note's body, a task's notes); inside a word
//             only from 4 letters typed
//   boost     -1 … 1: recent or coming up soon (moves it up among equally good matches)
//   later     listed after the rest of its group (a done task, a past event, an archived habit)
//   idle      shown with no query (the actions and the pages)
//
// Matching ignores case and accents: 'o' finds 'ø', 'ae' finds 'æ', 's' finds 'ș' (Norwegian,
// Romanian and the rest of Latin script). Every word typed must match somewhere. Per word, a match
// at the start of the title beats one at the start of a word, which beats one inside a word. A
// single letter only finds titles where a word starts with it.

/** Letters NFD can't take apart into a base letter and a mark (and Greek's word-final sigma, so
 *  folding letter by letter and folding a whole text agree). */
const SPECIAL = Object.freeze({ ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i', ħ: 'h', ŧ: 't', ŋ: 'n', ς: 'σ' });
const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL).join('')}]`, 'g');
const MARKS = /\p{M}+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

// Points per word typed: where in the title, keywords or text it matched (tier 3 = at the very
// start, 2 = at a word's start, 1 = inside a word). The best field counts.
const POINTS = Object.freeze({
  title: [0, 40, 70, 100],
  keywords: [0, 25, 60, 60],
  text: [0, 10, 20, 20],
});
/** The whole query (several words) starts the title / is the title. */
const PHRASE_BONUS = 40;
const EXACT_BONUS = 30;
/** Most a boost adds (or takes, at -1): from -1 to 1 spans less than one tier, so a better match
 *  always wins. */
export const BOOST_MAX = 12;

/**
 * Case- and accent-free text with a map back to the original:
 * fold('Bjørn') -> { text: 'bjorn', start: [0,1,2,3,4], end: [1,2,3,4,5] }
 * start[i] / end[i]: where folded character i came from in the original (UTF-16 offsets).
 */
export function fold(input) {
  const src = String(input ?? '');
  let text = '';
  const start = [];
  const end = [];
  let at = 0;
  let prev = 0; // where the previous letter's folded characters start
  for (const ch of src) {
    const lower = ch.toLowerCase();
    const out = SPECIAL[lower] ?? lower.normalize('NFD').replace(MARKS, '');
    // A mark typed apart from its letter (a + ◌̊) belongs to that letter
    if (!out) {
      for (let k = prev; k < end.length; k++) end[k] = at + ch.length;
      at += ch.length;
      continue;
    }
    prev = text.length;
    for (const c of out) {
      // A letter outside the BMP stays two code units; each maps to the same original
      for (let k = 0; k < c.length; k++) {
        text += c[k];
        start.push(at);
        end.push(at + ch.length);
      }
    }
    at += ch.length;
  }
  return { text, start, end };
}

/**
 * Just the folded text: normalize('Ștefan Ålesund') -> 'stefan alesund'. The same as
 * fold(input).text, done on the whole text at once (no map back): about ten times faster, which
 * counts for the long texts (a few hundred notes' bodies are megabytes).
 */
export function normalize(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(SPECIAL_RE, (c) => SPECIAL[c])
    .normalize('NFD')
    .replace(MARKS, '');
}

/** 'Call  Mum' -> ['call', 'mum'] (folded, unique, in the order typed). */
export function queryTerms(query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  return [...new Set(words)];
}

const isWordStart = (text, i) => i === 0 || !WORD_CHAR.test(text[i - 1]);

/**
 * Where `term` sits in folded `hay`: { tier, at } or null. Tier 3: hay starts with it; 2: a word
 * starts with it (the first such place); 1: only inside a word (the first place).
 */
export function matchTier(hay, term) {
  if (!term || !hay) return null;
  const first = hay.indexOf(term);
  if (first === -1) return null;
  if (first === 0) return { tier: 3, at: 0 };
  for (let i = first; i !== -1; i = hay.indexOf(term, i + 1)) {
    if (isWordStart(hay, i)) return { tier: 2, at: i };
  }
  return { tier: 1, at: first };
}

// Folded fields per entry, built once (entries are rebuilt each time the search opens)
const prepared = new WeakMap();

function prepare(entry) {
  let p = prepared.get(entry);
  if (!p) {
    const title = fold(entry.title);
    const keywords = normalize(Array.isArray(entry.keywords) ? entry.keywords.join(' ') : entry.keywords);
    const text = normalize(entry.text);
    p = { title, keywords, text };
    prepared.set(entry, p);
  }
  return p;
}

/**
 * How well `entry` matches the words: { score, hits } or null when a word matches nothing.
 * hits: [[start, end]] ranges of the title (original offsets) to highlight, merged and sorted.
 */
export function scoreEntry(entry, terms) {
  const p = prepare(entry);
  let score = 0;
  const ranges = [];
  for (const term of terms) {
    const t0 = matchTier(p.title.text, term);
    // One letter only finds titles, at the start of a word: the first key typed stays calm
    const single = term.length === 1;
    const t = t0 && (!single || t0.tier > 1) ? t0 : null;
    // Inside a word of the keywords or the text only from 4 letters: 'set' in 'closet' (or 'pu'
    // in 'computers') is noise, 'kake' in 'sjokoladekake' (a compound) is not
    const inner = (m) => (m && (m.tier > 1 || term.length >= 4) ? m : null);
    const k = single ? null : inner(matchTier(p.keywords, term));
    const x = single ? null : inner(matchTier(p.text, term));
    const best = Math.max(t ? POINTS.title[t.tier] : 0, k ? POINTS.keywords[k.tier] : 0, x ? POINTS.text[x.tier] : 0);
    if (!best) return null;
    score += best;
    if (t) ranges.push(foldedRange(p.title, t.at, t.at + term.length));
  }
  if (terms.length) {
    const phrase = terms.join(' ');
    if (p.title.text === phrase) score += EXACT_BONUS + (terms.length > 1 ? PHRASE_BONUS : 0);
    else if (terms.length > 1 && p.title.text.startsWith(phrase)) score += PHRASE_BONUS;
  }
  const boost = Number.isFinite(entry.boost) ? Math.max(-1, Math.min(1, entry.boost)) : 0;
  score += boost * BOOST_MAX;
  return { score, hits: mergeRanges(ranges) };
}

/** A folded [from, to) back to the original's offsets. */
function foldedRange(folded, from, to) {
  return [folded.start[from], folded.end[to - 1]];
}

/** [[5,8],[0,2],[1,4]] -> [[0,4],[5,8]] */
export function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r && r[1] > r[0]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Text split into plain and highlighted runs for drawing:
 * runs('Buy milk', [[4, 7]]) -> [{ text: 'Buy ', hit: false }, { text: 'mil', hit: true }, { text: 'k', hit: false }]
 */
export function runs(text, hits = []) {
  const str = String(text ?? '');
  const out = [];
  let pos = 0;
  for (const [s, e] of mergeRanges(hits.map((r) => [Math.max(0, r[0]), Math.min(str.length, r[1])]))) {
    if (s > pos) out.push({ text: str.slice(pos, s), hit: false });
    out.push({ text: str.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < str.length || !out.length) out.push({ text: str.slice(pos), hit: false });
  return out;
}

/**
 * A short piece of `text` around the first word that matches, for a row's second line:
 * { text, hits } (hits relative to the piece), or null when no word matches. Cut at spaces,
 * with '…' where it was cut.
 */
export function snippet(text, query, length = 90) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  const terms = Array.isArray(query) ? query : queryTerms(query);
  if (!src || !terms.length) return null;
  const f = fold(src);
  let first = -1;
  const ranges = [];
  for (const term of terms) {
    for (let i = f.text.indexOf(term); i !== -1; i = f.text.indexOf(term, i + term.length)) {
      const r = foldedRange(f, i, i + term.length);
      ranges.push(r);
      if (first === -1 || r[0] < first) first = r[0];
    }
  }
  if (first === -1) return null;
  let from = 0;
  if (first > length * 0.4) {
    const space = src.lastIndexOf(' ', first - 16);
    from = space > 0 ? space + 1 : Math.max(0, first - 16);
  }
  let to = Math.min(src.length, from + length);
  if (to < src.length) {
    const space = src.lastIndexOf(' ', to);
    if (space > first) to = space;
  }
  const lead = from > 0 ? '…' : '';
  const tail = to < src.length ? '…' : '';
  const shift = lead.length - from;
  const hits = mergeRanges(ranges.filter(([s, e]) => s >= from && e <= to).map(([s, e]) => [s + shift, e + shift]));
  return { text: `${lead}${src.slice(from, to)}${tail}`, hits };
}

/**
 * 1 when `days` is 0, falling off with distance: 0.5 at `half` days away, 0.25 at 3 × half.
 * For "coming up soon" (days ahead) and "edited lately" (days ago).
 */
export function nearness(days, half = 7) {
  if (!Number.isFinite(days)) return 0;
  return 1 / (1 + Math.abs(days) / Math.max(0.001, half));
}

/**
 * The search results, grouped: [{ group, items: [{ entry, score, hits }], total }].
 * - No query: the `idle` entries, in the order given, grouped (no limit).
 * - A query: every entry whose words all match. Within a group: the `later` ones last, then by
 *   score, then by title. Groups go by their best score (ties: `order`). A group shows `limit`
 *   items unless it is in `expanded`; `total` says how many matched.
 */
export function rank(entries, query, { limit = 5, order = [], expanded = [] } = {}) {
  const terms = queryTerms(query);
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.title === 'string') : [];
  const groupIndex = (g) => {
    const i = order.indexOf(g);
    return i === -1 ? order.length : i;
  };
  const groups = new Map();
  const add = (entry, score, hits) => {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push({ entry, score, hits });
  };

  if (!terms.length) {
    for (const entry of list) if (entry.idle) add(entry, 0, []);
    return [...groups].sort((a, b) => groupIndex(a[0]) - groupIndex(b[0])).map(([group, items]) => ({ group, items, total: items.length }));
  }

  for (const entry of list) {
    const m = scoreEntry(entry, terms);
    if (m) add(entry, m.score, m.hits);
  }
  const byTitle = (a, b) => a.entry.title.localeCompare(b.entry.title);
  const out = [];
  for (const [group, items] of groups) {
    items.sort((a, b) => Number(!!a.entry.later) - Number(!!b.entry.later) || b.score - a.score || byTitle(a, b));
    const best = Math.max(...items.filter((it) => !it.entry.later).map((it) => it.score), ...items.map((it) => it.score - 1000));
    out.push({ group, best, total: items.length, items: expanded.includes(group) ? items : items.slice(0, limit) });
  }
  return out.sort((a, b) => b.best - a.best || groupIndex(a.group) - groupIndex(b.group)).map(({ group, items, total }) => ({ group, items, total }));
}
