// Loading data over the network, and saving progress in the browser.
import { buildReverse, distancesToGoal, guideRoute } from "./logic.js";
import { ACCEPT_WIDTH, DEFAULT_STEP_LIMIT, LEVELS, candidatePool, cutNeighbors, dropSteps, relKey, twoWayNeighbors, excludedWords, gameNumber, inDegrees, informativeKeys, levelBand, mulberry32, patternRivals, puzzleFile, rulesFor, seedBase, seededLinkedPuzzle } from "./seeded.js";

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

// ConceptNet relations between GloVe neighbors (scripts/build_relations.py):
// a Map relKey(u, v) -> {rel, from} ("IsA", the word index the edge starts at or null), which hint routes prefer.
// About 120 KB, cached by name like the graph.
async function loadRelations(v) {
  const header = await getJson(`data/relations_v${v}.json`);
  const res = await fetch(`data/relations_v${v}.bin`);
  if (!res.ok) throw new Error(`relations: HTTP ${res.status}`);
  const view = new DataView(await res.arrayBuffer());
  const n = header.count;
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const u = view.getUint16(4 * i, true), w = view.getUint16(4 * i + 2, true);
    const d = header.layout === "directed" ? view.getUint8(5 * n + i) : 2;
    map.set(relKey(u, w), { rel: header.relations[view.getUint8(4 * n + i)], from: d === 2 ? null : d === 0 ? u : w });
  }
  return map;
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
    // Every era's start/goal exclusion file (a few KB each). Loaded up front,
    // not per era, so views stay synchronous; a missing file must fail
    // loudly, since the seeded puzzles depend on the exact pool.
    const excludePaths = [...new Set((config.rules ?? []).map((e) => e.excludeCandidates).filter(Boolean))];
    const [meta, cands, removedFile, ...excludeFiles] = await Promise.all([
      getJson(`data/graph_v${v}_wide.json`),
      getJson(`data/candidates_v${v}.json`),
      config.removedSteps ? getJson(config.removedSteps) : null,
      ...excludePaths.map((p) => getJson(p)),
    ]);
    const [head, related] = await Promise.all([
      getRows(`data/graph_v${v}_wide_head.bin`, meta.count, meta.head),
      loadRelations(config.relations ?? v),
    ]);
    const base = {
      words: meta.words,
      index: new Map(meta.words.map((w, i) => [w, i])),
      neighbors: head, // grows to the full top-100 lists once the tail arrives
      complete: false, // true once the tail is in
      candidates: cands.words, // the whole frozen list; a view may drop some
      exclusions: new Map(excludePaths.map((p, i) => [p, excludedWords(excludeFiles[i])])),
      // Words no ladder may use (config "removedSteps"): junk and obscure words.
      removed: removedFile ? excludedWords(removedFile) : new Set(),
      config,
      related, // ConceptNet pairs (relKey -> {rel, from}): clue text, never judge steps
      linked: informativeKeys(related), // the pairs a clue can explain: what routes count
      views: new Map(),
    };
    let tailPromise = null;
    base.loadFull = () => (tailPromise ??= getRows(`data/graph_v${v}_wide_tail.bin`, meta.count, meta.tail)
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
  const twoWay = Boolean(rules.twoWay);
  const key = `${rules.from ?? ""}|${k}|${twoWay ? "both" : "one"}`;
  let view = base.views.get(key);
  if (!view) {
    // Two-way eras: a link counts if either word is in the other's top k.
    const removed = base.removed ?? new Set();
    const gone = new Set([...removed].map((w) => base.index.get(w)).filter((i) => i !== undefined));
    const neighbors = dropSteps(twoWay ? twoWayNeighbors(base.neighbors, k)
      : k >= base.neighbors[0].length ? base.neighbors : cutNeighbors(base.neighbors, k), gone);
    // Same pool rule as Python's ladder_view: the era's exclusions plus removed words.
    const excluded = new Set([...(rules.excludeCandidates ? base.exclusions.get(rules.excludeCandidates) : []), ...removed]);
    const candidates = excluded.size ? candidatePool(base.candidates, excluded) : base.candidates;
    view = { ...base, neighbors, wide: dropSteps(base.neighbors, gone), fullNeighbors: base.neighbors, reverse: buildReverse(neighbors),
             inDegree: inDegrees(neighbors), candidates, config: { ...rules, stepLimit: k, twoWay } };
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
  const k = puzzle.stepLimit ?? rules.stepLimit ?? DEFAULT_STEP_LIMIT;
  // Daily puzzles go by their date's rules. An Unlimited game saved before
  // two-way links existed has no stamp: it keeps one-way links.
  const twoWay = puzzle.twoWay ?? (puzzle.date ? Boolean(rules.twoWay) : false);
  return { rules: { ...rules, twoWay }, k };
}

// Await before ladderFor: loads the tail if this puzzle's rules need it.
export const readyFor = (base, puzzle) => ensureWidth(base, Math.max(puzzleRules(base, puzzle).k, ACCEPT_WIDTH));

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
    const p = await getJson(puzzleFile(dateStr, level));
    if (p.graphVersion === config.graphVersion && ladder.index.has(p.start) && ladder.index.has(p.goal)) {
      return p;
    }
    console.warn("Puzzle file doesn't match this word map; using the seeded puzzle.", p);
  } catch (err) {
    if (err.status !== 404) console.warn("Couldn't load puzzle file; using the seeded puzzle.", err);
  }
  const s = seededLinkedPuzzle(ladder, seedBase(dateStr, level), levelBand(level, config));
  return {
    date: dateStr, level,
    gameNumber: gameNumber(dateStr, config.launchDate),
    start: s.start, goal: s.goal, par: s.par,
    theme: "Daily ladder", teaser: "",
    source: "seeded", graphVersion: config.graphVersion, stepLimit: config.stepLimit, twoWay: Boolean(config.twoWay),
  };
}

