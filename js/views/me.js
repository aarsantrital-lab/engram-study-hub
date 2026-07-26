/* =============================================================================
   js/views/me.js — the student's own page: profile editor, status, earned
   titles and frames, the stats strip, his shared items, the community shelf,
   and the (opt-in, friends-only) effort board.

   Owner: Job — profile + community editors + settings.
   Imports: config.js · store.js · dom.js · router.js · vault.js · community.js

   RULES KEPT VISIBLE HERE
     · Nothing on this page ranks ABILITY. The board is weekly XP + streak days
       — effort, which he controls — and it is OFF until he turns it on.
     · Marks-language, never vague praise.
     · game.js owns every number in the stats strip; this view only reads.
     · store.js is the only persistence path; KEYS.PROFILE is the profile home.
   ========================================================================== */

import CONFIG from '../config.js';
import { store, KEYS, todayLocalISO, addDaysISO, parseLocalISO } from '../store.js';
import { el, replace, icon, fmt, toast, haptic, spinner, clamp } from '../dom.js';
import { navigate } from '../router.js';
import { isVaultMissing } from '../vault.js';
import {
  STATUSES, FRAMES, loadGame, loadSb, sbReady, currentUser,
  openSheet, confirmSheet, compressImage, field,
  mountMyItems, mountBrowser, getGroups, joinGroup, leaveGroup, currentGroup,
  getCommunityState, patchCommunityState, slugify,
} from '../community.js';

/* =============================================================================
   1. PROFILE MODEL  (KEYS.PROFILE)
   ========================================================================== */

const DEFAULT_PROFILE = Object.freeze({
  displayName: '',
  username: '',
  bio: '',
  avatar: '',        // data: URL (compressed locally) or an https URL from storage
  status: 'studying',
  title: '',         // the LABEL of the equipped title — game.equipTitle() owns
                     // this field; never write it from here.
  frame: 'plain',
});

export function getProfile() {
  const saved = store.get(KEYS.PROFILE, null);
  return Object.assign({}, DEFAULT_PROFILE, saved && typeof saved === 'object' ? saved : {});
}

export function setProfile(patch) {
  const next = Object.assign(getProfile(), patch || {});
  const ok = store.set(KEYS.PROFILE, next);
  if (!ok) {
    toast('Storage is full — that change is in memory only. Export a backup from Settings.',
      { tone: 'warn', timeout: 8000 });
  }
  return next;
}

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'engram', 'hermes', 'moderator', 'mod',
  'staff', 'support', 'teacher', 'sir', 'miss', 'me', 'you', 'null', 'undefined', 'anon',
]);

/**
 * Username rules — stated once, checked live, never guessed at.
 * @returns {{ok:boolean, message:string, value?:string}}
 */
export function validateUsername(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return { ok: false, message: 'Pick a username — it is how your group finds your decks.' };
  if (s.length < 3) return { ok: false, message: 'At least 3 characters.' };
  if (s.length > 20) return { ok: false, message: '20 characters at most.' };
  if (!/^[a-z]/.test(s)) return { ok: false, message: 'Start with a lowercase letter.' };
  if (!/^[a-z0-9_]+$/.test(s)) return { ok: false, message: 'Lowercase letters, numbers and underscore only.' };
  if (/__/.test(s)) return { ok: false, message: 'No double underscore.' };
  if (/_$/.test(s)) return { ok: false, message: 'Cannot end with an underscore.' };
  if (RESERVED_USERNAMES.has(s)) return { ok: false, message: 'That one is reserved.' };
  return { ok: true, message: 'Free to use.', value: s };
}

function initialsOf(profile) {
  const src = String(profile.displayName || profile.username || 'E').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const a = (parts[0] || 'E')[0] || 'E';
  const b = parts.length > 1 ? (parts[parts.length - 1][0] || '') : '';
  return (a + b).toUpperCase();
}

function statusOf(id) {
  return STATUSES.find((s) => s.id === id) || STATUSES[0];
}

function frameOf(id) {
  return FRAMES.find((f) => f.id === id) || FRAMES[0];
}

/* =============================================================================
   2. AVATAR
   ========================================================================== */

const AVATAR_SIZES = { sm: 40, md: 56, lg: 84 };

/**
 * Avatar sources are UNTRUSTED (another student's row can carry any string).
 * Only a locally-produced data:image URL or an https URL is ever put in src —
 * javascript:, blob: and http: are dropped silently.
 */
function safeImageSrc(url) {
  const s = String(url == null ? '' : url).trim();
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return '';
}

