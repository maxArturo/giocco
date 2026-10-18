// @ts-check
/**
 * Persistence: one key, one envelope, one `migrate()` chain.
 *
 * ```js
 * localStorage['giocco'] = { v: 1, data: { games: { '<id>': { settings, store } } } }
 * ```
 *
 * `settings` is the host's (which pool the player chose); `store` is the Game's, opaque
 * here — nothing in this module parses Item semantics, scores, or reads inside a store.
 * Both are handed out as live objects whose writes are persisted on the spot, so a Game
 * that writes per answer keeps everything earned when the player quits mid-round, without
 * adding a callback, a `save()` call, or any property to the five-field Session contract.
 *
 * Nothing is pruned: an entry whose Item left the content file stays where it is, because
 * that is what makes re-adding an Item later restore the player's progress.
 */

/** The one persistent key. No second key, no export, no import. */
export const KEY = 'giocco';

/** The envelope version this build understands and writes. */
export const VERSION = 1;

/**
 * Host-owned pool selection for one Game, as rendered by the settings screen.
 * @typedef {{
 *   preset: string | null,
 *   include: Record<string, string[]>,
 *   controls: Record<string, string | number | boolean>,
 * }} Settings
 */

/** One Game's whole persisted slice. */
/** @typedef {{ settings: Settings, store: unknown }} Slice */

/**
 * Envelope contents once versioned. Extra top-level keys survive untouched.
 * @typedef {{ games: Record<string, Slice>, [key: string]: unknown }} Data
 */

/** A `localStorage`-shaped backend; injected so the module is testable without a DOM. */
/** @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} Backend */

/** @typedef {(data: Data) => Data} Step */

/**
 * One migration step per version bump, keyed by the version it *produces*. Empty because
 * `v: 1` is the first shipped envelope — the chain exists so the first bump is one entry
 * here plus `VERSION`, and never a boot that probes a set of versioned keys.
 * @type {Record<number, Step>}
 */
const STEPS = {};

/**
 * The single migration entry point. Walks `v` forward to {@link VERSION}, running one
 * registered step per version, and returns the data (normalised, never pruned).
 *
 * @param {unknown} v the version found in the envelope
 * @param {unknown} data the `data` found in the envelope
 * @param {Record<number, Step>} [steps] injection point so the chain is testable
 * @returns {Data}
 */
export function migrate(v, data, steps = STEPS) {
  let out = normalise(data);
  const from = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : VERSION;
  for (let next = from + 1; next <= VERSION; next += 1) {
    const step = steps[next];
    if (step) out = normalise(step(out));
  }
  return out;
}

/** A brand-new, empty envelope body. @returns {Data} */
function emptyData() {
  return { games: {} };
}

/** @returns {Settings} */
function defaultSettings() {
  return { preset: null, include: {}, controls: {} };
}

/**
 * Keep whatever is already persisted — including keys this build does not know — and make
 * sure `games` is an object to hang slices off. Never drops an entry.
 *
 * @param {unknown} data
 * @returns {Data}
 */
function normalise(data) {
  /** @type {Record<string, unknown>} */
  const source = isPlain(data) ? { .../** @type {Record<string, unknown>} */ (data) } : {};
  return { ...source, games: isPlain(source.games) ? /** @type {Record<string, Slice>} */ (source.games) : {} };
}

/**
 * @param {unknown} value
 * @returns {boolean} true for anything JSON can hold a mutation in (objects and arrays)
 */
