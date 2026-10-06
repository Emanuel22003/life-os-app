// LIFE/OS — 03 // Habits: WEEK PLAN tab and the shared add / edit dialog.
//
// The plan is a matrix: rows are active habits, columns Monday … Sunday. Every
// toggle re-plans that habit FROM TODAY; habits.logic.js keeps each past day on
// the plan it really had, so history and graphs never shift. This file never
// touches the store: it reads through `source` and writes through `actions`
// (both supplied by habits.js).

import { h, icon, openModal, confirmDialog, toast, onDayChange, formatDay, clamp, idx, term, plural, WEEKDAYS_SHORT } from '../ui.js';
import * as L from './habits.logic.js';

export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

/* ==========================================================================
   Shared helpers (habits.js uses these too)
   ========================================================================== */

/** Re-trigger a one-shot CSS animation class. */
export function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Message text quoting a user-typed name: wraps anywhere, so an unbroken name can't overflow a toast or dialog. */
export function prose(text) {
  return h('span', { class: 'hb-wrap' }, text);
}

/** 'Monday' | 'Monday and Friday' | 'Monday, Tuesday and Friday' — always Monday-first. */
export function dayNames(days) {
  const names = L.WEEK_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAYS_LONG[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
}

export const perWeek = (days) => `${days.length}× / week`;

const sameIds = (a, b) => a.length === b.length && a.every((hb, i) => hb.id === b[i].id);

function iconBtn(name, onClick) {
  return h('button', { type: 'button', class: 'btn btn--ghost btn--icon btn--sm hb-act', onClick }, icon(name, { size: 14 }));
}

/**
 * Monday-first weekday toggles (aria-pressed buttons).
 * sub(d) adds a second line (e.g. a count); describe(d) overrides the accessible name.
 * -> { el, get(), set(days) }   onChange(days) fires after every user toggle.
 */
function weekdayPicker({ days = [], labelledBy, locked = [], sub, describe, onChange } = {}) {
  let value = L.normalizeDays(days);
  const buttons = L.WEEK_ORDER.map((d) =>
    h(
      'button',
      {
        type: 'button',
        class: 'hb-wd',
        'aria-pressed': 'false',
        'aria-label': describe ? describe(d) : WEEKDAYS_LONG[d],
        title: WEEKDAYS_LONG[d],
        disabled: locked.includes(d),
        dataset: { d: String(d) },
        onClick: () => {
          value = value.includes(d) ? value.filter((x) => x !== d) : L.normalizeDays([...value, d]);
          paint();
          onChange?.(value);
        },
      },
      h('span', { class: 'hb-wd-name' }, WEEKDAYS_SHORT[d]),
      sub ? h('span', { class: 'hb-wd-sub mono tnum' }, sub(d)) : null,
    ),
  );
  const paint = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(value.includes(Number(b.dataset.d)))));
  paint();
  return {
    el: h('div', { class: 'hb-f-days', role: 'group', 'aria-labelledby': labelledBy }, buttons),
    get: () => value,
    set(next) {
      value = L.normalizeDays(next);
      paint();
    },
  };
}

/* ==========================================================================
   Add / edit dialog
   ========================================================================== */

/**
 * openHabitModal({ habit, weekday, draft, actions, onClose }) -> { el, close }
 * - New habit: `weekday` preselects only that day (else every day).
 * - Edit: days start from the plan in effect today; saving re-plans from today
 *   through actions.edit (logic editHabit -> setPlanDays), so history is unchanged.
 * - Footer: Archive / Restore (history stays in every graph) vs Delete forever.
 */
