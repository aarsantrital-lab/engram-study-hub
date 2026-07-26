/* =============================================================================
   js/community.js — shared items (decks · maps · notes): the editors, the
   browse/consume surfaces, the import-to-my-FSRS path, and the small utilities
   that me.js / maps.js / settings.js share (overlay sheet, confirm, local image
   compression, safe lazy access to game.js and sb.js).

   Owner: Job — profile + community editors + settings.
   Imports: config.js · store.js · dom.js · scheduler.js · router.js   (all frozen)

   CONTRACTS HONOURED
     · shared_items row  {id, owner_id, type, title, body, group_id,
                          created_at, updated_at}   body = JSON string
       deck body = {cards:[{q,a,type}]}  (this module adds pacer/cognitive/
       misconceptions/lesson fields alongside — additive, never replacing)
     · sb.js is reached ONLY through the documented surface, and lazily: the
       hub must boot with sb.js absent, so it is a dynamic import behind a
       cached promise that resolves to null on failure.
     · game.js likewise (a read-only store-backed shim stands in when absent).
     · window CustomEvent 'engram:import-deck' {deck, …} on import.
     · Persistence is store.js only. Never raw localStorage.
     · Markdown is rendered only through dom.md() → md.js (sanitised).
     · Scientific notation is a × 10ⁿ; e-notation in student content is a
       validation ERROR, not a style note.
   ========================================================================== */

import CONFIG, { hasSupabase } from './config.js';
import { store, KEYS, uid, todayLocalISO } from './store.js';
import {
  el, replace, clear, icon, fmt, toast, haptic, md, emptyState, spinner, debounce, clamp,
} from './dom.js';
import { initCard } from './scheduler.js';
import { getSubjects } from './vault.js';
import { navigate } from './router.js';

/* =============================================================================
   1. CONSTANTS
   ========================================================================== */

/** shared_items.type — the three things that can be shared. */
export const ITEM_TYPES = Object.freeze(['deck', 'map', 'note']);

export const TYPE_META = Object.freeze({
  deck: { label: 'Deck', icon: 'layers', tone: 'brand', plural: 'Decks' },
  map: { label: 'Map', icon: 'waypoints', tone: 'ai', plural: 'Maps' },
  note: { label: 'Note', icon: 'file-text', tone: 'info', plural: 'Notes' },
});

/** flashcards-template.md §"The metadata fields" — kept identical on purpose. */
export const CARD_TYPES = Object.freeze([
  'explain', 'relational', 'freerecall', 'transfer', 'numerical', 'cloze', 'definition',
]);
export const COGNITIVE_LEVELS = Object.freeze(['knowledge', 'understanding', 'application', 'higher']);
export const PACER_CODES = Object.freeze(['P', 'A', 'C', 'E', 'R']);
export const PACER_LABEL = Object.freeze({
  P: 'P · procedural', A: 'A · analogous', C: 'C · conceptual',
  E: 'E · evidence', R: 'R · arbitrary',
});
/** The CDC grid the deck's cognitive mix is measured against (pedagogy §5.3). */
export const CDC_MIX = Object.freeze({ knowledge: 15, understanding: 25, application: 35, higher: 25 });

/** The five profile statuses (me.js renders the picker; stored in KEYS.PROFILE). */
export const STATUSES = Object.freeze([
  { id: 'studying', label: 'Studying now', icon: 'book-open', tone: 'brand' },
  { id: 'numericals', label: 'On numericals', icon: 'calculator', tone: 'info' },
  { id: 'revising', label: 'Revision run', icon: 'layers', tone: 'ai' },
  { id: 'exam', label: 'Exam window', icon: 'graduation-cap', tone: 'warn' },
  { id: 'resting', label: 'Resting', icon: 'moon', tone: 'neutral' },
]);

/**
 * Avatar frames. Cosmetic only — they re-point --accent on the avatar ring and
 * nothing else. Unlock rule is the count of EARNED titles from game.getTitles(),
 * so a frame is always the visible half of something already earned.
 */
export const FRAMES = Object.freeze([
  { id: 'plain', label: 'Plain', tone: 'neutral', needTitles: 0 },
  { id: 'ember', label: 'Ember', tone: 'brand', needTitles: 1 },
  { id: 'frost', label: 'Frost', tone: 'info', needTitles: 2 },
  { id: 'nebula', label: 'Nebula', tone: 'ai', needTitles: 3 },
  { id: 'summit', label: 'Summit', tone: 'good', needTitles: 5 },
]);

/** Local (non-KEYS) store slot for community prefs, group list and offline drafts. */
const COMMUNITY_KEY = 'community';

const DEFAULT_COMMUNITY = Object.freeze({
  group: '',                 // '' = private / just me
  groups: [],                // [{id, label}] joined by code
  drafts: {},                // localId -> row (offline / no-Supabase saves)
  leaderboard: false,        // opt-in, default OFF (pedagogy §4 ban on ranking)
});

/* =============================================================================
   2. SMALL PURE HELPERS
   ========================================================================== */

