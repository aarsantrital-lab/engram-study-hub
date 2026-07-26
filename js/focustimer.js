/* =============================================================================
   js/focustimer.js — the adaptive Pomodoro engine behind Focus Mode.
   Owner: Job — Focus Mode + Study Room.  Pairs with js/views/focus.js.

   Imports store.js ONLY. No DOM, no window, no document — so it runs in a
   node harness and can be unit-tested without a browser.

   What lives here:
     · createFocusTimer()  — a wall-clock block/break timer (never drifts when
       the tab is throttled; every reading is derived from Date.now()).
     · sustainableInterval() — learns his interval from completion history.
       The rule is deterministic and explainable, because he is told WHY the
       number moved (pedagogy-spec §3.7: explain the machinery, marks-language,
       never vague praise).
     · the KEYS.FOCUS record layer: preset, sessions, distraction pad, muteChat.

   Persistence rules obeyed here:
     · store API only, never raw localStorage.
     · store.set() -> false means the quota refused the write. We NEVER prune,
       never retry-loop, never delete a session or a parked thought. The value
       stays live in memory and app.js shows the banner. (CONTRACT-A §5/§16.2)
     · every day key comes from store's LOCAL date helpers (Nepal is UTC+05:45).
   ========================================================================== */

import { store, KEYS, todayLocalISO, dayKeyFromTs, uid, nowTs } from './store.js';

/* ---------------------------------------------------------------------------
   1. Policy constants
   ------------------------------------------------------------------------ */

export const FOCUS_LIMITS = Object.freeze({
  minMinutes: 10,          // a block shorter than this is not a block
  maxMinutes: 50,          // past this, attention data says it is fiction
  stepMinutes: 5,          // the learner moves in 5-minute rungs
  defaultMinutes: 25,      // the standing start (pedagogy-spec §1.6 budget)
  breakMinutes: 5,
  longBreakMinutes: 15,
  blocksBeforeLongBreak: 3,
  extendMinutes: 5,        // "extend — I'm in flow"
  minSessionSec: 90,       // the 90-second escape hatch: still a real session
  learnWindow: 12,         // how many past blocks the learner looks at
  learnSample: 3,          // blocks needed before the interval may move
  shortRatio: 0.6,         // < 60% of the planned block = stopped early
});

/** The three lanes a declared task can map to (game.recordActivity kinds). */
export const TASK_KINDS = Object.freeze(['review', 'encode', 'drill']);

/** Student-facing labels for the lanes. Marks-language, no vague praise. */
export const KIND_LABELS = Object.freeze({
  review: 'Review',
  encode: 'Encode',
  drill: 'Drill',
});

export const KIND_BLURBS = Object.freeze({
  review: 'Cards due, retrieval to criterion.',
  encode: 'Build the map, make the material make sense.',
  drill: 'Numericals, past-paper questions, timed marks.',
});

/** Arousal 1–5 — logged before the block, used to explain the suggestion. */
export const AROUSAL_LABELS = Object.freeze({
  1: 'Flat',
  2: 'Low',
  3: 'Steady',
  4: 'Sharp',
  5: 'Wired',
});

const JOT_STATUS = Object.freeze(['open', 'done', 'dropped']);

/* ---------------------------------------------------------------------------
   2. Small pure helpers
   ------------------------------------------------------------------------ */

/**
 * Number or fallback. null / undefined / '' are ABSENT, not zero — otherwise a
 * skipped arousal reading would be stored as a real "0" and the fallback
 * argument would never be reached (Number(null) === 0, which is finite).
 */
const num = (v, dflt) => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Snap to the 5-minute rung and clamp into the legal block range. */
export function clampMinutes(minutes, dflt) {
  const raw = num(minutes, num(dflt, FOCUS_LIMITS.defaultMinutes));
  const step = FOCUS_LIMITS.stepMinutes;
  const snapped = Math.round(raw / step) * step;
  return clampNum(snapped, FOCUS_LIMITS.minMinutes, FOCUS_LIMITS.maxMinutes);
}

function clampBreakMinutes(minutes, dflt) {
  return clampNum(Math.round(num(minutes, num(dflt, FOCUS_LIMITS.breakMinutes))), 1, 30);
}

