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

// Little-endian uint16 rows (scripts/build_graph_bin.py) -> one array per word.
// DataView reads the byte order explicitly, so this is right on any CPU.
async function getRows(url, count, width) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { status: res.status });
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== count * width * 2) throw new Error(`${url}: unexpected size`);
  const view = new DataView(buf);
  const rows = new Array(count);
  for (let i = 0, o = 0; i < count; i++) {
    const row = new Array(width);
    for (let k = 0; k < width; k++, o += 2) row[k] = view.getUint16(o, true);
    rows[i] = row;
  }
  return rows;
}

// The word map, in two parts. The head (each word's 20 closest words,
// ~0.8 MB) is all today's rules need, so a game starts after that alone.
// The tail (ranks 21-100, ~3 MB) loads only when something needs it: an
// archive game from the top-100 era, or exact ranks in the Tried list.
let ladderPromise = null;
export function loadLadder() {
  return (ladderPromise ??= (async () => {
    const config = await loadConfig();
    const v = config.graphVersion;
    const [meta, cands] = await Promise.all([
      getJson(`data/graph_v${v}_words.json`),
      getJson(`data/candidates_v${v}.json`),
    ]);
    const head = await getRows(`data/graph_v${v}_head.bin`, meta.count, meta.head);
    const base = {
      words: meta.words,
      index: new Map(meta.words.map((w, i) => [w, i])),
      neighbors: head, // grows to the full top-100 lists once the tail arrives
      complete: false, // true once the tail is in
      candidates: cands.words,
      config,
      views: new Map(),
    };
    let tailPromise = null;
    base.loadFull = () => (tailPromise ??= getRows(`data/graph_v${v}_tail.bin`, meta.count, meta.tail)
      .then((tail) => {
        const full = head.map((row, i) => row.concat(tail[i]));
        base.neighbors = full;
        base.complete = true;
        for (const view of base.views.values()) view.fullNeighbors = full; // exact ranks from now on
      })
      .catch((err) => { tailPromise = null; throw err; }));
    return base;
  })().catch((err) => {
    ladderPromise = null; // don't cache a failure: let the next attempt retry
    throw err;
  }));
}

// Waits for the tail only when a step limit is wider than what's loaded.
async function ensureWidth(base, k) {
  if (base.complete === false && k > base.neighbors[0].length) await base.loadFull();
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
  if (base.complete === false && k > base.neighbors[0].length) throw new Error(`stepLimit ${k} needs the full word map: await readyFor first`);
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
function puzzleRules(base, puzzle) {
  const rules = rulesFor(base.config, puzzle.date ?? (puzzle.stepLimit == null ? base.config.launchDate : null));
  return { rules, k: puzzle.stepLimit ?? rules.stepLimit ?? DEFAULT_STEP_LIMIT };
}

// Await before ladderFor: loads the tail if this puzzle's rules need it.
export const readyFor = (base, puzzle) => ensureWidth(base, puzzleRules(base, puzzle).k);

export function ladderFor(base, puzzle) {
  const { rules, k } = puzzleRules(base, puzzle);
  if (k !== rules.stepLimit) console.warn(`Puzzle says stepLimit ${k}; its date's rules say ${rules.stepLimit}. Using ${k}.`);
  return viewOf(base, { ...rules, stepLimit: k });
}

// One level of a day's puzzle (puzzles/YYYY-MM-DD-<level>.json), or the
// identical-everywhere seeded fallback if the file is missing.
export async function loadDailyPuzzle(base, dateStr, level) {
  await ensureWidth(base, rulesFor(base.config, dateStr).stepLimit ?? DEFAULT_STEP_LIMIT);
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
export async function makePracticePuzzle(base, level) {
  await ensureWidth(base, rulesFor(base.config, null).stepLimit ?? DEFAULT_STEP_LIMIT);
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
  const schema = store.get("schema", 1);
  if (schema < 2) migrateToLevels();
  if (schema < 3) {
    migratePracticePerLevel();
    store.set("schema", 3);
  }
}

// Schema 3: Unlimited used one "practice" key for every level, so picking
// another level threw the game in progress away. Each level now has its own
// "practice:<level>"; the old save moves to the level it was played at.
function migratePracticePerLevel() {
  const practice = store.get("practice");
  if (practice?.puzzle) {
    const level = LEVELS.includes(practice.puzzle.level) ? practice.puzzle.level : levelOfOldPuzzle(practice.puzzle);
    if (store.get(`practice:${level}`) === null) {
      store.set(`practice:${level}`, { ...practice, puzzle: { ...practice.puzzle, level } });
    }
  }
  store.remove("practice");
}

function migrateToLevels() {
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
  // (A level-less "practice" save gets its level in migratePracticePerLevel.)
  store.set("schema", 2);
}

export { LEVELS };
