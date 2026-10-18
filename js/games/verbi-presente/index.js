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
 * Everything here is the Game's own business: the weight, the queue length, the option order, the
 * judging, the progress and the statistics. The host handed over a filtered Pool and an RNG
 * (`engine.js`); `roundLoop()` runs the question cycle; the store stays opaque to both.
 *
 * US-017 adds the progress: an attempt writes `{ a, c, ema, last }` for the Item it asked, the
 * points it earned, today's local bucket and this week's Tag snapshot into *this* Game's store,
 * and the summary's own **Statistics** action draws the four documented sections from those
 * numbers alone. None of it leaves the Game — the host persists the store without reading it, and
 * master/skill/points live only in the formulas below.
 */

import { bars, sparkline } from '../../lib/charts.js';
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
 * The round's queue for any Game that draws from a mastery-aware weighted pool: `size` distinct
 * Items, weakest (lowest mastery) first in expectation, with mastery read from the store it is
 * handed — so each Game passes its own store and none can borrow another's numbers.
 *
 * @param {VerbItem[]} items the filtered Pool
 * @param {{ size?: number, rng?: () => number, store?: unknown, today?: number }} [options]
 * @returns {VerbItem[]}
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

/* ---- progress, points and statistics (docs/design/content-and-progress.md § D, FR-10/FR-11) ---- */

/**
 * The Game's own numbers and the formulas that make them. Every entry point takes exactly one
 * thing from the outside: *this* Game's store. Nothing in the host knows the shape of an entry,
 * nothing here reaches for a host API, and `recordAttempt()` is only ever called from this Game's
 * own `onAnswer` — so "independent progress" is a fact about the data rather than a promise.
 * `verbi-presente-rivela` and `nomi-plurale` import these same helpers over their own stores, which
 * is why the two verb drills can share a corpus and still never share a number.
 *
 * The history is bounded on purpose: a store must not grow with total attempts, so there are at
 * most 90 daily buckets and at most one Tag snapshot per local week, 26 weeks deep.
 */

/** Local days of daily history kept, newest last. */
export const DAILY_BUCKETS = 90;

/** Local weeks of Tag snapshots kept, at most one snapshot per Tag per week. */
export const WEEKLY_SNAPSHOTS = 26;

/** Local days the cumulative points chart spans. */
export const POINTS_WINDOW = 30;

/** Local days one accuracy figure spans; the delta compares two of these windows. */
export const ATTEMPTS_WINDOW = 7;

/** Points: 10 for a correct answer, plus 5 for coming back to an Item after a week. */
export const POINTS_CORRECT = 10;
export const POINTS_RETURN = 5;
export const RETURN_DAYS = 7;

/** Mastered needs both a mastery floor and an attempt floor: one lucky answer is not knowledge. */
export const MASTERED_AT = 0.8;
export const MASTERED_ATTEMPTS = 3;

/** One stored per-Item entry: attempts, correct, recency-weighted accuracy, local epoch-day. */
/** @typedef {{ a: number, c: number, ema: number, last: number }} Progress */

/** One local day of attempts, correct answers and points earned. */
/** @typedef {{ d: number, a: number, c: number, p: number }} DayBucket */

/** One local week's snapshot of every Tag's Skill. */
/** @typedef {{ w: number, tags: Record<string, number> }} WeekSnapshot */

/** One statistics row: a Tag value, its Skill (mean Mastery), the percentage and its attempts. */
/** @typedef {{ tag: string, skill: number, pct: number, a: number }} TagSkill */

/** One of the weakest attempted Items, as the statistics view writes it. */
/** @typedef {{ id: string, prompt: string, mastery: number, pct: number, a: number }} WeakItem */

/**
 * The Game's own store bag, or `null` when there is none.
 *
 * A Session is allowed to carry no store (`engine.js` defaults it to `null`), and a Game must keep
 * working then: a round is still a round, it just cannot be remembered.
 *
 * @param {unknown} store
 * @returns {any}
 */
function asBag(store) {
  if (typeof store !== 'object' || store === null || Array.isArray(store)) return null;
  return store;
}

/**
 * A finite number, or `fallback`. Every read out of a stored blob goes through here, so a
 * hand-edited, truncated or pre-progress entry can never put `NaN` on screen.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * One stored per-Item entry, or `null` when the Item was never attempted. Never creates one.
 *
 * @param {unknown} store
 * @param {string} id
 * @returns {any}
 */
