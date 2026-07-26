/* =============================================================================
   js/pet.js — the study companion: a hand-drawn SVG creature with three
   evolution stages and a sleepy state.
   Job: GAME LAYER. Mounted through game.getPetMount().

   THE RULE THAT OVERRIDES EVERY OTHER DESIGN CHOICE HERE:
   the companion NEVER dies, never gets hungry, never looks sad, and never
   says anything about days missed. Neglect makes it doze, and a session wakes
   it. That is the entire failure mode. (pedagogy-spec §4 bans streak shaming
   and guilt framings; a pet that withers is exactly that mechanic wearing a
   costume.)

   Stage is driven by LIFETIME nights, which only ever increase — so the
   companion can never regress after a break either.

   No images, no sprites, no external anything: it is SVG built in code, using
   design tokens for every colour (never a raw hex), and every animation is
   gated on prefersReducedMotion().
   ========================================================================== */

import { getPetState, injectStyle, on as onGame } from './game.js';
import { prefersReducedMotion } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';

/** Build an SVG element. `style` is applied as a style attribute because CSS
 *  custom properties do not resolve inside SVG presentation attributes. */
function s(tag, attrs, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') node.setAttribute('style', String(v));
    else if (k === 'class') node.setAttribute('class', String(v));
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(3)) if (kid) node.appendChild(kid);
  return node;
}

/* ---------------------------------------------------------------------------
   Styles — tokens only. Injected once; the game layer owns no CSS file.
   ------------------------------------------------------------------------ */

const PET_CSS = `
.pet-slot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: var(--tap);
}
.pet-slot__art {
  flex: 0 0 auto;
  display: block;
  overflow: visible;
  color: var(--accent);
}
.pet-slot__text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pet-slot__name {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--fg);
  letter-spacing: -0.01em;
}
.pet-slot__caption {
  font-size: var(--fs-meta);
  line-height: var(--lh-snug);
  color: var(--fg-muted);
}
.pet-slot__meta {
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: var(--tr-micro);
  color: var(--fg-subtle);
}
.pet-slot__btn {
  appearance: none;
  background: none;
  border: 0;
  padding: 0;
  min-width: var(--tap);
  min-height: var(--tap);
  display: grid;
  place-items: center;
  cursor: pointer;
  border-radius: var(--r-lg);
}
.pet-slot__btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }

.pet-bob    { animation: pet-bob 3.6s var(--ease) infinite; transform-origin: 50% 60%; }
.pet-breathe{ animation: pet-breathe 5.4s var(--ease) infinite; transform-origin: 50% 60%; }
.pet-eyes   { animation: pet-blink 6.4s var(--ease) infinite; transform-origin: 50% 55%; }
.pet-orbit  { animation: pet-orbit 9s linear infinite; transform-origin: 32px 34px; }
.pet-zzz    { animation: pet-zzz 3.6s var(--ease) infinite; opacity: 0; }
.pet-zzz--b { animation-delay: 1.8s; }

@keyframes pet-bob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2.5px); }
}
@keyframes pet-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.035); }
}
@keyframes pet-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95%           { transform: scaleY(0.1); }
}
@keyframes pet-orbit {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes pet-zzz {
  0%   { opacity: 0; transform: translate(0, 2px) scale(0.8); }
  25%  { opacity: 0.9; }
  100% { opacity: 0; transform: translate(5px, -12px) scale(1.1); }
}

@media (prefers-reduced-motion: reduce) {
  .pet-bob, .pet-breathe, .pet-eyes, .pet-orbit, .pet-zzz { animation: none !important; }
  .pet-zzz { opacity: 0.7; }
}
`;

/* ---------------------------------------------------------------------------
   The creature
   ------------------------------------------------------------------------ */

const FILL_BODY = 'fill:rgb(var(--accent-rgb) / 0.22)';
const STROKE_BODY = 'stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round';
const FILL_INK = 'fill:var(--fg)';
const STROKE_INK = 'stroke:var(--fg);stroke-width:1.6;stroke-linecap:round;fill:none';

