/* =============================================================================
   js/chat/admin.js — Job CHAT. Moderation, only ever mounted for an admin.

   Nothing in this file is a security boundary. It decides which BUTTONS are
   drawn; the real authorisation is the RLS policy in supabase/schema.sql, which
   checks auth.uid() server-side (`profiles.is_admin`, never CONFIG.ADMIN_EMAIL).
   If the server refuses, the toast says so plainly.

   SCHEMA THIS FILE SPEAKS (supabase/schema.sql):
     channels(id, name '^[a-z0-9-]{1,24}$', description, locked, position, created_by)
     profiles(id, username, display_name, is_admin, …)
     mutes(id, user_id, until timestamptz NULL=indefinite, reason, created_by)
     bans (id, user_id, until timestamptz NULL=permanent,   reason, created_by)
     groups(id, name, created_by) · group_members(id, group_id, user_id, role)

   A mute/ban is a ROW, not a column: lifting one deletes the rows. Expiries are
   INSTANTS (timestamptz), so they are built with Date arithmetic — calendar-day
   maths anywhere in this codebase still goes through store.js's local helpers.
   ========================================================================== */

import CONFIG from '../config.js';
import { el, icon, fmt, toast, debounce } from '../dom.js';

/* ---------------------------------------------------------------------------
   1. Who is an admin
   ------------------------------------------------------------------------ */

/**
 * @param {object|null} profile the profiles row
 * @param {object|null} user the auth user
 * @returns {boolean} whether to DRAW the moderation UI
 */
export function isAdminProfile(profile, user) {
  if (profile && profile.is_admin === true) return true;
  const email = String((user && user.email) || '').toLowerCase();
  const configured = String(CONFIG.ADMIN_EMAIL || '').toLowerCase();
  return Boolean(email) && email === configured && configured !== 'you@example.com';
}

/* ---------------------------------------------------------------------------
   2. Durations
   ------------------------------------------------------------------------ */

const MINUTE = 60 * 1000;
export const DURATIONS = [
  { label: '10 minutes', ms: 10 * MINUTE },
  { label: '1 hour', ms: 60 * MINUTE },
  { label: '8 hours', ms: 8 * 60 * MINUTE },
  { label: '1 day', ms: 24 * 60 * MINUTE },
  { label: '7 days', ms: 7 * 24 * 60 * MINUTE },
  { label: 'Until lifted', ms: 0 },        // NULL until = indefinite
];

const untilFrom = (ms) => (ms ? new Date(Date.now() + ms).toISOString() : null);

/** Human text for a mute/ban expiry (null = indefinite). */
export function untilLabel(iso) {
  if (!iso) return 'until lifted';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'until lifted';
  return 'until ' + fmt.dateShort(t) + ' ' + fmt.time(t);
}

/** True when a mutes/bans row is still in force. */
export function rowActive(row) {
  if (!row) return false;
  if (!row.until) return true;                       // NULL = indefinite
  const t = Date.parse(row.until);
  return !Number.isFinite(t) || t > Date.now();
}

/** The strongest active restriction in a list, or null. */
export function activeRestriction(rows) {
  const live = (rows || []).filter(rowActive);
  if (!live.length) return null;
  if (live.some((r) => !r.until)) return live.find((r) => !r.until);
  return live.sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
}

/* ---------------------------------------------------------------------------
   3. Per-message admin actions
   ------------------------------------------------------------------------ */

/**
 * Extra entries for the message action sheet. The caller has already checked
 * hub.isAdmin(); these are the items that act on the AUTHOR.
 * @returns {Array<{icon:string,label:string,tone?:string,run:Function}>}
 */
export function messageAdminActions(hub, msg) {
  const authorId = msg && msg.author;
  if (!authorId) return [];
  const name = hub.displayName(authorId);
  return [
    { icon: 'alert-triangle', label: 'Mute ' + name, run: () => openModeration(hub, authorId, 'mute') },
    { icon: 'shield', label: 'Ban ' + name, tone: 'bad', run: () => openModeration(hub, authorId, 'ban') },
  ];
}

/* ---------------------------------------------------------------------------
   4. Mute / ban sheet
   ------------------------------------------------------------------------ */

