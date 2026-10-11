import { newId, fail } from './games/state.js';

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

// Validates and normalizes scene template data coming from the editor.
export function normalizeTemplate(input = {}) {
  const name = String(input.name ?? '').trim().slice(0, 60) || 'Untitled scene';
  const g = input.grid ?? {};
  const grid = {
    cols: clampInt(g.cols, 1, 100, 20),
    rows: clampInt(g.rows, 1, 100, 14),
    cellSize: clampInt(g.cellSize, 16, 256, 64),
    offsetX: clampInt(g.offsetX, -2000, 2000, 0),
    offsetY: clampInt(g.offsetY, -2000, 2000, 0),
    color: /^#[0-9a-f]{3,8}$/i.test(g.color ?? '') ? g.color : '#ffffff',
    opacity: Math.max(0, Math.min(1, Number(g.opacity ?? 0.25))),
  };
  const inGrid = (o) => Number.isInteger(o.x) && Number.isInteger(o.y) && o.x >= 0 && o.y >= 0 && o.x < grid.cols && o.y < grid.rows;
  const background = typeof input.background === 'string' && input.background.startsWith('/static/') ? input.background : null;
  const bgScale = Math.max(0.1, Math.min(10, Number(input.bgScale) || 1));
  const entities = (Array.isArray(input.entities) ? input.entities : []).filter(inGrid).slice(0, 200)
    .filter((e) => (e.kind === 'npc' || e.kind === 'monster') && typeof e.defId === 'string')
    .map((e) => ({
      id: typeof e.id === 'string' ? e.id.slice(0, 20) : newId('t'),
      kind: e.kind, defId: e.defId, x: e.x, y: e.y,
      ...(e.name ? { name: String(e.name).slice(0, 40) } : {}),
    }));
  const spawn = input.spawn && inGrid(input.spawn) ? { x: input.spawn.x, y: input.spawn.y } : null;
  return { name, data: { background, bgScale, grid, entities, spawn } };
}

export class TemplateStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }

  list() {
    return this.db.prepare('SELECT id, name, data, updated_at FROM scene_templates ORDER BY name COLLATE NOCASE')
      .all().map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at, background: JSON.parse(r.data).background }));
  }

  get(id) {
    const r = this.db.prepare('SELECT id, name, data, updated_at FROM scene_templates WHERE id = ?').get(String(id ?? ''));
    return r ? { id: r.id, name: r.name, data: JSON.parse(r.data), updatedAt: r.updated_at } : null;
  }

  // Counts how many templates reference each /static/... image (as a background).
  imageRefs() {
    const counts = new Map();
    const add = (path) => path && counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const r of this.db.prepare('SELECT data FROM scene_templates').all()) {
      const d = JSON.parse(r.data);
      add(d.background);
    }
    return counts;
  }

  create(input) {
    const { name, data } = normalizeTemplate(input);
    const id = newId('tpl');
    const t = this.now();
    this.db.prepare('INSERT INTO scene_templates (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, JSON.stringify(data), t, t);
    return this.get(id);
  }

  update(id, input) {
    if (!this.get(id)) fail('Scene not found');
    const { name, data } = normalizeTemplate(input);
    this.db.prepare('UPDATE scene_templates SET name = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(data), this.now(), id);
    return this.get(id);
  }

  delete(id) {
    return this.db.prepare('DELETE FROM scene_templates WHERE id = ?').run(id).changes > 0;
  }
}
