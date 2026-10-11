import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, makeService, scriptedRng, ok, DM } from './helpers.js';
import { EFFECT_TYPES, handlerCalls, validateAbility } from '../server/games/effects.js';
import { dealDamage } from '../server/games/combat.js';
import { addEffect } from '../server/games/status.js';
import { actionAllowance } from '../server/games/state.js';
import { stripMarkers } from '../server/games/helpers.js';
import { movementAllowance } from '../server/games/status.js';

// Deterministic dice: d20 rolls 15 and every other die rolls 1, unless a test queues values.
const fallback = (sides) => (sides === 20 ? 15 : 1);

function world(heroes = [], { cols = 14, rows = 10 } = {}) {
  const rng = scriptedRng(fallback);
  const s = setup({ rng });
  const tpl = s.templates.create({ name: 'Arena', grid: { cols, rows } });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const h = {};
  for (const [key, charId, x, y] of heroes) {
    const p = s.join(key);
    ok(s.run(p, { type: 'player.selectCharacter', characterId: charId }));
    const id = s.state().players[p.playerId].entityId;
    ok(s.run(DM, { type: 'move', entityId: id, x, y, force: true }));
    h[key] = { actor: p, id };
  }
  const ent = (id) => s.state().entities[id];
  return {
    ...s, rng, sid, h, ent,
    hero: (key) => ent(h[key].id),
    spawn: (defId, x, y, kind = 'monster') => ok(s.run(DM, { type: 'entity.spawn', kind, defId, x, y })).entityId,
    use: (key, abilityId, extra = {}) => s.run(h[key].actor, { type: 'ability', entityId: h[key].id, abilityId, ...extra }),
    dmAttack: (id, attackId, targetId) => s.run(DM, { type: 'attack', entityId: id, attackId, targetId }),
    feed: (role = 'player') => s.service.history(s.game.id, role).feed,
    last: (role = 'player') => stripMarkers(s.service.history(s.game.id, role).feed.at(-1).text),
    fight: () => ok(s.run(DM, { type: 'combat.start' })),
    extraAction: (key) => ok(s.run(DM, { type: 'entity.grantAction', entityId: h[key].id })),
    next: () => ok(s.run(DM, { type: 'combat.advance' })),
  };
}

test('attack: miss on natural 1, hit rolls damage, HP clamps at 0', () => {
  const w = world([['mage', 'x-fire-mage', 0, 0]]);
  const gob = w.spawn('goblin', 3, 0);
  assert.match(w.use('mage', 'inferno-surge', { targetId: gob }).error, /only available in combat/);
  w.fight();
  w.rng.push(1);
  ok(w.use('mage', 'inferno-surge', { targetId: gob }));
  assert.equal(w.ent(gob).hp, 9);
  assert.match(w.last(), /Inferno Surge on Goblin: Goblin: MISS/);
  w.extraAction('mage');
  w.rng.push(15, 8, 8); // 20 vs DEF 13; 2d8+2 = 18, ×4 DPS = 72 > 9 HP
  ok(w.use('mage', 'inferno-surge', { targetId: gob }));
  assert.equal(w.ent(gob).hp, 0);
  assert.equal(w.ent(gob).status, 'dead');
  assert.match(w.last(), /HIT 72 \(×4 DPS\).*Goblin is slain!/);
  w.extraAction('mage');
  assert.match(w.use('mage', 'inferno-surge', { targetId: gob }).error, /is dead/);
});

test('healing respects max HP and reports what was restored', () => {
  const w = world([['cleric', 'x-cleric', 0, 0], ['ranger', 'x-ranger', 1, 0]]);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ranger.id, amount: 5 }));
  w.rng.push(8); // 1d8+3 = 11, but only 5 missing
  ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }));
  assert.equal(w.hero('ranger').hp, 34);
  assert.match(w.last(), /Tessa Winmer \+5|\+5/);
  const gob = w.spawn('goblin', 2, 0);
  assert.match(w.use('cleric', 'healing-word', { targetId: gob }).error, /not an ally/);
});

