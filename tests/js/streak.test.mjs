// Streak timing rules (countsForStreak / computeStats in js/logic.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, countsForStreak } from "../../js/logic.js";

// The record saveResult writes: playedOn is the local date it was finished,
// startedOn the local date the game was first opened.
const won = (startedOn, playedOn) => ({ status: "won", steps: 3, par: 3, hints: 0, startedOn, playedOn });

test("started 23:59, finished 00:01: counts for the day it was started", () => {
  const r = won("2026-11-20", "2026-11-21");
  assert.equal(countsForStreak("2026-11-20", r), true);
  const results = { "2026-11-19:easy": won("2026-11-19", "2026-11-19"), "2026-11-20:hard": r };
  // Just after midnight: today (the 21st) has no win yet, the streak holds.
  assert.equal(computeStats(results, "2026-11-21").currentStreak, 2);
  // Solving the 21st's ladder later that day extends it.
  results["2026-11-21:easy"] = won("2026-11-21", "2026-11-21");
  assert.equal(computeStats(results, "2026-11-21").currentStreak, 3);
});

test("a streak survives midnight until a whole day passes unsolved", () => {
  const results = { "2026-11-20:easy": won("2026-11-20", "2026-11-20") };
  assert.equal(computeStats(results, "2026-11-20").currentStreak, 1);
  assert.equal(computeStats(results, "2026-11-21").currentStreak, 1);
  assert.equal(computeStats(results, "2026-11-22").currentStreak, 0);
});

test("started on its day but finished two days later: doesn't patch the gap", () => {
  assert.equal(countsForStreak("2026-11-20", won("2026-11-20", "2026-11-22")), false);
});

test("archive plays (started after their day) never count", () => {
  assert.equal(countsForStreak("2026-11-20", won("2026-11-21", "2026-11-21")), false);
  const results = {
    "2026-11-19:easy": won("2026-11-19", "2026-11-19"),
    "2026-11-20:easy": won("2026-11-22", "2026-11-22"), // filled in late from the archive
    "2026-11-21:easy": won("2026-11-21", "2026-11-21"),
  };
  assert.equal(computeStats(results, "2026-11-21").currentStreak, 1);
  assert.equal(computeStats(results, "2026-11-21").maxStreak, 1);
});

test("old results without startedOn keep the finished-on-the-day rule", () => {
  const old = { status: "won", steps: 3, par: 3, hints: 0, playedOn: "2026-11-20" };
  assert.equal(countsForStreak("2026-11-20", old), true);
  assert.equal(countsForStreak("2026-11-20", { ...old, playedOn: "2026-11-21" }), false);
  assert.equal(countsForStreak("2026-11-20", { ...old, startedOn: null, playedOn: "2026-11-21" }), false);
});

test("give-ups never count", () => {
  assert.equal(countsForStreak("2026-11-20", { status: "gaveUp", startedOn: "2026-11-20", playedOn: "2026-11-20" }), false);
});
