// LIFE/OS — 06 // Pomodoro: the timer engine. Pure and DOM-free, so tools/tests/pomodoro.test.js
// runs it in JavaScriptCore. pomodoro.js owns the store, the clock and every side effect.
//
// Store shape ('pomodoro'):
//   { settings: { focusMin, shortMin, longMin,          // minutes, 1..180
//                 roundsBeforeLong,                     // focus rounds before a long break, 1..12
//                 autoStartBreaks, autoStartFocus,      // start the next phase by itself
//                 sound, notify,                        // chime · desktop notification at a phase end
//                 showMini: 'active' | 'always' },      // the top-bar mini timer: while a session runs, or always
//     state: { phase: 'focus' | 'short' | 'long',
//              status: 'idle' | 'running' | 'paused',
//              endsAt,        // ms epoch, while running (null otherwise)
//              remainingMs,   // while paused or idle (idle: the whole phase); null while running
//              round,         // 1..roundsBeforeLong: which focus round of the cycle
//              taskId,        // the task being focused on (Tasks id) or null
//              startedAt,     // ms epoch of this session's first start (null while idle)
//              sessionId },   // id of the running / paused session (null while idle)
//     history: [{ id, phase, startedAt, endedAt, minutes, completed, taskId }] }   // oldest first, ≤ HISTORY_MAX
//
// Time left is always derived from endsAt (running) or remainingMs (paused / idle), never by
// counting ticks, so a reload, a route change, sleep or a throttled background tab can't drift it.
// Transitions are pure: (doc, now, …) -> doc, returning the same doc when nothing changes.
// A history entry's id is its session's id, so two windows recording the same session merge.

export const PHASES = Object.freeze(['focus', 'short', 'long']);
export const STATUSES = Object.freeze(['idle', 'running', 'paused']);
export const PHASE_LABEL = Object.freeze({ focus: 'Focus', short: 'Short break', long: 'Long break' });
export const MINI_MODES = Object.freeze(['active', 'always']);

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 12;
export const HISTORY_MAX = 500;
/** A stopped focus session shorter than this leaves no history entry (a start pressed by mistake). */
export const MIN_PARTIAL_MS = 60 * 1000;
/** A phase that ended longer ago than this (sleep, a closed app) ended "while you were away": no chime. */
export const AWAY_MS = 90 * 1000;

const MINUTE = 60 * 1000;
const MAX_TIME = 8.64e15; // the largest timestamp a Date can hold

export const DEFAULT_SETTINGS = Object.freeze({
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  roundsBeforeLong: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  notify: false,
  showMini: 'active',
});

export const PRESETS = Object.freeze(
  [
    { id: 'classic', label: 'Classic', focusMin: 25, shortMin: 5, longMin: 15, roundsBeforeLong: 4 },
    { id: 'deep', label: 'Deep work', focusMin: 50, shortMin: 10, longMin: 30, roundsBeforeLong: 3 },
    { id: 'quick', label: 'Quick', focusMin: 15, shortMin: 3, longMin: 10, roundsBeforeLong: 4 },
  ].map((p) => Object.freeze(p)),
);
const PRESET_FIELDS = ['focusMin', 'shortMin', 'longMin', 'roundsBeforeLong'];

/* ==========================================================================
   Normalization: anything stored (older versions, other tabs, hand edits) -> the shape above
   ========================================================================== */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIME;
const toId = (v) => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** A whole number in [lo, hi]; numeric strings count, anything else is the fallback. */
function clampInt(value, lo, hi, fallback) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

export function normalizeSettings(raw) {
  const s = isObject(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    focusMin: clampInt(s.focusMin, MIN_MINUTES, MAX_MINUTES, d.focusMin),
    shortMin: clampInt(s.shortMin, MIN_MINUTES, MAX_MINUTES, d.shortMin),
    longMin: clampInt(s.longMin, MIN_MINUTES, MAX_MINUTES, d.longMin),
    roundsBeforeLong: clampInt(s.roundsBeforeLong, MIN_ROUNDS, MAX_ROUNDS, d.roundsBeforeLong),
    autoStartBreaks: bool(s.autoStartBreaks, d.autoStartBreaks),
    autoStartFocus: bool(s.autoStartFocus, d.autoStartFocus),
    sound: bool(s.sound, d.sound),
    notify: bool(s.notify, d.notify),
    showMini: MINI_MODES.includes(s.showMini) ? s.showMini : d.showMini,
  };
}

/** Minutes of a phase under these settings. */
export function minutesOf(settings, phase) {
  if (phase === 'short') return settings.shortMin;
  if (phase === 'long') return settings.longMin;
  return settings.focusMin;
}

export const phaseMs = (settings, phase) => minutesOf(settings, phase) * MINUTE;

