/* =============================================================================
   js/chat/attachments.js — Job CHAT (leaf of the chat suite).

   Everything to do with files in chat:
     · client-side image compression  (canvas → WebP quality ladder)
     · size pre-checks for non-images
     · upload through sb.storage with staged progress
     · Discord-style attachment cards (image tile + file card)
     · image lightbox

   Imports ONLY frozen foundation modules (config.js, dom.js). It never reaches
   for sb.js itself — the caller passes the sb surface in, so this file stays
   trivially testable and has zero coupling to the rest of the chat suite.

   NOTE ON HEIC (iPhone): iOS Safari can decode HEIC through <img>, so the
   canvas ladder below transcodes iPhone photos to WebP on the phone itself.
   Desktop browsers cannot decode HEIC — we detect the failure and say so in
   plain language instead of uploading a file nobody can open.
   ========================================================================== */

import CONFIG from '../config.js';
import { el, icon, fmt, on, prefersReducedMotion } from '../dom.js';

/* ---------------------------------------------------------------------------
   1. Type helpers
   ------------------------------------------------------------------------ */

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|heic|heif|avif|bmp|tiff?)$/i;
/** Never fed to canvas: gif (animation would be flattened), svg (script vector). */
const CANVAS_UNSAFE = /^image\/(gif|svg\+xml)$/i;
const HEIC = /^image\/(heic|heif)$/i;

/** Files that are images by extension even when the browser reports no type. */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|heif|avif|bmp|tiff?)$/i;

export function isImageFile(file) {
  if (!file) return false;
  const type = String(file.type || '');
  if (IMAGE_MIME.test(type)) return true;
  return !type && IMAGE_EXT.test(String(file.name || ''));
}

/** SVG is a script-bearing document, not a picture. Refused in prepareFile(). */
export function isSvgFile(file) {
  if (!file) return false;
  return /^image\/svg/i.test(String(file.type || '')) || /\.svgz?$/i.test(String(file.name || ''));
}

function effectiveType(file) {
  const t = String(file.type || '').toLowerCase();
  if (t) return t;
  const m = IMAGE_EXT.exec(String(file.name || ''));
  if (!m) return 'application/octet-stream';
  const ext = m[1].toLowerCase();
  return 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
}

const MB = 1024 * 1024;
const imageMax = () => (CONFIG.LIMITS.imageMaxMB || 5) * MB;
const fileMax = () => (CONFIG.LIMITS.fileMaxMB || 2) * MB;

/** Below this we keep the original bytes untouched — recompressing a small
 *  screenshot only makes it blurrier. */
const KEEP_AS_IS_BYTES = 480 * 1024;
/** What the ladder actually aims for. The hard ceiling is imageMaxMB. */
const TARGET_BYTES = 1_200_000;

const MAX_EDGES = [2560, 2048, 1600, 1280, 1024, 800];
const QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];

/* ---------------------------------------------------------------------------
   2. Canvas plumbing
   ------------------------------------------------------------------------ */

let webpSupport = null;
function supportsWebP() {
  if (webpSupport !== null) return webpSupport;
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    webpSupport = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch (_) { webpSupport = false; }
  return webpSupport;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') { resolve(null); return; }
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

/** Decode a File into something drawable. Throws Error('decode-failed'). */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* Safari + HEIC land here — fall through to <img> */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
    img.src = url;
  });
}

const sizeOf = (src) => ({
  w: src.width || src.naturalWidth || 0,
  h: src.height || src.naturalHeight || 0,
});