function avatarNode(profile, size, opts) {
  const o = opts || {};
  const px = AVATAR_SIZES[size] || AVATAR_SIZES.md;
  const frame = frameOf(profile.frame);
  const src = safeImageSrc(profile.avatar);
  const inner = src
    ? el('img', {
        src,
        alt: '',
        attrs: { decoding: 'async' },
        style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
      })
    : el('span', {
        text: initialsOf(profile),
        style: {
          display: 'grid', placeItems: 'center', width: '100%', height: '100%',
          fontSize: Math.round(px / 2.6) + 'px', fontWeight: 'var(--fw-semibold)',
          color: 'var(--accent)', letterSpacing: '0.02em',
        },
      });

  return el('span', {
    dataset: { tone: frame.tone },
    attrs: { 'aria-hidden': o.decorative === false ? null : 'true' },
    style: {
      display: 'block', flex: '0 0 auto', width: px + 'px', height: px + 'px',
      borderRadius: 'var(--r-full)', overflow: 'hidden',
      background: 'rgb(var(--accent-rgb) / 0.12)',
      border: '2px solid rgb(var(--accent-rgb) / 0.55)',
      boxShadow: 'var(--lip), 0 8px 24px -14px rgb(var(--accent-rgb) / 0.9)',
    },
  }, inner);
}

/* =============================================================================
   3. THE VIEW
   ========================================================================== */

const cleanups = [];

function addCleanup(fn) { if (typeof fn === 'function') cleanups.push(fn); }

function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { fn(); } catch (err) { console.warn('[me] cleanup failed', err); }
  }
}

export default {
  id: 'me',
  title: 'Me',
  icon: 'user',

  async render(root) {
    runCleanups();

    const game = await loadGame();

    const headerHost = el('section.section');
    const statsHost = el('section.section');
    const statusHost = el('section.section');
    const lookHost = el('section.section');
    const mineHost = el('section.section');
    const shelfHost = el('section.section');
    const boardHost = el('section.section');

    root.appendChild(headerHost);
    root.appendChild(statsHost);
    root.appendChild(statusHost);
    root.appendChild(lookHost);
    root.appendChild(mineHost);
    root.appendChild(shelfHost);
    root.appendChild(boardHost);

    const redrawHeader = () => renderHeader(headerHost, game, redrawAll);
    const redrawStats = () => renderStats(statsHost, game);
    const redrawStatus = () => renderStatus(statusHost, redrawHeader);
    const redrawLook = () => renderLook(lookHost, game, redrawHeader);
    const redrawAll = () => { redrawHeader(); redrawStats(); redrawStatus(); redrawLook(); };

    redrawAll();
    renderMine(mineHost);
    renderShelf(shelfHost);
    renderBoard(boardHost, game);

    /* game.js pushes; we redraw the two panels that read its numbers. */
    if (typeof game.on === 'function') {
      for (const ev of ['xp', 'streak', 'badge', 'celebration']) {
        try { addCleanup(game.on(ev, () => { redrawStats(); redrawLook(); })); }
        catch (_) { /* an event this build does not emit */ }
      }
    }
    addCleanup(store.subscribe(KEYS.PROFILE, () => redrawHeader()));
  },

  onExit() { runCleanups(); },
};

/* =============================================================================
   4. HEADER — identity card
   ========================================================================== */

function renderHeader(host, game, redrawAll) {
  const p = getProfile();
  const st = statusOf(p.status);
  const titles = safeTitles(game);
  const activeTitle = titles.find((t) => t.equipped && t.earned) || null;

  replace(host,
    el('article.card.card--tone.card--pad-lg', { dataset: { tone: frameOf(p.frame).tone } },
      el('div.row', { style: { '--gap': 'var(--sp-4)', alignItems: 'flex-start' } },
        avatarNode(p, 'lg'),
        el('div.stack', { style: { '--gap': '6px', minWidth: '0', flex: '1 1 auto' } },
          el('div.text-title.truncate', { text: p.displayName || 'Set your name' }),
          el('div.text-meta.mono', { text: p.username ? '@' + p.username : 'no username yet' }),
          el('div.row.row--wrap', { style: { '--gap': '6px' } },
            el('span.pill', { class: 'pill--accent', dataset: { tone: st.tone } },
              icon(st.icon, { size: 12 }), el('span', { text: st.label })),
            activeTitle ? el('span.pill.pill--neutral', icon('crown', { size: 12 }), el('span', { text: activeTitle.label })) : null))),
      p.bio ? el('p.text-meta', { style: { marginTop: 'var(--sp-3)' }, text: p.bio }) : null,
      el('div.card__foot',
        el('button.btn.btn-primary.btn--sm', {
          type: 'button', onClick: () => openProfileEditor(redrawAll),
        }, icon('edit', { size: 14 }), el('span', { text: 'Edit profile' })),
        el('button.btn.btn-ghost.btn--sm', {
          type: 'button', onClick: () => navigate('stats'),
        }, icon('trending-up', { size: 14 }), el('span', { text: 'Full stats' })))));
}

