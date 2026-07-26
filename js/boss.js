/* =============================================================================
   js/boss.js — the mock-paper boss battle: a PRESENTATION layer over a result
   that has already been computed elsewhere.
   Job: GAME LAYER. Pulled in on demand by game.js the first time
   'engram:mock-completed' fires, so a mock anywhere in the hub gets the stage.

   Event contract (SHARED APIS #4):
     window.dispatchEvent(new CustomEvent('engram:mock-completed', { detail: {
       marksEarned, marksTotal, perQuestion[], durationSec, subject
     }}));

   Mapping:  boss HP = marksTotal     damage = marksEarned

   Tone rules (pedagogy-spec §3.7 — these are not decoration):
     · MARKS-LANGUAGE ONLY. "41 of 75 landed. Last time 36 — that is +5."
       Never "well done", never "good effort", never a vague adjective.
     · A paper that is still standing is never framed as a failure. It is
       framed as the remaining marks and exactly where they are.
     · XP is paid for SITTING the paper, not for the marks on it — correctness
       must never drive the XP number (§4).
     · Every animation is gated on prefersReducedMotion().
   ========================================================================== */

import {
  recordActivity, recordMilestone, awardXP, celebrate, cue, injectStyle,
  getBadges, getTitles, XP_MOCK_COMPLETED,
} from './game.js';
import { store, KEYS, todayLocalISO } from './store.js';
import { el, icon, fmt, prefersReducedMotion, clamp } from './dom.js';

/* ---------------------------------------------------------------------------
   1. Bosses, themed per subject
   ------------------------------------------------------------------------ */

/* `accent` is the recolouring contract from CONTRACT-A §13: a data-subject
   value where one exists for the subject, otherwise a data-tone value. */
const BOSSES = Object.freeze({
  Physics: { name: 'The Gravitation Warden', icon: 'atom', accent: { subject: 'physics' }, line: 'Half its marks are numericals. Units on every line.' },
  Chemistry: { name: 'The Stoichiometry Furnace', icon: 'flask', accent: { subject: 'chemistry' }, line: 'It feeds on mole ratios applied to grams.' },
  Mathematics: { name: 'The Calculus Gate', icon: 'sigma', accent: { subject: 'mathematics' }, line: 'It only opens for the right method, chosen first.' },
  Maths: { name: 'The Calculus Gate', icon: 'sigma', accent: { subject: 'maths' }, line: 'It only opens for the right method, chosen first.' },
  Biology: { name: 'The Cell Archive', icon: 'brain', accent: { tone: 'good' }, line: 'Diagrams are marked line by line in here.' },
  'Computer Science': { name: 'The Logic Gate', icon: 'code', accent: { subject: 'computer-science' }, line: 'Fifty marks, nine slots, no spare time.' },
  English: { name: 'The Comprehension Gauntlet', icon: 'book-open', accent: { subject: 'english' }, line: 'It marks structure before it marks vocabulary.' },
  Nepali: { name: 'The Prose Gate', icon: 'languages', accent: { subject: 'nepali' }, line: 'It wants the answer in the register the paper asked for.' },
  _default: { name: 'The Full Paper', icon: 'swords', accent: { tone: 'brand' }, line: 'Twenty-two answer slots. Three hours.' },
});

/** Outcome tiers. `down` is the defeat state. */
const TIERS = Object.freeze([
  { id: 'apex', min: 0.89, label: 'Down — past the A+ line', tone: 'good' },
  { id: 'down', min: 0.80, label: 'Down', tone: 'good' },
  { id: 'staggered', min: 0.60, label: 'Staggered', tone: 'warn' },
  { id: 'wounded', min: 0.40, label: 'Wounded', tone: 'warn' },
  { id: 'standing', min: 0, label: 'Still standing', tone: 'info' },
]);

function tierFor(ratio) {
  for (const t of TIERS) if (ratio >= t.min) return t;
  return TIERS[TIERS.length - 1];
}

function bossFor(subject) {
  const key = String(subject || '').trim();
  return BOSSES[key] || BOSSES._default;
}

/* ---------------------------------------------------------------------------
   2. Styles (tokens only — the stage is otherwise built from components.css)
   ------------------------------------------------------------------------ */

