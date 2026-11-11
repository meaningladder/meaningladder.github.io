// Loading data over the network, and saving progress in the browser.
import { buildReverse } from "./logic.js";
import { LEVELS, gameNumber, levelBand, seedBase, seededPuzzle } from "./seeded.js";

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

// One level of a day's puzzle (puzzles/YYYY-MM-DD-<level>.json), or the
// identical-everywhere seeded fallback if the file is missing.
export async function loadDailyPuzzle(ladder, dateStr, level) {
  const { config } = ladder;
  try {
    const p = await getJson(`puzzles/${dateStr}-${level}.json`);
    if (p.graphVersion === config.graphVersion && ladder.index.has(p.start) && ladder.index.has(p.goal)) {
      return p;
    }
    console.warn("Puzzle file doesn't match this word map; using the seeded puzzle.", p);
  } catch (err) {
    if (err.status !== 404) console.warn("Couldn't load puzzle file; using the seeded puzzle.", err);
  }
  const s = seededPuzzle(ladder, seedBase(dateStr, level), levelBand(level, config));
  return {
    date: dateStr, level,
    gameNumber: gameNumber(dateStr, config.launchDate),
    start: s.start, goal: s.goal, par: s.par,
    theme: "Daily ladder", teaser: "",
    source: "seeded", graphVersion: config.graphVersion,
  };
}

// Unlimited: a random seed fed through the same seeded generator, at the
// level the player picked.
export function makePracticePuzzle(ladder, level) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const band = levelBand(level, ladder.config);
  const s = seededPuzzle(ladder, `practice-${seed}`, band);
  return {
    date: null, gameNumber: null, level, start: s.start, goal: s.goal, par: s.par,
    theme: "Unlimited ladder", teaser: `Level: ${band.label}.`, source: "practice",
    graphVersion: ladder.config.graphVersion,
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
  // Every stored key (without the prefix) that starts with `start`.
  keys(start = "") {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(PREFIX + start)) out.push(k.slice(PREFIX.length));
      }
    } catch {
      /* not fatal */
    }
    return out;
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* not fatal */
    }
  },
};

// ------------------------------------------------------------ migration
// Before levels existed, a day had ONE puzzle, saved as "game:<date>" with a
// result under "results[<date>]". Move them to "game:<date>:<level>" and
// "results[<date>:<level>]", picking the level from the saved puzzle.
const OLD_DIFFICULTY_TO_LEVEL = {
  easy: "easy", medium: "medium", tricky: "medium",
  hard: "hard", "very hard": "hard", expert: "hard",
};

export function levelOfOldPuzzle(puzzle) {
  return OLD_DIFFICULTY_TO_LEVEL[puzzle?.difficulty] ?? (puzzle?.par >= 4 ? "hard" : "medium");
}

export function migrateStorage() {
  if (store.get("schema", 1) >= 2) return;
  const results = store.get("results", {});
  const levelOfDate = {};
  for (const key of store.keys("game:")) {
    const date = key.slice("game:".length);
    if (date.includes(":")) continue; // already per-level
    const state = store.get(key);
    if (state?.puzzle) {
      const level = levelOfOldPuzzle(state.puzzle);
      levelOfDate[date] = level;
      store.set(`game:${date}:${level}`, { ...state, puzzle: { ...state.puzzle, level } });
    }
    store.remove(key);
  }
  for (const [key, r] of Object.entries(results)) {
    if (key.includes(":")) continue;
    delete results[key];
    results[`${key}:${levelOfDate[key] ?? (r.par >= 4 ? "hard" : "medium")}`] = r;
  }
  store.set("results", results);
  const practice = store.get("practice");
  if (practice?.puzzle && !practice.puzzle.level) {
    store.set("practice", { ...practice, puzzle: { ...practice.puzzle, level: levelOfOldPuzzle(practice.puzzle) } });
  }
  store.set("schema", 2);
}

export { LEVELS };
