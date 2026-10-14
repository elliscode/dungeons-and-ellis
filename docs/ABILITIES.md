# Abilities and the effect engine

Every ability for every hero, NPC, and monster resolves on the server through one engine (`server/games/effects.js`). Ability text in `description` is only shown in the UI; it never drives mechanics.

To generate new heroes with an LLM, see [CHARACTER_GENERATION.md](CHARACTER_GENERATION.md) and `schemas/character.schema.json`. For monsters, see [MONSTER_GENERATION.md](MONSTER_GENERATION.md) and `schemas/monster.schema.json`. For NPCs, see [NPC_GENERATION.md](NPC_GENERATION.md) and `schemas/npc.schema.json`.

## Ability schema

```json
{
  "id": "inferno-surge",
  "name": "Inferno Surge",
  "actionCost": 1,
  "range": 6,
  "usesPerPhase": 1,
  "effects": [
    { "type": "attack", "target": "enemy", "attack": "1d20+5", "damage": "2d8+2", "range": 6, "damageType": "fire" }
  ],
  "description": "Unleash a concentrated blast of fire at one target."
}
```

| Field | Meaning |
| --- | --- |
| `actionCost` | Actions spent; `0` means free. Default: 1. |
| `range` | Default targeting range in grid squares; `0` means self. Effects can set their own `range`. |
| `usesPerPhase` | Optional cap per combat phase. Required for any ability that grants actions. |
| `effects` | Ordered list; they run top to bottom. |

Older loose fields (`attack`/`damage`, `heal`, `roll`, `free`, `grantsActions`) still load. They are converted on the fly by `normalizeAbility()`, so legacy JSON uploaded on the Data page keeps working. The hero roster has been migrated to the schema with `scripts/migrate-abilities.js`.

### Effect fields common to all types

- `target`: one of
  - `self`
  - `enemy`, `ally`, `ally_or_self`: the creature the player picks
  - `cell`: a square the player picks
  - `enemies_in_area`, `allies_in_area`
  - `hit_enemies`: enemies hit by an earlier attack effect in the same ability
  - `checked_enemy`: the subject of a `roll_to_apply` or `dm_check`
- `when: "attack_hits"` (or `"attack_misses"`) runs the effect only if a previous attack effect in the ability hit (or missed).
- `duration`: see *Timing*.
- `trigger`: see *Timing*.
- `label`: the name shown on tokens and in the feed. Defaults to the ability name.

### Effect types

