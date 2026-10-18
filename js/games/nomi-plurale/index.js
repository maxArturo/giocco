// @ts-check
/**
 * `nomi-plurale` — Italian noun plurals: prompt, four options, one answer.
 *
 * Registered by `js/registry.js` (US-004). US-015 declares the taxonomy and the hand-authored
 * corpus here — this module is the only place that knows what a noun Item looks like, because
 * the host must not. US-016 draws the round with the shared choice interaction.
 *
 * `id` is permanent (it is in the route and the storage key); `title` is display-only. Its
 * counters, points and Mastery stay in its own store, separate from both verb Games.
 *
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
    return () => {};
  },
};

export default nomiPlurale;
