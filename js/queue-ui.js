/* =============================================================================
   js/queue-ui.js — the session engine + every shared atom the runners are made
   of. Owner: Job B2 (review session / error book / pretest + prime runners).

   study.js is the screen; this file is everything the screen is made of:
     · the CARD POOL (vault flashcards + user cards) fused with FSRS state,
     · the one write path for a graded retrieval (SRS + append-only review log),
     · commit-before-reveal UI atoms (confidence picker, commit panel, grade row
       carrying the TRUE intervals, elaborated feedback panel),
     · the session clock + the always-visible 90-second escape hatch,
     · the game-layer bridge (lazy, optional — the hub must run without it).

   SPEC
     pedagogy-spec §1.5 RETRIEVE  — commit before reveal, no hover-reveal, to
       criterion, wrong items re-enter after ~5 cards then STOP, every recall
       chased by its paired application item.
     pedagogy-spec §1.6 SPACE     — scheduler.js owns every interval; we only
       display what it computes (build-constraints §9.9).
     pedagogy-spec R5             — immediate + ELABORATED feedback on daily
       practice; never a bare red X.
     pedagogy-spec R10            — cards auto-rated where machine-checkable,
       two-button override only; ONE effort slider per session, never per item.
     pedagogy-spec R8/§4          — attendance streak; 90-second session floor
       always one tap away and it always counts.
     build-constraints §5         — a × 10ⁿ only, no CS analogies, units on every
       quantity. §9.1 local dates only. §10 tokens only, no raw hexes.

   RULES OBSERVED
     · store API only (never raw localStorage); all day maths via store helpers.
     · no innerHTML — text via el({text}), markdown via dom.md()/mdInline().
     · every animation gated on prefersReducedMotion().
   ========================================================================== */

import { store, KEYS, todayLocalISO, uid, dayKeyFromTs, diffDaysISO } from './store.js';
import { getSettings } from './config.js';
import { getTopics, getTopic, onVaultChange } from './vault.js';
import {
  initCard, isNew, gradePreview, rateCard, srsTone, queueMeta,
  formatIntervalDays, buildSession, toLocalYMD, LEECH_THRESHOLD,
} from './scheduler.js';
import {
  el, icon, fmt, md, mdInline, prefersReducedMotion, haptic, sound, clamp,
} from './dom.js';

/* =============================================================================
   0. CONSTANTS
   ========================================================================== */

/** A session counts as a night once EITHER floor is met (pedagogy-spec R12). */
export const SESSION_FLOOR_SECONDS = 90;
export const SESSION_FLOOR_CARDS = 5;

/** Wrong items come back after roughly this many intervening cards (§1.5). */
export const RELEARN_GAP = 5;

/** Retrieve to criterion, then STOP — no massed drilling past it (§1.5). */
export const RELEARN_MAX_ATTEMPTS = 3;

/** Confidence at or above this on a WRONG answer = hypercorrection priority. */
export const CONFIDENT_THRESHOLD = 4;

/** A correct answer faster than this, at high confidence, suggests Easy. */
export const FAST_CORRECT_MS = 8000;

/** Under this, a wrong answer was a guess, not a retrieval (§3.5). */
export const GUESS_MS = 2500;

/** Successive-relearning milestone that is actually shown (§1.5). */
export const RELEARN_MILESTONE = 3;

/** Our own namespaced store keys (KEYS.* has no slot for these). */
export const SESSION_KEY = 'studySession';      // resumable in-flight session
export const REFLECT_KEY = 'studyReflect';      // effort + takeaway, by day
export const PRIME_KEY = 'primeLog';            // versioned priming hypotheses

const CONFIDENCE_LABELS = {
  1: 'No idea',
  2: 'Shaky',
  3: 'Think so',
  4: 'Fairly sure',
  5: 'Certain',
};

/* =============================================================================
   1. GAME BRIDGE — lazy, optional, never fatal
   Job C owns js/game.js. It may not exist yet (or the feature flag may be off);
   a study session must still run and still write its review log.
   ========================================================================== */

let gameModule = null;
let gamePromise = null;

function loadGame() {
  if (gamePromise) return gamePromise;
  gamePromise = import('./game.js')
    .then((m) => { gameModule = (m && (m.default || m)) || null; return gameModule; })
    .catch(() => { gameModule = null; return null; });
  return gamePromise;
}

function callGame(fn, ...args) {
  const run = (mod) => {
    if (!mod || typeof mod[fn] !== 'function') return null;
    try { return mod[fn](...args); } catch (err) { console.warn('[queue-ui] game.' + fn + ' failed', err); return null; }
  };
  if (gameModule) return run(gameModule);
  loadGame().then(run);
  return null;
}

/** Warm the game module so the first recordActivity is not a cold import. */
export function warmGame() { return loadGame(); }

/**
 * game.recordActivity('review'|'encode'|'drill', meta) — no-op without game.js.
 * ONE call per graded retrieval. game.js owns the ring, the XP for that attempt
 * (wrong answers included) and the attendance touch — never award XP here as
 * well, or the same attempt is paid for twice.
 * Do NOT pass `seconds`: the session's wall clock is reported once, by
 * recordSession() at the end.
 */
export function recordActivity(kind, meta) { return callGame('recordActivity', kind, meta || {}); }

/**
 * game.recordSession({seconds, source}) — attendance only, no ring, no fake
 * review. This is what the 90-second escape hatch and the end screen call.
 */
export function recordSession(meta) { return callGame('recordSession', meta || {}); }

/** game.awardXP(n, reason) — only for things recordActivity does not already pay. */
export function awardXP(n, reason) { return callGame('awardXP', n, reason); }

/* =============================================================================
   2. CARD POOL — vault + user cards fused with FSRS state
   ========================================================================== */

const SUBJECT_SLUGS = {
  physics: 'physics',
  chemistry: 'chemistry',
  chem: 'chemistry',
  maths: 'maths',
  math: 'math',
  mathematics: 'mathematics',
  cs: 'cs',
  'computer science': 'computer-science',
  'computer-science': 'computer-science',
  english: 'english',
  nepali: 'nepali',
};

/** Subject → the [data-subject] value theme.css re-points --accent on. */
export function subjectSlug(subject) {
  const k = String(subject || '').trim().toLowerCase();
  return SUBJECT_SLUGS[k] || k.replace(/\s+/g, '-');
}

/** Fields that belong to the SRS record. Content NEVER goes into KEYS.SRS. */
const PERSIST_FIELDS = [
  'id', 'topic', 'subject', 'unit',
  'stability', 'difficulty', 'due', 'last', 'reps', 'lapses', 'state', 'introducedOn',
  'suspended', 'leech', 'masteredOn', 'gates',
  'relearnSessions', 'lastCriterionDay', 'rewriteRequested',
];

/** Strip a live card down to what KEYS.SRS stores (no q/a, no `review` block). */
export function persistableCard(card) {
  const out = {};
  for (const k of PERSIST_FIELDS) {
    if (card[k] !== undefined) out[k] = card[k];
  }
  return out;
}

