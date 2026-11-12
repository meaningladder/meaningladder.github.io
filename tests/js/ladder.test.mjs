// Tests for ladderRows (js/logic.js): which word sits on which rung.
// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReverse, distancesToGoal, guideRoute, ladderRows } from "../../js/logic.js";

// rows as "rung:at" strings, top to bottom (at = path index, "-" = empty).
const shape = (lad) => lad.rows.map((r) => `${r.rung}:${r.at ?? "-"}${r.current ? "*" : ""}`);

test("a straight climb: one rung per good word", () => {
  const lad = ladderRows([4, 3, 2], 4);
  assert.deepEqual(shape(lad), ["4:-", "3:-", "2:2*", "1:1", "0:0"]);
  assert.equal(lad.climber, 2);
  assert.equal(lad.below, null);
  assert.equal(lad.off, null);
});

test("a word that's no closer takes over the same rung", () => {
  const lad = ladderRows([4, 3, 3], 4);
  assert.deepEqual(shape(lad), ["4:-", "3:-", "2:-", "1:2*", "0:0"]);
  assert.equal(lad.climber, 1);
});

test("a farther word drops you; the higher rung keeps its word", () => {
  const lad = ladderRows([4, 3, 4], 4);
  assert.deepEqual(shape(lad), ["4:-", "3:-", "2:-", "1:1", "0:2*"]);
  assert.equal(lad.climber, 0);
});

test("farther than the start: below the ladder", () => {
  const lad = ladderRows([3, 4], 3);
  assert.equal(lad.climber, "below");
  assert.equal(lad.below, 1);
  assert.ok(lad.rows.every((r) => !r.current));
});

test("no route: off the ladder", () => {
  const lad = ladderRows([3, 2, -1], 3);
  assert.equal(lad.climber, "off");
  assert.equal(lad.off, 2);
  assert.deepEqual(shape(lad), ["3:-", "2:-", "1:1", "0:0"]);
});

test("a win puts you on the goal rung", () => {
  const lad = ladderRows([3, 2, 1, 0], 3);
  assert.deepEqual(shape(lad), ["3:3*", "2:2", "1:1", "0:0"]);
  assert.equal(lad.climber, 3);
});

test("the ladder always has par + 1 rungs (par 7 included, par 0 guarded)", () => {
  assert.equal(ladderRows([7], 7).rows.length, 8);
  assert.equal(ladderRows([0], 0).rows.length, 2);
});

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

