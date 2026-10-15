# One & Done — Players Can Leave Their Hero (DM Option)

Implement this as an incremental change to the existing application. Inspect the current code and reuse the DM's existing Release logic (`releaseCharacter()`), the player's "You" menu, the DM's Players tab and the game-load upgrade (`upgradeState()`). Do not rebuild or refactor unrelated functionality.

## Background

Only the DM could free a player's hero, using **Release** in the Players tab or the inspector's "Reset player / release character". A player who wanted a different hero had to ask the DM.

This change lets players leave their hero themselves from their settings gear. They confirm first, then go back to the hero picker. Because swapping heroes affects the table (and can be used to escape a bad fight), it's a **per-game option the DM controls**. It's off by default, and the DM can turn it on or off mid-game.

## Part 1: The DM option

### 1. Behavior

- The Players tab on the DM page has a checkbox at the top: **☐ Let players leave their hero**.
  - Its tooltip: "Players can pick a different hero from their ⚙ menu (they confirm first). You can change this any time."
  - The checkbox sits inline with its label.
- It's **off by default** in every new game, and games saved before this change load with it off.
- The DM can change it at any time, including mid-combat.
- Each change adds a feed line that players can see:
  - "DM allowed players to leave their heroes"
  - "DM stopped players leaving their heroes"
- Setting it to the value it already has does nothing and logs nothing.

### 2. Implementation

`server/games/state.js`:
- `createGameState()` adds `options: { playersCanLeave: false }`, for per-game switches the DM can flip mid-game.
- `upgradeState()`, which already runs when a saved game loads, gives games without `options.playersCanLeave` the default `false`, and saves the change.

`server/games/commands.js`, a new command `game.setOption` (`who: 'dm'`):
- Takes `{ option, value }`. `option` must be one of the known game options (`GAME_OPTIONS`, currently just `playersCanLeave`); anything else is refused with "Unknown game option".
- `value` must be `true` or `false`; anything else is refused with "Option value must be on or off".
- If the value is unchanged, return. Otherwise set it and log the matching on/off line (`game` type, visible to players).

`server/games/project.js`: `projectForPlayer()` includes `options: { playersCanLeave }`. The DM's projection already includes all of `state`.

`client/js/dm.js`, `renderPlayers()`: the checkbox row comes first. It sends `game.setOption` when changed. The tab's memo key becomes `[state.players, state.options]`, so the checkbox follows changes.

`client/css/app.css`: `.option-row` lays out left to right. This overrides the app-wide column layout of `label`, so the checkbox stays inline. The checkbox keeps its natural size (no text-input width or padding) and uses the gold accent color.

## Part 2: Leaving a hero

### 1. Behavior

- When the option is on and the player has a hero, the **You** menu (their name chip, top-right) shows a **Leave hero…** button under the Character section. When the option is off, the button isn't shown.
- Clicking it closes the menu and opens a confirmation modal:

  > **Leave Tabasco Habanero?**
  > Your hero leaves the game and you'll pick a hero again. Its HP, items and effects are lost; picking it again starts fresh. Your name and color stay.

  During combat, the body adds: "Your token leaves the fight right away."
- **Cancel**, **Esc** or a click outside the card closes it and keeps the hero.
- **Leave hero** (red) or **Enter** confirms.
- When confirmed:
  - the hero's token leaves the board
  - the player is back on the role/hero picker
  - the feed says "Ana left Tabasco Habanero", using the hero's current name, including a player's rename
- Allowed **any time** while the option is on: in or out of combat, and while the hero is downed or dead.
- What's kept: the seat, the player's name and their color.
- What's lost: the hero's token, with its HP, items, effects and rename. The hero becomes free for any player to pick, and picking it again starts fresh from its definition.
- The DM's undo history is cleared, the same as the DM's Release, because undo snapshots don't include players.
- If the DM turns the option off while a player has the modal open, confirming is refused with the usual bottom toast.

### 2. Implementation

