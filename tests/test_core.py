"""Unit tests for ladder_core: BFS, seeded randomness, dates, validation."""
import json
from datetime import date
from pathlib import Path

import pytest

from ladder_core import (
    ROOT,
    Ladder,
    LEVELS,
    level_band,
    seed_base,
    bfs_route_stats,
    bfs_routes,
    fnv1a32,
    game_number,
    load_config,
    load_ladder,
    mulberry32,
    seeded_puzzle,
    seeded_sample,
    validate_pair,
)

FIXTURE = Path(__file__).parent / "fixtures" / "seeded_vectors.json"

# A tiny hand-made directed graph:
#
#   a -> b -> d -> e        a -> c -> d  (two shortest routes a..d)
#   e -> a                  f is a dead end nobody points to: f -> a
#
TINY_WORDS = ["a", "b", "c", "d", "e", "f"]
TINY_NEIGHBORS = [[1, 2], [3], [3], [4], [0], [0]]
A, B, C, D, E, F = range(6)


def tiny_ladder(**band_overrides) -> Ladder:
    config = {"minPar": 3, "maxPar": 6, "graphVersion": 0, "bands": {}}
    return Ladder(words=TINY_WORDS, index={w: i for i, w in enumerate(TINY_WORDS)},
                  neighbors=TINY_NEIGHBORS, candidates=sorted(TINY_WORDS),
                  candidate_set=set(TINY_WORDS) - {"c"}, config=config)


# ---------------------------------------------------------------- BFS
def test_bfs_distance_and_routes():
    assert bfs_routes(TINY_NEIGHBORS, A, B) == (1, 1)
    assert bfs_routes(TINY_NEIGHBORS, A, D) == (2, 2)  # via b or via c
    assert bfs_routes(TINY_NEIGHBORS, A, E) == (3, 2)
    assert bfs_routes(TINY_NEIGHBORS, A, A) == (0, 1)


def test_closer_first_moves():
    """Both of a's first moves (b, c) begin a shortest route to d and to e."""
    assert bfs_route_stats(TINY_NEIGHBORS, A, D) == (2, 2, 2)
    assert bfs_route_stats(TINY_NEIGHBORS, A, E) == (3, 2, 2)
    assert bfs_route_stats(TINY_NEIGHBORS, A, B) == (1, 1, 1)  # only b itself
    assert bfs_route_stats(TINY_NEIGHBORS, B, A) == (3, 1, 1)
    assert bfs_route_stats(TINY_NEIGHBORS, A, F) == (None, 0, 0)
    # A shortcut a -> d makes d's ripple-2 routes irrelevant: only one first move helps.
    assert bfs_route_stats([[1, 2, 3], [3], [3], [4], [0], [0]], A, E) == (2, 1, 1)


def test_bfs_unreachable():
    assert bfs_routes(TINY_NEIGHBORS, A, F) == (None, 0)  # nothing points to f


def test_bfs_is_directed():
    """Pitfall #1: a -> b is one step, but b -> a needs the long way round."""
    assert bfs_routes(TINY_NEIGHBORS, A, B)[0] == 1
    assert bfs_routes(TINY_NEIGHBORS, B, A)[0] == 3  # b -> d -> e -> a


# ---------------------------------------------------------------- seeded randomness
def test_fnv1a_standard_vectors():
    assert fnv1a32("") == 0x811C9DC5
    assert fnv1a32("a") == 0xE40C292C
    assert fnv1a32("foobar") == 0xBF9CF968


def test_mulberry32_is_deterministic_and_in_range():
    r1, r2 = mulberry32(42), mulberry32(42)
    xs = [r1() for _ in range(1000)]
    assert xs == [r2() for _ in range(1000)]
    assert all(0 <= x < 1 for x in xs)
    assert xs[:5] != [mulberry32(43)() for _ in range(5)]


