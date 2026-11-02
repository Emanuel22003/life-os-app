// LIFE/OS — Google Calendar: what the calendar and Home show of it. An event from Google opens
// this read-only sheet (when, where, which calendar, its description, and a link to change it in
// Google Calendar); the calendar's Google bar offers Refresh when the events need a tap to update.

import { h, icon, registerIcon, openModal } from './ui.js';
import { viewTitle } from './features/calendar.logic.js';
import { googleState, googleStatus, googleEvent, refreshGoogle } from './google.js';
import { updatedText, problemText } from './google.logic.js';

// From an online calendar: the app's mark for Google's events (Show menu, sheet, bar, Settings)
registerIcon('cloud', '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5Z"/>');

/** When an occurrence is, in words: 'Tue 3 Nov · 09:00–09:15' / 'Wed 4 Nov – Thu 5 Nov · All day'. */
export function whenText(occ) {
  const day = (key) => viewTitle('day', key);
  if (!occ.allDay) return `${day(occ.start)} · ${occ.startTime}–${occ.endTime}`;
  return occ.spanDays > 1 ? `${day(occ.start)} – ${day(occ.end)} · All day` : `${day(occ.start)} · All day`;
}

/** The read-only sheet of a Google occurrence (calendar.logic occurrencesInRange). onClose: after it. */
export function openGoogleEvent(occ, { onClose } = {}) {
  const ev = occ && googleEvent(occ.eventId);
  if (!ev) return null;
  const cal = googleState().calendars.find((c) => c.id === ev.calendarId);
  const line = (name, text) => h('p', { class: 'gcal-sheet-row' }, icon(name, { size: 14 }), h('span', null, text));
  let m = null;
  const close = h('button', { type: 'button', class: 'btn btn--primary', onClick: () => m.close() }, 'Close');
  m = openModal({
    title: occ.title,
    className: 'gcal-sheet',
    body: h(
      'div',
      { class: 'gcal-sheet-body' },
      line('clock', whenText(occ)),
      occ.location ? line('map-pin', occ.location) : null,
      line('cloud', cal ? `Google Calendar · ${cal.name}` : 'Google Calendar'),
      ev.notes ? h('p', { class: 'gcal-sheet-notes' }, ev.notes) : null,
      h('p', { class: 'gcal-sheet-hint' }, 'From your Google Calendar. LIFE/OS shows it; change or delete it in Google Calendar.'),
    ),
    footer: [ev.link ? h('a', { class: 'btn', href: ev.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Google Calendar', icon('external', { size: 14 })) : null, close].filter(Boolean),
    initialFocus: close,
    onClose,
  });
  return m;
}

/**
 * The calendar's Google bar: shown only when Google's events need a tap to update (access ran
 * out, or Google couldn't be reached), with Refresh. range(): the period on screen.
 */
export function googleBar({ range = () => null } = {}) {
  const el = h('div', { class: 'gcal-bar', role: 'status', hidden: true });
  let sig = '';
  function paint() {
    const g = googleState();
    const st = googleStatus();
    const need = g.connected && g.show && (st.state === 'signin' || st.state === 'error');
    const next = need ? `${st.state}:${st.problem}:${g.updatedAt}:${Math.floor(Date.now() / 60000)}` : '';
    if (next === sig) return;
    sig = next;
    el.hidden = !need;
    if (!need) return el.replaceChildren();
    const text = st.state === 'signin' && st.problem !== 'popup_failed_to_open' ? `Google Calendar · ${updatedText(g.updatedAt)}. Refresh to get the latest.` : `Google Calendar · ${problemText(st.problem)}`;
    const btn = h('button', { type: 'button', class: 'btn btn--sm', onClick: () => refreshGoogle({ tap: true, range: range() }) }, icon('sync', { size: 14 }), 'Refresh');
    el.replaceChildren(icon('cloud', { size: 14 }), h('span', { class: 'gcal-bar-text' }, text), btn);
    return undefined;
  }
  return { el, paint };
}
