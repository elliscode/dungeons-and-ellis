# One & Done — Roll20-Style Map Navigation (Trackpad, Mouse, Touch)

Implement this as an incremental change to the existing application. Inspect the current board (`client/js/board.js`) before changing it, and keep the existing coordinate maths, tokens, targeting, pings and the +, − and Fit buttons. Use the browser's native events; don't add a dependency.

## Background

Before this change, the map sat in a native scroll container (`overflow: auto`). A sizer element was set to the scaled map size, and the stage only had `transform: scale(zoom)`.
- Two-finger trackpad scrolling panned, as native scrolling.
- The mouse wheel only scrolled vertically.
- Zoom happened only on Ctrl/Cmd+wheel, in fixed 10% steps, toward the map's top-left corner rather than the cursor.
- There was no drag-to-pan.

This change makes navigation feel like Roll20 on a MacBook trackpad, a regular mouse and touch screens. It applies to the DM page, the player page and the scene editor, which all use the same `Board`.

## Part 1: Behavior

| Input | Result |
|---|---|
| Trackpad two-finger scroll | Pans horizontally and vertically, momentum included |
| Trackpad pinch | Smooth zoom toward the gesture center |
| Mouse wheel | Zooms toward the cursor, 15% per notch |
| Shift + mouse wheel | Pans sideways |
| Ctrl/Cmd + mouse wheel | Zooms toward the cursor, at most 25% per notch |
| Right-drag or middle-drag | Pans, with a grabbing cursor and no context menu |
| Touch: one finger on the empty map | Pans once it moves 5px |
| Touch: one finger on a token | Drags the token, as before |
| Touch: two fingers | Pinch-zooms around the midpoint and pans with it |
| **+** / **−** | Zoom ×1.2 / ÷1.2 around the viewport center |
| **Fit** | The whole map in view (max 2.5×), centered |

- **Zoom range:** 0.2× to 4×, as before. Fit never goes above 2.5×.
- **Zooming toward a point:** the map point under the cursor or fingers stays exactly where it is on screen.
- **Panning limits:** you can pan past the map's edges, but at least 120px of the map, or the whole map if it's smaller, always stays on screen.
- **Auto-fit:** a new scene fits automatically. The map refits when the window resizes until the user pans or zooms by hand; after that the view stays put until **Fit** is pressed.
- **Page scrolling:** gestures over the map never scroll or zoom the page. Everywhere else the browser behaves normally.
- **What still lines up at every zoom and pan:**
  - grid alignment, token positions and clicking cells
  - targeting highlights, movement and token drag and drop
  - pings, floating combat numbers, popup menus anchored to tokens, and hit testing
- **Gestures don't clash:**
  - right- and middle-drag never start a ping or a token drag, which use the left button only
  - a touch pan doesn't count as a tap when the finger lifts
  - a ping's press-and-hold is cancelled by moving 5px

### Pinch sensitivity

Trackpad pinches are damped by `PINCH_SENSITIVITY = 0.35` (1 means the raw gesture). For example, a pinch that would zoom ×1.6 zooms about ×1.18.
- The same damping applies to Chromium/Firefox pinches and to Safari's gesture events.
- Zoom is exponential in the pinch, so pinching in and out by the same amount cancels exactly.
- Touch-screen pinches aren't damped: the map follows the fingers 1:1.
- Mouse-wheel zoom isn't affected by this setting.

## Part 2: Telling the input apart

Wheel events come from both mice and trackpads, and the spec gives them opposite meanings (zoom vs pan). They're classified by what the browser reports about the device, never by how big the movement is.

| Classification | Signal | Action |
|---|---|---|
| **Pinch** | `ctrlKey` (or `metaKey`) on the wheel event: Chromium's and Firefox's trackpad-pinch signal, also set by Ctrl+wheel on a mouse | Smooth zoom from `deltaY` |
| **Mouse notch** | `deltaMode` 1 or 2 (Firefox line/page units), **or** the legacy `wheelDeltaY` a non-zero multiple of 120 with `wheelDeltaX` 0 (Chromium/Safari report whole notches for non-precise wheels and the exact pixel delta ×3 for precise devices) | Step zoom, 15% per notch |
| **Trackpad / Magic Mouse scroll** | anything else | Pan by the pixel deltas |

