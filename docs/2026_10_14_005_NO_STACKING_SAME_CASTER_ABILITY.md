# One & Done — No Stacking From the Same Caster and Ability

Implement this as an incremental change to the existing application. Inspect the current code and change the shared live-effect path rather than individual effect handlers. Do not rebuild or refactor unrelated functionality.

## Background

In playtesting, a healer cast **Blessing of the First Light** on the tank 15 times before combat, for **+30** on the first attack roll. The ability is a `grant_roll_bonus` of +2 that lasts until used. Two things allowed this:

- `applyLive()` in `server/games/effects.js` always added a new copy of the effect, even if the target already had one from the same caster and ability.
- `attackRoll()` adds up every `grant_roll_bonus` on the attacker.

Outside combat abilities cost no actions, so the blessing could be cast over and over for free.

## Part 1: The rule

### 1. One copy per caster per ability per target

A given ability's effect can be on a target **only once per caster**.

| Situation | Result |
|---|---|
| The same healer casts the same blessing on the tank again | The existing copy is **refreshed**; the tank still has one |
| Two different healers each cast that blessing on the tank | Both copies stay (+2 and +2 = +4) |
| One healer casts two **different** blessings on the tank | Both stay |

### 2. A recast refreshes

- The old copy is removed and the new one added, so a timed effect gets a fresh duration, and the params come from the new cast.
- A recast costs its action as usual in combat.
- Game Feed:
  - new target: "Tank gains Blessing of the First Light" (unchanged)
  - target that already had it: "Tank's Blessing of the First Light is refreshed"
  - an area cast that hits both kinds lists both, e.g. "Cleric gains Aegis; Tank's Aegis is refreshed"
  - several refreshed targets: "Tank's, Cleric's Aegis are refreshed"

### 3. What counts as "the same"

An existing effect on the target matches when all of these are equal:

- the caster (`source.entityId`)
- the ability (`source.abilityId`)
- the effect `type`
- the `status`, if any

Including the type and status means one ability that applies two different things keeps both. An Offer You Can't Refuse applies frightened **and** shaken, and recasting it leaves exactly one of each.

### 4. Where it applies

Every live effect, because they all go through `applyLive()`:

- `modify_healing`, `grant_protection`, `absorb_next_hit`, `redirect_next_hit`
- `defense_bonus` (including the radius version), `modify_damage_received`, `modify_damage_dealt`, `modify_movement` (including slowed)
- `taunt`, `reduce_actions`, `mark_target`, `grant_roll_bonus`, `discourage_attacks`
- `apply_status`, including statuses applied through `roll_to_apply` and through a resolved `dm_check` (Intimidating Roar)

### 5. What doesn't change

- **DM-added statuses** from the inspector have no caster or ability, so they never match and behave as before.
- **Poisoned** still refreshes instead of stacking, across all casters (its existing rule).
- **To-hit penalties** still count each status once per attack, however many copies there are.
- **Heals, damage, movement and spawned objects** (barriers, healing totems) aren't live effects on a creature, so they're unaffected.

### 6. Existing games

Copies applied before this change don't record their ability, so they're never matched. They stay until they're used, expire, or the DM removes them in the inspector.

## Part 2: Implementation

`server/games/effects.js`:

- **Record the ability.** `sourceOf(act)` returns `{ entityId, name, abilityId }`, with `abilityId` taken from `act.ability.id` (or null).
- **Deferred DM checks.** The pending check object stores `abilityId` next to `abilityName`. `resolveCheck()` rebuilds `act.ability` as `{ name: chk.abilityName, id: chk.abilityId ?? null }`, so effects applied on a successful check are keyed too.
- **`applyLive()`**, for each target:
  - Only when the ability has an id, find the target's effects matching the caster, ability, type and status.
  - Remove them with the existing `removeEffect()`, then add the new copy with `addEffect()`.
  - Sort the target into "gained" or "refreshed", and build the feed line from both lists.

No client changes are needed. Effects already show their source in the inspector and token icons.

## Part 3: Docs

Add a **Stacking** paragraph to the Timing section of `docs/ABILITIES.md` describing the rule, the refresh, and what still stacks.

## Part 4: Tests and Acceptance Criteria

New tests in `test/effect-types.test.js`:

- **The playtest case:** one caster uses Blessing of the First Light 15 times on an ally outside combat. The ally has exactly one roll bonus, and the feed says it was refreshed. In combat, a natural 8 plus 2 misses DEF 11 (it would hit with +30), and the bonus is then used up.
- **Different casters:** two casters with the same blessing on the same target give 2 copies.
- **Different abilities:** one caster's two different roll-bonus abilities give 2 copies.
- **Duration restarts:** a `{ "phases": 2 }` buff recast one phase later is still there after the original would have expired, with a single copy, and expires on the new schedule.
- **Area recast:** with one ally in radius and one out, then both in, each ends with one copy. The feed says "gains" for the newcomer and "is refreshed" for the other, and "are refreshed" for both on a third cast.
- **Two statuses:** an ability applying frightened and shaken, cast twice, leaves one of each.
- **DM checks:** the same `dm_check` ability used twice on one enemy and resolved as success twice leaves one frightened.

Update the existing tests that relied on the old stacking:

- **Slow:** the same caster's Slow cast twice leaves movement at −2. A second caster's Slow still stacks to −4.
- **"frightened twice is still only −2 to hit":** get the two copies from two *different* abilities, so it still proves the penalty doesn't stack.

All existing tests still pass.

Manual check:
1. Outside combat, have a healer cast Blessing of the First Light on the tank several times. The tank shows one blessing icon, and the feed says "is refreshed".
2. Start combat and attack with the tank. The roll shows +2 once.
3. Have a second healer bless the tank as well. The next attack shows both +2 bonuses.

## Implementation Approach

1. Add `abilityId` to `sourceOf()`, and carry it through pending DM checks.
2. Make `applyLive()` replace matching copies and report "gains" / "is refreshed".
3. Update the two tests that relied on stacking, and add the new tests.
4. Add the Stacking paragraph to `docs/ABILITIES.md`, then run the full suite.
