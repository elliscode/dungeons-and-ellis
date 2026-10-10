import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, makeService, scriptedRng, ok, DM } from './helpers.js';
import { projectForPlayer, projectForDm } from '../server/games/project.js';

const fallback = (sides) => (sides === 20 ? 15 : 1);

function range() {
  const rng = scriptedRng(fallback);
  const s = setup({ rng });
  const tpl = s.templates.create({ name: 'Yard', grid: { cols: 12, rows: 8 } });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const p = s.join('Juno');
  ok(s.run(p, { type: 'player.selectCharacter', characterId: 'x-wind-monk' }));
  const monk = s.state().players[p.playerId].entityId;
  ok(s.run(DM, { type: 'move', entityId: monk, x: 0, y: 0, force: true }));
  const dummy = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 1, y: 0 })).entityId;
  return { ...s, rng, sid, p, monk, dummy, d: () => s.state().entities[dummy] };
}

test('weapon hits report damage; misses use its Defense (10)', () => {
  const s = range();
  ok(s.run(DM, { type: 'combat.start' }));
  s.rng.push(4); // 4+5 = 9 < 10
  assert.equal(ok(s.run(s.p, { type: 'attack', entityId: s.monk, attackId: s.state().entities[s.monk].attacks[0].id, targetId: s.dummy })).hit, false);
  ok(s.run(DM, { type: 'combat.advance' }));
  ok(s.run(DM, { type: 'combat.advance' }));
  s.rng.push(5, 3); // 10 vs 10 hits
  const r = ok(s.run(s.p, { type: 'attack', entityId: s.monk, attackId: s.state().entities[s.monk].attacks[0].id, targetId: s.dummy }));
  assert.equal(r.hit, true);
  assert.equal(s.d().damageTaken, r.damage);
  assert.equal(s.d().status, 'active');
  const log = s.service.history(s.game.id, 'player').feed.map((f) => f.text).join('\n');
  assert.match(log, new RegExp(`Training Dummy: ${r.damage} total damage`));
  assert.doesNotMatch(log, /slain|DIED|DOWN/);
});

test('unlimited damage: 1,000 hits and a million-damage hit never down or kill it', () => {
  const s = range();
  for (let i = 0; i < 1000; i++) ok(s.run(DM, { type: 'entity.damage', entityId: s.dummy, amount: 50 }));
  ok(s.run(DM, { type: 'entity.damage', entityId: s.dummy, amount: 10000 }));
  const ctxDamage = 1000 * 50 + 10000;
  assert.equal(s.d().damageTaken, ctxDamage);
  assert.equal(s.d().hits, 1001);
  assert.equal(s.d().status, 'active');
  assert.equal(s.d().hp, null, 'no HP pool at all');
  assert.ok(s.state().entities[s.dummy], 'still present');
});

test('Flurry, area and chain attacks all hit it and it stands', () => {
  const s = range();
  const p2 = s.join('Rurik');
  ok(s.run(p2, { type: 'player.selectCharacter', characterId: 'x-stormcaller' }));
  const storm = s.state().players[p2.playerId].entityId;
  ok(s.run(DM, { type: 'move', entityId: storm, x: 2, y: 1, force: true }));
  const second = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 4, y: 1 })).entityId;
  ok(s.run(s.p, { type: 'ability', entityId: s.monk, abilityId: 'flurry-of-blows', targetId: s.dummy }));
  assert.equal(s.d().hits, 4);
  ok(s.run(p2, { type: 'ability', entityId: storm, abilityId: 'thunderclap' })); // both dummies within 2
  ok(s.run(p2, { type: 'ability', entityId: storm, abilityId: 'chain-lightning', targetId: s.dummy, picks: [second] }));
  assert.equal(s.d().hits, 6);
  assert.equal(s.state().entities[second].hits, 2);
  assert.notEqual(second, s.dummy, 'independent instances');
  assert.equal(s.state().entities[second].name, 'Training Dummy 2');
  for (const id of [s.dummy, second]) assert.equal(s.state().entities[id].status, 'active');
});

