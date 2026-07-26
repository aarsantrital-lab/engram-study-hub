/* =============================================================================
   js/search-index.js — the global search index + the ⌘K / '/' overlay.
   Job A2. Imports: dom.js, router.js, store.js, config.js, vault.js, md.js.

   ---------------------------------------------------------------------------
   FOR FEATURE AGENTS — registering your own searchable things
   ---------------------------------------------------------------------------
   Static list (re-registering under the same source replaces the old set):

       import { searchIndex } from './search-index.js';
       searchIndex.register('numericals', [{
         type: 'formula',                       // see SEARCH_TYPES
         title: 'n = m ÷ M',
         subtitle: 'Mole concept',
         body:  'moles mass molar mass gram per mol',
         route: '#/topic?id=mole-concept',      // where Enter takes you
         icon:  'sigma',                        // optional sprite id
         keywords: ['formula', 'mole'],         // optional extra match text
       }]);

   Live list (re-evaluated on every rebuild — use when your data changes):

       searchIndex.registerProvider('errorbook', () => rows.map(toEntry));

   An entry MUST have {type, title, body, route}. Everything else is optional.
   Call searchIndex.rebuild() after your data changes; the overlay refreshes.
   ========================================================================== */

import CONFIG from './config.js';
import { store, KEYS } from './store.js';
import { el, icon, on, fmt, haptic, sound, debounce } from './dom.js';
import { navigateTo } from './router.js';
import { getTopics, getAllCards, flattenMindmap, isVaultMissing } from './vault.js';
import { stripMarkdown, excerpt } from './md.js';

/* ---------------------------------------------------------------------------
   1. Types
   ------------------------------------------------------------------------ */

/**
 * @typedef {Object} SearchEntry
 * @property {string} id      unique within its source (auto-filled if omitted)
 * @property {string} type    key of SEARCH_TYPES
 * @property {string} title   the bold line
 * @property {string} [subtitle]
 * @property {string} body    free text that is matched but not shown in full
 * @property {string} route   hash route, e.g. '#/topic?id=mole-concept'
 * @property {string} [icon]  sprite id override
 * @property {string[]} [keywords]
 * @property {number} [weight] multiplier, default 1
 */

/** Result groups, in display order. `weight` biases ranking. */
export const SEARCH_TYPES = {
  action:  { label: 'Actions',    icon: 'zap',           weight: 1.35, order: 0 },
  view:    { label: 'Go to',      icon: 'map',       weight: 1.25, order: 1 },
  topic:   { label: 'Topics',     icon: 'layers',        weight: 1.20, order: 2 },
  lesson:  { label: 'Lessons',    icon: 'book-open',     weight: 1.15, order: 3 },
  card:    { label: 'Flashcards', icon: 'layers',  weight: 1.00, order: 4 },
  formula: { label: 'Formulas',   icon: 'sigma',         weight: 1.10, order: 5 },
  node:    { label: 'Map nodes',  icon: 'waypoints',     weight: 0.95, order: 6 },
  note:    { label: 'Notes',      icon: 'edit',  weight: 0.90, order: 7 },
  doc:     { label: 'Reference',  icon: 'file-text',     weight: 0.90, order: 8 },
  paper:   { label: 'Past papers',icon: 'file-text',    weight: 0.95, order: 9 },
  error:   { label: 'Error book', icon: 'circle-alert',  weight: 1.05, order: 10 },
  chat:    { label: 'Messages',   icon: 'message-circle',weight: 0.80, order: 11 },
  other:   { label: 'Other',      icon: 'search',        weight: 0.70, order: 99 },
};

/* ---------------------------------------------------------------------------
   2. Matching helpers
   ------------------------------------------------------------------------ */

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036F]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(q) {
  return normalizeText(q).split(' ').filter(Boolean).slice(0, 8);
}

function prepare(entry, source, i) {
  const type = SEARCH_TYPES[entry.type] ? entry.type : 'other';
  const title = String(entry.title || '');
  const body = String(entry.body || '');
  const subtitle = String(entry.subtitle || '');
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.join(' ') : '';
  return {
    id: String(entry.id || source + ':' + i),
    source,
    type,
    title,
    subtitle,
    body,
    route: String(entry.route || ''),
    icon: entry.icon || SEARCH_TYPES[type].icon,
    weight: Number(entry.weight) || 1,
    data: entry.data,
    _t: normalizeText(title),
    _s: normalizeText(subtitle),
    _b: normalizeText(body),
    _k: normalizeText(keywords),
  };
}

