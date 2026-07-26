/* =============================================================================
   js/app.js — the app shell: boot, router lifecycle, chrome, PWA, banners.
   Job A2. This is the only module that touches the shell DOM in index.html.

   Boot order (build-constraints §2 — the load order is load-bearing):
       vault-data.js (classic script, may be absent)
         -> store.js  (migrations run on import)
         -> vault.js  (normalise window.VAULT_DATA)
         -> registry  (every view module, imported exactly once)
         -> app.js    (this file: chrome, router, search, service worker)

   The hub MUST boot to a friendly empty state when vault-data.js is missing.
   That is a contract, not a fallback of convenience.
   ========================================================================== */

import CONFIG, { APP_VERSION, isFeatureEnabled, getSettings } from './config.js';
import { store, KEYS, todayLocalISO } from './store.js';
import { initVault, getVault, isVaultMissing, warnings as vaultWarnings, onVaultChange } from './vault.js';
import { el, icon, fmt, toast, haptic, sound, installIconSprite, on, delegate, prefersReducedMotion } from './dom.js';
import { parseHash, onRouteChange, navigate, navigateTo, routeFor, currentRoute, DEFAULT_ROUTE } from './router.js';
import { getView, navItems, NAV_PRIMARY, NAV_MORE, DEFAULT_VIEW_ID, VIEW_LIST } from './views/registry.js';
import {
  searchIndex, mountSearchOverlay, openSearch, closeSearch, isSearchOpen, buildVaultEntries,
} from './search-index.js';

/* ---------------------------------------------------------------------------
   0. Shell state
   ------------------------------------------------------------------------ */

const shell = {
  root: null,
  banners: null,
  tabbar: null,
  sidebarNav: null,
  moreSheet: null,
  titleNode: null,
  current: null,          // the normalised view object currently mounted
  mountToken: 0,          // guards against out-of-order async renders
  installPrompt: null,
  swRegistration: null,
};

/* ---------------------------------------------------------------------------
   1. Boot
   ------------------------------------------------------------------------ */

async function boot() {
  const t0 = performance.now();

  shell.root = document.getElementById('view-root');
  shell.banners = document.getElementById('banners');
  shell.tabbar = document.getElementById('tabbar');
  shell.sidebarNav = document.getElementById('sidebar-nav');
  shell.moreSheet = document.getElementById('more-sheet');
  shell.titleNode = document.getElementById('appbar-title');

  if (!shell.root) { console.error('[app] #view-root missing from index.html'); return; }

  installGlobalErrorHandlers();

  // 1a. vault — absent file is a supported state, never an error
  const { missing } = initVault();
  if (missing) console.info('[app] vault-data.js not loaded — booting empty shell (expected before the first sync)');

  // 1b. icons must be inlined before the first paint of any view
  await installIconSprite();

  // 1c. chrome
  buildNav();
  buildMoreSheet();
  wireHeader();
  renderStreak();
  renderStorageFooter();

  // 1d. search
  if (isFeatureEnabled('search')) {
    mountSearchOverlay();
    searchIndex.registerProvider('vault', buildVaultEntries);
    searchIndex.register('views', navigationEntries());
    searchIndex.register('actions', actionEntries());
    searchIndex.rebuild();
  }

  // 1e. banners that must be visible from the first frame
  if (missing) showVaultMissingBanner();
  showVaultWarnings();
  store.on('quota', showQuotaBanner);
  if (store.isMemoryOnly) showMemoryOnlyBanner();

  // 1f. router
  onRouteChange(handleRoute);
  if (!location.hash || location.hash === '#') {
    const last = (store.get(KEYS.UI, {}) || {}).lastView;
    navigateTo(routeFor(getView(last) ? last : DEFAULT_VIEW_ID), { replace: true });
  }
  await handleRoute(currentRoute());

  // 1g. keyboard + PWA
  wireKeyboard();
  registerServiceWorker();
  wireInstallPrompt();
  onVaultChange(() => { searchIndex.rebuild(); });

  document.documentElement.classList.remove('is-booting');
  document.documentElement.classList.add('is-ready');
  console.info('[app] Engram v' + APP_VERSION + ' ready in ' + Math.round(performance.now() - t0) + ' ms' +
    ' · storage: ' + (store.isPersistent ? 'localStorage' : 'memory') +
    ' · vault: ' + (missing ? 'missing' : getVault().counts.topics + ' topics'));
}

