// Meaning Ladder: screens, routing and events.
//
// Routes live in the URL hash so the static site needs no server:
//   #/            home
//   #/game/12/hard    daily game #12 at one level (easy, medium, hard)
//   #/game/12         -> the first level of #12 you haven't finished
//   #/practice/easy   unlimited random ladders at a level
//   #/archive     previous games
// For testing: ?today=YYYY-MM-DD pretends it's that date (local view only).

import { ladderFor, loadConfig, loadDailyPuzzle, loadLadder, makePracticePuzzle, migrateStorage, readyFor, store } from "./data.js";
import {
  addDays, computeStats, localDateStr, rankFill, stairStep, triedOrder, medalFor, pointsFor, resultPoints, shareText,
  classicLabel, isClassicDay, newestEra, playedDates, rulesNoticeDue, rulesNoticeText, betterMedal, resultMedal, scoreOf,
  linkedGame, linkedHint, linkedRung, linkedStart, linkedSubmit, shownLetters,
  FEEDBACK_KINDS, FEEDBACK_MAX, feedbackPayload, feedbackUrl,
} from "./logic.js";
import { ICONS as PHOSPHOR } from "./icons.js";
import { LEVELS, chainRank, gameNumber, rulesFor } from "./seeded.js";

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
const OTHER_GAME = "https://lereplacey.vercel.app/";
// One Unlimited save per level, so switching levels never discards a game.
const practiceKey = (level) => `practice:${level}`;
const resultKey = (date, level) => `${date}:${level}`;
const getResults = () => store.get("results", {});
function saveResult(date, state) {
  const results = getResults();
  results[resultKey(date, state.puzzle.level)] = {
    status: state.status, steps: state.path.length - 1, par: state.puzzle.par,
    moves: state.moves, hints: state.hints, playedOn: today(),
    // Lets a ladder started before midnight and solved after it still count
    // for its own day's streak (see countsForStreak in logic.js).
    startedOn: state.startedOn ?? null,
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

// The best medal earned on any level that day, or null. Compares medals, not
// moves over par: a capped gold-pace solve is only silver.
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
    // An action's optional 4th item is a check: false keeps the dialog open.
    h("div", { class: "dialog-actions" }, actions.map(([label, fn, primary, check]) =>
      h("button", {
        class: primary ? "btn" : "btn btn-quiet",
        onClick: () => { if (check && !check()) return; dlg.close(); fn?.(); },
      }, label))));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  dlg.scrollTop = 0;
  return dlg;
}

// One How to play for Daily and Unlimited.
function showHelp() {
  store.set("seenHelp", true);
  // Four rules, nothing else: players who read a long list still got lost.
  openDialog("How to play", h("div", {},
    h("ol", { class: "rules" },
      h("li", {}, "Get from the ", h("b", {}, "start"), " word to the ", h("b", {}, "goal"), ", one rung at a time."),
      h("li", {}, "Each rung shows a ", h("b", {}, "clue"), " for the next word, like “A kind of dog” or “5 letters, starts with T”. A word counts if it fits the clue and gets you one rung closer to the goal. Its plural counts too."),
      h("li", {}, "A wrong word costs a ", h("b", {}, "move"), ". Typos and repeats are free."),
      h("li", {}, "A ", h("b", {}, "hint"), " shows a letter of the next word for one move; the last letter plays the word. Every word and hint is a move: finish in ",
        h("b", {}, "par"), " for gold.")),
    h("p", { class: "sub example-caption" }, "Example: after dog, the clue says “Dog is a kind of this”. “cat”? Not it, one move. “animal”: yes."),
    h("p", { class: "sub example-caption" }, "Three new ladders every day: Easy, Medium and Hard. Unlimited has as many as you like."))
  );
}

