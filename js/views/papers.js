/* =============================================================================
   js/views/papers.js — Past-Paper Mode. Job C.

   Three things live here:
     1. FULL TIMED PAPER in the exact post-2077 NEB grid (11×1 + 8×5 + 3×8 = 75,
        OR-choices on ~2 shorts and ~1 long, 3 hours). Built ONLY from
        held_out:true rows — the assessment bank Hermes never teaches from, which
        is the only reason a predicted grade means anything.
     2. GROUP DRILLS — MCQ sprint, 5-mark drill, 8-mark build. These draw from
        the teaching pool first; using a held-out question in a drill burns it
        out of the mock bank, and the UI says so before it happens.
     3. DELAYED WHOLE-PAPER FEEDBACK. Nothing is marked, hinted or coloured
        while the clock runs (pedagogy-spec R5 — delayed feedback in exactly two
        places, and the weekly mock is one of them). After submission he marks
        himself against the real marking scheme, then gets the time-vs-marks
        report that fixes the documented "40 minutes on Q1" failure.

   Time economics drilled throughout: 2.4 min per mark, per-question countdown.
   ========================================================================== */

import {
  el, icon, fmt, toast, haptic, sound, emptyState, eyebrow,
  prefersReducedMotion, clamp,
} from '../dom.js';
import { store, KEYS, todayLocalISO, uid, nowTs, dayKeyFromTs, diffDaysISO } from '../store.js';
import { navigate } from '../router.js';
import {
  loadExamCalendar, daysToNextExam, gameCall, makeRng, freshSeed, hashString,
} from '../numericals.js';

/* ---------------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------------ */

const MIN_PER_MARK = 2.4;                 // NEB: 75 marks / 180 minutes
const SEC_PER_MARK = MIN_PER_MARK * 60;

/** post-2077 grids. `or` = how many slots in that group carry an OR choice. */
const GRIDS = {
  75: [
    { group: 'A', label: 'Group A — multiple choice', count: 11, marks: 1, or: 0 },
    { group: 'B', label: 'Group B — short answer', count: 8, marks: 5, or: 2 },
    { group: 'C', label: 'Group C — long answer', count: 3, marks: 8, or: 1 },
  ],
  50: [
    { group: 'A', label: 'Group A — multiple choice', count: 9, marks: 1, or: 0 },
    { group: 'B', label: 'Group B — short answer', count: 5, marks: 5, or: 1 },
    { group: 'C', label: 'Group C — long answer', count: 2, marks: 8, or: 1 },
  ],
};

const FIFTY_MARK_SUBJECTS = ['Computer Science'];

/** NEB letter grades — neb-nepal §4.1. */
const GRADE_TABLE = [
  { min: 90, letter: 'A+', gp: 4.0 },
  { min: 80, letter: 'A', gp: 3.6 },
  { min: 70, letter: 'B+', gp: 3.2 },
  { min: 60, letter: 'B', gp: 2.8 },
  { min: 50, letter: 'C+', gp: 2.4 },
  { min: 40, letter: 'C', gp: 2.0 },
  { min: 35, letter: 'D', gp: 1.6 },
  { min: 0, letter: 'NG', gp: 0.0 },
];

/** The number on the wall: 67/75 theory, assuming 23/25 practical. */
export const A_PLUS_THEORY = 67;

const COGNITIVE_LABEL = {
  knowledge: 'Knowledge', understanding: 'Understanding',
  application: 'Application', higher: 'Higher ability',
};

const CONFIDENCE_CHOICES = [
  { value: 1, label: 'Guess' },
  { value: 3, label: 'Fairly sure' },
  { value: 5, label: 'Certain' },
];

/* ---------------------------------------------------------------------------
   Bank loading
   ------------------------------------------------------------------------ */

let bankCache = null;
let bankPromise = null;

function dataUrl(path) {
  try { return new URL(path, document.baseURI).href; } catch (_) { return path; }
}

