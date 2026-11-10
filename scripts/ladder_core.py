"""Core puzzle logic shared by the generator and the tests.

Everything here is deterministic and has no network access. `js/seeded.js`
is a line-for-line port of the seeded parts. If you change one, change both,
then run `python scripts/make_fixtures.py` and both test suites.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASK32 = 0xFFFFFFFF
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
RELAX_AFTER = 5_000  # seeded attempts before relaxing the route-count rule
GIVE_UP_AFTER = 20_000  # an impossible band (e.g. par 6) must fail loudly, not hang


# ---------------------------------------------------------------- data
@dataclass
class Ladder:
    words: list[str]
    index: dict[str, int]
    neighbors: list[list[int]]
    candidates: list[str]  # sorted; order matters for the seeded pick
    candidate_set: set[str]
    config: dict


def load_config(root: Path = ROOT) -> dict:
    return json.loads((root / "puzzle_config.json").read_text(encoding="utf-8"))


def load_ladder(root: Path = ROOT, config: dict | None = None) -> Ladder:
    config = config or load_config(root)
    v = config["graphVersion"]
    graph = json.loads((root / "data" / f"graph_v{v}.json").read_text(encoding="utf-8"))
    cands = json.loads((root / "data" / f"candidates_v{v}.json").read_text(encoding="utf-8"))
    words = graph["words"]
    return Ladder(
        words=words,
        index={w: i for i, w in enumerate(words)},
        neighbors=graph["neighbors"],
        candidates=cands["words"],
        candidate_set=set(cands["words"]),
        config=config,
    )


# ---------------------------------------------------------------- BFS
def bfs_routes(neighbors: list[list[int]], start: int, goal: int) -> tuple[int | None, int]:
    """Shortest path length from start to goal, and how many shortest routes exist.

    Level by level, like ripples spreading from a stone dropped in water.
    Every word reached in ripple d inherits the route count of each word in
    ripple d-1 that points to it. We finish the goal's whole ripple before
    stopping, so the count is complete. Returns (None, 0) if unreachable.
    """
    if start == goal:
        return 0, 1
    dist = {start: 0}
    routes = {start: 1}
    frontier = [start]
    d = 0
    while frontier:
        d += 1
        nxt = []
        for u in frontier:
            ru = routes[u]
            for v in neighbors[u]:
                dv = dist.get(v)
                if dv is None:
                    dist[v] = d
                    routes[v] = ru
                    nxt.append(v)
                elif dv == d:
                    routes[v] += ru
        if goal in dist:
            return d, routes[goal]
        frontier = nxt
    return None, 0


# ---------------------------------------------------------------- seeded randomness
def fnv1a32(text: str) -> int:
    """32-bit FNV-1a hash of the UTF-8 bytes of `text`."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & MASK32  # JS: Math.imul(h, 0x01000193) >>> 0
    return h


def _imul(a: int, b: int) -> int:
    """JS Math.imul on unsigned 32-bit inputs: multiply, keep the low 32 bits."""
    return (a * b) & MASK32


def mulberry32(seed: int):
    """Tiny seeded PRNG. Returns a function giving floats in [0, 1).

    Python ints never overflow, so every step masks to 32 bits by hand to
    reproduce JavaScript's 32-bit integer behaviour exactly.
    """
    state = seed & MASK32

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & MASK32
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t = t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & MASK32)
        return ((t ^ (t >> 14)) & MASK32) / 4294967296

    return next_float


def seeded_sample(items: list[str], k: int, seed_text: str) -> list[str]:
    """k items chosen by a partial Fisher-Yates shuffle (deterministic)."""
    rand = mulberry32(fnv1a32(seed_text))
    arr = list(items)
    k = min(k, len(arr))
    for i in range(k):
        j = i + math.floor(rand() * (len(arr) - i))
        arr[i], arr[j] = arr[j], arr[i]
    return arr[:k]


# ---------------------------------------------------------------- dates
def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def game_number(day: date, launch: date) -> int:
    """Days since launch + 1. Python `date` math is exact (no clock times),
    so DST can't bite here. The JS port must round (pitfall #5)."""
    n = (day - launch).days + 1
    if n < 1:
        raise ValueError(f"{day} is before the launch date {launch}")
    return n


def band_for(day: date, config: dict) -> dict:
    """Today's difficulty band, e.g. {"label": "easy", "par": 3, "minRoutes": 40, ...}."""
    band = dict(config["bands"][WEEKDAYS[day.weekday()]])
    band["weekday"] = WEEKDAYS[day.weekday()]
    return band


# ---------------------------------------------------------------- validation
@dataclass
class Verdict:
    ok: bool
    reason: str
    par: int | None = None
    routes: int = 0


def validate_pair(
    ladder: Ladder,
    start: str,
    goal: str,
    band: dict | None = None,
    recent: set[str] = frozenset(),
    check_routes: bool = True,
) -> Verdict:
    """Is start -> goal an acceptable puzzle? Cheap checks first, BFS last."""
    cfg = ladder.config
    for w in (start, goal):
        if w not in ladder.index:
            return Verdict(False, f"'{w}' is not in the word graph")
        if w not in ladder.candidate_set:
            return Verdict(False, f"'{w}' is not an allowed start/goal word")
        if w in recent:
            return Verdict(False, f"'{w}' was used in a recent puzzle")
    if start == goal:
        return Verdict(False, "start and goal are the same word")

    par, routes = bfs_routes(ladder.neighbors, ladder.index[start], ladder.index[goal])
    if par is None:
        return Verdict(False, f"no path from {start} to {goal}")
    if not cfg["minPar"] <= par <= cfg["maxPar"]:
        return Verdict(False, f"par {par} is outside {cfg['minPar']}-{cfg['maxPar']}",
                       par, routes)
    if band:
        if par != band["par"]:
            return Verdict(False, f"par {par}, today needs par {band['par']}", par, routes)
        if check_routes and not band["minRoutes"] <= routes <= band["maxRoutes"]:
            return Verdict(False, f"{routes} shortest routes, today needs "
                                  f"{band['minRoutes']}-{band['maxRoutes']}", par, routes)
    return Verdict(True, "ok", par, routes)


def seeded_puzzle(ladder: Ladder, date_str: str, band: dict) -> tuple[str, str, Verdict, int]:
    """Deterministic fallback: same date -> same puzzle, in Python and in JS.

    Try attempt 0, 1, 2...: hash "YYYY-MM-DD#attempt", seed the PRNG with it,
    roll a start and a goal, keep the first pair that fits today's band.
    """
    cands = ladder.candidates
    n = len(cands)
    attempt = 0
    while True:
        rand = mulberry32(fnv1a32(f"{date_str}#{attempt}"))
        start = cands[math.floor(rand() * n)]
        goal = cands[math.floor(rand() * n)]
        verdict = validate_pair(ladder, start, goal, band,
                                check_routes=attempt < RELAX_AFTER)
        if verdict.ok:
            return start, goal, verdict, attempt
        attempt += 1
        if attempt >= GIVE_UP_AFTER:
            raise RuntimeError(f"no seeded puzzle for {date_str} in {attempt} attempts; "
                               f"is the band {band} achievable?")
