import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';

const pos = (state, eid, sid) => state.entities[eid].positions[sid];

test('scene instances are deep copies independent of the template and each other', () => {
  const { run, state, tpl, templates } = setup();
  const s1 = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  const s2 = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  assert.notEqual(s1, s2);
  assert.equal(state().scenes[s2].name, 'Cave (2)');
  const rats = Object.values(state().entities).filter((e) => e.defId === 'rat');
  assert.equal(rats.length, 2);
  const [r1, r2] = [rats.find((r) => r.sceneId === s1), rats.find((r) => r.sceneId === s2)];
  ok(run(DM, { type: 'scene.activate', sceneId: s1 }));
  ok(run(DM, { type: 'move', entityId: r1.id, x: 0, y: 0 }));
  ok(run(DM, { type: 'entity.damage', entityId: r1.id, amount: 3 }));
  state().scenes[s1].grid.cols = 99;
  assert.deepEqual(pos(state(), r2.id, s2), { x: 5, y: 5 });
  assert.equal(state().entities[r2.id].hp, 7);
  const t = templates.get(tpl.id);
  assert.deepEqual(t.data.entities[0], { id: t.data.entities[0].id, kind: 'monster', defId: 'rat', x: 5, y: 5 });
  assert.equal(t.data.grid.cols, 10);
});

test('editing a template does not change existing instances', () => {
  const { run, state, tpl, templates } = setup();
  const s1 = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  templates.update(tpl.id, { name: 'Renamed', grid: { cols: 3, rows: 3 } });
  assert.equal(state().scenes[s1].grid.cols, 10);
  assert.equal(state().scenes[s1].name, 'Cave');
});

test('scene templates hold only creatures: objects are dropped on save and never reach a game', () => {
  const { run, state, templates } = setup();
  const t = templates.create({
    name: 'Old', grid: { cols: 6, rows: 6 },
    objects: [{ id: 'o1', image: '/static/images/crate.png', x: 1, y: 1, w: 1, h: 1, obstacle: true }],
    entities: [{ kind: 'monster', defId: 'rat', x: 2, y: 2 }],
  });
  assert.equal(templates.get(t.id).data.objects, undefined);
  assert.equal(templates.get(t.id).data.entities.length, 1);
  assert.equal(templates.imageRefs().get('/static/images/crate.png'), undefined);
  const sid = ok(run(DM, { type: 'scene.add', templateId: t.id })).sceneId;
  assert.equal(state().scenes[sid].objects, undefined);
});

test('scene switching: PCs and game-scoped entities follow, scene-scoped entities stay', () => {
  const { run, state, tpl, tpl2, join } = setup();
  const a = join('Ana');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'ranger' }));
  const pc = state().players[a.playerId].entityId;
  const cave = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  const forest = ok(run(DM, { type: 'scene.add', templateId: tpl2.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: cave }));
  assert.deepEqual(pos(state(), pc, cave), { x: 0, y: 7 }, 'default spawn is bottom-left');

  const walky = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'walky-the-wize', scope: 'game' })).entityId;
  const rat = Object.values(state().entities).find((e) => e.defId === 'rat').id;
  ok(run(DM, { type: 'move', entityId: rat, x: 2, y: 2 }));
  ok(run(DM, { type: 'entity.damage', entityId: walky, amount: 5 }));

  ok(run(DM, { type: 'scene.activate', sceneId: forest }));
  assert.deepEqual(pos(state(), pc, forest), { x: 3, y: 3 }, 'custom spawn');
  assert.ok(pos(state(), walky, forest), 'game-scoped NPC placed in new scene');
  assert.equal(state().entities[walky].hp, 20, 'state carried over');
  assert.equal(pos(state(), rat, forest), undefined, 'scene-scoped rat did not follow');

  ok(run(a, { type: 'move', entityId: pc, x: 6, y: 6 }));
  ok(run(DM, { type: 'scene.activate', sceneId: cave }));
  assert.deepEqual(pos(state(), rat, cave), { x: 2, y: 2 }, 'rat kept its last position');
  assert.deepEqual(pos(state(), pc, cave), { x: 0, y: 7 }, 'pc returns to its old spot in the cave');
});

