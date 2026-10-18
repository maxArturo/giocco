// @ts-check
/**
 * The hash router: three frozen routes, and no server rewrite anywhere.
 *
 * | URL | Screen |
 * |---|---|
 * | `#/` | the hub — the list of Games |
 * | `#/g/<id>` | the Game, which is where a screen hands `play(root, session)` its root node |
 * | `#/g/<id>/settings` | pool selection, host-rendered from the Game's `dims`/`presets`/`controls` |
 *
 * GitHub Pages cannot rewrite, so a path route would 404 on reload; a fragment never leaves the
 * browser. The server only ever answers `/giocco/` — which is also why nothing here depends on
 * the deploy subpath: the fragment is opaque to it.
 *
 * Two rules keep stale or hand-typed links safe:
 *
 * 1. **Cold load.** Booting on `#/g/<id>` — a bookmark, a reload, a URL typed by hand — redirects
 *    to that Game's settings route, because a round must not be entered by skipping pool
 *    selection: `Start round` is the only way in. Once the app is running, the same URL renders
 *    the Game, which is what `Start round` navigates to.
 * 2. **Unknown.** An `id` that is not registered, and any fragment that is not one of the three
 *    routes (`#/g/x/stats`, `#/nope`, `#/g`, `#/g/x/`), redirects to `#/` — a Game's statistics
 *    and options views live *inside* `#/g/<id>` and the host never learns a sub-route.
 *
 * A redirect uses `location.replace()`, so the entry the cold or bad URL occupied is replaced
 * rather than pushed: Back leaves the app instead of bouncing off a route that redirects again.
 *
 * The router owns screen lifetime as well as screen choice: whatever the current `render` returns
 * is that screen's teardown, and the router runs it *before* the next screen renders — leaving a
 * Game tears its round down — and on `stop()`. A render function that returns nothing simply has
 * no teardown.
 *
 * The environment is a parameter (`window`), so `tools/sanity.mjs` can drive cold loads, redirects
 * and back/forward with a fake and no DOM; the browser path passes nothing.
 */

import { gameById } from './registry.js';

/** The hub — the route every redirect lands on. */
export const HUB_HASH = '#/';

/** @typedef {'hub' | 'settings' | 'game'} RouteName */
/** @typedef {{ name: RouteName, id: string | null }} Route */

/** The one hub route object, shared and frozen so a screen cannot poison it. @type {Route} */
const HUB_ROUTE = Object.freeze({ name: 'hub', id: null });

/**
 * @param {string} id a registered Game id
 * @returns {string} its Game route
 */
export function gameHash(id) {
  return `#/g/${id}`;
}

/**
 * @param {string} id a registered Game id
 * @returns {string} its settings route
 */
export function settingsHash(id) {
  return `#/g/${id}/settings`;
}

/**
 * Parse one fragment into a route, or `null` when it is not one of the three. Deliberately
 * strict: a trailing slash, an empty id or a fourth segment is not "close enough" — it is an
 * unknown route, and an unknown route redirects to the hub.
 *
 * @param {string} hash `location.hash` — with or without its `#`, and `''` for "no fragment"
 * @returns {Route | null}
 */
export function parseRoute(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  const fragment = raw.startsWith('#') ? raw.slice(1) : raw;
  if (fragment === '' || fragment === '/') return HUB_ROUTE;
  const parts = fragment.split('/');
  if (parts[0] !== '' || parts[1] !== 'g') return null;
  const id = parts[2];
  if (typeof id !== 'string' || id === '') return null;
  if (parts.length === 3) return { name: 'game', id };
  if (parts.length === 4 && parts[3] === 'settings') return { name: 'settings', id };
  return null;
}

/**
 * Resolve a fragment into the screen to render plus the redirect (a fragment, or `null`) that
 * belongs in the address bar. `cold` marks the boot load; every later hash change passes `false`,
 * so `#/g/<id>` means the settings screen on a cold load and the Game afterwards.
 *
 * @param {string} hash
 * @param {{ cold?: boolean, isGame?: (id: string) => boolean }} [options] `isGame` defaults to
 *   the registry, which is the only place a Game id can be known
 * @returns {{ route: Route, redirect: string | null }}
 */
