// Tests for the reveal medal cap and medal order (js/logic.js).
// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { betterMedal, medalFor, resultMedal } from "../../js/logic.js";

test("a word revealed by a hint caps gold at silver; clue hints don't", () => {
  const capped = medalFor(4, 4, { revealed: true });
  assert.equal(capped.id, "silver");
  assert.equal(capped.capped, true);
  assert.equal(medalFor(4, 4, { revealed: false }).id, "gold");
  // Already silver or worse: the cap changes nothing and says nothing.
  assert.deepEqual(medalFor(5, 4, { revealed: true }), medalFor(5, 4));
  assert.equal(medalFor(6, 4, { revealed: true }).id, "bronze");
  assert.equal(medalFor(9, 4, { revealed: true }).id, "finished");
});

test("saved results: old ones (no reveals field) keep their medal", () => {
  assert.equal(resultMedal({ status: "won", steps: 3, par: 3, hints: 2 }).id, "gold");
  assert.equal(resultMedal({ status: "won", steps: 3, par: 3, hints: 2, reveals: 0 }).id, "gold");
  assert.equal(resultMedal({ status: "won", steps: 3, par: 3, hints: 2, reveals: 1 }).id, "silver");
});

test("betterMedal ranks medals, not steps over par", () => {
  const capped = medalFor(4, 4, { revealed: true });
  assert.equal(betterMedal(capped, medalFor(6, 4)).id, "silver");
  assert.equal(betterMedal(medalFor(6, 4), medalFor(5, 5)).id, "gold");
  assert.equal([medalFor(9, 4), medalFor(5, 4), medalFor(6, 4)].reduce(betterMedal).id, "silver");
});
