# Open Ladders Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From Nov 15, Daily and Unlimited are open ladders again; climbed rungs form a staircase from red (bottom) to green (top); wrong guesses fill light red by how close they were.

**Architecture:** A new rules era in `puzzle_config.json` switches every new day (and Unlimited, which follows the newest era) back to open play. The generator and game already handle open eras, so the code work is the era notices/labels (which assume "newest = chain"), a height-based rung color, and one color token. Chain code stays: Nov 13–14 archive days still play as chains.

**Tech Stack:** Vanilla ES modules (`js/`), plain CSS (`style.css`), Python generator (`scripts/`), `node --test` + `pytest`, `make check PY=python`.

**Spec:** No separate design doc. The brainstorm on 2026-11-14 settled the request; the decisions are recorded in *Decisions* below, with mine marked **(my call)**.

## Decisions

1. Daily and Unlimited go back to open ladders: any word one rung closer counts (`upOneRung`, already in place).
2. New era `"from": "2026-11-15"`, with the exact settings of the last open era (commit `376f926`, Nov 13 block): `stepLimit` 10, `twoWay` true, same `excludeCandidates`, `minPar` 3, `maxPar` 7, par Easy 4 / Medium 5 / Hard 6, `minRoutes` 1, `maxRoutes` 100000, `minCloserFirstMoves` 3 on Easy and Medium. **(my call: the last open rules players saw)**
3. Nov 13–14 stay chain days. They are published and played, so they are never overwritten.
4. Staircase: each climbed rung's color is set by its **height**, red at rung 0 and green at the goal, not by distance. The "N to go" text stays. Empty rungs stay dashed and uncolored. **(my call: the color fills in as you climb, so the staircase builds under you)**
5. Wrong guesses in open ladders: same chips and fill amount (`rankFill`) as now, but the fill color becomes light red instead of beige clay. Soft, not alarm red. **(my call)**
6. Returning players get a one-time "New rules" notice: ladders are open again.

## Global Constraints

- **Deadline:** UTC+14 reaches Nov 15 at **10:00 UTC on 2026-11-14**. Task 1 must be on `main`, and the open Nov 15 puzzles generated, before then. If Task 1 can't be pushed by **09:00 UTC**, use `"from": "2026-11-16"` everywhere this plan says Nov 15.
- Published puzzle files are never edited or deleted. If the 06:17 UTC cron writes `2026-11-15-*.chain.json`, leave them; open play reads `2026-11-15-<level>.json`.
- No em or en dashes in player-facing text (tested in `eras.test.mjs`).
- Write source text containing backslash escapes with Edit/Write, never shell heredocs.
- Run `make check PY=python` before every push. Load the page in a browser before pushing UI changes.

## Review Focus

1. **A player mid-way through an Unlimited chain** when the switch lands: their save is replaced by a fresh open ladder without an error. The existing `chainNow` check in `game.js:586-591` handles this. Task 4 checks it by hand.
2. **Archive day Nov 13 or 14 opened after the switch:** it still plays as a chain and is labelled as a chain day, not as "top 10". Covered by a Task 2 test.
3. **Color-blind players:** red and green are hard to tell apart. Height and the "N to go" text still carry the meaning, and the hue ramp also changes lightness (Task 3), so the steps differ even in grayscale.
4. **Ladders of any length** (par 3–7, archive par 3/4): the bottom rung is always red and the goal always green. Covered by the `stairHue` endpoint tests.
5. **Dark mode:** stair colors and the light-red chips need their own darker values, with text still readable. Task 3 and Task 4 check this by eye.

---

### Task 1: Open era from Nov 15 (ship first, before 09:00 UTC)

**Files:**
- Modify: `puzzle_config.json` (append the era after the `2026-11-13` chain era)
- Test: `tests/test_generate.py:103-115`, `tests/js/eras.test.mjs:67-86`

**Interfaces:**
- Produces: `rulesFor(config, "2026-11-15").mode === undefined` (open), `rulesFor(config, null)` = the Nov 15 era (Unlimited); generator writes `puzzles/2026-11-15-<level>.json`.