function safeTitles(game) {
  try {
    const list = typeof game.getTitles === 'function' ? game.getTitles() : [];
    return Array.isArray(list) ? list.filter(Boolean).map((t) => ({
      id: String(t.id || ''),
      label: String(t.label || t.id || ''),
      earned: t.earned !== false,
      equipped: t.equipped === true,
    })) : [];
  } catch (_) { return []; }
}

/** game.getBadges() when the game layer ships it; earned titles otherwise. */
function safeBadges(game) {
  try {
    if (typeof game.getBadges === 'function') {
      const list = game.getBadges();
      if (Array.isArray(list)) {
        return list.filter(Boolean).map((b) => ({
          id: String(b.id || ''),
          label: String(b.label || b.id || ''),
          icon: String(b.icon || 'star'),
          tone: String(b.tone || 'brand'),
          description: String(b.description || ''),
          earned: b.earned === true,
        }));
      }
    }
  } catch (_) { /* fall through */ }
  return safeTitles(game).map((t, i) => ({
    id: t.id, label: t.label, icon: BADGE_ICONS[i % BADGE_ICONS.length],
    tone: BADGE_TONES[i % BADGE_TONES.length], description: '', earned: t.earned,
  }));
}

/* =============================================================================
   5. STATS STRIP + BADGE SHOWCASE
   ========================================================================== */

function renderStats(host, game) {
  let streak = { current: 0, lifetime: 0, freezesLeft: 0, longest: 0, repairable: false, repairRestoresTo: 0, copy: '' };
  let level = { level: 0, label: '', xp: 0, points: 0 };
  try { streak = Object.assign(streak, game.getStreak() || {}); } catch (_) { /* shim */ }
  try { level = Object.assign(level, game.getLevelInfo() || {}); } catch (_) { /* shim */ }

  const badges = safeBadges(game);
  const earned = badges.filter((b) => b.earned).slice(0, 6);
  const locked = badges.filter((b) => !b.earned).slice(0, Math.max(0, 6 - earned.length));

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'My numbers' })),
        el('h2.section-head__title', { text: 'Where I actually am' }))),

    el('div.stat-row',
      el('div.stat', { dataset: { tone: 'brand' } },
        el('div.stat__eyebrow', icon('flame', { size: 14 }), el('span', { text: 'Streak' })),
        el('div.stat__value.tabular', { text: fmt.int(streak.current) },
          el('span.stat__unit', { text: fmt.plural(streak.current, 'night') })),
        el('div.stat__sub', {
          text: 'longest ' + fmt.int(streak.longest || streak.current) + ' · ' +
            fmt.int(streak.freezesLeft) + ' ' + fmt.plural(streak.freezesLeft, 'freeze') + ' left',
        })),

      el('div.stat', { dataset: { tone: 'good' } },
        el('div.stat__eyebrow', icon('moon', { size: 14 }), el('span', { text: 'Lifetime nights' })),
        el('div.stat__value.stat__value--fg.tabular', { text: fmt.int(streak.lifetime) }),
        el('div.stat__sub', { text: 'a break never takes these away' })),

      el('div.stat', { dataset: { tone: 'ai' } },
        el('div.stat__eyebrow', icon('zap', { size: 14 }), el('span', { text: 'Level' })),
        el('div.stat__value.tabular', { text: fmt.int(level.level) }),
        el('div.stat__sub', { text: level.label || 'earned from real capability, never from volume' }))),

    streak.repairable
      ? el('div.card.card--quiet', { dataset: { tone: 'warn' }, style: { marginTop: 'var(--sp-3)' } },
          el('div.row.row--between',
            el('span.text-meta', {
              text: 'A run broke inside the last 48 hours. Repairing puts it back at ' +
                fmt.int(streak.repairRestoresTo) + ' — missing one day does not undo a habit.',
            }),
            el('button.btn.btn-secondary.btn--sm', {
              type: 'button',
              onClick: () => {
                try {
                  const res = game.repairStreak();
                  if (res && res.ok) { haptic('success'); toast('Run restored at ' + res.current + '.', { tone: 'good' }); }
                  else toast('That window has closed — start tonight instead.', { tone: 'info' });
                } catch (_) { toast('Could not repair right now.', { tone: 'warn' }); }
                renderStats(host, game);
              },
            }, icon('refresh', { size: 14 }), el('span', { text: 'Repair' }))))
      : null,

    el('div.card', { style: { marginTop: 'var(--sp-4)' } },
      el('div.card__head',
        el('div.card__title', { text: 'Badges' }),
        el('span.text-meta', { text: earned.length + ' of ' + badges.length })),
      (earned.length || locked.length)
        ? el('div.chip-row', { style: { '--gap': 'var(--sp-4)', marginTop: 'var(--sp-2)' } },
            earned.map((b) => badgeNode(b, false)).concat(locked.map((b) => badgeNode(b, true))))
        : el('p.text-meta', { style: { marginTop: 'var(--sp-2)' }, text: 'None yet. The first one is thirty lifetime nights — the only badge that cannot be rushed.' })));
}