const BOSS_CSS = `
.boss-stage .modal__foot { justify-content: space-between; align-items: center; }
.boss-stage__head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding-bottom: var(--sp-3);
}
.boss-stage__mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  border-radius: var(--r-xl);
  border: 1px solid rgb(var(--accent-rgb) / 0.4);
  background: rgb(var(--accent-rgb) / 0.14);
  color: var(--accent);
  box-shadow: var(--lip), 0 12px 32px -14px rgb(var(--accent-rgb) / 0.9);
}
.boss-stage__mark.is-hit { animation: boss-shake 0.22s var(--ease-pop); }
.boss-stage__name { font-size: var(--fs-title); font-weight: var(--fw-semibold); letter-spacing: -0.02em; }
.boss-stage__line { font-size: var(--fs-meta); color: var(--fg-muted); }
.boss-hp { margin: var(--sp-2) 0 var(--sp-4); }
.boss-hp__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: var(--fs-meta);
  color: var(--fg-muted);
  margin-bottom: 6px;
}
.boss-hp__num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg); }
.boss-q {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}
.boss-q__cell {
  flex: 1 1 10px;
  min-width: 8px;
  height: 18px;
  border-radius: var(--r-sm);
  background: var(--surface-muted);
  box-shadow: var(--lip);
  /* background only — animating box-shadow repaints the cell every frame and
     the colour already carries the hit state. */
  transition: background var(--dur) var(--ease);
}
.boss-q__cell[data-hit="full"] { background: rgb(var(--good-rgb) / 0.85); box-shadow: 0 0 8px -2px rgb(var(--good-rgb) / 0.9); }
.boss-q__cell[data-hit="part"] { background: rgb(var(--warn-rgb) / 0.75); }
.boss-q__cell[data-hit="none"] { background: rgb(var(--bad-rgb) / 0.35); }
.boss-leak { display: flex; flex-direction: column; gap: 6px; }
.boss-leak__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 8px 10px;
  border-radius: var(--r-md);
  background: var(--surface-muted);
  box-shadow: var(--lip);
  font-size: var(--fs-caption);
}
.boss-leak__marks { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--bad); }
.boss-loot { display: flex; flex-wrap: wrap; gap: var(--sp-3); }

@keyframes boss-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-3px); }
  75%      { transform: translateX(3px); }
}
@media (prefers-reduced-motion: reduce) {
  .boss-stage__mark.is-hit { animation: none !important; }
  .boss-q__cell { transition: none !important; }
}
`;

/* ---------------------------------------------------------------------------
   3. Normalising the incoming result
   ------------------------------------------------------------------------ */

function normalise(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const marksTotal = Math.max(1, Math.round(Number(d.marksTotal) || 75));
  const marksEarned = clamp(Math.round(Number(d.marksEarned) || 0), 0, marksTotal);
  const perQuestion = (Array.isArray(d.perQuestion) ? d.perQuestion : [])
    .map((q, i) => {
      const row = q && typeof q === 'object' ? q : { marks: Number(q) || 0 };
      const outOf = Math.max(0, Number(row.marksTotal ?? row.outOf ?? row.max ?? row.of ?? 0));
      const got = clamp(Number(row.marks ?? row.earned ?? 0) || 0, 0, outOf || Infinity);
      return {
        n: Number(row.n) || i + 1,
        label: String(row.label || row.id || ('Q' + (Number(row.n) || i + 1))),
        marks: got,
        outOf,
        group: row.group || null,
        seconds: Number(row.seconds) || 0,
      };
    });
  return {
    subject: d.subject ? String(d.subject) : null,
    marksEarned,
    marksTotal,
    perQuestion,
    durationSec: Math.max(0, Math.round(Number(d.durationSec) || 0)),
    paperId: d.paperId ? String(d.paperId) : null,
  };
}

/** Previous best damage on this subject's boss, for the honest comparison. */
function readBest(subject) {
  const g = store.get(KEYS.GAME, null);
  const bests = g && typeof g === 'object' && g.bossBest && typeof g.bossBest === 'object' ? g.bossBest : {};
  const row = bests[subject || '_all'];
  return row && typeof row === 'object' ? row : null;
}

function writeBest(subject, marks, marksTotal) {
  store.update(KEYS.GAME, (prev) => {
    const g = prev && typeof prev === 'object' ? Object.assign({}, prev) : {};
    const bests = g.bossBest && typeof g.bossBest === 'object' ? Object.assign({}, g.bossBest) : {};
    const key = subject || '_all';
    const cur = bests[key];
    if (!cur || Number(cur.marks) < marks) bests[key] = { marks, marksTotal, on: todayLocalISO() };
    g.bossBest = bests;
    return g;
  }, {});
}

