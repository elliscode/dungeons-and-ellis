import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, ok, DM, ROOT } from './helpers.js';
import { PLAYER_COLORS } from '../server/games/state.js';
import { projectForDm, projectForPlayer } from '../server/games/project.js';

test('two players cannot claim the same character', () => {
  const { join, run } = setup();
  const a = join('Ana'), b = join('Bo');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'paladin' }));
  const r = run(b, { type: 'player.selectCharacter', characterId: 'paladin' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already been chosen/);
  ok(run(b, { type: 'player.selectCharacter', characterId: 'cleric' }));
  assert.equal(run(a, { type: 'player.selectCharacter', characterId: 'ranger' }).ok, false, 'cannot pick a second hero');
});

test('name change keeps identity, color and character', () => {
  const { join, run, state } = setup();
  const a = join('Ana');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  const before = structuredClone(state().players[a.playerId]);
  ok(run(a, { type: 'player.setName', name: 'Anastasia' }));
  const after = state().players[a.playerId];
  assert.equal(after.name, 'Anastasia');
  assert.equal(after.color, before.color);
  assert.equal(after.characterId, 'fire-mage');
  assert.equal(after.entityId, before.entityId);
  assert.equal(Object.keys(state().players).length, 1);
});

test('colors are unique, changeable, and survive character changes', () => {
  const { join, run, state } = setup();
  const a = join('Ana'), b = join('Bo');
  assert.notEqual(state().players[a.playerId].color, state().players[b.playerId].color);
  assert.equal(run(b, { type: 'player.setColor', color: state().players[a.playerId].color }).ok, false);
  assert.equal(run(b, { type: 'player.setColor', color: '#123456' }).ok, false);
  ok(run(b, { type: 'player.setColor', color: PLAYER_COLORS[9] }));
  ok(run(b, { type: 'player.selectCharacter', characterId: 'bard' }));
  ok(run(DM, { type: 'dm.resetPlayer', playerId: b.playerId }));
  ok(run(b, { type: 'player.selectCharacter', characterId: 'druid' }));
  assert.equal(state().players[b.playerId].color, PLAYER_COLORS[9]);
});

test('game holds at most 10 players', () => {
  const { join, run } = setup();
  for (let i = 0; i < 10; i++) join(`P${i}`);
  assert.equal(run({ role: 'join' }, { type: 'player.create', name: 'Eleven' }).ok, false);
});

test('DM reset releases character; remove invalidates seat', () => {
  const { join, run, state } = setup();
  const a = join('Ana'), b = join('Bo');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'paladin' }));
  const eid = state().players[a.playerId].entityId;
  ok(run(DM, { type: 'dm.resetPlayer', playerId: a.playerId }));
  assert.equal(state().players[a.playerId].characterId, null);
  assert.equal(state().entities[eid], undefined);
  ok(run(b, { type: 'player.selectCharacter', characterId: 'paladin' }), 'released hero is free again');

  ok(run(DM, { type: 'dm.removePlayer', playerId: a.playerId }));
  const r = run(a, { type: 'player.setName', name: 'x' });
  assert.equal(r.ok, false, 'removed seat can no longer act');
});

test('players cannot run DM commands or touch other characters', () => {
  const { join, run, state, tpl } = setup();
  const a = join('Ana'), b = join('Bo');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'paladin' }));
  ok(run(b, { type: 'player.selectCharacter', characterId: 'cleric' }));
  const sid = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: sid }));
  const bEntity = state().players[b.playerId].entityId;
  assert.match(run(a, { type: 'move', entityId: bEntity, x: 1, y: 1 }).error, /not your character/);
  assert.equal(run(a, { type: 'entity.setHp', entityId: state().players[a.playerId].entityId, hp: 999 }).error, 'Not allowed');
  assert.equal(run(a, { type: 'combat.start' }).error, 'Not allowed');
  assert.equal(run(a, { type: 'undo' }).error, 'Not allowed');
  assert.equal(run(a, { type: 'combat.timerExpired' }).error, 'Not allowed');
});