function median(list) {
  const arr = list.slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/* ---------------------------------------------------------------------------
   3. The KEYS.FOCUS record  { sessions, preset, muteChat, pad }
   ------------------------------------------------------------------------ */

function blankState() {
  return {
    v: 1,
    /* autoBreak is reserved for Settings: when true the break clock starts by
       itself at the bell. Focus mode leaves it false so the bell is a CHOICE
       (extend / break / stop) rather than a countdown he has to interrupt. */
    preset: { minutes: FOCUS_LIMITS.defaultMinutes, breakMinutes: FOCUS_LIMITS.breakMinutes, autoBreak: false },
    muteChat: true,
    sessions: [],
    pad: [],
    lastArousal: null,
    lastKind: null,
  };
}

/** Read KEYS.FOCUS, normalised. Never returns null, never throws. */
export function readFocus() {
  const raw = store.get(KEYS.FOCUS, null);
  const base = blankState();
  if (!raw || typeof raw !== 'object') return base;
  const preset = raw.preset && typeof raw.preset === 'object' ? raw.preset : {};
  return {
    v: 1,
    preset: {
      minutes: clampMinutes(preset.minutes, FOCUS_LIMITS.defaultMinutes),
      breakMinutes: clampBreakMinutes(preset.breakMinutes, FOCUS_LIMITS.breakMinutes),
      autoBreak: preset.autoBreak === true,
    },
    muteChat: raw.muteChat !== false,
    sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => s && typeof s === 'object') : [],
    pad: Array.isArray(raw.pad) ? raw.pad.filter((p) => p && typeof p === 'object') : [],
    lastArousal: num(raw.lastArousal, null),
    lastKind: TASK_KINDS.includes(raw.lastKind) ? raw.lastKind : null,
  };
}

/**
 * Patch KEYS.FOCUS.
 * @param {Object|function(Object):Object} patch object to merge, or a reducer.
 * @returns {boolean} false = the quota refused the write (value is still live
 *          in memory; app.js banners it; NOTHING is deleted).
 */
export function writeFocus(patch) {
  const next = typeof patch === 'function'
    ? patch(readFocus())
    : Object.assign(readFocus(), patch || {});
  return store.set(KEYS.FOCUS, next);
}

export function getPreset() { return readFocus().preset; }

export function setPreset(patch) {
  const p = Object.assign(getPreset(), patch || {});
  const clean = {
    minutes: clampMinutes(p.minutes),
    breakMinutes: clampBreakMinutes(p.breakMinutes),
    autoBreak: p.autoBreak === true,
  };
  writeFocus({ preset: clean });
  return clean;
}

/** Chat is muted while a block runs — the view mirrors this into an indicator. */
export function isChatMuted() { return readFocus().muteChat !== false; }
export function setChatMuted(on) { writeFocus({ muteChat: Boolean(on) }); return Boolean(on); }

/* ---------------------------------------------------------------------------
   4. Distraction pad — intrusive thoughts get parked, never lost
   ------------------------------------------------------------------------ */

/**
 * Park a thought. Auto-saved immediately; reviewed at the end of the block.
 * @param {string} text
 * @param {string} [sessionId]
 * @returns {Object|null} the stored entry (null if the text was empty)
 */
export function addJot(text, sessionId) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return null;
  const ts = nowTs();
  const entry = {
    id: uid('jot'),
    ts,
    day: dayKeyFromTs(ts),
    sessionId: sessionId || null,
    text: body.slice(0, 500),
    status: 'open',
  };
  writeFocus((state) => {
    state.pad = state.pad.concat([entry]);
    return state;
  });
  return entry;
}

/**
 * Read parked thoughts, newest last.
 * @param {{sessionId?:string, status?:string, limit?:number}} [filter]
 */
export function getJots(filter) {
  const f = filter || {};
  let list = readFocus().pad;
  if (f.sessionId) list = list.filter((j) => j.sessionId === f.sessionId);
  if (f.status) list = list.filter((j) => (j.status || 'open') === f.status);
  if (f.limit) list = list.slice(-f.limit);
  return list;
}

/** Mark a parked thought done / dropped / open again. Never deletes it. */
export function setJotStatus(id, status) {
  const next = JOT_STATUS.includes(status) ? status : 'open';
  let hit = false;
  writeFocus((state) => {
    state.pad = state.pad.map((j) => {
      if (j.id !== id) return j;
      hit = true;
      return Object.assign({}, j, { status: next, resolvedTs: next === 'open' ? null : nowTs() });
    });
    return state;
  });
  return hit;
}