/* ---------------------------------------------------------------------------
   4. Loot — what actually dropped, revealed rather than invented
   ------------------------------------------------------------------------ */

function idsOf(list) { return new Set(list.filter((x) => x.earned).map((x) => x.id)); }

/**
 * Sit-the-paper XP plus a small deterministic salvage roll, then whatever
 * badges/titles the run actually unlocked. XP never scales with marks.
 */
function rollLoot(result, before) {
  const loot = [];

  const sitXP = XP_MOCK_COMPLETED;
  // Salvage: deterministic from the paper + the day, so it cannot be re-rolled.
  let h = 2166136261 >>> 0;
  const seed = (result.subject || '') + '|' + result.marksTotal + '|' + todayLocalISO() + '|' + result.perQuestion.length;
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const salvage = 10 + (h % 31);

  awardXP(sitXP + salvage, 'mock-sat');
  loot.push({ kind: 'xp', label: fmt.int(sitXP + salvage) + ' XP', icon: 'zap', tone: 'brand', note: 'for sitting the paper' });

  const afterBadges = idsOf(getBadges());
  for (const id of afterBadges) {
    if (!before.badges.has(id)) {
      const b = getBadges().find((x) => x.id === id);
      loot.push({ kind: 'badge', label: b ? b.label : id, icon: b ? b.icon : 'trophy', tone: b ? b.tone : 'good', note: 'badge' });
    }
  }
  const afterTitles = idsOf(getTitles());
  for (const id of afterTitles) {
    if (!before.titles.has(id)) {
      const t = getTitles().find((x) => x.id === id);
      // Prefixed: a badge and a title can legitimately share a name
      // ("Came Back"), and an unlabelled duplicate in the loot row is noise.
      loot.push({ kind: 'title', label: 'Title · ' + (t ? t.label : id), icon: 'crown', tone: 'ai', note: 'title unlocked' });
    }
  }
  return loot;
}

/* ---------------------------------------------------------------------------
   5. The stage
   ------------------------------------------------------------------------ */

let openStage = null;

function closeStage() {
  if (!openStage) return;
  const { scrim, modal, restore, offKey } = openStage;
  openStage = null;
  try { offKey(); } catch (_) { /* ignore */ }
  scrim.remove();
  modal.remove();
  if (restore && typeof restore.focus === 'function') { try { restore.focus(); } catch (_) { /* ignore */ } }
}

/**
 * Show the boss stage for an already-normalised result.
 * @param {Object} result
 * @param {Array} loot
 */