def test_python_matches_golden_fixture():
    """If this fails after editing candidates/graph, seeded puzzles changed
    (pitfall #4). Regenerate with scripts/make_fixtures.py on purpose."""
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for text, h in fx["fnv1a32"].items():
        assert fnv1a32(text) == h
    for seed, values in fx["mulberry32"].items():
        r = mulberry32(int(seed))
        assert [r() for _ in values] == values


def test_seeded_sample_deterministic():
    items = [f"w{i}" for i in range(100)]
    s1 = seeded_sample(items, 10, "sample#2026-11-12")
    assert s1 == seeded_sample(items, 10, "sample#2026-11-12")
    assert len(set(s1)) == 10
    assert s1 != seeded_sample(items, 10, "sample#2026-11-13")


# ---------------------------------------------------------------- dates
def test_game_number():
    launch = date(2026, 11, 12)
    assert game_number(date(2026, 11, 12), launch) == 1
    assert game_number(date(2026, 11, 13), launch) == 2
    # Across the US DST change (2027-03-14) and a leap day: still whole days.
    assert game_number(date(2027, 3, 15), launch) == 124
    assert game_number(date(2028, 3, 1), launch) == 476
    with pytest.raises(ValueError):
        game_number(date(2026, 11, 11), launch)


def test_levels_cover_easy_medium_hard():
    from ladder_core import rules_for

    cfg = load_config()
    assert LEVELS == ("easy", "medium", "hard")
    # Original rules (Nov 1-12): Easy and Medium are both 3 steps; Easy just has
    # many more routes.
    easy, medium, hard = (level_band(lv, rules_for(cfg, "2026-11-12")) for lv in LEVELS)
    assert easy["level"] == "easy" and easy["label"] == "Easy"
    assert easy["par"] == medium["par"] == 3 and hard["par"] == 4
    assert medium["maxRoutes"] < easy["minRoutes"]
    # Top-25 two-way rules (from Nov 13): Easy par 3; Medium and Hard par 4,
    # Hard with only 1-2 good first moves.
    assert [level_band(lv, rules_for(cfg, "2026-11-13"))["par"] for lv in LEVELS] == [3, 4, 4]
    assert seed_base("2026-11-12", "hard") == "2026-11-12:hard"


def test_rules_eras_pick_by_date():
    from ladder_core import rules_for

    cfg = load_config()
    assert cfg["rules"][0]["from"] == cfg["launchDate"]  # every date has rules
    assert [e["from"] for e in cfg["rules"]] == sorted(e["from"] for e in cfg["rules"])
    assert rules_for(cfg, "2026-11-01")["stepLimit"] == 100
    assert rules_for(cfg, "2026-11-12")["stepLimit"] == 100
    assert rules_for(cfg, "2026-11-13")["stepLimit"] == 25
    assert rules_for(cfg, "2030-01-01")["stepLimit"] == 25
    assert rules_for(cfg, None)["stepLimit"] == 25  # Unlimited: newest rules
    # Links work both ways from Nov 13; older dates stay one-way.
    assert rules_for(cfg, "2026-11-13")["twoWay"] is True
    assert "twoWay" not in rules_for(cfg, "2026-11-12")
    # Every word now has 25+ links in, so the thin-goal rule is gone.
    assert "minGoalInDegree" not in rules_for(cfg, "2026-11-13")
    merged = rules_for(cfg, "2026-11-13")
    assert "rules" not in merged and merged["launchDate"] == cfg["launchDate"]


# ---------------------------------------------------------------- validation
@pytest.mark.parametrize("start, goal, reason_part", [
    ("a", "a", "same word"),
    ("a", "zzz", "not in the word graph"),
    ("a", "c", "not an allowed start/goal"),  # c is in the graph, not a candidate
    ("a", "f", "no path"),
    ("a", "b", "par 1 is outside"),
    ("a", "e", "recent"),
])
def test_validator_rejects_bad_pairs(start, goal, reason_part):
    v = validate_pair(tiny_ladder(), start, goal, recent={"e"} if goal == "e" else set())
    assert not v.ok
    assert reason_part in v.reason