/* ---------------------------------------------------------------------------
   5. Session records
   ------------------------------------------------------------------------ */

/**
 * Append a finished focus session.
 * @param {Object} rec
 * @returns {Object} the normalised record that was stored
 */
export function recordSession(rec) {
  const r = rec || {};
  const ts = num(r.ts, nowTs());
  const entry = {
    id: r.id || uid('foc'),
    ts,
    day: dayKeyFromTs(ts),
    kind: TASK_KINDS.includes(r.kind) ? r.kind : 'review',
    taskId: r.taskId || null,
    taskLabel: String(r.taskLabel || '').slice(0, 160) || null,
    subject: r.subject || null,
    plannedSec: Math.max(0, Math.round(num(r.plannedSec, 0))),
    focusedSec: Math.max(0, Math.round(num(r.focusedSec, 0))),
    extendedSec: Math.max(0, Math.round(num(r.extendedSec, 0))),
    blocks: Math.max(0, Math.round(num(r.blocks, 0))),
    completed: Boolean(r.completed),
    arousal: num(r.arousal, null),
    effort: num(r.effort, null),
    thinking: typeof r.thinking === 'boolean' ? r.thinking : null,
    awaySec: Math.max(0, Math.round(num(r.awaySec, 0))),
    awayCount: Math.max(0, Math.round(num(r.awayCount, 0))),
    jots: Math.max(0, Math.round(num(r.jots, 0))),
    group: Boolean(r.group),
  };
  writeFocus((state) => {
    state.sessions = state.sessions.concat([entry]);
    state.lastArousal = entry.arousal;
    state.lastKind = entry.kind;
    return state;
  });
  return entry;
}

/** Sessions, oldest first. `limit` keeps the most RECENT n. */
export function getSessions(limit) {
  const list = readFocus().sessions;
  return limit ? list.slice(-limit) : list;
}

/** {blocks, focusedSec, sessions} banked on a local day (default today). */
export function dayFocusStats(dayISO) {
  const day = dayISO || todayLocalISO();
  const rows = readFocus().sessions.filter((s) => s.day === day);
  return {
    day,
    sessions: rows.length,
    blocks: rows.reduce((n, s) => n + (Number(s.blocks) || 0), 0),
    focusedSec: rows.reduce((n, s) => n + (Number(s.focusedSec) || 0), 0),
  };
}

/* ---------------------------------------------------------------------------
   6. THE ADAPTIVE PART — learn his sustainable interval
   ------------------------------------------------------------------------ */

/**
 * Work out the block length his own history says he can actually finish.
 *
 * Deterministic ladder (so the app can always say WHY it moved):
 *   · fewer than 3 recorded blocks -> the standing 25 minutes, no movement.
 *   · last 3 all ran to the bell    -> +5 minutes (capped at 50).
 *   · 2+ of the last 3 stopped under 60% of plan -> -5 minutes (floor 10).
 *   · otherwise                     -> hold, but never above
 *                                      (median finished minutes + 5).
 *
 * @param {Array} [sessions] defaults to stored history
 * @returns {{minutes:number, reason:string, sample:number, completionRate:number, base:number}}
 */
