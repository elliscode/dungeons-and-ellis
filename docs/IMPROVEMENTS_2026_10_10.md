# Claude Handoff: Shared Ability Effect Engine + Unified Game Feed + Training Dummy

## Project Context

**Project:** One & Done — lightweight multiplayer tabletop RPG VTT  
**Live site:** https://oneshot.elliscode.com

The application is already functional. Inspect the existing codebase before making changes. Extend the current architecture rather than rebuilding systems that already work.

The app uses a Node.js server, WebSockets, SQLite persistence, and a browser frontend. Keep the server authoritative for game state, dice, combat, action economy, ability effects, and entity state.

This work has three goals:

1. Implement a reusable, server-authoritative ability effect engine for the full character ability roster.
2. Combine chat and the existing activity/event log into one chronological **Game Feed**.
3. Add a **Training Dummy** enemy/entity type, inspired by World of Warcraft target dummies, that can take unlimited damage but never dies or becomes downed.

Keep implementation incremental and focused. Do not redesign unrelated features.

---

# Part 1: Shared Ability Effect Engine

## 1. Goals

The game has approximately 66 character abilities spanning tanks, DPS, healers, and support characters.

Replace ad hoc ability handling with a shared, structured effect engine that supports:

- Attacks and damage.
- Independent multi-attacks.
- Healing and conditional healing.
- Area attacks and chained attacks/heals.
- Damage prevention, absorption, and redirection.
- Defense and damage modifiers.
- Buffs, debuffs, status effects, and action restrictions.
- Action grants and free abilities.
- Movement and teleportation.
- Target selection, range validation, and effect duration.
- Persistent effects across phase changes, reconnects, and server restarts.
- Player character, NPC, monster, and Training Dummy interactions.
- DM overrides.

Descriptions are for the UI and narrative context. Never parse descriptions to infer mechanics.

## 2. Inspect the existing implementation first

Before coding:

1. Find the current ability definitions and character roster.
2. Find the ability activation UI and request handlers.
3. Trace the server-side attack, damage, healing, movement, and action-validation logic.
4. Identify how combat phases, enemy action allowances, downed/dead states, and DM overrides are represented.
5. Identify existing temporary-effect and status systems, if any.
6. Find how chat and activity events are stored and broadcast.
7. Identify the current database schema and migration approach.
8. Find the existing NPC/monster definition banks, live entity representation, spawn controls, and token rendering logic.

Reuse existing functions and state structures where practical. Avoid introducing duplicate damage pipelines, multiple competing effect representations, or a parallel combat system.

## 3. Canonical ability schema

Migrate abilities to a consistent schema.

Example:

```json
{
  "id": "inferno-surge",
  "name": "Inferno Surge",
  "actionCost": 1,
  "range": 6,
  "effects": [
    {
      "type": "attack",
      "target": "enemy",
      "attack": "1d20+5",
      "damage": "2d8+2",
      "range": 6,
      "damageType": "fire"
    }
  ],
  "description": "Unleash a concentrated blast of fire at one target."
}
```

Core fields:

- `id`: stable identifier.
- `name`: display name.
- `actionCost`: number of actions consumed; normally `1`, or `0` for a free ability.
- `range`: default maximum targeting distance in grid squares; `0` means self.
- `effects`: ordered array of structured effect definitions.
- `description`: display text only.
- `free`: optional compatibility/UI field if existing code depends on it.
- `usesPerPhase`: optional usage limit.
- `grantsActions`: retain only if needed for compatibility; prefer a structured `grant_actions` effect.

### Schema rules

1. Preserve existing ability IDs, names, descriptions, and dice expressions wherever possible.
2. Use `actionCost` for actions consumed.
3. Use `grant_actions` for extra actions.
4. Use `multi_attack` for multiple attacks within one ability.
5. Use `actionCost: 0` for genuinely free abilities.
6. Keep mechanics separate from descriptions.
7. Use a consistent range convention.
8. Validate definitions and effect types.
9. Do not invent elaborate mechanics to resolve ambiguities. Document decisions and choose consistent defaults.

## 4. Shared effect execution pipeline

All abilities must use one server-side activation and resolution pipeline:

