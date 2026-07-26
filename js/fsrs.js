/**
 * fsrs.js — FSRS-4.5 memory engine, bit-equal port of engram.py.
 * =============================================================================
 * Engram v2 · Job A3 · owner: fsrs.js / scheduler.js / tests/fsrs.test.html
 *
 * SCHEDULER OF RECORD IS engram.py (build-constraints §3, pedagogy-spec R3).
 * This module is a PROVISIONAL MIRROR: the browser computes the same numbers so
 * the student can study offline, writes an append-only review-log JSONL, and
 * that log is replayed into engram.py via `rate --file` / `receipt --file`.
 * Receipts on the VPS are truth. localStorage is a cache, never the sole copy.
 *
 * SOURCE OF TRUTH FOR EVERY FORMULA BELOW:
 *   engram-engine/scripts/engram.py  (v1.1.1, SCHEMA 1)
 * Every function carries the engram.py line number it mirrors. If engram.py
 * changes, change this file and re-run js/tests/fsrs.test.html.
 *
 * ZERO DOM. ZERO IMPORTS. ZERO NETWORK. Pure functions only.
 * ES module, modern browser baseline (iOS Safari 16+, Chrome Android).
 *
 * -----------------------------------------------------------------------------
 * FIDELITY NOTES (read before "fixing" anything here)
 * -----------------------------------------------------------------------------
 * 1. NO FUZZ. engram.py has no interval fuzz anywhere (`random` is imported only
 *    for SEEDED experiment assignment, never for scheduling). This port is
 *    therefore fully deterministic — same inputs, same bytes, forever.
 * 2. DAY GRANULARITY. engram.py schedules on calendar DATES (`datetime.date`),
 *    never timestamps. Elapsed time is a whole number of days. Everything here
 *    speaks 'YYYY-MM-DD' local civil dates.
 * 3. LOCAL DATES ONLY (build-constraints §9.1). Nepal is UTC+05:45. `toISOString`
 *    is never used for day math — dates come from getFullYear/getMonth/getDate
 *    or from explicit-offset helpers. Grep this file: there is no toISOString.
 * 4. PYTHON ROUNDING. engram.py uses Python's round(), which is round-half-to-
 *    EVEN on the exact binary value of the double. JS Math.round is half-up and
 *    toFixed is half-away-from-zero. `pyRound()` below reproduces CPython
 *    exactly (BigInt exact-value rounding + correctly-rounded strtod).
 * 5. OPERATION ORDER is preserved verbatim so IEEE-754 doubles match bit for
 *    bit. Do not "simplify" `s / FACTOR * (r ** -2 - 1) * m` into `s * k`.
 *    The only residual risk is that Math.pow/Math.exp may differ from libm by
 *    ≤1 ULP; every stored value is rounded to 4 dp (stability/difficulty) or to
 *    an integer (interval), which is ~11 orders of magnitude above that noise.
 * 6. DIFFICULTY LAG. The stability update uses the OLD difficulty d0, not the
 *    freshly computed d (engram.py:225). FSRS-5 reference impls differ here.
 *    Preserve engram.py.
 *
 * -----------------------------------------------------------------------------
 * CANONICAL CARD SHAPE (the contract every other module codes against)
 * -----------------------------------------------------------------------------
 *   {
 *     id:          string        // sha1("<file-stem>|<question>")[:12] per §1, or explicit `id:`
 *     topic:       string|null   // topic slug — used by engram replay + interleaving
 *     subject:     string|null   // declared in frontmatter, NEVER keyword-sniffed (§9.4)
 *     unit:        string|null
 *
 *     // ---- owned by fsrs.js (never write these by hand) ----
 *     stability:   number|null   // engram fsrs.s — days; null = never rated
 *     difficulty:  number|null   // engram fsrs.d — 1..10; null = never rated
 *     due:         string|null   // 'YYYY-MM-DD' local
 *     last:        string|null   // 'YYYY-MM-DD' local, last rating date
 *     reps:        number        // int ≥ 0, total ratings incl. first exposure
 *     lapses:      number        // int ≥ 0, 'again' ratings after first exposure
 *     state:       'new'|'learning'|'review'
 *     introducedOn:string|null   // 'YYYY-MM-DD' of first exposure = day 0 for retention
 *
 *     // ---- owned by scheduler.js ----
 *     suspended:   boolean       // leech auto-suspend (lapses ≥ 6) or manual
 *     leech:       boolean
 *     masteredOn:  string|null   // 'YYYY-MM-DD' — starts the +2d/+7d/+21d gates
 *     gates:       {}            // { "2": {result,on}, "7": …, "21": … }
 *
 *     // ---- owned by feature layers (fsrs.js copies them through untouched) ----
 *     …anything else (q, a, problemType, cognitive, misconceptionTags, estSeconds …)
 *   }
 *
 * Mapping to engram.py's node.fsrs block (engram.py:596 `_fresh_fsrs`):
 *   stability→s  difficulty→d  due→due  last→last  reps→reps  lapses→lapses
 * Use toEngramFsrs()/fromEngramFsrs() at the sync boundary — never rename inline.
 */

