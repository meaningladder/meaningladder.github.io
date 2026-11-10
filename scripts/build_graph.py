"""Build the Meaning Ladder neighbor graph (Milestone 1).

GloVe vectors -> filtered vocabulary -> top-K neighbors per word
-> data/graph_v<N>.json  (+ data/candidates_v<N>.json)

Usage:
    python scripts/build_graph.py                    # full build of v1
    python scripts/build_graph.py --candidates-only  # redo candidates after review
    python scripts/build_graph.py --out-version 2    # a new, separate data version
"""
from __future__ import annotations

import argparse
import gzip
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
from nltk.corpus import stopwords as nltk_stopwords
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from wordfilters import (
    is_concrete_noun,
    is_trivial_pair,
    is_valid_vocab_word,
    load_wordlist,
)

ROOT = Path(__file__).resolve().parent.parent
LISTS = ROOT / "scripts" / "lists"
DATA = ROOT / "data"

GLOVE_MODEL = "glove-wiki-gigaword-300"
PROBE_WORDS = ["ocean", "computer", "music", "dog", "volcano"]

# Candidate (start/goal word) rules. Tuned to land around 1,000-2,000 words.
CANDIDATE_MAX_RANK = 10_000  # only the 10k most frequent vocab words
CANDIDATE_MIN_IN_DEGREE = 10  # at least 10 words must point to it


# ---------------------------------------------------------------- vocabulary
def build_vocab(all_words: list[str], size: int) -> list[int]:
    """Walk GloVe's words in frequency order; return the GloVe row indexes of
    the first `size` words that pass the filters."""
    stop = set(nltk_stopwords.words("english"))
    block = load_wordlist(LISTS / "blocklist_en.txt")
    allow = load_wordlist(LISTS / "allowlist.txt")
    keep = []
    for i, w in enumerate(all_words):
        if is_valid_vocab_word(w, stop, block, allow):
            keep.append(i)
            if len(keep) == size:
                break
    return keep


# ---------------------------------------------------------------- neighbors
def top_neighbors(
    vectors: np.ndarray, words: list[str], k: int, batch: int, pool: int = 300
) -> list[list[int]]:
    """For each word, its k most cosine-similar words, minus trivial forms.

    Analogy: normalizing every vector to length 1 turns 'cosine similarity'
    into a plain dot product, so one matrix multiply compares a whole batch
    of words against the entire vocabulary at once.
    """
    n = len(words)
    m = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    m = m.astype(np.float32)
    result: list[list[int]] = []

    for start in range(0, n, batch):
        end = min(start + batch, n)
        sims = m[start:end] @ m.T  # (batch, n) cosine similarities
        sims[np.arange(end - start), np.arange(start, end)] = -np.inf  # no self
        # argpartition: find the `pool` best per row without fully sorting n.
        part = np.argpartition(-sims, pool, axis=1)[:, :pool]

        for r in range(end - start):
            a = start + r
            row_sims = sims[r]
            cand = part[r]
            # Sort by (-similarity, index) so ties break deterministically.
            cand = cand[np.lexsort((cand, -row_sims[cand]))]
            picked = _pick(words, a, cand, k)
            if len(picked) < k:  # rare: widen to the whole vocabulary
                full = np.lexsort((np.arange(n), -row_sims))
                picked = _pick(words, a, full, k)
            assert len(picked) == k, f"{words[a]} has only {len(picked)} neighbors"
            result.append(picked)
        print(f"  neighbors: {end:>6}/{n}", end="\r", flush=True)
    print()
    return result


def _pick(words: list[str], a: int, ordered: np.ndarray, k: int) -> list[int]:
    out = []
    for b in ordered:
        b = int(b)
        if b != a and not is_trivial_pair(words[a], words[b]):
            out.append(b)
            if len(out) == k:
                break
    return out


# ---------------------------------------------------------------- candidates
def build_candidates(words: list[str], neighbors: list[list[int]]) -> list[str]:
    in_degree = np.bincount(np.concatenate([np.array(r) for r in neighbors]),
                            minlength=len(words))
    exclude = load_wordlist(LISTS / "candidates_exclude.txt")
    out = []
    for i, w in enumerate(words[:CANDIDATE_MAX_RANK]):
        if (in_degree[i] >= CANDIDATE_MIN_IN_DEGREE
                and w not in exclude
                and is_concrete_noun(w)):
            out.append(w)
    return sorted(out)


