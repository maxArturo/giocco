// @ts-check
/**
 * `roundLoop()` — the shared question cycle: ask → judge → feed back → advance → summarise.
 *
 * It is a library a Game opts into (`README.md` § Architecture); the host neither knows nor cares
 * whether a round used it. A Game builds its own queue from `session.pool` — weighted, without
 * replacement, one `Question` per Item — hands it to `roundLoop()`, and gets the whole cycle: four
 * option buttons with tap feedback, or reveal-and-self-grade, a meter bound to the *actual* queue
 * length, a summary with points and up to three misses, and a teardown.
 *
 * Everything the loop cannot decide itself is a callback, and nothing else is. `sample()` is the
 * only source of a queue, so "Play again" is always a fresh draw; `onAnswer(question, correct)`
 * records one attempt in the Game's own store and returns the points it earned; `summaryActions()`
 * is where a Game appends its own action (a statistics view) beside Play again and Done. The loop
 * never touches `session`, storage or a content file: it draws exactly what it is handed, judges a
 * choice by string equality with the Item's `answer`, and keeps its counters in memory.
 *
 * The DOM is built once and every later step is a *mutation* — `textContent`, `className`, `hidden`
 * and `data-state` — never a re-mount and never `innerHTML`. That is what keeps focus stable: each
 * `ask` re-focuses `#prompt` with `{ preventScroll: true }` so the new question is announced
 * without the page moving under the thumb.
 *
 * Chrome copy is English ("Show answer", "I was right", "Play again", "Done"); the exercise content
 * and the status line stay Italian ("corretto", "giusto: cerchi"). `document`, `setTimeout`,
 * `clearTimeout` and `now` are injectable defaults — the `storage.js` / `ui.js` rule — so
 * `tools/sanity.mjs` drives the whole cycle, its 250 ms tap guard and its 700/1400 ms auto-advance
 * without a browser.
 *
 * Nothing here imports `router.js` for the hub route: `registry → Game → roundLoop → router →
 * registry` would be a cycle that TDZ-fails when the structural gate imports a Game module, so the
 * loop keeps the frozen `'#/'` itself and the sanity suite asserts the two agree.
 */

/**
 * One question: what to draw, its answer, and — in `choice` mode — the options to offer, in the
 * order they are shown. The Game owns option order (answer plus its authored distractors); the
 * loop only marks which one is the answer.
 * @typedef {{
 *   prompt: string,
 *   answer: string,
 *   options?: string[],
 * }} Question
 */

/**
 * What a Game hands `roundLoop()`. `mode` and `sample` are the only required entries.
 * @typedef {{
 *   mode: 'choice' | 'reveal',
 *   sample: () => Question[],
 *   onAnswer?: (question: Question, correct: boolean) => number,
 *   summaryActions?: (container: HTMLElement) => void,
 *   onState?: (state: string) => void,
 *   document?: Document,
 *   setTimeout?: (handler: () => void, ms: number) => number,
 *   clearTimeout?: (id: number) => void,
 *   now?: () => number,
 * }} RoundLoopOptions
 */

/** The cycle's five states; `advance` is the transit between two questions. */
/** @typedef {'ask' | 'feedback' | 'selfGrade' | 'advance' | 'summary'} RoundState */

/** What `roundLoop()` returns: the section it built, its state, and its teardown. */
/** @typedef {{ section: HTMLElement, state: () => RoundState, teardown: () => void }} RoundLoop */

/** Option buttons built once, and therefore the four rows `.options` reserves. */
export const OPTION_ROWS = 4;

/** How many misses the summary lists. */
export const MAX_MISSES = 3;

/** Choice auto-advance: fast when right, slow enough to read the answer when wrong. */
export const CORRECT_DELAY = 700;
export const WRONG_DELAY = 1400;

/** A tap this soon after feedback began is the tap that caused it, and is ignored. */
export const TAP_GUARD = 250;

/** How long a self-grade shows its confirmation before advancing. */
export const CONFIRM_DELAY = 250;

