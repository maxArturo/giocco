// @ts-check
/**
 * The host's screens and its one piece of in-game chrome.
 *
 * | Route | What the host draws |
 * |---|---|
 * | `#/` | the hub: a wordmark and one card per Game, in registry order |
 * | `#/g/<id>` | only the back control, plus the node the Game draws into |
 * | `#/g/<id>/settings` | pool selection, host-rendered from the Game's declaration (US-007) |
 *
 * The hub shows what exists and nothing else: no counts, no percentage, no streak, no search, no
 * "continue" — a Game that charts every Tag and a Game that never shows a number look identical
 * here, which is the point. The card *is* the tap target, and it opens that Game's settings route,
 * because pool selection is the only way into a round.
 *
 * On a Game route the host draws exactly one control — the back button to the hub — so no Game
 * can trap the player — and one empty node for the Game to draw into. Everything else on that
 * screen is the Game's, including any quit control, which is why no Game draws one. The host
 * never calls `play()` here: whoever renders the route mounts the Game into `playRoot` and
 * composes the two teardowns, which keeps this module free of Sessions and storage.
 *
 * Chrome copy is English ("Giocco", "Back"); every string a Game shows stays Italian. The
 * `document` is a parameter, the same rule as `storage.js`'s backend and the router's window: the
 * browser passes nothing, and `tools/sanity.mjs` checks the built DOM with a fake.
 */

import { GAMES } from './registry.js';
import { HUB_HASH, settingsHash } from './router.js';

/** @typedef {import('./engine.js').Game} Game */

/**
 * What the host chrome on a Game route hands back: the node the Game draws into, and the
 * teardown that removes the chrome and that node when the route changes.
 * @typedef {{ playRoot: HTMLElement, teardown: () => void }} GameScreen
 */

/** The hub's wordmark. Not a link, and it displays no data. */
const WORDMARK = 'Giocco';

/** The back control's label. Chrome is English; exercise content is not. */
const BACK_LABEL = 'Back';

/**
 * Build the host's screens against one document.
 *
 * @param {Document} [doc] defaults to the browser's `document`; inject a fake in Node checks
 * @returns {{
 *   hub: (root: HTMLElement, games?: ReadonlyArray<Game>) => void,
 *   gameScreen: (root: HTMLElement, game: Game) => GameScreen,
 * }}
 */
export function createUi(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('giocco ui: a document-like object is required');
  }

  /**
   * @template {keyof HTMLElementTagNameMap} T
   * @param {T} tag
   * @param {string} [className]
   * @returns {HTMLElementTagNameMap[T]}
   */
  function el(tag, className) {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    return node;
  }

  /**
   * An element carrying one piece of text — the only way this module writes copy.
   * @param {keyof HTMLElementTagNameMap} tag
   * @param {string} [className]
   * @param {string} [value]
   * @returns {HTMLElement}
   */
  function text(tag, className, value) {
    const node = el(tag, className);
    if (value !== undefined) node.textContent = value;
    return node;
  }

  /**
   * The hub. One column, registry order, a plain heading per `section` once a Game declares one
   * — and no teardown, because the hub listens to nothing and holds nothing.
   *
   * @param {HTMLElement} root the route root
   * @param {ReadonlyArray<Game>} [games] defaults to the registry
   */
  function hub(root, games = GAMES) {
    root.replaceChildren();

    const screen = el('section', 'hub');
    screen.append(text('h1', 'wordmark', WORDMARK));

    /** The open list, and the heading it sits under. @type {HTMLElement | null} */
    let list = null;
    /** `\u0000` is never a Game's section, so the first Game always opens a list. */
    let heading = '\u0000';
    for (const game of games) {
      const name = typeof game.section === 'string' ? game.section : '';
      if (list === null || name !== heading) {
        heading = name;
        if (name !== '') screen.append(text('h2', 'section-title', name));
        list = el('ul', 'game-list');
        screen.append(list);
      }
      const card = el('a', 'game-card');
      card.href = settingsHash(game.id);
      card.append(text('span', 'title', game.title));
      if (typeof game.description === 'string' && game.description !== '') {
        card.append(text('span', 'description', game.description));
      }
      const item = el('li');
      item.append(card);
      list.append(item);
    }

    root.append(screen);
  }

  /**
   * The host chrome on a Game route: the back control, and the node the Game draws into. The
   * node carries `data-game` so the DOM says which Game is on screen; the chrome beside it says
   * nothing about the Game, which is the boundary working.
   *
   * @param {HTMLElement} root the route root
   * @param {Game} game
   * @returns {GameScreen}
   */
  function gameScreen(root, game) {
    root.replaceChildren();

    const bar = el('header', 'host-bar');
    const back = el('a', 'back');
    back.href = HUB_HASH;
    const arrow = text('span', undefined, '←');
    arrow.setAttribute('aria-hidden', 'true');
    back.append(arrow, text('span', undefined, BACK_LABEL));
    bar.append(back);

    const playRoot = el('div', 'game');
    playRoot.setAttribute('data-game', game.id);

    root.append(bar, playRoot);
    return { playRoot, teardown: () => root.replaceChildren() };
  }

  return { hub, gameScreen };
}
