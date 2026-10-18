// @ts-check
/**
 * `verbi-presente-rivela` — produce a present-tense form, reveal, self-grade.
 *
 * Reads the same corpus as `verbi-presente` (US-012) and declares the same `fields`, `dims` and
 * `presets`, because the one file is validated against both Games — keep the two declarations in
 * step. This Game is the *other* drill over those Items: it asks you to produce the form from
 * memory, reveals the answer, and lets you grade yourself. Per `docs/design/ui-and-interaction.md`
 * the two are two Games sharing one file, never a mode inside one, and their Mastery is never
 * averaged — this Game reads and writes only its own `session.store`.
 *
 * The one thing they deliberately share is the *policy*: the weighted, without-replacement queue
 * (`weightedQueue`), the mastery read (`masteryOf`), the round-count control (`roundCount`) and the
 * whole progress core (`recordAttempt`, `statisticsView`) are imported from
 * `../verbi-presente/index.js` rather than copied, so "the same policy as the choice Game" is a
 * fact of the code and not a hope. Nothing about those helpers reads a store other than the one
 * this Game hands them: every one of them takes the store as an argument, so production progress
 * is written into, and read from, `storage.store('verbi-presente-rivela')` alone — the two verb
 * drills share one corpus and one policy and never share a number.
 *
 * The host handed over a filtered Pool and an RNG (`engine.js`); `roundLoop()` runs the
 * reveal/self-grade cycle; the store stays opaque to both.
 */

import { roundLoop } from '../../lib/roundLoop.js';
import {
  POINTS_CORRECT,
  masteryOf,
  recordAttempt,
  roundCount,
  statisticsView,
  weightedQueue,
} from '../verbi-presente/index.js';

/** @type {import('../../engine.js').Control} The shared round-count control every Game declares. */
const ROUND_COUNT = {
  id: 'count',
  label: 'Round',
  options: [5, 10, 20],
  default: 10,
};

/**
 * A verb Item draws with `prompt` / `answer` / `distractors` and is filtered by `tags` —
 * exactly these five fields, no authoring-only metadata.
 * @type {string[]}
 */
const FIELDS = ['id', 'prompt', 'answer', 'distractors', 'tags'];

/**
 * The verb vocabulary v0.1 (docs/design/content-and-progress.md § A). Declare only what ships.
 * @type {import('../../engine.js').Dim[]}
 */
const DIMS = [
  { dim: 'mood', values: ['ind'] },
  { dim: 'tense', values: ['pres'] },
  { dim: 'class', values: ['-are', '-ere', '-ire', '-isc'] },
  { dim: 'reg', values: ['regular', 'spelling', 'irregular'] },
  { dim: 'person', values: ['1s', '2s', '3s', '1p', '2p', '3p'] },
  { dim: 'refl', values: ['yes', 'no'] },
  { dim: 'cefr', values: ['a1'] },
];

/**
 * Named learner Pools, identical to `verbi-presente`'s. Each covers at least five Items.
 *
 * Annotated as `Preset[]` for the same reason the choice Game's are: inference would widen the
 * heterogeneous `include` maps into a union nothing assigns to `Record<string, string[]>`.
 * @type {import('../../engine.js').Preset[]}
 */
const PRESETS = [
  { id: 'a1', label: 'A1 - regolari', include: { reg: ['regular', 'spelling'] } },
  { id: 'irregolari', label: 'Irregolari', include: { reg: ['irregular'] } },
  { id: 'tutto', label: 'Tutto', include: { cefr: ['a1'] } },
];

/** One verb Item, exactly as `verbi-presente` declares it. The host never reads these fields. */
/** @typedef {import('../verbi-presente/index.js').VerbItem} VerbItem */

/**
 * The round's queue: the same weighted, without-replacement draw as the choice Game — `size`
 * distinct Items, weakest (lowest mastery) first in expectation — with mastery read from *this*
 * Game's own store, so production practice never borrows recognition's numbers. An empty Pool
 * yields an empty queue; the settings screen is what refuses to start one.
 *
 * @param {VerbItem[]} items the filtered Pool
 * @param {{ size?: number, rng?: () => number, store?: unknown, today?: number }} [options]
 * @returns {VerbItem[]}
 */
export function roundQueue(items, options = {}) {
  return weightedQueue(items, {
    size: options.size,
    rng: options.rng,
    mastery: (item) => masteryOf(options.store, item.id, options.today),
  });
}

