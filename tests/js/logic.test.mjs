// Tests for js/logic.js (pure game rules). Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, buildReverse, checkStep, closeness, computeStats, costsToGoal, distancesToGoal,
  localDateStr, medalFor, naturalRoute, shareText, shortestRoute, STEP_COST,
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

test("reverse adjacency remembers each edge's rank in the source list", () => {
  for (let v = 0; v < words.length; v++) {
    for (let k = reverse.offsets[v]; k < reverse.offsets[v + 1]; k++) {
      const u = reverse.edges[k];
      assert.equal(neighbors[u][reverse.ranks[k] - 1], v);
    }
  }
});

// Bellman-Ford: slow but obviously correct, to check the heap-based Dijkstra.
function bruteCosts(nbrs, goal) {
  const c = new Array(nbrs.length).fill(Infinity);
  c[goal] = 0;
  for (let round = 0; round < nbrs.length; round++) {
    nbrs.forEach((row, u) => row.forEach((v, r) => { c[u] = Math.min(c[u], r + 1 + STEP_COST + c[v]); }));
  }
  return c;
}

test("costsToGoal matches a brute-force shortest-cost search", () => {
  for (let goal = 0; goal < words.length; goal++) {
    assert.deepEqual([...costsToGoal(reverse, words.length, goal)], bruteCosts(neighbors, goal));
  }
});

test("naturalRoute takes the shortest route when it is also the gentlest", () => {
  const cost = costsToGoal(reverse, words.length, W.computer);
  assert.deepEqual(naturalRoute(neighbors, cost, W.ocean).map((i) => words[i]),
    ["ocean", "wave", "signal", "network", "computer"]);
  const toSea = costsToGoal(reverse, words.length, W.sea);
  assert.equal(naturalRoute(neighbors, toSea, W.computer), null); // can't get back to sea
});

test("naturalRoute avoids a wild leap even when it costs extra steps", () => {
  // start's 90th-closest word is the goal (a 1-step but awkward leap);
  // start -> near -> nearer -> goal uses only #1 steps.
  const names = ["start", "near", "nearer", "goal", ...Array.from({ length: 88 }, (_, i) => `filler${i}`)];
  const N = Object.fromEntries(names.map((w, i) => [w, i]));
  const fillers = names.slice(4).map((w) => N[w]);
  const nbrs = names.map(() => [N.start]); // fillers are dead ends back to start
  nbrs[N.start] = [N.near, ...fillers, N.goal];
  nbrs[N.near] = [N.nearer];
  nbrs[N.nearer] = [N.goal];
  nbrs[N.goal] = [N.start];
  assert.equal(nbrs[N.start].indexOf(N.goal) + 1, 90);
  const rev = buildReverse(nbrs);
  assert.equal(distancesToGoal(rev, names.length, N.goal)[N.start], 1); // par is still 1
  const route = naturalRoute(nbrs, costsToGoal(rev, names.length, N.goal), N.start);
  assert.deepEqual(route.map((i) => names[i]), ["start", "near", "nearer", "goal"]);
  route.slice(1).forEach((v, i) => assert.ok(nbrs[route[i]].includes(v), "every step is a real neighbor"));
});

test("checkStep names the step limit from the ladder's rules", () => {
  const limited = { ...ladder, config: { stepLimit: 20 } };
  assert.equal(checkStep(limited, ["ocean", "wave", "signal"], "keyboard").error,
    "keyboard isn't one of signal's 20 closest words.");
});

test("shortestRoute takes par steps even when the gentlest route is longer", () => {
  // Same graph as above: start -> goal directly (#90), or 3 gentle #1 steps.
  const names = ["start", "near", "nearer", "goal", ...Array.from({ length: 88 }, (_, i) => `filler${i}`)];
  const N = Object.fromEntries(names.map((w, i) => [w, i]));
  const fillers = names.slice(4).map((w) => N[w]);
  const nbrs = names.map(() => [N.start]);
  nbrs[N.start] = [N.near, ...fillers, N.goal];
  nbrs[N.near] = [N.nearer];
  nbrs[N.nearer] = [N.goal];
  nbrs[N.goal] = [N.start];
  const rev = buildReverse(nbrs);
  const d = distancesToGoal(rev, names.length, N.goal);
  const c = costsToGoal(rev, names.length, N.goal);
  assert.deepEqual(shortestRoute(nbrs, d, c, N.start).map((i) => names[i]), ["start", "goal"]);
  assert.equal(naturalRoute(nbrs, c, N.start).length, 4); // the gentle one differs
});