function entryOf(store, id) {
  const items = asBag(store)?.items;
  return asBag(asBag(items) ? items[id] : undefined);
}

/** Ascending text order, so a weakest-first tie-break is deterministic (FR-11). */
/** @param {string} left @param {string} right @returns {number} */
function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Add one attempt to today's local bucket, keeping the buckets ascending by day and dropping the
 * oldest past {@link DAILY_BUCKETS}.
 *
 * @param {any} bag
 * @param {number} today
 * @param {boolean} correct
 * @param {number} earned
 */
function addDay(bag, today, correct, earned) {
  const days = Array.isArray(bag.days) ? bag.days : (bag.days = []);
  let bucket = null;
  for (const entry of days) if (finiteOr(entry?.d, NaN) === today) bucket = entry;
  if (bucket === null) {
    bucket = { d: today, a: 0, c: 0, p: 0 };
    // Normally today's bucket is simply the last one; a day arriving out of order still lands in
    // order, because the chart walks the array and trusts it.
    let at = days.length;
    for (let index = 0; index < days.length; index += 1) {
      if (finiteOr(days[index]?.d, NaN) > today) {
        at = index;
        break;
      }
    }
    days.splice(at, 0, bucket);
  }
  bucket.a = finiteOr(bucket.a, 0) + 1;
  bucket.c = finiteOr(bucket.c, 0) + (correct ? 1 : 0);
  bucket.p = finiteOr(bucket.p, 0) + earned;
  if (days.length > DAILY_BUCKETS) days.splice(0, days.length - DAILY_BUCKETS);
}

/**
 * Refresh this local week's Tag snapshot — every Tag's current Skill, one entry per week, at most
 * {@link WEEKLY_SNAPSHOTS} weeks kept — so the history never grows per attempt (docs § D).
 *
 * @param {any} bag
 * @param {number} today
 * @param {VerbItem[]} items
 */
function addWeek(bag, today, items) {
  const week = Math.floor(today / 7);
  const snapshot = tagSkill(bag, items, today);
  const weeks = Array.isArray(bag.weeks) ? bag.weeks : (bag.weeks = []);
  let found = null;
  for (const entry of weeks) if (finiteOr(entry?.w, NaN) === week) found = entry;
  if (found === null) {
    found = { w: week, tags: {} };
    let at = weeks.length;
    for (let index = 0; index < weeks.length; index += 1) {
      if (finiteOr(weeks[index]?.w, NaN) > week) {
        at = index;
        break;
      }
    }
    weeks.splice(at, 0, found);
  }
  const tags = asBag(found.tags) ?? (found.tags = {});
  for (const [tag, skill] of Object.entries(snapshot)) tags[tag] = skill;
  if (weeks.length > WEEKLY_SNAPSHOTS) weeks.splice(0, weeks.length - WEEKLY_SNAPSHOTS);
}

/**
 * Skill per Tag: the mean Mastery of the *current-content* Items carrying that Tag, unseen Items
 * included at mastery 0 — the shape of what the player does not know yet (docs § D).
 *
 * It walks the Items, never the store, which is what keeps an Item the corpus no longer has out of
 * the view while its stored entry survives untouched.
 *
 * @param {unknown} store
 * @param {VerbItem[]} items
 * @param {number} today
 * @returns {Record<string, number>}
 */
function tagSkill(store, items, today) {
  /** @type {Record<string, number>} */
  const totals = {};
  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of items) {
    const mastery = masteryOf(store, item.id, today);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    for (const tag of tags) {
      totals[tag] = (totals[tag] ?? 0) + mastery;
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }
  /** @type {Record<string, number>} */
  const skill = {};
  for (const tag of Object.keys(totals)) skill[tag] = totals[tag] / counts[tag];
  return skill;
}

/**
 * The stored daily buckets as coerced copies, ascending by local day.
 *
 * @param {any} bag
 * @returns {DayBucket[]}
 */
function dayList(bag) {
  const stored = bag === null || !Array.isArray(bag.days) ? [] : bag.days;
  /** @type {DayBucket[]} */
  const days = [];
  for (const entry of stored) {
    const day = asBag(entry);
    if (day === null) continue;
    const d = finiteOr(day.d, NaN);
    if (!Number.isFinite(d)) continue;
    days.push({ d, a: finiteOr(day.a, 0), c: finiteOr(day.c, 0), p: finiteOr(day.p, 0) });
  }
  return days.sort((left, right) => left.d - right.d);
}

