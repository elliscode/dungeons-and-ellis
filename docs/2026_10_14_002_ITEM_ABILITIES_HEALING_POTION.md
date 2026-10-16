# One & Done — Item Abilities + Healing Potion

Implement this as an incremental change to the existing application. Inspect the current code and reuse the existing content loader, ability effect engine, heal pipeline and the player's ability targeting flow. Do not rebuild or refactor unrelated functionality.

## Background

Items are currently just names. `"healing-potion"` in a hero's `inventory` becomes `{ id, name: "Healing Potion" }`, and using any item spends an action, removes it and logs "X uses Healing Potion". There are no item definitions, so an item can't actually do anything.

This change lets an item have an optional **ability**. Using such an item asks the player how to perform it (the same targeting flow as a character ability), and the item is only used up once the ability resolves. The first item to get one is the **Healing Potion**.

## Part 1: Item catalog

### 1. `data/items.json`

Add a new single-file content category, `items`, alongside `acts.json`:

```json
[
  {
    "id": "healing-potion",
    "name": "Healing Potion",
    "description": "Drink it or give it to an adjacent ally: heals 25.",
    "ability": {
      "range": 1,
      "effects": [{ "type": "heal", "target": "ally_or_self", "heal": 25, "range": 1 }]
    }
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Kebab-case, unique. Matches the ids used in `inventory` arrays. |
| `name` | yes | Display name. |
| `description` | no | Shown in the player's Items menu. |
| `ability` | no | Same schema as a character ability. Without it, the item behaves as before. |

- Handle `acts` and `items` with one single-file lookup (`acts.json`, `items.json`) rather than more `category === 'acts'` special cases in `server/content.js`.
- `items.json` is optional. If it's missing, there are no item definitions, which is not an error, so older data folders still load.
- Validate items in `validateDefs()`: the usual `id`/`name` checks, `description` must be text, and `ability` must be an object that passes the existing `validateAbility()`.
- It's watched and live-reloaded like the other content files.
- Send the catalog to clients in both `publicContent()` and `dmContent()`, with each ability in the client form the Act menu already uses (normalized, plus server-computed `targeting`). The catalog isn't secret.

### 2. Matching inventory entries to the catalog

- `makeItem(name, defId)` stores the catalog id on the inventory entry when an item comes from a definition: `"healing-potion"` gives `{ id, name: "Healing Potion", defId: "healing-potion" }`.
- Lookup is by `defId` first, then a case-insensitive name match. The name fallback covers:
  - tokens already in live games, whose items were created before `defId` existed
  - items the DM adds by name ("healing potion")
- The server (`content.item(inv)`) and the client use the same rule.

### 3. Data page

- Add an **🧪 Items** section with a starter example and a short note.
- Like acts, it's a single file with no "New file" or "Upload" buttons. If `items.json` doesn't exist, offer **+ Create items.json**.

## Part 2: Using an item with an ability

### 1. Server: `item.use`

- Look up the item's catalog entry.
- **No ability:** unchanged. Spend the action, remove the item, log "X uses Y".
- **Has an ability:** run it through the shared ability engine with the `targetId`, `cell` or `picks` sent by the client, then remove the item.
  - Split `activateAbility()` into the existing lookup plus an exported `runAbility(ctx, entity, ability, { item })` core, so abilities and items share one path. Ability behavior must not change.
  - Any failure throws before the item is removed. The command rolls back, so the item is kept. Failures include:
    - the target is out of range
    - the target isn't an ally
    - the target is dead
    - the user has no actions left
  - It costs the ability's `actionCost` (default 1).
  - Item abilities don't count toward `usesPerPhase`; the item being consumed is the limit.
  - The feed line comes from the ability, e.g. "Shadow Rogue uses Healing Potion on Cleric: Cleric +25 (25)…".
- Keep the existing guards: players only, the user must be active (a downed hero can't drink a potion themselves), and it must be the player's window.

### 2. Client: the player's Items menu

- **An item with an ability** shows its description and ability summary (e.g. "heal 25 · range 1"). Clicking it calls the existing `startAbility()` targeting flow, with `send` wrapped to issue `item.use` with the item's id. This reuses:
  - the banner ("Healing Potion: choose an ally or yourself")
  - the range highlight and the ally/self filter
  - Esc to cancel. Cancelling sends nothing, so the item is kept.
- **An item without an ability** is used in one click, unchanged.

## Part 3: Healing Potion

| Property | Value |
|---|---|
| Range | 1 (yourself or an adjacent ally) |
| Heal | Flat 25 |
| Cost | 1 action in combat |
| Heal role bonus | Not applied |

### 1. Flat heal amounts

- `heal` (and `chain_heal`) accept a whole number from 1 to 1000 as well as dice. Validation rejects 0, decimals, and anything out of range.
- A numeric heal is applied as-is, with no roll. The feed shows it as "+25 (25)".

### 2. No Heal role bonus on item heals

- `healTarget()` takes a `roleBonus` option (default `true`). Item abilities pass `false`, so a Heal-role hero's potion heals 25, not 25 × the role multiplier.
- Caster bonuses such as Beacon of Grace still apply.

### 3. Downed allies

- An adjacent ally can give a potion to a downed hero.
- Under the healing rule from `2026_10_14_001_HEALING_RESETS_NEGATIVE_HP.md`, negative HP resets to 0 first, so a hero at −16 gets up at 25.

## Part 4: Docs and schemas

- `docs/ABILITIES.md`: an "Item abilities" section, and a note in the effect table that `heal` may be a whole number.
- `inventory` item descriptions in the character, NPC and monster schemas say that ids in `data/items.json` get that item's ability.
  - The NPC and monster schemas are generated: change `scripts/build-monster-schema.js` and `scripts/build-npc-schema.js`, then run `npm run build:schemas`.

## Part 5: Tests and Acceptance Criteria

Add `test/items.test.js` and a matching `test/fixtures/data/items.json`:

- A hero's potion links to the catalog (`defId: "healing-potion"`).
- Drinking a potion heals exactly 25, removes it, and logs the ability line.
- A Heal-role hero's potion heals 25, not 25 × the multiplier.
- A potion given to an adjacent downed ally at −16 HP leaves them active at 25.
- The potion is kept when:
  - the target is out of range
  - the target is an enemy
  - the user has no actions left
- An item without an ability (Thieves Tools) is still used up in one click.
- A DM-added "healing potion" with no `defId` gets the ability by name.
- Catalog validation accepts a plain item and a valid potion, and rejects:
  - `heal: 0`
  - an unknown effect type
  - a non-object `ability`
- The existing inventory test, the schema "up to date" tests, and the rest of `npm test` still pass.

Manual check:
1. As a player, damage a hero, then open Items → Healing Potion.
2. The banner reads "Healing Potion: choose an ally or yourself", and only you and adjacent allies are clickable.
3. Pick one: HP goes up by 25 and the potion leaves the inventory.
4. Repeat, but press Esc instead of picking: the potion is kept.

## Implementation Approach

1. Add the `items` category, validation and catalog lookup to `server/content.js`, plus `data/items.json` and its test copy.
2. Store `defId` on inventory entries in `makeItem()` / `entityFromDef()`.
3. Allow numeric `heal` values, and add `roleBonus` to `healTarget()`.
4. Split `activateAbility()` into `runAbility()`, and route `item.use` through it for items with an ability.
5. Update the player's Items menu and the Data page.
6. Update the docs and schema generators, rebuild the schemas, add the tests, and run the full suite.