function isBag(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value
 * @returns {boolean} true only for plain objects, never for arrays or class instances
 */
function isPlain(value) {
  if (!isBag(value) || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {string} message @param {unknown} [detail] */
function warn(message, detail) {
  if (typeof console !== 'undefined') console.warn(`giocco storage: ${message}`, detail ?? '');
}

/**
 * Read the stored blob into an envelope body.
 *
 * A blob that cannot be read at all (unparsable, or not an envelope) is left exactly where
 * it is and writes are refused, on the same principle as a newer version: never clobber
 * data this build cannot interpret. The app keeps working from memory for the session.
 *
 * @param {Backend} backend
 * @returns {{ data: Data, writable: boolean }}
 */
function open(backend) {
  /** @type {string | null} */
  let raw;
  try {
    raw = backend.getItem(KEY);
  } catch (error) {
    warn(`could not read ${KEY}; this session will not be saved`, error);
    return { data: emptyData(), writable: false };
  }
  if (raw === null) return { data: emptyData(), writable: true };

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(`stored ${KEY} is not valid JSON; leaving it alone`, error);
    return { data: emptyData(), writable: false };
  }
  if (!isPlain(parsed)) {
    warn(`stored ${KEY} is not an envelope; leaving it alone`);
    return { data: emptyData(), writable: false };
  }

  const v = /** @type {Record<string, unknown>} */ (parsed).v;
  if (typeof v === 'number' && v > VERSION) {
    warn(`stored ${KEY} is version ${v}, newer than this build's ${VERSION}; writes are disabled`);
    return { data: normalise(/** @type {Record<string, unknown>} */ (parsed).data), writable: false };
  }
  return { data: migrate(v, /** @type {Record<string, unknown>} */ (parsed).data), writable: true };
}

/**
 * Open the envelope and hand out live, auto-persisted, per-Game slices.
 *
 * @param {Backend} [backend] defaults to `localStorage`; inject a fake in Node checks
 * @returns {{
 *   readonly writable: boolean,
 *   settings: (gameId: string) => Settings,
 *   store: (gameId: string) => any,
 *   save: () => boolean,
 * }}
 */
export function createStorage(backend = globalThis.localStorage) {
  if (!backend || typeof backend.getItem !== 'function' || typeof backend.setItem !== 'function') {
    throw new Error('giocco storage: a localStorage-like backend is required');
  }

  const opened = open(backend);
  const data = opened.data;
  let writable = opened.writable;

  /** @type {WeakMap<object, object>} */
  const wrappers = new WeakMap();

  /**
   * Live view of a nested object: reads return wrapped children so mutations deep inside a
   * store persist too, and identity is stable (`store.a === store.a`).
   * @param {unknown} target
   * @returns {any}
   */
  function wrap(target) {
    if (!isBag(target)) return target;
    const object = /** @type {object} */ (target);
    const existing = wrappers.get(object);
    if (existing) return existing;
    const proxy = new Proxy(object, {
      get(t, key, receiver) {
        return wrap(Reflect.get(t, key, receiver));
      },
      set(t, key, value) {
        const ok = Reflect.set(t, key, value);
        if (ok) persist();
        return ok;
      },
      deleteProperty(t, key) {
        const ok = Reflect.deleteProperty(t, key);
        if (ok) persist();
        return ok;
      },
    });
    wrappers.set(object, proxy);
    return proxy;
  }

  /** Write the whole envelope now. @returns {boolean} */
  function persist() {
    if (!writable) return false;
    try {
      backend.setItem(KEY, JSON.stringify({ v: VERSION, data }));
      return true;
    } catch (error) {
      writable = false;
      warn('could not be written (quota or blocked); keeping this session in memory only', error);
      return false;
    }
  }

  /**
   * Find a Game's slice, creating it (and persisting) on first use. Two Games can never
   * share an object, so one Game's write cannot reach another Game's slice.
   * @param {string} gameId
   * @returns {Slice}
   */
  function sliceFor(gameId) {
    const existing = data.games[gameId];
    if (isPlain(existing)) {
      const slice = /** @type {Slice} */ (existing);
      if (!isPlain(slice.settings)) slice.settings = defaultSettings();
      if (!isBag(slice.store)) slice.store = {};
      return slice;
    }
    const created = { settings: defaultSettings(), store: {} };
    data.games[gameId] = created;
    persist();
    return created;
  }

  return {
    /** False once writes are refused (newer/foreign/unwritable blob). */
    get writable() {
      return writable;
    },
    /** @param {string} gameId */
    settings(gameId) {
      return /** @type {Settings} */ (wrap(sliceFor(gameId).settings));
    },
    /** @param {string} gameId @returns {any} */
    store(gameId) {
      return wrap(sliceFor(gameId).store);
    },
    save() {
      return persist();
    },
  };
}