export function sustainableInterval(sessions) {
  const all = (Array.isArray(sessions) ? sessions : readFocus().sessions)
    .filter((s) => s && Number(s.plannedSec) > 0 && Number(s.focusedSec) >= 60);
  const window = all.slice(-FOCUS_LIMITS.learnWindow);
  const preset = getPreset().minutes;

  if (window.length < FOCUS_LIMITS.learnSample) {
    return {
      minutes: clampMinutes(preset),
      base: clampMinutes(preset),
      sample: window.length,
      completionRate: 0,
      reason: window.length === 0
        ? 'No blocks logged yet. Starting at the standard ' + clampMinutes(preset) + ' minutes.'
        : window.length + ' of 3 blocks logged. The timer starts moving after the third.',
    };
  }

  const finished = (s) => Number(s.focusedSec) >= Number(s.plannedSec);
  const short = (s) => Number(s.focusedSec) < Number(s.plannedSec) * FOCUS_LIMITS.shortRatio;

  const last3 = window.slice(-FOCUS_LIMITS.learnSample);
  const base = clampMinutes(Math.round(Number(window[window.length - 1].plannedSec) / 60), preset);
  const completionRate = window.filter(finished).length / window.length;

  const finishedMins = window.filter(finished).map((s) => Number(s.focusedSec) / 60);
  const ceiling = finishedMins.length
    ? clampMinutes(median(finishedMins) + FOCUS_LIMITS.stepMinutes, base)
    : FOCUS_LIMITS.maxMinutes;

  const allFinished = last3.every(finished);
  const stretched = last3.some((s) => Number(s.extendedSec) > 0);
  const shortCount = last3.filter(short).length;

  if (allFinished) {
    const up = clampMinutes(base + FOCUS_LIMITS.stepMinutes);
    const minutes = Math.min(up, Math.max(ceiling, base));
    return {
      minutes,
      base,
      sample: window.length,
      completionRate,
      reason: minutes > base
        ? 'Your last 3 blocks all ran to the bell' + (stretched ? ' and one went into extra time' : '') +
          '. The timer moves up to ' + minutes + ' minutes.'
        : 'Your last 3 blocks all ran to the bell. Holding at ' + minutes + ' minutes — that is the length you finish.',
    };
  }

  if (shortCount >= 2) {
    const minutes = clampMinutes(base - FOCUS_LIMITS.stepMinutes);
    return {
      minutes,
      base,
      sample: window.length,
      completionRate,
      reason: shortCount + ' of your last 3 blocks stopped early. Dropping to ' + minutes +
        ' minutes so a block is a block you finish.',
    };
  }

  const minutes = Math.min(base, Math.max(ceiling, FOCUS_LIMITS.minMinutes));
  return {
    minutes,
    base,
    sample: window.length,
    completionRate,
    reason: 'Mixed run over your last 3 blocks. Holding at ' + minutes + ' minutes.',
  };
}

/** Shorthand: just the learned number of minutes. */
export function suggestMinutes() { return sustainableInterval().minutes; }

/**
 * Arousal 1–5 taken before the block, turned into a concrete suggestion.
 * Autonomy-support: this is a rationale + a choice, never an order.
 * @param {number} arousal
 * @param {number} minutes the learned interval
 */
export function arousalAdvice(arousal, minutes) {
  const a = clampNum(Math.round(num(arousal, 3)), 1, 5);
  const learned = clampMinutes(minutes);
  if (a <= 2) {
    return {
      arousal: a,
      minutes: clampMinutes(learned - FOCUS_LIMITS.stepMinutes),
      kind: 'review',
      note: 'Running flat. Cards hold up on low energy where new material does not — a shorter review block still banks the day.',
    };
  }
  if (a === 5) {
    return {
      arousal: a,
      minutes: learned,
      kind: 'drill',
      note: 'Wired. Timed problems soak that up better than reading does.',
    };
  }
  if (a === 4) {
    return {
      arousal: a,
      minutes: learned,
      kind: 'encode',
      note: 'Sharp. This is the state new, hard material is supposed to meet.',
    };
  }
  return {
    arousal: a,
    minutes: learned,
    kind: 'review',
    note: 'Steady. Any of the three lanes works from here.',
  };
}

/* ---------------------------------------------------------------------------
   7. Break micro-suggestions (rotating, deterministic)
   ------------------------------------------------------------------------ */

const BREAK_SUGGESTIONS = Object.freeze([
  { icon: 'flask', title: 'Water', detail: 'Fill the glass now. Drink half before you sit back down.' },
  { icon: 'zap', title: 'Stand and stretch', detail: 'Up. Roll your shoulders back ten times. Reach for the ceiling.' },
  { icon: 'eye', title: 'Look far away', detail: 'Find something about 6 metres off and hold your eyes there for 20 seconds.' },
  { icon: 'waypoints', title: 'Two laps', detail: 'Walk two laps of the room. The phone stays face down.' },
  { icon: 'moon', title: 'Air', detail: 'Open the window. Three slow breaths, shoulders down.' },
  { icon: 'layers', title: 'Reset the desk', detail: 'Clear everything except the one thing the next block needs.' },
]);

