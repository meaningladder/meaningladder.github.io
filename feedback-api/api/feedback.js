// Meaning Ladder feedback: the game posts here and this files a GitHub issue,
// so players don't need a GitHub account. The GitHub key (GITHUB_TOKEN, a
// fine-grained token with Issues read/write on the one repo) lives only in
// Vercel's environment, never in the page.
//
// Spam guards: only the game's own origin, a hidden honeypot field, a minimum
// time with the form open, size caps, and a per-instance rate limit. The rate
// limit lives in memory, so it resets when Vercel starts a new instance: it
// slows a burst down, it is not a hard cap.

export const REPO = "meaningladder/meaningladder.github.io";
export const ORIGINS = ["https://meaningladder.github.io", "http://localhost:8000"];
// Must match FEEDBACK_KINDS in js/logic.js (tests/js/feedback-api.test.mjs checks).
export const KINDS = [
  "A puzzle (a word or link that felt wrong)",
  "Something broke",
  "An idea",
  "Something else",
];
export const MAX_TEXT = 1500;
const MAX_LINES = 6;
const MAX_LINE = 300;
const MIN_OPEN_MS = 3000;
const LIMIT = { posts: 3, windowMs: 10 * 60 * 1000 };

const recent = new Map(); // ip -> timestamps of recent posts

export function rateLimited(ip, now = Date.now()) {
  const times = (recent.get(ip) ?? []).filter((t) => now - t < LIMIT.windowMs);
  if (times.length >= LIMIT.posts) {
    recent.set(ip, times);
    return true;
  }
  times.push(now);
  recent.set(ip, times);
  return false;
}
export const resetRateLimit = () => recent.clear();

// The player's text as a fenced block: GitHub renders nothing inside it, so
// @mentions don't notify anyone and links don't become links. A run of three
// or more backticks would end the fence early, so it is broken up.
const fence = (s) => "```text\n" + s.replace(/`{3,}/g, (m) => m.split("").join("​")) + "\n```";

export function issueFor({ kind, text, context }) {
  const first = text.split("\n")[0].slice(0, 60).trim();
  const lines = context.length ? fence(context.join("\n")) : "_none_";
  return {
    title: `[Feedback] ${first || "Game feedback"}`,
    body: `### What is it about?\n\n${kind}\n\n### What happened?\n\n${fence(text)}\n\n### Game and browser\n\n${lines}\n\n<sub>Sent from the in-game feedback form.</sub>`,
    labels: ["feedback"],
  };
}

// Checks the posted fields. Returns { ok: true, value } or { ok: false, status, error, silent? }.
export function validate(input, now = Date.now()) {
  if (!input || typeof input !== "object") return { ok: false, status: 400, error: "Bad request." };
  const { kind, text, context = [], website = "", openMs } = input;
  // Bots fill every field; people never see this one. Pretend it worked.
  if (website) return { ok: false, status: 200, silent: true };
  // How long the form was open, measured by the browser (comparing its clock
  // with ours would break on any clock difference). A speed bump, not proof.
  if (typeof openMs !== "number" || !(openMs >= MIN_OPEN_MS)) {
    return { ok: false, status: 400, error: "That was quick! Please try again in a moment." };
  }
  if (!KINDS.includes(kind)) return { ok: false, status: 400, error: "Pick what it's about." };
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return { ok: false, status: 400, error: "Write a few words first." };
  if (t.length > MAX_TEXT) return { ok: false, status: 400, error: `Keep it under ${MAX_TEXT} characters.` };
  if (!Array.isArray(context)) return { ok: false, status: 400, error: "Bad request." };
  const lines = context.filter((x) => typeof x === "string").slice(0, MAX_LINES).map((x) => x.slice(0, MAX_LINE));
  return { ok: true, value: { kind, text: t, context: lines } };
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!ORIGINS.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

const send = (res, status, data) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
};

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel parsed it
  if (typeof req.body === "string") return JSON.parse(req.body);
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error("too big");
  }
  return JSON.parse(raw || "null");
}

export default async function handler(req, res, { fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  if (!cors(req, res)) return send(res, 403, { ok: false, error: "Not allowed." });
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST only." });
  if (Number(req.headers["content-length"] ?? 0) > 8192) return send(res, 413, { ok: false, error: "Too long." });

  let input;
  try {
    input = await readJson(req);
  } catch {
    return send(res, 400, { ok: false, error: "Bad request." });
  }
  const v = validate(input, now);
  if (v.silent) return send(res, 200, { ok: true });
  if (!v.ok) return send(res, v.status, { ok: false, error: v.error });

  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip, now)) return send(res, 429, { ok: false, error: "Thanks! That's a lot of feedback at once. Try again in a few minutes." });

  if (!env.GITHUB_TOKEN) return send(res, 503, { ok: false, error: "Feedback isn't set up yet." });
  let gh;
  try {
    gh = await fetchImpl(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "meaning-ladder-feedback",
      },
      body: JSON.stringify(issueFor(v.value)),
    });
  } catch {
    return send(res, 502, { ok: false, error: "Couldn't reach GitHub." });
  }
  if (!gh.ok) {
    console.error("GitHub said", gh.status, await gh.text().catch(() => ""));
    return send(res, 502, { ok: false, error: "GitHub didn't take it." });
  }
  const issue = await gh.json();
  return send(res, 201, { ok: true, number: issue.number, url: issue.html_url });
}
