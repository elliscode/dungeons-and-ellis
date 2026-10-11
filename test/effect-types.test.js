import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, scriptedRng, ok, DM } from './helpers.js';
import { EFFECT_TYPES } from '../server/games/effects.js';
import { dealDamage } from '../server/games/combat.js';
import { movementAllowance } from '../server/games/status.js';
import { stripMarkers } from '../server/games/helpers.js';

// One suite per ability effect type, each checking the type's mechanic in isolation with
// hand-made abilities. Casters are friendly NPCs and targets are monsters: neither has a role, so
// role strength (DPS/Heal multipliers, Tank reduction) never enters the numbers, and friendly NPCs
// aren't limited by the per-phase action budget.

// Deterministic dice: d20 rolls 10 and every other die rolls 1, unless a test queues values.
const fallback = (sides) => (sides === 20 ? 10 : 1);

// W (caster, 25 HP, DEF 12, move 5) at (2,2); A (ally, 40 HP, DEF 15) at (3,2);
// O (ogre, 59 HP, DEF 11, move 5, 2×2) at (4,2), so A is adjacent to O and W is 2 away.
function arena() {
  const rng = scriptedRng(fallback);
  const s = setup({ rng });
  const tpl = s.templates.create({ name: 'Arena', grid: { cols: 16, rows: 12 } });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const spawn = (defId, x, y, kind = 'monster') => ok(s.run(DM, { type: 'entity.spawn', kind, defId, x, y })).entityId;
  const W = spawn('walky-the-wize', 2, 2, 'npc');
  const A = spawn('mysterious-wizard', 3, 2, 'npc');
  const O = spawn('ogre', 4, 2);
  const ent = (id) => s.state().entities[id];
  return {
    ...s, rng, sid, W, A, O, ent, spawn,
    // Adds a hand-made ability straight onto the entity in the live game state.
    give(id, abilityId, effects, extra = {}) {
      const e = ent(id);
      e.abilities = [...(e.abilities ?? []).filter((a) => a.id !== abilityId), { id: abilityId, name: abilityId, range: 10, effects, ...extra }];
    },
    use: (id, abilityId, extra = {}) => s.run(DM, { type: 'ability', entityId: id, abilityId, ...extra }),
    rock: (targetId) => s.run(DM, { type: 'attack', entityId: O, attackId: 'rock', targetId }), // ogre: 1d20+6, 2d6+4, range 8
    dmg: (id, amount) => ok(s.run(DM, { type: 'entity.damage', entityId: id, amount })),
    fight: () => ok(s.run(DM, { type: 'combat.start' })),
    next: () => ok(s.run(DM, { type: 'combat.advance' })),
    extra: (id) => ok(s.run(DM, { type: 'entity.grantAction', entityId: id })),
    last: (role = 'dm') => stripMarkers(s.service.history(s.game.id, role).feed.at(-1).text),
    has: (id, pred) => (ent(id).effects ?? []).some(pred),
  };
}

const HIT = { type: 'attack', target: 'enemy', attack: '1d20+10', damage: '1d4' }; // always hits the ogre for 1 by default

const covered = new Set();
function suite(type, fn) {
  covered.add(type);
  describe(type, fn);
}

after(() => {
  const missing = EFFECT_TYPES.filter((t) => !covered.has(t));
  assert.deepEqual(missing, [], `effect types without a suite: ${missing.join(', ')}`);
});