test('conditional heal: Life Drain heals the caster only on a hit', () => {
  const w = world([['lock', 'x-void-warlock', 0, 0]]);
  const gob = w.spawn('goblin', 2, 0);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.lock.id, amount: 10 }));
  w.fight();
  w.rng.push(1);
  ok(w.use('lock', 'life-drain', { targetId: gob }));
  assert.equal(w.hero('lock').hp, 20, 'miss: no heal');
  w.extraAction('lock');
  w.rng.push(15, 8, 6); // hit; 1d8+3 = 11 (×4 DPS); heal 1d6+2 = 8 (a DPS self-heal is not multiplied)
  ok(w.use('lock', 'life-drain', { targetId: gob }));
  assert.equal(w.hero('lock').hp, 28);
  assert.equal(w.ent(gob).status, 'dead');
});

test('Flurry of Blows: four independent attack rolls with separate damage, one action', () => {
  const w = world([['monk', 'x-wind-monk', 0, 0]]);
  const dummy = w.spawn('training-dummy', 1, 0);
  w.fight();
  // strike 1: 15 hit, 2d6 = 6+6; strike 2: natural 1; strike 3: natural 20 crit (4d6 = 1s); strike 4: 15 hit, 1+1
  // Each successful strike is multiplied ×4 (DPS) on its own: 14→56, 6→24, 4→16.
  w.rng.push(15, 6, 6, 1, 20, 1, 1, 1, 1, 15, 1, 1);
  const r = ok(w.use('monk', 'flurry-of-blows', { targetId: dummy }));
  assert.deepEqual(r.strikes.map((s) => s.hit), [true, false, true, true]);
  assert.deepEqual(r.strikes.map((s) => s.dealt), [56, 0, 24, 16]);
  assert.equal(r.strikes[2].crit, true);
  assert.equal(w.ent(dummy).damageTaken, 96);
  assert.equal(w.state().turn[w.h.monk.id].actions, 1, 'the whole flurry costs one action');
  assert.match(w.last(), /4 strikes on Training Dummy: HIT 56 \(×4 DPS\) · MISS · CRIT 24 \(×4 DPS\) · HIT 16 \(×4 DPS\) — 96 total/);
  assert.match(w.use('monk', 'flurry-of-blows', { targetId: dummy }).error, /no actions left/);
});

test('area attack: every enemy in the radius gets its own roll; others are untouched', () => {
  const w = world([['storm', 'x-stormcaller', 5, 5]]);
  const near = w.spawn('goblin', 6, 5);
  const edge = w.spawn('goblin', 7, 7);
  const far = w.spawn('goblin', 9, 5);
  w.fight();
  w.rng.push(1); // first target (nearest) misses, the next one hits with the fallback 15
  ok(w.use('storm', 'thunderclap'));
  assert.equal(w.ent(near).hp, 9);
  assert.equal(w.ent(edge).status, 'dead'); // 1d8+3 = 4, ×4 DPS = 16
  assert.equal(w.ent(far).hp, 9);
  assert.equal(w.feed().filter((f) => f.type === 'ability').length, 1, 'one feed row for the activation');
});

