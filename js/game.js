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
  acceptCap, rejectReason, addDays, autoGoal, playWord, closeness, computeStats, distancesToGoal, localDateStr,
  displayRank, normalize, rankFill, rankOf, rankTone, scoresFrom, stairStep, triedOrder,
  medalFor, movesOf, movesText, pointsFor, resultPoints, naturalRoute, costsToGoal, shareText, shortestRoute, hintStep,
  classicLabel, isClassicDay, newestEra, playedDates, rulesNoticeDue, rulesNoticeText,
  betterMedal, checkedRoute, clueFor, clueText, guideRoute, hintTier, ladderRows, resultMedal, scoreOf, upgradeHintState, upgradeMoves,
  bottleneckRoute, GENTLE_RANK, chainHint, chainLetters, chainStart, chainSubmit,
  FEEDBACK_KINDS, FEEDBACK_MAX, feedbackPayload, feedbackUrl,
} from "./logic.js";
import { ICONS as PHOSPHOR } from "./icons.js";
import { LEVELS, chainRank, levelAcceptRules, gameNumber, rulesFor } from "./seeded.js";

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

// The logo is the one custom mark: a night ladder, chalk rungs and the
// orange goal rung on top. Every UI glyph comes from Phosphor (js/icons.js).
const LOGO = '<svg viewBox="0 0 52 52" aria-hidden="true"><rect width="52" height="52" rx="12" fill="var(--logo-bg)"/><path d="M17 44V8M35 44V8" stroke="var(--logo-fg)" stroke-width="3.5" stroke-linecap="round"/><path d="M17 36h18" stroke="oklch(0.7 0.17 265)" stroke-width="4" stroke-linecap="round"/><path d="M17 27h18" stroke="oklch(0.7 0.19 330)" stroke-width="4" stroke-linecap="round"/><path d="M17 17h18" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/><circle cx="17" cy="36" r="4" fill="var(--accent)"/></svg>';
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

// Same text for every day and era: the closeness limit isn't spelled out.
function showHelp() {
  store.set("seenHelp", true);
  const ex = (word, d, { latest = false, isStart = false } = {}) => {
    const { hue, fill } = stairStep(4 - d, 4); // the same staircase as a real ladder
    return h("li", { class: `bar stair${latest ? " latest" : " passed"}`, style: `--stair-hue:${hue}; --fill:${fill}%` },
      h("span", {}, word, isStart ? h("span", { class: "tag" }, "start") : null),
      h("span", { class: "num" }, d === 0 ? "goal" : `${d} to go`));
  };
  // Four rules, nothing else: players who read a long list still got lost.
  openDialog("How to play", h("div", {},
    h("ol", { class: "rules" },
      h("li", {}, "Get from the ", h("b", {}, "start"), " word to the ", h("b", {}, "goal"), ", one word at a time."),
      h("li", {}, "Each word must be close in meaning to the last one."),
      h("li", {}, "Each rung accepts many close words — the top 40 on Easy (35 Medium, 30 Hard), a few fewer each rung you climb — if they're one rung closer to the goal or level. A level word costs a move but doesn't climb. Other words go to your Tried list, free."),
      h("li", {}, "Every word is a ", h("b", {}, "move"), ", even if undone. A hint costs one. Finish in ",
        h("b", {}, "par"), " for gold.")),
    h("p", { class: "sub example-caption" }, "Example: ocean to computer"),
    h("ol", { class: "example ladder" }, ex("computer", 0), ex("network", 1), ex("signal", 2), ex("wave", 3),
      ex("ocean", 4, { isStart: true })),
    h("p", { class: "sub" }, "ocean → wave → signal → network → computer: 4 moves, gold when par is 4."),
    h("p", { class: "sub example-caption" }, "Three new ladders every day: Easy, Medium and Hard."))
  );
}

