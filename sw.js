/**
 * The service worker: classic (never a module — module workers are not available everywhere this
 * app runs), at the root of the deployed subpath so its scope is exactly `/giocco/`.
 *
 * Strategy per request class, and why:
 *
 * - navigation: the cached `index.html`, falling back to the network, so an installed app never
 *   shows a browser error page;
 * - app code (`js/**`, `sw.js`, CSS, the manifest): network-first with a cache fallback, so a fix
 *   lands on the first online load;
 * - the rest of the precached shell (`./`, `index.html`): cache-first, so the app opens before
 *   anything else can be fetched;
 * - any other same-origin GET (`content/*.json`): stale-while-revalidate — serve the cached copy
 *   and refresh it in the background, or fetch and cache on a miss.
 *
 * There is no warm list and no message channel: `js/registry.js` statically imports every
 * Game module and `js/app.js` fetches every registered content file at boot, so both pass through
 * this handler and are cached on the first online load. Adding a Game therefore touches no host
 * file — this one included.
 *
 * Non-GET and cross-origin requests are not intercepted at all: they are the network's business.
 */

const CACHE = 'giocco-v1'; // bump on deploy
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest'];

/** The shell's paths, resolved once against this worker's own URL (the `/giocco/` subpath). */
const SHELL_PATHS = new Set(SHELL.map((entry) => new URL(entry, self.location.href).pathname));

/** App code, judged from the path alone: network-first, because a fix has to land. */
const APP_CODE = /\/js\/|sw\.js$|\.css$|\.webmanifest$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App code first: `styles.css` and the manifest are precached *and* need network-first, and the
  // two shell URLs left over (`./`, `index.html`) are the cache-first pair.
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
  } else if (APP_CODE.test(url.pathname)) {
    event.respondWith(networkFirst(request));
  } else if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/**
 * An installed app must never show a browser error page, so a navigation is answered from the
 * cached shell even when the network is right there.
 * @param {Request} request
 */
async function navigation(request) {
  const cache = await caches.open(CACHE);
  return (await cache.match('./index.html')) || fetch(request);
}

/** @param {Request} request */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  return (await cache.match(request)) || fetchAndCache(cache, request);
}

/** @param {Request} request */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // Nothing cached and no network: let the browser show its own network error.
    throw error;
  }
}

/**
 * Serve a cache hit immediately and refresh it in the background (`waitUntil` keeps the worker
 * alive for the refresh), or fetch-and-cache on a miss. A corpus edit appears on the next load,
 * and an offline load never waits on a doomed request.
 * @param {FetchEvent} event
 */
async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const network = fetch(request).then(async (fresh) => {
    if (fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  });

  const hit = await cache.match(request);
  if (!hit) return network;

  event.waitUntil(network.catch(() => {})); // offline: the stale copy is the answer
  return hit;
}

/**
 * @param {Cache} cache
 * @param {Request} request
 */
async function fetchAndCache(cache, request) {
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}
