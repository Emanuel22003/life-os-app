// LIFE/OS — Finance: pure helpers (no DOM, no store), tested in tools/tests/finance.test.js.
//
// Store shape ('finance'):
//   { subscriptions: [{
//       id, name, amount, currency,                 // amount per payment, e.g. 129.9 'NOK'
//       every, unit,                                // a payment every 1 'month' ('week' | 'month' | 'year')
//       billingDate,                                // 'YYYY-MM-DD': a payment day; payments repeat from it
//       status,                                     // 'active' | 'trial' | 'paused' | 'cancelled'
//       trialEnds, cancelledAt,                     // 'YYYY-MM-DD' | null
//       category, url, note, createdAt, updatedAt }],
//     view: { sort: 'next' | 'price' | 'name', showCancelled } }   // view is per device (not synced)
//
// Payments are never stored: they follow from billingDate and the cycle. A monthly payment keeps
// its day of the month and falls on the last day of shorter months (the 31st: 28 Feb, 31 Mar).
// A free trial's first payment is the day it ends. Paused and cancelled subscriptions cost nothing.
// Totals are kept per currency: LIFE/OS doesn't convert between currencies.

import { dateKey, parseKey, shiftKey, diffDays } from '../ui.js';

export const UNITS = Object.freeze(['week', 'month', 'year']);
export const STATUSES = Object.freeze(['active', 'trial', 'paused', 'cancelled']);
export const STATUS_LABEL = Object.freeze({ active: 'Active', trial: 'Free trial', paused: 'Paused', cancelled: 'Cancelled' });
export const SORTS = Object.freeze(['next', 'price', 'name']);
export const DEFAULT_VIEW = Object.freeze({ sort: 'next', showCancelled: false });
export const DEFAULT_STATE = Object.freeze({ subscriptions: Object.freeze([]), view: DEFAULT_VIEW });
export const EVERY_MAX = 52;
export const NAME_MAX = 80;
export const AMOUNT_MAX = 10_000_000;
export const NOTE_MAX = 1000;
export const URL_MAX = 500;
/** Weeks in an average month (365.25 / 7 / 12) */
const WEEKS_PER_MONTH = 365.25 / 7 / 12;

export const CATEGORIES = Object.freeze(
  [
    { id: 'streaming', name: 'TV & streaming' },
    { id: 'music', name: 'Music & audio' },
    { id: 'software', name: 'Software & AI' },
    { id: 'cloud', name: 'Cloud & storage' },
    { id: 'news', name: 'News & reading' },
    { id: 'gaming', name: 'Gaming' },
    { id: 'fitness', name: 'Fitness & health' },
    { id: 'phone', name: 'Phone & internet' },
    { id: 'home', name: 'Home & utilities' },
    { id: 'insurance', name: 'Insurance' },
    { id: 'transport', name: 'Transport' },
    { id: 'other', name: 'Other' },
  ].map((c) => Object.freeze(c)),
);
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

export function categoryName(id) {
  return CATEGORIES.find((c) => c.id === id)?.name ?? 'Other';
}

/** Common currencies first in the picker; any ISO code (3 capital letters) is accepted. */
export const CURRENCIES = Object.freeze(['NOK', 'SEK', 'DKK', 'EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CAD', 'AUD', 'JPY']);

