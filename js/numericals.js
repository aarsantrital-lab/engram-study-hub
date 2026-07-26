/* =============================================================================
   js/numericals.js — the Numericals Engine (pedagogy-spec Tier 0).

   Owner: Job C (numericals / papers / stats). Imports foundation modules only.

   WHAT THIS IS
     Parameterised problem templates -> fresh, physically sensible numbers on
     every attempt -> a SolutionChain the student works through LINE BY LINE,
     each line marked like an examiner marks it: value AND unit, or no mark.

   THE FIVE RULES THIS FILE EXISTS TO ENFORCE
     1. Units on every line. A correct number with no unit scores zero, and the
        student is told exactly which mark that cost (PH-U06).
     2. Backward fading per problemType: scaffoldLevel 0-4, two clean attempts
        to advance, one bad attempt to drop. Worked examples are FORBIDDEN at
        level 4 (expertise reversal — pedagogy-spec §3.2).
     3. Step-level feedback, not answer-level (VanLehn: step feedback is worth
        roughly three times answer-only feedback).
     4. Misconception-tagged distractors: when a wrong answer matches a known
        trap value, he gets that misconception's refutation AND why the wrong
        rule felt right (the anti-relapse step, ECPRC §3.4 step 4).
     5. "Which type is this?" classification on ~1/3 of items — the
        discrimination skill interleaving exists to build (R4).

   NOTATION LAW (build-constraints §5): every number rendered to the student
   goes through formatSig()/fmt.sci(). This file never emits e-notation.

   SAFETY: expressions in template JSON are evaluated by the hand-rolled
   recursive-descent parser below. No eval, no new Function, no CSP holes.
   ========================================================================== */

import {
  el, icon, fmt, toast, haptic, sound, prefersReducedMotion,
  emptyState, eyebrow, clamp,
} from './dom.js';
import { store, KEYS, todayLocalISO, daysFromToday, uid, nowTs } from './store.js';
import { SUBJECT_TOKENS, SUBJECT_ICONS } from './config.js';

/* ---------------------------------------------------------------------------
   1. Constants
   ------------------------------------------------------------------------ */

/** The backward-fading ladder. Level is stored per problemType, per student. */
export const SCAFFOLD_LEVELS = Object.freeze([
  { level: 0, name: 'Worked', blurb: 'Every line is shown. You explain why one of them works, then give the answer.' },
  { level: 1, name: 'Completion', blurb: 'The last line is yours.' },
  { level: 2, name: 'Faded', blurb: 'The last two lines are yours.' },
  { level: 3, name: 'Mostly cold', blurb: 'Only the first line is shown.' },
  { level: 4, name: 'Cold', blurb: 'Nothing is shown. This is exam conditions — no worked example is available at this level.' },
]);

export const SCAFFOLD_MAX = 4;

/** Relative tolerance when marking a value. 1% comfortably accepts 3-s.f. work. */
const VALUE_TOL = 0.01;
/** Slightly wider window for recognising a misconception trap value. */
const TRAP_TOL = 0.015;

/** Reserved sub-keys inside KEYS.NUMERICALS (not problemTypes). */
const RESERVED = ['_mix', '_attempts'];

/** The CDC specification grid the practice mix is measured against. */
export const EXAM_COGNITIVE_MIX = Object.freeze({
  knowledge: 15, understanding: 25, application: 35, higher: 25,
});

const COGNITIVE_ORDER = ['knowledge', 'understanding', 'application', 'higher'];
const COGNITIVE_LABEL = {
  knowledge: 'Knowledge', understanding: 'Understanding',
  application: 'Application', higher: 'Higher ability',
};

/* Directory listings do not exist over HTTP, so template files must be named.
   index.json is the manifest content authors edit; this list is the floor, and
   the two are UNIONed — a stale index.json can never hide a shipped file. */
const DEFAULT_INDEX = ['physics.json', 'chemistry.json', 'maths.json', 'chem-mole.json'];
const DATA_DIR = 'data/numericals/';

/* ---------------------------------------------------------------------------
   2. game.js bridge — game.js is another agent's file and may not exist yet.
      A static import would take the whole view down, so this is lazy + safe.
   ------------------------------------------------------------------------ */

let gameModule;

function loadGame() {
  if (!gameModule) {
    gameModule = import('./game.js')
      .then((m) => (m && m.default && typeof m.default === 'object' ? m.default : m))
      .catch(() => null);
  }
  return gameModule;
}

/** Call a game.js method if the module exists. Never throws, never blocks UI. */
export function gameCall(method, ...args) {
  return loadGame().then((g) => {
    if (g && typeof g[method] === 'function') {
      try { return g[method](...args); } catch (err) { console.warn('[numericals] game.' + method, err); }
    }
    return null;
  }).catch(() => null);
}

/* ---------------------------------------------------------------------------
   3. Seeded randomness — same seed, same paper, every time.
   ------------------------------------------------------------------------ */

/** mulberry32: 32-bit, fast, good enough, and 12 lines. */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A fresh seed for a new attempt. */
export function freshSeed() {
  return (hashString(uid('n') + ':' + nowTs()) >>> 0);
}

/* ---------------------------------------------------------------------------
   4. Numbers — significant figures, and NEVER e-notation.
   ------------------------------------------------------------------------ */

const SUP_MAP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };
const SUP_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g;

/** Round to n significant figures. */
export function toSigFigs(x, sf) {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0) return 0;
  const digits = Math.max(1, Math.round(Number(sf) || 3));
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const p = Math.pow(10, digits - 1 - mag);
  return Math.round(n * p) / p;
}

/** Count the significant figures a student actually wrote. */
export function countSigFigs(text) {
  const t = String(text || '').trim().replace(/[×x*]\s*10\s*\^?\s*[+-]?\d+/i, '').replace(/[eE][+-]?\d+/, '');
  const m = /-?(\d[\d.]*)/.exec(t);
  if (!m) return 0;
  let d = m[1].replace('.', '');
  if (!/\./.test(m[1])) d = d.replace(/0+$/, '');       // trailing zeros in an integer are ambiguous
  d = d.replace(/^0+/, '');
  return d.length || 1;
}

/**
 * Student-facing number. Above 10⁴ or below 10⁻³ it becomes a × 10ⁿ.
 * There is no code path here that can print '1.2e+5'.
 */
export function formatSig(x, sf) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const digits = Math.max(1, Math.round(Number(sf) || 3));
  const abs = Math.abs(n);
  if (abs >= 1e4 || abs < 1e-3) {
    const exp = Math.floor(Math.log10(abs));
    const man = n / Math.pow(10, exp);
    return fmt.sci(trimTrailing(man.toFixed(digits - 1)), exp);
  }
  const v = toSigFigs(n, digits);
  // intDigits goes <= 0 once |v| < 1 — one lower for every leading zero after
  // the point — so 0.041666 at 3 s.f. keeps "0.0417". Do NOT clamp this to a
  // minimum of 1: that silently drops real digits across the whole [1e-3, 1)
  // band and prints a model answer outside VALUE_TOL of answer.value.
  const intDigits = Math.floor(Math.log10(Math.abs(v))) + 1;
  const dec = clamp(digits - intDigits, 0, 8);
  return v.toFixed(dec);
}

/** Natural formatting for a template's substituted variable (trims 2.50 -> 2.5). */
export function formatVar(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e5 || abs < 1e-3) {
    const exp = Math.floor(Math.log10(abs));
    return fmt.sci(trimTrailing((n / Math.pow(10, exp)).toFixed(3)), exp);
  }
  return trimTrailing(n.toFixed(4));
}

function trimTrailing(s) {
  return String(s).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/* ---------------------------------------------------------------------------
   5. Expression evaluator — hand-rolled, no eval.
      grammar: expr := term (('+'|'-') term)*
               term := power (('*'|'/') power)*
               power:= unary ('^' power)?          (right associative)
               unary:= ('+'|'-') unary | primary
               primary := number | ident '(' args ')' | ident | '(' expr ')'
   ------------------------------------------------------------------------ */

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, exp: Math.exp,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
  rad: (d) => (d * Math.PI) / 180, deg: (r) => (r * 180) / Math.PI,
};

const BASE_CONSTANTS = Object.freeze({
  pi: Math.PI, PI: Math.PI, E: Math.E,
  g: 9.8, G: 6.67e-11, c_light: 3e8,
  R_gas: 8.314, NA: 6.022e23, N_A: 6.022e23,
  h_planck: 6.626e-34, k_B: 1.38e-23, e_charge: 1.6e-19, F_faraday: 96500,
  Vm_stp: 22.4, atm: 101325,
});

function tokenize(src) {
  const out = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new Error('bad number at ' + i);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') { out.push({ t: 'rel', v: two }); i += 2; continue; }
    if (ch === '>' || ch === '<') { out.push({ t: 'rel', v: ch }); i += 1; continue; }
    if ('+-*/^(),'.includes(ch)) { out.push({ t: ch }); i += 1; continue; }
    throw new Error('unexpected character "' + ch + '"');
  }
  return out;
}

/**
 * Evaluate an arithmetic expression against a scope object.
 * @param {string} src
 * @param {Object} scope variable name -> number
 * @returns {number} NaN when the expression cannot be evaluated
 */
