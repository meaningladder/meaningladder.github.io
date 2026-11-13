// The feedback function (feedback-api/api/feedback.js), with a fake GitHub.
// Run: node --test tests/js/*.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import handler, { KINDS, ORIGINS, issueFor, resetRateLimit } from "../../feedback-api/api/feedback.js";
import { FEEDBACK_KINDS } from "../../js/logic.js";

const ORIGIN = "https://meaningladder.github.io";
const NOW = 1_000_000;

function call({ method = "POST", origin = ORIGIN, body, ip = "1.2.3.4" } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, issue: JSON.parse(opts.body) });
    return { ok: true, status: 201, json: async () => ({ number: 7, html_url: "https://github.com/x/issues/7" }) };
  };
  const res = {
    statusCode: 0, headers: {}, out: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s = "") { this.out = s; },
  };
  const req = { method, headers: { origin, "x-forwarded-for": ip }, body };
  return handler(req, res, { fetchImpl, env: { GITHUB_TOKEN: "t" }, now: NOW })
    .then(() => ({ res, calls, json: res.out ? JSON.parse(res.out) : null }));
}
const good = (over = {}) => ({ kind: KINDS[0], text: "cow to leather felt odd", context: ["Game 14"], website: "", openMs: 10_000, ...over });

beforeEach(() => resetRateLimit());

test("the function's kinds match the game's", () => {
  assert.deepEqual(KINDS, FEEDBACK_KINDS);
  assert.ok(ORIGINS.includes(ORIGIN));
});

test("a good post files one labeled issue and returns its number", async () => {
  const { res, calls, json } = await call({ body: good() });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(json, { ok: true, number: 7, url: "https://github.com/x/issues/7" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /repos\/meaningladder\/meaningladder\.github\.io\/issues$/);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer t");
  assert.deepEqual(calls[0].issue.labels, ["feedback"]);
  assert.equal(calls[0].issue.title, "[Feedback] cow to leather felt odd");
  assert.equal(res.headers["access-control-allow-origin"], ORIGIN);
});

test("other sites, other methods and preflight", async () => {
  assert.equal((await call({ origin: "https://evil.test", body: good() })).res.statusCode, 403);
  assert.equal((await call({ method: "GET" })).res.statusCode, 405);
  const pre = await call({ method: "OPTIONS" });
  assert.equal(pre.res.statusCode, 204);
  assert.equal(pre.calls.length, 0);
});

test("bots and junk never reach GitHub", async () => {
  const bot = await call({ body: good({ website: "http://spam" }) });
  assert.equal(bot.res.statusCode, 200);               // looks fine to the bot
  assert.equal(bot.calls.length, 0);
  for (const body of [good({ openMs: 500 }), good({ openMs: undefined }), good({ kind: "<b>" }), good({ text: "   " }),
    good({ text: "x".repeat(1501) }), good({ context: "nope" }), null]) {
    const r = await call({ body });
    assert.equal(r.res.statusCode, 400, JSON.stringify(body));
    assert.equal(r.calls.length, 0);
  }
});

test("three posts per person, then a pause", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await call({ body: good() })).res.statusCode, 201);
  assert.equal((await call({ body: good() })).res.statusCode, 429);
  assert.equal((await call({ body: good(), ip: "5.6.7.8" })).res.statusCode, 201); // someone else
});

test("player text can't ping anyone or break out of its block", () => {
  const { body } = issueFor({ kind: KINDS[1], text: "hi @octocat\n```\n# big", context: [] });
  assert.match(body, /```text\nhi @octocat\n`​`​`\n# big\n```/);
  assert.equal((body.match(/```/g) ?? []).length, 2); // one fence open, one close
});
