/* =============================================================================
   js/mindmap-canvas.js — the GRINDE map editor (pedagogy-spec §1.3, R6).
   Owner: Job — Mindmaps.

   THE RULE THAT SHAPES THIS FILE (pedagogy-spec R6): the AI NEVER pre-draws a
   map. Constructing a concept map is g=0.72; studying a provided one is g=0.43.
   So there is no "generate map" button anywhere in here — only tools that make
   HIS construction cheaper: add, drag, group, link, weight, emphasise, and the
   island detector that tells him when part of his understanding is floating
   free.

   GRINDE, as tooling:
     G  grouped        — group containers, ≤3-word labels, subject-tone accents
     R  reflective     — recall mode: blank canvas, rebuild from memory, compare
     I  interconnected — island detector highlights unconnected clusters live
     N  non-verbal     — verbosity meter warns past 8 words in an idea
     D  directional    — every link is directed, arrowheads, weight 1–3
     E  emphasised     — backbone toggle per idea and per link

   Persistence (store API only — never raw localStorage):
     KEYS.MAPS      mapId -> doc            (a superset of the documented
                                             {nodes, edges, version, updatedISO})
     'mapVersions'  mapId -> [{id, ts, name, doc}]   last 20 unnamed + all named
     'mapRecall'    mapId -> {lastTs, recalled, total, added}

   Export / share body shape = shared_items 'map' (body = JSON string of doc).
   ========================================================================== */

import { el, icon, on, toast, clamp, prefersReducedMotion, fmt } from './dom.js';
import { store, KEYS, uid, nowTs, todayLocalISO } from './store.js';
import { getTopic } from './vault.js';
import { routeFor, navigateTo } from './router.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------------------------------------------------------------------
   0. Constants
   ------------------------------------------------------------------------ */

export const VERBOSE_LIMIT = 8;          // GRINDE "N" — warn past 8 words
export const GROUP_LABEL_WORDS = 3;      // GRINDE "G" — ≤3-word group labels
export const MAX_UNNAMED_VERSIONS = 20;

const NODE_MIN_W = 76;
const NODE_MAX_W = 190;
const NODE_PAD_X = 12;
const NODE_FONT = 13;
const LINE_H = 16;
const MAX_LINES = 3;

const SCALE_MIN = 0.25;
const SCALE_MAX = 3;
const GRID = 24;

const VERSION_KEY = 'mapVersions';
const RECALL_KEY = 'mapRecall';

const TONES = ['brand', 'physics', 'chem', 'math', 'cs', 'english', 'nepali'];
const SUBJECT_TONE = {
  physics: 'physics', chemistry: 'chem', chem: 'chem',
  mathematics: 'math', maths: 'math', math: 'math',
  'computer science': 'cs', cs: 'cs',
  english: 'english', nepali: 'nepali',
};

/* ---------------------------------------------------------------------------
   1. Tiny SVG helper (dom.js el() is HTML-only)
   ------------------------------------------------------------------------ */

function s(tag, attrs, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') { n.textContent = String(v); continue; }
      if (k === 'dataset') { for (const [p, val] of Object.entries(v)) n.dataset[p] = String(val); continue; }
      n.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function cssEscape(v) {
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, '\\$&');
}

/* ---------------------------------------------------------------------------
   2. Real text measurement (build-constraints §8 — never char-count:
      Devanagari, subscripts and × all break the 0.545×length approximation)
   ------------------------------------------------------------------------ */

let measHost = null;
let measText = null;
const measCache = new Map();

/**
 * Width in px of a run of text as the browser will actually draw it.
 * @param {string} text
 * @param {{size?:number, weight?:number|string}} [opts]
 * @returns {number}
 */
export function measureText(text, opts) {
  const o = opts || {};
  const size = o.size || NODE_FONT;
  const weight = o.weight || 500;
  const value = String(text == null ? '' : text);
  if (!value) return 0;
  const key = size + '|' + weight + '|' + value;
  const hit = measCache.get(key);
  if (hit !== undefined) return hit;

  let w = 0;
  try {
    if (!measHost) {
      measHost = document.createElementNS(SVG_NS, 'svg');
      measHost.setAttribute('aria-hidden', 'true');
      measHost.style.cssText =
        'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
      measText = document.createElementNS(SVG_NS, 'text');
      measText.style.fontFamily = 'var(--font-sans)';
      measHost.appendChild(measText);
      document.body.appendChild(measHost);
    }
    measText.style.fontSize = size + 'px';
    measText.style.fontWeight = String(weight);
    measText.textContent = value;
    w = measText.getComputedTextLength();
  } catch (_) { w = 0; }

  if (!w || !Number.isFinite(w)) w = value.length * size * 0.55;   // headless fallback
  if (measCache.size > 4000) measCache.clear();
  measCache.set(key, w);
  return w;
}

