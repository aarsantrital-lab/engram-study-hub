/* =============================================================================
   js/chat/messages.js — Job CHAT. The message pane.

   Discord message blocks:
     · header row = avatar + display name + title chip + timestamp
     · consecutive messages from the same author within 5 minutes are grouped
       (no avatar, no header, timestamp in the gutter on hover)
     · reply quotes that jump to the original
     · reactions with counts and a curated picker
     · pins + a pinned drawer
     · day dividers, typing indicator, "new messages" jump button
     · infinite scroll-back through range queries

   COLUMN NAMES COME FROM supabase/schema.sql AND NOTHING ELSE:
     messages(id, channel_id, author, content, reply_to, attachment_path,
              attachment_meta jsonb, pinned, deleted, edited_at, created_at)
     reactions(id, message_id, author, emoji)   — a separate table, not a column
   A "system" post (celebration) is an ordinary row whose attachment_meta
   carries {system:'celebration'}; the schema has no is_system column and this
   file must not invent one.

   Every piece of user text goes through md.js. There is no innerHTML here.
   All day maths uses store.js's LOCAL helpers (Nepal is UTC+05:45).
   ========================================================================== */

import { el, icon, fmt, on, toast, clear, prefersReducedMotion, throttle } from '../dom.js';
import { renderMarkdownInto, stripMarkdown } from '../md.js';
import { dayKeyFromTs, todayLocalISO, addDaysISO } from '../store.js';
import { attachmentCard } from './attachments.js';
import { messageAdminActions } from './admin.js';

/** Same author + within this window + no reply = one visual block. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** messages_guard_update() refuses a content change after 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
const PAGE_SIZE = 40;
const NEAR_BOTTOM_PX = 140;

/** Curated reaction set — study-shaped, no skin-tone variants to argue about. */
export const REACTIONS = [
  '👍', '❤️', '🔥', '😂', '😮', '😢', '🙌', '👏',
  '✅', '❌', '💯', '🧠', '📖', '✍️', '⚡', '🎯',
  '🏆', '⭐', '🤔', '😅', '🫡', '💀', '🧪', '📐',
];
const QUICK_REACTIONS = ['👍', '🔥', '🧠'];

/** Per-author accent, picked from the subject tokens. Never a raw colour. */
const AVATAR_TONES = [
  '--sub-physics', '--sub-chem', '--sub-math', '--sub-cs',
  '--sub-english', '--sub-nepali', '--info', '--ai',
];

function toneFor(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function accentStyle(id) {
  const t = toneFor(id);
  return { '--accent': 'var(' + t + ')', '--accent-rgb': 'var(' + t + '-rgb)' };
}

/* ---------------------------------------------------------------------------
   Row helpers — jsonb arrives as an object, but be forgiving about strings.
   ------------------------------------------------------------------------ */

function asJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  return fallback;
}

export const authorOf = (row) => (row && row.author) || null;
export const contentOf = (row) => String((row && row.content) || '');
export const isDeleted = (row) => Boolean(row && row.deleted);
export const metaOf = (row) => asJson(row && row.attachment_meta, {}) || {};
export const systemKindOf = (row) => {
  const m = metaOf(row);
  return m && typeof m.system === 'string' ? m.system : null;
};
export const isSystem = (row) => Boolean(systemKindOf(row));

