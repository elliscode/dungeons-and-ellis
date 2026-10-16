import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomAt, clampPan, fitCamera, normalizeWheel, isNotchedWheel, wheelIntent, wheelZoomFactor, pinchScaleFactor, PINCH_SENSITIVITY, ZOOM_MIN, ZOOM_MAX } from '../client/js/camera.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≈ ${b}`);
// World point under a viewport point, for camera { x, y, zoom } (screen = world * zoom + pan).
const worldAt = (cam, px, py) => ({ x: (px - cam.x) / cam.zoom, y: (py - cam.y) / cam.zoom });

test('zoomAt keeps the map point under the cursor fixed', () => {
  const cam = { x: 40, y: -25, zoom: 0.8 };
  for (const [f, px, py] of [[1.15, 300, 200], [1 / 1.15, 10, 590], [2.5, 0, 0], [0.5, 777, 333]]) {
    const before = worldAt(cam, px, py);
    const next = zoomAt(cam, f, px, py);
    const after = worldAt(next, px, py);
    close(after.x, before.x, 'x');
    close(after.y, before.y, 'y');
  }
});

test('zoomAt clamps to the zoom limits, still anchored', () => {
  const big = zoomAt({ x: 0, y: 0, zoom: 3 }, 10, 100, 100);
  assert.equal(big.zoom, ZOOM_MAX);
  close(worldAt(big, 100, 100).x, 100 / 3);
  assert.equal(zoomAt({ x: 0, y: 0, zoom: 0.3 }, 0.01, 0, 0).zoom, ZOOM_MIN);
});

test('clampPan keeps at least 120px of the map on screen; fitCamera centers', () => {
  const view = [800, 600], map = [1000, 1000];
  const far = clampPan({ x: -5000, y: 5000, zoom: 1 }, ...view, ...map);
  assert.deepEqual([far.x, far.y], [120 - 1000, 600 - 120]);
  const ok = clampPan({ x: -100, y: -50, zoom: 1 }, ...view, ...map);
  assert.deepEqual([ok.x, ok.y], [-100, -50], 'inside the bounds: unchanged');
  const tiny = clampPan({ x: 9999, y: -9999, zoom: 1 }, 800, 600, 50, 50);
  assert.deepEqual([tiny.x, tiny.y], [750, 0], 'a map smaller than 120px stays fully visible');

  const fit = fitCamera(800, 600, 1000, 500);
  close(fit.zoom, (800 - 16) / 1000);
  close(fit.x, (800 - 1000 * fit.zoom) / 2);
  close(fit.y, (600 - 500 * fit.zoom) / 2);
  assert.equal(fitCamera(800, 600, 10, 10).zoom, 2.5, 'never above 2.5 on fit');
  assert.equal(fitCamera(0, 600, 10, 10), null);
});

test('normalizeWheel converts lines and pages to pixels', () => {
  assert.deepEqual(normalizeWheel({ deltaMode: 0, deltaX: 3, deltaY: -7 }), { dx: 3, dy: -7 });
  assert.deepEqual(normalizeWheel({ deltaMode: 1, deltaX: 0, deltaY: 3 }), { dx: 0, dy: 48 });
  assert.deepEqual(normalizeWheel({ deltaMode: 2, deltaX: 0, deltaY: 1 }, 700), { dx: 0, dy: 700 });
});

test('mouse wheels vs trackpads: decided by the device report, not delta size', () => {
  // Chromium/Safari mouse notches: wheelDelta in multiples of 120, whatever the pixel delta.
  assert.equal(isNotchedWheel({ deltaMode: 0, deltaY: 100, wheelDeltaY: -120, wheelDeltaX: 0 }), true);
  assert.equal(isNotchedWheel({ deltaMode: 0, deltaY: 4.000244, wheelDeltaY: -240, wheelDeltaX: 0 }), true, 'macOS-accelerated wheel');
  // Trackpads report the exact pixel delta x3.
  assert.equal(isNotchedWheel({ deltaMode: 0, deltaY: 7, wheelDeltaY: -21, wheelDeltaX: 0 }), false);
  assert.equal(isNotchedWheel({ deltaMode: 0, deltaY: 40, deltaX: 3, wheelDeltaY: -120, wheelDeltaX: -9 }), false, 'any sideways motion is a trackpad');
  // Firefox wheels use line units.
  assert.equal(isNotchedWheel({ deltaMode: 1, deltaY: 3 }), true);
  assert.equal(isNotchedWheel({ deltaMode: 0, deltaY: 12 }), false, 'no legacy fields: treat as precise');
});

test('wheelIntent: pinch via ctrlKey, wheel zooms, trackpad scroll pans, gestures stay classified', () => {
  const mem = {};
  assert.equal(wheelIntent({ ctrlKey: true, deltaY: 3, wheelDeltaY: -9, wheelDeltaX: 0 }, mem, 0), 'pinch');
  // Chromium reports wheelDelta 120 on every pinch event, however small: ctrlKey always wins.
  assert.equal(wheelIntent({ ctrlKey: true, deltaY: -0.23, wheelDeltaY: 120, wheelDeltaX: 0 }, mem, 10), 'pinch');
  assert.equal(wheelIntent({ ctrlKey: true, deltaY: 100, wheelDeltaY: -120, wheelDeltaX: 0 }, mem, 20), 'pinch', 'ctrl + mouse wheel: capped smooth zoom');
  const m2 = {};
  assert.equal(wheelIntent({ deltaY: 7, wheelDeltaY: -21, wheelDeltaX: 0 }, m2, 1000), 'pan');
  // A momentum event that happens to be a multiple of 120 doesn't flip the gesture.
  assert.equal(wheelIntent({ deltaY: 40, wheelDeltaY: -120, wheelDeltaX: 0 }, m2, 1100), 'pan');
  // After a pause, a real mouse notch zooms.
  assert.equal(wheelIntent({ deltaY: 100, wheelDeltaY: -120, wheelDeltaX: 0 }, m2, 2000), 'zoom-step');
});

test('zoom amounts: 15% per notch; pinch is smooth and bounded per event', () => {
  close(wheelZoomFactor({ deltaY: -100, wheelDeltaY: 120 }, 'zoom-step'), 1.15);
  close(wheelZoomFactor({ deltaY: 200, wheelDeltaY: -240 }, 'zoom-step'), 1.15 ** -2);
  close(wheelZoomFactor({ deltaMode: 1, deltaY: -3 }, 'zoom-step'), 1.15, 'Firefox: 3 lines = 1 notch');
  close(wheelZoomFactor({ deltaMode: 0, deltaY: -10 }, 'pinch'), Math.exp(0.1 * PINCH_SENSITIVITY));
  assert.equal(wheelZoomFactor({ deltaMode: 0, deltaY: -5000 }, 'pinch'), 1.25);
  assert.equal(wheelZoomFactor({ deltaMode: 0, deltaY: 5000 }, 'pinch'), 0.8);
  // Pinching in and out by the same amount cancels exactly (wheel pinch and Safari gestures).
  close(wheelZoomFactor({ deltaY: -30 }, 'pinch') * wheelZoomFactor({ deltaY: 30 }, 'pinch'), 1);
  close(pinchScaleFactor(1.5) * pinchScaleFactor(1 / 1.5), 1);
  assert.ok(pinchScaleFactor(2) < 2 && pinchScaleFactor(2) > 1, 'Safari pinches are damped too');
});
