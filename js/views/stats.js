/* =============================================================================
   js/views/stats.js — the honest scoreboard. Job C.

   Five things, in this order, because that is the order they matter in:
     1. PREDICTED GRADE per subject — theory out of 75 computed ONLY from
        held-out full-paper attempts, then letter, then grade point, then the
        distance to the 67/75 wall. Plus a GPA simulator across every subject,
        because one NG subject destroys the whole picture and he should be able
        to see that rather than be told it.
     2. COGNITIVE MIX — his practice mix against the CDC grid (15/25/35/25).
        Recall-only practice is the documented national failure mode; this is
        the meter that makes the mismatch visible.
     3. COVERAGE DIALS per subject — how much of the syllabus has actually been
        touched, and how many items are currently held at ≥90% recall.
     4. EFFORT VS MARKS — study minutes per week against held-out mock
        percentage. This is the chart Hermes cites when high-load work feels
        worse than rereading.
     5. REVIEW LOG — the raw table, mono ids, tabular numerics, nothing hidden.

   Everything here refuses to invent a number. No held-out paper means no
   predicted grade, and it says so.
   ========================================================================== */

import { el, icon, fmt, emptyState, eyebrow, clamp } from '../dom.js';
import {
  store, KEYS, todayLocalISO, parseLocalISO, addDaysISO, dayKeyFromTs, RATING_NAMES,
} from '../store.js';
import { navigate } from '../router.js';
import { getTopics, getSubjects, isVaultMissing } from '../vault.js';
import { retrievability, isNew } from '../scheduler.js';
import {
  cognitiveMix, scaffoldSummary, attemptTally, loadExamCalendar,
  daysToNextExam, SCAFFOLD_LEVELS,
} from '../numericals.js';
import { allAttempts, gradeFor, A_PLUS_THEORY, loadBank, bankSubjects } from './papers.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Practical marks assumed when converting theory to a full subject grade.
 *  neb-nepal §4.2 — practicals are marked generously, 20–24 out of 25. */
const ASSUMED_PRACTICAL = 23;

const COGNITIVE_LABEL = {
  knowledge: 'Knowledge', understanding: 'Understanding',
  application: 'Application', higher: 'Higher ability',
};

/* ---------------------------------------------------------------------------
   Tiny SVG helper — dom.js el() is HTML-only and there is no innerHTML here.
   ------------------------------------------------------------------------ */

function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined) continue;
    if (k === 'style') node.setAttribute('style', v);
    else if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(3)) if (c) node.appendChild(c);
  return node;
}

function subjectKey(subject) {
  return String(subject || '').toLowerCase().replace(/\s+/g, '-');
}

/* ---------------------------------------------------------------------------
   Predicted grade
   ------------------------------------------------------------------------ */

/**
 * Predicted theory mark for a subject, from held-out FULL paper attempts only.
 * Recency-weighted over the last three (3:2:1) — one bad morning should not
 * define the prediction, and one good one should not either.
 * @returns {{ok:boolean, marks?:number, total?:number, pct?:number, letter?:string,
 *            gp?:number, gap?:number, attempts:number, trend?:number|null, lastTs?:number}}
 */
