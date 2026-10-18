# giocco — Content Model, Authoring & Progress

Read `README.md` first: it owns the domain language (Game, Item, Tag, Dimension, Preset,
Mastery, Skill) and the host/Game boundary. `architecture.md` owns how the host loads and
filters content. This file covers what an **Item** is, how one gets authored, and how the
Italian **Games** keep score — which the host knows nothing about.

## (A) Item shape, Tags and the vocabulary

An **Item** carries exactly two kinds of thing: what the **Game** draws with, and what the
player filters by. **A fact is one or the other, never both.**

```json
{
  "id": "verbi-pres-cercare-2s",
  "prompt": "cercare · tu · presente",
  "answer": "cerchi",
  "distractors": ["cerci", "cercai", "cerca"],
  "tags": ["mood:ind", "tense:pres", "class:-are", "reg:spelling", "person:2s", "refl:no", "cefr:a1"]
}
```

```json
{
  "id": "nomi-pl-amico",
  "prompt": "l'amico → gli ___",
  "answer": "amici",
  "distractors": ["amichi", "amiche", "amico"],
  "tags": ["gender:m", "plural:-co/-ci", "irreg:plural", "cefr:a1"]
}
```

- `id` is an opaque key: unique within its file, permanent once shipped, never parsed. It reads
  like a description because that is useful in a storage dump, but nothing is derived from it.
- `prompt`, `answer`, `distractors` are the Game's business to draw.
- `tags` are `dim:value` strings, written literally. They are never derived from other fields,
  and a value never appears twice on an Item (no `class` field beside `class:-are`).
- Nothing that is not drawn or filtered belongs here. Frequency rank, glosses and notes are
  authoring aids: they live in the author's scratch list, not in the shipped Item.

### Vocabulary, v0.1

| Game | Dimension | Values | Notes |
|---|---|---|---|
| `verbi-presente`, `verbi-presente-rivela` | `mood` | `ind` | |
| | `tense` | `pres` | the past tense arrives with its five Items |
| | `class` | `-are`, `-ere`, `-ire`, `-isc` | |
| | `reg` | `regular`, `spelling`, `irregular` | three values, not four |
| | `person` | `1s` … `3p` | |
| | `refl` | `yes`, `no` | deliberately imbalanced ~1:20 |
| | `cefr` | `a1` (+`a2` when authored) | |
| `nomi-plurale` | `gender` | `m`, `f`, `m/f` | |
| | `plural` | only the patterns with five nouns | |
| | `irreg` | `none`, `plural`, `gender-change` | |
| | `cefr` | `a1` (+`a2` when authored) | |

Rules that keep the table honest:

- **Declare only what ships.** A declared value with no Items is a permanently disabled toggle
  and a settings screen advertising content that does not exist. The ≥5 rule then enforces the
  promise on the day the Items arrive.
- **≥5 Items per value, and per Preset.** A Preset is a *combination*, and combinations are where
  a pool collapses: `reg:irregular` ∩ `cefr:a1` ∩ `tense:pres` needs five Items of its own.
- **Only one CEFR axis.** The earlier design carried `freq` (`a1/a2/b1`) *and* `level`
  (`a1…b2`) — the same axis twice, doubling the ≥5 obligation. `cefr` is the survivor, and the
  word "level" now means a **Preset** in conversation.
- **`reg` has three values.** `irregular-stem` vs `irregular-all` is a distinction no player
  toggles and one you would have to get right 120 times.
- **`aux` does not exist here.** Auxiliary choice only shows up in compound tenses and
  `tense:pres` has none; it returns as a Dimension when `pass-pross` Items exist.
- **`frequency_rank` is not shipped.** Frequency lists are used to choose which words are worth
  authoring (see §C) and then dropped; an Item carries only tags the player can filter on.

Two **Games** may point at one content file (`verbi-presente` and `verbi-presente-rivela` do).
Such Games must declare compatible `dims`: the file is one file, and the structural gate
validates it against each Game's declaration separately.

