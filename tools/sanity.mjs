/**
 * Deterministic Node-level sanity checks for the host modules that are pure enough to run
 * without a browser: `js/storage.js`, `js/engine.js`, `js/registry.js`, `js/router.js` today —
 * plus `js/ui.js` against a minimal fake `document`, which checks the screen structure it builds
 * (elements, order, hrefs) and not the layout, focus or taps a browser owns. Run by `npm test`
 * (or `node tools/sanity.mjs`).
 *
 * Dependency-free `node:assert` only — the project ships no test framework. Behaviour that
 * needs a real browser (boot, offline, safe areas, hit targets under a thumb) is verified
 * manually instead; see AGENTS.md.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEY, VERSION, createStorage, migrate } from '../js/storage.js';
import {
  createRng,
  createSession,
  defaultSettings,
  filterPool,
  itemsOf,
  loadContent,
  presetSettings,
} from '../js/engine.js';
import { GAME_IDS, GAMES, gameById } from '../js/registry.js';
import {
  HUB_HASH,
  createRouter,
  gameHash,
  parseRoute,
  resolveRoute,
  settingsHash,
} from '../js/router.js';
import { createUi } from '../js/ui.js';

/** Run `fn` with `console.warn` muted; storage warns on purpose for the blob cases. */
function quiet(fn) {
  const { warn } = console;
  console.warn = () => {};
  try {
    fn();
  } finally {
    console.warn = warn;
  }
}

/**
 * A `localStorage`-shaped fake. `values` is inspected directly so a case can prove what
 * actually reached persistence, not just what the in-memory object looks like.
 * @param {string | null} [initial]
 */
function fakeBackend(initial = null) {
  /** @type {Record<string, string>} */
  const values = {};
  if (initial !== null) values[KEY] = initial;
  return {
    values,
    getItem: (key) => (Object.hasOwn(values, key) ? values[key] : null),
    setItem: (key, value) => {
      values[key] = String(value);
    },
    keys: () => Object.keys(values).sort(),
    raw: () => (Object.hasOwn(values, KEY) ? values[KEY] : null),
    envelope: () => JSON.parse(values[KEY]),
  };
}

/** @type {Array<{ name: string, run: () => void | Promise<void> }>} */
const cases = [];
const test = (name, run) => cases.push({ name, run });

/**
 * A `fetch`-shaped fake keyed by absolute URL, so a case can prove exactly which URLs were
 * requested and in which order.
 * @param {Record<string, unknown>} routes
 */
function fakeFetch(routes) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    fetch: async (/** @type {string} */ url) => {
      calls.push(url);
      if (!Object.hasOwn(routes, url)) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => routes[url] };
    },
  };
}

/**
 * A `window`-shaped fake the router can be driven with: a real history stack, so `back()` and
 * `forward()` fire `hashchange` the way a browser does, and nothing else — plus `flush()`, for
 * the browser's queued-event behaviour, which a case opts into with `{ defer: true }`.
 *
 * @param {string} [initial] the fragment the app boots on
 * @param {{ defer?: boolean }} [options] `defer` queues events instead of dispatching them
 */
function fakeWindow(initial = HUB_HASH, options = {}) {
  const entries = [initial];
  let index = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Array<() => void>} */
  const queued = [];
  const replaceCalls = [];

  const dispatch = () => {
    for (const listener of [...listeners]) listener();
  };
  const fire = () => {
    if (options.defer === true) queued.push(dispatch);
    else dispatch();
  };

  const location = {
    get hash() {
      return entries[index];
    },
    set hash(url) {
      if (url === entries[index]) return; // an unchanged hash fires no event, as in a browser
      entries.splice(index + 1);
      entries.push(url);
      index = entries.length - 1;
      fire();
    },
    replace(url) {
      replaceCalls.push(url);
      entries[index] = url;
      fire();
    },
  };

  return {
    location,
    replaceCalls,
    addEventListener: (type, listener) => {
      if (type === 'hashchange') listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    history: () => [...entries],
    back() {
      if (index > 0) {
        index -= 1;
        fire();
      }
    },
    forward() {
      if (index < entries.length - 1) {
        index += 1;
        fire();
      }
    },
    flush() {
      while (queued.length > 0) queued.shift()();
    },
  };
}

/** A minimal Game declaration; the engine reads nothing from it but the fields it declares. */
const noopGame = { id: 'noop', title: 'Noop', play: () => () => {} };

/** A two-Dimension fixture shaped like the shipped verb Games. */
const fixtureGame = {
  id: 'fixture',
  title: 'Fixture',
  play: () => () => {},
  content: './content/fixture.json',
  dims: [
    { dim: 'reg', values: ['regular', 'spelling', 'irregular'] },
    { dim: 'person', values: ['1s', '2s'] },
  ],
  presets: [{ id: 'a1', label: 'A1', include: { reg: ['regular', 'spelling'] } }],
  controls: [{ id: 'count', label: 'Round', options: [5, 10, 20], default: 10 }],
};

/** An Item is opaque to the engine; only `tags` is ever read. */
const item = (id, tags) => ({ id, prompt: id, answer: id, distractors: [], tags });

/** Settings with just an include map, as the filter cases need them. */
const withInclude = (include) => ({ preset: null, include, controls: {} });

/** @param {Array<{ id: string }>} items */
const ids = (items) => items.map((entry) => entry.id);

// ------------------------------------------------------------- the frozen contract
test('the key and version are the frozen v0.1 contract', () => {
  assert.equal(KEY, 'giocco');
  assert.equal(VERSION, 1);
});

// ------------------------------------------------------------- envelope creation
test('a fresh backend yields a writable storage with no envelope until something is stored', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  assert.equal(storage.writable, true);
  assert.equal(backend.raw(), null, 'nothing may be written before a Game asks for a slice');
});

test('the first slice creates the documented envelope', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const settings = storage.settings('verbi-presente');

  assert.deepEqual(settings, { preset: null, include: {}, controls: {} });
  assert.deepEqual(backend.envelope(), {
    v: 1,
    data: { games: { 'verbi-presente': { settings: { preset: null, include: {}, controls: {} }, store: {} } } },
  });
  assert.deepEqual(backend.keys(), [KEY], 'exactly one persistent key');
});

test('settings are host-owned and persist on every write', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const settings = storage.settings('nomi-plurale');

  settings.preset = 'a1';
  settings.include.gender = ['m', 'f'];
  settings.controls.count = 20;

  const persisted = backend.envelope().data.games['nomi-plurale'].settings;
  assert.deepEqual(persisted, { preset: 'a1', include: { gender: ['m', 'f'] }, controls: { count: 20 } });
  assert.deepEqual(backend.keys(), [KEY]);
});

// ------------------------------------------------------------- immediate persistence
test('a store write is persisted immediately, with no save() call', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const store = storage.store('verbi-presente');

  store.items = {};
  store.items['v-1'] = { a: 1, c: 0, ema: 0, last: 100 };
  store.items['v-1'].ema = 0.25;

  assert.deepEqual(backend.envelope().data.games['verbi-presente'].store, {
    items: { 'v-1': { a: 1, c: 0, ema: 0.25, last: 100 } },
  });
});