export function predictFor(subject) {
  const rows = allAttempts({ subject, mode: 'full', heldOutOnly: true })
    .filter((a) => a.marksTotal > 0);
  if (!rows.length) return { ok: false, attempts: 0 };

  const recent = rows.slice(0, 3);
  const weights = [3, 2, 1];
  let num = 0, den = 0;
  recent.forEach((a, i) => {
    const w = weights[i] || 1;
    num += (a.marksEarned / a.marksTotal) * w;
    den += w;
  });
  const total = rows[0].marksTotal;
  const pct = (num / den) * 100;
  const marks = Math.round((pct / 100) * total * 10) / 10;

  // Grade is on the FULL subject total (theory + assumed practical), NEB-style.
  const subjectPct = ((marks + ASSUMED_PRACTICAL) / (total + 25)) * 100;
  const g = gradeFor(subjectPct);
  const target = total === 75 ? A_PLUS_THEORY : Math.round(total * 0.9);

  let trend = null;
  if (rows.length >= 2) {
    const a = rows[0].marksEarned / rows[0].marksTotal;
    const b = rows[1].marksEarned / rows[1].marksTotal;
    trend = Math.round((a - b) * (rows[0].marksTotal) * 10) / 10;
  }

  return {
    ok: true,
    marks, total,
    pct: Math.round(pct * 10) / 10,
    subjectPct: Math.round(subjectPct * 10) / 10,
    letter: g.letter, gp: g.gp,
    target,
    gap: Math.max(0, Math.round((target - marks) * 10) / 10),
    attempts: rows.length,
    trend,
    lastTs: rows[0].ts,
    cramShare: rows.filter((a) => a.cram).length,
  };
}

/* ---------------------------------------------------------------------------
   Coverage
   ------------------------------------------------------------------------ */

function coverageBySubject() {
  const topics = getTopics();
  const srs = store.get(KEYS.SRS, {}) || {};
  const map = new Map();

  for (const t of topics) {
    const key = t.subject || 'Unsorted';
    const row = map.get(key) || { subject: key, topics: 0, touched: 0, cards: 0, seen: 0, held: 0 };
    row.topics += 1;
    let touched = false;
    for (const c of t.flashcards || []) {
      row.cards += 1;
      const card = srs[c.id];
      if (card && !isNew(card)) {
        row.seen += 1;
        touched = true;
        const r = retrievability(card);
        if (r !== null && r >= 0.9) row.held += 1;
      }
    }
    if (touched) row.touched += 1;
    map.set(key, row);
  }

  return Array.from(map.values()).map((r) => Object.assign(r, {
    pct: r.topics ? Math.round((r.touched / r.topics) * 100) : 0,
  })).sort((a, b) => b.pct - a.pct);
}

/* ---------------------------------------------------------------------------
   Effort vs marks — weekly buckets
   ------------------------------------------------------------------------ */

function mondayOf(iso) {
  const d = parseLocalISO(iso);
  if (!d) return iso;
  const shift = (d.getDay() + 6) % 7;         // Monday = 0
  return addDaysISO(iso, -shift);
}

function weeklySeries(weeks) {
  const n = Math.max(4, Math.round(weeks || 10));
  const today = todayLocalISO();
  const thisWeek = mondayOf(today);

  const keys = [];
  for (let i = n - 1; i >= 0; i -= 1) keys.push(addDaysISO(thisWeek, -7 * i));

  const buckets = new Map(keys.map((k) => [k, { week: k, minutes: 0, attempts: 0, mockPct: null, mocks: 0 }]));

  const sessions = store.get(KEYS.SESSIONS, {}) || {};
  for (const [day, row] of Object.entries(sessions)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !row) continue;
    const wk = mondayOf(day);
    const b = buckets.get(wk);
    if (!b) continue;
    b.minutes += Math.round((Number(row.seconds) || 0) / 60);
    b.attempts += Math.max(0, Number(row.attempts) || Number(row.reviews) || 0);
  }

  for (const a of allAttempts({ mode: 'full', heldOutOnly: true })) {
    const wk = mondayOf(dayKeyFromTs(a.ts));
    const b = buckets.get(wk);
    if (!b || !a.marksTotal) continue;
    const pct = (a.marksEarned / a.marksTotal) * 100;
    b.mockPct = b.mocks ? (b.mockPct * b.mocks + pct) / (b.mocks + 1) : pct;
    b.mocks += 1;
  }

  return Array.from(buckets.values());
}

