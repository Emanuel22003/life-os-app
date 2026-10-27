// LIFE/OS — the guided tours: the pure parts. The step lists of the quick and the full tutorial
// (what each step says and which real control it points at), which steps a phone or a computer
// gets, chapters and progress, where to continue, and where the bubble goes on the screen. No
// DOM: tested in tools/tests/tour.test.js. js/tour.js draws the tours; js/welcome.js offers them.

export const TOUR_KINDS = Object.freeze(['quick', 'full']);

/* ---- The first-run choice (js/welcome.js): three ways in ---- */

export const WELCOME_CHOICES = Object.freeze(
  [
    { id: 'none', title: 'No tutorial', text: 'Straight in, no steps. The tours wait in More and Settings.', icon: 'wl-go' },
    { id: 'quick', title: 'Quick tutorial', text: 'The basics in 8 short steps, about a minute.', icon: 'wl-quick' },
    { id: 'full', title: 'Tutorial', text: 'Every page, step by step, about 10 minutes. Stop any time.', icon: 'wl-map' },
  ].map((c) => Object.freeze(c)),
);

/**
 * The three choices as the welcome shows them: the quick one counts its steps for this device (7
 * once a look was picked in the welcome, which leaves out its "Pick a look" step).
 */
export function welcomeChoices({ lookPicked = false } = {}) {
  const n = tourSteps('quick', { lookPicked }).length;
  return WELCOME_CHOICES.map((c) => (c.id === 'quick' ? { ...c, text: c.text.replace(/\d+ short steps/, `${n} short steps`) } : c));
}

/* ---- Steps ----
   A step: { id, chapter, page, target, title, text, missingText, only, ifMissing, picker, tryIt,
   advanceOn, place }
   - page: the page to open first ('tasks': #/tasks); none stays where you are.
   - target: what it points at: a selector, a list of them (the first one on screen wins), and a
     list item may be { sel, title, text } with its own words for that match. Any of these may be
     { phone, wide }: a phone (640px wide or less, the tab bar) and a computer (the sidebar) point
     at different controls. No target: the bubble sits in the middle, without a pointer.
   - title, text, missingText: words, or { phone, wide }. missingText is said when no target is on
     screen (the bubble is then centred). {search} and {undo} become ⌘K / Ctrl K, ⌘Z / Ctrl Z.
   - only: 'phone' | 'wide': the step is left out on the other kind of screen.
   - unlessLook: left out once a look was picked in the welcome (settings.lookPicked).
   - ifMissing: 'centre' (the default: centred, without a pointer) or 'skip' (left out).
   - picker: the tab picker (js/welcome.js tabPicker) goes in the bubble.
   - tryIt: a field the bubble's "Try it" puts the cursor in.
   - advanceOn: { store, list }: the step moves on by itself once that list grew (a task added).
     The tour only watches: it never adds, changes or deletes anything itself.
   - place: the side of the target the bubble prefers ('top', 'bottom', 'left', 'right'). */

export const CHAPTERS = Object.freeze(
  [
    { id: 'start', title: 'Getting started' },
    { id: 'home', title: 'Home' },
    { id: 'tasks', title: 'Tasks' },
    { id: 'notes', title: 'Notes' },
    { id: 'habits', title: 'Habits' },
    { id: 'calendar', title: 'Calendar' },
    { id: 'pomodoro', title: 'Pomodoro' },
    { id: 'training', title: 'Training' },
    { id: 'finance', title: 'Finance' },
    { id: 'recovery', title: 'Recovery' },
    { id: 'settings', title: 'Settings' },
    { id: 'end', title: 'Finish' },
  ].map((c) => Object.freeze(c)),
);

const ADD_TASK = { store: 'tasks', list: 'items' };

// The steps both tutorials share (the full one has them in its first chapter)
const PAGES = {
  id: 'pages',
  chapter: 'start',
  title: 'Move between pages',
  target: { wide: '.sidebar .nav', phone: '.tabbar' },
  text: {
    wide: 'The menu on the left lists every page. Click one to go there, or press its number, 1 to 9.',
    phone: 'The tab bar holds your main pages. More, at the right end, has the rest, plus Search and Settings.',
  },
  place: { wide: 'right', phone: 'top' },
};

