"""Ask OpenAI to suggest today's start/goal pair, then fact-check it.

This is the only file that talks to the network. The OpenAI client is passed
in, so tests can hand it a fake and never spend money or need a key.
"""
from __future__ import annotations

import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Callable

from pydantic import BaseModel

from ladder_core import (Ladder, Verdict, guide_route, incoming_words, rel_key, same_stem,
                         seeded_chain, seeded_sample, shortest_route, shortlist, validate_chain,
                         validate_pair)

PAIRS_PER_ROUND = 5
MAX_THEME = 40
MAX_TEASER = 120
MAX_REASON = 90


class Pair(BaseModel):
    start: str
    goal: str
    theme: str
    teaser: str
    # One short sentence per step of the pair's shown route, in order: why
    # each word leads to the next. Shown after the game so every ladder
    # makes sense, and a pair whose route can't be explained is skipped.
    reasons: list[str]


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
- Each verified pair shows one shortest route and some of the words that lead
  into the goal. They reveal which SENSE of the goal the word graph uses (e.g.
  "anchor" reached via presenter and newscast is the TV anchor, not the
  ship's). Skip a pair whose route or incoming words use a different sense
  than the one a player would naturally guess, or than your theme.
- Route steps may carry a ConceptNet relation in brackets, e.g.
  "cafe -[IsA]-> restaurant -[AtLocation]-> grill". These are real-world
  reasons the two words connect: prefer pairs with many of them, and let the
  theme follow that chain of reasons.
- Start and goal should feel far apart, but be bridgeable through a chain of
  related ideas. Prefer vivid, concrete, family-friendly words.
- Never use any word from the "recently used" list.
- theme: 1-4 words (max {MAX_THEME} characters, plain text) naming the idea that links the pair (e.g. "From sea to silicon").
- teaser: one playful sentence, at most {MAX_TEASER} characters, that hints at a
  possible route WITHOUT naming any intermediate word.
- Theme and teaser must be about the sense the shown route and incoming words
  actually use, so they point players the right way, never a different sense.
- reasons: for the pair you pick, one short plain sentence per step of its
  shown route, in order (a route of N steps needs exactly N sentences, at most
  {MAX_REASON} characters each), saying why each word leads to the next, e.g.
  "A cafe is a small restaurant." or "Kerosene is a fuel." Every step must make
  sense to an ordinary player. If any step of a pair's route would not, do not
  pick that pair.
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


INCOMING_SHOWN = 10  # enough to reveal a sense, short enough to keep the prompt small


def _pair_listing(ladder: Ladder, start: str, goal: str, incoming: list[str]) -> str:
    s, g = ladder.index[start], ladder.index[goal]
    if ladder.related and ladder.config.get("twoWay"):  # the route the game will show
        route = guide_route(ladder.neighbors, ladder.related, s, g)
        hops = [f" -[{ladder.related[rel_key(a, b)]}]-> " if rel_key(a, b) in ladder.related else " -> "
                for a, b in zip(route, route[1:])]
        text = ladder.words[route[0]] + "".join(hop + ladder.words[b] for hop, b in zip(hops, route[1:]))
    else:
        route = shortest_route(ladder.neighbors, s, g)
        text = " -> ".join(ladder.words[i] for i in route)
    return (f"- {start} -> {goal}\n"
            f"    shortest route: {text}\n"
            f"    words that step to {goal}: {', '.join(incoming)}")


def build_request(ladder: Ladder, date_str: str, band: dict, recent: set[str]) -> str:
    # Preferred: pairs the graph has already verified for today's band.
    # Seed by date AND level, so a day's three shortlists start from different words.
    pairs = shortlist(ladder, f"{date_str}:{band['level']}", band, recent)
    if len(pairs) >= PAIRS_PER_ROUND:
        # The route and the goal's incoming words show the AI which sense the
        # graph means; without them it themed "anchor" as nautical while
        # every way in was a TV presenter.
        incoming = incoming_words(ladder, sorted({g for _, g, _ in pairs}), INCOMING_SHOWN)
        listing = "\n".join(_pair_listing(ladder, s, g, incoming[g]) for s, g, _ in pairs)
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


def ask(client, model: str, messages: list[dict], text_format=None, instructions=None):
    """One structured-output call. Raises AIUnavailable on refusal/truncation."""
    response = client.responses.parse(
        model=model,
        instructions=instructions or INSTRUCTIONS,
        input=messages,
        text_format=text_format or Suggestions,
        max_output_tokens=16000,  # three chains with reasons and clues, plus reasoning (8000 ran out on Hard)
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


def shown_route(ladder: Ladder, start: str, goal: str) -> list[str]:
    """The route the game shows for this pair: a shortest route with the most
    ConceptNet-relation steps (guide_route), else any shortest route."""
    s, g = ladder.index[start], ladder.index[goal]
    # guide_route searches from the goal, which needs links that work both
    # ways; one-way eras (before Nov 13) get a plain shortest route.
    two_way = ladder.related and ladder.config.get("twoWay")
    route = (guide_route(ladder.neighbors, ladder.related, s, g) if two_way
             else shortest_route(ladder.neighbors, s, g))
    return [ladder.words[i] for i in route]


def check_pair(ladder: Ladder, pair: Pair, band: dict, recent: set[str]) -> Verdict:
    start, goal = pair.start.strip().lower(), pair.goal.strip().lower()
    for field, text, limit in (("theme", pair.theme, MAX_THEME), ("teaser", pair.teaser, MAX_TEASER)):
        reason = check_text(field, text, limit)
        if reason:
            return Verdict(False, reason)
    verdict = validate_pair(ladder, start, goal, band, recent)
    if not verdict.ok:
        return verdict
    # Every ladder must make sense: one checked, plain sentence per step.
    if len(pair.reasons) != verdict.par:
        return Verdict(False, f"{len(pair.reasons)} reasons for a {verdict.par}-step route, "
                              f"need exactly {verdict.par}", verdict.par, verdict.routes, verdict.closer)
    for k, text in enumerate(pair.reasons, 1):
        bad = check_text(f"reason {k}", text, MAX_REASON)
        if bad:
            return Verdict(False, bad, verdict.par, verdict.routes, verdict.closer)
    return verdict


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
                pair.reasons = [r.strip() for r in pair.reasons]
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


# ---------------------------------------------------------------- chain mode
# From the 2026-11-15 era every ladder is one fixed 5-step chain with one
# answer per rung. The AI writes the whole chain, a reason and a clue per
# step, and labels each link; validate_chain (ladder_core) checks it all.
CHAINS_PER_ROUND = 3
MAX_CLUE = 90
CHAIN_EXAMPLES = 4


class Chain(BaseModel):
    words: list[str]    # start, the hidden rungs, goal
    reasons: list[str]  # one per step: why the word leads to the next
    clues: list[str]    # one per step: a hint for the next word that never names it
    kinds: list[str]    # one per step: "everyday" or "lateral"
    theme: str
    teaser: str


class ChainSuggestions(BaseModel):
    chains: list[Chain]


LEVEL_STYLE = {
    "easy": "Every link is an everyday fact or a very common pairing (a kind of, a part of, "
            "used for, found at). No double meanings or wordplay: every kind is \"everyday\".",
    "medium": "Mostly everyday links, plus 1 or 2 lateral ones: a second meaning of a word, "
              "a set phrase, or a cultural link (e.g. butterfly -> swimming: a stroke).",
    "hard": "At least 2 lateral links (second meanings, set phrases, cultural links, e.g. "
            "turkey -> country), the rest everyday. Still fair: an ordinary adult should "
            "say \"of course\" once they see the reason.",
}

CHAIN_INSTRUCTIONS = f"""\
You design the daily puzzle for "Meaning Ladder", a word game. A ladder is a
chain of words: START, hidden words, GOAL. Players see the start, the goal,
and for each hidden word only its first letter and length. They must guess
each hidden word from the one below it, and only the intended word counts.

Suggest {CHAINS_PER_ROUND} different chains, best first. Rules:
- words: exactly N+1 single lowercase common English words for N steps
  (the request says N), start first, goal last. START and GOAL must come from
  the allowed list, spelled exactly; hidden words can be any common word.
- Each hidden word must be the obvious, natural next word after the one
  before it. If several words could follow, the first letter and length must
  pick out just yours.
- No two words in a chain may be forms of one word (ship, ships).
- reasons: one short plain sentence per step (N of them), at most
  {MAX_REASON} characters, saying why the word leads to the next, e.g.
  "A ship docks at a port."
- clues: one short plain hint per step (N of them), at most {MAX_CLUE}
  characters, pointing at the NEXT word without naming it or any form of it,
  e.g. "Where a ship ties up."
- kinds: one per step, "everyday" or "lateral" (a second meaning, a set
  phrase, wordplay or a cultural link).
- theme: 1-4 words (max {MAX_THEME} characters) naming the journey.
- teaser: one playful sentence, at most {MAX_TEASER} characters, that names
  no hidden word.
- Family-friendly. Never use a "recently used" word as start or goal.
- "Example chains" (if listed) already fit our word graph; you may use one,
  improve one, or write your own.
"""


def build_chain_request(ladder: Ladder, date_str: str, band: dict, recent: set[str]) -> str:
    level, par = band["level"], band["par"]
    examples = []
    for i in range(CHAIN_EXAMPLES):
        try:
            words, _, _ = seeded_chain(ladder, f"examples#{date_str}:{level}:{i}", band)
        except RuntimeError:
            continue
        if not recent & {words[0], words[-1]}:
            examples.append(" -> ".join(words))
    sample = seeded_sample(ladder.candidates, ladder.config["promptSampleSize"],
                           f"sample#{date_str}:{level}")
    sample = [w for w in sample if w not in recent]
    shown = "".join(f"- {e}\n" for e in examples)
    return (
        f"Date: {date_str}. Level: {band['label']}. Steps: N = {par} "
        f"({par + 1} words, {par - 1} hidden).\n"
        f"{LEVEL_STYLE.get(level, '')}\n\n"
        + (f"Example chains:\n{shown}\n" if examples else "")
        + f"Allowed start/goal words: {', '.join(sorted(sample))}\n\n"
        f"Recently used (do not use): {', '.join(sorted(recent)) or 'none'}"
    )


def names_word(clue: str, word: str) -> bool:
    """Does the clue give its answer away (the word or a form of it)?"""
    return any(same_stem(t, word) for t in re.findall(r"[a-z]+", clue.lower()))


def check_chain(ladder: Ladder, chain: Chain, band: dict, recent: set[str]) -> Verdict:
    par = band["par"]
    for field, text, limit in (("theme", chain.theme, MAX_THEME), ("teaser", chain.teaser, MAX_TEASER)):
        bad = check_text(field, text, limit)
        if bad:
            return Verdict(False, bad)
    words = [w.strip().lower() for w in chain.words]
    blocked = set(words) & _blocklist()
    if blocked:
        return Verdict(False, f"'{sorted(blocked)[0]}' is not family-friendly")
    for field, items, limit in (("reasons", chain.reasons, MAX_REASON), ("clues", chain.clues, MAX_CLUE)):
        if len(items) != par:
            return Verdict(False, f"{len(items)} {field} for {par} steps, need exactly {par}")
        for k, text in enumerate(items, 1):
            bad = check_text(f"{field[:-1]} {k}", text, limit)
            if bad:
                return Verdict(False, bad)
    for k, clue in enumerate(chain.clues, 1):
        if k < len(words) and names_word(clue, words[k]):
            return Verdict(False, f"clue {k} names its answer '{words[k]}'")
    teaser = re.findall(r"[a-z]+", chain.teaser.lower())
    for w in words[1:-1]:
        if any(same_stem(t, w) for t in teaser):
            return Verdict(False, f"the teaser names the hidden word '{w}'")
    return validate_chain(ladder, words, band, recent,
                          [k.strip().lower() for k in chain.kinds], graph_checks=False)


def ai_chain(ladder: Ladder, date_str: str, band: dict, recent: set[str], client,
             log: Callable[[str], None] = print) -> tuple[Chain, Verdict]:
    """Ask, check, give feedback, repeat (like ai_puzzle). Raises AIUnavailable."""
    model = ladder.config["model"]
    messages = [{"role": "user", "content": build_chain_request(ladder, date_str, band, recent)}]
    # A time budget per level: chains take the model much longer than pairs,
    # and three levels must finish well inside the workflow's time limit.
    deadline = time.monotonic() + ladder.config.get("aiSecondsPerLevel", 360)
    for round_no in range(1, ladder.config["aiRounds"] + 1):
        if round_no > 1 and time.monotonic() > deadline:
            raise AIUnavailable(f"out of time after {round_no - 1} rounds")
        started = time.monotonic()
        suggestions = ask(client, model, messages, ChainSuggestions, CHAIN_INSTRUCTIONS)
        log(f"  AI round {round_no}: answered in {time.monotonic() - started:.0f}s")
        feedback = []
        for chain in suggestions.chains:
            verdict = check_chain(ladder, chain, band, recent)
            label = " -> ".join(chain.words)
            if verdict.ok:
                log(f"  AI round {round_no}: accepted {label} ({verdict.closer} known relations)")
                chain.words = [w.strip().lower() for w in chain.words]
                chain.kinds = [k.strip().lower() for k in chain.kinds]
                chain.reasons = [r.strip() for r in chain.reasons]
                chain.clues = [c.strip() for c in chain.clues]
                chain.theme, chain.teaser = chain.theme.strip(), chain.teaser.strip()
                return chain, verdict
            feedback.append(f"- {label}: {verdict.reason}")
        log(f"  AI round {round_no}: all {len(suggestions.chains)} chains rejected")
        for line in feedback:
            log("    " + line)
        messages.append({"role": "assistant", "content": suggestions.model_dump_json()})
        messages.append({"role": "user", "content":
                         "None of those chains work:\n" + "\n".join(feedback)
                         + f"\nSuggest {CHAINS_PER_ROUND} new chains following the same rules."})
    raise AIUnavailable(f"no valid chain after {ladder.config['aiRounds']} rounds")


def make_client():
    """Real OpenAI client, reading OPENAI_API_KEY from the environment."""
    import os

    import openai

    if not os.environ.get("OPENAI_API_KEY"):
        raise AIUnavailable("OPENAI_API_KEY is not set")
    # One slow call must not eat the whole job: give up on it after 4 minutes
    # (one retry), and the caller falls back to the seeded puzzle.
    return openai.OpenAI(timeout=240, max_retries=1)