export function evalExpr(src, scope) {
  if (src === null || src === undefined || src === '') return NaN;
  let toks;
  /* Template authors reach for JS out of habit and write Math.pow(10, 23).
     Every Math.* name we support already exists bare in FUNCS/BASE_CONSTANTS,
     so drop the prefix rather than fail a whole problem over punctuation. */
  const cleaned = String(src).replace(/\bMath\s*\.\s*/g, '');
  try { toks = tokenize(cleaned); } catch (err) { return NaN; }
  let p = 0;
  const vars = Object.assign({}, BASE_CONSTANTS, scope || {});

  const peek = () => toks[p];
  const eat = (t) => { if (toks[p] && toks[p].t === t) { p += 1; return true; } return false; };

  /* Lowest precedence: a single comparison, yielding 1 or 0. This is what
     `constraints` are written in ("F > mu*m*9.8 + 4"); a template that wants a
     plain value simply never uses a relational operator. */
  function parseCompare() {
    const left = parseExpr();
    const tk = peek();
    if (!tk || tk.t !== 'rel') return left;
    p += 1;
    const right = parseExpr();
    switch (tk.v) {
      case '>': return left > right ? 1 : 0;
      case '<': return left < right ? 1 : 0;
      case '>=': return left >= right ? 1 : 0;
      case '<=': return left <= right ? 1 : 0;
      case '==': return Math.abs(left - right) < 1e-9 ? 1 : 0;
      case '!=': return Math.abs(left - right) >= 1e-9 ? 1 : 0;
      default: return NaN;
    }
  }

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      if (eat('+')) v += parseTerm();
      else if (eat('-')) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      if (eat('*')) v *= parseUnary();
      else if (eat('/')) v /= parseUnary();
      else return v;
    }
  }
  /* Unary minus binds LOOSER than '^', as every maths and physics text writes
     it: -3^2 is -(3^2) = -9, never (-3)^2 = 9. A template author writing
     "-b^2/(4*a)" gets the sign the textbook gives, and the exponent still takes
     a unary on its right so 2^-3 keeps working. */
  function parseUnary() {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    if (eat('^')) return Math.pow(base, parseUnary());   // right-associative
    return base;
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('unexpected end');
    if (tk.t === 'num') { p += 1; return tk.v; }
    if (tk.t === 'id') {
      p += 1;
      if (eat('(')) {
        const args = [];
        if (!eat(')')) {
          do { args.push(parseExpr()); } while (eat(','));
          if (!eat(')')) throw new Error('missing )');
        }
        const fn = FUNCS[tk.v];
        if (!fn) throw new Error('unknown function ' + tk.v);
        return fn.apply(null, args);
      }
      if (Object.prototype.hasOwnProperty.call(vars, tk.v)) return Number(vars[tk.v]);
      throw new Error('unknown name ' + tk.v);
    }
    if (eat('(')) {
      const v = parseCompare();
      if (!eat(')')) throw new Error('missing )');
      return v;
    }
    throw new Error('unexpected token');
  }

  try {
    const v = parseCompare();
    if (p !== toks.length) return NaN;
    return Number.isFinite(v) ? v : NaN;
  } catch (err) {
    return NaN;
  }
}

/* ---------------------------------------------------------------------------
   6. Units — parse, normalise, compare, and display as a student would write it.
   ------------------------------------------------------------------------ */

const WORD_ALIASES = {
  sec: 's', secs: 's', second: 's', seconds: 's',
  metre: 'm', metres: 'm', meter: 'm', meters: 'm',
  gram: 'g', grams: 'g', gm: 'g', gms: 'g',
  kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  litre: 'L', litres: 'L', liter: 'L', liters: 'L',
  newton: 'N', newtons: 'N',
  joule: 'J', joules: 'J',
  watt: 'W', watts: 'W',
  pascal: 'Pa', pascals: 'Pa',
  mole: 'mol', moles: 'mol', mols: 'mol',
  ampere: 'A', amperes: 'A', amp: 'A', amps: 'A',
  volt: 'V', volts: 'V',
  ohm: 'Ω', ohms: 'Ω',
  coulomb: 'C', coulombs: 'C',
  hertz: 'Hz',
  kelvin: 'K',
  degc: '°C', celsius: '°C', c: '°C',
  percent: '%',
};

/* NEB students routinely write ms⁻¹ for m s⁻¹. Split the common run-ons so the
   marking is about physics, not about spacing. */
const COMPOUND_SPLITS = {
  ms: 'm s', kgms: 'kg m s', kgm: 'kg m', Nm: 'N m', Nkg: 'N kg',
  Jkg: 'J kg', JK: 'J K', Jmol: 'J mol', JKmol: 'J K mol',
  moldm: 'mol dm', molL: 'mol L', moldm3: 'mol dm^3',
  Wm: 'W m', WmK: 'W m K', Vm: 'V m', Pam: 'Pa m', gmol: 'g mol',
  Nm2kg: 'N m^2 kg',
};

/** '⁻¹' -> '^-1', '×' -> '*', '·' -> ' ' etc. Shared by units and quantities. */
export function normaliseTypography(text) {
  return String(text == null ? '' : text)
    .replace(SUP_RE, (run) => '^' + run.split('').map((c) => SUP_MAP[c] || c).join(''))
    .replace(/[×✕✖]/g, '*')
    .replace(/[·⋅•]/g, ' ')
    .replace(/[–—−]/g, '-')
    .replace(/µ/g, 'μ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical signature for a unit string. 'm/s' and 'm s^-1' and 'ms⁻¹' all
 * become 'm^1|s^-1'. '' (dimensionless) becomes ''.
 * @param {string} raw
 * @returns {string}
 */
export function normaliseUnit(raw) {
  const src = normaliseTypography(raw).replace(/\((no unit|none|dimensionless|unitless)\)/gi, '');
  if (!src) return '';
  const parts = src.split('/');
  const terms = new Map();

  parts.forEach((part, partIdx) => {
    const sign = partIdx === 0 ? 1 : -1;
    for (const rawTok of part.split(/[\s*]+/)) {
      let tok = rawTok.trim();
      if (!tok || tok === '1') continue;
      let exp = 1;
      const caret = tok.indexOf('^');
      if (caret >= 0) {
        exp = Number(tok.slice(caret + 1)) || 0;
        tok = tok.slice(0, caret);
      } else {
        const trail = /^([A-Za-zΩ°μ%]+)(\d+)$/.exec(tok);   // dm3 -> dm^3
        if (trail) { tok = trail[1]; exp = Number(trail[2]); }
      }
      if (!tok) continue;

      const alias = WORD_ALIASES[tok.toLowerCase()];
      if (alias && tok.length > 1) tok = alias;
      else if (tok === 'l') tok = 'L';

      const split = COMPOUND_SPLITS[tok];
      const syms = split ? split.split(' ') : [tok];
      syms.forEach((sym, k) => {
        let s = sym;
        let e = k === syms.length - 1 ? exp : 1;
        const inner = /^([A-Za-zΩ°μ%]+)\^?(-?\d+)$/.exec(s);
        if (inner) { s = inner[1]; e = Number(inner[2]) * (k === syms.length - 1 ? Math.sign(exp) || 1 : 1); }
        terms.set(s, (terms.get(s) || 0) + sign * e);
      });
    }
  });

  const out = [];
  for (const [sym, exp] of terms) if (exp !== 0) out.push(sym + '^' + exp);
  out.sort();
  return out.join('|');
}

/** Render a unit the way it should appear on his answer sheet: 'm s⁻¹'. */
export function displayUnit(raw) {
  const src = normaliseTypography(raw);
  if (!src) return '';
  return src
    .replace(/\^\s*([+-]?\d+)/g, (_m, d) => fmt.sup(d))
    .replace(/\s*\*\s*/g, ' ');
}

/**
 * Parse a student's line into a value and a unit.
 * Accepts '4.5 m/s', '4.5 ms⁻¹', '1.2 × 10³ N', '1.2e3 N', '-9.8 m s^-2'.
 * @returns {{ok:boolean, value:number, unit:string, hasUnit:boolean, raw:string, reason:string}}
 */
export function parseQuantity(input) {
  const raw = String(input == null ? '' : input);
  const s = normaliseTypography(raw);
  const base = { ok: false, value: NaN, unit: '', hasUnit: false, raw, reason: '' };
  if (!s) return Object.assign(base, { reason: 'empty' });

  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(?:(?:[*x]\s*10\s*\^?\s*([+-]?\d+))|(?:[eE]\s*([+-]?\d+)))?\s*(.*)$/.exec(s);
  if (!m) return Object.assign(base, { reason: 'no-number' });

  let value = Number(m[1]);
  if (!Number.isFinite(value)) return Object.assign(base, { reason: 'no-number' });
  const exp = m[2] !== undefined ? Number(m[2]) : (m[3] !== undefined ? Number(m[3]) : null);
  if (exp !== null && Number.isFinite(exp)) value *= Math.pow(10, exp);

  const tail = String(m[4] || '').trim().replace(/^[=:]\s*/, '');
  const dimensionless = /^\(?\s*(no unit|none|unitless|dimensionless)\s*\)?$/i.test(tail);
  return {
    ok: true,
    value,
    unit: dimensionless ? '' : tail,
    hasUnit: !dimensionless && tail.length > 0,
    raw,
    reason: '',
  };
}

/** Two values agree within the marking tolerance. */
export function valuesAgree(a, b, tol) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const t = tol === undefined ? VALUE_TOL : tol;
  if (y === 0) return Math.abs(x) < 1e-9;
  return Math.abs(x - y) / Math.abs(y) <= t;
}

/* ---------------------------------------------------------------------------
   7. TeX-lite -> student-facing plain text.
      No KaTeX ships (zero external origins), and a raw '\frac{1}{2}' on screen
      is worse than nothing. This converts the handful of forms templates use.
   ------------------------------------------------------------------------ */

const TEX_SYMBOLS = {
  '\\times': '×', '\\cdot': '·', '\\pm': '±', '\\mp': '∓', '\\div': '÷',
  '\\Delta': 'Δ', '\\delta': 'δ', '\\rho': 'ρ', '\\mu': 'μ', '\\theta': 'θ',
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\lambda': 'λ', '\\pi': 'π',
  '\\omega': 'ω', '\\Omega': 'Ω', '\\sigma': 'σ', '\\phi': 'φ', '\\epsilon': 'ε',
  '\\approx': '≈', '\\neq': '≠', '\\leq': '≤', '\\geq': '≥', '\\infty': '∞',
  '\\left': '', '\\right': '', '\\,': ' ', '\\;': ' ', '\\!': '',
};

/** Read the balanced {...} group starting at index i. Returns null if absent. */
function readBrace(s, i) {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let k = i; k < s.length; k += 1) {
    if (s[k] === '{') depth += 1;
    else if (s[k] === '}') {
      depth -= 1;
      if (depth === 0) return { body: s.slice(i + 1, k), end: k + 1 };
    }
  }
  return null;
}

