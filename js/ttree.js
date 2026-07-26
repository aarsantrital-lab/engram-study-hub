/* =============================================================================
   js/ttree.js — the T-Tree: an auto-generated COVERAGE skeleton per chapter.
   Owner: Job — Mindmaps.

   pedagogy-spec R6 draws the line this file lives on: a T-Tree is allowed to
   mirror the syllabus, because its job is coverage ("what exists in this
   chapter"), not encoding. The GRINDE canvas is the encoding artefact and is
   never generated. So this file GENERATES a tree — from the vault's own
   mindmap.md (topics[].mindmap) — and never pretends that reading it is study.

   What makes it study:
     · blank-tree recall mode — labels hidden, revealed one at a time as he
       says them out loud (free recall, not recognition)
     · card back-links per branch — "what is testable here"
     · per-node R/Y/G he sets himself, cross-checked later against measured
       accuracy (Mike & Matty §4.3 — the illusion-of-competence diagnostic)

   Layout is the salvaged tidy-tree from the v1 mindmap.js, with the audited
   fix from build-constraints §8: REAL text measurement, never char-count
   (Devanagari, subscripts and × all break the 0.545×length approximation).

   Store keys owned here (namespaced by store.js, never raw localStorage):
     'ttreeGrow'  '<topicId>::<path>' -> {selfRating:'R'|'Y'|'G', updatedISO}
     'ttreeUi'    topicId -> {collapsed: string[]}
   KEYS.GROW is READ (never written) as the topic-level fallback colour.
   ========================================================================== */

import { el, icon, on, toast, clamp, fmt, prefersReducedMotion } from './dom.js';
import { store, KEYS, todayLocalISO } from './store.js';
import { navigateTo, routeFor } from './router.js';
import { measureText } from './mindmap-canvas.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const FONT = 13;
const ROW_H = 30;
const GAP_Y = 8;
const GAP_X = 54;
const PAD_X = 13;
const MAX_W = 264;
const MIN_W = 52;
const SCALE_MIN = 0.3;
const SCALE_MAX = 2.6;

const GROW_KEY = 'ttreeGrow';
const UI_KEY = 'ttreeUi';

/** R/Y/G -> the component tone class + the human label. */
const RATINGS = {
  R: { tone: 'tone-bad', label: 'Red — cannot do this yet' },
  Y: { tone: 'tone-warn', label: 'Amber — shaky' },
  G: { tone: 'tone-good', label: 'Green — solid' },
};

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

/* ---------------------------------------------------------------------------
   1. Building the tree from vault data
   ------------------------------------------------------------------------ */

export function normLabel(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Copy the vault mindmap into a keyed tree. Path keys are positional
 * ('0', '0.2', '0.2.1') so they survive a re-sync as long as the mindmap.md
 * order is stable, and they are what the store keys R/Y/G by.
 * @param {Object} mindmap topics[].mindmap
 * @param {string} fallbackLabel
 * @returns {Object|null}
 */
export function buildTree(mindmap, fallbackLabel) {
  if (!mindmap || typeof mindmap !== 'object') {
    return fallbackLabel ? { label: String(fallbackLabel), path: '0', depth: 0, cardId: null, children: [] } : null;
  }
  let count = 0;
  const walk = (node, path, depth) => {
    count += 1;
    if (count > 600) return null;
    const out = {
      label: String((node && node.label) || '').trim() || '—',
      path,
      depth,
      cardId: (node && node.cardId) || null,
      children: [],
    };
    const kids = Array.isArray(node && node.children) ? node.children : [];
    kids.forEach((kid, i) => {
      const child = walk(kid, path + '.' + i, depth + 1);
      if (child) out.children.push(child);
    });
    return out;
  };
  return walk(mindmap, '0', 0);
}

/** Flatten to rows in document order. */
export function flattenTree(root) {
  const out = [];
  const walk = (n) => { out.push(n); for (const c of n.children) walk(c); };
  if (root) walk(root);
  return out;
}

/** Truncate a label to `maxWidth` using real measurement. */
export function fitLabel(text, maxWidth, size) {
  const value = String(text == null ? '' : text);
  if (measureText(value, { size }) <= maxWidth) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(value.slice(0, mid) + '…', { size }) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, Math.max(1, lo)).trim() + '…';
}

