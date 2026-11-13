// Every script the browser loads must at least parse. The other tests only
// import logic.js and friends, so a syntax error in game.js (which needs a
// DOM to run) once shipped and left the site stuck on "Loading…".
// Run: node --test tests/js/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = [...readdirSync(join(root, "js")).map((f) => `js/${f}`), "sw.js"].filter((f) => f.endsWith(".js"));

test("every browser script parses as an ES module", () => {
  // Copied to .mjs so Node parses them as modules, the way the browser does.
  const dir = mkdtempSync(join(tmpdir(), "syntax-"));
  try {
    for (const f of scripts) {
      const copy = join(dir, f.replace(/\//g, "_").replace(/\.js$/, ".mjs"));
      copyFileSync(join(root, f), copy);
      try {
        execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
      } catch (e) {
        assert.fail(`${f} does not parse:\n${e.stderr}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(scripts.includes("js/game.js"));
});
