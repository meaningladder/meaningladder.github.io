"""The browser's split graph files must hold exactly the same data as graph_v1.json."""
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


@pytest.fixture(scope="module")
def graph():
    return json.loads((DATA / "graph_v1.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def header():
    return json.loads((DATA / "graph_v1_wide.json").read_text(encoding="utf-8"))


def test_words_and_layout_match(graph, header):
    assert header["words"] == graph["words"]
    assert header["count"] == len(graph["words"])
    assert header["head"] + header["tail"] == len(graph["neighbors"][0])


def test_head_plus_tail_is_the_graph(graph, header):
    n, h, t = header["count"], header["head"], header["tail"]
    head = np.frombuffer((DATA / "graph_v1_wide_head.bin").read_bytes(), dtype="<u2").reshape(n, h)
    tail = np.frombuffer((DATA / "graph_v1_wide_tail.bin").read_bytes(), dtype="<u2").reshape(n, t)
    assert np.array_equal(np.hstack([head, tail]), np.asarray(graph["neighbors"]))


def test_head_covers_the_newest_rules(header):
    config = json.loads((ROOT / "puzzle_config.json").read_text(encoding="utf-8"))
    # Today's games must be playable from the head alone (the fast first load).
    assert config["rules"][-1]["stepLimit"] <= header["head"]


def test_build_is_deterministic(graph):
    from build_graph_bin import split

    assert split(graph["neighbors"]) == split(graph["neighbors"])
