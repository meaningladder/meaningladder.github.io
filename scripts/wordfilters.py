"""Pure word-filtering rules for the Meaning Ladder graph builder.

Everything here is a plain function of its inputs (plus the WordNet
dictionary), so it can be unit-tested in milliseconds without loading
the 376 MB GloVe model.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from nltk.corpus import wordnet as wn

WORD_RE = re.compile(r"^[a-z]{3,}$")
POS_TAGS = ("n", "v", "a", "r")  # noun, verb, adjective, adverb

# Trivial-prefix rule: shared prefix must be at least this long ...
PREFIX_MIN_CHARS = 5
# ... AND cover at least this fraction of the shorter word.
PREFIX_MIN_RATIO = 0.75


def load_wordlist(path: Path) -> set[str]:
    """Read a one-word-per-line file. Blank lines and '#' comments are skipped.
    Multi-word phrases are ignored (our vocabulary is single tokens only)."""
    words = set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip().lower()
        if line and not line.startswith("#") and " " not in line:
            words.add(line)
    return words


@lru_cache(maxsize=None)
def base_forms(word: str) -> frozenset[str]:
    """Every dictionary base form of `word` across all parts of speech.

    volcanoes -> {volcano}, mice -> {mouse}, saw -> {saw, see}.
    Note: WordNet's morphy is case-insensitive, so 'paris' -> {'paris'}
    even though the real entry is 'Paris'. See `lowercase_base_forms`.
    """
    forms = set()
    for pos in POS_TAGS:
        forms.update(wn._morphy(word, pos))  # all bases, not just the first
    return frozenset(forms)


@lru_cache(maxsize=None)
def lowercase_base_forms(word: str) -> frozenset[str]:
    """Base forms that exist in WordNet as a *lowercase* single-word lemma.

    This is how we tell common words from proper nouns: 'paris' only appears
    as 'Paris', so it gets an empty set; 'china' also has 'china' (porcelain),
    so it survives.
    """
    keep = set()
    for base in base_forms(word):
        for synset in wn.synsets(base):
            if any(lemma.name() == base for lemma in synset.lemmas()):
                keep.add(base)
                break
    return frozenset(keep)


def is_dictionary_word(word: str) -> bool:
    return bool(lowercase_base_forms(word))


def is_valid_vocab_word(
    word: str,
    stopwords: set[str],
    blocklist: set[str],
    allowlist: set[str] = frozenset(),
) -> bool:
    """Should `word` be on the map at all?"""
    if not WORD_RE.match(word):
        return False
    if word in stopwords:
        return False
    # Block the word and any inflection of a blocked word.
    if word in blocklist or base_forms(word) & blocklist:
        return False
    if word in allowlist:
        return True
    return is_dictionary_word(word)


def common_prefix_len(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def is_trivial_pair(a: str, b: str) -> bool:
    """Is `b` just another form of `a` (so stepping a -> b would be free)?

    True when:
      * they share a dictionary base form (volcanoes/volcano, mice/mouse), or
      * they share a long prefix (volcan-o / volcan-ic, music / music-al).
    """
    if a == b:
        return True
    forms_a = base_forms(a) | {a}
    forms_b = base_forms(b) | {b}
    if forms_a & forms_b:
        return True
    p = common_prefix_len(a, b)
    return p >= PREFIX_MIN_CHARS and p >= PREFIX_MIN_RATIO * min(len(a), len(b))


# Hypernym roots that mean "a thing you could point at": objects, people,
# animals and places (object), food and materials (matter), body parts and
# bodies of water (thing). Excludes processes, phenomena and abstractions.
_CONCRETE_ROOTS = {
    wn.synset("object.n.01"),
    wn.synset("matter.n.03"),
    wn.synset("thing.n.12"),
}


def _usage(word: str) -> dict[str, int]:
    """How often `word` was tagged in WordNet's sense-annotated corpus (SemCor),
    split into lowercase noun / capitalized noun (proper) / adjective."""
    c = {"noun": 0, "proper": 0, "adj": 0}
    for s in wn.synsets(word):
        for lemma in s.lemmas():
            if lemma.name().lower() != word:
                continue
            if s.pos() == "n":
                c["noun" if lemma.name() == word else "proper"] += lemma.count()
            elif s.pos() in ("a", "s"):
                c["adj"] += lemma.count()
    return c


@lru_cache(maxsize=None)
def is_concrete_noun(word: str) -> bool:
    """Could `word` be a fun start/goal? A singular, common, concrete noun.

    volcano, tomato, ankle, scientist -> True
    volcanoes (plural), colours (form of colour), freedom (abstract),
    white (mostly an adjective), napoleon (mostly a name) -> False
    """
    # 1. It must be a lowercase noun lemma, and not an inflection of another one.
    senses = [s for s in wn.synsets(word, "n")
              if any(l.name() == word for l in s.lemmas())]
    if not senses or wn._morphy(word, "n") != [word]:
        return False
    usage = _usage(word)
    # 2. Not mostly an adjective (white, short, developing).
    if usage["adj"] > usage["noun"]:
        return False
    # 3. Not mostly a proper noun (Napoleon, Collins). Ties at 0 count as names.
    if usage["proper"] > 0 or any(l.name() == word.capitalize()
                                  for s in wn.synsets(word, "n") for l in s.lemmas()):
        if usage["proper"] >= usage["noun"]:
            return False
    # 4. Its most common lowercase sense must be a physical thing.
    first = senses[0]
    return any(_CONCRETE_ROOTS & set(path) for path in first.hypernym_paths())
