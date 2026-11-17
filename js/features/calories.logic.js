// LIFE/OS — Calories, the pure parts: what you ate each day (calories and, if you like, protein),
// by meal, against a daily goal; the foods you log are remembered so the next time is one tap; and
// a daily goal worked out from your body and how active you are (Mifflin-St Jeor), as an estimate.
// No DOM or storage, so tools/tests/calories.test.js runs them in JavaScriptCore.
//
// Store 'calories':
//   { goal: { kcal, protein }, profile: { formula, age, heightCm, activity, plan } | null,
//     entries: [{ id, date, meal, name, servings, kcal, protein, createdAt, updatedAt }],
//     foods: [{ id, name, kcal, protein, uses, lastUsed }], view: { day } }
// - an entry's kcal and protein are what was eaten (servings × the food's values per serving)
// - foods: one per name (any case), their values per serving, the latest logged
// - view.day: the day open on this device (null: today); it doesn't sync

export const MEALS = Object.freeze([
  Object.freeze({ id: 'breakfast', label: 'Breakfast' }),
  Object.freeze({ id: 'lunch', label: 'Lunch' }),
  Object.freeze({ id: 'dinner', label: 'Dinner' }),
  Object.freeze({ id: 'snack', label: 'Snacks' }),
]);
const MEAL_IDS = MEALS.map((m) => m.id);

export const NAME_MAX = 80;
export const KCAL_MAX = 10_000;
export const PROTEIN_MAX = 1_000;
export const SERVINGS_MAX = 50;
export const GOAL_KCAL_MIN = 800;
export const GOAL_KCAL_MAX = 8_000;
export const GOAL_PROTEIN_MAX = 500;
export const FOODS_MAX = 500;

export const ACTIVITY = Object.freeze([
  Object.freeze({ id: 'low', label: 'Little or no exercise', factor: 1.2 }),
  Object.freeze({ id: 'light', label: 'Light: exercise 1–3 days a week', factor: 1.375 }),
  Object.freeze({ id: 'moderate', label: 'Moderate: 3–5 days a week', factor: 1.55 }),
  Object.freeze({ id: 'high', label: 'Hard: 6–7 days a week', factor: 1.725 }),
  Object.freeze({ id: 'very', label: 'Very hard: twice a day, or a physical job', factor: 1.9 }),
]);

export const PLANS = Object.freeze([
  Object.freeze({ id: 'lose', label: 'Lose weight', delta: -500 }),
  Object.freeze({ id: 'keep', label: 'Keep my weight', delta: 0 }),
  Object.freeze({ id: 'gain', label: 'Gain (build muscle)', delta: 300 }),
]);

/** The two versions of the formula (it has one for each). */
export const FORMULAS = Object.freeze([
  Object.freeze({ id: 'female', label: 'Female' }),
  Object.freeze({ id: 'male', label: 'Male' }),
]);

export const DEFAULT_VIEW = Object.freeze({ day: null });
export const DEFAULT_STATE = Object.freeze({
  goal: Object.freeze({ kcal: null, protein: null }),
  profile: null,
  entries: Object.freeze([]),
  foods: Object.freeze([]),
  view: DEFAULT_VIEW,
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (v) => (Number.isFinite(v) ? v : 0);
const round1 = (n) => Math.round(n * 10) / 10;
const inRange = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;

export function isDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A number typed by hand ('450', '12,5', ' 3 ') -> the number, or null (empty or not a number). */
export function parseAmount(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (!t || !/^\d*\.?\d+$/.test(t)) return null;
  return Number(t);
}

/** Lowercase, without accents and extra spaces: how two foods' names are compared. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const cleanName = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

/** The meal for a time of day: before 11 breakfast, before 15 lunch, 17–21 dinner, else a snack. */
export function mealAt(hour) {
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 17 && hour < 22) return 'dinner';
  return 'snack';
}

export const mealLabel = (id) => MEALS.find((m) => m.id === id)?.label ?? 'Snacks';

/* ---- Normalizing ---- */

export function normalizeEntry(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || !isDay(raw.date)) return null;
  const kcal = Number.isFinite(raw.kcal) ? Math.round(raw.kcal) : null;
  if (kcal == null || kcal < 0 || kcal > KCAL_MAX * SERVINGS_MAX) return null;
  const protein = Number.isFinite(raw.protein) && raw.protein >= 0 ? round1(Math.min(raw.protein, PROTEIN_MAX * SERVINGS_MAX)) : null;
  const servings = inRange(raw.servings, 0.01, SERVINGS_MAX) ? round1(raw.servings) || 1 : 1;
  const createdAt = time(raw.createdAt) || time(raw.updatedAt);
  return {
    id: raw.id,
    date: raw.date,
    meal: MEAL_IDS.includes(raw.meal) ? raw.meal : 'snack',
    name: cleanName(raw.name) || 'Food',
    servings,
    kcal,
    protein,
    createdAt,
    updatedAt: Math.max(time(raw.updatedAt), createdAt),
  };
}

