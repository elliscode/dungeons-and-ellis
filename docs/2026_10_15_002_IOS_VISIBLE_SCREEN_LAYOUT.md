# One & Done — Fit the Layout to the Visible Screen on iPad / iOS

Implement this as an incremental change to the existing application. It's a CSS-only change in `client/css/app.css`; don't restructure the layout or add scripts to measure the viewport.

## Background

On iPad and iPhone, the app was taller than the visible area. The bottom of the screen sat underneath Safari's tab bar and address bar:
- the chat box
- the map's +, − and Fit buttons
- the end of the DM's sidebar

The layout should resize to whatever is actually visible: with the tab bar shown or hidden, the address bar expanded or collapsed, and after rotating the device.

**Cause:** the full-screen app shell was `.app { display: grid; height: 100vh; }`. It's used by:
- the DM page
- the player's game screen
- the Data page
- the scene editor

On iOS, `100vh` is the **large** viewport, measured as if the browser's bars were hidden. Whenever they're visible, part of the app is off-screen.

## Part 1: Choosing the unit

| Unit | Meaning on iOS | Verdict |
|---|---|---|
| `vh` / `lvh` | Largest viewport (bars hidden) | ✗ The bug: content hides under the bars |
| `svh` | Smallest viewport (all bars shown), never changes | Always fits, but leaves an empty strip when the bars collapse |
| `dvh` | The height visible right now: changes as bars appear or disappear, and on rotation | ✓ For the app shell |

**`dvh` for the app shell.**
- The shell never scrolls as a page; the map, sidebar and Game Feed scroll inside it. So Safari's bars don't slide in and out while playing.
- `dvh` therefore only changes when the bars or tabs genuinely change, or the device rotates, which is exactly when the layout should resize.
- The usual drawback of `dvh` (the layout jumping while the page scrolls) doesn't apply.

**`svh` for `min-height` on pages that scroll** (the login page). Such a page can be taller than the screen and scroll, and with `dvh` its height would jump as the bars animate during scrolling. `svh` always fills at least the visible screen with the bars showing, and never jumps.

**Fallbacks:** every rule declares the `vh` value first, then the new unit on the next line. Browsers without `dvh`/`svh` (iOS before 15.4, old desktop browsers) ignore the second line and keep the old behavior.

## Part 2: Changes (`client/css/app.css`)

| Selector | Before | After |
|---|---|---|
| `.app` (full-screen app shell) | `height: 100vh` | `height: 100vh; height: 100dvh;` |
| `.center-screen` (login page) | `min-height: 100vh` | `min-height: 100vh; min-height: 100svh;` |
| `.popup-menu` | `max-height: 70vh` | `max-height: 70vh; max-height: 70dvh;` |

- Each changed rule has a short comment explaining the unit choice.
- **Popup menus** (Items, Act, Attack, the turn counter list, etc.) are capped at 70% of the **visible** height, so a long menu fits above Safari's toolbar.

**Already fine, unchanged:**
- **The confirmation modal** is centered inside a `position: fixed; inset: 0` backdrop, which already follows the visible area.
- **The player's join and hero-pick screens** (`.flow`) are a padded column that sizes to its content and doesn't depend on the page height.
- **The waiting screen's** `margin-top: 18vh` is only spacing.

**Deliberately not changed:**
- **The viewport meta tag.** `interactive-widget=resizes-content` makes Chrome on Android shrink the layout for the on-screen keyboard, but Safari ignores it, and iOS already scrolls a focused input (the chat box) into view. It can be added later if Android keyboards become a problem.
- **Safe-area insets** (`viewport-fit=cover` plus `env(safe-area-inset-*)`). Only needed when running as an installed home-screen web app, which this isn't.

## Part 3: Docs

The README's DM notes gain an *iPad / iPhone* bullet: the layout fits the visible screen (`100dvh`, with a `100vh` fallback), so Safari's tab bar and address bar never cover the chat box or map controls, and it resizes as they change or the device rotates.

## Part 4: Tests and Acceptance Criteria

The change is CSS-only, so the existing test suite is unaffected.

### Browser check (Chromium via Playwright on a throwaway server)

**Setup:** the DM page and the player's game screen, at iPad sizes, resizing the viewport mid-session to simulate the browser bars appearing.

**Results:**

| Page | Viewport | Visible height | `.app` height | Chat box bottom | Map buttons bottom | Page height |
|---|---|---|---|---|---|---|
| Player | 820×1180 (portrait) | 1180 | 1180 | 1170 | 870 | 1180 |
| Player | 820×1060 (bars appear) | 1060 | 1060 | 1050 | 750 | 1060 |
| Player | 1180×760 (rotated, bars shown) | 760 | 760 | 750 | 750 | 760 |
| DM | 1180×820 (landscape) | 820 | 820 | 810 | 810 | 820 |
| DM | 1180×700 (bars appear) | 700 | 700 | 690 | 690 | 700 |

- The browser's parsed `.app` height rule is `100dvh`.
- **Pass criteria:**
  - `.app` height equals the visible height (`window.innerHeight`) at every size
  - the chat input and map buttons stay inside the visible area
  - the page never becomes taller than the screen

### On a real iPad / iPhone in Safari

Chromium can't recreate Safari's own bars, so check this on the device itself:
1. Open the player page and the DM page.
2. Show and hide the tab bar, expand and collapse the address bar, and rotate the device.
3. The chat box and the map's +/−/Fit buttons stay visible above Safari's toolbar. There's no gap at the bottom and no content cut off, and the layout settles to the new size each time.
4. On the login page, the content is centered on the visible screen and doesn't jump while scrolling.

## Implementation Approach

1. Change `.app` to `height: 100vh; height: 100dvh;`.
2. Change `.center-screen` to `min-height: 100vh; min-height: 100svh;`.
3. Change `.popup-menu` to `max-height: 70vh; max-height: 70dvh;`.
4. Add the comments and the README bullet.
5. Check at iPad sizes in a browser, then on a real iOS device.
