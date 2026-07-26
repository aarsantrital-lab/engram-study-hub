/* =============================================================================
   js/views/home.js — the anti-"I don't know where to start" screen.
   Job: HOME + GROW GRID.  Owns this file and js/grow.js.

   pedagogy-spec §2, Tier 0. Top to bottom:

     1. hero nebula   greeting · streak flame · exam countdown chips
     2. THE button    "What should I study now?" -> grow.pickNext() -> its route
     3. three rings   game.getRings(), 76px dials, tap for detail
     4. today's load  "today: about N minutes"  (NEVER a due count — §1.6)
     5. GROW grid     every CDC unit, R/Y/G self-rating cross-checked against
                      measured accuracy; mismatch = illusion-of-competence flag
     6. quote card    ambient, rotates daily, dismissible
     7. nightly strip the 10:25 PM loop, while it is still outstanding

   game.js belongs to the game-layer agent and may not exist yet, so it is
   loaded with a dynamic import and falls back to the store keys it owns
   (KEYS.RINGS / KEYS.STREAK). The screen never breaks on its absence.
   ========================================================================== */

import { getSettings, SUBJECT_ICONS } from '../config.js';
import { store, KEYS, todayLocalISO } from '../store.js';
import {
  el, icon, fmt, on, toast, haptic, prefersReducedMotion,
} from '../dom.js';
import { routeFor, navigateTo } from '../router.js';
import { isVaultMissing, counts as vaultCounts } from '../vault.js';
import {
  GROW_SUBJECTS, RATING_META, GROW_RATINGS, MEASURED_MIN_REVIEWS,
  buildRows, growSummary, pickNext, actionFor, todayLoad, setSelfRating,
  upcomingExams, nightlyLoopState, registerUnitSearch, invalidate,
} from '../grow.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* =============================================================================
   0. Scoped styles
   -----------------------------------------------------------------------------
   index.html, theme.css, components.css and shell.css are all frozen, so a
   view that needs its own layout has exactly one place to put it: a <style>
   node it owns, scoped to itself. Tokens only — no raw colours, no new
   component vocabulary, nothing that can leak into another view.
   ========================================================================== */

const STYLE_ID = 'engram-home-style';

