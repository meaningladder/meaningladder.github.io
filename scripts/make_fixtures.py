"""Write tests/fixtures/seeded_vectors.json: golden values from the Python
implementation that the JavaScript port (js/seeded.js) must reproduce exactly.

    python scripts/make_fixtures.py
"""
import json
from datetime import date, timedelta

from ladder_core import ROOT, band_for, fnv1a32, game_number, load_ladder, mulberry32, seeded_puzzle

OUT = ROOT / "tests" / "fixtures" / "seeded_vectors.json"
HASH_INPUTS = ["", "a", "foobar", "2026-11-12#0", "2026-11-12#1", "sample#2026-11-12", "héllo"]
SEEDS = [0, 1, 42, 0xDEADBEEF, 0xFFFFFFFF]
# One full week plus a DST-change week (US: 2027-03-14) and a leap day.
DATES = [(date(2026, 11, 16) + timedelta(days=i)).isoformat() for i in range(7)] + [
    "2027-03-14", "2027-03-15", "2028-02-29"]


def main() -> None:
    ladder = load_ladder()
    launch = date.fromisoformat(ladder.config["launchDate"])
    puzzles = []
    for d in DATES:
        day = date.fromisoformat(d)
        start, goal, verdict, attempt = seeded_puzzle(ladder, d, band_for(day, ladder.config))
        puzzles.append({"date": d, "gameNumber": game_number(day, launch),
                        "weekday": band_for(day, ladder.config)["weekday"],
                        "start": start, "goal": goal, "par": verdict.par,
                        "routes": verdict.routes, "attempt": attempt})
        print(f"  {d}: {start} -> {goal} (par {verdict.par}, attempt {attempt})")

    fixture = {
        "fnv1a32": {s: fnv1a32(s) for s in HASH_INPUTS},
        "mulberry32": {str(s): [r() for r in [mulberry32(s)] for _ in range(5)] for s in SEEDS},
        "puzzles": puzzles,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
