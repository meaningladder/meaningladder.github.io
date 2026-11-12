"""Generate daily Meaning Ladder puzzles (Milestone 2).

    python scripts/generate_puzzle.py                     # tomorrow (UTC), all 3 levels
    python scripts/generate_puzzle.py --date 2026-11-12   # a specific day
    python scripts/generate_puzzle.py --ahead 1           # today and tomorrow (the daily job)
    python scripts/generate_puzzle.py --no-ai --dry-run   # seeded only, print, write nothing

Writes puzzles/YYYY-MM-DD-<level>.json (level = easy, medium, hard) and never
overwrites an existing file.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ladder_core import (
    ROOT,
    Ladder,
    LEVELS,
    game_number,
    level_band,
    load_ladder,
    parse_date,
    seed_base,
    seeded_puzzle,
    wants_closer,
)

PUZZLES = ROOT / "puzzles"
SEEDED_THEME = "Daily ladder"


def recent_words(puzzle_dir: Path, day: date, days: int, extra: list[dict] = ()) -> set[str]:
    """Start/goal words used on `day` itself (its other levels) and the `days` days before."""
    words = set()
    for back in range(0, days + 1):
        d = (day - timedelta(days=back)).isoformat()
        for path in puzzle_dir.glob(f"{d}*.json"):  # d-easy.json, d-hard.json, legacy d.json
            p = json.loads(path.read_text(encoding="utf-8"))
            words |= {p["start"], p["goal"]}
    for p in extra:  # puzzles made earlier in this same run (matters for --dry-run)
        if 0 <= (day - parse_date(p["date"])).days <= days:
            words |= {p["start"], p["goal"]}
    return words


def make_puzzle(ladder: Ladder, day: date, level: str, recent: set[str], client_factory,
                log=print) -> dict:
    """Build one puzzle dict for one level: AI first, seeded fallback on any failure."""
    import openai  # only for the exception types

    from ai_suggest import AIUnavailable, ai_puzzle

    date_str = day.isoformat()
    ladder = ladder.at(date_str)  # that day's rules: step limit and level bands
    cfg = ladder.config
    band = level_band(level, cfg)
    closer = (f", closer first moves {band.get('minCloserFirstMoves', 0)}-"
              f"{band.get('maxCloserFirstMoves', 'any')}" if wants_closer(band) else "")
    log(f"{date_str} {band['label']}: par {band['par']}, "
        f"routes {band['minRoutes']}-{band['maxRoutes']}{closer}")

    source, theme, teaser = "seeded", SEEDED_THEME, ""
    try:
        if client_factory is None:
            raise AIUnavailable("AI disabled (--no-ai)")
        pair, verdict = ai_puzzle(ladder, date_str, band, recent, client_factory(), log)
        start, goal, theme, teaser, source = (pair.start, pair.goal, pair.theme.strip(),
                                              pair.teaser.strip(), "ai")
    except (AIUnavailable, openai.OpenAIError) as e:
        # OpenAIError is the base class of every SDK error: network, 429, 401, 5xx...
        log(f"  falling back to seeded puzzle: {type(e).__name__}: {e}")
        if client_factory is not None and os.environ.get("GITHUB_ACTIONS"):
            # Shows as a yellow annotation on the workflow run page.
            print(f"::warning title=Seeded fallback for {date_str} {level}::{type(e).__name__}: {e}")
        start, goal, verdict, attempt = seeded_puzzle(ladder, seed_base(date_str, level), band)
        log(f"  seeded attempt {attempt}: {start} -> {goal} "
            f"(par {verdict.par}, {verdict.routes} routes"
            f"{f', {verdict.closer} closer first moves' if closer else ''})")

    return {
        "date": date_str,
        "gameNumber": game_number(day, parse_date(cfg["launchDate"])),
        "level": level,
        "start": start,
        "goal": goal,
        "par": verdict.par,
        "theme": theme,
        "teaser": teaser,
        "source": source,
        "graphVersion": cfg["graphVersion"],
        "stepLimit": cfg["stepLimit"],
        "twoWay": bool(cfg.get("twoWay")),
    }


def puzzle_filename(date_str: str, level: str | None) -> str:
    return f"{date_str}-{level}.json" if level else f"{date_str}.json"


def write_puzzle(puzzle_dir: Path, puzzle: dict) -> Path:
    """Mode "x" = exclusive create: the OS raises FileExistsError instead of
    overwriting, so even a race between two runs can't clobber a puzzle."""
    puzzle_dir.mkdir(exist_ok=True)
    path = puzzle_dir / puzzle_filename(puzzle["date"], puzzle.get("level"))
    with open(path, "x", encoding="utf-8") as f:
        json.dump(puzzle, f, indent=2)
        f.write("\n")
    return path


def target_dates(args, now: datetime) -> list[date]:
    if args.date:
        return [parse_date(args.date)]
    today = now.date()
    return [today + timedelta(days=i) for i in range(0, args.ahead + 1)]


# The earliest time zone on Earth (Kiribati) is UTC+14.
EARLIEST_UTC_OFFSET = timedelta(hours=14)


def is_live(day: date, now: datetime) -> bool:
    """Has `day` already started somewhere on Earth?

    If so, and its file is missing, some players are already playing the
    browser's seeded fallback. An AI puzzle appearing now would swap their
    puzzle mid-day, so we must write the seeded one instead.
    """
    return day <= (now + EARLIEST_UTC_OFFSET).date()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="YYYY-MM-DD (default: tomorrow in UTC)")
    ap.add_argument("--ahead", type=int, default=1,
                    help="generate today (UTC) through today+N; existing files are "
                         "skipped (ignored with --date)")
    ap.add_argument("--level", choices=LEVELS, help="only this level (default: all three)")
    ap.add_argument("--no-ai", action="store_true", help="skip OpenAI, use the seeded pick")
    ap.add_argument("--dry-run", action="store_true", help="print, don't write files")
    ap.add_argument("--out", type=Path, default=PUZZLES, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    from ai_suggest import make_client

    ladder = load_ladder()
    launch = parse_date(ladder.config["launchDate"])
    now = datetime.now(timezone.utc)
    made: list[dict] = []
    levels = [args.level] if args.level else list(LEVELS)
    for day in target_dates(args, now):
        if day < launch:
            print(f"{day}: before launch ({launch}), skipping")
            continue
        for level in levels:
            path = args.out / puzzle_filename(day.isoformat(), level)
            if path.exists():
                print(f"{day} {level}: {path.name} exists, skipping (puzzles are never overwritten)")
                continue
            use_ai = not args.no_ai
            if use_ai and not args.date and is_live(day, now):
                print(f"{day} {level}: already live somewhere with no file; writing the seeded "
                      f"puzzle so it matches what browsers already show")
                use_ai = False
            recent = recent_words(args.out, day, ladder.config["recentDays"], made)
            puzzle = make_puzzle(ladder, day, level, recent, make_client if use_ai else None)
            made.append(puzzle)
            if args.dry_run:
                print(json.dumps(puzzle, indent=2))
            else:
                print(f"  wrote {write_puzzle(args.out, puzzle)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
