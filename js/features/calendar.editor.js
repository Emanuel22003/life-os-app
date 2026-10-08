// LIFE/OS — 04 // Calendar: the event editor dialog (new, edit, repeating events).
//
// openEventEditor({ event?, occurrenceKey?, defaults?, onDone? }) -> { close }
//   event          an Event from the store, or an occurrence (its eventId and start are used)
//   occurrenceKey  for a repeating event: the start day of the occurrence that was opened. The
//                  form shows that date, and saving asks Only this / This and following / All
//                  events. Without it a repeating event is edited as a whole series.
//   defaults       for a new event: { start, end, allDay, startTime, endTime, title?, style? }.
//                  Without times or allDay it becomes a timed event (the next whole hour on
//                  today, 09:00 on other days); a start/end span without allDay is all-day.
//   onDone(result) called once, after the dialog has closed:
//                  { action: 'created' | 'updated' | 'deleted' | 'cancelled',
//                    scope: null | 'only' | 'following' | 'all'   (repeating events),
//                    event: the stored Event that now holds the edited date (null otherwise),
//                    eventId: id of the event that was created, edited or deleted,
//                    key: the day the result is on ('YYYY-MM-DD'), so a view can show it }
//
// Also exported for the views: askScope() (the Only this / following / all question, e.g.
// after dragging a repeating event) and deleteEvent() (the editor's delete flow).
//
// Rules come from calendar.logic.js and every write goes through calendar.store.js, so data
// is normalized, persisted and picked up by other tabs. Changes that touch more than one event
// are written in a single store update, and every delete or series-wide edit offers Undo.

import { h, icon, registerIcon, openModal, toast, todayKey, formatDay, plural, WEEKDAYS_SHORT } from '../ui.js';
import { colorPicker, colorKey, paintColor } from '../colors.js';
import { isValidKey, weekdayOfKey } from './habits.logic.js';
import {
  STYLES,
  STYLE_LABEL,
  FREQS,
  FREQ_LABEL,
  TITLE_MAX,
  LOCATION_MAX,
  NOTES_MAX,
  INTERVAL_MAX,
  LAST_MINUTE,
  DEFAULT_DURATION,
  SNAP_MINUTES,
  WEEK_ORDER,
  WEEKDAYS_LONG,
  parseTime,
  formatTime,
  durationLabel,
  shiftDays,
  daysBetween,
  shiftCursor,
  validateEvent,
  createEvent,
  updateEvent,
  updateSeries,
  detachOccurrence,
  splitSeries,
  deleteOccurrence,
  endSeriesBefore,
  isEmptySeries,
  hasOccurrenceBefore,
  shiftFits,
  occurrenceOf,
  occursOn,
  normalizeRepeat,
  sameRepeat,
  describeRepeat,
} from './calendar.logic.js';
import { getEvents, getEvent, saveEvent, replaceEvents, subscribeCalendar, isNewerFormat } from './calendar.store.js';
import { undoToast, snapshot, revertEvents } from './calendar.undo.js';

registerIcon('cal-repeat', '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>');
registerIcon('cal-location', '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>');

const STEP = SNAP_MINUTES;
const START_GRID = Array.from({ length: 1440 / STEP }, (_, i) => i * STEP);
const UNITS = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };
const CANCELLED = Object.freeze({ action: 'cancelled', scope: null, event: null, eventId: null, key: null });
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const NEWER_COPY = `This event was saved by a newer version of LIFE/OS. Reload (${IS_MAC ? '⌘R' : 'Ctrl+R'}) to edit it.`;
export const SPLIT_NOTE = ' Its every-N-weeks pattern can’t move like this as a whole, so only this date can change.';

const SCOPE_COPY = {
  save: {
    only: ['Only this event', (k) => `${formatDay(k)} · the rest of the series stays as it is`],
    following: ['This and following events', (k) => `From ${formatDay(k)} on · earlier dates stay as they are`],
    all: ['All events', () => 'Every date in the series'],
  },
  delete: {
    only: ['Only this event', (k) => `Removes ${formatDay(k)} · the series keeps going`],
    following: ['This and following events', (k) => `From ${formatDay(k)} on · earlier dates stay`],
    all: ['All events', () => 'The whole series, every date'],
  },
};

let seq = 0;
let active = null; // the open editor, so opening another one replaces it

const cleanText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const shortTitle = (t, max = 48) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);
const quote = (t) => `“${shortTitle(cleanText(t) || 'Untitled event')}”`;
const kbd = (text) => h('span', { class: 'kbd' }, text);
const isComposing = (e) => e.isComposing || e.keyCode === 229;

/* ==========================================================================
   Writes (all through calendar.store.js)
   ========================================================================== */

/** list with `put` events replacing their id (or appended) and `drop` ids removed. */
function mergeEvents(list, put, drop) {
  const byId = new Map(put.map((e) => [e.id, e]));
  const gone = new Set(drop);
  const out = [];
  for (const e of list) {
    if (gone.has(e.id)) continue;
    if (byId.has(e.id)) {
      out.push(byId.get(e.id));
      byId.delete(e.id);
    } else {
      out.push(e);
    }
  }
  out.push(...byId.values());
  return out;
}

/**
 * Apply put / drop in ONE store write. Returns undo(), which puts back exactly what was there,
 * unless one of those events changed since (then it changes nothing and says so).
 */
function commitBatch({ put = [], drop = [] }, what) {
  const ids = [...new Set([...put.map((e) => e.id), ...drop])];
  const before = snapshot(ids);
  replaceEvents(mergeEvents(getEvents(), put, drop));
  const after = snapshot(ids);
  return () => revertEvents(before, after, what);
}

/* ==========================================================================
   Scope question for repeating events
   ========================================================================== */