function firstOf(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

/**
 * Normalise whatever teaching metadata the generator shipped alongside a card.
 * vault.js keeps flashcards to {id,q,a,source,type}; anything richer survives on
 * the raw topic, so we read it from there. Every key is optional.
 * @returns {{type,cognitive,problemType,explanation,distractorRationale,options,
 *            accept,solutionChain,misconceptionTags,pairedId,appliesTo,unit,hint}}
 */
export function normalizeCardMeta(raw, card) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const optionsRaw = firstOf(r, ['options', 'choices']);
  const options = Array.isArray(optionsRaw)
    ? optionsRaw.map((o) => (typeof o === 'string' ? { text: o } : {
      text: String((o && (o.text || o.label || o.option)) || ''),
      correct: !!(o && (o.correct === true || o.isCorrect === true)),
      rationale: String((o && (o.rationale || o.why || o.distractorRationale)) || '') || null,
    })).filter((o) => o.text)
    : null;

  let correctIndex = -1;
  const answerIdx = firstOf(r, ['answerIndex', 'answer_index', 'correctIndex']);
  if (answerIdx !== null && Number.isInteger(Number(answerIdx))) correctIndex = Number(answerIdx);
  if (options && correctIndex < 0) correctIndex = options.findIndex((o) => o.correct);

  const chainRaw = firstOf(r, ['solutionChain', 'solution_chain', 'steps']);
  const solutionChain = Array.isArray(chainRaw)
    ? chainRaw.map((s) => (typeof s === 'string'
      ? { statement: s, justification: '' }
      : {
        statement: String((s && (s.statement || s.step || s.text)) || ''),
        justification: String((s && (s.justification || s.why || s.reason)) || ''),
        formulaTeX: (s && (s.formulaTeX || s.formula)) ? String(s.formulaTeX || s.formula) : null,
      })).filter((s) => s.statement)
    : null;

  const acceptRaw = firstOf(r, ['accept', 'answerKey', 'answer_key', 'acceptedAnswers']);
  const accept = acceptRaw
    ? (Array.isArray(acceptRaw) ? acceptRaw.map(String) : [String(acceptRaw)])
    : null;

  const tagsRaw = firstOf(r, ['misconceptionTags', 'misconception_tags', 'misconceptions']);

  return {
    type: String(firstOf(r, ['type']) || (card && card.type) || '').toLowerCase(),
    cognitive: String(firstOf(r, ['cognitive', 'level']) || '').toLowerCase(),
    problemType: firstOf(r, ['problemType', 'problem_type']),
    explanation: firstOf(r, ['explanation', 'why', 'elaboration']),
    distractorRationale: firstOf(r, ['distractorRationale', 'distractor_rationale']),
    options,
    correctIndex,
    accept,
    solutionChain,
    misconceptionTags: Array.isArray(tagsRaw) ? tagsRaw.map(String) : [],
    pairedId: firstOf(r, ['pairedId', 'paired_id', 'applicationId', 'application_id']),
    appliesTo: firstOf(r, ['appliesTo', 'applies_to', 'applicationOf']),
    unit: firstOf(r, ['unit']),
    hint: firstOf(r, ['hint']),
    lessonUrl: firstOf(r, ['lesson', 'lessonUrl', 'source_url']),
  };
}

/** cardId → {q, a, topicId, topicName, subject, unit, meta} for the whole vault. */
let contentCache = null;
let contentCacheStamp = 0;
/** Prompts that exist for one session only (authored pretest questions). */
const transientContent = new Map();

function buildContent() {
  const map = new Map();
  for (const t of getTopics()) {
    const raws = (t.raw && Array.isArray(t.raw.flashcards)) ? t.raw.flashcards : [];
    const rawById = new Map(raws.map((c) => [String(c && c.id), c]));
    for (const c of t.flashcards) {
      map.set(c.id, {
        id: c.id,
        q: c.q,
        a: c.a,
        source: c.source,
        topicId: t.id,
        topicName: t.name,
        subject: t.subject,
        unit: t.unit,
        meta: normalizeCardMeta(rawById.get(c.id), c),
      });
    }
  }
  // Cards he made himself (KEYS.USER_CARDS: topicId -> [{id,q,a,...}]).
  const user = store.get(KEYS.USER_CARDS, {}) || {};
  for (const [topicId, list] of Object.entries(user)) {
    if (!Array.isArray(list)) continue;
    const t = getTopic(topicId);
    for (const c of list) {
      const id = String((c && c.id) || '');
      if (!id || !c || !c.q) continue;
      map.set(id, {
        id,
        q: String(c.q),
        a: String(c.a || ''),
        source: 'own',
        topicId: t ? t.id : String(topicId),
        topicName: t ? t.name : String(c.topicName || topicId),
        subject: t ? t.subject : String(c.subject || 'General'),
        unit: t ? t.unit : '',
        meta: normalizeCardMeta(c, c),
        user: true,
      });
    }
  }
  return map;
}

/** Invalidate the content cache (vault reload, deck import, new user card). */
export function invalidatePool() { contentCache = null; }

/* A re-synced vault or a card he just wrote must be in tonight's pool without a
   reload. The topic-count stamp alone cannot see either. */
try {
  onVaultChange(invalidatePool);
  store.subscribe(KEYS.USER_CARDS, invalidatePool);
} catch (_) { /* non-fatal: the stamp still catches topic-count changes */ }

function contentMap() {
  const stamp = getTopics().length;
  if (!contentCache || contentCacheStamp !== stamp) {
    contentCache = buildContent();
    contentCacheStamp = stamp;
    for (const [id, entry] of transientContent) contentCache.set(id, entry);
  }
  return contentCache;
}

/**
 * Register a prompt that has no vault card behind it — authored pretest
 * questions (§1.0), which are never scheduled and never scored.
 * @param {{id:string,q:string,a:string,topicId?:string,topicName?:string,
 *          subject?:string,unit?:string,explanation?:string}} entry
 */
export function registerTransientContent(entry) {
  const row = {
    id: String(entry.id),
    q: String(entry.q || ''),
    a: String(entry.a || ''),
    source: 'authored',
    topicId: String(entry.topicId || ''),
    topicName: String(entry.topicName || ''),
    subject: String(entry.subject || 'General'),
    unit: String(entry.unit || ''),
    meta: normalizeCardMeta(entry, entry),
    transient: true,
  };
  transientContent.set(row.id, row);
  contentMap().set(row.id, row);
  return row;
}

/** Question / answer / teaching metadata for one card id. */
export function cardContent(cardId) { return contentMap().get(String(cardId)) || null; }

/** Just the teaching metadata (explanation, options, solutionChain, …). */
export function cardMeta(cardId) {
  const c = cardContent(cardId);
  return c ? c.meta : normalizeCardMeta(null, null);
}

/**
 * Every studiable card, as a scheduler card fused with its saved FSRS state.
 * Content is deliberately NOT on the card object the scheduler sees beyond the
 * few fields it reads — look content up with cardContent(id).
 * @returns {Array<object>} scheduler cards
 */