/** Greedy word wrap using real measurement. Returns at most `maxLines` lines. */
export function wrapLabel(text, maxWidth, size, maxLines) {
  const limit = maxLines || MAX_LINES;
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const words = clean.split(' ');
  const lines = [];
  let line = '';
  let overflow = false;
  for (let i = 0; i < words.length; i += 1) {
    const candidate = line ? line + ' ' + words[i] : words[i];
    if (line && measureText(candidate, { size }) > maxWidth) {
      lines.push(line);
      line = words[i];
      // words[i..] are dropped here, so the last line always needs an ellipsis
      if (lines.length === limit) { line = ''; overflow = true; break; }
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < limit) lines.push(line);
  if (overflow && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && measureText(last + '…', { size }) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  return lines.length ? lines : [''];
}

/* ---------------------------------------------------------------------------
   3. Document model
   ------------------------------------------------------------------------ */

/** Words in a label — the verbosity meter's unit. */
export function wordCount(text) {
  const t = String(text == null ? '' : text).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Normalised label used for recall matching and cross-view selection sync. */
export function normLabel(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function toneForSubject(subject) {
  return SUBJECT_TONE[String(subject || '').toLowerCase().trim()] || 'brand';
}

/** A blank map document. */
export function createMapDoc(init) {
  const o = init || {};
  return {
    v: 1,
    kind: 'engram-map',
    id: o.id || uid('map'),
    topicId: o.topicId || '',
    subject: o.subject || '',
    title: o.title || 'Untitled map',
    nodes: [],
    edges: [],
    groups: [],
    image: null,
    view: { tx: 0, ty: 0, scale: 1 },
    version: 1,
    updatedISO: todayLocalISO(),
    updatedTs: nowTs(),
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d) => (v === undefined || v === null ? (d || '') : String(v));

/**
 * Accept anything that claims to be a map and return a safe document.
 * Links pointing at missing ideas are dropped; ids are minted where absent.
 * @param {Object} raw
 * @returns {Object}
 */
export function normalizeMapDoc(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const doc = createMapDoc({
    id: src.id, topicId: src.topicId, subject: src.subject, title: src.title,
  });

  const groupIds = new Set();
  doc.groups = (Array.isArray(src.groups) ? src.groups : []).slice(0, 40).map((g, i) => {
    const id = str(g && g.id) || uid('grp');
    groupIds.add(id);
    return {
      id,
      label: str(g && g.label, 'group ' + (i + 1)).slice(0, 60),
      x: num(g && g.x, 0), y: num(g && g.y, 0),
      w: clamp(num(g && g.w, 260), 120, 3000),
      h: clamp(num(g && g.h, 180), 100, 3000),
      tone: TONES.includes(str(g && g.tone)) ? str(g.tone) : 'brand',
    };
  });

  const nodeIds = new Set();
  doc.nodes = (Array.isArray(src.nodes) ? src.nodes : []).slice(0, 400).map((n, i) => {
    const id = str(n && n.id) || uid('n');
    nodeIds.add(id);
    const node = {
      id,
      label: str(n && n.label, 'idea ' + (i + 1)).replace(/\s+/g, ' ').slice(0, 160),
      x: num(n && n.x, 0), y: num(n && n.y, 0),
      group: groupIds.has(str(n && n.group)) ? str(n.group) : null,
      emphasis: Boolean(n && n.emphasis),
      link: str(n && n.link) || null,
      note: str(n && n.note).slice(0, 400),
      w: 0, h: 0,
    };
    layoutNode(node);
    return node;
  });

  doc.edges = (Array.isArray(src.edges) ? src.edges : []).slice(0, 800)
    .filter((e) => e && nodeIds.has(str(e.from)) && nodeIds.has(str(e.to)) && str(e.from) !== str(e.to))
    .map((e) => ({
      id: str(e.id) || uid('e'),
      from: str(e.from),
      to: str(e.to),
      label: str(e.label).replace(/\s+/g, ' ').slice(0, 60),
      weight: clamp(Math.round(num(e.weight, 1)), 1, 3),
      emphasis: Boolean(e.emphasis),
    }));

  if (src.image && typeof src.image === 'object' && str(src.image.src).slice(0, 11) === 'data:image/') {
    doc.image = {
      src: str(src.image.src),
      x: num(src.image.x, 0), y: num(src.image.y, 0),
      w: clamp(num(src.image.w, 640), 40, 6000),
      h: clamp(num(src.image.h, 480), 40, 6000),
      opacity: clamp(num(src.image.opacity, 0.45), 0.05, 1),
    };
  }

  const v = src.view && typeof src.view === 'object' ? src.view : {};
  doc.view = { tx: num(v.tx, 0), ty: num(v.ty, 0), scale: clamp(num(v.scale, 1), SCALE_MIN, SCALE_MAX) };
  doc.version = Math.max(1, Math.round(num(src.version, 1)));
  doc.updatedISO = /^\d{4}-\d{2}-\d{2}$/.test(str(src.updatedISO)) ? str(src.updatedISO) : todayLocalISO();
  doc.updatedTs = num(src.updatedTs, nowTs());
  return doc;
}

/** Recompute a node's drawn box from its label (real measurement). */
export function layoutNode(node) {
  const lines = wrapLabel(node.label || '…', NODE_MAX_W - NODE_PAD_X * 2, NODE_FONT, MAX_LINES);
  let textW = 0;
  for (const line of lines) textW = Math.max(textW, measureText(line, { size: NODE_FONT, weight: 500 }));
  node._lines = lines;
  node.w = Math.round(clamp(textW + NODE_PAD_X * 2, NODE_MIN_W, NODE_MAX_W));
  node.h = Math.round(Math.max(38, lines.length * LINE_H + 20));
  return node;
}

/** Drop the `_`-prefixed layout caches before writing or exporting. */
export function stripRuntime(doc, viewOverride) {
  const v = viewOverride || doc.view || { tx: 0, ty: 0, scale: 1 };
  return {
    v: 1, kind: 'engram-map',
    id: doc.id, topicId: doc.topicId, subject: doc.subject, title: doc.title,
    nodes: (doc.nodes || []).map((n) => ({
      id: n.id, label: n.label, x: Math.round(n.x), y: Math.round(n.y),
      group: n.group || null, emphasis: !!n.emphasis, link: n.link || null, note: n.note || '',
    })),
    edges: (doc.edges || []).map((e) => ({
      id: e.id, from: e.from, to: e.to, label: e.label || '', weight: e.weight, emphasis: !!e.emphasis,
    })),
    groups: (doc.groups || []).map((g) => ({
      id: g.id, label: g.label, x: Math.round(g.x), y: Math.round(g.y),
      w: Math.round(g.w), h: Math.round(g.h), tone: g.tone,
    })),
    image: doc.image ? Object.assign({}, doc.image) : null,
    view: { tx: Math.round(num(v.tx, 0)), ty: Math.round(num(v.ty, 0)), scale: Number(num(v.scale, 1).toFixed(3)) },
    version: doc.version || 1,
    updatedISO: doc.updatedISO || todayLocalISO(),
    updatedTs: doc.updatedTs || nowTs(),
  };
}

/* ---------------------------------------------------------------------------
   4. Island detector (GRINDE "I")
   ------------------------------------------------------------------------ */

/**
 * Connected components over the UNDIRECTED link graph. The largest component is
 * the mainland; everything else is an island (a lone idea counts).
 * @param {Object} doc
 * @returns {{islands:string[][], mainland:string[], islandNodes:Set<string>}}
 */
export function findIslands(doc) {
  const nodes = (doc && doc.nodes) || [];
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of (doc && doc.edges) || []) {
    if (adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
  }
  const seen = new Set();
  const comps = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    const comp = [];
    seen.add(n.id);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nxt of adj.get(cur) || []) if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
    }
    comps.push(comp);
  }
  comps.sort((a, b) => b.length - a.length);
  // There is no mainland until something is actually linked. With N nodes and
  // zero edges every component is a singleton, so crowning comps[0] promoted one
  // arbitrary lone idea to "connected" and under-reported the islands by exactly
  // one — the badge said "3 islands" over four unlinked boxes, and one of them
  // was left unflagged. GRINDE "I" is about links: no links, no mainland.
  const hasMainland = comps.length > 0 && comps[0].length > 1;
  const mainland = hasMainland ? comps[0] : [];
  const islands = hasMainland ? comps.slice(1) : comps;
  const islandNodes = new Set();
  for (const c of islands) for (const id of c) islandNodes.add(id);
  return { islands, mainland, islandNodes };
}

/* ---------------------------------------------------------------------------
   5. Recall comparison (GRINDE "R")
   ------------------------------------------------------------------------ */

/**
 * Compare a from-memory rebuild against the saved map.
 * @param {Object} base saved map
 * @param {Object} attempt rebuilt-from-memory map
 * @returns {{matched:Array, missing:Array, added:Array, recalled:number, total:number,
 *            edgesMatched:number, edgesTotal:number, edgesAdded:number}}
 */
export function diffMaps(base, attempt) {
  const baseNodes = (base && base.nodes) || [];
  const attemptNodes = (attempt && attempt.nodes) || [];
  const baseByLabel = new Map();
  for (const n of baseNodes) if (!baseByLabel.has(normLabel(n.label))) baseByLabel.set(normLabel(n.label), n);
  const attemptByLabel = new Map();
  for (const n of attemptNodes) if (!attemptByLabel.has(normLabel(n.label))) attemptByLabel.set(normLabel(n.label), n);

  const matched = [];
  const added = [];
  for (const n of attemptNodes) {
    const k = normLabel(n.label);
    if (baseByLabel.has(k)) matched.push({ attempt: n, base: baseByLabel.get(k) });
    else added.push(n);
  }
  const missing = baseNodes.filter((n) => !attemptByLabel.has(normLabel(n.label)));

  const keysOf = (d) => {
    const byId = new Map();
    for (const n of (d.nodes || [])) byId.set(n.id, normLabel(n.label));
    return (d.edges || []).map((e) => (byId.get(e.from) || '?') + '\u2192' + (byId.get(e.to) || '?'));
  };
  const baseEdgeKeys = new Set(keysOf(base || {}));
  let edgesMatched = 0;
  let edgesAdded = 0;
  for (const k of keysOf(attempt || {})) { if (baseEdgeKeys.has(k)) edgesMatched += 1; else edgesAdded += 1; }

  return {
    matched, missing, added,
    recalled: matched.length,
    total: baseNodes.length,
    edgesMatched,
    edgesTotal: baseEdgeKeys.size,
    edgesAdded,
  };
}

/* ---------------------------------------------------------------------------
   6. Store helpers  (store API only — §9.3: a refused write never deletes)
   ------------------------------------------------------------------------ */

function objectAt(key) {
  const raw = store.get(key, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** Every saved map, freshest first. */
export function listMaps(topicId) {
  const out = [];
  for (const [id, doc] of Object.entries(objectAt(KEYS.MAPS))) {
    if (!doc || typeof doc !== 'object') continue;
    if (topicId && doc.topicId !== topicId) continue;
    out.push({
      id,
      title: str(doc.title, 'Untitled map'),
      topicId: str(doc.topicId),
      subject: str(doc.subject),
      nodes: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
      edges: Array.isArray(doc.edges) ? doc.edges.length : 0,
      updatedISO: str(doc.updatedISO, ''),
      updatedTs: num(doc.updatedTs, 0),
    });
  }
  out.sort((a, b) => b.updatedTs - a.updatedTs);
  return out;
}

export function loadMap(mapId) {
  const doc = objectAt(KEYS.MAPS)[String(mapId)];
  return doc ? normalizeMapDoc(doc) : null;
}

let quotaWarned = false;

function warnQuotaOnce() {
  if (quotaWarned) return;
  quotaWarned = true;
  toast('Storage is full — the map is still on screen but was not saved. Export it to a file.', { tone: 'warn', timeout: 9000 });
}

/**
 * Persist a map. Returns false when the store refused (quota).
 * NOTHING is ever deleted to make room (build-constraints §9.3).
 */
export function saveMap(doc, viewOverride) {
  if (!doc || !doc.id) return false;
  doc.updatedISO = todayLocalISO();
  doc.updatedTs = nowTs();
  const all = objectAt(KEYS.MAPS);
  all[doc.id] = stripRuntime(doc, viewOverride);
  const ok = store.set(KEYS.MAPS, all);
  if (!ok) warnQuotaOnce();
  return ok;
}

export function deleteMap(mapId) {
  const all = objectAt(KEYS.MAPS);
  delete all[String(mapId)];
  return store.set(KEYS.MAPS, all);
}

/* --- version history ------------------------------------------------------ */

export function listVersions(mapId) {
  const rows = objectAt(VERSION_KEY)[String(mapId)];
  return Array.isArray(rows) ? rows.slice().sort((a, b) => b.ts - a.ts) : [];
}

/** Snapshot the map. Named saves are never pruned; unnamed keep the last 20. */
export function saveVersion(doc, name, viewOverride) {
  if (!doc || !doc.id) return null;
  const entry = {
    id: uid('v'), ts: nowTs(), day: todayLocalISO(),
    name: name ? String(name).slice(0, 48) : null,
    doc: stripRuntime(doc, viewOverride),
  };
  const all = objectAt(VERSION_KEY);
  const rows = Array.isArray(all[doc.id]) ? all[doc.id].slice() : [];
  rows.push(entry);
  const named = rows.filter((r) => r.name);
  const unnamed = rows.filter((r) => !r.name).sort((a, b) => b.ts - a.ts).slice(0, MAX_UNNAMED_VERSIONS);
  all[doc.id] = named.concat(unnamed).sort((a, b) => a.ts - b.ts);
  if (!store.set(VERSION_KEY, all)) { warnQuotaOnce(); return null; }
  return entry;
}

export function deleteVersion(mapId, versionId) {
  const all = objectAt(VERSION_KEY);
  all[String(mapId)] = (Array.isArray(all[String(mapId)]) ? all[String(mapId)] : []).filter((r) => r.id !== versionId);
  return store.set(VERSION_KEY, all);
}

export function readRecall(mapId) {
  return objectAt(RECALL_KEY)[String(mapId)] || null;
}

export function writeRecall(mapId, summary) {
  const all = objectAt(RECALL_KEY);
  all[String(mapId)] = Object.assign({ lastTs: nowTs(), day: todayLocalISO() }, summary);
  return store.set(RECALL_KEY, all);
}

/* ---------------------------------------------------------------------------
   7. Export / import / deep links
   ------------------------------------------------------------------------ */

/** shared_items 'map' envelope: {type, title, body} with body = JSON string. */
export function serializeMapPayload(doc, viewOverride) {
  return {
    engram: 'map@1',
    type: 'map',
    title: str(doc.title, 'Untitled map'),
    body: JSON.stringify(stripRuntime(doc, viewOverride)),
  };
}

/**
 * Accept a raw doc, a shared_items row, or the export envelope.
 * @param {string|Object} input
 * @returns {Object|null} normalised doc
 */
export function parseMapPayload(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  if (typeof data.body === 'string') {
    try { data = JSON.parse(data.body); } catch (_) { return null; }
  } else if (data.body && typeof data.body === 'object') {
    data = data.body;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) return null;
  return normalizeMapDoc(data);
}

function escapeRx(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Resolve a node deep link ('lesson:0003', 'topic:mole-concept', 'card:abc',
 * 'note:x', or a literal '#/route') to a hash route.
 * @returns {string|null}
 */
export function resolveDeepLink(link, topicId) {
  const raw = String(link == null ? '' : link).trim();
  if (!raw) return null;
  if (raw.slice(0, 2) === '#/') return raw;
  const m = /^([a-z]+)\s*:\s*(.+)$/i.exec(raw);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const ref = m[2].trim();

  if (kind === 'topic') return routeFor('topic', { id: ref });
  if (kind === 'card') return '#/study?card=' + encodeURIComponent(ref);
  if (kind === 'note') return routeFor('topic', { id: topicId || ref, note: ref });
  if (kind === 'map') return routeFor('maps', { topic: ref });
  if (kind === 'lesson' || kind === 'doc' || kind === 'cheatsheet') {
    const topic = getTopic(topicId);
    if (topic) {
      const rx = new RegExp('(^|/)' + escapeRx(ref) + '[-._]', 'i');
      const lower = ref.toLowerCase();
      const found =
        topic.docs.find((d) => d.url === ref) ||
        topic.docs.find((d) => rx.test(d.url)) ||
        topic.docs.find((d) => d.url.toLowerCase().indexOf(lower) >= 0) ||
        topic.docs.find((d) => d.title.toLowerCase().indexOf(lower) >= 0);
      if (found) return routeFor('lesson', { topic: topic.id, file: found.url });
    }
    return topicId ? routeFor('topic', { id: topicId }) : null;
  }
  return null;
}

/* ---------------------------------------------------------------------------
   8. Photo import — downscaled hard, because localStorage is small
   ------------------------------------------------------------------------ */

const PHOTO_MAX_EDGE = 900;
const PHOTO_MAX_CHARS = 520000;

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('that file is not an image the browser can open'));
      img.onload = () => resolve(img);
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * File -> {src, w, h} downscaled data URL, or throws with a readable message.
 * Never touches the network.
 */
export async function importPhoto(file) {
  if (!file) throw new Error('no file chosen');
  if (!/^image\//.test(file.type || '')) throw new Error('choose a photo (JPG, PNG or WebP)');
  const img = await readImageFile(file);
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const k = Math.min(1, PHOTO_MAX_EDGE / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  let src = canvas.toDataURL('image/jpeg', 0.62);
  if (src.length > PHOTO_MAX_CHARS) src = canvas.toDataURL('image/jpeg', 0.45);
  if (src.length > PHOTO_MAX_CHARS * 1.3) throw new Error('that photo is too big to store — crop it and try again');
  return { src, w, h };
}

/* ---------------------------------------------------------------------------
   9. A small text-entry modal (native prompt() is blocked in some contexts and
      looks nothing like the rest of the hub)
   ------------------------------------------------------------------------ */

/**
 * @param {{title:string, hint?:string, value?:string, placeholder?:string,
 *          okLabel?:string, meter?:(v:string)=>{text:string, tone:string}}} spec
 * @returns {Promise<string|null>} null when cancelled
 */
export function askText(spec) {
  ensureStyles();
  const o = spec || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      offEsc();
      scrim.remove();
      resolve(value);
    };
    const input = el('input.input', {
      type: 'text', value: o.value || '', placeholder: o.placeholder || '',
      attrs: { enterkeyhint: 'done', 'aria-label': o.title || 'Value' },
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } },
    });
    const meter = o.meter ? el('div.hint') : null;
    const sync = () => {
      if (!meter) return;
      const r = o.meter(input.value);
      meter.className = 'hint' + (r.tone === 'bad' ? ' hint--error' : '');
      meter.replaceChildren(el('span', { text: r.text }));
    };
    if (meter) { input.addEventListener('input', sync); sync(); }

    const modal = el('div.modal', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Enter a value' } },
      el('div.modal__head', el('h2.modal__title', { text: o.title || 'Enter a value' })),
      el('div.modal__body',
        o.hint ? el('p.card__sub', { text: o.hint }) : null,
        el('div.field', input, meter)),
      el('div.modal__foot',
        el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => finish(null) }),
        el('button.btn.btn-primary', { type: 'button', text: o.okLabel || 'Save', onClick: () => finish(input.value) })));

    const scrim = el('div.scrim.mm__scrim', { onClick: (e) => { if (e.target === scrim) finish(null); } }, modal);
    document.body.appendChild(scrim);
    const offEsc = on(document, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } });
    setTimeout(() => { input.focus(); input.select(); }, 20);
  });
}

