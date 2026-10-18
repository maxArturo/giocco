# giocco — Host, Offline & Deploy Architecture

The host is the layer around the **Games**. It knows no Italian, no scoring and no **Mastery**.
Read `README.md` first for the domain language and the host/Game boundary; this file is the
mechanics.

## Layout

```
index.html              the shell: <head>, the root node, and one module script
manifest.webmanifest    name, icons, display: standalone, start_url: "./"
sw.js                   classic service worker, never a module (iOS 11.3+)
styles.css              all shared CSS — there are no per-Game stylesheets
.nojekyll               stops GitHub Pages running the files through Jekyll
icons/                  180 / 192 / 512 + a maskable one
content/<game>.json     hand-authored Items, one file per Game
js/
  app.js                boot: registry → content → router → warm the service worker
  router.js             hash router, three routes
  registry.js           the only place a Game is announced
  engine.js             the four host jobs
  storage.js            envelope, migrate, per-Game settings + store
  ui.js                 hub, settings screen, host chrome
  lib/                  imported by Games, never by the host
    roundLoop.js        the question loop (ask → judge → feed back → advance)
    charts.js           sparkline() and bars(), used by a Game's own stats view
  games/<id>/index.js   one Game
tools/check.mjs         dev-only structural gate; never shipped, never precached
```

## Boot

1. `index.html` loads and registers `./sw.js` (classic, scope `/giocco/`).
2. `app.js` imports `registry.js` — which statically imports every Game module, so the whole
   Game graph is fetched (and therefore cached by the service worker) on the first online load.
3. Every registered Game's `content` is fetched, all of it, at boot. Hundreds of kilobytes is
   fine; fetching on demand is not, because a Game you have never opened would silently not
   exist offline.
4. `router.js` renders the current route.

Nothing is validated at boot: `tools/check.mjs` already did that at author time, and re-running
it in the browser would only slow down a load to catch a mistake that cannot ship.

## The four host jobs

**1. Filter the pool.** From the Game's content, keep the **Items** the player's settings allow:

```js
settings = { preset: 'a1' | null, include: { dim: [value, …] }, controls: { id: value } }
```

An **Item** passes iff, for every dimension present in `include`, the Item carries at least one
of the listed tags. Inside a dimension it is OR; across dimensions it is AND. Selecting a
**Preset** copies its declared `include` into settings and records its id; any manual change sets
`preset: null` and the settings screen shows "Custom". If a Game declares no `dims`, the pool is
its whole content file; if it declares no `content` either, the pool is empty and the Game builds
its own round. The host has now done its whole job on selection: **ordering, weighting, count and
repetition are the Game's business.**

Three edges `js/engine.js` fixes so a Game author never has to guess them: a **Dimension** listed
with an empty value list (the settings screen's "None") matches nothing, while a **Dimension**
absent from `include` is no constraint at all; for a Game declaring a content *map*, the **Pool**
is the Items of every array-valued file it declared, concatenated in declaration order; and the
settings shapes the screen starts from live in the engine too — `defaultSettings(game)` (every
value of every Dimension, `preset: null`, every control at its declared default) and
`presetSettings(game, id, current)` (the Preset's `include` copied out, its id recorded, the
current control values kept). The **Session** is assembled by `createSession(game, { content,
settings, store, rng })`, which is the engine's entire Game-facing API; `createRng(seed)` gives the
deterministic RNG a check or a bug report needs and `Math.random` is the app default.

**2. Load content.** `session.content` is the parsed JSON, keyed when the Game declared a map
(`{ words: './content/parole.json' }` → `session.content.words`). Paths are relative to the
deployed site root — the directory `index.html` sits in — never to `js/engine.js`, so a content
path works unchanged from the `/giocco/` subpath and from a root dev server. A failed fetch is a
loud error, not a silently empty Pool.

**3. Host chrome.** On `#/g/<id>` the host draws exactly one thing: the back control to the hub,
so no Game can trap the player. Everything else on that screen is the Game's. The other host
surface is the settings screen, rendered from the Game's `dims`, `presets` and `controls`.

`js/ui.js` is the whole of that: `createUi(doc = document)` returns three screens.
`hub()` draws the wordmark plus one card per Game, each a plain anchor to that Game's settings
route. `gameScreen(root, game)` draws the back control plus an empty `playRoot`, whose teardown
removes both; it never calls `play()`, so the route renderer mounts the Game into `playRoot` and
composes the two teardowns and a Game can never be handed host chrome. `settingsScreen(root, game,
{ settings, items, navigate })` draws the settings screen from the declaration: Preset chips (plus
a `Custom` chip whenever `preset` is `null`), one accordion per Dimension with the first open,
every value row's count-if-on badge, the declared control chips, and a sticky footer with the
eligible count and `Start round`. It is handed the *live* settings object (a `storage.settings()`
slice, so every write persists on the spot), the Game's Items (`itemsOf(session content)`, the
only thing it filters over) and the router's `navigate`. Anchors are used for navigation that is
always available (hub card, back control, so both work as soon as the fragment changes);
`Start round` is a `<button>` because it has to be `disabled` on an empty pool.

