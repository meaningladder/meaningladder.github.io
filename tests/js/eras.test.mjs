// Tests for the rules-era helpers in js/logic.js ("New rules" notice and
// "classic rules" labels). Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classicLabel, isClassicDay, newestEra, playedDates, rulesNoticeDue, rulesNoticeText,
} from "../../js/logic.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = JSON.parse(readFileSync(root + "puzzle_config.json", "utf8"));
const era = (from, stepLimit, pars) => ({
  from, stepLimit,
  levels: Object.fromEntries(["easy", "medium", "hard"].map((lv, i) => [lv, { par: pars[i] }])),
});
const two = { rules: [era("2026-11-01", 100, [3, 3, 4]), era("2026-11-13", 20, [4, 5, 6])] };
const fixedDay = (s) => ({ "2026-11-13": "November 13" })[s] ?? s;

test("newestEra needs an older era to change from", () => {
  assert.equal(newestEra(two).from, "2026-11-13");
  assert.equal(newestEra({ rules: [era("2026-11-01", 100, [3, 3, 4])] }), null);
  assert.equal(newestEra({}), null);
});

test("days before the newest era are classic, with their own step limit", () => {
  assert.equal(isClassicDay(two, "2026-11-12"), true);
  assert.equal(isClassicDay(two, "2026-11-13"), false);
  assert.equal(classicLabel(two, "2026-11-11"), "classic rules (top 100)");
  assert.equal(classicLabel(two, "2026-11-13"), "");
  assert.equal(classicLabel({ rules: [two.rules[0]] }, "2026-11-11"), "");
  const three = { rules: [era("2026-01-01", 200, [3, 3, 4]), ...two.rules] };
  assert.equal(classicLabel(three, "2026-01-05"), "classic rules (top 200)");
});

test("playedDates reads results (playedOn first) and in-progress save keys", () => {
  const results = { "2026-11-05:easy": { playedOn: "2026-11-14" }, "2026-11-02:hard": {} };
  assert.deepEqual(playedDates(results, ["game:2026-11-09:medium"]).sort(),
    ["2026-11-02", "2026-11-09", "2026-11-14"]);
  assert.deepEqual(playedDates(null), []);
});

test("notice is due once, only for players from an earlier era", () => {
  const veteran = ["2026-11-10"];
  assert.equal(rulesNoticeDue(two, "2026-11-12", veteran, false), false); // not yet
  assert.equal(rulesNoticeDue(two, "2026-11-13", veteran, false), true);
  assert.equal(rulesNoticeDue(two, "2026-11-20", veteran, false), true);  // first visit after
  assert.equal(rulesNoticeDue(two, "2026-11-13", veteran, true), false);  // dismissed
  assert.equal(rulesNoticeDue(two, "2026-11-13", [], false), false);      // brand new
  assert.equal(rulesNoticeDue(two, "2026-11-14", ["2026-11-13"], false), false); // started under new rules
  assert.equal(rulesNoticeDue({ rules: [two.rules[0]] }, "2026-11-13", veteran, false), false);
});

test("notice text is built from the eras", () => {
  assert.equal(rulesNoticeText(two, fixedDay),
    "From November 13, each step must be one of the previous word's 20 closest words (it was 100)."
    + " Ladders are longer: par 4 for Easy, 5 for Medium and 6 for Hard.");
  const samePar = { rules: [era("2026-11-01", 100, [4, 5, 6]), era("2026-11-13", 50, [4, 5, 6])] };
  assert.equal(rulesNoticeText(samePar, fixedDay),
    "From November 13, each step must be one of the previous word's 50 closest words (it was 100).");
  const shorter = { rules: [era("2026-11-01", 20, [4, 5, 6]), era("2026-11-13", 20, [3, 4, 5])] };
  assert.equal(rulesNoticeText(shorter, fixedDay),
    "From November 13, each step must be one of the previous word's 20 closest words. Now par 3 for Easy, 4 for Medium and 5 for Hard.");
  assert.equal(rulesNoticeText({ rules: [two.rules[0]] }, fixedDay), "");
});

test("the real config announces the November 13 change", () => {
  assert.equal(rulesNoticeText(config, fixedDay),
    "From November 13, a step counts if either word is among the other's 10 closest words."
    + " Ladders are longer: par 4 for Easy, 5 for Medium and 6 for Hard.");
});

test("notice text has no em or en dashes", () => {
  assert.doesNotMatch(rulesNoticeText(config, fixedDay) + classicLabel(config, "2026-11-01"), /[–—]/);
});