function drawScaled(src, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ---------------------------------------------------------------------------
   3. Compression
   ------------------------------------------------------------------------ */

function swapExt(name, ext) {
  const base = String(name || 'image').replace(/\.[^.]+$/, '');
  return (base || 'image') + '.' + ext;
}

/** Strip anything that could confuse a storage path or a download attribute. */
export function safeFileName(name) {
  const clean = String(name || 'file')
    .replace(/[^A-Za-z0-9 ._()-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'file').slice(0, 80);
}

/**
 * Shrink an image for chat.
 * @param {File} file
 * @param {{onProgress?:(f:number,label:string)=>void, targetBytes?:number}} [opts]
 * @returns {Promise<{blob:Blob,name:string,type:string,width:number,height:number,note:string|null,original:number}>}
 * @throws Error with .code = 'decode-failed' | 'heic-desktop' | 'too-big'
 */
export async function compressImage(file, opts) {
  const o = opts || {};
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const type = effectiveType(file);
  const target = o.targetBytes || TARGET_BYTES;
  const hardMax = imageMax();

  // Animated GIFs and vectors never touch the canvas.
  if (CANVAS_UNSAFE.test(type)) {
    if (/svg/.test(type)) {
      const err = new Error('SVG files are not accepted in chat.');
      err.code = 'svg';
      throw err;
    }
    if (file.size > hardMax) {
      const err = new Error('That GIF is ' + fmt.bytes(file.size) + ' — the limit is ' +
        CONFIG.LIMITS.imageMaxMB + ' MB.');
      err.code = 'too-big';
      throw err;
    }
    return { blob: file, name: safeFileName(file.name), type, width: 0, height: 0, original: file.size, note: null };
  }

  // Already small and in a format every browser opens: ship the original bytes.
  if (file.size <= KEEP_AS_IS_BYTES && /^image\/(png|jpeg|webp)$/.test(type)) {
    progress(1, 'Ready');
    return { blob: file, name: safeFileName(file.name), type, width: 0, height: 0, original: file.size, note: null };
  }

  progress(0.05, 'Reading the image');

  let src;
  try {
    src = await decode(file);
  } catch (err) {
    if (HEIC.test(type)) {
      const e = new Error('This is an iPhone HEIC photo and this browser cannot open it. ' +
        'On your phone it uploads fine; on a computer, save it as JPEG first.');
      e.code = 'heic-desktop';
      throw e;
    }
    const e = new Error('That image could not be read.');
    e.code = 'decode-failed';
    throw e;
  }

  const dims = sizeOf(src);
  if (!dims.w || !dims.h) {
    const e = new Error('That image could not be read.');
    e.code = 'decode-failed';
    throw e;
  }

  const outType = supportsWebP() ? 'image/webp' : 'image/jpeg';
  const ext = outType === 'image/webp' ? 'webp' : 'jpg';
  const longest = Math.max(dims.w, dims.h);

  let best = null;
  let step = 0;
  const totalSteps = MAX_EDGES.length * QUALITIES.length;

  for (const edge of MAX_EDGES) {
    const scale = longest > edge ? edge / longest : 1;
    const w = Math.round(dims.w * scale);
    const h = Math.round(dims.h * scale);
    const canvas = drawScaled(src, w, h);

    for (const q of QUALITIES) {
      step += 1;
      progress(0.05 + 0.5 * (step / totalSteps), 'Shrinking');
      /* eslint-disable no-await-in-loop */
      const blob = await toBlob(canvas, outType, q);
      /* eslint-enable no-await-in-loop */
      if (!blob) continue;
      if (!best || blob.size < best.blob.size) best = { blob, width: w, height: h };
      if (blob.size <= target) {
        if (src.close) src.close();
        progress(0.6, 'Ready');
        return {
          blob, name: swapExt(safeFileName(file.name), ext), type: outType,
          width: w, height: h, original: file.size,
          note: blob.size < file.size
            ? 'Compressed ' + fmt.bytes(file.size) + ' → ' + fmt.bytes(blob.size)
            : null,
        };
      }
    }
  }

  if (src.close) src.close();

  if (!best) {
    const e = new Error('That image could not be converted.');
    e.code = 'decode-failed';
    throw e;
  }
  if (best.blob.size > hardMax) {
    const e = new Error('Even after shrinking, that image is ' + fmt.bytes(best.blob.size) +
      ' — the limit is ' + CONFIG.LIMITS.imageMaxMB + ' MB.');
    e.code = 'too-big';
    throw e;
  }
  progress(0.6, 'Ready');
  return {
    blob: best.blob, name: swapExt(safeFileName(file.name), ext), type: outType,
    width: best.width, height: best.height, original: file.size,
    note: 'Compressed ' + fmt.bytes(file.size) + ' → ' + fmt.bytes(best.blob.size),
  };
}

/**
 * Turn a picked File into an upload-ready descriptor.
 * Images go through the compression ladder; everything else is size-checked.
 * @returns {Promise<{kind:'image'|'file', blob:Blob, name:string, type:string,
 *                    size:number, width:number, height:number, note:string|null}>}
 */
export async function prepareFile(file, opts) {
  if (!file) throw new Error('No file');

  /* SVG first, and here rather than in compressImage(): isImageFile() does not
     claim SVG (it is a script-bearing document, not a raster), so without this
     an .svg would slip through as an ordinary ≤2 MB file and the refusal in
     compressImage() would never run. Storage serves it with its own
     content-type, and a tab opened on that file executes its script on the
     storage origin — so it is refused before it is ever uploaded. */
  if (isSvgFile(file)) {
    const e = new Error('SVG files are not accepted in chat. Export it as PNG and send that.');
    e.code = 'svg';
    throw e;
  }

  if (isImageFile(file)) {
    const out = await compressImage(file, opts);
    return {
      kind: 'image', blob: out.blob, name: out.name, type: out.type,
      size: out.blob.size, width: out.width, height: out.height, note: out.note,
    };
  }
  if (file.size > fileMax()) {
    const e = new Error('“' + safeFileName(file.name) + '” is ' + fmt.bytes(file.size) +
      '. Files other than images have to be ' + CONFIG.LIMITS.fileMaxMB + ' MB or smaller.');
    e.code = 'too-big';
    throw e;
  }
  if (!file.size) {
    const e = new Error('That file is empty.');
    e.code = 'empty';
    throw e;
  }
  return {
    kind: 'file', blob: file, name: safeFileName(file.name),
    type: file.type || 'application/octet-stream', size: file.size,
    width: 0, height: 0, note: null,
  };
}

/* ---------------------------------------------------------------------------
   4. Upload
   ------------------------------------------------------------------------ */

function randomId() {
  const a = new Uint8Array(6);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(a);
  else for (let i = 0; i < a.length; i += 1) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a).map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** supabase/schema.sql §8: private bucket, 5 MB, first folder must be the uid. */
export const CHAT_BUCKET = 'attachments';
/** Public bucket for profile pictures (same schema section). */
export const AVATAR_BUCKET = 'avatars';

/**
 * Upload a prepared descriptor. sb.storage.upload has no progress channel in
 * the shared contract, so we report staged progress (prepared → uploading →
 * done) and pass an optional onProgress through in case the backend grows one.
 *
 * @param {object} sb the sb.js surface
 * @param {object} prepared output of prepareFile()
 * @param {{ownerId:string, bucket?:string, onProgress?:Function}} opts
 * @returns {Promise<{url:string, path:string, error:any}>}
 */
export async function uploadAttachment(sb, prepared, opts) {
  const o = opts || {};
  const bucket = o.bucket || CHAT_BUCKET;
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const ext = (/\.([a-z0-9]+)$/i.exec(prepared.name) || [, 'bin'])[1].toLowerCase();
  const path = String(o.ownerId || 'anon') + '/' + Date.now() + '-' + randomId() + '.' + ext;

  progress(0.7, 'Uploading');
  let res;
  try {
    res = await sb.storage.upload(bucket, path, prepared.blob, { onProgress: (f) => progress(0.7 + 0.3 * f, 'Uploading'), contentType: prepared.type });
  } catch (err) {
    return { url: '', path, error: { code: 'upload_failed', message: String((err && err.message) || err) } };
  }
  const out = res || {};
  if (out.error) return { url: '', path, error: out.error };
  progress(1, 'Done');
  const url = out.url || (sb.storage.publicUrl ? sb.storage.publicUrl(bucket, path) : '');
  return { url: url || '', path, error: null };
}

/** Best-effort cleanup when a message send fails after the upload succeeded. */
export async function removeAttachment(sb, path, bucket) {
  try { await sb.storage.remove(bucket || CHAT_BUCKET, path); } catch (_) { /* nothing to do */ }
}

/* ---------------------------------------------------------------------------
   5. Cards
   ------------------------------------------------------------------------ */

const FILE_ICON = [
  [/pdf/i, 'file-text'],
  [/zip|rar|7z|tar|gz/i, 'layers'],
  [/audio|mpeg|wav|ogg/i, 'mic'],
  [/video|mp4|webm|mov/i, 'play'],
  [/csv|sheet|excel/i, 'grid'],
  [/text|json|markdown|md/i, 'file-text'],
];

function iconForType(type) {
  for (const [re, name] of FILE_ICON) if (re.test(String(type || ''))) return name;
  return 'file-text';
}

/**
 * One attachment, Discord style.
 *
 * The `attachments` bucket is PRIVATE, so a stored message only carries a path;
 * the URL is a short-lived signed link. Pass `resolve: () => Promise<url>` and
 * the card fills itself in when the signature comes back.
 *
 * @param {{kind:string,name:string,url?:string,resolve?:Function,type:string,
 *          size:number,width:number,height:number}} att
 * @param {{onRemove?:Function}} [opts]
 */
export function attachmentCard(att, opts) {
  const o = opts || {};
  const a = att || {};

  if (a.kind === 'image') {
    const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
    const img = el('img.ch-att__img', {
      attrs: { alt: a.name || 'Shared image', loading: 'lazy', decoding: 'async' },
    });
    const box = el('button.ch-att.ch-att--img', {
      type: 'button',
      attrs: { 'aria-label': 'Open image ' + (a.name || '') },
      style: { '--ch-ratio': String(Math.max(0.4, Math.min(2.2, ratio))) },
      onClick: () => { if (a.url) openLightbox(a); },
    }, img);
    if (a.url) img.setAttribute('src', a.url);
    else {
      box.classList.add('is-loading');
      resolveInto(a, (url) => { a.url = url; img.setAttribute('src', url); box.classList.remove('is-loading'); });
    }
    return wrapRemovable(box, o);
  }

  const link = el('a.btn.btn-ghost.btn-icon.btn--sm', {
    attrs: {
      download: a.name || '', target: '_blank',
      rel: 'noopener noreferrer', 'aria-label': 'Download ' + (a.name || 'file'),
    },
  }, icon('download', { size: 14 }));
  if (a.url) link.setAttribute('href', a.url);
  else resolveInto(a, (url) => { a.url = url; link.setAttribute('href', url); });

  const card = el('div.ch-att.ch-att__file',
    el('span.icon-tile.icon-tile--sm', icon(iconForType(a.type), { size: 14 })),
    el('span.ch-att__meta',
      el('span.ch-att__name.truncate', { text: a.name || 'Attachment' }),
      el('span.ch-att__size.tabular', { text: fmt.bytes(a.size || 0) })),
    link
  );
  return wrapRemovable(card, o);
}

function resolveInto(att, apply) {
  if (typeof att.resolve !== 'function') return;
  Promise.resolve()
    .then(() => att.resolve())
    .then((url) => { if (url) apply(url); })
    .catch(() => { /* a missing signature just leaves the card blank */ });
}

function wrapRemovable(node, o) {
  if (!o.onRemove) return node;
  return el('div.ch-att-wrap', node, el('button.ch-att__x', {
    type: 'button', attrs: { 'aria-label': 'Remove attachment' }, onClick: o.onRemove,
  }, icon('x', { size: 12 })));
}

/** A row of attachment cards under a message body. */
export function attachmentRow(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return null;
  return el('div.ch-att-row', items.map((a) => attachmentCard(a)));
}

/* ---------------------------------------------------------------------------
   6. Lightbox — self-contained, no dependency on the chat shell
   ------------------------------------------------------------------------ */

let lightboxOpen = null;

export function openLightbox(att) {
  closeLightbox();
  const a = att || {};
  const previous = document.activeElement;
  const reduce = prefersReducedMotion();

  const scrim = el('div.scrim.ch-lightbox__scrim', { style: reduce ? { animation: 'none' } : null });
  const close = () => closeLightbox();

  const figure = el('div.ch-lightbox', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': a.name || 'Image' } },
    el('div.ch-lightbox__bar',
      el('span.ch-lightbox__name.truncate', { text: a.name || 'Image' }),
      el('div.row',
        a.url ? el('a.btn.btn-ghost.btn--sm', {
          attrs: { href: a.url, download: a.name || '', target: '_blank', rel: 'noopener noreferrer' },
        }, icon('download', { size: 14 }), 'Save') : null,
        el('button.btn.btn-ghost.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Close' }, onClick: close,
        }, icon('x', { size: 16 })))),
    el('img.ch-lightbox__img', { attrs: { src: a.url || '', alt: a.name || 'Shared image' } })
  );

  const offScrim = on(scrim, 'click', close);
  const offKey = on(document, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });

  document.body.appendChild(scrim);
  document.body.appendChild(figure);
  const btn = figure.querySelector('button');
  if (btn) btn.focus();

  lightboxOpen = () => {
    offScrim(); offKey();
    scrim.remove(); figure.remove();
    if (previous && typeof previous.focus === 'function') previous.focus();
  };
  return lightboxOpen;
}

export function closeLightbox() {
  if (lightboxOpen) { const fn = lightboxOpen; lightboxOpen = null; fn(); }
}

export default {
  isImageFile, isSvgFile, compressImage, prepareFile, uploadAttachment, removeAttachment,
  attachmentCard, attachmentRow, openLightbox, closeLightbox, safeFileName, CHAT_BUCKET,
};
