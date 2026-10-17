import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';
import { projectForDm } from '../core/project.js';

// Ana (Shadow Rogue) and Bo (Cleric), a friendly Town Guard, a Goblin and a hostile bandit (an NPC).
function table() {
  const s = setup();
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl2.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const a = s.join('Ana'), b = s.join('Bo');
  ok(s.run(a, { type: 'player.selectCharacter', characterId: 'shadow-rogue' }));
  ok(s.run(b, { type: 'player.selectCharacter', characterId: 'cleric' }));
  const ea = s.state().players[a.playerId].entityId;
  const eb = s.state().players[b.playerId].entityId;
  ok(s.run(DM, { type: 'move', entityId: ea, x: 0, y: 0, force: true }));
  ok(s.run(DM, { type: 'move', entityId: eb, x: 1, y: 0, force: true }));
  const spawn = (kind, defId, x, y) => ok(s.run(DM, { type: 'entity.spawn', kind, defId, x, y })).entityId;
  const guard = spawn('npc', 'town-guard', 0, 1);
  const gob = spawn('monster', 'goblin', 1, 1);
  const bandit = spawn('npc', 'town-guard', 2, 1);
  ok(s.run(DM, { type: 'entity.setHostile', entityId: bandit, hostile: true }));
  const tp = () => projectForDm(s.state(), () => 'online').turnProgress;
  const ent = (id) => s.state().entities[id];
  return { ...s, a, b, ea, eb, guard, gob, bandit, tp, ent };
}

test('no combat, no counter', () => {
  const w = table();
  assert.equal(w.tp(), null);
});

test('PLAYER PHASE counts heroes and friendly NPCs; a friendly NPC has one action', () => {
  const w = table();
  ok(w.run(DM, { type: 'combat.start' }));
  let tp = w.tp();
  assert.deepEqual([tp.side, tp.done, tp.total], ['party', 0, 3]);
  assert.deepEqual(tp.pending.map((p) => p.name), ['Cleric', 'Shadow Rogue', 'Town Guard'], 'heroes first, then by name');

  ok(w.run(w.a, { type: 'act', entityId: w.ea, actId: 'search' }));
  tp = w.tp();
  assert.deepEqual([tp.done, tp.total], [1, 3]);
  assert.deepEqual(tp.pending.map((p) => p.name), ['Cleric', 'Town Guard']);

  ok(w.run(DM, { type: 'attack', entityId: w.guard, attackId: 'spear', targetId: w.gob }));
  assert.deepEqual([w.tp().done, w.tp().total], [2, 3], 'the friendly NPC acting counts');
  assert.match(w.run(DM, { type: 'attack', entityId: w.guard, attackId: 'spear', targetId: w.gob }).error, /no actions left/);
  ok(w.run(DM, { type: 'entity.grantAction', entityId: w.guard }));
  assert.deepEqual([w.tp().done, w.tp().pending[1]], [1, { id: w.guard, name: 'Town Guard', left: 1 }], '+1 action: not done again');
});

test('DM PHASE counts monsters and hostile NPCs; friendly NPCs wait for the PLAYER PHASE', () => {
  const w = table();
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.run(w.a, { type: 'act', entityId: w.ea, actId: 'search' }));
  ok(w.run(DM, { type: 'combat.advance' }));
  let tp = w.tp();
  assert.deepEqual([tp.side, tp.done, tp.total], ['enemies', 0, 2], 'turn state reset, enemies only');
  assert.deepEqual(tp.pending.map((p) => p.id).sort(), [w.gob, w.bandit].sort());
  ok(w.run(DM, { type: 'attack', entityId: w.gob, attackId: w.ent(w.gob).attacks[0].id, targetId: w.ea }));
  assert.deepEqual([w.tp().done, w.tp().total], [1, 2]);
  assert.match(w.run(DM, { type: 'attack', entityId: w.guard, attackId: 'spear', targetId: w.gob }).error, /Friendly NPCs act during the PLAYER PHASE/);
  ok(w.run(DM, { type: 'combat.advance' }));
  tp = w.tp();
  assert.deepEqual([tp.side, tp.done], ['party', 0], 'a new round starts from 0');
});

test('granted actions, reduced actions and who is left out', () => {
  const w = table();
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.run(DM, { type: 'entity.grantAction', entityId: w.ea }));
  ok(w.run(w.a, { type: 'act', entityId: w.ea, actId: 'search' }));
  assert.equal(w.tp().pending.find((p) => p.id === w.ea).left, 1, 'a granted action is still to use');

  // Allowance 0 (reduce_actions), a dead NPC, a training dummy: not counted.
  w.edit((st) => st.entities[w.guard].effects.push({ id: 'fx_test', type: 'reduce_actions', params: { amount: 1 }, expires: null }));
  const dummy = ok(w.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 5, y: 5 })).entityId;
  const extra = ok(w.run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'walky-the-wize', x: 6, y: 6 })).entityId;
  ok(w.run(DM, { type: 'entity.kill', entityId: extra }));
  const tp = w.tp();
  assert.equal(tp.total, 2, 'just the two heroes');
  assert.ok(!tp.pending.some((p) => [w.guard, dummy, extra].includes(p.id)));
});

test('a downed hero counts, and is done after the down roll', () => {
  const w = table();
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.run(DM, { type: 'entity.damage', entityId: w.eb, amount: 40 }));
  assert.equal(w.ent(w.eb).status, 'down');
  assert.ok(w.tp().pending.some((p) => p.id === w.eb));
  w.rng.push(12); // holds on
  ok(w.run(w.b, { type: 'downRoll', entityId: w.eb }));
  assert.ok(!w.tp().pending.some((p) => p.id === w.eb));
});
