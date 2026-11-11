// Parity test: js/seeded.js must reproduce the Python golden values exactly.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bfsRoutes, fnv1a32, gameNumber, levelBand, mulberry32, seedBase, seededPuzzle } from "../../js/seeded.js";

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

test("bfsRoutes on the tiny directed graph", () => {
  const nb = [[1, 2], [3], [3], [4], [0], [0]]; // same graph as tests/test_core.py
  assert.deepEqual(bfsRoutes(nb, 0, 3), { par: 2, routes: 2 });
  assert.deepEqual(bfsRoutes(nb, 1, 0), { par: 3, routes: 1 });
  assert.deepEqual(bfsRoutes(nb, 0, 5), { par: null, routes: 0 });
});

test("seeded puzzles and game numbers match Python for every fixture date and level", () => {
  const config = readJson("puzzle_config.json");
  const graph = readJson(`data/graph_v${config.graphVersion}.json`);
  const ladder = {
    index: new Map(graph.words.map((w, i) => [w, i])),
    neighbors: graph.neighbors,
    candidates: readJson(`data/candidates_v${config.graphVersion}.json`).words,
    config,
  };
  for (const p of fixture.puzzles) {
    const band = levelBand(p.level, config);
    assert.equal(gameNumber(p.date, config.launchDate), p.gameNumber, p.date);
    const got = seededPuzzle(ladder, seedBase(p.date, p.level), band);
    assert.deepEqual(
      [got.start, got.goal, got.par, got.routes, got.attempt],
      [p.start, p.goal, p.par, p.routes, p.attempt],
      `${p.date} ${p.level}`,
    );
  }
});
