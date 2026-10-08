// LIFE/OS — Notes: a markdown notebook with sections (folders) and autosave.
//
// Rendering rule: the list re-renders from state on every change, but the
// editor's title input and textarea are built once per mount and only get new
// values when a different note is opened, so typing never moves the caret or
// breaks IME composition. Live typing updates the list item and meta in place.
//
// Sections: ui.view is this tab's view (All notes, Unsorted or a section) and the
// list shows only that view. Switching views opens the view's first note, unless
// the open note belongs there too. A note moved out of the view stays open in the
// editor, so filing a note never yanks it away mid-thought.
//
// Layouts: ui.layout is this tab's layout. 'list' is rail · list · editor; 'board'
// (notes.board.js) shows every section as a column of cards and opens a note in the
// same editor, as a panel over the board's right side (full screen on phones). In the
// board ui.pane === 'editor' means that panel is open.

import {
  h,
  icon,
  pageHeader,
  emptyState,
  toast,
  confirmDialog,
  timeAgo,
  formatDay,
  dateKey,
  onDayChange,
  uid,
  idx,
  num,
  term,
  plural,
  debounce,
  isTyping,
  modalOpen,
} from '../ui.js';
import { createStore } from '../store.js';
import {
  WELCOME_NOTE,
  VIEW_ALL,
  VIEW_UNSORTED,
  createNote,
  isBlank,
  normalizeState,
  queryTerms,
  highlight,
  excerpt,
  countWords,
  countChars,
  groupDigits,
  formatCount,
  continueList,
  pickNeighbor,
  clip,
  findSection,
  resolveView,
  viewSectionId,
  viewLabel,
  stepView,
  noteInView,
  notesInView,
  otherMatches,
  sectionCounts,
  createSection,
  updateSection,
  renameSection,
  deleteSection,
  restoreSection,
  moveNoteToSection,
  undoNoteMove,
  restoreNoteAt,
  setView,
  moveSectionTo,
  moveSection,
  LAYOUT_LIST,
  LAYOUT_BOARD,
  normalizeLayout,
  setLayout as withLayout,
  toggleCollapsed,
} from './notes.logic.js';
import { columnOf, columnSection } from './notes.board.logic.js';
import { registerContextProvider } from '../contextmenu.js';
import { paintColor, colorButton, colorKey } from '../colors.js';
import { splitText, copyName, pasteName } from '../contextmenu.logic.js';
import { createBoard } from './notes.board.js';
import { renderMarkdown, toggleTask } from './notes.markdown.js';
import {
  ALT_KEY,
  hint,
  viewIconName,
  glyphOf,
  createSectionNav,
  createNoteDrag,
  openSectionMenu,
  openSectionEditor,
  openDeleteSection,
  openManageSections,
} from './notes.sections.js';

const SAVE_DELAY = 400;
const CLOCK_MS = 30000;
const SINGLE_PANE = '(max-width: 900px)';
// The board keeps its note panel beside the columns down to tablet width; phones open it full screen.
const BOARD_FULL = '(max-width: 640px)';
const MOD_KEY = /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '') ? '⌘' : 'Ctrl';
const UNDO_MS = 6000;
const UNDO_KEY_MS = 60000; // ⌘/Ctrl+Z reaches the latest Undo for a minute, as in the Calendar
const TITLE_SIZES_ITSELF = !!globalThis.CSS?.supports?.('field-sizing', 'content');

/* ==========================================================================
   State (module singleton: mount() and badge() share it)
   ========================================================================== */

const store = createStore('notes', { items: [], sections: [], view: VIEW_ALL, selectedId: null, seeded: false });

// The store can hand back raw data (first load, another tab, older saves), so
// normalize once per distinct state object.
let memoRaw;
let memoState;

function getState() {
  const raw = store.get();
  if (raw !== memoRaw) {
    memoRaw = raw;
    memoState = normalizeState(raw, { makeId: uid });
  }
  return memoState;
}

/** Replace the state with an already-valid value. */
function save(next) {
  memoRaw = next;
  memoState = next;
  storageInSync = store.set(next) !== false;
}

/** save(fn(state)) unless fn returns null. */
function commit(fn) {
  const next = fn(getState());
  if (next) save(next);
}

/** save(fn(state)) only when fn returns a different state; true when something changed. */
function commitIfChanged(fn) {
  const s = getState();
  const next = fn(s);
  if (!next || next === s) return false;
  save(next);
  return true;
}

function findNote(id, state = getState()) {
  return id ? state.items.find((n) => n.id === id) ?? null : null;
}

/**
 * Write a title/body edit. No-op when nothing changed or the note is gone.
 *
 * Deleted in another tab while an edit is pending (the 400ms autosave window): the
 * edit is dropped, never written back. Writing it would save this tab's stale copy of
 * the whole notebook and resurrect the note as a ghost; recreating it would quietly undo
 * a delete the user just made on purpose (that tab's toast offers Undo). render() then
 * tells the user what happened (see noteVanished).
 */
function persist(id, title, body) {
  const s = getState();
  const note = findNote(id, s);
  if (!note || (note.title === title && note.body === body)) return false;
  if (deletedElsewhere(id)) return false;
  save({ ...s, items: s.items.map((n) => (n.id === id ? { ...n, title, body, updatedAt: Date.now() } : n)) });
  return true;
}

// The store's localStorage key (see store.js: `lifeos:v1:<key>`).
const STORAGE_KEY = `lifeos:v1:${store.key}`;
// False after a failed write (quota, private mode): storage no longer mirrors this tab,
// so a note missing there proves nothing about other tabs.
let storageInSync = true;

/**
 * True when another tab has already removed note `id` from storage but its `storage`
 * event has not reached this tab yet (a debounced save can fire in that gap).
 */
function deletedElsewhere(id) {
  if (!storageInSync) return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Fast path: the note's own `"id":"…"` pair is still in the saved JSON (quotes inside
    // note text are escaped, so body text cannot fake this match).
    if (raw == null || raw.includes(`"id":${JSON.stringify(id)}`)) return false;
    const saved = JSON.parse(raw);
    const items = Array.isArray(saved) ? saved : saved?.items;
    return Array.isArray(items) && !items.some((n) => n && String(n.id) === id);
  } catch {
    return false;
  }
}

/** `items` minus note `id` when that note is blank (leaving an empty note discards it). */
function withoutBlank(items, id) {
  const note = id ? items.find((n) => n.id === id) : null;
  return note && isBlank(note) ? items.filter((n) => n !== note) : items;
}

function dropIfBlank(id) {
  const s = getState();
  const items = withoutBlank(s.items, id);
  if (items === s.items) return false;
  save({ ...s, items, selectedId: s.selectedId === id ? null : s.selectedId });
  return true;
}

function pruneBlankNotes() {
  const s = getState();
  const items = s.items.filter((n) => !isBlank(n));
  if (items.length === s.items.length) return;
  save({ ...s, items, selectedId: items.some((n) => n.id === s.selectedId) ? s.selectedId : null });
}

/** A note coming back (Undo) whose section has gone since lands in Unsorted. */
function refiled(note, s) {
  return note.sectionId == null || findSection(s.sections, note.sectionId) ? note : { ...note, sectionId: null };
}

/** How many notes a view holds, from sectionCounts(). */
function viewCount(counts, view) {
  if (view === VIEW_ALL) return counts.all;
  if (view === VIEW_UNSORTED) return counts.unsorted;
  return counts.bySection[view] ?? 0;
}

// Header word total, cached per (immutable) note object.
const wordCache = new WeakMap();
function wordsIn(note) {
  let n = wordCache.get(note);
  if (n == null) {
    n = countWords(note.title) + countWords(note.body);
    wordCache.set(note, n);
  }
  return n;
}

let justSeeded = false;
let editorMode = 'edit'; // 'edit' | 'preview'; survives navigation within a session

function init() {
  const raw = store.get();
  let state = getState();
  if (!state.seeded) {
    const welcome = createNote({ id: uid(), ...WELCOME_NOTE });
    state = { ...state, items: [welcome, ...state.items], selectedId: welcome.id, seeded: true };
    justSeeded = true;
  }
  // Persist repairs (and the seed) so ids and timestamps stay stable.
  if (JSON.stringify(state) !== JSON.stringify(raw)) save(state);
}

try {
  init();
} catch (err) {
  console.error('[notes] could not initialise', err);
}

// notesApi.reveal() (bottom of file): the note the next Notes view should open
const REVEAL_TTL_MS = 10000; // a request no Notes view picked up by then is stale
let pendingReveal = null; // { id, at }
let revealInView = null; // set while the Notes view is mounted, so a reveal there acts at once

/* ==========================================================================
   Small DOM helpers
   ========================================================================== */

const pad2 = (n) => String(n).padStart(2, '0');

