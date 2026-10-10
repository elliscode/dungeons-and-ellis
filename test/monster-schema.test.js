import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFECT_TYPES, validateAbility } from '../server/games/effects.js';
import { validateDefs, loadContent } from '../server/content.js';
import { openDb } from '../server/db.js';
import { TemplateStore } from '../server/templates.js';
import { GameService } from '../server/games/service.js';
import { compileSchema, schemaErrors } from '../scripts/validate-characters.js';
import { buildMonsterSchema, render, CHARACTER_SCHEMA, MONSTER_SCHEMA } from '../scripts/build-monster-schema.js';
import { SAMPLES } from './schema-samples.js';
import { ok, DM, ROOT, FIXTURE_DATA } from './helpers.js';

// schemas/monster.schema.json is generated from character.schema.json (shared attacks, abilities
// and effects) plus monster-only fields. Anything it accepts must pass the server's own rules.

const schema = JSON.parse(readFileSync(MONSTER_SCHEMA, 'utf8'));
const validate = compileSchema(MONSTER_SCHEMA);
const errs = (def) => schemaErrors(validate, def).join('\n');

const monster = (extra = {}) => ({
  id: 'cave-troll', name: 'Cave Troll', image: '/static/tokens/monster_010.webp',
  maxHp: 60, defense: 12, movement: 5,
  attacks: [{ id: 'club', name: 'Club', attack: '1d20+6', damage: '2d8+4', range: 1 }],
  ...extra,
});

test('monster.schema.json is up to date with character.schema.json', () => {
  const character = JSON.parse(readFileSync(CHARACTER_SCHEMA, 'utf8'));
  assert.equal(readFileSync(MONSTER_SCHEMA, 'utf8'), render(buildMonsterSchema(character)), 'run: npm run build:monster-schema');
  const types = schema.$defs.effect.oneOf.map((r) => r.$ref.replace('#/$defs/effect_', ''));
  assert.deepEqual([...types].sort(), [...EFFECT_TYPES].sort());
});

test('every monster in the bank passes the schema', () => {
  const dir = join(ROOT, 'data', 'monsters');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    for (const m of [].concat(JSON.parse(readFileSync(join(dir, f), 'utf8')))) assert.equal(errs(m), '', `${f} › ${m.id}`);
  }
});

test('every monster field the game supports is allowed', () => {
  const full = monster({
    actions: 2, size: { w: 2, h: 2 }, hostile: true, inventory: ['rusty-key'], description: 'Hates sunlight.',
    attacks: [
      { id: 'club', name: 'Club', attack: '1d20+6', damage: '2d8+4', range: 2 },
      { id: 'spit', name: 'Acid Spit', attack: '1d20+5', damage: '2d6', range: 6, damageType: 'acid' },
    ],
    abilities: [{ id: 'roar', name: 'Roar', actionCost: 1, range: 0, description: 'Shakes nearby heroes.', effects: [{ type: 'roll_to_apply', target: 'enemies_in_area', radius: 3, roll: '1d20+4', onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'shaken' }] }] }],
  });
  assert.equal(errs(full), '');
  assert.deepEqual(validateDefs('monsters', [{ file: 'm.json', defs: [full] }]).errors, []);
  assert.equal(errs(monster({ hostile: false })), '', 'friendly monster');
  assert.equal(errs({ id: 'dummy', name: 'Dummy', image: '/static/tokens/token_174.webp', immortal: true, defense: 10, movement: 0, actions: 0, attacks: [] }), '', 'training dummy');
  assert.equal(errs(monster({ attacks: [] })), '', 'a monster that never attacks');
  assert.equal(errs(monster({ image: '/static/images/ogre.svg' })), '', 'images folder');
});