// Unlimited: a random seed fed through the same seeded generator, at the
// level the player picked, played as a chain (one hidden word per rung).
export async function makePracticePuzzle(base, level) {
  await ensureWidth(base, Math.max(rulesFor(base.config, null).stepLimit ?? DEFAULT_STEP_LIMIT, ACCEPT_WIDTH));
  return chainPuzzle(ladderAt(base, null), level, crypto.getRandomValues(new Uint32Array(1))[0]);
}

// A chain puzzle from a seed (deterministic). The route is guideRoute's
// readable shortest one; each hidden word shows one letter, at a position
// where none of the previous word's close words (patternRivals) fit. A route
// with a word that has rivals everywhere is retried with a new seed up to 20
// times, then the one with the fewest rivals is kept.
export function chainPuzzle(ladder, level, seed) {
  const rand = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const band = levelBand(level, ladder.config);
  let best = null;
  for (let attempt = 0; attempt < 20 && !(best?.rivals === 0); attempt++) {
    const s = seededLinkedPuzzle(ladder, `practice-${Math.floor(rand() * 2 ** 32)}`, band);
    const goal = ladder.index.get(s.goal);
    const dist = distancesToGoal(ladder.reverse, ladder.words.length, goal);
    const route = guideRoute(ladder.neighbors, dist, ladder.linked, ladder.index.get(s.start));
    let rivals = 0;
    const shown = [], hintOrder = [];
    for (let k = 1; k < route.length - 1; k++) {
      const word = ladder.words[route[k]];
      const counts = [...word].map((_, p) => patternRivals(ladder, route[k - 1], route[k], p).length);
      const fewest = Math.min(...counts);
      rivals += fewest;
      const pos = pick(counts.flatMap((c, p) => (c === fewest ? [p] : [])));
      const rest = counts.map((_, p) => p).filter((p) => p !== pos);
      for (let i = rest.length - 1; i > 0; i--) { // seeded shuffle: the order hints reveal letters
        const j = Math.floor(rand() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      shown.push({ pos, letter: word[pos] });
      hintOrder.push(rest);
    }
    if (!best || rivals < best.rivals) best = { rivals, s, route, shown, hintOrder };
  }
  const { s, route, shown, hintOrder } = best;
  return {
    date: null, gameNumber: null, level, start: s.start, goal: s.goal, par: s.par,
    mode: "chain", route: route.map((i) => ladder.words[i]), shown, hintOrder,
    theme: "Unlimited ladder", teaser: `Level: ${band.label}.`, source: "practice",
    graphVersion: ladder.config.graphVersion, stepLimit: ladder.config.stepLimit, twoWay: Boolean(ladder.config.twoWay),
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
// Schema 7 (2026-11-19): par is 3/4/5 and rungs accept a wide top-N for every
// day, and every published puzzle was re-made. Saves and results from any older
// schema were played on different puzzles, so all of them go; preferences
// (seenHelp etc.) stay.
export function migrateStorage() {
  if (store.get("schema", 1) < 7) {
    for (const key of [...store.keys("game:"), ...store.keys("practice")]) store.remove(key);
    store.remove("results");
  }
  store.set("schema", 7);
}

export { LEVELS };