suite('attack', () => {
  test('a hit deals the rolled damage; a miss deals nothing', () => {
    const w = arena();
    w.give(w.W, 'bolt', [{ type: 'attack', target: 'enemy', attack: '1d20', damage: '2d6' }]);
    w.fight();
    w.rng.push(12, 3, 4); // 12 vs DEF 11; 3+4
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].dealt, 7);
    assert.equal(w.ent(w.O).hp, 52);
    w.rng.push(5);
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, false);
    assert.equal(w.ent(w.O).hp, 52);
  });

  test('natural 20 doubles the dice; natural 1 misses even with a huge bonus', () => {
    const w = arena();
    w.give(w.W, 'bolt', [{ type: 'attack', target: 'enemy', attack: '1d20+30', damage: '2d6' }]);
    w.fight();
    w.rng.push(20, 1, 1, 1, 1); // crit: 4d6
    const r = ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0];
    assert.deepEqual([r.crit, r.dealt], [true, 4]);
    w.rng.push(1);
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, false);
  });

  test('attackBonus, damageBonus and defenseReduction apply exactly', () => {
    const w = arena();
    w.give(w.W, 'bonus', [{ type: 'attack', target: 'enemy', attack: '1d20', damage: '1d4', attackBonus: 2, damageBonus: 5 }]);
    w.give(w.W, 'pierce', [{ type: 'attack', target: 'enemy', attack: '1d20', damage: '1d4', defenseReduction: 3 }]);
    w.fight();
    w.rng.push(9); // 9 + 2 = 11 vs 11
    assert.equal(ok(w.use(w.W, 'bonus', { targetId: w.O })).strikes[0].dealt, 6);
    w.rng.push(8); // 8 vs 11 − 3
    assert.equal(ok(w.use(w.W, 'pierce', { targetId: w.O })).strikes[0].hit, true);
    w.rng.push(7);
    assert.equal(ok(w.use(w.W, 'pierce', { targetId: w.O })).strikes[0].hit, false);
  });

  test('damaging abilities are combat-only', () => {
    const w = arena();
    w.give(w.W, 'bolt', [HIT]);
    assert.match(w.use(w.W, 'bolt', { targetId: w.O }).error, /only available in combat/);
  });

  test('when: attack_hits / attack_misses follow-ups fire only on that outcome', () => {
    const w = arena();
    w.dmg(w.W, 10);
    w.give(w.W, 'drain', [
      { type: 'attack', target: 'enemy', attack: '1d20', damage: '1d4' },
      { type: 'heal', target: 'self', heal: '1d4+4', when: 'attack_hits' },
      { type: 'apply_status', target: 'self', status: 'shaken', when: 'attack_misses' },
    ]);
    w.fight();
    w.rng.push(12);
    ok(w.use(w.W, 'drain', { targetId: w.O }));
    assert.equal(w.ent(w.W).hp, 20, 'hit: healed 5');
    assert.ok(!w.has(w.W, (fx) => fx.status === 'shaken'));
    w.rng.push(2);
    ok(w.use(w.W, 'drain', { targetId: w.O }));
    assert.equal(w.ent(w.W).hp, 20, 'miss: no heal');
    assert.ok(w.has(w.W, (fx) => fx.status === 'shaken'));
  });
});

suite('multi_attack', () => {
  test('each strike rolls to hit and for damage on its own', () => {
    const w = arena();
    w.give(w.W, 'flurry', [{ type: 'multi_attack', target: 'enemy', attack: '1d20', damage: '1d4', count: 3 }]);
    w.fight();
    w.rng.push(12, 2, 5, 12, 3);
    const r = ok(w.use(w.W, 'flurry', { targetId: w.O }));
    assert.deepEqual(r.strikes.map((s) => s.hit), [true, false, true]);
    assert.deepEqual(r.strikes.map((s) => s.dealt), [2, 0, 3]);
    assert.equal(w.ent(w.O).hp, 54);
  });

  test('remaining strikes stop once the target dies', () => {
    const w = arena();
    const gob = w.spawn('goblin', 1, 2);
    w.give(w.W, 'flurry', [{ type: 'multi_attack', target: 'enemy', attack: '1d20+10', damage: '1d4+10', count: 3 }]);
    w.fight();
    const r = ok(w.use(w.W, 'flurry', { targetId: gob }));
    assert.equal(r.strikes.length, 1);
    assert.equal(w.ent(gob).status, 'dead');
  });
});

suite('area_attack', () => {
  test('centered on the caster: enemies within the radius are hit; allies and far enemies are not', () => {
    const w = arena();
    const g1 = w.spawn('goblin', 1, 1), g2 = w.spawn('goblin', 2, 3);
    w.give(w.W, 'nova', [{ type: 'area_attack', attack: '1d20+10', damage: '1d4+20', radius: 1 }]);
    w.fight();
    const r = ok(w.use(w.W, 'nova'));
    assert.equal(r.strikes.length, 2);
    assert.equal(w.ent(g1).status, 'dead');
    assert.equal(w.ent(g2).status, 'dead');
    assert.equal(w.ent(w.O).hp, 59, 'ogre is 2 away');
    assert.equal(w.ent(w.A).hp, 40, 'ally untouched');
  });

  test('center: target puts the area on the chosen enemy', () => {
    const w = arena();
    const gob = w.spawn('goblin', 6, 2); // next to the ogre, far from the caster
    w.give(w.W, 'meteor', [{ type: 'area_attack', attack: '1d20+10', damage: '1d4', radius: 1, center: 'target', range: 10 }]);
    w.fight();
    ok(w.use(w.W, 'meteor', { targetId: w.O }));
    assert.equal(w.ent(w.O).hp, 58);
    assert.equal(w.ent(gob).hp, 8);
    assert.equal(w.ent(w.A).hp, 40, 'ally next to the ogre is untouched');
  });
});