1. Receive the ability activation request.
2. Resolve the requesting player/entity and ability definition.
3. Validate ownership, target selection, phase, action availability, usage limits, range, and target eligibility.
4. Consume or reserve the required action according to existing rules.
5. Resolve effects in declared order.
6. Apply damage, healing, modifiers, movement, and status changes through shared game-state functions.
7. Update temporary effects and usage counters.
8. Persist the resulting state.
9. Broadcast the result and appropriate Game Feed events.
10. Return a consistent success or failure result.

The server is authoritative. Clients must never decide whether attacks hit, how much damage is dealt, whether an effect applies, or whether an action is allowed.

Where possible, make state changes for one activation atomic and avoid partially applying an ability after an unexpected error.

Use the existing server-side dice roller. Support expressions such as `1d20+5`, `2d6+2`, and `1d8+4`.

## 5. Required effect types and behavior

Implement these categories as reusable handlers.

### A. Attacks and damage

Supported effect types:

- `attack`
- `area_attack`
- `multi_attack`
- `chain_attack`

The engine must validate targets and range, roll attacks against Defense, roll damage on hits, apply modifiers once, handle misses and critical hits according to existing rules, and broadcast results.

#### Multi-attacks

**Flurry of Blows makes four independent attacks.**

```json
{
  "type": "multi_attack",
  "target": "enemy",
  "count": 4,
  "attack": "1d20+5",
  "damage": "2d6+2",
  "range": 1,
  "independentRolls": true
}
```

Roll four separate attack rolls and roll damage independently for each successful strike. Do not roll once and multiply damage by four.

The entire ability consumes its configured action cost, not one action per internal strike, unless explicitly configured otherwise.

#### Area and chain attacks

- Area attacks resolve against eligible targets using structured area/range parameters.
- Each affected target gets the configured independent attack and damage resolution.
- Chain attacks use the initial target and a configured number of additional targets.
- Chain Heal uses explicit target and jump rules.
- Do not silently choose arbitrary targets.
- If the existing grid does not support the required geometry, use a simple documented rule or DM-selected targets instead of introducing advanced line-of-sight or area-template systems.

### B. Healing

Supported types:

- `heal`
- `chain_heal`
- `modify_healing`

Healing must use the shared dice roller and HP update function.

- Validate range and eligibility.
- Clamp healing to maximum HP.
- Respect downed/dead rules.
- Support self-healing, conditional healing, and chain healing.
- Apply healing modifiers consistently.
- Record the amount actually restored.

Examples include Blood Siphon and Life Drain healing the caster only when their attack hits.

### C. Protection and damage redirection

Supported types:

- `grant_protection`
- `absorb_next_hit`
- `redirect_next_hit`
- `defense_bonus`
- `modify_damage_received`

Distinguish between preventing damage, absorbing a hit, reducing damage, increasing Defense, and redirecting a hit. Integrate these with the centralized damage pipeline.

Examples include Shield Wall, Ironbark, Bone Armor, Spellguard, Frozen Bulwark, Warding Rune, Intercept, and Serene Focus.

### D. Buffs, debuffs, and status effects

Supported types:

- `taunt`
- `reduce_actions`
- `modify_movement`
- `modify_damage_dealt`
- `modify_damage_received`
- `mark_target`
- `grant_roll_bonus`
- `apply_status`
- `remove_status`
- `discourage_attacks`

Examples include Hunter's Mark, Pinning Shot, Snare Trap, Reckless Cleave, Inspire, Foresight, Sanctuary, and Antidote.

Action reductions must integrate with existing enemy action allowances. Do not allow negative action counts.

Avoid implementing a complete D&D condition engine. Implement only the statuses and modifiers required by the roster.

### E. Extra actions and free abilities

Supported types:

- `grant_actions`
- `actionCost`
- `usesPerPhase`
- `free`

Examples:

- Cunning Action costs an action, grants one extra action, and can be used once per phase.
- Quick Reload grants an additional action/shot according to the shared action economy.
- Chi Dash, Beacon of Grace, and Veil Step are free abilities with `actionCost: 0`.

Free abilities must still validate ownership, targets, range, and usage restrictions. Prevent infinite loops involving abilities that grant actions.

The game uses a global PLAYER PHASE and DM PHASE model. Players normally get one action per PLAYER PHASE, with movement separate. Integrate with the existing rules.

### F. Movement and teleportation