| Type | Key fields | What it does |
| --- | --- | --- |
| `attack` | `attack`, `damage`, `attackBonus`, `defenseReduction`, `damageBonus`, `damageType` | One attack roll against Defense, then damage on a hit. |
| `multi_attack` | `count` + attack fields | `count` independent strikes, each with its own attack roll and damage roll. One activation pays `actionCost` once. Strikes stop if the target dies. |
| `area_attack` | `center` (`self`/`target`), `radius` + attack fields | Each enemy within `radius` of the center gets its own roll. |
| `chain_attack` | `jumps`, `jumpRange` + attack fields | The primary target plus up to `jumps` targets picked by the player. Each jump is within `jumpRange` of the previous target, with no repeats. |
| `heal` | `heal` | Rolls, then heals through the shared heal path. `heal` may also be a whole number (1–1000) for a flat heal. Capped at max HP. Dead targets, dummies, and objects can't be healed. |
| `chain_heal` | `heal`, `jumps`, `jumpRange` | Like a chain attack, but jumps must go to wounded allies. Each heal is rolled separately. |
| `modify_healing` | `amount` | The caster's next heal on the target gets `+amount` (Beacon of Grace). |
| `grant_protection` | `fraction` (default 0.5) or `amount` | The holder's next hit is reduced by that fraction or amount. |
| `absorb_next_hit` | `magicalOnly` | The holder's next hit (or next magical hit) deals 0. |
| `redirect_next_hit` | (none) | Placed on an ally: their next hit lands on the caster instead (Intercept). |
| `defense_bonus` | `amount` (can be negative), optional `radius` | Defense modifier. With `radius`, it also covers allies around the caster. |
| `modify_damage_received` | `amount` or `multiplier` | Changes the damage the holder takes from hits. |
| `modify_damage_dealt` | `amount` or `multiplier` | Changes the holder's next hit (Curse of Weakness uses 0.5). |
| `modify_movement` | `amount` | Movement modifier. Negative values show as *Slowed*. |
| `taunt` | optional `radius` | While the taunter is a valid target, the taunted enemy's attacks must target the taunter. |
| `reduce_actions` | `amount` | Lowers the target's action allowance. It never goes below 0. |
| `mark_target` | `bonus` (dice) | The caster's next hit on the target adds `bonus` (Hunter's Mark). |
| `grant_roll_bonus` | `bonus` (dice or number) | Added to the holder's next attack roll, including roll-to-apply rolls (Inspire, Foresight). |
| `apply_status` / `remove_status` | `status` | Statuses: `frightened` (−2 to hit, and can't move closer to its source), `snared` (movement 0), `shaken` (−2 to hit), `poisoned` (−2 to hit for the rest of the current phase plus 5 full rounds; ignores `duration`, and re-poisoning refreshes instead of stacking), `slowed`. |
| `discourage_attacks` | `penalty` (default 5) | Attacks against the holder take −penalty (Sanctuary). |
| `grant_actions` | `amount` | Extra actions this phase. The ability must set `usesPerPhase`, and it can grant at most `actionCost + 1`. |
| `teleport` | `distance` | Moves the caster to the picked square. |
| `dash` | `distance` | Moves the caster on foot to the picked square without spending movement. Snared creatures can't dash; frightened ones can't dash closer to their source. Follow it with a targeted effect (e.g. an attack with `range: 1`) and the player picks the square first, then the target measured from that square (Predator's Lunge). |
| `narrative` | optional `roll` | Records the use and the roll; the DM decides the outcome. |
| `create_barrier` | `name`, `duration` | A temporary object token on the picked square. It's visual cover; the DM adjudicates. |
| `healing_aura` | `heal`, `radius`, `pulses` | A totem token. At the start of each PLAYER PHASE it heals friendlies within `radius`, for `pulses` phases. |
| `roll_to_apply` | `roll`, `onSuccess`, `onFailure`, optional `radius` | Rolls against each subject's Defense. A natural 20 always succeeds and a natural 1 always fails. |
| `dm_check` | `roll`, `onSuccess`, `onFailure` | Creates a pending check. The DM clicks Success or Failure in the ⚖ menu. |

## Timing

Combat alternates PLAYER PHASE and DM PHASE. The server counts phases (`combat.phaseSeq`; 1 is the player phase of round 1).

| `duration` | Lasts |
| --- | --- |
| `current_turn` | until the current phase ends |
| `until_next_player_phase` | until the next PLAYER PHASE starts |
| `next_dm_phase` | through the end of the next DM PHASE (default for buffs and debuffs) |
| `{ "phases": N }` | N phase transitions |
| `combat` | until combat ends |
| `until_used` | no time limit; removed only when used |

`trigger` values are consumed exactly once, at the moment they fire: `next_hit`, `next_magical_hit`, `next_attack_against_self`, `until_used`, and `until_next_heal_by_caster`. An effect can have both a trigger and a time limit; the default time limit for one-shot protections is `next_dm_phase`.

A timed effect applied outside combat starts its clock when combat begins. Ending combat clears every timed effect. Effects are stored in the game state, so they survive reconnects, restarts, and undo. The DM can remove any effect, or add a status, from the inspector. For frightened, the DM then clicks the creature on the map that it's frightened of.

## Damage order

Every damage source runs through `dealDamage()` in `server/games/combat.js`: weapon attacks, ability attacks, area, chain, and multi strikes, enemy attacks, and the DM's Damage button. Each step applies at most once per hit:

1. Raw damage is rolled. A critical hit doubles the dice, not the modifier.
2. Attacker modifiers apply: `modify_damage_dealt`, then a Hunter's Mark bonus.
3. Attacker role: a DPS hero's damage is multiplied by the role strength n (rounded down). This happens before any of the target's defenses, once per strike.
4. Redirection: Intercept makes the protector the victim.
5. Victim protection: `absorb_next_hit` (the hit deals 0), otherwise `grant_protection` (reduced). Then `modify_damage_received`.
6. Tank mitigation: tank heroes take 1/n, rounded down, with a minimum of 1.
7. The damage is applied. A Training Dummy records it; everyone else goes through the normal down/dead rules.

Healing runs through `healTarget()` in this order:

1. The heal is rolled.
2. A Heal-role hero's healing is multiplied by n.
3. Flat bonuses from the caster are added (Beacon of Grace; consumed).
4. The heal is applied. Negative HP is reset to 0 first, so a downed target always gets back up with the full amount (−20 HP healed for 8 → 8 HP). The result is capped at max HP. Dead targets can't be healed.

Healing totems count as their caster's healing.

### Role bonuses

These are automatic for player characters, based on `role`, and scaled by one global setting, the **role strength** n. It's one of the presets 1–5 (default 4), chosen on the DM home page and stored in `data/settings.json`. The rules are defined once in `server/games/roles.js`, and the role-selection tiles read them from there.

| Role | Bonus |
| --- | --- |
| Tank | Takes 1/n damage (step 6 above) |
| DPS | Deals n× damage (step 3 above) |
| Heal | Heals for n× (heal step 2) |

| n | Tank | DPS | Heal |
| --- | --- | --- | --- |
| 1 | full damage | 1× | 1× (bonuses off) |
| 2 | ½ | 2× | 2× |
| 3 | ⅓ | 3× | 3× |
| 4 (default) | ¼ | 4× | 4× |
| 5 | ⅕ | 5× | 5× |

Monsters, NPCs, and the DM's Damage and Heal buttons never get role bonuses. A DPS hero's self-heal (Life Drain, for example) isn't multiplied, because only Heal-role heroes get the healing multiplier.

Attack rolls (`attackRoll()`) include `attackBonus`, one-shot roll bonuses (which are consumed), frightened/shaken/poisoned penalties (each status counts once, however many copies), the Sanctuary penalty, and the target's effective Defense (base, plus `defense_bonus`, minus `defenseReduction`). Serene Focus is consumed by the next attack against its holder.

## Action economy and movement

- Abilities that deal damage (any `attack`, `multi_attack`, `area_attack` or `chain_attack` effect, including ones nested in `onSuccess`/`onFailure`) work only in combat, like weapon attacks. The server refuses them outside combat, and the Act menu greys them out with "combat only". Heals, buffs, debuffs like Hunter's Mark, movement, and narrative abilities still work while exploring.
- Players get their allowance (default 1 action) each PLAYER PHASE. Monsters and hostile NPCs get theirs each DM PHASE and can only act then. Friendly NPCs and the DM's own tools are unlimited.
- The allowance is the definition's `actions`, plus granted actions, minus `reduce_actions`. It never goes below 0.
- Movement is separate from actions. In combat, players and enemies spend movement after modifiers; a snared creature can't move. The DM can **Shift-drag** to force a move past budgets and frightened restrictions.

## Item abilities

`data/items.json` is the item catalog: `{ id, name, description?, ability? }`, where `ability` uses the same schema as a character ability. An inventory entry matches a catalog item by its id (`"healing-potion"` in a definition's `inventory`) or, failing that, by name, so items the DM adds by name ("Healing Potion") match too.

- Using an item with an ability goes through the normal targeting flow and the shared effect engine. The item is removed only once the ability resolves. If the target is out of range or invalid, or the user has no actions left, the item is kept.
- It costs the ability's `actionCost` (default 1). Item abilities don't count toward `usesPerPhase`.
- Item heals skip the Heal role bonus, so a Healing Potion heals a flat 25 whoever uses it.
- Items without an ability are used up in one click, as before.
- Healing Potion: `range: 1`, `heal: 25`, targets yourself or an adjacent ally (a downed ally gets up at 25).

## Training Dummy

`data/monsters/training.json` defines `"immortal": true`. A dummy has no HP at all; it is not given a huge HP number. Damage goes through the normal pipeline, and step 6 records `damageTaken` and `hits` instead of subtracting HP, so no amount of damage can down or kill it.

- Statuses and debuffs apply normally.
- Heals on it are skipped.
- `actions: 0`, so it never acts.
- `movement: 0`, so it stays put in combat unless the DM force-moves it.
- The DM can reset its counter or remove it. Kill, Set HP, and status overrides are refused.

## Roster decisions

Where the original wording was vague, these defaults were chosen. They're applied by `scripts/migrate-abilities.js`.

- **Buffs that only had a roll** (Shield Wall, Stone Skin, Ironbark, Bone Armor, Unbreakable Rage, Frozen Bulwark, Warding Rune, Serene Focus, Spellguard, Intercept, Radiant Guard, Sanctuary) **always apply**. The roll is shown in the feed for flavor.
- **Debuffs that had a roll** (Hunter's Mark, Curse of Weakness, Snare Trap, Draconic Roar, Magnetic Taunt) roll against the target's Defense, like an attack.
- **Halve the next hit:** Shield Wall, Stone Skin, Ironbark, Unbreakable Rage.
- **Absorb the next hit:**
  - Bone Armor and Frozen Bulwark: self.
  - Warding Rune: an ally within 4.
  - Spellguard: an adjacent ally, magical hits only. Magical means a fire, cold, lightning, thunder, radiant, necrotic, arcane, force, psychic, poison, or acid `damageType`.
- **Areas:**
  - Thunderclap and Earthshaker: radius 2 around self.
  - Glacial Slam and Seismic Slam: radius 1 around self.
  - Cone of Cold: radius 1 around a target within 3.
  - Volatile Flask: radius 1 around a target within 5, and it also poisons.
- **Chains:** Chain Lightning and Chain Heal get 1 jump, within 3 squares. The player picks every jump.
- **Riders:**
  - Pinning Shot and Glacial Slam: −2 movement.
  - Silencing Strike: −1 action next DM phase.
  - Reckless Cleave: +3 damage, −2 Defense until the next player phase.
  - Life Drain and Blood Siphon: heal self on a hit.
- **Free, once per phase:**
  - Cunning Action and Quick Reload: +1 action.
  - Blink Step: teleport 4.
  - Veil Step: teleport 3, plus +2 Defense.
  - Chi Dash: +3 movement this phase.
  - Deploy Barrier.
- **Beacon of Grace** is free with no phase limit.
- **Support:**
  - Inspire and Foresight: +1d6 on the next roll.
  - Beacon of Grace: +3 on the caster's next heal of that ally.
  - Sanctuary: −5 to hit the ally through the next DM phase.
  - Healing Totem: 1d4+1 to allies within 2 at the start of the next 2 player phases.
- **Cunning Action:** the handoff text said it "costs an action and grants one", which nets to nothing. It stays as before: free, +1 action, once per phase.
- **Light and Speak with Animals** are narrative only.

## Known limitations

- There is no line of sight or cover geometry. Areas are radius-based, and barriers are visual.
- Monster attacks in the bank have no `damageType`, so magical-only protections don't trigger against them unless a definition adds one.
- Statuses are limited to the five listed above. This is not a full condition system.