/**
 * Draw the companion.
 * @param {ReturnType<import('./game.js').getPetState>} state
 * @param {{size?:number}} [opts]
 * @returns {SVGSVGElement}
 */
export function renderPetSVG(state, opts) {
  const o = opts || {};
  const size = Math.max(36, Math.round(o.size || 56));
  const st = state || { stage: 1, sleepy: false, mood: 'awake', name: 'Spark' };
  const stage = Math.min(3, Math.max(1, Number(st.stage) || 1));
  const sleepy = st.sleepy === true;
  const bright = st.mood === 'bright';
  const still = prefersReducedMotion();

  const r = stage === 1 ? 12.5 : stage === 2 ? 14 : 15;
  const cy = 34;

  const parts = [];

  /* Ambient glow behind the body — brighter when all three rings are closed. */
  parts.push(s('circle', {
    cx: 32, cy, r: r + 7,
    style: 'fill:rgb(var(--accent-rgb) / ' + (bright ? '0.20' : '0.10') + ')',
  }));

  /* Stage 3: halo + orbiting spark. */
  if (stage >= 3) {
    parts.push(s('ellipse', {
      cx: 32, cy: cy - r - 6, rx: r - 3, ry: 3.2,
      style: 'fill:none;stroke:var(--brand);stroke-width:2;opacity:0.85',
    }));
    parts.push(s('g', { class: still ? '' : 'pet-orbit' },
      s('circle', { cx: 32 + r + 5, cy, r: 2.2, style: 'fill:var(--brand)' }),
      s('circle', { cx: 32 - r - 5, cy, r: 1.4, style: 'fill:rgb(var(--brand-rgb) / 0.7)' })));
  }

  /* Stage 2+: side fins, sweeping outward and DOWN. (Outward-and-UP reads as
     horns, which is not the creature we want anywhere near a study app.) */
  if (stage >= 2) {
    parts.push(s('path', {
      d: 'M' + (32 - r + 1) + ',' + (cy - 2) + ' q-9,1 -11,9 q6,-3 11,-4 z',
      style: FILL_BODY + ';' + STROKE_BODY,
    }));
    parts.push(s('path', {
      d: 'M' + (32 + r - 1) + ',' + (cy - 2) + ' q9,1 11,9 q-6,-3 -11,-4 z',
      style: FILL_BODY + ';' + STROKE_BODY,
    }));
  }

  /* Body. */
  parts.push(s('circle', { cx: 32, cy, r, style: FILL_BODY + ';' + STROKE_BODY }));

  /* Highlight — the little lit spot that makes it read as a creature. */
  parts.push(s('ellipse', {
    cx: 32 - r * 0.38, cy: cy - r * 0.42, rx: r * 0.32, ry: r * 0.22,
    style: 'fill:rgb(var(--fg-rgb) / 0.20)',
  }));

  /* Antenna spark (all stages — it is the "engram" of the thing). */
  parts.push(s('path', {
    d: 'M32,' + (cy - r) + ' V' + (cy - r - 6),
    style: 'stroke:var(--accent);stroke-width:1.6;stroke-linecap:round',
  }));
  parts.push(s('circle', {
    cx: 32, cy: cy - r - 8, r: stage >= 2 ? 2.6 : 2,
    style: 'fill:var(--accent)',
  }));

  /* Face. */
  const eyeY = cy - 1;
  const eyeDx = r * 0.42;
  if (sleepy) {
    parts.push(s('path', {
      d: 'M' + (32 - eyeDx - 2.6) + ',' + eyeY + ' q2.6,2.6 5.2,0',
      style: STROKE_INK,
    }));
    parts.push(s('path', {
      d: 'M' + (32 + eyeDx - 2.6) + ',' + eyeY + ' q2.6,2.6 5.2,0',
      style: STROKE_INK,
    }));
  } else {
    parts.push(s('g', { class: still ? 'pet-face' : 'pet-face pet-eyes' },
      s('circle', { cx: 32 - eyeDx, cy: eyeY, r: 2.1, style: FILL_INK }),
      s('circle', { cx: 32 + eyeDx, cy: eyeY, r: 2.1, style: FILL_INK })));
  }

  /* Mouth: a calm line when dozing, a small smile otherwise. Never a frown. */
  parts.push(s('path', {
    d: sleepy
      ? 'M' + (32 - 3) + ',' + (cy + 5) + ' h6'
      : 'M' + (32 - 3.5) + ',' + (cy + 4) + ' q3.5,3 7,0',
    style: STROKE_INK,
  }));

  /* Dozing marks. Two of them, drifting. */
  if (sleepy) {
    const z = (x, y, scale, cls) => s('path', {
      d: 'M' + x + ',' + y + ' h' + (5 * scale) + ' l' + (-5 * scale) + ',' + (5.5 * scale) + ' h' + (5 * scale),
      class: cls,
      style: 'stroke:var(--fg-muted);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;fill:none',
    });
    parts.push(z(45, 16, 1, still ? '' : 'pet-zzz'));
    parts.push(z(51, 9, 0.7, still ? '' : 'pet-zzz pet-zzz--b'));
  }

  const inner = s('g', { class: still ? '' : (sleepy ? 'pet-breathe' : 'pet-bob') }, parts);

  const svg = s('svg', {
    class: 'pet-slot__art',
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    role: 'img',
    'aria-label': (st.name || 'Companion') + ' — ' + (sleepy ? 'dozing' : 'awake'),
  }, s('title', {}, document.createTextNode((st.name || 'Companion') + ', stage ' + stage)), inner);

  return svg;
}

