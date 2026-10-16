# One & Done — "Who Has Gone" Counter + Friendly NPC Action Economy

Implement these as incremental changes to the existing application. Inspect the current code and reuse the existing action budget (`budgeted()`, `checkAction()`, `spendAction()`, `actionAllowance()`), the DM projection and the DM top bar. Do not rebuild or refactor unrelated functionality.

## Background

In playtesting, the DM kept asking "did everyone go?" and kept forgetting to act for friendly NPCs. This change adds a counter to the DM's top bar showing how many creatures have used all their actions this phase.

Friendly NPC actions weren't tracked at all. `budgeted()` only counted actions for players and for enemies the DM acts through; friendly NPCs and the DM's own tools were unlimited. To count friendly NPCs, they now follow the same action economy as the heroes they fight alongside.

## Part 1: Friendly NPCs follow the action economy

### 1. Rules

| | Heroes | **Friendly NPCs (new)** | Monsters + hostile NPCs |
|---|---|---|---|
| Acts in (combat) | PLAYER PHASE | **PLAYER PHASE** | DM PHASE |
| Actions per phase | allowance (default 1) | **`actions` (default 1)** | `actions` (default 1) |
| Who spends them | the player | **the DM** | the DM |
| Override | DM **+1 action** | **DM +1 action** | DM **+1 action** |
| `usesPerPhase` | enforced | **enforced** | enforced |
| Movement | budgeted | **free (unchanged)** | budgeted |

- A second action is refused with "<NPC> has no actions left this phase (use +1 action to override)".
- In the DM PHASE, a friendly NPC is refused with "Friendly NPCs act during the PLAYER PHASE".
- Unchanged, and still unlimited:
  - the DM's own tools (Damage, Heal, Set HP, Kill, Revive, statuses)
  - the DM acting through a hero
  - everything outside combat
- An NPC switched between friendly and hostile follows the rules for its current side.
- Friendly NPC **movement** stays free. Only actions are limited.

### 2. Implementation

`server/games/helpers.js`:
- `budgeted(ctx, e)`: in combat, players always pay. The DM pays when acting through an enemy **or any NPC** (`!isFriendly(e) || e.kind === 'npc'`). Update the comment.
- `requireActionWindow(ctx, e)`: for the DM in combat, enemies still need the DM PHASE. Friendly NPCs need the PLAYER PHASE ("Friendly NPCs act during the PLAYER PHASE").

Everything else follows from `budgeted()` with no further changes:
- `checkAction()` and `spendAction()` refuse and count
- `runAbility()` enforces `usesPerPhase`
- `entity.grantAction` already works for any entity
- turn state still resets every phase

### 3. DM inspector and tokens

`client/js/dm.js`: the enemy-only action display now covers every NPC and monster.
- `npcActionsLeft(e)` (was `enemyActionsLeft`) returns actions left for any NPC or monster in combat. `actsIn(e)` gives `'dm'` for enemies and `'player'` for friendly NPCs.
- **Token ⚡ badge:** shown during the phase the creature acts in.
- **Banks list:** shows `⚡N` for every NPC and monster.
- **Inspector line:**
  - "⚡ N action(s) left this PLAYER PHASE." for friendly NPCs
  - "… DM PHASE. Shift-drag to force-move." for enemies
  - out of their phase: "Friendly NPCs act during the PLAYER PHASE." / "Enemies act during the DM PHASE."
- **"actions X/Y, moved Z" stats line:** shown for friendly NPCs too.
- **`actionBlock()`** (was `enemyBlock`) disables Use buttons with the right reason: the wrong phase for the creature's side, or "No actions left — use +1 action to override".

## Part 2: The "who has gone" counter

### 1. Behavior

In combat, the DM's top bar shows a badge next to the pending-checks badge:

| Phase | Counts | Example |
|---|---|---|
| PLAYER PHASE | heroes + friendly NPCs | ⏳ Party 4/6 done |
| DM PHASE | monsters + hostile NPCs | ⏳ Enemies 2/5 done |
| Everyone done | — | ✓ Party 6/6 done (green) |

- **Done** means 0 actions left this phase. Granted actions and `reduce_actions` are included, because the server's own `actionAllowance()` is used.
- **Hover:** "Still to go: Mira Vex (1 left), Town Guard (1 left)".
- **Click:**
  - a menu of the creatures still to go, with their actions left
  - clicking one opens its inspector, so the DM can act for it right away
  - when everyone has gone, the menu says "Ready for the next phase"
