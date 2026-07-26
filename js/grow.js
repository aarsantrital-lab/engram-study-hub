/* =============================================================================
   js/grow.js — the GROW grid model + the "what should I study now?" decision.
   Job: HOME + GROW GRID.  Imports: store, vault, config, scheduler(+fsrs),
   router, search-index.  Imported by: js/views/home.js (and, by design, by the
   stats view — the unit model is deliberately reusable).

   WHAT THIS FILE IS
   -----------------
   pedagogy-spec §2 Tier 0: "GROW grid as home screen — rows = every CDC unit,
   cells = self-rated R/Y/G cross-checked against measured accuracy, sorted by
   weakness × teaching-hours × staleness, one 'What should I study now?' button."

   Three ideas, kept separate on purpose:

     1. THE UNIT MODEL (`CDC_UNITS`) — the real NEB/CDC Grade 11 unit lists with
        their TEACHING HOURS. neb-nepal §5: CDC publishes no unit-wise marks
        weightage; teaching hours are the only sanctioned weight proxy. Never
        invent chapter marks.

     2. THE MEASURED SIDE — accuracy and staleness read out of the review log
        and the FSRS card store. Pretests and probes are excluded: a pretest
        score is "never displayed, never counted" (pedagogy-spec §1.0).

     3. THE CROSS-CHECK — self-rating vs measured accuracy. A unit rated green
        that measures 48% is the illusion-of-competence flag; that gap is the
        single most useful diagnostic on the screen.

   RULES OBSERVED HERE
     · every date via store's LOCAL helpers (build-constraints §9.1)
     · store API only, never raw localStorage
     · minutes, never due counts (pedagogy-spec §1.6)
     · marks-language; no vague praise; no computer-science analogies
   ========================================================================== */

import {
  store, KEYS, todayLocalISO, diffDaysISO, daysFromToday, localISO,
} from './store.js';
import { getTopics, getAllCards, isVaultMissing, onVaultChange } from './vault.js';
import CONFIG, { getSettings, SUBJECT_ICONS } from './config.js';
import { initCard, isNew, isDue, buildSession, estSecondsFor, SCHEDULER_DEFAULTS } from './scheduler.js';
import { routeFor } from './router.js';
import { searchIndex } from './search-index.js';

/* =============================================================================
   1. SELF-RATING VOCABULARY
   ========================================================================== */

export const GROW_RATINGS = Object.freeze(['R', 'Y', 'G']);

/**
 * The three cells. `weakness` is what feeds the sort; the wording is
 * exam-shaped ("cold", "book open"), never a feelings scale.
 */
export const RATING_META = Object.freeze({
  R: Object.freeze({
    key: 'R', label: 'Red', short: 'R',
    meaning: 'Shaky — I would lose most of the marks today',
    tone: 'bad', status: 'lapsed', weakness: 1.0,
  }),
  Y: Object.freeze({
    key: 'Y', label: 'Amber', short: 'Y',
    meaning: 'Partly there — I need the book open',
    tone: 'warn', status: 'due-soon', weakness: 0.6,
  }),
  G: Object.freeze({
    key: 'G', label: 'Green', short: 'G',
    meaning: 'Solid — I can answer this cold, under time',
    tone: 'good', status: 'mastered', weakness: 0.25,
  }),
});

/** Weakness assumed for a unit he has never rated. Between amber and red. */
const UNRATED_WEAKNESS = 0.75;

/** Reviews needed before measured accuracy is allowed to move the sort. */
export const MEASURED_MIN_REVIEWS = 6;

/** Review-log window used for "measured accuracy" (days). */
const MEASURED_WINDOW_DAYS = 120;

/** Staleness saturates here — a unit untouched for a month is maximally stale. */
const STALENESS_CAP_DAYS = 30;

/** Biggest single unit in the syllabus (Chemistry of non-metals, 22 h). */
const MAX_UNIT_HOURS = 22;

/* =============================================================================
   2. THE CDC UNIT MODEL  (neb-nepal §5 — hours are the only weight proxy)
   ========================================================================== */

/**
 * @typedef {Object} GrowUnit
 * @property {string}  id        stable slug, e.g. 'phy-gravitation'. PERSISTED
 *                               in KEYS.GROW and used in routes — never rename
 *                               one without a migration.
 * @property {string}  subject   'Physics' | 'Chemistry' | …
 * @property {string}  name      the CDC unit name
 * @property {string}  domain    CDC domain grouping (teaching order)
 * @property {number}  hours     CDC teaching hours — the sanctioned weight
 * @property {number}  order     position in the school's teaching sequence
 * @property {boolean} numerical carries a numerical component (neb-nepal §6)
 * @property {string[]} aliases  other names the vault/textbook may use
 * @property {string[]} parts    sub-topics, for the fat units
 */