test('deleting from a store persists immediately', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const store = storage.store('verbi-presente');
  store.items = { a: {}, b: {} };
  delete store.items.b;

  assert.deepEqual(backend.envelope().data.games['verbi-presente'].store, { items: { a: {} } });
});

test('nested reads are stable and writable in place', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const store = storage.store('nomi-plurale');
  store.items = { 'n-1': { a: 2 } };

  assert.equal(store.items['n-1'], store.items['n-1'], 'identity is stable across reads');
  assert.deepEqual(Object.keys(store), ['items']);
  store.items['n-1'].a += 1;
  assert.equal(backend.envelope().data.games['nomi-plurale'].store.items['n-1'].a, 3);
});

// ------------------------------------------------------------- isolation + round trip
test('one Game can never alter another Game\'s slice', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  storage.settings('verbi-presente').preset = 'a1';
  storage.store('verbi-presente').points = 10;

  const otherStore = storage.store('verbi-presente-rivela');
  otherStore.points = 999;
  storage.settings('verbi-presente-rivela').preset = 'irregolari';
  delete storage.settings('verbi-presente-rivela').preset;

  const games = backend.envelope().data.games;
  assert.deepEqual(games['verbi-presente'], { settings: { preset: 'a1', include: {}, controls: {} }, store: { points: 10 } });
  assert.equal(games['verbi-presente-rivela'].store.points, 999);
  assert.equal(Object.keys(games).length, 2);
  assert.deepEqual(Object.keys(storage.settings('verbi-presente')), ['preset', 'include', 'controls']);
});

test('a second session reads exactly what the first wrote', () => {
  const backend = fakeBackend();
  const first = createStorage(backend);
  first.settings('verbi-presente').include.reg = ['irregular'];
  const gameStore = first.store('verbi-presente');
  gameStore.points = 35;
  gameStore.history = { '2026-10-18': { a: 3, c: 2 } };

  const second = createStorage(backend);
  assert.equal(second.writable, true);
  assert.deepEqual(second.settings('verbi-presente').include, { reg: ['irregular'] });
  assert.deepEqual(second.store('verbi-presente'), { points: 35, history: { '2026-10-18': { a: 3, c: 2 } } });
});

// ------------------------------------------------------------- nothing is pruned
test('unknown keys, extra slice fields and removed Item entries all survive a write', () => {
  const backend = fakeBackend(
    JSON.stringify({
      v: 1,
      data: {
        future: 'kept',
        games: {
          'verbi-presente': {
            settings: { preset: null, include: {}, controls: {}, legacyControl: 3 },
            store: { items: { 'v-removed': { a: 4, c: 1, ema: 0.5, last: 99 } }, notes: ['x'] },
            extra: true,
          },
        },
      },
    }),
  );
  const storage = createStorage(backend);
  storage.store('verbi-presente').touched = true;

  const envelope = backend.envelope();
  assert.equal(envelope.data.future, 'kept');
  const slice = envelope.data.games['verbi-presente'];
  assert.deepEqual(slice.store.items['v-removed'], { a: 4, c: 1, ema: 0.5, last: 99 });
  assert.deepEqual(slice.store.notes, ['x']);
  assert.equal(slice.extra, true);
  assert.equal(slice.settings.legacyControl, 3);
  assert.equal(envelope.v, 1, 'the envelope is re-stamped at the running version');
});

// ------------------------------------------------------------- migration
test('migrate() keeps unknown data and adopts an unversioned blob as current', () => {
  const data = { games: { a: { settings: {}, store: { keep: 1 } } }, custom: 7 };
  assert.deepEqual(migrate(VERSION, data), data);
  assert.deepEqual(migrate(undefined, data), data);
  assert.deepEqual(migrate('one', data), data);
  assert.deepEqual(migrate(VERSION, null), { games: {} });
  assert.deepEqual(migrate(VERSION, 'nope'), { games: {} }, 'a non-object body degrades to the empty shape');
});

test('the migration chain runs one step per version, oldest first', () => {
  const order = [];
  /** @type {Record<number, (data: any) => any>} */
  const steps = {
    1: (data) => {
      order.push('1');
      return { ...data, one: true };
    },
    2: (data) => {
      order.push('2');
      return { ...data, two: true };
    },
  };
  const out = migrate(0, { games: {} }, steps);
  assert.deepEqual(order, ['1']);
  assert.deepEqual(out, { games: {}, one: true });
  assert.deepEqual(migrate(1, { games: {} }, steps), { games: {} }, 'a current blob runs no step again');
  assert.deepEqual(migrate(99, { games: {} }, steps), { games: {} }, 'a newer blob runs no step backwards');
});

test('a stored older blob is migrated on read and saved at the running version', () => {
  const backend = fakeBackend(JSON.stringify({ v: 0, data: { games: {} } }));
  const storage = createStorage(backend);
  assert.equal(storage.writable, true);
  storage.store('verbi-presente').points = 1;
  assert.equal(backend.envelope().v, VERSION);
  assert.equal(backend.envelope().data.games['verbi-presente'].store.points, 1);
});

// ------------------------------------------------------------- refusing to clobber
test('a newer stored version is readable but never written to', () => {
  const raw = JSON.stringify({
    v: VERSION + 1,
    data: { games: { 'verbi-presente': { settings: { preset: 'a1', include: {}, controls: {} }, store: { points: 900 } } } },
  });
  const backend = fakeBackend(raw);

  quiet(() => {
    const storage = createStorage(backend);
    assert.equal(storage.writable, false);
    assert.equal(storage.store('verbi-presente').points, 900, 'existing progress still reads');
    assert.equal(storage.settings('verbi-presente').preset, 'a1');
    storage.store('verbi-presente').points = 1;
    assert.equal(storage.save(), false);
    assert.equal(backend.raw(), raw, 'the newer blob is byte-for-byte untouched');
    assert.deepEqual(backend.keys(), [KEY]);
  });
});

test('an unreadable blob is left alone and writes are refused', () => {
  quiet(() => {
    for (const raw of ['{ not json', '"a string"', '[]', 'null']) {
      const backend = fakeBackend(raw);
      const storage = createStorage(backend);
      assert.equal(storage.writable, false, `${raw} must not be writable`);
      storage.store('verbi-presente').points = 1;
      assert.equal(storage.store('verbi-presente').points, 1, 'the session still works from memory');
      assert.equal(backend.raw(), raw);
    }
  });
});

test('a backend that throws on read or write degrades to a memory-only session', () => {
  const readOnly = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  const broken = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {},
  };

  quiet(() => {
    const storage = createStorage(readOnly);
    assert.equal(storage.writable, true);
    storage.store('verbi-presente').points = 4;
    assert.equal(storage.writable, false, 'a failed write disables further writes instead of throwing');
    assert.equal(storage.store('verbi-presente').points, 4);
    assert.equal(storage.save(), false);
    assert.equal(createStorage(broken).writable, false);
  });
});

test('a backend-less environment (Node, private mode) fails loudly, not silently', () => {
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.throws(() => createStorage(), /localStorage-like backend/);
  assert.throws(() => createStorage(/** @type {any} */ ({ getItem: () => null })), /localStorage-like backend/);
});

