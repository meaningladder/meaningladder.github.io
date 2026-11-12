// Meaning Ladder: screens, routing and events.
//
// Routes live in the URL hash so the static site needs no server:
//   #/            home
//   #/game/12/hard    daily game #12 at one level (easy, medium, hard)
//   #/game/12         -> the first level of #12 you haven't finished
//   #/practice/easy   unlimited random ladders at a level
//   #/archive     previous games
// For testing: ?today=YYYY-MM-DD pretends it's that date (local view only).

import { ladderFor, loadConfig, loadDailyPuzzle, loadLadder, loadVectors, makePracticePuzzle, migrateStorage, readyFor, store } from "./data.js";
import {
  addDays, checkStep, closeness, computeStats, distancesToGoal, localDateStr,
  displayRank, normalize, rankFill, rankOf, rankTone, scoresFrom, triedOrder,
  medalFor, naturalRoute, costsToGoal, shareText, shortestRoute,
  betterMedal, closerSteps, hintText, hintTier, resultMedal, upgradeHintState,
} from "./logic.js";
import { ICONS as PHOSPHOR } from "./icons.js";
import { DEFAULT_STEP_LIMIT, LEVELS, gameNumber, rulesFor } from "./seeded.js";

const app = document.getElementById("app");

const debugToday = new URLSearchParams(location.search).get("today");
const today = () => (/^\d{4}-\d{2}-\d{2}$/.test(debugToday ?? "") ? debugToday : localDateStr());

// ------------------------------------------------------------ tiny DOM helper
// h("p", { class: "x", onClick: fn }, "text", childNode) -> <p class="x">text…</p>
// Builds real nodes (never innerHTML), so no text can be interpreted as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// The logo is the one custom mark (a plain geometric ladder in our palette).
// Every UI glyph comes from the Phosphor icon library (js/icons.js).
const LOGO = '<svg viewBox="0 0 52 52" aria-hidden="true"><rect width="52" height="52" rx="14" fill="var(--accent)"/><path d="M17 42V10M35 42V10" stroke="var(--accent-text)" stroke-width="3.5" stroke-linecap="round"/><path d="M17 34h18" stroke="var(--far)" stroke-width="4" stroke-linecap="round"/><path d="M17 26h18" stroke="var(--mid)" stroke-width="4" stroke-linecap="round"/><path d="M17 18h18" stroke="var(--near)" stroke-width="4" stroke-linecap="round"/></svg>';
function icon(name, cls) {
  const tpl = document.createElement("template");
  tpl.innerHTML = name === "logo" ? LOGO : PHOSPHOR[name]; // constant markup, never user text
  const svg = tpl.content.firstElementChild;
  if (cls) svg.setAttribute("class", cls);
  return svg;
}

// Medal badge: a Phosphor glyph on a tinted disc. Emoji medals look different
// on every OS (and sometimes not at all), so the UI draws its own.
function medalBadge(medalId, size = "lg") {
  const glyph = { finished: "flag-checkered", gaveUp: "compass" }[medalId] ?? "medal";
  return h("span", { class: `medal-badge medal-${medalId} size-${size}`, "aria-hidden": "true" }, icon(glyph));
}

// ------------------------------------------------------------ dates
const fmt = (dateStr, opts) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
};
const longDate = (s) => fmt(s, { weekday: "long", month: "long", day: "numeric" });
const shortDate = (s) => fmt(s, { weekday: "short", month: "short", day: "numeric" });

function gameNumberOrNull(dateStr, config) {
  try { return gameNumber(dateStr, config.launchDate); } catch { return null; }
}
const dateOfGame = (n, config) => addDays(config.launchDate, n - 1);

// ------------------------------------------------------------ saved results
const LEVEL_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };
const resultKey = (date, level) => `${date}:${level}`;
const getResults = () => store.get("results", {});
function saveResult(date, state) {
  const results = getResults();
  results[resultKey(date, state.puzzle.level)] = {
    status: state.status, steps: state.path.length - 1, par: state.puzzle.par,
    hints: state.hints, reveals: state.reveals ?? 0, playedOn: today(),
  };
  store.set("results", results);
}

// One entry per level for a day: its saved result and whether it's in progress.
function dayLevels(date, results) {
  return LEVELS.map((level) => {
    const r = results[resultKey(date, level)];
    return { level, r, inProgress: !r && Boolean(store.get(`game:${date}:${level}`)) };
  });
}

// The best medal earned on any level that day, or null.
function bestMedal(levels) {
  const wins = levels.filter((x) => x.r?.status === "won");
  if (!wins.length) return null;
  return wins.map((x) => resultMedal(x.r)).reduce(betterMedal);
}

// The first level of a day that isn't finished yet (where a plain #/game/N goes).
function nextLevel(date, results, after = null) {
  const order = after ? [...LEVELS.slice(LEVELS.indexOf(after) + 1), ...LEVELS] : LEVELS;
  return order.find((lv) => lv !== after && !results[resultKey(date, lv)]) ?? null;
}

// ------------------------------------------------------------ dialogs
function openDialog(title, body, actions = [["Close", null]]) {
  const dlg = h("dialog", { "aria-labelledby": "dlg-title" },
    // Focus the title, not the first button: showModal() would otherwise
    // focus Close and scroll a long dialog to its bottom.
    h("h2", { id: "dlg-title", tabindex: "-1", autofocus: true }, title),
    body,
    h("div", { class: "dialog-actions" }, actions.map(([label, fn, primary]) =>
      h("button", {
        class: primary ? "btn" : "btn btn-quiet",
        onClick: () => { dlg.close(); fn?.(); },
      }, label))));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  dlg.scrollTop = 0;
  return dlg;
}

