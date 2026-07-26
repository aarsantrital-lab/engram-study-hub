/* =============================================================================
   js/share-image.js — branded share cards drawn on a <canvas>, exported as a
   PNG blob and handed to the Web Share API (download fallback).
   Job: GAME LAYER.

   Zero external origins: no image assets, no web fonts, no upload. The card is
   drawn from design tokens read out of theme.css at runtime — there is not a
   single raw colour value in this file, which is also why the card restyles
   itself the day theme.css changes.

   Copy rules: marks-language and real numbers only. A share card that says
   "Amazing work!" is exactly the vague praise §3.7 bans; one that says
   "52 of 75 — up 9 marks" is the thing worth sending.
   ========================================================================== */

import { token, fmt } from './dom.js';
import { APP_NAME } from './config.js';

/* Portrait: reads well in a chat thread and on a story. */
export const CARD_W = 1080;
export const CARD_H = 1350;

/* ---------------------------------------------------------------------------
   1. Tokens -> canvas colours
   ------------------------------------------------------------------------ */

/* Last-resort fallbacks are CSS system colours, never hard-coded hexes. */
const SYSTEM_INK = 'canvastext';
const SYSTEM_BG = 'canvas';

function color(name, fallback) {
  const v = token(name);
  return v || fallback || SYSTEM_INK;
}

/** Parse a `--x-rgb` triplet ("240 242 244" or "240, 242, 244") to rgba(). */
function rgba(name, alpha) {
  const raw = token(name);
  const parts = String(raw || '').split(/[\s,/]+/).map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (parts.length < 3) return 'transparent';
  return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + alpha + ')';
}

const SUBJECT_RGB = {
  Physics: '--sub-physics-rgb',
  Chemistry: '--sub-chem-rgb',
  Mathematics: '--sub-math-rgb',
  Maths: '--sub-math-rgb',
  'Computer Science': '--sub-cs-rgb',
  English: '--sub-english-rgb',
  Nepali: '--sub-nepali-rgb',
};
const SUBJECT_HEXTOKEN = {
  Physics: '--sub-physics',
  Chemistry: '--sub-chem',
  Mathematics: '--sub-math',
  Maths: '--sub-math',
  'Computer Science': '--sub-cs',
  English: '--sub-english',
  Nepali: '--sub-nepali',
};

function accentFor(subject) {
  const solid = SUBJECT_HEXTOKEN[subject] || '--brand';
  const trip = SUBJECT_RGB[subject] || '--brand-rgb';
  return { solid: color(solid, SYSTEM_INK), rgbToken: trip };
}

function fontStack() {
  return token('--font-sans') || 'system-ui, sans-serif';
}
function monoStack() {
  return token('--font-mono') || 'ui-monospace, monospace';
}

/* ---------------------------------------------------------------------------
   2. Drawing primitives
   ------------------------------------------------------------------------ */

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.arcTo(x + w, y, x + w, y + rad, rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  ctx.lineTo(x + rad, y + h);
  ctx.arcTo(x, y + h, x, y + h - rad, rad);
  ctx.lineTo(x, y + rad);
  ctx.arcTo(x, y, x + rad, y, rad);
  ctx.closePath();
}

/** Draw wrapped text; returns the y position after the last line. */
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const limit = maxLines || lines.length;
  const shown = lines.slice(0, limit);
  if (lines.length > limit && shown.length) shown[shown.length - 1] = shown[shown.length - 1] + '…';
  let cy = y;
  for (const l of shown) { ctx.fillText(l, x, cy); cy += lineHeight; }
  return cy;
}

/* ---------------------------------------------------------------------------
   3. The card
   ------------------------------------------------------------------------ */

/**
 * @typedef {Object} CardSpec
 * @property {'streak'|'mock'|'mastered'|'custom'} [kind]
 * @property {string} eyebrow   small uppercase line at the top
 * @property {string} title     the headline (short)
 * @property {string|number} metric  the big number
 * @property {string} [unit]    trailing unit for the metric ('/ 75', 'nights')
 * @property {string} [sub]     one line of real detail beneath the metric
 * @property {string} [note]    a second, quieter line
 * @property {string} [subject] recolours the card
 * @property {string} [footer]  defaults to 'Engram · Class 11 NEB'
 */

/**
 * Draw a share card onto a canvas.
 * @param {CardSpec} spec
 * @returns {HTMLCanvasElement}
 */