export function slugify(s) {
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[^\wऀ-ॿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

/** Stable 12-hex id from text. Deterministic across devices — no crypto needed. */
export function hash12(text) {
  const s = String(text == null ? '' : text);
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul((h2 + c) >>> 0, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

const trim = (v) => String(v == null ? '' : v).trim();

/** A <select> built the way el() can actually set a value (options first). */
export function selectField(values, current, onChange, opts) {
  const o = opts || {};
  const node = el('select.select', {
    attrs: o.label ? { 'aria-label': o.label } : null,
    onChange: (e) => onChange(e.target.value),
  });
  for (const v of values) {
    const val = typeof v === 'string' ? v : v.value;
    const lbl = typeof v === 'string' ? v : v.label;
    node.appendChild(el('option', { value: val, text: lbl }));
  }
  node.value = current == null ? '' : String(current);
  if (node.selectedIndex < 0 && node.options.length) node.selectedIndex = 0;
  return node;
}

/** Standard labelled field wrapper. */
export function field(label, control, hint, opts) {
  const o = opts || {};
  return el('div.field',
    label ? el('label.label', { class: o.required ? 'label--req' : null, text: label }) : null,
    control,
    hint ? el('div.hint', { class: o.error ? 'hint--error' : null, text: hint }) : null);
}

/* =============================================================================
   3. LAZY BRIDGES TO game.js AND sb.js
      Both files belong to other agents and may not exist yet. A static import
      would take the whole registry down with it, so both are dynamic, cached,
      and null-safe.
   ========================================================================== */

let sbPromise = null;
let gamePromise = null;

/** @returns {Promise<Object|null>} the sb façade, or null when unavailable. */
export function loadSb() {
  if (sbPromise) return sbPromise;
  sbPromise = import('./sb.js')
    .then((m) => (m && (m.sb || m.default)) || null)
    .catch(() => null);
  return sbPromise;
}

/** True only when sb.js exists AND reports itself configured. */
export async function sbReady() {
  if (!hasSupabase()) return false;
  const sb = await loadSb();
  if (!sb) return false;
  try { return Boolean(typeof sb.ready === 'function' ? sb.ready() : false); }
  catch (_) { return false; }
}

/** The signed-in user, or null. Never throws. */
export async function currentUser() {
  const sb = await loadSb();
  if (!sb || !sb.auth || typeof sb.auth.user !== 'function') return null;
  try {
    const u = sb.auth.user();
    return (u && typeof u.then === 'function') ? await u : u;
  } catch (_) { return null; }
}

/* --- game.js shim -----------------------------------------------------------
   Read-only, honest, and store-backed. It NEVER writes game state (that would
   fight the real owner); recordActivity/awardXP become logged no-ops. */
const GAME_SHIM = Object.freeze({
  __shim: true,
  getRings() {
    const day = store.get(KEYS.RINGS, {}) || {};
    const t = day[todayLocalISO()] || {};
    const ring = (k, goal) => ({
      done: Number(t[k] && t[k].done) || 0,
      goal: Number(t[k] && t[k].goal) || goal,
    });
    return { review: ring('review', 1), encode: ring('encode', 1), drill: ring('drill', 1) };
  },
  recordActivity() { return false; },
  awardXP() { return false; },
  getStreak() {
    const s = store.get(KEYS.STREAK, {}) || {};
    return {
      current: Number(s.count) || 0,
      lifetime: Number(s.lifetimeDays) || 0,
      freezesLeft: Number(s.freezes) || 0,
      longest: Number(s.longest) || 0,
    };
  },
  getLevelInfo() {
    const g = store.get(KEYS.GAME, {}) || {};
    const xp = Number(g.xp) || 0;
    const level = Number(g.level) || 1;
    return { level, xp, xpIntoLevel: xp, xpForNext: 0, label: 'Level ' + level };
  },
  getTitles() {
    const g = store.get(KEYS.GAME, {}) || {};
    const list = Array.isArray(g.titles) ? g.titles : [];
    return list.map((t) => (typeof t === 'string'
      ? { id: t, label: t, earned: true }
      : { id: String(t && t.id), label: String((t && t.label) || (t && t.id) || ''), earned: t && t.earned !== false }));
  },
  getPetState() { return store.get(KEYS.PET, null); },
  on() { return () => {}; },
});

/**
 * The game layer, or a read-only shim with the same surface.
 * @returns {Promise<Object>} never null — callers can always call through.
 */
export function loadGame() {
  if (gamePromise) return gamePromise;
  gamePromise = import('./game.js')
    .then((m) => {
      for (const cand of [m && m.game, m && m.default, m]) {
        if (cand && typeof cand.getStreak === 'function') return cand;
      }
      return GAME_SHIM;
    })
    .catch(() => GAME_SHIM);
  return gamePromise;
}

/** Fire-and-forget milestone. Never blocks a save, never throws. */
function creditGame(kind, meta) {
  loadGame().then((g) => {
    try { if (typeof g.recordMilestone === 'function') g.recordMilestone(kind, meta); }
    catch (err) { console.warn('[community] milestone ' + kind + ' failed', err); }
  });
}

/* =============================================================================
   4. COMMUNITY PREFS + GROUPS  (store.js only)
   ========================================================================== */

export function getCommunityState() {
  const raw = store.get(COMMUNITY_KEY, null);
  const s = Object.assign({}, DEFAULT_COMMUNITY, raw && typeof raw === 'object' ? raw : {});
  s.groups = Array.isArray(s.groups) ? s.groups : [];
  s.drafts = (s.drafts && typeof s.drafts === 'object') ? s.drafts : {};
  return s;
}

export function patchCommunityState(patch) {
  const next = Object.assign(getCommunityState(), patch || {});
  const ok = store.set(COMMUNITY_KEY, next);
  if (!ok) warnQuota();
  return next;
}

/** [{id,label}] — '' is always first and means "private, just me". */
export function getGroups() {
  const s = getCommunityState();
  return [{ id: '', label: 'Just me (private)' }].concat(
    s.groups.filter((g) => g && g.id).map((g) => ({ id: String(g.id), label: String(g.label || g.id) })));
}

export function currentGroup() { return getCommunityState().group || ''; }

export function setCurrentGroup(id) { return patchCommunityState({ group: id == null ? '' : String(id) }); }

/**
 * groups.name is `text unique check (char_length between 1 and 40)`, so the
 * human code IS the group name. Slugs longer than that are rejected rather
 * than truncated — two friends typing slightly different long codes must not
 * silently land in the same group.
 */
export const GROUP_CODE_MAX = 40;

export function normaliseGroupCode(code) {
  const id = slugify(code);
  if (!id || id === 'item') return { ok: false, error: 'Enter a group code first.' };
  if (id.length > GROUP_CODE_MAX) {
    return { ok: false, error: 'Group codes are ' + GROUP_CODE_MAX + ' characters at most.' };
  }
  return { ok: true, id };
}

/** Join a group by its code. Codes are slugs the students agree on offline. */
export function joinGroup(code, label) {
  const parsed = normaliseGroupCode(code);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const id = parsed.id;
  const s = getCommunityState();
  if (s.groups.some((g) => g.id === id)) return { ok: false, error: 'You are already in that group.' };
  const groups = s.groups.concat([{ id, label: trim(label) || id, uuid: null }]);
  patchCommunityState({ groups, group: id });
  return { ok: true, id };
}

export function leaveGroup(id) {
  const s = getCommunityState();
  const groups = s.groups.filter((g) => g.id !== id);
  patchCommunityState({ groups, group: s.group === id ? '' : s.group });
  return true;
}

/* --- group code -> groups.id (uuid) -----------------------------------------
   shared_items.group_id is a uuid FK to public.groups. The rest of this module
   speaks in human codes, so every cloud call resolves the code to its row id
   first and caches it. A code that cannot be resolved keeps the item LOCAL —
   it is never quietly published somewhere else. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) { return UUID_RE.test(String(v == null ? '' : v)); }

function cachedGroupUuid(code) {
  const g = getCommunityState().groups.find((x) => x && x.id === code);
  return (g && isUuid(g.uuid)) ? String(g.uuid) : null;
}

function cacheGroupUuid(code, uuid) {
  const s = getCommunityState();
  if (!s.groups.some((g) => g && g.id === code)) return;
  patchCommunityState({
    groups: s.groups.map((g) => (g && g.id === code ? Object.assign({}, g, { uuid }) : g)),
  });
}

/**
 * @param {string} code group code (or an already-resolved uuid)
 * @param {{create?:boolean}} [opts] create the group row when it does not exist
 * @returns {Promise<{uuid:string|null, error:string|null, offline?:boolean, missing?:boolean}>}
 */
export async function resolveGroupUuid(code, opts) {
  const o = opts || {};
  if (isUuid(code)) return { uuid: String(code), error: null };
  const parsed = normaliseGroupCode(code);
  if (!parsed.ok) return { uuid: null, error: parsed.error };
  const name = parsed.id;

  const hit = cachedGroupUuid(name);
  if (hit) return { uuid: hit, error: null };

  if (!(await sbReady())) return { uuid: null, error: null, offline: true };
  const sb = await loadSb();
  const user = await currentUser();
  if (!user) return { uuid: null, error: null, offline: true };

  const lookup = async () => {
    const res = await sb.db.select('groups', { filters: { name }, limit: 1 });
    if (res && res.error) return { row: null, error: errText(res.error) };
    const row = Array.isArray(res && res.data) ? res.data[0] : (res && res.data);
    return { row: row || null, error: null };
  };

  try {
    const found = await lookup();
    if (found.error) return { uuid: null, error: found.error };
    if (found.row && found.row.id) {
      cacheGroupUuid(name, found.row.id);
      await ensureMembership(sb, found.row.id, user.id);
      return { uuid: found.row.id, error: null };
    }
    if (!o.create) return { uuid: null, error: null, missing: true };

    const ins = await sb.db.insert('groups', { name, created_by: user.id });
    if (ins && ins.error) {
      /* Someone created it between the read and the write — read it back. */
      const again = await lookup();
      if (again.row && again.row.id) {
        cacheGroupUuid(name, again.row.id);
        await ensureMembership(sb, again.row.id, user.id);
        return { uuid: again.row.id, error: null };
      }
      return { uuid: null, error: errText(ins.error) };
    }
    const row = Array.isArray(ins && ins.data) ? ins.data[0] : (ins && ins.data);
    if (row && row.id) { cacheGroupUuid(name, row.id); return { uuid: row.id, error: null }; }
    return { uuid: null, error: 'The group was created but did not come back.' };
  } catch (err) {
    return { uuid: null, error: errText(err) };
  }
}

/**
 * Joining by code has to actually make you a MEMBER.
 *
 * Resolving a code to a uuid used to be the whole of "join": nothing ever wrote
 * a group_members row, so every share into a group you did not create failed
 * shared_items_insert's in_group() check and fell back to a local draft
 * carrying a raw RLS message. schema.sql now has group_members_join_self
 * (yourself only, role 'member', not while banned); this is the one caller.
 *
 * Never throws and never blocks the caller: on an older database without the
 * policy the insert is simply refused and the read path still works.
 */
async function ensureMembership(sb, groupUuid, userId) {
  if (!sb || !sb.db || !groupUuid || !userId) return;
  try {
    const mine = await sb.db.select('group_members', {
      filters: { group_id: groupUuid, user_id: userId }, limit: 1,
    });
    const existing = Array.isArray(mine && mine.data) ? mine.data[0] : (mine && mine.data);
    if (existing) return;
    await sb.db.insert('group_members', { group_id: groupUuid, user_id: userId, role: 'member' });
  } catch (_) { /* not a member and could not become one — the read path is unaffected */ }
}

function warnQuota() {
  toast('Storage is full — that change is held in memory only. Export a backup from Settings.',
    { tone: 'warn', timeout: 8000 });
}

/* =============================================================================
   5. OVERLAY SHEET + CONFIRM
      .scrim + .sheet (components.css auto-promotes .sheet to a centred modal
      at >=768px). Focus is trapped, Escape closes, motion is CSS-only so
      prefers-reduced-motion is already honoured by theme.css.
   ========================================================================== */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * @param {{title:string, subtitle?:string, body?:Node|Node[], foot?:Node|Node[],
 *          onClose?:Function, dismissible?:boolean}} opts
 * @returns {{node:HTMLElement, body:HTMLElement, close:Function, setFoot:Function}}
 */
export function openSheet(opts) {
  const o = opts || {};
  const prevFocus = document.activeElement;
  const titleId = 'sheet-t-' + uid('x').replace(/[^a-z0-9-]/gi, '');
  let closed = false;

  const bodyNode = el('div.modal__body', o.body || null);
  const footNode = el('div.modal__foot', o.foot || null);
  if (!o.foot) footNode.hidden = true;

  const sheet = el('div.sheet', {
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
  },
    el('span.sheet__grip'),
    el('div.modal__head',
      el('div',
        el('div.modal__title', { id: titleId, text: o.title || '' }),
        o.subtitle ? el('div.card__sub', { text: o.subtitle }) : null),
      el('button.btn-icon', {
        type: 'button', attrs: { 'aria-label': 'Close' }, onClick: () => close(),
      }, icon('x', { size: 16 }))),
    bodyNode,
    footNode);

  const scrim = el('div.scrim', {
    onClick: () => { if (o.dismissible !== false) close(); },
  });

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); if (o.dismissible !== false) close(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(sheet.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    sheet.remove();
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_) { /* gone */ }
    if (typeof o.onClose === 'function') o.onClose();
  }

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);

  const firstField = sheet.querySelector('input,textarea,select,button.btn-primary');
  try { (firstField || sheet).focus(); } catch (_) { /* non-fatal */ }

  return {
    node: sheet,
    body: bodyNode,
    close,
    setFoot(...children) { clear(footNode); footNode.hidden = false; children.flat(3).forEach((c) => c && footNode.appendChild(c)); },
  };
}

/**
 * Confirmation sheet. `acknowledge` adds a checkbox that must be ticked before
 * the destructive button enables — the "double confirm" the danger zone needs.
 * @returns {Promise<boolean>}
 */
export function confirmSheet(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; sheet.close(); resolve(v); };

    const confirmBtn = el('button.btn', {
      type: 'button',
      class: o.tone === 'bad' ? 'btn-danger' : 'btn-primary',
      text: o.confirmLabel || 'Confirm',
      onClick: () => finish(true),
    });
    if (o.acknowledge) confirmBtn.disabled = true;

    const ackBox = o.acknowledge
      ? el('label.check',
          el('input.check__input', {
            type: 'checkbox',
            onChange: (e) => { confirmBtn.disabled = !e.target.checked; },
          }),
          el('span.check__box', icon('check', { size: 12 })),
          el('span.check__text', { text: o.acknowledge }))
      : null;

    const sheet = openSheet({
      title: o.title || 'Are you sure?',
      body: [
        o.body ? el('p.text-body-lg', { text: o.body }) : null,
        o.detail ? el('p.hint', { text: o.detail }) : null,
        ackBox,
      ],
      foot: [
        el('button.btn.btn-ghost', { type: 'button', text: o.cancelLabel || 'Cancel', onClick: () => finish(false) }),
        confirmBtn,
      ],
      onClose: () => finish(false),
    });
  });
}

