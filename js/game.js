// Meaning Ladder: screens, routing and events.
//
// Routes live in the URL hash so the static site needs no server:
//   #/            home
//   #/game/12     daily game #12 (today or an earlier one)
//   #/practice    unlimited random ladders
//   #/archive     previous games
// For testing: ?today=YYYY-MM-DD pretends it's that date (local view only).

import { loadConfig, loadDailyPuzzle, loadLadder, makePracticePuzzle, store } from "./data.js";
import {
  addDays, checkStep, closeness, computeStats, distancesToGoal, localDateStr,
  medalFor, routeToGoal, shareText,
} from "./logic.js";
import { gameNumber } from "./seeded.js";

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

const ICONS = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  logo: '<svg viewBox="0 0 52 52" aria-hidden="true"><rect width="52" height="52" rx="14" fill="var(--accent)"/><path d="M17 42V10M35 42V10" stroke="var(--accent-text)" stroke-width="3.5" stroke-linecap="round"/><path d="M17 34h18" stroke="var(--far)" stroke-width="4" stroke-linecap="round"/><path d="M17 26h18" stroke="var(--mid)" stroke-width="4" stroke-linecap="round"/><path d="M17 18h18" stroke="var(--near)" stroke-width="4" stroke-linecap="round"/></svg>',
};
function icon(name, cls) {
  const tpl = document.createElement("template");
  tpl.innerHTML = ICONS[name]; // our own constant SVG markup, never user text
  const svg = tpl.content.firstElementChild;
  if (cls) svg.setAttribute("class", cls);
  return svg;
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
const getResults = () => store.get("results", {});
function saveResult(date, state) {
  const results = getResults();
  results[date] = {
    status: state.status, steps: state.path.length - 1, par: state.puzzle.par,
    hints: state.hints, playedOn: today(),
  };
  store.set("results", results);
}

// ------------------------------------------------------------ dialogs
function openDialog(title, body, actions = [["Close", null]]) {
  const dlg = h("dialog", { "aria-labelledby": "dlg-title" },
    h("h2", { id: "dlg-title" }, title),
    body,
    h("div", { class: "dialog-actions" }, actions.map(([label, fn, primary]) =>
      h("button", {
        class: primary ? "btn" : "btn btn-quiet",
        onClick: () => { dlg.close(); fn?.(); },
      }, label))));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function showHelp() {
  store.set("seenHelp", true);
  const ex = (word, d, latest) => {
    const { tone, fill } = closeness(d);
    return h("li", { class: `bar tone-${tone}${latest ? " latest" : ""}`, style: `--fill:${fill}%` },
      h("span", {}, word), h("span", { class: "num" }, d === 0 ? "goal" : d));
  };
  openDialog("How to play", h("div", {},
    h("ul", {},
      h("li", {}, "Climb from the ", h("b", {}, "start"), " word to the ", h("b", {}, "goal"), " word, one word at a time."),
      h("li", {}, "Each step must be one of the previous word's 100 closest words in meaning."),
      h("li", {}, "The number on each bar is how many steps that word is from the goal: green is 1, yellow is 2, pink is 3 or more."),
      h("li", {}, h("b", {}, "Par"), " is the fewest steps possible. Match it for gold, one over for silver, two over for bronze."),
      h("li", {}, "Stuck? Use Undo or Hint, or give up from the ⋯ menu."),
      h("li", {}, "A new ladder arrives every day at midnight, your time.")),
    h("p", { class: "sub", style: "margin-top:12px" }, "Example: ocean → computer"),
    h("ol", { class: "example path" }, ex("computer", 0), ex("network", 1), ex("signal", 2), ex("wave", 3)))
  );
}

function showStats() {
  const s = computeStats(getResults(), today());
  openDialog("Statistics", statsRow(s));
}

function statsRow(s) {
  const stat = (value, label) => h("div", { class: "stat" }, h("b", {}, value), h("span", {}, label));
  return h("div", { class: "stats-row" },
    stat(s.played, "Played"),
    stat(`${s.winPct}%`, "Win %"),
    stat(s.currentStreak, "Streak"),
    stat(s.avgOverPar == null ? "–" : `+${s.avgOverPar.toFixed(1)}`, "Avg over par"));
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
  if ((m = hash.match(/^#\/game\/(\d+)$/))) return showGame("daily", Number(m[1]));
  if (hash === "#/practice") return showGame("practice");
  if (hash === "#/archive") return showArchive();
  return showHome();
}

function render(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean)); // skip optional parts (null/false)
  window.scrollTo(0, 0);
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
  const todayState = store.get(`game:${t}`);
  const statusText = results[t]?.status === "won"
    ? `Solved in ${results[t].steps} · ${medalFor(results[t].steps, results[t].par).emoji}`
    : results[t]?.status === "gaveUp" ? "You gave up on this one."
    : todayState ? `In progress · ${todayState.path.length - 1} steps so far` : null;

  // Week strip: Sunday..Saturday of the current week.
  const [y, mo, d] = t.split("-").map(Number);
  const sunday = addDays(t, -new Date(y, mo - 1, d).getDay());
  const chips = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(sunday, i);
    const num = gameNumberOrNull(date, config);
    const playable = num !== null && date <= t;
    const r = results[date];
    const cls = ["chip", date === t && "today", r?.status === "won" && "won",
      r && r.status !== "won" && "played", store.get(`game:${date}`) && !r && "played"]
      .filter(Boolean).join(" ");
    const label = `${longDate(date)}${num ? `, game ${num}` : ""}${r?.status === "won" ? ", solved" : ""}`;
    const inner = [fmt(date, { weekday: "narrow" }), h("b", {}, Number(date.slice(8))),
      h("span", { class: "chip-dot" }, r?.status === "won" ? medalFor(r.steps, r.par).emoji : "")];
    return h("li", {}, playable
      ? h("a", { class: cls, href: `#/game/${num}`, "aria-label": label }, inner)
      : h("button", { class: cls, disabled: true, "aria-label": `${label} (not available)` }, inner));
  });

  const daily = h("section", { class: "card", "aria-labelledby": "daily-title" },
    h("div", { class: "card-row" },
      h("div", {},
        h("h2", { id: "daily-title" }, n ? `Daily ladder #${n}` : "Daily ladder"),
        h("p", { class: "sub" }, longDate(t))),
      n ? h("a", { class: "btn", href: `#/game/${n}` }, results[t] ? "View" : todayState ? "Resume" : "Play")
        : h("button", { class: "btn", disabled: true }, "Play")),
    !n && h("p", { class: "note" },
      `Game #1 arrives on ${longDate(config.launchDate)}. Try a practice ladder meanwhile!`),
    statusText && h("p", { class: "note" }, statusText),
    h("ol", { class: "week", "aria-label": "This week" }, chips));

  const practice = h("section", { class: "card", "aria-labelledby": "practice-title" },
    h("div", { class: "card-row" },
      h("div", {},
        h("h2", { id: "practice-title" }, "Practice"),
        h("p", { class: "sub" }, "Unlimited random ladders. No streaks at stake.")),
      h("a", { class: "btn", href: "#/practice" }, store.get("practice")?.status === "playing" ? "Resume" : "Play")));

  render(
    h("header", { class: "home-head" },
      icon("logo", "logo"),
      h("h1", {}, "meaning ladder"),
      h("p", { class: "tagline" }, "Climb from one word to another")),
    daily,
    h("a", { class: "btn btn-quiet btn-wide", href: "#/archive", style: "margin-bottom:14px" }, "Previous games"),
    practice,
    h("footer", { class: "home-foot" },
      h("button", { class: "link-btn", onClick: showHelp }, "How to play"),
      h("button", { class: "link-btn", onClick: showStats }, "Statistics")));

  if (!store.get("seenHelp")) showHelp();           // the only pop-up on load
  setTimeout(() => loadLadder().catch(() => {}), 300); // warm the 4.7 MB download
}

// ------------------------------------------------------------ archive screen
async function showArchive() {
  document.title = "Previous games · Meaning Ladder";
  const token = routeToken;
  const config = await loadConfig();
  if (token !== routeToken) return;
  const t = today();
  const last = gameNumberOrNull(t, config) ?? 0;
  const results = getResults();
  const items = [];
  for (let n = last; n >= 1; n--) {
    const date = dateOfGame(n, config);
    const r = results[date];
    const mark = r?.status === "won" ? `${r.steps} steps ${medalFor(r.steps, r.par).emoji}`
      : r?.status === "gaveUp" ? "gave up" : store.get(`game:${date}`) ? "in progress" : "–";
    items.push(h("li", {}, h("a", { href: `#/game/${n}` },
      h("span", {}, `#${n} · ${shortDate(date)}`), h("span", {}, mark))));
  }
  render(
    topbar("Previous games"),
    items.length ? h("ol", { class: "archive" }, items)
      : h("p", { class: "boot" }, `No games yet. Game #1 is on ${longDate(config.launchDate)}.`));
}

function topbar(title, menu = null) {
  return h("header", { class: "topbar" },
    h("a", { class: "icon-btn", href: "#/", "aria-label": "Back to home" }, icon("back")),
    h("h1", {}, title),
    menu ?? h("span"));
}

// ------------------------------------------------------------ game screen
function newState(kind, puzzle) {
  return { kind, puzzle, path: [puzzle.start], hints: 0, hint: null, status: "playing" };
}

async function showGame(kind, n) {
  const token = routeToken;
  render(topbar("meaning ladder"), h("p", { class: "boot", role: "status" }, "Loading the word map…"));

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
  if (kind === "daily") {
    date = dateOfGame(n, config);
    if (n < 1 || date > today()) {
      render(topbar("meaning ladder"), h("p", { class: "boot" }, "That game isn't out yet. No peeking! 🙂"));
      return;
    }
    saveKey = `game:${date}`;
    // A saved game keeps its own puzzle, so a refresh can never swap it.
    state = store.get(saveKey) ?? newState("daily", await loadDailyPuzzle(ladder, date));
  } else {
    saveKey = "practice";
    state = store.get(saveKey);
    if (!state || !ladder.index.has(state.puzzle.start) || !ladder.index.has(state.puzzle.goal)) {
      state = newState("practice", makePracticePuzzle(ladder));
    }
  }
  if (token !== routeToken) return;
  playView(ladder, state, saveKey, date);
}

function playView(ladder, state, saveKey, date) {
  const { puzzle } = state;
  const goalIdx = ladder.index.get(puzzle.goal);
  const dist = distancesToGoal(ladder.reverse, ladder.words.length, goalIdx);
  const stepsTo = (word) => dist[ladder.index.get(word)];
  // The graph is the source of truth: if a puzzle file's par disagrees with
  // the real shortest path, trust the BFS (and say so in the console).
  const truePar = stepsTo(puzzle.start);
  if (truePar > 0 && truePar !== puzzle.par) {
    console.warn(`Puzzle file says par ${puzzle.par}, but the shortest path is ${truePar}.`);
    puzzle.par = truePar;
  }
  const label = state.kind === "daily" ? `#${puzzle.gameNumber}` : "practice";
  document.title = `${state.kind === "daily" ? `#${puzzle.gameNumber}` : "Practice"} · Meaning Ladder`;

  let error = null;
  let justAdded = false;
  let countdownTimer = null;
  cleanups.push(() => clearInterval(countdownTimer));
  const save = () => store.set(saveKey, state);
  if (state.status === "playing") save();

  // ---- static parts
  const menuBtn = h("button", { class: "icon-btn", "aria-label": "Menu", "aria-haspopup": "true",
    "aria-expanded": "false", "aria-controls": "game-menu" }, icon("dots"));
  const menu = h("div", { class: "menu", id: "game-menu", role: "menu", hidden: true });
  const menuWrap = h("div", { class: "menu-wrap" }, menuBtn, menu);

  const status = h("p", { class: "status" });
  const theme = (puzzle.theme || puzzle.teaser) && h("p", { class: "theme" },
    h("strong", {}, puzzle.theme), puzzle.teaser ? h("span", {}, ` · ${puzzle.teaser}`) : null);
  const pills = h("div", { class: "pills", "aria-label": `From ${puzzle.start} to ${puzzle.goal}` },
    h("span", { class: "pill" }, puzzle.start), h("span", { class: "arrow" }, "→ … →"),
    h("span", { class: "pill goal" }, puzzle.goal));

  const input = h("input", { id: "guess", type: "text", autocomplete: "off", autocapitalize: "none",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "go", maxlength: "30" });
  const form = h("form", { class: "guess", onSubmit: (e) => { e.preventDefault(); submit(); } },
    h("label", { for: "guess", class: "visually-hidden" }, "Next word"), input);
  const feedback = h("div", { class: "feedback", "aria-live": "polite" });
  const win = h("section", { class: "card win", hidden: true, "aria-live": "polite" });
  const list = h("ol", { class: "path", "aria-label": "Your path, newest first" });
  const undoBtn = h("button", { class: "btn btn-quiet", onClick: undo }, "Undo");
  const hintBtn = h("button", { class: "btn btn-quiet", onClick: hint }, "Hint");
  const actions = h("div", { class: "actions" }, undoBtn, hintBtn);

  render(topbar("meaning ladder", menuWrap), status, theme, pills, win, form, feedback, list, actions);

  // ---- menu
  const menuItems = [
    ["Hint", hint, () => state.status === "playing"],
    ["Give up", confirmGiveUp, () => state.status === "playing"],
    ...(state.kind === "practice" ? [["New practice ladder", newPractice, () => true]] : []),
    ["How to play", showHelp, () => true],
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
      error = res.error;         // keep the typed text so a typo is easy to fix
      update();
      input.select();
      return;
    }
    state.path.push(res.word);
    state.hint = null;
    error = null;
    justAdded = true;
    input.value = "";
    if (res.word === puzzle.goal) finish("won");
    save();
    update();
  }

  function undo() {
    if (state.status !== "playing" || state.path.length < 2) return;
    state.path.pop();
    state.hint = null;
    error = null;
    save();
    update();
    input.focus();
  }

  function hint() {
    if (state.status !== "playing") return;
    const current = state.path[state.path.length - 1];
    const d = stepsTo(current);
    if (d < 0) {
      state.hint = { word: current, text: `There's no way to ${puzzle.goal} from ${current}. Try Undo.` };
    } else {
      const next = ladder.words[routeToGoal(ladder.neighbors, dist, ladder.index.get(current))[1]];
      const tier = state.hint?.word === current ? state.hint.tier + 1 : 1;
      if (tier > 2) return;
      state.hints++;
      state.hint = {
        word: current, tier,
        text: tier === 1
          ? `${current} is ${d} step${d === 1 ? "" : "s"} from ${puzzle.goal}. Try a word starting with “${next[0]}”. (Hint again to reveal it.)`
          : `Try “${next}”.`,
      };
    }
    error = null;
    save();
    update();
    input.focus();
  }

  function confirmGiveUp() {
    openDialog("Give up?", h("p", {}, "We'll show you one shortest route. This ends the game"
      + (state.kind === "daily" ? " and your streak." : ".")),
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

  // ---- rendering
  function bar(word, { latest = false, isStart = false, enter = false } = {}) {
    const d = stepsTo(word);
    const { tone, fill } = closeness(d);
    const num = d === 0 ? "goal" : d < 0 ? "–" : d;
    return h("li", {
      class: `bar tone-${tone}${latest ? " latest" : ""}${enter ? " enter" : ""}`,
      style: `--fill:${fill}%`,
    },
    h("span", {}, word, isStart ? h("span", { class: "tag" }, "start") : null),
    h("span", { class: "num" }, num,
      h("span", { class: "visually-hidden" }, d > 0 ? " steps to goal" : "")));
  }

  function update() {
    const steps = state.path.length - 1;
    const current = state.path[state.path.length - 1];
    const playing = state.status === "playing";
    const when = state.kind === "daily" ? `#${puzzle.gameNumber} · ${shortDate(date)}` : "Practice";
    status.textContent = `${when} · Steps: ${steps} · Par: ${puzzle.par}`;

    input.placeholder = `Next step from ${current}`;
    form.hidden = !playing;
    feedback.hidden = !playing;
    actions.hidden = !playing;
    undoBtn.disabled = steps === 0;
    hintBtn.disabled = state.hint?.word === current && state.hint?.tier >= 2;

    // Feedback slot: exactly one thing.
    if (!playing) feedback.replaceChildren();
    else if (error) feedback.replaceChildren(h("p", { class: "error" }, error));
    else if (state.hint?.word === current) feedback.replaceChildren(h("p", { class: "hintline" }, "💡 ", state.hint.text));
    else if (steps > 0) feedback.replaceChildren(h("ol", { class: "path", style: "margin:0" }, bar(current, { latest: true })));
    else feedback.replaceChildren(h("p", { class: "muted" }, `Type a word close in meaning to ${puzzle.start}.`));

    // Full path, newest on top; the start word sits at the bottom.
    list.replaceChildren(...state.path.map((w, i) => bar(w, {
      latest: playing && i === steps && steps > 0,
      isStart: i === 0,
      enter: justAdded && i === steps,
    })).reverse());
    justAdded = false;

    renderWin();
  }

  function renderWin() {
    win.hidden = state.status === "playing";
    if (win.hidden) return;
    const steps = state.path.length - 1;
    const won = state.status === "won";
    const medal = won ? medalFor(steps, puzzle.par) : null;
    const route = routeToGoal(ladder.neighbors, dist, ladder.index.get(puzzle.start)).map((i) => ladder.words[i]);
    const toast = h("p", { class: "toast", role: "status" });
    const shareBtn = h("button", { class: "btn", onClick: () => share(toast) }, "Share result");

    const countdown = h("p", { class: "countdown" });
    if (state.kind === "daily") {
      const tick = () => {
        // Real clock on purpose (even with ?today=): time to the next local midnight.
        const now = new Date();
        const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
        if (ms <= 0) { countdown.replaceChildren("A new ladder is ready! ", h("a", { href: "#/" }, "Play it")); return; }
        const s = Math.floor(ms / 1000);
        const pad = (x) => String(x).padStart(2, "0");
        countdown.replaceChildren("Next ladder in ", h("b", {}, `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`));
      };
      tick();
      clearInterval(countdownTimer); // never stack two timers
      countdownTimer = setInterval(tick, 1000);
    }

    win.replaceChildren(...[ // .filter(Boolean): replaceChildren(null) would print "null"
      h("div", { class: "medal", "aria-hidden": "true" }, won ? medal.emoji : "🧭"),
      h("h2", {}, won ? (medal.id === "finished" ? "You made it!" : `${medal.label}!`) : "Here's one way up"),
      h("p", { class: "result" }, won
        ? `${steps} step${steps === 1 ? "" : "s"} · par ${puzzle.par}${state.hints ? ` · ${state.hints} hint${state.hints === 1 ? "" : "s"}` : ""}`
        : `You stopped after ${steps} step${steps === 1 ? "" : "s"}. Par was ${puzzle.par}.`),
      h("p", { class: "route" },
        won && state.path.join() === route.join() ? "You found the most direct route: "
          : won && steps === puzzle.par ? "You found a shortest route! Another one: "
          : "One shortest route: ",
        h("b", {}, route.join(" → "))),
      h("div", { class: "btn-row" },
        shareBtn,
        state.kind === "practice"
          ? h("button", { class: "btn btn-quiet", onClick: newPractice }, "Play another")
          : h("a", { class: "btn btn-quiet", href: "#/" }, "Home")),
      toast,
      state.kind === "daily" ? countdown : null,
      state.kind === "daily" ? statsRow(computeStats(getResults(), today())) : null,
    ].filter(Boolean));
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
      const box = h("textarea", { rows: "3", readonly: true, style: "width:100%;margin-top:8px", "aria-label": "Result to copy" }, text);
      toast.replaceChildren("Copy this:", box);
      box.select();
    }
  }

  update();
  if (state.status === "playing") input.focus();
}

// ------------------------------------------------------------ start
window.addEventListener("hashchange", route);
route();
