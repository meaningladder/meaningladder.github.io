# Meaning Ladder

A daily word game: climb from a **start** word to a **goal** word, one step at a
time. Each step must be one of the previous word's 100 nearest neighbors in
meaning (GloVe word embeddings). Par is the shortest possible path.

```
ocean → wave → signal → network → computer
```

Every day has **three ladders: Easy, Medium and Hard**. Solving any of them
keeps your streak alive. Unlimited mode has the same three levels. Puzzle files
are `puzzles/YYYY-MM-DD-<level>.json` for open-ladder days and
`puzzles/YYYY-MM-DD-<level>.chain.json` for chain days (from 2026-11-13;
`puzzle_filename` in `scripts/generate_puzzle.py`, `puzzleFile` in
`js/seeded.js`). The separate name means a day whose rules change after its
file was written gets a new file instead of overwriting one players may
already be on: 2026-11-13 and 14 keep their open `.json` files for saved games,
and everyone else gets that day's chain.

**Rules eras.** The rules live in `puzzle_config.json` under `rules`, one entry
per era, each with a `from` date. A date always keeps the rules it was played
under (`rules_for` in `scripts/ladder_core.py`, `rulesFor` in `js/seeded.js`):

| From | Legal steps | Easy | Medium | Hard |
|---|---|---|---|---|
| 2026-11-01 | top 100 neighbors | par 3, 19+ routes | par 3, 1-18 routes | par 4 |
| 2026-11-13 | **chain**: one answer per rung | 5 steps, links in each other's top 10, all everyday | 5 steps, top 20, 1-2 lateral links | 5 steps, top 40, 2-3 lateral links |

A top-10 two-way open era (par 4/5/6) was planned for 2026-11-13 and its
files for Nov 13 and 14 were written, but the chain era moved up to Nov 13
before it was played much. Its era was removed from the config; the chain era
keeps `stepLimit` 10 and `twoWay`, so an open game saved on those days (and
rebuilt by `ladderFor` from the date's era plus the file's own `stepLimit` and
`twoWay`) still has exactly the same legal steps.

**Chain ladders (from 2026-11-13, `"mode": "chain"`).** Every ladder is one
fixed chain of 6 words (`route` in the puzzle file). The start and goal are
shown; each of the 4 hidden words shows only its first letter and length, and
only that word counts. Solving a rung shows why it links (`reasons`); a hint
gives the AI's clue (`clues`), then the word. Difficulty is how obvious the
links are, not how long the ladder is: the AI labels each link `everyday` or
`lateral` (a second meaning, a set phrase, a cultural link), and the code
checks the label counts per level and that none of the previous word's 5
closest words also fits a hidden rung's pattern (`uniqueWindow`;
`validate_chain` in `scripts/ladder_core.py`). GloVe ranks measure similar
meaning, not association (coffee -> cup scores as unrelated), so only
automatic chains are held to `maxRank` and `maxWordIndex`. Medals allow wrong guesses (`medalSlack`: gold up to
2 moves over the 4 hidden words). Without the AI, `seeded_chain` (and
`seededChain` in the browser, for missing files and Unlimited) builds a chain
from common start/goal-pool words with reasons from ConceptNet relations.

A "related step" is a step that ConceptNet also links with a real relation
(cafe IS A restaurant, coal IS USED FOR fuel; `data/relations_v1.*`, built by
`make relations`). Relations never decide whether a typed word counts on an
open ladder: they choose the route the game shows (hints, give-up),
always a shortest one, so par is unchanged. Chains use them for Easy (2+
related steps) and for seeded reasons. ConceptNet alone was measured too
hub-heavy (everything via person, city, car) and too sparse to be the rule.

A "good first move" is one of the start's legal steps that is one step closer
to the goal (`minCloserFirstMoves` / `maxCloserFirstMoves` in a level). Par
alone mislabeled levels: an Easy with a single right first guess played harder
than most Mediums, and par 6 pairs were rare and mostly unsolvable by feel.

The graph file always stores the top 100. A tighter era just uses the first N
of each (already sorted) list, so no data file changes. New puzzle files record
their `stepLimit`; files without one are from the top-100 era.

The top-10 two-way open rules (`twoWay`, planned for 2026-11-13, see above): a
step counts if either word is among the other's 10 closest. Playtests found the one-way top 20 too strict
(champ to dress needed "reigning" from a list of boxing words) and top 40 both
ways too short (mostly 3 steps); top 25 and top 15 were still asked to be
longer. Top 10 both ways makes most ladders 4-6 steps (champ to dress is par 5).
An era may also set `minGoalInDegree`: a goal must be a legal step from at
least that many words (used while the rule was one-way top 20). Goals with few ways in tend to be
reachable only through a sense players don't expect (anchor via TV
presenters), so the generator and the seeded fallback skip them. The AI prompt
also shows each shortlisted pair's shortest route and the goal's incoming
words, so the theme and teaser describe the sense the graph actually uses.