/* =============================================================================
   6. LOCAL IMAGE COMPRESSION  (canvas only — zero external origins)
   ========================================================================== */

/**
 * Downscale + re-encode an image entirely in the browser.
 * @param {File|Blob} file
 * @param {{maxDim?:number, maxBytes?:number, mime?:string, quality?:number}} [opts]
 * @returns {Promise<{dataUrl:string, blob:Blob|null, width:number, height:number, bytes:number}>}
 */
export async function compressImage(file, opts) {
  const o = Object.assign({ maxDim: 320, maxBytes: 90000, mime: 'image/jpeg', quality: 0.86 }, opts || {});
  if (!file) throw new Error('No image chosen.');
  if (!/^image\//.test(file.type || '')) throw new Error('That file is not an image.');
  const maxIn = (CONFIG.LIMITS.imageMaxMB || 5) * 1024 * 1024;
  if (file.size > maxIn) throw new Error('Images must be under ' + CONFIG.LIMITS.imageMaxMB + ' MB.');

  const src = await decodeImage(file);
  const scale = Math.min(1, o.maxDim / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not process the image.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.image, 0, 0, w, h);
  if (typeof src.close === 'function') src.close();

  let quality = o.quality;
  let dataUrl = canvas.toDataURL(o.mime, quality);
  // Walk the quality down until the payload fits; never below 0.4.
  while (dataUrlBytes(dataUrl) > o.maxBytes && quality > 0.4) {
    quality = Math.round((quality - 0.1) * 100) / 100;
    dataUrl = canvas.toDataURL(o.mime, quality);
  }

  const blob = await new Promise((res) => {
    if (!canvas.toBlob) { res(null); return; }
    canvas.toBlob((b) => res(b), o.mime, quality);
  });

  return { dataUrl, blob, width: w, height: h, bytes: dataUrlBytes(dataUrl) };
}

function dataUrlBytes(url) {
  const i = String(url).indexOf(',');
  return i < 0 ? 0 : Math.round((String(url).length - i - 1) * 3 / 4);
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
    } catch (_) { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('That image could not be read.'));
      i.src = url;
    });
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/* =============================================================================
   7. CARD + DECK VALIDATION
      flashcards-template.md rules 2, 3, 4, 6, 7 turned into checkable heuristics.
      Severity: 'error' blocks sharing · 'warn' is advisory.
   ========================================================================== */

const RECOGNITION_STEMS = /(which of the following|all of the above|none of the above|true or false|tick the correct)/i;
const IMPERATIVES = /^(state|explain|calculate|describe|write|derive|compare|define|show|find|name|give|list|draw|predict|justify|balance|identify|prove|convert|sketch|outline|distinguish|account for)\b/i;
const E_NOTATION = /\d\s*[eE][+-]?\s*\d/;
const CS_ANALOGY = /\b(cpu|ram\b|hard drive|computer memory|like a computer|like a program|source code|compiler|database|boolean|pointer|algorithm)\b/i;

/**
 * Heuristics for "the question is a pure cue".
 * @returns {Array<{severity:'error'|'warn', message:string}>}
 */
export function validateQuestion(q, answer) {
  const out = [];
  const question = trim(q);
  const a = trim(answer);
  if (!question) { out.push({ severity: 'error', message: 'The question is empty.' }); return out; }
  if (question.length < 12) out.push({ severity: 'error', message: 'Too short to be a real cue — say what is being asked.' });
  if (RECOGNITION_STEMS.test(question)) {
    out.push({ severity: 'error', message: 'Recognition stem. A card trains recall, not multiple choice — rewrite it as a cue.' });
  }
  if ((question.match(/\?/g) || []).length > 1) {
    out.push({ severity: 'error', message: 'Two questions in one card. One idea per card — split it.' });
  }
  if (!/\?$/.test(question) && !IMPERATIVES.test(question)) {
    out.push({ severity: 'warn', message: 'Not phrased as a question or an instruction ("State…", "Calculate…").' });
  }
  if (a) {
    const leak = answerLeak(question, a);
    /* Advisory, not blocking: a repeated word is evidence, not proof. Blocking
       on a fuzzy match would stop him writing perfectly good cards. */
    if (leak) {
      out.push({
        severity: 'warn',
        message: 'The stem repeats “' + leak + '” from the answer — check it is a cue, not a giveaway.',
      });
    }
  }
  if (E_NOTATION.test(question)) {
    out.push({ severity: 'error', message: 'Write powers of ten as a × 10ⁿ — never e-notation.' });
  }
  if (CS_ANALOGY.test(question)) {
    out.push({ severity: 'warn', message: 'Reads like a computing analogy. Use money, cooking, cricket or daily life instead.' });
  }
  return out;
}

/**
 * The longest distinctive answer word (>=7 letters) that also sits in the stem.
 * Common academic verbs and framing words are excluded — sharing "measures" or
 * "explains" between a question and its answer is normal English, not a leak.
 */
const LEAK_STOP = new Set([
  'because', 'between', 'through', 'therefore', 'without', 'against', 'another',
  'formula', 'equation', 'problem', 'example', 'question', 'following', 'measure',
  'measures', 'measured', 'calculate', 'calculated', 'chemistry', 'physics',
  'explain', 'explains', 'describe', 'describes', 'differs', 'different', 'difference',
  'contains', 'controls', 'produces', 'requires', 'happens', 'depends', 'changes',
  'balance', 'increase', 'increases', 'decrease', 'decreases', 'consider', 'compared',
  'related', 'relation', 'formulae', 'particles', 'reaction', 'reactions', 'process',
  'general', 'specific', 'certain', 'usually', 'exactly', 'instead', 'whether',
]);

function answerLeak(question, answer) {
  const qWords = new Set(question.toLowerCase().match(/[a-zऀ-ॿ]{7,}/g) || []);
  const aWords = (answer.toLowerCase().match(/[a-zऀ-ॿ]{7,}/g) || []);
  let best = '';
  for (const w of aWords) {
    if (LEAK_STOP.has(w) || !qWords.has(w)) continue;
    if (w.length > best.length) best = w;
  }
  return best;
}

/** Per-card checks (question heuristics + template metadata rules). */
export function validateCard(card) {
  const c = card || {};
  const out = validateQuestion(c.q, c.a);
  const a = trim(c.a);
  if (!a) out.push({ severity: 'error', message: 'The answer is empty.' });
  if (E_NOTATION.test(a)) out.push({ severity: 'error', message: 'Answer uses e-notation. Write a × 10ⁿ.' });
  if (CS_ANALOGY.test(a)) out.push({ severity: 'warn', message: 'Answer reads like a computing analogy — swap it for a daily-life one.' });
  if (/\band also\b/i.test(a)) out.push({ severity: 'warn', message: 'Answer contains "and also" — that is two cards.' });
  if (c.type === 'definition' && c.pacer !== 'R') {
    out.push({ severity: 'error', message: 'Cued definitions are for genuinely arbitrary facts only — set PACER to R, or change the type.' });
  }
  if (c.type === 'numerical' && a && !/[0-9]/.test(a)) {
    out.push({ severity: 'warn', message: 'A numerical card with no number in the worked answer.' });
  }
  if (c.type && !CARD_TYPES.includes(c.type)) out.push({ severity: 'error', message: 'Unknown card type.' });
  return out;
}

/**
 * Whole-deck validation.
 * @returns {{ok:boolean, errors:number, warnings:number, perCard:Array, deckIssues:Array, mix:Object}}
 */
