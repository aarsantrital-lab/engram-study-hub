/**
 * scheduler.js — queue building, caps, leeches, exam ramp, retention gates.
 * =============================================================================
 * Engram v2 · Job A3 · owner: fsrs.js / scheduler.js / tests/fsrs.test.html
 *
 * fsrs.js answers "what does this ONE card do when rated?".
 * scheduler.js answers "what should he study in the next 25 minutes, and why?".
 *
 * Everything here is a pure function of (cards, now, options). ZERO DOM, ZERO
 * network, ZERO randomness — two devices with the same cards build the same
 * queue, which is what makes the provisional browser mirror reconcilable with
 * engram.py (pedagogy-spec R3).
 *
 * SPEC SOURCES
 *   pedagogy-spec §1.6 SPACE — desiredRetention 0.90, exam ramp 0.90→0.95 over
 *     the final 21 days per subject then reset, retention gates +2d/+7d/+21d →
 *     RETAINED, new ≤10–15/day, queue capped by TIME BUDGET, lowest-
 *     retrievability first, never a due-count badge, leech (lapses ≥6) →
 *     auto-suspend → Hermes rewrites the card WITH him.
 *   pedagogy-spec R12 — a leech is a bad card or a missing prerequisite, never
 *     a willpower problem.
 *   build-constraints §9.6 — daily caps ACTUALLY enforced; unseen cards are NOT
 *     unconditionally due.
 *   build-constraints §9.9 — grade-button previews show the interval actually
 *     applied; retention metrics exclude first-exposure grades (0–3 d).
 *   build-constraints §9.1 — all dates from local Y/M/D, never toISOString.
 *   engram.py:928-1000 (due_items), 3366-3415 (RETENTION_BUCKETS / retention).
 */

import {
  RETENTION_DEFAULT, RETENTION_MIN, RETENTION_MAX,
  RATING_NAMES, GRADE_OF_RATING, GRADES, NEPAL_UTC_OFFSET_MIN,
  asNumber, clamp, pyRound,
  todayLocal, toLocalYMD, parseLocalDate, formatLocalDate, addDays, daysBetween,
  dayNumber, fromDayNumber, cmpDate, ymdAtOffset,
  initCard, isNew, cardLast, cardDue, retrievability, intervalFor, applyRating,
  previewIntervals, formatIntervalDays, toReviewLogEntry, toEngramFsrs,
  fromEngramFsrs, replay,
} from './fsrs.js';

/* Re-exported so a feature module can `import { todayLocal } from './scheduler.js'`
 * without also importing fsrs.js. One date implementation, one bug surface. */
export {
  RETENTION_DEFAULT, RETENTION_MIN, RETENTION_MAX,
  RATING_NAMES, GRADE_OF_RATING, GRADES, NEPAL_UTC_OFFSET_MIN,
  asNumber, clamp, pyRound,
  todayLocal, toLocalYMD, parseLocalDate, formatLocalDate, addDays, daysBetween,
  dayNumber, fromDayNumber, cmpDate, ymdAtOffset,
  initCard, isNew, cardLast, cardDue, retrievability, intervalFor, applyRating,
  previewIntervals, formatIntervalDays, toReviewLogEntry, toEngramFsrs,
  fromEngramFsrs, replay,
};

/* =============================================================================
 * 1. POLICY CONSTANTS (pedagogy-spec §1.6)
 * ========================================================================== */

/** Leech threshold. pedagogy-spec §1.6 + R12: lapses ≥ 6 → auto-suspend, and
 *  Hermes REWRITES the card with him. Never framed as a willpower failure. */
export const LEECH_THRESHOLD = 6;

/** New cards per day. Spec says 10–15; 12 is the default, 15 is a hard ceiling
 *  no option may exceed (build-constraints §9.6 — the dead `prefs.dailyNew`
 *  becomes real). */
export const NEW_PER_DAY_DEFAULT = 12;
export const NEW_PER_DAY_MIN = 10;
export const NEW_PER_DAY_MAX = 15;

/** Exam ramp: per-subject desiredRetention rises linearly over the final 21
 *  days before a scheduled paper, then resets. Automates the Cepeda gap ratio. */
export const EXAM_RAMP_DAYS = 21;
export const EXAM_RAMP_START_RETENTION = 0.90;
export const EXAM_RAMP_END_RETENTION = 0.95;

/** Retention gates after MASTERED. All three passed → RETAINED (green). */
export const GATE_DAYS = Object.freeze([2, 7, 21]);

/** engram.py:3366-3372. `early` (0–3 d) is REPORTED but NEVER pooled into a
 *  retention claim: a sub-4-day retrieval is still encoding (build-constraints §9.9). */