export function loadBank(opts) {
  if (opts && opts.force) { bankCache = null; bankPromise = null; }
  if (bankCache) return Promise.resolve(bankCache);
  if (bankPromise) return bankPromise;

  bankPromise = fetch(dataUrl('data/questions.json'), { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((raw) => {
      const rows = (raw && Array.isArray(raw.questions) ? raw.questions : [])
        .filter((q) => q && q.id && q.text)
        .map((q) => ({
          id: String(q.id),
          subject: String(q.subject || 'Physics'),
          unit: String(q.unit || ''),
          year: q.year || null,
          source: q.source || 'authored',
          patternEra: q.pattern_era === 'pre_2077' ? 'pre_2077' : 'post_2077',
          group: ['A', 'B', 'C'].includes(q.group) ? q.group : 'B',
          marks: Math.max(1, Math.round(Number(q.marks) || 1)),
          cognitive: COGNITIVE_LABEL[q.cognitive] ? q.cognitive : 'understanding',
          isNumerical: q.is_numerical === true,
          hasDiagram: q.has_diagram === true,
          heldOut: q.held_out === true,
          text: String(q.text),
          solution: String(q.solution || ''),
          markingPoints: normalisePoints(q.marking_points, Math.max(1, Math.round(Number(q.marks) || 1))),
          options: Array.isArray(q.options) ? q.options.map(String) : null,
          answerIndex: Number.isInteger(q.answerIndex) ? q.answerIndex : null,
        }));
      bankCache = { rows, note: (raw && raw.note) || '' };
      return bankCache;
    })
    .catch((err) => {
      console.warn('[papers] questions.json unavailable', err);
      bankCache = { rows: [], note: '' };
      return bankCache;
    });

  return bankPromise;
}

/** marking_points may be strings or {text, marks}. Always ends up summing to `marks`. */
function normalisePoints(raw, marks) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return [{ text: 'Answer matches the marking scheme', marks }];
  const out = list.map((p) => (typeof p === 'string'
    ? { text: p, marks: null }
    : { text: String(p && p.text ? p.text : ''), marks: Number(p && p.marks) }));
  const known = out.filter((p) => Number.isFinite(p.marks) && p.marks > 0);
  if (known.length === out.length) return out;
  const share = marks / out.length;
  return out.map((p) => ({ text: p.text, marks: Number.isFinite(p.marks) && p.marks > 0 ? p.marks : share }));
}

/* ---------------------------------------------------------------------------
   Persistence — KEYS.PAPERS.  Reserved sub-keys are prefixed '__'.
   ------------------------------------------------------------------------ */

/**
 * Subjects the question bank can actually build a paper for.
 *
 * Synchronous on purpose, so a caller that has already awaited loadBank() can
 * use it inline. Returns [] before the bank has loaded — never a guess.
 * Stats needs this: a subject can be examinable (full paper in the bank, chips
 * offered on Papers) while being absent from the vault, and reading the vault
 * alone made that subject vanish silently from Predicted grade and GPA.
 */
export function bankSubjects() {
  if (!bankCache || !Array.isArray(bankCache.rows)) return [];
  const set = new Set();
  for (const q of bankCache.rows) if (q && q.subject) set.add(q.subject);
  return Array.from(set).sort();
}

function readPapers() {
  const s = store.get(KEYS.PAPERS, {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** Every recorded attempt, newest first. */
export function allAttempts(filter) {
  const s = readPapers();
  const out = [];
  for (const [key, rec] of Object.entries(s)) {
    if (key.startsWith('__') || !rec || !Array.isArray(rec.attempts)) continue;
    for (const a of rec.attempts) out.push(Object.assign({ paperId: key }, a));
  }
  out.sort((a, b) => b.ts - a.ts);
  if (!filter) return out;
  return out.filter((a) => {
    if (filter.subject && a.subject !== filter.subject) return false;
    if (filter.mode && a.mode !== filter.mode) return false;
    if (filter.heldOutOnly && !a.heldOut) return false;
    return true;
  });
}

function saveAttempt(paperId, attempt) {
  store.update(KEYS.PAPERS, (prev) => {
    const s = prev && typeof prev === 'object' && !Array.isArray(prev) ? Object.assign({}, prev) : {};
    const rec = s[paperId] && Array.isArray(s[paperId].attempts) ? { attempts: s[paperId].attempts.slice() } : { attempts: [] };
    rec.attempts.push(attempt);
    s[paperId] = rec;
    return s;
  }, {});
}

function burnedIds() {
  const s = readPapers();
  return s.__burned && typeof s.__burned === 'object' ? s.__burned : {};
}

function burn(ids) {
  if (!ids || !ids.length) return;
  store.update(KEYS.PAPERS, (prev) => {
    const s = prev && typeof prev === 'object' && !Array.isArray(prev) ? Object.assign({}, prev) : {};
    const b = Object.assign({}, s.__burned || {});
    const day = todayLocalISO();
    for (const id of ids) b[id] = day;
    s.__burned = b;
    return s;
  }, {});
}

/* ---------------------------------------------------------------------------
   Grades
   ------------------------------------------------------------------------ */

export function gradeFor(percent) {
  const p = Number(percent) || 0;
  for (const row of GRADE_TABLE) if (p >= row.min) return row;
  return GRADE_TABLE[GRADE_TABLE.length - 1];
}

/** Practical marks assumed when turning a theory mark into a subject grade.
 *  neb-nepal §4.2 — practicals are marked generously, 20-24 out of 25.
 *  MUST stay equal to stats.js ASSUMED_PRACTICAL: one paper may never show two
 *  different letters on two different screens. */
export const ASSUMED_PRACTICAL = 23;

/**
 * NEB grades the SUBJECT — theory /75 plus practical /25 — never the theory
 * paper on its own. 43/75 is 57% of the theory paper but a B once a typical
 * practical is counted, and B is the letter that goes on the transcript. This
 * is the same arithmetic that makes 67/75 an A+.
 * @returns {{letter:string, gp:number, min:number}}
 */
export function subjectGradeFor(marks, total) {
  const t = Number(total) || 75;
  const pct = (((Number(marks) || 0) + ASSUMED_PRACTICAL) / (t + 25)) * 100;
  return gradeFor(pct);
}

function theoryTotalFor(subject) {
  return FIFTY_MARK_SUBJECTS.includes(subject) ? 50 : 75;
}

/* ---------------------------------------------------------------------------
   Paper construction
   ------------------------------------------------------------------------ */

function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * Pick `n` questions spread across as many units as possible, and nudged
 * towards the CDC cognitive grid (15/25/35/25).
 */
function pickSpread(pool, n, rng) {
  const byUnit = new Map();
  for (const q of shuffled(pool, rng)) {
    if (!byUnit.has(q.unit)) byUnit.set(q.unit, []);
    byUnit.get(q.unit).push(q);
  }
  const buckets = Array.from(byUnit.values());
  const out = [];
  let guard = 0;
  while (out.length < n && guard < n * 20) {
    guard += 1;
    let progressed = false;
    for (const b of buckets) {
      if (out.length >= n) break;
      if (b.length) { out.push(b.shift()); progressed = true; }
    }
    if (!progressed) break;
  }
  return out.slice(0, n);
}

/**
 * Build a full paper in the post-2077 grid.
 * @param {Array} rows the whole bank
 * @param {{subject:string, seed?:number, heldOutOnly?:boolean}} opts
 * @returns {{ok:boolean, paper?:Object, shortfall?:Array}}
 */
export function buildPaper(rows, opts) {
  const o = opts || {};
  const subject = o.subject;
  const total = theoryTotalFor(subject);
  const grid = GRIDS[total];
  const seed = Number.isFinite(Number(o.seed)) ? Number(o.seed) : freshSeed();
  const rng = makeRng(seed);
  const burnt = burnedIds();

  /* pre-2077 rows stay in the bank as reading material but are NEVER served in
     timed mode — the grid changed, and drilling the old shape is drilling a
     paper that no longer exists (pedagogy-spec §5.1). */
  const pool = rows.filter((q) => q.subject === subject
    && q.patternEra === 'post_2077'
    && (o.heldOutOnly === false ? true : q.heldOut === true)
    && !burnt[q.id]);

  const shortfall = [];
  const sections = [];
  let n = 0;

  for (const spec of grid) {
    const groupPool = pool.filter((q) => q.group === spec.group && q.marks === spec.marks);
    const need = spec.count + spec.or;
    if (groupPool.length < need) {
      shortfall.push({ group: spec.group, marks: spec.marks, have: groupPool.length, need });
    }
    const chosen = pickSpread(groupPool, need, rng);
    const slots = [];
    for (let i = 0; i < spec.count; i += 1) {
      const primary = chosen[i];
      if (!primary) break;
      n += 1;
      const alt = i >= spec.count - spec.or ? chosen[spec.count + (i - (spec.count - spec.or))] : null;
      slots.push({
        n,
        group: spec.group,
        marks: spec.marks,
        budgetSec: Math.round(spec.marks * SEC_PER_MARK),
        questions: alt ? [primary, alt] : [primary],
      });
    }
    sections.push({ group: spec.group, label: spec.label, marks: spec.marks, slots });
  }

  if (shortfall.length) return { ok: false, shortfall, subject, poolSize: pool.length };

  const paper = {
    id: 'paper:' + subject.toLowerCase().replace(/\s+/g, '-') + ':' + hashString(subject + ':' + seed).toString(36),
    subject,
    seed,
    totalMarks: total,
    durationSec: Math.round(total * SEC_PER_MARK),
    sections,
    slots: sections.flatMap((s) => s.slots),
    heldOut: o.heldOutOnly !== false,
  };
  return { ok: true, paper };
}

/** A group drill: N questions of one group, teaching pool preferred. */
export function buildDrill(rows, opts) {
  const o = opts || {};
  const rng = makeRng(Number.isFinite(Number(o.seed)) ? Number(o.seed) : freshSeed());
  const count = Math.max(1, Math.round(Number(o.count) || 5));
  const burnt = burnedIds();
  const base = rows.filter((q) => q.subject === o.subject && q.group === o.group
    && q.patternEra === 'post_2077' && !burnt[q.id]);
  const teaching = base.filter((q) => !q.heldOut);
  const usingHeldOut = o.allowHeldOut === true && teaching.length < count;
  const pool = usingHeldOut ? base : teaching;
  const chosen = pickSpread(pool, count, rng);
  let n = 0;
  const slots = chosen.map((q) => {
    n += 1;
    return { n, group: q.group, marks: q.marks, budgetSec: Math.round(q.marks * SEC_PER_MARK), questions: [q] };
  });
  return {
    id: 'drill:' + o.subject.toLowerCase().replace(/\s+/g, '-') + ':' + o.group,
    subject: o.subject,
    totalMarks: slots.reduce((a, s) => a + s.marks, 0),
    durationSec: slots.reduce((a, s) => a + s.budgetSec, 0),
    sections: [{ group: o.group, label: 'Group ' + o.group + ' drill', marks: slots[0] ? slots[0].marks : 0, slots }],
    slots,
    heldOut: usingHeldOut,
    burnedHeldOut: usingHeldOut ? chosen.filter((q) => q.heldOut).map((q) => q.id) : [],
    availableTeaching: teaching.length,
    availableTotal: base.length,
  };
}

/* ---------------------------------------------------------------------------
   Schedule status — the cram-mode label
   ------------------------------------------------------------------------ */

/**
 * A full paper is "on schedule" when it is the standing weekly mock, or an
 * exam window is open (≤14 days). Anything else is a labelled cram rescue —
 * it still logs and marks, it just never pretends to be the weekly measurement.
 */
export function scheduleStatus(subject) {
  const last = allAttempts({ mode: 'full' }).find((a) => a.subject === subject);
  const exam = daysToNextExam(subject);
  const examSoon = exam && exam.days <= 14;
  if (!last) return { cram: false, reason: 'First full paper in this subject — that is always on schedule.', examSoon: Boolean(examSoon), exam };
  const daysSince = Math.abs(diffDaysISO(dayKeyFromTs(last.ts), todayLocalISO()));
  if (examSoon) return { cram: false, reason: exam.event.label + ' is ' + exam.days + ' days away — full papers are the right work now.', daysSince, examSoon: true, exam };
  if (daysSince >= 6) return { cram: false, reason: 'Weekly mock — ' + daysSince + ' days since your last ' + subject + ' paper.', daysSince, examSoon: false, exam };
  return {
    cram: true,
    daysSince,
    examSoon: false,
    exam,
    reason: 'You sat a ' + subject + ' paper ' + daysSince + ' ' + fmt.plural(daysSince, 'day') + ' ago and there is no exam inside 14 days.',
  };
}

/* ---------------------------------------------------------------------------
   THE VIEW
   ------------------------------------------------------------------------ */

let teardown = [];

function onCleanup(fn) { teardown.push(fn); }

function runCleanup() {
  for (const fn of teardown.splice(0)) { try { fn(); } catch (_) { /* ignore */ } }
}

export default {
  id: 'papers',
  title: 'Past papers',
  icon: 'file-text',

  async render(root) {
    runCleanup();
    const [bank] = await Promise.all([loadBank(), loadExamCalendar()]);

    if (!bank.rows.length) {
      root.appendChild(el('div.section',
        el('div.section-head', el('h1.section-head__title', { text: 'Past papers' })),
        emptyState({
          icon: 'file-text',
          title: 'The question bank is empty',
          body: 'data/questions.json has no rows yet. Hermes grows this weekly — photos of VAC papers and your own returned scripts are worth more than any model set.',
        })));
      return;
    }

    renderHome(root, bank);
  },

  onExit() { runCleanup(); },
};

/* --- home ---------------------------------------------------------------- */

function subjectsIn(rows) {
  const out = [];
  for (const q of rows) if (!out.includes(q.subject)) out.push(q.subject);
  return out.sort();
}

function renderHome(root, bank) {
  root.replaceChildren();
  const subjects = subjectsIn(bank.rows);
  const state = store.get(KEYS.UI, {}) || {};
  let subject = subjects.includes(state.papersSubject) ? state.papersSubject : subjects[0];

  const head = el('div.section-head',
    el('div',
      el('h1.section-head__title', { text: 'Past papers' }),
      el('p.section-head__sub', {
        text: 'Post-2077 grid only: ' + '11 × 1 mark + 8 × 5 marks + 3 × 8 marks = 75, three hours, 2.4 minutes a mark. Twenty-two answer slots — that is the whole thing, and it is drillable to saturation.',
      })
    )
  );
  root.appendChild(el('div.section', head));

  /* subject picker */
  const picker = el('div.chip-row.chip-row--scroll');
  const body = el('div');

  subjects.forEach((s) => {
    const chip = el('button.chip.chip--button', {
      type: 'button', text: s,
      attrs: { 'aria-pressed': String(s === subject) },
      onClick: () => {
        subject = s;
        store.update(KEYS.UI, (u) => Object.assign({}, u || {}, { papersSubject: s }), {});
        Array.from(picker.children).forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === s)));
        paint();
      },
    });
    picker.appendChild(chip);
  });

  root.appendChild(el('div.section', picker, body));

  function paint() { body.replaceChildren(paintSubject(root, bank, subject)); }
  paint();
}

function countsFor(rows, subject) {
  const usable = rows.filter((q) => q.subject === subject && q.patternEra === 'post_2077');
  const held = usable.filter((q) => q.heldOut);
  const teach = usable.filter((q) => !q.heldOut);
  const byGroup = (list, g) => list.filter((q) => q.group === g).length;
  return {
    held: { A: byGroup(held, 'A'), B: byGroup(held, 'B'), C: byGroup(held, 'C'), total: held.length },
    teach: { A: byGroup(teach, 'A'), B: byGroup(teach, 'B'), C: byGroup(teach, 'C'), total: teach.length },
  };
}

function paintSubject(root, bank, subject) {
  const frag = el('div.stack', { style: { '--gap': 'var(--sp-5)' } });
  const c = countsFor(bank.rows, subject);
  const total = theoryTotalFor(subject);
  const grid = GRIDS[total];
  const status = scheduleStatus(subject);
  const build = buildPaper(bank.rows, { subject });

  /* --- the wall ---------------------------------------------------------- */
  const attempts = allAttempts({ subject, mode: 'full', heldOutOnly: true });
  const best = attempts.reduce((a, x) => (x.marksEarned > (a ? a.marksEarned : -1) ? x : a), null);
  frag.appendChild(el('section.card.card--tone.card--2xl.card--pad-lg', { dataset: { subject: subjectKey(subject) } },
    eyebrow(subject + ' · theory'),
    el('div.stat-row',
      el('div.stat',
        el('div.stat__eyebrow', icon('target', { size: 12 }), el('span', { text: 'A+ needs' })),
        el('div.stat__value', { text: String(total === 75 ? A_PLUS_THEORY : 45) }), el('span.stat__unit', { text: '/ ' + total }),
        el('p.stat__sub', { text: 'assuming 23/25 in the practical' })),
      el('div.stat',
        el('div.stat__eyebrow', icon('trophy', { size: 12 }), el('span', { text: 'Your best' })),
        el('div.stat__value', { text: best ? String(best.marksEarned) : '—' }), best ? el('span.stat__unit', { text: '/ ' + best.marksTotal }) : null,
        el('p.stat__sub', { text: best ? fmt.rel(best.ts) : 'no full paper sat yet' })),
      el('div.stat',
        el('div.stat__eyebrow', icon('gauge', { size: 12 }), el('span', { text: 'Gap to the wall' })),
        el('div.stat__value', { text: best ? String(Math.max(0, (total === 75 ? A_PLUS_THEORY : 45) - best.marksEarned)) : '—' }),
        el('span.stat__unit', { text: 'marks' }),
        el('p.stat__sub', { text: best ? 'from your best held-out paper' : 'sit one paper and this becomes real' }))
    ),
    el('p.hint', { text: 'Skipping all three long answers caps you at 51/75 — a B+ at absolute best. The 24 long-answer marks are not optional.' })
  ));

  /* --- full paper -------------------------------------------------------- */
  const fullCard = el('section.card.card--pad-lg.stack');
  fullCard.appendChild(el('div.card__head',
    el('div',
      eyebrow('Full timed paper'),
      el('h2.card__title', { text: subject + ' — ' + total + ' marks, ' + Math.round(total * MIN_PER_MARK) + ' minutes' }),
      el('p.card__sub', { text: grid.map((g) => g.count + ' × ' + g.marks).join('  ·  ') + '  ·  OR-choice on ' + grid.reduce((a, g) => a + g.or, 0) + ' slots' })
    ),
    el('span.pill', { class: build.ok ? 'pill--good' : 'pill--warn', text: c.held.total + ' held-out in bank' })
  ));

  if (status.cram) {
    fullCard.appendChild(el('div.card.card--tone', { dataset: { tone: 'warn' } },
      el('div.row', icon('alert-triangle', { size: 14 }), el('span.eyebrow', { text: 'Cram mode' })),
      el('p.prose', { text: status.reason + ' Sitting another one now is a rescue path, not the weekly measurement — it is marked and logged in full, and it is labelled cram everywhere it appears.' }),
      el('p.hint', { text: 'It never touches your review schedule. Nothing you do here can damage an interval you have earned.' })
    ));
  } else {
    fullCard.appendChild(el('p.hint', { text: status.reason }));
  }

  if (build.ok) {
    fullCard.appendChild(el('div.btn-row',
      el('button.btn.btn-primary.btn--lg', {
        type: 'button',
        onClick: () => startPaper(root, bank, build.paper, { mode: 'full', cram: status.cram }),
      }, icon('timer', { size: 16 }), el('span', { text: 'Start the clock' })),
      el('button.btn.btn-secondary', {
        type: 'button',
        onClick: () => {
          const b2 = buildPaper(bank.rows, { subject, seed: freshSeed() });
          if (b2.ok) startPaper(root, bank, b2.paper, { mode: 'full', cram: status.cram });
        },
      }, icon('refresh', { size: 16 }), el('span', { text: 'Different paper' }))
    ));
  } else {
    const rows = build.shortfall.map((s) => 'Group ' + s.group + ': ' + s.have + ' of ' + s.need);
    fullCard.appendChild(el('div.card.card--quiet',
      el('p.text-body-lg', { text: 'Not enough held-out questions to build a full ' + subject + ' paper yet.' }),
      el('p.hint', { text: rows.join('  ·  ') + '. Group drills below work with what is there, and Hermes can author the rest — a full paper needs ' + grid.reduce((a, g) => a + g.count + g.or, 0) + ' held-out questions in this subject.' })
    ));
  }
  frag.appendChild(fullCard);

  /* --- group drills ------------------------------------------------------ */
  const drillCard = el('section.card.card--pad-lg.stack');
  drillCard.appendChild(el('div.card__head', el('div',
    eyebrow('Group drills'),
    el('h2.card__title', { text: 'Drill one slot type until it is automatic' }),
    el('p.card__sub', { text: 'Teaching-pool questions first. A drill that has to reach into the held-out bank burns that question out of your mocks, and it will ask first.' })
  )));

  const drillSpecs = [
    { group: 'A', label: 'MCQ sprint', count: Math.min(11, Math.max(3, c.teach.A + c.held.A)), icon: 'zap', blurb: '11 free marks in the real paper. One-step numericals and definitions.' },
    { group: 'B', label: '5-mark drill', count: Math.min(4, Math.max(2, c.teach.B + c.held.B)), icon: 'layers', blurb: '40 of the 75 marks. Usually "state/derive, then a numerical".' },
    { group: 'C', label: '8-mark build', count: Math.min(2, Math.max(1, c.teach.C + c.held.C)), icon: 'trophy', blurb: '24 marks. Skip these and B+ is your ceiling.' },
  ];

  const drillGrid = el('div.card-grid');
  for (const d of drillSpecs) {
    const avail = bank.rows.filter((q) => q.subject === subject && q.group === d.group
      && q.patternEra === 'post_2077' && !burnedIds()[q.id]);
    const teaching = avail.filter((q) => !q.heldOut).length;
    drillGrid.appendChild(el('button.card.card--interactive.card--tone', {
      type: 'button',
      dataset: { subject: subjectKey(subject) },
      onClick: () => openDrill(root, bank, subject, d),
    },
      el('div.row', el('span.icon-tile', icon(d.icon, { size: 16 })), el('span.card__title', { text: d.label })),
      el('p.card__sub', { text: d.blurb }),
      el('p.text-meta', { text: avail.length + ' available · ' + teaching + ' from the teaching pool' })
    ));
  }
  drillCard.appendChild(drillGrid);
  frag.appendChild(drillCard);

  /* --- repeat hunter ----------------------------------------------------- */
  frag.appendChild(repeatHunter(bank.rows, subject));

  /* --- history ----------------------------------------------------------- */
  frag.appendChild(historyPanel(subject));

  return frag;
}

function subjectKey(subject) {
  return String(subject || '').toLowerCase().replace(/\s+/g, '-');
}

/** Units that keep coming back — exactly how Nepali toppers read past papers. */
function repeatHunter(rows, subject) {
  const byUnit = new Map();
  for (const q of rows) {
    if (q.subject !== subject) continue;
    const cur = byUnit.get(q.unit) || { unit: q.unit, count: 0, marks: 0, years: new Set(), groups: new Set() };
    cur.count += 1;
    cur.marks += q.marks;
    if (q.year) cur.years.add(q.year);
    cur.groups.add(q.group);
    byUnit.set(q.unit, cur);
  }
  const list = Array.from(byUnit.values()).sort((a, b) => b.marks - a.marks || b.count - a.count).slice(0, 8);
  const max = list.length ? list[0].marks : 1;

  const card = el('section.card.card--pad-lg.stack',
    el('div.card__head', el('div',
      eyebrow('Repeat hunter'),
      el('h2.card__title', { text: 'What this paper keeps asking' }),
      el('p.card__sub', { text: 'Marks in the bank per unit, across every year stored. A unit that appears in three papers will appear in a fourth.' })
    )));

  if (!list.length) {
    card.appendChild(el('p.hint', { text: 'No questions stored for this subject yet.' }));
    return card;
  }

  const rowsEl = el('div.stack', { style: { '--gap': 'var(--sp-3)' } });
  for (const u of list) {
    rowsEl.appendChild(el('div',
      el('div.row.row--between',
        el('span.text-body-lg', { text: u.unit || '(unit not declared)' }),
        el('span.text-meta.tabular', { text: u.marks + ' marks · ' + u.count + ' Q · ' + Array.from(u.years).sort().join(', ') })
      ),
      el('div.meter.meter--ticks', el('span.meter__fill', { style: { '--pct': String(Math.round((u.marks / max) * 100)) } }))
    ));
  }
  card.appendChild(rowsEl);
  return card;
}

function historyPanel(subject) {
  const attempts = allAttempts({ subject }).slice(0, 12);
  const card = el('section.card.card--pad-lg.stack',
    el('div.card__head', el('div',
      eyebrow('Attempt history'),
      el('h2.card__title', { text: 'Every paper you have sat' })
    )));

  if (!attempts.length) {
    card.appendChild(el('p.hint', { text: 'Nothing yet. The first full paper is the one that turns "am I improving?" into a number.' }));
    return card;
  }

  const table = el('table.table',
    el('thead', el('tr',
      el('th', { text: 'Date' }), el('th', { text: 'Mode' }),
      el('th.table__num', { text: 'Marks' }), el('th.table__num', { text: '%' }),
      el('th', { text: 'Grade' }), el('th.table__num', { text: 'Time' }), el('th', { text: 'Flag' })
    )),
    el('tbody', attempts.map((a) => {
      const pct = a.marksTotal ? (a.marksEarned / a.marksTotal) * 100 : 0;
      /* A grade letter only means something on a whole paper. A 15-mark drill
         has no NEB grade, so it gets a dash rather than an invented letter. */
      const g = a.mode === 'full' ? subjectGradeFor(a.marksEarned, a.marksTotal) : null;
      return el('tr',
        el('td.mono', { text: dayKeyFromTs(a.ts) }),
        el('td', { text: a.mode === 'full' ? 'Full paper' : 'Group ' + (a.group || '?') }),
        el('td.table__num.mono', { text: a.marksEarned + '/' + a.marksTotal }),
        el('td.table__num.mono', { text: Math.round(pct) + '%' }),
        el('td', g
          ? el('span.pill', { class: g.gp >= 3.6 ? 'pill--good' : g.gp >= 2.8 ? 'pill--warn' : 'pill--bad', text: g.letter })
          : el('span.text-meta', { text: '—' })),
        el('td.table__num.mono', { text: fmt.dur(a.durationSec * 1000) }),
        el('td', a.cram
          ? el('span.pill.pill--warn', { text: 'cram' })
          : (a.heldOut ? el('span.pill.pill--info', { text: 'held-out' }) : el('span.pill.pill--neutral', { text: 'drill' })))
      );
    }))
  );
  card.appendChild(el('div.scroll-x', table));
  return card;
}

/* ---------------------------------------------------------------------------
   Drill launcher (asks before burning a held-out question)
   ------------------------------------------------------------------------ */

function openDrill(root, bank, subject, spec) {
  const first = buildDrill(bank.rows, { subject, group: spec.group, count: spec.count, allowHeldOut: false });
  if (first.slots.length >= Math.min(spec.count, 1)) {
    return startPaper(root, bank, first, { mode: 'drill', group: spec.group, cram: false });
  }

  const withHeldOut = buildDrill(bank.rows, { subject, group: spec.group, count: spec.count, allowHeldOut: true });
  if (!withHeldOut.slots.length) {
    toast('No Group ' + spec.group + ' questions left for ' + subject + '.', { tone: 'warn' });
    return null;
  }

  const scrim = el('div.scrim');
  const sheet = el('div.sheet',
    el('span.sheet__grip'),
    el('div.modal__head', el('h2.modal__title', { text: 'This will burn held-out questions' })),
    el('div.modal__body',
      el('p.prose', { text: 'The teaching pool has no Group ' + spec.group + ' questions left for ' + subject + '. Running this drill uses ' + withHeldOut.burnedHeldOut.length + ' question' + (withHeldOut.burnedHeldOut.length === 1 ? '' : 's') + ' from the held-out bank, and they are removed from future mocks.' }),
      el('p.hint', { text: 'The held-out bank is the only honest measure of whether this is working. Burning it is sometimes worth it — but it is a real cost, so it is your call, not the app’s.' })
    ),
    el('div.modal__foot',
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: close }),
      el('button.btn.btn-primary', {
        type: 'button', text: 'Burn them and drill',
        onClick: () => { close(); burn(withHeldOut.burnedHeldOut); startPaper(root, bank, withHeldOut, { mode: 'drill', group: spec.group, cram: false }); },
      })
    )
  );
  function close() { scrim.remove(); sheet.remove(); }
  scrim.addEventListener('click', close);
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  onCleanup(close);
  return null;
}