/**
 * The attempts, correct answers and points inside an inclusive local-day range.
 *
 * @param {DayBucket[]} days
 * @param {number} from
 * @param {number} to
 * @returns {{ a: number, c: number, p: number }}
 */
function sumRange(days, from, to) {
  const total = { a: 0, c: 0, p: 0 };
  for (const day of days) {
    if (day.d < from || day.d > to) continue;
    total.a += day.a;
    total.c += day.c;
    total.p += day.p;
  }
  return total;
}

/** A whole-number percentage, or `null` when there is nothing to divide by. */
/** @param {{ a: number, c: number }} bucket @returns {number | null} */
function percentOf(bucket) {
  return bucket.a > 0 ? Math.round((100 * bucket.c) / bucket.a) : null;
}

/**
 * One attempt, written into this Game's own store: the per-Item `{ a, c, ema, last }`, the point
 * total, today's local bucket and this week's Tag snapshot. Every write goes through the live store
 * object the host handed over, so it is persisted at that moment — no `save()`, no callback, no
 * host knowledge of what was written.
 *
 * The elapsed days are read from the *previous* `last`, before it is overwritten: an unseen Item —
 * or one stored before progress existed — has elapsed 0 and therefore earns no recency bonus. The
 * +5 is for coming back after a week, independent of whether the answer was right (FR-10).
 *
 * @param {unknown} store this Game's own slice; `null` is tolerated (a check may build a Session
 *   without one) and then only the points are computed.
 * @param {VerbItem} item
 * @param {boolean} correct
 * @param {{ items?: VerbItem[], now?: number }} [options] `items` is the whole current corpus, used
 *   for the weekly Tag snapshot; `now` is injectable so a check can place an attempt on a day.
 * @returns {number} the points this attempt earned
 */
export function recordAttempt(store, item, correct, options = {}) {
  const today = epochDay(finiteOr(options.now, Date.now()));
  const previous = entryOf(store, item.id);
  const elapsed = previous === null ? 0 : Math.max(0, today - finiteOr(previous.last, today));
  const earned = (correct ? POINTS_CORRECT : 0) + (elapsed >= RETURN_DAYS ? POINTS_RETURN : 0);

  const bag = asBag(store);
  if (bag === null) return earned;

  const items = asBag(bag.items) ?? (bag.items = {});
  const entry = asBag(items[item.id]) ?? (items[item.id] = { a: 0, c: 0, ema: 0, last: today });
  entry.ema = 0.25 * (correct ? 1 : 0) + 0.75 * finiteOr(entry.ema, 0);
  entry.a = finiteOr(entry.a, 0) + 1;
  entry.c = finiteOr(entry.c, 0) + (correct ? 1 : 0);
  entry.last = today;
  bag.points = finiteOr(bag.points, 0) + earned;
  addDay(bag, today, correct, earned);
  addWeek(bag, today, Array.isArray(options.items) ? options.items : [item]);
  return earned;
}

/**
 * Mastered: the Item is both well known and attempted enough that one lucky answer cannot look
 * like knowledge (docs § D). The companion to {@link masteryOf}, in the same store.
 *
 * @param {unknown} store
 * @param {string} id
 * @param {number} [today] local epoch-day, defaults to today
 * @returns {boolean}
 */
export function masteredOf(store, id, today = epochDay()) {
  const entry = entryOf(store, id);
  if (entry === null) return false;
  return finiteOr(entry.a, 0) >= MASTERED_ATTEMPTS && masteryOf(store, id, today) >= MASTERED_AT;
}

/**
 * One row per Tag value the player has actually attempted, weakest Skill first with ties broken by
 * Tag value ascending (FR-11). `a` is the attempts those Items carry — the `n=` the view shows.
 *
 * @param {unknown} store
 * @param {VerbItem[]} items
 * @param {number} today
 * @returns {TagSkill[]}
 */
function tagRows(store, items, today) {
  /** @type {Map<string, { skill: number, n: number, a: number }>} */
  const totals = new Map();
  for (const item of items) {
    const mastery = masteryOf(store, item.id, today);
    const entry = entryOf(store, item.id);
    const attempts = entry === null ? 0 : finiteOr(entry.a, 0);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    for (const tag of tags) {
      const row = totals.get(tag) ?? { skill: 0, n: 0, a: 0 };
      row.skill += mastery;
      row.n += 1;
      row.a += attempts;
      totals.set(tag, row);
    }
  }
  /** @type {TagSkill[]} */
  const rows = [];
  for (const [tag, row] of totals) {
    if (row.a < 1) continue;
    rows.push({ tag, skill: row.skill / row.n, pct: Math.round((100 * row.skill) / row.n), a: row.a });
  }
  return rows.sort((left, right) => left.skill - right.skill || compareText(left.tag, right.tag));
}

