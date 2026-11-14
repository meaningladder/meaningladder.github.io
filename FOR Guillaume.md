# FOR Guillaume: the Meaning Ladder debrief

Grab a coffee. This is the story of how the game got built, what went sideways,
and the stuff worth stealing for your next project.

---

## The big idea, in one breath

A word embedding (GloVe) puts every word at a point in 300-dimensional space,
where "close" means "used in similar contexts". We turned that space into a
**road map**: every word gets one-way roads to its 100 nearest neighbors. A
puzzle is just "find a route from town A to town B", par is the shortest route
(BFS), and everything else (the AI themes, the seeded fallback, the colored
bars) is built around that one frozen map.

```
build_graph.py (once)     →  data/graph_v1.json  (20k words × 100 roads)
generate_puzzle.py (daily) →  puzzles/2026-11-16.json  (start, goal, par, theme)
browser                    →  loads both, runs BFS backwards from the goal, you play
```

The important design move: **the map is computed once, offline, and frozen.**
The browser never does any machine learning. It downloads ~0.8 MB of integers (see "Shipping less" below) and
does graph search, which is fast and cheap and works on a static host with no server.

---

## How the parts talk to each other

Think of it as three people who never meet but share a notebook:

1. **The cartographer** (`scripts/build_graph.py`) drew the map once, and the
   map is never redrawn in place. If it changes, it becomes `graph_v2.json`.
2. **The puzzle editor** (`scripts/generate_puzzle.py`, run by GitHub Actions
   twice a day, just before tomorrow starts anywhere) asks OpenAI for a fun pair, then fact-checks it
   against the map with BFS, because the AI has never seen our map.
3. **The player's browser** (`js/`) reads the map and the day's puzzle file.

The "shared notebook" is `puzzle_config.json` (launch date, difficulty bands,
model name), read by **both** Python and JavaScript. One source of truth means
the two sides can't drift apart on, say, what counts as Wednesday's difficulty.

The sneakiest connection: if a puzzle file is missing, the browser computes the
**exact same** puzzle Python would have, using the same hash (FNV-1a), the same
random generator (mulberry32) and the same candidate list. Two programs in two
languages agree without talking, like two people who memorized the same
dice-rolling ritual.

---

## Decisions, and what we turned down

| Decision | Chosen | Rejected (and why) |
|---|---|---|
| Vectors | GloVe 300d | 100d: noisier neighbors, and the output file is the same size either way, because we store indexes, not vectors |
| Vocabulary filter | Must be a lowercase WordNet lemma | Frequency + blocklist only: "paris" and "obama" would be steps, which turns the game into trivia |
| "Free step" filter | Shared lemma OR long shared prefix | Stemmer only: misses volcano/volcanic |
| File format | Plain JSON (indexes) | Binary Uint16: ~1.5 MB smaller, but unreadable and harder to debug. GitHub Pages gzips JSON anyway |
| Difficulty | Par + **number of shortest routes** | Par 3–6 as in the spec: impossible (see below) |
| AI provider | OpenAI `gpt-6.1-sol` (your call) | The Claude API from the spec; the code keeps everything AI-related in one file, `ai_suggest.py`, so swapping is easy |
| AI prompt | A daily seeded sample of 150 words + recent history | The full list (the model reuses its favorites); no list (wasted retries) |
| AI shape | 5 ranked pairs per call, feedback on retry | 1 pair per call: needs ~5× more calls to hit the day's band |
| Deploy | Pages via an Actions workflow, called by the daily job | "Deploy from branch": a push made with `GITHUB_TOKEN` doesn't trigger other workflows, so new puzzles wouldn't deploy |
| Frontend | Vanilla ES modules, a 10-line `h()` DOM helper | A framework: you asked for fundamentals, and the whole UI is ~600 lines |

---

## The moment the spec met reality

The spec said "3 ≤ par ≤ 6" and "Monday easy → Sunday hard, mapped to par".
Before designing around it, I **measured**: 400 random candidate pairs had par
1:5, 2:90, 3:264, 4:41, **5–6: zero.**

