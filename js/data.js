// Loading data over the network, and saving progress in the browser.
import { buildReverse } from "./logic.js";
import { DEFAULT_STEP_LIMIT, LEVELS, cutNeighbors, gameNumber, levelBand, rulesFor, seedBase, seededPuzzle } from "./seeded.js";

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
      neighbors: graph.neighbors, // the full top-100 lists; games use ladderAt/ladderFor views
      candidates: cands.words,
      config,
      views: new Map(),
    };
  })().catch((err) => {
    ladderPromise = null; // don't cache a failure: let the next attempt retry
    throw err;
  }));
}

// Compact word vectors (data/vectors_vN.bin, 64 bytes per word), used only to
// rank wrong guesses. Loaded on the first wrong guess, then cached.
let vectorsPromise = null;
export function loadVectors() {
  return (vectorsPromise ??= (async () => {
    const config = await loadConfig();
    const v = config.graphVersion;
    const header = await getJson(`data/vectors_v${v}.json`);
    const res = await fetch(`data/vectors_v${v}.bin`);
    if (!res.ok) throw new Error(`vectors: HTTP ${res.status}`);
    const data = new Int8Array(await res.arrayBuffer());
    if (data.length !== header.count * header.dims) throw new Error("vectors: unexpected size");
    const norms = new Float32Array(header.count);
    for (let i = 0; i < header.count; i++) {
      let sum = 0;
      for (let k = 0; k < header.dims; k++) sum += data[i * header.dims + k] ** 2;
      norms[i] = Math.sqrt(sum);
    }
    return { data, dims: header.dims, count: header.count, norms };
  })().catch((err) => {
    vectorsPromise = null; // let the next wrong guess retry
    throw err;
  }));
}

// ------------------------------------------------------------ rules views
// The base ladder holds every word's full top-100 list. A view applies one
// era's rules: neighbor lists cut to stepLimit (the legal steps), a reverse
// index for those, the full lists kept for exact near-miss ranks, and the
// merged config (levels, par range). Cached per era, since cutting and
// reversing 20k lists takes a few tens of ms.
function viewOf(base, rules) {
  const k = rules.stepLimit ?? DEFAULT_STEP_LIMIT;
  const key = `${rules.from ?? ""}|${k}`;
  let view = base.views.get(key);
  if (!view) {
    const neighbors = k >= base.neighbors[0].length ? base.neighbors : cutNeighbors(base.neighbors, k);
    view = { ...base, neighbors, fullNeighbors: base.neighbors, reverse: buildReverse(neighbors),
             config: { ...rules, stepLimit: k } };
    base.views.set(key, view);
  }
  return view;
}

// The rules for a date (null = the newest rules, used by Unlimited).
export const ladderAt = (base, dateStr) => viewOf(base, rulesFor(base.config, dateStr));

// The rules a puzzle was made under. Daily puzzles go by date; the file's own
// stepLimit wins if it disagrees. Unlimited puzzles carry their stepLimit;
// one saved before stepLimit existed was played on the original top 100.
export function ladderFor(base, puzzle) {
  const rules = rulesFor(base.config, puzzle.date ?? (puzzle.stepLimit == null ? base.config.launchDate : null));
  const k = puzzle.stepLimit ?? rules.stepLimit ?? DEFAULT_STEP_LIMIT;
  if (k !== rules.stepLimit) console.warn(`Puzzle says stepLimit ${k}; its date's rules say ${rules.stepLimit}. Using ${k}.`);
  return viewOf(base, { ...rules, stepLimit: k });
}

// One level of a day's puzzle (puzzles/YYYY-MM-DD-<level>.json), or the
// identical-everywhere seeded fallback if the file is missing.
export async function loadDailyPuzzle(base, dateStr, level) {
  const ladder = ladderAt(base, dateStr);
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
    source: "seeded", graphVersion: config.graphVersion, stepLimit: config.stepLimit,
  };
}

// Unlimited: a random seed fed through the same seeded generator, at the
// level the player picked.
export function makePracticePuzzle(base, level) {
  const ladder = ladderAt(base, null);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const band = levelBand(level, ladder.config);
  const s = seededPuzzle(ladder, `practice-${seed}`, band);
  return {
    date: null, gameNumber: null, level, start: s.start, goal: s.goal, par: s.par,
    theme: "Unlimited ladder", teaser: `Level: ${band.label}.`, source: "practice",
    graphVersion: ladder.config.graphVersion, stepLimit: ladder.config.stepLimit,
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
