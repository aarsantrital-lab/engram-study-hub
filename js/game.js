/* =============================================================================
   js/game.js — the game layer: rings, attendance streak, XP, capability levels,
   badges, titles, weekly quests, celebrations, pet mount, daily quote.
   Job: GAME LAYER. Owns this file plus pet.js, boss.js, sounds.js,
   share-image.js and data/quotes.json.

   THE CONTRACT (SHARED APIS — other features code against exactly this):
     getRings()      -> {review:{done,goal}, encode:{done,goal}, drill:{done,goal}}
     recordActivity(kind:'review'|'encode'|'drill', meta)
     awardXP(n, reason)
     getStreak()     -> {current, lifetime, freezesLeft, ...}
     getLevelInfo(subject?)
     getTitles()     -> [{id, label, earned}]
     getPetState()
     on(event, cb)   -> off      events: 'xp' 'ring' 'streak' 'badge' 'celebration'
   Features CALL these. game.js owns all of the state behind them.

   PEDAGOGY LAW (pedagogy-spec §4 — these calibrations are not preferences):
     · Attendance streak, never a volume streak. ANY completed session counts,
       including the 90-second minimum. 2 SILENT auto-freezes per calendar
       month. 48-hour repair window. Lifetime nights always shown beside the
       current run so a break never zeroes everything. Identity framing, never
       loss framing. On a break: the research-true reassurance line, never guilt.
     · XP is texture and it is paid for retrieval ATTEMPTS — including wrong
       ones. It is NEVER paid for being correct and never for volume, and it is
       never the headline number. (Rewarding correctness punishes desirable
       difficulty; rewarding volume is the inverted-U Sung warns about.)
     · Capability levels name real CDC skills ("solves limiting-reagent problems
       unaided"), never arbitrary numbers. The ladder is config-driven and the
       evidence comes from unit data (mastered/RETAINED units, scaffold levels,
       held-out papers).
     · 8 curated badges. No badge inflation, no leaderboards, no peer ranking,
       no time-on-app rewards, no daily-card-count goals, ever.
     · Rings are the daily shape: review = FSRS queue, encode = new learning and
       map work, drill = numericals and papers. Goals adapt to the time budget,
       and they SHRINK on a re-entry day (restart-ability is a design constraint).

   STORE KEYS OWNED HERE: GAME, RINGS, STREAK, PET (+ SESSIONS attendance
   fields, merged non-destructively). Read-only elsewhere: SRS, GROW,
   NUMERICALS, PAPERS, SETTINGS, PROFILE.
   ========================================================================== */

import {
  store, KEYS,
  todayLocalISO, addDaysISO, diffDaysISO, parseLocalISO, uid,
} from './store.js';
import { getSettings, isFeatureEnabled } from './config.js';
import { el, clamp, prefersReducedMotion, haptic } from './dom.js';
import { getTopics, getSubjects } from './vault.js';

/* ---------------------------------------------------------------------------
   0. Constants and calibrations
   ------------------------------------------------------------------------ */

/** The three daily rings. Order is the display order. */
export const RING_KINDS = Object.freeze(['review', 'encode', 'drill']);

export const RING_META = Object.freeze({
  review: { label: 'Review', icon: 'layers', tone: 'brand', what: 'FSRS queue' },
  encode: { label: 'Encode', icon: 'waypoints', tone: 'ai', what: 'new learning + maps' },
  drill: { label: 'Drill', icon: 'calculator', tone: 'good', what: 'numericals + papers' },
});

/**
 * XP per logged attempt. FLAT by design — the same whether the answer was right
 * or wrong (pedagogy-spec §4: XP is tied to retrieval attempts including wrong
 * ones). Do not add a correctness multiplier here; that is the one thing this
 * number is forbidden to encode.
 */
const XP_PER_ATTEMPT = Object.freeze({ review: 4, encode: 6, drill: 8 });

/** Small extra for tagging confidence before answering — a calibration
 *  behaviour, not a correctness reward. */
const XP_CONFIDENCE_TAG = 1;

const XP_RING_CLOSED = 15;
const XP_ALL_RINGS = 20;
const XP_QUEST_DONE = 40;

/** Paid for SITTING the paper, never for the marks on it. boss.js imports it
 *  so the number exists in exactly one place. */
export const XP_MOCK_COMPLETED = 120;

/** Attendance floor — the 90-second escape hatch always counts (§1.7). */
export const MIN_SESSION_SECONDS = 90;

/** Silent auto-freezes granted per calendar month (§4 / R8). */
export const FREEZES_PER_MONTH = 2;

/** How long a broken streak stays repairable. */
export const REPAIR_WINDOW_HOURS = 48;

/** Days without ring activity before the companion goes sleepy (never dies). */
export const PET_SLEEPY_AFTER_DAYS = 3;

const GAME_STATE_VERSION = 1;

/* ---------------------------------------------------------------------------
   1. Small utilities (local — nothing here belongs in a shared file)
   ------------------------------------------------------------------------ */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

/** Deterministic 32-bit hash of a string — seeds the confetti and the daily
 *  quote so the same day/label always produces the same burst. */
function hash32(str) {
  let h = 2166136261 >>> 0;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Monday-start ISO week key for a local YYYY-MM-DD. */
export function weekStartISO(iso) {
  const day = iso || todayLocalISO();
  const d = parseLocalISO(day);
  if (!d) return day;
  const dow = (d.getDay() + 6) % 7;          // 0 = Monday
  return addDaysISO(day, -dow);
}

/** 'YYYY-MM' for a local date — the freeze quota bucket. */
function monthKey(iso) { return String(iso || todayLocalISO()).slice(0, 7); }

/* ---------------------------------------------------------------------------
   2. Event emitter
   ------------------------------------------------------------------------ */

/** Events other features may subscribe to. */
export const GAME_EVENTS = Object.freeze([
  'xp', 'ring', 'streak', 'badge', 'celebration', 'quest', 'level', 'pet', 'activity',
]);

const listeners = new Map();

/**
 * Subscribe to a game event.
 * @param {'xp'|'ring'|'streak'|'badge'|'celebration'|'quest'|'level'|'pet'|'activity'} event
 * @param {(payload:Object)=>void} cb
 * @returns {()=>void} unsubscribe
 */
export function on(event, cb) {
  if (typeof cb !== 'function') return () => {};
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => { const s = listeners.get(event); if (s) s.delete(cb); };
}

function emit(event, payload) {
  const set = listeners.get(event);
  if (set) {
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error('[game] ' + event + ' handler failed', err); }
    }
  }
  const all = listeners.get('*');
  if (all) {
    for (const fn of Array.from(all)) {
      try { fn(payload, event); } catch (err) { console.error('[game] * handler failed', err); }
    }
  }
}

/* ---------------------------------------------------------------------------
   3. Persisted state
   ------------------------------------------------------------------------ */

function blankGame() {
  return {
    v: GAME_STATE_VERSION,
    xp: 0,
    level: 0,
    badges: [],            // [{id, earnedOn}]
    titles: [],            // [{id, earnedOn}]
    equippedTitle: null,
    quests: null,          // {weekStart, items:[...]}
    milestones: {},        // kind -> {count, firstOn, lastOn, best, last}
    capabilities: [],      // [{id, label, earnedOn}]
    ringStreak: { days: 0, lastDay: null },   // consecutive all-rings-closed days
    createdOn: todayLocalISO(),
  };
}

/** Read the game blob, healed into a known shape (never throws). */
export function readGame() {
  const raw = store.get(KEYS.GAME, null);
  const g = Object.assign(blankGame(), isObj(raw) ? raw : {});
  g.xp = Math.max(0, int(g.xp, 0));
  g.level = Math.max(0, int(g.level, 0));
  g.badges = arr(g.badges).filter(isObj);
  g.titles = arr(g.titles).filter(isObj);
  g.capabilities = arr(g.capabilities).filter(isObj);
  g.milestones = isObj(g.milestones) ? g.milestones : {};
  g.ringStreak = isObj(g.ringStreak) ? g.ringStreak : { days: 0, lastDay: null };
  return g;
}

function writeGame(g) {
  g.v = GAME_STATE_VERSION;
  // store.set() returning false means quota refused the write; the value stays
  // live in memory and app.js banners it. We never retry and never prune.
  store.set(KEYS.GAME, g);
  return g;
}

function blankStreak() {
  return {
    count: 0,
    longest: 0,
    lastDay: null,
    freezes: FREEZES_PER_MONTH,     // remaining THIS month (the shell reads this)
    lifetimeDays: 0,
    freezeMonth: monthKey(),
    freezeDays: [],                 // days silently covered by a freeze
    broken: null,                   // {brokenTs, previousCount, missedDays}
    lastRepairTs: null,
  };
}

/** Read the streak blob, healed (shape is shared with the appbar flame). */
export function readStreak() {
  const raw = store.get(KEYS.STREAK, null);
  const s = Object.assign(blankStreak(), isObj(raw) ? raw : {});
  s.count = Math.max(0, int(s.count, 0));
  s.longest = Math.max(s.count, int(s.longest, 0));
  s.lifetimeDays = Math.max(0, int(s.lifetimeDays, 0));
  s.freezeDays = arr(s.freezeDays).slice(-24);
  // Freeze quota refills silently on the 1st of each local month.
  const mk = monthKey();
  if (s.freezeMonth !== mk) { s.freezeMonth = mk; s.freezes = FREEZES_PER_MONTH; }
  s.freezes = clamp(int(s.freezes, FREEZES_PER_MONTH), 0, FREEZES_PER_MONTH);
  return s;
}