function badgeNode(b, locked) {
  const node = el('span.badge', {
    dataset: { tone: locked ? 'neutral' : b.tone },
    attrs: { title: b.description || b.label },
  },
    el('span.badge__medal', icon(locked ? 'lock' : b.icon, { size: 20 })),
    el('span.badge__label', { text: b.label }));
  if (locked) node.classList.add('is-locked');
  return node;
}

const BADGE_TONES = ['brand', 'good', 'info', 'ai', 'warn', 'neutral'];
const BADGE_ICONS = ['flame', 'trophy', 'target', 'crown', 'star', 'shield'];

/* =============================================================================
   6. STATUS PICKER
   ========================================================================== */

function renderStatus(host, redrawHeader) {
  const p = getProfile();
  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Status' })),
        el('h2.section-head__title', { text: 'What you are on right now' }))),
    el('div.card',
      el('div.chip-row',
        STATUSES.map((s) => el('button.chip.chip--button', {
          type: 'button',
          dataset: { tone: s.tone },
          attrs: { 'aria-pressed': String(p.status === s.id) },
          onClick: () => {
            setProfile({ status: s.id });
            haptic('select');
            renderStatus(host, redrawHeader);
            redrawHeader();
          },
        }, icon(s.icon, { size: 14 }), el('span', { text: s.label })))),
      el('p.hint', { style: { marginTop: 'var(--sp-3)' }, text: 'Your group sees this next to your shared decks. It is not tracked and nothing scores it.' })));
}

/* =============================================================================
   7. TITLES + FRAMES
   ========================================================================== */

function renderLook(host, game, redrawHeader) {
  const p = getProfile();
  const titles = safeTitles(game);
  const earnedCount = titles.filter((t) => t.earned).length;

  const anyEquipped = titles.some((t) => t.equipped);
  const titleChips = titles.length
    ? el('div.chip-row',
        [{ id: null, label: 'No title', earned: true, equipped: !anyEquipped }].concat(titles).map((t) => {
          const btn = el('button.chip.chip--button', {
            type: 'button',
            attrs: { 'aria-pressed': String(t.equipped === true) },
            onClick: () => {
              if (!t.earned) return;
              /* game.js owns the equipped title AND the profile.title field. */
              try {
                if (typeof game.equipTitle === 'function') game.equipTitle(t.id);
                else setProfile({ title: t.id ? t.label : '' });
              } catch (_) { toast('Could not equip that title.', { tone: 'warn' }); }
              haptic('select');
              renderLook(host, game, redrawHeader);
              redrawHeader();
            },
          }, t.earned ? null : icon('lock', { size: 12 }), el('span', { text: t.label }));
          if (!t.earned) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
          return btn;
        }))
    : el('p.text-meta', { text: 'Titles unlock from real capability — "can solve limiting-reagent problems unaided", not a number.' });

  const frameChips = el('div.chip-row',
    FRAMES.map((f) => {
      const locked = earnedCount < f.needTitles;
      const btn = el('button.chip.chip--button', {
        type: 'button',
        dataset: { tone: f.tone },
        attrs: { 'aria-pressed': String((p.frame || 'plain') === f.id) },
        onClick: () => {
          if (locked) return;
          setProfile({ frame: f.id });
          haptic('select');
          renderLook(host, game, redrawHeader);
          redrawHeader();
        },
      }, locked ? icon('lock', { size: 12 }) : null,
        el('span', { text: f.label + (locked ? ' · ' + f.needTitles + ' titles' : '') }));
      if (locked) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
      return btn;
    }));

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Earned' })),
        el('h2.section-head__title', { text: 'Titles and frames' }))),
    el('div.card',
      el('div.card__title', { text: 'Title' }),
      titleChips,
      el('hr.divider'),
      el('div.card__title', { text: 'Avatar frame' }),
      frameChips,
      el('p.hint', { style: { marginTop: 'var(--sp-3)' }, text: 'Frames are cosmetic. They unlock with titles you already earned — never bought, never granted for volume.' })));
}

/* =============================================================================
   8. PROFILE EDITOR
   ========================================================================== */

