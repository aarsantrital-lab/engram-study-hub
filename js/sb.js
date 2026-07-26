/* =============================================================================
   js/sb.js — Engram's hand-rolled Supabase client.  Job E (supabase-backend).

   Zero dependencies. No supabase-js, no CDN, no bundler. Plain ES module that
   speaks the four Supabase HTTP/WS protocols directly:

     GoTrue     POST/GET  <url>/auth/v1/…        auth + token refresh
     PostgREST  GET/POST… <url>/rest/v1/…        tables + rpc
     Storage    POST/GET… <url>/storage/v1/…     uploads, signed urls
     Realtime   wss       <url>/realtime/v1/…    Phoenix channels protocol

   PUBLIC SURFACE (the cross-agent contract — do not rename any of this):

     sb.ready() -> bool                                   config present?

     sb.auth.signUp(email, pass, username) -> {data,error}
     sb.auth.signIn(email, pass)           -> {data,error}
     sb.auth.signOut()                     -> {data,error}
     sb.auth.user()                        -> user|null      (SYNC, cached)
     sb.auth.onChange(cb)                  -> off            cb(event, session)

     sb.db.select(table, {filters,order,limit,range,columns,single,count})
     sb.db.insert(table, row) · update(table,id,patch) · remove(table,id)
     sb.db.rpc(fn, args)                                  all -> {data,error}

     sb.realtime.channel(name)
        .onBroadcast(ev, cb) · .onPostgres(table, ev, cb)
        .track(presenceState) · .onPresence(cb)
        .subscribe() · .unsubscribe()

     sb.storage.upload(bucket, path, blob) -> {url,error}
     sb.storage.publicUrl(bucket, path)    -> string
     sb.storage.remove(bucket, path)       -> {data,error}

     sb.effort.sync()   push this week's EFFORT (auto-wired; see §6b)
     sb.effort.push(s)  explicit push, for game.js if it wants to drive timing
     sb.effort.board()  -> {data,error}   the friends board, effort columns only

   Every async call resolves to `{data, error}` and NEVER throws for an
   expected failure. `error` is always `{code, message, retryAfterSec?}` — see
   `ERR` below for the code vocabulary. Feature agents show `error.message`
   verbatim; it is already student-safe English.

   Persistence: the session lives in `store` under `KEYS.AUTH` — never raw
   localStorage (CONTRACT-A §5). A quota refusal keeps the session in memory
   for the tab; nothing is ever deleted.
   ========================================================================== */

import { CONFIG, hasSupabase } from './config.js';
import {
  store, KEYS, nowTs,
  todayLocalISO, parseLocalISO, addDaysISO,
} from './store.js';

/* ===========================================================================
   0. CONSTANTS
   ======================================================================== */

const AUTH_PATH = '/auth/v1';
const REST_PATH = '/rest/v1';
const STORAGE_PATH = '/storage/v1';
const REALTIME_PATH = '/realtime/v1/websocket';

const DEFAULT_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 60000;
const MAX_HTTP_RETRIES = 2;          // network / 5xx only — never a 4xx
const REFRESH_MARGIN_S = 60;         // refresh this long before expiry
const HEARTBEAT_MS = 25000;
const JOIN_TIMEOUT_MS = 12000;
const PUSH_TIMEOUT_MS = 10000;
/** Exponential backoff ladder for the websocket (ms), last value repeats. */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

/** Error code vocabulary. Feature agents may branch on these. */
export const ERR = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  OFFLINE: 'offline',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  AUTH_REQUIRED: 'auth_required',
  INVALID_CREDENTIALS: 'invalid_credentials',
  EMAIL_TAKEN: 'email_taken',
  USERNAME_TAKEN: 'username_taken',
  WEAK_PASSWORD: 'weak_password',
  EMAIL_UNCONFIRMED: 'email_unconfirmed',
  RATE_LIMITED: 'rate_limited',
  MUTED: 'muted',
  BANNED: 'banned',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  TOO_LARGE: 'too_large',
  BAD_REQUEST: 'bad_request',
  SERVER: 'server',
  UNKNOWN: 'unknown',
});

/* ===========================================================================
   1. ERRORS — one shape everywhere: {code, message, retryAfterSec?}
   ======================================================================== */

/** Build a normalised error object. `extra` may carry retryAfterSec/details. */
export function sbError(code, message, extra) {
  const e = { code: code || ERR.UNKNOWN, message: String(message || 'Something went wrong.') };
  if (extra && typeof extra === 'object') {
    if (extra.retryAfterSec != null) e.retryAfterSec = Number(extra.retryAfterSec) || 0;
    if (extra.details) e.details = extra.details;
    if (extra.status) e.status = extra.status;
  }
  return e;
}

const NOT_CONFIGURED = () =>
  sbError(ERR.NOT_CONFIGURED,
    'Chat and sync are not set up yet. Paste your Supabase URL and anon key into js/config.js — see supabase/SETUP.md.');

const NEEDS_AUTH = () =>
  sbError(ERR.AUTH_REQUIRED, 'Sign in first.');

