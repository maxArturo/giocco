# giocco

A personal, mobile-first Italian-learning PWA: a hub of mini-games that drill Italian
grammar and vocabulary. Static files on GitHub Pages, installed to an iPhone home
screen, fully functional offline with no server ever.

`AGENTS.md` indexes every document. Design notes live in `docs/design/` (architecture,
content-and-progress, ui-and-interaction) and the expensive-to-reverse decisions in `docs/adr/`.
This README records the knowledge that cannot be read off the source: the domain language, the
host/Game boundary, and the frozen decisions.

## Architecture: host and game

Two layers, and the boundary between them is the contract everything else depends on.

**The host** (engine) does exactly four things: *filter the pool from the player's
settings → load the Game's content → route and host chrome → persist a per-Game store it
never looks inside*. It never learns any Italian, never assumes a question looks like
anything, and knows **no scoring or mastery formula**. It also displays nothing about
progress: the hub is a list of what exists, and every number a Game shows about itself is
drawn and computed by that Game. During play the host draws exactly one thing: the back
control to the hub, so no Game can trap you — everything else on screen is the Game's. The
other exception is the settings screen, which the host renders from the Game's declared
`dims`, `presets` and `controls` — pool selection is the one concern that must look and
behave identically in every Game. No Game code runs there.

**A game** is one module that exports `play(root, session)`: it draws its own screen,
judges its own answers, and returns a teardown function. Question-and-answer games do
not re-implement that: they are declared with `roundLoop()`, a helper that turns
"prompt, options, grade, next" into a `play()` implementation.

Rules that keep this from rotting:

- `play(root, session)` is the **only** gameplay entry point. No `init/activate/destroy`
  phases, no hook registry, no event bus. Those make it a framework.
- Growth goes **sideways, not up**: when a second game needs the same timer, grid, or
  gesture, it becomes a plain module in `js/lib/`. It is never promoted into the host.
- The host owns **persistence, not progress**. `session.store` is a namespaced JSON blob
  the Game reads and writes freely; the host never looks inside it. Every write is
  persisted immediately, so quitting mid-round keeps whatever the Game already wrote —
  which is why a Game writes per answer rather than at the end.
- Scoring, **Mastery**, points, streaks and history are Game-local: they live in the
  Game's own `store` and are drawn on the Game's own screen. Two Games may score the same
  **Item** completely differently, and the host neither knows nor shows either number.
- The host's entire state is per-Game settings plus the opaque `store`:
  `{ v, data: { games: { <id>: { settings, store } } } }`. No points, no days, no
  aggregates, no `award()`.
- There is **no export and no import**. The blob is device-local, and a lost blob is a lost
  blob. This is deliberate, not an oversight: the only thing the hub owes the player is a
  way back to the list of Games. It accepts the iOS storage-eviction risk with open eyes.
- Games never touch `localStorage`, the service worker, settings UI, the summary
  screen, or their own quit button.
- Adding a game must not change `engine.js`, `app.js`, `sw.js`, the router, or the hub.
- A **Game**'s `id` is permanent; its `title` is the display name and the only part you
  may change freely. **Mastery** is keyed by the (Game, Item) pair, so renaming an `id`
  orphans that game's progress.

**Nothing about Italian is assumed.** The host knows points, per-day rollups, control
values, chrome, routing and offline. It does *not* know whether a **Game** has content,
**Items**, **Tags**, **Dimensions** or answers. A Game about something else entirely — no
content file, no dimensions, no items — sits in the hub like any other and still gets a
card, chrome and points. `record(item, ok)` is only meaningful for a Game that has items;
`score(delta)` always is. The acceptance test for the boundary: *a Game with no `content`,
no `dims` and no items renders a hub card and records points with zero changes to the
host.*