// ------------------------------------------------------------- the registry
// `registry.js` is the sole Game announcement point: three imports, three entries. These
// checks are what keeps "exactly the three permanent ids, in display order" true.
test('the registry announces exactly the three permanent ids, in display order', () => {
  assert.deepEqual([...GAME_IDS], ['verbi-presente', 'verbi-presente-rivela', 'nomi-plurale']);
  assert.deepEqual(
    GAMES.map((game) => game.id),
    [...GAME_IDS],
    'the registered modules are the announced ids, in the same order',
  );
  assert.equal(new Set(GAME_IDS).size, GAME_IDS.length);
});

test('every registered Game follows the module contract', () => {
  for (const game of GAMES) {
    assert.equal(typeof game.id, 'string', 'a Game declares a string id');
    assert.ok(game.id.trim() !== '');
    assert.equal(typeof game.title, 'string', `${game.id} declares a title`);
    assert.ok(game.title.trim() !== '');
    assert.equal(typeof game.play, 'function', `${game.id} declares a synchronous play()`);
  }
});

test('gameById finds every registered Game and nothing else', () => {
  for (const game of GAMES) assert.equal(gameById(game.id), game);
  assert.equal(gameById('nope'), null);
  assert.equal(gameById(''), null);
});

// ------------------------------------------------------------- the pool filter
test('the pool filter is OR inside a Dimension and AND across Dimensions', () => {
  const items = [
    item('a', ['reg:regular', 'person:1s']),
    item('b', ['reg:spelling', 'person:2s']),
    item('c', ['reg:irregular', 'person:1s']),
  ];
  assert.deepEqual(ids(filterPool(items, withInclude({}))), ['a', 'b', 'c'], 'no include is the whole file');
  assert.deepEqual(ids(filterPool(items, withInclude({ reg: ['regular', 'spelling'] }))), ['a', 'b'], 'OR inside');
  assert.deepEqual(ids(filterPool(items, withInclude({ person: ['1s', '2s'] }))), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterPool(items, withInclude({ reg: ['regular'], person: ['2s'] }))), [], 'AND across');
  assert.deepEqual(ids(filterPool(items, withInclude({ reg: ['regular'], person: ['1s', '2s'] }))), ['a']);
});

test('a Dimension listed with no values matches nothing, and an untagged Item never matches', () => {
  const items = [item('a', ['reg:regular']), { id: 'bare' }];
  assert.deepEqual(ids(filterPool(items, withInclude({}))), ['a', 'bare']);
  assert.deepEqual(ids(filterPool(items, withInclude({ reg: [] }))), [], 'None really is an empty pool');
  assert.deepEqual(ids(filterPool(items, withInclude({ reg: ['regular'] }))), ['a']);
  assert.deepEqual(ids(filterPool(items, withInclude({ reg: ['spelling'] }))), []);
});

test('filtering never rewrites an Item and never returns the caller\'s array', () => {
  const weird = { id: 'x', tags: ['reg:regular'], answer: 42, nested: { keep: true } };
  const items = [weird];

  const all = filterPool(items, withInclude({}));
  assert.notEqual(all, items, 'a fresh array, so a Game cannot mutate the caller\'s list');
  assert.equal(all[0], weird, 'the same Item object, untouched');
  assert.equal(filterPool(items, withInclude({ reg: ['regular'] }))[0], weird);
});

// ------------------------------------------------------------- presets and settings
test('a first visit selects every declared value and every control default', () => {
  assert.deepEqual(defaultSettings(fixtureGame), {
    preset: null,
    include: { reg: ['regular', 'spelling', 'irregular'], person: ['1s', '2s'] },
    controls: { count: 10 },
  });
  assert.deepEqual(
    defaultSettings(noopGame),
    { preset: null, include: {}, controls: {} },
    'a Game declaring nothing gets a usable, empty settings object',
  );
});

test('choosing a preset copies its include map and records its id', () => {
  const chosen = presetSettings(fixtureGame, 'a1', { ...defaultSettings(fixtureGame), controls: { count: 20 } });
  assert.deepEqual(chosen, { preset: 'a1', include: { reg: ['regular', 'spelling'] }, controls: { count: 20 } });

  chosen.include.reg.push('irregular');
  assert.deepEqual(fixtureGame.presets[0].include.reg, ['regular', 'spelling'], 'the declaration is not aliased');

  assert.deepEqual(presetSettings(fixtureGame, 'a1').controls, { count: 10 }, 'control defaults survive');
  assert.throws(() => presetSettings(fixtureGame, 'nope'), /declares no preset "nope"/);
});

test('a chosen preset produces the documented pool', () => {
  const items = [
    item('a', ['reg:regular', 'person:1s']),
    item('b', ['reg:spelling', 'person:2s']),
    item('c', ['reg:irregular', 'person:1s']),
  ];
  assert.deepEqual(ids(filterPool(items, presetSettings(fixtureGame, 'a1'))), ['a', 'b']);
  assert.deepEqual(ids(filterPool(items, defaultSettings(fixtureGame))), ['a', 'b', 'c']);
});

// ------------------------------------------------------------- content mapping
test('content is fetched from the declared path, resolved against the site root', async () => {
  const backend = fakeFetch({ 'http://example.test/giocco/content/verbi-presente.json': [{ id: 'v-1' }] });
  const game = { ...noopGame, content: './content/verbi-presente.json' };

  const content = await loadContent(game, { base: 'http://example.test/giocco/', fetch: backend.fetch });

  assert.deepEqual(content, [{ id: 'v-1' }]);
  assert.deepEqual(backend.calls, ['http://example.test/giocco/content/verbi-presente.json']);
});

test('a content map is handed to the Game under its own keys, in declaration order', async () => {
  const backend = fakeFetch({
    'http://example.test/giocco/content/a.json': [{ id: 'a' }],
    'http://example.test/giocco/content/b.json': [],
  });
  const game = { ...noopGame, content: { words: './content/a.json', boards: './content/b.json' } };

  const content = await loadContent(game, { base: 'http://example.test/giocco/', fetch: backend.fetch });

  assert.deepEqual(content, { words: [{ id: 'a' }], boards: [] });
  assert.deepEqual(backend.calls, [
    'http://example.test/giocco/content/a.json',
    'http://example.test/giocco/content/b.json',
  ]);
});

test('a Game declaring no content fetches nothing and gets null', async () => {
  const backend = fakeFetch({});
  assert.equal(await loadContent(noopGame, { base: 'http://example.test/', fetch: backend.fetch }), null);
  assert.deepEqual(backend.calls, []);
});

test('a failed content fetch is a loud error, not a silent empty pool', async () => {
  const backend = fakeFetch({});
  const game = { ...noopGame, content: './content/missing.json' };
  await assert.rejects(
    loadContent(game, { base: 'http://example.test/giocco/', fetch: backend.fetch }),
    /could not load \.\/content\/missing\.json \(404\)/,
  );
});

