// LIFE/OS — 11 // Diary: a page a day to write whatever you want. Today opens ready to type; it saves
// as you type (and when you leave). ‹ › go a day back or forward, Today comes back; the list of the
// days you wrote, newest first, opens any of them (to read or change), and the search finds a
// word in all of them. Clearing a day's text removes that day.
//
// Pure rules in diary.logic.js. Store 'diary' (synced, except view: the day open on this device).
// An entry's id is its date, so the same day written on two devices is one entry after a sync.

import { h, icon, pageHeader, toast, todayKey, formatDay, relativeDay, shiftKey, onDayChange, isTyping, modalOpen, menuOpen, plural, dismissTip } from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import * as D from './diary.logic.js';

const TIP_ID = 'diary.intro';
// The list shows this many days at first; "Show older" adds more
const LIST_STEP = 60;
// Typing is saved this long after the last key (and at once on leaving the page or the window)
const SAVE_MS = 500;

/* ==========================================================================
   Store
   ========================================================================== */

const store = createStore('diary', D.DEFAULT_STATE);
let cacheRaw = null;
let cacheState = null;

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheState = D.normalizeState(raw);
  }
  return cacheState;
}

function commit(next) {
  cacheRaw = next;
  cacheState = next;
  store.set(next);
}

// Upgrade older / hand-edited data once, so every reader sees the same shape
if (JSON.stringify(store.get()) !== JSON.stringify(getState())) commit(getState());

/** The day open on this device: today unless another one was picked (never a day still to come). */
function openDay(today = todayKey()) {
  const day = getState().view.day;
  return day && day < today ? day : today;
}

function setOpenDay(day) {
  const s = getState();
  const next = day >= todayKey() ? null : day;
  if (s.view.day !== next) commit({ ...s, view: { ...s.view, day: next } });
}

function writeDay(date, body) {
  const s = getState();
  const next = D.setEntry(s, date, body, Date.now());
  if (next !== s) commit(next);
  if (!D.isBlank(body)) dismissTip(TIP_ID);
}

/** A day's whole entry gone at once, with Undo. */
function deleteDay(date) {
  const s = getState();
  const entry = D.entryFor(s, date);
  if (!entry) return;
  commit(D.setEntry(s, date, '', Date.now()));
  toast(`Diary of ${formatDay(date)} deleted.`, {
    duration: 7000,
    action: { label: 'Undo', onClick: () => commit(D.restoreEntry(getState(), entry)) },
  });
}

/** 'Today' · 'Yesterday' · 'Mon 3 Nov' */
const dayName = (date, today) => (/^(Today|Yesterday)$/.test(relativeDay(date, today)) ? relativeDay(date, today) : formatDay(date));

let pendingFocus = false;

/* ==========================================================================
   The page
   ========================================================================== */

