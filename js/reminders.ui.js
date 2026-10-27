// LIFE/OS — reminders: the pieces you touch. One editor for every place a reminder is set (the
// event editor, a task's Details, a task's page, Settings → Reminders), the small Reminders
// dialog, the right-click menu's "Remind me ▸" and the quiet bell on items that have reminders of
// their own. The rules are js/reminders.logic.js; firing them is js/reminders.js.
//
//   reminderEditor({ value, kind, mode, onChange })  -> { el, get(), set(value), setKind(kind), setHint(text) }
//     value  an item's list: null (the defaults), [] (none) or [{ id, before, sound }]
//     kind   'event' | 'timedTask' | 'dateTask': which defaults "Default" means
//     mode   'item' (Default · Custom · None on top) or 'defaults' (Settings: just the list)
//   openRemindersDialog({ title, kind, value, hint, onSave })
//   remindMenu({ value, kind, name, onSet, onCustom })  -> a "Remind me ▸" entry for the right-click menu
//   bellMark()  -> the bell beside an item's title or time

import { h, icon, registerIcon, hasIcon, dropdown, openModal, toast, uid } from './ui.js';
import { settings } from './store.js';
import {
  REMINDER_PRESETS,
  SOUNDS,
  UNITS,
  MAX_REMINDERS,
  normalizeSettings,
  normalizeReminders,
  effectiveReminders,
  formatBefore,
  listBefore,
  splitBefore,
  joinBefore,
  soundLabel,
} from './reminders.logic.js';
import { play, prime } from './sounds.js';

// The same bell as the Pomodoro page's (whichever module loads first draws it)
if (!hasIcon('bell')) registerIcon('bell', '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z"/><path d="M10 21h4"/>');
if (!hasIcon('play')) registerIcon('play', '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z"/>');
registerIcon('bell-off', '<path d="M8.5 5.2A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17"/><path d="M10 21h4M3 3l18 18"/>');
registerIcon('bell-plus', '<path d="M6 16V11a6 6 0 0 1 8.2-5.6"/><path d="M18 11.5V16l1.5 2h-15"/><path d="M10 21h4M18.5 3v5M16 5.5h5"/>');

/** This device's reminder settings (Settings → Reminders), cleaned. */
export function reminderSettings() {
  return normalizeSettings(settings.get()?.reminders);
}

/** The bell beside an item that has reminders of its own (quiet: its text color, small). */
export function bellMark({ size = 11 } = {}) {
  return h('span', { class: 'rm-bell', title: 'Has reminders' }, icon('bell', { size, stroke: 1.75 }), h('span', { class: 'sr-only' }, ', reminders set'));
}

/** 'At the time' · '10 min before': the short words the quick menus use. */
export function shortBefore(minutes) {
  if (minutes === 0) return 'At the time';
  if (minutes < 60) return `${minutes} min before`;
  return formatBefore(minutes);
}

const DEFAULT_SOUND = '__default';
const soundValue = (id) => id ?? DEFAULT_SOUND;
const soundFrom = (v) => (v === DEFAULT_SOUND ? null : v);
let seq = 0;

/** A new reminder for the list (an id of its own: two devices adding one never collide). */
const fresh = (before, sound = null) => ({ id: `r${uid().replace(/-/g, '').slice(0, 10)}`, before, sound });

/** The defaults of a kind as a list of the item's own (Default → Custom starts from them). */
function defaultsAsOwn(kind, s) {
  return effectiveReminders(null, kind, s).map((r) => fresh(r.before, r.sound));
}

/** Play a sound from a click (the click is what lets the browser play it). */
export function previewSound(id) {
  prime();
  if (id === 'none') return;
  if (!play(id)) toast('This browser can’t play the sound.');
}

/**
 * The editor. Every reminder is a row: [when ▾] [sound ▾] [▶] [×], then "+ Add reminder" (the
 * quick choices and Custom…: a number and minutes / hours / days / weeks). In 'item' mode a
 * three-way choice says where the item's reminders come from: Default (Settings → Reminders, said
 * in words under it), Custom (these rows) or None. Keyboard: every part is a button, a menu or a
 * field, in reading order.
 */
