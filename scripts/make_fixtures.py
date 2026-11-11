"""Write tests/fixtures/seeded_vectors.json: golden values from the Python
implementation that the JavaScript port (js/seeded.js) must reproduce exactly.

    python scripts/make_fixtures.py
"""
import json
from datetime import date, timedelta

from ladder_core import (ROOT, LEVELS, fnv1a32, game_number, level_band, load_ladder,
                         mulberry32, seed_base, seeded_puzzle)

OUT = ROOT / "tests" / "fixtures" / "seeded_vectors.json"
HASH_INPUTS = ["", "a", "foobar", "2026-11-12#0", "2026-11-12#1", "sample#2026-11-12", "héllo"]
SEEDS = [0, 1, 42, 0xDEADBEEF, 0xFFFFFFFF]
# A few ordinary days plus a DST-change day (US: 2027-03-14) and a leap day.
DATES = [(date(2026, 11, 16) + timedelta(days=i)).isoformat() for i in range(3)] + [
    "2027-03-14", "2028-02-29"]


def main() -> None:
    ladder = load_ladder()
    launch = date.fromisoformat(ladder.config["launchDate"])
    puzzles = []
    for d in DATES:
        day = date.fromisoformat(d)
        for level in LEVELS:
            band = level_band(level, ladder.config)
            start, goal, verdict, attempt = seeded_puzzle(ladder, seed_base(d, level), band)
            puzzles.append({"date": d, "level": level, "gameNumber": game_number(day, launch),
                            "start": start, "goal": goal, "par": verdict.par,
                            "routes": verdict.routes, "attempt": attempt})
            print(f"  {d} {level}: {start} -> {goal} (par {verdict.par}, attempt {attempt})")

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