const TABS = {
  id: 'tabs',
  chapter: 'start',
  picker: true,
  title: { wide: 'The tab bar on a phone', phone: 'Pick your tabs' },
  target: { phone: '.tabbar' },
  text: {
    wide: 'On a phone, or a window as narrow as one, a tab bar at the bottom takes the place of this menu. Tick the pages it shows; the rest wait in More.',
    phone: 'Tick the pages you use most. The bar changes as you tick; the rest stay one tap away in More.',
  },
  place: { phone: 'top' },
};

const SEARCH = {
  id: 'search',
  chapter: 'start',
  title: 'Search for anything',
  target: { wide: '.sidebar-search', phone: '.tab--more' },
  text: {
    wide: 'Search finds tasks, notes, events, habits and pages, and takes you there. Press {search} on any page.',
    phone: 'Search finds tasks, notes, events, habits and pages, and takes you there. It’s the first thing in More.',
  },
  place: { wide: 'right', phone: 'top' },
};

const QUICK = [
  {
    id: 'hello',
    chapter: 'start',
    title: 'Welcome to LIFE/OS',
    text: 'Your day in one place: tasks, notes, habits, a calendar, a focus timer and more. This short tour points at the real buttons and changes nothing by itself.',
  },
  PAGES,
  TABS,
  {
    id: 'home',
    chapter: 'start',
    page: 'home',
    title: 'Home at a glance',
    target: [
      { sel: '.hm-start:not([hidden])', text: 'Home opens first. On a new device, Start here lists three first steps and ticks each one off by itself.' },
      { sel: '.hm-glance:not([hidden])', text: 'Home opens first: today’s events, tasks, habits and the timer, each as one number. Tap one to open its page.' },
      '.hm-board',
    ],
    text: 'Home opens first: today’s tasks, events, habits and the timer, on cards you arrange yourself.',
  },
  {
    id: 'task',
    chapter: 'start',
    page: 'home',
    title: 'Add your first task',
    target: '.hm-add',
    tryIt: '.hm-add-input',
    text: 'Type a task here and press Enter. Add !h to make it high priority. Try it, or press Next.',
    missingText: 'Type a task in To do on Home, or on the Tasks page, and press Enter.',
    advanceOn: ADD_TASK,
  },
  SEARCH,
  {
    id: 'look',
    chapter: 'start',
    // (picked in the welcome already: nothing to ask)
    unlessLook: true,
    title: 'Pick a look',
    target: { wide: '.appearance-row', phone: '.tab--more' },
    text: {
      wide: 'Appearance has eight looks, light or dark, and your own colors. Try one: it changes how LIFE/OS looks, nothing else.',
      phone: 'More → Appearance has eight looks, light or dark, and your own colors. It changes how LIFE/OS looks, nothing else.',
    },
    place: { wide: 'right', phone: 'top' },
  },
  {
    id: 'again',
    chapter: 'start',
    title: 'That’s the basics',
    target: { wide: '.settings-btn', phone: '.tab--more' },
    text: {
      wide: 'Take this tour again, or the full one with every page, in Settings → About → Tutorial.',
      phone: 'Take this tour again, or the full one with every page, in More → Quick tutorial or Tutorial.',
    },
    place: { wide: 'right', phone: 'top' },
  },
];