/**
 * Walk TeX once, recursing into balanced groups. A regex cannot do this: the
 * quadratic formula nests a \sqrt inside a \frac, and a non-recursive \frac
 * pattern silently drops the whole fraction — which put "x = -b ± √(Δ)2a" on
 * screen, a wrong formula, which is worse than no formula at all.
 */
function texScan(src) {
  let out = '';
  let i = 0;
  const skipSpace = () => { while (src[i] === ' ') i += 1; };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
      if (m) {
        const name = m[1];
        i += m[0].length;

        if (name === 'frac' || name === 'tfrac' || name === 'dfrac') {
          skipSpace();
          const a = readBrace(src, i);
          if (!a) continue;
          i = a.end; skipSpace();
          const b = readBrace(src, i);
          if (!b) continue;
          i = b.end;
          const num = texScan(a.body);
          const den = texScan(b.body);
          out += (num === '1' && den === '2') ? '½' : '(' + num + ')/(' + den + ')';
          continue;
        }

        if (name === 'sqrt') {
          let root = '';
          if (src[i] === '[') {
            const close = src.indexOf(']', i);
            if (close > 0) { root = src.slice(i + 1, close); i = close + 1; }
          }
          const a = readBrace(src, i);
          if (a) { i = a.end; out += (root ? fmt.sup(root) : '') + '√(' + texScan(a.body) + ')'; }
          else out += '√';
          continue;
        }

        const sym = TEX_SYMBOLS['\\' + name];
        out += sym === undefined ? '' : sym;        // unknown command: drop it
        continue;
      }

      /* Backslash before punctuation: \% \$ \& \# \_ \{ \} and the spacing
         commands \, \; \! \\ . Un-escape rather than leak the backslash. */
      const nxt = src[i + 1];
      i += 2;
      if (nxt === undefined) continue;
      if (nxt === ',' || nxt === ';' || nxt === ':' || nxt === '\\') { out += ' '; continue; }
      if (nxt === '!') continue;
      out += nxt;
      continue;
    }

    if (ch === '^' || ch === '_') {
      i += 1;
      skipSpace();
      const g = readBrace(src, i);
      let body = null;
      if (g) { body = texScan(g.body); i = g.end; }
      else {
        const m2 = /^[+-]?[A-Za-z0-9]/.exec(src.slice(i));
        if (m2) { body = m2[0]; i += m2[0].length; }
      }
      if (body !== null) out += ch === '^' ? fmt.sup(body) : fmt.sub(body);
      continue;
    }

    if (ch === '{' || ch === '}' || ch === '$') { i += 1; continue; }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * '\tfrac{1}{2}mv^2' -> '½mv²'. Good enough to read, and it NEVER shows a
 * backslash — no KaTeX ships (zero external origins) and raw TeX on screen is
 * noise to a student who has never seen it.
 */
export function texToText(tex) {
  return texScan(String(tex || ''))
    .replace(/\\/g, '')          // belt and braces: nothing escapes with a backslash
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------------------------
   8. Template loading
   ------------------------------------------------------------------------ */

let templateCache = null;
let loadPromise = null;
let templateIssues = [];

function url(path) {
  try { return new URL(path, document.baseURI).href; } catch (_) { return path; }
}

async function fetchJSON(path) {
  const res = await fetch(url(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
  return res.json();
}

/**
 * Load every numericals template. Cached for the life of the page.
 * Missing files are skipped with a console warning, never a thrown error —
 * a half-populated engine still beats a dead screen.
 * @returns {Promise<Array>}
 */
export function loadTemplates(opts) {
  if (opts && opts.force) { templateCache = null; loadPromise = null; }
  if (templateCache) return Promise.resolve(templateCache);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let files = DEFAULT_INDEX.slice();
    try {
      const idx = await fetchJSON(DATA_DIR + 'index.json');
      if (idx && Array.isArray(idx.files)) {
        for (const f of idx.files) if (typeof f === 'string' && !files.includes(f)) files.push(f);
      }
    } catch (err) {
      console.warn('[numericals] index.json unavailable, using the built-in list', err);
    }

    const seen = new Set();
    const all = [];
    for (const file of files) {
      try {
        const raw = await fetchJSON(DATA_DIR + file);
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.templates) ? raw.templates : []);
        const subject = raw && raw.subject ? raw.subject : null;
        for (const t of list) {
          const tpl = normaliseTemplate(t, subject, file);
          if (!tpl) continue;
          if (seen.has(tpl.id)) {          // two files claiming one id: first wins, loudly
            console.warn('[numericals] duplicate template id "' + tpl.id + '" in ' + file + ' — ignored');
            continue;
          }
          seen.add(tpl.id);
          all.push(tpl);
        }
      } catch (err) {
        console.warn('[numericals] could not load ' + file, err);
      }
    }
    /* FAIL CLOSED. A template whose answer cannot be evaluated would be served
       as a problem whose model answer renders '—', marking a correct student
       wrong every time. Drop it here instead, and keep the reason so the UI can
       show it rather than burying it in a console nobody opens. */
    templateCache = all;
    templateIssues = [];
    const usable = [];
    for (const tpl of all) {
      const probe = instantiate(tpl, { seed: 1, classify: false });
      if (!probe || !Number.isFinite(probe.answer.value)) {
        const why = 'answer.expr "' + ((tpl.answer && tpl.answer.expr) || '(missing)') + '" does not evaluate';
        templateIssues.push({ id: tpl.id, file: tpl.source, reason: why });
        console.warn('[numericals] template "' + tpl.id + '" in ' + tpl.source + ' dropped — ' + why);
        continue;
      }
      usable.push(tpl);
    }
    templateCache = usable;
    return usable;
  })();

  return loadPromise;
}

/** [{id,file,reason}] — templates that failed validation and are not served. */
export function templateWarnings() {
  return templateIssues.slice();
}

function normaliseTemplate(t, subjectFallback, file) {
  if (!t || typeof t !== 'object' || !t.id || !t.template) return null;
  const chain = Array.isArray(t.solutionChain) ? t.solutionChain : [];
  return {
    id: String(t.id),
    subject: String(t.subject || subjectFallback || 'Physics'),
    unit: String(t.unit || ''),
    problemType: String(t.problemType || t.id),
    problemTypeLabel: String(t.problemTypeLabel || t.problemType || t.id),
    cognitive: COGNITIVE_ORDER.includes(t.cognitive) ? t.cognitive : 'application',
    template: String(t.template),
    vars: t.vars && typeof t.vars === 'object' ? t.vars : {},
    picks: t.picks && typeof t.picks === 'object' ? t.picks : {},
    constants: t.constants && typeof t.constants === 'object' ? t.constants : {},
    constraints: Array.isArray(t.constraints) ? t.constraints : [],
    solutionChain: chain,
    answer: t.answer && typeof t.answer === 'object' ? t.answer : null,
    difficulty: clamp(Number(t.difficulty) || 2, 1, 3),
    misconceptionTags: Array.isArray(t.misconceptionTags) ? t.misconceptionTags : [],
    misconceptions: Array.isArray(t.misconceptions) ? t.misconceptions : [],
    confusableWith: Array.isArray(t.confusableWith) ? t.confusableWith : [],
    source: file || null,
  };
}

/** Synchronous access after loadTemplates() has resolved. */
export function getTemplates(filter) {
  const all = templateCache || [];
  if (!filter) return all.slice();
  return all.filter((t) => {
    if (filter.subject && t.subject !== filter.subject) return false;
    if (filter.unit && t.unit !== filter.unit) return false;
    if (filter.problemType && t.problemType !== filter.problemType) return false;
    if (filter.id && t.id !== filter.id) return false;
    if (filter.maxDifficulty && t.difficulty > filter.maxDifficulty) return false;
    return true;
  });
}

export function getTemplate(id) {
  return (templateCache || []).find((t) => t.id === id) || null;
}

/** Distinct subjects present in the loaded template set. */
export function templateSubjects() {
  const out = [];
  for (const t of templateCache || []) if (!out.includes(t.subject)) out.push(t.subject);
  return out;
}

/** [{problemType, label, subject, unit, count}] — one row per drillable type. */
export function problemTypes(subject) {
  const map = new Map();
  for (const t of templateCache || []) {
    if (subject && t.subject !== subject) continue;
    const cur = map.get(t.problemType);
    if (cur) cur.count += 1;
    else map.set(t.problemType, { problemType: t.problemType, label: t.problemTypeLabel, subject: t.subject, unit: t.unit, count: 1 });
  }
  return Array.from(map.values());
}

/* ---------------------------------------------------------------------------
   8b. Exam calendar. It lives in this module because numericals.js is the only
       non-view file this job owns, and both papers.js and stats.js need it.
       Every seeded date is an ESTIMATE until Hermes confirms the real VAC
       timetable in week 1 — the UI must always say so.
   ------------------------------------------------------------------------ */

