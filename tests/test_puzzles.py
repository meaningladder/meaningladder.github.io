"""Published puzzles obey today's rule: par 3/4/5 by level, and the stored route
shows at least 2 clean link clues on the rungs the player sees (every step but
the last, which plays itself)."""
import json

import pytest

from ladder_core import ROOT, level_band, load_ladder, rel_key

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