Supported types:

- `teleport`
- `modify_movement`

Use the existing grid, obstacle, movement, and z-order logic. Teleportation must update authoritative position and emit appropriate events.

Do not duplicate movement implementation inside individual abilities.

### G. Utility effects

Supported types:

- `narrative`
- `create_barrier`
- `healing_aura`

Speak with Animals should record the ability use and leave narrative resolution to the DM. Deploy Barrier and Healing Totem should reuse existing entity/object infrastructure where possible.

Do not automatically invent narrative outcomes or build unrelated subsystems.

### H. Roll-to-apply and DM checks

Support structured checks such as `roll_to_apply` and `dm_check`, with explicit success/failure outcomes.

Do not invent universal success thresholds. Where an ability specifies a DM-set difficulty, let the DM supply it.

### I. Targeting and effect composition

Abilities can contain multiple ordered effects. Support explicit conditions such as `attack_hits` and resolve dependent effects only when the condition is met.

Examples:

- Blood Siphon: attack, then heal the caster if it hits.
- Antidote: heal and remove poisoned status.
- Veil Step: teleport and grant protection.
- Reckless Cleave: attack and apply its configured damage modifiers.

Do not parse descriptions for conditions.

## 6. Effect lifecycle and timing

The game uses global PLAYER PHASE and DM PHASE transitions, not individual initiative turns.

Support explicit expiration conditions such as:

- `next_dm_phase`
- `current_turn`, with a documented meaning
- `next_hit`
- `next_magical_hit`
- `next_attack_against_self`
- `until_used`
- `until_next_hit`
- `until_next_heal_by_caster`
- Explicit phase-duration counts

Normalize ambiguous timing values into documented internal rules.

Effects must apply and expire exactly once, persist when required, survive reconnects and server restarts, and behave consistently with downed/dead entities. The DM must be able to override or remove effects.

## 7. Centralized damage and healing resolution

All damage sources must use one shared damage pipeline, including normal attacks, abilities, area attacks, multi-attacks, chained attacks, and enemy attacks.

Integrate:

- Tank mitigation: tank-role player characters take 25% of incoming damage, with the existing minimum of 1 damage for positive damage.
- Protection, absorption, and redirection.
- Damage modifiers.
- Downed/dead transitions.
- HP clamping.
- DM overrides.

Apply each modifier exactly once and document the order.

Healing must integrate maximum HP, healing modifiers, downed recovery, dead-character restrictions, and DM revival.

**The Training Dummy exception is specified in Part 3.** Implement it as an entity-level damage-resolution rule, not as a separate attack engine or a very large HP value.

## 8. Hidden information and authorization

Preserve existing visibility rules:

- Players can see friendly HP.
- Players cannot see exact enemy HP.
- The DM can see all HP.
- Hidden enemy HP must not leak through chat, ability results, damage events, or WebSocket payloads.
- DM-only events remain private.
- Players can only activate abilities belonging to their assigned character.
- The server validates all targets, ranges, phases, and action limits.

Filter sensitive information on the server before broadcasting.

## 9. Migrate all abilities

Migrate the existing roster while preserving IDs, names, descriptions, dice expressions, and intended mechanics.

Tank abilities include Shield Wall, Second Wind, Earthshaker, Stone Skin, Lay on Hands, Challenger's Oath, Ironbark, Regrowth, Blood Siphon, Bone Armor, Reckless Cleave, Unbreakable Rage, Spellguard, Silencing Strike, Intercept, Radiant Guard, Frozen Bulwark, Glacial Slam, Deploy Barrier, and Magnetic Taunt.

DPS abilities include Inferno Surge, Light, Cunning Action, Backstab, Hunter's Mark, Pinning Shot, Cone of Cold, Blink Step, Chain Lightning, Thunderclap, Life Drain, Curse of Weakness, Flurry of Blows, Chi Dash, Companion Strike, Snare Trap, Quick Reload, Trick Shot, Flame Lunge, and Draconic Roar.

Healer/support abilities include Healing Word, Cure Wounds, Goodberry, Nature's Mend, Speak with Animals, Song of Rest, Inspire, Prayer of Mending, Sanctuary, Healing Surge, Chain Heal, Healing Totem, Soothing Mist, Renewing Wave, Serene Focus, Flash of Light, Beacon of Grace, Restorative Draught, Antidote, Volatile Flask, Celestial Balm, Warding Rune, Foresight, Ancestral Call, Spirit Tether, and Veil Step.

