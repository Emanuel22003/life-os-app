// LIFE/OS — what the shell (js/app.js) offers pages that can't import it, since it imports them.
// app.js fills these in before the first page renders; pages read them when they mount.
// Also the phone tab bar's pure rules (normalizeTabs, toggleTab): no DOM, tested in
// tools/tests/shell.test.js.

export const shell = {
  version: '',
  /** The pages a person can start on: [{ id, title }] in nav order. */
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

/* ---- The phone tab bar: up to four pages of your choice, then More ----
   settings.tabs (this device only, never synced) lists them in the bar's order. */

export const MAX_TABS = 4;
export const DEFAULT_TABS = Object.freeze(['home', 'tasks', 'calendar', 'habits']);

/**
 * The tab bar's pages: `value` (settings.tabs) kept to pages that exist (`pageIds`, the nav's
 * order), each once, at most four, in the order chosen. Nothing usable (never set, an old or
 * broken value, every page gone) gives the default four (those of them that exist).
 */
export function normalizeTabs(value, pageIds = DEFAULT_TABS) {
  const known = new Set(Array.isArray(pageIds) ? pageIds : []);
  const pick = (list) => {
    const out = [];
    for (const id of Array.isArray(list) ? list : []) {
      if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
      if (out.length === MAX_TABS) break;
    }
    return out;
  };
  const chosen = pick(value);
  if (chosen.length) return chosen;
  const fallback = pick(DEFAULT_TABS);
  return fallback.length ? fallback : pick([...known]);
}

/**
 * Tick or untick page `id` in the tab bar (Edit tabs). Ticking adds it at the end; it is refused
 * while four are in (untick one first), and the last page can't be unticked (the bar keeps one).
 * -> { tabs, changed, reason: null | 'full' | 'last' | 'unknown' }
 */
export function toggleTab(tabs, id, pageIds = DEFAULT_TABS) {
  const current = normalizeTabs(tabs, pageIds);
  if (!(Array.isArray(pageIds) ? pageIds : []).includes(id)) return { tabs: current, changed: false, reason: 'unknown' };
  if (current.includes(id)) {
    if (current.length === 1) return { tabs: current, changed: false, reason: 'last' };
    return { tabs: current.filter((x) => x !== id), changed: true, reason: null };
  }
  if (current.length >= MAX_TABS) return { tabs: current, changed: false, reason: 'full' };
  return { tabs: [...current, id], changed: true, reason: null };
}
