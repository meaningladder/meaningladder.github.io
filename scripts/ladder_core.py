"""Core puzzle logic shared by the generator and the tests.

Everything here is deterministic and has no network access. `js/seeded.js`
is a line-for-line port of the seeded parts. If you change one, change both,
then run `python scripts/make_fixtures.py` and both test suites.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASK32 = 0xFFFFFFFF
LEVELS = ("easy", "medium", "hard")  # every day has one puzzle per level
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
    config: dict  # the rules for one date (see rules_for), not the raw file
    # The full top-100 lists and the raw puzzle_config.json. `neighbors` above
    # is the legal-step view: each list cut to the rules' stepLimit.
    full_neighbors: list[list[int]] | None = None
    base_config: dict | None = None
    in_degree: list[int] | None = None
    # The whole candidates_vN.json list, and each era's "excludeCandidates"
    # file (path -> words). `candidates` above is the pool after the current
    # era's exclusions; the v1 file itself is frozen, so eras filter it.
    all_candidates: list[str] | None = None
    exclusions: dict[str, frozenset[str]] | None = None

    def at(self, date_str: str | None) -> "Ladder":
        """This ladder under the rules for `date_str` (None = the newest rules)."""
        return ladder_view(self, rules_for(self.base_config, date_str))


def load_config(root: Path = ROOT) -> dict:
    return json.loads((root / "puzzle_config.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- rules eras
DEFAULT_STEP_LIMIT = 100  # puzzles made before "stepLimit" existed allowed the top 100


def rules_for(config: dict, date_str: str | None) -> dict:
    """The config with one era of `config["rules"]` merged in: the newest era
    whose "from" <= date_str (None = the newest era). An era holds stepLimit,
    minPar, maxPar and levels, so older dates keep the rules they were played
    under. JS twin: rulesFor in js/seeded.js."""
    eras = config.get("rules")
    if not eras:  # hand-made test configs
        return config
    era = eras[-1] if date_str is None else next(
        (e for e in reversed(eras) if e["from"] <= date_str), eras[0])
    merged = {k: v for k, v in config.items() if k != "rules"}
    merged.update(era)
    return merged


def excluded_words(exclude_file: dict) -> set[str]:
    """Every word in an exclusion file (data/candidates_exclude_<era>.json),
    whatever its category. JS twin: excludedWords in js/seeded.js."""
    return {w for words in exclude_file["categories"].values() for w in words}


def candidate_pool(candidates: list[str], excluded) -> list[str]:
    """The start/goal pool for an era: candidates minus its exclusions, in the
    original sorted order (the seeded pick indexes into it). JS: candidatePool."""
    return [w for w in candidates if w not in excluded]


def ladder_view(ladder: Ladder, rules: dict) -> Ladder:
    """Same words, but each neighbor list cut to rules["stepLimit"]. The lists
    are sorted by similarity, so the first 20 ARE the top 20: no new data file.
    The start/goal pool drops the era's "excludeCandidates" words, if any."""
    full = ladder.full_neighbors or ladder.neighbors
    k = rules.get("stepLimit", DEFAULT_STEP_LIMIT)
    legal = two_way_neighbors(full, k) if rules.get("twoWay") else [row[:k] for row in full]
    view = replace(ladder, neighbors=legal, full_neighbors=full,
                   config=rules, in_degree=None)  # new lists, so recount on demand
    if ladder.all_candidates is None:  # hand-made test ladders: pool as given
        return view
    path = rules.get("excludeCandidates")
    pool = candidate_pool(ladder.all_candidates, ladder.exclusions[path]) if path \
        else ladder.all_candidates
    return replace(view, candidates=pool, candidate_set=set(pool))


def two_way_neighbors(full: list[list[int]], k: int) -> list[list[int]]:
    """Legal steps when links work both ways: a word's own top k (most
    similar first), then every word that has it in ITS top k, ordered by the
    rank that word gives it, then by index. Playtesters were rejected for
    natural steps that only ran one way (champ -> reigning). The graph is then
    undirected. JS twin: twoWayNeighbors in js/seeded.js (same order)."""
    extra: list[list[tuple[int, int]]] = [[] for _ in full]
    for u, row in enumerate(full):
        for r, v in enumerate(row[:k]):
            extra[v].append((r, u))
    out = []
    for v, row in enumerate(full):
        own = list(row[:k])
        seen = set(own)
        for _, u in sorted(extra[v]):
            if u not in seen:
                seen.add(u)
                own.append(u)
        out.append(own)
    return out


