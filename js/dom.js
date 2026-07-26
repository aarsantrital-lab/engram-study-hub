/* =============================================================================
   js/dom.js — the tiny helper layer every view is built from.
   Job A2. Imports: config.js, store.js, md.js.

   Rules:
     · el() NEVER accepts an HTML string. Markdown goes through md.js, which
       sanitises. There is exactly one innerHTML site in this codebase and it
       lives behind md.sanitizeToFragment().
     · icon() reads the inlined Lucide sprite (assets/icons.svg). Safari has
       never been reliable with cross-file <use>, so app.js inlines the sprite
       once at boot; icon() then references same-document ids.
     · Every animation helper respects prefers-reduced-motion (§10).
     · fmt.num()/fmt.sci() NEVER emit e-notation (build-constraints §5).
   ========================================================================== */

import CONFIG, { isFeatureEnabled } from './config.js';
import { store, KEYS } from './store.js';
import { sanitizeToFragment, renderMarkdown, renderInline, installSpoilerHandler, safeUrl } from './md.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/* URL-bearing attributes. The `k in node` fast path below used to assign these
   straight onto the element, so a value taken from a route param could reach
   a.href as `javascript:` without md.js's safeUrl() ever being consulted.
   They are all filtered here now, so no view can reopen the hole by forgetting
   to sanitise at the call site. Single-URL attributes only: srcset is
   space/comma separated and would be mangled by a single-URL check. */
const URL_PROPS = new Set(['href', 'src', 'action', 'formaction', 'formAction', 'poster', 'cite', 'data']);

function setUrlAttr(node, key, value) {
  const safe = safeUrl(value);
  if (safe === null) {
    console.warn('[dom] refused an unsafe ' + key + ' on <' + node.tagName.toLowerCase() + '>:', value);
    return;
  }
  node.setAttribute(key === 'formAction' ? 'formaction' : key, safe);
}

/* ---------------------------------------------------------------------------
   1. Element construction
   ------------------------------------------------------------------------ */

/**
 * Create an element.
 *   el('div')
 *   el('div.card')                              -> <div class="card">
 *   el('button.btn.btn--primary#go')            -> classes + id
 *   el('span', { text: 'hi', title: 'tip' })
 *   el('a', { href: '#/home', on: { click: fn } }, 'Home')
 *   el('div', {}, child1, [child2, child3], 'text')
 *
 * Props: text · class/className · id · style (object or string) · dataset
 *        · aria (object) · attrs (object) · on (object of listeners)
 *        · onClick/onInput/... (function) · any DOM property or attribute.
 * There is deliberately no `html` prop.
 *
 * @param {string} spec tag with optional .class and #id
 * @param {Object} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function el(spec, props, ...children) {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(String(spec || 'div'));
  const tag = (m && m[1]) || 'div';
  const node = document.createElement(tag);

  if (m && m[2]) {
    for (const token of m[2].match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') node.classList.add(token.slice(1));
      else node.id = token.slice(1);
    }
  }

  if (props && typeof props === 'object' && !isRenderable(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (URL_PROPS.has(k)) { setUrlAttr(node, k, v); continue; }
      if (k === 'text') { node.textContent = String(v); continue; }
      if (k === 'class' || k === 'className') { node.className += (node.className ? ' ' : '') + String(v); continue; }
      if (k === 'style') {
        if (typeof v === 'string') node.setAttribute('style', v);
        else for (const [p, val] of Object.entries(v)) {
          if (p.startsWith('--')) node.style.setProperty(p, String(val));
          else node.style[p] = val;
        }
        continue;
      }
      if (k === 'dataset') { for (const [p, val] of Object.entries(v)) node.dataset[p] = String(val); continue; }
      if (k === 'aria') { for (const [p, val] of Object.entries(v)) node.setAttribute('aria-' + p, String(val)); continue; }
      if (k === 'attrs') {
        for (const [p, val] of Object.entries(v)) {
          if (URL_PROPS.has(p)) setUrlAttr(node, p, val);
          else node.setAttribute(p, String(val));
        }
        continue;
      }
      if (k === 'on' && typeof v === 'object') { for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn); continue; }
      if (/^on[A-Z]/.test(k) && typeof v === 'function') { node.addEventListener(k.slice(2).toLowerCase(), v); continue; }
      if (k in node && k !== 'list' && typeof v !== 'object') { try { node[k] = v; continue; } catch (_) { /* fall through */ } }
      node.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }

  append(node, children);
  return node;
}

function isRenderable(v) {
  return v instanceof Node || typeof v === 'string' || typeof v === 'number' || Array.isArray(v);
}

