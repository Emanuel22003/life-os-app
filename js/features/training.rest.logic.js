// LIFE/OS — Training's rest timer, the pure parts. One rest timer on each device, there whether a
// workout is going or not: pick a length (2:00 …), start it, and it counts down on every page.
// Ticking a set in a workout starts it too. No DOM or storage, so tools/tests/training.rest.test.js
// runs them in JavaScriptCore.
//
// Store 'training-rest' (this device only, never synced: you rest on the phone you're holding):
//   { sec, endsAt, sound }
// - sec: the length picked (15 s – 10 min)
// - endsAt: when the rest running now ends (ms), or null
// - sound: ring at the end

import { REST_MIN, REST_MAX } from './training.logic.js';

/** The lengths offered in the menu, in seconds. */
export const REST_PRESETS = Object.freeze([30, 45, 60, 90, 120, 150, 180, 240, 300]);
export const REST_START_SEC = 120;
/** How long "Rest over" stays up after the end before the timer is ready again. */
export const OVER_MS = 8000;
/** A rest that ended this long ago or more ended while nobody was looking: no late alarm. */
export const LATE_MS = 90_000;

export const DEFAULT_REST = Object.freeze({ sec: REST_START_SEC, endsAt: null, sound: true });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampSec = (n) => Math.min(REST_MAX, Math.max(REST_MIN, Math.round(n)));

export function normalizeRest(raw) {
  const src = isObject(raw) ? raw : {};
  return {
    sec: Number.isFinite(src.sec) ? clampSec(src.sec) : REST_START_SEC,
    endsAt: Number.isFinite(src.endsAt) && src.endsAt > 0 ? src.endsAt : null,
    sound: src.sound !== false,
  };
}

/** 'idle' (ready to start), 'running', or 'over' (ended under OVER_MS ago). */
export function restPhase(rest, now) {
  if (!rest.endsAt) return 'idle';
  if (rest.endsAt > now) return 'running';
  return now - rest.endsAt < OVER_MS ? 'over' : 'idle';
}

/** Whole seconds left (rounded up, so it shows 0:01 until the very end), 0 when not running. */
export function restLeft(rest, now) {
  return rest.endsAt && rest.endsAt > now ? Math.ceil((rest.endsAt - now) / 1000) : 0;
}

/** Start (or start again) now, for `sec` (the length picked by default). */
export function startRest(rest, now, sec = rest.sec) {
  return { ...rest, endsAt: now + clampSec(sec) * 1000 };
}

export function stopRest(rest) {
  return rest.endsAt ? { ...rest, endsAt: null } : rest;
}

/**
 * −15 s / +15 s. While it runs: the time left (down to the end, never past it); otherwise the
 * length picked.
 */
export function nudgeRest(rest, deltaSec, now) {
  if (restPhase(rest, now) === 'running') {
    const endsAt = Math.max(now, rest.endsAt + deltaSec * 1000);
    return { ...rest, endsAt: Math.min(endsAt, now + REST_MAX * 1000) };
  }
  return { ...rest, sec: clampSec(rest.sec + deltaSec) };
}

/** The length picked, for the next rest (one running keeps its own end). */
export function setRestLength(rest, sec) {
  return Number.isFinite(sec) ? { ...rest, sec: clampSec(sec) } : rest;
}

/** '2:00', '0:45', '10:00' */
export function lengthText(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** In words, for the menu and screen readers: '2 min', '45 s', '1 min 30 s' */
export function lengthWords(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/**
 * A length typed by hand -> seconds (between REST_MIN and REST_MAX), or null.
 * '2:30' = 150 · '2' = 2 min · '90' = 90 s (a plain number up to 10 is minutes, above that
 * seconds) · '90s', '90 sec' · '2m', '2 min' · '1.5' or '1,5' = 90 s.
 */
export function parseLength(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  let sec = null;
  let m;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) {
    if (Number(m[2]) < 60) sec = Number(m[1]) * 60 + Number(m[2]);
  } else if ((m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?)$/.exec(t))) {
    sec = Number(m[1]);
  } else if ((m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?)$/.exec(t))) {
    sec = Number(m[1]) * 60;
  } else if ((m = /^\d+(?:\.\d+)?$/.exec(t))) {
    const n = Number(t);
    sec = n <= 10 ? n * 60 : n;
  }
  if (sec == null || !Number.isFinite(sec)) return null;
  sec = Math.round(sec);
  return sec >= REST_MIN && sec <= REST_MAX ? sec : null;
}