def closer_first_moves(neighbors: list[list[int]], start: int, goal: int, par: int) -> int:
    """How many of the start's legal steps are one step nearer the goal, for an
    UNDIRECTED graph (two-way eras): one BFS from the goal, depth par - 1.
    Two-way lists can hold more than 31 words, which the bit masks in
    bfs_route_stats can't track in JS. JS twin: closerFirstMoves."""
    if par < 1:
        return 0
    dist = {goal: 0}
    frontier = [goal]
    for d in range(1, par):
        nxt = []
        for u in frontier:
            for v in neighbors[u]:
                if v not in dist:
                    dist[v] = d
                    nxt.append(v)
        frontier = nxt
    return sum(1 for v in neighbors[start] if dist.get(v) == par - 1)


def load_exclusions(root: Path, config: dict) -> dict[str, frozenset[str]]:
    """Every exclusion file any era names, keyed by its path in the config."""
    paths = {e["excludeCandidates"] for e in config.get("rules", []) if e.get("excludeCandidates")}
    return {p: frozenset(excluded_words(json.loads((root / p).read_text(encoding="utf-8"))))
            for p in sorted(paths)}


def in_degrees(ladder: Ladder) -> list[int]:
    """For every word, how many words have it among their legal steps.

    A goal with few incoming links is only reachable through a handful of
    words, often all from one unexpected sense (anchor via presenter and
    newscast, butterfly via swim strokes), which makes an unfair puzzle.
    Counted once per view and cached, since validate_pair runs thousands of
    times per seeded puzzle. JS twin: inDegrees in js/seeded.js."""
    if ladder.in_degree is None:
        deg = [0] * len(ladder.neighbors)
        for row in ladder.neighbors:
            for v in row:
                deg[v] += 1
        ladder.in_degree = deg
    return ladder.in_degree


def load_ladder(root: Path = ROOT, config: dict | None = None,
                date_str: str | None = None) -> Ladder:
    """The word graph under the rules for `date_str` (None = the newest rules)."""
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
        base_config=config,
        all_candidates=cands["words"],
        exclusions=load_exclusions(root, config),
    ).at(date_str)


# ---------------------------------------------------------------- BFS
def bfs_routes(neighbors: list[list[int]], start: int, goal: int) -> tuple[int | None, int]:
    """Shortest path length from start to goal, and how many shortest routes exist.
    Returns (None, 0) if unreachable. See bfs_route_stats for how it works."""
    return bfs_route_stats(neighbors, start, goal)[:2]


MAX_TRACKED_FIRST_MOVES = 31  # JS bit masks are 32-bit ints; see bfs_route_stats


def bfs_route_stats(neighbors: list[list[int]], start: int,
                    goal: int) -> tuple[int | None, int, int]:
    """(par, shortest-route count, closer first moves) for start -> goal.

    Level by level, like ripples spreading from a stone dropped in water.
    Every word reached in ripple d inherits the route count of each word in
    ripple d-1 that points to it. We finish the goal's whole ripple before
    stopping, so the count is complete. Returns (None, 0, 0) if unreachable.

    "Closer first moves" = how many of the start's legal steps are one step
    nearer the goal (begin some shortest route). One full-par route hidden
    behind a single right first guess is what made "Easy" feel hard, so the
    level bands can ask for a minimum. It rides along the same BFS: each of
    the start's neighbors gets a bit, and every word inherits the bits of the
    words in the previous ripple that point to it, just like route counts.
    The goal's bits are exactly the first moves that begin a shortest route.
    JS twin: bfsRouteStats in js/seeded.js (32-bit masks, hence the cap).
    """
    if start == goal:
        return 0, 1, 0
    dist = {start: 0}
    routes = {start: 1}
    moves = {start: 0}
    frontier = []
    d = 1
    for i, v in enumerate(neighbors[start]):  # ripple 1: each first move gets its own bit
        bit = 1 << i if i < MAX_TRACKED_FIRST_MOVES else 0
        dv = dist.get(v)
        if dv is None:
            dist[v], routes[v], moves[v] = 1, 1, bit
            frontier.append(v)
        elif dv == 1:
            routes[v] += 1
            moves[v] |= bit
    while True:
        if goal in dist:
            return d, routes[goal], moves[goal].bit_count()
        if not frontier:
            return None, 0, 0
        d += 1
        nxt = []
        for u in frontier:
            ru, mu = routes[u], moves[u]
            for v in neighbors[u]:
                dv = dist.get(v)
                if dv is None:
                    dist[v] = d
                    routes[v] = ru
                    moves[v] = mu
                    nxt.append(v)
                elif dv == d:
                    routes[v] += ru
                    moves[v] |= mu
        frontier = nxt