`server/games/commands.js`, a new command `player.leaveCharacter` (`who: 'player'`, `clearsUndo: true`):
1. Refuse "The DM hasn't allowed leaving heroes in this game" if the option is off.
2. Refuse "You don't have a hero" if the player has no hero.
3. Note the hero's live name (falling back to the definition's name).
4. Call the existing `releaseCharacter(ctx, player)`, the same code as `dm.resetPlayer`. It deletes the token and its turn state and clears `characterId` and `entityId`.
5. Log a `character` feed row: "`<player>` left `<hero>`".

`client/js/common.js`: a new reusable `confirmModal({ title, body, confirm = 'OK', danger = false })` that returns a Promise<boolean>.
- It renders a dim backdrop and a centered card (title, body, **Cancel** and the confirm button). The confirm button is red when `danger` is set, and gets focus.
- Esc, Cancel and a backdrop click resolve `false`; the confirm button and Enter resolve `true`. It uses a capture-phase key listener, so the page's own Esc handling doesn't also fire.
- The element is removed on close.

`client/css/app.css`: `.modal-backdrop`, `.modal`, `.modal-title`, `.modal-body` and `.modal-actions`. They're styled like the popup menus (`var(--bg2)`, gold border) and sit above everything else, toasts included.

`client/js/play.js`, `settingsMenu()`:
- Build the **Leave hero…** button (`button.small.danger`) only when the player has a hero and `state.options.playersCanLeave` is true.
- On confirm, cancel any active board mode (targeting, move), then send `{ type: 'player.leaveCharacter' }`.
- The existing render logic shows the role/hero picker once `characterId` is empty.

## Part 3: Docs

README:
- The DM's Players tab notes mention the **Let players leave their hero** switch (per game, off by default, changeable mid-game).
- The players' notes describe **Leave hero…**: the confirmation, picking again, any time, and what's kept and what's lost.

## Part 4: Tests and Acceptance Criteria

Add to `test/players.test.js`:

- **Defaults and the switch:**
  - A new game has `playersCanLeave: false`, and leaving is refused with the "hasn't allowed" message (the hero stays).
  - Players can't send `game.setOption` ("Not allowed").
  - An unknown option and a non-boolean value are refused.
  - Turning it on shows "DM allowed players to leave their heroes" in the **player** feed, and `projectForPlayer().options.playersCanLeave` is true.
  - Turning it off logs the "stopped" line and refuses leaving again.
  - A saved game with no `options` reloads (from the database) with `playersCanLeave: false`.
- **Leaving:**
  - With the option on, leaving without a hero is refused ("You don't have a hero").
  - After picking Fire Mage and renaming it to Sparky, leaving deletes the token and clears `characterId`/`entityId`, keeps the name and color, and logs "Ana left Sparky".
  - Another player can then pick Fire Mage, and the leaver can pick Cleric, which starts with its definition's name.
- **Mid-combat:** with combat started and the hero downed, leaving still works. The token and its turn state are removed, and `undoInfo()` is null.

All existing tests still pass.

Manual check, with the DM view and one player:
1. The player's You menu has no **Leave hero…** button.
2. The DM ticks **Let players leave their hero**. The player's feed shows the line, and the button appears without a reload.
3. **Leave hero…** opens the modal. **Esc** closes it with the hero kept, and so does **Cancel**.
4. **Leave hero** returns the player to "Choose a role". The DM's board loses the token, and the feed shows "Ana left …".
5. The player picks a different hero.
6. The DM unticks the box, and the button disappears.

## Implementation Approach

1. Add `options` to game state and `upgradeState()`, plus the `game.setOption` command, with the option sent to players.
2. Add `player.leaveCharacter`, reusing `releaseCharacter()`.
3. Add `confirmModal()` and its styles.
4. Add the DM's checkbox (inline, with the memo key updated) and the player's **Leave hero…** button.
5. Add the tests and the README notes, then run the full suite.
