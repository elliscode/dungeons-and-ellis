// Map camera math for the Board: one transform, translate(x, y) scale(zoom), maps stage (world)
// pixels to viewport pixels: screen = world * zoom + pan. Pure functions (no DOM) so they can be
// unit-tested in Node.

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;
const FIT_MAX = 2.5;
const FIT_MARGIN = 8;
const KEEP_VISIBLE = 120; // px of map that always stays on screen while panning
const MOUSE_STEP = 1.15; // zoom per mouse-wheel notch
// Trackpad pinch sensitivity (1 = the raw gesture). Applied the same way to Chromium/Firefox
// ctrl+wheel pinches and Safari gesture events. Zoom is exponential in the pinch, so pinching in
// and out by the same amount always cancels out exactly.
export const PINCH_SENSITIVITY = 0.35;
const PINCH_SPEED = 0.01 * PINCH_SENSITIVITY; // zoom per pixel of pinch delta (exponential)
const STICKY_MS = 200; // a wheel gesture keeps its first classification while events keep coming

export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// Zoom by `factor` keeping the world point under viewport point (px, py) fixed.
export function zoomAt(cam, factor, px, py) {
  const zoom = clampZoom(cam.zoom * factor);
  const k = zoom / cam.zoom;
  return { zoom, x: px - (px - cam.x) * k, y: py - (py - cam.y) * k };
}

// Pan freely past the edges, but always keep some of the map on screen.
export function clampPan(cam, viewW, viewH, mapW, mapH) {
  const clampAxis = (pan, view, map) => {
    const size = map * cam.zoom;
    const keep = Math.min(KEEP_VISIBLE, size);
    return Math.min(view - keep, Math.max(keep - size, pan));
  };
  return { ...cam, x: clampAxis(cam.x, viewW, mapW), y: clampAxis(cam.y, viewH, mapH) };
}

// Whole map in view (never above FIT_MAX), centered.
export function fitCamera(viewW, viewH, mapW, mapH) {
  const w = viewW - FIT_MARGIN * 2, h = viewH - FIT_MARGIN * 2;
  if (w <= 0 || h <= 0 || !mapW || !mapH) return null;
  const zoom = Math.max(ZOOM_MIN, Math.min(FIT_MAX, w / mapW, h / mapH));
  return { zoom, x: (viewW - mapW * zoom) / 2, y: (viewH - mapH * zoom) / 2 };
}

// Wheel deltas in pixels (Firefox may report lines or pages).
export function normalizeWheel(e, pageHeight = 800) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  return { dx: (e.deltaX ?? 0) * unit, dy: (e.deltaY ?? 0) * unit };
}

// A notched mouse wheel (not a precise device like a trackpad or Magic Mouse)? Decided by what the
// browser reports about the device, never by how big the delta is: Firefox uses line units for
// wheels, and Chromium/Safari report the legacy wheelDelta in whole notches (multiples of 120) for
// non-precise wheels but the exact pixel delta x3 for precise devices.
export function isNotchedWheel(e) {
  if (e.deltaMode === 1 || e.deltaMode === 2) return true;
  const wy = e.wheelDeltaY, wx = e.wheelDeltaX;
  if (typeof wy !== 'number' || typeof wx !== 'number') return false;
  return wx === 0 && wy !== 0 && wy % 120 === 0;
}

// How to treat a wheel event: 'pinch' (trackpad pinch, or ctrl/cmd+wheel: Chromium and Firefox
// set ctrlKey for pinches), 'zoom-step' (mouse wheel), or 'pan' (trackpad / Magic Mouse scrolling).
// ctrlKey always means a smooth zoom from deltaY: Chromium reports wheelDelta 120 on every pinch
// event however small, so the notch test can't be used for it. `memory` keeps a gesture's
// classification while its events keep arriving, so one momentum event can't flip a pan into a zoom.
export function wheelIntent(e, memory = {}, now = Date.now()) {
  if (e.ctrlKey || e.metaKey) {
    memory.intent = null;
    return 'pinch';
  }
  const fresh = isNotchedWheel(e) ? 'zoom-step' : 'pan';
  const sticky = memory.intent && now - memory.at < STICKY_MS ? memory.intent : null;
  memory.intent = sticky ?? fresh;
  memory.at = now;
  return memory.intent;
}

// Zoom factor for a zooming wheel event. Pinch: exponential in the pixel delta, capped per event
// (so ctrl + a mouse wheel notch is a 25% step).
export function wheelZoomFactor(e, intent, pageHeight) {
  if (intent === 'zoom-step') {
    const notches = e.deltaMode === 1 || e.deltaMode === 2 || typeof e.wheelDeltaY !== 'number'
      ? -Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaMode === 1 ? e.deltaY / 3 : 1)))
      : e.wheelDeltaY / 120;
    return MOUSE_STEP ** notches;
  }
  const { dy } = normalizeWheel(e, pageHeight);
  return Math.min(1.25, Math.max(0.8, Math.exp(-dy * PINCH_SPEED)));
}

// Safari pinch: the gesture's scale change since the last event, damped like the wheel pinch.
export const pinchScaleFactor = (ratio) => ratio ** PINCH_SENSITIVITY;
