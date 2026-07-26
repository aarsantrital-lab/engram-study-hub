/* =============================================================================
   js/views/chat.js — Job CHAT. Replaces the Job A2 stub.

   The whole chat screen: auth, channels, the message pane, the composer, admin
   tools, presence, typing, profile cards and the celebration bridge.

   ARCHITECTURE
     · views/chat.js  (this file)  owns state, the backend calls and the UI
       layers (modal / sheet / popover / confetti). It builds one `hub` object
       and hands it to the sub-modules — they never import sb.js themselves.
     · js/chat/messages.js     the message pane
     · js/chat/composer.js     the input, cooldown, attachments UI
     · js/chat/attachments.js  compression, upload, cards, lightbox
     · js/chat/admin.js        moderation (drawn only for an admin)

   sb.js and the chat sub-modules are loaded with dynamic import() INSIDE
   render(). Two reasons: boot stays fast (chat code is never parsed until the
   screen is opened) and — critically — a missing or broken sb.js can never
   take the shell down, because registry.js imports this file at boot.

   COLUMN VOCABULARY — supabase/schema.sql is the only authority.
     messages(id, channel_id, author, content, reply_to, attachment_path,
              attachment_meta jsonb, pinned, deleted, edited_at, created_at,
              is_system, system_kind)
     channels(id, name, description, locked, position, created_by)
     profiles(id, username, display_name, bio, avatar_path, avatar_url,
              status, title, is_admin)
     reactions(id, message_id, author, emoji)      — a TABLE, not a column
     mutes/bans(id, user_id, until, reason)        — a ROW, not a column
   The schema also carries alias columns (author_id/body/attachments/deleted_at)
   kept in step by a trigger. We read and write the CANONICAL names only: they
   are the ones carrying the constraints and the foreign keys.

   A soft delete sets `deleted = true` and NOTHING else. Blanking `content`
   would trip the messages_not_empty CHECK and the delete would be refused.

   Chat is the one screen in Engram that genuinely needs the network. Every
   offline / not-configured path renders a friendly explanation, never an error.
   ========================================================================== */

import CONFIG, { hasSupabase } from '../config.js';
import {
  el, icon, fmt, on, toast, clear, emptyState, prefersReducedMotion, debounce, haptic,
} from '../dom.js';
import { store, KEYS } from '../store.js';
import { renderInlineInto, renderMarkdownInto } from '../md.js';
import { navigate } from '../router.js';
import { searchIndex } from '../search-index.js';

/* ===========================================================================
   0. Constants
   ======================================================================== */

/* EXACTLY the five values profiles.status accepts (schema.sql CHECK). A sixth
   label here would be rejected by the database with an unhelpful 400. */
const STATUSES = [
  { id: 'online', label: 'Online', icon: 'circle-check', tone: 'good', note: 'Around and replying.' },
  { id: 'studying', label: 'Studying', icon: 'book-open', tone: 'brand', note: 'Reachable on social media' },
  { id: 'social', label: 'On social', icon: 'message-circle', tone: 'info', note: 'Reachable on social media' },
  { id: 'dnd', label: 'Do not disturb', icon: 'eye-off', tone: 'bad', note: 'Deep work — replies come later.' },
  { id: 'offline', label: 'Invisible', icon: 'wifi-off', tone: 'neutral', note: 'Shown as offline to everyone.' },
];

const statusMeta = (id) => STATUSES.find((s) => s.id === id) || STATUSES[STATUSES.length - 1];

const TYPING_TTL_MS = 6000;
const TYPING_MIN_GAP_MS = 2200;
const CELEBRATION_MAX = 6;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const ATTACHMENT_BUCKET = 'attachments';
const AVATAR_BUCKET = 'avatars';
/** profiles.title CHECK is <= 40 characters. */
const TITLE_MAX = 40;

/* ===========================================================================
   1. Styles — injected once. Tokens only; theme.css owns every colour value.
   ======================================================================== */