def bfs_all(neighbors: list[list[int]], start: int) -> tuple[list[int], list[int], list[int]]:
    """Distance, shortest-route count and closer first moves from `start` to
    EVERY word (-1 / 0 / 0 = unreachable).

    Same ripple idea as bfs_route_stats, but it never stops early. One call
    answers "how far is every possible goal?" for this start word. Python
    only (the shortlist), so the first-move masks need no 32-bit cap here.
    """
    n = len(neighbors)
    dist = [-1] * n
    routes = [0] * n
    moves = [0] * n
    dist[start], routes[start] = 0, 1
    for i, v in enumerate(neighbors[start]):
        if dist[v] == -1:
            dist[v] = 1
            routes[v] = 1
        elif dist[v] == 1:
            routes[v] += 1
        moves[v] |= 1 << i
    frontier = [v for v in dict.fromkeys(neighbors[start]) if dist[v] == 1]
    d = 1
    while frontier:
        d += 1
        nxt = []
        for u in frontier:
            ru, mu = routes[u], moves[u]
            for v in neighbors[u]:
                if dist[v] == -1:
                    dist[v] = d
                    routes[v] = ru
                    moves[v] = mu
                    nxt.append(v)
                elif dist[v] == d:
                    routes[v] += ru
                    moves[v] |= mu
        frontier = nxt
    return dist, routes, [m.bit_count() for m in moves]


def shortest_route(neighbors: list[list[int]], start: int, goal: int) -> list[int] | None:
    """One fewest-steps route, as word indexes including both ends (None if
    unreachable). Plain BFS with parent links; lists are scanned most-similar
    first, so ties go to the closer neighbor. Shown to the AI so it can see
    which sense of a word the graph actually walks through."""
    parent = {start: start}
    frontier = [start]
    while frontier and goal not in parent:
        nxt = []
        for u in frontier:
            for v in neighbors[u]:
                if v not in parent:
                    parent[v] = u
                    nxt.append(v)
        frontier = nxt
    if goal not in parent:
        return None
    route = [goal]
    while route[-1] != start:
        route.append(parent[route[-1]])
    return route[::-1]


def incoming_words(ladder: "Ladder", goals: list[str], limit: int = 10) -> dict[str, list[str]]:
    """For each goal, the words that list it as a legal step, most similar
    link first (the rank at which they list it), up to `limit`. One pass over
    all lists answers every goal at once."""
    want = {ladder.index[g]: g for g in goals}
    found: dict[str, list[tuple[int, str]]] = {g: [] for g in goals}
    for u, row in enumerate(ladder.neighbors):
        for rank, v in enumerate(row):
            if v in want:
                found[want[v]].append((rank, ladder.words[u]))
    return {g: [w for _, w in sorted(found[g])[:limit]] for g in goals}


