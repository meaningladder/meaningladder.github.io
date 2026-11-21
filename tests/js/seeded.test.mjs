// Parity test: js/seeded.js must reproduce the Python golden values exactly.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { puzzleFile } from "../../js/seeded.js";
import { bfsAll, bfsRouteStats, bfsRoutes, candidatePool, closerFits, closerFirstMoves, cutNeighbors, dropSteps, excludedWords, twoWayNeighbors, fnv1a32, gameNumber, inDegrees, INFORMATIVE, levelBand, linkedFrom, linkedSteps, mulberry32, relKey, rulesFor, seedBase, seededLinkedPuzzle, seededPuzzle } from "../../js/seeded.js";

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
  // One set of rules for every day since 2026-11-16 (Nov 1-12 were top 100).
  for (const d of ["2026-11-01", "2026-11-12", "2026-11-13", null]) {
    assert.equal(rulesFor(config, d).stepLimit, 10);
    assert.equal(rulesFor(config, d).twoWay, true);
    assert.equal(rulesFor(config, d).levels.hard.par, 5);
  }
  assert.equal(rulesFor(config, "2026-11-13").rules, undefined);
  assert.deepEqual(cutNeighbors([[3, 1, 2], [0]], 2), [[3, 1], [0]]);
  // removedSteps: no step to or from the word; other lists keep their order.
  assert.deepEqual(dropSteps([[1, 2], [0, 2], [1, 0]], new Set([1])), [[2], [], [0]]);
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

// The newest rules' ladder, built the way js/data.js builds a view, with
// the informative links (ladder.linked) read from the config's relations file.
function liveLadder(dateStr) {
  const config = readJson("puzzle_config.json");
  const graph = readJson(`data/graph_v${config.graphVersion}.json`);
  const index = new Map(graph.words.map((w, i) => [w, i]));
  const candidates = readJson(`data/candidates_v${config.graphVersion}.json`).words;
  const removed = config.removedSteps ? excludedWords(readJson(config.removedSteps)) : new Set();
  const rules = rulesFor(config, dateStr);
  const gone = new Set([...removed].map((w) => index.get(w)));
  const neighbors = dropSteps(twoWayNeighbors(graph.neighbors, rules.stepLimit), gone);
  const excluded = new Set([...(rules.excludeCandidates ? excludedWords(readJson(rules.excludeCandidates)) : []), ...removed]);
  const relHead = readJson(`data/relations_v${config.relations}.json`);
  const relBin = readFileSync(root + `data/relations_v${config.relations}.bin`);
  const n = relHead.count, linked = new Set();
  for (let i = 0; i < n; i++) {
    if (INFORMATIVE.has(relHead.relations[relBin[4 * n + i]])) linked.add(relKey(relBin.readUInt16LE(4 * i), relBin.readUInt16LE(4 * i + 2)));
  }
  return { config, ladder: { words: graph.words, index, neighbors, candidates: candidatePool(candidates, excluded), config: rules, linked } };
}
const live = liveLadder(null);

test("seeded linked puzzles and game numbers match Python for every fixture seed", () => {
  const { config } = live;
  for (const p of fixture.puzzles) {
    const rules = rulesFor(config, p.date);
    assert.equal(rules.stepLimit, p.stepLimit, `${p.date} step limit`);
    assert.deepEqual(rules, live.ladder.config, "one era: the fixture dates share the live view");
    assert.equal(gameNumber(p.date, config.launchDate), p.gameNumber, p.date);
    const got = seededLinkedPuzzle(live.ladder, seedBase(p.date, p.level), levelBand(p.level, rules));
    assert.deepEqual(got, { start: p.start, goal: p.goal, par: p.par, routes: p.routes }, `${p.date} ${p.level}`);
  }
});

