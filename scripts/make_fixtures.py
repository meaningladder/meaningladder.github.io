"""Write tests/fixtures/seeded_vectors.json: golden values from the Python
implementation that the JavaScript port (js/seeded.js) must reproduce exactly.

    python scripts/make_fixtures.py
"""
import json
from datetime import date, timedelta

from ladder_core import (ROOT, LEVELS, chain_reasons, fnv1a32, game_number, is_chain, level_band,
                         load_ladder, mulberry32, seed_base, seeded_chain, seeded_puzzle)

OUT = ROOT / "tests" / "fixtures" / "seeded_vectors.json"
HASH_INPUTS = ["", "a", "foobar", "2026-11-12#0", "2026-11-12#1", "sample#2026-11-12", "héllo"]
SEEDS = [0, 1, 42, 0xDEADBEEF, 0xFFFFFFFF]
# Nov 13-14 are the only chain days; Nov 15 on is open again (top 10 both ways).
# Two days under the original top-100 rules (open ladders), then chain days
# (from 2026-11-13): ordinary ones, a DST-change day
# (US: 2027-03-14) and a leap day.
DATES = ["2026-11-05", "2026-11-12"] + [
    (date(2026, 11, 13) + timedelta(days=i)).isoformat() for i in range(3)] + ["2027-03-14", "2028-02-29"]


def main() -> None:
    ladder = load_ladder()
    launch = date.fromisoformat(ladder.config["launchDate"])
    puzzles, chains = [], []
    for d in DATES:
        day = date.fromisoformat(d)
        dated = ladder.at(d)
        for level in LEVELS:
            band = level_band(level, dated.config)
            if is_chain(dated.config):
                words, verdict, attempt = seeded_chain(dated, seed_base(d, level), band)
                chains.append({"date": d, "level": level, "gameNumber": game_number(day, launch),
                               "route": words, "reasons": chain_reasons(dated, words),
                               "linked": verdict.closer, "attempt": attempt})
                print(f"  {d} {level}: {' -> '.join(words)} (attempt {attempt})")
                continue
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
        "chains": chains,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n": the repo is LF-only, and Windows text mode would write CRLF.
    OUT.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
