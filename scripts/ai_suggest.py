"""Ask OpenAI to suggest today's start/goal pair, then fact-check it.

This is the only file that talks to the network. The OpenAI client is passed
in, so tests can hand it a fake and never spend money or need a key.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Callable

from pydantic import BaseModel

from ladder_core import Ladder, Verdict, seeded_sample, shortlist, validate_pair

PAIRS_PER_ROUND = 5
MAX_THEME = 40
MAX_TEASER = 120


class Pair(BaseModel):
    start: str
    goal: str
    theme: str
    teaser: str


class Suggestions(BaseModel):
    pairs: list[Pair]


class AIUnavailable(Exception):
    """The AI couldn't give us a usable answer, so the caller should use the seeded fallback."""


INSTRUCTIONS = f"""\
You design the daily puzzle for "Meaning Ladder", a word game. Players climb
from a START word to a GOAL word one step at a time; each step must be a word
close in meaning to the previous one (word-embedding neighbors).

Suggest {PAIRS_PER_ROUND} different (start, goal) pairs, best first. Rules:
- If the request lists "Verified pairs", choose ONLY from those, exactly as
  written: they already have the right difficulty. Pick the ones that make the
  most fun, surprising journey. Otherwise both words MUST come from the
  allowed word list, spelled exactly.
- Start and goal should feel far apart, but be bridgeable through a chain of
  related ideas. Prefer vivid, concrete, family-friendly words.
- Never use any word from the "recently used" list.
- theme: 1-4 words (max {MAX_THEME} characters, plain text) naming the idea that links the pair (e.g. "From sea to silicon").
- teaser: one playful sentence, at most {MAX_TEASER} characters, that hints at a
  possible route WITHOUT naming any intermediate word.
"""

DIFFICULTY_HINTS = {
    3: "The pair should be about 3 meaning-steps apart: related through one or "
       "two intermediate ideas, not obvious partners like ocean -> boat.",
    4: "The pair should be about 4 meaning-steps apart: from clearly different "
       "domains of life (e.g. a food and a machine, an animal and a building).",
    5: "The pair should be about 5 small meaning-steps apart: different domains, "
       "linked by a story of several clearly related ideas.",
    6: "The pair should be about 6 small meaning-steps apart: far-flung domains "
       "that still connect through a long chain of obvious neighbors.",
}


def build_request(ladder: Ladder, date_str: str, band: dict, recent: set[str]) -> str:
    # Preferred: pairs the graph has already verified for today's band.
    # Seed by date AND level, so a day's three shortlists start from different words.
    pairs = shortlist(ladder, f"{date_str}:{band['level']}", band, recent)
    if len(pairs) >= PAIRS_PER_ROUND:
        listing = "\n".join(f"- {s} -> {g}" for s, g, _ in pairs)
        return (
            f"Date: {date_str}. Level: {band['label']}.\n\n"
            f"Verified pairs (choose only from these):\n{listing}"
        )
    # Fallback: free choice from a word sample (validated afterwards as always).
    sample = seeded_sample(ladder.candidates, ladder.config["promptSampleSize"],
                           f"sample#{date_str}")
    sample = [w for w in sample if w not in recent]
    return (
        f"Date: {date_str}. Level: {band['label']}.\n"
        f"{DIFFICULTY_HINTS.get(band['par'], '')}\n"
        f"{'Fewer obvious routes is better today.' if band['minRoutes'] <= 5 else ''}\n\n"
        f"Allowed words: {', '.join(sorted(sample))}\n\n"
        f"Recently used (do not use): {', '.join(sorted(recent)) or 'none'}"
    )


def ask(client, model: str, messages: list[dict]) -> Suggestions:
    """One structured-output call. Raises AIUnavailable on refusal/truncation."""
    response = client.responses.parse(
        model=model,
        instructions=INSTRUCTIONS,
        input=messages,
        text_format=Suggestions,
        max_output_tokens=4000,
    )
    if getattr(response, "status", None) == "incomplete":
        reason = getattr(response.incomplete_details, "reason", "unknown")
        raise AIUnavailable(f"response incomplete ({reason})")
    for item in response.output:
        if item.type != "message":
            continue
        for part in item.content:
            if part.type == "refusal":
                raise AIUnavailable(f"model refused: {part.refusal}")
    if response.output_parsed is None:
        raise AIUnavailable("no parsed output")
    return response.output_parsed