export function openHabitModal({ habit = null, weekday = null, draft = null, actions, onClose } = {}) {
  const today = actions.today();
  const isEdit = !!habit;
  const archived = isEdit && L.isArchived(habit, today);
  const n = nextId('hb-f');
  const ids = { name: `${n}-name`, err: `${n}-err`, days: `${n}-days`, start: `${n}-start` };
  const initialDays = draft?.days ?? (isEdit ? L.planOn(habit, today) : Number.isInteger(weekday) ? [weekday] : L.ALL_DAYS);
  // The dialog stays clickable while it fades out (~140ms): without this a
  // double-click on Create would add the habit twice, or stack two prompts.
  let closed = false;

  const errEl = h('p', { id: ids.err, class: 'hb-f-error', hidden: true }, icon('x', { size: 12 }), h('span', null, term('habits.nameRequired', 'Name required — give the protocol a designation.')));
  const nameInput = h('input', {
    id: ids.name,
    class: 'input hb-f-name',
    type: 'text',
    value: draft?.name ?? habit?.name ?? '',
    maxlength: L.NAME_MAX,
    placeholder: 'e.g. Read 20 minutes',
    autocomplete: 'off',
    enterkeyhint: 'done',
    required: true,
    'aria-describedby': ids.err,
    onInput: () => {
      if (!errEl.hidden && L.cleanName(nameInput.value)) clearError();
    },
  });

  const picker = weekdayPicker({ days: initialDays, labelledBy: ids.days, onChange: syncDays });
  const presetBtns = L.PRESETS.map((p) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': 'false',
        onClick: () => {
          picker.set(p.days);
          syncDays();
        },
      },
      p.label,
    ),
  );
  const daysHint = h('p', { class: 'hb-f-hint label', 'aria-live': 'polite' });

  // A habit that starts in the future (imported data) may keep its date.
  const maxStart = isEdit && habit.createdAt > today ? null : today;
  const startInput = h('input', {
    id: ids.start,
    class: 'input hb-f-date',
    type: 'date',
    value: draft?.createdAt || (isEdit ? habit.createdAt : today),
    max: maxStart,
  });

  function syncDays() {
    const days = picker.get();
    const preset = L.presetOf(days);
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(L.PRESETS[i] === preset)));
    daysHint.classList.remove('is-warn');
    if (days.length) daysHint.textContent = `${perWeek(days)} · ${L.scheduleLabel(days)}`;
    else daysHint.textContent = isEdit ? 'No days — it keeps its history but appears on no day' : 'Pick at least one day';
  }

  function showError() {
    errEl.hidden = false;
    nameInput.setAttribute('aria-invalid', 'true');
    replay(nameInput, 'is-shake');
    nameInput.focus();
  }

  function clearError() {
    errEl.hidden = true;
    nameInput.removeAttribute('aria-invalid');
  }

  function submit() {
    if (closed) return;
    const name = L.cleanName(nameInput.value);
    if (!name) {
      showError();
      return;
    }
    const days = picker.get();
    if (!isEdit && !days.length) {
      daysHint.textContent = 'Pick at least one day';
      replay(daysHint, 'is-warn');
      return;
    }
    const now = actions.today();
    const raw = startInput.value;
    const fallback = isEdit ? habit.createdAt : now;
    const createdAt = L.isValidKey(raw) && (maxStart === null || raw <= now) ? raw : fallback;
    m.close();
    if (!isEdit) {
      actions.create({ name, days, createdAt });
    } else if (!actions.find(habit.id)) {
      toast('That habit no longer exists.');
    } else {
      actions.edit(habit.id, { name, days, createdAt });
    }
  }

  function toggleArchive() {
    if (closed) return;
    m.close();
    if (archived) actions.unarchive(habit.id);
    else actions.archive(habit.id);
  }

  async function remove() {
    if (closed) return;
    const keep = { name: nameInput.value, days: picker.get(), createdAt: startInput.value };
    m.close();
    const removed = await actions.remove(habit.id);
    // Cancelled: bring the dialog back with whatever the user had typed.
    if (removed === false && actions.isMounted() && actions.find(habit.id)) actions.openEditor(habit.id, { draft: keep });
  }

  const form = h(
    'form',
    {
      class: 'hb-form',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          submit();
        }
      },
    },
    h('div', { class: 'field' }, h('label', { class: 'label', for: ids.name }, 'Designation'), nameInput, errEl),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'label', id: ids.days }, 'Planned on'),
      h('div', { class: 'seg hb-f-presets', role: 'group', 'aria-label': 'Day presets' }, presetBtns),
      picker.el,
      daysHint,
      isEdit ? h('p', { class: 'hb-f-note' }, icon('clock', { size: 12 }), 'Applies from today — history unchanged.') : null,
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: ids.start }, 'Start date'),
      startInput,
      h('p', { class: 'hb-f-note' }, 'Days before the start date never count against a streak.'),
    ),
    isEdit
      ? h(
          'p',
          { class: 'hb-f-note hb-f-life' },
          archived ? 'Archived habits keep their history in every graph. Restore brings it back from today.' : 'Archive retires the habit but keeps its history in every graph. Delete forever erases it.',
        )
      : null,
  );

  syncDays();

  const title = isEdit ? 'Edit habit' : Number.isInteger(weekday) ? `New habit · ${WEEKDAYS_LONG[weekday]}` : 'New habit';
  const m = openModal({
    title,
    body: form,
    footer: [
      isEdit
        ? h('button', { type: 'button', class: 'btn btn--ghost hb-f-archive', onClick: toggleArchive }, icon(archived ? 'undo' : 'archive'), archived ? 'Restore' : 'Archive')
        : null,
      isEdit ? h('button', { type: 'button', class: 'btn btn--danger', onClick: remove }, icon('trash'), 'Delete forever') : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn--primary', onClick: submit }, icon(isEdit ? 'check' : 'plus'), isEdit ? 'Save' : 'Create habit'),
    ],
    initialFocus: nameInput,
    onClose: () => {
      closed = true;
      onClose?.();
    },
  });
  m.el.classList.add('hb-modal');
  return m;
}

