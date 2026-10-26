// LIFE/OS — what the shell (js/app.js) offers pages that can't import it, since it imports them.
// app.js fills these in before the first page renders; pages read them when they mount.
// Also the shell's pure rules: the phone tab bar (normalizeTabs, toggleTab, moveTab, tabBarFit)
// and the first run (welcomeOnStart; PAGE_INTROS, the tab picker's line per page). No DOM, tested
// in tools/tests/shell.test.js.

export const shell = {
  version: '',
  /** The pages a person can start on (and pick for the tab bar): [{ id, title, icon }] in nav order. */
  pages: [],
  /** Opens the Appearance dialog (template, light / dark). */
  openAppearance() {},
  /** The newest deployed version ('v0.11'), or null when it can't be checked (offline). */
  async latestVersion() {
    return null;
  },
  /** 'checking' | 'persistent' | 'best-effort' | 'unsupported' */
  storageState: () => 'checking',
};

export function provideShell(services) {
  Object.assign(shell, services);
}

/* ---- The phone tab bar: the pages of your choice, then More ----
   settings.tabs (this device only, never synced) lists them in the bar's order: as many as you
   like, at least one. When they don't fit the width the bar scrolls sideways (tabBarFit), with
   More kept at its end. */

export const DEFAULT_TABS = Object.freeze(['home', 'tasks', 'calendar', 'habits']);

/**
 * The tab bar's pages: `value` (settings.tabs) kept to pages that exist (`pageIds`, the nav's
 * order), each once, in the order chosen. Nothing usable (never set, an old or broken value, every
 * page gone) gives the default four (those of them that exist).
 */
export function normalizeTabs(value, pageIds = DEFAULT_TABS) {
  const known = new Set(Array.isArray(pageIds) ? pageIds : []);
  const pick = (list) => {
    const out = [];
    for (const id of Array.isArray(list) ? list : []) {
      if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const chosen = pick(value);
  if (chosen.length) return chosen;
  const fallback = pick(DEFAULT_TABS);
  return fallback.length ? fallback : pick([...known]);
}

/**
 * Tick or untick page `id` in the tab bar (Edit tabs, the tours' tab picker). Ticking adds it at the
 * end; the last page can't be unticked (the bar keeps one).
 * -> { tabs, changed, reason: null | 'last' | 'unknown' }
 */
export function toggleTab(tabs, id, pageIds = DEFAULT_TABS) {
  const current = normalizeTabs(tabs, pageIds);
  if (!(Array.isArray(pageIds) ? pageIds : []).includes(id)) return { tabs: current, changed: false, reason: 'unknown' };
  if (current.includes(id)) {
    if (current.length === 1) return { tabs: current, changed: false, reason: 'last' };
    return { tabs: current.filter((x) => x !== id), changed: true, reason: null };
  }
  return { tabs: [...current, id], changed: true, reason: null };
}

/**
 * Move page `id` `by` places in the bar's order (-1 = one to the left / up in Edit tabs), stopping
 * at either end. -> { tabs, changed }
 */
export function moveTab(tabs, id, by, pageIds = DEFAULT_TABS) {
  const current = normalizeTabs(tabs, pageIds);
  const from = current.indexOf(id);
  const to = Math.max(0, Math.min(current.length - 1, from + Math.trunc(Number(by) || 0)));
  if (from < 0 || to === from) return { tabs: current, changed: false };
  const next = current.filter((x) => x !== id);
  next.splice(to, 0, id);
  return { tabs: next, changed: true };
}

/** Narrowest share at which the tabs still split the bar evenly, as before (px). */
export const TAB_FIT_W = 60;
/** Narrowest tab in a bar that scrolls (px): room for a page's name under its icon. */
export const TAB_MIN_W = 64;

/**
 * How the tab bar lays out `count` tabs (the pages plus More) across `width` px:
 * - each gets at least `fit`: one row of equal tabs -> { scroll: false, tab: width / count }
 * - else the pages scroll sideways and More stays at the end -> { scroll: true, tab }: tabs at
 *   least `min` wide, sized so that whole tabs plus half of the next one show beside More (the
 *   half tab says there is more), the most that fit.
 * The shell raises both to the widest name in the bar, so a template's wide capitals still fit.
 */
export function tabBarFit(width, count, { fit = TAB_FIT_W, min = TAB_MIN_W } = {}) {
  const w = Math.max(0, Number(width) || 0);
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (!w || w / n >= fit) return { scroll: false, tab: w / n };
  // w = tab × (k whole tabs + a half + More)
  const k = Math.max(1, Math.floor(w / min - 1.5));
  return { scroll: true, tab: w / (k + 1.5) };
}

/* ---- First run: the welcome sheet ----
   The first time LIFE/OS opens on a device with nothing saved, a sheet offers three ways in: No
   tutorial, Quick tutorial or Tutorial (js/welcome.js, the tours in js/tour.js).
   settings.welcomed (this device only) remembers that it was answered. */

/**
 * Each page in a line, for the tab picker (a step of the tours, js/welcome.js tabPicker): what it
 * is for, in plain words. A page without one shows only its name.
 */
export const PAGE_INTROS = Object.freeze({
  home: 'Today at a glance: to-dos, events, habits and a timer on one board you arrange.',
  tasks: 'To-dos with due dates, times and priorities, sorted into sections.',
  notes: 'Write notes and file them in sections, as a list or a board.',
  habits: 'Plan habits for chosen weekdays, tick them off and keep your streaks.',
  calendar: 'Your events by month, week or day, with your tasks and habits beside them.',
  pomodoro: 'A focus timer: work in rounds with short breaks, in view on every page.',
  training: 'Log workouts and routines, with a rest timer and your progress per exercise.',
  finance: 'Your subscriptions: what they cost a month and which payment is next.',
  recovery: 'Count the days you stay away from something, such as smoking or alcohol.',
});

/**
 * Whether this start opens the welcome sheet. `welcomed` is settings.welcomed: true once the sheet
 * was answered (one of its three choices, Esc or ✕), false while it was shown but not answered (it
 * shows again), unset before. `hadSavedData`: LIFE/OS had saved something on this device before this start, so it is
 * already in use: no sheet, and `mark` says to set welcomed now, so it never shows there.
 * -> { show, mark }
 */
export function welcomeOnStart(welcomed, hadSavedData) {
  if (welcomed === true) return { show: false, mark: false };
  if (welcomed === false) return { show: true, mark: false };
  return hadSavedData ? { show: false, mark: true } : { show: true, mark: false };
}
