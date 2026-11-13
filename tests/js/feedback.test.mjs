// The "Send feedback" link: a pre-filled GitHub issue form.
// Run: node --test tests/js/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEEDBACK_KINDS, FEEDBACK_MAX, feedbackUrl } from "../../js/logic.js";

const REPO = "meaningladder/meaningladder.github.io";

test("the link opens the feedback form, filled in", () => {
  const url = new URL(feedbackUrl(REPO, {
    kind: FEEDBACK_KINDS[0], text: "  cow to leather felt odd\nmore words  ", context: ["Game 14 (medium)", null, "Firefox"],
  }));
  assert.equal(url.origin + url.pathname, `https://github.com/${REPO}/issues/new`);
  const p = url.searchParams;
  assert.equal(p.get("template"), "feedback.yml");
  assert.equal(p.get("title"), "[Feedback] cow to leather felt odd");
  assert.equal(p.get("kind"), FEEDBACK_KINDS[0]);
  assert.equal(p.get("details"), "cow to leather felt odd\nmore words");
  assert.equal(p.get("context"), "Game 14 (medium)\nFirefox");
});

test("unknown kinds, empty text and long text stay safe", () => {
  const p = new URL(feedbackUrl(REPO, { kind: "<script>", text: "x".repeat(5000) })).searchParams;
  assert.equal(p.get("kind"), "Something else");
  assert.equal(p.get("details").length, FEEDBACK_MAX);
  assert.ok(p.get("title").length <= "[Feedback] ".length + 60);
  assert.equal(new URL(feedbackUrl(REPO, { kind: FEEDBACK_KINDS[2], text: " " })).searchParams.get("title"), "[Feedback] Game feedback");
});

test("the game's kinds match the issue form's dropdown exactly", () => {
  const yml = readFileSync(new URL("../../.github/ISSUE_TEMPLATE/feedback.yml", import.meta.url), "utf8");
  for (const k of FEEDBACK_KINDS) assert.ok(yml.includes(`        - ${k}\n`), k);
});