function scoreEntry(e, tokens) {
  let total = 0;
  for (const tok of tokens) {
    let best = 0;
    if (e._t === tok) best = 140;
    else if (e._t.startsWith(tok)) best = 100;
    else if (new RegExp('(^| )' + escapeRe(tok)).test(e._t)) best = 78;
    else if (e._t.includes(tok)) best = 50;
    if (best < 78 && e._k.includes(tok)) best = Math.max(best, 40);
    if (best < 50 && e._s.includes(tok)) best = Math.max(best, 30);
    if (best < 30 && e._b.includes(tok)) {
      best = Math.max(best, new RegExp('(^| )' + escapeRe(tok)).test(e._b) ? 18 : 10);
    }
    if (best === 0) return 0;              // AND semantics: every token must hit
    total += best;
  }
  const typeWeight = SEARCH_TYPES[e.type] ? SEARCH_TYPES[e.type].weight : 1;
  const brevity = 1 + Math.max(0, (40 - e._t.length)) / 400;  // short titles win ties
  return total * typeWeight * e.weight * brevity;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---------------------------------------------------------------------------
   3. The index
   ------------------------------------------------------------------------ */

const staticSources = new Map();     // source -> prepared entries
const providers = new Map();         // source -> () => entries
let flat = [];
let dirty = true;
const changeListeners = new Set();

function rebuildNow() {
  flat = [];
  for (const entries of staticSources.values()) flat.push(...entries);
  for (const [source, fn] of providers.entries()) {
    try {
      const list = fn() || [];
      flat.push(...list.map((e, i) => prepare(e, source, i)));
    } catch (err) {
      console.error('[search] provider "' + source + '" failed', err);
    }
  }
  dirty = false;
  for (const fn of Array.from(changeListeners)) { try { fn(flat.length); } catch (_) { /* noop */ } }
  return flat.length;
}

function ensureFresh() { if (dirty) rebuildNow(); return flat; }

export const searchIndex = {
  /**
   * Replace (or add) a static set of entries for a source.
   * @param {string} source stable name — re-registering replaces the old set
   * @param {SearchEntry[]} entries
   * @returns {{remove:()=>void, update:(e:SearchEntry[])=>void}}
   */
  register(source, entries) {
    const key = String(source);
    staticSources.set(key, (entries || []).map((e, i) => prepare(e, key, i)));
    dirty = true;
    return {
      remove: () => { staticSources.delete(key); dirty = true; },
      update: (next) => { staticSources.set(key, (next || []).map((e, i) => prepare(e, key, i))); dirty = true; },
    };
  },

  /** Register a function that returns entries; re-run on every rebuild. */
  registerProvider(source, fn) {
    providers.set(String(source), fn);
    dirty = true;
    return () => { providers.delete(String(source)); dirty = true; };
  },

  unregister(source) {
    staticSources.delete(String(source));
    providers.delete(String(source));
    dirty = true;
  },

  /** Force a rebuild now. Returns the entry count. */
  rebuild() { return rebuildNow(); },

  /** Mark dirty; the next search rebuilds lazily. */
  invalidate() { dirty = true; },

  /** All prepared entries. */
  all() { return ensureFresh().slice(); },

  get size() { return ensureFresh().length; },

  sources() { return Array.from(new Set([...staticSources.keys(), ...providers.keys()])); },

  onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },

  /**
   * @param {string} query
   * @param {{limit?:number, types?:string[]}} [opts]
   * @returns {{entry:Object, score:number}[]} sorted best-first
   */
  search(query, opts) {
    const o = opts || {};
    const tokens = tokenize(query);
    const pool = ensureFresh();
    if (!tokens.length) return [];
    const out = [];
    for (const e of pool) {
      if (o.types && !o.types.includes(e.type)) continue;
      const score = scoreEntry(e, tokens);
      if (score > 0) out.push({ entry: e, score });
    }
    out.sort((a, b) => b.score - a.score || a.entry._t.length - b.entry._t.length);
    return out.slice(0, o.limit || CONFIG.LIMITS.searchResults);
  },
};