let calendarCache = null;
let calendarPromise = null;

/**
 * @returns {Promise<{events:Array, confirmedBy:string|null, note:string}>}
 *          events: {id,label,bs,ad,confidence,phase,subjects[],detail,daysAway}
 */
export function loadExamCalendar(opts) {
  if (opts && opts.force) { calendarCache = null; calendarPromise = null; }
  if (calendarCache) return Promise.resolve(calendarCache);
  if (calendarPromise) return calendarPromise;

  calendarPromise = fetchJSON('data/examCalendar.json')
    .then((raw) => {
      const events = (raw && Array.isArray(raw.events) ? raw.events : [])
        .filter((e) => e && typeof e.ad === 'string')
        .map((e) => Object.assign({}, e, {
          confidence: e.confidence === 'confirmed' ? 'confirmed' : 'estimate',
          subjects: Array.isArray(e.subjects) ? e.subjects : [],
        }))
        .sort((a, b) => (a.ad < b.ad ? -1 : a.ad > b.ad ? 1 : 0));
      calendarCache = { events, confirmedBy: (raw && raw.confirmedBy) || null, note: (raw && raw.note) || '' };
      /* game.js loads the same file itself and owns its own cache — pushing rows
         in from here would race it, so this module only reads. */
      return calendarCache;
    })
    .catch((err) => {
      console.warn('[numericals] examCalendar.json unavailable', err);
      calendarCache = { events: [], confirmedBy: null, note: '' };
      return calendarCache;
    });

  return calendarPromise;
}

/**
 * Days until the next event that covers `subject` (null = any).
 * Day arithmetic goes through store.js's LOCAL helpers — Nepal is UTC+05:45 and
 * a toISOString() day here would be wrong for 5 hours 45 minutes every night.
 */
export function daysToNextExam(subject) {
  const cal = calendarCache;
  if (!cal || !cal.events.length) return null;
  let best = null;
  for (const e of cal.events) {
    if (subject && e.subjects.length && !e.subjects.includes(subject)) continue;
    const d = daysFromToday(e.ad);
    if (d >= 0 && (best === null || d < best.days)) best = { days: d, event: e };
  }
  return best;
}

/* ---------------------------------------------------------------------------
   9. Instantiation — fresh, integer-friendly, physically sensible numbers.
   ------------------------------------------------------------------------ */

function drawVar(spec, rng) {
  const min = Number(spec.min);
  const max = Number(spec.max);
  const step = Number(spec.step) || 1;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return min || 0;
  const n = Math.max(0, Math.round((max - min) / step));
  const k = Math.floor(rng() * (n + 1));
  const v = min + k * step;
  // step can be fractional (0.5, 0.05) — kill float dust like 2.4000000000000004
  return Number(v.toFixed(6));
}

/**
 * Turn a template into a concrete problem with fresh numbers.
 * @param {Object} template
 * @param {{seed?:number, scaffoldLevel?:number, classify?:boolean}} [opts]
 */
export function instantiate(template, opts) {
  const o = opts || {};
  const tpl = typeof template === 'string' ? getTemplate(template) : template;
  if (!tpl) return null;

  const seed = Number.isFinite(Number(o.seed)) ? Number(o.seed) : freshSeed();
  const rng = makeRng(seed);

  /* Draw until BOTH hold:
       (a) every declared physical constraint is satisfied, and
       (b) no misconception trap lands on the correct answer.
     (b) is enforced here rather than left to template authors: a trap whose
     value equals the right answer would mark a correct student wrong, and it
     is the kind of collision that only shows up for particular numbers. */
  let values = {};
  let scope = {};
  let picks = {};
  let ansScopeDraft = null;
  let attempts = 0;
  let okConstraints = false;
  let okTraps = false;

  do {
    attempts += 1;
    values = {};
    for (const [name, spec] of Object.entries(tpl.vars)) values[name] = drawVar(spec, rng);
    scope = Object.assign({}, tpl.constants, values);
    picks = {};
    for (const [name, list] of Object.entries(tpl.picks)) {
      if (Array.isArray(list) && list.length) picks[name] = list[Math.floor(rng() * list.length)];
    }

    okConstraints = tpl.constraints.every((c) => evalExpr(c, scope) > 0);
    if (!okConstraints) { okTraps = false; continue; }

    ansScopeDraft = Object.assign({}, scope);
    let prev = [];
    tpl.solutionChain.forEach((raw, i) => {
      const sc = Object.assign({}, scope);
      prev.forEach((v, k) => { if (Number.isFinite(v)) sc['s' + (k + 1)] = v; });
      const val = raw.kind === 'given' || !raw.expr ? NaN : evalExpr(raw.expr, sc);
      prev.push(val);
      if (Number.isFinite(val)) ansScopeDraft['s' + (i + 1)] = val;
    });
    const draftAnswer = evalExpr(tpl.answer && tpl.answer.expr, ansScopeDraft);
    okTraps = !Number.isFinite(draftAnswer) || tpl.misconceptions.every((mc) => {
      const v = evalExpr(mc.trap, ansScopeDraft);
      return !Number.isFinite(v) || !valuesAgree(v, draftAnswer, TRAP_TOL);
    });
  } while (attempts < 120 && !(okConstraints && okTraps));

  if (!okConstraints && tpl.constraints.length) {
    console.warn('[numericals] "' + tpl.id + '" could not satisfy its constraints in ' + attempts + ' draws — widen the var ranges.');
  } else if (!okTraps) {
    console.warn('[numericals] "' + tpl.id + '" could not find numbers where every trap differs from the answer — one trap will be suppressed.');
  }

  const subst = (text) => substitute(text, scope, picks);

  // --- solution chain -------------------------------------------------------
  const steps = [];
  tpl.solutionChain.forEach((raw, i) => {
    const stepScope = Object.assign({}, scope);
    for (let k = 0; k < steps.length; k += 1) {
      if (Number.isFinite(steps[k].value)) stepScope['s' + (k + 1)] = steps[k].value;
    }
    const hasExpr = raw.expr !== undefined && raw.expr !== null && raw.expr !== '' && raw.kind !== 'given';
    const value = hasExpr ? evalExpr(raw.expr, stepScope) : NaN;
    const sf = Number(raw.sigfigs) || 3;
    const unit = raw.unit === undefined || raw.unit === null ? '' : String(raw.unit);
    steps.push({
      index: i,
      number: i + 1,
      kind: raw.kind === 'given' ? 'given' : 'work',
      checkable: hasExpr && Number.isFinite(value),
      statement: subst(raw.statement || ''),
      justification: subst(raw.justification || ''),
      formula: raw.formulaTeX ? texToText(raw.formulaTeX) : '',
      prompt: raw.prompt ? subst(raw.prompt) : '',
      value,
      unit,
      unitSig: normaliseUnit(unit),
      unitDisplay: displayUnit(unit),
      dimensionless: raw.dimensionless === true || normaliseUnit(unit) === '',
      sigfigs: sf,
      display: hasExpr && Number.isFinite(value) ? formatSig(value, sf) : '',
    });
  });

  // --- final answer ---------------------------------------------------------
  const ansScope = Object.assign({}, scope);
  steps.forEach((s, k) => { if (Number.isFinite(s.value)) ansScope['s' + (k + 1)] = s.value; });
  const a = tpl.answer || {};
  const ansValue = evalExpr(a.expr, ansScope);
  const ansSf = Number(a.sigfigs) || 3;
  const ansUnit = a.unit === undefined || a.unit === null ? '' : String(a.unit);
  const answer = {
    value: ansValue,
    unit: ansUnit,
    unitSig: normaliseUnit(ansUnit),
    unitDisplay: displayUnit(ansUnit),
    dimensionless: a.dimensionless === true || normaliseUnit(ansUnit) === '',
    sigfigs: ansSf,
    label: subst(a.label || 'final answer'),
    display: formatSig(ansValue, ansSf),
  };

  // --- misconception traps (a trap sitting on the right answer is dropped) --
  const traps = tpl.misconceptions.map((mc) => ({
    id: String(mc.id || 'MC'),
    value: evalExpr(mc.trap, ansScope),
    statement: subst(mc.statement || ''),
    feedback: subst(mc.feedback || ''),
    whyItFeelsRight: subst(mc.whyItFeelsRight || ''),
  })).filter((mc) => Number.isFinite(mc.value) && !valuesAgree(mc.value, ansValue, TRAP_TOL));

  // --- 'which type is this?' on ~1/3 of items -------------------------------
  const wantClassify = o.classify === undefined ? (hashString(tpl.id + ':' + seed) % 3 === 0) : Boolean(o.classify);
  const classify = wantClassify ? buildClassify(tpl, rng) : null;

  const scaffoldLevel = o.scaffoldLevel === undefined
    ? getScaffoldLevel(tpl.problemType)
    : clamp(Math.round(o.scaffoldLevel), 0, SCAFFOLD_MAX);

  return {
    id: uid('prob'),
    templateId: tpl.id,
    seed,
    subject: tpl.subject,
    unit: tpl.unit,
    problemType: tpl.problemType,
    problemTypeLabel: tpl.problemTypeLabel,
    cognitive: tpl.cognitive,
    difficulty: tpl.difficulty,
    text: subst(tpl.template),
    values,
    picks,
    steps,
    answer,
    traps,
    classify,
    scaffoldLevel,
    misconceptionTags: tpl.misconceptionTags.slice(),
  };
}

