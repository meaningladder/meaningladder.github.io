"""Unit tests for ladder_core: BFS, seeded randomness, dates, validation."""
import json
from datetime import date
from pathlib import Path

import pytest

from ladder_core import (
    Ladder,
    band_for,
    bfs_routes,
    fnv1a32,
    game_number,
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


def test_band_for_weekdays():
    cfg = {"bands": {d: {"par": i} for i, d in enumerate(
        ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])}}
    assert band_for(date(2026, 11, 16), cfg)["weekday"] == "monday"
    assert band_for(date(2026, 11, 22), cfg)["weekday"] == "sunday"


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


# ---------------------------------------------------------------- real data
@pytest.fixture(scope="module")
def ladder():
    return load_ladder()


def test_seeded_puzzle_same_date_same_puzzle(ladder):
    band = band_for(date(2026, 11, 17), ladder.config)
    first = seeded_puzzle(ladder, "2026-11-17", band)
    second = seeded_puzzle(ladder, "2026-11-17", band)
    assert first[:2] == second[:2]
    assert first[2].ok and first[2].par == band["par"]


def test_seeded_puzzles_match_fixture(ladder):
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for p in fx["puzzles"][:3]:  # the full list runs in the JS test
        day = date.fromisoformat(p["date"])
        start, goal, verdict, attempt = seeded_puzzle(ladder, p["date"],
                                                      band_for(day, ladder.config))
        assert (start, goal, verdict.par, attempt) == (p["start"], p["goal"], p["par"],
                                                       p["attempt"])


def test_bfs_all_matches_pairwise_bfs():
    from ladder_core import bfs_all

    dist, routes = bfs_all(TINY_NEIGHBORS, A)
    for goal in range(len(TINY_WORDS)):
        par, n = bfs_routes(TINY_NEIGHBORS, A, goal)
        assert dist[goal] == (-1 if par is None else par)
        assert routes[goal] == n


def test_shortlist_pairs_all_fit_the_band(ladder):
    """Saturday (par 4, narrow route band) is where blind AI guesses failed."""
    from ladder_core import shortlist

    band = band_for(date(2026, 11, 14), ladder.config)
    pairs = shortlist(ladder, "2026-11-14", band, recent={"bee"})
    assert len(pairs) >= 5
    assert pairs == shortlist(ladder, "2026-11-14", band, recent={"bee"})  # deterministic
    for start, goal, routes in pairs:
        assert "bee" not in (start, goal)
        v = validate_pair(ladder, start, goal, band)
        assert v.ok and v.routes == routes
