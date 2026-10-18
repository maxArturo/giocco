/**
 * Deterministic Node-level sanity checks for the host modules that are pure enough to run
 * without a DOM: `js/storage.js` today, the engine / router / round loop / charts as they
 * land. Run by `npm test` (or `node tools/sanity.mjs`).
 *
 * Dependency-free `node:assert` only — the project ships no test framework. Behaviour that
 * needs a browser (boot, offline, rendering) is verified manually instead; see AGENTS.md.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEY, VERSION, createStorage, migrate } from '../js/storage.js';

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

/** @type {Array<{ name: string, run: () => void }>} */
const cases = [];
const test = (name, run) => cases.push({ name, run });

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

/** @returns {boolean} true when every case passed */
export function runSanity() {
  let passed = 0;
  const failed = [];
  for (const { name, run } of cases) {
    try {
      run();
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
  process.exit(runSanity() ? 0 : 1);
}