export function buildPool() {
  const srs = store.get(KEYS.SRS, {}) || {};
  const suspendedMap = store.get(KEYS.SUSPENDED, {}) || {};
  const out = [];
  for (const c of contentMap().values()) {
    // Authored pretest prompts are session-only: never scheduled, never scored
    // (pedagogy-spec §1.0). They must not surface as "first-time" review cards.
    if (c.transient) continue;
    const saved = (srs && typeof srs[c.id] === 'object' && srs[c.id]) || null;
    const card = initCard(c.id, {
      ...(saved || {}),
      id: c.id,
      topic: c.topicId,
      subject: c.subject,
      unit: c.unit || null,
    });
    delete card.review;
    if (suspendedMap && suspendedMap[c.id]) card.suspended = true;
    out.push(card);
  }
  return out;
}

/** Write a rated card back into KEYS.SRS (content-free). */
export function saveCard(card) {
  store.update(KEYS.SRS, (prev) => {
    const next = (prev && typeof prev === 'object') ? { ...prev } : {};
    next[card.id] = persistableCard(card);
    return next;
  }, {});
  if (card.suspended) {
    store.update(KEYS.SUSPENDED, (prev) => ({ ...(prev || {}), [card.id]: true }), {});
  }
}

/**
 * The exam calendar has been written in three shapes over the build (game.js
 * `normaliseExamList` accepts all three): an array of rows, `{events:[…]}`, or a
 * bare `{Subject:'YYYY-MM-DD'}` map. The scheduler wants exactly the last one,
 * with the NEAREST future paper per subject — that is what drives the §1.6
 * exam ramp (desiredRetention 0.90 → 0.95 across the final 21 days).
 * @returns {Object<string,string>|null}
 */
/* Confidence words that permit the 21-day retention ramp — the union of
   views/settings.js EXAM_CONFIDENCE (high/med ramp) and its CONFIDENCE_ALIASES
   for those two values. Kept inline so the queue engine never imports a view. */
const RAMPING_CONFIDENCE = new Set(['high', 'confirmed', 'certain', 'med', 'medium', 'expected']);

export function examDatesMap(raw) {
  const rows = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray(raw.events)) ? raw.events
      : null;

  if (!rows) {
    // Already a {Subject: date} map?
    if (raw && typeof raw === 'object') {
      const map = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) map[k] = v;
      }
      return Object.keys(map).length ? map : null;
    }
    return null;
  }

  const today = todayLocalISO();
  const out = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const date = typeof row.ad === 'string' ? row.ad
      : (typeof row.date === 'string' ? row.date : null);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // Past papers cannot ramp anything (local day maths, never toISOString).
    if (diffDaysISO(today, date) < 0) continue;
    // Phase B-F stitch: only a date the school actually signalled may raise
    // the retention target. The calendar's owner (views/settings.js
    // EXAM_CONFIDENCE) rules that high/med ramp and low/'estimate' NEVER do —
    // "estimated dates count down but never change your workload". A missing
    // or unrecognised word is read as non-ramping, never as permission.
    const conf = String(row.confidence == null ? '' : row.confidence).trim().toLowerCase();
    if (!RAMPING_CONFIDENCE.has(conf)) continue;
    const subjects = Array.isArray(row.subjects) ? row.subjects
      : (row.subject ? [row.subject] : []);
    for (const s of subjects) {
      const key = String(s || '').trim();
      if (!key) continue;
      if (!out[key] || diffDaysISO(date, out[key]) > 0) out[key] = date;
    }
  }
  if (!Object.keys(out).length) return null;

  // The calendar says "Mathematics"; the vault may say "Maths". desiredRetentionFor
  // looks the subject up VERBATIM, so alias every vault label onto its paper.
  const byKey = new Map(Object.entries(out).map(([label, d]) => [subjectMatchKey(label), d]));
  for (const t of getTopics()) {
    const label = String(t.subject || '').trim();
    if (!label || out[label]) continue;
    const d = byKey.get(subjectMatchKey(label));
    if (d) out[label] = d;
  }
  return out;
}

/** Coarse subject identity for calendar↔vault matching (maths = mathematics). */
function subjectMatchKey(s) {
  const k = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (k === 'maths' || k === 'mathematics' || k === 'math') return 'math';
  if (k === 'chem' || k === 'chemistry') return 'chem';
  if (k === 'cs' || k === 'computerscience' || k === 'computer') return 'cs';
  if (k === 'phy' || k === 'physics') return 'physics';
  return k;
}

/** Options for scheduler calls, from the student's own settings. */
export function schedulerOpts(extra) {
  const s = getSettings();
  const budget = Number(s.dailyMinutes);
  return {
    timeBudgetMin: Number.isFinite(budget) && budget > 0 ? budget : 25,
    examDates: examDatesMap(store.get('examCalendar', null)),
    ...(extra || {}),
  };
}

/* =============================================================================
   3. ANSWER CHECKING  (machine-check only where it is HONEST to do so)
   ========================================================================== */

const SUP_TO_DIGIT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };
const SUB_TO_DIGIT = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₋': '-', '₊': '+' };

/** Loose-but-honest normalisation for comparing two short answers. */
export function normalizeAnswer(s) {
  return String(s == null ? '' : s)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/g, (c) => SUP_TO_DIGIT[c] || c)
    .replace(/[₀₁₂₃₄₅₆₇₈₉₋₊]/g, (c) => SUB_TO_DIGIT[c] || c)
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}.\-+/x]+/gu, '')
    .trim();
}

/**
 * Can this answer be graded by machine, and was it right?
 * Returns {machine, correct, chosenIndex, chosenText}.
 *   machine=false → the runner asks HIM (self-report), never guesses.
 * A free-text answer is only ever auto-marked CORRECT on an exact normalised
 * match; it is never auto-marked wrong (a paraphrase is not a miss).
 */
export function checkAnswer(given, content, chosenIndex) {
  const meta = (content && content.meta) || {};
  if (meta.options && meta.options.length && Number.isInteger(chosenIndex) && chosenIndex >= 0) {
    const known = meta.correctIndex >= 0;
    return {
      machine: known,
      correct: known ? chosenIndex === meta.correctIndex : null,
      chosenIndex,
      chosenText: (meta.options[chosenIndex] || {}).text || '',
    };
  }
  const typed = normalizeAnswer(given);
  if (!typed) return { machine: false, correct: null, chosenIndex: -1, chosenText: '' };

  const keys = [];
  if (meta.accept) keys.push(...meta.accept);
  const answer = String((content && content.a) || '');
  if (answer && answer.length <= 40) keys.push(answer);

  for (const k of keys) {
    const nk = normalizeAnswer(k);
    if (nk && nk === typed) return { machine: true, correct: true, chosenIndex: -1, chosenText: given };
  }
  // An accept-list is a closed key: a miss against it IS a miss.
  if (meta.accept && meta.accept.length) {
    return { machine: true, correct: false, chosenIndex: -1, chosenText: given };
  }
  return { machine: false, correct: null, chosenIndex: -1, chosenText: given };
}

