# Hash routes, relative URLs, and a frozen deploy subpath

The app is a static GitHub Pages project site at `https://<user>.github.io/giocco/`, installed to
an iPhone home screen, required to work fully offline. So: hash routes only (`#/`, `#/g/<id>`,
`#/g/<id>/settings`); every URL relative (`./js/app.js`, never `/giocco/js/app.js`); `.nojekyll`
committed; `sw.js` at the root of the subpath; the subpath itself fixed from day one.

Pages offers no rewrites — a path route 404s on reload — and no custom headers, which is why the
service worker is classic rather than a module and serves the shell cache-first. The worker's scope
is derived from the path of `sw.js`, so moving it later means the installed app becomes a
different app: new scope, cold cache, re-install. Hash routes, by contrast, have no bearing on
scope and can be renamed at any time.

**Consequences:** URLs contain a `#`; pretty paths would need a different host or accepting
reload-404s; the `CACHE` constant must be bumped on every deploy, because Pages sends
`Cache-Control: max-age=600` and `sw.js` itself can be up to ten minutes stale.