## (B) Authoring workflow and the gates

**Verdict: Items are hand-authored. Nothing generates a form, at build time or at runtime.**
Italian is least regular exactly where these Games drill it, so `cerchi`, `amici` and
`uovo → uova` ship as literal data. The earlier design proposed a lexeme file, a rule table, a
generator and a cross-check of every generated form against a Wiktionary extract; that is a
compiler for a corpus of 180 strings, and its failure mode — a rule that guesses wrong — is
invisible. Hand-authoring makes correctness true by construction, and the gates below catch the
mistakes hands actually make.

### The structural gate — `tools/check.mjs` (dev-only, never shipped)

Fails the commit on:

1. A file that does not parse as a non-empty array of objects.
2. An Item carrying a field the Game did not declare, or missing a required one — this is what
   catches `distractor:` before it silently breaks a round.
3. Wrong types: non-empty strings; `distractors` exactly three non-empty strings; `tags` an
   array of `dim:value`.
4. A duplicated `id` within the file.
5. A tag whose dimension or value is not in the Game's declared vocabulary, or an Item missing a
   declared dimension.
6. A `distractors` array containing the answer, or a duplicate. An Item whose answer is also
   offered as wrong is malformed, not a linguistic question.
7. Any selectable value or **Preset** covering fewer than five Items.

It does **not** judge Italian: whether `cerchi` is really the 2s of `cercare`, whether
`cerci/cercai/cerca` are plausible, and whether a `cefr` value is fair are not machine questions.

### The type gate — `npx tsc --noEmit` with `// @ts-check` (dev-only, devDependency only)

Guards the *code* around the data: `item.pural` in render code, a `play()` that forgets its
teardown, a Game that reads a `session` field that does not exist. It cannot guard the JSON
itself — a JSON import is inferred as a literal type, so checking it against a typedef needs a
cast, and the cast is the step that removes the check. Types guard code; `check.mjs` guards data.

### The human review pass

Per Game, before trusting it: read the shipped corpus end to end. Answer correctness, distractor
plausibility, tag accuracy, CEFR assignment. A separate agent or a careful hour does this; no tool
will.

### Distractors, specifically

They are authored, never sampled at runtime. For a conjugation Item the natural set is the same
verb's other persons (`cerco`, `cerca`, `cercano`) — always plausible, never accidentally the
answer — plus, where a spelling rule is the point, one wrong-stem form (`cerci`). Sampling
distractors from a twenty-verb corpus would produce `andare / molto / ieri` and teach nothing.
Rule to hold to: a distractor must never equal the answer of another Item sharing this prompt.

### Adding content

1. Append Items to `content/<game>.json`.
2. If a new tag value is involved, add it to the Game's `dims` in the same commit — and only if
   five Items now carry it.
3. `npm run check`.
4. Deploy. `content/*.json` is refreshed by the service worker on the next online load, and the
   Game marks nothing else.

## (C) Sourcing and corpus size

Sources: frequency lists (OPUS OpenSubtitles, `hermitdave/FrequencyWords`) are used **only to rank
which words are worth authoring**; CEFR is assigned by hand; the forms come from the author's own
knowledge and are reviewed in the pass above. No dictionary extract is vendored, so there is no
third-party attribution obligation in `content/`.

v0.1 targets:

- **Verbs: 20 lexemes × 6 persons = 120 Items**, chosen to satisfy the ≥5 rule: at least five
  verbs in every `class`, at least five `refl:yes`, at least five `reg:irregular`, and five
  Items inside every **Preset** you intend to ship.
- **Nouns: ~60 Items**, *chosen* so that every declared `plural` pattern has five nouns. The
  taxonomy follows the words you can name, not the other way round: `-cia/-cie` and `-gia/-gie`
  are rare, so they arrive with their nouns or not at all.
- **`cefr`: `a1` only** until `a2` Items exist. Declaring `b1`/`b2` now would be dead toggles.

