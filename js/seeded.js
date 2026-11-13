// Seeded puzzle logic: a line-for-line port of scripts/ladder_core.py.
// The browser uses this when a puzzle file is missing, and for Practice mode.
// If you change one side, change the other, then run both test suites:
//   python scripts/make_fixtures.py && pytest -q && node --test tests/js/

export const LEVELS = ["easy", "medium", "hard"]; // every day has one puzzle per level
const RELAX_AFTER = 5000;
const GIVE_UP_AFTER = 20000;

// ------------------------------------------------------------ seeded randomness
// JS numbers are 64-bit floats. `>>> 0` reinterprets a value as an unsigned
// 32-bit integer, and Math.imul multiplies like a 32-bit CPU would (keeping
// only the low 32 bits). Plain `*` would lose bits above 2^53 (pitfall #7).

export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function nextFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ BFS
// Shortest path length start -> goal and the number of shortest routes.
// Returns { par: null, routes: 0 } when the goal is unreachable.
export function bfsRoutes(neighbors, start, goal) {
  const { par, routes } = bfsRouteStats(neighbors, start, goal);
  return { par, routes };
}

// Python twin: MAX_TRACKED_FIRST_MOVES. The masks below are 32-bit ints and
// bit 31 is the sign bit, so we track at most 31 first moves.
export const MAX_TRACKED_FIRST_MOVES = 31;

// Python twin: bfs_route_stats. Same ripples, plus "closer first moves": how
// many of the start's legal steps begin some shortest route. Each first move
// gets a bit; every word ORs in the bits of the previous-ripple words that
// point to it (like route counts), so the goal's bits are the helpful moves.
// Returns { par: null, routes: 0, closer: 0 } when the goal is unreachable,
// or further than maxDepth: the seeded loop only wants one par, and the last
// ripples are by far the biggest, so stopping there keeps the browser fast.
export function bfsRouteStats(neighbors, start, goal, maxDepth = Infinity) {
  if (start === goal) return { par: 0, routes: 1, closer: 0 };
  const dist = new Map([[start, 0]]);
  const routes = new Map([[start, 1]]);
  const moves = new Map([[start, 0]]);
  let frontier = [];
  let d = 1;
  neighbors[start].forEach((v, i) => { // ripple 1: each first move gets its own bit
    const bit = i < MAX_TRACKED_FIRST_MOVES ? 1 << i : 0;
    const dv = dist.get(v);
    if (dv === undefined) {
      dist.set(v, 1);
      routes.set(v, 1);
      moves.set(v, bit);
      frontier.push(v);
    } else if (dv === 1) {
      routes.set(v, routes.get(v) + 1);
      moves.set(v, moves.get(v) | bit);
    }
  });
  for (;;) {
    if (dist.has(goal)) return { par: d, routes: routes.get(goal), closer: popcount(moves.get(goal)) };
    if (!frontier.length || d >= maxDepth) return { par: null, routes: 0, closer: 0 };
    d += 1;
    const next = [];
    for (const u of frontier) {
      const ru = routes.get(u);
      const mu = moves.get(u);
      for (const v of neighbors[u]) {
        const dv = dist.get(v);
        if (dv === undefined) {
          dist.set(v, d);
          routes.set(v, ru);
          moves.set(v, mu);
          next.push(v);
        } else if (dv === d) {
          routes.set(v, routes.get(v) + ru);
          moves.set(v, moves.get(v) | mu);
        }
      }
    }
    frontier = next;
  }
}

function popcount(m) {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c;
}

// ------------------------------------------------------------ dates
// "YYYY-MM-DD" -> milliseconds at UTC midnight. Using UTC for both dates means
// no daylight-saving hour sneaks in, and Math.round guards us anyway (pitfall #5).
function utcMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function gameNumber(dateStr, launchDateStr) {
  const n = Math.round((utcMs(dateStr) - utcMs(launchDateStr)) / 86400000) + 1;
  if (n < 1) throw new Error(`${dateStr} is before the launch date ${launchDateStr}`);
  return n;
}