test('players can rename the hero they play', () => {
  const { join, run, state, service, game } = setup();
  const a = join('Ana'), b = join('Bo');
  assert.equal(run(a, { type: 'player.renameCharacter', name: 'Tabasco' }).error, 'Pick a hero first');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  ok(run(b, { type: 'player.selectCharacter', characterId: 'paladin' }));
  const ea = state().players[a.playerId].entityId;
  const eb = state().players[b.playerId].entityId;
  const paladin = state().entities[eb].name;

  ok(run(a, { type: 'player.renameCharacter', name: '  Tabasco Habanero ' }));
  assert.equal(state().entities[ea].name, 'Tabasco Habanero');
  assert.equal(state().entities[eb].name, paladin, 'only your own hero');
  const feed = () => service.history(game.id, 'dm').feed;
  assert.match(feed().at(-1).text, /Ana's Fire Mage is now known as Tabasco Habanero/);

  // Everyone sees the new name: DM and player views.
  const presence = () => 'online';
  assert.equal(projectForDm(state(), presence).players.find((p) => p.id === a.playerId).heroName, 'Tabasco Habanero');
  const bView = projectForPlayer(state(), b.playerId, presence);
  assert.equal(bView.players.find((p) => p.id === a.playerId).heroName, 'Tabasco Habanero');
  assert.equal(projectForPlayer(state(), a.playerId, presence).me.heroName, 'Tabasco Habanero');

  const rows = feed().length;
  ok(run(a, { type: 'player.renameCharacter', name: 'Tabasco Habanero' }));
  assert.equal(feed().length, rows, 'same name: nothing logged');
  assert.match(run(a, { type: 'player.renameCharacter', name: '   ' }).error, /Character name is required/);
  ok(run(a, { type: 'player.renameCharacter', name: 'x'.repeat(60) }));
  assert.equal(state().entities[ea].name.length, 40, 'long names are cut to 40');
  assert.equal(run(DM, { type: 'player.renameCharacter', name: 'Nope' }).error, 'Not allowed');
});

test('a DM rename shows in heroName; releasing the hero resets its name', () => {
  const { join, run, state } = setup();
  const a = join('Ana');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  const ea = state().players[a.playerId].entityId;
  ok(run(DM, { type: 'entity.rename', entityId: ea, name: 'Sparky' }));
  assert.equal(projectForDm(state(), () => 'online').players[0].heroName, 'Sparky');
  ok(run(DM, { type: 'dm.resetPlayer', playerId: a.playerId }));
  assert.equal(projectForDm(state(), () => 'online').players[0].heroName, null);
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  const again = state().entities[state().players[a.playerId].entityId];
  assert.equal(again.name, 'Fire Mage');
});

test('red is not a player color (it is the enemy color); the first player gets green', () => {
  const { join, run, state } = setup();
  assert.ok(!PLAYER_COLORS.includes('#e6194b'));
  assert.equal(PLAYER_COLORS.length, 10);
  assert.equal(PLAYER_COLORS.at(-1), '#469990', 'teal took its place at the end');
  const a = join('Ana');
  assert.equal(state().players[a.playerId].color, '#3cb44b');
  assert.equal(run(a, { type: 'player.setColor', color: '#e6194b' }).error, 'Pick a color from the bank');
  ok(run(a, { type: 'player.setColor', color: '#469990' }));
});

test('saved games with a red player are moved to a free color on load', () => {
  const { join, state, service, game, db } = setup();
  const a = join('Ana'), b = join('Bo');
  // Simulate a game saved before red was removed: Ana red, Bo green.
  const saved = structuredClone(state());
  saved.players[a.playerId].color = '#e6194b';
  saved.players[b.playerId].color = '#3cb44b';
  db.prepare('UPDATE games SET state = ? WHERE id = ?').run(JSON.stringify(saved), game.id);
  service.games.delete(game.id); // force a reload from the database

  const loaded = service.get(game.id).state;
  assert.equal(loaded.players[b.playerId].color, '#3cb44b', 'valid colors are kept');
  assert.equal(loaded.players[a.playerId].color, '#4363d8', 'the first free bank color');
  const stored = JSON.parse(db.prepare('SELECT state FROM games WHERE id = ?').get(game.id).state);
  assert.equal(stored.players[a.playerId].color, '#4363d8', 'saved back to the database');
});

test('the client color list matches the server list', () => {
  const src = readFileSync(join(ROOT, 'client', 'js', 'common.js'), 'utf8');
  const m = src.match(/export const PLAYER_COLORS = (\[[^\]]*\]);/);
  assert.ok(m, 'PLAYER_COLORS found in common.js');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), PLAYER_COLORS);
});