House rules worth keeping from the earlier analysis, because they are the failure modes of a
hand-written corpus: `-co/-go` is not one rule (`albergo → alberghi`, `amico → amici`); `-cia/-gia`
keeps the `i` when stressed (`camicia → camicie`) and drops it when not (`arancia → arance`);
`bacio → baci` but stressed `zio → zii`; invariants `città, re, caffè, film, bar`; gender-changing
plurals `uovo → uova`, `braccio → braccia`, `dito → dita`; verb spelling `-care/-gare` +h
(`cerchi`), `-ciare/-giare` drop the i (`cominci`), `-isc` (`capisco` but `dormo`).

## (D) The Italian Games' own progress model

**None of this reaches the host.** The host persists a per-Game `store` it never reads; these are
the formulas the Italian Games write into theirs, kept here because they are the design intent for
learning, not because anything enforces them.

Per-Item counters, keyed by the Item's `id` inside the Game's `store`:

```js
{ a: 5, c: 4, ema: 0.78, last: 19700 }   // attempts, correct, recency-weighted accuracy, local epoch-day
```

- **Per attempt:** `ema ← 0.25 * outcome + 0.75 * ema` (α = 0.25 ≈ the last seven attempts).
- **Mastery** (0..1, decayed): `ema * 0.5 ** (daysSince(last) / 14)` — an Item you stopped
  practising fades instead of sitting at its best-ever score.
- **Points:** 10 per correct, +5 when `daysSince(last) >= 7`. Points are the Game's own number;
  there is no global total anywhere in the app.
- **Mastered:** `mastery >= 0.8 && a >= 3`. The attempt floor is what stops one lucky answer
  looking like knowledge.
- **Skill** (per Tag): the mean **Mastery** of the Items carrying that tag; what a stats view shows
  as a bar. A Game's headline percentage is the mean Mastery of its own Items.

**Ordering** is the Game's decision, expressed as a weight it passes to `roundLoop()`:

- `random` — uniform, pure drilling.
- `weighted` — `weight = (1 - mastery) + 0.2`, so weak Items come up more often. **The default**,
  and the reason the host does not need an `ordering` setting.
- `srs` — due-first with `interval = [0, 1, 3, 7, 16, 35]` days. Deferred: it needs data nobody
  has in week one, and it is additive when it arrives.

Bounded history, if a Game charts itself: keep the last **90 daily buckets** and at most **one
snapshot per tag per week, capped at 26**. Growth stays independent of total attempts. Charts use
`sparkline()` and `bars()` from `js/lib/charts.js` — inline SVG, no dependency, drawn inside the
Game's own view.

Pool semantics (dimension OR, AND across dimensions, presets) are the host's and are specified in
`architecture.md`.

## (E) Risks

1. **Empty toggles.** A dimension value or Preset below five Items makes the settings screen lie.
   Mitigated by gate rules 5 and 7, and by declaring only shipped values.
2. **Noisy Mastery.** Few attempts make a number that means nothing. Mitigated by the `a >= 3`
   floor; the rest is patience.
3. **Authoring drift as the corpus grows.** The structural gate catches typos and structural
   errors, not wrong Italian; only the review pass catches that. The moment this stops scaling —
   roughly past 500 Items, or when a second Game needs the same lemma asked differently — is the
   moment to reconsider a generator, deliberately and with the verification the earlier design
   proposed. Not before.
4. **No backup.** Progress is device-local by decision; iOS eviction loses it. Accepted, and not
   mitigated anywhere in v0.1.
5. **Two Games sharing a file.** They must declare compatible tags, or the file fails one Game's
   gate. Cheap to detect, easy to forget.
6. **CEFR assignment is a judgement**, unverified by anything. It is a filter for the player, not
   a claim about the language.
7. **Distractors can be accidentally correct** in ways the structural rule cannot see — a wrong
   form that happens to be right for a different reading. Only the review pass sees it.
