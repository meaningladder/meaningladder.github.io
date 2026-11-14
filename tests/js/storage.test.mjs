// Storage migrations (migrateStorage in js/data.js), against an in-memory
// localStorage so they run in Node.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
const { migrateStorage, store } = await import("../../js/data.js");

beforeEach(() => mem.clear());

const practiceGame = (level, path = ["ocean", "wave"]) => ({
  kind: "practice", puzzle: { start: "ocean", goal: "computer", par: 4, level, source: "practice" },
  path, hints: 0, hint: null, status: "playing",
});

test("schema 2: the single practice save moves to its level's own key", () => {
  store.set("schema", 2);
  store.set("practice", practiceGame("hard"));
  migrateStorage();
  assert.equal(store.get("practice"), null);
  assert.deepEqual(store.get("practice:hard"), practiceGame("hard"));
  assert.equal(store.get("practice:easy"), null);
  assert.equal(store.get("schema"), 4);
});

test("schema 1: a level-less practice save gets a level, then its own key", () => {
  const old = practiceGame(undefined);
  delete old.puzzle.level;
  old.puzzle.difficulty = "easy";
  store.set("practice", old);
  store.set("results", { "2026-11-20": { status: "won", steps: 3, par: 3, playedOn: "2026-11-20" } });
  migrateStorage();
  assert.equal(store.get("practice"), null);
  assert.equal(store.get("practice:easy").puzzle.level, "easy");
  assert.deepEqual(store.get("practice:easy").path, ["ocean", "wave"]);
  assert.ok(store.get("results")["2026-11-20:medium"]); // the v2 step still ran
  assert.equal(store.get("schema"), 4);
});

test("migration runs once and never overwrites a per-level save", () => {
  store.set("schema", 2);
  store.set("practice:medium", practiceGame("medium", ["ocean", "sea", "salt"]));
  store.set("practice", practiceGame("medium"));
  migrateStorage();
  assert.deepEqual(store.get("practice:medium").path, ["ocean", "sea", "salt"]);
  assert.equal(store.get("practice"), null);
  // A stray "practice" key written later (an old tab) isn't touched again.
  store.set("practice", practiceGame("easy"));
  migrateStorage();
  assert.equal(store.get("practice:easy"), null);
});

test("schema 4: chain ladders are wiped, saves and results; open ones stay", () => {
  store.set("schema", 3);
  const chain = { ...practiceGame("easy"), puzzle: { ...practiceGame("easy").puzzle, mode: "chain" } };
  const open = { ...practiceGame("hard"), kind: "daily" };
  store.set("game:2026-11-13:easy", chain);
  store.set("game:2026-11-13:hard", open); // an open game saved on a chain day
  store.set("practice:easy", chain);
  store.set("practice:hard", practiceGame("hard"));
  const won = { status: "won", steps: 5, par: 5, playedOn: "2026-11-14" };
  store.set("results", {
    "2026-11-13:easy": { ...won, medalPar: 5, slack: [2, 5, 8] },
    "2026-11-14:medium": { ...won, medalPar: 5, slack: [2, 5, 8] }, // its save is long gone
    "2026-11-13:hard": won,
    "2026-11-12:easy": won,
  });
  migrateStorage();
  assert.equal(store.get("game:2026-11-13:easy"), null);
  assert.equal(store.get("practice:easy"), null);
  assert.deepEqual(store.get("game:2026-11-13:hard"), open);
  assert.deepEqual(store.get("practice:hard"), practiceGame("hard"));
  assert.deepEqual(Object.keys(store.get("results")).sort(), ["2026-11-12:easy", "2026-11-13:hard"]);
  assert.equal(store.get("schema"), 4);
});

test("no practice save: migration is a no-op apart from the schema", () => {
  store.set("schema", 2);
  migrateStorage();
  assert.deepEqual(store.keys().sort(), ["schema"]);
});