test("seededLinkedPuzzle: every level has 2+ linked steps, Hard in under 1 s", () => {
  const { ladder } = live;
  for (const level of ["easy", "medium", "hard"]) {
    const band = levelBand(level, ladder.config);
    const t0 = performance.now();
    const got = seededLinkedPuzzle(ladder, `speed-${level}`, band);
    const ms = performance.now() - t0;
    if (level === "hard") assert.ok(ms < 1000, `Hard took ${ms.toFixed(0)} ms`);
    const [s, g] = [ladder.index.get(got.start), ladder.index.get(got.goal)];
    assert.equal(got.par, band.par);
    assert.ok(linkedSteps(ladder.neighbors, ladder.linked, s, g, got.par) >= 2, level);
    // linkedFrom (all goals) agrees with linkedSteps (one goal).
    const { dist } = bfsAll(ladder.neighbors, s, got.par);
    assert.equal(linkedFrom(ladder.neighbors, ladder.linked, s, dist)[g], linkedSteps(ladder.neighbors, ladder.linked, s, g, got.par));
  }
  assert.throws(() => seededLinkedPuzzle(ladder, "x", { ...levelBand("easy", ladder.config), maxRoutes: 0 }), /no linked puzzle/);
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


test("a day's puzzle file is puzzles/<date>-<level>.json", () => {
  assert.equal(puzzleFile("2026-11-12", "easy"), "puzzles/2026-11-12-easy.json");
  assert.equal(puzzleFile("2026-11-13", "hard"), "puzzles/2026-11-13-hard.json");
});

test("an open game saved on Nov 13 or 14 keeps the top-10 two-way steps it was made with", async () => {
  // A player who started one keeps it (game:<date>:<level> holds the puzzle);
  // ladderFor rebuilds its rules from the date's era and the file's
  // stepLimit/twoWay, which must give the same legal steps.
  const { ladderFor } = await import("../../js/data.js");
  const config = readJson("puzzle_config.json");
  const graph = readJson(`data/graph_v${config.graphVersion}.json`);
  const path = rulesFor(config, "2026-11-13").excludeCandidates;
  const base = {
    words: graph.words, index: new Map(graph.words.map((w, i) => [w, i])), neighbors: graph.neighbors,
    complete: true, candidates: readJson(`data/candidates_v${config.graphVersion}.json`).words,
    exclusions: new Map([[path, excludedWords(readJson(path))]]), config, views: new Map(),
    removed: config.removedSteps ? excludedWords(readJson(config.removedSteps)) : new Set(),
  };
  const openTop10 = dropSteps(twoWayNeighbors(graph.neighbors, 10),
    new Set([...base.removed].map((w) => base.index.get(w))));
  let checked = 0;
  for (const date of ["2026-11-13", "2026-11-14"]) {
    for (const level of ["easy", "medium", "hard"]) {
      let p;
      try { p = readJson(`puzzles/${date}-${level}.json`); } catch { continue; }
      assert.equal(p.mode, undefined, `${date} ${level}: opens in the open-ladder view`);
      const view = ladderFor(base, p);
      assert.equal(view.config.stepLimit, 10);
      assert.equal(view.config.twoWay, true);
      if (!checked) assert.deepEqual(view.neighbors, openTop10);
      assert.equal(view.neighbors, ladderFor(base, { ...p, level: "easy" }).neighbors); // one cached view
      assert.ok(view.index.has(p.start) && view.index.has(p.goal));
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test("levelAcceptRules: config levels without accept fields get the defaults, fields override one by one", async () => {
  const { levelAcceptRules } = await import("../../js/seeded.js");
  assert.deepEqual(levelAcceptRules({ levels: { easy: { label: "Easy", par: 3 } } }, "easy"),
    { acceptStart: 40, acceptStep: 5, label: "Easy", par: 3 });
  const r = levelAcceptRules({ levels: { hard: { acceptStart: 22 } } }, "hard");
  assert.equal(r.acceptStart, 22);
  assert.equal(r.acceptStep, 4);
  assert.equal(levelAcceptRules({}, "medium").acceptStart, 35);
});