// ------------------------------------------------------------- the Session contract
test('the Session handed to play() has exactly the five documented properties', () => {
  const content = [{ id: 'a', tags: ['reg:regular'] }, { id: 'b', tags: ['reg:irregular'] }];
  const store = { items: {} };
  const rng = createRng(1);

  const session = createSession(fixtureGame, {
    content,
    settings: presetSettings(fixtureGame, 'a1'),
    store,
    rng,
  });

  assert.deepEqual(Object.keys(session), ['pool', 'content', 'settings', 'rng', 'store']);
  assert.deepEqual(ids(session.pool), ['a'], 'the Pool arrives already filtered');
  assert.equal(session.content, content, 'content is passed through untouched');
  assert.equal(session.settings.preset, 'a1');
  assert.equal(session.rng, rng, 'the injected RNG is the Session\'s RNG');
  assert.equal(session.store, store, 'the Game\'s own store object, by identity');

  for (const banned of ['record', 'award', 'score', 'progress', 'finish', 'chrome', 'save']) {
    assert.equal(banned in session, false, `the Session offers no ${banned}()`);
  }
});

test('a Session built from nothing but a Game is still the five-property object', () => {
  const session = createSession(fixtureGame);
  assert.deepEqual(Object.keys(session), ['pool', 'content', 'settings', 'rng', 'store']);
  assert.deepEqual(session.pool, [], 'no content is an empty pool, which is a legal round for a Game with no content');
  assert.equal(session.content, null);
  assert.deepEqual(session.settings, defaultSettings(fixtureGame));
  assert.equal(typeof session.rng, 'function');
  assert.equal(session.store, null);
});

// ------------------------------------------------------------- content and the pool source
test('the pool source is every array file a Game declared, concatenated in declaration order', () => {
  assert.deepEqual(ids(itemsOf([{ id: 'a' }])), ['a'], 'a plain path is the file\'s own array');
  assert.deepEqual(ids(itemsOf({ words: [{ id: 'a' }], boards: [{ id: 'b' }, { id: 'c' }] })), ['a', 'b', 'c']);
  assert.deepEqual(itemsOf(null), []);
  assert.deepEqual(itemsOf(undefined), []);
  assert.deepEqual(itemsOf('./content/x.json'), [], 'a path that was never loaded is no pool');
  assert.deepEqual(itemsOf({ words: { not: 'an array' } }), []);
});

test('the injectable RNG is deterministic per seed and always in range', () => {
  const first = createRng(42);
  const second = createRng(42);
  const a = [first(), first(), first()];
  const b = [second(), second(), second()];
  assert.deepEqual(a, b, 'the same seed is the same sequence');
  assert.ok(a.every((value) => value >= 0 && value < 1));

  const other = createRng(43);
  assert.notDeepEqual(a, [other(), other(), other()]);
  assert.equal(createRng(), Math.random, 'the app gets the real RNG');
  assert.throws(() => createRng(1.5), /integer/);
});

// ------------------------------------------------------------- the hash router

/** `hub` / `settings:verbi-presente` — enough to see which screen rendered. */
const screen = (route) => (route.id === null ? route.name : `${route.name}:${route.id}`);

/** A router over a fake window that records every render and teardown, in order. */
function routerHarness(win, isGame = (id) => id === 'verbi-presente') {
  /** @type {string[]} */
  const log = [];
  const router = createRouter({
    window: win,
    isGame,
    render: (route) => {
      log.push(`render ${screen(route)}`);
      return () => log.push(`teardown ${screen(route)}`);
    },
  });
  return { router, log, renders: () => log.filter((line) => line.startsWith('render')) };
}

test('the router parses exactly the three frozen routes, and nothing else', () => {
  assert.deepEqual(parseRoute('#/'), { name: 'hub', id: null });
  assert.deepEqual(parseRoute(''), { name: 'hub', id: null }, 'no fragment is the hub');
  assert.deepEqual(parseRoute('#'), { name: 'hub', id: null });
  assert.deepEqual(parseRoute(gameHash('verbi-presente')), { name: 'game', id: 'verbi-presente' });
  assert.deepEqual(parseRoute(settingsHash('verbi-presente')), { name: 'settings', id: 'verbi-presente' });

  for (const hash of ['#/nope', '#/g', '#/g/', '#/g//settings', '#/g/x/y', '#/g/x/', '#/g/x/stats', '#/settings', 'nope', '#/g/x/Settings']) {
    assert.equal(parseRoute(hash), null, `${hash} is not a frozen route`);
  }
});

test('a cold Game load redirects to its settings route; unknown ids and routes go to the hub', () => {
  const isGame = (id) => id === 'verbi-presente';

  assert.deepEqual(resolveRoute('#/', { cold: true, isGame }), { route: { name: 'hub', id: null }, redirect: null });
  assert.deepEqual(resolveRoute('#/g/verbi-presente/settings', { cold: true, isGame }), {
    route: { name: 'settings', id: 'verbi-presente' },
    redirect: null,
  });
  assert.deepEqual(resolveRoute('#/g/verbi-presente', { cold: true, isGame }), {
    route: { name: 'settings', id: 'verbi-presente' },
    redirect: '#/g/verbi-presente/settings',
  });
  assert.deepEqual(
    resolveRoute('#/g/verbi-presente', { isGame }),
    { route: { name: 'game', id: 'verbi-presente' }, redirect: null },
    'a warm navigation into a Game route renders the Game',
  );

  for (const hash of ['#/g/nope', '#/g/nope/settings', '#/nope', '#/g/verbi-presente/stats', '#/g/']) {
    assert.deepEqual(resolveRoute(hash, { cold: true, isGame }), {
      route: { name: 'hub', id: null },
      redirect: HUB_HASH,
    }, `${hash} redirects to the hub, cold or warm`);
  }
});

test('a cold Game load replaces the URL and renders settings, once, hashchange included', () => {
  const win = fakeWindow('#/g/verbi-presente', { defer: true });
  const { router, log, renders } = routerHarness(win);

  router.start();
  assert.deepEqual(renders(), ['render settings:verbi-presente'], 'a cold Game URL never renders the Game');
  assert.equal(win.location.hash, '#/g/verbi-presente/settings');
  assert.deepEqual(win.replaceCalls, ['#/g/verbi-presente/settings']);
  assert.deepEqual(win.history(), ['#/g/verbi-presente/settings'], 'replaced, not pushed');

  win.flush(); // the hashchange the browser queues for the redirect
  assert.deepEqual(renders(), ['render settings:verbi-presente'], 'the queued hashchange is not a second render');
  assert.deepEqual(log, ['render settings:verbi-presente'], 'nothing was torn down and re-rendered');
  assert.deepEqual(router.current(), { name: 'settings', id: 'verbi-presente' });
});

test('navigation renders each frozen route once, and an unknown route lands on the hub', () => {
  const win = fakeWindow('#/');
  const { router, renders } = routerHarness(win);

  router.start();
  assert.deepEqual(router.current(), { name: 'hub', id: null });

  router.navigate('#/g/verbi-presente/settings');
  router.navigate('#/g/verbi-presente');
  router.navigate('#/g/verbi-presente');
  router.navigate('#/g/verbi-presente/stats');
  assert.deepEqual(renders(), [
    'render hub',
    'render settings:verbi-presente',
    'render game:verbi-presente',
    'render hub',
  ], 'a repeated hash is not a navigation');

  assert.equal(win.location.hash, HUB_HASH);
  assert.deepEqual(win.replaceCalls, [HUB_HASH], 'only the dead sub-route was replaced');
  assert.deepEqual(router.current(), { name: 'hub', id: null });
});

