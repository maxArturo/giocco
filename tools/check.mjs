/**
 * Giocco's structural content gate — dev-only, never shipped, never precached.
 *
 * `npm run check` validates every `content/*.json` against the declarations of every Game
 * that points at it (`fields`, `dims`, `presets`). It checks *structure*: a file that does
 * not parse, an Item with the wrong fields, an unknown `dim:value` tag, missing or duplicated
 * dimensions, malformed distractors, a duplicated file-local `id`, or a selectable value or
 * Preset covering fewer than five Items. It never judges Italian: whether `cerchi` is really
 * the 2s of `cercare`, whether a distractor is plausible and whether a `cefr` tag is fair are
 * questions for the human review pass, not for a tool.
 *
 * Usage
 *   node tools/check.mjs                 # gate the repository (default root: this repo)
 *   node tools/check.mjs <dir>           # gate another root, e.g. a fixture tree
 *   node tools/check.mjs --selftest      # run the gate's own fixture suite (npm test)
 *
 * A Game module is imported to read its declaration, so a Game under `js/games/<id>/index.js`
 * must be import-safe in Node: pure declarations at module scope, no DOM access until
 * `play()` runs.
 *
 * This file is deliberately not type-checked: the project ships exactly one devDependency
 * (`typescript`) and no `@types/node`, so Node built-ins have no declarations to resolve.
 * Application code under `js/**` is the part `npm run typecheck` covers.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Item fields assumed when a Game declares no `fields` of its own. */
export const DEFAULT_FIELDS = Object.freeze(['id', 'prompt', 'answer', 'distractors', 'tags']);

/** Minimum Items per selectable tag value and per declared Preset. */
export const MIN_ITEMS = 5;

/** A choice Item offers its answer plus exactly three authored distractors. */
export const DISTRACTORS = 3;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const toPosix = (root, target) => path.relative(root, target).split(path.sep).join('/');

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function isFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} list
 * @returns {string[]} the entries that appear more than once, each reported once
 */
function duplicatesOf(list) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of list) {
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  }
  return [...repeated];
}

/**
 * Import every `js/games/<id>/index.js` and return its declaration.
 * @param {string} root
 * @param {string[]} errors
 */
