// LIFE/OS — Finance (08): subscriptions. What they cost per month and per year, what is paid
// next, free trials about to turn into payments, cost by category, and what cancelling saves.
// Optional (Show → Daily results): what you made or lost each day, for a business or trading,
// with a graph of the progress. Pure rules live in finance.logic.js; store 'finance' (synced,
// except view).

import { h, icon, registerIcon, pageHeader, emptyState, dropdown, dismissTip, tip, toast, openModal, confirmDialog, todayKey, formatDay, relativeDay, diffDays, onDayChange, isTyping, modalOpen, menuOpen, uid, promptDialog, plural, clamp, checkButton, setChecked, WEEKDAYS_SHORT } from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import * as F from './finance.logic.js';

// The wallet icon is registered by the shell (js/app.js), 'external' by js/sync.panel.js;
// 'briefcase' and 'coins' (an account's kind) are in the shared set (js/icons.js)
registerIcon('fn-results', '<path d="M3 17.5 9 11.5l4 4 8-8.5"/><path d="M15.5 7H21v5.5"/>');

/* ==========================================================================
   Store
   ========================================================================== */

const store = createStore('finance', F.DEFAULT_STATE);
let cacheRaw = null;
let cacheState = null;

function getState() {
  const raw = store.get();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheState = F.normalizeState(raw);
  }
  return cacheState;
}

function commit(next) {
  cacheRaw = next;
  cacheState = next;
  store.set(next);
}

const findSub = (id) => getState().subscriptions.find((s) => s.id === id) ?? null;
const findEntry = (id) => getState().entries.find((e) => e.id === id) ?? null;
const findAccount = (id) => getState().accounts.find((a) => a.id === id) ?? null;

function setView(patch) {
  const s = getState();
  if (Object.keys(patch).every((k) => s.view[k] === patch[k])) return;
  commit({ ...s, view: { ...s.view, ...patch } });
}

function setSubs(fn) {
  const s = getState();
  const subscriptions = fn(s.subscriptions);
  if (subscriptions !== s.subscriptions) commit({ ...s, subscriptions });
}

function setEntries(fn) {
  const s = getState();
  const entries = fn(s.entries);
  if (entries !== s.entries) commit({ ...s, entries });
}

function setAccounts(fn) {
  const s = getState();
  const accounts = fn(s.accounts);
  if (accounts !== s.accounts) commit({ ...s, accounts });
}

/** Daily results on or off: the switch syncs (the phone shows it too); the view opened is this device's. */
function setResultsOn(on) {
  const s = getState();
  if (s.results.on === on) return;
  commit({ ...s, results: { ...s.results, on, updatedAt: Date.now() }, view: { ...s.view, tab: on ? 'results' : 'subs' } });
  toast(on ? 'Daily results is on: switch between Subscriptions and Results under the title.' : 'Daily results is off. Your results are kept; turn it on again under Show.');
}

/* ==========================================================================
   Money
   ========================================================================== */

const formats = new Map();

/** money(129.9, 'NOK') -> 'kr 129.90' / '129,90 kr' (the browser's own way); whole amounts drop the cents. */
function money(amount, currency, { round = false } = {}) {
  const n = round ? Math.round(amount) : amount;
  const cents = !round && Math.round(n * 100) % 100 !== 0;
  const key = `${currency}${cents}`;
  if (!formats.has(key)) {
    try {
      formats.set(key, new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }));
    } catch {
      formats.set(key, { format: (v) => `${v.toFixed(cents ? 2 : 0)} ${currency}` });
    }
  }
  return formats.get(key).format(n);
}

/** Several currencies: '1 240 kr + $20' */
const moneyList = (list, opts) => list.map((m) => money(m.amount, m.currency, opts)).join(' + ');

const MINUS = '−';