/** Well-known services: the name field suggests them and picks their category. */
export const SUGGESTIONS = Object.freeze(
  [
    { name: 'Netflix', category: 'streaming' },
    { name: 'Spotify', category: 'music' },
    { name: 'YouTube Premium', category: 'streaming' },
    { name: 'Disney+', category: 'streaming' },
    { name: 'HBO Max', category: 'streaming' },
    { name: 'Viaplay', category: 'streaming' },
    { name: 'TV 2 Play', category: 'streaming' },
    { name: 'Amazon Prime', category: 'streaming' },
    { name: 'Apple TV+', category: 'streaming' },
    { name: 'Apple Music', category: 'music' },
    { name: 'Tidal', category: 'music' },
    { name: 'Audible', category: 'music' },
    { name: 'Apple One', category: 'cloud' },
    { name: 'iCloud+', category: 'cloud' },
    { name: 'Google One', category: 'cloud' },
    { name: 'Dropbox', category: 'cloud' },
    { name: 'ChatGPT Plus', category: 'software' },
    { name: 'Claude Pro', category: 'software' },
    { name: 'Adobe Creative Cloud', category: 'software' },
    { name: 'Microsoft 365', category: 'software' },
    { name: 'Notion', category: 'software' },
    { name: 'CapCut Pro', category: 'software' },
    { name: 'PlayStation Plus', category: 'gaming' },
    { name: 'Xbox Game Pass', category: 'gaming' },
    { name: 'Nintendo Switch Online', category: 'gaming' },
    { name: 'Gym membership', category: 'fitness' },
    { name: 'Strava', category: 'fitness' },
    { name: 'Phone plan', category: 'phone' },
    { name: 'Internet', category: 'phone' },
    { name: 'Aftenposten', category: 'news' },
    { name: 'VG+', category: 'news' },
  ].map((s) => Object.freeze(s)),
);

/** The suggestion with this name (any case), or null. */
export function suggestionFor(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return key ? SUGGESTIONS.find((s) => s.name.toLowerCase() === key) ?? null : null;
}

/* ==========================================================================
   Reading input
   ========================================================================== */

const isKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && dateKey(parseKey(v)) === v;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * A typed price -> a number with at most 2 decimals, or NaN.
 * '129' · '129,90' · '129.90' · '1 290,50' · '1,290.50' · '1.290' (thousands) · 'kr 99'
 */
export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? Math.round(text * 100) / 100 : NaN;
  let s = String(text ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s) || s.includes('-')) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: the later one separates the decimals
    const dec = lastComma > lastDot ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    // One separator with 1–2 digits after it is a decimal point; anything else groups thousands
    s = parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