function effortChart(series) {
  const W = 640, H = 220, padL = 40, padR = 40, padT = 20, padB = 34;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxMin = Math.max(60, ...series.map((s) => s.minutes));
  const bw = innerW / series.length;

  const kids = [];

  // horizontal guides at 0/25/50/75/100% of the marks axis
  for (const p of [0, 25, 50, 75, 100]) {
    const y = padT + innerH * (1 - p / 100);
    kids.push(svg('line', {
      x1: padL, x2: W - padR, y1: y, y2: y,
      style: 'stroke: var(--hairline); stroke-width: 1',
    }));
    kids.push(svg('text', {
      x: W - padR + 6, y: y + 4, text: p + '%',
      style: 'fill: var(--fg-subtle); font-size: 10px; font-family: var(--font-mono)',
    }));
  }

  // the 67/75 = 89% wall
  const wallY = padT + innerH * (1 - 89 / 100);
  kids.push(svg('line', {
    x1: padL, x2: W - padR, y1: wallY, y2: wallY,
    style: 'stroke: var(--brand); stroke-width: 1.5; stroke-dasharray: 4 4; opacity: .8',
  }));
  kids.push(svg('text', {
    x: padL + 4, y: wallY - 5, text: 'A+ wall — 67/75',
    style: 'fill: var(--brand); font-size: 10px; letter-spacing: .08em',
  }));

  // effort bars
  series.forEach((s, i) => {
    const h = maxMin ? (s.minutes / maxMin) * innerH : 0;
    kids.push(svg('rect', {
      x: padL + i * bw + bw * 0.22,
      y: padT + innerH - h,
      width: bw * 0.56,
      height: Math.max(0, h),
      rx: 2,
      style: 'fill: rgb(var(--accent-rgb) / .38)',
    }));
    if (i % 2 === 0 || series.length <= 8) {
      kids.push(svg('text', {
        x: padL + i * bw + bw / 2, y: H - 12, text: fmt.dateShort(s.week),
        'text-anchor': 'middle',
        style: 'fill: var(--fg-subtle); font-size: 9px',
      }));
    }
  });

  // marks line
  const pts = [];
  series.forEach((s, i) => {
    if (s.mockPct === null) return;
    pts.push({
      x: padL + i * bw + bw / 2,
      y: padT + innerH * (1 - clamp(s.mockPct, 0, 100) / 100),
      pct: s.mockPct,
    });
  });
  if (pts.length > 1) {
    kids.push(svg('polyline', {
      points: pts.map((p) => p.x + ',' + p.y).join(' '),
      style: 'fill: none; stroke: var(--good); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round',
    }));
  }
  for (const p of pts) {
    kids.push(svg('circle', { cx: p.x, cy: p.y, r: 4, style: 'fill: var(--good); stroke: var(--surface); stroke-width: 2' }));
  }

  // y axis label for minutes
  kids.push(svg('text', {
    x: padL - 6, y: padT + 4, text: maxMin + 'm',
    'text-anchor': 'end',
    style: 'fill: var(--fg-subtle); font-size: 10px; font-family: var(--font-mono)',
  }));

  const chart = svg('svg', {
    viewBox: '0 0 ' + W + ' ' + H,
    role: 'img',
    'aria-label': 'Study minutes per week as bars, held-out mock percentage as a line',
    style: 'width: 100%; height: auto; min-width: 520px; display: block',
  }, kids);

  return el('div.scroll-x', chart);
}

/* ---------------------------------------------------------------------------
   THE VIEW
   ------------------------------------------------------------------------ */

export default {
  id: 'stats',
  title: 'Stats',
  icon: 'trending-up',

  async render(root) {
    await Promise.all([loadBank(), loadExamCalendar()]);

    root.appendChild(el('div.section',
      el('div.section-head', el('div',
        el('h1.section-head__title', { text: 'Where you actually are' }),
        el('p.section-head__sub', { text: 'Every number below comes from something you did. Nothing here is an estimate of how you feel — predicted grades move only when you sit a held-out paper.' })
      ))
    ));

    root.appendChild(predictedSection());
    root.appendChild(cognitiveSection());
    root.appendChild(coverageSection());
    root.appendChild(effortSection());
    root.appendChild(scaffoldSection());
    root.appendChild(reviewLogSection());
  },
};