test('Chain Lightning and Chain Heal validate picked jumps', () => {
  const w = world([['storm', 'x-stormcaller', 0, 0], ['shaman', 'x-restoration-shaman', 0, 4], ['ranger', 'x-ranger', 1, 4], ['bard', 'x-bard', 2, 4], ['cleric', 'x-cleric', 3, 4]]);
  const g1 = w.spawn('goblin', 5, 0), g2 = w.spawn('goblin', 7, 0), g3 = w.spawn('goblin', 13, 0);
  w.fight();
  assert.match(w.use('storm', 'chain-lightning', { targetId: g1, picks: [g3] }).error, /too far/);
  assert.match(w.use('storm', 'chain-lightning', { targetId: g1, picks: [g1] }).error, /already in the chain/);
  assert.match(w.use('storm', 'chain-lightning', { targetId: g1, picks: [g2, g3] }).error, /at most 1/);
  ok(w.use('storm', 'chain-lightning', { targetId: g1, picks: [g2] }));
  assert.equal(w.ent(g1).status, 'dead'); // 2d8+1 with 1s = 3, ×4 DPS = 12 each
  assert.equal(w.ent(g2).status, 'dead');

  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ranger.id, amount: 10 }));
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.cleric.id, amount: 10 }));
  assert.match(w.use('shaman', 'chain-heal', { targetId: w.h.ranger.id, picks: [w.h.bard.id] }).error, /isn't wounded/);
  assert.equal(w.state().turn[w.h.shaman.id]?.actions ?? 0, 0, 'a rejected ability spends nothing');
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ranger.id, amount: 10 }));
  ok(w.use('shaman', 'chain-heal', { targetId: w.h.ranger.id, picks: [w.h.cleric.id] }));
  assert.equal(w.hero('ranger').hp, 34 - 20 + 12, '1d8+2 = 3, ×4 Heal = 12');
  assert.equal(w.hero('cleric').hp, 34, 'capped at max HP');
});

test('protection: halve the next hit, absorb the next hit, both consumed once', () => {
  const w = world([['wall', 'x-shieldmarshal', 0, 0], ['ice', 'x-frost-defender', 3, 0]]);
  ok(w.use('wall', 'shield-wall'));
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.wall.id, amount: 20 }));
  assert.equal(w.hero('wall').hp, 44 - 2, '20 → halved 10 → tank 25% = 2');
  assert.match(w.last(), /takes 2 damage \(20, reduced by Shield Wall, reduced by Tank\)/);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.wall.id, amount: 20 }));
  assert.equal(w.hero('wall').hp, 42 - 5, 'shield was used up');

  ok(w.use('ice', 'frozen-bulwark'));
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ice.id, amount: 20 }));
  assert.equal(w.hero('ice').hp, 43);
  assert.match(w.last(), /takes 0 damage \(20, absorbed by Frozen Bulwark\)/);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ice.id, amount: 20 }));
  assert.equal(w.hero('ice').hp, 38);
});

test('magical-only absorb (Spellguard) ignores physical hits', () => {
  const w = world([['breaker', 'x-spellbreaker', 0, 0], ['mage', 'x-fire-mage', 1, 0]]);
  ok(w.use('breaker', 'spellguard', { targetId: w.h.mage.id }));
  const ctx = { state: w.state(), rng: w.rng, fx() {} };
  const mage = w.hero('mage');
  assert.equal(dealDamage(ctx, { target: mage, raw: 6 }).dealt, 6, 'physical: not absorbed');
  assert.equal(dealDamage(ctx, { target: mage, raw: 6, damageType: 'fire' }).dealt, 0, 'magical: absorbed');
  assert.equal(dealDamage(ctx, { target: mage, raw: 6, damageType: 'fire' }).dealt, 6, 'used up');
});

test('Intercept redirects the next hit onto the tank, with tank mitigation applied once', () => {
  const w = world([['sentinel', 'x-dawn-sentinel', 0, 0], ['mage', 'x-fire-mage', 1, 0]]);
  const gob = w.spawn('goblin', 2, 0);
  ok(w.use('sentinel', 'intercept', { targetId: w.h.mage.id }));
  w.fight();
  w.next();
  w.rng.push(15, 3); // 19 vs mage DEF 13; 1d6+2 = 5 → redirected → tank 25% = 1
  const r = ok(w.dmAttack(gob, 'scimitar', w.h.mage.id));
  assert.equal(r.damage, 1);
  assert.equal(w.hero('mage').hp, 30);
  assert.equal(w.hero('sentinel').hp, 43);
  assert.match(w.last('dm'), /intercepted by/);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.mage.id, amount: 4 }));
  assert.equal(w.hero('mage').hp, 26, 'only the next hit is redirected');
});