// The one pop-up on load. Newcomers get How to play (it already teaches
// today's rules, so the "New rules" notice is marked seen for them).
// Returning players who played under an older era get a one-time notice
// when a new era starts. Never both: two stacked dialogs on load is noise.
async function showIntro() {
  const newcomer = !store.get("seenHelp");
  if (newcomer) showHelp();
  let config;
  try { config = await loadConfig(); } catch { return; }
  const newest = newestEra(config);
  if (!newest) return;
  const seenKey = `seenRules:${newest.from}`;
  if (newcomer) {
    // Only once the era has begun: a player who starts the day before the
    // change still learns the old rules first and needs the notice later.
    if (today() >= newest.from) store.set(seenKey, true);
    return;
  }
  const dates = playedDates(getResults(), store.keys("game:"));
  if (!rulesNoticeDue(config, today(), dates, store.get(seenKey))) return;
  store.set(seenKey, true);
  const day = (s) => fmt(s, { month: "long", day: "numeric" });
  openDialog("New rules", h("p", {}, rulesNoticeText(config, day)), [["Got it", null, true]]);
}

function showStats() {
  const s = computeStats(getResults(), today());
  const { easy, medium, hard } = s.solvedByLevel;
  const a = s.avgPointsByLevel, av = (v) => (v == null ? "none yet" : v);
  openDialog("Statistics", h("div", {}, statsRow(s),
    h("p", { class: "sub stats-note" },
      `Solved so far: ${easy} easy, ${medium} medium, ${hard} hard.`),
    h("p", { class: "sub stats-note" },
      `Average points: easy ${av(a.easy)}, medium ${av(a.medium)}, hard ${av(a.hard)}`)));
}

// ------------------------------------------------------------ feedback
// Which game the player was on, for the feedback form.
function feedbackContext(state) {
  const p = state.puzzle;
  const which = state.kind === "daily" ? `Game ${p.gameNumber} (${p.date})` : "Unlimited";
  return [`${which}, ${p.level ?? "medium"}`,
    `Status: ${state.status}, ${state.moves ?? 0} moves`];
}

// "Send" posts to a small Vercel function (feedback-api/) that holds the
// GitHub key and files the issue, so players need no account. If it can't be
// reached, the old way still works: a pre-filled GitHub issue in a new tab.
// `context` names the game the player is on (no words, so no spoilers).
const FEEDBACK_REPO = "meaningladder/meaningladder.github.io";
const FEEDBACK_API = "https://meaning-ladder-feedback.vercel.app/api/feedback";

