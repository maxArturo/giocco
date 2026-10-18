# giocco — Mobile Interaction & Visual Design

Read `README.md` for the language and `architecture.md` for the host. The host draws exactly two
surfaces: the **hub** and the **settings screen**. Everything else in this file is what a **Game**
draws — including §B, which is the contract of `roundLoop()`, a library a Game opts into and not
something the host enforces.

Type is in `rem` so iOS Dynamic Type scales it; touch targets are in `px`. Theme follows the
system via CSS variables, one accent, no hover, no animation beyond colour and opacity, no timers.

## (A) The hub — a list of Games

The hub shows what exists. Nothing else: no percentages, no counts, no streak, no lifetime points,
no "Continue" button, no search, no carousel, no grid.

```
┌────────────────────────────────────┐
│ Verbi · presente                   │   title 22px
│ Coniugazioni al presente           │   description 15px muted
└────────────────────────────────────┘
```

- The **whole card** is the tap target (minimum 64px tall), because playing is the only thing a
  player does here. There is no separate play button.
- Order is registry order. Past roughly six Games, a Game's optional `section` gives plain
  headings ("Grammar", "Vocabulary") and the list grows downward in one column.
- The wordmark sits above the list; it is not a link and displays no data.
- A Game that shows no statistics ever and a Game that charts every tag look identical here. That
  is the point: a Game brings its own everything.

## (B) The round loop — `roundLoop()`'s contract

Binding for any Game that uses `roundLoop()`. A Game with its own `play()` — a board, a canvas,
anything spatial — may ignore all of it, and the host neither knows nor cares which happened.

`queue` is the Item list the Game built, `i` the cursor. The DOM is built **once** and mutated per
question: `textContent` and `data-state` only, never `innerHTML` re-rendering, never a re-mount.
Nothing scrolls: the layout is `height: 100dvh; overflow: hidden`.

| State | Screen | Exit |
|---|---|---|
| `ask` | Prompt plus the Game's own controls: four option buttons for a choice Game, one full-width **Show answer** for a reveal Game | tap → record → `feedback` (choice) / `selfGrade` (reveal) |
| `feedback` | Chosen option marked green, or red with a strike-through; **the correct one is always revealed in green**. Status line: "corretto" / "giusto: cerchi" | 700 ms correct · 1400 ms wrong · or a tap after a 250 ms guard → `advance` |
| `selfGrade` | Answer revealed in green, options replaced by **I was right / I was wrong** | tap → record → 250 ms confirm → `advance` |
| `advance` | Meter and `3/10` update; prompt and option labels rewritten in place | `i < n` → `ask`, else `summary` |
| `summary` | `8/10`, `+80 pt`, up to three misses, **Play again** / **Done** | new queue → `ask`, or back to the hub |
| `exit` | The host's back control, always present, in every state | → hub. Answers already given stay recorded; no confirm dialog, no penalty |

The two interactions are **two Games** sharing one content file, never a mode inside one: a Game
that offers four options and a Game that asks you to produce the form are different drills, and
their **Mastery** must not be averaged together. Both use the same container, nodes and timings.

Reveal-Game differences: no distractors, no auto-advance (grading is deliberate), nothing is ever
coloured red, and the action bar exists only in `selfGrade`.

Two details worth keeping: the prompt block reserves `min-height: 2.4em` so a one-line and a
two-line prompt never reflow the card under the player's thumb, and `.options` reserves four rows
so a short round (three options, or two after a thin pool) does not shift the buttons mid-tap.

### Markup and CSS

```html
<section id="round" data-state="ask" aria-labelledby="prompt">
  <header class="bar">
    <div class="meter"><i style="width:30%"></i></div><span>3/10</span>
  </header>
  <h1 id="prompt" tabindex="-1">cercare · tu · presente</h1>
  <p id="status" class="status" aria-live="polite"></p>
  <div class="options" role="group" aria-labelledby="prompt">
    <button class="opt">cerchi</button><button class="opt">cerci</button>
    <button class="opt">cercai</button><button class="opt">cerca</button>
  </div>
  <div class="actions" id="actions" hidden></div>
</section>
```

