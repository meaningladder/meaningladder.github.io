// Pure game rules. No DOM, no fetch, no localStorage, so Node can test
// every function here (tests/js/logic.test.mjs).

// ------------------------------------------------------------ graph helpers
// Reverse adjacency in "CSR" form: one flat array of edges plus an offsets
// array saying where each word's slice starts. Same idea as a phone book's
// thumb tabs: offsets[i]..offsets[i+1] is the section for word i.
export function buildReverse(neighbors) {
  const n = neighbors.length;
  const counts = new Int32Array(n + 1);
  for (const row of neighbors) for (const v of row) counts[v + 1]++;
  for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
  const offsets = counts.slice();
  const fill = counts.slice(0, n);
  const edges = new Int32Array(offsets[n]);
  // ranks[k]: where the word that points in (edges[k]) lists this word, 1 = its
  // most similar neighbor. Used to price steps in costsToGoal.
  const ranks = new Uint8Array(offsets[n]);
  neighbors.forEach((row, u) => row.forEach((v, r) => {
    const k = fill[v]++;
    edges[k] = u;
    ranks[k] = r + 1;
  }));
  return { offsets, edges, ranks };
}

// Steps-to-goal for EVERY word, via one BFS from the goal over reversed edges.
// "Who can reach the goal in 1 step? In 2?" Like ripples flowing backwards.
// Returns an Int16Array; -1 = can't reach the goal at all.
export function distancesToGoal(reverse, n, goal) {
  const dist = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  dist[goal] = 0;
  queue[tail++] = goal;
  while (head < tail) {
    const v = queue[head++];
    for (let k = reverse.offsets[v]; k < reverse.offsets[v + 1]; k++) {
      const u = reverse.edges[k];
      if (dist[u] === -1) {
        dist[u] = dist[v] + 1;
        queue[tail++] = u;
      }
    }
  }
  return dist;
}

// ------------------------------------------------------------ natural routes
// BFS finds the FEWEST steps, which often means one wild leap: any of a word's
// top 100 is legal, so door -> window -> stained -> blood (#79) -> kidney is
// "shortest". For hints and the route we show, we want the GENTLEST path:
// Dijkstra, where a step costs its rank in the neighbor list (1 = most similar)
// plus STEP_COST. Without STEP_COST the route would crawl through dozens of
// near-synonyms; 5 gives routes of roughly par to par + 4 steps.
// Par and medals still come from BFS (distancesToGoal); this only changes
// what we *suggest*.
export const STEP_COST = 5;

// Cheapest cost-to-goal for EVERY word: one Dijkstra from the goal over the
// reversed edges (same trick as distancesToGoal). Infinity = can't reach it.
// The priority queue is a binary heap keyed by word, with decrease-key, so it
// never holds more than n entries.
export function costsToGoal(reverse, n, goal) {
  const cost = new Float64Array(n).fill(Infinity);
  const heap = new Int32Array(n); // word indexes, smallest cost on top
  const pos = new Int32Array(n).fill(-1); // where each word sits in heap; -1 = not queued
  let size = 0;
  const swap = (i, j) => {
    const a = heap[i], b = heap[j];
    heap[i] = b; heap[j] = a; pos[b] = i; pos[a] = j;
  };
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[heap[p]] <= cost[heap[i]]) break;
      swap(i, p); i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < size && cost[heap[l]] < cost[heap[m]]) m = l;
      if (r < size && cost[heap[r]] < cost[heap[m]]) m = r;
      if (m === i) return;
      swap(i, m); i = m;
    }
  };
  cost[goal] = 0;
  heap[0] = goal; pos[goal] = 0; size = 1;
  while (size) {
    const v = heap[0];
    pos[v] = -2; // settled
    size--;
    if (size) { heap[0] = heap[size]; pos[heap[0]] = 0; down(0); }
    for (let k = reverse.offsets[v]; k < reverse.offsets[v + 1]; k++) {
      const u = reverse.edges[k];
      if (pos[u] === -2) continue;
      const c = cost[v] + reverse.ranks[k] + STEP_COST;
      if (c < cost[u]) {
        cost[u] = c;
        if (pos[u] === -1) { heap[size] = u; pos[u] = size; size++; }
        up(pos[u]);
      }
    }
  }
  return cost;
}

// The gentlest route from `from` to the goal, as word indexes including both
// ends; null if the goal can't be reached. At each word, take the neighbor
// with the lowest (step price + its cost-to-goal); ties go to the more similar word.
export function naturalRoute(neighbors, cost, from) {
  if (!Number.isFinite(cost[from])) return null;
  const route = [from];
  let cur = from;
  while (cost[cur] > 0 && route.length <= neighbors.length) {
    let best = -1, bestCost = Infinity;
    neighbors[cur].forEach((v, r) => {
      const c = r + 1 + STEP_COST + cost[v];
      if (c < bestCost) { best = v; bestCost = c; }
    });
    cur = best;
    route.push(cur);
  }
  return route;
}

