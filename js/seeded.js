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
  if (start === goal) return { par: 0, routes: 1 };
  const dist = new Map([[start, 0]]);
  const routes = new Map([[start, 1]]);
  let frontier = [start];
  let d = 0;
  while (frontier.length) {
    d += 1;
    const next = [];
    for (const u of frontier) {
      const ru = routes.get(u);
      for (const v of neighbors[u]) {
        const dv = dist.get(v);
        if (dv === undefined) {
          dist.set(v, d);
          routes.set(v, ru);
          next.push(v);
        } else if (dv === d) {
          routes.set(v, routes.get(v) + ru);
        }
      }
    }
    if (dist.has(goal)) return { par: d, routes: routes.get(goal) };
    frontier = next;
  }
  return { par: null, routes: 0 };
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
  const { par, routes } = bfsRoutes(ladder.neighbors, ladder.index.get(start), ladder.index.get(goal));
  if (par === null || par < config.minPar || par > config.maxPar) return null;
  if (par !== band.par) return null;
  if (checkRoutes && (routes < band.minRoutes || routes > band.maxRoutes)) return null;
  return { par, routes };
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
    if (ok) return { start, goal, par: ok.par, routes: ok.routes, attempt };
  }
  throw new Error(`no seeded puzzle for ${dateStr}`);
}
