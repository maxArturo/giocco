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
 * reads `masteryOf` from `session.store`, which boot fills with this id's slice and nothing else,
 * and the verbs can neither see nor average it. The shared *policy* is imported from
 * `../verbi-presente/index.js` rather than copied, so the weight and the queue length cannot
 * drift between the three drills while the stores stay per-id.
 *
 * The host handed over a filtered Pool and an RNG (`engine.js`); `roundLoop()` runs the choice
 * cycle and judges every tap; the store stays opaque to both.
 */

import { roundLoop } from '../../lib/roundLoop.js';
import { masteryOf, roundCount, shuffle, weightedQueue } from '../verbi-presente/index.js';

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
 * mastery read from *this* Game's own store, so noun practice never borrows a verb Game's
 * numbers. An empty Pool yields an empty queue; the settings screen is what refuses to start one.
 *
 * @param {NounItem[]} items the filtered Pool
 * @param {{ size?: number, rng?: () => number, store?: unknown, today?: number }} [options]
 * @returns {NounItem[]}
 */
export function roundQueue(items, options = {}) {
  return weightedQueue(items, {
    size: options.size,
    rng: options.rng,
    mastery: (item) => masteryOf(options.store, item.id, options.today),
  });
}

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
    const count = roundCount(session.settings);
    const rng = session.rng;
    // `sample()` is the loop's only source of a queue, so Play again is always a fresh draw — and
    // mastery is read at draw time from this Game's own store, which is what keeps its progress
    // out of both verb Games despite the shared policy.
    const sample = () =>
      roundQueue(items, { size: count, rng, store: session.store }).map((item) => questionFor(item, rng));
    return roundLoop(host, { mode: 'choice', sample }).teardown;
  },
};

export default nomiPlurale;