test('leaving a Game tears its round down, and stop() unhooks the hash and tears the screen down', () => {
  const win = fakeWindow('#/');
  const { router, log } = routerHarness(win);

  router.start();
  router.navigate('#/g/verbi-presente/settings');
  router.navigate('#/g/verbi-presente');
  assert.deepEqual(log, [
    'render hub',
    'teardown hub',
    'render settings:verbi-presente',
    'teardown settings:verbi-presente',
    'render game:verbi-presente',
  ]);

  router.navigate('#/');
  assert.deepEqual(log.slice(5), ['teardown game:verbi-presente', 'render hub'], 'the Game tears down on the way out');

  assert.equal(win.listenerCount(), 1);
  router.stop();
  assert.equal(win.listenerCount(), 0, 'stopped: hash changes are ignored again');
  assert.equal(router.current(), null);
  assert.deepEqual(log.slice(7), ['teardown hub']);
  router.stop();
  assert.deepEqual(log.slice(7), ['teardown hub'], 'stop() is idempotent');

  router.start();
  assert.deepEqual(log.slice(8), ['render hub'], 'a later start() renders the current fragment again');
});

test('browser back and forward re-render through the hash', () => {
  const win = fakeWindow('#/');
  const { router, log } = routerHarness(win, () => true);

  router.start();
  router.navigate('#/g/verbi-presente/settings');
  router.navigate('#/g/verbi-presente');
  win.back(); // a Game is left by going back, and its teardown runs
  win.back();
  win.forward();

  assert.deepEqual(log, [
    'render hub',
    'teardown hub',
    'render settings:verbi-presente',
    'teardown settings:verbi-presente',
    'render game:verbi-presente',
    'teardown game:verbi-presente',
    'render settings:verbi-presente',
    'teardown settings:verbi-presente',
    'render hub',
    'teardown hub',
    'render settings:verbi-presente',
  ]);
  assert.deepEqual(router.current(), { name: 'settings', id: 'verbi-presente' });
});

test('the router resolves ids against the registry by default, and a router needs a renderer', () => {
  for (const id of GAME_IDS) assert.deepEqual(resolveRoute(gameHash(id)).route, { name: 'game', id });
  assert.deepEqual(resolveRoute('#/g/not-a-game').route, { name: 'hub', id: null });
  assert.throws(() => createRouter({}), /render/);
});

// ------------------------------------------------------------- the host screens (js/ui.js)

/**
 * A `document`-shaped fake covering the handful of DOM members `js/ui.js` builds with, so the
 * host screens' *structure* can be checked in Node. It proves what was built and what it links
 * to, never how it looks: layout, focus, safe areas and taps still need the browser. Nodes carry
 * just enough event support (`addEventListener` storing listeners, `fire(type)` calling them) for
 * a case to tap what the screen built, which is how the settings screen's behaviour is covered.
 *
 * @returns {{ createElement: (tag: string) => any }}
 */
function fakeDocument() {
  /** @param {string} tagName */
  const createElement = (tagName) => {
    /** @type {Record<string, Array<(event: unknown) => void>>} */
    const listeners = {};
    const node = {
      tagName: tagName.toUpperCase(),
      className: '',
      children: [],
      attributes: {},
      disabled: false,
      hidden: false,
      _text: '',
      // As in the DOM: assigning text replaces the children it was holding.
      get textContent() {
        return node._text + node.children.map((child) => child.textContent).join('');
      },
      set textContent(value) {
        node._text = String(value);
        node.children.length = 0;
      },
      // Attribute reflection only — a real `a.href` would also resolve to an absolute URL.
      get href() {
        return Object.hasOwn(node.attributes, 'href') ? node.attributes.href : '';
      },
      set href(value) {
        node.attributes.href = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null;
      },
      setAttribute(name, value) {
        node.attributes[name] = String(value);
      },
      removeAttribute(name) {
        delete node.attributes[name];
      },
      addEventListener(type, listener) {
        (listeners[type] ??= []).push(listener);
      },
      removeEventListener(type, listener) {
        listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener);
      },
      /** Tap or otherwise trigger this node in a check. @param {string} type */
      fire(type) {
        for (const listener of [...(listeners[type] ?? [])]) listener({ type, target: node });
      },
      append(...nodes) {
        node.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        node.children.length = 0;
        node.children.push(...nodes);
      },
    };
    return node;
  };
  return { createElement };
}

/** Every node under and including `root`, in document order. @param {any} root */
const nodesOf = (root) => [root, ...root.children.flatMap(nodesOf)];

/** @param {any} root @param {string} className */
const byClass = (root, className) => nodesOf(root).filter((node) => node.className === className);

/** @param {any} root @param {string} tag */
const byTag = (root, tag) => nodesOf(root).filter((node) => node.tagName === tag.toUpperCase());

/** Every node carrying an exact attribute value. @param {any} root @param {string} name @param {string} value */
const byAttr = (root, name, value) => nodesOf(root).filter((node) => node.getAttribute(name) === value);

/** The one declaration block a selector owns in the shipped stylesheet. @param {string} selector */
function cssBlock(selector) {
  const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
  const match = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `${selector} exists in styles.css`);
  return match[1];
}

test('the hub is a wordmark and one card per Game, in registry order, and nothing else', () => {
  const doc = fakeDocument();
  const ui = createUi(doc);
  const root = doc.createElement('div');

  ui.hub(root);

  assert.equal(byClass(root, 'hub').length, 1);
  const wordmarks = byTag(root, 'h1');
  assert.equal(wordmarks.length, 1);
  assert.equal(wordmarks[0].className, 'wordmark');
  assert.equal(wordmarks[0].textContent, 'Giocco');
  assert.equal(wordmarks[0].tagName, 'H1', 'the wordmark is not a link');

  const lists = byClass(root, 'game-list');
  assert.equal(lists.length, 1, 'no Game declares a section yet: one column, one list');
  const cards = byClass(root, 'game-card');
  assert.deepEqual(lists[0].children.map((li) => li.tagName), ['LI', 'LI', 'LI']);
  assert.deepEqual(lists[0].children.map((li) => li.children[0]), cards, 'the card is the only child');

  assert.deepEqual(
    cards.map((card) => card.getAttribute('href')),
    GAME_IDS.map((id) => settingsHash(id)),
    'one card per registered Game, in display order, each opening its settings route',
  );
  assert.deepEqual(
    cards.map((card) => card.textContent),
    GAMES.map((game) => `${game.title}${game.description ?? ''}`),
    'a card shows the title and the optional description, and nothing derived',
  );
  assert.equal(cards[0].tagName, 'A', 'the whole card is the tap target');

  assert.deepEqual(byTag(root, 'button'), [], 'the hub has no button, so no continue action');
  assert.deepEqual(byTag(root, 'input'), [], 'no search');
  assert.doesNotMatch(byClass(root, 'hub')[0].textContent, /\d/, 'the hub shows no count or percentage');
});