/** The one attachment a message may carry, or null. */
export function attachmentOf(row) {
  const path = row && row.attachment_path;
  if (!path) return null;
  const m = metaOf(row);
  return {
    path,
    kind: m.kind || (/^image\//.test(String(m.type || '')) ? 'image' : 'file'),
    name: m.name || String(path).split('/').pop(),
    type: m.type || '',
    size: Number(m.size) || 0,
    width: Number(m.width) || 0,
    height: Number(m.height) || 0,
  };
}

export const tsOf = (row) => {
  const raw = row && row.created_at;
  if (typeof raw === 'number') return raw;
  const n = Date.parse(String(raw || ''));
  return Number.isFinite(n) ? n : Date.now();
};

/**
 * One flat line of a message, for a reply quote or the pinned drawer.
 * Spoilers are REDACTED, not just unwrapped: a preview that prints the hidden
 * answer in plain text is worse than no spoiler at all — the whole point of
 * ||…|| in a study chat is that the answer stays covered until you have tried.
 */
export function previewText(row) {
  const redacted = contentOf(row).replace(/\|\|[\s\S]*?\|\|/g, '⟨spoiler⟩');
  return stripMarkdown(redacted).replace(/\s+/g, ' ').trim();
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}

/** 'Today' / 'Yesterday' / '26 July 2026' for a day divider. */
function dayLabel(dayKey) {
  const today = todayLocalISO();
  if (dayKey === today) return 'Today';
  if (dayKey === addDaysISO(today, -1)) return 'Yesterday';
  return fmt.dateLong(dayKey);
}

/* ===========================================================================
   The pane
   ======================================================================== */

/**
 * @param {object} hub context from views/chat.js
 * @param {{onReply:Function, onEdit:Function}} opts
 */
export function createMessagePane(hub, opts) {
  const o = opts || {};

  const state = {
    channelId: null,
    rows: [],                 // ascending by created_at
    byId: new Map(),          // id -> row
    nodes: new Map(),         // id -> element
    offset: 0,                // range cursor for scroll-back
    hasMore: true,
    loading: false,
    pending: new Map(),       // tempId -> element
    typing: [],
    pinsOpen: false,
    destroyed: false,
  };

  const offs = [];
  let closePopover = null;

  /* ------------------------------------------------------------- structure */

  const list = el('div.msg-list', { attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' } });
  const topSentinel = el('div.ch__top');
  const typingBar = el('div.ch__typing', { hidden: true });
  const scroller = el('div.ch__scroll', { attrs: { tabindex: '0' } }, topSentinel, list);
  const jumpBtn = el('button.ch-jump', {
    type: 'button', hidden: true, onClick: () => stickToBottom(true),
  }, icon('chevron-down', { size: 14 }), el('span', { text: 'New messages' }));

  const pinsDrawer = el('div.ch-pins', { hidden: true });
  const root = el('div.ch__body', pinsDrawer, scroller, jumpBtn, typingBar);

  /* ------------------------------------------------------------- scrolling */

  const nearBottom = () =>
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;

  function stickToBottom(smooth) {
    const behavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
    try { scroller.scrollTo({ top: scroller.scrollHeight, behavior }); }
    catch (_) { scroller.scrollTop = scroller.scrollHeight; }
    jumpBtn.hidden = true;
  }

  const onScroll = throttle(() => {
    if (state.destroyed) return;
    if (nearBottom()) jumpBtn.hidden = true;
    if (scroller.scrollTop < 240 && state.hasMore && !state.loading) loadMore();
  }, 120);
  offs.push(on(scroller, 'scroll', onScroll, { passive: true }));

  /* ----------------------------------------------------------------- fetch */

  function sortRows() {
    state.rows.sort((a, b) => {
      const d = tsOf(a) - tsOf(b);
      return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
    });
  }

  function ingest(rows) {
    let added = 0;
    for (const row of rows || []) {
      if (!row || row.id == null) continue;
      if (state.byId.has(row.id)) { Object.assign(state.byId.get(row.id), row); continue; }
      state.byId.set(row.id, row);
      state.rows.push(row);
      added += 1;
    }
    if (added) sortRows();
    return added;
  }

  /** First page for a channel. */
  async function load(channelId) {
    state.channelId = channelId;
    state.rows = [];
    state.byId.clear();
    state.nodes.clear();
    state.pending.clear();
    state.offset = 0;
    state.hasMore = true;
    state.typing = [];
    renderTyping();
    renderSkeleton();

    const rows = await fetchPage(0);
    if (state.channelId !== channelId || state.destroyed) return;
    ingest(rows);
    state.offset = rows.length;
    state.hasMore = rows.length >= PAGE_SIZE;
    await hydrate(rows);
    if (state.channelId !== channelId || state.destroyed) return;
    renderAll();
    stickToBottom(false);
    refreshPins();
  }

  /** Reactions + signed attachment links for a freshly fetched page. */
  async function hydrate(rows) {
    const ids = (rows || []).map((r) => r.id);
    await Promise.all([
      hub.loadReactions(ids),
      hub.ensureAttachmentUrls(rows || []),
    ]);
  }

  async function fetchPage(offset) {
    state.loading = true;
    const res = await hub.db.select('messages', {
      filters: { channel_id: state.channelId },
      order: { column: 'created_at', ascending: false },
      range: [offset, offset + PAGE_SIZE - 1],
    });
    state.loading = false;
    if (res.error) {
      hub.err(res.error, 'Messages could not be loaded.');
      state.hasMore = false;
      return [];
    }
    return Array.isArray(res.data) ? res.data.slice() : [];
  }

  /** Older page, keeping the scroll position exactly where it was. */
  async function loadMore() {
    if (!state.hasMore || state.loading || !state.channelId) return 0;
    topSentinel.replaceChildren(el('div.ch__loading',
      icon('loader', { size: 14, cls: 'icon-spin' }),
      el('span', { text: 'Loading earlier messages' })));

    const before = scroller.scrollHeight;
    const rows = await fetchPage(state.offset);
    topSentinel.replaceChildren();
    if (state.destroyed) return 0;

    const added = ingest(rows);
    state.offset += rows.length;
    state.hasMore = rows.length >= PAGE_SIZE;
    if (!added) {
      if (!state.hasMore) topSentinel.replaceChildren(el('div.ch__start', { text: 'This is the beginning of the channel.' }));
      return 0;
    }
    await hydrate(rows);
    renderAll();
    scroller.scrollTop += scroller.scrollHeight - before;
    return added;
  }

  /* --------------------------------------------------------------- render */

  function renderSkeleton() {
    clear(list);
    const bone = (w, h) => el('span.skeleton.ch-bone', { style: { width: w, height: h + 'px' } });
    for (let i = 0; i < 6; i += 1) {
      list.appendChild(el('div.msg',
        el('span.msg__avatar.skeleton'),
        el('div.msg__head', bone('92px', 13)),
        el('div.msg__body', bone((44 + (i % 3) * 18) + '%', 12))));
    }
  }

  function isContinuation(row, prev) {
    if (!prev) return false;
    if (isSystem(row) || isSystem(prev)) return false;
    if (row.reply_to) return false;
    if (authorOf(row) !== authorOf(prev)) return false;
    if (dayKeyFromTs(tsOf(row)) !== dayKeyFromTs(tsOf(prev))) return false;
    return tsOf(row) - tsOf(prev) < GROUP_WINDOW_MS;
  }

  function renderAll() {
    clear(list);
    state.nodes.clear();
    let prev = null;
    let prevDay = null;
    const frag = document.createDocumentFragment();

    for (const row of state.rows) {
      const day = dayKeyFromTs(tsOf(row));
      if (day !== prevDay) {
        frag.appendChild(el('div.msg-divider', { text: dayLabel(day) }));
        prevDay = day;
        prev = null;                                   // a divider always breaks the block
      }
      const node = buildMessage(row, prev);
      frag.appendChild(node);
      state.nodes.set(row.id, node);
      prev = row;
    }

    if (!state.rows.length) {
      frag.appendChild(el('div.ch__empty',
        icon('message-circle', { size: 24 }),
        el('p.ch__empty-title', { text: 'Nothing here yet' }),
        el('p.text-meta', { text: 'Say the first thing.' })));
    }
    list.appendChild(frag);
    state.pending.forEach((node) => list.appendChild(node));
    if (!state.hasMore) topSentinel.replaceChildren(el('div.ch__start', { text: 'This is the beginning of the channel.' }));
  }

  /* ------------------------------------------------------- one message block */

  function buildMessage(row, prev) {
    const cont = isContinuation(row, prev);
    const ts = tsOf(row);
    const me = hub.user();
    const authorId = authorOf(row);
    const mine = Boolean(me && authorId === me.id);
    const deleted = isDeleted(row);
    const system = isSystem(row);

    const node = el('div.msg', {
      dataset: { id: String(row.id), author: String(authorId || '') },
      style: system ? null : accentStyle(authorId),
      class: [cont ? 'msg--cont' : '', mine ? 'msg--me' : '', system ? 'msg--system' : ''].filter(Boolean).join(' '),
    });

    if (system) return buildSystem(node, row, ts);

    if (row.reply_to) node.appendChild(buildReplyQuote(row));

    if (!cont) node.appendChild(buildAvatar(authorId));
    else node.appendChild(el('span.msg__stamp', { text: fmt.time(ts) }));

    if (!cont) {
      const prof = hub.profile(authorId) || {};
      node.appendChild(el('div.msg__head',
        el('button.msg__author.ch-name', {
          type: 'button',
          onClick: (e) => hub.openProfile(authorId, e.currentTarget),
        }, hub.displayName(authorId)),
        prof.title ? el('span.msg__tag', { text: String(prof.title).slice(0, 40) }) : null,
        prof.is_admin ? el('span.msg__tag.ch-tag--admin', icon('shield', { size: 12 }), 'Admin') : null,
        el('time.msg__time', { attrs: { datetime: new Date(ts).toISOString() }, text: fmt.time(ts) }),
        row.pinned ? el('span.ch-pinmark', { attrs: { title: 'Pinned' } }, icon('pin', { size: 12 })) : null));
    }

    const body = el('div.msg__body');
    if (deleted) {
      body.classList.add('ch-deleted');
      body.append(icon('trash', { size: 12 }), el('span', { text: 'This message was deleted.' }));
    } else {
      const text = contentOf(row);
      if (text) renderMarkdownInto(body, text);
      if (row.edited_at) {
        body.appendChild(el('span.ch-edited', {
          text: ' (edited)',
          attrs: { title: 'Edited ' + fmt.time(Date.parse(row.edited_at)) },
        }));
      }
    }
    node.appendChild(body);

    if (!deleted) {
      const col = el('div.msg__col');
      const att = attachmentOf(row);
      if (att) {
        col.appendChild(el('div.ch-att-row', attachmentCard({
          kind: att.kind, name: att.name, type: att.type, size: att.size,
          width: att.width, height: att.height,
          url: hub.cachedAttachmentUrl(att.path),
          resolve: () => hub.attachmentUrl(att.path),
        })));
      }
      const rx = buildReactions(row);
      if (rx) col.appendChild(rx);
      if (col.childNodes.length) node.appendChild(col);
      node.appendChild(buildActions(row, mine, ts));
    }

    wireMessageGestures(node, row, mine, ts);
    return node;
  }

  function buildSystem(node, row, ts) {
    node.classList.add('ch-sys');
    const kind = systemKindOf(row) || 'note';
    node.dataset.tone = kind === 'celebration' ? 'good' : 'info';
    node.appendChild(el('span.msg__avatar.ch-sys__mark',
      icon(kind === 'celebration' ? 'trophy' : 'sparkles', { size: 16 })));
    node.appendChild(el('div.msg__head',
      el('span.msg__author', { text: 'Engram' }),
      el('span.msg__tag', { text: kind === 'celebration' ? 'Milestone' : 'System' }),
      el('time.msg__time', { text: fmt.time(ts) })));
    const body = el('div.msg__body');
    renderMarkdownInto(body, contentOf(row));
    node.appendChild(body);
    return node;
  }

  function buildAvatar(userId) {
    const prof = hub.profile(userId) || {};
    const name = hub.displayName(userId);
    const status = hub.presenceOf(userId);
    const avatar = el('button.msg__avatar.ch-avatar', {
      type: 'button',
      attrs: { 'aria-label': 'Profile of ' + name },
      onClick: (e) => hub.openProfile(userId, e.currentTarget),
    });
    const src = hub.avatarUrl(prof);
    if (src) avatar.appendChild(el('img.ch-avatar__img', { attrs: { src, alt: '', loading: 'lazy', decoding: 'async' } }));
    else avatar.appendChild(el('span', { text: initialsOf(name) }));
    if (status) {
      const meta = hub.statusMeta(status);
      avatar.appendChild(el('span.dot.ch-status', {
        dataset: { tone: meta.tone },
        attrs: { title: meta.label + (meta.note ? ' — ' + meta.note : '') },
      }));
    }
    return avatar;
  }

  function buildReplyQuote(row) {
    const target = state.byId.get(row.reply_to);
    const authorId = target ? authorOf(target) : null;
    const name = authorId ? hub.displayName(authorId) : 'a message';
    const text = target
      ? (isDeleted(target) ? 'message deleted' : (previewText(target) || 'attachment'))
      : 'Jump to the original';

    return el('button.ch-reply', {
      type: 'button',
      attrs: { 'aria-label': 'Jump to the replied message' },
      style: authorId ? accentStyle(authorId) : null,
      onClick: () => jumpTo(row.reply_to),
    },
    icon('reply', { size: 12 }),
    el('span.ch-reply__who', { text: name }),
    el('span.ch-reply__text.truncate', { text: fmt.truncate(text, 120) }));
  }

  function buildReactions(row) {
    const map = hub.reactionsFor(row.id);
    const keys = Object.keys(map).filter((k) => map[k] && map[k].length);
    const me = hub.user();
    if (!keys.length) return null;
    const bar = el('div.ch-rxns');
    keys.sort();
    for (const emoji of keys) {
      const users = map[emoji];
      const mine = Boolean(me && users.indexOf(me.id) >= 0);
      const who = users.map((u) => hub.displayName(u)).slice(0, 6).join(', ');
      bar.appendChild(el('button.ch-rxn', {
        type: 'button',
        class: mine ? 'is-mine' : '',
        attrs: { 'aria-pressed': mine ? 'true' : 'false', title: who + ' reacted with ' + emoji },
        onClick: () => hub.toggleReaction(row, emoji),
      }, el('span.ch-rxn__e', { text: emoji }), el('span.ch-rxn__n.tabular', { text: String(users.length) })));
    }
    bar.appendChild(el('button.ch-rxn.ch-rxn--add', {
      type: 'button', attrs: { 'aria-label': 'Add a reaction' },
      onClick: (e) => openEmojiPicker(e.currentTarget, (emoji) => hub.toggleReaction(row, emoji)),
    }, icon('smile', { size: 14 })));
    return bar;
  }

  /** Repaint only the reaction bar of one message (realtime reaction events). */
  function refreshReactions(messageId) {
    const row = state.byId.get(messageId);
    const node = state.nodes.get(messageId);
    if (!row || !node) return;
    let col = node.querySelector('.msg__col');
    const existing = node.querySelector('.ch-rxns');
    const fresh = buildReactions(row);
    if (existing) {
      if (fresh) existing.replaceWith(fresh);
      else existing.remove();
      return;
    }
    if (!fresh) return;
    if (!col) {
      col = el('div.msg__col');
      const actions = node.querySelector('.msg__actions');
      if (actions) node.insertBefore(col, actions);
      else node.appendChild(col);
    }
    col.appendChild(fresh);
  }

  /* ------------------------------------------------------------- actions */

  function actionButton(iconName, label, run, tone) {
    return el('button.btn.btn-ghost.btn-icon.btn--sm.ch-act', {
      type: 'button',
      dataset: tone ? { tone } : null,
      attrs: { 'aria-label': label, title: label },
      onClick: (e) => { e.stopPropagation(); run(e); },
    }, icon(iconName, { size: 14 }));
  }

  const canEdit = (mine, ts) => mine && (Date.now() - ts) < EDIT_WINDOW_MS;

  function buildActions(row, mine, ts) {
    const bar = el('div.msg__actions');
    for (const emoji of QUICK_REACTIONS) {
      bar.appendChild(el('button.btn.btn-ghost.btn-icon.btn--sm.ch-act.ch-act--emoji', {
        type: 'button', attrs: { 'aria-label': 'React ' + emoji, title: 'React ' + emoji },
        onClick: (e) => { e.stopPropagation(); hub.toggleReaction(row, emoji); },
      }, el('span', { text: emoji })));
    }
    bar.appendChild(actionButton('smile', 'Pick a reaction',
      (e) => openEmojiPicker(e.currentTarget, (emoji) => hub.toggleReaction(row, emoji))));
    bar.appendChild(actionButton('reply', 'Reply', () => o.onReply && o.onReply(row)));
    if (canEdit(mine, ts)) bar.appendChild(actionButton('edit', 'Edit', () => o.onEdit && o.onEdit(row)));
    if (mine || hub.isAdmin()) bar.appendChild(actionButton('trash', 'Delete', () => hub.deleteMessage(row), 'bad'));
    if (hub.isAdmin()) {
      bar.appendChild(actionButton(row.pinned ? 'x' : 'pin', row.pinned ? 'Unpin' : 'Pin',
        () => hub.togglePin(row, !row.pinned)));
      if (!mine) bar.appendChild(actionButton('shield', 'Moderate', () => openActionSheet(row, mine, ts)));
    }
    return bar;
  }

  /** Long-press anywhere on a message opens the same actions as a sheet. */
  function wireMessageGestures(node, row, mine, ts) {
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const cancel = () => { if (timer) { clearTimeout(timer); timer = 0; } };

    node.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest && e.target.closest('button, a, input, textarea, .md-spoiler')) return;
      fired = false;
      startX = e.clientX; startY = e.clientY;
      cancel();
      timer = setTimeout(() => { fired = true; openActionSheet(row, mine, ts); }, 480);
    });
    node.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancel();
    });
    node.addEventListener('pointerup', cancel);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('contextmenu', (e) => { if (fired) e.preventDefault(); });
    node.addEventListener('click', (e) => {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);
  }

  function openActionSheet(row, mine, ts) {
    const items = [];
    items.push({ icon: 'smile', label: 'Add reaction', run: () => openEmojiSheet(row) });
    items.push({ icon: 'reply', label: 'Reply', run: () => o.onReply && o.onReply(row) });
    if (contentOf(row)) {
      items.push({
        icon: 'copy',
        label: 'Copy text',
        run: async () => {
          try { await navigator.clipboard.writeText(contentOf(row)); toast('Copied', { tone: 'good' }); }
          catch (_) { toast('Copying is blocked in this browser', { tone: 'info' }); }
        },
      });
    }
    if (canEdit(mine, ts)) items.push({ icon: 'edit', label: 'Edit message', run: () => o.onEdit && o.onEdit(row) });
    else if (mine) items.push({ icon: 'clock', label: 'Too late to edit (15 min)', run: () => toast('Messages can be edited for 15 minutes.', { tone: 'info' }) });
    if (mine || hub.isAdmin()) items.push({ icon: 'trash', label: 'Delete message', tone: 'bad', run: () => hub.deleteMessage(row) });
    if (hub.isAdmin()) {
      items.push({ icon: 'pin', label: row.pinned ? 'Unpin from channel' : 'Pin to channel', run: () => hub.togglePin(row, !row.pinned) });
      if (!mine) items.push(...messageAdminActions(hub, row));
    }
    hub.ui.actionSheet({ title: hub.displayName(authorOf(row)), items });
  }

  /* --------------------------------------------------------- emoji picker */

  function emojiGrid(onPick) {
    const grid = el('div.ch-emoji__grid', { attrs: { role: 'group', 'aria-label': 'Reactions' } });
    for (const emoji of REACTIONS) {
      grid.appendChild(el('button.ch-emoji__btn', {
        type: 'button', attrs: { 'aria-label': 'React ' + emoji },
        onClick: () => onPick(emoji),
      }, el('span', { text: emoji })));
    }
    return grid;
  }

  function openEmojiPicker(anchor, pick) {
    if (closePopover) { closePopover(); closePopover = null; }
    const panel = el('div.ch-emoji', emojiGrid((emoji) => {
      pick(emoji);
      if (closePopover) { closePopover(); closePopover = null; }
    }));
    closePopover = hub.ui.popover(anchor, panel);
  }

  function openEmojiSheet(row) {
    const close = hub.ui.sheet({
      title: 'Add a reaction',
      body: emojiGrid((emoji) => { hub.toggleReaction(row, emoji); close(); }),
    });
  }

  /* ------------------------------------------------------------- realtime */

  async function applyInsert(row) {
    if (!row || row.channel_id !== state.channelId) return;
    if (state.byId.has(row.id)) { applyUpdate(row); return; }

    const wasNear = nearBottom();
    const prev = state.rows[state.rows.length - 1] || null;
    state.byId.set(row.id, row);
    state.rows.push(row);
    state.offset += 1;

    if (row.attachment_path) await hub.ensureAttachmentUrls([row]);

    const day = dayKeyFromTs(tsOf(row));
    const prevDay = prev ? dayKeyFromTs(tsOf(prev)) : null;
    if (day !== prevDay) list.appendChild(el('div.msg-divider', { text: dayLabel(day) }));

    const node = buildMessage(row, day === prevDay ? prev : null);
    state.nodes.set(row.id, node);
    list.appendChild(node);
    state.pending.forEach((p) => list.appendChild(p));

    const me = hub.user();
    const mine = Boolean(me && authorOf(row) === me.id);
    if (wasNear || mine) stickToBottom(true);
    else jumpBtn.hidden = false;

    if (systemKindOf(row) === 'celebration') hub.ui.confetti();
    if (row.pinned) refreshPins();
  }

  function applyUpdate(row) {
    if (!row || row.id == null) return;
    const existing = state.byId.get(row.id);
    if (!existing) {
      if (row.channel_id === state.channelId) applyInsert(row);
      return;
    }
    const wasPinned = Boolean(existing.pinned);
    Object.assign(existing, row);
    const node = state.nodes.get(row.id);
    if (!node) return;
    const idx = state.rows.indexOf(existing);
    const prev = idx > 0 ? state.rows[idx - 1] : null;
    const sameDay = prev && dayKeyFromTs(tsOf(prev)) === dayKeyFromTs(tsOf(existing));
    const fresh = buildMessage(existing, sameDay ? prev : null);
    node.replaceWith(fresh);
    state.nodes.set(row.id, fresh);
    if (wasPinned !== Boolean(existing.pinned)) refreshPins();
  }

  function applyDelete(row) {
    if (!row || row.id == null) return;
    const existing = state.byId.get(row.id);
    if (!existing) return;
    const node = state.nodes.get(row.id);
    state.byId.delete(row.id);
    const i = state.rows.indexOf(existing);
    if (i >= 0) state.rows.splice(i, 1);
    state.nodes.delete(row.id);
    if (node) node.remove();
  }

  /* ------------------------------------------------- optimistic (pending) */

  function addPending(tempId, draft) {
    const me = hub.user();
    const row = {
      id: tempId,
      channel_id: state.channelId,
      author: me ? me.id : null,
      content: draft.body,
      attachment_path: null,
      attachment_meta: null,
      reply_to: draft.replyTo || null,
      created_at: new Date().toISOString(),
    };
    const prev = state.rows[state.rows.length - 1] || null;
    const node = buildMessage(row, isContinuation(row, prev) ? prev : null);
    node.classList.add('msg--pending');
    node.querySelectorAll('.msg__actions').forEach((n) => n.remove());
    if (draft.attachment) {
      const col = node.querySelector('.msg__col') || el('div.msg__col');
      if (!col.isConnected) node.appendChild(col);
      col.appendChild(el('div.ch-att-row', attachmentCard(draft.attachment)));
    }
    node.appendChild(el('span.ch-pending', icon('loader', { size: 12, cls: 'icon-spin' })));
    state.pending.set(tempId, node);
    list.appendChild(node);
    stickToBottom(true);
    return node;
  }

  function setPendingProgress(tempId, fraction, label) {
    const node = state.pending.get(tempId);
    if (!node) return;
    let bar = node.querySelector('.ch-pending__bar');
    if (!bar) { bar = el('span.ch-pending__bar'); node.appendChild(bar); }
    bar.style.setProperty('--ch-p', Math.round((fraction || 0) * 100) + '%');
    bar.setAttribute('title', label || 'Sending');
  }

  function resolvePending(tempId, row) {
    const node = state.pending.get(tempId);
    state.pending.delete(tempId);
    if (node) node.remove();
    if (row) applyInsert(row);
  }

  function failPending(tempId, message) {
    const node = state.pending.get(tempId);
    if (!node) return;
    node.classList.remove('msg--pending');
    node.classList.add('msg--failed');
    const spin = node.querySelector('.ch-pending');
    if (spin) spin.remove();
    const body = node.querySelector('.msg__body');
    if (body) body.appendChild(el('div.ch-failed', icon('alert-triangle', { size: 12 }), el('span', { text: message || 'Not sent' })));
    setTimeout(() => {
      const n = state.pending.get(tempId);
      if (n) { n.remove(); state.pending.delete(tempId); }
    }, 6000);
  }

  /* ---------------------------------------------------------------- typing */

  function setTyping(names) {
    state.typing = Array.isArray(names) ? names : [];
    renderTyping();
  }

  function renderTyping() {
    const names = state.typing;
    if (!names.length) { typingBar.hidden = true; typingBar.replaceChildren(); return; }
    let text;
    if (names.length === 1) text = names[0] + ' is typing…';
    else if (names.length === 2) text = names[0] + ' and ' + names[1] + ' are typing…';
    else text = 'Several people are typing…';
    typingBar.hidden = false;
    typingBar.replaceChildren(
      el('span.typing', el('span.typing__dot'), el('span.typing__dot'), el('span.typing__dot')),
      el('span.ch__typing-text', { text })
    );
  }

  /* ------------------------------------------------------------------ pins */

  async function refreshPins() {
    if (!state.channelId) return [];
    const res = await hub.db.select('messages', {
      filters: { channel_id: state.channelId, pinned: true },
      order: { column: 'created_at', ascending: false },
      limit: 50,
    });
    const rows = res.error ? [] : (res.data || []);
    hub.setPinCount(rows.length);
    if (state.pinsOpen) renderPins(rows);
    return rows;
  }

  function renderPins(rows) {
    pinsDrawer.replaceChildren(
      el('div.ch-pins__head',
        el('span.eyebrow.eyebrow--dot', el('span', { text: 'Pinned' })),
        el('button.btn.btn-ghost.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Close pinned messages' }, onClick: () => togglePins(false),
        }, icon('x', { size: 14 })))
    );
    if (!rows.length) {
      pinsDrawer.appendChild(el('p.text-meta.ch-pins__empty', {
        text: 'Nothing pinned yet. An admin can pin the messages worth keeping.',
      }));
      return;
    }
    for (const row of rows) {
      pinsDrawer.appendChild(el('div.ch-pins__item', { style: accentStyle(authorOf(row)) },
        el('button.ch-pins__go', {
          type: 'button', onClick: () => { togglePins(false); jumpTo(row.id); },
        },
        el('span.ch-pins__who', { text: hub.displayName(authorOf(row)) }),
        el('span.ch-pins__text.clamp-2', { text: previewText(row) || '(attachment)' }),
        el('span.text-meta', { text: fmt.rel(tsOf(row)) })),
        hub.isAdmin()
          ? el('button.btn.btn-ghost.btn-icon.btn--sm', {
            type: 'button', attrs: { 'aria-label': 'Unpin' },
            onClick: async () => { await hub.togglePin(row, false); renderPins(await refreshPins()); },
          }, icon('x', { size: 14 }))
          : null));
    }
  }

  async function togglePins(next) {
    const open = next === undefined ? !state.pinsOpen : Boolean(next);
    state.pinsOpen = open;
    pinsDrawer.hidden = !open;
    if (open) {
      pinsDrawer.replaceChildren(el('div.ch__loading', icon('loader', { size: 14, cls: 'icon-spin' })));
      renderPins(await refreshPins());
    }
  }

  /* ------------------------------------------------------------------ jump */

  async function jumpTo(messageId) {
    if (!messageId) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const node = state.nodes.get(messageId);
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        node.classList.add('is-flash');
        setTimeout(() => node.classList.remove('is-flash'), 1400);
        return;
      }
      if (!state.hasMore) break;
      /* eslint-disable no-await-in-loop */
      const added = await loadMore();
      /* eslint-enable no-await-in-loop */
      if (!added) break;
    }
    toast('That message is further back than the loaded history.', { tone: 'info' });
  }

  /* ---------------------------------------------------------------- public */

  function lastOwnMessage() {
    const me = hub.user();
    if (!me) return null;
    for (let i = state.rows.length - 1; i >= 0; i -= 1) {
      const row = state.rows[i];
      if (authorOf(row) === me.id && !isDeleted(row) && !isSystem(row)) return row;
    }
    return null;
  }

  function destroy() {
    state.destroyed = true;
    if (closePopover) { closePopover(); closePopover = null; }
    offs.forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
    root.remove();
  }

  return {
    el: root,
    scroller,
    load,
    loadMore,
    applyInsert,
    applyUpdate,
    applyDelete,
    refreshReactions,
    addPending,
    setPendingProgress,
    resolvePending,
    failPending,
    setTyping,
    togglePins,
    refreshPins,
    jumpTo,
    stickToBottom,
    lastOwnMessage,
    hasRow: (id) => state.byId.has(id),
    rowById: (id) => state.byId.get(id) || null,
    destroy,
  };
}

export default { createMessagePane, REACTIONS, EDIT_WINDOW_MS, previewText };