function showStage(result, loot, best) {
  if (typeof document === 'undefined') return null;
  injectStyle('engram-boss-style', BOSS_CSS);
  closeStage();

  const boss = bossFor(result.subject);
  const ratio = result.marksEarned / result.marksTotal;
  const tier = tierFor(ratio);
  const down = tier.id === 'down' || tier.id === 'apex';
  const still = prefersReducedMotion();
  const restore = document.activeElement;

  const scrim = el('div.scrim', { onClick: closeStage });
  const modal = el('div.modal.boss-stage', {
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': boss.name + ' result' },
    dataset: boss.accent,
  });

  /* --- head --- */
  const mark = el('div.boss-stage__mark', icon(boss.icon, { size: 24 }));
  modal.appendChild(el('div.modal__head',
    el('div.boss-stage__head',
      mark,
      el('div', {},
        el('div.boss-stage__name', { text: boss.name }),
        el('div.boss-stage__line', { text: boss.line })))));

  /* --- body --- */
  const body = el('div.modal__body');

  /* HP bar: fills from full down to whatever survived. */
  const hpFill = el('span.meter__fill', { style: { '--pct': '100' } });
  const hpNum = el('span.boss-hp__num', { text: result.marksTotal + ' / ' + result.marksTotal });
  body.appendChild(el('div.boss-hp',
    el('div.boss-hp__row',
      el('span', { text: 'Paper HP' }),
      hpNum),
    el('div.meter.meter--lg', { attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(result.marksTotal), 'aria-valuenow': String(result.marksTotal - result.marksEarned) } }, hpFill)));

  /* Per-question hit strip. */
  const cells = [];
  if (result.perQuestion.length) {
    const strip = el('div.boss-q', { attrs: { 'aria-hidden': 'true' } });
    for (const q of result.perQuestion) {
      const cell = el('span.boss-q__cell');
      cells.push({ cell, q });
      strip.appendChild(cell);
    }
    body.appendChild(strip);
  }

  /* Marks-language readout. */
  const deltaText = best && Number.isFinite(Number(best.marks))
    ? (result.marksEarned >= best.marks
      ? 'Best so far on this paper. Previous best ' + Math.round(best.marks) + '.'
      : 'Your best on this paper is ' + Math.round(best.marks) + ' — that is '
        + (Math.round(best.marks) - result.marksEarned) + ' marks away.')
    : 'First run at this paper. This is the number every later run is measured against.';

  const aPlus = Math.ceil(result.marksTotal * (67 / 75));
  const toAPlus = Math.max(0, aPlus - result.marksEarned);

  body.appendChild(el('div.stat-row',
    el('div.stat',
      el('div.stat__eyebrow', { text: 'Marks landed' }),
      el('div.stat__value', { text: String(result.marksEarned) },
        el('span.stat__unit', { text: ' / ' + result.marksTotal })),
      el('div.stat__sub', { text: deltaText })),
    el('div.stat',
      el('div.stat__eyebrow', { text: 'To the A+ line' }),
      el('div.stat__value', { text: String(toAPlus) },
        el('span.stat__unit', { text: ' marks' })),
      el('div.stat__sub', { text: aPlus + ' of ' + result.marksTotal + ' is the A+ theory line.' }))));

  /* Where the marks leaked — the three biggest losses, named. */
  const leaks = result.perQuestion
    .filter((q) => q.outOf > 0 && q.marks < q.outOf)
    .map((q) => Object.assign({}, q, { lost: q.outOf - q.marks }))
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 3);
  if (leaks.length) {
    body.appendChild(el('div.section-head',
      el('h3.section-head__title', { text: 'Where the marks went' })));
    const list = el('div.boss-leak');
    for (const q of leaks) {
      list.appendChild(el('div.boss-leak__row',
        el('span', { text: q.label + (q.group ? ' · group ' + q.group : '') }),
        el('span.boss-leak__marks', { text: '−' + fmt.num(q.lost) + ' of ' + fmt.num(q.outOf) })));
    }
    body.appendChild(list);
  }

  if (result.durationSec > 0) {
    const perMark = result.durationSec / 60 / Math.max(1, result.marksTotal);
    body.appendChild(el('p.hint', {
      text: fmt.dur(result.durationSec * 1000) + ' on the clock — '
        + perMark.toFixed(1) + ' min per mark. The paper pays 2.4.',
    }));
  }

  /* Loot. */
  if (loot.length) {
    body.appendChild(el('div.section-head', el('h3.section-head__title', { text: 'Loot' })));
    const lootRow = el('div.boss-loot');
    for (const drop of loot) {
      lootRow.appendChild(el('div.badge', { dataset: { tone: drop.tone || 'brand' } },
        el('span.badge__medal', icon(drop.icon, { size: 20 })),
        el('span.badge__label', { text: drop.label })));
    }
    body.appendChild(lootRow);
    body.appendChild(el('p.hint', { text: 'XP is for sitting the paper, not for the marks on it.' }));
  }

  modal.appendChild(body);

  /* --- foot --- */
  const closeBtn = el('button.btn.btn-primary', { type: 'button', text: 'Back to the hub', onClick: closeStage });
  modal.appendChild(el('div.modal__foot',
    el('span.pill', { class: 'pill--' + tier.tone, text: tier.label }),
    el('div.btn-row', closeBtn)));

  document.body.appendChild(scrim);
  document.body.appendChild(modal);

  /* Escape closes; Tab stays inside the dialog (aria-modal is a promise to the
     screen reader that focus cannot wander behind the scrim). */
  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeStage(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(modal.querySelectorAll(FOCUSABLE)).filter((n) => !n.disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const outside = !modal.contains(active);
    if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  openStage = { scrim, modal, restore, offKey: () => document.removeEventListener('keydown', onKey) };
  try { closeBtn.focus({ preventScroll: true }); } catch (_) { /* ignore */ }

  /* --- the hits --- */
  const finalHp = result.marksTotal - result.marksEarned;
  const setHp = (hp) => hpFill.style.setProperty('--pct', String(Math.round((hp / result.marksTotal) * 100)));
  const settle = () => {
    setHp(finalHp);
    hpNum.textContent = finalHp + ' / ' + result.marksTotal;
    for (const { cell, q } of cells) {
      cell.dataset.hit = q.outOf <= 0 ? 'none' : (q.marks >= q.outOf ? 'full' : (q.marks > 0 ? 'part' : 'none'));
    }
  };

  if (still || !cells.length) {
    settle();
    cue(down ? 'boss-down' : 'boss-stand');
  } else {
    const steps = Math.min(cells.length, 12);
    const per = Math.max(60, Math.round(720 / steps));
    let i = 0;
    let running = 0;
    const tick = () => {
      if (!openStage) return;
      const slice = Math.ceil(cells.length / steps);
      for (let k = 0; k < slice && i < cells.length; k += 1, i += 1) {
        const { cell, q } = cells[i];
        cell.dataset.hit = q.outOf <= 0 ? 'none' : (q.marks >= q.outOf ? 'full' : (q.marks > 0 ? 'part' : 'none'));
        running += q.marks;
      }
      const hp = clamp(result.marksTotal - running, finalHp, result.marksTotal);
      setHp(hp);
      hpNum.textContent = Math.round(hp) + ' / ' + result.marksTotal;
      mark.classList.add('is-hit');
      setTimeout(() => mark.classList.remove('is-hit'), 220);
      cue('boss-hit');
      if (i < cells.length) setTimeout(tick, per);
      else { settle(); setTimeout(() => cue(down ? 'boss-down' : 'boss-stand'), 160); }
    };
    setTimeout(tick, 260);
  }

  return modal;
}

/* ---------------------------------------------------------------------------
   6. Entry points
   ------------------------------------------------------------------------ */

let handling = false;

/**
 * Handle one 'engram:mock-completed' payload: credit the work, roll the loot,
 * raise the stage.
 * @param {{marksEarned:number, marksTotal:number, perQuestion:Array,
 *          durationSec:number, subject:string}} detail
 */
export function handleMockCompleted(detail) {
  if (handling) return null;
  handling = true;
  try {
    const result = normalise(detail);
    const ratio = result.marksEarned / result.marksTotal;
    const tier = tierFor(ratio);
    const down = tier.id === 'down' || tier.id === 'apex';
    const best = readBest(result.subject);

    const before = { badges: idsOf(getBadges()), titles: idsOf(getTitles()) };

    /* Credit the work. A full paper counts as drill work, capped so it cannot
       distort the adaptive ring goals. */
    recordActivity('drill', {
      count: clamp(result.perQuestion.length || 8, 1, 12),
      seconds: result.durationSec,
      subject: result.subject,
      source: 'mock',
      silent: true,
    });
    recordMilestone('timed-paper', {
      subject: result.subject,
      marks: result.marksEarned,
      marksTotal: result.marksTotal,
    });
    if (down) recordMilestone('boss-down', { subject: result.subject, marks: result.marksEarned });

    const loot = rollLoot(result, before);
    writeBest(result.subject, result.marksEarned, result.marksTotal);

    const stage = showStage(result, loot, best);

    if (down) {
      celebrate({
        kind: 'boss',
        label: bossFor(result.subject).name + ' is down',
        body: result.marksEarned + ' of ' + result.marksTotal + ' marks landed.',
        subject: result.subject,
        tone: 'good',
      });
    }
    return stage;
  } catch (err) {
    console.error('[boss] failed to present the mock result', err);
    return null;
  } finally {
    handling = false;
  }
}

let wired = false;

/** Start listening for mock results. Idempotent. */
export function initBoss() {
  if (wired || typeof window === 'undefined') return false;
  wired = true;
  window.addEventListener('engram:mock-completed', (e) => handleMockCompleted(e && e.detail));
  return true;
}

/** Dismiss the stage from outside (route change, for instance). */
export function dismissBoss() { closeStage(); }

/** Exposed for the papers view and for manual checks. */
export { showStage as showBossStage, bossFor, tierFor, BOSSES, TIERS };

export default { initBoss, handleMockCompleted, dismissBoss, bossFor, tierFor };