/* --- 1. predicted grade + GPA simulator ---------------------------------- */

function subjectUniverse() {
  const set = new Set();
  if (!isVaultMissing()) for (const s of getSubjects()) set.add(s);
  // The QUESTION BANK counts too. A subject can be fully examinable — Papers
  // will happily build a 75-mark paper for it — while its vault topic is
  // deferred and unauthored. Reading the vault alone made that subject
  // disappear from Predicted grade and from the GPA denominator without ever
  // saying so, which is the deferred-topic path failing quietly instead of
  // gracefully. render() awaits loadBank(), so this is populated by now.
  for (const s of bankSubjects()) set.add(s);
  for (const a of allAttempts()) set.add(a.subject);
  const predicted = store.get(KEYS.PREDICTED, {}) || {};
  for (const s of Object.keys(predicted)) set.add(s);
  return Array.from(set).sort();
}

function predictedSection() {
  const section = el('div.section');
  const subjects = subjectUniverse();

  section.appendChild(el('div.section-head',
    el('div',
      el('h2.section-head__title', { text: 'Predicted grade' }),
      el('p.section-head__sub', { text: 'Theory out of 75, from held-out mock attempts only — the bank Hermes never teaches from. A+ needs 67/75 with a typical 23/25 practical.' })
    ),
    el('button.btn.btn-ghost.btn--sm', { type: 'button', onClick: () => navigate('papers') },
      icon('file-text', { size: 14 }), el('span', { text: 'Sit a paper' }))
  ));

  if (!subjects.length) {
    section.appendChild(emptyState({
      icon: 'gauge',
      title: 'No subjects yet',
      body: 'Predicted grades appear once there is a vault or a question bank to measure against.',
    }));
    return section;
  }

  const grid = el('div.card-grid');
  const gps = [];
  let ungraded = 0;

  for (const subject of subjects) {
    const p = predictFor(subject);
    const card = el('article.card.card--tone.card--pad-lg.stack', { dataset: { subject: subjectKey(subject) } });

    card.appendChild(el('div.card__head',
      el('div', eyebrow(subject), el('h3.card__title', { text: p.ok ? p.marks + ' / ' + p.total : 'No prediction yet' })),
      p.ok ? el('span.pill', {
        class: p.gp >= 3.6 ? 'pill--good' : p.gp >= 2.8 ? 'pill--warn' : 'pill--bad',
        text: p.letter + ' · ' + p.gp.toFixed(1),
      }) : el('span.pill.pill--neutral', { text: 'unmeasured' })
    ));

    if (!p.ok) {
      card.appendChild(el('p.hint', { text: 'One full held-out paper turns this into a real number. Until then anything shown here would be a guess, so nothing is shown.' }));
      grid.appendChild(card);
      ungraded += 1;
      continue;
    }

    gps.push(p.gp);

    card.appendChild(el('div.meter-row',
      el('div.meter.meter--lg.meter--ticks', el('span.meter__fill', { style: { '--pct': String(Math.round(p.pct)) } })),
      el('span.meter__label', { text: Math.round(p.pct) + '%' })
    ));

    card.appendChild(el('div.stat-row',
      el('div.stat',
        el('div.stat__eyebrow', el('span', { text: 'Gap to ' + p.target })),
        el('div.stat__value', { text: p.gap === 0 ? 'clear' : '+' + p.gap }),
        p.gap === 0 ? null : el('span.stat__unit', { text: 'marks' })),
      el('div.stat',
        el('div.stat__eyebrow', el('span', { text: 'Papers sat' })),
        el('div.stat__value', { text: String(p.attempts) }),
        el('p.stat__sub', { text: 'last ' + fmt.rel(p.lastTs) })),
      p.trend === null ? null : el('div.stat',
        el('div.stat__eyebrow', el('span', { text: 'Since last time' })),
        el('div.stat__value', { text: (p.trend > 0 ? '+' : '') + p.trend }),
        el('span.stat__unit', { text: 'marks' }))
    ));

    if (p.cramShare) {
      card.appendChild(el('p.hint', { text: p.cramShare + ' of the papers behind this number were sat in cram mode. They still count — just know the prediction leans on a rushed sitting.' }));
    }

    grid.appendChild(card);
  }

  section.appendChild(grid);

  /* GPA simulator */
  const sim = el('section.card.card--pad-lg.stack',
    el('div.card__head', el('div',
      eyebrow('GPA simulator'),
      el('h3.card__title', { text: gps.length ? (gps.reduce((a, b) => a + b, 0) / gps.length).toFixed(2) + ' GPA' : 'GPA not computable yet' }),
      el('p.card__sub', { text: 'Mean grade point across measured subjects, using theory + an assumed ' + ASSUMED_PRACTICAL + '/25 practical.' })
    )));

  if (ungraded) {
    sim.appendChild(el('p.hint', { text: ungraded + ' ' + fmt.plural(ungraded, 'subject') + ' ' + (ungraded === 1 ? 'has' : 'have') + ' no held-out paper yet, so ' + (ungraded === 1 ? 'it is' : 'they are') + ' left out rather than guessed at.' }));
  }
  sim.appendChild(el('p.hint', { text: 'NEB does not print "fail" — it prints NG, worth 0.0. More than two NG subjects means repeating the year, and Grade 11 marks stay on the transcript permanently. That is the arithmetic, not a warning.' }));
  section.appendChild(sim);

  /* exam countdown */
  const next = daysToNextExam(null);
  if (next) {
    section.appendChild(el('section.card.card--quiet.stack',
      el('div.row.row--between',
        el('div',
          eyebrow('Next milestone'),
          el('p.text-body-lg', { text: next.event.label + ' — ' + fmt.dateLong(next.event.ad) })
        ),
        el('span.pill', { class: next.days <= 21 ? 'pill--warn' : 'pill--info', text: next.days + ' days' })
      ),
      el('p.hint', {
        text: next.event.confidence === 'estimate'
          ? 'This date is an estimate until Hermes confirms the real VAC timetable. Plans built on it will shift when the real date lands.'
          : 'Confirmed date.',
      })
    ));
  }

  return section;
}