const FULL = [
  /* Getting started */
  {
    id: 'hello',
    chapter: 'start',
    title: 'Welcome to LIFE/OS',
    text: 'This tour visits every page, a few steps each, about 10 minutes. It points at the real buttons and changes nothing by itself. Leave whenever you like: it remembers where you were.',
  },
  PAGES,
  TABS,
  SEARCH,

  /* Home */
  {
    id: 'home-today',
    chapter: 'home',
    page: 'home',
    title: 'Today at a glance',
    target: [
      { sel: '.hm-glance:not([hidden])', text: 'The Today strip: events, tasks, habits and the timer, each as one number. Tap one to open its page.' },
      { sel: '.hm-start:not([hidden])', text: 'On a new device, Start here lists three first steps. Each one ticks itself off once it’s done.' },
    ],
    text: 'Home opens first and shows today at a glance: events, tasks, habits and the timer.',
  },
  {
    id: 'home-cards',
    chapter: 'home',
    page: 'home',
    title: 'Your cards',
    // (a phone stacks the cards taller than the screen: the first one's title row)
    target: { wide: '.hm-board', phone: '.hm-board > .hm-widget .hm-card-head' },
    text: 'Cards for your to-dos, the calendar, habits, the timer and a quick note. Each one opens its own page.',
  },
  {
    id: 'home-customize',
    chapter: 'home',
    page: 'home',
    title: 'Make Home yours',
    target: '.hm-customize',
    text: 'Customize lets you add, remove, resize and move the cards. Press Done when you’re happy.',
  },

  /* Tasks */
  {
    id: 'tasks-add',
    chapter: 'tasks',
    page: 'tasks',
    title: 'Add a task',
    target: '.tk-command',
    tryIt: '.tk-add-input',
    text: 'Type a task and press Enter. Then pick its priority, when it’s due and its section, one step at a time. Try it, or press Next.',
    advanceOn: ADD_TASK,
  },
  {
    id: 'tasks-order',
    chapter: 'tasks',
    page: 'tasks',
    title: 'Smart order',
    target: '.tk-sort-dd-btn',
    text: 'Tasks sort themselves: late ones first, then today, upcoming and no date. Sort switches to your own order, the due date or priority.',
    missingText: 'Tasks sort themselves: late ones first, then today, upcoming and no date. Once you have tasks, Sort offers your own order too.',
  },
  {
    id: 'tasks-open',
    chapter: 'tasks',
    page: 'tasks',
    title: 'A task’s page',
    target: '.tk-row',
    text: {
      wide: 'Click a task to open its page for notes, checklists and pictures; the pencil opens its details. Right-click it for quick moves like Tomorrow or Priority.',
      phone: 'Tap a task to open its page for notes, checklists and pictures. Press and hold it for quick moves like Tomorrow or Priority.',
    },
    missingText: {
      wide: 'Once you have tasks, click one to open its page for notes, checklists and pictures. Right-click it for quick moves like Tomorrow or Priority.',
      phone: 'Once you have tasks, tap one to open its page for notes, checklists and pictures. Press and hold it for quick moves like Tomorrow.',
    },
  },
  {
    id: 'tasks-undo',
    chapter: 'tasks',
    page: 'tasks',
    title: 'Undo',
    text: {
      wide: 'Every change shows a message at the bottom with Undo, and {undo} takes it back too. Only clearing all completed tasks asks first.',
      phone: 'Every change shows a message at the bottom with Undo. Only clearing all completed tasks asks first.',
    },
  },

  /* Notes */
  {
    id: 'notes-sections',
    chapter: 'notes',
    page: 'notes',
    title: 'Sections',
    target: ['.nt-rail', '.nt-strip', '.nt-viewdd-btn'],
    text: 'Sections keep notes apart, like Work or Recipes. All notes shows every one of them.',
    place: { wide: 'right' },
  },
  {
    id: 'notes-new',
    chapter: 'notes',
    page: 'notes',
    title: 'New note',
    target: '.nt-new',
    text: 'New note starts one in the open section. It saves as you type.',
  },
  {
    id: 'notes-mode',
    chapter: 'notes',
    page: 'notes',
    title: 'Write or read',
    target: '.nt-seg',
    text: 'Edit to write, Preview to read. Simple marks work: # for a heading, - for a list, [ ] for a checklist.',
    ifMissing: 'skip',
  },

  /* Habits */
  {
    id: 'habits-tabs',
    chapter: 'habits',
    page: 'habits',
    title: 'Check in · Plan · Insights',
    target: '.hb-tabs',
    text: 'Check in to tick today’s habits, Plan to choose their days, Insights for streaks and charts.',
  },
  {
    id: 'habits-tick',
    chapter: 'habits',
    page: 'habits',
    title: 'Tick it off',
    target: [
      // Check in's Day list, else today's square in its Week grid, else (no habits yet) New habit
      '.hb-panel .hb-row-check',
      '.hb-panel .hb-mx-cell[aria-label*="(today)"]',
      { sel: '.hb-add', text: 'New habit adds one for the days you choose. Then tick it off here each day it’s done.' },
    ],
    text: 'Tick a habit when it’s done. Each day you keep it grows its streak.',
  },

  /* Calendar */
  {
    id: 'cal-views',
    chapter: 'calendar',
    page: 'calendar',
    title: 'Month, week or day',
    target: ['.cal-zoom', '.cal-view-btn'],
    text: {
      wide: 'Switch between month, week and day, or press M, W or D. Your tasks and habits show beside your events.',
      phone: 'Switch between month, week and day. Your tasks and habits show beside your events.',
    },
  },
  {
    id: 'cal-new',
    chapter: 'calendar',
    page: 'calendar',
    title: 'Add an event',
    target: '.cal-new',
    text: {
      wide: 'New event, or click a day, or drag on the week’s timeline.',
      phone: 'New event adds one, or tap a day to see it and add one there.',
    },
  },
  {
    id: 'cal-tray',
    chapter: 'calendar',
    page: 'calendar',
    title: 'Tasks without a date',
    target: '.cal-tray-toggle',
    text: 'Tasks without a date wait in this tray. Drag one onto a day to plan it.',
    ifMissing: 'skip',
  },

  /* Pomodoro */
  {
    id: 'pm-start',
    chapter: 'pomodoro',
    page: 'pomodoro',
    title: 'Focus',
    target: '.pm-main',
    text: {
      wide: 'Start a round of focus, then a short break. Space starts and pauses; the timer stays in view on every page.',
      phone: 'Start a round of focus, then a short break. The timer stays in view on every page.',
    },
  },
  {
    id: 'pm-setup',
    chapter: 'pomodoro',
    page: 'pomodoro',
    title: 'Set it up',
    target: '.pm-setup-btn',
    text: 'Set up how long focus and breaks last, the bell and notifications.',
  },

  /* Training */
  {
    id: 'tr-start',
    chapter: 'training',
    page: 'training',
    title: 'Start a workout',
    target: '[data-tour="training-start"]',
    text: 'Start workout opens it right here: add exercises, tick sets, and a rest timer starts. It saves as you go.',
  },
  {
    id: 'tr-routines',
    chapter: 'training',
    page: 'training',
    title: 'Routines',
    target: ['.tr-routines', '.tr-log .empty'],
    text: 'Routines save the exercises you repeat, like Push day. Start one in a click, with last time’s numbers ready.',
  },

  /* Finance */
  {
    id: 'fn-subs',
    chapter: 'finance',
    page: 'finance',
    title: 'Subscriptions',
    target: '.fn-add-sub',
    text: 'Add your subscriptions to see what they cost a month and which payment comes next.',
  },
  {
    id: 'fn-results',
    chapter: 'finance',
    page: 'finance',
    title: 'Daily results',
    target: '.fn-show-btn',
    text: 'Show → Daily results tracks what you make or lose each day, on a graph. It’s off until you turn it on.',
  },

  /* Recovery */
  {
    id: 'rc-trackers',
    chapter: 'recovery',
    page: 'recovery',
    title: 'Trackers',
    target: '[data-tour="recovery-new"]',
    text: 'A tracker counts the days you stay away from something, like smoking or alcohol. It’s for you alone.',
  },
  {
    id: 'rc-relapse',
    chapter: 'recovery',
    page: 'recovery',
    title: 'A slip is one day',
    target: [
      { sel: '.rc-relapse-btn', text: 'I relapsed today marks today; any other day, tap it on the calendar. Every clean day before it still counts.' },
      { sel: '.rc-cal', text: 'Tap a day on the calendar to mark a relapse, and again to take it back. Every clean day before it still counts.' },
    ],
    text: 'Once you have a tracker, mark a relapse on its calendar. Every clean day before it still counts.',
  },

  /* Settings */
  {
    id: 'st-look',
    chapter: 'settings',
    page: 'settings',
    title: 'Appearance',
    // (a phone shows a section's heading: the whole card is taller than the screen)
    target: { wide: '#st-sec-appearance', phone: '#st-sec-appearance .st-card-title' },
    text: 'Pick one of eight looks, light or dark, your own colors, and fewer animations if you like.',
  },
  {
    id: 'st-sync',
    chapter: 'settings',
    page: 'settings',
    title: 'Sync & backup',
    target: { wide: '#st-sec-sync', phone: '#st-sec-sync .st-card-title' },
    text: 'Sync keeps your computers in step through your own private GitHub. Download a backup here too.',
  },
  {
    id: 'st-tour',
    chapter: 'settings',
    page: 'settings',
    title: 'This tour',
    target: '[data-row="tutorial"]',
    text: 'Start a tutorial again here, or carry on where you left off.',
  },

  /* Finish */
  {
    id: 'keys',
    chapter: 'end',
    only: 'wide',
    title: 'Keyboard shortcuts',
    text: 'Press ? on any page for every shortcut. 1 to 9 switch pages, N adds something new and {search} searches.',
  },
  {
    id: 'done',
    chapter: 'end',
    title: 'You’re all set',
    text: 'That’s every page. Start small: one task, one habit or a note. Have a good day!',
  },
];

