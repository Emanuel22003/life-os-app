// LIFE/OS — 12 // Calories: what you eat each day, against a daily goal. The add line takes a food,
// its calories (and protein, if you like) per serving and how many servings, into a meal; every
// food you log is remembered, so the next time is a few letters and Enter, or one tap on its chip.
// The day shows eaten, the goal and what's left, then Breakfast · Lunch · Dinner · Snacks; ‹ ›
// open other days. Beside it: the last 7 days as bars and your saved foods. Goal works the daily
// number out from your body (Mifflin-St Jeor), as an estimate, or takes your own.
//
// Pure rules in calories.logic.js. Store 'calories' (synced, except view: the day open on this
// device).

import { h, icon, pageHeader, toast, todayKey, formatDay, relativeDay, shiftKey, onDayChange, isTyping, modalOpen, menuOpen, uid, openModal, dismissTip, WEEKDAYS_SHORT } from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import { healthApi } from './health.js';
import * as C from './calories.logic.js';

const TIP_ID = 'calories.intro';
const FOODS_STEP = 12;

/* ==========================================================================
   Store
   ========================================================================== */

const store = createStore('calories', C.DEFAULT_STATE);
let cacheRaw = null;
let cacheState = null;

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheState = C.normalizeState(raw);
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

const dayName = (date, today = todayKey()) => (/^(Today|Yesterday)$/.test(relativeDay(date, today)) ? relativeDay(date, today) : formatDay(date));
const kcal = (n) => `${C.kcalText(n)} kcal`;
const foodWords = (e) => `${e.name}${C.servingsText(e.servings) ? ` ${C.servingsText(e.servings)}` : ''}`;

function deleteEntry(id) {
  const s = getState();
  const entry = s.entries.find((e) => e.id === id);
  if (!entry) return;
  commit(C.removeEntry(s, id));
  toast(`${foodWords(entry)} taken out of ${C.mealLabel(entry.meal)}.`, {
    duration: 6000,
    key: 'cl-entry',
    action: { label: 'Undo', onClick: () => commit(C.restoreEntry(getState(), entry)) },
  });
}

/** Another serving of an entry, on the same day and meal. */
function repeat(id) {
  const s = getState();
  const cur = s.entries.find((e) => e.id === id);
  const res = cur && C.repeatEntry(s, id, { date: cur.date, now: Date.now(), makeId: uid });
  if (!res) return;
  commit(res.state);
  toast(`${foodWords(res.entry)} added again: ${kcal(res.entry.kcal)}.`, {
    key: 'cl-entry',
    action: { label: 'Undo', onClick: () => commit(C.removeEntry(getState(), res.entry.id)) },
  });
}

/** A saved food, one serving, into `meal` of `date` at once (a chip, the + on a saved food). */
function addSaved(food, { date, meal }) {
  const res = C.logFood(getState(), { name: food.name, kcal: String(food.kcal), protein: food.protein == null ? '' : String(food.protein), servings: '1' }, { date, meal, now: Date.now(), makeId: uid });
  if (res.error) return toast(res.error);
  commit(res.state);
  dismissTip(TIP_ID);
  toast(`${food.name} added to ${C.mealLabel(meal)}${date === todayKey() ? '' : ` on ${formatDay(date)}`}: ${kcal(res.entry.kcal)}.`, {
    key: 'cl-entry',
    action: { label: 'Undo', onClick: () => commit(C.removeEntry(getState(), res.entry.id)) },
  });
}

function forgetFood(id) {
  const s = getState();
  const food = s.foods.find((f) => f.id === id);
  if (!food) return;
  commit(C.removeFood(s, id));
  toast(`${food.name} forgotten (what you logged with it stays).`, {
    key: 'cl-food',
    action: { label: 'Undo', onClick: () => commit(C.normalizeState({ ...getState(), foods: [food, ...getState().foods] })) },
  });
}

/** The latest weight on the Health page, in kg (for working out the goal), or null. */
function latestKg() {
  try {
    const w = healthApi.state().weights;
    return w.length ? w[w.length - 1].kg : null;
  } catch {
    return null;
  }
}

const mealSelect = (id, value) =>
  h(
    'select',
    { id, class: 'select cl-meal-in' },
    C.MEALS.map((m) => h('option', { value: m.id, selected: m.id === value }, m.label)),
  );

const field = (label, input, className = '') => h('div', { class: ['field', className] }, h('label', { class: 'label', for: input.id }, label), input);

let pendingFocus = false;

