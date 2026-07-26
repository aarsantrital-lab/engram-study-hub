/* =============================================================================
   js/sounds.js — every cue in the hub, synthesised with WebAudio.
   Job: GAME LAYER.

   Zero audio files, zero external origins (build-constraints §9.5): every
   sound here is oscillators, a noise buffer and envelopes. Nothing is fetched.

   Design rules that are pedagogy, not taste:
     · The WRONG cue is a soft, low thud — never a buzzer, never harsh. A wrong
       answer is information, and the sound must not punish it (§3.7: feedback
       on the task, never on the person). It is quieter than the correct cue.
     · Everything is behind the sounds feature flag, and every cue also fires
       the matching haptic so the phone can answer when the volume is down.
     · He studies at night: the master gain is deliberately low.
     · Autoplay policy: the AudioContext is created lazily and resumed on the
       first user gesture. Nothing here ever throws into a caller.
   ========================================================================== */

import { isFeatureEnabled } from './config.js';
import { haptic } from './dom.js';

/* ---------------------------------------------------------------------------
   1. Context
   ------------------------------------------------------------------------ */

let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;
let gestureWired = false;

/** Master level. Low on purpose — this plays at 10:25 PM in a shared house. */
const MASTER_GAIN = 0.16;

function audioCtx() {
  if (ctx) return ctx;
  try {
    const Ctx = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
    wireGesture();
    return ctx;
  } catch (_) { ctx = null; return null; }
}

function wireGesture() {
  if (gestureWired || typeof window === 'undefined') return;
  gestureWired = true;
  const resume = () => {
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (_) { /* ignore */ } }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, resume, { passive: true });
  }
}

/**
 * Create the AudioContext inside a user gesture so iOS unlocks it.
 * Call once from the first tap in a session (optional — cues self-unlock too).
 */
export function unlock() {
  const c = audioCtx();
  if (c && c.state === 'suspended') { try { c.resume(); } catch (_) { /* ignore */ } }
  return Boolean(c);
}

/** Sounds are on when the build flag and the user setting both allow it. */
export function isEnabled() { return !muted && isFeatureEnabled('sounds'); }

/** Transient mute (focus mode, a timed paper). Does not touch settings. */
export function setMuted(v) { muted = Boolean(v); return muted; }
export function isMuted() { return muted; }

/* ---------------------------------------------------------------------------
   2. Primitives
   ------------------------------------------------------------------------ */

function noise() {
  if (noiseBuffer || !ctx) return noiseBuffer;
  const len = Math.floor(ctx.sampleRate * 0.4);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i += 1) {
    // Deterministic pseudo-noise: identical every session, no Math.random.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff) - 1;
  }
  noiseBuffer = buf;
  return noiseBuffer;
}

/**
 * One shaped oscillator voice.
 * @param {{freq:number, to?:number, type?:OscillatorType, at?:number,
 *          dur?:number, gain?:number, attack?:number, curve?:'exp'|'lin'}} spec
 */
function voice(spec) {
  const c = audioCtx();
  if (!c) return;
  const t0 = c.currentTime + Math.max(0, spec.at || 0);
  const dur = Math.max(0.02, spec.dur || 0.12);
  const peak = Math.max(0.0002, spec.gain === undefined ? 0.5 : spec.gain);
  const attack = spec.attack === undefined ? 0.008 : spec.attack;

  const osc = c.createOscillator();
  osc.type = spec.type || 'sine';
  osc.frequency.setValueAtTime(spec.freq, t0);
  if (spec.to) {
    if (spec.curve === 'lin') osc.frequency.linearRampToValueAtTime(spec.to, t0 + dur);
    else osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to), t0 + dur);
  }

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  let tail = g;
  if (spec.lowpass) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(spec.lowpass, t0);
    g.connect(f);
    tail = f;
  }
  osc.connect(g);
  tail.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** A filtered noise burst — the body of a thud or a pop. */
function burst(spec) {
  const c = audioCtx();
  if (!c) return;
  const buf = noise();
  if (!buf) return;
  const t0 = c.currentTime + Math.max(0, spec.at || 0);
  const dur = Math.max(0.02, spec.dur || 0.1);

  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = spec.rate || 1;

  const f = c.createBiquadFilter();
  f.type = spec.filter || 'lowpass';
  f.frequency.setValueAtTime(spec.freq || 900, t0);
  if (spec.freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, spec.freqTo), t0 + dur);
  f.Q.value = spec.q === undefined ? 0.9 : spec.q;

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, spec.gain || 0.3), t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

/* ---------------------------------------------------------------------------
   3. The cue library
   ------------------------------------------------------------------------ */