const LISTS = { quick: QUICK, full: FULL };

/** The words for this screen: a string, or { phone, wide }. */
function pick(value, phone) {
  if (value == null || typeof value === 'string') return value ?? null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && ('phone' in value || 'wide' in value)) return value[phone ? 'phone' : 'wide'] ?? null;
  return value;
}

/** ⌘K or Ctrl K, ⌘Z or Ctrl Z: the keys as this computer names them. */
export function fillKeys(text, { mac = true } = {}) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{search\}/g, mac ? '⌘K' : 'Ctrl K').replace(/\{undo\}/g, mac ? '⌘Z' : 'Ctrl Z');
}

/** A step's targets for this screen: [{ sel, title, text }] (empty: centred, no pointer). */
function targetsOf(step, phone, mac) {
  const raw = pick(step.target, phone);
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return list
    .map((t) => (typeof t === 'string' ? { sel: t } : t && typeof t.sel === 'string' ? t : null))
    .filter(Boolean)
    .map((t) => ({ sel: t.sel, title: fillKeys(pick(t.title, phone), { mac }), text: fillKeys(pick(t.text, phone), { mac }) }));
}

/**
 * The steps of tour `kind` ('quick' | 'full') for this screen: phone (640px or narrower) or a
 * computer, the keys' names (mac) and whether a look was picked in the welcome (lookPicked). Each
 * with its words and targets worked out:
 * { id, chapter, page, targets: [{ sel, title, text }], title, text, missingText, ifMissing,
 *   picker, tryIt, advanceOn, place }
 */
