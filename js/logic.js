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
  neighbors.forEach((row, u) => { for (const v of row) edges[fill[v]++] = u; });
  return { offsets, edges };
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

// One shortest route from `from` to the goal: at each word, take the most
// similar neighbor (neighbor lists are sorted by similarity) that is one step
// closer. Returns word indexes, including both ends.
export function routeToGoal(neighbors, dist, from) {
  if (dist[from] < 0) return null;
  const route = [from];
  let cur = from;
  while (dist[cur] > 0) {
    cur = neighbors[cur].find((v) => dist[v] === dist[cur] - 1);
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

// How far was a rejected word, really? A forward BFS from the current word
// that gives up after `maxDepth` steps (depth 3 already reaches most of the
// map, so this costs a few milliseconds).
//   steps:  2 or 3, or null when it's further than maxDepth (or unreachable)
//   oneWay: the attempt lists the current word among ITS neighbors, but not
//           the other way round (neighbor lists aren't symmetric)
export function nearMiss(ladder, fromIdx, toIdx, maxDepth = 3) {
  const oneWay = ladder.neighbors[toIdx].includes(fromIdx);
  const n = ladder.neighbors.length;
  const depth = new Int8Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  depth[fromIdx] = 0;
  queue[tail++] = fromIdx;
  while (head < tail) {
    const u = queue[head++];
    if (depth[u] === maxDepth) break; // BFS order: everything after is deeper
    for (const v of ladder.neighbors[u]) {
      if (depth[v] !== -1) continue;
      depth[v] = depth[u] + 1;
      if (v === toIdx) return { steps: depth[v], oneWay };
      queue[tail++] = v;
    }
  }
  return { steps: null, oneWay };
}

// The sentence shown under the rejection. It never names a bridging word,
// so it's feedback about the guess, not a hint about the answer.
export function nearMissText({ steps, oneWay }, current, word) {
  if (oneWay) {
    return { tone: "close", keyword: "So close:", text: `${current} is one of ${word}'s closest words, but the link only runs the other way.` };
  }
  if (steps === 2) return { tone: "close", keyword: "Close!", text: "It's 2 steps away: find a word that links them." };
  if (steps === 3) return { tone: "warm", keyword: "Warm.", text: "It's 3 steps away: try something closer in meaning." };
  return { tone: "far", keyword: "Far.", text: `Try a word much closer in meaning to ${current}.` };
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
