/**
 * Deterministic Node-level sanity checks for the host modules that are pure enough to run
 * without a browser: `js/storage.js`, `js/engine.js`, `js/registry.js`, `js/router.js` today —
 * plus `js/ui.js` against a minimal fake `document`, which checks the screen structure it builds
 * (elements, order, hrefs) and not the layout, focus or taps a browser owns — plus `sw.js`, run in
 * a `node:vm` context over a `CacheStorage` fake so its precache list and its four request
 * strategies are checked without a browser. Run by `npm test` (or `node tools/sanity.mjs`).
 *
 * Dependency-free `node:assert` only — the project ships no test framework. Behaviour that
 * needs a real browser (boot, offline, safe areas, hit targets under a thumb) is verified
 * manually instead; see AGENTS.md.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

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
import {
  CONFIRM_DELAY,
  CORRECT_DELAY,
  MAX_MISSES,
  TAP_GUARD,
  WRONG_DELAY,
  roundLoop,
} from '../js/lib/roundLoop.js';
import { bars, sparkline } from '../js/lib/charts.js';
import verbiPresenteGame, {
  ATTEMPTS_WINDOW,
  DAILY_BUCKETS,
  MASTERED_AT,
  MASTERED_ATTEMPTS,
  POINTS_CORRECT,
  POINTS_RETURN,
  POINTS_WINDOW,
  WEEKLY_SNAPSHOTS,
  epochDay,
  itemWeight,
  masteredOf,
  masteryOf,
  questionFor,
  recordAttempt,
  roundCount,
  roundQueue,
  shuffle,
  statisticsView,
  statsFor,
  weightedQueue,
} from '../js/games/verbi-presente/index.js';
import verbiPresenteRivelaGame, {
  revealQuestion,
} from '../js/games/verbi-presente-rivela/index.js';
import nomiPluraleGame, {
  questionFor as nounQuestionFor,
} from '../js/games/nomi-plurale/index.js';
import { boot } from '../js/app.js';

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

// Two Games share one corpus (`verbi-presente` and its reveal sibling), so the file is gated
// against each declaration separately. Nothing but this case stops the declarations from
// drifting apart, which would fail the structural gate on a file neither Game changed.
test('the two verb Games share one corpus and declare it identically', () => {
  const recognise = gameById('verbi-presente');
  const produce = gameById('verbi-presente-rivela');
  assert.ok(recognise && produce);
  assert.equal(produce.content, recognise.content, 'one file, both declarations');
  assert.deepEqual(produce.fields, recognise.fields);
  assert.deepEqual(produce.dims, recognise.dims);
  assert.deepEqual(produce.presets, recognise.presets);

  const items = JSON.parse(readFileSync(fileURLToPath(new URL('../content/verbi-presente.json', import.meta.url)), 'utf8'));
  assert.equal(items.length, 240, '40 lexemes × six persons');
  for (const item of items) assert.deepEqual(Object.keys(item), recognise.fields, `${item.id} carries exactly the declared fields`);

  // 40 distinct lexemes, six persons each — the shape the ≥5 rule was authored against.
  const lexemes = new Set(items.map((item) => item.id.replace(/^verbi-pres-/, '').replace(/-[0-9][sp]$/, '')));
  assert.equal(lexemes.size, 40);
  for (const lexeme of lexemes) {
    const persons = items.filter((item) => item.id.startsWith(`verbi-pres-${lexeme}-`)).map((item) => item.tags.find((tag) => tag.startsWith('person:')));
    assert.deepEqual([...persons].sort(), ['person:1p', 'person:1s', 'person:2p', 'person:2s', 'person:3p', 'person:3s']);
  }
});

// The noun corpus has one owning Game, so the structural gate already covers its shape and its
// ≥5 rule. This case records the authored *plan* the corpus was sized against and the house rules
// docs/design/content-and-progress.md § C calls out, so a later edit that quietly drops a pattern's
// fifth noun (and then its Dimension value) or loses a documented rule fails here too.
test('the noun Game declares a corpus that fills every declared value', () => {
  const game = gameById('nomi-plurale');
  assert.equal(game.content, './content/nomi-plurale.json');
  assert.deepEqual(game.fields, ['id', 'prompt', 'answer', 'distractors', 'tags']);
  assert.deepEqual(
    game.dims.map((entry) => entry.dim),
    ['gender', 'plural', 'irreg', 'cefr'],
    'the documented Dimension order, no m/f or a2 value advertised before its nouns exist',
  );
  assert.deepEqual(game.presets, [
    { id: 'a1', label: 'A1 - tutto', include: { cefr: ['a1'] } },
    { id: 'plurali-regolari', label: 'Plurali regolari', include: { irreg: ['none'] } },
    { id: 'plurali-irregolari', label: 'Plurali irregolari', include: { irreg: ['plural', 'gender-change'] } },
  ]);

  const items = JSON.parse(readFileSync(fileURLToPath(new URL('../content/nomi-plurale.json', import.meta.url)), 'utf8'));
  assert.equal(items.length, 130, 'thirteen plural patterns × ten nouns');
  for (const noun of items) assert.deepEqual(Object.keys(noun), game.fields, `${noun.id} carries exactly the declared fields`);
  assert.equal(new Set(items.map((noun) => noun.id)).size, items.length, 'ids are unique');
  assert.equal(new Set(items.map((noun) => noun.prompt)).size, items.length, 'no two Items share a prompt');

  const count = (/** @type {string} */ tag) => items.filter((noun) => noun.tags.includes(tag)).length;
  for (const { dim, values } of game.dims) {
    for (const value of values) assert.ok(count(`${dim}:${value}`) >= 5, `${dim}:${value} ships at least five Items`);
  }

  // Each plural pattern is one hand-authored group of ten: the corpus is sized by the rule, not
  // padded until the gate stops complaining.
  const patterns = /** @type {any} */ (game.dims.find((entry) => entry.dim === 'plural')).values;
  assert.equal(patterns.length, 13);
  for (const pattern of patterns) assert.equal(count(`plural:${pattern}`), 10, `plural:${pattern} is ten nouns`);

  // The two irregular presets are the split the corpus is built on: 90 regular, 40 irregular.
  assert.equal(count('irreg:none'), 90);
  assert.equal(count('irreg:plural') + count('irreg:gender-change'), 40);
  assert.equal(count('cefr:a1'), items.length, 'cefr:a1 is the only CEFR value authored');

  // The house rules § C asks for, each with the nouns it names: hard `-co/-go` (`alberghi`) next
  // to the sound shift (`amici`), the kept and dropped `i` (`camicie` / `arance`), the invariants
  // (`città`), and the gender-changing plurals (`uova`).
  const answerOf = (/** @type {string} */ id) => /** @type {any} */ (items.find((noun) => noun.id === id)).answer;
  assert.equal(answerOf('nomi-pl-albergo'), 'alberghi');
  assert.equal(answerOf('nomi-pl-amico'), 'amici');
  assert.equal(answerOf('nomi-pl-camicia'), 'camicie');
  assert.equal(answerOf('nomi-pl-arancia'), 'arance');
  assert.equal(answerOf('nomi-pl-citta'), 'città');
  assert.equal(answerOf('nomi-pl-uovo'), 'uova');
  assert.equal(answerOf('nomi-pl-mano'), 'mani', 'a feminine -o noun: la mano → le mani');
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
      // A chart is the one thing a Game writes as a string (`js/lib/charts.js`), and the fake does
      // not parse markup: it records what was assigned, so a case asserts exactly the string a
      // chart helper returned, and `assertSilent()`/`assertWellFormedSvg()` can read it.
      get innerHTML() {
        return node._html ?? '';
      },
      set innerHTML(value) {
        node._html = String(value);
        node._text = '';
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
      // Recorded, not performed: "every ask re-focuses the prompt with preventScroll" is a
      // claim about calls, and a fake that silently swallowed them could not check it.
      focus(options) {
        node.focusCalls = (node.focusCalls ?? 0) + 1;
        node.focusedWith = options;
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

/**
 * Run `fn` with the fake document installed as the global one. A real Game's `play()` reaches
 * `roundLoop()` without a document, exactly as it does in the browser, so this is the seam that
 * lets a case drive a round the way the app does; the global is restored either way.
 * @template T @param {(doc: any) => T} fn
 * @returns {T}
 */
function withFakeDocument(fn) {
  const previous = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    return fn(globalThis.document);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

/**
 * Run `fn` with `setTimeout`/`clearTimeout` replaced by a controllable clock: a real Game's
 * `play()` reaches `roundLoop()` with no injections, so this is how a case walks a whole round —
 * and its 700/1400/250 ms delays — by ticking the clock itself. Only the timers are faked: `now`
 * stays the real clock, so a record written during the round is stamped with today.
 * @template T @param {(clock: ReturnType<typeof fakeClock>) => T} fn
 * @returns {T}
 */
function withFakeTimers(fn) {
  const clock = fakeClock();
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  try {
    return fn(clock);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    // A pending fake timer is the suite's own version of a leaked handle: the Game's teardown has
    // to have cleared it, which is what the real browser and the real suite depend on.
    assert.equal(clock.pending(), 0, `${clock.pending()} timer(s) left scheduled when the case ended`);
  }
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
  // real settings screen, the real Game chrome — with the real noun Game playing its round.
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

  // `nomi-plurale` plays a real round now, and a Game's `play()` has nowhere to inject a
  // `document`, so the loop reaches for the global one: this step installs the fake for it.
  withFakeDocument(() => {
    router.navigate(gameHash('nomi-plurale')); // `Start round` is US-007's, but it lands here
    assert.deepEqual(router.current(), { name: 'game', id: 'nomi-plurale' });
  });

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
  // The Game route below runs the real registered Game, whose round needs the global document.
  withFakeDocument(() => {
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

// ------------------------------------------------------------- boot (js/app.js)

/** The deployed shape: a project subpath, so a relative content path has to resolve under it. */
const SITE_BASE = 'http://site.test/giocco/';

/**
 * A content-bearing fixture Game. `play` records the Session it is handed and returns a
 * teardown, the way a real drill will.
 * @param {string} id
 * @param {string | Record<string, string>} content
 * @param {string[]} log
 */
function bootGame(id, content, log) {
  return {
    id,
    title: `Game ${id}`,
    description: `${id} description`,
    content,
    dims: [{ dim: 'a', values: ['x', 'y'] }],
    controls: [{ id: 'count', label: 'Round', options: [5, 10, 20], default: 10 }],
    play(root, session) {
      log.push(`play:${id}`);
      log.push(`keys:${Object.keys(session).sort().join(',')}`);
      log.push(`pool:${session.pool.map((entry) => entry.id).sort().join(',')}`);
      root.textContent = id;
      return () => log.push(`teardown:${id}`);
    },
  };
}

/** Boot's own harness: a fake document, a fake window and a fetch recording both URL and order. */
function bootHarness({ hash = HUB_HASH, games, routes = {}, base = SITE_BASE } = {}) {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  const win = fakeWindow(hash);
  const { fetch, calls } = fakeFetch(routes);
  /** The root's child count at each fetch, which is how "content before render" is proven. */
  const during = [];
  const spy = async (/** @type {string} */ url) => {
    during.push(root.children.length);
    return fetch(url);
  };
  return { doc, root, win, fetch: spy, calls, during, games, base };
}

test('boot fetches every registered Game’s content, in declaration order, before it renders', async () => {
  const log = [];
  const harness = bootHarness({
    games: [
      bootGame('one', './content/one.json', log),
      bootGame('two', { words: './content/two-words.json', boards: './content/two-boards.json' }, log),
    ],
    routes: {
      [`${SITE_BASE}content/one.json`]: [item('one-1', ['a:x'])],
      [`${SITE_BASE}content/two-words.json`]: [item('two-1', ['a:x'])],
      [`${SITE_BASE}content/two-boards.json`]: [item('two-2', ['a:y'])],
    },
  });

  const app = await boot({
    document: harness.doc,
    window: harness.win,
    root: harness.root,
    storage: createStorage(fakeBackend()),
    games: harness.games,
    fetch: harness.fetch,
    base: harness.base,
  });

  assert.deepEqual(
    harness.calls,
    [
      `${SITE_BASE}content/one.json`,
      `${SITE_BASE}content/two-words.json`,
      `${SITE_BASE}content/two-boards.json`,
    ],
    'every declared file, keyed map included, in declaration order',
  );
  assert.deepEqual(harness.during, [0, 0, 0], 'nothing renders while content is still loading');
  assert.deepEqual(Object.keys(app.content), ['one', 'two']);
  assert.deepEqual(app.content.two, {
    words: [item('two-1', ['a:x'])],
    boards: [item('two-2', ['a:y'])],
  });
  assert.deepEqual(app.router.current(), { name: 'hub', id: null }, 'the hub renders after content');
  assert.equal(byClass(harness.root, 'hub').length, 1);
  assert.deepEqual(log, [], 'no Game ran a round just because boot loaded its content');
});

test('a cold Game URL boots onto that Game’s settings screen with the loaded content', async () => {
  const log = [];
  const harness = bootHarness({
    hash: gameHash('one'),
    games: [bootGame('one', './content/one.json', log)],
    routes: { [`${SITE_BASE}content/one.json`]: [item('one-1', ['a:x']), item('one-2', ['a:y'])] },
  });

  const app = await boot({
    document: harness.doc,
    window: harness.win,
    root: harness.root,
    storage: createStorage(fakeBackend()),
    games: harness.games,
    fetch: harness.fetch,
    base: harness.base,
  });

  assert.deepEqual(app.router.current(), { name: 'settings', id: 'one' });
  assert.equal(harness.win.location.hash, settingsHash('one'), 'a cold round URL is replaced');
  assert.equal(harness.win.replaceCalls.length, 1);
  assert.deepEqual(byTag(harness.root, 'h1').map((node) => node.textContent), ['Game one']);
  assert.equal(
    byClass(harness.root, 'eligible')[0].textContent,
    '2 eligible items',
    'the settings screen counts the Items boot loaded',
  );
  assert.deepEqual(log, [], 'a cold Game load never starts a round');
});

test('a Game route gets the five-property Session, and leaving it tears the round down', async () => {
  const log = [];
  /** The Session the Game's `play()` was handed, captured for the persistence check. @type {any} */
  let session = null;
  const game = {
    id: 'one',
    title: 'Game one',
    content: './content/one.json',
    dims: [{ dim: 'a', values: ['x', 'y'] }],
    controls: [{ id: 'count', label: 'Round', options: [5, 10, 20], default: 10 }],
    play(root, handed) {
      log.push('play:one');
      log.push(`keys:${Object.keys(handed).sort().join(',')}`);
      log.push(`pool:${handed.pool.map((entry) => entry.id).sort().join(',')}`);
      session = handed;
      return () => log.push('teardown:one');
    },
  };
  const backend = fakeBackend();
  const harness = bootHarness({
    hash: settingsHash('one'), // Start round is the only way in, so the settings route comes first
    games: [game],
    routes: { [`${SITE_BASE}content/one.json`]: [item('one-1', ['a:x']), item('one-2', ['a:y'])] },
  });

  const app = await boot({
    document: harness.doc,
    window: harness.win,
    root: harness.root,
    storage: createStorage(backend),
    games: harness.games,
    fetch: harness.fetch,
    base: harness.base,
  });

  assert.equal(
    byClass(harness.root, 'eligible')[0].textContent,
    '2 eligible items',
    'the settings route counted the Items boot loaded',
  );

  harness.win.location.hash = gameHash('one');
  assert.deepEqual(app.router.current(), { name: 'game', id: 'one' });
  assert.deepEqual(log, ['play:one', 'keys:content,pool,rng,settings,store', 'pool:one-1,one-2']);
  assert.equal(byClass(harness.root, 'game')[0].getAttribute('data-game'), 'one');
  assert.equal(byClass(harness.root, 'back')[0].getAttribute('href'), HUB_HASH);
  assert.equal(harness.calls.length, 1, 'content is fetched at boot, never on the Game visit');

  // Both slices are live, so a Game's write lands in localStorage on the spot and no host API
  // is needed for it — the same storage rule the host modules already follow.
  session.store.last = 3;
  session.settings.controls.count = 20;
  const envelope = backend.envelope();
  assert.equal(envelope.v, VERSION);
  assert.deepEqual(envelope.data.games.one, {
    settings: { preset: null, include: { a: ['x', 'y'] }, controls: { count: 20 } },
    store: { last: 3 },
  });

  harness.win.location.hash = HUB_HASH; // the host back control's own href
  assert.deepEqual(log.slice(3), ['teardown:one'], 'leaving the Game runs its teardown');
  assert.equal(byClass(harness.root, 'hub').length, 1);
});

test('boot fails loudly without a document or the #app root node', async () => {
  await assert.rejects(() => boot({ document: undefined }), /document is required/);
  await assert.rejects(
    () => boot({ document: { createElement: () => ({}), getElementById: () => null } }),
    /#app root node/,
  );
});

test('boot registers ./sw.js with updateViaCache: none before it fetches anything', async () => {
  const log = [];
  const harness = bootHarness({
    games: [bootGame('one', './content/one.json', [])],
    routes: { [`${SITE_BASE}content/one.json`]: [item('one-1', ['a:x'])] },
  });

  const app = await boot({
    document: harness.doc,
    window: harness.win,
    root: harness.root,
    storage: createStorage(fakeBackend()),
    games: harness.games,
    fetch: async (/** @type {string} */ url) => {
      log.push(`fetch:${url}`);
      return harness.fetch(url);
    },
    base: harness.base,
    // Never settles: boot resolving at all is the proof that registration is fire-and-forget.
    serviceWorker: {
      register(url, options) {
        log.push(`register:${url}:${JSON.stringify(options)}`);
        return new Promise(() => {});
      },
    },
  });

  assert.equal(log[0], 'register:./sw.js:{"updateViaCache":"none"}');
  assert.equal(log.filter((entry) => entry.startsWith('register:')).length, 1, 'registered once');
  assert.ok(
    log.slice(1).every((entry) => entry.startsWith('fetch:')),
    'the shell cache fills while the content loads',
  );
  assert.deepEqual(app.router.current(), { name: 'hub', id: null });
});

test('boot starts without a service worker, and a refused registration is only a warning', async () => {
  const warnings = [];
  const { warn } = console;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // An insecure context (`file://`, a plain-`http` LAN address) has no container at all.
    const bare = bootHarness({ games: [], routes: {} });
    const without = await boot({
      document: bare.doc,
      window: bare.win,
      root: bare.root,
      storage: createStorage(fakeBackend()),
      games: [],
      fetch: bare.fetch,
      base: bare.base,
      serviceWorker: null,
    });
    assert.deepEqual(without.router.current(), { name: 'hub', id: null });

    const refused = bootHarness({ games: [], routes: {} });
    const app = await boot({
      document: refused.doc,
      window: refused.win,
      root: refused.root,
      storage: createStorage(fakeBackend()),
      games: [],
      fetch: refused.fetch,
      base: refused.base,
      serviceWorker: { register: () => Promise.reject(new Error('insecure context')) },
    });
    assert.deepEqual(app.router.current(), { name: 'hub', id: null }, 'the app still started');
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      warnings.some((line) => /service worker did not register/.test(line)),
      'a refused registration is a warning, not a failed boot',
    );
  } finally {
    console.warn = warn;
  }
});

// ------------------------------------------------------------- the round loop (js/lib/roundLoop.js)

/** One four-option question, the way a choice Game builds it. @param {number} n */
const choiceQuestion = (n) => ({
  prompt: `prompt ${n}`,
  answer: `answer ${n}`,
  options: [`wrong a ${n}`, `answer ${n}`, `wrong b ${n}`, `wrong c ${n}`],
});

/**
 * The round loop's delays, made deterministic: a controllable clock and a queue of timers, so a
 * case asserts the exact 700 / 1400 / 250 ms and fires only what the loop actually scheduled.
 */
function fakeClock() {
  let id = 0;
  let time = 0;
  /** @type {Map<number, { fn: () => void, ms: number, at: number }>} */
  const timers = new Map();
  return {
    now: () => time,
    /** Move the clock by `ms` and run every timer that is now due. */
    /** @param {number} ms */
    tick(ms) {
      time += ms;
      for (const [key, entry] of [...timers]) {
        if (entry.at <= time) {
          timers.delete(key);
          entry.fn();
        }
      }
    },
    /** @param {() => void} fn @param {number} ms */
    setTimeout: (fn, ms) => {
      id += 1;
      timers.set(id, { fn, ms, at: time + ms });
      return id;
    },
    /** @param {number} key */
    clearTimeout: (key) => {
      timers.delete(key);
    },
    delays: () => [...timers.values()].map((entry) => entry.ms),
    pending: () => timers.size,
  };
}

/**
 * A real `roundLoop()` over the fake document, the fake clock and a state log — the seam that
 * makes the cycle's DOM, its counters and its three timings checkable in Node. A Game's own
 * answers/actions are passed through `extra`.
 *
 * @param {{
 *   mode?: 'choice' | 'reveal',
 *   queue?: Array<{ prompt: string, answer: string, options?: string[] }>,
 *   extra?: Record<string, unknown>,
 * }} [options]
 */
function roundHarness(options = {}) {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  const clock = fakeClock();
  /** @type {string[]} */
  const states = [];
  /** @type {Array<{ prompt: string, correct: boolean }>} */
  const answers = [];
  /** @type {Array<Array<{ prompt: string, answer: string, options?: string[] }>>} */
  const draws = [];
  const loop = roundLoop(root, {
    mode: options.mode ?? 'choice',
    // A fresh array of fresh questions every draw: "Play again samples a new queue" is then
    // something a case can see rather than assume.
    sample: () => {
      const queue = (options.queue ?? []).map((question) => ({ ...question }));
      draws.push(queue);
      return queue;
    },
    document: doc,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    onState: (state) => states.push(state),
    onAnswer: (question, correct) => {
      answers.push({ prompt: question.prompt, correct });
      return correct ? 10 : 0;
    },
    ...(options.extra ?? {}),
  });
  return { doc, root, clock, states, answers, draws, loop, section: loop.section };
}

/** The loop's live nodes, in one place. @param {any} root */
function roundNodes(root) {
  const section = byClass(root, 'round')[0];
  const bar = section.children[0];
  const summary = section.children[5];
  return {
    section,
    bar,
    meter: bar.children[0].children[0],
    ordinal: bar.children[1],
    prompt: section.children[1],
    status: section.children[2],
    options: section.children[3],
    buttons: nodesOf(section).filter(
      (node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'),
    ),
    actions: section.children[4],
    summary,
    score: byClass(summary, 'score')[0],
    points: byClass(summary, 'points')[0],
    misses: byClass(summary, 'misses')[0],
    slots: byClass(summary, 'miss'),
    summaryActions: byClass(summary, 'actions')[0],
    playAgain: byClass(summary, 'start')[0],
    grades: nodesOf(section).filter(
      (node) => node.tagName === 'BUTTON' && node.className.startsWith('grade'),
    ),
    done: byTag(summary, 'a')[0],
  };
}

test('the round loop counts against the actual queue length and reuses its one DOM', () => {
  const h = roundHarness({ queue: [1, 2, 3, 4, 5].map(choiceQuestion) });
  const n = roundNodes(h.root);

  assert.equal(h.root.children.length, 1, 'the loop owns one section in the node it was handed');
  assert.equal(n.section.getAttribute('data-state'), 'ask');
  assert.equal(n.section.getAttribute('aria-labelledby'), 'prompt');
  assert.equal(n.ordinal.textContent, '1/5');
  assert.equal(n.meter.getAttribute('style'), 'width:20%');
  assert.equal(n.prompt.tagName, 'H1');
  assert.equal(n.prompt.tabIndex, -1, 'the prompt is focusable, which is how each ask is announced');
  assert.deepEqual(n.prompt.focusedWith, { preventScroll: true });
  assert.equal(n.status.getAttribute('aria-live'), 'polite');
  assert.equal(n.options.getAttribute('role'), 'group');
  assert.equal(n.options.getAttribute('aria-labelledby'), 'prompt');
  assert.equal(n.buttons.length, 4, 'four option rows exist before the first question is read');
  assert.deepEqual(n.buttons.map((button) => button.textContent), ['wrong a 1', 'answer 1', 'wrong b 1', 'wrong c 1']);
  assert.ok(n.buttons.every((button) => button.tagName === 'BUTTON'));

  n.buttons[1].fire('click');
  h.clock.tick(CORRECT_DELAY);
  const next = roundNodes(h.root);
  assert.equal(next.prompt, n.prompt, 'the prompt node is reused, never re-mounted');
  assert.equal(next.ordinal, n.ordinal);
  assert.deepEqual(next.buttons, n.buttons, 'the option buttons are the same nodes');
  assert.equal(next.prompt.focusCalls, 2, 'each ask re-focuses the prompt');
  assert.equal(h.root.children.length, 1, 'no question ever re-mounts the section');
  assert.equal(next.ordinal.textContent, '2/5', 'the ordinal is the queue position, not a round length wish');
  assert.equal(next.meter.getAttribute('style'), 'width:40%');
  assert.deepEqual(h.states, ['ask', 'feedback', 'advance', 'ask']);
});

test('choice feedback reveals the answer, times the advance and swallows the answering tap', () => {
  const h = roundHarness({ queue: [choiceQuestion(1), choiceQuestion(2)] });
  const n = roundNodes(h.root);

  n.buttons[0].fire('click');
  assert.equal(n.section.getAttribute('data-state'), 'feedback');
  assert.equal(n.status.textContent, 'giusto: answer 1');
  assert.equal(n.buttons[0].className, 'opt wrong');
  assert.equal(n.buttons[1].className, 'opt correct', 'the correct option is always revealed');
  assert.equal(n.buttons[2].className, 'opt');
  assert.deepEqual(h.answers, [{ prompt: 'prompt 1', correct: false }], 'the attempt is recorded at once');
  assert.deepEqual(h.clock.delays(), [WRONG_DELAY]);

  // The answering tap bubbles into the section within the guard and must not advance.
  n.section.fire('click');
  assert.equal(n.section.getAttribute('data-state'), 'feedback');
  h.clock.tick(100);
  n.section.fire('click');
  assert.equal(n.section.getAttribute('data-state'), 'feedback', 'a tap inside the 250 ms guard is ignored');
  h.clock.tick(TAP_GUARD - 100);
  n.section.fire('click');
  assert.equal(n.section.getAttribute('data-state'), 'ask', 'a tap after the guard advances');
  assert.equal(h.clock.pending(), 0, 'advancing cancels the auto-advance it replaced');
  assert.equal(n.prompt.textContent, 'prompt 2');
  assert.equal(n.buttons[0].className, 'opt', 'a new question clears the old marks');
  assert.equal(n.status.textContent, '', 'and the old feedback copy');

  n.buttons[1].fire('click');
  assert.equal(n.status.textContent, 'corretto');
  assert.deepEqual(h.clock.delays(), [CORRECT_DELAY]);
  h.clock.tick(CORRECT_DELAY);

  assert.equal(n.section.getAttribute('data-state'), 'summary');
  assert.equal(n.score.textContent, '1/2', 'the score counts the actual queue');
  assert.equal(n.points.textContent, '+10 pt');
  assert.deepEqual(h.states, ['ask', 'feedback', 'advance', 'ask', 'feedback', 'advance', 'summary']);
});

test('reveal mode offers one Show answer, waits to be graded and never shows red', () => {
  const h = roundHarness({
    mode: 'reveal',
    queue: [
      { prompt: 'cercare · tu · presente', answer: 'cerchi' },
      { prompt: 'cercare · io · presente', answer: 'cerco' },
    ],
  });
  const n = roundNodes(h.root);
  const [showAnswer, gradeRight, gradeWrong] = n.grades;

  assert.equal(n.section.getAttribute('data-state'), 'ask');
  assert.equal(n.options.hidden, true, 'a reveal question has no option buttons to tap');
  assert.equal(n.actions.hidden, false);
  assert.equal(n.grades.length, 3);
  assert.equal(showAnswer.textContent, 'Show answer');
  assert.equal(showAnswer.className, 'grade wide', 'one full-width action');
  assert.equal(showAnswer.hidden, false);
  assert.equal(gradeRight.hidden, true, 'the grades only exist after the reveal');
  assert.equal(gradeWrong.hidden, true);
  assert.equal(h.clock.pending(), 0, 'asking a reveal question schedules nothing');

  showAnswer.fire('click');
  assert.equal(n.section.getAttribute('data-state'), 'selfGrade');
  assert.equal(n.status.textContent, 'cerchi', 'the answer lands in the polite status line, in green');
  assert.equal(gradeRight.hidden, false);
  assert.equal(gradeWrong.hidden, false);
  assert.equal(h.clock.pending(), 0, 'grading is deliberate: no auto-advance');
  assert.equal(byClass(n.section, 'wrong').length, 0);

  gradeWrong.fire('click');
  assert.equal(n.section.getAttribute('data-grade'), 'bad');
  assert.equal(n.status.textContent, 'da rivedere');
  assert.equal(byClass(n.section, 'wrong').length, 0, 'nothing is ever coloured red in reveal mode');
  assert.equal(byClass(n.section, 'grade ok').length, 0);
  assert.deepEqual(h.answers, [{ prompt: 'cercare · tu · presente', correct: false }]);
  assert.deepEqual(h.clock.delays(), [250]);
  h.clock.tick(250);
  assert.equal(n.section.getAttribute('data-state'), 'ask');
  assert.equal(n.prompt.textContent, 'cercare · io · presente');

  showAnswer.fire('click');
  gradeRight.fire('click');
  assert.equal(n.status.textContent, 'corretto');
  assert.equal(gradeRight.getAttribute('aria-pressed'), 'true');
  h.clock.tick(250);
  assert.equal(gradeRight.getAttribute('aria-pressed'), 'false', 'the next question resets the grades');
  assert.equal(gradeWrong.getAttribute('aria-pressed'), 'false');
  assert.equal(n.section.getAttribute('data-state'), 'summary');
  assert.equal(n.score.textContent, '1/2');
  assert.deepEqual(h.states, [
    'ask',
    'selfGrade',
    'advance',
    'ask',
    'selfGrade',
    'advance',
    'summary',
  ]);
});

test('the summary reports the queue, the points and at most three misses, and Play again re-draws', () => {
  const h = roundHarness({ queue: [1, 2, 3, 4, 5].map(choiceQuestion) });
  const n = roundNodes(h.root);

  // Four wrong, then one right: one point total, and the fourth miss is never listed.
  /** @param {number} option */
  const answer = (option) => {
    roundNodes(h.root).buttons[option].fire('click');
    h.clock.tick(WRONG_DELAY);
  };
  [0, 0, 0, 0, 1].forEach(answer);

  assert.equal(n.section.getAttribute('data-state'), 'summary');
  assert.equal(n.score.textContent, '1/5');
  assert.equal(n.points.textContent, '+10 pt');
  assert.equal(n.bar.hidden, true);
  assert.equal(n.prompt.hidden, true);
  assert.equal(n.status.hidden, true);
  assert.equal(n.summary.hidden, false);
  assert.equal(n.slots.length, MAX_MISSES);
  assert.deepEqual(n.slots.map((slot) => slot.textContent), ['prompt 1', 'prompt 2', 'prompt 3']);
  assert.ok(n.slots.every((slot) => slot.hidden === false));
  assert.equal(n.playAgain.textContent, 'Play again');
  assert.equal(n.done.textContent, 'Done');
  assert.equal(n.done.getAttribute('href'), HUB_HASH, 'Done routes to the hub through the router');
  assert.deepEqual(n.summaryActions.children, [n.playAgain, n.done]);

  n.playAgain.fire('click');
  assert.equal(h.draws.length, 2, 'Play again samples a new queue');
  assert.notEqual(h.draws[1], h.draws[0]);
  assert.equal(n.section.getAttribute('data-state'), 'ask');
  assert.equal(n.summary.hidden, true);
  assert.equal(n.ordinal.textContent, '1/5');
  assert.equal(n.status.textContent, '');
  assert.equal(n.prompt.textContent, 'prompt 1');
  assert.equal(h.states.at(-1), 'ask');
});

test('a Game appends its own summary action beside Play again and Done', () => {
  /** @type {any} */
  let statistics = null;
  const h = roundHarness({
    queue: [],
    extra: {
      summaryActions: (/** @type {any} */ container) => {
        statistics = { tagName: 'BUTTON', className: 'text-btn', textContent: 'Statistics', children: [] };
        container.append(statistics);
      },
    },
  });
  const n = roundNodes(h.root);

  assert.deepEqual(
    n.summaryActions.children.map((child) => child.textContent),
    ['Play again', 'Statistics', 'Done'],
    'a Game-owned action sits between the two host controls',
  );
  assert.equal(statistics.textContent, 'Statistics');
});

test('leaving a round early keeps the answers and never shows a summary', () => {
  const h = roundHarness({ queue: [1, 2, 3].map(choiceQuestion) });
  const n = roundNodes(h.root);

  assert.deepEqual(byTag(n.section, 'a'), [n.done], 'the loop draws no quit control — the host owns that');
  n.buttons[1].fire('click');
  assert.deepEqual(h.answers, [{ prompt: 'prompt 1', correct: true }], 'written on the spot, not at the end');
  h.clock.tick(TAP_GUARD);
  assert.equal(h.clock.pending(), 1, 'the auto-advance is still waiting');
  const before = [...h.states];

  h.loop.teardown();
  h.loop.teardown();
  assert.equal(h.clock.pending(), 0, 'an exiting round cancels its pending advance');
  assert.equal(h.root.children.length, 0, 'and leaves nothing behind');
  assert.equal(h.states.includes('summary'), false, 'an early exit skips the summary');
  // Past the guard, so only the listener's removal can stop this tap from advancing.
  n.section.fire('click');
  assert.equal(h.loop.state(), 'feedback', 'a torn-down round listens to nothing');
  assert.deepEqual(h.states, before, 'and advances nothing');
  assert.deepEqual(h.answers, [{ prompt: 'prompt 1', correct: true }]);
});

test('a zero-item queue summarises as 0/0 instead of starting a round', () => {
  const h = roundHarness({ queue: [] });
  const n = roundNodes(h.root);

  assert.equal(n.section.getAttribute('data-state'), 'summary');
  assert.equal(n.score.textContent, '0/0');
  assert.equal(n.points.textContent, '+0 pt');
  assert.equal(n.misses.hidden, true, 'no misses, no list');
  assert.deepEqual(h.states, ['summary']);
});

test('roundLoop fails loudly without a document, a mode or a queue', () => {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  const base = { mode: 'choice', sample: () => [], document: doc };

  assert.throws(() => roundLoop(root, { ...base, document: null }), /document-like/);
  assert.throws(() => roundLoop(root, { ...base, mode: 'both' }), /mode must be/);
  assert.throws(() => roundLoop(root, { ...base, sample: undefined }), /sample\(\)/);
  assert.throws(
    () => roundLoop(root, { ...base, sample: () => null }),
    /sample\(\) must return an array/,
  );
});

test('the round loop\u2019s reserved space and sizes live in the one stylesheet', () => {
  const round = cssBlock('#round');
  assert.match(round, /height:\s*100%/, 'the round fills the node a Game was handed');
  assert.doesNotMatch(round, /100dvh/, '100dvh would push the host back control off screen');
  assert.match(round, /overflow:\s*hidden/, 'a round never scrolls');
  assert.match(cssBlock('#prompt'), /min-height:\s*2\.4em/, 'a two-line prompt does not move the card');
  assert.match(cssBlock('.options'), /min-height:\s*calc\(4 \* 56px/, 'four rows are reserved');
  assert.match(cssBlock('.opt'), /min-height:\s*56px/);
  assert.match(cssBlock('.grade'), /min-height:\s*52px/);
  const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display:\s*none !important/,
    'hidden beats the display rules of the nodes the loop swaps around',
  );
  assert.match(
    css,
    /\[data-state="selfGrade"\]:not\(\[data-grade\]\) \.status\s*\{[^}]*color:\s*var\(--ok\)/,
    'the revealed answer is green',
  );
});

// ----------------------------------------------------------------- the charts (js/lib/charts.js)

/**
 * A deliberately small well-formedness check for the strings `charts.js` returns: one root `<svg>`
 * element, every tag opened and closed in order, every attribute quoted with no `<` inside it, and
 * no stray text or angle bracket anywhere. It is not an XML parser — it is enough to catch a chart
 * that emits broken markup, which is all a string-returning helper can get wrong.
 * @param {string} svg
 */
function assertWellFormedSvg(svg) {
  assert.match(svg, /^<svg\b[^>]*>[\s\S]*<\/svg>$/, 'exactly one root <svg> element');
  /** @type {string[]} */
  const open = [];
  const tag = /<\/?([a-z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  let cursor = 0;
  for (const match of svg.matchAll(tag)) {
    assert.equal(match.index, cursor, `no stray text before ${match[0]}`);
    cursor = /** @type {number} */ (match.index) + match[0].length;
    const [, name, , selfClosing] = match;
    if (match[0].startsWith('</')) assert.equal(open.pop(), name, `</${name}> closes what is open`);
    else if (!selfClosing) open.push(name);
  }
  assert.equal(cursor, svg.length, 'nothing after the root element');
  assert.deepEqual(open, [], 'every element is closed');
}

/** The `points` attribute of a sparkline, as `[x, y]` number pairs. @param {string} svg */
function pointsOf(svg) {
  const attr = /points="([^"]*)"/.exec(svg);
  assert.ok(attr, 'the sparkline carries points');
  return attr[1].split(' ').map((pair) => pair.split(',').map(Number));
}

/** The `<rect>` attributes of a bars row, in document order. @param {string} svg */
function rectsOf(svg) {
  return [...svg.matchAll(/<rect\b([^>]*)\/>/g)].map(([, attrs]) =>
    Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])),
  );
}

/** A chart never carries text, so it is never the only carrier of meaning. @param {string} svg */
function assertSilent(svg) {
  assert.match(svg, /aria-hidden="true"/, 'a chart is aria-hidden');
  assert.doesNotMatch(svg, /<text\b/, 'no text inside the SVG');
  assert.doesNotMatch(svg, />[^<>]*[a-zA-Z]{2,}[^<>]*</, 'no text node inside the SVG');
  assert.doesNotMatch(svg, /NaN|undefined/, 'no arithmetic leaked into the markup');
}

test('a sparkline is a line for two or more points, and nothing at all for fewer', () => {
  assert.equal(sparkline([]), '', 'an empty series has no chart');
  assert.equal(sparkline([4]), '', 'one point is not a line');
  assert.equal(sparkline(null), '', 'and neither is a series that is not a series');

  const rising = sparkline([0, 5, 10]);
  assertSilent(rising);
  assertWellFormedSvg(rising);
  assert.match(rising, /viewBox="0 0 300 56"/, 'the documented default box');
  assert.match(rising, /class="spark"/);
  assert.match(rising, /preserveAspectRatio="none"/, 'the line stretches to the width it is given');
  assert.match(rising, /fill="none" stroke="currentColor"/, 'the line takes the accent from CSS');
  assert.match(rising, /vector-effect="non-scaling-stroke"/, 'a stretched line keeps its 2px weight');

  const points = pointsOf(rising);
  assert.deepEqual(points, [
    [0, 54],
    [150, 28],
    [300, 2],
  ]);
  for (const [x, y] of points) {
    assert.ok(Number.isFinite(x) && x >= 0 && x <= 300, `${x} is inside the box`);
    assert.ok(Number.isFinite(y) && y >= 0 && y <= 56, `${y} is inside the box`);
  }

  assert.match(sparkline([1, 2], { w: 100, h: 20 }), /viewBox="0 0 100 20"/, 'the size is the caller\u2019s');
  assertSilent(sparkline([1, 2], { w: 100, h: 20 }));
});

test('a flat sparkline is a straight line, never a division by zero', () => {
  const flat = sparkline([7, 7, 7]);

  assertSilent(flat);
  assertWellFormedSvg(flat);
  const ys = pointsOf(flat).map(([, y]) => y);
  assert.deepEqual(ys, [54, 54, 54], 'every value maps to one height, and it is finite');
  assert.deepEqual(pointsOf(flat).map(([x]) => x), [0, 150, 300], 'x still spans the width');

  // A series whose span is real but whose values are large and near each other still draws.
  const tight = sparkline([1000, 1001, 1000.5]);
  assertSilent(tight);
  assert.ok(pointsOf(tight).every(([, y]) => y >= 0 && y <= 56), 'still inside the box');
});

test('a bars row is one rect per value, clamped into the viewBox', () => {
  assert.equal(bars([]), '', 'an empty series has no chart');
  assert.equal(bars(null), '');

  const pcts = bars([0, 50, 100]);
  assertSilent(pcts);
  assertWellFormedSvg(pcts);
  assert.match(pcts, /viewBox="0 0 240 34"/, 'three 6px bars, two 8px gaps');
  assert.match(pcts, /height="34"/, 'the SVG keeps its own height, whatever width CSS gives it');
  assert.match(pcts, /fill="currentColor"/, 'bars take the accent from CSS');
  assert.deepEqual(rectsOf(pcts), [
    { x: '0', y: '0', width: '0.0', height: '6', rx: '3' },
    { x: '0', y: '14', width: '120.0', height: '6', rx: '3' },
    { x: '0', y: '28', width: '240.0', height: '6', rx: '3' },
  ]);

  assert.deepEqual(
    rectsOf(bars([-20, 150])).map((rect) => rect.width),
    ['0.0', '240.0'],
    'outside 0..100 clamps to an empty or a full bar',
  );
  assert.deepEqual(
    rectsOf(bars([5], { min: 0, max: 10, w: 100 })).map((rect) => rect.width),
    ['50.0'],
    'min/max map the range onto the width',
  );
  assert.deepEqual(
    rectsOf(bars([5, 4], { min: 5, max: 5 })).map((rect) => rect.width),
    ['240.0', '0.0'],
    'an empty range is the ceiling, not a division by zero',
  );

  const single = bars([42]);
  assertWellFormedSvg(single);
  assert.equal(rectsOf(single).length, 1, 'one bar for one value');
  assert.match(single, /viewBox="0 0 240 6"/, 'a single bar is exactly h tall');
});

test('charts.js pulls in nothing and reads no app state', () => {
  const source = readFileSync(fileURLToPath(new URL('../js/lib/charts.js', import.meta.url)), 'utf8');

  assert.match(source, /^\/\/ @ts-check/, 'under the type gate like every js/** file');
  assert.doesNotMatch(source, /^\s*import\s/m, 'no dependency, not even a host module');
  assert.doesNotMatch(source, /\b(document|window|localStorage|fetch)\b/, 'no environment global');
  assert.doesNotMatch(
    source,
    /\b(session|settings|store|pool|store\.|host)\b/,
    'a chart reads no host or Game state',
  );
});

test('the chart sizing lives in the one stylesheet', () => {
  assert.match(cssBlock('.spark'), /width:\s*100%/, 'a line fills the column');
  assert.match(cssBlock('.spark'), /height:\s*56px/, 'the documented 56px line height');
  assert.match(cssBlock('.spark'), /color:\s*var\(--accent\)/, 'the line is the accent');
  assert.match(cssBlock('.bars'), /width:\s*100%/, 'a bar fills its row');
  assert.match(cssBlock('.bars'), /color:\s*var\(--accent\)/, 'the bars are the accent');
  assert.doesNotMatch(
    cssBlock('.bars'),
    /height:/,
    'a bars row keeps the height it was handed, not one CSS guesses',
  );
});

// ------------------------------- the verb choice Game (js/games/verbi-presente/index.js)

/** A verb Item, the way the corpus hands one over. @param {string} id @param {number} [mastery] */
const verbItem = (id, mastery = 0) => ({
  id,
  prompt: `${id} · io · presente`,
  answer: `${id}o`,
  distractors: [`${id}i`, `${id}a`, `${id}ano`],
  tags: ['mood:ind', 'person:1s'],
  mastery,
});

/** The shipped corpus, read once: the Game's own Item mapping is checked against the real file. */
const verbItems = JSON.parse(
  readFileSync(fileURLToPath(new URL('../content/verbi-presente.json', import.meta.url)), 'utf8'),
);

/** A whole round's Session, built the way boot builds one. @param {any[]} items */
const verbSession = (items, count, extra = {}) =>
  createSession(verbiPresenteGame, {
    content: items,
    settings: { preset: null, include: {}, controls: { count } },
    rng: createRng(3),
    store: null,
    ...extra,
  });

test('the weighted queue is min(count, pool) distinct Items, weakest first', () => {
  const pool = [verbItem('a', 0.9), verbItem('b', 0), verbItem('c', 0.5), verbItem('d', 0)];
  const byMastery = (/** @type {any} */ item) => item.mastery;

  // A constant RNG makes every key depend on nothing but weight, so the draw order *is* the
  // weight order: `(1 - mastery) + 0.2`, weakest first, ties kept in pool order.
  const queue = weightedQueue(pool, { size: 4, rng: () => 0.5, mastery: byMastery });
  assert.deepEqual(queue.map((entry) => entry.id), ['b', 'd', 'c', 'a']);

  // The round length is the choice, clamped by the pool: never more Items than exist.
  assert.equal(weightedQueue(pool, { size: 20 }).length, 4, 'a 20-item round draws a 4-item pool dry');
  assert.equal(weightedQueue(pool, { size: 3 }).length, 3);
  assert.deepEqual(weightedQueue(pool, { size: 0 }), []);
  assert.deepEqual(weightedQueue([]), [], 'an empty pool has no queue to draw');
  assert.equal(weightedQueue(pool).length, 4, 'no size asks for the whole pool');

  // No Item can repeat in a round, whatever the pool and whatever the RNG.
  for (const seed of [1, 7, 99]) {
    const full = weightedQueue(pool, { size: pool.length, rng: createRng(seed) });
    assert.equal(full.length, 4);
    assert.equal(new Set(full.map((entry) => entry.id)).size, 4, 'drawn without replacement');
  }
});

test('an unseen Item outweighs a practised one, and mastery fades by the day', () => {
  const today = 19700;
  assert.equal(itemWeight(0), 1.2, 'mastery 0 leaves the flat +0.2 on top of 1');
  assert.equal(itemWeight(1), 0.2);
  assert.equal(itemWeight(0.5), 0.7);

  const stored = (/** @type {any} */ entry) => ({ items: { known: entry } });
  assert.equal(masteryOf({}, 'known', today), 0, 'an Item with no entry is unseen');
  assert.equal(masteryOf(stored({ ema: 1, last: today }), 'known', today), 1);
  assert.equal(masteryOf(stored({ a: 3, c: 3, ema: 1, last: today - 14 }), 'known', today), 0.5, 'mastery halves over a fortnight');
  assert.ok(masteryOf(stored({ ema: 1, last: today - 100 }), 'known', today) < 0.02, 'an Item stopped months ago fades away');
  assert.equal(masteryOf(stored({ last: today }), 'known', today), 0, 'an entry from before progress existed is unseen');
  assert.equal(masteryOf({ items: { known: { ema: 9 } } }, 'known', today), 1, 'mastery never leaves 0..1');
  assert.equal(itemWeight(masteryOf(stored({ ema: 1, last: today }), 'known', today)), 0.2);

  // `today` defaults to the player's own local epoch-day, which is the day `last` is written in:
  // an attempt made today reads as fully practised, and the counter moves one per calendar day.
  assert.ok(Number.isInteger(epochDay()));
  const midday = Date.UTC(2026, 5, 15, 12);
  assert.equal(epochDay(midday + 86_400_000) - epochDay(midday), 1);
  assert.equal(masteryOf(stored({ ema: 1, last: epochDay() }), 'known'), 1);

  // A constant RNG shows the weighting deterministically: the unseen Item's key wins, whichever
  // order the two were in.
  const practised = verbItem('known', 1);
  const unseen = verbItem('new', 0);
  const draw = (/** @type {any[]} */ pool) =>
    weightedQueue(pool, { size: 1, rng: () => 0.5, mastery: (/** @type {any} */ item) => item.mastery });
  assert.deepEqual(draw([practised, unseen]).map((entry) => entry.id), ['new']);
  assert.deepEqual(draw([unseen, practised]).map((entry) => entry.id), ['new'], 'not just pool order');

  // Over many draws the unseen Item really does come up first far more often than chance.
  const rng = createRng(42);
  let unseenFirst = 0;
  for (let n = 0; n < 400; n += 1) {
    const [first] = weightedQueue([practised, unseen], { size: 2, rng, mastery: (item) => item.mastery });
    if (first.id === 'new') unseenFirst += 1;
  }
  assert.ok(unseenFirst >= 240, `the unseen Item came first in ${unseenFirst}/400 draws`);
});

test('each question offers its own answer plus its three authored distractors', () => {
  const cercare = {
    id: 'verbi-pres-cercare-2s',
    prompt: 'cercare · tu · presente',
    answer: 'cerchi',
    distractors: ['cerci', 'cercai', 'cerca'],
    tags: ['class:-are'],
  };
  const question = questionFor(cercare, createRng(5));
  assert.equal(question.prompt, cercare.prompt);
  assert.equal(question.answer, cercare.answer);
  assert.equal(question.options.length, 4, 'four options per question, always');
  assert.deepEqual(
    [...question.options].sort(),
    [cercare.answer, ...cercare.distractors].sort(),
    'its own answer and its own three distractors',
  );
  assert.equal(new Set(question.options).size, 4, 'never a duplicated option');

  // The order is drawn once, with the Session's RNG, so it is stable for that question and
  // nothing about the Item's fields can move it afterwards.
  assert.deepEqual(shuffle(['a', 'b', 'c', 'd'], createRng(5)), shuffle(['a', 'b', 'c', 'd'], createRng(5)));
  assert.deepEqual(questionFor(cercare, createRng(5)).options, question.options);

  // Every shipped Item maps to a four-option question whose options are exactly its own, and the
  // answer is not parked in the first row (a drill where position one always wins teaches that).
  const rng = createRng(11);
  let firstRowIsAnswer = 0;
  for (const item of verbItems) {
    const asked = questionFor(item, rng);
    assert.equal(asked.options.length, 4, `${item.id} asks four options`);
    assert.deepEqual([...asked.options].sort(), [item.answer, ...item.distractors].sort(), `${item.id} offers its own four`);
    if (asked.options[0] === item.answer) firstRowIsAnswer += 1;
  }
  assert.ok(firstRowIsAnswer >= 24 && firstRowIsAnswer <= 120, `the answer started in row one ${firstRowIsAnswer}/240 times`);
});

test('the verb Game plays a choice round of the chosen length, judged in the loop', () => {
  const pool = verbItems.slice(0, 8);
  const session = verbSession(pool, 5);
  assert.equal(session.pool.length, 8);

  withFakeDocument((doc) => {
    const root = doc.createElement('div');
    const teardown = verbiPresenteGame.play(root, session);
    const round = byClass(root, 'round')[0];
    assert.ok(round, 'the Game draws the shared round markup');
    assert.equal(round.getAttribute('data-state'), 'ask');
    assert.equal(round.children[0].children[1].textContent, '1/5', 'the chosen five, not the pool of eight');

    const options = nodesOf(round).filter((node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'));
    assert.equal(options.length, 4, 'four option rows exist before the first question is read');
    const promptText = round.children[1].textContent;
    const asked = pool.find((entry) => entry.prompt === promptText);
    assert.ok(asked, 'the question is one of the pool’s own Items');
    const labels = options.map((button) => button.textContent);
    assert.deepEqual([...labels].sort(), [asked.answer, ...asked.distractors].sort(), 'its own four options');

    // The Game judges nothing itself: the shared loop reads the correct answer out of the option
    // rows, which is why a wrong tap still shows `giusto: <answer>`.
    const answerAt = labels.indexOf(asked.answer);
    const wrongAt = labels.findIndex((label) => label !== asked.answer);
    options[wrongAt].fire('click');
    assert.equal(round.getAttribute('data-state'), 'feedback');
    assert.equal(byClass(round, 'status')[0].textContent, `giusto: ${asked.answer}`);
    assert.equal(options[answerAt].className, 'opt correct');
    assert.equal(options[wrongAt].className, 'opt wrong');

    // The host back control runs this teardown, so leaving a round mid-feedback cancels the
    // pending advance and empties the node the Game was handed.
    teardown();
    assert.equal(root.children.length, 0);
  });
});

test('the round length comes from the control, and an empty pool draws no question', () => {
  assert.equal(roundCount({ preset: null, include: {}, controls: { count: 20 } }), 20);
  assert.equal(roundCount({ preset: null, include: {}, controls: { count: '5' } }), 5, 'a chip’s option, whichever way it was written');
  assert.equal(roundCount({ preset: null, include: {}, controls: {} }), 10, 'the declared default');
  assert.equal(roundCount(undefined), 10);

  // A thin pool cannot produce a 20-item round: the queue is what exists.
  withFakeDocument((doc) => {
    const thin = doc.createElement('div');
    const thinTeardown = verbiPresenteGame.play(thin, verbSession(verbItems.slice(0, 3), 20));
    assert.equal(byClass(thin, 'round')[0].children[0].children[1].textContent, '1/3');
    thinTeardown();

    // The settings screen refuses to start an empty pool; if a round is entered anyway it
    // summarises 0/0 instead of asking anything.
    const empty = doc.createElement('div');
    const emptyTeardown = verbiPresenteGame.play(empty, verbSession([], 10));
    const round = byClass(empty, 'round')[0];
    assert.equal(round.getAttribute('data-state'), 'summary');
    assert.equal(byClass(round, 'score')[0].textContent, '0/0');
    assert.ok(
      nodesOf(round).filter((node) => node.className.startsWith('opt')).every((button) => button.textContent === ''),
      'no question was ever asked',
    );
    emptyTeardown();
  });
});

// ---------------------------- the verb choice Game's progress and statistics (US-017)

/**
 * A timestamp inside local epoch-day `day`: the inverse of `epochDay()` for a chosen day, so a
 * case can place attempts on the calendar instead of only "today". Noon-ish, then nudged, because
 * the offset `epochDay()` uses is the offset at that instant.
 * @param {number} day
 */
function atDay(day) {
  let ms = day * 86_400_000 + 12 * 3_600_000;
  while (epochDay(ms) < day) ms += 3_600_000;
  while (epochDay(ms) > day) ms -= 3_600_000;
  return ms;
}

/** An Item carrying exactly these Tags, for the Tag rows and the weakest-first order. */
const taggedVerb = (/** @type {string} */ id, /** @type {string[]} */ tags) => ({ ...verbItem(id), tags });

test('an attempt writes the per-Item counters, the EMA and the points it earned', () => {
  const today = epochDay();
  const item = verbItem('cercare');
  const store = {};

  // An unseen Item: a=0, c=0, ema=0, elapsed 0 — and an unseen Item earns no recency bonus.
  assert.equal(recordAttempt(store, item, true, { now: atDay(today) }), POINTS_CORRECT);
  assert.deepEqual(store.items[item.id], { a: 1, c: 1, ema: 0.25, last: today });
  assert.equal(store.points, POINTS_CORRECT);
  assert.equal(masteryOf(store, item.id, today), 0.25, 'mastery is the EMA on the day it was written');
  assert.equal(masteredOf(store, item.id, today), false, 'one answer is not knowledge');

  // The same Item on the same local day: no elapsed days, so a wrong answer earns nothing.
  assert.equal(recordAttempt(store, item, false, { now: atDay(today) }), 0);
  // The EMA is `0.25 * outcome + 0.75 * previous`, the documented recency weight.
  assert.equal(store.items[item.id].ema, 0.75 * 0.25);
  assert.equal(store.items[item.id].a, 2);
  assert.equal(store.items[item.id].c, 1);

  // Elapsed days come from the previous `last`, before it is overwritten…
  assert.equal(recordAttempt(store, item, true, { now: atDay(today + 3) }), POINTS_CORRECT, 'three days is not a week');
  assert.equal(store.items[item.id].last, today + 3);
  // …and the +5 is for coming back after a week, independent of the answer being right.
  assert.equal(
    recordAttempt(store, item, false, { now: atDay(today + 10) }),
    POINTS_RETURN,
    'the recency bonus does not need a correct answer',
  );
  assert.equal(store.items[item.id].c, 2, 'a wrong answer never counts as correct');
  assert.equal(store.points, 2 * POINTS_CORRECT + POINTS_RETURN);

  // Mastery decays by half a fortnight, and mastered needs both floors: the mastery and the
  // attempts (the floor is what stops one lucky answer looking like knowledge).
  const aged = { items: { known: { a: MASTERED_ATTEMPTS, c: MASTERED_ATTEMPTS, ema: 1, last: today - 14 } } };
  assert.equal(masteryOf(aged, 'known', today), 0.5);
  assert.equal(masteredOf(aged, 'known', today), false, 'the mastery has faded below the floor');
  const fresh = { items: { known: { a: MASTERED_ATTEMPTS, c: MASTERED_ATTEMPTS, ema: MASTERED_AT, last: today } } };
  assert.equal(masteredOf(fresh, 'known', today), true);
  const lucky = { items: { known: { a: MASTERED_ATTEMPTS - 1, c: 2, ema: 1, last: today } } };
  assert.equal(masteredOf(lucky, 'known', today), false, 'too few attempts, however good the EMA');

  // A Session built without a store is still a round: the points are computed, nothing is written.
  assert.equal(recordAttempt(null, item, true, { now: atDay(today) }), POINTS_CORRECT);
});

test('the daily buckets and the weekly Tag snapshots stay bounded', () => {
  const today = epochDay();
  const item = taggedVerb('cercare', ['reg:regular']);
  const store = {};

  // One attempt a local day for 200 days: an unbounded store would grow with practice itself.
  for (let day = today - 199; day <= today; day += 1) {
    recordAttempt(store, item, true, { now: atDay(day), items: [item] });
  }
  assert.equal(store.days.length, DAILY_BUCKETS, 'only the last 90 daily buckets are kept');
  assert.equal(store.days[0].d, today - DAILY_BUCKETS + 1, 'the oldest days are the ones dropped');
  assert.equal(store.days[DAILY_BUCKETS - 1].d, today);
  assert.deepEqual(
    store.days.map((bucket) => bucket.d),
    [...store.days.map((bucket) => bucket.d)].sort((left, right) => left - right),
    'the buckets stay ascending by local day',
  );
  assert.equal(store.points, 200 * POINTS_CORRECT, 'the total is not bounded, only the history is');

  // A local week is one snapshot, not one snapshot per attempt: 200 days is ~29 weeks.
  assert.equal(store.weeks.length, WEEKLY_SNAPSHOTS, 'at most 26 weekly snapshots are kept');
  assert.equal(new Set(store.weeks.map((week) => week.w)).size, WEEKLY_SNAPSHOTS, 'one snapshot per local week');
  assert.ok(
    store.weeks.every((week, index) => index === 0 || week.w > store.weeks[index - 1].w),
    'the weeks stay ascending too',
  );
  const newest = store.weeks[WEEKLY_SNAPSHOTS - 1];
  assert.equal(newest.w, Math.floor(today / 7), 'the newest week is this one');
  assert.ok(newest.tags['reg:regular'] > 0.999, 'a snapshot holds each Tag’s current Skill');

  // Two attempts inside one local week update that week’s snapshot instead of adding another,
  // and a day arriving out of order still lands in order.
  const oneWeek = {};
  recordAttempt(oneWeek, item, true, { now: atDay(today), items: [item] });
  recordAttempt(oneWeek, item, false, { now: atDay(today - 1), items: [item] });
  assert.equal(oneWeek.weeks.length, 1);
  assert.deepEqual(Object.keys(oneWeek.weeks[0].tags), ['reg:regular']);
  assert.deepEqual(oneWeek.days.map((bucket) => bucket.d), [today - 1, today]);
  assert.deepEqual(oneWeek.days.map((bucket) => bucket.a), [1, 1]);
});

test('a cold statistics view reads the documented empty states, and nothing shows NaN', () => {
  const doc = fakeDocument();
  const cold = statisticsView(doc, { store: null, items: [] });
  assert.equal(cold.section.hidden, true, 'the view starts hidden — the round owns the screen');
  assert.equal(cold.section.getAttribute('aria-labelledby'), 'stats-title');
  // A cumulative line always has 30 points to draw, so a cold store is a flat line at zero; the
  // daily line has nothing to draw at all, and its written note carries that case on its own.
  const coldCharts = byClass(cold.section, 'chart');
  assertWellFormedSvg(coldCharts[0].innerHTML);
  assertSilent(coldCharts[0].innerHTML);
  assert.equal(new Set(pointsOf(coldCharts[0].innerHTML).map(([, y]) => y)).size, 1, 'a cold store is a flat line');
  assert.equal(coldCharts[1].innerHTML, '', 'no day with attempts means no daily line');
  assert.deepEqual(byTag(cold.section, 'h2').map((head) => head.textContent), [
    'Points',
    'Accuracy',
    'Skills by Tag',
    'Weakest items',
  ]);
  assert.deepEqual(byClass(cold.section, 'stat').map((node) => node.textContent), [
    '0 points',
    'No attempts in the last 7 days',
  ]);
  assert.equal(byClass(cold.section, 'delta')[0].hidden, true, 'no accuracy means no delta');
  assert.equal(byClass(cold.section, 'delta')[0].textContent, '');
  assert.deepEqual(
    byClass(cold.section, 'stat-rows')[0].children.map((node) => node.textContent),
    ['No tagged attempts yet'],
  );
  // Every chart has its written summary next to it, and a cold store still says something true.
  const coldNotes = byClass(cold.section, 'note');
  assert.equal(coldNotes[0].textContent, `0 → 0 pt over the last ${POINTS_WINDOW} local days`);
  assert.equal(coldNotes[1].textContent, `No attempts in the last ${POINTS_WINDOW} local days to chart`);
  assert.equal(coldNotes[2].textContent, 'No tagged attempts yet');
  assert.deepEqual(byTag(cold.section, 'li').map((node) => node.textContent), ['No attempts yet']);
  assert.equal(byClass(cold.section, 'actions').length, 1);
  assert.equal(byClass(cold.section, 'actions')[0].children[0].textContent, 'Summary');
  assert.equal(byTag(cold.section, 'a').length, 0, 'the view navigates nowhere');

  // The numbers behind it are zeros and empty lists, never NaN.
  const stats = statsFor(null, []);
  assert.equal(stats.points, 0);
  assert.equal(stats.cumulative.length, POINTS_WINDOW);
  assert.ok(stats.cumulative.every((value) => value === 0));
  assert.deepEqual(stats.accuracy, { attempts: 0, correct: 0, pct: null, previousPct: null, delta: null });
  assert.deepEqual(stats.daily, []);
  assert.deepEqual(stats.tags, []);
  assert.deepEqual(stats.weakest, []);

  // A store hand-edited into nonsense still reads as numbers, never as NaN.
  const junk = statsFor({ items: { x: { a: 'no', ema: null, last: undefined } }, days: 'nope', weeks: 7, points: 'x' }, []);
  assert.equal(junk.points, 0);
  assert.ok(junk.cumulative.every(Number.isFinite), 'no arithmetic leaks into the chart');
  const junkView = statisticsView(fakeDocument(), {
    store: { days: [null, 'x', { d: 'x' }, { d: 1, a: 'x', c: null }] },
    items: [],
  });
  assert.equal(junkView.section.hidden, true);
  assert.ok(byClass(junkView.section, 'stat').every((node) => !/NaN|undefined/.test(node.textContent)));
  assert.ok(byClass(junkView.section, 'chart').every((chart) => !/NaN|undefined/.test(chart.innerHTML)));
});

test('the statistics view’s documented sizes live in the one stylesheet', () => {
  assert.match(cssBlock('.stat-row'), /min-height:\s*48px/, 'a Tag row is 48px');
  assert.match(cssBlock('.stat-row .bar-cell'), /flex:\s*1/, 'the bar takes the row’s free width');
  assert.match(cssBlock('.stats'), /height:\s*100%/, 'the view fills the node the Game was handed');
  assert.match(cssBlock('.stats'), /overflow-y:\s*auto/, 'and is the one Game view that scrolls');
  assert.match(cssBlock('.stats .actions'), /grid-template-columns:\s*1fr/, 'Summary is one full-width row');
});

test('the statistics are the store’s own numbers, weakest Tag first', () => {
  const today = epochDay();
  const items = [
    taggedVerb('a', ['reg:regular', 'person:1s']),
    taggedVerb('b', ['reg:irregular', 'person:1s']),
    taggedVerb('c', ['reg:regular', 'person:2s']),
  ];
  const store = {};
  // Two right answers on `a` today, two wrong ones on `b`, and `c` never asked.
  recordAttempt(store, items[0], true, { now: atDay(today), items });
  recordAttempt(store, items[0], true, { now: atDay(today), items });
  recordAttempt(store, items[1], false, { now: atDay(today), items });
  recordAttempt(store, items[1], false, { now: atDay(today), items });
  const masteryOfA = masteryOf(store, 'a', today);

  const stats = statsFor(store, items, atDay(today));
  // Skill is the mean Mastery of *every* current Item carrying the Tag — so `reg:regular` averages
  // in the untouched `c` at mastery 0 — and `person:2s` (only `c`) has no attempt, so no row.
  assert.deepEqual(
    stats.tags.map((row) => row.tag),
    ['reg:irregular', 'person:1s', 'reg:regular'],
    'weakest first, ties broken by Tag value ascending',
  );
  const [irregular, single, regular] = stats.tags;
  assert.equal(irregular.pct, 0, 'two wrong answers are no Skill at all');
  assert.equal(irregular.a, 2, 'n is the attempts the Tag’s Items carry');
  assert.equal(single.a, 4, 'both attempted Items carry person:1s');
  assert.equal(single.skill, masteryOfA / 2);
  assert.equal(regular.a, 2, 'the untouched Item of the two contributes attempts, not just Skill');
  assert.equal(regular.skill, masteryOfA / 2);
  assert.deepEqual(stats.weakest.map((item) => item.id), ['b', 'a'], 'the weakest attempted Items, text only');
  assert.equal(stats.points, 2 * POINTS_CORRECT);
  assert.equal(stats.accuracy.pct, 50, 'four attempts, two of them right');
  assert.equal(stats.accuracy.delta, null, 'there is no week before this one to compare with');
  assert.deepEqual(stats.daily, [50]);
  assert.equal(stats.cumulative[POINTS_WINDOW - 1], stats.points, 'the line ends at the total');

  // The view renders them: one row per attempted Tag, weakest first, with its bar, % and n=.
  const view = statisticsView(fakeDocument(), { store, items });
  const rows = byClass(view.section, 'stat-rows')[0].children;
  assert.deepEqual(rows.map((row) => row.children[0].textContent), ['reg:irregular', 'person:1s', 'reg:regular']);
  const expected = `${Math.round((masteryOfA / 2) * 100)}%`;
  assert.deepEqual(rows.map((row) => row.children[2].textContent), ['0%', expected, expected]);
  assert.deepEqual(rows.map((row) => row.children[3].textContent), ['n=2', 'n=4', 'n=2']);
  const barsRows = rows.map((row) => row.children[1].innerHTML);
  for (const bar of barsRows) {
    assertWellFormedSvg(bar);
    assertSilent(bar);
    assert.match(bar, /height="6"/, 'the row\u2019s bar is the documented 6px');
  }
  assert.deepEqual(rectsOf(barsRows[0]).map((rect) => rect.width), ['0.0'], 'a 0% row draws an empty bar');
  assert.deepEqual(byTag(view.section, 'li').map((node) => node.textContent), [
    'b · io · presente · 0%',
    `a · io · presente · ${Math.round(masteryOfA * 100)}%`,
  ]);

  // An Item the store knows but the current content no longer carries keeps its stored data and
  // stays out of the Tag and weakest-Item views — while its points are still the Game’s.
  const removed = {};
  recordAttempt(removed, taggedVerb('gone', ['reg:regular']), true, { now: atDay(today), items });
  const after = statsFor(removed, items, atDay(today));
  assert.ok(removed.items.gone, 'the removed Item keeps its stored entry');
  assert.deepEqual(after.weakest, [], 'a removed Item is never a weakest Item');
  assert.deepEqual(after.tags, [], 'and it carries no Tag Skill');
  assert.equal(after.points, POINTS_CORRECT, 'its points remain in the total');

  // Two local days with attempts are a daily line, one point per day with attempts...
  const twoDays = {};
  recordAttempt(twoDays, items[0], true, { now: atDay(today - 1), items });
  recordAttempt(twoDays, items[0], false, { now: atDay(today), items });
  const daily = byClass(statisticsView(fakeDocument(), { store: twoDays, items }).section, 'chart')[1].innerHTML;
  assertWellFormedSvg(daily);
  assertSilent(daily);
  assert.deepEqual(pointsOf(daily).map(([x]) => x), [0, 300], 'two points, across the width');

  // ...and the delta is in percentage points against the week before, drawn as the doc draws it.
  const deltaOf = (/** @type {boolean} */ earlierRight, /** @type {boolean} */ nowRight) => {
    const two = {};
    recordAttempt(two, items[0], earlierRight, { now: atDay(today - ATTEMPTS_WINDOW - 1), items });
    recordAttempt(two, items[0], nowRight, { now: atDay(today), items });
    return byClass(statisticsView(fakeDocument(), { store: two, items }).section, 'delta')[0];
  };
  assert.equal(deltaOf(true, true).textContent, '·0');
  assert.equal(deltaOf(false, true).textContent, '▲100');
  assert.equal(deltaOf(true, false).textContent, '▼100');
  assert.equal(deltaOf(true, false).hidden, false);
});

test('the verb Game writes the attempt the loop judged into its own store', () => {
  const pool = verbItems.slice(0, 3);
  const store = {};

  withFakeDocument((doc) => {
    const root = doc.createElement('div');
    const teardown = verbiPresenteGame.play(root, verbSession(pool, 5, { store }));
    const round = byClass(root, 'round')[0];
    const asked = pool.find((entry) => entry.prompt === round.children[1].textContent);
    assert.ok(asked, 'the question is one of the pool’s own Items');
    const options = nodesOf(round).filter((node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'));
    options[options.map((button) => button.textContent).indexOf(asked.answer)].fire('click');

    // The Game judges nothing itself: the loop reads the answer off the option rows, and this
    // Game's own `onAnswer` writes the attempt it hands over.
    assert.equal(byClass(round, 'status')[0].textContent, 'corretto');
    assert.deepEqual(store.items[asked.id], { a: 1, c: 1, ema: 0.25, last: epochDay() });
    assert.equal(store.points, POINTS_CORRECT);
    assert.deepEqual(store.days.map((bucket) => [bucket.d, bucket.a, bucket.c, bucket.p]), [
      [epochDay(), 1, 1, POINTS_CORRECT],
    ]);
    assert.equal(store.weeks.length, 1, 'and this week’s Tag snapshot');

    teardown();
    assert.equal(root.children.length, 0);
  });
});

test('the summary’s Statistics action opens the Game’s own view, and Summary returns to it', () => {
  const pool = verbItems.slice(0, 2);
  const store = {};

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteGame.play(root, verbSession(pool, 1, { store }));
      const round = byClass(root, 'round')[0];
      const stats = byClass(root, 'stats')[0];
      assert.ok(stats, 'the Game draws its own statistics view');
      assert.equal(stats.hidden, true, 'and keeps it out of the round until it is asked for');
      assert.equal(round.hidden, false);

      // One right answer, then the loop’s own 700 ms advance to the summary.
      const options = nodesOf(round).filter((node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'));
      const asked = pool.find((entry) => entry.prompt === round.children[1].textContent);
      options[options.map((button) => button.textContent).indexOf(asked.answer)].fire('click');
      clock.tick(CORRECT_DELAY);
      const summary = byClass(round, 'summary')[0];
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '1/1');
      assert.deepEqual(
        nodesOf(summary).filter((node) => node.tagName === 'BUTTON').map((button) => button.textContent),
        ['Play again', 'Statistics'],
        'the Game’s own action sits beside Play again, before the host’s Done',
      );
      assert.equal(nodesOf(summary).filter((node) => node.tagName === 'A')[0].textContent, 'Done');

      // Statistics is not a route and not a link: it swaps the Game’s two views in place.
      nodesOf(summary).filter((node) => node.textContent === 'Statistics')[0].fire('click');
      assert.equal(round.hidden, true);
      assert.equal(stats.hidden, false);
      assert.equal(byTag(stats, 'a').length, 0, 'the view carries no navigation at all');
      assert.equal(byClass(stats, 'back').length, 0, 'the host still owns the only quit control');
      assert.equal(byClass(stats, 'stat')[0].textContent, `${POINTS_CORRECT} pt`, 'refreshed from the store the round just wrote');
      assert.equal(byClass(stats, 'stat')[1].textContent, '100%', 'one right answer is 100% this week');
      assert.deepEqual(byTag(stats, 'h2').map((head) => head.textContent), [
        'Points',
        'Accuracy',
        'Skills by Tag',
        'Weakest items',
      ]);

      // The cumulative line is a chart; one day with attempts is not a line, so the written note
      // carries that case on its own.
      const charts = byClass(stats, 'chart');
      assertWellFormedSvg(charts[0].innerHTML);
      assertSilent(charts[0].innerHTML);
      assert.equal(charts[1].innerHTML, '');
      assert.match(byClass(stats, 'note')[1].textContent, /^1 day with attempts/);

      // Summary returns to the very same round summary: same score, same queue, no navigation.
      nodesOf(stats)
        .filter((node) => node.tagName === 'BUTTON' && node.textContent === 'Summary')[0]
        .fire('click');
      assert.equal(stats.hidden, true);
      assert.equal(round.hidden, false);
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '1/1');

      // Play again still samples a fresh queue in place, and the host back control still runs the
      // teardown that empties the node the Game was handed.
      nodesOf(summary).filter((node) => node.textContent === 'Play again')[0].fire('click');
      assert.equal(round.getAttribute('data-state'), 'ask');
      assert.equal(round.children[0].children[1].textContent, '1/1');
      assert.equal(store.items[asked.id].a, 1, 'a new queue records nothing until it is answered');
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

// ------------------------- the verb reveal Game (js/games/verbi-presente-rivela/index.js)

/** A whole reveal round's Session, built the way boot builds one. @param {any[]} items */
const rivelaSession = (items, count, extra = {}) =>
  createSession(verbiPresenteRivelaGame, {
    content: items,
    settings: { preset: null, include: {}, controls: { count } },
    rng: createRng(3),
    store: null,
    ...extra,
  });

/** The action-bar button carrying this label; text concatenates, so match the tag too. */
const revealButton = (/** @type {any} */ round, /** @type {string} */ label) =>
  nodesOf(round.children[4]).filter((node) => node.tagName === 'BUTTON' && node.textContent === label)[0];

/** The Item the question on screen asks, out of the pool it was drawn from. */
const askedItem = (/** @type {any} */ round, /** @type {any[]} */ pool) =>
  pool.find((entry) => entry.prompt === round.children[1].textContent);

test('the reveal Game draws the same weighted, without-replacement queue', () => {
  const today = epochDay();
  const pool = [verbItem('a', 0.9), verbItem('b', 0), verbItem('c', 0.5), verbItem('d', 0)];
  const store = {
    items: Object.fromEntries(pool.map((entry) => [entry.id, { ema: entry.mastery, last: today }])),
  };

  // The same Efraimidis–Spirakis key the choice Game uses: with a constant RNG the draw order *is*
  // the weight order, weakest first, ties kept in pool order.
  const queue = roundQueue(pool, { size: 4, rng: () => 0.5, store, today });
  assert.deepEqual(queue.map((entry) => entry.id), ['b', 'd', 'c', 'a']);

  // The round length is the choice, clamped by the pool; no Item can repeat in a round.
  assert.equal(roundQueue(pool, { size: 20, rng: () => 0.5, store, today }).length, 4, 'min(count, pool)');
  assert.deepEqual(roundQueue([], { size: 5, rng: () => 0.5, store, today }), [], 'an empty pool has no queue');
  for (const seed of [1, 7, 99]) {
    const full = roundQueue(pool, { size: 4, rng: createRng(seed), store, today });
    assert.equal(full.length, 4);
    assert.equal(new Set(full.map((entry) => entry.id)).size, 4, 'drawn without replacement');
  }
});

test('the reveal Game reads mastery from its own store, never the choice Game\u2019s', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const choiceStore = storage.store('verbi-presente');
  const revealStore = storage.store('verbi-presente-rivela');
  assert.notEqual(choiceStore, revealStore, 'each Game id owns its own slice');

  const today = epochDay();
  const pool = [verbItem('a'), verbItem('b'), verbItem('c'), verbItem('d')];
  // Recognition believes it has mastered a and b; production has no history at all.
  choiceStore.items = { a: { ema: 1, last: today }, b: { ema: 1, last: today } };

  /** @param {any} store */
  const draw = (store) => roundQueue(pool, { size: 4, rng: () => 0.5, store, today }).map((entry) => entry.id);
  assert.deepEqual(draw(choiceStore), ['c', 'd', 'a', 'b'], 'the choice Game weights by its own mastered Items');
  assert.deepEqual(draw(revealStore), ['a', 'b', 'c', 'd'], 'the reveal Game\u2019s empty store leaves the pool order alone');
  assert.deepEqual(draw(revealStore), draw(createStorage(fakeBackend()).store('verbi-presente-rivela')), 'nothing leaked in');

  // A write through one Game's slice never appears in the other's — the two drills never average.
  revealStore.items = { c: { a: 1, c: 1, ema: 0.25, last: today } };
  assert.equal(choiceStore.items.c, undefined, 'production progress stays out of recognition');
  assert.deepEqual(backend.envelope().data.games['verbi-presente'].store.items, {
    a: { ema: 1, last: today },
    b: { ema: 1, last: today },
  });
});

test('a reveal question carries the prompt and the answer, and no options', () => {
  const item = verbItem('cercare');
  assert.deepEqual(revealQuestion(item), { prompt: item.prompt, answer: item.answer });
  assert.equal('options' in revealQuestion(item), false, 'a reveal Game never draws options');
});

test('the reveal Game asks the prompt, reveals the answer and self-grades', () => {
  const pool = verbItems.slice(0, 5);
  const session = rivelaSession(pool, 5);

  withFakeDocument((doc) => {
    const root = doc.createElement('div');
    const teardown = verbiPresenteRivelaGame.play(root, session);
    const round = byClass(root, 'round')[0];
    assert.ok(round, 'the Game draws the shared round markup');
    assert.equal(round.getAttribute('data-state'), 'ask');
    assert.equal(round.children[0].children[1].textContent, '1/5', 'the chosen five, not the pool it was filtered from');
    assert.equal(byClass(round, 'back').length, 0, 'the Game draws no quit control \u2014 the host owns that');

    const options = round.children[3];
    assert.equal(options.hidden, true, 'a reveal round offers no option rows');
    const actions = round.children[4];
    assert.equal(actions.hidden, false);
    const [showAnswer, gradeRight, gradeWrong] = nodesOf(actions).filter((node) => node.tagName === 'BUTTON');
    assert.equal(showAnswer.textContent, 'Show answer');
    assert.equal(gradeRight.textContent, 'I was right');
    assert.equal(gradeWrong.textContent, 'I was wrong');
    assert.equal(gradeRight.hidden, true, 'the two grades only exist after the reveal');

    const asked = pool.find((entry) => entry.prompt === round.children[1].textContent);
    assert.ok(asked, 'the question is one of the pool\u2019s own Items');

    showAnswer.fire('click');
    assert.equal(round.getAttribute('data-state'), 'selfGrade');
    assert.equal(byClass(round, 'status')[0].textContent, asked.answer, 'the answer is revealed, to be graded');
    assert.equal(gradeRight.hidden, false);
    assert.equal(gradeWrong.hidden, false);
    assert.equal(byClass(round, 'wrong').length, 0, 'nothing is ever coloured red in reveal mode');

    gradeWrong.fire('click');
    assert.equal(round.getAttribute('data-grade'), 'bad');
    assert.equal(byClass(round, 'status')[0].textContent, 'da rivedere');

    // The host back control runs this teardown, so exiting mid-selfGrade cancels the pending
    // confirm and empties the node the Game was handed.
    teardown();
    assert.equal(root.children.length, 0);
  });
});

test('an empty reveal pool summarises as 0/0 instead of starting a round', () => {
  withFakeDocument((doc) => {
    const root = doc.createElement('div');
    const teardown = verbiPresenteRivelaGame.play(root, rivelaSession([], 10));
    const round = byClass(root, 'round')[0];
    assert.equal(round.getAttribute('data-state'), 'summary');
    assert.equal(byClass(round, 'score')[0].textContent, '0/0');
    assert.equal(round.children[3].hidden, true, 'no question was ever asked');
    teardown();
  });
});

// --------------------- the verb reveal Game's progress and statistics (US-018)

test('a production self-grade writes the shared counters into the reveal Game’s own store', () => {
  const today = epochDay();
  const pool = verbItems.slice(0, 2);
  const store = {};

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteRivelaGame.play(root, rivelaSession(pool, 1, { store }));
      const round = byClass(root, 'round')[0];
      const asked = askedItem(round, pool);
      assert.ok(asked, 'the question is one of the pool’s own Items');

      // A wrong self-grade: the documented unseen-Item start (a=1, c=0, ema=0, stamped today) and
      // no points, written the moment the player grades — the shared policy, this Game’s store.
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was wrong').fire('click');
      assert.deepEqual(store.items[asked.id], { a: 1, c: 0, ema: 0, last: today });
      assert.equal(store.points, 0);
      assert.deepEqual(store.days.map((bucket) => [bucket.d, bucket.a, bucket.c, bucket.p]), [[today, 1, 0, 0]]);
      assert.equal(store.weeks.length, 1, 'and this week’s Tag snapshot');
      clock.tick(CONFIRM_DELAY);
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'points')[0].textContent, '+0 pt', 'a wrong production attempt earns nothing');

      // Play again draws in place; a right self-grade compounds the same EMA and earns 10.
      nodesOf(round).filter((node) => node.tagName === 'BUTTON' && node.textContent === 'Play again')[0].fire('click');
      assert.equal(askedItem(round, pool).id, asked.id, 'a one-Item pool redraws the same Item');
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was right').fire('click');
      assert.deepEqual(store.items[asked.id], { a: 2, c: 1, ema: 0.25, last: today });
      assert.equal(store.points, POINTS_CORRECT);
      assert.equal(masteryOf(store, asked.id, today), 0.25, 'the shared mastery read sees the same number');
      clock.tick(CONFIRM_DELAY);
      assert.equal(byClass(round, 'points')[0].textContent, `+${POINTS_CORRECT} pt`);
      teardown();
      assert.equal(root.children.length, 0);
    });
  });

  // A Session built without a store is still a round: the points show, nothing is written.
  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteRivelaGame.play(root, rivelaSession(pool, 1));
      const round = byClass(root, 'round')[0];
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was right').fire('click');
      clock.tick(CONFIRM_DELAY);
      assert.equal(byClass(round, 'points')[0].textContent, `+${POINTS_CORRECT} pt`);
      teardown();
    });
  });
});