/** Parse `retry_after=NN` out of a PostgREST hint/message written by our triggers. */
function parseRetryAfter(text) {
  const m = /retry_after\s*=\s*(\d+)/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Turn any HTTP failure into the house error shape.
 * Handles PostgREST ({code,message,details,hint}), GoTrue ({error,error_description,msg})
 * and Storage ({statusCode,error,message}) bodies plus our own trigger errors.
 */
function httpError(status, body, headers, ctx) {
  const b = body && typeof body === 'object' ? body : {};
  const pgCode = String(b.code || '');
  const raw = String(b.message || b.msg || b.error_description || b.error || b.error_message || '')
    .trim();
  const hint = String(b.hint || '');
  const retryHeader = headers && headers.get ? headers.get('Retry-After') : null;
  const retryAfterSec = parseRetryAfter(hint) ?? parseRetryAfter(raw) ??
    (retryHeader ? Number(retryHeader) || null : null);

  /* --- our own guard triggers (schema.sql) speak in hints ---------------- */
  if (/^cooldown:/i.test(raw) || pgCode === 'P0001') {
    if (/muted/i.test(raw)) return sbError(ERR.MUTED, raw || 'You are muted right now.');
    if (/banned/i.test(raw)) return sbError(ERR.BANNED, raw || 'You are banned from chat.');
    if (/cooldown|slow down|too fast|rate/i.test(raw)) {
      return sbError(ERR.RATE_LIMITED, raw.replace(/^cooldown:\s*/i, '') || 'Slow down a moment.',
        { retryAfterSec: retryAfterSec || 5 });
    }
    return sbError(ERR.FORBIDDEN, raw || 'That is not allowed.');
  }

  /* --- postgres SQLSTATEs we care about --------------------------------- */
  if (pgCode === '23505') return sbError(ERR.CONFLICT, friendlyUnique(raw), { details: raw });
  if (pgCode === '23514' || pgCode === '22001') {
    return sbError(ERR.BAD_REQUEST, 'That value is outside the allowed limits.', { details: raw });
  }
  if (pgCode === '23503') return sbError(ERR.BAD_REQUEST, 'That refers to something that no longer exists.', { details: raw });
  if (pgCode === '42501' || /row-level security/i.test(raw)) {
    return sbError(ERR.FORBIDDEN,
      ctx === 'messages'
        ? 'That message was refused — you may be muted, on cooldown, or the channel is locked.'
        : 'You do not have permission to do that.',
      { details: raw });
  }
  if (pgCode === 'PGRST116') return sbError(ERR.NOT_FOUND, 'Not found.', { details: raw });

  /* --- status codes ------------------------------------------------------ */
  switch (status) {
    case 400:
      if (/already registered|already been registered|user already exists/i.test(raw)) {
        return sbError(ERR.EMAIL_TAKEN, 'That email already has an account. Sign in instead.');
      }
      if (/invalid login|invalid credentials|grant_type|invalid_grant/i.test(raw)) {
        return sbError(ERR.INVALID_CREDENTIALS, 'Email or password is wrong.');
      }
      if (/password/i.test(raw) && /least|short|weak/i.test(raw)) {
        return sbError(ERR.WEAK_PASSWORD, 'Password must be at least 6 characters.');
      }
      if (/email not confirmed/i.test(raw)) {
        return sbError(ERR.EMAIL_UNCONFIRMED, 'Confirm your email first, then sign in.');
      }
      return sbError(ERR.BAD_REQUEST, raw || 'That request was rejected.', { details: raw });
    case 401:
      if (/invalid login|invalid credentials/i.test(raw)) {
        return sbError(ERR.INVALID_CREDENTIALS, 'Email or password is wrong.');
      }
      return sbError(ERR.AUTH_REQUIRED, 'Your session expired. Sign in again.');
    case 403:
      return sbError(ERR.FORBIDDEN, raw || 'You do not have permission to do that.', { details: raw });
    case 404:
      return sbError(ERR.NOT_FOUND, 'Not found.', { details: raw });
    case 409:
      return sbError(ERR.CONFLICT, friendlyUnique(raw), { details: raw });
    case 413:
      return sbError(ERR.TOO_LARGE, 'That file is too big.');
    case 422:
      if (/already registered/i.test(raw)) return sbError(ERR.EMAIL_TAKEN, 'That email already has an account. Sign in instead.');
      if (/password/i.test(raw)) return sbError(ERR.WEAK_PASSWORD, 'Password must be at least 6 characters.');
      return sbError(ERR.BAD_REQUEST, raw || 'That request was rejected.', { details: raw });
    case 429:
      return sbError(ERR.RATE_LIMITED, 'Too many attempts. Wait a moment and try again.',
        { retryAfterSec: retryAfterSec || 30 });
    default:
      break;
  }
  if (status >= 500) {
    /* GoTrue reports a failed profile trigger as a generic 500. In signUp we
       always pass a username, so this is nearly always the username clash. */
    if (/database error saving new user/i.test(raw)) {
      return sbError(ERR.USERNAME_TAKEN, 'That username is taken. Pick another.');
    }
    return sbError(ERR.SERVER, 'The server had a problem. Try again in a minute.', { details: raw, status });
  }
  return sbError(ERR.UNKNOWN, raw || ('Request failed (' + status + ').'), { status });
}

function friendlyUnique(raw) {
  if (/username/i.test(raw)) return 'That username is taken. Pick another.';
  if (/reactions/i.test(raw)) return 'You already reacted with that.';
  if (/email/i.test(raw)) return 'That email already has an account.';
  if (/group_members/i.test(raw)) return 'Already a member of that group.';
  return 'That already exists.';
}

function networkError(e) {
  if (e && e.name === 'AbortError') {
    return sbError(ERR.TIMEOUT, 'The server took too long. Check your connection and try again.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return sbError(ERR.OFFLINE, 'You are offline. This will work again when you reconnect.');
  }
  return sbError(ERR.NETWORK, 'Could not reach the server. Check your connection.');
}

/* ===========================================================================
   2. HTTP CORE — timeouts, one 401 refresh-retry, backoff on 5xx/network
   ======================================================================== */

function baseUrl() {
  return String(CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
}
function anonKey() {
  return String(CONFIG.SUPABASE_ANON_KEY || '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch + AbortController timeout (and an optional caller signal). */
async function timedFetch(url, init, timeoutMs, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let unlink = null;
  if (signal) {
    if (signal.aborted) ctl.abort();
    else {
      const onAbort = () => ctl.abort();
      signal.addEventListener('abort', onAbort);
      unlink = () => signal.removeEventListener('abort', onAbort);
    }
  }
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
  } finally {
    clearTimeout(timer);
    if (unlink) unlink();
  }
}

async function readBody(res, parse) {
  if (res.status === 204 || res.status === 205) return null;
  if (parse === 'blob') return await res.blob();
  const text = await res.text();
  if (!text) return null;
  if (parse === 'text') return text;
  try { return JSON.parse(text); } catch (_) { return text; }
}

/**
 * The one request funnel.
 * @param {string} path absolute path beginning with '/'
 * @param {object} opts {method, headers, body, json, timeoutMs, auth:'session'|'anon'|'none',
 *                       parse:'json'|'text'|'blob', retries, signal, ctx, _retriedAuth}
 * @returns {Promise<{data,error,status,headers}>}
 */
async function request(path, opts) {
  const o = opts || {};
  if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED(), status: 0, headers: null };

  const url = baseUrl() + path;
  const headers = Object.assign({ apikey: anonKey() }, o.headers || {});
  const authMode = o.auth || 'session';
  if (authMode !== 'none') {
    const token = authMode === 'anon' ? anonKey() : (getAccessToken() || anonKey());
    headers.Authorization = 'Bearer ' + token;
  }

  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const retries = o.retries == null ? MAX_HTTP_RETRIES : o.retries;
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await timedFetch(url, { method: o.method || 'GET', headers, body }, timeoutMs, o.signal);
    } catch (e) {
      const error = networkError(e);
      if (attempt < retries && error.code !== ERR.OFFLINE) {
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        continue;
      }
      return { data: null, error, status: 0, headers: null };
    }

    if (res.ok) {
      const data = await readBody(res, o.parse || 'json');
      return { data, error: null, status: res.status, headers: res.headers };
    }

    /* Expired access token: refresh once, then replay the request. */
    if (res.status === 401 && authMode === 'session' && !o._retriedAuth && getRefreshToken()) {
      const ok = await refreshSession();
      if (ok) return request(path, Object.assign({}, o, { _retriedAuth: true }));
    }

    const payload = await readBody(res, 'json');
    if ((res.status >= 500 || res.status === 408) && attempt < retries) {
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      continue;
    }
    let error = httpError(res.status, payload, res.headers, o.ctx);
    /* Every table refuses `anon`, so a signed-out request looks like a
       permission failure. Say the true thing instead: you are not signed in. */
    if (error.code === ERR.FORBIDDEN && authMode === 'session' && !getAccessToken()) {
      error = NEEDS_AUTH();
    }
    return { data: null, error, status: res.status, headers: res.headers };
  }
}

/* ===========================================================================
   3. AUTH (GoTrue) — session cached in store[KEYS.AUTH], auto token refresh
   ======================================================================== */

/** @type {{session:object|null, timer:any, refreshing:Promise|null, listeners:Set, loaded:boolean}} */
const A = {
  session: null,
  timer: null,
  refreshing: null,
  listeners: new Set(),
  loaded: false,
};

function normaliseSession(raw) {
  if (!raw || typeof raw !== 'object' || !raw.access_token) return null;
  const expiresAt = Number(raw.expires_at) ||
    (Number(raw.expires_in) ? Math.floor(nowTs() / 1000) + Number(raw.expires_in) : 0);
  const u = raw.user || {};
  const meta = u.user_metadata || u.raw_user_meta_data || {};
  return {
    access_token: String(raw.access_token),
    refresh_token: raw.refresh_token ? String(raw.refresh_token) : null,
    expires_at: expiresAt,
    user: u && u.id ? {
      id: String(u.id),
      email: u.email || null,
      username: meta.username || null,
      created_at: u.created_at || null,
    } : (raw.userCache || null),
  };
}

function loadSession() {
  if (A.loaded) return;
  A.loaded = true;
  const saved = normaliseSession(store.get(KEYS.AUTH, null));
  if (!saved) return;
  A.session = saved;
  scheduleRefresh();
  /* Fire on the next tick so listeners registered during boot still hear it. */
  setTimeout(() => emitAuth('RESTORED'), 0);
}

function persistSession() {
  if (A.session) store.set(KEYS.AUTH, A.session);
  else store.remove(KEYS.AUTH);
}

function setSession(raw, event) {
  const s = normaliseSession(raw);
  if (s && !s.user && A.session && A.session.user) s.user = A.session.user;  // refresh w/o user body
  A.session = s;
  persistSession();
  scheduleRefresh();
  emitAuth(event || (s ? 'SIGNED_IN' : 'SIGNED_OUT'));
  return s;
}

function clearSession(event) {
  A.session = null;
  if (A.timer) { clearTimeout(A.timer); A.timer = null; }
  store.remove(KEYS.AUTH);
  emitAuth(event || 'SIGNED_OUT');
}

function emitAuth(event) {
  for (const cb of Array.from(A.listeners)) {
    try { cb(event, A.session); } catch (e) { console.error('[sb] auth listener failed', e); }
  }
}

function getAccessToken() {
  loadSession();
  return A.session ? A.session.access_token : null;
}
function getRefreshToken() {
  loadSession();
  return A.session ? A.session.refresh_token : null;
}

function scheduleRefresh() {
  if (A.timer) { clearTimeout(A.timer); A.timer = null; }
  if (!A.session || !A.session.refresh_token || !A.session.expires_at) return;
  const msUntil = (A.session.expires_at - REFRESH_MARGIN_S) * 1000 - nowTs();
  const delay = Math.max(2000, Math.min(msUntil, 0x7ffffffe));
  A.timer = setTimeout(() => { refreshSession(); }, delay);
}

/** Single-flight refresh. Resolves true when a fresh token is in hand. */
function refreshSession() {
  if (A.refreshing) return A.refreshing;
  const token = getRefreshToken();
  if (!token) return Promise.resolve(false);

  A.refreshing = (async () => {
    const { data, error } = await request(AUTH_PATH + '/token?grant_type=refresh_token', {
      method: 'POST',
      auth: 'anon',
      json: { refresh_token: token },
      retries: 1,
      ctx: 'auth',
    });
    if (error || !data || !data.access_token) {
      /* A refused refresh token is terminal — the stored session is dead. A
         network blip is not: keep the session and let the next call retry. */
      if (error && (error.code === ERR.AUTH_REQUIRED || error.code === ERR.BAD_REQUEST ||
                    error.code === ERR.INVALID_CREDENTIALS)) {
        clearSession('SIGNED_OUT');
      } else {
        scheduleRefresh();
      }
      return false;
    }
    setSession(data, 'TOKEN_REFRESHED');
    return true;
  })().finally(() => { A.refreshing = null; });

  return A.refreshing;
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const auth = {
  /**
   * Create an account. `username` is validated here and enforced unique by the
   * DB (profiles.username unique + handle_new_user trigger).
   * @returns {Promise<{data:{user,session}|null, error}>}
   */
  async signUp(email, password, username) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    const name = String(username || '').trim();
    if (!USERNAME_RE.test(name)) {
      return { data: null, error: sbError(ERR.BAD_REQUEST,
        'Username must be 3–20 characters: letters, numbers or underscore.') };
    }
    if (String(password || '').length < 6) {
      return { data: null, error: sbError(ERR.WEAK_PASSWORD, 'Password must be at least 6 characters.') };
    }

    /* Friendly pre-check (the DB is still the authority). */
    const check = await this.usernameAvailable(name);
    if (check.data === false) {
      return { data: null, error: sbError(ERR.USERNAME_TAKEN, 'That username is taken. Pick another.') };
    }

    const { data, error } = await request(AUTH_PATH + '/signup', {
      method: 'POST',
      auth: 'anon',
      json: { email: String(email || '').trim(), password: String(password || ''), data: { username: name } },
      retries: 0,
      ctx: 'auth',
    });
    if (error) return { data: null, error };

    /* Email confirmation OFF -> a session comes back with the user.
       Email confirmation ON  -> only the user; they must confirm then sign in. */
    if (data && data.access_token) {
      const s = setSession(data, 'SIGNED_IN');
      return { data: { user: s ? s.user : null, session: s }, error: null };
    }
    return {
      data: { user: data || null, session: null, needsConfirmation: true },
      error: null,
    };
  },

  /** Password sign-in. */
  async signIn(email, password) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    const { data, error } = await request(AUTH_PATH + '/token?grant_type=password', {
      method: 'POST',
      auth: 'anon',
      json: { email: String(email || '').trim(), password: String(password || '') },
      retries: 0,
      ctx: 'auth',
    });
    if (error) return { data: null, error };
    const s = setSession(data, 'SIGNED_IN');
    return { data: { user: s ? s.user : null, session: s }, error: null };
  },

  /** Sign out locally first (always succeeds), then best-effort server revoke. */
  async signOut() {
    const token = getAccessToken();
    clearSession('SIGNED_OUT');
    if (!token || !hasSupabase()) return { data: true, error: null };
    await request(AUTH_PATH + '/logout', { method: 'POST', auth: 'none', retries: 0,
      headers: { apikey: anonKey(), Authorization: 'Bearer ' + token }, ctx: 'auth' });
    return { data: true, error: null };
  },

  /** SYNC cached user — `{id,email,username}` or null. */
  user() {
    loadSession();
    return A.session ? A.session.user : null;
  },

  /** SYNC cached session (access token, expiry). Null when signed out. */
  session() {
    loadSession();
    return A.session;
  },

  /** True when a non-expired session is cached. */
  isSignedIn() {
    loadSession();
    return Boolean(A.session && A.session.access_token);
  },

  /**
   * Subscribe to auth changes.
   * cb(event, session) — 'RESTORED'|'SIGNED_IN'|'SIGNED_OUT'|'TOKEN_REFRESHED'|'USER_UPDATED'
   * @returns {() => void} off
   */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    loadSession();
    A.listeners.add(cb);
    return () => A.listeners.delete(cb);
  },

  /** Fresh user straight from GoTrue (also refreshes the cached copy). */
  async getUser() {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    if (!getAccessToken()) return { data: null, error: NEEDS_AUTH() };
    const { data, error } = await request(AUTH_PATH + '/user', { ctx: 'auth' });
    if (error) return { data: null, error };
    if (A.session && data && data.id) {
      const meta = data.user_metadata || {};
      A.session.user = { id: data.id, email: data.email || null, username: meta.username || null,
        created_at: data.created_at || null };
      persistSession();
      emitAuth('USER_UPDATED');
    }
    return { data: A.session ? A.session.user : null, error: null };
  },

  /** Change password / email for the signed-in user. */
  async updateUser(patch) {
    if (!getAccessToken()) return { data: null, error: NEEDS_AUTH() };
    const { data, error } = await request(AUTH_PATH + '/user', { method: 'PUT', json: patch || {}, ctx: 'auth' });
    if (error) return { data: null, error };
    return { data, error: null };
  },

  /** Pre-signup username check via the anon-callable RPC in schema.sql. */
  async usernameAvailable(name) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    const { data, error } = await request(REST_PATH + '/rpc/username_available', {
      method: 'POST', auth: 'anon', json: { p_username: String(name || '') },
      headers: { 'Content-Type': 'application/json' }, retries: 1, ctx: 'auth',
    });
    if (error) return { data: null, error };
    return { data: data === true || data === 'true', error: null };
  },

  /** Force a token refresh now (used by tests and the realtime reconnect). */
  refresh: () => refreshSession(),

  /** Current bearer token (or null). Realtime + storage use this. */
  accessToken: () => getAccessToken(),
};

