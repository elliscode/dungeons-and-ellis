import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPECS, EFFECT_TYPES, STATUSES, TARGETS, WHEN, validateAbility } from '../server/games/effects.js';
import { DURATIONS, TRIGGERS } from '../server/games/status.js';
import { isMagical } from '../server/games/combat.js';
import { validateDefs } from '../server/content.js';
import { compileSchema, schemaErrors, SCHEMA_PATH } from '../scripts/validate-characters.js';

// schemas/character.schema.json is handed to LLMs to generate heroes. These tests keep it in step
// with the effect engine: anything the schema accepts must also pass the server's own validation.

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const validate = compileSchema();
const effectDef = (type) => schema.$defs[`effect_${type}`];

// One minimal ability per effect type. Each must pass both the schema and the engine.
const SAMPLES = {
  attack: { range: 6, effects: [{ type: 'attack', target: 'enemy', attack: '1d20+5', damage: '2d8+2', range: 6, damageType: 'fire' }] },
  multi_attack: { range: 1, effects: [{ type: 'multi_attack', count: 3, attack: '1d20+5', damage: '1d6+2', range: 1 }] },
  area_attack: { range: 0, effects: [{ type: 'area_attack', center: 'self', radius: 2, attack: '1d20+4', damage: '1d8+3' }] },
  chain_attack: { range: 8, effects: [{ type: 'chain_attack', jumps: 2, jumpRange: 3, attack: '1d20+5', damage: '2d6', range: 8 }] },
  heal: { range: 0, effects: [{ type: 'heal', target: 'allies_in_area', radius: 2, heal: '1d6+2' }] },
  chain_heal: { range: 6, effects: [{ type: 'chain_heal', heal: '1d8+2', jumps: 1, jumpRange: 3, range: 6 }] },
  modify_healing: { range: 6, effects: [{ type: 'modify_healing', target: 'ally', amount: 3, range: 6 }] },
  grant_protection: { range: 0, effects: [{ type: 'grant_protection', target: 'self', fraction: 0.5 }] },
  absorb_next_hit: { range: 1, effects: [{ type: 'absorb_next_hit', target: 'ally', magicalOnly: true, range: 1 }] },
  redirect_next_hit: { range: 3, effects: [{ type: 'redirect_next_hit', target: 'ally', range: 3 }] },
  defense_bonus: { range: 0, effects: [{ type: 'defense_bonus', amount: 2, radius: 1, duration: 'next_dm_phase' }] },
  modify_damage_received: { range: 0, effects: [{ type: 'modify_damage_received', multiplier: 0.5, duration: { phases: 2 } }] },
  modify_damage_dealt: { range: 6, effects: [{ type: 'modify_damage_dealt', target: 'enemy', multiplier: 0.5, trigger: 'next_hit' }] },
  modify_movement: { range: 0, usesPerPhase: 1, actionCost: 0, effects: [{ type: 'modify_movement', amount: 3, duration: 'current_turn' }] },
  taunt: { range: 0, effects: [{ type: 'taunt', radius: 2 }] },
  reduce_actions: { range: 1, effects: [{ type: 'attack', attack: '1d20+5', damage: '1d6', range: 1 }, { type: 'reduce_actions', target: 'hit_enemies', amount: 1, when: 'attack_hits' }] },
  mark_target: { range: 10, effects: [{ type: 'mark_target', target: 'enemy', bonus: '1d6', label: 'Marked' }] },
  grant_roll_bonus: { range: 6, effects: [{ type: 'grant_roll_bonus', target: 'ally_or_self', bonus: 2, range: 6 }] },
  apply_status: { range: 4, effects: [{ type: 'apply_status', target: 'enemy', status: 'snared' }] },
  remove_status: { range: 4, effects: [{ type: 'remove_status', target: 'ally_or_self', status: 'poisoned' }] },
  discourage_attacks: { range: 4, effects: [{ type: 'discourage_attacks', target: 'ally', penalty: 5, range: 4 }] },
  grant_actions: { range: 0, actionCost: 0, usesPerPhase: 1, effects: [{ type: 'grant_actions', amount: 1 }] },
  teleport: { range: 4, actionCost: 0, usesPerPhase: 1, effects: [{ type: 'teleport', target: 'cell', distance: 4 }] },
  narrative: { range: 0, actionCost: 0, effects: [{ type: 'narrative', roll: '1d20+2' }] },
  create_barrier: { range: 3, effects: [{ type: 'create_barrier', target: 'cell', name: 'Ice Wall', duration: 'until_next_player_phase', range: 3 }] },
  healing_aura: { range: 4, effects: [{ type: 'healing_aura', heal: '1d4+1', radius: 2, pulses: 2, range: 4 }] },
  roll_to_apply: { range: 0, effects: [{ type: 'roll_to_apply', target: 'enemies_in_area', radius: 3, roll: '1d20+4', onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'shaken' }] }] },
  dm_check: { range: 3, effects: [{ type: 'dm_check', target: 'enemy', roll: '1d20', onFailure: [{ type: 'modify_movement', target: 'checked_enemy', amount: -2 }] }] },
};

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