/* --- 2. cognitive mix ---------------------------------------------------- */

function cognitiveSection() {
  const section = el('div.section');
  const mix = cognitiveMix();

  section.appendChild(el('div.section-head', el('div',
    el('h2.section-head__title', { text: 'Your mix vs the exam’s mix' }),
    el('p.section-head__sub', { text: 'The CDC specification grid is roughly 15% knowledge, 25% understanding, 35% application, 25% higher ability. Only about 11 of 75 marks are pure recall — practising recall alone is the documented national failure mode.' })
  )));

  const card = el('section.card.card--pad-lg.stack');

  if (!mix.total) {
    card.appendChild(el('p.hint', { text: 'Nothing tagged yet. This meter counts numericals and past-paper questions, which carry a real cognitive tag. Flashcards are left out because the vault does not tag them yet — a made-up bar would be worse than an empty one.' }));
    section.appendChild(card);
    return section;
  }

  for (const level of mix.order) {
    const yours = mix.pct[level];
    const target = mix.target[level];
    const delta = yours - target;
    card.appendChild(el('div',
      el('div.row.row--between',
        el('span.text-body-lg', { text: COGNITIVE_LABEL[level] }),
        el('span.text-meta.tabular', {
          text: Math.round(yours) + '% vs ' + target + '%' + (Math.abs(delta) < 5 ? '' : (delta > 0 ? '  (+' + Math.round(delta) + ')' : '  (' + Math.round(delta) + ')')),
        })
      ),
      el('div.meter.meter--lg', {
        dataset: { tone: Math.abs(delta) < 8 ? 'good' : delta < 0 ? 'bad' : 'warn' },
        style: { position: 'relative' },
      },
        el('span.meter__fill', { style: { '--pct': String(Math.round(clamp(yours, 0, 100))) } }),
        el('span', {
          attrs: { 'aria-hidden': 'true' },
          style: {
            position: 'absolute', top: '0', bottom: '0',
            left: 'calc(' + target + '% - 1px)', width: '2px',
            background: 'var(--fg-muted)', opacity: '0.8', borderRadius: '2px',
          },
        })
      )
    ));
  }

  const worst = mix.gaps.slice().sort((a, b) => a.delta - b.delta)[0];
  card.appendChild(el('p.hint', {
    text: worst && worst.delta < -8
      ? 'You are ' + Math.abs(Math.round(worst.delta)) + ' points light on ' + COGNITIVE_LABEL[worst.level].toLowerCase()
        + '. That is where the exam puts its marks, so it is where the next set should come from.'
      : 'Your mix is close to the paper’s. Keep it there — the grid is the target, not a maximum on any one row.',
  }));
  card.appendChild(el('p.text-meta', { text: mix.total + ' tagged ' + fmt.plural(mix.total, 'item') + ' counted. The grey line on each bar is the exam’s share.' }));

  section.appendChild(card);
  return section;
}