/* ==========================================================================
   The page
   ========================================================================== */

function mount(root) {
  root.classList.add('cl-root');
  const cleanups = [];

  const goalBtn = h('button', { type: 'button', class: 'btn cl-goal-btn', onClick: () => openGoalEditor() }, icon('flag', { size: 14 }), h('span', null, 'Goal'));
  const header = pageHeader({
    index: '12',
    title: 'Calories',
    subtitle: 'Log what you eat: calories and, if you like, protein. Every food you log is remembered, so next time it’s a few letters or one tap.',
    tipId: TIP_ID,
    actions: [goalBtn],
    stat: C.statusText(getState(), todayKey()),
  });
  goalBtn.title = 'Your daily calories and protein: set them, or work them out';

  let day = openDay();

  /* ---- The day: ‹ title › Today, then eaten · goal · left ---- */
  const prevBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-nav-btn', title: 'The day before', 'aria-label': 'The day before', onClick: () => go(shiftKey(day, -1)) }, icon('chevron-left', { size: 16 }));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-nav-btn', title: 'The day after', 'aria-label': 'The day after', onClick: () => go(shiftKey(day, 1)) }, icon('chevron-right', { size: 16 }));
  const todayBtn = h('button', { type: 'button', class: 'btn btn--sm cl-today', onClick: () => go(todayKey()) }, 'Today');
  const dayTitle = h('h2', { class: 'cl-day-title', id: 'cl-day-title' });
  const dayDate = h('p', { class: 'cl-day-date' });
  const eatenEl = h('span', { class: 'cl-eaten tnum' });
  const ofEl = h('span', { class: 'cl-of' });
  const leftEl = h('p', { class: 'cl-left' });
  const barFill = h('span', { class: 'cl-bar-fill' });
  const bar = h('div', { class: 'cl-bar', role: 'progressbar', 'aria-valuemin': '0' }, barFill);
  const proteinText = h('span', { class: 'cl-protein-text tnum' });
  const proteinFill = h('span', { class: 'cl-bar-fill' });
  const proteinBar = h('div', { class: 'cl-bar cl-bar--protein', role: 'progressbar', 'aria-valuemin': '0', 'aria-label': 'Protein' }, proteinFill);
  const proteinRow = h('div', { class: 'cl-protein' }, h('span', { class: 'label' }, 'Protein'), proteinText, proteinBar);
  const setGoalLink = h('button', { type: 'button', class: 'btn btn--sm cl-set-goal', onClick: () => openGoalEditor() }, icon('flag', { size: 13 }), h('span', null, 'Set a daily goal'));
  const dayPanel = h(
    'section',
    { class: 'cl-day panel', 'aria-labelledby': 'cl-day-title' },
    h('div', { class: 'cl-head' }, prevBtn, h('div', { class: 'cl-day-name' }, dayTitle, dayDate), nextBtn, h('span', { class: 'spacer' }), todayBtn),
    h('div', { class: 'cl-sum' }, h('p', { class: 'cl-sum-line' }, eatenEl, ofEl), leftEl, bar, setGoalLink),
    proteinRow,
  );

  function paintDay(s, today) {
    const t = C.dayTotals(s.entries, day);
    const isToday = day === today;
    dayTitle.textContent = dayName(day, today);
    dayDate.textContent = formatDay(day, 'long');
    nextBtn.disabled = isToday;
    todayBtn.hidden = isToday;
    eatenEl.textContent = C.kcalText(t.kcal);
    const goal = s.goal.kcal;
    ofEl.textContent = goal ? ` of ${kcal(goal)}` : ' kcal';
    const left = C.kcalLeft(s.goal, t.kcal);
    leftEl.textContent = left == null ? (t.count ? `${t.count} ${t.count === 1 ? 'food' : 'foods'} logged` : '') : left >= 0 ? `${kcal(left)} left` : `${kcal(-left)} over`;
    leftEl.classList.toggle('is-over', left != null && left < 0);
    leftEl.hidden = !leftEl.textContent;
    bar.hidden = !goal;
    setGoalLink.hidden = !!goal;
    if (goal) {
      barFill.style.width = `${Math.min(100, (t.kcal / goal) * 100)}%`;
      bar.classList.toggle('is-over', t.kcal > goal);
      bar.setAttribute('aria-valuemax', String(goal));
      bar.setAttribute('aria-valuenow', String(Math.min(t.kcal, goal)));
      bar.setAttribute('aria-valuetext', `${kcal(t.kcal)} of ${kcal(goal)}`);
      bar.setAttribute('aria-label', 'Calories eaten');
    }
    const pGoal = s.goal.protein;
    proteinRow.hidden = !pGoal && !t.hasProtein;
    proteinText.textContent = pGoal ? `${C.gramsText(t.protein)} of ${C.gramsText(pGoal)}` : C.gramsText(t.protein);
    proteinBar.hidden = !pGoal;
    if (pGoal) {
      proteinFill.style.width = `${Math.min(100, (t.protein / pGoal) * 100)}%`;
      proteinBar.setAttribute('aria-valuemax', String(pGoal));
      proteinBar.setAttribute('aria-valuenow', String(Math.min(t.protein, pGoal)));
      proteinBar.setAttribute('aria-valuetext', `${C.gramsText(t.protein)} of ${C.gramsText(pGoal)}`);
    }
  }

  /** Show `date` (never a day still to come). */
  function go(date) {
    const today = todayKey();
    day = date > today ? today : date;
    setOpenDay(day);
    render();
  }

  /* ---- The add line ---- */
  const add = addLine({ dayNow: () => day });

  /* ---- The meals of the day ---- */
  const mealsEl = h('section', { class: 'cl-meals panel', 'aria-label': 'What you ate' });

  function row(e) {
    return h(
      'li',
      { class: 'cl-row', dataset: { id: e.id } },
      h(
        'button',
        { type: 'button', class: 'cl-row-main', title: 'Change it', onClick: () => openEntryEditor(e.id) },
        h('span', { class: 'cl-row-name' }, e.name, C.servingsText(e.servings) ? h('span', { class: 'cl-row-x' }, ` ${C.servingsText(e.servings)}`) : null),
        e.protein != null ? h('span', { class: 'cl-row-protein tnum' }, C.gramsText(e.protein)) : h('span', { class: 'cl-row-protein', 'aria-hidden': 'true' }),
        h('span', { class: 'cl-row-kcal tnum' }, C.kcalText(e.kcal)),
      ),
      h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-row-del', title: `Take ${e.name} out`, 'aria-label': `Take ${e.name} out`, onClick: () => deleteEntry(e.id) }, icon('x', { size: 14 })),
    );
  }

  function paintMeals(s) {
    const t = C.dayTotals(s.entries, day);
    const focusId = document.activeElement?.closest?.('.cl-row')?.dataset.id;
    mealsEl.replaceChildren(
      ...t.meals.map((m) =>
        h(
          'div',
          { class: ['cl-meal', !m.items.length && 'is-empty'] },
          h(
            'div',
            { class: 'cl-meal-head' },
            h('h3', { class: 'cl-meal-title' }, m.label),
            h('span', { class: 'cl-meal-kcal tnum' }, m.items.length ? kcal(m.kcal) : ''),
            h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-meal-add', title: `Add to ${m.label}`, 'aria-label': `Add to ${m.label}`, onClick: () => add.focus(m.id) }, icon('plus', { size: 14 })),
          ),
          m.items.length ? h('ul', { class: 'cl-rows' }, m.items.map(row)) : null,
        ),
      ),
    );
    if (focusId) (mealsEl.querySelector(`.cl-row[data-id="${CSS.escape(focusId)}"] .cl-row-main`) ?? mealsEl.querySelector('.cl-row-main'))?.focus({ preventScroll: true });
  }

  /* ---- The last 7 days ---- */
  const weekEl = h('section', { class: 'cl-week panel', 'aria-labelledby': 'cl-week-title' });

  function paintWeek(s, today) {
    const days = C.lastDays(s.entries, today, 7);
    const goal = s.goal.kcal;
    const top = Math.max(goal ? goal * 1.15 : 0, ...days.map((d) => d.kcal), 1);
    const avg = C.averageKcal(days);
    const words = (d) => `${formatDay(d.date)}: ${d.logged ? kcal(d.kcal) : 'nothing logged'}`;
    // Each day a column (a click opens it), the goal a dashed line across, the days' names under
    const cols = days.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: ['cl-wk-day', d.date === day && 'is-open', goal && d.kcal > goal && 'is-over'],
          title: words(d),
          'aria-label': words(d),
          'aria-current': d.date === day ? 'date' : null,
          onClick: () => go(d.date),
        },
        h('span', { class: 'cl-wk-fill', style: `height:${(d.kcal / top) * 100}%` }),
      ),
    );
    const names = days.map((d) => h('span', { class: ['cl-wk-label', d.date === day && 'is-open'] }, d.date === today ? 'Today' : WEEKDAYS_SHORT[new Date(`${d.date}T12:00:00`).getDay()]));
    weekEl.replaceChildren(
      h('h2', { class: 'cl-side-title', id: 'cl-week-title' }, icon('activity', { size: 15 }), h('span', null, 'Last 7 days')),
      h('div', { class: 'cl-wk-plot' }, ...cols, goal ? h('span', { class: 'cl-wk-goal', style: `bottom:${(goal / top) * 100}%`, 'aria-hidden': 'true', title: `Goal ${kcal(goal)}` }) : null),
      h('div', { class: 'cl-wk-labels', 'aria-hidden': 'true' }, ...names),
      h('p', { class: 'cl-wk-avg' }, avg == null ? 'Nothing logged in the last 7 days.' : `Average ${kcal(avg)} a day${goal ? ` (goal ${C.kcalText(goal)})` : ''}, on the days you logged.`),
    );
  }

  /* ---- Your foods ---- */
  const foodsEl = h('section', { class: 'cl-foods panel', 'aria-labelledby': 'cl-foods-title' });
  let foodsLimit = FOODS_STEP;

  function paintFoods(s) {
    const list = s.foods;
    const focusId = document.activeElement?.closest?.('.cl-food')?.dataset.id;
    foodsEl.replaceChildren(
      h('h2', { class: 'cl-side-title', id: 'cl-foods-title' }, icon('list', { size: 15 }), h('span', null, 'Your foods')),
      list.length
        ? h(
            'ul',
            { class: 'cl-food-list' },
            list.slice(0, foodsLimit).map((f) =>
              h(
                'li',
                { class: 'cl-food', dataset: { id: f.id } },
                h('span', { class: 'cl-food-name' }, f.name),
                h('span', { class: 'cl-food-sub tnum' }, `${kcal(f.kcal)}${f.protein != null ? ` · ${C.gramsText(f.protein)} protein` : ''}`),
                h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-food-add', title: `Add one serving of ${f.name}`, 'aria-label': `Add one serving of ${f.name}`, onClick: () => addSaved(f, { date: day, meal: add.meal() }) }, icon('plus', { size: 14 })),
                h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-food-del', title: `Forget ${f.name}`, 'aria-label': `Forget ${f.name}`, onClick: () => forgetFood(f.id) }, icon('x', { size: 14 })),
              ),
            ),
          )
        : h('p', { class: 'cl-foods-empty' }, 'Every food you log shows here, with its calories per serving, ready to add again.'),
      ...(list.length > foodsLimit ? [h('button', { type: 'button', class: 'btn btn--sm btn--ghost cl-foods-more', onClick: () => ((foodsLimit += FOODS_STEP * 4), paintFoods(getState())) }, `Show all ${list.length}`)] : []),
    );
    if (focusId) foodsEl.querySelector(`.cl-food[data-id="${CSS.escape(focusId)}"] button`)?.focus({ preventScroll: true });
  }

  const body = h('div', { class: 'cl-body' }, h('div', { class: 'cl-main' }, dayPanel, add.el, mealsEl), h('div', { class: 'cl-side' }, weekEl, foodsEl));
  root.append(header, body);

  function render() {
    const s = getState();
    const today = todayKey();
    // The day open is the store's (this device's): another window, or midnight, moves it too
    day = openDay(today);
    header.setStat(C.statusText(s, today));
    paintDay(s, today);
    add.update(s, day);
    paintMeals(s);
    paintWeek(s, today);
    paintFoods(s);
  }

  /* ---- Right-click (or a long press) on a food eaten: Edit…, Duplicate, Delete ---- */
  cleanups.push(
    registerContextProvider('calories', (el) => {
      if (!mealsEl.contains(el)) return null;
      const rowEl = el.closest('.cl-row[data-id]');
      const entry = rowEl ? getState().entries.find((e) => e.id === rowEl.dataset.id) : null;
      if (!entry) return null;
      return {
        kind: 'food',
        id: entry.id,
        label: `${foodWords(entry)}: ${kcal(entry.kcal)}`,
        el: rowEl,
        edit: () => openEntryEditor(entry.id),
        duplicate: () => repeat(entry.id),
        remove: () => deleteEntry(entry.id),
        can: { copy: false, paste: false },
      };
    }),
  );

  // N: the food field · [ and ]: the day before / after
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || menuOpen() || e.defaultPrevented) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      add.focus();
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

  render();
  cleanups.push(store.subscribe(render));
  // Midnight: a page left on today moves on to the new today
  cleanups.push(onDayChange(render));
  if (pendingFocus) {
    pendingFocus = false;
    setTimeout(() => add.focus(), 0);
  }
  return () => cleanups.forEach((off) => off());
}