const PHYSICS_UNITS = [
  // ---- Mechanics + Elasticity — 45 h (35% of the course, front-loaded) -----
  { name: 'Physical quantities', domain: 'Mechanics', hours: 3, numerical: true,
    aliases: ['units and dimensions', 'dimensional analysis', 'measurement'] },
  { name: 'Vectors', domain: 'Mechanics', hours: 4, numerical: true,
    aliases: ['vector algebra', 'resolution of vectors'] },
  { name: 'Kinematics', domain: 'Mechanics', hours: 5, numerical: true,
    aliases: ['motion in a straight line', 'projectile motion', 'relative velocity'] },
  { name: 'Dynamics', domain: 'Mechanics', hours: 6, numerical: true,
    aliases: ["newton's laws", 'laws of motion', 'momentum', 'impulse'] },
  { id: 'work-energy-power', name: 'Work, energy and power', domain: 'Mechanics', hours: 6, numerical: true,
    aliases: ['work energy theorem', 'conservation of energy'] },
  { name: 'Circular motion', domain: 'Mechanics', hours: 6, numerical: true,
    aliases: ['centripetal force', 'banking of roads'] },
  { name: 'Gravitation', domain: 'Mechanics', hours: 10, numerical: true,
    aliases: ['universal law of gravitation', 'escape velocity', 'orbital velocity', 'variation of g'] },
  { name: 'Elasticity', domain: 'Mechanics', hours: 5, numerical: true,
    aliases: ["hooke's law", "young's modulus", 'stress and strain'] },

  // ---- Heat and Thermodynamics — 26 h -------------------------------------
  { id: 'heat-temperature', name: 'Heat and temperature', domain: 'Heat', hours: 3, numerical: false,
    aliases: ['thermometry', 'temperature scales'] },
  { name: 'Thermal expansion', domain: 'Heat', hours: 4, numerical: true,
    aliases: ['linear expansion', 'cubical expansion', 'expansion of liquids'] },
  { name: 'Quantity of heat', domain: 'Heat', hours: 6, numerical: true,
    aliases: ['calorimetry', 'specific heat capacity', 'latent heat'] },
  { name: 'Rate of heat flow', domain: 'Heat', hours: 5, numerical: true,
    aliases: ['thermal conduction', 'conductivity', 'radiation', 'convection'] },
  { name: 'Ideal gas', domain: 'Heat', hours: 8, numerical: true,
    aliases: ['kinetic theory of gases', 'gas laws', 'ideal gas equation'] },

  // ---- Waves and Optics — 15 h --------------------------------------------
  { id: 'curved-mirrors', name: 'Reflection at curved mirrors', domain: 'Optics', hours: 2, numerical: true,
    aliases: ['spherical mirrors', 'mirror formula', 'ray diagram'] },
  { id: 'refraction-plane', name: 'Refraction at plane surfaces', domain: 'Optics', hours: 4, numerical: true,
    aliases: ['refractive index', 'total internal reflection', 'critical angle'] },
  { id: 'prisms', name: 'Refraction through prisms', domain: 'Optics', hours: 3, numerical: true,
    aliases: ['prism', 'angle of deviation', 'minimum deviation'] },
  { name: 'Lenses', domain: 'Optics', hours: 3, numerical: true,
    aliases: ['lens formula', 'power of lens', 'lens maker formula'] },
  { name: 'Dispersion', domain: 'Optics', hours: 3, numerical: false,
    aliases: ['spectrum', 'chromatic aberration', 'dispersive power'] },

  // ---- Electricity and Magnetism — 27 h -----------------------------------
  { name: 'Electric charges', domain: 'Electricity', hours: 3, numerical: true,
    aliases: ["coulomb's law", 'electrostatics', 'charging'] },
  { name: 'Electric field', domain: 'Electricity', hours: 3, numerical: true,
    aliases: ['electric field intensity', "gauss's law", 'field lines'] },
  { id: 'potential', name: 'Potential, potential difference and potential energy', domain: 'Electricity', hours: 4, numerical: true,
    aliases: ['electric potential', 'equipotential', 'electron volt'] },
  { name: 'Capacitor', domain: 'Electricity', hours: 7, numerical: true,
    aliases: ['capacitance', 'parallel plate capacitor', 'dielectric', 'combination of capacitors'] },
  { name: 'DC circuits', domain: 'Electricity', hours: 10, numerical: true,
    aliases: ['current electricity', "ohm's law", "kirchhoff's laws", 'wheatstone bridge', 'potentiometer', 'resistivity'] },

  // ---- Modern Physics — 15 h ----------------------------------------------
  { name: 'Nuclear physics', domain: 'Modern physics', hours: 6, numerical: true,
    aliases: ['radioactivity', 'half life', 'binding energy', 'nuclear fission'] },
  { name: 'Solids', domain: 'Modern physics', hours: 3, numerical: false,
    aliases: ['crystal structure', 'energy bands', 'semiconductors'] },
  { id: 'recent-trends', name: 'Recent trends in physics', domain: 'Modern physics', hours: 6, numerical: false,
    aliases: ['particle physics', 'quarks', 'universe', 'cosmology'] },
];