Use the structured ability schema already established for this roster. Flag ambiguous mechanics and document consistent defaults.

## 10. NPCs and monsters

The same effect engine must support player characters, NPCs, monsters, and the new Training Dummy entity type.

- Reusable definitions remain separate from live instances.
- Live instances retain independent state.
- Entity scope remains independent of entity type.
- Scene-scoped entities retain their state when revisiting their scene.
- Game-scoped entities follow the adventure according to existing rules.
- Enemy action allowances reset at the start of each DM phase.
- NPCs may be friendly, neutral, or hostile.
- DM overrides remain available.

Do not create a separate effect engine for monsters or the Training Dummy.

## 11. Effect engine tests

Add automated tests with deterministic/mock dice rolls where practical.

Test at minimum:

1. Attack hits and misses.
2. Damage expressions and HP clamping.
3. Healing and maximum-HP limits.
4. Conditional healing.
5. Four independent Flurry of Blows attacks.
6. Area attacks against multiple targets.
7. Chain Lightning and Chain Heal.
8. Protection, absorption, and redirection.
9. Tank mitigation applied exactly once.
10. One-use modifiers and effect expiration.
11. Action grants, usage limits, and free abilities.
12. Enemy action reductions and phase resets.
13. Movement and teleport validation.
14. Effect persistence across reconnects and restarts.
15. Downed/dead behavior and DM revival.
16. Authorization and hidden-HP protection.
17. NPC and monster abilities.
18. Training Dummy damage handling and immunity to death/downed transitions.
19. Schema validation for every ability and effect type.

Do not claim full support simply because definitions have been migrated. Verify that every effect type has an executable handler.

---

# Part 2: Unified Game Feed

## 12. Goal

Replace the separate chat and activity/event log panes with one chronological pane titled **Game Feed**.

Chat messages and game events remain distinct internal event types but appear together in one feed. Preserve existing useful activity information and chat functionality.

## 13. Feed event types

Include relevant events such as:

- Player joins/disconnects and character selection.
- Chat messages and dice rolls.
- Attacks, misses, damage, healing, and protection.
- Ability activation and significant effect outcomes.
- Movement and teleportation.
- Inventory and Act actions.
- NPC/monster/Training Dummy spawn, removal, and relevant changes.
- Combat start/end.
- PLAYER PHASE and DM PHASE transitions.
- Timer events.
- DM actions and overrides when appropriate for the viewer.

For multi-attacks, show a useful summary of independent results. Avoid leaking hidden enemy HP or flooding the feed with internal state mutations.

Training Dummy hits should produce useful damage feedback in the feed, without suggesting that the dummy is dying.

## 14. Ordering and persistence

Every persisted event should have:

- Stable event ID.
- Server-generated timestamp.
- Monotonically increasing sequence number or equivalent stable ordering.
- Event type.
- Structured event data.
- Visibility information sufficient to render for authorized viewers.

The server assigns ordering metadata. Do not rely on client clocks.

Persist history using the existing SQLite infrastructure. Reconnects and server restarts must not lose history or create duplicates.

## 15. Feed UI and scroll behavior

- Render chat and game events in one chronological list.
- Visually distinguish event types.
- Preserve player colors.
- Show compact timestamps.
- Keep the chat input at the bottom.
- Preserve existing chat submission and slash commands, including `/roll 2d6`.
- Update over WebSockets without refreshing.
- Load historical events on reconnect.

Scrolling:

- Auto-scroll if the viewer was already at the bottom.
- Do not force-scroll if they are reading older entries.
- Show a subtle new-message indicator when appropriate.

## 16. Visibility and tests

Filter private/DM-only events and hidden enemy information on the server before broadcasting.

Test:

1. Unified chronological ordering.
2. Real-time delivery.
3. Existing chat commands.
4. Persistence and reconnect without duplicates.
5. Scroll preservation and new-message indication.
6. Player color consistency.
7. DM-only event filtering and hidden-HP protection.
8. Ability results and Training Dummy damage events rendering correctly.
9. No duplicate events when one ability generates several effects.