suite('chain_attack', () => {
  test('each link gets its own strike; bad picks are refused', () => {
    const w = arena();
    const gob = w.spawn('goblin', 6, 3), far = w.spawn('goblin', 14, 10);
    w.give(w.W, 'arc', [{ type: 'chain_attack', target: 'enemy', attack: '1d20+10', damage: '1d4', jumps: 1, jumpRange: 3 }]);
    w.fight();
    assert.match(w.use(w.W, 'arc', { targetId: w.O, picks: [w.A] }).error, /not an enemy/);
    assert.match(w.use(w.W, 'arc', { targetId: w.O, picks: [gob, far] }).error, /at most 1/);
    assert.match(w.use(w.W, 'arc', { targetId: w.O, picks: [far] }).error, /too far/);
    const r = ok(w.use(w.W, 'arc', { targetId: w.O, picks: [gob] }));
    assert.equal(r.strikes.length, 2);
    assert.equal(w.ent(w.O).hp, 58);
    assert.equal(w.ent(gob).hp, 8);
  });
});

suite('heal', () => {
  test('heals the rolled amount, capped at max HP; enemies are refused', () => {
    const w = arena();
    w.give(w.W, 'mend', [{ type: 'heal', target: 'ally_or_self', heal: '1d4+2' }]);
    w.dmg(w.W, 10);
    w.rng.push(3);
    ok(w.use(w.W, 'mend', { targetId: w.W }));
    assert.equal(w.ent(w.W).hp, 20);
    w.rng.push(4);
    ok(w.use(w.W, 'mend', { targetId: w.W }));
    assert.equal(w.ent(w.W).hp, 25, 'capped');
    assert.match(w.use(w.W, 'mend', { targetId: w.O }).error, /not an ally/);
  });

  test('a downed creature at negative HP heals onto the negative number', () => {
    const w = arena();
    w.give(w.W, 'mend', [{ type: 'heal', target: 'ally_or_self', heal: '1d4+2' }]);
    w.dmg(w.A, 45);
    assert.deepEqual([w.ent(w.A).status, w.ent(w.A).hp], ['down', -5]);
    ok(w.use(w.W, 'mend', { targetId: w.A }));
    assert.deepEqual([w.ent(w.A).status, w.ent(w.A).hp], ['down', -2]);
  });
});

suite('chain_heal', () => {
  test('every link heals; an unwounded NPC is a wasted jump; enemies are refused', () => {
    const w = arena();
    w.give(w.W, 'wave', [{ type: 'chain_heal', target: 'ally_or_self', heal: '1d4+2', jumps: 1, jumpRange: 3 }]);
    w.dmg(w.W, 10);
    w.dmg(w.A, 10);
    ok(w.use(w.W, 'wave', { targetId: w.A, picks: [w.W] }));
    assert.deepEqual([w.ent(w.A).hp, w.ent(w.W).hp], [33, 18]);
    w.dmg(w.W, 3);
    ok(w.run(DM, { type: 'entity.setHp', entityId: w.A, hp: 40 }));
    ok(w.use(w.W, 'wave', { targetId: w.W, picks: [w.A] }));
    assert.deepEqual([w.ent(w.W).hp, w.ent(w.A).hp], [18, 40]);
    assert.match(w.use(w.W, 'wave', { targetId: w.W, picks: [w.O] }).error, /not an ally/);
  });
});

suite('modify_healing', () => {
  test("adds to the caster's next heal on that target, then is used up; other healers don't use it", () => {
    const w = arena();
    w.give(w.W, 'beacon', [{ type: 'modify_healing', target: 'ally', amount: 3 }]);
    w.give(w.W, 'mend', [{ type: 'heal', target: 'ally_or_self', heal: '1d4+2' }]);
    w.give(w.A, 'mend', [{ type: 'heal', target: 'ally_or_self', heal: '1d4+2' }]);
    w.dmg(w.A, 20);
    ok(w.use(w.W, 'beacon', { targetId: w.A }));
    ok(w.use(w.A, 'mend', { targetId: w.A }));
    assert.equal(w.ent(w.A).hp, 23, 'own heal: no bonus');
    assert.ok(w.has(w.A, (fx) => fx.type === 'modify_healing'));
    ok(w.use(w.W, 'mend', { targetId: w.A }));
    assert.equal(w.ent(w.A).hp, 29, '3 + 3');
    assert.ok(!w.has(w.A, (fx) => fx.type === 'modify_healing'));
    ok(w.use(w.W, 'mend', { targetId: w.A }));
    assert.equal(w.ent(w.A).hp, 32);
  });

  test('recasting refreshes the bonus instead of stacking it', () => {
    const w = arena();
    w.give(w.W, 'beacon', [{ type: 'modify_healing', target: 'ally', amount: 3 }]);
    w.give(w.W, 'mend', [{ type: 'heal', target: 'ally_or_self', heal: '1d4+2' }]);
    w.dmg(w.A, 20);
    for (let i = 0; i < 3; i++) ok(w.use(w.W, 'beacon', { targetId: w.A }));
    assert.equal(w.ent(w.A).effects.filter((fx) => fx.type === 'modify_healing').length, 1);
    ok(w.use(w.W, 'mend', { targetId: w.A }));
    assert.equal(w.ent(w.A).hp, 26, '3 + 3, not 3 + 9');
  });
});

