// Seeded puzzle logic: a line-for-line port of scripts/ladder_core.py.
// The browser uses this when a puzzle file is missing, and for Practice mode.
// If you change one side, change the other, then run both test suites:
//   python scripts/make_fixtures.py && pytest -q && node --test tests/js/

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
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

export function bandFor(dateStr, config) {
  const jsDay = new Date(utcMs(dateStr)).getUTCDay(); // 0 = Sunday
  const weekday = WEEKDAYS[(jsDay + 6) % 7];          // Python: 0 = Monday
  return { ...config.bands[weekday], weekday };
}

// ------------------------------------------------------------ seeded puzzle
// ladder = { index: Map(word -> i), neighbors, candidates (sorted), config }
function check(ladder, start, goal, band, checkRoutes) {
  const { config } = ladder;
  if (start === goal) return null;
  const { par, routes } = bfsRoutes(ladder.neighbors, ladder.index.get(start), ladder.index.get(goal));
  if (par === null || par < config.minPar || par > config.maxPar) return null;
  if (par !== band.par) return null;
  if (checkRoutes && (routes < band.minRoutes || routes > band.maxRoutes)) return null;
  return { par, routes };
}

export function seededPuzzle(ladder, dateStr, band) {
  const cands = ladder.candidates;
  const n = cands.length;
  for (let attempt = 0; attempt < GIVE_UP_AFTER; attempt++) {
    const rand = mulberry32(fnv1a32(`${dateStr}#${attempt}`));
    const start = cands[Math.floor(rand() * n)];
    const goal = cands[Math.floor(rand() * n)];
    const ok = check(ladder, start, goal, band, attempt < RELAX_AFTER);
    if (ok) return { start, goal, par: ok.par, routes: ok.routes, attempt };
  }
  throw new Error(`no seeded puzzle for ${dateStr}`);
}