/** Deterministic rotation — block 1 always gets the same suggestion. */
export function breakSuggestion(index) {
  const i = Math.abs(Math.round(num(index, 0))) % BREAK_SUGGESTIONS.length;
  return BREAK_SUGGESTIONS[i];
}

/** How long the break after block `blockNumber` (1-based) should be. */
export function breakMinutesFor(blockNumber, preset) {
  const p = preset || getPreset();
  const n = Math.max(1, Math.round(num(blockNumber, 1)));
  return n % FOCUS_LIMITS.blocksBeforeLongBreak === 0
    ? FOCUS_LIMITS.longBreakMinutes
    : clampBreakMinutes(p.breakMinutes);
}

/* ---------------------------------------------------------------------------
   8. createFocusTimer — wall-clock block/break timer
   ------------------------------------------------------------------------ */

/**
 * Phases:
 *   idle       nothing started yet
 *   running    a block is counting down
 *   paused     a block is held (wall clock stops accruing)
 *   done       the block reached its planned length — awaiting break/extend
 *   break      a break is counting down
 *   break-done the break finished — awaiting the next block
 *   stopped    the session is finished; the snapshot is final
 *
 * Everything is derived from Date.now(), so a throttled/backgrounded tab
 * catches up exactly instead of losing seconds.
 *
 * @param {{minutes?:number, breakMinutes?:number, tickMs?:number,
 *          onTick?:function, onComplete?:function, onBreakEnd?:function,
 *          onPhase?:function}} [opts]
 */