suite('grant_protection', () => {
  test('default halves the next hit, once', () => {
    const w = arena();
    w.give(w.W, 'guard', [{ type: 'grant_protection' }]);
    ok(w.use(w.W, 'guard'));
    w.dmg(w.W, 10);
    assert.equal(w.ent(w.W).hp, 20);
    w.dmg(w.W, 10);
    assert.equal(w.ent(w.W).hp, 10);
  });

  test('a flat amount subtracts from the hit', () => {
    const w = arena();
    w.give(w.W, 'guard', [{ type: 'grant_protection', amount: 4 }]);
    ok(w.use(w.W, 'guard'));
    w.dmg(w.W, 10);
    assert.equal(w.ent(w.W).hp, 19);
  });

  test('magicalOnly ignores physical damage', () => {
    const w = arena();
    w.give(w.W, 'ward', [{ type: 'grant_protection', magicalOnly: true }]);
    ok(w.use(w.W, 'ward'));
    const ctx = { state: w.state(), rng: w.rng, fx() {} };
    assert.equal(dealDamage(ctx, { target: w.ent(w.W), raw: 10 }).dealt, 10, 'physical');
    assert.equal(dealDamage(ctx, { target: w.ent(w.W), raw: 10, damageType: 'fire' }).dealt, 5, 'magical');
    assert.equal(dealDamage(ctx, { target: w.ent(w.W), raw: 10, damageType: 'fire' }).dealt, 10, 'used up');
  });
});

suite('absorb_next_hit', () => {
  test('the next hit does nothing, the one after lands in full', () => {
    const w = arena();
    w.give(w.W, 'ice', [{ type: 'absorb_next_hit' }]);
    ok(w.use(w.W, 'ice'));
    w.dmg(w.W, 10);
    assert.equal(w.ent(w.W).hp, 25);
    w.dmg(w.W, 10);
    assert.equal(w.ent(w.W).hp, 15);
  });
});

suite('redirect_next_hit', () => {
  test("the ally's next hit lands on the caster, once; can't target self", () => {
    const w = arena();
    w.give(w.W, 'cover', [{ type: 'redirect_next_hit' }]);
    assert.match(w.use(w.W, 'cover', { targetId: w.W }).error, /must target an ally/);
    ok(w.use(w.W, 'cover', { targetId: w.A }));
    w.dmg(w.A, 6);
    assert.deepEqual([w.ent(w.A).hp, w.ent(w.W).hp], [40, 19]);
    w.dmg(w.A, 6);
    assert.deepEqual([w.ent(w.A).hp, w.ent(w.W).hp], [34, 19]);
  });
});

suite('defense_bonus', () => {
  test('+3 Defense until the next PLAYER PHASE', () => {
    const w = arena();
    w.give(w.W, 'brace', [{ type: 'defense_bonus', amount: 3 }]);
    w.fight();
    ok(w.use(w.W, 'brace'));
    w.next(); // DM phase
    w.rng.push(7); // 13 vs 12 + 3
    assert.equal(ok(w.rock(w.W)).hit, false);
    w.extra(w.O);
    w.rng.push(9); // 15 vs 15
    assert.equal(ok(w.rock(w.W)).hit, true);
    w.next();
    assert.ok(!w.has(w.W, (fx) => fx.type === 'defense_bonus'), 'expired at the PLAYER PHASE');
  });

  test('next_attack_against_self is used up by one attack', () => {
    const w = arena();
    w.give(w.W, 'parry', [{ type: 'defense_bonus', amount: 3, trigger: 'next_attack_against_self' }]);
    w.fight();
    ok(w.use(w.W, 'parry'));
    w.next();
    w.rng.push(7);
    assert.equal(ok(w.rock(w.W)).hit, false);
    w.extra(w.O);
    w.rng.push(7); // 13 vs plain 12
    assert.equal(ok(w.rock(w.W)).hit, true);
  });

  test('radius: the caster and allies nearby, not enemies', () => {
    const w = arena();
    w.give(w.W, 'aura', [{ type: 'defense_bonus', amount: 2, radius: 2 }]);
    ok(w.use(w.W, 'aura'));
    for (const id of [w.W, w.A]) assert.ok(w.has(id, (fx) => fx.type === 'defense_bonus'));
    assert.ok(!w.has(w.O, (fx) => fx.type === 'defense_bonus'));
  });

  test('a negative amount on an enemy lowers its Defense', () => {
    const w = arena();
    w.give(w.W, 'expose', [{ type: 'defense_bonus', target: 'enemy', amount: -3 }]);
    w.give(w.W, 'bolt', [{ type: 'attack', target: 'enemy', attack: '1d20', damage: '1d4' }]);
    w.fight();
    ok(w.use(w.W, 'expose', { targetId: w.O }));
    w.rng.push(8); // 8 vs 11 − 3
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, true);
  });
});

