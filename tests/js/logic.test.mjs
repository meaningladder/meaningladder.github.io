// Tests for js/logic.js (pure game rules). Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, buildReverse, computeStats, distancesToGoal, localDateStr, medalFor, oneEdit, resultMedal, scoreOf,
  shareText, squareFor, stairStep,
} from "../../js/logic.js";

test("stairStep: a red sliver at the start, a full green bar at the goal", () => {
  assert.deepEqual(stairStep(0, 5), { hue: 0, fill: 8 });
  assert.deepEqual(stairStep(5, 5), { hue: 130, fill: 100 });
  assert.deepEqual(stairStep(2, 4), { hue: 65, fill: 54 });
  assert.deepEqual(stairStep(-1, 4), stairStep(0, 4));    // below the start
  assert.deepEqual(stairStep(9, 4), stairStep(4, 4));     // never past the goal
  assert.deepEqual(stairStep(0, 0), { hue: 130, fill: 100 });
  for (const par of [3, 4, 5, 6, 7])  // every rung is greener and fuller than the one below
    for (let r = 1; r <= par; r++) {
      assert.ok(stairStep(r, par).hue > stairStep(r - 1, par).hue);
      assert.ok(stairStep(r, par).fill > stairStep(r - 1, par).fill);
    }
});

// ocean -> wave -> signal -> network -> computer, plus a shortcut and a dead end.
const words = ["ocean", "wave", "signal", "network", "computer", "keyboard", "sea"];
const W = Object.fromEntries(words.map((w, i) => [w, i]));
const neighbors = [
  [W.wave, W.sea],          // ocean
  [W.signal, W.ocean],      // wave
  [W.network, W.wave],      // signal
  [W.computer],             // network
  [W.keyboard, W.network],  // computer
  [W.computer],             // keyboard
  [W.ocean],                // sea (can only go back)
];
const ladder = { words, index: new Map(words.map((w, i) => [w, i])), neighbors };
const reverse = buildReverse(neighbors);
const dist = distancesToGoal(reverse, words.length, W.computer);

test("reverse BFS gives steps-to-goal for every word", () => {
  assert.equal(dist[W.computer], 0);
  assert.equal(dist[W.network], 1);
  assert.equal(dist[W.signal], 2);
  assert.equal(dist[W.ocean], 4);
  assert.equal(dist[W.sea], 5);      // sea -> ocean -> ...
  assert.equal(dist[W.keyboard], 1);  // keyboard -> computer
});

test("reverse adjacency lists who points to each word", () => {
  const into = (v) => [...reverse.edges.slice(reverse.offsets[v], reverse.offsets[v + 1])].sort();
  assert.deepEqual(into(W.computer), [W.network, W.keyboard].sort());
  assert.deepEqual(into(W.sea), [W.ocean]);
});

test("oneEdit covers Damerau-Levenshtein distance 1 only", () => {
  for (const [a, b] of [["coffe", "coffee"], ["coffee", "cofee"], ["cofefe", "coffee"], ["toffee", "coffee"], ["ab", "ba"]]) {
    assert.ok(oneEdit(a, b), `${a}/${b}`);
  }
  for (const [a, b] of [["coffee", "coffee"], ["cfoefe", "coffee"], ["tofee", "coffee"], ["abc", "cba"], ["ab", "abcd"]]) {
    assert.ok(!oneEdit(a, b), `${a}/${b}`);
  }
});

test("medals", () => {
  assert.equal(medalFor(4, 4).id, "gold");
  assert.equal(medalFor(5, 4).id, "silver");
  assert.equal(medalFor(6, 4).id, "bronze");
  assert.equal(medalFor(9, 4).id, "finished");
});

test("squares show the change in distance, not the distance", () => {
  assert.equal(squareFor(6, 5), "🟩"); // progress, even though still far away
  assert.equal(squareFor(3, 3), "🟨"); // no closer
  assert.equal(squareFor(2, 4), "🟥"); // farther
  assert.equal(squareFor(2, -1), "🟥"); // dead end
  assert.equal(squareFor(-1, 3), "🟩"); // back onto a route
  assert.equal(squareFor(1, 0), "✅"); // goal
});