/* ---------------------------------------------------------------------------
   10. Styles (injected once; design tokens only, no raw colours)
   ------------------------------------------------------------------------ */

const STYLE_ID = 'engram-mindmap-css';

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.mm { display: flex; flex-direction: column; gap: var(--sp-3); }
.mm__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
/* used in the toolbar AND in the inspector row — must not be scoped to .mm__bar */
.mm__spacer { flex: 1 1 auto; min-width: 0; }
.mm__stage {
  position: relative; width: 100%;
  height: clamp(340px, 58vh, 640px);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-card), var(--lip);
  overflow: hidden;
  touch-action: none;
  -webkit-user-select: none; user-select: none;
  cursor: grab;
}
@media (min-width: 900px) { .mm__stage { height: clamp(420px, 66vh, 780px); } }
.mm__stage:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--sh-card); }
.mm__stage.is-panning { cursor: grabbing; }
.mm__stage.is-linking { cursor: crosshair; }
.mm__svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

/* --- groups (GRINDE G) --- */
.mm-group__box {
  fill: rgb(var(--accent-rgb) / 0.06);
  stroke: rgb(var(--accent-rgb) / 0.45);
  stroke-width: 1.5; stroke-dasharray: 7 5;
}
.mm-group.is-selected .mm-group__box { stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: none; }
.mm-group.is-hot .mm-group__box { fill: rgb(var(--accent-rgb) / 0.16); stroke-dasharray: none; }
.mm-group__label {
  fill: var(--accent); font-size: 10px; font-weight: 600;
  letter-spacing: var(--tr-eyebrow); text-transform: uppercase;
  font-family: var(--font-sans);
}
.mm-group__grab { fill: transparent; cursor: grab; }

/* --- links (GRINDE D) --- */
.mm-edge__line { fill: none; stroke: var(--fg-subtle); stroke-linecap: round; stroke-width: 1.4; }
.mm-edge__head { fill: var(--fg-subtle); stroke: none; }
.mm-edge__hit { fill: none; stroke: rgb(0 0 0 / 0); stroke-width: 24; cursor: pointer; }
.mm-edge[data-weight="2"] .mm-edge__line { stroke-width: 2.4; }
.mm-edge[data-weight="3"] .mm-edge__line { stroke-width: 3.4; }
.mm-edge.is-emphasis .mm-edge__line { stroke: var(--accent); }
.mm-edge.is-emphasis .mm-edge__head { fill: var(--accent); }
.mm-edge.is-selected .mm-edge__line { stroke: var(--brand); }
.mm-edge.is-selected .mm-edge__head { fill: var(--brand); }
.mm-edge__label {
  fill: var(--fg-muted); font-size: 10px; font-family: var(--font-sans);
  text-anchor: middle; paint-order: stroke;
  stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;
}

/* --- ideas --- */
.mm-node { cursor: grab; }
.mm-node__box { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1.25; }
.mm-node__text { fill: var(--fg); font-size: 13px; font-weight: 500; font-family: var(--font-sans); }
.mm-node.is-emphasis .mm-node__box { fill: rgb(var(--accent-rgb) / 0.14); stroke: var(--accent); stroke-width: 2.2; }
.mm-node.is-emphasis .mm-node__text { font-weight: 600; }
.mm-node.is-selected .mm-node__box { stroke: var(--brand); stroke-width: 2.4; }
.mm-node.is-island .mm-node__box { stroke: var(--warn); stroke-dasharray: 5 4; }
.mm-node.is-ghost { opacity: 0.5; }
.mm-node.is-ghost .mm-node__box { fill: rgb(var(--bad-rgb) / 0.08); stroke: var(--bad); stroke-dasharray: 6 4; }
.mm-node.is-ghost .mm-node__text { fill: var(--bad); }
.mm-node.is-new .mm-node__box { fill: rgb(var(--info-rgb) / 0.14); stroke: var(--info); }
.mm-node.is-new .mm-node__text { fill: var(--info); }
.mm-node.is-match .mm-node__box { stroke: var(--good); }
.mm-node__dot { stroke: none; }
.mm-node__dot--link { fill: var(--info); }
.mm-node__dot--verbose { fill: var(--warn); }
.mm-node__dot--island { fill: var(--warn); }

/* --- handles: counter-scaled so they stay finger-sized at any zoom --- */
.mm-handle__hit { fill: rgb(0 0 0 / 0); cursor: crosshair; }
.mm-handle__dot { fill: var(--brand); stroke: var(--bg); stroke-width: 2; pointer-events: none; }
.mm-resize__hit { fill: rgb(0 0 0 / 0); cursor: nwse-resize; }
.mm-resize__dot { fill: var(--accent); stroke: var(--bg); stroke-width: 2; pointer-events: none; }
.mm-ghost-line { fill: none; stroke: var(--brand); stroke-width: 2; stroke-dasharray: 6 5; }

/* --- inline editor --- */
.mm__edit {
  position: absolute; z-index: 3; margin: 0;
  min-width: 168px; min-height: 46px;
  padding: 8px 10px; resize: none;
  font-family: var(--font-sans);
  font-size: var(--fs-input); line-height: 1.35;
  border: 2px solid var(--brand); border-radius: var(--r-md);
  background: var(--surface); color: var(--fg);
  box-shadow: var(--sh-pop);
}
.mm__edit-meter {
  position: absolute; z-index: 4;
  padding: 4px 9px; border-radius: var(--r-full);
  font-size: var(--fs-micro); letter-spacing: var(--tr-micro); text-transform: uppercase;
  background: var(--surface-muted); border: 1px solid var(--border);
  color: var(--fg-muted); white-space: nowrap;
}
.mm__edit-meter[data-tone="warn"] { color: var(--warn); border-color: var(--warn-bd); background: var(--warn-bg); }
.mm__edit-meter[data-tone="good"] { color: var(--good); border-color: var(--good-bd); background: var(--good-bg); }