/* ---------------------------------------------------------------------------
   THE EXAM RUNNER — no feedback of any kind while the clock is running
   ------------------------------------------------------------------------ */

function startPaper(root, bank, paper, opts) {
  const o = opts || {};
  runCleanup();
  root.replaceChildren();

  const slots = paper.slots;
  const answers = slots.map((s) => ({
    slot: s,
    chosen: 0,               // which OR alternative
    mcq: null,               // selected option index
    text: '',
    confidence: null,
    elapsedSec: 0,
  }));

  let idx = 0;
  let remainingSec = paper.durationSec;
  let finished = false;
  const startedTs = nowTs();

  /* --- chrome ----------------------------------------------------------- */
  const clock = el('span.stat__value.mono', { text: fmt.clock(remainingSec) });
  const qClock = el('span.mono', { text: '00:00' });
  const qClockPill = el('span.pill.pill--neutral', icon('timer', { size: 12 }), qClock);

  const bar = el('section.card.card--flush.card--pad-lg.stack', { style: { position: 'sticky', top: '0', zIndex: '2' } },
    el('div.row.row--between',
      el('div',
        eyebrow(o.mode === 'full' ? paper.subject + ' — full paper' : paper.subject + ' — Group ' + o.group + ' drill'),
        el('p.text-meta', { text: paper.totalMarks + ' marks · ' + Math.round(paper.durationSec / 60) + ' minutes · 2.4 min a mark' })
      ),
      el('div.row',
        o.cram ? el('span.pill.pill--warn', { text: 'Cram' }) : null,
        qClockPill,
        el('div', el('div.stat__eyebrow', el('span', { text: 'Paper' })), clock)
      )
    )
  );

  const navGrid = el('div.chip-row.chip-row--scroll');
  slots.forEach((s, i) => {
    navGrid.appendChild(el('button.chip.chip--button.chip--micro', {
      type: 'button', text: String(s.n),
      attrs: { 'aria-pressed': 'false', 'aria-label': 'Question ' + s.n },
      onClick: () => { go(i); },
    }));
  });
  bar.appendChild(navGrid);

  const stage = el('div.section');
  const foot = el('div.btn-row');

  root.appendChild(el('div.section', bar));
  root.appendChild(stage);
  root.appendChild(el('div.section', foot));

  /* --- timer ------------------------------------------------------------ */
  const tick = setInterval(() => {
    if (finished) return;
    remainingSec -= 1;
    answers[idx].elapsedSec += 1;
    clock.textContent = fmt.clock(Math.max(0, remainingSec));
    paintQClock();
    if (remainingSec <= 0) { toast('Time. The paper closes now — same as the hall.', { tone: 'warn' }); finish(); }
    else if (remainingSec === 300) toast('Five minutes left.', { tone: 'warn' });
  }, 1000);
  onCleanup(() => clearInterval(tick));

  function paintQClock() {
    const a = answers[idx];
    const budget = a.slot.budgetSec;
    const over = a.elapsedSec - budget;
    qClock.textContent = fmt.clock(Math.abs(over));
    qClockPill.className = 'pill ' + (over > 60 ? 'pill--bad' : over > 0 ? 'pill--warn' : 'pill--neutral');
    qClockPill.setAttribute('title', over > 0
      ? 'You are ' + Math.ceil(over / 60) + ' min over on this question'
      : 'Time left on this question');
  }

  function go(i) {
    idx = clamp(i, 0, slots.length - 1);
    paint();
  }

  function paint() {
    const a = answers[idx];
    const slot = a.slot;
    const q = slot.questions[a.chosen];

    Array.from(navGrid.children).forEach((c, i) => {
      c.setAttribute('aria-pressed', String(i === idx));
      const ans = answers[i];
      const done = ans.mcq !== null || String(ans.text).trim().length > 0;
      c.classList.toggle('chip--accent', done);
    });

    stage.replaceChildren();
    const card = el('article.card.card--pad-lg.stack', { dataset: { subject: subjectKey(paper.subject) } });

    card.appendChild(el('div.card__head',
      el('div',
        eyebrow('Question ' + slot.n + ' · Group ' + slot.group),
        el('p.card__sub', { text: q.unit + ' · ' + Math.round(slot.budgetSec / 60) + ' min budget' })
      ),
      el('span.pill.pill--accent', { text: slot.marks + ' ' + fmt.plural(slot.marks, 'mark') })
    ));

    if (slot.questions.length > 1) {
      const seg = el('div.segmented', { attrs: { role: 'group', 'aria-label': 'OR choice' } });
      slot.questions.forEach((_, k) => {
        seg.appendChild(el('button.segmented__btn', {
          type: 'button', text: k === 0 ? 'Question ' + slot.n : 'OR',
          attrs: { 'aria-selected': String(k === a.chosen) },
          onClick: () => { a.chosen = k; a.mcq = null; a.text = ''; paint(); },
        }));
      });
      card.appendChild(el('div',
        seg,
        el('p.hint', { text: 'Answer one of these two. In the hall, reading both before choosing costs about a minute and saves five.' })
      ));
    }

    card.appendChild(el('p.prose.text-body-lg', { text: q.text }));
    if (q.hasDiagram) card.appendChild(el('p.hint', { text: 'This question expects a diagram. Draw it on paper — diagrams are marked line by line and they are cheap marks.' }));

    if (q.group === 'A' && Array.isArray(q.options)) {
      const list = el('div.stack', { style: { '--gap': 'var(--sp-2)' } });
      q.options.forEach((opt, k) => {
        list.appendChild(el('button.option', {
          type: 'button',
          class: a.mcq === k ? 'is-selected' : '',
          onClick: () => { a.mcq = k; paint(); },
        }, el('span.option__key', { text: String.fromCharCode(65 + k) }), el('span', { text: opt })));
      });
      card.appendChild(list);
    } else {
      const ta = el('textarea.textarea', {
        rows: 10,
        placeholder: 'Write your answer here as you would in the answer book — every step on its own line, units on every line.',
        attrs: { 'aria-label': 'Answer to question ' + slot.n },
      });
      ta.value = a.text;
      ta.addEventListener('input', () => { a.text = ta.value; });
      card.appendChild(ta);
      card.appendChild(el('p.hint', { text: 'Working on paper is fine — type the key steps here so the marking scheme has something to check against.' }));
    }

    const confSeg = el('div.segmented');
    CONFIDENCE_CHOICES.forEach((cc) => {
      confSeg.appendChild(el('button.segmented__btn', {
        type: 'button', text: cc.label,
        attrs: { 'aria-selected': String(a.confidence === cc.value) },
        onClick: () => { a.confidence = cc.value; paint(); },
      }));
    });
    card.appendChild(el('div.field',
      el('label.label', { text: 'How sure are you? (optional, never guessed for you)' }),
      confSeg
    ));

    stage.appendChild(card);
    paintQClock();

    foot.replaceChildren(
      el('button.btn.btn-secondary', {
        type: 'button', disabled: idx === 0, onClick: () => go(idx - 1),
      }, icon('chevron-left', { size: 16 }), el('span', { text: 'Previous' })),
      idx < slots.length - 1
        ? el('button.btn.btn-primary', { type: 'button', onClick: () => go(idx + 1) },
            el('span', { text: 'Next' }), icon('chevron-right', { size: 16 }))
        : el('button.btn.btn-primary', { type: 'button', onClick: confirmFinish },
            icon('circle-check', { size: 16 }), el('span', { text: 'Finish the paper' })),
      el('button.btn.btn-ghost.push', { type: 'button', onClick: confirmFinish }, el('span', { text: 'Submit early' }))
    );
  }

  function confirmFinish() {
    const blank = answers.filter((a) => a.mcq === null && !String(a.text).trim()).length;
    if (blank && !window.confirm(blank + ' question' + (blank === 1 ? ' is' : 's are') + ' still blank. A blank answer is a guaranteed zero; a written attempt earns method marks. Submit anyway?')) return;
    finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(tick);
    const durationSec = Math.round((nowTs() - startedTs) / 1000);
    renderMarking(root, bank, paper, answers, Object.assign({}, o, { durationSec }));
  }

  paint();
}