export function validateDeck(deck) {
  const cards = (deck && Array.isArray(deck.cards)) ? deck.cards : [];
  const perCard = cards.map((c) => validateCard(c));
  const deckIssues = [];

  if (!cards.length) deckIssues.push({ severity: 'error', message: 'A deck needs at least one card.' });
  if (cards.length && !cards.some((c) => c.type === 'explain')) {
    deckIssues.push({ severity: 'warn', message: 'No "explain" card. At least one per topic is the rule — if nothing can be explained, the topic was not understood.' });
  }
  if (cards.length > 20) {
    deckIssues.push({ severity: 'warn', message: 'Over 20 cards. 8–20 is the target; a big deck usually means a method is being memorised instead of encoded.' });
  }
  const seen = new Map();
  cards.forEach((c, i) => {
    const key = trim(c.q).toLowerCase();
    if (!key) return;
    if (seen.has(key)) {
      perCard[i].push({ severity: 'error', message: 'Duplicate of card ' + (seen.get(key) + 1) + '.' });
    } else seen.set(key, i);
  });

  /* Blank rows in the editor must not skew the mix meter. */
  const mix = cognitiveMix(cards.filter((c) => trim(c && c.q)));
  const application = mix.pct.application + mix.pct.higher;
  if (cards.length >= 5 && application < 40) {
    deckIssues.push({ severity: 'warn', message: 'Only ' + application + '% of this deck is application or higher. The NEB grid is about 60% — a knowledge-heavy deck trains the wrong thing.' });
  }

  let errors = deckIssues.filter((x) => x.severity === 'error').length;
  let warnings = deckIssues.filter((x) => x.severity === 'warn').length;
  for (const list of perCard) {
    errors += list.filter((x) => x.severity === 'error').length;
    warnings += list.filter((x) => x.severity === 'warn').length;
  }
  return { ok: errors === 0, errors, warnings, perCard, deckIssues, mix };
}

/** Counts + percentages per cognitive level, beside the CDC target. */
export function cognitiveMix(cards) {
  const count = { knowledge: 0, understanding: 0, application: 0, higher: 0 };
  for (const c of cards || []) if (count[c && c.cognitive] !== undefined) count[c.cognitive] += 1;
  const total = Object.values(count).reduce((a, b) => a + b, 0) || 1;
  const pct = {};
  for (const k of COGNITIVE_LEVELS) pct[k] = Math.round((count[k] / total) * 100);
  return { count, pct, total: Object.values(count).reduce((a, b) => a + b, 0), target: CDC_MIX };
}

/* =============================================================================
   8. shared_items ACCESS  (sb.js when present; local drafts otherwise)
   ========================================================================== */

const TABLE = 'shared_items';

function nowIso() { return new Date().toISOString(); }   // a TIMESTAMP, not day math

/** Parse a row's JSON body defensively — a broken body must never throw. */
export function parseBody(row) {
  if (!row) return null;
  const b = row.body;
  if (b && typeof b === 'object') return b;
  try { return JSON.parse(String(b || 'null')); }
  catch (_) { return null; }
}

/**
 * Human label for a row's scope. Cloud rows carry a uuid in group_id, which is
 * meaningless on screen — map it back to the code he typed where we can.
 */
export function groupLabelOf(row) {
  const gid = row && row.group_id ? String(row.group_id) : '';
  if (!gid) return (row && row.local) ? 'private' : 'everyone signed in';
  const hit = getCommunityState().groups.find((g) => g && (g.id === gid || g.uuid === gid));
  if (hit) return String(hit.label || hit.id);
  return isUuid(gid) ? 'a group' : gid;
}

export function isOwner(row, userId) {
  if (!row) return false;
  if (row.local) return true;
  return Boolean(userId && row.owner_id && String(row.owner_id) === String(userId));
}

/** Empty deck body, ready for the editor. */
export function blankDeck(seed) {
  return Object.assign({ version: 1, subject: '', unit: '', cards: [blankCard()] }, seed || {});
}

export function blankCard() {
  return { q: '', a: '', type: 'explain', cognitive: 'understanding', pacer: 'C', misconceptions: '', lesson: '' };
}

/**
 * List shared items.
 * @param {{type?:string, group?:string, ownerOnly?:boolean, limit?:number}} [opts]
 * @returns {Promise<{rows:Array, error:string|null, offline:boolean}>}
 */
export async function listItems(opts) {
  const o = opts || {};
  const local = localDrafts(o);
  const ready = await sbReady();
  if (!ready) return { rows: local, error: null, offline: true };

  /* The private shelf ('') lives only on this device — there is no such thing
     as a private row in shared_items. Asking the server for one would return
     everything shared with everyone. */
  const scoped = o.group !== undefined && o.group !== null;
  if (scoped && !o.group) return { rows: local, error: null, offline: false, private: true };

  const sb = await loadSb();
  const user = await currentUser();
  const filters = {};
  if (o.type) filters.type = o.type;
  if (scoped) {
    const resolved = await resolveGroupUuid(o.group);
    if (!resolved.uuid) {
      return {
        rows: local,
        error: resolved.error || null,
        offline: Boolean(resolved.offline),
        missingGroup: Boolean(resolved.missing),
      };
    }
    filters.group_id = resolved.uuid;
  }
  if (o.ownerOnly) {
    if (!user) return { rows: local, error: null, offline: true };
    filters.owner_id = user.id;
  }
  try {
    const res = await sb.db.select(TABLE, {
      filters,
      order: { column: 'updated_at', ascending: false },
      limit: o.limit || 60,
    });
    if (res && res.error) return { rows: local, error: errText(res.error), offline: false };
    const rows = Array.isArray(res && res.data) ? res.data : [];
    return { rows: local.concat(rows), error: null, offline: false };
  } catch (err) {
    return { rows: local, error: errText(err), offline: false };
  }
}

function localDrafts(o) {
  const drafts = Object.values(getCommunityState().drafts || {});
  return drafts
    .filter((d) => d && (!o.type || d.type === o.type))
    .filter((d) => (o.group === undefined || o.group === null) ? true : (d.group_id || '') === (o.group || ''))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map((d) => Object.assign({}, d, { local: true }));
}

function errText(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  const m = e.message || e.code || 'Request failed';
  return e.retryAfterSec ? m + ' — try again in ' + e.retryAfterSec + 's.' : String(m);
}

/**
 * Create or update a shared item. Falls back to a durable LOCAL draft when
 * Supabase is not configured or the write fails, so nothing a student typed is
 * ever thrown away.
 * @returns {Promise<{ok:boolean, row:Object|null, local:boolean, error:string|null}>}
 */
/** shared_items.body is capped at 200 KB by the table's own check constraint. */
export const BODY_MAX_BYTES = 204800;

function byteLength(s) {
  try { return new TextEncoder().encode(String(s)).length; }
  catch (_) { return String(s).length; }
}

export async function saveItem(input) {
  const i = input || {};
  const type = ITEM_TYPES.includes(i.type) ? i.type : 'note';
  const title = trim(i.title).slice(0, 120);
  const body = typeof i.body === 'string' ? i.body : JSON.stringify(i.body || {});
  /* '' = private. The schema treats shared_items.group_id IS NULL as "visible
     to every signed-in member", so a private item must never be written to the
     cloud with a null group — it stays on this device, exactly as the editors
     promise. */
  const scope = i.group_id ? String(i.group_id) : '';
  if (!title) return { ok: false, row: null, local: false, error: 'Give it a title first.' };
  if (byteLength(body) > BODY_MAX_BYTES) {
    return { ok: false, row: null, local: false, error: 'That is too big to share (limit ' + fmt.bytes(BODY_MAX_BYTES) + '). Split it into two.' };
  }

  const ready = await sbReady();
  const user = ready ? await currentUser() : null;
  const isLocalId = Boolean(i.id && String(i.id).startsWith('local-'));

  if (ready && user && scope && !isLocalId) {
    const resolved = await resolveGroupUuid(scope, { create: true });
    if (!resolved.uuid) {
      return saveLocal(i, {
        type, title, body, group_id: scope,
        error: resolved.error || 'Could not reach that group — saved on this device instead.',
      });
    }
    const sb = await loadSb();
    try {
      const patch = { type, title, body, group_id: resolved.uuid, updated_at: nowIso() };
      const res = i.id
        ? await sb.db.update(TABLE, i.id, patch)
        : await sb.db.insert(TABLE, Object.assign({ owner_id: user.id, created_at: nowIso() }, patch));
      if (res && res.error) return saveLocal(i, { type, title, body, group_id: scope, error: errText(res.error) });
      const row = Array.isArray(res && res.data) ? res.data[0] : (res && res.data);
      // game.js grants the "Deck Shared" badge off this milestone. Private
      // items are not a share, and editing an existing one is not a new share.
      if (!i.id) creditGame('shared-deck', { type, title });
      return { ok: true, row: row || null, local: false, error: null };
    } catch (err) {
      return saveLocal(i, { type, title, body, group_id: scope, error: errText(err) });
    }
  }
  return saveLocal(i, { type, title, body, group_id: scope, error: null });
}