// One FEWEST-steps route (what par counts), as word indexes including both
// ends; null if the goal can't be reached. At each word, only neighbors one
// step closer (dist[v] === dist[cur] - 1) qualify; among those, take the
// gentlest by the same price naturalRoute uses (rank + STEP_COST + cost[v]).
export function shortestRoute(neighbors, dist, cost, from) {
  if (dist[from] < 0) return null;
  const route = [from];
  let cur = from;
  while (dist[cur] > 0) {
    let best = -1, bestCost = Infinity;
    neighbors[cur].forEach((v, r) => {
      if (dist[v] !== dist[cur] - 1) return;
      const c = r + 1 + STEP_COST + cost[v];
      if (best === -1 || c < bestCost) { best = v; bestCost = c; }
    });
    cur = best;
    route.push(cur);
  }
  return route;
}

// The word a hint points to from `from`: the first step of shortestRoute,
// so every hint gets exactly one step closer and a player who follows hints
// all the way still finishes at par (gold). naturalRoute can step sideways
// or away to dodge an awkward leap, which the game then tags "no closer" or
// "farther"; that gentler route is only for the give-up screen.
// Returns a word index, or -1 if the goal can't be reached or `from` is it.
export function hintStep(neighbors, dist, cost, from) {
  const route = shortestRoute(neighbors, dist, cost, from);
  return route && route.length > 1 ? route[1] : -1;
}

// ------------------------------------------------------------ bottleneck routes
// A route is only as convincing as its WEAKEST link: mentor -> protege ->
// combs -> puff -> cheese is par, but "combs" is embedding noise. So for the
// routes we show, first minimise the worst rank on the route (a "bottleneck"
// or minimax path), and only then the usual gentleness (sum of rank +
// STEP_COST) to break ties. Sum-based Dijkstra can't do this: it will happily
// trade one #98 leap for several #1 steps.
//
// A link "looks related" when it's in the top GENTLE_RANK of its word's list.
// Above that, a par + 1 route that stays within it reads better than par.
export const GENTLE_RANK = 30;

// The route of at most maxLen steps (default: par) from `from` to the goal
// (the word with dist 0) whose worst link rank is as small as possible; ties
// go to the lowest rank + STEP_COST total. Returns { route, worst } with
// route as word indexes including both ends, or null if no route fits.
//
// How: binary search the rank threshold T. For a given T, a depth-limited
// search keeps only links with rank <= T and prunes any word whose
// unrestricted distance to the goal (dist) already exceeds the steps left.
// With maxLen = par that leaves just the words on shortest paths, so each
// check touches a small corner of the 20k-word graph, not all of it.
export function bottleneckRoute(neighbors, dist, from, maxLen = dist[from]) {
  if (dist[from] < 0 || dist[from] > maxLen) return null;
  const stride = maxLen + 1;
  const search = (T) => {
    // Keyed by word * stride + steps left: cheapest total to the goal (Infinity
    // = impossible) and the neighbor that achieves it, to rebuild the route.
    const best = new Map();
    const next = new Map();
    const solve = (u, b) => {
      if (dist[u] === 0) return 0;
      const key = u * stride + b;
      const seen = best.get(key);
      if (seen !== undefined) return seen;
      let bestCost = Infinity, bestV = -1;
      const row = neighbors[u];
      const lim = Math.min(T, row.length);
      for (let r = 0; r < lim; r++) {
        const v = row[r];
        if (dist[v] < 0 || dist[v] > b - 1) continue; // can't finish in time
        const c = r + 1 + STEP_COST + solve(v, b - 1);
        if (c < bestCost) { bestCost = c; bestV = v; }
      }
      best.set(key, bestCost);
      next.set(key, bestV);
      return bestCost;
    };
    if (!Number.isFinite(solve(from, maxLen))) return null;
    const route = [from];
    for (let u = from, b = maxLen; dist[u] !== 0; b--) {
      u = next.get(u * stride + b);
      route.push(u);
    }
    return route;
  };
  let maxRank = 0;
  for (const row of neighbors) if (row.length > maxRank) maxRank = row.length;
  let lo = 1, hi = maxRank; // hi is always a feasible threshold
  if (!search(hi)) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (search(mid)) hi = mid; else lo = mid + 1;
  }
  const route = search(hi);
  return { route, worst: worstRank(neighbors, route) };
}

// The largest neighbor-list rank (1 = most similar) used along a route.
export function worstRank(neighbors, route) {
  let worst = 0;
  for (let i = 1; i < route.length; i++) {
    worst = Math.max(worst, neighbors[route[i - 1]].indexOf(route[i]) + 1);
  }
  return worst;
}

// ------------------------------------------------------------ steps
export function normalize(text) {
  return text.trim().toLowerCase();
}

