// @ts-check
/**
 * The host engine: the jobs the host owns, and nothing else.
 *
 * 1. Filter the Pool from the Game's content and the player's settings.
 * 2. Load the Game's declared content.
 * 3. Route and draw host chrome — `router.js` / `ui.js` own that half.
 * 4. Persist the opaque per-Game store — `js/storage.js` owns that half.
 *
 * The engine knows no Italian, no points, no Mastery and no statistics, and it never parses
 * what an Item means. It reads an Item's `tags` — the one field the Pool filter matches on —
 * and passes everything else through untouched. There is deliberately no `record()`, `award()`,
 * `score()`, `progress()`, `finish()` or chrome flag here: the object handed to `play()` has
 * exactly `{ pool, content, settings, rng, store }`, and everything else belongs to the Game.
 *
 * Ordering, weighting, round length and repetition are the Game's business too. The host hands
 * over the filtered Pool and an injectable RNG and stops there.
 */

/** An Item is opaque here: the engine reads `tags` and never another field. */
/** @typedef {Record<string, unknown>} Item */

/** Host-owned pool selection for one Game, as rendered by the settings screen. */
/** @typedef {{ preset: string | null, include: Record<string, string[]>, controls: Record<string, string | number | boolean> }} Settings */

/** The five properties of the object handed to `play()` — and no sixth. */
/** @typedef {{ pool: Item[], content: unknown, settings: Settings, rng: () => number, store: unknown }} Session */

/**
 * One settings-screen section: a Dimension and its allowlisted values, in declaration order.
 * @typedef {{ dim: string, values: string[] }} Dim
 */

/**
 * A named Pool: a Preset id and label plus the `include` map it writes into Settings.
 * @typedef {{ id: string, label: string, include: Record<string, string[]> }} Preset
 */

/**
 * One declared control (v0.1 has exactly the shared round count).
 * @typedef {{ id: string, label: string, options: Array<string | number>, default: string | number }} Control
 */

/**
 * One Game's module contract. `id`, `title` and a synchronous `play()` returning its own
 * teardown are the whole requirement; every other declaration is optional, and a Game that
 * declares nothing else still gets a hub entry, a filtered (empty) Pool and a back control.
 *
 * These typedefs are the single definition of each declaration shape: a Game annotates its own
 * literals with them (`Dim[]`, `Preset[]`, `Control[]`, and the declaration itself as `Game`), so
 * a heterogeneous `presets` array is checked against `include: Record<string, string[]>` instead
 * of widening into a union of object literals with `undefined`-typed missing keys — which nothing
 * would accept, and which would fail `registry.js`'s `Game[]` without a cast.
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   play: (root: Element, session: Session) => () => void,
 *   description?: string,
 *   section?: string,
 *   content?: string | Record<string, string>,
 *   fields?: string[],
 *   dims?: Dim[],
 *   presets?: Preset[],
 *   controls?: Control[],
 * }} Game
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * An Item's Tag strings. Filters only ever match on Tags; nothing else about an Item is
 * read, so a Game about something else entirely needs no change here.
 * @param {unknown} item
 * @returns {string[]}
 */
function tagsOf(item) {
  const tags = isPlain(item) ? item.tags : undefined;
  return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
}

/**
 * The Items a Pool is drawn from. A Game declaring a plain path gets that file's array; a
 * Game declaring a map gets the Items of every array file it declared, concatenated in
 * declaration order. Anything else is an empty pool, which is a legal round for a Game with
 * no content at all — it builds its own round.
 *
 * @param {unknown} content
 * @returns {Item[]}
 */
export function itemsOf(content) {
  if (Array.isArray(content)) return content;
  if (isPlain(content)) {
    /** @type {Item[]} */
    const items = [];
    for (const value of Object.values(content)) if (Array.isArray(value)) items.push(...value);
    return items;
  }
  return [];
}

/**
 * The Pool: the Items the player's settings allow. Inside a Dimension it is OR — any one of the
 * listed values matches — and across Dimensions it is AND, so every listed Dimension must be
 * satisfied. An empty `include` (a Game declaring no Dimensions) keeps every Item, while a
 * Dimension listed with no values is satisfiable by nothing: "None" on the settings screen
 * really is an empty pool, not an ignored constraint.
 *
 * @param {Item[]} items
 * @param {Settings} settings
 * @returns {Item[]}
 */
export function filterPool(items, settings) {
  const include = isPlain(settings) && isPlain(settings.include) ? settings.include : {};
  /** @type {Array<[string, string[]]>} */
  const active = [];
  for (const [dim, values] of Object.entries(include)) {
    if (Array.isArray(values)) active.push([dim, values.filter((v) => typeof v === 'string')]);
  }
  if (active.length === 0) return [...items];
  return items.filter((item) => {
    const tags = tagsOf(item);
    return active.every(([dim, values]) => values.some((value) => tags.includes(`${dim}:${value}`)));
  });
}