# ---------------------------------------------------------------- report
def write_json(path: Path, obj: dict) -> None:
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    path.write_bytes(raw)
    gz = len(gzip.compress(raw, compresslevel=9))
    print(f"  wrote {path.relative_to(ROOT)}: {len(raw)/1e6:.2f} MB raw, "
          f"{gz/1e6:.2f} MB gzipped")


def report(words: list[str], neighbors: list[list[int]], candidates: list[str]) -> None:
    n = len(words)
    idx = {w: i for i, w in enumerate(words)}
    print("\nProbe neighbors (top 10):")
    for w in PROBE_WORDS:
        if w in idx:
            print(f"  {w:>9}: {', '.join(words[j] for j in neighbors[idx[w]][:10])}")

    # Reciprocity: what fraction of edges a->b also have b->a?
    src = np.repeat(np.arange(n), [len(r) for r in neighbors])
    dst = np.concatenate([np.array(r) for r in neighbors])
    fwd = src.astype(np.int64) * n + dst
    rev = dst.astype(np.int64) * n + src
    recip = np.isin(rev, fwd).mean()
    print(f"\nEdges: {len(fwd):,}. Reciprocal (b->a also exists): {recip:.1%} "
          f"-> the graph is directed!")

    # Strongly connected components: groups where everyone can reach everyone.
    g = csr_matrix((np.ones(len(fwd), dtype=np.int8), (src, dst)), shape=(n, n))
    n_comp, labels = connected_components(g, directed=True, connection="strong")
    biggest = np.bincount(labels).argmax()
    in_big = sum(labels[idx[c]] == biggest for c in candidates)
    print(f"Strongly connected components: {n_comp:,}; largest has "
          f"{(labels == biggest).sum():,} words; "
          f"{in_big}/{len(candidates)} candidates are inside it.")

    print(f"\nCandidates: {len(candidates)}. Random sample for review:")
    sample = random.Random(0).sample(candidates, min(50, len(candidates)))
    print("  " + ", ".join(sorted(sample)))


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-version", type=int, default=1)
    ap.add_argument("--vocab-size", type=int, default=20_000)
    ap.add_argument("--k", type=int, default=100)
    ap.add_argument("--batch", type=int, default=1_000)
    ap.add_argument("--candidates-only", action="store_true",
                    help="reuse the existing graph file; rebuild candidates only")
    args = ap.parse_args()

    v = args.out_version
    graph_path = DATA / f"graph_v{v}.json"
    cand_path = DATA / f"candidates_v{v}.json"
    DATA.mkdir(exist_ok=True)

    if args.candidates_only:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        words, neighbors = graph["words"], graph["neighbors"]
    else:
        if graph_path.exists():
            print(f"{graph_path.relative_to(ROOT)} already exists. Data versions are "
                  f"frozen: never rebuild in place. Use --out-version {v + 1}.")
            return 1

        t0 = time.time()
        import gensim.downloader as api  # imported here: slow, and unused for --candidates-only
        print(f"Loading {GLOVE_MODEL} (first run downloads ~376 MB)...")
        kv = api.load(GLOVE_MODEL)
        print(f"  {len(kv.index_to_key):,} words x {kv.vector_size} dims "
              f"({time.time() - t0:.0f}s)")

        rows = build_vocab(kv.index_to_key, args.vocab_size)
        words = [kv.index_to_key[i] for i in rows]
        print(f"Vocabulary: {len(words):,} words (walked down to GloVe rank "
              f"{rows[-1]:,}). Least frequent kept: {', '.join(words[-5:])}")

        neighbors = top_neighbors(kv.vectors[rows], words, args.k, args.batch)
        write_json(graph_path, {"version": v, "words": words, "neighbors": neighbors})
        print(f"  graph built in {time.time() - t0:.0f}s")

    candidates = build_candidates(words, neighbors)
    write_json(cand_path, {"version": v, "words": candidates})
    report(words, neighbors, candidates)
    return 0


if __name__ == "__main__":
    sys.exit(main())