export const RETENTION_BUCKETS = Object.freeze([
  Object.freeze({ name: 'early', lo: 0, hi: 3, pooled: false }),
  Object.freeze({ name: '7d', lo: 4, hi: 14, pooled: true }),
  Object.freeze({ name: '30d', lo: 15, hi: 59, pooled: true }),   // ← the headline
  Object.freeze({ name: '90d', lo: 60, hi: 179, pooled: true }),
  Object.freeze({ name: '180d+', lo: 180, hi: 1e6, pooled: true }),
]);
export const RETENTION_HEADLINE_BUCKET = '30d';
/** First-exposure window excluded from every retention metric (§9.9). */
export const RETENTION_EARLY_MAX_DAYS = 3;

/** Defaults for buildSession/dueCards. Every one is overridable per call. */
export const SCHEDULER_DEFAULTS = Object.freeze({
  timeBudgetMin: 25,          // pedagogy-spec §1.6 — the user-facing control
  newPerDay: NEW_PER_DAY_DEFAULT,
  newDoneToday: null,         // null = derive from the cards themselves
  newReservePct: 0.30,        // share of the budget held for encoding
  newPlacement: 'spread',     // 'spread' | 'first' | 'last'
  secondsPerReview: 20,       // conservative median for a recall card
  secondsPerNew: 45,          // first exposure costs more
  maxSessionCards: 300,       // hard safety stop
  leechThreshold: LEECH_THRESHOLD,
  desiredRetention: RETENTION_DEFAULT,
  intervalMultiplier: 1.0,    // engram's per-user `im` (from `refit`), if any
  examDate: null,             // 'YYYY-MM-DD' fallback for cards without a subject
  examDates: null,            // { [subject]: 'YYYY-MM-DD' } — per-subject ramp
  horizonDays: 0,             // 0 = due today; >0 previews the next N days
  includeSuspended: false,
  interleaveTopics: false,    // engram.py:992-997 round-robin; OFF by default
                              // because §1.6 makes lowest-retrievability the rule
});

function opt(opts, key) {
  const v = opts ? opts[key] : undefined;
  return v === undefined ? SCHEDULER_DEFAULTS[key] : v;
}

/* =============================================================================
 * 2. DESIRED RETENTION + EXAM RAMP  (pedagogy-spec §1.6)
 * ========================================================================== */

/**
 * Desired retention for a scheduled paper, ramped linearly over the final
 * EXAM_RAMP_DAYS (21) days, then RESET.
 *
 *   daysToExam > 21   → 0.90        (no ramp yet)
 *   daysToExam = 21   → 0.90        (ramp boundary, inclusive)
 *   daysToExam = 10.5 → 0.925       (linear)
 *   daysToExam = 0    → 0.95        (paper day)
 *   daysToExam < 0    → 0.90        (paper is past → reset)
 *   examDate missing / unparseable → 0.90
 *
 * Formula: 0.90 + 0.05 * (21 - daysToExam) / 21, clamped to engram's
 * [0.70, 0.97] bounds and rounded to 6 dp so the value is stable in the
 * review-log JSONL across devices.
 *
 * @param {string|null} examDateLocal 'YYYY-MM-DD'
 * @param {string|Date|number|null} [now]
 * @returns {number}
 */
export function examRamp(examDateLocal, now = null) {
  const today = toLocalYMD(now);
  const d = daysBetween(today, examDateLocal);          // +ve = exam is ahead
  if (d === null || d < 0 || d > EXAM_RAMP_DAYS) return EXAM_RAMP_START_RETENTION;
  const progress = (EXAM_RAMP_DAYS - d) / EXAM_RAMP_DAYS;   // 0 at 21d, 1 on the day
  const r = EXAM_RAMP_START_RETENTION
    + (EXAM_RAMP_END_RETENTION - EXAM_RAMP_START_RETENTION) * progress;
  return pyRound(clamp(r, RETENTION_MIN, RETENTION_MAX), 6);
}

/**
 * The desired retention that applies to ONE card right now: its subject's exam
 * ramp if a paper is scheduled, otherwise the global default.
 * @param {object} card
 * @param {string|Date|number|null} [now]
 * @param {object} [opts] {examDates:{subject→date}, examDate, desiredRetention}
 * @returns {number}
 */
export function desiredRetentionFor(card, now = null, opts = {}) {
  const map = opt(opts, 'examDates');
  const subject = card && card.subject;
  const exam = (map && subject && map[subject]) || opt(opts, 'examDate') || null;
  if (exam) return examRamp(exam, now);
  return clamp(asNumber(opt(opts, 'desiredRetention'), RETENTION_DEFAULT),
    RETENTION_MIN, RETENTION_MAX);
}

