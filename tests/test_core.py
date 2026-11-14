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
    # Chain ladders (from Nov 13): every level is 5 steps.
    assert [level_band(lv, rules_for(cfg, "2026-11-13"))["par"] for lv in LEVELS] == [5, 5, 5]
    assert seed_base("2026-11-12", "hard") == "2026-11-12:hard"


def test_rules_eras_pick_by_date():
    from ladder_core import rules_for

    cfg = load_config()
    assert cfg["rules"][0]["from"] == cfg["launchDate"]  # every date has rules
    assert [e["from"] for e in cfg["rules"]] == sorted(e["from"] for e in cfg["rules"])
    assert rules_for(cfg, "2026-11-01")["stepLimit"] == 100
    assert rules_for(cfg, "2026-11-12")["stepLimit"] == 100
    assert rules_for(cfg, "2026-11-13")["stepLimit"] == 10
    assert rules_for(cfg, "2030-01-01")["stepLimit"] == 10
    assert rules_for(cfg, None)["stepLimit"] == 10  # Unlimited: newest rules
    # Links work both ways from Nov 13; older dates stay one-way.
    assert rules_for(cfg, "2026-11-13")["twoWay"] is True
    assert "twoWay" not in rules_for(cfg, "2026-11-12")
    # Every word now has 10+ links in both ways, so the thin-goal rule is gone.
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
# The open-ladder rules that were planned for 2026-11-13 and 14 (top 10, links
# both ways, par 4/5/6) before the chain era moved up to Nov 13. No date uses
# them now, but they are what the open puzzle files of those two days were
# made under (players who started them keep playing them: same stepLimit and
# twoWay as the chain era), and the open-ladder tests below run on them.
OPEN_TOP10 = {
    "from": "2026-11-13", "stepLimit": 10, "twoWay": True,
    "excludeCandidates": "data/candidates_exclude_2026-11-13.json", "minPar": 3, "maxPar": 7,
    "levels": {
        "easy": {"label": "Easy", "par": 4, "minRoutes": 1, "maxRoutes": 100000,
                 "minCloserFirstMoves": 3},
        "medium": {"label": "Medium", "par": 5, "minRoutes": 1, "maxRoutes": 100000,
                   "minCloserFirstMoves": 3},
        "hard": {"label": "Hard", "par": 6, "minRoutes": 1, "maxRoutes": 100000},
    },
}


@pytest.fixture(scope="module")
def ladder():
    # Open top-10 two-way rules; the chain rules (Nov 13-14) have
    # their own tests at the end of this file.
    from ladder_core import ladder_view

    base = load_ladder()
    return ladder_view(base, {**base.at("2026-11-12").config, **OPEN_TOP10})


def test_ladder_view_cuts_neighbor_lists(ladder):
    from ladder_core import ladder_view

    old, new = ladder.at("2026-11-12"), ladder  # top 100 one-way; top 10 both ways
    top20 = ladder_view(ladder, {**new.config, "stepLimit": 20, "twoWay": False})
    i = ladder.index["door"]
    assert len(old.neighbors[i]) == 100 and len(top20.neighbors[i]) == 20
    assert top20.neighbors[i] == old.neighbors[i][:20]  # lists are sorted: first 20 = top 20
    assert new.full_neighbors[i] == old.neighbors[i]
    # Two-way: own top 10 first, then words that list door in their top 10.
    assert new.neighbors[i][:10] == old.neighbors[i][:10] and len(new.neighbors[i]) >= 10
    assert all(i in new.neighbors[v] for v in new.neighbors[i])  # undirected
    # The same pair under each rule: top 100 par 4, top 20 one-way par 6,
    # top 10 both ways par 5 (after playtests asked for longer ladders).
    k = ladder.index["kidney"]
    assert bfs_routes(old.neighbors, i, k)[0] == 4
    assert bfs_routes(top20.neighbors, i, k)[0] == 6
    assert bfs_routes(new.neighbors, i, k)[0] == 5


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
    assert hard[:2] != first[:2] and hard[2].par == 6  # open top-10 two-way rules


