/* =============================================================================
   js/router.js — pure hash-route string helpers + navigation.
   Job A2. NO imports (leaf module) so any view can use it without cycles.

   Route grammar (canonical):
       #/<viewId>?<key>=<value>&<key>=<value>
   Examples:
       #/home
       #/topic?id=mole-concept
       #/lesson?topic=mole-concept&file=0001-what-is-a-mole.html
   Extra path segments are tolerated and exposed as params._path (array):
       #/topic/mole-concept   ->  { id:'topic', params:{ _path:['mole-concept'] } }

   app.js owns the view lifecycle; this module owns the strings.
   ========================================================================== */

export const DEFAULT_VIEW = 'home';
export const DEFAULT_ROUTE = '#/home';

/**
 * @typedef {{ id:string, params:Object<string,string>, hash:string, path:string[] }} Route
 */

/** Parse any hash string into a Route. Never throws. */
export function parseHash(hash) {
  const raw = String(hash == null ? (typeof location !== 'undefined' ? location.hash : '') : hash);
  let s = raw.replace(/^#/, '');
  if (s.startsWith('!')) s = s.slice(1);      // tolerate legacy #!/ routes
  s = s.replace(/^\/+/, '');
  if (!s) return { id: DEFAULT_VIEW, params: {}, hash: DEFAULT_ROUTE, path: [] };

  const qi = s.indexOf('?');
  const pathPart = qi === -1 ? s : s.slice(0, qi);
  const queryPart = qi === -1 ? '' : s.slice(qi + 1);

  const segs = pathPart.split('/').filter(Boolean).map(safeDecode);
  const id = (segs.shift() || DEFAULT_VIEW).toLowerCase();

  /** @type {Object<string,string>} */
  const params = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
      const v = eq === -1 ? '' : safeDecode(pair.slice(eq + 1));
      if (k) params[k] = v;
    }
  }
  if (segs.length) params._path = segs;

  return { id, params, hash: '#/' + pathPart + (queryPart ? '?' + queryPart : ''), path: segs };
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (_) { return String(s); }
}

/**
 * Build a canonical route string.
 * @param {string} id view id
 * @param {Object} [params] plain object; null/undefined/'' values are dropped
 * @returns {string} e.g. '#/lesson?topic=mole-concept&file=0001.html'
 */
export function routeFor(id, params) {
  const view = encodeURIComponent(String(id || DEFAULT_VIEW));
  const parts = [];
  if (params && typeof params === 'object') {
    for (const k of Object.keys(params)) {
      if (k === '_path') continue;
      const v = params[k];
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return '#/' + view + (parts.length ? '?' + parts.join('&') : '');
}

/** True when two routes point at the same view + params. */
export function sameRoute(a, b) {
  return normalize(a) === normalize(b);
}
function normalize(r) {
  const p = typeof r === 'string' ? parseHash(r) : r;
  return routeFor(p.id, p.params);
}

/**
 * Navigate to a view.
 * @param {string} id
 * @param {Object} [params]
 * @param {{replace?:boolean}} [opts]
 */
export function navigate(id, params, opts) {
  return navigateTo(routeFor(id, params), opts);
}

/** Navigate to a raw route string ('#/home' or '/home' or 'home'). */
export function navigateTo(route, opts) {
  let hash = String(route || DEFAULT_ROUTE);
  if (!hash.startsWith('#')) hash = '#' + (hash.startsWith('/') ? hash : '/' + hash);
  if (typeof location === 'undefined') return hash;
  if (opts && opts.replace) {
    const url = location.pathname + location.search + hash;
    history.replaceState(history.state, '', url);
    dispatchRouteChange();
  } else if (location.hash === hash) {
    dispatchRouteChange();               // same hash: no hashchange fires, force one
  } else {
    location.hash = hash;
  }
  return hash;
}

/** Current parsed route. */
export function currentRoute() {
  return parseHash(typeof location !== 'undefined' ? location.hash : '');
}

/** Go back if there is history within the app, else fall back to a route. */
export function back(fallback) {
  if (typeof history !== 'undefined' && history.length > 1) history.back();
  else navigateTo(fallback || DEFAULT_ROUTE, { replace: true });
}

/* ---- change notification ------------------------------------------------ */

const listeners = new Set();
let wired = false;

function emit() {
  const r = currentRoute();
  for (const fn of Array.from(listeners)) {
    try { fn(r); } catch (err) { console.error('[router] listener failed', err); }
  }
}

function dispatchRouteChange() { emit(); }

/**
 * Subscribe to route changes. Returns an unsubscribe function.
 * @param {(route:Route)=>void} fn
 */
export function onRouteChange(fn) {
  listeners.add(fn);
  if (!wired && typeof window !== 'undefined') {
    wired = true;
    window.addEventListener('hashchange', emit);
    window.addEventListener('popstate', emit);
  }
  return () => listeners.delete(fn);
}
