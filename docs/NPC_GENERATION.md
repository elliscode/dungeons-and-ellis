# Generating NPCs with an LLM

[`schemas/npc.schema.json`](../schemas/npc.schema.json) is a JSON Schema (draft 2020-12) for one NPC-bank entry. NPCs have the same shape as monsters, but they are **friendly by default**, so the schema describes sides, targets and actions from the NPC's point of view. If an NPC passes the schema, the server will load it.

## Workflow

1. Give the LLM the schema, two or three NPCs from `data/npcs/npcs.json` as examples, and the prompt below.
2. Save its output to a file and validate it:

   ```sh
   npm run validate:npcs -- path/to/new-npc.json
   ```

   This runs the schema, a duplicate-id check within the NPC, and the server's own content rules against the existing bank, so id clashes are caught. It also warns if the `image` file doesn't exist. Paste any errors back to the LLM and ask it to fix them.
3. Add the NPC to the bank. You can append it to `data/npcs/npcs.json`, save it as `data/npcs/<id>.json` (a single object is fine), or upload it on the Data page. The running server picks up new files automatically.

Run `npm run validate:npcs` with no arguments to check the whole bank.

## How NPCs differ from monsters

| | Friendly NPC (default) | Hostile NPC (`hostile: true`) |
| --- | --- | --- |
| Side | The party's | The monsters' |
| `ally` / `enemy` in abilities | heroes and friendly NPCs / monsters | monsters / heroes |
| When it acts | Any phase | DM PHASE only |
| Action limit | None (the DM decides) | `actions` per DM phase (default 1) |
| Players see its HP | Yes | No |

The DM can flip any NPC between friendly and hostile mid-game with the **Mark hostile** / **Mark friendly** button. Only the DM ever sees an NPC's inventory and attacks.

## Prompt

```text
You are designing an NPC (non-player character) for "One & Done", a grid-based tabletop RPG
run by a human DM. Output ONE JSON object that validates against the attached JSON Schema.
Output only the JSON.

Rules:
- Mechanics come only from structured fields. `description` is an optional note for the DM
  (personality, secrets, what they want). Never rely on it for mechanics.
- NPCs are friendly by default. Only set "hostile": true if the NPC should start as an enemy.
- In abilities, "ally" and "enemy" are relative to the NPC's side. For a friendly NPC, "ally"
  means the heroes and "enemy" means the monsters.
- Use only the effect types and fields defined in the schema. Use a "narrative" effect for
  roleplay or utility abilities that the DM adjudicates.
- Most NPCs are townsfolk with low stats, 0–1 weapon attacks and no abilities. Only notable
  NPCs (companions, mages, rivals) get abilities.
- Stay inside the "Typical" ranges in the field descriptions. An NPC meant to fight the party
  should be sized like a monster.
- Pick image "/static/tokens/token_NNN.webp" (001–213) for people, or
  "/static/tokens/monster_NNN.webp" (001–071) for creatures.

NPC request:
<describe the NPC: who they are, where they're found, whether they fight, anything specific>
```

## Balance reference (current bank)

| | maxHp | defense | movement | attacks |
| --- | --- | --- | --- | --- |
| Commoner (merchant, innkeeper) | 6–8 | 10 | 5 | none, or 1d20+2, 1d4 |
| Guard | 11 | 16 | 6 | 1d20+3, 1d6+1 |
| Notable (Walky the Wize) | 25 | 12 | 5 | 1d20+5, 1d8+2 |
| Powerful (Mysterious Wizard) | 40 | 15 | 6 | 1d20+7, 2d8+3 |

## Keeping the schema in sync

`npc.schema.json` is **generated** from `character.schema.json`. The shared attack, ability and effect definitions are copied over, and only the NPC fields live in `scripts/build-npc-schema.js`.

- **After editing `character.schema.json`:** run `npm run build:schemas`, which rebuilds the monster and NPC schemas.
- **When NPCs gain new engine features:** edit the NPC fields in `scripts/build-npc-schema.js`, then rebuild.

`test/npc-schema.test.js` fails if the generated file is out of date. It also checks that:

- every bank NPC passes the schema;
- every effect type works in an NPC ability, through both the schema and the engine;
- the schema rejects what NPCs can't have, such as a `role`, old-style ability fields, or `maxHp` on an immortal NPC;
- in a real game, a friendly NPC heals a hero in the player phase without spending actions, and a hostile NPC follows the enemy rules.
