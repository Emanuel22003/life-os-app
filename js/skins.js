// LIFE/OS — appearance templates ("skins"). Pure data and rules, no DOM, so tools/tests can
// import it. The shell applies the active skin (js/app.js), the picker shows all of them
// (js/appearance.js), and ui.js formats numbers and wording with it (idx, num, term).
//
// A skin is cosmetic only: the `data-skin` attribute on <html> (and on each picker preview),
// styled by css/skins/<id>.css. It never changes what is stored; settings.skin only remembers
// the choice. Mission Control ('hud') is the original look and has no skin file of its own.

export const DEFAULT_SKIN = 'simple';

export const SKINS = Object.freeze(
  [
    { id: 'simple', name: 'Simple', description: 'Calm and plain. Fewer numbers, everyday words. Easiest to start with.' },
    { id: 'minimal', name: 'Minimal', description: 'Only what matters: no boxes, no colors, no tips, lots of space. The least on the screen.', plain: true },
    { id: 'hud', name: 'Mission Control', description: 'The grayscale HUD: blueprint grid, readouts, zero-padded counters.' },
    { id: 'brutalist', name: 'Brutalist', description: 'Loud black-and-white blocks, hard shadows, hazard-yellow accent.' },
    { id: 'terminal', name: 'Terminal', description: 'A retro computer terminal in phosphor green, all monospace.' },
    { id: 'oldmoney', name: 'Old Money', description: 'Ivory paper, black ink and brass, Bodoni titles, an engraving-style horse.', plain: true },
    { id: 'coquette', name: 'Atelier', description: 'Editorial and warm: ivory and nude, a rosewood accent, serif titles, fine lines.', plain: true },
    { id: 'y2k', name: 'Pearl', description: 'Modern and calm: pearl and lilac grey, frosted glass, a thin iridescent accent.', plain: true },
  ].map((skin) => Object.freeze(skin)),
);

/**
 * Plain templates read like Simple: everyday words, no index numbers, kickers or shortcut tips
 * (base.css hides .lo-deco / .lo-hint for them). Old Money is Simple underneath, dressed up:
 * css/skins/simple.css styles both, css/skins/oldmoney.css adds its own look on top.
 */
export const PLAIN_SKINS = Object.freeze(['simple', ...SKINS.filter((s) => s.plain).map((s) => s.id)]);

export function isPlainSkin(id) {
  return PLAIN_SKINS.includes(normalizeSkin(id));
}

export const SKIN_IDS = Object.freeze(SKINS.map((s) => s.id));

/** Light or dark: settings.theme is 'dark' (the default), 'light' or 'system' (follow the computer). */
export const THEMES = Object.freeze(['light', 'dark', 'system']);

/** The mode to show: 'light' | 'dark'. prefersLight: the computer is in light mode. */
export function resolveTheme(theme, prefersLight = false) {
  if (theme === 'system') return prefersLight ? 'light' : 'dark';
  return theme === 'light' ? 'light' : 'dark';
}

/** Any stored value -> a known skin id (unknown, missing or malformed -> the default). */
export function normalizeSkin(value) {
  return typeof value === 'string' && SKIN_IDS.includes(value) ? value : DEFAULT_SKIN;
}

export function skinInfo(id) {
  return SKINS.find((s) => s.id === normalizeSkin(id));
}

/**
 * What the page needs before its first paint, per skin: its fonts stylesheet (only the active
 * skin's loads; the picker loads the others for its previews) and the title-bar color for dark
 * and light, and `plain` for the plain templates (data-plain goes on <html> with data-skin).
 * The fonts are the app's own files (fonts/<id>.css next to index.html, a relative URL so the
 * website's sub-folder works too): loading a template contacts only the server the app came
 * from, never Google or another third party, so no one else learns a visitor's address (see
 * README → Where your data lives).
 * index.html's head script holds the same object as SKIN_BOOT:
 * change both together (tools/tests/skins.test.js fails when they differ). After boot the shell
 * takes the title-bar color from the skin's computed --bg, so these colors only cover first paint.
 */
export const SKIN_BOOT = Object.freeze({
  simple: Object.freeze({
    font: 'fonts/simple.css',
    dark: '#111111',
    light: '#f7f7f5',
    plain: true,
  }),
  minimal: Object.freeze({
    font: 'fonts/minimal.css',
    dark: '#0d0d0d',
    light: '#ffffff',
    plain: true,
  }),
  hud: Object.freeze({
    font: 'fonts/hud.css',
    dark: '#060606',
    light: '#f4f4f4',
  }),
  brutalist: Object.freeze({
    font: 'fonts/brutalist.css',
    dark: '#000000',
    light: '#ffffff',
  }),
  terminal: Object.freeze({
    font: 'fonts/terminal.css',
    dark: '#050a05',
    light: '#e9f2e1',
  }),
  oldmoney: Object.freeze({
    font: 'fonts/oldmoney.css',
    dark: '#141311',
    light: '#f2eee5',
    plain: true,
  }),
  coquette: Object.freeze({
    font: 'fonts/coquette.css',
    dark: '#1e1714',
    light: '#f7f2ec',
    plain: true,
  }),
  y2k: Object.freeze({
    font: 'fonts/y2k.css',
    dark: '#15131f',
    light: '#f3f1f6',
    plain: true,
  }),
});