// Is `typed` a legal next step from the current (last) word of `path`?
// Returns { ok: true, word, note? } or { ok: false, error, suggestion? }.
// `goal` is optional: without it, forms of the goal get no special handling.
export function checkStep(ladder, path, typed, goal = null) {
  const word = normalize(typed);
  const current = path[path.length - 1];
  if (!word) return { ok: false, error: "Type a word first." };
  if (!/^[a-z]+$/.test(word)) return { ok: false, error: "Letters only, please." };
  // Links between forms of one word are removed from the graph, so "trees"
  // can be several steps from "tree". Typing a form of the goal almost always
  // means "the goal", so count it as the goal when that step is legal, and
  // say why it isn't otherwise instead of letting it become a detour.
  if (goal && word !== goal && formOf(word, goal)) {
    const cur = ladder.index.get(current), g = ladder.index.get(goal);
    if (cur !== undefined && g !== undefined && ladder.neighbors[cur].includes(g)) {
      return { ok: true, word: goal, note: `Counted as ${goal}.` };
    }
    return { ok: false, error: `${word} is a form of the goal ${goal}: you'll need to reach ${goal} itself.` };
  }
  // "ships" when "ship" is the legal step: a plural means the same thing, so
  // count it as the singular instead of rejecting it.
  if (!isLegal(ladder, path, word)) {
    const single = singularStep(ladder, path, word);
    if (single) return { ok: true, word: single, note: `Counted as ${single}.` };
  }
  if (!ladder.index.has(word)) {
    const suggestion = didYouMean(ladder, path, word);
    if (suggestion) return { ok: false, error: `Did you mean ${suggestion}?`, suggestion };
    const size = ladder.words.length.toLocaleString("en-US");
    return { ok: false, error: `${word} isn't in our ${size}-word list. Try a more common word.` };
  }
  if (word === current) return { ok: false, error: `You're already on ${word}.` };
  if (path.includes(word)) return { ok: false, error: `${word} is already in your path.` };
  const cur = ladder.index.get(current);
  const idx = ladder.index.get(word);
  if (!ladder.neighbors[cur].includes(idx)) {
    return {
      ok: false,
      error: `${word} isn't one of ${current}'s ${ladder.config?.stepLimit ?? 100} closest words.`,
      nearMiss: nearMiss(ladder, cur, idx),
    };
  }
  return { ok: true, word };
}

// Would `word` be accepted as is: a known word, new to the path, and one of
// the current word's legal steps?
function isLegal(ladder, path, word) {
  const cur = ladder.index.get(path[path.length - 1]), idx = ladder.index.get(word);
  return idx !== undefined && cur !== undefined && !path.includes(word) && ladder.neighbors[cur].includes(idx);
}

// The singular of a plural `word` when that is a legal next step, else null.
// Plural endings only: "tower" is not a form of "tow", nor "player" of "play".
function singularStep(ladder, path, word) {
  for (const base of baseForms(word, PLURAL)) if (isLegal(ladder, path, base)) return base;
  return null;
}

// Should an open ladder finish by itself? True when the goal is one of the
// current word's legal steps: typing it then is a chore, not a choice.
export function autoGoal(ladder, current, goal) {
  const cur = ladder.index.get(current), g = ladder.index.get(goal);
  return cur !== undefined && g !== undefined && current !== goal && ladder.neighbors[cur].includes(g);
}

// Regular English inflection endings, as [ending, replacement]: a rough
// stand-in for WordNet's morphy (which the Python side uses to drop these
// links). Irregulars like mice/mouse are not covered.
const DETACH = [
  ["ies", "y"], ["ses", "s"], ["xes", "x"], ["zes", "z"], ["ches", "ch"], ["shes", "sh"],
  ["men", "man"], ["es", "e"], ["es", ""], ["s", ""],
  ["ied", "y"], ["ed", "e"], ["ed", ""], ["ing", "e"], ["ing", ""],
  ["ier", "y"], ["iest", "y"], ["er", "e"], ["er", ""], ["est", "e"], ["est", ""],
];
// The noun-plural endings of DETACH (everything before "ied").
const PLURAL = DETACH.slice(0, DETACH.findIndex(([end]) => end === "ied"));

// Possible base forms of `w` by stripping one regular ending. Bases shorter
// than 3 letters are skipped: "bed" would otherwise be a form of "be".
// The set keeps the order of `endings`, so the likeliest base comes first.
function baseForms(w, endings = DETACH) {
  const out = new Set();
  for (const [end, rep] of endings) {
    if (!w.endsWith(end)) continue;
    const stem = w.slice(0, -end.length);
    const base = stem + rep;
    if (base.length >= 3) out.add(base);
    // running -> run, bigger -> big: undo a doubled final consonant.
    if (!rep && stem.length >= 4 && stem.at(-1) === stem.at(-2)) out.add(stem.slice(0, -1));
  }
  return out;
}

// Is `a` just another form of `b`? Same rule as the graph filter: a shared
// base form, or a long shared prefix (sameFamily).
export function formOf(a, b) {
  return a !== b && (baseForms(a).has(b) || baseForms(b).has(a) || sameFamily(a, b));
}

