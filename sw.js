// Service worker: makes repeat visits instant and the game playable offline.
//
// Two rules, chosen so a deploy can never get stuck behind an old cache:
//   data/*_vN.* (versioned, frozen: a change means a new N)  -> cache first
//   everything else (page, code, styles, config, puzzles)    -> network first,
//                                                               cache only as an offline fallback
// Only same-origin GET requests are touched.
const CACHE = "meaning-ladder-1";
// The app shell, saved at install. The page that registers the worker was
// fetched before the worker existed, so without this the very first visit
// could never reload offline. Still network-first: these only serve offline.
const SHELL = ["./", "style.css", "puzzle_config.json", "assets/fonts/nunito-latin-wght.woff2",
  "js/game.js", "js/data.js", "js/logic.js", "js/seeded.js", "js/icons.js"];
const VERSIONED = /\/data\/[a-z_]+_v\d+[a-z_]*\.(bin|json)$/;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Best effort: a missing file must not block the worker (the game works without it).
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    // Plus what a game needs to start, for the current data version.
    try {
      const { graphVersion: v, rules = [] } = await (await fetch("puzzle_config.json")).json();
      // Each era's start/goal exclusion file too: loadLadder needs all of them.
      // They don't match VERSIONED, so they stay network-first like the config.
      const excludes = rules.map((e) => e.excludeCandidates).filter(Boolean);
      await Promise.allSettled([`data/graph_v${v}_words.json`, `data/graph_v${v}_head.bin`,
        `data/candidates_v${v}.json`, ...excludes].map((url) => cache.add(url)));
    } catch { /* offline during install: they get cached on first use instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(VERSIONED.test(url.pathname) ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Offline. A page load gets the cached shell whatever its ?query is.
    const hit = req.mode === "navigate"
      ? (await cache.match(req, { ignoreSearch: true })) ?? (await cache.match("./"))
      : await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