---

# Part 3: Training Dummy Enemy Type

## 17. Goal

Add a new reusable enemy/entity type called **Training Dummy**, inspired by World of Warcraft target dummies.

The Training Dummy is intended for testing character builds, attack rolls, damage output, abilities, and combat interactions.

**Core behavior: the Training Dummy can receive unlimited damage and can never become downed or dead.**

Do not implement this by giving it an arbitrarily large HP value. Use an explicit entity-type or behavior flag so survivability does not depend on a numeric HP limit.

## 18. Definition and spawning

Integrate the Training Dummy into the existing NPC/monster bank and live entity system.

Requirements:

- Add a reusable Training Dummy definition.
- Allow the DM to spawn it during gameplay using the existing spawn workflow.
- Allow the DM to move and remove it like other supported entities.
- Use the existing token/image asset conventions.
- Make it selectable and targetable by player characters.
- Persist spawned instances using the existing game-state persistence.
- Ensure separate spawned dummies have independent instance IDs and positions.
- Respect existing scene-scoped versus game-scoped entity behavior where applicable.

Prefer the smallest change that fits the existing entity model. Do not create a new subsystem solely for this entity.

Example definition, adapted to the actual codebase's schema:

```json
{
  "id": "training-dummy",
  "name": "Training Dummy",
  "entityType": "training_dummy",
  "maxHp": null,
  "movement": 0,
  "defense": 10,
  "attacks": [],
  "abilities": [],
  "behavior": {
    "immortal": true,
    "canBeDowned": false,
    "canBeKilled": false,
    "canAct": false
  }
}
```

This is a conceptual example. Adapt field names to the existing NPC/monster schema. Do not use `maxHp: null` if the existing model requires a numeric HP value; the important behavior is the explicit immortality rule, not the particular representation of HP.

The Training Dummy should not attack or take its own combat actions by default. It exists as a stationary practice target. If the existing entity system requires a movement or action allowance, configure the dummy to remain stationary and have no available actions.

## 19. Unlimited damage behavior

When an attack or ability hits a Training Dummy:

1. Resolve the attack roll and hit/miss normally using its configured Defense.
2. Roll damage normally.
3. Pass the hit through the shared damage-resolution pipeline.
4. Calculate applicable damage modifiers and mitigation according to the existing rules.
5. Emit normal hit/damage results and visual feedback.
6. Never transition the dummy to downed or dead.
7. Never remove it automatically because of damage.

The dummy should be able to receive repeated attacks, multi-attacks, area attacks, chain attacks, and applicable ability effects.

**Unlimited damage means unlimited cumulative damage over its lifetime.** It must not eventually die from accumulated damage, regardless of the number of attacks or damage amount.

### HP representation

Do not let the dummy's HP reach zero and trigger normal death logic.

Inspect the existing HP model and choose the least disruptive approach:

- Represent its health as effectively unlimited while keeping its state non-depleting; or
- Track damage for feedback/statistics separately from survivability.

Do not introduce an arbitrarily large numeric HP value as the sole immortality mechanism.

For the player UI, use a clear representation such as `Training Dummy` without a depleting HP bar, or another non-depleting display consistent with the existing UI. The DM can identify the entity as a Training Dummy.

Damage numbers should still appear as normal. For example, repeated hits may show `-8`, `-12`, or `CRIT`, but the dummy remains standing.

If the application currently expects every entity to have numeric HP, preserve compatibility without letting the dummy's displayed or internal health cause death transitions.

## 20. Integration with the shared effect engine

The Training Dummy must use the same attack and effect resolution pipeline as other entities wherever possible.

Ensure compatibility with:

- Normal weapon attacks.
- Ability attacks.
- Four independently resolved Flurry of Blows strikes.
- Area attacks and chain attacks.
- Damage-type metadata.
- Hit/miss and critical-hit feedback.
- The unified Game Feed.
- DM controls and overrides.

Important distinctions:

- A successful attack against the dummy deals damage for reporting purposes but does not deplete survivability.
- The dummy should never trigger the normal downed/dead state transitions.
- Damage redirection and protection effects should still use the normal shared pipeline where relevant.
- The dummy should not accidentally become an infinite source of healing, damage reflection, or other secondary effects unless those mechanics are explicitly part of an ability.
- Applying a status or debuff should follow the ability's actual effect rules; immortality does not automatically make the dummy immune to every other effect.
- If a particular effect cannot meaningfully apply to a stationary training target, reject or ignore that effect according to a documented rule without breaking the rest of the ability.

