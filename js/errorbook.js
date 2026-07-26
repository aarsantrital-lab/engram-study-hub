/* =============================================================================
   js/errorbook.js — the Error Book. Owner: Job B2.

   "The single artefact most correlated with failing→topping" (pedagogy-spec §2,
   Tier 0). Every miss writes one row, automatically, with FIVE fields and no
   more: the question, HIS answer, the correct answer, the ONE missing step, and
   the confidence he held at the time.

   It is also the hypercorrection queue: a miss held at confidence ≥ 4 is flagged
   `hyper` and is the highest-priority item in the whole system next session
   (pedagogy-spec §2 Tier 0 + §1.5). study.js reads hypercorrectionCardIds().

   RULES
     · store API only; append-and-amend, never silently prune (build-constraints
       §9.3 — quota refuses, it does not delete).
     · all day maths through store's LOCAL date helpers (§9.1).
     · text via el({text}) / md.js only — no innerHTML (§9.8).
     · tone: marks-language, task-attributed, never "you keep getting this wrong".
   ========================================================================== */

import { store, KEYS, todayLocalISO, uid, dayKeyFromTs } from './store.js';
import { searchIndex } from './search-index.js';
import { routeFor } from './router.js';
import { el, icon, fmt, md, emptyState, toast } from './dom.js';
import { cardContent, subjectSlug, clearRewrite } from './queue-ui.js';

/** Search source name — must not collide with the shell's own sources. */
export const ERRORBOOK_SOURCE = 'errorbook';

/** Confidence at or above this on a miss = hypercorrection priority. */
export const HYPER_CONFIDENCE = 4;

/* =============================================================================
   1. STORAGE
   ========================================================================== */

function readAll() {
  const raw = store.get(KEYS.ERROR_BOOK, []);
  return Array.isArray(raw) ? raw : [];
}

function writeAll(rows) {
  const ok = store.set(KEYS.ERROR_BOOK, rows);
  if (!ok) {
    toast('Storage is full — this error was kept in memory only. Export a backup from Settings.', { tone: 'warn', timeout: 8000 });
  }
  searchIndex.invalidate();
  return ok;
}

/**
 * One row, in the book's shape.
 *
 * This is also the ADAPTER for sibling features that append straight to
 * KEYS.ERROR_BOOK (numericals.js writes `missing` / `misconceptionId` /
 * `problemType` and no `day`). The Error Book is one book, not one per feature,
 * so every alias is folded in here rather than asking each writer to change:
 * a numerical miss without this keeps its "one missing step" field BLANK, which
 * is the single most valuable field in the artefact (pedagogy-spec §2 Tier 0).
 */
function normalise(row) {
  const ts = Number(row.ts) || Date.now();
  const confidence = row.confidence === null || row.confidence === undefined || row.confidence === ''
    ? null
    : Math.max(1, Math.min(5, Math.round(Number(row.confidence)) || 1));

  const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
  for (const extra of [row.misconceptionId, row.problemType]) {
    const t = extra === null || extra === undefined ? '' : String(extra);
    if (t && !tags.includes(t)) tags.push(t);
  }

  return {
    id: String(row.id || uid('eb')),
    ts,
    day: String(row.day || dayKeyFromTs(ts) || todayLocalISO()),
    kind: ['miss', 'leech', 'pretest'].includes(row.kind) ? row.kind : 'miss',
    cardId: String(row.cardId || ''),
    topicId: String(row.topicId || ''),
    topicName: String(row.topicName || row.unit || ''),
    subject: String(row.subject || ''),
    question: String(row.question || ''),
    given: String(row.given || ''),
    correct: String(row.correct || ''),
    missingStep: String(row.missingStep || row.missing || ''),
    confidence,
    // A writer that never set the flag still gets the hypercorrection rule
    // applied to it: confident + wrong is the top-priority queue in the system.
    hyper: row.hyper === undefined || row.hyper === null
      ? Number(confidence) >= HYPER_CONFIDENCE
      : !!row.hyper,
    attempts: Math.max(1, Number(row.attempts) || 1),
    tags,
    resolved: !!row.resolved,
    resolvedOn: row.resolvedOn ? String(row.resolvedOn) : null,
    note: String(row.note || ''),
  };
}

/* =============================================================================
   2. WRITE API — called by the runners
   ========================================================================== */