/**
 * askScope({ mode: 'save' | 'delete', key, title, options }) -> Promise<'only' | 'following' | 'all' | null>
 * Asks which dates of a repeating event a change applies to (null: cancelled). `key` is the
 * occurrence's start day; `options` (default all three) hides choices that don't apply, e.g.
 * 'following' on the first date of a series. The promise has .close() to withdraw the question.
 */
export function askScope({ mode = 'save', key, title = '', options = ['only', 'following', 'all'], note = '' } = {}) {
  const kind = mode === 'delete' ? 'delete' : 'save';
  const leadId = `cal-ed-scope-lead-${++seq}`;
  const copy = SCOPE_COPY[kind];
  const list = (Array.isArray(options) ? options : []).filter((o) => copy[o]);
  let m;
  const promise = new Promise((resolve) => {
    let choice = null;
    const buttons = list.map((o) =>
      h(
        'button',
        {
          type: 'button',
          class: ['cal-ed-scope-opt', kind === 'delete' && 'cal-ed-scope-opt--danger'],
          dataset: { scope: o },
          onClick: () => {
            choice = o;
            m.close();
          },
        },
        h('span', { class: 'cal-ed-scope-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'cal-ed-scope-text' }, h('span', { class: 'cal-ed-scope-name' }, copy[o][0]), h('span', { class: 'cal-ed-scope-sub' }, isValidKey(key) ? copy[o][1](key) : '')),
      ),
    );
    // Arrow keys move between the choices (they read as one list)
    const onKeydown = (e) => {
      const at = buttons.indexOf(document.activeElement);
      if (at === -1) return;
      let next = -1;
      if (e.key === 'ArrowDown') next = (at + 1) % buttons.length;
      else if (e.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = buttons.length - 1;
      if (next === -1) return;
      e.preventDefault();
      buttons[next].focus();
    };
    const lead = kind === 'delete' ? ' repeats. Which dates should be deleted?' : ' repeats. Which dates should change?';
    m = openModal({
      title: kind === 'delete' ? 'Delete repeating event' : 'Save repeating event',
      className: 'cal-ed-scope',
      body: [
        h('p', { class: 'cal-ed-scope-lead', id: leadId }, h('span', { class: 'cal-ed-wrap' }, quote(title)), lead, note ? h('span', { class: 'cal-ed-scope-note' }, note) : null),
        h('div', { class: 'cal-ed-scope-list', role: 'group', 'aria-label': kind === 'delete' ? 'Delete' : 'Apply changes to', onKeydown }, buttons),
      ],
      footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel')],
      initialFocus: buttons[0],
      onClose: () => resolve(choice),
    });
    // The question itself is read with the dialog, not only its title
    m.el.setAttribute('aria-describedby', leadId);
  });
  promise.close = () => m?.close();
  return promise;
}

/* ==========================================================================
   Delete flow (editor button, or a view's Delete key)
   ========================================================================== */

function deleteToast(live, scope, key) {
  if (scope === 'only') return `Deleted ${quote(live.title)} on ${formatDay(key)}`;
  if (scope === 'following') return `Deleted ${quote(live.title)} from ${formatDay(key)} on`;
  return live.repeat ? `Deleted every date of ${quote(live.title)}` : `Deleted ${quote(live.title)}`;
}

function applyDelete(live, scope, key) {
  let rest = null; // what stays of the series (null: the event is removed entirely)
  if (scope === 'only') {
    rest = deleteOccurrence(live, key, { now: Date.now() });
  } else if (scope === 'following') {
    rest = endSeriesBefore(live, key, { now: Date.now() });
  }
  // A series with no date left would be invisible and impossible to delete: remove it instead
  if (rest && isEmptySeries(rest)) rest = null;
  const undo = commitBatch(rest ? { put: [rest] } : { drop: [live.id] }, quote(live.title));
  undoToast(deleteToast(live, scope, key), undo);
  return { action: 'deleted', scope: live.repeat ? scope : null, event: null, eventId: live.id, key: key ?? live.start };
}

/** Delete confirmation whose message is announced with the dialog (aria-describedby). */
function confirmDelete({ title, message, confirmLabel }) {
  return new Promise((resolve) => {
    let ok = false;
    const msgId = `cal-ed-confirm-${++seq}`;
    const confirmBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--danger',
        onClick: () => {
          ok = true;
          m.close();
        },
      },
      confirmLabel,
    );
    const m = openModal({
      title,
      className: 'cal-ed-scope',
      body: h('p', { class: 'muted cal-ed-wrap', id: msgId }, message),
      footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), confirmBtn],
      initialFocus: confirmBtn,
      onClose: () => resolve(ok),
    });
    m.el.setAttribute('aria-describedby', msgId);
  });
}

/** Confirm (or ask the scope), delete, toast with Undo. Resolves to an onDone-style result. */
async function runDelete(id, occurrenceKey, { onAsk } = {}) {
  const live = getEvent(id);
  if (!live) {
    toast('That event was already deleted.');
    return { ...CANCELLED, gone: true };
  }
  const key = live.repeat && isValidKey(occurrenceKey) && occursOn(live, occurrenceKey) ? occurrenceKey : null;
  let scope;
  if (key) {
    // "This and following" only when a date before this one stays (the start isn't always a date)
    const ask = askScope({ mode: 'delete', key, title: live.title, options: hasOccurrenceBefore(live, key) ? ['only', 'following', 'all'] : ['only', 'all'] });
    onAsk?.(ask);
    scope = await ask;
  } else {
    const ok = await confirmDelete({
      title: live.repeat ? 'Delete repeating event?' : 'Delete event?',
      message: live.repeat ? `${quote(live.title)} and every date in its series will be removed.` : `${quote(live.title)} will be removed from the calendar.`,
      confirmLabel: live.repeat ? 'Delete all' : 'Delete',
    });
    scope = ok ? 'all' : null;
  }
  if (!scope) return CANCELLED;
  // Re-read: another tab may have changed the event while the question was open. Never widen
  // the user's choice: if the chosen dates are already gone, nothing else is deleted.
  const current = getEvent(id);
  if (!current) {
    toast('That event was already deleted.');
    return { ...CANCELLED, gone: true };
  }
  if (scope !== 'all' && !current.repeat) {
    toast('That event no longer repeats, so nothing was deleted.');
    return CANCELLED;
  }
  if (scope === 'only' && !occursOn(current, key)) {
    toast('That date was already removed from the series.');
    return CANCELLED;
  }
  return applyDelete(current, scope, key);
}

