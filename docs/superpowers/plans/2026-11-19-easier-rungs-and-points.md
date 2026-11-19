# Easier Rungs, Lower Par, and Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily rungs accept many more words (a top-N schedule per level), every day (past ones re-made) gets par 3/4/5, every result gets a 0–100 points score next to its medal, and Unlimited becomes a strict one-answer chain with one letter shown per hidden word.

**Architecture:** The graph, distances and par stay exactly as they are (top-10, two-way). Only the "does this guess count" check widens: pure functions in `js/logic.js` decide it, and `js/game.js` calls them. The new par is changed in place in the single rules era of `puzzle_config.json`; every published puzzle is re-made and storage schema 7 wipes saves and results once. Points are derived from moves and par. Unlimited is browser-only and gets a chain mode ported from git history.

**Tech Stack:** Vanilla ES modules (browser), `node --test`, Python 3 + pytest for the generator, `make`.

**Spec:** `docs/superpowers/specs/2026-11-19-easier-rungs-and-points-design.md`

## Global Constraints

- Accept schedule: Easy start 40, step 5. Medium start 35, step 5. Hard start 30, step 4.
- `cap = max(1, acceptStart − acceptStep × rungsClimbed)`, where `rungsClimbed = dist[start] − dist[current]`. Flat steps don't shrink it.
- One era for every day, with pars changed in place: Easy 3, Medium 4, Hard 5.
- Every published puzzle (2026-11-01 through the newest on `main`) is re-made under the new par. Game numbers stay the same.
- Storage schema 7 wipes all `game:*`, `practice*` keys and `results`, and keeps preferences. Bump the service worker `CACHE`.
- `points = min(100, round(100 × par / moves))`. Gave up scores 0. Medals are unchanged.
- **Two additions to the spec, both required by its anti-goals:**
  - A guess may never skip a rung: `dist[v] >= dist[cur] − 1`. Otherwise a top-40 word could beat par.
  - Every legal step stays accepted. A two-way link can rank past the cap in the wide list (the smallest cap is 14).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Skipping a rung.** A top-N word two rungs closer must be rejected, or players beat par. Task 1 test: `never skips a rung`.
2. **Two-way links ranked past the cap.** A legal step that ranks beyond N in the wide list must still count. Task 1 test: `keeps every step the old rule accepted`.
3. **Neighbor rows not loaded wide enough.** The browser can hold rows narrower than 40 until `ensureWidth` loads the tail. Task 2 test: `readyFor loads at least the widest accept start`.
4. **Removed junk words.** `removedSteps` words must not come back through the wide list. Task 2 test: `wide list drops removed words`.
5. **Coming back after the wipe.** A returning player must lose old games and results but keep their preferences, and the wipe must run only once. Task 3B test: `schema 7 wipes games and results once, keeps prefs`.

---

### Task 0: Sync and commit the spec

- [ ] **Step 1:** Run `git merge origin/main` on `old-games-new-rules`. Expected: fast-forward or a clean merge. `puzzles/2026-11-20-*.json` should then exist.
- [ ] **Step 2:** Run `make test`. Expected: all pass. That's the baseline.
- [ ] **Step 3:** Commit the spec and this plan:

```bash
git add docs/superpowers/specs/2026-11-19-easier-rungs-and-points-design.md docs/superpowers/plans/2026-11-19-easier-rungs-and-points.md
git commit -m "Spec and plan: easier rungs, par 3/4/5, points score"
```

### Task 1: Accept cap and accepted steps (pure logic)

**Files:**
- Modify: `js/logic.js:856-871` (`acceptedSteps`)
- Test: `tests/js/logic.test.mjs:617-634` (replace that test)

**Interfaces:**
- Produces:
  - `acceptCap(levelRules: {acceptStart:number, acceptStep:number}, rungsClimbed: number) -> number`
  - `acceptedSteps(legal: number[][], wide: number[][], dist: number[], cur: number, cap: number) -> number[]`
- Behavior of `acceptedSteps`:
  - The result is the union of `legal[cur]` and `wide[cur].slice(0, cap)`, filtered to `dist[v] >= 0 && dist[cur] - 1 <= dist[v] <= dist[cur]`.
  - It is sorted closer first, then legal-list order, then wide-list order, without duplicates.
  - When `dist[cur] === 1` it returns only the goal (`dist[v] === 0`), as today.
  - It returns `[]` at the goal or off route.