/* ---------------------------------------------------------------------------
   4. Built-in vault provider
   ------------------------------------------------------------------------ */

/**
 * Every searchable thing that comes from vault-data.js.
 * Registered by app.js as the 'vault' provider, so it refreshes whenever the
 * service worker swaps in fresher vault data.
 * @returns {SearchEntry[]}
 */
export function buildVaultEntries() {
  if (isVaultMissing()) return [];
  const out = [];

  for (const t of getTopics()) {
    out.push({
      id: 'topic:' + t.id,
      type: 'topic',
      title: t.name,
      subtitle: t.subject + (t.unit ? ' · ' + t.unit : ''),
      body: stripMarkdown(t.description) + ' ' + t.subject + ' ' + t.unit,
      route: '#/topic?id=' + encodeURIComponent(t.id),
      keywords: [t.subject, t.unit, t.badge],
    });

    for (const d of t.docs) {
      out.push({
        id: 'doc:' + d.id,
        type: d.kind === 'lesson' ? 'lesson' : 'doc',
        title: d.title,
        subtitle: t.name + ' · ' + t.subject,
        body: d.title + ' ' + t.name + ' ' + t.subject,
        route: '#/lesson?topic=' + encodeURIComponent(t.id) + '&file=' + encodeURIComponent(d.url),
        keywords: [t.subject, d.kind],
      });
    }

    for (const n of t.notes) {
      out.push({
        id: 'note:' + n.id,
        type: 'note',
        title: n.title,
        subtitle: t.name,
        body: stripMarkdown(n.body),
        route: '#/topic?id=' + encodeURIComponent(t.id) + '&note=' + encodeURIComponent(n.id),
        keywords: [t.subject],
      });
    }

    if (t.mindmap) {
      for (const node of flattenMindmap(t.mindmap)) {
        if (node.depth === 0) continue;
        out.push({
          id: 'node:' + t.id + ':' + node.path.join('/'),
          type: 'node',
          title: node.label,
          subtitle: t.name + ' · ' + node.path.slice(0, -1).join(' › '),
          body: node.path.join(' '),
          route: '#/maps?topic=' + encodeURIComponent(t.id) + '&node=' + encodeURIComponent(node.label),
          keywords: [t.subject, 'map', 'mindmap'],
        });
      }
    }
  }

  for (const c of getAllCards()) {
    out.push({
      id: 'card:' + c.id,
      type: 'card',
      title: c.q,
      subtitle: c.topicName + ' · ' + c.subject,
      body: stripMarkdown(c.a),
      route: '#/study?card=' + encodeURIComponent(c.id),
      keywords: [c.subject, c.topicName, 'flashcard'],
    });
  }

  return out;
}

/* ---------------------------------------------------------------------------
   5. The overlay
   ------------------------------------------------------------------------ */

let overlay = null;
let input = null;
let resultsHost = null;
let footHint = null;
let current = [];        // flat list of {entry} in display order
let activeIndex = 0;
let lastFocus = null;
let openState = false;

const RECENT_MAX = 6;

function recentQueries() {
  const r = store.get(KEYS.SEARCH_RECENT, []);
  return Array.isArray(r) ? r.filter((x) => typeof x === 'string') : [];
}

function pushRecent(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return;
  const list = recentQueries().filter((x) => x.toLowerCase() !== query.toLowerCase());
  list.unshift(query);
  store.set(KEYS.SEARCH_RECENT, list.slice(0, RECENT_MAX));
}

/** Build the overlay DOM once. app.js calls this at boot. */
export function mountSearchOverlay() {
  if (overlay) return overlay;

  input = el('input.search__input', {
    type: 'search',
    placeholder: 'Search lessons, cards, maps, formulas…',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    attrs: { 'aria-label': 'Search', 'aria-controls': 'search-results', role: 'combobox', 'aria-expanded': 'true' },
  });

  resultsHost = el('div#search-results.search__results', { attrs: { role: 'listbox' } });
  footHint = el('div.search__foot',
    el('span.search__hint', el('kbd', { text: '↑' }), el('kbd', { text: '↓' }), ' navigate'),
    el('span.search__hint', el('kbd', { text: '↵' }), ' open'),
    el('span.search__hint', el('kbd', { text: 'esc' }), ' close'),
    el('span.search__count')
  );

  const panel = el('div.search__panel', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' } },
    el('div.search__bar', icon('search', { size: 16, cls: 'search__bar-icon' }), input,
      el('button.search__close', { type: 'button', attrs: { 'aria-label': 'Close search' }, onClick: closeSearch }, icon('x', { size: 16 }))),
    resultsHost,
    footHint
  );

  overlay = el('div#search-overlay.search-overlay', { hidden: true, dataset: { open: 'false' } }, panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSearch(); });

  const run = debounce(() => renderResults(input.value), 90);
  on(input, 'input', run);
  on(input, 'keydown', onKeyDown);
  on(overlay, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });

  document.body.appendChild(overlay);
  return overlay;
}