test('a week away from an Item earns the shared recency bonus, through the real Game', () => {
  const today = epochDay();
  const item = verbItem('cercare');
  // The Item was produced correctly ten local days ago; the reveal Game draws it and grades it
  // right again, so the +5 for coming back is what the shared policy adds — not a copy of it.
  const store = { items: { [item.id]: { a: 1, c: 1, ema: 0.5, last: today - 10 } }, points: POINTS_CORRECT };

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteRivelaGame.play(root, rivelaSession([item], 1, { store }));
      const round = byClass(root, 'round')[0];
      assert.equal(round.children[1].textContent, item.prompt);
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was right').fire('click');
      assert.equal(store.points, 2 * POINTS_CORRECT + POINTS_RETURN, '10 for the answer, 5 for the week away');
      assert.deepEqual(store.items[item.id], { a: 2, c: 2, ema: 0.625, last: today });
      clock.tick(CONFIRM_DELAY);
      assert.equal(byClass(round, 'points')[0].textContent, `+${POINTS_CORRECT + POINTS_RETURN} pt`);
      teardown();
    });
  });
});

test('the reveal Game keeps the shared bounded history and windows its statistics', () => {
  const today = epochDay();
  const item = verbItem('cercare');
  const store = {};

  // Five production rounds in one local day: one daily bucket that accumulates, one weekly
  // snapshot — the history is per local day and per local week, never per attempt.
  for (let n = 0; n < 5; n += 1) recordAttempt(store, item, n % 2 === 0, { now: atDay(today), items: [item] });
  assert.equal(store.days.length, 1);
  assert.deepEqual([store.days[0].a, store.days[0].c], [5, 3]);
  assert.equal(store.weeks.length, 1, 'one snapshot per local week');

  // Two hundred days of production practice: the history is bounded, the total is not.
  const aged = {};
  for (let day = today - 199; day <= today; day += 1) {
    recordAttempt(aged, item, true, { now: atDay(day), items: [item] });
  }
  assert.equal(aged.days.length, DAILY_BUCKETS, 'only the last 90 daily buckets are kept');
  assert.equal(aged.weeks.length, WEEKLY_SNAPSHOTS, 'at most 26 weekly snapshots are kept');
  assert.equal(aged.points, 200 * POINTS_CORRECT, 'the total is not bounded');

  // The view that reads it draws the documented 30-local-day window, never the whole store.
  const stats = statsFor(aged, [item], atDay(today));
  assert.equal(stats.cumulative.length, POINTS_WINDOW);
  assert.equal(stats.cumulative[POINTS_WINDOW - 1], stats.points, 'the line ends at the total');
  assert.equal(stats.daily.length, POINTS_WINDOW, 'one point per day with attempts, in the last 30 days');
  assert.equal(stats.accuracy.pct, 100);
  assert.deepEqual(stats.weakest.map((entry) => entry.id), [item.id]);
});