/**
 * Tidy horizontal tree: x by cumulative widest-per-depth, y by in-order leaf
 * packing, parents centred on their children.
 * @returns {{nodes:Array, links:Array, width:number, height:number}}
 */
export function layoutTree(root, collapsed, opts) {
  const o = opts || {};
  const blank = !!o.blank;
  const revealed = o.revealed || new Set();
  const nodes = [];
  const links = [];
  if (!root) return { nodes, links, width: 0, height: 0 };

  let cursorY = 0;

  const walk = (n) => {
    const showText = !blank || revealed.has(n.path);
    const hasKids = n.children.length > 0;
    const isCollapsed = hasKids && collapsed.has(n.path);
    const text = showText ? n.label : '';
    const textW = showText ? measureText(fitLabel(n.label, MAX_W - PAD_X * 2 - 30, FONT), { size: FONT, weight: n.depth === 0 ? 600 : 500 })
      : clamp(measureText(n.label, { size: FONT }) * 0.72, 34, MAX_W - PAD_X * 2 - 30);
    const extra = (n.cardId ? 12 : 0) + (hasKids ? 18 : 0);
    const box = {
      ref: n,
      path: n.path,
      depth: n.depth,
      label: showText ? fitLabel(n.label, MAX_W - PAD_X * 2 - extra, FONT) : '',
      blank: !showText,
      hasKids,
      collapsed: isCollapsed,
      kidCount: n.children.length,
      cardId: n.cardId,
      w: Math.round(clamp(textW + PAD_X * 2 + extra, MIN_W, MAX_W)),
      h: ROW_H,
      x: 0, y: 0,
    };
    if (!hasKids || isCollapsed) {
      box.y = cursorY + ROW_H / 2;
      cursorY += ROW_H + GAP_Y;
    } else {
      let first = null;
      let last = null;
      for (const kid of n.children) {
        const kb = walk(kid);
        if (first === null) first = kb.y;
        last = kb.y;
        links.push({ a: box, b: kb });
      }
      box.y = (first + last) / 2;
    }
    nodes.push(box);
    return box;
  };
  walk(root);

  const widest = new Map();
  for (const n of nodes) widest.set(n.depth, Math.max(widest.get(n.depth) || 0, n.w));
  const offsets = new Map();
  let acc = 0;
  for (const depth of Array.from(widest.keys()).sort((a, b) => a - b)) {
    offsets.set(depth, acc);
    acc += widest.get(depth) + GAP_X;
  }
  for (const n of nodes) n.x = offsets.get(n.depth) || 0;

  return { nodes, links, width: Math.max(acc - GAP_X, 1), height: Math.max(cursorY - GAP_Y, ROW_H) };
}

/* ---------------------------------------------------------------------------
   2. R/Y/G store (mine) + KEYS.GROW read-through
   ------------------------------------------------------------------------ */

