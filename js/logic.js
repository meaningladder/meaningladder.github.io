// Pure game rules. No DOM, no fetch, no localStorage, so Node can test
// every function here (tests/js/logic.test.mjs).
import { INFORMATIVE, fnv1a32, mulberry32, relKey } from "./seeded.js";

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
  neighbors.forEach((row, u) => row.forEach((v) => { edges[fill[v]++] = u; }));
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

// ------------------------------------------------------------ steps
export function normalize(text) {
  return text.trim().toLowerCase();
}

// Is one word a regular plural of the other (cities/city, women/woman)?
function pluralPair(a, b) {
  return a !== b && (baseForms(a, PLURAL).has(b) || baseForms(b, PLURAL).has(a));
}

// ------------------------------------------------------------ linked play
// One game for Daily and Unlimited. Each rung shows a clue for the PLANNED
// next word: its ConceptNet link to the current word (linkClue) when that
// link is clean, else "N letters, starts with X". A word counts when it is a
// legal step, one rung closer, and fits the clue (same relation and
// direction, or same length and first letter). Every word played, wrong real
// word and hint is a move; the goal plays itself one rung before the top, so
// a perfect game equals par.

// The clean (informative) link between two words, or null.
export function linkOf(related, a, b) {
  const r = related?.get(relKey(a, b));
  return r && INFORMATIVE.has(r.rel) ? r : null;
}

// For every word, the most clean links on a shortest path to the goal, not
// counting the step into the goal (it plays itself, its clue is never shown);
// -1 = no route. Layer by layer outwards from the goal, like guideRoute.
export function linkedToGoal(neighbors, related, dist, goal) {
  const to = new Int32Array(dist.length).fill(-1);
  to[goal] = 0;
  const order = [...dist.keys()].filter((i) => dist[i] > 0).sort((a, b) => dist[a] - dist[b]);
  for (const u of order) {
    for (const v of neighbors[u]) {
      if (dist[v] === dist[u] - 1 && to[v] >= 0) to[u] = Math.max(to[u], (v !== goal && linkOf(related, u, v) ? 1 : 0) + to[v]);
    }
  }
  return to;
}

// The next route word while `cur` is on the stored route (word indexes);
// otherwise guideRoute's choice: the one-closer step with the most clean
// links ahead, ties to the more similar word. -1 at the goal.
export function plannedNext(ladder, related, dist, toGoal, route, cur) {
  const k = route ? route.indexOf(cur) : -1;
  if (k >= 0 && k < route.length - 1) return route[k + 1];
  let best = -1, score = -1;
  for (const v of ladder.neighbors[cur]) {
    if (dist[v] !== dist[cur] - 1) continue;
    const c = (dist[v] > 0 && linkOf(related, cur, v) ? 1 : 0) + toGoal[v];
    if (c > score) { best = v; score = c; }
  }
  return best;
}

const capital = (t) => t[0].toUpperCase() + t.slice(1);

// The clue for the step cur -> planned. `from` null means either reading is
// true (symmetric, or the same relation both ways): linkClue reads it as is.
export function rungClue(ladder, related, cur, planned) {
  const link = linkOf(related, cur, planned);
  if (link) {
    const text = linkClue(link.rel, link.from == null ? null : link.from === cur, ladder.words[cur]);
    return { kind: "link", text: capital(text), rel: link.rel, from: link.from };
  }
  const w = ladder.words[planned];
  return { kind: "letters", text: `${w.length} letters, starts with ${w[0].toUpperCase()}`, length: w.length, first: w[0] };
}

// Does `v` fit the clue shown at `cur`? A link clue reads "next REL cur"
// unless its edge starts at cur; v fits with the same relation read the same
// way (a both-ways link reads either way).
function fitsClue(ladder, related, cur, clue, v) {
  if (clue.kind === "letters") return ladder.words[v].length === clue.length && ladder.words[v][0] === clue.first;
  const l = linkOf(related, cur, v);
  return Boolean(l) && l.rel === clue.rel && (l.from == null || (l.from === cur) === (clue.from === cur));
}