Do not hardcode a special case into every attack and ability handler. Centralize the immortality behavior in the entity/damage/death-resolution layer.

## 21. DM controls

The DM should be able to:

- Spawn the Training Dummy from the existing NPC/monster bank or spawn interface.
- Move it if the existing DM controls allow entity movement.
- Remove it normally.
- Inspect/select it even when other tokens share its square.
- See damage feedback and relevant activity.
- Override or remove it through the existing DM controls.

Normal damage must not kill or down it. If the existing DM has a force-remove action, that action may still remove the entity explicitly. Do not treat manual removal as ordinary damage or death.

Do not add a separate training-mode system, dedicated game mode, or new UI subsystem unless the current architecture requires a small integration change.

## 22. Persistence and multiplayer

- Persist spawned Training Dummy instances using existing game persistence.
- Reconnects and server restarts must not convert the dummy into an ordinary monster or cause it to die.
- All clients should see the same dummy position and state.
- Damage feedback and Game Feed events should be broadcast consistently.
- Do not expose hidden information for other entities as a side effect of dummy-specific events.

## 23. Training Dummy tests

Add automated tests covering:

1. A normal attack hits the dummy and reports damage.
2. A normal attack misses according to Defense.
3. Repeated hits never deplete its survivability.
4. Extremely large damage never kills or downs it.
5. Flurry of Blows resolves four independent attacks without killing the dummy.
6. Area and chain attacks can affect it according to their targeting rules.
7. Damage modifiers and the shared pipeline remain consistent.
8. The dummy does not take normal enemy actions.
9. The dummy remains present after many hits.
10. DM removal still works.
11. Multiple spawned dummies maintain independent identities.
12. Persistence and reconnects preserve the entity type and immortality behavior.
13. Game Feed events show damage without reporting a death.
14. Normal monsters and player characters retain their existing death/downed behavior.

---

# Part 4: Implementation Order

Work incrementally in this order:

1. Inspect the existing code and report the ability, action, damage, effect, entity, chat, and activity architecture.
2. Propose the canonical ability schema and identify ambiguous mechanics.
3. Normalize the ability definitions and validate the full roster.
4. Implement shared effect handlers and lifecycle management.
5. Integrate handlers with action economy, combat phases, damage/healing, HP states, movement, NPCs/monsters, and DM overrides.
6. Add the Training Dummy definition and integrate its immortality behavior centrally in the existing entity/damage lifecycle.
7. Add deterministic tests for effect handlers, roster coverage, and Training Dummy behavior.
8. Implement the unified Game Feed using existing chat/activity infrastructure.
9. Add ordering, persistence, visibility filtering, and reconnect behavior.
10. Run regression tests for multiplayer, movement, combat, DM controls, entity spawning/removal, and existing character abilities.
11. Summarize files changed, schema decisions, tests run, unresolved mechanics, and remaining limitations.

Do not rewrite the app architecture or perform unrelated UI redesigns.

# Final Acceptance Criteria

The work is complete when:

- Every roster ability uses the structured schema.
- Every declared effect type has a working server-side handler.
- Flurry of Blows performs four independent attack rolls and separate damage rolls for successful strikes.
- Action costs, free abilities, and granted actions work with existing phase rules.
- Temporary effects apply, expire, and persist correctly.
- Damage, healing, tank mitigation, downed/dead behavior, and DM overrides remain consistent.
- NPCs and monsters use the shared engine.
- The Training Dummy can be spawned, selected, targeted, damaged repeatedly, and removed by the DM.
- The Training Dummy never enters downed or dead state from damage, regardless of cumulative damage.
- The Training Dummy does not attack or take normal combat actions.
- Training Dummy damage feedback works without causing death events or exposing hidden information.
- Chat and activity appear in one persistent, chronological Game Feed.
- Reconnects and server restarts do not lose game state or duplicate events.
- Existing One & Done functionality continues to work.

Before finishing, provide a concise implementation summary, tests performed, ability-mechanics decisions, Training Dummy design details, and remaining limitations.