/* --- 3. coverage dials --------------------------------------------------- */

function coverageSection() {
  const section = el('div.section');
  section.appendChild(el('div.section-head', el('div',
    el('h2.section-head__title', { text: 'Syllabus coverage' }),
    el('p.section-head__sub', { text: 'Chapters you have actually retrieved from, not chapters you have opened. The second number is items currently held at 90% recall or better — that one only goes up.' })
  )));

  if (isVaultMissing()) {
    section.appendChild(emptyState({
      icon: 'wifi-off',
      title: 'No vault loaded',
      body: 'Coverage needs the topic list from vault-data.js. Everything else on this screen still works.',
    }));
    return section;
  }

  const rows = coverageBySubject();
  if (!rows.length) {
    section.appendChild(emptyState({ icon: 'layers', title: 'No topics yet', body: 'Run the sync and coverage appears here.' }));
    return section;
  }

  const grid = el('div.card-grid');
  for (const r of rows) {
    grid.appendChild(el('article.card.card--tone.card--pad-lg', { dataset: { subject: subjectKey(r.subject) } },
      el('div.row', { style: { '--gap': 'var(--sp-4)' } },
        el('div.dial', {
          style: { '--pct': String(r.pct) },
          attrs: { role: 'img', 'aria-label': r.pct + '% of ' + r.subject + ' chapters touched' },
        },
          svg('svg', { class: 'dial__svg', viewBox: '0 0 76 76', 'aria-hidden': 'true' },
            svg('circle', { class: 'dial__track', cx: 38, cy: 38, r: 34.5 }),
            svg('circle', { class: 'dial__fill', cx: 38, cy: 38, r: 34.5 })
          ),
          el('span.dial__center',
            el('span.dial__num', { text: String(r.pct) }),
            el('span.dial__pct', { text: '%' })
          )
        ),
        el('div',
          el('h3.card__title', { text: r.subject }),
          el('p.card__sub', { text: r.touched + ' of ' + r.topics + ' ' + fmt.plural(r.topics, 'chapter') + ' touched' }),
          el('p.text-meta', { text: r.held + ' of ' + r.cards + ' items held at ≥90% recall' })
        )
      )
    ));
  }
  section.appendChild(grid);
  return section;
}

/* --- 4. effort vs marks -------------------------------------------------- */