// Are `a` and `b` one edit apart (insert, delete, substitute, or swap two
// adjacent letters)? Linear time, no matrix: this runs on thousands of words
// per keypress-submit.
export function oneEdit(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Best vocabulary word one edit from `word`, or null. A legal next step wins
// (that's what the player was most likely aiming at), then the most common
// word (the list is in frequency order). Words already in the path are
// skipped since suggesting them would only lead to another rejection.
function didYouMean(ladder, path, word) {
  const cur = ladder.index.get(path[path.length - 1]);
  for (const idx of cur === undefined ? [] : ladder.neighbors[cur]) {
    const w = ladder.words[idx];
    if (!path.includes(w) && oneEdit(word, w)) return w;
  }
  // Anywhere else, only words with the same first letter: typos rarely change
  // it, and "kitten" -> "Did you mean bitten?" reads as a joke, not a fix.
  for (const w of ladder.words) {
    if (w[0] === word[0] && Math.abs(w.length - word.length) <= 1 && !path.includes(w) && oneEdit(word, w)) return w;
  }
  return null;
}

// Is the link one-way? The attempt lists the current word among ITS
// neighbors, but not the other way round (neighbor lists aren't symmetric).
export function nearMiss(ladder, fromIdx, toIdx) {
  return { oneWay: ladder.neighbors[toIdx].includes(fromIdx) };
}

// Extra sentence under a rejection, or null. Ranks (below) now say how close
// a guess was; this only explains the one surprising case.
export function nearMissText({ oneWay }, current, word) {
  return oneWay ? {
    tone: "close", keyword: "One-way:",
    text: `${current} is close to ${word}, but ${word} isn't one of ${current}'s closest. Only words close to ${current} count.`,
  } : null;
}

// ------------------------------------------------------------ Contexto-style ranks
// vectors = { data: Int8Array(count * dims), dims, count, norms: Float32Array }
// Cosine similarity of `fromIdx` against every word. Integer dot products on
// 8-bit numbers: 20k words x 64 dims is about a million multiplies (a few ms).
export function scoresFrom(vectors, fromIdx) {
  const { data, dims, count, norms } = vectors;
  const out = new Float32Array(count);
  const base = fromIdx * dims;
  for (let i = 0; i < count; i++) {
    let dot = 0;
    const off = i * dims;
    for (let k = 0; k < dims; k++) dot += data[base + k] * data[off + k];
    out[i] = dot / (norms[i] * norms[fromIdx] || 1);
  }
  return out;
}

// 1 + how many other words score strictly higher than `toIdx`.
export function rankOf(scores, fromIdx, toIdx) {
  const s = scores[toIdx];
  let rank = 1;
  for (let i = 0; i < scores.length; i++) if (i !== fromIdx && i !== toIdx && scores[i] > s) rank++;
  return rank;
}

// Same prefix rule as scripts/wordfilters.py is_trivial_pair (the lemma half
// needs WordNet, so mice/mouse falls through to a normal rank).
export function sameFamily(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p >= 5 && p >= 0.75 * Math.min(a.length, b.length);
}

// What a wrong guess shows. Words in the stored top 100 use their exact graph
// position (with the top-20 rule, #21-#100 are exact near misses); everything
// else is at least #101, even where the compact vectors disagree, so the
// number never contradicts the graph.
export function displayRank(ladder, fromIdx, toIdx, approxRank) {
  const pos = (ladder.fullNeighbors ?? ladder.neighbors)[fromIdx].indexOf(toIdx);
  if (pos >= 0) return { rank: pos + 1, family: false };
  if (sameFamily(ladder.words[fromIdx], ladder.words[toIdx])) return { rank: null, family: true };
  return { rank: Math.max(approxRank, 101), family: false };
}

// `limit` = the legal-step limit; a rejected word is always past it.
export function rankTone(rank, limit = 100) {
  if (rank <= limit) return "near";
  if (rank <= 300) return "mid";
  if (rank <= 2000) return "far";
  return "cold";
}

// Log scale: #1 fills the bar, #101 about half, #10,000 a sliver.
export function rankFill(rank, total = 20000) {
  return Math.max(4, Math.round(100 * (1 - Math.log(rank) / Math.log(total))));
}

// Tried list order: still-loading first, then closest, then "same word".
export function triedOrder(items) {
  const key = (x) => (x.family ? Infinity : typeof x.rank === "number" ? x.rank : x.rank == null ? -1 : 1e9);
  return [...items].sort((a, b) => key(a) - key(b));
}

// ------------------------------------------------------------ results
// A ladder's score is its moves: path steps plus every accepted word that was
// later undone. Without the undo count, Undo plus the exact "N to go" readout
// would let anyone try words, take back each "no closer" one and always get
// gold. Results saved before undos were counted have no `undos`: count 0.
export function movesOf({ steps = 0, undos = 0 } = {}) {
  return steps + (undos ?? 0);
}

// How a score reads: "4 steps" when nothing was undone (same as before undos
// counted), otherwise "5 moves (4 steps + 1 undo)" so the medal math shows.
export function movesText(steps, undos = 0) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (!undos) return plural(steps, "step");
  return `${plural(steps + undos, "move")} (${plural(steps, "step")} + ${plural(undos, "undo")})`;
}

// Callers pass moves (movesOf), not just the final path length.
// `revealed`: a hint gave away a whole word during the solve. That caps the
// medal at silver, since gold should mean you found the par route yourself.
// The returned medal says `capped` so the result card can explain why.
// `slack`: how many moves over par still earn gold, silver and bronze.
// Open ladders allow [0, 1, 2]. Chain ladders (one answer per rung) allow
// more, since every wrong guess costs a move (config "medalSlack").
export const DEFAULT_SLACK = [0, 1, 2];
export function medalFor(steps, par, { revealed = false, slack = DEFAULT_SLACK } = {}) {
  const over = steps - par;
  const [g, s, b] = slack ?? DEFAULT_SLACK;
  const silver = { id: "silver", label: "Silver", emoji: "🥈" };
  if (over <= g) return revealed ? { ...silver, capped: true } : { id: "gold", label: "Gold", emoji: "🥇" };
  if (over <= s) return silver;
  if (over <= b) return { id: "bronze", label: "Bronze", emoji: "🥉" };
  return { id: "finished", label: "Finished", emoji: "🏁" };
}

