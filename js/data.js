// Loading data over the network, and saving progress in the browser.
import { buildReverse } from "./logic.js";
import { bandFor, gameNumber, seededPuzzle } from "./seeded.js";

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" }); // revalidate; puzzles appear daily
  if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

let configPromise = null;
export function loadConfig() {
  return (configPromise ??= getJson("puzzle_config.json"));
}

// The 4.7 MB word map. Fetched once, then reused for every game in the session.
let ladderPromise = null;
export function loadLadder() {
  return (ladderPromise ??= (async () => {
    const config = await loadConfig();
    const v = config.graphVersion;
    const [graph, cands] = await Promise.all([
      getJson(`data/graph_v${v}.json`),
      getJson(`data/candidates_v${v}.json`),
    ]);
    return {
      words: graph.words,
      index: new Map(graph.words.map((w, i) => [w, i])),
      neighbors: graph.neighbors,
      reverse: buildReverse(graph.neighbors),
      candidates: cands.words,
      config,
    };
  })().catch((err) => {
    ladderPromise = null; // don't cache a failure: let the next attempt retry
    throw err;
  }));
}

// Today's puzzle file, or the identical-everywhere seeded fallback if the
// file is missing (or can't be fetched).
export async function loadDailyPuzzle(ladder, dateStr) {
  const { config } = ladder;
  try {
    const p = await getJson(`puzzles/${dateStr}.json`);
    if (p.graphVersion === config.graphVersion && ladder.index.has(p.start) && ladder.index.has(p.goal)) {
      return p;
    }
    console.warn("Puzzle file doesn't match this word map; using the seeded puzzle.", p);
  } catch (err) {
    if (err.status !== 404) console.warn("Couldn't load puzzle file; using the seeded puzzle.", err);
  }
  const band = bandFor(dateStr, config);
  const s = seededPuzzle(ladder, dateStr, band);
  return {
    date: dateStr,
    gameNumber: gameNumber(dateStr, config.launchDate),
    start: s.start, goal: s.goal, par: s.par,
    theme: "Daily ladder", teaser: "",
    source: "seeded", graphVersion: config.graphVersion, difficulty: band.label,
  };
}

// Practice: a random seed fed through the same seeded generator.
export function makePracticePuzzle(ladder) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const weekdays = Object.keys(ladder.config.bands);
  const weekday = weekdays[seed % weekdays.length];
  const band = { ...ladder.config.bands[weekday], weekday };
  const s = seededPuzzle(ladder, `practice-${seed}`, band);
  return {
    date: null, gameNumber: null, start: s.start, goal: s.goal, par: s.par,
    theme: "Practice ladder", teaser: `Difficulty: ${band.label}.`, source: "practice",
    graphVersion: ladder.config.graphVersion, difficulty: band.label,
  };
}

// ------------------------------------------------------------ storage
// localStorage can throw (private mode, storage full, blocked cookies), so
// every access is wrapped. The game still works, it just won't remember.
const PREFIX = "meaning-ladder:";

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* not fatal */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* not fatal */
    }
  },
};
