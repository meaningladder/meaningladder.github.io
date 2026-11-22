"""Published puzzles obey today's rule: par 3/4/5 by level, and the stored route
shows at least 2 clean link clues on the rungs the player sees (every step but
the last, which plays itself)."""
import json

import pytest

from ladder_core import ROOT, bfs_all, level_band, load_ladder, rel_key

FILES = sorted((ROOT / "puzzles").glob("*.json"))
PAR = {"easy": 3, "medium": 4, "hard": 5}


@pytest.fixture(scope="module")
def ladder():
    return load_ladder()


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_published_puzzle(path, ladder):
    p = json.loads(path.read_text(encoding="utf-8"))
    day = ladder.at(p["date"])
    band = level_band(p["level"], day.config)
    assert p["par"] == PAR[p["level"]]
    route = [day.index[w] for w in p["route"]]
    assert len(route) == p["par"] + 1 and route[0] == day.index[p["start"]] and route[-1] == day.index[p["goal"]]
    shown = sum(rel_key(a, b) in day.linked for a, b in zip(route[:-2], route[1:-1]))  # last step plays itself
    assert shown >= band["minLinkedSteps"], f"{path.name}: only {shown} link clues shown"
    to_goal = [bfs_all(day.neighbors, a)[0][route[-1]] for a in route]  # distance from each rung to the goal
    for k, (a, b) in enumerate(zip(route, route[1:])):
        assert b in day.neighbors[a], f"{path.name}: {day.words[a]} to {day.words[b]} is not a legal step"
        assert to_goal[k + 1] == to_goal[k] - 1, f"{path.name}: step {k + 1} is not one rung closer"