export function normalizeFood(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const name = cleanName(raw.name);
  const kcal = Number.isFinite(raw.kcal) ? Math.round(raw.kcal) : null;
  if (!name || kcal == null || kcal < 0 || kcal > KCAL_MAX) return null;
  return {
    id: raw.id,
    name,
    kcal,
    protein: Number.isFinite(raw.protein) && raw.protein >= 0 ? round1(Math.min(raw.protein, PROTEIN_MAX)) : null,
    uses: Number.isInteger(raw.uses) && raw.uses > 0 ? raw.uses : 1,
    lastUsed: time(raw.lastUsed),
  };
}

export function normalizeGoal(raw) {
  const src = isObject(raw) ? raw : {};
  return {
    kcal: inRange(src.kcal, GOAL_KCAL_MIN, GOAL_KCAL_MAX) ? Math.round(src.kcal) : null,
    protein: inRange(src.protein, 1, GOAL_PROTEIN_MAX) ? Math.round(src.protein) : null,
  };
}

export function normalizeProfile(raw) {
  if (!isObject(raw)) return null;
  return {
    formula: FORMULAS.some((f) => f.id === raw.formula) ? raw.formula : null,
    age: inRange(raw.age, 14, 110) ? Math.round(raw.age) : null,
    heightCm: inRange(raw.heightCm, 100, 250) ? Math.round(raw.heightCm) : null,
    activity: ACTIVITY.some((a) => a.id === raw.activity) ? raw.activity : 'moderate',
    plan: PLANS.some((p) => p.id === raw.plan) ? raw.plan : 'keep',
  };
}

const byDayThenMeal = (a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : MEAL_IDS.indexOf(a.meal) - MEAL_IDS.indexOf(b.meal) || a.createdAt - b.createdAt);

export function normalizeState(raw) {
  const src = isObject(raw) ? raw : {};
  const seen = new Set();
  const entries = (Array.isArray(src.entries) ? src.entries : [])
    .map(normalizeEntry)
    .filter((e) => e && !seen.has(e.id) && seen.add(e.id))
    .sort(byDayThenMeal);
  // One food a name: the one used last wins
  const byName = new Map();
  for (const f of (Array.isArray(src.foods) ? src.foods : []).map(normalizeFood).filter(Boolean)) {
    const key = fold(f.name);
    const had = byName.get(key);
    if (!had || f.lastUsed > had.lastUsed) byName.set(key, had ? { ...f, uses: f.uses + had.uses } : f);
  }
  const foods = [...byName.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, FOODS_MAX);
  return {
    ...src,
    goal: normalizeGoal(src.goal),
    profile: normalizeProfile(src.profile),
    entries,
    foods,
    view: { day: isObject(src.view) && isDay(src.view.day) ? src.view.day : null },
  };
}

/* ---- Logging ---- */

/**
 * Read what was typed in the add line (values per serving, then how many servings).
 * -> { name, servings, kcal, protein } (totals) or { error, field }
 */
export function readFood({ name = '', kcal = '', protein = '', servings = '' } = {}) {
  const per = parseAmount(kcal);
  if (per == null) return { error: String(kcal).trim() ? 'Calories: type a number, like 450.' : 'Type the calories first.', field: 'kcal' };
  if (per > KCAL_MAX) return { error: `Calories: at most ${KCAL_MAX.toLocaleString('en')} a serving.`, field: 'kcal' };
  const p = String(protein).trim() ? parseAmount(protein) : null;
  if (String(protein).trim() && p == null) return { error: 'Protein: type a number of grams, like 30.', field: 'protein' };
  if (p != null && p > PROTEIN_MAX) return { error: `Protein: at most ${PROTEIN_MAX} g a serving.`, field: 'protein' };
  const n = String(servings).trim() ? parseAmount(servings) : 1;
  if (n == null || n <= 0 || n > SERVINGS_MAX) return { error: `Servings: a number from 0.1 to ${SERVINGS_MAX}, like 1 or 1.5.`, field: 'servings' };
  return { name: cleanName(name) || 'Food', servings: round1(n) || 1, kcal: Math.round(per * n), protein: p == null ? null : round1(p * n) };
}