async function collectGames(root, errors) {
  const gamesDir = path.join(root, 'js', 'games');
  /** @type {Array<Record<string, any> & { __path: string }>} */
  const games = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(gamesDir, { withFileTypes: true });
  } catch {
    return games;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const modulePath = path.join(gamesDir, entry.name, 'index.js');
    if (!(await isFile(modulePath))) continue;
    const label = toPosix(root, modulePath);
    /** @type {unknown} */
    let declaration;
    try {
      const module = await import(pathToFileURL(modulePath).href);
      declaration = module.default;
    } catch (err) {
      errors.push(`${label}: Game module could not be imported (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!isPlainObject(declaration)) {
      errors.push(`${label}: Game module must default-export a declaration object`);
      continue;
    }
    if (!isNonEmptyString(declaration.id)) {
      errors.push(`${label}: Game declaration needs a non-empty string "id"`);
      continue;
    }
    games.push({ ...declaration, __path: label });
  }
  return games;
}

/**
 * Every `content` path a Game declares, resolved against the root.
 * @param {Array<Record<string, any>>} games
 * @param {string} root
 * @param {string[]} errors
 */
function collectContentDeclarations(games, root, errors) {
  /** @type {Array<{ gameId: string, gamePath: string, key: string | null, relPath: string, absPath: string }>} */
  const declarations = [];
  for (const game of games) {
    const content = game.content;
    if (content === undefined) continue;
    const add = (/** @type {string | null} */ key, /** @type {unknown} */ value) => {
      const where = key === null ? 'content' : `content.${key}`;
      if (!isNonEmptyString(value)) {
        errors.push(`${game.__path}: ${where} must be a non-empty relative path`);
        return;
      }
      const absPath = path.resolve(root, value);
      if (absPath !== root && !absPath.startsWith(root + path.sep)) {
        errors.push(`${game.__path}: ${where} ("${value}") must resolve inside the repository`);
        return;
      }
      declarations.push({
        gameId: game.id,
        gamePath: game.__path,
        key,
        relPath: value.replace(/^\.\//, ''),
        absPath,
      });
    };
    if (typeof content === 'string') add(null, content);
    else if (isPlainObject(content)) for (const [key, value] of Object.entries(content)) add(key, value);
    else errors.push(`${game.__path}: "content" must be a path string or a key → path object`);
  }
  return declarations;
}

/**
 * The exact field names an Item of this Game must carry.
 * @param {Record<string, any>} game
 * @param {string[]} errors
 */
function declaredFields(game, errors) {
  const fields = game.fields;
  if (fields === undefined) return [...DEFAULT_FIELDS];
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every(isNonEmptyString)) {
    errors.push(`${game.__path}: "fields" must be a non-empty array of field names`);
    return [...DEFAULT_FIELDS];
  }
  for (const name of duplicatesOf(fields)) errors.push(`${game.__path}: "fields" repeats "${name}"`);
  return fields;
}

/**
 * The Game's declared Dimensions, in declaration order.
 * @param {Record<string, any>} game
 * @param {string[]} errors
 */
function declaredDims(game, errors) {
  const dims = game.dims;
  if (dims === undefined) return [];
  if (!Array.isArray(dims)) {
    errors.push(`${game.__path}: "dims" must be an array of { dim, values }`);
    return [];
  }
  /** @type {Array<{ dim: string, values: string[] }>} */
  const out = [];
  const seen = new Set();
  for (const entry of dims) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.dim) || !Array.isArray(entry.values) || entry.values.length === 0 || !entry.values.every(isNonEmptyString)) {
      errors.push(`${game.__path}: each dimension needs { dim, values } with non-empty string values`);
      continue;
    }
    if (seen.has(entry.dim)) {
      errors.push(`${game.__path}: dimension "${entry.dim}" is declared twice`);
      continue;
    }
    seen.add(entry.dim);
    for (const value of duplicatesOf(entry.values)) errors.push(`${game.__path}: dimension "${entry.dim}" repeats value "${value}"`);
    out.push({ dim: entry.dim, values: [...entry.values] });
  }
  return out;
}

/**
 * The Game's declared Presets, validated against its Dimensions.
 * @param {Record<string, any>} game
 * @param {Array<{ dim: string, values: string[] }>} dims
 * @param {string[]} errors
 */
function declaredPresets(game, dims, errors) {
  const presets = game.presets;
  if (presets === undefined) return [];
  if (!Array.isArray(presets)) {
    errors.push(`${game.__path}: "presets" must be an array of { id, label, include }`);
    return [];
  }
  const allowed = new Map(dims.map(({ dim, values }) => [dim, new Set(values)]));
  /** @type {Array<{ id: string, include: Record<string, string[]> }>} */
  const out = [];
  const seen = new Set();
  for (const entry of presets) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.label) || !isPlainObject(entry.include)) {
      errors.push(`${game.__path}: each preset needs { id, label, include }`);
      continue;
    }
    if (seen.has(entry.id)) {
      errors.push(`${game.__path}: preset "${entry.id}" is declared twice`);
      continue;
    }
    seen.add(entry.id);
    for (const [dim, values] of Object.entries(entry.include)) {
      const allowedValues = allowed.get(dim);
      if (!allowedValues) {
        errors.push(`${game.__path}: preset "${entry.id}" filters undeclared dimension "${dim}"`);
        continue;
      }
      if (!Array.isArray(values) || values.length === 0 || !values.every(isNonEmptyString)) {
        errors.push(`${game.__path}: preset "${entry.id}" needs a non-empty list of values for "${dim}"`);
        continue;
      }
      for (const value of values) {
        if (!allowedValues.has(value)) errors.push(`${game.__path}: preset "${entry.id}" filters undeclared value "${dim}:${value}"`);
      }
    }
    out.push({ id: entry.id, include: /** @type {Record<string, string[]>} */ (entry.include) });
  }
  return out;
}

/**
 * @param {unknown} item
 * @param {number} index
 * @param {{ where: string, fields: string[], dims: Array<{ dim: string }>, errors: string[] }} context
 */
function validateItem(item, index, context) {
  const { fields, dims, errors } = context;
  const hasId = isPlainObject(item) && isNonEmptyString(item.id);
  const where = hasId ? `${context.where}${item.id}]` : `${context.where}#${index + 1}]`;
  if (!isPlainObject(item)) {
    errors.push(`${where}: each Item must be a JSON object`);
    return;
  }

  const actual = Object.keys(item);
  for (const field of fields) if (!actual.includes(field)) errors.push(`${where}: missing field "${field}"`);
  for (const key of actual) {
    if (!fields.includes(key)) errors.push(`${where}: unexpected field "${key}" (declared fields: ${fields.join(', ')})`);
  }

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) continue;
    if (field === 'distractors') validateDistractors(item, where, errors);
    else if (field === 'tags') validateTags(item, where, dims, errors);
    else if (!isNonEmptyString(item[field])) errors.push(`${where}: "${field}" must be a non-empty string`);
  }

  const tags = Array.isArray(item.tags) ? item.tags.filter(isNonEmptyString) : [];
  const presentDims = new Set(tags.map((tag) => tag.slice(0, tag.indexOf(':'))));
  for (const { dim } of dims) {
    if (!presentDims.has(dim)) errors.push(`${where}: missing tag for declared dimension "${dim}"`);
  }
}

