// @ts-check
/**
 * `nomi-plurale` — Italian noun plurals: prompt, four options, one answer.
 *
 * This module is the US-004 registration; `content`, `fields`, `dims`, `presets`, the
 * round-count `controls` and the shared `roundLoop()` interaction arrive with US-015/US-016.
 * Its counters, points and Mastery stay in its own store.
 */

export default {
  id: 'nomi-plurale',
  title: 'Nomi · plurale',
  description: 'Singolare → plurale',

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
