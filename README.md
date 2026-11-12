# Meaning Ladder

A daily word game: climb from a **start** word to a **goal** word, one step at a
time. Each step must be one of the previous word's 100 nearest neighbors in
meaning (GloVe word embeddings). Par is the shortest possible path.

```
ocean → wave → signal → network → computer
```

Every day has **three ladders: Easy, Medium and Hard**. Solving any of them
keeps your streak alive. Unlimited mode has the same three levels. Puzzle files
are `puzzles/YYYY-MM-DD-<level>.json`.

**Rules eras.** The rules live in `puzzle_config.json` under `rules`, one entry
per era, each with a `from` date. A date always keeps the rules it was played
under (`rules_for` in `scripts/ladder_core.py`, `rulesFor` in `js/seeded.js`):

| From | Legal steps | Easy | Medium | Hard |
|---|---|---|---|---|
| 2026-11-01 | top 100 neighbors | par 3, 19+ routes | par 3, 1-18 routes | par 4 |
| 2026-11-13 | top 25, links both ways | par 3, 3+ good first moves | par 4, 3+ good first moves | par 4, only 1-2 good first moves |

A "good first move" is one of the start's legal steps that is one step closer
to the goal (`minCloserFirstMoves` / `maxCloserFirstMoves` in a level). Par
alone mislabeled levels: an Easy with a single right first guess played harder
than most Mediums, and par 6 pairs were rare and mostly unsolvable by feel.

The graph file always stores the top 100. A tighter era just uses the first N
of each (already sorted) list, so no data file changes. New puzzle files record
their `stepLimit`; files without one are from the top-100 era.

From 2026-11-13 links work both ways (`twoWay`): a step counts if either word
is among the other's 25 closest. Playtests found the one-way top 20 too strict
(champ to dress needed "reigning" from a list of boxing words) and top 40 both
ways too short (mostly 3 steps); top 25 both ways makes champ to dress par 4.
An era may also set `minGoalInDegree`: a goal must be a legal step from at
least that many words (used while the rule was one-way top 20). Goals with few ways in tend to be
reachable only through a sense players don't expect (anchor via TV
presenters), so the generator and the seeded fallback skip them. The AI prompt
also shows each shortlisted pair's shortest route and the goal's incoming
words, so the theme and teaser describe the sense the graph actually uses.

If a step is rejected, it joins a Contexto-style **Tried** list with its rank
from the current word (under the top-25 rules, #26 was very close). Ranks up
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
  → puzzles/YYYY-MM-DD.json → commit → redeploy site

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
- Icons: [Phosphor](https://phosphoricons.com/) (bold), MIT, copied into `js/icons.js`.
- Font: [Nunito](https://github.com/googlefonts/nunito), SIL OFL 1.1, self-hosted from Fontsource.
- Blocklist: [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0).
