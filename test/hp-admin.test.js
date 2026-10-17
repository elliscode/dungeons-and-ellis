import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';

// DM HP tools on monsters: Set Max HP, then raise current HP to match.

function arena() {
  const s = setup();
  const tpl = s.templates.create({ name: 'R', grid: { cols: 8, rows: 8 } });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const gob = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 1, y: 1 })).entityId; // 9/9
  return { ...s, gob, g: () => s.state().entities[gob] };
}

test('raise max HP, then raise current HP to match', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: 20 }));
  assert.deepEqual([s.g().hp, s.g().maxHp], [9, 20], 'raising max does not heal');
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: 20 }));
  assert.deepEqual([s.g().hp, s.g().maxHp, s.g().status], [20, 20, 'active']);
});

test('values arriving as strings from the inspector inputs work', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: '25' }));
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: '25' }));
  assert.deepEqual([s.g().hp, s.g().maxHp], [25, 25]);
});

test('healing after raising max HP heals up to the new max', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: 20 }));
  ok(s.run(DM, { type: 'entity.heal', entityId: s.gob, amount: 50 }));
  assert.equal(s.g().hp, 20);
});

test('lowering max HP below current clamps current HP', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: 4 }));
  assert.deepEqual([s.g().hp, s.g().maxHp], [4, 4]);
});

test('undo reverts a max HP change and an HP change separately', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: 20 }));
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: 20 }));
  ok(s.run(DM, { type: 'undo' }));
  assert.deepEqual([s.g().hp, s.g().maxHp], [9, 20]);
  ok(s.run(DM, { type: 'undo' }));
  assert.deepEqual([s.g().hp, s.g().maxHp], [9, 9]);
});

test('the change survives in the projection the DM receives, and players never see the numbers', async () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: 20 }));
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: 20 }));
  const { projectForDm } = await import('../core/project.js');
  const dm = projectForDm(s.state(), () => 'online').entities[s.gob];
  assert.deepEqual([dm.hp, dm.maxHp], [20, 20]);
  const pub = s.service.history(s.game.id, 'player').feed.map((f) => f.text).join('\n');
  assert.doesNotMatch(pub, /20\/20/);
});

test('invalid inputs are rejected and change nothing', () => {
  const s = arena();
  for (const maxHp of [0, -5, 12.5, 'abc', '']) {
    assert.equal(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp }).ok, false, `maxHp ${JSON.stringify(maxHp)}`);
  }
  for (const hp of [-1, 12.5, 'abc']) {
    assert.equal(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp }).ok, false, `hp ${JSON.stringify(hp)}`);
  }
  assert.deepEqual([s.g().hp, s.g().maxHp], [9, 9]);
});

// ---------- fixed issues (were finicky in the inspector) ----------

test('one command sets max HP and HP together (max first), e.g. 20 / 20', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setHealth', entityId: s.gob, hp: '20', maxHp: '20' }));
  assert.deepEqual([s.g().hp, s.g().maxHp, s.g().status], [20, 20, 'active']);
  ok(s.run(DM, { type: 'entity.setHealth', entityId: s.gob, hp: 4, maxHp: 4 }), 'lowering both');
  assert.deepEqual([s.g().hp, s.g().maxHp], [4, 4]);
});

test('HP above max HP is refused with a clear message (not silently capped)', () => {
  const s = arena();
  const r = s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /can't be more than max HP \(9\)/);
  const r2 = s.run(DM, { type: 'entity.setHealth', entityId: s.gob, hp: 30, maxHp: 20 });
  assert.match(r2.error, /max HP \(20\)/);
  assert.deepEqual([s.g().hp, s.g().maxHp], [9, 9], 'nothing changed, not even max');
});

test('a blank HP or max HP field is refused, never treated as 0', () => {
  const s = arena();
  for (const cmd of [{ type: 'entity.setHp', hp: '' }, { type: 'entity.setHp', hp: '   ' }, { type: 'entity.setHp' }, { type: 'entity.setMaxHp', maxHp: '' }, { type: 'entity.setHealth' }]) {
    const r = s.run(DM, { ...cmd, entityId: s.gob });
    assert.equal(r.ok, false, JSON.stringify(cmd));
    assert.match(r.error, /required|Enter HP/);
  }
  assert.equal(s.g().status, 'active');
  assert.equal(s.g().hp, 9);
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: '0' }), 'an explicit 0 still works');
  assert.equal(s.g().status, 'dead');
});

test('setting HP above 0 on a dead monster brings it back', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.kill', entityId: s.gob }));
  ok(s.run(DM, { type: 'entity.setHealth', entityId: s.gob, hp: 25, maxHp: 25 }));
  assert.deepEqual([s.g().hp, s.g().maxHp, s.g().status], [25, 25, 'active']);
  assert.match(s.service.history(s.game.id, 'player').feed.at(-1).text, /Goblin is revived!/);
});

test('max HP changes are logged; players never see monster numbers', () => {
  const s = arena();
  const before = s.service.history(s.game.id, 'dm').feed.length;
  ok(s.run(DM, { type: 'entity.setMaxHp', entityId: s.gob, maxHp: 20 }));
  const dm = s.service.history(s.game.id, 'dm').feed;
  assert.equal(dm.length, before + 1);
  assert.match(dm.at(-1).text, /DM set Goblin max HP\. \(Goblin 9\/20\)/);
  assert.doesNotMatch(s.service.history(s.game.id, 'player').feed.at(-1).text, /\d+\/\d+/);
});