/**
 * Record a miss. Auto-called by study.js on every wrong retrieval.
 * An existing OPEN row for the same card is amended (attempts +1) rather than
 * duplicated — the book stays a book, not a log.
 *
 * @param {{cardId:string, given:string, correct?:string, missingStep:string,
 *          confidence:number|null, kind?:'miss'|'pretest', question?:string,
 *          tags?:string[]}} input
 * @returns {object|null} the stored row
 */
export function addMiss(input) {
  const cardId = String((input && input.cardId) || '');
  if (!cardId) return null;
  const content = cardContent(cardId);
  const rows = readAll();
  const openIndex = rows.findIndex((r) => r && r.cardId === cardId && !r.resolved && r.kind !== 'leech');

  const hyper = Number(input.confidence) >= HYPER_CONFIDENCE;
  const base = {
    cardId,
    kind: input.kind || 'miss',
    topicId: (content && content.topicId) || input.topicId || '',
    topicName: (content && content.topicName) || input.topicName || '',
    subject: (content && content.subject) || input.subject || '',
    question: input.question || (content && content.q) || '',
    given: input.given || '',
    correct: input.correct || (content && content.a) || '',
    missingStep: input.missingStep || '',
    confidence: input.confidence === undefined ? null : input.confidence,
    hyper,
    tags: input.tags || (content && content.meta && content.meta.misconceptionTags) || [],
    ts: Date.now(),
    day: todayLocalISO(),
  };

  let row;
  if (openIndex >= 0) {
    const prev = rows[openIndex];
    row = normalise({
      ...prev,
      ...base,
      id: prev.id,
      attempts: (Number(prev.attempts) || 1) + 1,
      hyper: prev.hyper || hyper,
      note: prev.note,
    });
    rows[openIndex] = row;
  } else {
    row = normalise(base);
    rows.push(row);
  }
  writeAll(rows);
  return row;
}

/**
 * A leech (lapses ≥ 6, auto-suspended by the scheduler) waiting for a rewrite.
 * Framed per pedagogy-spec R12: a bad card or a missing prerequisite, never a
 * willpower problem.
 */
export function addLeech(input) {
  const cardId = String((input && input.cardId) || '');
  if (!cardId) return null;
  const content = cardContent(cardId);
  const rows = readAll();
  const existing = rows.findIndex((r) => r && r.cardId === cardId && r.kind === 'leech' && !r.resolved);
  const row = normalise({
    ...(existing >= 0 ? rows[existing] : {}),
    kind: 'leech',
    cardId,
    topicId: (content && content.topicId) || '',
    topicName: (content && content.topicName) || '',
    subject: (content && content.subject) || '',
    question: (content && content.q) || '',
    correct: (content && content.a) || '',
    missingStep: input.missingStep || '',
    confidence: input.confidence === undefined ? null : input.confidence,
    given: input.given || '',
    ts: Date.now(),
    day: todayLocalISO(),
  });
  if (existing >= 0) rows[existing] = row; else rows.push(row);
  writeAll(rows);
  return row;
}

/** Close a row (he got it back, or he rewrote the card with Hermes). */
export function markResolved(id, how) {
  const rows = readAll();
  const i = rows.findIndex((r) => r && r.id === id);
  if (i < 0) return null;
  rows[i] = normalise({ ...rows[i], resolved: true, resolvedOn: todayLocalISO(), note: how || rows[i].note });
  writeAll(rows);
  return rows[i];
}

/** Re-open a row (the misconception came back — the highest-priority signal). */
export function reopen(id) {
  const rows = readAll();
  const i = rows.findIndex((r) => r && r.id === id);
  if (i < 0) return null;
  rows[i] = normalise({ ...rows[i], resolved: false, resolvedOn: null, attempts: (rows[i].attempts || 1) + 1 });
  writeAll(rows);
  return rows[i];
}

/**
 * A later correct retrieval closes the open row for that card.
 * @returns {object|null} the row that was closed, if any
 */
export function noteCorrect(cardId) {
  const rows = readAll();
  const i = rows.findIndex((r) => r && r.cardId === cardId && !r.resolved && r.kind !== 'leech');
  if (i < 0) return null;
  rows[i] = normalise({ ...rows[i], resolved: true, resolvedOn: todayLocalISO(), note: 'retrieved correctly' });
  writeAll(rows);
  return rows[i];
}

/** Attach his own note to a row (what he now thinks the rule is). */
export function setNote(id, note) {
  const rows = readAll();
  const i = rows.findIndex((r) => r && r.id === id);
  if (i < 0) return null;
  rows[i] = normalise({ ...rows[i], note: String(note || '').slice(0, 600) });
  writeAll(rows);
  return rows[i];
}