- [ ] **Step 1: Write the failing tests** (replace the old `accepted steps` test):

```js
test("accept cap: starts per level, shrinks per rung, never below 1", async () => {
  const { acceptCap } = await import("../../js/logic.js");
  assert.deepEqual([0, 1, 2].map((r) => acceptCap({ acceptStart: 40, acceptStep: 5 }, r)), [40, 35, 30]);
  assert.deepEqual([0, 4].map((r) => acceptCap({ acceptStart: 30, acceptStep: 4 }, r)), [30, 14]);
  assert.equal(acceptCap({ acceptStart: 30, acceptStep: 4 }, 9), 1);
});

test("accepted steps: wide top N, no farther, closer first", async () => {
  const { acceptedSteps } = await import("../../js/logic.js");
  // dist: 0:3 1:3 2:2 3:4 4:2 5:-1 6:3 7:2 8:1 9:0
  const dist = [3, 3, 2, 4, 2, -1, 3, 2, 1, 0];
  const legal = [[2], [], [], [], [], [], [], [], [9], []];
  const wide = [[1, 2, 3, 4, 5, 6, 7], [], [], [], [], [], [], [], [9, 2], []];
  assert.deepEqual(acceptedSteps(legal, wide, dist, 0, 40), [2, 4, 7, 1, 6]);
  assert.deepEqual(acceptedSteps(legal, wide, dist, 0, 2), [2, 1]);   // cap cuts the wide list only
  assert.deepEqual(acceptedSteps(legal, wide, dist, 8, 40), [9]);     // one out: only the goal
  assert.deepEqual(acceptedSteps(legal, wide, dist, 9, 40), []);
  assert.deepEqual(acceptedSteps(legal, wide, dist, 5, 40), []);
});

test("accepted steps: never skips a rung", async () => {
  const { acceptedSteps } = await import("../../js/logic.js");
  // 0 is 3 out; 1 is 1 out (two rungs closer) and must not count.
  assert.deepEqual(acceptedSteps([[]], [[1, 2]], [3, 1, 2], 0, 40), [2]);
});

test("accepted steps: keeps every step the old rule accepted", async () => {
  const { acceptedSteps } = await import("../../js/logic.js");
  // Legal closer step 3 sits at wide rank 4, past a cap of 2: still accepted.
  assert.deepEqual(acceptedSteps([[3]], [[1, 2, 4, 3]], [5, 9, 9, 4, 9], 0, 2), [3]);
});
```

- [ ] **Step 2:** Run `node --test tests/js/logic.test.mjs`. Expected: FAIL, because `acceptCap` is not exported.
- [ ] **Step 3:** Implement `acceptCap` and the new `acceptedSteps` in `js/logic.js`. Rewrite the comment above them so it explains the schedule and the no-skip floor.
- [ ] **Step 4:** Run `node --test tests/js/logic.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit: `Accept a wide top-N per rung, shrinking each rung climbed`.

### Task 2: Wire the wide check into the game

**Files:**
- Modify: `js/data.js:137-160` (`viewOf`, `readyFor`)
- Modify: `js/logic.js` (add `playWord` next to `checkStep`)
- Modify: `js/game.js:725-754` (`submit`), `js/game.js:888-893` (Tried label)
- Test: `tests/js/logic.test.mjs`, `tests/js/ladder.test.mjs`

**Interfaces:**
- Consumes: `acceptCap` and `acceptedSteps` from Task 1, plus `level.acceptStart`/`acceptStep` from Task 3's config. Use these defaults until Task 3 lands: `ACCEPT_DEFAULTS = { easy: {acceptStart: 40, acceptStep: 5}, medium: {acceptStart: 35, acceptStep: 5}, hard: {acceptStart: 30, acceptStep: 4} }`, exported from `js/seeded.js` beside `LEVELS`. The config values override them.
- Produces:
  - `view.wide: number[][]`: the full rows with `removedSteps` words dropped (`dropSteps(base.neighbors, gone)`), cached per view.
  - `playWord(ladder, dist, path, typed, goal, cap) -> {ok:true, word, note?} | {ok:false, noCloser:true, word} | <checkStep's error result>`. It runs `checkStep` first:
    - A result that is `ok`, or carries a `nearMiss`, for a known word not on the path is played when its index is in `acceptedSteps(ladder.neighbors, ladder.wide, dist, cur, cap)`.
    - Otherwise a known word gets `noCloser`.
    - Every other `checkStep` error passes through unchanged.
  - `ACCEPT_WIDTH = 40` in `js/seeded.js`: the widest accept start. `readyFor` ensures `max(k, ACCEPT_WIDTH)`.