const CHAT_CSS = `
.ch{display:flex;flex-direction:column;height:var(--ch-h,72dvh);min-height:380px;
  margin-bottom:calc((var(--tabbar-h) + var(--safe-bottom) + var(--sp-4)) * -1);
  border-width:1px;border-color:var(--border);border-radius:var(--r-xl);
  background:var(--surface);box-shadow:var(--sh-card);overflow:hidden}
@media (min-width:768px){.ch{margin-bottom:calc(var(--section-gap) * -1)}}
@media (min-width:900px){.ch{flex-direction:row}}

.ch__side{display:none;flex-direction:column;width:212px;flex:0 0 212px;min-height:0;
  border-right-width:1px;border-color:var(--border);background:var(--surface-nav)}
@media (min-width:900px){.ch__side{display:flex}}
.ch__side-head{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-3);
  border-bottom-width:1px;border-color:var(--hairline)}
.ch__side-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:var(--sp-2)}
.ch__side-foot{flex:0 0 auto;padding:var(--sp-2);border-top-width:1px;border-color:var(--hairline)}
.ch__mobile-only{display:inline-flex}
@media (min-width:900px){.ch__mobile-only{display:none}}

.ch-chan{display:flex;align-items:center;gap:var(--sp-2);width:100%;min-height:36px;
  padding:6px var(--sp-2);margin-bottom:2px;border:0;border-radius:var(--r-md);cursor:pointer;
  background:transparent;color:var(--fg-muted);font-size:var(--fs-body);text-align:left}
.ch-chan:hover{background:var(--surface-hover);color:var(--fg)}
.ch-chan.is-active{background:rgb(var(--brand-rgb)/0.14);color:var(--fg)}
.ch-chan.is-active .icon{color:var(--brand)}
.ch-chan__name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch-chan__dot{flex:0 0 auto;width:8px;height:8px;border-radius:var(--r-full);
  background:var(--brand);box-shadow:0 0 8px rgb(var(--brand-rgb)/0.7)}
.ch-chan.is-unread{color:var(--fg);font-weight:var(--fw-medium)}

.ch__pane{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}
.ch__head{display:flex;align-items:center;gap:var(--sp-2);flex:0 0 auto;min-height:52px;
  flex-wrap:nowrap;padding:var(--sp-2) var(--sp-3);border-bottom-width:1px;
  border-color:var(--border);background:var(--surface-nav)}
.ch__head-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
/* .btn-row wraps by default; five icon buttons plus a title do not fit on a
   430px phone, and a header that reflows to two rows shoves the messages down
   every time the title changes. The title truncates instead. */
.ch__head > .btn-row{flex:0 0 auto;flex-wrap:nowrap;gap:0}
.ch__head-title{display:flex;align-items:center;gap:6px;font-size:var(--fs-body-lg);
  font-weight:var(--fw-semibold);letter-spacing:var(--tr-metric);color:var(--fg)}
.ch__head-sub{font-size:var(--fs-meta);color:var(--fg-muted);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ch__count{margin-left:4px;font-size:var(--fs-micro);color:var(--fg-muted);
  font-variant-numeric:tabular-nums}

.ch__body{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.ch__scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;scroll-padding-bottom:var(--sp-6)}
.ch__top{padding:var(--sp-3) var(--sp-3) 0}
.ch__start,.ch__loading{display:flex;align-items:center;justify-content:center;gap:var(--sp-2);
  padding:var(--sp-4) 0;font-size:var(--fs-meta);color:var(--fg-subtle)}
.ch__empty{display:grid;place-items:center;gap:var(--sp-2);padding:var(--sp-10) var(--sp-4);text-align:center}
.ch__empty .icon{color:var(--fg-subtle)}
.ch__empty-title{font-size:var(--fs-body-lg);color:var(--fg);margin:0}
.ch-bone{display:inline-block;border-radius:var(--r-sm)}

.ch__typing{display:flex;align-items:center;gap:var(--sp-2);flex:0 0 auto;min-height:22px;
  padding:0 var(--sp-4) 2px;font-size:var(--fs-meta);color:var(--fg-muted)}
.ch__typing-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.ch-jump{position:absolute;left:50%;bottom:var(--sp-3);transform:translateX(-50%);
  display:inline-flex;align-items:center;gap:6px;z-index:var(--z-raised);
  min-height:32px;padding:0 var(--sp-3);border-width:1px;border-color:var(--border-strong);
  border-radius:var(--r-full);background:var(--surface-hover);color:var(--fg);
  font-size:var(--fs-meta);cursor:pointer;box-shadow:var(--sh-pop)}

.msg__body > :last-child{margin-bottom:0}
.msg.is-flash{background:rgb(var(--brand-rgb)/0.14);
  box-shadow:inset 2px 0 0 var(--brand);transition:background-color var(--dur-slow) var(--ease)}
.ch-avatar{overflow:visible;position:relative;cursor:pointer;padding:0}
.ch-avatar__img{width:100%;height:100%;object-fit:cover;border-radius:var(--r-full)}
.ch-name{border:0;background:transparent;padding:0;cursor:pointer;color:var(--accent);
  font:inherit;font-size:var(--fs-body-lg);font-weight:var(--fw-semibold)}
.ch-name:hover{text-decoration:underline}
.ch-status{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;
  border:2px solid var(--surface);background:var(--accent);box-shadow:none}
.ch-status[data-tone="neutral"]{background:var(--fg-subtle)}
.ch-tag--admin{display:inline-flex;align-items:center;gap:3px;
  --accent:var(--brand);--accent-rgb:var(--brand-rgb)}
.ch-pinmark{color:var(--fg-subtle);display:inline-flex}
.ch-edited{font-size:var(--fs-meta);color:var(--fg-subtle)}
.ch-deleted{display:inline-flex;align-items:center;gap:6px;color:var(--fg-subtle);font-style:italic}
.ch-failed{display:inline-flex;align-items:center;gap:6px;margin-top:4px;
  font-size:var(--fs-meta);color:var(--bad)}
.ch-pending{position:absolute;right:var(--sp-3);top:6px;color:var(--fg-subtle)}
.ch-pending__bar{position:absolute;left:0;bottom:0;height:2px;width:var(--ch-p,0%);
  background:var(--brand);transition:width var(--dur) var(--ease)}

.ch-reply{grid-column:1 / -1;display:flex;align-items:center;gap:6px;
  padding-left:calc(36px + var(--sp-3));margin-bottom:2px;border:0;background:transparent;
  cursor:pointer;color:var(--fg-muted);font-size:var(--fs-meta);text-align:left;min-width:0}
.ch-reply:hover{color:var(--fg)}
.ch-reply .icon{color:var(--accent);flex:0 0 auto;transform:scaleY(-1)}
.ch-reply__who{color:var(--accent);flex:0 0 auto}
.ch-reply__text{min-width:0}

.ch-rxns{display:flex;flex-wrap:wrap;gap:4px;margin-top:var(--sp-2)}
.ch-rxn{display:inline-flex;align-items:center;gap:4px;min-height:26px;padding:0 7px;
  border-width:1px;border-color:var(--border);border-radius:var(--r-full);
  background:var(--surface-muted);color:var(--fg-muted);font-size:var(--fs-caption);cursor:pointer}
.ch-rxn:hover{border-color:var(--border-hover);background:var(--surface-hover)}
.ch-rxn.is-mine{border-color:rgb(var(--brand-rgb)/0.5);background:rgb(var(--brand-rgb)/0.14);color:var(--fg)}
.ch-rxn__e{font-size:14px;line-height:1}
.ch-rxn__n{min-width:8px;font-size:var(--fs-meta);font-variant-numeric:tabular-nums}
.ch-rxn--add{color:var(--fg-subtle)}
/* Nine buttons in a hover bar need to be tighter than a standalone icon
   button. .btn--sm::after keeps the real hit area at 44px either way, and the
   whole bar is hidden on touch pointers below. */
.msg__actions .ch-act{width:30px;min-width:30px;height:30px}
.ch-act--emoji span{font-size:15px;line-height:1}
@media (hover:none){.msg__actions{display:none}}

.ch-emoji{padding:var(--sp-2)}
.ch-emoji__grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:2px}
.ch-emoji__btn{display:grid;place-items:center;min-width:var(--tap);min-height:var(--tap);
  border:0;border-radius:var(--r-md);background:transparent;font-size:20px;cursor:pointer;line-height:1}
.ch-emoji__btn:hover{background:var(--surface-hover)}

.ch-att-row{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin-top:var(--sp-2)}
.ch-att-row--pending{padding:var(--sp-2) var(--sp-3) 0}
.ch-att-wrap{position:relative;display:inline-flex}
.ch-att{position:relative;display:flex;align-items:center;gap:var(--sp-2);overflow:hidden;
  border-width:1px;border-color:var(--border);border-radius:var(--r-lg);background:var(--surface-muted)}
.ch-att--img{display:block;padding:0;cursor:zoom-in;max-width:min(340px,100%);
  aspect-ratio:var(--ch-ratio,1.33);border-color:var(--border-strong)}
.ch-att__img{display:block;width:100%;height:100%;object-fit:cover}
.ch-att__file{padding:var(--sp-2);min-width:min(260px,100%);max-width:100%}
.ch-att__meta{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}
.ch-att__name{font-size:var(--fs-caption);color:var(--fg)}
.ch-att__size{font-size:var(--fs-micro);color:var(--fg-muted)}
.ch-att__note{position:absolute;left:0;right:0;bottom:0;padding:2px 6px;
  background:rgb(var(--bg-rgb)/0.75);font-size:var(--fs-micro);color:var(--fg-muted)}
.ch-att__bar{position:absolute;left:0;bottom:0;height:3px;width:var(--ch-p,0%);background:var(--brand)}
.ch-att__x{position:absolute;top:-6px;right:-6px;display:grid;place-items:center;
  width:22px;height:22px;border-width:1px;border-color:var(--border-strong);
  border-radius:var(--r-full);background:var(--surface);color:var(--fg-muted);cursor:pointer;z-index:1}
.ch-att__x:hover{color:var(--bad);border-color:rgb(var(--bad-rgb)/0.5)}

.ch-lightbox__scrim{z-index:var(--z-scrim)}
.ch-lightbox{position:fixed;z-index:var(--z-modal);inset:var(--sp-4);
  display:flex;flex-direction:column;gap:var(--sp-2);align-items:center;justify-content:center;
  pointer-events:none}
.ch-lightbox__bar{display:flex;align-items:center;gap:var(--sp-2);pointer-events:auto;
  max-width:100%;padding:var(--sp-2) var(--sp-3);border-width:1px;border-color:var(--border-strong);
  border-radius:var(--r-full);background:var(--surface);box-shadow:var(--sh-pop)}
.ch-lightbox__name{font-size:var(--fs-caption);color:var(--fg-muted);max-width:40vw}
.ch-lightbox__img{max-width:100%;max-height:78dvh;object-fit:contain;pointer-events:auto;
  border-radius:var(--r-lg);box-shadow:var(--sh-modal)}

.ch-pins{position:absolute;left:0;right:0;top:0;z-index:var(--z-raised);max-height:60%;
  overflow-y:auto;padding:var(--sp-3);border-bottom-width:1px;border-color:var(--border-strong);
  background:var(--surface-nav);box-shadow:var(--sh-pop)}
.ch-pins__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--sp-2)}
.ch-pins__item{display:flex;align-items:flex-start;gap:var(--sp-2);padding:var(--sp-2);
  border-left-width:2px;border-color:var(--accent);border-radius:0 var(--r-md) var(--r-md) 0;
  background:var(--surface);margin-bottom:var(--sp-2)}
.ch-pins__go{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;
  border:0;background:transparent;cursor:pointer;text-align:left;color:var(--fg)}
.ch-pins__who{font-size:var(--fs-caption);font-weight:var(--fw-semibold);color:var(--accent)}
.ch-pins__text{font-size:var(--fs-caption);color:var(--fg-muted)}
.ch-pins__empty{padding:var(--sp-2) 0}

.ch-composer{position:relative;flex:0 0 auto}
.ch-composer__grow{position:relative;flex:1 1 auto;min-width:0;display:flex}
.ch-composer__count{position:absolute;right:var(--sp-3);bottom:-14px;font-size:var(--fs-micro);
  color:var(--fg-muted)}
.ch-composer__count.is-over{color:var(--bad)}
.ch-composer__attach,.ch-composer__send{flex:0 0 auto;width:var(--tap);height:var(--tap);min-width:var(--tap)}
.ch-composer__send{position:relative}
.ch-composer__notice{display:flex;align-items:center;gap:6px;padding:var(--sp-2) var(--sp-3);
  border-bottom-width:1px;border-color:var(--hairline);font-size:var(--fs-meta);color:var(--accent)}
.ch-composer__notice[data-tone="warn"]{--accent:var(--warn);--accent-rgb:var(--warn-rgb)}
.ch-composer__notice[data-tone="bad"]{--accent:var(--bad);--accent-rgb:var(--bad-rgb)}
.ch-composer__notice[data-tone="neutral"]{--accent:var(--fg-muted)}
.composer__input:disabled{opacity:0.6;cursor:not-allowed}

.ch-banner{display:flex;align-items:center;gap:6px;padding:6px var(--sp-3);
  border-left-width:2px;border-color:var(--accent);background:var(--surface-muted);
  font-size:var(--fs-meta);color:var(--fg-muted)}
.ch-banner[data-mode="edit"]{--accent:var(--warn);--accent-rgb:var(--warn-rgb)}
.ch-banner__who{color:var(--accent);flex:0 0 auto}
.ch-banner__text{min-width:0;flex:1 1 auto}

.ch-cool{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.ch-cool__svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.ch-cool__track{fill:none;stroke:rgb(var(--fg-rgb)/0.18);stroke-width:2.5}
.ch-cool__fill{fill:none;stroke:var(--fg-on-brand);stroke-width:2.5;stroke-linecap:round}
.ch-cool__num{font-size:var(--fs-meta);font-weight:var(--fw-semibold);color:var(--fg-on-brand)}
.ch-composer__send.is-cooling{opacity:1}

.ch-drop{position:absolute;inset:0;z-index:var(--z-raised);display:grid;place-items:center;
  gap:var(--sp-2);border:2px dashed rgb(var(--brand-rgb)/0.6);border-radius:var(--r-lg);
  background:rgb(var(--bg-rgb)/0.9);color:var(--brand);font-size:var(--fs-body);pointer-events:none}

.ch-sys{--accent:var(--good);--accent-rgb:var(--good-rgb)}
.ch-sys .msg__body{font-style:normal}
.ch-sys__mark{background:rgb(var(--accent-rgb)/0.16);color:var(--accent);
  border-color:rgb(var(--accent-rgb)/0.4)}

.ch-prof{width:min(320px,calc(100vw - var(--sp-6)));padding:var(--sp-4)}
.ch-prof__top{display:flex;align-items:center;gap:var(--sp-3);margin-bottom:var(--sp-3)}
.ch-prof__av{display:grid;place-items:center;width:52px;height:52px;flex:0 0 auto;
  border-width:1px;border-color:rgb(var(--accent-rgb)/0.4);border-radius:var(--r-full);
  background:rgb(var(--accent-rgb)/0.14);color:var(--accent);font-size:var(--fs-title);
  font-weight:var(--fw-semibold);overflow:hidden}
.ch-prof__av img{width:100%;height:100%;object-fit:cover}
.ch-prof__name{font-size:var(--fs-title);font-weight:var(--fw-semibold);letter-spacing:var(--tr-metric)}
.ch-prof__handle{font-size:var(--fs-meta);color:var(--fg-muted)}
.ch-prof__row{display:flex;align-items:center;gap:6px;margin-bottom:var(--sp-2);font-size:var(--fs-caption)}
.ch-prof__bio{padding-top:var(--sp-2);border-top-width:1px;border-color:var(--hairline);
  font-size:var(--fs-caption);color:var(--fg-muted);line-height:var(--lh-body)}

.ch-pop{position:fixed;z-index:var(--z-modal);border-width:1px;border-color:var(--border-strong);
  border-radius:var(--r-xl);background:var(--surface);box-shadow:var(--sh-pop);
  max-height:min(72dvh,520px);overflow:auto}

.ch-auth{display:grid;place-items:center;padding:var(--sp-6) var(--sp-3)}
.ch-auth__card{width:min(400px,100%)}
.ch-auth__tabs{margin-bottom:var(--sp-4)}

.ch-admin__tabs{width:100%}
.ch-admin__body{min-height:220px}
.ch-admin__list{display:flex;flex-direction:column;gap:var(--sp-2)}
.ch-admin__row{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2);
  border-width:1px;border-color:var(--border);border-radius:var(--r-lg);background:var(--surface-muted)}
.ch-admin__rowmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.ch-admin__name{font-size:var(--fs-body);color:var(--fg)}
.ch-admin__create{margin-bottom:var(--sp-4)}
.ch-admin__createrow{display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center}
.ch-admin__createrow .input,.ch-admin__createrow .select{flex:1 1 160px;min-width:0}
.ch-admin__durations{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:var(--sp-2)}
.ch-admin__board{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--sp-3)}
.ch-admin__col{display:flex;flex-direction:column;gap:6px;min-height:120px;padding:var(--sp-2);
  border-width:1px;border-color:var(--border);border-radius:var(--r-lg);background:var(--surface-muted)}
.ch-admin__col.is-over{border-color:var(--brand);background:rgb(var(--brand-rgb)/0.1)}
.ch-admin__colhead{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-2)}
.ch-admin__coldrop{padding:var(--sp-4) 0;text-align:center}
.ch-admin__chip{display:flex;align-items:center;gap:var(--sp-2);padding:4px 4px 4px var(--sp-2);
  min-height:36px;border-width:1px;border-color:var(--border);border-radius:var(--r-md);
  background:var(--surface);font-size:var(--fs-caption);cursor:grab}
.ch-admin__chip.is-dragging{opacity:0.45}
.ch-admin__empty{padding:var(--sp-4) 0;text-align:center}

.ch-sheet__list{display:flex;flex-direction:column;gap:2px}
.ch-sheet__item{display:flex;align-items:center;gap:var(--sp-3);width:100%;min-height:var(--tap);
  padding:0 var(--sp-3);border:0;border-radius:var(--r-md);background:transparent;
  color:var(--fg);font-size:var(--fs-body);text-align:left;cursor:pointer}
.ch-sheet__item:hover{background:var(--surface-hover)}
.ch-sheet__item[data-tone="bad"]{color:var(--bad)}
.ch-sheet__item[data-tone="bad"] .icon{color:var(--bad)}
.ch-sheet__item .icon{color:var(--fg-muted);flex:0 0 auto}

.ch-members__row{display:flex;align-items:center;gap:var(--sp-3);width:100%;min-height:var(--tap);
  padding:0 var(--sp-2);border:0;background:transparent;color:var(--fg);text-align:left;cursor:pointer}
.ch-members__row:hover{background:var(--surface-hover);border-radius:var(--r-md)}

.ch-att--img.is-loading{min-height:120px;background:var(--surface-muted)}
.ch-att--img.is-loading .ch-att__img{opacity:0}

@media (prefers-reduced-motion: reduce){
  .msg.is-flash{transition:none}
  .ch-att__bar,.ch-pending__bar{transition:none}
}

/* LAST RULE ON PURPOSE. Nearly every panel in this screen is toggled with the
   \`hidden\` property, and nearly every one of them also carries an author
   \`display\` — which beats the UA sheet's [hidden]{display:none} on
   specificity. Without this the typing bar, the jump button, the reply banner,
   the drop target, the composer notice and the cooldown ring are all on screen
   permanently. Higher specificity AND later in the sheet, so it always wins. */
.ch [hidden],.ch-composer [hidden],.ch-pop [hidden],.ch-prof [hidden]{display:none}
`;

