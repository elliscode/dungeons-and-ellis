import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, makeService, ok, DM } from './helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('timer expiry advances phase on the server', async () => {
  const s = setup({ now: Date.now });
  ok(s.run(DM, { type: 'combat.setTimer', seconds: 1 }));
  ok(s.run(DM, { type: 'combat.start' }));
  const endsAt = s.state().combat.phaseEndsAt;
  assert.ok(endsAt > Date.now());
  // simulate a short phase
  s.state().combat.phaseEndsAt = Date.now() + 30;
  s.service.syncTimer(s.service.get(s.game.id));
  await wait(80);
  assert.equal(s.state().combat.phase, 'dm');
  assert.ok(s.state().combat.phaseEndsAt >= Date.now() + 900);
  ok(s.run(DM, { type: 'combat.end' }));
  assert.equal(s.service.timers.size, 0);
  s.service.close();
});

test('stale timer events are ignored', () => {
  const s = setup();
  ok(s.run(DM, { type: 'combat.setTimer', seconds: 30 }));
  ok(s.run(DM, { type: 'combat.start' }));
  const r = s.service.dispatch(s.game.id, { role: 'system' }, { type: 'combat.timerExpired', phaseEndsAt: 123 });
  assert.equal(r.ok, false);
  assert.equal(s.state().combat.phase, 'player');
  s.service.close();
});

test('state survives a restart, and an expired phase advances on load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dne-'));
  const dbFile = join(dir, 'test.sqlite');
  try {
    const s1 = makeService({ dbFile, now: Date.now });
    const game = s1.service.createGame('Persist');
    const tpl = s1.templates.create({ name: 'Room', grid: { cols: 6, rows: 6 } });
    const p = ok(s1.service.dispatch(game.id, { role: 'join' }, { type: 'player.create', name: 'Ana' }));
    const actor = { role: 'player', playerId: p.playerId };
    ok(s1.service.dispatch(game.id, actor, { type: 'player.selectCharacter', characterId: 'paladin' }));
    const sid = ok(s1.service.dispatch(game.id, DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
    ok(s1.service.dispatch(game.id, DM, { type: 'scene.activate', sceneId: sid }));
    const gob = ok(s1.service.dispatch(game.id, DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin' })).entityId;
    ok(s1.service.dispatch(game.id, DM, { type: 'entity.damage', entityId: gob, amount: 4 }));
    ok(s1.service.dispatch(game.id, DM, { type: 'combat.setTimer', seconds: 60 }));
    ok(s1.service.dispatch(game.id, DM, { type: 'combat.start' }));
    s1.service.chat(game.id, actor, 'hello');
    // Pretend the server went down and the phase expired while it was off.
    const st = s1.service.get(game.id).state;
    st.combat.phaseEndsAt = Date.now() - 1000;
    s1.service.persist(s1.service.get(game.id), []);
    s1.service.close();
    s1.db.close();

    const s2 = makeService({ dbFile, now: Date.now });
    s2.service.restoreAll();
    await wait(30);
    const st2 = s2.service.get(game.id).state;
    assert.equal(st2.players[p.playerId].characterId, 'paladin');
    assert.equal(st2.entities[gob].hp, 5);
    assert.equal(st2.combat.phase, 'dm', 'expired phase advanced exactly once');
    assert.ok(st2.combat.phaseEndsAt > Date.now());
    assert.equal(s2.service.history(game.id, 'player').feed.filter((r) => r.kind === 'chat').at(-1).text, 'hello');
    s2.service.close();
    s2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