/** An id for a session nobody named (an auto-started phase, repaired data): the same inputs give the same id in every window. */
export const sessionIdFor = (time, phase) => `s-${Math.round(time).toString(36)}-${phase}`;

function idleState(phase, round, settings, taskId = null) {
  return { phase, status: 'idle', endsAt: null, remainingMs: phaseMs(settings, phase), round, taskId, startedAt: null, sessionId: null };
}

/**
 * The timer state against normalized `settings`: a known phase and status, round within the
 * cycle, a running state with a usable endsAt (no further away than the phase is long), a paused
 * one with remainingMs inside the phase. Anything unusable falls back to idle.
 */
export function normalizeTimerState(raw, settings, now = Date.now()) {
  const s = isObject(raw) ? raw : {};
  const phase = PHASES.includes(s.phase) ? s.phase : 'focus';
  const round = clampInt(s.round, MIN_ROUNDS, settings.roundsBeforeLong, MIN_ROUNDS);
  const taskId = toId(s.taskId);
  const total = phaseMs(settings, phase);
  const status = STATUSES.includes(s.status) ? s.status : 'idle';
  if (status === 'running' && isTime(s.endsAt)) {
    // A clock moved back (or junk) can't leave more than a whole phase to run
    const endsAt = Math.min(s.endsAt, now + total);
    const startedAt = isTime(s.startedAt) ? s.startedAt : null;
    return { phase, status, endsAt, remainingMs: null, round, taskId, startedAt, sessionId: toId(s.sessionId) ?? sessionIdFor(startedAt ?? endsAt, phase) };
  }
  if (status === 'paused' && typeof s.remainingMs === 'number' && Number.isFinite(s.remainingMs)) {
    const startedAt = isTime(s.startedAt) ? s.startedAt : null;
    const remainingMs = Math.min(total, Math.max(0, Math.round(s.remainingMs)));
    return { phase, status, endsAt: null, remainingMs, round, taskId, startedAt, sessionId: toId(s.sessionId) ?? sessionIdFor(startedAt ?? remainingMs + 1, phase) };
  }
  return idleState(phase, round, settings, taskId);
}

/** One stored history entry, or null when it can't be read. */
function normalizeEntry(raw) {
  if (!isObject(raw) || !PHASES.includes(raw.phase) || !isTime(raw.endedAt)) return null;
  const startedAt = isTime(raw.startedAt) && raw.startedAt <= raw.endedAt ? raw.startedAt : null;
  const minutes = typeof raw.minutes === 'number' && Number.isFinite(raw.minutes) ? Math.min(24 * 60, Math.max(0, raw.minutes)) : 0;
  return {
    id: toId(raw.id) ?? sessionIdFor(raw.endedAt, raw.phase),
    phase: raw.phase,
    startedAt,
    endedAt: raw.endedAt,
    minutes,
    completed: raw.completed === true,
    taskId: toId(raw.taskId),
  };
}

/** Readable entries only, one per id (the first stored wins), oldest first, the newest HISTORY_MAX. */
export function normalizeHistory(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  out.sort((a, b) => a.endedAt - b.endedAt);
  return out.length > HISTORY_MAX ? out.slice(out.length - HISTORY_MAX) : out;
}

/** The whole store value. Unknown top-level fields are kept (a newer version may add some). */
export function normalizePomodoro(raw, now = Date.now()) {
  const src = isObject(raw) ? raw : {};
  const settings = normalizeSettings(src.settings);
  return { ...src, settings, state: normalizeTimerState(src.state, settings, now), history: normalizeHistory(src.history) };
}

export function defaultDoc() {
  return normalizePomodoro({});
}

/* ==========================================================================
   Reading the clock
   ========================================================================== */

/** Milliseconds left in the current phase (0 once a running phase has passed its end). */
export function timeLeft(doc, now) {
  const { state, settings } = doc;
  const total = phaseMs(settings, state.phase);
  if (state.status === 'running') return Math.min(total, Math.max(0, state.endsAt - now));
  if (state.status === 'paused') return Math.min(total, Math.max(0, state.remainingMs));
  return total;
}

/** Milliseconds of the current phase already run (pauses excluded). */
export function elapsed(doc, now) {
  return phaseMs(doc.settings, doc.state.phase) - timeLeft(doc, now);
}

/** Share of the phase that is left, 1 (just started) … 0 (over). */
export function fractionLeft(doc, now) {
  const total = phaseMs(doc.settings, doc.state.phase);
  return total ? timeLeft(doc, now) / total : 0;
}

/** A running phase whose end has passed and is not recorded yet. */
export const isOverdue = (doc, now) => doc.state.status === 'running' && doc.state.endsAt <= now;