/* ==========================================================================
   The add line: food (your saved foods drop down as you type), calories and protein per serving,
   servings, meal, Add. Under it, your latest foods as one-tap chips.
   ========================================================================== */

let addSeq = 0;

function addLine({ dayNow }) {
  const n = ++addSeq;
  const fid = (k) => `cl-add-${n}-${k}`;
  const listId = fid('list');
  let mealPicked = null; // a meal chosen by hand stays until the day changes
  let shownDay = null;
  let options = [];
  let active = -1;

  const nameIn = h('input', {
    id: fid('name'),
    class: 'input cl-add-name',
    type: 'text',
    maxlength: String(C.NAME_MAX),
    placeholder: 'Oats with milk',
    autocomplete: 'off',
    enterkeyhint: 'next',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
  });
  const kcalIn = h('input', { id: fid('kcal'), class: 'input cl-add-num', type: 'text', inputmode: 'decimal', placeholder: '350', autocomplete: 'off', enterkeyhint: 'done' });
  const proteinIn = h('input', { id: fid('protein'), class: 'input cl-add-num', type: 'text', inputmode: 'decimal', placeholder: '–', autocomplete: 'off', enterkeyhint: 'done' });
  const servingsIn = h('input', { id: fid('servings'), class: 'input cl-add-num cl-add-servings', type: 'text', inputmode: 'decimal', placeholder: '1', autocomplete: 'off', enterkeyhint: 'done' });
  const mealIn = mealSelect(fid('meal'), C.mealAt(new Date().getHours()));
  mealIn.addEventListener('change', () => (mealPicked = mealIn.value));
  const listEl = h('ul', { class: 'cl-sugg', id: listId, role: 'listbox', 'aria-label': 'Your foods', hidden: true });
  const err = h('p', { class: 'cl-add-error', role: 'alert', hidden: true });
  const chipsEl = h('div', { class: 'cl-chips', role: 'group', 'aria-label': 'Add again in one tap' });
  const addBtn = h('button', { type: 'submit', class: 'btn btn--primary cl-add-btn' }, icon('plus', { size: 14 }), h('span', null, 'Add'));

  function closeList() {
    listEl.hidden = true;
    options = [];
    active = -1;
    nameIn.setAttribute('aria-expanded', 'false');
    nameIn.removeAttribute('aria-activedescendant');
  }

  function paintList() {
    listEl.replaceChildren(
      ...options.map((f, i) =>
        h(
          'li',
          {
            id: `${listId}-${i}`,
            class: 'cl-sugg-opt',
            role: 'option',
            'aria-selected': String(i === active),
            onMousedown: (e) => e.preventDefault(),
            onClick: () => pick(f),
          },
          h('span', { class: 'cl-sugg-name' }, f.name),
          h('span', { class: 'cl-sugg-sub tnum' }, `${kcal(f.kcal)}${f.protein != null ? ` · ${C.gramsText(f.protein)}` : ''}`),
        ),
      ),
    );
    listEl.hidden = !options.length;
    nameIn.setAttribute('aria-expanded', String(!!options.length));
    if (active >= 0) nameIn.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else nameIn.removeAttribute('aria-activedescendant');
  }

  /** A saved food into the fields (per serving): the servings field next, Enter adds. */
  function pick(f) {
    nameIn.value = f.name;
    kcalIn.value = String(f.kcal);
    proteinIn.value = f.protein == null ? '' : String(f.protein);
    servingsIn.value = '';
    closeList();
    clearError();
    servingsIn.focus();
  }

  nameIn.addEventListener('input', () => {
    clearError();
    options = C.matchFoods(getState().foods, nameIn.value);
    // A name typed exactly as a saved food: it's lit, Enter takes it
    active = options.length && C.fold(options[0].name) === C.fold(nameIn.value) ? 0 : -1;
    paintList();
  });
  nameIn.addEventListener('blur', () => setTimeout(closeList, 120));
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && options.length) {
      e.preventDefault();
      active = (active + 1) % options.length;
      paintList();
    } else if (e.key === 'ArrowUp' && options.length) {
      e.preventDefault();
      active = active <= 0 ? options.length - 1 : active - 1;
      paintList();
    } else if (e.key === 'Escape' && !listEl.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeList();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      if (active >= 0 && options[active]) pick(options[active]);
      else if (kcalIn.value.trim()) submit();
      else kcalIn.focus();
    }
  });

  function clearError() {
    err.hidden = true;
    [nameIn, kcalIn, proteinIn, servingsIn].forEach((x) => x.removeAttribute('aria-invalid'));
  }

  function submit() {
    clearError();
    const date = dayNow();
    const meal = mealIn.value;
    const res = C.logFood(getState(), { name: nameIn.value, kcal: kcalIn.value, protein: proteinIn.value, servings: servingsIn.value }, { date, meal, now: Date.now(), makeId: uid });
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      const f = { kcal: kcalIn, protein: proteinIn, servings: servingsIn }[res.field] ?? kcalIn;
      f.setAttribute('aria-invalid', 'true');
      f.focus();
      return;
    }
    commit(res.state);
    dismissTip(TIP_ID);
    const e = res.entry;
    toast(`${foodWords(e)} added to ${C.mealLabel(e.meal)}${date === todayKey() ? '' : ` on ${formatDay(date)}`}: ${kcal(e.kcal)}.`, {
      key: 'cl-entry',
      action: { label: 'Undo', onClick: () => commit(C.removeEntry(getState(), e.id)) },
    });
    nameIn.value = '';
    kcalIn.value = '';
    proteinIn.value = '';
    servingsIn.value = '';
    closeList();
    nameIn.focus();
  }

  const el = h(
    'form',
    {
      class: 'panel cl-add',
      'aria-label': 'Log a food',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        submit();
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input:not(.cl-add-name)')) {
          e.preventDefault();
          submit();
        }
      },
    },
    h(
      'div',
      { class: 'cl-add-grid' },
      h('div', { class: 'field cl-add-f-name' }, h('label', { class: 'label', for: nameIn.id }, 'Food'), h('div', { class: 'cl-combo' }, nameIn, listEl)),
      field('Calories', kcalIn, 'cl-add-f-num'),
      field('Protein (g)', proteinIn, 'cl-add-f-num'),
      field('Servings', servingsIn, 'cl-add-f-num'),
      field('Meal', mealIn, 'cl-add-f-meal'),
      addBtn,
    ),
    err,
    h('p', { class: 'cl-add-hint' }, 'Calories and protein are per serving; Servings multiplies them (2, 0.5). Type a few letters to pick a food you logged before.'),
    chipsEl,
  );

  function paintChips(s, date) {
    const recent = C.recentFoods(s.foods, 8);
    chipsEl.hidden = !recent.length;
    chipsEl.replaceChildren(
      ...recent.map((f) =>
        h(
          'button',
          { type: 'button', class: 'btn btn--sm cl-chip', title: `Add one serving of ${f.name} (${kcal(f.kcal)}) to ${C.mealLabel(mealIn.value)}`, onClick: () => addSaved(f, { date, meal: mealIn.value }) },
          icon('plus', { size: 13 }),
          h('span', null, f.name),
          h('span', { class: 'cl-chip-kcal tnum' }, C.kcalText(f.kcal)),
        ),
      ),
    );
  }

  return {
    el,
    /** The meal the next food goes into. */
    meal: () => mealIn.value,
    update(s, date) {
      // A new day open: the meal follows the clock on today, Dinner on another day, unless picked
      if (date !== shownDay) {
        shownDay = date;
        mealPicked = null;
      }
      if (!mealPicked) mealIn.value = date === todayKey() ? C.mealAt(new Date().getHours()) : 'dinner';
      paintChips(s, date);
    },
    /** The food field in focus; `meal`: that meal picked first (a meal's +). */
    focus(meal) {
      if (meal) {
        mealIn.value = meal;
        mealPicked = meal;
      }
      el.scrollIntoView?.({ block: 'nearest' });
      nameIn.focus();
    },
  };
}