**Two kinds of behaviour, and the line between them.** *Which items* a round draws —
dimensions, presets, round length — is declared by the Game and rendered by the host, so
it looks and behaves the same everywhere and the pool toggles stay meaningful across
games. *How a round plays* — what a prompt looks like, whether the player picks an option
or reveals the answer and grades themselves, whether it is a canvas, its gestures — is
local code inside the Game. There is no declared interaction mode and no host-rendered
judging bar. Two interactions are two **Games**, which may point at the same content file
and appear as two hub cards. *How a round scores itself, and what counts as progress* — the
points formula, the mastery formula, which items deserve another look, in what order — is
local too: the host accumulates what a Game awards and stores what a Game writes, and
knows neither formula.

## Content: authored, never generated

Items are hand-written. No build step produces a form, and the runtime never conjugates,
pluralises, or guesses: Italian is least regular exactly where these games drill it, so
every answer ships as literal data.

`content` is just a path, so the usual layout is `content/<game>.json`, but two **Games**
may point at the same file when they ask the same question and only judge it differently
(multiple choice vs typed). There is no `corpus` concept and no `game` field on an
**Item**.

**Content fields are what a Game draws with; Tags are what the player filters by. A fact
is exactly one of the two, never both.** `prompt`, `answer` and `distractors` are content;
`reg:spelling`, `person:2s`, `cefr:a1` are metadata. The design docs violate this by
writing both `"class": "-are"` and `"class:-are"` on the same item — that duplication is
deleted.

The gate before a commit is a **structural** check — the item parses and has the shape
this game's items are declared to have. It does not judge Italian. Whether `cerchi` is
really the 2s of `cercare`, whether a distractor is plausible, and whether a `cefr` tag
is right are settled by a human review pass per corpus, never by a tool.

Two zero-dependency, dev-only gates. Nothing is built, nothing is transpiled, nothing
ships, and neither gate is in the service worker's precache.

- **`tools/check.mjs`** (`npm run check`) validates every `content/*.json` against the
  shape the owning **Game** declares in its own module (`fields`, `dims`) — the host
  never learns Italian, so the verb game is the only place that can declare "a verb item
  has a `class`".
- **`// @ts-check` + JSDoc typedefs on `js/**`**, run as `npx tsc --noEmit` (devDependency
  only), guards the *code*: a typo like `item.pural` in render code, a `record()` call
  with the wrong arity, a `play()` that forgets its teardown.

Why the split: a JSON import is inferred as a literal type, so `tsc` cannot check a
content file against a typedef without a cast — and the cast is precisely the step that
removes the check. Types guard code; `check.mjs` guards data.

**In the structural gate:** the file parses as a non-empty array of objects; every item
carries exactly the declared fields, no extras (this is what catches `distractor:` before
it silently breaks a round); non-empty strings; exactly 3 distinct distractors, none of
which is the answer (an item whose answer is also a wrong option is malformed, not a
linguistic question); `id` unique **within its file** (mastery is keyed by the (Game, Item)
pair, so two files may reuse a name, though ids stay descriptive because they are the
debugging key); every tag is
`dim:value` from the vocabulary the game declares; every selectable tag value, and every
preset, covers at least 5 items.

**Not in it:** whether the Italian is correct, whether a distractor is plausible,
whether a `cefr` tag is accurate. That is a review pass per corpus.

**What a Game declares about its own taxonomy.** All of it optional — a Game may declare
nothing at all:

- `dims: [{ dim, values, label?, valuesLabel? }]` — an allowlist of values in settings
  order; the first entry is the primary accordion. This is the only place a **Dimension**
  exists, so a typo like `tens:pres` fails the build instead of creating a phantom settings
  section with one item. `label` names the dimension for the player, and a value gets a
  label only where the raw value isn't already readable (`['pres', 'Presente']`); the host
  renders whatever it is handed, so no per-Game UI code exists.
- **Declare only what ships.** Listing `tense` values for the past tense while shipping no
  past-tense items produces a permanently disabled toggle and a settings screen
  advertising content that doesn't exist. The ≥5 rule enforces the promise the day those
  items arrive.
- `presets: [{ id, label, include: { dim: [value] } }]` — named **Pools**, because the
  learner's progression is a curriculum, not a checkbox state.