export function resolveRoute(hash, options = {}) {
  const isGame = options.isGame ?? ((id) => gameById(id) !== null);
  const parsed = parseRoute(hash);
  if (parsed === null || (parsed.id !== null && !isGame(parsed.id))) {
    return { route: HUB_ROUTE, redirect: HUB_HASH };
  }
  if (options.cold === true && parsed.name === 'game' && parsed.id !== null) {
    return { route: { name: 'settings', id: parsed.id }, redirect: settingsHash(parsed.id) };
  }
  return { route: parsed, redirect: null };
}

/**
 * The slice of the browser the router touches, injected by the sanity suite.
 * @typedef {{
 *   location: { hash: string, replace: (url: string) => void },
 *   addEventListener: (type: string, listener: (event: unknown) => void) => void,
 *   removeEventListener: (type: string, listener: (event: unknown) => void) => void,
 * }} RouterWindow
 */

/**
 * What a screen gets besides its route: the router's own navigation, so a host screen never
 * reaches for the URL itself.
 * @typedef {{ navigate: (hash: string, options?: { replace?: boolean }) => void }} RouterHost
 */

/** The browser's `window`; under Node (the sanity suite) a fake is injected instead. */
function defaultWindow() {
  return /** @type {RouterWindow} */ (/** @type {unknown} */ (globalThis));
}

/**
 * Wire the hash to a renderer.
 *
 * `render(route, host)` is called with the resolved route and returns that screen's teardown (or
 * nothing). The previous screen's teardown runs before the next one renders, and `stop()` runs
 * the pending one and unhooks the hash.
 *
 * @param {{
 *   render: (route: Route, host: RouterHost) => (() => void) | void,
 *   isGame?: (id: string) => boolean,
 *   window?: RouterWindow,
 * }} options
 */
export function createRouter(options) {
  if (typeof options.render !== 'function') {
    throw new Error('giocco router: createRouter needs a render function');
  }
  const win = options.window ?? defaultWindow();
  const isGame = options.isGame ?? ((id) => gameById(id) !== null);
  const render = options.render;

  /** @type {Route | null} */
  let current = null;
  /** @type {(() => void) | null} */
  let teardown = null;
  /** The fragment the current screen was rendered for — null while stopped. @type {string | null} */
  let rendered = null;
  let started = false;

  /**
   * @param {string} hash
   * @param {{ replace?: boolean }} [navOptions]
   */
  function navigate(hash, navOptions = {}) {
    if (navOptions.replace === true) win.location.replace(hash);
    else win.location.hash = hash;
  }

  /** @type {RouterHost} */
  const host = { navigate };

  /**
   * @param {Route} route
   */
  function renderRoute(route) {
    if (teardown !== null) {
      const done = teardown;
      teardown = null;
      done();
    }
    current = route;
    const result = render(route, host);
    teardown = typeof result === 'function' ? result : null;
  }

  /**
   * Show whatever `hash` means. Recorded before any redirect is applied, because a redirect's
   * `hashchange` is queued by the browser and would otherwise re-render the screen we just drew
   * — or, under the sanity suite's synchronous fake, re-enter this function.
   *
   * @param {string} hash
   * @param {boolean} cold
   */
  function show(hash, cold) {
    const { route, redirect } = resolveRoute(hash, { cold, isGame });
    const target = redirect ?? (hash === '' || hash === '#' ? HUB_HASH : hash);
    if (rendered === target) return;
    rendered = target;
    if (redirect !== null && win.location.hash !== target) win.location.replace(target);
    renderRoute(route);
  }

  const onHashChange = () => show(win.location.hash, false);

  return {
    /** Render the current fragment — redirecting first if it is cold or unknown. Idempotent. */
    start() {
      if (started) return;
      started = true;
      win.addEventListener('hashchange', onHashChange);
      show(win.location.hash, true);
    },
    /** Unhook the hash and tear the current screen down. */
    stop() {
      if (started) {
        win.removeEventListener('hashchange', onHashChange);
        started = false;
      }
      if (teardown !== null) {
        const done = teardown;
        teardown = null;
        done();
      }
      current = null;
      rendered = null;
    },
    navigate,
    /** @returns {Route | null} the rendered route, or `null` before `start()`/after `stop()` */
    current: () => current,
  };
}