let stylesInstalled = false;
function installStyles() {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  const style = document.createElement('style');
  style.id = 'chat-styles';
  style.textContent = CHAT_CSS;
  document.head.appendChild(style);
}

/* ===========================================================================
   2. Celebration bridge — installed at import time so milestones earned while
      studying are still posted the next time chat is opened.
   ======================================================================== */

let bridgeInstalled = false;

function readCache() {
  const c = store.get(KEYS.CHAT_CACHE, null);
  return c && typeof c === 'object' ? c : {};
}
function patchCache(patch) {
  store.update(KEYS.CHAT_CACHE, (prev) => Object.assign({}, prev && typeof prev === 'object' ? prev : {}, patch), {});
}

function installCelebrationBridge() {
  if (bridgeInstalled || typeof window === 'undefined') return;
  bridgeInstalled = true;
  window.addEventListener('engram:celebration', (e) => {
    const d = (e && e.detail) || {};
    const label = String(d.label || '').trim();
    if (!label) return;
    const item = { kind: String(d.kind || 'celebration'), label: label.slice(0, 220), ts: Date.now() };
    const cache = readCache();
    const queue = Array.isArray(cache.celebrations) ? cache.celebrations.slice() : [];
    /* The same milestone earned twice in a day is one post, not two. */
    if (queue.some((q) => q.label === item.label && Date.now() - q.ts < 12 * 3600 * 1000)) return;
    queue.push(item);
    patchCache({ celebrations: queue.slice(-CELEBRATION_MAX) });
    if (session.hub && session.channel) session.flushCelebrations();
  });
}
installCelebrationBridge();

/* ===========================================================================
   3. Session — everything the mounted view owns. Torn down in onExit().
   ======================================================================== */

const session = {
  root: null,
  sb: null,
  mods: null,
  hub: null,
  user: null,
  me: null,
  channels: [],
  channel: null,
  profiles: new Map(),
  presence: new Map(),        // userId -> {user_id, status, display_name, …}
  typing: new Map(),          // userId -> expiry ts
  unread: new Map(),          // channelId -> latest message ts
  reactions: new Map(),       // messageId -> {emoji: [authorId, …]}
  fileUrls: new Map(),        // storage path -> {url, at}
  lobby: null,
  room: null,
  pane: null,
  composer: null,
  offs: [],
  timers: [],
  layers: [],
  destroyed: false,
  flushCelebrations: () => {},
};

/** Drop every listener, timer, layer and socket this view owns. */
function resetSession() {
  session.offs.forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
  session.timers.forEach((t) => clearInterval(t));
  session.layers.slice().forEach((close) => { try { close(); } catch (_) { /* ignore */ } });
  try { if (session.room && session.room.unsubscribe) session.room.unsubscribe(); } catch (_) { /* ignore */ }
  try { if (session.lobby && session.lobby.unsubscribe) session.lobby.unsubscribe(); } catch (_) { /* ignore */ }
  try { if (session.pane) session.pane.destroy(); } catch (_) { /* ignore */ }
  try { if (session.composer) session.composer.destroy(); } catch (_) { /* ignore */ }
  session.offs = [];
  session.timers = [];
  session.layers = [];
  session.presence = new Map();
  session.typing = new Map();
  session.reactions = new Map();
  session.fileUrls = new Map();
  session.lobby = null;
  session.room = null;
  session.pane = null;
  session.composer = null;
  session.hub = null;
  session.channel = null;
  session.destroyed = true;
}

/* ===========================================================================
   4. Backend adapters
   ======================================================================== */

/**
 * Wrap sb.db so a thrown exception looks exactly like a returned error and no
 * call site anywhere in the chat suite ever needs a try/catch.
 */
function makeDb(sb) {
  const norm = async (promise) => {
    try {
      const r = await promise;
      return {
        data: r && r.data !== undefined ? r.data : null,
        error: (r && r.error) || null,
        count: r && r.count !== undefined ? r.count : null,
      };
    } catch (err) {
      return { data: null, error: { code: 'exception', message: String((err && err.message) || err) }, count: null };
    }
  };
  return {
    select: (table, opts) => norm(sb.db.select(table, opts || {})),
    insert: (table, row) => norm(sb.db.insert(table, row)),
    update: (table, id, patch) => norm(sb.db.update(table, id, patch)),
    remove: (table, id) => norm(sb.db.remove(table, id)),
    removeWhere: (table, filters) => norm(sb.db.removeWhere(table, filters)),
    rpc: (fn, args) => norm(sb.db.rpc(fn, args)),
  };
}

/** A realtime postgres payload is {eventType, new, old, table, …}. */
const rowOf = (payload) => {
  if (!payload) return null;
  if (payload.new) return payload.new;
  if (payload.record) return payload.record;
  return payload.id != null ? payload : null;
};
const oldRowOf = (payload) => (payload && (payload.old || payload.old_record)) || null;

/** Presence arrives as {key: [meta, …]}; be forgiving about the other shapes. */
function normalizePresence(raw) {
  const out = [];
  if (!raw) return out;
  const push = (v) => { if (v && typeof v === 'object') out.push(v); };
  if (Array.isArray(raw)) { raw.forEach(push); return out; }
  if (raw.state && typeof raw.state === 'object') return normalizePresence(raw.state);
  Object.keys(raw).forEach((k) => {
    const v = raw[k];
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  });
  return out;
}

const rowsOf = (res) => {
  const d = res && res.data;
  if (Array.isArray(d)) return d;
  return d ? [d] : [];
};
const oneOf = (res) => rowsOf(res)[0] || null;

/**
 * The `attachments` bucket is PRIVATE, so a stored message carries a path and
 * the URL is a signed link. Re-sign well before the 7-day link actually lapses.
 */
const SIGNATURE_TTL_MS = 6 * 24 * 3600 * 1000;

/**
 * messages.reactions is a trigger-maintained `{emoji:[userId,…]}` mirror that
 * rides along on the message's own realtime UPDATE. jsonb arrives decoded, but
 * a stray string must not throw.
 *
 * THESE TWO LIVE AT MODULE SCOPE ON PURPOSE. mountChat() awaits before its own
 * body finishes, and the hoisted functions above those awaits (ensureAttachment
 * Urls, absorbReactions) run inside that window — a `const` further down the
 * function body would still be in the temporal dead zone and throw.
 */
const reactionMap = (row) => {
  const raw = row && row.reactions;
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : null; } catch (_) { return null; }
  }
  return null;
};

/* ===========================================================================
   5. The view
   ======================================================================== */

export default {
  id: 'chat',
  title: 'Chat',
  icon: 'message-circle',

  async render(root, params) {
    installStyles();
    /* A re-render without an onExit (defensive) must not leak the last mount. */
    if (!session.destroyed) resetSession();
    session.destroyed = false;
    session.root = root;

    /* --- not configured -------------------------------------------------- */
    if (!hasSupabase()) {
      root.appendChild(notConfigured());
      return;
    }

    /* --- offline --------------------------------------------------------- */
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      root.appendChild(offlineState());
      return;
    }

    const boot = el('div.ch__loading', icon('loader', { size: 20, cls: 'icon-spin' }), el('span', { text: 'Connecting' }));
    root.appendChild(boot);

    /* --- load sb.js + the chat modules ----------------------------------- */
    let sb = null;
    let mods = null;
    try {
      const mod = await import('../sb.js');
      sb = mod.sb || mod.default || null;
    } catch (err) {
      console.warn('[chat] sb.js is not available', err);
    }
    if (!sb || typeof sb.ready !== 'function' || !sb.ready()) {
      clear(root);
      root.appendChild(notConfigured());
      return;
    }

    try {
      const [messages, composer, admin, attachments] = await Promise.all([
        import('../chat/messages.js'),
        import('../chat/composer.js'),
        import('../chat/admin.js'),
        import('../chat/attachments.js'),
      ]);
      mods = { messages, composer, admin, attachments };
    } catch (err) {
      clear(root);
      root.appendChild(emptyState({
        icon: 'alert-triangle',
        title: 'Chat could not start',
        body: 'The chat code did not load. A reload usually fixes it — everything else in Engram is untouched.',
        action: { label: 'Reload', onClick: () => location.reload() },
      }));
      console.error('[chat] module load failed', err);
      return;
    }

    session.sb = sb;
    session.mods = mods;
    session.user = safeUser(sb);

    /* --- auth ------------------------------------------------------------ */
    if (!session.user) {
      clear(root);
      renderAuth(root, sb);
      return;
    }

    /* A token that expired while he was away signs him back out here. */
    session.offs.push(sb.auth.onChange((event) => {
      if (event === 'SIGNED_OUT' && !session.destroyed) navigate('chat');
    }));

    const loaded = await loadMyProfile(sb);
    if (loaded.error) {
      clear(root);
      root.appendChild(emptyState({
        icon: 'wifi-off',
        title: 'Could not reach the chat server',
        body: 'Your account is fine — the connection is not. Nothing else in Engram depends on it.',
        action: { label: 'Try again', onClick: () => navigate('chat') },
      }));
      return;
    }
    session.me = loaded.profile;
    if (!session.me) {
      clear(root);
      renderClaimUsername(root, sb);
      return;
    }

    clear(root);
    await mountChat(root, params);
  },

  onExit() {
    resetSession();
  },
};

/* ===========================================================================
   6. Zero-state screens
   ======================================================================== */

function notConfigured() {
  return el('div.stack',
    emptyState({
      icon: 'message-circle',
      title: 'Chat is not switched on yet',
      body: 'Chat needs a Supabase project — its URL and anon key go into js/config.js. '
        + 'Everything else in Engram works without it, offline included.',
      action: { label: 'Open settings', onClick: () => navigate('settings') },
    }));
}