export function openProfileEditor(onSaved) {
  const start = getProfile();
  const state = {
    displayName: start.displayName,
    username: start.username,
    bio: start.bio,
    avatar: start.avatar,
    avatarBlob: null,
  };

  const nameHint = el('div.hint');
  const userHint = el('div.hint');
  const bioHint = el('div.hint');
  const avatarHost = el('div.row', { style: { '--gap': 'var(--sp-4)' } });
  const saveBtn = el('button.btn.btn-primary', { type: 'button', text: 'Save profile' });

  const nameMax = CONFIG.LIMITS.displayNameMaxChars || 32;
  const bioMax = CONFIG.LIMITS.bioMaxChars || 190;

  function refreshValidation() {
    const name = String(state.displayName || '').trim();
    nameHint.textContent = name.length + '/' + nameMax + (name ? '' : ' · your group sees this name');
    nameHint.classList.toggle('hint--error', name.length > nameMax);

    const u = validateUsername(state.username);
    userHint.textContent = state.username ? u.message : 'Lowercase letters, numbers and _ · 3–20 characters.';
    userHint.classList.toggle('hint--error', Boolean(state.username) && !u.ok);

    const bio = String(state.bio || '');
    bioHint.textContent = bio.length + '/' + bioMax;
    bioHint.classList.toggle('hint--error', bio.length > bioMax);

    saveBtn.disabled = !name || name.length > nameMax || bio.length > bioMax ||
      (Boolean(state.username) && !u.ok);
  }

  function renderAvatar() {
    replace(avatarHost,
      avatarNode({ avatar: state.avatar, displayName: state.displayName, username: state.username, frame: start.frame }, 'md'),
      el('div.btn-row',
        el('label.btn.btn-secondary.btn--sm',
          icon('image', { size: 14 }),
          el('span', { text: state.avatar ? 'Change photo' : 'Add a photo' }),
          el('input', {
            type: 'file',
            accept: 'image/*',
            class: 'sr-only',
            onChange: async (e) => {
              const file = e.target.files && e.target.files[0];
              e.target.value = '';
              if (!file) return;
              try {
                const out = await compressImage(file, { maxDim: 320, maxBytes: 90000 });
                state.avatar = out.dataUrl;
                state.avatarBlob = out.blob;
                renderAvatar();
                toast('Photo resized to ' + out.width + '×' + out.height + ' · ' + fmt.bytes(out.bytes), { tone: 'good' });
              } catch (err) {
                toast(String((err && err.message) || 'That image could not be used.'), { tone: 'bad' });
              }
            },
          })),
        state.avatar
          ? el('button.btn.btn-ghost.btn--sm', {
              type: 'button',
              onClick: () => { state.avatar = ''; state.avatarBlob = null; renderAvatar(); },
            }, icon('trash', { size: 14 }), el('span', { text: 'Remove' }))
          : null));
  }

  const sheet = openSheet({
    title: 'Edit profile',
    subtitle: 'Only your group sees this.',
    body: [
      avatarHost,
      el('hr.divider'),
      el('div.field',
        el('label.label.label--req', { text: 'Display name' }),
        el('input.input', {
          type: 'text', value: state.displayName, attrs: { maxlength: String(nameMax), placeholder: 'Aarsh' },
          onInput: (e) => { state.displayName = e.target.value; refreshValidation(); },
        }),
        nameHint),
      el('div.field',
        el('label.label', { text: 'Username' }),
        el('div.input-group',
          el('span.input-group__icon', { text: '@' }),
          el('input.input.input--mono', {
            type: 'text', value: state.username,
            attrs: { maxlength: '20', placeholder: 'aarsh_np', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' },
            onInput: (e) => { state.username = String(e.target.value || '').toLowerCase(); e.target.value = state.username; refreshValidation(); },
          })),
        userHint),
      el('div.field',
        el('label.label', { text: 'Bio' }),
        el('textarea.textarea', {
          rows: 3, value: state.bio, attrs: { maxlength: String(bioMax), placeholder: 'Class 11 science · chasing 67/75' },
          onInput: (e) => { state.bio = e.target.value; refreshValidation(); },
        }),
        bioHint),
    ],
    foot: [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      saveBtn,
    ],
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const u = validateUsername(state.username);
    const patch = {
      displayName: String(state.displayName || '').trim(),
      username: u.ok ? u.value : '',
      bio: String(state.bio || '').trim(),
      avatar: state.avatar || '',
    };
    setProfile(patch);
    await syncProfileToCloud(patch, state.avatarBlob);
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save profile';
    sheet.close();
    toast('Profile saved.', { tone: 'good' });
    if (typeof onSaved === 'function') onSaved();
  });

  renderAvatar();
  refreshValidation();
  return sheet;
}

/**
 * Best-effort mirror of the profile to Supabase. Local is always authoritative;
 * a cloud failure is reported, never silent, and never blocks the local save.
 */
async function syncProfileToCloud(patch, avatarBlob) {
  if (!(await sbReady())) return;
  const sb = await loadSb();
  const user = await currentUser();
  if (!user) return;

  const row = {
    display_name: patch.displayName,
    username: patch.username || null,
    bio: patch.bio,
    updated_at: new Date().toISOString(),   // a TIMESTAMP column, not day math
  };

  if (avatarBlob && sb.storage && typeof sb.storage.upload === 'function') {
    try {
      const path = user.id + '/avatar-' + Date.now() + '.jpg';
      const up = await sb.storage.upload('avatars', path, avatarBlob);
      if (up && up.url) {
        row.avatar_url = up.url;
        // ALWAYS write the path too. avatar_url can be a signed url with a
        // finite life; avatar_path is the durable fact, and it is what lets a
        // reader rebuild a public url years later (chat.js prefers avatar_url
        // and falls back to this — the fallback only ever worked if the column
        // was actually filled in, and nothing filled it in).
        row.avatar_path = path;
      } else if (up && up.error) {
        toast('Photo saved on this device; the upload failed.', { tone: 'warn' });
      }
    } catch (_) {
      toast('Photo saved on this device; the upload failed.', { tone: 'warn' });
    }
  }

  try {
    const res = await sb.db.update('profiles', user.id, row);
    if (res && res.error) {
      const ins = await sb.db.insert('profiles', Object.assign({ id: user.id }, row));
      if (ins && ins.error) toast('Saved here. Syncing your profile failed: ' + (ins.error.message || 'unknown'), { tone: 'warn' });
    }
  } catch (err) {
    toast('Saved here. Syncing your profile failed.', { tone: 'warn' });
  }
}

/* =============================================================================
   9. MY SHARED ITEMS
   ========================================================================== */

function renderMine(host) {
  const listHost = el('div');
  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Mine' })),
        el('h2.section-head__title', { text: 'What I have shared' }),
        el('div.section-head__sub', { text: 'Only you can edit these. Everyone in the group can copy them.' }))),
    listHost);
  mountMyItems(listHost);
}