test("shortestRoute follows par on the small graph and reports dead ends", () => {
  const c = costsToGoal(reverse, words.length, W.computer);
  const route = shortestRoute(neighbors, dist, c, W.sea);
  assert.equal(route.length - 1, dist[W.sea]);
  assert.deepEqual(route.map((i) => words[i]), ["sea", "ocean", "wave", "signal", "network", "computer"]);
  const toSea = distancesToGoal(reverse, words.length, W.sea);
  assert.equal(shortestRoute(neighbors, toSea, costsToGoal(reverse, words.length, W.sea), W.computer), null);
});

test("checkStep accepts neighbors and explains every rejection", () => {
  const path = ["ocean", "wave", "signal"];
  assert.deepEqual(checkStep(ladder, path, "  Network "), { ok: true, word: "network" });
  assert.equal(checkStep(ladder, path, "keyboard").error, "keyboard isn't one of signal's 100 closest words.");
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

// ------------------------------------------------------------ undos count as moves
import { movesOf, movesText } from "../../js/logic.js";

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

test("moves text spells out undos only when there are some", () => {
  assert.equal(movesText(4, 0), "4 steps");
  assert.equal(movesText(1), "1 step");
  assert.equal(movesText(4, 1), "5 moves (4 steps + 1 undo)");
  assert.equal(movesText(1, 2), "3 moves (1 step + 2 undos)");
});

test("share text includes undos", () => {
  assert.equal(shareText({ label: "#12", steps: 4, par: 4, undos: 1, distances: [3, 2, 1, 0] }),
    "Meaning Ladder #12 — 5 moves (4 steps + 1 undo) (par 4) 🟥🟨🟩✅");
  assert.equal(shareText({ label: "#3", steps: 1, par: 3, undos: 2, distances: [4], gaveUp: true }),
    "Meaning Ladder #3 — gave up after 3 moves (1 step + 2 undos) (par 3) 🟥");
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
import {
  displayRank, nearMiss, nearMissText, rankFill, rankOf, rankTone, sameFamily, scoresFrom, triedOrder,
} from "../../js/logic.js";

test("nearMiss spots one-way links (pitfall #1)", () => {
  // signal lists network, but network doesn't list signal.
  assert.equal(nearMiss(ladder, W.network, W.signal).oneWay, true);
  assert.equal(nearMiss(ladder, W.ocean, W.keyboard).oneWay, false);
  assert.match(nearMissText({ oneWay: true }, "network", "signal").text, /signal isn't one of network's closest/);
  assert.equal(nearMissText({ oneWay: true }, "network", "signal").keyword, "One-way:");
  assert.equal(nearMissText({ oneWay: false }, "network", "signal"), null);
});

test("checkStep attaches near-miss info only to neighbor rejections", () => {
  const res = checkStep(ladder, ["ocean", "wave", "signal"], "computer");
  assert.equal(res.error, "computer isn't one of signal's 100 closest words.");
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
  assert.deepEqual([50, 101, 300, 301, 2000, 2001].map((r) => rankTone(r)), ["near", "mid", "mid", "far", "far", "cold"]);
  // Top-20 rules: #21 is already a miss, and reads as very close.
  assert.deepEqual([20, 21, 99].map((r) => rankTone(r, 20)), ["near", "mid", "mid"]);
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

test("rules views: a cut step limit rejects far neighbors and ranks them exactly", async () => {
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
  assert.deepEqual(checkStep(oldRules, ["hub"], w(24)), { ok: true, word: w(24) });
  assert.match(checkStep(newRules, ["hub"], w(24)).error, /isn't one of hub's 20 closest words/);
  assert.deepEqual(checkStep(newRules, ["hub"], w(19)), { ok: true, word: w(19) });
  // #25 is cut from the legal steps but still in the stored list: exact rank.
  assert.deepEqual(displayRank(newRules, 0, 25, 999), { rank: 25, family: false });
  // Which rules a puzzle gets: by date; Unlimited by its stamp; old saves = top 100.
  assert.equal(ladderFor(base, { date: "2026-11-05" }).config.stepLimit, 100);
  assert.equal(ladderFor(base, { date: "2026-11-14", stepLimit: 20 }).config.stepLimit, 20);
  assert.equal(ladderFor(base, { date: null, stepLimit: 20 }).config.stepLimit, 20);
  assert.equal(ladderFor(base, { date: null }).config.stepLimit, 100);
});