test('timing: one-use Defense bonus, phase-based expiry, out-of-combat effects start with combat', () => {
  const w = world([['mist', 'x-mistweaver', 0, 0], ['pal', 'x-paladin', 4, 4], ['wall', 'x-shieldmarshal', 8, 8]]);
  const gob = w.spawn('goblin', 1, 0);
  ok(w.use('wall', 'shield-wall')); // out of combat: pending, clock starts at combat start
  w.fight();
  ok(w.use('mist', 'serene-focus')); // +3 DEF vs the next attack on self (15 → 18)
  ok(w.use('pal', 'blessed-aegis')); // until the next PLAYER PHASE
  w.next(); // DM phase (seq 2)
  w.rng.push(13); // 17 < 18: miss, consumes Serene Focus
  assert.equal(ok(w.dmAttack(gob, 'scimitar', w.h.mist.id)).hit, false);
  assert.equal(w.hero('mist').effects.length, 0);
  ok(w.run(DM, { type: 'entity.grantAction', entityId: gob }));
  w.rng.push(13);
  assert.equal(ok(w.dmAttack(gob, 'scimitar', w.h.mist.id)).hit, true, '17 vs plain DEF 15');
  assert.equal(w.hero('pal').effects.length, 1, 'aegis lasts through the DM phase');
  assert.equal(w.hero('wall').effects.length, 1, 'shield wall still up');
  w.next(); // player phase round 2 (seq 3)
  assert.equal(w.hero('pal').effects.length, 0, 'aegis ended at the next PLAYER PHASE');
  assert.equal(w.hero('wall').effects.length, 0, 'next_dm_phase ended after that DM phase');
  ok(w.use('wall', 'shield-wall'));
  ok(w.run(DM, { type: 'combat.end' }));
  assert.equal(w.hero('wall').effects.length, 0, 'ending combat clears timed effects');
});

test('action economy: free abilities, granted actions, once-per-phase limits', () => {
  const w = world([['rogue', 'x-shadow-rogue', 0, 0], ['mage', 'x-fire-mage', 0, 3]]);
  const dummy = w.spawn('training-dummy', 1, 0);
  w.fight();
  ok(w.use('mage', 'light'));
  ok(w.use('mage', 'inferno-surge', { targetId: dummy }), 'free Light did not use the action');
  ok(w.use('rogue', 'backstab', { targetId: dummy }));
  assert.match(w.use('rogue', 'backstab', { targetId: dummy }).error, /no actions left/);
  ok(w.use('rogue', 'cunning-action'));
  assert.match(w.use('rogue', 'cunning-action').error, /once per phase/);
  ok(w.use('rogue', 'backstab', { targetId: dummy }), 'granted action');
  assert.match(w.use('rogue', 'backstab', { targetId: dummy }).error, /no actions left/);
  // Schema guards against grant loops.
  assert.match(validateAbility({ id: 'x', name: 'X', actionCost: 0, effects: [{ type: 'grant_actions', amount: 1 }] }, 'x').join(), /need usesPerPhase/);
  assert.match(validateAbility({ id: 'x', name: 'X', actionCost: 0, usesPerPhase: 1, effects: [{ type: 'grant_actions', amount: 2 }] }, 'x').join(), /at most actionCost \+ 1/);
});

test('enemy action reduction integrates with allowances, never negative, and resets', () => {
  const w = world([['breaker', 'x-spellbreaker', 0, 0]]);
  const gob = w.spawn('goblin', 1, 0);
  w.fight();
  ok(w.use('breaker', 'silencing-strike', { targetId: gob })); // hit: −1 action on the next DM phase
  ok(w.run(DM, { type: 'entity.grantAction', entityId: w.h.breaker.id }));
  ok(w.use('breaker', 'silencing-strike', { targetId: gob }));
  assert.equal(actionAllowance(w.ent(gob), w.state().turn[gob]), 0, 'two reductions clamp at 0');
  w.next();
  assert.match(w.dmAttack(gob, 'scimitar', w.h.breaker.id).error, /no actions left/);
  w.next();
  w.next(); // the following DM phase: the reduction has expired
  w.rng.push(1);
  ok(w.dmAttack(gob, 'scimitar', w.h.breaker.id));
});