/** A result always says which way it went: '+kr 1,240' · '−kr 300' · 'kr 0'. */
function signedMoney(amount, currency, opts) {
  const v = Math.abs(amount) < 0.005 ? 0 : amount;
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${money(Math.abs(v), currency, opts)}`;
}

const compactFormats = new Map();

/** The graph's axis: short sums ('kr 1.2K', '−kr 500', 'kr 0'). */
function axisMoney(v, currency) {
  if (!compactFormats.has(currency)) {
    try {
      compactFormats.set(currency, new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 }));
    } catch {
      compactFormats.set(currency, { format: (x) => `${Math.round(x)} ${currency}` });
    }
  }
  return `${v < 0 ? MINUS : ''}${compactFormats.get(currency).format(Math.abs(v))}`;
}

/** A first currency for someone new: the one of the time zone they are in. */
function guessCurrency() {
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* no Intl time zone */
  }
  const byZone = { 'Europe/Oslo': 'NOK', 'Europe/Stockholm': 'SEK', 'Europe/Copenhagen': 'DKK', 'Europe/London': 'GBP', 'Europe/Zurich': 'CHF', 'Europe/Warsaw': 'PLN', 'Asia/Tokyo': 'JPY', 'America/Toronto': 'CAD', 'America/Vancouver': 'CAD' };
  if (byZone[zone]) return byZone[zone];
  if (zone.startsWith('Europe/')) return 'EUR';
  if (zone.startsWith('Australia/')) return 'AUD';
  return 'USD';
}

/** New subscriptions (and accounts) start in the currency of the last subscription added (or the guess). */
function defaultCurrency() {
  const subs = getState().subscriptions;
  const last = subs.reduce((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  return last?.currency ?? guessCurrency();
}

/* ==========================================================================
   Small builders
   ========================================================================== */

const btn = (label, onClick, { iconName, primary = false, ghost = false, small = true, title, aria } = {}) =>
  h(
    'button',
    { type: 'button', class: ['btn', small && 'btn--sm', primary && 'btn--primary', ghost && 'btn--ghost', !label && 'btn--icon'], title: title ?? null, 'aria-label': aria ?? null, onClick },
    iconName ? icon(iconName, { size: 14 }) : null,
    label || null,
  );

function seg(label, options, value, onChange, className) {
  const buttons = options.map((o) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(o.value === value), dataset: { value: o.value }, onClick: () => onChange(o.value) }, o.label));
  const el = h('div', { class: ['seg', className], role: 'group', 'aria-label': label }, buttons);
  return {
    el,
    set: (v) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v))),
  };
}

/** 'Today' · 'Tomorrow' · 'In 3 days · Mon 12 Oct' · 'Fri 30 Oct' */
function whenText(date, today) {
  const rel = relativeDay(date, today);
  return rel === formatDay(date) ? rel : rel.startsWith('In ') ? `${rel} · ${formatDay(date)}` : rel;
}

/** A row's 'Next in 3 days · Tue 20 Oct' chip. 'in 3 days · ' gets its own span, so a template can
 *  show the date alone (Minimal: 'Next Tue 20 Oct', css/skins/minimal.css); the text is the same.
 *  One inner span holds it all: the chip is a flex box, which would drop the spaces between parts. */
function nextTag(date, today, soon) {
  const text = `Next ${whenText(date, today).replace(/^(Today|Tomorrow|In )/, (w) => w.toLowerCase())}`;
  const parts = text.match(/^Next (in \d+ days · )(.+)$/);
  return h(
    'span',
    { class: ['tag', 'fn-next', soon && 'tag--solid'] },
    parts ? h('span', null, 'Next ', h('span', { class: 'fn-next-rel' }, parts[1]), parts[2]) : text,
  );
}

const initial = (name) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase();

const GLYPH = { up: '▲', down: '▼', flat: '' };

/** A result: its sign and sum, with ▲ / ▼ before it (the shape and the sign say which way, not a color). */
function resultAmount(amount, currency, { className = '', glyph = true } = {}) {
  const dir = F.signOf(amount);
  return h(
    'span',
    { class: ['fn-amt', `is-${dir}`, className], dataset: { dir } },
    glyph && dir !== 'flat' ? h('span', { class: 'fn-glyph', 'aria-hidden': 'true' }, `${GLYPH[dir]}\u2009`) : null,
    signedMoney(amount, currency),
  );
}

/** 'Fri 23' within a month's list ('Today', 'Yesterday' for those) */
function dayShort(date, today) {
  const n = diffDays(date, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  const [, , d] = date.split('-').map(Number);
  return `${WEEKDAYS_SHORT[new Date(`${date}T12:00`).getDay()]} ${d}`;
}

/* ==========================================================================
   Page
   ========================================================================== */

function mount(root) {
  root.classList.add('fn-root');
  const cleanups = [];

  // The totals are one line beside the title (the header's stat): 'kr 219/mo · kr 2,628/yr ·
  // next: Netflix Thu'. Each part keeps its words together, so a narrow screen wraps the line
  // between parts and never cuts a sum short. With Results open it is that view's line instead.
  const statEl = h('span', { class: 'fn-sum' });
  // On a phone it reads "Add" (its name stays "Add subscription"): beside Show ▾ the full words
  // cut the title short in the wider templates
  const addSubBtn = h(
    'button',
    { type: 'button', class: 'btn btn--primary fn-add-sub', title: 'Add subscription', 'aria-label': 'Add subscription', onClick: () => openEditor() },
    icon('plus', { size: 14 }),
    h('span', { class: 'fn-add-long' }, 'Add subscription'),
    h('span', { class: 'fn-add-short', 'aria-hidden': 'true' }, 'Add'),
  );
  // Show ▾ · Daily results: the option, ticked or not (off: Finance is subscriptions only)
  const showDd = dropdown({
    label: 'Show',
    icon: 'eye',
    multi: true,
    items: [],
    className: 'fn-show-btn',
    title: 'What Finance shows',
    menuLabel: 'Show in Finance',
    ariaLabel: () => `Show: daily results ${getState().results.on ? 'on' : 'off'}`,
    onSelect: (value, on) => value === 'results' && setResultsOn(on),
  });
  const header = pageHeader({
    index: '08',
    title: 'Finance',
    subtitle: 'Your subscriptions: what they cost, and when they renew.',
    tipId: 'finance.intro',
    stat: statEl,
    actions: [showDd.el, addSubBtn],
  });

  // Subscriptions · Results: tabs under the page top while Daily results is on
  const tabIds = { subs: `fn-tab-subs-${uid()}`, results: `fn-tab-results-${uid()}` };
  const tabBtn = (id, label, iconName) =>
    h('button', { type: 'button', role: 'tab', id: tabIds[id], class: 'seg-btn fn-tab', 'aria-selected': 'false', tabindex: '-1', dataset: { tab: id }, onClick: () => setView({ tab: id }) }, icon(iconName, { size: 14 }), h('span', null, label));
  const tabEls = [tabBtn('subs', 'Subscriptions', 'repeat'), tabBtn('results', 'Results', 'fn-results')];
  const onTabKey = (e) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const at = tabEls.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const to = { ArrowRight: (at + 1) % 2, ArrowLeft: (at + 1) % 2, Home: 0, End: 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setView({ tab: tabEls[to].dataset.tab });
    tabEls[to].focus();
  };
  const tabsEl = h('div', { class: 'seg fn-tabs', role: 'tablist', 'aria-label': 'Finance views', hidden: true, onKeydown: onTabKey }, tabEls);

  const bodyEl = h('div', { class: 'fn-body' });
  // Built the first time Results opens
  let results = null;
  const resultsEl = h('div', { class: 'fn-results', hidden: true });
  root.append(header, tabsEl, bodyEl, resultsEl);

  function render() {
    const s = getState();
    const today = todayKey();
    const on = s.results.on;
    const tab = on ? s.view.tab : 'subs';
    paintChrome(on, tab);
    if (tab === 'results') {
      results ??= resultsView({ el: resultsEl, setStat: (v) => header.setStat(v) });
      results.render(s, today);
      return;
    }
    const subs = s.subscriptions;
    const focusId = document.activeElement?.closest?.('.fn-row[data-id]')?.dataset.id;
    const sortFocused = !!document.activeElement?.closest?.('.fn-root .fn-sort-btn');
    renderStat(subs, today);
    if (!subs.length) {
      bodyEl.replaceChildren(emptyView());
      return;
    }
    bodyEl.replaceChildren(
      h('div', { class: 'fn-main' }, listPanel(s, today)),
      h('div', { class: 'fn-side' }, upcomingPanel(subs, today), categoryPanel(subs)),
    );
    if (focusId) bodyEl.querySelector(`.fn-row[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    else if (sortFocused) bodyEl.querySelector('.fn-sort-btn')?.focus({ preventScroll: true });
  }

  /* ---- The option, the tabs and which view shows ---- */

  function paintChrome(on, tab) {
    showDd.update({ items: [{ value: 'results', label: 'Daily results', checked: on }] });
    tabsEl.hidden = !on;
    for (const b of tabEls) {
      const picked = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(picked));
      b.tabIndex = picked ? 0 : -1;
    }
    // Off: the subscriptions exactly as before (no tab panel roles)
    for (const [el, id] of [[bodyEl, 'subs'], [resultsEl, 'results']]) {
      el.hidden = tab !== id;
      if (on) {
        el.setAttribute('role', 'tabpanel');
        el.setAttribute('aria-labelledby', tabIds[id]);
      } else {
        el.removeAttribute('role');
        el.removeAttribute('aria-labelledby');
      }
    }
    addSubBtn.hidden = tab === 'results';
    // The subscriptions' explanation waits while Results shows (its own tip explains it)
    header.querySelector('.page-tip')?.toggleAttribute('hidden', tab === 'results');
  }

  /* ---- Totals: the header's stat ---- */

  function renderStat(subs, today) {
    const sum = F.summary(subs, today);
    const part = (cls, ...children) => h('span', { class: ['fn-sum-part', cls] }, ...children);
    const parts = [];
    if (sum.month.length) {
      parts.push(part('fn-sum-month', h('strong', { class: 'fn-sum-total' }, moneyList(sum.month, { round: true })), '/mo'));
      parts.push(part('fn-sum-year', `${moneyList(sum.year, { round: true })}/yr`));
    } else if (subs.length) {
      parts.push(part('fn-sum-none', sum.live ? 'Nothing to pay yet' : 'Nothing active'));
    }
    if (sum.next) parts.push(part('fn-sum-next', `next: ${sum.next.sub.name} ${F.shortWhen(sum.next.date, today)}${sum.next.trialEnd ? ', trial ends' : ''}`));
    // The dot is tied to the part before it (a no-break space), so a wrapped line never starts with one
    statEl.replaceChildren(...parts.flatMap((p, i) => (i ? [h('span', { class: 'fn-sum-sep', 'aria-hidden': 'true' }, '\u00a0· '), p] : [p])));
    // No subscriptions: no line at all
    header.setStat(parts.length ? statEl : null);
  }

  /* ---- The list ---- */

  function listPanel(s, today) {
    const subs = s.subscriptions;
    const live = F.sortSubs(subs.filter((x) => x.status === 'active' || x.status === 'trial'), s.view.sort, today);
    const paused = F.sortSubs(subs.filter((x) => x.status === 'paused'), s.view.sort, today);
    const cancelled = F.sortSubs(subs.filter((x) => x.status === 'cancelled'), 'name', today);
    // One quiet word with a caret, not three buttons where column heads would be
    const sort = dropdown({
      icon: 'sort',
      items: [
        { value: 'next', label: 'Next payment' },
        { value: 'price', label: 'Price' },
        { value: 'name', label: 'Name' },
      ],
      value: s.view.sort,
      onSelect: (v) => setView({ sort: v }),
      align: 'end',
      className: 'btn--ghost fn-sort-btn',
      menuLabel: 'Sort by',
      ariaLabel: ({ picked }) => `Sort by ${picked?.label.toLowerCase() ?? 'next payment'}`,
    });
    const group = (title, list) => (list.length ? [h('h3', { class: 'fn-group label' }, title), h('ul', { class: 'fn-list', role: 'list' }, list.map((x) => row(x, today)))] : []);
    const saved = F.savings(subs);
    const cancelToggle = cancelled.length
      ? h(
          'button',
          { type: 'button', class: 'fn-cancelled-toggle', 'aria-expanded': String(s.view.showCancelled), onClick: () => setView({ showCancelled: !s.view.showCancelled }) },
          icon('chevron-down', { size: 14, className: 'fn-caret' }),
          h('span', null, `Cancelled (${cancelled.length})`),
          saved.length ? h('span', { class: 'fn-saved' }, `saving ${moneyList(saved, { round: true })} a month`) : null,
        )
      : null;
    return h(
      'section',
      { class: 'panel hud fn-panel fn-subs', 'aria-label': 'Subscriptions' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'Subscriptions'), sort.el),
      live.length ? h('ul', { class: 'fn-list', role: 'list' }, live.map((x) => row(x, today))) : h('p', { class: 'fn-none' }, 'Nothing active right now.'),
      ...group('Paused', paused),
      cancelToggle,
      cancelled.length && s.view.showCancelled ? h('ul', { class: 'fn-list fn-list--cancelled', role: 'list' }, cancelled.map((x) => row(x, today))) : null,
    );
  }

  function row(sub, today) {
    const next = F.nextPayment(sub, today);
    const monthly = sub.unit !== 'month' || sub.every !== 1;
    const status =
      sub.status === 'trial'
        ? h('span', { class: 'tag fn-tag-trial' }, next ? `Free trial · ends ${formatDay(next)}` : 'Free trial')
        : sub.status === 'paused'
          ? h('span', { class: 'tag tag--dashed' }, 'Paused')
          : sub.status === 'cancelled'
            ? h('span', { class: 'tag tag--dashed' }, sub.cancelledAt ? `Cancelled ${formatDay(sub.cancelledAt)}` : 'Cancelled')
            : null;
    const url = F.safeUrl(sub.url);
    const soon = !!next && sub.status === 'active' && diffDays(today, next) <= 3;
    return h(
      'li',
      {
        class: ['fn-row', `is-${sub.status}`, soon && 'is-soon'],
        tabindex: '0',
        dataset: { id: sub.id },
        // The row is the way to edit (there's no pencil button): its name says so, and its state
        'aria-label': `${sub.name}, ${money(sub.amount, sub.currency)} ${F.cycleLabel(sub).toLowerCase()}${sub.status === 'active' ? '' : `, ${sub.status === 'trial' ? 'free trial' : sub.status}`}${next ? `, next payment ${formatDay(next, 'long')}` : ''}. Enter to edit`,
        onClick: (e) => {
          if (e.target.closest('a, button')) return;
          openEditor(sub.id);
        },
        onKeydown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openEditor(sub.id);
          }
        },
      },
      // The category's icon (TV, music, dumbbell…): a list of subscriptions scans by its icons
      h('span', { class: 'fn-avatar', 'aria-hidden': 'true' }, icon(F.categoryIcon(sub.category), { size: 18 })),
      h(
        'div',
        { class: 'fn-row-main' },
        h('span', { class: 'fn-name' }, sub.name),
        h(
          'span',
          { class: 'fn-meta' },
          h('span', { class: 'tag fn-cat' }, F.categoryName(sub.category)),
          status,
          next && sub.status === 'active' ? nextTag(next, today, soon) : null,
        ),
      ),
      // The site you saved, before the price (so every price ends on the row's right edge). The
      // row itself opens the editor (click, Enter, or Edit… in its right-click menu)
      url
        ? h(
            'div',
            { class: 'row-actions fn-row-actions' },
            h('a', { class: 'btn btn--ghost btn--icon btn--sm', href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Manage or cancel (opens their site)', 'aria-label': `Open ${sub.name}’s site` }, icon('external', { size: 14 })),
          )
        : null,
      h(
        'div',
        { class: 'fn-row-price' },
        h('span', { class: 'fn-price' }, money(sub.amount, sub.currency), h('span', { class: 'fn-per' }, ` ${F.cycleShort(sub)}`)),
        monthly ? h('span', { class: 'fn-monthly' }, `≈ ${money(F.perMonth(sub), sub.currency, { round: true })} / mo`) : null,
      ),
    );
  }

  /* ---- Coming up ---- */

  function upcomingPanel(subs, today) {
    const items = F.upcoming(subs, today, 30);
    const due = new Map();
    for (const u of items) due.set(u.sub.currency, (due.get(u.sub.currency) ?? 0) + u.sub.amount);
    const dueList = [...due].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
    return h(
      'section',
      { class: 'panel hud fn-panel fn-upcoming', 'aria-label': 'Next 30 days' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'Next 30 days'), dueList.length ? h('span', { class: 'fn-due' }, moneyList(dueList)) : null),
      items.length
        ? h(
            'ol',
            { class: 'fn-up-list' },
            items.slice(0, 12).map((u) =>
              h(
                'li',
                { class: ['fn-up', u.inDays <= 3 && 'is-soon'] },
                h('span', { class: 'fn-up-when' }, u.inDays === 0 ? 'Today' : u.inDays === 1 ? 'Tomorrow' : formatDay(u.date)),
                h('button', { type: 'button', class: 'fn-up-name', onClick: () => openEditor(u.sub.id) }, u.sub.name, u.trialEnd ? h('span', { class: 'fn-up-trial' }, ' · trial ends') : null),
                h('span', { class: 'fn-up-amount tnum' }, money(u.sub.amount, u.sub.currency)),
              ),
            ),
          )
        : h('p', { class: 'fn-none' }, 'Nothing to pay in the next 30 days.'),
      items.length > 12 ? h('p', { class: 'fn-more' }, `+ ${items.length - 12} more`) : null,
    );
  }

  /* ---- By category ---- */

  function categoryPanel(subs) {
    const currency = F.mainCurrency(subs.filter((x) => x.status === 'active'), defaultCurrency());
    const cats = F.byCategory(subs, currency);
    if (!cats.length) return null;
    const others = new Set(subs.filter((x) => x.status === 'active' && x.currency !== currency).map((x) => x.currency));
    return h(
      'section',
      { class: 'panel hud fn-panel fn-cats', 'aria-label': 'By category' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'By category'), h('span', { class: 'fn-due' }, 'per month')),
      h(
        'ul',
        { class: 'fn-cat-list', role: 'list' },
        cats.map((c) =>
          h(
            'li',
            { class: 'fn-cat-row' },
            h('span', { class: 'fn-cat-name' }, F.categoryName(c.category), h('span', { class: 'fn-cat-count' }, ` · ${c.count}`)),
            h('span', { class: 'fn-cat-amount tnum' }, money(c.amount, currency, { round: true })),
            h('span', { class: 'fn-cat-bar', 'aria-hidden': 'true' }, h('span', { class: 'fn-cat-fill', style: { width: `${Math.max(2, Math.round(c.share * 100))}%` } })),
          ),
        ),
      ),
      others.size ? h('p', { class: 'fn-more' }, `${currency} only; ${[...others].join(', ')} counted in the totals.`) : null,
    );
  }

  /* ---- Nothing yet ---- */

  // The shared empty state; its quick starters fill in a name (Add subscription is the header's)
  function emptyView() {
    const el = emptyState({
      icon: 'wallet',
      title: 'No subscriptions yet',
      text: 'Add what you pay for every month or year: LIFE/OS adds it up and shows what’s due next. It only knows what you type in, not your bank.',
      action: h(
        'div',
        { class: 'fn-starters', role: 'group', 'aria-label': 'Quick add' },
        F.SUGGESTIONS.slice(0, 8).map((s) => h('button', { type: 'button', class: 'btn btn--sm', onClick: () => openEditor(null, { name: s.name, category: s.category }) }, icon('plus', { size: 13 }), s.name)),
      ),
    });
    el.classList.add('fn-empty');
    return el;
  }

  /* ---- Right-click: copy, paste, duplicate, delete ---- */

  cleanups.push(
    registerContextProvider('finance', (el) => {
      if (!root.contains(el)) return null;
      // Daily results: a day's entry or an account (Results view)
      const entryEl = el.closest('[data-entry]');
      if (entryEl) return entryTarget(entryEl);
      const accountEl = el.closest('[data-account]');
      if (accountEl) return accountTarget(accountEl);
      // (a blank part of Results has nothing to paste: the browser's own menu)
      if (resultsEl.contains(el)) return null;
      const rowEl = el.closest('.fn-row[data-id]');
      const sub = rowEl ? findSub(rowEl.dataset.id) : null;
      const paste = { accepts: ['subscription'], paste: (c) => insertCopy(c.snapshot, { verb: 'Pasted' }) };
      if (!sub) return { kind: null, id: null, label: 'Finance', el: null, ...paste };
      return {
        kind: 'subscription',
        id: sub.id,
        label: `Subscription: ${sub.name}`,
        el: rowEl,
        ...paste,
        copy: () => {
          const cur = findSub(sub.id);
          return cur ? { kind: 'subscription', snapshot: snapshotOf(cur), text: F.subscriptionText(cur) } : null;
        },
        remove: () => removeSub(sub.id),
        duplicate: () => insertCopy(snapshotOf(sub), { verb: 'Duplicated' }),
        edit: () => openEditor(sub.id),
        rename: async () => {
          const name = await promptDialog({ title: 'Rename subscription', value: sub.name, maxLength: F.NAME_MAX });
          const cur = findSub(sub.id);
          if (name === null || !cur || name === cur.name) return;
          const res = F.updateSubscription(cur, { name }, { now: Date.now(), today: todayKey() });
          if (!res.error) setSubs((list) => list.map((x) => (x.id === cur.id ? res.sub : x)));
        },
      };
    }),
  );

  // N: add a subscription (like N for a new task); in Results, the quick add's amount
  const onKey = (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen() || menuOpen()) return;
    e.preventDefault();
    const s = getState();
    if (s.results.on && s.view.tab === 'results') results?.focusAdd();
    else openEditor();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  render();
  cleanups.push(store.subscribe(render));
  cleanups.push(onDayChange(render));
  cleanups.push(() => results?.destroy());
  return () => cleanups.forEach((off) => off());
}