// Typos, unknown words, words already on the ladder and repeat misses are
// free and say why; any other real word that doesn't count is `wrong` (a move).
// A typo is never answered with the planned word: only hints give letters away.
export function linkedGuess(ladder, related, dist, path, typed, goal, planned, misses = []) {
  const word = normalize(typed);
  if (!word) return { ok: false, error: "Type a word first." };
  if (!/^[a-z]+$/.test(word)) return { ok: false, error: "Letters only, please." };
  const cur = ladder.index.get(path[path.length - 1]);
  const clue = rungClue(ladder, related, cur, planned);
  const fits = ladder.neighbors[cur].filter((v) => dist[v] === dist[cur] - 1 && fitsClue(ladder, related, cur, clue, v))
    .map((v) => ladder.words[v]);
  if (fits.includes(word)) return { ok: true, word };
  const form = fits.find((w) => pluralPair(word, w));
  if (form) return { ok: true, word: form, note: `Counted as ${form}.` };
  if (!ladder.index.has(word)) {
    const suggestion = didYouMean(ladder, path, word, ladder.words[planned]);
    if (suggestion) return { ok: false, error: `Did you mean ${suggestion}?`, suggestion };
    const size = ladder.words.length.toLocaleString("en-US");
    return { ok: false, error: `${word} isn't in our ${size}-word list. Try a more common word.` };
  }
  if (path.includes(word) || word === goal) return { ok: false, error: `${word} is already on the ladder.` };
  if (misses.includes(word)) return { ok: false, error: `Already tried ${word}.` };
  return { ok: false, wrong: true, word };
}

// What a game needs besides the save: distances, clean links ahead, and the
// puzzle's stored route if it is still a real shortest route.
export function linkedGame(ladder, puzzle) {
  const goal = ladder.index.get(puzzle.goal);
  const dist = distancesToGoal(ladder.reverse ?? buildReverse(ladder.neighbors), ladder.words.length, goal);
  return {
    ladder, related: ladder.related, dist,
    toGoal: linkedToGoal(ladder.neighbors, ladder.related, dist, goal),
    route: checkedRoute(puzzle.route, puzzle, ladder, dist),
  };
}

// state.rungs[k]: the wrong words and hints at path word k.
export const linkedStart = (puzzle) => ({
  mode: "linked", puzzle, path: [puzzle.start], moves: 0, hints: 0, status: "playing", rungs: [],
});

// The rung being climbed: its index k, word, planned next word, clue and record.
export function linkedRung(game, state) {
  const k = state.path.length - 1;
  const cur = game.ladder.index.get(state.path[k]);
  const planned = plannedNext(game.ladder, game.related, game.dist, game.toGoal, game.route, cur);
  state.rungs[k] ??= { misses: [], hints: 0 };
  return { k, cur, planned, clue: rungClue(game.ladder, game.related, cur, planned), r: state.rungs[k] };
}