/* =============================================================================
 * 3. LEECHES  (pedagogy-spec §1.6 + R12)
 * ========================================================================== */

/** lapses ≥ threshold (default 6). */
export function isLeech(card, threshold = LEECH_THRESHOLD) {
  return (asNumber(card && card.lapses, 0) || 0) >= threshold;
}

/**
 * Pure leech pass: returns a NEW card with `leech` and `suspended` set when the
 * lapse count crosses the threshold. Never un-suspends (a manual suspend and a
 * leech suspend share the flag; only the feature layer clears it, after Hermes
 * and the student have rewritten the card together).
 * @returns {object} the same object reference when nothing changed
 */
export function leechCheck(card, threshold = LEECH_THRESHOLD) {
  if (!isLeech(card, threshold)) return card;
  if (card.leech && card.suspended) return card;
  return { ...card, leech: true, suspended: true };
}

/** Every leech, most-lapsed first — the rewrite worklist Hermes surfaces. */
export function leeches(cards, threshold = LEECH_THRESHOLD) {
  return (cards || [])
    .filter((c) => isLeech(c, threshold))
    .sort((a, b) => (b.lapses - a.lapses) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Clear a leech after Hermes + the student have rewritten the card.
 * Lapses are NOT zeroed — the history is real — but the counter is offset so the
 * rewritten card is not instantly re-suspended, and the offset is recorded.
 */
export function clearLeech(card, now = null) {
  return {
    ...card,
    leech: false,
    suspended: false,
    lapses: 0,
    rewrittenOn: toLocalYMD(now),
    lapsesBeforeRewrite: (asNumber(card.lapses, 0) || 0)
      + (asNumber(card.lapsesBeforeRewrite, 0) || 0),
  };
}

/* =============================================================================
 * 4. QUEUE BUILDING
 * ========================================================================== */

/**
 * Is this card due for review? engram.py:945-949:
 *   a node with state 'new' or no `due` date is NEVER in the due queue
 *   (build-constraints §9.6 — unseen cards are not unconditionally due).
 * @param {object} card
 * @param {string} todayStr 'YYYY-MM-DD'
 * @param {number} [horizonDays=0]
 */
export function isDue(card, todayStr, horizonDays = 0) {
  if (!card || card.state === 'new' || isNew(card)) return false;
  const due = cardDue(card);
  if (!due) return false;
  return cmpDate(due, addDays(todayStr, horizonDays)) <= 0;
}

/** Whole days a card is past its due date (0 if due today, negative if ahead). */
export function overdueDays(card, todayStr) {
  const n = daysBetween(cardDue(card), todayStr);
  return n === null ? 0 : n;
}

/** Estimated seconds this card will cost in a session. */
export function estSecondsFor(card, opts = {}) {
  const own = asNumber(card && card.estSeconds);
  if (own !== null && own > 0) return own;
  return isNew(card) ? opt(opts, 'secondsPerNew') : opt(opts, 'secondsPerReview');
}

/**
 * Per-card queue metadata, without mutating the card. UI reads this.
 * @returns {{card, retrievability:number, overdueDays:number, estSeconds:number,
 *            intervalDays:number, desiredRetention:number, tone:string}}
 */
export function queueMeta(card, now = null, opts = {}) {
  const today = toLocalYMD(now);
  const r = retrievability(card, today);
  const dr = desiredRetentionFor(card, today, opts);
  return {
    card,
    retrievability: r === null ? null : r,
    overdueDays: overdueDays(card, today),
    estSeconds: estSecondsFor(card, opts),
    intervalDays: intervalFor(card, dr, opt(opts, 'intervalMultiplier')),
    desiredRetention: dr,
    tone: srsTone(card, today),
  };
}

/**
 * SRS colour tone for the design tokens (build-constraints §10):
 *   mastered → emerald (--good) · due-soon/weak → amber (--warn)
 *   lapsed/overdue → red (--bad) · new → sky (--info)
 */
export function srsTone(card, now = null) {
  if (!card) return 'new';
  if (card.suspended) return 'lapsed';
  if (isNew(card)) return 'new';
  const today = toLocalYMD(now);
  const r = retrievability(card, today);
  if (overdueDays(card, today) > 0 || (r !== null && r < 0.80)) return 'lapsed';
  if (r !== null && r < 0.92) return 'due-soon';
  return 'mastered';
}

/**
 * DUE CARDS, sorted LOWEST-RETRIEVABILITY-FIRST (pedagogy-spec §1.6).
 * Suspended/leech cards are excluded (they are waiting on a rewrite, not on the
 * student). New cards are excluded — they arrive through the daily new cap.
 *
 * @param {Array<object>} cards
 * @param {string|Date|number|null} [now]
 * @param {object} [opts] {timeBudgetMin, horizonDays, includeSuspended,
 *                         interleaveTopics, secondsPerReview, examDates, …}
 *        timeBudgetMin: when supplied (and > 0) the returned array is truncated
 *        so its estimated cost fits the budget. Pass null for "everything due".
 * @returns {Array<object>} the ORIGINAL card objects, re-ordered (never copies —
 *          callers keep identity so they can write results straight back)
 */
export function dueCards(cards, now = null, opts = {}) {
  const today = toLocalYMD(now);
  const horizon = Math.max(0, Math.trunc(asNumber(opt(opts, 'horizonDays'), 0) || 0));
  const includeSuspended = !!opt(opts, 'includeSuspended');

  const pool = (cards || []).filter((c) =>
    isDue(c, today, horizon) && (includeSuspended || !c.suspended));

  const sorted = sortByRetrievability(pool, today);
  const ordered = opt(opts, 'interleaveTopics') ? interleaveByTopic(sorted) : sorted;

  const budgetMin = asNumber(opt(opts, 'timeBudgetMin'));
  if (budgetMin === null || budgetMin <= 0) return ordered;

  const budgetSec = budgetMin * 60;
  const out = [];
  let used = 0;
  const maxCards = Math.trunc(opt(opts, 'maxSessionCards'));
  for (const c of ordered) {
    const cost = estSecondsFor(c, opts);
    if (out.length && (used + cost > budgetSec || out.length >= maxCards)) break;
    out.push(c);
    used += cost;
    if (out.length >= maxCards) break;
  }
  return out;
}

/**
 * Lowest retrievability first. Deterministic tiebreak chain so two devices
 * building the same queue produce byte-identical order:
 *   retrievability ASC → overdueDays DESC → due ASC → id ASC
 * A null retrievability (a card with no stability) sorts first — it is the most
 * unknown thing in the queue — but dueCards never lets one through.
 */
export function sortByRetrievability(cards, now = null) {
  const today = toLocalYMD(now);
  const key = new Map();
  for (const c of cards) {
    const r = retrievability(c, today);
    key.set(c, { r: r === null ? -1 : r, od: overdueDays(c, today) });
  }
  return cards.slice().sort((a, b) => {
    const ka = key.get(a), kb = key.get(b);
    if (ka.r !== kb.r) return ka.r - kb.r;
    if (ka.od !== kb.od) return kb.od - ka.od;
    const d = cmpDate(cardDue(a) || '9999-12-31', cardDue(b) || '9999-12-31');
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** engram.py:992-997 — round-robin across topics, preserving each topic's order. */
export function interleaveByTopic(cards) {
  const byTopic = new Map();
  for (const c of cards) {
    const t = c.topic || '';
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(c);
  }
  const out = [];
  const lists = [...byTopic.values()];
  let more = true;
  while (more) {
    more = false;
    for (const l of lists) {
      if (l.length) { out.push(l.shift()); more = true; }
    }
  }
  return out;
}

/**
 * How many new cards were already introduced today. Derived from the cards
 * themselves (reps === 1 and last === today ⇒ today's first exposure) unless the
 * caller supplies an authoritative count from the review log.
 */
export function newDoneToday(cards, now = null, explicit = null) {
  const n = asNumber(explicit);
  if (n !== null) return Math.max(0, Math.trunc(n));
  const today = toLocalYMD(now);
  let count = 0;
  for (const c of cards || []) {
    if (c.introducedOn === today) count += 1;
    else if (c.last === today && (asNumber(c.reps, 0) || 0) === 1) count += 1;
  }
  return count;
}

/**
 * Candidate new cards, capped by the daily allowance actually remaining.
 * ENFORCED, not advisory (build-constraints §9.6). The cap is clamped to
 * [0, 15] no matter what the caller asks for.
 * Order: explicit `card.order` → topic → id, so it is stable and curriculum-led.
 */
export function newQueue(cards, now = null, opts = {}) {
  const today = toLocalYMD(now);
  const perDay = clamp(Math.trunc(asNumber(opt(opts, 'newPerDay'), NEW_PER_DAY_DEFAULT) || 0),
    0, NEW_PER_DAY_MAX);
  const done = newDoneToday(cards, today, opt(opts, 'newDoneToday'));
  const allowed = Math.max(0, perDay - done);
  if (allowed === 0) return [];
  return (cards || [])
    .filter((c) => isNew(c) && !c.suspended && c.state === 'new')
    .sort((a, b) => {
      const oa = asNumber(a.order, Number.MAX_SAFE_INTEGER);
      const ob = asNumber(b.order, Number.MAX_SAFE_INTEGER);
      if (oa !== ob) return oa - ob;
      const t = String(a.topic || '').localeCompare(String(b.topic || ''));
      if (t !== 0) return t;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, allowed);
}

/**
 * THE SESSION. Reviews (lowest-retrievability first) + the day's remaining new
 * cards, packed into a TIME BUDGET — never a card count, never a due-count badge
 * (pedagogy-spec §1.6: the user-facing control is "tonight: 25 minutes").
 *
 * Budget policy:
 *   1. up to `newReservePct` of the budget is reserved for new cards, so a
 *      review backlog can never starve encoding;
 *   2. reviews fill the remainder, lowest retrievability first;
 *   3. leftover budget spills back to whichever side still has cards.
 *
 * @returns {{
 *   date:string, queue:Array<object>, reviews:Array<object>, news:Array<object>,
 *   counts:{dueTotal:number, reviewsQueued:number, newAvailable:number,
 *           newAllowed:number, newDoneToday:number, newQueued:number,
 *           suspended:number, leeches:number, queued:number},
 *   budget:{timeBudgetMin:number, estSeconds:number, estMinutes:number,
 *           full:boolean, cutoff:'none'|'time-budget'|'max-cards'},
 *   label:string
 * }}
 */
export function buildSession(cards, now = null, opts = {}) {
  const today = toLocalYMD(now);
  const all = cards || [];
  const budgetMin = Math.max(0, asNumber(opt(opts, 'timeBudgetMin'), 25) || 0);
  const budgetSec = budgetMin * 60;
  const maxCards = Math.max(1, Math.trunc(opt(opts, 'maxSessionCards')));

  const dueAll = dueCards(all, today, { ...opts, timeBudgetMin: null });
  const newAll = newQueue(all, today, opts);

  const perDay = clamp(Math.trunc(asNumber(opt(opts, 'newPerDay'), NEW_PER_DAY_DEFAULT) || 0),
    0, NEW_PER_DAY_MAX);
  const done = newDoneToday(all, today, opt(opts, 'newDoneToday'));

  const reservePct = clamp(asNumber(opt(opts, 'newReservePct'), 0.30) || 0, 0, 1);
  const newBudget = budgetSec * reservePct;

  const news = [];
  const reviews = [];
  let used = 0;
  let cutoff = 'none';

  // pass 1 — new cards inside their reserve
  for (const c of newAll) {
    const cost = estSecondsFor(c, opts);
    if (used + cost > newBudget) break;
    if (news.length + reviews.length >= maxCards) { cutoff = 'max-cards'; break; }
    news.push(c); used += cost;
  }
  // pass 2 — reviews fill the rest
  for (const c of dueAll) {
    const cost = estSecondsFor(c, opts);
    if (used + cost > budgetSec) { cutoff = cutoff === 'none' ? 'time-budget' : cutoff; break; }
    if (news.length + reviews.length >= maxCards) { cutoff = 'max-cards'; break; }
    reviews.push(c); used += cost;
  }
  // pass 3 — spill leftover budget back to new cards
  if (reviews.length === dueAll.length) {
    for (const c of newAll) {
      if (news.includes(c)) continue;
      const cost = estSecondsFor(c, opts);
      if (used + cost > budgetSec) { cutoff = cutoff === 'none' ? 'time-budget' : cutoff; break; }
      if (news.length + reviews.length >= maxCards) { cutoff = 'max-cards'; break; }
      news.push(c); used += cost;
    }
  }
  if (cutoff === 'none' && (reviews.length < dueAll.length || news.length < newAll.length)) {
    cutoff = 'time-budget';
  }

  const queue = placeNewCards(reviews, news, opt(opts, 'newPlacement'));
  const suspended = all.filter((c) => c.suspended).length;

  return {
    date: today,
    queue,
    reviews,
    news,
    counts: {
      dueTotal: dueAll.length,
      reviewsQueued: reviews.length,
      newAvailable: all.filter((c) => isNew(c) && !c.suspended && c.state === 'new').length,
      newAllowed: Math.max(0, perDay - done),
      newDoneToday: done,
      newQueued: news.length,
      suspended,
      leeches: all.filter((c) => isLeech(c, opt(opts, 'leechThreshold'))).length,
      queued: queue.length,
    },
    budget: {
      timeBudgetMin: budgetMin,
      estSeconds: used,
      estMinutes: pyRound(used / 60, 1),
      full: used >= budgetSec && budgetSec > 0,
      cutoff,
    },
    // pedagogy-spec §1.6: show TIME, never a due count.
    label: sessionLabel(budgetMin, used),
  };
}

/** 'spread' distributes new cards evenly through the reviews (encoding does not
 *  all land at one end); 'first'/'last' block them. */
export function placeNewCards(reviews, news, placement = 'spread') {
  if (!news.length) return reviews.slice();
  if (!reviews.length) return news.slice();
  if (placement === 'first') return news.concat(reviews);
  if (placement === 'last') return reviews.concat(news);
  const out = [];
  const gap = reviews.length / (news.length + 1);
  let ni = 0;
  for (let i = 0; i < reviews.length; i += 1) {
    while (ni < news.length && i >= Math.round(gap * (ni + 1))) out.push(news[ni++]);
    out.push(reviews[i]);
  }
  while (ni < news.length) out.push(news[ni++]);
  return out;
}

/** "tonight: 25 minutes" — never "25 cards due" (pedagogy-spec §1.6). */
export function sessionLabel(budgetMin, estSeconds) {
  const mins = Math.max(1, Math.round(estSeconds / 60));
  const cap = Math.max(1, Math.round(budgetMin));
  return `${Math.min(mins, cap)} minutes`;
}

/* =============================================================================
 * 5. GRADE-BUTTON PREVIEW  (build-constraints §9.9)
 * ========================================================================== */

/**
 * The four grade buttons, each carrying the interval that WILL be applied —
 * computed through the real engine at this card's real desired retention
 * (exam ramp included). No invented labels, no "<10m" step engram does not have.
 *
 * @returns {Array<{rating, ratingNum, intervalDays, due, label, stability,
 *          difficulty, state, lapses, desiredRetention, tone}>}
 */
export function gradePreview(card, now = null, opts = {}) {
  const today = toLocalYMD(now);
  const dr = desiredRetentionFor(card, today, opts);
  const im = asNumber(opt(opts, 'intervalMultiplier'), 1.0);
  const tones = { again: 'lapsed', hard: 'due-soon', good: 'mastered', easy: 'mastered' };
  return previewIntervals(card, today, { desiredRetention: dr, intervalMultiplier: im })
    .map((p) => ({ ...p, desiredRetention: dr, tone: tones[p.rating] }));
}

/**
 * Rate a card and produce everything the app needs in one call:
 * the new card (leech-checked) and the review-log line to append.
 * @returns {{card:object, entry:object, leechTriggered:boolean}}
 */
export function rateCard(card, rating, now = null, opts = {}, logExtra = {}) {
  const today = toLocalYMD(now);
  const dr = desiredRetentionFor(card, today, opts);
  const im = asNumber(opt(opts, 'intervalMultiplier'), 1.0);
  const rated = applyRating(card, rating, today, { desiredRetention: dr, intervalMultiplier: im });
  const checked = leechCheck(rated, opt(opts, 'leechThreshold'));
  return {
    card: checked,
    entry: toReviewLogEntry(checked, logExtra),
    leechTriggered: !!checked.suspended && !card.suspended,
  };
}

/* =============================================================================
 * 6. RETENTION GATES  (pedagogy-spec §1.6)
 *    mastered → checks at +2d, +7d, +21d → RETAINED (green).
 *    Red / amber / green. The next topic unlocks on MASTERED, not RETAINED.
 * ========================================================================== */

/** Stamp mastery. Idempotent: an already-mastered card is returned unchanged. */
export function markMastered(card, now = null) {
  if (card && card.masteredOn) return card;
  return { ...card, masteredOn: toLocalYMD(now), gates: {} };
}

/** Mastery is the unlock condition for the NEXT topic (RETAINED is not). */
export function isMastered(card) {
  return !!(card && card.masteredOn);
}

/**
 * Record a gate outcome. `day` must be one of 2 | 7 | 21; `result` 'pass'|'fail'.
 * Pure — returns a new card.
 */
export function recordGate(card, day, result, now = null) {
  const d = Math.trunc(asNumber(day, -1) || -1);
  if (!GATE_DAYS.includes(d)) {
    throw new RangeError(`scheduler: gate day must be one of ${GATE_DAYS.join('|')}, got ${day}`);
  }
  if (result !== 'pass' && result !== 'fail') {
    throw new TypeError(`scheduler: gate result must be 'pass' or 'fail', got ${JSON.stringify(result)}`);
  }
  return {
    ...card,
    gates: { ...(card.gates || {}), [String(d)]: { result, on: toLocalYMD(now) } },
  };
}

/** Clear all gate history (used when a failed gate sends a topic back to study). */
export function resetGates(card, { keepMastery = false } = {}) {
  return { ...card, gates: {}, masteredOn: keepMastery ? card.masteredOn : null };
}

/**
 * Retention-gate state for a card (or a topic object carrying masteredOn/gates).
 *
 * @returns {{
 *   masteredOn:string|null, retained:boolean, tone:'red'|'amber'|'green',
 *   status:'NOT_MASTERED'|'IN_PROGRESS'|'CHECK_DUE'|'FAILED'|'RETAINED',
 *   gates:Array<{day:number, dueOn:string, status:'pending'|'due'|'passed'|'failed',
 *                overdueDays:number, on:string|null}>,
 *   nextGate:{day:number, dueOn:string, daysAway:number}|null,
 *   passed:number, unlocksNextTopic:boolean
 * }}
 */
export function gateChecks(card, now = null) {
  const today = toLocalYMD(now);
  const masteredOn = (card && parseLocalDate(card.masteredOn)) ? card.masteredOn : null;
  if (!masteredOn) {
    return {
      masteredOn: null, retained: false, tone: 'red', status: 'NOT_MASTERED',
      gates: GATE_DAYS.map((day) => ({
        day, dueOn: null, status: 'pending', overdueDays: 0, on: null,
      })),
      nextGate: null, passed: 0, unlocksNextTopic: false,
    };
  }
  const recorded = (card && card.gates) || {};
  const gates = GATE_DAYS.map((day) => {
    const dueOn = addDays(masteredOn, day);
    const rec = recorded[String(day)] || null;
    const res = rec && rec.result;
    let status;
    if (res === 'pass') status = 'passed';
    else if (res === 'fail') status = 'failed';
    else status = cmpDate(dueOn, today) <= 0 ? 'due' : 'pending';
    return {
      day, dueOn, status,
      overdueDays: Math.max(0, daysBetween(dueOn, today) || 0),
      on: rec ? rec.on : null,
    };
  });

  const passed = gates.filter((g) => g.status === 'passed').length;
  const failed = gates.some((g) => g.status === 'failed');
  const anyDue = gates.some((g) => g.status === 'due');

  let status, tone;
  if (failed) { status = 'FAILED'; tone = 'red'; }
  else if (passed === GATE_DAYS.length) { status = 'RETAINED'; tone = 'green'; }
  else if (anyDue) { status = 'CHECK_DUE'; tone = 'amber'; }
  else { status = 'IN_PROGRESS'; tone = 'amber'; }

  const pending = gates.find((g) => g.status === 'due' || g.status === 'pending') || null;
  return {
    masteredOn,
    retained: status === 'RETAINED',
    tone,
    status,
    gates,
    nextGate: pending
      ? { day: pending.day, dueOn: pending.dueOn, daysAway: daysBetween(today, pending.dueOn) }
      : null,
    passed,
    unlocksNextTopic: true,   // MASTERED is the unlock, not RETAINED
  };
}

/** Every card/topic whose retention check is due today or overdue. */
export function gatesDue(cards, now = null) {
  const today = toLocalYMD(now);
  const out = [];
  for (const c of cards || []) {
    const g = gateChecks(c, today);
    if (g.status === 'CHECK_DUE') out.push({ card: c, gate: g });
  }
  return out.sort((a, b) => (b.gate.gates.reduce((m, x) => Math.max(m, x.overdueDays), 0)
    - a.gate.gates.reduce((m, x) => Math.max(m, x.overdueDays), 0)));
}

/* =============================================================================
 * 7. RETENTION METRICS  (build-constraints §9.9, engram.py:3366-3415)
 *    "retention metrics exclude grades within 0-3d of first exposure" —
 *    a sub-4-day retrieval is re-encoding, not evidence anything was retained.
 * ========================================================================== */

/** Which RETENTION_BUCKETS bucket a days-since-encode value lands in. */
export function bucketOf(daysSinceEncode) {
  const d = asNumber(daysSinceEncode);
  if (d === null || d < 0) return null;
  for (const b of RETENTION_BUCKETS) if (d >= b.lo && d <= b.hi) return b.name;
  return null;
}

/**
 * Does this review-log entry count toward a retention claim?
 * FALSE for anything within 0–3 days of first exposure (build-constraints §9.9).
 * @param {{days_since_encode?:number, daysSinceEncode?:number}} entry
 */
export function isRetentionEligible(entry) {
  const d = asNumber(entry && (entry.days_since_encode ?? entry.daysSinceEncode));
  return d !== null && d > RETENTION_EARLY_MAX_DAYS;
}

/** engram.py:3404-3408 — trust an explicit grade, else derive it from the rating. */
export function gradeOf(entry) {
  const g = entry && entry.grade;
  if (typeof g === 'string' && GRADES.includes(g)) return g;
  const r = entry && entry.rating;
  return (typeof r === 'string' && GRADE_OF_RATING[r]) ? GRADE_OF_RATING[r] : null;
}

/**
 * THE NORTH STAR. Retention bucketed by each review's OWN days-since-encode
 * (engram.py:3374-3415), with the 0–3 d bucket reported but NEVER pooled.
 *
 * rate = (recalled + partial) / n, rounded to 3 dp — engram.py:3415 exactly.
 *
 * @param {Array<object>} entries review-log lines (toReviewLogEntry shape)
 * @returns {{
 *   buckets:Object<string,{recalled,partial,lapsed,n,rate}>,
 *   headline:{bucket:string, rate:number|null, n:number},
 *   pooled:{n:number, recalled:number, partial:number, lapsed:number, rate:number|null},
 *   excludedEarly:number, total:number, bucketed:number, read:string
 * }}
 */
export function retentionStats(entries) {
  const buckets = {};
  for (const b of RETENTION_BUCKETS) {
    buckets[b.name] = { recalled: 0, partial: 0, lapsed: 0, n: 0, rate: null };
  }
  let total = 0, bucketed = 0;
  for (const e of entries || []) {
    total += 1;
    const name = bucketOf(e.days_since_encode ?? e.daysSinceEncode);
    if (!name) continue;
    const b = buckets[name];
    const g = gradeOf(e);
    if (g) b[g] += 1;
    b.n += 1;
    bucketed += 1;
  }
  for (const b of Object.values(buckets)) {
    if (b.n) b.rate = pyRound((b.recalled + b.partial) / b.n, 3);
  }

  const pooled = { n: 0, recalled: 0, partial: 0, lapsed: 0, rate: null };
  for (const spec of RETENTION_BUCKETS) {
    if (!spec.pooled) continue;
    const b = buckets[spec.name];
    pooled.n += b.n; pooled.recalled += b.recalled;
    pooled.partial += b.partial; pooled.lapsed += b.lapsed;
  }
  if (pooled.n) pooled.rate = pyRound((pooled.recalled + pooled.partial) / pooled.n, 3);

  const head = buckets[RETENTION_HEADLINE_BUCKET];
  let read;
  if (head.n) read = `30-day recall ${Math.round(head.rate * 100)}% (n=${head.n})`;
  else if (pooled.n) {
    read = `measured over ${pooled.n} retrieval${pooled.n === 1 ? '' : 's'}`
      + ' — none yet at the 30-day mark';
  } else read = 'insufficient-data (no reviews past the 3-day re-encoding window yet)';

  return {
    buckets,
    headline: { bucket: RETENTION_HEADLINE_BUCKET, rate: head.rate, n: head.n },
    pooled,
    excludedEarly: buckets.early.n,
    total,
    bucketed,
    read,
  };
}

/**
 * Mean current retrievability across a set of cards — engram.py:3802-3819.
 * Each card is read from ITS OWN curve, never reconstructed from the interval
 * (which errs toward overstating decay, the one direction an honesty feature is
 * not allowed to err in).
 * @returns {number|null} null when nothing is measurable
 */
export function meanRetrievability(cards, now = null) {
  const today = toLocalYMD(now);
  const rs = [];
  for (const c of cards || []) {
    const r = retrievability(c, today);
    if (r !== null) rs.push(r);
  }
  if (!rs.length) return null;
  return pyRound(rs.reduce((a, b) => a + b, 0) / rs.length, 4);
}

/**
 * Forecast of daily review load, for the "will tomorrow be brutal?" view.
 * @returns {Array<{date:string, due:number, estMinutes:number}>}
 */
export function forecast(cards, now = null, days = 14, opts = {}) {
  const today = toLocalYMD(now);
  const live = (cards || []).filter((c) => !c.suspended && !isNew(c) && cardDue(c));
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = addDays(today, i);
    // Day 0 absorbs the whole backlog (everything already due); later days are
    // exactly the cards falling due that day.
    const bucket = live.filter((c) => (i === 0 ? cmpDate(cardDue(c), d) <= 0 : cardDue(c) === d));
    const sec = bucket.reduce((a, c) => a + estSecondsFor(c, opts), 0);
    out.push({ date: d, due: bucket.length, estMinutes: pyRound(sec / 60, 1) });
  }
  return out;
}