test('the reveal Game’s statistics read its whole corpus, never the round’s filtered pool', () => {
  const today = epochDay();
  const inPool = { ...verbItem('a'), tags: ['class:-are', 'person:1s'] };
  const outside = { ...verbItem('b'), tags: ['class:-isc', 'person:2s'] };
  const corpus = [inPool, outside];
  const store = {};
  // `outside` was practised in an earlier round and the corpus still carries it, while this
  // round’s settings keep `-are` only — so it can never be drawn now and must still be counted.
  recordAttempt(store, outside, true, { now: atDay(today), items: corpus });
  recordAttempt(store, taggedVerb('gone', ['class:-ere']), true, { now: atDay(today), items: corpus });
  const session = rivelaSession(corpus, 1, {
    store,
    settings: { preset: null, include: { class: ['-are'] }, controls: { count: 1 } },
  });
  assert.deepEqual(session.pool.map((entry) => entry.id), [inPool.id], 'the pool really is narrower than the corpus');

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteRivelaGame.play(root, session);
      const stats = byClass(root, 'stats')[0];
      // The excluded Item still counts: its Tags have rows and it is the weakest Item on screen.
      const rows = byClass(stats, 'stat-rows')[0].children;
      assert.deepEqual(rows.map((row) => row.children[0].textContent), ['class:-isc', 'person:2s']);
      assert.deepEqual(rows.map((row) => row.children[2].textContent), ['25%', '25%']);
      assert.deepEqual(byTag(stats, 'li').map((node) => node.textContent), [`${outside.prompt} · 25%`]);
      // An Item the corpus no longer has keeps its stored entry and stays out of both views, while
      // its points remain the Game’s.
      assert.ok(store.items.gone, 'the removed Item keeps its stored entry');
      assert.equal(byClass(stats, 'stat')[0].textContent, `${2 * POINTS_CORRECT} pt`);
      assert.equal(byTag(stats, 'li').length, 1, 'the removed Item is not a weakest Item');

      // The attempt this round writes is snapshotted against the whole corpus too: on a fresh
      // store the week’s Tag snapshot must carry the excluded Item’s Tag, which a pool-only
      // snapshot could not know.
      const roundStore = {};
      const roundSession = rivelaSession(corpus, 1, {
        store: roundStore,
        settings: { preset: null, include: { class: ['-are'] }, controls: { count: 1 } },
      });
      const roundRoot = doc.createElement('div');
      const roundTeardown = verbiPresenteRivelaGame.play(roundRoot, roundSession);
      const round = byClass(roundRoot, 'round')[0];
      const asked = askedItem(round, roundSession.pool);
      assert.equal(asked.id, inPool.id, 'the filtered pool is the only thing this round can draw');
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was right').fire('click');
      clock.tick(CONFIRM_DELAY);
      assert.deepEqual(roundStore.items[asked.id], { a: 1, c: 1, ema: 0.25, last: today });
      assert.deepEqual(Object.keys(roundStore.weeks[0].tags).sort(), [
        'class:-are',
        'class:-isc',
        'person:1s',
        'person:2s',
      ]);
      roundTeardown();
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

test('a production round writes only the reveal Game’s slice, and recognition keeps its own', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const choiceStore = storage.store('verbi-presente');
  const revealStore = storage.store('verbi-presente-rivela');
  const today = epochDay();
  const pool = verbItems.slice(0, 2);

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteRivelaGame.play(root, rivelaSession(pool, 1, { store: revealStore }));
      const round = byClass(root, 'round')[0];
      const asked = askedItem(round, pool);
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was right').fire('click');
      clock.tick(CONFIRM_DELAY);

      // The attempt is production’s, on the spot, and only production’s.
      assert.deepEqual(revealStore.items[asked.id], { a: 1, c: 1, ema: 0.25, last: today });
      assert.equal(masteryOf(choiceStore, asked.id, today), 0, 'recognition has never seen this Item');
      assert.equal(masteryOf(revealStore, asked.id, today), 0.25);
      assert.equal(choiceStore.items, undefined, 'recognition’s slice is untouched');
      const games = backend.envelope().data.games;
      assert.deepEqual(games['verbi-presente-rivela'].store.items[asked.id], { a: 1, c: 1, ema: 0.25, last: today });
      assert.equal(games['verbi-presente'].store.items, undefined, 'nothing leaked into recognition’s persisted slice');

      // The two Games draw the same pool differently, which is the point of separate stores: the
      // practised Item sinks in production and stays where it was in recognition.
      const drawOf = (/** @type {any} */ store) =>
        roundQueue(pool, { size: 2, rng: () => 0.5, store, today }).map((entry) => entry.id);
      assert.deepEqual(drawOf(choiceStore), pool.map((entry) => entry.id), 'uniform over an empty store');
      assert.equal(drawOf(revealStore)[1], asked.id, 'production sends it to the back');
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

test('the reveal Game’s own Statistics view swaps with the round, and Summary returns to it', () => {
  const pool = verbItems.slice(0, 2);
  const store = {};

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = verbiPresenteRivelaGame.play(root, rivelaSession(pool, 1, { store }));
      const round = byClass(root, 'round')[0];
      const stats = byClass(root, 'stats')[0];
      assert.ok(stats, 'the Game draws its own statistics view');
      assert.equal(stats.hidden, true, 'and keeps it out of the round until it is asked for');
      assert.equal(round.hidden, false);

      // Cold, before the round writes anything: the four documented empty states, never a NaN.
      assert.deepEqual(byTag(stats, 'h2').map((head) => head.textContent), [
        'Points',
        'Accuracy',
        'Skills by Tag',
        'Weakest items',
      ]);
      assert.deepEqual(byClass(stats, 'stat').map((node) => node.textContent), [
        '0 points',
        'No attempts in the last 7 days',
      ]);
      assert.equal(byClass(stats, 'delta')[0].hidden, true);
      assert.deepEqual(
        byClass(stats, 'stat-rows')[0].children.map((node) => node.textContent),
        ['No tagged attempts yet'],
      );
      assert.deepEqual(byTag(stats, 'li').map((node) => node.textContent), ['No attempts yet']);
      const coldCharts = byClass(stats, 'chart');
      assertWellFormedSvg(coldCharts[0].innerHTML);
      assertSilent(coldCharts[0].innerHTML);
      assert.equal(coldCharts[1].innerHTML, '', 'no day with attempts means no daily line');

      // One revealed question, graded wrong, then the loop’s own 250 ms confirm.
      const asked = askedItem(round, pool);
      revealButton(round, 'Show answer').fire('click');
      revealButton(round, 'I was wrong').fire('click');
      clock.tick(CONFIRM_DELAY);
      const summary = byClass(round, 'summary')[0];
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '0/1');
      assert.deepEqual(
        nodesOf(summary).filter((node) => node.tagName === 'BUTTON').map((button) => button.textContent),
        ['Play again', 'Statistics'],
        'the Game’s own action sits beside Play again, before the host’s Done',
      );
      assert.equal(nodesOf(summary).filter((node) => node.tagName === 'A')[0].textContent, 'Done');

      // Statistics is not a route and not a link: it swaps the Game’s two views in place.
      nodesOf(summary).filter((node) => node.tagName === 'BUTTON' && node.textContent === 'Statistics')[0].fire('click');
      assert.equal(round.hidden, true);
      assert.equal(stats.hidden, false);
      assert.equal(byTag(stats, 'a').length, 0, 'the view carries no navigation at all');
      assert.equal(byClass(stats, 'back').length, 0, 'the host still owns the only quit control');
      assert.equal(byClass(stats, 'stat')[1].textContent, '0%', 'refreshed from the store the round just wrote');
      assert.deepEqual(byTag(stats, 'li').map((node) => node.textContent), [`${asked.prompt} · 0%`], 'the Item just graded wrong leads');
      assert.equal(byClass(stats, 'chart')[1].innerHTML, '', 'one day with attempts is not a line');
      assert.match(byClass(stats, 'note')[1].textContent, /^1 day with attempts/);

      // Summary returns to the very same round summary: same score, same queue, no navigation.
      nodesOf(stats)
        .filter((node) => node.tagName === 'BUTTON' && node.textContent === 'Summary')[0]
        .fire('click');
      assert.equal(stats.hidden, true);
      assert.equal(round.hidden, false);
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '0/1');

      // Play again still samples a fresh queue in place, and records nothing until it is graded.
      nodesOf(summary).filter((node) => node.textContent === 'Play again')[0].fire('click');
      assert.equal(round.getAttribute('data-state'), 'ask');
      assert.equal(store.items[asked.id].a, 1);
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

// --------------------------------- the noun choice Game (js/games/nomi-plurale/index.js)

/** A noun Item, the way the corpus hands one over. @param {string} id @param {number} [mastery] */
const nounItem = (id, mastery = 0) => ({
  id,
  prompt: `il ${id} → i ___`,
  answer: `${id}i`,
  distractors: [`${id}o`, `${id}e`, `${id}a`],
  tags: ['gender:m', 'plural:-o/-i'],
  mastery,
});

/** The shipped noun corpus, read once: the Game's own Item mapping is checked against the real file. */
const nounItems = JSON.parse(
  readFileSync(fileURLToPath(new URL('../content/nomi-plurale.json', import.meta.url)), 'utf8'),
);

/** A whole noun round's Session, built the way boot builds one. @param {any[]} items */
const nounSession = (items, count, extra = {}) =>
  createSession(nomiPluraleGame, {
    content: items,
    settings: { preset: null, include: {}, controls: { count } },
    rng: createRng(3),
    store: null,
    ...extra,
  });

test('the noun Game draws the same weighted, without-replacement queue', () => {
  const today = epochDay();
  const pool = [nounItem('libro', 0.9), nounItem('casa', 0), nounItem('cane', 0.5), nounItem('film', 0)];
  const store = {
    items: Object.fromEntries(pool.map((entry) => [entry.id, { ema: entry.mastery, last: today }])),
  };

  // The same Efraimidis–Spirakis key the verb Games use: with a constant RNG the draw order *is*
  // the weight order, weakest first, ties kept in pool order.
  const queue = roundQueue(pool, { size: 4, rng: () => 0.5, store, today });
  assert.deepEqual(queue.map((entry) => entry.id), ['casa', 'film', 'cane', 'libro']);

  // The round length is the choice, clamped by the pool; no Item can repeat in a round.
  assert.equal(roundQueue(pool, { size: 20, rng: () => 0.5, store, today }).length, 4, 'min(count, pool)');
  assert.deepEqual(roundQueue([], { size: 5, rng: () => 0.5, store, today }), [], 'an empty pool has no queue');
  for (const seed of [1, 7, 99]) {
    const full = roundQueue(pool, { size: 4, rng: createRng(seed), store, today });
    assert.equal(full.length, 4);
    assert.equal(new Set(full.map((entry) => entry.id)).size, 4, 'drawn without replacement');
  }
});

test('the noun Game reads mastery from its own store, never a verb Game\u2019s', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const nounStore = storage.store('nomi-plurale');
  const choiceStore = storage.store('verbi-presente');
  const revealStore = storage.store('verbi-presente-rivela');
  assert.equal(new Set([nounStore, choiceStore, revealStore]).size, 3, 'each Game id owns its own slice');

  const today = epochDay();
  const pool = [nounItem('libro'), nounItem('casa'), nounItem('cane'), nounItem('film')];
  // Both verb Games have practiced different nouns; the noun Game has no history at all.
  choiceStore.items = { libro: { ema: 1, last: today }, casa: { ema: 1, last: today } };
  revealStore.items = { cane: { ema: 1, last: today } };

  const draw = (/** @type {any} */ store) =>
    roundQueue(pool, { size: 4, rng: () => 0.5, store, today }).map((entry) => entry.id);
  assert.deepEqual(draw(nounStore), ['libro', 'casa', 'cane', 'film'], 'an empty noun store leaves the pool order alone');
  assert.deepEqual(draw(nounStore), draw(storage.store('nomi-plurale')), 'nothing leaked in from either verb Game');

  // A write through one Game's slice is invisible in the other two, so the three sets of counters
  // and the three histories can never be averaged together.
  nounStore.items = { cane: { a: 2, c: 1, ema: 1, last: today } };
  assert.equal(choiceStore.items.cane, undefined, 'noun progress stays out of recognition');
  assert.deepEqual(revealStore.items.cane, { ema: 1, last: today }, 'production keeps its own cane');
  assert.deepEqual(backend.envelope().data.games['nomi-plurale'].store.items, {
    cane: { a: 2, c: 1, ema: 1, last: today },
  });
  assert.deepEqual(backend.envelope().data.games['verbi-presente'].store.items, {
    libro: { ema: 1, last: today },
    casa: { ema: 1, last: today },
  });
  assert.deepEqual(backend.envelope().data.games['verbi-presente-rivela'].store.items, {
    cane: { ema: 1, last: today },
  });

  // And noun mastery, once written, weights the noun draw — the policy is live, not decorative.
  assert.deepEqual(draw(nounStore), ['libro', 'casa', 'film', 'cane'], 'a mastered noun sinks to the end');
});

test('each noun question offers its own answer plus its three authored distractors', () => {
  const libro = nounItems.find((entry) => entry.id === 'nomi-pl-libro');
  assert.ok(libro, 'the corpus is the real one');
  const question = nounQuestionFor(libro, createRng(5));
  assert.equal(question.prompt, 'il libro → i ___');
  assert.equal(question.answer, 'libri');
  assert.equal(question.options.length, 4, 'four options per question, always');
  assert.deepEqual(
    [...question.options].sort(),
    [libro.answer, ...libro.distractors].sort(),
    'its own answer and its own three distractors',
  );
  assert.equal(new Set(question.options).size, 4, 'never a duplicated option');

  // The order is drawn once, with the Session's RNG, so it is stable for that question.
  assert.deepEqual(nounQuestionFor(libro, createRng(5)).options, question.options);

  // Every shipped Item maps to a four-option question whose options are exactly its own, and the
  // answer is not parked in the first row.
  const rng = createRng(11);
  let firstRowIsAnswer = 0;
  for (const item of nounItems) {
    const asked = nounQuestionFor(item, rng);
    assert.equal(asked.options.length, 4, `${item.id} asks four options`);
    assert.deepEqual([...asked.options].sort(), [item.answer, ...item.distractors].sort(), `${item.id} offers its own four`);
    if (asked.options[0] === item.answer) firstRowIsAnswer += 1;
  }
  assert.ok(firstRowIsAnswer >= 12 && firstRowIsAnswer <= 66, `the answer started in row one ${firstRowIsAnswer}/130 times`);
});

test('the noun Game plays a choice round of the chosen length, judged in the loop', () => {
  const pool = nounItems.slice(0, 8);
  const session = nounSession(pool, 5);
  assert.equal(session.pool.length, 8);

  withFakeDocument((doc) => {
    const root = doc.createElement('div');
    const teardown = nomiPluraleGame.play(root, session);
    const round = byClass(root, 'round')[0];
    assert.ok(round, 'the Game draws the shared round markup');
    assert.equal(round.getAttribute('data-state'), 'ask');
    assert.equal(round.children[0].children[1].textContent, '1/5', 'the chosen five, not the pool of eight');
    assert.equal(byClass(round, 'back').length, 0, 'the Game draws no quit control \u2014 the host owns that');

    const options = nodesOf(round).filter((node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'));
    assert.equal(options.length, 4, 'four option rows exist before the first question is read');
    const asked = pool.find((entry) => entry.prompt === round.children[1].textContent);
    assert.ok(asked, 'the question is one of the pool\u2019s own Items');
    const labels = options.map((button) => button.textContent);
    assert.deepEqual([...labels].sort(), [asked.answer, ...asked.distractors].sort(), 'its own four options');

    // The Game judges nothing itself: the shared loop reads the correct answer out of the option
    // rows, which is why a wrong tap still shows `giusto: <answer>`.
    const answerAt = labels.indexOf(asked.answer);
    const wrongAt = labels.findIndex((label) => label !== asked.answer);
    options[wrongAt].fire('click');
    assert.equal(round.getAttribute('data-state'), 'feedback');
    assert.equal(byClass(round, 'status')[0].textContent, `giusto: ${asked.answer}`);
    assert.equal(options[answerAt].className, 'opt correct');
    assert.equal(options[wrongAt].className, 'opt wrong');

    // The host back control runs this teardown, so leaving a round mid-feedback cancels the
    // pending advance and empties the node the Game was handed.
    teardown();
    assert.equal(root.children.length, 0);

    // A right tap, over a one-Item pool: the loop judges a choice by `option === answer`, so the
    // comments on screen are the documented Italian ones, not a Game-local vocabulary.
    const one = nounItems.slice(0, 1);
    const rightRoot = doc.createElement('div');
    const rightTeardown = nomiPluraleGame.play(rightRoot, nounSession(one, 5));
    const rightRound = byClass(rightRoot, 'round')[0];
    assert.equal(rightRound.children[0].children[1].textContent, '1/1', 'min(count, pool), through the real round');
    const answerButton = nodesOf(rightRound)
      .filter((node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'))
      .find((button) => button.textContent === one[0].answer);
    answerButton.fire('click');
    assert.equal(rightRound.getAttribute('data-state'), 'feedback');
    assert.equal(byClass(rightRound, 'status')[0].textContent, 'corretto');
    rightTeardown();
    assert.equal(rightRoot.children.length, 0);
  });
});

test('a thin noun pool is the round, and an empty one summarises 0/0', () => {
  withFakeDocument((doc) => {
    const thin = doc.createElement('div');
    const thinTeardown = nomiPluraleGame.play(thin, nounSession(nounItems.slice(0, 3), 20));
    assert.equal(byClass(thin, 'round')[0].children[0].children[1].textContent, '1/3');
    thinTeardown();

    // The settings screen refuses to start an empty pool; if a round is entered anyway it
    // summarises 0/0 instead of asking anything.
    const empty = doc.createElement('div');
    const emptyTeardown = nomiPluraleGame.play(empty, nounSession([], 10));
    const round = byClass(empty, 'round')[0];
    assert.equal(round.getAttribute('data-state'), 'summary');
    assert.equal(byClass(round, 'score')[0].textContent, '0/0');
    assert.ok(
      nodesOf(round).filter((node) => node.className.startsWith('opt')).every((button) => button.textContent === ''),
      'no question was ever asked',
    );
    emptyTeardown();
  });
});

// ---------------------- the noun choice Game's progress and statistics (US-019)

/** The one option button carrying this label, out of the four rows on screen. */
const nounOption = (/** @type {any} */ round, /** @type {string} */ label) =>
  nodesOf(round)
    .filter((node) => node.tagName === 'BUTTON' && node.className.startsWith('opt'))
    .find((button) => button.textContent === label);

/** A button carrying this label anywhere under `container`; text concatenates, so match the tag. */
const nounButton = (/** @type {any} */ container, /** @type {string} */ label) =>
  nodesOf(container).filter((node) => node.tagName === 'BUTTON' && node.textContent === label)[0];

/** A noun Item carrying exactly these Tags, for the Tag rows and the weakest-first order. */
const taggedNoun = (/** @type {string} */ id, /** @type {string[]} */ tags) => ({ ...nounItem(id), tags });

test('a noun answer writes the shared counters into the noun Game’s own store', () => {
  const today = epochDay();
  // One Item, so Play again re-draws the very Item whose counters this case follows.
  const pool = nounItems.slice(0, 1);
  const store = {};

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = nomiPluraleGame.play(root, nounSession(pool, 1, { store }));
      const round = byClass(root, 'round')[0];
      const asked = askedItem(round, pool);
      assert.ok(asked, 'the question is one of the pool’s own Items');

      // A wrong answer: the documented unseen-Item start (a=1, c=0, ema=0, stamped today), no
      // points, and this week’s Tag snapshot — written the moment the loop judges the tap.
      nounOption(round, asked.distractors[0]).fire('click');
      assert.deepEqual(store.items[asked.id], { a: 1, c: 0, ema: 0, last: today });
      assert.equal(store.points, 0);
      assert.deepEqual(store.days.map((bucket) => [bucket.d, bucket.a, bucket.c, bucket.p]), [[today, 1, 0, 0]]);
      assert.equal(store.weeks.length, 1, 'and this week’s Tag snapshot');
      clock.tick(WRONG_DELAY);
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '0/1');
      assert.equal(byClass(round, 'points')[0].textContent, '+0 pt', 'a wrong answer earns nothing');

      // Play again draws in place; a right answer compounds the same EMA and earns 10.
      nounButton(byClass(round, 'summary')[0], 'Play again').fire('click');
      assert.equal(askedItem(round, pool).id, asked.id, 'a one-Item pool redraws the same Item');
      nounOption(round, asked.answer).fire('click');
      assert.deepEqual(store.items[asked.id], { a: 2, c: 1, ema: 0.25, last: today });
      assert.equal(store.points, POINTS_CORRECT);
      assert.equal(masteryOf(store, asked.id, today), 0.25, 'the shared mastery read sees the same number');
      clock.tick(CORRECT_DELAY);
      assert.equal(byClass(round, 'points')[0].textContent, `+${POINTS_CORRECT} pt`);
      teardown();
      assert.equal(root.children.length, 0);
    });
  });

  // A Session built without a store is still a round: the points show, nothing is written.
  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = nomiPluraleGame.play(root, nounSession(pool, 1));
      const round = byClass(root, 'round')[0];
      const asked = askedItem(round, pool);
      nounOption(round, asked.answer).fire('click');
      clock.tick(CORRECT_DELAY);
      assert.equal(byClass(round, 'points')[0].textContent, `+${POINTS_CORRECT} pt`);
      teardown();
    });
  });
});