// A saved result's score. Results from now on store `moves` (every word
// played, undone ones and hints included). Older results kept steps, undos and
// reveals separately; they keep exactly the medal they were given.
export const scoreOf = (r) => (r.moves != null ? r.moves : movesOf(r));
// Chain results also store the par their medal is measured against (the
// hidden words) and the slack, so the medal never changes after the fact.
export const resultMedal = (r) => (r.moves != null
  ? medalFor(r.moves, r.medalPar ?? r.par, { slack: r.slack })
  : medalFor(movesOf(r), r.par, { revealed: r.reveals > 0 }));

// In-progress saves from before the single moves counter: start it from what
// they had (path steps plus undos), so resuming never resets the score.
export function upgradeMoves(state) {
  state.moves ??= (state.path.length - 1) + (state.undos ?? 0);
  return state;
}

const MEDAL_ORDER = ["gold", "silver", "bronze", "finished"];
// The better of two medals (gold beats silver...). Compares medals rather than
// steps over par, because a capped gold-pace solve is only silver.
export const betterMedal = (a, b) => (MEDAL_ORDER.indexOf(b.id) < MEDAL_ORDER.indexOf(a.id) ? b : a);

// ------------------------------------------------------------ hints
// Neighbors of `from` that are exactly one step closer to the goal.
export function closerSteps(neighbors, dist, from) {
  const d = dist[from];
  if (d <= 0) return [];
  return neighbors[from].filter((v) => dist[v] === d - 1);
}

// A clue for the hinted word `next` that never names it: up to three of its
// own closest words, its length and its first letter. Skipped as clue words:
// forms of the answer (formOf) and anything that contains it or sits inside
// it, since those give it away; words already on the player's path, the
// current word among them, since they say nothing new; and the goal.
export function clueFor(ladder, path, next, goal = null) {
  const word = ladder.words[next];
  const related = [];
  for (const idx of ladder.neighbors[next]) {
    const w = ladder.words[idx];
    if (w === goal || path.includes(w)) continue;
    if (formOf(w, word) || w.includes(word) || word.includes(w)) continue;
    if (related.some((r) => formOf(r, w))) continue; // not "room, rooms"
    related.push(w);
    if (related.length === 3) break;
  }
  return { related, length: word.length, first: word[0] };
}

// "Think of: espresso, tea, beans. 6 letters, starts with “c”."
export function clueText({ related, length, first }) {
  const shape = `${length} letter${length === 1 ? "" : "s"}, starts with “${first}”.`;
  return related.length ? `Think of: ${related.join(", ")}. ${shape}` : shape[0].toUpperCase() + shape.slice(1);
}

// Hint tier stored for a word, or null. hasOwn, because a word like
// "constructor" would otherwise find Object.prototype members.
export const hintTier = (state, word) => (Object.hasOwn(state.hintsAt, word) ? state.hintsAt[word] : null);

// Saves from before per-word hint memory had a single `hint` for the current
// word. Carry it over so a resumed game shows the same hint, uncharged.
export function upgradeHintState(state) {
  if (!state.hintsAt) {
    state.hintsAt = {};
    if (state.hint?.word && state.hint.tier) state.hintsAt[state.hint.word] = state.hint.tier;
  }
  // Tiers now mean 1 = clue, 2 = the word. A save without `clues` is from when
  // one hint showed the word outright: keep what the player already paid for.
  if (!state.clues) {
    for (const w of Object.keys(state.hintsAt)) if (state.hintsAt[w] === 1) state.hintsAt[w] = 2;
    state.clues = true;
  }
  state.reveals ??= Object.values(state.hintsAt).filter((t) => t >= 2).length;
  delete state.hint;
  return state;
}

// Bar look for a word that is `d` steps from the goal.
export function closeness(d) {
  if (d === 0) return { tone: "goal", fill: 100 };
  if (d === 1) return { tone: "near", fill: 84 };
  if (d === 2) return { tone: "mid", fill: 60 };
  const fills = { 3: 40, 4: 26, 5: 16 };
  return { tone: "far", fill: d > 0 && fills[d] ? fills[d] : 8 };
}

// One square per step, colored by how the step changed the distance to the
// goal (not by the absolute distance): on a par-6 ladder every early word is
// far away, so absolute colors made good opening moves look like mistakes.
// -1 means "no route to the goal from here".
export function squareFor(from, to) {
  if (to === 0) return "✅";
  if (to < 0) return "🟥";
  if (from < 0) return "🟩"; // back onto a route after a dead end is progress
  if (to < from) return "🟩";
  if (to === from) return "🟨";
  return "🟥";
}