test('leaving your hero is off by default; the DM switches it per game', () => {
  const { join, run, state, service, game, db } = setup();
  const a = join('Ana');
  assert.equal(state().options.playersCanLeave, false);
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  assert.equal(run(a, { type: 'player.leaveCharacter' }).error, "The DM hasn't allowed leaving heroes in this game");
  assert.ok(state().players[a.playerId].entityId, 'still has the hero');

  assert.equal(run(a, { type: 'game.setOption', option: 'playersCanLeave', value: true }).error, 'Not allowed');
  assert.equal(run(DM, { type: 'game.setOption', option: 'nope', value: true }).error, 'Unknown game option');
  assert.equal(run(DM, { type: 'game.setOption', option: 'playersCanLeave', value: 'yes' }).error, 'Option value must be on or off');
  ok(run(DM, { type: 'game.setOption', option: 'playersCanLeave', value: true }));
  assert.equal(state().options.playersCanLeave, true);
  const feed = service.history(game.id, 'player').feed;
  assert.match(feed.at(-1).text, /DM allowed players to leave their heroes/, 'players see it');
  assert.equal(projectForPlayer(state(), a.playerId, () => 'online').options.playersCanLeave, true);

  ok(run(DM, { type: 'game.setOption', option: 'playersCanLeave', value: false }));
  assert.match(service.history(game.id, 'player').feed.at(-1).text, /DM stopped players leaving their heroes/);
  assert.equal(run(a, { type: 'player.leaveCharacter' }).error, "The DM hasn't allowed leaving heroes in this game");

  // Games saved before options existed load with it off.
  const saved = structuredClone(state());
  delete saved.options;
  db.prepare('UPDATE games SET state = ? WHERE id = ?').run(JSON.stringify(saved), game.id);
  service.games.delete(game.id);
  assert.equal(service.get(game.id).state.options.playersCanLeave, false);
});

test('with the option on, a player leaves their hero and picks another', () => {
  const { join, run, state, service, game } = setup();
  const a = join('Ana'), b = join('Bo');
  ok(run(DM, { type: 'game.setOption', option: 'playersCanLeave', value: true }));
  assert.equal(run(a, { type: 'player.leaveCharacter' }).error, "You don't have a hero");
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  ok(run(a, { type: 'player.renameCharacter', name: 'Sparky' }));
  const before = structuredClone(state().players[a.playerId]);

  ok(run(a, { type: 'player.leaveCharacter' }));
  const p = state().players[a.playerId];
  assert.equal(p.characterId, null);
  assert.equal(p.entityId, null);
  assert.equal(state().entities[before.entityId], undefined, 'the token is gone');
  assert.deepEqual([p.name, p.color], [before.name, before.color], 'seat, name and color kept');
  assert.match(service.history(game.id, 'player').feed.at(-1).text, /Ana left Sparky/);

  ok(run(b, { type: 'player.selectCharacter', characterId: 'fire-mage' }), 'the hero is free again');
  ok(run(a, { type: 'player.selectCharacter', characterId: 'cleric' }));
  assert.equal(state().entities[state().players[a.playerId].entityId].name, 'Cleric');
});

test('leaving works mid-combat, even downed, and clears undo', () => {
  const { join, run, state, service, game, tpl } = setup();
  const sid = ok(run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(run(DM, { type: 'scene.activate', sceneId: sid }));
  const a = join('Ana');
  ok(run(DM, { type: 'game.setOption', option: 'playersCanLeave', value: true }));
  ok(run(a, { type: 'player.selectCharacter', characterId: 'fire-mage' }));
  const ea = state().players[a.playerId].entityId;
  ok(run(DM, { type: 'combat.start' }));
  ok(run(DM, { type: 'entity.damage', entityId: ea, amount: 30 }));
  assert.equal(state().entities[ea].status, 'down');
  ok(run(a, { type: 'player.leaveCharacter' }));
  assert.equal(state().entities[ea], undefined);
  assert.equal(state().turn[ea], undefined);
  assert.equal(service.undoInfo(game.id), null, 'undo history cleared');
});