With 100 roads per town, the map is a *small world*: everything is about 3–4
hops from everything, like six degrees of separation. So par alone gives you
two difficulty levels, not seven.

The fix was to count *how many* shortest routes exist. "Par 3 with 60 routes"
is a wide-open highway; "par 4 with 10 routes" is a hidden mountain pass. The
BFS got a one-line upgrade (each word inherits the route count of the words
that reach it), and the weekday bands were **calibrated from percentiles** of
2,500 random pairs, not guessed.

**The lesson:** spend 30 seconds measuring before you spend 3 hours designing.

---

## Mistakes, dead ends and how they got fixed

- **pip broke itself.** `pip install --upgrade pip` in a fresh venv on Windows
  half-replaced pip while it was running (Windows locks files in use). The fix
  was to delete the brand-new venv and reinstall without upgrading pip. Lesson:
  a broken environment that's 5 minutes old is cheaper to rebuild than to repair.
- **The first candidate list was full of names and adjectives.** napoleon,
  collins, white, short. WordNet's usage counts (from a hand-tagged corpus)
  told us when a word is "mostly a name" or "mostly an adjective".
- **My own test was wrong.** I asserted computer → computing should be an
  allowed step; the rule correctly called them the same word family. When a
  test fails, ask "is the code wrong or is my expectation wrong?" before
  "fixing" anything.
- **Offensive content got through anyway.** The blocklist caught profanity, but
  a practice puzzle routed curry → lamb → slaughter → civilians → insurgent,
  and another started at "racist". An automatic filter (WordNet's
  "disparagement" labels) turned out to be useless: it also flags baby, key and
  tool. So I did a hand pass over candidates. **You still owe the list one
  human read-through** (`scripts/lists/candidates_exclude.txt`).
- **CSS `hidden` didn't hide.** `.actions { display: flex }` beats the
  browser's built-in `[hidden] { display: none }`, so Undo/Hint stayed visible
  after winning. One global `[hidden] { display: none !important }` fixed it.
  This is one of the most common frontend bugs on the internet.
- **"nullnull" on screen.** `element.replaceChildren(null)` doesn't skip
  `null`; it inserts the text "null". Fixed by filtering optional children.
  JS DOM APIs stringify more eagerly than you'd expect.
- **The countdown said 199 hours.** The `?today=` testing override was mixed
  with the real clock. The countdown now always uses real time.
- **`node --test tests/js/` crashed.** Node 24 read the folder as a script
  path; a quoted glob (`"tests/js/*.test.mjs"`) works on every shell.
- **Test-harness escaping hell.** I hand-wrote JSON containing JavaScript
  containing regexes, and the backslashes ate me alive twice. The fix was to
  generate the JSON with `json.dumps` instead of string-pasting. When you
  catch yourself escaping escapes, use a serializer.

---

## Pitfalls I'd warn Future You about

1. **Directed graphs bite.** B in A's top-100 doesn't mean A is in B's top-100
   (only ~60% of roads go both ways). The steps-to-goal bars come from a BFS
   over *reversed* roads; a forward BFS from the goal would give the wrong answer.
2. **Never trust the AI's output.** It doesn't know our map. Every pair is
   checked for candidate membership, recent use, reachability, par and route
   band. The browser even re-derives par itself and trusts the BFS over the file.
3. **Changing data changes the past.** Edit the candidate list and every
   seeded puzzle changes. The golden fixture test (`seeded_vectors.json`)
   exists to make that *loud*. Once real puzzles are live, changes go in
   `_v2` files.
4. **Dates are a minefield.** `toISOString()` gives the UTC date, which is
   "tomorrow" for an evening player in New York. We use local dates in the
   browser, `Date.UTC` + `Math.round` for day differences, and Python's pure
   `date` objects (no clock, so no daylight-saving hour).
5. **The "already live" rule.** If a date's file is missing and that date has
   already begun somewhere (UTC+14, Kiribati), browsers there are playing the
   seeded fallback. Writing an AI puzzle now would swap their puzzle mid-day,
   so the generator writes the *seeded* one instead. That's a whole class of bug
   that only exists because the game runs in many time zones at once.