/* =============================================================================
   3. READ API
   ========================================================================== */

/**
 * @param {{subject?:string, topicId?:string, kind?:string, unresolvedOnly?:boolean,
 *          hyperOnly?:boolean, cardId?:string, since?:number, query?:string,
 *          limit?:number}} [filter]
 * @returns {Array<object>} newest first
 */
export function getEntries(filter) {
  const f = filter || {};
  const q = String(f.query || '').trim().toLowerCase();
  let rows = readAll().map(normalise).filter((r) => {
    if (f.subject && r.subject !== f.subject) return false;
    if (f.topicId && r.topicId !== f.topicId) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (f.cardId && r.cardId !== f.cardId) return false;
    if (f.unresolvedOnly && r.resolved) return false;
    if (f.hyperOnly && !r.hyper) return false;
    if (f.since !== undefined && r.ts < f.since) return false;
    if (q) {
      const hay = (r.question + ' ' + r.given + ' ' + r.correct + ' ' + r.missingStep + ' ' + r.topicName + ' ' + r.tags.join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  rows.sort((a, b) => b.ts - a.ts);
  if (f.limit) rows = rows.slice(0, f.limit);
  return rows;
}

/**
 * THE hypercorrection queue: confident-wrong, still open, most recent first.
 * study.js force-feeds these to the front of tonight's session.
 * @param {{limit?:number, topicId?:string}} [o]
 * @returns {string[]} card ids
 */
export function hypercorrectionCardIds(o) {
  const opts = o || {};
  const rows = getEntries({ unresolvedOnly: true, hyperOnly: true, topicId: opts.topicId });
  const ids = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.cardId || seen.has(r.cardId)) continue;
    seen.add(r.cardId);
    ids.push(r.cardId);
    if (opts.limit && ids.length >= opts.limit) break;
  }
  return ids;
}

/** Open leeches waiting for a rewrite with Hermes. */
export function leechEntries() { return getEntries({ kind: 'leech', unresolvedOnly: true }); }

/** Headline counts for the study intro + stats. */
export function stats() {
  const rows = getEntries();
  const open = rows.filter((r) => !r.resolved);
  return {
    total: rows.length,
    open: open.length,
    hyper: open.filter((r) => r.hyper && r.kind !== 'leech').length,
    leeches: open.filter((r) => r.kind === 'leech').length,
    resolved: rows.length - open.length,
    subjects: Array.from(new Set(rows.map((r) => r.subject).filter(Boolean))),
  };
}

/** The book as markdown — for Hermes, or for a printed revision sheet. */
export function exportMarkdown(filter) {
  const rows = getEntries(filter);
  const out = ['# Error Book — ' + todayLocalISO(), ''];
  for (const r of rows) {
    out.push('## ' + (r.topicName || r.subject || 'Item') + (r.resolved ? ' (closed)' : ''));
    out.push('- **Q:** ' + r.question);
    out.push('- **I wrote:** ' + (r.given || '(nothing written)'));
    out.push('- **Correct:** ' + r.correct);
    if (stepAddsSomething(r)) out.push('- **The one missing step:** ' + r.missingStep);
    out.push('- **Confidence at the time:** ' + (r.confidence === null ? 'not picked' : r.confidence + '/5'));
    if (r.tags.length) out.push('- **Tags:** ' + r.tags.join(', '));
    out.push('');
  }
  return out.join('\n');
}

/* =============================================================================
   4. SEARCH REGISTRATION
   ========================================================================== */

let searchRegistered = false;

/** Register the error book with the command palette (type: 'error'). */
export function registerErrorBookSearch() {
  if (searchRegistered) return () => {};
  searchRegistered = true;
  return searchIndex.registerProvider(ERRORBOOK_SOURCE, () => getEntries({ limit: 200 }).map((r) => ({
    id: r.id,
    type: 'error',
    title: fmt.truncate(r.question || 'Error book entry', 70),
    subtitle: (r.topicName || r.subject || '') + (r.resolved ? ' · closed' : (r.hyper ? ' · bit you' : '')),
    body: r.given + ' ' + r.correct + ' ' + r.missingStep + ' ' + r.tags.join(' '),
    route: routeFor('study', { mode: 'errors', entry: r.id }),
    icon: r.kind === 'leech' ? 'refresh' : 'circle-alert',
    keywords: ['error book', 'mistake', 'miss'].concat(r.tags),
  })));
}

/* =============================================================================
   5. VIEW SECTION — filters + rows
   ========================================================================== */

const KIND_LABEL = { miss: 'Missed', leech: 'Needs a rewrite', pretest: 'Pretest' };

function entryCard(row, onChange) {
  const card = el('section.card.card--tone', {
    dataset: row.subject ? { subject: subjectSlug(row.subject) } : { tone: 'bad' },
    style: { marginBottom: 'var(--sp-3)' },
  });

  const pills = el('div.chip-row', { style: { marginBottom: 'var(--sp-2)' } },
    el('span.pill', {
      class: row.resolved ? 'pill--mastered' : (row.kind === 'leech' ? 'pill--warn' : 'pill--bad'),
      text: row.resolved ? 'Closed' : (KIND_LABEL[row.kind] || 'Missed'),
    }),
    row.hyper && !row.resolved ? el('span.pill.pill--bad', icon('target', { size: 12 }), el('span', { text: 'Bit you' })) : null,
    row.topicName ? el('span.chip.chip--micro', { text: row.topicName }) : null,
    el('span.chip.chip--micro', { text: fmt.dateShort(row.ts) }),
    row.attempts > 1 ? el('span.chip.chip--micro', { text: row.attempts + ' misses' }) : null);
  card.appendChild(pills);

  const q = el('div.prose', { style: { marginBottom: 'var(--sp-3)' } });
  md(q, row.question || '—');
  card.appendChild(q);

  const grid = el('div.stack', { style: { '--gap': 'var(--sp-2)' } });
  grid.appendChild(field('You wrote', row.given || '(nothing written — a blank is data too)', 'bad'));
  grid.appendChild(field('Correct', row.correct || '—', 'good'));
  if (stepAddsSomething(row)) grid.appendChild(field('The one missing step', row.missingStep, 'warn'));
  grid.appendChild(field('Confidence at the time',
    row.confidence === null ? 'not picked' : row.confidence + ' of 5', 'info'));
  card.appendChild(grid);

  if (row.tags.length) {
    card.appendChild(el('div.chip-row', { style: { marginTop: 'var(--sp-3)' } },
      row.tags.map((t) => el('span.chip.chip--micro', { text: t }))));
  }

  const actions = el('div.btn-row', { style: { marginTop: 'var(--sp-4)' } });
  if (row.kind === 'leech' && !row.resolved) {
    actions.appendChild(el('button.btn.btn-secondary.btn--sm', {
      type: 'button',
      onClick: () => {
        clearRewrite(row.cardId);
        markResolved(row.id, 'rewritten');
        toast('Card released — it comes back in the normal queue.', { tone: 'good' });
        onChange();
      },
    }, icon('refresh', { size: 14 }), 'Rewritten — put it back'));
  }
  if (!row.resolved) {
    actions.appendChild(el('button.btn.btn-ghost.btn--sm', {
      type: 'button',
      onClick: () => { markResolved(row.id, 'closed by hand'); onChange(); },
    }, icon('check', { size: 14 }), 'I own this now'));
  } else {
    actions.appendChild(el('button.btn.btn-ghost.btn--sm', {
      type: 'button',
      onClick: () => { reopen(row.id); onChange(); },
    }, icon('refresh', { size: 14 }), 'It came back — reopen'));
  }
  if (row.topicId) {
    actions.appendChild(el('a.btn.btn-ghost.btn--sm', {
      href: routeFor('topic', { id: row.topicId }),
    }, icon('layers', { size: 14 }), 'Open topic'));
  }
  card.appendChild(actions);
  return card;
}

/**
 * A card with no SolutionChain and no explanation has no step to name, so the
 * runner falls back to the answer's first sentence. Printing that under "the
 * one missing step" would just be the Correct field twice — the row is dropped
 * instead. (The stored value is kept either way: Hermes uses it to write the
 * real step when he rewrites the card.)
 */
function stepAddsSomething(row) {
  const step = String(row.missingStep || '').trim();
  if (!step) return false;
  const correct = String(row.correct || '').trim();
  if (!correct) return true;
  const a = step.replace(/\s+/g, ' ').toLowerCase();
  const b = correct.replace(/\s+/g, ' ').toLowerCase();
  return !(a === b || b.startsWith(a.replace(/[.…]+$/, '')) || a.startsWith(b));
}

function field(label, value, tone) {
  return el('div', { dataset: { tone } },
    el('div.eyebrow', { style: { marginBottom: '2px' } }, el('span', { text: label })),
    el('div', { style: { fontSize: 'var(--fs-body-lg)', lineHeight: 'var(--lh-snug)' }, text: value }));
}

/**
 * The Error Book section, with filters. Mounted inside the Study view and
 * reachable at #/study?mode=errors (and per-entry from search).
 *
 * @param {HTMLElement} host container to render into (cleared)
 * @param {{subject?:string, topicId?:string, focusEntry?:string, compact?:boolean}} [o]
 */
export function renderErrorBook(host, o) {
  const opts = o || {};
  const state = {
    subject: opts.subject || '',
    kind: '',
    unresolvedOnly: true,
    query: '',
  };

  const list = el('div');
  const countLabel = el('span.text-meta');

  const subjects = Array.from(new Set(readAll().map((r) => r.subject).filter(Boolean))).sort();

  const search = el('input.input', {
    type: 'search',
    placeholder: 'Search your misses…',
    attrs: { 'aria-label': 'Search the error book' },
    on: { input: () => { state.query = search.value; paint(); } },
  });

  const chip = (label, active, onClick) => el('button.chip.chip--button', {
    type: 'button',
    class: active ? 'is-active' : '',
    attrs: { 'aria-pressed': active ? 'true' : 'false' },
    onClick,
  }, el('span', { text: label }));

  const filters = el('div.chip-row', { style: { marginBottom: 'var(--sp-3)' } });

  function paintFilters() {
    filters.replaceChildren();
    filters.appendChild(chip(state.unresolvedOnly ? 'Open only' : 'All rows', state.unresolvedOnly, () => {
      state.unresolvedOnly = !state.unresolvedOnly;
      paint();
    }));
    filters.appendChild(chip('Bit me', state.kind === 'hyper', () => {
      state.kind = state.kind === 'hyper' ? '' : 'hyper';
      paint();
    }));
    filters.appendChild(chip('Needs a rewrite', state.kind === 'leech', () => {
      state.kind = state.kind === 'leech' ? '' : 'leech';
      paint();
    }));
    for (const s of subjects) {
      filters.appendChild(chip(s, state.subject === s, () => {
        state.subject = state.subject === s ? '' : s;
        paint();
      }));
    }
  }

  function paint() {
    paintFilters();
    const rows = getEntries({
      subject: state.subject || undefined,
      topicId: opts.topicId || undefined,
      kind: state.kind === 'leech' ? 'leech' : undefined,
      hyperOnly: state.kind === 'hyper' || undefined,
      unresolvedOnly: state.unresolvedOnly || undefined,
      query: state.query || undefined,
      limit: opts.compact ? 3 : 60,
    });
    countLabel.textContent = rows.length + ' ' + fmt.plural(rows.length, 'row');
    list.replaceChildren();
    if (!rows.length) {
      list.appendChild(emptyState({
        icon: 'circle-check',
        title: state.query ? 'Nothing matches that' : 'No open errors',
        body: state.query
          ? 'Try a shorter search.'
          : 'Every miss lands here automatically with the one step that was missing. Nothing open right now.',
      }));
      return;
    }
    for (const r of rows) {
      const node = entryCard(r, paint);
      if (opts.focusEntry && r.id === opts.focusEntry) {
        node.style.outline = '2px solid rgb(var(--brand-rgb) / 0.6)';
        node.style.outlineOffset = '2px';
        setTimeout(() => node.scrollIntoView({ block: 'center', behavior: 'auto' }), 30);
      }
      list.appendChild(node);
    }
  }

  const head = el('div.section-head',
    el('div',
      el('h2.section-head__title.row', icon('circle-alert', { size: 16 }), el('span', { text: 'Error Book' })),
      el('p.section-head__sub', { text: 'Every miss, with the one step that was missing.' })),
    el('div.section-head__actions', countLabel));

  const tools = el('div.stack', { style: { '--gap': 'var(--sp-3)', marginBottom: 'var(--sp-4)' } },
    search, filters);

  host.replaceChildren(el('section.section', head, tools, list));
  paint();
  return { refresh: paint };
}

export default {
  addMiss, addLeech, noteCorrect, markResolved, reopen, setNote,
  getEntries, hypercorrectionCardIds, leechEntries, stats,
  renderErrorBook, registerErrorBookSearch, exportMarkdown,
};
