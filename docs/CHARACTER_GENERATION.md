# Generating characters with an LLM

[`schemas/character.schema.json`](../schemas/character.schema.json) is a JSON Schema (draft 2020-12) for one playable hero. It's strict: every effect type, field, enum, and numeric range in it is also accepted by the effect engine (`server/games/effects.js`). If a character passes the schema, the server will load it.

## Workflow

1. Give the LLM the schema, two or three roster heroes of the same role from `data/characters/` as examples, and the prompt below.
2. Save its output to a file and validate it:

   ```sh
   npm run validate:characters -- path/to/new-hero.json
   ```

   This runs the schema, a duplicate-id check within the character, and the server's own content rules against the existing roster, so id clashes are caught. It also warns if the `image` file doesn't exist. Paste any errors back to the LLM and ask it to fix them.
3. Add the hero to the roster. You can append it to `data/characters/<role>.json`, save it as `data/characters/<id>.json` (a single object is fine), or upload it on the Data page.

Run `npm run validate:characters` with no arguments to check the whole roster.

## Prompt

```text
You are designing a playable hero for "One & Done", a grid-based tabletop RPG.
Output ONE JSON object that validates against the attached JSON Schema. Output only the JSON.

Rules:
- Mechanics come only from structured fields. `description` is flavor and must accurately
  describe what the effects do. Never describe a mechanic the effects don't implement.
- Role bonuses (tank damage reduction, DPS/healer multipliers) are applied automatically by
  the game. Don't mention them, or any multiplier, in descriptions.
- Use only the effect types and fields defined in the schema. If an idea can't be expressed,
  pick the closest supported effect, or use a "narrative" effect for pure roleplay utility.
- Match the power level of the example heroes: 2 weapon attacks (usually one melee, one ranged)
  and 2–3 abilities. Stay inside the "Typical" ranges in the field descriptions.
- Abilities normally cost 1 action. Free abilities (actionCost 0) should be modest and set
  usesPerPhase: 1.
- Resistible debuffs on enemies go inside roll_to_apply (roll vs the target's Defense).
- Follow-up effects that should only happen on a hit use "when": "attack_hits", and target
  "hit_enemies" (or "self" for self-heals/buffs).
- Pick image "/static/tokens/token_NNN.webp" with NNN between 001 and 213.

Character request:
<describe the hero: role, theme, playstyle, anything specific>
```

## Balance reference (current roster)

| | Tank | DPS | Heal |
| --- | --- | --- | --- |
| maxHp | 40–48 | 29–36 | 30–36 |
| defense | 16–19 | 13–15 | 13–17 |
| movement | 4–5 | 6–7 | 5–7 |
| Weapon attack | 1d20+4 to +6 | 1d20+4 to +6 | 1d20+3 to +5 |
| Weapon damage | 1d8+4 to 1d12+4 | 1d8+4, 1d10+3, 2d6+2 | 1d6+2 to 1d8+3 |
| Single-target heal | | | 1d8+3 (range 6), 2d8+3 (adjacent) |

Role bonuses are automatic, so don't add abilities for them or mention them in descriptions (the rules live in `server/games/roles.js`):
- Tanks take 1/n of the damage from every hit (minimum 1).
- DPS deal n× the listed damage.
- Healers heal for n× the listed amount, capped at max HP.

n is the global *role strength* setting (1–5, default 4), chosen on the DM home page.

Keep listed dice at the levels in this table. The multipliers are applied on top.

## Keeping the schema in sync

`test/character-schema.test.js` compares the schema to the engine's registry (`SPECS`, `EFFECT_TYPES`, `STATUSES`, `TARGETS`, `DURATIONS`, `TRIGGERS`). It also runs one sample ability per effect type through both the schema and `validateAbility()`. The test fails when:

- a new effect type is added to `SPECS` without a matching `$defs.effect_<type>` and entry in `$defs.effect.oneOf`, or without a sample in the test;
- an engine field becomes required, or gains a numeric range that the schema doesn't respect;
- a status is added or removed;
- the schema allows something the engine would reject.

When you extend the engine, update the schema and add a sample to `SAMPLES` in `test/schema-samples.js`. Then run `npm run build:schemas`, because the monster and NPC schemas ([MONSTER_GENERATION.md](MONSTER_GENERATION.md), [NPC_GENERATION.md](NPC_GENERATION.md)) copy their shared definitions from this one. Also update the field descriptions and the balance table above, since that's what the LLM reads.

The schema is intentionally narrower than the engine in a few places, to keep generated output clean:

- Attack and check rolls must be `1d20±N`.
- Legacy ability fields (`free`, `heal` at the ability level, and so on) aren't allowed.
- Each effect only lists the targets that make sense for it.
- `immortal` isn't allowed, since heroes can't be immortal.