/* ===========================================================================
   4. DB (PostgREST)
   ======================================================================== */

/** Quote a value for a PostgREST `in.(…)` list. */
function quoteInValue(v) {
  if (v == null) return 'null';
  const s = String(v);
  return /[,."'()\s]/.test(s) ? '"' + s.replace(/(["\\])/g, '\\$1') + '"' : s;
}

/** Serialise one filter value into a PostgREST operator string. */
function filterValue(v) {
  if (v === null) return 'is.null';
  if (typeof v === 'boolean') return 'is.' + v;
  if (Array.isArray(v)) return 'in.(' + v.map(quoteInValue).join(',') + ')';
  return 'eq.' + v;
}

/**
 * filters accepts, per column:
 *   'abc'                -> col=eq.abc
 *   null / true / false  -> col=is.null / is.true / is.false
 *   ['a','b']            -> col=in.(a,b)
 *   {gte:x, lt:y}        -> col=gte.x AND col=lt.y   (operators: eq neq gt gte lt lte
 *                           like ilike is in cs cd ov fts not)
 *   {op:'ilike', value:'%x%'}   -> col=ilike.%x%
 */
function appendFilters(qs, filters) {
  if (!filters || typeof filters !== 'object') return;
  for (const col of Object.keys(filters)) {
    const v = filters[col];
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.op === 'string') { qs.append(col, v.op + '.' + serialiseOperand(v.op, v.value)); continue; }
      for (const op of Object.keys(v)) qs.append(col, op + '.' + serialiseOperand(op, v[op]));
      continue;
    }
    qs.append(col, filterValue(v));
  }
}