6. **32-bit math in JS.** Plain `*` in JavaScript silently loses precision past
   2^53. FNV and mulberry32 need `Math.imul` and `>>> 0`, and Python needs
   explicit `& 0xFFFFFFFF`. We proved they match with shared test vectors
   *before* building the frontend.
7. **GitHub disables cron in quiet repos.** In a public repo, scheduled
   workflows switch off after 60 days without activity. The daily commits should
   count, but if puzzles ever go `"source": "seeded"` for days, check the
   Actions tab (each fallback also leaves a yellow warning annotation on the run).

---

## What an expert would notice that a beginner might miss

- **Make the fallback the *same* as the real thing.** The seeded puzzle isn't a
  "something went wrong" screen; it's a fully valid puzzle every client agrees
  on. Graceful degradation designed in from the start.
- **Exclusive file creation (`open(path, "x")`).** "Check if the file exists,
  then write" has a race window. Asking the OS to refuse an overwrite doesn't.
- **Dependency injection for the API client.** `ai_puzzle(..., client)` takes
  the client as a parameter, so the tests pass a 20-line fake: no network, no
  key, no cost, fully deterministic.
- **Saved games store their own puzzle.** If the network glitches and a
  refresh would load a different puzzle, the saved game still holds its
  original start/goal. State that owns its inputs can't be swapped from under you.
- **Calibrate from data.** The difficulty thresholds come from percentiles;
  the contrast fixes come from computed WCAG ratios (light-mode muted text was
  3.6:1 and the buttons were 2.8:1, both below the 4.5:1 minimum, and they
  looked fine to the eye).
- **Test the UI like a user.** I drove headless Chrome over the DevTools
  protocol, typed words, and screenshotted light/dark at 320 and 390 px. The
  hidden-buttons bug and "nullnull" were *only* visible that way; every unit
  test was green.
- **Keep secrets out of the repo entirely.** The key lives only in the Actions
  secret store. The workflow passes it via `env:`, so it never appears in
  command lines or logs.

---

## Tools, and what else you could use

- **gensim** downloaded GloVe for us. *Alternative:* parse the raw `.txt` with numpy.
- **NLTK WordNet** handled lemmas, parts of speech, "is it a name?" and
  "is it a physical thing?". *Alternative:* spaCy (heavier, better lemmatizer).
- **scipy** found strongly connected components (to confirm every candidate
  can reach every other).
- **The OpenAI SDK with structured outputs** (`responses.parse` +
  Pydantic) means the reply is guaranteed to match our schema, so there's
  no "please return JSON" begging.
- **pytest + `node --test`**: two test runners, one shared golden fixture.
  *Alternative:* Jest/Vitest (needs npm and a `package.json`).
- **GitHub Actions + Pages** cost nothing for a public repo. *Alternatives:*
  Netlify/Vercel + their cron, or Cloudflare Pages + Workers.

---

## Lessons that travel to other projects

1. **Precompute the heavy stuff; ship the light stuff.** ML offline, integers online.
2. **Version your data like code.** Frozen `_v1` files + a config pointer.
3. **When two systems must agree, give them a shared fixture, not a promise.**
4. **Validate at the boundary.** Anything from an AI, a network or a user is a
   suggestion until your own code checks it.
5. **Measure before you design.** The par distribution changed the whole
   difficulty system.
6. **Filters are never done.** Automatic content filtering gets you 90% of the
   way, and the last 10% needs human eyes.
7. **Look at the thing.** Screenshots caught what tests couldn't.

---

## The design pass (after everything "worked")

Once the game was functionally done, I ran the frontend through a design
checklist. The interesting part is what it caught that "it works" didn't:

- **Hand-drawn icons and emoji as UI.** The back arrow and menu dots were
  SVG paths I'd sketched, and the medals were emoji, which render differently
  on Windows, macOS and Android (and sometimes as blank boxes). They're now
  glyphs copied verbatim from the Phosphor icon library, plus a small medal
  badge component with gold/silver/bronze tokens that pass contrast in both
  themes. Emoji survive only in the share text, where your spec asked for them.
