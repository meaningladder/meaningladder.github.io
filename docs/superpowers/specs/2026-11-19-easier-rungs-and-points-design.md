# Easier rungs, lower par, and a points score

Date: 2026-11-19. Status: awaiting approval.

## Why

Players say the game is still too strict: words that feel right get rejected.
The user also wants a points score next to the medals, measuring how far a
solve is from the optimal path.

## Goals

1. **Lower par by 1 for every day, past ones included:** Easy 3, Medium 4,
   Hard 5. The user wants every game consistent with the new rules, so all
   published days (2026-11-01 onward) are re-made and every player's saved
   games and results are cleared.
2. **Accept far more words per rung.** A guess counts when it is in the
   current word's top N and no farther from the goal than the current word.
   N starts at a per-level number and shrinks every rung climbed:

   | Level | Start N | Shrink per rung | At the new par |
   |---|---|---|---|
   | Easy | 40 | 5 | 40 → 35 → 30 |
   | Medium | 35 | 5 | 35 → 30 → 25 → 20 |
   | Hard | 30 | 4 | 30 → 26 → 22 → 18 → 14 |

3. **Points score, approach A:** `score = min(100, round(100 × par / moves))`.
   Giving up scores 0. Medals stay as they are.

## Non-goals

- The graph doesn't change: legal steps stay top 10, links both ways, and par
  stays the true shortest path on that graph.
- Medal rules don't change.
- Preferences (seen help, theme and so on) are not cleared.

## Anti-goals

- Old and new rules must never mix: no saved game or result from before this
  change may survive, and no day may keep an old par.
- The score must never disagree with the medal. Because both come from moves
  and par, it can't.

## Approaches considered

- **Scoring.** A (par ÷ moves) was **picked**: it can't disagree with medals
  and needs no migration. B (points per closer/flat/farther step) is harder to
  predict and can rank messy solves above clean ones. C (moves plus word
  choice) breaks ties but is opaque without a per-rung breakdown.
- **Rungs.** Making the top 40 the real legal steps was rejected because it
  would shrink every par (mother → match would go from 4 to about 2). Only the
  per-rung acceptance is widened.

## Design

### Rules config (`puzzle_config.json`)

- Keep the single era and change its level pars in place to 3/4/5. With one
  era there is still no "New rules" notice and no "classic rules" label.
- Each level gets `acceptStart` and `acceptStep` (40/5, 35/5, 30/4).

### Re-made past days (`puzzles/`)

- Every published file, from 2026-11-01 through the newest on `main`, is
  deleted and generated again under the new par, in date order so the
  "recent words" check works. A pair can't simply keep its start and goal,
  because par is the true shortest path. Game numbers stay the same.
- This is the second deliberate exception to "published puzzles are never
  overwritten" (the first was Nov 1–12 on 2026-11-16).
- The generator (`scripts/ladder_core.py`, `generate_puzzle.py`) reads par
  from the era, so new puzzles get the new par. Check that `minPar` (3) still
  allows Easy 3 and that `minCloserFirstMoves` still finds puzzles at par 3.

### Acceptance (`acceptedSteps`, `js/logic.js:863`)

- `cap = max(1, acceptStart − acceptStep × rungsClimbed)`, where
  `rungsClimbed = dist[start] − dist[current]`. Flat steps don't shrink N.
  The goal is always accepted when it's a legal step.
- Candidates are the current word's **top N nearest words in the full
  neighbor list** (not only the top-10 legal list), filtered to
  `dist[v] >= 0 && dist[v] <= dist[current]`, closer first.
  - Distances still come from the top-10 two-way graph, so a word outside
    the legal graph only counts if it has a route.
  - The full rows are already loaded as `base.neighbors` (`js/data.js:147`)
    before they're cut to the top 10. Keep them on the ladder object, minus
    the `removedSteps` words.
- The Tried list's "not top N" label shows the real N for that rung.
- Python has no twin of `acceptedSteps` today. Re-check the "every published
  puzzle can be finished in par" test against the new rule.

### Points (`js/logic.js` results section)

- `pointsFor(moves, par)` next to `medalFor`. A saved result's points come
  from `scoreOf(r)` and `r.par`.
- Shown on:
  - the result card ("🥈 Silver · 80 pts")
  - the share text, in the line `Meaning Ladder #N Level 🥈 80 pts`
  - stats, as average points per level
  - the archive list, as points beside the moves
- Gave-up games show no points in the share text, the same way they show no
  medal.

### Storage

Schema 7 wipes every saved game (`game:*`, `practice*`) and all `results`
once, like schema 5 did. Preferences stay. Streaks and stats reset as a
result, because they are computed from `results`. The service worker cache
name is bumped so no old puzzle file is served offline.

## Left to the builder

- The exact layout of the points on the result card and in stats.
- Test fixtures for the new cap schedule and for `pointsFor` edge cases:
  moves < par, moves = 0 guard, gave up.
- Merge `origin/main` into `old-games-new-rules` before starting.