function mount(root) {
  root.classList.add('dy-root');
  const cleanups = [];

  const header = pageHeader({
    index: '11',
    title: 'Diary',
    subtitle: 'Write about your day, or anything at all: a page a day, saved as you type. Only you see it.',
    tipId: TIP_ID,
    stat: D.statusText(getState(), todayKey()),
  });

  /* ---- The page of the open day ---- */
  let day = openDay();
  let saveTimer = 0;
  let dirty = false;

  const prevBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost dy-nav-btn', title: 'The day before', 'aria-label': 'The day before', onClick: () => go(shiftKey(day, -1)) }, icon('chevron-left', { size: 16 }));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost dy-nav-btn', title: 'The day after', 'aria-label': 'The day after', onClick: () => go(shiftKey(day, 1)) }, icon('chevron-right', { size: 16 }));
  const todayBtn = h('button', { type: 'button', class: 'btn btn--sm dy-today', onClick: () => go(todayKey(), { focus: true }) }, 'Today');
  const dayTitle = h('h2', { class: 'dy-day-title' });
  const dayDate = h('p', { class: 'dy-day-date' });
  const text = h('textarea', { class: 'dy-text', id: 'dy-text', spellcheck: 'true', autocomplete: 'off', 'aria-describedby': 'dy-meta' });
  const words = h('span', { class: 'dy-words tnum' });
  const saved = h('span', { class: 'dy-saved', role: 'status' });
  const delBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost dy-del', title: 'Delete this day’s entry', 'aria-label': 'Delete this day’s entry', onClick: () => deleteDay(day) }, icon('trash', { size: 14 }));
  const editor = h(
    'section',
    { class: 'dy-editor panel', 'aria-labelledby': 'dy-day-heading' },
    h('div', { class: 'dy-head' }, prevBtn, h('div', { class: 'dy-day', id: 'dy-day-heading' }, dayTitle, dayDate), nextBtn, h('span', { class: 'spacer' }), todayBtn),
    text,
    h('div', { class: 'dy-meta', id: 'dy-meta' }, words, saved, h('span', { class: 'spacer' }), delBtn),
  );

  function grow() {
    text.style.height = 'auto';
    text.style.height = `${text.scrollHeight + 2}px`;
  }

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    writeDay(day, text.value);
    saved.textContent = D.isBlank(text.value) ? '' : 'Saved';
  }

  text.addEventListener('input', () => {
    dirty = true;
    saved.textContent = 'Saving…';
    paintWords();
    grow();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_MS);
  });
  text.addEventListener('blur', flush);

  function paintWords() {
    const n = D.wordCount(text.value);
    words.textContent = n ? plural(n, 'word') : '';
  }

  /** Show `date`'s page (saving the one open first). */
  function go(date, { focus = false } = {}) {
    flush();
    const today = todayKey();
    day = date > today ? today : date;
    setOpenDay(day);
    paintEditor({ force: true });
    if (focus) text.focus({ preventScroll: true });
  }

  /** The open day's heading, text and buttons. force: the text from the store even while typing. */
  function paintEditor({ force = false } = {}) {
    const s = getState();
    const today = todayKey();
    const entry = D.entryFor(s, day);
    const isToday = day === today;
    dayTitle.textContent = dayName(day, today);
    dayDate.textContent = formatDay(day, 'long');
    nextBtn.disabled = isToday;
    todayBtn.hidden = isToday;
    delBtn.hidden = !entry;
    text.placeholder = isToday ? 'How was today? Write anything: what happened, what you think, what you want to remember.' : entry ? '' : 'Nothing written on this day. Write something now if you like.';
    text.setAttribute('aria-label', `Diary, ${isToday ? 'today' : formatDay(day, 'long')}`);
    // Never under the cursor: what's typed here wins (another window's or device's change shows
    // once you leave the field)
    const typing = document.activeElement === text && !force;
    if (!typing && !dirty) {
      const body = entry?.body ?? '';
      if (text.value !== body) text.value = body;
      saved.textContent = '';
    }
    paintWords();
    requestAnimationFrame(grow);
  }

  /* ---- The days written: search, then the list ---- */
  let query = '';
  let limit = LIST_STEP;
  const search = h('input', { class: 'input dy-search', type: 'search', placeholder: 'Search your diary', 'aria-label': 'Search your diary', autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', () => {
    query = search.value;
    limit = LIST_STEP;
    paintList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      search.value = '';
      query = '';
      paintList();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = listEl.querySelector('.dy-row');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  const countEl = h('p', { class: 'dy-count', role: 'status' });
  const listEl = h('ol', { class: 'dy-list', 'aria-label': 'Days written, newest first' });
  const moreBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost dy-more', onClick: () => ((limit += LIST_STEP), paintList()) }, 'Show older days');
  const side = h('section', { class: 'dy-side panel', 'aria-labelledby': 'dy-side-title' }, h('h2', { class: 'dy-side-title', id: 'dy-side-title' }, icon('book', { size: 15 }), h('span', null, 'Days written')), search, countEl, listEl, moreBtn);

  function row(entry, today) {
    const open = () => go(entry.date, { focus: true });
    return h(
      'li',
      null,
      h(
        'button',
        { type: 'button', class: ['dy-row', entry.date === day && 'is-open'], dataset: { date: entry.date }, 'aria-current': entry.date === day ? 'date' : null, onClick: open },
        h('span', { class: ['dy-row-day', entry.date === today && 'is-today'] }, dayName(entry.date, today)),
        h('span', { class: 'dy-row-words tnum' }, plural(D.wordCount(entry.body), 'word')),
        h('span', { class: 'dy-row-text' }, query.trim() ? D.searchSnippet(entry.body, query) : D.preview(entry.body)),
      ),
    );
  }

  function paintList() {
    const s = getState();
    const today = todayKey();
    const found = D.searchEntries(s.entries, query);
    const focusDate = document.activeElement?.closest?.('.dy-row')?.dataset.date;
    listEl.replaceChildren(...found.slice(0, limit).map((e) => row(e, today)));
    moreBtn.hidden = found.length <= limit;
    search.hidden = s.entries.length < 2 && !query;
    if (query.trim()) countEl.textContent = found.length ? `${plural(found.length, 'day')} with “${query.trim()}”` : `No day has “${query.trim()}”.`;
    else countEl.textContent = s.entries.length ? '' : 'The days you write show here.';
    countEl.hidden = !countEl.textContent;
    if (focusDate) listEl.querySelector(`.dy-row[data-date="${CSS.escape(focusDate)}"]`)?.focus({ preventScroll: true });
  }

  const body = h('div', { class: 'dy-body' }, editor, side);
  root.append(header, body);

  function render() {
    const s = getState();
    header.setStat(D.statusText(s, todayKey()));
    // Another window picked another day: follow it unless this one is being typed in
    const wanted = openDay();
    if (wanted !== day && document.activeElement !== text && !dirty) day = wanted;
    paintEditor();
    paintList();
  }

  /* ---- Right-click (or a long press) on a day in the list: Open, Copy, Delete ---- */
  cleanups.push(
    registerContextProvider('diary', (el) => {
      if (!side.contains(el)) return null;
      const rowEl = el.closest('.dy-row[data-date]');
      const entry = rowEl ? D.entryFor(getState(), rowEl.dataset.date) : null;
      if (!entry) return null;
      return {
        kind: 'diary',
        id: entry.id,
        label: `Diary: ${formatDay(entry.date)}`,
        el: rowEl,
        edit: () => go(entry.date, { focus: true }),
        copy: () => ({ kind: 'diary', snapshot: entry, text: `${formatDay(entry.date, 'long')}\n\n${entry.body}` }),
        remove: () => deleteDay(entry.date),
        can: { paste: false, duplicate: false },
      };
    }),
  );

  // N or /: write (the text field); [ and ]: the day before / after
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || menuOpen() || e.defaultPrevented) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      text.focus();
    } else if (e.key === '/') {
      e.preventDefault();
      if (search.hidden) text.focus();
      else search.focus();
    } else if (e.key === '[') {
      e.preventDefault();
      go(shiftKey(day, -1));
    } else if (e.key === ']') {
      e.preventDefault();
      go(shiftKey(day, 1));
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  // Leaving the window or the page saves what's typed at once
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  cleanups.push(() => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
  });

  render();
  cleanups.push(store.subscribe(render));
  // Midnight: a page left on today moves on to the new today
  let shownToday = todayKey();
  cleanups.push(
    onDayChange((today) => {
      if (day === shownToday && document.activeElement !== text) go(today);
      shownToday = today;
      render();
    }),
  );
  if (pendingFocus || !getState().entries.length || day === todayKey()) {
    // Opened to write: the cursor in today's page (at the end of what's there), unless a phone
    // would throw its keyboard over the page uninvited
    const wantFocus = pendingFocus || !matchMedia('(pointer: coarse)').matches;
    pendingFocus = false;
    if (wantFocus)
      requestAnimationFrame(() => {
        if (!text.isConnected || isTypingElsewhere()) return;
        text.focus({ preventScroll: true });
        text.setSelectionRange(text.value.length, text.value.length);
      });
  }
  return () => {
    flush();
    cleanups.forEach((off) => off());
  };
}

const isTypingElsewhere = () => {
  const a = document.activeElement;
  return !!a && a !== document.body && a.matches?.('input, textarea, select, [contenteditable="true"]');
};

/* ==========================================================================
   Feature
   ========================================================================== */

/** For Search (⌘K): the entries, and a way to open one. */
export const diaryApi = Object.freeze({
  entries: () => getState().entries,
  subscribe: (fn) => store.subscribe(fn),
  /** The Diary page on `date` (today when left out), the cursor in its text. */
  open: (date = null) => {
    setOpenDay(date && D.isDay(date) ? date : todayKey());
    pendingFocus = true;
    if (!/^#\/diary\b/.test(location.hash)) location.hash = '#/diary';
    else {
      const field = document.querySelector('#main > .view[data-feature="diary"] .dy-text');
      pendingFocus = false;
      field?.focus();
    }
  },
});

export default {
  id: 'diary',
  title: 'Diary',
  icon: 'book',
  mount,
};