/* ==========================================================================
   Dialogs: a food eaten · the goal
   ========================================================================== */

function openEntryEditor(id) {
  const e = getState().entries.find((x) => x.id === id);
  if (!e) return;
  const n = `cl-ed-${uid()}`;
  const per = (v) => (v == null ? '' : String(Math.round((v / e.servings) * 10) / 10));
  const nameIn = h('input', { id: `${n}-name`, class: 'input', type: 'text', value: e.name, maxlength: String(C.NAME_MAX), autocomplete: 'off' });
  const kcalIn = h('input', { id: `${n}-kcal`, class: 'input', type: 'text', inputmode: 'decimal', value: per(e.kcal), autocomplete: 'off' });
  const proteinIn = h('input', { id: `${n}-protein`, class: 'input', type: 'text', inputmode: 'decimal', value: per(e.protein), placeholder: '–', autocomplete: 'off' });
  const servingsIn = h('input', { id: `${n}-servings`, class: 'input', type: 'text', inputmode: 'decimal', value: String(e.servings), autocomplete: 'off' });
  const mealIn = mealSelect(`${n}-meal`, e.meal);
  const err = h('p', { class: 'cl-add-error', role: 'alert', hidden: true });

  function save() {
    const before = getState().entries.find((x) => x.id === id);
    const res = C.editEntry(getState(), id, { name: nameIn.value, kcal: kcalIn.value, protein: proteinIn.value, servings: servingsIn.value, meal: mealIn.value }, { now: Date.now() });
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      ({ kcal: kcalIn, protein: proteinIn, servings: servingsIn }[res.field] ?? nameIn).focus();
      return;
    }
    commit(res.state);
    m.close();
    toast(`Saved: ${foodWords(res.entry)}, ${kcal(res.entry.kcal)}.`, {
      key: 'cl-entry',
      action: { label: 'Undo', onClick: () => before && commit(C.restoreEntry(C.removeEntry(getState(), id), before)) },
    });
  }

  const body = h(
    'div',
    {
      class: 'cl-ed',
      onKeydown: (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing && ev.target instanceof HTMLInputElement) {
          ev.preventDefault();
          save();
        }
      },
    },
    field('Food', nameIn),
    h('div', { class: 'cl-ed-grid' }, field('Calories a serving', kcalIn), field('Protein a serving (g)', proteinIn), field('Servings', servingsIn), field('Meal', mealIn)),
    err,
  );
  const footer = [
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--danger',
        onClick: () => {
          m.close();
          deleteEntry(id);
        },
      },
      icon('trash', { size: 14 }),
      'Delete',
    ),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), 'Save'),
  ];
  const m = openModal({ title: `${e.name} · ${formatDay(e.date)}`, body, footer, className: 'cl-modal', initialFocus: kcalIn });
}

