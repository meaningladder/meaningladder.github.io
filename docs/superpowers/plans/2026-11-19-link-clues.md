# Link Clues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every rung, in Daily and Unlimited alike, shows the ConceptNet link from the current word to the next word, written as a short clue before the player types. Only shortest-path answers that fit the clue count.

**Architecture:**
- A new directed link file, `data/relations_v2.*`.
- Pure clue and rule functions in `js/logic.js`.
- Start-first seeded pickers in Python and JS that find fully linked puzzles. The two pickers must agree.
- One game view for both modes, generalized from `chainView`.
- Past puzzles are re-made, and storage schema 8 wipes saves.

**Tech Stack:** vanilla ES modules, `node --test`, Python 3 with pytest, numpy (build script only), `make`.

**Spec:** `docs/superpowers/specs/2026-11-19-link-clues-design.md`

## Global Constraints

- Legal steps are unchanged: graph v1, two-way top 10. Par stays Easy 3, Medium 4, Hard 5. `medalFor` and `pointsFor` are unchanged.
- **Informative relations** are every relation in the relations header except `RelatedTo`. The list is defined once per language: `ladder_core.py` and `js/seeded.js`.
- A puzzle is valid only if some shortest route from start to goal has an informative link on **every** step. The band rule is `minLinkedSteps = par`.
- A guess `v` from `cur` counts iff all of these hold:
  - `v` is a legal step
  - `dist[v] === dist[cur] - 1`
  - the link `cur–v` has the same relation **and** direction as the shown clue
  - `v` is fully linked: its best informative-linked count to the goal equals `dist[v]`
- A plural or singular of an accepted word counts as that word.
- A wrong real word costs a move. Typos, unknown words, and a repeat of a missed word on the same rung are free.
- Hints reveal letters of the planned next word, one move each. The hint that fills the last letter plays the word. The goal auto-plays when it's one step away. A perfect game equals par.
- No em or en dashes in UI files (`make audit`).
- Storage schema 8 wipes `game:*`, `practice*` and `results` once, and keeps preferences. The `sw.js` cache becomes `meaning-ladder-5`.
- Commits end with `Co-Authored-By: <your model> <noreply@anthropic.com>`.

## Review Focus

1. **Direction.** A word with the same relation in the reverse direction must be rejected, and its clue must read the right way round.
2. **Dead ends.** A word that fits the clue but has no fully linked continuation must be rejected. Otherwise the next rung would have no clue.
3. **Off-route answer.** A fitting word that isn't the planned route word must be accepted, and the next clue must follow from it.
4. **Parity.** Python `seeded_linked_puzzle` and JS `seededLinkedPuzzle` must pick the same puzzle for the same seed string, checked against the fixtures.
5. **Speed.** Unlimited Hard (par 5) must find a puzzle in the browser in about a second, not by trying 20,000 random pairs.

---

### Task 1: Directed relations file (relations_v2)

**Files:** `scripts/build_relations.py`, `data/relations_v2.bin`, `data/relations_v2.json`, `tests/test_core.py`.

- [ ] `build_relations.py` gets a version argument, so it can write v2 while v1 stays frozen and untouched.
- [ ] v2 layout: `count × (u uint16, v uint16)` with `u < v`, then `count × uint8` relation index, then `count × uint8` direction. Direction is 0 for ConceptNet edge u→v, 1 for v→u, and 2 for symmetric relations (`Synonym`, `SimilarTo`, `LocatedNear`, `RelatedTo`). The header records `"layout": "directed"`.
- [ ] When a pair has edges in both directions, keep the best-ranked relation as today. If both directions carry that same relation, store it as symmetric (2).
- [ ] Run it on the dump at `C:/Users/nanfa/AppData/Local/Temp/claude/4a59ba5a019c3f7b/4480a2a9-cd5f-4066-98b4-079ff2fe62c7/scratchpad/conceptnet/conceptnet-assertions-5.7.0.csv.gz`: `.venv/Scripts/python scripts/build_relations.py <dump> --version 2`.
- [ ] Test: v2 has the same pair count and labels as v1, so only direction was added.
- [ ] Test: spot-check that `ladder → roof` has direction ladder→roof (`AtLocation`), if that pair is present.
- [ ] Commit: `relations_v2: ConceptNet links with direction`.

### Task 2: Loaders, informative set, clue text

**Files:** `scripts/ladder_core.py` (`load_relations`, an `INFORMATIVE` set), `js/data.js` (`loadRelations`), `js/seeded.js` (`INFORMATIVE`), `js/logic.js` (`linkClue`), `puzzle_config.json` (`"relations": 2`), and tests.

**Interfaces:**
- `load_relations(root, v)` returns `{rel_key: (rel, frm)}`, where `frm` is the word index the edge starts at, or `None` when the relation is symmetric. JS returns a `Map(relKey → {rel, from})`.
- `linkClue(rel, fromCurrent, cur) -> string`. `fromCurrent` is `true` when the edge starts at the current word, `false` when it ends there, and `null` when symmetric.
- Every existing caller that only checks a key exists (`related.has`, `in related`) must keep working against the new value shape.

- [ ] Write a phrase table with one entry per informative relation and direction, avoiding dashes. Examples to match:
  - `AtLocation` with `fromCurrent=false` (next is found at cur): "Something you find at {cur}"
  - `AtLocation` with `fromCurrent=true`: "Where you find {cur}"
  - `IsA`: "A kind of {cur}" (false) / "{cur} is a kind of this" (true)
  - `PartOf`: "Part of {cur}" / "{cur} is part of this"
  - `UsedFor`: "Something used for {cur}" / "What {cur} is used for"
  - `Synonym`: "Means the same as {cur}"
