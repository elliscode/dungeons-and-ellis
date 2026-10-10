import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';
import { reduceIncoming } from '../server/games/combat.js';

// Ana plays a Paladin (tank), Bo a Ranger (dps). A goblin stands next to both.
function arena() {
  const s = setup();
  const a = s.join('Ana'), b = s.join('Bo');
  ok(s.run(a, { type: 'player.selectCharacter', characterId: 'paladin' }));
  ok(s.run(b, { type: 'player.selectCharacter', characterId: 'ranger' }));
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const tank = s.state().players[a.playerId].entityId;
  const dps = s.state().players[b.playerId].entityId;
  const gob = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 1, y: 7 })).entityId;
  return { ...s, a, b, tank, dps, gob, sid };
}
const toDmPhase = (s) => { ok(s.run(DM, { type: 'combat.start' })); ok(s.run(DM, { type: 'combat.advance' })); };

// ---------- enemy action limits ----------

test('enemies only act in DM PHASE and get one action by default', () => {
  const s = arena();
  ok(s.run(DM, { type: 'combat.start' }));
  assert.match(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }).error, /Enemies act during the DM PHASE/);
  ok(s.run(DM, { type: 'combat.advance' }));
  s.rng.push(1); // natural 1: miss (keeps HP simple)
  ok(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }));
  assert.match(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }).error, /no actions left/);
  ok(s.run(DM, { type: 'move', entityId: s.gob, x: 2, y: 6 }), 'movement is separate from actions');
  ok(s.run(DM, { type: 'move', entityId: s.gob, x: 1, y: 6 }));
  assert.equal(s.state().turn[s.gob].actions, 1, 'one counter, no duplicate');
});

test('allowance resets each DM PHASE', () => {
  const s = arena();
  toDmPhase(s);
  s.rng.push(1);
  ok(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }));
  ok(s.run(DM, { type: 'combat.advance' })); // player phase
  ok(s.run(DM, { type: 'combat.advance' })); // DM phase, round 2
  s.rng.push(1);
  ok(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }));
});

test('definitions can grant more actions (dragon: 2)', () => {
  const s = arena();
  const tpl = s.templates.create({ name: 'Lair', grid: { cols: 12, rows: 12 } });
  const lair = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: lair }));
  const dragon = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'dragon', x: 3, y: 8 })).entityId;
  ok(s.run(DM, { type: 'move', entityId: s.dps, x: 1, y: 11 }));
  toDmPhase(s);
  s.rng.push(1, 1);
  ok(s.run(DM, { type: 'attack', entityId: dragon, attackId: 'bite', targetId: s.dps }));
  ok(s.run(DM, { type: 'attack', entityId: dragon, attackId: 'fire-breath', targetId: s.dps }));
  assert.equal(s.run(DM, { type: 'attack', entityId: dragon, attackId: 'claw', targetId: s.dps }).ok, false);
});

test('DM overrides: +1 action, manual damage and HP tools ignore the budget', () => {
  const s = arena();
  toDmPhase(s);
  s.rng.push(1);
  ok(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }));
  ok(s.run(DM, { type: 'entity.grantAction', entityId: s.gob }));
  s.rng.push(1);
  ok(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }), 'granted action');
  assert.equal(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.dps }).ok, false);
  ok(s.run(DM, { type: 'combat.advance' })); // player phase: DM tools still work
  ok(s.run(DM, { type: 'entity.damage', entityId: s.dps, amount: 3 }));
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.gob, hp: 2 }));
  ok(s.run(DM, { type: 'entity.kill', entityId: s.gob }));
});

test('friendly NPCs are not limited; hostile NPCs are', () => {
  const s = arena();
  const guard = ok(s.run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'town-guard', x: 2, y: 7 })).entityId;
  ok(s.run(DM, { type: 'combat.start' }));
  s.rng.push(1, 1);
  ok(s.run(DM, { type: 'attack', entityId: guard, attackId: 'spear', targetId: s.gob }), 'friendly NPC in player phase');
  ok(s.run(DM, { type: 'attack', entityId: guard, attackId: 'spear', targetId: s.gob }));
  ok(s.run(DM, { type: 'entity.setHostile', entityId: guard, hostile: true }));
  assert.match(s.run(DM, { type: 'attack', entityId: guard, attackId: 'spear', targetId: s.dps }).error, /DM PHASE/);
});

