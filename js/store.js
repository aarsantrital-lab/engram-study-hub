/* =============================================================================
   js/store.js — namespaced local persistence + the append-only review log.
   Job A2 (data layer). LEAF MODULE: imports nothing.

   Design rules that are NOT negotiable (build-constraints):
     §9.1  Every date is built from getFullYear/getMonth/getDate. Nepal is
           UTC+05:45; `toISOString()` is NEVER used for day math.
     §9.3  On QuotaExceededError we REFUSE the write and raise a 'quota' event.
           We never delete, prune or shed user data to make room.
     §3.3  The review log is append-only. There is no delete API. Sync marks a
           watermark; it does not remove entries.
     §3    engram.py is the scheduler of record. Everything here is a CACHE plus
           a durable outbox (the JSONL) that gets replayed via `rate --file`.

   ---------------------------------------------------------------------------
   QUICK USE (feature agents)
       import { store, KEYS, todayLocalISO } from './store.js';
       const s   = store.get(KEYS.SRS, {});
       const ok  = store.set(KEYS.SRS, s);          // false => quota refused
       store.update(KEYS.SRS, prev => ({ ...prev, [id]: card }));
       const off = store.subscribe(KEYS.SRS, (val, key) => render());
       store.appendReviewLog({ cardId, rating: 3, elapsedMs: 4200, kind: 'review' });
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. Constants
   ------------------------------------------------------------------------ */

/** localStorage key prefix. Every key we own looks like `engram2:<name>`. */
export const NAMESPACE = 'engram2';
const SEP = ':';

/** Bump when a stored shape changes and add a migration below. */
export const SCHEMA_VERSION = 3;

/**
 * Canonical key registry. Feature agents MUST claim a key here (by using one of
 * these constants) instead of inventing raw strings, so nothing collides.
 * Anything not listed can still be used via store.get('myKey') — the namespace
 * keeps it out of everyone else's way — but adding it here is preferred.
 */
export const KEYS = Object.freeze({
  META: '__meta',            // {schema, createdAt, updatedAt, legacyImported}
  SETTINGS: 'settings',      // config.js DEFAULT_SETTINGS shape
  UI: 'ui',                  // ephemeral view state (scroll, last tab, stubs)
  PROFILE: 'profile',        // {displayName, bio, avatar, status, title, frame}

  SRS: 'srs',                // cardId -> {due, stability, difficulty, reps, lapses, lastISO}
  REVIEW_LOG: 'reviewLog',   // APPEND-ONLY array of review events (see below)
  SESSIONS: 'sessions',      // 'YYYY-MM-DD' -> {seconds, reviews, correct, rings}
  STREAK: 'streak',          // {count, longest, lastDay, freezes, lifetimeDays}
  RINGS: 'rings',            // 'YYYY-MM-DD' -> {review:{done,goal}, encode:{}, drill:{}}

  GROW: 'grow',              // unitId -> {selfRating:'R'|'Y'|'G', measured, updatedISO}
  ERROR_BOOK: 'errorBook',   // array of {id, ts, cardId, given, correct, missing, confidence}
  MISCONCEPTIONS: 'misconceptions',
  NUMERICALS: 'numericals',  // problemType -> {scaffoldLevel 0-4, streak}
  PAPERS: 'papers',          // paperId -> {attempts:[{ts, marks, perQuestion}]}
  PREDICTED: 'predicted',    // subject -> {marks, letter, gp, updatedISO}

  MAPS: 'maps',              // topicId -> {nodes, edges, version, updatedISO}
  NOTES: 'notes',            // topicId -> [{id, title, body, createdTs}]
  USER_CARDS: 'userCards',   // topicId -> [{id, q, a, user:true}]
  ASSETS: 'assets',          // topicId -> [{id, name, kind, data, createdTs}]
  STARRED: 'starred',        // cardId -> true
  SUSPENDED: 'suspended',    // cardId -> true

  GAME: 'game',              // {xp, level, badges:[], titles:[], quests:{}}
  PET: 'pet',                // {name, stage, mood, lastFedISO}
  FOCUS: 'focus',            // {sessions:[], preset, muteChat}
  SEARCH_RECENT: 'searchRecent',
  CHAT_CACHE: 'chatCache',
  AUTH: 'auth',              // supabase session cache (token handling is Job E's)
});

