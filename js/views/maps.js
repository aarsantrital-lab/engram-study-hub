/* =============================================================================
   js/views/maps.js — Maps: the GRINDE canvas, the T-Tree, the outline, shared.
   Owner: Job — Mindmaps. (Replaces the Job A2 stub; export shape unchanged.)

   ROUTE CONTRACT (the shell's search index already emits the second form —
   do not change it):
       #/maps
       #/maps?topic=<topicId>&node=<label>          -> T-Tree, that branch
       #/maps?topic=<topicId>&mode=my|tree|outline|shared
       #/maps?topic=<topicId>&mode=my&map=<mapId>&node=<nodeId>

   The four modes answer four different questions and are deliberately NOT
   merged (pedagogy-spec R6):
     My map   — the encoding artefact HE builds. Nothing here generates it.
     T-Tree   — auto coverage skeleton from the chapter's mindmap.md. "What
                exists in this chapter", plus blank-tree recall.
     Outline  — the same tree as clean indented text, for reading and linking.
     Shared   — maps other people in his group posted (read only until copied).
   ========================================================================== */

import { el, icon, on, toast, fmt, emptyState, eyebrow } from './../dom.js';
import { store, KEYS, uid } from './../store.js';
import { getTopics, getTopic, isVaultMissing, getSubjects } from './../vault.js';
import { navigate } from './../router.js';
import { searchIndex } from './../search-index.js';
import { SUBJECT_ICONS } from './../config.js';
import {
  createMindmapCanvas, listMaps, loadMap, saveMap, deleteMap, createMapDoc,
  normalizeMapDoc, parseMapPayload, askText,
} from './../mindmap-canvas.js';
import { createTTree, coverage, buildTree } from './../ttree.js';
import { createOutline, outlineTree } from './../outline.js';

const MODES = [
  { id: 'my', label: 'My map', icon: 'waypoints' },
  { id: 'tree', label: 'T-Tree', icon: 'grid' },
  { id: 'outline', label: 'Outline', icon: 'list' },
  { id: 'shared', label: 'Shared', icon: 'user' },
];

const UI_KEY = 'mapsUi';          // {topicId, mode, mapId, node}

/* The selected branch, carried across the mode switch. The LABEL is the shared
   key on purpose: ttree.focus(), outline.focus() and canvas.focusNode() all
   accept a label, while positional paths only exist in the two tree views. */
let selLabel = '';

/* ---------------------------------------------------------------------------
   Optional cross-job bridges — both modules may not exist yet, so every call
   is a dynamic import behind a try/catch and every failure is a silent no-op.
   ------------------------------------------------------------------------ */

let gamePromise;
async function gameLayer() {
  if (gamePromise === undefined) {
    gamePromise = import('./../game.js')
      .then((m) => m.game || m.default || m)
      .catch(() => null);
  }
  return gamePromise;
}

async function recordActivity(kind, meta) {
  const g = await gameLayer();
  if (!g || typeof g.recordActivity !== 'function') return;
  try { g.recordActivity(kind, meta); } catch (err) { console.error('[maps] recordActivity failed', err); }
}

let sbPromise;
async function backend() {
  if (sbPromise === undefined) {
    sbPromise = import('./../sb.js')
      .then((m) => m.sb || m.default || m)
      .catch(() => null);
  }
  return sbPromise;
}

/* ---------------------------------------------------------------------------
   Search: his own map ideas become findable. (The shell's 'vault' provider
   already indexes T-Tree branches — this source covers the GRINDE canvas.)
   ------------------------------------------------------------------------ */

