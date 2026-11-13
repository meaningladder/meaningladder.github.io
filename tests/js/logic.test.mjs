// Tests for js/logic.js (pure game rules). Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, autoGoal, bottleneckRoute, buildReverse, GENTLE_RANK, worstRank, checkStep, closeness, computeStats, costsToGoal, distancesToGoal, formOf, oneEdit,
  hintStep, localDateStr, medalFor, naturalRoute, resultMedal, scoreOf, shareText, shortestRoute, squareFor, STEP_COST, upgradeMoves,
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

// A padded graph where each list puts chosen words at chosen ranks; every
// other slot is a filler word that only leads back to start (a dead end).
function rankedGraph(names, links) {
  const all = [...names, ...Array.from({ length: 100 }, (_, i) => `filler${i}`)];
  const N = Object.fromEntries(all.map((w, i) => [w, i]));
  const fillers = all.slice(names.length).map((w) => N[w]);
  const nbrs = all.map(() => [N.start]);
  for (const [u, ranked] of Object.entries(links)) {
    const row = fillers.slice(0, 50);
    // Insert lowest rank first so later inserts don't shift earlier ones.
    for (const [v, rank] of Object.entries(ranked).sort((x, y) => x[1] - y[1])) row.splice(rank - 1, 0, N[v]);
    nbrs[N[u]] = row;
  }
  const dist = distancesToGoal(buildReverse(nbrs), all.length, N.goal);
  return { all, N, nbrs, dist, words: (r) => r.map((i) => all[i]) };
}

test("bottleneckRoute picks the par route whose worst link is best", () => {
  // Two 2-step routes: via "a" (#1 then #35, cheaper in total) and via "b"
  // (#20 then #20, weakest link only #20). Sum-based routing prefers "a".
  const g = rankedGraph(["start", "a", "b", "goal"], {
    start: { a: 1, b: 20 }, a: { goal: 35 }, b: { goal: 20 }, goal: {},
  });
  assert.deepEqual(g.words(shortestRoute(g.nbrs, g.dist, costsToGoal(buildReverse(g.nbrs), g.all.length, g.N.goal), g.N.start)),
    ["start", "a", "goal"]);
  const best = bottleneckRoute(g.nbrs, g.dist, g.N.start);
  assert.deepEqual(g.words(best.route), ["start", "b", "goal"]);
  assert.equal(best.worst, 20);
  assert.equal(worstRank(g.nbrs, best.route), 20);
});

test("bottleneckRoute breaks worst-link ties by total gentleness", () => {
  // Both routes' worst link is #10; via "a" the other step is #1, via "b" #9.
  const g = rankedGraph(["start", "a", "b", "goal"], {
    start: { a: 10, b: 9 }, a: { goal: 1 }, b: { goal: 10 }, goal: {},
  });
  const best = bottleneckRoute(g.nbrs, g.dist, g.N.start);
  assert.equal(best.worst, 10);
  assert.deepEqual(g.words(best.route), ["start", "a", "goal"]);
});

test("bottleneckRoute with one spare step finds a friendlier longer route", () => {
  // Par 2 needs a #40 link; the 3-step route via c1, c2 stays within #2.
  const g = rankedGraph(["start", "a", "c1", "c2", "goal"], {
    start: { a: 1, c1: 2 }, a: { goal: 40 }, c1: { c2: 1 }, c2: { goal: 1 }, goal: {},
  });
  assert.equal(g.dist[g.N.start], 2);
  const par = bottleneckRoute(g.nbrs, g.dist, g.N.start);
  assert.equal(par.worst, 40);
  assert.ok(par.worst > GENTLE_RANK);
  const plus = bottleneckRoute(g.nbrs, g.dist, g.N.start, 3);
  assert.deepEqual(g.words(plus.route), ["start", "c1", "c2", "goal"]);
  assert.equal(plus.worst, 2);
  plus.route.slice(1).forEach((v, i) => assert.ok(g.nbrs[plus.route[i]].includes(v), "every step is a real neighbor"));
});