// Spoiler-free share text: no words, just colored steps.
// `distances` starts with the START word's distance, so the first step's
// change is known; there is one square per step after it. Undone words count
// as moves (see movesOf), e.g.
//   Meaning Ladder #13 Hard 🥈
//   7 steps · par 6
//   🟩🟩🟨🟩🟩🟩✅
export function shareText({ label, moves, par, distances, gaveUp = false, url = "" }) {
  const squares = distances.slice(1).map((d, i) => squareFor(distances[i], d)).join("");
  // Gave-up games get no medal: the 🏁 "finished" emoji would read as a finish.
  const badge = gaveUp ? "" : " " + medalFor(moves, par).emoji;
  const n = `${moves} move${moves === 1 ? "" : "s"}`;
  const what = gaveUp ? `Gave up after ${n}` : n;
  return [`Meaning Ladder ${label}${badge}`, `${what} · par ${par}`, squares, url]
    .filter(Boolean).join("\n");
}

// ------------------------------------------------------------ dates & stats
// Local calendar date as "YYYY-MM-DD". Don't use toISOString(): that's the
// UTC date, which is "tomorrow" for evening players west of Greenwich.
export function localDateStr(d = new Date()) {
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localDateStr(new Date(y, m - 1, d + n)); // Date handles month/year rollover
}

// Whether a win on puzzle date `day` keeps the streak alive. Solving it on
// the day itself always counts. A ladder STARTED on its day but finished just
// after midnight counts too (startedOn is recorded when the game is created),
// but only until the end of the next day: otherwise a game opened and
// abandoned could be finished a week later and patch a streak gap. Archive
// plays (started after their day) never count. Results saved before
// startedOn existed only have playedOn, so they keep the old rule.
export function countsForStreak(day, r) {
  if (r?.status !== "won") return false;
  if (r.playedOn === day) return true;
  return r.startedOn === day && r.playedOn != null && r.playedOn <= addDays(day, 1);
}

