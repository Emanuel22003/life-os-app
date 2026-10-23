// LIFE/OS — the business details that every legal page shows (legal/*.html; legal.js fills them in).
//
// This is the ONE place to fill them in. A value left as '' shows on the pages as a clearly
// marked "[FILL IN: …]", so nothing made up is ever published as if it were a fact. Fill in only
// what is true today; the README's "Legal & release checklist" says what each one needs.
//
// A plain script (not a module), so the pages also fill in when opened straight from disk.
window.LIFEOS_LEGAL = {
  // The person or company that offers LIFE/OS: a full name, or the registered company name
  owner: '',
  // As registered in Brønnøysundregistrene, e.g. 'Sole proprietorship (enkeltpersonforetak, ENK)'
  // or 'Private limited company (aksjeselskap, AS)'
  legalForm: '',
  // The 9-digit organisasjonsnummer from Enhetsregisteret, e.g. '123 456 789'
  orgNumber: '',
  // The register(s) the business is in, e.g. 'Enhetsregisteret' or 'Foretaksregisteret'
  register: '',
  // A postal address people can write to: street, postcode and town
  address: '',
  // Where people reach you about privacy, the terms, refunds and support (read it regularly)
  email: '',
  // The company that stores the emails sent to that address, and the country it keeps them in:
  // the privacy policy names it as a recipient (GDPR art. 13), e.g. '<company>, <country>'. If
  // that country is outside the EEA, also note the safeguard (an adequacy decision or the
  // standard contractual clauses) in privacy.html section 5.
  emailProvider: '',
  // e.g. 'Registered in the Norwegian VAT register (Merverdiavgiftsregisteret)' or
  // 'Not registered for VAT'
  vat: '',
  country: 'Norway',
  // Only once a paid plan exists: the full price a consumer pays, VAT included,
  // e.g. 'NOK 49 per month, VAT included'
  priceMonthly: '',
  priceYearly: '',
  // The day the legal texts last changed (YYYY-MM-DD): shown as "Last updated" on every page.
  // Change it whenever you change what a page says.
  updated: '2026-10-23',
};