/* ==========================================================================
   Edits
   ========================================================================== */

function snapshotOf(sub) {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = sub;
  return rest;
}

function insertCopy(snapshot, { verb = 'Pasted' } = {}) {
  const res = F.createSubscription({ ...snapshot, status: snapshot.status === 'cancelled' ? 'active' : snapshot.status }, { now: Date.now(), today: todayKey(), makeId: uid });
  if (res.error) {
    toast(`Couldn’t paste: ${res.error}`);
    return;
  }
  setSubs((list) => [...list, res.sub]);
  toast(`${verb} “${res.sub.name}”`, { action: { label: 'Undo', onClick: () => setSubs((list) => list.filter((x) => x.id !== res.sub.id)) } });
}

function removeSub(id) {
  const s = getState();
  const at = s.subscriptions.findIndex((x) => x.id === id);
  if (at < 0) return;
  const gone = s.subscriptions[at];
  setSubs((list) => list.filter((x) => x.id !== id));
  toast(`“${gone.name}” deleted.`, {
    action: {
      label: 'Undo',
      onClick: () =>
        setSubs((list) => {
          if (list.some((x) => x.id === gone.id)) return list;
          const next = list.slice();
          next.splice(Math.min(at, next.length), 0, gone);
          return next;
        }),
    },
  });
}

/* ---- Daily results ---- */

const accountName = (id) => findAccount(id)?.name ?? 'an account';
const accountCurrency = (id) => findAccount(id)?.currency ?? defaultCurrency();
const dayWords = (date) => (date === todayKey() ? 'today' : formatDay(date));

/** A new result; its account is touched (usedAt), so a delete of it on another device can't drop it. */
function addEntry(entry, { verb = 'Added' } = {}) {
  const s = getState();
  const now = Date.now();
  commit({ ...s, entries: [...s.entries, entry], accounts: s.accounts.map((a) => (a.id === entry.accountId ? { ...a, usedAt: now } : a)) });
  // The Results tip has done its job once something is in
  dismissTip('finance.results');
  toast(`${verb} ${signedMoney(entry.amount, accountCurrency(entry.accountId))} for ${accountName(entry.accountId)}, ${dayWords(entry.date)}.`, {
    action: { label: 'Undo', onClick: () => setEntries((list) => list.filter((e) => e.id !== entry.id)) },
  });
}

function replaceEntry(next) {
  setEntries((list) => list.map((e) => (e.id === next.id ? next : e)));
}

function removeEntry(id) {
  const s = getState();
  const at = s.entries.findIndex((e) => e.id === id);
  if (at < 0) return;
  const gone = s.entries[at];
  setEntries((list) => list.filter((e) => e.id !== id));
  toast(`${signedMoney(gone.amount, accountCurrency(gone.accountId))} on ${formatDay(gone.date)} deleted.`, {
    action: {
      label: 'Undo',
      onClick: () =>
        setEntries((list) => {
          if (list.some((e) => e.id === gone.id)) return list;
          const next = list.slice();
          next.splice(Math.min(at, next.length), 0, gone);
          return next;
        }),
    },
  });
}

function duplicateEntry(id) {
  const cur = findEntry(id);
  if (!cur) return;
  const res = F.createEntry(cur, { now: Date.now(), makeId: uid });
  if (!res.error) addEntry(res.entry, { verb: 'Duplicated:' });
}

/** Made ↔ lost, from the right-click menu (a sign typed the wrong way) */
function flipEntry(id) {
  const cur = findEntry(id);
  if (!cur || !cur.amount) return;
  const res = F.updateEntry(cur, { amount: -cur.amount }, { now: Date.now() });
  if (res.error) return;
  replaceEntry(res.entry);
  toast(`Now ${signedMoney(res.entry.amount, accountCurrency(cur.accountId))} on ${formatDay(cur.date)}.`, { action: { label: 'Undo', onClick: () => replaceEntry({ ...cur, updatedAt: Date.now() }) } });
}

function moveEntry(id, accountId) {
  const cur = findEntry(id);
  if (!cur || cur.accountId === accountId || !findAccount(accountId)) return;
  const res = F.updateEntry(cur, { accountId }, { now: Date.now() });
  if (res.error) return;
  replaceEntry(res.entry);
  toast(`Moved to ${accountName(accountId)}.`, { action: { label: 'Undo', onClick: () => replaceEntry({ ...cur, updatedAt: Date.now() }) } });
}

function setArchived(id, archived) {
  const cur = findAccount(id);
  if (!cur || cur.archived === archived) return;
  const res = F.updateAccount(cur, { archived }, { now: Date.now() });
  if (res.error) return;
  setAccounts((list) => list.map((a) => (a.id === id ? res.account : a)));
  toast(archived ? `“${cur.name}” archived: it’s no longer offered when you add a result. Its days still count.` : `“${cur.name}” is back.`, {
    action: { label: 'Undo', onClick: () => setAccounts((list) => list.map((a) => (a.id === id ? { ...a, archived: !archived, updatedAt: Date.now() } : a))) },
  });
}

/** Delete an account and its results: asks first when it has some (archive keeps them). */
async function removeAccount(id) {
  const cur = findAccount(id);
  if (!cur) return;
  const count = getState().entries.filter((e) => e.accountId === id).length;
  if (count) {
    const sure = await confirmDialog({
      title: `Delete “${cur.name}”?`,
      message: `Its ${plural(count, 'result')} go too. To keep them, archive it instead (Edit → Archived).`,
      confirmLabel: 'Delete',
    });
    if (!sure) return;
  }
  const s = getState();
  const at = s.accounts.findIndex((a) => a.id === id);
  if (at < 0) return;
  const account = s.accounts[at];
  const gone = s.entries.filter((e) => e.accountId === id);
  commit({ ...s, accounts: s.accounts.filter((a) => a.id !== id), entries: s.entries.filter((e) => e.accountId !== id) });
  toast(`“${account.name}” deleted${gone.length ? ` with ${plural(gone.length, 'result')}` : ''}.`, {
    action: {
      label: 'Undo',
      onClick: () => {
        const now = getState();
        if (now.accounts.some((a) => a.id === id)) return;
        const accounts = now.accounts.slice();
        accounts.splice(Math.min(at, accounts.length), 0, account);
        const have = new Set(now.entries.map((e) => e.id));
        commit({ ...now, accounts, entries: [...now.entries, ...gone.filter((e) => !have.has(e.id))] });
      },
    },
  });
}

