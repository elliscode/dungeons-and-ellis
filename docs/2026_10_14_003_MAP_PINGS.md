# One & Done — Map Pings

Implement this as an incremental change to the existing application. Inspect the current code and reuse the existing board, socket wiring, player colors and toast notifications. Do not rebuild or refactor unrelated functionality.

## Background

Players and the DM have no way to point at a spot on the map ("over here", "watch that door"). This change lets anyone **press and hold** on the map to drop a ping that everyone in the game sees, in the pinger's color.

## Part 1: Behavior

### 1. Creating a ping

- Press and hold the left mouse button (or a finger) on the map for **500 ms** without moving. This works on empty squares, on tokens, and anywhere on the map's background image, including parts outside the grid.
- Moving more than 5 px (the board's existing drag threshold) before the hold completes cancels the ping. Letting go early, or the browser cancelling the pointer, also cancels it. Dragging tokens, normal clicks and touch-scrolling must never ping.
- `pointerleave` must **not** cancel the hold. Pressing a token makes it capture the pointer, and the browser then fires a `pointerleave` on the token's inner element even though the pointer hasn't moved.
- The click that follows the release is swallowed. A ping must never also:
  - select a token
  - open the donut menu or the inspector
  - place a creature
  - pick a target during ability targeting
- A touch long-press must not open the browser's context menu.
- Pings work in every board mode, for both players and the DM.

### 2. Who sees it

- Everyone in the game who has joined (all players and the DM) sees the ping.
- Players still on the join screen don't.
- A ping for a scene other than the one the viewer is showing is ignored.

### 3. Color

| Pinger | Color |
|---|---|
| Player | Their assigned player color (one of the 10 `PLAYER_COLORS`) |
| DM | `DM_COLOR` (gold, `#d4af37`) |

### 4. Rate limit

- Each **player** may ping at most **10 times per minute**. This is tracked on the server; the client is never trusted for it.
- The 10th ping within a minute still goes through, then mutes that player's pings until **one minute after that 10th ping**.
- While muted, each attempt is refused with a bottom-of-screen error toast, in the same style as "X is frightened of Y and can't move closer":
  > Ping limit reached (10 per minute). Try again in 42s.
- Refused attempts don't extend the mute.
- Pings spread over more than a minute never hit the limit; only pings within the last 60 seconds count.
- Limits are per player. One player being muted doesn't affect anyone else.
- The **DM is never rate-limited**.
- Limits are kept in memory only, so a server restart resets them.

### 5. What a ping is not

A ping is a throwaway visual. It must not:
- change game state
- be saved to the database
- create an undo entry
- appear in the Game Feed
- trigger a full state broadcast

## Part 2: Visual

At the ping point, draw in the pinger's color:

- **A small solid dot**, about 20% of a grid square, that holds for a moment and fades out.
- **Three rings (the "blips")**. Each ring:
  - starts small (scale 0.2, fully opaque) at the ping point
  - grows to about 3 grid squares across while fading to transparent over about 1.3 s
  - starts 0.35 s after the previous one (delays of 0, 0.35 s and 0.7 s)
- A light glow in the same color helps the rings stand out on dark maps.

Further details:

- Ring and dot sizes scale with the scene's grid cell size, and the ping sits inside the zoomed board, so it looks the same at any zoom.
- The ping is drawn above tokens and HP bars, and ignores pointer events.
- The element is removed after about 2.2 s.

## Part 3: Implementation

### 1. Server

`server/games/service.js` gets a `ping(gameId, actor, { x, y })` method, next to `chat()`:

- `x` and `y` are in grid-cell units and may be fractional, so the ping lands exactly where the pointer was.
- Reject:
  - an unknown game
  - no active scene ("No active scene to ping")
  - non-numeric coordinates, or anything more than 1000 cells from the grid's origin ("Bad ping")
  - a player who isn't in the game
- Don't clamp the position to the grid. Map backgrounds are often larger than the grid, so pings outside it (including negative positions) are valid.
- Apply the player rate limit using `this.now()`, so tests can control the clock.
- On success, emit `'ping'` with `{ sceneId, x, y, color }` and return `{ ok: true }`.

`server/sockets.js`:

- Relay the service's `'ping'` event to every socket in the game, as the `'ping'` socket event. Skip player sockets that haven't joined.
- Both namespaces accept a `'ping'` event with an ack. Players must have joined first ("Join the game first").
- Use a dedicated socket event rather than a game command, so pings never touch state, saving or undo.

### 2. Client

`client/js/board.js`:
- Add a `pointAt(clientX, clientY, { onGrid })` helper that returns the fractional grid position. `cellAt()` uses it with `onGrid: true`, so it returns null off the grid. Pings use `onGrid: false`, which returns null only off the map image itself.
- Add an `onPing({ x, y })` board option. When set, install the hold detection on the stage using **capture-phase** listeners, because token `pointerdown` handlers stop propagation.
- After a ping fires, set the existing `suppressClick` flag and a new `pinged` flag, and have the token release handler check `pinged`. Reset both on every new press, so a ping can never swallow a later click.
- Add `showPing({ sceneId, x, y, color })`, which draws into the board's effects layer (see the layer naming note below).

`client/js/play.js` and `client/js/dm.js`:
- Pass `onPing` to the board. It emits `'ping'` with an 8 s timeout and shows any error as an error toast, the same pattern as `sendCmd()`.
- Add `socket.on('ping', (p) => board.showPing(p))` next to the existing `fx` handler.

`client/css/app.css`: add the `.ping`, `.ping-dot` and `.ping-ring` styles and the `ping-grow` / `ping-dot` keyframes next to the floating combat text styles. Pass the color and cell size in as the `--ping-color` and `--cell` variables.

The board's effects layer must be named `.layer.fx-layer`, not `.layer.fx`. The floating combat text rule `.fx` would otherwise match the layer itself, and its `rise` animation, which ends at opacity 0, hides the whole layer about 1.6 s after the page loads. That hides pings and floating combat numbers alike.

### 3. Docs

Add a line to the README's board notes about press-and-hold pings, the 10-per-minute player limit, and the DM's unlimited gold pings.

## Part 4: Tests and Acceptance Criteria

Add `test/ping.test.js` (service level):

- A player's ping is broadcast with the active scene, the exact position and that player's color. The DM's ping uses `DM_COLOR`.
- A player's first 10 pings succeed. The 11th is refused with "Ping limit reached (10 per minute). Try again in Ns." and isn't broadcast.
- 59 s after the 10th ping they're still muted, and that refused attempt doesn't extend the mute. At 60 s they can ping again.
- 30 pings spaced 7 s apart all succeed.
- After one player hits the limit, a second player can still ping, and the DM can ping 30 times in a row.
- Refused: a non-numeric position, NaN, a missing position, a position 1,000,000 cells away, a player not in the game, and no active scene. A position off the grid, such as (14.5, −2) on a 10×8 grid, is accepted unchanged.
- A ping leaves game state, the Game Feed and undo unchanged, and emits no `'change'` event.

All existing tests still pass.

Manual check, with the DM view and two player tabs open:
- Holding on an empty square shows the rings in that player's color in all three tabs, at the same spot.
- Holding on a token does the same, and so does holding on part of the background image outside the grid.
- A quick click still selects or moves as before, and dragging a token never pings.
- Releasing after a ping doesn't select a token, open a menu, or pick a target.
- A player's 11th ping within a minute shows the bottom toast. The DM can keep pinging.
- Pings look the same zoomed in and out.

## Implementation Approach

1. Add `service.ping()` with validation (no clamping to the grid) and the per-player rate limit.
2. Relay pings in `server/sockets.js`, and accept them on both namespaces.
3. Add `pointAt()`, hold detection with click suppression, and `showPing()` to the board.
4. Wire `onPing` and the `'ping'` listener into the player and DM views.
5. Add the CSS animation, and rename the effects layer to `.layer.fx-layer`.
6. Add the tests and the README line, then run the full suite.
