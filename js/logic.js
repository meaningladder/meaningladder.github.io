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

// Regular English inflection endings, as [ending, replacement]: a rough
// stand-in for WordNet's morphy (which the Python side uses to drop these
// links). Irregulars like mice/mouse are not covered.
const DETACH = [
  ["ies", "y"], ["ses", "s"], ["xes", "x"], ["zes", "z"], ["ches", "ch"], ["shes", "sh"],
  ["men", "man"], ["es", "e"], ["es", ""], ["s", ""],
  ["ied", "y"], ["ed", "e"], ["ed", ""], ["ing", "e"], ["ing", ""],
  ["ier", "y"], ["iest", "y"], ["er", "e"], ["er", ""], ["est", "e"], ["est", ""],
];

// Possible base forms of `w` by stripping one regular ending. Bases shorter
// than 3 letters are skipped: "bed" would otherwise be a form of "be".
function baseForms(w) {
  const out = new Set();
  for (const [end, rep] of DETACH) {
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
  for (const w of ladder.words) {
    if (Math.abs(w.length - word.length) <= 1 && !path.includes(w) && oneEdit(word, w)) return w;
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
export function medalFor(steps, par) {
  const over = steps - par;
  if (over <= 0) return { id: "gold", label: "Gold", emoji: "🥇" };
  if (over === 1) return { id: "silver", label: "Silver", emoji: "🥈" };
  if (over === 2) return { id: "bronze", label: "Bronze", emoji: "🥉" };
  return { id: "finished", label: "Finished", emoji: "🏁" };
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
export function shareText({ label, steps, par, distances, gaveUp = false, hints = 0, undos = 0, url = "" }) {
  const squares = distances.slice(1).map((d, i) => squareFor(distances[i], d)).join("");
  // Gave-up games get no medal: the 🏁 "finished" emoji would read as a finish.
  const badge = gaveUp ? "" : " " + medalFor(steps + undos, par).emoji;
  const what = gaveUp ? `Gave up after ${movesText(steps, undos)}` : movesText(steps, undos);
  const hintPart = hints ? ` · 💡${hints}` : "";
  return [`Meaning Ladder ${label}${badge}`, `${what} · par ${par}${hintPart}`, squares, url]
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

  const overPar = wins.map(([, r]) => movesOf(r) - r.par);
  return {
    played: finished.length,
    winPct: finished.length ? Math.round((100 * wins.length) / finished.length) : 0,
    currentStreak: current,
    maxStreak: Math.max(best, current),
    avgOverPar: overPar.length ? overPar.reduce((a, b) => a + b, 0) / overPar.length : null,
    solvedByLevel,
  };
}