export function reminderEditor({ value = null, kind = 'event', mode = 'item', onChange = () => {}, label = 'Reminders' } = {}) {
  const n = ++seq;
  const labelId = `rm-ed-${n}-label`;
  let list = mode === 'defaults' ? normalizeReminders(value) ?? [] : normalizeReminders(value);
  let currentKind = kind;
  const customRows = new Set(); // rows showing the number + unit fields (Custom…)

  const s = () => reminderSettings();

  const modeBtns = mode === 'item'
    ? [
        ['default', 'Default'],
        ['custom', 'Custom'],
        ['none', 'None'],
      ].map(([v, text]) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', dataset: { mode: v }, onClick: () => pickMode(v) }, text))
    : [];
  const seg = mode === 'item' ? h('div', { class: 'seg rm-ed-mode', role: 'group', 'aria-label': 'Where this item’s reminders come from' }, modeBtns) : null;
  const note = h('p', { class: 'rm-ed-note' });
  const rowsEl = h('ul', { class: 'rm-ed-list', 'aria-labelledby': labelId });
  const addMenu = dropdown({
    label: 'Add reminder',
    icon: 'plus',
    items: [],
    showValue: false,
    className: 'rm-ed-add-btn',
    menuLabel: 'Add a reminder',
    onSelect: (before) => add(before),
  });
  const hintEl = h('p', { class: 'rm-ed-hint', hidden: true });
  const el = h(
    'div',
    { class: ['rm-ed', `rm-ed--${mode}`], role: 'group', 'aria-labelledby': labelId },
    h('div', { class: 'rm-ed-head' }, h('span', { class: 'label rm-ed-label', id: labelId }, icon('bell', { size: 13 }), h('span', null, label)), seg),
    note,
    rowsEl,
    h('div', { class: 'rm-ed-add' }, addMenu.el),
    hintEl,
  );

  const modeOf = () => (list === null ? 'default' : list.length ? 'custom' : 'none');

  function commit(next, { focus = null } = {}) {
    list = next === null ? null : normalizeReminders(next) ?? [];
    for (const id of [...customRows]) if (!list?.some((r) => r.id === id)) customRows.delete(id);
    render(focus);
    onChange(get());
  }

  function get() {
    if (list === null) return null;
    return list.map((r) => ({ id: r.id, before: r.before, sound: r.sound ?? null }));
  }

  function pickMode(v) {
    if (v === modeOf()) return;
    if (v === 'default') commit(null, { focus: '[data-mode="default"]' });
    else if (v === 'none') commit([], { focus: '[data-mode="none"]' });
    else {
      const start = defaultsAsOwn(currentKind, s());
      commit(start.length ? start : [fresh(currentKind === 'event' ? 15 : 0)], { focus: '[data-mode="custom"]' });
    }
  }

  /** Add one (`before` in minutes, or 'custom' for the number + unit fields). From Default, the defaults stay. */
  function add(before) {
    const base = list === null ? defaultsAsOwn(currentKind, s()) : list.slice();
    if (base.length >= MAX_REMINDERS) return;
    if (before === 'custom') {
      // The first quick choice not taken yet, ready to change
      const taken = new Set(base.map((r) => r.before));
      const start = [60, 30, 120, 1440, 15, 10, 5].find((m) => !taken.has(m)) ?? 45;
      const r = fresh(start);
      customRows.add(r.id);
      commit([...base, r], { focus: `[data-row="${r.id}"] .rm-num` });
      return;
    }
    if (base.some((r) => r.before === before)) return;
    const r = fresh(before);
    commit([...base, r], { focus: `[data-row="${r.id}"] .rm-when .dd-btn` });
  }

  function change(id, patch, focus) {
    if (!list) return;
    commit(list.map((r) => (r.id === id ? { ...r, ...patch } : r)), { focus });
  }

  function remove(id, at) {
    if (!list) return;
    const next = list.filter((r) => r.id !== id);
    // The keyboard goes to the next row's ×, the one before, or Add
    const after = next[at] ?? next[at - 1];
    commit(next, { focus: after ? `[data-row="${after.id}"] .rm-x` : '.rm-ed-add-btn' });
  }

  function whenControl(r, i) {
    const used = new Set(list.filter((x) => x.id !== r.id).map((x) => x.before));
    if (customRows.has(r.id)) {
      const { n: count, unit } = splitBefore(r.before);
      const num = h('input', {
        class: 'input rm-num tnum',
        type: 'number',
        inputmode: 'numeric',
        min: '0',
        max: '999',
        step: '1',
        value: String(count),
        'aria-label': `Reminder ${i + 1}: how many`,
      });
      const unitSel = h(
        'select',
        { class: 'select rm-unit', 'aria-label': `Reminder ${i + 1}: minutes, hours, days or weeks` },
        UNITS.map((u) => h('option', { value: u.id }, u.label)),
      );
      unitSel.value = unit;
      let current = r.before;
      const apply = () => {
        const minutes = joinBefore(num.value, unitSel.value);
        const taken = minutes !== null && used.has(minutes);
        const bad = minutes === null || num.value.trim() === '' || taken;
        num.toggleAttribute('aria-invalid', bad);
        num.title = taken ? 'There is a reminder at that time already' : '';
        if (!bad && minutes !== current) {
          // The list re-sorts when the fields are left, not under the typing
          current = minutes;
          list = list.map((x) => (x.id === r.id ? { ...x, before: minutes } : x));
          onChange(get());
        }
      };
      num.addEventListener('input', apply);
      unitSel.addEventListener('change', apply);
      // Leaving the fields puts the row in its place (largest first)
      const settle = (e) => {
        if (wrap.contains(e.relatedTarget)) return;
        num.removeAttribute('aria-invalid');
        commit(list);
      };
      const wrap = h('span', { class: 'rm-when rm-when--custom' }, num, unitSel, h('span', { class: 'rm-before' }, 'before'));
      wrap.addEventListener('focusout', settle);
      return wrap;
    }
    const items = REMINDER_PRESETS.map((m) => ({ value: m, label: formatBefore(m), disabled: used.has(m) }));
    if (!REMINDER_PRESETS.includes(r.before)) items.push({ value: r.before, label: formatBefore(r.before) });
    items.push({ separator: true }, { label: 'Custom…', icon: 'edit', action: () => {
      customRows.add(r.id);
      render(`[data-row="${r.id}"] .rm-num`);
    } });
    const dd = dropdown({
      items,
      value: r.before,
      className: 'rm-when-btn',
      menuLabel: 'When',
      ariaLabel: ({ picked }) => `Reminder ${i + 1}: ${picked?.label ?? formatBefore(r.before)}`,
      onSelect: (m) => change(r.id, { before: m }, `[data-row="${r.id}"] .rm-when .dd-btn`),
    });
    return h('span', { class: 'rm-when' }, dd.el);
  }

  function soundControl(r, i) {
    const def = s().sound;
    const items = [{ value: DEFAULT_SOUND, label: soundLabel(null, def), icon: 'volume' }, ...SOUNDS.map((x) => ({ value: x.id, label: x.label, icon: x.id === 'none' ? 'bell-off' : 'volume' }))];
    const dd = dropdown({
      items,
      value: soundValue(r.sound),
      className: 'rm-sound-btn',
      menuLabel: 'Sound',
      ariaLabel: ({ picked }) => `Reminder ${i + 1} sound: ${picked?.label ?? ''}`,
      onSelect: (v) => {
        change(r.id, { sound: soundFrom(v) }, `[data-row="${r.id}"] .rm-sound .dd-btn`);
        // Picking a sound plays it (a click: the browser allows it)
        previewSound(soundFrom(v) ?? def);
      },
    });
    const effective = r.sound ?? def;
    const playBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--icon btn--sm rm-play',
        'aria-label': `Play ${soundLabel(effective)}`,
        title: effective === 'none' ? 'Silent' : `Play ${soundLabel(effective)}`,
        disabled: effective === 'none',
        onClick: () => previewSound(effective),
      },
      icon('play', { size: 13 }),
    );
    return h('span', { class: 'rm-sound' }, dd.el, playBtn);
  }

  function rowEl(r, i) {
    return h(
      'li',
      { class: 'rm-row', dataset: { row: r.id } },
      whenControl(r, i),
      soundControl(r, i),
      h(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--icon btn--sm rm-x', 'aria-label': `Remove reminder: ${formatBefore(r.before)}`, title: 'Remove', onClick: () => remove(r.id, i) },
        icon('x', { size: 14 }),
      ),
    );
  }

  function render(focus = null) {
    // A focused part comes back after the redraw (the same row's same control)
    const active = document.activeElement;
    const keep = !focus && el.contains(active) ? focusKey(active) : null;
    const m = modeOf();
    modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    const settingsNow = s();
    if (mode === 'item' && m === 'default') {
      const d = effectiveReminders(null, currentKind, settingsNow);
      // (a task with only a date, or an all-day event, counts from the all-day time)
      const from = currentKind === 'dateTask' ? ` (from ${settingsNow.allDayTime} on its day)` : '';
      note.textContent = d.length ? `${listBefore(d)}${from} · ${soundLabel(d[0].sound, settingsNow.sound).replace(/^Default \((.*)\)$/, '$1')}. Change the defaults in Settings → Reminders.` : 'No reminders by default. Change that in Settings → Reminders.';
      note.hidden = false;
    } else if (mode === 'item' && m === 'none') {
      note.textContent = 'No reminders for this one.';
      note.hidden = false;
    } else if (mode === 'defaults' && !list.length) {
      note.textContent = 'No reminders by default.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    const shown = list ?? [];
    rowsEl.replaceChildren(...shown.map(rowEl));
    rowsEl.hidden = !shown.length;
    const count = list === null ? effectiveReminders(null, currentKind, settingsNow).length : list.length;
    const full = count >= MAX_REMINDERS;
    const taken = new Set((list ?? effectiveReminders(null, currentKind, settingsNow)).map((r) => r.before));
    addMenu.update({
      items: [
        ...REMINDER_PRESETS.map((mins) => ({ value: mins, label: formatBefore(mins), disabled: taken.has(mins) })),
        { separator: true },
        { label: 'Custom…', icon: 'edit', action: () => add('custom') },
      ],
    });
    addMenu.button.disabled = full;
    addMenu.button.title = full ? `At most ${MAX_REMINDERS} reminders` : '';
    const target = focus ? el.querySelector(focus) : keep ? el.querySelector(keep) : null;
    target?.focus({ preventScroll: true });
  }

  /** A selector for the control that has the focus, to find it again after a redraw. */
  function focusKey(node) {
    const rowNode = node.closest('[data-row]');
    const part = node.closest('.rm-when, .rm-sound, .rm-x, .rm-play') ?? node;
    if (node.dataset?.mode) return `[data-mode="${node.dataset.mode}"]`;
    if (node.closest('.rm-ed-add')) return '.rm-ed-add-btn';
    if (!rowNode) return null;
    const cls = part.classList.contains('rm-x') ? '.rm-x' : part.classList.contains('rm-play') ? '.rm-play' : part.classList.contains('rm-sound') ? '.rm-sound .dd-btn' : node.classList.contains('rm-unit') ? '.rm-unit' : node.classList.contains('rm-num') ? '.rm-num' : '.rm-when .dd-btn';
    return `[data-row="${rowNode.dataset.row}"] ${cls}`;
  }

  render();
  // Settings → Reminders changed (the default sound, the defaults): the words follow. The editor
  // lives in a dialog or on a page and stops listening once it is gone.
  let seen = JSON.stringify(settings.get()?.reminders ?? null);
  const off = settings.subscribe((next) => {
    if (!el.isConnected) {
      if (mounted) off();
      return;
    }
    mounted = true;
    const now = JSON.stringify(next?.reminders ?? null);
    if (now === seen) return;
    seen = now;
    if (!el.querySelector('.rm-num:focus, .rm-unit:focus')) render();
  });
  let mounted = false;
  queueMicrotask(() => (mounted = el.isConnected));

  return {
    el,
    get,
    set(next) {
      list = mode === 'defaults' ? normalizeReminders(next) ?? [] : normalizeReminders(next);
      customRows.clear();
      render();
    },
    /** Which defaults "Default" stands for (a task gets a time: timedTask). */
    setKind(next) {
      if (next === currentKind) return;
      currentKind = next;
      render();
    },
    /** A line under the editor ('Add a date to get reminders'), or '' for none. */
    setHint(text) {
      hintEl.textContent = text ?? '';
      hintEl.hidden = !text;
    },
  };
}

