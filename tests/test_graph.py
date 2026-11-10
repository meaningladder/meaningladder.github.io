"""Checks on the built data files. Run scripts/build_graph.py first."""
import json
from pathlib import Path

import pytest

from wordfilters import is_trivial_pair, load_wordlist

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "data" / "graph_v1.json"
CANDS = ROOT / "data" / "candidates_v1.json"
K = 100

pytestmark = pytest.mark.skipif(not GRAPH.exists(), reason="graph not built yet")


@pytest.fixture(scope="module")
def graph():
    return json.loads(GRAPH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def index(graph):
    return {w: i for i, w in enumerate(graph["words"])}


@pytest.fixture(scope="module")
def candidates():
    return json.loads(CANDS.read_text(encoding="utf-8"))


def neighbor_words(graph, index, word):
    return [graph["words"][j] for j in graph["neighbors"][index[word]]]


def test_shape(graph):
    assert graph["version"] == 1
    assert len(graph["words"]) == len(graph["neighbors"]) == 20_000
    assert len(set(graph["words"])) == len(graph["words"])  # no duplicates


def test_every_word_has_exactly_k_unique_valid_neighbors(graph):
    n = len(graph["words"])
    for i, row in enumerate(graph["neighbors"]):
        assert len(row) == K, graph["words"][i]
        assert len(set(row)) == K, graph["words"][i]
        assert i not in row, f"self-loop on {graph['words'][i]}"
        assert all(isinstance(j, int) and 0 <= j < n for j in row)


def test_ocean_has_sea_neighbors(graph, index):
    near = set(neighbor_words(graph, index, "ocean"))
    expected = {"sea", "seas", "waters", "coast", "coastal", "shore", "marine",
                "pacific", "atlantic", "coral", "underwater"}
    assert len(near & expected) >= 3, near & expected


def test_computer_has_tech_neighbors(graph, index):
    near = set(neighbor_words(graph, index, "computer"))
    assert {"software", "hardware", "laptop"} <= near


def test_no_trivial_neighbors(graph, index):
    near = neighbor_words(graph, index, "volcano")
    assert "volcanoes" not in near and "volcanic" not in near
    # And spot-check the rule across a slice of the whole graph.
    words = graph["words"]
    for i in range(0, len(words), 97):
        for j in graph["neighbors"][i]:
            assert not is_trivial_pair(words[i], words[j]), (words[i], words[j])


def test_no_blocklisted_words(graph):
    block = load_wordlist(ROOT / "scripts" / "lists" / "blocklist_en.txt")
    assert not block & set(graph["words"])


def test_graph_is_directed(graph):
    """Pitfall #1: neighbor relationships are not symmetric."""
    nb = [set(r) for r in graph["neighbors"]]
    one_way = sum(1 for a, row in enumerate(nb) for b in row if a not in nb[b])
    assert one_way > 0


def test_candidates(graph, candidates):
    words = set(graph["words"])
    cands = candidates["words"]
    assert candidates["version"] == 1
    assert 1_000 <= len(cands) <= 2_000
    assert set(cands) <= words
    assert cands == sorted(set(cands))  # sorted, no duplicates
    exclude = load_wordlist(ROOT / "scripts" / "lists" / "candidates_exclude.txt")
    assert not exclude & set(cands)