/* ---------------------------------------------------------------------------
   MARKING — the delayed whole-paper feedback, against the real scheme
   ------------------------------------------------------------------------ */

function renderMarking(root, bank, paper, answers, o) {
  root.replaceChildren();

  const marks = answers.map((a) => {
    const q = a.slot.questions[a.chosen];
    if (q.group === 'A' && Array.isArray(q.options)) {
      return { auto: true, awarded: a.mcq !== null && a.mcq === q.answerIndex ? q.marks : 0, points: [] };
    }
    return { auto: false, awarded: 0, points: q.markingPoints.map(() => false) };
  });

  const totalEl = el('span.stat__value.mono', { text: '0' });

  function recompute() {
    let sum = 0;
    marks.forEach((m, i) => {
      if (!m.auto) {
        const q = answers[i].slot.questions[answers[i].chosen];
        m.awarded = m.points.reduce((acc, on, k) => acc + (on ? q.markingPoints[k].marks : 0), 0);
      }
      sum += m.awarded;
    });
    totalEl.textContent = String(Math.round(sum * 10) / 10);
    return sum;
  }

  root.appendChild(el('div.section',
    el('div.section-head',
      el('div',
        el('h1.section-head__title', { text: 'Mark it yourself, against the real scheme' }),
        el('p.section-head__sub', { text: 'This is the part that moves marks. You already know the physics of your own answer better than any tick — what you do not yet know is what an examiner is actually paid to look for. Tick only what you genuinely wrote.' })
      ),
      el('div.stat',
        el('div.stat__eyebrow', el('span', { text: 'Running total' })),
        totalEl, el('span.stat__unit', { text: '/ ' + paper.totalMarks })
      )
    )
  ));

  const list = el('div.stack', { style: { '--gap': 'var(--sp-5)' } });

  answers.forEach((a, i) => {
    const q = a.slot.questions[a.chosen];
    const m = marks[i];
    const over = a.elapsedSec - a.slot.budgetSec;

    const card = el('article.card.card--pad-lg.stack', { dataset: { subject: subjectKey(paper.subject) } });
    card.appendChild(el('div.card__head',
      el('div',
        eyebrow('Question ' + a.slot.n + ' · Group ' + a.slot.group + ' · ' + q.unit),
        el('p.card__sub', { text: q.marks + ' marks · you spent ' + fmt.dur(a.elapsedSec * 1000) + ' of a ' + Math.round(a.slot.budgetSec / 60) + ' min budget' })
      ),
      over > 60 ? el('span.pill.pill--bad', { text: Math.ceil(over / 60) + ' min over' })
        : over > 0 ? el('span.pill.pill--warn', { text: 'just over' })
        : el('span.pill.pill--good', { text: 'in budget' })
    ));

    card.appendChild(el('p.prose', { text: q.text }));

    if (m.auto) {
      const chosen = a.mcq === null ? null : q.options[a.mcq];
      const right = a.mcq === q.answerIndex;
      card.appendChild(el('div.stack', { style: { '--gap': 'var(--sp-2)' } },
        q.options.map((opt, k) => el('div.option', {
          class: k === q.answerIndex ? 'is-correct' : (k === a.mcq && !right ? 'is-wrong' : ''),
        }, el('span.option__key', { text: String.fromCharCode(65 + k) }), el('span', { text: opt })))
      ));
      card.appendChild(el('p.text-meta', {
        text: chosen === null ? 'Left blank — 0 of ' + q.marks + '.'
          : right ? 'Correct — ' + q.marks + ' banked.'
            : 'You chose ' + chosen + '. 0 of ' + q.marks + '.',
      }));
    } else {
      card.appendChild(el('div.card.card--quiet',
        eyebrow('What you wrote'),
        el('p.prose', { text: String(a.text).trim() || '(blank)' })
      ));

      const scheme = el('div.stack', { style: { '--gap': 'var(--sp-2)' } });
      q.markingPoints.forEach((p, k) => {
        const box = el('input.check__input', { type: 'checkbox' });
        box.addEventListener('change', () => { m.points[k] = box.checked; recompute(); });
        scheme.appendChild(el('label.check',
          box, el('span.check__box', icon('check', { size: 12 })),
          el('span.check__text', { text: p.text + '  (' + (Math.round(p.marks * 10) / 10) + ')' })
        ));
      });
      card.appendChild(el('div',
        eyebrow('Marking scheme — tick what you actually wrote'),
        scheme
      ));
    }

    card.appendChild(el('details.card.card--quiet',
      el('summary', { text: 'Model answer' }),
      el('p.prose', { text: q.solution })
    ));

    list.appendChild(card);
  });

  root.appendChild(el('div.section', list));

  const reportBtn = el('button.btn.btn-primary.btn--lg.btn--block', { type: 'button' },
    icon('trending-up', { size: 16 }), el('span', { text: 'See the report' }));
  reportBtn.addEventListener('click', () => {
    const earned = recompute();
    commitAttempt(root, bank, paper, answers, marks, earned, o);
  });
  root.appendChild(el('div.section', el('div.btn-row', reportBtn)));

  recompute();
}

