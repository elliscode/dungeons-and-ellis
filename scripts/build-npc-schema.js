// Builds schemas/npc.schema.json from schemas/character.schema.json.
//
// NPCs have the same shape as monsters, but default to FRIENDLY (monsters default to hostile),
// which flips what "ally" and "enemy" mean and lifts the action limit. Shared $defs (dice,
// effects, abilities, durations...) are copied from the character schema; only the NPC fields and
// NPC-specific descriptions live here. Edit effects in character.schema.json, then run
//
//   npm run build:schemas                 # regenerate the monster and NPC schemas
//   npm run build:npc-schema -- --check   # exit 1 if npc.schema.json is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forMonsters, render, CHARACTER_SCHEMA } from './build-monster-schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NPC_SCHEMA = join(ROOT, 'schemas', 'npc.schema.json');

export function buildNpcSchema(character) {
  const defs = forMonsters(structuredClone(character.$defs));

  defs.attackRoll = {
    ...defs.attackRoll,
    description: 'A d20 roll with a flat modifier, e.g. "1d20+3". Typical NPC modifiers are +2 (commoner) to +7 (powerful mage or veteran).',
  };
  // NPC weapon attacks may carry a damageType, like monster attacks.
  defs.weaponAttack = {
    ...defs.weaponAttack,
    properties: {
      ...defs.weaponAttack.properties,
      damage: { $ref: '#/$defs/dice', description: 'Typical: 1d4 (improvised) to 1d6+1 (guard); powerful NPCs up to 2d8+3.' },
      range: { type: 'integer', minimum: 0, maximum: 30, description: '1 = melee. Ranged attacks and spells are typically 6–10.' },
      damageType: { $ref: '#/$defs/damageType' },
    },
  };
  defs.ability = {
    ...defs.ability,
    description: `${defs.ability.description} A friendly NPC acts in the PLAYER PHASE with the heroes: each ability costs actions from its per-phase allowance and usesPerPhase applies. While hostile, the NPC follows enemy rules: DM PHASE only, with the same costs.`,
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://dungeons-and-ellis/schemas/npc.schema.json',
    title: 'One & Done NPC',
    description: [
      'A non-player character for the DM\'s NPC bank in One & Done, a grid-based tabletop game: townsfolk, guards, quest givers, companions, rivals. Spawned NPCs are independent copies, so editing a definition never changes NPCs already in a game.',
      'All mechanics come from structured fields; `description` is a note for the DM and never drives mechanics.',
      'NPCs are FRIENDLY by default: they side with the party, players see their HP, and they act in the PLAYER PHASE alongside the heroes, with `actions` actions per phase (default 1). The DM can mark any NPC hostile (or friendly again) mid-game, and `hostile: true` makes it start hostile.',
      'Which side an NPC is on decides what ability targets mean. Friendly: "ally" = heroes and other friendly NPCs, "enemy" = monsters and hostile NPCs. Hostile: the reverse. Design abilities for the side the NPC normally starts on.',
      'Attacks roll `attack` (always 1d20+N) against the target\'s Defense; on a hit, roll `damage`. Attacks and damaging abilities only work in combat. Hostile NPCs take the heroes\' role bonuses (DPS heroes multiply their damage, default 4×), so size a hostile NPC\'s maxHp like a monster\'s.',
      'Distances are grid squares (1 = adjacent).',
    ].join(' '),
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name', 'image', 'defense', 'movement', 'attacks'],
    properties: {
      id: { $ref: '#/$defs/id', description: 'Unique kebab-case id, e.g. "town-guard". Must not clash with an existing NPC id.' },
      name: { type: 'string', minLength: 1, maxLength: 60, description: 'Display name, e.g. "Innkeeper" or a proper name like "Walky the Wize".' },
      image: {
        type: 'string',
        pattern: '^/static/(?:tokens|images)/[A-Za-z0-9_.-]+\\.(?:webp|png|svg|jpg|jpeg|gif)$',
        description: 'Token image. Use the exact token path given in the request, e.g. "/static/tokens/token_273.webp". If none is given, use the literal placeholder "/static/tokens/token_NNN.webp" (the DM swaps in the real token later). Do not invent a numbered token.',
      },
      maxHp: {
        type: 'integer', minimum: 1, maximum: 9999,
        description: 'Required unless `immortal`. Typical: commoners 6–8, guards 11–16, notable NPCs (veterans, mages) 25–40. An NPC meant to fight the party should use monster-sized HP.',
      },
      defense: { type: 'integer', minimum: 0, maximum: 30, description: 'Number an attack roll must meet or beat to hit. Typical: 10 (commoner), 12–15 (adventurer types), 16 (armored guard).' },
      movement: {
        type: 'integer', minimum: 0, maximum: 20,
        description: 'Squares per phase. 0 = stationary. Typical 5–6.',
      },
      actions: {
        type: 'integer', minimum: 0, maximum: 10,
        description: 'Actions per phase (default 1): per PLAYER PHASE while friendly, per DM PHASE while hostile. Leave out unless the NPC is a boss or a strong companion.',
      },
      size: {
        type: 'object', additionalProperties: false, required: ['w', 'h'],
        description: 'Footprint in squares. Leave out for normal 1×1 NPCs. Range is measured from the nearest edge.',
        properties: { w: { type: 'integer', minimum: 1, maximum: 10 }, h: { type: 'integer', minimum: 1, maximum: 10 } },
      },
      hostile: {
        type: 'boolean',
        description: 'Default false (friendly). true = the NPC starts on the monsters\' side: it acts only in the DM PHASE with `actions` actions, players can\'t see its HP, and heroes target it as an enemy. Leave out for ordinary NPCs. The DM can flip this mid-game.',
      },
      immortal: {
        type: 'boolean',
        description: 'true = cannot be downed or killed and has no HP (damage is only recorded). Use rarely, e.g. a story-critical figure or a sparring partner. Omit maxHp when true.',
      },
      attacks: {
        type: 'array', minItems: 0, maxItems: 6, items: { $ref: '#/$defs/weaponAttack' },
        description: 'Weapon attacks, one per action. Empty for NPCs that never fight (merchants, quest givers); otherwise usually 1.',
      },
      abilities: {
        type: 'array', minItems: 0, maxItems: 6, items: { $ref: '#/$defs/ability' },
        description: 'Optional special abilities (same effect engine as heroes). For a friendly NPC, "ally" targets are heroes and friendly NPCs and "enemy" targets are monsters. Use a "narrative" effect for roleplay or utility abilities with no mechanics.',
      },
      inventory: {
        type: 'array', maxItems: 10, items: { $ref: '#/$defs/id', description: 'Item id, kebab-case, e.g. "room-key". Ids that appear in data/items.json (e.g. "healing-potion") get that item\'s ability.' },
        description: 'Optional items the NPC carries, sells or can hand over. Only the DM sees an NPC\'s inventory.',
      },
      description: { type: 'string', minLength: 1, maxLength: 300, description: 'Optional note for the DM (personality, what they know, what they want). Not shown to players and not used by the game.' },
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

function main(args) {
  const character = JSON.parse(readFileSync(CHARACTER_SCHEMA, 'utf8'));
  const out = render(buildNpcSchema(character));
  if (args.includes('--check')) {
    let current = '';
    try { current = readFileSync(NPC_SCHEMA, 'utf8'); } catch { /* missing */ }
    if (current !== out) {
      console.error('schemas/npc.schema.json is out of date — run: npm run build:schemas');
      process.exit(1);
    }
    console.log('npc.schema.json is up to date.');
    return;
  }
  writeFileSync(NPC_SCHEMA, out);
  console.log('wrote schemas/npc.schema.json');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
