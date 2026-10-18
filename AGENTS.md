# AGENTS.md

Repo map. Read the row before you touch that area.

| Path | What it holds | Read it when |
|---|---|---|
| `README.md` | Domain language, the host/Game boundary, frozen routes and storage, accepted risks | Before changing anything |
| `docs/design/architecture.md` | The host's four jobs, boot order, the service worker, storage, deploy, how to add a Game | Before touching host code or adding a Game |
| `docs/design/content-and-progress.md` | Item shape, Tags and the vocabulary, the authoring gates, corpus plan, the Italian Games' own progress formulas | Before authoring content or changing a Dimension |
| `docs/design/ui-and-interaction.md` | The hub, `roundLoop()`'s contract, the settings screen, statistics-view guidance, touch/a11y rules | Before changing any screen |
| `docs/adr/0001-the-host-owns-no-scoring.md` | Why scoring, mastery and statistics are Game-local | Before adding a shared progress model |
| `docs/adr/0002-hash-routes-relative-urls-on-deploy.md` | Why hash routes, relative URLs, and a frozen subpath | Before changing routing or deploy paths |

## Development gates

| Command | What it does |
|---|---|
| `npm install` | Installs the only devDependency (`typescript`). No runtime dependencies, no test framework. |
| `npm run check` | `node tools/check.mjs` — the structural gate over `content/*.json`. |
| `npm run typecheck` | `npx tsc --noEmit` — type-checks `js/**` JavaScript without emitting files. |
| `npm test` | `node tools/check.mjs --selftest && node tools/sanity.mjs` — the gate's fixture suite, then the host modules' Node-level sanity suite. |
| `python3 -m http.server 8000` | The local server every manual browser/device check uses. |

`tools/check.mjs` imports `js/games/<id>/index.js` to read each Game's own declarations
(`content`, `fields`, `dims`, `presets`) and validates every content file against each Game that
declares it. Two consequences: a Game module must be import-safe in Node (pure declarations at
module scope, no DOM until `play()` runs), and every file under `js/**` must open with
`// @ts-check` — `tsconfig.json` sets `checkJs: false`, so the pragma is what puts a file under
the type gate, and the structural gate fails a file that omits it.

A Game declares the exact Item field names in `fields` (default
`['id', 'prompt', 'answer', 'distractors', 'tags']`); the gate rejects an Item with an extra or
missing field. Extend `tools/selftest.mjs` (not a new framework) when adding a gate rule.

Host modules that are DOM-free carry their deterministic checks in `tools/sanity.mjs` instead
(`node tools/sanity.mjs`, also run by `npm test`); it imports `js/**` directly with plain
`node:assert` cases, and a case may be `async` (`runSanity()` awaits every case). Anything that
needs a DOM (boot, rendering, offline) is verified manually. Host modules that touch environment
globals (`localStorage`) or the network (`fetch`) take them as injectable defaults so Node can
drive them with a fake backend.

Status: **host engine.** `index.html`, `styles.css`, `manifest.webmanifest`, `icons/`,
`.nojekyll`, the `js/app.js` boot placeholder, `js/storage.js` (envelope, `migrate()`, per-Game
settings + store), `js/engine.js` (Pool filter, content loading, the five-property Session,
injectable RNG, settings/Preset helpers), `js/registry.js` (the three permanent ids in
display order, each importing its `js/games/<id>/index.js`) and `js/router.js` (the three frozen
hash routes, cold-load and unknown-route redirects, screen teardown) exist. Those three Game
modules are registration placeholders: they declare `id`, `title`, `description` and a no-op
`play()` until their drills, declarations and `content/*.json` land. `sw.js`, `js/ui.js`,
`js/lib/*` and `content/*.json` do not exist yet, and nothing calls `createRouter()` — the boot
wiring is US-008's.

## Shell

- Every URL is relative (`./js/app.js`, `./icons/icon-192.png`), so the shell is deployable from
the `/giocco/` subpath and from a root dev server unchanged. `manifest.webmanifest` uses
`start_url: "./"`.
- `styles.css` is the only stylesheet and holds every shared primitive (shell, hub, settings,
the `roundLoop()` markup, statistics rows). There is no per-Game stylesheet and no build step.
- `js/app.js` is a boot placeholder so the shell has no broken asset reference; the registry →
content → router wiring lands there later. Service-worker registration is not in `index.html`
yet — it arrives with `sw.js`.
- `js/registry.js` statically imports every Game module and is the only place a Game is announced,
so the whole Game graph is fetched and cached on the first online load; `js/engine.js` builds the
Session from a Game's declaration without reading a single Item field but `tags`.
- `js/router.js` reads only the fragment, so the deployed subpath never reaches it. It takes its
environment (`window`) as a parameter, which is how `tools/sanity.mjs` drives cold loads,
redirects and Back/Forward with a fake; a redirect uses `location.replace()` so the entry that
held the cold or dead URL is replaced rather than pushed. Whatever a screen's `render` returns is
its teardown, and the router runs it before the next screen renders and on `stop()`.

To check the shell the way it is deployed, symlink the repo into a parent directory and serve
that (`ln -s $PWD /tmp/serve/giocco && cd /tmp/serve && python3 -m http.server 8001`), then load
`http://127.0.0.1:8001/giocco/`.