/** FSRS grade constants — mirror engram.py `rate --rating`. */
export const RATING = Object.freeze({ AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 });
export const RATING_NAMES = Object.freeze({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' });
/** engram.py `--kind` values. */
export const REVIEW_KINDS = Object.freeze(['encode', 'review', 'pretest', 'transfer', 'audit']);
/** engram.py `--grade` values. */
export const REVIEW_GRADES = Object.freeze(['recalled', 'partial', 'lapsed']);
/** engram.py `--error-class` values. */
export const ERROR_CLASSES = Object.freeze(['slip', 'conceptual']);

/* ---------------------------------------------------------------------------
   2. LOCAL date helpers  (build-constraints §9.1 — the whole point)
   ------------------------------------------------------------------------ */

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * Local calendar date of a Date object as YYYY-MM-DD.
 * Built from getFullYear/getMonth/getDate — NEVER toISOString().
 * @param {Date} [d]
 */
export function localISO(d) {
  const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}

/** Today's local calendar date, YYYY-MM-DD. */
export function todayLocalISO() { return localISO(new Date()); }

/** Local calendar date for an epoch-ms timestamp. */
export function dayKeyFromTs(ts) { return localISO(new Date(Number(ts) || Date.now())); }

/** Parse 'YYYY-MM-DD' into a Date at LOCAL midnight (not UTC midnight). */
export function parseLocalISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

/** Date at local midnight for a Date/timestamp. */
export function startOfLocalDay(d) {
  const x = d instanceof Date ? new Date(d.getTime()) : new Date(d == null ? Date.now() : d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Add whole days to a YYYY-MM-DD string, DST-safe (uses the local calendar). */
export function addDaysISO(iso, days) {
  const base = parseLocalISO(iso) || startOfLocalDay(new Date());
  return localISO(new Date(base.getFullYear(), base.getMonth(), base.getDate() + (Number(days) || 0)));
}

/** Whole days from isoA to isoB (b - a). Calendar arithmetic, DST-immune. */
export function diffDaysISO(isoA, isoB) {
  const a = parseLocalISO(isoA), b = parseLocalISO(isoB);
  if (!a || !b) return 0;
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

/** Days from today (negative = past). */
export function daysFromToday(iso) { return diffDaysISO(todayLocalISO(), iso); }

/**
 * TEST/PORTABILITY HELPER — the local calendar date an observer at a fixed UTC
 * offset would write down for an instant. Lets the unit tests pin Nepal's
 * +05:45 regardless of the machine running them. Not used by app code.
 * @param {number} ts epoch ms
 * @param {number} offsetMinutes e.g. 345 for UTC+05:45
 */
export function isoAtOffset(ts, offsetMinutes) {
  const d = new Date(Number(ts) + Number(offsetMinutes) * 60000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Nepal Standard Time offset in minutes (UTC+05:45). Reference constant. */
export const NPT_OFFSET_MINUTES = 345;

export function nowTs() { return Date.now(); }

/** Short unique id, sortable-ish by time. */
export function uid(prefix) {
  return (prefix || 'x') + '-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 8);
}

/* ---------------------------------------------------------------------------
   3. Backends
   ------------------------------------------------------------------------ */

/** In-memory Storage-compatible backend (Safari private mode, file://, tests). */
export function createMemoryBackend(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    isMemory: true,
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

function detectBackend() {
  try {
    const ls = globalThis.localStorage;
    const probe = '__engram_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch (_) {
    return createMemoryBackend();
  }
}

function isQuotaError(err) {
  if (!err) return false;
  return err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 || err.code === 1014 ||
    /quota|exceeded|storage is full/i.test(String(err.message || ''));
}

/* ---------------------------------------------------------------------------
   4. Migrations.  MIGRATIONS[n] upgrades a schema-n snapshot to schema n+1.
      `data` is a plain object of un-namespaced key -> parsed value.
   ------------------------------------------------------------------------ */

export const MIGRATIONS = {
  /* 1 -> 2 : the very first hub kept one blob under `engramStudyHub`.
     Its reviews map moves to `srs`; nothing else survived. */
  1(data) {
    const out = Object.assign({}, data);
    if (out.reviews && !out.srs) { out.srs = out.reviews; delete out.reviews; }
    return out;
  },
  /* 2 -> 3 : v2 (`engram.hub.v2`) shape -> namespaced v3 keys.
     - reviews -> srs
     - userNotes -> notes, userAssets -> assets
     - prefs.{dailyNew,mode,sound} -> settings
     - reviewLog created (it did not exist; SM-2 history was inside `reviews`) */
  2(data) {
    const out = Object.assign({}, data);
    if (out.reviews && !out.srs) { out.srs = out.reviews; delete out.reviews; }
    if (out.userNotes && !out.notes) { out.notes = out.userNotes; delete out.userNotes; }
    if (out.userAssets && !out.assets) { out.assets = out.userAssets; delete out.userAssets; }
    if (out.prefs) {
      out.settings = Object.assign({}, out.settings, {
        sounds: out.prefs.sound === true,
        dailyMinutes: 25,
      });
      delete out.prefs;
    }
    if (!Array.isArray(out.reviewLog)) out.reviewLog = [];
    return out;
  },
};

/** Run a data snapshot forward from `from` to SCHEMA_VERSION. */
export function migrateData(data, from) {
  let v = Number(from) || 1;
  let out = data && typeof data === 'object' ? data : {};
  const trail = [];
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (typeof step === 'function') {
      try { out = step(out) || out; trail.push(v + '->' + (v + 1)); }
      catch (err) { console.warn('[store] migration ' + v + ' failed', err); }
    }
    v += 1;
  }
  return { data: out, applied: trail, schema: SCHEMA_VERSION };
}

/* ---------------------------------------------------------------------------
   5. Review-log entry normalisation (mirrors engram.py `rate` semantics)
   ------------------------------------------------------------------------ */

/**
 * @typedef {Object} ReviewEntry
 * @property {number} v            entry format version (1)
 * @property {string} id           stable id — the replay dedupe key
 * @property {string} cardId       REQUIRED. matches vault-data flashcard id
 * @property {string|null} topic   engram.py --topic
 * @property {string|null} node    engram.py --node (defaults to cardId)
 * @property {number} ts           epoch ms (local clock)
 * @property {string} day          LOCAL YYYY-MM-DD for that ts
 * @property {1|2|3|4} rating      1 again · 2 hard · 3 good · 4 easy
 * @property {string} ratingName   again|hard|good|easy
 * @property {number|null} confidence  1-5, picked by the student or null.
 *                                     NEVER inferred (engine invariant 6).
 * @property {number} elapsedMs    time from card shown to answer submitted
 * @property {string} kind         encode|review|pretest|transfer|audit
 * @property {string|null} grade   recalled|partial|lapsed
 * @property {string|null} errorClass  slip|conceptual
 * @property {boolean} probe       engram.py --probe
 * @property {string} source       'hub' (or 'hub-focus', 'hub-cram', …)
 * @property {boolean} synced      set true by markReviewLogSynced()
 */

function normalizeReviewEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const cardId = String(input.cardId || '').trim();
  if (!cardId) return null;

  let rating = Number(input.rating);
  if (!Number.isInteger(rating)) {
    const byName = Object.keys(RATING_NAMES).find(k => RATING_NAMES[k] === String(input.rating).toLowerCase());
    rating = byName ? Number(byName) : NaN;
  }
  if (!(rating >= 1 && rating <= 4)) return null;

  const ts = Number.isFinite(Number(input.ts)) ? Number(input.ts) : Date.now();

  let confidence = input.confidence;
  confidence = (confidence === null || confidence === undefined || confidence === '')
    ? null
    : Math.max(1, Math.min(5, Math.round(Number(confidence))));
  if (Number.isNaN(confidence)) confidence = null;

  const kind = REVIEW_KINDS.includes(input.kind) ? input.kind : 'review';
  const grade = REVIEW_GRADES.includes(input.grade) ? input.grade : null;
  const errorClass = ERROR_CLASSES.includes(input.errorClass) ? input.errorClass : null;

  let elapsedMs = Math.round(Number(input.elapsedMs));
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = 0;
  if (elapsedMs > 3600000) elapsedMs = 3600000;      // clamp AFK outliers at 1h

  return {
    v: 1,
    id: String(input.id || uid('rl')),
    cardId,
    topic: input.topic ? String(input.topic) : null,
    node: input.node ? String(input.node) : cardId,
    ts,
    day: dayKeyFromTs(ts),
    rating,
    ratingName: RATING_NAMES[rating],
    confidence,
    elapsedMs,
    kind,
    grade,
    errorClass,
    probe: input.probe === true,
    source: input.source ? String(input.source) : 'hub',
    synced: false,
  };
}

/* ---------------------------------------------------------------------------
   6. The store
   ------------------------------------------------------------------------ */

/**
 * Build an isolated store. The app uses the `store` singleton below; the unit
 * tests build throwaway stores over fake backends.
 * @param {{backend?:Object, namespace?:string, schemaVersion?:number,
 *          migrations?:Object, importLegacy?:boolean}} [opts]
 */
export function createStore(opts) {
  const o = opts || {};
  const backend = o.backend || detectBackend();
  const ns = (o.namespace || NAMESPACE) + SEP;
  const schemaVersion = o.schemaVersion || SCHEMA_VERSION;
  const migrations = o.migrations || MIGRATIONS;

  const cache = new Map();                    // key -> parsed value
  const subs = new Map();                     // key ('*' allowed) -> Set<fn>
  const events = new Map();                   // 'quota'|'change'|'error' -> Set<fn>
  const state = {
    /** false once localStorage rejected a write (or was never available). */
    persistent: !backend.isMemory,
    /** true when we fell back to memory entirely. */
    memoryOnly: Boolean(backend.isMemory),
    lastError: null,
    quota: null,                              // {key, bytes, ts} of the refusal
    refusedKeys: new Set(),
  };

  const full = (k) => ns + k;
  const short = (k) => (k.startsWith(ns) ? k.slice(ns.length) : null);

  function emit(name, payload) {
    const set = events.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error('[store] ' + name + ' handler failed', err); }
    }
  }
  function notify(key, value) {
    for (const k of [key, '*']) {
      const set = subs.get(k);
      if (!set) continue;
      for (const fn of Array.from(set)) {
        try { fn(value, key); } catch (err) { console.error('[store] subscriber failed', err); }
      }
    }
    emit('change', { key, value });
  }

  function readRaw(key) {
    try { return backend.getItem(full(key)); }
    catch (err) { state.lastError = err; return null; }
  }

  function writeRaw(key, json) {
    try {
      backend.setItem(full(key), json);
      state.refusedKeys.delete(key);
      // One oversized value (a big pasted image, say) must not brand the whole
      // store as broken forever: a write that lands proves storage still works.
      // `refusedKeys` is the durable truth about what is NOT saved.
      if (!state.memoryOnly) state.persistent = true;
      return true;
    } catch (err) {
      state.lastError = err;
      if (isQuotaError(err)) {
        // §9.3 — REFUSE. We do not evict, prune or shed anything.
        state.persistent = false;
        state.refusedKeys.add(key);
        state.quota = { key, bytes: json.length, ts: Date.now() };
        emit('quota', {
          key,
          bytes: json.length,
          usage: usageBytes(),
          message: 'This device’s storage is full. Your latest change is held in ' +
                   'memory only — export a backup now so nothing is lost.',
        });
        return false;
      }
      emit('error', { key, error: err });
      return false;
    }
  }

  /** All keys we own that exist in the backend. */
  function keys() {
    const out = new Set(cache.keys());
    try {
      for (let i = 0; i < backend.length; i++) {
        const s = short(backend.key(i) || '');
        if (s) out.add(s);
      }
    } catch (_) { /* backend may not enumerate */ }
    return Array.from(out);
  }

  function usageBytes() {
    let n = 0;
    for (const k of keys()) {
      const raw = readRaw(k);
      if (raw) n += (full(k).length + raw.length) * 2;   // UTF-16 estimate
    }
    return n;
  }

  /* ---- core KV ---- */

  function get(key, fallback) {
    if (cache.has(key)) {
      const v = cache.get(key);
      return v === undefined ? (fallback === undefined ? null : fallback) : v;
    }
    const raw = readRaw(key);
    if (raw === null || raw === undefined) return fallback === undefined ? null : fallback;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) {
      console.warn('[store] corrupt value at ' + key + ' — using fallback (value kept on disk)', err);
      emit('error', { key, error: err, corrupt: true });
      return fallback === undefined ? null : fallback;
    }
    cache.set(key, parsed);
    return parsed;
  }

  /**
   * @returns {boolean} true when the value reached durable storage.
   *   false = quota refused (value IS still live in memory; a banner is raised).
   */
  function set(key, value) {
    let json;
    try { json = JSON.stringify(value); }
    catch (err) { emit('error', { key, error: err }); return false; }
    if (json === undefined) json = 'null';

    cache.set(key, value);          // in-memory truth updates either way
    const ok = writeRaw(key, json);
    if (ok) touchMeta();
    notify(key, value);
    return ok;
  }

  function update(key, fn, fallback) {
    const next = fn(get(key, fallback === undefined ? null : fallback));
    set(key, next);
    return next;
  }

  function remove(key) {
    cache.delete(key);
    try { backend.removeItem(full(key)); } catch (err) { state.lastError = err; }
    notify(key, undefined);
  }

  function has(key) {
    return cache.has(key) || readRaw(key) !== null;
  }

  function subscribe(key, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => { const s = subs.get(key); if (s) s.delete(fn); };
  }

  function on(name, fn) {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name).add(fn);
    return () => { const s = events.get(name); if (s) s.delete(fn); };
  }

  /* ---- meta + migrations ---- */

  function readMeta() {
    const m = get(KEYS.META, null);
    return (m && typeof m === 'object') ? m : null;
  }

  function touchMeta() {
    const m = readMeta() || { schema: schemaVersion, createdAt: Date.now() };
    m.updatedAt = Date.now();
    m.updatedDay = todayLocalISO();
    m.schema = schemaVersion;
    cache.set(KEYS.META, m);
    try { backend.setItem(full(KEYS.META), JSON.stringify(m)); } catch (_) { /* non-fatal */ }
  }

  function snapshot() {
    const data = {};
    for (const k of keys()) { if (k !== KEYS.META) data[k] = get(k, null); }
    return data;
  }

  function runMigrations() {
    const meta = readMeta();
    // Legacy single-blob stores from hub v1/v2 live OUTSIDE our namespace.
    if (!meta) {
      const legacy = importLegacyBlobs();
      const from = legacy.from || schemaVersion;
      if (legacy.found) {
        const res = migrateData(legacy.data, from);
        for (const k of Object.keys(res.data)) {
          if (!has(k)) set(k, res.data[k]);
        }
        console.info('[store] migrated legacy data (' + (res.applied.join(', ') || 'none') + ')');
      }
      const m = { schema: schemaVersion, createdAt: Date.now(), updatedAt: Date.now(), legacyImported: legacy.found };
      set(KEYS.META, m);
      return { migrated: legacy.found, from, to: schemaVersion };
    }
    const from = Number(meta.schema) || 1;
    if (from < schemaVersion) {
      const res = migrateData(snapshot(), from);
      for (const k of Object.keys(res.data)) set(k, res.data[k]);
      meta.schema = schemaVersion;
      meta.migratedAt = Date.now();
      set(KEYS.META, meta);
      console.info('[store] schema ' + (res.applied.join(', ') || 'noop'));
      return { migrated: true, from, to: schemaVersion, applied: res.applied };
    }
    return { migrated: false, from: schemaVersion, to: schemaVersion };
  }

  /** Pull the old un-namespaced blobs, if present. Never deletes them. */
  function importLegacyBlobs() {
    const tryKey = (k) => { try { return backend.getItem(k); } catch (_) { return null; } };
    const v2 = tryKey('engram.hub.v2');
    if (v2) {
      try { return { found: true, from: 2, data: JSON.parse(v2) }; } catch (_) { /* fall through */ }
    }
    const v1 = tryKey('engramStudyHub');
    if (v1) {
      try { return { found: true, from: 1, data: JSON.parse(v1) }; } catch (_) { /* fall through */ }
    }
    return { found: false, from: schemaVersion, data: {} };
  }

  /* ---- review log (append-only) ---- */

  function appendReviewLog(entry) {
    const e = normalizeReviewEntry(entry);
    if (!e) { console.warn('[store] rejected malformed review entry', entry); return null; }
    const log = get(KEYS.REVIEW_LOG, []);
    const arr = Array.isArray(log) ? log : [];
    arr.push(e);
    const ok = set(KEYS.REVIEW_LOG, arr);
    if (!ok) emit('reviewlog-unsaved', e);
    return e;
  }

  /** Append many at once (one write). Returns the accepted entries. */
  function appendReviewLogBatch(entries) {
    const arr = get(KEYS.REVIEW_LOG, []);
    const list = Array.isArray(arr) ? arr : [];
    const accepted = [];
    for (const raw of (entries || [])) {
      const e = normalizeReviewEntry(raw);
      if (e) { list.push(e); accepted.push(e); }
    }
    if (accepted.length) {
      const ok = set(KEYS.REVIEW_LOG, list);
      if (!ok) emit('reviewlog-unsaved', accepted);
    }
    return accepted;
  }

  /**
   * @param {{since?:number, until?:number, cardId?:string, topic?:string,
   *          kind?:string, unsyncedOnly?:boolean, limit?:number}} [filter]
   */
  function getReviewLog(filter) {
    const f = filter || {};
    let out = get(KEYS.REVIEW_LOG, []);
    if (!Array.isArray(out)) out = [];
    out = out.filter((e) => {
      if (!e || typeof e !== 'object') return false;
      if (f.since !== undefined && e.ts < f.since) return false;
      if (f.until !== undefined && e.ts > f.until) return false;
      if (f.cardId && e.cardId !== f.cardId) return false;
      if (f.topic && e.topic !== f.topic) return false;
      if (f.kind && e.kind !== f.kind) return false;
      if (f.unsyncedOnly && e.synced) return false;
      return true;
    });
    if (f.limit && out.length > f.limit) out = out.slice(-f.limit);
    return out;
  }

  function reviewLogCount() { return getReviewLog().length; }

  /**
   * JSON Lines, one review event per line — the exact file that gets committed
   * into the vault repo and replayed with `engram.py rate --file`.
   */
  function exportReviewLogJSONL(filter) {
    const rows = getReviewLog(filter);
    if (!rows.length) return '';
    return rows.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  /**
   * Mark everything at or before `uptoTs` as synced. Sets a flag; DELETES
   * NOTHING (the log is append-only — build-constraints §3 invariant 3).
   */
  function markReviewLogSynced(uptoTs) {
    const cut = Number(uptoTs) || Date.now();
    let n = 0;
    const arr = get(KEYS.REVIEW_LOG, []);
    if (!Array.isArray(arr)) return 0;
    for (const e of arr) { if (e && e.ts <= cut && !e.synced) { e.synced = true; n += 1; } }
    if (n) set(KEYS.REVIEW_LOG, arr);
    const meta = readMeta() || {};
    meta.reviewLogSyncedUpto = cut;
    meta.reviewLogSyncedAt = Date.now();
    set(KEYS.META, meta);
    return n;
  }

  /* ---- export / import ---- */

  function exportAllData() {
    return {
      app: 'engram-study-hub',
      kind: 'engram-full-export',
      namespace: ns.slice(0, -1),
      schema: schemaVersion,
      exportedAt: Date.now(),
      exportedDay: todayLocalISO(),
      data: snapshot(),
    };
  }

  /**
   * @param {Object|string} payload result of exportAllData() (object or JSON)
   * @param {{merge?:boolean, dryRun?:boolean}} [opts] merge defaults to true
   */
  function importAllData(payload, opts) {
    const o = opts || {};
    const merge = o.merge !== false;
    let p = payload;
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch (err) { return { ok: false, error: 'Not valid JSON: ' + err.message }; }
    }
    if (!p || typeof p !== 'object') return { ok: false, error: 'Empty or malformed backup.' };
    const incoming = (p.data && typeof p.data === 'object') ? p.data : p;
    const fromSchema = Number(p.schema) || 1;
    const migrated = migrateData(incoming, fromSchema).data;

    const report = { ok: true, imported: [], skipped: [], merged: [], applied: fromSchema + '->' + schemaVersion };
    for (const key of Object.keys(migrated)) {
      if (key === KEYS.META) { report.skipped.push(key); continue; }
      const incomingVal = migrated[key];
      if (incomingVal === undefined) { report.skipped.push(key); continue; }
      if (o.dryRun) { report.imported.push(key); continue; }

      if (!merge || !has(key)) { set(key, incomingVal); report.imported.push(key); continue; }

      const currentVal = get(key, null);
      if (key === KEYS.REVIEW_LOG && Array.isArray(currentVal) && Array.isArray(incomingVal)) {
        const seen = new Set(currentVal.map((e) => e && e.id));
        const added = incomingVal.filter((e) => e && !seen.has(e.id)).map(normalizeReviewEntry).filter(Boolean);
        const joined = currentVal.concat(added).sort((a, b) => a.ts - b.ts);
        set(key, joined);
        report.merged.push(key + ' (+' + added.length + ')');
      } else if (Array.isArray(currentVal) && Array.isArray(incomingVal)) {
        set(key, currentVal.concat(incomingVal));
        report.merged.push(key);
      } else if (currentVal && typeof currentVal === 'object' && incomingVal && typeof incomingVal === 'object') {
        set(key, Object.assign({}, currentVal, incomingVal));
        report.merged.push(key);
      } else {
        set(key, incomingVal);
        report.imported.push(key);
      }
    }
    if (!o.dryRun) touchMeta();
    return report;
  }

  /** Trigger a file download in the browser (no-op outside a document). */
  function downloadFile(filename, text, mime) {
    if (typeof document === 'undefined') return false;
    try {
      const blob = new Blob([text], { type: mime || 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch (err) { console.error('[store] download failed', err); return false; }
  }

  function downloadBackup() {
    return downloadFile(
      'engram-backup-' + todayLocalISO() + '.json',
      JSON.stringify(exportAllData(), null, 2),
      'application/json'
    );
  }

  function downloadReviewLog() {
    return downloadFile(
      'engram-reviews-' + todayLocalISO() + '.jsonl',
      exportReviewLogJSONL(),
      'application/x-ndjson'
    );
  }

  /**
   * Destroy local state. EXPLICIT USER ACTION ONLY — never called on quota,
   * never called automatically. Always offer a backup first.
   */
  function resetAll(confirmToken) {
    if (confirmToken !== 'I understand this deletes local progress') {
      throw new Error('store.resetAll requires the explicit confirmation token');
    }
    for (const k of keys()) remove(k);
    cache.clear();
    touchMeta();
    return true;
  }

  const api = {
    // identity
    namespace: ns.slice(0, -1),
    schema: schemaVersion,
    state,
    get isPersistent() { return state.persistent; },
    get isMemoryOnly() { return state.memoryOnly; },

    /** true when one or more values are live in memory but NOT on disk.
     *  This — not isPersistent — is what a "your work is at risk" UI reads. */
    hasUnsavedData: () => state.refusedKeys.size > 0,
    unsavedKeys: () => Array.from(state.refusedKeys),

    // core
    get, set, update, remove, has, keys, subscribe, on, snapshot, usageBytes,

    // review log
    appendReviewLog, appendReviewLogBatch, getReviewLog, reviewLogCount,
    exportReviewLogJSONL, markReviewLogSynced,

    // backup
    exportAllData, importAllData, downloadBackup, downloadReviewLog, downloadFile,

    // lifecycle
    runMigrations, resetAll,

    // dates (also exported at module level)
    todayLocalISO, localISO, addDaysISO, diffDaysISO, dayKeyFromTs, uid,
  };

  if (o.autoMigrate !== false) api.migrationResult = runMigrations();
  return api;
}

/** The app-wide singleton. */
export const store = createStore();

export default store;
