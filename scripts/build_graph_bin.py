"""Split the word graph into the compact files the browser loads.

    python scripts/build_graph_bin.py        # writes data/graph_vN_wide{_head,_tail}.bin + graph_vN_wide.json

graph_vN.json stays the source of truth (Python and the tests read it). This
is the SAME data in a lighter shape for phones, not a new graph version:

  graph_vN_wide.json      the word list and the layout below (~85 KB gzipped)
  graph_vN_wide_head.bin  each word's first HEAD neighbors  (n x HEAD uint16, little-endian)
  graph_vN_wide_tail.bin  neighbors HEAD+1..100             (n x (100-HEAD) uint16)

Neighbor lists are sorted by similarity, so the head IS each word's top 40,
which is all today's rules (top 40, links both ways) need: the two-way lists
are built from the top 40 of every word. The browser loads the head first
(~1.6 MB) and fetches the tail only for top-100-era archive games and exact
#41-#100 ranks in the Tried list.
"""
from __future__ import annotations

import json
import sys

import numpy as np

from ladder_core import ROOT

HEAD = 40  # = the newest era's stepLimit; a later era with a bigger limit just waits for the tail
# The files carry a new name whenever HEAD changes: the service worker caches
# data files forever by name, so new contents under an old name would mix.
NAME = "wide"


def split(neighbors: list[list[int]], head: int = HEAD) -> tuple[bytes, bytes]:
    a = np.asarray(neighbors, dtype="<u2")  # 20k words < 65,536, so 2 bytes per index
    return a[:, :head].tobytes(), a[:, head:].tobytes()


def main() -> int:
    config = json.loads((ROOT / "puzzle_config.json").read_text(encoding="utf-8"))
    v = config["graphVersion"]
    graph = json.loads((ROOT / "data" / f"graph_v{v}.json").read_text(encoding="utf-8"))
    words, neighbors = graph["words"], graph["neighbors"]
    width = len(neighbors[0])
    assert len(words) < 65_536 and all(len(r) == width for r in neighbors)

    head, tail = split(neighbors)
    data = ROOT / "data"
    (data / f"graph_v{v}_{NAME}_head.bin").write_bytes(head)
    (data / f"graph_v{v}_{NAME}_tail.bin").write_bytes(tail)
    header = {"version": 1, "graphVersion": v, "count": len(words), "head": HEAD,
              "tail": width - HEAD, "dtype": "uint16le", "words": words}
    (data / f"graph_v{v}_{NAME}.json").write_bytes((json.dumps(header, separators=(",", ":")) + "\n").encode())
    print(f"head {len(head) / 1e6:.2f} MB, tail {len(tail) / 1e6:.2f} MB, {len(words):,} words")
    return 0


if __name__ == "__main__":
    sys.exit(main())