function offlineState() {
  const wrap = el('div.stack');
  wrap.appendChild(emptyState({
    icon: 'wifi-off',
    title: 'Chat needs a connection',
    body: 'You are offline right now. Your review queue, maps and notes all still work — '
      + 'chat comes back on its own the moment the connection does.',
    action: { label: 'Try again', onClick: () => navigate('chat') },
  }));
  const off = on(window, 'online', () => { off(); navigate('chat'); });
  session.offs.push(off);
  return wrap;
}

/* ===========================================================================
   7. Auth
   ======================================================================== */

function safeUser(sb) {
  try { return sb.auth.user() || null; } catch (_) { return null; }
}

function field(labelText, input, hintText) {
  return el('label.field',
    el('span.label', { text: labelText }),
    input,
    hintText ? el('span.hint', { text: hintText }) : null);
}

function renderAuth(root, sb) {
  let mode = 'in';
  const host = el('div.ch-auth');
  const card = el('div.card.card--pad-lg.ch-auth__card');
  host.appendChild(card);
  root.appendChild(host);

  const paint = () => {
    clear(card);
    const tabs = el('div.segmented.ch-auth__tabs', { attrs: { role: 'tablist' } },
      el('button.segmented__btn', {
        type: 'button', class: mode === 'in' ? 'is-active' : '', text: 'Sign in',
        attrs: { role: 'tab', 'aria-selected': mode === 'in' ? 'true' : 'false' },
        onClick: () => { mode = 'in'; paint(); },
      }),
      el('button.segmented__btn', {
        type: 'button', class: mode === 'up' ? 'is-active' : '', text: 'Create account',
        attrs: { role: 'tab', 'aria-selected': mode === 'up' ? 'true' : 'false' },
        onClick: () => { mode = 'up'; paint(); },
      }));

    const email = el('input.input', { type: 'email', attrs: { placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email' } });
    const pass = el('input.input', { type: 'password', attrs: { placeholder: '••••••••', autocomplete: mode === 'up' ? 'new-password' : 'current-password' } });
    const username = el('input.input', { attrs: { placeholder: 'ezgody', autocomplete: 'username', maxlength: '20' } });
    const err = el('p.hint.hint--error', { hidden: true });
    const submit = el('button.btn.btn-primary.btn--block.btn--lg', {
      type: 'submit', text: mode === 'in' ? 'Sign in' : 'Create account',
    });

    const form = el('form', { attrs: { novalidate: '' } },
      field('Email', email),
      field('Password', pass, mode === 'up' ? 'At least 8 characters.' : null),
      mode === 'up' ? field('Username', username, 'Lowercase letters, numbers and underscores. 3–20 characters.') : null,
      err, submit);

    const showErr = (text) => { err.hidden = false; err.textContent = text; };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const mail = email.value.trim();
      const pw = pass.value;
      if (!mail || !pw) { showErr('Email and password are both needed.'); return; }
      if (mode === 'up' && pw.length < 8) { showErr('Use at least 8 characters — this account is the only key to your messages.'); return; }
      const uname = username.value.trim().toLowerCase();
      if (mode === 'up' && !USERNAME_RE.test(uname)) {
        showErr('Usernames are 3–20 characters: lowercase letters, numbers, underscores.');
        return;
      }

      submit.disabled = true;
      const res = await callAuth(sb, mode, mail, pw, uname);
      submit.disabled = false;

      if (res.error) { showErr(friendlyAuthError(res.error, mode)); return; }
      if (res.needsConfirm) {
        clear(card);
        card.appendChild(el('div.stack',
          el('span.icon-tile.icon-tile--lg.icon-tile--brand', icon('bell', { size: 20 })),
          el('h2.text-title', { text: 'Check your email' }),
          el('p.text-meta', { text: 'A confirmation link is on its way to ' + mail + '. Open it, then come back and sign in.' })));
        return;
      }
      navigate('chat');   // same-hash navigate force-fires the route change
    });

    card.appendChild(el('div.stack',
      el('div.row',
        el('span.icon-tile.icon-tile--brand', icon('message-circle', { size: 16 })),
        el('div.stack',
          el('h2.text-title', { text: mode === 'in' ? 'Welcome back' : 'Join the chat' }),
          el('p.text-meta', { text: 'Your study data stays on this device either way — chat is the only part that needs an account.' }))),
      tabs, form));
  };

  paint();
}

async function callAuth(sb, mode, email, password, username) {
  try {
    const res = mode === 'up'
      ? await sb.auth.signUp(email, password, username)
      : await sb.auth.signIn(email, password);
    if (res && res.error) return { error: res.error };
    const data = (res && res.data) || {};
    return { user: data.user || null, needsConfirm: Boolean(data.needsConfirmation) };
  } catch (err) {
    return { error: { message: String((err && err.message) || err) } };
  }
}

/** sb.js already speaks a code vocabulary — branch on that before the text. */
function friendlyAuthError(error, mode) {
  const e = error || {};
  switch (e.code) {
    case 'username_taken': return 'That username is taken. Pick another one.';
    case 'email_taken': return 'That email already has an account — switch to Sign in.';
    case 'invalid_credentials': return 'That email and password do not match. Try again.';
    case 'weak_password': return 'That password is too short. Use at least 8 characters.';
    case 'email_unconfirmed': return 'Confirm your email first — check your inbox for the link.';
    case 'offline':
    case 'network':
    case 'timeout': return 'The network dropped out. Check your connection and try again.';
    case 'rate_limited': return 'Too many attempts just now. Wait a minute, then try again.';
    default: break;
  }
  return String(e.message || (mode === 'up' ? 'The account could not be created.' : 'Sign in did not work.'));
}

/* --- username claim (signed in, but no profile row yet) -------------------- */

function renderClaimUsername(root, sb) {
  const host = el('div.ch-auth');
  const card = el('div.card.card--pad-lg.ch-auth__card');
  const username = el('input.input', { attrs: { placeholder: 'ezgody', maxlength: '20', autocomplete: 'username' } });
  const display = el('input.input', { attrs: { placeholder: 'Aarav', maxlength: String(CONFIG.LIMITS.displayNameMaxChars) } });
  const err = el('p.hint.hint--error', { hidden: true });
  const submit = el('button.btn.btn-primary.btn--block.btn--lg', { type: 'submit', text: 'Claim it' });

  const form = el('form', { attrs: { novalidate: '' } },
    field('Username', username, 'This is your @handle. Lowercase letters, numbers, underscores.'),
    field('Display name', display, 'What people see above your messages.'),
    err, submit);

  const showErr = (text) => { err.hidden = false; err.textContent = text; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const uname = username.value.trim().toLowerCase();
    const name = display.value.trim() || uname;
    if (!USERNAME_RE.test(uname)) {
      showErr('Usernames are 3–20 characters: lowercase letters, numbers, underscores.');
      return;
    }
    submit.disabled = true;

    const free = await sb.auth.usernameAvailable(uname);
    if (free.data === false) {
      submit.disabled = false;
      showErr('That username is taken. Try another.');
      return;
    }

    const user = safeUser(sb);
    const res = await makeDb(sb).insert('profiles', {
      id: user.id,
      username: uname,
      display_name: name.slice(0, CONFIG.LIMITS.displayNameMaxChars),
      status: 'online',
    });
    submit.disabled = false;
    if (res.error) { showErr(String(res.error.message || 'That did not save. Try again.')); return; }
    navigate('chat');
  });

  card.appendChild(el('div.stack',
    el('h2.text-title', { text: 'Pick your username' }),
    el('p.text-meta', { text: 'One time only — it is how people find you in chat.' }),
    form));
  host.appendChild(card);
  root.appendChild(host);
}

/**
 * A missing row and a dead network are different problems: one wants the claim
 * form, the other wants "try again". Never confuse them.
 * @returns {Promise<{profile:object|null, error:object|null}>}
 */
async function loadMyProfile(sb) {
  const user = safeUser(sb);
  if (!user) return { profile: null, error: null };
  const res = await makeDb(sb).select('profiles', { filters: { id: user.id }, limit: 1 });
  if (res.error) {
    console.warn('[chat] profile load failed', res.error);
    return { profile: null, error: res.error };
  }
  return { profile: oneOf(res), error: null };
}

/* ===========================================================================
   8. The chat itself
   ======================================================================== */