function serialiseOperand(op, v) {
  if (op === 'in') return '(' + (Array.isArray(v) ? v : [v]).map(quoteInValue).join(',') + ')';
  if (v === null) return 'null';
  return String(v);
}

function appendOrder(qs, order) {
  if (!order) return;
  const list = Array.isArray(order) ? order : [order];
  const parts = [];
  for (const o of list) {
    if (!o) continue;
    if (typeof o === 'string') { parts.push(o); continue; }
    if (typeof o === 'object' && o.column) {
      let s = o.column;
      s += o.ascending === false ? '.desc' : '.asc';
      if (o.nullsFirst === true) s += '.nullsfirst';
      else if (o.nullsFirst === false) s += '.nullslast';
      parts.push(s);
    }
  }
  if (parts.length) qs.append('order', parts.join(','));
}

const db = {
  /**
   * Read rows.
   * @param {string} table
   * @param {object} [opts] {filters, order, limit, range:[from,to]|{from,to},
   *                         columns:'a,b', single:bool, maybeSingle:bool, count:'exact'}
   * @returns {Promise<{data,error,count}>}
   */
  async select(table, opts) {
    const o = opts || {};
    const qs = new URLSearchParams();
    qs.set('select', o.columns || '*');
    appendFilters(qs, o.filters);
    appendOrder(qs, o.order);
    if (o.limit != null) qs.set('limit', String(o.limit));
    if (o.offset != null) qs.set('offset', String(o.offset));

    const headers = {};
    const prefer = [];
    if (o.count) prefer.push('count=' + o.count);
    if (o.range) {
      const from = Array.isArray(o.range) ? o.range[0] : o.range.from;
      const to = Array.isArray(o.range) ? o.range[1] : o.range.to;
      headers['Range-Unit'] = 'items';
      headers.Range = String(from) + '-' + String(to);
      if (!o.count) prefer.push('count=exact');
    }
    if (prefer.length) headers.Prefer = prefer.join(',');
    if (o.single) headers.Accept = 'application/vnd.pgrst.object+json';

    const res = await request(REST_PATH + '/' + encodeURIComponent(table) + '?' + qs.toString(),
      { headers, ctx: table, signal: o.signal });
    if (res.error) {
      /* `single` on zero rows is a normal "not there yet", not a failure. */
      if (o.maybeSingle && res.error.code === ERR.NOT_FOUND) return { data: null, error: null, count: 0 };
      return { data: null, error: res.error, count: null };
    }
    let count = null;
    const cr = res.headers && res.headers.get ? res.headers.get('content-range') : null;
    if (cr && cr.indexOf('/') >= 0) {
      const n = cr.split('/')[1];
      count = n === '*' ? null : Number(n);
    }
    return { data: res.data, error: null, count };
  },

  /** Insert one row (object) or many (array). Returns the stored row(s). */
  async insert(table, row) {
    const res = await request(REST_PATH + '/' + encodeURIComponent(table), {
      method: 'POST',
      json: row,
      headers: { Prefer: 'return=representation' },
      retries: 0,                       // never silently double-post
      ctx: table,
    });
    if (res.error) return { data: null, error: res.error };
    const arr = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    return { data: Array.isArray(row) ? arr : (arr[0] || null), error: null };
  },

  /** Insert-or-merge on a unique constraint. Additive to the contract. */
  async upsert(table, row, opts) {
    const o = opts || {};
    const qs = new URLSearchParams();
    if (o.onConflict) qs.set('on_conflict', o.onConflict);
    const res = await request(REST_PATH + '/' + encodeURIComponent(table) +
      (qs.toString() ? '?' + qs.toString() : ''), {
      method: 'POST',
      json: row,
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      retries: 0,
      ctx: table,
    });
    if (res.error) return { data: null, error: res.error };
    const arr = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    return { data: Array.isArray(row) ? arr : (arr[0] || null), error: null };
  },

  /** Patch one row by primary key `id`. */
  async update(table, id, patch) {
    const qs = new URLSearchParams();
    qs.append('id', 'eq.' + String(id));
    const res = await request(REST_PATH + '/' + encodeURIComponent(table) + '?' + qs.toString(), {
      method: 'PATCH',
      json: patch || {},
      headers: { Prefer: 'return=representation' },
      retries: 0,
      ctx: table,
    });
    if (res.error) return { data: null, error: res.error };
    const arr = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    if (!arr.length) {
      return { data: null, error: sbError(ERR.FORBIDDEN, 'Nothing was updated — that row is missing or not yours.') };
    }
    return { data: arr[0], error: null };
  },

  /** Hard-delete one row by `id`. Chat messages should be soft-deleted instead. */
  async remove(table, id) {
    const qs = new URLSearchParams();
    qs.append('id', 'eq.' + String(id));
    const res = await request(REST_PATH + '/' + encodeURIComponent(table) + '?' + qs.toString(), {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
      retries: 0,
      ctx: table,
    });
    if (res.error) return { data: null, error: res.error };
    const arr = Array.isArray(res.data) ? res.data : [];
    return { data: arr[0] || null, error: null };
  },

  /** Delete rows matching `filters` (used for un-reacting, leaving groups). */
  async removeWhere(table, filters) {
    const qs = new URLSearchParams();
    appendFilters(qs, filters);
    if (!qs.toString()) {
      return { data: null, error: sbError(ERR.BAD_REQUEST, 'Refusing an unfiltered delete.') };
    }
    const res = await request(REST_PATH + '/' + encodeURIComponent(table) + '?' + qs.toString(), {
      method: 'DELETE', headers: { Prefer: 'return=representation' }, retries: 0, ctx: table,
    });
    if (res.error) return { data: null, error: res.error };
    return { data: Array.isArray(res.data) ? res.data : [], error: null };
  },

  /** Call a Postgres function. */
  async rpc(fn, args) {
    const res = await request(REST_PATH + '/rpc/' + encodeURIComponent(fn), {
      method: 'POST',
      json: args || {},
      retries: 0,
      ctx: 'rpc:' + fn,
    });
    if (res.error) return { data: null, error: res.error };
    return { data: res.data, error: null };
  },
};

/* ===========================================================================
   5. REALTIME — hand-rolled Phoenix channels client
   ---------------------------------------------------------------------------
   Wire format (vsn=1.0.0): every frame is a JSON object
       { topic, event, payload, ref }
   Events we speak:
     out  phx_join / phx_leave / heartbeat / access_token / broadcast / presence
     in   phx_reply / phx_error / phx_close / postgres_changes / broadcast /
          presence_state / presence_diff / system
   ======================================================================== */

const RT_STATUS = Object.freeze({
  CLOSED: 'closed', CONNECTING: 'connecting', OPEN: 'open',
});

class RealtimeSocket {
  constructor() {
    this.ws = null;
    this.state = RT_STATUS.CLOSED;
    this.ref = 0;
    this.channels = new Map();        // name -> RealtimeChannel
    this.pending = new Map();         // ref -> {resolve, timer}
    this.attempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pendingHeartbeat = null;
    this.statusListeners = new Set();
    this.manualClose = false;
    this._authOff = null;
  }

