// @ts-check
/**
 * `nomi-plurale` — Italian noun plurals: prompt, four options, one answer.
 *
 * Registered by `js/registry.js` (US-004). US-015 declares the taxonomy and the hand-authored
 * corpus here — this module is the only place that knows what a noun Item looks like, because
 * the host must not. US-016 draws the round: the same weighted, without-replacement queue and
 * the same shared choice interaction as `verbi-presente`, over this Game's own Item shape.
 *
 * `id` is permanent (it is in the route and the storage key); `title` is display-only. Its
 * counters, points and Mastery stay in its own store, separate from both verb Games: the draw
 * reads mastery from `session.store`, which boot fills with this id's slice and nothing else,
 * and the verbs can neither see nor average it. The shared *policy* is imported from
 * `../verbi-presente/index.js` rather than copied, so the weight and the queue length cannot
 * drift between the three drills while the stores stay per-id.
 *
 * The host handed over a filtered Pool and an RNG (`engine.js`); `roundLoop()` runs the choice
 * cycle and judges every tap; the store stays opaque to both.
 *
 * US-019 adds the progress: an answered question writes `{ a, c, ema, last }` for the Item it
 * asked, the points it earned, today's local bucket and this week's Tag snapshot into *this*
 * Game's store, and the round summary's own **Statistics** action draws the four documented
 * sections from those numbers alone. Not one formula is restated here — `recordAttempt()`,
 * `statisticsPanel()` and the points rules are the same US-017 policy the two verb drills use,
 * imported and handed this Game's own store, so the three Games can share one policy and still
 * never share a number.
 */

import { roundLoop } from '../../lib/roundLoop.js';
import {
  recordAttempt,
  roundCount,
  roundQueue,
  shuffle,
  statisticsPanel,
} from '../verbi-presente/index.js';

/**
 * Every declaration literal is annotated with `engine.js`'s own typedefs (`Control`, `Dim`,
 * `Preset`, `Game`) so there is exactly one definition of each shape: contextual typing then
 * checks a heterogeneous `presets` array against `include: Record<string, string[]>`, instead of
 * inferring a union of object literals whose missing `include` key is `undefined`-typed — which
 * fails `registry.js`'s `Game[]` and would tempt a cast into the host.
 */

/** @type {import('../../engine.js').Control} The shared round-count control every Game declares. */
const ROUND_COUNT = {
  id: 'count',
  label: 'Round',
  options: [5, 10, 20],
  default: 10,
};

/**
 * A noun Item draws with `prompt` / `answer` / `distractors` and is filtered by `tags` —
 * exactly these five fields, no authoring-only metadata.
 * @type {string[]}
 */
const FIELDS = ['id', 'prompt', 'answer', 'distractors', 'tags'];

/**
 * The noun vocabulary v0.1 (docs/design/content-and-progress.md § A). Declare only what ships:
 * every value below carries at least five Items, and `m/f` is absent because no ambiguous-gender
 * noun is authored yet — a declared value with no Items is a permanently disabled toggle.
 *
 * `plural` names the vowel change the plural makes, not the part of speech: `-o/-i` is the plain
 * masculine, `-co/-chi` keeps the hard sound with an `h`, `-co/-ci` shifts it (`amico → amici`),
 * `-cia/-gie` keeps the `i` (`camicia → camicie`, `ciliegia → ciliegie`) while `-cia/-ce` drops
 * it (`arancia → arance`), `-o/-a` is the gender-changing plural (`uovo → uova`), `invariabile`
 * never changes (`città → città`) and `irregolare` is a plural no rule predicts
 * (`uomo → uomini`, `la mano → le mani`).
 * @type {import('../../engine.js').Dim[]}
 */
const DIMS = [
  { dim: 'gender', values: ['m', 'f'] },
  {
    dim: 'plural',
    values: [
      '-o/-i',
      '-a/-e',
      '-e/-i',
      '-co/-chi',
      '-go/-ghi',
      '-ca/-che',
      '-ga/-ghe',
      '-cia/-gie',
      '-cia/-ce',
      'invariabile',
      '-o/-a',
      '-co/-ci',
      'irregolare',
    ],
  },
  { dim: 'irreg', values: ['none', 'plural', 'gender-change'] },
  { dim: 'cefr', values: ['a1'] },
];

/** @type {import('../../engine.js').Preset[]} Named learner Pools, verbatim from US-015. */
const PRESETS = [
  { id: 'a1', label: 'A1 - tutto', include: { cefr: ['a1'] } },
  { id: 'plurali-regolari', label: 'Plurali regolari', include: { irreg: ['none'] } },
  { id: 'plurali-irregolari', label: 'Plurali irregolari', include: { irreg: ['plural', 'gender-change'] } },
];

/** One noun Item, as this Game draws it. The host never reads these fields. */
/** @typedef {{ id: string, prompt: string, answer: string, distractors: string[], tags: string[] }} NounItem */

/**
 * The round's queue: the same weighted, without-replacement draw as the choice verb Game —
 * `min(size, items.length)` distinct Items, weakest (lowest mastery) first in expectation — with
 * mastery read from *this* Game's own store, so noun practice never borrows a verb Game's numbers.
 * That store-reading draw is `roundQueue()` from the choice verb Game, imported rather than
 * restated. An empty Pool yields an empty queue; the settings screen is what refuses to start one.
 */

/**
 * One question: the Item's prompt, its answer, and its own four options. The answer plus the
 * three authored distractors are always all four — nothing is sampled from another Item (which
 * would offer a plural of a different noun as a plausible-looking distractor).
 *
 * @param {NounItem} item
 * @param {() => number} rng
 * @returns {import('../../lib/roundLoop.js').Question}
 */
export function questionFor(item, rng) {
  return {
    prompt: item.prompt,
    answer: item.answer,
    options: shuffle([item.answer, ...item.distractors], rng),
  };
}

/** @type {import('../../engine.js').Game} */
const nomiPlurale = {
  id: 'nomi-plurale',
  title: 'Nomi · plurale',
  description: 'Singolare → plurale',
  content: './content/nomi-plurale.json',
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
    const items = /** @type {NounItem[]} */ (session.pool);
    // The statistics describe the Game, not the round: the views read the Game's whole current
    // corpus, so a filtered round still shows every Tag and every attempted Item — and an Item the
    // corpus no longer has is left out without its stored entry being deleted.
    const corpus = Array.isArray(session.content) ? /** @type {NounItem[]} */ (session.content) : items;
    const store = session.store;
    const count = roundCount(session.settings);
    const rng = session.rng;

    /**
     * Which Item each drawn question asks. `sample()` is the only place a question is made, so this
     * can never disagree with what the loop is showing — and identity, not prompt text, decides
     * which Item an attempt belongs to.
     * @type {WeakMap<object, NounItem>}
     */
    const asked = new WeakMap();

    // `sample()` is the loop's only source of a queue, so Play again is always a fresh draw — and
    // mastery is read at draw time from this Game's own store, which is what keeps its progress
    // out of both verb Games despite the shared policy.
    const sample = () =>
      roundQueue(items, { size: count, rng, store }).map((item) => {
        const question = questionFor(item, rng);
        asked.set(question, item);
        return question;
      });

    const stats = statisticsPanel({ store, items: corpus });

    const loop = roundLoop(host, {
      mode: 'choice',
      sample,
      // The answer is recorded the moment the loop judges it — through the shared US-017 policy,
      // into this Game's own store, over this Game's whole current corpus. The points it earned
      // are what the summary adds up; a store-less Session still plays, it just forgets.
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

export default nomiPlurale;