/**
 * The Reminders dialog (a task's page, the right-click menu's Custom…): the editor for one item,
 * Save and Cancel. onSave(value) gets the list (null, [] or the reminders).
 */
export function openRemindersDialog({ title = '', kind = 'event', value = null, hint = '', onSave = () => {} } = {}) {
  // (the dialog's title says "Reminders" already: the editor's own label is for screen readers)
  const editor = reminderEditor({ value, kind, label: title ? `Reminders for ${title}` : 'Reminders' });
  if (hint) editor.setHint(hint);
  const initial = JSON.stringify(editor.get());
  const save = () => {
    const next = editor.get();
    m.close();
    if (JSON.stringify(next) !== initial) onSave(next);
  };
  const m = openModal({
    title: 'Reminders',
    className: 'rm-dialog',
    body: [title ? h('p', { class: 'rm-dialog-for' }, title) : null, editor.el],
    footer: [h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, 'Save')],
    initialFocus: editor.el.querySelector('.seg-btn[aria-pressed="true"]') ?? editor.el.querySelector('button'),
  });
  return m;
}

/** The quick choices of "Remind me ▸" (minutes before). */
export const QUICK_REMINDERS = Object.freeze([0, 10, 60, 1440, 10080]);

/**
 * "Remind me ▸" for a right-click menu: the quick choices (each ticked while the item has it, a
 * click adds or removes it; the item's reminders start from the defaults it follows), Custom…
 * (the Reminders dialog), No reminders, and Use the defaults once it has its own.
 * onSet(list, message) writes the item (with Undo); onCustom() opens the dialog.
 */
