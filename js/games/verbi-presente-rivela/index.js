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
 * (`weightedQueue`), the mastery read (`masteryOf`) and the round-count control (`roundCount`) are
 * imported from `../verbi-presente/index.js` rather than copied, so "the same queue policy as the
 * choice Game" is a fact of the code and not a hope. Nothing about those helpers reads a store
 * other than the one this Game hands them.
 *
 * The host handed over a filtered Pool and an RNG (`engine.js`); `roundLoop()` runs the
 * reveal/self-grade cycle; the store stays opaque to both.
 */

import { roundLoop } from '../../lib/roundLoop.js';
import { masteryOf, roundCount, weightedQueue } from '../verbi-presente/index.js';

/** The shared round-count control every Game declares (US-007). */
const ROUND_COUNT = {
  id: 'count',
  label: 'Round',
  options: [5, 10, 20],
  default: 10,
};

/**
 * A verb Item draws with `prompt` / `answer` / `distractors` and is filtered by `tags` —
 * exactly these five fields, no authoring-only metadata.
 */
const FIELDS = ['id', 'prompt', 'answer', 'distractors', 'tags'];

/** The verb vocabulary v0.1 (docs/design/content-and-progress.md § A). Declare only what ships. */
const DIMS = [
  { dim: 'mood', values: ['ind'] },
  { dim: 'tense', values: ['pres'] },
  { dim: 'class', values: ['-are', '-ere', '-ire', '-isc'] },
  { dim: 'reg', values: ['regular', 'spelling', 'irregular'] },
  { dim: 'person', values: ['1s', '2s', '3s', '1p', '2p', '3p'] },
  { dim: 'refl', values: ['yes', 'no'] },
  { dim: 'cefr', values: ['a1'] },
];

/** Named learner Pools, identical to `verbi-presente`'s. Each covers at least five Items. */
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

export default {
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
    const count = roundCount(session.settings);
    const rng = session.rng;
    // `sample()` is the loop's only source of a queue, so Play again is always a fresh draw — and
    // mastery is read at draw time from this Game's own store, which is what keeps its progress
    // separate from `verbi-presente` despite the shared Items.
    const sample = () =>
      roundQueue(items, { size: count, rng, store: session.store }).map(revealQuestion);
    return roundLoop(host, { mode: 'reveal', sample }).teardown;
  },
};
