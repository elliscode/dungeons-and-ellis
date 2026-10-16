# One & Done — Healing Resets Negative HP

Implement this as an incremental change to the existing application. Inspect the current code and change the shared server-side healing step rather than individual heal sources. Do not rebuild or refactor unrelated functionality.

## Background

Player characters and NPCs go DOWN at 0 HP, keep taking damage into negative HP, and truly die at −max HP. Monsters die at 0 HP.

Before this change, healing added onto the negative number. A hero at −20 HP healed for 8 ended at −12 and stayed down, so small heals on a badly hurt ally looked like they did nothing. Negative HP is meant to be a buffer before true death, not a debt that healing has to pay off first.

## Part 1: The rule

### 1. Healing order

When anything heals a creature that isn't dead:

1. If the heal amount is greater than 0 and the creature's HP is below 0, set HP to 0.
2. Add the full heal amount.
3. Cap at max HP.
4. A downed creature whose HP is now above 0 becomes active.

| Before | Heal | After |
|---|---|---|
| −20 HP, down | 8 | 8 HP, active |
| −5 HP, down | 3 | 3 HP, active |
| 0 HP, down | 5 | 5 HP, active |
| −31 of 32 max, down | 40 | 32 HP (capped), active |
| −10 HP, down | 0 | −10 HP, down (nothing happens) |

### 2. Where it applies

- Implement it once, in `applyHeal()` in `server/games/combat.js`. Every heal ends there, so the rule covers all of them:
  - `heal`, `chain_heal` and healing totems
  - self-heals such as Life Drain
  - the DM's Heal button
- The Heal role multiplier and caster bonuses such as Beacon of Grace are still applied before `applyHeal()`, so the full multiplied amount is what lands.

### 3. What doesn't change

- Damage still pushes player characters and NPCs into negative HP, down to −max HP (true death). Monsters still die at 0.
- Dead creatures can't be healed. The DM still uses Revive.
- The DM's Set HP tool still sets an exact value, including negative values.
- Training dummies and objects still can't be healed.

### 4. Down roll

- The downed character's d20 "get back up" result must still leave them at exactly 1 HP.
- It previously healed `1 − hp` to climb out of the negative. Under the new rule that would overshoot, so it now heals exactly 1, which lands on 1 HP from any negative value.

### 5. Feed and floating numbers

- The healed amount reported in the Game Feed and the floating "+N" counts from 0, not from the negative number. A hero at −20 healed for 8 shows "+8", not "+28".
- The existing "is back on their feet!" message still appears when a downed creature gets up.

## Part 2: Docs

- Update the healing order in `docs/ABILITIES.md` to say that negative HP resets to 0 before the heal applies, with an example.
- Update the comments on `applyHeal()` and `healTarget()` to match.

## Part 3: Tests and Acceptance Criteria

- A hero at −31 HP (max 32) healed for 5 by the DM ends at 5 HP and active, and the feed says "healed for 5".
- Healing them for 40 more caps at 32.
- A downed NPC at −5 healed for 3 by an ability ends at 3 HP and active, and the feed shows "+3".
- The down roll's "get back up" result still leaves the character at 1 HP.
- Existing healing tests still pass: Heal role ×n, Beacon of Grace, chain heals, totems, the max HP cap, and dead targets being refused.
- Run the full suite.

## Implementation Approach

1. Change `applyHeal()` to reset negative HP to 0 when the heal amount is greater than 0, then apply the existing cap and downed-recovery logic.
2. Change the down roll's "get back up" result to heal 1.
3. Update the comments and `docs/ABILITIES.md`.
4. Update the tests that asserted the old behavior, then run the full suite.