- **Not counted:**
  - dead creatures, objects and training dummies
  - downed NPCs and monsters, which can't act
  - creatures whose allowance is 0
- **Downed heroes are counted**, because their down roll costs their action.
- Only creatures in the active scene count. There's no badge outside combat, or when nobody qualifies.

### 2. Implementation

`server/games/project.js`: a new exported `turnProgress(state)`, added to `projectForDm()` as `turnProgress`. It returns:

```js
{ side: 'party' | 'enemies', done, total, pending: [{ id, name, left }] }
```

or `null` when combat isn't active or there's no active scene.
- **Who counts:** entities from `entitiesInScene()` on the current phase's side, minus the exclusions above.
- **Actions left:** `actionAllowance(e, state.turn[e.id])` minus `turn.actions`.
- **`pending`:** heroes first, then by name.
- It's computed on the server so it matches what the server enforces and can be tested.

`client/js/dm.js`: `turnsBadge()` renders the button in `renderTop()`, which runs on every state update. It uses the existing `popupMenu()` and `select()`.

`client/css/app.css`: `.turns-badge` and `.turns-badge.all-done` (using `var(--good)`), next to `.checks-badge`.

## Part 3: Docs and generated schema text

Every place that said friendly NPCs act in any phase without an action limit now describes the new rule:
- **README:** the Enemy actions paragraph covers friendly NPCs, and a new "Who has gone" bullet describes the counter.
- **`docs/ABILITIES.md`:** the Action economy section.
- **`docs/NPC_GENERATION.md`:**
  - the friendly/hostile table rows for "When it acts" and "Action limit"
  - the test description
- **`scripts/build-npc-schema.js`:** the ability description, the NPC overview and the `actions` field description. Then run `npm run build:schemas`, which regenerates `schemas/npc.schema.json`.

## Part 4: Tests and Acceptance Criteria

### Updated tests (old rule → new rule)

- **`test/rules.test.js`:** a friendly NPC acts once per PLAYER PHASE. The second attack is refused, +1 action allows another, the DM PHASE refuses it, and the next PLAYER PHASE gives a fresh action. Hostile NPCs keep the enemy rules.
- **`test/npc-schema.test.js`:** the friendly healer's second Mend in a phase is refused until +1 action.
- **`test/effects.test.js`:** the assertion message now reads "friendly NPC acts in the player phase".
- **`test/effect-types.test.js`:**
  - The arena's friendly-NPC casters get `actionsPerPhase = 99`, because those suites test effects, not the action economy.
  - Tests where a caster acted in the DM PHASE now act in PLAYER PHASEs: the dash vs snared/frightened test, and the recast-restarts-duration test (now a 3-phase buff, recast in round 2).

### New tests (`test/turn-progress.test.js`)

- **No combat:** no counter.
- **PLAYER PHASE:**
  - Two heroes and a friendly Town Guard give `party 0/3`, ordered Cleric, Shadow Rogue, Town Guard.
  - A hero's Act gives 1/3, and the guard's attack gives 2/3.
  - The guard's second attack is refused. After +1 action, the guard is pending again with 1 left.
- **DM PHASE:**
  - The goblin and the hostile NPC give `enemies 0/2`, and the goblin attacking gives 1/2.
  - The friendly guard is refused with "Friendly NPCs act during the PLAYER PHASE".
  - The next round starts at 0.
- **Granted and reduced actions:**
  - a hero with a granted action still has 1 left after one action
  - a creature reduced to 0 actions, a killed NPC and a training dummy aren't counted
- **Downed hero:** counted until its down roll, then done.

All existing tests still pass.

### Manual check (DM view plus one player, with a friendly NPC and a monster)

1. Start combat. The top bar shows "⏳ Party 0/2 done", and hovering lists the hero and the NPC.
2. The hero acts → "1/2". Click the badge, then the NPC. Its inspector opens with "⚡ 1 action(s) left this PLAYER PHASE".
3. Use the NPC's attack → "✓ Party 2/2 done" in green. A second attack is refused with the +1 action hint.
4. Advance → "⏳ Enemies 0/1 done".

## Implementation Approach

1. Change `budgeted()` and `requireActionWindow()` for friendly NPCs.
2. Update the existing tests and the effect-test arena for the new rule.
3. Add `turnProgress()` to the DM projection, with tests.
4. Add the top-bar badge, and generalize the ⚡ and inspector displays to friendly NPCs.
5. Update the docs and the NPC schema generator text, rebuild the schemas, and run the full suite.