function formatStamp(ts) {
  const d = new Date(ts);
  return `${formatDay(dateKey(d))} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Label above value, the order the Tasks stats and Habits readouts use. */
function statBlock(label, valueEl) {
  return h('div', { class: 'stat nt-stat' }, h('span', { class: 'label' }, label), valueEl);
}

/** User text dropped into a sentence (toasts, dialogs), isolated so its direction cannot reorder the copy around it. */
const bdi = (text) => h('bdi', null, text);

function marked(text, terms) {
  return highlight(text, terms).map((seg) => (seg.hit ? h('mark', { class: 'nt-hit' }, seg.text) : seg.text));
}

/** Restart a CSS animation class. */
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Set a field's value without throwing the caret to the end. */
function setValueKeepCaret(el, value) {
  if (el.value === value) return false;
  if (document.activeElement !== el) {
    el.value = value;
    return true;
  }
  const { selectionStart, selectionEnd } = el;
  el.value = value;
  el.setSelectionRange(Math.min(selectionStart, value.length), Math.min(selectionEnd, value.length));
  return true;
}

function scrollRatio(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

/** isTyping(), except a focused preview checkbox does not swallow shortcuts. */
function typing(e) {
  const t = e.target;
  return isTyping(e) && !(t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio'));
}

/** True when focus has fallen back to the page (its element was removed or hidden). */
function focusLost() {
  const active = document.activeElement;
  return !active || active === document.body || (active instanceof HTMLElement && !active.isConnected);
}

/* ==========================================================================
   View
   ========================================================================== */

function mount(root) {
  root.classList.add('nt-view');
  const singlePane = window.matchMedia(SINGLE_PANE);
  const boardFull = window.matchMedia(BOARD_FULL);

  // An empty note can be left behind when a tab closes mid-edit.
  pruneBlankNotes();

  const initial = getState();
  const ui = {
    pane: 'list', // which pane shows in single-pane (<=900px) mode
    view: initial.view, // this tab's view: 'all', 'unsorted' or a section id
    viewName: viewLabel(initial.sections, initial.view), // kept for "deleted in another tab"
    query: '',
    terms: [],
    selectedId: null, // this tab's selection
    editorId: null, // note currently loaded into the inputs
    pendingId: null, // note with an unsaved (debounced) edit
    previewSource: null, // body the preview was last rendered from
    menu: null, // the open section picker
    refocus: false, // the editor dropped focus while emptying; render() gives it a new home
    layout: initial.layout, // this tab's layout: 'list' or 'board'
  };
  const isBoard = () => ui.layout === LAYOUT_BOARD;
  // The open note fills the screen (Back returns): the list's single pane, the board on phones.
  const editorFull = () => (isBoard() ? boardFull.matches : singlePane.matches);
  // The editor is on screen: always in the list; on the board only while its panel is open.
  const editorShown = () => !!ui.editorId && (!isBoard() || ui.pane === 'editor');
  root.dataset.layout = ui.layout;
  // Reopen the last note when it belongs to the view; otherwise render opens the view's first note.
  const lastOpen = findNote(initial.selectedId, initial);
  if (lastOpen && noteInView(lastOpen, ui.view)) ui.selectedId = lastOpen.id;

  const itemCache = new Map(); // note id -> { li, btn, note, index, selected, key, section, dirty }
  let disposed = false;
  let firstRender = true;
  let listRendered = false; // rows added after the list's first paint animate in
  let frame = 0;
  let flashTimer = 0;
  let moveSig = null;
  let lastUndo = null; // { run, expires }: the latest toast Undo, for ⌘/Ctrl+Z

  if (justSeeded) {
    editorMode = 'preview'; // first impression: show the welcome note rendered
    justSeeded = false;
  }

  const saver = debounce((id, title, body) => {
    ui.pendingId = null;
    persist(id, title, body);
    setStatus('saved');
  }, SAVE_DELAY);
  const flushSave = () => saver.flush();

  /* ---- Sections navigation (rail on wide workspaces, chip strip on narrow ones) ---- */

  const nav = createSectionNav({
    onView: (view) => switchView(view),
    onCreate: () => newSection(),
    onSuggest: (fields) => addSection(fields),
    onManage: () => manageSections(),
    onEdit: (id) => editSection(id),
    onDelete: (id) => confirmDeleteSection(id),
    onRename: (id, name) => renameSectionTo(id, name),
    onRenameRefused: (id, error) => renameRefused(id, error),
    onReorder: (id, index) => reorderSection(id, (s) => moveSectionTo(s, id, index)),
    onMoveBy: (id, delta) => reorderSection(id, (s) => moveSection(s, id, delta), delta),
  });

  const noteDrag = createNoteDrag({
    nav,
    host: root,
    titleOf: (id) => clip(findNote(id)?.title ?? '', 40) || 'Untitled',
    homeOf: (id) => findNote(id)?.sectionId ?? VIEW_UNSORTED,
    labelOf: (view) => viewLabel(getState().sections, view),
    onDrop: (id, view) => moveNote(id, view === VIEW_UNSORTED ? null : view),
  });

  const board = createBoard({
    host: root,
    onOpen: (id, { keyboard }) => openCard(id, { keyboard }),
    onMove: (id, column) => moveNote(id, columnSection(column)),
    onMenu: (id, anchor, { keyboard }) => toggleCardMenu(id, anchor, { keyboard }),
    onNew: (column) => newNote({ column }),
    onNewSection: () => newSection(),
    onToggleCollapse: (column) => toggleColumn(column),
    onPick: (column) => pickColumn(column),
    onAnnounce: (text) => announce(text),
    // The editor panel covers the board's right side except on phones. From layout sizes,
    // not its box: the panel's slide-in transform would put that edge 24px too far right.
    coverLeft: () => {
      if (!isBoard() || ui.pane !== 'editor' || boardFull.matches || editorPanel.offsetParent === null) return null;
      return editorPanel.parentElement.getBoundingClientRect().right - editorPanel.offsetWidth;
    },
  });

  /* ---- Header ---- */

  const statNotes = h('span', { class: 'stat-value' });
  const statSections = h('span', { class: 'stat-value' });
  const statPinned = h('span', { class: 'stat-value' });
  const statWords = h('span', { class: 'stat-value' });

  // List · Board: each tab keeps its own; the last choice is what a new tab opens with.
  const layoutBtn = (layout, iconName, label) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': String(ui.layout === layout),
        'aria-keyshortcuts': 'B',
        title: `${label} layout (B)`,
        onClick: () => setLayout(layout),
      },
      icon(iconName, { size: 12 }),
      label,
    );
  const layoutList = layoutBtn(LAYOUT_LIST, 'list', 'List');
  const layoutBoard = layoutBtn(LAYOUT_BOARD, 'nt-board', 'Board');
  const layoutSeg = h('div', { class: 'seg nt-layout', role: 'group', 'aria-label': 'Layout' }, layoutList, layoutBoard);

  const header = pageHeader({
    index: '03',
    title: 'Notes',
    subtitle: term('notes.subtitle', 'Ideas, plans and references in markdown. Saved as you type.'),
    actions: [
      layoutSeg,
      h(
        'div',
        { class: 'nt-stats lo-deco', role: 'group', 'aria-label': 'Notebook totals' },
        statBlock('Notes', statNotes),
        statBlock('Sections', statSections),
        statBlock('Pinned', statPinned),
        statBlock('Words', statWords),
      ),
    ],
  });

  /* ---- List panel ---- */

  const newBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary btn--block nt-new', 'aria-label': 'New note', 'aria-keyshortcuts': 'N', onClick: () => newNote() },
    icon('plus'),
    h('span', null, 'New note'),
    h('span', { class: 'kbd nt-kbd-inv lo-hint', 'aria-hidden': 'true' }, 'N'),
  );

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search notes',
    'aria-label': 'Search notes',
    'aria-keyshortcuts': '/ Control+K Meta+K',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    onInput: () => setQuery(searchInput.value),
    onKeydown: onSearchKey,
  });
  const searchClear = h(
    'button',
    {
      type: 'button',
      class: 'nt-search-clear',
      'aria-label': 'Clear search',
      hidden: true,
      onClick: () => {
        setQuery('');
        searchInput.focus();
      },
    },
    icon('x', { size: 14 }),
  );
  const search = h(
    'div',
    { class: 'input-group nt-search', role: 'search' },
    icon('search'),
    searchInput,
    h('span', { class: 'kbd nt-search-kbd lo-hint', 'aria-hidden': 'true' }, '/'),
    searchClear,
  );

  const listCount = h('span', { class: 'label nt-list-count' });
  const pinnedCount = h('span', { class: 'nt-group-count' });
  const notesCount = h('span', { class: 'nt-group-count' });
  const pinnedHead = h('div', { class: 'nt-group label' }, icon('pin', { size: 12 }), h('span', null, 'Pinned'), pinnedCount);
  const notesHead = h('div', { class: 'nt-group label' }, h('span', null, 'Notes'), notesCount);
  const pinnedList = h('ul', { class: 'nt-items', role: 'list', 'aria-label': 'Pinned notes' });
  const notesList = h('ul', { class: 'nt-items', role: 'list', 'aria-label': 'Notes' });
  const noMatch = emptyState({
    icon: 'search',
    title: 'No matches',
    text: ' ', // filled in per query below
    action: h(
      'button',
      {
        type: 'button',
        class: 'btn btn--sm',
        onClick: () => {
          setQuery('');
          searchInput.focus();
        },
      },
      'Clear search',
    ),
  });
  noMatch.classList.add('nt-nomatch');
  const noMatchText = noMatch.querySelector('.empty-text');

  const escHint = hint(['Esc'], 'Exit editor');

  // An empty view: "No notes in TikTok ideas yet" + a button that starts one there.
  const viewEmptyLabel = h('span');
  const viewEmpty = emptyState({
    icon: 'nt-folder',
    title: ' ',
    text: ' ',
    action: h('button', { type: 'button', class: 'btn btn--sm btn--primary nt-viewempty-btn', onClick: () => newNote() }, icon('plus'), viewEmptyLabel),
  });
  viewEmpty.classList.add('nt-nomatch', 'nt-viewempty');
  const viewEmptyIcon = viewEmpty.querySelector('.empty-icon');
  const viewEmptyTitle = viewEmpty.querySelector('.empty-title');
  const viewEmptyText = viewEmpty.querySelector('.empty-text');

  // Search inside a section: "3 more in other sections — Show all".
  const elsewhereText = h('span', { class: 'nt-elsewhere-text' });
  const elsewhere = h(
    'div',
    { class: 'nt-elsewhere' },
    icon('search', { size: 12 }),
    elsewhereText,
    h('button', { type: 'button', class: 'btn btn--sm nt-elsewhere-btn', onClick: () => switchView(VIEW_ALL) }, 'Show all'),
  );

  const listBody = h('div', { class: 'nt-list-body', onKeydown: onListKey, onPointerdown: (e) => noteDrag.onPointerDown(e) });
  listBody.addEventListener('animationend', () => listBody.classList.remove('is-swapping'));

  // New note + search sit in the list's head, or in the board's toolbar (placeTools()).
  const listHead = h('div', { class: 'nt-list-head' }, newBtn, search);
  const listPanel = h(
    'section',
    { class: 'panel hud nt-list', 'aria-label': 'Notes list' },
    listHead,
    h('div', { class: 'nt-list-meta' }, listCount, h('span', { class: 'label faint' }, 'Recent first')),
    listBody,
    // The search field shows its own '/' key, so the footer keeps to one line.
    h('div', { class: 'nt-foot nt-hints label' }, hint(['N'], 'New'), hint(['↑', '↓'], 'Browse'), hint(['B'], 'Board')),
  );

  /* ---- Board panel ---- */

  // Toolbar: New note + search, the column pager (the drop dock while a card is lifted), Manage.
  const boardTools = h('div', { class: 'nt-board-tools' });
  const boardCount = h('span', { class: 'nt-board-count' });
  const boardPanel = h(
    'section',
    { class: 'panel hud nt-board', 'aria-label': 'Notes board' },
    h(
      'div',
      { class: 'nt-board-head' },
      boardTools,
      board.pager,
      h(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--icon btn--sm nt-board-manage', 'aria-label': 'Manage sections', title: 'Manage sections', onClick: () => manageSections() },
        icon('nt-sliders'),
      ),
    ),
    board.el,
    h(
      'div',
      { class: 'nt-foot nt-hints label' },
      hint(['←', '→', '↑', '↓'], 'Browse'),
      hint([ALT_KEY, '←', '→'], 'Move'),
      hint(['M'], 'Move to…'),
      hint(['N'], 'New'),
      hint(['B'], 'List'),
      h(
        'span',
        { class: 'nt-board-meta', title: 'Cards in a column keep this order: moving a card only changes its section' },
        boardCount,
        h('span', { class: 'faint nt-board-order' }, 'Newest first'),
        h('span', { class: 'faint nt-board-tip' }, 'Drag a card onto a column or a chip above'),
      ),
    ),
  );

  /* ---- Editor panel ---- */

  const backLabel = h('span', { class: 'nt-back-label' }, 'Notes');
  const backBtn = h(
    'button',
    { type: 'button', class: 'btn btn--ghost btn--sm nt-back', 'aria-label': 'Back to notes', onClick: () => backToList() },
    icon('chevron-left'),
    backLabel,
  );
  // Board layout, wide screens: the editor is a panel over the board, closed with this (or Esc).
  const peekClose = h(
    'button',
    { type: 'button', class: 'btn btn--ghost btn--icon btn--sm nt-peek-close', 'aria-label': 'Close note', title: 'Close (Esc)', onClick: () => backToList() },
    icon('x'),
  );
  const editBtn = h(
    'button',
    { type: 'button', class: 'seg-btn', 'aria-pressed': 'true', onClick: () => setMode('edit', { focus: true }) },
    icon('edit', { size: 12 }),
    'Edit',
  );
  const previewBtn = h(
    'button',
    { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', title: `Toggle preview (${MOD_KEY}+E)`, onClick: () => setMode('preview', { focus: true }) },
    icon('eye', { size: 12 }),
    'Preview',
  );
  const pinBtn = h(
    'button',
    { type: 'button', class: 'btn btn--icon btn--sm nt-pin', 'aria-pressed': 'false', 'aria-label': 'Pin note', title: 'Pin note', onClick: () => togglePin() },
    icon('pin'),
  );
  const deleteBtn = h(
    'button',
    { type: 'button', class: 'btn btn--danger btn--icon btn--sm', 'aria-label': 'Delete note', title: 'Delete note', onClick: () => deleteCurrent() },
    icon('trash'),
  );
  // Color coding: the open note's color
  const colorBtn = colorButton({ title: 'Note color', className: 'nt-color', onPick: (c) => setNoteColor(ui.editorId, c) });
  colorBtn.el.dataset.ccFor = 'notes';

  // The open note's section; opens the move menu.
  const moveIcon = h('span', { class: 'nt-move-icon', 'aria-hidden': 'true' });
  const moveName = h('span', { class: 'nt-move-name' });
  const moveBtn = h(
    'button',
    { type: 'button', class: 'nt-move', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Move to another section', onClick: () => toggleMoveMenu() },
    moveIcon,
    moveName,
    icon('chevron-down', { size: 12, className: 'nt-move-caret' }),
  );

  // A textarea, so a long title-only idea wraps and reads in full (also in the board's panel).
  // It stays one paragraph: Enter moves to the body and pasted line breaks become spaces.
  const titleInput = h('textarea', {
    class: 'nt-title',
    rows: '1',
    placeholder: 'Untitled',
    'aria-label': 'Note title',
    autocomplete: 'off',
    enterkeyhint: 'next',
    onInput: onTitleInput,
    onKeydown: onTitleKey,
  });

  const metaCreated = h('span', { class: 'nt-meta-item lo-deco' });
  const metaEdited = h('span', { class: 'nt-meta-item' });
  const metaWords = h('span', { class: 'nt-meta-item lo-deco' });
  const metaChars = h('span', { class: 'nt-meta-item lo-deco' });
  const statusText = h('span', null, 'Saved');
  const status = h('span', { class: 'nt-status', dataset: { state: 'saved' } }, h('span', { class: 'nt-status-dot', 'aria-hidden': 'true' }), statusText);
  // Screen readers hear explicit saves (Cmd/Ctrl+S), view switches made away from the
  // section nav and section reorders; routine autosaves stay quiet. It sits outside the
  // editor, which is hidden whenever no note is open or the list pane shows on phones.
  const announcer = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

  const bodyInput = h('textarea', {
    class: 'nt-body',
    placeholder: 'Start writing… markdown works here.',
    'aria-label': 'Note body',
    onInput: onEdit,
    onKeydown: onBodyKey,
  });
  const previewEl = h('div', {
    class: 'nt-preview nt-prose',
    role: 'region',
    'aria-label': 'Note preview',
    tabindex: '0',
    hidden: true,
    onChange: onPreviewChange,
    onKeydown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        releaseEditor();
      }
    },
  });

  const doc = h(
    'div',
    { class: 'nt-doc' },
    h('div', { class: 'nt-doc-head' }, moveBtn),
    titleInput,
    h('div', { class: 'nt-meta label' }, h('div', { class: 'nt-meta-info' }, metaCreated, metaEdited, metaWords, metaChars), status),
    h('div', { class: 'nt-pane' }, bodyInput, previewEl),
  );

  // No note open (an empty view): a quiet slot instead of a stale note.
  const editorEmpty = h('div', { class: 'nt-editor-empty' }, emptyState({ icon: 'note', title: 'No note open', text: ' ' }));
  const editorEmptyText = editorEmpty.querySelector('.empty-text');

  const editorPanel = h(
    'section',
    { class: 'panel hud nt-editor', 'aria-label': 'Note editor' },
    h(
      'div',
      { class: 'panel-head nt-toolbar' },
      backBtn,
      h('div', { class: 'seg nt-seg', role: 'group', 'aria-label': 'Editor mode' }, editBtn, previewBtn),
      h('span', { class: 'spacer' }),
      colorBtn.el,
      pinBtn,
      deleteBtn,
      peekClose,
    ),
    doc,
    editorEmpty,
    h(
      'div',
      { class: 'nt-foot nt-hints label' },
      hint([MOD_KEY, 'S'], 'Save'),
      hint([MOD_KEY, 'E'], 'Preview'),
      escHint,
      h('span', { class: 'tag tag--dashed nt-md-tag' }, 'Markdown'),
    ),
  );

  /* ---- Empty notebook ---- */

  const emptyEl = h(
    'div',
    { class: 'nt-empty' },
    emptyState({
      icon: 'note',
      title: 'No notes yet',
      text: 'Capture an idea, a plan or a checklist. Notes save automatically while you type.',
      action: h(
        'button',
        { type: 'button', class: 'btn btn--primary nt-create', onClick: () => newNote() },
        icon('plus'),
        h('span', null, 'Create your first note'),
        h('span', { class: 'kbd nt-kbd-inv lo-hint', 'aria-hidden': 'true' }, 'N'),
      ),
    }),
  );

  // Narrow workspaces show the chip strip as a full-width row above the panes (rail hidden).
  root.append(header, h('div', { class: 'nt-workspace' }, nav.rail, nav.strip, listPanel, boardPanel, editorPanel, emptyEl), announcer);

  /* ---- Render ---- */

  function render() {
    if (disposed) return;
    const s = getState();
    syncView(s);
    const counts = sectionCounts(s.items, s.sections);
    renderStats(s);
    // A row or chip (or its rename field) removed under the keyboard, e.g. deleted in another tab.
    const navFocused = nav.hasFocus();
    nav.update({ sections: s.sections, view: ui.view, counts });
    if (navFocused && focusLost()) nav.focusView(ui.view);
    // The big empty state is for a blank notebook; with sections the list explains each empty view.
    root.dataset.empty = String(!s.items.length && !s.sections.length);

    let current = findNote(ui.selectedId, s);
    if (!current) {
      // Our note vanished (deleted in another tab) or nothing was chosen yet.
      if (ui.selectedId) noteVanished(ui.selectedId);
      // The list opens the view's first note; the board opens nothing by itself.
      current = isBoard() ? null : notesInView(s.items, ui.view)[0] ?? null;
      ui.selectedId = current?.id ?? null;
    }
    syncEditor(current, s);
    // The open picker lists what the sections were when it opened; a change elsewhere makes it stale.
    if (ui.menu && ui.menu.sig !== menuSig(s, findNote(ui.menu.noteId, s))) ui.menu.close();
    if (isBoard()) renderBoard(s, counts);
    else renderList(s, counts, current?.id ?? null);
    if (ui.refocus) {
      ui.refocus = false;
      if (focusLost()) focusListFallback();
    }
    firstRender = false;
  }

  /** What the move menu shows: the sections and where the open note is filed. */
  function menuSig(s, note) {
    return JSON.stringify([note?.id ?? null, note?.sectionId ?? null, s.sections.map((x) => [x.id, x.name, x.icon])]);
  }

  /** Somewhere sensible for focus once its control is gone: the empty view's button, a note, or the nav. */
  function focusListFallback() {
    if (isBoard()) {
      board.focusFallback();
      return;
    }
    const target = (viewEmpty.isConnected && viewEmpty.querySelector('.btn')) || listBody.querySelector('.nt-item');
    if (target && target.offsetParent !== null) target.focus({ preventScroll: true });
    else nav.focusView(ui.view);
  }

  function announce(text) {
    // Alternate the text so a repeat is announced again.
    announcer.textContent = announcer.textContent === text ? `${text}\u00A0` : text;
  }

  /** The section this tab is viewing was deleted in another tab: fall back to All notes. */
  function syncView(s) {
    const view = resolveView(s.sections, ui.view);
    if (view !== ui.view) {
      // The board shows every section, so only the list has something to say.
      if (!isBoard()) toast(['“', bdi(clip(ui.viewName, 40)), '” was deleted in another tab. Showing all notes.']);
      ui.view = view;
      listBody.scrollTop = 0;
    }
    ui.viewName = viewLabel(s.sections, ui.view);
  }

  /**
   * The open note was deleted in another tab; another note (or the empty state) is about
   * to load. An unsaved edit to it is dropped, not saved into a recreated note: the
   * delete was deliberate and that tab's toast offers Undo (see persist()).
   */
  function noteVanished(id) {
    const dropped = ui.pendingId === id;
    if (dropped) {
      saver.cancel();
      ui.pendingId = null;
    }
    const active = document.activeElement;
    const editing = active instanceof HTMLElement && doc.contains(active);
    // Keep further keystrokes out of whichever note opens next.
    if (editing) active.blur();
    if (editing || dropped) toast('This note was deleted in another tab.');
    if (ui.pane === 'editor') setPane('list');
    // The board's panel just closed under the keyboard: render() hands focus to a card.
    if (editing && isBoard()) ui.refocus = true;
  }

  function renderStats(s) {
    let pinned = 0;
    let words = 0;
    for (const note of s.items) {
      if (note.pinned) pinned += 1;
      words += wordsIn(note);
    }
    statNotes.textContent = num(s.items.length);
    statSections.textContent = num(s.sections.length);
    statPinned.textContent = num(pinned);
    statWords.textContent = formatCount(words);
  }

  function renderList(s, counts, currentId) {
    const { terms, query, view } = ui;
    // "All notes" tags every filed note with its section.
    const tagged = view === VIEW_ALL && s.sections.length > 0;
    const baseKey = `${terms.join('\u0001')}\u0002${tagged ? 1 : 0}`;
    const visible = notesInView(s.items, view, terms);
    const pinned = visible.filter((n) => n.pinned);
    const others = visible.filter((n) => !n.pinned);
    const total = viewCount(counts, view);
    const elsewhereCount = otherMatches(s.items, view, terms);

    const active = document.activeElement;
    const focusId = active instanceof HTMLElement && listBody.contains(active) ? active.dataset.id : null;
    const focusAt = focusId ? [...listBody.querySelectorAll('.nt-item')].indexOf(active) : -1;

    let index = 0;
    const toRow = (note) => renderItem(note, (index += 1), note.id === currentId, baseKey, tagged ? findSection(s.sections, note.sectionId) : null);
    syncChildren(pinnedList, pinned.map(toRow));
    syncChildren(notesList, others.map(toRow));
    pinnedCount.textContent = num(pinned.length);
    notesCount.textContent = num(others.length);

    if (!total) paintViewEmpty(s);
    else if (!visible.length) {
      noMatchText.textContent = view === VIEW_ALL ? `Nothing contains “${query.trim()}”.` : `Nothing in “${clip(ui.viewName, 40)}” contains “${query.trim()}”.`;
    }
    if (elsewhereCount) elsewhereText.textContent = `${elsewhereCount} more in other sections`;
    syncChildren(listBody, [
      ...(pinned.length ? [pinnedHead, pinnedList] : []),
      ...(others.length ? [notesHead, notesList] : []),
      ...(!total ? [viewEmpty] : visible.length ? [] : [noMatch]),
      ...(elsewhereCount ? [elsewhere] : []),
    ]);

    listCount.textContent = terms.length
      ? `${num(visible.length)} ${visible.length === 1 ? 'match' : 'matches'}`
      : `${num(total)} ${total === 1 ? 'note' : 'notes'}`;

    if (itemCache.size > s.items.length) {
      const ids = new Set(s.items.map((n) => n.id));
      for (const id of itemCache.keys()) if (!ids.has(id)) itemCache.delete(id);
    }

    // Re-ordering detaches nodes, which drops focus; put it back. A row that left the list
    // (dragged to another section, deleted elsewhere) hands focus to the row now in its place.
    const focusBtn = focusId ? itemCache.get(focusId)?.btn : null;
    if (focusBtn?.isConnected) {
      if (document.activeElement !== focusBtn) focusBtn.focus({ preventScroll: true });
    } else if (focusAt !== -1 && focusLost()) {
      const rows = listBody.querySelectorAll('.nt-item');
      (rows[Math.min(focusAt, rows.length - 1)] ?? listBody.querySelector('.btn'))?.focus({ preventScroll: true });
    }
    listRendered = true;
  }

  /** The board: every column from state, the search applied; the open note's card is marked. */
  function renderBoard(s, counts) {
    board.update({
      items: s.items,
      sections: s.sections,
      terms: ui.terms,
      collapsed: Array.isArray(s.boardCollapsed) ? s.boardCollapsed : [],
      openId: ui.pane === 'editor' ? ui.selectedId : null,
    });
    const shown = ui.terms.length ? notesInView(s.items, VIEW_ALL, ui.terms).length : counts.all;
    boardCount.textContent = ui.terms.length ? `${num(shown)} ${shown === 1 ? 'match' : 'matches'}` : `${num(shown)} ${shown === 1 ? 'note' : 'notes'}`;
  }

  /** Copy for a view with no notes at all. */
  function paintViewEmpty(s) {
    const { view } = ui;
    const name = clip(ui.viewName, 40);
    viewEmptyIcon.replaceChildren(icon(viewIconName(s.sections, view), { size: 20 }));
    if (view === VIEW_ALL) {
      viewEmptyTitle.textContent = 'No notes yet';
      viewEmptyText.textContent = 'Capture an idea, a plan or a checklist. New notes start out unsorted.';
      viewEmptyLabel.textContent = 'New note';
    } else if (view === VIEW_UNSORTED) {
      viewEmptyTitle.textContent = 'Nothing unsorted';
      viewEmptyText.textContent = 'Every note is filed in a section. Notes you start here stay unsorted.';
      viewEmptyLabel.textContent = 'New note';
    } else {
      viewEmptyTitle.textContent = `No notes in ${name} yet`;
      viewEmptyText.textContent = `Start one here, or file a note with the section button above its title.${nav.railVisible() ? ' You can also drag a note from the list onto a section.' : ''}`;
      viewEmptyLabel.textContent = `New note in ${clip(ui.viewName, 22)}`;
    }
  }

  function syncChildren(parent, nodes) {
    const current = parent.children;
    if (current.length === nodes.length && nodes.every((node, i) => current[i] === node)) return;
    parent.replaceChildren(...nodes);
  }

  function renderItem(note, index, selected, baseKey, section) {
    let entry = itemCache.get(note.id);
    if (!entry) {
      const btn = h('button', { type: 'button', class: 'nt-item', dataset: { id: note.id }, onClick: (e) => onItemClick(note.id, e) });
      const li = h('li', { class: ['nt-row', listRendered && 'is-new'] }, btn);
      li.addEventListener('animationend', () => li.classList.remove('is-new'), { once: true });
      entry = { li, btn };
      itemCache.set(note.id, entry);
    }
    const key = section ? `${baseKey}\u0002${section.id}\u0001${section.name}\u0001${section.icon}` : baseKey;
    // Color coding: the note's own color, else its section's
    paintColor(entry.btn, 'notes', note.color, sectionColor(note.sectionId));
    if (entry.dirty || entry.note !== note || entry.index !== index || entry.selected !== selected || entry.key !== key) {
      Object.assign(entry, { note, index, selected, key, section, dirty: false });
      fillItem(entry.btn, note, index, section);
      if (selected) entry.btn.setAttribute('aria-current', 'true');
      else entry.btn.removeAttribute('aria-current');
    }
    return entry.li;
  }

  function fillItem(btn, note, index, section) {
    const { terms } = ui;
    const title = note.title.trim();
    const preview = excerpt(note.body, { terms, skip: title });
    btn.replaceChildren(
      h('span', { class: 'nt-item-index lo-deco', 'aria-hidden': 'true' }, idx(index)),
      h(
        'span',
        { class: 'nt-item-main' },
        h(
          'span',
          { class: 'nt-item-top' },
          h('span', { class: ['nt-item-title', !title && 'is-untitled'] }, title ? marked(title, terms) : 'Untitled'),
          note.pinned ? h('span', { class: 'nt-item-pin', title: 'Pinned' }, icon('pin', { size: 12 }), h('span', { class: 'sr-only' }, ', pinned')) : null,
          h('span', { class: 'nt-item-time label', dataset: { ts: String(note.updatedAt) } }, timeAgo(note.updatedAt)),
        ),
        // In All notes the section tag leads the excerpt line, so filed rows stay as tall as the rest.
        h(
          'span',
          { class: ['nt-item-excerpt', !preview && 'is-empty'] },
          section
            ? h('span', { class: 'tag nt-item-tag' }, icon(glyphOf(section), { size: 10 }), h('span', { class: 'sr-only' }, 'In section '), h('span', { class: 'nt-item-tag-name' }, section.name), h('span', { class: 'sr-only' }, '. '))
            : null,
          preview ? marked(preview, terms) : h('span', { class: 'nt-item-filler' }, 'No additional text'),
        ),
      ),
    );
  }

  /** Mirror what is being typed into the list row (or board card) before the save lands. */
  function updateLiveItem() {
    if (isBoard()) {
      const note = findNote(ui.editorId);
      if (note) board.updateCard({ ...note, title: titleInput.value, body: bodyInput.value, updatedAt: Date.now() });
      return;
    }
    const entry = itemCache.get(ui.editorId);
    if (!entry?.note) return;
    fillItem(entry.btn, { ...entry.note, title: titleInput.value, body: bodyInput.value, updatedAt: Date.now() }, entry.index, entry.section);
    entry.dirty = true;
  }

  function revealItem(id) {
    if (isBoard()) {
      board.revealCard(id);
      return;
    }
    const li = itemCache.get(id)?.li;
    if (!li?.isConnected) return;
    const box = listBody.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    if (r.top < box.top) listBody.scrollTop -= box.top - r.top + 8;
    else if (r.bottom > box.bottom) listBody.scrollTop += r.bottom - box.bottom + 8;
  }

  function syncEditor(note, s = getState()) {
    if (!note) {
      clearEditor(s);
      return;
    }
    if (note.id !== ui.editorId) {
      // A pending edit still belongs to the previous note; land it there.
      if (ui.pendingId) queueMicrotask(flushSave);
      ui.menu?.close();
      ui.editorId = note.id;
      titleInput.value = note.title;
      fitTitle();
      bodyInput.value = note.body;
      bodyInput.scrollTop = 0;
      previewEl.scrollTop = 0;
      ui.previewSource = null;
      setStatus('saved');
      replay(doc, 'is-switching');
    } else if (ui.pendingId !== note.id) {
      // Same note changed underneath us (another tab, a preview checkbox).
      if (setValueKeepCaret(titleInput, note.title)) fitTitle();
      setValueKeepCaret(bodyInput, note.body);
    }
    editorPanel.dataset.state = 'open';
    // Toggle button: constant name, state via aria-pressed; only the tooltip changes.
    pinBtn.setAttribute('aria-pressed', String(note.pinned));
    pinBtn.title = note.pinned ? 'Unpin note' : 'Pin note';
    colorBtn.set(note.color ?? null);
    metaCreated.replaceChildren('Created ', h('b', null, formatStamp(note.createdAt)));
    metaEdited.replaceChildren('Edited ', h('b', { dataset: { ts: String(note.updatedAt) } }, timeAgo(note.updatedAt)));
    paintMoveButton(findSection(s.sections, note.sectionId));
    updateCounts();
    if (editorMode === 'preview') renderPreview();
  }

  /** Nothing to open in this view: unload the inputs and show the placeholder. */
  function clearEditor(s) {
    if (ui.editorId !== null) {
      if (ui.pendingId) queueMicrotask(flushSave);
      ui.menu?.close();
      // The toolbar and document hide; take focus out of them (render() then finds it a home).
      const active = document.activeElement;
      if (active instanceof HTMLElement && editorPanel.contains(active)) {
        active.blur();
        ui.refocus = true;
      }
      ui.editorId = null;
      titleInput.value = '';
      fitTitle();
      bodyInput.value = '';
      ui.previewSource = null;
      setStatus('saved');
    }
    editorPanel.dataset.state = 'empty';
    const name = clip(ui.viewName, 40);
    if (s.items.some((n) => noteInView(n, ui.view))) editorEmptyText.textContent = 'Pick a note from the list to open it here.';
    else if (ui.view === VIEW_ALL) editorEmptyText.textContent = 'Start a note and it opens here.';
    else if (ui.view === VIEW_UNSORTED) editorEmptyText.textContent = 'Notes you start now stay unsorted.';
    else editorEmptyText.textContent = `Notes you start now are filed in “${name}”.`;
    if (ui.pane === 'editor') setPane('list');
  }

  function paintMoveButton(section) {
    const sig = section ? `${section.id}\u0001${section.name}\u0001${section.icon}` : '';
    if (sig === moveSig) return;
    moveSig = sig;
    const name = section ? section.name : 'Unsorted';
    moveIcon.replaceChildren(icon(section ? glyphOf(section) : 'inbox', { size: 12 }));
    moveName.textContent = name;
    moveBtn.classList.toggle('is-unsorted', !section);
    moveBtn.setAttribute('aria-label', `Section: ${name}. Move note`);
  }

  function updateCounts() {
    const body = bodyInput.value;
    const words = countWords(body);
    const chars = countChars(body);
    metaWords.replaceChildren(h('b', null, groupDigits(words)), words === 1 ? ' word' : ' words');
    metaChars.replaceChildren(h('b', null, groupDigits(chars)), chars === 1 ? ' char' : ' chars');
  }

  function setStatus(state) {
    if (status.dataset.state === state) return;
    status.dataset.state = state;
    statusText.textContent = state === 'saving' ? 'Saving…' : 'Saved';
  }

  function setPane(pane) {
    ui.pane = pane;
    root.dataset.pane = pane;
    // Board: 'editor' is the panel open over the board; its note's card is marked.
    if (isBoard()) board.setOpen(pane === 'editor' ? ui.selectedId : null);
  }

  function setMode(next, { focus = false } = {}) {
    const from = editorMode === 'preview' ? previewEl : bodyInput;
    const ratio = from.hidden ? 0 : scrollRatio(from);
    editorMode = next === 'preview' ? 'preview' : 'edit';
    const previewing = editorMode === 'preview';
    editBtn.setAttribute('aria-pressed', String(!previewing));
    previewBtn.setAttribute('aria-pressed', String(previewing));
    bodyInput.hidden = previewing;
    previewEl.hidden = !previewing;
    editorPanel.dataset.mode = editorMode;
    if (previewing) renderPreview();
    // Keep roughly the same spot in the document when flipping modes.
    const to = previewing ? previewEl : bodyInput;
    if (ratio) to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    if (focus) to.focus({ preventScroll: true });
  }

  function toggleMode() {
    // Carry focus across only when it is in the body/preview (not the title).
    const active = document.activeElement;
    const inBody = active === bodyInput || previewEl.contains(active);
    setMode(editorMode === 'preview' ? 'edit' : 'preview', { focus: inBody });
  }

  function renderPreview() {
    const src = bodyInput.value;
    if (src === ui.previewSource) return;
    ui.previewSource = src;
    // renderMarkdown escapes all user text before adding markup (see notes.markdown.js).
    previewEl.innerHTML = renderMarkdown(src);
    if (!src.trim()) previewEl.append(h('p', { class: 'nt-preview-empty' }, 'Nothing to preview yet. Switch to Edit and start writing.'));
  }

  /* ---- Editing ---- */

  function scheduleSave() {
    if (!ui.editorId) return;
    ui.pendingId = ui.editorId;
    setStatus('saving');
    saver(ui.editorId, titleInput.value, bodyInput.value);
  }

  /** The title grows with its text where CSS cannot (no field-sizing support). */
  function fitTitle() {
    if (TITLE_SIZES_ITSELF) return;
    titleInput.style.height = 'auto';
    titleInput.style.height = `${titleInput.scrollHeight}px`;
  }

  function onTitleInput(e) {
    // A paste or drop can carry line breaks; one space each keeps the caret where it was.
    if (!e.isComposing && /[\r\n]/.test(titleInput.value)) {
      const { selectionStart, selectionEnd } = titleInput;
      titleInput.value = titleInput.value.replace(/[\r\n]/g, ' ');
      titleInput.setSelectionRange(selectionStart, selectionEnd);
    }
    fitTitle();
    onEdit();
  }

  function onEdit() {
    scheduleSave();
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      updateCounts();
      updateLiveItem();
    });
  }

  function saveNow() {
    flushSave();
    if (!editorShown()) return;
    setStatus('saved');
    replay(status, 'is-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => status.classList.remove('is-flash'), 1400);
    announce('Note saved');
  }

  function onPreviewChange(e) {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.classList.contains('nt-task-box') || !ui.editorId) return;
    const next = toggleTask(bodyInput.value, Number(box.dataset.line), box.checked);
    if (next === bodyInput.value) {
      // The preview was stale; redraw it from the source.
      ui.previewSource = null;
      renderPreview();
      return;
    }
    bodyInput.value = next;
    ui.previewSource = next; // the checkbox already shows the new state
    box.closest('.nt-task')?.classList.toggle('is-done', box.checked);
    if (box.checked) replay(box, 'is-pop');
    scheduleSave();
    flushSave();
  }

  function insertText(text) {
    // execCommand keeps the native undo stack; fall back where it is unsupported.
    let ok = false;
    try {
      ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    } catch {
      ok = false;
    }
    if (!ok) {
      bodyInput.setRangeText(text, bodyInput.selectionStart, bodyInput.selectionEnd, 'end');
      bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function onBodyKey(e) {
    // Keys pressed during IME composition belong to the IME (Escape cancels it there).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      releaseEditor();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const { selectionStart: start, selectionEnd: end, value } = bodyInput;
    if (start !== end) return;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', start);
    const action = continueList(value.slice(lineStart, start), value.slice(start, lineEnd === -1 ? value.length : lineEnd));
    if (!action) return;
    e.preventDefault();
    if (action.clear) {
      bodyInput.setSelectionRange(start - action.clear, start);
      insertText('');
    } else {
      insertText(action.insert);
    }
  }

  function onTitleKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      releaseEditor();
    } else if (e.key === 'Enter' || (e.key === 'ArrowDown' && titleInput.selectionStart === titleInput.value.length)) {
      e.preventDefault();
      if (editorMode === 'preview') setMode('edit');
      bodyInput.focus({ preventScroll: true });
      bodyInput.setSelectionRange(0, 0);
      bodyInput.scrollTop = 0;
    }
  }

  /** Escape: leave the editor. On desktop focus returns to the note's list row; the board's panel closes. */
  function releaseEditor() {
    if (isBoard()) {
      backToList();
      return;
    }
    const btn = itemCache.get(ui.editorId)?.btn;
    if (btn && btn.offsetParent !== null) btn.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function focusEditor() {
    if (!ui.editorId) return;
    (editorMode === 'preview' ? previewEl : bodyInput).focus({ preventScroll: true });
  }

  /* ---- Actions ---- */

  function selectNote(id, { open = true } = {}) {
    if (id !== ui.editorId) {
      flushSave();
      const leaving = ui.editorId;
      ui.selectedId = id;
      commit((s) => ({ ...s, items: withoutBlank(s.items, leaving), selectedId: id }));
    } else if (getState().selectedId !== id) {
      commit((s) => ({ ...s, selectedId: id }));
    }
    if (!open) return;
    setPane('editor');
    if (editorFull()) backBtn.focus({ preventScroll: true });
  }

  function onItemClick(id, e) {
    selectNote(id);
    // Keyboard activation (Enter/Space on a row) goes straight into the editor.
    if (e.detail === 0 && !singlePane.matches) focusEditor();
  }

  /** A card opens its note in the panel beside the board (full screen on phones). */
  function openCard(id, { keyboard = false } = {}) {
    if (!findNote(id)) return;
    selectNote(id);
    // Keep the card in sight left of the panel, so the board and the note read together.
    board.revealCard(id);
    if (keyboard && !boardFull.matches) focusEditor();
  }

  /** Leaving the open note: an empty one is discarded silently. */
  function discardIfBlank() {
    const note = findNote(ui.editorId);
    if (!note || !isBlank(note)) return;
    ui.selectedId = null; // our own removal, not a vanished note
    dropIfBlank(note.id);
  }

  function backToList() {
    flushSave();
    const openId = ui.selectedId;
    discardIfBlank();
    setPane('list');
    if (isBoard()) {
      // The panel closes; focus goes back to the note's card (or a neighbour if it was empty and
      // let go), unless it is already on a card the user moved to while the panel was open.
      if (board.hasFocus() && !focusLost()) return;
      if (!(ui.selectedId && board.focusCard(ui.selectedId)) && openId) board.focusFallback();
      return;
    }
    const btn = itemCache.get(ui.selectedId)?.btn;
    if (btn?.isConnected) {
      revealItem(ui.selectedId);
      btn.focus({ preventScroll: true });
    }
  }

  /**
   * A new note in the current view's section (All notes and Unsorted start it unsorted).
   * Board: in `column` (a column's + buttons), else in the column holding keyboard focus (the
   * open note's column while focus is in its panel), else Unsorted, as in All notes.
   */
  function newNote({ column } = {}) {
    let focusedColumn = null;
    if (isBoard() && column === undefined) {
      focusedColumn = board.focusedColumn();
      const open = ui.pane === 'editor' && editorPanel.contains(document.activeElement) ? findNote(ui.editorId) : null;
      if (focusedColumn == null && open) focusedColumn = columnOf(open, getState().sections);
    }
    flushSave();
    if (ui.query) setQuery('');
    const { sections } = getState();
    let sectionId = viewSectionId(sections, ui.view);
    if (isBoard()) sectionId = columnSection(column !== undefined ? column : focusedColumn);
    // A column whose section was deleted meanwhile (another tab) files the note in Unsorted.
    if (sectionId != null && !findSection(sections, sectionId)) sectionId = null;
    const current = findNote(ui.editorId);
    if (current && isBlank(current)) {
      // Reuse the empty note instead of stacking another, filed where the user is.
      ui.selectedId = current.id;
      commitIfChanged((s) => moveNoteToSection(s, current.id, sectionId));
    } else {
      const note = createNote({ id: uid(), sectionId });
      ui.selectedId = note.id;
      commit((s) => ({ ...s, items: [note, ...s.items], selectedId: note.id }));
    }
    if (editorMode !== 'edit') setMode('edit');
    setPane('editor');
    titleInput.focus();
    revealItem(ui.selectedId);
  }

  /** The color a note shows when it has none of its own: its section's. */
  function sectionColor(sectionId) {
    return sectionId != null ? findSection(getState().sections, sectionId)?.color ?? null : null;
  }

  /** Color coding: set (palette id) or clear (null) a note's color. Not an edit: updatedAt stays. */
  function setNoteColor(id, color) {
    if (!id || !findNote(id)) return;
    if (id === ui.editorId) flushSave();
    commitIfChanged((s) => {
      let changed = false;
      const items = s.items.map((n) => {
        if (n.id !== id) return n;
        const next = colorKey(color) ? { ...n, color: colorKey(color) } : (({ color: _c, ...rest }) => rest)(n);
        changed = (n.color ?? null) !== (colorKey(color) ?? null);
        return changed ? next : n;
      });
      return changed ? { ...s, items } : s;
    });
  }

  function togglePin() {
    const id = ui.editorId;
    if (!id) return;
    commit((s) => ({ ...s, items: s.items.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)) }));
    revealItem(id);
  }

  function deleteCurrent() {
    return deleteNote(ui.editorId);
  }

  /**
   * Delete a note (the open one, or any note from the right-click menu): a note with text asks
   * first, and Undo brings it back where it was stored. Deleting the open note opens its neighbour.
   */
  async function deleteNote(id) {
    if (!findNote(id)) return;
    flushSave();
    let note = findNote(id);
    if (!isBlank(note)) {
      const confirmed = await confirmDialog({
        title: 'Delete note?',
        // A node rather than a string so an unbroken title can wrap inside the dialog.
        message: h('span', { class: 'nt-confirm-msg' }, `“${clip(note.title, 48) || 'Untitled'}” will be removed from this device. You can undo right after.`),
        confirmLabel: 'Delete note',
      });
      note = findNote(id);
      if (!confirmed || !note) return;
    }
    if (ui.pendingId === id) {
      saver.cancel();
      ui.pendingId = null;
    }
    const wasOpen = ui.editorId === id;
    // Open the next note the user can actually see (the view, maybe narrowed by search).
    // On the board that is the next card of the note's column.
    const { items, sections } = getState();
    const scope = isBoard() ? columnOf(note, sections) : ui.view;
    const order = notesInView(items, scope);
    const shown = ui.terms.length ? notesInView(items, scope, ui.terms) : order;
    const neighbor = pickNeighbor(shown, id) ?? pickNeighbor(order, id);
    const at = items.findIndex((n) => n.id === id);
    if (ui.selectedId === id) ui.selectedId = neighbor?.id ?? null;
    commit((s) => ({ ...s, items: s.items.filter((n) => n.id !== id), selectedId: wasOpen || s.selectedId === id ? neighbor?.id ?? null : s.selectedId }));

    if (!disposed && wasOpen && isBoard()) {
      // The panel closes on the board; focus lands on the card that took the note's place.
      setPane('list');
      if (!(neighbor && board.focusCard(neighbor.id))) board.focusFallback();
    } else if (!disposed && wasOpen && singlePane.matches) {
      setPane('list');
      const btn = neighbor ? itemCache.get(neighbor.id)?.btn : null;
      if (btn?.isConnected) btn.focus({ preventScroll: true });
    } else if (!disposed && focusLost()) {
      // Its row (or card) had focus: the next one takes it.
      if (isBoard()) {
        if (!(neighbor && board.focusCard(neighbor.id))) board.focusFallback();
      } else {
        const btn = neighbor ? itemCache.get(neighbor.id)?.btn : null;
        if (btn?.isConnected) btn.focus({ preventScroll: true });
        else focusListFallback();
      }
    }
    if (!isBlank(note)) offerUndo(`“${clip(note.title, 40) || 'Untitled'}” deleted.`, () => restoreNote(note, at));
  }

  /* ---- Copy, paste, duplicate (the right-click menu) ---- */

  /** What a copy of a note carries. */
  const noteSnapshot = (note) => ({ title: note.title, body: note.body, pinned: !!note.pinned, color: note.color ?? null });

  /**
   * A new note from `snap` in section `sectionId` (Unsorted when null or gone), named by
   * `naming(title, titles of that section)`. It shows at once (search cleared), Undo removes it.
   */
  function insertNoteCopy(snap, sectionId, { verb = 'Pasted', naming = pasteName } = {}) {
    const src = snap && typeof snap === 'object' ? snap : {};
    const body = typeof src.body === 'string' ? src.body : '';
    flushSave();
    const s = getState();
    const sid = sectionId != null && findSection(s.sections, sectionId) ? sectionId : null;
    const siblings = s.items.filter((n) => (n.sectionId ?? null) === sid).map((n) => n.title);
    const raw = typeof src.title === 'string' ? src.title : '';
    const title = (raw.trim() || verb === 'Duplicated') ? naming(raw, siblings) : '';
    if (!title.trim() && !body.trim()) {
      toast('Nothing to paste.');
      return null;
    }
    if (ui.query) setQuery('');
    const created = createNote({ id: uid(), title, body, pinned: !!src.pinned, sectionId: sid });
    const note = colorKey(src.color) ? { ...created, color: colorKey(src.color) } : created;
    commit((st) => ({ ...st, items: [note, ...st.items] }));
    if (!disposed) {
      revealItem(note.id);
      if (isBoard()) board.landed(note.id);
    }
    const where = sid !== null || isBoard() ? ` to ${viewLabel(getState().sections, sid ?? VIEW_UNSORTED)}` : '';
    offerUndo([`${verb} “`, bdi(clip(title, 40) || 'Untitled'), `”${verb === 'Pasted' ? where : ''}.`], () => removeNoteCopy(note));
    return note;
  }

  /** Undo of a paste / duplicate: the copy goes, but only while it is exactly as it was made. */
  function removeNoteCopy(created) {
    flushSave();
    const cur = findNote(created.id);
    if (!cur) {
      toast('Nothing undone: the copy was deleted since.');
      return false;
    }
    if (cur.title !== created.title || cur.body !== created.body || cur.pinned !== created.pinned || (cur.sectionId ?? null) !== (created.sectionId ?? null)) {
      toast('Nothing undone: the copy was changed since.');
      return false;
    }
    if (ui.pendingId === created.id) {
      saver.cancel();
      ui.pendingId = null;
    }
    if (ui.selectedId === created.id) ui.selectedId = null;
    commit((st) => ({ ...st, items: st.items.filter((n) => n.id !== created.id), selectedId: st.selectedId === created.id ? null : st.selectedId }));
    return true;
  }

  /** Plain text from the clipboard: the first line is the title, the rest the body. */
  function pasteNoteText(text, sectionId) {
    const { title, rest } = splitText(text, 200);
    if (!title && !rest) {
      toast('Nothing to paste.');
      return;
    }
    insertNoteCopy({ title, body: rest, pinned: false }, sectionId);
  }

  function duplicateNote(id) {
    flushSave();
    const note = findNote(id);
    if (note) insertNoteCopy(noteSnapshot(note), note.sectionId, { verb: 'Duplicated', naming: (t, taken) => copyName(t, taken) });
  }

  /** The section a paste lands in when nothing more specific was right-clicked. */
  function pasteSectionAt(el) {
    const sections = getState().sections;
    const col = el.closest('.nt-col[data-col]');
    if (col) return columnSection(col.dataset.col);
    const viewEl = el.closest('[data-view]');
    const view = viewEl?.dataset.view;
    if (view === VIEW_ALL || view === VIEW_UNSORTED) return null;
    if (view && findSection(sections, view)) return view;
    return isBoard() ? null : viewSectionId(sections, ui.view);
  }

  /**
   * The right-click menu: a list row or board card, the open note (its panel, outside the text
   * fields), or anywhere else (a paste target: that column, rail section, or the current view).
   */
  function contextTarget(el) {
    if (!root.contains(el)) return null;
    let note = null;
    let itemEl = el.closest('.nt-item[data-id], .nt-card-row[data-id]');
    if (itemEl) note = findNote(itemEl.dataset.id);
    else if (editorPanel.contains(el) && editorShown()) {
      note = findNote(ui.editorId);
      itemEl = editorPanel;
    }
    if (note && note.id === ui.editorId) flushSave(); // copy what is on screen
    note = note ? findNote(note.id) : null;
    const sectionId = note ? (note.sectionId != null && findSection(getState().sections, note.sectionId) ? note.sectionId : null) : pasteSectionAt(el);
    const paste = {
      accepts: ['note'],
      paste: (c) => insertNoteCopy(c.snapshot, sectionId),
      pasteText: (text) => pasteNoteText(text, sectionId),
    };
    if (!note) return { kind: null, id: null, label: 'Notes', el: null, ...paste };
    const id = note.id;
    const blank = isBlank(note);
    return {
      kind: 'note',
      id,
      label: `Note: ${clip(note.title, 60) || 'Untitled'}`,
      el: itemEl.matches('.nt-card-row') ? itemEl.querySelector('.nt-card') ?? itemEl : itemEl,
      ...paste,
      copy: () => {
        flushSave();
        const n = findNote(id);
        return n && !isBlank(n) ? { kind: 'note', snapshot: noteSnapshot(n), text: [n.title.trim(), n.body.trim()].filter(Boolean).join('\n\n') } : null;
      },
      remove: () => deleteNote(id),
      duplicate: () => duplicateNote(id),
      can: { copy: !blank, duplicate: !blank },
      color: { kind: 'notes', value: note.color ?? null, set: (c) => setNoteColor(id, c) },
    };
  }

  /** Undo of a delete: the note comes back where it was stored, so the saved list reads as before. */
  function restoreNote(note, at) {
    if (findNote(note.id)) return false;
    if (disposed) {
      commit((s) => ({ ...s, items: restoreNoteAt(s.items, refiled(note, s), at), selectedId: note.id }));
      return true;
    }
    flushSave();
    const leaving = ui.editorId;
    ui.selectedId = note.id;
    commit((s) => ({ ...s, items: restoreNoteAt(withoutBlank(s.items, leaving), refiled(note, s), at), selectedId: note.id }));
    revealItem(note.id);
    if (isBoard()) board.landed(note.id);
    return true;
  }

  /**
   * A toast with Undo. The same undo also runs from ⌘/Ctrl+Z for a minute, at most once
   * (a 6 s toast is hard to reach from the keyboard). `undo()` returns false when it changed
   * nothing (it says why itself).
   */
  function offerUndo(message, undo, { duration = UNDO_MS } = {}) {
    let used = false;
    let handle = null;
    const run = () => {
      if (used) return false;
      used = true;
      if (lastUndo?.run === run) lastUndo = null;
      handle?.dismiss();
      return undo() !== false;
    };
    lastUndo = { run, expires: Date.now() + UNDO_KEY_MS };
    handle = toast(message, { duration, action: { label: 'Undo', onClick: run } });
  }

  /** ⌘/Ctrl+Z outside a text field: the latest Undo, if it is recent. */
  function undoLast() {
    const last = lastUndo;
    lastUndo = null;
    if (!last || Date.now() > last.expires) return false;
    last.run();
    return true;
  }

  /* ---- Views & sections ---- */

  /**
   * Which note to open in `view`: the open one when it belongs there, else `preferId`
   * when it does, else the view's first note (search applied first). Leaving an empty
   * note discards it, as when opening another note: `items` comes back without it.
   */
  function pickForView(items, view, preferId = null) {
    const open = ui.selectedId ? items.find((n) => n.id === ui.selectedId) : null;
    if (open && noteInView(open, view)) return { items, selectedId: open.id };
    const rest = withoutBlank(items, ui.selectedId);
    const preferred = preferId ? rest.find((n) => n.id === preferId) : null;
    const pick = preferred && noteInView(preferred, view) ? preferred : notesInView(rest, view, ui.terms)[0] ?? notesInView(rest, view)[0] ?? null;
    return { items: rest, selectedId: pick?.id ?? null };
  }

  /** A new view's list starts at the top, with the swap animation. */
  function freshList() {
    listBody.scrollTop = 0;
    replay(listBody, 'is-swapping');
  }

  /** "TikTok ideas · 5 notes" for screen readers when the view changed away from the nav. */
  function announceView() {
    const s = getState();
    announce(`${ui.viewName} · ${plural(viewCount(sectionCounts(s.items, s.sections), ui.view), 'note')}`);
  }

  /**
   * Show another view (search text is kept). The open note stays when it belongs to
   * the new view; otherwise the view's first note opens, or the placeholder.
   */
  function switchView(view) {
    const next = resolveView(getState().sections, view);
    if (next === ui.view) return;
    flushSave();
    ui.menu?.close();
    const s = getState();
    const active = document.activeElement;
    const focusIn = (el) => active instanceof HTMLElement && el.contains(active);
    const fromList = focusIn(listBody);
    const fromNav = nav.hasFocus();
    const hadFocus = !focusLost();

    const { items, selectedId } = pickForView(s.items, next);
    ui.selectedId = selectedId;
    ui.view = next;
    ui.viewName = viewLabel(s.sections, next);
    if (singlePane.matches) setPane('list');
    freshList();
    save({ ...s, items, view: next, selectedId });

    if (fromNav) nav.focusView(next);
    else if (fromList && !listBody.contains(document.activeElement)) listBody.querySelector('.nt-item, .btn')?.focus({ preventScroll: true });
    else if (hadFocus && focusLost()) focusListFallback();
    // A focused row or chip already says where we are; elsewhere ('[' / ']', Show all) say it.
    if (!fromNav) announceView();
  }

  /**
   * File a note under a section (null = Unsorted), with Undo. Its place in recency order is kept:
   * moveNoteToSection changes sectionId only. The toast (a polite live region) names the note
   * and where it went, so a keyboard move is announced once.
   */
  function moveNote(noteId, sectionId) {
    const s = getState();
    const note = findNote(noteId, s);
    if (!note) return;
    // Picked from a menu or drop target that went stale (deleted in another tab).
    if (sectionId != null && !findSection(s.sections, sectionId)) {
      toast('That section no longer exists.');
      return;
    }
    const from = note.sectionId ?? null;
    const next = moveNoteToSection(s, noteId, sectionId);
    if (next === s) return;
    save(next);
    const to = sectionId ?? null;
    const label = viewLabel(next.sections, to ?? VIEW_UNSORTED);
    if (!disposed) pulseView(to ?? VIEW_UNSORTED, noteId);
    offerUndo(['Moved “', bdi(clip(note.title, 32) || 'Untitled'), '” to ', bdi(clip(label, 32))], () => undoMove(noteId, from, to));
  }

  /**
   * Put a moved note back, only while it is still where this move left it: a note moved again
   * since (here or in another tab) stays put, so Undo never overwrites a newer move. When its
   * old section is gone meanwhile it goes to Unsorted, as that delete would have sent it.
   */
  function undoMove(noteId, from, to) {
    const s = getState();
    const active = document.activeElement;
    const refocus = focusLost() || (active instanceof Element && !!active.closest('.toast'));
    const { state: next, status } = undoNoteMove(s, noteId, from, to);
    if (status === 'gone') {
      toast('Nothing undone: the note was deleted since.');
      return false;
    }
    if (status === 'moved') {
      toast('Nothing undone: the note was moved again since.');
      return false;
    }
    if (next !== s) save(next);
    if (status === 'refiled') toast('Its old section no longer exists, so the note is in Unsorted.');
    if (disposed) return true;
    const back = findNote(noteId, next)?.sectionId ?? null;
    const label = viewLabel(next.sections, back ?? VIEW_UNSORTED);
    pulseView(back ?? VIEW_UNSORTED, noteId);
    announce(`Moved back to ${label}.`);
    // The toast's Undo took focus with it: land on the card (or the list) again.
    if (refocus) {
      if (isBoard()) {
        if (!board.focusCard(noteId)) board.focusColumn(back ?? VIEW_UNSORTED);
      } else {
        const btn = itemCache.get(noteId)?.btn;
        if (btn?.isConnected) btn.focus({ preventScroll: true });
        else focusListFallback();
      }
    }
    return true;
  }

  /** A note just landed in `view`: glow its rail row or chip, and on the board its column and card. */
  function pulseView(view, noteId = null) {
    nav.pulse(view);
    if (!isBoard()) return;
    board.pulse(view);
    if (noteId) board.landed(noteId);
  }

  function toggleMoveMenu() {
    if (ui.menu) {
      ui.menu.close({ restore: true });
      return;
    }
    const s = getState();
    const note = findNote(ui.editorId, s);
    if (!note) return;
    moveBtn.setAttribute('aria-expanded', 'true');
    ui.menu = openSectionMenu({
      anchor: moveBtn,
      sections: s.sections,
      current: note.sectionId ?? null,
      onPick: (sectionId) => moveNote(note.id, sectionId),
      onCreate: () => newSection({ moveId: note.id }),
      onClose: () => {
        ui.menu = null;
        moveBtn.setAttribute('aria-expanded', 'false');
      },
    });
    ui.menu.noteId = note.id;
    ui.menu.anchor = moveBtn;
    ui.menu.sig = menuSig(s, note);
  }

  /**
   * A card's Move to… picker (its ⋯ button, or M on the card). The same menu as the editor's
   * section button; a second press on the same ⋯ closes it.
   */
  function toggleCardMenu(id, anchor, { keyboard = false } = {}) {
    if (ui.menu) {
      const same = ui.menu.noteId === id && ui.menu.anchor === anchor;
      ui.menu.close({ restore: same });
      if (same) return;
    }
    const s = getState();
    const note = findNote(id, s);
    if (!note) return;
    const popup = anchor.hasAttribute('aria-haspopup');
    if (popup) anchor.setAttribute('aria-expanded', 'true');
    ui.menu = openSectionMenu({
      anchor,
      sections: s.sections,
      current: note.sectionId ?? null,
      onPick: (sectionId) => moveNote(id, sectionId),
      onCreate: () => newSection({ moveId: id }),
      onClose: () => {
        ui.menu = null;
        if (popup) anchor.setAttribute('aria-expanded', 'false');
      },
    });
    ui.menu.noteId = id;
    ui.menu.anchor = anchor;
    ui.menu.sig = menuSig(s, note);
  }

  /** A pager chip was used on the board: that column is this tab's view (the list opens there). */
  function pickColumn(column) {
    const s = getState();
    const view = resolveView(s.sections, column);
    ui.view = view;
    ui.viewName = viewLabel(s.sections, view);
    commitIfChanged((st) => setView(st, view));
  }

  /** Fold a board column to a slim strip (or unfold it); remembered with the notebook. */
  function toggleColumn(column) {
    const hadFocus = board.focusedColumn() === column || focusLost();
    if (!commitIfChanged((s) => toggleCollapsed(s, column))) return;
    const s = getState();
    const folded = s.boardCollapsed.includes(column);
    announce(`${viewLabel(s.sections, column)} ${folded ? 'collapsed' : 'expanded'}`);
    // Its fold button (or strip) just hid: land on the strip, or on the column's first card.
    if (hadFocus) board.focusColumn(column);
  }

  /**
   * The New section dialog. By default the new section opens; with moveId the note
   * is filed there instead (the move menu's "New section…"); open: false only adds it.
   */
  function newSection({ open = true, moveId = null } = {}) {
    let created = null;
    openSectionEditor({
      getSections: () => getState().sections,
      onSubmit: (fields) => {
        const r = createSection(getState(), fields, { makeId: uid });
        if (r.error) return r;
        created = r.section.id;
        save(r.state);
        if (moveId) moveNote(moveId, r.section.id);
        else if (open && isBoard()) board.revealColumn(r.section.id, { glow: true });
        else if (open) switchView(r.section.id);
        return null;
      },
      // The opener may be gone (strip chips rebuilt, the rail's starters hidden once a
      // section exists); land on the new section, or back on the section button after a move.
      onClose: (stranded) => {
        if (!created || disposed) return;
        if (isBoard()) {
          // The new column (its + button), or the moved card when its menu button is gone.
          if (moveId) {
            if (stranded) board.focusCard(moveId);
          } else if (open) board.focusColumn(created);
          return;
        }
        if (!(stranded || nav.hasFocus())) return;
        if (moveId) {
          if (moveBtn.offsetParent !== null) moveBtn.focus({ preventScroll: true });
        } else if (open) {
          nav.focusView(created);
        }
      },
    });
  }

  /** One-click suggestion ("TikTok ideas"): create it and, from the rail or strip, open it. */
  function addSection(fields, { open = true } = {}) {
    const r = createSection(getState(), fields, { makeId: uid });
    if (r.error) {
      toast(r.error);
      return;
    }
    save(r.state);
    if (!open) return;
    switchView(r.section.id);
    // The starter chips are gone now that a section exists.
    nav.focusView(r.section.id);
  }

  function editSection(id) {
    const section = findSection(getState().sections, id);
    if (!section) return;
    openSectionEditor({
      section,
      getSections: () => getState().sections,
      onSubmit: (fields) => {
        const s = getState();
        const r = updateSection(s, id, fields);
        if (r.error) return r;
        if (r.state !== s) save(r.state);
        return null;
      },
    });
  }

  /** Inline rename from the rail: the error message, or null once saved. */
  function renameSectionTo(id, name) {
    const s = getState();
    const r = renameSection(s, id, name);
    if (r.error) return r.error;
    if (r.state !== s) save(r.state);
    return null;
  }

  /** Focus left an inline rename holding a name that cannot be saved: say why it reverted. */
  function renameRefused(id, error) {
    const section = findSection(getState().sections, id);
    if (!section) return;
    toast(['“', bdi(clip(section.name, 40)), `” was not renamed. ${error}`]);
  }

  /** Reorder (Alt+↑/↓, grip drag, Manage) and say where the section landed. */
  function reorderSection(id, fn, delta = 0) {
    const changed = commitIfChanged(fn);
    const { sections } = getState();
    const at = sections.findIndex((x) => x.id === id);
    if (at === -1) return;
    const name = sections[at].name;
    if (changed) announce(`${name}: position ${at + 1} of ${sections.length}`);
    else if (delta) announce(`${name} is already ${delta < 0 ? 'first' : 'last'}`);
  }

  /** Notes a section really holds: an empty note filed there (just started) does not count. */
  function filedCount(s, id) {
    return s.items.filter((n) => n.sectionId === id && !isBlank(n)).length;
  }

  function confirmDeleteSection(id) {
    flushSave();
    const s = getState();
    const section = findSection(s.sections, id);
    if (!section) return;
    const count = filedCount(s, id);
    openDeleteSection({ section, count, onConfirm: (mode) => removeSection(id, mode, count) });
  }

  /** Delete a section ('move' its notes to Unsorted, or 'delete' them too), with Undo. */
  function removeSection(id, mode, expected) {
    if (disposed) return;
    flushSave();
    let s = getState();
    if (!findSection(s.sections, id)) return;
    // Another tab filed notes here while the dialog was open: never delete more than it said.
    if (mode === 'delete' && filedCount(s, id) !== expected) {
      toast('This section changed while the dialog was open. Check the count again.');
      confirmDeleteSection(id);
      return;
    }
    // An empty note filed here goes with the section; it is neither moved nor brought back by Undo.
    let selectedId = ui.selectedId;
    const blank = s.items.filter((n) => n.sectionId === id && isBlank(n));
    if (blank.length) {
      s = { ...s, items: s.items.filter((n) => !blank.includes(n)) };
      if (blank.some((n) => n.id === selectedId)) selectedId = null;
    }
    // Run it against this tab's view and selection, so Undo restores what this tab showed.
    const { state: next, removed } = deleteSection({ ...s, view: ui.view, selectedId }, id, mode);
    if (!removed) return;
    const active = document.activeElement;
    const onRow = active instanceof Element && active.closest('.nt-srow')?.dataset.view === id;
    // Our own changes: set them first so render() does not report them as another tab's.
    const viewChanged = next.view !== ui.view;
    ui.view = next.view;
    ui.viewName = viewLabel(next.sections, ui.view);
    ui.selectedId = next.selectedId;
    if (viewChanged) freshList();
    save(next);
    // Focus was on the deleted row (or its Delete button): move to the row that took its place.
    if (isBoard()) {
      if (focusLost()) board.focusFallback();
    } else if (onRow || focusLost()) nav.focusSectionAt(removed.index);

    const name = bdi(clip(removed.section.name, 40));
    const n = removed.notes.length;
    let message = ['Section “', name, '” deleted.'];
    if (n && removed.mode === 'delete') message = ['Section “', name, `” and its ${plural(n, 'note')} deleted.`];
    else if (n) message = ['Section “', name, `” deleted. ${n === 1 ? 'Its note is' : `Its ${n} notes are`} in Unsorted.`];
    offerUndo(message, () => undoRemoveSection(removed), { duration: 8000 });
  }

  /**
   * Undo a section delete. The view returns to the section when this tab was showing it
   * and still shows All notes; the open note then follows the switchView rules (the note
   * open at delete time comes back when it belongs there).
   */
  function undoRemoveSection(removed) {
    if (disposed) {
      commitIfChanged((s) => restoreSection(s, removed));
      return;
    }
    flushSave();
    const s = getState();
    const next = restoreSection(s, removed);
    if (next === s) return;
    const { section } = removed;
    const active = document.activeElement;
    const refocus = nav.hasFocus() || focusLost() || (active instanceof Element && !!active.closest('.toast'));

    let view = ui.view === VIEW_ALL && removed.view === section.id ? section.id : ui.view;
    view = resolveView(next.sections, view);
    const viewChanged = view !== ui.view;
    let { items } = next;
    let selectedId = ui.selectedId;
    const prior = removed.selectedId;
    const priorNote = removed.notes.some((n) => n.id === prior) ? findNote(prior, next) : null;
    if (priorNote && noteInView(priorNote, view) && prior !== selectedId && (removed.mode === 'delete' || viewChanged)) {
      // The note open at delete time went with the section: reopen it.
      items = withoutBlank(items, selectedId);
      selectedId = prior;
    } else if (viewChanged) {
      ({ items, selectedId } = pickForView(items, view));
    }

    ui.view = view;
    ui.viewName = viewLabel(next.sections, view);
    ui.selectedId = selectedId;
    if (viewChanged) {
      if (singlePane.matches) setPane('list');
      freshList();
    }
    save({ ...next, items, view, selectedId });
    pulseView(section.id);
    if (isBoard()) {
      if (refocus) board.focusColumn(section.id);
      return;
    }
    if (refocus) nav.focusView(section.id);
    if (viewChanged && !refocus) announceView();
  }

  function manageSections() {
    openManageSections({
      getState,
      subscribe: (fn) => store.subscribe(fn),
      counts: (s) => sectionCounts(s.items, s.sections),
      onCreate: () => newSection({ open: false }),
      onSuggest: (fields) => addSection(fields, { open: false }),
      onEdit: (id) => editSection(id),
      onDelete: (id) => confirmDeleteSection(id),
      onMoveBy: (id, delta) => reorderSection(id, (s) => moveSection(s, id, delta), delta),
    });
  }

  /* ---- Layout: list or board ---- */

  /** Put New note + search where the layout shows them, keeping focus if they had it. */
  function placeTools() {
    const host = isBoard() ? boardTools : listHead;
    if (newBtn.parentNode === host) return;
    const active = document.activeElement;
    host.append(newBtn, search);
    if ((active === newBtn || active === searchInput) && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  /** Copy that names where Back / Esc lead in this layout. */
  function paintLayoutCopy() {
    const on = isBoard();
    layoutList.setAttribute('aria-pressed', String(!on));
    layoutBoard.setAttribute('aria-pressed', String(on));
    backLabel.textContent = on ? 'Board' : 'Notes';
    backBtn.setAttribute('aria-label', on ? 'Back to the board' : 'Back to notes');
    escHint.lastChild.textContent = on ? 'Close' : 'Exit editor';
  }

  /**
   * Switch this tab between the list and the board (B, or the List · Board toggle). The
   * pending autosave lands first. The board opens as an overview with no note open (an empty
   * note is let go, as when leaving it) and shows the list's section; back in the list, the
   * note the board was on (the open one, else the focused card) opens in its section.
   */
  function setLayout(next, { viaKey = false } = {}) {
    const layout = normalizeLayout(next);
    if (layout === ui.layout || disposed) return;
    flushSave();
    ui.menu?.close();
    noteDrag.destroy();
    board.cancelDrag();
    const toBoard = layout === LAYOUT_BOARD;
    const active = document.activeElement;
    const onToggle = active === layoutList || active === layoutBoard;
    const panelOpen = ui.pane === 'editor';
    let followId = null;
    if (toBoard) {
      followId = ui.selectedId;
      discardIfBlank();
      if (!findNote(followId)) followId = null;
    } else {
      followId = (panelOpen ? ui.selectedId : null) ?? board.focusedId();
    }

    ui.layout = layout;
    root.dataset.layout = layout;
    paintLayoutCopy();
    placeTools();

    if (toBoard) {
      setPane('list');
      commitIfChanged((s) => withLayout(s, layout));
      render();
      announce('Board layout');
      if (viaKey || (!onToggle && focusLost())) {
        if (!(followId && board.focusCard(followId))) board.focusFallback();
      } else if (followId) {
        board.revealCard(followId, { instant: true });
      } else if (ui.view !== VIEW_ALL) {
        // The section the list was showing: bring its column into view.
        board.revealColumn(ui.view, { instant: true, glow: true });
      }
      return;
    }

    const s = getState();
    const note = findNote(followId, s);
    let { view } = ui;
    let { items } = s;
    let selectedId;
    if (note) {
      selectedId = note.id;
      if (!noteInView(note, view)) view = columnOf(note, s.sections);
    } else {
      ({ items, selectedId } = pickForView(items, view));
    }
    ui.view = view;
    ui.viewName = viewLabel(s.sections, view);
    ui.selectedId = selectedId;
    // Phones keep a note that was open in the board's panel open in the editor.
    setPane(panelOpen && singlePane.matches && selectedId ? 'editor' : 'list');
    freshList();
    save(withLayout({ ...s, items, view, selectedId }, layout));
    announce(`List layout · ${ui.viewName}`);
    if (viaKey || (!onToggle && focusLost())) {
      const btn = itemCache.get(selectedId)?.btn;
      if (ui.pane === 'list' && btn?.isConnected) btn.focus({ preventScroll: true });
      else if (ui.pane === 'list') focusListFallback();
    }
    revealItem(selectedId);
    nav.revealView(view, { instant: true });
  }

  /* ---- Search ---- */

  function setQuery(value) {
    if (searchInput.value !== value) searchInput.value = value;
    ui.query = value;
    ui.terms = queryTerms(value);
    search.classList.toggle('has-query', !!value);
    searchClear.hidden = !value;
    listBody.scrollTop = 0;
    render();
  }

  function focusSearch() {
    if (root.dataset.empty === 'true') return;
    if (editorFull() && ui.pane === 'editor') backToList();
    searchInput.focus();
    searchInput.select();
  }

  function onSearchKey(e) {
    if (e.isComposing) return;
    if (isBoard() && e.key !== 'Escape') {
      // ↓ goes to the first card, Enter opens it.
      const first = board.firstCard();
      if (!first || (e.key !== 'ArrowDown' && e.key !== 'Enter')) return;
      e.preventDefault();
      if (e.key === 'ArrowDown') board.focusCard(first);
      else openCard(first, { keyboard: true });
      return;
    }
    const first = listBody.querySelector('.nt-item');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (searchInput.value) setQuery('');
      else searchInput.blur();
    } else if (e.key === 'ArrowDown' && first) {
      e.preventDefault();
      first.focus();
    } else if (e.key === 'Enter' && first) {
      e.preventDefault();
      selectNote(first.dataset.id);
      if (!singlePane.matches) focusEditor();
    }
  }

  function onListKey(e) {
    const btn = e.target instanceof Element ? e.target.closest('.nt-item') : null;
    if (!btn || e.altKey || e.metaKey || e.ctrlKey) return;
    const items = [...listBody.querySelectorAll('.nt-item')];
    const i = items.indexOf(btn);
    let next;
    if (e.key === 'ArrowDown') next = items[i + 1];
    else if (e.key === 'ArrowUp') next = i > 0 ? items[i - 1] : searchInput;
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else return;
    e.preventDefault();
    if (!next) return;
    next.focus();
    // Two-pane: arrows browse notes like a mail client. Single-pane: they only move focus.
    if (next !== searchInput && !singlePane.matches) selectNote(next.dataset.id, { open: false });
  }

  /* ---- Global keys & lifecycle ---- */

  function onKeydown(e) {
    // Autofill can dispatch keydown events without a key.
    if (e.defaultPrevented || typeof e.key !== 'string') return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    if (mod && key === 's') {
      e.preventDefault(); // never the browser's "Save page" dialog while in Notes, even over a dialog
      saveNow();
      return;
    }
    // The section picker owns the keyboard while it is open, a lifted card while it is dragged.
    if (modalOpen() || ui.menu || board.dragging()) return;
    // '[' / ']' come before the modifier check: many layouts type brackets with Option
    // (Mac) or AltGr (Ctrl+Alt on Windows). e.key is the character, so this stays layout-true.
    if ((key === '[' || key === ']') && !e.metaKey && (!e.ctrlKey || e.altKey) && !typing(e)) {
      e.preventDefault();
      // The board shows every section: step between its columns instead.
      if (isBoard()) board.stepColumn(key === '[' ? -1 : 1);
      else switchView(stepView(getState().sections, ui.view, key === '[' ? -1 : 1));
      return;
    }
    if (mod) {
      if (key === 'k') {
        e.preventDefault();
        focusSearch();
      } else if (key === 'e' && editorShown() && root.dataset.empty !== 'true') {
        e.preventDefault();
        toggleMode();
      } else if (key === 'z' && !typing(e) && undoLast()) {
        // Text fields keep their own undo; elsewhere ⌘/Ctrl+Z takes back the latest move or delete.
        e.preventDefault();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    if (key === '/') {
      e.preventDefault();
      focusSearch();
    } else if (key === 'n') {
      e.preventDefault();
      newNote();
    } else if (key === 'b') {
      e.preventDefault();
      setLayout(isBoard() ? LAYOUT_LIST : LAYOUT_BOARD, { viaKey: true });
    } else if (key === 'Escape' && isBoard() && ui.pane === 'editor') {
      // Esc anywhere outside a field closes the board's panel (fields handle it themselves).
      e.preventDefault();
      backToList();
    }
  }

  function refreshTimes() {
    if (disposed) return;
    for (const el of root.querySelectorAll('[data-ts]')) {
      const label = timeAgo(Number(el.dataset.ts));
      if (el.textContent !== label) el.textContent = label;
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushSave();
  };
  const onBeforeUnload = () => flushSave();
  const onPageHide = (e) => {
    flushSave();
    // A page parked in the back/forward cache comes back as it was, so only a
    // real unload discards an empty note (mount() prunes any leftovers too).
    if (!e.persisted) discardIfBlank();
  };

  const unsubscribe = store.subscribe(() => render());
  const offMenu = registerContextProvider('notes', contextTarget);
  const stopDay = onDayChange(() => {
    render();
    refreshTimes();
  });
  const clock = setInterval(refreshTimes, CLOCK_MS);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', onPageHide);

  paintLayoutCopy();
  placeTools();
  setPane('list');
  render();
  setMode(editorMode);
  // The board opens at its first column; the list scrolls to the open note.
  if (!isBoard()) revealItem(ui.selectedId);

  /** notesApi.reveal(): open the requested note (in its section's view, or its card's panel on the board). */
  const revealRequested = () => {
    const id = takePendingReveal();
    const note = id ? findNote(id) : null;
    if (!note || disposed) return;
    if (isBoard()) {
      openCard(note.id);
      return;
    }
    if (ui.query) setQuery('');
    if (!noteInView(note, ui.view)) switchView(note.sectionId ?? VIEW_UNSORTED);
    selectNote(note.id);
    revealItem(note.id);
  };
  revealInView = revealRequested;
  revealRequested();
  // Chip widths settle once the web fonts arrive; re-centre the open view then.
  const revealOpenView = () => {
    if (!disposed) nav.revealView(ui.view, { instant: true });
  };
  requestAnimationFrame(revealOpenView);
  document.fonts?.ready.then(revealOpenView, () => {});

  return () => {
    disposed = true;
    if (revealInView === revealRequested) revealInView = null;
    offMenu();
    unsubscribe();
    ui.menu?.close();
    noteDrag.destroy();
    board.destroy();
    nav.destroy();
    flushSave();
    dropIfBlank(ui.editorId);
    stopDay();
    clearInterval(clock);
    cancelAnimationFrame(frame);
    clearTimeout(flashTimer);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', onPageHide);
  };
}

/* ==========================================================================
   notesApi: other modules (Home's quick note) add and open notes through here, so a note made
   elsewhere is created, filed and saved exactly as one made on this page (createNote +
   normalized state). Reads are frozen copies.
   ========================================================================== */

const freezeNote = (n) => Object.freeze({ ...n });

/** The sections in display order: [{ id, name, icon }] (icon null = the default folder). */
function apiGetSections() {
  return Object.freeze(getState().sections.map((s) => Object.freeze({ id: s.id, name: s.name, icon: s.icon ?? null })));
}

/** The `limit` most recently edited notes with something in them, newest first. */
function apiRecent(limit = 3) {
  const n = Math.max(0, Math.floor(Number(limit) || 0));
  const items = getState().items.filter((note) => !isBlank(note));
  return Object.freeze([...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, n).map(freezeNote));
}

/**
 * A new note at the top of its section, as the page's own New note files it. `sectionId` must
 * name an existing section (anything else is Unsorted). -> the frozen note, or null when the
 * title and the text are both empty.
 */
function apiAddNote({ title = '', body = '', sectionId = null } = {}) {
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body === 'string' && body.trim() ? body : '';
  if (!t && !b) return null;
  const s = getState();
  const sid = sectionId != null && findSection(s.sections, sectionId) ? sectionId : null;
  const note = createNote({ id: uid(), title: t, body: b, sectionId: sid });
  save({ ...s, items: [note, ...s.items] });
  return freezeNote(findNote(note.id) ?? note);
}

/** Open the Notes page on this note. False when there is no such note. */
function apiReveal(id) {
  if (!findNote(id)) return false;
  pendingReveal = { id, at: Date.now() };
  if (revealInView) revealInView();
  else location.hash = '#/notes';
  return true;
}

/** fn() after the notes change (here or in another tab); this window's view and selection changes don't fire it. */
function apiSubscribe(fn) {
  let last = getState().items;
  return store.subscribe(() => {
    const { items } = getState();
    if (items === last) return;
    last = items;
    fn();
  });
}

function takePendingReveal() {
  const p = pendingReveal;
  pendingReveal = null;
  return p && Date.now() - p.at < REVEAL_TTL_MS ? p.id : null;
}

export const notesApi = Object.freeze({
  addNote: apiAddNote,
  getSections: apiGetSections,
  recent: apiRecent,
  reveal: apiReveal,
  subscribe: apiSubscribe,
});

export default {
  id: 'notes',
  title: 'Notes',
  icon: 'note',
  badge() {
    const n = getState().items.length;
    return n ? String(n) : '';
  },
  mount,
};
