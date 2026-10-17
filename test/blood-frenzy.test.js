import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, scriptedRng, ok, DM, ROOT } from './helpers.js';
import { validateAbility } from '../core/effects.js';
import { stripMarkers } from '../core/helpers.js';

// Blood Frenzy is Korvath the Scarred's (data/characters/bald.json): "your next hit deals +4
// damage". Tests run on the fixture content, so Korvath's real attacks and abilities are read from
// the roster file and put on a DPS hero in a fixture game.
const korvath = JSON.parse(readFileSync(join(ROOT, 'data', 'characters', 'bald.json'), 'utf8')).find((c) => c.id === 'korvath');
const FRENZY = 'korvath-blood-frenzy';
const AXE = 'korvath-greataxe'; // 1d20+5, 2d6+2, melee

// d20s roll 15 (hits the dummy), every damage die rolls 3: the greataxe always rolls 3+3+2 = 8.
function arena() {
  const rng = scriptedRng((sides) => (sides === 20 ? 15 : 3));
  const s = setup({ rng });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl2.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const actor = s.join('Ana');
  ok(s.run(actor, { type: 'player.selectCharacter', characterId: 'shadow-rogue' })); // a DPS hero
  const id = s.state().players[actor.playerId].entityId;
  s.edit((st) => {
    st.entities[id].attacks = structuredClone(korvath.attacks);
    st.entities[id].abilities = structuredClone(korvath.abilities);
  });
  ok(s.run(DM, { type: 'move', entityId: id, x: 0, y: 0, force: true }));
  const dummy = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 1, y: 0 })).entityId;
  const ent = (eid) => s.state().entities[eid];
  const frenzy = () => s.run(actor, { type: 'ability', entityId: id, abilityId: FRENZY });
  const swing = () => s.run(actor, { type: 'attack', entityId: id, attackId: AXE, targetId: dummy });
  const extra = () => ok(s.run(DM, { type: 'entity.grantAction', entityId: id }));
  const taken = () => ent(dummy).damageTaken;
  const frenzies = () => ent(id).effects.filter((fx) => fx.type === 'modify_damage_dealt').length;
  const last = () => stripMarkers(s.service.history(s.game.id, 'dm').feed.at(-1).text);
  return { ...s, rng, actor, id, dummy, ent, frenzy, swing, extra, taken, frenzies, last };
}

test('Blood Frenzy is defined as a valid +4 next-hit self buff', () => {
  const ab = korvath.abilities.find((a) => a.id === FRENZY);
  assert.ok(ab, 'Korvath has Blood Frenzy');
  assert.deepEqual(validateAbility(ab, FRENZY), []);
  assert.equal(ab.actionCost, 1);
  assert.deepEqual(ab.effects, [{ type: 'modify_damage_dealt', target: 'self', amount: 4, duration: 'until_used' }]);
});

test('the next hit deals +4 (before the DPS multiplier), then the frenzy is used up', () => {
  const w = arena();
  ok(w.run(DM, { type: 'combat.start' }));

  // Baseline: an ordinary greataxe hit (8 rolled, times the DPS role multiplier).
  ok(w.swing());
  const plain = w.taken();
  const mult = plain / 8;
  assert.ok(Number.isInteger(mult) && mult >= 1, `DPS multiplier ${mult}`);

  w.extra();
  ok(w.frenzy());
  assert.equal(w.frenzies(), 1);
  assert.match(w.last(), /uses Blood Frenzy/);

  w.extra();
  const before = w.taken();
  ok(w.swing());
  assert.equal(w.taken() - before, (8 + 4) * mult, '+4 is added to the roll, then multiplied');
  assert.equal(w.frenzies(), 0, 'used up by the hit');

  w.extra();
  const before2 = w.taken();
  ok(w.swing());
  assert.equal(w.taken() - before2, plain, 'only the next hit');
});

test('a miss does not use up the frenzy', () => {
  const w = arena();
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.frenzy());
  w.extra();
  w.rng.push(1); // natural 1: always a miss
  ok(w.swing());
  assert.equal(w.taken(), 0);
  assert.equal(w.frenzies(), 1, 'still waiting for a hit');
  w.extra();
  ok(w.swing());
  assert.equal(w.frenzies(), 0, 'the hit uses it');
});

test('it costs the action in combat, and recasting refreshes rather than stacks', () => {
  const w = arena();
  ok(w.frenzy()); // out of combat: free to use, no action budget
  ok(w.frenzy());
  assert.equal(w.frenzies(), 1, 'same caster, same ability: refreshed, not +8');
  assert.match(w.last(), /is refreshed/);

  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.frenzy());
  assert.match(w.swing().error, /no actions left/, 'Blood Frenzy used the action');
});

test('it lasts until the hit lands, even rounds later (used on one turn, swing on the next)', () => {
  const w = arena();
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.swing());
  const plain = w.taken();
  const mult = plain / 8;

  ok(w.run(DM, { type: 'combat.advance' })); // DM phase
  ok(w.run(DM, { type: 'combat.advance' })); // player phase, round 2
  ok(w.frenzy()); // round 2: use Blood Frenzy (that's the turn's action)
  for (let i = 0; i < 4; i++) ok(w.run(DM, { type: 'combat.advance' })); // two full rounds go by
  assert.equal(w.frenzies(), 1, 'still there on a later turn');
  const before = w.taken();
  ok(w.swing());
  assert.equal(w.taken() - before, (8 + 4) * mult, 'and the next hit gets the +4');
  assert.equal(w.frenzies(), 0);
});

test('used before combat, it is still there once combat starts and rounds pass', () => {
  const w = arena();
  ok(w.frenzy());
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.run(DM, { type: 'combat.advance' }));
  ok(w.run(DM, { type: 'combat.advance' }));
  assert.equal(w.frenzies(), 1);
});