async function renameAccount(id) {
  const cur = findAccount(id);
  if (!cur) return;
  const name = await promptDialog({ title: 'Rename account', value: cur.name, maxLength: F.NAME_MAX });
  const now = findAccount(id);
  if (name === null || !now || name === now.name) return;
  const res = F.updateAccount(now, { name }, { now: Date.now() });
  if (!res.error) setAccounts((list) => list.map((a) => (a.id === id ? res.account : a)));
}

/* ---- Right-click on Daily results ---- */

function entryTarget(rowEl) {
  const entry = findEntry(rowEl.dataset.entry);
  if (!entry) return null;
  const s = getState();
  const currency = accountCurrency(entry.accountId);
  const others = s.accounts.filter((a) => !a.archived || a.id === entry.accountId);
  return {
    kind: 'result',
    id: entry.id,
    label: `Result: ${signedMoney(entry.amount, currency)} on ${formatDay(entry.date)}`,
    el: rowEl,
    actions: [
      { id: 'flip', label: entry.amount < 0 ? 'Make it a gain' : 'Make it a loss', icon: 'repeat', disabled: !entry.amount, run: () => flipEntry(entry.id) },
      others.length > 1
        ? { id: 'account', label: 'Account', icon: 'wallet', children: others.map((a) => ({ id: `acc-${a.id}`, label: `${a.name} (${a.currency})`, checked: a.id === entry.accountId, run: () => moveEntry(entry.id, a.id) })) }
        : null,
    ].filter(Boolean),
    edit: () => openEntryEditor(entry.id),
    duplicate: () => duplicateEntry(entry.id),
    remove: () => removeEntry(entry.id),
  };
}

function accountTarget(rowEl) {
  const account = findAccount(rowEl.dataset.account);
  if (!account) return null;
  return {
    kind: 'account',
    id: account.id,
    label: `Account: ${account.name}`,
    el: rowEl,
    actions: [
      { id: 'show', label: 'Show its results', icon: 'eye', run: () => setView({ scope: `acc:${account.id}` }) },
      { id: 'archive', label: account.archived ? 'Unarchive' : 'Archive', icon: 'archive', run: () => setArchived(account.id, !account.archived) },
    ],
    edit: () => openAccountEditor(account.id),
    rename: () => renameAccount(account.id),
    remove: () => removeAccount(account.id),
  };
}

/* ==========================================================================
   The dialog: add or edit a subscription
   ========================================================================== */

function openEditor(id = null, preset = {}) {
  const existing = id ? findSub(id) : null;
  const today = todayKey();
  const start = existing ?? { name: preset.name ?? '', amount: '', currency: defaultCurrency(), every: 1, unit: 'month', billingDate: today, status: 'active', trialEnds: null, category: preset.category ?? 'other', url: '', note: '' };
  // The date shown is the next payment from the stored one (an old date would read as the past)
  const shownDate = existing?.billingDate ? F.nextPayment({ ...existing, status: 'active' }, today) : today;
  let categoryTouched = !!existing || !!preset.category;

  const fid = (name) => `fn-ed-${name}`;
  const err = h('p', { class: 'fn-ed-error', role: 'alert', hidden: true });
  const listId = fid('suggest');

  const nameIn = h('input', { id: fid('name'), class: 'input', type: 'text', value: start.name, maxlength: String(F.NAME_MAX), placeholder: 'Netflix, Spotify, gym…', autocomplete: 'off', list: listId });
  const amountIn = h('input', { id: fid('amount'), class: 'input fn-ed-amount', type: 'text', inputmode: 'decimal', value: start.amount === '' ? '' : String(start.amount), placeholder: '129', autocomplete: 'off' });
  const currencies = F.CURRENCIES.includes(start.currency) ? F.CURRENCIES : [start.currency, ...F.CURRENCIES];
  const currencyIn = h('select', { id: fid('currency'), class: 'select fn-ed-currency', 'aria-label': 'Currency' }, currencies.map((c) => h('option', { value: c }, c)));
  currencyIn.value = start.currency;
  const everyIn = h('input', { id: fid('every'), class: 'input fn-ed-every', type: 'number', min: '1', max: String(F.EVERY_MAX), step: '1', value: String(start.every), 'aria-label': 'Every how many' });
  const unitIn = h('select', { id: fid('unit'), class: 'select fn-ed-unit', 'aria-label': 'Weeks, months or years' }, [h('option', { value: 'week' }, 'week(s)'), h('option', { value: 'month' }, 'month(s)'), h('option', { value: 'year' }, 'year(s)')]);
  unitIn.value = start.unit;
  const statusSeg = seg(
    'Status',
    F.STATUSES.map((v) => ({ value: v, label: F.STATUS_LABEL[v] })),
    start.status,
    (v) => {
      status = v;
      statusSeg.set(v);
      paintStatus();
    },
    'fn-ed-status',
  );
  let status = start.status;
  const dateIn = h('input', { id: fid('date'), class: 'input', type: 'date', value: shownDate ?? '' });
  const trialIn = h('input', { id: fid('trial'), class: 'input', type: 'date', value: start.trialEnds ?? '' });
  const categoryIn = h('select', { id: fid('category'), class: 'select' }, F.CATEGORIES.map((c) => h('option', { value: c.id }, c.name)));
  categoryIn.value = start.category;
  categoryIn.addEventListener('change', () => (categoryTouched = true));
  const urlIn = h('input', { id: fid('url'), class: 'input', type: 'url', value: start.url, placeholder: 'netflix.com/account', autocomplete: 'off' });
  const noteIn = h('textarea', { id: fid('note'), class: 'textarea', rows: '2', placeholder: 'Shared with family, student price…' });
  noteIn.value = start.note ?? '';

  // A known service picks its category (until you choose one yourself)
  nameIn.addEventListener('input', () => {
    const s = F.suggestionFor(nameIn.value);
    if (s && !categoryTouched) categoryIn.value = s.category;
  });

  const dateField = h('div', { class: 'field' }, h('label', { class: 'label', for: dateIn.id }, 'Next payment'), dateIn);
  // How LIFE/OS counts, not a fact about the service: it only knows the date typed in here
  const trialField = h('div', { class: 'field' }, h('label', { class: 'label', for: trialIn.id }, 'Free trial ends'), trialIn, h('p', { class: 'fn-ed-hint' }, 'LIFE/OS counts the first payment on that day. It shows under Next 30 days once it’s that close.'));
  function paintStatus() {
    dateField.hidden = status === 'trial' || status === 'cancelled';
    trialField.hidden = status !== 'trial';
  }
  paintStatus();

  function fail(message, field) {
    err.textContent = message;
    err.hidden = false;
    const el = { name: nameIn, amount: amountIn, every: everyIn, billingDate: dateIn, trialEnds: trialIn }[field];
    el?.setAttribute('aria-invalid', 'true');
    el?.focus();
  }

  function save() {
    [nameIn, amountIn, everyIn, dateIn, trialIn].forEach((el) => el.removeAttribute('aria-invalid'));
    const fields = {
      name: nameIn.value,
      amount: amountIn.value,
      currency: currencyIn.value,
      every: Number(everyIn.value),
      unit: unitIn.value,
      billingDate: dateIn.value || null,
      status,
      trialEnds: trialIn.value || null,
      category: categoryIn.value,
      url: urlIn.value,
      note: noteIn.value,
    };
    const now = Date.now();
    if (existing) {
      const cur = findSub(existing.id);
      if (!cur) {
        m.close();
        toast('That subscription no longer exists.');
        return;
      }
      const res = F.updateSubscription(cur, fields, { now, today: todayKey() });
      if (res.error) return fail(res.error, res.field);
      setSubs((list) => list.map((x) => (x.id === cur.id ? res.sub : x)));
      toast(`“${res.sub.name}” saved.`);
    } else {
      const res = F.createSubscription(fields, { now, today: todayKey(), makeId: uid });
      if (res.error) return fail(res.error, res.field);
      setSubs((list) => [...list, res.sub]);
      // The page's explanation has done its job once something is in
      dismissTip('finance.intro');
      toast(`“${res.sub.name}” added: ${money(res.sub.amount, res.sub.currency)} ${F.cycleLabel(res.sub).toLowerCase()}.`);
    }
    m.close();
  }

  const onEnter = (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      save();
    }
  };

  const body = h(
    'div',
    { class: 'fn-ed', onKeydown: onEnter },
    h('datalist', { id: listId }, F.SUGGESTIONS.map((s) => h('option', { value: s.name }))),
    h('div', { class: 'field' }, h('label', { class: 'label', for: nameIn.id }, 'Name'), nameIn),
    h(
      'div',
      { class: 'fn-ed-grid' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: amountIn.id }, 'Price'), h('div', { class: 'fn-ed-pair' }, amountIn, currencyIn)),
      h('div', { class: 'field' }, h('label', { class: 'label', for: everyIn.id }, 'Paid every'), h('div', { class: 'fn-ed-pair' }, everyIn, unitIn)),
    ),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Status'), statusSeg.el),
    h('div', { class: 'fn-ed-grid' }, dateField, trialField, h('div', { class: 'field' }, h('label', { class: 'label', for: categoryIn.id }, 'Category'), categoryIn)),
    h('div', { class: 'field' }, h('label', { class: 'label', for: urlIn.id }, 'Where to manage or cancel it'), urlIn),
    h('div', { class: 'field' }, h('label', { class: 'label', for: noteIn.id }, 'Note'), noteIn),
    err,
  );

  const footer = [
    existing
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn--danger fn-ed-delete',
            onClick: () => {
              m.close();
              removeSub(existing.id);
            },
          },
          icon('trash', { size: 14 }),
          'Delete',
        )
      : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), existing ? 'Save' : 'Add'),
  ];

  const m = openModal({ title: existing ? existing.name : 'New subscription', body, footer, className: 'fn-modal', initialFocus: existing ? amountIn : nameIn.value ? amountIn : nameIn });
}

/* ==========================================================================
   Daily results: the view (Show → Daily results, then the Results tab)
   Built once per page; render() redraws everything under the quick add, which stays put, so
   what is being typed there survives a sync or another tab's change.
   ========================================================================== */

const DAYS_STEP = 45;

