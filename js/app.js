// @ts-check
/**
 * Boot: the Game graph → every registered content file → routing.
 *
 * `index.html` has exactly one module entry, and this is it. The documented boot order is the
 * service worker, then the Game graph, then every content file, then the router:
 *
 * 1. Register `./sw.js` (fire-and-forget).
 * 2. Importing `./registry.js` brings the whole Game graph in — its static imports of the three
 *    Game modules are fetched on the first online load and therefore cached for the first
 *    offline one.
 * 3. Fetch every registered Game's declared content, all of it, at boot. A Game whose content
 *    was fetched on first visit would silently not exist offline.
 * 4. Hand `js/router.js` a renderer that composes the host's screens with that loaded content
 *    and the live `storage` slices.
 *
 * Nothing is validated here. `tools/check.mjs` is an author-time gate over the corpus; running it
 * in the browser would only slow a load down to catch a mistake that cannot ship.
 *
 * Everything the module touches in the environment is a parameter with a browser default
 * (`document`, `window`, `fetch`, the storage backend) — the same rule as `storage.js`,
 * `engine.js`, `router.js` and `ui.js` — so `tools/sanity.mjs` drives the whole boot with fakes
 * and the browser path calls `boot()` with nothing.
 */

import { createSession, itemsOf, loadContent } from './engine.js';
import { GAMES } from './registry.js';
import { createRouter } from './router.js';
import { createStorage } from './storage.js';
import { createUi } from './ui.js';

/** @typedef {import('./engine.js').Game} Game */
/** @typedef {import('./router.js').Route} Route */
/** @typedef {import('./router.js').RouterHost} RouterHost */
/** @typedef {import('./router.js').RouterWindow} RouterWindow */

/**
 * The root node the shell provides. Boot draws every screen into it and never replaces it: a
 * screen's teardown empties it, which is what keeps the module entry's one node stable.
 */
const ROOT_ID = 'app';

/**
 * @typedef {{
 *   document?: Document,
 *   window?: RouterWindow,
 *   root?: HTMLElement,
 *   storage?: ReturnType<typeof createStorage>,
 *   games?: ReadonlyArray<Game>,
 *   fetch?: typeof globalThis.fetch,
 *   base?: string,
 *   rng?: () => number,
 *   serviceWorker?: ServiceWorkerContainer | null,
 * }} BootOptions
 */

/**
 * Register the service worker: its install precaches the shell and its fetch handler answers the
 * next load from a cache, which is what makes the app work offline.
 *
 * Deliberately fire-and-forget. An insecure context (`file://`, an `http://` LAN address) or a
 * browser without service workers must degrade to an ordinary online-only app, never to a page
 * that failed to start — so a failed registration is a warning, not an error. It is the first
 * thing boot does, so the shell cache is filling while the corpus loads.
 *
 * `./sw.js` is relative like every other URL, which is what gives the worker the deployed
 * `/giocco/` scope; `{ updateViaCache: 'none' }` keeps GitHub Pages' ten-minute `Cache-Control`
 * off the script that is otherwise the one file a fix can be stuck behind.
 *
 * @param {ServiceWorkerContainer | null | undefined} container injected by `tools/sanity.mjs`
 */
function registerServiceWorker(container) {
  const target = container === undefined ? globalThis.navigator?.serviceWorker : container;
  if (!target || typeof target.register !== 'function') return;
  target.register('./sw.js', { updateViaCache: 'none' }).catch((error) => {
    console.warn('giocco: the service worker did not register', error);
  });
}

/**
 * Start the host: the service worker, then content, then the router. Everything injected has a
 * browser default, so `boot()` is the whole browser path.
 *
 * @param {BootOptions} [options] injected by `tools/sanity.mjs`; the browser passes nothing
 * @returns {Promise<{
 *   router: ReturnType<typeof createRouter>,
 *   ui: ReturnType<typeof createUi>,
 *   storage: ReturnType<typeof createStorage>,
 *   content: Record<string, unknown>,
 * }>}
 */
export async function boot(options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('giocco app: a document is required to boot');
  }
  const appRoot =
    options.root ?? (typeof doc.getElementById === 'function' ? doc.getElementById(ROOT_ID) : null);
  if (!appRoot) throw new Error(`giocco app: index.html must provide a #${ROOT_ID} root node`);
  /** The checked root, non-null for every screen below. @type {HTMLElement} */
  const root = appRoot;

  registerServiceWorker(options.serviceWorker);

  const games = options.games ?? GAMES;
  const storage = options.storage ?? createStorage();
  const ui = createUi(doc);

  /** Content paths are relative to the deployed site root, so the base is the injected one. */
  /** @type {{ base?: string, fetch?: typeof globalThis.fetch }} */
  const contentOptions = {};
  if (options.base !== undefined) contentOptions.base = options.base;
  if (options.fetch !== undefined) contentOptions.fetch = options.fetch;

  // Every registered Game's content, all of it, before anything renders. Sequential on purpose:
  // the order a failure reports is the declaration order, and a boot fetch is a one-off.
  /** @type {Record<string, unknown>} */
  const content = {};
  for (const game of games) content[game.id] = await loadContent(game, contentOptions);

  const isGame = (/** @type {string} */ id) => games.some((game) => game.id === id);

  /**
   * The renderer the router calls. It owns the screens' composition (the hosts' chrome plus the
   * Game into it) and nothing else: `js/ui.js` builds the DOM, the Game's own `play()` runs the
   * round, and both teardowns are composed so leaving a route always tears the round down.
   *
   * @param {Route} route
   * @param {RouterHost} host
   * @returns {(() => void) | void}
   */
  function renderRoute(route, host) {
    const game = route.id === null ? null : games.find((entry) => entry.id === route.id) ?? null;
    if (game === null) {
      ui.hub(root, games);
      return;
    }

    if (route.name === 'settings') {
      return ui.settingsScreen(root, game, {
        settings: storage.settings(game.id),
        items: itemsOf(content[game.id]),
        navigate: host.navigate,
      });
    }

    const { playRoot, teardown } = ui.gameScreen(root, game);
    const session = createSession(game, {
      content: content[game.id],
      settings: storage.settings(game.id),
      store: storage.store(game.id),
      rng: options.rng,
    });
    const done = game.play(playRoot, session);
    return () => {
      done();
      teardown();
    };
  }

  const router = createRouter({ render: renderRoute, isGame, window: options.window });
  router.start();

  return { router, ui, storage, content };
}

// The browser path: `index.html`'s one module script is this file. Under Node (the sanity suite)
// there is no document and nothing starts.
if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  boot().catch((error) => {
    console.error('giocco: the app could not start', error);
  });
}
