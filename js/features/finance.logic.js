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
//     results: { on, updatedAt },                   // Daily results shown (off by default; synced)
//     accounts: [{ id, name, kind,                  // what you track: 'business' | 'trading' | 'other'
//       currency, archived, usedAt, createdAt, updatedAt }],
//     entries: [{ id, accountId, date,              // a day's result: 'YYYY-MM-DD'
//       amount,                                     // signed: + made, − lost (several a day add up)
//       note, createdAt, updatedAt }],
//     view: { sort: 'next' | 'price' | 'name', showCancelled,        // view is per device (not synced)
//             tab: 'subs' | 'results', range: '7D' … 'ALL', scope } }
//
// Payments are never stored: they follow from billingDate and the cycle. A monthly payment keeps
// its day of the month and falls on the last day of shorter months (the 31st: 28 Feb, 31 Mar).
// A free trial's first payment is the day it ends. Paused and cancelled subscriptions cost nothing.
// Totals are kept per currency: LIFE/OS doesn't convert between currencies.
//
// Daily results (an option: results.on) are what you made or lost on a day, per account (a shop,
// a forex account). Accounts and entries are lists of records with ids, so Sync merges them one
// by one (merge3 in js/sync.logic.js): a day added on the phone and one on the Mac both stay.
// Sums never mix currencies: a scope (all accounts, all in one currency, one account) has one.

import { dateKey, parseKey, shiftKey, diffDays, formatDay, WEEKDAYS_SHORT } from '../ui.js';

export const UNITS = Object.freeze(['week', 'month', 'year']);
export const STATUSES = Object.freeze(['active', 'trial', 'paused', 'cancelled']);
export const STATUS_LABEL = Object.freeze({ active: 'Active', trial: 'Free trial', paused: 'Paused', cancelled: 'Cancelled' });
export const SORTS = Object.freeze(['next', 'price', 'name']);
export const TABS = Object.freeze(['subs', 'results']);
/** The graph's time ranges: the last `days` days up to today (null: since the first result). */
export const RESULT_RANGES = Object.freeze(
  [
    { id: '7D', days: 7, name: '7 days' },
    { id: '30D', days: 30, name: '30 days' },
    { id: '90D', days: 90, name: '90 days' },
    { id: '1Y', days: 365, name: 'year' },
    { id: 'ALL', days: null, name: 'all time' },
  ].map((r) => Object.freeze(r)),
);
const RANGE_IDS = RESULT_RANGES.map((r) => r.id);
export const DEFAULT_VIEW = Object.freeze({ sort: 'next', showCancelled: false, tab: 'subs', range: '30D', scope: 'all' });
export const DEFAULT_RESULTS = Object.freeze({ on: false, updatedAt: 0 });
export const DEFAULT_STATE = Object.freeze({ subscriptions: Object.freeze([]), results: DEFAULT_RESULTS, accounts: Object.freeze([]), entries: Object.freeze([]), view: DEFAULT_VIEW });
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

/** Each category's icon (js/icons.js): a subscription shows its category's at the front of its row. */
export const CATEGORY_ICON = Object.freeze({
  streaming: 'tv',
  music: 'music',
  software: 'code',
  cloud: 'folder',
  news: 'book',
  gaming: 'gamepad',
  fitness: 'dumbbell',
  phone: 'phone',
  home: 'home',
  insurance: 'heart',
  transport: 'car',
  other: 'wallet',
});

export function categoryIcon(id) {
  return CATEGORY_ICON[id] ?? CATEGORY_ICON.other;
}

export function categoryName(id) {
  return CATEGORIES.find((c) => c.id === id)?.name ?? 'Other';
}

/** Common currencies first in the picker; any ISO code (3 capital letters) is accepted. */
export const CURRENCIES = Object.freeze(['NOK', 'SEK', 'DKK', 'EUR', 'USD', 'GBP', 'CHF', 'PLN', 'CAD', 'AUD', 'JPY']);

/**
 * Well-known services: the name field suggests them and picks their category. Typing help only:
 * no one pays to be listed, and nothing here links to or advertises a service. A paid or sponsored
 * entry would have to be marked as an ad (markedsføringsloven § 8, first paragraph).
 */
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
    tab: TABS.includes(v.tab) ? v.tab : DEFAULT_VIEW.tab,
    range: RANGE_IDS.includes(v.range) ? v.range : DEFAULT_VIEW.range,
    // 'all', 'cur:NOK' or an account's id; one that no longer exists falls back (resolveScope)
    scope: typeof v.scope === 'string' && v.scope ? v.scope.slice(0, 120) : DEFAULT_VIEW.scope,
  };
}

