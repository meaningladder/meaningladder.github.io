"""Build the ConceptNet relations file: which GloVe neighbors are ALSO linked
by a labeled real-world relation (a cafe IS AT a restaurant, coal IS USED FOR fuel).

    python scripts/build_relations.py conceptnet-assertions-5.7.0.csv.gz [--version 2]
    # writes data/relations_v<N>.bin + .json (default N=1; v1 is frozen, don't rebuild it)

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
v2 ("layout": "directed") appends count x uint8 direction: 0 = ConceptNet edge
u->v, 1 = v->u, 2 = symmetric (symmetric relation, or both directions carry the
best relation).
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
SYMMETRIC = {"Synonym", "SimilarTo", "LocatedNear", "RelatedTo"}


def main(path: str, version: int = 1) -> int:
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
    seen: dict[tuple[int, int], int] = {}  # bitmask of directions carrying best[key]
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
                best[key], seen[key] = RANK[rel], 0
            if RANK[rel] == best[key]:
                seen[key] |= 1 << (a != key[0])  # bit0: u->v, bit1: v->u

    pairs = sorted(best)
    arr = np.asarray(pairs, dtype="<u2").reshape(-1, 2)
    labels = np.asarray([best[p] for p in pairs], dtype="u1")
    blob = arr.tobytes() + labels.tobytes()
    extra = {}
    if version >= 2:
        sym = [RELATIONS[best[p]] in SYMMETRIC or seen[p] == 3 for p in pairs]
        dirs = np.asarray([2 if s else seen[p] - 1 for p, s in zip(pairs, sym)], dtype="u1")
        blob += dirs.tobytes()
        extra = {"layout": "directed"}
        print("directions (u->v, v->u, symmetric):", np.bincount(dirs, minlength=3).tolist())
    (ROOT / "data" / f"relations_v{version}.bin").write_bytes(blob)
    header = {"version": version, **extra, "graphVersion": v, "count": len(pairs), "relations": RELATIONS,
              "window": WINDOW, "minWeight": MIN_WEIGHT,
              "source": "ConceptNet 5.7 assertions (https://conceptnet.io)",
              "license": "CC BY-SA 4.0", "sha256": hashlib.sha256(blob).hexdigest()}
    (ROOT / "data" / f"relations_v{version}.json").write_bytes((json.dumps(header, indent=2) + "\n").encode())
    counts = np.bincount(labels, minlength=len(RELATIONS))
    print(f"{len(pairs):,} related neighbor pairs ({len(blob) / 1e3:.0f} KB):",
          ", ".join(f"{RELATIONS[i]} {c}" for i, c in enumerate(counts) if c))
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    ver = 1
    if len(args) == 3 and args[1] == "--version":
        ver = int(args[2])
    elif len(args) != 1:
        sys.exit("usage: python scripts/build_relations.py conceptnet-assertions-5.7.0.csv.gz [--version N]")
    sys.exit(main(args[0], ver))