searchIndex.registerProvider('mymaps', () => {
  const out = [];
  const raw = store.get(KEYS.MAPS, {});
  if (!raw || typeof raw !== 'object') return out;
  for (const [mapId, doc] of Object.entries(raw)) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.nodes)) continue;
    const title = String(doc.title || 'Untitled map');
    const topicId = String(doc.topicId || '');
    out.push({
      id: 'map:' + mapId,
      type: 'other',
      icon: 'waypoints',
      title,
      subtitle: (doc.subject || 'My maps') + ' · ' + doc.nodes.length + ' ' + fmt.plural(doc.nodes.length, 'idea'),
      body: title + ' mind map ' + (doc.subject || ''),
      route: '#/maps?mode=my' + (topicId ? '&topic=' + encodeURIComponent(topicId) : '') + '&map=' + encodeURIComponent(mapId),
      keywords: ['map', 'mindmap', 'grinde'],
    });
    for (const n of doc.nodes.slice(0, 120)) {
      if (!n || !n.label) continue;
      out.push({
        id: 'mapnode:' + mapId + ':' + n.id,
        type: 'node',
        title: String(n.label),
        subtitle: title + (doc.subject ? ' · ' + doc.subject : ''),
        body: String(n.label) + ' ' + title,
        route: '#/maps?mode=my' + (topicId ? '&topic=' + encodeURIComponent(topicId) : '') +
          '&map=' + encodeURIComponent(mapId) + '&node=' + encodeURIComponent(n.id),
        keywords: ['map', 'idea', doc.subject || ''],
      });
    }
  }
  return out;
});

/* ---------------------------------------------------------------------------
   Styles
   ------------------------------------------------------------------------ */