// ------------------------------------------------------------ rules eras
// Python twin: ladder_core.rules_for. The config with one era of
// config.rules merged in: the newest era whose "from" <= dateStr
// (null = the newest era). Older dates keep the rules they were played under.
export const DEFAULT_STEP_LIMIT = 100; // puzzles from before "stepLimit" existed

export function rulesFor(config, dateStr) {
  const eras = config.rules;
  if (!eras?.length) return config;
  const era = dateStr == null ? eras[eras.length - 1]
    : [...eras].reverse().find((e) => e.from <= dateStr) ?? eras[0];
  const { rules, ...rest } = config;
  return { ...rest, ...era };
}

// Each neighbor list cut to the step limit. The lists are sorted by
// similarity, so the first 20 ARE the top 20 (Python: ladder_view).
export const cutNeighbors = (neighbors, k) => neighbors.map((row) => row.slice(0, k));

// Legal steps when links work both ways: a word's own top k, then every word
// that has it in ITS top k, ordered by the rank that word gives it, then by
// index. Python twin: two_way_neighbors (same order, so seeded picks match).
export function twoWayNeighbors(full, k) {
  const extra = full.map(() => []);
  full.forEach((row, u) => {
    const n = Math.min(k, row.length);
    for (let r = 0; r < n; r++) extra[row[r]].push([r, u]);
  });
  return full.map((row, v) => {
    const own = row.slice(0, k);
    const seen = new Set(own);
    extra[v].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, u] of extra[v]) if (!seen.has(u)) { seen.add(u); own.push(u); }
    return own;
  });
}

// ConceptNet relations between GloVe neighbors (data/relations_vN.*), one
// key per unordered pair. Python twins: rel_key, linked_steps.
export const REL_KEY = 65536;
export const relKey = (a, b) => (a < b ? a * REL_KEY + b : b * REL_KEY + a);

// The most steps that are relations on any SHORTEST route start -> goal
// (undirected two-way graphs): BFS layers from the goal, then the best count
// per word from the layer below.
export function linkedSteps(neighbors, related, start, goal, par) {
  if (par < 1) return 0;
  const dist = new Map([[goal, 0]]);
  const layers = [[goal]];
  for (let d = 1; d <= par; d++) {
    const nxt = [];
    for (const u of layers[d - 1]) for (const v of neighbors[u]) if (!dist.has(v)) { dist.set(v, d); nxt.push(v); }
    layers.push(nxt);
  }
  if (dist.get(start) !== par) return 0;
  const best = new Map([[goal, 0]]);
  for (let d = 1; d <= par; d++) {
    for (const u of layers[d]) {
      let b = -1;
      for (const v of neighbors[u]) {
        if (dist.get(v) !== d - 1) continue;
        const c = (related.has(relKey(u, v)) ? 1 : 0) + best.get(v);
        if (c > b) b = c;
      }
      best.set(u, b);
    }
  }
  return best.get(start);
}

// Closer first moves on an UNDIRECTED graph (two-way eras): one BFS from the
// goal, depth par - 1. Two-way lists can exceed the 31 first moves the bit
// masks in bfsRouteStats track. Python twin: closer_first_moves.
export function closerFirstMoves(neighbors, start, goal, par) {
  if (par < 1) return 0;
  const dist = new Map([[goal, 0]]);
  let frontier = [goal];
  for (let d = 1; d < par; d++) {
    const nxt = [];
    for (const u of frontier) for (const v of neighbors[u]) if (!dist.has(v)) { dist.set(v, d); nxt.push(v); }
    frontier = nxt;
  }
  return neighbors[start].filter((v) => dist.get(v) === par - 1).length;
}

// For every word, how many words have it among their legal steps (Python:
// in_degrees). A goal few words point to is often reachable only through
// one unexpected sense, so eras with "minGoalInDegree" skip such goals.
export function inDegrees(neighbors) {
  const deg = new Int32Array(neighbors.length);
  for (const row of neighbors) for (const v of row) deg[v]++;
  return deg;
}

