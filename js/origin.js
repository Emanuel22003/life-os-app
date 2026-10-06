// LIFE/OS — which copy of the app this page is.
//
// The browser keeps data per address (origin), so every address is a LIFE/OS with its own storage.
// Two addresses are real: the Mac's background service, and the website (GitHub Pages) that other
// computers open and install. Anything else (a developer preview, another port) is a test copy:
// it must never look like the real app, offer to install, or sync.
// `?treat-as-real` lifts that for testing the install flow on another port (this tab only; it
// still never syncs). index.html's head script repeats REAL_ORIGINS: keep the two in step.

export const LOCAL_ORIGIN = 'http://127.0.0.1:8765';
export const SITE_ORIGIN = 'https://emanuel22003.github.io';
export const SITE_URL = `${SITE_ORIGIN}/life-os-app/`;
export const REAL_ORIGINS = Object.freeze([LOCAL_ORIGIN, SITE_ORIGIN]);

/** Served from one of the real addresses (sync is only ever offered here). */
export const isRealAddress = REAL_ORIGINS.includes(location.origin);

export const isRealCopy = (() => {
  if (isRealAddress) return true;
  try {
    if (/[?&]treat-as-real/.test(location.search + location.hash)) sessionStorage.setItem('lifeos:treat-as-real', '1');
    return sessionStorage.getItem('lifeos:treat-as-real') === '1';
  } catch {
    return false;
  }
})();

/** The website copy (GitHub Pages) rather than the Mac's own. */
export const isSite = location.origin === SITE_ORIGIN;
