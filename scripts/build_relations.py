"""Build the ConceptNet relations file: which GloVe neighbors are ALSO linked
by a labeled real-world relation (a cafe IS AT a restaurant, coal IS USED FOR fuel).

    python scripts/build_relations.py conceptnet-assertions-5.7.0.csv.gz
    # writes data/relations_v1.bin + data/relations_v1.json

Why: GloVe says which words appear in similar contexts, which makes a good,
forgiving step rule but sometimes odd routes. ConceptNet has explicit
relations, but alone it routes everything through hubs (person, city, car)
and is far too sparse to be the step rule (measured: most words would have
1-2 accepted next words). So it is used only to choose and SHOW routes:
among the shortest routes, prefer the one whose steps are real relations.

Only pairs that are GloVe top-40 neighbors (either direction) are kept, since
no other pair can ever be a step. ConceptNet 5.7 is CC BY-SA 4.0
(https://conceptnet.io): this derived file carries the same license, and the
game credits it. The 500 MB assertions dump is NOT committed; download it from
https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz

Layout (little-endian): count x (u uint16, v uint16) with u < v, then
count x uint8 relation index into the header's "relations" list.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import sys

import numpy as np

from ladder_core import ROOT

WINDOW = 40  # pairs must be GloVe top-40 neighbors in either direction
MIN_WEIGHT = 1.0
# Labeled relations a player can read as a reason ("used for", "part of").
# RelatedTo is ConceptNet's catch-all; kept last so any labeled reason wins.
RELATIONS = ["IsA", "PartOf", "HasA", "UsedFor", "AtLocation", "MadeOf", "CapableOf",
             "Causes", "HasPrerequisite", "CreatedBy", "LocatedNear", "ReceivesAction",
             "HasProperty", "HasSubevent", "Desires", "MotivatedByGoal", "Synonym",
             "SimilarTo", "RelatedTo"]
RANK = {r: i for i, r in enumerate(RELATIONS)}


def main(path: str) -> int:
    config = json.loads((ROOT / "puzzle_config.json").read_text(encoding="utf-8"))
    v = config["graphVersion"]
    graph = json.loads((ROOT / "data" / f"graph_v{v}.json").read_text(encoding="utf-8"))
    words, neighbors = graph["words"], graph["neighbors"]
    index = {w: i for i, w in enumerate(words)}
    near = set()
    for u, row in enumerate(neighbors):
        for x in row[:WINDOW]:
            near.add((min(u, x), max(u, x)))

    def word(uri: str):
        parts = uri.split("/")  # /c/en/coffee[/n/...]
        return index.get(parts[3]) if len(parts) > 3 and parts[2] == "en" else None

    best: dict[tuple[int, int], int] = {}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            _, rel, start, end, meta = line.rstrip("\n").split("\t")
            rel = rel.rsplit("/", 1)[-1]
            if rel not in RANK:
                continue
            a, b = word(start), word(end)
            if a is None or b is None or a == b:
                continue
            key = (min(a, b), max(a, b))
            if key not in near or json.loads(meta).get("weight", 1.0) < MIN_WEIGHT:
                continue
            if key not in best or RANK[rel] < best[key]:
                best[key] = RANK[rel]

    pairs = sorted(best)
    arr = np.asarray(pairs, dtype="<u2").reshape(-1, 2)
    labels = np.asarray([best[p] for p in pairs], dtype="u1")
    blob = arr.tobytes() + labels.tobytes()
    (ROOT / "data" / f"relations_v{v}.bin").write_bytes(blob)
    header = {"version": 1, "graphVersion": v, "count": len(pairs), "relations": RELATIONS,
              "window": WINDOW, "minWeight": MIN_WEIGHT,
              "source": "ConceptNet 5.7 assertions (https://conceptnet.io)",
              "license": "CC BY-SA 4.0", "sha256": hashlib.sha256(blob).hexdigest()}
    (ROOT / "data" / f"relations_v{v}.json").write_bytes((json.dumps(header, indent=2) + "\n").encode())
    counts = np.bincount(labels, minlength=len(RELATIONS))
    print(f"{len(pairs):,} related neighbor pairs ({len(blob) / 1e3:.0f} KB):",
          ", ".join(f"{RELATIONS[i]} {c}" for i, c in enumerate(counts) if c))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python scripts/build_relations.py conceptnet-assertions-5.7.0.csv.gz")
    sys.exit(main(sys.argv[1]))