// An era may drop words from the frozen candidates list (rules.excludeCandidates
// names a data/candidates_exclude_<era>.json file). Python twins:
// ladder_core.excluded_words and candidate_pool. The pool keeps the original
// sorted order, because the seeded pick indexes into it.
export const excludedWords = (excludeFile) => new Set(Object.values(excludeFile.categories).flat());
export const candidatePool = (candidates, excluded) => candidates.filter((w) => !excluded.has(w));

export function levelBand(level, config) {
  return { ...config.levels[level], level };
}

// Python twins: wants_closer and closer_fits. Only newer eras set these limits.
const wantsCloser = (band) => "minCloserFirstMoves" in band || "maxCloserFirstMoves" in band;
export const closerFits = (band, closer) =>
  (band.minCloserFirstMoves ?? 0) <= closer && closer <= (band.maxCloserFirstMoves ?? Infinity);

// What the seeded fallback hashes: one independent stream per date AND level
// (Python: ladder_core.seed_base). e.g. "2026-11-12:hard".
export const seedBase = (dateStr, level) => `${dateStr}:${level}`;

// ------------------------------------------------------------ seeded puzzle
// ladder = { index: Map(word -> i), neighbors, candidates (sorted), config,
//            inDegree? (precomputed per view; counted here if missing) }
function check(ladder, start, goal, band, checkRoutes, inDeg) {
  const { config } = ladder;
  if (start === goal) return null;
  if (inDeg && inDeg[ladder.index.get(goal)] < config.minGoalInDegree) return null;
  const i = ladder.index.get(start);
  const twoWay = Boolean(config.twoWay);
  if (wantsCloser(band) && !twoWay && ladder.neighbors[i].length > MAX_TRACKED_FIRST_MOVES) {
    // Python counts any number; the two must agree, so refuse like Python does.
    throw new Error(`closer-first-move bands need stepLimit <= ${MAX_TRACKED_FIRST_MOVES}`);
  }
  // Depth capped at band.par: deeper pairs fail the par check below anyway, so
  // the chosen puzzle is the same as Python's uncapped validate_pair picks.
  const stats = bfsRouteStats(ladder.neighbors, i, ladder.index.get(goal), band.par);
  const { par, routes } = stats;
  if (par === null || par < config.minPar || par > config.maxPar) return null;
  if (par !== band.par) return null;
  if (checkRoutes && (routes < band.minRoutes || routes > band.maxRoutes)) return null;
  // Never relaxed (unlike routes): it is what keeps the level label honest.
  const closer = twoWay ? closerFirstMoves(ladder.neighbors, i, ladder.index.get(goal), par) : stats.closer;
  if (wantsCloser(band) && !closerFits(band, closer)) return null;
  // Newer eras want a shortest route whose steps are mostly real relations.
  if (band.minLinkedSteps != null) {
    if (!ladder.related) throw new Error("minLinkedSteps needs data/relations_vN.*");
    if (linkedSteps(ladder.neighbors, ladder.related, i, ladder.index.get(goal), par) < band.minLinkedSteps) return null;
  }
  return { par, routes, closer };
}

export function seededPuzzle(ladder, dateStr, band) {
  const cands = ladder.candidates;
  const n = cands.length;
  // Counted once per call at most, never per pair. Older eras have no
  // minGoalInDegree, so they skip the check exactly like Python does.
  const inDeg = ladder.config.minGoalInDegree
    ? ladder.inDegree ?? inDegrees(ladder.neighbors) : null;
  for (let attempt = 0; attempt < GIVE_UP_AFTER; attempt++) {
    const rand = mulberry32(fnv1a32(`${dateStr}#${attempt}`));
    const start = cands[Math.floor(rand() * n)];
    const goal = cands[Math.floor(rand() * n)];
    const ok = check(ladder, start, goal, band, attempt < RELAX_AFTER, inDeg);
    if (ok) return { start, goal, par: ok.par, routes: ok.routes, closer: ok.closer, attempt };
  }
  throw new Error(`no seeded puzzle for ${dateStr}`);
}