// k = the step limit to explain: a game passes its own (archive days keep
// their era's rules); null = today's rules (home screen).
async function showHelp(k = null) {
  store.set("seenHelp", true);
  let eraNote = "";
  try {
    const config = await loadConfig();
    k ??= rulesFor(config, today()).stepLimit ?? DEFAULT_STEP_LIMIT;
    // A note about the other era, built from config.rules (not hard-coded).
    const eras = config.rules ?? [];
    const newest = eras[eras.length - 1];
    const older = eras[eras.length - 2];
    const day = (s) => fmt(s, { month: "long", day: "numeric" });
    if (newest && k !== newest.stepLimit) {
      eraNote = today() < newest.from
        ? ` From ${day(newest.from)} each step must be in the top ${newest.stepLimit} instead.`
        : ` (Ladders from ${day(newest.from)} on use the top ${newest.stepLimit}.)`;
    } else if (newest && older && older.stepLimit !== k) {
      eraNote = ` (Ladders before ${day(newest.from)} allowed ${older.stepLimit}.)`;
    }
  } catch { k ??= DEFAULT_STEP_LIMIT; }
  const ex = (word, d, { latest = false, isStart = false } = {}) => {
    const { tone, fill } = closeness(d);
    return h("li", { class: `bar tone-${tone}${latest ? " latest" : ""}`, style: `--fill:${fill}%` },
      h("span", {}, word, isStart ? h("span", { class: "tag" }, "start") : null),
      h("span", { class: "num" }, d === 0 ? "goal" : `${d} to go`));
  };
  openDialog("How to play", h("div", {},
    h("ul", {},
      h("li", {}, "Climb from the ", h("b", {}, "start"), " word to the ", h("b", {}, "goal"), " word, one word at a time."),
      h("li", {}, "Every day has three ladders: ", h("b", {}, "Easy"), ", ", h("b", {}, "Medium"), " and ", h("b", {}, "Hard"), ". Solve any of them to keep your streak."),
      h("li", {}, `Each step must be one of the previous word's ${k} closest words in meaning.${eraNote}`),
      h("li", {}, "Each word on your path shows how many steps it still is from the goal (“3 to go”): green is 1, yellow is 2, pink is 3 or more. A step can be valid without getting you closer; those are marked “no closer”."),
      h("li", {}, h("b", {}, "Par"), " is the fewest steps possible. Match it for gold, one over for silver, two over for bronze. A hint that reveals a word caps you at silver."),
      h("li", {}, `A rejected word joins your Tried list with its rank from the current word. Only the top ${k} are valid steps, so #${k + 1} was very close.`),
      h("li", {}, "Stuck? Use Undo or Hint (a clue first, then the word), or give up from the ⋯ menu."),
      h("li", {}, "New ladders arrive every day at midnight, your time.")),
    h("p", { class: "sub example-caption" }, "Example: ocean → computer (newest word on top)"),
    h("ol", { class: "example path" }, ex("computer", 0), ex("network", 1), ex("signal", 2), ex("wave", 3),
      ex("ocean", 4, { isStart: true })))
  );
}

function showStats() {
  const s = computeStats(getResults(), today());
  const { easy, medium, hard } = s.solvedByLevel;
  openDialog("Statistics", h("div", {}, statsRow(s),
    h("p", { class: "sub stats-note" },
      `Solved so far: ${easy} easy, ${medium} medium, ${hard} hard.`)));
}

function statsRow(s) {
  const stat = (value, label) => h("div", { class: "stat" }, h("b", {}, value), h("span", {}, label));
  return h("div", { class: "stats-row" },
    stat(s.played, "Played"),
    stat(`${s.winPct}%`, "Win %"),
    stat(s.currentStreak, "Streak"),
    stat(s.avgOverPar == null ? "-" : `+${s.avgOverPar.toFixed(1)}`, "Avg over par"));
}

// ------------------------------------------------------------ router
let routeToken = 0;          // bumps on every navigation; stale async work checks it
let cleanups = [];           // timers etc. owned by the current screen

