/**
 * Fixture suite for the structural gate: `npm test` (or `node tools/check.mjs --selftest`).
 *
 * Every case builds a throwaway repository root in the OS temp directory with a Game
 * declaration and a content file, runs `check()` over it, and asserts that the gate rejects
 * exactly the structural error it is about. Dependency-free `node:assert` only — the project
 * ships no test framework.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_FIELDS, check } from './check.mjs';

const GAME = Object.freeze({
  id: 'demo',
  title: 'Demo',
  content: './content/demo.json',
  fields: DEFAULT_FIELDS,
  dims: [{ dim: 'unit', values: ['u1'], label: 'Unit' }],
});

/** One well-formed Item; `over` bends it into the malformed shape a case is about. */
function item(n, over = {}) {
  return {
    id: `i${n}`,
    prompt: `prompt ${n}`,
    answer: `answer ${n}`,
    distractors: [`d${n}a`, `d${n}b`, `d${n}c`],
    tags: ['unit:u1'],
    ...over,
  };
}

const items = (n) => Array.from({ length: n }, (_, index) => item(index + 1));

async function write(root, relPath, contents) {
  const target = path.join(root, relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

const writeGame = (root, game, dir = game.id) =>
  write(root, `js/games/${dir}/index.js`, `// @ts-check\nexport default ${JSON.stringify(game)};\n`);
const writeContent = (root, name, data) => write(root, `content/${name}.json`, data);

const has = (report, needle) => report.errors.some((error) => error.includes(needle));

/** @param {{ errors: string[] }} report @param {string} needle @param {string} about */
function expect(report, needle, about) {
  assert.ok(has(report, needle), `${about}: expected an error containing ${JSON.stringify(needle)}, got:\n${report.errors.map((e) => `  ${e}`).join('\n') || '  (no errors)'}`);
}

/** @type {Array<{ name: string, run: (root: string) => Promise<void> }>} */
const cases = [];
const test = (name, run) => cases.push({ name, run });

// ---------------------------------------------------------------- happy paths

test('an empty repository is a successful check', async (root) => {
  const report = await check(root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.filesChecked, 0);
  assert.equal(report.games, 0);
});

test('valid content against one Game passes', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5));
  const report = await check(root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.filesChecked, 1);
  assert.equal(report.itemsChecked, 5);
});

test('a Game declaring content that is not authored yet only warns', async (root) => {
  await writeGame(root, GAME);
  const report = await check(root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 1);
  assert.ok(report.warnings[0].includes('does not exist yet'));
});

test('JS under js/ carrying // @ts-check is accepted', async (root) => {
  await write(root, 'js/lib/x.js', "// @ts-check\n/** @type {string} */\nexport const x = 'x';\n");
  const report = await check(root);
  assert.deepEqual(report.errors, []);
});

// ------------------------------------------------------------- file and Item shape

test('a content file that is not JSON is rejected', async (root) => {
  await writeGame(root, GAME);
  await write(root, 'content/demo.json', '{ not json');
  expect(await check(root), 'is not valid JSON', 'invalid JSON');
});

test('a content file that is not an array is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', { items: [] });
  expect(await check(root), 'must be a JSON array', 'non-array');
});

test('an empty content array is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', []);
  expect(await check(root), 'must be a non-empty array', 'empty array');
});

test('an unexpected Item field is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, hint: 'oops' } : it)));
  expect(await check(root), 'unexpected field "hint"', 'extra field');
});

test('a missing Item field is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { id: it.id, prompt: it.prompt, answer: it.answer, distractors: it.distractors } : it)));
  expect(await check(root), 'missing field "tags"', 'missing field');
});

test('an empty string in a declared field is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, prompt: '   ' } : it)));
  expect(await check(root), '"prompt" must be a non-empty string', 'blank string');
});

test('duplicate file-local Item ids are rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it) => ({ ...it, id: 'same' })));
  expect(await check(root), 'duplicate Item id "same"', 'duplicate id');
});

// ------------------------------------------------------------------------- tags

test('a tag outside the declared vocabulary is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, tags: ['unit:u1', 'topic:greetings'] } : it)));
  expect(await check(root), 'uses dimension "topic"', 'undeclared dimension');
});

test('a tag value outside the declared vocabulary is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, tags: ['unit:u9'] } : it)));
  expect(await check(root), 'uses value "u9"', 'undeclared value');
});

test('a duplicated tag is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, tags: ['unit:u1', 'unit:u1'] } : it)));
  expect(await check(root), 'duplicate tag "unit:u1"', 'duplicate tag');
});

test('two tags for one dimension are rejected', async (root) => {
  const game = { ...GAME, dims: [{ dim: 'unit', values: ['u1', 'u2'] }] };
  await writeGame(root, game);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, tags: ['unit:u1', 'unit:u2'] } : it)));
  expect(await check(root), 'more than one tag for dimension "unit"', 'repeated dimension');
});

test('a missing tag for a declared dimension is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, tags: [] } : it)));
  expect(await check(root), 'missing tag for declared dimension "unit"', 'missing dimension');
});

// ------------------------------------------------------------------- distractors

test('a wrong distractor count is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, distractors: ['d1a', 'd1b'] } : it)));
  expect(await check(root), 'exactly 3 non-empty strings', 'two distractors');
});