test('damage penalties (curses) still wear off after the next DM phase', () => {
  const w = arena();
  w.edit((st) => st.entities[w.id].abilities.push({ id: 'weaken', name: 'Weaken', actionCost: 1, range: 0, effects: [{ type: 'modify_damage_dealt', target: 'self', multiplier: 0.5 }], description: 'Test penalty.' }));
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.run(w.actor, { type: 'ability', entityId: w.id, abilityId: 'weaken' }));
  assert.equal(w.frenzies(), 1);
  ok(w.run(DM, { type: 'combat.advance' })); // DM phase: still on
  assert.equal(w.frenzies(), 1);
  ok(w.run(DM, { type: 'combat.advance' })); // next player phase: gone
  assert.equal(w.frenzies(), 0);
});

// Cleave is one swing that attacks every enemy within 1 square, each with its own attack and
// damage roll. Blood Frenzy boosts "your next hit", and inside one ability that means every hit the
// ability makes: both enemies get the +4, and the frenzy is used up once the Cleave is done.
test('Blood Frenzy, then Cleave on the next turn: every enemy hit gets the +4', () => {
  const w = arena();
  const dummy2 = ok(w.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 0, y: 1 })).entityId;
  const took = (id) => w.ent(id).damageTaken;
  const cleave = () => ok(w.run(w.actor, { type: 'ability', entityId: w.id, abilityId: 'korvath-cleave' }));
  ok(w.run(DM, { type: 'combat.start' }));

  // Baseline Cleave (1d10+3 rolls 3+3 = 6) on both dummies, to learn the DPS multiplier.
  cleave();
  const plain = took(w.dummy);
  assert.equal(took(dummy2), plain, 'both dummies hit for the same normal damage');
  const mult = plain / 6;

  ok(w.run(DM, { type: 'combat.advance' })); // DM phase
  ok(w.run(DM, { type: 'combat.advance' })); // round 2
  ok(w.frenzy()); // round 2's action: Blood Frenzy
  ok(w.run(DM, { type: 'combat.advance' }));
  ok(w.run(DM, { type: 'combat.advance' })); // round 3: Cleave
  let [a0, b0] = [took(w.dummy), took(dummy2)];
  cleave();
  assert.deepEqual([took(w.dummy) - a0, took(dummy2) - b0], [(6 + 4) * mult, (6 + 4) * mult], 'both enemies got the +4');
  assert.equal(w.frenzies(), 0, 'used up once the Cleave finished');
  assert.match(w.last(), /Training Dummy HIT \d+ \(Blood Frenzy.*Training Dummy 2 HIT \d+ \(Blood Frenzy/, 'the feed shows it on both hits');

  // The next ability is back to normal.
  ok(w.run(DM, { type: 'combat.advance' }));
  ok(w.run(DM, { type: 'combat.advance' }));
  [a0, b0] = [took(w.dummy), took(dummy2)];
  cleave();
  assert.deepEqual([took(w.dummy) - a0, took(dummy2) - b0], [plain, plain]);
});

test('every strike of a multi-attack and every link of a chain gets the boost, then it is used up', () => {
  const w = arena();
  const dummy2 = ok(w.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 2, y: 0 })).entityId;
  w.edit((st) => st.entities[w.id].abilities.push(
    { id: 'flurry', name: 'Flurry', actionCost: 1, range: 1, effects: [{ type: 'multi_attack', target: 'enemy', count: 3, attack: '1d20+5', damage: '1d4+1', range: 1 }], description: 'Test.' },
    { id: 'zap', name: 'Zap', actionCost: 1, range: 4, effects: [{ type: 'chain_attack', target: 'enemy', jumps: 1, jumpRange: 3, attack: '1d20+5', damage: '1d4+1', range: 4 }], description: 'Test.' },
  ));
  const use = (abilityId, extra = {}) => ok(w.run(w.actor, { type: 'ability', entityId: w.id, abilityId, ...extra }));
  ok(w.run(DM, { type: 'combat.start' }));
  use('flurry', { targetId: w.dummy }); // 3 strikes of 1d4+1 = 4 each
  const mult = w.taken() / 12;

  w.extra(); ok(w.frenzy());
  w.extra();
  let before = w.taken();
  use('flurry', { targetId: w.dummy });
  assert.equal(w.taken() - before, 3 * (4 + 4) * mult, 'all 3 strikes got +4');
  assert.equal(w.frenzies(), 0);

  w.extra(); ok(w.frenzy());
  w.extra();
  before = w.taken();
  const before2 = w.ent(dummy2).damageTaken;
  use('zap', { targetId: w.dummy, picks: [dummy2] });
  assert.deepEqual([w.taken() - before, w.ent(dummy2).damageTaken - before2], [(4 + 4) * mult, (4 + 4) * mult], 'both chain links got +4');
  assert.equal(w.frenzies(), 0);
});

test('an ability that misses everything keeps the boost; one hit among misses uses it', () => {
  const w = arena();
  const dummy2 = ok(w.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 0, y: 1 })).entityId;
  const cleave = () => ok(w.run(w.actor, { type: 'ability', entityId: w.id, abilityId: 'korvath-cleave' }));
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.frenzy());
  w.extra();
  w.rng.push(1, 1); // both attack rolls are natural 1s
  cleave();
  assert.equal(w.frenzies(), 1, 'nothing hit: still frenzied');
  w.extra();
  w.rng.push(1); // first enemy missed, second hit
  cleave();
  assert.equal(w.frenzies(), 0, 'the hit used it');
  assert.ok(w.ent(dummy2).damageTaken > 0 && w.taken() === 0);
});
