// LIFE/OS — Notes: pure helpers. DOM-free and store-free so they can be
// unit-tested with JavaScriptCore (tools/tests/notes.test.js, notes.sections.test.js).
//
// Store shape ('notes'):
//   { items: [{ id, title, body, pinned, createdAt, updatedAt, sectionId }],
//     sections: [{ id, name, icon, createdAt, order }],   // display order, order === index
//     view: 'all' | 'unsorted' | <section id>,
//     selectedId, seeded,
//     layout: 'list' | 'board',                            // last layout chosen (each tab keeps its own)
//     boardCollapsed: ['unsorted' | <section id>] }       // board columns folded to a strip
// State functions never mutate their input and return the same object on a no-op.
// Color coding adds an optional `color` (a palette id, js/colors.logic.js) to notes and sections.

import { colorKey, withColor } from '../colors.logic.js';

export const EXCERPT_LENGTH = 140;

const fallbackId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A usable id: finite numbers become strings, blank or non-string values become null. */
const toId = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' && value.trim() ? value : null;

/* ==========================================================================
   Model
   ========================================================================== */

export function createNote({ id = fallbackId(), title = '', body = '', pinned = false, sectionId = null, now = Date.now() } = {}) {
  return { id, title, body, pinned, createdAt: now, updatedAt: now, sectionId: toId(sectionId) };
}

/** A note with no visible title and no visible body. */
export function isBlank(note) {
  return !note || (!String(note.title ?? '').trim() && !String(note.body ?? '').trim());
}

// Largest timestamp a Date can hold; anything above renders as "Invalid Date".
const MAX_TIME = 8.64e15;

function toTime(value) {
  let t = null;
  if (typeof value === 'number') t = value;
  else if (typeof value === 'string' && value.trim()) t = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  return Number.isFinite(t) && t > 0 && t <= MAX_TIME ? t : null;
}

const toText = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** Coerce one stored note into the current shape; null when it is unusable. */
export function normalizeNote(raw, { now = Date.now(), makeId = fallbackId } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let id = typeof raw.id === 'number' && Number.isFinite(raw.id) ? String(raw.id) : raw.id;
  if (typeof id !== 'string' || !id.trim()) id = makeId();
  const createdAt = toTime(raw.createdAt) ?? toTime(raw.updatedAt) ?? now;
  const updatedAt = Math.max(toTime(raw.updatedAt) ?? createdAt, createdAt);
  return {
    ...raw,
    id,
    title: toText(raw.title),
    body: toText(raw.body),
    pinned: raw.pinned === true,
    createdAt,
    updatedAt,
    // Shape only: normalizeState also checks that the section exists.
    sectionId: toId(raw.sectionId),
  };
}

/**
 * Validate the whole store value: drops junk entries, repairs fields, makes ids
 * unique, clears a dangling selection, repairs sections (see normalizeSections),
 * sends notes of a missing section to Unsorted and a missing view to All notes.
 * Data that already has notes counts as seeded so older saves never get a welcome
 * note pushed into them. Idempotent: normalizing its own output changes nothing.
 */
export function normalizeState(raw, { now = Date.now(), makeId = fallbackId } = {}) {
  // A bare array is read as the list of notes rather than wiped by the next save.
  const src = Array.isArray(raw) ? { items: raw } : raw && typeof raw === 'object' ? raw : {};
  const { sections, remap } = normalizeSections(src.sections, { now, makeId });
  const sectionIds = new Set(sections.map((s) => s.id));
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(src.items) ? src.items : []) {
    const note = normalizeNote(entry, { now, makeId });
    if (!note) continue;
    const base = note.id;
    for (let n = 2; seen.has(note.id); n += 1) note.id = `${base}-${n}`;
    seen.add(note.id);
    const ref = remap.get(note.sectionId) ?? note.sectionId;
    note.sectionId = ref !== null && sectionIds.has(ref) ? ref : null;
    items.push(note);
  }
  return {
    ...src,
    items,
    sections,
    view: resolveView(sections, src.view),
    selectedId: typeof src.selectedId === 'string' && seen.has(src.selectedId) ? src.selectedId : null,
    seeded: src.seeded === true || items.length > 0 || sections.length > 0,
    layout: normalizeLayout(src.layout),
    boardCollapsed: normalizeCollapsed(src.boardCollapsed, sectionIds, remap),
  };
}

/* ==========================================================================
   Layout: list (rail · list · editor) or board (one column per section)
   ========================================================================== */

export const LAYOUT_LIST = 'list';
export const LAYOUT_BOARD = 'board';

/** 'board' stays 'board'; anything else is the list. */
export function normalizeLayout(value) {
  return value === LAYOUT_BOARD ? LAYOUT_BOARD : LAYOUT_LIST;
}

/**
 * Collapsed board columns: 'unsorted' and ids of existing sections (a renamed built-in id
 * follows its section), each once, in the stored order. Anything else is dropped.
 */
