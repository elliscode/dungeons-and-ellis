import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPECS, EFFECT_TYPES, STATUSES, TARGETS, WHEN, validateAbility } from '../core/effects.js';
import { DURATIONS, TRIGGERS } from '../core/status.js';
import { isMagical } from '../core/combat.js';
import { validateDefs } from '../core/content.js';
import { compileSchema, schemaErrors, SCHEMA_PATH } from '../scripts/validate-characters.js';
import { SAMPLES } from './schema-samples.js';

// schemas/character.schema.json is handed to LLMs to generate heroes. These tests keep it in step
// with the effect engine: anything the schema accepts must also pass the server's own validation.

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const validate = compileSchema();
const effectDef = (type) => schema.$defs[`effect_${type}`];

function hero(abilities) {
  return {
    id: 'sample-hero', name: 'Sample Hero', role: 'dps', image: '/static/tokens/token_001.webp',
    maxHp: 30, movement: 6, defense: 14,
    attacks: [{ id: 'dagger', name: 'Dagger', attack: '1d20+5', damage: '1d6+3', range: 1 }],
    abilities: abilities.map(([id, a]) => ({ id, name: id, actionCost: 1, description: `Sample ${id}.`, ...a })),
    inventory: ['healing-potion'],
  };
}

test('schema covers exactly the engine effect types', () => {
  const types = schema.$defs.effect.oneOf.map((r) => r.$ref.replace('#/$defs/effect_', ''));
  assert.deepEqual([...types].sort(), [...EFFECT_TYPES].sort());
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...EFFECT_TYPES].sort());
});

test('schema enums are a subset of what the engine accepts', () => {
  assert.deepEqual([...schema.$defs.status.enum].sort(), Object.keys(STATUSES).sort());
  assert.deepEqual([...schema.$defs.when.enum].sort(), [...WHEN].sort());
  for (const d of schema.$defs.duration.oneOf[0].enum) assert.ok(DURATIONS.includes(d), `duration ${d}`);
  for (const t of schema.$defs.trigger.enum) assert.ok(TRIGGERS.includes(t), `trigger ${t}`);
  for (const dt of schema.$defs.damageType.enum) {
    assert.equal(isMagical(dt), !['slashing', 'piercing', 'bludgeoning'].includes(dt), `damageType ${dt}`);
  }
});

test('each effect definition matches its engine spec', () => {
  for (const type of EFFECT_TYPES) {
    const def = effectDef(type);
    const spec = SPECS[type];
    for (const k of spec.required ?? []) assert.ok(def.required.includes(k), `${type}.${k} should be required`);
    for (const k of spec.dice ?? []) assert.ok(def.properties[k], `${type}.${k} (dice) missing from schema`);
    for (const [k, r] of Object.entries(spec.nums ?? {})) {
      const p = def.properties[k];
      assert.ok(p, `${type}.${k} missing from schema`);
      assert.ok(p.minimum >= r.min && p.maximum <= r.max, `${type}.${k} bounds ${p.minimum}..${p.maximum} exceed engine ${r.min}..${r.max}`);
    }
    for (const [k, vals] of Object.entries(spec.enums ?? {})) {
      const allowed = def.properties[k].enum ?? schema.$defs[def.properties[k].$ref?.split('/').pop()]?.enum;
      for (const v of allowed) assert.ok(vals.includes(v), `${type}.${k} value ${v}`);
    }
    const targets = def.properties.target.enum;
    for (const t of targets) assert.ok(TARGETS.includes(t), `${type} target ${t}`);
    assert.ok(targets.includes(spec.target), `${type} default target ${spec.target} not allowed by schema`);
  }
});

test('one sample of every effect type passes the schema and the engine', () => {
  for (const [type, ability] of Object.entries(SAMPLES)) {
    const def = hero([[type.replaceAll('_', '-'), ability]]);
    assert.deepEqual(schemaErrors(validate, def), [], `${type} schema`);
    assert.deepEqual(validateAbility(def.abilities[0], type), [], `${type} engine`);
  }
  const all = hero(Object.entries(SAMPLES).map(([t, a]) => [t.replaceAll('_', '-'), a]));
  assert.deepEqual(validateDefs('characters', [{ file: 'sample.json', defs: [all] }]).errors, []);
});

test('schema rejects the mistakes the engine rejects', () => {
  const bad = (abilities) => schemaErrors(validate, hero(abilities)).join('\n');
  assert.match(bad([['haste', { range: 0, actionCost: 0, effects: [{ type: 'grant_actions', amount: 1 }] }]]), /usesPerPhase/);
  assert.match(bad([['haste', { range: 0, actionCost: 0, usesPerPhase: 1, effects: [{ type: 'grant_actions', amount: 2 }] }]]), /amount/);
  assert.match(bad([['zap', { range: 6, effects: [{ type: 'attack', attack: '1d20+5', damage: '1d7' }] }]]), /damage/);
  assert.match(bad([['zap', { range: 6, effects: [{ type: 'fireball' }] }]]), /oneOf/);
  assert.match(bad([['zap', { range: 6, effects: [{ type: 'attack', attack: '1d20+5', damage: '1d6', bogus: 1 }] }]]), /bogus/);
  assert.match(bad([['weak', { range: 6, effects: [{ type: 'modify_damage_dealt', target: 'enemy' }] }]]), /amount|multiplier/);
  assert.match(schemaErrors(validate, { ...hero([]), immortal: true }).join('\n'), /immortal/);
});
