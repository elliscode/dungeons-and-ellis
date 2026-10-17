import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';
import { DM_COLOR } from '../core/state.js';

function table() {
  const s = setup();
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const a = s.join('Ana'), b = s.join('Bo');
  const pings = [];
  s.service.on('ping', (gameId, p) => pings.push({ gameId, ...p }));
  const ping = (actor, pos = { x: 2.5, y: 3.25 }) => s.service.ping(s.game.id, actor, pos);
  return { ...s, sid, a, b, pings, ping };
}

test('a ping reaches everyone with the scene, position and the pinger\'s color', () => {
  const w = table();
  assert.deepEqual(w.ping(w.a), { ok: true });
  assert.deepEqual(w.pings[0], { gameId: w.game.id, sceneId: w.sid, x: 2.5, y: 3.25, color: w.state().players[w.a.playerId].color });
  ok(w.ping(DM, { x: 1, y: 1 }));
  assert.equal(w.pings[1].color, DM_COLOR);
});

test('players get 10 pings a minute, then are muted for a minute from the 10th', () => {
  const w = table();
  for (let i = 0; i < 10; i++) {
    assert.equal(w.ping(w.a).ok, true, `ping ${i + 1}`);
    w.clock.t += 1000;
  }
  const tenth = w.clock.t - 1000;
  const r = w.ping(w.a);
  assert.equal(r.ok, false);
  assert.match(r.error, /Ping limit reached \(10 per minute\)\. Try again in \d+s\./);
  assert.equal(w.pings.length, 10, 'a refused ping is not broadcast');

  w.clock.t = tenth + 59_000;
  assert.match(w.ping(w.a).error, /Try again in 1s/, 'still muted, and refused pings do not extend the mute');
  w.clock.t = tenth + 60_000;
  assert.equal(w.ping(w.a).ok, true, 'a minute after the 10th ping');
});

test('pings spread over more than a minute never hit the limit', () => {
  const w = table();
  for (let i = 0; i < 30; i++) {
    assert.equal(w.ping(w.a).ok, true, `ping ${i + 1}`);
    w.clock.t += 7000; // ~8.6 per minute
  }
});

test('the limit is per player, and the DM has none', () => {
  const w = table();
  for (let i = 0; i < 10; i++) ok(w.ping(w.a));
  assert.equal(w.ping(w.a).ok, false);
  assert.equal(w.ping(w.b).ok, true, 'another player is unaffected');
  for (let i = 0; i < 30; i++) assert.equal(w.ping(DM).ok, true, `DM ping ${i + 1}`);
});

test('bad pings are refused; positions off the grid (on the map image) are kept', () => {
  const w = table();
  assert.equal(w.ping(w.a, { x: 'a', y: 1 }).error, 'Bad ping');
  assert.equal(w.ping(w.a, { x: NaN, y: 1 }).error, 'Bad ping');
  assert.equal(w.ping(w.a, null).error, 'Bad ping');
  assert.equal(w.ping({ role: 'player', playerId: 'nobody' }).error, 'You are not in this game');
  assert.equal(w.ping(w.a, { x: 1e6, y: 1 }).error, 'Bad ping');
  ok(w.ping(w.a, { x: 14.5, y: -2 }));
  assert.deepEqual([w.pings[0].x, w.pings[0].y], [14.5, -2]);
  const fresh = setup(); // no scene activated yet
  assert.equal(fresh.service.ping(fresh.game.id, DM, { x: 1, y: 1 }).error, 'No active scene to ping');
});

test('a ping leaves game state, the Game Feed and undo untouched', () => {
  const w = table();
  const before = JSON.stringify(w.state());
  const feed = w.service.history(w.game.id, 'dm').feed.length;
  const undo = JSON.stringify(w.service.undoInfo(w.game.id));
  let changes = 0;
  w.service.on('change', () => changes++);
  ok(w.ping(w.a));
  assert.equal(JSON.stringify(w.state()), before);
  assert.equal(w.service.history(w.game.id, 'dm').feed.length, feed);
  assert.equal(JSON.stringify(w.service.undoInfo(w.game.id)), undo);
  assert.equal(changes, 0);
});