const CHEMISTRY_UNITS = [
  // ---- General and Physical Chemistry — 48 h ------------------------------
  { id: 'foundation', name: 'Foundation and fundamentals', domain: 'General and physical', hours: 2, numerical: false,
    aliases: ['fundamentals of chemistry', 'basic concepts'] },
  { name: 'Stoichiometry', domain: 'General and physical', hours: 8, numerical: true,
    aliases: ['mole concept', 'limiting reactant', 'limiting reagent', 'empirical formula', 'percentage composition', 'equivalent weight'],
    parts: ['Mole concept', 'Limiting reactant', 'Empirical and molecular formula', 'Percentage composition'] },
  { name: 'Atomic structure', domain: 'General and physical', hours: 8, numerical: true,
    aliases: ['quantum numbers', 'electronic configuration', 'bohr model', 'orbitals'] },
  { id: 'periodic-classification', name: 'Periodic classification of elements', domain: 'General and physical', hours: 5, numerical: false,
    aliases: ['periodic table', 'periodic properties', 'periodicity'] },
  { id: 'bonding', name: 'Chemical bonding and shapes of molecules', domain: 'General and physical', hours: 9, numerical: false,
    aliases: ['chemical bonding', 'vsepr', 'hybridisation', 'hybridization', 'ionic bond', 'covalent bond'] },
  { id: 'redox', name: 'Oxidation and reduction', domain: 'General and physical', hours: 5, numerical: true,
    aliases: ['redox', 'oxidation number', 'balancing redox equations'] },
  { name: 'States of matter', domain: 'General and physical', hours: 8, numerical: true,
    aliases: ['gas laws', "graham's law", "dalton's law", 'liquid state', 'solid state', 'vapour pressure'] },
  { name: 'Chemical equilibrium', domain: 'General and physical', hours: 3, numerical: true,
    aliases: ['equilibrium constant', 'le chatelier', 'kc kp'] },

  // ---- Inorganic Chemistry — 35 h -----------------------------------------
  { id: 'non-metals', name: 'Chemistry of non-metals', domain: 'Inorganic', hours: 22, numerical: false,
    aliases: ['non metals', 'hydrogen', 'oxygen', 'ozone', 'nitrogen', 'halogens', 'sulphur', 'sulfur', 'phosphorus'],
    parts: ['Hydrogen, oxygen and ozone (4 h)', 'Nitrogen (5 h)', 'Halogens (5 h)', 'Sulphur (5 h)', 'Carbon and phosphorus (3 h)'] },
  { id: 'metals', name: 'Chemistry of metals', domain: 'Inorganic', hours: 10, numerical: false,
    aliases: ['metallurgy', 'metallurgical principles', 'alkali metals', 'alkaline earth metals'],
    parts: ['Metallurgical principles (5 h)', 'Alkali and alkaline earth metals (5 h)'] },
  { id: 'bio-inorganic', name: 'Bio-inorganic chemistry', domain: 'Inorganic', hours: 3, numerical: false,
    aliases: ['bio inorganic', 'biological role of elements'] },

  // ---- Organic Chemistry — 30 h -------------------------------------------
  { id: 'organic-basics', name: 'Basic concepts of organic chemistry', domain: 'Organic', hours: 6, numerical: false,
    aliases: ['organic basics', 'iupac nomenclature', 'functional groups', 'homologous series'] },
  { id: 'organic-principles', name: 'Fundamental principles of organic chemistry', domain: 'Organic', hours: 10, numerical: false,
    aliases: ['reaction mechanism', 'isomerism', 'inductive effect', 'resonance', 'electronic effects'],
    parts: ['Isomerism', 'Electronic effects', 'Reaction mechanisms', 'Purification methods'] },
  { name: 'Hydrocarbons', domain: 'Organic', hours: 8, numerical: false,
    aliases: ['alkanes', 'alkenes', 'alkynes', 'aliphatic hydrocarbons'] },
  { name: 'Aromatic hydrocarbons', domain: 'Organic', hours: 6, numerical: false,
    aliases: ['benzene', 'aromaticity', 'electrophilic substitution'] },

  // ---- Applied Chemistry — 15 h -------------------------------------------
  { id: 'applied-fundamentals', name: 'Fundamentals of applied chemistry', domain: 'Applied', hours: 4, numerical: false,
    aliases: ['applied chemistry', 'chemistry in daily life'] },
  { id: 'modern-manufactures', name: 'Modern chemical manufactures', domain: 'Applied', hours: 11, numerical: false,
    aliases: ['haber process', 'solvay process', 'contact process', 'caustic soda', 'sodium carbonate', 'industrial chemistry'],
    parts: ['Haber process', 'Solvay process (sodium carbonate)', 'Caustic soda', 'Extraction of sodium'] },
];

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function buildUnits(subject, prefix, list) {
  return list.map((u, i) => Object.freeze({
    id: prefix + '-' + (u.id || slugify(u.name)),
    subject,
    name: u.name,
    domain: u.domain,
    hours: u.hours,
    order: i,
    numerical: Boolean(u.numerical),
    aliases: Object.freeze((u.aliases || []).slice()),
    parts: Object.freeze((u.parts || []).slice()),
  }));
}

/**
 * The seeded unit spine. Physics + Chemistry are the real CDC Grade 11 lists
 * (neb-nepal §5.1/§5.2, 128 theory hours each). Maths, Computer Science,
 * English, Nepali and Social Studies are deliberately absent until their CDC
 * unit lists are confirmed — an invented syllabus is worse than none.
 * @type {ReadonlyArray<GrowUnit>}
 */
export const CDC_UNITS = Object.freeze([
  ...buildUnits('Physics', 'phy', PHYSICS_UNITS),
  ...buildUnits('Chemistry', 'chem', CHEMISTRY_UNITS),
]);

/** Subjects that currently have a seeded unit spine, in teaching order. */
export const GROW_SUBJECTS = Object.freeze(
  CDC_UNITS.reduce((acc, u) => (acc.includes(u.subject) ? acc : acc.concat(u.subject)), [])
);

/** Total CDC theory hours per subject (Physics 128, Chemistry 128). */
export const SUBJECT_HOURS = Object.freeze(
  GROW_SUBJECTS.reduce((acc, s) => {
    acc[s] = CDC_UNITS.filter((u) => u.subject === s).reduce((n, u) => n + u.hours, 0);
    return acc;
  }, {})
);

const UNIT_BY_ID = new Map(CDC_UNITS.map((u) => [u.id, u]));

/** @returns {GrowUnit[]} */
export function getUnits(subject) {
  return subject ? CDC_UNITS.filter((u) => u.subject === subject) : CDC_UNITS.slice();
}

/** @returns {GrowUnit|null} */
export function getUnit(id) { return UNIT_BY_ID.get(String(id || '')) || null; }

/* --- alias lookup: vault frontmatter / topic names -> unit id -------------- */