test('teleport validates distance and bounds; once per phase in combat', () => {
  const w = world([['sorc', 'x-frost-sorcerer', 0, 0]]);
  assert.match(w.use('sorc', 'blink-step', { cell: { x: 9, y: 0 } }).error, /out of range/);
  assert.match(w.use('sorc', 'blink-step', { cell: { x: 99, y: 0 } }).error, /square on the map/);
  ok(w.use('sorc', 'blink-step', { cell: { x: 4, y: 0 } }));
  assert.deepEqual(w.hero('sorc').positions[w.sid], { x: 4, y: 0 });
  w.fight();
  ok(w.use('sorc', 'blink-step', { cell: { x: 6, y: 0 } }));
  assert.match(w.use('sorc', 'blink-step', { cell: { x: 7, y: 0 } }).error, /once per phase/);
});

test('movement: snares and slows limit enemy moves; the DM can force', () => {
  const w = world([['beast', 'x-beastmaster', 0, 0], ['ranger', 'x-ranger', 0, 2]]);
  const gob = w.spawn('goblin', 2, 0);
  const orc = w.spawn('ogre', 4, 4); // 59 HP: survives the ×4 DPS pinning shot
  ok(w.use('beast', 'snare-trap', { targetId: gob })); // 19 vs DEF 13: snared
  w.fight();
  ok(w.use('ranger', 'pinning-shot', { targetId: orc })); // hit: −2 movement
  w.next();
  assert.match(w.run(DM, { type: 'move', entityId: gob, x: 3, y: 0 }).error, /0 squares left/);
  ok(w.run(DM, { type: 'move', entityId: gob, x: 3, y: 0, force: true }), 'DM override');
  assert.match(w.run(DM, { type: 'move', entityId: orc, x: 8, y: 4 }).error, /3 squares left/, 'ogre movement 5 − 2');
  ok(w.run(DM, { type: 'move', entityId: orc, x: 7, y: 4 }));
});

test('frightened (DM check) and taunt restrict enemies', () => {
  const w = world([['barb', 'x-barbarian', 0, 0], ['eng', 'x-ironclad-engineer', 5, 5], ['mage', 'x-fire-mage', 6, 6]]);
  const scared = w.spawn('goblin', 3, 0);
  ok(w.use('barb', 'intimidating-roar', { targetId: scared }));
  const [chk] = w.state().pendingChecks;
  assert.equal(chk.subjectId, scared);
  assert.match(w.last(), /awaiting the DM/);
  assert.equal(w.run(w.h.barb.actor, { type: 'check.resolve', checkId: chk.id, success: true }).error, 'Not allowed');
  ok(w.run(DM, { type: 'check.resolve', checkId: chk.id, success: true }));
  assert.equal(w.ent(scared).effects[0].status, 'frightened');
  assert.match(w.run(DM, { type: 'move', entityId: scared, x: 2, y: 0 }).error, /frightened/);
  ok(w.run(DM, { type: 'move', entityId: scared, x: 4, y: 0 }));

  const g1 = w.spawn('goblin', 6, 5);
  ok(w.use('eng', 'magnetic-taunt'));
  assert.ok(w.ent(g1).effects.some((fx) => fx.type === 'taunt'));
  w.fight();
  w.next();
  assert.match(w.dmAttack(g1, 'scimitar', w.h.mage.id).error, /taunted by/);
  w.rng.push(1);
  ok(w.dmAttack(g1, 'scimitar', w.h.eng.id));
});