function onKeyDown(e) {
  if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); activate(activeIndex); }
  else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Home' && !input.value) { e.preventDefault(); setActive(0); }
}

function move(delta) {
  if (!current.length) return;
  setActive((activeIndex + delta + current.length) % current.length);
}

function setActive(i) {
  activeIndex = i;
  const rows = resultsHost.querySelectorAll('.search__row');
  rows.forEach((row, k) => {
    const on_ = k === i;
    row.classList.toggle('is-active', on_);
    row.setAttribute('aria-selected', on_ ? 'true' : 'false');
    if (on_) row.scrollIntoView({ block: 'nearest' });
  });
}

function activate(i) {
  const hit = current[i];
  if (!hit) return;
  pushRecent(input.value);
  haptic('select');
  sound('select');
  closeSearch();
  // Priority: explicit handler -> entry.data.run() (actions) -> route.
  if (typeof hit.onSelect === 'function') hit.onSelect();
  else if (hit.entry && hit.entry.data && typeof hit.entry.data.run === 'function') hit.entry.data.run();
  else if (hit.route) navigateTo(hit.route);
}

/** Text with <mark> around matches, built from nodes (no innerHTML). */
function highlight(text, tokens) {
  const out = document.createDocumentFragment();
  const src = String(text || '');
  if (!tokens.length) { out.appendChild(document.createTextNode(src)); return out; }
  const norm = normalizeText(src);
  const ranges = [];
  for (const tok of tokens) {
    let from = 0, at;
    while ((at = norm.indexOf(tok, from)) !== -1 && ranges.length < 40) {
      ranges.push([at, at + tok.length]);
      from = at + tok.length;
    }
  }
  if (!ranges.length) { out.appendChild(document.createTextNode(src)); return out; }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r);
  }
  let cursor = 0;
  // normalizeText only lowercases + strips marks, so indices track 1:1 closely
  // enough for highlighting; we clamp to stay inside the source string.
  for (const [a, b] of merged) {
    const s = Math.min(a, src.length), e2 = Math.min(b, src.length);
    if (s > cursor) out.appendChild(document.createTextNode(src.slice(cursor, s)));
    const mark = document.createElement('mark');
    mark.className = 'search__mark';
    mark.textContent = src.slice(s, e2);
    out.appendChild(mark);
    cursor = e2;
  }
  if (cursor < src.length) out.appendChild(document.createTextNode(src.slice(cursor)));
  return out;
}

function snippet(body, tokens) {
  const src = String(body || '');
  if (!src) return '';
  if (!tokens.length) return fmt.truncate(src, 110);
  const norm = normalizeText(src);
  let at = -1;
  for (const t of tokens) { const i = norm.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at === -1) return fmt.truncate(src, 110);
  const start = Math.max(0, at - 38);
  return (start > 0 ? '…' : '') + fmt.truncate(src.slice(start), 130);
}