/**
 * Number style per skin. padIndex: position labels ("03" vs "3"), via ui.idx().
 * padCount: counts in readouts ("07 notes" vs "7 notes"), via ui.num().
 */
export const SKIN_NUMBERS = Object.freeze({
  simple: Object.freeze({ padIndex: false, padCount: false }),
  minimal: Object.freeze({ padIndex: false, padCount: false }),
  hud: Object.freeze({ padIndex: true, padCount: true }),
  brutalist: Object.freeze({ padIndex: true, padCount: true }),
  terminal: Object.freeze({ padIndex: true, padCount: true }),
  oldmoney: Object.freeze({ padIndex: false, padCount: false }),
  coquette: Object.freeze({ padIndex: false, padCount: false }),
  y2k: Object.freeze({ padIndex: false, padCount: false }),
});

function numberRules(skin) {
  return SKIN_NUMBERS[normalizeSkin(skin)];
}

/** formatIndex(3, 2, 'hud') -> '03'; formatIndex(3, 2, 'simple') -> '3' */
export function formatIndex(n, width = 2, skin = DEFAULT_SKIN) {
  const text = String(n);
  return numberRules(skin).padIndex ? text.padStart(width, '0') : text;
}

/** formatCount(7, 2, 'hud') -> '07'; formatCount(7, 2, 'simple') -> '7' */
export function formatCount(n, width = 2, skin = DEFAULT_SKIN) {
  const text = String(n);
  return numberRules(skin).padCount ? text.padStart(width, '0') : text;
}

/**
 * Mission Control's voice for the Habits page (Terminal speaks it too). The pages' own words are
 * plain (the fallback passed to term()), and so are these two's sentences: their voice is only in
 * the short labels (7D, ▲, pts). '{n}', '{name}', '{plan}' and '{range}' are filled in by the page
 * (habits.js, habits.plan.js, habits.insights.js).
 */
const HABITS_HUD = Object.freeze({
  'habits.subtitle': 'Plan each weekday. Check in daily. Track your streaks and LIFE index.',
  // The voice is in the labels (7D, ▲ 46 pts); every sentence stays plain English
  'habits.allDone.toast': 'All habits done. Perfect-day streak: {n}.',
  'habits.nameLabel': 'Name',
  'habits.nameRequired': 'Name required: give the habit a name.',
  'habits.added': '“{name}” added · {plan}.',
  'habits.starter': 'Or start with one of these',
  'habits.empty.title': 'No habits yet',
  'habits.empty.archived': 'All habits archived',
  'habits.empty.text': 'Habits are small actions you plan on chosen weekdays. Check them off daily and LIFE/OS tracks streaks, completion and your LIFE index.',
  'habits.range.7d': '7D',
  'habits.range.30d': '30D',
  'habits.range.90d': '90D',
  'habits.range.all': 'ALL',
  'habits.change.up': '▲',
  'habits.change.down': '▼',
  'habits.change.flat': '■',
  'habits.change.unit': 'pts',
  'habits.change.vs': 'vs prev {range}',
  'habits.change.vsAll': 'vs prev period',
  'habits.change.none': 'No data for the previous {range}',
});

/**
 * Skin-specific wording. ui.term(key, fallback) returns TERMS[activeSkin][key] when present,
 * otherwise the fallback (the wording every other skin keeps). Keys are '<area>.<thing>'.
 * Add entries here; never rely on a key existing (the fallback is always passed).
 */
export const TERMS = Object.freeze({
  hud: HABITS_HUD,
  terminal: HABITS_HUD,
  simple: Object.freeze({
    'shell.status': 'Saved on this device',
    'shell.nav': 'Menu',
    'tasks.priority': 'Priority',
    'tasks.priority.none': 'None',
    'tasks.priority.med': 'Medium',
    'tasks.sort.manual': 'My order',
    'tasks.sort.due': 'Due date',
    'tasks.parsed': 'Will set',
    'tasks.empty.upcoming': 'Tasks with a due date after today show up here.',
    'tasks.empty.first': 'Write down anything on your mind: type it in the box above and press Enter.',
    'notes.subtitle': 'Ideas, plans and lists. Everything saves as you type.',
    // Home's habits card (the Habits page's own words are plain already, see HABITS_HUD)
    'habits.allDone': 'All habits done for today. Nice work!',
    'calendar.subtitle': 'Your events, tasks and habits by month, week or day.',
    'pomodoro.subtitle': 'Work in focused blocks with short breaks in between. The timer keeps going while you use the rest of the app.',
    'calendar.addTask': 'Add a task for this day…',
    'calendar.sep': '·',
  }),
});

export function termFor(skin, key, fallback) {
  const id = normalizeSkin(skin);
  // A plain template without words of its own speaks Simple's
  const table = TERMS[id] ?? (isPlainSkin(id) ? TERMS.simple : null);
  return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback;
}
