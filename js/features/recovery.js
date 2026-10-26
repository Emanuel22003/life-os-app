// LIFE/OS — Recovery (09): days clean. A tracker for each thing you stay away from (smoking,
// alcohol, social media …): how many days clean now, a calendar where you mark the days you
// relapsed, the clean runs between relapses, and a few calm numbers (best run, relapses, average
// run, clean days, the next milestone). Pure rules live in recovery.logic.js; store 'recovery'
// (synced, except view: the tracker shown and its calendar's month stay on this device).
//
// Kind by design: a relapse is a day like any other on the calendar, marked once and taken back
// with Undo; the words never judge, and the days clean before it keep counting in every number.

import { h, icon, iconBadge, pageHeader, emptyState, dropdown, dismissTip, toast, openModal, confirmDialog, promptDialog, iconPicker, todayKey, formatDay, onDayChange, isTyping, modalOpen, menuOpen, uid, plural } from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import { ICON_CHOICES, cleanIcon, suggestIcon } from '../icons.logic.js';
import * as R from './recovery.logic.js';

// The leaf (the page's icon) is registered by the shell (js/app.js), the other icons by js/icons.js

/* ==========================================================================
   Store
   ========================================================================== */

const store = createStore('recovery', R.DEFAULT_STATE);
let cacheRaw = null;
let cacheState = null;

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheState = R.normalizeState(raw);
  }
  return cacheState;
}

function commit(next) {
  cacheRaw = next;
  cacheState = next;
  store.set(next);
}

const findTracker = (id) => getState().items.find((t) => t.id === id) ?? null;

function setView(patch) {
  const s = getState();
  if (Object.keys(patch).every((k) => s.view[k] === patch[k])) return;
  commit({ ...s, view: { ...s.view, ...patch } });
}

function setItems(fn, viewPatch = null) {
  const s = getState();
  const items = fn(s.items);
  if (items === s.items && !viewPatch) return;
  commit({ ...s, items, view: viewPatch ? { ...s.view, ...viewPatch } : s.view });
}

/** Put a changed tracker back in its place. */
const putTracker = (t) => setItems((list) => list.map((x) => (x.id === t.id ? t : x)));

/* ==========================================================================
   Words
   ========================================================================== */

const dayCount = R.dayCount;
const longDay = (key) => formatDay(key, 'long');

/** A tracker's days in the picker: '12 days', '0 days' (a relapse today), 'Not yet' (a later start). */
function shortStatus(t, today) {
  const s = R.stats(t, today);
  return s.started ? dayCount(s.current) : 'Not yet';
}

/** A short line under the big number: since when, or what a relapse today means. */
function sinceText(t, s, today) {
  if (!s.started) return `Your first day is ${formatDay(t.start)}.`;
  if (s.relapsedToday) return 'Today is marked as a relapse. Tomorrow is day 1.';
  if (s.currentFrom === today) return s.relapseCount ? 'Day 1 is today: a new run.' : 'Day 1 is today.';
  return `Since ${formatDay(s.currentFrom)}${s.relapseCount ? ', the day after your last relapse' : ''}.`;
}

/* ==========================================================================
   Small builders
   ========================================================================== */

// `tour`: data-tour, what the full tutorial points at (js/tour.logic.js)
const btn = (label, onClick, { iconName, primary = false, ghost = false, small = true, title, aria, fid, className, disabled = false, tour } = {}) =>
  h(
    'button',
    { type: 'button', class: ['btn', small && 'btn--sm', primary && 'btn--primary', ghost && 'btn--ghost', !label && 'btn--icon', className], title: title ?? null, 'aria-label': aria ?? null, dataset: fid || tour ? { ...(fid ? { fid } : {}), ...(tour ? { tour } : {}) } : null, disabled, onClick },
    iconName ? icon(iconName, { size: 14 }) : null,
    label ? h('span', null, label) : null,
  );

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

// The control to give the focus back to after the next render (data-fid), e.g. a calendar day the
// arrow keys moved to in another month
let pendingFocus = null;

