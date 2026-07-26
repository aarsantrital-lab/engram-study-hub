/* =============================================================================
   js/views/focus.js — FOCUS MODE + STUDY ROOM.
   Owner: Job — Focus Mode. Timer engine lives in js/focustimer.js.

   Why this screen exists: his single biggest quit cause is the phone and the
   boredom that reaches for it. So the screen does four things, in order:

     1. F.O.C.U.S. — five taps that cost ~20 seconds and produce a declared
        task, a phone face down, an arousal reading, and an empty head.
     2. A fullscreen takeover. The tab bar, the app bar and the sidebar are all
        covered by the stage. Leaving is deliberate: Escape asks first.
     3. An adaptive block. The length is learned from his own completion
        history and he is told why it moved. "Extend — I'm in flow" is always
        one tap away, and so is a parked-thought pad.
     4. A study room, when Supabase is configured: friends' avatars, live ring
        progress, and a synced group block. Offline / not configured, solo mode
        is the whole product and nothing is greyed out or nagging.

   Contract notes:
     · game.js, sb.js and grow.js are loaded with dynamic import() inside a
       try/catch. They are other agents' files and may not exist yet — this
       screen must never take the shell down because a sibling has not landed.
     · No XP is awarded for time on the app (pedagogy-spec §4 hard ban). Focus
       reports an ACTIVITY to game.js; game.js owns every reward decision.
     · All styling is injected once from a token-only stylesheet (this file
       owns no CSS file; components.css / theme.css are frozen).
   ========================================================================== */

import { CONFIG, isFeatureEnabled } from '../config.js';
import { store, KEYS, uid, nowTs } from '../store.js';
import {
  el, append, clear, icon, fmt, toast, haptic, sound, on, prefersReducedMotion, eyebrow, clamp,
} from '../dom.js';
import { navigateTo, routeFor } from '../router.js';
import { isVaultMissing } from '../vault.js';
import * as FT from '../focustimer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------------------------------------------------------------------
   0. Module state — one focus session at a time, torn down in onExit()
   ------------------------------------------------------------------------ */

const S = {
  root: null,
  lobby: null,          // {refs}
  stage: null,          // {node, refs}
  timer: null,
  session: null,
  offs: [],             // global listeners to unbind
  room: null,
  wakeLock: null,
  away: { sec: 0, count: 0, leftAt: 0 },
  starter: null,
  suggestion: null,
  tasks: null,          // normalised quick-pick list
  padOpen: false,
  exitArmed: false,
};

/* ---------------------------------------------------------------------------
   1. Optional sibling modules (game / sb / grow)
   ------------------------------------------------------------------------ */

const modCache = Object.create(null);

async function loadOptional(name) {
  if (name in modCache) return modCache[name];
  let mod = null;
  try {
    if (name === 'game') mod = await import('../game.js');
    else if (name === 'sb') mod = await import('../sb.js');
    else if (name === 'grow') mod = await import('../grow.js');
  } catch (_) {
    mod = null;                       // not shipped yet — solo mode is complete
  }
  modCache[name] = mod;
  return mod;
}

/** Find a function on a module, whether it is a named or a default export. */
function fn(mod, name) {
  if (!mod) return null;
  if (typeof mod[name] === 'function') return mod[name].bind(mod);
  const d = mod.default;
  if (d && typeof d[name] === 'function') return d[name].bind(d);
  return null;
}

/** The sb facade object, whichever way sb.js chose to export it. */
function sbOf(mod) {
  if (!mod) return null;
  const cand = mod.sb || mod.default || mod;
  return cand && typeof cand === 'object' ? cand : null;
}

async function callGame(name, ...args) {
  const g = await loadOptional('game');
  const f = fn(g, name);
  if (!f) return null;
  try { return f(...args); } catch (err) { console.warn('[focus] game.' + name + ' failed', err); return null; }
}

/* ---------------------------------------------------------------------------
   2. Styles — injected once, tokens only, no raw colour anywhere
   ------------------------------------------------------------------------ */

const STYLE_ID = 'focus-mode-styles';