function resultsView({ el, setStat }) {
  const intro = tip({ id: 'finance.results', text: 'Write down what you made or lost each day, for your business or your trading: the graph shows how it adds up. LIFE/OS only knows what you type in; it doesn’t connect to a bank or a broker.', className: 'fn-r-tip' });
  const qa = quickAdd();
  const restEl = h('div', { class: 'fn-r-body' });
  el.append(intro, qa.el, restEl);
  let showArchived = false;
  let daysLimit = DAYS_STEP;
  let chart = null;
  let lastScope = null;

  /** Where the keyboard was, by what it was on, so a redraw puts it back (a deleted row: the next one) */
  function focusKey() {
    const a = document.activeElement;
    if (!a || !restEl.contains(a)) return null;
    const keyed = a.closest('[data-fn-focus]');
    if (keyed) return { sel: `[data-fn-focus="${CSS.escape(keyed.dataset.fnFocus)}"]` };
    for (const attr of ['entry', 'account']) {
      const row = a.closest(`[data-${attr}]`);
      if (row) return { sel: `[data-${attr}="${CSS.escape(row.dataset[attr])}"]`, list: `[data-${attr}]`, at: [...restEl.querySelectorAll(`[data-${attr}]`)].indexOf(row) };
    }
    if (a.closest('.fn-ch')) return { sel: '.fn-ch' };
    return null;
  }

  function restoreFocus(key) {
    if (!key) return;
    let el = restEl.querySelector(key.sel);
    if (!el && key.list) {
      const rows = restEl.querySelectorAll(key.list);
      el = rows[Math.min(key.at, rows.length - 1)] ?? null;
    }
    el?.focus({ preventScroll: true });
  }

  function render(s, today) {
    const focus = focusKey();
    chart?.destroy();
    chart = null;
    const live = s.accounts.filter((a) => !a.archived);
    qa.el.hidden = !live.length;
    if (!s.accounts.length) {
      setStat(null);
      restEl.replaceChildren(noAccounts());
      return;
    }
    const scope = F.resolveScope(s.accounts, s.view.scope);
    if (scope.id !== lastScope) {
      lastScope = scope.id;
      daysLimit = DAYS_STEP;
    }
    qa.update(s, scope, today);
    const days = F.dailyResults(s.entries, scope.accountIds);
    const overview = F.resultOverview(days, today);
    setStat(statLine(scope, overview, days));
    if (!days.length) {
      restEl.replaceChildren(h('div', { class: 'fn-r-main' }, chartPanel(s, scope, days, today, noDays(scope, live.length))), h('div', { class: 'fn-r-side' }, accountsPanel(s, today)));
    } else {
      restEl.replaceChildren(
        h('div', { class: 'fn-r-main' }, chartPanel(s, scope, days, today), daysPanel(s, scope, today)),
        h('div', { class: 'fn-r-side' }, overviewPanel(overview, scope, days), statsPanel(s, scope, days, today), accountsPanel(s, today)),
      );
    }
    restoreFocus(focus);
  }

  /* ---- The header's line: this month and today ('+kr 1,240 this month · today −kr 300') ---- */

  function statLine(scope, o, days) {
    if (!days.length) return 'Nothing written down yet';
    const part = (cls, ...children) => h('span', { class: ['fn-sum-part', cls] }, ...children);
    const parts = [part('fn-sum-month', h('strong', { class: 'fn-sum-total' }, signedMoney(o.month.amount, scope.currency, { round: true })), ' this month')];
    if (o.today.days) parts.push(part('fn-sum-today', `today ${signedMoney(o.today.amount, scope.currency, { round: true })}`));
    return h('span', { class: 'fn-sum' }, ...parts.flatMap((p, i) => (i ? [h('span', { class: 'fn-sum-sep', 'aria-hidden': 'true' }, '\u00a0· '), p] : [p])));
  }

  /* ---- Nothing yet ---- */

  // One clear action: the first account (the header has no button of its own here)
  function noAccounts() {
    const box = emptyState({
      icon: 'fn-results',
      title: 'What do you want to track?',
      text: 'Add your business, your trading or anything else that makes or loses money. Then write down each day’s result, and the graph shows your progress.',
      action: h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openAccountEditor() }, icon('plus', { size: 14 }), 'Add what you track'),
    });
    box.classList.add('fn-r-empty');
    return box;
  }

  function noDays(scope, liveCount) {
    const box = emptyState({
      icon: 'fn-results',
      title: scope.kind === 'account' ? `No results for ${scope.label} yet` : 'No results yet',
      text: liveCount ? 'Type what you made or lost today above (a minus for a loss) and press Enter. Several results on one day add up.' : 'Every account is archived. Unarchive one, or add a new one, to write down a result.',
      action: liveCount ? h('button', { type: 'button', class: 'btn btn--sm', onClick: () => qa.focus() }, icon('plus', { size: 13 }), 'Add today’s result') : null,
    });
    box.classList.add('fn-r-empty');
    return box;
  }

  /* ---- Progress: the graph, with what it shows and its time range ---- */

  // empty: what shows instead of the graph while what is shown has no results (its head stays,
  // so another account can be picked)
  function chartPanel(s, scope, days, today, empty = null) {
    const scopes = F.resultScopes(s.accounts);
    const mixed = new Set(s.accounts.map((a) => a.currency)).size > 1;
    const items = [];
    for (const sc of scopes) {
      if (items.length && sc.kind === 'account' && items[items.length - 1].kind !== 'account') items.push({ separator: true });
      items.push({ value: sc.id, label: sc.kind === 'account' && mixed ? `${sc.label} (${sc.currency})` : sc.label, hint: sc.archived ? 'archived' : null, kind: sc.kind });
    }
    const scopeDd =
      scopes.length > 1
        ? dropdown({
            items,
            value: scope.id,
            onSelect: (v) => setView({ scope: v }),
            className: 'btn--ghost fn-scope-btn',
            menuLabel: 'Show results for',
            ariaLabel: ({ picked }) => `Results for: ${picked?.label ?? scope.label}`,
          })
        : null;
    scopeDd?.button.setAttribute('data-fn-focus', 'scope');
    if (empty) {
      return h(
        'section',
        { class: 'panel hud fn-panel fn-ch-panel', 'aria-label': 'Progress' },
        h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'Progress'), h('div', { class: 'fn-ch-tools' }, scopeDd?.el)),
        empty,
      );
    }
    const range = F.RESULT_RANGES.find((r) => r.id === s.view.range) ?? F.RESULT_RANGES[1];
    const from = F.rangeStart(range.id, today, days);
    const last = days[days.length - 1].date;
    const to = last > today ? last : today;
    const points = F.cumulativeSeries(days, from, to);
    const total = points.length ? points[points.length - 1].total : 0;
    const shown = points.filter((p) => p.has).length;
    const rangeSeg = seg('Time range', F.RESULT_RANGES.map((r) => ({ value: r.id, label: r.id === 'ALL' ? 'All' : r.id })), range.id, (v) => setView({ range: v }), 'fn-range-seg');
    rangeSeg.el.querySelectorAll('.seg-btn').forEach((b) => {
      const r = F.RESULT_RANGES.find((x) => x.id === b.dataset.value);
      b.dataset.fnFocus = `range-${r.id}`;
      b.setAttribute('aria-label', r.days ? `Last ${r.name}` : 'All time');
    });
    const when = range.days ? `in the last ${range.name}` : `since ${formatDay(from)}`;
    const describe = (p) => [
      formatDay(p.date, 'long'),
      p.has ? `${signedMoney(p.amount, scope.currency)} that day` : 'Nothing written down that day',
      `${signedMoney(p.total, scope.currency)} since ${formatDay(from)}`,
    ];
    let plot;
    if (points.length && shown) {
      chart = resultsChart({ points, currency: scope.currency, label: `${scope.label}: ${signedMoney(total, scope.currency)} ${when}`, describe });
      plot = chart.el;
    } else {
      plot = h('p', { class: 'fn-none' }, `Nothing written down ${when}. Pick a longer range.`);
    }
    return h(
      'section',
      { class: 'panel hud fn-panel fn-ch-panel', 'aria-label': 'Progress' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'Progress'), h('div', { class: 'fn-ch-tools' }, scopeDd?.el, rangeSeg.el)),
      h(
        'div',
        { class: 'fn-ch-sum' },
        resultAmount(total, scope.currency, { className: 'fn-ch-total' }),
        h('span', { class: 'fn-ch-when' }, `${when}${shown ? ` · ${plural(shown, 'day')} with a result` : ''}`),
      ),
      plot,
      h('p', { class: 'fn-ch-key', 'aria-hidden': 'true' }, h('span', { class: 'fn-key fn-key--line' }), 'Running total', h('span', { class: 'fn-key fn-key--up' }), 'Day up', h('span', { class: 'fn-key fn-key--down' }), 'Day down'),
    );
  }

  /* ---- Today, this week, this month, all time ---- */

  function overviewPanel(o, scope, days) {
    const sub = (sum, none) => (sum.days ? [sum.up && `${sum.up} up`, sum.down && `${sum.down} down`, sum.flat && `${sum.flat} even`].filter(Boolean).join(' · ') : none);
    const kpi = (label, sum, text) => h('div', { class: 'fn-kpi' }, h('span', { class: 'label fn-kpi-label' }, label), resultAmount(sum.amount, scope.currency, { className: 'fn-kpi-value' }), h('span', { class: 'fn-kpi-sub' }, text));
    return h(
      'section',
      { class: 'panel hud fn-panel fn-over', 'aria-label': 'Overview' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, scope.kind === 'account' ? scope.label : 'Overview'), h('span', { class: 'fn-due' }, scope.currency)),
      h(
        'div',
        { class: 'fn-kpis' },
        kpi('Today', o.today, o.today.days ? plural(days.find((d) => d.date === todayKey())?.count ?? 1, 'result') : 'Nothing yet'),
        kpi('This week', o.week, sub(o.week, 'Nothing yet')),
        kpi('This month', o.month, sub(o.month, 'Nothing yet')),
        kpi('All time', o.all, `since ${formatDay(days[0].date)}`),
      ),
    );
  }

  /* ---- Win days, loss days and the rest, over the graph's range ---- */

  function statsPanel(s, scope, days, today) {
    const range = F.RESULT_RANGES.find((r) => r.id === s.view.range) ?? F.RESULT_RANGES[1];
    const from = F.rangeStart(range.id, today, days);
    const st = F.resultStats(days.filter((d) => d.date >= from));
    const runs = F.streaks(days);
    const cur = runs.current;
    const row = (label, value, note) =>
      h('div', { class: 'fn-stat' }, h('dt', { class: 'fn-stat-label' }, label), h('dd', { class: 'fn-stat-value' }, typeof value === 'string' ? h('span', null, value) : value, note ? h('span', { class: 'fn-stat-note' }, note) : null));
    const rate = st.winRate == null ? '—' : `${Math.round(st.winRate * 100)}%`;
    const total = st.up + st.down + st.flat;
    const split = total
      ? h(
          'div',
          { class: 'fn-split', 'aria-hidden': 'true' },
          st.up ? h('span', { class: 'fn-split-up', style: { flexGrow: String(st.up) } }) : null,
          st.flat ? h('span', { class: 'fn-split-flat', style: { flexGrow: String(st.flat) } }) : null,
          st.down ? h('span', { class: 'fn-split-down', style: { flexGrow: String(st.down) } }) : null,
        )
      : null;
    const runText = !cur.dir ? '—' : cur.dir === 'flat' ? 'An even day' : `${plural(cur.length, 'day')} ${cur.dir}`;
    return h(
      'section',
      { class: 'panel hud fn-panel fn-stats', 'aria-label': 'How the days went' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'How the days went'), h('span', { class: 'fn-due' }, range.days ? `last ${range.name}` : 'all time')),
      st.days
        ? h(
            'dl',
            { class: 'fn-stat-list' },
            row('Up and down', h('span', null, `${st.up} up · ${st.down} down${st.flat ? ` · ${st.flat} even` : ''}`), split),
            row('Win rate', rate, st.winRate == null ? null : 'of the days up or down'),
            row('Best day', resultAmount(st.best.amount, scope.currency, { glyph: false }), formatDay(st.best.date)),
            row('Worst day', resultAmount(st.worst.amount, scope.currency, { glyph: false }), formatDay(st.worst.date)),
            row('Average day', resultAmount(st.average, scope.currency, { glyph: false }), `over ${plural(st.days, 'day')}`),
            row('In a row now', runText, runs.longestUp ? `longest up: ${plural(runs.longestUp, 'day')}` : null),
          )
        : h('p', { class: 'fn-none' }, `Nothing written down in the last ${range.name}.`),
    );
  }

  /* ---- Every day, newest first, by month ---- */

  function daysPanel(s, scope, today) {
    const months = F.monthGroups(s.entries, scope.accountIds);
    const many = scope.accountIds.length > 1;
    const count = months.reduce((n, m) => n + m.days.length, 0);
    let left = daysLimit;
    const blocks = [];
    for (const m of months) {
      if (left <= 0) break;
      const shown = m.days.slice(0, left);
      left -= shown.length;
      blocks.push(
        h(
          'section',
          { class: 'fn-month', 'aria-label': F.monthName(m.month) },
          h(
            'h3',
            { class: 'fn-month-head' },
            h('span', { class: 'fn-month-name' }, F.monthName(m.month)),
            h('span', { class: 'fn-month-meta' }, [m.up && `${m.up} up`, m.down && `${m.down} down`].filter(Boolean).join(' · ')),
            resultAmount(m.amount, scope.currency, { className: 'fn-month-total' }),
          ),
          h('ul', { class: 'fn-day-list', role: 'list' }, shown.map((d) => dayRow(d, scope, many, today))),
        ),
      );
    }
    return h(
      'section',
      { class: 'panel hud fn-panel fn-days', 'aria-label': 'Days' },
      h('div', { class: 'panel-head fn-panel-head' }, h('h2', { class: 'fn-panel-title' }, 'Days'), h('span', { class: 'fn-due' }, plural(count, 'day'))),
      blocks,
      count > daysLimit
        ? h(
            'button',
            {
              type: 'button',
              class: 'fn-cancelled-toggle fn-days-more',
              dataset: { fnFocus: 'days-more' },
              onClick: () => {
                daysLimit += DAYS_STEP * 2;
                render(getState(), todayKey());
              },
            },
            icon('chevron-down', { size: 14 }),
            h('span', null, `Show older days (${count - daysLimit} more)`),
          )
        : null,
    );
  }

  // A day with one result is one row; a day with several shows its total and a row for each
  function dayRow(d, scope, many, today) {
    const date = h('span', { class: ['fn-day-date', d.date === today && 'is-today'] }, dayShort(d.date, today));
    if (d.entries.length === 1) return entryRow(d.entries[0], scope, many, { date, single: true });
    return h(
      'li',
      { class: 'fn-day is-multi' },
      h('div', { class: 'fn-day-head' }, date, h('span', { class: 'fn-day-count' }, plural(d.entries.length, 'result')), resultAmount(d.amount, scope.currency, { className: 'fn-day-total' })),
      h('ul', { class: 'fn-entry-list', role: 'list' }, d.entries.map((e) => entryRow(e, scope, many, {}))),
    );
  }

  // A result's row: the day (a one-result day), the account (when several are shown), the note
  function entryRow(e, scope, many, { date = null, single = false }) {
    const account = findAccount(e.accountId);
    const currency = account?.currency ?? scope.currency;
    const open = () => openEntryEditor(e.id);
    return h(
      'li',
      {
        class: ['fn-entry', single && 'fn-day'],
        tabindex: '0',
        dataset: { entry: e.id },
        'aria-label': `${formatDay(e.date, 'long')}: ${signedMoney(e.amount, currency)}${account ? `, ${account.name}` : ''}${e.note ? `, ${e.note}` : ''}. Enter to edit`,
        onClick: open,
        onKeydown: (ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            open();
          }
        },
      },
      date,
      h('span', { class: 'fn-entry-main' }, many && account ? h('span', { class: 'fn-entry-acct' }, account.name) : null, e.note ? h('span', { class: 'fn-entry-note' }, e.note) : null),
      resultAmount(e.amount, currency, { className: 'fn-entry-amt', glyph: single }),
    );
  }

  /* ---- What you track ---- */

  function accountsPanel(s, today) {
    const totals = F.accountTotals(s.accounts, s.entries, today);
    const live = totals.filter((t) => !t.account.archived);
    const archived = totals.filter((t) => t.account.archived);
    const scope = F.resolveScope(s.accounts, s.view.scope);
    const acctRow = ({ account, month, all }) =>
      h(
        'li',
        {
          class: ['fn-acct', account.archived && 'is-archived', scope?.kind === 'account' && scope.accountIds[0] === account.id && 'is-shown'],
          tabindex: '0',
          dataset: { account: account.id },
          'aria-label': `${account.name}, ${F.RESULT_KIND_LABEL[account.kind]}, ${account.currency}${account.archived ? ', archived' : ''}: ${signedMoney(month.amount, account.currency)} this month, ${signedMoney(all.amount, account.currency)} in all. Enter to edit`,
          onClick: () => openAccountEditor(account.id),
          onKeydown: (e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openAccountEditor(account.id);
            }
          },
        },
        h('span', { class: 'fn-avatar', 'aria-hidden': 'true' }, icon(F.RESULT_KIND_ICON[account.kind], { size: 18 })),
        h('span', { class: 'fn-acct-main' }, h('span', { class: 'fn-name' }, account.name), h('span', { class: 'fn-acct-meta' }, `${F.RESULT_KIND_LABEL[account.kind]} · ${account.currency}${account.archived ? ' · archived' : ''}`)),
        h('span', { class: 'fn-acct-nums' }, resultAmount(month.amount, account.currency, { glyph: false, className: 'fn-acct-month' }), h('span', { class: 'fn-acct-all' }, `${signedMoney(all.amount, account.currency, { round: true })} in all`)),
      );
    return h(
      'section',
      { class: 'panel hud fn-panel fn-accts', 'aria-label': 'Accounts' },
      h(
        'div',
        { class: 'panel-head fn-panel-head' },
        h('h2', { class: 'fn-panel-title' }, 'Accounts'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm fn-acct-add', dataset: { fnFocus: 'acct-add' }, onClick: () => openAccountEditor() }, icon('plus', { size: 13 }), h('span', null, 'New')),
      ),
      h('p', { class: 'fn-acct-cap label' }, 'This month'),
      live.length ? h('ul', { class: 'fn-acct-list', role: 'list' }, live.map(acctRow)) : h('p', { class: 'fn-none' }, 'Every account is archived.'),
      archived.length
        ? h(
            'button',
            {
              type: 'button',
              class: 'fn-cancelled-toggle',
              'aria-expanded': String(showArchived),
              dataset: { fnFocus: 'acct-archived' },
              onClick: () => {
                showArchived = !showArchived;
                render(getState(), todayKey());
              },
            },
            icon('chevron-down', { size: 14, className: 'fn-caret' }),
            h('span', null, `Archived (${archived.length})`),
          )
        : null,
      archived.length && showArchived ? h('ul', { class: 'fn-acct-list fn-list--cancelled', role: 'list' }, archived.map(acctRow)) : null,
    );
  }

  return {
    render,
    focusAdd: () => (qa.el.hidden ? openAccountEditor() : qa.focus()),
    destroy: () => chart?.destroy(),
  };
}

