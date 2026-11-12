"""Build the start/goal exclusion list for one rules era.

candidates_v1.json is frozen: editing it would change the seeded puzzles of
every date already played. So a newer rules era names a small JSON file of
words to drop from that pool ("excludeCandidates" in puzzle_config.json),
and both the generator (ladder_core.ladder_view) and the browser
(js/data.js viewOf) filter the pool with it.

    python scripts/build_era_exclude.py            # write data/candidates_exclude_<era>.json
    python scripts/build_era_exclude.py --check    # exit 1 if the committed file is stale

Two sources, one category per word:
  * hand-reviewed sections of scripts/lists/candidates_exclude_<era>.txt
  * "name_neighbors": candidates whose 10 closest words are mostly names
    (scripts/lists/names_en.txt), e.g. billy -> bob, jack, jimmy, miller.
    Players who start there wander among people instead of meanings.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from wordfilters import load_wordlist

ROOT = Path(__file__).resolve().parent.parent
LISTS = ROOT / "scripts" / "lists"
ERA = "2026-11-13"
GRAPH_VERSION = 1
# A candidate is name-like when at least this many of its NAME_TOP closest
# words are names. 4 of 10 catches billy, baker, porter and hunter; 3 of 10
# would also take carpenter, dean and knight, which read fine as words.
NAME_TOP = 10
NAME_MIN = 4


def read_sections(path: Path) -> dict[str, list[str]]:
    """'## category' headers, then one word per line; '#' lines are comments."""
    sections: dict[str, list[str]] = {}
    current = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip().lower()
        if line.startswith("## "):
            current = line[3:].strip()
            sections.setdefault(current, [])
        elif line and not line.startswith("#"):
            if current is None:
                raise ValueError(f"{path.name}: '{line}' is not under a '## category' header")
            sections[current].append(line)
    return sections


def name_like(words: list[str], neighbors: list[list[int]], index: dict[str, int],
              candidates: list[str], names: set[str]) -> list[str]:
    return [c for c in candidates
            if sum(words[j] in names for j in neighbors[index[c]][:NAME_TOP]) >= NAME_MIN]


def build(root: Path = ROOT, era: str = ERA, version: int = GRAPH_VERSION) -> dict:
    graph = json.loads((root / "data" / f"graph_v{version}.json").read_text(encoding="utf-8"))
    candidates = json.loads(
        (root / "data" / f"candidates_v{version}.json").read_text(encoding="utf-8"))["words"]
    cand_set = set(candidates)
    words = graph["words"]
    index = {w: i for i, w in enumerate(words)}

    sections = read_sections(root / "scripts" / "lists" / f"candidates_exclude_{era}.txt")
    seen: dict[str, str] = {}
    for cat, ws in sections.items():
        for w in ws:
            if w not in cand_set:  # a typo here would silently exclude nothing
                raise ValueError(f"'{w}' ({cat}) is not in candidates_v{version}.json")
            if w in seen:
                raise ValueError(f"'{w}' is listed under both {seen[w]} and {cat}")
            seen[w] = cat

    names = load_wordlist(root / "scripts" / "lists" / "names_en.txt")
    auto = [w for w in name_like(words, graph["neighbors"], index, candidates, names)
            if w not in seen]  # a hand-picked category is more informative

    categories = {cat: sorted(ws) for cat, ws in sorted(sections.items())}
    categories["name_neighbors"] = sorted(auto)
    return {"from": era, "graphVersion": version,
            "source": f"scripts/lists/candidates_exclude_{era}.txt",
            "categories": categories}


def render(obj: dict) -> str:
    # One category per line: small, and a review diff shows exactly which words moved.
    cats = ",\n".join(f'    {json.dumps(k)}: {json.dumps(v)}' for k, v in obj["categories"].items())
    head = {k: v for k, v in obj.items() if k != "categories"}
    return (json.dumps(head, indent=2)[:-2] + ',\n  "categories": {\n' + cats + "\n  }\n}\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="fail if the committed file is stale")
    args = ap.parse_args()
    obj = build()
    out = ROOT / "data" / f"candidates_exclude_{ERA}.json"
    text = render(obj)
    if args.check:
        ok = out.exists() and out.read_text(encoding="utf-8") == text
        print(f"{out.relative_to(ROOT)} is {'up to date' if ok else 'STALE: rerun without --check'}")
        return 0 if ok else 1
    out.write_bytes(text.encode("utf-8"))  # bytes: LF line endings on Windows too
    total = sum(len(v) for v in obj["categories"].values())
    for cat, ws in obj["categories"].items():
        print(f"  {cat:15} {len(ws):4}")
    print(f"wrote {out.relative_to(ROOT)}: {total} words")
    return 0


if __name__ == "__main__":
    sys.exit(main())