- **A third-party font request on every visit.** Nunito came from Google
  Fonts; it's now a single 39 KB self-hosted file with `font-display: swap`.
  That's one less DNS lookup and no visitor IPs sent to a third party.
- **"Loading..." for a 4.7 MB download.** On a slow phone that's seconds of
  blank screen. A skeleton shaped like the real game screen makes the wait
  read as "almost there" instead of "broken".
- **Five different corner radii.** 8, 10, 12, 14 and 6 px had crept in. Now
  there's one documented rule: controls 8 px, containers 12 px, pills round.
- **Motion with a reason.** Exactly two animations, each one justified:
  the win card rising in (a state change), the new bar sliding in (where
  your eye should go). There was a shake on rejected words too; it was cut
  later because the Tried list already shows what happened.
  All of them switch off under `prefers-reduced-motion`.
- **Copy bugs.** "A expert one." (the practice teaser) and dash characters
  used as placeholders ("Not played" and "no route" now say what they mean).

The lesson: "functionally correct" and "finished" are different milestones.
A checklist written by someone else finds the stuff you've stopped seeing.

---

## The security pass

A static game sounds like it has nothing to attack, but the moving parts are
the GitHub Actions (they hold your OpenAI key and can push to the repo) and
the AI text that ends up on the page. What we checked and fixed:

- **Script injection in Actions.** The manual `date` input was pasted into a
  shell line unquoted, so `2026-11-16 --out /somewhere` would have smuggled in
  an extra argument. Now the date must match `YYYY-MM-DD` and arguments go in
  a quoted bash array. We proved it by attacking our own workflow: rejected.
- **Pinned actions.** `actions/checkout@v7` is a tag, and tags can be moved to
  different code. Every action is now pinned to a full commit SHA, and
  Dependabot proposes updates. (This is how real supply-chain attacks spread:
  a popular action's tag gets repointed.)
- **Least privilege.** `permissions: {}` at the top of each workflow; each job
  asks only for what it needs. The key is visible to exactly one step, after
  `pip install`, so a malicious package install script can't read it.
- **Content-Security-Policy.** The page may only load code, styles, fonts and
  data from its own origin. That's possible because the earlier design pass
  removed the Google Fonts dependency, so security and design helped each other.
- **XSS check.** We fed the site a booby-trapped puzzle file (`<img onerror>`,
  `<script>`) and it rendered as plain text, because the UI builds DOM nodes
  with `textContent` instead of `innerHTML`. AI-written themes/teasers are
  also checked server-side (plain text, length, no links, blocklist).
- **Already in place:** GitHub secret scanning + push protection, HTTPS
  enforced, no secrets anywhere in git history.

Things only you can do: put a monthly spending cap on the OpenAI project that
owns the key, and if the key ever leaks, revoke it at OpenAI first, then run
`gh secret set OPENAI_API_KEY` with a new one.

---

## Three levels a day

The weekday curve (easy Monday ... expert Sunday) became **Easy / Medium / Hard
every day**: same graph rules, three bands (3 steps with many routes, 3 steps
with few, 4 steps). Design choices worth noticing:

- **One file per level** (`2026-11-12-hard.json`), so "never overwrite" still
  works file by file and a failed level doesn't block the other two.
- **The seed includes the level** (`"2026-11-12:hard#0"`), so a day's three
  fallback puzzles are independent; the golden fixture pins it in both languages.
- **Same-day words count as "recent"**, so a day's three puzzles never share a word.
- **Saved progress was migrated, not wiped.** A one-time `migrateStorage()`
  moves old `game:<date>` saves to `game:<date>:<level>`, guessing the level
  from the old difficulty label. A test caught that navigating to the *same*
  URL doesn't reload the page, which is why the first migration check "failed".
- **Deploy order mattered.** Today's new levels were already "live" in UTC+14,
  so the code was pushed with `[skip ci]` and the puzzle job's own deploy
  published the new frontend and the new files together: no seeded window.

---

## Launch

We launched on **Tuesday 2026-11-10**, then moved Game #1 back to **Nov 1** two days later so the whole first month is playable (27 back-filled puzzles; the game computes numbers from the date, so stale saves can't show old numbers). Originally it launched (moved up from the planned Monday the 16th,
which was safe because no real puzzle had been published yet, so no game numbers
changed for anyone). The first four puzzles (Nov 10-13) were written by the
GitHub job with the AI. On Nov 11 the job switched to just-in-time: because the
repo is public, every committed puzzle is readable on GitHub at once, so it now
writes only tomorrow's puzzle, a few hours before UTC+14 reaches it. (Hashed file
names wouldn't have helped: they'd sit in the same public repo, and the browser's
naming rule would be in public JavaScript.) A robots.txt, which only works now
that the game sits at a domain root, keeps /puzzles/ and /data/ out of search.