function writeStreak(s) { store.set(KEYS.STREAK, s); return s; }

function readRingsMap() {
  const raw = store.get(KEYS.RINGS, null);
  return isObj(raw) ? raw : {};
}

/* ---------------------------------------------------------------------------
   4. Ring goals — adaptive to the time budget (never a card-count target)
   ------------------------------------------------------------------------ */

/*  The budget split mirrors the scheduler's own cost model:
      review  45% of the budget at ~20 s a card
      encode  30% of the budget at ~45 s a first exposure (capped at the
              scheduler's hard new-card ceiling of 15)
      drill   25% of the budget at ~150 s a numerical
    Then two corrections that exist for pedagogical reasons, not aesthetics:
      1. a personal blend toward what he actually completes, so the ring is a
         real target rather than a daily accusation, and
      2. a re-entry discount after time away — pedagogy-spec §4 makes
         restart-ability a design constraint ("10 days away -> a 5-minute
         re-entry path, not 400 due cards").                                   */

const RING_SPLIT = Object.freeze({ review: 0.45, encode: 0.30, drill: 0.25 });
const RING_SECONDS = Object.freeze({ review: 20, encode: 45, drill: 150 });
const RING_BOUNDS = Object.freeze({
  review: [5, 45], encode: [2, 15], drill: [1, 12],
});

/** Goals purely from a minutes budget, before personalisation. */
export function budgetGoals(minutes) {
  const m = clamp(int(minutes, 25) || 25, 10, 120);
  const out = {};
  for (const k of RING_KINDS) {
    const [lo, hi] = RING_BOUNDS[k];
    out[k] = clamp(Math.round((m * RING_SPLIT[k] * 60) / RING_SECONDS[k]), lo, hi);
  }
  return out;
}

