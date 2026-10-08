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
    { id: 'hud', name: 'Mission Control', description: 'The grayscale HUD: blueprint grid, readouts, zero-padded counters.' },
    { id: 'brutalist', name: 'Brutalist', description: 'Loud black-and-white blocks, hard shadows, hazard-yellow accent.' },
    { id: 'terminal', name: 'Terminal', description: 'A retro computer terminal in phosphor green, all monospace.' },
    { id: 'oldmoney', name: 'Old Money', description: 'Ivory paper and navy ink, Bodoni titles, a galloping horse. Quiet and elegant.', plain: true },
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
 * What the page needs before its first paint, per skin: the Google Fonts stylesheet (only the
 * active skin's loads; the picker loads the others for its previews) and the title-bar color
 * for dark and light. index.html's head script holds the same object as SKIN_BOOT:
 * change both together (tools/tests/skins.test.js fails when they differ). After boot the shell
 * takes the title-bar color from the skin's computed --bg, so these colors only cover first paint.
 */
export const SKIN_BOOT = Object.freeze({
  simple: Object.freeze({
    font: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    dark: '#111111',
    light: '#f7f7f5',
  }),
  hud: Object.freeze({
    font: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap',
    dark: '#060606',
    light: '#f4f4f4',
  }),
  brutalist: Object.freeze({
    font: 'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap',
    dark: '#000000',
    light: '#ffffff',
  }),
  terminal: Object.freeze({
    font: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=VT323&display=swap',
    dark: '#050a05',
    light: '#e9f2e1',
  }),
  oldmoney: Object.freeze({
    font: 'https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..700;1,6..96,400..700&family=EB+Garamond:ital,wght@0,400..700;1,400..700&family=Montserrat:wght@400;500;600&family=Pinyon+Script&display=swap',
    dark: '#0f1621',
    light: '#f3efe6',
  }),
});

/**
 * Number style per skin. padIndex: position labels ("03" vs "3"), via ui.idx().
 * padCount: counts in readouts ("07 notes" vs "7 notes"), via ui.num().
 */
export const SKIN_NUMBERS = Object.freeze({
  simple: Object.freeze({ padIndex: false, padCount: false }),
  hud: Object.freeze({ padIndex: true, padCount: true }),
  brutalist: Object.freeze({ padIndex: true, padCount: true }),
  terminal: Object.freeze({ padIndex: true, padCount: true }),
  oldmoney: Object.freeze({ padIndex: false, padCount: false }),
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
 * Skin-specific wording. ui.term(key, fallback) returns TERMS[activeSkin][key] when present,
 * otherwise the fallback (the wording every other skin keeps). Keys are '<area>.<thing>'.
 * Add entries here; never rely on a key existing (the fallback is always passed).
 */
export const TERMS = Object.freeze({
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
    'habits.subtitle': 'Small things you do on chosen days. Tick them off as you go.',
    'habits.section': 'Your habits',
    'habits.allDone': 'All habits done for today. Nice work!',
    'habits.nameRequired': 'Give your habit a name.',
    'habits.starter': 'Or start with one of these',
    'habits.step2': 'Tick off',
    'habits.step3': 'Keep going',
    'habits.step3.text': 'Each day you tick a habit off, its streak grows by one.',
    'habits.empty.title': 'No habits yet',
    'habits.empty.archived': 'All habits are archived',
    'habits.empty.text': 'A habit is something small you do on chosen days, like a walk or reading. Tick it off when it is done and LIFE/OS keeps your streak.',
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
