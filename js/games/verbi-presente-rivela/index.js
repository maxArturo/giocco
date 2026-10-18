// @ts-check
/**
 * `verbi-presente-rivela` — produce a present-tense form, reveal, self-grade.
 *
 * Reads the same content file as `verbi-presente` (US-014) but keeps its own store, so
 * recognition and production never share Mastery. This module is the US-004 registration;
 * the drill and its declarations arrive with US-012/US-014.
 */

export default {
  id: 'verbi-presente-rivela',
  title: 'Verbi · rivela',
  description: 'Produci la forma e autovalutati',

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