def test_seeded_puzzles_match_fixture(ladder):
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for p in fx["puzzles"][3:6]:  # Nov 12, top 100; the full list runs in the JS test
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
    new = ladder_view(ladder, {**ladder.config, "stepLimit": 20,
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


# ---------------------------------------------------------------- ConceptNet relations
def test_relations_file_is_consistent(ladder):
    """Every related pair is a GloVe top-40 neighbor pair (the only pairs that
    can ever be steps), and the file matches the hash in its header."""
    import hashlib
    from ladder_core import REL_KEY

    head = json.loads((ROOT / "data" / "relations_v1.json").read_text(encoding="utf-8"))
    blob = (ROOT / "data" / "relations_v1.bin").read_bytes()
    assert hashlib.sha256(blob).hexdigest() == head["sha256"]
    assert head["license"] == "CC BY-SA 4.0" and len(ladder.related) == head["count"]
    full = ladder.full_neighbors
    for key in list(ladder.related)[:3000]:
        u, v = divmod(key, REL_KEY)
        assert u < v and (v in full[u][:40] or u in full[v][:40])


def test_guide_route_keeps_par_and_prefers_relations(ladder):
    """The shown route is a real shortest route (par kept, every step legal)
    with as many relation steps as any shortest route has."""
    from ladder_core import bfs_all, guide_route, linked_from, linked_steps, rel_key

    nb, rel, ix = ladder.neighbors, ladder.related, ladder.index
    for s, g in [("cafe", "fuel"), ("champ", "dress"), ("lunch", "sedan"), ("chest", "stream")]:
        par = bfs_routes(nb, ix[s], ix[g])[0]
        route = guide_route(nb, rel, ix[s], ix[g])
        assert len(route) - 1 == par and route[0] == ix[s] and route[-1] == ix[g]
        assert all(route[k + 1] in nb[route[k]] for k in range(par))
        linked = sum(rel_key(route[k], route[k + 1]) in rel for k in range(par))
        assert linked == linked_steps(nb, rel, ix[s], ix[g], par)
        # The all-goals version used by the shortlist agrees.
        dist = bfs_all(nb, ix[s])[0]
        assert linked_from(nb, rel, ix[s], dist)[ix[g]] == linked
    # cafe -> fuel: 4 of its 5 steps are real relations (restaurant, grill, stove, kerosene).
    assert linked_steps(nb, rel, ix["cafe"], ix["fuel"], 5) == 4


# ---------------------------------------------------------------- chain mode
def test_chain_era_starts_nov_13(ladder):
    from ladder_core import is_chain, rules_for

    cfg = ladder.base_config
    assert [e["from"] for e in cfg["rules"]] == ["2026-11-01", "2026-11-13", "2026-11-15"]
    assert not is_chain(rules_for(cfg, "2026-11-12"))
    new = rules_for(cfg, "2026-11-13")
    assert is_chain(new) and is_chain(rules_for(cfg, "2026-11-14"))
    # Open ladders again from Nov 15, and in Unlimited.
    assert not is_chain(rules_for(cfg, "2026-11-15")) and not is_chain(rules_for(cfg, None))
    # Every level is 5 steps; difficulty is how loose the links may be.
    assert [new["levels"][lv]["par"] for lv in LEVELS] == [5, 5, 5]
    ranks = [new["levels"][lv]["maxRank"] for lv in LEVELS]
    assert ranks == sorted(ranks) and ranks[-1] <= 40  # the browser's lists stop at 40
    laterals = [new["levels"][lv]["lateral"] for lv in LEVELS]
    assert laterals == sorted(laterals) and laterals[0] == [0, 0]


def test_open_games_saved_on_chain_days_keep_their_steps(ladder):
    """Nov 13 and 14 have open-ladder files, made under OPEN_TOP10. Players who
    started one keep it, and the browser rebuilds its rules from the date's era
    (now the chain era) plus the file's stepLimit/twoWay. Those must give the
    very same legal steps and start/goal pool."""
    for d in ("2026-11-13", "2026-11-14"):
        dated = ladder.at(d)
        assert (dated.config["stepLimit"], dated.config["twoWay"]) == (10, True)
        assert dated.neighbors == ladder.neighbors
        assert dated.candidates == ladder.candidates
    for path in sorted((ROOT / "puzzles").glob("2026-11-1[34]-*.json")):
        if path.name.endswith(".chain.json"):
            continue
        p = json.loads(path.read_text(encoding="utf-8"))
        assert "mode" not in p and (p["stepLimit"], p["twoWay"]) == (10, True), path.name
        v = validate_pair(ladder, p["start"], p["goal"], level_band(p["level"], ladder.config))
        assert v.ok and v.par == p["par"], path.name


@pytest.fixture(scope="module")
def chain_day(ladder):
    return ladder.at("2026-11-14")  # chains ran Nov 13-14 only


def test_seeded_chains_are_fair_and_deterministic(chain_day):
    from ladder_core import chain_rank, pattern_rivals, seeded_chain, validate_chain

    for lv in LEVELS:
        band = level_band(lv, chain_day.config)
        words, verdict, attempt = seeded_chain(chain_day, seed_base("2026-11-20", lv), band)
        again = seeded_chain(chain_day, seed_base("2026-11-20", lv), band)
        assert (words, attempt) == (again[0], again[2])
        assert verdict.ok and validate_chain(chain_day, words, band).ok
        assert len(words) == 6 and len(set(words)) == 6
        idx = [chain_day.index[w] for w in words]
        assert all(chain_rank(chain_day, a, b) <= band["maxRank"] for a, b in zip(idx, idx[1:]))
        # One answer per hidden rung: no other close word fits its pattern.
        assert not any(pattern_rivals(chain_day, idx[k - 1], idx[k], {idx[0], idx[-1]})
                       for k in range(1, 5))
        assert all(chain_day.index[w] < band["maxWordIndex"] for w in words[1:-1])


def test_validate_chain_rejects_unfair_chains(chain_day):
    from ladder_core import seeded_chain, validate_chain

    band = level_band("medium", chain_day.config)
    words, _, _ = seeded_chain(chain_day, "test-chain", band)

    def check(ws, **kw):
        return validate_chain(chain_day, ws, band, **kw)

    assert "need exactly 6" in check(words[:-1]).reason
    assert "not in our word list" in check([words[0], "zzqx", *words[2:]]).reason
    assert "forms of one word" in check([*words[:2], words[1], *words[3:]]).reason
    assert "too loose" in check([words[0], "volcano", *words[2:]]).reason
    assert "recent" in check(words, recent={words[-1]}).reason
    assert "lateral" in check(words, kinds=["everyday"] * 5).reason  # Medium needs 1-2
    assert check(words, kinds=["lateral"] + ["everyday"] * 4).ok
    assert "kinds" in check(words, kinds=["odd"] * 5).reason


def test_pattern_rivals_find_a_second_answer():
    """A tiny map: after "sea", both "ship" and "shop" are close and both
    have 4 letters starting with s, so that rung has two answers."""
    from ladder_core import Ladder, pattern_rivals, same_stem

    words = ["sea", "ship", "shop", "port", "boat"]
    nb = [[1, 2, 4], [0, 3], [0], [1], [0]]
    lad = Ladder(words=words, index={w: i for i, w in enumerate(words)}, neighbors=nb,
                 candidates=words, candidate_set=set(words), config={}, full_neighbors=nb)
    assert pattern_rivals(lad, 0, 1, set()) == [2]
    assert pattern_rivals(lad, 0, 1, {2}) == []      # a word on screen is no rival
    assert pattern_rivals(lad, 0, 4, set()) == []    # only boat starts with b
    assert same_stem("ship", "ships") and same_stem("swim", "swimming")
    assert not same_stem("sea", "seal") and not same_stem("ship", "shop")


def test_seeded_chain_reasons_read_both_ways(chain_day):
    from ladder_core import chain_reason, chain_reasons

    assert chain_reason("cafe", "restaurant", "IsA") == "Cafe and restaurant: one is a kind of the other."
    assert chain_reason("box", "corner", None) == "Box and corner: they often go together."
    words = ["photo", "picture", "movie", "box", "corner", "edge"]
    assert len(chain_reasons(chain_day, words)) == 5


def test_seeded_chains_match_fixture(ladder):
    from ladder_core import chain_reasons, seeded_chain

    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for c in fx["chains"][:3]:  # the full list runs in the JS test
        dated = ladder.at(c["date"])
        words, verdict, attempt = seeded_chain(dated, seed_base(c["date"], c["level"]),
                                               level_band(c["level"], dated.config))
        assert (words, attempt, verdict.closer) == (c["route"], c["attempt"], c["linked"])
        assert chain_reasons(dated, words) == c["reasons"]