  nextRef() { this.ref += 1; return String(this.ref); }

  url() {
    const http = baseUrl().replace(/^http/i, 'ws');
    return http + REALTIME_PATH + '?apikey=' + encodeURIComponent(anonKey()) + '&vsn=1.0.0';
  }

  onStatus(cb) {
    if (typeof cb !== 'function') return () => {};
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  emitStatus(status, detail) {
    for (const cb of Array.from(this.statusListeners)) {
      try { cb(status, detail); } catch (e) { console.error('[sb] realtime status listener failed', e); }
    }
  }

  connect() {
    if (!hasSupabase()) return;
    if (typeof WebSocket === 'undefined') return;
    if (this.ws && (this.state === RT_STATUS.OPEN || this.state === RT_STATUS.CONNECTING)) return;

    this.manualClose = false;
    this.state = RT_STATUS.CONNECTING;
    this.emitStatus('connecting');

    let ws;
    try { ws = new WebSocket(this.url()); }
    catch (e) { this.state = RT_STATUS.CLOSED; this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.state = RT_STATUS.OPEN;
      this.attempts = 0;
      this.emitStatus('open');
      this.startHeartbeat();
      for (const ch of this.channels.values()) if (ch.wanted) ch._join();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onerror = () => { /* onclose always follows; nothing useful in the event */ };
    ws.onclose = () => {
      this.state = RT_STATUS.CLOSED;
      this.ws = null;
      this.stopHeartbeat();
      this.failPending(sbError(ERR.NETWORK, 'Live connection dropped.'));
      for (const ch of this.channels.values()) ch._onSocketClosed();
      this.emitStatus('closed');
      if (!this.manualClose) this.scheduleReconnect();
    };

    /* Re-issue the JWT to every joined channel whenever it rotates. */
    if (!this._authOff) {
      this._authOff = auth.onChange((event) => {
        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
          const token = getAccessToken() || anonKey();
          for (const ch of this.channels.values()) {
            if (ch.state === 'joined') ch._push('access_token', { access_token: token });
          }
        } else if (event === 'SIGNED_OUT') {
          this.disconnect();
        }
      });
    }
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    this.state = RT_STATUS.CLOSED;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.manualClose) return;
    if (!Array.from(this.channels.values()).some((c) => c.wanted)) return;   // nobody listening
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    const jitter = Math.floor(delay * 0.2 * (Math.random() - 0.5) * 2);
    this.attempts += 1;
    this.emitStatus('reconnecting', { attempt: this.attempts, delayMs: delay + jitter });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, Math.max(500, delay + jitter));
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.pendingHeartbeat) {
        /* No reply to the previous beat — the socket is a zombie. */
        this.pendingHeartbeat = null;
        if (this.ws) { try { this.ws.close(); } catch (_) {} }
        return;
      }
      const ref = this.nextRef();
      this.pendingHeartbeat = ref;
      this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.pendingHeartbeat = null;
  }

  send(msg) {
    if (!this.ws || this.state !== RT_STATUS.OPEN) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; }
    catch (e) { return false; }
  }

  /** Push and wait for the matching phx_reply. */
  push(msg, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.send(msg)) { resolve({ status: 'error', response: { reason: 'not connected' } }); return; }
      const timer = setTimeout(() => {
        this.pending.delete(msg.ref);
        resolve({ status: 'timeout', response: {} });
      }, timeoutMs || PUSH_TIMEOUT_MS);
      this.pending.set(msg.ref, { resolve, timer });
    });
  }

  failPending(error) {
    for (const [ref, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ status: 'error', response: { reason: error.message } });
      this.pending.delete(ref);
    }
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    const { topic, event, payload, ref } = msg;

    if (ref && this.pending.has(ref)) {
      const p = this.pending.get(ref);
      clearTimeout(p.timer);
      this.pending.delete(ref);
      p.resolve(payload || { status: 'ok', response: {} });
    }
    if (this.pendingHeartbeat && ref === this.pendingHeartbeat) this.pendingHeartbeat = null;
    if (topic === 'phoenix') return;

    for (const ch of this.channels.values()) {
      if (ch.topic === topic) { ch._handle(event, payload); break; }
    }
  }
}

class RealtimeChannel {
  constructor(socket, name) {
    this.socket = socket;
    this.name = name;
    this.topic = 'realtime:' + name;
    this.state = 'closed';            // closed | joining | joined | errored
    this.wanted = false;              // has subscribe() been called?
    this.joinRef = null;

    this._broadcast = new Map();      // event -> Set<cb>   ('*' = all)
    this._pgBindings = [];            // {table, event, schema, filter, cb, serverId}
    this._presenceCbs = new Set();
    this._statusCbs = new Set();
    this._presence = {};              // key -> [meta,…]
    this._trackState = null;
    this._joinPromise = null;
    this._joinTimer = null;           // armed in subscribe(), cleared in _settleJoin()
  }

  /* ---- registration (call BEFORE subscribe) --------------------------- */

  /**
   * Listen for a broadcast event on this channel. `ev` may be '*'.
   * @returns {this}
   */
  onBroadcast(ev, cb) {
    const key = String(ev || '*');
    if (typeof cb !== 'function') return this;
    if (!this._broadcast.has(key)) this._broadcast.set(key, new Set());
    this._broadcast.get(key).add(cb);
    return this;
  }

  /**
   * Listen for postgres changes.
   *   onPostgres('messages', 'INSERT', cb)
   *   onPostgres({table:'messages', event:'*', filter:'channel_id=eq.…'}, cb)
   * cb receives {eventType, new, old, table, schema, commitTimestamp}.
   * Adding a binding after subscribe() re-joins the channel automatically.
   * @returns {this}
   */
  onPostgres(table, ev, cb, opts) {
    let cfg, handler;
    if (table && typeof table === 'object') { cfg = table; handler = ev; }
    else { cfg = Object.assign({ table, event: ev }, opts || {}); handler = cb; }
    if (typeof handler !== 'function') return this;

    this._pgBindings.push({
      table: String(cfg.table || '*'),
      event: String(cfg.event || '*').toUpperCase(),
      schema: cfg.schema || 'public',
      filter: cfg.filter || null,
      cb: handler,
      serverId: null,
    });
    if (this.state === 'joined' || this.state === 'joining') this._rejoin();
    return this;
  }

  /** Presence updates: cb(stateMap, {joins, leaves}). @returns {this} */
  onPresence(cb) {
    if (typeof cb === 'function') this._presenceCbs.add(cb);
    return this;
  }

  /** Subscription status: cb('SUBSCRIBED'|'CLOSED'|'CHANNEL_ERROR'|'TIMED_OUT', err). */
  onStatus(cb) {
    if (typeof cb === 'function') this._statusCbs.add(cb);
    return this;
  }

  /* ---- lifecycle ------------------------------------------------------- */

  /**
   * Join the channel. Safe to call twice.
   * @param {function} [cb] optional status callback
   * @returns {Promise<{status:string, error:object|null}>}
   */
  subscribe(cb) {
    if (cb) this.onStatus(cb);
    if (!hasSupabase()) {
      const error = NOT_CONFIGURED();
      this._emitStatus('CHANNEL_ERROR', error);
      return Promise.resolve({ status: 'CHANNEL_ERROR', error });
    }
    this.wanted = true;
    this.socket.connect();
    if (this.state === 'joined') return Promise.resolve({ status: 'SUBSCRIBED', error: null });
    if (this._joinPromise) return this._joinPromise;
    this._joinPromise = new Promise((resolve) => { this._resolveJoin = resolve; });
    // ALWAYS settle. _join() only runs from ws.onopen or when the socket is
    // already OPEN, so on a paused free project, a blocked WebSocket or a
    // captive portal the socket just retried on its backoff ladder and this
    // promise never resolved at all. focus.js awaits it, so the study-room card
    // was never re-rendered and its own "could not reach the study room"
    // fallback could never fire. A timeout is an answer; hanging is not.
    if (this._joinTimer) clearTimeout(this._joinTimer);
    this._joinTimer = setTimeout(() => {
      this._joinTimer = null;
      this._emitStatus('TIMED_OUT', sbError(ERR.NETWORK, 'Live updates did not connect.'));
      this._settleJoin({ status: 'TIMED_OUT', error: sbError(ERR.NETWORK, 'Live updates did not connect.') });
    }, JOIN_TIMEOUT_MS);
    if (this.socket.state === RT_STATUS.OPEN) this._join();
    return this._joinPromise;
  }