def test_validator_accepts_and_checks_band():
    lad = tiny_ladder()
    assert validate_pair(lad, "a", "e").ok  # par 3, 2 routes
    band = {"par": 3, "minRoutes": 1, "maxRoutes": 1}
    v = validate_pair(lad, "a", "e", band)
    assert not v.ok and "routes" in v.reason
    assert not validate_pair(lad, "a", "e", {**band, "par": 4}).ok


def test_in_degrees_and_min_goal_in_degree():
    from ladder_core import in_degrees

    lad = tiny_ladder()
    assert in_degrees(lad) == [2, 1, 1, 2, 1, 0]  # a <- e, f; d <- b, c; ...
    assert validate_pair(lad, "a", "e").ok  # no minGoalInDegree: no check (old eras)
    lad.config["minGoalInDegree"] = 2
    v = validate_pair(lad, "a", "e")  # only d steps to e
    assert not v.ok and "only 1 words step to 'e'" in v.reason
    lad.config["minGoalInDegree"] = 1
    assert validate_pair(lad, "a", "e").ok


def test_shortest_route_and_incoming_words():
    from ladder_core import incoming_words, shortest_route

    assert shortest_route(TINY_NEIGHBORS, A, E) == [A, B, D, E]  # b is a's closer neighbor
    assert shortest_route(TINY_NEIGHBORS, A, A) == [A]
    assert shortest_route(TINY_NEIGHBORS, A, F) is None
    assert incoming_words(tiny_ladder(), ["d", "a", "f"]) == {"d": ["b", "c"], "a": ["e", "f"],
                                                               "f": []}
    assert incoming_words(tiny_ladder(), ["d"], limit=1) == {"d": ["b"]}


def test_validator_checks_closer_first_moves():
    lad = tiny_ladder()
    band = {"par": 3, "minRoutes": 1, "maxRoutes": 9}
    v = validate_pair(lad, "a", "e", {**band, "minCloserFirstMoves": 2})
    assert v.ok and v.closer == 2
    v = validate_pair(lad, "a", "e", {**band, "minCloserFirstMoves": 3})
    assert not v.ok and "first moves" in v.reason
    assert not validate_pair(lad, "a", "e", {**band, "maxCloserFirstMoves": 1}).ok
    assert validate_pair(lad, "a", "e", band).ok  # no limit set: old eras unaffected


def test_closer_bands_refuse_wide_step_limits(ladder):
    """JS tracks first moves in 32-bit masks; Python must refuse what JS can't count."""
    old = ladder.at("2026-11-12")  # top 100
    with pytest.raises(ValueError):
        validate_pair(old, "door", "kidney", {**level_band("hard", old.config),
                                              "minCloserFirstMoves": 1})


# ---------------------------------------------------------------- real data
@pytest.fixture(scope="module")
def ladder():
    return load_ladder()


def test_ladder_view_cuts_neighbor_lists(ladder):
    from ladder_core import ladder_view

    old, new = ladder.at("2026-11-12"), ladder.at("2026-11-13")
    top20 = ladder_view(ladder, {**new.config, "stepLimit": 20, "twoWay": False})
    i = ladder.index["door"]
    assert len(old.neighbors[i]) == 100 and len(top20.neighbors[i]) == 20
    assert top20.neighbors[i] == old.neighbors[i][:20]  # lists are sorted: first 20 = top 20
    assert new.full_neighbors[i] == old.neighbors[i]
    # Two-way: own top 25 first, then words that list door in their top 25.
    assert new.neighbors[i][:25] == old.neighbors[i][:25] and len(new.neighbors[i]) >= 25
    assert all(i in new.neighbors[v] for v in new.neighbors[i])  # undirected
    # The same pair under each rule: top 100 par 4, top 20 one-way par 6,
    # top 25 both ways par 4 (playtests: top 20 one-way too strict, top 40 too short).
    k = ladder.index["kidney"]
    assert bfs_routes(old.neighbors, i, k)[0] == 4
    assert bfs_routes(top20.neighbors, i, k)[0] == 6
    assert bfs_routes(new.neighbors, i, k)[0] == 4