def shortlist(ladder: "Ladder", date_str: str, band: dict, recent: set[str] = frozenset(),
              starts: int = 12, per_start: int = 3) -> list[tuple[str, str, int]]:
    """Pairs that already satisfy today's band, for the AI to choose from.

    The AI can't see our graph, so on hard days (par 4 with a narrow route
    range, ~1-3% of random pairs) it almost never guesses a valid pair. Instead
    we find valid ones first: one full BFS per sampled start word reveals every
    goal that fits. Deterministic for a given date.
    """
    pool = [w for w in ladder.candidates if w not in recent]
    # Goals validate_pair would reject anyway; filtering here keeps every
    # shortlisted pair valid, so the AI never wastes a round on them.
    min_in = ladder.config.get("minGoalInDegree")
    goals = pool if not min_in else [
        w for w in pool if in_degrees(ladder)[ladder.index[w]] >= min_in]
    rand = mulberry32(fnv1a32(f"shortlist#{date_str}"))
    out = []
    for start in seeded_sample(pool, starts, f"shortlist-starts#{date_str}"):
        dist, routes, closer = bfs_all(ladder.neighbors, ladder.index[start])
        fits = [g for g in goals if g != start
                and dist[ladder.index[g]] == band["par"]
                and band["minRoutes"] <= routes[ladder.index[g]] <= band["maxRoutes"]
                and closer_fits(band, closer[ladder.index[g]])]
        for _ in range(min(per_start, len(fits))):
            goal = fits.pop(math.floor(rand() * len(fits)))
            out.append((start, goal, routes[ladder.index[goal]]))
    return out


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


def level_band(level: str, config: dict) -> dict:
    """A level's rules, e.g. {"level": "hard", "label": "Hard", "par": 4, "minRoutes": 1, ...}."""
    band = dict(config["levels"][level])
    band["level"] = level
    return band


def wants_closer(band: dict | None) -> bool:
    """Does this level band limit the closer first moves? Only newer eras do."""
    return bool(band) and ("minCloserFirstMoves" in band or "maxCloserFirstMoves" in band)


def closer_fits(band: dict, closer: int) -> bool:
    """Is `closer` (see bfs_route_stats) inside the band? Missing limits = no limit.
    JS twin: closerFits in js/seeded.js."""
    return (band.get("minCloserFirstMoves", 0) <= closer
            <= band.get("maxCloserFirstMoves", math.inf))


def seed_base(date_str: str, level: str) -> str:
    """What the seeded fallback hashes: one independent stream per date AND level."""
    return f"{date_str}:{level}"


# ---------------------------------------------------------------- validation
@dataclass
class Verdict:
    ok: bool
    reason: str
    par: int | None = None
    routes: int = 0
    closer: int = 0  # closer first moves, see bfs_route_stats


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
    min_in = cfg.get("minGoalInDegree")  # absent in older eras: no check
    if min_in and in_degrees(ladder)[ladder.index[goal]] < min_in:
        return Verdict(False, f"only {in_degrees(ladder)[ladder.index[goal]]} words step to "
                              f"'{goal}', today needs {min_in}")

    i = ladder.index[start]
    two_way = bool(cfg.get("twoWay"))
    if wants_closer(band) and not two_way and len(ladder.neighbors[i]) > MAX_TRACKED_FIRST_MOVES:
        # The JS twin can't count past 31 first moves, and the two must agree.
        raise ValueError(f"closer-first-move bands need stepLimit <= {MAX_TRACKED_FIRST_MOVES}")
    par, routes, closer = bfs_route_stats(ladder.neighbors, i, ladder.index[goal])
    if two_way and par is not None:
        closer = closer_first_moves(ladder.neighbors, i, ladder.index[goal], par)
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
        # Never relaxed (unlike routes): it is what keeps the level label honest.
        if wants_closer(band) and not closer_fits(band, closer):
            return Verdict(False, f"{closer} of {start}'s first moves get closer to {goal}, "
                                  f"today needs {band.get('minCloserFirstMoves', 0)}-"
                                  f"{band.get('maxCloserFirstMoves', 'any')}",
                           par, routes, closer)
    return Verdict(True, "ok", par, routes, closer)


def seeded_puzzle(ladder: Ladder, date_str: str, band: dict) -> tuple[str, str, Verdict, int]:
    """Deterministic fallback: same seed text -> same puzzle, in Python and in JS.

    `date_str` is the seed base, normally seed_base(date, level), e.g.
    "2026-11-12:hard". Try attempt 0, 1, 2...: hash "<base>#attempt", seed the
    PRNG with it, roll a start and a goal, keep the first pair that fits the band.
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
