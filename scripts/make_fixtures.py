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
# Two days under the original top-100 rules, then ordinary top-20 days, a
# DST-change day (US: 2027-03-14) and a leap day.
DATES = ["2026-11-05", "2026-11-12"] + [(date(2026, 11, 16) + timedelta(days=i)).isoformat() for i in range(3)] + [
    "2027-03-14", "2028-02-29"]


def main() -> None:
    ladder = load_ladder()
    launch = date.fromisoformat(ladder.config["launchDate"])
    puzzles = []
    for d in DATES:
        day = date.fromisoformat(d)
        dated = ladder.at(d)
        for level in LEVELS:
            band = level_band(level, dated.config)
            start, goal, verdict, attempt = seeded_puzzle(dated, seed_base(d, level), band)
            puzzles.append({"date": d, "level": level, "stepLimit": dated.config["stepLimit"],
                            "gameNumber": game_number(day, launch),
                            "start": start, "goal": goal, "par": verdict.par,
                            "routes": verdict.routes, "closer": verdict.closer,
                            "attempt": attempt})
            print(f"  {d} {level}: {start} -> {goal} (par {verdict.par}, attempt {attempt})")

    fixture = {
        "fnv1a32": {s: fnv1a32(s) for s in HASH_INPUTS},
        "mulberry32": {str(s): [r() for r in [mulberry32(s)] for _ in range(5)] for s in SEEDS},
        "puzzles": puzzles,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n": the repo is LF-only, and Windows text mode would write CRLF.
    OUT.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