/** Daily results' switch: off unless it was turned on. */
export function normalizeResults(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { ...r, on: r.on === true, updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0 };
}

/** Each record normalized, junk dropped, a repeated id made unique ('a', 'a-2'). */
function uniqueList(list, normalize, opts) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const rec = normalize(raw, opts);
    if (!rec) continue;
    const base = rec.id;
    for (let n = 2; seen.has(rec.id); n++) rec.id = `${base}-${n}`;
    seen.add(rec.id);
    out.push(rec);
  }
  return out;
}

/**
 * The whole store value, repaired: junk dropped, ids unique, view filled in. Data from before
 * Daily results (no results, accounts or entries) gets them empty and switched off.
 */
export function normalizeState(raw, opts = {}) {
  const src = Array.isArray(raw) ? { subscriptions: raw } : raw && typeof raw === 'object' ? raw : {};
  const subscriptions = uniqueList(src.subscriptions, normalizeSubscription, opts);
  const accounts = uniqueList(src.accounts, normalizeAccount, opts);
  const entries = uniqueList(src.entries, normalizeEntry, opts);
  // A day whose account is gone (deleted on one device while the other added to it) brings its
  // account back as "Restored account", so nothing typed in is lost; it can be renamed or deleted
  const known = new Set(accounts.map((a) => a.id));
  for (const e of entries) {
    if (known.has(e.accountId)) continue;
    known.add(e.accountId);
    const createdAt = Math.min(...entries.filter((x) => x.accountId === e.accountId).map((x) => x.createdAt));
    accounts.push(normalizeAccount({ id: e.accountId, name: RESTORED_NAME, kind: 'other', createdAt, updatedAt: 0 }, opts));
  }
  return { ...src, subscriptions, results: normalizeResults(src.results), accounts, entries, view: normalizeView(src.view) };
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

/**
 * The page's one-line summary (the stat beside its title): what the active subscriptions cost
 * per month and per year (per currency, biggest first) and the next payment, a free trial's
 * first one included. { month, year, next: { sub, date, inDays, trialEnd } | null, live }
 * (live: active subscriptions and free trials).
 */
export function summary(subs, today) {
  const t = totals(subs);
  return { month: t.month, year: t.year, next: upcoming(subs, today, 400)[0] ?? null, live: t.active + t.trials };
}

/** A payment's day in a few letters: 'today', 'tomorrow', 'Thu' within the week, else 'Thu 29 Oct'. */
export function shortWhen(date, today) {
  const n = diffDays(today, date);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return n > 1 && n < 7 ? WEEKDAYS_SHORT[parseKey(date).getDay()] : formatDay(date);
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

/* ==========================================================================
   Daily results: what you made or lost each day, per account (an option, off by default)
   ========================================================================== */

export const RESULT_KINDS = Object.freeze(['business', 'trading', 'other']);
export const RESULT_KIND_LABEL = Object.freeze({ business: 'Business', trading: 'Trading', other: 'Other' });
/** Each kind's icon (js/icons.js; 'activity' is ui.js's own): an account's row starts with it. */
export const RESULT_KIND_ICON = Object.freeze({ business: 'briefcase', trading: 'activity', other: 'coins' });
export const ENTRY_NOTE_MAX = 200;
export const RESTORED_NAME = 'Restored account';
const RESTORED_ID = 'restored';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const idOf = (raw, makeId) => (typeof raw.id === 'string' && raw.id ? raw.id : typeof raw.id === 'number' ? String(raw.id) : String(makeId()));
const clampAmount = (n) => Math.max(-AMOUNT_MAX, Math.min(AMOUNT_MAX, n));
const hasSign = (text) => /^[^\d]*[-−–+]/.test(String(text ?? '').trim());
const hasMinus = (text) => /^[^\d]*[-−–]/.test(String(text ?? '').trim());

/**
 * A typed result -> a signed number with at most 2 decimals, or NaN. A minus before the number is
 * a loss: '250' · '-120' · '−1 200,50' · '+80' · 'kr -99'.
 */
export function parseSigned(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? (Math.sign(text) * Math.round(Math.abs(text) * 100)) / 100 || 0 : NaN;
  const n = parseAmount(String(text ?? '').replace(/[-−–+]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return hasMinus(text) && n !== 0 ? -n : n;
}

/** What the quick add stores: the text's own sign when it has one ('-120' is a loss), else Made / Lost. */
export function signedAmount(text, lost = false) {
  const n = parseSigned(text);
  if (!Number.isFinite(n)) return NaN;
  if (hasSign(text)) return n;
  return lost ? -Math.abs(n) || 0 : Math.abs(n);
}

/** 'up' (made money) · 'down' (lost) · 'flat' (even) */
export function signOf(amount) {
  return amount > 0 ? 'up' : amount < 0 ? 'down' : 'flat';
}

/** One thing you track. Fields this version doesn't know are kept; a nameless one is "Account". */
export function normalizeAccount(raw, { now = Date.now(), makeId = fallbackId, currency = 'NOK' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  return {
    ...raw,
    id: idOf(raw, makeId),
    name: clean(raw.name, NAME_MAX) || 'Account',
    kind: RESULT_KINDS.includes(raw.kind) ? raw.kind : 'other',
    currency: isCurrency(raw.currency) ? raw.currency : currency,
    archived: raw.archived === true,
    // When a result was last added to it: that touch keeps the account (and its name and
    // currency) if another device deleted it meanwhile (an edit beats a delete in Sync)
    usedAt: Number.isFinite(raw.usedAt) ? raw.usedAt : 0,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

/** One result, or null (no valid day or amount). An entry without an account goes to the restored one. */
export function normalizeEntry(raw, { now = Date.now(), makeId = fallbackId } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isKey(raw.date)) return null;
  const amount = parseSigned(raw.amount);
  if (!Number.isFinite(amount)) return null;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  return {
    ...raw,
    id: idOf(raw, makeId),
    accountId: typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : typeof raw.accountId === 'number' ? String(raw.accountId) : RESTORED_ID,
    date: raw.date,
    amount: clampAmount(amount),
    note: typeof raw.note === 'string' ? raw.note.slice(0, ENTRY_NOTE_MAX) : '',
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

/* ---- Edits ---- */

function validateAccount(f) {
  const name = clean(f.name, NAME_MAX);
  if (!name) return { error: 'Give it a name, like My shop or Forex.', field: 'name' };
  if (!isCurrency(f.currency)) return { error: 'Pick a currency.', field: 'currency' };
  return { fields: { name, kind: RESULT_KINDS.includes(f.kind) ? f.kind : 'other', currency: f.currency, archived: f.archived === true } };
}

/** A new account from { name, kind, currency }. -> { account } | { error, field } */
export function createAccount(fields, { now = Date.now(), makeId = fallbackId } = {}) {
  const v = validateAccount(fields);
  if (v.error) return v;
  return { account: normalizeAccount({ ...v.fields, id: String(makeId()), createdAt: now, updatedAt: now }, { now, makeId }) };
}

/** The same account with `fields` changed (a rename, its kind, currency, archived). */
export function updateAccount(account, fields, { now = Date.now() } = {}) {
  const v = validateAccount({ ...account, ...fields });
  if (v.error) return v;
  return { account: normalizeAccount({ ...account, ...v.fields, updatedAt: now }, { now }) };
}

// today: no results for days still to come (left out when an edit only moves or flips one)
function validateEntry(f, today) {
  if (typeof f.accountId !== 'string' || !f.accountId) return { error: 'Pick what it’s for (an account).', field: 'accountId' };
  if (!isKey(f.date)) return { error: 'Pick a day.', field: 'date' };
  if (today && f.date > today) return { error: 'Pick today or a day before it.', field: 'date' };
  const amount = parseSigned(f.amount);
  if (!Number.isFinite(amount)) return { error: 'Type an amount, like 250 (or -120 for a loss).', field: 'amount' };
  if (Math.abs(amount) > AMOUNT_MAX) return { error: 'That amount is too big.', field: 'amount' };
  return { fields: { accountId: f.accountId, date: f.date, amount, note: clean(f.note, ENTRY_NOTE_MAX) } };
}

/** A new result from { accountId, date, amount (signed), note }. -> { entry } | { error, field } */
export function createEntry(fields, { now = Date.now(), today = null, makeId = fallbackId } = {}) {
  const v = validateEntry(fields, today);
  if (v.error) return v;
  return { entry: normalizeEntry({ ...v.fields, id: String(makeId()), createdAt: now, updatedAt: now }, { now, makeId }) };
}

/** The same result with `fields` changed. */
export function updateEntry(entry, fields, { now = Date.now(), today = null } = {}) {
  const v = validateEntry({ ...entry, ...fields }, today);
  if (v.error) return v;
  return { entry: normalizeEntry({ ...entry, ...v.fields, updatedAt: now }, { now }) };
}

/* ---- What is shown: one currency at a time ---- */

/**
 * What the Results view can show, in its menu's order: every account together when they share a
 * currency ('all'), else all accounts of one currency ('cur:NOK', for a currency two or more
 * accounts use), then each account ('acc:<id>'; archived ones last). Each has one currency, so a
 * sum never mixes two. -> [{ id, label, currency, accountIds, kind: 'all' | 'currency' | 'account', archived }]
 */
export function resultScopes(accounts) {
  const ordered = [...accounts.filter((a) => !a.archived), ...accounts.filter((a) => a.archived)];
  const byCurrency = new Map();
  for (const a of ordered) byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a]);
  const out = [];
  if (ordered.length > 1 && byCurrency.size === 1) {
    out.push({ id: 'all', label: 'All accounts', currency: ordered[0].currency, accountIds: ordered.map((a) => a.id), kind: 'all', archived: false });
  } else if (ordered.length > 1) {
    for (const [currency, list] of byCurrency) {
      if (list.length > 1) out.push({ id: `cur:${currency}`, label: `All ${currency} accounts`, currency, accountIds: list.map((a) => a.id), kind: 'currency', archived: false });
    }
  }
  for (const a of ordered) out.push({ id: `acc:${a.id}`, label: a.name, currency: a.currency, accountIds: [a.id], kind: 'account', archived: a.archived });
  return out;
}

/** The scope with this id, else the first one (null without accounts). */
export function resolveScope(accounts, id) {
  const list = resultScopes(accounts);
  return list.find((s) => s.id === id) ?? list[0] ?? null;
}

/** Each day's result for these accounts, oldest first: [{ date, amount, count }] (several entries add up). */
export function dailyResults(entries, accountIds) {
  const ids = new Set(accountIds);
  const byDate = new Map();
  for (const e of entries) {
    if (!ids.has(e.accountId)) continue;
    const d = byDate.get(e.date) ?? { date: e.date, amount: 0, count: 0 };
    d.amount = round2(d.amount + e.amount);
    d.count += 1;
    byDate.set(e.date, d);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The days from `from` to `to` (inclusive; null: no limit) added up: { amount, days, up, down, flat }. */
export function sumDays(days, from = null, to = null) {
  const out = { amount: 0, days: 0, up: 0, down: 0, flat: 0 };
  for (const d of days) {
    if ((from && d.date < from) || (to && d.date > to)) continue;
    out.amount = round2(out.amount + d.amount);
    out.days += 1;
    out[signOf(d.amount)] += 1;
  }
  return out;
}

/** Monday of the week that holds `key` (weeks start on Monday, as in Habits and the Calendar). */
const mondayOf = (key) => shiftKey(key, -((parseKey(key).getDay() + 6) % 7));

/** Today, this week (Monday to Sunday), this month and all time, each as sumDays() gives it. */
export function resultOverview(days, today) {
  const month = today.slice(0, 8);
  return {
    today: sumDays(days, today, today),
    week: sumDays(days, mondayOf(today), shiftKey(mondayOf(today), 6)),
    month: sumDays(days, `${month}01`, `${month}31`),
    all: sumDays(days),
  };
}

/**
 * How the days went: { days, up, down, flat, total, winRate (days up of the days up or down,
 * 0–1; null with neither), average (per day with a result), best, worst ({ date, amount } | null;
 * on a tie the later day) }.
 */
export function resultStats(days) {
  const s = sumDays(days);
  let best = null;
  let worst = null;
  for (const d of days) {
    if (!best || d.amount >= best.amount) best = d;
    if (!worst || d.amount <= worst.amount) worst = d;
  }
  return {
    days: s.days,
    up: s.up,
    down: s.down,
    flat: s.flat,
    total: s.amount,
    winRate: s.up + s.down ? s.up / (s.up + s.down) : null,
    average: s.days ? round2(s.amount / s.days) : 0,
    best: best && { date: best.date, amount: best.amount },
    worst: worst && { date: worst.date, amount: worst.amount },
  };
}

/**
 * Runs of days in a row that went the same way. Only days with a result count, so a weekend
 * without trading doesn't end one; an even day does. { current: { dir, length } (dir null
 * without days), longestUp, longestDown }
 */
export function streaks(days) {
  let dir = null;
  let run = 0;
  let longestUp = 0;
  let longestDown = 0;
  for (const d of days) {
    const s = signOf(d.amount);
    run = s === dir ? run + 1 : 1;
    dir = s;
    if (dir === 'up') longestUp = Math.max(longestUp, run);
    if (dir === 'down') longestDown = Math.max(longestDown, run);
  }
  return { current: { dir, length: run }, longestUp, longestDown };
}

/** The first day a range shows: 7D is today and the 6 days before; ALL starts at the first result. */
export function rangeStart(rangeId, today, days = []) {
  const r = RESULT_RANGES.find((x) => x.id === rangeId) ?? RESULT_RANGES[1];
  if (r.days) return shiftKey(today, -(r.days - 1));
  return days.length && days[0].date < today ? days[0].date : today;
}

/**
 * Progress over a range: one point per calendar day from `from` to `to`, { date, amount (that
 * day's result, 0 without one), total (the running sum since `from`), has (a result that day) }.
 * Days before `from` don't count: the line starts at 0, so above 0 is up over the range.
 */
export function cumulativeSeries(days, from, to) {
  if (!isKey(from) || !isKey(to) || to < from) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out = [];
  let total = 0;
  // (at most about 55 years of days)
  for (let key = from; key <= to && out.length < 20000; key = shiftKey(key, 1)) {
    const d = byDate.get(key);
    if (d) total = round2(total + d.amount);
    out.push({ date: key, amount: d ? d.amount : 0, total, has: !!d });
  }
  return out;
}

/** Round tick values for a money axis that always holds 0: { min, max, step, ticks }. */
export function moneyScale(lo, hi, count = 4) {
  const min = Math.min(0, Number.isFinite(lo) ? lo : 0);
  let max = Math.max(0, Number.isFinite(hi) ? hi : 0);
  if (min === max) max = 1;
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw * (1 - 1e-9)) ?? 10 * mag;
  const from = Math.floor(min / step + 1e-9) * step;
  const to = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = from; v <= to + step / 2; v += step) ticks.push(Number(v.toFixed(10)) || 0);
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/**
 * The days list: months newest first, { month: 'YYYY-MM', amount, up, down, days }, each day
 * { date, amount, entries } newest first, a day's entries in the order they were added.
 */
export function monthGroups(entries, accountIds) {
  const ids = new Set(accountIds);
  const byDate = new Map();
  for (const e of entries) {
    if (!ids.has(e.accountId)) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const days = [...byDate]
    .map(([date, list]) => ({ date, amount: list.reduce((n, e) => round2(n + e.amount), 0), entries: list.slice().sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const months = [];
  for (const d of days) {
    let g = months[months.length - 1];
    if (!g || g.month !== d.date.slice(0, 7)) months.push((g = { month: d.date.slice(0, 7), amount: 0, up: 0, down: 0, days: [] }));
    g.days.push(d);
    g.amount = round2(g.amount + d.amount);
    if (d.amount > 0) g.up += 1;
    else if (d.amount < 0) g.down += 1;
  }
  return months;
}

/** 'October 2026' for '2026-10' */
export function monthName(month) {
  const [y, m] = String(month).split('-').map(Number);
  return MONTH_NAMES[m - 1] ? `${MONTH_NAMES[m - 1]} ${y}` : String(month);
}

/** Every account with this month's and all-time result (its own currency): [{ account, month, all, last }] */
export function accountTotals(accounts, entries, today) {
  const month = today.slice(0, 8);
  return accounts.map((account) => {
    const days = dailyResults(entries, [account.id]);
    return { account, month: sumDays(days, `${month}01`, `${month}31`), all: sumDays(days), last: days.length ? days[days.length - 1].date : null };
  });
}

/** Names people track, for the account dialog's suggestions; each picks its kind (until one is chosen). */
export const ACCOUNT_SUGGESTIONS = Object.freeze(
  [
    { name: 'My shop', kind: 'business' },
    { name: 'Online store', kind: 'business' },
    { name: 'Freelance', kind: 'business' },
    { name: 'Consulting', kind: 'business' },
    { name: 'Forex', kind: 'trading' },
    { name: 'Stocks', kind: 'trading' },
    { name: 'Crypto', kind: 'trading' },
    { name: 'Side hustle', kind: 'other' },
  ].map((s) => Object.freeze(s)),
);

/** The suggested kind for a typed account name (any case), or null. */
export function accountKindFor(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return ACCOUNT_SUGGESTIONS.find((s) => s.name.toLowerCase() === key)?.kind ?? null;
}