function effortSection() {
  const section = el('div.section');
  const series = weeklySeries(10);
  const anyEffort = series.some((s) => s.minutes > 0);
  const anyMock = series.some((s) => s.mockPct !== null);

  section.appendChild(el('div.section-head', el('div',
    el('h2.section-head__title', { text: 'Effort vs marks' }),
    el('p.section-head__sub', { text: 'Bars are minutes studied that week. The green line is your held-out mock percentage. This is the chart to look at when the work feels worse than rereading did — that feeling is the technique working, and this is the evidence.' })
  )));

  const card = el('section.card.card--pad-lg.stack');

  if (!anyEffort && !anyMock) {
    card.appendChild(el('p.hint', { text: 'Ten weeks of history will build up here. Nothing to plot yet.' }));
    section.appendChild(card);
    return section;
  }

  card.appendChild(effortChart(series));

  const totalMin = series.reduce((a, s) => a + s.minutes, 0);
  const activeWeeks = series.filter((s) => s.minutes > 0).length;
  const mocks = series.filter((s) => s.mockPct !== null);
  const first = mocks[0], last = mocks[mocks.length - 1];

  card.appendChild(el('div.stat-row',
    el('div.stat',
      el('div.stat__eyebrow', el('span', { text: 'Last 10 weeks' })),
      el('div.stat__value', { text: String(Math.round(totalMin / 60)) }), el('span.stat__unit', { text: 'hours' })),
    el('div.stat',
      el('div.stat__eyebrow', el('span', { text: 'Weeks with study' })),
      el('div.stat__value', { text: activeWeeks + ' / ' + series.length })),
    el('div.stat',
      el('div.stat__eyebrow', el('span', { text: 'Mock movement' })),
      el('div.stat__value', {
        text: first && last && first !== last
          ? (last.mockPct - first.mockPct >= 0 ? '+' : '') + Math.round(last.mockPct - first.mockPct) + '%'
          : '—',
      }),
      el('p.stat__sub', { text: mocks.length + ' held-out ' + fmt.plural(mocks.length, 'mock') }))
  ));

  if (!anyMock) {
    card.appendChild(el('p.hint', { text: 'No held-out mock in this window, so the line has nothing to draw. Effort without a measurement is just effort.' }));
  }

  section.appendChild(card);
  return section;
}

/* --- 5. numericals scaffold ladder --------------------------------------- */

function scaffoldSection() {
  const section = el('div.section');
  const rows = scaffoldSummary();
  const tally = attemptTally();

  section.appendChild(el('div.section-head', el('div',
    el('h2.section-head__title', { text: 'Numericals — where the scaffolding is' }),
    el('p.section-head__sub', { text: 'Two clean runs drop the support one level; one bad run puts it back. Level 4 is cold, exam conditions, no worked example available.' })
  )));

  const card = el('section.card.card--pad-lg.stack');

  if (!rows.length) {
    card.appendChild(el('p.hint', { text: 'No numericals attempted yet. Physics carries a numerical component in about half its questions, and every chemistry stoichiometry mark is one.' }));
    card.appendChild(el('div.btn-row', el('button.btn.btn-primary', { type: 'button', onClick: () => navigate('study') },
      icon('calculator', { size: 16 }), el('span', { text: 'Start a set' }))));
    section.appendChild(card);
    return section;
  }

  card.appendChild(el('div.stat-row',
    el('div.stat',
      el('div.stat__eyebrow', el('span', { text: 'Problem types' })),
      el('div.stat__value', { text: String(rows.length) })),
    el('div.stat',
      el('div.stat__eyebrow', el('span', { text: 'At cold (level 4)' })),
      el('div.stat__value', { text: String(rows.filter((r) => r.level === 4).length) })),
    el('div.stat',
      el('div.stat__eyebrow', el('span', { text: 'Attempts today' })),
      el('div.stat__value', { text: String(tally.today) }),
      el('p.stat__sub', { text: tally.clean + ' clean of ' + tally.total + ' all time' }))
  ));

  const table = el('table.table',
    el('thead', el('tr',
      el('th', { text: 'Problem type' }), el('th', { text: 'Unit' }),
      el('th', { text: 'Fade level' }), el('th.table__num', { text: 'Clean' }),
      el('th', { text: 'Last' })
    )),
    el('tbody', rows.map((r) => el('tr',
      el('td', { text: r.label }),
      el('td.text-meta', { text: r.unit || '—' }),
      el('td',
        el('div.row',
          el('div.rail', { style: { width: '68px' } },
            [0, 1, 2, 3].map((i) => el('span.rail__cell', { class: i < r.level ? 'is-done' : '' }))),
          el('span.text-meta', { text: SCAFFOLD_LEVELS[r.level].name })
        )
      ),
      el('td.table__num.mono', { text: r.correct + '/' + r.attempts }),
      el('td.text-meta.mono', { text: r.updatedISO || '—' })
    )))
  );
  card.appendChild(el('div.scroll-x', table));
  section.appendChild(card);
  return section;
}