/* ---- The quick add: a day's result in one line (Enter adds) ---- */

function quickAdd() {
  let lost = false;
  let accountsSig = '';
  let scopeShown = null;
  const fid = (n) => `fn-qa-${n}`;
  const today0 = todayKey();
  const dateIn = h('input', { id: fid('date'), class: 'input fn-qa-date', type: 'date', value: today0, max: today0, dataset: { today: today0 } });
  const accountIn = h('select', { id: fid('account'), class: 'select fn-qa-account' });
  const signSeg = seg('Made or lost', [{ value: 'made', label: '+ Made' }, { value: 'lost', label: `${MINUS} Lost` }], 'made', (v) => setLost(v === 'lost'), 'fn-qa-sign');
  const curEl = h('span', { class: 'fn-qa-cur', 'aria-hidden': 'true' });
  const amountIn = h('input', { id: fid('amount'), class: 'input fn-qa-amount', type: 'text', inputmode: 'decimal', placeholder: '250', autocomplete: 'off', enterkeyhint: 'done', 'aria-describedby': fid('hint') });
  const noteIn = h('input', { id: fid('note'), class: 'input fn-qa-note', type: 'text', placeholder: 'Big order, fees…', maxlength: String(F.ENTRY_NOTE_MAX), autocomplete: 'off', enterkeyhint: 'done' });
  const err = h('p', { class: 'fn-qa-error', role: 'alert', hidden: true });
  const hint = h('p', { class: 'fn-qa-hint sr-only', id: fid('hint') }, 'Type a minus first for a loss, or pick Lost.');
  const accountField = h('div', { class: 'field fn-qa-f-account' }, h('label', { class: 'label', for: accountIn.id }, 'Account'), accountIn);

  function setLost(v) {
    lost = v;
    signSeg.set(v ? 'lost' : 'made');
    el.classList.toggle('is-lost', v);
  }

  // A sign typed first picks Made or Lost (a phone's number keys have no minus: the buttons do)
  amountIn.addEventListener('input', () => {
    const m = amountIn.value.match(/^\s*([-−–+])\s*/);
    if (!m) return;
    setLost(m[1] !== '+');
    amountIn.value = amountIn.value.slice(m[0].length);
  });
  accountIn.addEventListener('change', () => (curEl.textContent = findAccount(accountIn.value)?.currency ?? ''));

  function add() {
    [dateIn, amountIn, accountIn].forEach((x) => x.removeAttribute('aria-invalid'));
    err.hidden = true;
    const amount = F.signedAmount(amountIn.value, lost);
    const res = F.createEntry({ accountId: accountIn.value, date: dateIn.value, amount, note: noteIn.value }, { now: Date.now(), today: todayKey(), makeId: uid });
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      const field = { accountId: accountIn, date: dateIn, amount: amountIn }[res.field] ?? amountIn;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    addEntry(res.entry);
    amountIn.value = '';
    noteIn.value = '';
    setLost(false);
    amountIn.focus();
  }

  const el = h(
    'form',
    {
      class: 'panel fn-qa',
      'aria-label': 'Add a result',
      novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        add();
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input, select')) {
          e.preventDefault();
          add();
        }
      },
    },
    h(
      'div',
      { class: 'fn-qa-grid' },
      h('div', { class: 'field fn-qa-f-date' }, h('label', { class: 'label', for: dateIn.id }, 'Day'), dateIn),
      accountField,
      h('div', { class: 'field fn-qa-f-amount' }, h('label', { class: 'label', for: amountIn.id }, 'Made or lost'), h('div', { class: 'fn-qa-pair' }, signSeg.el, h('div', { class: 'fn-qa-money' }, amountIn, curEl))),
      h('div', { class: 'field fn-qa-f-note' }, h('label', { class: 'label', for: noteIn.id }, 'Note (if you like)'), noteIn),
      h('button', { type: 'submit', class: 'btn btn--primary fn-qa-add' }, icon('plus', { size: 14 }), h('span', null, 'Add')),
    ),
    hint,
    err,
  );

  /** The accounts to pick from, the one picked (the shown account's own, else the last one used), its currency, the day. */
  function update(s, scope, today) {
    const live = s.accounts.filter((a) => !a.archived);
    // (the currency shows at the end of the amount, so the names stay short)
    const sig = live.map((a) => `${a.id}:${a.name}:${a.currency}`).join('|');
    if (sig !== accountsSig) {
      accountsSig = sig;
      const keep = accountIn.value;
      accountIn.replaceChildren(...live.map((a) => h('option', { value: a.id }, a.name)));
      if (live.some((a) => a.id === keep)) accountIn.value = keep;
    }
    if (scope.id !== scopeShown || !live.some((a) => a.id === accountIn.value)) {
      scopeShown = scope.id;
      const inScope = live.filter((a) => scope.accountIds.includes(a.id));
      const pick = inScope.slice().sort((a, b) => b.usedAt - a.usedAt)[0] ?? live[0];
      if (pick) accountIn.value = pick.id;
    }
    accountField.hidden = live.length < 2;
    el.classList.toggle('has-account', live.length >= 2);
    curEl.textContent = findAccount(accountIn.value)?.currency ?? '';
    // A new day: the field moves on with it, unless another day was picked by hand
    if (dateIn.value === dateIn.dataset.today && today !== dateIn.dataset.today) dateIn.value = today;
    dateIn.dataset.today = today;
    dateIn.max = today;
  }

  return { el, update, focus: () => amountIn.focus() };
}