The screen builds its DOM once and mutates it through one `refresh()`: every change writes through
the live settings object, clears `preset` (so the row shows `Custom`) and recomputes the whole
form — each badge is `filterPool(items, { include: { …current, [dim]: [value] } })`, what that
value would add given everything else, and a value below five is dimmed, `aria-disabled` and given
a `needs 5+ items` sub-line. A Dimension an `include` omits (a Preset only mentions the Dimensions
it filters) is unconstrained — the engine's own reading — so the form shows it all-on, never
`None`. `ui.js` therefore imports the engine's pure `filterPool`/`presetSettings` and neither a
Session nor storage.

**4. Persist.** The host writes `session.store` on every mutation and never looks inside it.

## The Game module

```js
export default {
  id: 'verbi-presente',                    // permanent: it is in routes and storage keys
  title: 'Verbi · presente',               // display only, free to change
  description: 'Coniugazioni al presente', // hub card second line, optional
  section: 'Grammatica',                   // optional hub heading, once the list grows

  content: './content/verbi-presente.json',      // or { words: './...', boards: './...' }
  dims:    [{ dim: 'tense', values: ['pres'], label: 'Tempo' }],
  presets: [{ id: 'a1', label: 'A1 · regolari', include: { reg: ['regular', 'spelling'] } }],
  controls:[{ id: 'count', label: 'Domande', options: [5, 10, 20], default: 10 }],

  play(root, session) {                    // the only gameplay entry point
    …
    return teardown;                       // called on quit or route change
  },
};
```

Required: `id`, `title`, `play`. Everything else is optional, and a Game that declares nothing
but those three still gets a hub entry, points, and a back control. `play` is synchronous, has no
`init`/`activate`/`destroy` phases, and returns its own teardown — no event bus, no hook registry.
Those are what would turn this boundary into a framework.

## Session

```js
session = {
  pool,      // Items, already filtered — the Game never re-implements the filter
  content,   // parsed JSON by key
  settings,  // { preset, include, controls } as persisted
  rng(),     // injectable RNG: deterministic rounds in tests and bug reports
  store,     // the Game's own JSON, persisted on every write, opaque to the host
}
```

A Game reads five things and writes one. There is no `record()`, `award()`, `progress()`,
`finish()` or `chrome` flag, because the host has nothing to record, nothing to score and nothing
to display. Because `store` writes are immediate, a Game that writes per answer keeps everything
earned when the player quits mid-round — write as you go, never at the end.

## Storage

```js
localStorage['giocco'] = {
  v: 1,
  data: { games: { '<id>': { settings: {…}, store: {…} } } },
}
```

- One key, one envelope, one `migrate(v, data)` chain with a single entry point. Never a key per
  version, or every boot has to probe a set of them.
- `settings` belongs to the host (which pool the player chose); `store` belongs to the Game.
- `js/storage.js` hands out both as **live objects**: `settings(gameId)` and `store(gameId)`
  return proxies whose writes (including deletes and deep `store.items[id].ema = …` updates) hit
  `localStorage` on the spot. That is what makes "persisted on every write" true without putting
  a callback or a `save()` method on the Game's five-field `session`. Slices are per-`id` objects
  with stable identity, so one Game can never reach another Game's slice.
- The backend is a parameter (`createStorage(backend = localStorage)`), which is how
  `tools/sanity.mjs` drives the whole envelope without a DOM.
- If the stored `v` is *newer* than the running code — an older build opened after a newer one —
  the host must refuse to write rather than clobber it. A blob that cannot be read at all (bad
  JSON, not an envelope) is treated the same way: reads still work from memory, every write is
  refused, and the blob is left byte-for-byte alone. A failed `setItem` (quota, Safari private
  mode) also flips the session to memory-only instead of throwing.
- Nothing is pruned. An **Item** removed from a content file keeps its entry, so re-adding it
  later restores the player's progress instead of silently deleting history.
- There is no export and no import, deliberately (see `README.md`). Local storage on iOS is the
  only copy, and a lost blob is a lost blob.

## Router

| Route | Screen | Owner |
|---|---|---|
| `#/` | Hub — the list of Games | host |
| `#/g/<id>` | The Game, root node handed to `play()` | Game |
| `#/g/<id>/settings` | Pool selection, from `dims` / `presets` / `controls` | host |

A Game's own statistics or options views live *inside* `#/g/<id>`; the host never learns
sub-routes, and a Game that wants no statistics simply has none. Hash routing is not a
preference: GitHub Pages has no rewrites, so a fragment route never 404s on reload.

`js/router.js` parses exactly those three fragments and resolves two safety rules before it
renders anything:

