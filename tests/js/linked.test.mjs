// One clue-driven game (Daily and Unlimited): a ConceptNet link clue per rung,
// or "N letters, starts with X" where the planned step has no clean link.
// Only shortest-path words that fit the clue count.
// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ladderAt, practicePuzzle } from "../../js/data.js";
import {
  linkedGame, linkedGuess, linkedHint, linkedRung, linkedStart, linkedSubmit, linkedToGoal, plannedNext, rungClue, shownLetters,
} from "../../js/logic.js";
import { bfsAll, excludedWords, informativeKeys, levelBand, linkedFrom, linkedSteps, relKey, seededLinkedPuzzle } from "../../js/seeded.js";
import { buildReverse, distancesToGoal, guideRoute } from "../../js/logic.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(root + p, "utf8"));

// The newest rules' view of the real word map, built the way js/data.js does.
function realLadder() {
  const config = readJson("puzzle_config.json");
  const v = config.graphVersion;
  const graph = readJson(`data/graph_v${v}.json`);
  const relHead = readJson(`data/relations_v${config.relations}.json`);
  const bin = readFileSync(root + `data/relations_v${config.relations}.bin`);
  const n = relHead.count, related = new Map();
  for (let i = 0; i < n; i++) {
    const u = bin.readUInt16LE(4 * i), w = bin.readUInt16LE(4 * i + 2), d = bin[5 * n + i];
    related.set(relKey(u, w), { rel: relHead.relations[bin[4 * n + i]], from: d === 2 ? null : d === 0 ? u : w });
  }
  const paths = [...new Set(config.rules.map((e) => e.excludeCandidates).filter(Boolean))];
  const base = {
    words: graph.words, index: new Map(graph.words.map((w, i) => [w, i])), neighbors: graph.neighbors,
    complete: true, candidates: readJson(`data/candidates_v${v}.json`).words,
    exclusions: new Map(paths.map((p) => [p, excludedWords(readJson(p))])), config, related, linked: informativeKeys(related), views: new Map(),
    removed: config.removedSteps ? excludedWords(readJson(config.removedSteps)) : new Set(),
  };
  return ladderAt(base, null);
}

// A tiny hand-made map, goal "port" (route jeep, truck, tanker, port):
//   jeep (3 to go): truck, van, tank (2 to go), ship (4 to go: only leads back to jeep)
//   truck: tanker, tinker, barrel (1 to go); van, tank: tanker; tanker, tinker, barrel: port
// Links: jeep IsA truck and jeep IsA van (edge starts at jeep), tank IsA jeep
// (the other way round), van-tanker AtLocation; truck has no clean link.
const words = ["jeep", "truck", "van", "tank", "ship", "tanker", "tinker", "barrel", "port", "trucks", "vans"];
const I = Object.fromEntries(words.map((w, i) => [w, i]));
const nb = words.map(() => []);
nb[I.jeep] = [I.truck, I.van, I.tank, I.ship];
nb[I.truck] = [I.tanker, I.tinker, I.barrel];
nb[I.van] = [I.tanker];
nb[I.tank] = [I.tanker];
nb[I.ship] = [I.jeep];
for (const w of ["tanker", "tinker", "barrel"]) nb[I[w]] = [I.port];
const related = new Map([
  [relKey(I.jeep, I.truck), { rel: "IsA", from: I.jeep }],
  [relKey(I.jeep, I.van), { rel: "IsA", from: I.jeep }],
  [relKey(I.jeep, I.tank), { rel: "IsA", from: I.tank }],
  [relKey(I.van, I.tanker), { rel: "AtLocation", from: I.tanker }],
  [relKey(I.truck, I.tanker), { rel: "RelatedTo", from: null }], // not clean: no clue
]);
const tiny = { words, index: new Map(words.map((w, i) => [w, i])), neighbors: nb, related };
const puzzle = { start: "jeep", goal: "port", par: 3, route: ["jeep", "truck", "tanker", "port"] };
const game = () => linkedGame(tiny, puzzle);

test("linkedToGoal counts the most clean links on a shortest path; plannedNext follows the route, else the guide choice", () => {
  const g = game();
  const to = linkedToGoal(nb, related, g.dist, I.port);
  assert.deepEqual([to[I.port], to[I.tanker], to[I.truck], to[I.van], to[I.jeep]], [0, 0, 0, 1, 2]);
  assert.equal(plannedNext(tiny, related, g.dist, to, g.route, I.jeep), I.truck); // on the stored route
  assert.equal(plannedNext(tiny, related, g.dist, to, null, I.jeep), I.van);       // guide: 2 links via van
  assert.equal(plannedNext(tiny, related, g.dist, to, g.route, I.van), I.tanker);  // off route
});