/* --- floating chrome --- */
.mm__hint {
  position: absolute; left: 50%; bottom: var(--sp-3); transform: translateX(-50%);
  z-index: 2; pointer-events: none;
  padding: 6px 12px; border-radius: var(--r-full);
  background: rgb(var(--surface-rgb) / 0.9);
  border: 1px solid var(--border); box-shadow: var(--lip);
  font-size: var(--fs-meta); color: var(--fg-muted); text-align: center;
  max-width: calc(100% - var(--sp-6));
}
.mm__badge {
  position: absolute; top: var(--sp-3); right: var(--sp-3); z-index: 2;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  pointer-events: none;
}
.mm__inspect {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface-muted); box-shadow: var(--lip);
}
.mm__inspect-label {
  font-size: var(--fs-caption); color: var(--fg); font-weight: var(--fw-medium);
  max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* an author display rule beats the UA sheet's [hidden]{display:none} — say it
   here, or the empty inspector bar stays on screen. */
.mm__inspect[hidden], .mm__hint[hidden] { display: none; }
.mm__panel {
  padding: var(--sp-4); border: 1px solid var(--border);
  border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--lip);
  display: flex; flex-direction: column; gap: var(--sp-3);
}
.mm__vlist { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
.mm__vrow {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px 8px; border-radius: var(--r-md);
  background: var(--surface-muted); border: 1px solid var(--border);
  min-height: var(--tap);
}
.mm__vrow-main { flex: 1 1 auto; min-width: 0; }
.mm__vrow-name { font-size: var(--fs-caption); color: var(--fg); }
.mm__vrow-meta { font-size: var(--fs-micro); color: var(--fg-subtle); }
.mm__range { flex: 1 1 140px; min-width: 110px; height: var(--tap); accent-color: var(--accent); }
.mm__summary { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
.mm__file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.mm__scrim { display: flex; align-items: center; justify-content: center; padding: var(--sp-4); }
.mm-pulse { animation: mm-pulse 1.1s var(--ease) 2; }
@keyframes mm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .mm-pulse { animation: none; } }
`;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
   11. The editor
   ------------------------------------------------------------------------ */

/**
 * Mount a GRINDE map editor.
 *
 * @param {HTMLElement} host
 * @param {{
 *   doc?: Object, topicId?: string, subject?: string, readOnly?: boolean,
 *   onChange?: (doc:Object) => void,
 *   onSelect?: (node:Object|null) => void,
 *   onActivity?: (kind:'review'|'encode'|'drill', meta:Object) => void,
 * }} [opts]
 * @returns {Object} controller
 */
export function createMindmapCanvas(host, opts) {
  ensureStyles();
  const o = opts || {};
  const offs = [];
  let destroyed = false;

  let doc = o.doc ? normalizeMapDoc(o.doc) : createMapDoc({ topicId: o.topicId, subject: o.subject });

  const view = { tx: doc.view.tx, ty: doc.view.ty, scale: doc.view.scale };
  let mode = 'edit';                 // 'edit' | 'recall' | 'compare'
  let baseline = null;               // saved map stashed during recall
  let compareInfo = null;
  let sel = null;                    // {kind:'node'|'edge'|'group', id}
  let showIslands = true;
  let islandInfo = findIslands(doc);
  let encodeLogged = false;
  let openPanel = null;
  let editor = null;

  /* ---- DOM ------------------------------------------------------------- */
  const root = el('div.mm', { dataset: { subject: (o.subject || doc.subject || '').toLowerCase() } });
  const bar = el('div.mm__bar');
  const stage = el('div.mm__stage.grid-bg', {
    attrs: { role: 'application', 'aria-label': 'Mind map canvas', tabindex: '0' },
  });
  const inspect = el('div.mm__inspect', { hidden: true });
  const panelHost = el('div');
  const fileInput = el('input.mm__file', { type: 'file', accept: 'image/*', attrs: { tabindex: '-1', 'aria-hidden': 'true' } });
  const importInput = el('input.mm__file', { type: 'file', accept: 'application/json,.json', attrs: { tabindex: '-1', 'aria-hidden': 'true' } });

  const svg = s('svg', { class: 'mm__svg' });
  const world = s('g', { class: 'mm__world' });
  const layerImage = s('g');
  const layerGroups = s('g');
  const layerEdges = s('g');
  const layerNodes = s('g');
  const layerOverlay = s('g');
  world.append(layerImage, layerGroups, layerEdges, layerNodes, layerOverlay);
  svg.appendChild(world);

  const badge = el('div.mm__badge');
  const hint = el('div.mm__hint');
  stage.append(svg, badge, hint);
  root.append(bar, stage, inspect, panelHost, fileInput, importInput);
  host.appendChild(root);

  /* ---- coordinates ----------------------------------------------------- */
  const rectOf = () => stage.getBoundingClientRect();
  function toWorld(clientX, clientY) {
    const r = rectOf();
    return { x: (clientX - r.left - view.tx) / view.scale, y: (clientY - r.top - view.ty) / view.scale };
  }
  function applyTransform() {
    world.setAttribute('transform', 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')');
    const g = GRID * view.scale;
    stage.style.backgroundSize = g + 'px ' + g + 'px';
    stage.style.backgroundPosition = view.tx + 'px ' + view.ty + 'px';
    renderOverlay();
  }

  const nodeById = (id) => doc.nodes.find((n) => n.id === id) || null;
  const groupById = (id) => doc.groups.find((g) => g.id === id) || null;

  /* ---- persistence ----------------------------------------------------- */
  let saveTimer = null;
  function touch(structural) {
    doc.version += 1;
    if (structural) {
      // Islands must be recomputed BEFORE the island-tinted layers are painted.
      // Callers paint first (so the new node/edge appears immediately), so the
      // repaint belongs here — otherwise the badge and the dashed outlines lag
      // one edit behind, which reads as "the detector is broken".
      islandInfo = findIslands(doc);
      renderNodes();
      renderBadges();
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (destroyed || mode !== 'edit') return;
      saveMap(doc, view);
      if (o.onChange) { try { o.onChange(doc); } catch (err) { console.error('[maps] onChange failed', err); } }
      if (!encodeLogged && doc.nodes.length >= 3 && o.onActivity) {
        encodeLogged = true;
        try {
          o.onActivity('encode', {
            source: 'grinde-map', mapId: doc.id, topicId: doc.topicId,
            nodes: doc.nodes.length, edges: doc.edges.length,
          });
        } catch (_) { /* the game layer is optional */ }
      }
    }, 700);
  }

  /* ---- rendering ------------------------------------------------------- */

  function renderImage() {
    layerImage.replaceChildren();
    if (!doc.image) return;
    layerImage.appendChild(s('image', {
      href: doc.image.src, x: doc.image.x, y: doc.image.y,
      width: doc.image.w, height: doc.image.h,
      opacity: doc.image.opacity, preserveAspectRatio: 'none', 'pointer-events': 'none',
    }));
  }

  function renderGroups() {
    layerGroups.replaceChildren();
    for (const g of doc.groups) {
      const node = s('g', {
        class: 'mm-group tone-' + g.tone + (sel && sel.kind === 'group' && sel.id === g.id ? ' is-selected' : ''),
        dataset: { groupId: g.id },
      });
      node.appendChild(s('rect', { class: 'mm-group__box', x: g.x, y: g.y, width: g.w, height: g.h, rx: 14, ry: 14 }));
      node.appendChild(s('text', { class: 'mm-group__label', x: g.x + 12, y: g.y + 21, text: g.label }));
      node.appendChild(s('rect', {
        class: 'mm-group__grab', x: g.x, y: g.y, width: g.w, height: 32, rx: 14, ry: 14,
        dataset: { grabGroup: g.id },
      }));
      layerGroups.appendChild(node);
    }
  }

  function anchorOn(node, tx, ty) {
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const hw = node.w / 2 + 3;
    const hh = node.h / 2 + 3;
    const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
    const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
    const k = Math.min(sx, sy);
    return { x: cx + dx * k, y: cy + dy * k };
  }

  function edgeGeometry(e) {
    const a = nodeById(e.from);
    const b = nodeById(e.to);
    if (!a || !b) return null;
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = anchorOn(a, bc.x, bc.y);
    const tip = anchorOn(b, ac.x, ac.y);
    const dx = tip.x - p1.x;
    const dy = tip.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = clamp(len * 0.09, 0, 26);
    const mx = (p1.x + tip.x) / 2 - (dy / len) * bow;
    const my = (p1.y + tip.y) / 2 + (dx / len) * bow;
    const angle = Math.atan2(tip.y - my, tip.x - mx);
    const head = 9 + e.weight * 1.6;
    return {
      p1,
      p2: { x: tip.x - Math.cos(angle) * head * 0.6, y: tip.y - Math.sin(angle) * head * 0.6 },
      mx, my, angle, tip, head,
    };
  }

  function arrowHeadPath(x, y, angle, size) {
    const a1 = angle + Math.PI * 0.86;
    const a2 = angle - Math.PI * 0.86;
    return 'M' + x + ' ' + y +
      ' L' + (x + size * Math.cos(a1)) + ' ' + (y + size * Math.sin(a1)) +
      ' L' + (x + size * Math.cos(a2)) + ' ' + (y + size * Math.sin(a2)) + ' Z';
  }

  function renderEdges() {
    layerEdges.replaceChildren();
    for (const e of doc.edges) {
      const geo = edgeGeometry(e);
      if (!geo) continue;
      const g = s('g', {
        class: 'mm-edge' + (e.emphasis ? ' is-emphasis' : '') +
          (sel && sel.kind === 'edge' && sel.id === e.id ? ' is-selected' : ''),
        dataset: { edgeId: e.id, weight: String(e.weight) },
      });
      const d = 'M' + geo.p1.x + ' ' + geo.p1.y + ' Q' + geo.mx + ' ' + geo.my + ' ' + geo.p2.x + ' ' + geo.p2.y;
      g.appendChild(s('path', { class: 'mm-edge__hit', d }));
      g.appendChild(s('path', { class: 'mm-edge__line', d }));
      g.appendChild(s('path', { class: 'mm-edge__head', d: arrowHeadPath(geo.tip.x, geo.tip.y, geo.angle, geo.head) }));
      if (e.label) g.appendChild(s('text', { class: 'mm-edge__label', x: geo.mx, y: geo.my - 6, text: e.label }));
      layerEdges.appendChild(g);
    }
  }

  function nodeClasses(n) {
    let cls = 'mm-node';
    const groupTone = n.group ? (groupById(n.group) || {}).tone : null;
    if (groupTone) cls += ' tone-' + groupTone;
    if (n.emphasis) cls += ' is-emphasis';
    if (sel && sel.kind === 'node' && sel.id === n.id) cls += ' is-selected';
    if (mode !== 'compare' && showIslands && islandInfo.islandNodes.has(n.id) && doc.nodes.length > 1) cls += ' is-island';
    if (n._cmp === 'missing') cls += ' is-ghost';
    if (n._cmp === 'new') cls += ' is-new';
    if (n._cmp === 'match') cls += ' is-match';
    return cls;
  }

  function renderOneNode(n) {
    const g = s('g', {
      class: nodeClasses(n),
      dataset: { nodeId: n.id },
      transform: 'translate(' + n.x + ',' + n.y + ')',
    });
    g.appendChild(s('rect', { class: 'mm-node__box', x: 0, y: 0, width: n.w, height: n.h, rx: 10, ry: 10 }));
    const lines = n._lines || wrapLabel(n.label, NODE_MAX_W - NODE_PAD_X * 2, NODE_FONT, MAX_LINES);
    const startY = (n.h - lines.length * LINE_H) / 2 + LINE_H - 4;
    lines.forEach((line, i) => {
      g.appendChild(s('text', {
        class: 'mm-node__text', x: n.w / 2, y: startY + i * LINE_H, 'text-anchor': 'middle', text: line,
      }));
    });
    const dots = [];
    if (n.link) dots.push('link');
    if (mode !== 'compare') {
      // in compare mode the only signal that matters is match / missing / new
      if (wordCount(n.label) > VERBOSE_LIMIT) dots.push('verbose');
      if (showIslands && islandInfo.islandNodes.has(n.id) && doc.nodes.length > 1) dots.push('island');
    }
    dots.forEach((kind, i) => {
      g.appendChild(s('circle', { class: 'mm-node__dot mm-node__dot--' + kind, cx: n.w - 8 - i * 9, cy: 8, r: 3.2 }));
    });
    return g;
  }

  function renderNodes() {
    layerNodes.replaceChildren();
    for (const n of doc.nodes) layerNodes.appendChild(renderOneNode(n));
  }

  function refreshNode(n) {
    const old = layerNodes.querySelector('[data-node-id="' + cssEscape(n.id) + '"]');
    const next = renderOneNode(n);
    if (old) layerNodes.replaceChild(next, old);
    else layerNodes.appendChild(next);
  }

  /** Handles live in world space, counter-scaled so they stay ~44 px on screen. */
  function renderOverlay() {
    layerOverlay.replaceChildren();
    if (mode === 'compare' || o.readOnly) return;
    const inv = 1 / view.scale;
    if (sel && sel.kind === 'node') {
      const n = nodeById(sel.id);
      if (n) {
        const g = s('g', { transform: 'translate(' + (n.x + n.w) + ',' + (n.y + n.h / 2) + ') scale(' + inv + ')' });
        g.appendChild(s('circle', { class: 'mm-handle__hit', cx: 11, cy: 0, r: 22, dataset: { linkFrom: n.id } }));
        g.appendChild(s('circle', { class: 'mm-handle__dot', cx: 11, cy: 0, r: 7 }));
        layerOverlay.appendChild(g);
      }
    }
    if (sel && sel.kind === 'group') {
      const gr = groupById(sel.id);
      if (gr) {
        const g = s('g', { transform: 'translate(' + (gr.x + gr.w) + ',' + (gr.y + gr.h) + ') scale(' + inv + ')' });
        g.appendChild(s('circle', { class: 'mm-resize__hit', cx: 0, cy: 0, r: 22, dataset: { resizeGroup: gr.id } }));
        g.appendChild(s('circle', { class: 'mm-resize__dot', cx: 0, cy: 0, r: 7 }));
        layerOverlay.appendChild(g);
      }
    }
  }

  function render() {
    renderImage();
    renderGroups();
    renderEdges();
    renderNodes();
    applyTransform();
    renderBar();
    renderInspector();
    renderHint();
    renderBadges();
  }

  /* ---- chrome ---------------------------------------------------------- */

  function chip(label, iconName, onClick, extra) {
    const b = el('button.chip.chip--button', { type: 'button', onClick });
    if (iconName) b.appendChild(icon(iconName, { size: 14 }));
    b.appendChild(el('span', { text: label }));
    b.setAttribute('aria-pressed', extra && extra.active ? 'true' : 'false');
    if (extra && extra.active) b.classList.add('is-active');
    if (extra && extra.tone) b.dataset.tone = extra.tone;
    return b;
  }

  /** Two-tap delete — no native confirm(), no accidental loss. */
  function dangerChip(label, run) {
    let armed = false;
    let timer = null;
    const b = el('button.chip.chip--button', { type: 'button', dataset: { tone: 'bad' } });
    const paint = () => {
      b.replaceChildren(icon('trash', { size: 12 }), el('span', { text: armed ? 'Tap again' : label }));
      b.classList.toggle('is-active', armed);
    };
    b.addEventListener('click', () => {
      if (armed) { clearTimeout(timer); run(); return; }
      armed = true;
      paint();
      timer = setTimeout(() => { armed = false; if (b.isConnected) paint(); }, 3000);
    });
    paint();
    return b;
  }

  function iconBtn(name, label, onClick) {
    return el('button.btn.btn-icon', {
      type: 'button', attrs: { 'aria-label': label, title: label }, onClick,
    }, icon(name, { size: 16 }));
  }

  function renderBar() {
    bar.replaceChildren();
    if (o.readOnly) {
      bar.append(
        el('span.eyebrow', { text: 'Shared map · read only' }),
        el('div.mm__spacer'),
        iconBtn('minus', 'Zoom out', () => zoomBy(1 / 1.25)),
        iconBtn('plus', 'Zoom in', () => zoomBy(1.25)),
        iconBtn('target', 'Fit to screen', fit),
      );
      return;
    }
    if (mode === 'edit') {
      bar.append(
        chip('Idea', 'plus', () => addNodeAtCentre()),
        chip('Group', 'grid', () => addGroup()),
        chip(showIslands ? 'Islands on' : 'Islands off', 'waypoints', () => {
          showIslands = !showIslands;
          renderNodes(); renderBar(); renderBadges();
        }, { active: showIslands }),
        el('div.mm__spacer'),
        iconBtn('minus', 'Zoom out', () => zoomBy(1 / 1.25)),
        iconBtn('plus', 'Zoom in', () => zoomBy(1.25)),
        iconBtn('target', 'Fit to screen', fit),
        iconBtn('brain', 'Recall mode — rebuild from memory', () => startRecall()),
        iconBtn('more-horizontal', 'More map tools', () => togglePanel('more')),
      );
      return;
    }
    if (mode === 'recall') {
      bar.append(
        el('span.pill.pill--ai', icon('brain', { size: 12 }), el('span', { text: 'Recall · notes closed' })),
        chip('Idea', 'plus', () => addNodeAtCentre()),
        el('div.mm__spacer'),
        iconBtn('target', 'Fit to screen', fit),
        el('button.btn.btn-primary.btn--sm', { type: 'button', onClick: () => compare() },
          icon('circle-check', { size: 14 }), el('span', { text: 'Compare' })),
        el('button.btn.btn-ghost.btn--sm', { type: 'button', onClick: () => cancelRecall() }, el('span', { text: 'Cancel' })),
      );
      return;
    }
    bar.append(
      el('span.pill.pill--info', icon('eye', { size: 12 }), el('span', { text: 'Comparing' })),
      el('div.mm__spacer'),
      iconBtn('target', 'Fit to screen', fit),
      el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => keepRecall() },
        icon('check', { size: 14 }), el('span', { text: 'Keep rebuild' })),
      el('button.btn.btn-ghost.btn--sm', { type: 'button', onClick: () => cancelRecall() },
        icon('arrow-left', { size: 14 }), el('span', { text: 'Back to my map' })),
    );
  }

  function renderBadges() {
    badge.replaceChildren();
    if (mode === 'compare') return;
    const islands = islandInfo.islands.length;
    if (showIslands && islands > 0 && doc.nodes.length > 1) {
      badge.appendChild(el('span.pill.pill--warn', icon('alert-triangle', { size: 12 }),
        el('span', { text: islands + ' ' + fmt.plural(islands, 'island') + ' — link ' + (islands === 1 ? 'it' : 'them') + ' in' })));
    }
    const verbose = doc.nodes.filter((n) => wordCount(n.label) > VERBOSE_LIMIT).length;
    if (verbose > 0) {
      badge.appendChild(el('span.pill.pill--warn', icon('edit', { size: 12 }),
        el('span', { text: verbose + ' over ' + VERBOSE_LIMIT + ' words' })));
    }
  }

  function renderHint() {
    hint.replaceChildren();
    let text = '';
    if (o.readOnly) text = '';
    else if (mode === 'recall') {
      text = doc.nodes.length === 0
        ? 'Blank on purpose. Rebuild it from memory — double-tap to place an idea.'
        : doc.nodes.length + ' ' + fmt.plural(doc.nodes.length, 'idea') + ' placed. Compare when you have nothing left.';
    } else if (mode === 'compare' && compareInfo) {
      text = compareInfo.recalled + ' of ' + compareInfo.total + ' ideas recalled · ' +
        compareInfo.missing.length + ' missing (red) · ' + compareInfo.added.length + ' new (blue)';
    } else if (doc.nodes.length === 0) {
      text = 'Double-tap the canvas to place your first idea. Nobody draws this for you — that is the point.';
    } else if (!sel) {
      text = 'Tap an idea to select · drag the orange dot to link it · double-tap to rename';
    }
    hint.hidden = !text;
    if (text) hint.appendChild(el('span', { text }));
  }

  /* ---- inspector ------------------------------------------------------- */

  function renderInspector() {
    inspect.replaceChildren();
    if (o.readOnly || mode !== 'edit' || !sel) { inspect.hidden = true; return; }
    inspect.hidden = false;

    if (sel.kind === 'node') {
      const n = nodeById(sel.id);
      if (!n) { sel = null; inspect.hidden = true; return; }
      const words = wordCount(n.label);
      inspect.append(
        el('span.mm__inspect-label', { text: n.label }),
        el('span.pill', { class: words > VERBOSE_LIMIT ? 'pill--warn' : 'pill--neutral' },
          el('span', { text: words + ' ' + fmt.plural(words, 'word') })),
        chip('Rename', 'edit', () => beginEdit(n)),
        chip(n.emphasis ? 'On backbone' : 'Backbone', 'star', () => {
          n.emphasis = !n.emphasis; refreshNode(n); renderInspector(); touch(false);
        }, { active: n.emphasis }),
        chip('Link out', 'external-link', () => promptLink(n), { active: !!n.link }),
      );
      if (n.link) {
        const route = resolveDeepLink(n.link, doc.topicId);
        inspect.appendChild(el('button.chip.chip--button.chip--accent', {
          type: 'button',
          onClick: () => {
            if (route) navigateTo(route);
            else toast('Nothing in the vault matches “' + n.link + '” yet.', { tone: 'warn' });
          },
        }, icon('arrow-right', { size: 12 }), el('span', { text: n.link })));
      }
      inspect.append(el('div.mm__spacer'), dangerChip('Delete', () => removeNode(n)));
      return;
    }

    if (sel.kind === 'edge') {
      const e = doc.edges.find((x) => x.id === sel.id);
      if (!e) { sel = null; inspect.hidden = true; return; }
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      inspect.append(
        el('span.mm__inspect-label', { text: (a ? a.label : '?') + ' → ' + (b ? b.label : '?') }),
        chip('Weight ' + e.weight, 'gauge', () => {
          e.weight = e.weight >= 3 ? 1 : e.weight + 1;
          renderEdges(); renderInspector(); touch(false);
        }),
        chip(e.emphasis ? 'On backbone' : 'Backbone', 'star', () => {
          e.emphasis = !e.emphasis; renderEdges(); renderInspector(); touch(false);
        }, { active: e.emphasis }),
        chip(e.label || 'Label', 'edit', () => promptEdgeLabel(e)),
        chip('Flip', 'refresh', () => {
          const from = e.from; e.from = e.to; e.to = from;
          renderEdges(); touch(true);
        }),
        el('div.mm__spacer'),
        dangerChip('Delete', () => {
          doc.edges = doc.edges.filter((x) => x.id !== e.id);
          sel = null;
          renderEdges(); renderNodes(); renderOverlay(); renderInspector(); renderBadges(); touch(true);
        }),
      );
      return;
    }

    const g = groupById(sel.id);
    if (!g) { sel = null; inspect.hidden = true; return; }
    const gWords = wordCount(g.label);
    inspect.append(
      el('span.mm__inspect-label', { text: g.label }),
      el('span.pill', { class: gWords > GROUP_LABEL_WORDS ? 'pill--warn' : 'pill--neutral' },
        el('span', { text: gWords + '/' + GROUP_LABEL_WORDS + ' words' })),
      chip('Rename', 'edit', () => promptGroupLabel(g)),
      chip('Colour', 'sparkles', () => {
        g.tone = TONES[(TONES.indexOf(g.tone) + 1) % TONES.length];
        renderGroups(); renderNodes(); touch(false);
      }),
      el('div.mm__spacer'),
      dangerChip('Delete', () => {
        doc.groups = doc.groups.filter((x) => x.id !== g.id);
        for (const n of doc.nodes) if (n.group === g.id) n.group = null;
        sel = null;
        renderGroups(); renderNodes(); renderOverlay(); renderInspector(); touch(false);
      }),
    );
  }

  /* ---- inline label editing ------------------------------------------- */

  function beginEdit(n) {
    endEdit(false);
    const r = rectOf();
    const w = Math.max(168, Math.min(280, n.w * view.scale));
    const left = clamp(view.tx + n.x * view.scale, 6, Math.max(6, r.width - w - 6));
    const top = clamp(view.ty + n.y * view.scale, 6, Math.max(6, r.height - 96));
    const box = el('textarea.mm__edit', {
      value: n.label,
      attrs: { rows: '2', spellcheck: 'false', 'aria-label': 'Idea text' },
      style: { left: Math.round(left) + 'px', top: Math.round(top) + 'px', width: Math.round(w) + 'px' },
    });
    const meter = el('div.mm__edit-meter', { style: { left: Math.round(left) + 'px', top: Math.round(top) + 'px' } });
    const place = () => {
      // sit the meter just under the real rendered height of the textarea
      meter.style.top = Math.round(top + box.offsetHeight + 6) + 'px';
    };
    const sync = () => {
      const words = wordCount(box.value);
      meter.dataset.tone = words === 0 ? '' : words > VERBOSE_LIMIT ? 'warn' : 'good';
      meter.replaceChildren(el('span', {
        text: words > VERBOSE_LIMIT ? words + ' words — cut to ' + VERBOSE_LIMIT : words + ' / ' + VERBOSE_LIMIT + ' words',
      }));
    };
    stage.append(box, meter);
    place();
    sync();
    box.focus();
    box.select();

    const offInput = on(box, 'input', sync);
    const offKey = on(box, 'keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); endEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
    });
    const offBlur = on(box, 'blur', () => endEdit(true));
    editor = { node: n, box, cleanup: () => { offInput(); offKey(); offBlur(); box.remove(); meter.remove(); } };
  }

  function endEdit(commit) {
    if (!editor) return;
    const n = editor.node;
    const value = String(editor.box.value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    editor.cleanup();
    editor = null;
    if (commit && value && value !== n.label) {
      n.label = value;
      layoutNode(n);
      refreshNode(n);
      renderEdges();
      renderOverlay();
      renderInspector();
      renderBadges();
      touch(false);
    } else if (!value && (!n.label || n.label === 'new idea')) {
      removeNode(n);
    }
  }

  async function promptLink(n) {
    const value = await askText({
      title: 'Link this idea',
      hint: 'Point it at a lesson, topic or card. Examples: lesson:0003 · topic:mole-concept · card:ffc0a0edda68. Empty removes the link.',
      value: n.link || 'lesson:',
      placeholder: 'lesson:0003',
      okLabel: 'Link',
    });
    if (value === null) return;
    const v = String(value).trim();
    n.link = v || null;
    if (v && !resolveDeepLink(v, doc.topicId)) {
      toast('Saved, but nothing in the vault matches “' + v + '” yet.', { tone: 'warn' });
    }
    refreshNode(n);
    renderInspector();
    touch(false);
  }

  async function promptEdgeLabel(e) {
    const value = await askText({
      title: 'Label this link',
      hint: 'A verb works best: causes · needs · is measured by · limits.',
      value: e.label || '',
      placeholder: 'causes',
    });
    if (value === null) return;
    e.label = String(value).replace(/\s+/g, ' ').trim().slice(0, 60);
    renderEdges();
    renderInspector();
    touch(false);
  }

  async function promptGroupLabel(g) {
    const value = await askText({
      title: 'Name this group',
      hint: 'Your own grouping, not the chapter headings. ' + GROUP_LABEL_WORDS + ' words at most.',
      value: g.label,
      placeholder: 'counting particles',
      meter: (v) => {
        const w = wordCount(v);
        return {
          text: w > GROUP_LABEL_WORDS ? w + ' words — a group holds ' + GROUP_LABEL_WORDS + ' or fewer' : w + ' / ' + GROUP_LABEL_WORDS + ' words',
          tone: w > GROUP_LABEL_WORDS ? 'bad' : 'good',
        };
      },
    });
    if (value === null) return;
    const v = String(value).replace(/\s+/g, ' ').trim().slice(0, 60) || g.label;
    if (wordCount(v) > GROUP_LABEL_WORDS) {
      toast('That is ' + wordCount(v) + ' words. Groups hold ' + GROUP_LABEL_WORDS + ' or fewer — it forces you to name the idea, not describe it.', { tone: 'warn' });
    }
    g.label = v;
    renderGroups();
    renderInspector();
    touch(false);
  }

  /* ---- structural edits ------------------------------------------------ */

  function addNode(wx, wy, label) {
    const n = {
      id: uid('n'), label: label === undefined ? 'new idea' : label,
      x: Math.round(wx), y: Math.round(wy),
      group: null, emphasis: false, link: null, note: '', w: 0, h: 0,
    };
    layoutNode(n);
    n.x = Math.round(n.x - n.w / 2);
    n.y = Math.round(n.y - n.h / 2);
    n.group = groupAt(n.x + n.w / 2, n.y + n.h / 2);
    doc.nodes.push(n);
    sel = { kind: 'node', id: n.id };
    renderNodes();
    renderOverlay();
    renderInspector();
    renderBadges();
    renderHint();
    touch(true);
    emitSelect();
    beginEdit(n);
    return n;
  }

  /* The toolbar aims at one fixed world point, so without this every '+ Idea'
     lands exactly on the previous one: the canvas shows a single box while the
     doc holds N nodes at identical coords, and recall-mode Compare then paints
     them as one illegible overlap. Walk out along widening rings until the new
     box clears every existing one. Double-tap placement is untouched — a tap
     names its own point and must be honoured exactly. */
  function freeSpotNear(cx, cy) {
    const probe = layoutNode({ label: 'new idea', x: 0, y: 0, w: 0, h: 0 });
    const w = probe.w || NODE_MIN_W;
    const h = probe.h || 38;
    const GAP = 8;
    const hits = (px, py) => doc.nodes.some((n) => {
      const nw = n.w || NODE_MIN_W;
      const nh = n.h || 38;
      return Math.abs(px - (n.x + nw / 2)) < (w + nw) / 2 + GAP
          && Math.abs(py - (n.y + nh / 2)) < (h + nh) / 2 + GAP;
    });
    if (!hits(cx, cy)) return { x: cx, y: cy };
    for (let ring = 1; ring <= 24; ring += 1) {
      const d = ring * GRID;
      const ring8 = [
        [cx + d, cy], [cx, cy + d], [cx - d, cy], [cx, cy - d],
        [cx + d, cy + d], [cx - d, cy + d], [cx + d, cy - d], [cx - d, cy - d],
      ];
      for (const [px, py] of ring8) if (!hits(px, py)) return { x: px, y: py };
    }
    return { x: cx + 25 * GRID, y: cy + 25 * GRID };   // pathological: still never stacked
  }

  function addNodeAtCentre() {
    const r = rectOf();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const spot = freeSpotNear(c.x, c.y);
    return addNode(spot.x, spot.y);
  }

  function removeNode(n) {
    doc.nodes = doc.nodes.filter((x) => x.id !== n.id);
    doc.edges = doc.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    if (sel && sel.id === n.id) sel = null;
    renderNodes();
    renderEdges();
    renderOverlay();
    renderInspector();
    renderBadges();
    renderHint();
    touch(true);
    emitSelect();
  }

  function addGroup() {
    const r = rectOf();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const g = {
      id: uid('grp'),
      label: 'group ' + (doc.groups.length + 1),
      x: Math.round(c.x - 150), y: Math.round(c.y - 110),
      w: 300, h: 220,
      tone: toneForSubject(doc.subject),
    };
    doc.groups.push(g);
    sel = { kind: 'group', id: g.id };
    renderGroups();
    renderOverlay();
    renderInspector();
    touch(false);
    promptGroupLabel(g);
  }

  function groupAt(wx, wy) {
    for (let i = doc.groups.length - 1; i >= 0; i -= 1) {
      const g = doc.groups[i];
      if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + g.h) return g.id;
    }
    return null;
  }

  function addEdge(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return null;
    const exists = doc.edges.find((e) => e.from === fromId && e.to === toId);
    if (exists) {
      sel = { kind: 'edge', id: exists.id };
      renderEdges(); renderNodes(); renderOverlay(); renderInspector();
      return exists;
    }
    const e = { id: uid('e'), from: fromId, to: toId, label: '', weight: 1, emphasis: false };
    doc.edges.push(e);
    sel = { kind: 'edge', id: e.id };
    renderEdges();
    renderNodes();
    renderOverlay();
    renderInspector();
    renderBadges();
    renderHint();
    touch(true);
    return e;
  }

  /* ---- viewport -------------------------------------------------------- */

  function zoomAt(px, py, factor) {
    const next = clamp(view.scale * factor, SCALE_MIN, SCALE_MAX);
    const k = next / view.scale;
    view.tx = px - k * (px - view.tx);
    view.ty = py - k * (py - view.ty);
    view.scale = next;
    applyTransform();
  }

  function zoomBy(factor) {
    const r = rectOf();
    zoomAt(r.width / 2, r.height / 2, factor);
  }

  function contentBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x, y, w, h) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    };
    for (const n of doc.nodes) consider(n.x, n.y, n.w, n.h);
    for (const g of doc.groups) consider(g.x, g.y, g.w, g.h);
    if (doc.image) consider(doc.image.x, doc.image.y, doc.image.w, doc.image.h);
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  function fit() {
    const r = rectOf();
    const box = contentBox();
    const width = r.width || 320;
    const height = r.height || 320;
    if (!box) {
      view.tx = width / 2; view.ty = height / 2; view.scale = 1;
      applyTransform();
      return;
    }
    const padX = 44;
    const padTop = 44;
    const padBottom = 62;                 // the hint pill floats along the bottom
    const inner = Math.max(90, height - padTop - padBottom);
    view.scale = clamp(Math.min((width - padX * 2) / box.w, inner / box.h), SCALE_MIN, 1.6);
    view.tx = (width - box.w * view.scale) / 2 - box.x * view.scale;
    view.ty = padTop + (inner - box.h * view.scale) / 2 - box.y * view.scale;
    applyTransform();
  }

  /* ---- pointer interaction -------------------------------------------- */

  const pointers = new Map();
  let gesture = null;
  let pinch = null;
  let tapInfo = { ts: 0, x: 0, y: 0 };
  let moved = 0;

  function targetInfo(target) {
    if (!(target instanceof Element)) return {};
    const linkHandle = target.closest('[data-link-from]');
    if (linkHandle) return { kind: 'link', id: linkHandle.dataset.linkFrom };
    const resize = target.closest('[data-resize-group]');
    if (resize) return { kind: 'resize', id: resize.dataset.resizeGroup };
    const grab = target.closest('[data-grab-group]');
    if (grab) return { kind: 'group', id: grab.dataset.grabGroup };
    const node = target.closest('[data-node-id]');
    if (node) return { kind: 'node', id: node.dataset.nodeId };
    const edge = target.closest('[data-edge-id]');
    if (edge) return { kind: 'edge', id: edge.dataset.edgeId };
    const group = target.closest('[data-group-id]');
    if (group) return { kind: 'groupBody', id: group.dataset.groupId };
    return {};
  }

  function hitNodeAt(wx, wy) {
    for (let i = doc.nodes.length - 1; i >= 0; i -= 1) {
      const n = doc.nodes[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) return n;
    }
    return null;
  }

  offs.push(on(stage, 'pointerdown', (e) => {
    if (editor && !(e.target instanceof Element && e.target.closest('.mm__edit'))) endEdit(true);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }

    if (pointers.size === 2) {
      const two = Array.from(pointers.values());
      const r = rectOf();
      pinch = {
        dist: Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1,
        mid: { x: (two[0].x + two[1].x) / 2 - r.left, y: (two[0].y + two[1].y) / 2 - r.top },
        scale: view.scale, tx: view.tx, ty: view.ty,
      };
      gesture = null;
      stage.classList.remove('is-panning');
      return;
    }
    if (pointers.size > 2) return;

    moved = 0;
    const info = targetInfo(e.target);
    const w = toWorld(e.clientX, e.clientY);
    const editable = mode !== 'compare' && !o.readOnly;

    if (editable && info.kind === 'link') {
      gesture = { type: 'link', from: info.id };
      stage.classList.add('is-linking');
      return;
    }
    if (editable && info.kind === 'resize') {
      const g = groupById(info.id);
      if (g) gesture = { type: 'resize', id: g.id, ow: g.w, oh: g.h, sx: w.x, sy: w.y };
      return;
    }
    if (editable && info.kind === 'group') {
      const g = groupById(info.id);
      if (g) {
        gesture = {
          type: 'group', id: g.id, ox: g.x, oy: g.y, sx: w.x, sy: w.y,
          members: doc.nodes.filter((n) => n.group === g.id).map((n) => ({ n, x: n.x, y: n.y })),
        };
        select('group', g.id);
      }
      return;
    }
    if (info.kind === 'node') {
      const n = nodeById(info.id);
      if (n) {
        if (editable) gesture = { type: 'node', id: n.id, ox: n.x, oy: n.y, sx: w.x, sy: w.y };
        select('node', n.id);
      }
      return;
    }
    if (info.kind === 'edge' && editable) { select('edge', info.id); gesture = null; return; }

    gesture = { type: 'pan', tx: view.tx, ty: view.ty, sx: e.clientX, sy: e.clientY };
    stage.classList.add('is-panning');
    if (info.kind === 'groupBody' && editable) select('group', info.id);
    else if (sel) select(null, null);
  }));

  offs.push(on(stage, 'pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && pointers.size >= 2) {
      const two = Array.from(pointers.values());
      const r = rectOf();
      const dist = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1;
      const mid = { x: (two[0].x + two[1].x) / 2 - r.left, y: (two[0].y + two[1].y) / 2 - r.top };
      const next = clamp(pinch.scale * (dist / pinch.dist), SCALE_MIN, SCALE_MAX);
      const k = next / pinch.scale;
      view.scale = next;
      view.tx = mid.x - k * (pinch.mid.x - pinch.tx);
      view.ty = mid.y - k * (pinch.mid.y - pinch.ty);
      applyTransform();
      moved = 999;
      return;
    }
    if (!gesture) return;
    const w = toWorld(e.clientX, e.clientY);

    if (gesture.type === 'pan') {
      view.tx = gesture.tx + (e.clientX - gesture.sx);
      view.ty = gesture.ty + (e.clientY - gesture.sy);
      moved = Math.abs(e.clientX - gesture.sx) + Math.abs(e.clientY - gesture.sy);
      applyTransform();
      return;
    }
    if (gesture.type === 'node') {
      const n = nodeById(gesture.id);
      if (!n) return;
      n.x = Math.round(gesture.ox + (w.x - gesture.sx));
      n.y = Math.round(gesture.oy + (w.y - gesture.sy));
      moved += 5;
      const g = layerNodes.querySelector('[data-node-id="' + cssEscape(n.id) + '"]');
      if (g) g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
      const overId = groupAt(n.x + n.w / 2, n.y + n.h / 2);
      for (const box of layerGroups.querySelectorAll('.mm-group')) {
        box.classList.toggle('is-hot', box.dataset.groupId === overId);
      }
      renderEdges();
      renderOverlay();
      return;
    }
    if (gesture.type === 'group') {
      const g = groupById(gesture.id);
      if (!g) return;
      const dx = w.x - gesture.sx;
      const dy = w.y - gesture.sy;
      g.x = Math.round(gesture.ox + dx);
      g.y = Math.round(gesture.oy + dy);
      for (const m of gesture.members) { m.n.x = Math.round(m.x + dx); m.n.y = Math.round(m.y + dy); }
      moved += 5;
      renderGroups(); renderNodes(); renderEdges(); renderOverlay();
      return;
    }
    if (gesture.type === 'resize') {
      const g = groupById(gesture.id);
      if (!g) return;
      g.w = Math.round(clamp(gesture.ow + (w.x - gesture.sx), 140, 3000));
      g.h = Math.round(clamp(gesture.oh + (w.y - gesture.sy), 110, 3000));
      moved += 5;
      renderGroups(); renderOverlay();
      return;
    }
    if (gesture.type === 'link') {
      const from = nodeById(gesture.from);
      if (!from) return;
      moved += 5;
      const a = anchorOn(from, w.x, w.y);
      for (const p of layerOverlay.querySelectorAll('.mm-ghost-line')) p.remove();
      layerOverlay.appendChild(s('path', { class: 'mm-ghost-line', d: 'M' + a.x + ' ' + a.y + ' L' + w.x + ' ' + w.y }));
      const hover = hitNodeAt(w.x, w.y);
      for (const g2 of layerNodes.querySelectorAll('.mm-node')) {
        g2.classList.toggle('is-selected', !!hover && g2.dataset.nodeId === hover.id);
      }
    }
  }));

  function endPointer(e) {
    pointers.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* fine */ }
    if (pointers.size < 2) pinch = null;
    stage.classList.remove('is-panning', 'is-linking');

    const g = gesture;
    gesture = null;
    if (!g) { maybeDoubleTap(e); return; }

    if (g.type === 'link') {
      for (const p of layerOverlay.querySelectorAll('.mm-ghost-line')) p.remove();
      const w = toWorld(e.clientX, e.clientY);
      const target = hitNodeAt(w.x, w.y);
      if (target && target.id !== g.from) addEdge(g.from, target.id);
      else { renderNodes(); renderOverlay(); }
      return;
    }
    if (g.type === 'node') {
      const n = nodeById(g.id);
      if (!n) return;
      if (moved > 8) {
        n.group = groupAt(n.x + n.w / 2, n.y + n.h / 2);
        for (const box of layerGroups.querySelectorAll('.mm-group')) box.classList.remove('is-hot');
        refreshNode(n);
        touch(false);
      } else {
        maybeDoubleTap(e, n);
      }
      return;
    }
    if (g.type === 'group' || g.type === 'resize') { if (moved > 8) touch(false); return; }
    if (g.type === 'pan' && moved < 8) maybeDoubleTap(e);
  }

  function maybeDoubleTap(e, node) {
    if (o.readOnly || mode === 'compare') return;
    const now = nowTs();
    const isDouble = now - tapInfo.ts < 340 &&
      Math.abs(e.clientX - tapInfo.x) < 26 && Math.abs(e.clientY - tapInfo.y) < 26;
    tapInfo = { ts: now, x: e.clientX, y: e.clientY };
    if (!isDouble) return;
    tapInfo.ts = 0;
    if (node) { beginEdit(node); return; }
    const w = toWorld(e.clientX, e.clientY);
    addNode(w.x, w.y, '');
  }

  offs.push(on(stage, 'pointerup', endPointer));
  offs.push(on(stage, 'pointercancel', endPointer));

  offs.push(on(stage, 'wheel', (e) => {
    e.preventDefault();
    const r = rectOf();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false }));

  offs.push(on(stage, 'keydown', (e) => {
    if (o.readOnly || editor || mode === 'compare') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      if (sel.kind === 'node') { const n = nodeById(sel.id); if (n) removeNode(n); }
      else if (sel.kind === 'edge') {
        doc.edges = doc.edges.filter((x) => x.id !== sel.id);
        sel = null;
        renderEdges(); renderOverlay(); renderInspector(); renderBadges(); touch(true);
      }
    } else if (e.key === 'Enter' && sel && sel.kind === 'node') {
      e.preventDefault();
      const n = nodeById(sel.id);
      if (n) beginEdit(n);
    } else if (e.key === 'Escape' && sel) {
      select(null, null);
    } else if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addNodeAtCentre();
    }
  }));

  function select(kind, id) {
    sel = kind ? { kind, id } : null;
    renderNodes(); renderEdges(); renderGroups(); renderOverlay();
    renderInspector(); renderHint();
    emitSelect();
  }

  function emitSelect() {
    if (!o.onSelect) return;
    const n = sel && sel.kind === 'node' ? nodeById(sel.id) : null;
    try { o.onSelect(n); } catch (err) { console.error('[maps] onSelect failed', err); }
  }

  /* ---- recall mode (GRINDE R) ----------------------------------------- */

  function startRecall() {
    if (doc.nodes.length < 2) {
      toast('Build the map first — then come back and rebuild it from memory.', { tone: 'info' });
      return;
    }
    endEdit(true);
    saveMap(doc, view);
    baseline = normalizeMapDoc(stripRuntime(doc, view));
    doc = createMapDoc({ id: baseline.id + '__recall', topicId: baseline.topicId, subject: baseline.subject, title: baseline.title });
    mode = 'recall';
    sel = null;
    compareInfo = null;
    islandInfo = findIslands(doc);
    openPanel = null;
    panelHost.replaceChildren();
    const r = rectOf();
    view.tx = (r.width || 320) / 2;
    view.ty = (r.height || 320) / 2;
    view.scale = 1;
    render();
    toast('Notes closed. Rebuild the map from memory — every idea you can reach.', { tone: 'info', timeout: 6000 });
  }

  function compare() {
    if (!baseline) return;
    endEdit(true);
    const attempt = normalizeMapDoc(stripRuntime(doc, view));
    const info = diffMaps(baseline, attempt);
    compareInfo = info;
    mode = 'compare';

    const merged = normalizeMapDoc(stripRuntime(attempt, view));
    const baseKeys = new Set(baseline.nodes.map((n) => normLabel(n.label)));
    for (const n of merged.nodes) n._cmp = baseKeys.has(normLabel(n.label)) ? 'match' : 'new';
    for (const b of info.missing) {
      const ghost = {
        id: 'ghost-' + b.id, label: b.label, x: b.x, y: b.y,
        group: null, emphasis: false, link: null, note: '', w: 0, h: 0, _cmp: 'missing',
      };
      layoutNode(ghost);
      merged.nodes.push(ghost);
    }
    const idOf = new Map();
    for (const n of merged.nodes) if (!idOf.has(normLabel(n.label))) idOf.set(normLabel(n.label), n.id);
    for (const e of baseline.edges) {
      const a = baseline.nodes.find((n) => n.id === e.from);
      const b = baseline.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const from = idOf.get(normLabel(a.label));
      const to = idOf.get(normLabel(b.label));
      if (!from || !to || from === to) continue;
      if (!merged.edges.some((x) => x.from === from && x.to === to)) {
        merged.edges.push({ id: uid('ge'), from, to, label: e.label, weight: e.weight, emphasis: false });
      }
    }
    doc = merged;
    islandInfo = findIslands(doc);
    sel = null;
    render();
    fit();
    showCompareSummary(info);
    writeRecall(baseline.id, {
      recalled: info.recalled, total: info.total, added: info.added.length,
      edgesMatched: info.edgesMatched, edgesTotal: info.edgesTotal,
    });
    if (o.onActivity) {
      try {
        o.onActivity('review', {
          source: 'map-recall', mapId: baseline.id, topicId: baseline.topicId,
          recalled: info.recalled, total: info.total, added: info.added.length,
        });
      } catch (_) { /* the game layer is optional */ }
    }
  }

  function showCompareSummary(info) {
    const pct = info.total ? Math.round((info.recalled / info.total) * 100) : 0;
    panelHost.replaceChildren(el('div.mm__panel',
      el('div.section-head',
        el('h3.section__title', { text: 'Rebuilt from memory' }),
        el('span.pill', { class: pct >= 80 ? 'pill--good' : pct >= 50 ? 'pill--warn' : 'pill--bad' },
          el('span', { text: info.recalled + ' / ' + info.total + ' ideas' }))),
      el('div.mm__summary',
        el('span.pill.pill--good', el('span', { text: info.recalled + ' recalled' })),
        el('span.pill.pill--bad', el('span', { text: info.missing.length + ' missing' })),
        el('span.pill.pill--info', el('span', { text: info.added.length + ' new' })),
        el('span.pill.pill--neutral', el('span', { text: info.edgesMatched + ' / ' + info.edgesTotal + ' links' }))),
      info.missing.length
        ? el('p.card__sub', { text: 'Missing: ' + info.missing.slice(0, 8).map((n) => n.label).join(' · ') + (info.missing.length > 8 ? ' …' : '') })
        : el('p.card__sub', { text: 'Nothing missing. Every idea on the saved map came back.' }),
      info.added.length
        ? el('p.card__sub', { text: 'New this time (blue): ' + info.added.slice(0, 8).map((n) => n.label).join(' · ') })
        : null,
    ));
  }

  function keepRecall() {
    if (!baseline) return;
    const kept = doc.nodes.filter((n) => n._cmp !== 'missing');
    const keptIds = new Set(kept.map((n) => n.id));
    saveVersion(baseline, 'before rebuild ' + todayLocalISO());
    doc = normalizeMapDoc({
      id: baseline.id, topicId: baseline.topicId, subject: baseline.subject, title: baseline.title,
      nodes: kept.map((n) => ({
        id: n.id, label: n.label, x: n.x, y: n.y,
        group: null, emphasis: n.emphasis, link: n.link, note: n.note,
      })),
      edges: doc.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
      groups: [],
      image: baseline.image,
      version: baseline.version + 1,
    });
    baseline = null;
    compareInfo = null;
    mode = 'edit';
    sel = null;
    islandInfo = findIslands(doc);
    saveMap(doc, view);
    panelHost.replaceChildren();
    render();
    fit();
    toast('Rebuild kept. The map you had before is in version history.', { tone: 'good' });
  }

  function cancelRecall() {
    if (!baseline) { mode = 'edit'; compareInfo = null; render(); return; }
    doc = baseline;
    baseline = null;
    compareInfo = null;
    mode = 'edit';
    sel = null;
    for (const n of doc.nodes) { delete n._cmp; layoutNode(n); }
    islandInfo = findIslands(doc);
    panelHost.replaceChildren();
    render();
    fit();
  }

  /* ---- the "more" panel: photo, versions, export, import, share -------- */

  function togglePanel(name) {
    openPanel = openPanel === name ? null : name;
    renderPanel();
  }

  function renderPanel() {
    panelHost.replaceChildren();
    if (openPanel === 'more') panelHost.appendChild(morePanel());
    else if (openPanel === 'versions') panelHost.appendChild(versionsPanel());
  }

  function morePanel() {
    const p = el('div.mm__panel',
      el('div.section-head', el('h3.section__title', { text: 'Map tools' })),
      el('div.btn-row',
        el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => fileInput.click() },
          icon('image', { size: 14 }), el('span', { text: doc.image ? 'Replace photo' : 'Import photo' })),
        el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => { openPanel = 'versions'; renderPanel(); } },
          icon('clock', { size: 14 }), el('span', { text: 'Versions' })),
        el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => exportFile() },
          icon('download', { size: 14 }), el('span', { text: 'Export' })),
        el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => importInput.click() },
          icon('upload', { size: 14 }), el('span', { text: 'Import' })),
        el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => shareToGroup() },
          icon('send', { size: 14 }), el('span', { text: 'Share' })),
        el('button.btn.btn-secondary.btn--sm', { type: 'button', onClick: () => nameAndSaveVersion() },
          icon('pin', { size: 14 }), el('span', { text: 'Save version' })),
      ));
    if (doc.image) {
      p.append(
        el('div.row.row--between',
          el('span.eyebrow', { text: 'Photo layer' }),
          el('button.chip.chip--button', {
            type: 'button', dataset: { tone: 'bad' },
            onClick: () => { doc.image = null; renderImage(); renderPanel(); touch(false); },
          }, icon('trash', { size: 12 }), el('span', { text: 'Remove' }))),
        el('div.row',
          icon('image', { size: 14 }),
          el('input.mm__range', {
            type: 'range', min: '5', max: '100', step: '5',
            value: String(Math.round(doc.image.opacity * 100)),
            attrs: { 'aria-label': 'Photo opacity' },
            onInput: (e) => {
              doc.image.opacity = clamp(Number(e.target.value) / 100, 0.05, 1);
              const img = layerImage.querySelector('image');
              if (img) img.setAttribute('opacity', String(doc.image.opacity));
              touch(false);
            },
          })),
        el('div.btn-row',
          el('button.btn.btn-ghost.btn--sm', { type: 'button', text: 'Smaller', onClick: () => scalePhoto(1 / 1.2) }),
          el('button.btn.btn-ghost.btn--sm', { type: 'button', text: 'Bigger', onClick: () => scalePhoto(1.2) }),
          el('button.btn.btn-ghost.btn--sm', {
            type: 'button', text: 'Recentre',
            onClick: () => { doc.image.x = 0; doc.image.y = 0; renderImage(); fit(); touch(false); },
          })),
        el('p.hint', { text: 'The photo sits under your map, so you can trace a paper map you already drew — then fade it out.' }),
      );
    }
    return p;
  }

  async function nameAndSaveVersion() {
    const name = await askText({
      title: 'Name this version',
      hint: 'Named versions are kept forever. Unnamed snapshots keep the last ' + MAX_UNNAMED_VERSIONS + '.',
      value: '', placeholder: 'after chapter 3',
    });
    if (name === null) return;
    const v = saveVersion(doc, name.trim() || null, view);
    if (v) toast('Version saved.', { tone: 'good' });
  }

  function scalePhoto(k) {
    if (!doc.image) return;
    doc.image.w = clamp(doc.image.w * k, 60, 6000);
    doc.image.h = clamp(doc.image.h * k, 60, 6000);
    renderImage();
    touch(false);
  }

  function versionsPanel() {
    const rows = listVersions(doc.id);
    const p = el('div.mm__panel',
      el('div.row.row--between',
        el('span.eyebrow', { text: 'Version history' }),
        el('button.chip.chip--button', { type: 'button', onClick: () => { openPanel = 'more'; renderPanel(); } },
          icon('arrow-left', { size: 12 }), el('span', { text: 'Back' }))));
    if (!rows.length) {
      p.appendChild(el('p.hint', { text: '“Save version” snapshots the map, so the diff between two versions is the evidence your understanding changed.' }));
      return p;
    }
    const list = el('div.mm__vlist');
    for (const r of rows) {
      const count = (r.doc && r.doc.nodes ? r.doc.nodes.length : 0);
      list.appendChild(el('div.mm__vrow',
        icon(r.name ? 'pin' : 'clock', { size: 14 }),
        el('div.mm__vrow-main',
          el('div.mm__vrow-name', { text: r.name || fmt.dateShort(r.ts) + ' · ' + fmt.time(r.ts) }),
          el('div.mm__vrow-meta', { text: count + ' ' + fmt.plural(count, 'idea') + ' · ' + fmt.rel(r.ts) })),
        el('button.chip.chip--button', { type: 'button', onClick: () => restore(r) },
          icon('refresh', { size: 12 }), el('span', { text: 'Restore' })),
        el('button.btn.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Delete version' },
          onClick: () => { deleteVersion(doc.id, r.id); renderPanel(); },
        }, icon('trash', { size: 14 })),
      ));
    }
    p.appendChild(list);
    return p;
  }

  function restore(row) {
    saveVersion(doc, 'before restore ' + todayLocalISO(), view);
    const next = normalizeMapDoc(row.doc);
    next.id = doc.id;
    next.version = doc.version + 1;
    doc = next;
    islandInfo = findIslands(doc);
    sel = null;
    saveMap(doc, view);
    openPanel = null;
    render();
    fit();
    toast('Restored. Your current map was snapshotted first.', { tone: 'good' });
  }

  function exportFile() {
    const payload = serializeMapPayload(doc, view);
    const slug = String(doc.title || 'map').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
    store.downloadFile('engram-map-' + slug + '.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  offs.push(on(fileInput, 'change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const photo = await importPhoto(file);
      const r = rectOf();
      const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const w = 640;
      const h = Math.round((photo.h / photo.w) * w) || 480;
      doc.image = { src: photo.src, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), w, h, opacity: 0.45 };
      renderImage();
      renderPanel();
      touch(false);
      toast('Photo placed under the map. Trace it, then fade it out.', { tone: 'good' });
    } catch (err) {
      toast(String(err && err.message ? err.message : err), { tone: 'bad' });
    }
  }));

  offs.push(on(importInput, 'change', () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file.', { tone: 'bad' });
    reader.onload = () => {
      const parsed = parseMapPayload(String(reader.result));
      if (!parsed) { toast('That file is not an Engram map.', { tone: 'bad' }); return; }
      saveVersion(doc, 'before import ' + todayLocalISO(), view);
      parsed.id = doc.id;
      parsed.topicId = parsed.topicId || doc.topicId;
      doc = parsed;
      islandInfo = findIslands(doc);
      sel = null;
      saveMap(doc, view);
      openPanel = null;
      render();
      fit();
      toast('Map imported.', { tone: 'good' });
    };
    reader.readAsText(file);
  }));

  /**
   * Share the map. Goes through community.js `saveItem`, which is the ONE place
   * allowed to write shared_items.
   *
   * This used to insert straight into the table with no `group_id`. NULL
   * group_id is defined by schema.sql as "visible to every signed-in member",
   * so the toast said "Map shared to your group" while the map went to the
   * entire circle. saveItem() refuses to write a null group for exactly that
   * reason; the canvas was the one caller that walked around it.
   */
  async function shareToGroup() {
    let community = null;
    try { community = await import('./community.js'); } catch (_) { community = null; }
    if (!community || typeof community.saveItem !== 'function') {
      toast('Sharing needs the group server set up. Export the file instead.', { tone: 'warn' });
      return;
    }
    if (!(await community.sbReady())) {
      toast('Sharing needs the group server set up. Export the file instead.', { tone: 'warn' });
      return;
    }
    const group = community.currentGroup();
    if (!group) {
      // '' means private. Publishing to everybody because no group was chosen
      // is the failure this whole function was rewritten to stop.
      toast('Pick a group first — Me › Groups. Nothing was shared.', { tone: 'warn' });
      return;
    }
    try {
      const payload = serializeMapPayload(doc, view);
      const res = await community.saveItem({
        type: 'map', title: payload.title, body: payload.body, group_id: group,
      });
      if (!res || !res.ok) {
        toast('Could not share: ' + ((res && res.error) || 'unknown error'), { tone: 'bad' });
      } else if (res.local) {
        toast('Saved on this device — the group server did not take it.', { tone: 'warn' });
      } else {
        const label = (community.getGroups().find((g) => g.id === group) || {}).label || group;
        toast('Map shared to ' + label + '.', { tone: 'good' });
      }
    } catch (err) {
      console.error('[maps] share failed', err);
      toast('Could not share that map.', { tone: 'bad' });
    }
  }

  /* ---- resize ---------------------------------------------------------- */

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (!destroyed) applyTransform(); });
    ro.observe(stage);
  }

  /* ---- boot ------------------------------------------------------------ */

  render();
  if (doc.nodes.length) {
    if (view.tx || view.ty || view.scale !== 1) applyTransform();
    else fit();
  } else {
    const r = rectOf();
    view.tx = (r.width || 320) / 2;
    view.ty = (r.height || 320) / 2;
    applyTransform();
  }

  /* ---- controller ------------------------------------------------------ */

  return {
    root,
    get doc() { return doc; },
    get mode() { return mode; },
    getDoc: () => doc,
    setDoc(next) {
      endEdit(false);
      doc = normalizeMapDoc(next);
      baseline = null;
      compareInfo = null;
      mode = 'edit';
      sel = null;
      encodeLogged = false;
      islandInfo = findIslands(doc);
      openPanel = null;
      panelHost.replaceChildren();
      render();
      fit();
    },
    save() { return saveMap(doc, view); },
    fit,
    zoomBy,
    addNode: () => addNodeAtCentre(),
    startRecall,
    compare,
    islands: () => islandInfo,
    /** Focus an idea by id or by (normalised) label — search + cross-view sync. */
    focusNode(idOrLabel) {
      const key = normLabel(idOrLabel);
      const n = nodeById(idOrLabel) || doc.nodes.find((x) => normLabel(x.label) === key);
      if (!n) return false;
      select('node', n.id);
      const r = rectOf();
      view.tx = (r.width || 320) / 2 - (n.x + n.w / 2) * view.scale;
      view.ty = (r.height || 320) / 2 - (n.y + n.h / 2) * view.scale;
      applyTransform();
      if (!prefersReducedMotion()) {
        const g = layerNodes.querySelector('[data-node-id="' + cssEscape(n.id) + '"]');
        if (g) { g.classList.add('mm-pulse'); setTimeout(() => g.classList.remove('mm-pulse'), 2400); }
      }
      return true;
    },
    destroy() {
      destroyed = true;
      clearTimeout(saveTimer);
      endEdit(false);
      for (const off of offs) { try { off(); } catch (_) { /* fine */ } }
      if (ro) ro.disconnect();
      if (mode === 'edit') saveMap(doc, view);
      root.remove();
    },
  };
}

export default createMindmapCanvas;