function saveLocal(input, data) {
  const id = (input.id && String(input.id).startsWith('local-')) ? input.id : 'local-' + uid('si');
  const s = getCommunityState();
  const existing = s.drafts[id] || {};
  const row = {
    id,
    owner_id: 'me',
    type: data.type,
    title: data.title,
    body: data.body,
    group_id: data.group_id,
    created_at: existing.created_at || nowIso(),
    updated_at: nowIso(),
    local: true,
  };
  const drafts = Object.assign({}, s.drafts, { [id]: row });
  patchCommunityState({ drafts });
  return { ok: true, row, local: true, error: data.error };
}

/** @returns {Promise<{ok:boolean, error:string|null}>} */
export async function deleteItem(id) {
  if (!id) return { ok: false, error: 'Nothing to delete.' };
  if (String(id).startsWith('local-')) {
    const s = getCommunityState();
    const drafts = Object.assign({}, s.drafts);
    delete drafts[id];
    patchCommunityState({ drafts });
    return { ok: true, error: null };
  }
  const ready = await sbReady();
  if (!ready) return { ok: false, error: 'Not signed in — cannot delete a shared item right now.' };
  const sb = await loadSb();
  try {
    const res = await sb.db.remove(TABLE, id);
    if (res && res.error) return { ok: false, error: errText(res.error) };
    return { ok: true, error: null };
  } catch (err) { return { ok: false, error: errText(err) }; }
}

/* =============================================================================
   9. IMPORT PATHS
   ========================================================================== */

/**
 * Convert a shared deck into local user cards + fresh FSRS cards, then announce
 * it on the bus. Dedupes on question text, so re-importing is safe.
 *
 * @param {{cards:Array}} deck
 * @param {{title?:string, subject?:string, unit?:string, id?:string, topicId?:string}} [meta]
 * @returns {{added:number, skipped:number, topicId:string, saved:boolean}}
 */
export function importDeckToFsrs(deck, meta) {
  const m = meta || {};
  const cards = (deck && Array.isArray(deck.cards)) ? deck.cards : [];
  const topicId = m.topicId || ('shared-' + slugify(m.title || 'deck'));
  const subject = trim(m.subject) || trim(deck && deck.subject) || null;
  const unit = trim(m.unit) || trim(deck && deck.unit) || null;

  const userCards = store.get(KEYS.USER_CARDS, {}) || {};
  const list = Array.isArray(userCards[topicId]) ? userCards[topicId].slice() : [];
  const seen = new Set(list.map((c) => trim(c && c.q).toLowerCase()));
  const srs = store.get(KEYS.SRS, {}) || {};

  let added = 0;
  let skipped = 0;
  for (const c of cards) {
    const q = trim(c && c.q);
    const a = trim(c && c.a);
    if (!q || !a) { skipped += 1; continue; }
    const key = q.toLowerCase();
    if (seen.has(key)) { skipped += 1; continue; }
    const id = 'sh-' + hash12(topicId + '|' + q);
    list.push({
      id, q, a,
      type: c.type || '',
      pacer: c.pacer || '',
      cognitive: c.cognitive || '',
      misconceptions: c.misconceptions || '',
      user: true,
      source: 'community',
      sharedItemId: m.id || null,
      createdTs: Date.now(),
    });
    if (!srs[id]) srs[id] = initCard(id, { topic: topicId, subject, unit });
    seen.add(key);
    added += 1;
  }

  userCards[topicId] = list;
  const okCards = store.set(KEYS.USER_CARDS, userCards);
  const okSrs = store.set(KEYS.SRS, srs);
  if (!okCards || !okSrs) warnQuota();

  try {
    window.dispatchEvent(new CustomEvent('engram:import-deck', {
      detail: { deck: { cards, subject, unit, title: m.title || '' }, topicId, added, skipped, sourceId: m.id || null },
    }));
  } catch (_) { /* CustomEvent unsupported — the store write already landed */ }

  /* The review pool is cached behind a topic-count stamp, which importing cards
     does not move; study.js drops the cache on the event above but only while
     it is mounted, and imports happen from Me. Tell the queue directly so the
     new cards are in TONIGHT's session, not next reload. Lazy + guarded: the
     queue module must never be a hard dependency of the community shelf. */
  if (added > 0) {
    import('./queue-ui.js')
      .then((m) => { if (m && typeof m.invalidatePool === 'function') m.invalidatePool(); })
      .catch(() => { /* queue not in this build — the event still fired */ });
  }

  return { added, skipped, topicId, saved: okCards && okSrs };
}

/**
 * Copy a shared map into his own maps.
 *
 * The map document shape belongs to the maps agent, so this never hand-writes
 * KEYS.MAPS: it goes through that module's own `normalizeMapDoc()` (which drops
 * dangling edges and mints missing ids) and `saveMap()`. The id is derived from
 * the source row, so importing the same map twice updates one copy instead of
 * breeding duplicates. The event still fires for anyone listening.
 *
 * @returns {Promise<{ok:boolean, mapId:string|null, error:string|null}>}
 */
export async function importMap(mapBody, meta) {
  const m = meta || {};
  const title = trim(m.title) || trim(mapBody && mapBody.title) || 'Shared map';
  let mapId = null;
  let error = null;

  try {
    const mm = await import('./mindmap-canvas.js');
    if (mm && typeof mm.normalizeMapDoc === 'function' && typeof mm.saveMap === 'function') {
      const doc = mm.normalizeMapDoc(Object.assign({}, mapBody || {}, {
        id: 'shared-' + hash12(String(m.id || '') + '|' + title),
        title,
      }));
      /* saveMap() returns false on a refused write and raises its own banner —
         nothing is deleted to make room, so we simply do not claim success. */
      if (mm.saveMap(doc)) mapId = doc.id;
      else error = 'Storage is full — the map was not saved.';
    } else {
      error = 'The maps canvas is not part of this build.';
    }
  } catch (_) {
    error = 'The maps canvas could not be loaded.';
  }

  try {
    window.dispatchEvent(new CustomEvent('engram:import-map', {
      detail: { map: mapBody, title, sourceId: m.id || null, mapId },
    }));
  } catch (_) { /* CustomEvent unsupported */ }

  return { ok: Boolean(mapId), mapId, error };
}

/** Copy a shared note into the local notes for a topic (or the community shelf). */
export function importNote(noteBody, meta) {
  const m = meta || {};
  const topicId = m.topicId || 'shared-notes';
  const notes = store.get(KEYS.NOTES, {}) || {};
  const list = Array.isArray(notes[topicId]) ? notes[topicId].slice() : [];
  const title = trim(m.title) || 'Shared note';
  const body = trim(noteBody && noteBody.md);
  const id = 'sn-' + hash12(topicId + '|' + title + '|' + body.slice(0, 200));
  if (list.some((n) => n && n.id === id)) return { added: 0, id, topicId, saved: true };
  list.push({ id, title, body, createdTs: Date.now(), source: 'community', sharedItemId: m.id || null });
  notes[topicId] = list;
  const ok = store.set(KEYS.NOTES, notes);
  if (!ok) warnQuota();
  return { added: 1, id, topicId, saved: ok };
}

/* =============================================================================
   10. DECK EDITOR
   ========================================================================== */

/**
 * @param {{row?:Object, group?:string, seed?:Object, onSaved?:Function}} [opts]
 */
