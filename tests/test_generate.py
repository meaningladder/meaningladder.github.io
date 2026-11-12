"""Tests for the generator. A fake OpenAI client stands in for the real one,
so these never touch the network or need an API key."""
import json
from datetime import date
from types import SimpleNamespace

import openai
import pytest

from ai_suggest import Pair, Suggestions
from generate_puzzle import make_puzzle, recent_words, write_puzzle
from ladder_core import level_band, load_ladder, validate_pair

DAY = date(2026, 11, 17)
LEVEL = "medium"  # par 5 under the top-15 two-way rules (from Nov 13)
SPEC_FIELDS = {"date", "gameNumber", "level", "start", "goal", "par", "theme", "teaser",
               "source", "graphVersion", "stepLimit", "twoWay"}


@pytest.fixture(scope="module")
def ladder():
    return load_ladder()


@pytest.fixture(scope="module")
def good_pair(ladder):
    """Find a real pair that fits Tuesday's band, to feed the fake AI."""
    band = level_band(LEVEL, ladder.config)
    for s in ladder.candidates[:60]:
        for g in ladder.candidates[-60:]:
            if validate_pair(ladder, s, g, band).ok:
                return s, g
    pytest.skip("no Tuesday pair found in the sample")


class FakeClient:
    """Mimics client.responses.parse(); returns queued answers in order."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []
        self.responses = self

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return SimpleNamespace(status="completed", output=[], output_parsed=answer)


def pairs(*pairs_):
    return Suggestions(pairs=[Pair(start=s, goal=g, theme="A theme", teaser="A teaser.")
                              for s, g in pairs_])


def quiet(_msg):
    pass


def test_ai_retries_with_feedback_then_succeeds(ladder, good_pair):
    s, g = good_pair
    fake = FakeClient([pairs(("ocean", "ocean"), ("notaword", "ocean")),
                       pairs((s.upper(), g))])  # also checks case-normalising
    puzzle = make_puzzle(ladder, DAY, LEVEL, set(), lambda: fake, quiet)
    assert puzzle["source"] == "ai"
    assert (puzzle["start"], puzzle["goal"]) == (s, g)
    assert len(fake.calls) == 2
    feedback = fake.calls[1]["input"][-1]["content"]
    assert "same word" in feedback and "notaword" in feedback


def test_ai_error_falls_back_to_seeded(ladder):
    err = openai.APIConnectionError(request=SimpleNamespace(method="POST", url="x"))
    puzzle = make_puzzle(ladder, DAY, LEVEL, set(), lambda: FakeClient([err]), quiet)
    assert puzzle["source"] == "seeded"
    assert puzzle["teaser"] == ""


def test_ai_never_valid_falls_back_after_all_rounds(ladder):
    rounds = ladder.config["aiRounds"]
    fake = FakeClient([pairs(("ocean", "ocean"))] * rounds)
    puzzle = make_puzzle(ladder, DAY, LEVEL, set(), lambda: fake, quiet)
    assert puzzle["source"] == "seeded"
    assert len(fake.calls) == rounds


def test_no_ai_is_seeded_and_deterministic(ladder):
    p1 = make_puzzle(ladder, DAY, LEVEL, set(), None, quiet)
    p2 = make_puzzle(ladder, DAY, LEVEL, set(), None, quiet)
    assert p1 == p2
    assert set(p1) == SPEC_FIELDS
    assert p1["par"] == level_band(LEVEL, ladder.config)["par"]
    assert p1["level"] == LEVEL
    assert p1["gameNumber"] == 17  # launch 2026-11-01 is game 1
    assert p1["stepLimit"] == 15 and p1["par"] == 5 and p1["twoWay"] is True  # Nov 17


def test_puzzles_follow_their_dates_rules(ladder):
    """Before Nov 13 the original top-100 rules apply, even with a newest-rules ladder."""
    old = make_puzzle(ladder, date(2026, 11, 12), "hard", set(), None, quiet)
    new = make_puzzle(ladder, date(2026, 11, 13), "hard", set(), None, quiet)
    assert (old["stepLimit"], old["par"]) == (100, 4)
    assert (new["stepLimit"], new["par"], new["twoWay"]) == (15, 5, True)
    assert old["twoWay"] is False
    # Each new-era level's first-move band holds for the seeded pick.
    for level in ("easy", "medium", "hard"):
        p = make_puzzle(ladder, date(2026, 11, 20), level, set(), None, quiet)
        band = level_band(level, ladder.at("2026-11-20").config)
        v = validate_pair(ladder.at("2026-11-20"), p["start"], p["goal"], band)
        assert v.ok and band.get("minCloserFirstMoves", 0) <= v.closer


def test_write_never_overwrites(tmp_path, ladder):
    puzzle = make_puzzle(ladder, DAY, LEVEL, set(), None, quiet)
    path = write_puzzle(tmp_path, puzzle)
    assert json.loads(path.read_text()) == puzzle
    with pytest.raises(FileExistsError):
        write_puzzle(tmp_path, {**puzzle, "start": "changed"})
    assert json.loads(path.read_text())["start"] == puzzle["start"]


def test_recent_words(tmp_path):
    write_puzzle(tmp_path, {"date": "2026-11-15", "level": "hard", "start": "ore", "goal": "pie"})
    write_puzzle(tmp_path, {"date": "2026-11-17", "level": "easy", "start": "sun", "goal": "jam"})
    write_puzzle(tmp_path, {"date": "2026-10-01", "start": "old", "goal": "news"})  # legacy name
    assert (tmp_path / "2026-11-15-hard.json").exists()
    # The same day's other levels count too, so a day's three puzzles don't repeat words.
    assert recent_words(tmp_path, date(2026, 11, 17), 30) == {"ore", "pie", "sun", "jam"}


def test_is_live_uses_earliest_time_zone():
    from datetime import datetime, timezone

    from generate_puzzle import is_live

    # 09:59 UTC on Nov 16: it's 23:59 Nov 16 in UTC+14, so Nov 17 hasn't started.
    assert not is_live(date(2026, 11, 17), datetime(2026, 11, 16, 9, 59, tzinfo=timezone.utc))
    # 10:00 UTC: midnight Nov 17 in UTC+14, so Nov 17 is live somewhere.
    assert is_live(date(2026, 11, 17), datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc))
    assert is_live(date(2026, 11, 16), datetime(2026, 11, 16, 0, 17, tzinfo=timezone.utc))


def test_cli_skips_dates_before_launch(tmp_path, capsys):
    from generate_puzzle import main

    main(["--date", "2026-10-31", "--no-ai", "--out", str(tmp_path)])
    assert "before launch" in capsys.readouterr().out
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("text, ok", [
    ("From tides to dinner", True),
    ("Take a salty shortcut from rolling waves to a twirl on your fork.", True),
    ("Rock & roll: it's (mostly) fine!", True),
    ("<img src=x onerror=alert(1)>", False),      # markup
    ("Visit https://example.test now", False),    # link
    ("see example.com", False),                   # link without scheme
    ("line one\nline two", False),                # control character
    ("x" * 121, False),                           # too long
    ("", False),
])
def test_ai_display_text_is_plain_and_safe(text, ok):
    from ai_suggest import MAX_TEASER, check_text

    assert (check_text("teaser", text, MAX_TEASER) is None) is ok


def test_ai_text_blocklist():
    from ai_suggest import check_text

    assert check_text("teaser", "A shit route to the goal.", 120) == "teaser contains a blocked word"


def test_unsafe_ai_text_is_rejected_with_feedback(ladder, good_pair):
    s, g = good_pair
    evil = Suggestions(pairs=[Pair(start=s, goal=g, theme="<script>x</script>", teaser="ok")])
    fake = FakeClient([evil, pairs((s, g))])
    puzzle = make_puzzle(ladder, DAY, LEVEL, set(), lambda: fake, quiet)
    assert puzzle["source"] == "ai" and "<" not in puzzle["theme"]
    assert "plain text" in fake.calls[1]["input"][-1]["content"]


def test_prompt_offers_verified_pairs(ladder):
    from ai_suggest import build_request

    band = level_band("hard", ladder.config)
    prompt = build_request(ladder, "2026-11-14", band, set())
    assert "Verified pairs" in prompt
    s, g = prompt.split("\n- ", 1)[1].split("\n")[0].split(" -> ")
    assert validate_pair(ladder, s, g, band).ok
    # Each pair carries a route and the goal's incoming words, so the AI can
    # see which sense of the goal the graph uses (the "anchor" problem).
    lines = prompt.split("\n- ", 1)[1].split("\n")
    route = lines[1].split("shortest route: ")[1].split(" -> ")
    assert route[0] == s and route[-1] == g and len(route) == band["par"] + 1
    incoming = lines[2].split(f"words that step to {g}: ")[1].split(", ")
    assert 1 <= len(incoming) <= 10
    assert all(ladder.index[g] in ladder.neighbors[ladder.index[w]] for w in incoming)


def test_instructions_ask_for_the_routes_sense():
    from ai_suggest import INSTRUCTIONS

    assert "shortest route" in INSTRUCTIONS and "SENSE" in INSTRUCTIONS
    assert "sense the shown route" in INSTRUCTIONS


def test_daily_cron_runs_before_tomorrow_starts_anywhere():
    """Just-in-time schedule: both cron runs must land before UTC+14 reaches
    tomorrow (10:00 UTC), or tomorrow would get the seeded puzzle."""
    import re
    from datetime import datetime, timedelta, timezone
    from pathlib import Path

    from generate_puzzle import is_live

    wf = (Path(__file__).resolve().parent.parent / ".github/workflows/daily-puzzle.yml").read_text()
    crons = re.findall(r'cron: "(\d+) (\d+) \* \* \*"', wf)
    assert len(crons) == 2
    for minute, hour in crons:
        now = datetime(2026, 11, 12, int(hour), int(minute), tzinfo=timezone.utc)
        assert not is_live((now + timedelta(days=1)).date(), now), f"{hour}:{minute} is too late"
    assert "args=(--ahead 1)" in wf