/** Substitute {name} — evaluated as an expression, so {m1+m2} works too. */
function substitute(text, scope, picks) {
  return String(text || '').replace(/\{([^{}]+)\}/g, (whole, body) => {
    const key = body.trim();
    if (picks && Object.prototype.hasOwnProperty.call(picks, key)) return String(picks[key]);
    const v = evalExpr(key, scope);
    return Number.isFinite(v) ? formatVar(v) : whole;
  });
}

function buildClassify(tpl, rng) {
  const pool = new Set();
  for (const p of tpl.confusableWith) pool.add(p);
  for (const other of templateCache || []) {
    if (other.subject === tpl.subject && other.problemType !== tpl.problemType) pool.add(other.problemType);
  }
  const labelOf = (pt) => {
    const hit = (templateCache || []).find((t) => t.problemType === pt);
    return hit ? hit.problemTypeLabel : humanise(pt);
  };
  const distractors = Array.from(pool).filter((p) => p !== tpl.problemType);
  // deterministic shuffle
  for (let i = distractors.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = distractors[i]; distractors[i] = distractors[j]; distractors[j] = tmp;
  }
  const chosen = distractors.slice(0, 3);
  if (!chosen.length) return null;
  const options = chosen.map((p) => ({ problemType: p, label: labelOf(p), correct: false }));
  options.push({ problemType: tpl.problemType, label: tpl.problemTypeLabel, correct: true });
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = options[i]; options[i] = options[j]; options[j] = tmp;
  }
  return { question: 'Before you calculate anything — which type of problem is this?', options };
}

function humanise(s) {
  return String(s).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Pick a set of problems with no two adjacent items sharing a problemType
 * (R4: interleave WITHIN a subject, by type).
 * @param {{subject?:string, unit?:string, count?:number, seed?:number}} [opts]
 */
export function pickProblems(opts) {
  const o = opts || {};
  const count = clamp(Math.round(Number(o.count) || 5), 1, 25);
  const pool = getTemplates({ subject: o.subject, unit: o.unit });
  if (!pool.length) return [];
  const rng = makeRng(Number.isFinite(Number(o.seed)) ? Number(o.seed) : freshSeed());

  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
  }

  const ordered = [];
  const remaining = shuffled.slice();
  while (ordered.length < count && remaining.length) {
    const lastType = ordered.length ? ordered[ordered.length - 1].problemType : null;
    let idx = remaining.findIndex((t) => t.problemType !== lastType);
    if (idx < 0) idx = 0;
    ordered.push(remaining.splice(idx, 1)[0]);
    if (!remaining.length && ordered.length < count) remaining.push(...shuffled);
    if (ordered.length > count * 4) break;
  }

  return ordered.slice(0, count).map((t) => instantiate(t, { seed: Math.floor(rng() * 4294967296) }));
}

/* ---------------------------------------------------------------------------
   10. Scaffold ladder — stored per problemType at KEYS.NUMERICALS.
       Rule (pedagogy-spec Tier 0): 2 correct -> advance, 1 wrong -> drop.
   ------------------------------------------------------------------------ */

function readState() {
  const s = store.get(KEYS.NUMERICALS, {});
  return s && typeof s === 'object' ? s : {};
}

export function getScaffoldRecord(problemType) {
  const rec = readState()[problemType];
  if (!rec || typeof rec !== 'object') {
    return { scaffoldLevel: 0, streak: 0, attempts: 0, correct: 0, updatedISO: null };
  }
  return {
    scaffoldLevel: clamp(Math.round(Number(rec.scaffoldLevel) || 0), 0, SCAFFOLD_MAX),
    streak: Math.max(0, Math.round(Number(rec.streak) || 0)),
    attempts: Math.max(0, Math.round(Number(rec.attempts) || 0)),
    correct: Math.max(0, Math.round(Number(rec.correct) || 0)),
    updatedISO: rec.updatedISO || null,
  };
}

export function getScaffoldLevel(problemType) {
  return getScaffoldRecord(problemType).scaffoldLevel;
}

/**
 * Record one clean/unclean attempt and move the ladder.
 * @returns {{level:number, previous:number, direction:'up'|'down'|'hold', streak:number}}
 */
export function recordScaffoldOutcome(problemType, wasClean) {
  const prev = getScaffoldRecord(problemType);
  let level = prev.scaffoldLevel;
  let streak = prev.streak;
  let direction = 'hold';

  if (wasClean) {
    streak += 1;
    if (streak >= 2 && level < SCAFFOLD_MAX) { level += 1; streak = 0; direction = 'up'; }
  } else {
    streak = 0;
    if (level > 0) { level -= 1; direction = 'down'; }
  }

  const next = {
    scaffoldLevel: level,
    streak,
    attempts: prev.attempts + 1,
    correct: prev.correct + (wasClean ? 1 : 0),
    updatedISO: todayLocalISO(),
  };
  store.update(KEYS.NUMERICALS, (s) => Object.assign({}, s && typeof s === 'object' ? s : {}, { [problemType]: next }), {});
  return { level, previous: prev.scaffoldLevel, direction, streak };
}

/** [{problemType, label, level, levelName, attempts, correct, updatedISO}] for stats.js. */
export function scaffoldSummary() {
  const state = readState();
  const rows = [];
  for (const [key, rec] of Object.entries(state)) {
    if (RESERVED.includes(key) || !rec || typeof rec !== 'object') continue;
    const level = clamp(Math.round(Number(rec.scaffoldLevel) || 0), 0, SCAFFOLD_MAX);
    const meta = (templateCache || []).find((t) => t.problemType === key);
    rows.push({
      problemType: key,
      label: meta ? meta.problemTypeLabel : humanise(key),
      subject: meta ? meta.subject : null,
      unit: meta ? meta.unit : null,
      level,
      levelName: SCAFFOLD_LEVELS[level].name,
      attempts: Math.max(0, Math.round(Number(rec.attempts) || 0)),
      correct: Math.max(0, Math.round(Number(rec.correct) || 0)),
      updatedISO: rec.updatedISO || null,
    });
  }
  rows.sort((a, b) => b.level - a.level || b.attempts - a.attempts);
  return rows;
}

/* ---------------------------------------------------------------------------
   11. Cognitive practice mix — the "your mix vs the exam's mix" data source.
       Only items whose cognitive level is ACTUALLY tagged are counted. Cards
       from the vault carry no cognitive tag yet, so they are honestly absent.
   ------------------------------------------------------------------------ */

/** @param {'knowledge'|'understanding'|'application'|'higher'} level */
export function recordCognitive(level, n) {
  if (!COGNITIVE_ORDER.includes(level)) return;
  const add = Math.max(1, Math.round(Number(n) || 1));
  store.update(KEYS.NUMERICALS, (s) => {
    const next = Object.assign({}, s && typeof s === 'object' ? s : {});
    const mix = Object.assign({ knowledge: 0, understanding: 0, application: 0, higher: 0 }, next._mix || {});
    mix[level] += add;
    next._mix = mix;
    return next;
  }, {});
}

/** {counts:{...}, total, pct:{...}, target:{...}, gaps:[{level,delta}]} */
export function cognitiveMix() {
  const mix = Object.assign({ knowledge: 0, understanding: 0, application: 0, higher: 0 }, readState()._mix || {});
  const total = COGNITIVE_ORDER.reduce((a, k) => a + (Number(mix[k]) || 0), 0);
  const pct = {};
  for (const k of COGNITIVE_ORDER) pct[k] = total ? (mix[k] / total) * 100 : 0;
  const gaps = COGNITIVE_ORDER.map((k) => ({ level: k, label: COGNITIVE_LABEL[k], delta: pct[k] - EXAM_COGNITIVE_MIX[k] }));
  return { counts: mix, total, pct, target: EXAM_COGNITIVE_MIX, gaps, order: COGNITIVE_ORDER, labels: COGNITIVE_LABEL };
}

/* ---------------------------------------------------------------------------
   12. Marking
   ------------------------------------------------------------------------ */

/**
 * Mark one line the way an examiner does.
 * @param {string} input the student's line
 * @param {{value:number, unitSig:string, unitDisplay:string, dimensionless:boolean, sigfigs:number}} expected
 * @returns {{mark:0|1, status:string, message:string, parsed:Object, sigFigNote:string}}
 */
export function markLine(input, expected) {
  const parsed = parseQuantity(input);
  const wantUnit = !expected.dimensionless;

  if (!parsed.ok) {
    return {
      mark: 0, status: 'blank', parsed, sigFigNote: '',
      message: 'Nothing to mark on this line. A blank line is a guaranteed zero — a wrong attempt at least earns method marks.',
    };
  }

  const valueOk = valuesAgree(parsed.value, expected.value);
  const unitSig = normaliseUnit(parsed.unit);
  const unitOk = wantUnit ? unitSig === expected.unitSig : (unitSig === '' || unitSig === expected.unitSig);

  if (wantUnit && !parsed.hasUnit) {
    return {
      mark: 0, status: valueOk ? 'no-unit' : 'wrong', parsed, sigFigNote: '',
      message: valueOk
        ? 'The number is right and the mark is gone anyway — this line carries no unit. Every line needs one: ' + expected.unitDisplay + '. That is the cheapest mark in the whole paper to lose (PH-U06).'
        : 'No unit, and the value does not match. Write the unit on every line; it is also how you catch the wrong formula before you finish.',
    };
  }

  if (valueOk && unitOk) {
    const sf = countSigFigs(parsed.raw);
    const want = expected.sigfigs || 3;
    const sigFigNote = sf && Math.abs(sf - want) >= 2
      ? 'Value and unit are both right — 1 mark. Separately: you wrote ' + sf + ' significant figures where ' + want + ' is appropriate (PH-U05). Not marked here, but it is marked in the paper.'
      : '';
    return { mark: 1, status: 'correct', parsed, sigFigNote, message: '' };
  }

  if (valueOk && !unitOk) {
    return {
      mark: 0, status: 'wrong-unit', parsed, sigFigNote: '',
      message: 'Right number, wrong unit. You wrote ' + displayUnit(parsed.unit) + '; this line is ' + expected.unitDisplay + '. Track the units through the algebra and the unit tells you whether the formula was right.',
    };
  }

  return {
    mark: 0, status: 'wrong', parsed, sigFigNote: '',
    message: 'Expected ' + formatSig(expected.value, expected.sigfigs) + (expected.unitDisplay ? ' ' + expected.unitDisplay : '') + '.',
  };
}