suite('modify_damage_received', () => {
  test('+2 on every hit for the duration, then expires', () => {
    const w = arena();
    w.give(w.W, 'brittle', [{ type: 'modify_damage_received', target: 'enemy', amount: 2 }]);
    w.fight();
    ok(w.use(w.W, 'brittle', { targetId: w.O }));
    w.dmg(w.O, 1);
    w.dmg(w.O, 1);
    assert.equal(w.ent(w.O).hp, 53, 'not used up');
    w.next();
    assert.ok(w.has(w.O, (fx) => fx.type === 'modify_damage_received'), 'through the DM phase');
    w.next();
    assert.ok(!w.has(w.O, (fx) => fx.type === 'modify_damage_received'), 'gone after it');
  });

  test('multiplier doubles; a negative amount reduces', () => {
    const w = arena();
    w.give(w.W, 'doom', [{ type: 'modify_damage_received', target: 'enemy', multiplier: 2 }]);
    w.give(w.W, 'skin', [{ type: 'modify_damage_received', amount: -3 }]);
    ok(w.use(w.W, 'doom', { targetId: w.O }));
    w.dmg(w.O, 5);
    assert.equal(w.ent(w.O).hp, 49);
    ok(w.use(w.W, 'skin'));
    w.dmg(w.W, 5);
    assert.equal(w.ent(w.W).hp, 23);
  });
});

suite('modify_damage_dealt', () => {
  test("changes only the caster's next hit", () => {
    const w = arena();
    w.give(w.W, 'weak', [{ type: 'modify_damage_dealt', multiplier: 0.5 }]);
    w.give(w.W, 'fury', [{ type: 'modify_damage_dealt', amount: 3 }]);
    w.give(w.W, 'bolt', [{ type: 'attack', target: 'enemy', attack: '1d20+10', damage: '1d4+9' }]); // 10
    w.fight();
    ok(w.use(w.W, 'weak'));
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].dealt, 5);
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].dealt, 10);
    ok(w.use(w.W, 'fury'));
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].dealt, 13);
    assert.equal(w.ent(w.O).hp, 59 - 5 - 10 - 13);
  });

  test("on an enemy: halves that enemy's next hit", () => {
    const w = arena();
    w.give(w.W, 'curse', [{ type: 'modify_damage_dealt', target: 'enemy', multiplier: 0.5 }]);
    w.fight();
    ok(w.use(w.W, 'curse', { targetId: w.O }));
    w.next();
    w.rng.push(15, 3, 3); // 2d6+4 = 10
    assert.equal(ok(w.rock(w.W)).damage, 5);
  });
});

suite('modify_movement', () => {
  test('+2, −2 (Slowed), stacking, floor at 0', () => {
    const w = arena();
    w.give(w.W, 'haste', [{ type: 'modify_movement', amount: 2 }]);
    w.give(w.W, 'slow', [{ type: 'modify_movement', target: 'enemy', amount: -2 }]);
    w.give(w.W, 'freeze', [{ type: 'modify_movement', target: 'enemy', amount: -20 }]);
    ok(w.use(w.W, 'haste'));
    assert.equal(movementAllowance(w.ent(w.W)), 7);
    ok(w.use(w.W, 'slow', { targetId: w.O }));
    assert.equal(movementAllowance(w.ent(w.O)), 3);
    assert.ok(w.has(w.O, (fx) => fx.status === 'slowed'));
    ok(w.use(w.W, 'slow', { targetId: w.O }));
    assert.equal(movementAllowance(w.ent(w.O)), 1);
    ok(w.use(w.W, 'freeze', { targetId: w.O }));
    assert.equal(movementAllowance(w.ent(w.O)), 0);
  });

  test('enemy moves are limited to the reduced movement', () => {
    const w = arena();
    w.give(w.W, 'slow', [{ type: 'modify_movement', target: 'enemy', amount: -2 }]);
    w.fight();
    ok(w.use(w.W, 'slow', { targetId: w.O }));
    w.next();
    assert.match(w.run(DM, { type: 'move', entityId: w.O, x: 8, y: 2 }).error, /3 squares left/);
    ok(w.run(DM, { type: 'move', entityId: w.O, x: 7, y: 2 }));
  });
});