export function openDeckEditor(opts) {
  const o = opts || {};
  const row = o.row || null;
  const parsed = row ? parseBody(row) : null;
  const deck = blankDeck(parsed && Array.isArray(parsed.cards)
    ? { subject: parsed.subject || '', unit: parsed.unit || '', cards: parsed.cards.map(normaliseCard) }
    : (o.seed || null));
  if (!deck.cards.length) deck.cards.push(blankCard());

  const state = {
    title: row ? String(row.title || '') : trim(o.seed && o.seed.title),
    group: scopeOf(row, o.group),
    deck,
  };

  const listHost = el('div.stack', { style: { '--gap': 'var(--sp-3)' } });
  const summaryHost = el('div');
  const saveBtn = el('button.btn.btn-primary', { type: 'button', text: row ? 'Save changes' : 'Save deck' });

  const revalidate = debounce(() => {
    renderSummary();
    Array.from(listHost.children).forEach((node, i) => {
      const issues = node.__issues;
      if (issues) renderIssues(issues, validateCard(state.deck.cards[i]));
    });
  }, 220);

  function renderSummary() {
    const v = validateDeck(state.deck);
    saveBtn.disabled = !v.ok || !trim(state.title);
    replace(summaryHost, deckSummaryCard(v, state));
  }

  function renderList() {
    clear(listHost);
    state.deck.cards.forEach((card, i) => listHost.appendChild(cardRow(card, i)));
    renderSummary();
  }

  function cardRow(card, index) {
    const issuesHost = el('div.stack', { style: { '--gap': '4px' } });
    const node = el('article.card.card--quiet',
      el('div.row.row--between',
        el('div.row',
          el('span.chip.chip--micro', { text: 'CARD ' + (index + 1) }),
          el('span.pill.pill--neutral', { text: card.type || 'explain' })),
        el('div.row',
          iconBtn('chevron-up', 'Move up', () => { move(index, -1); }),
          iconBtn('chevron-down', 'Move down', () => { move(index, +1); }),
          iconBtn('trash', 'Delete card', () => { removeCard(index); }))),
      field('Question — a pure cue, one idea',
        el('textarea.textarea', {
          rows: 2, value: card.q, attrs: { placeholder: 'Why does…? / State… / Calculate…' },
          onInput: (e) => { card.q = e.target.value; revalidate(); },
        }), null),
      field('Answer',
        el('textarea.textarea', {
          rows: 3, value: card.a, attrs: { placeholder: 'Units on every quantity. Powers of ten as a × 10ⁿ.' },
          onInput: (e) => { card.a = e.target.value; revalidate(); },
        }), null),
      el('div.card-grid',
        field('Type', selectField(CARD_TYPES, card.type, (v) => { card.type = v; renderList(); }, { label: 'Card type' })),
        field('Cognitive level', selectField(COGNITIVE_LEVELS, card.cognitive, (v) => { card.cognitive = v; revalidate(); }, { label: 'Cognitive level' }))),
      el('div.card-grid',
        field('PACER', selectField(PACER_CODES.map((p) => ({ value: p, label: PACER_LABEL[p] })), card.pacer, (v) => { card.pacer = v; revalidate(); }, { label: 'PACER route' })),
        field('Misconception ids', el('input.input.input--mono', {
          type: 'text', value: card.misconceptions || '', attrs: { placeholder: 'CH-S02, PH-F01 — or leave blank' },
          onInput: (e) => { card.misconceptions = e.target.value; },
        }))),
      issuesHost);
    node.__issues = issuesHost;
    renderIssues(issuesHost, validateCard(card));
    return node;
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.deck.cards.length) return;
    const arr = state.deck.cards;
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    haptic('select');
    renderList();
  }

  function removeCard(i) {
    if (state.deck.cards.length === 1) { toast('A deck needs at least one card.', { tone: 'info' }); return; }
    state.deck.cards.splice(i, 1);
    renderList();
  }

  const sheet = openSheet({
    title: row ? 'Edit deck' : 'New deck',
    subtitle: 'Cards are minted after encoding — not instead of it.',
    body: [
      field('Deck title', el('input.input', {
        type: 'text', value: state.title, attrs: { maxlength: '120', placeholder: 'Mole concept — limiting reagent' },
        onInput: (e) => { state.title = e.target.value; renderSummary(); },
      }), null, { required: true }),
      el('div.card-grid',
        field('Subject', selectField(
          [{ value: '', label: 'Not set' }].concat(subjectOptions()),
          state.deck.subject, (v) => { state.deck.subject = v; }, { label: 'Subject' })),
        field('Unit', el('input.input', {
          type: 'text', value: state.deck.unit || '', attrs: { placeholder: 'Unit 5' },
          onInput: (e) => { state.deck.unit = e.target.value; },
        }))),
      field('Shared with', groupSelect(state.group, (v) => { state.group = v; }),
        'Private decks stay on this device until you pick a group.'),
      el('hr.divider'),
      summaryHost,
      listHost,
      el('button.btn.btn-secondary.btn--block', {
        type: 'button',
        onClick: () => { state.deck.cards.push(blankCard()); renderList(); },
      }, icon('plus', { size: 16 }), el('span', { text: 'Add a card' })),
    ],
    foot: [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      saveBtn,
    ],
  });

  saveBtn.addEventListener('click', async () => {
    const v = validateDeck(state.deck);
    if (!v.ok) { toast('Fix the blocking issues first — they are listed on the cards.', { tone: 'warn' }); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const res = await saveItem({
      id: row ? row.id : null,
      type: 'deck',
      title: state.title,
      group_id: state.group,
      body: {
        version: 1,
        subject: state.deck.subject || '',
        unit: state.deck.unit || '',
        cards: state.deck.cards.map(normaliseCard),
      },
    });
    saveBtn.disabled = false;
    saveBtn.textContent = row ? 'Save changes' : 'Save deck';
    if (!res.ok) { toast(res.error || 'Could not save.', { tone: 'bad' }); return; }
    toast(res.local
      ? 'Saved on this device. Sign in to share it with your group.'
      : 'Deck saved — ' + state.deck.cards.length + ' ' + fmt.plural(state.deck.cards.length, 'card') + '.',
      { tone: 'good' });
    sheet.close();
    if (typeof o.onSaved === 'function') o.onSaved(res.row);
  });

  renderList();
  return sheet;
}

function normaliseCard(c) {
  const card = c || {};
  return {
    q: trim(card.q),
    a: trim(card.a),
    type: CARD_TYPES.includes(card.type) ? card.type : 'explain',
    cognitive: COGNITIVE_LEVELS.includes(card.cognitive) ? card.cognitive : 'understanding',
    pacer: PACER_CODES.includes(card.pacer) ? card.pacer : 'C',
    misconceptions: trim(card.misconceptions),
    lesson: trim(card.lesson),
  };
}

function renderIssues(host, issues) {
  clear(host);
  for (const it of issues) {
    host.appendChild(el('div.row', { dataset: { tone: it.severity === 'error' ? 'bad' : 'warn' } },
      icon(it.severity === 'error' ? 'circle-alert' : 'alert-triangle', { size: 14, cls: 'icon--accent' }),
      el('span.text-meta', { text: it.message })));
  }
}

function deckSummaryCard(v, state) {
  const mix = v.mix;
  const bar = (level) => el('div.meter-row',
    el('span.meter__label', { text: level + ' · ' + mix.pct[level] + '% (exam ' + CDC_MIX[level] + '%)' }),
    el('div.meter.meter--sm', el('span.meter__fill', { style: { '--pct': String(clamp(mix.pct[level], 0, 100)) } })));

  return el('div.card.card--quiet', { dataset: { tone: v.ok ? 'good' : 'bad' } },
    el('div.row.row--between',
      el('div.row',
        icon(v.ok ? 'circle-check' : 'circle-alert', { size: 16, cls: 'icon--accent' }),
        el('span.text-body-lg', {
          text: v.ok
            ? (state.deck.cards.length + ' ' + fmt.plural(state.deck.cards.length, 'card') + ' · ready to save')
            : (v.errors + ' ' + fmt.plural(v.errors, 'issue') + ' to fix'),
        })),
      v.warnings ? el('span.pill.pill--warn', { text: v.warnings + ' advisory' }) : null),
    el('div.stack', { style: { '--gap': '6px', marginTop: 'var(--sp-3)' } },
      COGNITIVE_LEVELS.map(bar)),
    v.deckIssues.length
      ? el('div.stack', { style: { '--gap': '4px', marginTop: 'var(--sp-3)' } },
          v.deckIssues.map((it) => el('div.row', { dataset: { tone: it.severity === 'error' ? 'bad' : 'warn' } },
            icon(it.severity === 'error' ? 'circle-alert' : 'alert-triangle', { size: 14, cls: 'icon--accent' }),
            el('span.text-meta', { text: it.message }))))
      : null);
}

function subjectOptions() {
  const fromVault = getSubjects();
  const base = ['Physics', 'Chemistry', 'Mathematics', 'Biology', 'English', 'Nepali', 'Computer Science'];
  const seen = new Set();
  const out = [];
  for (const s of fromVault.concat(base)) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({ value: s, label: s });
  }
  return out;
}

/**
 * The scope a row is ACTUALLY shared under, expressed as a value the scope
 * <select> can display. Cloud rows carry a uuid; where that uuid is a group he
 * has joined, show the code he typed instead.
 */
export function scopeOf(row, fallback) {
  const gid = row && row.group_id ? String(row.group_id) : '';
  if (!gid) return row ? '' : (fallback === undefined ? currentGroup() : fallback);
  const hit = getCommunityState().groups.find((g) => g && (g.id === gid || g.uuid === gid));
  return hit ? String(hit.id) : gid;
}

/**
 * The group-scope <select> used by every editor.
 *
 * A scope this device cannot name (a uuid from a group he left, say) still gets
 * an option of its own. Falling back to the first option would render a
 * group-shared item as "Just me (private)" — a lie about who can see it, and
 * the one mistake this control is not allowed to make.
 */
export function groupSelect(current, onChange) {
  const value = current == null ? '' : String(current);
  const options = getGroups().map((g) => ({ value: g.id, label: g.label }));
  if (value && !options.some((o) => o.value === value)) {
    options.push({ value, label: groupLabelOf({ group_id: value }) + ' (current)' });
  }
  return selectField(options, value, onChange, { label: 'Group scope' });
}

/* =============================================================================
   11. NOTE EDITOR (markdown textarea + live, sanitised preview)
   ========================================================================== */