const FOCUS_CSS = `
.focus-lead { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
.focus-lead__num { font-size: var(--fs-metric); font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums;
  letter-spacing: var(--tr-metric); color: var(--fg); text-shadow: 0 0 40px rgb(var(--accent-rgb) / 0.33); }
.focus-lead__unit { font-size: var(--fs-body); color: var(--fg-muted); margin-left: var(--sp-1); }

.focus-rail { display: flex; gap: 3px; width: 100%; margin-top: var(--sp-3); }
.focus-ladder { display: flex; align-items: flex-start; gap: var(--sp-3); }
.focus-letter { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center;
  border-radius: var(--r-lg); border-width: 1px; border-color: rgb(var(--accent-rgb) / 0.32);
  background: rgb(var(--accent-rgb) / 0.14); color: var(--accent);
  font-weight: var(--fw-semibold); font-size: var(--fs-body-lg); box-shadow: var(--lip); }
.focus-step { flex: 1 1 auto; min-width: 0; }
.focus-step__title { font-size: var(--fs-title); font-weight: var(--fw-semibold); letter-spacing: var(--tr-metric); }
.focus-step__why { font-size: var(--fs-meta); color: var(--fg-muted); line-height: var(--lh-snug); margin-top: 2px; }
.focus-options { display: grid; gap: var(--sp-2); margin-top: var(--sp-4); }
.focus-option__why { display: block; font-size: var(--fs-meta); color: var(--fg-muted); margin-top: 2px; line-height: var(--lh-snug); }
.focus-arousal { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--sp-2); margin-top: var(--sp-4); }
.focus-arousal__btn { min-height: var(--tap); display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; border-width: 1px; border-radius: var(--r-md); background: var(--surface-muted); color: var(--fg-muted);
  cursor: pointer; padding: var(--sp-2) 2px; }
.focus-arousal__btn:hover { background: var(--surface-hover); color: var(--fg); border-color: var(--border-hover); }
.focus-arousal__btn[aria-pressed="true"] { background: rgb(var(--accent-rgb) / 0.16); color: var(--accent);
  border-color: rgb(var(--accent-rgb) / 0.4); }
.focus-arousal__n { font-size: var(--fs-body-lg); font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums; }
.focus-arousal__l { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: var(--tr-micro); }

.focus-dialstep { display: flex; align-items: center; justify-content: center; gap: var(--sp-4); margin-top: var(--sp-4); }
.focus-dialstep__num { font-size: var(--fs-metric); font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums;
  min-width: 3ch; text-align: center; }

/* ---- the immersive stage ------------------------------------------------ */
/* While a block runs the page behind must not scroll. Set and removed by JS
   with the stage itself, so the shell is never left in this state. */
.is-focus-stage, .is-focus-stage body { overflow: hidden; }
.focus-stage { position: fixed; inset: 0; z-index: var(--z-modal); display: flex; flex-direction: column;
  background-color: var(--bg); background-image: var(--wash-accent); overflow: hidden; overscroll-behavior: contain; }
.focus-stage__grid { position: absolute; inset: 0; pointer-events: none; opacity: 0.5;
  background-image: linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
                    linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
  background-size: var(--grid-size) var(--grid-size); }
.focus-stage__top { position: relative; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
  padding: calc(var(--safe-top) + var(--sp-3)) calc(var(--safe-right) + var(--gutter))
           var(--sp-3) calc(var(--safe-left) + var(--gutter)); }
.focus-stage__main { position: relative; flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: var(--sp-5);
  padding: var(--sp-4) calc(var(--safe-right) + var(--gutter)) var(--sp-6) calc(var(--safe-left) + var(--gutter));
  text-align: center; }
/* auto margins, not justify-content:center — centred flex content clips its own
   top once it overflows, and the wrap-up screen overflows on a phone.
   flex:0 0 auto stops a short viewport squashing the cards instead of scrolling. */
.focus-stage__main > * { flex: 0 0 auto; max-width: 100%; }
.focus-stage__main > *:first-child { margin-top: auto; }
.focus-stage__main > *:last-child { margin-bottom: auto; }
.focus-stage__foot { position: relative; padding: var(--sp-3) calc(var(--safe-right) + var(--gutter))
  calc(var(--safe-bottom) + var(--sp-4)) calc(var(--safe-left) + var(--gutter)); }
.focus-stage__panel { width: 100%; max-width: 520px; text-align: left; }

.focus-dial { --dial-size: min(64vw, 264px); --dial-stroke: 4px; }
.focus-dial .dial__center { gap: var(--sp-1); }
.focus-clock { font-size: var(--fs-metric-lg); font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums;
  letter-spacing: var(--tr-metric); line-height: 1; color: var(--fg); text-shadow: 0 0 40px rgb(var(--accent-rgb) / 0.33); }
.focus-phase { font-size: var(--fs-eyebrow); text-transform: uppercase; letter-spacing: var(--tr-eyebrow); color: var(--fg-muted); }
.focus-task { max-width: 30ch; font-size: var(--fs-title-lg); font-weight: var(--fw-semibold);
  letter-spacing: var(--tr-metric); line-height: var(--lh-tight); }
.focus-sub { max-width: 44ch; font-size: var(--fs-body); color: var(--fg-muted); line-height: var(--lh-body); }
.focus-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: center; }

.focus-pad { width: 100%; max-width: 520px; margin-inline: auto; text-align: left; }
.focus-pad__list { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); }
.focus-jot { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
  border-width: 1px; border-radius: var(--r-lg); background: var(--surface-muted); font-size: var(--fs-body);
  line-height: var(--lh-snug); }
.focus-jot__text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.focus-jot[data-status="done"] .focus-jot__text { color: var(--fg-subtle); text-decoration: line-through; }
.focus-jot[data-status="dropped"] .focus-jot__text { color: var(--fg-subtle); opacity: 0.7; }

.focus-statrow { display: flex; flex-wrap: wrap; gap: var(--sp-4); justify-content: center; }
.focus-stat { min-width: 84px; }
.focus-stat__v { font-size: var(--fs-title-lg); font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums; }
.focus-stat__k { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: var(--tr-micro); color: var(--fg-muted); }

.focus-slider { -webkit-appearance: none; appearance: none; width: 100%; height: var(--tap);
  background: transparent; accent-color: var(--brand); cursor: pointer; }
.focus-slider:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--r-full); }
.focus-slider::-webkit-slider-runnable-track { height: 8px; border-radius: var(--r-full);
  background: var(--surface-muted); box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.4); }
.focus-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 24px; height: 24px; margin-top: -8px;
  border-radius: var(--r-full); background: var(--brand); box-shadow: var(--glow-accent-soft); }
.focus-slider::-moz-range-track { height: 8px; border-radius: var(--r-full); background: var(--surface-muted); }
.focus-slider::-moz-range-thumb { width: 24px; height: 24px; border: 0; border-radius: var(--r-full); background: var(--brand); }

/* ---- study room --------------------------------------------------------- */
.focus-room__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: var(--sp-3); margin-top: var(--sp-3); }
.focus-member { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: var(--sp-3) var(--sp-2);
  border-width: 1px; border-radius: var(--r-lg); background: var(--surface-muted); text-align: center; }
.focus-member[data-focusing="true"] { border-color: rgb(var(--accent-rgb) / 0.35); background: rgb(var(--accent-rgb) / 0.08); }
.focus-av { width: 40px; height: 40px; border-radius: var(--r-full); display: grid; place-items: center;
  border-width: 1px; border-color: rgb(var(--accent-rgb) / 0.32); background: rgb(var(--accent-rgb) / 0.16);
  color: var(--accent); font-weight: var(--fw-semibold); font-size: var(--fs-body-lg); overflow: hidden; }
.focus-av img { width: 100%; height: 100%; object-fit: cover; }
.focus-member__name { font-size: var(--fs-meta); font-weight: var(--fw-medium); max-width: 100%; }
.focus-member__status { font-size: var(--fs-micro); color: var(--fg-muted); max-width: 100%; }
.focus-member__rings { display: flex; flex-direction: column; gap: 2px; width: 100%; margin-top: 2px; }
.focus-roomstrip { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; justify-content: center; }
.focus-roomstrip .focus-av { width: 28px; height: 28px; font-size: var(--fs-meta); }

@media (min-width: 768px) {
  .focus-dial { --dial-size: 300px; --dial-stroke: 3.5px; }
}
@media (prefers-reduced-motion: reduce) {
  .focus-stage, .focus-dial .dial__fill { animation: none !important; transition: none !important; }
}
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FOCUS_CSS;                 // static string, never user input
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
   3. Small builders
   ------------------------------------------------------------------------ */

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

/** The 76-viewBox ring dial from components.css, scaled by --dial-size. */
function ringDial(pct, centre, cls) {
  const svg = svgEl('svg', { class: 'dial__svg', viewBox: '0 0 76 76', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('circle', { class: 'dial__track', cx: 38, cy: 38, r: 34.5 }));
  svg.appendChild(svgEl('circle', { class: 'dial__fill', cx: 38, cy: 38, r: 34.5 }));
  return el('div.dial' + (cls ? '.' + cls : ''), {
    style: { '--pct': clamp(Number(pct) || 0, 0, 100) },
    attrs: { role: 'img' },
  }, svg, centre || null);
}

function pill(text, opts) {
  const o = opts || {};
  return el('span.pill' + (o.variant ? '.pill--' + o.variant : ''), {
    dataset: o.tone ? { tone: o.tone } : null,
  }, o.icon ? icon(o.icon, { size: 12 }) : null, el('span', { text: String(text) }));
}

function statBlock(value, label) {
  return el('div.focus-stat',
    el('div.focus-stat__v', { text: String(value) }),
    el('div.focus-stat__k', { text: String(label) }));
}

function sectionHead(title, sub, actions) {
  return el('div.section-head',
    el('div',
      el('h2.section-head__title', { text: title }),
      sub ? el('p.section-head__sub', { text: sub }) : null),
    actions ? el('div.section-head__actions', actions) : null);
}

function subjectSlug(subject) {
  return String(subject || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** '30 minutes' once it is worth saying in minutes, '48s' when it is not. */
function humanMinutes(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 120) return fmt.dur(s * 1000);
  const m = Math.round(s / 60);
  return m + ' ' + fmt.plural(m, 'minute');
}

/** Confetti burst — deterministic, cheap, and silent under reduced motion. */
function confetti() {
  if (prefersReducedMotion()) return;
  const layer = el('div.confetti-layer', { attrs: { 'aria-hidden': 'true' } });
  const pieces = 26;
  for (let i = 0; i < pieces; i += 1) {
    const angle = (Math.PI * 2 * i) / pieces;
    const dist = 90 + (i % 5) * 28;
    layer.appendChild(el('span.confetti-piece', {
      style: {
        left: '50%',
        top: '46%',
        background: 'var(--confetti-' + ((i % 6) + 1) + ')',
        '--tx': Math.round(Math.cos(angle) * dist) + 'px',
        '--ty': Math.round(Math.sin(angle) * dist - 40) + 'px',
        '--rot': ((i % 2 ? 1 : -1) * (180 + i * 13)) + 'deg',
        animationDelay: ((i % 7) * 18) + 'ms',
      },
    }));
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1100);
}

/** A gentle chime — dom.js synthesises it; honours the sounds setting. */
function chime() { sound('complete'); }

/**
 * CONTRACT-A §16.3 — zero external origins. A friend's avatar may only be
 * fetched from this origin, from an inline `data:` URL, or from the configured
 * Supabase project (which is where sb.storage puts it). Anything else renders
 * as an initial letter rather than opening a request to a stranger's host.
 * @returns {string|null}
 */
function safeAvatarSrc(src) {
  const s = String(src || '').trim();
  if (!s) return null;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);/i.test(s)) return s;
  try {
    const u = new URL(s, location.href);
    if (u.origin === location.origin) return u.href;
    const configured = String(CONFIG.SUPABASE_URL || '').trim();
    if (configured && u.protocol === 'https:' && u.origin === new URL(configured).origin) return u.href;
  } catch (_) { /* unparseable — treat as untrusted */ }
  return null;
}

function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); }
  catch (_) { /* very old browser — the local flow still works */ }
}

/* ---------------------------------------------------------------------------
   4. Tasks — the ONE task he declares
   ------------------------------------------------------------------------ */

const LANE_ROUTES = { review: 'study', encode: 'maps', drill: 'papers' };

const LANE_TASKS = [
  {
    id: 'lane-review', kind: 'review', label: 'Cards due today',
    why: 'Lowest-retrievability first, capped by your time budget — not by a due count.',
  },
  {
    id: 'lane-encode', kind: 'encode', label: 'Build or extend a map',
    why: 'Cards for a chapter cannot exist until its map does. This is the stage that makes the rest cheap.',
  },
  {
    id: 'lane-drill', kind: 'drill', label: 'Numericals or past-paper questions',
    why: 'The NEB grid is 60–70% application. Step-marking is where 3 of 5 becomes 5 of 5.',
  },
];

function inferKind(text) {
  const t = String(text || '').toLowerCase();
  if (/card|review|recall|retriev|due|srs|flash|relearn/.test(t)) return 'review';
  if (/numeric|problem|paper|mock|drill|past|mcq|exam|timed|marks/.test(t)) return 'drill';
  if (/map|encode|lesson|note|tree|prime|read|grinde/.test(t)) return 'encode';
  return 'review';
}

function normaliseTask(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const label = raw.trim();
    if (!label) return null;
    return { id: null, label, kind: inferKind(label), subject: null, route: null, why: null };
  }
  if (typeof raw !== 'object') return null;
  const label = raw.label || raw.title || raw.name || raw.unit || raw.unitName || raw.topic || raw.id;
  if (!label) return null;
  const kind = FT.TASK_KINDS.includes(raw.kind) ? raw.kind
    : inferKind([raw.kind, raw.type, raw.action, raw.label, raw.title, raw.reason].join(' '));
  let route = typeof raw.route === 'string' && raw.route ? raw.route : null;
  if (!route && raw.topicId) route = routeFor('topic', { id: raw.topicId });
  return {
    id: raw.id || raw.unitId || raw.topicId || null,
    label: String(label).slice(0, 120),
    subject: raw.subject || null,
    kind,
    route,
    why: raw.why || raw.reason || raw.rationale || null,
  };
}

/**
 * grow.pickNext() answers "what should I study now?" with
 * {unit, row, action:{kind,label,detail,route}, reason, alternatives[]}.
 * Its `action.kind` vocabulary is wider than the three rings, so it is mapped.
 */
function taskFromPick(entry) {
  if (!entry || !entry.unit) return null;
  const unit = entry.unit;
  const action = entry.action || {};
  const kind = FT.TASK_KINDS.includes(action.kind)
    ? action.kind
    : inferKind([action.kind, action.label, action.detail].join(' '));
  return {
    id: unit.id || null,
    label: String(unit.name || 'This unit').slice(0, 120),
    subject: unit.subject || null,
    kind,
    route: action.route || null,
    why: action.label ? action.label + (action.detail ? ' — ' + action.detail : '') : null,
    reason: entry.reason || null,
  };
}

async function loadTasks() {
  const grow = await loadOptional('grow');
  const pick = fn(grow, 'pickNext');
  let picked = [];
  if (pick) {
    try {
      const out = await Promise.resolve(pick({ alternatives: 2 }));
      if (out && out.unit && !out.empty) {
        picked = [out].concat(Array.isArray(out.alternatives) ? out.alternatives : [])
          .map(taskFromPick).filter(Boolean).slice(0, 3)
          // grow's `reason` sentence is written for the top pick only.
          .map((t, i) => (i === 0 ? t : Object.assign({}, t, { reason: null })));
      } else if (Array.isArray(out)) {
        picked = out.map((x) => taskFromPick(x) || normaliseTask(x)).filter(Boolean).slice(0, 3);
      }
    } catch (err) {
      console.warn('[focus] grow.pickNext() failed — falling back to the three lanes', err);
    }
  }
  const lanes = LANE_TASKS.map((t) => Object.assign({}, t, { route: routeFor(LANE_ROUTES[t.kind]) }));
  return picked.length ? picked.concat(lanes) : lanes;
}

function taskRoute(task) {
  if (task && task.route) return task.route;
  const lane = task && FT.TASK_KINDS.includes(task.kind) ? task.kind : 'review';
  return routeFor(LANE_ROUTES[lane]);
}

/* ---------------------------------------------------------------------------
   5. LOBBY
   ------------------------------------------------------------------------ */

function freshStarter() {
  const sug = FT.sustainableInterval();
  const focus = FT.readFocus();
  return {
    step: 0,
    task: null,
    kind: focus.lastKind || null,
    arousal: null,
    phoneDown: false,
    minutes: sug.minutes,
    /* An ABSOLUTE end time, not a countdown snapshot: the five taps take
       ~20 seconds, so a number captured at join time would already be a lie by
       the time he reads it on the last tap. */
    groupEndsAt: 0,
  };
}

/** Seconds left on the group block he is joining, computed at read time. */
function starterGroupRemaining() {
  const ends = S.starter && S.starter.groupEndsAt;
  if (!ends) return 0;
  return Math.max(0, Math.ceil((ends - Date.now()) / 1000));
}

const LADDER = [
  { letter: 'F', title: 'Fix ONE task', why: 'One declared task beats a list. A block with two jobs in it is a block you abandon.' },
  { letter: 'O', title: 'Off and over', why: 'Face down, screen off, out of arm’s reach. Reaching for it is the failure mode this whole screen exists to beat.' },
  { letter: 'C', title: 'Check your charge', why: 'Rate how awake you are right now, 1 to 5. It sets the block length and the lane — the reading is used, not collected.' },
  { letter: 'U', title: 'Unload your head', why: 'Anything nagging at you goes in the pad now, and comes back at the end. Parked, not lost.' },
  { letter: 'S', title: 'Set the clock', why: 'The length comes from your own finished blocks. You can push it mid-block whenever you are in flow.' },
];

function renderLobby() {
  const root = S.root;
  if (!root) return;
  clear(root);

  const focus = FT.readFocus();
  const sug = S.suggestion || FT.sustainableInterval();
  S.suggestion = sug;
  const today = FT.dayFocusStats();

  /* --- lead card ------------------------------------------------------- */
  root.appendChild(el('section.section',
    el('div.card.card--tone.card--2xl.card--pad-lg', { dataset: { tone: 'brand' } },
      eyebrow('Focus mode'),
      el('h1.text-title', { text: 'One task. One block. Phone face down.' }),
      el('div.focus-lead', { style: { marginTop: 'var(--sp-4)' } },
        el('div',
          el('span.focus-lead__num', { text: String(sug.minutes) }),
          el('span.focus-lead__unit', { text: 'min block' })),
        el('div.stack', { style: { gap: 'var(--sp-2)' } },
          el('p.text-meta', { text: sug.reason, style: { maxWidth: '44ch' } }),
          el('div.chip-row',
            pill(today.blocks + ' ' + fmt.plural(today.blocks, 'block') + ' today', { icon: 'circle-check', variant: today.blocks ? 'good' : 'neutral' }),
            pill(humanMinutes(today.focusedSec) + ' focused', { icon: 'timer', variant: 'neutral' }),
            sug.sample >= 3
              ? pill(fmt.pct(sug.completionRate) + ' of blocks finished', { icon: 'trending-up', variant: 'neutral' })
              : null)))),
  ));

  /* --- the F.O.C.U.S. ladder ------------------------------------------ */
  root.appendChild(el('section.section', ladderCard()));

  /* --- chat mute (the stage mirrors this into an indicator) ------------- */
  if (isFeatureEnabled('chat')) root.appendChild(el('section.section', chatMuteCard()));

  /* --- rings ------------------------------------------------------------ */
  const ringsSection = el('section.section');
  root.appendChild(ringsSection);
  S.lobby = { ringsSection };

  /* --- parked thoughts -------------------------------------------------- */
  const open = FT.getJots({ status: 'open' });
  if (open.length) {
    root.appendChild(el('section.section',
      sectionHead('Parked thoughts', open.length + ' waiting from earlier blocks'),
      el('div.card',
        el('div.focus-pad__list', ...open.slice(-8).reverse().map((j) => jotRow(j, () => renderLobby()))))));
  }

  /* --- study room ------------------------------------------------------- */
  const roomHost = el('div');
  S.lobby.roomHost = roomHost;
  root.appendChild(el('section.section', roomHost));
  renderRoomCard();

  /* --- recent blocks ---------------------------------------------------- */
  const recent = FT.getSessions(6).slice().reverse();
  if (recent.length) {
    root.appendChild(el('section.section',
      sectionHead('Recent blocks', 'What the timer learned from'),
      el('div.card.card--flush',
        el('div.scroll-x',
          el('table.table',
            el('thead', el('tr',
              el('th', { text: 'When' }), el('th', { text: 'Task' }),
              el('th.table__num', { text: 'Planned' }), el('th.table__num', { text: 'Focused' }))),
            el('tbody', ...recent.map((s) => el('tr',
              el('td', { text: fmt.rel(s.ts) }),
              el('td', el('span.truncate', { text: s.taskLabel || FT.KIND_LABELS[s.kind] || '—' })),
              el('td.table__num', { text: Math.round(s.plannedSec / 60) + 'm' }),
              el('td.table__num', {
                text: Math.round(s.focusedSec / 60) + 'm',
                class: s.focusedSec >= s.plannedSec ? 'text-accent' : '',
              })))))))));
  }

  if (isVaultMissing()) {
    root.appendChild(el('p.text-meta', {
      text: 'No study data has synced yet — you can still declare a task in your own words and run a block.',
    }));
  }

  renderRings();
}

/**
 * The chat-mute preference. Focus owns the FLAG (KEYS.FOCUS.muteChat) and
 * announces it on 'engram:focus-start' / 'engram:focus-end'; chat.js owns
 * whether it acts on it. Stated plainly here so the indicator on the stage is
 * never a promise this screen cannot keep.
 */
function chatMuteCard() {
  const label = el('span', { text: FT.isChatMuted() ? 'Chat is muted during a block' : 'Chat stays on during a block' });
  const btn = el('button.btn.btn-secondary.btn--sm', { type: 'button' });
  const paint = () => {
    const muted = FT.isChatMuted();
    label.textContent = muted ? 'Chat is muted during a block' : 'Chat stays on during a block';
    clear(btn);
    btn.setAttribute('aria-pressed', String(muted));
    append(btn,
      icon(muted ? 'bell' : 'message-circle', { size: 14 }),
      el('span', { text: muted ? 'Unmute' : 'Mute' }));
  };
  btn.addEventListener('click', () => {
    FT.setChatMuted(!FT.isChatMuted());
    haptic('tap');
    paint();
    emit('engram:focus-mute', { muted: FT.isChatMuted() });
  });
  paint();

  return el('div.card',
    el('div.row.row--between',
      el('div.row',
        icon('message-circle', { size: 16, cls: 'icon--muted' }),
        el('div',
          el('div.card__title', label),
          el('p.text-meta', { text: 'The stage covers the whole screen either way — this is for notifications that would arrive behind it.' }))),
      btn));
}

function jotRow(jot, after) {
  const row = el('div.focus-jot', { dataset: { status: jot.status || 'open' } },
    icon(jot.status === 'done' ? 'circle-check' : 'pin', { size: 14, cls: 'icon--muted' }),
    el('span.focus-jot__text', { text: jot.text }));
  if ((jot.status || 'open') === 'open') {
    row.appendChild(el('div.btn-row',
      el('button.btn.btn-ghost.btn--sm', {
        type: 'button', text: 'Done',
        onClick: () => { FT.setJotStatus(jot.id, 'done'); haptic('tap'); if (after) after(); },
      }),
      el('button.btn.btn-ghost.btn--sm', {
        type: 'button', text: 'Drop',
        onClick: () => { FT.setJotStatus(jot.id, 'dropped'); haptic('tap'); if (after) after(); },
      })));
  }
  return row;
}

/* --- the five taps ------------------------------------------------------ */

function ladderCard() {
  const st = S.starter;
  const step = LADDER[st.step] || LADDER[0];

  const rail = el('div.rail.focus-rail', ...LADDER.map((_, i) =>
    el('span.rail__cell', { class: i < st.step ? 'is-done' : (i === st.step ? 'is-current' : '') })));

  const card = el('div.card.card--pad-lg', {
    dataset: st.task && st.task.subject ? { subject: subjectSlug(st.task.subject) } : { tone: 'brand' },
  },
    el('div.focus-ladder',
      el('div.focus-letter', { text: step.letter }),
      el('div.focus-step',
        el('div.focus-step__title', { text: step.title }),
        el('p.focus-step__why', { text: step.why }))),
    rail,
    stepBody(st.step));

  if (st.step > 0) {
    card.appendChild(el('div.card__foot',
      el('button.btn.btn-ghost.btn--sm', {
        type: 'button', onClick: () => { S.starter.step -= 1; haptic('tap'); renderLobby(); },
      }, icon('chevron-left', { size: 14 }), el('span', { text: 'Back' })),
      el('span.push.text-meta', { text: 'Step ' + (st.step + 1) + ' of 5' })));
  }
  return card;
}

function advance() {
  S.starter.step = Math.min(LADDER.length - 1, S.starter.step + 1);
  haptic('select');
  renderLobby();
}

function stepBody(step) {
  if (step === 0) return stepTask();
  if (step === 1) return stepPhone();
  if (step === 2) return stepArousal();
  if (step === 3) return stepUnload();
  return stepClock();
}

function stepTask() {
  const host = el('div.focus-options');
  const list = S.tasks || LANE_TASKS.map((t) => Object.assign({}, t, { route: routeFor(LANE_ROUTES[t.kind]) }));

  for (const task of list) {
    host.appendChild(el('button.option', {
      type: 'button',
      dataset: task.subject ? { subject: subjectSlug(task.subject) } : null,
      onClick: () => {
        S.starter.task = task;
        S.starter.kind = task.kind;
        advance();
      },
    },
      el('span.option__key', { text: (FT.KIND_LABELS[task.kind] || '?').charAt(0) }),
      el('span',
        el('span', { text: task.label }),
        el('span.focus-option__why', { text: task.why || FT.KIND_BLURBS[task.kind] || '' }),
        task.reason ? el('span.focus-option__why', { text: task.reason }) : null)));
  }

  const input = el('input.input', {
    type: 'text', placeholder: 'Or type the one task in your own words',
    attrs: { 'aria-label': 'Declare your own task', maxlength: '120', enterkeyhint: 'go' },
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } },
  });
  const commit = () => {
    const label = String(input.value || '').trim();
    if (!label) { input.focus(); return; }
    S.starter.task = { id: null, label, kind: inferKind(label), subject: null, route: null, why: null };
    S.starter.kind = S.starter.task.kind;
    advance();
  };
  host.appendChild(el('div.input-group.input-group--trail',
    input,
    el('button.input-group__action', { type: 'button', attrs: { 'aria-label': 'Use this task' }, onClick: commit },
      icon('arrow-right', { size: 16 }))));

  return host;
}

function stepPhone() {
  return el('div',
    el('p.text-meta', {
      style: { marginTop: 'var(--sp-3)' },
      text: 'Screen down on the desk, or in another room. Nothing here can stop a notification — this step is the only thing that can.',
    }),
    el('div.btn-row', { style: { marginTop: 'var(--sp-4)' } },
      el('button.btn.btn-primary.btn--lg.btn--block', {
        type: 'button',
        onClick: () => { S.starter.phoneDown = true; advance(); },
      }, icon('check', { size: 16 }), el('span', { text: 'It is face down' }))));
}

function stepArousal() {
  const host = el('div');
  const grid = el('div.focus-arousal');
  for (let n = 1; n <= 5; n += 1) {
    grid.appendChild(el('button.focus-arousal__btn', {
      type: 'button',
      attrs: { 'aria-pressed': String(S.starter.arousal === n) },
      onClick: () => {
        const advice = FT.arousalAdvice(n, S.suggestion ? S.suggestion.minutes : FT.suggestMinutes());
        S.starter.arousal = n;
        S.starter.minutes = advice.minutes;
        if (!S.starter.task) S.starter.kind = advice.kind;
        advance();
      },
    },
      el('span.focus-arousal__n', { text: String(n) }),
      el('span.focus-arousal__l', { text: FT.AROUSAL_LABELS[n] })));
  }
  host.appendChild(grid);
  host.appendChild(el('p.text-meta', { style: { marginTop: 'var(--sp-3)' }, text: '1 = running on empty · 5 = buzzing' }));
  return host;
}

function stepUnload() {
  const box = el('textarea.textarea', {
    placeholder: 'Anything circling in your head? Park it here — you get it back at the end.',
    attrs: { 'aria-label': 'Park a thought', maxlength: '500', rows: '3' },
  });
  const park = (goOn) => {
    const text = String(box.value || '').trim();
    if (text) { FT.addJot(text, null); box.value = ''; }
    if (goOn) advance();
  };
  return el('div', { style: { marginTop: 'var(--sp-3)' } },
    box,
    el('div.btn-row', { style: { marginTop: 'var(--sp-3)' } },
      el('button.btn.btn-primary', { type: 'button', onClick: () => park(true) },
        icon('pin', { size: 14 }), el('span', { text: 'Park it and carry on' })),
      el('button.btn.btn-ghost', { type: 'button', text: 'Head is clear', onClick: () => advance() })));
}

function stepClock() {
  const st = S.starter;
  const readout = el('div.focus-dialstep__num', { text: String(st.minutes) });
  const setMin = (delta) => {
    st.minutes = FT.clampMinutes(st.minutes + delta);
    readout.textContent = String(st.minutes);
    haptic('tap');
  };
  const advice = st.arousal ? FT.arousalAdvice(st.arousal, st.minutes) : null;

  return el('div',
    el('div.focus-dialstep',
      el('button.btn.btn-icon.btn--lg', { type: 'button', attrs: { 'aria-label': 'Five minutes less' }, onClick: () => setMin(-FT.FOCUS_LIMITS.stepMinutes) },
        icon('minus', { size: 20 })),
      el('div',
        readout,
        el('div.focus-stat__k', { text: 'minutes' })),
      el('button.btn.btn-icon.btn--lg', { type: 'button', attrs: { 'aria-label': 'Five minutes more' }, onClick: () => setMin(FT.FOCUS_LIMITS.stepMinutes) },
        icon('plus', { size: 20 }))),
    el('div.chip-row', { style: { marginTop: 'var(--sp-3)', justifyContent: 'center' } },
      st.task ? pill(st.task.label, { icon: 'target', variant: 'accent' }) : null,
      pill(FT.KIND_LABELS[st.kind || 'review'], { variant: 'neutral' }),
      st.arousal ? pill('Charge ' + st.arousal + ' · ' + FT.AROUSAL_LABELS[st.arousal], { variant: 'neutral' }) : null),
    advice ? el('p.text-meta', { style: { marginTop: 'var(--sp-3)' }, text: advice.note }) : null,
    st.task && st.task.reason ? el('p.text-meta', { style: { marginTop: 'var(--sp-2)' }, text: st.task.reason }) : null,
    starterGroupRemaining() > 0
      ? el('p.text-meta', { style: { marginTop: 'var(--sp-2)' }, text: 'Group block has ' + fmt.clock(starterGroupRemaining()) + ' left.' })
      : null,
    el('div.btn-row', { style: { marginTop: 'var(--sp-4)' } },
      el('button.btn.btn-primary.btn--lg.btn--block', { type: 'button', onClick: () => startSession() },
        icon('play', { size: 16 }), el('span', { text: 'Start the block' }))));
}

/* --- rings -------------------------------------------------------------- */

const RING_TONES = { review: 'brand', encode: 'ai', drill: 'info' };

async function renderRings() {
  const host = S.lobby && S.lobby.ringsSection;
  if (!host) return;
  const rings = await callGame('getRings');
  if (!S.lobby || S.lobby.ringsSection !== host) return;
  if (!rings) { host.remove(); return; }        // game.js not shipped yet — no empty hole

  const cards = FT.TASK_KINDS.map((kind) => {
    const r = rings[kind] || {};
    const done = Number(r.done) || 0;
    const goal = Math.max(1, Number(r.goal) || 1);
    const pct = clamp((done / goal) * 100, 0, 100);
    // A closed ring reads as CLOSED, not as "3 of 1". Overshooting the goal is
    // normal — one 4-question drill closes a 1-drill ring three times over — and
    // the fraction was the only thing on screen still counting past 100%. The
    // true count stays visible in the tooltip; nothing he did is hidden.
    const closed = done >= goal;
    const dialCentre = closed
      ? el('span.dial__center',
          el('span.dial__num', { text: String(goal) }),
          el('span.dial__pct', { text: 'done' }))
      : el('span.dial__center',
          el('span.dial__num', { text: String(done) }),
          el('span.dial__pct', { text: 'of ' + goal }));
    return el('div.card.card--tone', {
      dataset: { tone: RING_TONES[kind] },
      attrs: { title: FT.KIND_LABELS[kind] + ': ' + done + ' of ' + goal },
    },
      el('div.row',
        ringDial(pct, dialCentre, 'dial--sm'),
        el('div',
          el('div.stat__eyebrow', { text: FT.KIND_LABELS[kind] }),
          el('div.text-meta', { text: FT.KIND_BLURBS[kind] }))));
  });

  clear(host);
  host.appendChild(sectionHead('Today’s rings', 'What a block here moves'));
  host.appendChild(el('div.card-grid', ...cards));
}

/* ---------------------------------------------------------------------------
   6. THE STAGE — fullscreen takeover
   ------------------------------------------------------------------------ */

async function startSession() {
  const st = S.starter;
  const task = st.task || Object.assign({}, LANE_TASKS[0], { route: routeFor('study') });
  const kind = FT.TASK_KINDS.includes(st.kind) ? st.kind : task.kind;
  const minutes = FT.clampMinutes(st.minutes);

  S.session = {
    id: uid('foc'),
    startedTs: nowTs(),
    task,
    kind,
    minutes,
    arousal: st.arousal,
    jots: [],
    group: starterGroupRemaining() > 0,
    effort: null,
    thinking: null,
    handedOff: false,
    recordId: null,
    final: null,
  };
  S.away = { sec: 0, count: 0, leftAt: 0 };
  S.exitArmed = false;
  S.padOpen = false;

  FT.setPreset({ minutes });
  emit('engram:focus-start', {
    sessionId: S.session.id, kind, task: task.label, minutes,
    chatMuted: FT.isChatMuted(),
  });

  // The timer must exist before the stage paints — the stage reads its phase.
  S.timer = FT.createFocusTimer({
    minutes,
    breakMinutes: FT.breakMinutesFor(1),
    onTick: onTick,
    onComplete: onBlockComplete,
    onBreakEnd: onBreakEnd,
  });

  buildStage();

  S.timer.start();
  onTick(S.timer.snapshot());

  requestFullscreen();
  requestWakeLock();
  wireStageGlobals();
  pushRoomPresence();
  haptic('select');
}

function buildStage() {
  teardownStage();
  const session = S.session;
  const refs = {};

  refs.clock = el('div.focus-clock', { text: fmt.clock(session.minutes * 60) });
  refs.phase = el('div.focus-phase', { text: 'Block 1' });
  refs.dial = ringDial(0, el('span.dial__center', refs.clock, refs.phase), 'focus-dial');
  refs.dial.setAttribute('aria-label', 'Time left in this block');

  refs.taskLine = el('div.focus-task', { text: session.task.label });
  refs.subLine = el('p.focus-sub', {
    text: FT.KIND_BLURBS[session.kind] || '',
  });

  refs.actions = el('div.focus-actions');
  refs.main = el('div.focus-stage__main');
  refs.padHost = el('div.focus-pad', { hidden: true });
  refs.roomStrip = el('div.focus-roomstrip');
  refs.foot = el('div.focus-stage__foot', refs.padHost, refs.roomStrip);

  refs.chatPill = isFeatureEnabled('chat') && FT.isChatMuted()
    ? pill('Chat muted', { icon: 'message-circle', variant: 'neutral' })
    : null;

  refs.top = el('div.focus-stage__top',
    pill(FT.KIND_LABELS[session.kind], { icon: 'target', variant: 'accent' }),
    refs.chatPill,
    session.group ? pill('Group block', { icon: 'user', variant: 'info' }) : null,
    el('span.push'),
    el('button.btn.btn-ghost.btn--sm', {
      type: 'button', attrs: { 'aria-label': 'End the session' }, onClick: () => requestExit(),
    }, icon('x', { size: 16 }), el('span', { text: 'End' })));

  const node = el('div.focus-stage', {
    dataset: session.task.subject ? { subject: subjectSlug(session.task.subject) } : { tone: 'brand' },
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Focus session' },
  },
    el('div.focus-stage__grid'),
    refs.top,
    refs.main,
    refs.foot);

  document.body.appendChild(node);
  document.documentElement.classList.add('is-focus-stage');
  S.stage = { node, refs };
  renderBlockMode();
  renderRoomStrip();
}

function renderBlockMode() {
  if (!S.stage || !S.timer) return;
  const { refs } = S.stage;
  clear(refs.main);
  clear(refs.actions);

  refs.actions.appendChild(el('button.btn.btn-primary', {
    type: 'button',
    onClick: () => {
      S.timer.extend(FT.FOCUS_LIMITS.extendMinutes);
      haptic('success');
      toast('+' + FT.FOCUS_LIMITS.extendMinutes + ' minutes on this block', { tone: 'good', timeout: 2200 });
      onTick(S.timer.snapshot());
      if (S.timer.phase === 'running') renderBlockMode();
    },
  }, icon('zap', { size: 16 }), el('span', { text: 'Extend — I’m in flow' })));

  const pauseBtn = el('button.btn.btn-secondary', { type: 'button' },
    icon(S.timer.phase === 'paused' ? 'play' : 'pause', { size: 16 }),
    el('span', { text: S.timer.phase === 'paused' ? 'Resume' : 'Pause' }));
  pauseBtn.addEventListener('click', () => {
    S.timer.toggle();
    haptic('tap');
    renderBlockMode();
    onTick(S.timer.snapshot());
  });
  refs.actions.appendChild(pauseBtn);

  refs.actions.appendChild(el('button.btn.btn-ghost', {
    type: 'button', onClick: () => togglePad(),
  }, icon('pin', { size: 16 }), el('span', { text: 'Jot' })));

  refs.main.appendChild(refs.dial);
  refs.main.appendChild(refs.taskLine);
  refs.main.appendChild(refs.subLine);
  refs.main.appendChild(refs.actions);
  if (S.timer.phase === 'paused') {
    refs.main.appendChild(el('p.text-meta', { text: 'Held. The clock is not running.' }));
  }
}

function onTick(snap) {
  if (!S.stage) return;
  const { refs } = S.stage;
  const inBreak = snap.phase === 'break' || snap.phase === 'break-done';
  const secs = inBreak ? snap.breakRemainingSec : snap.remainingSec;
  // The ring shows time LEFT: full at the start, empty at the bell.
  const pct = 100 - (inBreak ? snap.breakPct : snap.pct);
  if (refs.clock) refs.clock.textContent = fmt.clock(secs);
  if (refs.dial) {
    refs.dial.style.setProperty('--pct', String(Math.round(pct)));
    refs.dial.setAttribute('aria-label', fmt.clock(secs) + ' left');
  }
  if (refs.phase) {
    refs.phase.textContent = inBreak ? 'Break'
      : (snap.phase === 'paused' ? 'Held' : 'Block ' + (snap.blocks + 1));
  }
  if (refs.breakClock) refs.breakClock.textContent = fmt.clock(snap.breakRemainingSec);
}

function onBlockComplete(snap) {
  chime();
  haptic('success');
  confetti();
  renderBellMode(snap);
  pushRoomPresence();
}

function renderBellMode(snap) {
  if (!S.stage) return;
  const { refs } = S.stage;
  const blockNo = snap.blocks + 1;
  const suggestion = FT.breakSuggestion(blockNo - 1);
  const breakMin = FT.breakMinutesFor(blockNo);

  clear(refs.main);
  refs.main.appendChild(el('div.focus-phase', { text: 'Block ' + blockNo + ' done' }));
  refs.main.appendChild(el('div.focus-task', {
    text: Math.round(snap.plannedSec / 60) + ' minutes on ' + S.session.task.label,
  }));

  refs.main.appendChild(el('div.card.card--tone.focus-stage__panel', { dataset: { tone: 'good' } },
    el('div.row',
      icon(suggestion.icon, { size: 20, cls: 'icon--accent' }),
      el('div',
        el('div.card__title', { text: suggestion.title }),
        el('p.text-meta', { text: suggestion.detail })))));

  refs.main.appendChild(el('div.focus-actions',
    el('button.btn.btn-primary', {
      type: 'button',
      onClick: () => {
        S.timer.extend(FT.FOCUS_LIMITS.extendMinutes);
        renderBlockMode();
        onTick(S.timer.snapshot());
        haptic('select');
      },
    }, icon('zap', { size: 16 }), el('span', { text: '+' + FT.FOCUS_LIMITS.extendMinutes + ' — I’m in flow' })),
    el('button.btn.btn-secondary', {
      type: 'button',
      onClick: () => {
        S.timer.startBreak(breakMin);
        renderBreakMode(S.timer.snapshot());
        onTick(S.timer.snapshot());
      },
    }, icon('clock', { size: 16 }), el('span', { text: 'Take ' + breakMin + ' minutes' })),
    el('button.btn.btn-ghost', {
      type: 'button', text: 'Finish for today', onClick: () => finishSession(),
    })));
}

function renderBreakMode(snap) {
  if (!S.stage) return;
  const { refs } = S.stage;
  const suggestion = FT.breakSuggestion(snap.blocks - 1);
  clear(refs.main);

  refs.main.appendChild(refs.dial);
  refs.main.appendChild(el('div.focus-task', { text: suggestion.title }));
  refs.main.appendChild(el('p.focus-sub', { text: suggestion.detail }));
  refs.main.appendChild(el('div.focus-actions',
    el('button.btn.btn-secondary', {
      type: 'button',
      onClick: () => { S.timer.skipBreak(); onBreakEnd(S.timer.snapshot()); },
    }, icon('play', { size: 16 }), el('span', { text: 'Skip the break' })),
    el('button.btn.btn-ghost', { type: 'button', text: 'Finish for today', onClick: () => finishSession() })));
  onTick(snap);
}

function onBreakEnd(snap) {
  if (!S.stage) return;
  chime();
  const { refs } = S.stage;
  const nextNo = snap.blocks + 1;
  const minutes = FT.clampMinutes(S.session.minutes);
  clear(refs.main);
  refs.main.appendChild(el('div.focus-phase', { text: 'Break over' }));
  refs.main.appendChild(el('div.focus-task', { text: 'Block ' + nextNo + '?' }));
  refs.main.appendChild(el('p.focus-sub', { text: 'Same task: ' + S.session.task.label }));
  refs.main.appendChild(el('div.focus-actions',
    el('button.btn.btn-primary.btn--lg', {
      type: 'button',
      onClick: () => {
        S.timer.nextBlock(minutes);
        renderBlockMode();
        onTick(S.timer.snapshot());
        haptic('select');
      },
    }, icon('play', { size: 16 }), el('span', { text: 'Start block ' + nextNo + ' · ' + minutes + ' min' })),
    el('button.btn.btn-ghost', { type: 'button', text: 'Finish for today', onClick: () => finishSession() })));
}

/* --- distraction pad ---------------------------------------------------- */

function togglePad() {
  S.padOpen = !S.padOpen;
  renderPad();
  if (S.padOpen && S.stage) {
    const input = S.stage.refs.padHost.querySelector('textarea');
    if (input) input.focus();
  }
}

function renderPad() {
  if (!S.stage) return;
  const host = S.stage.refs.padHost;
  host.hidden = !S.padOpen;
  clear(host);
  if (!S.padOpen) return;

  const box = el('textarea.textarea', {
    placeholder: 'Park it — you get it back at the end of the block.',
    attrs: { 'aria-label': 'Park a thought', maxlength: '500', rows: '2' },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); park(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); togglePad(); }
    },
  });
  const park = () => {
    const entry = FT.addJot(box.value, S.session ? S.session.id : null);
    if (!entry) return;
    S.session.jots.push(entry);
    box.value = '';
    haptic('tap');
    renderPad();
  };

  host.appendChild(el('div.row',
    icon('pin', { size: 14, cls: 'icon--muted' }),
    el('span.text-meta', { text: 'Distraction pad · ' + S.session.jots.length + ' parked' }),
    el('button.btn.btn-ghost.btn--sm.push', { type: 'button', text: 'Close', onClick: () => togglePad() })));
  host.appendChild(box);
  host.appendChild(el('div.btn-row',
    el('button.btn.btn-secondary.btn--sm', { type: 'button', text: 'Park it', onClick: park })));
  if (S.session.jots.length) {
    host.appendChild(el('div.focus-pad__list',
      ...S.session.jots.slice(-4).reverse().map((j) => el('div.focus-jot',
        icon('pin', { size: 14, cls: 'icon--muted' }),
        el('span.focus-jot__text', { text: j.text })))));
  }
}

/* --- exit + wrap -------------------------------------------------------- */

function requestExit() {
  if (!S.stage) return;
  if (S.session && S.session.final) {           // already wrapped up — just leave
    closeStage();
    renderLobby();
    return;
  }
  if (S.exitArmed) { finishSession(); return; }
  S.exitArmed = true;
  const snap = S.timer.snapshot();
  const banked = snap.focusedSec >= FT.FOCUS_LIMITS.minSessionSec;
  toast(banked
    ? 'End the block? ' + fmt.dur(snap.focusedSec * 1000) + ' is already banked.'
    : 'End the block? ' + Math.max(0, FT.FOCUS_LIMITS.minSessionSec - snap.focusedSec) + ' seconds short of a session that counts.', {
    tone: 'warn',
    timeout: 6000,
    action: { label: 'End it', onClick: () => finishSession() },
  });
  setTimeout(() => { S.exitArmed = false; }, 6000);
}

/**
 * Stop the clock, store the record, show the wrap-up.
 * Idempotent: a second call after the session is already final is a no-op, so
 * Escape-twice / End / onExit can never double-record a block.
 * @param {{silent?:boolean}} [opts] silent = we are being torn down, no UI
 */
function finishSession(opts) {
  const silent = Boolean(opts && opts.silent);
  if (!S.session || !S.timer) { if (!silent) closeStage(); return; }
  if (S.session.final) { if (!silent) { closeStage(); renderLobby(); } return; }
  const snap = S.timer.stop();
  const session = S.session;
  session.final = snap;

  const record = FT.recordSession({
    id: session.id,
    ts: session.startedTs,
    kind: session.kind,
    taskId: session.task.id,
    taskLabel: session.task.label,
    subject: session.task.subject,
    plannedSec: snap.plannedSec,
    focusedSec: snap.focusedSec,
    extendedSec: snap.extendedSec,
    blocks: snap.blocks,
    completed: snap.blocks > 0,
    arousal: session.arousal,
    awaySec: Math.round(S.away.sec),
    awayCount: S.away.count,
    jots: session.jots.length,
    group: session.group,
  });
  session.recordId = record.id;

  releaseWakeLock();
  exitFullscreen();
  endGroupBlock();          // my session is over, so the block I hosted is too
  if (!silent) renderWrap(snap);
  pushRoomPresence(true);
}

function renderWrap(snap) {
  if (!S.stage) return;
  const { refs } = S.stage;
  const session = S.session;
  const counts = snap.focusedSec >= FT.FOCUS_LIMITS.minSessionSec;

  clear(refs.main);
  clear(refs.top);
  refs.top.appendChild(pill('Session over', { icon: 'circle-check', variant: counts ? 'good' : 'neutral' }));
  refs.top.appendChild(el('span.push'));
  refs.top.appendChild(el('button.btn.btn-ghost.btn--sm', {
    type: 'button', attrs: { 'aria-label': 'Close' },
    onClick: () => { handOff(); closeStage(); renderLobby(); },
  }, icon('x', { size: 16 }), el('span', { text: 'Close' })));
  refs.padHost.hidden = true;
  S.padOpen = false;

  refs.main.appendChild(el('div.focus-phase', { text: counts ? 'Banked' : 'Not banked yet' }));
  refs.main.appendChild(el('div.focus-task', {
    text: counts
      ? humanMinutes(snap.focusedSec) + ' on ' + session.task.label
      : 'That ran ' + fmt.dur(snap.focusedSec * 1000),
  }));
  refs.main.appendChild(el('p.focus-sub', {
    text: counts
      ? snap.blocks + ' ' + fmt.plural(snap.blocks, 'block') + ' finished' +
        (snap.extendedSec ? ' · ' + humanMinutes(snap.extendedSec) + ' of that was extra time you asked for' : '')
      : FT.FOCUS_LIMITS.minSessionSec + ' seconds is the floor that counts as a session. One more minute does it.',
  }));

  /* Under two minutes this reports SECONDS. Rounding 47 s up to "1 minutes"
     directly under the line that says "that ran 47s" is the kind of small lie
     that makes every other number on the screen worth less. */
  const mins = Math.round(snap.focusedSec / 60);
  refs.main.appendChild(el('div.focus-statrow',
    snap.focusedSec < 120
      ? statBlock(snap.focusedSec, fmt.plural(snap.focusedSec, 'second'))
      : statBlock(mins, fmt.plural(mins, 'minute')),
    statBlock(snap.blocks, fmt.plural(snap.blocks, 'block')),
    statBlock(session.jots.length, 'parked'),
    S.away.count ? statBlock(fmt.dur(S.away.sec * 1000), 'away') : null));

  if (!counts) {
    refs.main.appendChild(el('div.focus-actions',
      el('button.btn.btn-primary', {
        type: 'button',
        onClick: () => { restartShortBlock(); },
      }, icon('play', { size: 16 }), el('span', { text: 'Give it 90 seconds' }))));
  }

  /* effort — ONE slider + one binary, per pedagogy-spec R10 */
  const slider = el('input.focus-slider', {
    type: 'range', min: '0', max: '100', step: '5',
    value: String(session.effort == null ? 60 : session.effort),
    attrs: { 'aria-label': 'How hard did your brain work' },
  });
  const readout = el('span.focus-stat__v', { text: (session.effort == null ? 60 : session.effort) + '%' });
  slider.addEventListener('input', () => {
    session.effort = Number(slider.value);
    readout.textContent = session.effort + '%';
  });
  session.effort = session.effort == null ? 60 : session.effort;

  const thinkingRow = el('div.segmented', { attrs: { role: 'tablist' } });
  const setThinking = (v) => {
    session.thinking = v;
    for (const b of thinkingRow.children) b.setAttribute('aria-selected', String(b.dataset.v === String(v)));
    haptic('tap');
  };
  for (const opt of [{ v: 'true', label: 'Thinking' }, { v: 'false', label: 'Copying' }]) {
    thinkingRow.appendChild(el('button.segmented__btn', {
      type: 'button', text: opt.label, dataset: { v: opt.v },
      attrs: { role: 'tab', 'aria-selected': 'false' },
      onClick: () => setThinking(opt.v === 'true'),
    }));
  }

  refs.main.appendChild(el('div.card.focus-stage__panel',
    el('div.card__head', el('div.card__title', { text: 'How hard did your brain work?' })),
    el('div.row', slider, readout),
    el('p.text-meta', { text: 'High effort during encoding is the technique working, not a bad session.' }),
    el('div.divider'),
    el('div.card__title', { text: 'Copying or thinking?' }),
    thinkingRow));

  /* parked thoughts come back */
  if (session.jots.length) {
    const listHost = el('div.focus-pad__list');
    const paint = () => {
      clear(listHost);
      for (const j of FT.getJots({ sessionId: session.id })) listHost.appendChild(jotRow(j, paint));
    };
    paint();
    refs.main.appendChild(el('div.card.focus-stage__panel',
      el('div.card__head', el('div.card__title', { text: 'Your parked thoughts' }),
        el('div.card__sub', { text: 'Clear them now so they do not follow you into the next block.' })),
      listHost));
  }

  const route = taskRoute(session.task);
  refs.main.appendChild(el('div.focus-actions',
    el('button.btn.btn-primary.btn--lg', {
      type: 'button',
      onClick: () => { handOff(); closeStage(); navigateTo(route); },
    }, icon('arrow-right', { size: 16 }), el('span', { text: 'Carry on to ' + (FT.KIND_LABELS[session.kind] || 'study') })),
    el('button.btn.btn-secondary', {
      type: 'button', text: 'Bank it and stop',
      onClick: () => { handOff(); closeStage(); renderLobby(); },
    })));
}

function restartShortBlock() {
  const session = S.session;
  closeStage();
  S.starter = freshStarter();
  S.starter.task = session.task;
  S.starter.kind = session.kind;
  S.starter.arousal = session.arousal;
  S.starter.minutes = FT.FOCUS_LIMITS.minMinutes;
  S.starter.step = LADDER.length - 1;
  renderLobby();
}

/** Hand the finished session to game.js exactly once. */
function handOff() {
  const session = S.session;
  if (!session || session.handedOff) return;
  session.handedOff = true;

  const snap = session.final || (S.timer ? S.timer.snapshot() : null);
  const focusedSec = snap ? snap.focusedSec : 0;

  if (session.recordId) {
    FT.writeFocus((state) => {
      state.sessions = state.sessions.map((s) => (s.id === session.recordId
        ? Object.assign({}, s, { effort: session.effort, thinking: session.thinking })
        : s));
      return state;
    });
  }

  if (focusedSec >= FT.FOCUS_LIMITS.minSessionSec) {
    // ONE block = one unit of the declared lane. game.js owns every reward
    // decision from here (rings, attendance, XP) — focus never awards XP for
    // time on the app (pedagogy-spec §4 hard ban).
    callGame('recordActivity', session.kind, {
      source: 'focus',
      count: 1,
      seconds: focusedSec,
      subject: session.task.subject || null,
      unit: session.task.id || null,
      sessionId: session.id,
      minutes: Math.round(focusedSec / 60),
      focusedSec,
      plannedSec: snap ? snap.plannedSec : 0,
      blocks: snap ? snap.blocks : 0,
      completed: Boolean(snap && snap.blocks > 0),
      taskId: session.task.id,
      taskLabel: session.task.label,
      arousal: session.arousal,
      effort: session.effort,
      thinking: session.thinking,
      awaySec: Math.round(S.away.sec),
      awayCount: S.away.count,
      jots: session.jots.length,
      group: session.group,
    });
  }

  emit('engram:focus-end', {
    sessionId: session.id,
    kind: session.kind,
    focusedSec,
    blocks: snap ? snap.blocks : 0,
    effort: session.effort,
    thinking: session.thinking,
    banked: focusedSec >= FT.FOCUS_LIMITS.minSessionSec,
    chatMuted: false,       // the block is over — chat is live again
  });
}

/* --- stage teardown ----------------------------------------------------- */

function closeStage() {
  handOff();
  teardownStage();
  S.session = null;
  if (S.timer) { S.timer.destroy(); S.timer = null; }
  S.starter = freshStarter();
  S.suggestion = FT.sustainableInterval();
  pushRoomPresence();
}

function teardownStage() {
  unwireStageGlobals();
  releaseWakeLock();
  exitFullscreen();
  if (S.stage && S.stage.node) S.stage.node.remove();
  document.documentElement.classList.remove('is-focus-stage');
  S.stage = null;
  S.padOpen = false;
  S.exitArmed = false;
}

/* --- global wiring while the stage is up -------------------------------- */

let stageOffs = [];

function wireStageGlobals() {
  unwireStageGlobals();

  stageOffs.push(on(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || !S.stage) return;
    e.preventDefault();
    e.stopPropagation();
    if (S.padOpen) { togglePad(); return; }
    requestExit();
  }, true));

  stageOffs.push(on(document, 'visibilitychange', () => {
    if (!S.stage) return;
    if (document.hidden) {
      S.away.leftAt = Date.now();
    } else if (S.away.leftAt) {
      const gone = (Date.now() - S.away.leftAt) / 1000;
      S.away.leftAt = 0;
      if (gone > 3) {
        S.away.sec += gone;
        S.away.count += 1;
        toast('Back. ' + fmt.dur(gone * 1000) + ' away — the clock kept running.', { tone: 'info', timeout: 3000 });
      }
      requestWakeLock();
    }
  }));

  const guard = (e) => {
    if (!S.timer || S.timer.phase !== 'running') return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  };
  window.addEventListener('beforeunload', guard);
  stageOffs.push(() => window.removeEventListener('beforeunload', guard));
}

function unwireStageGlobals() {
  for (const off of stageOffs) { try { off(); } catch (_) { /* ignore */ } }
  stageOffs = [];
}

/* --- fullscreen + wake lock (both best-effort; iOS Safari has neither) --- */

function requestFullscreen() {
  try {
    const root = document.documentElement;
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (typeof req === 'function' && !document.fullscreenElement) {
      const out = req.call(root);
      if (out && typeof out.catch === 'function') out.catch(() => { /* denied — the stage still covers everything */ });
    }
  } catch (_) { /* not supported */ }
}

function exitFullscreen() {
  try {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (typeof ex === 'function' && document.fullscreenElement) {
      const out = ex.call(document);
      if (out && typeof out.catch === 'function') out.catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

function requestWakeLock() {
  try {
    if (S.wakeLock || !navigator.wakeLock || !S.stage) return;
    navigator.wakeLock.request('screen')
      .then((lock) => {
        S.wakeLock = lock;
        lock.addEventListener('release', () => { S.wakeLock = null; });
      })
      .catch(() => { S.wakeLock = null; });
  } catch (_) { S.wakeLock = null; }
}

function releaseWakeLock() {
  try { if (S.wakeLock) S.wakeLock.release(); } catch (_) { /* ignore */ }
  S.wakeLock = null;
}

/* ---------------------------------------------------------------------------
   7. STUDY ROOM (Supabase presence; entirely optional)
   ------------------------------------------------------------------------ */

const ROOM_CHANNEL = 'study-room';
const GROUP_BLOCK_MIN = 25;

function roomOffline(reason) {
  return el('div.card.card--quiet',
    el('div.row',
      icon('wifi-off', { size: 16, cls: 'icon--muted' }),
      el('div',
        el('div.card__title', { text: 'Study room is off' }),
        el('p.text-meta', { text: reason }))));
}

function renderRoomCard() {
  const host = S.lobby && S.lobby.roomHost;
  if (!host) return;
  clear(host);

  const room = S.room;
  if (!room || !room.connected) {
    host.appendChild(sectionHead('Study room', 'Everyone’s blocks, side by side'));
    host.appendChild(roomOffline(room && room.reason
      ? room.reason
      : 'Not connected. Solo focus works exactly the same, online or off.'));
    return;
  }

  const members = room.members.slice().sort((a, b) => (a.me ? -1 : b.me ? 1 : String(a.name).localeCompare(String(b.name))));
  const group = activeGroupTimer();

  host.appendChild(sectionHead('Study room',
    members.length + ' ' + fmt.plural(members.length, 'person') + ' here',
    group
      ? el('button.btn.btn-primary.btn--sm', { type: 'button', onClick: () => joinGroupBlock(group) },
        icon('play', { size: 14 }), el('span', { text: 'Join · ' + fmt.clock(groupRemaining(group)) }))
      : el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => startGroupBlock() },
        icon('timer', { size: 14 }), el('span', { text: 'Start a ' + GROUP_BLOCK_MIN + '-min block' }))));

  const grid = el('div.focus-room__grid');
  for (const m of members) grid.appendChild(memberTile(m));
  host.appendChild(el('div.card', grid));
}

function memberTile(m) {
  const rings = m.rings || {};
  const meters = FT.TASK_KINDS.map((kind) => {
    const r = rings[kind] || {};
    const pct = clamp(((Number(r.done) || 0) / Math.max(1, Number(r.goal) || 1)) * 100, 0, 100);
    return el('span.meter.meter--sm', { dataset: { tone: RING_TONES[kind] }, attrs: { title: FT.KIND_LABELS[kind] } },
      el('span.meter__fill', { style: { '--pct': Math.round(pct) } }));
  });
  const initial = String(m.name || '?').trim().charAt(0).toUpperCase() || '?';
  const avatar = el('span.focus-av');
  const src = safeAvatarSrc(m.avatar);
  if (src) avatar.appendChild(el('img', { src, alt: '', attrs: { loading: 'lazy' } }));
  else avatar.textContent = initial;
  return el('div.focus-member', { dataset: { focusing: String(Boolean(m.focusing)) } },
    avatar,
    el('span.focus-member__name.truncate', { text: m.me ? 'You' : String(m.name || 'Someone') }),
    el('span.focus-member__status.truncate', { text: String(m.status || 'In the hub') }),
    el('span.focus-member__rings', ...meters));
}

function renderRoomStrip() {
  if (!S.stage) return;
  const strip = S.stage.refs.roomStrip;
  clear(strip);
  const room = S.room;
  if (!room || !room.connected) return;
  const others = room.members.filter((m) => !m.me);
  if (!others.length) return;
  strip.appendChild(el('span.text-meta', { text: 'With you:' }));
  for (const m of others.slice(0, 8)) {
    const initial = String(m.name || '?').trim().charAt(0).toUpperCase() || '?';
    strip.appendChild(el('span.focus-av', { attrs: { title: m.name + ' · ' + (m.status || '') } }, initial));
  }
  const group = activeGroupTimer();
  if (group) strip.appendChild(pill('Group · ' + fmt.clock(groupRemaining(group)), { icon: 'timer', variant: 'info' }));
}

function collectPresence(value, depth, out) {
  if (!value || depth > 4) return out;
  if (Array.isArray(value)) { for (const v of value) collectPresence(v, depth + 1, out); return out; }
  if (typeof value !== 'object') return out;
  if (value.id || value.name || value.userId) { out.push(value); return out; }
  for (const v of Object.values(value)) collectPresence(v, depth + 1, out);
  return out;
}

function normaliseMembers(payload, myId) {
  const raw = collectPresence(payload, 0, []);
  const byId = new Map();
  for (const r of raw) {
    const id = String(r.id || r.userId || r.key || r.name);
    const prev = byId.get(id);
    if (prev && Number(prev.ts) > Number(r.ts || 0)) continue;
    byId.set(id, {
      id,
      me: myId ? id === String(myId) : Boolean(r.me),
      name: String(r.name || r.displayName || 'Someone').slice(0, 32),
      avatar: r.avatar || null,
      status: String(r.status || 'In the hub').slice(0, 48),
      focusing: Boolean(r.focusing),
      rings: r.rings && typeof r.rings === 'object' ? r.rings : {},
      groupTimer: r.groupTimer && typeof r.groupTimer === 'object' ? r.groupTimer : null,
      ts: Number(r.ts) || 0,
    });
  }
  return Array.from(byId.values());
}

/**
 * The one group block currently running, from any source: mine, the last
 * broadcast I heard, or anyone's presence state. Broadcast is kept as its own
 * slot because "join mid-session" must work in the window BEFORE the starter's
 * presence has re-tracked — otherwise the invitation is dropped on the floor.
 */
function activeGroupTimer() {
  const room = S.room;
  if (!room || !room.connected) return null;
  const now = Date.now();
  let best = null;
  const consider = (g) => {
    if (!g || !g.startedAt || !g.durationSec || g.ended) return;
    if (g.startedAt + g.durationSec * 1000 <= now) return;
    if (!best || g.startedAt < best.startedAt) best = g;
  };
  consider(room.groupTimer);
  consider(room.remoteGroup);
  for (const m of room.members) consider(m.groupTimer);
  return best;
}

/** Stable identity for a group block, so the tick can spot start/end edges. */
function groupKey(g) { return g ? String(g.by) + ':' + g.startedAt : ''; }

function groupRemaining(group) {
  if (!group) return 0;
  return Math.max(0, Math.ceil((group.startedAt + group.durationSec * 1000 - Date.now()) / 1000));
}

/**
 * Bumped on every initRoom() so a connection attempt that is overtaken while
 * awaiting can tell it is stale and clean itself up. app.js mounts a view more
 * than once per navigation, so this runs concurrently in practice — without the
 * token the first attempt leaks a 1-second interval and a live subscription
 * that nothing holds a reference to any more.
 */
let roomGen = 0;

async function initRoom() {
  teardownRoom();
  const gen = ++roomGen;
  const stale = () => gen !== roomGen;

  const sb = sbOf(await loadOptional('sb'));
  if (stale()) return;
  if (!sb || typeof sb.ready !== 'function') {
    S.room = { connected: false, reason: 'Online features are not set up on this build. Solo focus is the whole product here.' };
    renderRoomCard();
    return;
  }
  let ready = false;
  try { ready = Boolean(sb.ready()); } catch (_) { ready = false; }
  if (!ready) {
    S.room = { connected: false, reason: 'No account connected yet. Solo focus works exactly the same.' };
    renderRoomCard();
    return;
  }

  let userId = null;
  let name = null;
  try {
    const u = await Promise.resolve(sb.auth && sb.auth.user ? sb.auth.user() : null);
    const user = u && u.data ? u.data : u;
    if (user) { userId = user.id || user.userId || null; name = user.username || user.email || null; }
  } catch (_) { /* anonymous is fine */ }
  if (stale()) return;

  const profile = store.get(KEYS.PROFILE, {}) || {};
  const room = {
    connected: false,
    channel: null,
    members: [],
    userId: userId || 'local-' + (profile.displayName || 'me'),
    name: profile.displayName || name || 'You',
    avatar: profile.avatar || null,
    groupTimer: null,      // the block I started
    remoteGroup: null,     // the block someone else broadcast
    lastGroupKey: '',
    lastTrack: 0,
    tickId: null,
  };
  S.room = room;

  try {
    const ch = sb.realtime.channel(ROOM_CHANNEL);
    room.channel = ch;
    if (typeof ch.onPresence === 'function') {
      ch.onPresence((payload) => {
        room.members = normaliseMembers(payload, room.userId);
        renderRoomCard();
        renderRoomStrip();
      });
    }
    if (typeof ch.onBroadcast === 'function') {
      ch.onBroadcast('group-timer', (payload) => {
        const p = (payload && payload.payload) || payload || {};
        if (!p.startedAt || !p.durationSec) return;
        const owner = room.members.find((m) => m.id === String(p.by));
        if (owner) owner.groupTimer = p.ended ? null : p;
        if (p.ended) {
          if (groupKey(room.remoteGroup) === groupKey(p)) room.remoteGroup = null;
        } else {
          room.remoteGroup = p;
          if (!S.session) {
            toast('A group block just started · ' + Math.round(p.durationSec / 60) + ' min', {
              tone: 'info',
              action: { label: 'Join', onClick: () => joinGroupBlock(p) },
            });
          }
        }
        room.lastGroupKey = groupKey(activeGroupTimer());
        renderRoomCard();
        renderRoomStrip();
      });
      ch.onBroadcast('celebration', (payload) => {
        const p = (payload && payload.payload) || payload || {};
        confetti();
        toast(String(p.name || 'Someone') + ' — ' + String(p.label || 'chapter banked'), { tone: 'good' });
      });
    }
    const res = await Promise.resolve(ch.subscribe());
    if (stale()) { try { ch.unsubscribe(); } catch (_) { /* ignore */ } return; }
    if (res && res.status && res.status !== 'SUBSCRIBED') {
      throw new Error('channel status ' + res.status);
    }
    room.connected = true;
    await pushRoomPresence(true);
    if (stale()) { try { ch.unsubscribe(); } catch (_) { /* ignore */ } return; }
    /* One second tick, but only while it has something to say. On the EDGE
       where a group block runs out we repaint once more and ring the bell —
       otherwise the card is left frozen on a "Join · 00:00" button. */
    room.tickId = setInterval(() => {
      const g = activeGroupTimer();
      const key = groupKey(g);
      if (key !== room.lastGroupKey) {
        const ending = !g && room.lastGroupKey;
        room.lastGroupKey = key;
        if (ending) {
          chime();
          toast('Group block finished.', { tone: 'good', timeout: 3000 });
        }
      } else if (!g) {
        return;
      }
      renderRoomCard();
      renderRoomStrip();
    }, 1000);
  } catch (err) {
    console.warn('[focus] study room could not connect', err);
    S.room = { connected: false, reason: 'Could not reach the study room. Your block runs the same without it.' };
  }
  renderRoomCard();
  renderRoomStrip();
}

async function pushRoomPresence(force) {
  const room = S.room;
  if (!room || !room.connected || !room.channel || typeof room.channel.track !== 'function') return;
  const now = Date.now();
  if (!force && now - room.lastTrack < 8000) return;
  room.lastTrack = now;

  const rings = (await callGame('getRings')) || {};
  const session = S.session;
  const state = {
    id: room.userId,
    name: room.name,
    avatar: room.avatar,
    focusing: Boolean(session),
    status: session
      ? FT.KIND_LABELS[session.kind] + ' · ' + fmt.truncate(session.task.label, 24)
      : 'In the hub',
    rings,
    groupTimer: room.groupTimer,
    ts: now,
  };
  try { await Promise.resolve(room.channel.track(state)); }
  catch (err) { console.warn('[focus] presence track failed', err); }
}

/** Best-effort broadcast — the documented sb surface only guarantees onBroadcast. */
function tryBroadcast(event, payload) {
  const room = S.room;
  const ch = room && room.channel;
  if (!ch) return false;
  try {
    if (typeof ch.broadcast === 'function') { ch.broadcast(event, payload); return true; }
    if (typeof ch.send === 'function') { ch.send(event, payload); return true; }
  } catch (err) { console.warn('[focus] broadcast failed', err); }
  return false;
}

function startGroupBlock() {
  const room = S.room;
  if (!room || !room.connected) return;
  room.groupTimer = { startedAt: Date.now(), durationSec: GROUP_BLOCK_MIN * 60, by: room.userId };
  room.lastGroupKey = groupKey(room.groupTimer);
  tryBroadcast('group-timer', room.groupTimer);
  pushRoomPresence(true);
  renderRoomCard();
  renderRoomStrip();
  toast('Group block started · ' + GROUP_BLOCK_MIN + ' minutes', { tone: 'good' });
  if (!S.session) joinGroupBlock(room.groupTimer);
}

/** Tell the room the block I started is over. Safe to call when there isn't one. */
function endGroupBlock() {
  const room = S.room;
  if (!room || !room.connected || !room.groupTimer) return;
  tryBroadcast('group-timer', Object.assign({}, room.groupTimer, { ended: true }));
  room.groupTimer = null;
  room.lastGroupKey = groupKey(activeGroupTimer());
  renderRoomCard();
  renderRoomStrip();
}

function joinGroupBlock(group) {
  const remaining = groupRemaining(group);
  if (remaining <= 0) return;
  if (S.session) {
    S.session.group = true;
    toast('You are in the group block · ' + fmt.clock(remaining) + ' left', { tone: 'info' });
    return;
  }
  S.starter = freshStarter();
  S.starter.groupEndsAt = group.startedAt + group.durationSec * 1000;
  S.starter.minutes = FT.clampMinutes(Math.max(FT.FOCUS_LIMITS.minMinutes, Math.round(remaining / 60)));
  renderLobby();
  toast('Group block joined — five taps and you are in.', { tone: 'info' });
}

function teardownRoom() {
  const room = S.room;
  if (!room) return;
  if (room.tickId) clearInterval(room.tickId);
  try { if (room.channel && typeof room.channel.unsubscribe === 'function') room.channel.unsubscribe(); }
  catch (_) { /* ignore */ }
  S.room = null;
}

/** Drop every window-level listener this view owns. Safe to call twice. */
function releaseGlobals() {
  for (const off of S.offs) { try { off(); } catch (_) { /* ignore */ } }
  S.offs = [];
}

/* --- celebration bridge -------------------------------------------------- */

/**
 * A LOCAL celebration has ALREADY burst its own confetti — game.celebrate()
 * and queue-ui's celebrate() both fire before they dispatch the event, and
 * game.js additionally emits its own 'celebration' game event for the same
 * milestone. Adding a burst here would triple-fire on every ring closed and
 * would override a deliberately `silent: true` celebration.
 *
 * So: local celebrations are only CARRIED to the study room from here.
 * Confetti on this screen is for REMOTE ones — a friend's milestone, which
 * nothing else on this device would ever show him (that is the auto-
 * celebration listener the study room spec asks for; see the 'celebration'
 * channel handler in initRoom()).
 */
function wireCelebrations() {
  releaseGlobals();          // idempotent: app.js mounts a view more than once
  S.offs.push(on(window, 'engram:celebration', (e) => {
    const d = (e && e.detail) || {};
    if (!S.room || !S.room.connected) return;
    tryBroadcast('celebration', {
      name: S.room.name,
      label: String(d.label || d.kind || 'chapter banked').slice(0, 120),
    });
  }));
}

/* ---------------------------------------------------------------------------
   8. View module
   ------------------------------------------------------------------------ */

export default {
  id: 'focus',
  title: 'Focus',
  icon: 'timer',

  async render(container) {
    ensureStyles();
    teardownStage();
    S.root = container;
    S.starter = S.starter || freshStarter();
    S.suggestion = FT.sustainableInterval();

    if (!isFeatureEnabled('focus')) {
      container.appendChild(el('div.card',
        el('div.card__title', { text: 'Focus mode is switched off' }),
        el('p.text-meta', { text: 'Turn it back on in Settings when you want the timer back.' })));
      return;
    }

    renderLobby();

    // Everything below is optional and must never block the first paint.
    loadTasks().then((tasks) => {
      S.tasks = tasks;
      if (S.root === container && !S.stage) renderLobby();
    });
    initRoom();
    wireCelebrations();
  },

  onExit() {
    if (S.session) {
      // Navigating away is a legitimate exit — bank the block, never lose it.
      finishSession({ silent: true });
      handOff();
    }
    teardownStage();
    if (S.timer) { S.timer.destroy(); S.timer = null; }
    S.session = null;
    teardownRoom();
    roomGen += 1;              // orphan any in-flight connection attempt
    releaseGlobals();
    S.root = null;
    S.lobby = null;
  },
};