/**
 * THE ONE MISSING STEP — the Error Book's most valuable field (§2 Tier 0).
 * Prefers the first SolutionChain step whose key term is absent from his answer;
 * falls back to the explanation's first sentence, then the answer's.
 */
export function pickMissingStep(content, given) {
  const meta = (content && content.meta) || {};
  const typed = normalizeAnswer(given);
  if (meta.solutionChain && meta.solutionChain.length) {
    for (const step of meta.solutionChain) {
      const tokens = String(step.statement).split(/\s+/)
        .map(normalizeAnswer)
        .filter((t) => t.length >= 4);
      const covered = tokens.length
        ? tokens.filter((t) => typed.includes(t)).length / tokens.length
        : 1;
      if (covered < 0.5) {
        return step.justification
          ? step.statement + ' — ' + step.justification
          : step.statement;
      }
    }
    const last = meta.solutionChain[meta.solutionChain.length - 1];
    return last.statement;
  }
  const src = String(meta.explanation || (content && content.a) || '').trim();
  if (!src) return '';
  const firstSentence = src.split(/(?<=[.!?])\s+/)[0] || src;
  return fmt.truncate(firstSentence, 180);
}

/**
 * The auto-rating (pedagogy-spec R10): correct→good, wrong→again, fast+confident
 * correct→easy. Hard/Easy stay one tap away as the override.
 * @returns {{rating:'again'|'hard'|'good'|'easy', reason:string, guess:boolean}}
 */
export function autoRating({ correct, elapsedMs, confidence }) {
  if (!correct) {
    const guess = elapsedMs > 0 && elapsedMs < GUESS_MS;
    return {
      rating: 'again',
      reason: guess
        ? 'Answered in ' + fmt.num(elapsedMs / 1000, 1) + ' s — that is a guess, not a retrieval.'
        : 'Missed — this one comes back inside this session.',
      guess,
    };
  }
  if (elapsedMs > 0 && elapsedMs <= FAST_CORRECT_MS && Number(confidence) >= 4) {
    return {
      rating: 'easy',
      reason: 'Correct in ' + fmt.num(elapsedMs / 1000, 1) + ' s at high confidence — that earns the long interval.',
      guess: false,
    };
  }
  return { rating: 'good', reason: 'Correct — held at the scheduled interval.', guess: false };
}

/* =============================================================================
   4. THE WRITE PATH — one graded retrieval, everywhere
   ========================================================================== */

/**
 * Apply a rating: FSRS state (unless probe) + the append-only review log.
 * EVERY retrieval goes through here, including wrong ones and probes.
 *
 * @param {object} args
 * @param {object} args.card       scheduler card from buildPool()
 * @param {string} args.rating     'again'|'hard'|'good'|'easy'
 * @param {number|null} args.confidence  1-5, PICKED, never inferred
 * @param {number} args.elapsedMs
 * @param {string} [args.kind]     'review'|'encode'|'pretest'|'transfer'|'audit'
 * @param {boolean} [args.probe]   true = criterion re-check / pretest: LOGGED but
 *                                 FSRS state is left alone (one rating per card
 *                                 per session is the honest measure)
 * @param {string} [args.grade]    'recalled'|'partial'|'lapsed'
 * @param {string} [args.errorClass] 'slip'|'conceptual'
 * @param {string} [args.production] his typed answer (≤800 chars, engram cap)
 * @param {boolean} [args.criterion] true when this retrieval reached criterion
 * @returns {{card:object, entry:object|null, leechTriggered:boolean, preview:Array}}
 */
export function applyGrade(args) {
  const {
    card, rating, confidence = null, elapsedMs = 0,
    kind = 'review', probe = false, grade = null, errorClass = null,
    production = null, criterion = false, source = 'hub',
  } = args;
  const today = todayLocalISO();
  const opts = schedulerOpts();

  if (probe) {
    const entry = store.appendReviewLog({
      cardId: card.id,
      topic: card.topic,
      node: card.id,
      rating,
      confidence,
      elapsedMs,
      kind,
      grade,
      errorClass,
      probe: true,
      source,
    });
    return { card, entry, leechTriggered: false, preview: [] };
  }

  const res = rateCard(card, rating, today, opts, {
    confidence,
    kind,
    grade: grade || undefined,
    error_class: errorClass || undefined,
    production: production ? String(production).slice(0, 800) : undefined,
    source,
  });

  let next = res.card;
  if (criterion && next.lastCriterionDay !== today) {
    next = {
      ...next,
      relearnSessions: (Number(next.relearnSessions) || 0) + 1,
      lastCriterionDay: today,
    };
  }
  saveCard(next);

  const entry = store.appendReviewLog({
    cardId: card.id,
    topic: card.topic,
    node: card.id,
    rating,
    confidence,
    elapsedMs,
    kind,
    grade: grade || res.entry.grade,
    errorClass,
    probe: false,
    source,
  });

  return { card: next, entry, leechTriggered: res.leechTriggered, preview: [] };
}

/** Un-suspend a leech once it has been rewritten with Hermes (pedagogy R12). */
export function clearRewrite(cardId) {
  store.update(KEYS.SUSPENDED, (prev) => {
    const next = { ...(prev || {}) };
    delete next[cardId];
    return next;
  }, {});
  store.update(KEYS.SRS, (prev) => {
    const next = { ...(prev || {}) };
    if (next[cardId]) next[cardId] = { ...next[cardId], suspended: false, leech: false, rewriteRequested: false, lapses: 0 };
    return next;
  }, {});
}

/* =============================================================================
   5. SESSION CLOCK + the 90-second escape hatch
   ========================================================================== */