test("bottleneckRoute handles the goal itself, dead ends and too-small budgets", () => {
  const toComputer = distancesToGoal(reverse, words.length, W.computer);
  assert.deepEqual(bottleneckRoute(neighbors, toComputer, W.computer), { route: [W.computer], worst: 0 });
  assert.deepEqual(bottleneckRoute(neighbors, toComputer, W.sea).route.map((i) => words[i]),
    ["sea", "ocean", "wave", "signal", "network", "computer"]);
  assert.equal(bottleneckRoute(neighbors, toComputer, W.sea, 4), null); // par is 5
  const toSea = distancesToGoal(reverse, words.length, W.sea);
  assert.equal(bottleneckRoute(neighbors, toSea, W.computer), null); // unreachable
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

test("following every hint gets one step closer each time and finishes at par", () => {
  // start -> mid -> goal is par 2, but mid is start's 50th-closest word.
  // The gentle way starts with start's #1 word "side", which is FARTHER
  // (side -> a -> b -> goal is 3 steps), so naturalRoute's first step is
  // exactly the kind of hint the game would tag "farther".
  const names = ["start", "side", "a", "b", "mid", "goal", ...Array.from({ length: 48 }, (_, i) => `filler${i}`)];
  const N = Object.fromEntries(names.map((w, i) => [w, i]));
  const fillers = names.slice(6).map((w) => N[w]);
  const nbrs = names.map(() => [N.start]); // fillers are dead ends back to start
  nbrs[N.start] = [N.side, ...fillers, N.mid];
  nbrs[N.side] = [N.a];
  nbrs[N.a] = [N.b];
  nbrs[N.b] = [N.goal];
  nbrs[N.mid] = [N.goal];
  nbrs[N.goal] = [N.start];
  assert.equal(nbrs[N.start].indexOf(N.mid) + 1, 50);
  const rev = buildReverse(nbrs);
  const d = distancesToGoal(rev, names.length, N.goal);
  const c = costsToGoal(rev, names.length, N.goal);
  assert.equal(d[N.start], 2);
  // The premise: the gentle route's first step is farther from the goal.
  const gentle = naturalRoute(nbrs, c, N.start);
  assert.equal(names[gentle[1]], "side");
  assert.ok(d[gentle[1]] > d[N.start]);
  // Hints: every step is a real neighbor exactly one step closer.
  const path = [N.start];
  while (path.at(-1) !== N.goal) {
    const cur = path.at(-1);
    const next = hintStep(nbrs, d, c, cur);
    assert.ok(nbrs[cur].includes(next), "a hint is a legal step");
    assert.equal(d[next], d[cur] - 1, `hint from ${names[cur]} gets exactly one step closer`);
    path.push(next);
  }
  assert.deepEqual(path.map((i) => names[i]), ["start", "mid", "goal"]);
  assert.equal(path.length - 1, d[N.start]); // all hints = par = gold
  // The small graph too: from every word that can reach the goal.
  const c2 = costsToGoal(reverse, words.length, W.computer);
  for (let w = 0; w < words.length; w++) {
    if (dist[w] <= 0) continue;
    assert.equal(dist[hintStep(neighbors, dist, c2, w)], dist[w] - 1);
  }
  assert.equal(hintStep(neighbors, dist, c2, W.computer), -1); // already there
  const toSea = distancesToGoal(reverse, words.length, W.sea);
  assert.equal(hintStep(neighbors, toSea, costsToGoal(reverse, words.length, W.sea), W.computer), -1);
});

test("checkStep accepts neighbors and explains every rejection", () => {
  const path = ["ocean", "wave", "signal"];
  assert.deepEqual(checkStep(ladder, path, "  Network "), { ok: true, word: "network" });
  assert.equal(checkStep(ladder, path, "keyboard").error, "keyboard isn't one of signal's 100 closest words.");
  assert.equal(checkStep(ladder, path, "zzzz").error, "zzzz isn't in our 7-word list. Try a more common word.");
  assert.match(checkStep(ladder, path, "signal").error, /already on/);
  assert.match(checkStep(ladder, path, "wave").error, /already in your path/);
  assert.match(checkStep(ladder, path, "").error, /Type a word/);
  assert.match(checkStep(ladder, path, "c3po").error, /Letters only/);
});

test("checkStep suggests a one-edit fix for typos, preferring legal steps", () => {
  const path = ["ocean", "wave", "signal"];
  // transposition, deletion, insertion
  assert.deepEqual(checkStep(ladder, path, "ntework"), { ok: false, error: "Did you mean network?", suggestion: "network" });
  // Off the legal steps, a different first letter is no typo: "cave" is not "wave".
  assert.equal(checkStep(ladder, ["ocean", "wave", "signal", "network"], "cave").suggestion, undefined);
  assert.equal(checkStep(ladder, path, "netwrk").suggestion, "network");
  // A plural of a legal step is no typo now: it counts as the singular.
  assert.deepEqual(checkStep(ladder, path, "networks"), { ok: true, word: "network", note: "Counted as network." });  assert.equal(checkStep(ladder, path, "keybaord").suggestion, "keyboard"); // not a legal step, still a word
  assert.equal(checkStep(ladder, path, "waev").suggestion, undefined);      // wave is already in the path
  // Two candidates one edit away: the legal neighbor beats the more common word.
  const ws = ["cat", "cot", "dog"];
  const tiny = { words: ws, index: new Map(ws.map((w, i) => [w, i])), neighbors: [[2], [], [1]] };
  assert.equal(checkStep(tiny, ["dog"], "cct").suggestion, "cot");
  assert.equal(checkStep(tiny, ["cat"], "cct").suggestion, "cot"); // cat itself is skipped
  assert.equal(checkStep(tiny, ["cot"], "cct").suggestion, "cat"); // no legal match: most common word
  const big = { ...tiny, words: Array.from({ length: 20000 }, (_, i) => (i < 3 ? ws[i] : `w${i}`)) };
  assert.equal(checkStep(big, ["dog"], "kitten").error, "kitten isn't in our 20,000-word list. Try a more common word.");
});

test("oneEdit covers Damerau-Levenshtein distance 1 only", () => {
  for (const [a, b] of [["coffe", "coffee"], ["coffee", "cofee"], ["cofefe", "coffee"], ["toffee", "coffee"], ["ab", "ba"]]) {
    assert.ok(oneEdit(a, b), `${a}/${b}`);
  }
  for (const [a, b] of [["coffee", "coffee"], ["cfoefe", "coffee"], ["tofee", "coffee"], ["abc", "cba"], ["ab", "abcd"]]) {
    assert.ok(!oneEdit(a, b), `${a}/${b}`);
  }
});

test("a form of the goal counts as the goal when that step is legal", () => {
  const ws = ["forest", "tree", "trees", "branch", "key", "keys", "lock"];
  const I = Object.fromEntries(ws.map((w, i) => [w, i]));
  const nb = ws.map(() => []);
  nb[I.forest] = [I.trees, I.tree, I.branch];
  nb[I.branch] = [I.trees];
  nb[I.lock] = [I.key];
  const g = { words: ws, index: new Map(ws.map((w, i) => [w, i])), neighbors: nb };
  assert.deepEqual(checkStep(g, ["forest"], "Trees", "tree"), { ok: true, word: "tree", note: "Counted as tree." });
  assert.equal(checkStep(g, ["branch"], "trees", "tree").error,
    "trees is a form of the goal tree: you'll need to reach tree itself.");
  assert.deepEqual(checkStep(g, ["lock"], "keys", "key"), { ok: true, word: "key", note: "Counted as key." });
  assert.deepEqual(checkStep(g, ["forest"], "tree", "tree"), { ok: true, word: "tree" }); // the goal itself: no note
  assert.deepEqual(checkStep(g, ["forest"], "trees"), { ok: true, word: "trees" });       // no goal given: old behavior
});

test("a plural counts as its singular when the singular is the legal step", () => {
  const ws = ["sea", "ship", "ships", "box", "crate", "glass", "cup", "tow", "tower", "rope"];
  const I = Object.fromEntries(ws.map((w, i) => [w, i]));
  const nb = ws.map(() => []);
  nb[I.sea] = [I.ship];
  nb[I.crate] = [I.box];
  nb[I.cup] = [I.glass];
  nb[I.rope] = [I.tow];
  const g = { words: ws, index: new Map(ws.map((w, i) => [w, i])), neighbors: nb };
  const counted = (w) => ({ ok: true, word: w, note: `Counted as ${w}.` });
  assert.deepEqual(checkStep(g, ["sea"], "Ships"), counted("ship"));      // in the list, but not a legal step
  assert.deepEqual(checkStep(g, ["crate"], "boxes"), counted("box"));     // not in the list at all
  assert.deepEqual(checkStep(g, ["cup"], "glasses"), counted("glass"));
  assert.deepEqual(checkStep(g, ["sea"], "ship"), { ok: true, word: "ship" }); // the singular itself: no note
  // Only plural endings: "tower" is a word of its own, not a form of "tow".
  assert.match(checkStep(g, ["rope"], "tower").error, /isn't one of rope's/);
  // The singular must still be a fresh step.
  assert.match(checkStep(g, ["sea", "ship", "crate"], "ships").error, /isn't one of crate's/);
  assert.match(checkStep(g, ["box", "crate"], "boxes").error, /isn't in our 10-word list/);
  // Forms of the goal keep their own rule.
  assert.match(checkStep(g, ["crate"], "ships", "ship").error, /form of the goal ship/);
});

test("autoGoal: the ladder finishes itself once the goal is a legal step", () => {
  assert.equal(autoGoal(ladder, "network", "computer"), true);
  assert.equal(autoGoal(ladder, "keyboard", "computer"), true);
  assert.equal(autoGoal(ladder, "signal", "computer"), false);  // two steps away
  assert.equal(autoGoal(ladder, "computer", "network"), true);   // computer lists network
  assert.equal(autoGoal(ladder, "network", "signal"), false);    // edges are one-way
  assert.equal(autoGoal(ladder, "computer", "computer"), false); // already there
  assert.equal(autoGoal(ladder, "zzzz", "computer"), false);
});

test("formOf spots regular inflections and long shared prefixes", () => {
  for (const [a, b] of [["trees", "tree"], ["key", "keys"], ["cities", "city"], ["boxes", "box"], ["running", "run"],
    ["baked", "bake"], ["bigger", "big"], ["women", "woman"], ["musical", "music"]]) {
    assert.ok(formOf(a, b), `${a}/${b}`);
  }
  for (const [a, b] of [["tree", "tree"], ["bed", "be"], ["trees", "forest"], ["king", "kin"], ["cat", "cast"]]) {
    assert.ok(!formOf(a, b), `${a}/${b}`);
  }
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
  assert.equal(text, "Meaning Ladder #13 Hard 🥈\n7 moves · par 6\n🟩🟩🟨🟩🟩🟩✅");
  assert.equal(shareText({ label: "#1 Easy", moves: 2, par: 2, distances: [2, 1, 0] }),
    "Meaning Ladder #1 Easy 🥇\n2 moves · par 2\n🟩✅");
  assert.equal(shareText({ label: "#2 Medium", moves: 6, par: 3, distances: [3, 4, 2, 2, 1, -1, 0] }),
    "Meaning Ladder #2 Medium 🏁\n6 moves · par 3\n🟥🟩🟨🟩🟥✅");
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

test("one score: moves; old results keep the medal they were given", () => {
  // New results store moves (undone words and hints already inside).
  assert.equal(resultMedal({ status: "won", steps: 4, moves: 5, par: 4 }).id, "silver");
  assert.equal(scoreOf({ steps: 4, moves: 5, par: 4 }), 5);
  // Older results: steps + undos, and a revealed word capped gold at silver.
  assert.equal(resultMedal({ status: "won", steps: 4, undos: 1, par: 4 }).id, "silver");
  assert.equal(resultMedal({ status: "won", steps: 4, par: 4, reveals: 1 }).id, "silver");
  assert.equal(resultMedal({ status: "won", steps: 4, par: 4 }).id, "gold");
  // In-progress saves get a counter that starts where they were.
  assert.equal(upgradeMoves({ path: ["a", "b", "c"], undos: 2 }).moves, 4);
  assert.equal(upgradeMoves({ path: ["a"], moves: 7 }).moves, 7);
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
  assert.equal(rulesFor(config, "2026-11-12").excludeCandidates, undefined); // past dates untouched
  const path = rulesFor(config, "2026-11-13").excludeCandidates;
  const excluded = excludedWords(read(path));
  const cands = new Set(read(`data/candidates_v${config.graphVersion}.json`).words);
  for (const w of ["batman", "billy", "bobby", "ben", "amir", "ayatollah", "afghan", "argentine",
    "behind", "bolster", "bore", "wing", "jam"]) assert.ok(excluded.has(w), w);
  for (const w of excluded) assert.ok(cands.has(w), `${w} is not a candidate`);
});

test("open ladders: only a word one rung closer counts (grandmother = son)", async () => {
  const { upOneRung } = await import("../../js/logic.js");
  // dist: steps to the goal for words 0..4 (-1 = no route); the goal is 3.
  const dist = [2, 1, 2, 0, -1];
  assert.equal(upOneRung(dist, 0, 1), true);   // one rung up
  assert.equal(upOneRung(dist, 1, 3), true);   // the goal
  assert.equal(upOneRung(dist, 0, 2), false);  // same rung: "grandmother = son"
  assert.equal(upOneRung(dist, 1, 0), false);  // farther
  assert.equal(upOneRung(dist, 0, 4), false);  // no route from there
  assert.equal(upOneRung(dist, 4, 1), false);  // from a dead end (old saves): undo instead
  assert.equal(upOneRung(dist, 3, 1), false);  // already at the goal
});