test('a week away from a noun earns the shared recency bonus, through the real Game', () => {
  const today = epochDay();
  const item = nounItems[0];
  // The noun was answered correctly ten local days ago; this round answers it right again, so the
  // +5 for coming back is what the shared policy adds — not a copy of it living in this Game.
  const store = { items: { [item.id]: { a: 1, c: 1, ema: 0.5, last: today - 10 } }, points: POINTS_CORRECT };

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = nomiPluraleGame.play(root, nounSession([item], 1, { store }));
      const round = byClass(root, 'round')[0];
      assert.equal(round.children[1].textContent, item.prompt);
      nounOption(round, item.answer).fire('click');
      assert.equal(store.points, 2 * POINTS_CORRECT + POINTS_RETURN, '10 for the answer, 5 for the week away');
      assert.deepEqual(store.items[item.id], { a: 2, c: 2, ema: 0.625, last: today });
      clock.tick(CORRECT_DELAY);
      assert.equal(byClass(round, 'points')[0].textContent, `+${POINTS_CORRECT + POINTS_RETURN} pt`);
      teardown();
    });
  });
});

test('the noun Game keeps the shared bounded history and windows its statistics', () => {
  const today = epochDay();
  const item = nounItems[0];
  const store = {};

  // Five noun rounds in one local day: one daily bucket that accumulates, one weekly snapshot —
  // the history is per local day and per local week, never per attempt.
  for (let n = 0; n < 5; n += 1) recordAttempt(store, item, n % 2 === 0, { now: atDay(today), items: [item] });
  assert.equal(store.days.length, 1);
  assert.deepEqual([store.days[0].a, store.days[0].c], [5, 3]);
  assert.equal(store.weeks.length, 1, 'one snapshot per local week');

  // Two hundred days of noun practice: the history is bounded, the total is not.
  const aged = {};
  for (let day = today - 199; day <= today; day += 1) {
    recordAttempt(aged, item, true, { now: atDay(day), items: [item] });
  }
  assert.equal(aged.days.length, DAILY_BUCKETS, 'only the last 90 daily buckets are kept');
  assert.equal(aged.weeks.length, WEEKLY_SNAPSHOTS, 'at most 26 weekly snapshots are kept');
  assert.equal(aged.points, 200 * POINTS_CORRECT, 'the total is not bounded');

  // The view that reads it draws the documented 30-local-day window, never the whole store.
  const stats = statsFor(aged, [item], atDay(today));
  assert.equal(stats.cumulative.length, POINTS_WINDOW);
  assert.equal(stats.cumulative[POINTS_WINDOW - 1], stats.points, 'the line ends at the total');
  assert.equal(stats.daily.length, POINTS_WINDOW, 'one point per day with attempts, in the last 30 days');
  assert.equal(stats.accuracy.pct, 100);
  assert.deepEqual(stats.weakest.map((entry) => entry.id), [item.id]);
});