- [ ] Tests:
  - every informative relation, in both directions or symmetric, gives a non-empty clue that doesn't contain a dash
  - `RelatedTo` throws
  - the loader round-trips three known pairs
- [ ] Commit: `Directed relation loaders and link clue text`.

### Task 3: Start-first linked puzzle pickers (Python and JS twins)

**Files:** `scripts/ladder_core.py`, `scripts/generate_puzzle.py`, `js/seeded.js`, `puzzle_config.json` (`minLinkedSteps` = par for each level), `scripts/make_fixtures.py`, `tests/fixtures/seeded_vectors.json`, and tests.

**Interfaces:**
- `linked_from` (existing) and a new JS `linkedFrom(neighbors, related, start, dist)` count informative links only.
- `seeded_linked_puzzle(ladder, seed_str, band) -> {start, goal, par, routes}`. It is deterministic.
  - Pick start words in a seeded order from the candidates.
  - Run BFS from each start, and collect goals at `dist == par` with `linked == par` that also pass the band's other checks (`minGoalInDegree`, routes, closer-first).
  - Pick one goal with the same PRNG.
  - Give up after 300 starts with an error.
- JS twin `seededLinkedPuzzle(ladder, seedStr, band)` returns the identical result.
- Puzzle files store `route = guide_route(...)` over informative links, so every step is linked.

- [ ] The `--no-ai` path and the validator use the new picker and rule, and `shortlist` feeds the informative set.
- [ ] Fixtures cover three seeds per level, and the JS test checks parity with them.
- [ ] Test: `validate_pair` rejects a pair whose best shortest route has an unlinked step.
- [ ] Test: JS Hard (par 5) finds a puzzle in under 1 s (`performance.now`).
- [ ] Commit: `Start-first seeded pickers for fully linked puzzles`.

### Task 4: Play rules and one game view

**Files:** `js/logic.js`, `js/game.js`, `js/data.js` (`makePracticePuzzle`), `style.css`, and tests (`tests/js/chain.test.mjs` becomes `tests/js/linked.test.mjs`, plus `logic.test.mjs`).

**Interfaces:**
- `linkedToGoal(neighbors, related, dist, goal) -> Int array`: for each word, the most informative links on a shortest path to the goal (reverse BFS layers).
- `plannedNext(ladder, related, dist, toGoal, route, cur) -> index`: the next route word when `cur` is on the route. Otherwise it is the most-similar legal next word with `dist == d-1`, an informative link, and `toGoal == dist`.
- `linkedGuess(ladder, related, dist, toGoal, path, typed, goal, planned, misses) -> {ok, word} | {ok:false, wrong:true, word} | {ok:false, error}`. Follow the Global Constraints rule, and keep the form handling and `didYouMean` behavior of `chainGuess`, including never suggesting the planned word.
- Hints use the `chainHint` letter machinery on `planned`.

- [ ] A single game view (generalized from `chainView`) serves Daily and Unlimited. It shows the current rung's clue (`linkClue`) under the moves and par line. Later rungs show "?", and climbed rungs show their words. The letter-blank rows are gone.
- [ ] `makePracticePuzzle` uses `seededLinkedPuzzle` with a crypto seed and stores `route`. Delete `chainPuzzle`'s letter and rival code.
- [ ] Delete code that is now dead, together with its tests:
  - `acceptCap`, `acceptedSteps`, `playWord`, `rejectReason`, `levelAcceptRules`, `ACCEPT_DEFAULTS`, `ACCEPT_WIDTH`, `view.wide`
  - the config fields `acceptStart` and `acceptStep`
  - `patternRivals`, `shown`, the blank-pattern rendering, `chainLetters`
  - `playView`'s wide branch
- [ ] Help: one How to play for both modes. It explains the clue, which word counts, that a wrong word costs a move, and that hints show letters. `seenChainHelp` merges into `seenHelp`.
- [ ] Tests:
  - a wrong-direction word is rejected
  - a dead-end fitting word is rejected
  - a fitting off-route word is accepted, and `plannedNext` follows from it
  - a repeat miss is free
  - hints reveal letters, and the last hint plays the word
  - a perfect game equals par
- [ ] Commit: `One clue-driven game: ConceptNet link per rung, shortest-path answers only`.

### Task 5: Re-make puzzles, wipe, docs

**Files:** `puzzles/2026-11-*.json`, `js/data.js` (`migrateStorage` to schema 8), `sw.js` (`meaning-ladder-5`), `tests/js/storage.test.mjs`, `README.md`, `FOR Guillaume.md`, and the Python tests that pin published puzzles.

- [ ] Delete `puzzles/2026-11-*.json`, then run `.venv/Scripts/python scripts/generate_puzzle.py --date D --no-ai` for each D from 2026-11-01 to 2026-11-20, in order.
- [ ] Check that every file has par 3/4/5 by level and that every route step has an informative link.
- [ ] Schema 8 does the full wipe. The test seeds schema 7 and asserts the wipe happens once and preferences are kept.
- [ ] README:
  - rewrite the rules section: link clue, which answers count, a wrong word costs a move, hints
  - add a note on `relations_v2`
  - remove the wide-acceptance and Unlimited-blanks text
- [ ] `FOR Guillaume.md`: add a dated entry.
- [ ] Run `make check`. It must pass.
- [ ] Commit: `Re-make puzzles with link clues; wipe saves (schema 8)`.