/** Find the misconception whose trap value the student landed on. */
export function matchTrap(value, traps) {
  if (!Number.isFinite(value) || !Array.isArray(traps)) return null;
  for (const t of traps) if (valuesAgree(value, t.value, TRAP_TOL)) return t;
  return null;
}

/* ---------------------------------------------------------------------------
   13. Recording an attempt — review log, error book, misconceptions, game.
   ------------------------------------------------------------------------ */

function ratingFromFraction(f) {
  if (f >= 0.95) return 4;
  if (f >= 0.7) return 3;
  if (f >= 0.4) return 2;
  return 1;
}

function gradeFromFraction(f) {
  if (f >= 0.8) return 'recalled';
  if (f >= 0.4) return 'partial';
  return 'lapsed';
}

/**
 * Persist one finished numerical. Writes the review log, the error book on a
 * miss, the misconception tally, the cognitive mix, and pings game.js.
 * @param {Object} problem
 * @param {{marks:number, marksTotal:number, confidence:number|null, elapsedMs:number,
 *          trap?:Object|null, unitSlip?:boolean, classifyCorrect?:boolean|null,
 *          answerLine?:string, cram?:boolean, hintsUsed?:number}} result
 */
export function recordAttempt(problem, result) {
  const total = Math.max(1, Number(result.marksTotal) || 1);
  const marks = clamp(Number(result.marks) || 0, 0, total);
  const frac = marks / total;
  const clean = frac >= 0.8;

  store.appendReviewLog({
    cardId: 'num:' + problem.templateId,
    topic: problem.unit || problem.subject,
    node: problem.problemType,
    rating: ratingFromFraction(frac),
    confidence: result.confidence === undefined ? null : result.confidence,
    elapsedMs: Number(result.elapsedMs) || 0,
    kind: 'transfer',
    grade: gradeFromFraction(frac),
    errorClass: clean ? null : (result.trap ? 'conceptual' : (result.unitSlip ? 'slip' : 'conceptual')),
    source: result.cram ? 'hub:numericals:cram' : 'hub:numericals',
  });

  recordCognitive(problem.cognitive, 1);
  bumpAttemptTally(clean);

  if (!clean) {
    const missing = result.trap
      ? result.trap.statement
      : (result.unitSlip ? 'A line was written without its unit.' : 'The chain broke before the final line.');
    store.update(KEYS.ERROR_BOOK, (prev) => {
      const arr = Array.isArray(prev) ? prev.slice() : [];
      arr.push({
        id: uid('eb'),
        ts: nowTs(),
        cardId: 'num:' + problem.templateId,
        subject: problem.subject,
        unit: problem.unit,
        problemType: problem.problemType,
        question: problem.text,
        given: String(result.answerLine || '').slice(0, 240),
        correct: problem.answer.display + (problem.answer.unitDisplay ? ' ' + problem.answer.unitDisplay : ''),
        missing,
        confidence: result.confidence === undefined ? null : result.confidence,
        misconceptionId: result.trap ? result.trap.id : null,
      });
      return arr;
    }, []);
  }

  if (result.trap) recordMisconception(result.trap, problem);

  const move = recordScaffoldOutcome(problem.problemType, clean);

  // game.js awards the XP itself inside recordActivity — never double-award.
  gameCall('recordActivity', 'drill', {
    count: 1,
    correct: clean,
    seconds: Math.round((Number(result.elapsedMs) || 0) / 1000),
    confidence: result.confidence === undefined ? null : result.confidence,
    subject: problem.subject,
    unit: problem.unit,
    cardId: 'num:' + problem.templateId,
    source: result.cram ? 'numericals:cram' : 'numericals',
    problemType: problem.problemType,
    marks,
    marksTotal: total,
    cram: Boolean(result.cram),
  });

  return { marks, marksTotal: total, clean, move };
}

function bumpAttemptTally(clean) {
  store.update(KEYS.NUMERICALS, (s) => {
    const next = Object.assign({}, s && typeof s === 'object' ? s : {});
    const t = Object.assign({ total: 0, clean: 0, day: null, today: 0 }, next._attempts || {});
    const day = todayLocalISO();
    if (t.day !== day) { t.day = day; t.today = 0; }
    t.total += 1;
    t.today += 1;
    if (clean) t.clean += 1;
    next._attempts = t;
    return next;
  }, {});
}

/** {total, clean, today} — the daily numerical quota lives on this. */
export function attemptTally() {
  const t = readState()._attempts || {};
  const day = todayLocalISO();
  return {
    total: Math.max(0, Number(t.total) || 0),
    clean: Math.max(0, Number(t.clean) || 0),
    today: t.day === day ? Math.max(0, Number(t.today) || 0) : 0,
  };
}

function recordMisconception(trap, problem) {
  store.update(KEYS.MISCONCEPTIONS, (prev) => {
    const map = prev && typeof prev === 'object' && !Array.isArray(prev) ? Object.assign({}, prev) : {};
    const day = todayLocalISO();
    const cur = map[trap.id] || { id: trap.id, statement: trap.statement, count: 0, firstISO: day, lastISO: day, resolvedISO: null };
    cur.count = (Number(cur.count) || 0) + 1;
    cur.lastISO = day;
    cur.statement = trap.statement || cur.statement;
    cur.subject = problem.subject;
    cur.unit = problem.unit;
    if (cur.resolvedISO) cur.relapsed = true;
    cur.resolvedISO = null;
    map[trap.id] = cur;
    return map;
  }, {});
}

/* ---------------------------------------------------------------------------
   14. UI
   ------------------------------------------------------------------------ */

const CONFIDENCE_CHOICES = [
  { value: 1, label: 'Guess' },
  { value: 3, label: 'Fairly sure' },
  { value: 5, label: 'Certain' },
];

function subjectAttrs(subject) {
  const key = String(subject || '').toLowerCase().replace(/\s+/g, '-');
  return { subject: SUBJECT_TOKENS[subject] ? key : 'physics' };
}

function marksPill(marks, total) {
  const frac = total ? marks / total : 0;
  const tone = frac >= 0.8 ? 'good' : frac >= 0.4 ? 'warn' : 'bad';
  return el('span.pill', { class: 'pill--' + tone, text: marks + ' of ' + total + ' marks' });
}

/**
 * Which chain steps are visible at this fade level.
 *
 * Backward fading peels lines off the END of the chain, one per level, and
 * level 3+ additionally caps at the single opening line. The Math.min is what
 * keeps the ladder MONOTONIC: on a short chain (2 work steps) the peel has
 * already reached zero by level 2, and a flat "level 3 shows one line" rule
 * would hand the student MORE help for going up a level — backward fading
 * running backwards. Support must never grow as the level rises.
 */
export function visibleStepCount(steps, level) {
  const n = steps.filter((s) => s.kind !== 'given').length;
  const lvl = clamp(Math.round(Number(level) || 0), 0, SCAFFOLD_MAX);
  if (lvl <= 0) return n;                    // fully worked
  if (lvl >= SCAFFOLD_MAX) return 0;         // cold — no worked line at all
  const byPeel = Math.max(0, n - lvl);       // L1: n-1, L2: n-2, L3: n-3
  const cap = lvl >= 3 ? 1 : n;              // L3+: at most the opening line
  return Math.min(byPeel, cap);
}

/**
 * Mount one numerical problem, fully interactive.
 * @param {HTMLElement} host
 * @param {{problem?:Object, template?:Object|string, subject?:string, unit?:string,
 *          seed?:number, scaffoldLevel?:number, cram?:boolean,
 *          onComplete?:Function, onNext?:Function, nextLabel?:string}} opts
 * @returns {{node:HTMLElement, problem:Object, destroy:Function}}
 */