export function drawCard(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const accent = accentFor(s.subject);
  const bg = color('--bg', SYSTEM_BG);
  const surface = color('--surface', SYSTEM_BG);
  const ink = color('--fg', SYSTEM_INK);
  const inkMuted = color('--fg-muted', SYSTEM_INK);
  const sans = fontStack();
  const mono = monoStack();

  /* --- background -------------------------------------------------------- */
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  /* 24px grid — the signature .grid-bg, drawn by hand. */
  ctx.strokeStyle = rgba('--fg-rgb', 0.035);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= CARD_W; x += 48) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, CARD_H); }
  for (let y = 0; y <= CARD_H; y += 48) { ctx.moveTo(0, y + 0.5); ctx.lineTo(CARD_W, y + 0.5); }
  ctx.stroke();

  /* Corner glow orb, top-right — the card's one flourish. */
  const orb = ctx.createRadialGradient(CARD_W * 0.86, CARD_H * 0.1, 0, CARD_W * 0.86, CARD_H * 0.1, CARD_W * 0.62);
  orb.addColorStop(0, rgba(accent.rgbToken, 0.34));
  orb.addColorStop(0.55, rgba(accent.rgbToken, 0.06));
  orb.addColorStop(1, rgba(accent.rgbToken, 0));
  ctx.fillStyle = orb;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  /* --- panel ------------------------------------------------------------- */
  const M = 72;
  const panelY = 190;
  const panelH = CARD_H - panelY - 200;
  ctx.fillStyle = surface;
  roundRect(ctx, M, panelY, CARD_W - M * 2, panelH, 40);
  ctx.fill();
  ctx.strokeStyle = rgba('--fg-rgb', 0.1);
  ctx.lineWidth = 2;
  ctx.stroke();

  /* Accent bar down the left edge of the panel. */
  const bar = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
  bar.addColorStop(0, rgba(accent.rgbToken, 0.95));
  bar.addColorStop(1, rgba(accent.rgbToken, 0.25));
  ctx.fillStyle = bar;
  roundRect(ctx, M, panelY + 40, 8, panelH - 80, 4);
  ctx.fill();

  /* --- brand line -------------------------------------------------------- */
  ctx.fillStyle = accent.solid;
  ctx.beginPath();
  ctx.arc(M + 12, 104, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '600 30px ' + sans;
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(APP_NAME, M + 36, 114);

  /* --- eyebrow ----------------------------------------------------------- */
  const inner = M + 56;
  const innerW = CARD_W - inner - M - 40;
  let y = panelY + 108;

  if (s.eyebrow) {
    ctx.font = '600 26px ' + sans;
    ctx.fillStyle = accent.solid;
    const eb = String(s.eyebrow).toUpperCase();
    ctx.save();
    // Hand-rolled letter-spacing: canvas has no tracking property everywhere.
    let x = inner;
    for (const ch of eb) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + 5; }
    ctx.restore();
    y += 62;
  }

  /* --- metric ------------------------------------------------------------ */
  if (s.metric !== undefined && s.metric !== null && s.metric !== '') {
    ctx.font = '600 168px ' + mono;
    ctx.fillStyle = ink;
    ctx.shadowColor = rgba(accent.rgbToken, 0.45);
    ctx.shadowBlur = 60;
    const metric = String(s.metric);
    ctx.fillText(metric, inner, y + 128);
    ctx.shadowBlur = 0;
    if (s.unit) {
      const w = ctx.measureText(metric).width;
      ctx.font = '500 52px ' + sans;
      ctx.fillStyle = inkMuted;
      ctx.fillText(String(s.unit), inner + w + 20, y + 128);
    }
    y += 190;
  }

  /* --- title ------------------------------------------------------------- */
  if (s.title) {
    ctx.font = '600 58px ' + sans;
    ctx.fillStyle = ink;
    y = wrapText(ctx, s.title, inner, y + 48, innerW, 72, 3);
    y += 14;
  }

  /* --- detail lines ------------------------------------------------------ */
  if (s.sub) {
    ctx.font = '400 38px ' + sans;
    ctx.fillStyle = inkMuted;
    y = wrapText(ctx, s.sub, inner, y + 34, innerW, 52, 3);
  }
  if (s.note) {
    ctx.font = '400 32px ' + sans;
    ctx.fillStyle = rgba('--fg-muted-rgb', 0.85);
    y = wrapText(ctx, s.note, inner, y + 40, innerW, 46, 2);
  }

  /* --- footer ------------------------------------------------------------ */
  ctx.font = '500 30px ' + sans;
  ctx.fillStyle = inkMuted;
  ctx.fillText(s.footer || (APP_NAME + ' · Class 11 · NEB'), M, CARD_H - 88);

  return canvas;
}

/** Canvas -> PNG blob (toBlob where available, data URL otherwise). */
function toBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), 'image/png');
      return;
    }
    try {
      const url = canvas.toDataURL('image/png');
      const bin = atob(url.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: 'image/png' }));
    } catch (_) { resolve(null); }
  });
}