// ------------------------------------------------------------ chain mode
// From the 2026-11-15 era ("mode": "chain") a ladder is one fixed chain of
// par + 1 words with ONE answer per hidden rung, shown as its first letter
// and length. Python twins: the "chain mode" section of ladder_core.py.

// Two forms of one word (ship/ships, swim/swimming), roughly. Python: same_stem.
export function sameStem(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

// The better of b's place in a's list and a's in b's, 1 = most similar
// (null = in neither). The browser's lists stop at 40; callers only compare
// against ranks <= 40, so the answer matches Python's top-100 one.
export function chainRank(ladder, a, b) {
  const full = ladder.fullNeighbors ?? ladder.neighbors;
  const ra = full[a].indexOf(b), rb = full[b].indexOf(a);
  const ranks = [ra, rb].filter((r) => r >= 0).map((r) => r + 1);
  return ranks.length ? Math.min(...ranks) : null;
}

// Every word's close words both ways (top uniqueWindow, default 40), built
// once per ladder view: the words a player could reasonably try for a rung.
export function chainWide(ladder) {
  const full = ladder.fullNeighbors ?? ladder.neighbors;
  const k = ladder.config?.uniqueWindow ?? 40;
  if (ladder._wide?.k !== k) ladder._wide = { k, rows: twoWayNeighbors(full, k) };
  return ladder._wide.rows;
}

// Close words of `prev` that fit the target's pattern too (same first letter
// and length), other than words on screen (`shown`, a Set). Python: pattern_rivals.
export function patternRivals(ladder, prev, target, shown) {
  const w = ladder.words[target];
  return chainWide(ladder)[prev].filter((u) => u !== target && !shown.has(u)
    && ladder.words[u].length === w.length && ladder.words[u][0] === w[0]);
}

// Is this chain a fair one-answer ladder for the band? Python: validate_chain
// (which also checks recent words and the AI's link kinds).
export function validateChain(ladder, words, band) {
  const par = band.par;
  if (words.length !== par + 1) return { ok: false, reason: "length" };
  if (!words.every((w) => ladder.index.has(w))) return { ok: false, reason: "unknown word" };
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) if (sameStem(words[i], words[j])) return { ok: false, reason: "forms of one word" };
  }
  const cands = (ladder._candSet ??= new Set(ladder.candidates));
  if (!cands.has(words[0]) || !cands.has(words[par])) return { ok: false, reason: "start/goal" };
  const idx = words.map((w) => ladder.index.get(w));
  if (band.maxWordIndex && idx.slice(1, -1).some((i) => i >= band.maxWordIndex)) return { ok: false, reason: "too rare" };
  let linked = 0;
  for (let k = 0; k < par; k++) {
    const rank = chainRank(ladder, idx[k], idx[k + 1]);
    if (rank == null || rank > band.maxRank) return { ok: false, reason: "too loose" };
    if (ladder.related?.has(relKey(idx[k], idx[k + 1]))) linked++;
  }
  const shown = new Set([idx[0], idx[par]]);
  for (let k = 1; k < par; k++) {
    if (patternRivals(ladder, idx[k - 1], idx[k], shown).length) return { ok: false, reason: "rivals" };
  }
  if (linked < (band.minLinkedSteps ?? 0)) return { ok: false, reason: "linked" };
  return { ok: true, linked };
}