const HOME_CSS = `
.engram-home > * + * { margin-top: var(--section-gap); }
.engram-home .home-block > * + * { margin-top: var(--sp-3); }

/* --- hero ---------------------------------------------------------------- */
.engram-home .home-hero__top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
.engram-home .home-hero__sub { margin: var(--sp-2) 0 0; max-width: 48ch; font-size: var(--fs-body); line-height: var(--lh-body); color: var(--hero-ink-soft); }
.engram-home .home-hero__chips { margin-top: var(--sp-5); }
.engram-home .home-streak { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 34px; padding: 4px var(--sp-3); border-radius: var(--r-full); border: 1px solid var(--hero-border); background: rgb(var(--surface-rgb) / 0.45); font-size: var(--fs-meta); color: var(--fg); white-space: nowrap; }
.engram-home .home-streak__n { font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums; }
.engram-home .home-streak .icon { color: var(--brand); }
.engram-home .home-streak[data-state="cold"] .icon { color: var(--fg-subtle); }

/* --- the button ---------------------------------------------------------- */
.engram-home .home-cta__next { margin: var(--sp-3) 0 0; font-size: var(--fs-body-lg); font-weight: var(--fw-medium); color: var(--fg); }
.engram-home .home-cta__next .home-cta__unit { color: var(--accent); }
.engram-home .home-cta__detail { margin: var(--sp-1) 0 0; font-size: var(--fs-caption); line-height: var(--lh-snug); color: var(--fg-muted); }
.engram-home .home-cta__why { margin: var(--sp-2) 0 0; font-size: var(--fs-meta); line-height: var(--lh-snug); color: var(--fg-subtle); }
.engram-home .home-chip__est { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: var(--tr-micro); color: var(--fg-subtle); }
.engram-home .home-cta__alts { margin-top: var(--sp-3); }
.engram-home .home-alt-label { font-size: var(--fs-meta); color: var(--fg-subtle); align-self: center; }

/* --- rings --------------------------------------------------------------- */
.engram-home .home-rings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
.engram-home .home-ring { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-1); min-height: var(--tap); border: 1px solid transparent; border-radius: var(--r-lg); background: transparent; color: var(--fg); cursor: pointer; font: inherit; }
.engram-home .home-ring:hover { background: var(--surface-hover); }
.engram-home .home-ring[aria-expanded="true"] { border-color: rgb(var(--accent-rgb) / 0.4); background: rgb(var(--accent-rgb) / 0.06); }
.engram-home .home-ring__label { font-size: var(--fs-eyebrow); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: var(--tr-eyebrow); color: var(--fg-muted); }
.engram-home .home-ring__detail { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border); font-size: var(--fs-meta); line-height: var(--lh-body); color: var(--fg-muted); }
.engram-home .home-ring__detail strong { color: var(--fg); font-weight: var(--fw-medium); }

/* --- today's load -------------------------------------------------------- */
.engram-home .home-load__value { font-size: var(--fs-metric); font-weight: var(--fw-semibold); line-height: 1; letter-spacing: var(--tr-metric); font-variant-numeric: tabular-nums; color: var(--accent); text-shadow: 0 0 40px rgb(var(--accent-rgb) / 0.33); }
.engram-home .home-load__unit { margin-left: var(--sp-2); font-size: var(--fs-body-lg); color: var(--fg-muted); font-weight: var(--fw-body); }
.engram-home .home-load__split { margin: var(--sp-3) 0 0; font-size: var(--fs-meta); color: var(--fg-muted); }

/* --- GROW grid ----------------------------------------------------------- */
.engram-home .home-grow__controls { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
.engram-home .home-grow__subject { margin-top: var(--sp-5); }
.engram-home .home-grow__subject:first-of-type { margin-top: var(--sp-2); }
.engram-home .home-grow__shead { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding-bottom: var(--sp-2); }
.engram-home .home-grow__stitle { font-size: var(--fs-title); font-weight: var(--fw-semibold); letter-spacing: var(--tr-metric); }
.engram-home .home-grow__scount { font-size: var(--fs-meta); color: var(--fg-muted); }

.engram-home .home-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "main main" "measure rate";
  gap: var(--sp-2) var(--sp-3);
  align-items: center;
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--border);
}
.engram-home .home-row:first-child { border-top: 0; padding-top: 0; }
.engram-home .home-row__main { grid-area: main; min-width: 0; }
.engram-home .home-row__measure { grid-area: measure; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.engram-home .home-row__rate { grid-area: rate; }
@media (min-width: 620px) {
  .engram-home .home-row {
    grid-template-columns: minmax(0, 1fr) minmax(160px, 240px) auto;
    grid-template-areas: "main measure rate";
  }
}
.engram-home .home-row__open { position: relative; display: block; width: 100%; min-height: 38px; padding: 2px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--r-md); }
.engram-home .home-row__open::after { content: ""; position: absolute; inset: -3px; }
.engram-home .home-row__open:hover .home-row__name { color: var(--accent); }
.engram-home .home-row__name { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-body-lg); font-weight: var(--fw-medium); line-height: var(--lh-snug); }
.engram-home .home-row__name .icon { color: var(--accent); flex: 0 0 auto; }
.engram-home .home-row__meta { margin-top: 2px; font-size: var(--fs-meta); color: var(--fg-muted); }
.engram-home .home-row__flag { margin-top: var(--sp-2); }
/* The illusion message is a sentence, not a tag — let it wrap rather than be
   clipped on a phone. */
.engram-home .home-row__flag .pill { white-space: normal; align-items: flex-start; text-align: left; line-height: var(--lh-snug); }
.engram-home .home-row__flag .pill .icon { margin-top: 2px; }
.engram-home .home-row__meterwrap { flex: 1 1 120px; min-width: 90px; }
.engram-home .home-row__mlabel { margin-top: 3px; font-size: var(--fs-micro); letter-spacing: var(--tr-micro); text-transform: uppercase; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.engram-home .home-rate .segmented__btn { min-height: 38px; min-width: 44px; font-variant-numeric: tabular-nums; }
.engram-home .home-rate .segmented__btn::after { content: ""; position: absolute; inset: -3px; }
/* The R/Y/G row is the single most-tapped control in the app — 129 of them on a
   full GROW grid, every night. 38px + a 3px expander that the neighbour eats is
   under the 44px floor, so on touch the box carries the height itself. */
@media (pointer: coarse) {
  .engram-home .home-rate .segmented__btn { min-height: var(--tap); }
}
.engram-home .home-rate .segmented__btn[data-r="R"][aria-pressed="true"] { background: var(--bad-bg); color: var(--bad); box-shadow: inset 0 0 0 1px var(--bad-bd); }
.engram-home .home-rate .segmented__btn[data-r="Y"][aria-pressed="true"] { background: var(--warn-bg); color: var(--warn); box-shadow: inset 0 0 0 1px var(--warn-bd); }
.engram-home .home-rate .segmented__btn[data-r="G"][aria-pressed="true"] { background: var(--good-bg); color: var(--good); box-shadow: inset 0 0 0 1px var(--good-bd); }

/* --- quote --------------------------------------------------------------- */
.engram-home .home-quote { display: grid; grid-template-columns: minmax(0, 1fr) var(--tap); gap: var(--sp-2); align-items: start; }
.engram-home .home-quote__text { margin: var(--sp-2) 0 0; font-size: var(--fs-body); line-height: var(--lh-body); color: var(--fg-muted); }
.engram-home .home-quote__src { margin: var(--sp-2) 0 0; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: var(--tr-micro); color: var(--fg-subtle); }

/* --- nightly strip ------------------------------------------------------- */
.engram-home .home-night { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
.engram-home .home-night__body { flex: 1 1 220px; min-width: 0; }
.engram-home .home-night__title { font-size: var(--fs-body-lg); font-weight: var(--fw-medium); display: flex; align-items: center; gap: var(--sp-2); }
.engram-home .home-night__title .icon { color: var(--accent); }
.engram-home .home-night__sub { margin: 2px 0 0; font-size: var(--fs-meta); color: var(--fg-muted); line-height: var(--lh-snug); }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = HOME_CSS;      // static, authored here — never user input
  document.head.appendChild(node);
}

/* =============================================================================
   1. game.js bridge (optional dependency)
   ========================================================================== */

let gamePromise = null;

function gameModule() {
  if (!gamePromise) {
    gamePromise = import('../game.js').then((m) => m || null).catch(() => null);
  }
  return gamePromise;
}

const RING_KINDS = ['review', 'encode', 'drill'];

const RING_META = {
  review: {
    label: 'Review', icon: 'layers',
    detail: 'Retrieval from the spaced queue. The engine schedules it; you only have to show up.',
  },
  encode: {
    label: 'Encode', icon: 'waypoints',
    detail: 'New material actually encoded — a map built, a tree filled, a worked example understood. Cards come after this, never before.',
  },
  drill: {
    label: 'Drill', icon: 'calculator',
    detail: 'Exam-shaped practice: numericals with every step written, 5-mark answers, diagrams marked line by line.',
  },
};

function normRing(v, goalFallback) {
  const done = Math.max(0, Math.round(Number(v && v.done) || 0));
  const goal = Math.max(1, Math.round(Number(v && v.goal) || goalFallback));
  return { done, goal, pct: Math.min(100, Math.round((done / goal) * 100)) };
}

function fallbackRings() {
  const map = store.get(KEYS.RINGS, {}) || {};
  const today = map[todayLocalISO()] || {};
  const budget = Math.max(1, Number(getSettings().dailyMinutes) || 25);
  return {
    review: normRing(today.review, budget),
    encode: normRing(today.encode, 1),
    drill: normRing(today.drill, 5),
  };
}

async function readRings() {
  const g = await gameModule();
  if (g && typeof g.getRings === 'function') {
    try {
      const r = g.getRings() || {};
      const fb = fallbackRings();
      return {
        review: r.review ? normRing(r.review, fb.review.goal) : fb.review,
        encode: r.encode ? normRing(r.encode, fb.encode.goal) : fb.encode,
        drill: r.drill ? normRing(r.drill, fb.drill.goal) : fb.drill,
      };
    } catch (err) { console.warn('[home] game.getRings() failed', err); }
  }
  return fallbackRings();
}

async function readStreak() {
  const g = await gameModule();
  if (g && typeof g.getStreak === 'function') {
    try {
      const s = g.getStreak() || {};
      return {
        current: Math.max(0, Number(s.current) || 0),
        lifetime: Math.max(0, Number(s.lifetime) || 0),
        freezesLeft: Math.max(0, Number(s.freezesLeft) || 0),
        lastDay: s.lastDay || null,
      };
    } catch (err) { console.warn('[home] game.getStreak() failed', err); }
  }
  const s = store.get(KEYS.STREAK, {}) || {};
  return {
    current: Math.max(0, Number(s.count) || 0),
    lifetime: Math.max(0, Number(s.lifetimeDays) || Number(s.longest) || 0),
    freezesLeft: Math.max(0, Number(s.freezes) || 0),
    lastDay: s.lastDay || null,
  };
}

/* =============================================================================
   2. Small builders
   ========================================================================== */

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

/** The signature 76px ring dial (theme.css: r = 34.5, C = 216.77). */
function dial(pct, centreText, unitText, label) {
  return el('div.dial', {
    style: { '--pct': String(Math.max(0, Math.min(100, pct))) },
    attrs: { role: 'img', 'aria-label': label },
  },
  (() => {
    const svg = svgEl('svg', { class: 'dial__svg', viewBox: '0 0 76 76', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('circle', { class: 'dial__track', cx: 38, cy: 38, r: 34.5 }));
    svg.appendChild(svgEl('circle', { class: 'dial__fill', cx: 38, cy: 38, r: 34.5 }));
    return svg;
  })(),
  el('span.dial__center',
    el('span.dial__num', { text: centreText }),
    el('span.dial__pct', { text: unitText })));
}

function subjectAttr(subject) {
  return String(subject || '').toLowerCase().replace(/\s+/g, '-');
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Late night';
}

function displayName() {
  const p = store.get(KEYS.PROFILE, {}) || {};
  const n = String(p.displayName || '').trim();
  return n ? n.split(/\s+/)[0].slice(0, 24) : '';
}

/* =============================================================================
   3. Sections
   ========================================================================== */

/* --- 3.1 hero ------------------------------------------------------------- */

function heroSection(view) {
  const name = displayName();
  const title = greeting() + (name ? ', ' + name : '');
  const summary = growSummary();

  const streakHost = el('div');
  const chipHost = el('div.chip-row.chip-row--scroll.home-hero__chips');

  const rated = summary.total - summary.unrated;
  const sub = rated === 0
    ? 'Rate the units below red, amber or green. That single pass is what makes this screen able to answer "what now?".'
    : rated + ' of ' + summary.total + ' units rated'
      + (summary.illusions
        ? ' · ' + summary.illusions + ' ' + fmt.plural(summary.illusions, 'unit') + ' rated higher than measured'
        : '')
      + ' · target 67 of 75 theory marks per subject.';

  const node = el('section.hero.card--2xl',
    el('div.hero__bg'),
    el('div.hero__grid'),
    prefersReducedMotion() ? null : el('div.dream-stars'),
    el('div.hero__orb.hero__orb--tl'),
    el('div.hero__orb.hero__orb--br'),
    el('div.hero__inner',
      el('div.home-hero__top',
        el('div',
          el('div.hero__eyebrow', { text: fmt.dayName(new Date()) + ' · ' + fmt.dateLong(new Date()) }),
          el('h1.hero__title', { text: title })),
        streakHost),
      el('p.home-hero__sub', { text: sub }),
      chipHost));

  // streak flame — asynchronous because game.js may or may not be there
  readStreak().then((s) => {
    const state = s.current === 0 ? 'cold' : (s.lastDay === todayLocalISO() ? 'lit' : 'due');
    const label = s.current === 0
      ? 'No streak yet'
      : s.current + ' ' + fmt.plural(s.current, 'night');
    const tail = s.current === 0
      ? '90 seconds tonight starts one'
      : s.lifetime + ' lifetime';
    streakHost.replaceChildren(el('div.home-streak', {
      dataset: { state },
      attrs: {
        title: s.freezesLeft
          ? tail + ' · ' + s.freezesLeft + ' ' + fmt.plural(s.freezesLeft, 'freeze') + ' left this month'
          : tail,
      },
    },
    icon('flame', { size: 16 }),
    el('span.home-streak__n', { text: label }),
    el('span', { style: { color: 'var(--fg-subtle)' }, text: '·' }),
    el('span', { style: { color: 'var(--fg-muted)' }, text: tail })));
  });

  // exam countdown chips
  const exams = upcomingExams(3);
  if (!exams.length) {
    chipHost.appendChild(el('span.chip', icon('calendar', { size: 14 }),
      el('span', { text: 'No exam dates set' })));
  } else {
    for (const m of exams) {
      const days = Math.max(0, m.days);
      chipHost.appendChild(el('span.chip', {
        attrs: {
          title: m.label + ' — ' + fmt.dateLong(m.ad) + (m.bs ? ' (' + m.bs + ')' : '')
            + (m.confidence === 'low' ? ' · extrapolated date, confirm with college' : ''),
        },
        dataset: { confidence: m.confidence },
      },
      icon('calendar', { size: 14 }),
      el('span', { text: m.label }),
      el('span.mono.tabular', { style: { color: 'var(--fg-subtle)' }, text: days === 0 ? 'today' : days + 'd' }),
      m.confidence === 'low'
        ? el('span.home-chip__est', { text: 'est.', attrs: { 'aria-label': 'estimated date, not confirmed' } })
        : null));
    }
  }

  view.refreshHero = () => { /* hero copy is cheap but static per mount */ };
  return node;
}

/* --- 3.2 THE button ------------------------------------------------------- */

function decisionSection(view) {
  const host = el('section.card.card--tone.card--pad-lg.card--2xl');
  const render = () => {
    const d = pickNext();
    host.dataset.subject = d.unit ? subjectAttr(d.unit.subject) : '';
    const cta = el('button.btn.btn-primary.btn--lg.btn--block', {
      type: 'button',
      attrs: { 'data-testid': 'home-cta' },
      onClick: () => {
        haptic('select');
        toast(d.reason, { tone: 'info', timeout: 6000 });
        navigateTo(d.action.route);
      },
    }, icon('sparkles', { size: 20 }), el('span', { text: 'What should I study now?' }));

    const next = d.unit
      ? el('p.home-cta__next',
        el('span', { text: d.action.label + ' — ' }),
        el('span.home-cta__unit', { text: d.unit.name }),
        el('span', { text: ' · ' + d.unit.subject }))
      : el('p.home-cta__next', { text: 'Nothing is loaded yet.' });

    const detail = d.unit && d.action.detail
      ? el('p.home-cta__detail', { text: d.action.detail })
      : null;

    const why = el('p.home-cta__why', { text: d.reason });

    const alts = el('div.chip-row.home-cta__alts');
    if (d.alternatives && d.alternatives.length) {
      alts.appendChild(el('span.home-alt-label', { text: 'or start with' }));
      for (const a of d.alternatives) {
        alts.appendChild(el('button.chip.chip--button', {
          type: 'button',
          dataset: { subject: subjectAttr(a.unit.subject) },
          attrs: { title: a.reason },
          onClick: () => { haptic('tap'); navigateTo(a.action.route); },
        }, icon(SUBJECT_ICONS[a.unit.subject] || 'layers', { size: 14 }),
        el('span', { text: a.unit.name })));
      }
    }

    // Spread the optional children — replaceChildren() is native DOM and
    // stringifies a null argument into a literal "null" on screen. Both
    // `detail` (no action detail) and `alts` (no alternate units) are null on
    // ordinary days, so this printed "null" inside the Start-here card.
    host.replaceChildren(
      el('div.eyebrow.eyebrow--dot', el('span', { text: 'Start here' })),
      el('div', { style: { marginTop: 'var(--sp-3)' } }, cta),
      next,
      ...(detail ? [detail] : []),
      why,
      ...(alts.childElementCount ? [alts] : [])
    );
  };

  render();
  view.refreshDecision = render;
  return host;
}

/* --- 3.3 rings ------------------------------------------------------------ */

function ringsSection(view) {
  const grid = el('div.home-rings');
  const detail = el('div.home-ring__detail', { attrs: { hidden: '' } });
  const host = el('section.card',
    el('div.card__head', el('h2.card__title', { text: "Today's three rings" })),
    grid, detail);

  let open = null;

  const paint = (rings) => {
    grid.replaceChildren();
    for (const kind of RING_KINDS) {
      const meta = RING_META[kind];
      const r = rings[kind];
      const btn = el('button.home-ring', {
        type: 'button',
        dataset: { ring: kind },
        attrs: {
          'aria-expanded': String(open === kind),
          'aria-label': meta.label + ' ring, ' + r.done + ' of ' + r.goal + ' done',
        },
        onClick: () => {
          haptic('tap');
          open = open === kind ? null : kind;
          paint(rings);
        },
      },
      dial(r.pct, fmt.int(r.done), '/ ' + fmt.int(r.goal),
        meta.label + ': ' + r.done + ' of ' + r.goal),
      el('span.home-ring__label', { text: meta.label }));
      grid.appendChild(btn);
    }

    if (open) {
      const r = rings[open];
      detail.hidden = false;
      detail.replaceChildren(
        el('strong', { text: RING_META[open].label + ' — ' + r.done + ' of ' + r.goal + ' done. ' }),
        el('span', { text: RING_META[open].detail })
      );
    } else {
      detail.hidden = true;
      detail.replaceChildren();
    }
  };

  paint({ review: normRing(null, 25), encode: normRing(null, 1), drill: normRing(null, 5) });

  const refresh = () => { readRings().then((r) => { view.rings = r; paint(r); }); };
  refresh();
  view.refreshRings = refresh;
  return host;
}

/* --- 3.4 today's load ----------------------------------------------------- */

function loadSection(view) {
  const host = el('section.card.card--tone', { dataset: { tone: 'brand' } });

  const render = () => {
    const load = todayLoad();
    const body = [];

    if (!load.hasWork) {
      body.push(
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Today' })),
        el('p', {
          style: { margin: 'var(--sp-3) 0 0', color: 'var(--fg-muted)', fontSize: 'var(--fs-body)' },
          text: isVaultMissing()
            ? 'No material is loaded yet, so there is nothing scheduled. The GROW grid below still works — rate the units and the system can start pointing you somewhere.'
            : 'Nothing is scheduled right now. That is the spacing doing its job, not a gap — new work appears as intervals come due.',
        })
      );
    } else {
      const mins = Math.max(1, load.estMinutes);
      const pct = Math.min(100, Math.round((mins / Math.max(1, load.budgetMin)) * 100));
      const split = [];
      if (load.reviewMinutes >= 1) split.push('about ' + load.reviewMinutes + ' min of review');
      if (load.newMinutes >= 1) split.push('about ' + load.newMinutes + ' min of new material');
      body.push(
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Today' })),
        el('div', { style: { marginTop: 'var(--sp-3)', display: 'flex', alignItems: 'baseline' } },
          el('span.home-load__value', { text: String(mins) }),
          el('span.home-load__unit', { text: fmt.plural(mins, 'minute') })),
        el('div.meter.meter--ticks', { style: { marginTop: 'var(--sp-4)' } },
          el('span.meter__fill', { style: { '--pct': String(pct) } })),
        el('p.home-load__split', {
          text: (split.length ? split.join(' · ') + ' · ' : '')
            + 'inside your ' + load.budgetMin + '-minute budget',
        }),
        el('div.btn-row', { style: { marginTop: 'var(--sp-4)' } },
          el('button.btn.btn-secondary', {
            type: 'button',
            onClick: () => { haptic('select'); navigateTo(routeFor('study', { mode: 'review' })); },
          }, icon('play', { size: 16 }), el('span', { text: 'Start the queue' })),
          el('button.btn.btn-ghost.btn--sm', {
            type: 'button',
            attrs: { title: 'The 90-second floor still counts as a night' },
            onClick: () => { haptic('tap'); navigateTo(routeFor('study', { mode: 'minimum' })); },
          }, el('span', { text: '90-second version' })))
      );
    }

    host.replaceChildren(...body);
  };

  render();
  view.refreshLoad = render;
  return host;
}

/* --- 3.5 the GROW grid ---------------------------------------------------- */

function ratingControl(row, onPick) {
  const group = el('div.segmented.home-rate', {
    attrs: { role: 'group', 'aria-label': 'Self-rating for ' + row.unit.name },
  });
  for (const key of GROW_RATINGS) {
    const meta = RATING_META[key];
    const pressed = row.selfRating === key;
    group.appendChild(el('button.segmented__btn', {
      type: 'button',
      dataset: { r: key },
      attrs: { 'aria-pressed': String(pressed), title: meta.meaning },
      text: meta.short,
      onClick: () => onPick(pressed ? null : key),
    }));
  }
  return group;
}

function measureCell(row) {
  const wrap = el('div.home-row__measure');

  if (row.measured === null || row.reviews < MEASURED_MIN_REVIEWS) {
    wrap.appendChild(el('span.pill.pill--neutral', {
      text: row.reviews
        ? row.reviews + ' ' + fmt.plural(row.reviews, 'review') + ' — too few to call'
        : 'not measured yet',
    }));
    return wrap;
  }

  const pct = Math.round(row.measured * 100);
  const tone = pct >= 85 ? 'good' : (pct >= 70 ? 'warn' : 'bad');
  wrap.appendChild(el('div.home-row__meterwrap', { dataset: { tone } },
    el('div.meter.meter--sm', el('span.meter__fill', { style: { '--pct': String(pct) } })),
    el('div.home-row__mlabel', {
      text: pct + '% recall · ' + row.reviews + ' ' + fmt.plural(row.reviews, 'review'),
    })));
  return wrap;
}

function growRow(row, view) {
  const unit = row.unit;
  const node = el('div.home-row', {
    dataset: { subject: subjectAttr(unit.subject), status: row.status, unit: unit.id },
  });

  const meta = [unit.domain, unit.hours + ' teaching ' + fmt.plural(unit.hours, 'hour')];
  if (row.stalenessDays === null) meta.push('not started');
  else if (row.stalenessDays > 0) meta.push('last touched ' + row.stalenessDays + 'd ago');
  else meta.push('touched today');

  const main = el('div.home-row__main',
    el('button.home-row__open', {
      type: 'button',
      attrs: { title: actionFor(row).label + ' · ' + unit.name },
      onClick: () => { haptic('tap'); navigateTo(actionFor(row).route); },
    },
    el('span.home-row__name',
      icon(SUBJECT_ICONS[unit.subject] || 'layers', { size: 14 }),
      el('span.clamp-2', { text: unit.name })),
    el('span.home-row__meta', { text: meta.join(' · ') })));

  if (row.illusion) {
    main.appendChild(el('div.home-row__flag',
      el('span.pill', {
        class: 'pill--' + (row.illusion.severity === 'good' ? 'good' : row.illusion.severity),
      }, icon(row.illusion.severity === 'good' ? 'circle-check' : 'alert-triangle', { size: 12 }),
      el('span', { text: row.illusion.message }))));
  }

  const rate = el('div.home-row__rate', ratingControl(row, (value) => {
    const ok = setSelfRating(unit.id, value);
    if (!ok) {
      toast('Storage refused that write — your rating is live but not saved yet. Nothing was deleted.', { tone: 'warn' });
    } else {
      haptic('select');
    }
    invalidate();
    view.refreshGrid();
    view.refreshDecision();
  }));

  node.appendChild(main);
  node.appendChild(measureCell(row));
  node.appendChild(rate);
  return node;
}

function gridSection(view) {
  const host = el('section.section');
  const controls = el('div.home-grow__controls');
  const body = el('div');

  const ui = store.get(KEYS.UI, {}) || {};
  let sort = ui.homeGrowSort === 'priority' ? 'priority' : 'syllabus';
  let filter = GROW_SUBJECTS.includes(ui.homeGrowSubject) ? ui.homeGrowSubject : 'all';

  const persist = () => {
    store.update(KEYS.UI, (prev) => Object.assign({}, prev, {
      homeGrowSort: sort, homeGrowSubject: filter,
    }), {});
  };

  const buildControls = () => {
    const filters = el('div.chip-row');
    const mk = (value, label) => el('button.chip.chip--button', {
      type: 'button',
      attrs: { 'aria-pressed': String(filter === value) },
      text: label,
      onClick: () => { filter = value; persist(); paint(); },
    });
    filters.appendChild(mk('all', 'All subjects'));
    for (const s of GROW_SUBJECTS) filters.appendChild(mk(s, s));

    const sorter = el('div.segmented', { attrs: { role: 'group', 'aria-label': 'Sort the grid' } },
      el('button.segmented__btn', {
        type: 'button', text: 'Syllabus order',
        attrs: { 'aria-pressed': String(sort === 'syllabus') },
        onClick: () => { sort = 'syllabus'; persist(); paint(); },
      }),
      el('button.segmented__btn', {
        type: 'button', text: 'Weakest first',
        attrs: { 'aria-pressed': String(sort === 'priority') },
        onClick: () => { sort = 'priority'; persist(); paint(); },
      }));

    controls.replaceChildren(filters, sorter);
  };

  const paint = () => {
    buildControls();
    const subject = filter === 'all' ? undefined : filter;
    const rows = buildRows({ subject, sort });
    body.replaceChildren();

    if (sort === 'priority') {
      const card = el('div.card.card--flush', { style: { padding: 'var(--sp-4) var(--sp-5)' } });
      for (const r of rows) card.appendChild(growRow(r, view));
      body.appendChild(card);
    } else {
      const subjects = subject ? [subject] : GROW_SUBJECTS;
      for (const s of subjects) {
        const subjectRows = rows.filter((r) => r.unit.subject === s);
        if (!subjectRows.length) continue;
        const sum = growSummary(s);
        const section = el('div.home-grow__subject', { dataset: { subject: subjectAttr(s) } },
          el('div.home-grow__shead',
            el('span.icon-tile.icon-tile--sm', icon(SUBJECT_ICONS[s] || 'layers', { size: 14 })),
            el('span.home-grow__stitle', { text: s }),
            el('span.home-grow__scount', {
              text: sum.total + ' units · ' + sum.hours + ' teaching hours'
                + (sum.R ? ' · ' + sum.R + ' red' : '')
                + (sum.unrated ? ' · ' + sum.unrated + ' unrated' : ''),
            })));
        const card = el('div.card.card--flush', { style: { padding: 'var(--sp-4) var(--sp-5)' } });
        for (const r of subjectRows) card.appendChild(growRow(r, view));
        section.appendChild(card);
        body.appendChild(section);
      }
    }

    if (!body.childElementCount) {
      body.appendChild(el('div.card', el('p', {
        style: { margin: 0, color: 'var(--fg-muted)' },
        text: 'No units for that filter.',
      })));
    }
  };

  host.appendChild(el('div.section-head',
    el('div',
      el('h2.section-head__title', { text: 'GROW grid' }),
      el('p.section-head__sub', {
        text: 'Every CDC unit, rated by you and cross-checked against what you actually recall. '
          + 'Teaching hours are the weight — NEB publishes no unit-wise marks.',
      }))));
  host.appendChild(controls);
  host.appendChild(el('div', { style: { marginTop: 'var(--sp-4)' } }, body));

  paint();
  view.refreshGrid = paint;
  return host;
}

/* --- 3.6 ambient quote ---------------------------------------------------- */

const QUOTE_CACHE_KEY = 'quotesCache';
const QUOTE_TTL_MS = 7 * 86400000;

/** Never leaves the card empty, even offline before the first fetch. */
const QUOTE_FALLBACK = [
  { id: 'fb-1', text: '75 marks in 180 minutes is 2.4 minutes per mark. A 5-mark answer gets 12 minutes, not 25.', source: 'NEB time economics' },
  { id: 'fb-2', text: 'Testing yourself beats rereading. Practice testing lands at d = 0.74; rereading sits near zero.', source: 'Learning-science synthesis' },
  { id: 'fb-3', text: 'A+ needs about 67 of 75 theory marks per subject. That is a number you can chase.', source: 'NEB grading scale' },
];

function readQuoteCache() {
  const c = store.get(QUOTE_CACHE_KEY, null);
  if (!c || !Array.isArray(c.quotes) || !c.quotes.length) return null;
  return c;
}

/**
 * data/quotes.json carries two sets, tagged `kind`. This card only ever shows
 * `fact` entries — statements about method, marks or the paper. The `quote`
 * entries are attributed motivational lines owned elsewhere, and pedagogy-spec
 * §3.5 (Playbook P) is explicit that a motivational quote is never the right
 * thing to put in front of him unprompted.
 */
function usableQuotes(list) {
  const facts = list.filter((q) => q && q.text && (q.kind === undefined || q.kind === 'fact'));
  return facts.length ? facts : list.filter((q) => q && q.text);
}

async function loadQuotes() {
  const cached = readQuoteCache();
  if (cached && Date.now() - (Number(cached.ts) || 0) < QUOTE_TTL_MS) return usableQuotes(cached.quotes);
  try {
    const res = await fetch('data/quotes.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const list = Array.isArray(json && json.quotes) ? json.quotes.filter((q) => q && q.text) : [];
    if (!list.length) throw new Error('no quotes in file');
    store.set(QUOTE_CACHE_KEY, { ts: Date.now(), quotes: list });
    return usableQuotes(list);
  } catch (err) {
    console.warn('[home] quotes not loaded', err);
    return usableQuotes((cached && cached.quotes) || QUOTE_FALLBACK);
  }
}

/** Deterministic per local day, so it does not flicker between renders. */
function quoteForToday(list) {
  const iso = todayLocalISO();
  const n = Number(iso.slice(0, 4)) * 372 + Number(iso.slice(5, 7)) * 31 + Number(iso.slice(8, 10));
  return list[n % list.length];
}

function quoteSection(view) {
  const host = el('section');
  const today = todayLocalISO();
  const ui = store.get(KEYS.UI, {}) || {};
  if (ui.homeQuoteDismissed === today) return host;

  loadQuotes().then((list) => {
    if (view.dead) return;
    const q = quoteForToday(list);
    if (!q) return;
    host.replaceChildren(el('div.card.card--quiet', { style: { border: '1px solid var(--border)' } },
      el('div.home-quote',
        el('div',
          el('div.eyebrow.eyebrow--dot', el('span', { text: 'From the research' })),
          el('p.home-quote__text', { text: q.text }),
          (q.source || q.author) ? el('p.home-quote__src', { text: q.source || q.author }) : null),
        el('button.btn.btn-ghost.btn-icon', {
          type: 'button',
          attrs: { 'aria-label': 'Hide this for today' },
          onClick: () => {
            store.update(KEYS.UI, (prev) => Object.assign({}, prev, { homeQuoteDismissed: today }), {});
            host.replaceChildren();
          },
        }, icon('x', { size: 16 })))));
  });

  return host;
}

/* --- 3.7 the 10:25 strip -------------------------------------------------- */

function nightlySection(view) {
  const host = el('section');

  const render = () => {
    if (view.dead) return;
    const rings = view.rings || null;
    const done = Boolean(rings && rings.review.done >= rings.review.goal);
    const loop = nightlyLoopState({ done });

    if (!loop.pending) { host.replaceChildren(); return; }

    const title = 'Tonight ' + loop.clock + ' — the nightly loop';
    const sub = loop.past
      ? 'Past ' + loop.clock + ' and tonight is still open. The 90-second floor still counts as a night.'
      : (loop.minutesAway <= 90
        ? 'In about ' + loop.minutesAway + ' ' + fmt.plural(loop.minutesAway, 'minute')
          + ': the spaced queue, then interleaved numericals, then one thing said back in your own words.'
        : 'The spaced queue, then interleaved numericals, then one thing said back in your own words. About '
          + Math.max(1, Math.round(loop.minutesAway / 60)) + 'h from now.');

    host.replaceChildren(el('div.card.card--tone', { dataset: { tone: 'info' } },
      el('div.home-night',
        el('span.icon-tile', icon('moon', { size: 16 })),
        el('div.home-night__body',
          el('div.home-night__title', el('span', { text: title })),
          el('p.home-night__sub', { text: sub })),
        el('button.btn.btn-secondary.btn--sm', {
          type: 'button',
          onClick: () => { haptic('select'); navigateTo(routeFor('study', { mode: 'nightly' })); },
        }, icon('play', { size: 14 }), el('span', { text: 'Start now' })))));
  };

  render();
  view.refreshNightly = render;
  return host;
}

/* =============================================================================
   4. The view module
   ========================================================================== */

let active = null;

export default {
  id: 'home',
  title: 'Home',
  icon: 'home',

  render(root) {
    injectStyles();
    registerUnitSearch();
    invalidate();

    const view = {
      dead: false,
      rings: null,
      disposers: [],
      refreshHero: () => {},
      refreshDecision: () => {},
      refreshRings: () => {},
      refreshLoad: () => {},
      refreshGrid: () => {},
      refreshNightly: () => {},
    };
    active = view;

    root.classList.add('engram-home');

    const hero = heroSection(view);
    const decision = decisionSection(view);
    const rings = ringsSection(view);
    const load = loadSection(view);
    const grid = gridSection(view);
    const quote = quoteSection(view);
    const nightly = nightlySection(view);

    root.append(hero, decision, rings, load, grid, quote, nightly);

    if (isVaultMissing() || vaultCounts().flashcards === 0) {
      decision.after(el('p', {
        style: {
          margin: 'var(--sp-3) 0 0', fontSize: 'var(--fs-meta)',
          color: 'var(--fg-subtle)', lineHeight: 'var(--lh-snug)',
        },
        text: 'No vault material is loaded, so nothing is scheduled yet. Self-ratings below are saved locally '
          + 'and start working the moment cards arrive.',
      }));
    }

    // Re-render the pieces that other features write to.
    const onRings = store.subscribe(KEYS.RINGS, () => { view.refreshRings(); });
    const onGame = store.subscribe(KEYS.GAME, () => { view.refreshRings(); });
    const onSrs = store.subscribe(KEYS.SRS, () => {
      invalidate(); view.refreshLoad(); view.refreshDecision();
    });
    view.disposers.push(onRings, onGame, onSrs);

    // The nightly strip is clock-dependent — refresh it once a minute.
    const tick = setInterval(() => {
      if (view.dead) return;
      view.refreshNightly();
    }, 60000);
    view.disposers.push(() => clearInterval(tick));

    // Rings resolve asynchronously; the strip depends on them.
    readRings().then((r) => {
      if (view.dead) return;
      view.rings = r;
      view.refreshNightly();
    });

    // Cross-feature: a finished mock changes the picture immediately.
    const onMock = () => { invalidate(); view.refreshGrid(); view.refreshDecision(); view.refreshLoad(); };
    view.disposers.push(on(window, 'engram:mock-completed', onMock));
  },

  onExit() {
    if (!active) return;
    active.dead = true;
    for (const off of active.disposers) { try { off(); } catch (_) { /* noop */ } }
    active.disposers = [];
    active = null;
  },
};
