import { entitiesInScene } from './state.js';

export function defaultSpawn(scene) {
  return scene.spawn ?? { x: 0, y: scene.grid.rows - 1 };
}

export function inBounds(scene, x, y, size = { w: 1, h: 1 }) {
  const { cols, rows } = scene.grid;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x + size.w <= cols && y + size.h <= rows;
}

function clampToGrid(scene, pos, size) {
  return {
    x: Math.max(0, Math.min(pos.x, scene.grid.cols - size.w)),
    y: Math.max(0, Math.min(pos.y, scene.grid.rows - size.h)),
  };
}

// Spiral outward (by Chebyshev ring) from `start` to find an unoccupied in-bounds cell.
function nearestFree(scene, occupied, start, size, skipStart) {
  const maxR = Math.max(scene.grid.cols, scene.grid.rows);
  for (let r = skipStart ? 1 : 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = start.x + dx, y = start.y + dy;
        if (inBounds(scene, x, y, size) && !occupied.has(`${x},${y}`)) return { x, y };
      }
    }
  }
  return start;
}

// Gives every entity visible in the scene a valid position there. Player characters land on
// the spawn square (stacking is allowed); other entities get the nearest free square to it.
export function ensurePlaced(state, sceneId) {
  const scene = state.scenes[sceneId];
  if (!scene) return;
  const ents = entitiesInScene(state, sceneId);
  const occupied = new Set();
  for (const e of ents) {
    const p = e.positions[sceneId];
    if (p && inBounds(scene, p.x, p.y, e.size)) occupied.add(`${p.x},${p.y}`);
  }
  for (const e of ents) {
    const p = e.positions[sceneId];
    if (p && inBounds(scene, p.x, p.y, e.size)) continue;
    const spawn = clampToGrid(scene, defaultSpawn(scene), e.size);
    const pos = e.kind === 'pc' ? spawn : nearestFree(scene, occupied, spawn, e.size, true);
    e.positions[sceneId] = pos;
    e.z = ++state.zCounter;
    occupied.add(`${pos.x},${pos.y}`);
  }
}