def test_new_era_drops_excluded_start_goal_words(ladder):
    """Names and abstract words leave the start/goal pool from 2026-11-13 on;
    older dates keep the whole frozen v1 list (their seeded puzzles must not move)."""
    from ladder_core import excluded_words

    old, new = ladder.at("2026-11-12"), ladder.at("2026-11-13")
    path = new.config["excludeCandidates"]
    excluded = excluded_words(json.loads((ROOT / path).read_text(encoding="utf-8")))
    assert "excludeCandidates" not in old.config
    assert old.candidates == ladder.all_candidates  # untouched before the era
    assert new.candidates == [w for w in old.candidates if w not in excluded]  # order kept
    assert len(new.candidates) == len(old.candidates) - len(excluded)
    for w in ("billy", "batman", "ayatollah", "behind", "wing", "jam", "afghan"):
        assert w in excluded and w in old.candidate_set and w not in new.candidate_set
        assert w in new.index  # still a legal step on the map
    v = validate_pair(new, "billy", "volcano")
    assert not v.ok and "not an allowed start/goal" in v.reason
    assert ladder.at(None).candidates == new.candidates  # Unlimited: newest rules
    assert new.at("2026-11-12").candidates == old.candidates  # a view re-views cleanly


def test_era_exclusion_file_is_up_to_date():
    """data/candidates_exclude_2026-11-13.json is generated: hand edits to it,
    or to the .txt / names list without a rebuild, would drift apart."""
    from build_era_exclude import ERA, build, render

    obj = build()
    out = ROOT / "data" / f"candidates_exclude_{ERA}.json"
    assert out.read_text(encoding="utf-8") == render(obj)
    words = [w for ws in obj["categories"].values() for w in ws]
    assert len(words) == len(set(words))  # one category per word
    assert {"billy", "bobby", "ben", "amir"} <= set(obj["categories"]["name_neighbors"])


def test_seeded_puzzle_same_date_same_puzzle(ladder):
    band = level_band("medium", ladder.config)
    first = seeded_puzzle(ladder, seed_base("2026-11-17", "medium"), band)
    second = seeded_puzzle(ladder, seed_base("2026-11-17", "medium"), band)
    assert first[:2] == second[:2]
    assert first[2].ok and first[2].par == band["par"]
    # Each level of a day is an independent puzzle.
    hard = seeded_puzzle(ladder, seed_base("2026-11-17", "hard"), level_band("hard", ladder.config))
    assert hard[:2] != first[:2] and hard[2].par == 4  # Nov 17: top-25 two-way rules


def test_seeded_puzzles_match_fixture(ladder):
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for p in fx["puzzles"][3:9]:  # both rules eras; the full list runs in the JS test
        dated = ladder.at(p["date"])
        assert dated.config["stepLimit"] == p["stepLimit"]
        start, goal, verdict, attempt = seeded_puzzle(
            dated, seed_base(p["date"], p["level"]), level_band(p["level"], dated.config))
        assert (start, goal, verdict.par, attempt) == (p["start"], p["goal"], p["par"],
                                                       p["attempt"])


def test_bfs_all_matches_pairwise_bfs():
    from ladder_core import bfs_all

    dist, routes, closer = bfs_all(TINY_NEIGHBORS, A)
    for goal in range(len(TINY_WORDS)):
        if goal == A:
            continue
        par, n, c = bfs_route_stats(TINY_NEIGHBORS, A, goal)
        assert dist[goal] == (-1 if par is None else par)
        assert (routes[goal], closer[goal]) == (n, c)


def _dist_to(neighbors, goal):
    """Plain BFS on the reversed graph: every word's distance TO `goal`."""
    rev = [[] for _ in neighbors]
    for u, row in enumerate(neighbors):
        for v in row:
            rev[v].append(u)
    dist = {goal: 0}
    frontier = [goal]
    while frontier:
        nxt = []
        for v in frontier:
            for u in rev[v]:
                if u not in dist:
                    dist[u] = dist[v] + 1
                    nxt.append(u)
        frontier = nxt
    return dist


