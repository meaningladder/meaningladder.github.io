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
const ladder = { index: new Map(words.map((w, i) => [w, i])), neighbors };
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

// ------------------------------------------------------------ near-miss feedback
import { nearMiss, nearMissText } from "../../js/logic.js";

test("nearMiss measures how far a rejected word really is", () => {
  assert.deepEqual(nearMiss(ladder, W.signal, W.computer), { steps: 2, oneWay: false });
  assert.deepEqual(nearMiss(ladder, W.wave, W.computer), { steps: 3, oneWay: false });
  assert.deepEqual(nearMiss(ladder, W.ocean, W.keyboard), { steps: null, oneWay: false }); // 5 away
});

test("nearMiss spots one-way links (pitfall #1)", () => {
  // signal lists network, but network doesn't list signal.
  assert.equal(nearMiss(ladder, W.network, W.signal).oneWay, true);
});

test("checkStep attaches near-miss info only to neighbor rejections", () => {
  const res = checkStep(ladder, ["ocean", "wave", "signal"], "computer");
  assert.equal(res.error, "computer isn't a neighbor of signal. Try another word.");
  assert.deepEqual(res.nearMiss, { steps: 2, oneWay: false });
  assert.equal(checkStep(ladder, ["ocean"], "zzzz").nearMiss, undefined);
});

test("nearMissText copy: four cases, no dashes, never names a third word", () => {
  const cases = [
    [{ steps: 2, oneWay: false }, "close", "Close!"],
    [{ steps: 3, oneWay: false }, "warm", "Warm."],
    [{ steps: null, oneWay: false }, "far", "Far."],
    [{ steps: null, oneWay: true }, "close", "So close:"],
  ];
  for (const [miss, tone, keyword] of cases) {
    const m = nearMissText(miss, "signal", "keyboard");
    assert.equal(m.tone, tone);
    assert.equal(m.keyword, keyword);
    assert.doesNotMatch(m.keyword + m.text, /[–—]/);
    const named = (m.keyword + " " + m.text).toLowerCase().match(/[a-z]+/g)
      .filter((w) => words.includes(w));
    assert.ok(named.every((w) => w === "signal" || w === "keyboard"), named.join());
  }
});