// Letter positions hints reveal: every one but the first, shuffled. Seeded by
// the word so a reload, and every player on the daily, gets the same letters.
function hintOrder(word) {
  const order = [...word].map((_, i) => i).slice(1);
  const rand = mulberry32(fnv1a32(word));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// The planned word as letters and "_" for the ones not shown yet.
export function shownLetters(game, state) {
  const { planned, clue, r } = linkedRung(game, state);
  const word = game.ladder.words[planned];
  const shown = new Set(hintOrder(word).slice(0, r.hints));
  if (clue.kind === "letters") shown.add(0);
  return [...word].map((c, i) => (shown.has(i) ? c : "_"));
}

// The word is played (its move is the caller's). One rung below the goal,
// the goal follows for one more move.
function linkedPlay(game, state, word) {
  state.path.push(word);
  if (game.dist[game.ladder.index.get(word)] === 1) {
    state.path.push(state.puzzle.goal);
    state.moves++;
  }
  if (state.path[state.path.length - 1] === state.puzzle.goal) state.status = "won";
}

export function linkedSubmit(game, state, typed) {
  const { planned, r } = linkedRung(game, state);
  const res = linkedGuess(game.ladder, game.related, game.dist, state.path, typed,
    state.puzzle.goal, planned, r.misses.map((m) => m.word));
  if (res.ok || res.wrong) state.moves++;
  if (res.wrong) r.misses.push({ word: res.word, rank: null }); // the caller fills in rank
  if (res.ok) linkedPlay(game, state, res.word);
  return res;
}

// One more letter of the planned word, for one move. The hint that shows
// the last hidden letter plays the word (no extra move for that).
export function linkedHint(game, state) {
  const { planned, r } = linkedRung(game, state);
  const word = game.ladder.words[planned];
  r.hints++;
  state.hints++;
  state.moves++;
  if (r.hints >= hintOrder(word).length) {
    r.revealed = true;
    linkedPlay(game, state, word);
  }
}

// Regular English inflection endings, as [ending, replacement]: a rough
// stand-in for WordNet's morphy (which the Python side uses to drop these
// links). Irregulars like mice/mouse are not covered.
const DETACH = [
  ["ies", "y"], ["ses", "s"], ["xes", "x"], ["zes", "z"], ["ches", "ch"], ["shes", "sh"],
  ["men", "man"], ["es", "e"], ["es", ""], ["s", ""],
  ["ied", "y"], ["ed", "e"], ["ed", ""], ["ing", "e"], ["ing", ""],
  ["ier", "y"], ["iest", "y"], ["er", "e"], ["er", ""], ["est", "e"], ["est", ""],
];
// The noun-plural endings of DETACH (everything before "ied").
const PLURAL = DETACH.slice(0, DETACH.findIndex(([end]) => end === "ied"));

// Possible base forms of `w` by stripping one regular ending. Bases shorter
// than 3 letters are skipped: "bed" would otherwise be a form of "be".
// The set keeps the order of `endings`, so the likeliest base comes first.
function baseForms(w, endings = DETACH) {
  const out = new Set();
  for (const [end, rep] of endings) {
    if (!w.endsWith(end)) continue;
    const stem = w.slice(0, -end.length);
    const base = stem + rep;
    if (base.length >= 3) out.add(base);
    // running -> run, bigger -> big: undo a doubled final consonant.
    if (!rep && stem.length >= 4 && stem.at(-1) === stem.at(-2)) out.add(stem.slice(0, -1));
  }
  return out;
}

// Are `a` and `b` one edit apart (insert, delete, substitute, or swap two
// adjacent letters)? Linear time, no matrix: this runs on thousands of words
// per keypress-submit.
export function oneEdit(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Best vocabulary word one edit from `word`, or null. A legal next step wins
// (that's what the player was most likely aiming at), then the most common
// word (the list is in frequency order). Words already in the path are
// skipped since suggesting them would only lead to another rejection.
// `hidden`: a chain's answer, never suggested (nor its plural/singular).
function didYouMean(ladder, path, word, hidden = null) {
  const ok = (w) => !path.includes(w) && (!hidden || (w !== hidden && !pluralPair(w, hidden)));
  const cur = ladder.index.get(path[path.length - 1]);
  for (const idx of cur === undefined ? [] : ladder.neighbors[cur]) {
    const w = ladder.words[idx];
    if (ok(w) && oneEdit(word, w)) return w;
  }
  // Anywhere else, only words with the same first letter: typos rarely change
  // it, and "kitten" -> "Did you mean bitten?" reads as a joke, not a fix.
  for (const w of ladder.words) {
    if (w[0] === word[0] && Math.abs(w.length - word.length) <= 1 && ok(w) && oneEdit(word, w)) return w;
  }
  return null;
}

// ------------------------------------------------------------ Tried list
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
// A ladder's score is its moves: path steps plus every accepted word that was
// later undone. Without the undo count, Undo plus the exact "N to go" readout
// would let anyone try words, take back each "no closer" one and always get
// gold. Results saved before undos were counted have no `undos`: count 0.
export function movesOf({ steps = 0, undos = 0 } = {}) {
  return steps + (undos ?? 0);
}

// Callers pass moves (movesOf), not just the final path length.
// `revealed`: a hint gave away a whole word during the solve. That caps the
// medal at silver, since gold should mean you found the par route yourself.
// The returned medal says `capped` so the result card can explain why.
export function medalFor(steps, par, { revealed = false } = {}) {
  const over = steps - par;
  const silver = { id: "silver", label: "Silver", emoji: "🥈" };
  if (over <= 0) return revealed ? { ...silver, capped: true } : { id: "gold", label: "Gold", emoji: "🥇" };
  if (over <= 1) return silver;
  if (over <= 2) return { id: "bronze", label: "Bronze", emoji: "🥉" };
  return { id: "finished", label: "Finished", emoji: "🏁" };
}

// A saved result's score. Results from now on store `moves` (every word
// played, undone ones and hints included). Older results kept steps, undos and
// reveals separately; they keep exactly the medal they were given.
export const scoreOf = (r) => (r.moves != null ? r.moves : movesOf(r));
export const resultMedal = (r) => (r.moves != null
  ? medalFor(r.moves, r.par)
  : medalFor(movesOf(r), r.par, { revealed: r.reveals > 0 }));

// Points: 100 at or under par, less the more moves it took. Gave up scores 0.
export const pointsFor = (moves, par) => (moves > 0 ? Math.min(100, Math.round((100 * par) / moves)) : 0);
export const resultPoints = (r) => (r.status === "won" ? pointsFor(scoreOf(r), r.par) : 0);

const MEDAL_ORDER = ["gold", "silver", "bronze", "finished"];
// The better of two medals (gold beats silver...). Compares medals rather than
// steps over par, because a capped gold-pace solve is only silver.
export const betterMedal = (a, b) => (MEDAL_ORDER.indexOf(b.id) < MEDAL_ORDER.indexOf(a.id) ? b : a);

// ------------------------------------------------------------ ladder & share
// A climbed rung by its height: a red sliver (hue 0, 8% filled) at the start
// up to a full green bar (hue 130, 100%) at the goal.
export function stairStep(rung, par) {
  const t = par <= 0 ? 1 : Math.min(1, Math.max(0, rung / par));
  return { hue: Math.round(130 * t), fill: Math.round(8 + 92 * t) };
}

// One square per rung, read from state.rungs: 🟩 first guess, 🟨 after wrong
// words or hints, ⬜ revealed by hints (or the rung given up on), ✅ the goal.
export function shareSquares({ path, rungs, status }) {
  const sq = path.slice(1).map((_, k) => {
    if (k === path.length - 2 && status === "won") return "✅";
    const r = rungs[k];
    return !r ? "🟩" : r.revealed ? "⬜" : r.misses.length || r.hints ? "🟨" : "🟩";
  });
  const r = rungs[path.length - 1]; // the unfinished rung
  if (status === "gaveUp" && r && (r.misses.length || r.hints)) sq.push("⬜");
  return sq.join("");
}

// Spoiler-free share text: no words, just colored rungs (see shareSquares), e.g.
//   Meaning Ladder #13 Hard 🥈 86 pts
//   7 moves · par 6
//   🟩🟨🟩🟩⬜✅
export function shareText({ label, moves, par, squares = "", gaveUp = false, url = "" }) {
  // Gave-up games get no medal: the 🏁 "finished" emoji would read as a finish.
  const badge = gaveUp ? "" : ` ${medalFor(moves, par).emoji} ${pointsFor(moves, par)} pts`;
  const n = `${moves} move${moves === 1 ? "" : "s"}`;
  const what = gaveUp ? `Gave up after ${n}` : n;
  return [`Meaning Ladder ${label}${badge}`, `${what} · par ${par}`, squares, url]
    .filter(Boolean).join("\n");
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

// Whether a win on puzzle date `day` keeps the streak alive. Solving it on
// the day itself always counts. A ladder STARTED on its day but finished just
// after midnight counts too (startedOn is recorded when the game is created),
// but only until the end of the next day: otherwise a game opened and
// abandoned could be finished a week later and patch a streak gap. Archive
// plays (started after their day) never count. Results saved before
// startedOn existed only have playedOn, so they keep the old rule.
export function countsForStreak(day, r) {
  if (r?.status !== "won") return false;
  if (r.playedOn === day) return true;
  return r.startedOn === day && r.playedOn != null && r.playedOn <= addDays(day, 1);
}

// Results are keyed "<date>:<level>" (older saves: just "<date>").
// The streak counts DAYS: one level that countsForStreak keeps it alive.
// Just after midnight "today" has no win yet, so counting starts at
// yesterday: the streak only breaks once a whole day passes unsolved.
export function computeStats(results, today) {
  const dayOf = (key) => key.slice(0, 10);
  const levelOf = (key) => key.slice(11) || null;
  const finished = Object.entries(results).filter(([, r]) => r.status !== "playing");
  const wins = finished.filter(([, r]) => r.status === "won");
  const onTimeDays = new Set(wins.filter(([k, r]) => countsForStreak(dayOf(k), r)).map(([k]) => dayOf(k)));

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

  const avgPointsByLevel = {};
  for (const lv of ["easy", "medium", "hard"]) {
    const pts = finished.filter(([k]) => levelOf(k) === lv).map(([, r]) => resultPoints(r));
    avgPointsByLevel[lv] = pts.length ? Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) : null;
  }
  const overPar = wins.map(([, r]) => scoreOf(r) - r.par);
  return {
    played: finished.length,
    winPct: finished.length ? Math.round((100 * wins.length) / finished.length) : 0,
    currentStreak: current,
    maxStreak: Math.max(best, current),
    avgOverPar: overPar.length ? overPar.reduce((a, b) => a + b, 0) / overPar.length : null,
    solvedByLevel,
    avgPointsByLevel,
  };
}

// ------------------------------------------------------------ rules eras
// config.rules is a list of eras sorted by "from" (see rulesFor in seeded.js).
// These helpers drive the one-time "New rules" notice and the "classic rules"
// labels, all from config, so a future era needs no code change.

// The newest era, but only if there was an older one to change from.
// Eras that change what players see: the step limit, link direction or a
// level's par. An era that only changes how puzzles are picked (for example
// minLinkedSteps) isn't news, so it gets no notice and no "classic" label.
const visibleRules = (e) => JSON.stringify([e.stepLimit, Boolean(e.twoWay),
  ...["easy", "medium", "hard"].map((lv) => e.levels?.[lv]?.par ?? null)]);
export function visibleEras(config) {
  const out = [];
  for (const e of config?.rules ?? []) {
    if (!out.length || visibleRules(out[out.length - 1]) !== visibleRules(e)) out.push(e);
  }
  return out;
}

export function newestEra(config) {
  const eras = visibleEras(config);
  return eras.length > 1 ? eras[eras.length - 1] : null;
}

// True if a daily game on dateStr is played under an older era's rules.
export function isClassicDay(config, dateStr) {
  const newest = newestEra(config);
  return Boolean(newest && dateStr && dateStr < newest.from);
}

// Short tag for an older-era day ("classic rules (top 100)"), or "".
// The step limit is that day's own era's (there could be several old eras).
export function classicLabel(config, dateStr) {
  if (!isClassicDay(config, dateStr)) return "";
  const era = [...config.rules].reverse().find((e) => e.from <= dateStr) ?? config.rules[0];
  return `classic rules (top ${era.stepLimit})`;
}

// Dates the player played on, from saved results ("<date>:<level>" ->
// { playedOn }) and save keys ("game:<date>:<level>"). Results use playedOn
// (when they played), falling back to the game's own date for old saves.
export function playedDates(results, gameKeys = []) {
  const dates = Object.entries(results ?? {}).map(([k, r]) => r?.playedOn ?? k.slice(0, 10));
  for (const k of gameKeys) dates.push(k.slice("game:".length, "game:".length + 10));
  return dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

// Should the "New rules" notice show? Only once the newest era has started,
// only for players with history from before it (newcomers get How to play,
// which already teaches today's rules), and only until dismissed.
export function rulesNoticeDue(config, today, dates, seen) {
  const newest = newestEra(config);
  if (!newest || today < newest.from || seen) return false;
  return dates.some((d) => d < newest.from);
}

// "4, 5 and 6"
const listJoin = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Body text of the notice, comparing the newest era with the one before it.
// dayText formats a "YYYY-MM-DD" date: the DOM side owns the player's
// locale, and tests pass a fixed formatter.
export function rulesNoticeText(config, dayText, levelOrder = ["easy", "medium", "hard"]) {
  const newest = newestEra(config);
  if (!newest) return "";
  const eras = visibleEras(config);
  const old = eras[eras.length - 2];
  const was = old.stepLimit !== newest.stepLimit ? ` (it was ${old.stepLimit})` : "";
  // Two-way eras: a step counts if EITHER word is among the other's closest.
  const parts = [newest.twoWay && !old.twoWay
    ? `From ${dayText(newest.from)}, a step counts if either word is among the other's ${newest.stepLimit} closest words.`
    : `From ${dayText(newest.from)}, each step must be one of the previous word's ${newest.stepLimit} closest words${was}.`];
  const pars = (era) => levelOrder.map((lv) => era.levels?.[lv]?.par).filter((p) => p != null);
  const now = pars(newest);
  const before = pars(old);
  if (now.length && now.join() !== before.join()) {
    const longer = before.length === now.length && now.every((p, i) => p >= before[i]);
    // Name the levels: two levels can share a par (Medium and Hard are both 5),
    // and "par is 4, 5 and 5" wouldn't say which is which.
    const named = levelOrder.filter((lv) => newest.levels?.[lv]?.par != null)
      .map((lv, i) => `${i ? "" : "par "}${newest.levels[lv].par} for ${newest.levels[lv].label ?? lv[0].toUpperCase() + lv.slice(1)}`);
    parts.push(longer ? `Ladders are longer: ${listJoin(named)}.` : `Now ${listJoin(named)}.`);
  }
  return parts.join(" ");
}

// ------------------------------------------------------------ stored route
// A puzzle file's route (AI-checked, with a reason per step) as word indexes,
// or null unless it is still a real shortest route under this view's rules:
// right ends, par + 1 words, every step legal and one step closer.
export function checkedRoute(route, puzzle, ladder, dist) {
  if (!Array.isArray(route) || route.length !== puzzle.par + 1) return null;
  if (route[0] !== puzzle.start || route[route.length - 1] !== puzzle.goal) return null;
  const idx = route.map((w) => ladder.index.get(w));
  if (idx.some((i) => i === undefined)) return null;
  for (let k = 0; k < puzzle.par; k++) {
    if (!ladder.neighbors[idx[k]].includes(idx[k + 1]) || dist[idx[k + 1]] !== dist[idx[k]] - 1) return null;
  }
  return idx;
}

// ------------------------------------------------------------ guide route
// A shortest route (each step one closer, via `dist`) with the most steps
// that are informative ConceptNet links (`related`: a Set of relKey pairs,
// normally ladder.linked), not counting the step into the goal (it plays
// itself, so players never see its clue); ties go
// to the more similar neighbor. Par is kept, so following it still earns
// gold; it just reads better (cafe, restaurant, grill, stove, kerosene,
// fuel). Word indexes including both ends, or null.
export function guideRoute(neighbors, dist, related, from) {
  if (!related || dist[from] < 0) return null;
  const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
  const memo = new Map();
  const best = (u) => {
    if (dist[u] === 0) return 0;
    if (memo.has(u)) return memo.get(u);
    let b = -1;
    for (const v of neighbors[u]) {
      if (dist[v] !== dist[u] - 1) continue;
      const c = (dist[v] > 0 && related.has(key(u, v)) ? 1 : 0) + best(v);
      if (c > b) b = c;
    }
    memo.set(u, b);
    return b;
  };
  const route = [from];
  for (let u = from; dist[u] > 0;) {
    let pick = -1, score = -1;
    for (const v of neighbors[u]) {
      if (dist[v] !== dist[u] - 1) continue;
      const c = (dist[v] > 0 && related.has(key(u, v)) ? 1 : 0) + best(v);
      if (c > score) { score = c; pick = v; }
    }
    u = pick;
    route.push(u);
  }
  return route;
}

// ------------------------------------------------------------ feedback
// The site has no server, so feedback goes to a GitHub issue. This builds the
// "new issue" link for the repo's feedback form (.github/ISSUE_TEMPLATE/
// feedback.yml), filled in with what the player typed and which game they
// were on. Long text is cut so the link stays well under URL limits.
export const FEEDBACK_KINDS = [
  "A puzzle (a word or link that felt wrong)",
  "Something broke",
  "An idea",
  "Something else",
];
export const FEEDBACK_MAX = 1500;

export function feedbackUrl(repo, { kind, text, context = [] }) {
  const details = String(text ?? "").trim().slice(0, FEEDBACK_MAX);
  const first = details.split("\n")[0].slice(0, 60).trim();
  const params = new URLSearchParams({
    template: "feedback.yml",
    title: `[Feedback] ${first || "Game feedback"}`,
    kind: FEEDBACK_KINDS.includes(kind) ? kind : FEEDBACK_KINDS[3],
    details,
    context: context.filter(Boolean).join("\n"),
  });
  return `https://github.com/${repo}/issues/new?${params}`;
}

// The body the game POSTs to the feedback function (feedback-api/), which
// files the issue itself, so players need no GitHub account. `website` is the
// hidden honeypot field (people leave it empty) and `openMs` how long the form
// was open (the function refuses posts made within 3 seconds).
export function feedbackPayload({ kind, text, context = [], website = "", openMs }) {
  return {
    kind: FEEDBACK_KINDS.includes(kind) ? kind : FEEDBACK_KINDS[3],
    text: String(text ?? "").trim().slice(0, FEEDBACK_MAX),
    context: context.filter(Boolean).slice(0, 6).map((x) => String(x).slice(0, 300)),
    website: String(website ?? ""),
    openMs: Math.max(0, Math.round(Number(openMs) || 0)),
  };
}

// Clue for the NEXT word, in terms of `cur`, never naming it. [next REL cur, cur REL next];
// a single string means symmetric. fromCurrent: true = edge starts at cur, null = symmetric.
const LINK_CLUES = {
  IsA: [(c) => `A kind of ${c}`, (c) => `${c} is a kind of this`],
  PartOf: [(c) => `Part of ${c}`, (c) => `${c} is part of this`],
  HasA: [(c) => `Something that has ${c}`, (c) => `What ${c} has`],
  UsedFor: [(c) => `Something used for ${c}`, (c) => `What ${c} is used for`],
  AtLocation: [(c) => `Something you find at ${c}`, (c) => `Where you find ${c}`],
  MadeOf: [(c) => `Something made of ${c}`, (c) => `What ${c} is made of`],
  CapableOf: [(c) => `Something that can ${c}`, (c) => `What ${c} can do`],
  Causes: [(c) => `Something that causes ${c}`, (c) => `What ${c} causes`],
  HasPrerequisite: [(c) => `Something that needs ${c} first`, (c) => `What you need to ${c}`],
  CreatedBy: [(c) => `Something created by ${c}`, (c) => `Who or what creates ${c}`],
  ReceivesAction: [(c) => `Something you can ${c}`, (c) => `What you can do to ${c}`],
  HasProperty: [(c) => `Something that is ${c}`, (c) => `What ${c} is like`],
  HasSubevent: [(c) => `Something during which ${c} happens`, (c) => `What happens during ${c}`],
  Desires: [(c) => `Something that wants ${c}`, (c) => `What ${c} wants`],
  MotivatedByGoal: [(c) => `Something you do because of ${c}`, (c) => `Why you ${c}`],
  Synonym: (c) => `Means the same as ${c}`,
  SimilarTo: (c) => `Similar to ${c}`,
  LocatedNear: (c) => `Found near ${c}`,
};

export function linkClue(rel, fromCurrent, cur) {
  const t = LINK_CLUES[rel];
  if (!t) throw new Error(`linkClue: no clue for ${rel}`);
  return typeof t === "function" ? t(cur) : t[fromCurrent ? 1 : 0](cur);
}