export function openNoteEditor(opts) {
  const o = opts || {};
  const row = o.row || null;
  const parsed = row ? parseBody(row) : null;
  const state = {
    title: row ? String(row.title || '') : trim(o.seed && o.seed.title),
    group: scopeOf(row, o.group),
    md: (parsed && typeof parsed.md === 'string') ? parsed.md : trim(o.seed && o.seed.md),
  };

  const preview = el('div.prose', { style: { padding: 'var(--sp-3)', background: 'var(--surface-muted)', borderRadius: 'var(--r-lg)' } });
  const counter = el('div.hint');
  const saveBtn = el('button.btn.btn-primary', { type: 'button', text: row ? 'Save changes' : 'Save note' });

  const repaint = debounce(() => {
    md(preview, state.md || '_Nothing yet._');
    counter.textContent = state.md.length + ' characters';
    saveBtn.disabled = !trim(state.title) || !trim(state.md);
  }, 160);

  const sheet = openSheet({
    title: row ? 'Edit note' : 'New note',
    subtitle: 'Markdown. Question-first notes beat summaries.',
    body: [
      field('Title', el('input.input', {
        type: 'text', value: state.title, attrs: { maxlength: '120', placeholder: 'Limiting reagent — the three traps' },
        onInput: (e) => { state.title = e.target.value; repaint(); },
      }), null, { required: true }),
      field('Shared with', groupSelect(state.group, (v) => { state.group = v; })),
      field('Note', el('textarea.textarea', {
        rows: 10, value: state.md,
        attrs: { placeholder: '## Q: what breaks if the mole ratio is applied to grams?\n\nA: …' },
        onInput: (e) => { state.md = e.target.value; repaint(); },
      }), null),
      counter,
      el('div.eyebrow.eyebrow--dot', el('span', { text: 'Preview' })),
      preview,
    ],
    foot: [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      saveBtn,
    ],
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const res = await saveItem({
      id: row ? row.id : null,
      type: 'note',
      title: state.title,
      group_id: state.group,
      body: { md: state.md },
    });
    saveBtn.disabled = false;
    saveBtn.textContent = row ? 'Save changes' : 'Save note';
    if (!res.ok) { toast(res.error || 'Could not save.', { tone: 'bad' }); return; }
    toast(res.local ? 'Saved on this device.' : 'Note shared.', { tone: 'good' });
    sheet.close();
    if (typeof o.onSaved === 'function') o.onSaved(res.row);
  });

  repaint();
  return sheet;
}

/* =============================================================================
   12. MAP SHARE FLOW  (called by maps.js — it owns the canvas, this owns sharing)
   ========================================================================== */

/**
 * @param {{row?:Object, title?:string, body?:Object, group?:string, onSaved?:Function}} opts
 */
export function openMapShareEditor(opts) {
  const o = opts || {};
  const row = o.row || null;
  const parsed = row ? parseBody(row) : null;
  const mapBody = parsed || o.body || null;
  const state = {
    title: row ? String(row.title || '') : trim(o.title),
    group: scopeOf(row, o.group),
  };
  const nodes = countMapNodes(mapBody);
  const saveBtn = el('button.btn.btn-primary', { type: 'button', text: row ? 'Save changes' : 'Share map' });

  const sheet = openSheet({
    title: row ? 'Edit shared map' : 'Share this map',
    subtitle: 'A map you built. Nobody else can edit it.',
    body: [
      field('Title', el('input.input', {
        type: 'text', value: state.title, attrs: { maxlength: '120', placeholder: 'Stoichiometry — my map' },
        onInput: (e) => { state.title = e.target.value; saveBtn.disabled = !trim(state.title); },
      }), null, { required: true }),
      field('Shared with', groupSelect(state.group, (v) => { state.group = v; })),
      el('div.card.card--quiet',
        el('div.row',
          icon('waypoints', { size: 16, cls: 'icon--accent' }),
          el('span.text-meta', { text: nodes + ' ' + fmt.plural(nodes, 'node') + ' in this map' }))),
      el('p.hint', { text: 'Sharing a map shares the picture, not your review history.' }),
    ],
    foot: [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      saveBtn,
    ],
  });
  saveBtn.disabled = !trim(state.title);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const res = await saveItem({
      id: row ? row.id : null,
      type: 'map',
      title: state.title,
      group_id: state.group,
      body: mapBody || {},
    });
    saveBtn.disabled = false;
    if (!res.ok) { toast(res.error || 'Could not save.', { tone: 'bad' }); return; }
    toast(res.local ? 'Saved on this device.' : 'Map shared.', { tone: 'good' });
    sheet.close();
    if (typeof o.onSaved === 'function') o.onSaved(res.row);
  });

  return sheet;
}

function countMapNodes(body) {
  if (!body || typeof body !== 'object') return 0;
  if (Array.isArray(body.nodes)) return body.nodes.length;
  let n = 0;
  const walk = (x) => { if (!x) return; n += 1; for (const c of (Array.isArray(x.children) ? x.children : [])) walk(c); };
  walk(body.root || body);
  return Math.max(0, n - (body.root ? 0 : 1));
}

/** One entry point maps.js can call for any item type. */
export function openShareEditor(type, opts) {
  if (type === 'deck') return openDeckEditor(opts);
  if (type === 'map') return openMapShareEditor(opts);
  return openNoteEditor(opts);
}

/* =============================================================================
   13. CONSUME — preview + import
   ========================================================================== */

/**
 * Preview a shared item and offer the right import action.
 * @param {Object} row shared_items row
 * @param {{userId?:string, onChanged?:Function}} [opts]
 */
export function openItemPreview(row, opts) {
  const o = opts || {};
  const body = parseBody(row) || {};
  const type = ITEM_TYPES.includes(row && row.type) ? row.type : 'note';
  const meta = TYPE_META[type];
  const owner = isOwner(row, o.userId);

  const bodyNodes = [];
  bodyNodes.push(el('div.row.row--wrap',
    el('span.pill.pill--accent', { dataset: { tone: meta.tone } }, icon(meta.icon, { size: 12 }), el('span', { text: meta.label })),
    el('span.chip.chip--micro', { text: groupLabelOf(row) }),
    row.local ? el('span.pill.pill--warn', { text: 'on this device' }) : null,
    el('span.text-meta', { text: 'updated ' + fmt.rel(row.updated_at || row.created_at) })));

  if (type === 'deck') {
    const cards = Array.isArray(body.cards) ? body.cards : [];
    const v = validateDeck({ cards: cards.map(normaliseCard) });
    bodyNodes.push(el('p.text-meta', {
      text: cards.length + ' ' + fmt.plural(cards.length, 'card') +
        (body.subject ? ' · ' + body.subject : '') + (body.unit ? ' · ' + body.unit : ''),
    }));
    if (v.warnings || v.errors) {
      bodyNodes.push(el('div.card.card--quiet', { dataset: { tone: v.errors ? 'bad' : 'warn' } },
        el('div.row', icon('alert-triangle', { size: 14, cls: 'icon--accent' }),
          el('span.text-meta', {
            text: v.errors
              ? v.errors + ' blocking ' + fmt.plural(v.errors, 'issue') + ' in this deck — import it and fix the cards, or skip it.'
              : v.warnings + ' advisory ' + fmt.plural(v.warnings, 'note') + ' on this deck.',
          }))));
    }
    bodyNodes.push(el('div.stack', { style: { '--gap': 'var(--sp-2)' } },
      cards.slice(0, 8).map((c, i) => el('div.card.card--quiet',
        el('div.row.row--between',
          el('span.chip.chip--micro', { text: String(i + 1).padStart(2, '0') }),
          el('span.pill.pill--neutral', { text: c.type || 'card' })),
        el('div.text-body-lg', { text: trim(c.q) }),
        el('details',
          el('summary.text-meta', { text: 'Show the answer' }),
          el('div.text-meta', { style: { marginTop: '6px' }, text: trim(c.a) }))))));
    if (cards.length > 8) bodyNodes.push(el('p.hint', { text: 'and ' + (cards.length - 8) + ' more…' }));
  } else if (type === 'note') {
    const prose = el('div.prose');
    md(prose, String(body.md || ''));
    bodyNodes.push(prose);
  } else {
    const n = countMapNodes(body);
    bodyNodes.push(el('div.card.card--quiet',
      el('div.row', icon('waypoints', { size: 16, cls: 'icon--accent' }),
        el('span.text-body-lg', { text: n + ' ' + fmt.plural(n, 'node') }))));
    bodyNodes.push(el('p.hint', { text: 'Open it on the Maps canvas to rebuild it from memory — that is the part that teaches.' }));
  }

  const actions = [];
  actions.push(el('button.btn.btn-ghost', { type: 'button', text: 'Close', onClick: () => sheet.close() }));

  if (owner) {
    actions.push(el('button.btn.btn-secondary', {
      type: 'button', onClick: () => { sheet.close(); openShareEditor(type, { row, onSaved: o.onChanged }); },
    }, icon('edit', { size: 14 }), el('span', { text: 'Edit' })));
  }

  if (type === 'deck') {
    actions.push(el('button.btn.btn-primary', {
      type: 'button',
      onClick: () => {
        const res = importDeckToFsrs(body, { title: row.title, subject: body.subject, unit: body.unit, id: row.id });
        haptic('success');
        toast(res.added
          ? res.added + ' ' + fmt.plural(res.added, 'card') + ' added to your own queue' + (res.skipped ? ' · ' + res.skipped + ' already there' : '')
          : 'Every card in this deck is already in your queue.',
          { tone: 'good' });
        sheet.close();
      },
    }, icon('download', { size: 14 }), el('span', { text: 'Add to my cards' })));
  } else if (type === 'note') {
    actions.push(el('button.btn.btn-primary', {
      type: 'button',
      onClick: () => {
        const res = importNote(body, { title: row.title, id: row.id });
        toast(res.added ? 'Note saved to your notes.' : 'You already have this note.', { tone: 'good' });
        sheet.close();
      },
    }, icon('download', { size: 14 }), el('span', { text: 'Save to my notes' })));
  } else {
    actions.push(el('button.btn.btn-primary', {
      type: 'button',
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const res = await importMap(body, { title: row.title, id: row.id });
        btn.disabled = false;
        if (!res.ok) { toast(res.error || 'Could not copy that map.', { tone: 'bad' }); return; }
        haptic('success');
        sheet.close();
        toast('Copied to your maps — rebuild it from memory, that is the part that teaches.', { tone: 'good' });
        navigate('maps', { map: res.mapId });
      },
    }, icon('waypoints', { size: 14 }), el('span', { text: 'Copy to my maps' })));
  }

  const sheet = openSheet({
    title: String(row.title || meta.label),
    subtitle: owner ? 'Yours' : 'Shared with your group',
    body: bodyNodes,
    foot: actions,
  });
  return sheet;
}