/* =============================================================================
   10. THE COMMUNITY SHELF  (browse + groups)
   ========================================================================== */

function renderShelf(host) {
  const browserHost = el('div');
  const groupsHost = el('div');

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Community' })),
        el('h2.section-head__title', { text: 'Decks, maps and notes from your group' }),
        el('div.section-head__sub', { text: 'Copy anything into your own queue. Your review history stays yours.' }))),
    isVaultMissing()
      ? el('div.card.card--quiet', { dataset: { tone: 'info' } },
          el('div.row', icon('info', { size: 16, cls: 'icon--accent' }),
            el('span.text-meta', { text: 'Your vault has not been synced to this device yet — imported decks still work and will sit alongside it when it arrives.' })))
      : null,
    groupsHost,
    browserHost);

  renderGroups(groupsHost, () => mountBrowser(browserHost, {}));
  mountBrowser(browserHost, {});
}

function renderGroups(host, onChange) {
  const groups = getGroups().filter((g) => g.id);
  const active = currentGroup();

  replace(host,
    el('div.card', { style: { marginBottom: 'var(--sp-3)' } },
      el('div.row.row--between',
        el('div.card__title', { text: 'Groups' }),
        el('button.btn.btn-ghost.btn--sm', { type: 'button', onClick: () => openJoinGroup(() => { renderGroups(host, onChange); onChange(); }) },
          icon('plus', { size: 14 }), el('span', { text: 'Join by code' }))),
      groups.length
        ? el('div.chip-row', { style: { marginTop: 'var(--sp-2)' } },
            groups.map((g) => el('span.chip', { dataset: { tone: g.id === active ? 'brand' : 'neutral' } },
              el('span', { text: g.label }),
              el('button.btn-icon', {
                type: 'button', attrs: { 'aria-label': 'Leave ' + g.label },
                onClick: async () => {
                  const yes = await confirmSheet({
                    title: 'Leave ' + g.label + '?',
                    body: 'Your own decks stay. You just stop seeing this group’s shelf.',
                    confirmLabel: 'Leave',
                    tone: 'bad',
                  });
                  if (!yes) return;
                  leaveGroup(g.id);
                  renderGroups(host, onChange);
                  onChange();
                },
              }, icon('x', { size: 12 })))))
        : el('p.hint', { style: { marginTop: 'var(--sp-2)' }, text: 'A group code is just a word your friends agree on — type the same one and you see the same shelf.' })));
}