/** '25:00', '04:59', '00:00'; minutes past an hour stay minutes ('120:00'). Rounds up to the second. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Nav badge: whole minutes left while running ('12m', '1m' in the last minute), otherwise ''. */
export function badgeText(doc, now) {
  if (doc.state.status !== 'running') return '';
  return `${Math.max(1, Math.ceil(timeLeft(doc, now) / MINUTE))}m`;
}

/** Window title lead while running: '12:34 · Focus'; '' otherwise. */
export function titleText(doc, now) {
  if (doc.state.status !== 'running') return '';
  return `${formatClock(timeLeft(doc, now))} · ${PHASE_LABEL[doc.state.phase]}`;
}

/* ==========================================================================
   The cycle
   ========================================================================== */

/**
 * The phase after `phase` in round `round`: focus -> short break, or the long break after the
 * last round; a short break -> the next focus round; the long break -> focus, round 1.
 */
export function nextPhase(phase, round, settings) {
  const rounds = settings.roundsBeforeLong;
  if (phase === 'focus') return { phase: round >= rounds ? 'long' : 'short', round };
  if (phase === 'short') return { phase: 'focus', round: Math.min(round + 1, rounds) };
  return { phase: 'focus', round: 1 };
}

/** Does the phase after a finished one start by itself? */
export function autoStarts(phase, settings) {
  return phase === 'focus' ? settings.autoStartFocus : settings.autoStartBreaks;
}

const withState = (doc, state) => ({ ...doc, state });

function withEntry(doc, entry) {
  if (!entry || doc.history.some((e) => e.id === entry.id)) return doc;
  const history = [...doc.history, entry].sort((a, b) => a.endedAt - b.endedAt);
  return { ...doc, history: history.length > HISTORY_MAX ? history.slice(history.length - HISTORY_MAX) : history };
}

const roundMinutes = (ms) => Math.round((ms / MINUTE) * 10) / 10;

/**
 * The history entry for a focus session stopped before its end (reset, skip, switching phase),
 * or null: breaks and sessions shorter than MIN_PARTIAL_MS leave none.
 */
export function partialEntry(doc, now) {
  const { state } = doc;
  if (state.phase !== 'focus' || state.status === 'idle') return null;
  const ran = elapsed(doc, now);
  if (ran < MIN_PARTIAL_MS) return null;
  return {
    id: state.sessionId ?? sessionIdFor(state.startedAt ?? now, state.phase),
    phase: state.phase,
    startedAt: state.startedAt,
    endedAt: now,
    minutes: roundMinutes(ran),
    completed: false,
    taskId: state.taskId,
  };
}

/* ==========================================================================
   Transitions
   ========================================================================== */

/** Start (idle) or resume (paused). `id` names a new session (the caller's uid). */
export function start(doc, now, { id } = {}) {
  const s = doc.state;
  if (s.status === 'running') return doc;
  const fresh = s.status === 'idle' || !s.sessionId;
  return withState(doc, {
    ...s,
    status: 'running',
    endsAt: now + timeLeft(doc, now),
    remainingMs: null,
    startedAt: s.status === 'idle' || !s.startedAt ? now : s.startedAt,
    sessionId: fresh ? toId(id) ?? sessionIdFor(now, s.phase) : s.sessionId,
  });
}

export function pause(doc, now) {
  const s = doc.state;
  if (s.status !== 'running') return doc;
  return withState(doc, { ...s, status: 'paused', endsAt: null, remainingMs: timeLeft(doc, now) });
}

/** Start / resume when stopped, pause while running. */
export function toggle(doc, now, opts) {
  return doc.state.status === 'running' ? pause(doc, now) : start(doc, now, opts);
}

/** Stop and put the current phase back to its full length (a focus session that ran a minute or more is kept as stopped early). */
export function reset(doc, now) {
  const s = doc.state;
  if (s.status === 'idle') return doc;
  return withState(withEntry(doc, partialEntry(doc, now)), idleState(s.phase, s.round, doc.settings, s.taskId));
}

/** Back to the start of the cycle: focus, round 1, stopped. */
export function resetCycle(doc, now) {
  const s = doc.state;
  if (s.status === 'idle' && s.phase === 'focus' && s.round === 1) return doc;
  return withState(withEntry(doc, partialEntry(doc, now)), idleState('focus', 1, doc.settings, s.taskId));
}

/**
 * End the current phase early and move to the next one. The next phase starts by itself only
 * when the skipped one was running and its auto-start setting is on.
 */
export function skip(doc, now, { id } = {}) {
  const s = doc.state;
  const next = nextPhase(s.phase, s.round, doc.settings);
  const after = withState(withEntry(doc, partialEntry(doc, now)), idleState(next.phase, next.round, doc.settings, s.taskId));
  return s.status === 'running' && autoStarts(next.phase, doc.settings) ? start(after, now, { id }) : after;
}