export async function openModeration(hub, userId, mode) {
  const kind = mode === 'ban' ? 'ban' : 'mute';
  const table = kind === 'ban' ? 'bans' : 'mutes';
  const name = hub.displayName(userId);

  const existing = await hub.db.select(table, { filters: { user_id: userId }, limit: 20 });
  const rows = existing.error ? [] : (existing.data || []);
  const active = activeRestriction(rows);

  const body = el('div.stack');
  body.appendChild(el('p.text-meta', {
    text: kind === 'ban'
      ? 'A ban blocks posting and reacting. Reading stays open, so realtime history does not break.'
      : 'A mute blocks posting and reacting. Reading stays open.',
  }));

  if (active) {
    body.appendChild(el('div.card.card--quiet',
      el('p', { text: name + ' is ' + (kind === 'ban' ? 'banned ' : 'muted ') + untilLabel(active.until) + '.' }),
      el('button.btn.btn-secondary.btn--block', {
        type: 'button', text: kind === 'ban' ? 'Lift the ban' : 'Unmute',
        onClick: () => lift(),
      })));
  }

  const grid = el('div.ch-admin__durations');
  for (const d of DURATIONS) {
    grid.appendChild(el('button.btn.btn-secondary', {
      type: 'button', text: d.label,
      onClick: () => apply(untilFrom(d.ms)),
    }));
  }
  body.appendChild(el('p.label', { text: kind === 'ban' ? 'Ban for' : 'Mute for' }));
  body.appendChild(grid);

  const reason = el('input.input', { attrs: { placeholder: 'Reason (optional)', maxlength: '200' } });
  body.appendChild(el('label.field', el('span.label', { text: 'Reason' }), reason));

  const close = hub.ui.sheet({ title: (kind === 'ban' ? 'Ban ' : 'Mute ') + name, body });

  async function apply(until) {
    const res = await hub.db.insert(table, {
      user_id: userId,
      until,
      reason: reason.value.trim().slice(0, 200) || null,
    });
    if (res.error) { hub.err(res.error, 'That did not save.'); return; }
    toast(name + ' is ' + (kind === 'ban' ? 'banned ' : 'muted ') + untilLabel(until), { tone: 'warn' });
    close();
    hub.refreshRestrictions();
  }

  async function lift() {
    for (const row of rows.filter(rowActive)) {
      /* eslint-disable no-await-in-loop */
      const res = await hub.db.remove(table, row.id);
      /* eslint-enable no-await-in-loop */
      if (res.error) { hub.err(res.error, 'That did not lift.'); return; }
    }
    toast(name + ' is back to normal', { tone: 'good' });
    close();
    hub.refreshRestrictions();
  }
}

/* ---------------------------------------------------------------------------
   5. The admin panel
   ------------------------------------------------------------------------ */

const TABS = [
  { id: 'channels', label: 'Channels', icon: 'message-circle' },
  { id: 'people', label: 'People', icon: 'user' },
  { id: 'groups', label: 'Groups', icon: 'layers' },
  { id: 'pins', label: 'Pins', icon: 'pin' },
];

export function openAdminPanel(hub, opts) {
  const o = opts || {};
  let tab = o.tab || 'channels';

  const panelBody = el('div.ch-admin__body');
  const tabs = el('div.segmented.ch-admin__tabs', { attrs: { role: 'tablist' } });

  const modal = hub.ui.modal({
    title: 'Moderation',
    icon: 'shield',
    wide: true,
    body: el('div.stack', tabs, panelBody),
  });

  function paintTabs() {
    tabs.replaceChildren();
    for (const t of TABS) {
      tabs.appendChild(el('button.segmented__btn', {
        type: 'button',
        class: t.id === tab ? 'is-active' : '',
        attrs: { role: 'tab', 'aria-selected': t.id === tab ? 'true' : 'false' },
        onClick: () => { tab = t.id; paintTabs(); paint(); },
      }, icon(t.icon, { size: 14 }), el('span', { text: t.label })));
    }
  }

  function paint() {
    panelBody.replaceChildren(el('div.ch__loading', icon('loader', { size: 16, cls: 'icon-spin' })));
    if (tab === 'channels') renderChannels(hub, panelBody);
    else if (tab === 'people') renderPeople(hub, panelBody);
    else if (tab === 'groups') renderGroups(hub, panelBody);
    else renderPins(hub, panelBody, modal);
  }

  paintTabs();
  paint();
  return modal;
}

/* ------------------------------------------------------------- 5a. channels */

