import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';
import { projectForPlayer } from '../server/games/project.js';

function arena() {
  const s = setup();
  const a = s.join('Ana'), b = s.join('Bo');
  ok(s.run(a, { type: 'player.selectCharacter', characterId: 'shadow-rogue' }));
  ok(s.run(b, { type: 'player.selectCharacter', characterId: 'cleric' }));
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const ea = s.state().players[a.playerId].entityId;
  const eb = s.state().players[b.playerId].entityId;
  const gob = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 1, y: 7 })).entityId;
  return { ...s, a, b, ea, eb, gob, sid };
}

test('attacks are disabled outside combat', () => {
  const { run, a, ea, gob } = arena();
  const r = run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob });
  assert.match(r.error, /only available in combat/);
});

test('player phase: one action, movement separate and limited, range enforced', () => {
  const { run, a, ea, gob, rng, state } = arena();
  ok(run(DM, { type: 'combat.start' }));
  assert.equal(state().combat.phase, 'player');
  // move 3 then attack from range
  ok(run(a, { type: 'move', entityId: ea, x: 3, y: 7 }));
  assert.match(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }).error, /out of range/);
  rng.push(10, 1, 1); // 10+6 = 16 vs DEF 13: hit, damage 1d6+4 = 5, ×4 DPS = 20
  const r = ok(run(a, { type: 'attack', entityId: ea, attackId: 'throwing-knife', targetId: gob }));
  assert.equal(r.hit, true);
  assert.equal(r.damage, 20);
  assert.equal(state().entities[gob].hp, 0);
  assert.match(run(a, { type: 'attack', entityId: ea, attackId: 'throwing-knife', targetId: gob }).error, /no actions left/);
  ok(run(a, { type: 'move', entityId: ea, x: 7, y: 7 }), 'can still move after attacking');
  assert.match(run(a, { type: 'move', entityId: ea, x: 9, y: 7 }).error, /Not enough movement/);
});

test('ability can grant an extra action once per phase', () => {
  const { run, a, ea, gob, rng } = arena();
  ok(run(DM, { type: 'combat.start' }));
  ok(run(a, { type: 'ability', entityId: ea, abilityId: 'cunning-action' }));
  assert.match(run(a, { type: 'ability', entityId: ea, abilityId: 'cunning-action' }).error, /once per phase/);
  rng.push(1, 1); // natural 1 auto-miss
  assert.equal(ok(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob })).hit, false);
  rng.push(1);
  ok(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }));
  assert.equal(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }).ok, false);
});

test('players cannot act during DM phase; phases alternate and reset actions', () => {
  const { run, a, ea, gob, state, rng } = arena();
  ok(run(DM, { type: 'combat.start' }));
  rng.push(1);
  ok(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }));
  ok(run(DM, { type: 'combat.advance' }));
  assert.equal(state().combat.phase, 'dm');
  assert.match(run(a, { type: 'move', entityId: ea, x: 2, y: 7 }).error, /PLAYER PHASE/);
  ok(run(DM, { type: 'attack', entityId: gob, attackId: 'scimitar', targetId: ea }), 'DM attacks with monsters');
  ok(run(DM, { type: 'combat.advance' }));
  assert.equal(state().combat.round, 2);
  rng.push(1);
  ok(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }), 'action refreshed');
  ok(run(DM, { type: 'combat.end' }));
  assert.equal(state().combat.active, false);
  assert.equal(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }).ok, false);
});

test('crit doubles damage dice', () => {
  const { run, a, ea, gob, rng, state } = arena();
  ok(run(DM, { type: 'combat.start' }));
  rng.push(20, 1, 1, 1, 1);
  const r = ok(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }));
  assert.equal(r.crit, true);
  assert.equal(r.damage, (4 + 4) * 4, 'crit doubles the dice (2d4 → 4d4 = 4, +4), then DPS ×4');
  assert.equal(state().entities[gob].status, 'dead');
});

test('down at 0 HP, death when downed creature takes max HP, heal restores', () => {
  const { run, a, ea, b, eb, state } = arena();
  ok(run(DM, { type: 'entity.damage', entityId: ea, amount: 100 }));
  assert.equal(state().entities[ea].status, 'down');
  assert.equal(state().entities[ea].hp, 0);
  assert.match(run(a, { type: 'move', entityId: ea, x: 2, y: 7 }).error, /down/);
  assert.match(run(a, { type: 'act', entityId: ea, actId: 'search' }).error, /down/);
  ok(run(a, { type: 'downRoll', entityId: ea }));
  ok(run(DM, { type: 'entity.damage', entityId: ea, amount: 31 }));
  assert.equal(state().entities[ea].status, 'down', '31 < 32 max HP');
  ok(run(b, { type: 'ability', entityId: eb, abilityId: 'healing-word', targetId: ea }));
  assert.equal(state().entities[ea].status, 'active');
  ok(run(DM, { type: 'entity.setHp', entityId: ea, hp: 0 }));
  assert.equal(state().entities[ea].status, 'down');
  ok(run(DM, { type: 'entity.damage', entityId: ea, amount: 32 }));
  assert.equal(state().entities[ea].status, 'dead');
  assert.match(run(b, { type: 'ability', entityId: eb, abilityId: 'healing-word', targetId: ea }).error, /dead/);
  ok(run(DM, { type: 'entity.revive', entityId: ea }));
  assert.equal(state().entities[ea].status, 'active');
  assert.equal(state().entities[ea].hp, 1);
});