function normKey(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** normalised alias -> unitId. Longest keys first so 'dc circuits' wins. */
const ALIAS_INDEX = (() => {
  const pairs = [];
  for (const u of CDC_UNITS) {
    pairs.push([normKey(u.name), u.id]);
    pairs.push([normKey(u.id), u.id]);
    for (const a of u.aliases) pairs.push([normKey(a), u.id]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.filter((p) => p[0].length >= 3);
})();

/**
 * Resolve a free-text unit/topic name onto a CDC unit id.
 * Exact match first, then longest-alias containment. Returns null rather than
 * guessing wildly — build-constraints §9.4: subject/unit are DECLARED, never
 * keyword-sniffed. This is a display-side convenience, not a data source.
 * @param {string} text
 * @param {string} [subject] restricts the match when known
 * @returns {string|null} unit id
 */
export function resolveUnitId(text, subject) {
  const key = normKey(text);
  if (!key) return null;
  for (const [alias, id] of ALIAS_INDEX) {
    if (alias !== key) continue;
    if (subject && UNIT_BY_ID.get(id).subject !== subject) continue;
    return id;
  }
  for (const [alias, id] of ALIAS_INDEX) {
    if (alias.length < 5) continue;
    if (subject && UNIT_BY_ID.get(id).subject !== subject) continue;
    if (key.includes(alias)) return id;
  }
  return null;
}

/* =============================================================================
   3. SELF-RATINGS  (KEYS.GROW: unitId -> {selfRating, measured, updatedISO})
   ========================================================================== */

/** The whole GROW map. Never returns null. */
export function getGrowState() {
  const raw = store.get(KEYS.GROW, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** @returns {'R'|'Y'|'G'|null} */
export function getSelfRating(unitId) {
  const e = getGrowState()[String(unitId)];
  const r = e && e.selfRating;
  return GROW_RATINGS.includes(r) ? r : null;
}

/**
 * Set (or clear, by passing the same value again / null) a self-rating.
 * @param {string} unitId
 * @param {'R'|'Y'|'G'|null} rating
 * @returns {boolean} false = the write was refused (quota). Nothing is deleted.
 */
export function setSelfRating(unitId, rating) {
  const id = String(unitId || '');
  if (!id) return false;
  const value = GROW_RATINGS.includes(rating) ? rating : null;
  const next = Object.assign({}, getGrowState());
  const prev = next[id] || {};
  next[id] = Object.assign({}, prev, {
    selfRating: value,
    updatedISO: todayLocalISO(),
    ratedTs: Date.now(),
  });
  const ok = store.set(KEYS.GROW, next);
  invalidate();
  return ok;
}

/** Days since he last moved this unit's self-rating (null = never rated). */
function ratedAgeDays(entry) {
  if (!entry || !entry.updatedISO) return null;
  const d = diffDaysISO(entry.updatedISO, todayLocalISO());
  return Number.isFinite(d) ? Math.max(0, d) : null;
}

/* =============================================================================
   4. MEASURED SIDE — cards, dueness, accuracy, staleness
   ========================================================================== */

let _cache = null;

/** Drop the memo. Called on any store write and on a vault reload. */
export function invalidate() { _cache = null; }

try {
  store.subscribe('*', invalidate);
  onVaultChange(invalidate);
} catch (_) { /* non-browser harness — the memo is simply never invalidated */ }

/**
 * Every FSRS card the scheduler should see: the vault's flashcards merged with
 * whatever state KEYS.SRS holds for them, plus any SRS card the vault no longer
 * carries (orphans still owe reviews) and the student's own cards.
 * @returns {object[]} cards in the fsrs.js card shape
 */
function collectCards(topicUnit) {
  const srs = store.get(KEYS.SRS, {}) || {};
  const out = [];
  const seen = new Set();

  for (const c of getAllCards()) {
    const id = String(c.id);
    seen.add(id);
    const saved = srs[id] && typeof srs[id] === 'object' ? srs[id] : null;
    const base = initCard(id, {
      topic: c.topicId, subject: c.subject, unit: topicUnit.get(c.topicId) || null,
    });
    out.push(saved ? Object.assign(base, saved, {
      id,
      topic: saved.topic || c.topicId,
      subject: saved.subject || c.subject,
      unit: topicUnit.get(c.topicId) || saved.unit || null,
    }) : base);
  }

  const userCards = store.get(KEYS.USER_CARDS, {}) || {};
  for (const [topicId, list] of Object.entries(userCards)) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const id = c && String(c.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const saved = srs[id] && typeof srs[id] === 'object' ? srs[id] : null;
      const base = initCard(id, { topic: topicId, unit: topicUnit.get(topicId) || null });
      out.push(saved ? Object.assign(base, saved, { id }) : base);
    }
  }

  for (const [id, saved] of Object.entries(srs)) {
    if (seen.has(id) || !saved || typeof saved !== 'object') continue;
    out.push(Object.assign(initCard(id, {}), saved, { id }));
  }

  return out;
}

/**
 * Build (or reuse) the whole measured index in one pass.
 * @returns {{today:string, topicUnit:Map, cardUnit:Map, cards:object[],
 *            byUnit:Map<string,object>, topicsByUnit:Map<string,object[]>}}
 */
function index() {
  if (_cache) return _cache;

  const today = todayLocalISO();
  const topicUnit = new Map();      // topicId -> unitId
  const topicsByUnit = new Map();   // unitId  -> [topic]

  for (const t of getTopics()) {
    const uid = resolveUnitId(t.unit, t.subject)
      || resolveUnitId(t.name, t.subject)
      || resolveUnitId(t.unit)
      || resolveUnitId(t.name);
    if (!uid) continue;
    topicUnit.set(t.id, uid);
    if (!topicsByUnit.has(uid)) topicsByUnit.set(uid, []);
    topicsByUnit.get(uid).push(t);
  }

  const cards = collectCards(topicUnit);
  const cardUnit = new Map();
  const byUnit = new Map();
  for (const u of CDC_UNITS) {
    byUnit.set(u.id, {
      cards: [], due: 0, dueSeconds: 0, newCount: 0, seen: 0, lastReviewTs: 0,
      correct: 0, reviews: 0,
    });
  }

  for (const c of cards) {
    const uid = c.unit && byUnit.has(c.unit) ? c.unit : (topicUnit.get(c.topic) || null);
    if (!uid || !byUnit.has(uid)) continue;
    cardUnit.set(c.id, uid);
    const bucket = byUnit.get(uid);
    bucket.cards.push(c);
    if (isNew(c)) bucket.newCount += 1; else bucket.seen += 1;
    if (isDue(c, today)) { bucket.due += 1; bucket.dueSeconds += estSecondsFor(c); }
  }

  // --- review log: measured accuracy + real staleness ---------------------
  const since = Date.now() - MEASURED_WINDOW_DAYS * 86400000;
  let log = [];
  try { log = store.getReviewLog({ since }) || []; } catch (_) { log = []; }
  for (const e of log) {
    if (!e || !e.cardId) continue;
    // pedagogy-spec §1.0: a pretest score is never displayed and never counted.
    if (e.kind === 'pretest' || e.probe) continue;
    const uid = cardUnit.get(String(e.cardId));
    if (!uid) continue;
    const bucket = byUnit.get(uid);
    bucket.reviews += 1;
    const good = e.grade ? e.grade === 'recalled' : Number(e.rating) >= 3;
    if (good) bucket.correct += 1;
    if (e.ts > bucket.lastReviewTs) bucket.lastReviewTs = e.ts;
  }

  // Cards carry a `last` even when the log was trimmed or synced elsewhere.
  for (const [uid, bucket] of byUnit) {
    void uid;
    for (const c of bucket.cards) {
      const last = c.last || c.lastISO;
      if (!last) continue;
      const ts = Date.parse(last + 'T00:00:00');
      if (Number.isFinite(ts) && ts > bucket.lastReviewTs) bucket.lastReviewTs = ts;
    }
  }

  _cache = { today, topicUnit, cardUnit, cards, byUnit, topicsByUnit };
  return _cache;
}

/** Every FSRS card, vault + store merged. Reused by the study/stats views. */
export function allCards() { return index().cards.slice(); }

/** Vault topics that belong to a unit (may be empty). */
export function topicsForUnit(unitId) {
  return (index().topicsByUnit.get(String(unitId)) || []).slice();
}

/* =============================================================================
   5. ROWS — the GROW grid model, one row per CDC unit
   ========================================================================== */

/**
 * @typedef {Object} GrowRow
 * @property {GrowUnit} unit
 * @property {'R'|'Y'|'G'|null} selfRating
 * @property {number|null} measured      0..1 accuracy, null when under-sampled
 * @property {number} reviews            reviews counted in the window
 * @property {number} weakness           0..1, the sort's first factor
 * @property {number|null} stalenessDays null = never touched
 * @property {number} score              weakness × hours × staleness × …
 * @property {{kind:string, severity:string, message:string}|null} illusion
 * @property {number} cardCount
 * @property {number} dueCount           INTERNAL — render minutes, not counts
 * @property {number} dueMinutes
 * @property {boolean} hasContent
 * @property {string} status             data-status value
 */

function weaknessOf(selfRating, measured, reviews) {
  const selfWeak = selfRating ? RATING_META[selfRating].weakness : UNRATED_WEAKNESS;
  if (measured === null || reviews < MEASURED_MIN_REVIEWS) return selfWeak;
  const measuredWeak = 1 - measured;
  return 0.45 * selfWeak + 0.55 * measuredWeak;
}

/**
 * The illusion-of-competence cross-check (pedagogy-spec Tier 0).
 * Only fires with enough measured data — a two-review sample says nothing.
 */
function illusionOf(selfRating, measured, reviews) {
  if (measured === null || reviews < MEASURED_MIN_REVIEWS || !selfRating) return null;
  const pct = Math.round(measured * 100);
  if (selfRating === 'G' && measured < 0.70) {
    return {
      kind: 'overrated',
      severity: measured < 0.55 ? 'bad' : 'warn',
      message: 'Rated green, measured ' + pct + '% recall. That gap is where marks go missing.',
    };
  }
  if (selfRating === 'Y' && measured < 0.50) {
    return {
      kind: 'overrated', severity: 'warn',
      message: 'Rated amber, measured ' + pct + '% recall. Closer to red than it feels.',
    };
  }
  if (selfRating === 'R' && measured >= 0.85) {
    return {
      kind: 'underrated', severity: 'good',
      message: 'Rated red, measured ' + pct + '% recall. The marks are already there.',
    };
  }
  return null;
}

/**
 * Build one row per CDC unit.
 * @param {{subject?:string, sort?:'priority'|'syllabus'}} [opts]
 * @returns {GrowRow[]}
 */
export function buildRows(opts) {
  const o = opts || {};
  const ix = index();
  const grow = getGrowState();
  const rows = [];

  for (const unit of CDC_UNITS) {
    if (o.subject && unit.subject !== o.subject) continue;
    const bucket = ix.byUnit.get(unit.id);
    const entry = grow[unit.id] || null;
    const selfRating = entry && GROW_RATINGS.includes(entry.selfRating) ? entry.selfRating : null;

    const reviews = bucket.reviews;
    const measured = reviews > 0 ? bucket.correct / reviews : null;

    const ratedAge = ratedAgeDays(entry);
    const reviewAge = bucket.lastReviewTs
      ? Math.max(0, diffDaysISO(localISO(new Date(bucket.lastReviewTs)), ix.today))
      : null;
    const stalenessDays = reviewAge === null
      ? (ratedAge === null ? null : ratedAge)
      : (ratedAge === null ? reviewAge : Math.min(reviewAge, ratedAge));

    const weakness = weaknessOf(selfRating, measured, reviews);
    const hoursW = 0.55 + 0.45 * (unit.hours / MAX_UNIT_HOURS);
    const staleW = 1 + Math.min(stalenessDays === null ? STALENESS_CAP_DAYS : stalenessDays,
      STALENESS_CAP_DAYS) / STALENESS_CAP_DAYS;
    const hasContent = bucket.cards.length > 0 || (ix.topicsByUnit.get(unit.id) || []).length > 0;
    // An untaught unit stays visible but must not outrank a unit that owes work.
    const readiness = hasContent ? 1 : 0.55;
    const overdueBoost = 1 + Math.min(bucket.due, 20) / 40;
    const illusion = illusionOf(selfRating, measured, reviews);

    rows.push({
      unit,
      selfRating,
      measured,
      reviews,
      weakness,
      stalenessDays,
      score: Math.round(weakness * hoursW * staleW * readiness * overdueBoost * 1000) / 10,
      illusion,
      cardCount: bucket.cards.length,
      newCount: bucket.newCount,
      dueCount: bucket.due,
      dueMinutes: Math.round(bucket.dueSeconds / 60),
      hasContent,
      // The row's colour follows the MEASURED truth, not the claim: a unit he
      // rated green that measures 40% shows amber, with his green still
      // pressed. The disagreement is the whole point of the cross-check.
      status: illusion && illusion.kind === 'overrated'
        ? 'weak'
        : (selfRating ? RATING_META[selfRating].status : 'new'),
      topics: ix.topicsByUnit.get(unit.id) || [],
    });
  }

  if (o.sort === 'priority') {
    rows.sort((a, b) => b.score - a.score
      || b.unit.hours - a.unit.hours
      || a.unit.subject.localeCompare(b.unit.subject)
      || a.unit.order - b.unit.order);
  }
  return rows;
}

/** Counts for the section headers. Never a due count — ratings only. */
export function growSummary(subject) {
  const rows = buildRows({ subject });
  const out = { total: rows.length, R: 0, Y: 0, G: 0, unrated: 0, illusions: 0, hours: 0, ratedHours: 0 };
  for (const r of rows) {
    out.hours += r.unit.hours;
    if (r.selfRating) { out[r.selfRating] += 1; out.ratedHours += r.unit.hours; } else out.unrated += 1;
    if (r.illusion && r.illusion.kind === 'overrated') out.illusions += 1;
  }
  out.ratedPct = out.total ? Math.round(((out.total - out.unrated) / out.total) * 100) : 0;
  return out;
}

/* =============================================================================
   6. THE DECISION — "What should I study now?"
   ========================================================================== */

/** First lesson document of a unit's topics, if the vault has one. */
function nextLessonFor(row) {
  for (const t of row.topics) {
    for (const d of t.docs || []) {
      if (d.kind === 'lesson' || /\/lessons\//.test(String(d.url || ''))) {
        return { topicId: t.id, doc: d };
      }
    }
  }
  return null;
}

/**
 * Turn a row into its ONE next action. Three kinds only, in priority order:
 *   'review'  something is due — retrieval is the daily engine (§1.5)
 *   'lesson'  nothing due and a lesson exists — encode before cards (§1.2/§1.4)
 *   'drill'   everything else — exam-shaped practice (§1.7)
 * @param {GrowRow} row
 * @returns {{kind:string, label:string, detail:string, route:string, icon:string}}
 */
export function actionFor(row) {
  const unit = row.unit;

  if (row.dueCount > 0) {
    const mins = Math.max(1, row.dueMinutes || 1);
    return {
      kind: 'review',
      label: 'Start the review queue',
      detail: 'about ' + mins + ' ' + (mins === 1 ? 'minute' : 'minutes') + ' of retrieval',
      route: routeFor('study', { unit: unit.id, subject: unit.subject, mode: 'review' }),
      icon: 'layers',
    };
  }

  const lesson = nextLessonFor(row);
  if (lesson) {
    return {
      kind: 'lesson',
      label: 'Open the next lesson',
      detail: lesson.doc.title || 'lesson',
      route: routeFor('lesson', { topic: lesson.topicId, file: lesson.doc.url }),
      icon: 'book-open',
    };
  }

  if (!row.hasContent) {
    return {
      kind: 'lesson',
      label: 'Build this unit',
      detail: 'no material here yet — start with the coverage tree',
      route: routeFor('study', { unit: unit.id, subject: unit.subject, mode: 'encode' }),
      icon: 'waypoints',
    };
  }

  return {
    kind: 'drill',
    label: unit.numerical ? 'Drill the numericals' : 'Drill exam questions',
    detail: unit.numerical
      ? 'formula, substitution, units, significant figures'
      : 'short answers and diagrams, marked line by line',
    route: routeFor('study', { unit: unit.id, subject: unit.subject, mode: 'drill' }),
    icon: unit.numerical ? 'calculator' : 'file-text',
  };
}

/** The sentence that explains the choice. Rationale, never a command. */
function reasonFor(row) {
  const bits = [];
  if (row.selfRating === 'R') bits.push('you rated it red');
  else if (row.selfRating === 'Y') bits.push('you rated it amber');
  else if (!row.selfRating) bits.push('you have not rated it yet');
  if (row.measured !== null && row.reviews >= MEASURED_MIN_REVIEWS) {
    bits.push('measured recall ' + Math.round(row.measured * 100) + '%');
  }
  bits.push(row.unit.hours + ' teaching hours');
  if (row.stalenessDays === null) bits.push('not started yet');
  else if (row.stalenessDays >= 1) bits.push('last touched ' + row.stalenessDays + (row.stalenessDays === 1 ? ' day ago' : ' days ago'));
  return 'The reason this is first: ' + bits.join(', ') + '.';
}

/**
 * THE decision. Reddest × heaviest × stalest, routed to its next action.
 *
 * @param {{subject?:string, exclude?:string[], alternatives?:number}} [opts]
 * @returns {{
 *   unit:GrowUnit, row:GrowRow, action:object, reason:string, score:number,
 *   alternatives:{unit:GrowUnit, row:GrowRow, action:object, reason:string}[],
 *   empty:boolean
 * }}
 */
export function pickNext(opts) {
  const o = opts || {};
  const exclude = new Set(o.exclude || []);
  const rows = buildRows({ subject: o.subject, sort: 'priority' })
    .filter((r) => !exclude.has(r.unit.id));

  if (!rows.length) {
    return {
      unit: null, row: null, empty: true, score: 0, alternatives: [],
      action: { kind: 'drill', label: 'Open Study', detail: '', route: routeFor('study'), icon: 'layers' },
      reason: 'No units are loaded yet.',
    };
  }

  const decorate = (r) => ({ unit: r.unit, row: r, action: actionFor(r), reason: reasonFor(r), score: r.score });
  const top = decorate(rows[0]);

  // Autonomy support (pedagogy-spec §3.7): two alternates, ideally from a
  // different subject so the choice is real rather than cosmetic.
  const wantAlts = o.alternatives === undefined ? 2 : Math.max(0, o.alternatives);
  const alts = [];
  const otherSubject = rows.find((r) => r.unit.subject !== rows[0].unit.subject);
  if (otherSubject && wantAlts > 0) alts.push(decorate(otherSubject));
  for (const r of rows.slice(1)) {
    if (alts.length >= wantAlts) break;
    if (alts.some((a) => a.unit.id === r.unit.id)) continue;
    alts.push(decorate(r));
  }

  return Object.assign({}, top, { alternatives: alts.slice(0, wantAlts), empty: false });
}

/* =============================================================================
   7. TODAY'S LOAD — minutes, never a due count (pedagogy-spec §1.6)
   ========================================================================== */

/**
 * @returns {{label:string, estMinutes:number, budgetMin:number, hasWork:boolean,
 *            reviewMinutes:number, newMinutes:number, session:object}}
 */
export function todayLoad(opts) {
  const settings = getSettings();
  const budgetMin = Math.max(1, Number(settings.dailyMinutes) || SCHEDULER_DEFAULTS.timeBudgetMin);
  const cards = index().cards;
  const session = buildSession(cards, null, Object.assign({ timeBudgetMin: budgetMin }, opts || {}));

  let reviewSeconds = 0;
  for (const c of session.reviews) reviewSeconds += estSecondsFor(c);
  let newSeconds = 0;
  for (const c of session.news) newSeconds += estSecondsFor(c);

  return {
    label: session.label,
    estMinutes: Math.round(session.budget.estSeconds / 60),
    budgetMin,
    reviewMinutes: Math.round(reviewSeconds / 60),
    newMinutes: Math.round(newSeconds / 60),
    hasWork: session.queue.length > 0,
    full: session.budget.full,
    session,
  };
}

/* =============================================================================
   8. EXAM CALENDAR  (neb-nepal §1 — extrapolated; VAC confirms in week 1)
   ========================================================================== */

/** Store key. Not in KEYS yet — see the report's shared-file requests. */
export const EXAM_CALENDAR_KEY = 'examCalendar';

/**
 * Seeded milestones. AD dates are the LOW-confidence extrapolation of the
 * 2082/83 cycle onto 2083/84; BS values are month-level only because a
 * day-level BS conversion here would be invented. `confidence` is rendered.
 */
export const EXAM_CALENDAR_SEED = Object.freeze([
  { id: 'unit-test-1', label: 'Unit test', ad: '2026-09-03', bs: 'Bhadra 2083', confidence: 'low', kind: 'unit' },
  { id: 'terminal-1', label: 'First terminal', ad: '2026-11-24', bs: 'Mangsir 2083', confidence: 'low', kind: 'terminal' },
  { id: 'terminal-2', label: 'Second terminal', ad: '2027-02-23', bs: 'Falgun 2083', confidence: 'low', kind: 'terminal' },
  { id: 'pre-board', label: 'Pre-board model set', ad: '2027-04-13', bs: 'Baisakh 2084', confidence: 'low', kind: 'mock' },
  { id: 'practical', label: 'Practical exam', ad: '2027-05-09', bs: 'Baisakh 2084', confidence: 'low', kind: 'practical' },
  { id: 'final', label: 'Grade 11 final', ad: '2027-05-24', bs: 'Jestha 2084', confidence: 'med', kind: 'final' },
]);

function normaliseMilestone(m, i) {
  if (!m || typeof m !== 'object') return null;
  const ad = String(m.ad || m.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ad)) return null;
  return {
    id: String(m.id || 'exam-' + i),
    label: String(m.label || 'Exam'),
    ad,
    bs: m.bs ? String(m.bs) : '',
    confidence: ['high', 'med', 'low'].includes(m.confidence) ? m.confidence : 'low',
    kind: String(m.kind || 'exam'),
    subject: m.subject ? String(m.subject) : null,
  };
}

/** Read the calendar, seeding it on first run. Always sorted by date. */
export function getExamCalendar() {
  const raw = store.get(EXAM_CALENDAR_KEY, null);
  const list = Array.isArray(raw) ? raw : null;
  if (!list) {
    store.set(EXAM_CALENDAR_KEY, EXAM_CALENDAR_SEED.map((m) => Object.assign({}, m)));
    return EXAM_CALENDAR_SEED.map((m) => Object.assign({}, m));
  }
  return list.map(normaliseMilestone).filter(Boolean).sort((a, b) => a.ad.localeCompare(b.ad));
}

/** Overwrite the calendar (Settings / Hermes week-1 confirmation). */
export function setExamCalendar(list) {
  const clean = (Array.isArray(list) ? list : []).map(normaliseMilestone).filter(Boolean);
  const ok = store.set(EXAM_CALENDAR_KEY, clean);
  invalidate();
  return ok;
}

/**
 * The next `n` milestones with their countdowns.
 * @returns {{id,label,ad,bs,confidence,kind,days:number}[]}
 */
export function upcomingExams(n) {
  const today = todayLocalISO();
  return getExamCalendar()
    .map((m) => Object.assign({}, m, { days: daysFromToday(m.ad) }))
    .filter((m) => m.ad >= today)
    .slice(0, n === undefined ? 3 : n);
}

/* =============================================================================
   9. THE NIGHTLY LOOP STRIP  (pedagogy-spec §1.7 — 10:25 PM NPT)
   ========================================================================== */

/** '22:25' — 10:25 PM NPT, the canonical nightly-loop start. */
export const NIGHTLY_LOOP_TIME = CONFIG.NIGHTLY_LOOP || '22:25';

/**
 * Is tonight's loop still outstanding, and how far away is it?
 * `done` is supplied by the caller (the rings own that truth), so this stays
 * a pure clock helper.
 * @param {{now?:Date, done?:boolean}} [opts]
 * @returns {{time:string, done:boolean, pending:boolean, past:boolean,
 *            minutesAway:number, clock:string}}
 */
export function nightlyLoopState(opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  const parts = String(NIGHTLY_LOOP_TIME).split(':');
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10);
  const loopMinutes = (Number.isFinite(hh) ? hh : 22) * 60 + (Number.isFinite(mm) ? mm : 25);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const done = o.done === true;
  const minutesAway = loopMinutes - nowMinutes;
  const h12 = ((Math.floor(loopMinutes / 60) + 11) % 12) + 1;
  const suffix = loopMinutes >= 720 ? 'pm' : 'am';
  return {
    time: NIGHTLY_LOOP_TIME,
    clock: h12 + ':' + String(loopMinutes % 60).padStart(2, '0') + ' ' + suffix,
    done,
    past: minutesAway < 0,
    minutesAway,
    pending: !done,
  };
}

/* =============================================================================
   10. SEARCH — every CDC unit is findable, plus the decision as an Action
   ========================================================================== */

let searchRegistered = false;

/**
 * Register the 'grow' provider (units + the "what should I study now?" action).
 * Idempotent; safe to call from home.render(). Providers re-run on rebuild, so
 * routes always reflect the current next action.
 */
export function registerUnitSearch() {
  if (searchRegistered) return;
  searchRegistered = true;
  searchIndex.registerProvider('grow', () => {
    const entries = [];
    try {
      for (const row of buildRows()) {
        const u = row.unit;
        const rating = row.selfRating ? RATING_META[row.selfRating].label : 'not rated';
        entries.push({
          id: 'grow:' + u.id,
          type: 'topic',
          title: u.name,
          subtitle: u.subject + ' · ' + u.hours + ' teaching hours · ' + rating,
          body: [u.subject, u.domain, u.aliases.join(' '), u.parts.join(' '), 'cdc unit syllabus grow'].join(' '),
          route: actionFor(row).route,
          icon: SUBJECT_ICONS[u.subject] || 'layers',
          keywords: ['unit', 'grow', u.subject],
          weight: 1 + Math.min(row.score, 300) / 1000,
        });
      }
      entries.push({
        id: 'grow:decide',
        type: 'action',
        title: 'What should I study now?',
        subtitle: 'Picks the reddest, heaviest, stalest unit',
        body: 'decide next study pick unit grow start where do i start',
        route: routeFor('home'),
        icon: 'sparkles',
        data: { run: () => { location.hash = pickNext().action.route; } },
      });
    } catch (err) {
      console.warn('[grow] search provider failed', err);
    }
    return entries;
  });
  try { searchIndex.rebuild(); } catch (_) { /* rebuilt lazily on first search */ }
}

/* =============================================================================
   11. Convenience for other views
   ========================================================================== */

/** True when there is genuinely nothing to work with yet. */
export function isEmptyBuild() { return isVaultMissing() && index().cards.length === 0; }

export default {
  CDC_UNITS, GROW_SUBJECTS, SUBJECT_HOURS, RATING_META, GROW_RATINGS,
  getUnits, getUnit, resolveUnitId, getSelfRating, setSelfRating,
  buildRows, growSummary, pickNext, actionFor, todayLoad, allCards,
  getExamCalendar, setExamCalendar, upcomingExams, nightlyLoopState,
  NIGHTLY_LOOP_TIME, registerUnitSearch, invalidate,
};