function normalizeCollapsed(list, sectionIds, remap = new Map()) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    // 'unsorted' always means the Unsorted column, even when a stored section had that id.
    const id = entry === VIEW_UNSORTED ? entry : remap.get(entry) ?? entry;
    if (typeof id !== 'string' || out.includes(id)) continue;
    if (id === VIEW_UNSORTED || sectionIds.has(id)) out.push(id);
  }
  return out;
}

/** The state with `layout` (normalized); the same state when it already has it. */
export function setLayout(state, layout) {
  const next = normalizeLayout(layout);
  return state?.layout === next ? state : { ...state, layout: next };
}

/** Fold or unfold one board column ('unsorted' or a section id); `collapsed` forces a side. Same state on a no-op. */
export function toggleCollapsed(state, column, collapsed) {
  const list = Array.isArray(state?.boardCollapsed) ? state.boardCollapsed : [];
  const valid = column === VIEW_UNSORTED || !!findSection(sectionsOf(state), column);
  const has = list.includes(column);
  const want = typeof collapsed === 'boolean' ? collapsed : !has;
  if (!valid || want === has) return state;
  return { ...state, boardCollapsed: want ? [...list, column] : list.filter((id) => id !== column) };
}

/* ==========================================================================
   Sections (folders): constants, names, icons
   ========================================================================== */

export const VIEW_ALL = 'all';
export const VIEW_UNSORTED = 'unsorted';
export const SECTION_NAME_MAX = 40;

/** Icon names for the section icon picker. 'folder' is the default and is stored as icon: null. */
export const DEFAULT_SECTION_ICON = 'folder';
export const SECTION_ICONS = Object.freeze(['folder', 'note', 'video', 'play', 'bulb', 'zap', 'star', 'flag', 'target', 'code', 'camera', 'music', 'hash']);
export const SECTION_ICON_LABELS = Object.freeze({
  folder: 'Folder',
  note: 'Note',
  video: 'Video',
  play: 'Play',
  bulb: 'Idea',
  zap: 'Bolt',
  star: 'Star',
  flag: 'Flag',
  target: 'Target',
  code: 'Code',
  camera: 'Camera',
  music: 'Music',
  hash: 'Hashtag',
});

/** One-click starters offered while the user has no sections. */
export const SUGGESTED_SECTIONS = Object.freeze([
  Object.freeze({ name: 'Random notes', icon: 'note' }),
  Object.freeze({ name: 'TikTok ideas', icon: 'video' }),
  Object.freeze({ name: 'YouTube ideas', icon: 'play' }),
  Object.freeze({ name: 'Projects', icon: 'flag' }),
]);

const VIEW_LABELS = { [VIEW_ALL]: 'All notes', [VIEW_UNSORTED]: 'Unsorted' };
// Names that would read like the built-in rows (lowercase key -> label to quote).
const RESERVED_NAMES = new Map([
  ['all', 'All notes'],
  ['all notes', 'All notes'],
  ['unsorted', 'Unsorted'],
]);
const UNTITLED_SECTION = 'Untitled section';
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
// Invisible format characters, removed outright: bidi controls (they reverse the text
// around a name wherever it is quoted), zero-width spaces, word joiners, soft hyphens
// and byte-order marks. ZWJ / ZWNJ stay: emoji sequences and some scripts need them.
const FORMAT_CHARS = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
// Fillers that draw as empty space: treated as spaces, so they collapse and trim away.
const BLANK_CHARS = /[\u115F\u1160\u2800\u3164\uFFA0]/g;
const JOINER_RUNS = /[\u200C\u200D]+/g;
// What is left of a name with no visible character: spaces, joiners, variation selectors, tags.
const INVISIBLE_CHARS = /[\s\u034F\u17B4\u17B5\u200C\u200D\uFE00-\uFE0F\u{E0000}-\u{E01EF}]/gu;
// Ignored when comparing names: joiners and emoji/text presentation selectors.
const KEY_IGNORED = /[\u200C\u200D\uFE0E\uFE0F]/g;
const GRAPHEMES = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

const isReservedView = (id) => id === VIEW_ALL || id === VIEW_UNSORTED;
// Names that look the same compare the same: case, joiners and presentation selectors aside.
const nameKey = (name) => String(name).replace(KEY_IGNORED, '').toLowerCase();
const sectionsOf = (state) => (Array.isArray(state?.sections) ? state.sections : []);
const itemsOf = (state) => (Array.isArray(state?.items) ? state.items : []);

const isPadding = (ch) => ch === ' ' || ch === '\u200C' || ch === '\u200D';

