// Tests for the distances, guide route and stored route (js/logic.js).
// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReverse, checkedRoute, distancesToGoal, guideRoute } from "../../js/logic.js";

test("what the ladder assumes: a step gets at most one step closer, and no route stays no route", () => {
  // a -> b -> c -> d, with a shortcut-free side branch and a dead end.
  const neighbors = [[1, 4], [2, 0], [3, 1], [], [0, 5], [5]];
  const reverse = buildReverse(neighbors);
  const dist = distancesToGoal(reverse, neighbors.length, 3);
  neighbors.forEach((row, u) => row.forEach((v) => {
    if (dist[u] >= 0 && dist[v] >= 0) assert.ok(dist[v] >= dist[u] - 1, `${u}->${v}`);
    if (dist[u] < 0) assert.ok(dist[v] < 0, `${u}->${v} escapes a dead end`);
  }));
});

test("guideRoute keeps par and takes the route with the most relation steps", () => {
  // Two shortest routes 0 -> 3: via 1 (first neighbor) or via 2. Only 0-2 and 2-3 are relations.
  const neighbors = [[1, 2], [0, 3], [0, 3], [1, 2]];
  const dist = distancesToGoal(buildReverse(neighbors), 4, 3);
  const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  assert.deepEqual(guideRoute(neighbors, dist, new Set([key(0, 2), key(2, 3)]), 0), [0, 2, 3]);
  assert.deepEqual(guideRoute(neighbors, dist, new Set(), 0), [0, 1, 3]); // tie: more similar first
  assert.equal(guideRoute(neighbors, dist, null, 0), null); // no relations loaded
});

test("a puzzle file's route is used only while it is a real shortest route", () => {
  const words = ["a", "b", "c", "d"];
  const neighbors = [[1, 2], [0, 3], [0, 3], [1, 2]];
  const ladder = { index: new Map(words.map((w, i) => [w, i])), neighbors };
  const dist = distancesToGoal(buildReverse(neighbors), 4, 3);
  const puzzle = { start: "a", goal: "d", par: 2 };
  assert.deepEqual(checkedRoute(["a", "c", "d"], puzzle, ladder, dist), [0, 2, 3]);
  assert.equal(checkedRoute(["a", "d"], puzzle, ladder, dist), null);           // wrong length
  assert.equal(checkedRoute(["a", "b", "c"], puzzle, ladder, dist), null);      // wrong goal
  assert.equal(checkedRoute(["a", "zz", "d"], puzzle, ladder, dist), null);     // unknown word
  assert.equal(checkedRoute(undefined, puzzle, ladder, dist), null);            // old files
  const longer = { start: "a", goal: "d", par: 3 };
  assert.equal(checkedRoute(["a", "b", "a", "d"], longer, ladder, dist), null); // not shortest
});