test('the noun Game’s statistics read its whole corpus, never the round’s filtered pool', () => {
  const today = epochDay();
  const inPool = taggedNoun('libro', ['gender:m', 'plural:-o/-i']);
  const outside = taggedNoun('camicia', ['gender:f', 'plural:-cia/-gie']);
  const corpus = [inPool, outside];
  const store = {};
  // `outside` was practised in an earlier round and the corpus still carries it, while this
  // round’s settings keep `-o/-i` only — so it can never be drawn now and must still be counted.
  recordAttempt(store, outside, true, { now: atDay(today), items: corpus });
  recordAttempt(store, taggedNoun('nomi-pl-gone', ['gender:m', 'plural:irregolare']), true, { now: atDay(today), items: corpus });
  const session = nounSession(corpus, 1, {
    store,
    settings: { preset: null, include: { plural: ['-o/-i'] }, controls: { count: 1 } },
  });
  assert.deepEqual(session.pool.map((entry) => entry.id), [inPool.id], 'the pool really is narrower than the corpus');

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = nomiPluraleGame.play(root, session);
      const stats = byClass(root, 'stats')[0];
      // The excluded Item still counts: its Tags have rows and it is the weakest Item on screen.
      const rows = byClass(stats, 'stat-rows')[0].children;
      assert.deepEqual(rows.map((row) => row.children[0].textContent), ['gender:f', 'plural:-cia/-gie']);
      assert.deepEqual(rows.map((row) => row.children[2].textContent), ['25%', '25%']);
      assert.deepEqual(byTag(stats, 'li').map((node) => node.textContent), [`${outside.prompt} · 25%`]);
      // An Item the corpus no longer has keeps its stored entry and stays out of both views, while
      // its points remain the Game’s.
      assert.ok(store.items['nomi-pl-gone'], 'the removed Item keeps its stored entry');
      assert.equal(byClass(stats, 'stat')[0].textContent, `${2 * POINTS_CORRECT} pt`);
      assert.equal(byTag(stats, 'li').length, 1, 'the removed Item is not a weakest Item');

      // The attempt this round writes is snapshotted against the whole corpus too: on a fresh
      // store the week’s Tag snapshot must carry the excluded Item’s Tags, which a pool-only
      // snapshot could not know.
      const roundStore = {};
      const roundSession = nounSession(corpus, 1, {
        store: roundStore,
        settings: { preset: null, include: { plural: ['-o/-i'] }, controls: { count: 1 } },
      });
      const roundRoot = doc.createElement('div');
      const roundTeardown = nomiPluraleGame.play(roundRoot, roundSession);
      const round = byClass(roundRoot, 'round')[0];
      const asked = askedItem(round, roundSession.pool);
      assert.equal(asked.id, inPool.id, 'the filtered pool is the only thing this round can draw');
      nounOption(round, asked.answer).fire('click');
      clock.tick(CORRECT_DELAY);
      assert.deepEqual(roundStore.items[asked.id], { a: 1, c: 1, ema: 0.25, last: today });
      assert.deepEqual(Object.keys(roundStore.weeks[0].tags).sort(), [
        'gender:f',
        'gender:m',
        'plural:-cia/-gie',
        'plural:-o/-i',
      ]);
      roundTeardown();
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

test('a noun round writes only the noun Game’s slice, and both verb stores keep theirs', () => {
  const backend = fakeBackend();
  const storage = createStorage(backend);
  const nounStore = storage.store('nomi-plurale');
  const choiceStore = storage.store('verbi-presente');
  const revealStore = storage.store('verbi-presente-rivela');
  const today = epochDay();
  const pool = nounItems.slice(0, 2);

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = nomiPluraleGame.play(root, nounSession(pool, 1, { store: nounStore }));
      const round = byClass(root, 'round')[0];
      const asked = askedItem(round, pool);
      nounOption(round, asked.answer).fire('click');
      clock.tick(CORRECT_DELAY);

      // The attempt is the noun Game’s, on the spot, and only the noun Game’s.
      assert.deepEqual(nounStore.items[asked.id], { a: 1, c: 1, ema: 0.25, last: today });
      assert.equal(masteryOf(choiceStore, asked.id, today), 0, 'recognition has never seen this noun');
      assert.equal(masteryOf(revealStore, asked.id, today), 0, 'nor has production');
      assert.equal(choiceStore.items, undefined, 'recognition’s slice is untouched');
      assert.equal(revealStore.items, undefined, 'production’s slice is untouched');
      const games = backend.envelope().data.games;
      assert.deepEqual(games['nomi-plurale'].store.items[asked.id], { a: 1, c: 1, ema: 0.25, last: today });
      assert.equal(games['verbi-presente'].store.items, undefined, 'nothing leaked into recognition’s persisted slice');
      assert.equal(games['verbi-presente-rivela'].store.items, undefined, 'nothing leaked into production’s');

      // The noun Game’s own numbers weight its own draw: the practised noun sinks in nouns and
      // stays where it was in both verb Games.
      const drawOf = (/** @type {any} */ store) =>
        roundQueue(pool, { size: 2, rng: () => 0.5, store, today }).map((entry) => entry.id);
      assert.deepEqual(drawOf(choiceStore), pool.map((entry) => entry.id), 'uniform over an empty store');
      assert.equal(drawOf(nounStore)[1], asked.id, 'the noun Game sends it to the back');
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

test('the noun Game’s own Statistics view swaps with the round, and Summary returns to it', () => {
  const pool = nounItems.slice(0, 2);
  const store = {};

  withFakeDocument((doc) => {
    withFakeTimers((clock) => {
      const root = doc.createElement('div');
      const teardown = nomiPluraleGame.play(root, nounSession(pool, 1, { store }));
      const round = byClass(root, 'round')[0];
      const stats = byClass(root, 'stats')[0];
      assert.ok(stats, 'the Game draws its own statistics view');
      assert.equal(stats.hidden, true, 'and keeps it out of the round until it is asked for');
      assert.equal(round.hidden, false);

      // Cold, before the round writes anything: the four documented empty states, never a NaN.
      assert.deepEqual(byTag(stats, 'h2').map((head) => head.textContent), [
        'Points',
        'Accuracy',
        'Skills by Tag',
        'Weakest items',
      ]);
      assert.deepEqual(byClass(stats, 'stat').map((node) => node.textContent), [
        '0 points',
        'No attempts in the last 7 days',
      ]);
      assert.equal(byClass(stats, 'delta')[0].hidden, true);
      assert.deepEqual(byClass(stats, 'stat-rows')[0].children.map((node) => node.textContent), [
        'No tagged attempts yet',
      ]);
      assert.deepEqual(byTag(stats, 'li').map((node) => node.textContent), ['No attempts yet']);
      const coldCharts = byClass(stats, 'chart');
      assertWellFormedSvg(coldCharts[0].innerHTML);
      assertSilent(coldCharts[0].innerHTML);
      assert.equal(coldCharts[1].innerHTML, '', 'no day with attempts means no daily line');

      // One question, answered right, then the loop’s own 700 ms advance.
      const asked = askedItem(round, pool);
      nounOption(round, asked.answer).fire('click');
      clock.tick(CORRECT_DELAY);
      const summary = byClass(round, 'summary')[0];
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '1/1');
      assert.deepEqual(
        nodesOf(summary).filter((node) => node.tagName === 'BUTTON').map((button) => button.textContent),
        ['Play again', 'Statistics'],
        'the Game’s own action sits beside Play again, before the host’s Done',
      );
      assert.equal(nodesOf(summary).filter((node) => node.tagName === 'A')[0].textContent, 'Done');

      // Statistics is not a route and not a link: it swaps the Game’s two views in place.
      nounButton(summary, 'Statistics').fire('click');
      assert.equal(round.hidden, true);
      assert.equal(stats.hidden, false);
      assert.equal(byTag(stats, 'a').length, 0, 'the view carries no navigation at all');
      assert.equal(byClass(stats, 'back').length, 0, 'the host still owns the only quit control');
      assert.equal(byClass(stats, 'stat')[0].textContent, `${POINTS_CORRECT} pt`);
      assert.equal(byClass(stats, 'stat')[1].textContent, '100%', 'refreshed from the store the round just wrote');
      assert.deepEqual(
        byTag(stats, 'li').map((node) => node.textContent),
        [`${asked.prompt} · 25%`],
        'the one noun answered so far is the weakest the view knows',
      );
      assert.equal(byClass(stats, 'chart')[1].innerHTML, '', 'one day with attempts is not a line');
      assert.match(byClass(stats, 'note')[1].textContent, /^1 day with attempts/);

      // Summary returns to the very same round summary: same score, same queue, no navigation.
      nounButton(stats, 'Summary').fire('click');
      assert.equal(stats.hidden, true);
      assert.equal(round.hidden, false);
      assert.equal(round.getAttribute('data-state'), 'summary');
      assert.equal(byClass(round, 'score')[0].textContent, '1/1');

      // Play again still samples a fresh queue in place, and records nothing until it is answered.
      nounButton(summary, 'Play again').fire('click');
      assert.equal(round.getAttribute('data-state'), 'ask');
      assert.equal(store.items[asked.id].a, 1);
      teardown();
      assert.equal(root.children.length, 0);
    });
  });
});

// ------------------------------------------------------------- the service worker (sw.js)

/** The deployed shape again: `sw.js` sits at the root of the frozen subpath, which is its scope. */
const SW_ORIGIN = 'https://site.test';
const SW_URL = `${SW_ORIGIN}/giocco/sw.js`;

/** @param {string} url @param {unknown} body @param {{ status?: number }} [options] */
function swResponse(url, body, options = {}) {
  const status = options.status ?? 200;
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    body,
    clone: () => swResponse(url, body, { status }),
  };
}

/**
 * Run the real `sw.js` in a `node:vm` context over `CacheStorage`/`Cache`-shaped fakes, so a case
 * can dispatch the install/activate/fetch events and see what the worker answered, cached and
 * deleted. This is the offline story minus a browser's own HTTP cache and the device.
 */
function swHarness() {
  /** @type {Map<string, Map<string, any>>} */
  const stores = new Map();
  const flags = { skipWaiting: 0, claim: 0 };
  /** @type {string[]} */
  const fetchCalls = [];
  /** @type {Map<string, unknown>} */
  const network = new Map();
  let online = true;

  /** Cache keys are absolute; a relative one resolves against the worker's own URL, as in a browser. */
  const absolute = (/** @type {string} */ url) =>
    url.startsWith('http') ? url : new URL(url, SW_URL).href;

  /** @param {string | { url: string }} input */
  async function fetchImpl(input) {
    const url = absolute(typeof input === 'string' ? input : input.url);
    fetchCalls.push(url);
    if (!online) throw new TypeError('Failed to fetch');
    if (!network.has(url)) return swResponse(url, null, { status: 404 });
    return swResponse(url, network.get(url));
  }

  /** @param {string} name */
  const cacheApi = (name) => {
    const entries = stores.get(name);
    if (!entries) throw new Error(`no such cache: ${name}`);
    return {
      addAll: async (/** @type {string[]} */ urls) => {
        for (const url of urls) {
          const response = await fetchImpl(url);
          if (!response.ok) throw new Error(`precache failed: ${url}`);
          entries.set(absolute(url), response);
        }
      },
      put: async (/** @type {any} */ request, /** @type {any} */ response) => {
        entries.set(absolute(typeof request === 'string' ? request : request.url), response);
      },
      match: async (/** @type {any} */ request) =>
        entries.get(absolute(typeof request === 'string' ? request : request.url)),
    };
  };

  const caches = {
    open: async (/** @type {string} */ name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return cacheApi(name);
    },
    keys: async () => [...stores.keys()],
    delete: async (/** @type {string} */ name) => stores.delete(name),
  };

  /** @type {Record<string, Array<(event: any) => void>>} */
  const listeners = {};
  const self = {
    location: { href: SW_URL, origin: SW_ORIGIN },
    addEventListener: (/** @type {string} */ type, /** @type {any} */ listener) => {
      (listeners[type] ??= []).push(listener);
    },
    skipWaiting: async () => {
      flags.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        flags.claim += 1;
      },
    },
  };

  /** @param {string} type */
  const dispatch = async (type) => {
    /** @type {Array<Promise<unknown>>} */
    const waiting = [];
    const event = { waitUntil: (promise) => waiting.push(promise) };
    for (const listener of listeners[type] ?? []) listener(event);
    await Promise.all(waiting);
  };

  /** @param {{ url: string, method: string, mode: string }} request */
  const dispatchFetch = async (request) => {
    /** @type {Array<Promise<unknown>>} */
    const waiting = [];
    /** @type {Promise<any> | null} */
    let responded = null;
    const event = {
      request,
      respondWith: (/** @type {Promise<any>} */ promise) => {
        responded = promise;
      },
      waitUntil: (/** @type {Promise<unknown>} */ promise) => waiting.push(promise),
    };
    for (const listener of listeners.fetch ?? []) listener(event);
    if (responded === null) {
      return { intercepted: false, response: null, waiting, settle: async () => {} };
    }
    return {
      intercepted: true,
      response: await responded,
      // Background work the worker scheduled (`waitUntil`) — how a case sees that a
      // stale-while-revalidate refresh is actually in flight.
      waiting,
      // A stale-while-revalidate refresh is scheduled *while* the response is produced, so the
      // background work is only awaited here.
      settle: async () => {
        await Promise.resolve();
        await Promise.all(waiting);
      },
    };
  };

  const source = readFileSync(fileURLToPath(new URL('../sw.js', import.meta.url)), 'utf8');
  runInContext(`${source}\nself.__declared = { CACHE, SHELL };`, createContext({ self, caches, fetch: fetchImpl, URL, console }), {
    filename: 'sw.js',
  });

  return {
    source,
    flags,
    fetchCalls,
    listeners: () => Object.keys(listeners),
    declarations: () => self.__declared,
    install: () => dispatch('install'),
    activate: () => dispatch('activate'),
    dispatchFetch,
    /** @param {string} url @param {{ method?: string, mode?: string }} [options] */
    request: (url, options = {}) => ({
      url: absolute(url),
      method: options.method ?? 'GET',
      mode: options.mode ?? 'no-cors',
    }),
    /** What the network will answer with from now on. @param {string} url @param {unknown} body */
    send: (url, body) => network.set(absolute(url), body),
    /** Create another cache, the way a previous deploy's worker would have. */
    openCache: (/** @type {string} */ name) => caches.open(name),
    hasCache: (/** @type {string} */ name) => stores.has(name),
    hasEntry: (/** @type {string} */ name, /** @type {string} */ url) =>
      (stores.get(name) ?? new Map()).has(absolute(url)),
    entries: (/** @type {string} */ name) => [...(stores.get(name) ?? new Map()).keys()],
    cached: (/** @type {string} */ name, /** @type {string} */ url) =>
      (stores.get(name) ?? new Map()).get(absolute(url))?.body,
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
  };
}

const SHELL_URLS = [
  'https://site.test/giocco/',
  'https://site.test/giocco/index.html',
  'https://site.test/giocco/styles.css',
  'https://site.test/giocco/manifest.webmanifest',
];

/** Every request class that must land on the network first. */
const APP_CODE_URLS = [
  'js/app.js',
  'js/lib/roundLoop.js',
  'styles.css',
  'manifest.webmanifest',
  'sw.js',
];

/** Install the shell, the way any case that needs a populated cache starts. */
async function installedSw() {
  const harness = swHarness();
  for (const url of SHELL_URLS) harness.send(url, `shell:${url}`);
  await harness.install();
  return harness;
}

test('sw.js is a classic script with the frozen v0.1 cache name and shell list', () => {
  const harness = swHarness();
  const { CACHE, SHELL } = harness.declarations();

  assert.equal(CACHE, 'giocco-v1', 'the cache name is not renamed in v0.1');
  // `Array.from` copies out of the vm realm, or `deepEqual` compares prototypes across realms.
  assert.deepEqual(Array.from(SHELL), ['./', './index.html', './styles.css', './manifest.webmanifest']);
  assert.deepEqual(
    harness.listeners(),
    ['install', 'activate', 'fetch'],
    'no warm list and no message channel',
  );
  assert.doesNotMatch(harness.source, /^\s*(?:import|export)\s/m, 'classic worker, never a module');
  assert.doesNotMatch(harness.source, /postMessage|addEventListener\(['"]message/);
  assert.doesNotMatch(harness.source, /tools\//, 'the development gate is never cached or shipped');
});

test('install precaches exactly the four shell URLs, and nothing else', async () => {
  const harness = await installedSw();

  assert.deepEqual(harness.entries('giocco-v1'), SHELL_URLS);
  assert.deepEqual(harness.fetchCalls, SHELL_URLS, 'the shell is the whole precache');
  assert.equal(harness.flags.skipWaiting, 1, 'the new worker takes over on install');
});

test('activate drops every older cache and claims the open clients', async () => {
  const harness = await installedSw();
  await harness.openCache('giocco-v0');

  await harness.activate();

  assert.equal(harness.hasCache('giocco-v0'), false, 'the previous cache name is deleted');
  assert.equal(harness.hasCache('giocco-v1'), true);
  assert.deepEqual(harness.entries('giocco-v1'), SHELL_URLS, 'the current cache survives');
  assert.equal(harness.flags.claim, 1);
});

test('a navigation is answered from the cached shell, and the network only as a last resort', async () => {
  const harness = await installedSw();
  const settled = harness.fetchCalls.length;

  harness.offline();
  const offline = await harness.dispatchFetch(
    harness.request('https://site.test/giocco/a/deep/link', { mode: 'navigate' }),
  );
  assert.equal(offline.intercepted, true);
  assert.equal(offline.response.body, `shell:${SHELL_URLS[1]}`, 'never a browser error page');
  assert.equal(harness.fetchCalls.length, settled, 'a navigation never waits on the network');

  harness.online();
  const online = await harness.dispatchFetch(
    harness.request('https://site.test/giocco/', { mode: 'navigate' }),
  );
  assert.equal(online.response.body, `shell:${SHELL_URLS[1]}`, 'the cached shell wins online too');
  assert.equal(harness.fetchCalls.length, settled);

  // Before the worker has installed, a navigation is still the network's job.
  const cold = swHarness();
  cold.send('https://site.test/giocco/', 'live page');
  const fresh = await cold.dispatchFetch(
    cold.request('https://site.test/giocco/', { mode: 'navigate' }),
  );
  assert.equal(fresh.response.body, 'live page');
});

test('app code is network-first, with the cache as the offline fallback', async () => {
  const harness = await installedSw();
  for (const url of APP_CODE_URLS) harness.send(url, `${url}:v1`);

  for (const url of APP_CODE_URLS) {
    const first = await harness.dispatchFetch(harness.request(url));
    assert.equal(first.response.body, `${url}:v1`, `${url} comes from the network`);
    assert.equal(harness.cached('giocco-v1', url), `${url}:v1`, `${url} is cached as it passes`);
  }

  harness.send('js/app.js', 'js/app.js:v2');
  const fixed = await harness.dispatchFetch(harness.request('js/app.js'));
  assert.equal(fixed.response.body, 'js/app.js:v2', 'a fix lands on the first online load');
  assert.equal(harness.cached('giocco-v1', 'js/app.js'), 'js/app.js:v2');

  harness.offline();
  for (const url of APP_CODE_URLS) {
    const cached = await harness.dispatchFetch(harness.request(url));
    assert.equal(cached.response.body, harness.cached('giocco-v1', url), `${url} falls back to cache`);
  }
  await assert.rejects(
    () => harness.dispatchFetch(harness.request('js/never-seen.js')).then((result) => result.response),
    'offline with nothing cached is a network error, not a wrong response',
  );
});

test('other same-origin content is stale-while-revalidate', async () => {
  const harness = await installedSw();
  const url = 'content/verbi-presente.json';

  harness.send(url, 'corpus v1');
  const miss = await harness.dispatchFetch(harness.request(url));
  assert.equal(miss.response.body, 'corpus v1', 'a miss fetches and caches');
  assert.equal(harness.cached('giocco-v1', url), 'corpus v1');
  assert.equal(miss.waiting.length, 0, 'a miss has nothing to refresh in the background');

  harness.send(url, 'corpus v2');
  const stale = await harness.dispatchFetch(harness.request(url));
  assert.equal(stale.response.body, 'corpus v1', 'the cached copy is served at once');
  assert.equal(stale.waiting.length, 1, 'the refresh is kept alive as a background task');
  await stale.settle();
  assert.equal(harness.cached('giocco-v1', url), 'corpus v2', 'the refresh rewrote the cache behind it');

  const next = await harness.dispatchFetch(harness.request(url));
  assert.equal(next.response.body, 'corpus v2', 'a corpus edit appears on the next load');

  harness.offline();
  harness.send(url, 'unreachable');
  const offline = await harness.dispatchFetch(harness.request(url));
  assert.equal(offline.response.body, 'corpus v2', 'offline answers from the cache');
  await offline.settle(); // the failed background refresh must not reject or clobber the cache
  assert.equal(harness.cached('giocco-v1', url), 'corpus v2');
});

test('a non-GET or cross-origin request is left to the network', async () => {
  const harness = await installedSw();
  const settled = harness.fetchCalls.length;

  const post = await harness.dispatchFetch(harness.request('content/x.json', { method: 'POST' }));
  assert.equal(post.intercepted, false);
  const other = await harness.dispatchFetch(
    harness.request('https://other.test/giocco/content/x.json'),
  );
  assert.equal(other.intercepted, false);
  assert.equal(harness.fetchCalls.length, settled, 'not ours to handle, so not ours to fetch');
});

test('the shell hands boot one #app root and one module entry, and boot’s imports stay relative', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(html, /<div id="app"><\/div>/);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(scripts.length, 1, 'one module entry, no second script tag');
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="\.\/js\/app\.js"/);

  const source = readFileSync(fileURLToPath(new URL('../js/app.js', import.meta.url)), 'utf8');
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'boot has a module graph');
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('./'), `${specifier} is relative to the deployed subpath`);
    assert.doesNotMatch(specifier, /tools|check/, `${specifier} is not the development gate`);
  }
});