function installGlobalErrorHandlers() {
  window.addEventListener('error', (e) => {
    if (e && e.message) console.error('[app] uncaught', e.message, e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[app] unhandled rejection', e.reason);
  });
}

/* ---------------------------------------------------------------------------
   2. View lifecycle
   ------------------------------------------------------------------------ */

async function handleRoute(route) {
  const r = route || currentRoute();
  const view = getView(r.id) || getView(DEFAULT_VIEW_ID);
  if (!view) return;

  if (r.id !== view.id) {                    // unknown route -> canonical home
    navigateTo(routeFor(view.id), { replace: true });
    return;
  }

  const token = ++shell.mountToken;

  // teardown
  if (shell.current && shell.current.onExit) {
    try { shell.current.onExit({ route: r, view: shell.current }); }
    catch (err) { console.error('[app] onExit failed for "' + shell.current.id + '"', err); }
  }
  if (isSearchOpen()) closeSearch();
  closeMoreSheet();

  // fresh container per mount — views never see another view's leftovers
  const container = el('div.view', { dataset: { view: view.id } });
  shell.root.replaceChildren(container);
  shell.root.dataset.view = view.id;
  shell.current = view;

  document.title = view.title + ' · ' + CONFIG.APP_NAME;
  if (shell.titleNode) shell.titleNode.textContent = view.title;
  setActiveNav(view.id);
  window.scrollTo(0, 0);

  const ctx = { route: r, params: r.params, view, root: container, navigate };

  try {
    await view.render(container, r.params, ctx);
    if (token !== shell.mountToken) return;          // a newer navigation won
    if (view.onEnter) await view.onEnter(ctx);
  } catch (err) {
    if (token !== shell.mountToken) return;
    console.error('[app] view "' + view.id + '" failed to render', err);
    container.replaceChildren(renderViewError(view, err));
  }

  store.update(KEYS.UI, (prev) => Object.assign({}, prev, { lastView: view.id, lastSeenDay: todayLocalISO() }), {});
}

function renderViewError(view, err) {
  return el('div.view-error', { dataset: { tone: 'bad' } },
    el('div.view-error__icon', icon('circle-alert', { size: 20 })),
    el('h2.view-error__title', { text: 'The “' + view.title + '” screen hit an error' }),
    el('p.view-error__body', { text: 'Nothing was lost — your data is untouched. Try again, or go home.' }),
    el('pre.view-error__detail', { text: String((err && err.message) || err) }),
    el('div.view-error__actions',
      el('button.btn.btn-primary', { type: 'button', text: 'Reload', onClick: () => location.reload() }),
      el('button.btn.btn-ghost', { type: 'button', text: 'Go home', onClick: () => navigate(DEFAULT_VIEW_ID) })
    )
  );
}

/* ---------------------------------------------------------------------------
   3. Chrome — nav, header, more sheet
   ------------------------------------------------------------------------ */

/* components.css owns .tab-item (bottom bar) and .nav-item (sidebar),
   including the orange active edge bar. We only supply the markup. */
function navButton(item, base) {
  return el('a.' + base, {
    href: routeFor(item.id),
    dataset: { nav: item.id },
    attrs: { 'aria-label': item.title },
    onClick: () => haptic('tap'),
  },
    icon(item.icon, { size: base === 'tab-item' ? 20 : 16 }),
    el('span.' + base + '__label', { text: item.title })
  );
}

function buildNav() {
  const items = navItems();
  const primary = items.filter((i) => i.group === 'primary');
  const more = items.filter((i) => i.group === 'more');

  if (shell.tabbar) {
    shell.tabbar.replaceChildren(
      ...primary.map((i) => navButton(i, 'tab-item')),
      el('button.tab-item.tab-item--more', {
        type: 'button',
        dataset: { nav: '__more' },
        attrs: { 'aria-label': 'More', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
        onClick: toggleMoreSheet,
      },
        icon('more-horizontal', { size: 20 }),
        el('span.tab-item__label', { text: 'More' })
      )
    );
  }

  if (shell.sidebarNav) {
    shell.sidebarNav.replaceChildren(
      el('div.sidebar__group-label', { text: 'Study' }),
      ...primary.map((i) => navButton(i, 'nav-item')),
      el('div.sidebar__divider'),
      el('div.sidebar__group-label', { text: 'More' }),
      ...more.map((i) => navButton(i, 'nav-item'))
    );
  }
}

function setActiveNav(id) {
  for (const node of document.querySelectorAll('[data-nav]')) {
    const active = node.dataset.nav === id;
    node.classList.toggle('is-active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}

function buildMoreSheet() {
  if (!shell.moreSheet) return;
  const more = navItems().filter((i) => i.group === 'more');

  shell.moreSheet.replaceChildren(
    el('div.scrim', { onClick: closeMoreSheet }),
    el('div.sheet', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'More' } },
      el('div.sheet__grip'),
      el('div.sheet__links', ...more.map((i) =>
        el('a.sheet__link', { href: routeFor(i.id), onClick: () => { haptic('tap'); closeMoreSheet(); } },
          icon(i.icon, { size: 16 }), el('span', { text: i.title })))),
      el('div.sheet__divider'),
      el('div.sheet__links',
        sheetAction('download', 'Export a backup', () => {
          store.downloadBackup();
          toast('Backup downloaded', { tone: 'good' });
          closeMoreSheet();
        }),
        sheetAction('file-text', 'Export review log (JSONL)', () => {
          const n = store.reviewLogCount();
          if (!n) { toast('No reviews logged yet', { tone: 'info' }); return; }
          store.downloadReviewLog();
          toast(fmt.int(n) + ' reviews exported — commit this into the vault repo', { tone: 'good', timeout: 6000 });
          closeMoreSheet();
        }),
        sheetAction('refresh', 'Check for updates', () => { checkForUpdate(); closeMoreSheet(); }),
        CONFIG.FEATURES.install ? sheetAction('download', 'Install the app', () => { promptInstall(); closeMoreSheet(); }, 'sheet-install') : null
      ),
      el('div.sheet__meta', { text: CONFIG.APP_NAME + ' v' + APP_VERSION + ' · ' + CONFIG.TIMEZONE_LABEL })
    )
  );
  shell.moreSheet.hidden = true;
}

function sheetAction(iconName, label, onClick, id) {
  return el('button.sheet__link', { type: 'button', id: id || undefined, onClick },
    icon(iconName, { size: 16 }), el('span', { text: label }));
}

function openMoreSheet() {
  if (!shell.moreSheet) return;
  shell.moreSheet.hidden = false;
  shell.moreSheet.dataset.open = 'true';
  document.documentElement.classList.add('is-sheet-open');
  const btn = document.querySelector('[data-nav="__more"]');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  haptic('tap');
}

function closeMoreSheet() {
  if (!shell.moreSheet || shell.moreSheet.hidden) return;
  shell.moreSheet.hidden = true;
  shell.moreSheet.dataset.open = 'false';
  document.documentElement.classList.remove('is-sheet-open');
  const btn = document.querySelector('[data-nav="__more"]');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleMoreSheet() {
  if (!shell.moreSheet) return;
  if (shell.moreSheet.hidden) openMoreSheet(); else closeMoreSheet();
}

function wireHeader() {
  const searchBtn = document.getElementById('btn-search');
  if (searchBtn) {
    searchBtn.hidden = !isFeatureEnabled('search');
    on(searchBtn, 'click', () => openSearch());
    const kbd = searchBtn.querySelector('.appbar__kbd');
    if (kbd) kbd.textContent = isMac() ? '⌘K' : 'Ctrl K';
  }
  const streakBtn = document.getElementById('streak-flame');
  if (streakBtn) on(streakBtn, 'click', () => navigate('me'));
  const logo = document.getElementById('logo-tile');
  if (logo) on(logo, 'click', () => haptic('tap'));
}

/**
 * The streak flame. Job D owns the streak RULES; the shell only displays
 * store.get('streak') = { count, longest, lastDay, freezes, lifetimeDays }.
 */
function renderStreak() {
  const host = document.getElementById('streak-flame');
  if (!host) return;
  const s = store.get(KEYS.STREAK, null) || {};
  const count = Number(s.count) || 0;
  const settings = getSettings();
  host.hidden = settings.showStreakFlame === false;
  const label = host.querySelector('#streak-count');
  if (label) label.textContent = fmt.int(count);
  host.dataset.state = count === 0 ? 'cold' : (s.lastDay === todayLocalISO() ? 'lit' : 'due');
  host.setAttribute('aria-label', count + ' day study streak');
  host.setAttribute('title', count === 0
    ? 'No streak yet — 90 seconds of study today starts one'
    : count + ' day streak' + (s.lastDay === todayLocalISO() ? ' · today is done' : ' · today is still open'));
}

function renderStorageFooter() {
  const foot = document.getElementById('sidebar-foot');
  if (!foot) return;
  // "At risk" means something is live in memory but did NOT reach the disk —
  // not merely that one oversized write was refused earlier.
  const atRisk = store.isMemoryOnly || store.hasUnsavedData();
  foot.replaceChildren(
    el('div.storage', { dataset: { ok: atRisk ? 'no' : 'yes' } },
      icon(atRisk ? 'alert-triangle' : 'gauge', { size: 12 }),
      el('span', {
        text: store.isMemoryOnly ? 'Memory only — export often'
          : store.hasUnsavedData() ? fmt.int(store.unsavedKeys().length) + ' unsaved — export now'
          : fmt.bytes(store.usageBytes()) + ' saved locally',
      })),
    el('div.storage__version', { text: 'v' + APP_VERSION })
  );
}

/* ---------------------------------------------------------------------------
   4. Banners
   ------------------------------------------------------------------------ */

function banner(id, tone, iconName, title, body, actions) {
  if (!shell.banners) return null;
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const node = el('div.banner', { id, dataset: { tone } },
    el('span.banner__icon', icon(iconName, { size: 16 })),
    el('div.banner__text',
      el('strong.banner__title', { text: title }),
      body ? el('span.banner__body', { text: body }) : null),
    el('div.banner__actions', ...(actions || [])),
    el('button.banner__close', {
      type: 'button', attrs: { 'aria-label': 'Dismiss' }, onClick: () => node.remove(),
    }, icon('x', { size: 14 }))
  );
  shell.banners.appendChild(node);
  return node;
}

/** §9.3 — quota NEVER deletes anything. Refuse, then offer the export. */
function showQuotaBanner(info) {
  banner('banner-quota', 'bad', 'alert-triangle',
    'This device’s storage is full',
    'Your latest change is held in memory only. Export a backup now, then free some space — nothing has been deleted.',
    [
      el('button.btn.btn-primary.btn--sm', {
        type: 'button', text: 'Export backup',
        onClick: () => { store.downloadBackup(); toast('Backup downloaded', { tone: 'good' }); },
      }),
      el('button.btn.btn-ghost.btn--sm', {
        type: 'button', text: 'Export reviews',
        onClick: () => { store.downloadReviewLog(); toast('Review log downloaded', { tone: 'good' }); },
      }),
    ]);
  console.warn('[app] storage quota refused a write', info);
}

function showMemoryOnlyBanner() {
  banner('banner-memory', 'warn', 'alert-triangle',
    'Progress will not survive a reload',
    'This browser is blocking local storage (private window, or storage disabled). Export a backup before you close the tab.',
    [el('button.btn.btn--ghost.btn--sm', { type: 'button', text: 'Export backup', onClick: () => store.downloadBackup() })]);
}

function showVaultMissingBanner() {
  banner('banner-vault', 'info', 'info',
    'No study data loaded yet',
    'vault-data.js is not on the server. The app is fully working — it just has nothing to show. ' +
    'Run sync.py (vault → hub) and reload.',
    []);
}

/** §9.7 — generator warnings belong in front of the student, not in a console. */
function showVaultWarnings() {
  const list = vaultWarnings();
  if (!list || !list.length) return;
  // Counts WARNINGS, not files: one folder can raise several, and most of them
  // are "something is missing" rather than "this failed to parse". The old copy
  // ("N files did not parse") was wrong on both halves and turned a deliberate,
  // accepted deferral into an alarm in front of the student.
  banner('banner-warnings', 'warn', 'alert-triangle',
    fmt.int(list.length) + ' vault ' + fmt.plural(list.length, 'warning') + ' from the last sync',
    list.slice(0, 3).join(' · ') + (list.length > 3 ? ' …' : ''),
    []);
}

/* ---------------------------------------------------------------------------
   5. Keyboard
   ------------------------------------------------------------------------ */

function isMac() {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
}

function isTyping(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    // ⌘K / Ctrl-K — global search
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      if (!isFeatureEnabled('search')) return;
      e.preventDefault();
      isSearchOpen() ? closeSearch() : openSearch();
      return;
    }
    // '/' — search, unless the user is typing
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
      if (!isFeatureEnabled('search')) return;
      e.preventDefault();
      openSearch();
      return;
    }
    // Escape — close the topmost layer
    if (e.key === 'Escape') {
      if (isSearchOpen()) { closeSearch(); return; }
      if (shell.moreSheet && !shell.moreSheet.hidden) { closeMoreSheet(); return; }
    }
    // Alt+1..5 — jump to a primary tab
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^[1-5]$/.test(e.key)) {
      const id = NAV_PRIMARY[Number(e.key) - 1];
      if (id) { e.preventDefault(); navigate(id); }
    }
  });
}

