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
 * The settings screen is the host's one game-specific surface, rendered from the Game's own
 * declaration (`dims`, `presets`, `controls`). `ui.js` therefore imports the engine's *pure*
 * helpers — `filterPool` for the counts, `presetSettings` for a chip — and never a Session or
 * storage: the live `settings` object it is handed is the boot wiring's, and every write it
 * makes lands in `localStorage` through that object. It also never imports a Game: no Game code
 * runs here.
 *
 * Chrome copy is English ("Giocco", "Back", "Start round"); every string a Game shows stays
 * Italian. The `document` is a parameter, the same rule as `storage.js`'s backend and the
 * router's window: the browser passes nothing, and `tools/sanity.mjs` checks the built DOM with
 * a fake. `navigate` is the second injectable: the boot wiring passes the router's own, so the
 * screen never reaches for the URL itself.
 */

import { filterPool, presetSettings } from './engine.js';
import { GAMES } from './registry.js';
import { HUB_HASH, gameHash, settingsHash } from './router.js';

/** @typedef {import('./engine.js').Game} Game */
/** @typedef {import('./engine.js').Item} Item */
/** @typedef {import('./engine.js').Settings} Settings */

/**
 * What the host chrome on a Game route hands back: the node the Game draws into, and the
 * teardown that removes the chrome and that node when the route changes.
 * @typedef {{ playRoot: HTMLElement, teardown: () => void }} GameScreen
 */

/**
 * One value row's live nodes, so `refresh()` can rewrite its count and state without a
 * re-render (and therefore without moving focus).
 * @typedef {{
 *   value: string,
 *   row: HTMLElement,
 *   badge: HTMLElement,
 *   sub: HTMLElement,
 *   sw: HTMLButtonElement,
 * }} ValueRow
 */

/** One Dimension's accordion, kept for `refresh()`. */
/**
 * @typedef {{
 *   dim: string,
 *   values: string[],
 *   head: HTMLButtonElement,
 *   count: HTMLElement,
 *   body: HTMLElement,
 *   rows: ValueRow[],
 * }} DimensionSection
 */

/** What whoever renders the settings route hands the screen. */
/**
 * @typedef {{
 *   settings?: Settings | null,
 *   items?: Item[],
 *   navigate?: (hash: string) => void,
 * }} SettingsOptions
 */

/** The hub's wordmark. Not a link, and it displays no data. */
const WORDMARK = 'Giocco';

/** The back control's label. Chrome is English; exercise content is not. */
const BACK_LABEL = 'Back';

/** The settings screen's one action that leaves it, and the only way into a round. */
const START_LABEL = 'Start round';

/** Shown in the preset row whenever no declared Preset is the current filter set. */
const CUSTOM_LABEL = 'Custom';

/** What the footer says when the current settings allow nothing. */
const EMPTY_POOL = 'no items match these filters';

/** The structural gate's own threshold, surfaced on the form instead of hidden. */
const THIN_VALUE = 5;

/**
 * True for anything JSON can hold a mutation in, and false for arrays — the shape test the
 * settings screen needs and the engine's own `isPlain` keeps private.
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Complete a saved Settings against the Game's declaration. Storage hands back
 * `{ preset: null, include: {}, controls: {} }` on a first visit, and a Game can grow a
 * Dimension or a control after a player has saved something, so every declared piece is
 * filled in here: all of a Dimension's values, a control's declared default, `preset: null`.
 * The object is mutated, not copied — it *is* the persisted one, so the usable whole-content
 * pool is saved the moment it is completed.
 *
 * @param {Game} game
 * @param {Settings | null} [saved]
 * @returns {Settings}
 */
function ensureSettings(game, saved = null) {
  /** @type {any} */
  const settings = isObject(saved) ? saved : {};
  if (!isObject(settings.include)) settings.include = {};
  if (!isObject(settings.controls)) settings.controls = {};

  for (const { dim, values } of game.dims ?? []) {
    const current = settings.include[dim];
    // An empty list is the player's "None" and is kept; a missing or foreign one starts full.
    if (Array.isArray(current)) settings.include[dim] = current.filter((value) => typeof value === 'string');
    else settings.include[dim] = [...values];
  }

  for (const control of game.controls ?? []) {
    const current = settings.controls[control.id];
    const known = control.options.some((option) => String(option) === String(current));
    if (!known) settings.controls[control.id] = control.default;
  }

  const declared = (game.presets ?? []).some((preset) => preset.id === settings.preset);
  if (settings.preset !== null && !declared) settings.preset = null;

  return /** @type {Settings} */ (settings);
}

/**
 * The browser's own navigation, used when the boot wiring passes no `navigate`. It is not the
 * default used by a node check: there is no `location` there, which is the loud failure below.
 * @param {string} hash
 */