/** The foods list with `food` (per serving) remembered: a known name is updated and moves up. */
export function rememberFood(foods, { name, kcal, protein }, { now, makeId }) {
  const clean = cleanName(name);
  if (!clean || clean === 'Food' || !Number.isFinite(kcal)) return foods;
  const key = fold(clean);
  const had = foods.find((f) => fold(f.name) === key);
  const food = had
    ? { ...had, name: clean, kcal: Math.round(kcal), protein: protein == null ? null : round1(protein), uses: had.uses + 1, lastUsed: now }
    : { id: makeId(), name: clean, kcal: Math.round(kcal), protein: protein == null ? null : round1(protein), uses: 1, lastUsed: now };
  return [food, ...foods.filter((f) => f !== had)].slice(0, FOODS_MAX);
}

/**
 * Add what was eaten to `date`'s `meal`. -> { state, entry } or { error, field }. The food is
 * remembered (per serving) for next time.
 */
export function logFood(state, input, { date, meal, now, makeId }) {
  if (!isDay(date)) return { error: 'Pick a day.', field: 'date' };
  const read = readFood(input);
  if (read.error) return read;
  const entry = { id: makeId(), date, meal: MEAL_IDS.includes(meal) ? meal : 'snack', name: read.name, servings: read.servings, kcal: read.kcal, protein: read.protein, createdAt: now, updatedAt: now };
  const perServing = { name: read.name, kcal: read.kcal / read.servings, protein: read.protein == null ? null : read.protein / read.servings };
  return {
    entry,
    state: { ...state, entries: [...state.entries, entry].sort(byDayThenMeal), foods: rememberFood(state.foods, perServing, { now, makeId }) },
  };
}

/** Change an entry (its name, values, servings or meal). -> { state, entry } or { error, field } */
export function editEntry(state, id, input, { now }) {
  const cur = state.entries.find((e) => e.id === id);
  if (!cur) return { error: 'That food is gone.', field: 'name' };
  const read = readFood(input);
  if (read.error) return read;
  const entry = { ...cur, name: read.name, servings: read.servings, kcal: read.kcal, protein: read.protein, meal: MEAL_IDS.includes(input.meal) ? input.meal : cur.meal, updatedAt: now };
  return { entry, state: { ...state, entries: state.entries.map((e) => (e.id === id ? entry : e)).sort(byDayThenMeal) } };
}

export function removeEntry(state, id) {
  return state.entries.some((e) => e.id === id) ? { ...state, entries: state.entries.filter((e) => e.id !== id) } : state;
}

/** Put a removed entry back (Undo). */
export function restoreEntry(state, entry) {
  const e = normalizeEntry(entry);
  if (!e || state.entries.some((x) => x.id === e.id)) return state;
  return { ...state, entries: [...state.entries, e].sort(byDayThenMeal) };
}

/** The same food again (another serving of it), now, on `date`. */
export function repeatEntry(state, id, { date, meal, now, makeId }) {
  const cur = state.entries.find((e) => e.id === id);
  if (!cur) return null;
  const entry = { ...cur, id: makeId(), date, meal: meal ?? cur.meal, createdAt: now, updatedAt: now };
  return { entry, state: { ...state, entries: [...state.entries, entry].sort(byDayThenMeal) } };
}

export function removeFood(state, id) {
  return state.foods.some((f) => f.id === id) ? { ...state, foods: state.foods.filter((f) => f.id !== id) } : state;
}

/* ---- Reading ---- */

/** A day's totals and its meals, in meal order (each with its foods and subtotals). */
export function dayTotals(entries, date) {
  const items = entries.filter((e) => e.date === date);
  const sum = (list, k) => list.reduce((n, e) => n + (e[k] ?? 0), 0);
  const meals = MEALS.map((m) => {
    const list = items.filter((e) => e.meal === m.id);
    return { id: m.id, label: m.label, items: list, kcal: sum(list, 'kcal'), protein: round1(sum(list, 'protein')) };
  });
  return { date, kcal: sum(items, 'kcal'), protein: round1(sum(items, 'protein')), count: items.length, hasProtein: items.some((e) => e.protein != null), meals };
}

