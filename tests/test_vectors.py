"""Checks on data/vectors_v1.bin, the compact vectors behind Contexto-style ranks."""
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "data" / "vectors_v1.bin"
HEADER = ROOT / "data" / "vectors_v1.json"

pytestmark = pytest.mark.skipif(not BIN.exists(), reason="vectors not built (make vectors)")


@pytest.fixture(scope="module")
def header():
    return json.loads(HEADER.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def graph():
    return json.loads((ROOT / "data" / "graph_v1.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def q(header):
    return np.frombuffer(BIN.read_bytes(), dtype=np.int8).reshape(header["count"], header["dims"])


def test_header_and_size(header, graph):
    assert header["graphVersion"] == 1 and header["dtype"] == "int8"
    assert header["count"] == len(graph["words"])  # one row per graph word, same order
    assert BIN.stat().st_size == header["count"] * header["dims"]
    assert BIN.stat().st_size < 2_000_000  # stays a small download for phones


def test_compact_vectors_agree_with_the_exact_graph(q, graph):
    """At least 70% of each word's exact top-100 neighbors rank within the
    compact top 150 (measured: 71.5%). It isn't higher partly because the
    compact vectors rank excluded "same word" forms (volcanoes) near the top.
    What players see agrees far better: on 2026-11-11, 93% of wrong guesses got
    the same color band as full 300-d vectors (ranks off by a median x1.26).
    Ranks 1-100 always come from the exact graph."""
    from build_vectors import quality

    assert quality(q, graph["neighbors"], samples=100) >= 0.70


def test_reduce_is_deterministic():
    from build_vectors import quantize, reduce

    rng = np.random.default_rng(1)
    x = rng.normal(size=(50, 12))
    a, sa = quantize(reduce(x, 4))
    b, sb = quantize(reduce(x.copy(), 4))
    assert sa == sb and a.tobytes() == b.tobytes()