/**
 * The weakest attempted Items, three at most, text only, ties broken by Item id ascending.
 *
 * @param {unknown} store
 * @param {VerbItem[]} items
 * @param {number} today
 * @returns {WeakItem[]}
 */
function weakestItems(store, items, today) {
  /** @type {WeakItem[]} */
  const attempted = [];
  for (const item of items) {
    const entry = entryOf(store, item.id);
    if (entry === null || finiteOr(entry.a, 0) < 1) continue;
    const mastery = masteryOf(store, item.id, today);
    attempted.push({
      id: item.id,
      prompt: item.prompt,
      mastery,
      pct: Math.round(mastery * 100),
      a: finiteOr(entry.a, 0),
    });
  }
  attempted.sort((left, right) => left.mastery - right.mastery || compareText(left.id, right.id));
  return attempted.slice(0, 3);
}

/**
 * This Game's statistics: the four documented sections' numbers, computed from its own store and
 * its own current Items, with no DOM and no host involvement. `items` is the Game's whole current
 * corpus, never the filtered Pool — the views describe the Game, not the round that happened to be
 * drawn.
 *
 * Everything is a plain number or a plain array, so a cold store reads as zeros and empty lists
 * rather than as `NaN` or a crash.
 *
 * @param {unknown} store
 * @param {VerbItem[]} [items]
 * @param {number} [now]
 * @returns {{
 *   today: number,
 *   points: number,
 *   cumulative: number[],
 *   accuracy: { attempts: number, correct: number, pct: number | null, previousPct: number | null, delta: number | null },
 *   daily: number[],
 *   tags: TagSkill[],
 *   weakest: WeakItem[],
 * }}
 */
export function statsFor(store, items = [], now = Date.now()) {
  const today = epochDay(now);
  const bag = asBag(store);
  const days = dayList(bag);
  // A store written before the total existed still shows one: the daily buckets are the honest
  // fallback, and the deep history beyond 90 days only ever under-counts.
  const storedPoints = bag === null ? NaN : finiteOr(bag.points, NaN);
  const points = Number.isFinite(storedPoints) ? storedPoints : days.reduce((sum, day) => sum + day.p, 0);

  // The cumulative chart: 30 local points ending today. Days before the window are not drawn, they
  // are the level the line starts from — which is why the last point is exactly the total.
  const from = today - POINTS_WINDOW + 1;
  const windowDays = days.filter((day) => day.d >= from && day.d <= today);
  const buckets = new Map(windowDays.map((day) => [day.d, day]));
  /** @type {number[]} */
  const cumulative = [];
  let running = points - windowDays.reduce((sum, day) => sum + day.p, 0);
  for (let day = from; day <= today; day += 1) {
    const bucket = buckets.get(day);
    running += bucket === undefined ? 0 : bucket.p;
    cumulative.push(running);
  }

  const recent = sumRange(days, today - ATTEMPTS_WINDOW + 1, today);
  const previous = sumRange(days, today - 2 * ATTEMPTS_WINDOW + 1, today - ATTEMPTS_WINDOW);
  const pct = percentOf(recent);
  const previousPct = percentOf(previous);

  return {
    today,
    points,
    cumulative,
    accuracy: {
      attempts: recent.a,
      correct: recent.c,
      pct,
      previousPct,
      delta: pct === null || previousPct === null ? null : pct - previousPct,
    },
    // One accuracy point per local day *with attempts*, in day order: a day nobody practised is
    // skipped rather than plotted as a zero the player never earned (docs § D).
    daily: windowDays.filter((day) => day.a > 0).map((day) => percentOf(day) ?? 0),
    tags: tagRows(store, items, today),
    weakest: weakestItems(store, items, today),
  };
}

