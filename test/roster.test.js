import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadContent } from '../server/content.js';
import { EFFECT_TYPES, HANDLED_TYPES, normalizeAbility, targetingOf } from '../server/games/effects.js';
import { ROOT } from './helpers.js';

// The live hero roster in data/characters must use the canonical ability schema.
const content = loadContent(join(ROOT, 'data'));
const abilities = content.characters.flatMap((c) => (c.abilities ?? []).map((a) => ({ hero: c.id, a })));

const walk = (effects, fn) => {
  for (const e of effects ?? []) {
    fn(e);
    walk(e.onSuccess, fn);
    walk(e.onFailure, fn);
  }
};

test('roster loads and every ability is in the canonical schema', () => {
  assert.ok(abilities.length >= 1);
  for (const { hero, a } of abilities) {
    const at = `${hero}/${a.id}`;
    assert.ok(Array.isArray(a.effects) && a.effects.length, `${at} has effects`);
    assert.ok(Number.isInteger(a.actionCost), `${at} has actionCost`);
    for (const legacy of ['attack', 'damage', 'heal', 'roll', 'grantsActions']) assert.equal(a[legacy], undefined, `${at} has no legacy ${legacy}`);
    assert.deepEqual(normalizeAbility(a).effects, a.effects, `${at} is already normalized`);
    assert.ok(['enemy', 'ally', 'cell', 'none'].includes(targetingOf(a).kind));
  }
});

test('every effect type used by the roster has a handler', () => {
  assert.deepEqual([...EFFECT_TYPES].sort(), [...HANDLED_TYPES].sort());
  const used = new Set();
  for (const { a } of abilities) walk(a.effects, (e) => used.add(e.type));
  for (const t of used) assert.ok(HANDLED_TYPES.includes(t), `handler for ${t}`);
});

test('Flurry of Blows is four independent strikes', () => {
  const flurry = abilities.find(({ a }) => a.id === 'flurry-of-blows')?.a;
  if (!flurry) return;
  assert.equal(flurry.effects[0].type, 'multi_attack');
  assert.equal(flurry.effects[0].count, 4);
});
