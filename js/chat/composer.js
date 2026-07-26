/* =============================================================================
   js/chat/composer.js — Job CHAT.

   The message box: auto-growing textarea, Enter-to-send / Shift+Enter newline,
   attachments (button, paste, drag-drop), reply and edit banners, the character
   counter, and the send cooldown.

   COOLDOWN UX (the thing this file exists for)
     After every successful send the send button is disabled for
     CONFIG.LIMITS.cooldownSec and a circular countdown drains around it. If the
     SERVER pushes back with {retryAfterSec} we adopt that number instead and
     say so kindly — never a red error, never "rate limited".
     Under prefers-reduced-motion the ring steps once per second instead of
     animating per frame.

   Imports: config.js, dom.js, ./attachments.js. Talks to the backend only
   through the `hub` object built by views/chat.js.
   ========================================================================== */

import CONFIG from '../config.js';
import { el, icon, fmt, on, toast, prefersReducedMotion, debounce, clamp } from '../dom.js';
import { stripMarkdown } from '../md.js';
import { prepareFile, attachmentCard } from './attachments.js';

/** supabase/schema.sql gives a message ONE attachment_path — so one file. */
const MAX_ATTACHMENTS = 1;

/* Canonical message columns (supabase/schema.sql): author / content /
   attachment_path + attachment_meta. The alias columns author_id / body /
   attachments[] exist too, but ONLY the canonical ones carry the constraints
   and the foreign keys — and only the canonical ones are present on the
   optimistic rows this file is handed before a send has come back. */
const authorOf = (row) => (row && row.author) || null;
const contentOf = (row) => String((row && row.content) || '');

/** jsonb arrives decoded, but a stray string should not throw. */
function asJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  return fallback;
}

/** The file name of the one attachment a message may carry, or ''. */
function attachmentNameOf(row) {
  const path = row && row.attachment_path;
  if (!path) return '';
  const meta = asJson(row && row.attachment_meta, {}) || {};
  return String(meta.name || String(path).split('/').pop() || 'attachment');
}

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

/**
 * @param {object} hub  the chat context built by views/chat.js
 * @param {{onSend:Function, onEditSave:Function, onHeightChange?:Function}} opts
 * @returns {{el:HTMLElement, focus:Function, destroy:Function, setReply:Function,
 *            startEdit:Function, cancelEdit:Function, setChannelState:Function,
 *            insertText:Function, isBusy:Function}}
 */