suite('taunt', () => {
  test('a taunted enemy must attack the taunter, until the taunter dies', () => {
    const w = arena();
    w.give(w.W, 'taunt', [{ type: 'taunt', target: 'enemy' }]);
    w.fight();
    ok(w.use(w.W, 'taunt', { targetId: w.O }));
    w.next();
    assert.match(w.rock(w.A).error, /taunted by/);
    w.rng.push(1);
    ok(w.rock(w.W));
    ok(w.run(DM, { type: 'entity.kill', entityId: w.W }));
    w.extra(w.O);
    w.rng.push(1);
    ok(w.rock(w.A), 'taunter dead: free to attack anyone');
  });

  test('radius: every enemy in range is taunted', () => {
    const w = arena();
    const gob = w.spawn('goblin', 2, 4), dragon = w.spawn('dragon', 10, 8);
    w.give(w.W, 'roar', [{ type: 'taunt', target: 'self', radius: 2 }]);
    ok(w.use(w.W, 'roar'));
    assert.ok(w.has(w.O, (fx) => fx.type === 'taunt'));
    assert.ok(w.has(gob, (fx) => fx.type === 'taunt'));
    assert.ok(!w.has(dragon, (fx) => fx.type === 'taunt'));
    assert.ok(!w.has(w.A, (fx) => fx.type === 'taunt'), 'allies are never taunted');
  });
});

suite('reduce_actions', () => {
  test('the enemy loses its action in the next DM PHASE, then gets it back', () => {
    const w = arena();
    w.give(w.W, 'stun', [{ type: 'reduce_actions', target: 'enemy', amount: 1 }]);
    w.fight();
    ok(w.use(w.W, 'stun', { targetId: w.O }));
    w.next();
    assert.match(w.rock(w.W).error, /no actions left/);
    w.extra(w.O);
    w.rng.push(1);
    ok(w.rock(w.W), 'a granted action still works');
    w.next();
    w.next(); // the following DM phase
    w.rng.push(1);
    ok(w.rock(w.W));
  });
});

suite('mark_target', () => {
  test("the caster's next hit adds the bonus die and uses the mark; others don't", () => {
    const w = arena();
    w.give(w.W, 'mark', [{ type: 'mark_target', target: 'enemy', bonus: '1d6' }]);
    w.give(w.W, 'bolt', [HIT]);
    w.give(w.A, 'bolt', [HIT]);
    w.fight();
    ok(w.use(w.W, 'mark', { targetId: w.O }));
    w.rng.push(10, 2);
    assert.equal(ok(w.use(w.A, 'bolt', { targetId: w.O })).strikes[0].dealt, 2, "another caster's hit: no bonus");
    assert.ok(w.has(w.O, (fx) => fx.type === 'mark_target'));
    w.rng.push(10, 2, 5);
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].dealt, 7);
    assert.ok(!w.has(w.O, (fx) => fx.type === 'mark_target'));
    w.rng.push(10, 2);
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].dealt, 2);
  });
});

suite('grant_roll_bonus', () => {
  test('a flat or dice bonus applies to one attack roll, then is used up', () => {
    const w = arena();
    w.give(w.W, 'bless', [{ type: 'grant_roll_bonus', bonus: 5 }]);
    w.give(w.W, 'luck', [{ type: 'grant_roll_bonus', bonus: '1d4' }]);
    w.give(w.W, 'bolt', [{ type: 'attack', target: 'enemy', attack: '1d20', damage: '1d4' }]);
    w.fight();
    ok(w.use(w.W, 'bless', { targetId: w.W }));
    w.rng.push(6); // 6 + 5 = 11
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, true);
    w.rng.push(6);
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, false, 'used up');
    ok(w.use(w.W, 'luck', { targetId: w.W }));
    w.rng.push(4, 7); // bonus d4 rolls first: 7 + 4 = 11
    assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, true);
  });
});

suite('apply_status', () => {
  for (const status of ['poisoned', 'shaken']) {
    test(`${status}: exactly −2 to hit`, () => {
      const w = arena();
      w.give(w.W, 'sick', [{ type: 'apply_status', target: 'self', status }]);
      w.give(w.W, 'bolt', [{ type: 'attack', target: 'enemy', attack: '1d20', damage: '1d4' }]);
      w.fight();
      ok(w.use(w.W, 'sick'));
      w.rng.push(12); // 10 vs 11
      assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, false);
      w.rng.push(13); // 11 vs 11
      assert.equal(ok(w.use(w.W, 'bolt', { targetId: w.O })).strikes[0].hit, true);
    });
  }

  test('snared: 0 movement; slowed: −2 movement', () => {
    const w = arena();
    const gob = w.spawn('goblin', 1, 2);
    w.give(w.W, 'snare', [{ type: 'apply_status', target: 'enemy', status: 'snared' }]);
    w.give(w.W, 'slow', [{ type: 'apply_status', target: 'enemy', status: 'slowed' }]);
    ok(w.use(w.W, 'snare', { targetId: w.O }));
    assert.equal(movementAllowance(w.ent(w.O)), 0);
    ok(w.use(w.W, 'slow', { targetId: gob }));
    assert.equal(movementAllowance(w.ent(gob)), 4);
  });

  test("frightened: can't move closer to the source, can move away", () => {
    const w = arena();
    w.give(w.W, 'fear', [{ type: 'apply_status', target: 'enemy', status: 'frightened' }]);
    w.fight();
    ok(w.use(w.W, 'fear', { targetId: w.O }));
    w.next();
    assert.match(w.run(DM, { type: 'move', entityId: w.O, x: 3, y: 3 }).error, /frightened/);
    ok(w.run(DM, { type: 'move', entityId: w.O, x: 6, y: 2 }));
  });

  test('lasts through the next DM PHASE', () => {
    const w = arena();
    w.give(w.W, 'snare', [{ type: 'apply_status', target: 'enemy', status: 'snared' }]);
    w.fight();
    ok(w.use(w.W, 'snare', { targetId: w.O }));
    w.next();
    assert.ok(w.has(w.O, (fx) => fx.status === 'snared'));
    w.next();
    assert.ok(!w.has(w.O, (fx) => fx.status === 'snared'));
  });
});