function objectAt(key) {
  const raw = store.get(key, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

const growKey = (topicId, path) => String(topicId) + '::' + String(path);

/** Node R/Y/G, falling back to the topic-level GROW cell for the root. */
export function nodeRating(topicId, path, topicUnit) {
  const own = objectAt(GROW_KEY)[growKey(topicId, path)];
  if (own && RATINGS[own.selfRating]) return own.selfRating;
  if (path === '0') {
    const grow = objectAt(KEYS.GROW);
    const cell = grow[topicUnit] || grow[topicId];
    if (cell && RATINGS[cell.selfRating]) return cell.selfRating;
  }
  return null;
}

/** Set (or clear with null) a node's R/Y/G. Returns false when quota refused. */
export function setNodeRating(topicId, path, rating) {
  const all = objectAt(GROW_KEY);
  const key = growKey(topicId, path);
  if (rating && RATINGS[rating]) all[key] = { selfRating: rating, updatedISO: todayLocalISO() };
  else delete all[key];
  const ok = store.set(GROW_KEY, all);
  if (!ok) toast('Storage is full — that colour was not saved.', { tone: 'warn' });
  return ok;
}

/** Coverage tally for a topic: how many branches are red / amber / green. */
export function coverage(topicId, tree, topicUnit) {
  const rows = flattenTree(tree);
  const out = { total: rows.length, R: 0, Y: 0, G: 0, unrated: 0 };
  for (const n of rows) {
    const r = nodeRating(topicId, n.path, topicUnit);
    if (r) out[r] += 1;
    else out.unrated += 1;
  }
  return out;
}

function readUi(topicId) {
  const row = objectAt(UI_KEY)[String(topicId)];
  return { collapsed: new Set(Array.isArray(row && row.collapsed) ? row.collapsed : []) };
}

function writeUi(topicId, collapsed) {
  const all = objectAt(UI_KEY);
  all[String(topicId)] = { collapsed: Array.from(collapsed) };
  store.set(UI_KEY, all);
}

/* ---------------------------------------------------------------------------
   3. Styles
   ------------------------------------------------------------------------ */

const STYLE_ID = 'engram-ttree-css';

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.tt { display: flex; flex-direction: column; gap: var(--sp-3); }
.tt__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.tt__spacer { flex: 1 1 auto; min-width: 0; }
.tt__stage {
  position: relative; width: 100%;
  height: clamp(320px, 54vh, 620px);
  border: 1px solid var(--border); border-radius: var(--r-xl);
  background: var(--surface); box-shadow: var(--sh-card), var(--lip);
  overflow: hidden; touch-action: none;
  -webkit-user-select: none; user-select: none;
  cursor: grab;
}
@media (min-width: 900px) { .tt__stage { height: clamp(400px, 62vh, 760px); } }
.tt__stage.is-panning { cursor: grabbing; }
.tt__stage:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--sh-card); }
.tt__svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

.tt-link { fill: none; stroke: var(--border-strong); stroke-width: 1.5; }
.tt-link.is-hot { stroke: var(--accent); }