test('game-scoped entities never keep out-of-bounds coordinates', () => {
  const { run, state, tpl, tpl2, templates } = setup();
  const forest = ok(run(DM, { type: 'scene.add', templateId: tpl2.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: forest }));
  const w = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'walky-the-wize', scope: 'game' })).entityId;
  ok(run(DM, { type: 'move', entityId: w, x: 11, y: 11 }));
  const tiny = templates.create({ name: 'Closet', grid: { cols: 2, rows: 2 } });
  const closet = ok(run(DM, { type: 'scene.add', templateId: tiny.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: closet }));
  const p = pos(state(), w, closet);
  assert.ok(p.x < 2 && p.y < 2);
});

test('promote and demote preserve state without duplicates', () => {
  const { run, state, tpl, tpl2 } = setup();
  const cave = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  const forest = ok(run(DM, { type: 'scene.add', templateId: tpl2.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: cave }));
  const rat = Object.values(state().entities).find((e) => e.defId === 'rat').id;
  ok(run(DM, { type: 'entity.damage', entityId: rat, amount: 2 }));
  ok(run(DM, { type: 'item.add', entityId: rat, name: 'Shiny Coin' }));
  const count = Object.keys(state().entities).length;

  ok(run(DM, { type: 'entity.setScope', entityId: rat, scope: 'game' }));
  assert.deepEqual(pos(state(), rat, cave), { x: 5, y: 5 }, 'keeps position in current scene');
  ok(run(DM, { type: 'scene.activate', sceneId: forest }));
  assert.ok(pos(state(), rat, forest), 'promoted rat follows');
  assert.equal(state().entities[rat].hp, 5);

  ok(run(DM, { type: 'entity.setScope', entityId: rat, scope: 'scene' }));
  assert.equal(state().entities[rat].sceneId, forest);
  ok(run(DM, { type: 'scene.activate', sceneId: cave }));
  const inCave = Object.values(state().entities).filter((e) => e.scope === 'game' || e.sceneId === cave);
  assert.ok(!inCave.some((e) => e.id === rat), 'demoted rat stayed in the forest');
  assert.equal(Object.keys(state().entities).length, count, 'no duplication or loss');
  assert.equal(state().entities[rat].inventory[0].name, 'Shiny Coin');
});

test('removing a scene instance removes only its scene-scoped entities', () => {
  const { run, state, tpl, tpl2 } = setup();
  const cave = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(run(DM, { type: 'scene.add', templateId: tpl2.id }));
  ok(run(DM, { type: 'scene.activate', sceneId: cave }));
  const w = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'walky-the-wize', scope: 'game' })).entityId;
  ok(run(DM, { type: 'scene.remove', sceneId: cave }));
  assert.equal(state().activeSceneId, null);
  assert.ok(state().entities[w]);
  assert.equal(state().entities[w].positions[cave], undefined);
  assert.ok(!Object.values(state().entities).some((e) => e.defId === 'rat'));
});

test('z-order: moved token becomes topmost', () => {
  const { run, state, tpl } = setup();
  const cave = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: cave }));
  const a = ok(run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin' })).entityId;
  const b = ok(run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin' })).entityId;
  ok(run(DM, { type: 'move', entityId: a, x: 1, y: 1 }));
  ok(run(DM, { type: 'move', entityId: b, x: 1, y: 1 }));
  assert.ok(state().entities[b].z > state().entities[a].z);
  ok(run(DM, { type: 'move', entityId: a, x: 1, y: 2 }));
  assert.ok(state().entities[a].z > state().entities[b].z);
  assert.equal(state().entities[b].name, 'Goblin 2');
});