suite('remove_status', () => {
  test('removes the status (and its mechanics); says so when there was nothing to remove', () => {
    const w = arena();
    w.give(w.W, 'sick', [{ type: 'apply_status', target: 'self', status: 'poisoned' }]);
    w.give(w.W, 'cure', [{ type: 'remove_status', status: 'poisoned' }]);
    w.give(w.W, 'slow', [{ type: 'apply_status', target: 'self', status: 'slowed' }]);
    w.give(w.W, 'unslow', [{ type: 'remove_status', status: 'slowed' }]);
    ok(w.use(w.W, 'sick'));
    ok(w.use(w.W, 'cure', { targetId: w.W }));
    assert.ok(!w.has(w.W, (fx) => fx.status === 'poisoned'));
    ok(w.use(w.W, 'cure', { targetId: w.W }));
    assert.match(w.last(), /wasn't poisoned/);
    ok(w.use(w.W, 'slow'));
    assert.equal(movementAllowance(w.ent(w.W)), 3);
    ok(w.use(w.W, 'unslow', { targetId: w.W }));
    assert.equal(movementAllowance(w.ent(w.W)), 5);
  });
});

suite('discourage_attacks', () => {
  test('attacks on the protected ally take −5 by default', () => {
    const w = arena();
    w.give(w.W, 'sanctuary', [{ type: 'discourage_attacks' }]);
    w.fight();
    ok(w.use(w.W, 'sanctuary', { targetId: w.A }));
    w.next();
    w.rng.push(13); // 19 − 5 = 14 vs 15
    assert.equal(ok(w.rock(w.A)).hit, false);
    w.extra(w.O);
    w.rng.push(14); // 20 − 5 = 15 vs 15
    assert.equal(ok(w.rock(w.A)).hit, true);
  });
});

suite('grant_actions', () => {
  test('grants extra actions in combat; does nothing outside it', () => {
    const w = arena();
    w.give(w.O, 'rally', [{ type: 'grant_actions', amount: 1 }], { actionCost: 0, usesPerPhase: 1 });
    ok(w.use(w.O, 'rally'));
    assert.match(w.last(), /extra actions only matter in combat/);
    w.fight();
    w.next();
    ok(w.use(w.O, 'rally'));
    w.rng.push(1, 1);
    ok(w.rock(w.W));
    ok(w.rock(w.W), 'the granted action');
    assert.match(w.rock(w.W).error, /no actions left/);
  });
});

suite('teleport', () => {
  test('moves the caster within distance; refuses far or off-map squares', () => {
    const w = arena();
    w.give(w.W, 'blink', [{ type: 'teleport', target: 'cell', distance: 3 }]);
    ok(w.use(w.W, 'blink', { cell: { x: 5, y: 5 } }));
    assert.deepEqual(w.ent(w.W).positions[w.sid], { x: 5, y: 5 });
    assert.match(w.use(w.W, 'blink', { cell: { x: 9, y: 5 } }).error, /out of range/);
    assert.match(w.use(w.W, 'blink', { cell: { x: 99, y: 5 } }).error, /square on the map/);
  });
});

suite('narrative', () => {
  test('logs the roll when there is one, otherwise just the use', () => {
    const w = arena();
    w.give(w.W, 'lore', [{ type: 'narrative', roll: '1d20+4' }]);
    w.give(w.W, 'wave', [{ type: 'narrative' }]);
    ok(w.use(w.W, 'lore'));
    assert.match(w.last(), /lore: rolls 1d20\+4/);
    ok(w.use(w.W, 'wave'));
    assert.equal(w.last(), `${w.ent(w.W).name} uses wave`);
  });
});

suite('create_barrier', () => {
  test("places a temporary object that can't be attacked and is gone after the next DM PHASE", () => {
    const w = arena();
    w.give(w.W, 'wall', [{ type: 'create_barrier', target: 'cell', range: 2, duration: 'next_dm_phase' }]);
    w.fight();
    ok(w.use(w.W, 'wall', { cell: { x: 2, y: 4 } }));
    const barrier = Object.values(w.state().entities).find((e) => e.name === 'Barrier');
    assert.deepEqual([barrier.kind, barrier.temporary, barrier.positions[w.sid]], ['object', true, { x: 2, y: 4 }]);
    assert.match(w.run(DM, { type: 'entity.damage', entityId: barrier.id, amount: 5 }).error, /object/);
    w.next();
    assert.match(w.rock(barrier.id).error, /can't be attacked/);
    assert.ok(w.ent(barrier.id), 'still up during the DM phase');
    w.next();
    assert.equal(w.ent(barrier.id), undefined, 'gone');
  });
});

suite('healing_aura', () => {
  test('pulses at each PLAYER PHASE for allies in range only, then disappears', () => {
    const w = arena();
    w.give(w.W, 'totem', [{ type: 'healing_aura', target: 'cell', heal: '1d4', radius: 2, pulses: 2, range: 2 }]);
    for (const id of [w.W, w.A, w.O]) w.dmg(id, 10);
    w.fight();
    ok(w.use(w.W, 'totem', { cell: { x: 2, y: 3 } }));
    w.next();
    w.next(); // player phase: pulse 1
    assert.deepEqual([w.ent(w.W).hp, w.ent(w.A).hp, w.ent(w.O).hp], [16, 31, 49]);
    w.next();
    w.next(); // pulse 2
    assert.deepEqual([w.ent(w.W).hp, w.ent(w.A).hp, w.ent(w.O).hp], [17, 32, 49]);
    assert.ok(!Object.values(w.state().entities).some((e) => e.name === 'Healing Totem'));
  });
});

suite('roll_to_apply', () => {
  const effects = [{
    type: 'roll_to_apply', target: 'enemy', roll: '1d20',
    onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'snared' }],
    onFailure: [{ type: 'apply_status', target: 'checked_enemy', status: 'slowed' }],
  }];

  test('success applies onSuccess, failure applies onFailure; the feed marks the outcome', () => {
    const w = arena();
    const gob = w.spawn('goblin', 1, 2);
    w.give(w.W, 'vines', effects);
    w.rng.push(12); // vs ogre DEF 11
    ok(w.use(w.W, 'vines', { targetId: w.O }));
    assert.ok(w.has(w.O, (fx) => fx.status === 'snared'));
    assert.match(w.service.history(w.game.id, 'player').feed.at(-1).text, /SUCCESS/);
    w.rng.push(5); // vs goblin DEF 13
    ok(w.use(w.W, 'vines', { targetId: gob }));
    assert.ok(w.has(gob, (fx) => fx.status === 'slowed'));
    assert.ok(!w.has(gob, (fx) => fx.status === 'snared'));
    assert.match(w.service.history(w.game.id, 'player').feed.at(-1).text, /RESISTED/);
  });

  test('radius: one roll per enemy in the area', () => {
    const w = arena();
    const gob = w.spawn('goblin', 2, 4), dragon = w.spawn('dragon', 10, 8);
    w.give(w.W, 'quake', [{ ...effects[0], target: 'enemies_in_area', radius: 2 }]); // as the real data writes it
    w.rng.push(1, 15); // sorted by distance then name: Goblin resists, Ogre fails to resist
    ok(w.use(w.W, 'quake'));
    assert.ok(w.has(gob, (fx) => fx.status === 'slowed'));
    assert.ok(w.has(w.O, (fx) => fx.status === 'snared'));
    assert.equal(w.ent(dragon).effects.length, 0);
  });
});