/** Median of the last `days` completed values for one ring (0 if no history). */
function recentMedian(ringsMap, kind, days, endDay) {
  const vals = [];
  for (let i = 1; i <= days; i += 1) {
    const d = addDaysISO(endDay, -i);
    const row = ringsMap[d];
    if (!isObj(row) || !isObj(row[kind])) continue;
    vals.push(Math.max(0, int(row[kind].done, 0)));
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}

/** Days since the last day with any ring activity (Infinity if never). */
export function daysIdle(endDay) {
  const map = readRingsMap();
  const today = endDay || todayLocalISO();
  for (let i = 0; i <= 120; i += 1) {
    const d = addDaysISO(today, -i);
    const row = map[d];
    if (isObj(row) && RING_KINDS.some((k) => isObj(row[k]) && int(row[k].done, 0) > 0)) return i;
  }
  return Infinity;
}

/**
 * The goals for a given day: budget-derived, blended 70/30 with his own recent
 * median (clamped to +/-40% of the budget figure so the blend can never make a
 * ring silly), then discounted on a re-entry day.
 * @param {string} [day] local YYYY-MM-DD
 */
export function goalsFor(day) {
  const d = day || todayLocalISO();
  const minutes = int(getSettings().dailyMinutes, 25) || 25;
  const base = budgetGoals(minutes);
  const map = readRingsMap();
  const idle = daysIdle(addDaysISO(d, -1));
  const ease = idle >= 7 ? 0.4 : idle >= 4 ? 0.55 : idle >= 2 ? 0.8 : 1;

  const out = {};
  for (const k of RING_KINDS) {
    const [lo, hi] = RING_BOUNDS[k];
    const med = recentMedian(map, k, 14, d);
    let g = base[k];
    if (med !== null && med > 0) {
      const blended = Math.round(base[k] * 0.7 + med * 0.3);
      g = clamp(blended, Math.round(base[k] * 0.6), Math.round(base[k] * 1.4));
    }
    out[k] = clamp(Math.round(g * ease), lo, hi);
  }
  // Night one gets the same gentle goals as a return, but it is NOT a return —
  // nothing in the UI should welcome him back from a break he never took.
  out._fresh = !Number.isFinite(idle);
  out._reentry = ease < 1 && Number.isFinite(idle);
  return out;
}

function blankRingRow(day) {
  const goals = goalsFor(day);
  const row = {};
  for (const k of RING_KINDS) row[k] = { done: 0, goal: goals[k] };
  row.reentry = goals._reentry === true;
  row.fresh = goals._fresh === true;
  return row;
}

/** Today's ring row, created (but not necessarily persisted) if absent. */
function ringRow(day, map) {
  const m = map || readRingsMap();
  const d = day || todayLocalISO();
  const existing = m[d];
  if (!isObj(existing)) return blankRingRow(d);
  const row = { reentry: existing.reentry === true, fresh: existing.fresh === true };
  const goals = goalsFor(d);
  for (const k of RING_KINDS) {
    const cell = isObj(existing[k]) ? existing[k] : {};
    row[k] = {
      done: Math.max(0, int(cell.done, 0)),
      // Goals stay pinned once the day has started so a ring can never move
      // away from him mid-session.
      goal: Math.max(1, int(cell.goal, goals[k])),
    };
  }
  return row;
}

/**
 * THE CONTRACT SHAPE.
 * @param {string} [day] local YYYY-MM-DD (defaults to today)
 * @returns {{review:{done,goal,pct,closed}, encode:{...}, drill:{...},
 *            day:string, allClosed:boolean, reentry:boolean, fresh:boolean}}
 *          `reentry` = goals eased after time away · `fresh` = his first day,
 *          which is eased too but must never be framed as a return.
 */
export function getRings(day) {
  const d = day || todayLocalISO();
  const row = ringRow(d);
  const out = { day: d, reentry: row.reentry === true, fresh: row.fresh === true };
  let all = true;
  for (const k of RING_KINDS) {
    const done = row[k].done;
    const goal = Math.max(1, row[k].goal);
    const closed = done >= goal;
    if (!closed) all = false;
    out[k] = { done, goal, pct: clamp(done / goal, 0, 1), closed };
  }
  out.allClosed = all;
  return out;
}

/* ---------------------------------------------------------------------------
   5. Attendance streak (pedagogy-spec R8 / §4)
   ------------------------------------------------------------------------ */

/**
 * Register attendance for a local day. Idempotent per day.
 *
 * Rules, in order:
 *   same day            -> nothing changes
 *   gap of 1 day        -> the run continues
 *   gap of n days, with (n-1) missed days covered by remaining freezes
 *                       -> freezes are spent SILENTLY, the run continues
 *   otherwise           -> the run breaks. lifetimeDays is untouched (it never
 *                          resets), and a 48-hour repair window opens.
 *
 * @param {string} [day]
 * @returns {{changed:boolean, kind:'same-day'|'continued'|'frozen'|'started'|'broken',
 *            streak:Object, missedDays:number, freezesUsed:number}}
 */
export function touchStreak(day) {
  const d = day || todayLocalISO();
  const s = readStreak();

  if (s.lastDay === d) return { changed: false, kind: 'same-day', streak: s, missedDays: 0, freezesUsed: 0 };

  const gap = s.lastDay ? diffDaysISO(s.lastDay, d) : null;
  let kind = 'started';
  let freezesUsed = 0;
  let missedDays = 0;

  if (gap === null || gap <= 0) {
    // First ever night, or a clock that moved backwards. Never punish either.
    s.count = Math.max(1, s.count || 0);
    kind = s.count > 1 ? 'continued' : 'started';
  } else if (gap === 1) {
    s.count += 1;
    kind = 'continued';
  } else {
    missedDays = gap - 1;
    if (missedDays > 0 && missedDays <= s.freezes) {
      // Silent. He is never told a freeze was spent — that is the point.
      s.freezes -= missedDays;
      freezesUsed = missedDays;
      for (let i = 1; i <= missedDays; i += 1) s.freezeDays.push(addDaysISO(s.lastDay, i));
      s.freezeDays = s.freezeDays.slice(-24);
      s.count += 1;
      kind = 'frozen';
    } else {
      s.broken = { brokenTs: Date.now(), previousCount: s.count, missedDays, brokenAfter: s.lastDay };
      s.count = 1;
      kind = 'broken';
    }
  }

  s.lastDay = d;
  s.lifetimeDays += 1;                  // lifetime nights only ever go up
  s.longest = Math.max(s.longest, s.count);
  if (kind !== 'broken' && s.broken && Date.now() - int(s.broken.brokenTs, 0) > REPAIR_WINDOW_HOURS * 3600000) {
    s.broken = null;                    // window elapsed; stop offering repair
  }
  writeStreak(s);

  const payload = { kind, missedDays, freezesUsed, streak: getStreak() };
  emit('streak', payload);
  if (kind === 'broken' || (kind === 'started' && s.lifetimeDays > 1)) {
    recordMilestone('comeback', { after: missedDays });
  }
  return Object.assign({ changed: true, streak: s }, payload);
}

/**
 * THE CONTRACT SHAPE (superset).
 * @returns {{current:number, lifetime:number, freezesLeft:number, longest:number,
 *            lastDay:string|null, todayDone:boolean, repairable:boolean,
 *            repairRestoresTo:number, copy:Object}}
 */
export function getStreak() {
  const s = readStreak();
  const today = todayLocalISO();
  const repairable = Boolean(
    s.broken && Date.now() - int(s.broken.brokenTs, 0) <= REPAIR_WINDOW_HOURS * 3600000
  );
  return {
    current: s.count,
    lifetime: s.lifetimeDays,
    freezesLeft: s.freezes,
    longest: s.longest,
    lastDay: s.lastDay,
    todayDone: s.lastDay === today,
    repairable,
    repairRestoresTo: repairable ? int(s.broken.previousCount, 0) + 1 : 0,
    copy: streakCopy(s, today),
  };
}

/**
 * Restore a run broken within the last 48 hours. Explicit user action only —
 * never automatic, never charged, never mentioned as a failure.
 * @returns {{ok:boolean, current:number, reason?:string}}
 */
export function repairStreak() {
  const s = readStreak();
  if (!s.broken) return { ok: false, current: s.count, reason: 'nothing-to-repair' };
  if (Date.now() - int(s.broken.brokenTs, 0) > REPAIR_WINDOW_HOURS * 3600000) {
    s.broken = null; writeStreak(s);
    return { ok: false, current: s.count, reason: 'window-closed' };
  }
  s.count = Math.max(s.count, int(s.broken.previousCount, 0) + 1);
  s.longest = Math.max(s.longest, s.count);
  s.lastRepairTs = Date.now();
  s.broken = null;
  writeStreak(s);
  const payload = { kind: 'repaired', missedDays: 0, freezesUsed: 0, streak: getStreak() };
  emit('streak', payload);
  return { ok: true, current: s.count };
}

/**
 * Student-facing streak copy. Identity framing when the run is alive;
 * the research-true reassurance line after a break. Never guilt, never a
 * "you missed N days" count.
 */
export function streakCopy(streakState, today) {
  const s = streakState || readStreak();
  const day = today || todayLocalISO();
  const done = s.lastDay === day;
  const lifetime = s.lifetimeDays;

  if (s.count === 0 && lifetime === 0) {
    return {
      tone: 'info',
      title: 'Night one is tonight',
      body: 'Ninety seconds counts as a night. That is the whole entry price.',
    };
  }
  if (s.count === 0 || (!done && s.broken)) {
    return {
      tone: 'info',
      title: 'Welcome back',
      body: 'Missing one day does not affect habit formation — the research is clear. '
        + 'Restarting today does. Your ' + lifetime + ' lifetime ' + (lifetime === 1 ? 'night' : 'nights')
        + ' stay banked.',
    };
  }
  if (done) {
    return {
      tone: 'good',
      title: 'Night ' + s.count,
      body: 'You are someone who reviews every night. ' + lifetime + ' '
        + (lifetime === 1 ? 'night' : 'nights') + ' lifetime.',
    };
  }
  return {
    tone: 'warn',
    title: 'Night ' + (s.count + 1) + ' is open',
    body: 'Ninety seconds keeps it. ' + lifetime + ' ' + (lifetime === 1 ? 'night' : 'nights') + ' lifetime.',
  };
}

/* ---------------------------------------------------------------------------
   6. XP
   ------------------------------------------------------------------------ */

/**
 * Add XP. XP is texture: it is paid for showing up and attempting retrieval,
 * including when the attempt is wrong. Never call this with an amount that
 * scales with correctness or with raw volume.
 * @param {number} n
 * @param {string} reason short machine-ish tag ('review-attempt', 'ring-closed')
 * @returns {{total:number, added:number, reason:string}}
 */
export function awardXP(n, reason) {
  const add = Math.max(0, int(n, 0));
  const g = readGame();
  const before = g.xp;
  g.xp = before + add;
  writeGame(g);
  const payload = { added: add, total: g.xp, before, reason: String(reason || 'xp') };
  if (add > 0) emit('xp', payload);
  return payload;
}

/** Total XP earned, lifetime. Never displayed as the headline number. */
export function getXP() { return readGame().xp; }

/* ---------------------------------------------------------------------------
   7. Sessions + activity
   ------------------------------------------------------------------------ */

function bumpSession(day, patch) {
  store.update(KEYS.SESSIONS, (prev) => {
    const all = isObj(prev) ? Object.assign({}, prev) : {};
    const cur = isObj(all[day]) ? Object.assign({}, all[day]) : {};
    cur.seconds = Math.max(0, int(cur.seconds, 0)) + Math.max(0, int(patch.seconds, 0));
    cur.reviews = Math.max(0, int(cur.reviews, 0)) + Math.max(0, int(patch.reviews, 0));
    cur.correct = Math.max(0, int(cur.correct, 0)) + Math.max(0, int(patch.correct, 0));
    cur.attempts = Math.max(0, int(cur.attempts, 0)) + Math.max(0, int(patch.attempts, 0));
    cur.rings = Math.max(int(cur.rings, 0), int(patch.rings, 0));
    cur.day = day;
    all[day] = cur;
    return all;
  }, {});
}

/**
 * Record one unit of study. THIS IS THE FUNCTION EVERY FEATURE CALLS.
 *
 * @param {'review'|'encode'|'drill'} kind
 * @param {{count?:number, correct?:boolean, seconds?:number, confidence?:number|null,
 *          subject?:string, unit?:string, topic?:string, cardId?:string,
 *          silent?:boolean, source?:string}} [meta]
 * @returns {{rings:Object, xp:number, closed:string[], streak:Object}}
 */
export function recordActivity(kind, meta) {
  const k = RING_KINDS.includes(kind) ? kind : 'review';
  const m = isObj(meta) ? meta : {};
  const day = todayLocalISO();
  const n = clamp(int(m.count, 1) || 1, 1, 200);

  /* --- rings ---------------------------------------------------------- */
  let before = null;
  store.update(KEYS.RINGS, (prev) => {
    const map = isObj(prev) ? Object.assign({}, prev) : {};
    const row = ringRow(day, map);
    before = Object.assign({}, row[k]);
    row[k] = { done: row[k].done + n, goal: row[k].goal };
    map[day] = row;
    return map;
  }, {});

  /* --- attendance ------------------------------------------------------ */
  const streakResult = touchStreak(day);
  bumpSession(day, {
    seconds: int(m.seconds, 0),
    reviews: k === 'review' ? n : 0,
    attempts: n,
    correct: m.correct === true ? n : 0,
  });

  /* --- XP: flat per attempt, wrong answers included -------------------- */
  let xpAdded = XP_PER_ATTEMPT[k] * n;
  if (m.confidence !== undefined && m.confidence !== null) xpAdded += XP_CONFIDENCE_TAG * n;
  const xp = awardXP(xpAdded, k + '-attempt');

  /* --- ring closure ---------------------------------------------------- */
  const rings = getRings(day);
  const closed = [];
  if (before && rings[k].closed && before.done < rings[k].goal) closed.push(k);

  emit('ring', { kind: k, added: n, rings, closed, meta: m });
  emit('activity', { kind: k, added: n, meta: m, day });

  if (closed.length && !m.silent) {
    awardXP(XP_RING_CLOSED, 'ring-closed');
    celebrate({
      kind: 'ring',
      label: RING_META[k].label + ' ring closed',
      body: rings[k].done + ' of ' + rings[k].goal + ' done.',
      subject: m.subject || null,
      tone: RING_META[k].tone,
    });
  }

  if (rings.allClosed) {
    const g = readGame();
    if (g.ringStreak.lastDay !== day) {
      const yesterday = addDaysISO(day, -1);
      g.ringStreak = {
        days: g.ringStreak.lastDay === yesterday ? int(g.ringStreak.days, 0) + 1 : 1,
        lastDay: day,
      };
      writeGame(g);
      if (!m.silent) {
        awardXP(XP_ALL_RINGS, 'all-rings');
        celebrate({ kind: 'day', label: 'All three rings closed', body: 'Review, encode and drill — all done today.' });
      }
    }
  }

  progressQuests({ kind: k, count: n, meta: m, day });
  evaluateBadges();
  syncLevelSnapshot();

  return { rings, xp: xp.total, closed, streak: streakResult.streak };
}

/**
 * Record a bare session with no ring attached — the 90-second escape hatch,
 * a focus block, a teach-back recording. Attendance only.
 * @param {{seconds?:number, source?:string, silent?:boolean}} [meta]
 */
export function recordSession(meta) {
  const m = isObj(meta) ? meta : {};
  const seconds = Math.max(0, int(m.seconds, MIN_SESSION_SECONDS));
  const day = todayLocalISO();
  bumpSession(day, { seconds, attempts: 0 });
  if (seconds >= MIN_SESSION_SECONDS) {
    const res = touchStreak(day);
    awardXP(2, 'session');
    evaluateBadges();
    return { counted: true, streak: res.streak, seconds };
  }
  return { counted: false, streak: getStreak(), seconds };
}

/** A running session handle — call end() when the view unmounts. */
export function startSession(meta) {
  const t0 = Date.now();
  let ended = false;
  return {
    end(extra) {
      if (ended) return null;
      ended = true;
      const seconds = Math.round((Date.now() - t0) / 1000);
      return recordSession(Object.assign({}, meta, extra, { seconds }));
    },
  };
}

/** Days this week (Monday-start) with any recorded activity. */
export function nightsThisWeek(day) {
  const d = day || todayLocalISO();
  const start = weekStartISO(d);
  const map = readRingsMap();
  const sessions = store.get(KEYS.SESSIONS, {});
  let n = 0;
  for (let i = 0; i < 7; i += 1) {
    const key = addDaysISO(start, i);
    const row = map[key];
    const ses = isObj(sessions) ? sessions[key] : null;
    const active = (isObj(row) && RING_KINDS.some((k) => isObj(row[k]) && int(row[k].done, 0) > 0))
      || (isObj(ses) && int(ses.seconds, 0) >= MIN_SESSION_SECONDS);
    if (active) n += 1;
  }
  return n;
}

/* ---------------------------------------------------------------------------
   8. Capability levels — real CDC skills, config-driven from unit data
   ------------------------------------------------------------------------ */

/*  A level is never "you have 4200 XP". It is a sentence about what he can now
    do, and it is earned from unit evidence:
      +1  a unit with at least one card MASTERED
      +2  a unit RETAINED (the +2/+7/+21 gates all passed)
      +1  a problemType carried to scaffoldLevel >= 3 (faded / cold)
      +2  a held-out paper attempt at 60% or better
    Content jobs can replace the rung wording with the exact CDC skill lines for
    a unit through configureCapabilities().                                    */

const DEFAULT_LADDERS = Object.freeze({
  Physics: [
    'Writes the units on every line of a numerical',
    'Solves one-step numericals unaided',
    'Names the principle before substituting anything',
    'Carries multi-step numericals through with correct significant figures',
    'Builds an 8-mark derivation from the backbone, unaided',
    'Works a full post-2077 paper inside three hours',
  ],
  Chemistry: [
    'Converts mass to moles with units on every line',
    'Balances an equation without touching a subscript',
    'Finds the limiting reagent from moles divided by coefficients',
    'Carries multi-step stoichiometry through to yield, unaided',
    'Explains a reaction family and says where the analogy breaks',
    'Works a full post-2077 paper inside three hours',
  ],
  Mathematics: [
    'Rearranges and simplifies without sign slips',
    'Picks the right method from the Method Bank',
    'Treats differentiation as a rate, not a rule',
    'Carries multi-step problems through unaided',
    'Writes a full derivation that would score every mark',
    'Works a full post-2077 paper inside three hours',
  ],
  Biology: [
    'Labels the canonical diagrams from memory',
    'States a process in the right order, unaided',
    'Explains a mechanism rather than listing its parts',
    'Compares two processes on the points that are marked',
    'Builds an 8-mark answer from a structured plan',
    'Works a full post-2077 paper inside three hours',
  ],
  _default: [
    'Turns up and attempts, notes closed',
    'Recalls the core of a chapter unaided',
    'Explains it in one sentence a younger student would get',
    'Applies it to a question shaped like the exam',
    'Builds a long answer from a plan, under time',
    'Works a full paper inside the real time limit',
  ],
});

const LEVEL_THRESHOLDS = Object.freeze([0, 2, 5, 10, 18, 30, 46]);

let ladderOverrides = null;

/**
 * Replace the capability wording for one or more subjects with the real CDC
 * skill lines. Content jobs call this once at boot with unit-derived text.
 * @param {{[subject:string]: string[]}} map
 */
export function configureCapabilities(map) {
  if (!isObj(map)) return;
  ladderOverrides = Object.assign({}, ladderOverrides || {}, map);
}

function ladderFor(subject) {
  const key = subject || '_default';
  if (ladderOverrides && Array.isArray(ladderOverrides[key])) return ladderOverrides[key];
  if (Array.isArray(DEFAULT_LADDERS[key])) return DEFAULT_LADDERS[key];
  if (subject === 'Maths' || subject === 'Math') return DEFAULT_LADDERS.Mathematics;
  return DEFAULT_LADDERS._default;
}

/** A card counts as RETAINED when the +2/+7/+21 gates have all passed. */
function isRetainedCard(card) {
  const gates = isObj(card) && isObj(card.gates) ? card.gates : null;
  if (!gates) return false;
  return [2, 7, 21].every((d) => {
    const g = gates[d] || gates[String(d)];
    return g === 'pass' || (isObj(g) && g.result === 'pass');
  });
}

/**
 * Unit-level evidence, read straight from the SRS cards plus the vault's unit
 * declarations (subject/unit are declared in frontmatter — never sniffed).
 */
export function unitEvidence(subject) {
  const srs = store.get(KEYS.SRS, {});
  const cards = isObj(srs) ? Object.values(srs) : [];
  const topics = getTopics();
  const topicUnit = new Map();
  const topicSubject = new Map();
  for (const t of topics) {
    topicUnit.set(t.id, t.unit || t.name || t.id);
    topicSubject.set(t.id, t.subject || null);
  }

  const units = new Map();     // unitKey -> {unit, subject, mastered, retained, cards}
  for (const c of cards) {
    if (!isObj(c)) continue;
    const subj = c.subject || topicSubject.get(c.topic) || null;
    if (subject && subj !== subject) continue;
    const unit = c.unit || topicUnit.get(c.topic) || c.topic || 'Unsorted';
    const key = (subj || '—') + ' · ' + unit;
    if (!units.has(key)) units.set(key, { key, unit, subject: subj, mastered: 0, retained: 0, cards: 0 });
    const u = units.get(key);
    u.cards += 1;
    if (c.masteredOn) u.mastered += 1;
    if (isRetainedCard(c)) u.retained += 1;
  }
  return Array.from(units.values());
}

function numericalEvidence(subject) {
  const raw = store.get(KEYS.NUMERICALS, {});
  if (!isObj(raw)) return [];
  return Object.entries(raw)
    .filter(([, v]) => isObj(v) && int(v.scaffoldLevel, 0) >= 3)
    .filter(([, v]) => !subject || !v.subject || v.subject === subject)
    .map(([k, v]) => ({ problemType: k, scaffoldLevel: int(v.scaffoldLevel, 0) }));
}

function paperEvidence(subject) {
  const raw = store.get(KEYS.PAPERS, {});
  if (!isObj(raw)) return [];
  const out = [];
  for (const [id, rec] of Object.entries(raw)) {
    if (!isObj(rec)) continue;
    if (subject && rec.subject && rec.subject !== subject) continue;
    for (const a of arr(rec.attempts)) {
      const marks = Number(a && a.marks);
      const total = Number((a && a.marksTotal) || rec.marksTotal || 75);
      if (Number.isFinite(marks) && total > 0) out.push({ id, ratio: marks / total, marks, total });
    }
  }
  return out;
}

/**
 * THE CONTRACT SHAPE (superset).
 * @param {string} [subject] restrict to one subject; omit for the whole hub
 */
export function getLevelInfo(subject) {
  const subj = subject || null;
  const units = unitEvidence(subj);
  const nums = numericalEvidence(subj);
  const papers = paperEvidence(subj).filter((p) => p.ratio >= 0.6);

  let points = 0;
  const capabilities = [];
  for (const u of units) {
    if (u.mastered > 0) {
      points += 1;
      capabilities.push({
        id: 'mastered:' + u.key,
        label: u.unit + ' — recalled unaided',
        earned: true,
        evidence: u.mastered + ' ' + (u.mastered === 1 ? 'card' : 'cards') + ' mastered',
      });
    }
    if (u.retained > 0) {
      points += 2;
      capabilities.push({
        id: 'retained:' + u.key,
        label: u.unit + ' — still held after 21 days',
        earned: true,
        evidence: 'gates +2 / +7 / +21 all passed',
      });
    }
  }
  points += Math.min(10, nums.length);
  for (const n of nums.slice(0, 10)) {
    capabilities.push({
      id: 'scaffold:' + n.problemType,
      label: n.problemType + ' — solved with the scaffolding removed',
      earned: true,
      evidence: 'scaffold level ' + n.scaffoldLevel + ' of 4',
    });
  }
  points += Math.min(6, papers.length * 2);
  if (papers.length) {
    const best = papers.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    capabilities.push({
      id: 'paper-60',
      label: 'Full paper at 60% or better',
      earned: true,
      evidence: Math.round(best.marks) + ' of ' + Math.round(best.total) + ' marks',
    });
  }

  const ladder = ladderFor(subj);
  let level = 0;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (points >= LEVEL_THRESHOLDS[i]) level = i;
  }
  const capIndex = clamp(level, 0, ladder.length - 1);
  const nextIdx = level + 1;
  const nextThreshold = LEVEL_THRESHOLDS[nextIdx];
  const floor = LEVEL_THRESHOLDS[level] || 0;

  return {
    subject: subj,
    level,
    maxLevel: LEVEL_THRESHOLDS.length - 1,
    label: ladder[capIndex],
    points,
    pointsIntoLevel: points - floor,
    pointsForNext: nextThreshold === undefined ? 0 : nextThreshold - floor,
    progress: nextThreshold === undefined ? 1 : clamp((points - floor) / Math.max(1, nextThreshold - floor), 0, 1),
    next: nextThreshold === undefined ? null : {
      level: nextIdx,
      label: ladder[clamp(nextIdx, 0, ladder.length - 1)],
      need: (nextThreshold - points) + ' more '
        + ((nextThreshold - points) === 1 ? 'unit milestone' : 'unit milestones'),
    },
    capabilities,
    unitsMastered: units.filter((u) => u.mastered > 0).length,
    unitsRetained: units.filter((u) => u.retained > 0).length,
    xp: readGame().xp,
  };
}