/* =============================================================================
   14. BROWSE + MY ITEMS  (mounted by me.js; reusable anywhere)
   ========================================================================== */

function itemRow(row, userId, onChanged) {
  const type = ITEM_TYPES.includes(row && row.type) ? row.type : 'note';
  const meta = TYPE_META[type];
  const body = parseBody(row) || {};
  const n = type === 'deck'
    ? (Array.isArray(body.cards) ? body.cards.length : 0)
    : (type === 'map' ? countMapNodes(body) : String(body.md || '').split(/\s+/).filter(Boolean).length);
  const noun = type === 'deck' ? 'card' : (type === 'map' ? 'node' : 'word');
  const sub = n + ' ' + fmt.plural(n, noun);

  return el('button.option', {
    type: 'button',
    dataset: { tone: meta.tone },
    onClick: () => openItemPreview(row, { userId, onChanged }),
  },
    el('span.option__key', icon(meta.icon, { size: 14 })),
    el('span.stack', { style: { '--gap': '2px', minWidth: '0', flex: '1 1 auto' } },
      el('span.truncate', { text: String(row.title || meta.label) }),
      el('span.text-meta', {
        text: sub + ' · ' + groupLabelOf(row) + ' · ' + fmt.rel(row.updated_at || row.created_at),
      })),
    row.local ? el('span.pill.pill--warn', { text: 'local' }) : null);
}

/**
 * Browse shared items by group and type.
 * @param {HTMLElement} host
 * @param {{type?:string, group?:string, limit?:number}} [opts]
 * @returns {{refresh:Function}}
 */
export function mountBrowser(host, opts) {
  const o = opts || {};
  const state = { type: o.type || '', group: o.group !== undefined ? o.group : currentGroup(), userId: null };
  const listHost = el('div.stack', { style: { '--gap': 'var(--sp-2)' } });

  const typeChips = el('div.chip-row.chip-row--scroll',
    [{ id: '', label: 'Everything' }].concat(ITEM_TYPES.map((t) => ({ id: t, label: TYPE_META[t].plural })))
      .map((t) => el('button.chip.chip--button', {
        type: 'button',
        attrs: { 'aria-pressed': String(state.type === t.id) },
        text: t.label,
        onClick: (e) => {
          state.type = t.id;
          Array.from(typeChips.children).forEach((c) => c.setAttribute('aria-pressed', 'false'));
          e.currentTarget.setAttribute('aria-pressed', 'true');
          refresh();
        },
      })));

  const groupPicker = groupSelect(state.group, (v) => { state.group = v; setCurrentGroup(v); refresh(); });

  replace(host,
    el('div.stack', { style: { '--gap': 'var(--sp-3)' } },
      el('div.row.row--wrap', groupPicker),
      typeChips,
      listHost));

  async function refresh() {
    replace(listHost, spinner('Loading shared items'));
    state.userId = (await currentUser() || {}).id || null;
    const res = await listItems({ type: state.type || undefined, group: state.group, limit: o.limit || 60 });
    clear(listHost);
    if (res.error) {
      listHost.appendChild(el('div.card.card--quiet', { dataset: { tone: 'bad' } },
        el('div.row', icon('circle-alert', { size: 16, cls: 'icon--accent' }),
          el('span.text-meta', { text: res.error }))));
    }
    if (!res.rows.length) {
      let title = 'This group has nothing yet';
      let body = 'Be the first — build a deck from a topic you have already encoded.';
      if (res.private) {
        title = 'Nothing on this device yet';
        body = 'This is your private shelf. Pick a group above to see what your friends have shared.';
      } else if (res.missingGroup) {
        title = 'Nobody has used that code yet';
        body = 'The group is created the moment you share something to it. Type the same code your friends typed.';
      } else if (res.offline) {
        title = 'Nothing shared here yet';
        body = 'Community sharing needs Supabase configured and a sign-in. Anything you build now is saved on this device and uploads later.';
      }
      listHost.appendChild(emptyState({ icon: 'layers', title, body }));
      return;
    }
    for (const row of res.rows) listHost.appendChild(itemRow(row, state.userId, refresh));
  }

  refresh();
  return { refresh };
}

/**
 * "My shared items" manager: list · edit · delete, with the group-scope selector.
 * @param {HTMLElement} host
 * @returns {{refresh:Function}}
 */
export function mountMyItems(host, opts) {
  const o = opts || {};
  const listHost = el('div.stack', { style: { '--gap': 'var(--sp-2)' } });
  const state = { userId: null };

  const newRow = el('div.btn-row',
    el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => openDeckEditor({ onSaved: refresh }) },
      icon('layers', { size: 14 }), el('span', { text: 'New deck' })),
    el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => openNoteEditor({ onSaved: refresh }) },
      icon('file-text', { size: 14 }), el('span', { text: 'New note' })));

  replace(host, el('div.stack', { style: { '--gap': 'var(--sp-3)' } }, newRow, listHost));

  function manageRow(row) {
    return el('div.card.card--quiet',
      el('div.row.row--between',
        el('div.row', { style: { minWidth: '0' } },
          icon(TYPE_META[row.type] ? TYPE_META[row.type].icon : 'file-text', { size: 16, cls: 'icon--accent' }),
          el('div.stack', { style: { '--gap': '2px', minWidth: '0' } },
            el('div.truncate', { text: String(row.title || '') }),
            el('div.text-meta', {
              text: groupLabelOf(row) + ' · ' + fmt.rel(row.updated_at || row.created_at) + (row.local ? ' · on this device' : ''),
            }))),
        el('div.row',
          iconBtn('eye', 'Preview', () => openItemPreview(row, { userId: state.userId, onChanged: refresh })),
          iconBtn('edit', 'Edit', () => openShareEditor(row.type, { row, onSaved: refresh })),
          iconBtn('trash', 'Delete', async () => {
            const yes = await confirmSheet({
              title: 'Delete “' + String(row.title || '') + '”?',
              body: 'It disappears for everyone in the group. Cards you already imported into your own queue stay — this only removes the shared copy.',
              confirmLabel: 'Delete',
              tone: 'bad',
            });
            if (!yes) return;
            const res = await deleteItem(row.id);
            if (!res.ok) { toast(res.error || 'Could not delete.', { tone: 'bad' }); return; }
            toast('Deleted.', { tone: 'good' });
            refresh();
          }))));
  }

  async function refresh() {
    replace(listHost, spinner('Loading your items'));
    state.userId = (await currentUser() || {}).id || null;
    const res = await listItems({ ownerOnly: true, group: undefined, limit: 100 });
    const mine = res.rows.filter((r) => isOwner(r, state.userId));
    clear(listHost);
    if (res.error) {
      listHost.appendChild(el('div.card.card--quiet', { dataset: { tone: 'bad' } },
        el('div.row', icon('circle-alert', { size: 16, cls: 'icon--accent' }), el('span.text-meta', { text: res.error }))));
    }
    if (!mine.length) {
      listHost.appendChild(emptyState({
        icon: 'plus',
        title: 'You have not shared anything yet',
        body: 'Build a deck from a topic you have already mapped, or write a note worth keeping.',
      }));
    } else {
      for (const row of mine) listHost.appendChild(manageRow(row));
    }
    if (typeof o.onCount === 'function') o.onCount(mine.length);
  }

  refresh();
  return { refresh };
}

function iconBtn(name, label, onClick) {
  return el('button.btn-icon', {
    type: 'button', attrs: { 'aria-label': label, title: label }, onClick,
  }, icon(name, { size: 16 }));
}

export default {
  ITEM_TYPES, TYPE_META, CARD_TYPES, COGNITIVE_LEVELS, PACER_CODES, STATUSES, FRAMES,
  loadSb, loadGame, sbReady, currentUser,
  getGroups, currentGroup, setCurrentGroup, joinGroup, leaveGroup,
  resolveGroupUuid, groupLabelOf, normaliseGroupCode, isUuid,
  openSheet, confirmSheet, compressImage,
  validateQuestion, validateCard, validateDeck, cognitiveMix,
  listItems, saveItem, deleteItem, parseBody, isOwner,
  openDeckEditor, openNoteEditor, openMapShareEditor, openShareEditor, openItemPreview,
  mountBrowser, mountMyItems,
  importDeckToFsrs, importMap, importNote,
  getCommunityState, patchCommunityState, field, selectField, groupSelect, scopeOf,
  slugify, hash12, blankDeck, blankCard, BODY_MAX_BYTES,
};
