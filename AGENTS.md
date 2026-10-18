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
| `docs/verification/v0.1-acceptance.md` | The US-020 verification record: the served `/giocco/` shape, the offline relaunch, the navigation contracts, and what a real device still owns | Before re-verifying the deployed path or offline behavior |

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

A Game's declaration literals carry `engine.js`'s own typedefs (`/** @type {Dim[]} */`,
`Preset[]`, `Control[]`, and the exported object as `Game`). That is not decoration: an
unannotated heterogeneous `presets` array (`{ reg: […] }` beside `{ cefr: […] }`) infers a union
whose members carry the missing key as `undefined`, which no `Record<string, string[]>` accepts —
so `registry.js`'s `Game[]` fails on a file the Game never touched. Annotating in the Game keeps
`registry.js` free of casts and keeps one definition of each shape.

Host modules that are DOM-free carry their deterministic checks in `tools/sanity.mjs` instead
(`node tools/sanity.mjs`, also run by `npm test`); it imports `js/**` directly with plain
`node:assert` cases, and a case may be `async` (`runSanity()` awaits every case). Host modules
that touch environment globals (`localStorage`) or the network (`fetch`) take them as injectable
defaults so Node can drive them with a fake backend — `js/ui.js` takes `document` the same way,
and the suite's `fakeDocument()` (create/append/attrs/`textContent`, plus `addEventListener` and a
`fire(type)` helper) is what lets a screen's *structure* **and its taps** be checked in Node — it
also records `innerHTML` as the exact string it was handed, because a chart is the one thing a
Game writes as markup. Timers take the same treatment: `withFakeTimers()` swaps
`setTimeout`/`clearTimeout` for a controllable clock, which is how a real Game's `play()` — with
nowhere to inject them — is walked through a whole round and its 700/1400/250 ms delays. Boot
is covered the same way: `boot({ document, window, fetch, storage, games, serviceWorker })` in
`js/app.js` takes every environment global as an injectable default, so a case can prove
fetch-before-render order, the cold-load redirect and the composed Game teardown without a
browser. `sw.js` takes the same treatment from the other direction: a case runs the real worker
in a `node:vm` context over `CacheStorage`-shaped fakes and dispatches install/activate/fetch, so
every documented strategy (precache list, navigation fallback, network-first app code,
stale-while-revalidate) is asserted without a browser — see `swHarness()` in `tools/sanity.mjs`.
`js/lib/roundLoop.js` is the third shape: its `document`, `setTimeout`, `clearTimeout` and `now`
are injectable defaults, so a case drives the whole cycle — including its three timings — over the
same `fakeDocument()`. `js/lib/charts.js` is a fourth: two pure functions that turn an array of
numbers into an inline-SVG **string** (`sparkline()`, `bars()`), with nothing injected and no DOM,
so a case asserts the geometry, the clamping and the well-formedness of that string directly. What
a fake cannot see — layout, safe areas, focus order, hit targets under a thumb, offline, or how a
chart actually looks at its rendered size — stays a manual browser/device check; the CSS minimum
sizes are the one thing read out of `styles.css` by a case.