function openJoinGroup(onDone) {
  const state = { code: '', label: '' };
  const hint = el('div.hint');
  const joinBtn = el('button.btn.btn-primary', { type: 'button', text: 'Join' });
  joinBtn.disabled = true;

  const sheet = openSheet({
    title: 'Join a group',
    subtitle: 'Same code = same shelf.',
    body: [
      field('Group code', el('input.input.input--mono', {
        type: 'text', attrs: { placeholder: 'vac-11-science', autocapitalize: 'none', spellcheck: 'false' },
        onInput: (e) => {
          state.code = e.target.value;
          const slug = slugify(state.code);
          hint.textContent = state.code ? 'Will join as: ' + slug : '';
          joinBtn.disabled = !state.code.trim();
        },
      })),
      hint,
      field('Name it (optional)', el('input.input', {
        type: 'text', attrs: { placeholder: 'My class' },
        onInput: (e) => { state.label = e.target.value; },
      })),
    ],
    foot: [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      joinBtn,
    ],
  });

  joinBtn.addEventListener('click', () => {
    const res = joinGroup(state.code, state.label);
    if (!res.ok) { toast(res.error, { tone: 'warn' }); return; }
    sheet.close();
    toast('Joined ' + res.id + '.', { tone: 'good' });
    if (typeof onDone === 'function') onDone();
  });
}

/* =============================================================================
   11. EFFORT BOARD  (opt-in · friends only · effort, never marks)
   ========================================================================== */

function renderBoard(host, game) {
  const on = getCommunityState().leaderboard === true;

  const toggle = el('label.toggle',
    el('input.toggle__input', {
      type: 'checkbox',
      checked: on,
      onChange: (e) => {
        patchCommunityState({ leaderboard: e.target.checked === true });
        renderBoard(host, game);
      },
    }),
    el('span.toggle__track', el('span.toggle__thumb')),
    el('span.toggle__label', { text: on ? 'Showing' : 'Hidden' }));

  const bodyHost = el('div');

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Effort' })),
        el('h2.section-head__title', { text: 'This week, side by side' }),
        el('div.section-head__sub', { text: 'Effort since Monday, not marks. Nights shown up and retrieval attempts — nothing here measures how good anyone is.' })),
      el('div.section-head__actions', toggle)),
    bodyHost);

  if (!on) {
    replace(bodyHost, el('div.card.card--quiet',
      el('div.row', icon('swords', { size: 16, cls: 'icon--accent' }),
        el('span.text-meta', { text: 'Off by default. Comparing marks with friends helps nobody who is behind — comparing effort sometimes does. Your call.' }))));
    return;
  }

  replace(bodyHost, spinner('Loading your friends’ week'));
  loadBoard(game).then((res) => {
    replace(bodyHost, boardCard(res));
  }).catch(() => {
    replace(bodyHost, el('div.card.card--quiet', { dataset: { tone: 'warn' } },
      el('div.row', icon('wifi-off', { size: 16, cls: 'icon--accent' }),
        el('span.text-meta', { text: 'Could not reach the group right now. Your own week is still counted locally.' }))));
  });
}

/**
 * Monday of the week `iso` falls in, in LOCAL Y/M/D (Nepal is UTC+05:45, so
 * every day boundary here goes through the store helpers — never Date.UTC).
 * This is the same bucket sb.js writes effort rows under, which is the whole
 * point: both sides of the board must measure the same days.
 */
function weekStartLocal(iso) {
  const day = iso || todayLocalISO();
  const d = parseLocalISO(day);
  if (!d) return day;
  return addDaysISO(day, -((d.getDay() + 6) % 7));   // getDay(): 0 = Sunday
}

/**
 * My own row, measured EXACTLY as sb.js measures it before pushing (retrieval
 * attempts since this week's Monday). A rolling 7-day count here would read
 * low against friends' whole-week rows — the one direction of error this
 * screen is never allowed to make.
 */
function myLocalRow(game, snapshot) {
  let streak = { current: 0 };
  try { streak = Object.assign(streak, game.getStreak() || {}); } catch (_) { /* shim */ }

  let attempts = 0;
  let streakDays = Number(streak.current) || 0;
  if (snapshot && typeof snapshot === 'object') {
    attempts = Math.max(0, Number(snapshot.xp) || 0);
    streakDays = Math.max(0, Number(snapshot.streakDays) || streakDays);
  } else {
    const sinceDate = parseLocalISO(weekStartLocal(todayLocalISO()));
    try {
      attempts = store.getReviewLog({ since: sinceDate ? sinceDate.getTime() : 0 }).length;
    } catch (_) { attempts = 0; }
  }
  const p = getProfile();
  return {
    user_id: 'me',
    username: p.username || 'you',
    display_name: p.displayName || 'You',
    avatar_url: p.avatar || '',
    xp_week: attempts,
    streak_days: streakDays,
    me: true,
  };
}

