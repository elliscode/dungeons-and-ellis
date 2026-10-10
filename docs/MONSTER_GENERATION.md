# Generating monsters with an LLM

[`schemas/monster.schema.json`](../schemas/monster.schema.json) is a JSON Schema (draft 2020-12) for one Monster-bank entry. It allows everything the game supports for monsters today, even though the current bank uses only part of it. If a monster passes the schema, the server will load it.

## Workflow

1. Give the LLM the schema, two or three monsters from `data/monsters/monsters.json` as examples, and the prompt below.
2. Save its output to a file and validate it:

   ```sh
   npm run validate:monsters -- path/to/new-monster.json
   ```

   This runs the schema, a duplicate-id check within the monster, and the server's own content rules against the existing bank, so id clashes are caught. It also warns if the `image` file doesn't exist. Paste any errors back to the LLM and ask it to fix them.
3. Add the monster to the bank. You can append it to `data/monsters/monsters.json`, save it as `data/monsters/<id>.json` (a single object is fine), or upload it on the Data page.

Run `npm run validate:monsters` with no arguments to check the whole bank.

## What a monster can have

| Field | Notes |
| --- | --- |
| `id`, `name`, `image`, `defense`, `movement`, `attacks` | Required. `attacks` can be empty for things that never attack. |
| `maxHp` | Required unless `immortal`. |
| `actions` | Actions per DM phase. Default 1; 2 for bosses; 0 for things that never act. |
| `size` | Footprint in squares: `{ "w": 2, "h": 2 }` for large, `3×3` for huge. |
| `abilities` | The same effect engine as heroes (see [ABILITIES.md](ABILITIES.md)). |
| `damageType` on a weapon attack | Optional. Magical types matter for protections like Spellguard. |
| `hostile: false` | Sides with the party: no action limit, players see its HP, heroes treat it as an ally. |
| `immortal: true` | Training-dummy behavior: no HP, records damage, can never be downed or killed. Omit `maxHp`. |
| `inventory` | Loot or carried items; only the DM sees a hostile monster's items. |
| `description` | A note for the DM. Not shown to players and not used by the game. |

## Rules the LLM needs to know (already written into the schema)

- Hostile monsters act only in the DM PHASE. Each phase they get `actions` actions (one weapon attack or one ability each), plus `movement` squares.
- Monster abilities follow the same enemy rules. Abilities that deal damage only work in combat.
- Monsters get no role bonuses, but heroes do: DPS heroes deal 4× damage, tanks take ¼, and healers heal 4×. Size `maxHp` with that in mind.
- In a monster's abilities, `enemy` means heroes (and friendly NPCs), and `ally` means other monsters.

## Prompt

```text
You are designing a monster for "One & Done", a grid-based tabletop RPG run by a human DM.
Output ONE JSON object that validates against the attached JSON Schema. Output only the JSON.

Rules:
- Mechanics come only from structured fields. `description` is an optional note for the DM.
  Never rely on it for mechanics.
- Use only the effect types and fields defined in the schema. If an idea can't be expressed,
  pick the closest supported effect, or leave it to the DM in the description.
- Match the power level of the example monsters and stay inside the "Typical" ranges in the
  field descriptions. Remember DPS heroes deal 4× damage when choosing maxHp.
- Most monsters have 1–2 weapon attacks and no abilities. Bosses may have actions: 2 and 1–2 abilities.
- Resistible debuffs on heroes go inside roll_to_apply (roll vs the target's Defense).
- Large creatures set size (2×2 or 3×3) and usually reach 2 with melee.
- Pick image "/static/tokens/monster_NNN.webp" with NNN between 001 and 071.

Monster request:
<describe the monster: theme, threat level, how it fights, anything specific>
```

## Balance reference (current bank)

| | maxHp | defense | movement | attacks |
| --- | --- | --- | --- | --- |
| Vermin (rat) | 7 | 12 | 6 | 1d20+4, 1d4+2 |
| Soldier (goblin, skeleton, orc) | 9–16 | 13 | 6 | 1d20+4 to +5, 1d6+2 to 1d12+3 |
| Brute (ogre, 2×2) | 59 | 11 | 5 | 1d20+6, 2d8+4 |
| Boss (dragon, 3×3) | 120 | 18 | 8 | 1d20+10, 2d10+6; breath 1d20+8, 6d6 |

## Keeping the schema in sync

`monster.schema.json` is **generated** from `character.schema.json`. The shared attack, ability and effect definitions are copied over, and only the monster fields live in `scripts/build-monster-schema.js`.

- **After editing `character.schema.json`:** run `npm run build:monster-schema`.
- **When monsters gain new engine features:** edit the monster fields in `scripts/build-monster-schema.js`, then rebuild.

`test/monster-schema.test.js` fails if the generated file is out of date. It also checks that:

- every bank monster passes the schema;
- every effect type works in a monster ability, through both the schema and the engine;
- the schema rejects what monsters can't have, such as a `role`, or `maxHp` on an immortal monster.