export function tourSteps(kind, { phone = false, mac = true, lookPicked = false } = {}) {
  const list = LISTS[kind] ?? [];
  return list
    .filter((s) => !s.only || s.only === (phone ? 'phone' : 'wide'))
    .filter((s) => !(s.unlessLook && lookPicked === true))
    .map((s) => {
      const text = fillKeys(pick(s.text, phone), { mac });
      return Object.freeze({
        id: s.id,
        chapter: s.chapter ?? null,
        page: s.page ?? null,
        targets: Object.freeze(targetsOf(s, phone, mac)),
        title: fillKeys(pick(s.title, phone), { mac }),
        text,
        missingText: fillKeys(pick(s.missingText, phone), { mac }) ?? text,
        ifMissing: s.ifMissing === 'skip' ? 'skip' : 'centre',
        picker: !!s.picker,
        tryIt: pick(s.tryIt, phone) ?? null,
        advanceOn: s.advanceOn ?? null,
        place: pick(s.place, phone) ?? null,
      });
    });
}

/* ---- Progress ---- */

/** "Step 3 of 8" */
export function progressText(index, total) {
  const n = Math.max(1, Math.min(total, Math.trunc(index) + 1));
  return `Step ${n} of ${total}`;
}

/**
 * The chapter of step `index` in the full tutorial, numbered among the chapters these steps have:
 * { id, title, n, of }. Null for a step without one (or a tour without chapters, the quick one).
 */
export function chapterOf(steps, index, { chapters = true } = {}) {
  const step = steps?.[index];
  if (!chapters || !step?.chapter) return null;
  const order = [];
  for (const s of steps) if (s.chapter && !order.includes(s.chapter)) order.push(s.chapter);
  const info = CHAPTERS.find((c) => c.id === step.chapter);
  return { id: step.chapter, title: info?.title ?? step.chapter, n: order.indexOf(step.chapter) + 1, of: order.length };
}

/* ---- Where each tour is (settings.tours, this device only) ----
   { quick: { step, status }, full: { step, status } }: status 'open' (on screen, or the window
   closed during it), 'left' (Skip, Esc) or 'done' (End on the last step); step: the step's id. */

export const TOUR_STATUS = Object.freeze(['open', 'left', 'done']);

/** settings.tours, kept to what this version knows. */
export function normalizeTours(value) {
  const out = {};
  for (const kind of TOUR_KINDS) {
    const v = value && typeof value === 'object' ? value[kind] : null;
    if (v && typeof v === 'object' && TOUR_STATUS.includes(v.status)) out[kind] = { step: typeof v.step === 'string' ? v.step : null, status: v.status };
  }
  return out;
}