- [ ] **Step 1: Write the failing tests:**
  - `logic.test.mjs` `playWord plays a wide word that isn't a legal step`: build a tiny ladder where the word is in `wide[cur]` within the cap and one rung closer, but not in `neighbors[cur]`. Expect `{ok: true, word}`.
  - `playWord marks a close but not accepted word noCloser`: same ladder, with the word one rung farther. Expect `noCloser: true`.
  - `playWord keeps checkStep's typo errors`: `"zzzz"` returns the `isn't in our` error.
  - `ladder.test.mjs` `wide list drops removed words`: after `ladderAt`, no row of `view.wide` contains the index of a word from `data/removed_steps.json`.
  - `ladder.test.mjs` `readyFor loads at least the widest accept start`: after `await readyFor(base, puzzle)`, `base.neighbors[0].length >= 40`.
- [ ] **Step 2:** Run `make test-js`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `view.wide`, `ACCEPT_WIDTH` in `readyFor`, and `playWord`.
- [ ] **Step 4:** In `game.js` `submit`:
  - Compute `cap = acceptCap(levelRules, Math.max(0, stepsTo(puzzle.start) - stepsTo(current)))`. Here `levelRules` is `ladder.config.levels?.[puzzle.level]`, falling back to `ACCEPT_DEFAULTS[puzzle.level]`.
  - Replace the `checkStep` + `acceptedSteps` pair with `playWord`.
  - Keep the current Tried and feedback behavior for `nearMiss` and `noCloser`.
  - Change the Tried label at `game.js:893` to `not top ${cap}`, using the cap for `state.tried.at`.
- [ ] **Step 5:** Run `make test-js`. Expected: PASS.
- [ ] **Step 6:** Run `make serve`, open today's Easy puzzle and check by hand:
  - A sensible word outside the top 10 that moves toward the goal is played.
  - A word two rungs closer is listed as `not top N`.
- [ ] **Step 7:** Commit: `Play wide top-N words; Tried list shows the real N`.

### Task 3: Par 3/4/5 and the accept schedule in config

**Files:**
- Modify: `puzzle_config.json`
- Test: `tests/test_core.py:120-130`

**Interfaces:**
- Produces:
  - The single era in `config.rules` with `levels.easy.par 3`, `medium.par 4` and `hard.par 5`.
  - Each level carries `acceptStart`/`acceptStep` from the Global Constraints.
  - Keep `minPar` at 3. There is still one era, so no "New rules" notice and no "classic rules" label.

- [ ] **Step 1:** Change the failing expectation in `tests/test_core.py:129` to `[3, 4, 5]`. Also update `tests/test_core.py:308` (`hard[2].par == 6` → `5`).
- [ ] **Step 2:** Run `make test-py`. Expected: those tests FAIL.
- [ ] **Step 3:** Edit `puzzle_config.json`.
- [ ] **Step 4:** Run `make test-py`. Expected: the band tests PASS. The published-puzzle checks (`test_core.py:318`, `:472`) now FAIL, because the old files carry the old par. Task 3B fixes those, so don't commit between 3 and 3B.
- [ ] **Step 5:** Run `make fixtures` and keep any change to `tests/fixtures/seeded_vectors.json` for the 3B commit.

### Task 3B: Re-make every published day, wipe saves once

**Files:**
- Modify: every `puzzles/2026-11-*.json` (deleted and regenerated)
- Modify: `js/data.js:268-287` (`migrateStorage`), `sw.js:8` (`CACHE`)
- Test: `tests/js/storage.test.mjs`

