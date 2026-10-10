// Builds schemas/monster.schema.json from schemas/character.schema.json.
//
// Monsters use the same attacks, abilities and effect engine as heroes, so every shared $def
// (dice, effects, abilities, durations...) is copied from the character schema. Only the
// top-level monster fields and a few monster-specific descriptions are defined here. That keeps
// the two schemas from drifting apart: edit effects in character.schema.json, then run
//
//   npm run build:monster-schema           # regenerate
//   npm run build:monster-schema -- --check  # exit 1 if monster.schema.json is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CHARACTER_SCHEMA = join(ROOT, 'schemas', 'character.schema.json');
export const MONSTER_SCHEMA = join(ROOT, 'schemas', 'monster.schema.json');

// Monster abilities are used by the DM, so "the player picks" becomes "the DM picks".
function forMonsters(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('the player picks', 'the DM picks')
      .replaceAll('what the player picks', 'what the DM picks')
      .replaceAll('player-facing', 'DM-facing');
  }
  if (Array.isArray(value)) return value.map(forMonsters);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forMonsters(v)]));
  return value;
}

export function buildMonsterSchema(character) {
  const defs = forMonsters(structuredClone(character.$defs));

  defs.attackRoll = {
    ...defs.attackRoll,
    description: 'A d20 roll with a flat modifier, e.g. "1d20+5". Typical monster modifiers are +4 (weak) to +10 (boss).',
  };
  // Monster weapon attacks may carry a damageType (e.g. a dragon's fire breath), which the
  // shared damage pipeline uses for magical-only protections such as Spellguard.
  defs.weaponAttack = {
    ...defs.weaponAttack,
    properties: {
      ...defs.weaponAttack.properties,
      damage: { $ref: '#/$defs/dice', description: 'Typical: 1d4+2 (vermin) to 1d12+3 (brutes); bosses 2d10+6 or 6d6 breath weapons. Heroes take these as written (tanks take reduced damage).' },
      range: { type: 'integer', minimum: 0, maximum: 30, description: '1 = melee. Reach 2 for big creatures; ranged attacks are typically 6–10.' },
      damageType: { $ref: '#/$defs/damageType' },
    },
  };
  defs.ability = {
    ...defs.ability,
    description: `${defs.ability.description} Monster abilities follow enemy rules: they can only be used during the DM PHASE, and each costs actions from the monster's per-phase allowance.`,
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://dungeons-and-ellis/schemas/monster.schema.json',
    title: 'One & Done monster',
    description: [
      'A monster for the DM\'s Monster bank in One & Done, a grid-based tabletop game. Spawned monsters are independent copies, so editing a definition never changes monsters already in a game.',
      'All mechanics come from structured fields; `description` is a note for the DM and never drives mechanics.',
      'Rules: each round has a PLAYER PHASE and a DM PHASE. Hostile monsters act only in the DM PHASE, with `actions` actions (default 1) plus `movement` squares, which are separate. An action is one weapon attack or one ability.',
      'Attacks roll `attack` (always 1d20+N) against the target\'s Defense; on a hit, roll `damage`. A natural 20 is a crit (damage dice doubled), and a natural 1 always misses. Attacks and damaging abilities only work in combat.',
      'Monsters get no role bonuses, but heroes do: DPS heroes multiply their damage against monsters, tanks take reduced damage, and healers heal for more (a game setting from 1× to 5×, default 4×). Size maxHp with that in mind.',
      'Distances are grid squares (1 = adjacent).',
    ].join(' '),
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name', 'image', 'defense', 'movement', 'attacks'],
    properties: {
      id: { $ref: '#/$defs/id', description: 'Unique kebab-case id, e.g. "cave-troll". Must not clash with an existing monster id.' },
      name: { type: 'string', minLength: 1, maxLength: 60, description: 'Display name. Spawned copies are numbered automatically ("Goblin 2").' },
      image: {
        type: 'string',
        pattern: '^/static/(?:tokens|images)/[A-Za-z0-9_.-]+\\.(?:webp|png|svg|jpg|jpeg|gif)$',
        description: 'Token image. Use "/static/tokens/monster_NNN.webp" with NNN from 001 to 071. Large monsters scale the image to their `size`.',
      },
      maxHp: {
        type: 'integer', minimum: 1, maximum: 9999,
        description: 'Required unless `immortal`. Remember DPS heroes multiply their damage (default 4×). Typical: vermin 7–9, soldiers 13–16, brutes 50–60, bosses 120+.',
      },
      defense: { type: 'integer', minimum: 0, maximum: 30, description: 'Number an attack roll must meet or beat to hit. Typical: 11 (lumbering) to 13 (most), 18 (armored boss).' },
      movement: {
        type: 'integer', minimum: 0, maximum: 20,
        description: 'Squares per phase. In combat the DM\'s moves spend it (slows and snares reduce it; Shift-drag overrides). 0 = stationary. Typical 5–6, fast or flying 8.',
      },
      actions: {
        type: 'integer', minimum: 0, maximum: 10,
        description: 'Actions per DM phase (default 1). Use 2 for bosses that make several attacks; 0 for things that never act (training dummies). The DM can always grant +1 action.',
      },
      size: {
        type: 'object', additionalProperties: false, required: ['w', 'h'],
        description: 'Footprint in squares. Leave out for normal 1×1 monsters; 2×2 for large (ogre), 3×3 for huge (dragon). Range is measured from the nearest edge.',
        properties: { w: { type: 'integer', minimum: 1, maximum: 10 }, h: { type: 'integer', minimum: 1, maximum: 10 } },
      },
      hostile: {
        type: 'boolean',
        description: 'Default true. false makes it side with the party: it can act in any phase without an action limit, players see its HP, and heroes\' abilities treat it as an ally. Leave out for ordinary monsters.',
      },
      immortal: {
        type: 'boolean',
        description: 'true = a training-dummy-style target with no HP at all: damage is recorded but it can never be downed or killed (the DM can still remove it). Omit maxHp when true. Usually pair with actions 0 and movement 0.',
      },
      attacks: {
        type: 'array', minItems: 0, maxItems: 6, items: { $ref: '#/$defs/weaponAttack' },
        description: 'Weapon attacks, one per action. Roster monsters have 1–3 (usually a melee and a ranged option). Empty only for things that never attack.',
      },
      abilities: {
        type: 'array', minItems: 0, maxItems: 6, items: { $ref: '#/$defs/ability' },
        description: 'Optional special abilities (same effect engine as heroes). "enemy" targets are heroes and friendly NPCs; "ally" targets are other monsters.',
      },
      inventory: {
        type: 'array', maxItems: 10, items: { $ref: '#/$defs/id', description: 'Item id, kebab-case, e.g. "rusty-key".' },
        description: 'Optional loot or carried items. Only the DM sees a hostile monster\'s inventory.',
      },
      description: { type: 'string', minLength: 1, maxLength: 300, description: 'Optional note for the DM (tactics, lore). Not shown to players and not used by the game.' },
    },
    allOf: [
      {
        if: { required: ['immortal'], properties: { immortal: { const: true } } },
        then: { not: { required: ['maxHp'] } },
        else: { required: ['maxHp'] },
      },
    ],
    $defs: defs,
  };
}

export const render = (schema) => `${JSON.stringify(schema, null, 2)}\n`;

function main(args) {
  const character = JSON.parse(readFileSync(CHARACTER_SCHEMA, 'utf8'));
  const out = render(buildMonsterSchema(character));
  if (args.includes('--check')) {
    let current = '';
    try { current = readFileSync(MONSTER_SCHEMA, 'utf8'); } catch { /* missing */ }
    if (current !== out) {
      console.error('schemas/monster.schema.json is out of date — run: npm run build:monster-schema');
      process.exit(1);
    }
    console.log('monster.schema.json is up to date.');
    return;
  }
  writeFileSync(MONSTER_SCHEMA, out);
  console.log('wrote schemas/monster.schema.json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
