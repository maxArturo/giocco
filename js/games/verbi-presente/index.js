// @ts-check
/**
 * `verbi-presente` — recognise present-tense verb forms: prompt, four options, one answer.
 *
 * Registered by `js/registry.js` (US-004); the drill lands in US-012/US-013, which declare
 * `content`, `fields` and `presets` and replace this `play()` with the shared `roundLoop()`
 * implementation. The host only ever reads the declaration, so a Game that declares nothing
 * else still gets a hub card, a settings screen with its round-count control and a back control.
 *
 * `id` is permanent (it is in the route and the storage key); `title` is display-only.
 */

/** The shared round-count control every Game declares (US-007). */
const ROUND_COUNT = {
  id: 'count',
  label: 'Round',
  options: [5, 10, 20],
  default: 10,
};

export default {
  id: 'verbi-presente',
  title: 'Verbi · presente',
  description: 'Coniugazioni al presente',
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