/** Level for every subject the vault knows about. */
export function getLevelsBySubject() {
  const subjects = getSubjects();
  const list = (subjects && subjects.length ? subjects : []).map((s) => getLevelInfo(typeof s === 'string' ? s : s.name));
  return list.filter(Boolean);
}

/* getLevelInfo() walks every SRS card. Capability levels move over weeks, so
   recomputing the snapshot more than once a minute buys nothing. */
let lastLevelSync = 0;

function syncLevelSnapshot(force) {
  const now = Date.now();
  if (!force && now - lastLevelSync < 60000) return;
  lastLevelSync = now;
  const info = getLevelInfo();
  const g = readGame();
  if (g.level !== info.level) {
    const before = g.level;
    g.level = info.level;
    writeGame(g);
    emit('level', { level: info.level, before, label: info.label });
    if (info.level > before) {
      celebrate({ kind: 'level', label: 'New capability: ' + info.label });
    }
  }
}

/* ---------------------------------------------------------------------------
   9. Badges — exactly eight, curated (pedagogy-spec §4: no badge inflation)
   ------------------------------------------------------------------------ */

export const BADGES = Object.freeze([
  {
    id: 'terminal-jump',
    label: 'Terminal Jump',
    icon: 'trending-up',
    tone: 'good',
    description: 'Scored more at a terminal than at the one before it.',
  },
  {
    id: 'first-paper',
    label: 'Full Paper',
    icon: 'file-text',
    tone: 'brand',
    description: 'Sat a complete paper under the real time limit.',
  },
  {
    id: 'thirty-nights',
    label: 'Thirty Nights',
    icon: 'moon',
    tone: 'ai',
    description: 'Thirty lifetime nights of review.',
  },
  {
    id: 'first-retained',
    label: 'Chapter Held',
    icon: 'shield',
    tone: 'good',
    description: 'A chapter that survived the +2, +7 and +21 day checks.',
  },
  {
    id: 'boss-down',
    label: 'Mock Down',
    icon: 'swords',
    tone: 'bad',
    description: 'Took a mock paper down for the first time.',
  },
  {
    id: 'shared-deck',
    label: 'Deck Shared',
    icon: 'send',
    tone: 'info',
    description: 'Shared a deck, map or note with the group.',
  },
  {
    id: 'all-rings-week',
    label: 'Seven Full Days',
    icon: 'target',
    tone: 'brand',
    description: 'Seven days running with all three rings closed.',
  },
  {
    id: 'comeback',
    label: 'Came Back',
    icon: 'heart',
    tone: 'ai',
    description: 'Returned after time away and started again.',
  },
]);

