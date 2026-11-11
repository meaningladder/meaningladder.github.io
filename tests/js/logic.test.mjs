// Tests for js/logic.js (pure game rules). Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, buildReverse, checkStep, closeness, computeStats, distancesToGoal,
  localDateStr, medalFor, routeToGoal, shareText,
} from "../../js/logic.js";

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

test("routeToGoal follows one shortest route", () => {
  assert.deepEqual(routeToGoal(neighbors, dist, W.ocean).map((i) => words[i]),
    ["ocean", "wave", "signal", "network", "computer"]);
});

test("checkStep accepts neighbors and explains every rejection", () => {
  const path = ["ocean", "wave", "signal"];
  assert.deepEqual(checkStep(ladder, path, "  Network "), { ok: true, word: "network" });
  assert.equal(checkStep(ladder, path, "keyboard").error, "keyboard isn't a neighbor of signal. Try another word.");
  assert.match(checkStep(ladder, path, "zzzz").error, /don't know/);
  assert.match(checkStep(ladder, path, "signal").error, /already on/);
  assert.match(checkStep(ladder, path, "wave").error, /already in your path/);
  assert.match(checkStep(ladder, path, "").error, /Type a word/);
  assert.match(checkStep(ladder, path, "c3po").error, /Letters only/);
});

test("checkStep respects direction (pitfall #1)", () => {
  // network -> computer is allowed, but computer -> signal is not, even though
  // signal -> network -> computer exists.
  assert.ok(checkStep(ladder, ["network"], "computer").ok);
  assert.equal(checkStep(ladder, ["computer"], "signal").ok, false);
});

test("medals", () => {
  assert.equal(medalFor(4, 4).id, "gold");
  assert.equal(medalFor(5, 4).id, "silver");
  assert.equal(medalFor(6, 4).id, "bronze");
  assert.equal(medalFor(9, 4).id, "finished");
});

test("closeness colors: 1 green, 2 yellow, 3+ pink, goal full", () => {
  assert.deepEqual(closeness(0), { tone: "goal", fill: 100 });
  assert.equal(closeness(1).tone, "near");
  assert.equal(closeness(2).tone, "mid");
  assert.equal(closeness(3).tone, "far");
  assert.ok(closeness(1).fill > closeness(2).fill && closeness(2).fill > closeness(5).fill);
  assert.equal(closeness(-1).tone, "far");
});

test("share text matches the spec format and has no words in it", () => {
  const text = shareText({ label: "#12", steps: 5, par: 4, distances: [3, 2, 2, 1, 0] });
  assert.equal(text, "Meaning Ladder #12 — 5 steps (par 4) 🟥🟨🟨🟩✅");
  const withHints = shareText({ label: "#3", steps: 1, par: 3, distances: [4], gaveUp: true, hints: 2, url: "https://x.test/" });
  assert.equal(withHints, "Meaning Ladder #3 — gave up after 1 step (par 3) 🟥 · 💡2\nhttps://x.test/");
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

// ------------------------------------------------------------ near-miss + ranks
import {
  displayRank, nearMiss, nearMissText, rankFill, rankOf, rankTone, sameFamily, scoresFrom, triedOrder,
} from "../../js/logic.js";

test("nearMiss spots one-way links (pitfall #1)", () => {
  // signal lists network, but network doesn't list signal.
  assert.equal(nearMiss(ladder, W.network, W.signal).oneWay, true);
  assert.equal(nearMiss(ladder, W.ocean, W.keyboard).oneWay, false);
  assert.match(nearMissText({ oneWay: true }, "network", "signal").text, /other way/);
  assert.equal(nearMissText({ oneWay: false }, "network", "signal"), null);
});

test("checkStep attaches near-miss info only to neighbor rejections", () => {
  const res = checkStep(ladder, ["ocean", "wave", "signal"], "computer");
  assert.equal(res.error, "computer isn't a neighbor of signal. Try another word.");
  assert.deepEqual(res.nearMiss, { oneWay: false });
  assert.equal(checkStep(ladder, ["ocean"], "zzzz").nearMiss, undefined);
});

// Four words in 2-d: a=(1,0); b is near a; c is perpendicular; d is opposite.
const vec = (rows) => {
  const data = new Int8Array(rows.flat());
  const norms = new Float32Array(rows.map((r) => Math.hypot(...r)));
  return { data, dims: rows[0].length, count: rows.length, norms };
};

test("scoresFrom + rankOf rank every word by cosine", () => {
  const v = vec([[100, 0], [90, 20], [0, 100], [-100, 0]]);
  const scores = scoresFrom(v, 0);
  assert.ok(Math.abs(scores[0] - 1) < 1e-6);
  assert.equal(rankOf(scores, 0, 1), 1); // closest other word
  assert.equal(rankOf(scores, 0, 2), 2);
  assert.equal(rankOf(scores, 0, 3), 3); // the opposite word is last
});

test("displayRank never shows a non-neighbor inside the top 100", () => {
  assert.deepEqual(displayRank(ladder, W.signal, W.network, 7), { rank: 1, family: false }); // exact graph position
  assert.deepEqual(displayRank(ladder, W.signal, W.computer, 12), { rank: 101, family: false });
  assert.deepEqual(displayRank(ladder, W.signal, W.computer, 4567), { rank: 4567, family: false });
});

test("sameFamily mirrors the Python prefix rule", () => {
  assert.ok(sameFamily("volcano", "volcanic"));
  assert.ok(sameFamily("music", "musical"));
  assert.ok(sameFamily("computer", "computing"));
  assert.ok(!sameFamily("car", "cart"));
  assert.ok(!sameFamily("planet", "plantation"));
});

test("rank tones, fills and tried-list order", () => {
  assert.deepEqual([50, 101, 300, 301, 2000, 2001].map(rankTone), ["near", "mid", "mid", "far", "far", "cold"]);
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