/** The statistics view's own copy, and the empty states the story names. */
const STATISTICS_LABEL = 'Statistics';
const SUMMARY_LABEL = 'Summary';
const POINTS_SECTION = 'Points';
const ACCURACY_SECTION = 'Accuracy';
const TAGS_SECTION = 'Skills by Tag';
const WEAKEST_SECTION = 'Weakest items';
const EMPTY_ACCURACY = 'No attempts in the last 7 days';
const EMPTY_TAGS = 'No tagged attempts yet';
const EMPTY_ITEMS = 'No attempts yet';

/**
 * The points line: the documented `0 points` for a store nobody has written to, and `pt` after
 * that (the way the round summary writes points too).
 *
 * @param {number} points
 * @returns {string}
 */
function pointsText(points) {
  return points === 0 ? '0 points' : `${points} pt`;
}

/**
 * The percentage-point delta, drawn as the design doc draws it: `▲6`, `▼3`, `·0`.
 *
 * @param {number} delta
 * @returns {string}
 */
function deltaText(delta) {
  const sign = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
  return `${sign}${Math.abs(delta)}`;
}

/**
 * The Game's statistics view: the four documented sections, built once and mutated by `refresh()`
 * (the `js/ui.js` rule — no re-mount, nothing to lose focus), reading only this Game's store. It is
 * built hidden; the round summary's own **Statistics** action shows it and its own **Summary**
 * action hides it again. It is not a route, it carries no link, and the host's back control stays
 * the only way out of the Game.
 *
 * Charts are `js/lib/charts.js` strings and therefore the one place this Game sets `innerHTML`;
 * each one is `aria-hidden` and sits next to a written summary, so no chart is ever the only carrier
 * of meaning.
 *
 * @param {Document} doc
 * @param {{ store: unknown, items?: VerbItem[], onSummary?: () => void }} options
 * @returns {{ section: HTMLElement, refresh: () => void }}
 */
export function statisticsView(doc, options) {
  const store = options.store;
  const items = Array.isArray(options.items) ? options.items : [];
  const onSummary = typeof options.onSummary === 'function' ? options.onSummary : () => {};

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

  /**
   * @param {'h1' | 'h2' | 'p' | 'span' | 'li'} tag
   * @param {string} className
   * @param {string} text
   * @returns {HTMLElement}
   */
  function line(tag, className, text) {
    const node = el(tag, className);
    node.textContent = text;
    return node;
  }

  const section = el('section', 'stats');
  section.id = 'stats';
  section.hidden = true;
  section.setAttribute('aria-labelledby', 'stats-title');
  const title = line('h1', 'title', STATISTICS_LABEL);
  title.id = 'stats-title';

  // 1 — points over time: the total, and where the total has been for the last 30 local days.
  const pointsValue = line('p', 'stat', '');
  const pointsChart = el('div', 'chart');
  const pointsNote = line('p', 'note', '');

  // 2 — accuracy: this week against the week before, and one point per day with attempts.
  const accuracyLine = el('p', 'stat');
  const accuracyValue = line('span', 'value', '');
  const accuracyDelta = line('span', 'delta', '');
  accuracyLine.append(accuracyValue, accuracyDelta);
  const accuracyChart = el('div', 'chart');
  const accuracyNote = line('p', 'note', '');

  // 3 — Skill by Tag, weakest first: a 48px row with a 6px bar, its percentage and its attempts.
  const tagRowsBox = el('div', 'stat-rows');

  // 4 — the weakest attempted Items, text only.
  const weakestList = el('ul', 'items');

  const actions = el('div', 'actions');
  const summary = el('button', 'text-btn');
  summary.type = 'button';
  summary.textContent = SUMMARY_LABEL;
  summary.addEventListener('click', () => onSummary());
  actions.append(summary);

  section.append(
    title,
    line('h2', '', POINTS_SECTION),
    pointsValue,
    pointsChart,
    pointsNote,
    line('h2', '', ACCURACY_SECTION),
    accuracyLine,
    accuracyChart,
    accuracyNote,
    line('h2', '', TAGS_SECTION),
    tagRowsBox,
    line('h2', '', WEAKEST_SECTION),
    weakestList,
    actions,
  );

  /** @param {TagSkill} entry */
  function tagRow(entry) {
    const row = el('div', 'stat-row');
    const label = line('span', 'label', entry.tag);
    const cell = el('span', 'bar-cell');
    cell.innerHTML = bars([entry.pct]);
    row.append(label, cell, line('span', 'pct', `${entry.pct}%`), line('span', 'n', `n=${entry.a}`));
    return row;
  }

  function refresh() {
    const stats = statsFor(store, items);

    pointsValue.textContent = pointsText(stats.points);
    pointsChart.innerHTML = sparkline(stats.cumulative);
    const first = stats.cumulative[0] ?? 0;
    const last = stats.cumulative[stats.cumulative.length - 1] ?? 0;
    pointsNote.textContent = `${first} → ${last} pt over the last ${POINTS_WINDOW} local days`;

    accuracyValue.textContent = stats.accuracy.pct === null ? EMPTY_ACCURACY : `${stats.accuracy.pct}%`;
    accuracyDelta.hidden = stats.accuracy.delta === null;
    accuracyDelta.textContent = stats.accuracy.delta === null ? '' : deltaText(stats.accuracy.delta);
    accuracyChart.innerHTML = sparkline(stats.daily);
    accuracyNote.textContent =
      stats.daily.length === 0
        ? `No attempts in the last ${POINTS_WINDOW} local days to chart`
        : `${stats.daily.length} day${stats.daily.length === 1 ? '' : 's'} with attempts, last ${POINTS_WINDOW} local days`;

    tagRowsBox.replaceChildren(
      ...(stats.tags.length === 0 ? [line('p', 'note', EMPTY_TAGS)] : stats.tags.map(tagRow)),
    );
    weakestList.replaceChildren(
      ...(stats.weakest.length === 0
        ? [line('li', 'note', EMPTY_ITEMS)]
        : stats.weakest.map((entry) => line('li', 'item', `${entry.prompt} · ${entry.pct}%`))),
    );
  }

  refresh();
  return { section, refresh };
}