/* =============================================================================
 * 1. CONSTANTS — verbatim from engram.py:31-72
 * ========================================================================== */

/** FSRS-4.5 default parameter vector (open-spaced-repetition). engram.py:45-46.
 *  w[0..3] are initial stabilities for Again/Hard/Good/Easy; the rest shape
 *  difficulty and growth. DO NOT reorder, DO NOT round. */
export const W = Object.freeze([
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
]);

/** engram.py:47 */
export const DECAY = -0.5;
/** engram.py:48 — chosen so R(t = S) = 0.9 exactly. */
export const FACTOR = 19.0 / 81.0;

/** engram.py:36 */
export const RETENTION_DEFAULT = 0.90;
/** engram.py:37 */
export const INTERVAL_MAX = 365;
/** engram.py:38 — sane desired-retention bounds; interval_for clamps into these. */
export const RETENTION_MIN = 0.70;
export const RETENTION_MAX = 0.97;
/** engram.py:39 — matches the `refit` clamp. */
export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 1.5;

/** engram.py:50 */
export const RATINGS = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
/** Index-ordered names; index i ↔ rating i+1. */
export const RATING_NAMES = Object.freeze(['again', 'hard', 'good', 'easy']);
/** engram.py:68 */
export const NODE_STATES = Object.freeze(['new', 'learning', 'review']);
/** engram.py:51 */
export const GRADES = Object.freeze(['recalled', 'partial', 'lapsed']);
/** engram.py:71 — grade ↔ rating is a bijection. */
export const GRADE_OF_RATING = Object.freeze({
  again: 'lapsed', hard: 'partial', good: 'recalled', easy: 'recalled',
});
/** engram.py:72 */
export const OUTCOME_OF_GRADE = Object.freeze({ recalled: 1.0, partial: 0.5, lapsed: 0.0 });

/** Nepal Standard Time offset from UTC, in minutes (+05:45). build-constraints §9.1. */
export const NEPAL_UTC_OFFSET_MIN = 345;

/* =============================================================================
 * 2. PYTHON-COMPATIBLE PRIMITIVES
 *    These exist so the JS numbers are the SAME numbers, not merely close ones.
 * ========================================================================== */

const _DV = new DataView(new ArrayBuffer(8));

/**
 * Exact decomposition of an IEEE-754 double into sign · mantissa · 2^exp.
 * |x| === mant * 2**exp exactly (BigInt mantissa, so no precision is lost).
 * @private
 */
function _decompose(x) {
  _DV.setFloat64(0, x);
  const hi = _DV.getUint32(0);
  const lo = _DV.getUint32(4);
  const neg = (hi >>> 31) === 1;
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0x000fffff) << 32n) | BigInt(lo >>> 0);
  let exp;
  if (expBits === 0) {
    exp = -1074;                       // subnormal (or zero)
  } else {
    mant |= 1n << 52n;                 // implicit leading 1
    exp = expBits - 1075;
  }
  return { neg, mant, exp };
}

/**
 * CPython's `round(x)` / `round(x, ndigits)` for floats, exactly.
 *
 * CPython computes the correctly-rounded decimal representation of the EXACT
 * binary value of x with `_Py_dg_dtoa(x, mode 3, ndigits)` — which is
 * ROUND-HALF-TO-EVEN — and converts it back with a correctly-rounded strtod.
 * Neither Math.round (half-up, and only for integers) nor toFixed
 * (half-away-from-zero) does that, and both are wrong on real inputs:
 *   Python round(2.675, 2) === 2.67   (2.675 is really 2.674999…)
 *   Python round(2.5)      === 2      (half-to-even)
 *   Python round(0.03125,4)=== 0.0312 (exact tie → even)
 * This reproduces all three.
 *
 * @param {number} x
 * @param {number} [nd=0] digits after the decimal point (≥ 0)
 * @returns {number}
 */
