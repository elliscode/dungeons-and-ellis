# One & Done — "Next Hit" Damage Boosts: Duration and Area/Multi-Hit Abilities

Implement this as an incremental change to the existing application. Inspect the effect engine (`server/games/effects.js`) and the shared damage pipeline (`server/games/combat.js`) before changing them. Fix the behavior in the engine rather than in individual hero definitions, and don't refactor unrelated functionality.

## Background

In playtesting, Korvath the Scarred (`data/characters/bald.json`) used **Blood Frenzy** ("your next hit deals +4 damage", a `modify_damage_dealt` effect on himself), and the buff disappeared before his next turn. Two problems came out of looking into it:

1. **The boost expired too early.** `modify_damage_dealt` always defaulted to lasting through the end of the next DM PHASE. Used in round 1's PLAYER PHASE, the buff survived the DM PHASE and expired as round 2's PLAYER PHASE began, before Korvath could swing. That default suits a curse on an enemy (Curse of Weakness halves its next attack, which happens in the DM PHASE), but not a buff on yourself.
2. **Area, chain and multi-hit abilities only boosted their first hit.** Each hit of such an ability goes through the damage pipeline separately, and the boost was removed on the first one. So Blood Frenzy followed by Cleave boosted only one of the enemies hit. The user wants a damage bonus to combine with these abilities, making them more interesting.

## Part 1: Default duration of `modify_damage_dealt`

### 1. Rule

| Effect | Example | Default duration |
|---|---|---|
| **Boost**: `amount` > 0 or `multiplier` > 1 | Blood Frenzy (+4), Phase Step / Overcharged Sigil (×1.5) | **Until the hit lands** (`until_used`), however many phases or rounds later |
| **Penalty**: `amount` < 0 or `multiplier` < 1 | Curse of Weakness, Wither Curse (×0.5 on an enemy) | Through the next DM PHASE (unchanged) |