/**
 * Render a card to a PNG blob.
 * @param {CardSpec} spec
 * @returns {Promise<{canvas:HTMLCanvasElement, blob:Blob|null, filename:string}>}
 */
export async function renderShareCard(spec) {
  const canvas = drawCard(spec);
  const blob = await toBlob(canvas);
  const slug = String((spec && spec.kind) || 'card').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return { canvas, blob, filename: 'engram-' + slug + '.png' };
}

/** Save the blob to the device. */
export function downloadCard(blob, filename) {
  if (!blob || typeof document === 'undefined') return false;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'engram-card.png';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch (err) { console.warn('[share-image] download failed', err); return false; }
}

/**
 * Render and share. Uses the Web Share API when it can carry files, and falls
 * back to a download otherwise. Never throws.
 * @param {CardSpec} spec
 * @returns {Promise<{ok:boolean, shared:boolean, downloaded:boolean, reason?:string}>}
 */
export async function shareCard(spec) {
  const { blob, filename } = await renderShareCard(spec);
  if (!blob) return { ok: false, shared: false, downloaded: false, reason: 'render-failed' };

  const text = [spec && spec.title, spec && spec.sub].filter(Boolean).join(' — ');
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof File === 'function') {
      const file = new File([blob], filename, { type: 'image/png' });
      const payload = { files: [file], title: APP_NAME, text: text || APP_NAME };
      if (typeof navigator.canShare !== 'function' || navigator.canShare(payload)) {
        await navigator.share(payload);
        return { ok: true, shared: true, downloaded: false };
      }
    }
  } catch (err) {
    // AbortError = he changed his mind. That is not a failure and not a retry.
    if (err && err.name === 'AbortError') return { ok: true, shared: false, downloaded: false, reason: 'cancelled' };
    console.warn('[share-image] share failed, falling back to download', err);
  }

  const saved = downloadCard(blob, filename);
  return { ok: saved, shared: false, downloaded: saved, reason: saved ? undefined : 'download-failed' };
}

/* ---------------------------------------------------------------------------
   4. The three shipped templates
   ------------------------------------------------------------------------ */

/**
 * Streak milestone.
 * @param {{current:number, lifetime:number}} o
 */
export function streakCard(o) {
  const cur = Math.max(0, Math.round(Number(o && o.current) || 0));
  const life = Math.max(0, Math.round(Number(o && o.lifetime) || 0));
  return {
    kind: 'streak',
    eyebrow: 'Attendance',
    metric: fmt.int(cur),
    unit: cur === 1 ? 'night' : 'nights running',
    title: 'Someone who reviews every night.',
    sub: life + ' ' + (life === 1 ? 'night' : 'nights') + ' banked lifetime.',
    note: 'Any session counts, including the ninety-second one.',
  };
}

/**
 * Mock-paper result. `delta` is the change against the previous best.
 * @param {{subject:string, marksEarned:number, marksTotal:number, delta?:number}} o
 */
export function mockCard(o) {
  const s = o && typeof o === 'object' ? o : {};
  const earned = Math.max(0, Math.round(Number(s.marksEarned) || 0));
  const total = Math.max(1, Math.round(Number(s.marksTotal) || 75));
  const aPlus = Math.ceil(total * (67 / 75));
  const delta = Number(s.delta);
  return {
    kind: 'mock',
    subject: s.subject || null,
    eyebrow: (s.subject || 'Mock') + ' · timed paper',
    metric: String(earned),
    unit: '/ ' + total,
    title: Number.isFinite(delta) && delta !== 0
      ? (delta > 0 ? '+' + Math.round(delta) + ' marks on the last run.' : Math.round(delta) + ' marks on the last run.')
      : 'Full paper, full time.',
    sub: Math.max(0, aPlus - earned) + ' marks from the A+ line (' + aPlus + ' of ' + total + ').',
    note: 'Held-out paper. Nothing taught from it.',
  };
}

/**
 * A chapter that survived the +2 / +7 / +21 day gates.
 * @param {{chapter:string, subject?:string, cards?:number}} o
 */
export function masteredCard(o) {
  const s = o && typeof o === 'object' ? o : {};
  return {
    kind: 'mastered',
    subject: s.subject || null,
    eyebrow: (s.subject || 'Syllabus') + ' · retained',
    metric: '21',
    unit: 'days on',
    title: String(s.chapter || 'Chapter') + ' is still there.',
    sub: 'Passed the +2, +7 and +21 day checks without a re-read.',
    note: s.cards ? fmt.int(s.cards) + ' items held at ninety percent recall.' : '',
  };
}

export default {
  drawCard, renderShareCard, shareCard, downloadCard,
  streakCard, mockCard, masteredCard, CARD_W, CARD_H,
};
