"""Build compact word vectors for Contexto-style ranks of wrong guesses.

    python scripts/build_vectors.py            # writes data/vectors_v1.bin + .json

The graph only stores each word's top 100 neighbors. To say "keyboard is #143
from signal", the browser needs to compare a word against all 20k words, so it
needs vectors. Full GloVe (300 floats per word) would be ~24 MB; this keeps the
64 most informative directions (PCA) at 1 byte each: ~1.3 MB.

Ranks #1-#100 always come from the exact graph; these vectors only rank words
beyond the top 100, where small errors don't change what the player sees.
"""
from __future__ import annotations

import json
import sys
import time

import numpy as np

from ladder_core import ROOT

DIMS = 64
GLOVE_MODEL = "glove-wiki-gigaword-300"


def reduce(vectors: np.ndarray, dims: int) -> np.ndarray:
    """Unit-normalize, center, project onto the top `dims` principal
    components (SVD), then unit-normalize again so dot product = cosine."""
    x = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    x = x - x.mean(axis=0)
    # Rows of vt are the principal directions, strongest first.
    _, _, vt = np.linalg.svd(x, full_matrices=False)
    vt = vt * np.sign(vt[:, :1])  # fix each direction's sign so builds are byte-identical
    y = x @ vt[:dims].T
    return y / np.linalg.norm(y, axis=1, keepdims=True)


def quantize(y: np.ndarray) -> tuple[np.ndarray, float]:
    """One global scale so the largest component maps to +-127."""
    scale = 127.0 / float(np.abs(y).max())
    return np.round(y * scale).astype(np.int8), scale


def quality(q: np.ndarray, neighbors: list[list[int]], samples: int = 200, within: int = 150) -> float:
    """Share of each sampled word's exact top-100 neighbors that the compact
    vectors also rank within `within`."""
    rng = np.random.default_rng(0)
    qf = q.astype(np.float32)
    qf /= np.linalg.norm(qf, axis=1, keepdims=True)
    hits = total = 0
    for i in rng.choice(len(neighbors), size=samples, replace=False):
        sims = qf @ qf[i]
        sims[i] = -np.inf
        top = set(np.argpartition(-sims, within)[:within].tolist())
        hits += sum(1 for j in neighbors[i] if j in top)
        total += len(neighbors[i])
    return hits / total


def main() -> int:
    config = json.loads((ROOT / "puzzle_config.json").read_text(encoding="utf-8"))
    v = config["graphVersion"]
    graph = json.loads((ROOT / "data" / f"graph_v{v}.json").read_text(encoding="utf-8"))
    words = graph["words"]

    t0 = time.time()
    import gensim.downloader as api  # slow import; only needed here

    print(f"Loading {GLOVE_MODEL}...")
    kv = api.load(GLOVE_MODEL)
    vectors = np.stack([kv[w] for w in words]).astype(np.float64)
    print(f"  {len(words):,} words x {vectors.shape[1]} dims ({time.time() - t0:.0f}s)")

    q, scale = quantize(reduce(vectors, DIMS))
    out_bin = ROOT / "data" / f"vectors_v{v}.bin"
    out_json = ROOT / "data" / f"vectors_v{v}.json"
    out_bin.write_bytes(q.tobytes())  # row-major: word i occupies bytes [i*DIMS, (i+1)*DIMS)
    header = {"version": 1, "graphVersion": v, "count": len(words), "dims": DIMS,
              "scale": round(scale, 6), "dtype": "int8"}
    out_json.write_text(json.dumps(header, indent=2) + "\n", encoding="utf-8")
    print(f"  wrote {out_bin.relative_to(ROOT)} ({out_bin.stat().st_size / 1e6:.2f} MB) and {out_json.name}")

    share = quality(q, graph["neighbors"])
    print(f"Quality: {share:.1%} of exact top-100 neighbors rank within the compact top 150 "
          f"(70%+ expected; excluded word forms take some of those slots).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
