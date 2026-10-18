# The host owns no scoring, mastery or statistics

A **Game** is a self-contained module. The host does four things — filter the pool from the
player's settings, load the Game's content, draw the hub and the settings screen, and persist an
opaque per-Game `store` it never reads. `play(root, session)` receives five inputs (`pool`,
`content`, `settings`, `rng`, `store`) and writes exactly one. Scoring, **Mastery**, points,
streaks and every number a Game displays are local to that Game.

A shared progress model would force every Game into the shape of a multiple-choice drill: a Game
that has nothing to do with Italian would have to pretend to have "items" with "correct" answers.
The host would also end up rendering statistics it cannot interpret, and a hub that displays
numbers it does not understand breaks the first time a Game measures something else.

**Considered and rejected:** a host-side engine with `record(item, ok)`, points and mastery
formulas, per-tag aggregates, a shared progress screen fed by them, and export/import of a rich
progress blob.

**Consequences:** two Games may share one content file and keep separate numbers — which is why
recognising a form and producing it from memory never average together; adding a Game touches no
host file; there is no cross-Game total anywhere; and progress is device-local with no backup, by
decision rather than by omission.