export function mountNumerical(host, opts) {
  const o = opts || {};
  let problem = o.problem || null;
  if (!problem) {
    const tpl = o.template
      ? (typeof o.template === 'string' ? getTemplate(o.template) : o.template)
      : (getTemplates({ subject: o.subject, unit: o.unit })[0] || null);
    if (tpl) problem = instantiate(tpl, { seed: o.seed, scaffoldLevel: o.scaffoldLevel });
  }

  if (!problem) {
    const node = emptyState({
      icon: 'calculator',
      title: 'No numerical templates loaded',
      body: 'data/numericals/ has no template for this filter yet. Ask Hermes to author one for this unit — the engine is ready for it.',
    });
    host.appendChild(node);
    return { node, problem: null, destroy() { node.remove(); } };
  }

  const level = problem.scaffoldLevel;
  const workSteps = problem.steps.filter((s) => s.kind !== 'given');
  const givens = problem.steps.filter((s) => s.kind === 'given');
  const shown = visibleStepCount(problem.steps, level);
  const blankSteps = workSteps.slice(shown).filter((s) => s.checkable);
  const marksTotal = blankSteps.length + 1;         // + the final answer

  const startTs = nowTs();
  const inputs = new Map();
  let confidence = null;
  let classifyChoice = null;
  let hintsUsed = 0;
  let submitted = false;

  const card = el('article.card.card--tone.card--pad-lg', {
    dataset: subjectAttrs(problem.subject),
  });

  /* --- head ------------------------------------------------------------- */
  card.appendChild(el('div.card__head',
    el('div',
      eyebrow(problem.unit || problem.subject),
      el('h2.card__title', { text: problem.problemTypeLabel }),
      el('p.card__sub', {
        text: SCAFFOLD_LEVELS[level].name + ' · level ' + level + ' of 4 · ' + SCAFFOLD_LEVELS[level].blurb,
      })
    ),
    el('div.row',
      el('span.pill.pill--neutral', { text: marksTotal + ' ' + fmt.plural(marksTotal, 'mark') }),
      o.cram ? el('span.pill.pill--warn', icon('alert-triangle', { size: 12 }), el('span', { text: 'Cram mode' })) : null
    )
  ));

  const body = el('div.card__body.stack');
  card.appendChild(body);

  /* --- 'which type is this?' -------------------------------------------- */
  const workArea = el('div.stack');

  if (problem.classify) {
    const classifyBox = el('section.card.card--quiet',
      el('p.text-body-lg', { text: problem.classify.question }),
      el('p.hint', { text: 'Naming the type before you calculate is the skill interleaving is for. Exams do not label their questions.' })
    );
    const list = el('div.stack', { style: { '--gap': 'var(--sp-2)' } });
    problem.classify.options.forEach((opt, i) => {
      const btn = el('button.option', {
        type: 'button',
        dataset: { idx: String(i) },
        onClick: () => {
          if (classifyChoice !== null) return;
          classifyChoice = opt.correct;
          Array.from(list.children).forEach((n, k) => {
            const oo = problem.classify.options[k];
            /* classList.add('') throws in every browser — only ever add a real token. */
            if (oo.correct) n.classList.add('is-correct');
            else if (k === i) n.classList.add('is-wrong');
            n.disabled = true;
          });
          classifyBox.appendChild(el('p.hint', {
            class: opt.correct ? '' : 'hint--error',
            text: opt.correct
              ? 'Correct — this is a ' + problem.problemTypeLabel.toLowerCase() + ' problem. Now the working.'
              : 'Not quite. This is a ' + problem.problemTypeLabel.toLowerCase() + ' problem, not ' + opt.label.toLowerCase() + '. The tell is in what the question asks you to FIND, not in the words it uses.',
          }));
          workArea.hidden = false;
          haptic(opt.correct ? 'success' : 'warn');
        },
      },
        el('span.option__key', { text: String.fromCharCode(65 + i) }),
        el('span', { text: opt.label })
      );
      list.appendChild(btn);
    });
    classifyBox.appendChild(list);
    body.appendChild(classifyBox);
    workArea.hidden = true;
  }

  body.appendChild(workArea);

  /* --- the question ------------------------------------------------------ */
  workArea.appendChild(el('div.card.card--quiet',
    eyebrow('Question'),
    el('p.prose', { text: problem.text })
  ));

  /* --- givens (never blanked) -------------------------------------------- */
  if (givens.length) {
    workArea.appendChild(el('div.card.card--quiet',
      eyebrow('Start here'),
      el('div.stack', { style: { '--gap': 'var(--sp-2)' } },
        givens.map((s) => el('div',
          el('p.formula', { text: s.statement }),
          s.justification ? el('p.hint', { text: s.justification }) : null
        ))
      )
    ));
  }

  /* --- worked lines (shown at this fade level) --------------------------- */
  if (shown > 0) {
    const workedBox = el('section.stack', { style: { '--gap': 'var(--sp-3)' } });
    workedBox.appendChild(eyebrow(level === 0 ? 'Worked example' : 'Given to you'));
    workSteps.slice(0, shown).forEach((s) => {
      workedBox.appendChild(el('div.card.card--quiet',
        el('div.row.row--between',
          el('span.eyebrow', { text: 'Step ' + s.number }),
          s.checkable ? el('span.mono.text-meta', { text: s.display + (s.unitDisplay ? ' ' + s.unitDisplay : '') }) : null
        ),
        el('p.formula', { text: s.statement }),
        s.formula ? el('p.math.text-meta', { text: s.formula }) : null,
        s.justification ? el('p.hint', { text: s.justification }) : null
      ));
    });
    workArea.appendChild(workedBox);
  }

  /* --- self-explanation, level 0 only ------------------------------------ */
  let selfExplain = null;
  if (level === 0 && workSteps.length) {
    const target = workSteps[Math.min(1, workSteps.length - 1)];
    selfExplain = el('textarea.textarea', {
      rows: 2,
      placeholder: 'One sentence. Say what step ' + target.number + ' is FOR.',
      attrs: { 'aria-label': 'Why step ' + target.number + ' works' },
    });
    workArea.appendChild(el('div.field',
      el('label.label.label--req', { text: 'Why does step ' + target.number + ' work?' }),
      selfExplain,
      el('p.hint', { text: 'Reading a worked example without explaining it to yourself is the version that does not transfer. One sentence is enough.' })
    ));
  }

  /* --- the lines he has to write ----------------------------------------- */
  if (blankSteps.length) {
    const yours = el('section.stack', { style: { '--gap': 'var(--sp-3)' } });
    yours.appendChild(eyebrow('Your working — one line each, units every line'));
    blankSteps.forEach((s) => {
      const input = el('input.input.input--mono', {
        type: 'text',
        inputmode: 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: false,
        placeholder: 'value + unit' + (s.dimensionless ? ' (this one has no unit)' : ', e.g. 4.20 ' + s.unitDisplay),
        attrs: { 'aria-label': 'Step ' + s.number },
      });
      inputs.set(s.number, input);

      const hintHost = el('div');
      const row = el('div.field',
        el('div.row.row--between',
          el('label.label', { text: 'Step ' + s.number + (s.prompt ? ' — ' + s.prompt : '') }),
          level < SCAFFOLD_MAX
            ? el('button.btn.btn-ghost.btn--sm', {
                type: 'button',
                onClick: (e) => {
                  hintsUsed += 1;
                  e.currentTarget.disabled = true;
                  hintHost.appendChild(el('p.hint', { text: s.justification || 'Work out what this line is for before you compute it.' }));
                  if (s.formula) hintHost.appendChild(el('p.math.text-meta', { text: s.formula }));
                },
              }, icon('info', { size: 12 }), el('span', { text: 'Hint' }))
            : null
        ),
        input,
        hintHost
      );
      yours.appendChild(row);
    });
    workArea.appendChild(yours);
  }

  /* --- final answer ------------------------------------------------------ */
  const answerInput = el('input.input.input--mono', {
    type: 'text',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    placeholder: problem.answer.dimensionless ? 'value (no unit)' : 'value + unit, e.g. 4.20 ' + problem.answer.unitDisplay,
    attrs: { 'aria-label': 'Final answer' },
  });
  workArea.appendChild(el('div.field',
    el('label.label.label--req', { text: 'Final answer — ' + problem.answer.label }),
    answerInput,
    el('p.hint', { text: 'To ' + problem.answer.sigfigs + ' significant figures, with the unit. An answer with no unit scores nothing, however right the number is.' })
  ));

  /* --- confidence -------------------------------------------------------- */
  const confSeg = el('div.segmented', { attrs: { role: 'group', 'aria-label': 'How sure are you?' } });
  CONFIDENCE_CHOICES.forEach((c) => {
    const b = el('button.segmented__btn', {
      type: 'button', text: c.label,
      attrs: { 'aria-selected': 'false' },
      onClick: () => {
        confidence = c.value;
        Array.from(confSeg.children).forEach((n) => n.setAttribute('aria-selected', 'false'));
        b.setAttribute('aria-selected', 'true');
      },
    });
    confSeg.appendChild(b);
  });
  workArea.appendChild(el('div.field',
    el('label.label.label--req', { text: 'Before you check — how sure are you?' }),
    confSeg,
    el('p.hint', { text: 'Confident and wrong is the most expensive combination in the paper, so it gets its own queue. This is never guessed for you.' })
  ));

  /* --- actions + results ------------------------------------------------- */
  const resultHost = el('div');
  const checkBtn = el('button.btn.btn-primary.btn--block', { type: 'button' },
    icon('circle-check', { size: 16 }), el('span', { text: 'Mark my working' }));
  const actions = el('div.btn-row', checkBtn);
  workArea.appendChild(actions);
  workArea.appendChild(resultHost);

  checkBtn.addEventListener('click', () => {
    if (submitted) return;
    if (confidence === null) {
      toast('Pick how sure you are first — that is the part that trains calibration.', { tone: 'warn' });
      confSeg.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    if (selfExplain && !selfExplain.value.trim()) {
      toast('One sentence on why that step works, then I will mark it.', { tone: 'warn' });
      selfExplain.focus();
      return;
    }
    submitted = true;
    checkBtn.disabled = true;
    mark();
  });

  function mark() {
    const lines = [];
    let marks = 0;
    let unitSlip = false;

    for (const s of blankSteps) {
      const input = inputs.get(s.number);
      const res = markLine(input ? input.value : '', s);
      if (res.mark) marks += 1;
      if (res.status === 'no-unit') unitSlip = true;
      input.disabled = true;
      input.classList.toggle('input--invalid', res.mark === 0);
      lines.push({ step: s, res });
    }

    const ansRes = markLine(answerInput.value, problem.answer);
    if (ansRes.mark) marks += 1;
    if (ansRes.status === 'no-unit') unitSlip = true;
    answerInput.disabled = true;
    answerInput.classList.toggle('input--invalid', ansRes.mark === 0);

    const trap = ansRes.mark === 0 && ansRes.parsed.ok ? matchTrap(ansRes.parsed.value, problem.traps) : null;
    const elapsedMs = nowTs() - startTs;

    const outcome = recordAttempt(problem, {
      marks, marksTotal, confidence, elapsedMs,
      trap, unitSlip,
      classifyCorrect: classifyChoice,
      answerLine: answerInput.value,
      cram: o.cram,
      hintsUsed,
    });

    renderResult(lines, ansRes, trap, marks, outcome);

    if (marks === marksTotal) { sound('correct'); haptic('success'); }
    else { sound('wrong'); haptic('warn'); }

    if (typeof o.onComplete === 'function') {
      o.onComplete({ problem, marks, marksTotal, confidence, elapsedMs, trap, outcome, classifyCorrect: classifyChoice });
    }
  }

  function renderResult(lines, ansRes, trap, marks, outcome) {
    const missed = marksTotal - marks;
    const box = el('section.card.card--tone.stack', {
      dataset: { tone: marks === marksTotal ? 'good' : missed <= 1 ? 'warn' : 'bad' },
    });

    box.appendChild(el('div.row.row--between',
      el('h3.card__title', { text: marks + ' of ' + marksTotal + ' marks' }),
      marksPill(marks, marksTotal)
    ));

    box.appendChild(el('p.text-meta', {
      text: missed === 0
        ? 'Clean. Every line carried its unit.'
        : 'Here are the ' + missed + ' ' + fmt.plural(missed, 'mark') + ' you dropped, line by line.',
    }));

    // confidently wrong gets named, because that is where board marks go
    if (confidence >= 5 && marks < marksTotal) {
      box.appendChild(el('div.card.card--quiet',
        el('p.text-body-lg', { text: 'You were certain and it did not come out.' }),
        el('p.hint', { text: 'That combination is the most useful signal in the system — it means a rule you trust is wrong, not that you were careless. It goes to the top of the queue.' })
      ));
    }

    lines.forEach(({ step, res }) => {
      box.appendChild(el('div.card.card--quiet',
        el('div.row.row--between',
          el('span.eyebrow', { text: 'Step ' + step.number }),
          el('span.pill', { class: res.mark ? 'pill--good' : 'pill--bad', text: res.mark + '/1' })
        ),
        el('p.formula', { text: step.statement }),
        el('p.mono.text-meta', { text: 'Model line: ' + step.display + (step.unitDisplay ? ' ' + step.unitDisplay : ' (no unit)') }),
        res.message ? el('p.hint', { class: res.mark ? '' : 'hint--error', text: res.message }) : null,
        res.sigFigNote ? el('p.hint', { text: res.sigFigNote }) : null,
        step.justification ? el('p.hint', { text: step.justification }) : null
      ));
    });

    box.appendChild(el('div.card.card--quiet',
      el('div.row.row--between',
        el('span.eyebrow', { text: 'Final answer' }),
        el('span.pill', { class: ansRes.mark ? 'pill--good' : 'pill--bad', text: ansRes.mark + '/1' })
      ),
      el('p.formula', { text: problem.answer.label + ' = ' + problem.answer.display + (problem.answer.unitDisplay ? ' ' + problem.answer.unitDisplay : '') }),
      ansRes.message ? el('p.hint', { class: ansRes.mark ? '' : 'hint--error', text: ansRes.message }) : null,
      ansRes.sigFigNote ? el('p.hint', { text: ansRes.sigFigNote }) : null
    ));

    if (trap) {
      box.appendChild(el('div.card.card--tone', { dataset: { tone: 'warn' } },
        el('div.row', icon('alert-triangle', { size: 14 }), el('span.eyebrow', { text: 'Named error · ' + trap.id })),
        el('p.text-body-lg', { text: trap.statement }),
        el('p.prose', { text: trap.feedback }),
        trap.whyItFeelsRight
          ? el('p.hint', { text: 'Why the wrong rule felt right: ' + trap.whyItFeelsRight })
          : null
      ));
    }

    if (outcome.move.direction === 'up') {
      box.appendChild(el('p.hint', {
        text: 'Two clean runs — the scaffolding drops. Next ' + problem.problemTypeLabel.toLowerCase()
          + ' problem starts at level ' + outcome.move.level + ' (' + SCAFFOLD_LEVELS[outcome.move.level].name + ').',
      }));
    } else if (outcome.move.direction === 'down') {
      box.appendChild(el('p.hint', {
        text: 'Scaffolding goes back up one level (' + SCAFFOLD_LEVELS[outcome.move.level].name
          + ') for the next one. That is the system working, not a penalty.',
      }));
    }

    if (typeof o.onNext === 'function') {
      box.appendChild(el('div.btn-row',
        el('button.btn.btn-primary', { type: 'button', onClick: () => o.onNext() },
          el('span', { text: o.nextLabel || 'Next problem' }), icon('arrow-right', { size: 16 }))
      ));
    }

    resultHost.appendChild(box);
    box.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  host.appendChild(card);
  return { node: card, problem, destroy() { card.remove(); } };
}

/**
 * A short interleaved set with a progress rail and a closing report.
 * @param {HTMLElement} host
 * @param {{subject?:string, unit?:string, count?:number, cram?:boolean, onFinish?:Function}} opts
 */
export function mountNumericalSession(host, opts) {
  const o = opts || {};
  const problems = pickProblems({ subject: o.subject, unit: o.unit, count: o.count || 5 });
  const results = [];
  let current = null;
  let idx = 0;

  const wrap = el('div.stack');
  const rail = el('div.rail', problems.map(() => el('span.rail__cell')));
  const railRow = el('div.meter-row',
    rail,
    el('span.meter__label', { text: '0 / ' + problems.length })
  );
  const stage = el('div');
  wrap.appendChild(el('div.card.card--quiet', eyebrow('Interleaved set'), railRow,
    el('p.hint', { text: 'No two problems in a row share a type — that is the part that trains "which method is this?", which is what the exam actually tests.' })));
  wrap.appendChild(stage);
  host.appendChild(wrap);

  if (!problems.length) {
    stage.appendChild(emptyState({
      icon: 'calculator',
      title: 'No templates for that filter',
      body: 'Nothing in data/numericals/ matches yet.',
    }));
    return { node: wrap, destroy() { wrap.remove(); } };
  }

  function paintRail() {
    Array.from(rail.children).forEach((c, i) => {
      c.classList.toggle('is-done', i < idx);
      c.classList.toggle('is-current', i === idx);
    });
    railRow.lastChild.textContent = idx + ' / ' + problems.length;
  }

  function step() {
    stage.replaceChildren();
    paintRail();
    if (idx >= problems.length) return finish();
    current = mountNumerical(stage, {
      problem: problems[idx],
      cram: o.cram,
      nextLabel: idx === problems.length - 1 ? 'See the report' : 'Next problem',
      onComplete: (r) => { results.push(r); },
      onNext: () => { idx += 1; step(); },
    });
    return current;
  }

  function finish() {
    paintRail();
    const marks = results.reduce((a, r) => a + r.marks, 0);
    const total = results.reduce((a, r) => a + r.marksTotal, 0) || 1;
    const secs = Math.round(results.reduce((a, r) => a + r.elapsedMs, 0) / 1000);
    const confWrong = results.filter((r) => r.confidence >= 5 && r.marks < r.marksTotal).length;

    stage.appendChild(el('section.card.card--tone.card--pad-lg.stack', { dataset: { tone: marks / total >= 0.8 ? 'good' : 'warn' } },
      eyebrow('Set complete'),
      el('h2.card__title', { text: marks + ' of ' + total + ' marks' }),
      el('div.stat-row',
        el('div.stat', el('div.stat__eyebrow', el('span', { text: 'Time' })), el('div.stat__value', { text: fmt.dur(secs * 1000) })),
        el('div.stat', el('div.stat__eyebrow', el('span', { text: 'Problems' })), el('div.stat__value', { text: String(results.length) })),
        el('div.stat', el('div.stat__eyebrow', el('span', { text: 'Confident + wrong' })), el('div.stat__value', { text: String(confWrong) }))
      ),
      confWrong
        ? el('p.hint', { text: confWrong + ' ' + fmt.plural(confWrong, 'item') + ' you were certain about came out wrong. Those are queued first — a wrong rule you trust costs more marks than a topic you know you have not learnt.' })
        : el('p.hint', { text: 'Marks banked. Every attempt, right or wrong, moved the schedule.' })
    ));

    // Each problem already called recordActivity; this only banks the session time.
    gameCall('recordSession', { seconds: secs, source: 'numericals-set' });
    if (typeof o.onFinish === 'function') o.onFinish({ marks, marksTotal: total, results });
    return null;
  }

  step();
  return {
    node: wrap,
    destroy() { if (current) current.destroy(); wrap.remove(); },
  };
}

/* ---------------------------------------------------------------------------
   15. Default export
   ------------------------------------------------------------------------ */

export default {
  loadTemplates, getTemplates, getTemplate, templateSubjects, problemTypes,
  loadExamCalendar, daysToNextExam, gameCall,
  instantiate, pickProblems, makeRng, freshSeed,
  getScaffoldLevel, getScaffoldRecord, recordScaffoldOutcome, scaffoldSummary,
  cognitiveMix, recordCognitive, attemptTally,
  parseQuantity, normaliseUnit, displayUnit, evalExpr, formatSig, toSigFigs,
  markLine, matchTrap, recordAttempt,
  mountNumerical, mountNumericalSession,
  SCAFFOLD_LEVELS, SCAFFOLD_MAX, EXAM_COGNITIVE_MIX,
};