/** Trim spaces and joiners (they join nothing at either end). A loop, so it stays linear. */
function trimPadding(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isPadding(text[start])) start += 1;
  while (end > start && isPadding(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/**
 * The longest start of `text` within `max` code points that never splits what reads as one
 * character (a ZWJ family emoji, a flag). Code points, so it agrees with the name counter.
 */
function capSymbols(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  let out = '';
  if (GRAPHEMES) {
    let used = 0;
    for (const { segment } of GRAPHEMES.segment(text)) {
      const n = [...segment].length;
      if (used + n > max) break;
      out += segment;
      used += n;
    }
  } else {
    // No segmenter: drop a dangling joiner or tag and never keep half a flag.
    out = chars.slice(0, max).join('').replace(/[\u200C\u200D\u{E0020}-\u{E007F}]+$/u, '');
    const flags = /[\u{1F1E6}-\u{1F1FF}]+$/u.exec(out);
    if (flags && [...flags[0]].length % 2) out = [...out].slice(0, -1).join('');
  }
  // A single cluster longer than the cap (stacked combining marks) is cut by code point.
  if (!out) out = chars.slice(0, max).join('');
  return trimPadding(out);
}

/**
 * User text -> section name: NFC; bidi controls and zero-width characters removed;
 * control characters, blank fillers and runs of whitespace become one space; trimmed;
 * at most `max` (SECTION_NAME_MAX) symbols. '' when nothing visible is left.
 * Pass { max: Infinity } for the uncut length (the name counter).
 */
export function cleanSectionName(raw, options) {
  const max = typeof options?.max === 'number' && options.max > 0 ? options.max : SECTION_NAME_MAX;
  const str = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
  const spaced = str
    .normalize('NFC')
    .replace(FORMAT_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(BLANK_CHARS, ' ')
    .replace(/\s+/g, ' ')
    // A joiner beside a space joins nothing ('TikTok \u200D ideas' is 'TikTok ideas').
    .replace(JOINER_RUNS, (run, at, all) => (all[at - 1] === ' ' || all[at + run.length] === ' ' ? '' : run))
    .replace(/ {2,}/g, ' ');
  const name = capSymbols(trimPadding(spaced), max);
  return name.replace(INVISIBLE_CHARS, '') ? name : '';
}

/**
 * Check a proposed name against the other sections (`exceptId` is the section being
 * renamed, so changing only its case is allowed).
 *   { ok: true, name }                          the cleaned name to store
 *   { ok: false, code, error }                  code: 'empty' | 'reserved' | 'duplicate'
 */
export function validateSectionName(name, sections = [], exceptId = null) {
  const clean = cleanSectionName(name);
  if (!clean) return { ok: false, code: 'empty', error: 'Give the section a name.' };
  const key = nameKey(clean);
  const builtIn = RESERVED_NAMES.get(key);
  if (builtIn) return { ok: false, code: 'reserved', error: `"${builtIn}" is built in. Choose another name.` };
  const twin = (Array.isArray(sections) ? sections : []).find((s) => s && s.id !== exceptId && nameKey(cleanSectionName(s.name)) === key);
  if (twin) return { ok: false, code: 'duplicate', error: `You already have a section called "${twin.name}".` };
  return { ok: true, name: clean };
}

/** Stored icon value: a known picker icon, else null (null shows the default folder). */
export function cleanSectionIcon(icon) {
  return typeof icon === 'string' && icon !== DEFAULT_SECTION_ICON && SECTION_ICONS.includes(icon) ? icon : null;
}

/** The icon name to draw for a section (its icon, or the default folder). */
export function sectionIcon(section) {
  return cleanSectionIcon(section?.icon) ?? DEFAULT_SECTION_ICON;
}

/** Lowercase names already in use, including the built-in view names. */
function takenNames(sections) {
  const taken = new Set(RESERVED_NAMES.keys());
  for (const s of sections) taken.add(nameKey(s.name));
  return taken;
}

/** `base`, or 'base 2', 'base 3'… (shortened to fit) when that name is taken. */
function uniqueName(base, taken) {
  if (!taken.has(nameKey(base))) return base;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const name = `${[...base].slice(0, SECTION_NAME_MAX - suffix.length).join('').trimEnd()}${suffix}`;
    if (!taken.has(nameKey(name))) return name;
  }
}

/** `base`, or 'base-2', 'base-3'… when taken or equal to a built-in view id. */
function uniqueId(base, used) {
  let id = base;
  for (let n = 2; used.has(id) || isReservedView(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Positions written back as `order` (keeps unchanged sections by reference). */
function reindex(sections) {
  return sections.map((s, i) => (s.order === i ? s : { ...s, order: i }));
}

/** One stored section with repaired fields; id may still be null. Null when unusable. */
function readSection(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = toId(raw.id);
  const name = cleanSectionName(raw.name);
  if (!id && !name) return null;
  return {
    ...raw,
    id,
    name: name || UNTITLED_SECTION,
    icon: cleanSectionIcon(raw.icon),
    createdAt: toTime(raw.createdAt) ?? now,
    order: 0,
  };
}

/**
 * Repair the stored section list: drop junk, sort by stored order (bad orders sink,
 * ties keep their position), make ids unique and never 'all'/'unsorted', drop an exact
 * repeat (same id and name), suffix clashing names ('Ideas 2'), reindex order 0..n-1.
 * `remap` maps a renamed built-in id ('all' -> 'all-2') so its notes follow it.
 */
function normalizeSections(list, { now, makeId }) {
  const entries = Array.isArray(list) ? list : [];
  const ranked = entries
    .map((entry, at) => ({ entry, at, rank: Number.isFinite(entry?.order) ? entry.order : Infinity }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at);
  // Suffixed ids must not steal an id that a later entry really has.
  const used = new Set(entries.map((entry) => toId(entry?.id)).filter(Boolean));
  const byId = new Map();
  const remap = new Map();
  const sections = [];
  for (const { entry } of ranked) {
    const section = readSection(entry, now);
    if (!section) continue;
    const prior = section.id ? byId.get(section.id) : null;
    if (prior && nameKey(prior.name) === nameKey(section.name)) continue;
    if (!section.id || prior || isReservedView(section.id)) {
      const id = uniqueId(section.id ?? toId(makeId()) ?? fallbackId(), used);
      if (isReservedView(section.id) && !remap.has(section.id)) remap.set(section.id, id);
      section.id = id;
    }
    used.add(section.id);
    byId.set(section.id, section);
    sections.push(section);
  }
  // The first section in display order keeps a contested name.
  const taken = new Set(RESERVED_NAMES.keys());
  const clashes = [];
  for (const s of sections) {
    const key = nameKey(s.name);
    if (taken.has(key)) clashes.push(s);
    else taken.add(key);
  }
  for (const s of clashes) {
    s.name = uniqueName(s.name, taken);
    taken.add(nameKey(s.name));
  }
  sections.forEach((s, i) => {
    s.order = i;
  });
  return { sections, remap };
}

/** Sections whose names are still free, for the suggestion chips. */
export function availableSuggestions(sections = []) {
  const taken = takenNames(Array.isArray(sections) ? sections : []);
  return SUGGESTED_SECTIONS.filter((s) => !taken.has(nameKey(s.name)));
}

/* ==========================================================================
   Sections: views
   ========================================================================== */

export function findSection(sections, id) {
  return (Array.isArray(sections) && id != null && sections.find((s) => s.id === id)) || null;
}

/** `view` when it still exists, else 'all'. */
export function resolveView(sections, view) {
  if (view === VIEW_ALL || view === VIEW_UNSORTED) return view;
  return typeof view === 'string' && findSection(sections, view) ? view : VIEW_ALL;
}

/** The state viewing `view` (validated); the same state when nothing changes. */
export function setView(state, view) {
  const next = resolveView(sectionsOf(state), view);
  return next === state.view ? state : { ...state, view: next };
}

/** The section a new note created in `view` belongs to: the viewed section, else null (Unsorted). */
export function viewSectionId(sections, view) {
  return isReservedView(view) ? null : findSection(sections, view)?.id ?? null;
}

/** 'All notes' | 'Unsorted' | the section's name ('All notes' for a missing section). */
export function viewLabel(sections, view) {
  return VIEW_LABELS[view] ?? findSection(sections, view)?.name ?? VIEW_LABELS[VIEW_ALL];
}

/** Every view in rail order: All notes, Unsorted, then the sections. */
export function viewOrder(sections) {
  return [VIEW_ALL, VIEW_UNSORTED, ...(Array.isArray(sections) ? sections : []).map((s) => s.id)];
}

/** The view `delta` steps from `view` in rail order ('[' / ']'); wraps around unless wrap is false. */
export function stepView(sections, view, delta, { wrap = true } = {}) {
  const order = viewOrder(sections);
  const from = order.indexOf(resolveView(sections, view));
  const step = Math.trunc(Number(delta)) || 0;
  const to = wrap ? (((from + step) % order.length) + order.length) % order.length : Math.max(0, Math.min(order.length - 1, from + step));
  return order[to];
}

/** Whether a note shows in `view` ('all' and a missing view show everything). */
export function noteInView(note, view) {
  if (!note) return false;
  if (view == null || view === VIEW_ALL) return true;
  if (view === VIEW_UNSORTED) return note.sectionId == null;
  return note.sectionId === view;
}

const termsOf = (query) => (Array.isArray(query) ? query : queryTerms(query));

/**
 * The notes of `view` that match the search, pinned first then most recently edited.
 * `query` is the search text, or terms already split by queryTerms().
 */
export function notesInView(items, view, query = '') {
  const terms = termsOf(query);
  return sortNotes((Array.isArray(items) ? items : []).filter((note) => noteInView(note, view) && matchesTerms(note, terms)));
}

/** How many notes outside `view` match the search (0 in All notes or without a query). */
export function otherMatches(items, view, query = '') {
  const terms = termsOf(query);
  if (!terms.length || view == null || view === VIEW_ALL) return 0;
  let count = 0;
  for (const note of Array.isArray(items) ? items : []) if (!noteInView(note, view) && matchesTerms(note, terms)) count += 1;
  return count;
}

/** { all, unsorted, bySection: { [id]: n } }; every section has an entry, notes of a missing section count as unsorted. */
export function sectionCounts(items, sections) {
  const bySection = Object.create(null);
  for (const s of Array.isArray(sections) ? sections : []) bySection[s.id] = 0;
  let all = 0;
  let unsorted = 0;
  for (const note of Array.isArray(items) ? items : []) {
    all += 1;
    if (note.sectionId != null && note.sectionId in bySection) bySection[note.sectionId] += 1;
    else unsorted += 1;
  }
  return { all, unsorted, bySection };
}

/* ==========================================================================
   Sections: state changes
   ========================================================================== */

/**
 * Add a section at the end.
 *   { state, section }   or   { error, code } when the name is refused (see validateSectionName)
 */
export function createSection(state, { name, icon = null, color = null } = {}, { now = Date.now(), makeId = fallbackId } = {}) {
  const sections = sectionsOf(state);
  const check = validateSectionName(name, sections);
  if (!check.ok) return { error: check.error, code: check.code };
  const used = new Set(sections.map((s) => s.id));
  const section = {
    id: uniqueId(toId(makeId()) ?? fallbackId(), used),
    name: check.name,
    icon: cleanSectionIcon(icon),
    createdAt: now,
    order: sections.length,
    ...(colorKey(color) ? { color: colorKey(color) } : {}),
  };
  return { state: { ...state, sections: [...sections, section] }, section };
}

/**
 * Change a section's name and/or icon (undefined keeps a field, icon null resets to the folder).
 *   { state, section }   or   { error, code } (code 'missing' when the section is gone)
 * Unchanged values return the same state.
 */
export function updateSection(state, id, { name, icon, color } = {}) {
  const sections = sectionsOf(state);
  const at = sections.findIndex((s) => s.id === id);
  if (at === -1) return { error: 'That section no longer exists.', code: 'missing' };
  const current = sections[at];
  let next = current;
  if (name !== undefined) {
    const check = validateSectionName(name, sections, id);
    if (!check.ok) return { error: check.error, code: check.code };
    if (check.name !== current.name) next = { ...next, name: check.name };
  }
  if (icon !== undefined) {
    const clean = cleanSectionIcon(icon);
    if (clean !== current.icon) next = { ...next, icon: clean };
  }
  // Color coding: a palette id, or null to clear it
  if (color !== undefined) next = withColor(next, color);
  if (next === current) return { state, section: current };
  return { state: { ...state, sections: sections.map((s, i) => (i === at ? next : s)) }, section: next };
}

/** { state, section } | { error, code } — see updateSection. */
export function renameSection(state, id, name) {
  return updateSection(state, id, { name });
}

/** The state with the section's icon changed (same state when unchanged or missing). */
export function setSectionIcon(state, id, icon) {
  return updateSection(state, id, { icon }).state ?? state;
}

/**
 * Remove a section. mode 'move' (default) sends its notes to Unsorted, untouched
 * otherwise; mode 'delete' removes them too. Viewing it switches to All notes, and
 * a deleted selected note clears the selection.
 *   { state, removed }  removed = { section, index, above, below, at, mode, notes, noteIndexes, view, selectedId }
 *                       (null and the same state when the section does not exist)
 * above / below are the ids around it (nearest last / first) and `at` the time, so
 * restoreSection() can put it back between the right neighbours. Pass `removed` to undo.
 */
export function deleteSection(state, id, mode = 'move', { now = Date.now() } = {}) {
  const sections = sectionsOf(state);
  const index = sections.findIndex((s) => s.id === id);
  if (index === -1) return { state, removed: null };
  const section = sections[index];
  const drop = mode === 'delete';
  const items = itemsOf(state);
  const notes = [];
  const noteIndexes = [];
  items.forEach((note, i) => {
    if (note.sectionId !== id) return;
    notes.push(note);
    noteIndexes.push(i);
  });
  const inSection = new Set(notes);
  let nextItems = items;
  if (notes.length) nextItems = drop ? items.filter((n) => !inSection.has(n)) : items.map((n) => (inSection.has(n) ? { ...n, sectionId: null } : n));
  return {
    state: {
      ...state,
      items: nextItems,
      sections: reindex(sections.filter((s) => s !== section)),
      view: state.view === id ? VIEW_ALL : state.view,
      selectedId: drop && notes.some((n) => n.id === state.selectedId) ? null : state.selectedId,
    },
    removed: {
      section,
      index,
      above: sections.slice(0, index).map((s) => s.id),
      below: sections.slice(index + 1).map((s) => s.id),
      at: now,
      mode: drop ? 'delete' : 'move',
      notes,
      noteIndexes,
      view: state.view,
      selectedId: state.selectedId,
    },
  };
}

/**
 * Where a deleted section goes back: below the nearest section that was above it and
 * above the nearest one that was below it. Sections in between that it never saw (deleted
 * before it, restored since) stay above it; sections created after the delete stay below.
 * That keeps the order exact for undo in any order unless an older delete sat below it.
 * Records without neighbours fall back to the old index.
 */
function restorePosition(sections, removed) {
  const { above, below } = removed;
  if (!Array.isArray(above) || !Array.isArray(below)) {
    return Number.isInteger(removed.index) ? Math.max(0, Math.min(removed.index, sections.length)) : sections.length;
  }
  const pos = new Map(sections.map((s, i) => [s.id, i]));
  let lower = 0;
  for (let i = above.length - 1; i >= 0; i -= 1) {
    if (pos.has(above[i])) {
      lower = pos.get(above[i]) + 1;
      break;
    }
  }
  let upper = sections.length;
  for (const id of below) {
    if (pos.has(id)) {
      upper = pos.get(id);
      break;
    }
  }
  // Reordered meanwhile so the neighbours swapped: stay below the one that was above.
  if (upper < lower) return lower;
  const at = Number.isFinite(removed.at) ? removed.at : Infinity;
  let to = lower;
  while (to < upper && !(sections[to].createdAt > at)) to += 1;
  return to;
}

/**
 * Undo deleteSection: the section returns to its old place (see restorePosition; renamed
 * 'Name 2' if the name was taken meanwhile). 'move': its notes that are still Unsorted go back
 * (later moves and edits win). 'delete': its notes return at their old positions
 * unless a note with that id exists. View and selection come back when they are
 * still what the delete left. A section that already exists makes this a no-op.
 */
export function restoreSection(state, removed) {
  const section = removed?.section;
  const sections = sectionsOf(state);
  if (!section || typeof section.id !== 'string' || findSection(sections, section.id)) return state;

  const name = uniqueName(section.name, takenNames(sections));
  const nextSections = [...sections];
  nextSections.splice(restorePosition(sections, removed), 0, name === section.name ? section : { ...section, name });

  const notes = Array.isArray(removed.notes) ? removed.notes : [];
  let items = itemsOf(state);
  if (removed.mode === 'delete') {
    items = [...items];
    const present = new Set(items.map((n) => n.id));
    const indexes = Array.isArray(removed.noteIndexes) ? removed.noteIndexes : [];
    notes
      .map((note, k) => ({ note, pos: Number.isInteger(indexes[k]) && indexes[k] >= 0 ? indexes[k] : Infinity }))
      .sort((a, b) => a.pos - b.pos)
      .forEach(({ note, pos }) => {
        if (!note || present.has(note.id)) return;
        items.splice(Math.min(pos, items.length), 0, note.sectionId === section.id ? note : { ...note, sectionId: section.id });
        present.add(note.id);
      });
  } else {
    const ids = new Set(notes.map((n) => n?.id));
    if (ids.size) items = items.map((n) => (ids.has(n.id) && n.sectionId == null ? { ...n, sectionId: section.id } : n));
  }

  const selectedBack = state.selectedId == null && removed.selectedId != null && items.some((n) => n.id === removed.selectedId);
  return {
    ...state,
    items,
    sections: reindex(nextSections),
    view: removed.view === section.id && state.view === VIEW_ALL ? section.id : state.view,
    selectedId: selectedBack ? removed.selectedId : state.selectedId,
  };
}

/**
 * File a note under `sectionId` (null or 'unsorted' = Unsorted). Its updatedAt is kept so
 * it holds its place in recency order. Same state when nothing changes, the note is
 * missing or the section does not exist.
 */
export function moveNoteToSection(state, noteId, sectionId) {
  const target = sectionId == null || sectionId === VIEW_UNSORTED ? null : sectionId;
  if (target !== null && !findSection(sectionsOf(state), target)) return state;
  const items = itemsOf(state);
  const at = items.findIndex((n) => n.id === noteId);
  if (at === -1 || (items[at].sectionId ?? null) === target) return state;
  const next = [...items];
  next[at] = { ...items[at], sectionId: target };
  return { ...state, items: next };
}

/**
 * Undo of a note move (from section `from` to `to`, null or 'unsorted' = Unsorted): file the
 * note back under `from`, but only while it is still where that move put it. A note moved
 * again since (in this tab or another) is left alone, so Undo never overwrites a newer move.
 * When `from` was deleted meanwhile the note goes to Unsorted, as that delete would have sent it.
 *   -> { state, status: 'done' | 'refiled' | 'moved' | 'gone' }  (the same state for moved / gone)
 */
export function undoNoteMove(state, noteId, from, to) {
  const unsorted = (id) => (id == null || id === VIEW_UNSORTED ? null : id);
  const note = itemsOf(state).find((n) => n.id === noteId);
  if (!note) return { state, status: 'gone' };
  if ((note.sectionId ?? null) !== unsorted(to)) return { state, status: 'moved' };
  const home = unsorted(from);
  const back = home !== null && !findSection(sectionsOf(state), home) ? null : home;
  return { state: moveNoteToSection(state, noteId, back), status: back === home ? 'done' : 'refiled' };
}

/**
 * Undo of a note delete: `items` with `note` back at `index`, where it was stored (clamped;
 * at the end when the index is unknown), so the saved list reads exactly as before. A note
 * whose id is present again is not added twice.
 */
export function restoreNoteAt(items, note, index) {
  const list = Array.isArray(items) ? items : [];
  if (!note || list.some((n) => n.id === note.id)) return list;
  const at = Number.isInteger(index) && index >= 0 ? Math.min(index, list.length) : list.length;
  return [...list.slice(0, at), note, ...list.slice(at)];
}

/** Move a section to position `index` (0-based final position, clamped). Same state on a no-op. */
export function moveSectionTo(state, id, index) {
  const sections = sectionsOf(state);
  const from = sections.findIndex((s) => s.id === id);
  if (from === -1 || typeof index !== 'number' || Number.isNaN(index)) return state;
  const to = Math.max(0, Math.min(sections.length - 1, Math.trunc(index)));
  if (to === from) return state;
  const next = [...sections];
  next.splice(to, 0, ...next.splice(from, 1));
  return { ...state, sections: reindex(next) };
}

/** Move a section `delta` places (-1 up, +1 down), clamped at the ends. */
export function moveSection(state, id, delta) {
  const from = sectionsOf(state).findIndex((s) => s.id === id);
  if (from === -1 || typeof delta !== 'number' || Number.isNaN(delta)) return state;
  return moveSectionTo(state, id, from + Math.trunc(delta));
}

/* ==========================================================================
   Ordering & search
   ========================================================================== */

/** Pinned first, then most recently edited. */
export function compareNotes(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortNotes(items) {
  return [...items].sort(compareNotes);
}

/** 'Grocery  LIST' -> ['grocery', 'list'] (lowercased, unique). */
export function queryTerms(query) {
  return [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
}

/** Every term must appear somewhere in the title or body (case-insensitive). */
export function matchesTerms(note, terms) {
  if (!terms.length) return true;
  const haystack = `${note.title ?? ''}\n${note.body ?? ''}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterNotes(items, query) {
  const terms = queryTerms(query);
  return terms.length ? items.filter((note) => matchesTerms(note, terms)) : items.slice();
}

/**
 * The note to open after `id` is removed from the ordered `list`: the one below
 * it, else the one above, else null. Notes are matched by id.
 */
export function pickNeighbor(list, id) {
  const at = list.findIndex((note) => note.id === id);
  if (at === -1) return list[0] ?? null;
  return list[at + 1] ?? list[at - 1] ?? null;
}

/**
 * Split text into plain and matching runs for highlighting:
 * highlight('Buy milk', ['mil']) -> [{ text: 'Buy ', hit: false }, { text: 'mil', hit: true }, { text: 'k', hit: false }]
 */
export function highlight(text, terms) {
  const str = String(text ?? '');
  const plain = [{ text: str, hit: false }];
  if (!str || !terms?.length) return plain;
  const lower = str.toLowerCase();
  // A few characters change length when lowercased; skip highlighting rather than misalign.
  if (lower.length !== str.length) return plain;

  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) ranges.push([i, i + term.length]);
  }
  if (!ranges.length) return plain;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const out = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos) out.push({ text: str.slice(pos, start), hit: false });
    out.push({ text: str.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < str.length) out.push({ text: str.slice(pos), hit: false });
  return out;
}

/* ==========================================================================
   Text
   ========================================================================== */

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** Markdown -> one line of readable plain text. `separator` joins the source lines. */
export function toPlainText(md, { separator = ' ' } = {}) {
  // Park backslash-escaped characters so the syntax strippers cannot see them.
  const escaped = [];
  return String(md ?? '')
    .replace(/[\uE000\uE001]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, (_, ch) => `\uE000${escaped.push(ch) - 1}\uE001`)
    .split(/\r\n?|\n/)
    .filter((line) => !FENCE_LINE.test(line) && !RULE_LINE.test(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:>\s?)+/, '')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\](?:\s+|$))?/, ''),
    )
    .filter((line) => line.trim())
    .join(separator)
    // Labels stop at '[' and URLs allow one level of parens, so this stays linear.
    .replace(/!?\[([^\][]*)\]\(\s*(?:[^()\s]|\([^()\s]*\))*\s*\)/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/(\*\*\*|\*\*|__|~~)(?=\S)(.+?)\1/g, '$2')
    .replace(/\*(?=\S)([^*]+?)\*/g, '$1')
    .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1$2')
    .replace(/\uE000(\d+)\uE001/g, (_, n) => escaped[Number(n)] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ' · ' keeps list items and headings readable once flattened to one line.
const flatten = (md) => toPlainText(md, { separator: ' · ' });

// Rows show ~140 characters, so very long notes flatten only a leading slice
// (cut at a line break) instead of the whole body on every keystroke.
const EXCERPT_SCAN = 8000;

function plainLead(body, need) {
  const src = String(body ?? '');
  const cut = src.length > EXCERPT_SCAN * 2 ? src.indexOf('\n', EXCERPT_SCAN) : -1;
  if (cut !== -1) {
    const text = flatten(src.slice(0, cut));
    if (text.length > need) return text;
  }
  return flatten(src);
}

/**
 * Short plain-text preview of a note body.
 * - skip: drop a leading copy of the title (bodies often start with '# Title')
 * - terms: when the first match sits deep in the text, start the excerpt near it
 */
export function excerpt(body, { length = EXCERPT_LENGTH, terms = [], skip = '' } = {}) {
  const lead = String(skip ?? '').trim().toLowerCase();
  // Searching needs the whole text; otherwise a leading slice is enough.
  let text = terms.length ? flatten(body) : plainLead(body, lead.length + length + 8);
  if (lead && text.toLowerCase().startsWith(lead)) {
    const next = text.charAt(lead.length);
    if (!next || /[\s:.,;!?·\-–—]/.test(next)) text = text.slice(lead.length).replace(/^[\s:.,;!?·\-–—]+/, '');
  }
  if (!text) return '';

  let start = 0;
  if (terms.length) {
    const lower = text.toLowerCase();
    const hits = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0);
    const first = hits.length ? Math.min(...hits) : -1;
    if (first > length * 0.5) {
      const space = text.lastIndexOf(' ', first - 24);
      start = space > 0 ? space + 1 : Math.max(0, first - 24);
    }
  }

  let out = text.slice(start, start + length);
  if (start + length < text.length) out = `${out.replace(/\s+\S*$/, '')}…`;
  return start > 0 ? `…${out}` : out;
}

const WORD = /[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu;
const LIST_MARK = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\](?=[ \t]|$))?/gm;

/** Words = runs of letters/digits; markdown symbols and list markers ("1.", "- [x]") do not count. */
export function countWords(text) {
  return (String(text ?? '').replace(LIST_MARK, ' ').match(WORD) || []).length;
}

/** Characters as people see them (astral symbols such as emoji count once). */
export function countChars(text) {
  const s = String(text ?? '');
  return s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []).length;
}

/** 1234567 -> '1,234,567' */
export function groupDigits(n) {
  return String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact HUD readout: 950 -> '950', 1250 -> '1.2K', 48200 -> '48K', 2300000 -> '2.3M' */
export function formatCount(n) {
  const v = Math.max(0, Math.trunc(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return `${(Math.floor(v / 100) / 10).toFixed(1).replace(/\.0$/, '')}K`;
  if (v < 1e6) return `${Math.floor(v / 1000)}K`;
  return `${(Math.floor(v / 1e5) / 10).toFixed(1).replace(/\.0$/, '')}M`;
}

/** One-line copy of user text for dialogs and toasts: whitespace collapsed, at most `max` symbols. */
export function clip(text, max = 60) {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  let out = chars.slice(0, max - 1).join('');
  // Prefer ending on a whole word when one ends close to the cut.
  const space = out.lastIndexOf(' ');
  if (space > out.length * 0.6) out = out.slice(0, space);
  return `${out.trimEnd()}…`;
}

/* ==========================================================================
   Editor: Enter inside a list or quote
   ========================================================================== */

const LIST_LINE = /^([ \t]*(?:>[ \t]?)*[ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\](?:[ \t]+|$))?(.*)$/;
const QUOTE_LINE = /^([ \t]*(?:>[ \t]?)+)(.*)$/;

/**
 * What Enter should do given the current line split at the caret.
 *   { insert: '\n- ' }  continue the list/quote (numbers increment, tasks reset to [ ])
 *   { clear: n }        the item is empty: remove its n-char marker to end the list
 *   null                not in a list; let the browser insert a plain newline
 */
export function continueList(before, after = '') {
  // '* * *' and '- - -' are horizontal rules, not list items.
  if (RULE_LINE.test(before + after)) return null;
  const item = LIST_LINE.exec(before);
  if (item) {
    const [, lead, marker, num, delim, gap, task, rest] = item;
    if (!rest.trim() && !after.trim()) return { clear: before.length };
    const next = num ? `${Number(num) + 1}${delim}` : marker;
    return { insert: `\n${lead}${next}${gap}${task ? '[ ] ' : ''}` };
  }
  const quote = QUOTE_LINE.exec(before);
  if (quote) {
    if (!quote[2].trim() && !after.trim()) return { clear: before.length };
    return { insert: `\n${quote[1]}` };
  }
  return null;
}

/* ==========================================================================
   First-run content
   ========================================================================== */

export const WELCOME_NOTE = {
  title: 'Welcome to LIFE/OS',
  body: [
    '# Welcome to LIFE/OS',
    '',
    'Your personal mission control for **tasks**, **notes** and **daily habits**. Everything stays on this device, stored locally in your browser.',
    '',
    '## How notes work',
    '- Notes save automatically while you type',
    '- Pin the important ones to keep them on top',
    '- File notes into **sections** such as *TikTok ideas* or *YouTube ideas* with the section button above the title',
    '- Switch to **Preview** to see the formatted result',
    '- An empty note disappears when you leave it',
    '',
    '## Markdown cheatsheet',
    '**Bold**, *italic*, ~~strikethrough~~ and `inline code`.',
    'Links like [the CommonMark guide](https://commonmark.org/help/) open in a new tab.',
    '',
    '1. Numbered lists',
    '2. Count for you',
    '',
    '- [x] Open this note',
    '- [ ] Tick a box in Preview to update the text',
    '- [ ] Write your first note',
    '',
    '> Quotes hold the ideas worth remembering.',
    '',
    '```js',
    "const focus = 'one thing at a time';",
    '```',
    '',
    '---',
    '',
    '### Shortcuts',
    '`N` new note · `/` search · `[` `]` switch sections · `B` board layout · `⌘/Ctrl S` save now · `⌘/Ctrl E` preview · `Esc` leave the editor · `1` `2` `3` `4` switch modules',
    '',
    'Delete this note whenever you like. It will not come back.',
  ].join('\n'),
};
