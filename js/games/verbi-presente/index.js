// @ts-check
/**
 * `verbi-presente` — recognise present-tense verb forms: prompt, four options, one answer.
 *
 * Registered by `js/registry.js` (US-004). US-012 declares the taxonomy and the shared corpus
 * here — this module is the only place that knows what a verb Item looks like, because the host
 * must not. US-013 replaces the placeholder `play()` with the `roundLoop()` drill.
 *
 * `id` is permanent (it is in the route and the storage key); `title` is display-only.
 * `verbi-presente-rivela` declares the same `content`, `fields`, `dims` and `presets` (the gate
 * validates the one file against both), so the two declarations must stay in step.
 */

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

/** Named learner Pools. Every one of them covers at least five Items of the shipped corpus. */
const PRESETS = [
  { id: 'a1', label: 'A1 - regolari', include: { reg: ['regular', 'spelling'] } },
  { id: 'irregolari', label: 'Irregolari', include: { reg: ['irregular'] } },
  { id: 'tutto', label: 'Tutto', include: { cefr: ['a1'] } },
];

export default {
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
    return () => {};
  },
};