/* ---------------------------------------------------------------------------
   Mounting
   ------------------------------------------------------------------------ */

/**
 * Fill a mount node with the companion and keep it live.
 * @param {HTMLElement} host the node returned by game.getPetMount()
 * @param {{size?:number, showCaption?:boolean, onClick?:Function}} [opts]
 * @returns {()=>void} destroy
 */
export function mountPet(host, opts) {
  if (!host) return () => {};
  const o = opts || {};
  injectStyle('engram-pet-style', PET_CSS);
  if (!host.classList.contains('pet-slot')) host.classList.add('pet-slot');

  const draw = () => {
    if (!host.isConnected && host.__petDrawnOnce) return;
    const state = getPetState();
    host.__petDrawnOnce = true;
    const art = renderPetSVG(state, { size: o.size });

    const children = [];
    if (typeof o.onClick === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pet-slot__btn';
      btn.setAttribute('aria-label', state.name + ' — study companion');
      btn.appendChild(art);
      btn.addEventListener('click', () => o.onClick(state));
      children.push(btn);
    } else {
      children.push(art);
    }

    if (o.showCaption !== false) {
      const text = document.createElement('div');
      text.className = 'pet-slot__text';

      const name = document.createElement('div');
      name.className = 'pet-slot__name';
      name.textContent = state.name + ' · ' + state.stageName;
      text.appendChild(name);

      const cap = document.createElement('div');
      cap.className = 'pet-slot__caption';
      cap.textContent = state.caption;
      text.appendChild(cap);

      if (state.nextStage) {
        const meta = document.createElement('div');
        meta.className = 'pet-slot__meta';
        meta.textContent = state.nextStage.nightsToGo + ' more '
          + (state.nextStage.nightsToGo === 1 ? 'night' : 'nights') + ' to ' + state.nextStage.name;
        text.appendChild(meta);
      }
      children.push(text);
    }

    host.replaceChildren(...children);
    host.setAttribute('data-mood', state.mood);
  };

  draw();

  const offs = [];
  const wire = (ev) => offs.push(onGame(ev, () => {
    if (!host.isConnected) { destroy(); return; }
    draw();
  }));
  for (const ev of ['ring', 'streak', 'pet', 'celebration']) wire(ev);

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of offs) { try { off(); } catch (_) { /* ignore */ } }
    offs.length = 0;
  }

  host.__petDestroy = destroy;
  return destroy;
}

export default { renderPetSVG, mountPet };