```css
:root{--bg:#0f1216;--card:#1a2029;--fg:#eef2f6;--muted:#94a3b8;--ok:#22c55e;--bad:#ef4444;--accent:#3b82f6}
@media(prefers-color-scheme:light){:root{--bg:#f7f8fa;--card:#fff;--fg:#12161c;--muted:#5b6676}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:1.0625rem/1.4 -apple-system,system-ui,sans-serif;
  overscroll-behavior:none}
#round{height:100dvh;display:flex;flex-direction:column;gap:12px;
  padding:calc(8px + env(safe-area-inset-top)) 16px calc(12px + env(safe-area-inset-bottom))}
.bar{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.875rem}
.meter{flex:1;height:4px;border-radius:2px;background:#ffffff1f;overflow:hidden}
.meter i{display:block;height:100%;background:var(--accent)}
#prompt{margin:0;font-size:1.75rem;line-height:1.2;min-height:2.4em}
.status{margin:0;min-height:1.4em;font-size:.9375rem;color:var(--muted)}
[data-state="ask"] .status{visibility:hidden}
.options{margin-top:auto;display:grid;gap:8px;min-height:calc(4 * 56px + 3 * 8px)}
.opt{min-height:56px;font:inherit;font-size:1.1875rem;border:1px solid #33415a;border-radius:14px;
  background:var(--card);color:var(--fg);touch-action:manipulation;user-select:none;
  -webkit-tap-highlight-color:transparent;transition:none}
.opt:active{opacity:.85}
[data-state]:not([data-state="ask"]) .options{pointer-events:none}
[data-state]:not([data-state="ask"]) .opt{opacity:.55}
.opt.correct{opacity:1;border-color:var(--ok);background:#12291b}
.opt.wrong{opacity:1;border-color:var(--bad);background:#2a1416;text-decoration:line-through}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grade{min-height:52px;font:600 1.0625rem system-ui;border:1px solid;border-radius:14px;
  background:transparent;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.grade.ok{border-color:var(--ok);color:var(--ok)}
.grade.bad{border-color:var(--bad);color:var(--bad)}
.grade:active{background:#ffffff14}
```

## (C) The settings screen — the host's one game-specific surface

Host-rendered from the Game's declaration, because pool selection is the one thing that must look
and behave identically in every Game. No Game code runs here.

Top to bottom: **Preset chips** → one accordion per **Dimension**, in declared order → control rows
→ sticky footer with the eligible count and **Start**.

- The **first declared Dimension** is the primary accordion and the only one expanded by default,
  so a Game with six dimensions still opens looking like three lines. Header is 56px: name, a
  "2 of 4" summary, a chevron. `All` / `None` text buttons per section.
- Rows are 48px: label, an item-count badge, a switch on the right. A value whose Item count
  resolves below five renders at 40% opacity with `aria-disabled` and a "needs 5+ items"
  sub-line — the same rule `check.mjs` enforces, surfaced instead of hidden.
- **Counts are recomputed for the whole form on every change** and show how many Items are
  reachable *if this were on, given everything else currently selected*. At a few hundred Items
  and ten dimensions this is instant.
- **Presets** are 40px chips rendered from the Game's declarations ("A1 · regolari", "Tutto
  verificato"). Tapping one writes its `include`; any manual change afterwards flips the chip row
  to "Custom". Presets are the answer to too many toggles, not more toggles.
- **Controls** are chip rows too — round length (5 / 10 / 20) is one. A Game declares them; the
  host renders and persists them. Nothing here is free text.
- The footer is sticky and safe-area padded: "34 eligible items" and a 52px **Start round**. When
  the pool is empty, Start is disabled and the line says so: "no items match these filters".

Deliberately absent: an ordering/spaced-repetition option, an `onlyUnmastered` switch, per-tag
difficulty, item-id allowlists, free text, export/import. Each is either YAGNI or game-local, and
the docs' earlier mentions of them are superseded.

## (D) A Game's statistics view — optional, and the Game's own