function route() {
  routeToken++;
  cleanups.forEach((fn) => fn());
  cleanups = [];
  document.querySelectorAll("dialog").forEach((d) => d.close());
  const hash = location.hash || "#/";
  let m;
  if ((m = hash.match(/^#\/game\/(\d+)\/(easy|medium|hard)$/))) return showGame("daily", Number(m[1]), m[2]);
  if ((m = hash.match(/^#\/game\/(\d+)$/))) return openDay(Number(m[1]));
  if ((m = hash.match(/^#\/practice\/(easy|medium|hard)$/))) return showGame("practice", null, m[1]);
  if (hash === "#/practice") {
    const level = store.get("practice")?.puzzle?.level;
    return location.replace(`#/practice/${LEVELS.includes(level) ? level : "medium"}`);
  }
  if (hash === "#/archive") return showArchive();
  return showHome();
}

// A plain day link (old shares, the calendar) opens the first unfinished level.
async function openDay(n) {
  const config = await loadConfig();
  const date = dateOfGame(n, config);
  location.replace(`#/game/${n}/${nextLevel(date, getResults()) ?? "easy"}`);
}

function render(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean)); // skip optional parts (null/false)
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------ day chips
const weekdayIndex = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay(); // 0 = Sunday
};

// One day in the week strip or the archive calendar: a link if that game is
// out, otherwise a disabled placeholder. Solved days carry their medal.
function dayChip(date, config, results, t, { weekdayLabel = false } = {}) {
  const num = gameNumberOrNull(date, config);
  const playable = num !== null && date <= t;
  const levels = dayLevels(date, results);
  const solved = levels.filter((x) => x.r?.status === "won").length;
  const touched = levels.some((x) => x.r || x.inProgress);
  const medal = bestMedal(levels);
  const cls = ["chip", date === t && "today", solved && "won", !solved && touched && "played"]
    .filter(Boolean).join(" ");
  const state = solved ? `, ${solved} of 3 solved, best ${medal.label}` : touched ? ", started" : "";
  const label = `${longDate(date)}${num ? `, game ${num}` : ""}${state}`;
  const inner = [
    weekdayLabel ? fmt(date, { weekday: "narrow" }) : null,
    h("b", {}, Number(date.slice(8))),
    h("span", { class: "chip-mark" }, medal ? medalBadge(medal.id, "xs") : null),
  ];
  return playable
    ? h("a", { class: cls, href: `#/game/${num}`, "aria-label": label }, inner)
    : h("button", { class: cls, disabled: true, "aria-label": `${label} (not available)` }, inner);
}

// ------------------------------------------------------------ home screen
async function showHome() {
  document.title = "Meaning Ladder";
  const token = routeToken;
  const config = await loadConfig();
  if (token !== routeToken) return;

  const t = today();
  const n = gameNumberOrNull(t, config);
  const results = getResults();
  // Three level buttons for today: each shows its own status.
  const dailyLevels = n && h("div", { class: "levels", role: "group", "aria-label": "Today's ladders" },
    dayLevels(t, results).map(({ level, r, inProgress }) => {
      const medal = r?.status === "won" ? resultMedal(r) : null;
      const status = medal ? `${r.steps} steps` : r?.status === "gaveUp" ? "Gave up" : inProgress ? "Resume" : "Play";
      return h("a", { class: `level-btn${medal ? " solved" : ""}`, href: `#/game/${n}/${level}`,
        "aria-label": `${LEVEL_LABEL[level]} ladder: ${medal ? `solved, ${medal.label}` : status}` },
        h("b", {}, LEVEL_LABEL[level]),
        h("span", { class: "with-badge" }, medal ? medalBadge(medal.id, "xs") : null, status));
    }));

  // Week strip: Sunday..Saturday of the current week.
  const sunday = addDays(t, -weekdayIndex(t));
  const chips = Array.from({ length: 7 }, (_, i) =>
    h("li", {}, dayChip(addDays(sunday, i), config, results, t, { weekdayLabel: true })));

  const daily = h("section", { class: "card", "aria-labelledby": "daily-title" },
    h("div", { class: "card-row" },
      h("div", {},
        h("h2", { id: "daily-title" }, n ? `Daily ladder #${n}` : "Daily ladder"),
        h("p", { class: "sub" }, longDate(t))),
      ),
    !n && h("p", { class: "note" },
      `Game #1 arrives on ${longDate(config.launchDate)}. Try an unlimited ladder meanwhile!`),
    dailyLevels,
    h("ol", { class: "week", "aria-label": "This week" }, chips));

  const saved = store.get("practice");
  const practice = h("section", { class: "card", "aria-labelledby": "practice-title" },
    h("h2", { id: "practice-title" }, "Unlimited"),
    h("p", { class: "sub" }, "Random ladders, as many as you like. No streaks at stake."),
    h("div", { class: "levels", role: "group", "aria-label": "Unlimited ladders" },
      LEVELS.map((level) => {
        const resume = saved?.status === "playing" && saved.puzzle?.level === level;
        return h("a", { class: "level-btn", href: `#/practice/${level}`,
          "aria-label": `${resume ? "Resume" : "Play"} an unlimited ${LEVEL_LABEL[level].toLowerCase()} ladder` },
          h("b", {}, LEVEL_LABEL[level]), h("span", {}, resume ? "Resume" : "Play"));
      })));

  render(
    h("header", { class: "home-head" },
      icon("logo", "logo"),
      h("h1", {}, "meaning ladder"),
      h("p", { class: "tagline" }, "Climb from one word to another")),
    daily,
    h("a", { class: "btn btn-quiet btn-wide home-archive", href: "#/archive" }, "Previous games"),
    practice,
    h("footer", { class: "home-foot" },
      h("button", { class: "link-btn", onClick: () => showHelp() }, "How to play"),
      h("button", { class: "link-btn", onClick: showStats }, "Statistics")));

  if (!store.get("seenHelp")) showHelp();           // the only pop-up on load
  setTimeout(() => loadLadder().catch(() => {}), 300); // warm the 0.8 MB word map
}

// ------------------------------------------------------------ archive screen
async function showArchive() {
  document.title = "Previous games \u00b7 Meaning Ladder";
  const token = routeToken;
  const config = await loadConfig();
  if (token !== routeToken) return;
  const t = today();
  const results = getResults();
  if (gameNumberOrNull(t, config) === null) {
    render(topbar("Previous games"),
      h("p", { class: "boot" }, `No games yet. Game #1 is on ${longDate(config.launchDate)}.`));
    return;
  }

  // Newest month first. Each month is a 7-column calendar of day chips.
  const months = [];
  let cursor = `${t.slice(0, 7)}-01`;
  const firstMonth = `${config.launchDate.slice(0, 7)}-01`;
  while (cursor >= firstMonth) {
    const [y, m] = cursor.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const dates = Array.from({ length: daysInMonth }, (_, i) => addDays(cursor, i));
    const released = dates.filter((d) => d >= config.launchDate && d <= t);
    const solved = released.reduce((sum, d) =>
      sum + dayLevels(d, results).filter((x) => x.r?.status === "won").length, 0);
    const offset = weekdayIndex(cursor);
    months.push(h("section", { class: "month", "aria-label": fmt(cursor, { month: "long", year: "numeric" }) },
      h("div", { class: "month-head" },
        h("h2", {}, fmt(cursor, { month: "long", year: "numeric" })),
        h("p", { class: "sub" }, `${solved} of ${released.length * LEVELS.length} solved`)),
      h("div", { class: "week weekdays", "aria-hidden": "true" },
        ["S", "M", "T", "W", "T", "F", "S"].map((d) => h("span", {}, d))),
      h("ol", { class: "week" },
        Array.from({ length: offset }, () => h("li", { class: "pad", "aria-hidden": "true" })),
        dates.map((d) => h("li", {}, dayChip(d, config, results, t))))));
    cursor = addDays(cursor, -1).slice(0, 7) + "-01";
  }
  render(topbar("Previous games"), ...months);
}

function topbar(title, menu = null) {
  return h("header", { class: "topbar" },
    h("a", { class: "icon-btn", href: "#/", "aria-label": "Back to home" }, icon("arrow-left")),
    h("h1", {}, title),
    menu ?? h("span"));
}

// ------------------------------------------------------------ game screen
function newState(kind, puzzle) {
  // hintsAt: hint tier shown at each word ({ word: 1 | 2 }, 0 = dead-end note),
  // so Undo back to a word shows its hint again without charging twice.
  // reveals: tier-2 hints (a whole word given away), which cap the medal.
  return { kind, puzzle, path: [puzzle.start], hints: 0, hintsAt: {}, reveals: 0, status: "playing" };
}

// Placeholder shaped like the game screen, shown while the 4.7 MB map downloads.
function skeleton() {
  return h("div", { class: "skeleton", role: "status" },
    h("span", { class: "visually-hidden" }, "Loading the word map"),
    h("div", { class: "sk sk-line" }),
    h("div", { class: "sk sk-pills" }),
    h("div", { class: "sk sk-input" }),
    [62, 44, 30].map((w) => h("div", { class: "sk sk-bar", style: `--w:${w}%` })),
    h("p", { class: "sk-note", "aria-hidden": "true" }, "Loading the word map"));
}

async function showGame(kind, n, level) {
  const token = routeToken;
  render(topbar("meaning ladder"), skeleton());

  let ladder;
  try {
    ladder = await loadLadder();
  } catch (err) {
    console.error(err);
    if (token === routeToken) render(topbar("meaning ladder"),
      h("p", { class: "boot" }, "Couldn't load the word map. Check your connection and reload."));
    return;
  }
  if (token !== routeToken) return;
  const { config } = ladder;

  let state, saveKey, date = null;
  try {
    if (kind === "daily") {
      date = dateOfGame(n, config);
      if (n < 1 || date > today()) {
        render(topbar("meaning ladder"), h("p", { class: "boot" }, `That game isn't out yet. It unlocks on ${longDate(date)}.`));
        return;
      }
      saveKey = `game:${date}:${level}`;
      // A saved game keeps its own puzzle, so a refresh can never swap it.
      state = store.get(saveKey) ?? newState("daily", await loadDailyPuzzle(ladder, date, level));
    } else {
      saveKey = "practice";
      state = store.get(saveKey);
      if (!state || state.puzzle.level !== level
          || !ladder.index.has(state.puzzle.start) || !ladder.index.has(state.puzzle.goal)) {
        state = newState("practice", await makePracticePuzzle(ladder, level));
      }
    }
    await readyFor(ladder, state.puzzle); // top-100-era games wait for the rest of the word map
  } catch (err) {
    console.error(err);
    if (token === routeToken) render(topbar("meaning ladder"),
      h("p", { class: "boot" }, "Couldn't load the word map. Check your connection and reload."));
    return;
  }
  if (token !== routeToken) return;
  playView(ladderFor(ladder, state.puzzle), state, saveKey, date); // that puzzle's rules
}

function playView(ladder, state, saveKey, date) {
  const { puzzle } = state;
  upgradeHintState(state); // saves from before per-word hint memory
  const goalIdx = ladder.index.get(puzzle.goal);
  const dist = distancesToGoal(ladder.reverse, ladder.words.length, goalIdx);
  const stepsTo = (word) => dist[ladder.index.get(word)];
  // Gentlest-route costs (Dijkstra), only computed when a hint or the result
  // screen first needs them, so opening a puzzle stays instant.
  let cost = null;
  const costs = () => (cost ??= costsToGoal(ladder.reverse, ladder.words.length, goalIdx));
  const routeFrom = (word) => naturalRoute(ladder.neighbors, costs(), ladder.index.get(word));
  const shortestFrom = (word) => shortestRoute(ladder.neighbors, dist, costs(), ladder.index.get(word));
  // The graph is the source of truth: if a puzzle file's par disagrees with
  // the real shortest path, trust the BFS (and say so in the console).
  const truePar = stepsTo(puzzle.start);
  if (truePar > 0 && truePar !== puzzle.par) {
    console.warn(`Puzzle file says par ${puzzle.par}, but the shortest path is ${truePar}.`);
    puzzle.par = truePar;
  }
  // The game number always comes from the date and the current launch date,
  // never from a saved copy (saves made before a launch-date change are stale).
  if (state.kind === "daily") puzzle.gameNumber = gameNumber(date, ladder.config.launchDate);
  const level = puzzle.level ?? "medium";
  const levelLabel = LEVEL_LABEL[level];
  const label = state.kind === "daily" ? `#${puzzle.gameNumber} ${levelLabel}` : `unlimited (${level})`;
  document.title = `${state.kind === "daily" ? `#${puzzle.gameNumber} ${levelLabel}` : `Unlimited ${levelLabel}`} · Meaning Ladder`;
  const levelHref = (lv) => (state.kind === "daily" ? `#/game/${puzzle.gameNumber}/${lv}` : `#/practice/${lv}`);

  let error = null;
  let rejected = null;       // a real word that just went into the Tried list
  let justTried = false;     // animate that word's bar once
  let justAdded = false;
  let countdownTimer = null;
  cleanups.push(() => clearInterval(countdownTimer));
  const save = () => store.set(saveKey, state);
  if (state.status === "playing") save();

  // ---- static parts
  const menuBtn = h("button", { class: "icon-btn", "aria-label": "Menu", "aria-haspopup": "true",
    "aria-expanded": "false", "aria-controls": "game-menu" }, icon("dots-three"));
  const menu = h("div", { class: "menu", id: "game-menu", role: "menu", hidden: true });
  const menuWrap = h("div", { class: "menu-wrap" }, menuBtn, menu);

  const status = h("p", { class: "status" });
  // Easy | Medium | Hard switcher; solved daily levels carry their medal.
  // Rebuilt on every update(), so a medal appears the moment you win.
  const switcher = h("nav", { class: "levels compact", "aria-label": "Level" });
  function renderSwitcher() {
    const results = state.kind === "daily" ? getResults() : {};
    switcher.replaceChildren(...LEVELS.map((lv) => {
      const r = results[resultKey(date, lv)];
      const medal = r?.status === "won" ? resultMedal(r) : null;
      return h("a", { class: `level-btn${lv === level ? " current" : ""}`, href: levelHref(lv),
        "aria-current": lv === level ? "page" : null,
        "aria-label": `${LEVEL_LABEL[lv]}${medal ? `, solved, ${medal.label}` : ""}` },
        medal ? medalBadge(medal.id, "xs") : null, LEVEL_LABEL[lv]);
    }));
  }
  // Unlimited ladders have no real theme ("Unlimited ladder · Level: Easy"
  // only repeats the status line and the switcher), so skip it there.
  const isPractice = state.kind === "practice" || puzzle.source === "practice";
  const theme = !isPractice && (puzzle.theme || puzzle.teaser) && h("p", { class: "theme" },
    h("strong", {}, puzzle.theme), puzzle.teaser ? h("span", {}, ` · ${puzzle.teaser}`) : null);
  // Start, every word found so far, then the goal: the ladder at a glance.
  // The word you're on is outlined (aria-current) while you play.
  const pills = h("div", { class: "pills" });
  function renderPills() {
    const playing = state.status === "playing";
    const won = state.status === "won";
    const middle = state.path.slice(1, won ? -1 : undefined);
    const last = state.path.length - 1;
    const pill = (word, cls, i) => h("span", {
      class: `pill${cls}${playing && i === last ? " current" : ""}`,
      "aria-current": playing && i === last ? "step" : null,
    }, word);
    const arrow = (text = "→") => h("span", { class: "arrow", "aria-hidden": "true" }, text);
    const parts = [pill(puzzle.start, "", 0)];
    middle.forEach((w, j) => parts.push(arrow(), pill(w, " step", j + 1)));
    parts.push(arrow(won ? "→" : "→ … →"), h("span", { class: "pill goal" }, puzzle.goal));
    pills.setAttribute("aria-label",
      `Your ladder so far: ${[puzzle.start, ...middle].join(", ")}${won ? "" : ", …"}, ${puzzle.goal}`);
    pills.replaceChildren(...parts);
  }

  const input = h("input", { id: "guess", type: "text", autocomplete: "off", autocapitalize: "none",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "go", maxlength: "30" });
  const form = h("form", { class: "guess", onSubmit: (e) => { e.preventDefault(); submit(); } },
    h("label", { for: "guess", class: "visually-hidden" }, "Next word"), input,
    h("button", { type: "submit", class: "btn go" }, "Go"));
  const feedback = h("div", { class: "feedback", "aria-live": "polite" });
  const tried = h("section", { class: "tried", hidden: true, "aria-label": "Words you tried" });
  const win = h("section", { class: "card win", hidden: true, "aria-live": "polite" });
  const list = h("ol", { class: "path", "aria-label": "Your path, newest first" });
  const undoBtn = h("button", { class: "btn btn-quiet", onClick: undo }, "Undo");
  const hintBtn = h("button", { class: "btn btn-quiet", onClick: hint }, "Hint");
  const actions = h("div", { class: "actions" }, undoBtn, hintBtn);

  render(topbar("meaning ladder", menuWrap), switcher, status, theme, pills, win, form, feedback, tried,
    h("p", { class: "list-head", "aria-hidden": "true" }, "Your path"), list, actions);

  // ---- menu
  const menuItems = [
    ["Hint", hint, () => state.status === "playing"],
    ["Give up", confirmGiveUp, () => state.status === "playing"],
    ...(state.kind === "practice" ? [["New unlimited ladder", newPractice, () => true]] : []),
    ["How to play", () => showHelp(ladder.config.stepLimit), () => true],
    ["Statistics", showStats, () => true],
    ["Previous games", () => { location.hash = "#/archive"; }, () => true],
  ];
  function openMenu(open) {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      menu.replaceChildren(...menuItems.map(([text, fn, enabled]) =>
        h("button", { role: "menuitem", disabled: !enabled(), onClick: () => { openMenu(false); fn(); } }, text)));
      menu.querySelector("button:not(:disabled)")?.focus();
    }
  }
  menuBtn.addEventListener("click", () => openMenu(menu.hidden));
  const onDocClick = (e) => { if (!menuWrap.contains(e.target)) openMenu(false); };
  const onKey = (e) => { if (e.key === "Escape" && !menu.hidden) { openMenu(false); menuBtn.focus(); } };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  cleanups.push(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  // ---- actions
  function submit() {
    if (state.status !== "playing") return;
    const res = checkStep(ladder, state.path, input.value);
    if (!res.ok) {
      const current = state.path[state.path.length - 1];
      // A real word that just isn't close enough goes into the Tried list,
      // which already shows it, its rank and a highlight: no red sentence.
      // Typos, unknown words and repeats keep their message.
      error = res.nearMiss ? null : res.error;  // the typed text stays, so a typo is easy to fix
      rejected = res.nearMiss ? { word: normalize(input.value), at: current } : null;
      if (res.nearMiss) {
        justTried = true;
        addTried(normalize(input.value), current, res.nearMiss.oneWay);
      }
      update();
      input.select();
      return;
    }
    state.path.push(res.word);
    state.tried = null;   // a new word means a new Tried list
    error = null;
    rejected = null;
    justAdded = true;
    input.value = "";
    if (res.word === puzzle.goal) finish("won");
    save();
    update();
  }

  function undo() {
    if (state.status !== "playing" || state.path.length < 2) return;
    state.path.pop(); // hintsAt is kept: coming back here shows the same hint, free
    state.tried = null;
    error = null;
    rejected = null;
    save();
    update();
    input.focus();
  }

  function hint() {
    if (state.status !== "playing") return;
    const current = state.path[state.path.length - 1];
    if (stepsTo(current) < 0) {
      state.hintsAt[current] = 0; // the dead-end note is free
    } else {
      const tier = (hintTier(state, current) ?? 0) + 1;
      if (tier > 2) return;
      state.hints++;
      if (tier === 2) state.reveals++;
      state.hintsAt[current] = tier;
    }
    error = null;
    rejected = null;
    save();
    update();
    input.focus();
  }

  // The hint text for a word, rebuilt from its stored tier (the route is
  // deterministic, so the same tier always says the same thing).
  function hintLine(current, tier) {
    const d = stepsTo(current);
    if (d < 0 || !tier) return `There's no way to ${puzzle.goal} from ${current}. Try Undo.`;
    const next = ladder.words[routeFrom(current)[1]];
    const from = ladder.index.get(current);
    return hintText(tier, {
      current, next, total: ladder.neighbors[from].length,
      closer: closerSteps(ladder.neighbors, dist, from).length,
      nextIsCloser: stepsTo(next) === d - 1,
    });
  }

  function confirmGiveUp() {
    openDialog("Give up?", h("p", {}, `We'll show you a route to the goal. This ends this ${levelLabel.toLowerCase()} ladder.`),
      [["Keep playing", () => input.focus()], ["Give up", () => { finish("gaveUp"); save(); update(); }, true]]);
  }

  function finish(result) {
    state.status = result;
    if (state.kind === "daily") saveResult(date, state);
  }

  function newPractice() {
    store.remove("practice");
    route();
  }

  // ---- Contexto-style Tried list
  // Each wrong guess at the current word, ranked by closeness to that word.
  let scoreCache = { at: -1, scores: null }; // scores for one "from" word at a time

  function addTried(word, current, oneWay) {
    if (state.tried?.at !== current) state.tried = { at: current, items: [] };
    state.tried.items = state.tried.items.filter((x) => x.word !== word); // a repeat moves to newest
    state.tried.items.push({ word, rank: null, family: false, oneWay });
    save();
    resolveRanks();
  }

  async function resolveRanks() {
    const t = state.tried;
    if (!t || !t.items.some((x) => x.rank == null && !x.family)) return;
    let vectors;
    try {
      // Ranks need the vectors, plus the full top-100 lists for exact #21-#100.
      [vectors] = await Promise.all([loadVectors(), ladder.loadFull?.()]);
    } catch (err) {
      console.warn("Couldn't load word vectors for ranks.", err);
      t.items.forEach((x) => { if (x.rank == null && !x.family) x.rank = "?"; });
      update();
      return;
    }
    const from = ladder.index.get(t.at);
    if (scoreCache.at !== from) scoreCache = { at: from, scores: scoresFrom(vectors, from) };
    for (const x of t.items) {
      if (x.rank != null || x.family) continue;
      const to = ladder.index.get(x.word);
      Object.assign(x, displayRank(ladder, from, to, rankOf(scoreCache.scores, from, to)));
    }
    save();
    update();
  }

  function rankBar(x, latest) {
    const known = typeof x.rank === "number";
    const tone = x.family || !known ? "cold" : rankTone(x.rank, ladder.config.stepLimit);
    const right = x.family ? h("span", { class: "tag" }, "same word")
      : x.rank == null ? "\u2026" : known ? `#${x.rank.toLocaleString()}` : "?";
    const enter = latest && justTried;
    return h("li", { class: `bar tone-${tone}${latest ? " latest" : ""}${enter ? " enter" : ""}`, style: `--fill:${known ? rankFill(x.rank) : 0}%` },
      h("span", {}, x.word, x.oneWay ? h("span", { class: "tag" }, "one-way") : null),
      h("span", { class: "num" }, right,
        known ? h("span", { class: "visually-hidden" }, ` closest to ${state.tried.at}`) : null));
  }

  function renderTried(current, playing) {
    const t = state.tried;
    tried.hidden = !playing || !t || t.at !== current || !t.items.length;
    if (tried.hidden) return;
    const latest = t.items[t.items.length - 1];
    tried.replaceChildren(...[
      h("p", { class: "tried-head" },
        `Tried from ${t.at} · ranked by closeness (top ${ladder.config.stepLimit} are valid steps)`),
      h("ol", { class: "path" }, triedOrder(t.items).map((x) => rankBar(x, x === latest))),
      t.items.some((x) => x.oneWay)
        ? h("p", { class: "tried-note" }, "One-way: the current word is close to it, but not the other way round.")
        : null,
    ].filter(Boolean));
  }

  // ---- rendering
  // How a step compared with the word before it: "no closer", "farther" or null.
  function drift(prev, word) {
    if (prev == null) return null;
    const a = stepsTo(prev), b = stepsTo(word);
    if (a < 0 || b < 0) return null;
    return b === a ? "no closer" : b > a ? "farther" : null;
  }

  function bar(word, { latest = false, isStart = false, enter = false, prev = null } = {}) {
    const d = stepsTo(word);
    const { tone, fill } = closeness(d);
    const num = d === 0 ? "goal" : d < 0 ? "no route" : `${d} to go`;
    const note = isStart ? "start" : drift(prev, word);
    return h("li", {
      class: `bar tone-${tone}${latest ? " latest" : ""}${enter ? " enter" : ""}`,
      style: `--fill:${fill}%`,
    },
    h("span", {}, word, note ? h("span", { class: "tag" }, note) : null),
    h("span", { class: "num" }, num));
  }

  // One muted line after a good step (the bar itself is already on the path).
  function progressLine(current, steps) {
    const d = stepsTo(current);
    if (d < 0) return `${current}: no route to ${puzzle.goal} from here. Try Undo.`;
    const s = d === 1 ? "" : "s";
    const how = drift(state.path[steps - 1], current);
    if (how === "no closer") return `${current} didn't get you closer: still ${d} step${s} to ${puzzle.goal}.`;
    if (how === "farther") return `${current} is farther: now ${d} step${s} to ${puzzle.goal}. Undo to go back.`;
    const over = steps + d - puzzle.par;
    return `${current}: ${d} step${d === 1 ? "" : "s"} to ${puzzle.goal}.`
      + (over <= 0 ? " On track for par." : ` Best now: par +${over}.`);
  }

  function update() {
    const steps = state.path.length - 1;
    const current = state.path[state.path.length - 1];
    const playing = state.status === "playing";
    const when = state.kind === "daily" ? `Game ${puzzle.gameNumber}, ${shortDate(date)}` : "Unlimited";
    status.textContent = `${when} · Steps: ${steps} · Par: ${puzzle.par}`;

    input.placeholder = `Next step from ${current}`;
    form.hidden = !playing;
    feedback.hidden = !playing;
    actions.hidden = !playing;
    undoBtn.disabled = steps === 0;
    hintBtn.disabled = hintTier(state, current) >= 2;

    // Feedback slot: exactly one thing.
    if (!playing) feedback.replaceChildren();
    else if (error) feedback.replaceChildren(h("p", { class: "error" }, error));
    else if (rejected?.at === current) feedback.replaceChildren(h("p", { class: "visually-hidden" },
      `${rejected.word} is not a valid step from ${current}. It was added to your Tried list.`));
    else if (hintTier(state, current) != null) feedback.replaceChildren(h("p", { class: "hintline" }, icon("lightbulb", "inline-icon"), hintLine(current, hintTier(state, current))));
    else if (steps > 0) feedback.replaceChildren(h("p", { class: "muted" }, progressLine(current, steps)));
    else feedback.replaceChildren(h("p", { class: "muted" },
      `Type one of ${puzzle.start}'s ${ladder.config.stepLimit} closest words in meaning. Par is ${puzzle.par}: the fewest steps possible.`));

    // Full path, newest on top; the start word sits at the bottom.
    list.replaceChildren(...state.path.map((w, i) => bar(w, {
      latest: playing && i === steps, // the word you're on, start included
      isStart: i === 0,
      enter: justAdded && i === steps,
      prev: i > 0 ? state.path[i - 1] : null,
    })).reverse());
    justAdded = false;

    renderPills();
    renderTried(current, playing);
    justTried = false;
    renderSwitcher();
    renderWin();
  }

  function renderWin() {
    win.hidden = state.status === "playing";
    if (win.hidden) return;
    const steps = state.path.length - 1;
    const won = state.status === "won";
    const medal = won ? medalFor(steps, puzzle.par, { revealed: state.reveals > 0 }) : null;
    const route = routeFrom(puzzle.start).map((i) => ladder.words[i]);
    const routeSteps = route.length - 1;
    const foundIt = won && state.path.join() === route.join();
    const hitPar = won && steps === puzzle.par;
    const toast = h("p", { class: "toast", role: "status" });
    const shareBtn = h("button", { class: "btn", onClick: () => share(toast) }, icon("share-network", "btn-icon"), "Share result");

    const countdown = h("p", { class: "countdown" });
    if (state.kind === "daily") {
      const tick = () => {
        // Real clock on purpose (even with ?today=): time to the next local midnight.
        const now = new Date();
        const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
        if (ms <= 0) { countdown.replaceChildren("New ladders are ready! ", h("a", { href: "#/" }, "Play them")); return; }
        const s = Math.floor(ms / 1000);
        const pad = (x) => String(x).padStart(2, "0");
        countdown.replaceChildren("Next ladders in ", h("b", {}, `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`));
      };
      tick();
      clearInterval(countdownTimer); // never stack two timers
      countdownTimer = setInterval(tick, 1000);
    }

    win.replaceChildren(...[ // .filter(Boolean): replaceChildren(null) would print "null"
      medalBadge(won ? medal.id : "gaveUp", "lg"),
      h("h2", {}, won ? (medal.id === "finished" ? "You made it!" : `${medal.label}!`) : "Here's one way up"),
      h("p", { class: "result" }, won
        ? `${steps} step${steps === 1 ? "" : "s"}, par ${puzzle.par}.${state.hints ? ` ${state.hints} hint${state.hints === 1 ? "" : "s"} used.` : ""}`
        : `You stopped after ${steps} step${steps === 1 ? "" : "s"}. Par was ${puzzle.par}.`),
      medal?.capped ? h("p", { class: "result" }, "Silver: a hint revealed a word.") : null,
      ...routeLines(won, foundIt, hitPar, route, routeSteps),
      h("div", { class: "btn-row" },
        shareBtn,
        state.kind === "practice"
          ? h("button", { class: "btn btn-quiet", onClick: newPractice }, icon("arrow-clockwise", "btn-icon"), "Play another")
          : nextLevel(date, getResults(), level)
            ? h("a", { class: "btn btn-quiet", href: levelHref(nextLevel(date, getResults(), level)) },
                `Play ${LEVEL_LABEL[nextLevel(date, getResults(), level)]}`)
            : h("a", { class: "btn btn-quiet", href: "#/" }, "Home")),
      toast,
      state.kind === "daily" ? countdown : null,
      state.kind === "daily" ? statsRow(computeStats(getResults(), today())) : null,
    ].filter(Boolean));
  }

  // The route paragraph(s) on the result card. Giving up always shows a
  // par-length route, plus the gentler natural one when that one differs.
  function routeLines(won, foundIt, hitPar, route, routeSteps) {
    const line = (lead, words, tail = null) => h("p", { class: "route" }, lead, h("b", {}, words.join(" → ")), tail);
    if (!won) {
      const short = shortestFrom(puzzle.start)?.map((i) => ladder.words[i]);
      if (!short) return [line("A natural route: ", route)];
      return [
        line(`One shortest route (${puzzle.par} step${puzzle.par === 1 ? "" : "s"}): `, short),
        short.join() !== route.join() ? line("A gentler one: ", route, ` (${routeSteps} steps).`) : null,
      ];
    }
    if (foundIt) return [line("You found the natural route: ", route)];
    if (hitPar) return [line(routeSteps === puzzle.par ? "You matched par! Another shortest route: "
      : "You matched par! A longer, smoother route: ", route)];
    return [line(routeSteps === puzzle.par ? "One shortest route: " : "A natural route: ", route,
      routeSteps !== puzzle.par ? ` (${routeSteps} steps; the shortest takes ${puzzle.par}).` : null)];
  }

  async function share(toast) {
    const steps = state.path.length - 1;
    const text = shareText({
      label, steps, par: puzzle.par, hints: state.hints, gaveUp: state.status === "gaveUp",
      distances: state.path.slice(1).map(stepsTo),
      url: location.origin + location.pathname,
    });
    try {
      await navigator.clipboard.writeText(text);
      toast.textContent = "Copied to clipboard!";
    } catch {
      // Clipboard API needs HTTPS + permission; fall back to a selectable box.
      const box = h("textarea", { rows: "3", readonly: true, class: "share-box", "aria-label": "Result to copy" }, text);
      toast.replaceChildren("Copy this:", box);
      box.select();
    }
  }

  update();
  resolveRanks(); // ranks still pending from before a refresh
  if (state.status === "playing") input.focus();
  // First visit straight to a game (a shared link): explain the rules once,
  // same as the home screen does.
  if (!store.get("seenHelp")) showHelp(ladder.config.stepLimit);
}

// ------------------------------------------------------------ start
migrateStorage(); // one-time move of pre-levels saves to the per-level format
window.addEventListener("hashchange", route);
route();

// Offline play and instant repeat visits (sw.js). Pages is always https;
// localhost counts as secure too. A failure here never affects the game.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered.", err));
  });
}