If a step is rejected, it joins a Contexto-style **Tried** list with its rank
from the current word (under the top-10 rules, #11 was very close). Ranks up
to #100 are exact, from the graph. Ranks beyond 100 come from compact 64-d word vectors (`data/vectors_v1.bin`,
1.3 MB, built by `make vectors`), loaded only after the first wrong guess. It's
free feedback: it never names the right word.

## How it fits together

```
ONE TIME (offline, scripts/build_graph.py)
  GloVe 300d → filtered 20k vocabulary → top-100 neighbors (directed graph)
  → data/graph_v1.json, data/candidates_v1.json            (frozen, versioned)
  → scripts/build_graph_bin.py (make graph-bin): the same graph split for the browser
    graph_v1_wide.json + graph_v1_wide_head.bin (top 40, ~1.6 MB) + graph_v1_wide_tail.bin
    (ranks 41-100, ~2.4 MB, loaded only for top-100-era games and exact Tried ranks)

BROWSER (static, GitHub Pages)
  sw.js caches the frozen data files and keeps a copy of the app for offline play;
  code, config and puzzles are always fetched fresh first, so a deploy shows at once.
  .github/workflows/heartbeat.yml checks at 09:37 UTC that tomorrow's three puzzles are live.

DAILY (GitHub Actions, .github/workflows/daily-puzzle.yml, 06:17 + 08:47 UTC)
  scripts/generate_puzzle.py --ahead 1   (tomorrow, just before it starts in UTC+14)
    OpenAI suggests start/goal + theme + teaser → BFS validates against the graph
    → retry with feedback → seeded fallback if anything fails
  → puzzles/YYYY-MM-DD-<level>[.chain].json → commit → redeploy site

IN THE BROWSER (index.html, style.css, js/)
  load graph + today's puzzle (or compute the identical seeded fallback)
  → reverse BFS from the goal gives every word's steps-to-goal
```

## Shortcuts (Makefile)

Run `make` to list everything. The ones you'll use most:

| Command | What it does |
|---|---|
| `make setup` | Create `.venv`, install dependencies, download WordNet data |
| `make check` | Design/security audits + all tests (exactly what CI runs) |
| `make serve` | Play locally at http://localhost:8000 |
| `make preview DATE=2026-11-16` | Preview an AI puzzle without saving (`NOAI=1` for the free seeded one) |
| `make candidates` | Rebuild start/goal words after editing the exclude list |
| `make cloud-dry-run DATE=...` | Run the daily GitHub job without saving anything |
| `make secret-check` | Confirm the OpenAI key secret exists (names only) |

On Windows, run `make` from Git Bash. Install it once with
`winget install ezwinports.make`.

## Run it locally

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m nltk.downloader wordnet omw-1.4 stopwords

python -m http.server 8000        # then open http://localhost:8000
                                  # add ?today=2026-11-20 to pretend it's another day
```

## Tests

```powershell
pytest -q                          # Python: word filters, graph, BFS, generator
node --test "tests/js/*.test.mjs"  # JS: game rules + Python/JS seeded parity
```

## Common tasks

| Task | Command |
|---|---|
| Preview a puzzle without writing it | `python scripts/generate_puzzle.py --date 2026-11-20 --dry-run` |
| Same, without calling OpenAI | add `--no-ai` |
| Generate today + tomorrow | `python scripts/generate_puzzle.py --ahead 1` |
| Drop start/goal words (current era) | edit `scripts/lists/candidates_exclude_2026-11-13.txt` (only before that era is played), then `make era-exclude` |
| Run the daily job now | GitHub → Actions → Daily puzzle → Run workflow |

## Secrets

The daily job reads `OPENAI_API_KEY` from the repository's Actions secrets
(Settings → Secrets and variables → Actions). It never appears in code or in
the browser. Without it, puzzles fall back to the deterministic seeded pick and
the run shows a warning.

## Data versioning

`graph_v1.json` and `candidates_v1.json` are frozen once puzzles are live:
seeded puzzles (and the browser fallback) depend on their exact contents.
Changes go into new `_v2` files plus a `graphVersion` bump in
`puzzle_config.json`.

A rules era can still shrink the start/goal pool without touching v1: its
`excludeCandidates` names a generated file (`data/candidates_exclude_<era>.json`,
built by `scripts/build_era_exclude.py` from a hand-reviewed list plus an
automatic "neighbors are mostly names" rule). Python and the browser both
filter the pool with it, so the seeded fallback stays identical. Once an era
has been played its file is frozen too; later fixes need a new era.

## Credits

- Word vectors: [GloVe](https://nlp.stanford.edu/projects/glove/) (Wikipedia + Gigaword, 300d), via gensim.
- Dictionary checks: [WordNet](https://wordnet.princeton.edu/) via NLTK.
- Word relations: [ConceptNet 5.7](https://conceptnet.io), CC BY-SA 4.0. `data/relations_v1.*` is
  derived from it and shared under the same license; the game credits it on the home screen.
- Icons: [Phosphor](https://phosphoricons.com/) (bold), MIT, copied into `js/icons.js`.
- Font: [Nunito](https://github.com/googlefonts/nunito), SIL OFL 1.1, self-hosted from Fontsource.
- Blocklist: [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0).