/** Append strings / nodes / nested arrays; null & false are skipped. */
export function append(parent, ...children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Remove all children. */
export function clear(node) { if (node) node.replaceChildren(); return node; }

/** Replace children in one shot. */
export function replace(node, ...children) {
  clear(node);
  return append(node, ...children);
}

export const frag = (...children) => append(document.createDocumentFragment(), ...children);

export const qs = (sel, root) => (root || document).querySelector(sel);
export const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** addEventListener that returns its own remover. */
export function on(node, type, handler, opts) {
  node.addEventListener(type, handler, opts);
  return () => node.removeEventListener(type, handler, opts);
}

/** Delegated listener. Returns a remover. */
export function delegate(root, selector, type, handler) {
  const fn = (e) => {
    const t = e.target instanceof Element ? e.target.closest(selector) : null;
    if (t && root.contains(t)) handler(e, t);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}

/* ---------------------------------------------------------------------------
   2. Icons — inlined Lucide sprite
   ------------------------------------------------------------------------ */

let spriteState = 'idle';   // 'idle' | 'inlined' | 'external'
let spritePromise = null;

/**
 * Fetch assets/icons.svg once and inline it into the document so <use href="#id">
 * works everywhere (including iOS Safari). app.js awaits this before first paint.
 * Falls back to external references when fetch is unavailable (file://).
 * @returns {Promise<'inlined'|'external'>}
 */
export function installIconSprite(url) {
  if (spritePromise) return spritePromise;
  const src = url || CONFIG.ICON_SPRITE;
  spritePromise = (async () => {
    try {
      const res = await fetch(src, { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.documentElement;
      if (!svg || svg.nodeName === 'parsererror') throw new Error('sprite did not parse');
      for (const bad of Array.from(svg.querySelectorAll('script, foreignObject'))) bad.remove();
      const host = document.createElement('div');
      host.id = 'icon-sprite';
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      host.appendChild(document.importNode(svg, true));
      document.body.insertBefore(host, document.body.firstChild);
      spriteState = 'inlined';
    } catch (err) {
      console.warn('[dom] icon sprite not inlined, falling back to external <use>', err);
      spriteState = 'external';
    }
    return spriteState;
  })();
  return spritePromise;
}

/**
 * An inline SVG icon.
 * @param {string} name sprite id, bare Lucide kebab name ('flame', 'book-open')
 * @param {{size?:number, cls?:string, title?:string, tone?:string}} [opts]
 *        size is strict per §10: 12 | 14 | 16 (occasionally 20 in the header)
 * @returns {SVGElement}
 */
export function icon(name, opts) {
  const o = opts || {};
  const size = o.size || 16;
  const svg = document.createElementNS(SVG_NS, 'svg');
  // components.css owns .icon / .icon--<size>; the attributes below are a
  // fallback for the case where components.css has not loaded.
  const sizeClass = [12, 14, 16, 20, 24].includes(size) ? ' icon--' + size : '';
  svg.setAttribute('class', 'icon' + sizeClass + (o.cls ? ' ' + o.cls : ''));
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('focusable', 'false');
  if (o.tone) svg.style.color = o.tone;
  if (o.title) {
    svg.setAttribute('role', 'img');
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = o.title;
    svg.appendChild(t);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const use = document.createElementNS(SVG_NS, 'use');
  const id = '#' + CONFIG.ICON_PREFIX + String(name || 'info');
  const href = spriteState === 'external' ? CONFIG.ICON_SPRITE + id : id;
  use.setAttribute('href', href);
  use.setAttributeNS(XLINK_NS, 'xlink:href', href);
  svg.appendChild(use);
  return svg;
}

/* ---------------------------------------------------------------------------
   3. Formatting  (NEVER e-notation — build-constraints §5)
   ------------------------------------------------------------------------ */

const SUPS = { '-': '⁻', '+': '⁺', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const SUBS = { '-': '₋', '+': '₊', 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };

export const fmt = {
  /** Unicode superscript digits: sup(23) -> '²³'. */
  sup: (n) => String(n).split('').map((c) => SUPS[c] ?? c).join(''),
  /** Unicode subscript digits: sub(2) -> '₂'. */
  sub: (n) => String(n).split('').map((c) => SUBS[c] ?? c).join(''),

  /** Scientific notation the ONLY sanctioned way: '6.022 × 10²³'. */
  sci(mantissa, exponent) {
    return String(mantissa) + ' × 10' + fmt.sup(exponent);
  },

  /**
   * A number as text. Falls back to a × 10ⁿ form rather than ever printing
   * '1e+21' (build-constraints §5 — no programmer notation, anywhere).
   */
  num(value, decimals) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (n !== 0 && (abs >= 1e21 || abs < 1e-6)) {
      const exp = Math.floor(Math.log10(abs));
      const man = (n / Math.pow(10, exp)).toFixed(decimals === undefined ? 3 : decimals);
      return fmt.sci(man, exp);
    }
    return decimals === undefined
      ? n.toLocaleString(CONFIG.LOCALE)
      : n.toLocaleString(CONFIG.LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },

  int: (v) => fmt.num(Math.round(Number(v) || 0), 0),
  pct: (v, dp) => (Number.isFinite(Number(v)) ? fmt.num(Number(v) * 100, dp === undefined ? 0 : dp) + '%' : '—'),

  bytes(b) {
    const n = Number(b) || 0;
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, x = n;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    return (i === 0 ? Math.round(x) : x.toFixed(1)) + ' ' + units[i];
  },

  /** '1m 20s' · '45s' · '2h 5m' */
  dur(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  },

  /** 'MM:SS' for timers. */
  clock(seconds) {
    const t = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  },

  /** '26 Jul' — local calendar, never UTC. */
  dateShort(input) {
    const d = toDate(input);
    return d ? d.toLocaleDateString(CONFIG.LOCALE, { day: 'numeric', month: 'short' }) : '—';
  },
  dateLong(input) {
    const d = toDate(input);
    return d ? d.toLocaleDateString(CONFIG.LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  },
  time(input) {
    const d = toDate(input);
    return d ? d.toLocaleTimeString(CONFIG.LOCALE, { hour: 'numeric', minute: '2-digit' }) : '—';
  },
  dayName(input) {
    const d = toDate(input);
    return d ? d.toLocaleDateString(CONFIG.LOCALE, { weekday: 'short' }) : '—';
  },

  /** 'just now' · '4 min ago' · 'yesterday' · 'in 3 days' */
  rel(input) {
    const d = toDate(input);
    if (!d) return '—';
    const diff = d.getTime() - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    if (abs < 45000) return 'just now';
    if (mins < 60) return diff < 0 ? mins + ' min ago' : 'in ' + mins + ' min';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return diff < 0 ? hrs + 'h ago' : 'in ' + hrs + 'h';
    const days = Math.round(hrs / 24);
    if (days === 1) return diff < 0 ? 'yesterday' : 'tomorrow';
    if (days < 30) return diff < 0 ? days + ' days ago' : 'in ' + days + ' days';
    return fmt.dateShort(d);
  },

  ordinal(n) {
    const i = Math.round(Number(n) || 0), r10 = i % 10, r100 = i % 100;
    if (r10 === 1 && r100 !== 11) return i + 'st';
    if (r10 === 2 && r100 !== 12) return i + 'nd';
    if (r10 === 3 && r100 !== 13) return i + 'rd';
    return i + 'th';
  },

  plural: (n, one, many) => (Number(n) === 1 ? one : (many || one + 's')),

  /** Trim to length on a word boundary. */
  truncate(s, max) {
    const t = String(s || '');
    const n = max || 80;
    if (t.length <= n) return t;
    const cut = t.lastIndexOf(' ', n);
    return t.slice(0, cut > n * 0.6 ? cut : n).trim() + '…';
  },
};

function toDate(input) {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));   // LOCAL midnight
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/* ---------------------------------------------------------------------------
   4. Motion, haptics, sound (all progressive enhancement)
   ------------------------------------------------------------------------ */

/** OS/user preference for reduced motion (settings can force it either way). */
export function prefersReducedMotion() {
  const s = store.get(KEYS.SETTINGS, null);
  const pref = s && s.reduceMotion;
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const HAPTIC_PATTERNS = {
  tap: [8], soft: [4], select: [10],
  success: [10, 40, 18], warn: [18, 60, 18], error: [30, 40, 30],
  levelup: [12, 30, 12, 30, 24],
};

/**
 * Vibrate, if the device supports it and the user has haptics on.
 * Silently does nothing on iOS (no Vibration API) — that is fine.
 * @param {keyof typeof HAPTIC_PATTERNS|number[]} [kind]
 */
export function haptic(kind) {
  try {
    if (!isFeatureEnabled('haptics')) return false;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    const pattern = Array.isArray(kind) ? kind : (HAPTIC_PATTERNS[kind] || HAPTIC_PATTERNS.tap);
    return navigator.vibrate(pattern);
  } catch (_) { return false; }
}

/* Sounds are synthesised — zero external origins, zero audio files. */
const SOUND_SPECS = {
  tick:    { freq: 880,  type: 'sine',     dur: 0.05, gain: 0.05 },
  select:  { freq: 660,  type: 'sine',     dur: 0.06, gain: 0.05 },
  correct: { freq: 587,  type: 'sine',     dur: 0.16, gain: 0.09, to: 880 },
  wrong:   { freq: 220,  type: 'triangle', dur: 0.20, gain: 0.09, to: 165 },
  complete:{ freq: 523,  type: 'sine',     dur: 0.28, gain: 0.10, to: 1046 },
  levelup: { freq: 659,  type: 'square',   dur: 0.30, gain: 0.06, to: 1318 },
};

let audioCtx = null;

/**
 * Play a UI sound. No-op when the sounds flag is off or audio is unavailable.
 * Must be first triggered inside a user gesture (browser autoplay policy).
 * @param {keyof typeof SOUND_SPECS} name
 */
export function sound(name) {
  try {
    if (!isFeatureEnabled('sounds')) return false;
    const spec = SOUND_SPECS[name];
    if (!spec) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, t0);
    if (spec.to) osc.frequency.exponentialRampToValueAtTime(spec.to, t0 + spec.dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(spec.gain, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + spec.dur + 0.02);
    return true;
  } catch (_) { return false; }
}

/* ---------------------------------------------------------------------------
   5. Shared micro-components
   ------------------------------------------------------------------------ */

let toastHost = null;

/**
 * Transient message. Tones: 'info' | 'good' | 'warn' | 'bad'.
 * @param {string} message
 * @param {{tone?:string, timeout?:number, action?:{label:string, onClick:Function}}} [opts]
 */
export function toast(message, opts) {
  const o = opts || {};
  if (!toastHost) {
    toastHost = el('div#toast-host.toast-stack', { attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.appendChild(toastHost);
  }
  const tone = o.tone || 'info';
  const TONE_ICON = { good: 'circle-check', warn: 'alert-triangle', bad: 'alert-triangle', info: 'info' };
  const node = el('div.toast', { class: 'toast--' + tone, dataset: { tone } },
    icon(TONE_ICON[tone] || 'info', { size: 16 }),
    el('span.toast__msg', { text: String(message) }),
    o.action ? el('button.toast__action', {
      type: 'button', text: o.action.label,
      onClick: () => { try { o.action.onClick(); } finally { node.remove(); } },
    }) : null,
    el('button.toast__close', { type: 'button', attrs: { 'aria-label': 'Dismiss' }, onClick: () => node.remove() }, icon('x', { size: 14 }))
  );
  toastHost.appendChild(node);
  const ms = o.timeout === 0 ? 0 : (o.timeout || 4200);
  if (ms) setTimeout(() => node.remove(), ms);
  return node;
}

/**
 * The standard empty / zero-data panel.
 * @param {{icon?:string, title:string, body?:string, action?:{label:string, onClick:Function, href?:string}}} o
 */
export function emptyState(o) {
  const spec = o || {};
  return el('div.empty-state',
    icon(spec.icon || 'sparkles', { size: 24 }),
    el('h3.empty-state__title', { text: spec.title || 'Nothing here yet' }),
    spec.body ? el('p.empty-state__body', { text: spec.body }) : null,
    spec.action ? el('button.btn.btn-primary', {
      type: 'button', text: spec.action.label,
      onClick: spec.action.onClick || (() => { if (spec.action.href) location.hash = spec.action.href; }),
    }) : null
  );
}

/** A labelled section heading with the §10 eyebrow dot. */
export function eyebrow(text, tone) {
  return el('div.eyebrow.eyebrow--dot', { style: tone ? { '--accent': tone } : null },
    el('span', { text: String(text) }));
}

export function spinner(label) {
  return el('div.spinner', { attrs: { role: 'status', 'aria-label': label || 'Loading' } },
    icon('loader', { size: 20, cls: 'icon-spin' }));
}

/** Render markdown into a node (sanitised). Re-exported for convenience. */
export function md(node, text) {
  if (!node) return node;
  node.replaceChildren(sanitizeToFragment(renderMarkdown(text)));
  installSpoilerHandler();
  return node;
}

/** Render a single inline run of markdown into a node (sanitised). */
export function mdInline(node, text) {
  if (!node) return node;
  node.replaceChildren(sanitizeToFragment(renderInline(text)));
  installSpoilerHandler();
  return node;
}

/* ---------------------------------------------------------------------------
   6. Timing utilities
   ------------------------------------------------------------------------ */

export function debounce(fn, wait) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait || 150); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttle(fn, wait) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    const now = Date.now();
    pending = args;
    if (now - last >= (wait || 100)) { last = now; fn(...pending); return; }
    if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...pending); }, (wait || 100) - (now - last));
    }
  };
}

export function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }

export function onIdle(fn, timeout) {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout: timeout || 1200 });
  return setTimeout(fn, 1);
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Read a CSS custom property from :root (or any element). Used by the stubs
 *  to prove theme.css loaded, and by charts that need the real token value. */
export function token(name, target) {
  const host = target || document.documentElement;
  return getComputedStyle(host).getPropertyValue(name).trim();
}

export default { el, icon, fmt, toast, haptic, sound, md };