/**
 * deleteEvent({ event, occurrenceKey }) -> Promise<result>
 * The editor's delete flow without the editor: a repeating occurrence asks Only this / This and
 * following / All events, anything else asks for confirmation; then a toast with Undo.
 * Resolves to { action: 'deleted', scope, eventId, key, event: null } or { action: 'cancelled' }.
 */
export async function deleteEvent({ event, occurrenceKey = null } = {}) {
  const id = event ? String(event.eventId ?? event.id ?? '') : '';
  const key = occurrenceKey ?? (event && event.occId ? event.start : null);
  const res = await runDelete(id, key);
  const { gone, ...out } = res;
  return out;
}

/* ==========================================================================
   Form pieces
   ========================================================================== */

/** Native radios styled as a segmented control. -> { el, get(), set(v), input(v) } */
function radioSeg({ name, options, labels, value, labelledBy, describedBy, className, onChange }) {
  const inputs = new Map();
  const opts = new Map();
  const paint = () => opts.forEach((label, o) => label.classList.toggle('is-on', inputs.get(o).checked));
  const el = h(
    'div',
    { class: ['seg', 'cal-ed-seg', className], role: 'radiogroup', 'aria-labelledby': labelledBy, 'aria-describedby': describedBy },
    options.map((o) => {
      const input = h('input', {
        type: 'radio',
        class: 'cal-ed-radio',
        name,
        value: o,
        checked: o === value,
        onChange: () => {
          paint();
          if (input.checked) onChange?.(o);
        },
      });
      inputs.set(o, input);
      const label = h('label', { class: 'seg-btn cal-ed-seg-opt' }, input, h('span', null, labels[o]));
      opts.set(o, label);
      return label;
    }),
  );
  paint();
  return {
    el,
    get: () => options.find((o) => inputs.get(o).checked) ?? options[0],
    set(v) {
      if (!inputs.has(v)) return;
      inputs.get(v).checked = true;
      paint();
    },
    input: (v) => inputs.get(v),
  };
}

function fillStart(sel, value) {
  const list = START_GRID.includes(value) ? START_GRID : [...START_GRID, value].sort((a, b) => a - b);
  sel.replaceChildren(...list.map((m) => h('option', { value: String(m) }, formatTime(m))));
  sel.value = String(value);
}

// A closed <select> shows its option's text, and on phones '10:45 · 1h 30m' doesn't fit
const roomyTimes = typeof matchMedia === 'function' ? matchMedia('(min-width: 641px)') : null;

/** End times after `start` (15-minute steps, then 23:59), with their length where there is room. */
function fillEnd(sel, start, value) {
  const list = [];
  for (let m = Math.floor(start / STEP) * STEP + STEP; m < 1440; m += STEP) list.push(m);
  list.push(LAST_MINUTE);
  if (value > start && !list.includes(value)) list.push(value);
  list.sort((a, b) => a - b);
  const withLength = !roomyTimes || roomyTimes.matches;
  sel.replaceChildren(...list.map((m) => h('option', { value: String(m) }, withLength ? `${formatTime(m)} · ${durationLabel(start, m)}` : formatTime(m))));
  sel.value = String(list.includes(value) ? value : list[0]);
}

/** First slot for a new timed event: the next whole hour today, 09:00 on other days. */
function defaultSlot(start, today) {
  if (start !== today) return [9 * 60, 10 * 60];
  const next = (new Date().getHours() + 1) * 60;
  const s = Math.min(next, 23 * 60);
  return [s, Math.min(s + DEFAULT_DURATION, LAST_MINUTE)];
}

function fromDefaults(raw, today) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const start = isValidKey(d.start) ? d.start : today;
  const sMin = parseTime(d.startTime);
  const allDay = typeof d.allDay === 'boolean' ? d.allDay : sMin === null && isValidKey(d.end) && d.end > start;
  let s;
  let e;
  if (sMin !== null) {
    s = Math.min(sMin, LAST_MINUTE - 1);
    e = parseTime(d.endTime);
  } else {
    [s, e] = defaultSlot(start, today);
  }
  if (e === null || e <= s) e = Math.min(s + DEFAULT_DURATION, LAST_MINUTE);
  return {
    title: typeof d.title === 'string' ? d.title : '',
    allDay,
    start,
    end: allDay && isValidKey(d.end) && d.end >= start ? d.end : start,
    startMin: s,
    endMin: e,
    location: '',
    notes: '',
    style: STYLES.includes(d.style) ? d.style : 'solid',
    color: colorKey(d.color),
    repeat: null,
  };
}

function fromEvent(ev, occ) {
  const when = occ ?? ev;
  const s = parseTime(when.startTime);
  const e = parseTime(when.endTime);
  const timed = !when.allDay && s !== null;
  return {
    title: ev.title,
    allDay: !timed,
    start: when.start,
    end: when.end,
    startMin: timed ? s : 9 * 60,
    endMin: timed && e !== null && e > s ? e : timed ? Math.min(s + DEFAULT_DURATION, LAST_MINUTE) : 10 * 60,
    location: ev.location ?? '',
    notes: ev.notes ?? '',
    style: STYLES.includes(ev.style) ? ev.style : 'solid',
    color: colorKey(ev.color),
    repeat: ev.repeat ?? null,
  };
}