export function isCurrency(code) {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

/** Only web links open from a subscription ('' for anything else). */
export function safeUrl(url) {
  const s = clean(url, URL_MAX);
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(withScheme) ? withScheme : '';
}

/* ==========================================================================
   Normalization — tolerate missing / malformed fields from older versions
   ========================================================================== */

const fallbackId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A valid subscription, or null (no name). Fields this version doesn't know are kept. */
export function normalizeSubscription(raw, { now = Date.now(), makeId = fallbackId, currency = 'NOK' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = clean(raw.name, NAME_MAX);
  if (!name) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : typeof raw.id === 'number' ? String(raw.id) : String(makeId());
  const amount = parseAmount(raw.amount);
  const every = Number.isInteger(raw.every) && raw.every >= 1 && raw.every <= EVERY_MAX ? raw.every : 1;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  return {
    ...raw,
    id,
    name,
    amount: Number.isFinite(amount) ? Math.min(amount, AMOUNT_MAX) : 0,
    currency: isCurrency(raw.currency) ? raw.currency : currency,
    every,
    unit: UNITS.includes(raw.unit) ? raw.unit : 'month',
    billingDate: isKey(raw.billingDate) ? raw.billingDate : null,
    status: STATUSES.includes(raw.status) ? raw.status : 'active',
    trialEnds: isKey(raw.trialEnds) ? raw.trialEnds : null,
    cancelledAt: isKey(raw.cancelledAt) ? raw.cancelledAt : null,
    category: CATEGORY_IDS.has(raw.category) ? raw.category : 'other',
    url: typeof raw.url === 'string' ? raw.url.trim().slice(0, URL_MAX) : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX) : '',
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

export function normalizeView(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    sort: SORTS.includes(v.sort) ? v.sort : DEFAULT_VIEW.sort,
    showCancelled: typeof v.showCancelled === 'boolean' ? v.showCancelled : DEFAULT_VIEW.showCancelled,
  };
}

/** The whole store value, repaired: junk dropped, ids unique, view filled in. */
export function normalizeState(raw, opts = {}) {
  const src = Array.isArray(raw) ? { subscriptions: raw } : raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const subscriptions = [];
  for (const entry of Array.isArray(src.subscriptions) ? src.subscriptions : []) {
    const sub = normalizeSubscription(entry, opts);
    if (!sub) continue;
    const base = sub.id;
    for (let n = 2; seen.has(sub.id); n++) sub.id = `${base}-${n}`;
    seen.add(sub.id);
    subscriptions.push(sub);
  }
  return { ...src, subscriptions, view: normalizeView(src.view) };
}

/* ==========================================================================
   Edits
   ========================================================================== */

/**
 * A new subscription from dialog fields:
 * { name, amount, currency, every, unit, billingDate, status, trialEnds, category, url, note }.
 * -> { sub } | { error, field }
 */
export function createSubscription(fields, { now = Date.now(), today = dateKey(new Date(now)), makeId = fallbackId } = {}) {
  const v = validate(fields);
  if (v.error) return v;
  const sub = normalizeSubscription({ ...v.fields, id: String(makeId()), createdAt: now, updatedAt: now, cancelledAt: v.fields.status === 'cancelled' ? today : null }, { now, makeId });
  return { sub };
}

/** The same subscription with `fields` changed. Cancelling stamps the day; un-cancelling clears it. */
export function updateSubscription(sub, fields, { now = Date.now(), today = dateKey(new Date(now)) } = {}) {
  const v = validate({ ...sub, ...fields });
  if (v.error) return v;
  const status = v.fields.status;
  const cancelledAt = status === 'cancelled' ? (sub.status === 'cancelled' && sub.cancelledAt ? sub.cancelledAt : today) : null;
  return { sub: normalizeSubscription({ ...sub, ...v.fields, cancelledAt, updatedAt: now }, { now }) };
}

function validate(f) {
  const name = clean(f.name, NAME_MAX);
  if (!name) return { error: 'Give it a name, like Netflix.', field: 'name' };
  const amount = parseAmount(f.amount);
  if (!Number.isFinite(amount)) return { error: 'Type the price as a number, like 129 or 129,90.', field: 'amount' };
  if (amount > AMOUNT_MAX) return { error: 'That price is too high.', field: 'amount' };
  const every = Number(f.every);
  if (!Number.isInteger(every) || every < 1 || every > EVERY_MAX) return { error: `Pick how often: every 1 to ${EVERY_MAX}.`, field: 'every' };
  const status = STATUSES.includes(f.status) ? f.status : 'active';
  const billingDate = isKey(f.billingDate) ? f.billingDate : null;
  const trialEnds = isKey(f.trialEnds) ? f.trialEnds : null;
  if (status === 'trial' && !trialEnds && !billingDate) return { error: 'When does the free trial end?', field: 'trialEnds' };
  if ((status === 'active' || status === 'paused') && !billingDate) return { error: 'When is the next payment?', field: 'billingDate' };
  return {
    fields: {
      name,
      amount,
      currency: isCurrency(f.currency) ? f.currency : 'NOK',
      every,
      unit: UNITS.includes(f.unit) ? f.unit : 'month',
      billingDate,
      status,
      trialEnds: status === 'trial' ? trialEnds : null,
      category: CATEGORY_IDS.has(f.category) ? f.category : 'other',
      url: clean(f.url, URL_MAX),
      note: typeof f.note === 'string' ? f.note.replace(/\s+$/, '').slice(0, NOTE_MAX) : '',
    },
  };
}

/* ==========================================================================
   Payments
   ========================================================================== */

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** The k-th payment (k = 0 is the anchor itself). */
function paymentAt(anchor, every, unit, k) {
  if (unit === 'week') return shiftKey(anchor, k * 7 * every);
  const [y, m, d] = anchor.split('-').map(Number);
  const months = (m - 1) + k * every * (unit === 'year' ? 12 : 1);
  const year = y + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(year, month));
  return dateKey(new Date(year, month, day));
}

/** Index of the first payment on or after `from` (0 when the anchor is already on or after it). */
function firstIndexFrom(anchor, every, unit, from) {
  if (anchor >= from) return 0;
  let k;
  if (unit === 'week') {
    k = Math.ceil(diffDays(anchor, from) / (7 * every));
  } else {
    const [ay, am] = anchor.split('-').map(Number);
    const [fy, fm] = from.split('-').map(Number);
    const step = every * (unit === 'year' ? 12 : 1);
    k = Math.max(0, Math.floor(((fy - ay) * 12 + (fm - am)) / step) - 1);
  }
  while (paymentAt(anchor, every, unit, k) < from) k++;
  return k;
}

/** Where a subscription's payments count from: the trial's end for a free trial. */
function anchorOf(sub) {
  if (sub.status === 'trial') return sub.trialEnds ?? sub.billingDate;
  return sub.billingDate;
}

const charges = (sub) => sub.status === 'active' || sub.status === 'trial';

/** The next payment on or after `today` ('YYYY-MM-DD'), or null (paused, cancelled, no date). */
export function nextPayment(sub, today) {
  const anchor = anchorOf(sub);
  if (!charges(sub) || !anchor) return null;
  return paymentAt(anchor, sub.every, sub.unit, firstIndexFrom(anchor, sub.every, sub.unit, today));
}

/** Every payment from `from` to `to` (inclusive). */
export function paymentsBetween(sub, from, to) {
  const anchor = anchorOf(sub);
  if (!charges(sub) || !anchor || to < from) return [];
  const out = [];
  for (let k = firstIndexFrom(anchor, sub.every, sub.unit, from); out.length < 400; k++) {
    const day = paymentAt(anchor, sub.every, sub.unit, k);
    if (day > to) break;
    out.push(day);
  }
  return out;
}

/**
 * Payments in the next `days` days (today included), soonest first:
 * [{ sub, date, inDays, trialEnd }] (trialEnd: this is the first payment after a free trial).
 */
export function upcoming(subs, today, days = 30) {
  const to = shiftKey(today, days);
  const out = [];
  for (const sub of subs) {
    for (const date of paymentsBetween(sub, today, to)) {
      out.push({ sub, date, inDays: diffDays(today, date), trialEnd: sub.status === 'trial' && date === anchorOf(sub) });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.sub.amount - a.sub.amount || a.sub.name.localeCompare(b.sub.name)));
}

/** How many payments fall today or in the next `days` days (the nav badge). */
export function dueSoon(subs, today, days = 3) {
  return upcoming(subs, today, days).length;
}

/* ==========================================================================
   Costs
   ========================================================================== */

/** What one payment cycle costs per month on average. */
export function perMonth(sub) {
  const a = Number.isFinite(sub.amount) ? sub.amount : 0;
  if (sub.unit === 'week') return (a * WEEKS_PER_MONTH) / sub.every;
  if (sub.unit === 'year') return a / (12 * sub.every);
  return a / sub.every;
}

export const perYear = (sub) => perMonth(sub) * 12;

const round2 = (n) => Math.round(n * 100) / 100;

function sumByCurrency(subs) {
  const map = new Map();
  for (const s of subs) map.set(s.currency, (map.get(s.currency) ?? 0) + perMonth(s));
  return map;
}

/**
 * What it all costs, per currency, biggest first:
 * { month: [{ currency, amount }], year: […], active, trials, paused, cancelled }.
 * Only active subscriptions count; free trials are listed apart (they cost nothing yet).
 */
export function totals(subs) {
  const active = subs.filter((s) => s.status === 'active');
  const month = [...sumByCurrency(active)].map(([currency, amount]) => ({ currency, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
  return {
    month,
    year: month.map((m) => ({ currency: m.currency, amount: round2(m.amount * 12) })),
    active: active.length,
    trials: subs.filter((s) => s.status === 'trial').length,
    paused: subs.filter((s) => s.status === 'paused').length,
    cancelled: subs.filter((s) => s.status === 'cancelled').length,
  };
}

/** What cancelled subscriptions would have cost per month, per currency (what you save). */
export function savings(subs) {
  return [...sumByCurrency(subs.filter((s) => s.status === 'cancelled'))].map(([currency, amount]) => ({ currency, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
}

/** The currency most subscriptions use (ties: the bigger monthly total), or `fallback`. */
export function mainCurrency(subs, fallback = 'NOK') {
  const live = subs.filter((s) => s.status !== 'cancelled');
  if (!live.length) return subs[subs.length - 1]?.currency ?? fallback;
  const count = new Map();
  for (const s of live) count.set(s.currency, (count.get(s.currency) ?? 0) + 1);
  const sums = sumByCurrency(live);
  return [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || sums.get(b) - sums.get(a))[0];
}

/** Monthly cost per category for one currency (active only), biggest first: [{ category, amount, count, share }]. */
export function byCategory(subs, currency) {
  const map = new Map();
  for (const s of subs) {
    if (s.status !== 'active' || s.currency !== currency) continue;
    const cur = map.get(s.category) ?? { category: s.category, amount: 0, count: 0 };
    cur.amount += perMonth(s);
    cur.count += 1;
    map.set(s.category, cur);
  }
  const list = [...map.values()].sort((a, b) => b.amount - a.amount);
  const total = list.reduce((n, c) => n + c.amount, 0);
  return list.map((c) => ({ ...c, amount: round2(c.amount), share: total ? c.amount / total : 0 }));
}

/* ==========================================================================
   Words
   ========================================================================== */

const UNIT_WORDS = { week: ['week', 'weeks', 'Weekly'], month: ['month', 'months', 'Monthly'], year: ['year', 'years', 'Yearly'] };

/** 'Monthly' · 'Every 2 weeks' · 'Every 3 months' · 'Yearly' */
export function cycleLabel(sub) {
  const [one, many, adverb] = UNIT_WORDS[sub.unit] ?? UNIT_WORDS.month;
  if (sub.every === 1) return adverb;
  if (sub.unit === 'month' && sub.every === 12) return 'Yearly';
  return `Every ${sub.every} ${sub.every === 1 ? one : many}`;
}

/** The short suffix after a price: '/ mo' · '/ 3 mo' · '/ wk' · '/ yr' */
export function cycleShort(sub) {
  const unit = { week: 'wk', month: 'mo', year: 'yr' }[sub.unit] ?? 'mo';
  return sub.every === 1 ? `/ ${unit}` : `/ ${sub.every} ${unit}`;
}

/** Sort for the list: next payment (soonest first; none last), price (per month, biggest first) or name. */
export function sortSubs(subs, sort, today) {
  const next = new Map(subs.map((s) => [s.id, nextPayment(s, today)]));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const list = subs.slice();
  if (sort === 'name') return list.sort(byName);
  if (sort === 'price') return list.sort((a, b) => perMonth(b) - perMonth(a) || byName(a, b));
  return list.sort((a, b) => {
    const x = next.get(a.id);
    const y = next.get(b.id);
    if (x && y && x !== y) return x < y ? -1 : 1;
    if (!x !== !y) return x ? -1 : 1;
    return byName(a, b);
  });
}

/** A text copy of a subscription ('Netflix — 129 NOK monthly'), for the clipboard. */
export function subscriptionText(sub) {
  return `${sub.name} — ${sub.amount} ${sub.currency} ${cycleLabel(sub).toLowerCase()}`;
}