/**
 * The Game's **Statistics** summary action and the view it opens, as one piece: all three Games
 * show the same pair, so it is built here beside the policy that fills it. `summaryActions:
 * panel.action` puts the button between Play again and Done, `bind()` ties the view to the round
 * it swaps with, and the Game appends `panel.section` to its own root — hidden until the action is
 * used, never a route, and carrying no link of its own.
 *
 * @param {{ store: unknown, items?: VerbItem[], document?: Document }} options
 * @returns {{
 *   section: HTMLElement,
 *   action: (container: HTMLElement) => void,
 *   bind: (round: HTMLElement) => void,
 * }}
 */
export function statisticsPanel(options) {
  const doc = options.document ?? activeDocument();
  /** The round this view belongs to, once the Game has built one. @type {HTMLElement | null} */
  let round = null;

  const view = statisticsView(doc, {
    store: options.store,
    items: options.items,
    onSummary: () => swap(false),
  });

  /** The round and the statistics are two views of one Game, swapping in place. @param {boolean} showStats */
  function swap(showStats) {
    if (round === null) return;
    if (showStats) view.refresh();
    round.hidden = showStats;
    view.section.hidden = !showStats;
  }

  return {
    section: view.section,
    action(container) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'text-btn';
      button.textContent = STATISTICS_LABEL;
      button.addEventListener('click', () => swap(true));
      container.append(button);
    },
    bind(roundSection) {
      round = roundSection;
    },
  };
}

/**
 * A Game's `play()` has nowhere to inject a document, so its own chrome (the summary's Statistics
 * action) and its statistics view draw with the global one — exactly the default `roundLoop()`
 * itself uses, and guaranteed present by the time either runs. `tools/sanity.mjs` installs a fake
 * with `withFakeDocument()`.
 *
 * @returns {Document}
 */
function activeDocument() {
  return /** @type {Document} */ (globalThis.document);
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
    // The statistics describe the Game, not the round: the views read the Game's whole current
    // corpus, so a filtered round still shows every Tag and every attempted Item — and an Item the
    // corpus no longer has is left out without its stored entry being deleted.
    const corpus = Array.isArray(session.content) ? /** @type {VerbItem[]} */ (session.content) : items;
    const store = session.store;
    const count = roundCount(session.settings);
    const rng = session.rng;

    /**
     * Which Item each drawn question asks. `sample()` is the only place a question is made, so this
     * can never disagree with what the loop is showing.
     * @type {WeakMap<object, VerbItem>}
     */
    const asked = new WeakMap();

    // `sample()` is the loop's only source of a queue, so Play again is always a fresh draw — and
    // mastery is read at draw time, which is what makes a weak Item come up more often.
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
      // An attempt is recorded the moment the loop judges it, and the points it earned are what
      // the summary adds up. `session.store` is this Game's slice and nobody else's.
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

export default verbiPresente;