/* ==========================================================================
   Week plan matrix
   ========================================================================== */

/**
 * mountPlan(container, source, actions) -> cleanup
 * actions: { today, find, isMounted, openEditor(id|null, { weekday }), create, toggleDay,
 *            copyDay, clearDay, archive, unarchive, remove, move(id, delta, visibleIds) }
 */
export function mountPlan(container, source, actions) {
  let mounted = true;
  let dayModal = null;
  let order = []; // ids of the active rows, top to bottom
  let cursor = { id: null, col: null }; // roving tab stop inside the matrix
  let lastArchived = [];
  let lastToday = null;
  let liveCount = -1; // active rows at the last render (-1 before the first)
  let archOpen = false;
  let addDays = [...L.ALL_DAYS];
  const rows = new Map();
  const archRows = new Map();
  const n = nextId('hb-plan');

  /* ---- Head ---- */

  const summaryEl = h('span', { class: 'label tnum hb-plan-summary' });
  const head = h(
    'div',
    { class: 'hb-plan-head' },
    h('h2', { class: 'label hb-plan-title' }, 'Week plan'),
    summaryEl,
    h('span', { class: 'hb-rule', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'hb-legend', 'aria-hidden': 'true' },
      h('span', { class: 'hb-legend-item label' }, h('span', { class: 'hb-swatch', dataset: { s: 'done' } }), 'Planned'),
      h('span', { class: 'hb-legend-item label' }, h('span', { class: 'hb-swatch' }), 'Off'),
    ),
  );

  /* ---- Column heads: weekday, habit count + unit, mini bar; click = copy / clear ---- */

  const cols = L.WEEK_ORDER.map((wd) => {
    const count = h('span', { class: 'hb-plan-count mono tnum' });
    const unit = h('span', { class: 'hb-plan-unit-l' });
    const fill = h('span', { class: 'hb-plan-bar-fill' });
    const btn = h(
      'button',
      { type: 'button', class: 'hb-plan-colbtn', 'aria-haspopup': 'dialog', onClick: () => openDayModal(wd) },
      h('span', { class: 'hb-plan-wd' }, WEEKDAYS_SHORT[wd]),
      h('span', { class: 'hb-plan-load' }, count, h('span', { class: 'hb-plan-unit' }, unit, h('span', { class: 'hb-plan-unit-s' }, 'hb'))),
      h('span', { class: 'hb-plan-bar', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'hb-plan-more', 'aria-hidden': 'true' }, icon('more', { size: 14 })),
    );
    return { wd, btn, count, unit, fill, th: h('th', { scope: 'col', class: 'hb-plan-th' }, btn) };
  });

  /* ---- Add row: name in the sticky column, draft toggles under each weekday ---- */

  const hintId = `${n}-hint`;
  const addHint = h('span', { id: hintId, class: 'label hb-plan-addhint', 'aria-live': 'polite' });
  const addInput = h('input', {
    class: 'input hb-plan-input',
    type: 'text',
    placeholder: 'New habit…',
    maxlength: L.NAME_MAX,
    autocomplete: 'off',
    enterkeyhint: 'done',
    'aria-label': 'New habit name',
    'aria-describedby': hintId,
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submitAdd();
      }
    },
    onInput: () => addHint.classList.contains('is-warn') && paintAdd(),
  });
  const addCells = L.WEEK_ORDER.map((wd) => {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'hb-plan-cell is-draft',
        'aria-pressed': 'true',
        'aria-label': `New habit on ${WEEKDAYS_LONG[wd]}`,
        title: WEEKDAYS_LONG[wd],
        onClick: () => {
          addDays = addDays.includes(wd) ? addDays.filter((d) => d !== wd) : L.normalizeDays([...addDays, wd]);
          paintAdd();
        },
      },
      icon('check', { size: 14, stroke: 2.5 }),
    );
    return { wd, btn, td: h('td', { class: 'hb-plan-td' }, btn) };
  });
  const addBtn = h('button', { type: 'button', class: 'btn btn--sm btn--primary', onClick: submitAdd }, icon('plus', { size: 14 }), 'Add habit');

  /* ---- Table ---- */

  const tbody = h('tbody', { onKeydown: onGridKey });
  const emptyRow = h(
    'tr',
    { class: 'hb-plan-empty' },
    h('td', { colspan: '8' }, h('span', { class: 'label' }, 'No active habits'), h('span', null, ' — name one below and pick its days.')),
  );
  const table = h(
    'table',
    { class: 'hb-plan-table' },
    h('caption', { class: 'sr-only' }, 'Weekly plan. Rows are habits, columns are weekdays. Toggling a cell plans or unplans that habit from today. Arrow keys move between cells; Alt with Up or Down reorders.'),
    h('colgroup', null, h('col', { class: 'hb-plan-namecol' }), L.WEEK_ORDER.map(() => h('col'))),
    h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'hb-plan-corner' }, h('span', { class: 'label' }, 'Habit')), cols.map((c) => c.th))),
    tbody,
    h(
      'tfoot',
      null,
      h(
        'tr',
        { class: 'hb-plan-addrow' },
        h('th', { scope: 'row', class: 'hb-plan-rowhead' }, h('div', { class: 'hb-plan-addname' }, icon('plus', { size: 14 }), addInput)),
        addCells.map((c) => c.td),
      ),
    ),
  );

  const panel = h(
    'section',
    { class: 'panel hud hb-plan', 'aria-label': 'Week plan' },
    head,
    h('div', { class: 'hb-plan-scroll' }, table),
    h(
      'div',
      { class: 'hb-plan-foot' },
      h('div', { class: 'hb-plan-addbar' }, addHint, h('span', { class: 'spacer' }), addBtn),
      h('p', { class: 'label hb-plan-note' }, icon('clock', { size: 12 }), h('span', null, 'Changes apply from today · past days keep their plan')),
    ),
  );

  /* ---- Archived ---- */

  const archCount = h('span', { class: 'label tnum' });
  const archList = h('ul', { id: `${n}-arch`, class: 'hb-arch-list' });
  const archToggle = h(
    'button',
    {
      type: 'button',
      class: 'hb-fold',
      'aria-expanded': 'false',
      'aria-controls': archList.id,
      onClick: () => {
        archOpen = !archOpen;
        paintArch(lastArchived);
      },
    },
    h('span', { class: 'hb-fold-icon', 'aria-hidden': 'true' }, icon('chevron-right', { size: 14 })),
    h('span', { class: 'label hb-fold-title' }, 'Archived'),
    archCount,
  );
  const archSection = h('section', { class: 'hb-arch', 'aria-label': 'Archived habits' }, archToggle, archList);

  container.append(panel, archSection);

  /* ---- Rows ---- */

  function createRow(id) {
    const nameText = h('span', { class: 'hb-plan-name-text' });
    const nameBtn = h('button', { type: 'button', class: 'hb-plan-name', onClick: () => actions.openEditor(id) }, nameText, h('span', { class: 'sr-only' }, ', edit'));
    const sub = h('span', { class: 'hb-plan-sub label tnum' });
    const editBtn = iconBtn('edit', () => actions.openEditor(id));
    const archiveBtn = iconBtn('archive', () => actions.archive(id));
    const deleteBtn = iconBtn('trash', () => actions.remove(id));
    editBtn.title = 'Edit';
    archiveBtn.title = 'Archive';
    deleteBtn.title = 'Delete forever';
    const cells = L.WEEK_ORDER.map((wd, col) => {
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'hb-plan-cell',
          tabindex: '-1',
          'aria-pressed': 'false',
          dataset: { id, col: String(col) },
          onClick: () => actions.toggleDay(id, wd),
          onFocus: () => {
            cursor = { id, col };
            syncTabStops();
          },
        },
        icon('check', { size: 14, stroke: 2.5 }),
      );
      return { wd, btn, td: h('td', { class: 'hb-plan-td' }, btn) };
    });
    const tr = h(
      'tr',
      { class: 'hb-plan-row', dataset: { id } },
      h(
        'th',
        { scope: 'row', class: 'hb-plan-rowhead' },
        h('div', { class: 'hb-plan-rowin' }, h('div', { class: 'hb-plan-ident' }, nameBtn, sub), h('div', { class: 'row-actions hb-plan-acts' }, editBtn, archiveBtn, deleteBtn)),
      ),
      cells.map((c) => c.td),
    );

    function update(it, today, todayCol) {
      const days = L.planOn(it, today);
      nameText.textContent = it.name;
      nameBtn.title = `${it.name} — edit`;
      editBtn.setAttribute('aria-label', `Edit “${it.name}”`);
      archiveBtn.setAttribute('aria-label', `Archive “${it.name}”`);
      deleteBtn.setAttribute('aria-label', `Delete “${it.name}” forever`);
      sub.textContent = it.createdAt > today ? `Starts ${formatDay(it.createdAt)}` : days.length ? perWeek(days) : 'No days';
      tr.classList.toggle('is-idle', !days.length);
      cells.forEach((c, i) => {
        const on = days.includes(c.wd);
        c.btn.setAttribute('aria-pressed', String(on));
        c.btn.setAttribute('aria-label', `${it.name} on ${WEEKDAYS_LONG[c.wd]}`);
        c.btn.title = `${WEEKDAYS_LONG[c.wd]} · ${on ? 'planned' : 'off'}`;
        c.td.classList.toggle('is-today', i === todayCol);
      });
    }

    return { tr, cells, update };
  }

  function syncTabStops() {
    if (!rows.has(cursor.id)) cursor = { id: order[0] ?? null, col: cursor.col };
    for (const [id, row] of rows) row.cells.forEach((c, col) => (c.btn.tabIndex = id === cursor.id && col === cursor.col ? 0 : -1));
  }

  function focusCell(id, col) {
    const row = rows.get(id);
    if (!row) return;
    cursor = { id, col };
    syncTabStops();
    row.cells[col].btn.focus();
  }

  /** Arrow keys walk the grid; Alt + Up/Down (anywhere in a row) reorders the habit among the visible rows. */
  function onGridKey(e) {
    const tr = e.target instanceof Element ? e.target.closest('.hb-plan-row[data-id]') : null;
    if (!tr || !order.includes(tr.dataset.id)) return;
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      actions.move(tr.dataset.id, e.key === 'ArrowUp' ? -1 : 1, order);
      return;
    }
    const btn = e.target.closest('.hb-plan-cell[data-id]');
    if (!btn || e.altKey || e.metaKey || e.ctrlKey) return;
    const r = order.indexOf(btn.dataset.id);
    const c = Number(btn.dataset.col);
    let nr = r;
    let nc = c;
    if (e.key === 'ArrowLeft') nc--;
    else if (e.key === 'ArrowRight') nc++;
    else if (e.key === 'ArrowUp') nr--;
    else if (e.key === 'ArrowDown') nr++;
    else if (e.key === 'Home') nc = 0;
    else if (e.key === 'End') nc = 6;
    else return;
    e.preventDefault();
    focusCell(order[clamp(nr, 0, order.length - 1)], clamp(nc, 0, 6));
  }

  /* ---- Archived rows ---- */

  function createArchRow(id) {
    const name = h('span', { class: 'hb-arch-name' });
    const meta = h('span', { class: 'label tnum hb-arch-meta' });
    const restore = h('button', { type: 'button', class: 'btn btn--sm', onClick: () => actions.unarchive(id) }, icon('undo', { size: 14 }), 'Restore');
    const del = h('button', { type: 'button', class: 'btn btn--sm btn--danger', onClick: () => actions.remove(id) }, icon('trash', { size: 14 }), h('span', null, 'Delete forever'));
    const li = h('li', { class: 'hb-arch-row' }, h('div', { class: 'hb-arch-ident' }, name, meta), h('div', { class: 'hb-arch-acts' }, restore, del));
    return {
      li,
      update(it) {
        const logged = Object.keys(it.log).length;
        name.textContent = it.name;
        name.title = it.name;
        meta.textContent = `Archived ${formatDay(it.archivedAt)} · ${plural(logged, 'logged day')}`;
        restore.setAttribute('aria-label', `Restore “${it.name}” from today`);
        del.setAttribute('aria-label', `Delete “${it.name}” forever`);
      },
    };
  }

  function paintArch(archived) {
    lastArchived = archived;
    archSection.hidden = !archived.length;
    if (!archived.length) archOpen = false;
    archCount.textContent = `(${archived.length})`;
    archToggle.setAttribute('aria-expanded', String(archOpen));
    archList.hidden = !archOpen;
    const keep = new Set(archived.map((it) => it.id));
    for (const [id, row] of archRows) {
      if (keep.has(id)) continue;
      row.li.remove();
      archRows.delete(id);
    }
    archived.forEach((it, i) => {
      let row = archRows.get(it.id);
      if (!row) {
        row = createArchRow(it.id);
        archRows.set(it.id, row);
      }
      row.update(it);
      if (archList.children[i] !== row.li) archList.insertBefore(row.li, archList.children[i] ?? null);
    });
  }

  /* ---- Add row ---- */

  function paintAdd(warning = '') {
    addCells.forEach((c) => c.btn.setAttribute('aria-pressed', String(addDays.includes(c.wd))));
    addHint.classList.toggle('is-warn', !!warning);
    addHint.textContent = warning || (addDays.length ? `${perWeek(addDays)} · ${L.scheduleLabel(addDays)} · Enter to add` : 'Pick at least one day');
  }

  function warnAdd(text, el) {
    paintAdd(text);
    replay(addHint, 'is-shake');
    el?.focus();
  }

  function submitAdd() {
    const name = L.cleanName(addInput.value);
    if (!name) {
      warnAdd('Type a name first', addInput);
      return;
    }
    if (!addDays.length) {
      warnAdd('Pick at least one day');
      return;
    }
    actions.create({ name, days: addDays });
    addInput.value = '';
    addInput.focus();
    paintAdd();
  }

  /* ---- Day dialog: one weekday's lineup, copy it to other days, or clear it ---- */

  function openDayModal(wd, preset = []) {
    if (!mounted) return;
    dayModal?.close();
    const today = source.today();
    const byDay = new Map(L.weekPlan(source.getItems(), today).map((d) => [d.weekday, d.habits]));
    const lineup = byDay.get(wd);
    const name = WEEKDAYS_LONG[wd];
    const labelId = nextId('hb-dm');
    let targets = preset.filter((d) => d !== wd);
    let closed = false;

    const overwritten = () => targets.filter((d) => byDay.get(d).length && !sameIds(byDay.get(d), lineup));
    const hint = h('p', { class: 'hb-f-hint label', 'aria-live': 'polite' });
    const copyBtn = h('button', { type: 'button', class: 'btn btn--primary', onClick: copy }, icon('check'), 'Copy');
    const picker = weekdayPicker({
      days: targets,
      labelledBy: labelId,
      locked: [wd],
      sub: (d) => idx(byDay.get(d).length),
      describe: (d) => `${WEEKDAYS_LONG[d]} (${plural(byDay.get(d).length, 'habit')} now)`,
      onChange: (v) => {
        targets = v;
        sync();
      },
    });

    function sync() {
      const over = overwritten();
      copyBtn.disabled = !targets.length;
      if (!targets.length) hint.textContent = 'Pick the days that should get this lineup';
      else if (over.length) hint.textContent = `Replaces the lineup on ${dayNames(over)}`;
      else hint.textContent = `${plural(lineup.length, 'habit')} → ${dayNames(targets)}`;
    }

    async function copy() {
      if (closed || !targets.length) return;
      const chosen = [...targets];
      const over = overwritten();
      m.close();
      if (over.length) {
        const ok = await confirmDialog({
          title: 'Overwrite lineups?',
          message: `${dayNames(over)} will get ${name}'s lineup (${plural(lineup.length, 'habit')}) from today. Past days keep their plan.`,
          confirmLabel: 'Overwrite',
          danger: true,
        });
        if (!ok) {
          if (mounted) openDayModal(wd, chosen);
          return;
        }
      }
      actions.copyDay(wd, chosen);
    }

    function clear() {
      if (closed) return;
      m.close();
      actions.clearDay(wd);
    }

    function addHere() {
      if (closed) return;
      m.close();
      actions.openEditor(null, { weekday: wd });
    }

    const body = [
      h(
        'div',
        { class: 'hb-dm-lineup' },
        h('span', { class: 'label' }, `${plural(lineup.length, 'habit')} on ${name}s`),
        lineup.length
          ? h('ol', { class: 'hb-dm-names' }, lineup.map((hb, i) => h('li', null, h('span', { class: 'label tnum' }, idx(i + 1)), h('span', { class: 'hb-wrap' }, hb.name))))
          : h('p', { class: 'hb-f-note' }, 'Nothing planned — a rest day.'),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost hb-dm-add', onClick: addHere }, icon('plus', { size: 14 }), `New habit on ${name}`),
      ),
      h('div', { class: 'field' }, h('span', { class: 'label', id: labelId }, 'Copy this lineup to'), picker.el, hint),
      h('p', { class: 'hb-f-note' }, icon('clock', { size: 12 }), 'Applies from today — past days keep their plan.'),
    ];

    const m = openModal({
      title: `${name} lineup`,
      body,
      footer: [
        h('button', { type: 'button', class: 'btn btn--danger', disabled: !lineup.length, onClick: clear }, icon('x'), `Clear ${name}`),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
        copyBtn,
      ],
      // Copy starts disabled until a day is picked, so the default target (the primary button) can't take focus.
      initialFocus: targets.length ? copyBtn : [...picker.el.children].find((b) => !b.disabled),
      onClose: () => {
        closed = true;
        if (dayModal === m) dayModal = null;
      },
    });
    m.el.classList.add('hb-modal');
    dayModal = m;
    sync();
  }

  /* ---- Render (patches in place: the add input and focus survive updates) ---- */

  function render() {
    if (!mounted) return;
    const today = source.today();
    const items = source.getItems();
    const live = items.filter((it) => !L.isArchived(it, today));
    const counts = L.weekPlan(items, today).map((d) => d.habits.length);
    const max = Math.max(1, ...counts);
    const todayCol = L.WEEK_ORDER.indexOf(L.weekdayOfKey(today));
    if (today !== lastToday) {
      cursor = { id: cursor.id, col: todayCol };
      lastToday = today;
    }

    summaryEl.textContent = `${plural(live.length, 'habit')} · ${counts.reduce((a, b) => a + b, 0)} check-ins / week`;
    cols.forEach((c, i) => {
      c.count.textContent = String(counts[i]);
      c.count.classList.toggle('is-zero', !counts[i]);
      c.unit.textContent = counts[i] === 1 ? 'habit' : 'habits';
      c.fill.style.width = `${(counts[i] / max) * 100}%`;
      c.th.classList.toggle('is-today', i === todayCol);
      c.btn.setAttribute('aria-label', `${WEEKDAYS_LONG[c.wd]}${i === todayCol ? ' (today)' : ''}: ${plural(counts[i], 'habit')} planned. Copy or clear this day`);
      c.btn.title = `Copy or clear ${WEEKDAYS_LONG[c.wd]}`;
    });
    addCells.forEach((c, i) => c.td.classList.toggle('is-today', i === todayCol));

    const active = document.activeElement;
    const ids = new Set(live.map((it) => it.id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.tr.remove();
      rows.delete(id);
    }
    if (live.length) emptyRow.remove();
    else if (!emptyRow.isConnected) tbody.append(emptyRow);
    live.forEach((it, i) => {
      let row = rows.get(it.id);
      if (!row) {
        row = createRow(it.id);
        rows.set(it.id, row);
      }
      row.update(it, today, todayCol);
      if (tbody.children[i] !== row.tr) tbody.insertBefore(row.tr, tbody.children[i] ?? null);
    });
    order = live.map((it) => it.id);
    // Nothing active any more (or on arrival, e.g. from "Restore from archive"): show what can come back.
    if (!live.length && liveCount !== 0) archOpen = true;
    liveCount = live.length;
    syncTabStops();
    // Re-inserting a row drops focus; put it back where the user was.
    if (active instanceof HTMLElement && active !== document.activeElement && active.isConnected) active.focus({ preventScroll: true });

    paintArch(items.filter((it) => L.isArchived(it, today)));
  }

  paintAdd();
  render();
  const unsubscribe = source.subscribe(render);
  const offDayChange = onDayChange(render);

  return () => {
    mounted = false;
    unsubscribe();
    offDayChange();
    dayModal?.close();
  };
}
