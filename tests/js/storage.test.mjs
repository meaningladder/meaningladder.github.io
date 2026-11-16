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

const game = (level) => ({
  kind: "daily", puzzle: { start: "ocean", goal: "computer", par: 4, level, source: "seeded" },
  path: ["ocean", "wave"], moves: 1, status: "playing",
});

for (const schema of [undefined, 2, 3, 4]) {
  test(`schema ${schema ?? 1} -> 6: every save and result goes, preferences stay`, () => {
    if (schema) store.set("schema", schema);
    store.set("game:2026-11-15:easy", game("easy"));
    store.set("game:2026-11-10", game("hard"));          // pre-level key
    store.set("practice", game("medium"));               // pre-schema-3 key
    store.set("practice:hard", game("hard"));
    store.set("results", { "2026-11-15:easy": { status: "won", steps: 4, par: 4 } });
    store.set("seenHelp", true);
    store.set("rulesSeen", "2026-11-13");
    migrateStorage();
    assert.deepEqual(store.keys().sort(), ["rulesSeen", "schema", "seenHelp"]);
    assert.equal(store.get("schema"), 6);
  });
}

test("schema 5 -> 6: only Nov 1-12 saves and results go (their par changed)", () => {
  store.set("schema", 5);
  store.set("game:2026-11-12:hard", game("hard"));
  store.set("game:2026-11-13:easy", game("easy"));
  store.set("practice:easy", game("easy"));
  store.set("results", { "2026-11-01:easy": { status: "won" }, "2026-11-14:hard": { status: "won" } });
  migrateStorage();
  assert.equal(store.get("game:2026-11-12:hard"), null);
  assert.deepEqual(store.get("game:2026-11-13:easy"), game("easy"));
  assert.deepEqual(store.get("practice:easy"), game("easy"));
  assert.deepEqual(Object.keys(store.get("results")), ["2026-11-14:hard"]);
  assert.equal(store.get("schema"), 6);
});

test("migration runs once: saves made under schema 6 are kept", () => {
  store.set("schema", 6);
  store.set("game:2026-11-16:easy", game("easy"));
  store.set("results", { "2026-11-16:easy": { status: "won", steps: 4, par: 4 } });
  migrateStorage();
  assert.deepEqual(store.get("game:2026-11-16:easy"), game("easy"));
  assert.ok(store.get("results")["2026-11-16:easy"]);
});

test("nothing stored: migration only sets the schema", () => {
  migrateStorage();
  assert.deepEqual(store.keys(), ["schema"]);
});
