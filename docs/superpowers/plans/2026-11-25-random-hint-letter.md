# Random Hint Letter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hints reveal letters in a seeded random order that never includes the first letter.

**Architecture:** `hintOrder(word, clue)` in `js/logic.js` returns positions 1..n-1 shuffled by a PRNG seeded from the word. `shownLetters` and `linkedHint` already consume it, so nothing else changes.

**Tech Stack:** Vanilla ES modules, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-25-random-hint-letter-design.md`

## Global Constraints

- Position 0 is never in the hint order, on link and letters rungs alike.
- The order is a pure function of the word (reload-safe, same for every player).
- The last hint plays the word; no move for the goal follow-on beyond today's rule.
- No new dependency; reuse `fnv1a32` and `mulberry32` from `js/seeded.js`.

## Review Focus

- A 1-letter word: order is empty; the first hint plays the word (`r.hints >= 0` already true after one hint). Expect no crash.
- A 2-letter word: one hint, it plays the word.
- Reload mid-rung: same `r.hints` must give the same shown letters (covered by the stability assertion).
- Letters clue: position 0 still shown from the clue, hints never re-pick it.

---

### Task 1: Seeded hint order without the first letter

**Files:**
- Modify: `js/logic.js:3` (import), `js/logic.js:172-173` (`hintOrder`)
- Test: `tests/js/linked.test.mjs:137-149`

**Interfaces:**
- Produces: `hintOrder(word: string, clue) -> number[]`, a permutation of `1..word.length-1`. `clue` is now unused; keep the parameter so callers stay unchanged, or drop it from both call sites in `js/logic.js` (179, 213).

- [ ] **Step 1: Rewrite the hint test** `"hints reveal letters for a move each, and the last hint plays the word"`:
  - after 1 hint on the `truck` rung: exactly one non-`_` letter, not at index 0, and it matches `truck` at its position.
  - `shownLetters` called twice gives the same array.
  - after 3 hints: `[s.path, s.moves, s.hints]` equals `[["jeep"], 3, 3]`; the 4th hint plays it: `[s.path, s.moves]` equals `[["jeep", "truck"], 4]`.
  - letters rung: before hints `["t","_","_","_","_","_"]`; after 1 hint exactly 2 letters shown, one being index 0.
- [ ] **Step 2: Run** `node --test tests/js/linked.test.mjs` — expect FAIL (first hint shows index 0 on the link rung; truck needs 5 hints).
- [ ] **Step 3: Implement `hintOrder`**: positions `1..n-1`, Fisher-Yates with `mulberry32(fnv1a32(word))`. Comment: one line saying it is seeded by the word so reloads and players agree.
- [ ] **Step 4: Run** `node --test "tests/js/*.test.mjs"` — expect all pass.
- [ ] **Step 5: Commit** `js/logic.js tests/js/linked.test.mjs docs/superpowers/` with message "Hints show a random letter, never the first".
