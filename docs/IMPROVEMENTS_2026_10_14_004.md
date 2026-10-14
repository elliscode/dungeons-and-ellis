# One & Done — Undo Movement for Players

Implement this as an incremental change to the existing application. Inspect the current code and reuse the existing turn state, movement validation, `spendAction()` and the player's top bar. Do not rebuild or refactor unrelated functionality.

## Background

In combat, a player who drags their token to the wrong square loses that movement for the rest of the phase. Only the DM's global Undo can fix it. This change lets a player **take back their latest move and get the squares back**, as long as they haven't performed an action since.

Movement is already tracked per phase in turn state (`state.turn[entityId].moved`), and `state.turn` is reset on every phase change.

## Part 1: Behavior

### 1. When undo is available

- **Combat only, during the PLAYER PHASE.** Outside combat movement is free, so there's nothing to give back.
- **Only for the player's own active hero.** A downed or dead hero can't undo, and nobody else can undo for them, including the DM through this command.

### 2. What undo does

- Each undo steps back **one** move:
  - the token returns to the square that move started from
  - that move's squares are added back to the movement budget
- Pressing it again undoes the move before that, all the way back to where the hero started the phase.
- With nothing left to undo: "Nothing to undo".
- Game Feed: "<hero> takes back their move".

### 3. What locks moves in

Once a move is locked in, it can no longer be undone. The following lock in **all** of the hero's moves so far this phase:

| Event | Why |
|---|---|
| Any action: attack, ability, item, Act, down roll | The player has committed to their position. |
| A free ability (`actionCost: 0`, e.g. Cunning Action) | Using any ability counts as acting, even if it costs nothing. |
| The DM moving the hero (normal or Shift-drag force move) | Undo must never undo the DM's placement. |
| The phase ending | Turn state is reset each phase. |

- Moves made **after** one of these can still be undone, back to that point.
- An action that **fails** (out of range, wrong target, no actions left) doesn't lock anything in, because failed commands roll back.

### 4. Safety net

If the token isn't on the square the last move left it on (for example, it was moved by something that bypassed the `move` command), undo is refused with "You were moved since then, so that move can't be undone". Undo must never teleport a token from somewhere else.

### 5. DM Undo

- `move.undo` is itself an undoable command, so the DM's global Undo can reverse a player's undo. That puts the token back where it was and uses the squares again.

## Part 2: Implementation

### 1. Server

`server/games/state.js`: the default turn object gains `moves: []`. Turn objects in live games that lack it are handled with `t.moves ??= []`.

`server/games/commands.js`, `move`:
- When a **player** pays for a move in combat, push `{ sceneId, from, to: { x, y }, dist }` onto `t.moves`.
- When the **DM** moves an entity that has turn state, clear its `moves`. This happens before the position changes, and applies to force moves too.

`server/games/commands.js`, new command `move.undo` (`who: 'player'`, `undoable: 'undo move'`):
1. `controlled()`, `onActiveScene()`, `requireStatus(e, 'move')`.
2. Refuse outside combat ("Undo move only works in combat"), then `requirePlayerWindow()` ("Wait for the PLAYER PHASE").
3. Take the last entry of `t.moves`; with none, fail "Nothing to undo".
4. If the active scene isn't that entry's scene, or the token isn't on that entry's `to` square, refuse with the "moved since" message.
   - Don't try to clear the history before failing. A failed command rolls back all its changes, so the clear would be lost. Clearing happens where the DM move happens instead.
5. Pop the entry, put the token back on its `from` square, bump `z`, reduce `t.moved` by the entry's distance (not below 0), and log.

`server/games/helpers.js`, `spendAction()`: at the very top, before the early return for free actions, clear `turnFor(...).moves` whenever the action is budgeted (in combat). Every action already goes through `spendAction()`:
- attacks, Acts, `item.use` (both paths) and down rolls
- `runAbility()`, which covers all abilities, including dash and teleport

No projection change is needed. Players already receive their own `turn`, which now includes `moves`. It's their own data, so nothing leaks.

### 2. Client

`client/play.html`: an **↶ Undo move** button next to `#turn-info` in the top bar. It's hidden by default, and its tooltip mentions the shortcut and that acting locks moves in.

`client/js/play.js`:
- `canUndoMove()` is true when all of these hold:
  - the player has a hero
  - the hero is active
  - combat is active
  - it's the PLAYER PHASE
  - `state.turn.moves` isn't empty
- `undoMove()` sends `{ type: 'move.undo', entityId }` through the existing `send()`, so any error shows as the usual bottom toast.
- `gameScreen()` shows or hides the button with `canUndoMove()` on every render. It disappears as soon as there's nothing to undo or the player acts.
- **Ctrl/Cmd+Z** calls `undoMove()` when `canUndoMove()` is true and focus isn't in a text input, matching the DM page's Undo shortcut.

### 3. Docs

The README's Combat paragraph explains Undo move: the button and shortcut, getting the squares back, and what locks moves in.

## Part 3: Tests and Acceptance Criteria

Add `test/move-undo.test.js`:

- **Stepping back:** move 3 then 2. Undo goes back to the end of the first move with 3 used, undo again goes back to the start with 0 used, and a third undo is "Nothing to undo". The feed says "takes back their move".
- **Budget restored:** use all 7 squares of movement (the next move is refused), undo, then move 7 squares again.
- **Acting locks in:** move, then Act. Undo is refused and the token stays put. A move after the Act can be undone, and it gives back only that move's squares.
- **Free ability:** move, then Cunning Action. Undo is refused.
- **Failed action:** move, then an out-of-range attack (refused). Undo still works.
- **DM move:** move, then the DM moves the hero. Undo is refused and the token stays put. A later move can be undone back to the DM's square.
- **Safety net:** if the token's position is changed outside the `move` command, undo is refused with the "moved since" message and the token isn't moved.
- **Timing:** refused outside combat and during the DM PHASE, and the history is gone after the phase changes.
- **Ownership:** another player can't undo your move, and the DM can't send `move.undo`. The DM's Undo reverses a player's undo.

All existing tests still pass.

Manual check, as a player in combat:
1. Move 3 squares. The top bar shows "Move: 3/6" and the **↶ Undo move** button.
2. Click the button. The token returns, the bar shows "Move: 6/6", and the button hides.
3. Move again, then press Ctrl/Cmd+Z. Same result.
4. Move, then use an Act. The button disappears and undo is no longer possible.

## Implementation Approach

1. Add `moves` to turn state, and record player moves in `move`.
2. Clear the history in `spendAction()` and on DM moves.
3. Add the `move.undo` command with its checks.
4. Add the top-bar button, `canUndoMove()` / `undoMove()` and the shortcut.
5. Add the tests and the README line, then run the full suite.
