import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { loadContent } from '../server/content.js';
import { TemplateStore } from '../server/templates.js';
import { GameService } from '../server/games/service.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const content = loadContent(join(ROOT, 'data'));

// rng that returns queued values, then falls back to `fallback` (default: max roll).
export function scriptedRng(fallback = (s) => s) {
  const queue = [];
  const rng = (sides) => (queue.length ? queue.shift() : fallback(sides));
  rng.push = (...v) => queue.push(...v);
  return rng;
}

export function makeService({ dbFile = ':memory:', now, rng } = {}) {
  const db = openDb(dbFile);
  const templates = new TemplateStore(db);
  const clock = { t: 1_000_000 };
  rng ??= scriptedRng();
  const service = new GameService({ db, content, templates, rng, now: now ?? (() => clock.t) });
  return { db, templates, service, clock, rng };
}

export const DM = { role: 'dm' };

export function ok(r) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.result;
}

export function setup(opts) {
  const ctx = makeService(opts);
  const { service, templates } = ctx;
  const game = service.createGame('Test');
  const tpl = templates.create({
    name: 'Cave', grid: { cols: 10, rows: 8 },
    entities: [{ kind: 'monster', defId: 'rat', x: 5, y: 5 }],
  });
  const tpl2 = templates.create({ name: 'Forest', grid: { cols: 12, rows: 12 }, spawn: { x: 3, y: 3 } });
  const join = (name) => {
    const r = ok(service.dispatch(game.id, { role: 'join' }, { type: 'player.create', name }));
    return { role: 'player', playerId: r.playerId, seatSecret: r.seatSecret };
  };
  const state = () => service.get(game.id).state;
  const run = (actor, cmd) => service.dispatch(game.id, actor, cmd);
  return { ...ctx, game, tpl, tpl2, join, state, run };
}
