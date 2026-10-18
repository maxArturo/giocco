// @ts-check
/**
 * `verbi-presente` — recognise present-tense verb forms: prompt, four options, one answer.
 *
 * Registered by `js/registry.js` (US-004). US-012 declares the taxonomy and the shared corpus
 * here — this module is the only place that knows what a verb Item looks like, because the host
 * must not. US-013 draws the round: a weighted, without-replacement queue of at most the chosen
 * round length, each Item asked with its own answer plus its three authored distractors.
 *
 * `id` is permanent (it is in the route and the storage key); `title` is display-only.
 * `verbi-presente-rivela` declares the same `content`, `fields`, `dims` and `presets` (the gate
 * validates the one file against both), so the two declarations must stay in step.
 *
 * Everything here is the Game's own business: the weight, the queue length, the option order and
 * the judging. The host handed over a filtered Pool and an RNG (`engine.js`); `roundLoop()` runs
 * the question cycle; the store stays opaque to both.
 */

import { roundLoop } from '../../lib/roundLoop.js';

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
 * Named learner Pools. Every one of them covers at least five Items of the shipped corpus.
 *
 * Annotated as `Preset[]` rather than left to inference: a heterogeneous array of object
 * literals (`{ reg } | { cefr }`) infers a union whose members carry `cefr?: undefined`, and no
 * `Record<string, string[]>` accepts an `undefined`-typed key — which would fail the registry's
 * `Game[]` and tempt a cast into host code.
 * @type {import('../../engine.js').Preset[]}
 */
const PRESETS = [
  { id: 'a1', label: 'A1 - regolari', include: { reg: ['regular', 'spelling'] } },
  { id: 'irregolari', label: 'Irregolari', include: { reg: ['irregular'] } },
  { id: 'tutto', label: 'Tutto', include: { cefr: ['a1'] } },
];

/** One verb Item, as this Game draws it. The host never reads these fields. */
/** @typedef {{ id: string, prompt: string, answer: string, distractors: string[], tags: string[] }} VerbItem */

/** The weight an unseen Item carries: mastery 0 leaves the flat `+0.2` on top of `1`. */
export const BASE_WEIGHT = 0.2;

/** An Item nobody has attempted yet. The default every mastery read falls back to. */
export const UNSEEN_MASTERY = 0;

/** Mastery halves over this many local days without practice (docs § D). */
const DECAY_DAYS = 14;

/** One local day, for the epoch-day arithmetic below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {number} value @returns {number} */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The local epoch-day for a timestamp — the calendar day the player is actually living in, since
 * `last` is written in local days and mastery decays per day. Negative before 1970, as the epoch
 * itself is.
 *
 * @param {number} [ms] defaults to now
 * @returns {number}
 */
export function epochDay(ms = Date.now()) {
  return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / DAY_MS);
}

/**
 * The weight of an Item in the draw: `(1 - mastery) + 0.2`, so a weak Item comes up more often
 * than a known one and an unseen Item (mastery 0) comes up most often of all.
 *
 * @param {number} mastery 0..1
 * @returns {number}
 */
export function itemWeight(mastery) {
  return 1 - clamp01(mastery) + BASE_WEIGHT;
}

/**
 * What one stored per-Item entry currently represents: `ema * 0.5 ** (daysSince(last) / 14)`, so
 * an Item you stopped practising fades instead of sitting at its best-ever score. An Item with no
 * entry — or an entry from before progress existed — is unseen: mastery 0.
 *
 * @param {unknown} store this Game's own slice, never the host's
 * @param {string} id
 * @param {number} [today] local epoch-day, defaults to today
 * @returns {number}
 */
export function masteryOf(store, id, today = epochDay()) {
  const items = store && typeof store === 'object' ? /** @type {any} */ (store).items : undefined;
  const entry = items && typeof items === 'object' ? items[id] : undefined;
  if (!entry || typeof entry !== 'object') return UNSEEN_MASTERY;
  const ema = Number(entry.ema);
  if (!Number.isFinite(ema)) return UNSEEN_MASTERY;
  const last = Number(entry.last);
  const days = Number.isFinite(last) ? Math.max(0, today - last) : 0;
  return clamp01(ema) * Math.pow(0.5, days / DECAY_DAYS);
}

/**
 * A Fisher–Yates shuffle over a copy: the option order is drawn once per question, with the
 * Session's injectable RNG, so a question's four options never move under the thumb.
 *
 * @param {string[]} values
 * @param {() => number} rng
 * @returns {string[]}
 */
export function shuffle(values, rng) {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const held = out[index];
    out[index] = out[swap];
    out[swap] = held;
  }
  return out;
}

/**
 * The round's queue: `size` distinct Items out of `items`, drawn without replacement, with an
 * Item's chance of being picked before another proportional to its weight. The key is
 * `u ** (1 / weight)` (Efraimidis–Spirakis): a heavier Item's key lands nearer 1, so sorting the
 * keys descending *is* a weighted draw without replacement, and no Item can repeat in a round.
 * Ties keep the caller's order, so a constant RNG draws strictly by weight.
 *
 * An empty Pool yields an empty queue — the settings screen is what refuses to start one.
 *
 * @param {VerbItem[]} items the filtered Pool
 * @param {{ size?: number, rng?: () => number, mastery?: (item: VerbItem, index: number) => number }} [options]
 * @returns {VerbItem[]}
 */
export function weightedQueue(items, options = {}) {
  const rng = options.rng ?? Math.random;
  const mastery = options.mastery ?? (() => UNSEEN_MASTERY);
  const wanted = Number.isFinite(options.size) ? Math.max(0, Math.floor(/** @type {number} */ (options.size))) : items.length;
  const keys = items.map((item, index) => {
    const weight = itemWeight(mastery(item, index));
    const key = Math.pow(clamp01(rng()), 1 / weight);
    return { item, index, key: Number.isFinite(key) ? key : 0 };
  });
  keys.sort((a, b) => b.key - a.key || a.index - b.index);
  return keys.slice(0, Math.min(wanted, items.length)).map((entry) => entry.item);
}

/**
 * One question: the Item's prompt, its answer, and its own four options. The answer plus the
 * three authored distractors are always all four — nothing is sampled from another Item.
 *
 * @param {VerbItem} item
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

/**
 * The round length the player chose, or the declared default when nothing usable was saved (a
 * first visit before the settings screen completed the object, say).
 *
 * @param {import('../../engine.js').Settings} settings
 * @returns {number}
 */
export function roundCount(settings) {
  const chosen = Number(settings?.controls?.count);
  if (Number.isFinite(chosen) && chosen > 0) return Math.floor(chosen);
  // The declaration's own default, which `Control.default` types as `string | number`.
  const declared = Number(ROUND_COUNT.default);
  return Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 10;
}

/** @type {import('../../engine.js').Game} */
const verbiPresente = {
  id: 'verbi-presente',
  title: 'Verbi · presente',
  description: 'Coniugazioni al presente',
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
    // mastery is read at draw time, which is what makes a weak Item come up more often.
    const sample = () =>
      weightedQueue(items, {
        size: count,
        rng,
        mastery: (item) => masteryOf(session.store, item.id),
      }).map((item) => questionFor(item, rng));
    return roundLoop(host, { mode: 'choice', sample }).teardown;
  },
};

export default verbiPresente