  /** Leave and forget the channel. */
  unsubscribe() {
    this.wanted = false;
    if (this.socket.state === RT_STATUS.OPEN && this.state === 'joined') {
      this.socket.send({ topic: this.topic, event: 'phx_leave', payload: {}, ref: this.socket.nextRef() });
    }
    this.state = 'closed';
    this._presence = {};
    this.socket.channels.delete(this.name);
    this._emitStatus('CLOSED', null);
    this._settleJoin({ status: 'CLOSED', error: null });
    /* Nothing left to keep alive? Drop the socket so a background tab is quiet. */
    if (!Array.from(this.socket.channels.values()).some((c) => c.wanted)) this.socket.disconnect();
    return this;
  }

  /**
   * Publish presence for this client (e.g. `{status:'studying', topic:'Mole Concept'}`).
   * Buffered until the channel is joined.
   * @returns {Promise<{status:string}>}
   */
  track(presenceState) {
    this._trackState = presenceState && typeof presenceState === 'object' ? presenceState : {};
    if (this.state !== 'joined') return Promise.resolve({ status: 'pending' });
    return this._push('presence', { type: 'presence', event: 'track', payload: this._trackState });
  }

  /** Stop publishing presence. */
  untrack() {
    this._trackState = null;
    if (this.state !== 'joined') return Promise.resolve({ status: 'pending' });
    return this._push('presence', { type: 'presence', event: 'untrack', payload: {} });
  }

  /** Current presence map: `{userKey: [meta, …]}`. */
  presenceState() {
    return this._presence;
  }

  /**
   * Send a broadcast to everyone else on this channel (typing indicators, nudges).
   * Additive to the contract — a receive-only broadcast API would be useless.
   */
  broadcast(ev, payload) {
    if (this.state !== 'joined') return Promise.resolve({ status: 'error' });
    return this._push('broadcast', { type: 'broadcast', event: String(ev), payload: payload || {} });
  }
  send(ev, payload) { return this.broadcast(ev, payload); }

  /* ---- internals ------------------------------------------------------- */

  _emitStatus(status, error) {
    for (const cb of Array.from(this._statusCbs)) {
      try { cb(status, error || null); } catch (e) { console.error('[sb] channel status listener failed', e); }
    }
  }

  _settleJoin(result) {
    if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
    if (this._resolveJoin) { const r = this._resolveJoin; this._resolveJoin = null; this._joinPromise = null; r(result); }
  }

  _push(event, payload) {
    return this.socket.push({ topic: this.topic, event, payload, ref: this.socket.nextRef() });
  }

  _joinPayload() {
    const pg = this._pgBindings.map((b) => {
      const o = { event: b.event, schema: b.schema, table: b.table };
      if (b.filter) o.filter = b.filter;
      return o;
    });
    return {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: '' },
        postgres_changes: pg,
        private: false,
      },
      access_token: getAccessToken() || anonKey(),
    };
  }

  async _join() {
    if (this.state === 'joining') return;
    this.state = 'joining';
    const ref = this.socket.nextRef();
    this.joinRef = ref;
    const reply = await this.socket.push(
      { topic: this.topic, event: 'phx_join', payload: this._joinPayload(), ref }, JOIN_TIMEOUT_MS);

    if (reply && reply.status === 'ok') {
      this.state = 'joined';
      /* Server hands back an id per postgres_changes binding, in request order. */
      const ids = (reply.response && reply.response.postgres_changes) || [];
      this._pgBindings.forEach((b, i) => { b.serverId = ids[i] ? ids[i].id : null; });
      if (this._trackState) this._push('presence', { type: 'presence', event: 'track', payload: this._trackState });
      this._emitStatus('SUBSCRIBED', null);
      this._settleJoin({ status: 'SUBSCRIBED', error: null });
      return;
    }

    this.state = 'errored';
    const reason = (reply && reply.response && (reply.response.reason || reply.response.message)) || '';
    const error = reply && reply.status === 'timeout'
      ? sbError(ERR.TIMEOUT, 'Live updates timed out. Retrying…')
      : sbError(ERR.NETWORK, reason ? 'Live updates refused: ' + reason : 'Live updates unavailable. Retrying…');
    this._emitStatus(reply && reply.status === 'timeout' ? 'TIMED_OUT' : 'CHANNEL_ERROR', error);
    this._settleJoin({ status: 'CHANNEL_ERROR', error });
    /* Let the socket-level backoff drive the retry. */
    if (this.socket.state === RT_STATUS.OPEN && this.wanted) {
      try { this.socket.ws.close(); } catch (_) {}
    }
  }

  _rejoin() {
    if (this.socket.state !== RT_STATUS.OPEN) return;
    this.socket.send({ topic: this.topic, event: 'phx_leave', payload: {}, ref: this.socket.nextRef() });
    this.state = 'closed';
    this._join();
  }

  _onSocketClosed() {
    if (this.state === 'joined' || this.state === 'joining') this.state = 'closed';
    this._presence = {};
    // The socket went away with a join still in flight. The channel will retry
    // on the backoff ladder, but the caller who is awaiting subscribe() has to
    // be told NOW — it is the only way it can render its offline fallback.
    this._settleJoin({ status: 'CHANNEL_ERROR', error: sbError(ERR.NETWORK, 'Live updates dropped.') });
  }

  _handle(event, payload) {
    switch (event) {
      case 'postgres_changes': return this._handlePostgres(payload);
      case 'broadcast': return this._handleBroadcast(payload);
      case 'presence_state': return this._handlePresenceState(payload);
      case 'presence_diff': return this._handlePresenceDiff(payload);
      case 'phx_error':
        this.state = 'errored';
        this._emitStatus('CHANNEL_ERROR', sbError(ERR.NETWORK, 'Live updates dropped. Retrying…'));
        return;
      case 'phx_close':
        this.state = 'closed';
        this._emitStatus('CLOSED', null);
        return;
      case 'system':
        /* Realtime reports token problems here — refresh once, then rejoin. */
        if (payload && /token/i.test(String(payload.message || ''))) {
          refreshSession().then((ok) => { if (ok && this.wanted) this._rejoin(); });
        }
        return;
      default: return;
    }
  }

  _handlePostgres(payload) {
    if (!payload) return;
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    const d = payload.data || payload;
    const evt = {
      eventType: String(d.type || d.eventType || '').toUpperCase(),
      new: d.record || d.new || null,
      old: d.old_record || d.old || null,
      table: d.table || null,
      schema: d.schema || 'public',
      commitTimestamp: d.commit_timestamp || null,
      errors: d.errors || null,
    };
    for (const b of this._pgBindings) {
      const idMatch = b.serverId == null ? true : ids.indexOf(b.serverId) >= 0;
      const tableMatch = b.table === '*' || b.table === evt.table;
      const eventMatch = b.event === '*' || b.event === evt.eventType;
      if (idMatch && tableMatch && eventMatch) {
        try { b.cb(evt); } catch (e) { console.error('[sb] postgres handler failed', e); }
      }
    }
  }

  _handleBroadcast(payload) {
    if (!payload) return;
    const ev = String(payload.event || '');
    const body = payload.payload !== undefined ? payload.payload : payload;
    for (const key of [ev, '*']) {
      const set = this._broadcast.get(key);
      if (!set) continue;
      for (const cb of Array.from(set)) {
        try { cb(body, ev); } catch (e) { console.error('[sb] broadcast handler failed', e); }
      }
    }
  }

  _handlePresenceState(payload) {
    this._presence = flattenPresence(payload || {});
    this._emitPresence({ joins: this._presence, leaves: {} });
  }

  _handlePresenceDiff(payload) {
    const joins = flattenPresence((payload && payload.joins) || {});
    const leaves = flattenPresence((payload && payload.leaves) || {});
    for (const k of Object.keys(leaves)) delete this._presence[k];
    for (const k of Object.keys(joins)) this._presence[k] = joins[k];
    this._emitPresence({ joins, leaves });
  }

  _emitPresence(diff) {
    for (const cb of Array.from(this._presenceCbs)) {
      try { cb(this._presence, diff); } catch (e) { console.error('[sb] presence handler failed', e); }
    }
  }
}