suite('dm_check', () => {
  test('creates a pending check; the DM call runs onSuccess or onFailure, once', () => {
    const w = arena();
    w.give(w.W, 'roar', [{
      type: 'dm_check', target: 'enemy', roll: '1d20',
      onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'frightened' }],
      onFailure: [{ type: 'apply_status', target: 'checked_enemy', status: 'shaken' }],
    }]);
    ok(w.use(w.W, 'roar', { targetId: w.O }));
    const [chk] = w.state().pendingChecks;
    assert.equal(chk.subjectId, w.O);
    assert.equal(w.ent(w.O).effects.length, 0, 'nothing happens until the DM decides');
    ok(w.run(DM, { type: 'check.resolve', checkId: chk.id, success: false }));
    assert.ok(w.has(w.O, (fx) => fx.status === 'shaken'));
    assert.ok(!w.has(w.O, (fx) => fx.status === 'frightened'));
    assert.match(w.run(DM, { type: 'check.resolve', checkId: chk.id, success: true }).error, /already resolved/);
    ok(w.use(w.W, 'roar', { targetId: w.O }));
    ok(w.run(DM, { type: 'check.resolve', checkId: w.state().pendingChecks[0].id, success: true }));
    assert.ok(w.has(w.O, (fx) => fx.status === 'frightened'));
  });
});