- **`ctrlKey` always means smooth pinch zoom.** Chromium reports `wheelDeltaY: 120` on **every** pinch event, however small the `deltaY`, so the notch test can't be applied to pinches. Treating them as notches made a ×1.6 pinch jump to ×5.4.
- **Gestures keep their classification.** A wheel gesture keeps its first classification while its events keep arriving less than 200ms apart, so one momentum event that happens to land on a multiple of 120 can't turn a trackpad pan into a zoom.
- **Line and page units** are converted to pixels: lines ×16, pages × the viewport height.
- **Zoom amounts:**
  - mouse notch: `1.15 ^ notches`, where notches is `wheelDeltaY / 120`, or 3 lines per notch in Firefox
  - pinch: `exp(-deltaY × 0.01 × PINCH_SENSITIVITY)`, with each event clamped to ×0.8–×1.25
- **Safari** sends trackpad pinches as `gesturestart` / `gesturechange` / `gestureend` events with a cumulative `scale`. Each change zooms by `(scale / previous scale) ^ PINCH_SENSITIVITY` around the gesture point.

## Part 3: Implementation

### 1. One camera transform

- The sizer element is removed, and the stage sits directly in the viewport.
- The viewport is `overflow: hidden; touch-action: none; overscroll-behavior: contain`.
- The stage gets one transform for every map layer (background, grid, highlights, tokens, HP bars, effects and pings): `translate(x, y) scale(zoom)` with origin 0,0. On screen, a point is at `world × zoom + pan`.
- The camera is `this.cam = { x, y, zoom }`. `this.zoom` is now a getter, so existing callers keep working.
- `applyCamera()` keeps the pan within its limits and writes the transform straight away. Browsers already batch style writes until the next paint, so clicks never see an out-of-date transform.
- Every existing screen↔map conversion (`pointAt`, `cellAt`, `screenPoint`, token drag/drop) reads `stage.getBoundingClientRect()` and `this.zoom`, which already include the translate, so they need no changes.

### 2. `client/js/camera.js` (new, pure, no DOM)

- `zoomAt(cam, factor, px, py)`: zoom keeping the point under (px, py) fixed: `pan' = p − (p − pan) × z'/z`, clamped to 0.2–4.
- `clampPan(cam, viewW, viewH, mapW, mapH)`: the 120px-visible limit.
- `fitCamera(viewW, viewH, mapW, mapH)`: fits with an 8px margin, max 2.5×, centered. Returns `null` for an empty view or map.
- `normalizeWheel(e, pageHeight)`: lines/pages → pixels.
- `isNotchedWheel(e)`, `wheelIntent(e, memory, now)` and `wheelZoomFactor(e, intent, pageHeight)`: the classification and zoom amounts from Part 2.
- `pinchScaleFactor(ratio)` and `PINCH_SENSITIVITY`: the pinch damping.

### 3. `client/js/board.js`: `bindNavigation()`

- **`wheel`** (`passive: false`, on the viewport only, and only once a scene is loaded): `preventDefault()`, classify, then pan or `zoomBy()` around the cursor.
- **Safari pinch:** `gesturestart` / `gesturechange` / `gestureend` call `preventDefault()` and zoom with the damping.
- **`pointerdown`, mouse:**
  - button 2 or 1 starts a pan with pointer capture, and adds the `.panning` class (grabbing cursor)
  - `pointermove` pans by the movement
  - `pointerup` / `pointercancel` ends it
- **`pointerdown`, touch:**
  - active touches are tracked
  - one finger pans after 5px; touches on tokens never reach the viewport, because token handlers stop them
  - two fingers switch to pinch: zoom by the change in finger distance around the midpoint, and pan with the midpoint
  - lifting after a pan sets `suppressClick`, so the lift doesn't count as a tap
- **`contextmenu`:** prevented on the whole viewport. This was previously only on the stage when pings were on; the scene editor gets it now too.
- **`zoomBy(factor, px, py)` and `panBy(dx, dy)`:** clear `autoFit` and apply the camera. The +/− buttons zoom around the viewport center. **Fit** sets `autoFit` and calls `fit()`.
- **The ResizeObserver** refits while `autoFit` is on, and otherwise just re-applies the camera so the pan limits follow the new size.

### 4. `client/css/app.css`

- `.board-viewport { overflow: hidden; touch-action: none; overscroll-behavior: contain; }`
- `.board-viewport.panning { cursor: grabbing; }`
- `.board-stage { will-change: transform; }`
- `.board-sizer` is removed.

### 5. Docs