test('a Game declaring a section gets a plain heading, and the column stays one column', () => {
  const doc = fakeDocument();
  const ui = createUi(doc);
  const root = doc.createElement('div');
  const games = [
    { id: 'a', title: 'A', play: () => () => {} },
    { id: 'b', title: 'B', play: () => () => {}, section: 'Grammar' },
    { id: 'c', title: 'C', play: () => () => {}, section: 'Grammar' },
    { id: 'd', title: 'D', play: () => () => {}, description: 'D sc', section: 'Vocabulary' },
  ];

  ui.hub(root, games);

  assert.deepEqual(byClass(root, 'section-title').map((h) => h.textContent), ['Grammar', 'Vocabulary']);
  assert.deepEqual(byTag(root, 'h2').map((h) => h.className), ['section-title', 'section-title']);
  assert.equal(byClass(root, 'game-list').length, 3, 'the list breaks only where the heading changes');
  assert.deepEqual(byClass(root, 'game-card').map((card) => card.getAttribute('href')), [
    '#/g/a/settings',
    '#/g/b/settings',
    '#/g/c/settings',
    '#/g/d/settings',
  ]);
});

test('a Game route draws one back control and hands the Game its own node, chrome apart', () => {
  const doc = fakeDocument();
  const ui = createUi(doc);
  const root = doc.createElement('div');
  const game = { id: 'verbi-presente', title: 'Verbi · presente', play: () => () => {} };

  const { playRoot, teardown } = ui.gameScreen(root, game);

  const backs = byClass(root, 'back');
  assert.equal(backs.length, 1, 'the host draws exactly one control');
  assert.equal(backs[0].tagName, 'A');
  assert.equal(backs[0].getAttribute('href'), HUB_HASH, 'the back control always goes to the hub');
  assert.equal(backs[0].textContent, '←Back', 'English chrome');
  assert.deepEqual(byTag(byClass(root, 'host-bar')[0], 'a'), [backs[0]]);
  assert.deepEqual(byTag(root, 'button'), [], 'the chrome is not a button the host would have to wire');

  assert.equal(playRoot.className, 'game');
  assert.equal(playRoot.getAttribute('data-game'), 'verbi-presente');
  assert.deepEqual(byClass(playRoot, 'back'), [], 'the node a Game gets holds no quit control');
  assert.deepEqual(root.children, [byClass(root, 'host-bar')[0], playRoot], 'chrome first, then the Game');

  teardown();
  assert.deepEqual(root.children, [], 'leaving the Game removes the chrome and its node');
});

test('the documented tap-target minimums live in the one stylesheet', () => {
  assert.match(cssBlock('.game-card'), /display:\s*block/);
  assert.match(cssBlock('.game-card'), /width:\s*100%/);
  assert.match(cssBlock('.game-card'), /min-height:\s*64px/);
  assert.match(cssBlock('.back'), /min-width:\s*44px/);
  assert.match(cssBlock('.back'), /min-height:\s*44px/);
});

test('a hub card opens that Game’s settings route, and the back control returns to the hub', () => {
  const doc = fakeDocument();
  const ui = createUi(doc);
  const root = doc.createElement('div');
  const win = fakeWindow(HUB_HASH);
  /** @type {string[]} */
  const log = [];
  const session = { pool: [], content: null, settings: null, rng: Math.random, store: null };

  // The render a boot wires up: this is the composition the router owns — the real hub, the
  // real settings screen, the real Game chrome — over a Game route whose Game does nothing yet.
  const router = createRouter({
    window: win,
    render: (route, host) => {
      if (route.name === 'hub') {
        log.push('hub');
        ui.hub(root);
        return;
      }
      const game = gameById(route.id);
      if (route.name === 'game') {
        log.push(`game:${route.id}`);
        const { playRoot, teardown } = ui.gameScreen(root, game);
        const done = game.play(playRoot, session);
        return () => {
          done();
          teardown();
          log.push(`teardown game:${route.id}`);
        };
      }
      log.push(`settings:${route.id}`);
      const teardown = ui.settingsScreen(root, game, {
        settings: { preset: null, include: {}, controls: {} },
        items: [],
        navigate: host.navigate,
      });
      return () => {
        teardown();
        log.push(`teardown settings:${route.id}`);
      };
    },
  });

  router.start();
  assert.deepEqual(router.current(), { name: 'hub', id: null });

  // A tap on a card is navigation to the href the host put on it — the host pushes no route
  // itself, so the card works before any script runs.
  assert.equal(win.location.hash, HUB_HASH);
  win.location.hash = byClass(root, 'game-card')[0].getAttribute('href');
  assert.deepEqual(router.current(), { name: 'settings', id: 'verbi-presente' });

  router.navigate(gameHash('nomi-plurale')); // `Start round` is US-007's, but it lands here
  assert.deepEqual(router.current(), { name: 'game', id: 'nomi-plurale' });

  win.location.hash = byClass(root, 'back')[0].getAttribute('href');
  assert.equal(win.location.hash, HUB_HASH);
  assert.deepEqual(router.current(), { name: 'hub', id: null }, 'the back control leaves the Game');
  assert.deepEqual(log, [
    'hub',
    'settings:verbi-presente',
    'teardown settings:verbi-presente',
    'game:nomi-plurale',
    'teardown game:nomi-plurale',
    'hub',
  ]);
});

test('the host screens need a document, and the browser path takes none', () => {
  assert.throws(() => createUi(null), /document-like/);
  assert.throws(() => createUi({}), /document-like/);
  const ui = createUi(fakeDocument());
  assert.equal(typeof ui.hub, 'function');
  assert.equal(typeof ui.gameScreen, 'function');
  assert.equal(typeof ui.settingsScreen, 'function');
});

// ------------------------------------------------------------- the settings screen (US-007)

/** A settings-screen fixture: two Dimensions, one Preset, one control — the shipped shape. */
const settingsGame = {
  id: 'verbi-presente',
  title: 'Verbi · presente',
  play: () => () => {},
  dims: [
    { dim: 'reg', values: ['regular', 'spelling', 'irregular'] },
    { dim: 'person', values: ['1s', '2s'] },
  ],
  presets: [{ id: 'a1', label: 'A1 · regolari', include: { reg: ['regular', 'spelling'] } }],
  controls: [{ id: 'count', label: 'Round', options: [5, 10, 20], default: 10 }],
};

/** `n` Items carrying exactly these tags. @param {string} prefix @param {string[]} tags @param {number} n */
function taggedItems(prefix, tags, n) {
  return Array.from({ length: n }, (_, index) => item(`${prefix}-${index}`, tags));
}

/**
 * 26 Items: 6 per regular/spelling × person pair and 2 irregular ones, so `reg:irregular`
 * resolves below the gate's five and every other value clears it.
 */
const settingsItems = [
  ...taggedItems('regular-1s', ['reg:regular', 'person:1s'], 6),
  ...taggedItems('regular-2s', ['reg:regular', 'person:2s'], 6),
  ...taggedItems('spelling-1s', ['reg:spelling', 'person:1s'], 6),
  ...taggedItems('spelling-2s', ['reg:spelling', 'person:2s'], 6),
  ...taggedItems('irregular-1s', ['reg:irregular', 'person:1s'], 2),
];

/**
 * Render the settings screen over a live settings object, and remember where `Start round`
 * would navigate, so a case can tap the built form.
 *
 * @param {{ settings?: any, items?: any[], game?: any }} [options]
 */