/**
 * One reveal question: the Item's prompt and its answer. A reveal Game never draws options — the
 * answer exists to be shown, not to be offered.
 *
 * @param {VerbItem} item
 * @returns {{ prompt: string, answer: string }}
 */
export function revealQuestion(item) {
  return { prompt: item.prompt, answer: item.answer };
}

/** The statistics view's own action, exactly as the choice Game labels it. */
const STATISTICS_LABEL = 'Statistics';

/**
 * A Game's `play()` has nowhere to inject a document, so its own chrome (the summary's Statistics
 * action) and its statistics view draw with the global one — the same default `roundLoop()` itself
 * uses, and guaranteed present by the time either runs. `tools/sanity.mjs` installs a fake with
 * `withFakeDocument()`.
 *
 * @returns {Document}
 */
function activeDocument() {
  return /** @type {Document} */ (globalThis.document);
}

/** @type {import('../../engine.js').Game} */
const verbiPresenteRivela = {
  id: 'verbi-presente-rivela',
  title: 'Verbi · rivela',
  description: 'Produci la forma e autovalutati',
  content: './content/verbi-presente.json',
  fields: FIELDS,
  dims: DIMS,
  presets: PRESETS,
  controls: [ROUND_COUNT],

  /**
   * Draw the round and return its teardown. Synchronous, no phases, no lifecycle.
   * @param {Element} root
   * @param {import('../../engine.js').Session} session
   * @returns {() => void}
   */
  play(root, session) {
    const host = /** @type {HTMLElement} */ (root);
    const items = /** @type {VerbItem[]} */ (session.pool);
    // The statistics describe the Game, not the round: the views read the Game's whole current
    // corpus, so a filtered round still shows every Tag and every attempted Item — and an Item the
    // corpus no longer has is left out without its stored entry being deleted.
    const corpus = Array.isArray(session.content) ? /** @type {VerbItem[]} */ (session.content) : items;
    const store = session.store;
    const count = roundCount(session.settings);
    const rng = session.rng;

    /**
     * Which Item each drawn question asks. `sample()` is the only place a question is made, so this
     * can never disagree with what the loop is showing.
     * @type {WeakMap<object, VerbItem>}
     */
    const asked = new WeakMap();

    // `sample()` is the loop's only source of a queue, so Play again is always a fresh draw — and
    // mastery is read at draw time from this Game's own store, which is what keeps its progress
    // separate from `verbi-presente` despite the shared Items.
    const sample = () =>
      roundQueue(items, { size: count, rng, store }).map((item) => {
        const question = revealQuestion(item);
        asked.set(question, item);
        return question;
      });

    /** The round and the Game's statistics view: two views of the same Game, swapping in place. */
    /** @type {HTMLElement | null} */
    let round = null;
    /** @type {{ section: HTMLElement, refresh: () => void } | null} */
    let stats = null;

    /** Show the Game's statistics, refreshed from this Game's store as it stands now. */
    function showStats() {
      if (round === null || stats === null) return;
      stats.refresh();
      round.hidden = true;
      stats.section.hidden = false;
    }

    /** Back to that same round summary — not a route, and not a way out of the Game. */
    function showSummary() {
      if (round === null || stats === null) return;
      stats.section.hidden = true;
      round.hidden = false;
    }

    const loop = roundLoop(host, {
      mode: 'reveal',
      sample,
      // The self-grade is recorded the moment the player gives it — through the shared US-017
      // policy, into this Game's own store, over this Game's whole current corpus. The points it
      // earned are what the summary adds up; a store-less Session still plays, it just forgets.
      onAnswer: (question, correct) => {
        const item = asked.get(question);
        if (item === undefined) return correct ? POINTS_CORRECT : 0;
        return recordAttempt(store, item, correct, { items: corpus });
      },
      // The Game's own action, between Play again and Done (the loop calls this once, at build).
      summaryActions: (container) => {
        const button = activeDocument().createElement('button');
        button.type = 'button';
        button.className = 'text-btn';
        button.textContent = STATISTICS_LABEL;
        button.addEventListener('click', showStats);
        container.append(button);
      },
    });

    round = loop.section;
    stats = statisticsView(activeDocument(), { store, items: corpus, onSummary: showSummary });
    host.append(stats.section);
    return loop.teardown;
  },
};

export default verbiPresenteRivela