async function mountChat(root, params) {
  const sb = session.sb;
  const mods = session.mods;
  const db = makeDb(sb);

  /* Every mutable binding in this function is declared HERE, exactly once.
     Anything referenced by a function defined above its own declaration would
     otherwise sit in the temporal dead zone until that line runs. */
  let peopleCache = null;
  let groupCache = null;
  let groupMemberCache = null;
  let pinCount = 0;
  let lastTypingSent = 0;
  let myMute = null;
  let myBan = null;

  session.profiles.set(session.me.id, session.me);

  /* --- shell ----------------------------------------------------------- */
  const sideList = el('div.ch__side-list');
  /* Hidden for everyone but an admin — an empty bordered strip is just a
     rule across the sidebar for no reason. */
  const sideFoot = el('div.ch__side-foot', { hidden: true });
  const side = el('aside.ch__side',
    el('div.ch__side-head',
      el('span.icon-tile.icon-tile--sm.icon-tile--brand', icon('message-circle', { size: 14 })),
      el('span.text-body-lg', { text: 'Channels' }),
      el('span.push')),
    sideList,
    sideFoot);

  const headTitle = el('span.ch__head-title');
  const headSub = el('span.ch__head-sub');
  const headActions = el('div.btn-row');
  const head = el('header.ch__head',
    el('button.btn.btn-ghost.btn-icon.btn--sm.ch__mobile-only', {
      type: 'button', attrs: { 'aria-label': 'Channels' }, onClick: () => openChannelSheet(),
    }, icon('menu', { size: 16 })),
    el('div.ch__head-main', headTitle, headSub),
    headActions);

  const pane = el('section.ch__pane', head);
  const shell = el('div.ch', side, pane);
  root.appendChild(shell);

  /* --- height fitting (iOS keyboard aware) ------------------------------ */
  const fit = () => {
    if (session.destroyed || !shell.isConnected) return;
    const rect = shell.getBoundingClientRect();
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const offsetTop = vv ? vv.offsetTop : 0;
    const tabbar = document.getElementById('tabbar');
    const tabH = tabbar ? tabbar.getBoundingClientRect().height : 0;
    const h = Math.max(360, Math.round(vh - (rect.top - offsetTop) - tabH - 8));
    shell.style.setProperty('--ch-h', h + 'px');
  };
  const fitSoon = debounce(fit, 60);
  fit();
  session.offs.push(on(window, 'resize', fitSoon));
  session.offs.push(on(window, 'orientationchange', fitSoon));
  if (window.visualViewport) {
    session.offs.push(on(window.visualViewport, 'resize', fitSoon));
    session.offs.push(on(window.visualViewport, 'scroll', fitSoon));
  }

  /* --- hub ------------------------------------------------------------- */
  const hub = {
    sb,
    db,
    user: () => session.user,
    me: () => session.me,
    isAdmin: () => mods.admin.isAdminProfile(session.me, session.user),
    channel: () => session.channel,
    channels: () => session.channels,
    profile: (id) => session.profiles.get(id) || null,
    displayName,
    avatarUrl,
    statusMeta,
    presenceOf,
    openProfile,
    typing: broadcastTyping,
    setDraft: debounce(saveDraft, 400),
    sendMessage,
    deleteMessage,
    toggleReaction,
    togglePin,
    loadReactions,
    reactionsFor,
    ensureAttachmentUrls,
    cachedAttachmentUrl,
    attachmentUrl,
    jumpTo: (id) => session.pane && session.pane.jumpTo(id),
    setPinCount,
    setChannel,
    refreshChannels,
    refreshRestrictions,
    loadPeople,
    refreshPeople: () => loadPeople(true).then(() => renderChannelList()),
    loadGroups,
    loadGroupMembers,
    invalidateGroups: () => { groupCache = null; groupMemberCache = null; },
    err: showError,
    ui: {
      sheet: openSheet,
      modal: openModal,
      popover: openPopover,
      actionSheet: openActionSheet,
      confirm: openConfirm,
      confetti: burstConfetti,
      closeAll: closeAllLayers,
    },
  };
  session.hub = hub;

  /* --- panes ----------------------------------------------------------- */
  const messagePane = mods.messages.createMessagePane(hub, {
    onReply: (row) => session.composer && session.composer.setReply(row),
    onEdit: (row) => session.composer && session.composer.startEdit(row),
  });
  session.pane = messagePane;
  pane.appendChild(messagePane.el);

  const composer = mods.composer.createComposer(hub, {
    onSend: sendMessage,
    onEditSave: saveEdit,
    onEditLast: () => {
      const last = messagePane.lastOwnMessage();
      if (last) composer.startEdit(last);
    },
    onHeightChange: () => messagePane.stickToBottom(false),
  });
  session.composer = composer;
  pane.appendChild(composer.el);

  /* --- data ------------------------------------------------------------ */
  await refreshChannels();
  await loadPeople();
  await refreshRestrictions();
  await refreshUnread();

  const wanted = params && params.channel;
  const cached = readCache().lastChannel;
  const target = session.channels.find((c) => String(c.id) === String(wanted))
    || session.channels.find((c) => String(c.id) === String(cached))
    || session.channels[0]
    || null;

  subscribeLobby();
  renderHeadActions();

  if (!target) {
    messagePane.el.replaceChildren(emptyState({
      icon: 'message-circle',
      title: 'No channels yet',
      body: hub.isAdmin()
        ? 'Create the first channel from the moderation panel.'
        : 'An admin has not made any channels yet. Come back in a bit.',
      action: hub.isAdmin() ? { label: 'Open moderation', onClick: () => mods.admin.openAdminPanel(hub) } : null,
    }));
    renderChannelList();
    return;
  }

  await setChannel(target.id);

  /* --- housekeeping ----------------------------------------------------- */
  session.timers.push(setInterval(() => {
    const now = Date.now();
    let changed = false;
    session.typing.forEach((expiry, id) => {
      if (expiry <= now) { session.typing.delete(id); changed = true; }
    });
    if (changed) paintTyping();
  }, 1500));

  session.offs.push(on(window, 'offline', () => {
    toast('Connection lost — chat will catch up when it is back.', { tone: 'warn', timeout: 6000 });
  }));
  session.offs.push(on(window, 'online', () => {
    toast('Back online', { tone: 'good' });
    if (session.channel) messagePane.load(session.channel.id);
  }));

  session.offs.push(searchIndex.registerProvider('chat', () => session.channels.map((c) => ({
    id: 'chat:' + c.id,
    type: 'chat',
    title: '#' + c.name,
    subtitle: 'Chat channel',
    body: 'chat channel messages ' + String(c.description || ''),
    route: '#/chat?channel=' + encodeURIComponent(c.id),
    icon: 'message-circle',
  }))));
  searchIndex.rebuild();

  session.flushCelebrations = flushCelebrations;
  flushCelebrations();

  /* =========================================================================
     8a. People, groups, presence
     ====================================================================== */

  async function loadPeople(force) {
    if (peopleCache && !force) return peopleCache;
    const res = await db.select('profiles', { order: { column: 'username', ascending: true }, limit: 200 });
    if (res.error) { peopleCache = peopleCache || []; return peopleCache; }
    peopleCache = rowsOf(res);
    peopleCache.forEach((p) => session.profiles.set(p.id, Object.assign(session.profiles.get(p.id) || {}, p)));
    if (session.me) session.me = session.profiles.get(session.me.id) || session.me;
    return peopleCache;
  }

  async function loadGroups(force) {
    if (groupCache && !force) return groupCache;
    const res = await db.select('groups', { order: { column: 'name', ascending: true }, limit: 100 });
    groupCache = res.error ? [] : rowsOf(res);
    return groupCache;
  }

  async function loadGroupMembers(force) {
    if (groupMemberCache && !force) return groupMemberCache;
    const res = await db.select('group_members', { limit: 500 });
    groupMemberCache = res.error ? [] : rowsOf(res);
    return groupMemberCache;
  }

  function displayName(id) {
    if (!id) return 'Someone';
    const p = session.profiles.get(id);
    if (p) return p.display_name || p.username || 'Someone';
    const pres = session.presence.get(id);
    if (pres) return pres.display_name || pres.username || 'Someone';
    return 'Someone';
  }

  /** profiles.avatar_url is the resolved link; avatar_path is the storage key. */
  function avatarUrl(profile) {
    const p = profile || {};
    if (p.avatar_url) return String(p.avatar_url);
    if (p.avatar_path && sb.storage && typeof sb.storage.publicUrl === 'function') {
      return sb.storage.publicUrl(AVATAR_BUCKET, p.avatar_path);
    }
    return '';
  }

  function presenceOf(id) {
    const p = session.presence.get(id);
    if (p && p.status) return p.status;
    return null;
  }

  /* =========================================================================
     8b. Restrictions (mutes / bans are ROWS, never columns)
     ====================================================================== */

  async function refreshRestrictions() {
    if (!session.user) return;
    const [mutes, bans] = await Promise.all([
      db.select('mutes', { filters: { user_id: session.user.id }, limit: 20 }),
      db.select('bans', { filters: { user_id: session.user.id }, limit: 20 }),
    ]);
    myMute = mutes.error ? null : mods.admin.activeRestriction(rowsOf(mutes));
    myBan = bans.error ? null : mods.admin.activeRestriction(rowsOf(bans));
    applyPermissions();
  }

  /** NULL `until` means indefinite — represent it as a far-future instant. */
  function untilMs(row) {
    if (!row) return 0;
    if (!row.until) return Number.MAX_SAFE_INTEGER;
    const t = Date.parse(row.until);
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  }

  function applyPermissions() {
    if (!session.composer) return;
    session.composer.setPermissions({
      locked: Boolean(session.channel && session.channel.locked) && !hub.isAdmin(),
      mutedUntil: hub.isAdmin() ? 0 : untilMs(myMute),
      bannedUntil: hub.isAdmin() ? 0 : untilMs(myBan),
    });
  }

  /* =========================================================================
     8c. Channels
     ====================================================================== */

  async function refreshChannels() {
    const res = await db.select('channels', { order: { column: 'position', ascending: true }, limit: 100 });
    if (res.error) { showError(res.error, 'Channels could not be loaded.'); return session.channels; }
    session.channels = rowsOf(res).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    renderChannelList();
    return session.channels;
  }

  /** One cheap sweep so the sidebar can show which channels moved on. */
  async function refreshUnread() {
    const res = await db.select('messages', {
      columns: 'id,channel_id,created_at',
      order: { column: 'created_at', ascending: false },
      limit: 120,
    });
    if (res.error) return;
    for (const row of rowsOf(res)) {
      const ts = Date.parse(row.created_at) || 0;
      if (ts > (session.unread.get(row.channel_id) || 0)) session.unread.set(row.channel_id, ts);
    }
    renderChannelList();
  }

  function isUnread(channelId) {
    const latest = session.unread.get(channelId) || 0;
    if (!latest) return false;
    const read = (readCache().lastRead || {})[channelId] || 0;
    return latest > read;
  }

  function markRead(channelId) {
    const cache = readCache();
    const lastRead = Object.assign({}, cache.lastRead || {});
    lastRead[channelId] = Date.now();
    patchCache({ lastRead, lastChannel: channelId });
    renderChannelList();
  }

  function channelButton(c) {
    const active = session.channel && session.channel.id === c.id;
    const unread = !active && isUnread(c.id);
    return el('button.ch-chan', {
      type: 'button',
      class: [active ? 'is-active' : '', unread ? 'is-unread' : ''].filter(Boolean).join(' '),
      attrs: { 'aria-current': active ? 'true' : 'false' },
      onClick: () => { closeAllLayers(); setChannel(c.id); },
    },
    icon(c.locked ? 'lock' : 'message-circle', { size: 14 }),
    el('span.ch-chan__name', { text: c.name || 'channel' }),
    unread ? el('span.ch-chan__dot') : null);
  }

  /** The one channel-management affordance, drawn only for an admin. */
  function newChannelButton() {
    return el('button.btn.btn-secondary.btn--sm.btn--block', {
      type: 'button',
      onClick: () => { closeAllLayers(); mods.admin.openAdminPanel(hub, { tab: 'channels' }); },
    }, icon('plus', { size: 14 }), el('span', { text: 'New channel' }));
  }

  function renderChannelList() {
    clear(sideList);
    if (!session.channels.length) {
      sideList.appendChild(el('p.text-meta', { text: 'No channels yet.' }));
    } else {
      session.channels.forEach((c) => sideList.appendChild(channelButton(c)));
    }
    clear(sideFoot);
    const admin = Boolean(session.hub) && hub.isAdmin();
    sideFoot.hidden = !admin;
    if (admin) sideFoot.appendChild(newChannelButton());
  }

  function openChannelSheet() {
    const body = el('div.ch-sheet__list');
    session.channels.forEach((c) => body.appendChild(channelButton(c)));
    if (!session.channels.length) body.appendChild(el('p.text-meta', { text: 'No channels yet.' }));
    if (hub.isAdmin()) body.appendChild(el('div', { style: { paddingTop: 'var(--sp-2)' } }, newChannelButton()));
    openSheet({ title: 'Channels', body });
  }

  async function setChannel(channelId) {
    const next = session.channels.find((c) => String(c.id) === String(channelId));
    if (!next) return;
    session.channel = next;
    session.typing.clear();
    paintTyping();
    renderChannelList();
    renderHead();
    renderHeadActions();
    subscribeRoom(next.id);

    composer.setChannelState({
      locked: Boolean(next.locked) && !hub.isAdmin(),
      mutedUntil: hub.isAdmin() ? 0 : untilMs(myMute),
      bannedUntil: hub.isAdmin() ? 0 : untilMs(myBan),
      draft: (readCache().drafts || {})[next.id] || '',
    });

    await messagePane.load(next.id);
    markRead(next.id);
    fit();
    flushCelebrations();
  }

  function saveDraft(text) {
    if (!session.channel) return;
    const drafts = Object.assign({}, readCache().drafts || {});
    if (text) drafts[session.channel.id] = String(text).slice(0, CONFIG.LIMITS.messageMaxChars);
    else delete drafts[session.channel.id];
    patchCache({ drafts });
  }

  function renderHead() {
    const c = session.channel;
    clear(headTitle);
    clear(headSub);
    if (!c) return;
    headTitle.append(
      icon(c.locked ? 'lock' : 'message-circle', { size: 16 }),
      el('span', { text: c.name || 'channel' })
    );
    const online = Array.from(session.presence.values())
      .filter((p) => p.status && p.status !== 'offline').length;
    headSub.textContent = (c.description ? c.description + ' · ' : '')
      + (online ? online + ' ' + fmt.plural(online, 'person', 'people') + ' here' : 'Nobody else here right now');
  }

  function setPinCount(n) { pinCount = Number(n) || 0; renderHeadActions(); }

  function renderHeadActions() {
    clear(headActions);
    if (!session.channel) return;

    const pinBtn = el('button.btn.btn-ghost.btn-icon.btn--sm', {
      type: 'button', attrs: { 'aria-label': 'Pinned messages', title: 'Pinned messages' },
      onClick: () => messagePane.togglePins(),
    }, icon('pin', { size: 16 }));
    if (pinCount) pinBtn.appendChild(el('span.ch__count', { text: String(pinCount) }));
    headActions.appendChild(pinBtn);

    headActions.appendChild(el('button.btn.btn-ghost.btn-icon.btn--sm', {
      type: 'button', attrs: { 'aria-label': 'Who is here', title: 'Who is here' },
      onClick: openMembers,
    }, icon('user', { size: 16 })));

    if (hub.isAdmin()) {
      headActions.appendChild(el('button.btn.btn-ghost.btn-icon.btn--sm', {
        type: 'button', attrs: { 'aria-label': 'Moderation', title: 'Moderation' },
        onClick: () => mods.admin.openAdminPanel(hub),
      }, icon('shield', { size: 16 })));
    }

    headActions.appendChild(el('button.btn.btn-ghost.btn-icon.btn--sm', {
      type: 'button', attrs: { 'aria-label': 'Your profile', title: 'Your profile' },
      onClick: (e) => openProfile(session.user.id, e.currentTarget),
    }, icon('settings', { size: 16 })));
  }

  /* =========================================================================
     8d. Realtime
     ====================================================================== */

  function subscribeLobby() {
    try {
      const lobby = sb.realtime.channel('chat:lobby');
      session.lobby = lobby;
      lobby.onPostgres('channels', '*', () => refreshChannels());
      lobby.onPostgres('profiles', 'UPDATE', (p) => {
        const row = rowOf(p);
        if (!row || !row.id) return;
        session.profiles.set(row.id, Object.assign(session.profiles.get(row.id) || {}, row));
        if (session.me && row.id === session.me.id) {
          session.me = session.profiles.get(row.id);
          applyPermissions();              // permissions only — never his draft
        }
      });
      lobby.onPostgres('messages', 'INSERT', (p) => {
        const row = rowOf(p);
        if (!row || !row.channel_id) return;
        const ts = Date.parse(row.created_at) || Date.now();
        if (ts > (session.unread.get(row.channel_id) || 0)) session.unread.set(row.channel_id, ts);
        if (!session.channel || row.channel_id !== session.channel.id) renderChannelList();
      });
      lobby.onPresence(handlePresence);
      lobby.subscribe();
      trackPresence();
    } catch (err) {
      console.warn('[chat] realtime lobby unavailable', err);
    }
  }

  function subscribeRoom(channelId) {
    try { if (session.room && session.room.unsubscribe) session.room.unsubscribe(); } catch (_) { /* ignore */ }
    session.room = null;
    try {
      const room = sb.realtime.channel('chat:room:' + channelId);
      session.room = room;
      const filter = 'channel_id=eq.' + channelId;

      room.onPostgres({ table: 'messages', event: 'INSERT', filter }, (p) => {
        const row = rowOf(p);
        if (!row || row.channel_id !== channelId) return;
        absorbReactions(row);
        messagePane.applyInsert(row);
        if (row.author !== session.user.id) markRead(channelId);
      });
      room.onPostgres({ table: 'messages', event: 'UPDATE', filter }, (p) => {
        const row = rowOf(p);
        if (!row || row.channel_id !== channelId) return;
        /* A reaction change reaches us as an UPDATE of messages.reactions —
           the schema keeps that map in step precisely so this is one channel. */
        const changed = absorbReactions(row);
        messagePane.applyUpdate(row);
        if (changed) messagePane.refreshReactions(row.id);
      });
      room.onPostgres({ table: 'messages', event: 'DELETE', filter }, (p) => {
        const row = oldRowOf(p) || rowOf(p);
        if (row) messagePane.applyDelete(row);
      });

      room.onBroadcast('typing', (payload) => {
        const data = (payload && payload.payload) || payload || {};
        if (!data.user_id || data.user_id === session.user.id) return;
        session.typing.set(data.user_id, Date.now() + TYPING_TTL_MS);
        paintTyping();
      });

      room.subscribe();
    } catch (err) {
      console.warn('[chat] realtime room unavailable', err);
    }
  }

  function presencePayload(extra) {
    return Object.assign({
      user_id: session.user.id,
      username: session.me.username,
      display_name: session.me.display_name || session.me.username,
      title: session.me.title || '',
      status: session.me.status || 'online',
    }, extra || {});
  }

  function trackPresence(extra) {
    try {
      if (session.lobby && session.lobby.track) session.lobby.track(presencePayload(extra));
    } catch (_) { /* presence is a nicety, never a requirement */ }
  }

  function handlePresence(raw) {
    const list = normalizePresence(raw);
    const next = new Map();
    for (const m of list) {
      const id = m.user_id || m.id;
      if (!id) continue;
      next.set(id, m);
    }
    session.presence = next;
    renderHead();
    paintTyping();
  }

  /** Tell the room I am typing, at most once every TYPING_MIN_GAP_MS. */
  function broadcastTyping() {
    const now = Date.now();
    if (now - lastTypingSent < TYPING_MIN_GAP_MS) return;
    lastTypingSent = now;
    const room = session.room;
    if (!room || typeof room.broadcast !== 'function') return;
    try {
      room.broadcast('typing', {
        user_id: session.user.id,
        display_name: displayName(session.user.id),
        ts: now,
      });
    } catch (_) { /* a dropped typing ping is not worth a message */ }
  }

  function paintTyping() {
    const names = [];
    session.typing.forEach((expiry, id) => {
      if (expiry > Date.now() && id !== session.user.id) names.push(displayName(id));
    });
    messagePane.setTyping(names);
  }

  /* =========================================================================
     8e. Reactions — the `reactions` TABLE is the truth; messages.reactions is
         a trigger-maintained mirror that rides along on realtime UPDATEs.
     ====================================================================== */

  /** Take the mirror map off a message row. @returns {boolean} did it change */
  function absorbReactions(row) {
    const map = reactionMap(row);
    if (!map) return false;
    const clean = {};
    for (const emoji of Object.keys(map)) {
      const users = Array.isArray(map[emoji]) ? map[emoji].map(String) : [];
      if (users.length) clean[emoji] = users;
    }
    const before = JSON.stringify(session.reactions.get(row.id) || {});
    session.reactions.set(row.id, clean);
    return before !== JSON.stringify(clean);
  }

  /** Called by the pane for each freshly fetched page. */
  async function loadReactions(ids) {
    const wanted = (ids || []).filter((id) => id != null && !session.reactions.has(id));
    if (!wanted.length) return;
    /* Seed empty so a message with no reactions is not re-queried every page. */
    wanted.forEach((id) => session.reactions.set(id, {}));
    const res = await db.select('reactions', { filters: { message_id: wanted }, limit: 1000 });
    if (res.error) return;
    const built = new Map();
    for (const r of rowsOf(res)) {
      if (!built.has(r.message_id)) built.set(r.message_id, {});
      const m = built.get(r.message_id);
      if (!m[r.emoji]) m[r.emoji] = [];
      m[r.emoji].push(String(r.author));
    }
    built.forEach((map, id) => session.reactions.set(id, map));
  }

  function reactionsFor(messageId) {
    return session.reactions.get(messageId) || {};
  }

  async function toggleReaction(row, emoji) {
    const me = session.user;
    if (!me || !row || !row.id) return;

    const current = reactionsFor(row.id);
    const next = {};
    Object.keys(current).forEach((k) => { next[k] = current[k].slice(); });
    const list = next[emoji] || [];
    const idx = list.indexOf(me.id);
    if (idx >= 0) list.splice(idx, 1); else list.push(me.id);
    if (list.length) next[emoji] = list; else delete next[emoji];

    session.reactions.set(row.id, next);
    messagePane.refreshReactions(row.id);
    haptic('soft');

    /* One round trip that both writes and returns the authoritative map. */
    const res = await db.rpc('toggle_reaction', { p_message_id: row.id, p_emoji: emoji });
    if (!res.error) {
      if (absorbReactions({ id: row.id, reactions: res.data })) messagePane.refreshReactions(row.id);
      return;
    }

    /* Older project without the RPC: write the reactions TABLE directly. */
    const fallback = idx >= 0
      ? await db.removeWhere('reactions', { message_id: row.id, author: me.id, emoji })
      : await db.insert('reactions', { message_id: row.id, author: me.id, emoji });
    if (fallback.error) {
      session.reactions.set(row.id, current);
      messagePane.refreshReactions(row.id);
      showError(fallback.error, 'That reaction did not save.');
    }
  }

  /* =========================================================================
     8f. Attachments — the bucket is PRIVATE, so every render needs a signature
         (SIGNATURE_TTL_MS lives at module scope; see the note there)
     ====================================================================== */

  function cachedAttachmentUrl(path) {
    const hit = session.fileUrls.get(path);
    if (hit && Date.now() - hit.at < SIGNATURE_TTL_MS) return hit.url;
    return '';
  }

  async function attachmentUrl(path) {
    if (!path) return '';
    const hit = cachedAttachmentUrl(path);
    if (hit) return hit;
    try {
      const res = await sb.storage.signedUrl(ATTACHMENT_BUCKET, path);
      if (res.error || !res.data) return '';
      session.fileUrls.set(path, { url: res.data, at: Date.now() });
      return res.data;
    } catch (_) {
      return '';
    }
  }

  /** Pre-sign a whole page in parallel so the cards paint without a flash. */
  async function ensureAttachmentUrls(rows) {
    const paths = [];
    for (const row of rows || []) {
      const p = row && row.attachment_path;
      if (p && !cachedAttachmentUrl(p) && paths.indexOf(p) < 0) paths.push(p);
    }
    if (!paths.length) return;
    await Promise.all(paths.map((p) => attachmentUrl(p)));
  }

  /* =========================================================================
     8g. Message operations
     ====================================================================== */

  async function sendMessage(payload, hooks) {
    const me = session.user;
    const channel = session.channel;
    if (!me || !channel) return { error: { message: 'No channel is open.' } };

    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const file = (payload.files || [])[0] || null;

    messagePane.addPending(tempId, {
      body: payload.body,
      replyTo: payload.replyTo,
      attachment: file ? {
        kind: file.kind, name: file.name, type: file.type, size: file.size,
        width: file.width, height: file.height, url: file.previewUrl || '',
      } : null,
    });

    let uploadedPath = null;
    let meta = null;
    try {
      if (file) {
        const up = await mods.attachments.uploadAttachment(sb, file, {
          ownerId: me.id,
          bucket: ATTACHMENT_BUCKET,
          onProgress: (f, label) => {
            messagePane.setPendingProgress(tempId, f, label);
            if (hooks && hooks.onProgress) hooks.onProgress(f, label);
          },
        });
        if (up.error) {
          messagePane.failPending(tempId, 'Upload failed');
          return { error: up.error };
        }
        uploadedPath = up.path;
        meta = {
          kind: file.kind, name: file.name, type: file.type, size: file.size,
          width: file.width, height: file.height, path: up.path,
        };
        if (up.url) session.fileUrls.set(up.path, { url: up.url, at: Date.now() });
      }

      const row = {
        channel_id: channel.id,
        author: me.id,
        content: String(payload.body || '').slice(0, CONFIG.LIMITS.messageMaxChars),
        reply_to: payload.replyTo || null,
      };
      if (uploadedPath) { row.attachment_path = uploadedPath; row.attachment_meta = meta; }

      const res = await db.insert('messages', row);
      if (res.error) {
        messagePane.failPending(tempId, 'Not sent');
        if (uploadedPath) await mods.attachments.removeAttachment(sb, uploadedPath, ATTACHMENT_BUCKET);
        return { error: res.error };
      }

      const saved = oneOf(res);
      messagePane.resolvePending(tempId, saved);
      if (!saved) setTimeout(() => messagePane.resolvePending(tempId, null), 2500);
      markRead(channel.id);
      haptic('tap');
      return {};
    } catch (err) {
      messagePane.failPending(tempId, 'Not sent');
      if (uploadedPath) await mods.attachments.removeAttachment(sb, uploadedPath, ATTACHMENT_BUCKET);
      return { error: { message: String((err && err.message) || err) } };
    }
  }

  /** messages_guard_update() stamps edited_at itself when content changes. */
  async function saveEdit(row, body) {
    const res = await db.update('messages', row.id, {
      content: String(body).slice(0, CONFIG.LIMITS.messageMaxChars),
    });
    if (res.error) return { error: res.error };
    messagePane.applyUpdate(oneOf(res) || Object.assign({}, row, { content: body, edited_at: new Date().toISOString() }));
    return {};
  }

  /**
   * Soft delete = a real TOMBSTONE. The row survives so replies still make
   * sense, but the text and the files go.
   *
   * Sending only `{deleted:true}` was not a delete at all: messages_select is
   * `using (true)` and returns every column, so anybody with DevTools could
   * read the "deleted" text, and the file stayed in the bucket with a signable
   * path. The schema is built for this — messages_not_empty starts with
   * `deleted or …` precisely so a tombstone may be empty, and the alias trigger
   * has a branch for "the caller emptied the array deliberately (this is what a
   * soft delete does)". The client simply never used either.
   */
  async function deleteMessage(row) {
    const ok = await openConfirm({
      title: 'Delete this message?',
      body: 'The text and any file are removed. A "deleted" placeholder stays so replies '
          + 'to it still make sense. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'bad',
    });
    if (!ok) return;
    const patch = { deleted: true, content: '', attachments: [] };
    const res = await db.update('messages', row.id, patch);
    if (res.error) { showError(res.error, 'That message was not deleted.'); return; }

    // Best effort, and only after the row is a tombstone: if this fails the
    // object is orphaned but no longer reachable through the UI.
    const paths = (Array.isArray(row.attachments) ? row.attachments : [])
      .map((a) => a && a.path).filter(Boolean);
    if (row.attachment_path) paths.push(row.attachment_path);
    if (paths.length && sb && sb.storage && typeof sb.storage.remove === 'function') {
      for (const p of Array.from(new Set(paths))) {
        try { await sb.storage.remove(ATTACHMENT_BUCKET, p); } catch (_) { /* orphan, not a leak */ }
      }
    }

    messagePane.applyUpdate(oneOf(res) || Object.assign({}, row, patch));
  }

  /** Admin only — messages_guard_update() refuses a pin from anybody else. */
  async function togglePin(row, next) {
    const patch = next ? { pinned: true, pinned_by: session.user.id } : { pinned: false };
    const res = await db.update('messages', row.id, patch);
    if (res.error) { showError(res.error, 'The pin did not change.'); return; }
    messagePane.applyUpdate(oneOf(res) || Object.assign({}, row, { pinned: Boolean(next) }));
    toast(next ? 'Pinned' : 'Unpinned', { tone: 'good' });
  }

  /* =========================================================================
     8h. Celebrations — one post, never a burst (the 5 s cooldown is real)
     ====================================================================== */

  async function flushCelebrations() {
    const queue = (readCache().celebrations || []).filter((c) => c && c.label);
    if (!queue.length || !session.channel || !session.user) return;
    patchCache({ celebrations: [] });

    const kind = queue.some((c) => c.kind === 'celebration') ? 'celebration' : 'note';
    const text = queue.length === 1
      ? queue[0].label
      : queue.map((c) => '- ' + c.label).join('\n');

    const res = await db.insert('messages', {
      channel_id: session.channel.id,
      author: session.user.id,
      content: text.slice(0, CONFIG.LIMITS.messageMaxChars),
      is_system: true,
      system_kind: kind,
      attachment_meta: { system: kind },
    });
    if (res.error) {
      /* Put it back rather than lose it, and stop trying until next time. */
      patchCache({ celebrations: queue });
      console.warn('[chat] celebration post refused', res.error);
      return;
    }
    const saved = oneOf(res);
    if (saved) messagePane.applyInsert(saved);
  }

  /* =========================================================================
     8i. Profile card + members
     ====================================================================== */

  async function openProfile(userId, anchor) {
    let profile = session.profiles.get(userId);
    if (!profile) {
      const res = await db.select('profiles', { filters: { id: userId }, limit: 1 });
      profile = oneOf(res);
      if (profile) session.profiles.set(userId, profile);
    }
    if (!profile) { toast('That profile could not be loaded.', { tone: 'info' }); return; }

    const isMe = session.user && session.user.id === userId;
    const status = statusMeta(presenceOf(userId) || profile.status);
    const card = el('div.ch-prof', { style: { '--accent': 'var(--brand)', '--accent-rgb': 'var(--brand-rgb)' } });

    const avatar = el('span.ch-prof__av');
    const src = avatarUrl(profile);
    if (src) avatar.appendChild(el('img', { attrs: { src, alt: '' } }));
    else avatar.appendChild(el('span', { text: String(profile.display_name || profile.username || '?').charAt(0).toUpperCase() }));

    card.appendChild(el('div.ch-prof__top', avatar,
      el('div.stack',
        el('span.ch-prof__name', { text: profile.display_name || profile.username || 'Someone' }),
        el('span.ch-prof__handle', { text: '@' + (profile.username || 'unknown') }))));

    if (profile.title) card.appendChild(el('div.ch-prof__row', el('span.pill.pill--accent', { text: profile.title })));
    if (profile.is_admin) card.appendChild(el('div.ch-prof__row', el('span.pill.pill--info', icon('shield', { size: 12 }), 'Admin')));

    card.appendChild(el('div.ch-prof__row',
      icon(status.icon, { size: 14 }),
      el('span', { text: status.label }),
      el('span.text-meta', { text: '· ' + status.note })));

    if (profile.bio) {
      const bio = el('p.ch-prof__bio');
      renderInlineInto(bio, String(profile.bio).slice(0, CONFIG.LIMITS.bioMaxChars));
      card.appendChild(bio);
    }

    const actions = el('div.btn-row', { style: { marginTop: 'var(--sp-3)' } });
    actions.appendChild(el('button.btn.btn-secondary.btn--sm', {
      type: 'button', text: 'View shared items',
      onClick: () => { closeAllLayers(); openSharedItems(userId); },
    }));
    if (isMe) {
      actions.appendChild(el('button.btn.btn-ghost.btn--sm', {
        type: 'button', text: 'Edit profile',
        onClick: () => { closeAllLayers(); openProfileEditor(); },
      }));
      actions.appendChild(el('button.btn.btn-ghost.btn--sm', {
        type: 'button', text: 'Sign out',
        onClick: async () => {
          closeAllLayers();
          try { await sb.auth.signOut(); } catch (_) { /* ignore */ }
          session.user = null;
          session.me = null;
          navigate('chat');
        },
      }));
    } else if (hub.isAdmin()) {
      actions.appendChild(el('button.btn.btn-ghost.btn--sm', {
        type: 'button', text: 'Moderate',
        onClick: () => { closeAllLayers(); mods.admin.openModeration(hub, userId, 'mute'); },
      }));
    }
    card.appendChild(actions);

    if (anchor && matchMedia('(min-width: 768px)').matches) openPopover(anchor, card);
    else openSheet({ title: profile.display_name || profile.username || 'Profile', body: card });
  }

  function openProfileEditor() {
    const me = session.me;
    const display = el('input.input', { value: me.display_name || '', attrs: { maxlength: String(CONFIG.LIMITS.displayNameMaxChars) } });
    const bio = el('textarea.textarea', { value: me.bio || '', attrs: { maxlength: String(CONFIG.LIMITS.bioMaxChars), placeholder: 'One line about you' } });
    const titleInput = el('input.input', { value: me.title || '', attrs: { maxlength: String(TITLE_MAX), placeholder: 'A title you have earned' } });

    const statusWrap = el('div.chip-row');
    let chosen = me.status || 'online';
    const paintStatus = () => {
      clear(statusWrap);
      STATUSES.forEach((s) => {
        statusWrap.appendChild(el('button.chip.chip--button', {
          type: 'button',
          class: chosen === s.id ? 'is-active' : '',
          attrs: { 'aria-pressed': chosen === s.id ? 'true' : 'false', title: s.note },
          dataset: { tone: s.tone },
          onClick: () => { chosen = s.id; paintStatus(); },
        }, icon(s.icon, { size: 14 }), el('span', { text: s.label })));
      });
    };
    paintStatus();

    const body = el('div.stack',
      field('Display name', display),
      field('Title', titleInput, 'Shown as a chip beside your name.'),
      field('About you', bio),
      el('div.field', el('span.label', { text: 'Status' }), statusWrap,
        el('span.hint', { text: 'Studying shows a book beside your name and tells people you are reachable on social media.' })));

    const modal = openModal({
      title: 'Your profile',
      icon: 'user',
      body,
      foot: el('div.btn-row',
        el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => modal.close() }),
        el('button.btn.btn-primary', {
          type: 'button', text: 'Save',
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            const patch = {
              display_name: display.value.trim().slice(0, CONFIG.LIMITS.displayNameMaxChars) || me.username,
              bio: bio.value.trim().slice(0, CONFIG.LIMITS.bioMaxChars) || null,
              title: titleInput.value.trim().slice(0, TITLE_MAX) || null,
              status: chosen,
            };
            const res = await db.update('profiles', me.id, patch);
            btn.disabled = false;
            if (res.error) { showError(res.error, 'Your profile did not save.'); return; }
            Object.assign(session.me, patch);
            session.profiles.set(me.id, session.me);
            trackPresence();
            modal.close();
            if (session.channel) messagePane.load(session.channel.id);
            toast('Profile saved', { tone: 'good' });
          },
        })),
    });
  }

  async function openSharedItems(userId) {
    const body = el('div.stack', el('div.ch__loading', icon('loader', { size: 16, cls: 'icon-spin' })));
    const modal = openModal({ title: 'Shared by ' + displayName(userId), icon: 'layers', body });

    const res = await db.select('shared_items', {
      filters: { owner_id: userId },
      order: { column: 'created_at', ascending: false },
      limit: 50,
    });
    clear(body);
    if (res.error) { body.appendChild(el('p.text-meta', { text: 'Those items could not be loaded.' })); return; }
    const rows = rowsOf(res);
    if (!rows.length) {
      body.appendChild(el('p.text-meta', { text: 'Nothing shared yet.' }));
      return;
    }
    const TYPE_ICON = { deck: 'layers', map: 'waypoints', note: 'file-text' };
    for (const item of rows) {
      body.appendChild(el('div.ch-admin__row',
        el('span.icon-tile.icon-tile--sm', icon(TYPE_ICON[item.type] || 'file-text', { size: 14 })),
        el('span.ch-admin__rowmain',
          el('span.ch-admin__name', { text: item.title || 'Untitled' }),
          el('span.text-meta', { text: String(item.type || 'item') + ' · ' + fmt.rel(item.created_at) })),
        el('button.btn.btn-secondary.btn--sm', {
          type: 'button',
          text: item.type === 'deck' ? 'Import' : 'Open',
          onClick: () => { modal.close(); openSharedItem(item); },
        })));
    }
  }

  function openSharedItem(item) {
    let parsed = null;
    try { parsed = typeof item.body === 'string' ? JSON.parse(item.body) : item.body; }
    catch (_) { parsed = null; }

    if (item.type === 'deck') {
      if (!parsed || !Array.isArray(parsed.cards) || !parsed.cards.length) {
        toast('That deck is empty or malformed.', { tone: 'warn' });
        return;
      }
      /* Phase B-F stitch: 'engram:import-deck' is a NOTIFICATION that a deck
         WAS imported (community.js fires it after writing USER_CARDS + SRS);
         dispatching it alone imported nothing. Call the owner of the import
         path — it writes the cards, seeds FSRS, invalidates the study pool
         and fires the event itself. */
      import('../community.js')
        .then((mod) => {
          if (!mod || typeof mod.importDeckToFsrs !== 'function') throw new Error('no importer');
          const res = mod.importDeckToFsrs(parsed, {
            id: item.id, title: item.title, subject: parsed.subject, unit: parsed.unit,
          });
          if (res && res.added) {
            toast(res.added + ' ' + fmt.plural(res.added, 'card') + ' added to your decks'
              + (res.skipped ? ' · ' + res.skipped + ' already there' : ''), { tone: 'good' });
          } else {
            toast('Every card in that deck is already in your decks.', { tone: 'info' });
          }
        })
        .catch(() => toast('Import failed — the deck importer could not be loaded.', { tone: 'bad' }));
      return;
    }
    if (item.type === 'note') {
      const node = el('div.prose');
      renderMarkdownInto(node, String((parsed && parsed.md) || ''));
      openModal({ title: item.title || 'Note', icon: 'file-text', body: node });
      return;
    }
    toast('Opening shared maps happens on the Maps screen.', { tone: 'info' });
    navigate('maps');
  }

  function openMembers() {
    const body = el('div.stack');
    const list = Array.from(session.presence.values());
    if (!list.length) {
      body.appendChild(el('p.text-meta', { text: 'Nobody else is here right now. Messages still arrive when they open the app.' }));
    }
    list.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
    for (const m of list) {
      const meta = statusMeta(m.status);
      body.appendChild(el('button.ch-members__row', {
        type: 'button',
        onClick: () => { closeAllLayers(); openProfile(m.user_id); },
      },
      icon(meta.icon, { size: 16 }),
      el('span.ch-admin__rowmain',
        el('span.ch-admin__name', { text: m.display_name || m.username || 'Someone' }),
        el('span.text-meta', { text: meta.label + ' · ' + meta.note })),
      el('span.dot', { dataset: { tone: meta.tone } })));
    }
    openSheet({ title: 'Who is here', body });
  }

  /* =========================================================================
     8j. UI layers
     ====================================================================== */

  function closeAllLayers() {
    session.layers.slice().forEach((close) => { try { close(); } catch (_) { /* ignore */ } });
    session.layers = [];
  }

  /** Register a teardown so onExit() can close whatever is still open. */
  function track(close) {
    session.layers.push(close);
    return () => {
      const i = session.layers.indexOf(close);
      if (i >= 0) session.layers.splice(i, 1);
      close();
    };
  }

  function layerScrim(onClose) {
    const scrim = el('div.scrim', { onClick: onClose });
    if (prefersReducedMotion()) scrim.style.animation = 'none';
    return scrim;
  }

  function openSheet(spec) {
    const o = spec || {};
    const previous = document.activeElement;
    let close = () => {};
    const scrim = layerScrim(() => close());
    const sheet = el('div.sheet', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Options' } },
      el('span.sheet__grip'),
      el('div.modal__head', el('h2.modal__title', { text: o.title || '' }),
        el('button.btn.btn-ghost.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Close' }, onClick: () => close(),
        }, icon('x', { size: 16 }))),
      el('div.modal__body', o.body || null));

    const offKey = on(document, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    document.body.append(scrim, sheet);
    const focusable = sheet.querySelector('button, [href], input, textarea, select');
    if (focusable) focusable.focus();

    close = track(() => {
      offKey();
      scrim.remove();
      sheet.remove();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    });
    return close;
  }

  function openModal(spec) {
    const o = spec || {};
    const previous = document.activeElement;
    let close = () => {};
    const scrim = layerScrim(() => close());
    const node = el('div.modal', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Dialog' } },
      el('div.modal__head',
        el('h2.modal__title', o.icon ? icon(o.icon, { size: 16 }) : null, el('span', { text: o.title || '' })),
        el('button.btn.btn-ghost.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Close' }, onClick: () => close(),
        }, icon('x', { size: 16 }))),
      el('div.modal__body', o.body || null),
      o.foot ? el('div.modal__foot', o.foot) : null);
    if (o.wide) node.style.width = 'min(720px, calc(100vw - var(--sp-8)))';

    const offKey = on(document, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    document.body.append(scrim, node);
    const focusable = node.querySelector('button, [href], input, textarea, select');
    if (focusable) focusable.focus();

    close = track(() => {
      offKey();
      scrim.remove();
      node.remove();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    });
    return { el: node, body: node.querySelector('.modal__body'), close: () => close() };
  }

  function openPopover(anchor, content) {
    let close = () => {};
    const node = el('div.ch-pop', content);
    node.style.visibility = 'hidden';
    document.body.appendChild(node);

    const rect = anchor.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - box.width - margin));
    let top = rect.bottom + margin;
    if (top + box.height > window.innerHeight - margin) top = Math.max(margin, rect.top - box.height - margin);
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
    node.style.visibility = '';

    const offDoc = on(document, 'pointerdown', (e) => {
      if (!node.contains(e.target) && e.target !== anchor) close();
    }, true);
    const offKey = on(document, 'keydown', (e) => { if (e.key === 'Escape') close(); });
    const offResize = on(window, 'resize', () => close());

    close = track(() => { offDoc(); offKey(); offResize(); node.remove(); });
    return () => close();
  }

  function openActionSheet(spec) {
    const o = spec || {};
    const list = el('div.ch-sheet__list');
    let close = () => {};
    (o.items || []).forEach((item) => {
      list.appendChild(el('button.ch-sheet__item', {
        type: 'button',
        dataset: item.tone ? { tone: item.tone } : null,
        onClick: () => { close(); item.run(); },
      }, icon(item.icon || 'circle-check', { size: 16 }), el('span', { text: item.label })));
    });
    close = openSheet({ title: o.title || 'Options', body: list });
    return close;
  }

  function openConfirm(spec) {
    const o = spec || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (done) return; done = true; modal.close(); resolve(value); };
      const modal = openModal({
        title: o.title || 'Are you sure?',
        body: el('p', { text: o.body || '' }),
        foot: el('div.btn-row',
          el('button.btn.btn-ghost', { type: 'button', text: o.cancelLabel || 'Cancel', onClick: () => finish(false) }),
          el('button', {
            type: 'button',
            class: 'btn ' + (o.tone === 'bad' ? 'btn-danger' : 'btn-primary'),
            text: o.confirmLabel || 'Yes',
            onClick: () => finish(true),
          })),
      });
    });
  }

  function burstConfetti() {
    if (prefersReducedMotion()) return;
    const layer = el('div.confetti-layer');
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight * 0.42;
    for (let i = 0; i < 28; i += 1) {
      const angle = (Math.PI * 2 * i) / 28 + Math.random() * 0.4;
      const dist = 120 + Math.random() * 160;
      layer.appendChild(el('span.confetti-piece', {
        style: {
          left: cx + 'px',
          top: cy + 'px',
          background: 'var(--confetti-' + (1 + (i % 6)) + ')',
          '--tx': Math.round(Math.cos(angle) * dist) + 'px',
          '--ty': Math.round(Math.sin(angle) * dist + 140) + 'px',
          '--rot': Math.round(180 + Math.random() * 540) + 'deg',
          animationDelay: (i % 7) * 18 + 'ms',
        },
      }));
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1200);
  }

  /* =========================================================================
     8k. Errors — a refusal is explained, never dumped
     ====================================================================== */

  function showError(error, fallback) {
    const e = error || {};
    const msg = String(e.message || '');

    if (e.code === 'banned') { toast('You are banned from chat right now.', { tone: 'bad', timeout: 7000 }); return; }
    if (e.code === 'muted') { toast(msg || 'You are muted right now.', { tone: 'warn', timeout: 7000 }); return; }
    if (e.code === 'rate_limited') {
      const secs = Number(e.retryAfterSec || 0);
      toast(secs ? 'One moment — try again in ' + Math.ceil(secs) + ' s.' : 'Slow down a moment, then try again.', { tone: 'info' });
      return;
    }
    if (e.code === 'offline' || e.code === 'network' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      toast('You are offline — chat will catch up when the connection returns.', { tone: 'warn' });
      return;
    }
    if (e.code === 'forbidden' || /row-level security|permission|denied|not authorized/i.test(msg)) {
      toast('The server said no to that one — it is a permissions rule, not you.', { tone: 'warn', timeout: 6000 });
      return;
    }
    toast(fallback || msg || 'That did not work.', { tone: 'bad', timeout: 6000 });
    if (msg) console.warn('[chat]', msg, error);
  }
}