export function createComposer(hub, opts) {
  const o = opts || {};
  const limits = CONFIG.LIMITS;
  const maxChars = limits.messageMaxChars || 2000;

  const state = {
    reply: null,          // message row being replied to
    edit: null,           // message row being edited
    files: [],            // prepared attachment descriptors (pre-upload)
    busy: false,          // a send is in flight
    cooldownUntil: 0,     // epoch ms
    locked: false,        // channel is locked and I am not an admin
    mutedUntil: 0,        // active mutes row expiry as epoch ms (0 = not muted)
    bannedUntil: 0,       // active bans row expiry as epoch ms (0 = not banned)
    cooldownTotal: 0,     // seconds the current cooldown started from
    destroyed: false,
  };

  const offs = [];
  let rafId = 0;
  let tickId = 0;
  let liftId = 0;       // fires when a timed mute/ban expires

  /* ---------------------------------------------------------------- markup */

  const banner = el('div.ch-banner', { hidden: true });
  const fileRow = el('div.ch-att-row.ch-att-row--pending', { hidden: true });
  const notice = el('div.ch-composer__notice', { hidden: true });

  const input = el('textarea.composer__input', {
    attrs: {
      rows: '1', placeholder: 'Message', 'aria-label': 'Message',
      maxlength: String(maxChars), enterkeyhint: 'send',
      autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'true',
    },
  });

  const picker = el('input', {
    type: 'file', hidden: true,
    attrs: { multiple: '', accept: 'image/*,.pdf,.txt,.md,.csv,.json,.zip' },
  });

  const attachBtn = el('button.btn.btn-ghost.btn-icon.ch-composer__attach', {
    type: 'button', attrs: { 'aria-label': 'Attach a file' },
    onClick: () => { if (!inputDisabled()) picker.click(); },
  }, icon('paperclip', { size: 18 }));

  const ringTrack = svgCircle('ch-cool__track');
  const ringFill = svgCircle('ch-cool__fill');
  ringFill.setAttribute('stroke-dasharray', String(RING_C));
  ringFill.setAttribute('stroke-dashoffset', '0');

  const ring = el('span.ch-cool', { hidden: true, attrs: { 'aria-hidden': 'true' } },
    svgWrap(ringTrack, ringFill),
    el('span.ch-cool__num.tabular'));

  const sendIcon = icon('send', { size: 18 });
  const sendBtn = el('button.btn.btn-primary.btn-icon.ch-composer__send', {
    type: 'button', attrs: { 'aria-label': 'Send message' },
    onClick: () => { submit(); },
  }, sendIcon, ring);

  const counter = el('span.ch-composer__count.tabular', { hidden: true });

  const row = el('div.composer', attachBtn, el('div.ch-composer__grow', input, counter), sendBtn);
  const root = el('div.ch-composer', notice, banner, fileRow, row, picker);

  const drop = el('div.ch-drop', { hidden: true },
    icon('upload', { size: 24 }),
    el('span', { text: 'Drop to attach' }));
  root.appendChild(drop);

  /* ------------------------------------------------------------- utilities */

  function svgWrap(...kids) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('class', 'ch-cool__svg');
    svg.setAttribute('aria-hidden', 'true');
    kids.forEach((k) => svg.appendChild(k));
    return svg;
  }
  function svgCircle(cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '18'); c.setAttribute('cy', '18'); c.setAttribute('r', String(RING_R));
    return c;
  }

  const now = () => Date.now();
  const cooling = () => state.cooldownUntil > now();
  const muted = () => state.mutedUntil > now();
  const banned = () => state.bannedUntil > now();
  const inputDisabled = () => state.locked || muted() || banned() || state.destroyed;

  /* A restriction with no end date is stored as MAX_SAFE_INTEGER, which is not
     a date anybody wants to read. Say "until it is lifted" instead. */
  const INDEFINITE = Number.MAX_SAFE_INTEGER;
  const untilText = (ms) => (ms >= INDEFINITE ? 'until it is lifted' : 'until ' + fmt.time(ms));

  function autoGrow() {
    input.style.height = 'auto';
    const max = Math.round(Math.min(window.innerHeight * 0.4, 220));
    input.style.height = Math.min(input.scrollHeight, max) + 'px';
    if (typeof o.onHeightChange === 'function') o.onHeightChange();
  }

  function updateCounter() {
    const n = input.value.length;
    const near = n > maxChars - 200;
    counter.hidden = !near;
    if (near) {
      counter.textContent = fmt.int(maxChars - n);
      counter.classList.toggle('is-over', n >= maxChars);
    }
  }

  function canSend() {
    if (inputDisabled() || state.busy || cooling()) return false;
    return Boolean(input.value.trim()) || state.files.length > 0 || Boolean(state.edit);
  }

  function syncSend() {
    const ok = canSend();
    sendBtn.disabled = !ok;
    sendBtn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    attachBtn.disabled = inputDisabled() || state.files.length >= MAX_ATTACHMENTS;
  }

  /* --------------------------------------------------------------- notices */

  function setNotice(text, tone, iconName) {
    if (!text) { notice.hidden = true; notice.replaceChildren(); return; }
    notice.hidden = false;
    notice.dataset.tone = tone || 'neutral';
    notice.replaceChildren(icon(iconName || 'info', { size: 14 }), el('span', { text }));
  }

  /* A ban outranks a mute outranks a lock: say the thing that actually stops
     him, once, in words he can act on. Never "Invalid Date" — an indefinite
     restriction is stored as MAX_SAFE_INTEGER and untilText() knows that. */
  function refreshNotice() {
    if (banned()) {
      setNotice('You are banned from chat ' + untilText(state.bannedUntil)
        + '. Reading still works, and nothing else in Engram is affected.', 'bad', 'shield');
    } else if (muted()) {
      setNotice('You are muted ' + untilText(state.mutedUntil) + '. Reading still works.', 'warn', 'alert-triangle');
    } else if (state.locked) {
      setNotice('This channel is locked — only an admin can post here. You can still read everything.', 'neutral', 'lock');
    } else {
      setNotice('');
    }
    input.disabled = inputDisabled();
    input.setAttribute('placeholder', banned() ? 'Banned from posting'
      : muted() ? 'Muted ' + untilText(state.mutedUntil)
        : state.locked ? 'Locked channel'
          : 'Message ' + (hub.channel() ? '#' + (hub.channel().name || '') : ''));
    scheduleLift();
    syncSend();
  }

  /**
   * A 10-minute mute has to end after 10 minutes even if nothing else happens.
   * Without this the box stays greyed out and the notice stays on screen until
   * the student navigates away and back — which reads as a permanent ban.
   */
  function scheduleLift() {
    if (liftId) { clearTimeout(liftId); liftId = 0; }
    const ends = [state.mutedUntil, state.bannedUntil]
      .filter((t) => t > now() && t < INDEFINITE);
    if (!ends.length) return;
    /* setTimeout overflows past ~24.8 days and fires immediately; clamp it. */
    const delay = Math.min(Math.min.apply(null, ends) - now() + 250, 2147483000);
    liftId = setTimeout(() => {
      liftId = 0;
      if (state.destroyed) return;
      refreshNotice();      // the clock has passed it — the box opens itself
      resync();             // and the real row is re-read, in case it was extended
    }, Math.max(250, delay));
  }

  /* ---------------------------------------------------------- reply / edit */

  function renderBanner() {
    banner.replaceChildren();
    const target = state.edit || state.reply;
    if (!target) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.dataset.mode = state.edit ? 'edit' : 'reply';

    const who = state.edit ? 'Editing your message' : 'Replying to ' + hub.displayName(authorOf(target));
    banner.append(
      icon(state.edit ? 'edit' : 'reply', { size: 14 }),
      el('span.ch-banner__who', { text: who }),
      el('span.ch-banner__text.truncate', { text: previewOf(target) }),
      el('button.btn.btn-ghost.btn-icon.btn--sm', {
        type: 'button', attrs: { 'aria-label': 'Cancel' },
        onClick: () => { state.edit ? cancelEdit() : setReply(null); },
      }, icon('x', { size: 14 }))
    );
  }

  /* Spoilers stay covered in the reply banner too — printing the hidden answer
     above the box he is about to type into defeats the point of ||…||. */
  function previewOf(msg) {
    const redacted = contentOf(msg).replace(/\|\|[\s\S]*?\|\|/g, '⟨spoiler⟩');
    const text = stripMarkdown(redacted).replace(/\s+/g, ' ').trim();
    if (text) return fmt.truncate(text, 90);
    return attachmentNameOf(msg) || '(no text)';
  }

  function setReply(msg) {
    if (state.edit) return;              // editing wins; reply is ignored
    state.reply = msg || null;
    renderBanner();
    if (msg) focus();
    syncSend();
  }

  function startEdit(msg) {
    if (!msg) return;
    state.edit = msg;
    state.reply = null;
    input.value = contentOf(msg);
    renderBanner();
    autoGrow();
    updateCounter();
    focus();
    // put the caret at the end
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* ignore */ }
    syncSend();
  }

  function cancelEdit() {
    if (!state.edit) return;
    state.edit = null;
    input.value = '';
    renderBanner();
    autoGrow();
    updateCounter();
    syncSend();
  }

  /* ------------------------------------------------------------ attachments */

  function renderFiles() {
    fileRow.replaceChildren();
    fileRow.hidden = state.files.length === 0;
    state.files.forEach((f, i) => {
      const card = attachmentCard({
        kind: f.kind, name: f.name, type: f.type, size: f.size,
        width: f.width, height: f.height, url: f.previewUrl,
      }, { onRemove: () => removeFile(i) });
      if (f.progress != null && f.progress < 1) {
        card.appendChild(el('span.ch-att__bar', { style: { '--ch-p': String(Math.round(f.progress * 100)) + '%' } }));
      }
      if (f.note) card.appendChild(el('span.ch-att__note', { text: f.note }));
      fileRow.appendChild(card);
    });
    syncSend();
  }

  function removeFile(i) {
    const f = state.files[i];
    if (f && f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    state.files.splice(i, 1);
    renderFiles();
  }

  function clearFiles() {
    state.files.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    state.files = [];
    renderFiles();
  }

  async function addFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    if (inputDisabled()) return;
    for (const file of files) {
      if (state.files.length >= MAX_ATTACHMENTS) {
        toast('One file per message — send the rest in the next one.', { tone: 'info' });
        break;
      }
      const slot = {
        kind: 'file', name: file.name, type: file.type, size: file.size,
        width: 0, height: 0, progress: 0, note: 'Preparing…', blob: null, previewUrl: '',
      };
      state.files.push(slot);
      renderFiles();
      try {
        /* eslint-disable no-await-in-loop */
        const prepared = await prepareFile(file, {
          onProgress: (f) => { slot.progress = clamp(f, 0, 0.99); renderFiles(); },
        });
        /* eslint-enable no-await-in-loop */
        Object.assign(slot, prepared, { progress: 1 });
        if (slot.kind === 'image') slot.previewUrl = URL.createObjectURL(slot.blob);
        renderFiles();
      } catch (err) {
        const i = state.files.indexOf(slot);
        if (i >= 0) state.files.splice(i, 1);
        renderFiles();
        toast(String((err && err.message) || 'That file could not be attached.'), { tone: 'warn', timeout: 7000 });
      }
    }
  }

  /* ---------------------------------------------------------------- sending */

  function stopTimers() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (tickId) { clearInterval(tickId); tickId = 0; }
  }

  function paintRing() {
    const total = Math.max(1, state.cooldownTotal || 1);
    const left = Math.max(0, state.cooldownUntil - now()) / 1000;
    const frac = clamp(left / total, 0, 1);
    ringFill.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
    const num = ring.lastChild;
    if (num) num.textContent = String(Math.ceil(left));
  }

  function endCooldown() {
    stopTimers();
    state.cooldownUntil = 0;
    ring.hidden = true;
    sendBtn.classList.remove('is-cooling');
    sendIcon.style.opacity = '';
    syncSend();
  }

  /**
   * Start the send cooldown.
   * @param {number} seconds
   */
  function startCooldown(seconds) {
    const secs = Math.max(0, Number(seconds) || 0);
    if (!secs) { endCooldown(); return; }
    stopTimers();
    state.cooldownTotal = secs;
    state.cooldownUntil = now() + secs * 1000;
    ring.hidden = false;
    sendBtn.classList.add('is-cooling');
    sendIcon.style.opacity = '0';
    syncSend();
    paintRing();

    /* The interval is the SAFETY NET and always runs. requestAnimationFrame is
       paused in a background tab, so a student who switches to Instagram
       mid-cooldown would come back to a frozen ring over a dead send button.
       setInterval still fires (clamped to ~1 s in the background), so the
       cooldown always ends. rAF only adds the smooth sweep on top of it, and
       only when motion is allowed. */
    tickId = setInterval(() => {
      if (state.destroyed) { stopTimers(); return; }
      if (!cooling()) { endCooldown(); return; }
      paintRing();
    }, 250);

    if (!prefersReducedMotion()) {
      const step = () => {
        rafId = 0;
        if (state.destroyed || !cooling()) return;
        paintRing();
        rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    }
  }

  async function submit() {
    if (!canSend()) return;
    const body = input.value.replace(/\s+$/, '');

    /* --- edit path ------------------------------------------------------- */
    if (state.edit) {
      const target = state.edit;
      if (!body.trim()) {
        toast('An edited message cannot be empty — delete it instead.', { tone: 'info' });
        return;
      }
      state.busy = true; syncSend();
      const res = await safe(() => o.onEditSave(target, body));
      state.busy = false;
      if (res && res.error) { handleError(res.error); syncSend(); return; }
      cancelEdit();
      return;
    }

    /* --- send path ------------------------------------------------------- */
    const files = state.files.filter((f) => f.blob);
    if (!body.trim() && !files.length) return;

    state.busy = true;
    syncSend();
    const payload = { body, files, replyTo: state.reply ? state.reply.id : null };

    // Optimistic clear: the message is already on screen as a pending block.
    const restoreText = input.value;
    input.value = '';
    autoGrow();
    updateCounter();

    const res = await safe(() => o.onSend(payload, {
      onProgress: (f, label) => {
        files.forEach((file) => { file.progress = f; file.note = label; });
        renderFiles();
      },
    }));

    state.busy = false;

    if (res && res.error) {
      input.value = restoreText;            // nothing is lost on failure
      autoGrow();
      updateCounter();
      handleError(res.error);
      syncSend();
      return;
    }

    clearFiles();
    setReply(null);
    startCooldown(limits.cooldownSec || 5);
    focus();
  }

  async function safe(fn) {
    try { return await fn(); } catch (err) { return { error: { message: String((err && err.message) || err) } }; }
  }

  /** Re-read mutes/bans through the hub so permissions self-heal. */
  function resync() {
    if (typeof hub.refreshRestrictions === 'function') {
      Promise.resolve().then(() => hub.refreshRestrictions()).catch(() => { /* nicety */ });
    }
  }

  function handleError(error) {
    const e = error || {};
    const retry = Number(e.retryAfterSec || e.retry_after_sec || 0);
    if (retry > 0) {
      startCooldown(retry);
      toast('One moment — you can send again in ' + Math.ceil(retry) + ' s.', { tone: 'info' });
      return;
    }
    /* The server is the authority on mutes and bans. Say so kindly, then ask
       the hub to re-read the real row so the box explains itself and unlocks
       itself the moment the restriction lapses. */
    if (e.code === 'banned' || /banned/i.test(String(e.message || ''))) {
      toast('You are banned from chat right now. Reading still works.', { tone: 'bad', timeout: 7000 });
      resync();
      return;
    }
    if (e.code === 'muted' || /muted/i.test(String(e.message || ''))) {
      toast(String(e.message || 'You are muted in chat right now.'), { tone: 'warn', timeout: 7000 });
      resync();
      return;
    }
    if (!navigator.onLine) {
      toast('No connection — the message is still in the box, nothing was lost.', { tone: 'warn', timeout: 7000 });
      return;
    }
    toast(String(e.message || 'That did not send. It is still in the box — try again.'), { tone: 'bad', timeout: 7000 });
  }

  /* ---------------------------------------------------------------- wiring */

  const notifyTyping = debounce(() => {
    if (typeof hub.typing === 'function' && !inputDisabled()) hub.typing();
  }, 400);

  offs.push(on(input, 'input', () => {
    autoGrow();
    updateCounter();
    syncSend();
    if (input.value.trim()) notifyTyping();
    if (typeof hub.setDraft === 'function' && !state.edit) hub.setDraft(input.value);
  }));

  offs.push(on(input, 'keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.edit) { e.preventDefault(); cancelEdit(); return; }
      if (state.reply) { e.preventDefault(); setReply(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'ArrowUp' && !input.value && !state.edit && typeof o.onEditLast === 'function') {
      e.preventDefault();
      o.onEditLast();
    }
  }));

  offs.push(on(input, 'paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;                                  // plain text / links: let it through
    const files = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  }));

  offs.push(on(picker, 'change', () => { addFiles(picker.files); picker.value = ''; }));

  let dragDepth = 0;
  offs.push(on(root, 'dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault(); dragDepth += 1; drop.hidden = inputDisabled();
  }));
  offs.push(on(root, 'dragover', (e) => {
    if (!drop.hidden) e.preventDefault();
  }));
  offs.push(on(root, 'dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.hidden = true; }));
  offs.push(on(root, 'drop', (e) => {
    if (drop.hidden) return;
    e.preventDefault();
    dragDepth = 0; drop.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }));

  /* ----------------------------------------------------------------- public */

  function focus() {
    // Never steal focus on a touch device — it yanks the keyboard open.
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) input.focus();
  }

  /** Full reset for a channel switch: permissions, draft, attachments, modes.
   *  The cooldown is deliberately NOT reset — msg_cooldown_ok() counts per
   *  author, not per channel, so hopping channels must not buy a free send. */
  function setChannelState(next) {
    const s = next || {};
    state.locked = Boolean(s.locked);
    state.mutedUntil = Number(s.mutedUntil || 0);
    state.bannedUntil = Number(s.bannedUntil || 0);
    clearFiles();
    cancelEdit();
    setReply(null);
    input.value = String(s.draft || '');
    autoGrow();
    updateCounter();
    refreshNotice();
  }

  /** Permissions only — never disturbs the text already in the box. */
  function setPermissions(next) {
    const s = next || {};
    if (s.locked !== undefined) state.locked = Boolean(s.locked);
    if (s.mutedUntil !== undefined) state.mutedUntil = Number(s.mutedUntil || 0);
    if (s.bannedUntil !== undefined) state.bannedUntil = Number(s.bannedUntil || 0);
    refreshNotice();
  }

  function insertText(text) {
    const t = String(text || '');
    if (!t) return;
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    input.value = input.value.slice(0, start) + t + input.value.slice(end);
    const caret = start + t.length;
    try { input.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
    autoGrow(); updateCounter(); syncSend(); focus();
  }

  function destroy() {
    state.destroyed = true;
    stopTimers();
    if (liftId) { clearTimeout(liftId); liftId = 0; }
    notifyTyping.cancel();
    clearFiles();
    offs.forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
    root.remove();
  }

  refreshNotice();
  autoGrow();
  syncSend();

  return {
    el: root,
    focus,
    destroy,
    setReply,
    startEdit,
    cancelEdit,
    setChannelState,
    setPermissions,
    insertText,
    startCooldown,
    isBusy: () => state.busy,
    isEditing: () => Boolean(state.edit),
    replyTarget: () => state.reply,
  };
}

export default { createComposer };
