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

Status: **docs only — no code yet.** Nothing described in these docs exists: no `package.json`,
no `index.html`, no `sw.js`, no `js/`, no `content/`, no `tools/`.