**Interfaces:**
- Consumes: the Task 3 config.
- Produces: puzzle files for 2026-11-01 through the newest date on `main`, all with par 3/4/5, plus `store.schema === 7`.

- [ ] **Step 1: Write the failing test** in `storage.test.mjs`, `schema 7 wipes games and results once, keeps prefs`:
  - Seed schema 6 with `game:2026-11-18:easy`, `practice:easy`, `results` holding one entry, and `seenHelp: true`.
  - Run `migrateStorage()`.
  - Assert the game keys and `results` are gone, `seenHelp` is still `true`, and `schema === 7`.
  - Write a new result, run `migrateStorage()` again and assert the result survives.
- [ ] **Step 2:** Run `node --test tests/js/storage.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** In `migrateStorage`, schema `< 7` gets the same wipe as schema 5 (every `game:` and `practice` key, plus `results`), replacing the `< 5` / `< 6` branches. The schema-6 date-range branch is moot now, so delete it. Set `schema` to 7. Update the comment to give the date and the reason: par 3/4/5 and wide rungs for every day.
- [ ] **Step 4:** Bump `sw.js` to `CACHE = "meaning-ladder-3"` and update its comment.
- [ ] **Step 5:** Run `node --test tests/js/storage.test.mjs`. Expected: PASS.
- [ ] **Step 6: Re-make the puzzles, in date order.**
  - Note the last date: `ls puzzles | tail -1`.
  - Delete `puzzles/2026-11-*.json`.
  - For each date from 2026-11-01 to that last date, run `$(PY) scripts/generate_puzzle.py --date <D>`. Use the AI pick when a key is set, otherwise add `--no-ai`, which falls back to the seeded pick.
  - Expected: three files per day, each with `par` equal to 3/4/5 for its level and the same `gameNumber` as before.
  - Check with: `python -c "import json,glob; print({(json.load(open(f))['level'], json.load(open(f))['par']) for f in glob.glob('puzzles/*.json')})"` → `{('easy',3),('medium',4),('hard',5)}`.
- [ ] **Step 7:** Run `make test`. Expected: all PASS, including `test_core.py:318` and `:472`. If `:318` pins specific start/goal words for a fixed date, update it to the new files and say so in the commit.
- [ ] **Step 8:** Commit Tasks 3 and 3B together: `Par 3/4/5 for every day: re-make published puzzles, wipe saves (schema 7)`.

### Task 4: Points score

**Files:**
- Modify: `js/logic.js:493-520` (results), `js/logic.js:613-622` (`shareText`), `js/logic.js:653-683` (`computeStats`)
- Modify: `js/game.js:278` (`statsRow`), `js/game.js:365` (archive list), `js/game.js:1105` (result card)
- Test: `tests/js/logic.test.mjs`, `tests/js/streak.test.mjs` (or wherever `computeStats` is tested: `grep -ln computeStats tests/js`)

**Interfaces:**
- Produces:
  - `pointsFor(moves: number, par: number) -> number`: `min(100, round(100*par/moves))`, or 0 when `moves <= 0`.
  - `resultPoints(r) -> number`: `pointsFor(scoreOf(r), r.par)` when `r.status === "won"`, and 0 when it's `"gaveUp"`.
  - `computeStats(...).avgPointsByLevel: {easy: number|null, medium: number|null, hard: number|null}`: the rounded mean over finished games of that level, with gave-up games counting 0.
  - `shareText` first line: `Meaning Ladder ${label} ${emoji} ${points} pts`. Gave up keeps no badge and no points.

- [ ] **Step 1: Write the failing tests:**
  - `pointsFor`: `(4,4)→100`, `(5,4)→80`, `(6,4)→67`, `(8,4)→50`, `(3,4)→100`, `(0,4)→0`.
  - `resultPoints works for old results`: `{status:"won", steps:5, undos:1, par:4}` (no `moves`) gives 67, and `{status:"gaveUp", moves:9, par:4}` gives 0.
  - `shareText` has the first line `Meaning Ladder #13 Hard 🥈 86 pts` for `moves 7, par 6`. The gave-up line has no `pts`. Update the existing share-text expectations to match.
  - `computeStats`: one easy win at 100 and one easy give-up give `avgPointsByLevel.easy === 50`, with `medium === null`.