// Links for seeded chains: two-way top k between start/goal-pool words only,
// most similar first. Python: chain_graph.
export function chainGraph(ladder, k, common) {
  ladder._chainGraphs ??= new Map();
  const key = `${k}|${common ?? ""}`;
  if (!ladder._chainGraphs.has(key)) {
    const ok = new Set();
    for (const w of ladder.candidates) {
      const i = ladder.index.get(w);
      if (common == null || i < common) ok.add(i);
    }
    const two = twoWayNeighbors(ladder.fullNeighbors ?? ladder.neighbors, k);
    ladder._chainGraphs.set(key, two.map((row, u) => (ok.has(u) ? row.filter((v) => ok.has(v)) : [])));
  }
  return ladder._chainGraphs.get(key);
}

// A route of exactly `par` steps through `graph`, each step one closer to
// the goal, whose hidden rungs have no pattern rivals, with the most
// ConceptNet steps (ties: the more similar neighbor). Python: chain_route.
export function chainRoute(ladder, graph, start, goal, par) {
  const dist = new Map([[goal, 0]]);
  let frontier = [goal];
  for (let d = 1; d <= par; d++) {
    const nxt = [];
    for (const u of frontier) for (const v of graph[u]) if (!dist.has(v)) { dist.set(v, d); nxt.push(v); }
    frontier = nxt;
  }
  if (dist.get(start) !== par) return null;
  const shown = new Set([start, goal]);
  const memo = new Map([[goal, [0, -1]]]);
  const best = (u) => {
    if (!memo.has(u)) {
      let b = -1, pick = -1;
      for (const v of graph[u]) {
        if (dist.get(v) !== dist.get(u) - 1) continue;
        if (v !== goal && patternRivals(ladder, u, v, shown).length) continue;
        let c = best(v);
        if (c < 0) continue;
        if (ladder.related?.has(relKey(u, v))) c++;
        if (c > b) { b = c; pick = v; }
      }
      memo.set(u, [b, pick]);
    }
    return memo.get(u)[0];
  };
  const linked = best(start);
  if (linked < 0) return null;
  const route = [start];
  while (route[route.length - 1] !== goal) route.push(memo.get(route[route.length - 1])[1]);
  return { route, linked };
}

// Deterministic chain (missing daily files, Unlimited). Python: seeded_chain.
export function seededChain(ladder, seed, band) {
  const graph = chainGraph(ladder, band.maxRank, band.maxWordIndex);
  const cands = ladder.candidates, n = cands.length;
  for (let attempt = 0; attempt < GIVE_UP_AFTER; attempt++) {
    const rand = mulberry32(fnv1a32(`${seed}#${attempt}`));
    const start = cands[Math.floor(rand() * n)];
    const goal = cands[Math.floor(rand() * n)];
    if (start === goal) continue;
    const found = chainRoute(ladder, graph, ladder.index.get(start), ladder.index.get(goal), band.par);
    if (!found) continue;
    const words = found.route.map((i) => ladder.words[i]);
    const v = validateChain(ladder, words, band);
    if (v.ok) return { route: words, linked: v.linked, attempt };
  }
  throw new Error(`no seeded chain for ${seed}`);
}

// Plain reasons for seeded chains from the ConceptNet relation; the pair is
// unordered, so each phrase reads both ways. Python: chain_reason(s).
const RELATION_PHRASES = {
  IsA: "one is a kind of the other",
  PartOf: "one is part of the other",
  HasA: "one is part of the other",
  UsedFor: "one is used for the other",
  AtLocation: "you find one near the other",
  LocatedNear: "you find one near the other",
  MadeOf: "one is made from the other",
  Causes: "one leads to the other",
  Synonym: "they are close in meaning",
  SimilarTo: "they are close in meaning",
};

export const chainReason = (a, b, relation) =>
  `${a[0].toUpperCase()}${a.slice(1)} and ${b}: ${RELATION_PHRASES[relation] ?? "they often go together"}.`;

// ladder.related is a Map relKey -> relation name (js/data.js).
export function chainReasons(ladder, words) {
  return words.slice(1).map((b, k) => {
    const a = words[k];
    const rel = ladder.related?.get?.(relKey(ladder.index.get(a), ladder.index.get(b)));
    return chainReason(a, b, rel);
  });
}