/* ---------------------------------------------------------------------------
   6. Search entries owned by the shell
   ------------------------------------------------------------------------ */

function navigationEntries() {
  return VIEW_LIST
    .filter((v) => NAV_PRIMARY.includes(v.id) || NAV_MORE.includes(v.id))
    .map((v) => ({
      id: 'view:' + v.id,
      type: 'view',
      title: v.title,
      subtitle: 'Screen',
      body: v.id + ' screen navigate open go to',
      route: routeFor(v.id),
      icon: v.icon,
    }));
}

function actionEntries() {
  return [
    {
      id: 'action:export', type: 'action', title: 'Export a full backup',
      subtitle: 'Download every local record as JSON', body: 'backup export download save data json',
      route: '', icon: 'download', data: { run: () => store.downloadBackup() },
    },
    {
      id: 'action:reviewlog', type: 'action', title: 'Export the review log (JSONL)',
      subtitle: 'The file engram.py replays with `rate --file`',
      body: 'review log jsonl export sync engram fsrs receipts', route: '', icon: 'file-text',
      data: { run: () => store.downloadReviewLog() },
    },
    {
      id: 'action:update', type: 'action', title: 'Check for updates',
      subtitle: 'Re-check the service worker', body: 'update refresh service worker cache version',
      route: '', icon: 'refresh', data: { run: () => checkForUpdate() },
    },
  ];
}