/** `{key:{metas:[…]}}` (wire shape) -> `{key:[…]}` (what features want). */
function flattenPresence(raw) {
  const out = {};
  for (const key of Object.keys(raw || {})) {
    const entry = raw[key];
    const metas = entry && Array.isArray(entry.metas) ? entry.metas : (Array.isArray(entry) ? entry : []);
    out[key] = metas.map((m) => {
      const copy = Object.assign({}, m);
      delete copy.phx_ref;
      delete copy.phx_ref_prev;
      return copy;
    });
  }
  return out;
}

const socket = new RealtimeSocket();

const realtime = {
  /**
   * Get (or create) a channel. Calling this twice with the same name returns
   * the SAME channel — register your handlers, then `subscribe()`.
   * @param {string} name
   * @returns {RealtimeChannel}
   */
  channel(name) {
    const key = String(name || 'default');
    if (!socket.channels.has(key)) socket.channels.set(key, new RealtimeChannel(socket, key));
    return socket.channels.get(key);
  },
  /** 'closed' | 'connecting' | 'open' */
  status() { return socket.state; },
  /** cb(status, detail) for connection banners. Returns off. */
  onStatus(cb) { return socket.onStatus(cb); },
  connect() { socket.connect(); },
  disconnect() { socket.disconnect(); },
  /** Leave every channel and drop the socket (call from a view's onExit). */
  leaveAll() {
    for (const ch of Array.from(socket.channels.values())) ch.unsubscribe();
    socket.disconnect();
  },
};

/* ===========================================================================
   6. STORAGE
   ======================================================================== */

const IMAGE_MIME = /^image\//i;

function encodePath(path) {
  return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * Storage hands back `signedURL` either absolute, or relative to /storage/v1
 * ('/object/sign/…'), or already carrying the prefix. Normalise all three.
 */
function absoluteStorageUrl(signed) {
  let p = String(signed || '');
  if (/^https?:\/\//i.test(p)) return p;
  if (p.charAt(0) !== '/') p = '/' + p;
  if (p.indexOf(STORAGE_PATH + '/') !== 0) p = STORAGE_PATH + p;
  return baseUrl() + p;
}

const storage = {
  /**
   * Upload a Blob/File. Path MUST start with the uploader's user id — the
   * storage policy enforces `(storage.foldername(name))[1] = auth.uid()`.
   * @returns {Promise<{url, path, bucket, error}>}
   */
  async upload(bucket, path, blob, opts) {
    const o = opts || {};
    if (!hasSupabase()) return { url: null, path: null, bucket, error: NOT_CONFIGURED() };
    if (!getAccessToken()) return { url: null, path: null, bucket, error: NEEDS_AUTH() };
    if (!blob || typeof blob.size !== 'number') {
      return { url: null, path: null, bucket, error: sbError(ERR.BAD_REQUEST, 'Nothing to upload.') };
    }

    /* Callers may name the type explicitly (a canvas blob often has none). */
    const contentType = o.contentType || blob.type || 'application/octet-stream';

    /* Mirror of the server policy so the student hears it before the upload. */
    const isImage = IMAGE_MIME.test(contentType);
    const maxMB = isImage ? CONFIG.LIMITS.imageMaxMB : CONFIG.LIMITS.fileMaxMB;
    if (blob.size > maxMB * 1024 * 1024) {
      return { url: null, path: null, bucket, error: sbError(ERR.TOO_LARGE,
        'That file is ' + (blob.size / (1024 * 1024)).toFixed(1) + ' MB — the limit is ' + maxMB + ' MB.') };
    }

    const res = await request(STORAGE_PATH + '/object/' + encodeURIComponent(bucket) + '/' + encodePath(path), {
      method: 'POST',
      body: blob,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'max-age=31536000',
        'x-upsert': o.upsert === false ? 'false' : 'true',
      },
      timeoutMs: o.timeoutMs || UPLOAD_TIMEOUT_MS,
      retries: 0,
      ctx: 'storage',
    });
    if (res.error) return { url: null, path: null, bucket, error: res.error };

    const url = await resolveUrl(bucket, path, o.expiresIn);
    return { url, path: String(path), bucket, error: null };
  },

  /**
   * Public URL for an object in a PUBLIC bucket ('avatars'). Pure string —
   * no network. For the private 'attachments' bucket use `signedUrl()`.
   */
  publicUrl(bucket, path) {
    if (!hasSupabase()) return '';
    return baseUrl() + STORAGE_PATH + '/object/public/' + encodeURIComponent(bucket) + '/' + encodePath(path);
  },

  /**
   * Time-limited URL for a private bucket. Safe in `<img src>` (the token
   * rides in the query string).
   * @param {number} [expiresIn] seconds, default 7 days
   */
  async signedUrl(bucket, path, expiresIn) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    const res = await request(STORAGE_PATH + '/object/sign/' + encodeURIComponent(bucket) + '/' + encodePath(path), {
      method: 'POST',
      json: { expiresIn: Number(expiresIn) || 604800 },
      retries: 1,
      ctx: 'storage',
    });
    if (res.error) return { data: null, error: res.error };
    const signed = res.data && (res.data.signedURL || res.data.signedUrl);
    if (!signed) return { data: null, error: sbError(ERR.UNKNOWN, 'Could not sign that file link.') };
    return { data: absoluteStorageUrl(signed), error: null };
  },

  /** Delete one object. Owner-or-admin per the storage policy. */
  async remove(bucket, path) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    const res = await request(STORAGE_PATH + '/object/' + encodeURIComponent(bucket) + '/' + encodePath(path), {
      method: 'DELETE', retries: 0, ctx: 'storage',
    });
    if (res.error) return { data: null, error: res.error };
    return { data: true, error: null };
  },

  /** Bucket metadata (cached). Used to decide public vs signed URLs. */
  async info(bucket) {
    if (bucketCache.has(bucket)) return { data: bucketCache.get(bucket), error: null };
    const res = await request(STORAGE_PATH + '/bucket/' + encodeURIComponent(bucket), { retries: 1, ctx: 'storage' });
    // Cache the MISS too. GET /bucket/:id reads storage.buckets, which needs a
    // select policy (schema.sql §8 adds one) — on a database that has not been
    // re-applied it fails every single time, and an uncached failure meant one
    // guaranteed-losing round trip per avatar render.
    if (res.error) { bucketCache.set(bucket, null); return { data: null, error: res.error }; }
    bucketCache.set(bucket, res.data);
    return { data: res.data, error: null };
  },
};

const bucketCache = new Map();

/* Buckets schema.sql creates as public. If the bucket lookup fails (no select
   policy on storage.buckets, offline, older schema), fall back to what the
   schema says rather than to a 7-day signed token that expires into a dead
   image. A public URL for a public bucket is correct forever; a signed URL for
   a public bucket is correct for a week and then 400s. */
const PUBLIC_BUCKETS = new Set(['avatars']);