export function pyRound(x, nd = 0) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  if (x === 0) return x;                                   // preserves -0 like Python
  const { neg, mant, exp } = _decompose(x);
  if (mant === 0n) return x;
  const P = 10n ** BigInt(nd);
  let num = mant * P;
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den = 1n << BigInt(-exp);
  let q = num / den;
  const rem = num % den;
  const twice = rem * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && (q & 1n) === 1n) q += 1n;       // exact tie → even
  // Build the decimal string and let the engine's correctly-rounded parser
  // convert it — this is exactly CPython's dtoa→strtod round trip.
  let digits = q.toString();
  let out;
  if (nd === 0) {
    out = digits;
  } else {
    if (digits.length <= nd) digits = '0'.repeat(nd - digits.length + 1) + digits;
    out = digits.slice(0, digits.length - nd) + '.' + digits.slice(digits.length - nd);
  }
  const v = Number(out);
  return neg ? -v : v;
}

/**
 * engram.py:169-170 — `def clamp(x, lo, hi): return max(lo, min(hi, x))`.
 * NaN-safe in the same direction Python is not: NaN never reaches here because
 * every input funnels through asNumber() first.
 */
export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * engram.py:101-121 — THE numeric gate for the whole engine.
 * Coerce a JSON scalar to a float, or return `dflt`. Booleans are NOT numbers.
 * NON-FINITE IS NOT A NUMBER: NaN / ±Infinity return the default (a hand-edited
 * state file can carry them, and they poison every comparison downstream).
 * @param {*} x
 * @param {number|null} [dflt=null]
 * @returns {number|null}
 */
export function asNumber(x, dflt = null) {
  if (typeof x === 'boolean' || x === null || x === undefined) return dflt;
  if (typeof x === 'number') return Number.isFinite(x) ? x : dflt;
  return dflt;
}

/* =============================================================================
 * 3. LOCAL CIVIL-DATE MATH — build-constraints §9.1 (audit C1)
 *    Nepal is UTC+05:45. `new Date(...).toISOString()` on a local midnight
 *    returns the PREVIOUS day. Every date here is a pure civil (Y, M, D) triple;
 *    Date objects are only ever read through getFullYear/getMonth/getDate, or
 *    through an explicit numeric offset. There is no toISOString in this file.
 * ========================================================================== */

const _YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * engram.py:92-99 `safe_date` — parse 'YYYY-MM-DD', tolerating garbage (→ null).
 * Rejects impossible dates (2026-02-31) the way date.fromisoformat does.
 * @param {*} s
 * @returns {{y:number,m:number,d:number}|null}
 */
