import { newId, fail } from '../core/state.js';
import { normalizeTemplate } from '../core/templates.js';

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
