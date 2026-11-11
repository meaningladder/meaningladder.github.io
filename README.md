# Meaning Ladder

A daily word game: climb from a **start** word to a **goal** word, one step at a
time. Each step must be one of the previous word's 100 nearest neighbors in
meaning (GloVe word embeddings). Par is the shortest possible path.

```
ocean → wave → signal → network → computer
```

Every day has **three ladders: Easy, Medium and Hard** (Easy: 3 steps with
19+ shortest routes; Medium: 3 steps with 1-18; Hard: 4 steps). Solving any
of them keeps your streak alive. Unlimited mode has the same three levels.
Puzzle files are `puzzles/YYYY-MM-DD-<level>.json`.

If a step is rejected, the game says how close the guess really was: **Close!**
(2 steps from your current word), **Warm.** (3 steps), **Far.**, or **So close:**
when the link only exists in the other direction. It never names the bridging
word, so it's free feedback, not a hint.

## How it fits together

```
ONE TIME (offline, scripts/build_graph.py)
  GloVe 300d → filtered 20k vocabulary → top-100 neighbors (directed graph)
  → data/graph_v1.json, data/candidates_v1.json            (frozen, versioned)

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
| Edit start/goal words | edit `scripts/lists/candidates_exclude.txt`, then `python scripts/build_graph.py --candidates-only` and `python scripts/make_fixtures.py` |
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

## Credits

- Word vectors: [GloVe](https://nlp.stanford.edu/projects/glove/) (Wikipedia + Gigaword, 300d), via gensim.
- Dictionary checks: [WordNet](https://wordnet.princeton.edu/) via NLTK.
- Icons: [Phosphor](https://phosphoricons.com/) (bold), MIT, copied into `js/icons.js`.
- Font: [Nunito](https://github.com/googlefonts/nunito), SIL OFL 1.1, self-hosted from Fontsource.
- Blocklist: [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0).