/** Calories left today against the goal: positive left, negative over; null without a goal. */
export const kcalLeft = (goal, kcal) => (goal?.kcal ? goal.kcal - kcal : null);

/** The `n` days up to `today`, oldest first, each with its calories (0 when nothing was logged). */
export function lastDays(entries, today, n = 7) {
  if (!isDay(today)) return [];
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    const key = dt.toISOString().slice(0, 10);
    const t = dayTotals(entries, key);
    out.push({ date: key, kcal: t.kcal, protein: t.protein, logged: t.count > 0 });
  }
  return out;
}

/** The average of the days that have something logged, or null. */
export function averageKcal(days) {
  const logged = days.filter((d) => d.logged);
  return logged.length ? Math.round(logged.reduce((n, d) => n + d.kcal, 0) / logged.length) : null;
}

/** '1,450' */
export const kcalText = (n) => Math.round(n).toLocaleString('en');
/** '32 g', '12.5 g' */
export const gramsText = (n) => `${Number.isInteger(round1(n)) ? round1(n) : round1(n).toFixed(1)} g`;
/** '×2', '×1.5', '' for one */
export const servingsText = (n) => (n === 1 ? '' : `×${n}`);

/** The page's line beside the title: '' before anything is logged or a goal set. */
export function statusText(state, today) {
  const t = dayTotals(state.entries, today);
  const goal = state.goal.kcal;
  if (!t.count && !goal) return state.entries.length ? 'Nothing logged today yet' : '';
  if (!goal) return `${kcalText(t.kcal)} kcal today`;
  const left = goal - t.kcal;
  return left >= 0 ? `${kcalText(t.kcal)} of ${kcalText(goal)} kcal · ${kcalText(left)} left` : `${kcalText(t.kcal)} of ${kcalText(goal)} kcal · ${kcalText(-left)} over`;
}

/** Saved foods whose name holds every word of `query` (a name that starts with it first), most used first. */
export function matchFoods(foods, query, n = 6) {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(' ');
  return foods
    .filter((f) => {
      const name = fold(f.name);
      return words.every((w) => name.includes(w));
    })
    .map((f) => ({ f, starts: fold(f.name).startsWith(q) ? 1 : 0 }))
    .sort((a, b) => b.starts - a.starts || b.f.uses - a.f.uses || b.f.lastUsed - a.f.lastUsed)
    .slice(0, n)
    .map((x) => x.f);
}

/** The foods used last, for one-tap chips. */
export const recentFoods = (foods, n = 8) => [...foods].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, n);

/* ---- The goal, worked out (an estimate, not advice) ---- */

/**
 * Daily calories from Mifflin-St Jeor: resting energy × activity, then the plan (−500 to lose,
 * +300 to gain), rounded to 10 and never under 1,200. Protein: 1.6 g per kg of body weight (2 g
 * when gaining), rounded to 5. -> { kcal, protein, bmr, maintenance } or { error, field }
 */
export function estimateGoal({ formula, age, heightCm, kg, activity = 'moderate', plan = 'keep' }) {
  if (!FORMULAS.some((f) => f.id === formula)) return { error: 'Pick which formula to use.', field: 'formula' };
  if (!inRange(age, 14, 110)) return { error: 'Age: a number from 14 to 110.', field: 'age' };
  if (!inRange(heightCm, 100, 250)) return { error: 'Height: in centimetres, from 100 to 250.', field: 'height' };
  if (!inRange(kg, 30, 400)) return { error: 'Weight: in kilograms, from 30 to 400.', field: 'weight' };
  const factor = ACTIVITY.find((a) => a.id === activity)?.factor ?? 1.55;
  const delta = PLANS.find((p) => p.id === plan)?.delta ?? 0;
  const bmr = 10 * kg + 6.25 * heightCm - 5 * age + (formula === 'male' ? 5 : -161);
  const maintenance = Math.round((bmr * factor) / 10) * 10;
  const kcal = Math.max(1200, Math.round((bmr * factor + delta) / 10) * 10);
  const protein = Math.round((kg * (plan === 'gain' ? 2 : 1.6)) / 5) * 5;
  return { kcal, protein, bmr: Math.round(bmr), maintenance };
}