/** channels.name is the handle itself: lowercase, digits, hyphens, ≤24 chars. */
export function channelName(input) {
  const s = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return s || 'channel';
}

async function renderChannels(hub, host) {
  const channels = hub.channels();
  host.replaceChildren();

  const nameInput = el('input.input', { attrs: { placeholder: 'physics-doubts', maxlength: '24', 'aria-label': 'New channel name' } });
  const descInput = el('input.input', { attrs: { placeholder: 'What it is for (optional)', maxlength: '140', 'aria-label': 'Channel description' } });

  host.appendChild(el('div.card.card--quiet.ch-admin__create',
    el('p.label', { text: 'New channel' }),
    el('div.ch-admin__createrow', nameInput, descInput,
      el('button.btn.btn-primary', {
        type: 'button', text: 'Create',
        onClick: async (e) => {
          const btn = e.currentTarget;
          const name = channelName(nameInput.value);
          if (!nameInput.value.trim()) { nameInput.focus(); return; }
          btn.disabled = true;
          const res = await hub.db.insert('channels', {
            name,
            description: descInput.value.trim().slice(0, 140) || null,
            position: channels.length,
            locked: false,
            created_by: hub.user().id,
          });
          btn.disabled = false;
          if (res.error) { hub.err(res.error, 'The channel was not created.'); return; }
          nameInput.value = '';
          descInput.value = '';
          await hub.refreshChannels();
          toast('#' + name + ' created', { tone: 'good' });
          renderChannels(hub, host);
        },
      })),
    el('p.hint', { text: 'Lowercase letters, numbers and hyphens — anything else is converted.' })));

  const list = el('div.ch-admin__list');
  if (!channels.length) list.appendChild(emptyLine('No channels yet.'));

  channels.forEach((c, i) => {
    list.appendChild(el('div.ch-admin__row',
      el('span.icon-tile.icon-tile--sm', icon(c.locked ? 'lock' : 'message-circle', { size: 14 })),
      el('span.ch-admin__rowmain',
        el('span.ch-admin__name', { text: '#' + c.name }),
        el('span.text-meta', { text: (c.description ? c.description + ' · ' : '') + (c.locked ? 'Locked' : 'Open') })),
      el('div.btn-row',
        el('button.btn.btn-ghost.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Move up', title: 'Move up' },
          disabled: i === 0, onClick: () => move(c, -1),
        }, icon('chevron-up', { size: 14 })),
        el('button.btn.btn-ghost.btn-icon.btn--sm', {
          type: 'button', attrs: { 'aria-label': 'Move down', title: 'Move down' },
          disabled: i === channels.length - 1, onClick: () => move(c, 1),
        }, icon('chevron-down', { size: 14 })),
        el('button.btn.btn-secondary.btn--sm', {
          type: 'button', text: c.locked ? 'Unlock' : 'Lock',
          onClick: async (e) => {
            const btn = e.currentTarget;          // currentTarget is null after the await
            btn.disabled = true;
            const res = await hub.db.update('channels', c.id, { locked: !c.locked });
            if (res.error) { hub.err(res.error, 'The lock did not change.'); btn.disabled = false; return; }
            await hub.refreshChannels();
            renderChannels(hub, host);
          },
        }))));
  });
  host.appendChild(list);

  async function move(channel, delta) {
    const ordered = hub.channels().slice();
    const from = ordered.findIndex((x) => x.id === channel.id);
    const to = from + delta;
    if (to < 0 || to >= ordered.length) return;
    const other = ordered[to];
    const a = await hub.db.update('channels', channel.id, { position: to });
    const b = await hub.db.update('channels', other.id, { position: from });
    if (a.error || b.error) { hub.err(a.error || b.error, 'The order did not save.'); return; }
    await hub.refreshChannels();
    renderChannels(hub, host);
  }
}

/* --------------------------------------------------------------- 5b. people */