/** A Game's default points per correct answer, used when it passes no `onAnswer`. */
export const POINTS_PER_CORRECT = 10;

/**
 * The hub route. `router.js` owns it, but importing it here would close the
 * registry → Game → roundLoop → router → registry cycle, so the loop carries the literal.
 */
const HUB_HASH = '#/';

const SHOW_ANSWER_LABEL = 'Show answer';
const GRADE_RIGHT_LABEL = 'I was right';
const GRADE_WRONG_LABEL = 'I was wrong';
const PLAY_AGAIN_LABEL = 'Play again';
const DONE_LABEL = 'Done';

/** Choice feedback and the self-grade's confirmation, in Italian as feedback copy is. */
const CORRECT_TEXT = 'corretto';
const WRONG_PREFIX = 'giusto: ';
const REVIEW_TEXT = 'da rivedere';

/**
 * Build the loop in the node a Game draws into and start the first question.
 *
 * @param {HTMLElement} root the node `play(root, session)` was handed
 * @param {RoundLoopOptions} [options] `mode` and `sample` are required and checked below
 * @returns {RoundLoop}
 */
export function roundLoop(root, options = /** @type {RoundLoopOptions} */ ({})) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('giocco roundLoop: a document-like object is required');
  }
  const mode = options.mode;
  if (mode !== 'choice' && mode !== 'reveal') {
    throw new Error(`giocco roundLoop: mode must be "choice" or "reveal", got ${String(mode)}`);
  }
  const sample = options.sample;
  if (typeof sample !== 'function') throw new Error('giocco roundLoop: a sample() function is required');

  const record = options.onAnswer ?? ((question, correct) => (correct ? POINTS_PER_CORRECT : 0));
  const schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const cancel = options.clearTimeout ?? ((id) => clearTimeout(id));
  const clock = options.now ?? Date.now;

  /**
   * @template {keyof HTMLElementTagNameMap} T
   * @param {T} tag
   * @param {string} [className]
   * @returns {HTMLElementTagNameMap[T]}
   */
  function el(tag, className) {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    return node;
  }

  // ---- the one DOM, built here and never again -------------------------------------------

  const section = el('section', 'round');
  section.id = 'round';
  section.setAttribute('data-state', 'ask');
  section.setAttribute('aria-labelledby', 'prompt');

  // Meter and ordinal: the ordinal is the question's position in the *actual* queue, so a thin
  // pool shows 3/5 rather than 3/10.
  const bar = el('header', 'bar');
  const meter = el('div', 'meter');
  const meterFill = el('i');
  meter.append(meterFill);
  const ordinal = el('span');
  bar.append(meter, ordinal);

  const prompt = el('h1');
  prompt.id = 'prompt';
  prompt.tabIndex = -1;

  // The polite live region, and the only carrier of feedback copy: the choice verdict, the
  // revealed answer, the self-grade's confirmation.
  const status = el('p', 'status');
  status.id = 'status';
  status.setAttribute('aria-live', 'polite');

  const optionsGroup = el('div', 'options');
  optionsGroup.setAttribute('role', 'group');
  optionsGroup.setAttribute('aria-labelledby', 'prompt');

  /** @type {HTMLButtonElement[]} */
  const optionButtons = [];
  for (let index = 0; index < OPTION_ROWS; index += 1) {
    const button = el('button', 'opt');
    button.type = 'button';
    button.addEventListener('click', () => choose(index));
    optionsGroup.append(button);
    optionButtons.push(button);
  }

  /** The reveal Game's action bar: one full-width Show answer, then the two grades. */
  const actions = el('div', 'actions');
  actions.id = 'actions';
  const showAnswer = el('button', 'grade wide');
  showAnswer.type = 'button';
  showAnswer.textContent = SHOW_ANSWER_LABEL;
  showAnswer.addEventListener('click', reveal);
  const gradeRight = el('button', 'grade');
  gradeRight.type = 'button';
  gradeRight.textContent = GRADE_RIGHT_LABEL;
  gradeRight.addEventListener('click', () => grade(true));
  const gradeWrong = el('button', 'grade');
  gradeWrong.type = 'button';
  gradeWrong.textContent = GRADE_WRONG_LABEL;
  gradeWrong.addEventListener('click', () => grade(false));
  actions.append(showAnswer, gradeRight, gradeWrong);

  const summary = el('div', 'summary');
  const score = el('p', 'score');
  const pointsText = el('p', 'points');
  const missesList = el('ul', 'misses');
  /** @type {HTMLElement[]} */
  const missSlots = [];
  for (let index = 0; index < MAX_MISSES; index += 1) {
    const slot = el('li', 'miss');
    slot.hidden = true;
    missesList.append(slot);
    missSlots.push(slot);
  }
  const summaryButtons = el('div', 'actions');
  const playAgain = el('button', 'start');
  playAgain.type = 'button';
  playAgain.textContent = PLAY_AGAIN_LABEL;
  playAgain.addEventListener('click', start);
  summaryButtons.append(playAgain);
  // The Game's own action (a statistics view, say) sits between the two host controls.
  if (typeof options.summaryActions === 'function') options.summaryActions(summaryButtons);
  const done = el('a', 'text-btn');
  done.href = HUB_HASH;
  done.textContent = DONE_LABEL;
  summaryButtons.append(done);
  summary.append(score, pointsText, missesList, summaryButtons);

  section.append(bar, prompt, status, optionsGroup, actions, summary);
  root.append(section);

  // ---- state -----------------------------------------------------------------------------

  /** @type {RoundState} */
  let state = 'ask';
  /** @type {Question[]} */
  let queue = [];
  let cursor = 0;
  let correctCount = 0;
  let points = 0;
  /** @type {Question[]} */
  let misses = [];
  /** When the current feedback began, for the tap guard. */
  let feedbackAt = 0;
  let graded = false;
  /** @type {number | null} */
  let timer = null;

  /** Everything hidden/shown is a function of the state and the mode, computed in one place. */
  function applyVisibility() {
    const onSummary = state === 'summary';
    bar.hidden = onSummary;
    prompt.hidden = onSummary;
    status.hidden = onSummary;
    summary.hidden = !onSummary;
    optionsGroup.hidden = onSummary || mode === 'reveal';
    // The choice game never uses the action bar: its feedback auto-advances.
    actions.hidden = mode === 'choice' || onSummary;
    showAnswer.hidden = mode !== 'reveal' || state !== 'ask';
    gradeRight.hidden = mode !== 'reveal' || state !== 'selfGrade';
    gradeWrong.hidden = mode !== 'reveal' || state !== 'selfGrade';
  }

  /** @param {RoundState} next */
  function setState(next) {
    state = next;
    section.setAttribute('data-state', next);
    applyVisibility();
    if (typeof options.onState === 'function') options.onState(next);
  }

  function clearTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  /** @param {number} ms */
  function scheduleAdvance(ms) {
    clearTimer();
    timer = schedule(() => {
      timer = null;
      advance();
    }, ms);
  }

  /** Meter and ordinal for the current cursor, against the actual queue length. */
  function updateBar() {
    const total = queue.length;
    // The summary hides the bar, and advancing past the last question must not leave a 6/5 in
    // the DOM for anyone reading it: the position is clamped to the queue's own length.
    const shown = Math.min(cursor + 1, total);
    ordinal.textContent = `${shown}/${total}`;
    meterFill.setAttribute('style', `width:${total === 0 ? 0 : Math.round((shown / total) * 100)}%`);
  }

  /** An attempt is recorded the moment it happens, so leaving the round keeps it. */
  /** @param {Question} question @param {boolean} right */
  function recordAttempt(question, right) {
    if (right) correctCount += 1;
    else if (misses.length < MAX_MISSES) misses.push(question);
    const earned = Number(record(question, right));
    points += Number.isFinite(earned) ? earned : 0;
  }

  function start() {
    clearTimer();
    const next = sample();
    if (!Array.isArray(next)) throw new Error('giocco roundLoop: sample() must return an array');
    queue = next;
    cursor = 0;
    correctCount = 0;
    points = 0;
    misses = [];
    graded = false;
    feedbackAt = 0;
    if (queue.length === 0) renderSummary();
    else renderAsk();
  }

  function renderAsk() {
    const question = queue[cursor];
    prompt.textContent = question.prompt;
    status.textContent = '';
    section.removeAttribute('data-grade');
    graded = false;
    gradeRight.setAttribute('aria-pressed', 'false');
    gradeWrong.setAttribute('aria-pressed', 'false');
    if (mode === 'choice') {
      const labels = question.options ?? [];
      optionButtons.forEach((button, index) => {
        const label = labels[index];
        button.textContent = label ?? '';
        button.hidden = label === undefined;
        button.className = 'opt';
      });
    }
    updateBar();
    setState('ask');
    prompt.focus({ preventScroll: true });
  }

  /** @param {number} index */
  function choose(index) {
    if (state !== 'ask' || mode !== 'choice') return;
    const question = queue[cursor];
    const label = (question.options ?? [])[index];
    if (label === undefined) return;
    const right = label === question.answer;
    recordAttempt(question, right);

    optionButtons.forEach((button, at) => {
      const option = (question.options ?? [])[at];
      if (option === undefined) button.className = 'opt';
      else if (option === question.answer) button.className = 'opt correct';
      else if (at === index) button.className = 'opt wrong';
      else button.className = 'opt';
    });

    status.textContent = right ? CORRECT_TEXT : `${WRONG_PREFIX}${question.answer}`;
    feedbackAt = clock();
    setState('feedback');
    scheduleAdvance(right ? CORRECT_DELAY : WRONG_DELAY);
  }

  /** The reveal Game's "Show answer": the answer lands in the polite status line, ungraded. */
  function reveal() {
    if (state !== 'ask' || mode !== 'reveal') return;
    status.textContent = queue[cursor].answer;
    setState('selfGrade');
  }

  /** @param {boolean} right */
  function grade(right) {
    if (state !== 'selfGrade' || mode !== 'reveal' || graded) return;
    graded = true;
    const question = queue[cursor];
    recordAttempt(question, right);
    status.textContent = right ? CORRECT_TEXT : REVIEW_TEXT;
    section.setAttribute('data-grade', right ? 'ok' : 'bad');
    (right ? gradeRight : gradeWrong).setAttribute('aria-pressed', 'true');
    scheduleAdvance(CONFIRM_DELAY);
  }

  /** The transit between two questions: meter first, then the next question or the summary. */
  function advance() {
    if (state !== 'feedback' && state !== 'selfGrade') return;
    clearTimer();
    setState('advance');
    // Leaving selfGrade clears its confirmation, so a summary never carries a stale grade.
    gradeRight.setAttribute('aria-pressed', 'false');
    gradeWrong.setAttribute('aria-pressed', 'false');
    section.removeAttribute('data-grade');
    cursor += 1;
    updateBar();
    if (cursor < queue.length) renderAsk();
    else renderSummary();
  }

  function renderSummary() {
    score.textContent = `${correctCount}/${queue.length}`;
    pointsText.textContent = `+${points} pt`;
    missSlots.forEach((slot, index) => {
      const miss = misses[index];
      slot.textContent = miss ? miss.prompt : '';
      slot.hidden = miss === undefined;
    });
    missesList.hidden = misses.length === 0;
    setState('summary');
  }

  // A tap during feedback advances — but not the tap that produced it: the answering tap bubbles
  // here within a millisecond of `feedbackAt`, and is swallowed by the guard.
  function onSectionClick() {
    if (state !== 'feedback') return;
    if (clock() - feedbackAt < TAP_GUARD) return;
    advance();
  }
  section.addEventListener('click', onSectionClick);

  start();

  return {
    section,
    state: () => state,
    teardown: () => {
      clearTimer();
      section.removeEventListener('click', onSectionClick);
      root.replaceChildren();
    },
  };
}
