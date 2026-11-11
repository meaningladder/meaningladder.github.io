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

// ------------------------------------------------------------ steps
export function normalize(text) {
  return text.trim().toLowerCase();
}

// Is `typed` a legal next step from the current (last) word of `path`?
// Returns { ok: true, word } or { ok: false, error }.
export function checkStep(ladder, path, typed) {
  const word = normalize(typed);
  const current = path[path.length - 1];
  if (!word) return { ok: false, error: "Type a word first." };
  if (!/^[a-z]+$/.test(word)) return { ok: false, error: "Letters only, please." };
  if (!ladder.index.has(word)) return { ok: false, error: `I don't know “${word}”.` };
  if (word === current) return { ok: false, error: `You're already on ${word}.` };
  if (path.includes(word)) return { ok: false, error: `${word} is already in your path.` };
  const cur = ladder.index.get(current);
  const idx = ladder.index.get(word);
  if (!ladder.neighbors[cur].includes(idx)) {
    return {
      ok: false,
      error: `${word} isn't a neighbor of ${current}. Try another word.`,
      nearMiss: nearMiss(ladder, cur, idx),
    };
  }
  return { ok: true, word };
}

// Is the link one-way? The attempt lists the current word among ITS
// neighbors, but not the other way round (neighbor lists aren't symmetric).
export function nearMiss(ladder, fromIdx, toIdx) {
  return { oneWay: ladder.neighbors[toIdx].includes(fromIdx) };
}

// Extra sentence under a rejection, or null. Ranks (below) now say how close
// a guess was; this only explains the one surprising case.
export function nearMissText({ oneWay }, current, word) {
  return oneWay ? { tone: "close", keyword: "So close:", text: `${current} is one of ${word}'s closest words, but the link only runs the other way.` } : null;
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

export function squareFor(d) {
  if (d === 0) return "✅";
  if (d === 1) return "🟩";
  if (d === 2) return "🟨";
  return "🟥";
}

// Spoiler-free share text: no words, just colored steps.
// e.g. "Meaning Ladder #12 — 5 steps (par 4) 🟥🟨🟨🟩✅"
export function shareText({ label, steps, par, distances, gaveUp = false, hints = 0, url = "" }) {
  const squares = distances.map(squareFor).join("");
  const what = gaveUp ? `gave up after ${steps} step${steps === 1 ? "" : "s"}`
                      : `${steps} step${steps === 1 ? "" : "s"}`;
  const hintPart = hints ? ` · 💡${hints}` : "";
  return `Meaning Ladder ${label} — ${what} (par ${par})${squares ? " " + squares : ""}${hintPart}${url ? "\n" + url : ""}`;
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

// Results are keyed "<date>:<level>" (older saves: just "<date>").
// The streak counts DAYS: solving any level on the day itself keeps it alive.
// Archive plays (finished on a later date) never extend a streak.
export function computeStats(results, today) {
  const dayOf = (key) => key.slice(0, 10);
  const levelOf = (key) => key.slice(11) || null;
  const finished = Object.entries(results).filter(([, r]) => r.status !== "playing");
  const wins = finished.filter(([, r]) => r.status === "won");
  const onTimeDays = new Set(wins.filter(([k, r]) => r.playedOn === dayOf(k)).map(([k]) => dayOf(k)));

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

  const overPar = wins.map(([, r]) => r.steps - r.par);
  return {
    played: finished.length,
    winPct: finished.length ? Math.round((100 * wins.length) / finished.length) : 0,
    currentStreak: current,
    maxStreak: Math.max(best, current),
    avgOverPar: overPar.length ? overPar.reduce((a, b) => a + b, 0) / overPar.length : null,
    solvedByLevel,
  };
}