test('players still get one action and the projection reports the allowance', async () => {
  const s = arena();
  ok(s.run(DM, { type: 'combat.start' }));
  s.rng.push(1);
  ok(s.run(s.b, { type: 'attack', entityId: s.dps, attackId: 'longbow', targetId: s.gob }));
  assert.match(s.run(s.b, { type: 'attack', entityId: s.dps, attackId: 'longbow', targetId: s.gob }).error, /no actions left/);
  const { projectForPlayer } = await import('../server/games/project.js');
  const me = projectForPlayer(s.state(), s.b.playerId, () => 'online').entities.find((e) => e.id === s.dps);
  assert.equal(me.actionsPerPhase, 1);
});

// ---------- tank damage reduction ----------

test('tank reduction: 25%, rounded down, minimum 1', () => {
  const tank = { kind: 'pc', role: 'tank' };
  assert.equal(reduceIncoming(tank, 8), 2);
  assert.equal(reduceIncoming(tank, 7), 1);
  assert.equal(reduceIncoming(tank, 3), 1);
  assert.equal(reduceIncoming(tank, 1), 1);
  assert.equal(reduceIncoming(tank, 0), 0);
  assert.equal(reduceIncoming(tank, 41), 10);
  assert.equal(reduceIncoming({ kind: 'pc', role: 'dps' }, 8), 8);
  assert.equal(reduceIncoming({ kind: 'monster', role: null }, 8), 8);
});

test('tank reduction applies to attacks and DM damage, and reports the damage dealt', () => {
  const s = arena();
  const hp0 = s.state().entities[s.tank].hp; // 42
  // DM manual damage
  ok(s.run(DM, { type: 'entity.damage', entityId: s.tank, amount: 10 }));
  assert.equal(s.state().entities[s.tank].hp, hp0 - 2);
  // monster attack: 1d20+4 -> 15+4 hits DEF 18; damage 1d6+2 -> 6+2 = 8 -> 2
  toDmPhase(s);
  s.rng.push(15, 6);
  const r = ok(s.run(DM, { type: 'attack', entityId: s.gob, attackId: 'scimitar', targetId: s.tank }));
  assert.equal(r.damage, 2);
  assert.equal(s.state().entities[s.tank].hp, hp0 - 4);
  const log = s.service.history(s.game.id, 'player').feed.map((x) => x.text).join('\n');
  assert.match(log, /takes 2 damage \(10, reduced by Tank\)/);
  assert.match(log, /HIT for 2 \(\[6\]\+2 = 8, reduced by Tank\)/);
  // non-tank takes full damage
  ok(s.run(DM, { type: 'entity.damage', entityId: s.dps, amount: 10 }));
  assert.equal(s.state().entities[s.dps].hp, 34 - 10);
});

test('tank reduction does not touch healing, set HP, or death override', () => {
  const s = arena();
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.tank, hp: 5 }));
  assert.equal(s.state().entities[s.tank].hp, 5);
  ok(s.run(DM, { type: 'entity.heal', entityId: s.tank, amount: 8 }));
  assert.equal(s.state().entities[s.tank].hp, 13);
  // downed tank (max 42) needs reduced damage >= 42 to die: 167 raw -> 41 stays down, 168 -> 42 dies
  ok(s.run(DM, { type: 'entity.setHp', entityId: s.tank, hp: 0 }));
  assert.equal(s.state().entities[s.tank].status, 'down');
  ok(s.run(DM, { type: 'entity.damage', entityId: s.tank, amount: 167 }));
  assert.equal(s.state().entities[s.tank].status, 'down');
  ok(s.run(DM, { type: 'entity.damage', entityId: s.tank, amount: 168 }));
  assert.equal(s.state().entities[s.tank].status, 'dead');
  ok(s.run(DM, { type: 'entity.revive', entityId: s.tank }));
  ok(s.run(DM, { type: 'entity.kill', entityId: s.tank }));
  assert.equal(s.state().entities[s.tank].status, 'dead');
});