.tt-node { cursor: pointer; }
.tt-node__box { fill: var(--surface-muted); stroke: var(--border); stroke-width: 1; }
.tt-node__text { fill: var(--fg); font-size: 13px; font-weight: 500; font-family: var(--font-sans); dominant-baseline: middle; }
.tt-node--root .tt-node__box { fill: rgb(var(--accent-rgb) / 0.12); stroke: var(--accent); }
.tt-node--root .tt-node__text { font-weight: 600; }
.tt-node.is-selected .tt-node__box { stroke: var(--brand); stroke-width: 2.2; }
.tt-node.is-rated .tt-node__box { stroke: var(--accent); }
.tt-node__blank { fill: none; stroke: var(--fg-subtle); stroke-width: 2; stroke-dasharray: 5 5; stroke-linecap: round; }
.tt-node.is-blank .tt-node__box { fill: var(--surface-sunken, var(--surface-muted)); stroke-dasharray: 4 4; }
.tt-node__count { fill: var(--fg-subtle); font-size: 10px; font-family: var(--font-mono); dominant-baseline: middle; }
.tt-node__chev { fill: none; stroke: var(--fg-muted); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.tt-node__card { fill: var(--info); }
.tt-node__rag { stroke: none; }
.tt-node__rag--R { fill: var(--bad); }
.tt-node__rag--Y { fill: var(--warn); }
.tt-node__rag--G { fill: var(--good); }

.tt__hint {
  position: absolute; left: 50%; bottom: var(--sp-3); transform: translateX(-50%);
  z-index: 2; pointer-events: none;
  padding: 6px 12px; border-radius: var(--r-full);
  background: rgb(var(--surface-rgb) / 0.9); border: 1px solid var(--border);
  box-shadow: var(--lip);
  font-size: var(--fs-meta); color: var(--fg-muted); text-align: center;
  max-width: calc(100% - var(--sp-6));
}
.tt__progress {
  position: absolute; top: var(--sp-3); left: var(--sp-3); right: var(--sp-3);
  z-index: 2; pointer-events: none; display: flex; align-items: center; gap: var(--sp-2);
}
.tt__progress .meter { flex: 1 1 auto; }
.tt__inspect {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
  padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface-muted); box-shadow: var(--lip);
}
.tt__inspect-label {
  font-size: var(--fs-caption); color: var(--fg); font-weight: var(--fw-medium);
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* an author display rule beats the UA sheet's [hidden]{display:none} — say it
   here, or the empty inspector/progress bars stay on screen. */
.tt__inspect[hidden], .tt__progress[hidden], .tt__hint[hidden] { display: none; }
.tt-pulse { animation: tt-pulse 1.1s var(--ease) 2; }
@keyframes tt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .tt-pulse { animation: none; } }
`;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
   4. The view
   ------------------------------------------------------------------------ */

/**
 * Mount the T-Tree for one topic.
 *
 * @param {HTMLElement} host
 * @param {{
 *   topic: Object,                                  // vault topic (normalised)
 *   onSelect?: (node:{label,path,cardId}|null) => void,
 *   onActivity?: (kind:'review'|'encode'|'drill', meta:Object) => void,
 * }} opts
 * @returns {Object} controller
 */
export function createTTree(host, opts) {
  ensureStyles();
  const o = opts || {};
  const topic = o.topic || {};
  const topicId = topic.id || '';
  const offs = [];
  let destroyed = false;

  const tree = buildTree(topic.mindmap, topic.name);
  const ui = readUi(topicId);
  let collapsed = ui.collapsed;
  let blank = false;
  const revealed = new Set();
  let selPath = null;
  let lay = { nodes: [], links: [], width: 1, height: 1 };
  let recallLogged = false;

  const view = { tx: 0, ty: 0, scale: 1 };

  /* ---- DOM ---- */
  const root = el('div.tt', { dataset: { subject: String(topic.subject || '').toLowerCase() } });
  const bar = el('div.tt__bar');
  const stage = el('div.tt__stage', { attrs: { role: 'application', 'aria-label': 'Coverage tree', tabindex: '0' } });
  const inspect = el('div.tt__inspect', { hidden: true });
  const svg = s('svg', { class: 'tt__svg' });
  const world = s('g');
  const layerLinks = s('g');
  const layerNodes = s('g');
  world.append(layerLinks, layerNodes);
  svg.appendChild(world);
  const progress = el('div.tt__progress', { hidden: true });
  const hint = el('div.tt__hint');
  stage.append(svg, progress, hint);
  root.append(bar, stage, inspect);
  host.appendChild(root);

  const rectOf = () => stage.getBoundingClientRect();

  function applyTransform() {
    world.setAttribute('transform', 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')');
  }

  /* ---- render ---- */

  function chevronPath(x, y, open) {
    return open
      ? 'M' + (x - 4) + ' ' + (y - 2) + ' L' + x + ' ' + (y + 3) + ' L' + (x + 4) + ' ' + (y - 2)
      : 'M' + (x - 2) + ' ' + (y - 4) + ' L' + (x + 3) + ' ' + y + ' L' + (x - 2) + ' ' + (y + 4);
  }

  function render() {
    lay = layoutTree(tree, collapsed, { blank, revealed });
    layerLinks.replaceChildren();
    layerNodes.replaceChildren();

    for (const link of lay.links) {
      const x1 = link.a.x + link.a.w;
      const y1 = link.a.y;
      const x2 = link.b.x;
      const y2 = link.b.y;
      const mx = (x1 + x2) / 2;
      layerLinks.appendChild(s('path', {
        class: 'tt-link',
        dataset: { to: link.b.path },
        d: 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2,
      }));
    }

    for (const n of lay.nodes) {
      const rating = nodeRating(topicId, n.path, topic.unit);
      let cls = 'tt-node' + (n.depth === 0 ? ' tt-node--root' : '');
      if (rating) cls += ' is-rated ' + RATINGS[rating].tone;
      if (selPath === n.path) cls += ' is-selected';
      if (n.blank) cls += ' is-blank';
      const g = s('g', { class: cls, dataset: { path: n.path }, transform: 'translate(' + n.x + ',' + (n.y - n.h / 2) + ')' });
      g.appendChild(s('rect', { class: 'tt-node__box', x: 0, y: 0, width: n.w, height: n.h, rx: 8, ry: 8 }));

      let textX = PAD_X;
      if (n.hasKids) {
        g.appendChild(s('path', { class: 'tt-node__chev', d: chevronPath(9, n.h / 2, !n.collapsed) }));
        textX = PAD_X + 8;
      }
      if (n.blank) {
        g.appendChild(s('line', {
          class: 'tt-node__blank', x1: textX, y1: n.h / 2, x2: Math.max(textX + 12, n.w - PAD_X - (n.cardId ? 12 : 0)), y2: n.h / 2,
        }));
      } else {
        g.appendChild(s('text', { class: 'tt-node__text', x: textX, y: n.h / 2, text: n.label }));
      }
      if (n.collapsed && n.kidCount) {
        g.appendChild(s('text', { class: 'tt-node__count', x: n.w + 7, y: n.h / 2, text: '+' + n.kidCount }));
      }
      if (n.cardId) g.appendChild(s('circle', { class: 'tt-node__card', cx: n.w - 9, cy: 9, r: 3 }));
      if (rating) g.appendChild(s('circle', { class: 'tt-node__rag tt-node__rag--' + rating, cx: n.w - 9, cy: n.h - 9, r: 3.4 }));
      layerNodes.appendChild(g);
    }

    applyTransform();
    renderBar();
    renderInspector();
    renderProgress();
    renderHint();
  }

  function chip(label, iconName, onClick, extra) {
    const b = el('button.chip.chip--button', { type: 'button', onClick });
    if (iconName) b.appendChild(icon(iconName, { size: 14 }));
    b.appendChild(el('span', { text: label }));
    b.setAttribute('aria-pressed', extra && extra.active ? 'true' : 'false');
    if (extra && extra.active) b.classList.add('is-active');
    if (extra && extra.tone) b.dataset.tone = extra.tone;
    return b;
  }

  function iconBtn(name, label, onClick) {
    return el('button.btn.btn-icon', { type: 'button', attrs: { 'aria-label': label, title: label }, onClick },
      icon(name, { size: 16 }));
  }

  function renderBar() {
    bar.replaceChildren();
    const cov = coverage(topicId, tree, topic.unit);
    bar.append(
      chip(blank ? 'Blank tree on' : 'Blank-tree recall', 'eye-off', () => toggleBlank(), { active: blank }),
      chip('Expand all', 'chevron-down', () => { collapsed = new Set(); writeUi(topicId, collapsed); render(); fit(); }),
      chip('Collapse', 'chevron-right', () => collapseToDepth(1)),
      el('div.tt__spacer'),
      el('span.pill.pill--neutral', el('span', {
        text: cov.G + ' green · ' + cov.Y + ' amber · ' + cov.R + ' red of ' + cov.total,
      })),
      iconBtn('minus', 'Zoom out', () => zoomBy(1 / 1.25)),
      iconBtn('plus', 'Zoom in', () => zoomBy(1.25)),
      iconBtn('target', 'Fit to screen', fit),
    );
  }

  function renderProgress() {
    progress.replaceChildren();
    if (!blank) { progress.hidden = true; return; }
    progress.hidden = false;
    const total = flattenTree(tree).length;
    const pct = total ? Math.round((revealed.size / total) * 100) : 0;
    progress.append(
      el('span.pill.pill--ai', icon('brain', { size: 12 }), el('span', { text: revealed.size + ' / ' + total })),
      el('div.meter', { style: { '--pct': String(pct) } }, el('span.meter__fill')),
    );
  }

  function renderHint() {
    hint.replaceChildren();
    let text = '';
    if (!tree) text = '';
    else if (blank) {
      text = revealed.size === 0
        ? 'Say each branch out loud, then tap it to check. Nothing is revealed until you commit.'
        : 'Keep going — tap a branch only after you have said it.';
    } else if (!selPath) {
      text = 'Tap a branch to colour it or open its cards · tap the arrow to fold';
    }
    hint.hidden = !text;
    if (text) hint.appendChild(el('span', { text }));
  }

  function nodeAt(path) { return lay.nodes.find((n) => n.path === path) || null; }
  function treeNodeAt(path) { return flattenTree(tree).find((n) => n.path === path) || null; }

  /** Flashcards whose text mentions this branch — "what is testable here". */
  function cardsFor(node) {
    if (!node) return [];
    const out = [];
    if (node.cardId) {
      const direct = (topic.flashcards || []).find((c) => c.id === node.cardId);
      if (direct) out.push(direct);
    }
    const key = normLabel(node.label);
    if (key.length >= 4) {
      for (const c of topic.flashcards || []) {
        if (out.length >= 4) break;
        if (out.some((x) => x.id === c.id)) continue;
        if (normLabel(c.q + ' ' + c.a).indexOf(key) >= 0) out.push(c);
      }
    }
    return out;
  }

  function renderInspector() {
    inspect.replaceChildren();
    const node = selPath ? treeNodeAt(selPath) : null;
    if (!node) { inspect.hidden = true; return; }
    inspect.hidden = false;
    const rating = nodeRating(topicId, node.path, topic.unit);
    const cards = cardsFor(node);

    inspect.append(
      el('span.tt__inspect-label', { text: node.label }),
      el('span.eyebrow', { text: 'How solid?' }),
    );
    for (const key of ['R', 'Y', 'G']) {
      inspect.appendChild(chip(key === 'R' ? 'Red' : key === 'Y' ? 'Amber' : 'Green', null, () => {
        setNodeRating(topicId, node.path, rating === key ? null : key);
        render();
      }, { active: rating === key, tone: key === 'R' ? 'bad' : key === 'Y' ? 'warn' : 'good' }));
    }
    if (cards.length) {
      inspect.appendChild(el('span.pill.pill--info', icon('layers', { size: 12 }),
        el('span', { text: cards.length + ' ' + fmt.plural(cards.length, 'card') })));
      inspect.appendChild(chip('Open card', 'arrow-right', () => {
        navigateTo('#/study?card=' + encodeURIComponent(cards[0].id));
      }));
    }
    // cross-view sync: the same branch, in the other two views. Labels are the
    // shared key (outline.focus() and canvas.focusNode() both accept a label).
    inspect.append(
      chip('Outline', 'list', () => navigateTo(routeFor('maps', { topic: topicId, mode: 'outline', node: node.label }))),
      chip('On my map', 'waypoints', () => navigateTo(routeFor('maps', { topic: topicId, mode: 'my', node: node.label }))),
      el('div.tt__spacer'),
      chip('Topic', 'layers', () => navigateTo(routeFor('topic', { id: topicId }))),
    );
  }

  /* ---- behaviour ---- */

  function toggleBlank() {
    blank = !blank;
    if (blank) {
      revealed.clear();
      recallLogged = false;
      selPath = null;
      collapsed = new Set();
      toast('Notes closed. Say each branch before you tap it.', { tone: 'info', timeout: 5000 });
    } else if (revealed.size && !recallLogged) {
      logRecall();
    }
    render();
    fit();
  }

  function logRecall() {
    recallLogged = true;
    const total = flattenTree(tree).length;
    if (!o.onActivity) return;
    try {
      o.onActivity('review', {
        source: 'ttree-blank', topicId, revealed: revealed.size, total,
      });
    } catch (_) { /* the game layer is optional */ }
  }

  function collapseToDepth(depth) {
    collapsed = new Set();
    for (const n of flattenTree(tree)) {
      if (n.depth >= depth && n.children.length) collapsed.add(n.path);
    }
    writeUi(topicId, collapsed);
    render();
    fit();
  }

  function toggleCollapse(path) {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    writeUi(topicId, collapsed);
    const keep = { tx: view.tx, ty: view.ty, scale: view.scale };
    render();
    view.tx = keep.tx; view.ty = keep.ty; view.scale = keep.scale;
    applyTransform();
  }

  function select(path) {
    selPath = path;
    render();
    if (!o.onSelect) return;
    const node = path ? treeNodeAt(path) : null;
    try { o.onSelect(node ? { label: node.label, path: node.path, cardId: node.cardId } : null); } catch (err) {
      console.error('[ttree] onSelect failed', err);
    }
  }

  /* ---- pan / zoom / tap ---- */

  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let moved = 0;

  offs.push(on(stage, 'pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
    if (pointers.size === 2) {
      const two = Array.from(pointers.values());
      const r = rectOf();
      pinch = {
        dist: Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1,
        mid: { x: (two[0].x + two[1].x) / 2 - r.left, y: (two[0].y + two[1].y) / 2 - r.top },
        scale: view.scale, tx: view.tx, ty: view.ty,
      };
      pan = null;
      stage.classList.remove('is-panning');
      return;
    }
    if (pointers.size > 2) return;
    moved = 0;
    pan = { tx: view.tx, ty: view.ty, sx: e.clientX, sy: e.clientY };
    stage.classList.add('is-panning');
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
    if (!pan) return;
    view.tx = pan.tx + (e.clientX - pan.sx);
    view.ty = pan.ty + (e.clientY - pan.sy);
    moved = Math.abs(e.clientX - pan.sx) + Math.abs(e.clientY - pan.sy);
    applyTransform();
  }));

  function endPointer(e) {
    pointers.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* fine */ }
    if (pointers.size < 2) pinch = null;
    stage.classList.remove('is-panning');
    const wasPan = pan;
    pan = null;
    if (!wasPan || moved > 8) return;
    handleTap(e);
  }

  function handleTap(e) {
    const target = e.target instanceof Element ? e.target.closest('[data-path]') : null;
    if (!target) { if (selPath) select(null); return; }
    const path = target.dataset.path;
    const box = nodeAt(path);
    if (!box) return;

    // the fold arrow is the left 26 px of the box
    const r = rectOf();
    const localX = ((e.clientX - r.left) - view.tx) / view.scale - box.x;
    if (box.hasKids && localX < 26) { toggleCollapse(path); return; }

    if (blank) {
      if (!revealed.has(path)) {
        revealed.add(path);
        const total = flattenTree(tree).length;
        render();
        if (revealed.size >= total && !recallLogged) {
          logRecall();
          toast('Whole tree recovered — ' + total + ' of ' + total + ' branches.', { tone: 'good' });
        }
        return;
      }
    }
    select(path === selPath ? null : path);
  }

  offs.push(on(stage, 'pointerup', endPointer));
  offs.push(on(stage, 'pointercancel', endPointer));

  offs.push(on(stage, 'wheel', (e) => {
    e.preventDefault();
    const r = rectOf();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const next = clamp(view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), SCALE_MIN, SCALE_MAX);
    const k = next / view.scale;
    view.tx = px - k * (px - view.tx);
    view.ty = py - k * (py - view.ty);
    view.scale = next;
    applyTransform();
  }, { passive: false }));

  offs.push(on(layerNodes, 'mouseover', (e) => {
    const g = e.target instanceof Element ? e.target.closest('[data-path]') : null;
    if (!g) return;
    for (const p of layerLinks.querySelectorAll('.tt-link')) {
      p.classList.toggle('is-hot', p.dataset.to === g.dataset.path);
    }
  }));
  offs.push(on(layerNodes, 'mouseout', () => {
    for (const p of layerLinks.querySelectorAll('.tt-link.is-hot')) p.classList.remove('is-hot');
  }));

  function zoomBy(factor) {
    const r = rectOf();
    const px = (r.width || 320) / 2;
    const py = (r.height || 320) / 2;
    const next = clamp(view.scale * factor, SCALE_MIN, SCALE_MAX);
    const k = next / view.scale;
    view.tx = px - k * (px - view.tx);
    view.ty = py - k * (py - view.ty);
    view.scale = next;
    applyTransform();
  }

  function fit() {
    const r = rectOf();
    const width = r.width || 320;
    const height = r.height || 320;
    let box = null;
    try {
      const bb = world.getBBox();
      if (bb && bb.width && bb.height) box = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    } catch (_) { box = null; }
    if (!box) box = { x: 0, y: -ROW_H / 2, w: lay.width, h: lay.height + ROW_H };
    const padX = 28;
    const padTop = 28;
    const padBottom = 52;                 // the hint pill floats along the bottom
    const inner = Math.max(80, height - padTop - padBottom);
    view.scale = clamp(Math.min((width - padX * 2) / box.w, inner / box.h), SCALE_MIN, 1.5);
    view.tx = (width - box.w * view.scale) / 2 - box.x * view.scale;
    view.ty = padTop + (inner - box.h * view.scale) / 2 - box.y * view.scale;
    applyTransform();
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (!destroyed) applyTransform(); });
    ro.observe(stage);
  }

  render();
  fit();

  return {
    root,
    get tree() { return tree; },
    fit,
    zoomBy,
    render,
    coverage: () => coverage(topicId, tree, topic.unit),
    setBlank(next) { if (!!next !== blank) toggleBlank(); },
    /** Select + centre a branch by path or by label — cross-view sync. */
    focus(pathOrLabel) {
      const key = normLabel(pathOrLabel);
      const rows = flattenTree(tree);
      const node = rows.find((n) => n.path === pathOrLabel) || rows.find((n) => normLabel(n.label) === key);
      if (!node) return false;
      // un-fold every ancestor so the branch is actually on screen
      let changed = false;
      for (const anc of rows) {
        if (node.path.indexOf(anc.path + '.') === 0 && collapsed.has(anc.path)) { collapsed.delete(anc.path); changed = true; }
      }
      if (changed) writeUi(topicId, collapsed);
      // select(), not a bare assignment: a deep link / cross-view jump must
      // report the selection so the view above can carry it to the next mode.
      select(node.path);
      const box = nodeAt(node.path);
      if (box) {
        const r = rectOf();
        view.tx = (r.width || 320) / 2 - (box.x + box.w / 2) * view.scale;
        view.ty = (r.height || 320) / 2 - box.y * view.scale;
        applyTransform();
        if (!prefersReducedMotion()) {
          const g = layerNodes.querySelector('[data-path="' + String(node.path).replace(/"/g, '') + '"]');
          if (g) { g.classList.add('tt-pulse'); setTimeout(() => g.classList.remove('tt-pulse'), 2400); }
        }
      }
      return true;
    },
    destroy() {
      destroyed = true;
      if (blank && revealed.size && !recallLogged) logRecall();
      for (const off of offs) { try { off(); } catch (_) { /* fine */ } }
      if (ro) ro.disconnect();
      root.remove();
    },
  };
}

export default createTTree;