export function parseLocalDate(s) {
  if (typeof s !== 'string') return null;
  const m = _YMD_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** Days in a civil month. */
export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Proleptic Gregorian leap year. */
export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Civil (y,m,d) → days since 1970-01-01. Howard Hinnant's days_from_civil.
 * Pure integer arithmetic — no Date, no timezone, no DST, no toISOString.
 */
export function dayNumber(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;                                   // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Days since 1970-01-01 → civil {y,m,d}. Inverse of dayNumber. */
export function fromDayNumber(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;                                 // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);                         // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);                   // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;           // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9);                            // [1, 12]
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** {y,m,d} → 'YYYY-MM-DD'. Zero-padded, never locale-dependent. */
export function formatLocalDate(ymd) {
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return `${String(ymd.y).padStart(4, '0')}-${p2(ymd.m)}-${p2(ymd.d)}`;
}

/**
 * TODAY as a local civil date string, read from the device wall clock.
 * Uses getFullYear/getMonth/getDate — NEVER toISOString (build-constraints §9.1).
 * @param {Date} [d=new Date()]
 * @returns {string} 'YYYY-MM-DD'
 */
export function todayLocal(d = new Date()) {
  return formatLocalDate({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
}

/**
 * The civil date at a FIXED UTC offset, from an absolute instant.
 * Use this when the device clock's timezone cannot be trusted but Nepal's
 * calendar day is what matters: `ymdAtOffset(Date.now(), NEPAL_UTC_OFFSET_MIN)`.
 * Reads UTC components after shifting — still no toISOString.
 * @param {number|Date} instant epoch ms, or a Date
 * @param {number} offsetMin minutes east of UTC (Nepal = 345)
 * @returns {string} 'YYYY-MM-DD'
 */
export function ymdAtOffset(instant, offsetMin = NEPAL_UTC_OFFSET_MIN) {
  const ms = (instant instanceof Date ? instant.getTime() : Number(instant)) + offsetMin * 60000;
  const t = new Date(ms);
  return formatLocalDate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/**
 * Normalise anything the app might hand us into a 'YYYY-MM-DD' local date.
 * Accepts: 'YYYY-MM-DD' (passthrough), Date (local components), null/undefined
 * (→ today local), a number (epoch ms → device-local day).
 * Throws on an unparseable string, because silently scheduling on the wrong day
 * is the failure mode audit C1 exists to prevent.
 * @param {string|Date|number|null|undefined} now
 * @returns {string}
 */
export function toLocalYMD(now) {
  if (now === null || now === undefined) return todayLocal();
  if (typeof now === 'string') {
    if (parseLocalDate(now)) return now;
    throw new TypeError(`fsrs: not a local YYYY-MM-DD date: ${JSON.stringify(now)}`);
  }
  if (now instanceof Date) return todayLocal(now);
  if (typeof now === 'number' && Number.isFinite(now)) return todayLocal(new Date(now));
  throw new TypeError(`fsrs: cannot read a local date from ${typeof now}`);
}

/** 'YYYY-MM-DD' + n days → 'YYYY-MM-DD'. Pure integer day arithmetic. */
export function addDays(ymdStr, n) {
  const p = parseLocalDate(ymdStr);
  if (!p) return null;
  return formatLocalDate(fromDayNumber(dayNumber(p.y, p.m, p.d) + Math.trunc(n)));
}

/**
 * engram.py:123-128 `days_between(a, b)` → (b - a) in whole days, or null if
 * either date is missing/garbled. Can be negative.
 */
export function daysBetween(aYmd, bYmd) {
  const a = parseLocalDate(aYmd), b = parseLocalDate(bYmd);
  if (!a || !b) return null;
  return dayNumber(b.y, b.m, b.d) - dayNumber(a.y, a.m, a.d);
}

/** Chronological compare of two 'YYYY-MM-DD' strings (lexicographic is valid). */
export function cmpDate(a, b) { return a === b ? 0 : (a < b ? -1 : 1); }

/* =============================================================================
 * 4. FSRS-4.5 LEAF FUNCTIONS — engram.py:167-207
 *    Each is a line-for-line mirror. Operation order is load-bearing.
 * ========================================================================== */

/**
 * engram.py:172-175
 *   def retrievability(elapsed_days, stability):
 *       if stability <= 0: return 0.0
 *       return (1.0 + FACTOR * elapsed_days / stability) ** DECAY
 * The FSRS-4.5 power forgetting curve. R(t = S) === 0.9 by construction.
 * @param {number} elapsedDays whole days since `last`
 * @param {number} stability days
 * @returns {number} 0..1
 */
export function retrievabilityRaw(elapsedDays, stability) {
  const s = asNumber(stability);
  const e = asNumber(elapsedDays, 0);
  if (s === null || s <= 0) return 0.0;
  return Math.pow(1.0 + FACTOR * e / s, DECAY);
}

/**
 * engram.py:177-183
 *   retention = clamp(retention, RETENTION_MIN, RETENTION_MAX)
 *   multiplier = clamp(multiplier, MULTIPLIER_MIN, MULTIPLIER_MAX)
 *   days = stability / FACTOR * (retention ** (1.0 / DECAY) - 1.0) * multiplier
 *   return int(clamp(round(days), 1, INTERVAL_MAX))
 * The defensive clamps are NOT decoration: retention 0 would evaluate 0**-2 and
 * a negative multiplier would schedule into the past.
 * @returns {number} integer days in [1, 365]
 */
export function intervalForStability(stability, retention = RETENTION_DEFAULT, multiplier = 1.0) {
  const s = asNumber(stability);
  if (s === null) return 1;
  const r = clamp(asNumber(retention, RETENTION_DEFAULT), RETENTION_MIN, RETENTION_MAX);
  const m = clamp(asNumber(multiplier, 1.0), MULTIPLIER_MIN, MULTIPLIER_MAX);
  const days = s / FACTOR * (Math.pow(r, 1.0 / DECAY) - 1.0) * m;
  return Math.trunc(clamp(pyRound(days), 1, INTERVAL_MAX));
}

/** engram.py:185-186 — `clamp(W[g-1], 0.1, 100.0)`. g is 1..4. */
export function initStability(g) {
  return clamp(W[g - 1], 0.1, 100.0);
}

/** engram.py:188-189 — `clamp(W[4] - (g - 3) * W[5], 1.0, 10.0)`. */
export function initDifficulty(g) {
  return clamp(W[4] - (g - 3) * W[5], 1.0, 10.0);
}

/**
 * engram.py:191-196
 *   nd = d - W[6] * (g - 3)
 *   nd = W[7] * init_difficulty(3) + (1.0 - W[7]) * nd     # mean reversion
 *   return clamp(nd, 1.0, 10.0)
 * ⚠ FSRS-4.5 mean-reverts toward D0(3) (Good), NOT D0(4). D0(4) is the FSRS-5
 * rule and would inflate stability growth ~20% under this 4.5 weight vector.
 * engram.py has a selftest pinning this (engram.py:4752-4756) — so does ours.
 */
export function nextDifficulty(d, g) {
  let nd = d - W[6] * (g - 3);
  nd = W[7] * initDifficulty(3) + (1.0 - W[7]) * nd;
  return clamp(nd, 1.0, 10.0);
}

/**
 * engram.py:198-203
 *   hard_penalty = W[15] if g == 2 else 1.0
 *   easy_bonus   = W[16] if g == 4 else 1.0
 *   grow = (exp(W[8]) * (11.0 - d) * (s ** -W[9])
 *           * (exp(W[10] * (1.0 - r)) - 1.0) * hard_penalty * easy_bonus)
 *   return clamp(s * (1.0 + grow), 0.1, 36500.0)
 * The `(exp(w10*(1-r)) - 1)` term is the PREDICTION ERROR: at r = 1 (same-day
 * review) it is exactly 0, so a same-day review buys no stability. That is the
 * spacing effect, and it is not a bug (engram.py:5038-5042).
 */
export function nextStabilityRecall(d, s, r, g) {
  const hardPenalty = g === 2 ? W[15] : 1.0;
  const easyBonus = g === 4 ? W[16] : 1.0;
  const grow = Math.exp(W[8]) * (11.0 - d) * Math.pow(s, -W[9])
    * (Math.exp(W[10] * (1.0 - r)) - 1.0) * hardPenalty * easyBonus;
  return clamp(s * (1.0 + grow), 0.1, 36500.0);
}

/**
 * engram.py:205-207
 *   sf = W[11] * (d ** -W[12]) * (((s + 1.0) ** W[13]) - 1.0) * exp(W[14] * (1.0 - r))
 *   return clamp(min(sf, s), 0.1, 36500.0)   # a lapse NEVER increases stability
 */
export function nextStabilityForget(d, s, r) {
  const sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1.0, W[13]) - 1.0)
    * Math.exp(W[14] * (1.0 - r));
  return clamp(Math.min(sf, s), 0.1, 36500.0);
}

/* =============================================================================
 * 5. CARD-LEVEL API
 * ========================================================================== */

/**
 * A fresh, never-rated card. Mirrors engram.py:595-596 `_fresh_fsrs()` plus the
 * identity + scheduler fields the hub needs.
 *
 * @param {string|null} [id] stable card id (see build-constraints §1 — sha1 of
 *        "<flashcard-file-stem>|<question>" truncated to 12, or an explicit `id:`)
 * @param {object} [overrides] any extra fields (q, a, topic, subject, unit, …)
 * @returns {object} card
 */
export function initCard(id = null, overrides = {}) {
  return {
    id: id,
    topic: null,
    subject: null,
    unit: null,
    // fsrs.js-owned
    stability: null,
    difficulty: null,
    due: null,
    last: null,
    reps: 0,
    lapses: 0,
    state: 'new',
    introducedOn: null,
    // scheduler.js-owned
    suspended: false,
    leech: false,
    masteredOn: null,
    gates: {},
    ...overrides,
  };
}

/** True when the card has never been rated (engram: `fsrs.s is None`). */
export function isNew(card) {
  return asNumber(card && card.stability) === null;
}

/**
 * Read a card's last-review date, TOLERANTLY.
 * The canonical field is `last` (engram.py's own name, engram.py:596). Some hub
 * layers persist it as `lastISO`; accepting both on READ costs nothing and stops
 * a naming mismatch from silently scheduling every card as if it were reviewed
 * today (elapsed 0 ⇒ r = 1 ⇒ no stability growth — a bug that looks like a
 * plateau, not like a crash). WRITES are always canonical `last`.
 * @returns {string|null} 'YYYY-MM-DD'
 */
export function cardLast(card) {
  if (!card) return null;
  for (const k of ['last', 'lastISO', 'lastReview', 'last_review']) {
    if (parseLocalDate(card[k])) return card[k];
  }
  return null;
}

/** Read a card's due date, tolerantly (`due` | `dueISO`). Writes stay `due`. */
export function cardDue(card) {
  if (!card) return null;
  for (const k of ['due', 'dueISO']) {
    if (parseLocalDate(card[k])) return card[k];
  }
  return null;
}

/**
 * Current retrievability of a card, 0..1 — the probability the student would
 * recall it right now under the FSRS-4.5 forgetting curve.
 * Elapsed days are floored at 0 (engram.py:222 `max(0, (on_date - last_d).days)`),
 * so a clock that jumped backwards can never manufacture a >1 retrievability.
 * A never-rated card returns null (unknown, NOT 0 — build-constraints §9.6:
 * unseen cards are not unconditionally due).
 *
 * @param {object} card
 * @param {string|Date|number|null} [now] local 'YYYY-MM-DD' (default: today local)
 * @returns {number|null}
 */
export function retrievability(card, now = null) {
  const s = asNumber(card && card.stability);
  if (s === null) return null;
  const today = toLocalYMD(now);
  const el = daysBetween(cardLast(card), today);
  const elapsed = el === null ? 0 : Math.max(0, el);
  return retrievabilityRaw(elapsed, clamp(s, 0.1, 36500.0));
}

/**
 * The interval (whole days) this card's CURRENT stability earns at a given
 * desired retention. This is the number a grade-button preview must show
 * (build-constraints §9.9) — no invented "<10m" labels.
 *
 * @param {object} card
 * @param {number} [desiredRetention=0.90]
 * @param {number} [intervalMultiplier=1.0] engram's per-user `im` from `refit`
 * @returns {number} integer days in [1, 365]
 */
export function intervalFor(card, desiredRetention = RETENTION_DEFAULT, intervalMultiplier = 1.0) {
  return intervalForStability(card && card.stability, desiredRetention, intervalMultiplier);
}

/**
 * THE TRANSITION. Bit-equal port of engram.py:209-244 `apply_rating`, plus the
 * node-state transition from engram.py:1238-1245 (which lives in `apply_item`).
 *
 *   engram.py:211  g = RATINGS[rating_name]
 *   engram.py:212  s0, d0 = as_number(fsrs["s"]), as_number(fsrs["d"])
 *   engram.py:214  if s0 is not None: s0 = clamp(s0, 0.1, 36500.0)
 *   engram.py:216  if s0 is None:  s, d, r = init_stability(g), init_difficulty(g), None
 *   engram.py:219  elif d0 is None: d0 = init_difficulty(3)      # re-anchor
 *   engram.py:222  elapsed = max(0, (on_date - last_d).days) if last_d else 0
 *   engram.py:223  r = retrievability(elapsed, s0)
 *   engram.py:224  d = next_difficulty(d0, g)
 *   engram.py:225  s = next_stability_forget(d0, s0, r) if g == 1
 *                      else next_stability_recall(d0, s0, r, g)   ← OLD d0, not d
 *   engram.py:226  ivl = interval_for(s, retention, im)           ← UNROUNDED s
 *   engram.py:237  out["s"], out["d"] = round(s, 4), round(d, 4)
 *   engram.py:239  out["due"] = on_date + ivl days
 *   engram.py:240  out["reps"]   = max(0, int(reps)) + 1
 *   engram.py:241  out["lapses"] = max(0, int(lapses)) + (1 if g == 1 and s0 is not None else 0)
 *
 * State (engram.py:1240-1245):
 *   again                → 'learning'
 *   first exposure + hard→ 'learning'
 *   otherwise            → 'review'
 * (engram.py has no separate relearning-step queue: an 'again' rewrites stability
 *  through next_stability_forget and the interval falls out of interval_for, which
 *  floors at 1 day. "Relearning" is the `learning` state at a 1-day interval.)
 *
 * PURE: `card` is never mutated; a new object is returned.
 *
 * @param {object} card
 * @param {'again'|'hard'|'good'|'easy'|1|2|3|4} rating
 * @param {string|Date|number|null} [now] local 'YYYY-MM-DD' (default: today local)
 * @param {{desiredRetention?:number, intervalMultiplier?:number}} [opts]
 * @returns {object} the NEW card — carries stability, difficulty, due, lapses,
 *          reps, state (the documented contract) plus `last`, `introducedOn`,
 *          and a `review` sub-object with the engram receipt fields.
 */
export function applyRating(card, rating, now = null, opts = {}) {
  const name = normaliseRating(rating);
  const g = RATINGS[name];
  const onDate = toLocalYMD(now);
  const src = card || initCard();

  const retention = asNumber(opts.desiredRetention, RETENTION_DEFAULT);
  const im = asNumber(opts.intervalMultiplier, 1.0);

  let s0 = asNumber(src.stability);
  let d0 = asNumber(src.difficulty);
  if (s0 !== null) s0 = clamp(s0, 0.1, 36500.0);          // engram.py:214

  const wasNew = s0 === null;
  let s, d, r, elapsed;

  if (wasNew) {                                            // engram.py:216-217
    s = initStability(g);
    d = initDifficulty(g);
    r = null;
    elapsed = null;
  } else {
    if (d0 === null) d0 = initDifficulty(3);               // engram.py:219-220
    const el = daysBetween(cardLast(src), onDate);         // engram.py:221-222
    elapsed = el === null ? 0 : Math.max(0, el);
    r = retrievabilityRaw(elapsed, s0);                    // engram.py:223
    d = nextDifficulty(d0, g);                             // engram.py:224
    s = (g === 1)                                          // engram.py:225
      ? nextStabilityForget(d0, s0, r)
      : nextStabilityRecall(d0, s0, r, g);
  }

  const ivl = intervalForStability(s, retention, im);      // engram.py:226-227 (unrounded s)

  const reps = asNumber(src.reps, 0) || 0;                 // engram.py:234
  const lapses = asNumber(src.lapses, 0) || 0;             // engram.py:235
  const sOut = pyRound(s, 4);                              // engram.py:237
  const dOut = pyRound(d, 4);

  const state = (g === 1) ? 'learning'                     // engram.py:1240-1245
    : (wasNew && g === 2) ? 'learning'
      : 'review';

  const out = {
    ...src,
    stability: sOut,
    difficulty: dOut,
    last: onDate,                                          // engram.py:238
    due: addDays(onDate, ivl),                             // engram.py:239
    reps: Math.max(0, Math.trunc(reps)) + 1,               // engram.py:240
    lapses: Math.max(0, Math.trunc(lapses)) + ((g === 1 && !wasNew) ? 1 : 0), // engram.py:241
    state,
    // Day 0 for the retention north star (engram.py:1264 `_first_receipt_ts`).
    // Stamped once, never rewritten — a re-stamped day 0 would let every review
    // look like a 7-day retention win.
    introducedOn: src.introducedOn || onDate,
    review: {
      // engram.py:243-244 receipt fields, same names, same rounding.
      s_before: s0,
      s_after: sOut,
      interval_days: ivl,
      retrievability: r === null ? null : pyRound(r, 4),
      // hub-side extras (not in engram's receipt; ignored by `rate --file`)
      rating: name,
      rating_num: g,
      grade: GRADE_OF_RATING[name],
      date: onDate,
      elapsed_days: elapsed,
      was_new: wasNew,
      lapsed: g === 1 && !wasNew,
      difficulty_before: d0,
      difficulty_after: dOut,
      desired_retention: clamp(retention === null ? RETENTION_DEFAULT : retention,
        RETENTION_MIN, RETENTION_MAX),
      interval_multiplier: clamp(im === null ? 1.0 : im, MULTIPLIER_MIN, MULTIPLIER_MAX),
      days_since_encode: Math.max(0, daysBetween(src.introducedOn || onDate, onDate) || 0),
    },
  };
  return out;
}

/**
 * Accept 'again'|'hard'|'good'|'easy' (any case) or 1|2|3|4 → the canonical name.
 * Throws on anything else: engram.py does `RATINGS[rating_name]` and a KeyError
 * is a hard failure there too. A silently-defaulted rating would write a lie
 * into an append-only log.
 */
export function normaliseRating(rating) {
  if (typeof rating === 'number' && RATING_NAMES[rating - 1]) return RATING_NAMES[rating - 1];
  if (typeof rating === 'string') {
    const k = rating.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(RATINGS, k)) return k;
  }
  throw new TypeError(`fsrs: bad rating ${JSON.stringify(rating)} — use again|hard|good|easy or 1..4`);
}

/**
 * TRUE computed intervals for all four grade buttons — build-constraints §9.9:
 * the button must show the interval that will actually be applied. Never label
 * a button with a duration the scheduler does not implement (engram schedules in
 * whole days; there is no "<10m" step).
 *
 * @param {object} card
 * @param {string|Date|number|null} [now]
 * @param {{desiredRetention?:number, intervalMultiplier?:number}} [opts]
 * @returns {Array<{rating:string, ratingNum:number, intervalDays:number,
 *          due:string, stability:number, difficulty:number, state:string,
 *          lapses:number, label:string}>} in again→hard→good→easy order
 */
export function previewIntervals(card, now = null, opts = {}) {
  return RATING_NAMES.map((name) => {
    const next = applyRating(card, name, now, opts);
    return {
      rating: name,
      ratingNum: RATINGS[name],
      intervalDays: next.review.interval_days,
      due: next.due,
      stability: next.stability,
      difficulty: next.difficulty,
      state: next.state,
      lapses: next.lapses,
      label: formatIntervalDays(next.review.interval_days),
    };
  });
}

/**
 * Honest interval label: ALWAYS the exact day count (§9.9). The parenthetical
 * month figure is a convenience, never a substitute.
 * @param {number} d whole days
 * @returns {string}
 */
export function formatIntervalDays(d) {
  const n = Math.trunc(asNumber(d, 0) || 0);
  if (n <= 1) return '1 day';
  if (n < 31) return `${n} days`;
  if (n < 365) return `${n} days (~${pyRound(n / 30.4375, 1)} mo)`;
  return `${n} days (~${pyRound(n / 365.25, 1)} yr)`;
}

/* =============================================================================
 * 6. engram.py BRIDGE — the review-log JSONL that becomes truth
 *    pedagogy-spec R3 / build-constraints §3: browser reviews are provisional,
 *    appended to a JSONL, synced into the vault repo, replayed via `rate --file`.
 * ========================================================================== */

/** Card → engram node.fsrs block (engram.py:596 key names). */
export function toEngramFsrs(card) {
  return {
    s: card.stability, d: card.difficulty, due: card.due,
    last: card.last, reps: card.reps, lapses: card.lapses,
  };
}

/** engram node.fsrs block → card fields (inverse of toEngramFsrs). */
export function fromEngramFsrs(fsrs, into = {}) {
  const f = (fsrs && typeof fsrs === 'object' && !Array.isArray(fsrs)) ? fsrs : {}; // engram.py:139-153
  return {
    ...into,
    stability: asNumber(f.s),
    difficulty: asNumber(f.d),
    due: parseLocalDate(f.due) ? f.due : null,
    last: parseLocalDate(f.last) ? f.last : null,
    reps: Math.max(0, Math.trunc(asNumber(f.reps, 0) || 0)),
    lapses: Math.max(0, Math.trunc(asNumber(f.lapses, 0) || 0)),
  };
}

/**
 * One line of the append-only review log. Shape is a valid `rate --file` /
 * `receipt --file` item (engram.py:1016-1055 `make_receipt`, validate_item):
 * engram reads topic/node/rating/confidence/production/grade/source/sid and
 * IGNORES every extra key, so the hub-side mirror fields ride along for free.
 *
 * ⚠ `sid` is the idempotency transaction id (engram.py:1150-1170): replaying the
 * same log twice is a no-op instead of a double-apply. Always emit one.
 * ⚠ engram stamps the receipt `ts` with ITS OWN today() — it cannot be told the
 * client date. `ts_client` carries the true study date for later analysis; the
 * replay should therefore run daily, not in month-long batches.
 *
 * @param {object} ratedCard the card returned by applyRating()
 * @param {object} [extra] {confidence, production, grade, kind, source, misconceptions,
 *                          rubric_notes, error_class, sid}
 * @returns {object} JSONL-ready record
 */
export function toReviewLogEntry(ratedCard, extra = {}) {
  const rv = ratedCard.review || {};
  const sid = extra.sid || `hub_${ratedCard.id}_${rv.date}_${rv.rating_num}_${ratedCard.reps}`;
  const e = {
    // --- engram.py `rate --file` item contract ---
    topic: ratedCard.topic || null,
    node: ratedCard.id,
    rating: rv.rating,
    kind: extra.kind || 'review',            // engram.py:55 KINDS
    grade: extra.grade || rv.grade,          // engram.py:51 GRADES
    confidence: extra.confidence === undefined ? null : extra.confidence,
    source: extra.source || 'hub',
    sid,
    // --- provisional mirror of what the browser computed (engram recomputes) ---
    ts_client: rv.date,
    s_before: rv.s_before,
    s_after: rv.s_after,
    d_after: rv.difficulty_after,
    interval_days: rv.interval_days,
    due_next: ratedCard.due,
    retrievability: rv.retrievability,
    elapsed_days: rv.elapsed_days,
    days_since_encode: rv.days_since_encode,
    reps: ratedCard.reps,
    lapses: ratedCard.lapses,
    state: ratedCard.state,
    desired_retention: rv.desired_retention,
    engine: 'engram-hub-fsrs45',
  };
  if (extra.production) e.production = String(extra.production).slice(0, 800); // PRODUCTION_MAX
  if (extra.misconceptions) e.misconceptions = extra.misconceptions;
  if (extra.rubric_notes) e.rubric_notes = extra.rubric_notes;
  if (extra.error_class === 'slip' || extra.error_class === 'conceptual') {
    e.error_class = extra.error_class;       // engram.py:67 ERROR_CLASSES
  }
  return e;
}

/**
 * Replay a review-log into a card, in order — the browser-side equivalent of
 * engram's receipt replay. Used by the "did the hub and the engine agree?"
 * reconciliation view and by the test page.
 * @param {object} card starting card (usually initCard())
 * @param {Array<{rating:string, ts_client:string, desired_retention?:number}>} entries
 * @returns {object} final card
 */
export function replay(card, entries) {
  let c = card;
  for (const e of entries) {
    c = applyRating(c, e.rating, e.ts_client || e.ts, {
      desiredRetention: asNumber(e.desired_retention, RETENTION_DEFAULT),
      intervalMultiplier: asNumber(e.interval_multiplier, 1.0),
    });
  }
  return c;
}