// Results are keyed "<date>:<level>" (older saves: just "<date>").
// The streak counts DAYS: one level that countsForStreak keeps it alive.
// Just after midnight "today" has no win yet, so counting starts at
// yesterday: the streak only breaks once a whole day passes unsolved.
export function computeStats(results, today) {
  const dayOf = (key) => key.slice(0, 10);
  const levelOf = (key) => key.slice(11) || null;
  const finished = Object.entries(results).filter(([, r]) => r.status !== "playing");
  const wins = finished.filter(([, r]) => r.status === "won");
  const onTimeDays = new Set(wins.filter(([k, r]) => countsForStreak(dayOf(k), r)).map(([k]) => dayOf(k)));

  let current = 0;
  let d = onTimeDays.has(today) ? today : addDays(today, -1);
  while (onTimeDays.has(d)) { current++; d = addDays(d, -1); }

  let best = 0, run = 0, prev = null;
  for (const day of [...onTimeDays].sort()) {
    run = prev && addDays(prev, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }

  const solvedByLevel = { easy: 0, medium: 0, hard: 0 };
  for (const [k] of wins) if (levelOf(k) in solvedByLevel) solvedByLevel[levelOf(k)]++;

  const overPar = wins.map(([, r]) => scoreOf(r) - (r.medalPar ?? r.par)); // chains: vs the hidden words
  return {
    played: finished.length,
    winPct: finished.length ? Math.round((100 * wins.length) / finished.length) : 0,
    currentStreak: current,
    maxStreak: Math.max(best, current),
    avgOverPar: overPar.length ? overPar.reduce((a, b) => a + b, 0) / overPar.length : null,
    solvedByLevel,
  };
}

// ------------------------------------------------------------ rules eras
// config.rules is a list of eras sorted by "from" (see rulesFor in seeded.js).
// These helpers drive the one-time "New rules" notice and the "classic rules"
// labels, all from config, so a future era needs no code change.

// The newest era, but only if there was an older one to change from.
// Eras that change what players see: the step limit, link direction or a
// level's par. An era that only changes how puzzles are picked (for example
// minLinkedSteps) isn't news, so it gets no notice and no "classic" label.
const visibleRules = (e) => JSON.stringify([e.mode ?? "open", e.stepLimit, Boolean(e.twoWay),
  ...["easy", "medium", "hard"].map((lv) => e.levels?.[lv]?.par ?? null)]);
export function visibleEras(config) {
  const out = [];
  for (const e of config?.rules ?? []) {
    if (!out.length || visibleRules(out[out.length - 1]) !== visibleRules(e)) out.push(e);
  }
  return out;
}

export function newestEra(config) {
  const eras = visibleEras(config);
  return eras.length > 1 ? eras[eras.length - 1] : null;
}

// True if a daily game on dateStr is played under an older era's rules.
export function isClassicDay(config, dateStr) {
  const newest = newestEra(config);
  return Boolean(newest && dateStr && dateStr < newest.from);
}

// Short tag for an older-era day ("classic rules (top 100)"), or "".
// The step limit is that day's own era's (there could be several old eras).
export function classicLabel(config, dateStr) {
  if (!isClassicDay(config, dateStr)) return "";
  const era = [...config.rules].reverse().find((e) => e.from <= dateStr) ?? config.rules[0];
  return newestEra(config).mode === "chain" && era.mode !== "chain"
    ? `classic rules (open ladder, top ${era.stepLimit})`
    : `classic rules (top ${era.stepLimit})`;
}

// Dates the player played on, from saved results ("<date>:<level>" ->
// { playedOn }) and save keys ("game:<date>:<level>"). Results use playedOn
// (when they played), falling back to the game's own date for old saves.
export function playedDates(results, gameKeys = []) {
  const dates = Object.entries(results ?? {}).map(([k, r]) => r?.playedOn ?? k.slice(0, 10));
  for (const k of gameKeys) dates.push(k.slice("game:".length, "game:".length + 10));
  return dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

// Should the "New rules" notice show? Only once the newest era has started,
// only for players with history from before it (newcomers get How to play,
// which already teaches today's rules), and only until dismissed.
export function rulesNoticeDue(config, today, dates, seen) {
  const newest = newestEra(config);
  if (!newest || today < newest.from || seen) return false;
  return dates.some((d) => d < newest.from);
}

// "4, 5 and 6"
const listJoin = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Body text of the notice, comparing the newest era with the one before it.
// dayText formats a "YYYY-MM-DD" date: the DOM side owns the player's
// locale, and tests pass a fixed formatter.
export function rulesNoticeText(config, dayText, levelOrder = ["easy", "medium", "hard"]) {
  const newest = newestEra(config);
  if (!newest) return "";
  const eras = visibleEras(config);
  const old = eras[eras.length - 2];
  if (newest.mode === "chain" && old.mode !== "chain") {
    const par = newest.levels?.easy?.par ?? 5;
    return `From ${dayText(newest.from)}, every ladder is ${par} steps and each hidden rung has `
      + "exactly one answer. You see its length, and each wrong guess shows how close it is. Solve a rung to see why it links; "
      + "a hint gives a clue, then the word.";
  }
  const was = old.stepLimit !== newest.stepLimit ? ` (it was ${old.stepLimit})` : "";
  // Two-way eras: a step counts if EITHER word is among the other's closest.
  const parts = [newest.twoWay && !old.twoWay
    ? `From ${dayText(newest.from)}, a step counts if either word is among the other's ${newest.stepLimit} closest words.`
    : `From ${dayText(newest.from)}, each step must be one of the previous word's ${newest.stepLimit} closest words${was}.`];
  const pars = (era) => levelOrder.map((lv) => era.levels?.[lv]?.par).filter((p) => p != null);
  const now = pars(newest);
  const before = pars(old);
  if (now.length && now.join() !== before.join()) {
    const longer = before.length === now.length && now.every((p, i) => p >= before[i]);
    // Name the levels: two levels can share a par (Medium and Hard are both 5),
    // and "par is 4, 5 and 5" wouldn't say which is which.
    const named = levelOrder.filter((lv) => newest.levels?.[lv]?.par != null)
      .map((lv, i) => `${i ? "" : "par "}${newest.levels[lv].par} for ${newest.levels[lv].label ?? lv[0].toUpperCase() + lv.slice(1)}`);
    parts.push(longer ? `Ladders are longer: ${listJoin(named)}.` : `Now ${listJoin(named)}.`);
  }
  return parts.join(" ");
}

// ------------------------------------------------------------ the ladder
// The play screen draws a real ladder with par + 1 rungs: the start word on
// rung 0, the goal on rung `par`. Your word sits on rung par - (steps to go),
// so height IS progress. A legal step can get at most one step closer
// (distancesToGoal + checkStep), so a good word lifts you exactly one rung; a
// word that's no closer keeps your rung and a farther one drops you.
//
// dists: steps-to-goal of every word played, start first (-1 = no route).
// Returns rows top (goal) to bottom (start). Each row: its rung, the distance
// it stands for, `at` = index of the most recent word played at that
// distance (or null: an empty rung), and whether it's the current word.
// The current word can also be off the ladder: `below` (farther than the
// start) or `off` (no route to the goal), each the path index, else null.
export function ladderRows(dists, par) {
  par = Math.max(1, par);
  const lastAt = new Map();
  dists.forEach((d, i) => lastAt.set(d, i));
  const cur = dists[dists.length - 1];
  const rows = [];
  for (let rung = par; rung >= 0; rung--) {
    const d = par - rung;
    rows.push({ rung, d, at: lastAt.has(d) ? lastAt.get(d) : null, current: cur === d });
  }
  const last = dists.length - 1;
  return {
    rows,
    below: cur > par ? last : null,
    off: cur < 0 ? last : null,
    climber: cur < 0 ? "off" : cur > par ? "below" : par - cur,
  };
}

// ------------------------------------------------------------ stored route
// A puzzle file's route (AI-checked, with a reason per step) as word indexes,
// or null unless it is still a real shortest route under this view's rules:
// right ends, par + 1 words, every step legal and one step closer.
export function checkedRoute(route, puzzle, ladder, dist) {
  if (!Array.isArray(route) || route.length !== puzzle.par + 1) return null;
  if (route[0] !== puzzle.start || route[route.length - 1] !== puzzle.goal) return null;
  const idx = route.map((w) => ladder.index.get(w));
  if (idx.some((i) => i === undefined)) return null;
  for (let k = 0; k < puzzle.par; k++) {
    if (!ladder.neighbors[idx[k]].includes(idx[k + 1]) || dist[idx[k + 1]] !== dist[idx[k]] - 1) return null;
  }
  return idx;
}

// ------------------------------------------------------------ guide route
// A shortest route (each step one closer, via `dist`) with the most steps
// that are ConceptNet relations (`related`: a Set of relKey pairs); ties go
// to the more similar neighbor. Par is kept, so following it still earns
// gold; it just reads better (cafe, restaurant, grill, stove, kerosene,
// fuel). Word indexes including both ends, or null.
export function guideRoute(neighbors, dist, related, from) {
  if (!related || dist[from] < 0) return null;
  const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  const memo = new Map();
  const best = (u) => {
    if (dist[u] === 0) return 0;
    if (memo.has(u)) return memo.get(u);
    let b = -1;
    for (const v of neighbors[u]) {
      if (dist[v] !== dist[u] - 1) continue;
      const c = (related.has(key(u, v)) ? 1 : 0) + best(v);
      if (c > b) b = c;
    }
    memo.set(u, b);
    return b;
  };
  const route = [from];
  for (let u = from; dist[u] > 0;) {
    let pick = -1, score = -1;
    for (const v of neighbors[u]) {
      if (dist[v] !== dist[u] - 1) continue;
      const c = (related.has(key(u, v)) ? 1 : 0) + best(v);
      if (c > score) { score = c; pick = v; }
    }
    u = pick;
    route.push(u);
  }
  return route;
}

// ------------------------------------------------------------ chain ladders
// From the 2026-11-13 era a ladder is one fixed chain (puzzle.route): each
// hidden rung has one answer, shown as its length; wrong guesses show how
// close they are to it.

// A puzzle file's chain, or null if it can't be played as one: par + 1 known
// words with the right ends, one reason per step, and clues either absent
// (seeded) or one per step.
export function checkedChain(puzzle, ladder) {
  const { route, reasons, clues = [], par } = puzzle ?? {};
  if (!Array.isArray(route) || route.length !== par + 1 || par < 2) return null;
  if (!route.every((w) => typeof w === "string" && ladder.index.has(w))) return null;
  if (route[0] !== puzzle.start || route[par] !== puzzle.goal) return null;
  if (new Set(route).size !== route.length) return null;
  const texts = (xs, n) => Array.isArray(xs) && xs.length === n && xs.every((x) => typeof x === "string");
  if (!texts(reasons, par)) return null;
  if (!(texts(clues, 0) || texts(clues, par))) return null;
  return route;
}

// "_ _ _ _ _ _": the pattern shown on a hidden rung, one blank per letter.
// No first letter: wrong guesses show how close they are instead.
export const chainPattern = (word) => [..."_".repeat(word.length)].join(" ");

// How a wrong guess's closeness rank (1 = the answer's closest word) reads.
export function closenessLabel(rank) {
  if (typeof rank !== "number") return "";
  if (rank <= 10) return "very close";
  if (rank <= 50) return "close";
  if (rank <= 300) return "warm";
  return "cold";
}

// A guess at a hidden rung. `target` is the rung's word, `prev` the word
// below it, `shown` the words already on screen. Returns
//   { ok: true, note? }                     the answer (or a form / typo of it)
//   { ok: false, error, free: true }        not a fair guess: no move charged
//   { ok: false, wrong: true, near, word }  a real, fitting word, but not it
export function chainGuess(ladder, typed, target, prev, shown = []) {
  const word = normalize(typed);
  if (!word) return { ok: false, free: true, error: "Type a word first." };
  if (!/^[a-z]+$/.test(word)) return { ok: false, free: true, error: "Letters only, please." };
  if (word === target) return { ok: true };
  // Inflections only (tankers for tanker, ship for ships), not a shorter
  // relative: "tank" for "tanker" is another word.
  if (formOf(word, target) && (word.startsWith(target) || (target.endsWith("s") && target.startsWith(word)))) {
    return { ok: true, note: `Counted as ${target}.` };
  }
  if (!ladder.index.has(word)) {
    if (oneEdit(word, target)) return { ok: true, note: `Counted as ${target}.` };
    const size = ladder.words.length.toLocaleString("en-US");
    return { ok: false, free: true, error: `${word} isn't in our ${size}-word list.` };
  }
  if (shown.includes(word)) return { ok: false, free: true, error: `${word} is already on the ladder.` };
  if (word.length !== target.length) {
    const n = target.length;
    return { ok: false, free: true, error: `This word has ${n} letter${n === 1 ? "" : "s"}.` };
  }
  const p = ladder.index.get(prev);
  return { ok: false, wrong: true, word, near: p !== undefined && ladder.neighbors[p].includes(ladder.index.get(word)) };
}

// One square per hidden rung, then the goal: 🟩 first guess, 🟨 after wrong
// guesses, ⬜ revealed by a hint (or not reached).
export function chainSquares(rungs, won) {
  const sq = rungs.map((r) => (!r.solved || r.revealed ? "⬜" : r.misses ? "🟨" : "🟩")).join("");
  return sq + (won ? "✅" : "");
}

export function chainShareText({ label, moves, par, slack, rungs, gaveUp = false, url = "" }) {
  const badge = gaveUp ? "" : " " + medalFor(moves, par, { slack }).emoji;
  const n = `${moves} move${moves === 1 ? "" : "s"}`;
  const what = gaveUp ? `Gave up after ${n}` : n;
  return [`Meaning Ladder ${label}${badge}`, `${what} · ${par} hidden words`, chainSquares(rungs, !gaveUp), url]
    .filter(Boolean).join("\n");
}

