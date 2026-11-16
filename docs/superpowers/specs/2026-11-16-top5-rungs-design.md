# Top-5 shrinking rungs (looser accept rule)

## Context
Two playtesters said the game feels like "guess the designer's exact word" (tail → fuselage).
The cause is the one-rung-closer rule (`upOneRung`, js/logic.js:859). Today's medium
(tail → sculptor) accepts 4 / 2 / 2 / 1 / 1 words per rung. Hard has four rungs in a row where
only one word is accepted. The user chose a looser rule with shrinking strictness.

## Decided with the user
- **Accepted set per rung.** Look at the current word's legal steps (the same top-10 two-way
  lists) and drop any word that is farther from the goal. Sort what's left by distance to the
  goal, then by its order in the current word's list. Keep the first `K = min(5, dist[current])`.
  That gives 5, 4, 3, 2, and then only the goal.
- **Closer word** in the set: climbs a rung. This is the same as today.
- **Same-distance word** in the set ("fins" after "tail"): accepted, costs a move, and the stair
  stays level. The stair rises again on the next closer word.
- **Anything else** (farther, or outside the K): goes to the Tried list and costs no move. This
  is the same as today.
- **Same rule for every day**, past and future. Par is unchanged, because the graph and BFS are
  untouched.
- **Old saves:** wipe all saved games, practice saves and results. Preferences (`seenHelp`,
  `schema`) are kept.
- **Not doing:** ConceptNet meaning links and letter counts.

Measured preview (medium, 2026-11-16):
`tail(5): fuselage, elongated, peacock, markings, fins(=)`,
`fuselage(4): fiberglass, plywood, cockpit(=), fitted(=)`, `plywood(3)`, `wood(2): carver, carpenter(=)`, `carver(1): sculptor`.

## Changes
1. **js/logic.js**
   - Replace `upOneRung` with `acceptedSteps(neighbors, dist, cur, cap = 5)`. It returns the
     accepted word indexes in order, or `[]` when `dist[cur] <= 0`.
   - Delete `trimToStepsUp`. The wipe makes it dead code.
   - Reuse the existing `squareFor`: it already gives 🟨 for a same-distance step.
   - Reuse the existing `ladderRows`: it already puts a word on the rung for its distance, so
     "fins" shows on tail's rung and the full path stays in the trail.
2. **js/game.js**
   - In `submit()` (~line 745), swap `upOneRung(...)` for
     `acceptedSteps(...).includes(idx)`.
   - Drop the `trimToStepsUp` call (line 644) and its import.
   - Update the Tried chip text in `triedChip` (line 885) to
     `Close to X, but not one of its N best steps toward GOAL`.
   - Change the Tried heading (line 900) to "Not accepted:".
   - Change the same-rung step message (line 931) to `Same distance. ${b} to go.`
   - Update the How-to-play text (~line 149) to explain the rule: up to 5 answers per rung,
     fewer near the goal, and same-distance words cost a move.
   - `autoGoal` still works, because at distance 1 the goal is the only accepted word.
3. **js/data.js** `migrateStorage`
   - Add `schema < 5`: remove every `game:*` and `practice:*` key and `results`, then set
     `schema` to 5. Copy the style of `wipeChainLadders`.
4. **tests/js/logic.test.mjs**
   - Replace the `upOneRung` and `trimToStepsUp` tests (~line 617) with `acceptedSteps` tests.
     Cover: K shrinks with distance; farther words are excluded; closer words come before
     same-distance words; a rung with fewer than K non-farther words returns what exists;
     distance 1 returns only the goal; distance 0 or -1 returns `[]`.
   - Add a migration test if data.js tests exist. If none exist, check it by hand.
5. **Docs:** update the README rules line and "FOR Guillaume.md" with a short note. Also save
   this plan to `docs/superpowers/specs/2026-11-16-top5-rungs-design.md`.

The Python generator needs no change. The puzzle pick (par, `minCloserFirstMoves`) still
uses graph distance.

## Verification
- `make check PY=python`, which runs the JS tests, the syntax test and pytest.
- Local server: `python -m http.server 8765`. Play today's medium:
  - "fins" at tail is accepted, stays level and gives a 🟨 square.
  - "otter" at tail goes to Tried.
  - At wood, only carver and carpenter are accepted.
  - The medal is silver with one extra move.
- Load with an old save present: all games and results are cleared, and the How-to-play state
  is kept.
- Do not push to main until the user has checked it locally (their rule).

## Risk
Medals get easier to keep, because detours are now possible. If too many players get gold
or silver without trying, lower the cap (5 → 4).
