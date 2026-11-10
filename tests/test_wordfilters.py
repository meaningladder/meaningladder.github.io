"""Fast unit tests for the word rules. No GloVe download needed."""
import pytest

from wordfilters import (
    common_prefix_len,
    is_concrete_noun,
    is_dictionary_word,
    is_trivial_pair,
    is_valid_vocab_word,
)

STOP = {"the", "and", "with"}
BLOCK = {"badword"}
ALLOW = {"selfie"}


@pytest.mark.parametrize("word, ok", [
    ("ocean", True),
    ("volcanoes", True),    # inflected forms are fine as words...
    ("the", False),         # stopword
    ("ab", False),          # too short
    ("x2y", False),         # not alphabetic
    ("Ocean", False),       # not lowercase
    ("badword", False),     # blocklisted
    ("badwords", False),    # inflection of a blocklisted word
    ("paris", False),       # proper noun only ('Paris')
    ("obama", False),       # not in WordNet at all
    ("selfie", True),       # not in WordNet, but allowlisted
])
def test_is_valid_vocab_word(word, ok):
    assert is_valid_vocab_word(word, STOP, BLOCK, ALLOW) is ok


def test_dictionary_keeps_common_sense_of_ambiguous_names():
    assert is_dictionary_word("china")  # porcelain
    assert not is_dictionary_word("paris")


@pytest.mark.parametrize("a, b, trivial", [
    ("volcano", "volcanoes", True),   # plural (shared lemma)
    ("volcano", "volcanic", True),    # derived form (shared prefix)
    ("mouse", "mice", True),          # irregular plural
    ("see", "saw", True),             # irregular past tense
    ("music", "musical", True),
    ("ocean", "ocean", True),
    ("car", "cart", False),           # short prefix: different words
    ("ocean", "sea", False),
    ("computer", "computing", True),  # same root 'comput' (6 >= 75% of 8)
    ("card", "cardinal", False),      # prefix only 4 chars
    ("planet", "plantation", False),  # 'plan' is too short a shared prefix
])
def test_is_trivial_pair(a, b, trivial):
    assert is_trivial_pair(a, b) is trivial
    assert is_trivial_pair(b, a) is trivial  # the rule is symmetric


def test_common_prefix_len():
    assert common_prefix_len("volcano", "volcanic") == 6
    assert common_prefix_len("abc", "xyz") == 0


@pytest.mark.parametrize("word, ok", [
    ("volcano", True), ("tomato", True), ("ankle", True), ("scientist", True),
    ("volcanoes", False),  # plural
    ("colours", False),    # inflection of 'colour'
    ("freedom", False),    # abstract
    ("white", False),      # mostly an adjective
    ("napoleon", False),   # mostly a name
])
def test_is_concrete_noun(word, ok):
    assert is_concrete_noun(word) is ok