// How to play, Unlimited (chain ladders): one hidden answer per rung.
// Its own flag, so a player's first daily ladder still gets the daily rules.
function showChainHelp() {
  store.set("seenChainHelp", true);
  const ex = (text, cls, tag = null) => h("li", { class: cls },
    h("span", { class: cls.startsWith("rung") ? "pattern" : null }, text, tag ? h("span", { class: "tag" }, tag) : null));
  openDialog("How to play", h("div", {},
    h("ol", { class: "rules" },
      h("li", {}, "Get from the ", h("b", {}, "start"), " word to the ", h("b", {}, "goal"), ". The words in between are hidden."),
      h("li", {}, "Each hidden word has ", h("b", {}, "one answer"), ", close in meaning to the word below it. Its plural counts too."),
      h("li", {}, "Each hidden word shows its length and one letter. A ", h("b", {}, "hint"), " shows one more letter; filling the last blank plays the word."),
      h("li", {}, "Every word you find, wrong guess and hint is a ", h("b", {}, "move"), ". Finish in ", h("b", {}, "par"), " for gold.")),
    h("p", { class: "sub example-caption" }, "Example: jeep to port"),
    h("ol", { class: "example ladder chain" },
      ex("port", "bar passed", "goal"), ex("_ a _ _ _ _", "rung chain-rung"), ex("t _ _ _ _", "rung chain-rung next"),
      ex("jeep", "bar passed", "start")),
    h("p", { class: "sub example-caption" }, "After jeep: “tank”? Not it, one move. “truck”: yes. Then the word after truck.")));
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
  const a = s.avgPointsByLevel, av = (v) => (v == null ? "—" : v);
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
    h("p", { class: "sub" }, "Random ladders with one hidden answer per rung, as many as you like. No streaks at stake."),
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
function newState(kind, puzzle) {
  // moves: the score. +1 for every word played and every hint; Undo never
  // takes one back. hintsAt: the hint shown at each word (1 = a clue, 2 = the
  // word itself, 0 = the free dead-end note), so Undo back to a word shows
  // its hint again for free. clues: marks saves that use those tier meanings.
  const state = { kind, puzzle, path: [puzzle.start], moves: 0, hints: 0, hintsAt: {}, clues: true, status: "playing" };
  // The day a daily ladder was opened, so finishing it after midnight still
  // counts for the streak of the day it belongs to.
  if (kind === "daily") state.startedOn = today();
  return state;
}

// Unlimited chain ladders: state.rungs[k] holds hidden word k's wrong
// guesses and hints (see chainStart in logic.js).
const newChainState = (kind, puzzle) => ({ kind, mode: "chain", ...chainStart(puzzle) });

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
      if (!state) {
        const puzzle = await loadDailyPuzzle(ladder, date, level);
        state = newState("daily", puzzle);
      }
    } else {
      saveKey = practiceKey(level);
      state = store.get(saveKey);
      if (!state || state.puzzle?.level !== level || state.puzzle.mode !== "chain"
          || !ladder.index.has(state.puzzle.start) || !ladder.index.has(state.puzzle.goal)
          || !state.puzzle.route.every((w) => ladder.index.has(w))) {
        state = newChainState("practice", await makePracticePuzzle(ladder, level));
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
  // Archive days from an older era say so, since their step limit differs.
  const classic = date ? classicLabel(config, date) : "";
  const view = state.puzzle.mode === "chain" ? chainView : playView;
  view(ladderFor(ladder, state.puzzle), state, saveKey, date, classic); // that puzzle's rules
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

function playView(ladder, state, saveKey, date, classic = "") {
  const { puzzle } = state;
  upgradeHintState(state); // saves from before per-word hint memory
  upgradeMoves(state);     // saves from before the single moves counter
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
  let countedNote = null;    // "Counted as tree." when a form of the goal finished it
  let rejected = null;       // a real word that just went into the Tried list
  let justTried = false;     // animate that word's bar once
  let justAdded = false;     // a word was just played: the climber moves
  let justUndone = false;    // Undo: the climber moves back
  const countdown = makeCountdown();
  const save = () => store.set(saveKey, state);
  if (state.status === "playing") save();

  // ---- static parts

  const status = h("p", { class: "status" });
  // Easy | Medium | Hard switcher; solved daily levels carry their medal.
  // Rebuilt on every update(), so a medal appears the moment you win.
  const switcher = h("nav", { class: "levels compact", "aria-label": "Level" });
  const renderSwitcher = () => renderLevelSwitcher(switcher, { daily: state.kind === "daily", date, level, href: levelHref });
  // The theme is shown on the result card, not during play: it's extra
  // reading, and a teaser can point at a sense the route doesn't use.
  const isPractice = state.kind === "practice" || puzzle.source === "practice";

  const input = h("input", { id: "guess", type: "text", autocomplete: "off", autocapitalize: "none",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "go", maxlength: "30", "aria-describedby": "guess-count" });
  // Stays visible while typing, unlike the placeholder.
  const count = h("span", { class: "count", id: "guess-count" });
  const form = h("form", { class: "guess", onSubmit: (e) => { e.preventDefault(); submit(); } },
    h("label", { for: "guess", class: "visually-hidden" }, "Next word"), h("span", { class: "field" }, input, count),
    h("button", { type: "submit", class: "btn go" }, "Go"));
  const feedback = h("div", { class: "feedback", "aria-live": "polite" });
  const tried = h("section", { class: "tried", hidden: true, "aria-label": "Words you tried" });
  const win = h("section", { class: "card win", hidden: true, "aria-live": "polite" });
  // A real ladder: par + 1 rungs, start at the bottom, goal at the top, and
  // your word on the rung that matches how close it is (see ladderRows). The
  // input stays in one place under it: moving a focused input would close
  // the phone keyboard after every word.
  const ladderEl = h("ol", { class: "ladder", "aria-label": `Ladder from ${puzzle.start} up to ${puzzle.goal}` });
  const extraEl = h("ol", { class: "ladder-extra", "aria-label": "Off the ladder" });
  const trail = h("div", { class: "trail" });
  // Undo is for fixing a mistake; the move it took still counts.
  const undoBtn = h("button", { class: "btn btn-quiet", onClick: undo,
    title: "Take back your last word (the move still counts)" }, "Undo");
  const hintBtn = h("button", { class: "btn btn-quiet", onClick: hint,
    title: "A clue first, then the word. Each costs one move." }, "Hint");
  const actions = h("div", { class: "actions" }, undoBtn, hintBtn);

  // ---- menu (its actions are function declarations below, so hoisted)
  const menuWrap = gameMenu([
    ["Hint", hint, () => state.status === "playing"],
    ["Give up", confirmGiveUp, () => state.status === "playing"],
    ...(state.kind === "practice" ? [["New unlimited ladder", newPractice, () => true]] : []),
    ["How to play", () => showHelp(), () => true],
    ["Statistics", showStats, () => true],
    ["Send feedback", () => showFeedback(feedbackContext(state)), () => true],
    ["Previous games", () => { location.hash = "#/archive"; }, () => true],
  ]);

  render(topbar(state.kind === "daily" ? `Game ${puzzle.gameNumber}` : "Unlimited", menuWrap),
    switcher, status, win, ladderEl, extraEl, feedback, tried, form, actions, trail);


  // ---- actions
  // Accepted top-N at `current`: shrinks with every rung climbed.
  const acceptCapAt = (current) => acceptCap(levelAcceptRules(ladder.config, level),
    Math.max(0, stepsTo(puzzle.start) - stepsTo(current)));

  function submit() {
    if (state.status !== "playing") return;
    const current = state.path[state.path.length - 1];
    const cap = acceptCapAt(current);
    const res = playWord(ladder, dist, state.path, input.value, puzzle.goal, cap);
    if (res.noCloser) {
      // Close, but not one of this rung's accepted words: not played, no
      // move. It goes into the Tried list marked "not top N".
      error = null;
      rejected = { word: res.word, at: current, noCloser: true };
      justTried = true;
      addTried(res.word, current, false, true);
      update();
      input.select();
      return;
    }
    if (!res.ok) {
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
    state.moves++;        // every word played is a move, even if undone later
    state.tried = null;   // a new word means a new Tried list
    error = null;
    rejected = null;
    justAdded = true;
    countedNote = res.note ?? null;
    input.value = "";
    if (res.word === puzzle.goal) finish("won");
    else autoFinish(res.note);
    save();
    update();
  }

  // One rung below the goal, the goal is a legal step: climb it for the
  // player. It still costs the move typing it would, so medals don't change.
  function autoFinish(note = null) {
    const current = state.path[state.path.length - 1];
    if (state.status !== "playing" || !autoGoal(ladder, current, puzzle.goal)) return false;
    state.path.push(puzzle.goal);
    state.moves++;
    countedNote = `${note ? `${note} ` : ""}${current} leads straight to ${puzzle.goal}.`;
    finish("won");
    return true;
  }

  function undo() {
    if (state.status !== "playing" || state.path.length < 2) return;
    state.path.pop(); // the move stays counted; hintsAt is kept, so a hint here is free again
    justUndone = true;
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
      const tier = (hintTier(state, current) ?? 0) + 1; // 1 = a clue, 2 = the word
      if (tier > 2) return; // already revealed here: free to see again
      state.hints++;
      state.moves++; // each hint costs one move
      state.hintsAt[current] = tier;
    }
    error = null;
    rejected = null;
    save();
    update();
    input.focus();
  }

  // The hint for a word points at one word that gets one step closer (see
  // hintStep): first a clue that never names it, then the word itself.
  // Deterministic, so revisiting the word shows the same hint.
  function hintedNext(current) {
    const cur = ladder.index.get(current);
    return bestRoute(cur)?.[1] ?? hintStep(ladder.neighbors, dist, costs(), cur);
  }

  function hintLine(current, tier) {
    if (stepsTo(current) < 0 || !tier) return `There's no way to ${puzzle.goal} from ${current}. Undo to go back.`;
    // Hints follow the route the game shows (bestRoute), so they agree with
    // the give-up route and the result card.
    const next = hintedNext(current);
    if (tier >= 2) return `Try “${ladder.words[next]}”.`;
    return clueText(clueFor(ladder, state.path, next, puzzle.goal));
  }

  function confirmGiveUp() {
    openDialog("Give up?", h("p", {}, `We'll show you a route to the goal. This ends this ${levelLabel.toLowerCase()} ladder.`),
      [["Keep playing", () => input.focus()], ["Give up", () => { finish("gaveUp"); save(); update(); }, true]]);
  }

  function finish(result) {
    state.status = result;
    if (state.kind === "daily") saveResult(date, state);
  }

  // Throwing away a ladder with real progress asks first; a fresh or
  // finished one is replaced straight away.
  function newPractice() {
    const fresh = () => { store.remove(saveKey); route(); };
    if (state.status !== "playing" || state.path.length < 2) return fresh();
    openDialog("Start a new ladder?", h("p", {}, "This one will be lost."),
      [["Keep playing", () => input.focus()], ["New ladder", fresh, true]]);
  }

  // ---- Contexto-style Tried list
  // Each wrong guess at the current word, ranked by closeness to that word.
  let scoreCache = { at: -1, scores: null }; // scores for one "from" word at a time

  function addTried(word, current, oneWay, noCloser = false) {
    if (state.tried?.at !== current) state.tried = { at: current, items: [] };
    state.tried.items = state.tried.items.filter((x) => x.word !== word); // a repeat moves to newest
    state.tried.items.push({ word, rank: null, family: false, oneWay, noCloser });
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

  // A chip per word that was too far, closest first. The shaded part shows
  // how close it was; the exact rank is for screen readers only, not on screen.
  function noteFor(word) {
    const at = state.tried.at, cap = acceptCapAt(at);
    const why = rejectReason(ladder.neighbors, ladder.wide, dist, ladder.index.get(at), cap, ladder.index.get(word));
    return why === "wrongWay" ? "wrong way" : why === "tooFar" ? "too far ahead" : `not top ${cap}`;
  }

  function triedChip(x, latest) {
    const known = typeof x.rank === "number";
    const tip = x.noCloser ? `Close to ${state.tried.at}, but not one of its best steps toward ${puzzle.goal}`
      : x.family ? "Same word family" : known ? `#${x.rank.toLocaleString()} closest to ${state.tried.at}` : "";
    const enter = latest && justTried;
    return h("li", { class: `tchip${latest ? " latest" : ""}${enter ? " enter" : ""}`,
      style: `--fill:${known ? rankFill(x.rank) : 0}%` }, x.word,
      x.noCloser ? h("span", { class: "tchip-note" }, noteFor(x.word)) : null,
      tip ? h("span", { class: "visually-hidden" }, `, ${tip}`) : null);
  }

  function renderTried(current, playing) {
    const t = state.tried;
    tried.hidden = !playing || !t || t.at !== current || !t.items.length;
    if (tried.hidden) return;
    const latest = t.items[t.items.length - 1];
    tried.replaceChildren(
      h("span", { class: "tried-head" }, "Not accepted:"),
      h("ol", { class: "tchips" }, triedOrder(t.items).map((x) => triedChip(x, x === latest))));
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

  // What the last step did, in rungs. A good step is only announced to
  // screen readers (the ladder already shows it); anything else is said.
  function progressLine(current, steps) {
    const a = stepsTo(state.path[steps - 1]), b = stepsTo(current);
    if (b < 0) return { text: `There's no way to ${puzzle.goal} from ${current}. Undo to go back.` };
    if (b === a) return { text: `Same distance: no climb, still ${b} to go.` };
    if (b > a) {
      if (b > puzzle.par) return { text: "Below the start now. Undo to go back." };
      const n = b - a;
      return { text: `Down ${n} rung${n === 1 ? "" : "s"}. Undo to go back.` };
    }
    return { text: `Up one rung. ${b} to go.`, hidden: true };
  }

  // ---- the ladder
  const srOnly = (text) => h("span", { class: "visually-hidden" }, text);

  // One rung. Filled rungs reuse bar(); empty ones are dashed slots.
  function rungEl(row, { climberRung, ghost, playing }) {
    const prefix = srOnly(`Rung ${row.rung} of ${puzzle.par}: `);
    const isGoal = row.d === 0;
    if (row.at != null || isGoal) {
      const word = row.at != null ? state.path[row.at] : puzzle.goal;
      const el = bar(word, {
        latest: row.current,
        isStart: row.at === 0,
        prev: row.at > 0 ? state.path[row.at - 1] : null,
      });
      // Climbed rungs form a staircase: color and fill grow with height.
      const step = stairStep(row.rung, puzzle.par);
      el.classList.add("stair");
      el.style.setProperty("--stair-hue", step.hue);
      el.style.setProperty("--fill", `${step.fill}%`);
      if (isGoal && row.at == null) el.classList.add("goal-slot");
      if (row.at != null && !row.current && !isGoal) el.classList.add("passed");
      if (row.current) el.setAttribute("aria-current", "step");
      el.prepend(prefix);
      return el;
    }
    const g = ghost.get(row.rung);
    if (g) {
      return h("li", { class: "rung ghost" }, prefix,
        h("span", {}, g, h("span", { class: "tag" }, "route")), h("span", { class: "num" }, `${row.d} to go`));
    }
    const next = playing && typeof climberRung === "number" && row.rung === climberRung + 1;
    return h("li", { class: `rung empty${next ? " next" : ""}` }, prefix,
      h("span", {}, next ? "next word" : ""), h("span", { class: "num" }, `${row.d} to go`));
  }

  // FLIP: the climber glides from where it was to its new rung. JS-started
  // animations ignore the CSS reduced-motion rule, so check it here.
  function animateClimber(prevTop) {
    const moved = justAdded || justUndone;
    justAdded = justUndone = false;
    if (!moved || prevTop == null) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const el = app.querySelector('[aria-current="step"]');
    if (!el?.animate) return;
    const dy = prevTop - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: 280, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }

  // The route the game shows (hints, give-up): a shortest route
  // whose steps are most often real ConceptNet relations, else the one with
  // the strongest weakest link.
  // The puzzle file's own route comes first: the AI checked that every step
  // makes sense and wrote why (puzzle.reasons). Re-checked here, so a stale
  // or edited file can never show an illegal route.
  const fileRoute = checkedRoute(puzzle.route, puzzle, ladder, dist);
  const reasons = fileRoute && Array.isArray(puzzle.reasons) && puzzle.reasons.length === puzzle.par
    ? puzzle.reasons.map(String) : null;

  function bestRoute(from) {
    const k = fileRoute ? fileRoute.indexOf(from) : -1;
    if (k >= 0) return fileRoute.slice(k);
    return guideRoute(ladder.neighbors, dist, ladder.related, from)
      ?? bottleneckRoute(ladder.neighbors, dist, from)?.route ?? null;
  }

  function renderLadder(playing) {
    const prevTop = app.querySelector('[aria-current="step"]')?.getBoundingClientRect().top ?? null;
    const dists = state.path.map(stepsTo);
    const lad = ladderRows(dists, puzzle.par);
    // After giving up, a route from your word fills the rungs above you.
    const ghost = new Map();
    const cur = state.path[state.path.length - 1];
    if (state.status === "gaveUp" && typeof lad.climber === "number") {
      const route = bestRoute(ladder.index.get(cur)); // the same route the result card names
      route?.slice(1, -1).forEach((idx, k) => ghost.set(lad.climber + k + 1, ladder.words[idx]));
    }
    ladderEl.classList.toggle("off-route", lad.off != null);
    ladderEl.replaceChildren(...lad.rows.map((row) => rungEl(row, { climberRung: lad.climber, ghost, playing })));
    const extra = lad.below ?? lad.off;
    extraEl.hidden = extra == null;
    extraEl.replaceChildren(...(extra == null ? [] : [(() => {
      const el = bar(state.path[extra], { latest: true, prev: extra > 0 ? state.path[extra - 1] : null });
      el.setAttribute("aria-current", "step");
      el.classList.add(lad.off != null ? "off" : "below");
      if (lad.below != null) el.querySelector(".tag")?.replaceChildren("below start");
      return el;
    })()]));
    animateClimber(prevTop);
  }

  // Every word in the order played: ↑ closer, = same rung, ↓ down.
  function renderTrail() {
    const steps = state.path.length - 1;
    trail.hidden = steps === 0;
    if (trail.hidden) return;
    const parts = [], spoken = [];
    state.path.forEach((w, i) => {
      if (i > 0) {
        const a = stepsTo(state.path[i - 1]), b = stepsTo(w);
        const [mark, word] = b >= 0 && a >= 0 && b < a ? ["↑", "up"] : b === a ? ["=", "same rung"] : ["↓", "down"];
        parts.push(h("span", { class: "trail-mark", "aria-hidden": "true" }, ` ${mark} `));
        spoken.push(`${word}, ${w}`);
      } else spoken.push(w);
      parts.push(h("span", { "aria-hidden": "true" }, w));
    });
    const line = h("p", { "aria-label": `Your words in order: ${spoken.join(", ")}` }, ...parts);
    trail.replaceChildren(state.path.length > 10
      ? h("details", {}, h("summary", {}, `All ${state.path.length} words`), line)
      : line);
  }

  function update() {
    const steps = state.path.length - 1;
    const current = state.path[state.path.length - 1];
    const playing = state.status === "playing";
    status.textContent = `Par ${puzzle.par} · Moves ${state.moves}`;

    // The letter count is the hinted word's: other accepted words may differ.
    const next = playing && stepsTo(current) > 0 ? hintedNext(current) : undefined;
    input.placeholder = `Next step from ${current}`;
    const countText = next !== undefined ? `${ladder.words[next].length} letters` : "";
    count.hidden = !countText;
    // A fresh span replays the entrance only when the number actually changes.
    if (count.textContent !== countText) count.replaceChildren(h("span", { class: "enter" }, countText));
    form.hidden = !playing;
    feedback.hidden = !playing;
    actions.hidden = !playing;
    undoBtn.disabled = steps === 0;
    // After the clue, the same button reveals the word (one more move).
    hintBtn.disabled = hintTier(state, current) >= 2;
    hintBtn.textContent = hintTier(state, current) === 1 ? "Reveal word" : "Hint";

    // Feedback slot: exactly one thing.
    if (!playing) feedback.replaceChildren();
    else if (error) feedback.replaceChildren(h("p", { class: "error" }, error));
    else if (rejected?.at === current && rejected.noCloser) feedback.replaceChildren(h("p", { class: "muted" },
      `${rejected.word} is close to ${current}, but it doesn't get you closer to ${puzzle.goal}. Try another word.`));
    else if (rejected?.at === current) feedback.replaceChildren(h("p", { class: "visually-hidden" },
      `${rejected.word} is not a valid step from ${current}. It was added to your Tried list.`));
    else if (hintTier(state, current) != null) feedback.replaceChildren(h("p", { class: "hintline" }, icon("lightbulb", "inline-icon"), hintLine(current, hintTier(state, current))));
    else if (steps > 0) {
      const line = progressLine(current, steps);
      feedback.replaceChildren(h("p", { class: line.hidden ? "visually-hidden" : "muted" }, line.text));
    } else feedback.replaceChildren(h("p", { class: "muted" }, `Type a word close in meaning to ${puzzle.start}.`));

    renderLadder(playing);
    renderTrail();

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
    const moves = state.moves;
    const medal = won ? medalFor(moves, puzzle.par) : null;
    const n = (k, word = "move") => `${k} ${word}${k === 1 ? "" : "s"}`;
    const toast = h("p", { class: "toast", role: "status" });
    const shareBtn = h("button", { class: "btn", onClick: () => share(toast) }, icon("share-network", "btn-icon"), "Share result");


    win.replaceChildren(...[ // .filter(Boolean): replaceChildren(null) would print "null"
      medalBadge(won ? medal.id : "gaveUp", "lg"),
      h("h2", {}, won ? (medal.id === "finished" ? "You made it!" : `${medal.label}!`) : "Here's one way up"),
      h("p", { class: "result" }, won ? `${n(moves)}, par ${puzzle.par} · ${pointsFor(moves, puzzle.par)} pts` : `Par was ${puzzle.par}.`),
      // The game ends on that step, so the feedback line is hidden: say it here.
      won && countedNote ? h("p", { class: "muted" }, countedNote) : null,
      routeLine(won && steps === puzzle.par),
      !isPractice && puzzle.theme ? h("p", { class: "muted" }, `Today's theme: ${puzzle.theme}`) : null,
      h("div", { class: "btn-row" },
        shareBtn,
        state.kind === "practice"
          ? h("button", { class: "btn btn-quiet", onClick: newPractice }, icon("arrow-clockwise", "btn-icon"), "Play another")
          : nextLevel(date, getResults(), level)
            ? h("a", { class: "btn btn-quiet", href: levelHref(nextLevel(date, getResults(), level)) },
                `Play ${LEVEL_LABEL[nextLevel(date, getResults(), level)]}`)
            : h("a", { class: "btn btn-quiet", href: "#/" }, "Home")),
      toast,
      state.kind === "daily" ? countdown() : null,
    ].filter(Boolean));
  }

  // ONE route on the result card: a shortest one, picked so its weakest link
  // is as strong as possible (see bottleneckRoute). Skipped when your own
  // ladder already was a shortest one.
  function routeLine(yoursWasShortest) {
    // Every daily ladder makes sense: show each step of its route and why.
    if (reasons) {
      const w = fileRoute.map((i) => ladder.words[i]);
      return h("div", { class: "route" },
        h("p", {}, yoursWasShortest ? "Your ladder was as short as it gets. Today's route:" : "Today's route, step by step:"),
        h("ol", { class: "reasons" }, reasons.map((text, k) =>
          h("li", {}, h("b", {}, `${w[k]} → ${w[k + 1]}`), " ", text))));
    }
    if (yoursWasShortest) return h("p", { class: "route" }, "Your ladder was as short as it gets.");
    const best = bestRoute(ladder.index.get(puzzle.start));
    const words = best ? best.map((i) => ladder.words[i])
      : naturalRoute(ladder.neighbors, costs(), ladder.index.get(puzzle.start))?.map((i) => ladder.words[i]);
    if (!words) return null;
    return h("p", { class: "route" }, "A shortest route: ", h("b", {}, words.join(" → ")));
  }

  async function share(toast) {
    const text = shareText({
      label, moves: state.moves, par: puzzle.par, gaveUp: state.status === "gaveUp",
      distances: state.path.map(stepsTo), // includes the start, so step 1's change is known
      url: location.origin + location.pathname,
    });
    await copyShare(text, toast);
  }

  // A save from before auto-finish can sit one rung below the goal: finish it
  // now. Not on a fresh ladder, where the start itself is the word to leave.
  if (state.path.length > 1 && autoFinish()) save();
  update();
  resolveRanks(); // ranks still pending from before a refresh
  if (state.status === "playing") input.focus();
  // First visit straight to a game (a shared link): explain the rules once,
  // same as the home screen does (or announce new rules to a returning player).
  showIntro();
}

// ------------------------------------------------------------ chain ladders
// Strict Unlimited: puzzle.route is one fixed chain; each hidden word shows
// its length and puzzle.shown[k]'s letter, and only that word counts (see
// chainSubmit). Wrong guesses go to the Tried list, ranked by chainRank.
function chainView(ladder, state, saveKey, date) {
  const { puzzle } = state;
  const chain = puzzle.route;
  const hidden = chain.length - 2;
  const level = puzzle.level ?? "medium";
  const levelLabel = LEVEL_LABEL[level];
  const label = `unlimited (${level})`;
  document.title = `Unlimited ${levelLabel} · Meaning Ladder`;
  const levelHref = (lv) => `#/practice/${lv}`;

  let error = null;      // a free rejection (typo, unknown word, repeat)
  let note = null;       // "Counted as truck."
  let justMissed = false;
  let justSolved = -1;   // hidden word to animate once
  const save = () => store.set(saveKey, state);
  if (state.status === "playing") save();
  const rungNow = () => state.path.length - 1; // the hidden word being guessed

  const status = h("p", { class: "status" });
  const switcher = h("nav", { class: "levels compact", "aria-label": "Level" });
  const input = h("input", { id: "guess", type: "text", autocomplete: "off", autocapitalize: "none",
    autocorrect: "off", spellcheck: "false", enterkeyhint: "go", maxlength: "30" });
  const form = h("form", { class: "guess", onSubmit: (e) => { e.preventDefault(); submit(); } },
    h("label", { for: "guess", class: "visually-hidden" }, "Your guess for the next hidden word"), h("span", { class: "field" }, input),
    h("button", { type: "submit", class: "btn go" }, "Go"));
  const feedback = h("div", { class: "feedback", "aria-live": "polite" });
  const tried = h("section", { class: "tried", hidden: true, "aria-label": "Wrong guesses for this word" });
  const win = h("section", { class: "card win", hidden: true, "aria-live": "polite" });
  const ladderEl = h("ol", { class: "ladder chain", "aria-label": `Ladder from ${puzzle.start} up to ${puzzle.goal}` });
  const hintBtn = h("button", { class: "btn btn-quiet", onClick: hint, title: "Shows one more letter. Costs one move." }, "Hint");
  const actions = h("div", { class: "actions" }, hintBtn);

  const menuWrap = gameMenu([
    ["Hint", hint, () => state.status === "playing"],
    ["Give up", confirmGiveUp, () => state.status === "playing"],
    ["New unlimited ladder", newPractice, () => true],
    ["How to play", showChainHelp, () => true],
    ["Statistics", showStats, () => true],
    ["Send feedback", () => showFeedback(feedbackContext(state)), () => true],
    ["Previous games", () => { location.hash = "#/archive"; }, () => true],
  ]);

  render(topbar("Unlimited", menuWrap), switcher, status, win, ladderEl, feedback, tried, form, actions);

  // ---- actions
  function submit() {
    if (state.status !== "playing") return;
    const k = rungNow();
    const res = chainSubmit(ladder, state, input.value);
    error = note = null;
    if (res.ok) {
      note = res.note ?? null;
      justSolved = k;
      input.value = "";
    } else if (res.wrong) {
      state.rungs[k].misses.at(-1).rank = chainRank(ladder, ladder.index.get(chain[k + 1]), ladder.index.get(res.word)) ?? "?";
      justMissed = true;
      input.select();
    } else {
      error = res.error; // free: no move
      input.select();
    }
    save();
    update();
  }

  function hint() {
    if (state.status !== "playing") return;
    const k = rungNow();
    chainHint(state);
    if (rungNow() > k) justSolved = k;
    error = note = null;
    save();
    update();
    input.focus();
  }

  function confirmGiveUp() {
    openDialog("Give up?", h("p", {}, `We'll show you the hidden words. This ends this ${levelLabel.toLowerCase()} ladder.`),
      [["Keep playing", () => input.focus()], ["Give up", () => { state.status = "gaveUp"; save(); update(); }, true]]);
  }

  function newPractice() {
    const fresh = () => { store.remove(saveKey); route(); };
    if (state.status !== "playing" || state.moves === 0) return fresh();
    openDialog("Start a new ladder?", h("p", {}, "This one will be lost."),
      [["Keep playing", () => input.focus()], ["New ladder", fresh, true]]);
  }

  // ---- rendering
  const srOnly = (text) => h("span", { class: "visually-hidden" }, text);
  // Climbed rungs form the same staircase as a daily ladder (stairStep).
  const stair = (el, rung) => {
    const step = stairStep(rung, puzzle.par);
    el.classList.add("stair");
    el.style.setProperty("--stair-hue", step.hue);
    el.style.setProperty("--fill", `${step.fill}%`);
    return el;
  };

  // Rows top (goal) to bottom (start). Hidden word k sits on rung k + 1.
  function rows() {
    const playing = state.status === "playing";
    const cur = rungNow();
    const out = [stair(h("li", { class: `bar${state.status === "won" ? " latest" : " goal-slot"}` },
      srOnly(`Rung ${puzzle.par}, the goal: `), h("span", {}, puzzle.goal, h("span", { class: "tag" }, "goal"))), puzzle.par)];
    for (let k = hidden - 1; k >= 0; k--) {
      const word = chain[k + 1];
      const solved = k < cur;
      if (solved || !playing) {
        out.push(stair(h("li", { class: `bar${solved ? " passed" : " ghost-word"}${justSolved === k ? " enter" : ""}` },
          srOnly(`Rung ${k + 1}${solved ? "" : ", not found"}: `),
          h("span", {}, word, solved ? null : h("span", { class: "tag" }, "answer"))), k + 1));
        continue;
      }
      const shown = new Set(chainLetters(state, k));
      const letters = [...word].map((c, i) => (shown.has(i) ? c : "_"));
      const next = k === cur;
      out.push(h("li", { class: `rung chain-rung${next ? " next" : ""}`, "aria-current": next ? "step" : null },
        srOnly(`Rung ${k + 1}${next ? ", your next word" : ", hidden"}: ${word.length} letters, `
          + letters.map((c) => (c === "_" ? "blank" : c)).join(" ")),
        h("span", { class: "pattern", "aria-hidden": "true" }, letters.join(" "))));
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
          srOnly(known ? `, #${m.rank} closest to the answer` : ", not among the answer's 40 closest words"));
      })));
    justMissed = false;
  }

  function update() {
    const playing = state.status === "playing";
    const k = rungNow();
    status.textContent = `Par ${puzzle.par} · Moves ${state.moves}`;
    form.hidden = feedback.hidden = actions.hidden = !playing;
    renderLevelSwitcher(switcher, { daily: false, date, level, href: levelHref });
    ladderEl.replaceChildren(...rows());
    renderTried(k, playing);
    if (playing) {
      input.placeholder = `Word after ${chain[k]}`;
      if (error) feedback.replaceChildren(h("p", { class: "error" }, error));
      else if (note) feedback.replaceChildren(h("p", { class: "muted" }, note));
      else feedback.replaceChildren(h("p", { class: "muted" }, `Which word comes after ${chain[k]}?`));
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
    win.replaceChildren(...[ // .filter(Boolean): replaceChildren(null) would print "null"
      medalBadge(won ? medal.id : "gaveUp", "lg"),
      h("h2", {}, won ? (medal.id === "finished" ? "You made it!" : `${medal.label}!`) : "Here's the ladder"),
      h("p", { class: "result" }, won
        ? `${moves} move${moves === 1 ? "" : "s"}, par ${puzzle.par} · ${pointsFor(moves, puzzle.par)} pts`
        : `Par was ${puzzle.par}.`),
      won && note ? h("p", { class: "muted" }, note) : null,
      h("p", { class: "route" }, "The ladder: ", h("b", {}, chain.join(" → "))),
      h("div", { class: "btn-row" },
        h("button", { class: "btn", onClick: () => share(toast) }, icon("share-network", "btn-icon"), "Share result"),
        h("button", { class: "btn btn-quiet", onClick: newPractice }, icon("arrow-clockwise", "btn-icon"), "Play another")),
      toast,
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
  if (!store.get("seenChainHelp")) showChainHelp(); // first Unlimited visit: these rules, not the daily ones
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
