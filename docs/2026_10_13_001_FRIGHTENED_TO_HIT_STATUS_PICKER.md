# One & Done — Frightened: To-Hit Penalty + DM Status Picker

Implement these as incremental changes to the existing application. Inspect the current code and reuse the existing status table, shared attack-roll pipeline, and the DM board's targeting mode. Do not rebuild or refactor unrelated functionality.

## Background

Frightened already stopped a creature from moving closer to the creature that frightened it (its *source*, stored as `params.sourceId` on the effect). In play it often looked like it did nothing: a frightened creature already next to its source could keep attacking with no penalty. The DM also couldn't apply frightened by hand, because the manual "Add status…" dropdown had no way to say who the source was.

## Part 1: Frightened gives −2 to hit

### 1. Rules

| Status | Effect |
|---|---|
| Frightened | −2 to hit, and can't move closer to its source |

- Apply the penalty in the shared server-side attack roll (`attackRoll()` in `server/games/combat.js`), through the same status penalty table as shaken and poisoned (`STATUS_TO_HIT`).
- The penalty applies to every attack roll the frightened creature makes: weapon attacks, attack abilities, multi, area and chain attacks.
- The penalty applies whether or not the source is in range or still alive. This is a deliberate simplification of the D&D rule (which only applies while the source is in sight).
- Keep the existing movement rule unchanged: no ending a move or dash closer to the source, and the DM's Shift-drag still forces a move.

### 2. Stacking

- Frightened never stacks with itself. A creature frightened twice, for example by two different sources, still gets −2. Each status counts once per attack roll, however many copies are on the creature.
- Different statuses do stack. Frightened + shaken is −4, the same as shaken + poisoned. This is intended.
- Each copy of frightened still enforces its own movement restriction, so a creature frightened of two sources can't move closer to either one.

### 3. Descriptions

Every description of frightened must mention both parts of the rule.

- Status comment in `server/games/effects.js`, the `apply_status` description in the character, NPC and monster schemas, and `docs/ABILITIES.md`.
- Ability descriptions that apply frightened now read "frightened (−2 to hit, can't move closer to …)":
  - Intimidating Roar (`data/characters/tanks.json`)
  - Rook's gavel ability (`data/npcs/gilded-betrayal.json`)
  - An Offer You Can't Refuse (`data/npcs/abomination-of-blackthorn.json`). It applies frightened *and* shaken, so its description says "and shaken (another −2 to hit)" to make the −4 total clear.
  - Haunting Chill and Dreadful Presence (`data/monsters/monsters.json`). These also gain the range and duration, matching how the NPC abilities are worded.

## Part 2: DM can add frightened by picking its source on the map

### 1. Flow

1. The DM selects a creature and chooses **frightened** in the inspector's "Add status…" dropdown.
2. The board enters a picker mode with the banner **"Choose who <name> is frightened of"**, plus the usual Cancel (Esc) button.
3. The DM clicks any creature on the map. That creature becomes the source, and the status is applied.

The other statuses (poisoned, snared, shaken, slowed) still apply immediately when chosen, with "DM" as their source.

### 2. Server: `effect.addStatus`

- Accept `status: 'frightened'` along with a new `sourceId` field.
- Reject:
  - frightened with no `sourceId` ("Choose who <name> is frightened of")
  - a source that no longer exists ("That token no longer exists")
  - the creature itself as the source ("A creature can't be frightened of itself")
  - an object as the source ("Objects can't frighten anyone")
- Store the effect the same way the `apply_status` ability effect does: `params.sourceId` and `source: { entityId, name }` both point at the chosen creature. The movement check and the to-hit penalty then work without changes.
- Duration is `next_dm_phase`, like the other manual statuses. The command remains undoable.
- Game Feed: "<name> is frightened of <source>".
- `sourceId` is ignored for every other status.

### 3. Client: DM inspector and board

- Add `frightened` to the dropdown.
- Choosing it resets the dropdown and starts the existing `'target'` board mode (the same one the DM's attack "Use" button uses), with:
  - origin: the frightened creature
  - unlimited range
  - valid targets: anything except the creature itself and objects
- Reuse the mode's existing behavior: valid targets are highlighted, the "Which target?" popup appears for stacked tokens, Esc cancels, and the mode clears itself if the creature is removed.
- With unlimited range, don't tint the range cells, so the whole board isn't highlighted.
- Add one line to `docs/ABILITIES.md` saying the DM picks the source on the map.

## Part 3: Tests and Acceptance Criteria

### To-hit penalty

- Frightened gives exactly −2 to hit (covered with poisoned and shaken).
- A creature with two copies of frightened still gets only −2.
- The existing movement and dash tests for frightened still pass.

### DM picker

- `effect.addStatus` with frightened and no source fails; with the creature as its own source it fails.
- With a valid source, the effect stores that source, the feed says "<name> is frightened of <source>", moving closer to the source fails, moving away succeeds, and the creature's attack takes −2.
- Manual check: choose frightened → the banner appears → click a hero → the inspector shows "Frightened · <hero>". Dragging toward that hero is refused unless Shift-dragged, and Esc cancels the picker without applying anything.

## Implementation Approach

1. Add frightened to the to-hit penalty table and confirm the per-status de-duplication in `attackRoll()` covers stacking.
2. Update the schemas, docs and ability descriptions.
3. Extend `effect.addStatus` to take a source for frightened.
4. Add the dropdown option and reuse the board's target mode for the picker.
5. Add tests, then run the full suite.