function mount(root) {
  root.classList.add('rc-root');
  const cleanups = [];

  const header = pageHeader({
    index: '09',
    title: 'Recovery',
    subtitle: 'Count the days you stay away from something. If you relapse, mark the day on the calendar: the days before it still count.',
    tipId: 'recovery.intro',
    actions: [btn('New tracker', () => openEditor(), { iconName: 'plus', primary: true, small: false, tour: 'recovery-new' })],
  });
  const bodyEl = h('div', { class: 'rc-body' });
  root.append(header, bodyEl);

  // The menus of the last render (closed before the next one replaces their buttons)
  let menus = [];
  let historyOpen = false;

  function render() {
    const s = getState();
    const today = todayKey();
    const focusFid = pendingFocus ?? (root.contains(document.activeElement) ? document.activeElement?.dataset?.fid ?? null : null);
    pendingFocus = null;
    menus.forEach((m) => m.close(false));
    menus = [];
    if (!s.items.length) {
      header.setStat(null);
      bodyEl.replaceChildren(emptyView());
      return;
    }
    const t = R.selectedTracker(s);
    const st = R.stats(t, today);
    header.setStat(R.statusText(t, today));
    const month = R.clampMonth(s.view.month, t, today);
    const more = trackerMenu(t);
    bodyEl.replaceChildren(
      toolbar(s, t),
      h(
        'div',
        { class: 'rc-grid' },
        h('div', { class: 'rc-main' }, heroPanel(t, st, today, more), calendarPanel(t, month, today, focusFid)),
        h('div', { class: 'rc-side' }, statsPanel(t, st), historyPanel(t, st, today)),
      ),
    );
    if (!focusFid) return;
    const back = bodyEl.querySelector(`[data-fid="${CSS.escape(focusFid)}"]`);
    if (back && !back.disabled) back.focus({ preventScroll: true });
    // Gone or at its end (Today in this month, ‹ at the first one; Unarchive done): the calendar's
    // day in reach, else the tracker's card
    else (focusFid.startsWith('cal-') ? bodyEl.querySelector('.rc-day[tabindex="0"]') : bodyEl.querySelector('.rc-hero'))?.focus({ preventScroll: true });
  }

  /* ---- The tracker picker and its menu ---- */

  function toolbar(s, t) {
    const list = R.orderedTrackers(s.items);
    const active = list.filter((x) => !x.archived);
    const archived = list.filter((x) => x.archived);
    const today = todayKey();
    const item = (x) => ({ value: x.id, label: x.name, icon: R.trackerIcon(x), hint: x.archived ? 'Archived' : shortStatus(x, today) });
    const picker = dropdown({
      icon: R.trackerIcon(t),
      items: [
        ...active.map(item),
        ...(archived.length ? [{ separator: true }, ...archived.map(item)] : []),
        { separator: true },
        { action: () => openEditor(), label: 'New tracker…', icon: 'plus' },
      ],
      value: t.id,
      onSelect: (id) => setView({ selectedId: id, month: null }),
      className: 'rc-pick-btn',
      menuLabel: 'Trackers',
      ariaLabel: ({ picked }) => `Tracker: ${picked?.label ?? t.name}. Pick another`,
    });
    picker.button.dataset.fid = 'picker';
    menus.push(picker);
    return h('div', { class: 'rc-bar' }, picker.el, t.archived ? h('span', { class: 'tag tag--dashed' }, 'Archived') : null);
  }

  /** The tracker's own menu (⋯ on its card): Edit, Archive, Delete. */
  function trackerMenu(t) {
    const more = dropdown({
      icon: 'more',
      showValue: false,
      items: [
        { action: () => openEditor(t.id), label: 'Edit…', icon: 'edit' },
        { action: () => toggleArchive(t.id), label: t.archived ? 'Unarchive' : 'Archive', icon: t.archived ? 'undo' : 'archive' },
        { separator: true },
        { action: () => deleteTracker(t.id), label: 'Delete…', icon: 'trash', danger: true },
      ],
      align: 'end',
      className: 'btn--ghost btn--icon rc-more-btn',
      menuLabel: `${t.name}: options`,
      ariaLabel: `${t.name}: edit, archive or delete`,
      title: 'Edit, archive or delete',
    });
    more.button.dataset.fid = 'more';
    menus.push(more);
    return more;
  }

  /* ---- Days clean, now ---- */

  function heroPanel(t, s, today, more) {
    const ms = s.milestone;
    const action = t.archived
      ? btn('Unarchive', () => toggleArchive(t.id), { iconName: 'undo', fid: 'unarchive' })
      : s.relapsedToday
        ? btn('Remove today’s relapse', () => setDay(t.id, today, false), { iconName: 'undo', ghost: true, fid: 'today' })
        : s.started
          ? btn('I relapsed today', () => markToday(t.id), { iconName: 'sunrise', fid: 'today', className: 'rc-relapse-btn', aria: `I relapsed today: mark today as a relapse for ${t.name}` })
          : null;
    return h(
      'section',
      { class: 'panel rc-hero', 'aria-labelledby': 'rc-hero-name', tabindex: '-1' },
      h('div', { class: 'rc-hero-head' }, iconBadge(R.trackerIcon(t), { tone: 'recovery', size: 18, box: 34 }), h('h2', { class: 'rc-hero-name', id: 'rc-hero-name' }, t.name), more.el),
      h(
        'p',
        { class: 'rc-count' },
        h('span', { class: 'stat-value rc-count-num' }, String(s.current)),
        h('span', { class: 'rc-count-unit' }, s.current === 1 ? 'day clean' : 'days clean'),
      ),
      h('p', { class: 'rc-since' }, sinceText(t, s, today)),
      s.started
        ? h(
            'div',
            { class: 'rc-ms' },
            h(
              'p',
              { class: 'rc-ms-text' },
              h('span', null, 'Next milestone: ', h('strong', null, R.milestoneLabel(ms.next))),
              h('span', { class: 'rc-ms-left' }, ms.toGo === 1 ? '1 day to go' : `${ms.toGo} days to go`),
            ),
            h('span', { class: 'progress rc-ms-bar', 'aria-hidden': 'true' }, h('span', { class: 'progress-fill', style: { width: `${Math.round(ms.progress * 100)}%` } })),
          )
        : null,
      action ? h('div', { class: 'rc-hero-actions' }, action) : null,
    );
  }

  /* ---- The calendar: tap a day to mark or remove a relapse ---- */

  function calendarPanel(t, month, today, focusFid) {
    const { first, last } = R.monthRange(t, today);
    const weeks = R.monthWeeks(month);
    const title = R.monthTitle(month);
    const keys = weeks.flat().filter(Boolean);
    // One day takes Tab (a roving focus): the one asked for, else today, the start or the 1st
    const asked = focusFid?.startsWith('day:') ? focusFid.slice(4) : null;
    const tabDay = [asked, today, t.start].find((k) => k && keys.includes(k)) ?? keys[0];
    const grid = h(
      'div',
      { class: 'rc-days', role: 'group', 'aria-label': `${title}. Arrow keys move between days; Enter marks or removes a relapse.`, onKeydown: (e) => onDayKey(e, t, today) },
      weeks.flat().map((key) => (key ? dayButton(t, key, today, key === tabDay) : h('span', { class: 'rc-day is-out', 'aria-hidden': 'true' }))),
    );
    return h(
      'section',
      { class: 'panel rc-cal', 'aria-labelledby': 'rc-cal-title' },
      h(
        'div',
        { class: 'panel-head rc-cal-head' },
        h('h2', { class: 'rc-panel-title rc-cal-title', id: 'rc-cal-title' }, title),
        h(
          'div',
          { class: 'rc-cal-nav' },
          month !== last ? btn('Today', () => setView({ month: R.monthOf(today) }), { ghost: true, fid: 'cal-today', title: 'Back to this month (T)' }) : null,
          // (from the tracker's first month to this one)
          btn('', () => setView({ month: R.shiftMonth(month, -1) }), { iconName: 'chevron-left', ghost: true, aria: 'Previous month', title: 'Previous month', fid: 'cal-prev', className: 'rc-cal-step', disabled: month <= first }),
          btn('', () => setView({ month: R.shiftMonth(month, 1) }), { iconName: 'chevron-right', ghost: true, aria: 'Next month', title: 'Next month', fid: 'cal-next', className: 'rc-cal-step', disabled: month >= last }),
        ),
      ),
      h('div', { class: 'rc-week', 'aria-hidden': 'true' }, R.WEEK_HEADS.map((d) => h('span', { class: 'rc-week-day' }, h('span', { class: 'rc-wd-long' }, d), h('span', { class: 'rc-wd-short' }, d[0])))),
      grid,
      h(
        'p',
        { class: 'rc-legend' },
        h('span', { class: 'rc-key' }, h('span', { class: 'rc-swatch is-relapse', 'aria-hidden': 'true' }), 'Relapse'),
        h('span', { class: 'rc-key' }, h('span', { class: 'rc-swatch is-clean', 'aria-hidden': 'true' }), 'Clean day'),
        h('span', { class: 'rc-key' }, h('span', { class: 'rc-swatch is-today', 'aria-hidden': 'true' }), 'Today'),
      ),
    );
  }

  function dayButton(t, key, today, tabbable) {
    const { kind, relapse } = R.dayState(t, key, today);
    const markable = kind === 'clean' || kind === 'relapse';
    const words = { before: 'before you started', future: relapse ? 'a relapse, still to come' : 'not yet', relapse: 'relapse', clean: 'clean day' }[kind];
    const label = `${longDay(key)}${key === today ? ' (today)' : ''}: ${words}`;
    return h(
      'button',
      {
        type: 'button',
        class: ['rc-day', `is-${kind}`, relapse && 'has-mark', key === today && 'is-today'],
        tabindex: tabbable ? '0' : '-1',
        dataset: { day: key, fid: `day:${key}` },
        'aria-pressed': markable ? String(kind === 'relapse') : null,
        'aria-disabled': markable ? null : 'true',
        'aria-label': label,
        title: markable ? `${label}. ${kind === 'relapse' ? 'Click to remove the relapse' : 'Click to mark a relapse'}` : label,
        onClick: () => markable && setDay(t.id, key, kind !== 'relapse'),
      },
      h('span', { class: 'rc-day-num' }, String(Number(key.slice(8)))),
    );
  }

  /** Arrow keys between days (into the next or previous month too), Home / End, Page Up / Down. */
  function onDayKey(e, t, today) {
    const el = e.target.closest?.('.rc-day[data-day]');
    if (!el || e.metaKey || e.ctrlKey || e.altKey) return;
    const day = el.dataset.day;
    const wd = (new Date(`${day}T12:00`).getDay() + 6) % 7;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -wd, End: 6 - wd }[e.key];
    let to = null;
    if (step !== undefined) to = shiftDay(day, step);
    else if (e.key === 'PageUp' || e.key === 'PageDown') to = sameDayIn(day, e.key === 'PageUp' ? -1 : 1);
    if (!to) return;
    e.preventDefault();
    const { first, last } = R.monthRange(t, today);
    const m = R.monthOf(to);
    if (m < first || m > last) return;
    const target = bodyEl.querySelector(`.rc-day[data-day="${to}"]`);
    if (target) {
      bodyEl.querySelectorAll('.rc-day[tabindex="0"]').forEach((b) => (b.tabIndex = -1));
      target.tabIndex = 0;
      target.focus();
      return;
    }
    // Another month: show it, then the same day there takes the focus
    pendingFocus = `day:${to}`;
    setView({ month: m });
  }

  /* ---- The numbers ---- */

  function statsPanel(t, s) {
    const tile = (label, value, sub = null) => h('div', { class: 'rc-stat' }, h('dt', { class: 'rc-stat-label' }, label), h('dd', { class: 'rc-stat-value stat-value' }, value), sub ? h('dd', { class: 'rc-stat-sub' }, sub) : null);
    return h(
      'section',
      { class: 'panel rc-stats', 'aria-labelledby': 'rc-stats-title' },
      h('div', { class: 'panel-head rc-panel-head' }, h('h2', { class: 'rc-panel-title', id: 'rc-stats-title' }, 'Your numbers')),
      h(
        'dl',
        { class: 'rc-stat-list' },
        tile('Best run', s.best ? dayCount(s.best) : '—', s.best && s.best === s.current && s.relapseCount ? 'That’s the run you’re on' : null),
        tile('Relapses', String(s.relapseCount), s.relapseCount ? `${s.relapses30} in the last 30 days` : 'None so far'),
        tile('Average run', R.averageText(s.average), s.runs.length > 1 ? `over ${s.runs.length} runs` : null),
        tile('Clean days', R.percentText(s.cleanRatio), s.started ? `${s.cleanDays} of ${dayCount(s.totalDays)} since ${formatDay(t.start)}` : null),
      ),
    );
  }

  /* ---- Between relapses: the runs, as a chart and a list ---- */

  function historyPanel(t, s, today) {
    const runs = s.runs;
    const newest = [...runs].reverse();
    const LIMIT = 8;
    const shown = historyOpen ? newest : newest.slice(0, LIMIT);
    let intro = null;
    if (!runs.length) intro = s.started ? 'Your first run starts tomorrow.' : `Your first run starts ${formatDay(t.start)}.`;
    else if (!s.relapseCount) intro = `No relapses. One run so far: ${dayCount(s.current)} and going on.`;
    return h(
      'section',
      { class: 'panel rc-history', 'aria-labelledby': 'rc-history-title' },
      h('div', { class: 'panel-head rc-panel-head' }, h('h2', { class: 'rc-panel-title', id: 'rc-history-title' }, 'Between relapses'), runs.length > 1 ? h('span', { class: 'rc-due' }, plural(runs.length, 'run')) : null),
      intro ? h('p', { class: 'rc-none' }, intro) : null,
      runs.length > 1 ? runChart(R.chartRuns(runs), today) : null,
      runs.length > 1
        ? h(
            'ol',
            { class: 'rc-runs', 'aria-label': 'Clean runs, newest first' },
            shown.map((r) =>
              h(
                'li',
                { class: ['rc-run', r.ongoing && 'is-ongoing', r.days === s.best && 'is-best'] },
                h('span', { class: 'rc-run-days' }, dayCount(r.days)),
                h('span', { class: 'rc-run-range' }, R.runRange(r, today)),
                r.ongoing ? h('span', { class: 'tag rc-run-tag' }, 'Going on') : r.days === s.best ? h('span', { class: 'tag tag--dashed rc-run-tag' }, 'Best') : null,
              ),
            ),
          )
        : null,
      newest.length > LIMIT
        ? h(
            'button',
            {
              type: 'button',
              class: 'rc-more-runs',
              dataset: { fid: 'more-runs' },
              'aria-expanded': String(historyOpen),
              onClick: () => {
                historyOpen = !historyOpen;
                pendingFocus = 'more-runs';
                render();
              },
            },
            icon('chevron-down', { size: 14, className: 'rc-caret' }),
            historyOpen ? 'Show fewer' : `Show all ${newest.length} runs`,
          )
        : null,
    );
  }

  /* ---- Nothing yet ---- */

  // The shared empty state, with quick starters that fill in a name (New tracker is the header's)
  function emptyView() {
    const el = emptyState({
      icon: 'leaf',
      title: 'Nothing tracked yet',
      text: 'Pick something you want to stay away from. LIFE/OS counts your days clean, and if you relapse you mark the day, so you can see how long you did well in between.',
      action: h(
        'div',
        { class: 'rc-starters', role: 'group', 'aria-label': 'Quick start' },
        R.STARTERS.map((name) => h('button', { type: 'button', class: 'btn btn--sm', onClick: () => openEditor(null, { name }) }, icon(suggestIcon(name, R.TRACKER_ICON), { size: 13 }), name)),
      ),
    });
    el.classList.add('rc-empty');
    return el;
  }

  /* ---- Right-click: a day's relapse; the tracker's Edit, Rename, Archive and Delete ---- */

  cleanups.push(
    registerContextProvider('recovery', (el) => {
      if (!root.contains(el)) return null;
      const t = R.selectedTracker(getState());
      if (!t) return null;
      const today = todayKey();
      const dayEl = el.closest('.rc-day[data-day]');
      if (dayEl) {
        const day = dayEl.dataset.day;
        const on = t.relapses.includes(day);
        return {
          kind: 'recovery-day',
          id: day,
          label: longDay(day),
          el: dayEl,
          actions: [{ id: 'relapse', label: on ? 'Remove relapse' : 'Mark as a relapse', icon: on ? 'undo' : 'sunrise', disabled: !R.canMark(t, day, today), run: () => setDay(t.id, day, !on) }],
          // Delete (and the Delete key) on a marked day takes the relapse away, with Undo
          remove: on && R.canMark(t, day, today) ? () => setDay(t.id, day, false) : undefined,
        };
      }
      const s = R.stats(t, today);
      return {
        kind: 'tracker',
        id: t.id,
        label: `Tracker: ${t.name}`,
        el: root.querySelector('.rc-hero'),
        actions: [
          s.relapsedToday
            ? { id: 'unmark', label: 'Remove today’s relapse', icon: 'undo', run: () => setDay(t.id, today, false) }
            : { id: 'mark', label: 'I relapsed today', icon: 'sunrise', disabled: !s.started, run: () => markToday(t.id) },
          { id: 'archive', label: t.archived ? 'Unarchive' : 'Archive', icon: t.archived ? 'undo' : 'archive', run: () => toggleArchive(t.id) },
        ],
        edit: () => openEditor(t.id),
        rename: () => renameTracker(t.id),
        remove: () => deleteTracker(t.id),
      };
    }),
  );

  // N: a new tracker (like N for a new task); T: the calendar back to this month
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || menuOpen() || e.defaultPrevented) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openEditor();
    } else if ((e.key === 't' || e.key === 'T') && getState().items.length) {
      e.preventDefault();
      const today = todayKey();
      pendingFocus = `day:${today}`;
      if (getState().view.month === R.monthOf(today) || !getState().view.month) render();
      else setView({ month: R.monthOf(today) });
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  render();
  cleanups.push(store.subscribe(render));
  cleanups.push(onDayChange(render));
  cleanups.push(() => menus.forEach((m) => m.close(false)));
  return () => cleanups.forEach((off) => off());
}