**Vocabulary rules for the Italian games** (v0.1): one CEFR axis, `cefr` — the docs' `freq`
is deleted, because "level" now means a **Preset**, and `frequency_rank` does not ship at all:
frequency lists only decide which words are worth authoring; `reg` is `regular`, `spelling`, `irregular` — the docs' `irregular-stem` /
`irregular-all` split is a distinction no player toggles; `aux` is deleted because
auxiliary choice only exists in compound tenses and `tense:pres` has none.

## v0.1 inventory

Three **Games**, all built on `roundLoop()`:

| Game (`id`) | Content | Interaction |
|---|---|---|
| `verbi-presente` | `content/verbi-presente.json` — ~20 verbs × 6 persons | pick 1 of 4 |
| `verbi-presente-rivela` | the same file | produce the form, reveal, self-grade |
| `nomi-plurale` | `content/nomi-plurale.json` — ~60 nouns | pick 1 of 4 |

The second and third exist partly as the boundary's proof: adding a **Game** must change no
host file. The corpus must satisfy the ≥5 rule per selectable value *and per preset* (the
binding one is `reg:irregular` ∩ `cefr:a1` ∩ `tense:pres`), and the nouns are chosen so that
every declared `plural` pattern has five. Only `cefr` values that will actually be authored
are declared — a declared-but-empty value is a permanently disabled toggle.

## Routes and persistent state (frozen)

Three host routes:

- `#/` — the hub: the list of Games. Nothing else on it.
- `#/g/<id>` — the Game. This root node is what `play(root, session)` receives. A Game's own
  statistics or options screens, if it has any, live *inside* this route; the host never learns
  sub-routes.
- `#/g/<id>/settings` — pool selection, host-rendered from the Game's `dims`, `presets` and
  `controls`.

Hash routing is not optional (GitHub Pages has no rewrites, so a fragment never 404s on
reload) and it also means routes have no bearing on the service worker's scope — `#/g/x` can be
renamed any day. What *is* frozen: the deploy subpath (`/giocco/`), `sw.js` at the root of it,
every URL relative (`./js/app.js`, never `/giocco/js/app.js`), and `.nojekyll`. Change any of
those and the installed app is a different app: new scope, new cache, re-install.

All persistent state:

```js
localStorage['giocco'] = { v: 1, data: { games: { '<id>': { settings, store } } } }
```

`settings` is the host's (which pool the player chose); `store` is the Game's, opaque to the
host and persisted on every write; `v` drives a `migrate(v, data)` chain with one entry point.

## Language

**Game** (mini-game):
One module exporting `play()` — one self-contained way to practise something. One Game is
exactly one hub entry and exactly one `store` slice.
_Avoid_: app, mode, activity, exercise, card

**Item**:
One exercise record in a content file: a prompt, its answer, its tags.
_Avoid_: exercise, question, card

**Dimension**:
One selectable filtering axis a **Game** declares for itself (`tense`, `reg`) — an
allowlist of values, in settings order, with optional player-facing labels. A Game may
declare none, in which case its settings screen has no toggles. There is no global
vocabulary.
_Avoid_: tag group, category, facet, filter

**Tag**:
One `dim:value` string on an **Item** — the unit the **Pool** filter matches and **Skill**
is aggregated over. Tags are written literally and are never derived from other fields.
_Avoid_: label, keyword, attribute, flag

**Preset**:
A named **Pool** a player picks in one tap, standing for a point in their progression
("A1 basics", "+ irregular"). This is what the learner calls a "level".
_Avoid_: level, mode, profile, filter

**Round**:
One play session of a game — a queue drawn from the pool, played to the end or stopped.
_Avoid_: set, level, session

**Pool**:
The set of items eligible for a round, after the player's settings are applied.
_Avoid_: deck, selection, corpus

**Session**:
The object the host hands to `play()` — pool, content, settings, rng, store. Five
read/write inputs and nothing else: no callbacks, no reporting, no lifecycle.
_Avoid_: context, state, env

**Host** (engine):
The layer that filters pools, loads content, hosts chrome, and records outcomes.
_Avoid_: core, framework, runtime, shell