There is no shared progress screen and no host route for one. A Game that wants to show progress
renders it inside its own `#/g/<id>`, with its own layout, reading its own `store`. Guidance, not
a contract:

1. **Points over time** — the Game's own total with a 30-day cumulative `sparkline()` (a total
   only rises, so the curve reads as progress rather than noise).
2. **Accuracy** — `Σc / Σa` over the last seven days with a delta against the previous seven
   ("78% · ▲6"), and a daily sparkline that **skips days with no attempts** instead of plotting
   zero.
3. **Skill by Tag**, weakest first: one 48px row per Tag value with a 6px bar, its percentage, and
   `n=12`. This is the payoff of the whole screen — the player sees the shape of what they don't
   know. Only values with `a >= 1`.
4. **Weakest Items**, top three, text only.

Formulas are in `content-and-progress.md` §D — they are the Game's, and the host knows none of
them. Charts come from `js/lib/charts.js`:

```js
export function sparkline(vals, { w = 300, h = 56 } = {}) {
  if (vals.length < 2) return "";
  const lo = Math.min(...vals), span = (Math.max(...vals) - lo) || 1;
  const x = i => (i / (vals.length - 1) * w).toFixed(1);
  const y = v => (h - 2 - (v - lo) / span * (h - 4)).toFixed(1);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark" aria-hidden="true">
    <polyline fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"
      stroke-linejoin="round" points="${pts}"/></svg>`;
}
// .spark{display:block;width:100%;height:56px;color:var(--accent)}
```

Every chart is `aria-hidden` with an adjacent text summary, never the sole carrier of meaning.

**Open:** whether a stats row can deep-link into this Game's settings pre-filtered to that single
Tag ("drill this"). It needs either a hash query on `#/g/<id>/settings` or a way for a Game to
write the host's `settings`; both are unresolved, and v0.1 can ship without it.

## (E) Touch and accessibility rules (binding)

- **Targets**: options 56px, self-grade 52px, icon buttons 44×44, chips 40px, gaps ≥ 8px. Nothing
  tappable in the top 60px of a round except the host's back control.
- **One-handed**: every primary action lives in the bottom 40%; the prompt is at the top and never
  scrolls away.
- **Viewport**: `viewport-fit=cover`; `100dvh`, never `100vh`; padding via
  `env(safe-area-inset-*)`; fixed bars pad with `calc(12px + env(safe-area-inset-bottom))`.
- **Touch**: `touch-action: manipulation` on everything tappable (no double-tap zoom, no 300 ms
  delay); `:active` for press states; any `:hover` rule inside `@media (hover: hover)`; no
  gesture-only action, no swipe-to-skip.
- **Focus and scroll**: the round cannot scroll, and nodes are reused, so focus is never lost. On
  each `ask`, call `prompt.focus({ preventScroll: true })` (`h1` is `tabindex="-1"`) so
  VoiceOver announces the new question. Never call `scrollIntoView`. Feedback goes through the
  `aria-live="polite"` status line; answer buttons stay `<button>` inside `role="group"` with
  stable order, so a mis-tap never lands on a different option mid-round.
- **Type**: 16px minimum anywhere focusable, 19px for options, all in `rem`; the layout tolerates
  200% text because options grow and the prompt block has reserved height.

## (F) Deliberate omissions for v0.1

No timer, lives, leaderboard, daily goal, streak-freeze, notification or reminder. No audio, no
haptics, no confetti, no transitions beyond colour and opacity. No onboarding carousel, theme
picker, font-size setting, settings search, or per-Game reset. No light/dark toggle (system only).
No shared progress screen, no statistics on the hub, no export/import screen, no accounts. No
item-level drilling, no editing or undoing a grade, no "review my mistakes" round. No ordering,
spaced-repetition or `onlyUnmastered` UI.

**Chrome copy language is unresolved** (see `README.md` § Open): the earlier drafts mixed English
chrome ("I was right", "Start round") with Italian card titles and status lines ("corretto"). The
working assumption in these sketches is English chrome, Italian exercise content.