- [ ] **Step 1: Write the failing tests.** In `tests/test_generate.py`, extend `test_puzzles_follow_their_dates_rules`: a puzzle for `date(2026, 11, 14)` still has `mode == "chain"`, and one for `date(2026, 11, 15)` has no `mode` key, `stepLimit == 10`, `twoWay is True`, and `par` 4 / 5 / 6 for easy / medium / hard. Update the docstring. In `tests/js/eras.test.mjs`, change the real-config test: `newestEra(config).from === "2026-11-15"`, `newestEra(config).mode === undefined`, `isClassicDay(config, "2026-11-14") === true`, `isClassicDay(config, "2026-11-15") === false`. Leave the notice/label assertions for Task 2: mark them `test.todo` for now, with a comment.
- [ ] **Step 2: Run them and check they fail.** `make test PY=python`. Expected: the new Nov 15 assertions FAIL (the newest era is still chain).
- [ ] **Step 3: Add the era** to `puzzle_config.json` with the values in Decision 2. Copy them from `git show 376f926:puzzle_config.json` (the `2026-11-13` block), changing only `from`.
- [ ] **Step 4: Run the checks.** `make check PY=python`. Expected: PASS.
- [ ] **Step 5: Commit and push.** `git commit -m "Open ladders again from Nov 15"`, then push.
- [ ] **Step 6: Generate Nov 15 now** (don't wait for the 08:47 cron): `gh workflow run daily-puzzle.yml`. Watch with `gh run watch`. Expected: three `puzzles/2026-11-15-{easy,medium,hard}.json` on `main`, each with no `mode` key.

### Task 2: Notices and labels when the newest era is open after a chain

**Files:**
- Modify: `js/logic.js:717-723` (`classicLabel`), `js/logic.js:749-760` (`rulesNoticeText`), `js/game.js:511-516` (archive `classicNote`)
- Test: `tests/js/eras.test.mjs`

**Interfaces:**
- Consumes: the Nov 15 era from Task 1.
- Produces: `classicLabel(config, dateStr): string`, `rulesNoticeText(config, dayText): string`. Signatures unchanged.

- [ ] **Step 1: Write the failing tests** (replacing Task 1's `test.todo`s):

```js
assert.equal(rulesNoticeText(config, fixedDay),
  "From November 15, ladders are open again: any word one rung closer to the goal is a step."
  + " Your ladder turns from red to green as you climb, and each word that isn't a step up shows how close it was.");
assert.equal(classicLabel(config, "2026-11-13"), "classic rules (chain ladder)");
assert.equal(classicLabel(config, "2026-11-14"), "classic rules (chain ladder)");
assert.equal(classicLabel(config, "2026-11-12"), "classic rules (top 100)");
assert.equal(classicLabel(config, "2026-11-15"), "");
assert.equal(rulesNoticeDue(config, "2026-11-15", ["2026-11-13"], false), true);
assert.equal(rulesNoticeDue(config, "2026-11-14", ["2026-11-13"], false), false);
```

Keep the existing open→chain cases working by building a two-era `{open, chain}` config inline with the `era()` helper and a `mode: "chain"` field, so the old notice text stays tested.
- [ ] **Step 2: Run them and check they fail.** `node --test tests/js/eras.test.mjs`. Expected: FAIL on the notice text and the chain labels.
- [ ] **Step 3: Implement.** In `rulesNoticeText`, add a branch `newest.mode !== "chain" && old.mode === "chain"` that returns the exact text above. In `classicLabel`, a day whose own era is a chain era returns `"classic rules (chain ladder)"`. Leave the open→chain branch as is. In `game.js` `classicNote`, when the newest era is open and the era before it is a chain, the sentence ends `"chain ladders, where each hidden rung has one answer."`.
- [ ] **Step 4: Run the checks.** `make check PY=python`. Expected: PASS, including "notice text has no em or en dashes".
- [ ] **Step 5: Commit.** `git commit -m "New rules notice and archive labels for the return to open ladders"`

### Task 3: Staircase rungs and light-red guesses

**Files:**
- Modify: `js/logic.js` (new export next to `closeness`, ~line 592), `js/game.js:999-1015` (`rungEl`, filled rungs only), `style.css:28-33,60-73` (tokens), `style.css:245-250` (new `.bar.stair` rule), `style.css:258-259` (comment on tried colors)
- Test: `tests/js/logic.test.mjs`

**Interfaces:**
- Produces: `stairHue(rung: number, par: number): number`, a hue in degrees, `0` (red) at `rung <= 0`, `130` (green) at `rung >= par`, linear and rounded in between; `par <= 0` returns `130`.

- [ ] **Step 1: Write the failing test** in `tests/js/logic.test.mjs` (add `stairHue` to the import):

```js
test("stairHue runs red at the bottom to green at the goal", () => {
  assert.equal(stairHue(0, 5), 0);
  assert.equal(stairHue(5, 5), 130);
  assert.equal(stairHue(2, 4), 65);
  assert.equal(stairHue(-1, 4), 0);   // below the start
  assert.equal(stairHue(9, 4), 130);  // never past green
  assert.equal(stairHue(0, 0), 130);
  for (const par of [3, 4, 5, 6, 7])  // every step is warmer than the one below
    for (let r = 1; r <= par; r++) assert.ok(stairHue(r, par) > stairHue(r - 1, par));
});
```

- [ ] **Step 2: Run it and check it fails.** `node --test tests/js/logic.test.mjs`. Expected: FAIL, `stairHue` is not exported.
- [ ] **Step 3: Implement `stairHue`** in `js/logic.js`.
- [ ] **Step 4: Wire it into the rungs.** In `rungEl`, for a filled rung (`row.at != null || isGoal`), add the class `stair` and set `--stair-hue:${stairHue(row.rung, puzzle.par)}; --fill:100%` on the element `bar()` returns. Don't change `bar()` itself: the off-route bars and the How-to-play examples keep their distance colors.
- [ ] **Step 5: Add the CSS.** Add `.bar.stair { --tone: hsl(var(--stair-hue) var(--stair-sat) calc(var(--stair-light) + var(--stair-hue) * var(--stair-lift))); }`. Tokens: light theme `--stair-sat: 60%; --stair-light: 76%; --stair-lift: 0.03%`. Dark theme (both dark blocks): `--stair-sat: 32%; --stair-light: 28%; --stair-lift: 0.04%`. Set `--tried` to `#f5c2bd` (light) and `#6a3a38` (dark), and update the comment at `style.css:258` to say tried chips are light red.
- [ ] **Step 6: Run the checks.** `make check PY=python`. Expected: PASS, including `syntax.test.mjs`.
- [ ] **Step 7: Commit.** `git commit -m "Open ladders: rungs climb from red to green; wrong guesses fill light red"`

### Task 4: Check in the browser, then push

**Files:** none changed unless a fix is needed.

- [ ] **Step 1: Serve locally.** `python -m http.server 8000` from the repo root, then open `http://localhost:8000/`.
- [ ] **Step 2: Check today's Daily (Nov 14)** in the browser, at phone width and in dark mode. Expected: it still plays as a chain (its era hasn't changed). Then open Unlimited. Expected: an open ladder; climbing 2 rungs shows red then orange-ish rungs; a word that isn't a step up appears as a light-red chip whose fill grows with closeness; the goal rung is green; the text is readable in both themes.
- [ ] **Step 3: Check the archive.** Expected: Nov 13 shows "classic rules (chain ladder)" and plays as a chain; Nov 12 shows "classic rules (top 100)".
- [ ] **Step 4: Check a save from before the switch.** With a chain Unlimited save in localStorage (play one rung before pulling Task 1), reload. Expected: a fresh open ladder, no console errors.
- [ ] **Step 5: Push.** Push, then confirm the Pages deploy (`gh run list -w pages.yml -L 1`) and load https://meaningladder.github.io/ once.