test('it cannot act or be healed, killed, or HP-set; DM can reset and remove it', () => {
  const s = range();
  ok(s.run(DM, { type: 'combat.start' }));
  ok(s.run(DM, { type: 'combat.advance' }));
  assert.match(s.run(DM, { type: 'attack', entityId: s.dummy, attackId: 'x', targetId: s.monk }).error, /no actions left|Unknown attack/);
  assert.match(s.run(DM, { type: 'move', entityId: s.dummy, x: 2, y: 0 }).error, /0 squares left/);
  for (const cmd of [{ type: 'entity.kill' }, { type: 'entity.setHp', hp: 0 }, { type: 'entity.setStatus', status: 'dead' }, { type: 'entity.heal', amount: 5 }, { type: 'entity.revive' }]) {
    assert.match(s.run(DM, { ...cmd, entityId: s.dummy }).error, /training dummy/i, cmd.type);
  }
  ok(s.run(DM, { type: 'entity.damage', entityId: s.dummy, amount: 7 }));
  ok(s.run(DM, { type: 'entity.resetDummy', entityId: s.dummy }));
  assert.equal(s.d().damageTaken, 0);
  ok(s.run(DM, { type: 'entity.remove', entityId: s.dummy }));
  assert.equal(s.state().entities[s.dummy], undefined);
});

test('debuffs still apply; healing it is skipped, not an error, inside area heals', () => {
  const s = range();
  const p2 = s.join('Bea');
  ok(s.run(p2, { type: 'player.selectCharacter', characterId: 'x-beastmaster' }));
  const beast = s.state().players[p2.playerId].entityId;
  ok(s.run(DM, { type: 'move', entityId: beast, x: 0, y: 2, force: true }));
  ok(s.run(p2, { type: 'ability', entityId: beast, abilityId: 'snare-trap', targetId: s.dummy }));
  assert.ok(s.d().effects.some((fx) => fx.status === 'snared'));
});

test('projections: players see the dummy without HP; DM sees totals', () => {
  const s = range();
  ok(s.run(DM, { type: 'entity.damage', entityId: s.dummy, amount: 12 }));
  const pv = projectForPlayer(s.state(), s.p.playerId, () => 'online').entities.find((e) => e.id === s.dummy);
  assert.equal(pv.immortal, true);
  assert.equal(pv.damageTaken, 12);
  assert.equal('hp' in pv, false);
  const dv = projectForDm(s.state(), () => 'online').entities[s.dummy];
  assert.equal(dv.damageTaken, 12);
});

test('dummy survives a restart as a dummy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dne-dummy-'));
  try {
    const dbFile = join(dir, 'db.sqlite');
    const a = makeService({ dbFile });
    const game = a.service.createGame('Yard');
    const tpl = a.templates.create({ name: 'R', grid: { cols: 5, rows: 5 } });
    const sid = ok(a.service.dispatch(game.id, DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
    ok(a.service.dispatch(game.id, DM, { type: 'scene.activate', sceneId: sid }));
    const id = ok(a.service.dispatch(game.id, DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy' })).entityId;
    ok(a.service.dispatch(game.id, DM, { type: 'entity.damage', entityId: id, amount: 99 }));
    a.service.close(); a.db.close();
    const b = makeService({ dbFile });
    ok(b.service.dispatch(game.id, DM, { type: 'entity.damage', entityId: id, amount: 1e6 }));
    const d = b.service.get(game.id).state.entities[id];
    assert.equal(d.immortal, true);
    assert.equal(d.status, 'active');
    assert.equal(d.damageTaken, 99 + 1e6);
    b.service.close(); b.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normal monsters and heroes still go down and die', () => {
  const s = range();
  const gob = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 5, y: 5 })).entityId;
  ok(s.run(DM, { type: 'entity.damage', entityId: gob, amount: 100 }));
  assert.equal(s.state().entities[gob].status, 'dead');
  ok(s.run(DM, { type: 'entity.damage', entityId: s.monk, amount: 100 }));
  assert.equal(s.state().entities[s.monk].status, 'down');
});