function defaultNavigate(hash) {
  const location = globalThis.location;
  if (!location) throw new Error('giocco ui: the settings screen needs a navigate function or a location');
  location.hash = hash;
}

/**
 * Build the host's screens against one document.
 *
 * @param {Document} [doc] defaults to the browser's `document`; inject a fake in Node checks
 * @returns {{
 *   hub: (root: HTMLElement, games?: ReadonlyArray<Game>) => void,
 *   gameScreen: (root: HTMLElement, game: Game) => GameScreen,
 *   settingsScreen: (root: HTMLElement, game: Game, options?: SettingsOptions) => (() => void),
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

  /**
   * The settings screen: pool selection, host-rendered from the Game's declaration.
   *
   * Top to bottom: the Game's title, the Preset chips, one accordion per Dimension in declared
   * order (only the first open), the declared control chips, and a sticky footer with the
   * eligible count and **Start round** — the one control that enters the Game route.
   *
   * The DOM is built once and `refresh()` mutates it, so a toggle never loses focus and no
   * question of a re-render is answered by `innerHTML`. Every change writes through the live
   * `settings` object (so it persists), clears `preset`, and recomputes the *whole* form: each
   * value's badge is how many Items would be eligible if that value were on given everything
   * else currently selected, and any value whose answer is below five is dimmed, marked
   * `aria-disabled` and given a "needs 5+ items" sub-line — the structural gate's rule,
   * surfaced rather than hidden.
   *
   * @param {HTMLElement} root the route root
   * @param {Game} game
   * @param {SettingsOptions} [options]
   * @returns {() => void} the screen's teardown
   */
  function settingsScreen(root, game, options = {}) {
    root.replaceChildren();

    const settings = ensureSettings(game, options.settings);
    const items = Array.isArray(options.items) ? options.items : [];
    const navigate = typeof options.navigate === 'function' ? options.navigate : defaultNavigate;
    const dims = game.dims ?? [];
    const presets = game.presets ?? [];
    const controls = game.controls ?? [];
    const prefix = `settings-${game.id}`;

    const screen = el('section', 'settings');
    screen.setAttribute('data-game', game.id);
    const title = text('h1', undefined, game.title);
    title.id = `${prefix}-title`;
    screen.setAttribute('aria-labelledby', title.id);
    screen.append(title);

    /** @type {Array<{ id: string, chip: HTMLButtonElement }>} */
    const presetChips = [];
    /** Only the preset row has one — the "Custom" state chip. @type {HTMLElement | null} */
    let customChip = null;
    /** A preset row exists only when the Game declares a Preset to choose. */
    if (presets.length > 0) {
      const row = el('div', 'presets');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Presets');
      for (const preset of presets) {
        const chip = el('button', 'chip');
        chip.type = 'button';
        chip.textContent = preset.label;
        chip.setAttribute('data-preset', preset.id);
        chip.addEventListener('click', () => choosePreset(preset.id));
        row.append(chip);
        presetChips.push({ id: preset.id, chip });
      }
      customChip = text('span', 'chip custom', CUSTOM_LABEL);
      row.append(customChip);
      screen.append(row);
    }

    /** @type {DimensionSection[]} */
    const sections = [];

    dims.forEach(({ dim, values }, index) => {
      const bodyId = `${prefix}-${dim}`;
      const accordion = el('div', 'accordion');
      accordion.setAttribute('data-dim', dim);

      const head = el('button', 'acc-head');
      head.type = 'button';
      head.id = `${bodyId}-head`;
      head.setAttribute('aria-controls', bodyId);
      head.setAttribute('aria-expanded', index === 0 ? 'true' : 'false');
      const count = text('span', 'count', '');
      const chevron = text('span', 'chevron', '⌄');
      chevron.setAttribute('aria-hidden', 'true');
      head.append(text('span', 'label', dim), count, chevron);

      // Only the first declared Dimension is open, so a Game with six of them opens as three
      // lines rather than a wall of switches.
      const body = el('div', 'acc-body');
      body.id = bodyId;
      body.hidden = index !== 0;
      head.addEventListener('click', () => {
        const open = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
        body.hidden = open;
      });

      const actions = el('div', 'acc-actions');
      const all = el('button', 'text-btn');
      all.type = 'button';
      all.textContent = 'All';
      all.addEventListener('click', () => setDim(dim, values));
      const none = el('button', 'text-btn');
      none.type = 'button';
      none.textContent = 'None';
      none.addEventListener('click', () => setDim(dim, []));
      actions.append(all, none);
      body.append(actions);

      /** @type {ValueRow[]} */
      const rows = [];
      for (const value of values) {
        const row = el('div', 'value-row');
        row.setAttribute('data-value', value);
        const labels = el('div', 'labels');
        const sub = text('span', 'sub', '');
        labels.append(text('span', 'label', value), sub);
        const badge = text('span', 'badge', '');
        const sw = el('button', 'switch');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-label', value);
        sw.addEventListener('click', () => toggle(dim, value));
        row.append(labels, badge, sw);
        body.append(row);
        rows.push({ value, row, badge, sub, sw });
      }

      accordion.append(head, body);
      screen.append(accordion);
      sections.push({ dim, values: [...values], head, count, body, rows });
    });

    /** @type {Array<{ control: { id: string, options: Array<string | number> }, option: string | number, chip: HTMLButtonElement }>} */
    const controlChips = [];
    for (const control of controls) {
      const row = el('div', 'control-row');
      row.setAttribute('data-control', control.id);
      const label = text('span', 'label', control.label);
      label.id = `${prefix}-control-${control.id}`;
      const group = el('div', 'controls');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', label.id);
      for (const option of control.options) {
        const chip = el('button', 'chip');
        chip.type = 'button';
        chip.textContent = String(option);
        chip.addEventListener('click', () => {
          settings.controls[control.id] = option;
          settings.preset = null;
          refresh();
        });
        group.append(chip);
        controlChips.push({ control, option, chip });
      }
      row.append(label, group);
      screen.append(row);
    }

    const footer = el('footer', 'settings-footer');
    const eligible = text('span', 'eligible', '');
    eligible.setAttribute('aria-live', 'polite');
    const start = el('button', 'start');
    start.type = 'button';
    start.textContent = START_LABEL;
    start.addEventListener('click', () => {
      if (start.disabled) return;
      navigate(gameHash(game.id));
    });
    footer.append(eligible, start);
    screen.append(footer);
    root.append(screen);

    /**
     * Choosing a Preset copies its declared include map and records its id; the control values
     * the player already chose are kept.
     * @param {string} id
     */
    function choosePreset(id) {
      const next = presetSettings(game, id, settings);
      settings.preset = next.preset;
      settings.include = next.include;
      settings.controls = next.controls;
      refresh();
    }

    /**
     * A manual Dimension change — a switch, All or None. It always clears the Preset.
     * @param {string} dim
     * @param {string[]} values
     */
    function setDim(dim, values) {
      settings.include[dim] = [...values];
      settings.preset = null;
      refresh();
    }

    /**
     * @param {string} dim
     * @param {string} value
     */
    function toggle(dim, value) {
      const declared = dims.find((entry) => entry.dim === dim)?.values ?? [];
      // A Dimension a Preset does not mention is unconstrained — the engine reads an absent
      // Dimension as no constraint — so it starts from "every value" here too.
      const current = settings.include[dim] ?? declared;
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      // The declared order, not the tap order, is what the stored settings keep.
      settings.include[dim] = declared.filter((entry) => next.has(entry));
      settings.preset = null;
      refresh();
    }

    /** Recompute the whole form: preset chips, every badge and count, and the footer. */
    function refresh() {
      const include = settings.include;
      const total = filterPool(items, settings).length;

      for (const { id, chip } of presetChips) {
        chip.setAttribute('aria-pressed', settings.preset === id ? 'true' : 'false');
      }
      if (customChip !== null) customChip.hidden = settings.preset !== null;

      for (const section of sections) {
        // An absent Dimension means "no constraint", which the form must show as all-on: a
        // Preset only mentions the Dimensions it filters, and pretending the rest are "None"
        // would advertise an empty pool that the engine will happily fill.
        const selected = include[section.dim] ?? section.values;
        section.count.textContent = `${selected.length} of ${section.values.length}`;
        for (const entry of section.rows) {
          const count = filterPool(items, {
            preset: null,
            include: { ...include, [section.dim]: [entry.value] },
            controls: {},
          }).length;
          entry.badge.textContent = String(count);
          entry.sw.setAttribute('aria-checked', selected.includes(entry.value) ? 'true' : 'false');
          entry.row.setAttribute('aria-disabled', count < THIN_VALUE ? 'true' : 'false');
          entry.sub.textContent = count < THIN_VALUE ? `needs ${THIN_VALUE}+ items` : '';
        }
      }

      for (const { control, option, chip } of controlChips) {
        const pressed = String(settings.controls[control.id]) === String(option);
        chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      }

      eligible.textContent = total === 0 ? EMPTY_POOL : `${total} eligible item${total === 1 ? '' : 's'}`;
      start.disabled = total === 0;
    }

    refresh();
    return () => root.replaceChildren();
  }

  return { hub, gameScreen, settingsScreen };
}
