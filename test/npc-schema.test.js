import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFECT_TYPES, validateAbility } from '../core/effects.js';
import { loadContent } from '../server/content.js';
import { validateDefs } from '../core/content.js';
import { openDb } from '../server/db.js';
import { TemplateStore } from '../server/templates.js';
import { GameService } from '../server/games/service.js';
import { compileSchema, schemaErrors } from '../scripts/validate-characters.js';
import { render, CHARACTER_SCHEMA } from '../scripts/build-monster-schema.js';
import { buildNpcSchema, NPC_SCHEMA } from '../scripts/build-npc-schema.js';
import { SAMPLES } from './schema-samples.js';
import { ok, DM, ROOT, FIXTURE_DATA, fixedSettings } from './helpers.js';

// schemas/npc.schema.json is generated from character.schema.json (shared attacks, abilities and
// effects) plus NPC-only fields. Anything it accepts must pass the server's own rules.

const schema = JSON.parse(readFileSync(NPC_SCHEMA, 'utf8'));
const validate = compileSchema(NPC_SCHEMA);
const errs = (def) => schemaErrors(validate, def).join('\n');

const npc = (extra = {}) => ({
  id: 'village-healer', name: 'Village Healer', image: '/static/tokens/token_150.webp',
  maxHp: 10, defense: 11, movement: 5,
  attacks: [{ id: 'staff', name: 'Staff', attack: '1d20+2', damage: '1d4', range: 1 }],
  ...extra,
});
const mend = { id: 'mend', name: 'Mend', actionCost: 1, range: 4, description: 'Heals an ally within 4.', effects: [{ type: 'heal', target: 'ally', heal: '1d4+2', range: 4 }] };
const roar = { id: 'roar', name: 'Roar', actionCost: 1, range: 0, description: 'Shakes nearby foes.', effects: [{ type: 'roll_to_apply', target: 'enemies_in_area', radius: 3, roll: '1d20+4', onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'shaken' }] }] };

test('npc.schema.json is up to date with character.schema.json', () => {
  const character = JSON.parse(readFileSync(CHARACTER_SCHEMA, 'utf8'));
  assert.equal(readFileSync(NPC_SCHEMA, 'utf8'), render(buildNpcSchema(character)), 'run: npm run build:schemas');
  const types = schema.$defs.effect.oneOf.map((r) => r.$ref.replace('#/$defs/effect_', ''));
  assert.deepEqual([...types].sort(), [...EFFECT_TYPES].sort());
});

test('every NPC in the bank passes the schema', () => {
  const dir = join(ROOT, 'data', 'npcs');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    for (const n of [].concat(JSON.parse(readFileSync(join(dir, f), 'utf8')))) assert.equal(errs(n), '', `${f} › ${n.id}`);
  }
});

test('every NPC field the game supports is allowed', () => {
  const full = npc({
    actions: 2, size: { w: 2, h: 2 }, hostile: true, inventory: ['herb-pouch'], description: 'Knows the old road.',
    attacks: [{ id: 'sling', name: 'Sling', attack: '1d20+3', damage: '1d4+1', range: 6, damageType: 'bludgeoning' }],
    abilities: [mend],
  });
  assert.equal(errs(full), '');
  assert.deepEqual(validateDefs('npcs', [{ file: 'n.json', defs: [full] }]).errors, []);
  assert.equal(errs(npc({ attacks: [] })), '', 'an NPC that never fights');
  assert.equal(errs({ id: 'oracle', name: 'Oracle', image: '/static/tokens/token_151.webp', immortal: true, defense: 10, movement: 0, attacks: [] }), '', 'immortal NPC');
});

test('an NPC can use an ability of every effect type, accepted by schema and engine', () => {
  const abilities = Object.entries(SAMPLES).map(([type, a]) => ({ id: type.replaceAll('_', '-'), name: type, actionCost: 1, description: `Sample ${type}.`, ...a }));
  for (const a of abilities) {
    assert.equal(errs(npc({ abilities: [a] })), '', `${a.id} schema`);
    assert.deepEqual(validateAbility(a, a.id), [], `${a.id} engine`);
  }
  assert.deepEqual(validateDefs('npcs', [{ file: 'n.json', defs: [npc({ abilities })] }]).errors, []);
});