/* ==========================================================================
   The graph: the running total as a line over the range, each day's result as a bar under it
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/**
 * points: cumulativeSeries() (one per day). Above the 0 line is up over the range (a soft fill),
 * under it down (hatched); a day up is a filled bar over the bars' base line, a day down an
 * outlined bar under it, so neither needs a color. Hover, tap or the arrow keys read a day.
 * -> { el, destroy }
 */
function resultsChart({ points, currency, label, describe }) {
  const H = 260;
  const BAR_H = 54;
  const GAP = 14;
  const pad = { l: 62, r: 14, t: 12, b: 26 };
  const n = points.length;
  const totals = points.map((p) => p.total);
  const scale = F.moneyScale(Math.min(...totals), Math.max(...totals), 4);
  const maxUp = Math.max(0, ...points.map((p) => p.amount));
  const maxDown = Math.max(0, ...points.map((p) => -p.amount));
  const barSpan = maxUp + maxDown || 1;
  const marks = points.map((p, i) => (p.has ? i : -1)).filter((i) => i >= 0);
  const ids = { up: `fn-ch-up-${uid()}`, down: `fn-ch-down-${uid()}`, hatch: `fn-ch-hatch-${uid()}` };
  let W = 0;
  let xAt = () => 0;
  let yAt = () => 0;
  let cross = null;
  let dot = null;
  let bars = [];
  let active = null;

  const svg = sv('svg', { class: 'fn-ch-svg', role: 'img', 'aria-label': label });
  const tipEl = h('div', { class: 'fn-ch-tip', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const el = h('div', { class: 'fn-ch', tabindex: '0', role: 'group', 'aria-label': `${label}. Left and right arrow keys read each day with a result.` }, svg, tipEl, live);

  function draw(width) {
    W = Math.max(280, Math.round(width));
    const pw = W - pad.l - pad.r;
    const lineH = H - pad.t - pad.b - BAR_H - GAP;
    const barTop = pad.t + lineH + GAP;
    const base = barTop + BAR_H * (maxUp / barSpan);
    const slot = pw / n;
    xAt = (i) => pad.l + (i + 0.5) * slot;
    yAt = (v) => pad.t + (1 - (v - scale.min) / (scale.max - scale.min || 1)) * lineH;
    const y0 = yAt(0);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.replaceChildren();

    // Above 0 and under it: the line's area is a soft fill up there, hatched down here
    svg.append(
      sv(
        'defs',
        null,
        sv('clipPath', { id: ids.up }, sv('rect', { x: pad.l, y: pad.t, width: pw, height: Math.max(0, y0 - pad.t) })),
        sv('clipPath', { id: ids.down }, sv('rect', { x: pad.l, y: y0, width: pw, height: Math.max(0, pad.t + lineH - y0) })),
        sv('pattern', { id: ids.hatch, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, sv('line', { class: 'fn-ch-hatch', x1: 0, y1: 0, x2: 0, y2: 6 })),
      ),
    );

    const grid = sv('g', { class: 'fn-ch-grid' });
    for (const t of scale.ticks) {
      const y = yAt(t);
      grid.append(sv('line', { class: t === 0 ? 'fn-ch-zero' : null, x1: pad.l, x2: W - pad.r, y1: y, y2: y }), sv('text', { class: ['fn-ch-axis', t === 0 && 'is-zero'].filter(Boolean).join(' '), x: pad.l - 8, y: y + 4, 'text-anchor': 'end' }, axisMoney(t, currency)));
    }
    svg.append(grid);

    // The line starts at 0 on the range's left edge, then one point per day
    const path = `M${pad.l} ${y0.toFixed(1)} ${points.map((p, i) => `L${xAt(i).toFixed(1)} ${yAt(p.total).toFixed(1)}`).join(' ')}`;
    const area = `${path} L${xAt(n - 1).toFixed(1)} ${y0.toFixed(1)} Z`;
    svg.append(
      sv('path', { class: 'fn-ch-area fn-ch-area--up', d: area, 'clip-path': `url(#${ids.up})` }),
      sv('path', { class: 'fn-ch-area fn-ch-area--down', d: area, fill: `url(#${ids.hatch})`, 'clip-path': `url(#${ids.down})` }),
    );

    // Each day's result under the line: up over the base line, down under it
    svg.append(sv('line', { class: 'fn-ch-base', x1: pad.l, x2: W - pad.r, y1: base, y2: base }));
    const bw = Math.max(1, Math.min(14, slot * 0.64));
    const barsG = sv('g', { class: 'fn-ch-bars' });
    bars = points.map((p, i) => {
      if (!p.has) return null;
      const dir = F.signOf(p.amount);
      const hgt = dir === 'flat' ? 2 : Math.max(2, (Math.abs(p.amount) / barSpan) * BAR_H);
      const y = dir === 'up' ? base - hgt : dir === 'down' ? base : base - 1;
      const r = sv('rect', { class: ['fn-ch-bar', `is-${dir}`, bw < 5 && 'is-thin'].filter(Boolean).join(' '), x: (xAt(i) - bw / 2).toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: hgt.toFixed(1) });
      barsG.append(r);
      return r;
    });
    svg.append(barsG);

    // The first and last day on x, and the middle one when there is room
    const used = [];
    for (const i of n > 2 ? [0, n - 1, Math.floor((n - 1) / 2)] : n > 1 ? [0, n - 1] : [0]) {
      const x = xAt(i);
      if (used.some((u) => Math.abs(u - x) < 96)) continue;
      used.push(x);
      const anchor = n === 1 ? 'middle' : x < pad.l + 44 ? 'start' : x > W - pad.r - 44 ? 'end' : 'middle';
      svg.append(sv('text', { class: 'fn-ch-axis', x: anchor === 'start' ? pad.l : anchor === 'end' ? W - pad.r : x, y: H - 6, 'text-anchor': anchor }, formatDay(points[i].date)));
    }

    svg.append(sv('path', { class: 'fn-ch-line', d: path }));
    svg.append(sv('circle', { class: 'fn-ch-end', cx: xAt(n - 1).toFixed(1), cy: yAt(points[n - 1].total).toFixed(1), r: 4 }));
    cross = sv('line', { class: 'fn-ch-cross', x1: 0, x2: 0, y1: pad.t, y2: barTop + BAR_H, visibility: 'hidden' });
    dot = sv('circle', { class: 'fn-ch-dot', cx: 0, cy: 0, r: 4.5, visibility: 'hidden' });
    svg.append(cross, dot);
    if (active != null) show(active);
  }

  const show = (i) => {
    active = clamp(i, 0, n - 1);
    const p = points[active];
    const x = xAt(active);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', yAt(p.total));
    dot.setAttribute('visibility', 'visible');
    bars.forEach((b, j) => b?.classList.toggle('is-active', j === active));
    const lines = describe(p);
    tipEl.replaceChildren(...lines.map((t, j) => h('div', { class: j === 1 ? 'fn-ch-tip-main' : 'fn-ch-tip-sub' }, t)));
    tipEl.classList.add('is-on');
    const w = tipEl.offsetWidth;
    const left = x + 14 + w > el.clientWidth ? x - 14 - w : x + 14;
    tipEl.style.transform = `translate(${Math.round(Math.max(0, left))}px, ${pad.t}px)`;
    live.textContent = lines.join('. ');
  };
  const hide = () => {
    active = null;
    cross?.setAttribute('visibility', 'hidden');
    dot?.setAttribute('visibility', 'hidden');
    bars.forEach((b) => b?.classList.remove('is-active'));
    tipEl.classList.remove('is-on');
  };
  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    const x = ((clientX - rect.left) / rect.width) * W;
    return clamp(Math.floor(((x - pad.l) / (W - pad.l - pad.r)) * n), 0, n - 1);
  };
  el.addEventListener('pointermove', (e) => {
    const i = nearest(e.clientX);
    if (i != null && i !== active) show(i);
  });
  // A tap shows the day (and keeps it until the next tap or the focus leaves)
  el.addEventListener('pointerdown', (e) => {
    const i = nearest(e.clientX);
    if (i != null) show(i);
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  el.addEventListener('blur', hide);
  el.addEventListener('keydown', (e) => {
    if (!marks.length) return;
    let to = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const right = e.key === 'ArrowRight';
      if (active == null) to = marks[marks.length - 1];
      else to = (right ? marks.find((i) => i > active) : [...marks].reverse().find((i) => i < active)) ?? active;
    } else if (e.key === 'Home') to = marks[0];
    else if (e.key === 'End') to = marks[marks.length - 1];
    else if (e.key === 'Escape' && active != null) {
      e.stopPropagation();
      hide();
      return;
    }
    if (to == null) return;
    e.preventDefault();
    show(to);
  });

  draw(640);
  const ro = new ResizeObserver(([entry]) => {
    if (!el.isConnected) return;
    const width = entry.contentRect.width;
    if (width && Math.abs(Math.max(280, Math.round(width)) - W) > 1) draw(width);
  });
  ro.observe(el);
  return { el, destroy: () => ro.disconnect() };
}

/* ==========================================================================
   The dialogs: a result, an account
   ========================================================================== */

function openEntryEditor(id) {
  const existing = findEntry(id);
  if (!existing) return;
  const s = getState();
  let lost = existing.amount < 0;
  const fid = (name) => `fn-en-${name}`;
  const err = h('p', { class: 'fn-ed-error', role: 'alert', hidden: true });
  const dateIn = h('input', { id: fid('date'), class: 'input', type: 'date', value: existing.date, max: todayKey() > existing.date ? todayKey() : existing.date });
  const accounts = s.accounts.filter((a) => !a.archived || a.id === existing.accountId);
  const mixed = new Set(accounts.map((a) => a.currency)).size > 1;
  const accountIn = h('select', { id: fid('account'), class: 'select' }, accounts.map((a) => h('option', { value: a.id }, `${a.name}${mixed ? ` (${a.currency})` : ''}${a.archived ? ' · archived' : ''}`)));
  accountIn.value = existing.accountId;
  const signSeg = seg('Made or lost', [{ value: 'made', label: '+ Made' }, { value: 'lost', label: `${MINUS} Lost` }], lost ? 'lost' : 'made', (v) => {
    lost = v === 'lost';
    signSeg.set(v);
  });
  const amountIn = h('input', { id: fid('amount'), class: 'input fn-ed-amount', type: 'text', inputmode: 'decimal', value: String(Math.abs(existing.amount)), autocomplete: 'off' });
  amountIn.addEventListener('input', () => {
    const m = amountIn.value.match(/^\s*([-−–+])\s*/);
    if (!m) return;
    lost = m[1] !== '+';
    signSeg.set(lost ? 'lost' : 'made');
    amountIn.value = amountIn.value.slice(m[0].length);
  });
  const curEl = h('span', { class: 'fn-qa-cur', 'aria-hidden': 'true' }, accountCurrency(existing.accountId));
  accountIn.addEventListener('change', () => (curEl.textContent = accountCurrency(accountIn.value)));
  const noteIn = h('input', { id: fid('note'), class: 'input', type: 'text', value: existing.note, maxlength: String(F.ENTRY_NOTE_MAX), placeholder: 'Big order, fees…', autocomplete: 'off' });

  function save() {
    [dateIn, amountIn, accountIn].forEach((x) => x.removeAttribute('aria-invalid'));
    const cur = findEntry(id);
    if (!cur) {
      m.close();
      toast('That result no longer exists.');
      return;
    }
    // A day already in the future (another device's time zone) may stay as it is
    const res = F.updateEntry(cur, { accountId: accountIn.value, date: dateIn.value, amount: F.signedAmount(amountIn.value, lost), note: noteIn.value }, { now: Date.now(), today: dateIn.value === cur.date ? null : todayKey() });
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      const field = { accountId: accountIn, date: dateIn, amount: amountIn }[res.field] ?? amountIn;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    replaceEntry(res.entry);
    toast(`Saved: ${signedMoney(res.entry.amount, accountCurrency(res.entry.accountId))} on ${formatDay(res.entry.date)}.`);
    m.close();
  }

  const body = h(
    'div',
    {
      class: 'fn-ed',
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input, select')) {
          e.preventDefault();
          save();
        }
      },
    },
    h('div', { class: 'fn-ed-grid' }, h('div', { class: 'field' }, h('label', { class: 'label', for: dateIn.id }, 'Day'), dateIn), h('div', { class: 'field' }, h('label', { class: 'label', for: accountIn.id }, 'Account'), accountIn)),
    h('div', { class: 'field' }, h('label', { class: 'label', for: amountIn.id }, 'Made or lost'), h('div', { class: 'fn-qa-pair' }, signSeg.el, h('div', { class: 'fn-qa-money' }, amountIn, curEl))),
    h('div', { class: 'field' }, h('label', { class: 'label', for: noteIn.id }, 'Note'), noteIn),
    err,
  );
  const footer = [
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn--danger fn-ed-delete',
        onClick: () => {
          m.close();
          removeEntry(id);
        },
      },
      icon('trash', { size: 14 }),
      'Delete',
    ),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), 'Save'),
  ];
  const m = openModal({ title: `Result · ${formatDay(existing.date)}`, body, footer, className: 'fn-modal', initialFocus: amountIn, onClose: () => backToRow(`[data-entry="${CSS.escape(id)}"]`) });
}