**Loop** (round loop):
The question cycle inside a round — ask, judge, feed back, advance — provided by
`roundLoop()` for games that want it. A game may bypass it with its own `play()`.
_Avoid_: drill, flow, sequence, question loop; bare `loop()` (that means a frame loop)

**Mastery**:
Whichever number a **Game** uses to say how well the player knows one of its **Items** — a
decayed, recency-weighted accuracy in the Italian games. The host never computes it. The
same **Item** has a separate **Mastery** in each **Game** that includes it, so recognising
a form and producing it from scratch never contaminate each other's numbers.
_Avoid_: proficiency, score, strength

**Skill**:
A per-tag aggregate of mastery across the items carrying that tag. What the progress
screen shows as a percentage and a bar.
_Avoid_: rating, level, rank, ability

## Relationships

- A **Game** declares zero or more **Dimensions**, and may point its `content` at another **Game**'s file
- A **Game** plays zero or more **Rounds**, each drawn from one **Pool**
- A **Tag** always belongs to exactly one **Dimension**; a **Preset** selects **Tags**
- A **Round** plays one or more **Items**; the same **Item** may belong to several **Games**
- A **Pool** is a filtered subset of the **Items** in one content file
- A **Session** exposes exactly one **Pool** to one **Game** for one **Round**
- An **Item** has one **Mastery** per **Game** that includes it
- A **Tag**'s **Skill**, and a Game card's percentage, are derived by the **Game** from its own stored counters; the host computes neither
- A **Loop** turns a **Round** into a sequence of **Items**; a **Game** may ignore it

## Example dialogue

> **Dev:** "The player quits the round after three items — do we drop the answers?"
> **Maintainer:** "No. The Game writes to its own store on every answer, so the three items
> keep their mastery and the day keeps its points. We only skip the summary, because there
> is no round left to summarise."
>
> **Dev:** "And if a game wants a board instead of a prompt?"
> **Maintainer:** "Then it's a **Game** with its own `play()` and no **Loop**. It still gets
> the filtered **Pool**, the host chrome and `record()` — that's the whole point of the
> boundary."

## Flagged ambiguities

- **"loop" means two things.** Resolved: the helper is `roundLoop()`, and it only ever
  means the question cycle inside a round. Bare `loop()` means a frame tick
  (`requestAnimationFrame`) and is never a name for the round loop.
- **"exercise" was used for both the item and the round.** Resolved: an **Item** is one
  record; a **Round** is a queue of them. Copy that says "34 esercizi" on a hub card is
  counting **Items**.
- **"skill" was used for both per-item and per-tag numbers.** Resolved: **Mastery** is
  per item, **Skill** is per tag. Hub-card percentages are **Skill**.
- **"session" means two different things.** Resolved: in this project a **Session** is
  the object handed to `play()`; a pi/agent conversation is never called a session here.
- **"level" meant two different things.** Resolved: the learner's progression is a
  **Preset**; CEFR bands are the `cefr` **Dimension**. `level` is no longer a term here.
- **"corpus" is not a concept.** Resolved: there is a content *file* and a **Pool**. No
  object in the system is called a corpus.
- **"card" is not a unit of scope.** Resolved: a card is the hub's rendering of one
  **Game**; one Game is one hub entry, one `play()` and one `store` slice. Scope is always
  counted in Games.
- **"kind" / "mode" are not terms.** Resolved: a **Game** fixes its own interaction in its
  own code. There is no declared judging mode — `kind` on an **Item** and `mode` on a
  **Game** are both deleted, and the self-grade bar belongs to `roundLoop()`, not the host.

## Open

- **Chrome copy language.** The UI sketches assume English chrome with Italian exercise content;
  the earlier drafts mixed the two (Italian card titles and `corretto` beside `I was right`).
- **Deep-linking a single-Tag drill** from a Game's statistics view into its own settings. It
  needs either a hash query on `#/g/<id>/settings` or a way for a Game to write the host's
  `settings`. v0.1 can ship without it.