/** Wall clock for a session, pausing while the tab is hidden. */
export class SessionClock {
  constructor(seedMs) {
    this.accumulated = Math.max(0, Number(seedMs) || 0);
    this.startedAt = Date.now();
    this.running = true;
    this._onVis = () => {
      if (document.hidden) this.pause();
      else this.resume();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  pause() {
    if (!this.running) return;
    this.accumulated += Date.now() - this.startedAt;
    this.running = false;
  }

  resume() {
    if (this.running) return;
    this.startedAt = Date.now();
    this.running = true;
  }

  elapsedMs() {
    return this.accumulated + (this.running ? Date.now() - this.startedAt : 0);
  }

  elapsedSec() { return Math.round(this.elapsedMs() / 1000); }

  dispose() {
    this.pause();
    document.removeEventListener('visibilitychange', this._onVis);
  }
}

/**
 * The escape hatch — ALWAYS visible, always one tap, and it always counts once
 * the 90-second (or 5-card) floor is met (pedagogy-spec §1.7 / R8).
 * @param {{onBank:Function, getState:()=>({sec:number, cards:number})}} o
 */
export function escapeHatch(o) {
  const label = el('span', { text: 'Bank the streak' });
  const meta = el('span.mono', { style: { fontSize: 'var(--fs-micro)', opacity: '0.8' }, text: '0:00' });
  const btn = el('button.btn.btn-secondary.btn--sm', {
    type: 'button',
    attrs: { 'aria-label': 'End the session now and bank the night' },
    onClick: () => o.onBank(),
  }, icon('flame', { size: 14 }), label, meta);

  const node = el('div.row', { style: { gap: 'var(--sp-2)' } }, btn);

  function tick() {
    const s = o.getState();
    const floorMet = s.sec >= SESSION_FLOOR_SECONDS || s.cards >= SESSION_FLOOR_CARDS;
    meta.textContent = fmt.clock(s.sec);
    btn.dataset.tone = floorMet ? 'good' : 'neutral';
    btn.classList.toggle('btn-outline', floorMet);
    btn.classList.toggle('btn-secondary', !floorMet);
    btn.setAttribute('title', floorMet
      ? 'This session already counts as a night. Stop whenever you want.'
      : 'Bank now — ' + Math.max(0, SESSION_FLOOR_SECONDS - s.sec) + ' s or '
        + Math.max(0, SESSION_FLOOR_CARDS - s.cards) + ' more cards makes it a full night.');
  }

  tick();
  const timer = setInterval(tick, 1000);
  return { node, tick, dispose: () => clearInterval(timer) };
}

/* =============================================================================
   6. UI ATOMS — commit before reveal
   ========================================================================== */

/**
 * Confidence 1-5, picked BEFORE submit. Never inferred, never defaulted
 * (engine invariant 6 + pedagogy-spec Tier 0).
 * @param {{onPick:(n:number)=>void}} o
 */
export function confidencePicker(o) {
  let value = null;
  const btns = [];
  const group = el('div.segmented', {
    attrs: { role: 'radiogroup', 'aria-label': 'How sure are you, before you answer?' },
  });
  for (let n = 1; n <= 5; n += 1) {
    const b = el('button.segmented__btn', {
      type: 'button',
      attrs: { role: 'radio', 'aria-checked': 'false', 'aria-label': n + ' — ' + CONFIDENCE_LABELS[n] },
      dataset: { conf: String(n) },
      style: { flex: '1 1 0' },
      onClick: () => set(n),
    }, el('span.mono', { text: String(n) }));
    btns.push(b);
    group.appendChild(b);
  }
  const hint = el('p.hint', { text: 'Pick before you answer — this is what finds the ones that bite you.' });

  function set(n) {
    value = n;
    btns.forEach((b, i) => {
      const on = i + 1 === n;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    hint.textContent = n + ' · ' + CONFIDENCE_LABELS[n];
    haptic('select');
    if (o && o.onPick) o.onPick(n);
  }

  const node = el('div.field', { style: { marginBottom: '0' } },
    el('span.label', { text: 'Confidence' }),
    group,
    hint);

  return { node, get: () => value, set, focus: () => btns[2].focus() };
}

/**
 * The commit panel: typed answer, MCQ selection, or a mental-commit tap.
 * There is NO hover-reveal and no "peek" — the answer is not in the DOM yet.
 * @param {{content:object, onChange:Function, onSubmit:Function}} o
 */
export function commitPanel(o) {
  const meta = (o.content && o.content.meta) || {};
  let committed = false;
  let chosenIndex = -1;
  let typed = '';

  const node = el('div.stack', { style: { '--gap': 'var(--sp-3)' } });

  const change = () => { if (o.onChange) o.onChange(state()); };
  const state = () => ({ committed, chosenIndex, typed });
  /** Freeze the commitment once the answer is out — set by each branch below. */
  let lock = () => {};

  if (meta.options && meta.options.length) {
    const list = el('div.stack', { style: { '--gap': 'var(--sp-2)' }, attrs: { role: 'radiogroup', 'aria-label': 'Choose one' } });
    meta.options.forEach((opt, i) => {
      const key = el('span.option__key', { text: String.fromCharCode(65 + i) });
      const text = el('span');
      mdInline(text, opt.text);
      const b = el('button.option', {
        type: 'button',
        attrs: { role: 'radio', 'aria-checked': 'false' },
        onClick: () => {
          chosenIndex = i;
          committed = true;
          for (const other of list.children) {
            other.classList.remove('is-selected');
            other.setAttribute('aria-checked', 'false');
          }
          b.classList.add('is-selected');
          b.setAttribute('aria-checked', 'true');
          haptic('select');
          change();
        },
      }, key, text);
      list.appendChild(b);
    });
    node.appendChild(list);
    lock = () => {
      const known = Number.isInteger(meta.correctIndex) && meta.correctIndex >= 0;
      Array.from(list.children).forEach((b, i) => {
        b.disabled = true;
        if (known && i === meta.correctIndex) b.classList.add('is-correct');
        else if (i === chosenIndex && known) b.classList.add('is-wrong');
      });
    };
  } else {
    const input = el('textarea.textarea', {
      rows: 3,
      placeholder: 'Write the answer — even one line. Committing is what makes it stick.',
      attrs: { 'aria-label': 'Your answer' },
      on: {
        input: () => {
          typed = input.value;
          committed = typed.trim().length > 0;
          change();
        },
      },
    });
    const mental = el('button.btn.btn-ghost.btn--sm', {
      type: 'button',
      onClick: () => {
        committed = true;
        mental.classList.add('is-active');
        mental.dataset.tone = 'good';
        haptic('tap');
        change();
      },
    }, icon('brain', { size: 14 }), 'I said it out loud — reveal');
    node.appendChild(input);
    node.appendChild(el('div.row.row--between', { style: { flexWrap: 'wrap' } },
      el('span.hint', { text: 'No peeking: the answer only appears after you commit.' }),
      mental));
    node.__input = input;
    lock = () => {
      input.readOnly = true;
      input.setAttribute('aria-readonly', 'true');
      mental.disabled = true;
    };
  }

  return {
    node,
    state,
    isCommitted: () => committed,
    focus: () => { if (node.__input) node.__input.focus(); },
    /** Once the answer is revealed the commitment is frozen — no re-picking. */
    lock: () => lock(),
  };
}

/**
 * The four grade buttons, each showing the interval the scheduler WILL apply
 * (build-constraints §9.9). The auto-rating is highlighted; Hard/Easy are the
 * two-button override (pedagogy-spec R10).
 * @param {{card:object, suggested:string, onGrade:(rating:string)=>void}} o
 */
export function gradeRow(o) {
  const previews = gradePreview(o.card, todayLocalISO(), schedulerOpts());
  const row = el('div.grade-row');
  const LABEL = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
  for (const p of previews) {
    const isSuggested = p.rating === o.suggested;
    const b = el('button.btn.btn-grade', {
      type: 'button',
      class: 'btn-grade--' + p.rating,
      dataset: { rating: p.rating, suggested: isSuggested ? 'true' : 'false' },
      style: isSuggested ? { borderColor: 'rgb(var(--accent-rgb) / 0.75)', background: 'rgb(var(--accent-rgb) / 0.2)' } : null,
      attrs: { 'aria-label': LABEL[p.rating] + ' — next in ' + p.label },
      onClick: () => o.onGrade(p.rating),
    },
    el('span.btn-grade__label', { text: LABEL[p.rating] }),
    el('span.btn-grade__interval', { text: p.label }));
    row.appendChild(b);
  }
  return {
    node: el('div.stack', { style: { '--gap': 'var(--sp-2)' } },
      row,
      el('p.hint', {
        text: o.suggested
          ? 'Auto-rated ' + LABEL[o.suggested] + '. Tap Hard or Easy if it felt different — the day counts are real.'
          : 'Each button shows the real next interval.',
      })),
    focusSuggested: () => {
      const b = row.querySelector('[data-suggested="true"]');
      if (b) b.focus();
    },
  };
}

/**
 * ELABORATED feedback — never a bare wrong (pedagogy-spec R5).
 * @param {{content:object, correct:boolean|null, given:string, chosenIndex:number,
 *          missingStep:string, autoReason:string, confidence:number|null}} o
 */
export function feedbackPanel(o) {
  const content = o.content || {};
  const meta = content.meta || {};
  const wrong = o.correct === false;
  const confidentWrong = wrong && Number(o.confidence) >= CONFIDENT_THRESHOLD;

  const card = el('section.card.card--tone', {
    dataset: { tone: wrong ? 'bad' : 'good' },
    style: { marginTop: 'var(--sp-3)' },
  });

  /* Decided BEFORE the headline is written. The heading used to promise "here
     is the step that was missing" unconditionally, while the step block below
     renders only when a real chain or explanation exists — so a self-reported
     miss on a card with neither showed a heading naming a step that was never
     printed. A broken promise on a wrong answer is worse than a plain one. */
  const hasStepSource = !!((meta.solutionChain && meta.solutionChain.length) || meta.explanation);
  const showsMissingStep = !!(o.missingStep && wrong && hasStepSource);
  const answerIsInThisCard = o.showAnswer !== false;

  let headline;
  if (o.correct === null) headline = 'Here is the answer';
  else if (!wrong) headline = 'Held';
  else if (showsMissingStep) headline = 'Missed — here is the step that was missing';
  else if (answerIsInThisCard) headline = 'Missed — here is the answer';
  else headline = 'Missed — the answer is above';

  const head = el('div.row', { style: { gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' } },
    icon(wrong ? 'circle-alert' : 'circle-check', { size: 16, cls: 'icon--accent' }),
    el('span.text-title', { text: headline }));
  card.appendChild(head);

  if (confidentWrong) {
    card.appendChild(el('div.pill.pill--bad', { style: { marginBottom: 'var(--sp-3)' } },
      icon('target', { size: 12 }),
      el('span', { text: 'This one bit you — it goes first next session' })));
  }

  // The self-report path has already revealed the answer — do not print it twice.
  if (o.showAnswer !== false) {
    card.appendChild(el('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, el('span', { text: 'Answer' })));
    const ans = el('div.prose');
    md(ans, content.a || '—');
    card.appendChild(ans);
  }

  // Only a real chain or explanation can name a step the answer did not already
  // say — otherwise this block would just repeat the answer back at him.
  // `showsMissingStep` is computed above so the headline agrees with it.
  if (showsMissingStep) {
    card.appendChild(el('div.formula-block', { style: { marginTop: 'var(--sp-3)' } },
      el('div.eyebrow', { style: { marginBottom: '4px' } }, el('span', { text: 'The one missing step' })),
      el('span', { text: o.missingStep })));
  }

  if (meta.solutionChain && meta.solutionChain.length) {
    const ol = el('ol', { style: { paddingLeft: 'var(--sp-5)', marginTop: 'var(--sp-3)' } });
    for (const step of meta.solutionChain) {
      const li = el('li', { style: { marginBottom: 'var(--sp-2)' } });
      const st = el('div');
      mdInline(st, step.statement);
      li.appendChild(st);
      if (step.justification) {
        li.appendChild(el('div.text-meta', { text: step.justification }));
      }
      ol.appendChild(li);
    }
    card.appendChild(el('div',
      el('div.eyebrow', { style: { margin: 'var(--sp-3) 0 var(--sp-1)' } }, el('span', { text: 'Marked step by step' })),
      ol));
  }

  const rationale = pickRationale(meta, o.chosenIndex);
  if (rationale) {
    card.appendChild(el('div', { style: { marginTop: 'var(--sp-3)' } },
      el('div.eyebrow', { style: { marginBottom: '4px' } }, el('span', { text: 'Why that one is wrong' })),
      (() => { const n = el('div.prose'); md(n, rationale); return n; })()));
  }

  if (meta.explanation) {
    const ex = el('div.prose');
    md(ex, String(meta.explanation));
    card.appendChild(el('div', { style: { marginTop: 'var(--sp-3)' } },
      el('div.eyebrow', { style: { marginBottom: '4px' } }, el('span', { text: 'Why' })),
      ex));
  }

  if (meta.misconceptionTags && meta.misconceptionTags.length) {
    card.appendChild(el('div.chip-row', { style: { marginTop: 'var(--sp-3)' } },
      meta.misconceptionTags.map((t) => el('span.chip.chip--micro', { text: t }))));
  }

  if (o.autoReason) {
    card.appendChild(el('p.hint', { style: { marginTop: 'var(--sp-3)' }, text: o.autoReason }));
  }

  return card;
}

function pickRationale(meta, chosenIndex) {
  if (!meta) return '';
  if (meta.options && Number.isInteger(chosenIndex) && chosenIndex >= 0) {
    const opt = meta.options[chosenIndex];
    if (opt && opt.rationale && chosenIndex !== meta.correctIndex) return opt.rationale;
  }
  if (meta.distractorRationale && typeof meta.distractorRationale === 'string') return meta.distractorRationale;
  if (meta.distractorRationale && Array.isArray(meta.distractorRationale) && chosenIndex >= 0) {
    return meta.distractorRationale[chosenIndex] || '';
  }
  return '';
}

/** In-session progress rail. Never a due-count badge — it is a position, not a debt. */
export function sessionRail(total) {
  const node = el('div.rail', { attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': '0' } });
  const cells = [];
  for (let i = 0; i < total; i += 1) {
    const c = el('span.rail__cell');
    cells.push(c);
    node.appendChild(c);
  }
  return {
    node,
    set(index, doneFlags) {
      cells.forEach((c, i) => {
        c.classList.toggle('is-done', !!(doneFlags && doneFlags[i]));
        c.classList.toggle('is-current', i === index);
      });
      node.setAttribute('aria-valuenow', String(index));
    },
    grow() {
      const c = el('span.rail__cell');
      cells.push(c);
      node.appendChild(c);
    },
  };
}

/** The ONE effort question per session (pedagogy-spec R10). Never per item. */
export function effortSlider() {
  const out = el('output.mono', { style: { fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-semibold)' }, text: '50' });
  const input = el('input', {
    type: 'range',
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    style: {
      accentColor: 'var(--accent)',
      height: 'var(--tap)',
      width: '100%',
      cursor: 'pointer',
    },
    attrs: { 'aria-label': 'How hard did your brain work, 0 to 100' },
    on: { input: () => { out.textContent = input.value; } },
  });
  const node = el('div.field', { style: { marginBottom: '0' } },
    el('div.row.row--between',
      el('span.label', { text: 'How hard did your brain work?' }),
      out),
    input,
    el('div.row.row--between',
      el('span.hint', { text: 'Coasting' }),
      el('span.hint', { text: 'Everything I had' })));
  return { node, get: () => Number(input.value) };
}

/** "Copying or thinking?" — the binary that pairs with the slider (R10). */
export function modeBinary() {
  let value = null;
  const mk = (v, label, iconName) => el('button.segmented__btn', {
    type: 'button',
    attrs: { 'aria-selected': 'false' },
    style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flex: '1 1 0' },
    onClick: () => {
      value = v;
      for (const b of group.children) b.setAttribute('aria-selected', 'false');
      btns[v].setAttribute('aria-selected', 'true');
    },
  }, icon(iconName, { size: 14 }), el('span', { text: label }));
  const btns = { copying: null, thinking: null };
  btns.copying = mk('copying', 'Copying', 'copy');
  btns.thinking = mk('thinking', 'Thinking', 'brain');
  const group = el('div.segmented', { attrs: { role: 'group', 'aria-label': 'Was this copying or thinking?' } },
    btns.copying, btns.thinking);
  const node = el('div.field', { style: { marginBottom: '0' } },
    el('span.label', { text: 'Copying or thinking?' }),
    group);
  return { node, get: () => value };
}

/** Takeaway in his own words — saved, and reused by Hermes later (§3.7). */
export function takeawayField() {
  const input = el('textarea.textarea', {
    rows: 2,
    placeholder: 'One sentence a Class 8 kid would get…',
    attrs: { 'aria-label': 'Tonight in one sentence' },
  });
  const node = el('div.field', { style: { marginBottom: '0' } },
    el('span.label', { text: 'Give me tonight in one sentence, your words' }),
    input,
    el('p.hint', { text: 'Your own wording comes back in later reviews — that is why it is worth 10 seconds.' }));
  return { node, get: () => input.value.trim() };
}

/* =============================================================================
   7. SESSION REFLECTION + COMPETENCE STATEMENT
   ========================================================================== */

/**
 * Persist the end-of-session self-report. Lands in two places on purpose:
 *   · our own REFLECT_KEY (the full history, exported alongside the review log)
 *   · KEYS.SESSIONS[day] — ONLY the reflection fields. game.js owns the seconds
 *     / reviews / correct tallies on that key; adding to them here would double
 *     every number the moment the game layer is present.
 */
export function saveReflection(entry) {
  const day = todayLocalISO();
  const row = {
    id: uid('refl'),
    ts: Date.now(),
    day,
    mode: entry.mode || 'review',
    effort: Number.isFinite(Number(entry.effort)) ? Number(entry.effort) : null,
    thinking: entry.thinking || null,
    takeaway: String(entry.takeaway || '').slice(0, 600),
    cards: Number(entry.cards) || 0,
    correct: Number(entry.correct) || 0,
    seconds: Number(entry.seconds) || 0,
    banked: !!entry.banked,
  };
  store.update(REFLECT_KEY, (prev) => {
    const map = (prev && typeof prev === 'object') ? { ...prev } : {};
    const list = Array.isArray(map[day]) ? map[day].slice() : [];
    list.push(row);
    map[day] = list;
    return map;
  }, {});
  store.update(KEYS.SESSIONS, (prev) => {
    const map = (prev && typeof prev === 'object') ? { ...prev } : {};
    const cur = (map[day] && typeof map[day] === 'object') ? map[day] : {};
    map[day] = {
      ...cur,
      effort: row.effort === null ? (cur.effort ?? null) : row.effort,
      thinking: row.thinking || cur.thinking || null,
      takeaway: row.takeaway || cur.takeaway || '',
    };
    return map;
  }, {});
  return row;
}

/** All reflections, newest first — the review-log export companion. */
export function getReflections(limit) {
  const map = store.get(REFLECT_KEY, {}) || {};
  const rows = [];
  for (const list of Object.values(map)) {
    if (Array.isArray(list)) rows.push(...list);
  }
  rows.sort((a, b) => b.ts - a.ts);
  return limit ? rows.slice(0, limit) : rows;
}

/** JSONL of the reflections — ships beside store.exportReviewLogJSONL(). */
export function exportReflectionsJSONL() {
  const rows = getReflections().slice().sort((a, b) => a.ts - b.ts);
  return rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
}

/**
 * Real numbers, marks-language, zero vague praise (pedagogy-spec §3.7).
 * @param {{attempts,correct,relearned,newIntervals:number[],hyperFixed:number,
 *          seconds:number,milestones:string[],confidentWrong:number}} s
 * @returns {string[]} lines
 */
export function competenceLines(s) {
  const lines = [];
  const attempts = Number(s.attempts) || 0;
  const correct = Number(s.correct) || 0;
  if (attempts) {
    lines.push(correct + ' of ' + attempts + ' retrievals held on the first attempt.');
  }
  if (s.relearned) {
    lines.push(s.relearned + ' ' + fmt.plural(s.relearned, 'item') + ' missed then retrieved to criterion before you stopped — that is the part that moves marks.');
  }
  const ivl = (s.newIntervals || []).filter((n) => Number.isFinite(n));
  if (ivl.length) {
    const longest = Math.max(...ivl);
    lines.push(ivl.length + ' ' + fmt.plural(ivl.length, 'item') + ' rescheduled, the furthest ' + formatIntervalDays(longest) + ' out.');
  }
  if (s.hyperFixed) {
    lines.push(s.hyperFixed + ' ' + fmt.plural(s.hyperFixed, 'item') + ' that bit you last time came back correct.');
  }
  if (s.confidentWrong) {
    lines.push(s.confidentWrong + ' ' + fmt.plural(s.confidentWrong, 'item') + ' you were sure about and missed — those are exactly where board marks go, and they lead tomorrow.');
  }
  for (const m of (s.milestones || [])) lines.push(m);
  if (!lines.length) lines.push('Session banked. Nothing was rated, so nothing moved — the streak still counts.');
  return lines;
}

/**
 * Successive-relearning milestones crossed in this session (§1.5: "3 relearn
 * sessions complete" is the mastery milestone shown, never cards-reviewed).
 * @param {Array<object>} cards rated cards, post-grade
 */
export function relearnMilestones(cards) {
  const out = [];
  for (const c of cards) {
    if ((Number(c.relearnSessions) || 0) === RELEARN_MILESTONE) {
      const content = cardContent(c.id);
      out.push((content ? content.topicName : 'This item') + ' — ' + RELEARN_MILESTONE
        + ' relearn sessions complete on “' + fmt.truncate((content && content.q) || c.id, 48) + '”.');
    }
  }
  return out.slice(0, 3);
}

/* =============================================================================
   8. CELEBRATION (cheap, deterministic, reduced-motion aware)
   ========================================================================== */

const CONFETTI_TOKENS = ['--confetti-1', '--confetti-2', '--confetti-3', '--confetti-4', '--confetti-5', '--confetti-6'];

/**
 * Confetti + the cross-feature event. Motion is skipped entirely under
 * prefers-reduced-motion; the event still fires so the game layer can react.
 * @param {{kind:string, label:string, pieces?:number}} o
 */
export function celebrate(o) {
  const detail = { kind: o.kind || 'session', label: o.label || '' };
  try {
    window.dispatchEvent(new CustomEvent('engram:celebration', { detail }));
  } catch (_) { /* non-fatal */ }
  sound('complete');
  haptic('success');
  if (prefersReducedMotion()) return;

  const layer = el('div.confetti-layer');
  const n = clamp(Number(o.pieces) || 28, 8, 60);
  for (let i = 0; i < n; i += 1) {
    const angle = (Math.PI * 2 * i) / n;
    const dist = 120 + (i % 5) * 34;
    layer.appendChild(el('span.confetti-piece', {
      style: {
        left: '50%',
        top: '38%',
        background: 'var(' + CONFETTI_TOKENS[i % CONFETTI_TOKENS.length] + ')',
        '--tx': Math.round(Math.cos(angle) * dist) + 'px',
        '--ty': Math.round(Math.sin(angle) * dist + 90) + 'px',
        '--rot': ((i % 4) * 180 + 180) + 'deg',
        animationDelay: (i % 6) * 18 + 'ms',
      },
    }));
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1400);
}

/* =============================================================================
   9. QUEUE ASSEMBLY
   ========================================================================== */

/**
 * Tonight's queue. Hypercorrection items (confident-wrong, unresolved) are
 * force-fed to the FRONT — the highest-priority queue in the system (Tier 0).
 *
 * @param {object} o
 * @param {Array<string>} [o.priorityIds] card ids to put first (hypercorrection)
 * @param {string} [o.topicId] restrict to one topic
 * @param {Array<string>} [o.cardIds] an explicit queue (deck study / pretest)
 * @returns {{items:Array<object>, session:object, pool:Array<object>, byId:Map}}
 */
export function assembleQueue(o) {
  const opts = o || {};
  const pool = buildPool();
  const byId = new Map(pool.map((c) => [c.id, c]));

  if (opts.cardIds && opts.cardIds.length) {
    const items = opts.cardIds.map((id) => byId.get(id)).filter(Boolean).map(toItem);
    return { items, session: null, pool, byId };
  }

  const scoped = opts.topicId ? pool.filter((c) => c.topic === opts.topicId) : pool;
  const session = buildSession(scoped, todayLocalISO(), schedulerOpts());

  const priority = [];
  const seen = new Set();
  for (const id of (opts.priorityIds || [])) {
    const card = byId.get(id);
    if (!card || card.suspended || seen.has(id)) continue;
    if (opts.topicId && card.topic !== opts.topicId) continue;
    priority.push(toItem(card, { hyper: true }));
    seen.add(id);
  }

  const rest = session.queue.filter((c) => !seen.has(c.id)).map((c) => toItem(c));
  return { items: priority.concat(rest), session, pool, byId };
}

/** One queue slot. `attempt` counts criterion attempts within THIS session. */
export function toItem(card, extra) {
  return {
    cardId: card.id,
    card,
    attempt: 1,
    relearn: false,
    hyper: false,
    paired: false,
    isNew: isNew(card),
    ...(extra || {}),
  };
}

/**
 * Re-entry: a missed item comes back after ~5 intervening cards, to criterion,
 * then STOPS (pedagogy-spec §1.5 — no massed drilling past criterion).
 * @returns {boolean} true when it was re-queued
 */
export function requeueForCriterion(items, index, item) {
  if (item.attempt >= RELEARN_MAX_ATTEMPTS) return false;
  const at = Math.min(items.length, index + 1 + RELEARN_GAP);
  items.splice(at, 0, {
    ...item,
    attempt: item.attempt + 1,
    relearn: true,
    paired: false,
  });
  return true;
}

/**
 * The paired application item — "now use it" (§1.5: every recall is chased by an
 * application item on the same concept when one exists).
 * @returns {object|null} the queue item to splice in next
 */
export function pairedItemFor(item, byId, alreadyQueued) {
  const content = cardContent(item.cardId);
  const meta = (content && content.meta) || {};
  let target = meta.pairedId ? byId.get(String(meta.pairedId)) : null;
  if (!target) {
    for (const [id, card] of byId) {
      if (alreadyQueued.has(id) || id === item.cardId) continue;
      const m = cardMeta(id);
      if (m.appliesTo && String(m.appliesTo) === item.cardId) { target = card; break; }
    }
  }
  if (!target || alreadyQueued.has(target.id) || target.suspended) return null;
  return toItem(target, { paired: true });
}

/* =============================================================================
   10. SMALL SHARED PIECES
   ========================================================================== */

/** A card's topic/subject header chip row. */
export function cardChips(content, card) {
  const meta = (content && content.meta) || {};
  const chips = [];
  if (content && content.topicName) {
    chips.push(el('span.chip.chip--micro', { text: content.topicName }));
  }
  if (meta.cognitive) {
    chips.push(el('span.chip.chip--micro', { text: meta.cognitive }));
  }
  if (card && isNew(card)) {
    chips.push(el('span.pill.pill--new', { text: 'First time' }));
  } else if (card) {
    const tone = srsTone(card, todayLocalISO());
    const LABEL = { mastered: 'Holding', 'due-soon': 'Fading', lapsed: 'Slipped', new: 'First time' };
    chips.push(el('span.pill', { class: 'pill--' + (tone === 'due-soon' ? 'due' : tone), text: LABEL[tone] || tone }));
  }
  return el('div.chip-row', chips);
}

/** Estimated minutes left for N remaining cards — minutes, never a due count. */
export function minutesFor(cards) {
  const secs = (Number(cards) || 0) * 20;
  return Math.max(1, Math.round(secs / 60));
}

/** Minutes for a set of queue items, using the scheduler's own per-card costs
 *  (SCHEDULER_DEFAULTS: 45 s for a first exposure, 20 s for a review) so the
 *  breakdown always adds up to the headline the session label shows. */
export function estMinutesForItems(items) {
  const secs = (items || []).reduce((n, i) => n + (i && i.isNew ? 45 : 20), 0);
  return Math.max(1, Math.round(secs / 60));
}

/** Human interval label for a card's CURRENT schedule. */
export function nextDueLabel(card) {
  const m = queueMeta(card, todayLocalISO(), schedulerOpts());
  return formatIntervalDays(m.intervalDays);
}

export { CONFIDENCE_LABELS, LEECH_THRESHOLD, formatIntervalDays, toLocalYMD, dayKeyFromTs };

export default {
  assembleQueue, buildPool, cardContent, cardMeta, applyGrade,
  confidencePicker, commitPanel, gradeRow, feedbackPanel, escapeHatch,
  SessionClock, celebrate, saveReflection, competenceLines,
};
