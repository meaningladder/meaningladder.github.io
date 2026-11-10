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
The browser never does any machine learning. It downloads 4.7 MB of integers and
does graph search, which is fast and cheap and works on a static host with no server.

---

## How the parts talk to each other

Think of it as three people who never meet but share a notebook:

1. **The cartographer** (`scripts/build_graph.py`) drew the map once, and the
   map is never redrawn in place. If it changes, it becomes `graph_v2.json`.
2. **The puzzle editor** (`scripts/generate_puzzle.py`, run by GitHub Actions
   every day at 00:17 UTC) asks OpenAI for a fun pair, then fact-checks it
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
- **Motion with a reason.** Exactly three animations, each one justified:
  a short shake when a word is rejected (feedback), the win card rising in
  (a state change), the new bar sliding in (where your eye should go).
  All of them switch off under `prefers-reduced-motion`.
- **Copy bugs.** "A expert one." (the practice teaser) and dash characters
  used as placeholders ("Not played" and "no route" now say what they mean).

The lesson: "functionally correct" and "finished" are different milestones.
A checklist written by someone else finds the stuff you've stopped seeing.

---

## Your to-do list before launch (Monday 2026-11-16)

1. **Add the API key secret.** Run `gh secret set OPENAI_API_KEY -R NKGuillaume/meaning-ladder`
   and paste the key when asked. Do this **before 2026-11-13 00:17 UTC**, when the
   job first generates the Nov 16 puzzle (today + 3). Without it you'll get
   seeded puzzles (valid, but no themes).
2. **Try the AI once locally:** `python scripts/generate_puzzle.py --date 2026-11-16 --dry-run`
   with `$env:OPENAI_API_KEY` set. If the themes or teasers feel off, tune
   the prompt in `scripts/ai_suggest.py`.
3. **Skim the candidate words** (`data/candidates_v1.json`) and add any dull or
   awkward ones to `scripts/lists/candidates_exclude.txt`. Rebuild with
   `--candidates-only`, regenerate the fixture, commit. After launch,
   this list is frozen.

Live site: https://nkguillaume.github.io/meaning-ladder/
