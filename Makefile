# Meaning Ladder: one command for each thing we used to type by hand.
#
#   make            list every target
#   make check      what CI runs: tests + design/security audits
#
# Windows: run from Git Bash (or a VS Code terminal set to Git Bash).
# Override any variable on the command line, e.g. `make test PY=python`.

ifeq ($(OS),Windows_NT)
  VENV_BIN   := .venv/Scripts
  PYTHON_SYS ?= python
else
  VENV_BIN   := .venv/bin
  PYTHON_SYS ?= python3
endif

PY    ?= $(VENV_BIN)/python
GH    ?= $(shell command -v gh 2>/dev/null || echo '"/c/Program Files/GitHub CLI/gh.exe"')
REPO  ?= NKGuillaume/meaning-ladder
PORT  ?= 8000
DATE  ?=
NOAI  ?=
UI_FILES := index.html style.css js/game.js js/data.js js/seeded.js js/icons.js

.DEFAULT_GOAL := help
.PHONY: help setup test test-py test-js check audit graph candidates fixtures \
        serve preview puzzles cloud-dry-run cloud-status secret-check redeploy clean

help: ## List all targets
	@echo "Meaning Ladder targets:"
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  %-15s %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup
setup: ## Create .venv, install dependencies, download WordNet data
	$(PYTHON_SYS) -m venv .venv
	@# No `pip install --upgrade pip`: on Windows it can break pip mid-upgrade.
	$(PY) -m pip install --disable-pip-version-check -r requirements.txt
	$(PY) -m nltk.downloader -q wordnet omw-1.4 stopwords

# ---------------------------------------------------------------- tests & audits
test: test-py test-js ## Run both test suites

test-py: ## Python tests (word filters, graph, BFS, generator, AI text checks)
	$(PY) -m pytest -q

test-js: ## JavaScript tests (game rules + Python/JS seeded parity)
	node --test "tests/js/*.test.mjs"

check: audit test ## Everything CI checks

audit: ## Design + security audits (dashes, CSP, pinned actions, leaked keys)
	@if grep -n -e '—' -e '–' $(UI_FILES); then \
	  echo "FAIL: dash characters in UI files (design rule)"; exit 1; \
	else echo "ok   no em/en dashes in UI files"; fi
	@grep -q 'Content-Security-Policy' index.html \
	  && echo "ok   Content-Security-Policy present" \
	  || { echo "FAIL: Content-Security-Policy missing from index.html"; exit 1; }
	@if grep -nE 'uses: [^ ]+@v[0-9]' .github/workflows/*.yml; then \
	  echo "FAIL: actions referenced by tag, pin them to commit SHAs"; exit 1; \
	else echo "ok   all GitHub Actions pinned to commit SHAs"; fi
	@if git grep -nIE 'sk-[A-Za-z0-9_-]{20,}' -- . ':!Makefile'; then \
	  echo "FAIL: something that looks like an API key is committed"; exit 1; \
	else echo "ok   no API-key-like strings in tracked files"; fi
	@if grep -n 'fonts.googleapis' index.html; then \
	  echo "FAIL: third-party font request (self-host fonts instead)"; exit 1; \
	else echo "ok   no third-party font requests"; fi

# ---------------------------------------------------------------- data
graph: ## Build a NEW graph version: make graph VERSION=2 (v1 is frozen)
	@test -n "$(VERSION)" || { echo "usage: make graph VERSION=2   (existing versions are never rebuilt)"; exit 1; }
	$(PY) scripts/build_graph.py --out-version $(VERSION)

candidates: ## Rebuild start/goal words after editing scripts/lists/candidates_exclude.txt
	$(PY) scripts/build_graph.py --candidates-only
	$(PY) scripts/make_fixtures.py
	@echo "Seeded puzzles changed: review, then commit data/ and tests/fixtures/ together."

fixtures: ## Regenerate the Python->JS golden values (tests/fixtures/seeded_vectors.json)
	$(PY) scripts/make_fixtures.py

# ---------------------------------------------------------------- play & puzzles
serve: ## Play locally at http://localhost:8000 (append ?today=YYYY-MM-DD to time-travel)
	@echo "Open http://localhost:$(PORT)   (Ctrl+C to stop)"
	$(PY) -m http.server $(PORT) --bind 127.0.0.1

preview: ## Preview one puzzle, saves nothing: make preview DATE=2026-11-16 [NOAI=1]
	@test -n "$(DATE)" || { echo "usage: make preview DATE=YYYY-MM-DD [NOAI=1]"; exit 1; }
	$(PY) scripts/generate_puzzle.py --date $(DATE) --dry-run $(if $(NOAI),--no-ai)

puzzles: ## Generate and SAVE today..today+3 locally (what the daily job does)
	$(PY) scripts/generate_puzzle.py --ahead 3

# ---------------------------------------------------------------- GitHub
cloud-dry-run: ## Run the daily job on GitHub without saving: make cloud-dry-run DATE=2026-11-16 [NOAI=1]
	@test -n "$(DATE)" || { echo "usage: make cloud-dry-run DATE=YYYY-MM-DD [NOAI=1]"; exit 1; }
	$(GH) workflow run daily-puzzle.yml -R $(REPO) -f date=$(DATE) -f dry_run=true $(if $(NOAI),-f no_ai=true)
	@echo "Started. Follow it with: make cloud-status"

cloud-status: ## Latest workflow runs on GitHub
	$(GH) run list -R $(REPO) --limit 8

secret-check: ## Confirm the OPENAI_API_KEY secret exists (shows names only, never values)
	$(GH) secret list -R $(REPO)

redeploy: ## Re-publish the site to GitHub Pages
	$(GH) workflow run pages.yml -R $(REPO)

# ---------------------------------------------------------------- housekeeping
clean: ## Delete Python caches (never touches data/ or puzzles/)
	rm -rf .pytest_cache
	find . -name __pycache__ -not -path './.venv/*' -prune -exec rm -rf {} +
