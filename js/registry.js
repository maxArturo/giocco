// @ts-check
/**
 * The sole Game announcement point.
 *
 * A Game exists because it is imported here, and this is the only file an addition touches:
 * one import, one array entry. Everything the host does with a Game is read off the module's
 * own declaration (`id`, `title`, optional `content`/`dims`/`presets`/`controls`/`description`/
 * `section`), so adding a Game changes no host behaviour — `engine.js`, `app.js`, `router.js`,
 * `ui.js`, `storage.js` and `sw.js` all stay as they are.
 *
 * The imports are static on purpose: the whole Game graph is fetched on the first online load
 * and therefore cached for the first offline one. A lazily imported Game would silently not
 * exist offline.
 */

import nomiPlurale from './games/nomi-plurale/index.js';
import verbiPresente from './games/verbi-presente/index.js';
import verbiPresenteRivela from './games/verbi-presente-rivela/index.js';

/** @typedef {import('./engine.js').Game} Game */

/**
 * The permanent ids, in hub display order. An `id` is in routes and storage keys, so it never
 * changes; a `title` may change freely.
 * @type {ReadonlyArray<string>}
 */
export const GAME_IDS = Object.freeze(['verbi-presente', 'verbi-presente-rivela', 'nomi-plurale']);

/**
 * Every registered Game, in display order: the recognition drill, the production drill, then
 * the noun drill.
 * @type {ReadonlyArray<Game>}
 */
export const GAMES = Object.freeze([verbiPresente, verbiPresenteRivela, nomiPlurale]);

/**
 * The one lookup the router needs. Returns `null` for an unknown id, which is a redirect to
 * the hub rather than an error.
 * @param {string} id
 * @returns {Game | null}
 */
export function gameById(id) {
  return GAMES.find((game) => game.id === id) ?? null;
}