The README's DM Board notes gain a *Map navigation* bullet covering trackpad, mouse and touch controls, the buttons, and the fact that gestures over the map never scroll or zoom the page.

## Part 4: Tests and Acceptance Criteria

### Unit tests (`test/camera.test.js`, importing the pure `client/js/camera.js`)

- **`zoomAt` anchoring:** for several factors and points, the map point under the cursor is the same before and after.
- **`zoomAt` limits:** it clamps to 0.2–4 and stays anchored when clamped.
- **`clampPan`:**
  - a far-off pan is pulled back to leave 120px visible
  - a pan inside the limits is unchanged
  - a map smaller than 120px stays fully visible
- **`fitCamera`:** the expected zoom (margin, 2.5× cap), centered, and `null` for an empty view.
- **`normalizeWheel`:** pixels, lines (×16) and pages (× height).
- **`isNotchedWheel`:**
  - `wheelDeltaY` ±120/±240 with no X → notch, including macOS-accelerated deltas like `deltaY: 4.000244`
  - exact-pixel trackpad deltas → not a notch
  - any `wheelDeltaX` → not a notch
  - Firefox `deltaMode: 1` → notch
  - no legacy fields → not a notch
- **`wheelIntent`:**
  - `ctrlKey` → pinch, including Chromium's `deltaY: -0.23, wheelDeltaY: 120`, and Ctrl + a mouse notch
  - a trackpad stream stays a pan, even when a momentum event is a multiple of 120
  - after a pause, a mouse notch zooms
- **Zoom amounts:**
  - a notch is ×1.15, two notches the other way are ×1.15⁻², and 3 Firefox lines are ×1.15
  - pinch is `exp(0.1 × PINCH_SENSITIVITY)` for `deltaY −10`, clamped to ×1.25 / ×0.8
  - in and out by the same amount multiply to 1, for both wheel pinch and `pinchScaleFactor`
  - Safari pinches are damped (×2 gives a factor between 1 and 2)

### Browser checks (Chrome via Playwright on a throwaway server; a Giant Rat on a 16×12 map with a background image)

- **Mouse wheel:** a notch up zooms ×1.15 and a notch down zooms back, with the map point under the cursor unchanged.
- **Ctrl+wheel:** zooms toward the cursor.
- **A real synthesized ×1.6 trackpad pinch** (CDP `Input.synthesizePinchGesture`) zooms about ×1.18, and pinching back in returns to a net ×1.000. The point under the gesture stays put.
- **Trackpad-style scrolls pan exactly:** sideways deltas, and a precise vertical scroll, move the map by their deltas without zooming.
- **Right-drag** pans by exactly the mouse movement, and no context menu appears.
- **Zoomed in and panned:**
  - clicking the token opens its inspector
  - dragging it one cell diagonally moves it from (5,4) to (6,5)
  - a ping lands within 1px of the press point
- **+ / − / Fit:** + zooms ×1.2, − zooms ÷1.2, and Fit restores the fitted view.
- **Touch** (real touch events): a one-finger drag pans by exactly the finger's travel, and a two-finger pinch from 100px to 260px zooms ×2.6 around the midpoint.
- **The page itself:** never scrolls or zooms (`scrollX`/`scrollY` stay 0, `visualViewport.scale` stays 1).

All existing tests still pass.

### On real hardware

- **MacBook trackpad,** in Chrome and Safari:
  - two-finger scroll pans
  - pinch zooms gently toward the fingers, and pinching back in undoes it
- **Mouse:**
  - each wheel notch zooms toward the cursor
  - right-drag pans
  - no context menu
- **Magic Mouse:** it pans, because macOS reports it as a precise device like a trackpad.
- **The same controls work in the scene editor.**
- **Mixed-up mouse and trackpad:** if a wheel ever pans when it should zoom, or the reverse, look first at `isNotchedWheel()`. Tune pinch feel with `PINCH_SENSITIVITY`.

## Implementation Approach

1. Add `client/js/camera.js`, with its unit tests.
2. Replace the scroll container and sizer with the camera transform in `board.js` (`cam`, `zoom` getter, `applyCamera`, `fit`, `zoomBy`, `panBy`).
3. Add `bindNavigation()`: wheel classification, Safari gestures, right/middle-drag, touch pan and pinch, and context-menu suppression. Rewire +, − and Fit.
4. Update the viewport and stage CSS, and remove `.board-sizer`.
5. Check zoom anchoring, panning, hit testing, pings and touch in a browser.
6. Add the README notes.