test("share text: level, medal, moves/par, one square per step, no words", () => {
  const text = shareText({ label: "#13 Hard", moves: 7, par: 6, distances: [6, 5, 4, 4, 3, 2, 1, 0] });
  assert.equal(text, "Meaning Ladder #13 Hard 🥈 86 pts\n7 moves · par 6\n🟩🟩🟨🟩🟩🟩✅");
  assert.equal(shareText({ label: "#1 Easy", moves: 2, par: 2, distances: [2, 1, 0] }),
    "Meaning Ladder #1 Easy 🥇 100 pts\n2 moves · par 2\n🟩✅");
  assert.equal(shareText({ label: "#2 Medium", moves: 6, par: 3, distances: [3, 4, 2, 2, 1, -1, 0] }),
    "Meaning Ladder #2 Medium 🏁 50 pts\n6 moves · par 3\n🟥🟩🟨🟩🟥✅");
});

test("gave-up share has no medal and still reads clearly", () => {
  const text = shareText({ label: "#3 Hard", moves: 3, par: 3, distances: [3, 4, 4], gaveUp: true, url: "https://x.test/" });
  assert.equal(text, "Meaning Ladder #3 Hard\nGave up after 3 moves · par 3\n🟥🟨\nhttps://x.test/");
  // Giving up before any step: no empty squares line.
  assert.equal(shareText({ label: "#3 Hard", moves: 0, par: 3, distances: [3], gaveUp: true }),
    "Meaning Ladder #3 Hard\nGave up after 0 moves · par 3");
});

test("local dates and day arithmetic", () => {
  assert.equal(localDateStr(new Date(2026, 10, 16, 23, 59)), "2026-11-16"); // late evening stays local
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(addDays("2027-03-14", 1), "2027-03-15"); // across a DST change
});

test("stats and streaks", () => {
  const won = (d, steps = 4, playedOn = d) => ({ status: "won", steps, par: 3, hints: 0, playedOn });
  const results = {
    "2026-11-16": won("2026-11-16"),
    "2026-11-17": won("2026-11-17", 3),
    "2026-11-18": { status: "gaveUp", steps: 2, par: 3, hints: 0, playedOn: "2026-11-18" },
    "2026-11-19": won("2026-11-19"),
    "2026-11-20": won("2026-11-20", 5),
    "2026-11-21": won("2026-11-21", 3, "2026-11-25"), // archive play: doesn't extend streaks
  };
  const s = computeStats(results, "2026-11-21");
  assert.equal(s.played, 6);
  assert.equal(s.winPct, 83);
  assert.equal(s.currentStreak, 2);  // 19th + 20th (21st was played late)
  assert.equal(s.maxStreak, 2);
  assert.ok(Math.abs(s.avgOverPar - 0.8) < 1e-9); // (1+0+1+2+0)/5
  assert.equal(computeStats({}, "2026-11-21").avgOverPar, null);
});

// ------------------------------------------------------------ undos count as moves
import { movesOf } from "../../js/logic.js";

test("moves = steps + undos; old results without undos count 0", () => {
  assert.equal(movesOf({ steps: 4, undos: 1 }), 5);
  assert.equal(movesOf({ steps: 4 }), 4);              // saved before undos were tracked
  assert.equal(movesOf({ steps: 4, undos: null }), 4);
});

test("undoing a word costs a medal tier", () => {
  // The exploit: a par-length path reached by undoing two "no closer" words.
  assert.equal(medalFor(movesOf({ steps: 4, undos: 0 }), 4).id, "gold");
  assert.equal(medalFor(movesOf({ steps: 4, undos: 1 }), 4).id, "silver");
  assert.equal(medalFor(movesOf({ steps: 4, undos: 2 }), 4).id, "bronze");
  assert.equal(medalFor(movesOf({ steps: 5, undos: 3 }), 4).id, "finished");
  assert.equal(medalFor(movesOf({ steps: 4 }), 4).id, "gold"); // old saves keep their medal
});

test("one score: moves; old results keep the medal they were given", () => {
  // New results store moves (undone words and hints already inside).
  assert.equal(resultMedal({ status: "won", steps: 4, moves: 5, par: 4 }).id, "silver");
  assert.equal(scoreOf({ steps: 4, moves: 5, par: 4 }), 5);
  // Older results: steps + undos, and a revealed word capped gold at silver.
  assert.equal(resultMedal({ status: "won", steps: 4, undos: 1, par: 4 }).id, "silver");
  assert.equal(resultMedal({ status: "won", steps: 4, par: 4, reveals: 1 }).id, "silver");
  assert.equal(resultMedal({ status: "won", steps: 4, par: 4 }).id, "gold");
});

