// @ts-check
/**
 * `verbi-presente` — recognise present-tense verb forms: prompt, four options, one answer.
 *
 * Registered by `js/registry.js` (US-004); the drill lands in US-012/US-013, which declare
 * `content`, `fields`, `dims`, `presets` and the round-count `controls` and replace this
 * `play()` with the shared `roundLoop()` implementation. The host only ever reads the
 * declaration, so a Game that declares nothing else still gets a hub card and a back control.
 *
 * `id` is permanent (it is in the route and the storage key); `title` is display-only.
 */

export default {
  id: 'verbi-presente',
  title: 'Verbi · presente',
  description: 'Coniugazioni al presente',

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