/** settings.tours with tour `kind` at step `step` (an id) and `status`. Never changes `value`. */
export function recordTour(value, kind, step, status) {
  const out = normalizeTours(value);
  if (!TOUR_KINDS.includes(kind) || !TOUR_STATUS.includes(status)) return out;
  out[kind] = { step: typeof step === 'string' ? step : null, status };
  return out;
}

/** Where a tour picks up: the saved step (left or open), else the start. -> index into `steps` */
export function resumeIndex(steps, record) {
  if (!record || record.status === 'done' || !Array.isArray(steps)) return 0;
  const at = steps.findIndex((s) => s.id === record.step);
  return at < 0 ? 0 : at;
}

/**
 * Whether Settings offers "Continue": the tour was left (or the window closed) after its first
 * step and before its end. -> { index, n, of } | null
 */
export function continueInfo(steps, record) {
  if (!record || record.status === 'done' || !Array.isArray(steps) || !steps.length) return null;
  const index = steps.findIndex((s) => s.id === record.step);
  if (index <= 0) return null;
  return { index, n: index + 1, of: steps.length };
}

/* ---- Where the spotlight and the bubble go ----
   Rects are { left, top, width, height } in the window (getBoundingClientRect). */

/** The spotlight: the target with `pad` around it, kept inside the window (2px from its edges). */
export function spotRect(target, view, pad = 6) {
  const left = Math.max(2, target.left - pad);
  const top = Math.max(2, target.top - pad);
  const right = Math.min(view.width - 2, target.left + target.width + pad);
  const bottom = Math.min(view.height - 2, target.top + target.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** The part of `rect` inside the window, or null when none of it is. */
export function visiblePart(rect, view) {
  if (!rect) return null;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(view.width, rect.left + rect.width);
  const bottom = Math.min(view.height, rect.top + rect.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

const SIDES = ['bottom', 'top', 'right', 'left'];

/**
 * Where the bubble (`size`: { width, height }) goes next to `target` (the spotlight's rect, or
 * null: the middle of the window), inside `view` ({ width, height }) with `margin` to spare:
 * on the side it prefers if it fits there, else below, above, right or left, the first that fits,
 * lined up with the target's middle as far as the window allows. A target too big for any side
 * (a whole board) gets the bubble over it, at the window's bottom or top, away from its middle.
 * -> { left, top, side: 'bottom' | 'top' | 'right' | 'left' | 'over' | 'center', arrow }
 *    arrow: px along the bubble's edge where the pointer goes (null: no pointer).
 */
export function placeBubble(target, size, view, { prefer = null, gap = 12, margin = 12, edge = 18 } = {}) {
  const w = Math.min(size.width, Math.max(0, view.width - 2 * margin));
  const h = Math.min(size.height, Math.max(0, view.height - 2 * margin));
  const clampX = (x) => Math.max(margin, Math.min(view.width - margin - w, x));
  const clampY = (y) => Math.max(margin, Math.min(view.height - margin - h, y));
  if (!target) return { left: clampX((view.width - w) / 2), top: clampY((view.height - h) / 2), side: 'center', arrow: null };

  const right = target.left + target.width;
  const bottom = target.top + target.height;
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const along = (offset, length) => Math.max(edge, Math.min(length - edge, offset));
  const order = [...(SIDES.includes(prefer) ? [prefer] : []), ...SIDES.filter((s) => s !== prefer)];
  for (const side of order) {
    if (side === 'bottom' && view.height - margin - (bottom + gap) >= h) {
      const left = clampX(cx - w / 2);
      return { left, top: clampY(bottom + gap), side, arrow: along(cx - left, w) };
    }
    if (side === 'top' && target.top - gap - margin >= h) {
      const left = clampX(cx - w / 2);
      return { left, top: clampY(target.top - gap - h), side, arrow: along(cx - left, w) };
    }
    if (side === 'right' && view.width - margin - (right + gap) >= w) {
      const top = clampY(cy - h / 2);
      return { left: clampX(right + gap), top, side, arrow: along(cy - top, h) };
    }
    if (side === 'left' && target.left - gap - margin >= w) {
      const top = clampY(cy - h / 2);
      return { left: clampX(target.left - gap - w), top, side, arrow: along(cy - top, h) };
    }
  }
  // Over the target: at the far end of the window from its middle
  return { left: clampX(cx - w / 2), top: cy < view.height / 2 ? clampY(view.height - margin - h) : margin, side: 'over', arrow: null };
}