const BADGE_INDEX = new Map(BADGES.map((b) => [b.id, b]));

function milestoneCount(g, kind) {
  const m = g.milestones[kind];
  return isObj(m) ? int(m.count, 0) : 0;
}

/** Award a badge if it is not already held. Returns true when newly earned. */
function grantBadge(g, id, day) {
  if (!BADGE_INDEX.has(id)) return false;
  if (g.badges.some((b) => b && b.id === id)) return false;
  g.badges.push({ id, earnedOn: day || todayLocalISO() });
  return true;
}

/** Re-check every badge condition. Cheap; safe to call after any activity. */
export function evaluateBadges() {
  const g = readGame();
  const s = readStreak();
  const day = todayLocalISO();
  const earned = [];
  const held = new Set(g.badges.map((b) => b && b.id));

  if (s.lifetimeDays >= 30 && grantBadge(g, 'thirty-nights', day)) earned.push('thirty-nights');
  if (milestoneCount(g, 'timed-paper') >= 1 && grantBadge(g, 'first-paper', day)) earned.push('first-paper');
  if (milestoneCount(g, 'boss-down') >= 1 && grantBadge(g, 'boss-down', day)) earned.push('boss-down');
  if (milestoneCount(g, 'shared-deck') >= 1 && grantBadge(g, 'shared-deck', day)) earned.push('shared-deck');
  if (milestoneCount(g, 'terminal-jump') >= 1 && grantBadge(g, 'terminal-jump', day)) earned.push('terminal-jump');
  if (milestoneCount(g, 'comeback') >= 1 && grantBadge(g, 'comeback', day)) earned.push('comeback');
  if (int(g.ringStreak.days, 0) >= 7 && grantBadge(g, 'all-rings-week', day)) earned.push('all-rings-week');

  // unitEvidence() walks every SRS card, so only pay for it while the badge
  // is still outstanding.
  if (!held.has('first-retained')) {
    const retained = milestoneCount(g, 'retained-chapter') >= 1
      || unitEvidence().some((u) => u.retained > 0);
    if (retained && grantBadge(g, 'first-retained', day)) earned.push('first-retained');
  }

  if (earned.length) {
    writeGame(g);
    for (const id of earned) emit('badge', { id, badge: BADGE_INDEX.get(id) });
    // One burst, however many landed at once — three overlapping confetti
    // layers and three chimes is noise, not a reward.
    if (earned.length === 1) {
      const b = BADGE_INDEX.get(earned[0]);
      celebrate({ kind: 'badge', label: b.label, body: b.description, tone: b.tone });
    } else {
      celebrate({
        kind: 'badge',
        label: earned.length + ' badges earned',
        body: earned.map((id) => BADGE_INDEX.get(id).label).join(' · '),
      });
    }
  }
  return earned;
}

/** Every badge with its earned state — locked ones render at .is-locked. */
export function getBadges() {
  const g = readGame();
  const held = new Map(g.badges.map((b) => [b.id, b.earnedOn]));
  return BADGES.map((b) => Object.assign({}, b, {
    earned: held.has(b.id),
    earnedOn: held.get(b.id) || null,
  }));
}

/* ---------------------------------------------------------------------------
   10. Titles
   ------------------------------------------------------------------------ */

export const TITLES = Object.freeze([
  { id: 'night-one', label: 'Night One', test: (c) => c.lifetime >= 1 },
  { id: 'seven-nights', label: 'Seven Nights', test: (c) => c.lifetime >= 7 },
  { id: 'thirty-nights', label: 'Thirty Nights', test: (c) => c.lifetime >= 30 },
  { id: 'hundred-nights', label: 'Hundred Nights', test: (c) => c.lifetime >= 100 },
  { id: 'chapter-keeper', label: 'Chapter Keeper', test: (c) => c.unitsRetained >= 3 },
  { id: 'unit-clearer', label: 'Unit Clearer', test: (c) => c.unitsMastered >= 5 },
  { id: 'paper-veteran', label: 'Paper Veteran', test: (c) => c.papers >= 3 },
  { id: 'mock-breaker', label: 'Mock Breaker', test: (c) => c.bossDown >= 3 },
  { id: 'came-back', label: 'Came Back', test: (c) => c.comebacks >= 1 },
  { id: 'sixty-seven', label: '67 Club', test: (c) => c.bestPaperMarks >= 67 },
]);

function titleContext() {
  const g = readGame();
  const s = readStreak();
  const lvl = getLevelInfo();
  const papers = paperEvidence(null);
  const best = papers.reduce((a, p) => Math.max(a, p.marks || 0), 0);
  return {
    lifetime: s.lifetimeDays,
    unitsRetained: lvl.unitsRetained,
    unitsMastered: lvl.unitsMastered,
    papers: milestoneCount(g, 'timed-paper'),
    bossDown: milestoneCount(g, 'boss-down'),
    comebacks: milestoneCount(g, 'comeback'),
    bestPaperMarks: best,
  };
}

/**
 * THE CONTRACT SHAPE.
 * @returns {Array<{id:string, label:string, earned:boolean, earnedOn:string|null, equipped:boolean}>}
 */
export function getTitles() {
  const g = readGame();
  const ctx = titleContext();
  const held = new Map(g.titles.map((t) => [t.id, t.earnedOn]));
  const day = todayLocalISO();
  let dirty = false;

  const out = TITLES.map((t) => {
    let earned = held.has(t.id);
    if (!earned) {
      try { earned = Boolean(t.test(ctx)); } catch (_) { earned = false; }
      if (earned) { g.titles.push({ id: t.id, earnedOn: day }); held.set(t.id, day); dirty = true; }
    }
    return {
      id: t.id,
      label: t.label,
      earned,
      earnedOn: held.get(t.id) || null,
      equipped: g.equippedTitle === t.id,
    };
  });

  if (dirty) writeGame(g);
  return out;
}

/**
 * Equip an earned title. Writes only the `title` field of KEYS.PROFILE.
 * @param {string|null} id
 */
export function equipTitle(id) {
  const list = getTitles();
  const found = id === null ? null : list.find((t) => t.id === id && t.earned);
  if (id !== null && !found) return { ok: false, reason: 'not-earned' };
  const g = readGame();
  g.equippedTitle = found ? found.id : null;
  writeGame(g);
  store.update(KEYS.PROFILE, (prev) => Object.assign({}, isObj(prev) ? prev : {}, {
    title: found ? found.label : null,
  }), {});
  return { ok: true, title: found ? found.label : null };
}