test('an empty distractor is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, distractors: ['', 'd1b', 'd1c'] } : it)));
  expect(await check(root), 'exactly 3 non-empty strings', 'blank distractor');
});

test('duplicate distractors are rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, distractors: ['d1a', 'd1a', 'd1b'] } : it)));
  expect(await check(root), 'must be distinct', 'duplicate distractor');
});

test('a distractor equal to the answer is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(5).map((it, index) => (index === 0 ? { ...it, distractors: ['answer 1', 'd1b', 'd1c'] } : it)));
  expect(await check(root), 'must not equal the answer', 'answer as distractor');
});

// -------------------------------------------------------------------- coverage

test('a selectable value with fewer than five Items is rejected', async (root) => {
  await writeGame(root, GAME);
  await writeContent(root, 'demo', items(4));
  expect(await check(root), 'unit:u1 has 4 Item(s), but at least 5 are required', 'thin value');
});

test('a declared value with no Items is rejected', async (root) => {
  const game = { ...GAME, dims: [{ dim: 'unit', values: ['u1', 'u2'] }] };
  await writeGame(root, game);
  await writeContent(root, 'demo', items(5));
  expect(await check(root), 'unit:u2 has 0 Item(s), but at least 5 are required', 'unshipped value');
});

test('a preset with fewer than five Items is rejected', async (root) => {
  const game = { ...GAME, presets: [{ id: 'p', label: 'P', include: { unit: ['u1'] } }] };
  await writeGame(root, game);
  await writeContent(root, 'demo', items(4));
  expect(await check(root), 'preset "p" has 4 Item(s), but at least 5 are required', 'thin preset');
});

test('a preset covering five Items passes', async (root) => {
  const game = { ...GAME, presets: [{ id: 'p', label: 'P', include: { unit: ['u1'] } }] };
  await writeGame(root, game);
  await writeContent(root, 'demo', items(5));
  assert.deepEqual((await check(root)).errors, []);
});

test('a preset filtering an undeclared value is rejected', async (root) => {
  const game = { ...GAME, presets: [{ id: 'p', label: 'P', include: { unit: ['u9'] } }] };
  await writeGame(root, game);
  await writeContent(root, 'demo', items(5));
  expect(await check(root), 'preset "p" filters undeclared value "unit:u9"', 'bad preset value');
});

test('a malformed dimension declaration is rejected', async (root) => {
  const game = { ...GAME, dims: [{ dim: 'unit', values: [] }] };
  await writeGame(root, game);
  expect(await check(root), 'each dimension needs { dim, values }', 'malformed dims');
});

// --------------------------------------------------------- ownership and games

test('shared content is checked against each owning Game', async (root) => {
  await writeGame(root, { ...GAME, id: 'gameA' });
  await writeGame(root, { ...GAME, id: 'gameB', dims: [{ dim: 'unit', values: ['u1'] }, { dim: 'level', values: ['l1'] }] });
  await writeContent(root, 'demo', items(5));
  const report = await check(root);
  expect(report, '[gameB, i1]: missing tag for declared dimension "level"', 'second owner');
  expect(report, '[gameB]: level:l1 has 0 Item(s)', 'second owner coverage');
  assert.ok(!report.errors.some((error) => error.includes('[gameA,')), 'gameA should not be blamed');
});

test('content declared by no Game is rejected', async (root) => {
  await writeContent(root, 'demo', items(5));
  expect(await check(root), 'is not declared by any Game', 'orphan content');
});

test('a Game module that cannot be imported is rejected', async (root) => {
  await write(root, 'js/games/broken/index.js', "// @ts-check\nthrow new Error('boom');\n");
  const report = await check(root);
  expect(report, 'could not be imported', 'broken module');
  expect(report, 'boom', 'broken module cause');
});

test('a Game declaration without an id is rejected', async (root) => {
  await write(root, 'js/games/demo/index.js', "// @ts-check\nexport default { title: 'Demo' };\n");
  expect(await check(root), 'non-empty string "id"', 'missing game id');
});

test('a duplicate Game id is rejected', async (root) => {
  const game = { ...GAME };
  delete game.content;
  await writeGame(root, game, 'one');
  await writeGame(root, game, 'two');
  expect(await check(root), 'duplicate Game id "demo"', 'duplicate game');
});

test('JS under js/ without // @ts-check is rejected', async (root) => {
  await write(root, 'js/lib/x.js', "export const x = 'x';\n");
  expect(await check(root), 'must open with "// @ts-check"', 'missing pragma');
});

test('a content path escaping the repository is rejected', async (root) => {
  await writeGame(root, { ...GAME, content: '../outside.json' });
  expect(await check(root), 'must resolve inside the repository', 'escaping path');
});

/** @returns {Promise<boolean>} true when every case passed */
export async function runSelfTest() {
  let passed = 0;
  /** @type {string[]} */
  const failed = [];
  for (const { name, run } of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'giocco-check-'));
    try {
      await run(root);
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed.push(name);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL ${name}\n       ${message.split('\n').join('\n       ')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  console.log(`\nselftest: ${passed}/${cases.length} passed`);
  return failed.length === 0;
}
