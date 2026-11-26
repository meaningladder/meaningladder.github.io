# Hints never show the first letter

**Intent:** the user asked that a hint never be the thing that gives away the
first letter of the next word; the first hint shows a random letter instead.

**Goals**
- No hint reveals position 0 of the planned word, on any rung.
- The first hint shows a letter from a random-looking position.
- The last hint still plays the word (no extra move for that one).

**Non-goals**
- The "N letters, starts with X" clue keeps showing the first letter.
- No save wipe or schema bump.

**Constraints**
- Saves store only `rungs[k].hints` (a count), so the shown letters must be
  recomputable: the order is a pure function of the word.
- Same daily word gives every player the same hint letters.

**Approaches**
- *Seeded shuffle from the word (picked):* `fnv1a32(word)` seeds
  `mulberry32`, a Fisher-Yates shuffle orders positions 1..n-1. Deterministic,
  reload-safe, fair across players.
- *True random per click:* rejected, letters would change after a reload and
  differ between players.
- *Fixed pattern (e.g. middle letter first):* rejected, not random and easy
  to learn.

**Decided**
- `hintOrder` in `js/logic.js` becomes the seeded shuffle without position 0,
  for both link and letters clues.
- Link rungs get one fewer hint (an n-letter word takes n-1 hints).
- Mid-rung saves from before the change show different letters, same count.

**Left to the builder:** test shape in `tests/js/linked.test.mjs`.