test('a monster can use an ability of every effect type, accepted by schema and engine', () => {
  const abilities = Object.entries(SAMPLES).map(([type, a]) => ({ id: type.replaceAll('_', '-'), name: type, actionCost: 1, description: `Sample ${type}.`, ...a }));
  for (const a of abilities) {
    assert.equal(errs(monster({ abilities: [a] })), '', `${a.id} schema`);
    assert.deepEqual(validateAbility(a, a.id), [], `${a.id} engine`);
  }
  assert.deepEqual(validateDefs('monsters', [{ file: 'm.json', defs: [monster({ abilities })] }]).errors, []);
});

test('rejects what monsters cannot have', () => {
  assert.match(errs(monster({ role: 'tank' })), /role/);
  assert.match(errs(monster({ immortal: true })), /maxHp|must NOT be valid/i, 'immortal must not have maxHp');
  const { maxHp, ...noHp } = monster();
  assert.match(errs(noHp), /maxHp/, 'mortal monsters need maxHp');
  assert.match(errs(monster({ hostile: 'yes' })), /hostile/);
  assert.match(errs(monster({ image: 'goblin.png' })), /image/);
  assert.match(errs(monster({ actions: 11 })), /actions/);
  assert.match(errs(monster({ size: { w: 0, h: 1 } })), /size/);
  assert.match(errs(monster({ attacks: [{ id: 'x', name: 'X', attack: '2d6', damage: '1d6', range: 1 }] })), /attack/, 'attack rolls must be 1d20±N');
  assert.match(errs(monster({ abilities: [{ id: 'haste', name: 'Haste', actionCost: 0, range: 0, description: 'x', effects: [{ type: 'grant_actions', amount: 1 }] }] })), /usesPerPhase/);
  assert.match(errs(monster({ bogus: 1 })), /bogus/);
});

test('a schema-valid monster loads and its ability runs under enemy rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dne-monster-'));
  try {
    for (const sub of ['characters', 'monsters', 'npcs']) cpSync(join(FIXTURE_DATA, sub), join(dir, sub), { recursive: true });
    cpSync(join(FIXTURE_DATA, 'acts.json'), join(dir, 'acts.json'));
    const troll = monster({ abilities: [{ id: 'roar', name: 'Roar', actionCost: 1, range: 0, description: 'Shakes nearby heroes.', effects: [{ type: 'roll_to_apply', target: 'enemies_in_area', radius: 3, roll: '1d20+4', onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'shaken' }] }] }] });
    assert.equal(errs(troll), '');
    writeFileSync(join(dir, 'monsters', 'troll.json'), JSON.stringify([troll]));
    const content = loadContent(dir);
    const db = openDb(':memory:');
    const templates = new TemplateStore(db);
    const service = new GameService({ db, content, templates, rng: (sides) => sides });
    const game = service.createGame('Troll test');
    const run = (actor, cmd) => service.dispatch(game.id, actor, cmd);
    const sid = ok(run(DM, { type: 'scene.add', templateId: templates.create({ name: 'R', grid: { cols: 8, rows: 8 } }).id })).sceneId;
    ok(run(DM, { type: 'scene.activate', sceneId: sid }));
    const p = ok(run({ role: 'join' }, { type: 'player.create', name: 'Ana' }));
    ok(run({ role: 'player', playerId: p.playerId }, { type: 'player.selectCharacter', characterId: 'paladin' }));
    const hero = service.get(game.id).state.players[p.playerId].entityId;
    ok(run(DM, { type: 'move', entityId: hero, x: 0, y: 0, force: true }));
    const t = ok(run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'cave-troll', x: 2, y: 0 })).entityId;
    ok(run(DM, { type: 'combat.start' }));
    assert.match(run(DM, { type: 'ability', entityId: t, abilityId: 'roar' }).error, /DM PHASE/);
    ok(run(DM, { type: 'combat.advance' }));
    ok(run(DM, { type: 'ability', entityId: t, abilityId: 'roar' }));
    assert.ok(service.get(game.id).state.entities[hero].effects.some((fx) => fx.status === 'shaken'));
    assert.match(run(DM, { type: 'ability', entityId: t, abilityId: 'roar' }).error, /no actions left/);
    service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