/* Entries of type 'action' carry `data.run` — search-index.js calls it on
   Enter/click instead of navigating. Any feature agent can do the same. */

/* ---------------------------------------------------------------------------
   7. Service worker + install
   ------------------------------------------------------------------------ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') {
    console.info('[app] file:// — service worker skipped (serve over http to test offline)');
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(CONFIG.PATHS.serviceWorker, { scope: './' })
      .then((reg) => {
        shell.swRegistration = reg;
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
          });
        });
      })
      .catch((err) => console.warn('[app] service worker registration failed', err));

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'VAULT_UPDATED') {
        // The SW revalidated vault-data.js. Reload so the classic script re-runs.
        toast('Fresh study data is available', {
          tone: 'info', timeout: 0,
          action: { label: 'Reload', onClick: () => location.reload() },
        });
      }
    });
  });
}

function offerUpdate(worker) {
  toast('A new version of Engram is ready', {
    tone: 'info',
    timeout: 0,
    action: {
      label: 'Update now',
      onClick: () => { try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (_) { location.reload(); } },
    },
  });
}

function checkForUpdate() {
  if (!shell.swRegistration) { toast('Offline caching is not active here', { tone: 'info' }); return; }
  shell.swRegistration.update()
    .then(() => toast('Checked — you are on the latest version', { tone: 'good' }))
    .catch(() => toast('Could not check right now', { tone: 'warn' }));
}

function wireInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    shell.installPrompt = e;
    const btn = document.getElementById('sheet-install');
    if (btn) btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    shell.installPrompt = null;
    toast('Engram installed — it works offline now', { tone: 'good' });
  });
}

function promptInstall() {
  if (!shell.installPrompt) {
    toast('Use your browser menu → “Add to Home Screen”', { tone: 'info', timeout: 6000 });
    return;
  }
  shell.installPrompt.prompt();
  shell.installPrompt = null;
}

/* ---------------------------------------------------------------------------
   8. Debug handle (Hermes / console use only — never a dependency)
   ------------------------------------------------------------------------ */

window.ENGRAM = {
  version: APP_VERSION,
  config: CONFIG,
  store,
  vault: getVault,
  search: searchIndex,
  navigate,
  routeFor,
  refresh: () => handleRoute(currentRoute()),
  reindex: () => searchIndex.rebuild(),
  export: () => store.exportAllData(),
};

/* ---------------------------------------------------------------------------
   9. Go
   ------------------------------------------------------------------------ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export { boot, handleRoute, renderStreak };