test("avg over par uses moves for new results, steps for old ones", () => {
  const results = {
    "2026-11-16:easy": { status: "won", steps: 3, par: 3, undos: 2, playedOn: "2026-11-16" }, // +2
    "2026-11-16:hard": { status: "won", steps: 4, par: 3, playedOn: "2026-11-16" },           // old: +1
    "2026-11-17:easy": { status: "won", steps: 3, par: 3, undos: 0, playedOn: "2026-11-17" }, // 0
  };
  assert.equal(computeStats(results, "2026-11-17").avgOverPar, 1);
});

// ------------------------------------------------------------ near-miss + ranks
import { rankFill, triedOrder } from "../../js/logic.js";

// Four words in 2-d: a=(1,0); b is near a; c is perpendicular; d is opposite.
const vec = (rows) => {
  const data = new Int8Array(rows.flat());
  const norms = new Float32Array(rows.map((r) => Math.hypot(...r)));
  return { data, dims: rows[0].length, count: rows.length, norms };
};

test("rank fills and tried-list order", () => {
  assert.equal(rankFill(1), 100);
  assert.ok(rankFill(101) > rankFill(1000) && rankFill(1000) > rankFill(15000));
  assert.ok(rankFill(20000) >= 4);
  const order = triedOrder([
    { word: "far", rank: 5000 }, { word: "fam", rank: null, family: true },
    { word: "near", rank: 120 }, { word: "loading", rank: null }, { word: "err", rank: "?" },
  ]).map((x) => x.word);
  assert.deepEqual(order, ["loading", "near", "far", "err", "fam"]);
});

test("streak counts days, not levels: any solved level keeps it alive", () => {
  const won = (playedOn, steps = 3, par = 3) => ({ status: "won", steps, par, hints: 0, playedOn });
  const results = {
    "2026-11-20:easy": won("2026-11-20"),
    "2026-11-20:hard": won("2026-11-20", 6, 4),
    "2026-11-21:medium": won("2026-11-21"),
    "2026-11-22:hard": { status: "gaveUp", steps: 1, par: 4, hints: 0, playedOn: "2026-11-22" },
    "2026-11-22:easy": won("2026-11-22"),
  };
  const s = computeStats(results, "2026-11-22");
  assert.equal(s.currentStreak, 3);           // 20, 21, 22 (two levels on the 20th count once)
  assert.equal(s.maxStreak, 3);
  assert.equal(s.played, 5);
  assert.equal(s.winPct, 80);
  assert.deepEqual(s.solvedByLevel, { easy: 2, medium: 1, hard: 1 });
});

test("rules views: a cut step limit drops far neighbors and keeps their exact ranks", async () => {
  const { ladderAt, ladderFor } = await import("../../js/data.js");
  // hub's list: 30 words, most similar first. Top 20 = w(0)..w(19).
  const abc = "abcdefghijklmnopqrstuvwxyz";
  const w = (i) => `w${abc[Math.floor(i / 26)]}${abc[i % 26]}`; // words must be letters only
  const names = ["hub", ...Array.from({ length: 30 }, (_, i) => w(i))];
  const nbrs = names.map(() => [0]);
  nbrs[0] = names.slice(1).map((_, i) => i + 1);
  const base = {
    words: names, index: new Map(names.map((w, i) => [w, i])), neighbors: nbrs, candidates: names,
    views: new Map(),
    config: { launchDate: "2026-11-01", rules: [
      { from: "2026-11-01", stepLimit: 100, minPar: 1, maxPar: 6, levels: {} },
      { from: "2026-11-13", stepLimit: 20, minPar: 1, maxPar: 6, levels: {} }] },
  };
  const oldRules = ladderAt(base, "2026-11-12"), newRules = ladderAt(base, "2026-11-13");
  assert.equal(ladderAt(base, "2026-11-20"), newRules); // cached per era
  assert.ok(oldRules.neighbors[0].includes(25));  // w(24), hub's #25
  assert.ok(!newRules.neighbors[0].includes(25) && newRules.neighbors[0].includes(20));
  // #25 is cut from the legal steps but still in the stored list: exact rank.
  assert.equal(newRules.fullNeighbors[0].indexOf(25) + 1, 25);
  // Which rules a puzzle gets: by date; Unlimited by its stamp; old saves = top 100.
  assert.equal(ladderFor(base, { date: "2026-11-05" }).config.stepLimit, 100);
  assert.equal(ladderFor(base, { date: "2026-11-14", stepLimit: 20 }).config.stepLimit, 20);
  assert.equal(ladderFor(base, { date: null, stepLimit: 20 }).config.stepLimit, 20);
  assert.equal(ladderFor(base, { date: null }).config.stepLimit, 100);
});

