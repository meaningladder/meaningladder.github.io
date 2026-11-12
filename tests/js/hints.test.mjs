// Tests for hint memory, hint text and the reveal medal cap (js/logic.js).
// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  betterMedal, buildReverse, closerSteps, distancesToGoal, hintText, hintTier,
  medalFor, resultMedal, upgradeHintState,
} from "../../js/logic.js";

// ocean -> wave -> signal -> network -> computer, plus a dead end (sea).
const words = ["ocean", "wave", "signal", "network", "computer", "keyboard", "sea"];
const W = Object.fromEntries(words.map((w, i) => [w, i]));
const neighbors = [
  [W.wave, W.sea],          // ocean
  [W.signal, W.ocean],      // wave
  [W.network, W.wave],      // signal
  [W.computer],             // network
  [W.keyboard, W.network],  // computer
  [W.computer],             // keyboard
  [W.ocean],                // sea
];
const dist = distancesToGoal(buildReverse(neighbors), words.length, W.computer);

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

test("closerSteps lists the valid steps that are one step nearer the goal", () => {
  assert.deepEqual(closerSteps(neighbors, dist, W.ocean), [W.wave]); // sea is farther
  assert.deepEqual(closerSteps(neighbors, dist, W.network), [W.computer]);
  assert.deepEqual(closerSteps(neighbors, dist, W.computer), []);    // already the goal
});

test("tier-1 hint text gives a count and a letter, not the distance", () => {
  const t1 = hintText(1, { current: "ocean", next: "wave", closer: 3, total: 20 });
  assert.equal(t1, "3 of 20 words from ocean get closer. One starts with “w”. (Hint again to reveal it.)");
  assert.ok(!/step/.test(t1)); // the path bars already show steps to go
  assert.match(hintText(1, { current: "ocean", next: "wave", closer: 1, total: 20 }),
    /^1 of 20 words from ocean gets closer\. It starts with “w”\./);
  assert.match(hintText(1, { current: "ocean", next: "sea", closer: 2, total: 20, nextIsCloser: false }),
    /A smoother step starts with “s”\./);
  assert.equal(hintText(2, { current: "ocean", next: "wave", closer: 3, total: 20 }), "Try “wave”.");
});

test("hint memory: tiers per word, and old saves upgrade without losing their hint", () => {
  const fresh = upgradeHintState({ path: ["ocean"], hints: 1, hintsAt: { ocean: 1 }, reveals: 0 });
  assert.equal(hintTier(fresh, "ocean"), 1);
  assert.equal(hintTier(fresh, "wave"), null);
  assert.equal(hintTier(fresh, "constructor"), null); // no prototype leaks

  const old = upgradeHintState({ path: ["ocean", "wave"], hints: 3,
    hint: { word: "wave", tier: 2, text: "Try “signal”." } });
  assert.deepEqual(old.hintsAt, { wave: 2 });
  assert.equal(old.reveals, 1);
  assert.equal(old.hints, 3);
  assert.ok(!("hint" in old));

  const oldNoHint = upgradeHintState({ path: ["ocean"], hints: 1, hint: null });
  assert.deepEqual(oldNoHint.hintsAt, {});
  assert.equal(oldNoHint.reveals, 0);
});
