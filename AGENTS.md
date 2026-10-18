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
| `npm test` | `node tools/check.mjs --selftest` — the gate's own fixture suite. |
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

Status: **tooling and gates only.** The app itself — `index.html`, `styles.css`, `sw.js`,
`js/**`, `content/*.json`, `icons/` — does not exist yet.