test('monsters die at 0 HP', () => {
  const { run, gob, state } = arena();
  ok(run(DM, { type: 'entity.damage', entityId: gob, amount: 9 }));
  assert.equal(state().entities[gob].status, 'dead');
});

test('inventory: use removes item and consumes action in combat', () => {
  const { run, a, ea, state } = arena();
  const item = state().entities[ea].inventory[0];
  ok(run(a, { type: 'item.use', entityId: ea, itemId: item.id }));
  assert.equal(state().entities[ea].inventory.length, 2);
  ok(run(DM, { type: 'item.add', entityId: ea, name: 'Rope' }));
  ok(run(DM, { type: 'combat.start' }));
  const [i1, i2] = state().entities[ea].inventory;
  ok(run(a, { type: 'item.use', entityId: ea, itemId: i1.id }));
  assert.match(run(a, { type: 'item.use', entityId: ea, itemId: i2.id }).error, /no actions left/);
});

test('player projection hides enemy HP and stats; activity text does not leak it', () => {
  const { run, a, ea, gob, state, service, game, rng } = arena();
  ok(run(DM, { type: 'combat.start' }));
  rng.push(15, 2, 2);
  ok(run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }));
  ok(run(DM, { type: 'entity.setHp', entityId: gob, hp: 3 }));
  const view = projectForPlayer(state(), a.playerId, () => 'online');
  const g = view.entities.find((e) => e.id === gob);
  for (const k of ['hp', 'maxHp', 'defense', 'attacks', 'inventory']) assert.equal(k in g, false, k);
  const mine = view.entities.find((e) => e.id === ea);
  assert.equal(typeof mine.hp, 'number');
  assert.ok(mine.attacks.length);
  const other = view.entities.find((e) => e.id !== ea && e.kind === 'pc');
  assert.equal(typeof other.hp, 'number', 'friendly HP visible');
  assert.equal('attacks' in other, false);
  assert.equal(JSON.stringify(view).includes('seatSecret'), false);

  const playerLog = service.history(game.id, 'player').feed.map((r) => r.text).join('\n');
  const dmLog = service.history(game.id, 'dm').feed.map((r) => r.text).join('\n');
  assert.doesNotMatch(playerLog, /Goblin \d+\/9/);
  assert.doesNotMatch(playerLog, /DEF 13/);
  assert.match(dmLog, /Goblin 3\/9/);
});

test('hostile NPCs are hidden like monsters', () => {
  const { run, a, state } = arena();
  const w = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'mysterious-wizard' })).entityId;
  assert.equal(typeof projectForPlayer(state(), a.playerId, () => 'online').entities.find((e) => e.id === w).hp, 'number');
  ok(run(DM, { type: 'entity.setHostile', entityId: w, hostile: true }));
  assert.equal('hp' in projectForPlayer(state(), a.playerId, () => 'online').entities.find((e) => e.id === w), false);
});

test('undo restores the last supported actions', () => {
  const { run, ea, gob, state, service, game } = arena();
  const before = structuredClone(state().entities[gob].positions);
  ok(run(DM, { type: 'move', entityId: gob, x: 8, y: 1 }));
  ok(run(DM, { type: 'entity.damage', entityId: ea, amount: 5 }));
  assert.equal(service.undoInfo(game.id), 'damage');
  assert.equal(ok(run(DM, { type: 'undo' })).undone, 'damage');
  assert.equal(state().entities[ea].hp, 32);
  ok(run(DM, { type: 'undo' }));
  assert.deepEqual(state().entities[gob].positions, before);
  const spawned = ok(run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'orc' })).entityId;
  ok(run(DM, { type: 'undo' }));
  assert.equal(state().entities[spawned], undefined);
  ok(run(DM, { type: 'combat.start' }));
  assert.equal(run(DM, { type: 'undo' }).ok, false, 'structural change clears undo');
});

test('failed commands leave state untouched', () => {
  const { run, a, ea, state } = arena();
  const before = JSON.stringify(state());
  assert.equal(run(a, { type: 'move', entityId: ea, x: 99, y: 99 }).ok, false);
  assert.equal(run(a, { type: 'act', entityId: ea, text: 'Dance', roll: '1d7' }).ok, false);
  assert.equal(JSON.stringify(state()), before);
});

test('players can only weapon-attack the other side; the DM can still force friendly fire', () => {
  const { run, a, ea, eb, gob, state } = arena();
  ok(run(DM, { type: 'move', entityId: ea, x: 0, y: 7, force: true }));
  ok(run(DM, { type: 'move', entityId: eb, x: 1, y: 6, force: true }));
  const guard = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'town-guard', x: 0, y: 6 })).entityId;
  const bandit = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'merchant', x: 2, y: 7 })).entityId;
  ok(run(DM, { type: 'entity.setHostile', entityId: bandit, hostile: true }));
  ok(run(DM, { type: 'combat.start' }));
  const hit = (target) => run(a, { type: 'attack', entityId: ea, attackId: 'throwing-knife', targetId: target });
  assert.match(hit(eb).error, /not an enemy/, 'another PC');
  assert.match(hit(guard).error, /not an enemy/, 'a friendly NPC');
  assert.equal(state().turn[ea]?.actions ?? 0, 0, 'a refused attack spends no action');
  ok(hit(bandit), 'a hostile NPC');
  assert.match(hit(gob).error, /no actions left/);
  ok(run(DM, { type: 'attack', entityId: eb, attackId: 'mace', targetId: ea }), 'DM-forced friendly fire');
});