export function createFocusTimer(opts) {
  const o = opts || {};
  const tickMs = Math.max(100, num(o.tickMs, 250));

  let plannedSec = clampMinutes(o.minutes) * 60;
  let breakSec = clampBreakMinutes(o.breakMinutes) * 60;

  let phase = 'idle';
  let segmentStart = 0;     // ts the live running/break segment began
  let blockAccum = 0;       // seconds already accrued in the CURRENT block
  let breakAccum = 0;       // seconds already accrued in the CURRENT break
  let focusedAccum = 0;     // seconds from blocks already closed out
  let extendedSec = 0;      // total extra time claimed this session
  let blocks = 0;           // blocks finished to the bell
  let completeFired = false;
  let timerId = null;
  let destroyed = false;

  const live = () => (segmentStart ? (Date.now() - segmentStart) / 1000 : 0);
  const blockElapsed = () => blockAccum + (phase === 'running' ? live() : 0);
  const breakElapsed = () => breakAccum + (phase === 'break' ? live() : 0);

  function fire(name, ...args) {
    const fn = o[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { console.error('[focustimer] ' + name + ' handler failed', err); }
  }

  function snapshot() {
    const elapsed = blockElapsed();
    const brk = breakElapsed();
    return {
      phase,
      plannedSec: Math.round(plannedSec),
      elapsedSec: Math.floor(elapsed),
      remainingSec: Math.max(0, Math.ceil(plannedSec - elapsed)),
      focusedSec: Math.floor(focusedAccum + elapsed),
      extendedSec: Math.round(extendedSec),
      breakSec: Math.round(breakSec),
      breakRemainingSec: Math.max(0, Math.ceil(breakSec - brk)),
      blocks,
      pct: plannedSec > 0 ? clampNum((elapsed / plannedSec) * 100, 0, 100) : 0,
      breakPct: breakSec > 0 ? clampNum((brk / breakSec) * 100, 0, 100) : 0,
      running: phase === 'running',
    };
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    fire('onPhase', phase, snapshot());
  }

  function ensureTicking() {
    if (timerId || destroyed) return;
    timerId = setInterval(tick, tickMs);
  }

  function stopTicking() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function tick() {
    if (phase === 'running' && !completeFired && blockElapsed() >= plannedSec) {
      completeFired = true;
      blockAccum = plannedSec;          // pin it — no overrun creep
      segmentStart = 0;
      setPhase('done');
      fire('onComplete', snapshot());
      fire('onTick', snapshot());
      return;
    }
    if (phase === 'break' && breakElapsed() >= breakSec) {
      breakAccum = breakSec;
      segmentStart = 0;
      setPhase('break-done');
      fire('onBreakEnd', snapshot());
      fire('onTick', snapshot());
      return;
    }
    if (phase === 'running' || phase === 'break') fire('onTick', snapshot());
  }

  /** Close out the current block into the session totals. */
  function closeBlock() {
    const elapsed = blockElapsed();
    focusedAccum += elapsed;
    if (elapsed >= plannedSec - 0.5) blocks += 1;
    blockAccum = 0;
    segmentStart = 0;
    completeFired = false;
  }

  const api = {
    /** Begin the first block (or restart from idle). */
    start() {
      if (destroyed || phase === 'running') return snapshot();
      if (phase === 'idle' || phase === 'stopped') { blockAccum = 0; completeFired = false; }
      segmentStart = Date.now();
      setPhase('running');
      ensureTicking();
      return snapshot();
    },

    pause() {
      if (phase !== 'running') return snapshot();
      blockAccum += live();
      segmentStart = 0;
      setPhase('paused');
      return snapshot();
    },

    resume() {
      if (phase !== 'paused') return snapshot();
      segmentStart = Date.now();
      setPhase('running');
      ensureTicking();
      return snapshot();
    },

    toggle() { return phase === 'running' ? api.pause() : api.resume(); },

    /**
     * "Extend — I'm in flow": add time to the CURRENT block. Legal while the
     * block runs, is paused, or has just hit the bell.
     */
    extend(minutes) {
      if (phase !== 'running' && phase !== 'paused' && phase !== 'done') return snapshot();
      const add = clampNum(Math.round(num(minutes, FOCUS_LIMITS.extendMinutes)), 1, FOCUS_LIMITS.maxMinutes) * 60;
      plannedSec += add;
      extendedSec += add;
      if (phase === 'done') {                 // roll straight back into the block
        completeFired = false;
        segmentStart = Date.now();
        setPhase('running');
        ensureTicking();
      }
      return snapshot();
    },

    /** Finish the block and take a break. */
    startBreak(minutes) {
      if (phase === 'break') return snapshot();
      if (phase === 'running' || phase === 'paused' || phase === 'done') closeBlock();
      breakSec = clampBreakMinutes(minutes, Math.round(breakSec / 60)) * 60;
      breakAccum = 0;
      segmentStart = Date.now();
      setPhase('break');
      ensureTicking();
      return snapshot();
    },

    /** Cut the break short. */
    skipBreak() {
      if (phase !== 'break' && phase !== 'break-done') return snapshot();
      breakAccum = 0;
      segmentStart = 0;
      setPhase('break-done');
      return snapshot();
    },

    /** Start a fresh block (after a break, or straight after the bell). */
    nextBlock(minutes) {
      if (phase === 'running' || phase === 'paused' || phase === 'done') closeBlock();
      plannedSec = clampMinutes(minutes, Math.round(plannedSec / 60)) * 60;
      blockAccum = 0;
      completeFired = false;
      segmentStart = Date.now();
      setPhase('running');
      ensureTicking();
      return snapshot();
    },

    /** End the session. The returned snapshot is final. */
    stop() {
      if (phase === 'running' || phase === 'paused' || phase === 'done') closeBlock();
      segmentStart = 0;
      stopTicking();
      setPhase('stopped');
      return snapshot();
    },

    /** Change the planned length of the block that has not started yet. */
    setMinutes(minutes) {
      if (phase === 'running' || phase === 'paused' || phase === 'done') return snapshot();
      plannedSec = clampMinutes(minutes) * 60;
      return snapshot();
    },

    /** True when the whole planned block was served. */
    get completed() { return blocks > 0 || blockElapsed() >= plannedSec - 0.5; },
    get phase() { return phase; },
    snapshot,

    destroy() {
      destroyed = true;
      stopTicking();
      segmentStart = 0;
    },
  };

  return api;
}

export default {
  FOCUS_LIMITS,
  TASK_KINDS,
  KIND_LABELS,
  AROUSAL_LABELS,
  createFocusTimer,
  sustainableInterval,
  suggestMinutes,
  arousalAdvice,
  breakSuggestion,
  breakMinutesFor,
  readFocus,
  writeFocus,
  getPreset,
  setPreset,
  isChatMuted,
  setChatMuted,
  addJot,
  getJots,
  setJotStatus,
  recordSession,
  getSessions,
  dayFocusStats,
  clampMinutes,
};