function showFeedback(context = []) {
  const openedAt = Date.now();
  const kind = h("select", { id: "fb-kind" },
    FEEDBACK_KINDS.map((k) => h("option", { value: k }, k)));
  const text = h("textarea", { id: "fb-text", rows: 5, maxlength: FEEDBACK_MAX,
    placeholder: "What happened, or what would make the game better?" });
  // Honeypot: hidden from people (and screen readers); bots fill it in.
  const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", class: "fb-trap" });
  const hint = h("p", { class: "fb-error", "aria-live": "polite" });
  const info = [...context, `Browser: ${navigator.userAgent}`];
  const form = h("div", { class: "fb" },
    h("label", { for: "fb-kind" }, "What is it about?"), kind,
    h("label", { for: "fb-text" }, "Your feedback"), text, trap, hint,
    h("p", { class: "sub" }, "Sent as a public GitHub issue (no account needed). Please don't write today's answers."),
    h("details", { class: "fb-context" }, h("summary", {}, "Also sent"),
      h("p", {}, info.join("\n"))));
  const onGitHub = () => window.open(feedbackUrl(FEEDBACK_REPO, { kind: kind.value, text: text.value, context: info }), "_blank", "noopener");
  let sending = false;
  const dlg = openDialog("Send feedback", form, [["Cancel", null], ["Send", null, true, () => {
    if (sending) return false;
    if (!text.value.trim()) {
      hint.textContent = "Write a few words first.";
      text.focus();
      return false;
    }
    send();
    return false; // stays open: send() shows the result
  }]]);
  const [cancelBtn, sendBtn] = dlg.querySelectorAll(".dialog-actions button");

  async function send() {
    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    hint.textContent = "";
    let res = null, data = null;
    try {
      res = await fetch(FEEDBACK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedbackPayload({ kind: kind.value, text: text.value, context: info, website: trap.value, openMs: Date.now() - openedAt })),
      });
      data = await res.json().catch(() => null);
    } catch {
      /* offline, blocked, or the function is down */
    }
    sending = false;
    if (res?.ok && data?.ok) {
      form.replaceChildren(h("p", {}, "Thanks! ",
        data.number ? ["Sent as ", h("a", { href: data.url, target: "_blank", rel: "noopener" }, `issue #${data.number}`), "."] : "Your feedback was sent."));
      sendBtn.remove();
      cancelBtn.textContent = "Close";
      return;
    }
    // A clear reason from the function (too quick, too long...) is shown as is;
    // anything else offers GitHub instead.
    const reason = res && res.status < 500 && res.status !== 403 ? data?.error : null;
    if (reason) hint.replaceChildren(reason);
    else hint.replaceChildren("Couldn't send right now. ",
      h("button", { type: "button", class: "link-btn", onClick: onGitHub }, "Send on GitHub instead"));
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
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
    // Resume whichever level has a game going; otherwise medium.
    const level = LEVELS.find((lv) => store.get(practiceKey(lv))?.status === "playing");
    return location.replace(`#/practice/${level ?? "medium"}`);
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
  const classic = num ? classicLabel(config, date) : "";
  const label = `${longDate(date)}${num ? `, game ${num}` : ""}${classic ? `, ${classic}` : ""}${state}`;
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
      const status = medal ? `${scoreOf(r)} moves · ${resultPoints(r)} pts` : r?.status === "gaveUp" ? "Gave up" : inProgress ? "Resume" : "Play";
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

  const practice = h("section", { class: "card", "aria-labelledby": "practice-title" },
    h("h2", { id: "practice-title" }, "Unlimited"),
    h("p", { class: "sub" }, "Random ladders, as many as you like. No streaks at stake."),
    h("div", { class: "levels", role: "group", "aria-label": "Unlimited ladders" },
      LEVELS.map((level) => {
        const resume = store.get(practiceKey(level))?.status === "playing";
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
    // Our other daily word game, black and orange so it stands out.
    h("a", { class: "btn btn-wide other-game-link", href: OTHER_GAME, target: "_blank", rel: "noopener" },
      "Play LeReplacey, our other word game"),
    practice,
    h("footer", { class: "home-foot" },
      h("button", { class: "link-btn", onClick: () => showHelp() }, "How to play"),
      h("button", { class: "link-btn", onClick: showStats }, "Statistics"),
      h("button", { class: "link-btn", onClick: () => showFeedback() }, "Send feedback")),
    // Plain words for people (and search engines) who don't know the game yet.
    h("p", { class: "about" }, "Meaning Ladder is a free daily word puzzle. Each day has three word ladders, ",
      "easy, medium and hard: climb from the start word to the goal one step at a time, ",
      "each word close in meaning to the last. Play past days or unlimited ladders any time."),
    // ConceptNet's license (CC BY-SA 4.0) asks for credit wherever it's used.
    h("p", { class: "credits" }, "Word links from ",
      h("a", { href: "https://conceptnet.io", rel: "noopener" }, "ConceptNet 5.7"), ", CC BY-SA 4.0."));

  showIntro();                                      // the only pop-up on load
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
  // Once a new era starts, older days still play by their own rules; say so
  // up front so a top-100 archive day doesn't feel like a bug.
  const newest = newestEra(config);
  const before = newest && addDays(newest.from, -1);
  const classicNote = newest && t >= newest.from && isClassicDay(config, config.launchDate) && h("p", { class: "archive-note" },
    `Games before ${fmt(newest.from, { month: "long", day: "numeric" })} use classic rules: `
    + `each step may be any of the previous word's ${rulesFor(config, before).stepLimit} closest words.`);
  render(topbar("Previous games"), classicNote, ...months);
}

function topbar(title, menu = null) {
  return h("header", { class: "topbar" },
    h("a", { class: "icon-btn", href: "#/", "aria-label": "Back to home" }, icon("arrow-left")),
    h("h1", {}, title),
    menu ?? h("span"));
}

// ------------------------------------------------------------ game screen
// state.rungs[k] holds rung k's wrong words and hints (see linkedStart).
function newState(kind, puzzle) {
  const state = { kind, ...linkedStart(puzzle) };
  // The day a daily ladder was opened, so finishing it after midnight still
  // counts for the streak of the day it belongs to.
  if (kind === "daily") state.startedOn = today();
  return state;
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
      state = store.get(saveKey);
      if (state?.mode !== "linked") { // none yet, or a save from the old rules
        const puzzle = await loadDailyPuzzle(ladder, date, level);
        state = newState("daily", puzzle);
      }
    } else {
      saveKey = practiceKey(level);
      state = store.get(saveKey);
      if (state?.mode !== "linked" || state.puzzle?.level !== level
          || !ladder.index.has(state.puzzle.start) || !ladder.index.has(state.puzzle.goal)
          || !state.puzzle.route.every((w) => ladder.index.has(w))) {
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
  gameView(ladderFor(ladder, state.puzzle), state, saveKey, date); // that puzzle's rules
}

// ------------------------------------------------------------ shared game-screen parts

// The game menu (three dots). items: [label, fn, enabled()]; `enabled` is
// read each time the menu opens. Its document listeners end with the screen.
function gameMenu(items) {
  const menuBtn = h("button", { class: "icon-btn", "aria-label": "Menu", "aria-haspopup": "true",
    "aria-expanded": "false", "aria-controls": "game-menu" }, icon("dots-three"));
  const menu = h("div", { class: "menu", id: "game-menu", role: "menu", hidden: true });
  const wrap = h("div", { class: "menu-wrap" }, menuBtn, menu);
  function openMenu(open) {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      menu.replaceChildren(...items.map(([text, fn, enabled]) =>
        h("button", { role: "menuitem", disabled: !enabled(), onClick: () => { openMenu(false); fn(); } }, text)));
      menu.querySelector("button:not(:disabled)")?.focus();
    }
  }
  menuBtn.addEventListener("click", () => openMenu(menu.hidden));
  const onDocClick = (e) => { if (!wrap.contains(e.target)) openMenu(false); };
  const onKey = (e) => { if (e.key === "Escape" && !menu.hidden) { openMenu(false); menuBtn.focus(); } };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  cleanups.push(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });
  return wrap;
}

// Easy | Medium | Hard; solved daily levels carry their medal. Rebuilt on
// every update, so a medal appears the moment you win.
function renderLevelSwitcher(el, { daily, date, level, href }) {
  const results = daily ? getResults() : {};
  el.replaceChildren(...LEVELS.map((lv) => {
    const r = results[resultKey(date, lv)];
    const medal = r?.status === "won" ? resultMedal(r) : null;
    return h("a", { class: `level-btn${lv === level ? " current" : ""}`, href: href(lv),
      "aria-current": lv === level ? "page" : null,
      "aria-label": `${LEVEL_LABEL[lv]}${medal ? `, solved, ${medal.label}` : ""}` },
      medal ? medalBadge(medal.id, "xs") : null, LEVEL_LABEL[lv]);
  }));
}

// "Next ladders in hh:mm:ss". Returns a function that builds a fresh line;
// each call stops the previous timer (the result card is rebuilt on every
// update), and leaving the screen stops the last one.
function makeCountdown() {
  let timer = null;
  cleanups.push(() => clearInterval(timer));
  return () => {
    const el = h("p", { class: "countdown" });
    const tick = () => {
      // Real clock on purpose (even with ?today=): time to the next local midnight.
      const now = new Date();
      const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
      if (ms <= 0) { el.replaceChildren("New ladders are ready! ", h("a", { href: "#/" }, "Play them")); return; }
      const sec = Math.floor(ms / 1000);
      const pad = (x) => String(x).padStart(2, "0");
      el.replaceChildren("Next ladders in ", h("b", {}, `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`));
    };
    tick();
    clearInterval(timer); // never stack two timers
    timer = setInterval(tick, 1000);
    return el;
  };
}

// Copy a result to the clipboard, or show it in a selectable box: the
// Clipboard API needs HTTPS plus permission.
async function copyShare(text, toast) {
  try {
    await navigator.clipboard.writeText(text);
    toast.textContent = "Copied to clipboard!";
  } catch {
    const box = h("textarea", { rows: "3", readonly: true, class: "share-box", "aria-label": "Result to copy" }, text);
    toast.replaceChildren("Copy this:", box);
    box.select();
  }
}

// ------------------------------------------------------------ the game
// Daily and Unlimited alike: each rung shows a clue for the next word (see
// linkedSubmit in logic.js). Any word that fits it and is one rung closer
// counts; wrong real words go to the Tried list, ranked by chainRank.
function gameView(ladder, state, saveKey, date) {
  const { puzzle } = state;
  // The graph is the source of truth: if a puzzle file's par disagrees with
  // the real shortest path, trust the BFS (and say so in the console).
  let game = linkedGame(ladder, puzzle);
  const truePar = game.dist[ladder.index.get(puzzle.start)];
  if (truePar > 0 && truePar !== puzzle.par) {
    console.warn(`Puzzle file says par ${puzzle.par}, but the shortest path is ${truePar}.`);
    puzzle.par = truePar;
    game = linkedGame(ladder, puzzle);
  }
  const daily = state.kind === "daily";
  // The game number always comes from the date and the current launch date,
  // never from a saved copy (saves made before a launch-date change are stale).
  if (daily) puzzle.gameNumber = gameNumber(date, ladder.config.launchDate);
  const level = puzzle.level ?? "medium";
  const levelLabel = LEVEL_LABEL[level];
  const label = daily ? `#${puzzle.gameNumber} ${levelLabel}` : `unlimited (${level})`;
  document.title = `${daily ? `#${puzzle.gameNumber} ${levelLabel}` : `Unlimited ${levelLabel}`} · Meaning Ladder`;
  const levelHref = (lv) => (daily ? `#/game/${puzzle.gameNumber}/${lv}` : `#/practice/${lv}`);
  // A daily file's route can come with a reason per step (AI-checked).
  const reasons = game.route && Array.isArray(puzzle.reasons) && puzzle.reasons.length === puzzle.par
    ? puzzle.reasons.map(String) : null;

  let error = null;      // a free rejection (typo, unknown word, repeat)
  let note = null;       // "Counted as truck."
  let missed = null;     // the wrong word just tried, for screen readers
  let justMissed = false;
  let justSolved = -1;   // rung to animate once
  const countdown = makeCountdown();
  const save = () => store.set(saveKey, state);
  if (state.status === "playing") save();
  const rungNow = () => state.path.length - 1;

  const status = h("p", { class: "status" });
  // The clue is read out when it changes; focus stays in the input.
  const clue = h("p", { class: "clue", "aria-live": "polite" });
  const switcher = h("nav", { class: "levels compact", "aria-label": "Level" });
  const input = h("input", { id: "guess", type: "text", autocomplete: "off", autocapitalize: "none",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "go", maxlength: "30" });
  const form = h("form", { class: "guess", onSubmit: (e) => { e.preventDefault(); submit(); } },
    h("label", { for: "guess", class: "visually-hidden" }, "Next word"), h("span", { class: "field" }, input),
    h("button", { type: "submit", class: "btn go" }, "Go"));
  const feedback = h("div", { class: "feedback", "aria-live": "polite" });
  const tried = h("section", { class: "tried", hidden: true, "aria-label": "Wrong words for this rung" });
  const win = h("section", { class: "card win", hidden: true, "aria-live": "polite" });
  const ladderEl = h("ol", { class: "ladder", "aria-label": `Ladder from ${puzzle.start} up to ${puzzle.goal}` });
  const hintBtn = h("button", { class: "btn btn-quiet", onClick: hint, title: "Shows one letter of the next word. Costs one move." }, "Hint");
  const actions = h("div", { class: "actions" }, hintBtn);

  const menuWrap = gameMenu([
    ["Hint", hint, () => state.status === "playing"],
    ["Give up", confirmGiveUp, () => state.status === "playing"],
    ...(daily ? [] : [["New unlimited ladder", newPractice, () => true]]),
    ["How to play", showHelp, () => true],
    ["Statistics", showStats, () => true],
    ["Send feedback", () => showFeedback(feedbackContext(state)), () => true],
    ["Previous games", () => { location.hash = "#/archive"; }, () => true],
  ]);

  render(topbar(daily ? `Game ${puzzle.gameNumber}` : "Unlimited", menuWrap),
    switcher, status, clue, win, ladderEl, feedback, tried, form, actions);

  // ---- actions
  function submit() {
    if (state.status !== "playing") return;
    const k = rungNow();
    const { planned } = linkedRung(game, state);
    const res = linkedSubmit(game, state, input.value);
    error = note = missed = null;
    if (res.ok) {
      note = res.note ?? null;
      justSolved = k;
      input.value = "";
    } else if (res.wrong) {
      state.rungs[k].misses.at(-1).rank = chainRank(ladder, planned, ladder.index.get(res.word)) ?? "?";
      missed = res.word;
      justMissed = true;
      input.select();
    } else {
      error = res.error; // free: no move
      input.select();
    }
    after();
  }

  function hint() {
    if (state.status !== "playing") return;
    const k = rungNow();
    linkedHint(game, state);
    if (rungNow() > k) justSolved = k;
    error = note = missed = null;
    after();
    input.focus();
  }

  function after() {
    if (state.status === "won" && daily) saveResult(date, state);
    save();
    update();
  }

  function confirmGiveUp() {
    openDialog("Give up?", h("p", {}, `We'll show you a way up. This ends this ${levelLabel.toLowerCase()} ladder.`),
      [["Keep playing", () => input.focus()], ["Give up", () => {
        state.status = "gaveUp";
        if (daily) saveResult(date, state);
        save();
        update();
      }, true]]);
  }

  // Throwing away a ladder with real progress asks first.
  function newPractice() {
    const fresh = () => { store.remove(saveKey); route(); };
    if (state.status !== "playing" || state.moves === 0) return fresh();
    openDialog("Start a new ladder?", h("p", {}, "This one will be lost."),
      [["Keep playing", () => input.focus()], ["New ladder", fresh, true]]);
  }

  // ---- rendering
  const srOnly = (text) => h("span", { class: "visually-hidden" }, text);
  // Climbed rungs form a staircase: color and fill grow with height.
  const stair = (el, rung) => {
    const step = stairStep(rung, puzzle.par);
    el.classList.add("stair");
    el.style.setProperty("--stair-hue", step.hue);
    el.style.setProperty("--fill", `${step.fill}%`);
    return el;
  };

  // After giving up: the rest of the way from the last word, planned rung by rung.
  function wayUp() {
    const s = { ...state, path: [...state.path], rungs: [] };
    while (s.path.at(-1) !== puzzle.goal) s.path.push(ladder.words[linkedRung(game, s).planned]);
    return s.path;
  }

  // Rows top (goal) to bottom (start). Path word k sits on rung k.
  function rows() {
    const playing = state.status === "playing";
    const cur = rungNow();
    const shown = playing ? state.path : wayUp();
    const out = [stair(h("li", { class: `bar${state.status === "won" ? " latest" : " goal-slot"}` },
      srOnly(`Rung ${puzzle.par}, the goal: `), h("span", {}, puzzle.goal, h("span", { class: "tag" }, "goal"))), puzzle.par)];
    for (let k = puzzle.par - 1; k >= 1; k--) {
      if (k <= cur || !playing) {
        const solved = k <= cur;
        out.push(stair(h("li", { class: `bar${solved ? " passed" : " ghost-word"}${justSolved === k - 1 ? " enter" : ""}` },
          srOnly(`Rung ${k}${solved ? "" : ", not found"}: `),
          h("span", {}, shown[k], solved ? null : h("span", { class: "tag" }, "answer"))), k));
        continue;
      }
      const next = k === cur + 1;
      out.push(h("li", { class: `rung${next ? " next" : ""}`, "aria-current": next ? "step" : null },
        srOnly(`Rung ${k}${next ? ", your next word" : ""}: `), h("span", { "aria-hidden": "true" }, "?")));
    }
    out.push(stair(h("li", { class: "bar passed" }, srOnly("Rung 0, the start: "),
      h("span", {}, puzzle.start, h("span", { class: "tag" }, "start"))), 0));
    justSolved = -1;
    return out;
  }

  function renderTried(k, playing) {
    const r = playing ? state.rungs[k] : null;
    tried.hidden = !r?.misses.length;
    if (tried.hidden) return;
    const latest = r.misses[r.misses.length - 1];
    tried.replaceChildren(
      h("span", { class: "tried-head" }, "Not it:"),
      h("ol", { class: "tchips" }, triedOrder(r.misses).map((m) => {
        const known = typeof m.rank === "number";
        return h("li", {
          class: `tchip${m === latest ? " latest" : ""}${m === latest && justMissed ? " enter" : ""}`,
          style: `--fill:${known ? rankFill(m.rank) : 0}%` }, m.word,
          srOnly(known ? `, #${m.rank} closest to the answer` : ", not among the answer's closest words"));
      })));
    justMissed = false;
  }

  let clueShown = null; // rung, text and letters last drawn: redrawing re-announces the live region
  function renderClue(playing) {
    clue.hidden = !playing;
    if (!playing) return;
    const { k, clue: c, r } = linkedRung(game, state);
    const letters = r.hints ? shownLetters(game, state) : null;
    const key = `${k}|${c.text}|${letters?.join("")}`;
    if (key === clueShown) return;
    clueShown = key;
    clue.replaceChildren(h("span", { class: "clue-label" }, "Next word: "), h("b", {}, c.text),
      h("span", { class: "clue-letters", hidden: !letters },
        letters && [srOnly(", letters so far: "),
          h("span", { "aria-hidden": "true" }, letters.join(" ")),
          srOnly(letters.map((x) => (x === "_" ? "blank" : x)).join(" "))]));
  }

  function update() {
    const playing = state.status === "playing";
    const k = rungNow();
    status.textContent = `Par ${puzzle.par} · Moves ${state.moves}`;
    form.hidden = feedback.hidden = actions.hidden = !playing;
    renderLevelSwitcher(switcher, { daily, date, level, href: levelHref });
    renderClue(playing);
    ladderEl.replaceChildren(...rows());
    renderTried(k, playing);
    if (playing) {
      input.placeholder = `Word after ${state.path[k]}`;
      if (error) feedback.replaceChildren(h("p", { class: "error" }, error));
      else if (note) feedback.replaceChildren(h("p", { class: "muted" }, note));
      else if (missed) feedback.replaceChildren(h("p", { class: "visually-hidden" }, `${missed} is not it. It costs one move.`));
      else feedback.replaceChildren(h("p", { class: "muted" }, `Which word comes after ${state.path[k]}?`));
    }
    renderWin();
  }

  function renderWin() {
    win.hidden = state.status === "playing";
    if (win.hidden) return;
    const won = state.status === "won";
    const moves = state.moves;
    const medal = won ? medalFor(moves, puzzle.par) : null;
    const toast = h("p", { class: "toast", role: "status" });
    const next = daily ? nextLevel(date, getResults(), level) : null;
    win.replaceChildren(...[ // .filter(Boolean): replaceChildren(null) would print "null"
      medalBadge(won ? medal.id : "gaveUp", "lg"),
      h("h2", {}, won ? (medal.id === "finished" ? "You made it!" : `${medal.label}!`) : "Here's one way up"),
      h("p", { class: "result" }, won
        ? `${moves} move${moves === 1 ? "" : "s"}, par ${puzzle.par} · ${pointsFor(moves, puzzle.par)} pts`
        : `Par was ${puzzle.par}.`),
      won && note ? h("p", { class: "muted" }, note) : null,
      reasons ? h("div", { class: "route" }, h("p", {}, "Today's route, step by step:"),
        h("ol", { class: "reasons" }, reasons.map((text, k) =>
          h("li", {}, h("b", {}, `${puzzle.route[k]} → ${puzzle.route[k + 1]}`), " ", text)))) : null,
      daily && puzzle.theme ? h("p", { class: "muted" }, `Today's theme: ${puzzle.theme}`) : null,
      h("div", { class: "btn-row" },
        h("button", { class: "btn", onClick: () => share(toast) }, icon("share-network", "btn-icon"), "Share result"),
        !daily ? h("button", { class: "btn btn-quiet", onClick: newPractice }, icon("arrow-clockwise", "btn-icon"), "Play another")
          : next ? h("a", { class: "btn btn-quiet", href: levelHref(next) }, `Play ${LEVEL_LABEL[next]}`)
            : h("a", { class: "btn btn-quiet", href: "#/" }, "Home")),
      toast,
      daily ? countdown() : null,
    ].filter(Boolean));
  }

  async function share(toast) {
    const text = shareText({
      label, moves: state.moves, par: puzzle.par, gaveUp: state.status === "gaveUp",
      distances: state.path.map((_, i) => puzzle.par - i), // every played word is one rung up
      url: location.origin + location.pathname,
    });
    await copyShare(text, toast);
  }

  update();
  if (state.status === "playing") input.focus();
  // First visit straight to a game (a shared link): explain the rules once,
  // same as the home screen does (or announce new rules to a returning player).
  showIntro();
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