test('downed and dead targets, DM revive', () => {
  const w = world([['cleric', 'x-cleric', 0, 0], ['ranger', 'x-ranger', 1, 0]]);
  ok(w.run(DM, { type: 'entity.setHp', entityId: w.h.ranger.id, hp: 0 }));
  assert.equal(w.hero('ranger').status, 'down');
  assert.match(w.use('ranger', 'pinning-shot', { targetId: w.h.cleric.id }).error, /down/);
  ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }));
  assert.equal(w.hero('ranger').status, 'active', 'healing a downed ally revives them');
  ok(w.run(DM, { type: 'entity.kill', entityId: w.h.ranger.id }));
  assert.match(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }).error, /is dead/);
  ok(w.run(DM, { type: 'entity.revive', entityId: w.h.ranger.id }));
  ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }));
  assert.equal(w.hero('ranger').hp, 1 + 16, '1d8+3 = 4, ×4 Heal');
});

test('authorization and hidden enemy HP in ability results', () => {
  const w = world([['mage', 'x-fire-mage', 0, 0], ['monk', 'x-wind-monk', 1, 1]]);
  const gob = w.spawn('ogre', 2, 0);
  assert.match(w.run(w.h.mage.actor, { type: 'ability', entityId: w.h.monk.id, abilityId: 'flurry-of-blows', targetId: gob }).error, /not your character/);
  w.fight();
  ok(w.use('mage', 'inferno-surge', { targetId: gob })); // 2d8+2 = 4, ×4 = 16: ogre 43/59
  const pub = w.last('player'), dm = w.last('dm');
  assert.doesNotMatch(pub, /43\/59/);
  assert.doesNotMatch(JSON.stringify(w.feed('player')), /"hp"/);
  assert.match(dm, /Ogre 43\/59/);
  assert.match(dm, /vs DEF 11/);
});

test('NPC and monster abilities use the same engine and enemy rules', () => {
  const w = world([['mage', 'x-fire-mage', 0, 0]]);
  const walky = w.spawn('walky-the-wize', 2, 0, 'npc');
  w.fight();
  ok(w.run(DM, { type: 'ability', entityId: walky, abilityId: 'wize-words' }), 'friendly NPC acts any phase');
  ok(w.run(DM, { type: 'entity.setHostile', entityId: walky, hostile: true }));
  assert.match(w.run(DM, { type: 'ability', entityId: walky, abilityId: 'wize-words' }).error, /DM PHASE/);
  w.next();
  ok(w.run(DM, { type: 'ability', entityId: walky, abilityId: 'wize-words' }));
  assert.match(w.run(DM, { type: 'ability', entityId: walky, abilityId: 'wize-words' }).error, /no actions left/);
});

