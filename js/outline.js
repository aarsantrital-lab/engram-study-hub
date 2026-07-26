/* =============================================================================
   js/outline.js — the same chapter as a clean indented outline.
   Owner: Job — Mindmaps.

   Source of truth is the Obsidian-canon `mindmap.md` (build-constraints §1:
   indented "- " bullets, 2 spaces = one level). generate_data.py already parses
   it into topics[].mindmap, so that is what we render when it is present; the
   raw note is parsed only as a fallback. Either way the positional path keys
   ('0', '0.2', '0.2.1') are IDENTICAL to ttree.js's, which is what makes
   selection and the R/Y/G colours shared across the three views.

   This is a reading + navigation surface, not a study surface — the study
   surfaces are the GRINDE canvas (encode) and the blank tree (retrieve). The
   one retrieval affordance here is "Conceal detail", which hides everything
   below the level you choose so the outline works as a prompt list.
   ========================================================================== */

import { el, icon, on, toast, fmt } from './dom.js';
import { store } from './store.js';
import { navigateTo, routeFor } from './router.js';
import { buildTree, flattenTree, nodeRating, setNodeRating, normLabel } from './ttree.js';

const RATING_LABEL = { R: 'Red', Y: 'Amber', G: 'Green' };
const RATING_TONE = { R: 'bad', Y: 'warn', G: 'good' };

/* ---------------------------------------------------------------------------
   1. Markdown outline parsing (the fallback path)
   ------------------------------------------------------------------------ */

/**
 * Parse an Obsidian mindmap.md bullet tree.
 * 2-space indent = one level (build-constraints §1); tabs count as 2 spaces.
 * @param {string} text
 * @param {string} [fallbackLabel] used when the file has several top-level items
 * @returns {Object|null} {label, path, depth, cardId, children}
 */
export function parseOutlineMarkdown(text, fallbackLabel) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const tops = [];
  const stack = [];          // [{level, node}]
  let count = 0;

  for (const raw of lines) {
    const m = /^([ \t]*)[-*+]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const label = m[2].replace(/\s+/g, ' ').trim();
    if (!label) continue;
    count += 1;
    if (count > 600) break;
    const indent = m[1].replace(/\t/g, '  ').length;
    const level = Math.floor(indent / 2);
    const node = { label, path: '', depth: 0, cardId: null, children: [] };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (!stack.length) tops.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ level, node });
  }

  if (!tops.length) return null;
  const root = tops.length === 1
    ? tops[0]
    : { label: String(fallbackLabel || 'Outline'), cardId: null, children: tops };

  const key = (n, path, depth) => {
    n.path = path;
    n.depth = depth;
    n.children.forEach((c, i) => key(c, path + '.' + i, depth + 1));
    return n;
  };
  return key(root, '0', 0);
}

/** The topic note that holds mindmap.md, if the generator shipped one. */
export function findMindmapNote(topic) {
  const notes = (topic && topic.notes) || [];
  return notes.find((n) => /mindmap\.md$/i.test(n.path || '')) ||
    notes.find((n) => /^map\.md$/i.test(String(n.path || '').split('/').pop() || '')) ||
    notes.find((n) => /^mindmap$/i.test(n.title || '')) ||
    null;
}

/**
 * The tree an outline renders: topics[].mindmap when present (identical path
 * keys to ttree.js), otherwise the raw mindmap.md parsed here.
 */
export function outlineTree(topic) {
  if (topic && topic.mindmap) return buildTree(topic.mindmap, topic.name);
  const note = findMindmapNote(topic);
  if (note) return parseOutlineMarkdown(note.body, topic && topic.name);
  return null;
}

/** The outline back as markdown — used by "Copy outline". */
export function treeToMarkdown(tree) {
  const out = [];
  const walk = (n, depth) => {
    out.push('  '.repeat(depth) + '- ' + n.label);
    for (const c of n.children) walk(c, depth + 1);
  };
  if (tree) walk(tree, 0);
  return out.join('\n');
}

/* ---------------------------------------------------------------------------
   2. Styles
   ------------------------------------------------------------------------ */