async function renderPeople(hub, host) {
  const [people, mutes, bans] = await Promise.all([
    hub.loadPeople(true),
    hub.db.select('mutes', { limit: 200 }),
    hub.db.select('bans', { limit: 200 }),
  ]);
  const muteRows = mutes.error ? [] : (mutes.data || []);
  const banRows = bans.error ? [] : (bans.data || []);
  const activeFor = (rows, id) => activeRestriction(rows.filter((r) => String(r.user_id) === String(id)));

  host.replaceChildren();
  const search = el('input.input', { attrs: { placeholder: 'Find someone', 'aria-label': 'Find someone', type: 'search' } });
  const list = el('div.ch-admin__list');
  host.appendChild(el('div.field', search));
  host.appendChild(list);

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const rows = people.filter((p) => !q
      || String(p.username || '').toLowerCase().indexOf(q) >= 0
      || String(p.display_name || '').toLowerCase().indexOf(q) >= 0);
    list.replaceChildren();
    if (!rows.length) { list.appendChild(emptyLine('Nobody matches that.')); return; }
    for (const p of rows) {
      const mute = activeFor(muteRows, p.id);
      const ban = activeFor(banRows, p.id);
      list.appendChild(el('div.ch-admin__row',
        el('span.icon-tile.icon-tile--sm', { text: String(p.display_name || p.username || '?').charAt(0).toUpperCase() }),
        el('span.ch-admin__rowmain',
          el('span.ch-admin__name', { text: p.display_name || p.username || 'Someone' }),
          el('span.text-meta', {
            text: '@' + (p.username || 'unknown')
              + (p.is_admin ? ' · admin' : '')
              + (ban ? ' · banned ' + untilLabel(ban.until) : mute ? ' · muted ' + untilLabel(mute.until) : ''),
          })),
        el('div.btn-row',
          el('button.btn.btn-secondary.btn--sm', {
            type: 'button', text: mute ? 'Muted' : 'Mute',
            onClick: () => openModeration(hub, p.id, 'mute'),
          }),
          el('button.btn.btn-danger.btn--sm', {
            type: 'button', text: ban ? 'Banned' : 'Ban',
            onClick: () => openModeration(hub, p.id, 'ban'),
          }),
          el('button.btn.btn-ghost.btn-icon.btn--sm', {
            type: 'button',
            attrs: { 'aria-label': p.is_admin ? 'Remove admin' : 'Make admin', title: p.is_admin ? 'Remove admin' : 'Make admin' },
            onClick: async () => {
              const ok = await hub.ui.confirm({
                title: p.is_admin ? 'Remove admin rights?' : 'Make this person an admin?',
                body: p.is_admin
                  ? (p.display_name || p.username) + ' will lose the moderation tools.'
                  : (p.display_name || p.username) + ' will be able to delete, pin, mute and ban.',
              });
              if (!ok) return;
              const res = await hub.db.update('profiles', p.id, { is_admin: !p.is_admin });
              if (res.error) { hub.err(res.error, 'That change did not save.'); return; }
              p.is_admin = !p.is_admin;
              paint();
            },
          }, icon(p.is_admin ? 'crown' : 'shield', { size: 14 })))));
    }
  };

  search.addEventListener('input', debounce(paint, 160));
  paint();
}

/* --------------------------------------------------------------- 5c. groups */