function renderResults(query) {
  const q = String(query || '').trim();
  const tokens = tokenize(q);
  resultsHost.replaceChildren();
  current = [];

  if (!q) { renderIdle(); return; }

  const hits = searchIndex.search(q, { limit: CONFIG.LIMITS.searchResults });
  if (!hits.length) {
    resultsHost.appendChild(el('div.search__empty',
      icon('search', { size: 18 }),
      el('p', { text: 'No matches for “' + q + '”' }),
      el('p.search__empty-hint', { text: 'Try a shorter word, a formula, or a topic name.' })
    ));
    updateCount(0);
    return;
  }

  const groups = new Map();
  for (const hit of hits) {
    if (!groups.has(hit.entry.type)) groups.set(hit.entry.type, []);
    groups.get(hit.entry.type).push(hit);
  }
  const ordered = Array.from(groups.entries()).sort(
    (a, b) => (SEARCH_TYPES[a[0]].order ?? 99) - (SEARCH_TYPES[b[0]].order ?? 99));

  for (const [type, list] of ordered) {
    const meta = SEARCH_TYPES[type] || SEARCH_TYPES.other;
    resultsHost.appendChild(el('div.search__group', { text: meta.label }));
    for (const hit of list) {
      const e = hit.entry;
      const idx = current.length;
      const row = el('div.search__row', {
        dataset: { type },
        attrs: { role: 'option', 'aria-selected': 'false', tabindex: '-1' },
        onClick: () => activate(idx),
        onMousemove: () => setActive(idx),
      },
        el('span.search__row-icon', icon(e.icon, { size: 14 })),
        el('span.search__row-main',
          el('span.search__row-title', highlight(fmt.truncate(e.title, 90), tokens)),
          e.subtitle ? el('span.search__row-sub', { text: e.subtitle }) : null,
          e.body ? el('span.search__row-body', highlight(snippet(e.body, tokens), tokens)) : null
        ),
        el('span.search__row-enter', { text: '↵' })
      );
      current.push({ route: e.route, entry: e });
      resultsHost.appendChild(row);
    }
  }
  updateCount(hits.length);
  setActive(0);
}

function renderIdle() {
  const recents = recentQueries();
  if (recents.length) {
    resultsHost.appendChild(el('div.search__group', { text: 'Recent' }));
    for (const q of recents) {
      const idx = current.length;
      resultsHost.appendChild(el('div.search__row', {
        dataset: { type: 'recent' },
        attrs: { role: 'option', 'aria-selected': 'false' },
        onClick: () => activate(idx),
        onMousemove: () => setActive(idx),
      },
        el('span.search__row-icon', icon('clock', { size: 14 })),
        el('span.search__row-main', el('span.search__row-title', { text: q })),
        el('span.search__row-enter', { text: '↵' })
      ));
      current.push({ onSelect: () => { openSearch(q); } });
    }
  }

  const suggestions = searchIndex.all().filter((e) => e.type === 'action' || e.type === 'view').slice(0, 8);
  if (suggestions.length) {
    resultsHost.appendChild(el('div.search__group', { text: 'Jump to' }));
    for (const e of suggestions) {
      const idx = current.length;
      resultsHost.appendChild(el('div.search__row', {
        dataset: { type: e.type },
        attrs: { role: 'option', 'aria-selected': 'false' },
        onClick: () => activate(idx),
        onMousemove: () => setActive(idx),
      },
        el('span.search__row-icon', icon(e.icon, { size: 14 })),
        el('span.search__row-main',
          el('span.search__row-title', { text: e.title }),
          e.subtitle ? el('span.search__row-sub', { text: e.subtitle }) : null),
        el('span.search__row-enter', { text: '↵' })
      ));
      current.push({ route: e.route, entry: e });
    }
  }
  updateCount(searchIndex.size, true);
  setActive(0);
}

function updateCount(n, idle) {
  const node = footHint && footHint.querySelector('.search__count');
  if (!node) return;
  node.textContent = idle
    ? fmt.int(n) + ' items indexed'
    : fmt.int(n) + ' ' + fmt.plural(n, 'result');
}

/* ---- open / close ---- */

export function isSearchOpen() { return openState; }

/** @param {string} [prefill] */
export function openSearch(prefill) {
  if (!overlay) mountSearchOverlay();
  searchIndex.rebuild();
  lastFocus = document.activeElement;
  openState = true;
  overlay.hidden = false;
  overlay.dataset.open = 'true';
  document.documentElement.classList.add('is-search-open');
  input.value = prefill === undefined ? '' : String(prefill);
  renderResults(input.value);
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return overlay;
}

export function closeSearch() {
  if (!overlay || !openState) return;
  openState = false;
  overlay.dataset.open = 'false';
  overlay.hidden = true;
  document.documentElement.classList.remove('is-search-open');
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
}

export function toggleSearch() { return openState ? closeSearch() : openSearch(); }

export default searchIndex;