Status: **host engine.** `index.html`, `styles.css`, `manifest.webmanifest`, `icons/`,
`.nojekyll`, `sw.js` (the classic service worker: the four-URL shell precache, the four fetch
strategies and the two rejections), `js/app.js` (boot: register the service worker → registry →
every registered content file → router/render),
`js/storage.js` (envelope, `migrate()`, per-Game
settings + store), `js/engine.js` (Pool filter, content loading, the five-property Session,
injectable RNG, settings/Preset helpers), `js/registry.js` (the three permanent ids in
display order, each importing its `js/games/<id>/index.js`), `js/router.js` (the three frozen
hash routes, cold-load and unknown-route redirects, screen teardown), `js/ui.js` (the hub —
wordmark plus one card per Game linking to its settings route — the settings screen, and the Game
route's chrome: a single back control to `#/` plus the empty node a Game draws into) and
`js/lib/roundLoop.js` (the shared question cycle a Game opts into — ask → feedback/self-grade →
advance → summary, plus its teardown) and `js/lib/charts.js` (the two dependency-free inline-SVG
chart helpers a Game's own statistics view draws with) exist, and `content/verbi-presente.json`
(the hand-authored verb corpus: 20 lexemes × six persons = 120 Items) now ships.
`js/games/verbi-presente/index.js` plays a real round (US-013): a weighted draw of
`min(chosen count, pool.length)` distinct Items, each asked with its own answer plus its three
authored distractors in a shuffled four-option set, handed to `roundLoop()` in `choice` mode.
Its named exports (`weightedQueue`, `questionFor`, `itemWeight`, `masteryOf`, `epochDay`,
`shuffle`, `roundCount`, and the store-reading `roundQueue`) are the draw policy the other Games
import rather than copy, and since US-017 they include the progress core (`recordAttempt`,
`statsFor`, `masteredOf`, the bounded
history and the `statisticsView()` the Game draws with): the Game records `{ a, c, ema, last }`
per Item, the points, 90 daily buckets and 26 weekly Tag snapshots in **its own** store, and its
round summary carries a Game-owned **Statistics** action beside Play again and Done — the action
plus the in-place view it opens are `statisticsPanel()`, so the three Games share one pair of
summary controls and still draw each view from their own store alone.
`js/games/verbi-presente-rivela/index.js` plays a real reveal round (US-014): it imports that
policy (`roundQueue`, `roundCount`), draws the same weighted, without-replacement
queue and hands `roundLoop()` `mode: 'reveal'` with `{ prompt, answer }` questions — one prompt,
one *Show answer*, then the two self-grade labels, nothing red and no auto-advance. Mastery is
read from *its own* `session.store`, so production progress never borrows recognition's; since
US-018 it also imports that Game's progress core (`recordAttempt`, `statisticsPanel`), so every
self-grade is written the moment it is given, its summary carries a Game-owned **Statistics**
action beside Play again and Done, and the four statistics sections are computed over production's
store and the whole verb corpus alone.
`nomi-plurale` declares its own `content`, `fields`, the four noun `dims` (`gender`, `plural`,
`irreg`, `cefr`) and the three noun `presets` (US-015), so `content/nomi-plurale.json` — the
hand-authored noun corpus, 13 plural patterns × five nouns = 65 Items — is gated against it, and
its `play()` now plays a real choice round (US-016): the same shared choice interaction as
`verbi-presente`, whose draw policy it imports (`roundQueue`/`shuffle`/`roundCount`)
with its own `questionFor` for the noun Item shape, mastery read from its own store. Since US-019
it imports that Game's progress core too (`recordAttempt`, `statisticsPanel`):
every answered question is written the moment the shared loop judges it, its summary carries a
Game-owned **Statistics** action beside Play again and Done, and the four statistics sections are
computed over the noun store and the whole noun corpus alone, so the three Games share one policy
and never a number. The two
verb modules also declare
`content`, `fields`, `dims` and `presets` (US-012), so the one verb file is gated against both of
them — their declarations must stay in step, which `tools/sanity.mjs` checks. The boot wiring is
`js/app.js`: `boot()` registers `./sw.js`, fetches every registered Game's declared content, then
hands `createRouter()` a renderer that composes the host's screens with that content and the live
storage slices. `tools/sanity.mjs` also carries US-020's deployed-shape case (every shipped URL
relative and on disk, `.nojekyll`, the manifest's `start_url`/`scope`, the worker's classic form
and four-URL `SHELL`, no development gate wired in), and the manual half of that verification —
the served `/giocco/` crawl, the offline relaunch over the real server, and the navigation
contracts played through the real `boot()` — is recorded in `docs/verification/v0.1-acceptance.md`.

## Shell

- Every URL is relative (`./js/app.js`, `./icons/icon-192.png`), so the shell is deployable from
the `/giocco/` subpath and from a root dev server unchanged. `manifest.webmanifest` uses
`start_url: "./"`.
- `styles.css` is the only stylesheet and holds every shared primitive (shell, hub, settings,
the `roundLoop()` markup, statistics rows). There is no per-Game stylesheet and no build step.
- `js/app.js` is boot, and the only module `index.html` loads: `boot(options)` imports the
registry (which statically imports every Game, so the whole graph is fetched on the first online
load), registers `./sw.js` first (fire-and-forget, `{ updateViaCache: 'none' }`, so an insecure
context or a missing service worker only warns), fetches every registered Game's declared content
**before anything renders** — a Game fetched on first visit would silently not exist offline — and
only then starts the router with a
renderer that composes `ui.hub` / `ui.settingsScreen` / `ui.gameScreen` + `game.play()` with that
content and the live `storage.settings`/`storage.store` slices. Nothing is validated at boot
(`tools/check.mjs` is an author-time gate). Every environment global is an injected default
(`document`, `window`, `fetch`, the storage backend, the Game list, the service-worker container),
so `tools/sanity.mjs` drives the whole boot with fakes while the browser runs the zero-argument
`boot()`.
- `sw.js` is a classic worker at the deployed root, so its scope is the `/giocco/` subpath. It
precaches exactly `['./', './index.html', './styles.css', './manifest.webmanifest']` under
`giocco-v1`, serves a navigation from the cached `./index.html`, treats `js/**`, `sw.js`, CSS and
the webmanifest as network-first (a fix must land), keeps every other same-origin GET on
stale-while-revalidate, and ignores non-GET and cross-origin requests. There is no warm list and
no message channel: the module graph and the corpus are cached because they are fetched through
this handler on the first online load. Registration lives in `js/app.js`, not `index.html` — the
shell keeps its single module entry.
- `js/registry.js` statically imports every Game module and is the only place a Game is announced,
so the whole Game graph is fetched and cached on the first online load; `js/engine.js` builds the
Session from a Game's declaration without reading a single Item field but `tags`.
- `js/router.js` reads only the fragment, so the deployed subpath never reaches it. It takes its
environment (`window`) as a parameter, which is how `tools/sanity.mjs` drives cold loads,
redirects and Back/Forward with a fake; a redirect uses `location.replace()` so the entry that
held the cold or dead URL is replaced rather than pushed. Whatever a screen's `render` returns is
its teardown, and the router runs it before the next screen renders and on `stop()`.
- `js/ui.js` draws the host's screens and nothing else: `createUi(doc = document)` returns `hub()`
(wordmark + one `a.game-card` per Game, in registry order, each pointing at that Game's settings
route), `gameScreen()` (the back control plus the node a Game draws into) and `settingsScreen()`
(the Game's title, Preset chips + a `Custom` state chip, one accordion per Dimension with the
first open, its control chips and a sticky footer with the eligible count and `Start round`).
Cards and the back control are plain anchors, so navigation needs no handler and works before the
boot script has run; `Start round` is a `<button>` (it must be `disabled` on an empty pool) and
takes `navigate` as an injected option, which the boot wiring fills with the router's own.
`gameScreen()` never calls `play()`: the route renderer mounts the Game into the returned
`playRoot` and composes the two teardowns, which is why `ui.js` imports no Session and no storage
— only the engine's pure `filterPool`/`presetSettings` helpers, because the settings screen is
host-rendered from the Game's declaration. Chrome copy is English; a Game's own strings stay
Italian.
- The settings screen builds its DOM once and mutates it through a `refresh()`: every change
writes through the live (persisted) `settings` object — clearing `preset` and setting
`include`/`controls` — then recomputes every badge, the accordion counts, the chip states and the
footer. A value's badge is `filterPool(items, { include: { …current, [dim]: [value] } })`, i.e.
what it would add given everything else; below five it is dimmed, `aria-disabled` and given a
`needs 5+ items` sub-line. A Dimension absent from `include` (a Preset mentions only the
Dimensions it filters) is **unconstrained**, so the form shows it all-on rather than as `None`.
- `js/lib/roundLoop.js` is the Game-side loop (`docs/design/ui-and-interaction.md` § B is its
contract), and every environment it touches is an injected default: `roundLoop(root, { mode:
'choice' | 'reveal', sample, onAnswer, summaryActions, onState, document, setTimeout,
clearTimeout, now })`. `sample()` is the *only* source of a queue, so Play again is always a
fresh draw; `onAnswer(question, correct)` records the attempt on the spot and returns the points
it earned (default 10 per correct); `summaryActions(container)` is called once, at build time,
where a Game appends its own summary action (US-017's Statistics) between Play again and Done.
The loop never reads `session`, storage or content, judges a choice by `option === answer`, and
carries the hub hash `#/` as a literal — importing `router.js` would close the
`registry → Game → roundLoop → router → registry` cycle that TDZ-fails the structural gate.
It builds one DOM and mutates it (text, class, `hidden`, `data-state`), re-focuses `#prompt`
with `preventScroll` on every ask, and returns `{ section, state(), teardown() }`; the timer and
clock injectables are what let `tools/sanity.mjs` assert the 700/1400 ms auto-advance, the 250 ms
tap guard and the 250 ms self-grade confirm. `styles.css` pins `[hidden] { display: none
!important }`, because the loop hides nodes that carry their own `display` rule.
- `js/games/verbi-presente/index.js` is the first Game with a real round, and it is the one place
the choice drill's policy lives: the queue is a weighted draw *without replacement* over
`session.pool`, one key `u ** (1 / weight)` per Item (Efraimidis–Spirakis) sorted descending — so
`weight = (1 - mastery) + 0.2` with a constant RNG makes the draw order *be* the weight order,
which is how a case asserts the weighting deterministically — clamped to
`min(settings.controls.count, pool.length)`. Mastery is read from the Game's own store
(`masteryOf`) and is 0 for an unseen Item, so an empty store draws uniformly and the
`onAnswer` that writes `{ a, c, ema, last }` makes weak Items come up more often with no change
to the draw. Option order is drawn once per question with `session.rng`, never re-shuffled while
the question is on screen. `roundLoop()` needs a `document` and a Game's `play(root, session)` has
no place to inject one, so `tools/sanity.mjs`'s `withFakeDocument()` installs the fake as the
global document for the duration of such a case.
- The Game-side progress core lives in `js/games/verbi-presente/index.js` and is *policy*, not
host state: `recordAttempt(store, item, correct, { items, now })` writes one attempt into the
store it is handed (`{ items: { <id>: { a, c, ema, last } }, points, days: [{ d, a, c, p }],
weeks: [{ w, tags }] }`), and `statsFor(store, items, now)` returns the four sections' numbers.
Both take the store as an argument, so `verbi-presente-rivela` (US-018) and `nomi-plurale`
(US-019) reuse the same formulas over their own slices without sharing a number; `items` is the
Game's *whole current corpus* (`session.content`), never the filtered Pool, so a filtered round
cannot rewrite the views.
The store proxy persists every write on the spot, so an attempt made mid-round survives the host
back control. `statisticsView(doc, { store, items, onSummary })` is the view: it builds the four
sections once and refreshes them by mutation (the `js/ui.js` rule), it is built hidden and swapped
with the round's own node in place — never a route, never a link — and its only action is the
Game-owned **Summary** that returns to the same round summary. `statisticsPanel({ store, items })`
is the same view plus the summary **Statistics** action that opens it and the swap between the two,
so each Game's `play()` binds the pair with `stats.bind(loop.section)` and appends it once. A chart
is inserted with
`innerHTML` (the one place a Game does so, because `js/lib/charts.js` returns a string) and always
sits next to a written summary; empty states are strings, never `NaN`.
- `js/lib/charts.js` is the Game-side statistics decoration and imports nothing: `sparkline(vals,
{ w, h })` returns an inline-SVG string for two or more values and `''` for fewer, and `bars(vals,
{ w, h, gap, min, max })` returns one `h`-tall clamped rect per value (defaults 6px tall, 8px
apart, mapped over 0..100). Both are `aria-hidden="true"` and carry no text, so the caller owes an
adjacent written summary, and both are laid out by the caller: `.spark` takes its height from
`styles.css`, `.bars` carries the total as its `height` attribute and only fills the column's
width, so `preserveAspectRatio="none"` stretches bars horizontally without changing their 6px
weight. A chart string is for a Game's own statistics view; the round loop still never touches
`innerHTML`.

To check the shell the way it is deployed, symlink the repo into a parent directory and serve
that (`ln -s $PWD /tmp/serve/giocco && cd /tmp/serve && python3 -m http.server 8001`), then load
`http://127.0.0.1:8001/giocco/`.