const STYLE_ID = 'engram-outline-css';

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.ol { display: flex; flex-direction: column; gap: var(--sp-3); }
.ol__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.ol__spacer { flex: 1 1 auto; min-width: 0; }
.ol__body {
  border: 1px solid var(--border); border-radius: var(--r-xl);
  background: var(--surface); box-shadow: var(--sh-card), var(--lip);
  padding: var(--sp-2) 0;
  max-height: clamp(320px, 60vh, 720px);
  overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}
.ol__row {
  position: relative;
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: var(--tap);
  padding: 0 var(--sp-3) 0 calc(var(--sp-3) + var(--depth, 0) * 18px);
  border-left: 2px solid transparent;
}
.ol__row:hover { background: var(--surface-hover); }
.ol__row.is-selected { background: rgb(var(--accent-rgb) / 0.1); border-left-color: var(--accent); }
.ol__row[data-depth="0"] { border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.ol__guide {
  position: absolute; top: 0; bottom: 0; width: 1px;
  background: var(--border-strong); pointer-events: none;
}
.ol__twist {
  position: relative;            /* REQUIRED: anchors the ::after hit area to the
                                    twist itself, not to the whole row */
  flex: 0 0 auto;
  width: 28px; height: var(--tap); min-width: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r-sm); color: var(--fg-muted);
  background: transparent; border: 0;
}
.ol__twist::after { content: ""; position: absolute; inset: -8px; }
.ol__twist:hover { color: var(--fg); background: var(--surface-muted); }
.ol__twist[data-leaf="1"] { visibility: hidden; }
.ol__label {
  flex: 1 1 auto; min-width: 0; min-height: var(--tap);
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 4px 0; border: 0; background: transparent;
  color: var(--fg); font-size: var(--fs-body); font-weight: var(--fw-body);
  font-family: var(--font-sans); text-align: left; line-height: var(--lh-snug);
}
.ol__row[data-depth="0"] .ol__label { font-size: var(--fs-body-lg); font-weight: var(--fw-semibold); }
.ol__row[data-depth="1"] .ol__label { font-weight: var(--fw-medium); }
.ol__text { min-width: 0; overflow-wrap: anywhere; }
.ol__row.is-hidden .ol__text {
  display: inline-block; min-width: 90px; height: 12px;
  border-radius: var(--r-full); background: var(--surface-hover);
  border: 1px dashed var(--border-strong);
}
.ol__dots { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }
.ol__dot { width: 7px; height: 7px; border-radius: var(--r-full); display: inline-block; }
.ol__dot--card { background: var(--info); }
.ol__dot--R { background: var(--bad); }
.ol__dot--Y { background: var(--warn); }
.ol__dot--G { background: var(--good); }
.ol__count {
  font-family: var(--font-mono); font-size: var(--fs-micro);
  color: var(--fg-subtle); font-variant-numeric: tabular-nums;
}
.ol__inspect {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
  padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-lg);
  background: var(--surface-muted); box-shadow: var(--lip);
}
.ol__inspect-label {
  font-size: var(--fs-caption); color: var(--fg); font-weight: var(--fw-medium);
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* an author display rule beats the UA sheet's [hidden]{display:none}. */
.ol__inspect[hidden] { display: none; }
`;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
   3. The view
   ------------------------------------------------------------------------ */

/**
 * Mount the indented outline for a topic.
 *
 * @param {HTMLElement} host
 * @param {{
 *   topic: Object,
 *   onSelect?: (node:{label,path,cardId}|null) => void,
 * }} opts
 * @returns {Object} controller
 */
export function createOutline(host, opts) {
  ensureStyles();
  const o = opts || {};
  const topic = o.topic || {};
  const topicId = topic.id || '';
  const offs = [];

  const tree = outlineTree(topic);
  const rows = flattenTree(tree);
  const maxDepth = rows.reduce((m, n) => Math.max(m, n.depth), 0);

  const collapsed = new Set();
  let concealFrom = 0;          // 0 = nothing concealed; n = hide depth >= n
  const revealed = new Set();
  let selPath = null;

  const root = el('div.ol', { dataset: { subject: String(topic.subject || '').toLowerCase() } });
  const bar = el('div.ol__bar');
  const body = el('div.ol__body', { attrs: { role: 'tree', 'aria-label': (topic.name || 'Topic') + ' outline' } });
  const inspect = el('div.ol__inspect', { hidden: true });
  root.append(bar, body, inspect);
  host.appendChild(root);

  function isHiddenByAncestor(node) {
    for (const anc of rows) {
      if (anc === node) continue;
      if (node.path.indexOf(anc.path + '.') === 0 && collapsed.has(anc.path)) return true;
    }
    return false;
  }

  function isConcealed(node) {
    return concealFrom > 0 && node.depth >= concealFrom && !revealed.has(node.path);
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

  function renderBar() {
    bar.replaceChildren();
    if (!tree) return;
    const concealLabel = concealFrom === 0 ? 'Conceal detail' : 'Concealed below level ' + concealFrom;
    bar.append(
      chip('Expand all', 'chevron-down', () => { collapsed.clear(); render(); }),
      chip('Fold to level 1', 'chevron-right', () => {
        collapsed.clear();
        for (const n of rows) if (n.depth >= 1 && n.children.length) collapsed.add(n.path);
        render();
      }),
      chip(concealLabel, 'eye-off', () => {
        concealFrom = concealFrom === 0 ? Math.min(2, Math.max(1, maxDepth)) : concealFrom === 1 ? 0 : 1;
        revealed.clear();
        render();
      }, { active: concealFrom > 0 }),
      el('div.ol__spacer'),
      chip('Copy outline', 'copy', () => copyOutline()),
    );
  }

  function render() {
    body.replaceChildren();
    if (!tree) {
      body.appendChild(el('div.empty-state',
        icon('list', { size: 24 }),
        el('h3.empty-state__title', { text: 'No outline for this chapter yet' }),
        el('p.empty-state__body', {
          text: 'The outline comes from mindmap.md in the topic folder. Add one there and re-sync, or build the chapter yourself on the canvas.',
        })));
      renderBar();
      renderInspector();
      return;
    }

    for (const node of rows) {
      if (isHiddenByAncestor(node)) continue;
      const hidden = isConcealed(node);
      const rating = nodeRating(topicId, node.path, topic.unit);
      const isCollapsed = collapsed.has(node.path);
      const row = el('div.ol__row', {
        dataset: { path: node.path, depth: String(node.depth) },
        style: { '--depth': String(node.depth) },
        attrs: { role: 'treeitem', 'aria-level': String(node.depth + 1) },
        class: (selPath === node.path ? 'is-selected' : '') + (hidden ? ' is-hidden' : ''),
      });
      if (node.children.length) row.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      for (let d = 1; d <= node.depth; d += 1) {
        row.appendChild(el('span.ol__guide', { style: { left: 'calc(var(--sp-3) + ' + (d - 1) * 18 + 'px + 13px)' } }));
      }

      row.appendChild(el('button.ol__twist', {
        type: 'button',
        dataset: { leaf: node.children.length ? '0' : '1', act: 'twist' },
        attrs: { 'aria-label': isCollapsed ? 'Expand' : 'Collapse', tabindex: node.children.length ? '0' : '-1' },
      }, icon(isCollapsed ? 'chevron-right' : 'chevron-down', { size: 14 })));

      const label = el('button.ol__label', { type: 'button', dataset: { act: 'label' } },
        el('span.ol__text', { text: hidden ? '' : node.label }));
      const dots = el('span.ol__dots');
      if (node.cardId) dots.appendChild(el('span.ol__dot.ol__dot--card', { attrs: { title: 'Has a flashcard' } }));
      if (rating) dots.appendChild(el('span.ol__dot', { class: 'ol__dot--' + rating, attrs: { title: RATING_LABEL[rating] } }));
      if (isCollapsed && node.children.length) dots.appendChild(el('span.ol__count', { text: '+' + node.children.length }));
      label.appendChild(el('span.ol__spacer'));
      label.appendChild(dots);
      row.appendChild(label);
      body.appendChild(row);
    }

    renderBar();
    renderInspector();
  }

  function nodeAt(path) { return rows.find((n) => n.path === path) || null; }

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
    const node = selPath ? nodeAt(selPath) : null;
    if (!node) { inspect.hidden = true; return; }
    inspect.hidden = false;
    const rating = nodeRating(topicId, node.path, topic.unit);
    const cards = cardsFor(node);
    inspect.append(
      el('span.ol__inspect-label', { text: node.label }),
      el('span.eyebrow', { text: 'How solid?' }),
    );
    for (const key of ['R', 'Y', 'G']) {
      inspect.appendChild(chip(RATING_LABEL[key], null, () => {
        setNodeRating(topicId, node.path, rating === key ? null : key);
        render();
      }, { active: rating === key, tone: RATING_TONE[key] }));
    }
    if (cards.length) {
      inspect.append(
        el('span.pill.pill--info', icon('layers', { size: 12 }),
          el('span', { text: cards.length + ' ' + fmt.plural(cards.length, 'card') })),
        chip('Open card', 'arrow-right', () => navigateTo('#/study?card=' + encodeURIComponent(cards[0].id))),
      );
    }
    // cross-view sync — same branch, other two views (label is the shared key).
    inspect.append(
      chip('T-Tree', 'grid', () => navigateTo(routeFor('maps', { topic: topicId, mode: 'tree', node: node.label }))),
      chip('On my map', 'waypoints', () => navigateTo(routeFor('maps', { topic: topicId, mode: 'my', node: node.label }))),
      el('div.ol__spacer'),
      chip('Topic', 'layers', () => navigateTo(routeFor('topic', { id: topicId }))),
    );
  }

  function select(path) {
    selPath = path;
    render();
    if (!o.onSelect) return;
    const node = path ? nodeAt(path) : null;
    try { o.onSelect(node ? { label: node.label, path: node.path, cardId: node.cardId } : null); } catch (err) {
      console.error('[outline] onSelect failed', err);
    }
  }

  async function copyOutline() {
    const text = treeToMarkdown(tree);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        toast('Outline copied as markdown.', { tone: 'good' });
        return;
      }
      throw new Error('no clipboard');
    } catch (_) {
      store.downloadFile((topicId || 'topic') + '-outline.md', text, 'text/markdown');
      toast('Clipboard is blocked here — the outline downloaded instead.', { tone: 'info' });
    }
  }

  offs.push(on(body, 'click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const row = target && target.closest('.ol__row');
    if (!row) return;
    const path = row.dataset.path;
    const node = nodeAt(path);
    if (!node) return;
    const act = target.closest('[data-act]');
    if (act && act.dataset.act === 'twist' && node.children.length) {
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      render();
      return;
    }
    if (isConcealed(node)) { revealed.add(path); render(); return; }
    select(path === selPath ? null : path);
  }));

  offs.push(on(body, 'keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const row = e.target instanceof Element ? e.target.closest('.ol__row') : null;
    if (!row) return;
    const node = nodeAt(row.dataset.path);
    if (!node || !node.children.length) return;
    e.preventDefault();
    if (e.key === 'ArrowRight') collapsed.delete(node.path);
    else collapsed.add(node.path);
    render();
  }));

  render();

  return {
    root,
    get tree() { return tree; },
    render,
    markdown: () => treeToMarkdown(tree),
    /** Select + scroll a branch by path or label — cross-view selection sync. */
    focus(pathOrLabel) {
      if (!tree) return false;
      const key = normLabel(pathOrLabel);
      const node = rows.find((n) => n.path === pathOrLabel) || rows.find((n) => normLabel(n.label) === key);
      if (!node) return false;
      for (const anc of rows) if (node.path.indexOf(anc.path + '.') === 0) collapsed.delete(anc.path);
      if (isConcealed(node)) revealed.add(node.path);
      // select() so a deep link / cross-view jump reports the selection upward.
      select(node.path);
      const row = body.querySelector('.ol__row.is-selected');
      if (row && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
      return true;
    },
    destroy() {
      for (const off of offs) { try { off(); } catch (_) { /* fine */ } }
      root.remove();
    },
  };
}

export default createOutline;