test("rules views: an era's excludeCandidates file shrinks the start/goal pool, older eras keep it", async () => {
  const { ladderAt } = await import("../../js/data.js");
  const { excludedWords } = await import("../../js/seeded.js");
  const words = ["apple", "billy", "behind", "volcano"];
  const path = "data/candidates_exclude_test.json";
  const file = { from: "2026-11-13", categories: { name_neighbors: ["billy"], function: ["behind"] } };
  const base = {
    words, index: new Map(words.map((w, i) => [w, i])), neighbors: words.map(() => [0]),
    candidates: words, exclusions: new Map([[path, excludedWords(file)]]), views: new Map(),
    config: { launchDate: "2026-11-01", rules: [
      { from: "2026-11-01", stepLimit: 100, minPar: 1, maxPar: 6, levels: {} },
      { from: "2026-11-13", stepLimit: 20, minPar: 1, maxPar: 6, levels: {}, excludeCandidates: path }] },
  };
  assert.deepEqual(ladderAt(base, "2026-11-12").candidates, words);
  assert.deepEqual(ladderAt(base, "2026-11-13").candidates, ["apple", "volcano"]); // order kept
  assert.deepEqual(ladderAt(base, null).candidates, ["apple", "volcano"]); // Unlimited
  assert.equal(ladderAt(base, "2026-11-13").index.get("billy"), 1); // still on the map
});

test("the real exclusion file covers the reported words and only drops real candidates", async () => {
  const { readFileSync } = await import("node:fs");
  const { excludedWords, rulesFor } = await import("../../js/seeded.js");
  const root = new URL("../../", import.meta.url);
  const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
  const config = read("puzzle_config.json");
  // One set of rules for every day since 2026-11-16, Nov 1-12 included.
  assert.equal(rulesFor(config, "2026-11-12").excludeCandidates, rulesFor(config, "2026-11-13").excludeCandidates);
  const path = rulesFor(config, "2026-11-13").excludeCandidates;
  const excluded = excludedWords(read(path));
  const cands = new Set(read(`data/candidates_v${config.graphVersion}.json`).words);
  for (const w of ["batman", "billy", "bobby", "ben", "amir", "ayatollah", "afghan", "argentine",
    "behind", "bolster", "bore", "wing", "jam"]) assert.ok(excluded.has(w), w);
  for (const w of excluded) assert.ok(cands.has(w), `${w} is not a candidate`);
});

import { pointsFor, resultPoints } from "../../js/logic.js";
test("pointsFor", () => {
  for (const [m, p, want] of [[4, 4, 100], [5, 4, 80], [6, 4, 67], [8, 4, 50], [3, 4, 100], [0, 4, 0]]) {
    assert.equal(pointsFor(m, p), want);
  }
});
test("resultPoints works for old results", () => {
  assert.equal(resultPoints({ status: "won", steps: 5, undos: 1, par: 4 }), 67);
  assert.equal(resultPoints({ status: "gaveUp", moves: 9, par: 4 }), 0);
});
test("avgPointsByLevel counts give-ups as 0", () => {
  const s = computeStats({
    "2026-11-20:easy": { status: "won", moves: 4, par: 4, playedOn: "2026-11-20" },
    "2026-11-19:easy": { status: "gaveUp", moves: 9, par: 4 },
  }, "2026-11-20");
  assert.deepEqual(s.avgPointsByLevel, { easy: 50, medium: null, hard: null });
});
