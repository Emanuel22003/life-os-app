// LIFE/OS — the reminder sounds, drawn with Web Audio on the spot: no audio files, nothing to
// download. Each is a short, pleasant shape (an alarm a little longer and more insistent, never
// harsh); 'none' is silent. The ids and names are SOUNDS in js/reminders.logic.js.
//
//   play(id)    play one now -> true when it could (the browser allowed sound)
//   prime()     set up sound during a click or key press: browsers only allow it after one
//   canPlay()   whether a sound could play now, without a click first
//
// The Pomodoro timer keeps its own bell (js/features/pomodoro.js); both follow the same rule.
// One AudioContext for every reminder sound; js/reminders.js primes it on the first click or key
// press in the window, so a reminder that comes later (the window in the background too) can ring.

const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
let ctx = null;

/** Set up sound during a user gesture (a click, a key press). -> the context, or null */
export function prime() {
  if (!AudioCtor) return null;
  try {
    if (!ctx) ctx = new AudioCtor();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch (err) {
    console.warn('[sounds] sound unavailable', err);
    ctx = null;
  }
  return ctx;
}

/** A sound could play now: the context runs, or the window has had a click or key press (sticky). */
export function canPlay() {
  if (!AudioCtor) return false;
  return (ctx && ctx.state === 'running') || !!globalThis.navigator?.userActivation?.hasBeenActive;
}

/** One soft partial: a sine (or another wave) with an envelope, into `out`. */
function tone(c, out, { freq, at, length, type = 'sine', level = 1, attack = 0.012 }) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(level, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain);
  gain.connect(out);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

/** A bell note: a sine with quiet overtones (`partials`: [multiple, level]). */
function bellNote(c, out, freq, at, length, partials = [[1, 1], [2.01, 0.22], [3.02, 0.08]]) {
  for (const [mult, level] of partials) tone(c, out, { freq: freq * mult, at, length: length / (mult > 2 ? 1.6 : 1), level });
}

/** Output with a master volume and a gentle low-pass, so nothing is shrill. */
function output(c, volume, cutoff = 6000) {
  const master = c.createGain();
  master.gain.setValueAtTime(volume, c.currentTime);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(cutoff, c.currentTime);
  master.connect(lp);
  lp.connect(c.destination);
  return master;
}

// Each shape: (context, start time) -> draws the sound (about 0.5–1.5 s; the alarm about 2.4 s)
const SHAPES = {
  // Two rising bell notes, G5 then C6: friendly and clear
  chime(c, t) {
    const out = output(c, 0.22);
    bellNote(c, out, 783.99, t, 1.1);
    bellNote(c, out, 1046.5, t + 0.18, 1.4);
  },
  // One struck bell: a fundamental with the inharmonic partials of a real bell, a long fade
  bell(c, t) {
    const out = output(c, 0.2);
    bellNote(c, out, 659.25, t, 1.6, [[1, 1], [2.4, 0.3], [3.9, 0.12], [5.4, 0.05]]);
  },
  // Two pairs of short, rounded beeps (a triangle through the low-pass: a watch, not a buzzer)
  digital(c, t) {
    const out = output(c, 0.16, 3200);
    for (const start of [0, 0.14, 0.42, 0.56]) tone(c, out, { freq: 1318.5, at: t + start, length: 0.09, type: 'triangle', attack: 0.004 });
  },
  // A slow, quiet swell of a soft chord (C5 + E5): for when any sound is too much
  soft(c, t) {
    const out = output(c, 0.14, 2400);
    tone(c, out, { freq: 523.25, at: t, length: 1.3, attack: 0.18 });
    tone(c, out, { freq: 659.25, at: t + 0.08, length: 1.2, attack: 0.2, level: 0.7 });
  },
  // Three rounds of a rising two-tone: longer and more insistent, still rounded (triangle, low-pass)
  alarm(c, t) {
    const out = output(c, 0.17, 2600);
    for (let round = 0; round < 3; round++) {
      const at = t + round * 0.8;
      tone(c, out, { freq: 880, at, length: 0.26, type: 'triangle', attack: 0.01 });
      tone(c, out, { freq: 1174.66, at: at + 0.3, length: 0.34, type: 'triangle', attack: 0.01 });
    }
  },
};

/** The sound ids this module draws ('none' plays nothing). */
export const SOUND_SHAPES = Object.freeze(Object.keys(SHAPES));

/**
 * Play a reminder sound now ('chime' · 'bell' · 'digital' · 'soft' · 'alarm'; 'none' and unknown
 * ids are silent). -> true when it played. Before any click or key press in the window the
 * browser refuses sound: then false (the notification's own sound stands in).
 */
export function play(id) {
  const shape = SHAPES[id];
  if (!shape) return false;
  const c = ctx ?? (canPlay() ? prime() : null);
  if (!c) return false;
  try {
    if (c.state !== 'running') {
      c.resume().catch(() => {});
      // Paused by the browser and no click allowed it since: it may stay silent (say so)
      if (!globalThis.navigator?.userActivation?.hasBeenActive) return false;
    }
    shape(c, c.currentTime + 0.04);
    return true;
  } catch (err) {
    console.warn('[sounds] could not play', id, err);
    return false;
  }
}
