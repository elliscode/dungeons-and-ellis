# One & Done — No Red Player Color

Implement this as an incremental change to the existing application. Inspect the current code and change the shared player color lists rather than individual pickers. Do not rebuild or refactor unrelated functionality.

## Background

Enemies (monsters and hostile NPCs) are drawn in red on the board. Red (`#e6194b`) was also the **first** player color, so the first player to join a game was always red and could be mistaken for an enemy. This change removes red from the player color bank and adds a replacement at the end of the list.

## Part 1: The color bank

### 1. New list

| # | Before | After |
|---|---|---|
| 1 | red `#e6194b` | green `#3cb44b` |
| 2 | green `#3cb44b` | blue `#4363d8` |
| 3 | blue `#4363d8` | orange `#f58231` |
| 4 | orange `#f58231` | purple `#911eb4` |
| 5 | purple `#911eb4` | cyan `#42d4f4` |
| 6 | cyan `#42d4f4` | magenta `#f032e6` |
| 7 | magenta `#f032e6` | lime `#bfef45` |
| 8 | lime `#bfef45` | pink `#fabed4` |
| 9 | pink `#fabed4` | yellow `#ffe119` |
| 10 | yellow `#ffe119` | **teal `#469990`** (new) |

- There are still 10 colors, one per seat (games hold at most 10 players).
- Teal comes from the same accessible 20-color set as the others. It's clearly different from green and cyan, and readable on the dark UI.
- New players still get the first free color, so the **first player to join is now green**.
- Red can no longer be picked. `player.setColor` and `dm.setPlayerColor` refuse it with "Pick a color from the bank".
- The DM's gold (`#d4af37`) is unchanged.

### 2. Two lists, kept identical

The list exists in two places, which must match exactly:
- `server/games/state.js`, `PLAYER_COLORS`: used for assigning, validating, the DM's color, pings and the feed.
- `client/js/common.js`, `PLAYER_COLORS`: renders the swatch pickers in the player's You menu and the DM's Players tab.

Both carry a comment saying red is left out on purpose (it's the enemy color) and pointing to the other copy. A test checks they're equal.

## Part 2: Existing games

Players in saved games who already have red are moved to a free color when the game loads.

- `server/games/state.js`, new `upgradeState(state)`:
  - for each player whose color isn't in `PLAYER_COLORS`, assign the first color no other player in the game uses
  - return whether anything changed
  - it's written generally, so it also covers any color removed in the future
- `server/games/service.js` `get(id)`: run `upgradeState()` right after a game is loaded from the database. If anything changed, save the state straight away with `persist(game, [])`, so the database matches what clients see.
- Feed rows already written keep the color they were written with. They're history and aren't rewritten.
- Undo can't bring red back: undo snapshots restore entities, turn state, pending checks and the z-counter, never players.

## Part 3: Tests and Acceptance Criteria

Add to `test/players.test.js`:

- **The bank:** red isn't in `PLAYER_COLORS`, there are 10 colors, and teal is last.
- **New players:** the first player to join gets green.
- **Picking colors:** red is refused, and teal can be picked.
- **Migration:**
  - setup: write a game state straight into the database with one red player and one green player, then force a reload from the database
  - green is kept
  - the red player gets blue (`#4363d8`, the first free color)
  - the database row holds the new color too
- **Lists in sync:** read `client/js/common.js` as text, parse its `PLAYER_COLORS` array, and check it equals the server's list.

The existing color tests still pass. For example, "colors are unique, changeable, …" picks `PLAYER_COLORS[9]`, which is now teal.

Manual check:
1. Start a new game. The first player to join is green.
2. Open the You menu. The swatches run green → teal, with no red, and the current color is marked.
3. The DM's Players tab color picker shows the same 10 colors.
4. Restart the server with a game in which a player was red. That player now has a free color, both in the browser and after another restart.

## Implementation Approach

1. Update `PLAYER_COLORS` in `server/games/state.js` and `client/js/common.js`: remove red, append teal, and add the comments.
2. Add `upgradeState()` and call it in `GameService.get()`, saving when it changes something.
3. Add the tests, then run the full suite.