const STYLE_ID = 'engram-maps-view-css';

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.mv { display: flex; flex-direction: column; gap: var(--sp-4); }
.mv__head { display: flex; flex-direction: column; gap: var(--sp-2); }
.mv__title { margin: 0; font-size: var(--fs-title-lg); font-weight: var(--fw-semibold); letter-spacing: var(--tr-metric); }
.mv__sub { margin: 0; font-size: var(--fs-caption); color: var(--fg-muted); max-width: var(--prose-max); }
.mv__controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.mv__picker { min-width: 190px; flex: 1 1 220px; max-width: 340px; }
.mv__modes { flex: 0 0 auto; overflow-x: auto; scrollbar-width: none; }
.mv__modes::-webkit-scrollbar { display: none; }
.mv__panel { display: flex; flex-direction: column; gap: var(--sp-3); }
.mv__maps { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.mv__spacer { flex: 1 1 auto; min-width: 0; }
.mv__shared { display: grid; gap: var(--sp-3); grid-template-columns: 1fr; }
@media (min-width: 720px) { .mv__shared { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.mv__legend { display: flex; flex-wrap: wrap; gap: var(--sp-3); font-size: var(--fs-meta); color: var(--fg-muted); }
.mv__legend span { display: inline-flex; align-items: center; gap: 6px; }
.mv__swatch { width: 10px; height: 10px; border-radius: var(--r-full); display: inline-block; }
`;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------------------
   View state
   ------------------------------------------------------------------------ */

let mounted = null;     // active sub-view controller
let offs = [];

function teardown() {
  if (mounted && typeof mounted.destroy === 'function') {
    try { mounted.destroy(); } catch (err) { console.error('[maps] teardown failed', err); }
  }
  mounted = null;
  for (const off of offs) { try { off(); } catch (_) { /* fine */ } }
  offs = [];
}

function readUi() {
  const raw = store.get(UI_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function writeUi(patch) {
  store.set(UI_KEY, Object.assign(readUi(), patch || {}));
}

/** Every sub-view reports its selection here, so the mode switch keeps it. */
function remember(node) {
  selLabel = node && node.label ? String(node.label) : '';
  writeUi({ node: selLabel });
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

/** Two-tap destructive action — no native confirm(). */
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

/* ---------------------------------------------------------------------------
   The view
   ------------------------------------------------------------------------ */

export default {
  id: 'maps',
  title: 'Maps',
  icon: 'waypoints',

  render(root, params) {
    ensureStyles();
    teardown();

    const ui = readUi();
    const topics = getTopics();
    const vaultMissing = isVaultMissing();

    /* ---- resolve topic ------------------------------------------------- */
    let topicId = String(params.topic || (params._path && params._path[0]) || ui.topicId || '');
    let topic = topicId ? getTopic(topicId) : null;
    if (!topic && topics.length) { topic = topics[0]; topicId = topic.id; }
    if (topic) topicId = topic.id;

    /* ---- resolve mode -------------------------------------------------- */
    const requested = String(params.mode || '').toLowerCase();
    let mode = MODES.some((m) => m.id === requested) ? requested : '';
    if (!mode && params.map) mode = 'my';
    if (!mode && params.node) mode = 'tree';
    if (!mode) mode = MODES.some((m) => m.id === ui.mode) ? ui.mode : '';
    if (!mode) mode = topic && topic.mindmap ? 'tree' : 'my';
    // With the vault missing, an EXPLICIT T-Tree/Outline request keeps its mode
    // so the card below can say why it is empty. Silently swapping him to the
    // canvas would read as a broken link.
    if (!vaultMissing || !requested) {
      if (mode === 'tree' && (!topic || !topic.mindmap)) mode = 'my';
      if (mode === 'outline' && !topic) mode = 'my';
    }

    /* ---- resolve the shared selection ---------------------------------- */
    if (ui.topicId !== topicId) selLabel = '';
    else if (!selLabel && ui.node) selLabel = String(ui.node);
    if (params.node) selLabel = String(params.node);

    writeUi({ topicId, mode, node: selLabel || '' });

    /* ---- shell --------------------------------------------------------- */
    const wrap = el('div.mv', {
      dataset: { subject: topic ? String(topic.subject || '').toLowerCase() : '' },
    });
    const head = el('div.mv__head',
      eyebrow('Maps'),
      el('h1.mv__title', { text: topic ? topic.name : 'Mind maps' }),
      el('p.mv__sub', {
        text: mode === 'my'
          ? 'Your map, drawn by you. Group what belongs together, point every arrow, and check the islands — nothing floating on its own.'
          : mode === 'tree'
            ? 'Coverage skeleton for this chapter, straight from the vault. Use blank-tree recall before you decide a chapter is done.'
            : mode === 'outline'
              ? 'The same chapter as plain indented text — quickest way to find a branch and jump to its cards.'
              : 'Maps your group has shared. Read them, copy one in, but draw your own first — copying someone else’s map is reading, not encoding.',
      }));

    const controls = el('div.mv__controls');

    // topic picker
    if (topics.length) {
      const select = el('select.select.mv__picker', { attrs: { 'aria-label': 'Choose a chapter' } });
      const bySubject = new Map();
      for (const subject of getSubjects()) bySubject.set(subject, []);
      for (const t of topics) {
        if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
        bySubject.get(t.subject).push(t);
      }
      for (const [subject, list] of bySubject) {
        const group = el('optgroup', { attrs: { label: subject } });
        for (const t of list) {
          group.appendChild(el('option', { value: t.id, text: t.name, selected: t.id === topicId }));
        }
        select.appendChild(group);
      }
      offs.push(on(select, 'change', () => {
        navigate('maps', { topic: select.value, mode });
      }));
      controls.appendChild(select);
    }

    // mode switcher
    const modes = el('div.segmented.mv__modes', { attrs: { role: 'tablist', 'aria-label': 'Map view' } });
    for (const m of MODES) {
      const disabled =
        (m.id === 'tree' && (!topic || !topic.mindmap)) ||
        (m.id === 'outline' && !topic);
      const btn = el('button.segmented__btn', {
        type: 'button',
        attrs: { role: 'tab', 'aria-selected': String(m.id === mode) },
        disabled: disabled || undefined,
        onClick: () => navigate('maps', { topic: topicId || null, mode: m.id, node: selLabel || null }),
      }, icon(m.icon, { size: 14 }), el('span', { text: m.label }));
      if (m.id === mode) btn.classList.add('is-active');
      modes.appendChild(btn);
    }
    controls.appendChild(modes);

    const panel = el('div.mv__panel');
    wrap.append(head, controls, panel);
    root.appendChild(wrap);

    if (vaultMissing && mode !== 'my' && mode !== 'shared') {
      panel.appendChild(vaultMissingCard());
      return;
    }

    if (mode === 'my') mountMyMap(panel, { topic, topicId, params });
    else if (mode === 'tree') mountTree(panel, { topic, params });
    else if (mode === 'outline') mountOutline(panel, { topic, params });
    else mountShared(panel, { topic, topicId });
  },

  onExit() { teardown(); },
};

/* ---------------------------------------------------------------------------
   Vault-missing state — the canvas still works without a vault, so say so.
   ------------------------------------------------------------------------ */

function vaultMissingCard() {
  return el('div.card',
    emptyState({
      icon: 'wifi-off',
      title: 'No chapters loaded yet',
      body: 'The T-Tree and the outline are built from your vault (mindmap.md per topic), and vault-data.js is not here yet. ' +
        'You can still draw a map from scratch — it saves on this device.',
      action: { label: 'Draw a map anyway', onClick: () => navigate('maps', { mode: 'my' }) },
    }));
}

/* ---------------------------------------------------------------------------
   Mode: My map (the GRINDE canvas)
   ------------------------------------------------------------------------ */

function mountMyMap(panel, ctx) {
  const topic = ctx.topic;
  const topicId = ctx.topicId || '';
  const params = ctx.params || {};
  const ui = readUi();

  const saved = listMaps(topicId || undefined);
  let mapId = String(params.map || '');
  if (!mapId && ui.mapId && saved.some((m) => m.id === ui.mapId)) mapId = ui.mapId;
  if (!mapId && saved.length) mapId = saved[0].id;
  if (!mapId) mapId = topicId || uid('map');

  let doc = loadMap(mapId);
  if (!doc) {
    doc = createMapDoc({
      id: mapId,
      topicId,
      subject: topic ? topic.subject : '',
      title: topic ? topic.name + ' — my map' : 'My map',
    });
  }
  writeUi({ mapId });

  /* map switcher row */
  const row = el('div.mv__maps');
  const rebuildRow = () => {
    row.replaceChildren();
    const list = listMaps(topicId || undefined);
    if (!list.some((m) => m.id === mapId)) {
      list.unshift({ id: mapId, title: doc.title, nodes: doc.nodes.length, updatedTs: 0 });
    }
    for (const m of list) {
      row.appendChild(chip(
        m.title + ' · ' + m.nodes,
        'waypoints',
        () => navigate('maps', { topic: topicId || null, mode: 'my', map: m.id }),
        { active: m.id === mapId },
      ));
    }
    row.append(
      chip('New map', 'plus', async () => {
        const title = await askText({
          title: 'Name the new map',
          hint: 'One map per chapter usually beats one giant map.',
          value: topic ? topic.name : '', placeholder: 'Mole concept',
        });
        if (title === null) return;
        const id = uid('map');
        const next = createMapDoc({
          id, topicId, subject: topic ? topic.subject : '',
          title: String(title).trim() || 'Untitled map',
        });
        saveMap(next);
        navigate('maps', { topic: topicId || null, mode: 'my', map: id });
      }),
      el('div.mv__spacer'),
      chip('Rename', 'edit', async () => {
        const title = await askText({ title: 'Rename this map', value: doc.title, okLabel: 'Rename' });
        if (title === null) return;
        doc.title = String(title).trim().slice(0, 80) || doc.title;
        if (mounted && typeof mounted.save === 'function') mounted.save();
        else saveMap(doc);
        rebuildRow();
        searchIndex.invalidate();
      }),
      dangerChip('Delete map', () => {
        deleteMap(mapId);
        searchIndex.invalidate();
        toast('Map deleted.', { tone: 'info' });
        navigate('maps', { topic: topicId || null, mode: 'my' });
      }),
    );
  };
  rebuildRow();

  const canvasHost = el('div');
  panel.append(row, canvasHost, legend());

  mounted = createMindmapCanvas(canvasHost, {
    doc,
    topicId,
    subject: topic ? topic.subject : '',
    onSelect: remember,
    // Rebuild the chip row too, not just the search index: the chip shows the
    // idea count, and rebuildRow() only ever ran at mount and on Rename, so it
    // read "· 0" for a whole session while the map filled up underneath it.
    onChange: () => { searchIndex.invalidate(); rebuildRow(); },
    onActivity: (kind, meta) => {
      recordActivity(kind, meta);
      if (kind === 'review' && meta && meta.total) {
        window.dispatchEvent(new CustomEvent('engram:celebration', {
          detail: { kind: 'map-recall', label: meta.recalled + ' of ' + meta.total + ' ideas rebuilt from memory' },
        }));
      }
    },
  });

  const wanted = String(params.node || selLabel || '');
  if (wanted) {
    setTimeout(() => {
      if (!mounted || typeof mounted.focusNode !== 'function') return;
      const found = mounted.focusNode(wanted);
      // Coming from the tree, the outline or search: say so, then leave it to
      // him. R6 — nothing here draws the idea for him.
      if (!found && params.node && mounted.doc && mounted.doc.nodes.length) {
        toast('“' + wanted + '” is not on your map yet. If it belongs there, add it.',
          { tone: 'info', timeout: 6000 });
      }
    }, 60);
  }
}

function legend() {
  const swatch = (token) => el('span.mv__swatch', { style: { background: 'var(' + token + ')' } });
  return el('div.mv__legend',
    el('span', swatch('--warn'), el('span', { text: 'island — not linked to anything' })),
    el('span', swatch('--brand'), el('span', { text: 'backbone — the answer plan for an 8-mark question' })),
    el('span', swatch('--info'), el('span', { text: 'links out to a lesson or card' })),
  );
}

/* ---------------------------------------------------------------------------
   Mode: T-Tree
   ------------------------------------------------------------------------ */

function mountTree(panel, ctx) {
  const topic = ctx.topic;
  const params = ctx.params || {};
  if (!topic || !topic.mindmap) {
    panel.appendChild(el('div.card', emptyState({
      icon: 'grid',
      title: 'No coverage tree for this chapter',
      body: 'A T-Tree is generated from mindmap.md in the topic folder. Add one and re-sync — or use the canvas and build the chapter yourself.',
      action: { label: 'Open my map', onClick: () => navigate('maps', { topic: topic ? topic.id : null, mode: 'my' }) },
    })));
    return;
  }

  const cov = coverage(topic.id, buildTree(topic.mindmap, topic.name), topic.unit);
  panel.appendChild(el('div.card.card--tone.card--quiet',
    el('div.row.row--between',
      el('div.row',
        icon(SUBJECT_ICONS[topic.subject] || 'layers', { size: 16 }),
        el('span.card__title', { text: topic.name })),
      el('span.pill.pill--neutral', el('span', {
        text: cov.total + ' ' + fmt.plural(cov.total, 'branch', 'branches') + ' · ' + cov.unrated + ' not yet rated',
      })))));

  const treeHost = el('div');
  panel.appendChild(treeHost);

  mounted = createTTree(treeHost, {
    topic,
    onSelect: remember,
    onActivity: (kind, meta) => recordActivity(kind, meta),
  });

  const wanted = String(params.node || selLabel || '');
  if (wanted) {
    setTimeout(() => { if (mounted && typeof mounted.focus === 'function') mounted.focus(wanted); }, 60);
  }
}

/* ---------------------------------------------------------------------------
   Mode: Outline
   ------------------------------------------------------------------------ */

function mountOutline(panel, ctx) {
  const topic = ctx.topic;
  const params = ctx.params || {};
  if (!topic) {
    panel.appendChild(el('div.card', emptyState({
      icon: 'list', title: 'Pick a chapter first',
      body: 'The outline reads mindmap.md from a topic folder.',
    })));
    return;
  }
  const tree = outlineTree(topic);
  const host = el('div');
  panel.appendChild(host);
  mounted = createOutline(host, { topic, onSelect: remember });

  const wanted = String(params.node || selLabel || '');
  if (tree && wanted) {
    setTimeout(() => { if (mounted && typeof mounted.focus === 'function') mounted.focus(wanted); }, 60);
  }
}

/* ---------------------------------------------------------------------------
   Mode: Shared
   ------------------------------------------------------------------------ */

function mountShared(panel, ctx) {
  const topicId = ctx.topicId || '';
  const listHost = el('div.mv__shared');
  const status = el('div');
  panel.append(status, listHost);

  status.appendChild(el('div.row', icon('loader', { size: 16, cls: 'icon-spin' }),
    el('span.card__sub', { text: 'Looking for shared maps…' })));

  let cancelled = false;
  mounted = { destroy() { cancelled = true; } };

  (async () => {
    const sb = await backend();
    if (cancelled) return;
    if (!sb || typeof sb.ready !== 'function' || !sb.ready()) {
      status.replaceChildren(el('div.card', emptyState({
        icon: 'wifi-off',
        title: 'Group sharing is not set up',
        body: 'Once the group server is configured you will see maps your friends posted here. Until then, export a map to a file and send it — Import is in the canvas tools.',
        action: { label: 'Back to my map', onClick: () => navigate('maps', { topic: topicId || null, mode: 'my' }) },
      })));
      return;
    }
    let res;
    try {
      res = await sb.db.select('shared_items', {
        filters: { type: 'map' },
        order: { column: 'updated_at', ascending: false },
        limit: 40,
      });
    } catch (err) {
      console.error('[maps] shared fetch failed', err);
      res = { data: null, error: { message: 'could not reach the group server' } };
    }
    if (cancelled) return;
    if (res && res.error) {
      status.replaceChildren(el('div.banner', icon('alert-triangle', { size: 16 }),
        el('span', { text: 'Could not load shared maps: ' + (res.error.message || 'unknown error') })));
      return;
    }
    const rows = Array.isArray(res && res.data) ? res.data : [];
    status.replaceChildren(el('div.row.row--between',
      el('span.eyebrow', { text: rows.length + ' shared ' + fmt.plural(rows.length, 'map') }),
      chip('Refresh', 'refresh', () => navigate('maps', { topic: topicId || null, mode: 'shared' }))));
    if (!rows.length) {
      listHost.appendChild(el('div.card', emptyState({
        icon: 'user', title: 'Nobody has shared a map yet',
        body: 'Share yours from the canvas tools — then compare groupings. Different groupings for the same chapter is the interesting part.',
      })));
      return;
    }
    for (const row of rows) listHost.appendChild(sharedCard(row, topicId));
  })();
}

function sharedCard(row, topicId) {
  const doc = parseMapPayload(row);
  const title = String((row && row.title) || (doc && doc.title) || 'Shared map');
  const card = el('div.card.card--tone',
    el('div.card__head',
      el('div.card__title', { text: title }),
      el('div.card__sub', {
        text: doc
          ? doc.nodes.length + ' ' + fmt.plural(doc.nodes.length, 'idea') + ' · ' + doc.edges.length + ' ' + fmt.plural(doc.edges.length, 'link')
          : 'This map could not be read.',
      })));
  const body = el('div.card__body');
  card.appendChild(body);

  if (!doc) return card;

  let preview = null;
  card.appendChild(el('div.card__foot',
    chip('Preview', 'eye', () => {
      if (preview) { preview.destroy(); preview = null; body.replaceChildren(); return; }
      preview = createMindmapCanvas(body, { doc, readOnly: true });
      preview.fit();
    }),
    chip('Copy to my maps', 'copy', () => {
      const copy = normalizeMapDoc(doc);
      copy.id = uid('map');
      copy.topicId = topicId || copy.topicId;
      copy.title = title + ' (copy)';
      if (saveMap(copy)) {
        searchIndex.invalidate();
        toast('Copied. Now change one grouping — reading someone else’s map is not encoding.', { tone: 'good', timeout: 7000 });
        navigate('maps', { topic: topicId || null, mode: 'my', map: copy.id });
      }
    }),
  ));
  return card;
}