/**
 * @param {Record<string, any>} item
 * @param {string} where
 * @param {string[]} errors
 */
function validateDistractors(item, where, errors) {
  const distractors = item.distractors;
  if (!Array.isArray(distractors) || distractors.length !== DISTRACTORS || !distractors.every(isNonEmptyString)) {
    errors.push(`${where}: "distractors" must be exactly ${DISTRACTORS} non-empty strings`);
    return;
  }
  if (new Set(distractors).size !== DISTRACTORS) errors.push(`${where}: "distractors" must be distinct`);
  if (isNonEmptyString(item.answer) && distractors.includes(item.answer)) {
    errors.push(`${where}: a distractor must not equal the answer ("${item.answer}")`);
  }
}

/**
 * @param {Record<string, any>} item
 * @param {string} where
 * @param {Array<{ dim: string, values: string[] }>} dims
 * @param {string[]} errors
 */
function validateTags(item, where, dims, errors) {
  const tags = item.tags;
  if (!Array.isArray(tags) || tags.length === 0) {
    errors.push(`${where}: "tags" must be a non-empty array of dim:value strings`);
    return;
  }
  const allowed = new Map(dims.map(({ dim, values }) => [dim, new Set(values)]));
  const seen = new Set();
  const perDim = new Map();
  for (const tag of tags) {
    if (!isNonEmptyString(tag)) {
      errors.push(`${where}: every tag must be a non-empty "dim:value" string`);
      continue;
    }
    const at = tag.indexOf(':');
    const dim = at > 0 ? tag.slice(0, at) : '';
    const value = at > 0 ? tag.slice(at + 1) : '';
    if (!dim || !value) {
      errors.push(`${where}: tag "${tag}" is not a "dim:value" string`);
      continue;
    }
    if (seen.has(tag)) {
      errors.push(`${where}: duplicate tag "${tag}"`);
      continue;
    }
    seen.add(tag);
    if (perDim.has(dim)) errors.push(`${where}: more than one tag for dimension "${dim}" ("${perDim.get(dim)}" and "${tag}")`);
    else perDim.set(dim, tag);
    const allowedValues = allowed.get(dim);
    if (!allowedValues) {
      errors.push(`${where}: tag "${tag}" uses dimension "${dim}", which the Game does not declare`);
      continue;
    }
    if (!allowedValues.has(value)) errors.push(`${where}: tag "${tag}" uses value "${value}", which the Game does not declare for "${dim}"`);
  }
}

/**
 * Item ids are unique within their file (two files may reuse a name).
 * @param {unknown[]} items
 * @param {string} label
 * @param {string[]} errors
 */
function validateUniqueIds(items, label, errors) {
  const seen = new Set();
  for (const item of items) {
    if (!isPlainObject(item) || !isNonEmptyString(item.id)) continue;
    if (seen.has(item.id)) errors.push(`${label}: duplicate Item id "${item.id}"`);
    else seen.add(item.id);
  }
}

/**
 * Every selectable tag value, and every declared Preset, covers at least five Items.
 * @param {unknown[]} items
 * @param {{ label: string, gameId: string, dims: Array<{ dim: string, values: string[] }>, presets: Array<{ id: string, include: Record<string, string[]> }>, errors: string[] }} context
 */
function checkCoverage(items, context) {
  const { label, gameId, dims, presets, errors } = context;
  const tagsOf = (/** @type {unknown} */ item) =>
    isPlainObject(item) && Array.isArray(item.tags) ? item.tags.filter(isNonEmptyString) : [];
  for (const { dim, values } of dims) {
    for (const value of values) {
      const count = items.filter((item) => tagsOf(item).includes(`${dim}:${value}`)).length;
      if (count < MIN_ITEMS) {
        errors.push(`${label} [${gameId}]: ${dim}:${value} has ${count} Item(s), but at least ${MIN_ITEMS} are required`);
      }
    }
  }
  for (const preset of presets) {
    const count = items.filter((item) =>
      Object.entries(preset.include).every(([dim, values]) => values.some((value) => tagsOf(item).includes(`${dim}:${value}`))),
    ).length;
    if (count < MIN_ITEMS) {
      errors.push(`${label} [${gameId}]: preset "${preset.id}" has ${count} Item(s), but at least ${MIN_ITEMS} are required`);
    }
  }
}