/* ==========================================================================
   The chart: one bar per run, oldest left; the run going on is the bright one
   ========================================================================== */

function runChart(runs, today) {
  const H = 150;
  const pad = { l: 30, r: 8, t: 18, b: 24 };
  const axis = R.axisTicks(Math.max(...runs.map((r) => r.days)));
  const svg = sv('svg', { class: 'rc-svg', 'aria-hidden': 'true', focusable: 'false' });
  const tip = h('div', { class: 'rc-tip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const words = (r) => `${R.runRange(r, today)}: ${dayCount(r.days)}${r.ongoing ? ', going on' : ''}`;
  const summary = `Clean runs between relapses, oldest first: ${runs.map((r) => `${r.days}${r.ongoing ? ' (going on)' : ''}`).join(', ')} days.`;
  const el = h('div', { class: 'rc-plot', tabindex: '0', role: 'group', 'aria-label': `${summary} Left and right arrow keys read each run.` }, svg, tip, live);
  let W = 0;
  let bars = [];
  let slot = 0;
  let active = null;

  function draw(width) {
    W = Math.max(220, Math.round(width));
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    slot = pw / runs.length;
    const bw = Math.max(3, Math.min(28, slot * 0.62));
    const yAt = (v) => pad.t + ph - (v / axis.top) * ph;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.replaceChildren();
    const grid = sv('g', { class: 'rc-grid-lines' });
    for (const v of axis.ticks) {
      const y = Math.round(yAt(v)) + 0.5;
      grid.append(sv('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }), sv('text', { class: 'rc-axis', x: pad.l - 6, y: y + 3.5, 'text-anchor': 'end' }, String(v)));
    }
    svg.append(grid);
    bars = runs.map((r, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      const y = yAt(r.days);
      const bar = sv('rect', { class: ['rc-bar', r.ongoing && 'is-ongoing'].filter(Boolean).join(' '), x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: Math.max(1, pad.t + ph - y).toFixed(1), rx: Math.min(3, bw / 4).toFixed(1) });
      svg.append(bar);
      // The number over each bar while there is room for it
      if (slot >= 22) svg.append(sv('text', { class: ['rc-bar-val', r.ongoing && 'is-ongoing'].filter(Boolean).join(' '), x: (x + bw / 2).toFixed(1), y: (y - 5).toFixed(1), 'text-anchor': 'middle' }, String(r.days)));
      return bar;
    });
    // When the first and the last run began
    const firstX = pad.l + slot / 2;
    const lastX = pad.l + slot * (runs.length - 1) + slot / 2;
    svg.append(sv('text', { class: 'rc-axis', x: Math.max(pad.l, firstX - 10), y: H - 6, 'text-anchor': 'start' }, formatDay(runs[0].from)));
    if (lastX - firstX > 110) svg.append(sv('text', { class: 'rc-axis', x: Math.min(W - pad.r, lastX + 10), y: H - 6, 'text-anchor': 'end' }, runs.at(-1).ongoing ? 'Now' : formatDay(runs.at(-1).from)));
    if (active != null) show(active);
  }

  const show = (i) => {
    active = Math.max(0, Math.min(runs.length - 1, i));
    bars.forEach((b, j) => b.classList.toggle('is-active', j === active));
    const r = runs[active];
    tip.replaceChildren(h('div', { class: 'rc-tip-main' }, dayCount(r.days)), h('div', { class: 'rc-tip-sub' }, R.runRange(r, today)), r.ongoing ? h('div', { class: 'rc-tip-sub' }, 'Going on') : null);
    tip.classList.add('is-on');
    const cx = pad.l + slot * active + slot / 2;
    const left = cx + 12 + tip.offsetWidth > el.clientWidth ? cx - 12 - tip.offsetWidth : cx + 12;
    tip.style.transform = `translate(${Math.round(Math.max(0, left))}px, 0)`;
    live.textContent = words(r);
  };
  const hide = () => {
    active = null;
    bars.forEach((b) => b.classList.remove('is-active'));
    tip.classList.remove('is-on');
  };
  el.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((x - pad.l) / slot);
    if (i >= 0 && i < runs.length && i !== active) show(i);
  });
  el.addEventListener('pointerleave', hide);
  el.addEventListener('blur', hide);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(active == null ? runs.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : runs.length - 1);
    } else if (e.key === 'Escape' && active != null) {
      e.stopPropagation();
      hide();
    }
  });

  draw(320);
  // Drawn at the plot's real width (again when it changes), so labels keep their true size
  const ro = new ResizeObserver(([entry]) => {
    if (!el.isConnected) return ro.disconnect();
    const width = entry.contentRect.width;
    if (width && Math.abs(Math.max(220, Math.round(width)) - W) > 1) draw(width);
  });
  ro.observe(el);
  return h('figure', { class: 'rc-figure' }, el);
}