test('support effects: roll bonus, mark, curse, sanctuary, beacon, poison/antidote, barrier, totem, brittle', () => {
  const w = world([
    ['bard', 'x-bard', 0, 0], ['ranger', 'x-ranger', 1, 0], ['lock', 'x-void-warlock', 2, 0], ['priest', 'x-holy-priest', 3, 0],
    ['lp', 'x-light-paladin', 4, 0], ['alch', 'x-field-alchemist', 5, 0], ['eng', 'x-ironclad-engineer', 6, 0],
    ['shaman', 'x-restoration-shaman', 7, 0], ['tester', 'x-tester', 8, 0], ['druid', 'x-druid', 9, 0],
  ]);
  const g1 = w.spawn('ogre', 1, 1), g2 = w.spawn('goblin', 5, 3), g3 = w.spawn('goblin', 9, 3);

  // Inspire: +1d6 (rolls 1) on the ranger's next attack roll, then gone.
  ok(w.use('bard', 'inspire', { targetId: w.h.ranger.id }));
  ok(w.use('ranger', 'hunters-mark', { targetId: g1 })); // roll uses the Inspire bonus
  assert.match(w.last(), /\+1 Inspired/);
  assert.equal(w.hero('ranger').effects.length, 0);
  // Hunter's Mark: the ranger's next hit on g1 adds 1d6.
  w.fight();
  ok(w.use('ranger', 'pinning-shot', { targetId: g1 }));
  assert.match(w.last(), /\+1 Hunter's Mark/);
  assert.equal(w.ent(g1).hp, 59 - (1 + 3 + 1) * 4, '(1d8+3 + 1d6 mark) ×4 DPS');

  // Curse of Weakness halves the goblin's next hit.
  ok(w.use('lock', 'curse-of-weakness', { targetId: g2 }));
  // Sanctuary: attacks on the priest take −5.
  ok(w.use('priest', 'sanctuary', { targetId: w.h.priest.id }));
  w.next();
  w.rng.push(13); // control: 13+4 = 17 vs the ranger's DEF 14 (no Sanctuary)
  assert.equal(ok(w.dmAttack(g1, 'greatclub', w.h.ranger.id)).hit, true);
  ok(w.run(DM, { type: 'move', entityId: g2, x: 3, y: 1, force: true }));
  w.rng.push(15, 6); // 1d6+2 = 8 → halved by the curse = 4
  assert.equal(ok(w.dmAttack(g2, 'scimitar', w.h.lock.id)).damage, 4);
  ok(w.run(DM, { type: 'entity.grantAction', entityId: g2 }));
  w.rng.push(13);
  assert.equal(ok(w.dmAttack(g2, 'scimitar', w.h.priest.id)).hit, false, 'Sanctuary −5');
  ok(w.run(DM, { type: 'combat.end' }));

  // Beacon of Grace: +3 on the light paladin's next heal of that ally.
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.alch.id, amount: 30 }));
  ok(w.use('lp', 'beacon-of-grace', { targetId: w.h.alch.id }));
  ok(w.use('lp', 'flash-of-light', { targetId: w.h.alch.id })); // 1d8+4 = 5, ×4 Heal = 20, then +3 Beacon
  assert.equal(w.hero('alch').hp, 31 - 30 + 23);
  assert.match(w.last(), /\+3 Beacon of Grace/);

  // Volatile Flask poisons (area around g3); Antidote removes poisoned.
  ok(w.run(DM, { type: 'effect.addStatus', entityId: w.h.druid.id, status: 'poisoned' }));
  w.fight();
  ok(w.use('alch', 'volatile-flask', { targetId: g3 }));
  w.extraAction('alch');
  assert.ok(w.ent(g3).effects.some((fx) => fx.status === 'poisoned'));
  ok(w.run(DM, { type: 'move', entityId: w.h.alch.id, x: 9, y: 1, force: true }));
  ok(w.use('alch', 'antidote', { targetId: w.h.druid.id }));
  assert.ok(!w.hero('druid').effects.some((fx) => fx.status === 'poisoned'));

  // Brittle: target takes +2 from hits.
  ok(w.use('tester', 'brittle', { targetId: g3 }));
  const hpBefore = w.ent(g3).hp;
  ok(w.run(DM, { type: 'entity.damage', entityId: g3, amount: 1 }));
  assert.equal(w.ent(g3).hp, hpBefore - 3);

  // Deploy Barrier and Healing Totem create temporary objects.
  ok(w.use('eng', 'deploy-barrier', { cell: { x: 6, y: 1 } }));
  const barrier = Object.values(w.state().entities).find((e) => e.name === 'Barrier');
  assert.equal(barrier.kind, 'object');
  assert.match(w.dmAttack(g1, 'scimitar', barrier.id).error ?? '', /can't be attacked|DM PHASE/);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.shaman.id, amount: 20 }));
  ok(w.use('shaman', 'healing-totem', { cell: { x: 7, y: 1 } }));
  w.next();
  w.next(); // player phase: totem pulse (1d4+1 = 2) ; barrier expires (next_dm_phase over)
  assert.equal(w.hero('shaman').hp, 33 - 20 + 8, 'totem pulse 1d4+1 = 2, ×4 Heal (the shaman is a healer)');
  assert.ok(!w.state().entities[barrier.id], 'barrier expired');
  w.next();
  w.next(); // second pulse, then the totem is gone
  assert.equal(w.hero('shaman').hp, 33 - 20 + 16);
  assert.ok(!Object.values(w.state().entities).some((e) => e.name === 'Healing Totem'));

  // Narrative: the roll shows in the feed.
  ok(w.use('druid', 'speak-with-animals'));
  assert.match(w.last(), /rolls 1d20\+4/);
});