- [ ] **Step 2:** Run `make test-js`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `pointsFor`, `resultPoints`, the `shareText` line and `avgPointsByLevel`.
- [ ] **Step 4:** Update the UI:
  - Result card: `🥈 Silver · 80 pts`.
  - Archive status: `5 moves · 80 pts`.
  - Stats dialog: one line `Average points: easy 82, medium 70, hard —`, with `—` for null.
- [ ] **Step 5:** Run `make test-js`. Expected: PASS. Run `make serve` and check that the card, archive and stats show points.
- [ ] **Step 6:** Commit: `Points score (100 × par ÷ moves) beside medals`.

### Task 5B: Strict Unlimited (chain mode)

6. **Strict Unlimited (chain mode).** It's browser-only, so there's no Python or puzzle files. The old chain code is in git history: the code is removed in `a49fade`, the blanks-with-length rendering is at `d3247fa`, and `a49fade^:js/seeded.js` has `patternRivals`, `chainRank` and `chainWide`. Port from those rather than writing fresh.
   - **Rules:**
     - Chain length = the level's par from the newest era (3/4/5), so there are 2/3/4 hidden words.
     - Only the hidden word counts on each rung. Plural and singular forms are counted as the word, as `checkStep` does today.
     - Every wrong guess is a move and goes into the Tried list, ranked by closeness to the hidden word (`chainRank`).
     - A hint reveals one more letter and costs a move. Once the last blank is filled, the word is played.
     - Medals and points are the same as daily: `medalFor` / `pointsFor` with moves and par.
   - **Generation** (`makePracticePuzzle`, `js/data.js:210`):
     - Pick the start and goal as today (`seededPuzzle`), then a route with `guideRoute` (`js/logic.js`), the readable shortest path.
     - For each hidden word, choose the revealed letter position at random, but prefer a position where no **rival** matches the pattern. A rival is any other word among the previous word's close words (`patternRivals`, window 40) with the same length and the same letter in that spot.
     - If a word has rivals at every position, retry with a new seed, up to 20 times. After that, accept the one with the fewest rivals.
     - The puzzle object gains `mode: "chain"`, `route`, and `shown: [{pos, letter}]` per hidden word. Saved Unlimited games store it, so resuming shows the same letters.
   - **UI** (`js/game.js`):
     - When `puzzle.mode === "chain"`, the ladder shows the start, then one row per hidden word as blanks with its shown letters, then the goal.
     - `submit` checks the typed word against the next hidden word instead of calling `playWord`.
     - How-to-play text for Unlimited explains the one-answer rule and the letter clue.
     - Re-add the chain styles from `a49fade^:style.css`.
   - **Tests** (`tests/js/chain.test.mjs`, new):
     - Easy/Medium/Hard chains have 2/3/4 hidden words, and each consecutive pair is a legal step one rung closer.
     - Every `shown` letter matches the hidden word at `pos`.
     - Only the hidden word (or its plural form) is accepted. A legal but different word costs a move and isn't played.
     - A hint reveals a new position, and the last hint plays the word.
     - A seeded generation with a fixed seed is deterministic.

- [ ] Commit: `Strict Unlimited: one hidden answer per rung, one letter shown`.

### Task 5: Docs and full check

**Files:** `README.md` (rules table and intro), `FOR Guillaume.md` (a dated entry)

- [ ] **Step 1:** Update the README:
  - Fix the intro, which says "100 nearest neighbors". It should say legal steps are the top 10, and rungs accept the top N from the schedule.
  - Change the rules table to par 3/4/5.
  - Note that every day was re-made and saves were wiped on 2026-11-19 (schema 7).
  - Add short "Points" and "Strict Unlimited" paragraphs.
- [ ] **Step 2:** Add a 2026-11-19 entry to `FOR Guillaume.md`: what changed and why, plus the no-skip floor lesson.
- [ ] **Step 3:** Run `make check`. Expected: all tests and audits pass.
- [ ] **Step 4:** Commit: `Docs: wide rungs, par 3/4/5, points`.
