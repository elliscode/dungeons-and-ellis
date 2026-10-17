import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, scriptedRng, fixedSettings, ok, DM, ROOT } from './helpers.js';
import { applyCommand, applyUndo, applyChat, checkPing, nextDeadline, PING_LIMIT } from '../core/index.js';

const CORE = join(ROOT, 'core');

test('core/ only imports its own modules and node:crypto', () => {
  for (const file of readdirSync(CORE).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(CORE, file), 'utf8');
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      assert.ok(/^\.\/[a-z-]+\.js$/.test(spec) || spec === 'node:crypto', `${file} imports ${spec}`);
    }
    for (const banned of [/\bDate\.now\b/, /\bnew Date\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bprocess\./, /\bMath\.random\b/, /^let\s/m]) {
      assert.doesNotMatch(src, banned, `${file} uses ${banned}`);
    }
  }
});

// A game with an active scene, one goblin and one joined hero, plus deps for calling the core directly.
function world() {
  const rng = scriptedRng((sides) => (sides === 20 ? 15 : 1));
  const s = setup({ rng });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const p = s.join('Ana');
  ok(s.run(p, { type: 'player.selectCharacter', characterId: 'paladin' }));
  const hero = s.state().players[p.playerId].entityId;
  return { ...s, p, hero, deps: () => s.service.deps() };
}

test('applyCommand never mutates its input and returns the new state', () => {
  const w = world();
  const before = w.state();
  const frozen = structuredClone(before);
  const r = applyCommand(before, DM, { type: 'entity.damage', entityId: w.hero, amount: 5 }, w.deps());
  assert.equal(r.ok, true);
  assert.deepEqual(before, frozen, 'input untouched');
  assert.equal(r.state.entities[w.hero].hp, before.entities[w.hero].hp - 1, 'tank at strength 4: ⌊5/4⌋');
  assert.ok(r.feed.length > 0 && r.feed.every((f) => f.kind === 'event' && !('id' in f)), 'feed rows without ids');
});

test('applyCommand is deterministic for fixed rng and clock', () => {
  const w = world();
  const deps = () => ({ ...w.deps(), rng: () => 4, now: 123 });
  const cmd = { type: 'roll', expr: '2d6+1' };
  assert.deepEqual(applyCommand(w.state(), DM, cmd, deps()), applyCommand(w.state(), DM, cmd, deps()));
});

test('a failing command returns ok:false and nothing to store', () => {
  const w = world();
  const before = structuredClone(w.state());
  for (const [actor, cmd, err] of [
    [DM, null, /Bad command/],
    [DM, { type: 'nope' }, /Unknown command/],
    [w.p, { type: 'combat.start' }, /Not allowed/],
    [{ role: 'player', playerId: 'ghost' }, { type: 'move', entityId: w.hero, x: 1, y: 1 }, /not in this game/],
    [DM, { type: 'entity.damage', entityId: 'missing', amount: 5 }, /./],
  ]) {
    const r = applyCommand(w.state(), actor, cmd, w.deps());
    assert.equal(r.ok, false);
    assert.match(r.error, err);
    assert.equal(r.state, undefined);
  }
  assert.deepEqual(w.state(), before);
});

test('undoable commands hand back the previous state as the snapshot; applyUndo restores it', () => {
  const w = world();
  const before = w.state();
  const r = applyCommand(before, DM, { type: 'entity.damage', entityId: w.hero, amount: 7 }, w.deps());
  assert.ok(r.undo?.label);
  assert.equal(r.undo.snapshot, before);
  assert.equal(applyUndo(r.state, w.p, r.undo, 1).error, 'Not allowed');
  assert.equal(applyUndo(r.state, DM, null, 1).error, 'Nothing to undo');
  const u = applyUndo(r.state, DM, r.undo, 1);
  assert.equal(u.ok, true);
  assert.equal(u.state.entities[w.hero].hp, before.entities[w.hero].hp);
  assert.match(u.feed[0].text, /DM undid the last/);
});

test('applyChat: rows, /roll routing and errors', () => {
  const w = world();
  assert.deepEqual(applyChat(w.state(), DM, '/r 1d20+2', 5), { roll: { type: 'roll', expr: '1d20+2' } });
  assert.equal(applyChat(w.state(), DM, '   ', 5).error, 'Empty message');
  assert.equal(applyChat(w.state(), { role: 'player', playerId: 'ghost' }, 'hi', 5).error, 'You are not in this game');
  const { row } = applyChat(w.state(), w.p, 'hello', 5);
  assert.deepEqual([row.kind, row.text, row.name, row.playerId, row.ts], ['chat', 'hello', 'Ana', w.p.playerId, 5]);
});

test('checkPing: the limiter record is data the shell stores', () => {
  const w = world();
  let lim;
  for (let i = 0; i < PING_LIMIT; i++) {
    const r = checkPing(w.state(), w.p, { x: 1, y: 1 }, lim, 1000 + i);
    assert.ok(r.ping, `ping ${i + 1}`);
    lim = r.limiter;
  }
  assert.match(checkPing(w.state(), w.p, { x: 1, y: 1 }, lim, 2000).error, /Ping limit reached/);
  assert.ok(checkPing(w.state(), w.p, { x: 1, y: 1 }, lim, 1009 + 60_000).ping, 'mute ends after a minute');
  assert.equal(checkPing(w.state(), DM, { x: 1, y: 1 }, null, 0).limiter, null, 'the DM is never limited');
  assert.equal(checkPing(w.state(), DM, { x: 'a', y: 1 }, null, 0).error, 'Bad ping');
});

test('nextDeadline reads the combat phase timer', () => {
  const w = world();
  assert.equal(nextDeadline(w.state()), null);
  const state = structuredClone(w.state());
  state.combat = { ...state.combat, active: true, phaseEndsAt: 5000 };
  assert.deepEqual(nextDeadline(state), { at: 5000, cmd: { type: 'combat.timerExpired', phaseEndsAt: 5000 } });
});

test('role strength comes from each service, not a global', () => {
  const hit = (n) => {
    const rng = scriptedRng(() => 1);
    const s = setup({ rng, settings: fixedSettings(n) });
    const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
    ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
    const p = s.join('Tank');
    ok(s.run(p, { type: 'player.selectCharacter', characterId: 'paladin' }));
    const id = s.state().players[p.playerId].entityId;
    const hp = s.state().entities[id].hp;
    ok(s.run(DM, { type: 'entity.damage', entityId: id, amount: 12 }));
    return hp - s.state().entities[id].hp;
  };
  assert.equal(hit(1), 12, 'strength 1: full damage');
  assert.equal(hit(4), 3, 'strength 4 in the same process: tank takes ¼');
});

test('a shell that forgets settings fails loudly instead of defaulting', () => {
  const w = world();
  const { settings, ...deps } = w.deps();
  assert.throws(() => applyCommand(w.state(), DM, { type: 'entity.damage', entityId: w.hero, amount: 5 }, deps), /ctx\.settings\.roleStrength/);
});
