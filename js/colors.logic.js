// LIFE/OS — color coding, the pure part (no DOM, so tools/tests can import it).
//
// Anything can carry an optional color: task sections and note sections ({ color }), tasks,
// notes and events ({ color }), and days of the calendar (calendar.dayColors { 'YYYY-MM-DD':
// color }). A color is a palette id, never a hex value: each template (and light / dark) draws
// its own shade of it (--cc-<id> in css/tokens.css and the skins). Unknown ids are kept as
// stored (a newer version may add colors) and simply show no color.
//
// Showing colors is a per-device choice (settings.colors): one master switch plus one switch per
// kind. Off hides the colors and the pickers; nothing stored changes.

export const COLORS = Object.freeze(
  [
    { id: 'red', name: 'Red' },
    { id: 'orange', name: 'Orange' },
    { id: 'yellow', name: 'Yellow' },
    { id: 'green', name: 'Green' },
    { id: 'teal', name: 'Teal' },
    { id: 'blue', name: 'Blue' },
    { id: 'purple', name: 'Purple' },
    { id: 'pink', name: 'Pink' },
  ].map((c) => Object.freeze(c)),
);

const IDS = new Set(COLORS.map((c) => c.id));

/** A known palette id, or null (none, unknown, malformed). */
export function colorKey(value) {
  return typeof value === 'string' && IDS.has(value) ? value : null;
}

export function colorName(id) {
  return COLORS.find((c) => c.id === id)?.name ?? 'No color';
}

/** What can be colored, in the order Settings lists the switches. */
export const COLOR_KINDS = Object.freeze([
  Object.freeze({ id: 'sections', name: 'Sections', hint: 'Task and note sections; their tasks and notes take the color too' }),
  Object.freeze({ id: 'tasks', name: 'Tasks', hint: 'One task, in Tasks, Home and the Calendar' }),
  Object.freeze({ id: 'notes', name: 'Notes', hint: 'One note, in the list and on the board' }),
  Object.freeze({ id: 'events', name: 'Events', hint: 'Calendar events' }),
  Object.freeze({ id: 'days', name: 'Days', hint: 'Whole days in the month view' }),
]);

export const DEFAULT_COLOR_PREFS = Object.freeze({ on: true, sections: true, tasks: true, notes: true, events: true, days: true });

/** settings.colors -> { on, sections, tasks, notes, events, days } (missing switches are on). */
export function normalizeColorPrefs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { on: typeof src.on === 'boolean' ? src.on : DEFAULT_COLOR_PREFS.on };
  for (const k of COLOR_KINDS) out[k.id] = typeof src[k.id] === 'boolean' ? src[k.id] : DEFAULT_COLOR_PREFS[k.id];
  return out;
}

/** True when colors of `kind` show (master switch and that kind's switch). */
export function showsColor(prefs, kind) {
  const p = normalizeColorPrefs(prefs);
  return p.on && p[kind] === true;
}

/** The classes on <html> that turn colors on: 'cc-on' plus 'cc-<kind>' for every kind shown. */
export function colorClasses(prefs) {
  const p = normalizeColorPrefs(prefs);
  if (!p.on) return [];
  return ['cc-on', ...COLOR_KINDS.filter((k) => p[k.id]).map((k) => `cc-${k.id}`)];
}

/** A record with its color set (or removed with null): the same record when nothing changes. */
export function withColor(record, color) {
  const next = colorKey(color);
  if ((record.color ?? null) === next) return record;
  const { color: _old, ...rest } = record;
  return next ? { ...rest, color: next } : rest;
}

/** dayColors with one day set (or cleared): the same object when nothing changes. */
export function withDayColor(dayColors, key, color) {
  const map = dayColors && typeof dayColors === 'object' && !Array.isArray(dayColors) ? dayColors : {};
  const next = colorKey(color);
  if ((map[key] ?? null) === next) return map;
  const { [key]: _old, ...rest } = map;
  return next ? { ...rest, [key]: next } : rest;
}