/* ---------------------------------------------------------------------------
   11. Weekly quests — from GROW weakness data + the terminal countdown
   ------------------------------------------------------------------------ */

/* The calendar lives at one store key. grow.js exports the identical string
   (`EXAM_CALENDAR_KEY = 'examCalendar'`) and owns the student-confirmed rows;
   this layer only reads them, plus the shipped data/examCalendar.json as a
   fallback for a fresh install. It is not in KEYS yet — see the report. */
const EXAM_CALENDAR_KEY = 'examCalendar';

/** The shipped-file rows only. The STORE always wins over this (below). */
let examCalendarCache = null;
let examCalendarPending = null;

/** Normalise one calendar row. data/examCalendar.json uses `ad` for the
 *  Gregorian date (all day math is on that); `bs` is display only. */
function normaliseExamRow(e) {
  if (!isObj(e)) return null;
  const date = typeof e.ad === 'string' ? e.ad
    : (typeof e.date === 'string' ? e.date : null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  return {
    id: e.id || e.label || date,
    label: String(e.label || 'Exam'),
    date,
    bs: e.bs || null,
    phase: e.phase || null,
    confidence: e.confidence || null,
    subjects: Array.isArray(e.subjects) ? e.subjects : (e.subject ? [e.subject] : []),
    detail: e.detail || '',
  };
}

/**
 * Supply the exam calendar in code (tests, or a job that already has it).
 * @param {Array<{id?:string, label:string, date?:string, ad?:string}>} list
 */
export function setExamCalendar(list) {
  examCalendarCache = Array.isArray(list) ? list.map(normaliseExamRow).filter(Boolean) : null;
  if (examCalendarCache) {
    store.set(EXAM_CALENDAR_KEY, examCalendarCache);
    // The calendar usually arrives AFTER this week's quests were generated
    // (papers/settings hand it over on their first render). Without this the
    // countdown quest would not appear until the following Monday.
    if (examCalendarCache.length) refreshExamQuest();
  }
  return examCalendarCache || [];
}

/** Any of the three shapes the calendar has ever been written in -> rows. */
function normaliseExamList(raw) {
  if (Array.isArray(raw)) return raw.map(normaliseExamRow).filter(Boolean);
  if (isObj(raw) && Array.isArray(raw.events)) return raw.events.map(normaliseExamRow).filter(Boolean);
  if (isObj(raw)) {
    return Object.entries(raw)
      .map(([subject, date]) => normaliseExamRow({ label: subject + ' paper', subject, date }))
      .filter(Boolean);
  }
  return [];
}

/* The STORE is read first on purpose: those are the dates he (or Hermes in
   week 1) confirmed with the college, and they must beat the extrapolated
   dates shipped in data/examCalendar.json. */
function readExamCalendar() {
  const stored = normaliseExamList(store.get(EXAM_CALENDAR_KEY, null));
  if (stored.length) return stored;
  return examCalendarCache || [];
}

/** Fetch data/examCalendar.json once. Same-origin, cached, never fatal. */
export function loadExamCalendar() {
  if (examCalendarCache) return Promise.resolve(examCalendarCache);
  if (examCalendarPending) return examCalendarPending;
  const url = new URL('../data/examCalendar.json', import.meta.url).toString();
  examCalendarPending = fetch(url, { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      const rows = Array.isArray(json) ? json : arr(json && json.events);
      examCalendarCache = rows.map(normaliseExamRow).filter(Boolean);
      if (examCalendarCache.length) refreshExamQuest();
      return examCalendarCache;
    })
    .catch(() => { examCalendarCache = []; return examCalendarCache; });
  return examCalendarPending;
}

/** Swap the generic paper quest for the real countdown once the calendar lands. */
function refreshExamQuest() {
  const day = todayLocalISO();
  const g = readGame();
  if (!isObj(g.quests) || g.quests.weekStart !== weekStartISO(day)) return;
  const idx = g.quests.items.findIndex((it) => isObj(it) && it.id === 'paper:weekly' && !it.completedOn && !int(it.progress, 0));
  if (idx < 0) return;
  const rebuilt = buildQuests(day).items.find((it) => it.kind === 'milestone');
  if (rebuilt && rebuilt.id !== 'paper:weekly') {
    g.quests.items[idx] = rebuilt;
    writeGame(g);
    emit('quest', { quests: getQuests(day), finished: [] });
  }
}

/** The next exam ahead of `day`, or null. */
export function nextExam(day) {
  const today = day || todayLocalISO();
  const rows = readExamCalendar()
    .map((e) => Object.assign({}, e, { daysAway: diffDaysISO(today, e.date) }))
    .filter((e) => e.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway);
  return rows[0] || null;
}

/** GROW rows sorted reddest and stalest first. */
function weakestUnits(limit) {
  const raw = store.get(KEYS.GROW, {});
  if (!isObj(raw)) return [];
  const today = todayLocalISO();
  const weight = { R: 3, Y: 2, G: 1 };
  return Object.entries(raw)
    .filter(([, v]) => isObj(v))
    .map(([unitId, v]) => {
      const stale = Math.min(60, Math.abs(diffDaysISO(v.updatedISO || today, today)));
      const measured = Number.isFinite(Number(v.measured)) ? Number(v.measured) : null;
      const gap = measured !== null && v.selfRating === 'G' && measured < 0.6 ? 2 : 0;
      return {
        unitId,
        unit: v.unit || v.name || unitId,
        subject: v.subject || null,
        selfRating: v.selfRating || 'R',
        score: (weight[v.selfRating] || 3) * 10 + stale * 0.5 + gap * 5,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 2);
}

/*  Four quests a week, in priority order:
      1. the reddest GROW unit          (weakness x staleness)
      2. the terminal countdown         (exam value)
      3. numericals                     (half the physics paper)
      4. five nights                    (attendance is the dominant variable)
    A second GROW unit only appears when one of the others cannot be built. */
function buildQuests(day) {
  const start = weekStartISO(day);
  const growItems = [];
  const items = [];

  for (const w of weakestUnits(2)) {
    growItems.push({
      id: 'grow:' + w.unitId,
      label: 'Three retrieval sessions on ' + w.unit + ', on three days',
      detail: (w.selfRating === 'R'
        ? 'Your reddest unit. Three spaced sessions moves it off red.'
        : 'Marked ' + (w.selfRating === 'Y' ? 'amber' : 'green') + ' but stale — prove it.')
        + ' One counts per day: the gap between them is what makes it hold.',
      goal: 3,
      progress: 0,
      kind: 'unit',
      match: { unit: w.unitId, subject: w.subject },
      icon: 'target',
      tone: w.selfRating === 'R' ? 'bad' : 'warn',
    });
  }
  if (growItems.length) items.push(growItems[0]);

  const exam = nextExam(day);
  items.push(exam && exam.daysAway <= 90 ? {
    id: 'exam:' + (exam.id || exam.label),
    label: 'One full timed paper before ' + exam.label,
    detail: exam.daysAway + ' ' + (exam.daysAway === 1 ? 'day' : 'days') + ' out. '
      + 'A+ needs about 67 of 75 theory marks.',
    goal: 1,
    progress: 0,
    kind: 'milestone',
    match: { milestone: 'timed-paper' },
    icon: 'clock',
    tone: exam.daysAway <= 21 ? 'bad' : 'brand',
  } : {
    id: 'paper:weekly',
    label: 'Bank one full timed paper',
    detail: 'The standing weekly mock. 22 answer slots, three hours.',
    goal: 1,
    progress: 0,
    kind: 'milestone',
    match: { milestone: 'timed-paper' },
    icon: 'file-text',
    tone: 'brand',
  });

  items.push({
    id: 'drill:20',
    label: 'Twenty numericals, units on every line',
    detail: 'Units on every line is what turns 3 of 5 into 5 of 5.',
    goal: 20,
    progress: 0,
    kind: 'ring',
    match: { ring: 'drill' },
    icon: 'calculator',
    tone: 'good',
  });

  items.push({
    id: 'nights:5',
    label: 'Five nights this week',
    detail: 'Ninety seconds counts as a night.',
    goal: 5,
    progress: 0,
    kind: 'nights',
    icon: 'moon',
    tone: 'ai',
  });

  if (growItems.length > 1) items.push(growItems[1]);

  return { weekStart: start, generatedOn: day || todayLocalISO(), items: items.slice(0, 4) };
}

/**
 * This week's quests, regenerated when the ISO week rolls over.
 * @returns {{weekStart:string, daysLeft:number, items:Array}}
 */
export function getQuests(day) {
  const d = day || todayLocalISO();
  const start = weekStartISO(d);
  loadExamCalendar();                 // background; the fallback quest holds until it lands
  const g = readGame();
  let q = g.quests;
  if (!isObj(q) || q.weekStart !== start || !Array.isArray(q.items)) {
    q = buildQuests(d);
    g.quests = q;
    writeGame(g);
  }
  const items = q.items.map((it) => {
    const stored = Math.max(0, int(it.progress, 0));
    const progress = it.kind === 'nights' ? Math.max(stored, nightsThisWeek(d)) : stored;
    const goal = Math.max(1, int(it.goal, 1));
    return Object.assign({}, it, {
      progress: Math.min(progress, goal),
      goal,
      done: progress >= goal,
      pct: clamp(progress / goal, 0, 1),
    });
  });
  return {
    weekStart: start,
    daysLeft: Math.max(0, 6 - diffDaysISO(start, d)),
    items,
    doneCount: items.filter((i) => i.done).length,
  };
}

function progressQuests(ev) {
  const d = ev.day || todayLocalISO();
  const start = weekStartISO(d);
  const g = readGame();
  if (!isObj(g.quests) || g.quests.weekStart !== start) { getQuests(d); return; }
  let changed = false;
  const finished = [];

  for (const it of g.quests.items) {
    if (!isObj(it) || it.completedOn) continue;
    const goal = Math.max(1, int(it.goal, 1));
    let add = 0;
    if (it.kind === 'ring' && it.match && it.match.ring === ev.kind) add = ev.count;
    if (it.kind === 'unit' && it.match) {
      const meta = ev.meta || {};
      const unitHit = meta.unit && it.match.unit && String(meta.unit) === String(it.match.unit);
      const topicHit = meta.topic && it.match.unit && String(meta.topic) === String(it.match.unit);
      // ONE per day. The quest says "three retrieval sessions", and three
      // sessions in one sitting is massed practice wearing a quest's clothes —
      // the spacing IS the intervention (pedagogy-spec §1.6).
      if ((unitHit || topicHit) && it.lastDay !== d) { add = 1; it.lastDay = d; }
    }
    if (it.kind === 'milestone' && ev.milestone && it.match && it.match.milestone === ev.milestone) add = 1;
    if (it.kind === 'nights') {
      // Attendance is derived, not incremented — take the live count.
      const live = Math.min(goal, nightsThisWeek(d));
      add = Math.max(0, live - int(it.progress, 0));
    }
    if (!add) continue;
    it.progress = Math.min(goal, int(it.progress, 0) + add);
    changed = true;
    if (it.progress >= goal) { it.completedOn = d; finished.push(it); }
  }

  if (changed) {
    writeGame(g);
    emit('quest', { quests: getQuests(d), finished });
    for (const it of finished) {
      awardXP(XP_QUEST_DONE, 'quest');
      celebrate({ kind: 'quest', label: it.label, body: 'Weekly quest done.', tone: it.tone });
    }
  }
}

/* ---------------------------------------------------------------------------
   12. Milestones — the hooks other features call for one-off achievements
   ------------------------------------------------------------------------ */

export const MILESTONE_KINDS = Object.freeze([
  'timed-paper',        // a full paper sat under time
  'terminal-jump',      // a terminal scored above the previous one
  'retained-chapter',   // gates +2/+7/+21 all passed on a chapter
  'boss-down',          // a mock boss defeated (boss.js)
  'shared-deck',        // a deck/map/note shared to the group
  'comeback',           // returned after time away
]);

/**
 * Record a one-off achievement. Idempotent per call; counts accumulate.
 * @param {string} kind one of MILESTONE_KINDS
 * @param {Object} [meta]
 */
export function recordMilestone(kind, meta) {
  const k = String(kind || '');
  if (!MILESTONE_KINDS.includes(k)) return null;
  const day = todayLocalISO();
  const g = readGame();
  const cur = isObj(g.milestones[k]) ? g.milestones[k] : { count: 0, firstOn: null, lastOn: null };
  cur.count = int(cur.count, 0) + 1;
  cur.firstOn = cur.firstOn || day;
  cur.lastOn = day;
  cur.last = isObj(meta) ? meta : null;
  g.milestones[k] = cur;
  writeGame(g);
  progressQuests({ kind: null, count: 0, meta: meta || {}, day, milestone: k });
  evaluateBadges();
  syncLevelSnapshot(true);          // a milestone is exactly when the level may move
  return cur;
}

/**
 * Report a terminal / mock result so the Terminal Jump badge can fire.
 * @param {{subject:string, marks:number, marksTotal:number, label?:string}} result
 */
export function recordTerminalResult(result) {
  const r = isObj(result) ? result : {};
  const subject = String(r.subject || 'overall');
  const marks = Number(r.marks);
  const total = Number(r.marksTotal) || 75;
  if (!Number.isFinite(marks)) return null;
  const g = readGame();
  const key = 'terminal:' + subject;
  const prev = isObj(g.milestones[key]) ? g.milestones[key] : null;
  const prevMarks = prev ? Number(prev.marks) : null;
  g.milestones[key] = { count: (prev ? int(prev.count, 0) : 0) + 1, marks, marksTotal: total, lastOn: todayLocalISO() };
  writeGame(g);
  if (prevMarks !== null && marks > prevMarks) {
    recordMilestone('terminal-jump', { subject, from: prevMarks, to: marks, marksTotal: total });
    celebrate({
      kind: 'terminal',
      label: subject + ': ' + Math.round(marks) + ' of ' + Math.round(total),
      body: '+' + Math.round(marks - prevMarks) + ' marks on last time.',
      subject,
    });
  }
  return { marks, prevMarks, marksTotal: total };
}

/* ---------------------------------------------------------------------------
   13. Celebrations — confetti + window event + optional chat auto-post
   ------------------------------------------------------------------------ */

const posters = new Set();

/**
 * Register a chat auto-post hook. Chat calls this; the post only happens when
 * the student has opted in (settings.celebrationAutoPost === true).
 * @param {(payload:{kind:string,label:string,text:string})=>void} fn
 * @returns {()=>void} unregister
 */
export function registerCelebrationPoster(fn) {
  if (typeof fn !== 'function') return () => {};
  posters.add(fn);
  return () => posters.delete(fn);
}

/**
 * Fire a celebration: confetti (motion-safe), a cue, the window CustomEvent
 * 'engram:celebration', the 'celebration' game event, and — only if opted in —
 * the chat auto-post hook.
 * @param {{kind:string, label:string, body?:string, subject?:string,
 *          tone?:string, silent?:boolean}} spec
 */
export function celebrate(spec) {
  const s = isObj(spec) ? spec : {};
  const detail = {
    kind: String(s.kind || 'session'),
    label: String(s.label || 'Done'),
    body: s.body ? String(s.body) : '',
    subject: s.subject || null,
    tone: s.tone || 'brand',
    ts: Date.now(),
    id: uid('celeb'),
  };

  if (!s.silent) {
    confetti({ seed: detail.label + detail.kind, subject: detail.subject, tone: detail.tone });
    haptic('success');
    cue('streak');
  }

  emit('celebration', detail);
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('engram:celebration', { detail }));
  }

  if (getSettings().celebrationAutoPost === true && posters.size) {
    const text = detail.label + (detail.body ? ' — ' + detail.body : '');
    for (const fn of Array.from(posters)) {
      try { fn({ kind: detail.kind, label: detail.label, text }); }
      catch (err) { console.warn('[game] celebration poster failed', err); }
    }
  }
  return detail;
}

/**
 * Deterministic confetti burst using theme.css's .confetti-layer/.confetti-piece
 * and the six --confetti-* tokens. No-op under prefers-reduced-motion.
 * @param {{seed?:string, count?:number, subject?:string, origin?:{x:number,y:number}}} [opts]
 */
export function confetti(opts) {
  const o = isObj(opts) ? opts : {};
  if (typeof document === 'undefined' || !document.body) return null;
  if (prefersReducedMotion()) return null;

  const rand = prng(hash32(o.seed || 'engram'));
  const count = clamp(int(o.count, 28), 6, 60);
  const layer = el('div.confetti-layer', { attrs: { 'aria-hidden': 'true' } });
  const w = window.innerWidth || 360;
  const h = window.innerHeight || 640;
  const ox = o.origin && Number.isFinite(o.origin.x) ? o.origin.x : w / 2;
  const oy = o.origin && Number.isFinite(o.origin.y) ? o.origin.y : h * 0.34;

  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + rand() * 0.6;
    const dist = 90 + rand() * Math.min(260, w * 0.45);
    const piece = el('span.confetti-piece', {
      style: {
        left: Math.round(ox) + 'px',
        top: Math.round(oy) + 'px',
        background: 'var(--confetti-' + (1 + Math.floor(rand() * 6)) + ')',
        '--tx': Math.round(Math.cos(angle) * dist) + 'px',
        '--ty': Math.round(Math.sin(angle) * dist + 120 + rand() * 140) + 'px',
        '--rot': Math.round(180 + rand() * 540) + 'deg',
        animationDelay: Math.round(rand() * 90) + 'ms',
        opacity: String(0.75 + rand() * 0.25),
      },
    });
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1200);
  return layer;
}