/* ==========================================================================
   The editor
   ========================================================================== */

export function openEventEditor({ event = null, occurrenceKey = null, defaults = null, onDone = null } = {}) {
  active?.dismiss();

  const today = todayKey();
  const n = ++seq;
  const fid = (s) => `cal-ed-${n}-${s}`;

  // ---- What is being edited (always the stored copy, never the caller's object)
  const id = event ? String(event.eventId ?? event.id ?? '') : '';
  const base = id ? getEvent(id) : null;
  if (event && !base) {
    toast('That event no longer exists.');
    queueMicrotask(() => onDone?.(CANCELLED));
    return { close() {} };
  }
  if (base && isNewerFormat(base.id)) {
    toast(NEWER_COPY);
    queueMicrotask(() => onDone?.(CANCELLED));
    return { close() {} };
  }
  const isEdit = !!base;
  const occHint = occurrenceKey ?? (event && event.occId ? event.start : null);
  const occKey = isEdit && base.repeat && isValidKey(occHint) && occursOn(base, occHint) ? occHint : null;
  const init = isEdit ? fromEvent(base, occKey ? occurrenceOf(base, occKey) : null) : fromDefaults(defaults, today);
  // A rule made in this dialog follows the start date's weekday until the user picks days
  const freshRule = !isEdit || !base.repeat;

  let allDay = init.allDay;
  let sMin = init.startMin;
  let eMin = init.endMin;
  let freq = init.repeat ? init.repeat.freq : 'none';
  let days = init.repeat && init.repeat.freq === 'weekly' ? [...init.repeat.days] : [];
  let daysTouched = !freshRule;
  let lastStart = init.start;
  let closed = false;
  let busy = false; // a follow-up question (scope / confirm) is open
  let pendingAsk = null;
  let result = null;

  /* ---- Title ---- */
  const titleErr = errorLine(fid('title-err'));
  const titleIn = h('input', {
    id: fid('title'),
    class: 'input cal-ed-title',
    type: 'text',
    value: init.title,
    maxlength: TITLE_MAX,
    placeholder: 'e.g. Dentist, Team sync, Trip to Bergen',
    autocomplete: 'off',
    enterkeyhint: 'done',
    required: true,
    'aria-describedby': titleErr.id,
    onInput: syncPreview,
  });

  /* ---- When ---- */
  const whenErr = errorLine(fid('when-err'));
  const allDaySw = h(
    'button',
    { type: 'button', class: 'cal-ed-switch', role: 'switch', id: fid('allday'), 'aria-checked': String(allDay), onClick: () => setAllDay(!allDay) },
    h('span', { class: 'cal-ed-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'cal-ed-switch-thumb' })),
    h('span', null, 'All day'),
  );
  const startDate = h('input', {
    id: fid('start'),
    class: 'input cal-ed-date',
    type: 'date',
    value: init.start,
    min: '1970-01-01',
    max: '9999-12-31',
    required: true,
    'aria-describedby': whenErr.id,
    onInput: onStartDate,
  });
  const endDate = h('input', {
    id: fid('end'),
    class: 'input cal-ed-date',
    type: 'date',
    value: init.end,
    min: init.start,
    max: '9999-12-31',
    'aria-describedby': whenErr.id,
    onInput: syncLength,
  });
  const startSel = h('select', { id: fid('stime'), class: 'select cal-ed-time', 'aria-describedby': whenErr.id, onChange: onStartTime });
  const endSel = h('select', {
    id: fid('etime'),
    class: 'select cal-ed-time',
    'aria-describedby': whenErr.id,
    onChange: () => {
      eMin = Number(endSel.value);
      syncLength();
      syncPreview();
    },
  });
  fillStart(startSel, sMin);
  fillEnd(endSel, sMin, eMin);

  const startDateLabel = h('label', { class: 'label', for: startDate.id }, 'Date');
  const fStartDate = h('div', { class: 'field cal-ed-f-date' }, startDateLabel, startDate);
  const fEndDate = h('div', { class: 'field cal-ed-f-end' }, h('label', { class: 'label', for: endDate.id }, 'End date'), endDate);
  const fStartTime = h('div', { class: 'field cal-ed-f-time' }, h('label', { class: 'label', for: startSel.id }, 'Start'), startSel);
  const fEndTime = h('div', { class: 'field cal-ed-f-time' }, h('label', { class: 'label', for: endSel.id }, 'End'), endSel);
  const whenGrid = h('div', { class: 'cal-ed-when' }, fStartDate, fEndDate, fStartTime, fEndTime);
  const lengthOut = h('p', { class: 'cal-ed-hint', 'aria-live': 'polite' });

  /* ---- Repeat ---- */
  const repeatErr = errorLine(fid('repeat-err'));
  const freqSeg = radioSeg({
    name: fid('freq'),
    options: ['none', ...FREQS],
    labels: { none: 'None', ...FREQ_LABEL },
    value: freq,
    labelledBy: fid('repeat-label'),
    describedBy: repeatErr.id,
    className: 'cal-ed-freq',
    onChange: (v) => {
      freq = v;
      if (freq === 'weekly' && !days.length && isValidKey(startDate.value)) days = [weekdayOfKey(startDate.value)];
      syncRepeat();
    },
  });
  const intervalIn = h('input', {
    id: fid('interval'),
    class: 'input cal-ed-interval',
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: INTERVAL_MAX,
    step: 1,
    value: String(init.repeat?.interval ?? 1),
    'aria-describedby': repeatErr.id,
    onInput: syncRepeat,
  });
  const unitEl = h('span', { class: 'cal-ed-unit', id: fid('unit') });
  intervalIn.setAttribute('aria-labelledby', `${fid('every')} ${fid('interval')} ${unitEl.id}`);
  const dayBtns = WEEK_ORDER.map((d) =>
    h(
      'button',
      {
        type: 'button',
        class: 'cal-ed-wd',
        'aria-pressed': 'false',
        'aria-label': WEEKDAYS_LONG[d],
        title: WEEKDAYS_LONG[d],
        dataset: { d: String(d) },
        'aria-describedby': repeatErr.id,
        onClick: () => {
          days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b);
          daysTouched = true;
          clearError(dayBtns);
          syncRepeat();
        },
      },
      WEEKDAYS_SHORT[d],
    ),
  );
  const daysGroup = h('div', { class: 'cal-ed-days', role: 'group', 'aria-labelledby': fid('on-label') }, dayBtns);
  const endsSeg = radioSeg({
    name: fid('ends'),
    options: ['never', 'on'],
    labels: { never: 'Never', on: 'On date' },
    value: init.repeat?.until ? 'on' : 'never',
    labelledBy: fid('ends-label'),
    className: 'cal-ed-ends-seg',
    onChange: (v) => {
      if (v === 'on' && !untilIn.value && isValidKey(startDate.value)) untilIn.value = shiftCursor('month', startDate.value, 3);
      clearError(untilIn);
      syncRepeat();
    },
  });
  const untilIn = h('input', {
    id: fid('until'),
    class: 'input cal-ed-date cal-ed-until',
    type: 'date',
    value: init.repeat?.until ?? '',
    min: init.start,
    max: '9999-12-31',
    'aria-label': 'Last date of the repeat',
    'aria-describedby': repeatErr.id,
    onInput: syncRepeat,
  });
  const summaryText = h('span');
  const summary = h('p', { class: 'cal-ed-summary', 'aria-live': 'polite' }, icon('cal-repeat', { size: 12 }), summaryText);
  const daysRow = h('div', { class: 'cal-ed-row' }, h('span', { class: 'label cal-ed-row-label', id: fid('on-label') }, 'On'), daysGroup);
  const repeatBox = h(
    'div',
    { class: 'cal-ed-repeat' },
    h('div', { class: 'cal-ed-row cal-ed-every' }, h('span', { class: 'label cal-ed-row-label', id: fid('every') }, 'Every'), intervalIn, unitEl),
    daysRow,
    h('div', { class: 'cal-ed-row cal-ed-ends' }, h('span', { class: 'label cal-ed-row-label', id: fid('ends-label') }, 'Ends'), endsSeg.el, untilIn),
    summary,
  );

  /* ---- Details ---- */
  const locIn = h('input', {
    id: fid('loc'),
    class: 'input',
    type: 'text',
    value: init.location,
    maxlength: LOCATION_MAX,
    placeholder: 'Add a place or a link',
    autocomplete: 'off',
    enterkeyhint: 'done',
  });
  const notesIn = h('textarea', { id: fid('notes'), class: 'textarea cal-ed-notes', rows: 3, maxlength: NOTES_MAX, placeholder: 'Agenda, address, what to bring…', value: init.notes });

  /* ---- Look ---- */
  const styleInputs = new Map();
  const styleOpts = new Map();
  const styleGroup = h(
    'div',
    { class: 'cal-ed-styles', role: 'radiogroup', 'aria-labelledby': fid('look-label') },
    STYLES.map((s) => {
      const input = h('input', { type: 'radio', class: 'cal-ed-radio', name: fid('style'), value: s, checked: s === init.style, onChange: syncPreview });
      styleInputs.set(s, input);
      const opt = h(
        'label',
        { class: 'cal-ed-style' },
        input,
        h('span', { class: `cal-ed-swatch cal-ev--${s}`, 'aria-hidden': 'true' }),
        h('span', { class: 'cal-ed-style-name' }, icon('check', { size: 10, stroke: 2.5, className: 'cal-ed-style-tick' }), STYLE_LABEL[s]),
      );
      styleOpts.set(s, opt);
      return opt;
    }),
  );
  const previewTime = h('span', { class: 'cal-ed-preview-time' });
  const previewTitle = h('span', { class: 'cal-ed-preview-title' });
  const preview = h('div', { class: 'cal-ed-preview' }, previewTime, previewTitle);
  const selectedStyle = () => STYLES.find((s) => styleInputs.get(s).checked) ?? 'solid';
  // Color coding: the event's color (shown in the preview too)
  const colorIn = colorPicker({ value: init.color, label: 'Color', onChange: () => syncPreview() });

  /* ---- Banner (repeating) + notice (deleted elsewhere) ---- */
  const banner =
    isEdit && base.repeat
      ? h(
          'div',
          { class: 'cal-ed-banner' },
          icon('cal-repeat', { size: 12 }),
          h(
            'span',
            null,
            h('strong', null, 'Repeats'),
            ` · ${describeRepeat(base.repeat, base.start)}`,
            h('br'),
            occKey ? `Editing ${formatDay(occKey)} · you choose which dates change when you save` : 'Changes apply to every date in the series',
          ),
        )
      : null;
  const notice = h('p', { class: 'cal-ed-notice', role: 'status', hidden: true });
  // One assertive region announces validation errors (the visible lines are descriptions)
  const errLive = h('p', { class: 'sr-only', role: 'alert', 'aria-atomic': 'true' });

  const form = h(
    'form',
    {
      class: 'cal-ed-form',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
      onKeydown: (e) => {
        if (e.key !== 'Enter' || isComposing(e) || e.metaKey || e.ctrlKey) return;
        if (e.target instanceof HTMLInputElement && e.target.type !== 'radio') {
          e.preventDefault();
          submit();
        }
      },
      onInput: (e) => clearError(e.target),
      onChange: (e) => clearError(e.target),
    },
    banner,
    notice,
    errLive,
    h('div', { class: 'field' }, h('label', { class: 'label', for: titleIn.id }, 'Title'), titleIn, titleErr),
    h(
      'div',
      { class: 'cal-ed-group', role: 'group', 'aria-labelledby': fid('when-label') },
      h('div', { class: 'cal-ed-group-head' }, h('span', { class: 'label', id: fid('when-label') }, 'When'), allDaySw),
      whenGrid,
      lengthOut,
      whenErr,
    ),
    h('div', { class: 'cal-ed-group' }, h('span', { class: 'label', id: fid('repeat-label') }, 'Repeat'), freqSeg.el, repeatBox, repeatErr),
    h(
      'div',
      { class: 'cal-ed-details' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: locIn.id }, 'Location'), h('div', { class: 'input-group' }, icon('cal-location', { size: 14 }), locIn)),
      h('div', { class: 'field' }, h('label', { class: 'label', for: notesIn.id }, 'Notes'), notesIn),
    ),
    h(
      'div',
      { class: 'cal-ed-group', role: 'group', 'aria-labelledby': fid('look-label') },
      h('div', { class: 'cal-ed-group-head' }, h('span', { class: 'label', id: fid('look-label') }, 'Look'), h('span', { class: 'cal-ed-hint' }, 'Tell kinds of events apart')),
      styleGroup,
      h('div', { class: 'cal-ed-color cc-field', dataset: { ccFor: 'events' } }, h('span', { class: 'label' }, 'Color'), colorIn.el),
      h('div', { class: 'cal-ed-preview-row', 'aria-hidden': 'true' }, h('span', { class: 'label' }, 'Preview'), preview),
    ),
  );

  /* ---- Errors ---- */

  function errorLine(errId) {
    return h('p', { id: errId, class: 'cal-ed-error', hidden: true }, icon('x', { size: 12 }), h('span'));
  }

  const FIELD = {
    title: () => [[titleIn], titleErr],
    start: () => [[startDate], whenErr],
    end: () => [[endDate], whenErr],
    startTime: () => [[startSel], whenErr],
    endTime: () => [[endSel], whenErr],
    repeat: () => [[freqSeg.input(freqSeg.get())], repeatErr],
    interval: () => [[intervalIn], repeatErr],
    days: () => [dayBtns, repeatErr],
    until: () => [[untilIn], repeatErr],
  };
  const ERR_LINES = [titleErr, whenErr, repeatErr];

  /** Hide an error line and drop its text, so fields that point at it no longer read it. */
  function hideError(err) {
    err.hidden = true;
    err.lastChild.textContent = '';
  }

  function showError(field, message) {
    clearAllErrors();
    const [ctls, err] = (FIELD[field] ?? FIELD.title)();
    err.lastChild.textContent = message;
    err.hidden = false;
    for (const c of ctls) c.setAttribute('aria-invalid', 'true');
    ctls[0].focus();
    // Announce it even when focus stays where it was (Enter in an empty title)
    errLive.textContent = '';
    setTimeout(() => {
      if (!closed) errLive.textContent = message;
    }, 60);
  }

  function clearAllErrors() {
    ERR_LINES.forEach(hideError);
    errLive.textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  }

  /** Clear the error of the control(s) the user just changed (and its message once its group is clean). */
  function clearError(target) {
    const list = Array.isArray(target) ? target : [target?.closest?.('[aria-invalid]')];
    const ctls = list.filter((c) => c && c.hasAttribute?.('aria-invalid') && form.contains(c));
    if (!ctls.length) return;
    // The weekday toggles share one error: changing any of them clears all of them
    for (const c of ctls.some((c) => dayBtns.includes(c)) ? [...ctls, ...dayBtns] : ctls) c.removeAttribute('aria-invalid');
    for (const err of ERR_LINES) {
      if (!err.hidden && ![...form.querySelectorAll('[aria-invalid]')].some((el) => (el.getAttribute('aria-describedby') ?? '').includes(err.id))) hideError(err);
    }
  }

  /* ---- Sync ---- */

  function setAllDay(next) {
    allDay = next;
    if (allDay && (!isValidKey(endDate.value) || (isValidKey(startDate.value) && endDate.value < startDate.value))) endDate.value = startDate.value;
    clearError(allDay ? startSel : endDate);
    syncWhen();
  }

  function onStartDate() {
    const v = startDate.value;
    if (isValidKey(v)) {
      // The end date keeps the span; a fresh weekly rule keeps following the start's weekday
      if (isValidKey(lastStart) && isValidKey(endDate.value)) endDate.value = shiftDays(v, Math.max(0, daysBetween(lastStart, endDate.value)));
      if (!daysTouched && isValidKey(lastStart) && days.length === 1 && days[0] === weekdayOfKey(lastStart)) days = [weekdayOfKey(v)];
      lastStart = v;
      endDate.min = v;
      untilIn.min = v;
    }
    syncLength();
    syncRepeat();
  }

  function onStartTime() {
    const next = Number(startSel.value);
    const length = Math.max(1, eMin - sMin);
    sMin = next;
    eMin = Math.min(next + length, LAST_MINUTE);
    if (eMin <= sMin) eMin = LAST_MINUTE;
    fillEnd(endSel, sMin, eMin);
    eMin = Number(endSel.value);
    clearError(endSel);
    syncLength();
    syncPreview();
  }

  function syncWhen() {
    allDaySw.setAttribute('aria-checked', String(allDay));
    whenGrid.classList.toggle('is-allday', allDay);
    fEndDate.hidden = !allDay;
    fStartTime.hidden = allDay;
    fEndTime.hidden = allDay;
    startDateLabel.textContent = allDay ? 'Start date' : 'Date';
    syncLength();
    syncPreview();
  }

  function syncLength() {
    if (allDay) {
      const s = startDate.value;
      const e = endDate.value;
      lengthOut.textContent = isValidKey(s) && isValidKey(e) && e >= s ? (e === s ? `All day · ${formatDay(s)}` : `${plural(daysBetween(s, e) + 1, 'day')} · ${formatDay(s)} – ${formatDay(e)}`) : '';
    } else {
      lengthOut.textContent = `${formatTime(sMin)}–${formatTime(eMin)} · ${durationLabel(sMin, eMin)}`;
    }
  }

  function readRepeat() {
    if (freq === 'none') return null;
    return { freq, interval: intervalIn.value.trim(), days: freq === 'weekly' ? days.slice() : [], until: endsSeg.get() === 'on' ? untilIn.value : null };
  }

  function syncRepeat() {
    repeatBox.hidden = freq === 'none';
    daysRow.hidden = freq !== 'weekly';
    untilIn.hidden = endsSeg.get() !== 'on';
    const k = Number(intervalIn.value);
    const okInterval = Number.isInteger(k) && k >= 1 && k <= INTERVAL_MAX;
    if (UNITS[freq]) unitEl.textContent = UNITS[freq][okInterval && k === 1 ? 0 : 1];
    dayBtns.forEach((b) => b.setAttribute('aria-pressed', String(days.includes(Number(b.dataset.d)))));
    const start = startDate.value;
    if (freq === 'none') summaryText.textContent = '';
    else if (!okInterval && intervalIn.value.trim() !== '') summaryText.textContent = `Repeat every 1 to ${INTERVAL_MAX} ${UNITS[freq][1]}`;
    else if (freq === 'weekly' && !days.length) summaryText.textContent = 'Pick at least one weekday';
    else if (!isValidKey(start)) summaryText.textContent = 'Pick a start date';
    else summaryText.textContent = describeRepeat({ ...readRepeat(), interval: okInterval ? k : 1, until: isValidKey(untilIn.value) && endsSeg.get() === 'on' ? untilIn.value : null }, start);
  }

  function syncPreview() {
    const style = selectedStyle();
    styleOpts.forEach((opt, s) => opt.classList.toggle('is-on', s === style));
    preview.className = `cal-ed-preview cal-ev--${style}`;
    paintColor(preview, 'events', colorIn.get());
    previewTime.textContent = allDay ? 'All day' : `${formatTime(sMin)}–${formatTime(eMin)}`;
    previewTitle.textContent = cleanText(titleIn.value) || 'Untitled event';
    previewTitle.classList.toggle('is-placeholder', !cleanText(titleIn.value));
  }

  /* ---- Read / compare ---- */

  function readInput() {
    const start = startDate.value;
    return {
      title: titleIn.value,
      allDay,
      start,
      end: allDay ? endDate.value : start,
      startTime: allDay ? null : formatTime(sMin),
      endTime: allDay ? null : formatTime(eMin),
      location: locIn.value,
      notes: notesIn.value.replace(/\s+$/, ''),
      style: selectedStyle(),
      color: colorIn.get(),
      repeat: readRepeat(),
    };
  }

  /** The when-fields go together: a change to any of them sends all of them. */
  const WHEN = ['allDay', 'start', 'end', 'startTime', 'endTime'];
  const whenSig = (i) => JSON.stringify([i.allDay, i.start, i.allDay ? i.end : null, i.startTime, i.endTime]);

  /**
   * Only what the user changed in this dialog, as a patch for the stored event. Fields left alone
   * are not sent, so a change made meanwhile in another window (notes, place, look …) survives.
   */
  function changedFields(input) {
    const p = {};
    if (cleanText(input.title) !== cleanText(initial.title)) p.title = input.title;
    if (whenSig(input) !== whenSig(initial)) for (const k of WHEN) p[k] = input[k];
    if (cleanText(input.location) !== cleanText(initial.location)) p.location = input.location;
    if (input.notes !== initial.notes) p.notes = input.notes;
    if (input.style !== initial.style) p.style = input.style;
    if ((input.color ?? null) !== (initial.color ?? null)) p.color = input.color;
    if (JSON.stringify(input.repeat) !== JSON.stringify(initial.repeat)) p.repeat = input.repeat;
    return p;
  }

  /* ---- Save ---- */

  function finish(res) {
    result = res;
    m.close();
  }

  function saveNew(input, note) {
    const res = createEvent(input);
    if (res.error) return showError(res.field, res.error);
    const saved = saveEvent(res.event);
    if (!saved) return showError('title', 'This event could not be saved.');
    if (note) toast(note);
    finish({ action: 'created', scope: null, event: saved, eventId: saved.id, key: saved.start });
  }

  function saveToast(scope, title, key) {
    if (scope === 'only') return `Changed ${quote(title)} on ${formatDay(key)} only`;
    if (scope === 'following') return `Changed ${quote(title)} from ${formatDay(key)} on`;
    return `Changed every date of ${quote(title)}`;
  }

  /** Save a repeating event's occurrence with the chosen scope (one store write, Undo in the toast). */
  function applyScoped(live, key, patch, scope, input) {
    const now = Date.now();
    let res;
    if (scope === 'only') res = detachOccurrence(live, key, patch, { now });
    else if (scope === 'following') res = splitSeries(live, key, patch, { now });
    else res = updateSeries(live, key, patch, { now });
    if (res.error) {
      showError(res.field ?? 'start', res.error);
      return;
    }
    let put;
    let drop = [];
    let primary;
    if (scope === 'only') {
      put = [res.series, res.single];
      primary = res.single;
    } else if (scope === 'following') {
      // series is null when no date stays before `key`: the new series replaces the old one
      put = res.series ? [res.series, res.next] : [res.next];
      if (!res.series) drop = [live.id];
      primary = res.next;
    } else {
      put = [res.event];
      primary = res.event;
    }
    const undo = commitBatch({ put, drop }, quote(live.title));
    undoToast(saveToast(scope, input.title, key), undo);
    finish({ action: 'updated', scope, event: getEvent(primary.id) ?? primary, eventId: live.id, key: input.start });
  }

  function submit() {
    if (closed || busy) return;
    const input = readInput();
    if (freq !== 'none' && endsSeg.get() === 'on' && !untilIn.value) return showError('until', 'Pick the day the repeat ends.');
    const v = validateEvent(input);
    if (!v.ok) return showError(v.field, v.error);
    if (!isEdit) return saveNew(input);

    // Deleted elsewhere: Save keeps the promise of the notice (adds it back), even untouched
    const live = getEvent(base.id);
    if (!live) return saveNew(occKey ? { ...input, repeat: null } : input, 'The original was deleted in another window, so this was saved as a new event.');
    const patch = changedFields(input);
    if (!Object.keys(patch).length) return finish(CANCELLED);
    if (isNewerFormat(live.id)) return showError('title', NEWER_COPY);

    if (!live.repeat) {
      const res = updateEvent(live, patch, { now: Date.now() });
      if (res.error) return showError(res.field, res.error);
      const saved = saveEvent(res.event) ?? res.event;
      return finish({ action: 'updated', scope: null, event: saved, eventId: live.id, key: saved.start });
    }

    if (!occKey) {
      // The whole series, as shown from its first date: a date change moves every occurrence
      const res = updateSeries(live, base.start, patch, { now: Date.now() });
      if (res.error) return showError(res.field, res.error);
      const undo = commitBatch({ put: [res.event] }, quote(live.title));
      undoToast(saveToast('all', input.title), undo);
      const saved = getEvent(res.event.id) ?? res.event;
      return finish({ action: 'updated', scope: 'all', event: saved, eventId: live.id, key: saved.start });
    }

    if (!occursOn(live, occKey)) {
      return saveNew({ ...input, repeat: null }, 'That date was removed from the series in another window, so this was saved as a separate event.');
    }

    // Changing the rule itself only makes sense for this-and-following or the whole series
    const ruleChanged = 'repeat' in patch && !sameRepeat(patch.repeat ? normalizeRepeat(patch.repeat, live.start) : null, live.repeat);
    // An every-N-weeks rule can't always follow a date move (shiftFits): then only this date moves
    const fits = ruleChanged || !('start' in patch) || shiftFits(live, daysBetween(occKey, patch.start));
    const options = [];
    if (!ruleChanged) options.push('only');
    if (fits && hasOccurrenceBefore(live, occKey)) options.push('following');
    if (fits) options.push('all');
    if (options.length === 1 && options[0] === 'all') return applyScoped(live, occKey, patch, 'all', input);

    busy = true;
    pendingAsk = askScope({ mode: 'save', key: occKey, title: live.title, options, note: fits ? '' : SPLIT_NOTE });
    pendingAsk.then((scope) => {
      busy = false;
      pendingAsk = null;
      if (closed || !scope) return;
      const fresh = getEvent(live.id);
      if (!fresh) return saveNew({ ...input, repeat: null }, 'The original was deleted in another window, so this was saved as a new event.');
      if (!occursOn(fresh, occKey)) return saveNew({ ...input, repeat: null }, 'That date was removed from the series in another window, so this was saved as a separate event.');
      applyScoped(fresh, occKey, patch, scope, input);
    });
  }

  async function onDelete() {
    if (closed || busy || !isEdit) return;
    busy = true;
    const res = await runDelete(base.id, occKey, { onAsk: (ask) => (pendingAsk = ask) });
    busy = false;
    pendingAsk = null;
    if (closed || res.action !== 'deleted') return;
    finish(res);
  }

  /* ---- Modal ---- */

  const saveBtn = h('button', { type: 'button', class: 'btn btn--primary cal-ed-save', onClick: submit }, icon(isEdit ? 'check' : 'plus', { size: 14 }), isEdit ? 'Save' : 'Create event');
  const footer = [
    isEdit ? h('button', { type: 'button', class: 'btn btn--danger cal-ed-delete', onClick: onDelete }, icon('trash', { size: 14 }), 'Delete') : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'cal-ed-keys label lo-hint', 'aria-hidden': 'true' }, kbd(IS_MAC ? '⌘' : 'Ctrl'), kbd('↵')),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    saveBtn,
  ].filter(Boolean);

  syncWhen();
  syncRepeat();
  const initial = readInput();

  // Tell the user when another window deleted or changed this event while the dialog is open
  const baseJson = isEdit ? JSON.stringify(base) : '';
  const syncNotice = () => {
    const live = getEvent(base.id);
    const changed = live && JSON.stringify(live) !== baseJson;
    notice.hidden = !!live && !changed;
    notice.textContent = live ? 'This event changed in another window. Saving applies only the fields you change here.' : 'This event was deleted in another window. Saving adds it back as a new event.';
  };
  const unsubscribeStore = isEdit ? subscribeCalendar(syncNotice) : () => {};
  const relabelTimes = () => fillEnd(endSel, sMin, eMin);
  roomyTimes?.addEventListener?.('change', relabelTimes);
  const unsubscribe = () => {
    unsubscribeStore();
    roomyTimes?.removeEventListener?.('change', relabelTimes);
  };

  const m = openModal({
    title: isEdit ? 'Edit event' : 'New event',
    body: form,
    footer,
    size: 'lg',
    className: 'cal-editor',
    initialFocus: titleIn,
    onClose: () => {
      closed = true;
      unsubscribe();
      if (active === handle) active = null;
      const res = result ?? CANCELLED;
      onDone?.(res);
    },
  });
  m.el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isComposing(e)) {
      e.preventDefault();
      submit();
    }
  });

  const handle = {
    dismiss() {
      pendingAsk?.close?.();
      m.close();
    },
  };
  active = handle;
  return { close: () => handle.dismiss() };
}