test("a link rung shows the link clue the right way round; a rung without one shows letters", () => {
  assert.deepEqual(rungClue(tiny, related, I.jeep, I.truck),
    { kind: "link", text: "Jeep is a kind of this", rel: "IsA", from: I.jeep });
  assert.deepEqual(rungClue(tiny, related, I.truck, I.tanker),
    { kind: "letters", text: "6 letters, starts with T", length: 6, first: "t" });
  assert.equal(rungClue(tiny, related, I.van, I.tanker).text, "Something you find at van");
});

test("a wrong-direction word is rejected and costs a move", () => {
  const g = game(), s = linkedStart(puzzle);
  const res = linkedSubmit(g, s, "tank"); // tank IsA jeep: same relation, other direction
  assert.equal(res.wrong, true);
  assert.deepEqual([s.path, s.moves], [["jeep"], 1]);
  assert.equal(linkedSubmit(g, s, "ship").wrong, true); // legal, but farther
  assert.equal(s.moves, 2);
});

test("a fitting off-route word is accepted, and the next clue follows from it", () => {
  const g = game(), s = linkedStart(puzzle);
  assert.equal(linkedSubmit(g, s, "van").ok, true);
  assert.deepEqual([s.path, s.moves], [["jeep", "van"], 1]);
  const rung = linkedRung(g, s);
  assert.equal(rung.planned, I.tanker);
  assert.equal(rung.clue.text, "Something you find at van");
});

test("on a letters rung, the right length and first letter one rung closer counts; a wrong first letter costs a move", () => {
  const g = game(), s = linkedStart(puzzle);
  linkedSubmit(g, s, "truck");
  assert.equal(linkedRung(g, s).clue.kind, "letters");
  assert.equal(linkedSubmit(g, s, "barrel").wrong, true);
  assert.equal(s.moves, 2);
  assert.equal(linkedSubmit(g, s, "tinker").ok, true); // not the planned tanker, still fits
  // One rung from the goal: the goal plays itself for one move.
  assert.deepEqual([s.path, s.moves, s.status], [["jeep", "truck", "tinker", "port"], 4, "won"]);
});

test("a perfect game equals par; a plural counts as its word", () => {
  const g = game(), s = linkedStart(puzzle);
  const res = linkedSubmit(g, s, " Trucks ");
  assert.deepEqual([res.ok, res.word, res.note], [true, "truck", "Counted as truck."]);
  linkedSubmit(g, s, "tanker");
  assert.deepEqual([s.path, s.moves, s.status], [["jeep", "truck", "tanker", "port"], 3, "won"]);
});

test("a repeat miss, a typo and an unknown word are free", () => {
  const g = game(), s = linkedStart(puzzle);
  assert.equal(linkedSubmit(g, s, "tank").wrong, true);
  assert.equal(linkedSubmit(g, s, " TANK").error, "Already tried tank.");
  assert.equal(linkedSubmit(g, s, "zzzz").ok, false);
  assert.equal(linkedSubmit(g, s, "jeep").ok, false);
  assert.equal(linkedSubmit(g, s, "").ok, false);
  assert.equal(s.moves, 1);
  assert.deepEqual(s.rungs[0].misses.map((m) => m.word), ["tank"]);
});

test("a typo never gets the planned word as its suggestion", () => {
  const res = linkedGuess(tiny, related, game().dist, ["jeep"], "truk", "port", I.truck, []);
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.error, /truck/);
});

test("hints reveal letters for a move each, and the last hint plays the word", () => {
  const g = game(), s = linkedStart(puzzle);
  const shown = (word) => [...shownLetters(g, s)].map((c, i) => [c, i]).filter(([c]) => c !== "_")
    .map(([c, i]) => { assert.equal(c, word[i]); return i; });
  linkedHint(g, s);
  const first = shown("truck");
  assert.equal(first.length, 1); // one letter, never the first one
  assert.notEqual(first[0], 0);
  assert.deepEqual(shown("truck"), first); // same letter on reload
  for (let i = 0; i < 2; i++) linkedHint(g, s);
  assert.deepEqual([s.path, s.moves, s.hints], [["jeep"], 3, 3]);
  linkedHint(g, s); // the last hidden letter (not the first) plays truck, no extra move
  assert.deepEqual([s.path, s.moves], [["jeep", "truck"], 4]);
  // A letters rung already shows the first letter; a hint adds one more.
  assert.deepEqual(shownLetters(g, s), ["t", "_", "_", "_", "_", "_"]);
  linkedHint(g, s);
  const word = g.ladder.words[linkedRung(g, s).planned];
  const two = shown(word);
  assert.equal(two.length, 2);
  assert.equal(two[0], 0);
});

