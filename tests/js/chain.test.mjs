// Strict Unlimited (chain mode): one hidden answer per rung, one letter shown.
// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainPuzzle, ladderAt } from "../../js/data.js";
import { buildReverse, chainHint, chainLetters, chainStart, chainSubmit, distancesToGoal } from "../../js/logic.js";
import { excludedWords, informativeKeys, relKey } from "../../js/seeded.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(root + p, "utf8"));

// The newest rules' view of the real word map, built the way js/data.js does.
function realLadder() {
  const config = readJson("puzzle_config.json");
  const v = config.graphVersion;
  const graph = readJson(`data/graph_v${v}.json`);
  const relHead = readJson(`data/relations_v${config.relations}.json`);
  const relBin = readFileSync(root + `data/relations_v${config.relations}.bin`);
  const n = relHead.count, related = new Map(); // direction left out: only the relation names matter here
  for (let i = 0; i < n; i++) related.set(relKey(relBin.readUInt16LE(4 * i), relBin.readUInt16LE(4 * i + 2)), { rel: relHead.relations[relBin[4 * n + i]] });
  const paths = [...new Set(config.rules.map((e) => e.excludeCandidates).filter(Boolean))];
  const base = {
    words: graph.words, index: new Map(graph.words.map((w, i) => [w, i])), neighbors: graph.neighbors,
    complete: true, candidates: readJson(`data/candidates_v${v}.json`).words,
    exclusions: new Map(paths.map((p) => [p, excludedWords(readJson(p))])), config, related, linked: informativeKeys(related), views: new Map(),
    removed: config.removedSteps ? excludedWords(readJson(config.removedSteps)) : new Set(),
  };
  return ladderAt(base, null);
}
const ladder = realLadder();
const made = Object.fromEntries(["easy", "medium", "hard"].map((lv) => [lv, chainPuzzle(ladder, lv, 12345)]));

test("Easy/Medium/Hard chains hide 2/3/3 words, each step legal and one rung closer", () => {
  for (const [lv, hidden] of [["easy", 2], ["medium", 3], ["hard", 3]]) {
    const p = made[lv];
    assert.equal(p.mode, "chain");
    assert.equal(p.route.length, hidden + 2, lv);
    assert.equal(p.par, hidden + 1, lv);
    assert.equal(p.shown.length, hidden, lv);
    assert.equal(p.route[0], p.start);
    assert.equal(p.route.at(-1), p.goal);
    const idx = p.route.map((w) => ladder.index.get(w));
    const dist = distancesToGoal(buildReverse(ladder.neighbors), ladder.words.length, idx.at(-1));
    for (let k = 0; k + 1 < idx.length; k++) {
      assert.ok(ladder.neighbors[idx[k]].includes(idx[k + 1]), `${lv}: ${p.route[k]} -> ${p.route[k + 1]}`);
      assert.equal(dist[idx[k + 1]], dist[idx[k]] - 1, `${lv}: one rung closer`);
    }
  }
});

test("every shown letter matches its hidden word, and hints cover the other positions", () => {
  for (const p of Object.values(made)) {
    p.shown.forEach(({ pos, letter }, k) => {
      const word = p.route[k + 1];
      assert.equal(word[pos], letter);
      assert.deepEqual([pos, ...p.hintOrder[k]].sort((a, b) => a - b), [...word].map((_, i) => i));
    });
  }
});

test("a fixed seed makes the same chain", () => {
  assert.deepEqual(chainPuzzle(ladder, "medium", 12345), made.medium);
  assert.notDeepEqual(chainPuzzle(ladder, "medium", 777).route, made.medium.route);
});

// A tiny hand-made chain: jeep -> truck -> tanker -> port.
const words = ["jeep", "truck", "tanker", "port", "ship", "tinker", "trucks"];
const tiny = { words, index: new Map(words.map((w, i) => [w, i])), neighbors: words.map(() => []) };
const puzzle = {
  start: "jeep", goal: "port", par: 3, mode: "chain", route: ["jeep", "truck", "tanker", "port"],
  shown: [{ pos: 0, letter: "t" }, { pos: 2, letter: "n" }], hintOrder: [[3, 1, 4, 2], [0, 5, 1, 3, 4]],
};

test("only the hidden word (or its plural/singular) is played; another real word costs a move", () => {
  const s = chainStart(puzzle);
  const wrong = chainSubmit(tiny, s, "ship");
  assert.equal(wrong.wrong, true);
  assert.deepEqual([s.path, s.moves], [["jeep"], 1]);
  // Typos, unknown words and repeats are free.
  assert.equal(chainSubmit(tiny, s, "zzzz").ok, false);
  assert.equal(chainSubmit(tiny, s, "jeep").ok, false);
  assert.equal(chainSubmit(tiny, s, "").ok, false);
  assert.equal(s.moves, 1);
  const plural = chainSubmit(tiny, s, " Trucks ");
  assert.equal(plural.ok, true);
  assert.equal(plural.note, "Counted as truck.");
  assert.deepEqual([s.path, s.moves], [["jeep", "truck"], 2]);
  assert.equal(chainSubmit(tiny, s, "tinker").wrong, true); // one letter off, but a real word
  // The last hidden word leads to the goal, which costs its move like daily's autoGoal.
  assert.equal(chainSubmit(tiny, s, "tanker").ok, true);
  assert.deepEqual([s.path, s.moves, s.status], [["jeep", "truck", "tanker", "port"], 5, "won"]);
});

test("a hint shows one more letter and costs a move; the last one plays the word", () => {
  const s = chainStart(puzzle);
  assert.deepEqual(chainLetters(s, 0), [0]);
  chainHint(s);
  assert.deepEqual(chainLetters(s, 0), [0, 3]);
  assert.deepEqual([s.moves, s.hints, s.path.length], [1, 1, 1]);
  chainHint(s);
  chainHint(s);
  assert.deepEqual([s.path, s.moves], [["jeep"], 3]);
  chainHint(s); // fills the last blank: the word is played, no extra move for it
  assert.deepEqual([s.path, s.moves, s.hints], [["jeep", "truck"], 4, 4]);
  assert.deepEqual(chainLetters(s, 1), [2]); // the next word starts with only its shown letter
});

test("guessing the same wrong word again is free", () => {
  const s = chainStart(puzzle);
  assert.equal(chainSubmit(tiny, s, "ship").wrong, true);
  const again = chainSubmit(tiny, s, " SHIP");
  assert.deepEqual([again.ok, again.wrong, again.error], [false, undefined, "Already tried ship."]);
  assert.equal(s.moves, 1);
  assert.deepEqual(s.rungs[0].misses.map((m) => m.word), ["ship"]);
});

test("a typo never gets the hidden word as its suggestion; suggestions come from the current word", () => {
  const w = ["jeep", "truck", "tanker", "port", "dart", "part", "trucks"];
  const nb = [[1, 4], [], [], [5], [], [], []]; // jeep: truck, dart; port (the goal): part
  const lad = { words: w, index: new Map(w.map((x, i) => [x, i])), neighbors: nb };
  const s = chainStart(puzzle);
  const typo = chainSubmit(lad, s, "truk"); // one letter off the answer
  assert.equal(typo.ok, false);
  assert.doesNotMatch(typo.error, /truck/);
  assert.equal(chainSubmit(lad, s, "bart").error, "Did you mean dart?"); // jeep's neighbor, not port's
  assert.equal(s.moves, 0);
});