function settingsHarness(options = {}) {
  const doc = fakeDocument();
  const ui = createUi(doc);
  const root = doc.createElement('div');
  /** @type {string[]} */
  const log = [];
  const settings = options.settings ?? { preset: null, include: {}, controls: {} };
  const teardown = ui.settingsScreen(root, options.game ?? settingsGame, {
    settings,
    items: options.items ?? settingsItems,
    navigate: (hash) => log.push(hash),
  });
  return { doc, ui, root, settings, log, teardown };
}

/** The value rows, keyed by their declared value. @param {any} root */
function valueRows(root) {
  return new Map(byClass(root, 'value-row').map((row) => [row.getAttribute('data-value'), row]));
}

/** @param {any} row @param {string} className */
const inRow = (row, className) => byClass(row, className)[0];

test('the settings screen is presets, one accordion per Dimension in order, controls, then the footer', () => {
  const { root } = settingsHarness();
  const screen = byClass(root, 'settings')[0];

  assert.deepEqual(
    screen.children.map((node) => node.className),
    ['', 'presets', 'accordion', 'accordion', 'control-row', 'settings-footer'],
    'top to bottom: title, Preset chips, Dimensions in declared order, controls, footer',
  );
  assert.equal(screen.children[0].tagName, 'H1');
  assert.equal(screen.children[0].textContent, 'Verbi · presente');
  assert.equal(screen.getAttribute('data-game'), 'verbi-presente');

  const presetRow = screen.children[1];
  assert.deepEqual(presetRow.children.map((node) => node.textContent), ['A1 · regolari', 'Custom']);
  assert.equal(presetRow.children[0].tagName, 'BUTTON');
  assert.equal(byClass(root, 'chip custom')[0].tagName, 'SPAN', 'Custom is a state, not a choice');

  assert.deepEqual(byClass(root, 'accordion').map((node) => node.getAttribute('data-dim')), ['reg', 'person']);
  assert.deepEqual(
    byClass(root, 'acc-head').map((head) => head.getAttribute('aria-expanded')),
    ['true', 'false'],
    'only the first declared Dimension is open',
  );
  assert.deepEqual(byClass(root, 'acc-body').map((body) => body.hidden), [false, true]);
  assert.deepEqual(
    byClass(root, 'acc-head')[0].children.map((node) => node.textContent),
    ['reg', '3 of 3', '⌄'],
    'header: label, selected of available, chevron',
  );

  assert.deepEqual([...valueRows(root).keys()], ['regular', 'spelling', 'irregular', '1s', '2s']);
  const switches = byClass(root, 'switch');
  assert.equal(switches.length, 5);
  assert.deepEqual(switches.map((sw) => sw.getAttribute('role')), Array(5).fill('switch'));
  assert.deepEqual(switches.map((sw) => sw.getAttribute('aria-label')), ['regular', 'spelling', 'irregular', '1s', '2s']);

  const controlRow = byClass(root, 'control-row')[0];
  assert.equal(controlRow.getAttribute('data-control'), 'count');
  assert.deepEqual(byClass(controlRow, 'controls')[0].children.map((chip) => chip.textContent), ['5', '10', '20']);

  const footer = screen.children[5];
  assert.deepEqual(footer.children.map((node) => node.className), ['eligible', 'start']);
  assert.equal(footer.children[1].textContent, 'Start round');
  assert.equal(footer.children[1].tagName, 'BUTTON');

  assert.deepEqual(byTag(root, 'input'), [], 'no text input');
  assert.deepEqual(byTag(root, 'select'), [], 'no select, so no ordering UI');
  assert.deepEqual(byClass(root, 'control-row').map((row) => row.getAttribute('data-control')), ['count']);
});

test('a first visit selects every value, no preset, and every control default — persisted', () => {
  const settings = { preset: null, include: {}, controls: {} };
  const { root } = settingsHarness({ settings });

  assert.deepEqual(settings, {
    preset: null,
    include: { reg: ['regular', 'spelling', 'irregular'], person: ['1s', '2s'] },
    controls: { count: 10 },
  }, 'the usable whole-content pool is written into the persisted settings object');
  assert.equal(byClass(root, 'chip custom')[0].hidden, false, 'Custom shows while no Preset is chosen');
  assert.equal(byClass(root, 'eligible')[0].textContent, '26 eligible items');
  assert.equal(byClass(root, 'start')[0].disabled, false);
  assert.deepEqual(
    byClass(root, 'switch').map((sw) => sw.getAttribute('aria-checked')),
    ['true', 'true', 'true', 'true', 'true'],
  );
});

test('each badge is what that value alone would add, and a thin value is flagged, not hidden', () => {
  const { root } = settingsHarness();
  const rows = valueRows(root);

  assert.deepEqual(
    [...rows].map(([value, row]) => [value, inRow(row, 'badge').textContent]),
    [
      ['regular', '12'],
      ['spelling', '12'],
      ['irregular', '2'],
      ['1s', '14'],
      ['2s', '12'],
    ],
    'the count is "if this value were on, given everything else currently selected"',
  );

  const thin = rows.get('irregular');
  assert.equal(thin.getAttribute('aria-disabled'), 'true');
  assert.equal(inRow(thin, 'sub').textContent, 'needs 5+ items');
  assert.equal(thin.getAttribute('aria-disabled'), 'true', 'the row is dimmed through CSS');
  assert.equal(inRow(rows.get('regular'), 'sub').textContent, '', 'a healthy value has no sub-line');
  assert.equal(rows.get('regular').getAttribute('aria-disabled'), 'false');
});

test('a Preset chip copies its include map, records its id, and hides Custom', () => {
  const settings = { preset: null, include: { reg: [], person: [] }, controls: { count: 20 } };
  const { root } = settingsHarness({ settings });
  const chip = byClass(root, 'presets')[0].children[0];

  chip.fire('click');

  assert.deepEqual(settings, {
    preset: 'a1',
    include: { reg: ['regular', 'spelling'] },
    controls: { count: 20 },
  }, 'the declaration is copied out, and the chosen control survives');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(byClass(root, 'chip custom')[0].hidden, true);
  assert.equal(byClass(root, 'eligible')[0].textContent, '24 eligible items');
  assert.equal(
    byClass(root, 'acc-head')[1].children[1].textContent,
    '2 of 2',
    'a Dimension the Preset does not mention is unconstrained, so the form shows it all-on',
  );
  assert.equal(inRow(valueRows(root).get('1s'), 'badge').textContent, '12');
});