Still worth doing: one human read of `data/candidates_v1.json`, and a monthly
spending cap on the OpenAI project. Edits to the candidate list now only affect
the seeded fallback for days that have no puzzle file, so they're low-risk,
but run `make candidates` and commit the fixture with it.

Live site: https://meaningladder.github.io/

## Natural routes: fewest rungs isn't gentlest rungs

Players said the ladders felt jumpy. The puzzles weren't the problem, since
players pick the middle words themselves. The problem was the route *we*
showed them on the result screen and in hints. That route came from BFS, which
finds the path with the **fewest steps**. When any of a word's top 100
neighbors counts as a legal step, the fewest-steps path usually needs one wild
leap: `door → window → stained → blood (#79) → kidney`.

The fix is a different question with a different algorithm. **Dijkstra** finds
the *cheapest* path, and the price of a step is its rank in the neighbor list
(#1 costs 1, #79 costs 79) plus 5 per step. Same puzzle:
`door → window → glass → shards → fragments → bone → marrow → kidney`.
It's three steps longer, and every step is obvious.

- **Why add a +5 per step?** Without it, ten #1 steps would beat one #11 step,
  and routes would crawl through near-synonyms. One constant (`STEP_COST`)
  sets the trade-off between short and smooth.
- **Same trick as BFS, run backwards.** One Dijkstra from the goal over
  reversed edges gives every word's cost-to-goal at once, so any hint is just
  "pick the neighbor with the cheapest step plus remaining cost." It takes
  about 22 ms on 20k words, and it only runs when a hint or the result screen
  needs it.
- **Par stays on BFS.** Par is a promise about the *fewest* steps possible,
  and medals depend on it. Changing it would have silently changed every past
  result. So the result screen says both things:
  "A natural route … (7 steps; the shortest takes 4)."
- **No similarity scores needed.** The graph only stores neighbor lists, but
  they're sorted by similarity, so rank works as a free cost. Always check
  what your data already encodes before adding more of it.

## Tightening the rule without breaking history

Natural routes fixed what we *showed*, but players could still make, and par
still assumed, big leaps, because any of a word's top 100 was a legal step. The
real fix was a rule change: from Nov 13, only the **top 20** count. Across 300
random pairs, par moved from mostly 3 to mostly 4–6, and the shortest path
itself became sensible: `mineral → copper → gold → crown → throne`.

The interesting part is changing a rule in a live game:

- **Eras, not edits.** `puzzle_config.json` now has a `rules` list with dated
  entries. Nov 1–12 keep top 100 and their old pars; Nov 13+ get top 20 and
  pars 4/5/6. One function (`rules_for` in Python, `rulesFor` in JS) picks
  the era for a date. Every old result, medal and streak stays valid, because
  every old puzzle is still judged by its old rule.
- **A view, not a new data file.** The neighbor lists were already sorted by
  similarity, so "top 20" is just `row[:20]`. A *ladder view* wraps the same
  graph with cut lists, its own reverse index and the era's config. Because
  every function already took a `ladder`, the whole game (checks, par, hints,
  routes, seeded fallback, AI shortlist) switched rules without touching those
  functions. That's the payoff of passing data in instead of reading globals.
- **The cut part is still useful.** Words ranked #21–#100 are no longer legal,
  but the file still knows their exact rank, so the Tried list now shows "#50"
  exactly instead of estimating it from the compact vectors.
- **Stamp what you can't infer later.** New puzzle files carry `stepLimit`.
  Old files don't, and "missing means 100" is the one rule for reading them.
  Unlimited games are stamped too, so a game saved under the old rules still
  resumes under the old rules.
- **Timing.** Nov 13–15 already had Hard puzzles built for the old rule. They
  were unplayed (UTC+14 was still on Nov 12), so they were deleted and
  regenerated. That's the same exception as before, checked the same way.

---

## Shipping less, and surviving offline

A design review asked: what would break first if this got popular? Not the
servers (there are none). The **download**: 4.7 MB of compressed JSON on every
first visit, and GitHub Pages has a soft bandwidth limit of 100 GB a month.

- **Measure before you optimize.** Rewriting the JSON as raw binary only went
  from 4.7 MB to 3.8 MB gzipped: random word numbers don't compress, whatever
  the format. Not worth it on its own.
- **Ship what's needed, when it's needed.** The current rules only use each
  word's top 20 neighbors, which come to 0.8 MB. So the graph is split into a *head*
  (top 20, loaded first) and a *tail* (ranks 21 to 100, loaded only for
  old top-100 archive games and exact ranks in the Tried list). The first
  download shrank ~5x **without changing the data**: `graph_v1.json` is still the
  source of truth, and `tests/test_graph_bin.py` proves head + tail equals it.
- **Cache by name, fetch fresh otherwise.** The service worker (`sw.js`)
  treats files with a version in their name (`_v1`) as frozen, so they're cached
  forever. Everything else is network-first, so a deploy is never hidden behind
  an old cache. That's the same "never edit v1" rule from the data, put to work twice.
- **Test the real failure, not the happy path.** The first offline test
  failed: the page that registers a service worker was fetched *before* the
  worker existed, so nothing had cached it. The fix (save the app files when
  the worker installs) only came from actually killing the server and reloading.
- **Know when it breaks before players do.** `heartbeat.yml` checks every
  morning that tomorrow's puzzles are live and emails you if not.

The design-system pass did the same at a smaller scale. 14 font sizes became
6 tokens. The "you are here" outline was written 4 times; now it's one rule,
and it no longer makes elements shift by a pixel. Leftover near-miss code went too.

---

## Loosening the rule: playtests beat theory

The top-20 rule looked principled on paper: every step clearly related. A real
player then hit champ to dress and gave up. Champ's 20 closest words were all
boxing; the only way out was "reigning" (to crown, princess, bride, dress), and
nothing on screen pointed at royalty. Half of all links also ran only one way,
so obvious guesses were rejected for a reason players can't see.

Two fixes, each aimed at a different cause:
- **Direction, not just distance:** a signpost word on a middle rung, taken
  from a real route, so a long ladder has a visible heading.
- **Fewer pointless rejections:** a step now counts if *either* word is in the
  other's top 40. The graph becomes undirected, champ to dress is par 3 with 8
  good first moves instead of 1, and "one-way" stops being a thing to explain.

Both used the same safety rails as before: the change lives in a rules era,
past days keep their rules, Python and JS build the two-way lists in the exact
same order (the parity tests prove it), and new browser files get a new name
(`graph_v1_wide_*`) because the service worker caches data files forever by name.

The first loosening overshot: top 40 both ways made most ladders 3 steps, and
the next playtest asked for more steps. Top 25 both ways sits between the two:
no one-way rejections, about half the ladders 4 steps. Two quick rounds, each
measured on the real word map before shipping, beat one big guess.
A third round asked for longer ladders still, so the limit went to top 15 both
ways: about as many accepted words per step as the old one-way top 20 (22 on
average), but with no one-way surprises, a signpost and clue hints. Easy is
par 4, Medium and Hard par 5.
Round four tightened to top 10 both ways (about 15 accepted words per step):
Easy par 4, Medium 5, Hard 6. Removing filler "hub" words (really, thing) was
measured first and barely changed lengths: the step limit is the real lever.

---

## Better routes without a stricter rule

The ask was "make the route better and longer". Three word maps were measured
before writing any game code:
- **WordNet** (dictionary relations): no longer, 6% of pairs unreachable, odd
  verb-sense hops (building, make, fire).
- **ConceptNet** (labeled relations): *shorter*, because hubs like person, city
  and car connect everything; removing hubs didn't help.
- **Hybrid** (GloVe-close AND a ConceptNet link): lovely, longer routes (cafe,
  restaurant, dinner, barbecue, charcoal, coal, fuel), but as a step rule it
  leaves most words 1-2 accepted next words. Far too strict.

So the hybrid became a *lens*, not a rule. You can still type any word the
GloVe rule accepts. ConceptNet only (1) picks puzzles that have a shortest
route made mostly of real relations, and (2) chooses which shortest route the
game shows. Because the shown route is always a shortest one, par and medals
are untouched. The lesson: when one data source is great at quality but too
sparse for a rule, use it to rank, not to judge.

## One answer per rung

Even with longer ladders and reasons, open play let people wander, and
"impossible" ladders kept coming back from playtests. The new ask: every level
5 steps, difficulty = how obvious the associations are, and one answer per
ladder. That's a different game (a chain puzzle), so it got its own era
(`"mode": "chain"`, from Nov 15) instead of a patch on the old one.

What made "one answer" fair rather than cruel:
- **A pattern on every hidden rung** (first letter + length). Without it, one
  answer is a mind-reading contest. With it, the code can *prove* uniqueness:
  no other word close to the previous one fits the same pattern
  (`pattern_rivals`). The AI is told exactly which rival words broke a chain.
- **Free misses for impossible guesses.** A word that doesn't fit the letters
  costs nothing; only a fitting wrong guess is a move. Medals got slack
  (`medalSlack`) because every wrong guess now costs.
- **Reasons as you climb.** Each solved rung shows why it links, so a lateral
  step (turkey, the country) reads as clever, not unfair.

Difficulty moved from "longer route" to "looser links": Easy links must be in
each other's top 10 and labeled everyday by the AI; Hard allows top 40 and asks
for 2-3 lateral links. Two independent signals (an AI label and a measured
rank) is a pattern worth stealing: neither alone is trustworthy, together they
catch each other's mistakes.

Tradeoff to remember: less freedom. Open ladders rewarded creative routes;
chains reward finding *the* route. The old days stay playable as "classic rules
(open ladder)", so both versions can be compared on real players.


Update: the signpost (a free guide word on a middle rung of open ladders) was
later removed. Chain ladders made it redundant, and the page reads simpler
without it; hints still follow the same shown route.

Update: the chain rules moved up to November 13, a day whose open-ladder files
were already live and being played. Chain days now get their own file name
(`2026-11-13-easy.chain.json`) instead of replacing the open one: never
overwrite a puzzle someone may already be playing. Saved games keep the old file,
new players get the chain, and the generator's "x" (create only) mode still guards both.

Update: open ladders now accept only a word that takes you one rung closer
to the goal. A player saw "grandmother = son": son is close to grandmother
(GloVe groups family words), but it kept them on the same rung, which read
as a bug. Such words now go to the Tried list as "no closer", for free.
Tradeoff: open ladders only accept words on a shortest route now, so par is
always the number of words played and only hints cost extra.

## Back to open ladders, and a staircase

On 2026-11-14 the chain ladders were retired after two days: every day, past
and future, plays as an open ladder again. Nov 13 and 14 already had open
files (written before the chain era moved up), so they simply use those.
Consistency won over keeping progress: the browser wipes saved chain games
and their results once (a storage schema bump, like the per-level move
before it), and about 1,600 lines of chain code and tests went with them. Deleting dead
code beats keeping a second game alive "just in case"; git keeps it.

The ladder became a staircase: each climbed rung is colored by its height,
from a red sliver at the start to a full green bar at the goal, and wrong
guesses show closeness only as a light-red fill, no words. Lesson from the
switch itself: the heartbeat workflow still checked for `.chain.json` files,
a reminder that a rename touches every place that names a file, including
the monitors.