/** Public bucket -> plain URL; private bucket -> signed URL. */
async function resolveUrl(bucket, path, expiresIn) {
  const info = await storage.info(bucket);
  if (info.data && info.data.public) return storage.publicUrl(bucket, path);
  if (!info.data && PUBLIC_BUCKETS.has(bucket)) return storage.publicUrl(bucket, path);
  const signed = await storage.signedUrl(bucket, path, expiresIn);
  return signed.data || null;
}

/* ===========================================================================
   6b. EFFORT BOARD — the one writer of xp_weekly
   ---------------------------------------------------------------------------
   schema.sql exposes upsert_xp_weekly() as the ONLY way into the xp_weekly
   table (it has no client insert/update policy). Nothing else in the hub calls
   it, so without this the friends board would show every member on zero
   forever. The numbers are derived here, from `store` alone — sb.js never
   imports game.js, and game.js never has to know Supabase exists.

   WHAT COUNTS AS EFFORT (pedagogy-spec §4): retrieval attempts — including the
   wrong ones — and nights shown up. Never marks, never accuracy, never a
   predicted grade. The table has no column for those and must never grow one.

   `xp` here is the number of review-log entries since the local Monday. That
   is a count of attempts, so it only ever rises inside a week, which matches
   the RPC's monotonic clamp: a stale tab can never lower somebody's total.
   ======================================================================== */

/** Do not hammer the API: at most one push per this interval, plus one on sign-in. */
const EFFORT_MIN_INTERVAL_MS = 5 * 60 * 1000;

const E = { lastPushAt: 0, lastSig: '', timer: null, inFlight: null, wired: false };

/**
 * The local Monday of the week containing `iso` (default today).
 * Day math is LOCAL only — Nepal is UTC+05:45 and `toISOString` is banned for
 * day arithmetic (CONTRACT-A §16.1).
 * @param {string} [iso] 'YYYY-MM-DD'
 * @returns {string} 'YYYY-MM-DD'
 */
export function weekStartISO(iso) {
  const day = iso || todayLocalISO();
  const d = parseLocalISO(day);
  if (!d) return day;
  const back = (d.getDay() + 6) % 7;          // getDay(): 0 = Sunday
  return addDaysISO(day, -back);
}

/** Derive this week's effort from local storage. Never throws. */
function effortSnapshot() {
  const week = weekStartISO();
  const start = parseLocalISO(week);
  let entries = [];
  try {
    entries = store.getReviewLog({ since: start ? start.getTime() : 0 }) || [];
  } catch (_) { entries = []; }

  const days = new Set();
  for (const e of entries) if (e && e.day) days.add(e.day);

  let streakDays = 0;
  try {
    const s = store.get(KEYS.STREAK, null);
    streakDays = Math.max(0, Number(s && s.count) || 0);
  } catch (_) { streakDays = 0; }

  return { week, xp: entries.length, streakDays, sessions: days.size };
}

function effortSignature(s) {
  return [s.week, s.xp, s.streakDays, s.sessions].join('|');
}

function scheduleEffortSync(delayMs) {
  if (E.timer) return;
  E.timer = setTimeout(() => { E.timer = null; effort.sync(); }, Math.max(1000, delayMs));
}

export const effort = {
  /** This week's numbers as they would be pushed. Read-only, no network. */
  snapshot: () => effortSnapshot(),

  weekStartISO,

  /**
   * Push a week's effort row. Pass nothing to push the current snapshot.
   * game.js may call this directly on an XP or streak event if it prefers to
   * drive the timing itself — it is idempotent and the server clamps.
   * @returns {Promise<{data,error}>}
   */
  async push(snap) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    if (!getAccessToken()) return { data: null, error: NEEDS_AUTH() };
    const s = snap && typeof snap === 'object' ? snap : effortSnapshot();
    return db.rpc('upsert_xp_weekly', {
      p_week: s.week || weekStartISO(),
      p_xp: Math.max(0, Number(s.xp) || 0),
      p_streak: Math.max(0, Number(s.streakDays) || 0),
      p_sessions: Math.max(0, Number(s.sessions) || 0),
    });
  },

  /**
   * Push if the numbers actually moved and the throttle window has passed.
   * Silent by design: the board is a nicety and must never interrupt a review.
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<boolean>} true when a row was written
   */
  async sync(opts) {
    const force = Boolean(opts && opts.force);
    if (!hasSupabase() || !getAccessToken()) return false;
    if (E.inFlight) return E.inFlight;

    const snap = effortSnapshot();
    const sig = effortSignature(snap);
    if (!force && sig === E.lastSig) return false;

    const waited = nowTs() - E.lastPushAt;
    if (!force && waited < EFFORT_MIN_INTERVAL_MS) {
      scheduleEffortSync(EFFORT_MIN_INTERVAL_MS - waited);
      return false;
    }

    E.inFlight = (async () => {
      const { error } = await this.push(snap);
      if (error) {
        /* A refused push is not the student's problem. Try again next change. */
        if (error.code !== ERR.NOT_CONFIGURED && error.code !== ERR.AUTH_REQUIRED) {
          console.debug('[sb] effort sync deferred:', error.code, error.message);
        }
        return false;
      }
      E.lastSig = sig;
      E.lastPushAt = nowTs();
      return true;
    })().finally(() => { E.inFlight = null; });

    return E.inFlight;
  },

  /**
   * The friends board, newest week first. EFFORT COLUMNS ONLY.
   * @param {string} [sinceISO] 'YYYY-MM-DD' — defaults to this week's Monday
   * @returns {Promise<{data:Array|null, error}>}
   */
  async board(sinceISO) {
    if (!hasSupabase()) return { data: null, error: NOT_CONFIGURED() };
    const since = weekStartISO(sinceISO || todayLocalISO());

    const viaRpc = await db.rpc('effort_leaderboard', { since_day: since });
    if (!viaRpc.error && Array.isArray(viaRpc.data)) return { data: viaRpc.data, error: null };

    /* Older projects may not have the function yet — the view carries the same
       columns. Filter on `week`, which is a real column (there is no
       `since_day` column anywhere; that name belongs to the RPC argument). */
    const viaView = await db.select('effort_leaderboard_view', {
      filters: { week: { gte: since } },
      order: [{ column: 'xp_week', ascending: false }, { column: 'streak_days', ascending: false }],
      limit: 50,
    });
    if (!viaView.error && Array.isArray(viaView.data)) return { data: viaView.data, error: null };
    return { data: null, error: viaView.error || viaRpc.error };
  },
};

/**
 * Keep the board fresh without any other module knowing. Pushes once when a
 * session appears and thereafter at most once every 5 minutes, when the review
 * log or the streak actually changes.
 */
function wireEffortSync() {
  if (E.wired) return;
  E.wired = true;

  auth.onChange((event) => {
    if (event === 'SIGNED_IN' || event === 'RESTORED') {
      effort.sync({ force: true });
    } else if (event === 'SIGNED_OUT') {
      E.lastSig = '';
      E.lastPushAt = 0;
      if (E.timer) { clearTimeout(E.timer); E.timer = null; }
    }
  });

  try {
    store.subscribe('*', (_value, key) => {
      if (key === KEYS.REVIEW_LOG || key === KEYS.STREAK || key === KEYS.GAME) effort.sync();
    });
  } catch (_) { /* a memory-only store still works; the board just waits */ }
}

/* ===========================================================================
   7. PUBLIC OBJECT
   ======================================================================== */

export const sb = {
  /** True when SUPABASE_URL + SUPABASE_ANON_KEY are filled in (js/config.js). */
  ready: () => hasSupabase(),
  /** The configured project URL (empty string when unconfigured). */
  url: () => baseUrl(),
  auth,
  db,
  realtime,
  storage,
  effort,
  ERR,
  sbError,
};

/* Restore any cached session as soon as the module is imported so that
   `sb.auth.user()` is truthful on the first render. */
loadSession();

/* Start mirroring effort to the board. No-op until a session exists. */
wireEffortSync();

export default sb;