test('a manual change — a switch, All or None — clears the Preset and recomputes the whole form', () => {
  const settings = { preset: 'a1', include: { reg: ['regular', 'spelling'] }, controls: { count: 10 } };
  const { root } = settingsHarness({ settings });
  const rows = valueRows(root);

  inRow(rows.get('2s'), 'switch').fire('click');
  assert.equal(settings.preset, null, 'a manual change always means Custom');
  assert.deepEqual(settings.include.person, ['1s']);
  assert.equal(byClass(root, 'chip custom')[0].hidden, false);
  assert.equal(byClass(root, 'acc-head')[1].children[1].textContent, '1 of 2');
  assert.equal(inRow(rows.get('regular'), 'badge').textContent, '6', 'the badges were recomputed');
  assert.equal(byClass(root, 'eligible')[0].textContent, '12 eligible items');

  const [all, none] = byClass(byAttr(root, 'data-dim', 'reg')[0], 'text-btn');
  assert.deepEqual([all.textContent, none.textContent], ['All', 'None']);

  // Nothing manual keeps a Preset, All and None included — not just the switches.
  byClass(root, 'presets')[0].children[0].fire('click');
  assert.equal(settings.preset, 'a1');
  all.fire('click');
  assert.equal(settings.preset, null, 'All is a manual change too');
  assert.deepEqual(settings.include.reg, ['regular', 'spelling', 'irregular']);
  assert.equal(byClass(root, 'chip custom')[0].hidden, false);
  assert.equal(byClass(root, 'eligible')[0].textContent, '26 eligible items');

  none.fire('click');
  assert.deepEqual(settings.include.reg, []);
  assert.equal(byClass(root, 'eligible')[0].textContent, 'no items match these filters');
  assert.equal(byClass(root, 'start')[0].disabled, true, 'None is an empty pool, and Start says so');

  all.fire('click');
  assert.deepEqual(settings.include.reg, ['regular', 'spelling', 'irregular']);
  assert.equal(byClass(root, 'eligible')[0].textContent, '26 eligible items');
  assert.equal(byClass(root, 'start')[0].disabled, false);
});

test('a declared control chip persists its value and clears the Preset', () => {
  const settings = { preset: 'a1', include: { reg: ['regular', 'spelling'] }, controls: { count: 10 } };
  const { root } = settingsHarness({ settings });
  const chips = byClass(root, 'controls')[0].children;

  assert.deepEqual(chips.map((chip) => chip.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  chips[2].fire('click');
  assert.equal(settings.controls.count, 20);
  assert.equal(settings.preset, null);
  assert.deepEqual(chips.map((chip) => chip.getAttribute('aria-pressed')), ['false', 'false', 'true']);
});

test('an empty pool says exactly so and disables Start round', () => {
  const { root, log } = settingsHarness({
    settings: { preset: null, include: { reg: [], person: [] }, controls: {} },
  });
  const eligible = byClass(root, 'eligible')[0];
  const start = byClass(root, 'start')[0];

  assert.equal(eligible.textContent, 'no items match these filters');
  assert.equal(start.disabled, true);
  start.fire('click');
  assert.deepEqual(log, [], 'a disabled Start round cannot enter the Game route');
});

test('Start round is the only control that enters the Game route', () => {
  const { root, log } = settingsHarness();

  byClass(root, 'presets')[0].children[0].fire('click');
  byClass(root, 'switch')[0].fire('click');
  byClass(root, 'acc-head')[0].fire('click');
  byClass(root, 'controls')[0].children[0].fire('click');
  assert.deepEqual(log, [], 'no other control leaves the settings screen');

  byClass(root, 'start')[0].fire('click');
  assert.deepEqual(log, [gameHash('verbi-presente')]);
});

test('Start round on the settings route enters the Game route through the router', () => {
  const doc = fakeDocument();
  const ui = createUi(doc);
  const root = doc.createElement('div');
  const win = fakeWindow(HUB_HASH);
  /** @type {string[]} */
  const log = [];
  const settings = { preset: null, include: {}, controls: {} };

  const router = createRouter({
    window: win,
    render: (route, host) => {
      const game = gameById(route.id);
      if (route.name === 'hub') {
        log.push('hub');
        ui.hub(root);
        return;
      }
      if (route.name === 'game') {
        log.push(`game:${route.id}`);
        const { playRoot, teardown } = ui.gameScreen(root, game);
        const done = game.play(playRoot, { pool: [], content: null, settings, rng: Math.random, store: null });
        return () => {
          done();
          teardown();
          log.push(`teardown game:${route.id}`);
        };
      }
      log.push(`settings:${route.id}`);
      const teardown = ui.settingsScreen(root, settingsGame, {
        settings,
        items: settingsItems,
        navigate: host.navigate,
      });
      return () => {
        teardown();
        log.push(`teardown settings:${route.id}`);
      };
    },
  });

  router.start();
  win.location.hash = settingsHash('verbi-presente'); // the hub card's own href
  assert.deepEqual(router.current(), { name: 'settings', id: 'verbi-presente' });
  assert.equal(byClass(root, 'eligible')[0].textContent, '26 eligible items');

  byClass(root, 'start')[0].fire('click');
  assert.equal(win.location.hash, gameHash('verbi-presente'), 'Start round is the only way in');
  assert.deepEqual(router.current(), { name: 'game', id: 'verbi-presente' });
  assert.deepEqual(log, [
    'hub',
    'settings:verbi-presente',
    'teardown settings:verbi-presente',
    'game:verbi-presente',
  ]);
});

test('a saved settings object is completed against the declaration, and a dead Preset is dropped', () => {
  const settings = { preset: 'gone', include: { reg: ['spelling'] }, controls: { count: 7 } };
  const { root, teardown } = settingsHarness({ settings });

  assert.deepEqual(settings, {
    preset: null,
    include: { reg: ['spelling'], person: ['1s', '2s'] },
    controls: { count: 10 },
  });
  assert.equal(byClass(root, 'chip custom')[0].hidden, false);

  teardown();
  assert.deepEqual(root.children, [], 'leaving the screen removes it');
});

test('a Game that declares nothing still gets a usable settings screen', () => {
  const { root } = settingsHarness({ game: noopGame, settings: {}, items: [] });

  assert.deepEqual(byClass(root, 'settings')[0].children.map((node) => node.className), ['', 'settings-footer']);
  assert.deepEqual(byClass(root, 'presets'), []);
  assert.deepEqual(byClass(root, 'accordion'), []);
  assert.deepEqual(byClass(root, 'control-row'), []);
  assert.equal(byClass(root, 'eligible')[0].textContent, 'no items match these filters');
  assert.equal(byClass(root, 'start')[0].disabled, true);
});

test('the settings screen’s documented sizes live in the one stylesheet', () => {
  assert.match(cssBlock('.chip'), /min-height:\s*40px/);
  assert.match(cssBlock('.acc-head'), /min-height:\s*56px/);
  assert.match(cssBlock('.value-row'), /min-height:\s*48px/);
  assert.match(cssBlock('.start'), /min-height:\s*52px/);
  const footer = cssBlock('.settings-footer');
  assert.match(footer, /position:\s*sticky/);
  assert.match(footer, /env\(safe-area-inset-bottom\)/);
});

test('every registered Game declares the shared round-count control', () => {
  for (const game of GAMES) {
    const controls = game.controls ?? [];
    const count = controls.find((control) => control.id === 'count');
    assert.ok(count, `${game.id} declares a round-count control`);
    assert.deepEqual(count.options, [5, 10, 20], `${game.id} offers 5, 10 and 20`);
    assert.equal(count.default, 10, `${game.id} defaults to 10`);
    assert.equal(typeof count.label, 'string');
  }
});

/** @returns {Promise<boolean>} true when every case passed */
export async function runSanity() {
  let passed = 0;
  const failed = [];
  for (const { name, run } of cases) {
    try {
      await run();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed.push(name);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAIL ${name}\n       ${message.split('\n').join('\n       ')}`);
    }
  }
  console.log(`\nsanity: ${passed}/${cases.length} passed`);
  return failed.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSanity().then((ok) => process.exit(ok ? 0 : 1));
}