@lru_cache(maxsize=1)
def _blocklist() -> frozenset[str]:
    # Read directly (not via wordfilters) so the daily job doesn't need WordNet data.
    path = Path(__file__).resolve().parent / "lists" / "blocklist_en.txt"
    words = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip().lower()
        if line and not line.startswith("#") and " " not in line:
            words.add(line)
    return frozenset(words)


# Plain text only: letters, digits, spaces and everyday punctuation. No markup,
# no URLs, no control characters. The browser renders these as text anyway;
# this is defense in depth against a model output we didn't expect.
_SAFE_TEXT = re.compile(r"^[A-Za-z0-9 ,.!?'’\-:;&()]+$")


def check_text(field: str, text: str, max_len: int) -> str | None:
    """Return a rejection reason for AI-written display text, or None if OK."""
    text = text.strip()
    if not text:
        return f"empty {field}"
    if len(text) > max_len:
        return f"{field} longer than {max_len} characters"
    if not _SAFE_TEXT.match(text):
        return f"{field} has characters outside plain text"
    lowered = text.lower()
    if "http" in lowered or "www." in lowered or ".com" in lowered:
        return f"{field} looks like it contains a link"
    if set(re.findall(r"[a-z]+", lowered)) & _blocklist():
        return f"{field} contains a blocked word"
    return None


def check_pair(ladder: Ladder, pair: Pair, band: dict, recent: set[str]) -> Verdict:
    start, goal = pair.start.strip().lower(), pair.goal.strip().lower()
    for field, text, limit in (("theme", pair.theme, MAX_THEME), ("teaser", pair.teaser, MAX_TEASER)):
        reason = check_text(field, text, limit)
        if reason:
            return Verdict(False, reason)
    return validate_pair(ladder, start, goal, band, recent)


def ai_puzzle(
    ladder: Ladder,
    date_str: str,
    band: dict,
    recent: set[str],
    client,
    log: Callable[[str], None] = print,
) -> tuple[Pair, Verdict]:
    """Ask, check, give feedback, repeat. Returns the first valid pair.

    Raises AIUnavailable if every round fails (caller falls back to seeded).
    API errors (network, rate limit, bad key) propagate as openai exceptions;
    the caller treats them the same way.
    """
    model = ladder.config["model"]
    messages = [{"role": "user", "content": build_request(ladder, date_str, band, recent)}]
    for round_no in range(1, ladder.config["aiRounds"] + 1):
        suggestions = ask(client, model, messages)
        feedback = []
        for pair in suggestions.pairs:
            verdict = check_pair(ladder, pair, band, recent)
            if verdict.ok:
                log(f"  AI round {round_no}: accepted {pair.start} -> {pair.goal} "
                    f"(par {verdict.par}, {verdict.routes} routes)")
                pair.start, pair.goal = pair.start.strip().lower(), pair.goal.strip().lower()
                return pair, verdict
            feedback.append(f"- {pair.start} -> {pair.goal}: {verdict.reason}")
        log(f"  AI round {round_no}: all {len(suggestions.pairs)} pairs rejected")
        for line in feedback:
            log("    " + line)
        messages.append({"role": "assistant", "content": suggestions.model_dump_json()})
        messages.append({"role": "user", "content":
                         "None of those pairs work in our word graph:\n" + "\n".join(feedback)
                         + f"\nSuggest {PAIRS_PER_ROUND} new pairs following the same rules."})
    raise AIUnavailable(f"no valid pair after {ladder.config['aiRounds']} rounds")


def make_client():
    """Real OpenAI client, reading OPENAI_API_KEY from the environment."""
    import os

    import openai

    if not os.environ.get("OPENAI_API_KEY"):
        raise AIUnavailable("OPENAI_API_KEY is not set")
    return openai.OpenAI()