/* ---------------------------------------------------------------------------
   REPORT + persistence + the cross-feature event
   ------------------------------------------------------------------------ */

function commitAttempt(root, bank, paper, answers, marks, earnedRaw, o) {
  const marksEarned = Math.round(earnedRaw * 10) / 10;
  const marksTotal = paper.totalMarks;
  const durationSec = o.durationSec || 0;
  const ts = nowTs();

  const perQuestion = answers.map((a, i) => {
    const q = a.slot.questions[a.chosen];
    return {
      id: q.id,
      n: a.slot.n,
      group: a.slot.group,
      unit: q.unit,
      cognitive: q.cognitive,
      marks: Math.round(marks[i].awarded * 10) / 10,
      marksMax: q.marks,
      sec: a.elapsedSec,
      budgetSec: a.slot.budgetSec,
      confidence: a.confidence,
      blank: a.mcq === null && !String(a.text).trim(),
    };
  });

  const attempt = {
    id: uid('att'),
    ts,
    day: todayLocalISO(),
    subject: paper.subject,
    mode: o.mode,
    group: o.group || null,
    heldOut: paper.heldOut === true,
    cram: o.cram === true,
    marksEarned,
    marksTotal,
    durationSec,
    perQuestion,
  };

  saveAttempt(paper.id, attempt);

  /* review log — one append per question, so engram.py sees the real items */
  const entries = perQuestion.map((p) => ({
    cardId: 'q:' + p.id,
    topic: p.unit || paper.subject,
    node: p.id,
    rating: p.marksMax ? ratingFor(p.marks / p.marksMax) : 1,
    confidence: p.confidence === undefined ? null : p.confidence,
    elapsedMs: Math.min(3600000, p.sec * 1000),
    kind: 'audit',
    grade: p.marksMax && p.marks / p.marksMax >= 0.8 ? 'recalled' : (p.marks > 0 ? 'partial' : 'lapsed'),
    source: o.cram ? 'hub:papers:cram' : 'hub:papers',
  }));
  store.appendReviewLogBatch(entries);

  /* cognitive mix tally lives in numericals.js — import lazily to avoid a cycle */
  import('../numericals.js').then((N) => {
    for (const p of perQuestion) N.recordCognitive(p.cognitive, 1);
  }).catch(() => {});

  /* predicted grade cache (stats.js recomputes from attempts; this is a cache) */
  if (attempt.heldOut && o.mode === 'full') {
    const g = subjectGradeFor(marksEarned, marksTotal);
    store.update(KEYS.PREDICTED, (prev) => Object.assign({}, prev || {}, {
      [paper.subject]: { marks: marksEarned, total: marksTotal, letter: g.letter, gp: g.gp, updatedISO: todayLocalISO() },
    }), {});
  }

  /* Game credit — ONE path per attempt (Phase B-F stitch):
     · full mock → 'engram:mock-completed'; boss.js owns the credit
       (recordActivity capped at 12, silent + recordMilestone + mock XP).
       Crediting here as well double-counted the drill ring and the XP.
     · drill     → credited directly; a drill group never raises the boss
       stage, so the mock event is not fired for it. */
  if (o.mode === 'full') {
    /* Load the game layer first — importing it wires the boss bootstrap
       listener. If it cannot load, the dispatch is harmless: no game layer,
       nothing to credit, and the attempt is already saved above. */
    import('../game.js').catch(() => null).then(() => {
      try {
        window.dispatchEvent(new CustomEvent('engram:mock-completed', {
          detail: { marksEarned, marksTotal, perQuestion, durationSec, subject: paper.subject, mode: o.mode, cram: attempt.cram, heldOut: attempt.heldOut },
        }));
      } catch (_) { /* CustomEvent unsupported — nothing else to do */ }
    });
  } else {
    gameCall('recordActivity', 'drill', {
      count: perQuestion.length,
      correct: marksTotal ? marksEarned / marksTotal >= 0.8 : false,
      seconds: durationSec,
      subject: paper.subject,
      source: 'papers:drill',
      silent: false,
    });
  }

  sound('complete');
  haptic('success');
  renderReport(root, bank, paper, attempt);
}