def test_closer_first_moves_match_the_definition(ladder):
    """closer = how many of the start's legal steps sit at distance par-1 from the goal."""
    from ladder_core import closer_first_moves, ladder_view

    # The bit-mask count (one-way eras, at most 31 first moves): top 20 one-way.
    nb = ladder_view(ladder, {**ladder.config, "stepLimit": 20, "twoWay": False}).neighbors
    for s, g in [("cafe", "fuel"), ("grocery", "silicon"), ("jam", "key"),
                 ("novelist", "butterfly"), ("door", "kidney")]:
        par, _, closer = bfs_route_stats(nb, ladder.index[s], ladder.index[g])
        to_goal = _dist_to(nb, ladder.index[g])
        assert closer == sum(1 for v in nb[ladder.index[s]] if to_goal.get(v) == par - 1), (s, g)
    # The measured complaint: live Easy puzzles had a single good first move.
    assert bfs_route_stats(nb, ladder.index["cafe"], ladder.index["fuel"])[2] == 1
    # Two-way eras count with one BFS from the goal; same definition.
    two = ladder.neighbors
    for s, g in [("champ", "dress"), ("cafe", "fuel"), ("door", "kidney")]:
        par = bfs_route_stats(two, ladder.index[s], ladder.index[g])[0]
        to_goal = _dist_to(two, ladder.index[g])
        assert closer_first_moves(two, ladder.index[s], ladder.index[g], par) == \
            sum(1 for v in two[ladder.index[s]] if to_goal.get(v) == par - 1), (s, g)


def test_newest_levels_are_ordered_by_difficulty(ladder):
    """Easy < Medium < Hard: par never drops, and at equal par the harder level
    has fewer first moves that get closer (its bands must not overlap)."""
    bands = [level_band(lv, ladder.config) for lv in LEVELS]
    for easier, harder in zip(bands, bands[1:]):
        assert easier["par"] <= harder["par"]
        if easier["par"] == harder["par"]:
            assert harder["maxCloserFirstMoves"] < easier["minCloserFirstMoves"]
    for band in bands:
        assert band.get("minCloserFirstMoves", 1) >= 1  # every level has a good first move


def test_shortlist_pairs_all_fit_the_band(ladder):
    """Par-4 days are where blind AI guesses failed; the shortlist must always fit."""
    from ladder_core import shortlist

    band = level_band("hard", ladder.config)
    pairs = shortlist(ladder, "2026-11-14", band, recent={"bee"})
    assert len(pairs) >= 5
    assert pairs == shortlist(ladder, "2026-11-14", band, recent={"bee"})  # deterministic
    for start, goal, routes in pairs:
        assert "bee" not in (start, goal)
        v = validate_pair(ladder, start, goal, band)
        assert v.ok and v.routes == routes


def test_goals_few_words_step_to_are_rejected(ladder):
    """anchor (Nov 14 Hard) was only reachable via TV presenters, butterfly
    (Nov 13 Hard) via moths and swim strokes: unfair under the top-20 rules."""
    from ladder_core import in_degrees

    from ladder_core import ladder_view

    # The rule itself, on the one-way top-20 lists where it was needed (the
    # two-way era drops it: every word has 40+ links in).
    new = ladder_view(ladder, {**ladder.at("2026-11-13").config, "stepLimit": 20,
                               "twoWay": False, "minGoalInDegree": 12})
    old = ladder.at("2026-11-12")
    for goal in ("anchor", "butterfly"):
        assert in_degrees(new)[new.index[goal]] < new.config["minGoalInDegree"]
        # "ocean" is an allowed start in both eras ("wing" is excluded from Nov 13 on).
        v = validate_pair(new, "ocean", goal)
        assert not v.ok and "words step to" in v.reason
        assert "words step to" not in validate_pair(old, "ocean", goal).reason
    # The cached count follows the view: top-100 lists give far more links in.
    assert in_degrees(old)[old.index["anchor"]] > in_degrees(new)[new.index["anchor"]]