/* ==========================================================================
   Edits
   ========================================================================== */

function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d + n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The same day of the month a month earlier or later (the last day of a shorter month). */
function sameDayIn(key, months) {
  const target = R.shiftMonth(R.monthOf(key), months);
  const [y, m] = target.split('-').map(Number);
  const day = Math.min(Number(key.slice(8)), new Date(y, m, 0).getDate());
  return `${target}-${String(day).padStart(2, '0')}`;
}

/** Mark (on) or remove (off) a relapse on `day`, at once, with Undo in the toast. */
function setDay(id, day, on) {
  const cur = findTracker(id);
  if (!cur) return;
  const today = todayKey();
  const before = R.stats(cur, today);
  const res = R.setRelapse(cur, day, on, today);
  if (res.error) {
    toast(res.error);
    return;
  }
  if (!res.changed) return;
  putTracker(res.tracker);
  dismissTip('recovery.intro');
  const when = day === today ? 'Today' : formatDay(day);
  let message;
  if (!on) message = `Relapse removed: ${day === today ? 'today' : formatDay(day)} is a clean day again.`;
  else if (day === today) {
    // The run counted today too: the clean days before it are one fewer
    const kept = Math.max(0, before.current - 1);
    message = kept > 1 ? `Today is marked as a relapse. The ${kept} clean days before it still count.` : kept === 1 ? 'Today is marked as a relapse. The clean day before it still counts.' : 'Today is marked as a relapse.';
  }
  else message = `${when} is marked as a relapse.`;
  toast(message, {
    key: 'rc-day',
    action: {
      label: 'Undo',
      onClick: () => {
        const now = findTracker(id);
        if (!now) return;
        const back = R.setRelapse(now, day, !on, todayKey());
        if (!back.error && back.changed) putTracker(back.tracker);
      },
    },
  });
}

