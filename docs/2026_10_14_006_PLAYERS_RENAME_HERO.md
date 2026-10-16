# One & Done — Players Can Rename Their Hero

Implement this as an incremental change to the existing application. Inspect the current code and reuse the player's existing "You" settings menu, the `str()` input helper and the per-viewer projections. Do not rebuild or refactor unrelated functionality.

## Background

Players can change their own **player name** and **color** from the "You" menu, which opens from their name chip in the top-right of the player page. The hero they play always keeps its definition's name ("Fire Mage"). Only the DM can rename a token, using the inspector's ✎ button (`entity.rename`).

This change lets a player **rename the hero they play** from that same menu.

Several places also showed the hero's name from its *definition* rather than the live token, so a renamed hero would still have appeared under its old name there. Those now show the live name.

## Part 1: Behavior

### 1. The "You" menu

| Section | Shown | Contents |
|---|---|---|
| Name | always | Player name input + Rename (unchanged) |
| **Character** | once the player has picked a hero | Hero name input (prefilled with the current name, max 40 characters) + Rename |
| Color | always | Color swatches (unchanged) |

Submitting the Character form (Rename button or Enter) renames the hero and closes the menu. Errors show in the usual bottom toast.

### 2. Rules

- A player can only rename **their own** hero. There's no way to name another hero.
- Leading and trailing spaces are trimmed. A blank name is refused ("Character name is required").
- The outcome-badge markers (``, ``) are stripped by `str()`, as for every other typed name. A pasted name can't fake a HIT, MISS or CRIT badge in the Game Feed; typing the word "HIT" just shows as plain text.
- Names longer than 40 characters are cut to 40, the same as `entity.rename`. Player names are also cut, at 24.
- Renaming to the current name does nothing and logs nothing.
- Not undoable, like changing the player name.
- Game Feed: "Ana's Tabasco Habanero is now known as Sir Sparks".

### 3. Where the new name shows

| Place | Before | After |
|---|---|---|
| Token label (board) | live name | live name (unchanged) |
| Party list hover card (player page) | definition name | **live name** |
| Waiting screen, "You are playing …" | definition name | **live name** |
| DM Players tab, "<hero> (<role>)" | definition name | **live name** (role still from the definition) |
| DM Release confirmation | definition name | **live name** |

Renames the DM makes through the inspector use the same field, so they show in all these places too.

### 4. Releasing the hero

The DM's **Release** deletes the hero's token, so the rename goes with it. If the player picks a hero again, it starts with the definition's name.

## Part 2: Implementation

### 1. Server

`server/games/commands.js`: add a new command next to `player.setName`:

```js
def('player.renameCharacter', { who: 'player' }, (ctx) => { … });
```

1. Look up the player's hero (`ctx.state.entities[ctx.player.entityId]`). Fail "Pick a hero first" if there isn't one.
2. Read the name with `str(ctx.cmd.name, 40, 'Character name')`.
3. If it's unchanged, return without logging.
4. Otherwise set `e.name` and log a `character` feed row: "`<player>'s <old> is now known as <new>`".

`server/games/project.js`: `publicPlayer(p, presence, state)` adds `heroName: state.entities[p.entityId]?.name ?? null`. Both callers, `projectForDm` and `projectForPlayer` (for `me` and for `players`), pass `state` in.
- This is the same name everyone already sees on the token, so it reveals nothing new.

### 2. Client

`client/js/play.js`:
- In `settingsMenu()`, when `state.me.entityId` is set, build a Character form:
  - an input with `maxLength: 40`, prefilled with `state.me.heroName`
  - a Rename button
  - submit sends `{ type: 'player.renameCharacter', name }` through `send()` and closes the menu on success
  - the menu sections are Name, Character, Color
- In `waitingScreen()` and the party roster card, show `heroName`, falling back to the definition's name.

`client/js/dm.js`: in the Players tab entry and the Release confirmation, show `p.heroName`, falling back to the definition's name.
- The Players tab already redraws whenever `state.players` changes, and `heroName` is part of it, so renames appear immediately.

### 3. Docs

The README's Players notes mention that the **You** menu also renames your hero, where the new name shows, and that releasing the hero resets it.

## Part 3: Tests and Acceptance Criteria

Add to `test/players.test.js`:

- **Before picking a hero:** `player.renameCharacter` is refused with "Pick a hero first".
- **Renaming:** after picking a hero, renaming to "  Tabasco Habanero " stores "Tabasco Habanero" and leaves the other player's hero alone. The feed says "Ana's Fire Mage is now known as Tabasco Habanero".
- **Projections:** the new name appears as `heroName` in the DM projection, in another player's `players` list, and in the renaming player's own `me`.
- **Same name:** renaming to the current name adds no feed row.
- **Bad names:** a blank name is refused. A 60-character name is cut to 40.
- **DM:** can't send `player.renameCharacter` ("Not allowed").
- **DM rename and Release:** a DM rename through `entity.rename` shows up in `heroName`. After Release, `heroName` is null, and picking the hero again gives the definition's name.

All existing tests still pass.

Manual check, as a player with a hero:
1. Open the **You** menu from the name chip in the top-right. It shows Name, Character (prefilled with the hero's name) and Color.
2. Rename the hero to "Sir Sparks". The token label changes, and the feed shows "… is now known as Sir Sparks".
3. In the DM view, the Players tab shows "Sir Sparks (DPS)".
4. Another player's party list card shows "Sir Sparks".

## Implementation Approach

1. Add the `player.renameCharacter` command.
2. Add `heroName` to `publicPlayer()` and pass `state` from both projections.
3. Add the Character form to the player's "You" menu.
4. Use `heroName` in the party card, the waiting screen and the DM Players tab.
5. Add the tests and the README line, then run the full suite.
