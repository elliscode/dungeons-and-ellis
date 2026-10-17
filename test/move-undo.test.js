import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';

// Ana plays the Shadow Rogue (movement 7) at (0,0) on a 12×12 scene; Bo plays the Cleric.
function arena() {
  const s = setup();
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl2.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const a = s.join('Ana'), b = s.join('Bo');
  ok(s.run(a, { type: 'player.selectCharacter', characterId: 'shadow-rogue' }));
  ok(s.run(b, { type: 'player.selectCharacter', characterId: 'cleric' }));
  const ea = s.state().players[a.playerId].entityId;
  const eb = s.state().players[b.playerId].entityId;
  ok(s.run(DM, { type: 'move', entityId: ea, x: 0, y: 0, force: true }));
  ok(s.run(DM, { type: 'move', entityId: eb, x: 0, y: 5, force: true }));
  const e = () => s.state().entities[ea];
  const pos = () => ({ ...e().positions[sid] });
  const moved = () => s.state().turn[ea]?.moved ?? 0;
  const move = (x, y) => s.run(a, { type: 'move', entityId: ea, x, y });
  const undo = (actor = a, entityId = ea) => s.run(actor, { type: 'move.undo', entityId });
  const fight = () => ok(s.run(DM, { type: 'combat.start' }));
  const last = () => s.service.history(s.game.id, 'dm').feed.at(-1).text;
  return { ...s, sid, a, b, ea, eb, e, pos, moved, move, undo, fight, last };
}

test('undo steps back one move at a time and returns the squares', () => {
  const w = arena();
  w.fight();
  ok(w.move(3, 0));
  ok(w.move(3, 2));
  assert.equal(w.moved(), 5);
  ok(w.undo());
  assert.deepEqual(w.pos(), { x: 3, y: 0 });
  assert.equal(w.moved(), 3);
  assert.match(w.last(), /Shadow Rogue takes back their move/);
  ok(w.undo());
  assert.deepEqual(w.pos(), { x: 0, y: 0 });
  assert.equal(w.moved(), 0);
  assert.equal(w.undo().error, 'Nothing to undo');
});

test('the movement really comes back: use all 7, undo, move 7 again', () => {
  const w = arena();
  w.fight();
  ok(w.move(7, 0));
  assert.match(w.move(7, 1).error, /Not enough movement: 0 squares left/);
  ok(w.undo());
  ok(w.move(0, 7));
  assert.equal(w.moved(), 7);
});

test('acting locks moves in; moves after the action can be undone', () => {
  const w = arena();
  w.fight();
  ok(w.move(2, 0));
  ok(w.run(w.a, { type: 'act', entityId: w.ea, actId: 'search' }));
  assert.equal(w.undo().error, 'Nothing to undo');
  assert.deepEqual(w.pos(), { x: 2, y: 0 });
  ok(w.move(4, 0));
  ok(w.undo());
  assert.deepEqual(w.pos(), { x: 2, y: 0 });
  assert.equal(w.moved(), 2, 'only the move after the action came back');
});

test('a free ability (Cunning Action) also locks moves in', () => {
  const w = arena();
  w.fight();
  ok(w.move(2, 0));
  ok(w.run(w.a, { type: 'ability', entityId: w.ea, abilityId: 'cunning-action' }));
  assert.equal(w.undo().error, 'Nothing to undo');
});

test('a failed action does not clear the history', () => {
  const w = arena();
  w.fight();
  ok(w.move(2, 0));
  const gob = ok(w.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 11, y: 11 })).entityId;
  assert.match(w.run(w.a, { type: 'attack', entityId: w.ea, attackId: 'twin-daggers', targetId: gob }).error, /out of range/);
  ok(w.undo());
});

test('the DM moving you locks in your earlier moves', () => {
  const w = arena();
  w.fight();
  ok(w.move(2, 0));
  ok(w.run(DM, { type: 'move', entityId: w.ea, x: 5, y: 5, force: true }));
  assert.equal(w.undo().error, 'Nothing to undo');
  assert.deepEqual(w.pos(), { x: 5, y: 5 });
  ok(w.move(6, 5), 'a move after the DM\'s can still be undone');
  ok(w.undo());
  assert.deepEqual(w.pos(), { x: 5, y: 5 });
});

test('undo never jumps you back from a square the move didn\'t leave you on', () => {
  const w = arena();
  w.fight();
  ok(w.move(2, 0));
  w.edit((st) => { st.entities[w.ea].positions[w.sid] = { x: 9, y: 9 }; }); // moved by something that bypassed the move command
  assert.equal(w.undo().error, "You were moved since then, so that move can't be undone");
  assert.deepEqual(w.pos(), { x: 9, y: 9 });
});

test('the phase ending clears the history; DM phase and out of combat are refused', () => {
  const w = arena();
  assert.equal(w.undo().error, 'Undo move only works in combat');
  w.fight();
  ok(w.move(2, 0));
  ok(w.run(DM, { type: 'combat.advance' }));
  assert.equal(w.undo().error, 'Wait for the PLAYER PHASE');
  ok(w.run(DM, { type: 'combat.advance' }));
  assert.equal(w.undo().error, 'Nothing to undo');
});

test('only the owner can undo their move; the DM\'s Undo reverts a move.undo', () => {
  const w = arena();
  w.fight();
  ok(w.move(2, 0));
  assert.match(w.undo(w.b, w.ea).error, /not your character/);
  assert.equal(w.run(DM, { type: 'move.undo', entityId: w.ea }).error, 'Not allowed');
  ok(w.undo());
  ok(w.run(DM, { type: 'undo' }));
  assert.deepEqual(w.pos(), { x: 2, y: 0 });
  assert.equal(w.moved(), 2);
});