function openGoalEditor() {
  const s = getState();
  const p = s.profile ?? { formula: null, age: null, heightCm: null, activity: 'moderate', plan: 'keep' };
  const n = `cl-goal-${uid()}`;
  const num = (id, value, placeholder) => h('input', { id: `${n}-${id}`, class: 'input', type: 'text', inputmode: 'decimal', value: value == null ? '' : String(value), placeholder, autocomplete: 'off' });
  const kcalIn = num('kcal', s.goal.kcal, '2200');
  const proteinIn = num('protein', s.goal.protein, '140');
  const err = h('p', { class: 'cl-add-error', role: 'alert', hidden: true });

  // Work it out: the formula, age, height, weight (Health's latest), activity, the plan
  let formula = p.formula;
  const formulaBtns = C.FORMULAS.map((f) =>
    h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(f.id === formula), dataset: { value: f.id }, onClick: () => ((formula = f.id), formulaBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === formula)))) }, f.label),
  );
  const formulaSeg = h('div', { class: 'seg cl-formula', role: 'group', 'aria-label': 'Formula for' }, formulaBtns);
  const ageIn = num('age', p.age, '30');
  const heightIn = num('height', p.heightCm, '178');
  const kg = latestKg();
  const weightIn = num('weight', kg == null ? null : Math.round(kg * 10) / 10, '75');
  const activityIn = h('select', { id: `${n}-activity`, class: 'select' }, C.ACTIVITY.map((a) => h('option', { value: a.id, selected: a.id === p.activity }, a.label)));
  const planIn = h('select', { id: `${n}-plan`, class: 'select' }, C.PLANS.map((x) => h('option', { value: x.id, selected: x.id === p.plan }, x.label)));
  const result = h('p', { class: 'cl-calc-result', role: 'status' });
  const profile = () => ({ formula, age: C.parseAmount(ageIn.value), heightCm: C.parseAmount(heightIn.value), activity: activityIn.value, plan: planIn.value });

  function workOut() {
    err.hidden = true;
    const pr = profile();
    const res = C.estimateGoal({ ...pr, kg: C.parseAmount(weightIn.value) });
    if (res.error) {
      result.textContent = res.error;
      ({ age: ageIn, height: heightIn, weight: weightIn }[res.field] ?? formulaBtns[0]).focus();
      return;
    }
    kcalIn.value = String(res.kcal);
    proteinIn.value = String(res.protein);
    const plan = C.PLANS.find((x) => x.id === pr.plan);
    result.textContent = `About ${kcal(res.maintenance)} a day keeps your weight. ${plan.id === 'keep' ? 'Goal' : `${plan.label}:`} ${kcal(res.kcal)} and ${C.gramsText(res.protein)} protein, filled in above. An estimate to start from, not medical advice: adjust it after a couple of weeks.`;
  }

  function save() {
    err.hidden = true;
    const k = kcalIn.value.trim() ? C.parseAmount(kcalIn.value) : null;
    const pr = proteinIn.value.trim() ? C.parseAmount(proteinIn.value) : null;
    if (kcalIn.value.trim() && (k == null || k < C.GOAL_KCAL_MIN || k > C.GOAL_KCAL_MAX)) {
      err.textContent = `Calories a day: a number from ${C.GOAL_KCAL_MIN} to ${C.kcalText(C.GOAL_KCAL_MAX)}.`;
      err.hidden = false;
      kcalIn.focus();
      return;
    }
    if (proteinIn.value.trim() && (pr == null || pr < 1 || pr > C.GOAL_PROTEIN_MAX)) {
      err.textContent = `Protein a day: a number of grams from 1 to ${C.GOAL_PROTEIN_MAX}.`;
      err.hidden = false;
      proteinIn.focus();
      return;
    }
    const cur = getState();
    const pf = profile();
    const keepProfile = pf.formula || pf.age || pf.heightCm;
    commit({ ...cur, goal: C.normalizeGoal({ kcal: k, protein: pr }), profile: keepProfile ? C.normalizeProfile(pf) : cur.profile });
    m.close();
    toast(k ? `Goal: ${kcal(k)} a day${pr ? ` and ${C.gramsText(pr)} protein` : ''}.` : 'No calorie goal now.');
  }

  const body = h(
    'div',
    {
      class: 'cl-goal',
      onKeydown: (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing && ev.target instanceof HTMLInputElement) {
          ev.preventDefault();
          if (ev.target === ageIn || ev.target === heightIn || ev.target === weightIn) workOut();
          else save();
        }
      },
    },
    h('div', { class: 'cl-ed-grid' }, field('Calories a day', kcalIn), field('Protein a day (g, if you like)', proteinIn)),
    err,
    h(
      'fieldset',
      { class: 'cl-calc' },
      h('legend', { class: 'cl-calc-title' }, 'Not sure? Work it out'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Formula for'), formulaSeg),
      h('div', { class: 'cl-ed-grid cl-ed-grid--3' }, field('Age', ageIn), field('Height (cm)', heightIn), field(kg == null ? 'Weight (kg)' : 'Weight (kg, from Health)', weightIn)),
      h('div', { class: 'cl-ed-grid' }, field('How active you are', activityIn), field('Your plan', planIn)),
      h('button', { type: 'button', class: 'btn cl-calc-btn', onClick: workOut }, icon('zap', { size: 14 }), 'Work it out'),
      result,
    ),
  );
  const footer = [
    s.goal.kcal || s.goal.protein
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost',
            onClick: () => {
              const before = getState().goal;
              commit({ ...getState(), goal: C.normalizeGoal(null) });
              m.close();
              toast('Goal cleared.', { action: { label: 'Undo', onClick: () => commit({ ...getState(), goal: before }) } });
            },
          },
          icon('x', { size: 14 }),
          'Clear goal',
        )
      : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), 'Save'),
  ].filter(Boolean);
  const m = openModal({ title: 'Your daily goal', body, footer, className: 'cl-modal', initialFocus: kcalIn });
}

/* ==========================================================================
   Feature
   ========================================================================== */

/** For Search (⌘K) and Home: today's numbers, and the way in. */
export const caloriesApi = Object.freeze({
  state: () => getState(),
  subscribe: (fn) => store.subscribe(fn),
  /** The Calories page on today, the food field in focus. */
  focusAdd: () => {
    setOpenDay(todayKey());
    const field = document.querySelector('#main > .view[data-feature="calories"] .cl-add-name');
    if (field) {
      field.scrollIntoView?.({ block: 'nearest' });
      field.focus();
      return;
    }
    pendingFocus = true;
    location.hash = '#/calories';
  },
});

export default {
  id: 'calories',
  title: 'Calories',
  icon: 'apple',
  mount,
};