/* ---------------------------------------------------------------------------
   14. Sound + haptic cue (delegates to sounds.js, lazily)
   ------------------------------------------------------------------------ */

let soundsModule = null;
let soundsPending = null;

/**
 * Play a synthesised cue with its matching haptic. Silent when the sounds
 * feature flag is off. Never throws, never blocks.
 * @param {'correct'|'wrong'|'streak'|'confetti'|'boss-hit'|string} name
 */
export function cue(name) {
  if (!isFeatureEnabled('sounds')) return false;
  if (soundsModule) { try { soundsModule.cue(name); } catch (_) { /* ignore */ } return true; }
  if (!soundsPending) {
    soundsPending = import('./sounds.js')
      .then((m) => { soundsModule = m; return m; })
      .catch((err) => { console.warn('[game] sounds unavailable', err); return null; });
  }
  soundsPending.then((m) => { if (m) { try { m.cue(name); } catch (_) { /* ignore */ } } });
  return true;
}

/* ---------------------------------------------------------------------------
   15. Pet
   ------------------------------------------------------------------------ */

export const PET_STAGES = Object.freeze([
  { stage: 1, name: 'Spark', from: 0, blurb: 'Small, awake, and paying attention.' },
  { stage: 2, name: 'Ember', from: 10, blurb: 'Steady now. It has seen you come back.' },
  { stage: 3, name: 'Beacon', from: 30, blurb: 'Bright enough to study by.' },
]);