/** Choose a phase by hand (the page's phase tabs): stopped, full length, same round. */
export function switchPhase(doc, phase, now) {
  if (!PHASES.includes(phase)) return doc;
  const s = doc.state;
  if (s.phase === phase && s.status === 'idle') return doc;
  return withState(withEntry(doc, partialEntry(doc, now)), idleState(phase, s.round, doc.settings, s.taskId));
}

/** What the timer is focusing on (a task id, or null for nothing in particular). */
export function setTask(doc, taskId) {
  const id = toId(taskId);
  return doc.state.taskId === id ? doc : withState(doc, { ...doc.state, taskId: id });
}

/**
 * New settings (a patch). The current phase follows a change of its own length: idle shows the
 * new length; a paused or running session keeps what it already ran (a running one past its new
 * end finishes at once).
 */
export function updateSettings(doc, patch, now) {
  const settings = normalizeSettings({ ...doc.settings, ...(isObject(patch) ? patch : {}) });
  if (Object.keys(settings).every((k) => settings[k] === doc.settings[k])) return doc;
  const s = doc.state;
  const round = Math.min(s.round, settings.roundsBeforeLong);
  const delta = phaseMs(settings, s.phase) - phaseMs(doc.settings, s.phase);
  let state;
  if (s.status === 'idle') state = idleState(s.phase, round, settings, s.taskId);
  else if (s.status === 'paused') state = { ...s, round, remainingMs: Math.min(phaseMs(settings, s.phase), Math.max(0, s.remainingMs + delta)) };
  else state = { ...s, round, endsAt: Math.max(now, s.endsAt + delta) };
  return { ...doc, settings, state };
}

/** The preset these settings match ('classic' | 'deep' | 'quick'), or 'custom'. */
export function presetOf(settings) {
  return PRESETS.find((p) => PRESET_FIELDS.every((k) => p[k] === settings[k]))?.id ?? 'custom';
}

export function applyPreset(doc, presetId, now) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return doc;
  return updateSettings(doc, Object.fromEntries(PRESET_FIELDS.map((k) => [k, preset[k]])), now);
}

/**
 * Record a running phase that has reached its end and move on. The phase ended at its endsAt
 * (not "now"), so a window that notices late (sleep, a throttled background tab, a closed app)
 * records the true time, and an auto-started next phase starts at that moment: when part of it
 * has already run, it keeps running with what is left. One that would already be over too
 * waits instead (nobody was there to take it), so a long absence never piles up sessions.
 *
 * -> { doc, completed: the history entry | null, next: the new state | null }
 */
export function settle(doc, now) {
  if (!isOverdue(doc, now)) return { doc, completed: null, next: null };
  const s = doc.state;
  const endedAt = s.endsAt;
  const completed = {
    id: s.sessionId ?? sessionIdFor(s.startedAt ?? endedAt, s.phase),
    phase: s.phase,
    startedAt: s.startedAt,
    endedAt,
    minutes: minutesOf(doc.settings, s.phase),
    completed: true,
    taskId: s.taskId,
  };
  const nx = nextPhase(s.phase, s.round, doc.settings);
  const length = phaseMs(doc.settings, nx.phase);
  const next =
    autoStarts(nx.phase, doc.settings) && endedAt + length > now
      ? { phase: nx.phase, status: 'running', endsAt: endedAt + length, remainingMs: null, round: nx.round, taskId: s.taskId, startedAt: endedAt, sessionId: sessionIdFor(endedAt, nx.phase) }
      : idleState(nx.phase, nx.round, doc.settings, s.taskId);
  return { doc: withState(withEntry(doc, completed), next), completed, next };
}

/** True when a phase that ended at `endedAt` is noticed too late for a chime (see AWAY_MS). */
export const endedWhileAway = (endedAt, now) => now - endedAt > AWAY_MS;

/* ==========================================================================
   History
   ========================================================================== */

/**
 * Focus history between two instants (ms; a local day's midnight to the next):
 * { sessions: finished focus sessions, minutes: focus minutes incl. sessions stopped early,
 *   entries: those focus entries, oldest first }.
 */
export function focusStats(history, from, to) {
  const entries = (Array.isArray(history) ? history : []).filter((e) => e.phase === 'focus' && e.endedAt >= from && e.endedAt < to);
  const minutes = entries.reduce((sum, e) => sum + e.minutes, 0);
  return { sessions: entries.filter((e) => e.completed).length, minutes: Math.round(minutes * 10) / 10, entries };
}

/** Remove entries by id (Undo of an action that recorded them). Same doc when none is there. */
export function withoutEntries(doc, ids) {
  const drop = new Set(ids);
  if (!doc.history.some((e) => drop.has(e.id))) return doc;
  return { ...doc, history: doc.history.filter((e) => !drop.has(e.id)) };
}