function ratingFor(f) {
  if (f >= 0.95) return 4;
  if (f >= 0.7) return 3;
  if (f >= 0.4) return 2;
  return 1;
}

function renderReport(root, bank, paper, attempt) {
  root.replaceChildren();
  const pct = attempt.marksTotal ? (attempt.marksEarned / attempt.marksTotal) * 100 : 0;
  const isFull = attempt.mode === 'full';
  /* Same arithmetic stats.js uses, so the letter he sees here is the letter he
     sees on the Stats page ten seconds later. A grade is only computed for a
     whole paper — a drill has no NEB grade to report. */
  const g = isFull ? subjectGradeFor(attempt.marksEarned, attempt.marksTotal) : null;
  const target = attempt.marksTotal === 75 ? A_PLUS_THEORY : Math.round(attempt.marksTotal * 0.9);
  const gap = Math.max(0, target - attempt.marksEarned);

  root.appendChild(el('div.section',
    el('section.card.card--tone.card--2xl.card--pad-lg.stack', {
      dataset: { tone: g ? (g.gp >= 3.6 ? 'good' : g.gp >= 2.8 ? 'warn' : 'bad') : 'neutral' },
    },
      eyebrow(paper.subject + ' · ' + (isFull ? 'full paper' : 'Group ' + attempt.group + ' drill') + (attempt.cram ? ' · cram' : '')),
      el('h1.section-head__title', { text: attempt.marksEarned + ' of ' + attempt.marksTotal }),
      el('div.stat-row',
        el('div.stat',
          el('div.stat__eyebrow', el('span', { text: 'Theory paper' })),
          el('div.stat__value', { text: Math.round(pct) }), el('span.stat__unit', { text: '%' })),
        g
          ? el('div.stat',
              el('div.stat__eyebrow', el('span', { text: 'Subject grade' })),
              el('div.stat__value', { text: g.letter }), el('span.stat__unit', { text: 'GP ' + g.gp.toFixed(1) }),
              el('div.stat__sub', { text: 'with a typical 23/25 practical' }))
          : null,
        isFull
          ? el('div.stat',
              el('div.stat__eyebrow', el('span', { text: 'To A+ (' + target + ')' })),
              el('div.stat__value', { text: gap === 0 ? '0' : '+' + Math.round(gap) }), el('span.stat__unit', { text: 'marks' }))
          : null,
        el('div.stat',
          el('div.stat__eyebrow', el('span', { text: 'Time used' })),
          el('div.stat__value', { text: Math.round(attempt.durationSec / 60) }), el('span.stat__unit', { text: 'min' }))
      ),
      attempt.cram
        ? el('p.hint', { text: 'Sat in cram mode. It counts, it is logged, and it is flagged — the weekly held-out paper is still the number that decides your predicted grade.' })
        : (attempt.heldOut
          ? el('p.hint', { text: 'Held-out paper. This is the one that moves your predicted grade, because nothing here has ever been taught to you.' })
          : el('p.hint', { text: 'Drill questions come from the teaching pool, so this measures practice, not progress.' }))
    )
  ));

  /* --- time vs marks ----------------------------------------------------- */
  const rows = attempt.perQuestion.slice().sort((a, b) => b.sec - a.sec);
  const worstOver = rows.filter((r) => r.sec > r.budgetSec + 60);
  const maxSec = Math.max(1, ...rows.map((r) => Math.max(r.sec, r.budgetSec)));

  const timeCard = el('section.card.card--pad-lg.stack',
    el('div.card__head', el('div',
      eyebrow('Time vs marks'),
      el('h2.card__title', { text: 'Where the three hours actually went' }),
      el('p.card__sub', { text: 'Bar = minutes spent, tick = the 2.4-min-a-mark budget. Burning 40 minutes on question 1 is the single most documented way to lose a paper you knew.' })
    )));

  const bars = el('div.stack', { style: { '--gap': 'var(--sp-3)' } });
  for (const r of rows.slice(0, 12)) {
    const overBy = r.sec - r.budgetSec;
    bars.appendChild(el('div',
      el('div.row.row--between',
        el('span.text-meta', { text: 'Q' + r.n + ' · ' + (r.unit || '—') }),
        el('span.text-meta.tabular', { text: fmt.dur(r.sec * 1000) + ' / ' + Math.round(r.budgetSec / 60) + ' min · ' + r.marks + '/' + r.marksMax })
      ),
      el('div.meter.meter--lg', { dataset: { tone: overBy > 60 ? 'bad' : overBy > 0 ? 'warn' : 'good' } },
        el('span.meter__fill', { style: { '--pct': String(Math.round((r.sec / maxSec) * 100)) } }))
    ));
  }
  timeCard.appendChild(bars);
  timeCard.appendChild(el('p.hint', {
    text: worstOver.length
      ? worstOver.length + ' ' + fmt.plural(worstOver.length, 'question') + ' ran more than a minute over budget: ' + worstOver.map((r) => 'Q' + r.n).join(', ') + '. Those minutes came out of questions further down the paper.'
      : 'Every question stayed inside its budget. That is the exam-hall skill, and it is worth marks on its own.',
  }));
  root.appendChild(el('div.section', timeCard));

  /* --- where the marks went --------------------------------------------- */
  const byGroup = {};
  for (const r of attempt.perQuestion) {
    const k = r.group;
    byGroup[k] = byGroup[k] || { earned: 0, max: 0, n: 0 };
    byGroup[k].earned += r.marks; byGroup[k].max += r.marksMax; byGroup[k].n += 1;
  }
  const groupCard = el('section.card.card--pad-lg.stack',
    el('div.card__head', el('div', eyebrow('Where the marks went'), el('h2.card__title', { text: 'By group' }))));
  for (const [k, v] of Object.entries(byGroup)) {
    const p = v.max ? (v.earned / v.max) * 100 : 0;
    groupCard.appendChild(el('div',
      el('div.row.row--between',
        el('span.text-body-lg', { text: 'Group ' + k + ' · ' + v.n + ' Q' }),
        el('span.text-meta.tabular', { text: Math.round(v.earned * 10) / 10 + ' / ' + v.max })
      ),
      el('div.meter.meter--ticks', el('span.meter__fill', { style: { '--pct': String(Math.round(p)) } }))
    ));
  }

  const confWrong = attempt.perQuestion.filter((r) => r.confidence >= 5 && r.marksMax && r.marks / r.marksMax < 0.5);
  const blanks = attempt.perQuestion.filter((r) => r.blank);
  if (confWrong.length) {
    groupCard.appendChild(el('div.card.card--tone', { dataset: { tone: 'bad' } },
      el('span.eyebrow', { text: 'Confident and wrong' }),
      el('p.prose', { text: confWrong.map((r) => 'Q' + r.n).join(', ') + ' — you were certain and scored under half. That is a rule you trust being wrong, which is the most expensive thing in the paper and the fastest thing to fix.' })
    ));
  }
  if (blanks.length) {
    groupCard.appendChild(el('p.hint', { text: blanks.length + ' ' + fmt.plural(blanks.length, 'question') + ' left blank: ' + blanks.map((r) => 'Q' + r.n).join(', ') + '. A blank is a certain zero; a wrong attempt at a 5-mark question still collects method marks.' }));
  }
  root.appendChild(el('div.section', groupCard));

  /* --- cognitive mix of the paper --------------------------------------- */
  const cog = {};
  for (const r of attempt.perQuestion) {
    cog[r.cognitive] = cog[r.cognitive] || { earned: 0, max: 0 };
    cog[r.cognitive].earned += r.marks; cog[r.cognitive].max += r.marksMax;
  }
  const cogCard = el('section.card.card--pad-lg.stack',
    el('div.card__head', el('div',
      eyebrow('Cognitive levels'),
      el('h2.card__title', { text: 'Which kind of thinking cost you marks' }),
      el('p.card__sub', { text: 'The CDC grid is roughly 15% knowledge, 25% understanding, 35% application, 25% higher ability. Only about 11 of 75 marks are pure recall.' })
    )));
  for (const [k, v] of Object.entries(cog)) {
    const p = v.max ? (v.earned / v.max) * 100 : 0;
    cogCard.appendChild(el('div',
      el('div.row.row--between',
        el('span.text-body-lg', { text: COGNITIVE_LABEL[k] || k }),
        el('span.text-meta.tabular', { text: Math.round(v.earned * 10) / 10 + ' / ' + v.max })
      ),
      el('div.meter', el('span.meter__fill', { style: { '--pct': String(Math.round(p)) } }))
    ));
  }
  root.appendChild(el('div.section', cogCard));

  root.appendChild(el('div.section', el('div.btn-row',
    el('button.btn.btn-primary', { type: 'button', onClick: () => { renderHome(root, bank); } },
      icon('file-text', { size: 16 }), el('span', { text: 'Back to papers' })),
    el('button.btn.btn-secondary', { type: 'button', onClick: () => navigate('stats') },
      icon('trending-up', { size: 16 }), el('span', { text: 'Predicted grade' }))
  )));

  root.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
