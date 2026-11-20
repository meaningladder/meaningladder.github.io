# ConceptNet link clues: one strict game for Daily and Unlimited

Date: 2026-11-19. Status: approved by the user, who answered the decisions below in conversation.

## Why

Players still find the game too hard. Daily accepts up to 40 close words per rung, but it gives no sense of which way to go. Unlimited is strict, with one hidden word per rung shown as letter blanks.

The user wants one clue-driven game. Before typing, each rung shows the ConceptNet link between the word you're on and the next word, and only shortest-path answers count.

## Decisions (the user's)

- **Both modes.** This replaces the wide 40/35/30 acceptance in Daily and the letter blanks in Unlimited.
- **Real link types only.** Bare `RelatedTo` never counts.
- **Any word that fits counts.** The next word must:
  - be a legal step (two-way top 10)
  - be one rung closer
  - have the shown link with the current word, with the same relation and direction
  - still have a fully linked shortest route on to the goal
- **Letter blanks are dropped.** The clue is the only thing shown. A hint reveals letters of the planned next word.
- **A wrong real word costs a move.** Typos, unknown words and repeats on the same rung stay free.
- **Clues read naturally.** The link data is rebuilt with direction from ConceptNet 5.7 (CC BY-SA 4.0).
- **Past days are re-made, and saves and results are wiped again** (schema 8).

## Non-goals

- AI riddles were considered and dropped by the user.
- Par stays 3/4/5. Medals and the points formula stay as they are.

## Anti-goals

- A rung must never show no clue.
- A correct-by-clue answer must never be rejected.
- Old saves under the old rules must never survive.

## Constraints and findings

- Pairs with a shortest route where every step is linked by a non-`RelatedTo` link are rare: 1.34% at par 3, 0.17% at par 4 and 0.07% at par 5. Puzzle search must therefore be start-first: one BFS from a start word, then scan the goals at distance = par. Random pairs fail at par 5.
- `data/relations_v1.*` stores unordered pairs with no direction. Data files are versioned and frozen, so this ships as `relations_v2`.

## Approaches considered

- **AI riddles for each step.** Dropped by the user in favour of ConceptNet links.
- **A pool of ready-made Unlimited puzzles.** Not needed, because start-first search keeps Unlimited endless in the browser.
- **Neutral, direction-free wording with no rebuild.** Rejected by the user, because the clues read clunkily.

## Design

See the implementation plan at `docs/superpowers/plans/2026-11-19-link-clues.md`.