// ------------------------------------------------------------- the deployed shape (US-020)

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every `.js` file under a directory, in directory order. @param {string} dir */
function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** A relative URL is one a `/giocco/` deploy keeps inside its scope. @param {string} url */
const isRelativeUrl = (url) => !url.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(url);

/** The import specifiers of one source file, so a prose quote is never mistaken for an import. */
const importSpecifiers = (source) =>
  [
    ...source.matchAll(/^\s*(?:import|export)\b[^\n]*?from\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);

test('the deployed shape: every shipped URL is relative, and no development gate is wired in', () => {
  // `.nojekyll` is what keeps GitHub Pages from running Jekyll over the deployed subpath.
  assert.equal(existsSync(path.join(REPO_ROOT, '.nojekyll')), true, 'the site root carries .nojekyll');

  const html = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(refs.length > 0, 'the shell references its assets');
  for (const ref of refs) {
    assert.ok(isRelativeUrl(ref), `${ref} is absolute, so it would leave the /giocco/ subpath`);
    assert.equal(existsSync(path.join(REPO_ROOT, ref)), true, `${ref} is missing under the site root`);
    assert.doesNotMatch(ref, /tools\/|node_modules/, `${ref} is a development path`);
  }

  for (const file of jsFiles(path.join(REPO_ROOT, 'js'))) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      const where = path.relative(REPO_ROOT, file);
      assert.ok(isRelativeUrl(specifier), `${where} imports absolute ${specifier}`);
      assert.doesNotMatch(specifier, /tools\/|node_modules/, `${where} imports a development gate`);
      assert.equal(
        existsSync(path.resolve(path.dirname(file), specifier)),
        true,
        `${where} imports a module that is not on disk`,
      );
    }
  }

  // A Game's declared `content` is resolved against the site root at boot (`engine.js`), so an
  // absolute path would pass every other gate here and then 404 beneath `/giocco/`.
  for (const game of GAMES) {
    const declared = game.content;
    if (declared === undefined) continue;
    const paths = typeof declared === 'string' ? [declared] : Object.values(declared);
    for (const entry of paths) {
      assert.ok(isRelativeUrl(entry), `${game.id} declares the absolute content path ${entry}`);
      assert.doesNotMatch(entry, /tools\/|node_modules/, `${game.id} declares a development path`);
      assert.equal(
        existsSync(path.join(REPO_ROOT, entry)),
        true,
        `${game.id} declares content that is not on disk: ${entry}`,
      );
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './', 'the installed app starts inside the subpath');
  assert.equal(manifest.scope, './', 'the installed app is scoped to the subpath');
  for (const icon of manifest.icons) {
    assert.ok(isRelativeUrl(icon.src), `${icon.src} is absolute`);
    assert.equal(existsSync(path.join(REPO_ROOT, icon.src)), true, `${icon.src} is missing`);
  }

  // `sw.js` at the site root is exactly what gives the worker its `/giocco/` scope, and its
  // precache list is the only thing a first online load needs before the app code caches itself.
  const worker = readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');
  const shell = worker.match(/const SHELL = (\[[^\]]*\]);/);
  assert.ok(shell, 'sw.js keeps its one SHELL literal');
  assert.deepEqual(JSON.parse(shell[1].replace(/'/g, '"')), [
    './',
    './index.html',
    './styles.css',
    './manifest.webmanifest',
  ]);
  assert.doesNotMatch(shell[1], /tools\/|node_modules/);
  assert.equal(worker.includes('type: \'module\''), false, 'the worker stays classic');
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