/**
 * Every declared Dimension's values, in declaration order — the "select everything" state a
 * Game's settings screen starts from.
 * @param {Game} game
 * @returns {Record<string, string[]>}
 */
function allValues(game) {
  /** @type {Record<string, string[]>} */
  const include = {};
  for (const { dim, values } of game.dims ?? []) include[dim] = [...values];
  return include;
}

/**
 * Each declared control at its declared default (the round-count control's `10`, for example).
 * @param {Game} game
 * @returns {Record<string, string | number | boolean>}
 */
function defaultControls(game) {
  /** @type {Record<string, string | number | boolean>} */
  const controls = {};
  for (const control of game.controls ?? []) controls[control.id] = control.default;
  return controls;
}

/**
 * The settings a Game with nothing saved gets: all values of every declared Dimension,
 * `preset: null`, and every control at its declared default. That is a usable whole-content
 * Pool, so the settings screen is never a dead end on a first visit.
 *
 * @param {Game} game
 * @returns {Settings}
 */
export function defaultSettings(game) {
  return { preset: null, include: allValues(game), controls: defaultControls(game) };
}

/**
 * Selecting a Preset copies its declared `include` map and records its id; anything else the
 * settings screen has (the round-count control) is kept. A manual change afterwards is the
 * settings screen's job — it sets `preset: null` and shows "Custom".
 *
 * @param {Game} game
 * @param {string} presetId
 * @param {Settings} [current] defaults to {@link defaultSettings}
 * @returns {Settings}
 */
export function presetSettings(game, presetId, current = defaultSettings(game)) {
  const preset = (game.presets ?? []).find((entry) => entry.id === presetId);
  if (!preset) throw new Error(`giocco engine: Game "${game.id}" declares no preset "${presetId}"`);
  /** @type {Record<string, string[]>} */
  const include = {};
  for (const [dim, values] of Object.entries(preset.include)) include[dim] = [...values];
  const controls = isPlain(current.controls) ? current.controls : defaultControls(game);
  return { preset: preset.id, include, controls: { ...controls } };
}

/**
 * The Session's RNG. Deterministic rounds in tests and bug reports, `Math.random` in the app.
 * A seed yields the same sequence every run (mulberry32).
 *
 * @param {number} [seed]
 * @returns {() => number} numbers in [0, 1)
 */
export function createRng(seed) {
  if (seed === undefined) return Math.random;
  if (!Number.isInteger(seed)) throw new Error(`giocco engine: rng seed must be an integer, got ${String(seed)}`);
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Content paths in a Game module are relative to the deployed site root, not to `js/engine.js`,
 * so the default base is the document's base URL — the directory `index.html` sits in, which is
 * the `/giocco/` project subpath in production. Under Node (the sanity suite) it is the
 * repository root, one level above `js/`.
 * @returns {string}
 */
function siteBase() {
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string') return document.baseURI;
  return new URL('../', import.meta.url).href;
}

/**
 * Fetch and parse one declared content file.
 * @param {string} url relative to the site root, e.g. `./content/verbi-presente.json`
 * @param {string} base
 * @param {typeof globalThis.fetch} doFetch
 * @returns {Promise<unknown>}
 */
async function readJson(url, base, doFetch) {
  const response = await doFetch(new URL(url, base).href);
  if (!response.ok) throw new Error(`giocco engine: could not load ${url} (${response.status})`);
  return response.json();
}

/**
 * Load a Game's declared content. A plain path gives the parsed file; a map gives the same
 * parsed JSON keyed by declaration key, so `session.content.words` is the words file.
 * A Game declaring no content gets `null`.
 *
 * @param {Game} game
 * @param {{ base?: string, fetch?: typeof globalThis.fetch }} [options] injected by the sanity
 *   checks — the browser path passes nothing
 * @returns {Promise<unknown>}
 */
export async function loadContent(game, options = {}) {
  const content = game.content;
  if (content === undefined) return null;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('giocco engine: no fetch available to load content');
  const base = options.base ?? siteBase();
  if (typeof content === 'string') return readJson(content, base, doFetch);
  /** @type {Record<string, unknown>} */
  const mapped = {};
  for (const [key, path] of Object.entries(content)) mapped[key] = await readJson(path, base, doFetch);
  return mapped;
}

/**
 * Build the object handed to `play(root, session)`: exactly five properties, no callbacks, no
 * lifecycle, no scoring API. The Pool is already filtered, so a Game never re-implements the
 * filter, and the RNG is injectable, so a round is reproducible in a check or a bug report.
 *
 * @param {Game} game
 * @param {{ content?: unknown, settings?: Settings, store?: unknown, rng?: () => number }} [parts]
 * @returns {Session}
 */
export function createSession(game, parts = {}) {
  const settings = isPlain(parts.settings) ? /** @type {Settings} */ (parts.settings) : defaultSettings(game);
  return {
    pool: filterPool(itemsOf(parts.content), settings),
    content: parts.content ?? null,
    settings,
    rng: typeof parts.rng === 'function' ? parts.rng : Math.random,
    store: parts.store ?? null,
  };
}