async function loadBoard(game) {
  if (!(await sbReady())) return { rows: [myLocalRow(game, null)], offline: true, error: null };

  const sb = await loadSb();
  const since = weekStartLocal(todayLocalISO());
  let rows = null;
  let error = null;

  /* sb.js measures my week itself; borrowing its snapshot keeps my row and the
     row my friends see of me identical to the digit. */
  let snapshot = null;
  try {
    if (sb.effort && typeof sb.effort.snapshot === 'function') snapshot = sb.effort.snapshot();
  } catch (_) { snapshot = null; }
  const mine = myLocalRow(game, snapshot);

  /* Preferred path: sb.js owns the board query (rpc, with its own view
     fallback). Only if that surface is absent do we query it ourselves. */
  try {
    if (sb.effort && typeof sb.effort.board === 'function') {
      const res = await sb.effort.board(since);
      if (res && !res.error && Array.isArray(res.data)) rows = res.data;
      else if (res && res.error) error = res.error.message || null;
    }
  } catch (_) { /* fall through */ }

  try {
    if (!rows) {
      const rpc = await sb.db.rpc('effort_leaderboard', { since_day: since });
      if (rpc && !rpc.error && Array.isArray(rpc.data)) { rows = rpc.data; error = null; }
      else if (rpc && rpc.error) error = rpc.error.message || error;
    }
  } catch (_) { /* fall through to the view */ }

  if (!rows) {
    /* Fallback for a database where the function is missing: the view carries
       the same effort columns plus the `week` each row belongs to.
       `effort_leaderboard` itself is a FUNCTION — it can only be reached
       through rpc(), never through select(). */
    try {
      const sel = await sb.db.select('effort_leaderboard_view', {
        filters: { week: { gte: since } },
        order: { column: 'xp_week', ascending: false },
        limit: 20,
      });
      if (sel && !sel.error && Array.isArray(sel.data)) rows = sel.data;
      else if (sel && sel.error) error = sel.error.message || error;
    } catch (_) { /* leave rows null */ }
  }

  if (!rows) return { rows: [mine], offline: true, error };

  const user = await currentUser();
  /* Rows are one per person PER WEEK. The window is a single week bucket, but
     an older project may still hand back two — fold by user so nobody ever
     appears twice with half their effort on each line. */
  const byUser = new Map();
  for (const r of rows) {
    const id = String(r.user_id || r.id || '');
    if (!id) continue;
    const prev = byUser.get(id);
    const row = prev || {
      user_id: id,
      username: String(r.username || ''),
      display_name: String(r.display_name || r.username || 'Someone'),
      avatar_url: String(r.avatar_url || ''),
      xp_week: 0,
      streak_days: 0,
      me: Boolean(user && id === String(user.id)),
    };
    row.xp_week += Number(r.xp_week || r.xp || 0) || 0;
    row.streak_days = Math.max(row.streak_days, Number(r.streak_days || r.streak || 0) || 0);
    byUser.set(id, row);
  }
  const norm = Array.from(byUser.values());
  if (!norm.some((r) => r.me)) norm.push(mine);
  return { rows: norm, offline: false, error };
}

function boardCard(res) {
  const rows = res.rows.slice().sort((a, b) => (b.xp_week - a.xp_week) || (b.streak_days - a.streak_days));
  const top = Math.max(1, rows[0] ? rows[0].xp_week : 1);

  return el('div.card',
    res.offline
      ? el('div.row', { style: { marginBottom: 'var(--sp-3)' } },
          icon('wifi-off', { size: 14, cls: 'icon--accent' }),
          el('span.text-meta', { text: 'Showing your own week only — the group board needs Supabase and a sign-in.' }))
      : null,
    res.error
      ? el('div.row', { style: { marginBottom: 'var(--sp-3)' }, dataset: { tone: 'warn' } },
          icon('alert-triangle', { size: 14, cls: 'icon--accent' }),
          el('span.text-meta', { text: res.error }))
      : null,
    el('div.stack', { style: { '--gap': 'var(--sp-3)' } },
      rows.map((r, i) => el('div.row', { dataset: r.me ? { tone: 'brand' } : null, style: { '--gap': 'var(--sp-3)' } },
        el('span.option__key.mono', { text: String(i + 1) }),
        avatarNode({ avatar: r.avatar_url, displayName: r.display_name, username: r.username, frame: r.me ? 'ember' : 'plain' }, 'sm'),
        el('div.stack', { style: { '--gap': '4px', flex: '1 1 auto', minWidth: '0' } },
          el('div.row.row--between',
            el('span.truncate', { text: r.display_name + (r.me ? ' · you' : '') }),
            el('span.text-meta.tabular', {
              text: fmt.int(r.xp_week) + ' effort · ' + fmt.int(r.streak_days) + ' ' + fmt.plural(r.streak_days, 'night'),
            })),
          el('div.meter.meter--sm',
            el('span.meter__fill', { style: { '--pct': String(clamp(Math.round((r.xp_week / top) * 100), 2, 100)) } })))))),
    el('p.hint', { style: { marginTop: 'var(--sp-4)' }, text: 'Effort counts retrieval attempts this week — including the ones you got wrong. Nobody’s marks, accuracy or grades appear on this board, ever.' }));
}