function openAccountEditor(id = null) {
  const existing = id ? findAccount(id) : null;
  if (id && !existing) return;
  const start = existing ?? { name: '', kind: 'business', currency: defaultCurrency(), archived: false };
  let kind = start.kind;
  let kindTouched = !!existing;
  let archived = start.archived;
  let created = false;
  const fid = (name) => `fn-ac-${name}`;
  const err = h('p', { class: 'fn-ed-error', role: 'alert', hidden: true });
  const listId = fid('suggest');
  const nameIn = h('input', { id: fid('name'), class: 'input', type: 'text', value: start.name, maxlength: String(F.NAME_MAX), placeholder: 'My shop, Forex, Freelance…', autocomplete: 'off', list: listId });
  const kindSeg = seg('Kind', F.RESULT_KINDS.map((k) => ({ value: k, label: F.RESULT_KIND_LABEL[k] })), kind, (v) => {
    kind = v;
    kindTouched = true;
    kindSeg.set(v);
  });
  // A known name picks its kind (until you choose one yourself)
  nameIn.addEventListener('input', () => {
    const k = F.accountKindFor(nameIn.value);
    if (k && !kindTouched) {
      kind = k;
      kindSeg.set(k);
    }
  });
  const currencies = F.CURRENCIES.includes(start.currency) ? F.CURRENCIES : [start.currency, ...F.CURRENCIES];
  const currencyIn = h('select', { id: fid('currency'), class: 'select' }, currencies.map((c) => h('option', { value: c }, c)));
  currencyIn.value = start.currency;
  const count = existing ? getState().entries.filter((e) => e.accountId === existing.id).length : 0;
  const archiveCheck = checkButton({
    checked: archived,
    label: 'Archived',
    onToggle: (on) => {
      archived = on;
      setChecked(archiveCheck, on);
    },
  });
  const archiveField = existing
    ? h(
        'div',
        { class: 'field fn-ac-archive' },
        h('label', { class: 'fn-ac-check' }, archiveCheck, h('span', null, 'Archived')),
        h('p', { class: 'fn-ed-hint' }, 'An archived account isn’t offered when you add a result. Its days stay and still count.'),
      )
    : null;

  function save() {
    nameIn.removeAttribute('aria-invalid');
    const fields = { name: nameIn.value, kind, currency: currencyIn.value, archived };
    const now = Date.now();
    if (existing) {
      const cur = findAccount(existing.id);
      if (!cur) {
        m.close();
        toast('That account no longer exists.');
        return;
      }
      const res = F.updateAccount(cur, fields, { now });
      if (res.error) return fail(res);
      setAccounts((list) => list.map((a) => (a.id === cur.id ? res.account : a)));
      toast(`“${res.account.name}” saved.`);
    } else {
      const res = F.createAccount(fields, { now, makeId: uid });
      if (res.error) return fail(res);
      const s = getState();
      // The new account is what the Results view shows next, ready for its first result
      commit({ ...s, accounts: [...s.accounts, res.account], view: { ...s.view, scope: `acc:${res.account.id}` } });
      created = true;
      toast(`“${res.account.name}” added. Write down its first result at the top.`);
    }
    m.close();
  }

  function fail(res) {
    err.textContent = res.error;
    err.hidden = false;
    const field = { name: nameIn, currency: currencyIn }[res.field] ?? nameIn;
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }

  const body = h(
    'div',
    {
      class: 'fn-ed',
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('input, select')) {
          e.preventDefault();
          save();
        }
      },
    },
    h('datalist', { id: listId }, F.ACCOUNT_SUGGESTIONS.map((x) => h('option', { value: x.name }))),
    h('div', { class: 'field' }, h('label', { class: 'label', for: nameIn.id }, 'Name'), nameIn),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Kind'), kindSeg.el),
    h('div', { class: 'field' }, h('label', { class: 'label', for: currencyIn.id }, 'Currency'), currencyIn, count ? h('p', { class: 'fn-ed-hint' }, `Changing it doesn’t convert its ${plural(count, 'result')}: the numbers stay as typed.`) : null),
    archiveField,
    err,
  );
  const footer = [
    existing
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn--danger fn-ed-delete',
            onClick: () => {
              m.close();
              removeAccount(existing.id);
            },
          },
          icon('trash', { size: 14 }),
          'Delete',
        )
      : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => m.close() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: save }, icon('check', { size: 14 }), existing ? 'Save' : 'Add'),
  ];
  const m = openModal({ title: existing ? existing.name : 'What do you track?', body, footer, className: 'fn-modal', initialFocus: nameIn, onClose: () => (existing ? backToRow(`[data-account="${CSS.escape(existing.id)}"]`) : created && backToRow('.fn-qa-amount')) });
}

/** A dialog opened from a row hands the keyboard back to that row (redrawn meanwhile: its new copy). */
function backToRow(selector) {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !a.closest('.modal-root')) return;
  document.querySelector(`.fn-root ${selector}`)?.focus({ preventScroll: true });
}

/* ==========================================================================
   Feature
   ========================================================================== */

/** For Home's Payments widget: the subscriptions, their changes and the money format. */
export const financeApi = Object.freeze({
  subscriptions: () => getState().subscriptions,
  subscribe: (fn) => store.subscribe(fn),
  money,
  add: () => openEditor(),
  /** Search: the subscription's own dialog (Edit). False when there is no such subscription. */
  edit: (id) => {
    if (!findSub(id)) return false;
    // (from the Results view: its list comes back first, so closing the dialog lands on its row)
    if (getState().view.tab === 'results') setView({ tab: 'subs' });
    openEditor(id);
    return true;
  },
});

/** Payments due today or in the next 3 days, on the nav (empty when none). */
function badge() {
  const n = F.dueSoon(getState().subscriptions, todayKey(), 3);
  return n ? String(n) : '';
}

export default {
  id: 'finance',
  title: 'Finance',
  icon: 'wallet',
  badge,
  mount,
};