/**
 * THE CONTRACT SHAPE.
 * Stage is driven by LIFETIME nights, which never decrease — the companion can
 * never regress, never dies, and never guilts. Idle just makes it sleepy.
 */
export function getPetState() {
  const s = readStreak();
  const raw = store.get(KEYS.PET, null);
  const saved = isObj(raw) ? raw : {};
  const nights = s.lifetimeDays;
  let stageDef = PET_STAGES[0];
  for (const st of PET_STAGES) if (nights >= st.from) stageDef = st;
  const idle = daysIdle();
  const idleDays = Number.isFinite(idle) ? idle : 99;
  const rings = getRings();
  const next = PET_STAGES.find((st) => st.from > nights) || null;

  return {
    name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim() : stageDef.name,
    stage: stageDef.stage,
    stageName: stageDef.name,
    blurb: stageDef.blurb,
    mood: idleDays >= PET_SLEEPY_AFTER_DAYS ? 'sleepy' : (rings.allClosed ? 'bright' : 'awake'),
    sleepy: idleDays >= PET_SLEEPY_AFTER_DAYS,
    idleDays,
    nights,
    nextStage: next ? { stage: next.stage, name: next.name, atNights: next.from, nightsToGo: next.from - nights } : null,
    lastActiveDay: s.lastDay,
    // Never "hungry", never "dying". The only states are awake, bright, sleepy.
    caption: idleDays >= PET_SLEEPY_AFTER_DAYS
      ? 'Dozing. It wakes on your next session.'
      : (rings.allClosed ? 'All three rings closed today.' : stageDef.blurb),
  };
}

/** Rename the companion (his choice — autonomy support). */
export function setPetName(name) {
  const clean = String(name || '').slice(0, 24).trim();
  store.update(KEYS.PET, (prev) => Object.assign({}, isObj(prev) ? prev : {}, { name: clean || null }), {});
  emit('pet', getPetState());
  return getPetState();
}

/**
 * A small mount node for the companion, for the home screen slot.
 * Returns synchronously; pet.js fills it in on the next tick.
 * @param {{size?:number, showCaption?:boolean}} [opts]
 * @returns {HTMLElement}
 */
export function getPetMount(opts) {
  const o = isObj(opts) ? opts : {};
  const host = el('div.pet-slot', {
    dataset: { petSlot: '1' },
    attrs: { role: 'img', 'aria-label': 'Study companion' },
  });
  if (!isFeatureEnabled('pet')) { host.hidden = true; return host; }
  import('./pet.js')
    .then((m) => { host.__petDestroy = m.mountPet(host, o); })
    .catch((err) => { console.warn('[game] pet unavailable', err); host.hidden = true; });
  return host;
}

/** Tear a pet mount down (call from a view's onExit). */
export function destroyPetMount(host) {
  if (host && typeof host.__petDestroy === 'function') {
    try { host.__petDestroy(); } catch (_) { /* ignore */ }
    host.__petDestroy = null;
  }
}

/* ---------------------------------------------------------------------------
   16. Daily quote (data/quotes.json — same-origin, zero external fetches)
   ------------------------------------------------------------------------ */

/*  data/quotes.json carries two sets, tagged by `kind`:
      'fact'  research and method statements — safe in ANY state, including
              straight after a miss or a broken streak.
      'quote' attributed motivational lines — DECORATION ONLY. Playbook P
              (§3.5) forbids answering "I don't feel like it" with a
              motivational quote, so never route this set into a struggle
              response; ask for the feeling and shrink the task instead.       */

let quoteCache = null;
let quotePending = null;

function normaliseQuote(q) {
  if (!isObj(q) || typeof q.text !== 'string') return null;
  return {
    id: q.id || uid('q'),
    kind: q.kind === 'quote' ? 'quote' : 'fact',
    text: q.text,
    author: q.author || null,
    source: q.source || null,
    original: q.original || null,
    tag: q.tag || null,
    attribution: q.author || q.source || null,
  };
}

/** Load and cache data/quotes.json. Resolves to [] when unavailable offline. */
export function loadQuotes() {
  if (quoteCache) return Promise.resolve(quoteCache);
  if (quotePending) return quotePending;
  const url = new URL('../data/quotes.json', import.meta.url).toString();
  quotePending = fetch(url, { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : []))
    .then((json) => {
      const list = Array.isArray(json) ? json : arr(json && json.quotes);
      quoteCache = list.map(normaliseQuote).filter(Boolean);
      return quoteCache;
    })
    .catch(() => { quoteCache = []; return quoteCache; });
  return quotePending;
}

function pickForDay(list, day) {
  if (!list.length) return null;
  return list[hash32(day) % list.length];
}

/**
 * One entry per local day, stable for that day.
 * @param {{day?:string, kind?:'fact'|'quote'|'any'}} [opts]
 * @returns {Promise<{text:string, attribution:string|null, kind:string}|null>}
 */
export async function getDailyQuote(opts) {
  const o = typeof opts === 'string' ? { day: opts } : (isObj(opts) ? opts : {});
  const list = await loadQuotes();
  const kind = o.kind || 'any';
  const pool = kind === 'any' ? list : list.filter((q) => q.kind === kind);
  return pickForDay(pool.length ? pool : list, o.day || todayLocalISO());
}

/** The already-loaded entry for today, or null if quotes.json is not in yet. */
export function getDailyQuoteSync(opts) {
  const o = typeof opts === 'string' ? { day: opts } : (isObj(opts) ? opts : {});
  if (!quoteCache || !quoteCache.length) { loadQuotes(); return null; }
  const kind = o.kind || 'any';
  const pool = kind === 'any' ? quoteCache : quoteCache.filter((q) => q.kind === kind);
  return pickForDay(pool.length ? pool : quoteCache, o.day || todayLocalISO());
}

/* ---------------------------------------------------------------------------
   17. Shared style injector (pet.js / boss.js use this — tokens only, no hexes)
   ------------------------------------------------------------------------ */

const injected = new Set();

/**
 * Inject a one-off <style> block. The game layer owns no CSS file, so its few
 * bespoke pieces (the pet slot, the boss stage) ship their rules here. Every
 * value must be a design token — never a raw colour.
 * @param {string} id
 * @param {string} css
 */
export function injectStyle(id, css) {
  if (typeof document === 'undefined') return false;
  if (injected.has(id) || document.getElementById(id)) { injected.add(id); return false; }
  const node = document.createElement('style');
  node.id = id;
  node.textContent = css;
  document.head.appendChild(node);
  injected.add(id);
  return true;
}

/* ---------------------------------------------------------------------------
   18. Boss bootstrap — 'engram:mock-completed' pulls boss.js in on demand
   ------------------------------------------------------------------------ */

let bossPending = null;
const bossQueue = [];

function bossBootstrap(ev) {
  bossQueue.push(ev && ev.detail);
  if (bossPending) return;
  bossPending = import('./boss.js')
    .then((m) => {
      if (typeof window !== 'undefined') window.removeEventListener('engram:mock-completed', bossBootstrap);
      m.initBoss();
      while (bossQueue.length) m.handleMockCompleted(bossQueue.shift());
      return m;
    })
    .catch((err) => {
      console.warn('[game] boss layer unavailable', err);
      bossQueue.length = 0;
      // Still credit the work even if the presentation layer failed to load.
      recordMilestone('timed-paper');
      return null;
    });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('engram:mock-completed', bossBootstrap);
}

/* ---------------------------------------------------------------------------
   19. Public surface
   ------------------------------------------------------------------------ */

export const game = {
  // the contract
  getRings, recordActivity, awardXP, getStreak, getLevelInfo, getTitles, getPetState, on,
  // rings + attendance
  goalsFor, budgetGoals, daysIdle, nightsThisWeek, recordSession, startSession,
  touchStreak, repairStreak, streakCopy, weekStartISO,
  // progression
  getXP, getLevelsBySubject, configureCapabilities, unitEvidence,
  getBadges, evaluateBadges, equipTitle,
  getQuests, setExamCalendar, loadExamCalendar, nextExam,
  recordMilestone, recordTerminalResult,
  // presentation
  celebrate, confetti, cue, registerCelebrationPoster, injectStyle,
  // pet
  getPetMount, destroyPetMount, setPetName,
  // quotes
  getDailyQuote, getDailyQuoteSync, loadQuotes,
  // constants
  RING_KINDS, RING_META, BADGES, TITLES, PET_STAGES, MILESTONE_KINDS,
  MIN_SESSION_SECONDS, FREEZES_PER_MONTH, REPAIR_WINDOW_HOURS,
};

export default game;
