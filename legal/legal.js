// LIFE/OS — the legal pages' blanks (legal/*.html), filled in from legal/business.js.
//
// Every element with data-legal="<key>" gets that value from window.LIFEOS_LEGAL. A value that
// is still empty shows as "[FILL IN: …]", marked by .legal-missing, so a blank can't go unnoticed
// or be mistaken for a fact. The HTML already holds those placeholders, so a page reads the same
// without JavaScript, and the draft note ([data-legal-draft]) shows until every blank on the page
// is filled.
//
// A plain script, not a module: the pages must also work when opened straight from disk (the
// browser refuses modules there). It adds one global, LifeosLegal, whose pure helpers
// tools/tests/legal.test.js checks in JavaScriptCore.
(function (root) {
  'use strict';

  // What each blank asks for: the words after "FILL IN:"
  var LABELS = {
    owner: 'name of the person or company',
    legalForm: 'legal form',
    orgNumber: 'organisation number',
    register: 'register',
    address: 'postal address',
    email: 'contact email',
    emailProvider: 'email provider and the country where it keeps email',
    vat: 'VAT status',
    country: 'country',
    priceMonthly: 'price per month, VAT included',
    priceYearly: 'price per year, VAT included',
    updated: 'date',
  };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // Text as it should read: a string with its spaces tidied, or '' for anything else
  function clean(value) {
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function placeholder(key) {
    return '[FILL IN: ' + (Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : key) + ']';
  }

  /** '2026-10-18' -> '18 October 2026'; anything that isn't a real date -> ''. */
  function formatDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value));
    if (!m) return '';
    var year = Number(m[1]);
    var month = Number(m[2]);
    var day = Number(m[3]);
    // Day 0 of the next month is the last day of this one (handles leap years)
    var last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > last) return '';
    return day + ' ' + MONTHS[month - 1] + ' ' + year;
  }

  /** A mailto: link for a plausible address, or '' (then the address shows as plain text). */
  function mailtoHref(value) {
    var email = clean(value);
    return /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/.test(email) ? 'mailto:' + email : '';
  }

  /**
   * The text for one blank: { text, missing }. missing: the value is empty (or, for `updated`,
   * not a real YYYY-MM-DD date), and text is the "[FILL IN: …]" placeholder.
   */
  function legalValue(info, key) {
    var own = info !== null && typeof info === 'object' && Object.prototype.hasOwnProperty.call(info, key);
    var text = own ? clean(info[key]) : '';
    if (key === 'updated') text = formatDate(text);
    return text ? { text: text, missing: false } : { text: placeholder(key), missing: true };
  }

  /** Fill every [data-legal] element under doc; returns how many are still blank. */
  function fillPage(doc, info) {
    var blanks = 0;
    var nodes = doc.querySelectorAll('[data-legal]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-legal');
      var value = legalValue(info, key);
      if (value.missing) blanks++;
      el.textContent = value.text;
      if (value.missing) el.classList.add('legal-missing');
      else el.classList.remove('legal-missing');
      var tag = String(el.tagName).toUpperCase();
      // An email blank written as a link becomes a working mailto: link once it's filled
      if (tag === 'A') {
        var href = value.missing ? '' : key === 'email' ? mailtoHref(value.text) : '';
        if (href) el.setAttribute('href', href);
        else el.removeAttribute('href');
      }
      if (tag === 'TIME') {
        if (value.missing) el.removeAttribute('datetime');
        else el.setAttribute('datetime', clean(info[key]));
      }
    }
    var drafts = doc.querySelectorAll('[data-legal-draft]');
    for (var j = 0; j < drafts.length; j++) drafts[j].hidden = blanks === 0;
    return blanks;
  }

  root.LifeosLegal = { LABELS: LABELS, clean: clean, placeholder: placeholder, formatDate: formatDate, mailtoHref: mailtoHref, legalValue: legalValue, fillPage: fillPage };

  if (typeof document === 'undefined') return;
  function run() {
    fillPage(document, root.LIFEOS_LEGAL || {});
  }
  // Loaded with defer, so the page is parsed by now; the check keeps it right if that changes
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})(typeof window !== 'undefined' ? window : globalThis);