/* --- 6. review log ------------------------------------------------------- */

const KIND_FILTERS = ['all', 'review', 'encode', 'transfer', 'audit', 'pretest'];

function reviewLogSection() {
  const section = el('div.section');
  section.appendChild(el('div.section-head',
    el('div',
      el('h2.section-head__title', { text: 'Review log' }),
      el('p.section-head__sub', { text: 'Append-only. Every rating you have ever given, exactly as it will be replayed into the scheduler of record. Nothing in this app can delete a line of it.' })
    ),
    el('button.btn.btn-ghost.btn--sm', {
      type: 'button',
      onClick: () => { try { store.downloadReviewLog(); } catch (_) { /* older store */ } },
    }, icon('download', { size: 14 }), el('span', { text: 'Export JSONL' }))
  ));

  const card = el('section.card.card--pad-lg.stack');
  const totalCount = store.reviewLogCount();

  if (!totalCount) {
    card.appendChild(el('p.hint', { text: 'Empty. The first rating you give writes the first line.' }));
    section.appendChild(card);
    return section;
  }

  let kind = 'all';
  const chips = el('div.chip-row.chip-row--scroll');
  const host = el('div');

  KIND_FILTERS.forEach((k) => {
    chips.appendChild(el('button.chip.chip--button.chip--micro', {
      type: 'button', text: k,
      attrs: { 'aria-pressed': String(k === kind) },
      onClick: () => {
        kind = k;
        Array.from(chips.children).forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === k)));
        paint();
      },
    }));
  });

  function paint() {
    const rows = store.getReviewLog(kind === 'all' ? {} : { kind }).slice(-80).reverse();
    host.replaceChildren(
      el('p.text-meta', { text: rows.length + ' of ' + totalCount + ' entries shown, newest first.' }),
      el('div.scroll-x', el('table.table',
        el('thead', el('tr',
          el('th', { text: 'Day' }), el('th', { text: 'Item' }), el('th', { text: 'Kind' }),
          el('th', { text: 'Rating' }), el('th', { text: 'Grade' }),
          el('th.table__num', { text: 'Conf' }), el('th.table__num', { text: 'Time' })
        )),
        el('tbody', rows.map((e) => el('tr',
          el('td.mono', { text: e.day }),
          el('td.table__id', { text: fmt.truncate(e.cardId, 28) }),
          el('td.text-meta', { text: e.kind }),
          el('td', el('span.pill', {
            class: e.rating >= 3 ? 'pill--good' : e.rating === 2 ? 'pill--warn' : 'pill--bad',
            text: RATING_NAMES[e.rating] || String(e.rating),
          })),
          el('td.text-meta', { text: e.grade || '—' }),
          el('td.table__num.mono', { text: e.confidence === null ? '—' : String(e.confidence) }),
          el('td.table__num.mono', { text: e.elapsedMs ? fmt.dur(e.elapsedMs) : '—' })
        )))
      ))
    );
  }

  card.appendChild(chips);
  card.appendChild(host);
  paint();
  section.appendChild(card);
  return section;
}