test("a link on the goal step counts for nothing: the goal plays itself", () => {
  // Two-way s-a-b-g and s-c-d-g (par 3). Clean links s-a and b-g on the
  // first route, c-d on the second: a player sees at most 1 link clue.
  const ws = ["s", "a", "b", "c", "d", "g"];
  const [S, A, B, C, D, G] = ws.keys();
  const n = [[A, C], [S, B], [A, G], [S, D], [C, G], [B, D]];
  const rel = new Map([[relKey(S, A), { rel: "IsA", from: S }], [relKey(B, G), { rel: "IsA", from: B }], [relKey(C, D), { rel: "IsA", from: C }]]);
  const linked = informativeKeys(rel);
  assert.equal(linkedSteps(n, linked, S, G, 3), 1);
  assert.equal(linkedFrom(n, linked, S, bfsAll(n, S).dist)[G], 1);
  const lad = { words: ws, index: new Map(ws.map((w, i) => [w, i])), neighbors: n, candidates: ["g", "s"], linked, related: rel, config: { twoWay: true } };
  assert.throws(() => seededLinkedPuzzle(lad, "x", { par: 3, minRoutes: 1, maxRoutes: 10, minLinkedSteps: 2 }), /no linked puzzle/);
  const dist = distancesToGoal(buildReverse(n), ws.length, G);
  assert.deepEqual(guideRoute(n, dist, linked, S), [S, A, B, G]); // a 1-1 tie: the more similar neighbor
  const to = linkedToGoal(n, rel, dist, G);
  assert.deepEqual([to[S], to[A], to[C], to[B], to[D]], [1, 0, 1, 0, 0]);
  assert.equal(plannedNext(lad, rel, dist, to, null, S), A);
});

// ---- the real word map
const ladder = realLadder();
const made = Object.fromEntries(["easy", "medium", "hard"].map((lv) => [lv, practicePuzzle(ladder, lv, 12345)]));

test("Unlimited puzzles store a shortest route, par 3/4/5, every step legal and one rung closer", () => {
  for (const [lv, par] of [["easy", 3], ["medium", 4], ["hard", 5]]) {
    const p = made[lv];
    assert.equal(p.par, par, lv);
    assert.equal(p.route.length, par + 1, lv);
    assert.deepEqual([p.route[0], p.route.at(-1)], [p.start, p.goal]);
    const g = linkedGame(ladder, p);
    assert.ok(g.route, `${lv}: route checks out`);
  }
  assert.deepEqual(practicePuzzle(ladder, "medium", 12345), made.medium);
});

test("every rung, on route or off, has a clue", () => {
  for (const p of Object.values(made)) {
    const g = linkedGame(ladder, p);
    // Every word on any shortest path that still needs a guess (2 or more to go).
    let layer = [ladder.index.get(p.start)];
    while (g.dist[layer[0]] >= 2) {
      const next = new Set();
      for (const u of layer) {
        const v = plannedNext(ladder, ladder.related, g.dist, g.toGoal, g.route, u);
        assert.equal(g.dist[v], g.dist[u] - 1);
        assert.ok(rungClue(ladder, ladder.related, u, v).text);
        for (const w of ladder.neighbors[u]) if (g.dist[w] === g.dist[u] - 1) next.add(w);
      }
      layer = [...next];
    }
  }
});

test("playing the planned word every rung is a perfect game", () => {
  for (const p of Object.values(made)) {
    const g = linkedGame(ladder, p), s = linkedStart(p);
    while (s.status === "playing") assert.equal(linkedSubmit(g, s, ladder.words[linkedRung(g, s).planned]).ok, true);
    assert.deepEqual([s.path, s.moves], [p.route, p.par]);
  }
});

test("every picked fixture puzzle shows at least minLinkedSteps link clues on the rungs players see", () => {
  const fx = readJson("tests/fixtures/seeded_vectors.json");
  for (const f of fx.puzzles) {
    const band = levelBand(f.level, ladder.config); // one era: the fixture dates share the live view
    const dist = distancesToGoal(ladder.reverse, ladder.words.length, ladder.index.get(f.goal));
    const stored = guideRoute(ladder.neighbors, dist, ladder.linked, ladder.index.get(f.start)).map((i) => ladder.words[i]);
    // With the route a file stores, and without one (a seeded daily): play every planned word.
    for (const route of [stored, undefined]) {
      const p = { start: f.start, goal: f.goal, par: f.par, route };
      const g = linkedGame(ladder, p), s = linkedStart(p);
      let links = 0;
      while (s.status === "playing") {
        const { clue, planned } = linkedRung(g, s);
        if (clue.kind === "link") links++;
        linkedSubmit(g, s, ladder.words[planned]);
      }
      assert.ok(links >= band.minLinkedSteps, `${f.date} ${f.level}: ${links} link clues`);
    }
  }
});