- An ability that sets `duration` explicitly keeps it. Phase Step and Overcharged Sigil already set `until_used`, and both curses set `next_dm_phase`, so none of them change.
- The trigger is still `next_hit`: the effect is used up by a hit that deals damage. A miss doesn't use it up.
- Boosts without a time limit behave like the other "until used" buffs (Blessing of the First Light, Hunter's Mark). They survive combat starting and ending until used. A boost used before combat is still there once combat starts.

### 2. Implementation

`server/games/effects.js`, the `modify_damage_dealt` handler: work out `penalty = eff.amount < 0 || eff.multiplier < 1`. Pass `duration: penalty ? 'next_dm_phase' : 'until_used'` as the default to `applyLive()` (the ability's own `duration`, if set, still wins). The icon logic (🥀 for a penalty, 💪 for a boost) uses the same test.

### 3. Hero definition

Blood Frenzy's effect in `data/characters/bald.json` also states the duration explicitly, `{ "type": "modify_damage_dealt", "target": "self", "amount": 4, "duration": "until_used" }`, matching Phase Step and Overcharged Sigil. The engine default covers it either way.

## Part 2: "Next hit" means every hit of the next ability

### 1. Rule

- A `modify_damage_dealt` effect with a consumable trigger (`next_hit` and the other "until used" triggers) applies to **every hit made by the ability that uses it**:
  - every enemy hit by an area attack (Cleave, Fireball, Flame Breath, …)
  - every link of a chain attack (Chain Lightning, Static Surge, …)
  - every strike of a multi-attack (Flurry of Blows, Twin Volley, …)
  - every hit of an ability with several attack effects
- It's used up **once that ability finishes**. The next ability or attack does normal damage.
- If the ability misses every target, the boost isn't used up and waits for the next hit. If at least one hit lands, it's used up.
- **Weapon attacks** (the `attack` command) are a single hit, so they're unaffected: the boost applies to that hit and is used up.
- **Penalties follow the same rule.** If a cursed enemy uses an area or multi-hit attack, every hit of it is reduced, and then the curse is used up.

**Not changed:**
- **Defensive "next hit" effects on the target** (`absorb_next_hit`, `grant_protection`, `modify_damage_received` with a trigger). Each target takes its own hit, so these still cover exactly one hit on their holder.
- **`mark_target`** (Hunter's Mark and similar). It only adds to hits on the marked enemy, so an area attack boosts only the marked target's hit.
- **`grant_roll_bonus`** (to-hit bonuses). It's still used up by the next attack roll.

### 2. Implementation

`server/games/combat.js`, `dealDamage()`: when an attacker's `modify_damage_dealt` effect with a consumable trigger is applied and `ctx.spendAfterAbility` is set, push `{ entity: source, id: fx.id }` onto that list instead of removing the effect. Outside an ability, for example a weapon attack, remove it straight away as before. The damage order comment is updated to match.

`server/games/effects.js`, `runAbility()`:
- before resolving the effects, save any outer `ctx.spendAfterAbility` and set a fresh empty list
- resolve the effects in a `try` block
- in `finally`, remove every collected effect with `removeEffect()`, then restore the outer list

Because the effect stays on the attacker until the ability ends, each later hit of the same ability finds it and applies it. If the command fails, the whole state is rolled back anyway.

### 3. Feed

Each boosted hit names the effect in its notes, e.g. "Korvath uses Cleave: Training Dummy HIT 40 (Blood Frenzy, ×4 DPS), Training Dummy 2 HIT 40 (Blood Frenzy, ×4 DPS)".

## Part 3: Docs and schema

- **`docs/ABILITIES.md`:**
  - the `modify_damage_dealt` row in the effect table covers the default duration (boost vs penalty) and "next hit" meaning every hit of the next ability
  - step 2 of the damage order notes that the modifier applies to every hit of the ability that uses it
- **`schemas/character.schema.json`:** the `effect_modify_damage_dealt` description gains the default-duration rule and the every-hit-of-the-ability rule. Run `npm run build:schemas` to regenerate the NPC and monster schemas.

## Part 4: Tests and Acceptance Criteria

Add `test/blood-frenzy.test.js`.
- **Setup:**
  - It reads Korvath's real attacks and abilities from `data/characters/bald.json` and puts them on a DPS hero in a fixture game, so it tests the move as written. It fails if Blood Frenzy's definition changes.
  - The d20 rolls 15 and every damage die rolls 3: the Bloodied Greataxe always rolls 8, and Cleave rolls 6.
  - The targets are training dummies, which record exact damage.
  - The DPS multiplier is measured from a baseline hit, so the tests don't depend on the role-strength setting.
- **Definition:** Blood Frenzy exists, passes `validateAbility`, costs 1 action, and is exactly `{ modify_damage_dealt, self, amount 4, duration until_used }`.
- **Single hit:** the next greataxe hit deals (8 + 4) × the multiplier. The boost is then gone, and the following hit is normal.
- **Miss:** after a natural-1 miss the boost is still there, and the next hit uses it.
- **Cost and stacking:** recasting out of combat refreshes it, so there's one copy and the feed says "is refreshed". In combat it uses the action, so the attack right after is refused.
- **Duration:**
  - **across turns:** used in round 2, it's still there two full rounds later, and the hit deals +4
  - **before combat:** used before combat, it's still there after combat starts and a round passes
  - **penalties:** a ×0.5 penalty is still on during the DM PHASE and gone at the next PLAYER PHASE
- **Cleave:**
  - after Blood Frenzy and a round passing, Cleave on two adjacent dummies deals (6 + 4) × the multiplier to **both**
  - the feed shows Blood Frenzy on both hits, and the boost is used up
  - the Cleave after that deals normal damage to both
- **Multi-attack and chain:**
  - a 3-strike multi-attack (1d4+1, rolling 4) deals 3 × (4 + 4) × the multiplier
  - a 1-jump chain attack deals (4 + 4) × the multiplier to both links
  - the boost is used up after each
- **All misses vs one hit:** a Cleave where both attack rolls are natural 1s keeps the boost. A Cleave where the first misses and the second hits uses it up, and only the second dummy takes damage.

The existing `modify_damage_dealt` tests in `test/effect-types.test.js` (a caster's next hit, and halving an enemy's next hit) still pass. So does the rest of the suite.

**Mutation checks done while building this:**
- With the old `next_dm_phase` default restored, the two duration tests fail.
- The previous "only the first enemy hit gets the +4" assertion fails against the new engine.

Manual check:
1. In combat, Korvath uses Blood Frenzy (💪 on his token).
2. Advance through the DM PHASE. On his next turn the 💪 is still there.
3. Cleave two adjacent enemies. Both feed entries show "(Blood Frenzy, …)" with the higher damage, and the 💪 disappears.
4. The next Cleave shows normal damage.

## Implementation Approach

1. Give `modify_damage_dealt` boosts an `until_used` default duration, keeping `next_dm_phase` for penalties.
2. Add `"duration": "until_used"` to Blood Frenzy's definition.
3. Collect consumed attacker damage modifiers in `ctx.spendAfterAbility` during `runAbility()`, and remove them when the ability finishes.
4. Update `docs/ABILITIES.md` and the schema description, then rebuild the schemas.
5. Add `test/blood-frenzy.test.js` and run the full suite.