- **A cold load of `#/g/<id>` redirects to that Game's settings route.** A bookmark, a reload or
a hand-typed URL must not enter a round that skipped pool selection — `Start round` is the only
way in. Once the app is running, `#/g/<id>` renders the Game, which is what `Start round`
navigates to.
- **Anything else that is not `#/` redirects to `#/`**: an unregistered id, a dead sub-route
(`#/g/x/stats`), a fourth segment, an empty id. A Game's own views are not routes, so a stale
link can never dead-end.

Both redirects use `location.replace()`, so the entry holding the cold or dead URL is replaced
rather than pushed: Back leaves the app instead of bouncing off a route that redirects again. The
router also owns screen lifetime — whatever the current screen's render returns is its teardown,
and it runs before the next screen renders and on `stop()`, which is how leaving a Game tears its
round down. The environment is a parameter (`createRouter({ render, isGame, window })`), so
`tools/sanity.mjs` drives cold loads, unknown links and Back/Forward with a fake window instead
of a browser.

## Service worker

Classic, ~50 lines, cache-first where it must be and network-first where updates matter:

| Request | Strategy | Why |
|---|---|---|
| precached shell (`index.html`, `styles.css`, icons, manifest) | cache-first, precached on install | offline must work before anything else |
| navigations | cache, falling back to the cached `index.html` | an installed app must never show a browser error page |
| app code (`js/**`, `sw.js`) | network-first, cache fallback | a fix lands on the first online load |
| everything else same-origin (`content/*.json`) | stale-while-revalidate | corpus edits appear on the next load, offline never breaks |

```js
const CACHE = 'giocco-v1';                                  // bump on deploy
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest'];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;

  const isNav  = request.mode === 'navigate';
  const isCode = /\/js\/|\.css$|\.webmanifest$/.test(new URL(request.url).pathname);

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isNav) return (await cache.match('./index.html')) || fetch(request);
    if (isCode) {
      try {
        const fresh = await fetch(request);
        cache.put(request, fresh.clone());
        return fresh;
      } catch { return (await cache.match(request)) || Response.error(); }
    }
    const hit = await cache.match(request);
    return hit || fetch(request).then(r => (cache.put(request, r.clone()), r));
  })());
});
```

There is **no warm list and no `postMessage` channel**. Every Game module is statically imported by
`registry.js` and every content file is fetched at boot, so both pass through this handler and are
cached on the first online load. Adding a Game therefore touches no host file — `sw.js` included.

## Deploy

Project site: repo root is the site root, deployed to `https://<user>.github.io/giocco/`.

The classic silent failures, in the order they bite:

1. **A 404'd `sw.js`.** No service worker, no offline, forever, with no visible error. After
   deploying, open `/giocco/sw.js` directly and confirm it is 200 and your source.
2. **An absolute path.** `/js/app.js` works locally and 404s under the project subpath. Every URL
   is relative: `./js/app.js`.
3. **Missing `.nojekyll`.** Jekyll silently drops files beginning with an underscore.
4. **Installing before the first online load.** Add to Home Screen, then open it offline at least
   once — a first launch in Airplane mode has nothing cached.
5. **Stale code after a deploy.** Pages sends `Cache-Control: max-age=600`, so `sw.js` itself can
   be up to ten minutes stale. Bump `CACHE` on every deploy, and register with
   `{ updateViaCache: 'none' }` where supported.

Local development needs a server (`python3 -m http.server 8000`); `file://` has no secure context,
so the service worker never registers. The one test that matters is on the device: load online
once, Airplane mode, play each Game, kill and relaunch offline.

## Adding a Game

1. `content/<game>.json` — hand-authored **Items**.
2. `js/games/<id>/index.js` — the module: `id`, `title`, `content`, `dims`, `presets`,
   `controls`, `play`.
3. `js/registry.js` — one import, one array entry.
4. `npm run check` — the structural gate must pass.

Acceptance test for "did I add it the modular way": the diff contains a content file, a Game
folder and one registry line, and **nothing** under `engine.js`, `app.js`, `router.js`, `ui.js`,
`storage.js` or `sw.js`. If any of those changed, the boundary leaked and the leak is the bug.

## Growth

Growth goes **sideways, not up**. The second time two Games need the same timer, grid, shuffle or
chart, it becomes a plain module in `js/lib/` and both Games import it. It is never promoted into
`engine.js`. `roundLoop()` is the one that earned this already.

## Deliberate non-goals

No build step, no bundler, no framework, no TypeScript files, no htmx, no accounts, no sync, no
server, no analytics, no export/import, no event bus, no plugin system, no runtime content
generation.

**Why not htmx** (asked and settled): htmx works by making an HTTP request and swapping the
returned HTML into the DOM. Offline, the only thing that can answer is the service worker serving
pre-baked files — so every swap target would have to exist as a file. A round is ten randomised
questions from a filtered pool, and `hx-get` takes a URL, not a dice roll; grading and settings
would have nowhere to go; and every swap destroys focus and input state, which is exactly what a
round is made of. A hash router and one delegated click handler cover the navigation, and the
Games ship plain ES modules anyway.
