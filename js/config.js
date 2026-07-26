/* =============================================================================
   js/config.js — the single configuration object for the whole hub.
   Job A2 (app shell / PWA / data layer). Feature agents READ from here; the
   only values a human ever edits are SUPABASE_URL, SUPABASE_ANON_KEY and
   ADMIN_EMAIL (see supabase/SETUP.md).

   Imports: store.js only (leaf-safe: store.js imports nothing).
   ========================================================================== */

import { store, KEYS } from './store.js';

/** Bumped by hand on every deploy. sw.js keys its cache off this string. */
export const APP_VERSION = '2.1.1';

/** Display name used in <title>, manifest fallbacks, export filenames. */
export const APP_NAME = 'Engram';

export const CONFIG = {
  APP_NAME,
  APP_VERSION,

  /* ---- Supabase (chat / leaderboard / profiles). Empty = feature off. ---- */
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  /* ---- Admin. PLACEHOLDER — paste the real address here at setup time.
     This repo is public, so no personal address is committed by default.
     It only gates which moderation UI is *shown*; the real authorisation is
     the Supabase RLS policy, which must check auth.uid() server-side and must
     never trust this value. ---------------------------------------------- */
  ADMIN_EMAIL: 'you@example.com',

  /* ---- Feature flags. `isFeatureEnabled()` layers user settings on top. ---- */
  FEATURES: {
    chat: true,        // requires SUPABASE_URL — see isFeatureEnabled()
    sounds: true,
    haptics: true,
    pet: true,
    game: true,
    focus: true,
    papers: true,
    search: true,
    install: true,     // show the PWA install prompt affordance
  },

  /* ---- Hard limits. Mirrored server-side in Supabase RLS/storage policy. --- */
  LIMITS: {
    imageMaxMB: 5,
    fileMaxMB: 2,
    cooldownSec: 5,
    messageMaxChars: 2000,
    displayNameMaxChars: 32,
    bioMaxChars: 190,
    searchResults: 40,
    reviewLogSoftMax: 20000,   // advisory only — the log is NEVER auto-pruned
  },

  /* ---- Icon sprite. dom.js inlines this at boot; ids are bare Lucide names,
     e.g. assets/icons.svg#flame  ->  icon('flame'). ------------------------ */
  ICON_SPRITE: 'assets/icons.svg',
  ICON_PREFIX: '',

  /* ---- Locale / time. All day math is LOCAL Y/M/D (build-constraints §9.1).
     TIMEZONE is documentation + display only; never used for day arithmetic. */
  TIMEZONE: 'Asia/Kathmandu',
  TIMEZONE_LABEL: 'NPT (UTC+05:45)',
  LOCALE: 'en-GB',
  NIGHTLY_LOOP: '22:25',       // 10:25 PM NPT — pedagogy-spec §1.7

  /* ---- Paths (all relative — the hub is served from a GitHub Pages subpath) */
  PATHS: {
    vaultData: 'vault-data.js',
    assets: 'assets/',
    serviceWorker: 'sw.js',
  },
};

/** Default user settings. The Settings view (Job D/F) owns the UI; this is the
 *  shape it must read/write at store key `settings`. */
export const DEFAULT_SETTINGS = {
  sounds: true,
  haptics: true,
  reduceMotion: 'auto',        // 'auto' | 'on' | 'off'  ('auto' = OS preference)
  dailyMinutes: 25,            // user-facing load control (pedagogy-spec §1.6)
  showStreakFlame: true,
  compactDensity: false,
  confirmBeforeExit: false,
  lastView: 'home',
};

/** Subject -> CSS accent token name (theme.css §10 owns the values). */
export const SUBJECT_TOKENS = {
  Physics: '--sub-physics',
  Chemistry: '--sub-chem',
  Mathematics: '--sub-math',
  Maths: '--sub-math',
  'Computer Science': '--sub-cs',
  English: '--sub-english',
  Nepali: '--sub-nepali',
};

/** Subject -> sprite icon id (build-constraints §10 component mapping). */
export const SUBJECT_ICONS = {
  Physics: 'atom',
  Chemistry: 'flask',
  Mathematics: 'sigma',
  Maths: 'sigma',
  'Computer Science': 'code',
  English: 'book-open',
  Nepali: 'languages',
};

/** Read current settings merged over defaults (never returns undefined keys). */
export function getSettings() {
  const saved = store.get(KEYS.SETTINGS, null);
  return Object.assign({}, DEFAULT_SETTINGS, saved && typeof saved === 'object' ? saved : {});
}

/** Patch settings. Returns the merged object. */
export function setSettings(patch) {
  const next = Object.assign(getSettings(), patch || {});
  store.set(KEYS.SETTINGS, next);
  return next;
}

/**
 * A feature is on when the build flag is on AND the user has not turned it off
 * AND its hard dependency is satisfied (chat needs a Supabase URL).
 * @param {string} name key of CONFIG.FEATURES
 */
export function isFeatureEnabled(name) {
  if (!CONFIG.FEATURES[name]) return false;
  if (name === 'chat' && !CONFIG.SUPABASE_URL) return false;
  const s = getSettings();
  if (name === 'sounds') return s.sounds !== false;
  if (name === 'haptics') return s.haptics !== false;
  return true;
}

/** True when Supabase is configured at all (chat, auth, uploads, leaderboard). */
export function hasSupabase() {
  return Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
}

export default CONFIG;
