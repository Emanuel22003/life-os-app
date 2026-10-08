// LIFE/OS — Finance (08): subscriptions. What they cost per month and per year, what is paid
// next, free trials about to turn into payments, cost by category, and what cancelling saves.
// Pure rules live in finance.logic.js; store 'finance' (synced, except view).

import { h, icon, pageHeader, toast, openModal, todayKey, formatDay, relativeDay, diffDays, onDayChange, isTyping, modalOpen, plural, uid } from '../ui.js';
import { createStore } from '../store.js';
import { registerContextProvider } from '../contextmenu.js';
import * as F from './finance.logic.js';

// The wallet icon is registered by the shell (js/app.js), 'external' by js/sync.panel.js

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

/** New subscriptions start in the currency of the last one added (or the guess). */
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

const initial = (name) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase();

/* ==========================================================================
   Page
   ========================================================================== */

function mount(root) {
  root.classList.add('fn-root');
  const cleanups = [];

  const header = pageHeader({
    index: '08',
    title: 'Finance',
    subtitle: 'Your subscriptions: what they cost, and when they renew.',
    actions: [btn('Add subscription', () => openEditor(), { iconName: 'plus', primary: true, small: false })],
  });
  const summaryEl = h('section', { class: 'fn-summary', 'aria-label': 'Totals' });
  const bodyEl = h('div', { class: 'fn-body' });
  root.append(header, summaryEl, bodyEl);

  function render() {
    const s = getState();
    const today = todayKey();
    const subs = s.subscriptions;
    const focusId = document.activeElement?.closest?.('.fn-row[data-id]')?.dataset.id;
    if (!subs.length) {
      summaryEl.hidden = true;
      bodyEl.replaceChildren(emptyView());
      return;
    }
    summaryEl.hidden = false;
    summaryEl.replaceChildren(...summaryCards(subs, today));
    bodyEl.replaceChildren(
      h('div', { class: 'fn-main' }, listPanel(s, today)),
      h('div', { class: 'fn-side' }, upcomingPanel(subs, today), categoryPanel(subs)),
    );
    if (focusId) bodyEl.querySelector(`.fn-row[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  }

  /* ---- Totals ---- */

  function summaryCards(subs, today) {
    const t = F.totals(subs);
    const next = F.upcoming(subs, today, 400)[0] ?? null;
    const card = (label, value, sub, cls) => h('div', { class: ['fn-stat', 'panel', 'hud', cls] }, h('span', { class: 'label' }, label), h('span', { class: 'stat-value fn-stat-value' }, value), sub ? h('span', { class: 'fn-stat-sub' }, sub) : null);
    const [mainM, ...moreM] = t.month;
    const [mainY, ...moreY] = t.year;
    const counts = [t.trials && plural(t.trials, 'free trial'), t.paused && `${t.paused} paused`].filter(Boolean).join(' · ');
    return [
      card('Per month', mainM ? money(mainM.amount, mainM.currency, { round: true }) : '—', moreM.length ? `+ ${moneyList(moreM, { round: true })}` : 'All active subscriptions', 'fn-stat--month'),
      card('Per year', mainY ? money(mainY.amount, mainY.currency, { round: true }) : '—', moreY.length ? `+ ${moneyList(moreY, { round: true })}` : null),
      card('Next payment', next ? next.sub.name : 'Nothing due', next ? `${money(next.sub.amount, next.sub.currency)} · ${whenText(next.date, today)}` : null, 'fn-stat--next'),
      card('Active', String(t.active), counts || null),
    ];
  }

  /* ---- The list ---- */

  function listPanel(s, today) {
    const subs = s.subscriptions;
    const live = F.sortSubs(subs.filter((x) => x.status === 'active' || x.status === 'trial'), s.view.sort, today);
    const paused = F.sortSubs(subs.filter((x) => x.status === 'paused'), s.view.sort, today);
    const cancelled = F.sortSubs(subs.filter((x) => x.status === 'cancelled'), 'name', today);
    const sort = seg(
      'Sort by',
      [
        { value: 'next', label: 'Next payment' },
        { value: 'price', label: 'Price' },
        { value: 'name', label: 'Name' },
      ],
      s.view.sort,
      (v) => setView({ sort: v }),
      'fn-sort',
    );
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
        'aria-label': `${sub.name}, ${money(sub.amount, sub.currency)} ${F.cycleLabel(sub).toLowerCase()}${next ? `, next payment ${formatDay(next, 'long')}` : ''}`,
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
      h('span', { class: 'fn-avatar', 'aria-hidden': 'true' }, initial(sub.name)),
      h(
        'div',
        { class: 'fn-row-main' },
        h('span', { class: 'fn-name' }, sub.name),
        h(
          'span',
          { class: 'fn-meta' },
          h('span', { class: 'tag' }, F.categoryName(sub.category)),
          status,
          next && sub.status === 'active' ? h('span', { class: ['tag', 'fn-next', soon && 'tag--solid'] }, `Next ${whenText(next, today).replace(/^(Today|Tomorrow|In )/, (w) => w.toLowerCase())}`) : null,
        ),
      ),
      h(
        'div',
        { class: 'fn-row-price' },
        h('span', { class: 'fn-price' }, money(sub.amount, sub.currency), h('span', { class: 'fn-per' }, ` ${F.cycleShort(sub)}`)),
        monthly ? h('span', { class: 'fn-monthly' }, `≈ ${money(F.perMonth(sub), sub.currency, { round: true })} / mo`) : null,
      ),
      h(
        'div',
        { class: 'row-actions fn-row-actions' },
        url ? h('a', { class: 'btn btn--ghost btn--icon btn--sm', href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Manage or cancel (opens their site)', 'aria-label': `Open ${sub.name}’s site` }, icon('external', { size: 14 })) : null,
        btn('', () => openEditor(sub.id), { iconName: 'edit', ghost: true, title: 'Edit', aria: `Edit ${sub.name}` }),
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
            { class: 'fn-cat' },
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

  function emptyView() {
    return h(
      'section',
      { class: 'panel hud fn-empty' },
      h('div', { class: 'empty-icon' }, icon('wallet', { size: 20 })),
      h('h2', { class: 'empty-title' }, 'Track your subscriptions'),
      h('p', { class: 'empty-text' }, 'Add what you pay for every month or year. LIFE/OS adds it up, shows what renews next and warns you before a free trial turns into a payment.'),
      h('div', { class: 'fn-starters' }, F.SUGGESTIONS.slice(0, 8).map((s) => h('button', { type: 'button', class: 'btn btn--sm', onClick: () => openEditor(null, { name: s.name, category: s.category }) }, icon('plus', { size: 13 }), s.name))),
      btn('Add subscription', () => openEditor(), { iconName: 'plus', primary: true, small: false }),
    );
  }

  /* ---- Right-click: copy, paste, duplicate, delete ---- */

  cleanups.push(
    registerContextProvider('finance', (el) => {
      if (!root.contains(el)) return null;
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
      };
    }),
  );

  // N: add a subscription (like N for a new task)
  const onKey = (e) => {
    if (e.key !== 'n' && e.key !== 'N') return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || modalOpen()) return;
    e.preventDefault();
    openEditor();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  render();
  cleanups.push(store.subscribe(render));
  cleanups.push(onDayChange(render));
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
  const trialField = h('div', { class: 'field' }, h('label', { class: 'label', for: trialIn.id }, 'Free trial ends'), trialIn, h('p', { class: 'fn-ed-hint' }, 'The first payment is that day. You’ll see it coming.'));
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
   Feature
   ========================================================================== */

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
