// Parity test: js/seeded.js must reproduce the Python golden values exactly.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bfsRouteStats, bfsRoutes, candidatePool, closerFits, closerFirstMoves, cutNeighbors, excludedWords, twoWayNeighbors, fnv1a32, gameNumber, inDegrees, levelBand, mulberry32, rulesFor, seedBase, seededPuzzle } from "../../js/seeded.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(root + p, "utf8"));
const fixture = readJson("tests/fixtures/seeded_vectors.json");

test("fnv1a32 matches Python", () => {
  for (const [text, h] of Object.entries(fixture.fnv1a32)) assert.equal(fnv1a32(text), h, text);
});

test("mulberry32 matches Python", () => {
  for (const [seed, values] of Object.entries(fixture.mulberry32)) {
    const r = mulberry32(Number(seed));
    assert.deepEqual(values.map(() => r()), values, `seed ${seed}`);
  }
});

test("mulberry32 equals the canonical published version", () => {
  // The widely copied original, verbatim. Ours must give identical output.
  function canonical(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (const seed of [0, 1, 42, 123456789]) {
    const ours = mulberry32(seed), theirs = canonical(seed);
    for (let i = 0; i < 1000; i++) assert.equal(ours(), theirs());
  }
});

test("rulesFor picks each date's era, like Python's rules_for", () => {
  const config = readJson("puzzle_config.json");
  assert.equal(rulesFor(config, "2026-11-01").stepLimit, 100);
  assert.equal(rulesFor(config, "2026-11-12").stepLimit, 100);
  assert.equal(rulesFor(config, "2026-11-13").stepLimit, 15);
  assert.equal(rulesFor(config, "2026-11-13").twoWay, true);
  assert.equal(rulesFor(config, "2026-11-12").twoWay, undefined); // older days stay one-way
  assert.equal(rulesFor(config, null).stepLimit, 15); // Unlimited: newest rules
  assert.deepEqual(rulesFor(config, "2026-11-13").levels.hard.par, 5);
  assert.equal(rulesFor(config, "2026-11-12").levels.hard.minCloserFirstMoves, undefined);
  assert.equal(rulesFor(config, "2026-11-13").rules, undefined);
  assert.deepEqual(cutNeighbors([[3, 1, 2], [0]], 2), [[3, 1], [0]]);
});

test("bfsRoutes on the tiny directed graph", () => {
  const nb = [[1, 2], [3], [3], [4], [0], [0]]; // same graph as tests/test_core.py
  assert.deepEqual(bfsRoutes(nb, 0, 3), { par: 2, routes: 2 });
  assert.deepEqual(bfsRoutes(nb, 1, 0), { par: 3, routes: 1 });
  assert.deepEqual(bfsRoutes(nb, 0, 5), { par: null, routes: 0 });
});

test("bfsRouteStats counts first moves that begin a shortest route, like Python", () => {
  const nb = [[1, 2], [3], [3], [4], [0], [0]];
  assert.deepEqual(bfsRouteStats(nb, 0, 4), { par: 3, routes: 2, closer: 2 });
  assert.deepEqual(bfsRouteStats(nb, 0, 1), { par: 1, routes: 1, closer: 1 });
  assert.deepEqual(bfsRouteStats([[1, 2, 3], [3], [3], [4], [0], [0]], 0, 4), { par: 2, routes: 1, closer: 1 });
  assert.deepEqual(bfsRouteStats(nb, 0, 5), { par: null, routes: 0, closer: 0 });
  // The seeded loop caps depth at the band's par; a farther goal reads as "no fit".
  assert.deepEqual(bfsRouteStats(nb, 0, 4, 3), { par: 3, routes: 2, closer: 2 });
  assert.deepEqual(bfsRouteStats(nb, 0, 4, 2), { par: null, routes: 0, closer: 0 });
  // Bit 30 is the last tracked move; it must not go negative and miscount.
  const wide = [Array.from({ length: 31 }, (_, i) => i + 1), ...Array.from({ length: 31 }, () => [32]), []];
  assert.deepEqual(bfsRouteStats(wide, 0, 32), { par: 2, routes: 31, closer: 31 });
  assert.ok(closerFits({ minCloserFirstMoves: 1, maxCloserFirstMoves: 2 }, 2));
  assert.ok(!closerFits({ minCloserFirstMoves: 3 }, 2));
  assert.ok(closerFits({}, 0));
});

test("seeded puzzles and game numbers match Python for every fixture date and level", () => {
  const config = readJson("puzzle_config.json");
  const graph = readJson(`data/graph_v${config.graphVersion}.json`);
  const index = new Map(graph.words.map((w, i) => [w, i]));
  const candidates = readJson(`data/candidates_v${config.graphVersion}.json`).words;
  const cut = new Map(); // one cut graph per step limit
  for (const p of fixture.puzzles) {
    const rules = rulesFor(config, p.date);
    assert.equal(rules.stepLimit, p.stepLimit, `${p.date} step limit`);
    const key = `${rules.stepLimit}|${Boolean(rules.twoWay)}`;
    if (!cut.has(key)) cut.set(key, rules.twoWay ? twoWayNeighbors(graph.neighbors, rules.stepLimit)
      : cutNeighbors(graph.neighbors, rules.stepLimit));
    // Same pool rule as js/data.js viewOf and Python's ladder_view.
    const pool = rules.excludeCandidates
      ? candidatePool(candidates, excludedWords(readJson(rules.excludeCandidates)))
      : candidates;
    const ladder = { index, neighbors: cut.get(key), candidates: pool, config: rules };
    const band = levelBand(p.level, rules);
    assert.equal(gameNumber(p.date, config.launchDate), p.gameNumber, p.date);
    const got = seededPuzzle(ladder, seedBase(p.date, p.level), band);
    assert.deepEqual(
      [got.start, got.goal, got.par, got.routes, got.closer, got.attempt],
      [p.start, p.goal, p.par, p.routes, p.closer, p.attempt],
      `${p.date} ${p.level}`,
    );
  }
});

test("inDegrees counts legal steps into each word, and seededPuzzle skips thin goals", () => {
  const nb = [[1, 2], [3], [3], [4], [0], [0]]; // same graph as tests/test_core.py
  assert.deepEqual([...inDegrees(nb)], [2, 1, 1, 2, 1, 0]);
  const words = ["a", "b", "c", "d", "e", "f"];
  const ladder = (extra) => ({
    index: new Map(words.map((w, i) => [w, i])), neighbors: nb, candidates: words,
    config: { minPar: 1, maxPar: 6, ...extra },
  });
  const band = { par: 3, minRoutes: 1, maxRoutes: 100 };
  // Only a and d have 2 links in; every other par-3 goal (b, c, e) has 1.
  for (const seed of ["t", "u", "v", "w"]) {
    assert.ok(["a", "d"].includes(seededPuzzle(ladder({ minGoalInDegree: 2 }), seed, band).goal));
    // A view's precomputed count is used as is (data.js builds one per view).
    const view = { ...ladder({ minGoalInDegree: 2 }), inDegree: Int32Array.from([0, 9, 9, 0, 9, 9]) };
    assert.ok(["b", "c", "e"].includes(seededPuzzle(view, seed, band).goal));
  }
  // No field (older eras): no check, same as Python.
  assert.equal(seededPuzzle(ladder({}), "t", band).par, 3);
});

test("two-way links: own top k first, then reverse links by the rank they give", () => {
  // 0's top 1 is 1; 2 lists 0 first; 3 lists 0 second.
  const full = [[1, 2], [2, 0], [0, 1], [1, 0]];
  assert.deepEqual(twoWayNeighbors(full, 1), [[1, 2], [2, 0, 3], [0, 1], [1]]);
  // Undirected: every link runs both ways.
  const nb = twoWayNeighbors(full, 2);
  nb.forEach((row, u) => row.forEach((v) => assert.ok(nb[v].includes(u), `${u}-${v}`)));
});

test("closerFirstMoves counts the start's neighbors one step nearer the goal", () => {
  const nb = twoWayNeighbors([[1, 2], [3], [3], [], [0]], 2); // 0-1, 0-2, 1-3, 2-3, 0-4
  assert.equal(closerFirstMoves(nb, 0, 3, 2), 2); // via 1 and via 2
  assert.equal(closerFirstMoves(nb, 4, 3, 3), 1); // only via 0
});

