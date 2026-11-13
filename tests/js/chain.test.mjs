// Chain ladders (from 2026-11-13): one fixed chain, one answer per rung.
// Run: node --test tests/js/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainGuess, closenessLabel, chainShareText, chainSquares, checkedChain, medalFor, resultMedal } from "../../js/logic.js";

const words = ["jeep", "truck", "tanker", "ship", "port", "harbor", "trucks", "tank", "tinker", "turkey"];
// truck's neighbors: tanker, tank, trucks, turkey (a word list in the ladder's shape).
const neighbors = [[1], [2, 7, 6, 9], [1, 3], [2, 4], [3], [4], [1], [1], [], [1]];
const ladder = { words, index: new Map(words.map((w, i) => [w, i])), neighbors };

test("only the rung's word counts; forms and typos of it do too", () => {
  assert.deepEqual(chainGuess(ladder, " Tanker ", "tanker", "truck"), { ok: true });
  assert.equal(chainGuess(ladder, "tankers", "tanker", "truck").note, "Counted as tanker.");
  assert.equal(chainGuess(ladder, "tankre", "tanker", "truck").note, "Counted as tanker."); // typo, not a word
  // A real word one letter off is a different word, not a typo.
  const tinker = chainGuess(ladder, "tinker", "tanker", "truck");
  assert.equal(tinker.ok, false);
  assert.equal(tinker.wrong, true);
  assert.equal(tinker.near, false);
});

test("a plural counts for its singular and a singular for its plural", () => {
  assert.equal(chainGuess(ladder, "ships", "ship", "tanker").note, "Counted as ship.");
  assert.equal(chainGuess(ladder, "truck", "trucks", "jeep").note, "Counted as trucks.");
  assert.equal(chainGuess(ladder, "box", "boxes", "jeep").note, "Counted as boxes.");
  // -ies and -men plurals, both ways (they don't share a start).
  const pl = { words: ["city", "cities", "party", "parties", "woman", "women"], neighbors: [] };
  pl.index = new Map(pl.words.map((w, i) => [w, i]));
  for (const [a, b] of [["city", "cities"], ["party", "parties"], ["woman", "women"]]) {
    assert.equal(chainGuess(pl, a, b, "jeep").note, `Counted as ${b}.`);
    assert.equal(chainGuess(pl, b, a, "jeep").note, `Counted as ${a}.`);
  }
  // A shorter relative is another word, even with a shared start.
  assert.equal(chainGuess(ladder, "tank", "tanker", "truck").ok, false);
});

test("a fitting wrong guess costs a move and says if it was close", () => {
  const r = chainGuess(ladder, "turkey", "tanker", "truck");
  assert.deepEqual(r, { ok: false, wrong: true, word: "turkey", near: true });
});

test("guesses that can't be the answer are free and say why", () => {
  const free = (t) => chainGuess(ladder, t, "tanker", "truck", ["jeep", "truck", "harbor"]);
  assert.match(free("zzzzzz").error, /isn't in our 10-word list/);
  assert.match(free("harbor").error, /already on the ladder/);
  assert.match(free("").error, /Type a word/);
  assert.match(free("t4nker").error, /Letters only/);
  for (const t of ["zzzzzz", "harbor", "", "t4nker"]) assert.equal(free(t).free, true);
});

test("no length is shown, so a real word of any length is a wrong guess", () => {
  // tank is a close neighbor of truck; ship isn't.
  assert.deepEqual(chainGuess(ladder, "tank", "tanker", "truck"), { ok: false, wrong: true, word: "tank", near: true });
  assert.deepEqual(chainGuess(ladder, "ship", "tanker", "truck"), { ok: false, wrong: true, word: "ship", near: false });
  assert.equal(chainGuess(ladder, "harbor", "tanker", "truck", []).wrong, true); // same length, other word
});

test("closeness labels for wrong guesses", () => {
  assert.deepEqual([1, 10, 11, 50, 51, 300, 301, 5000].map(closenessLabel),
    ["very close", "very close", "close", "close", "warm", "warm", "cold", "cold"]);
  assert.equal(closenessLabel(null), "");
  assert.equal(closenessLabel("?"), "");
});

test("a puzzle file's chain is used only when it is complete and consistent", () => {
  const good = { start: "jeep", goal: "harbor", par: 5, route: ["jeep", "truck", "tanker", "ship", "port", "harbor"],
    reasons: ["a", "b", "c", "d", "e"], clues: [] };
  assert.deepEqual(checkedChain(good, ladder), good.route);
  assert.ok(checkedChain({ ...good, clues: ["1", "2", "3", "4", "5"] }, ladder));
  assert.equal(checkedChain({ ...good, clues: ["1"] }, ladder), null);
  assert.equal(checkedChain({ ...good, reasons: ["a"] }, ladder), null);
  assert.equal(checkedChain({ ...good, goal: "port" }, ladder), null);
  assert.equal(checkedChain({ ...good, route: ["jeep", "truck", "zz", "ship", "port", "harbor"] }, ladder), null);
  assert.equal(checkedChain({ ...good, route: ["jeep", "truck", "truck", "ship", "port", "harbor"] }, ladder), null);
  assert.equal(checkedChain({ start: "jeep", goal: "harbor", par: 5 }, ladder), null); // open-ladder file
});

test("chain medals allow wrong guesses: gold up to par + 2 by default config", () => {
  const slack = [2, 5, 8];
  assert.equal(medalFor(4, 4, { slack }).id, "gold");
  assert.equal(medalFor(6, 4, { slack }).id, "gold");
  assert.equal(medalFor(7, 4, { slack }).id, "silver");
  assert.equal(medalFor(12, 4, { slack }).id, "bronze");
  assert.equal(medalFor(13, 4, { slack }).id, "finished");
  // Open ladders keep their exact thresholds.
  assert.deepEqual([4, 5, 6, 7].map((m) => medalFor(m, 4).id), ["gold", "silver", "bronze", "finished"]);
  // A saved chain result keeps its own par and slack.
  assert.equal(resultMedal({ moves: 6, par: 5, medalPar: 4, slack }).id, "gold");
  assert.equal(resultMedal({ moves: 6, par: 5 }).id, "silver");
});

test("share squares: first guess, after misses, revealed", () => {
  const rungs = [{ solved: true, misses: 0 }, { solved: true, misses: 2 }, { solved: true, misses: 0, revealed: true }, { solved: true, misses: 0 }];
  assert.equal(chainSquares(rungs, true), "🟩🟨⬜🟩✅");
  const text = chainShareText({ label: "#15 Easy", moves: 7, par: 4, slack: [2, 5, 8], rungs, url: "https://x.test/" });
  assert.equal(text, "Meaning Ladder #15 Easy 🥈\n7 moves · 4 hidden words\n🟩🟨⬜🟩✅\nhttps://x.test/");
  assert.doesNotMatch(chainShareText({ label: "x", moves: 3, par: 4, slack: [2, 5, 8], rungs, gaveUp: true }), /🥇|🥈/);
});
