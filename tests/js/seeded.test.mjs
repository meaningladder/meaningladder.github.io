// Parity test: js/seeded.js must reproduce the Python golden values exactly.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainReason, chainReasons, patternRivals, puzzleFile, sameStem, seededChain } from "../../js/seeded.js";
import { bfsRouteStats, bfsRoutes, candidatePool, closerFits, closerFirstMoves, cutNeighbors, excludedWords, twoWayNeighbors, fnv1a32, gameNumber, inDegrees, levelBand, mulberry32, relKey, rulesFor, seedBase, seededPuzzle } from "../../js/seeded.js";

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
  assert.equal(rulesFor(config, "2026-11-13").stepLimit, 10);
  assert.equal(rulesFor(config, "2026-11-13").twoWay, true);
  assert.equal(rulesFor(config, "2026-11-12").twoWay, undefined); // older days stay one-way
  assert.equal(rulesFor(config, null).stepLimit, 10); // Unlimited: newest rules
  assert.equal(rulesFor(config, "2026-11-12").mode, undefined); // open ladders
  assert.equal(rulesFor(config, "2026-11-13").mode, "chain"); // chains from today on
  assert.equal(rulesFor(config, "2026-11-15").mode, undefined); // open ladders again
  assert.equal(rulesFor(config, null).mode, undefined); // Unlimited follows the newest era
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
  // ConceptNet pairs, read the way js/data.js reads them (newer eras need them).
  const relHead = readJson(`data/relations_v${config.graphVersion}.json`);
  const relBin = readFileSync(root + `data/relations_v${config.graphVersion}.bin`);
  const related = new Set();
  for (let i = 0; i < relHead.count; i++) related.add(relKey(relBin.readUInt16LE(4 * i), relBin.readUInt16LE(4 * i + 2)));
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
    const ladder = { index, neighbors: cut.get(key), candidates: pool, config: rules, related };
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


test("seeded chains match Python for every chain fixture date and level", () => {
  const config = readJson("puzzle_config.json");
  const graph = readJson(`data/graph_v${config.graphVersion}.json`);
  const index = new Map(graph.words.map((w, i) => [w, i]));
  const candidates = readJson(`data/candidates_v${config.graphVersion}.json`).words;
  // Relations with their names, read the way js/data.js reads them.
  const relHead = readJson(`data/relations_v${config.graphVersion}.json`);
  const relBin = readFileSync(root + `data/relations_v${config.graphVersion}.bin`);
  const related = new Map();
  for (let i = 0; i < relHead.count; i++) {
    related.set(relKey(relBin.readUInt16LE(4 * i), relBin.readUInt16LE(4 * i + 2)), relHead.relations[relBin[4 * relHead.count + i]]);
  }
  // The browser's lists stop at 40; the chain rules never look further.
  const head = graph.neighbors.map((row) => row.slice(0, 40));
  const views = new Map();
  assert.ok(fixture.chains.length >= 6); // 3 levels x Nov 13-14
  for (const c of fixture.chains) {
    const rules = rulesFor(config, c.date);
    assert.equal(rules.mode, "chain", c.date);
    if (!views.has(rules.from)) {
      const pool = candidatePool(candidates, excludedWords(readJson(rules.excludeCandidates)));
      views.set(rules.from, { words: graph.words, index, neighbors: head, fullNeighbors: head, candidates: pool, config: rules, related });
    }
    const ladder = views.get(rules.from);
    const band = levelBand(c.level, rules);
    const got = seededChain(ladder, seedBase(c.date, c.level), band);
    assert.deepEqual([got.route, got.linked, got.attempt], [c.route, c.linked, c.attempt], `${c.date} ${c.level}`);
    assert.deepEqual(chainReasons(ladder, got.route), c.reasons);
    assert.equal(gameNumber(c.date, config.launchDate), c.gameNumber);
  }
});

test("pattern rivals: a second close word with the same first letter and length", () => {
  const words = ["sea", "ship", "shop", "port", "boat"];
  const nb = [[1, 2, 4], [0, 3], [0], [1], [0]];
  const ladder = { words, index: new Map(words.map((w, i) => [w, i])), neighbors: nb, config: {} };
  assert.deepEqual(patternRivals(ladder, 0, 1, new Set()), [2]);
  assert.deepEqual(patternRivals(ladder, 0, 1, new Set([2])), []);
  assert.deepEqual(patternRivals(ladder, 0, 4, new Set()), []);
  assert.ok(sameStem("ship", "ships") && sameStem("swim", "swimming"));
  assert.ok(!sameStem("sea", "seal") && !sameStem("ship", "shop"));
  assert.equal(chainReason("cafe", "restaurant", "IsA"), "Cafe and restaurant: one is a kind of the other.");
  assert.equal(chainReason("box", "corner", undefined), "Box and corner: they often go together.");
});

test("chain days load their own file name; open days keep the old one", () => {
  const config = readJson("puzzle_config.json");
  const file = (d, lv) => puzzleFile(d, lv, rulesFor(config, d));
  assert.equal(file("2026-11-12", "easy"), "puzzles/2026-11-12-easy.json");
  assert.equal(file("2026-11-13", "hard"), "puzzles/2026-11-13-hard.chain.json");
  assert.equal(file("2026-11-14", "medium"), "puzzles/2026-11-14-medium.chain.json");
  assert.equal(file("2026-11-15", "easy"), "puzzles/2026-11-15-easy.json"); // open again
  assert.equal(file("2027-01-01", "easy"), "puzzles/2027-01-01-easy.json");
  assert.equal(puzzleFile("2026-11-13", "easy", null), "puzzles/2026-11-13-easy.json");
});

test("an open game saved on Nov 13 or 14 keeps the top-10 two-way steps it was made with", async () => {
  // Those days had open-ladder files before the chain era moved up to Nov 13.
  // A player who started one keeps it (game:<date>:<level> holds the puzzle);
  // ladderFor rebuilds its rules from the date's era (now chain) and the file's
  // stepLimit/twoWay, which must give the same legal steps.
  const { ladderFor } = await import("../../js/data.js");
  const config = readJson("puzzle_config.json");
  const graph = readJson(`data/graph_v${config.graphVersion}.json`);
  const path = rulesFor(config, "2026-11-13").excludeCandidates;
  const base = {
    words: graph.words, index: new Map(graph.words.map((w, i) => [w, i])), neighbors: graph.neighbors,
    complete: true, candidates: readJson(`data/candidates_v${config.graphVersion}.json`).words,
    exclusions: new Map([[path, excludedWords(readJson(path))]]), config, views: new Map(),
  };
  const openTop10 = twoWayNeighbors(graph.neighbors, 10);
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