export function remindMenu({ value = null, kind = 'event', name = '', onSet, onCustom, disabledHint = '' }) {
  const s = reminderSettings();
  const own = normalizeReminders(value);
  const effective = own ?? effectiveReminders(null, kind, s);
  const has = new Set(effective.map((r) => r.before));
  // The quick choices, and any reminder the item has besides them (15 minutes, the default), ticked
  const choices = [...new Set([...QUICK_REMINDERS, ...has])].sort((a, b) => a - b);
  const children = choices.map((m) => ({
    id: `remind-${m}`,
    label: shortBefore(m),
    checked: has.has(m),
    run: () => {
      const base = (own ?? effective.map((r) => fresh(r.before, r.sound))).slice();
      if (has.has(m)) onSet(base.filter((r) => r.before !== m), `${name}: no reminder ${shortBefore(m).toLowerCase()} now.`);
      else onSet([...base, fresh(m)].slice(-MAX_REMINDERS), `${name}: reminder ${shortBefore(m).toLowerCase()}.`);
    },
  }));
  children.push(
    { separator: true },
    { id: 'remind-custom', label: 'Custom…', icon: 'edit', run: () => onCustom() },
    { id: 'remind-none', label: 'No reminders', icon: 'bell-off', checked: own !== null && own.length === 0, run: () => onSet([], `${name}: no reminders.`) },
  );
  if (own !== null) children.push({ id: 'remind-default', label: 'Use the defaults', icon: 'undo', run: () => onSet(null, `${name} follows the default reminders.`) });
  if (disabledHint) children.unshift({ id: 'remind-hint', label: disabledHint, icon: 'calendar', disabled: true, run: () => {} }, { separator: true });
  return { id: 'remind', label: 'Remind me', icon: 'bell', children };
}
