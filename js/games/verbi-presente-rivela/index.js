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
 * The one thing they deliberately share is the *policy*: the store-reading draw (`roundQueue`),
 * the round-count control (`roundCount`), the whole progress core (`recordAttempt`) and the
 * statistics pair (`statisticsPanel`) are imported from `../verbi-presente/index.js` rather than
 * copied, so "the same policy as the choice Game" is a fact of the code and not a hope. Nothing
 * about those helpers reads a store other than the one this Game hands them: every one of them
 * takes the store as an argument, so production progress is written into, and read from,
 * `storage.store('verbi-presente-rivela')` alone — the two verb drills share one corpus and one
 * policy and never share a number.
 *
 * The host handed over a filtered Pool and an RNG (`engine.js`); `roundLoop()` runs the
 * reveal/self-grade cycle; the store stays opaque to both.
 */

import { roundLoop } from '../../lib/roundLoop.js';
import {
  recordAttempt,
  roundCount,
  roundQueue,
  statisticsPanel,
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
 * One reveal question: the Item's prompt and its answer. A reveal Game never draws options — the
 * answer exists to be shown, not to be offered.
 *
 * @param {VerbItem} item
 * @returns {{ prompt: string, answer: string }}
 */
export function revealQuestion(item) {
  return { prompt: item.prompt, answer: item.answer };
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

    const stats = statisticsPanel({ store, items: corpus });

    const loop = roundLoop(host, {
      mode: 'reveal',
      sample,
      // The self-grade is recorded the moment the player gives it — through the shared US-017
      // policy, into this Game's own store, over this Game's whole current corpus. The points it
      // earned are what the summary adds up; a store-less Session still plays, it just forgets.
      onAnswer: (question, correct) => {
        const item = asked.get(question);
        if (item === undefined) throw new Error('giocco: a question this Game did not draw');
        return recordAttempt(store, item, correct, { items: corpus });
      },
      // The Game's own action, between Play again and Done (the loop calls this once, at build).
      summaryActions: stats.action,
    });

    stats.bind(loop.section);
    host.append(stats.section);
    return loop.teardown;
  },
};

export default verbiPresenteRivela;