const CUES = {
  /* A retrieval attempt landed. Short, bright, over instantly. */
  correct() {
    voice({ freq: 660, to: 990, type: 'sine', dur: 0.09, gain: 0.5 });
    voice({ freq: 1320, type: 'sine', dur: 0.05, gain: 0.12, at: 0.05 });
  },

  /* A retrieval attempt missed. SOFT. Low, damped, quieter than `correct`.
     This is the sound of information arriving, not of a buzzer. */
  wrong() {
    voice({ freq: 190, to: 130, type: 'triangle', dur: 0.19, gain: 0.34, lowpass: 700, attack: 0.014 });
    burst({ freq: 320, freqTo: 140, dur: 0.13, gain: 0.1, rate: 0.7 });
  },

  /* The night is banked. A small three-note chime, never a fanfare. */
  streak() {
    voice({ freq: 523.25, type: 'sine', dur: 0.16, gain: 0.34 });
    voice({ freq: 659.25, type: 'sine', dur: 0.16, gain: 0.32, at: 0.09 });
    voice({ freq: 783.99, type: 'sine', dur: 0.26, gain: 0.3, at: 0.18 });
  },

  /* Confetti pop — one soft percussive spit of air plus a rising blip. */
  confetti() {
    burst({ freq: 1800, freqTo: 600, dur: 0.09, gain: 0.24, filter: 'bandpass', q: 1.4, rate: 1.6 });
    voice({ freq: 420, to: 1200, type: 'sine', dur: 0.11, gain: 0.24 });
  },

  /* A mark lands on the boss. Percussive, felt more than heard. */
  'boss-hit'() {
    voice({ freq: 150, to: 70, type: 'square', dur: 0.1, gain: 0.4, lowpass: 900 });
    burst({ freq: 2400, freqTo: 700, dur: 0.07, gain: 0.16, filter: 'bandpass', q: 2 });
  },

  /* The paper is down. Rising, four notes, still short. */
  'boss-down'() {
    const notes = [392, 523.25, 659.25, 880];
    notes.forEach((f, i) => voice({ freq: f, type: 'triangle', dur: 0.22, gain: 0.3, at: i * 0.085 }));
    burst({ freq: 1400, freqTo: 300, dur: 0.3, gain: 0.12, at: 0.24, rate: 0.8 });
  },

  /* The paper survived. Not a failure sound — a low, neutral settle. */
  'boss-stand'() {
    voice({ freq: 300, to: 220, type: 'sine', dur: 0.26, gain: 0.26, lowpass: 1200 });
  },

  /* A ring closed. */
  'ring-close'() {
    voice({ freq: 587.33, type: 'sine', dur: 0.13, gain: 0.3 });
    voice({ freq: 880, type: 'sine', dur: 0.2, gain: 0.26, at: 0.08 });
  },

  /* A capability level was reached. */
  'level-up'() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => voice({ freq: f, type: 'sine', dur: 0.24, gain: 0.28, at: i * 0.07 }));
  },

  /* Generic UI tick — grade buttons, chips. */
  tap() { voice({ freq: 880, type: 'sine', dur: 0.035, gain: 0.16 }); },

  /* A timer expired (per-question countdown in a timed paper). */
  timeup() {
    voice({ freq: 440, type: 'triangle', dur: 0.12, gain: 0.3 });
    voice({ freq: 440, type: 'triangle', dur: 0.12, gain: 0.3, at: 0.16 });
  },
};

/** Every cue name this module knows. */
export const CUE_NAMES = Object.freeze(Object.keys(CUES));

/** Haptic to pair with each cue (dom.js owns the vibration patterns). */
const HAPTIC_FOR = Object.freeze({
  correct: 'select',
  wrong: 'soft',
  streak: 'success',
  confetti: 'success',
  'boss-hit': 'warn',
  'boss-down': 'levelup',
  'boss-stand': 'soft',
  'ring-close': 'success',
  'level-up': 'levelup',
  tap: 'tap',
  timeup: 'warn',
});

/**
 * Play a cue. No-op when sounds are off or WebAudio is unavailable.
 * @param {keyof typeof CUES} name
 * @returns {boolean} true when something was scheduled
 */
export function play(name) {
  try {
    if (!isEnabled()) return false;
    const fn = CUES[name];
    if (!fn) return false;
    const c = audioCtx();
    if (!c) return false;
    if (c.state === 'suspended') { try { c.resume(); } catch (_) { /* ignore */ } }
    fn();
    return true;
  } catch (err) {
    console.warn('[sounds] cue failed', err);
    return false;
  }
}

/**
 * Play a cue AND its haptic. This is the function the rest of the hub calls —
 * the phone answers even when the volume is down.
 * @param {keyof typeof CUES} name
 * @param {{haptic?:string|false}} [opts]
 */
export function cue(name, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const played = play(name);
  const h = o.haptic === undefined ? HAPTIC_FOR[name] : o.haptic;
  if (h) { try { haptic(h); } catch (_) { /* ignore */ } }
  return played;
}

/** Grade-button feedback in one call: cue('correct') or the soft cue('wrong'). */
export function gradeCue(correct) { return cue(correct ? 'correct' : 'wrong'); }

export default { cue, play, gradeCue, unlock, isEnabled, setMuted, isMuted, CUE_NAMES };