/**
 * @param {string} absPath
 * @param {string} label
 * @param {string[]} errors
 * @returns {Promise<unknown[] | null>}
 */
async function parseItems(absPath, label, errors) {
  /** @type {string} */
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    errors.push(`${label}: could not be read (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    errors.push(`${label}: is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  if (!Array.isArray(data)) {
    errors.push(`${label}: must be a JSON array of Items`);
    return null;
  }
  if (data.length === 0) {
    errors.push(`${label}: must be a non-empty array of Items`);
    return null;
  }
  return data;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} every `.js` / `.mjs` file under dir, sorted
 */
async function listJsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJsFiles(child)));
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) out.push(child);
  }
  return out;
}

/**
 * `tsconfig.json` sets `checkJs: false`, so the `// @ts-check` pragma is what puts a file
 * under the type gate. Enforce the pragma here so a forgotten one cannot hide a file.
 * @param {string[]} files
 * @param {string} root
 * @param {string[]} errors
 */
async function checkTsCheckPragma(files, root, errors) {
  for (const file of files) {
    const label = toPosix(root, file);
    const head = (await readFile(file, 'utf8')).split('\n', 8).join('\n');
    if (!/^\s*\/\/\s*@ts-check\b/m.test(head)) {
      errors.push(`${label}: must open with "// @ts-check" so the type gate checks it`);
    }
  }
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} `content/*.json`, sorted
 */
async function listContentFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) out.push(path.join(dir, entry.name));
  }
  return out.sort();
}

/**
 * Gate one repository root.
 * @param {string} [root]
 */
export async function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const games = await collectGames(absoluteRoot, errors);
  const gameIds = new Map();
  for (const game of games) {
    if (gameIds.has(game.id)) errors.push(`${game.__path}: duplicate Game id "${game.id}"`);
    else gameIds.set(game.id, game.__path);
  }

  const declarations = collectContentDeclarations(games, absoluteRoot, errors);
  const byPath = new Map();
  for (const declaration of declarations) {
    const list = byPath.get(declaration.absPath) ?? [];
    list.push(declaration);
    byPath.set(declaration.absPath, list);
  }
  for (const declaration of declarations) {
    if (!(await isFile(declaration.absPath))) {
      warnings.push(`${declaration.gamePath}: declares content "${declaration.relPath}", which does not exist yet (skipped)`);
    }
  }

  /** @type {Map<string, { fields: string[], dims: Array<{ dim: string, values: string[] }>, presets: Array<{ id: string, include: Record<string, string[]> }> }>} */
  const shapeOf = new Map();
  for (const game of games) {
    const dims = declaredDims(game, errors);
    shapeOf.set(game.id, { fields: declaredFields(game, errors), dims, presets: declaredPresets(game, dims, errors) });
  }

  await checkTsCheckPragma(await listJsFiles(path.join(absoluteRoot, 'js')), absoluteRoot, errors);

  let filesChecked = 0;
  let itemsChecked = 0;
  for (const file of await listContentFiles(path.join(absoluteRoot, 'content'))) {
    const label = toPosix(absoluteRoot, file);
    const owners = byPath.get(file) ?? [];
    if (owners.length === 0) errors.push(`${label}: is not declared by any Game's "content"`);
    const items = await parseItems(file, label, errors);
    if (items === null) continue;
    filesChecked += 1;
    itemsChecked += items.length;
    validateUniqueIds(items, label, errors);
    for (const owner of owners) {
      const shape = shapeOf.get(owner.gameId);
      if (!shape) continue;
      const where = `${label} [${owner.gameId}, `;
      items.forEach((item, index) => validateItem(item, index, { where, fields: shape.fields, dims: shape.dims, errors }));
      checkCoverage(items, { label, gameId: owner.gameId, dims: shape.dims, presets: shape.presets, errors });
    }
  }

  return { errors, warnings, filesChecked, itemsChecked, games: games.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const { runSelfTest } = await import('./selftest.mjs');
    process.exit((await runSelfTest()) ? 0 : 1);
  }
  const rootArg = args.find((arg) => !arg.startsWith('-'));
  const report = await check(rootArg ? path.resolve(rootArg) : REPO_ROOT);
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  for (const error of report.errors) console.error(`error: ${error}`);
  if (report.errors.length > 0) {
    console.error(`\ncheck failed: ${report.errors.length} error(s) in ${report.filesChecked} content file(s).`);
    process.exit(1);
  }
  console.log(`check passed: ${report.filesChecked} content file(s), ${report.itemsChecked} Item(s), ${report.games} Game declaration(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('check crashed:', err);
    process.exit(1);
  });
}