test('rejects what NPCs cannot have', () => {
  assert.match(errs(npc({ role: 'heal' })), /role/);
  assert.match(errs(npc({ immortal: true })), /maxHp|must NOT be valid/i, 'immortal must not have maxHp');
  const { maxHp, ...noHp } = npc();
  assert.match(errs(noHp), /maxHp/, 'mortal NPCs need maxHp');
  assert.match(errs(npc({ hostile: 'no' })), /hostile/);
  assert.match(errs(npc({ abilities: [{ id: 'wize-words', name: 'Wize Words', roll: '1d20+6' }] })), /roll|effects/, 'legacy ability fields');
  assert.match(errs(npc({ bogus: 1 })), /bogus/);
});

test('schema-valid NPCs load and follow friendly or hostile rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-npc-'));
  try {
    for (const sub of ['characters', 'monsters', 'npcs']) cpSync(join(FIXTURE_DATA, sub), join(dir, sub), { recursive: true });
    cpSync(join(FIXTURE_DATA, 'acts.json'), join(dir, 'acts.json'));
    const healer = npc({ abilities: [mend] });
    const bandit = npc({ id: 'bandit-chief', name: 'Bandit Chief', hostile: true, abilities: [roar] });
    assert.equal(errs(healer), '');
    assert.equal(errs(bandit), '');
    writeFileSync(join(dir, 'npcs', 'test-npcs.json'), JSON.stringify([healer, bandit]));
    const content = loadContent(dir);
    const db = openDb(':memory:');
    const templates = new TemplateStore(db);
    const service = new GameService({ db, content, templates, settings: fixedSettings(), rng: (sides) => sides });
    const game = service.createGame('NPC test');
    const run = (actor, cmd) => service.dispatch(game.id, actor, cmd);
    const state = () => service.get(game.id).state;
    const sid = ok(run(DM, { type: 'scene.add', templateId: templates.create({ name: 'R', grid: { cols: 8, rows: 8 } }).id })).sceneId;
    ok(run(DM, { type: 'scene.activate', sceneId: sid }));
    const p = ok(run({ role: 'join' }, { type: 'player.create', name: 'Ana' }));
    ok(run({ role: 'player', playerId: p.playerId }, { type: 'player.selectCharacter', characterId: 'paladin' }));
    const hero = state().players[p.playerId].entityId;
    ok(run(DM, { type: 'move', entityId: hero, x: 0, y: 0, force: true }));
    const h = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'village-healer', x: 1, y: 0 })).entityId;
    const b = ok(run(DM, { type: 'entity.spawn', kind: 'npc', defId: 'bandit-chief', x: 2, y: 0 })).entityId;
    assert.equal(state().entities[h].hostile, false, 'NPCs default to friendly');
    assert.equal(state().entities[b].hostile, true, 'hostile: true starts hostile');

    ok(run(DM, { type: 'combat.start' }));
    // Friendly: "ally" is the hero, usable in the player phase, one action per phase.
    ok(run(DM, { type: 'entity.setHp', entityId: hero, hp: 10 }));
    ok(run(DM, { type: 'ability', entityId: h, abilityId: 'mend', targetId: hero }));
    assert.match(run(DM, { type: 'ability', entityId: h, abilityId: 'mend', targetId: hero }).error, /no actions left/);
    ok(run(DM, { type: 'entity.grantAction', entityId: h }));
    ok(run(DM, { type: 'ability', entityId: h, abilityId: 'mend', targetId: hero }));
    assert.equal(state().entities[hero].hp, 22);
    ok(run(DM, { type: 'entity.grantAction', entityId: h }));
    assert.match(run(DM, { type: 'ability', entityId: h, abilityId: 'mend', targetId: b }).error, /not an ally/);
    // Hostile: enemy rules, and the hero is its enemy.
    assert.match(run(DM, { type: 'ability', entityId: b, abilityId: 'roar' }).error, /DM PHASE/);
    ok(run(DM, { type: 'combat.advance' }));
    ok(run(DM, { type: 'ability', entityId: b, abilityId: 'roar' }));
    assert.ok(state().entities[hero].effects.some((fx) => fx.status === 'shaken'));
    assert.match(run(DM, { type: 'ability', entityId: b, abilityId: 'roar' }).error, /no actions left/);
    service.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