async function renderGroups(hub, host) {
  const [groups, people, memberships] = await Promise.all([
    hub.loadGroups(true), hub.loadPeople(), hub.loadGroupMembers(true),
  ]);
  host.replaceChildren();

  const nameInput = el('input.input', { attrs: { placeholder: 'Group name', maxlength: '40', 'aria-label': 'New group name' } });
  host.appendChild(el('div.card.card--quiet.ch-admin__create',
    el('p.label', { text: 'New group' }),
    el('div.ch-admin__createrow', nameInput,
      el('button.btn.btn-primary', {
        type: 'button', text: 'Create',
        onClick: async (e) => {
          const btn = e.currentTarget;
          const name = nameInput.value.trim();
          if (!name) { nameInput.focus(); return; }
          btn.disabled = true;
          const res = await hub.db.insert('groups', { name: name.slice(0, 40), created_by: hub.user().id });
          btn.disabled = false;
          if (res.error) { hub.err(res.error, 'The group was not created.'); return; }
          nameInput.value = '';
          hub.invalidateGroups();
          renderGroups(hub, host);
        },
      })),
    el('p.hint', { text: 'Groups decide who can see a shared deck, map or note.' })));

  const byGroup = new Map();
  groups.forEach((g) => byGroup.set(String(g.id), []));
  const ungrouped = [];
  const groupOf = new Map();
  memberships.forEach((m) => groupOf.set(String(m.user_id), String(m.group_id)));
  people.forEach((p) => {
    const gid = groupOf.get(String(p.id));
    if (gid && byGroup.has(gid)) byGroup.get(gid).push(p);
    else ungrouped.push(p);
  });

  const board = el('div.ch-admin__board');
  board.appendChild(column({ id: '', name: 'No group' }, ungrouped));
  groups.forEach((g) => board.appendChild(column(g, byGroup.get(String(g.id)) || [])));
  host.appendChild(board);
  host.appendChild(el('p.hint', { text: 'Drag a person between columns, or use the menu on their chip — both do the same thing.' }));

  function column(group, members) {
    const drop = el('div.ch-admin__col', { dataset: { group: String(group.id || '') } },
      el('div.ch-admin__colhead',
        el('span.eyebrow', el('span', { text: group.name })),
        el('span.pill.pill--neutral', { text: String(members.length) })));

    members.forEach((p) => drop.appendChild(chip(p, group)));
    if (!members.length) drop.appendChild(el('p.text-meta.ch-admin__coldrop', { text: 'Drop someone here' }));

    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const userId = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (userId) assign(userId, group.id || null);
    });
    return drop;
  }

  function chip(person, group) {
    const node = el('div.ch-admin__chip', {
      attrs: { draggable: 'true' },
      dataset: { user: String(person.id) },
    },
    el('span.truncate', { text: person.display_name || person.username || 'Someone' }),
    el('button.btn.btn-ghost.btn-icon.btn--sm', {
      type: 'button', attrs: { 'aria-label': 'Move to another group' },
      onClick: () => {
        const items = [{ icon: 'x', label: 'No group', run: () => assign(person.id, null) }]
          .concat(groups.map((g) => ({ icon: 'layers', label: g.name, run: () => assign(person.id, g.id) })))
          .filter((it) => it.label !== group.name);
        hub.ui.actionSheet({ title: 'Move ' + (person.display_name || person.username), items });
      },
    }, icon('more-horizontal', { size: 14 })));

    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(person.id));
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('is-dragging'));
    return node;
  }

  async function assign(userId, groupId) {
    const existing = memberships.find((m) => String(m.user_id) === String(userId));
    let res;
    if (!groupId) {
      if (!existing) return;
      res = await hub.db.remove('group_members', existing.id);
    } else if (existing) {
      res = await hub.db.update('group_members', existing.id, { group_id: groupId });
    } else {
      res = await hub.db.insert('group_members', { group_id: groupId, user_id: userId });
    }
    if (res && res.error) { hub.err(res.error, 'That move did not save.'); return; }
    hub.invalidateGroups();
    renderGroups(hub, host);
  }
}

/* ----------------------------------------------------------------- 5d. pins */

async function renderPins(hub, host, modal) {
  const channel = hub.channel();
  host.replaceChildren();
  if (!channel) { host.appendChild(emptyLine('Open a channel first.')); return; }

  const res = await hub.db.select('messages', {
    filters: { channel_id: channel.id, pinned: true },
    order: { column: 'created_at', ascending: false },
    limit: 100,
  });
  if (res.error) { hub.err(res.error, 'Pins could not be loaded.'); return; }
  const rows = res.data || [];

  host.replaceChildren(el('p.text-meta', { text: 'Pinned in #' + channel.name }));
  if (!rows.length) { host.appendChild(emptyLine('Nothing is pinned in this channel.')); return; }

  const list = el('div.ch-admin__list');
  for (const row of rows) {
    list.appendChild(el('div.ch-admin__row',
      el('span.ch-admin__rowmain',
        el('span.ch-admin__name', { text: hub.displayName(row.author) }),
        el('span.text-meta.clamp-2', { text: String(row.content || '(attachment)') })),
      el('div.btn-row',
        el('button.btn.btn-ghost.btn--sm', {
          type: 'button', text: 'Jump',
          onClick: () => { modal.close(); hub.jumpTo(row.id); },
        }),
        el('button.btn.btn-secondary.btn--sm', {
          type: 'button', text: 'Unpin',
          onClick: async () => { await hub.togglePin(row, false); renderPins(hub, host, modal); },
        }))));
  }
  host.appendChild(list);
}

function emptyLine(text) {
  return el('p.text-meta.ch-admin__empty', { text });
}

export default {
  isAdminProfile, messageAdminActions, openAdminPanel, openModeration,
  DURATIONS, untilLabel, rowActive, activeRestriction, channelName,
};