test('effects persist through a server restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dne-fx-'));
  try {
    const dbFile = join(dir, 'db.sqlite');
    const a = makeService({ dbFile });
    const game = a.service.createGame('Persist');
    const tpl = a.templates.create({ name: 'R', grid: { cols: 5, rows: 5 } });
    const p = ok(a.service.dispatch(game.id, { role: 'join' }, { type: 'player.create', name: 'Ana' }));
    const actor = { role: 'player', playerId: p.playerId };
    ok(a.service.dispatch(game.id, actor, { type: 'player.selectCharacter', characterId: 'x-shieldmarshal' }));
    const sid = ok(a.service.dispatch(game.id, DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
    ok(a.service.dispatch(game.id, DM, { type: 'scene.activate', sceneId: sid }));
    const eid = a.service.get(game.id).state.players[p.playerId].entityId;
    ok(a.service.dispatch(game.id, actor, { type: 'ability', entityId: eid, abilityId: 'shield-wall' }));
    a.service.close();
    a.db.close();
    const b = makeService({ dbFile });
    const e = b.service.get(game.id).state.entities[eid];
    assert.equal(e.effects[0].label, 'Shield Wall');
    ok(b.service.dispatch(game.id, DM, { type: 'entity.damage', entityId: eid, amount: 20 }));
    assert.equal(b.service.get(game.id).state.entities[eid].hp, 44 - 2);
    b.service.close();
    b.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DM can remove effects and add statuses; undo restores effects', () => {
  const w = world([['wall', 'x-shieldmarshal', 0, 0]]);
  ok(w.use('wall', 'shield-wall'));
  const fx = w.hero('wall').effects[0];
  ok(w.run(DM, { type: 'effect.remove', entityId: w.h.wall.id, effectId: fx.id }));
  assert.equal(w.hero('wall').effects.length, 0);
  ok(w.run(DM, { type: 'undo' }));
  assert.equal(w.hero('wall').effects.length, 1);
  ok(w.run(DM, { type: 'effect.addStatus', entityId: w.h.wall.id, status: 'snared' }));
  assert.ok(w.hero('wall').effects.some((x) => x.status === 'snared'));
  assert.equal(w.run(w.h.wall.actor, { type: 'effect.remove', entityId: w.h.wall.id, effectId: fx.id }).error, 'Not allowed');
  // grant_protection by amount, applied directly through the shared store
  addEffect(w.state(), w.hero('wall'), { type: 'grant_protection', label: 'Test', params: { amount: 3 } });
});

after(() => {
  const missing = EFFECT_TYPES.filter((t) => !handlerCalls.get(t));
  assert.deepEqual(missing, [], `effect types never exercised: ${missing.join(', ')}`);
});

test('Slowed from an ability (apply_status) costs 2 movement, same as the DM status, and expires', () => {
  const w = world([['rog', 'shadow-rogue', 2, 2]]);
  const mummy = w.spawn('mummy', 4, 2);
  const base = movementAllowance(w.hero('rog'));
  w.fight();
  w.next(); // DM phase
  ok(w.run(DM, { type: 'ability', entityId: mummy, abilityId: 'desiccating-curse', targetId: w.h.rog.id })); // 15+5 hits
  assert.ok(w.hero('rog').effects.some((fx) => fx.status === 'slowed'));
  assert.equal(movementAllowance(w.hero('rog')), base - 2);
  w.next(); // player phase: still slowed
  assert.equal(movementAllowance(w.hero('rog')), base - 2);
  w.next(); w.next(); // through the next DM phase: expired
  assert.equal(movementAllowance(w.hero('rog')), base);
  ok(w.run(DM, { type: 'effect.addStatus', entityId: w.h.rog.id, status: 'slowed' }));
  assert.equal(movementAllowance(w.hero('rog')), base - 2, 'DM-applied Slowed matches');
});
