// LIFE/OS — formats: how dates and measures read, by this device's choice (Settings → Language &
// units, or the first run's "Your formats" step). Pure (no DOM, no store), so the pure page rules
// (calendar.logic.js, contextmenu.logic.js) and the tests use it as it is; ui.js re-exports it and
// app.js points it at settings once (useFormats), so every page follows a change.
//
// settings.dateFormat: 'dmy' (the default: 27/10/2026, Tue 27 Oct) · 'mdy' (US: 10/27/2026,
// Tue Oct 27) · 'ymd' (2026-10-27, Tue 2026-10-27). Month and weekday names stay words.
// settings.units: 'metric' (the default: kg, km) · 'us' (lb, miles). Stored values are metric
// whatever is shown.

export const DATE_FORMATS = Object.freeze(['dmy', 'mdy', 'ymd']);
export const DEFAULT_DATE_FORMAT = 'dmy';
export const UNIT_SYSTEMS = Object.freeze(['metric', 'us']);
export const DEFAULT_UNITS = 'metric';

export const WEEKDAYS_SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
export const WEEKDAYS_LONG = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
export const MONTHS_SHORT = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
export const MONTHS_LONG = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

/** The choices as Settings and the first run list them (the example is worked out from today). */
export const DATE_FORMAT_CHOICES = Object.freeze(
  [
    { id: 'dmy', label: 'Day / month / year' },
    { id: 'mdy', label: 'Month / day / year (US)' },
    { id: 'ymd', label: 'Year-month-day' },
  ].map((c) => Object.freeze(c)),
);
export const UNIT_CHOICES = Object.freeze(
  [
    { id: 'metric', label: 'Metric', hint: 'kg, km' },
    { id: 'us', label: 'US', hint: 'lb, miles' },
  ].map((c) => Object.freeze(c)),
);

export const normalizeDateFormat = (v) => (DATE_FORMATS.includes(v) ? v : DEFAULT_DATE_FORMAT);
export const normalizeUnits = (v) => (UNIT_SYSTEMS.includes(v) ? v : DEFAULT_UNITS);

// Where the device's choice comes from: () => settings (app.js, through ui.js useSettings)
let source = () => null;

/** Read the choices from `read()` (an object with dateFormat and units) from now on. */
export function useFormats(read) {
  source = typeof read === 'function' ? read : () => null;
}

function current() {
  try {
    return source() ?? {};
  } catch {
    return {};
  }
}

/** This device's date format ('dmy' when none was chosen). */
export const dateFormat = () => normalizeDateFormat(current().dateFormat);
/** This device's units ('metric' when none were chosen). */
export const unitSystem = () => normalizeUnits(current().units);
/** The weight unit the units stand for: 'kg' or 'lb'. */
export const weightUnitFor = (units) => (normalizeUnits(units) === 'us' ? 'lb' : 'kg');

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A day of a month (m 1–12): dmy '4 Oct' · '4 Oct 2026'; mdy 'Oct 4' · 'Oct 4, 2026'; ymd '10-04'
 * · '2026-10-04'. long: month names in full. `d` may be text already (a template's own digits).
 */
export function dayMonth(y, m, d, { year = false, long = false, format = dateFormat() } = {}) {
  const f = normalizeDateFormat(format);
  if (f === 'ymd') return `${year ? `${y}-` : ''}${pad2(m)}-${pad2(parseInt(d, 10))}`;
  const name = (long ? MONTHS_LONG : MONTHS_SHORT)[m - 1];
  if (f === 'mdy') return `${name} ${d}${year ? `, ${y}` : ''}`;
  return `${d} ${name}${year ? ` ${y}` : ''}`;
}

/**
 * A span of days a ([y, m, d]) to b: dmy '5–11 Oct' · '26 Oct – 1 Nov' (+ ' 2026' with year);
 * mdy 'Oct 5–11' · 'Oct 26 – Nov 1' (+ ', 2026'); ymd '10-05 – 10-11'. Across two years with
 * year, each side names its own.
 */
export function dayRange([ay, am, ad], [by, bm, bd], { year = false, format = dateFormat() } = {}) {
  const f = normalizeDateFormat(format);
  if (year && ay !== by) return `${dayMonth(ay, am, ad, { year: true, format: f })} – ${dayMonth(by, bm, bd, { year: true, format: f })}`;
  if (f === 'ymd') return `${dayMonth(ay, am, ad, { year, format: f })} – ${dayMonth(by, bm, bd, { year, format: f })}`;
  if (f === 'mdy') {
    const tail = year ? `, ${by}` : '';
    return am === bm ? `${MONTHS_SHORT[bm - 1]} ${ad}–${bd}${tail}` : `${MONTHS_SHORT[am - 1]} ${ad} – ${MONTHS_SHORT[bm - 1]} ${bd}${tail}`;
  }
  const tail = year ? ` ${by}` : '';
  return am === bm ? `${ad}–${bd} ${MONTHS_SHORT[bm - 1]}${tail}` : `${ad} ${MONTHS_SHORT[am - 1]} – ${bd} ${MONTHS_SHORT[bm - 1]}${tail}`;
}

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const partsOf = (key) => {
  const m = typeof key === 'string' ? KEY.exec(key) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const weekdayOf = (y, m, d) => new Date(y, m - 1, d).getDay();

/**
 * A day with its weekday: short 'Tue 27 Oct' (the year when it isn't `thisYear`, or with
 * year: true; year-month-day always has it: 'Tue 2026-10-27'); long 'Tuesday 27 October 2026' (mdy 'Tuesday, October 27, 2026'; ymd 'Tuesday
 * 2026-10-27'). '' for anything that isn't a day.
 */
export function weekdayDate(key, { long = false, year = null, thisYear = new Date().getFullYear(), format = dateFormat() } = {}) {
  const p = partsOf(key);
  if (!p) return '';
  const [y, m, d] = p;
  const f = normalizeDateFormat(format);
  const wd = weekdayOf(y, m, d);
  if (long) return `${WEEKDAYS_LONG[wd]}${f === 'mdy' ? ',' : ''} ${dayMonth(y, m, d, { year: true, long: true, format: f })}`;
  // (year-month-day always says its year: '10-27' alone reads as a code)
  return `${WEEKDAYS_SHORT[wd]} ${dayMonth(y, m, d, { year: year ?? (f === 'ymd' || y !== thisYear), format: f })}`;
}

/** A day in figures: '27/10/2026' · '10/27/2026' · '2026-10-27' ('' for anything else). */
export function numericDate(key, format = dateFormat()) {
  const p = partsOf(key);
  if (!p) return '';
  const [y, m, d] = p;
  const f = normalizeDateFormat(format);
  if (f === 'ymd') return `${y}-${pad2(m)}-${pad2(d)}`;
  if (f === 'mdy') return `${pad2(m)}/${pad2(d)}/${y}`;
  return `${pad2(d)}/${pad2(m)}/${y}`;
}

/** What a format looks like on `key` (today): '27/10/2026 · Tue 27 Oct'. */
export function dateFormatExample(format, key) {
  return `${numericDate(key, format)} · ${weekdayDate(key, { format, thisYear: Number(String(key).slice(0, 4)) })}`;
}