const markToday = (id) => setDay(id, todayKey(), true);

function toggleArchive(id) {
  const cur = findTracker(id);
  if (!cur) return;
  putTracker({ ...cur, archived: !cur.archived });
  toast(cur.archived ? `“${cur.name}” is back with your trackers.` : `“${cur.name}” archived. Its history stays; find it under Archived in the list.`, {
    action: {
      label: 'Undo',
      onClick: () => {
        const now = findTracker(id);
        if (now) putTracker({ ...now, archived: cur.archived });
      },
    },
  });
}

async function renameTracker(id) {
  const cur = findTracker(id);
  if (!cur) return;
  const name = await promptDialog({ title: 'Rename tracker', value: cur.name, maxLength: R.NAME_MAX });
  const now = findTracker(id);
  if (name === null || !now || name === now.name) return;
  const res = R.updateTracker(now, { name }, { today: todayKey() });
  if (!res.error) putTracker(res.tracker);
}

/**
 * Delete a tracker. One with a history (any day before today, or a relapse) asks first: what goes
 * can't come back from anywhere else. Undo in the toast either way, like every delete.
 */
async function deleteTracker(id) {
  const cur = findTracker(id);
  if (!cur) return false;
  const today = todayKey();
  const s = R.stats(cur, today);
  if (cur.relapses.length || s.totalDays > 1) {
    const what = [s.totalDays ? dayCount(s.totalDays) : null, cur.relapses.length ? plural(cur.relapses.length, 'relapse') : null].filter(Boolean).join(' and ');
    const confirmed = await confirmDialog({
      title: 'Delete forever?',
      message: `“${cur.name}” and its history (${what || 'its days'}) will be erased.${cur.archived ? '' : ' Archive it instead to keep the history out of the way.'}`,
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!confirmed) return false;
  }
  const list = getState().items;
  const at = list.findIndex((t) => t.id === id);
  if (at < 0) return false;
  const gone = list[at];
  setItems((items) => items.filter((t) => t.id !== id));
  toast(`“${gone.name}” deleted.`, {
    action: {
      label: 'Undo',
      onClick: () =>
        setItems((items) => {
          if (items.some((t) => t.id === gone.id)) return items;
          const next = items.slice();
          next.splice(Math.min(at, next.length), 0, gone);
          return next;
        }),
    },
  });
  return true;
}

/* ==========================================================================
   The dialog: a new tracker, or one changed (name, start day, icon)
   ========================================================================== */

let editorSeq = 0;

function openEditor(id = null, preset = {}) {
  const existing = id ? findTracker(id) : null;
  const today = todayKey();
  const n = `rc-ed-${++editorSeq}`;
  const err = h('p', { class: 'rc-ed-error', role: 'alert', hidden: true });
  const nameIn = h('input', { id: `${n}-name`, class: 'input rc-ed-name', type: 'text', value: existing?.name ?? preset.name ?? '', maxlength: String(R.NAME_MAX), placeholder: 'Smoking, alcohol, social media…', autocomplete: 'off', enterkeyhint: 'done' });
  // A start saved by a device ahead in time may stay as it is
  const startIn = h('input', { id: `${n}-start`, class: 'input rc-ed-start', type: 'date', value: existing?.start ?? today, max: existing && existing.start > today ? existing.start : today });
  const startNote = h('p', { class: 'rc-ed-hint', 'aria-live': 'polite' });

  /* ---- Icon: a button beside the name shows it and opens the grid (as in the habit dialog) ---- */
  // null = Auto: the icon follows the name. An icon this copy doesn't know stays until one is picked.
  let pickedIcon = cleanIcon(existing?.icon) ?? null;
  let iconTouched = false;
  const autoIcon = () => suggestIcon(nameIn.value, R.TRACKER_ICON);
  const preview = iconBadge(pickedIcon ?? autoIcon(), { tone: 'recovery', size: 20, className: 'rc-ed-ib' });
  const iconsId = `${n}-icons`;
  const iconBtn = h(
    'button',
    { type: 'button', class: 'rc-ed-iconbtn', 'aria-expanded': 'false', 'aria-controls': iconsId, onClick: () => showIcons(iconWrap.hidden) },
    preview,
    h('span', { class: 'rc-ed-iconbtn-chev', 'aria-hidden': 'true' }, icon('chevron-down', { size: 12, stroke: 2 })),
  );
  const grid = iconPicker({
    choices: ICON_CHOICES,
    value: pickedIcon,
    auto: autoIcon(),
    labelledBy: `${n}-icons-label`,
    onChange: (name) => {
      pickedIcon = name;
      iconTouched = true;
      paintIcon();
    },
  });
  const iconWrap = h('div', { class: 'rc-ed-icons', id: iconsId, hidden: true }, h('span', { class: 'label', id: `${n}-icons-label` }, 'Icon'), grid.el);
  grid.el.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.ip-btn')) return;
    showIcons(false);
    iconBtn.focus({ preventScroll: true });
  });
  function paintIcon() {
    const name = pickedIcon ?? autoIcon();
    preview.replaceChildren(icon(name, { size: 20 }));
    const label = ICON_CHOICES.find((c) => c.name === name)?.label ?? 'Leaf';
    iconBtn.setAttribute('aria-label', `Icon: ${label}${pickedIcon ? '' : ' (follows the name)'}. Change icon`);
    iconBtn.title = `Icon: ${label} — change`;
  }
  function showIcons(open) {
    iconWrap.hidden = !open;
    iconBtn.setAttribute('aria-expanded', String(open));
    if (open) iconWrap.scrollIntoView?.({ block: 'nearest' });
  }
  nameIn.addEventListener('input', () => {
    grid.setAuto(autoIcon());
    paintIcon();
    nameIn.removeAttribute('aria-invalid');
    err.hidden = true;
  });
  paintIcon();

  // Moving the start later takes the relapses before it with it: say so before saving
  function paintStartNote() {
    const start = startIn.value;
    const lost = existing && R.isKey(start) ? existing.relapses.filter((d) => d < start).length : 0;
    startNote.textContent = lost ? `${plural(lost, 'relapse')} before this day will be removed.` : existing ? 'Days before it don’t count.' : 'The first day you stayed away. It counts as day 1.';
  }
  startIn.addEventListener('input', paintStartNote);
  paintStartNote();

  function fail(message, field) {
    err.textContent = message;
    err.hidden = false;
    const el = field === 'start' ? startIn : nameIn;
    el.setAttribute('aria-invalid', 'true');
    el.focus();
  }

  function save() {
    [nameIn, startIn].forEach((el) => el.removeAttribute('aria-invalid'));
    const now = todayKey();
    const fields = { name: nameIn.value, start: startIn.value };
    if (existing) {
      const cur = findTracker(existing.id);
      if (!cur) {
        m.close();
        toast('That tracker no longer exists.');
        return;
      }
      const res = R.updateTracker(cur, { ...fields, ...(iconTouched ? { icon: pickedIcon } : {}) }, { today: now });
      if (res.error) return fail(res.error, res.field);
      putTracker(res.tracker);
      m.close();
      toast(res.dropped ? `“${res.tracker.name}” saved. ${plural(res.dropped, 'relapse')} before the new start ${res.dropped === 1 ? 'was' : 'were'} removed.` : `“${res.tracker.name}” saved.`, {
        action: res.dropped ? { label: 'Undo', onClick: () => findTracker(cur.id) && putTracker(cur) } : undefined,
      });
      return;
    }
    const res = R.createTracker({ ...fields, icon: pickedIcon }, { today: now, makeId: uid });
    if (res.error) return fail(res.error, res.field);
    setItems((list) => [...list, res.tracker], { selectedId: res.tracker.id, month: null });
    // The page's explanation has done its job once something is tracked
    dismissTip('recovery.intro');
    m.close();
    toast(`“${res.tracker.name}” added: ${R.statusText(res.tracker, now).toLowerCase()}.`);
  }

  const body = h(
    'div',
    {
      class: 'rc-ed',
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          save();
        }
      },
    },
    h('div', { class: 'field' }, h('label', { class: 'label', for: nameIn.id }, 'What are you staying away from?'), h('div', { class: 'rc-ed-namerow' }, iconBtn, nameIn), iconWrap),
    h('div', { class: 'field' }, h('label', { class: 'label', for: startIn.id }, 'Day you started'), startIn, startNote),
    err,
  );

  const footer = [
    existing
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onClick: () => {
              m.close();
              toggleArchive(existing.id);
            },
          },
          icon(existing.archived ? 'undo' : 'archive', { size: 14 }),
          existing.archived ? 'Unarchive' : 'Archive',
        )
      : null,
    existing
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn--danger',
            onClick: () => {
              m.close();
              deleteTracker(existing.id);
            },
          },
          icon('trash', { size: 14 }),
          'Delete…',
        )
      : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon(existing ? 'check' : 'plus', { size: 14 }), existing ? 'Save' : 'Start counting'),
  ];

  const m = openModal({ title: existing ? `Edit “${existing.name}”` : 'New tracker', body, footer, className: 'rc-modal', initialFocus: nameIn });
  return m;
}

/* ==========================================================================
   Feature
   ========================================================================== */

/** For Search and Home: the trackers, their changes, and ways in. Reads are the stored items. */
export const recoveryApi = Object.freeze({
  trackers: () => getState().items,
  subscribe: (fn) => store.subscribe(fn),
  add: () => openEditor(),
  /** Show this tracker on the Recovery page (this device's choice); false when there is none. */
  select: (id) => {
    if (!findTracker(id)) return false;
    setView({ selectedId: id, month: null });
    return true;
  },
  /** Search: the tracker shown, its card in view and in focus. False when there is no such tracker. */
  reveal: (id) => {
    if (!recoveryApi.select(id)) return false;
    const hero = document.querySelector('#main > .view[data-feature="recovery"] .rc-hero');
    if (!hero) return false;
    hero.scrollIntoView({ block: 'nearest' });
    hero.focus({ preventScroll: true });
    return true;
  },
});

export default {
  id: 'recovery',
  title: 'Recovery',
  icon: 'leaf',
  mount,
};
