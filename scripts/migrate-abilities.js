// One-time migration of hero abilities to the canonical effect schema (see docs/ABILITIES.md).
// Keeps every ability's id, name, description and dice; mechanics come from the explicit table
// below, never from descriptions. Abilities not in the table go through normalizeAbility().
//   node scripts/migrate-abilities.js [dataDir]      (default: ./data)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAbility, validateAbility } from '../server/games/effects.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(process.argv[2] ?? join(ROOT, 'data'), 'characters');

const atk = (a, extra = {}) => ({ type: 'attack', target: 'enemy', attack: a.attack, damage: a.damage, range: a.range ?? 1, ...extra });
const healAlly = (a) => [{ type: 'heal', target: 'ally_or_self', heal: a.heal, range: a.range ?? 1 }];
const healSelf = (a) => [{ type: 'heal', target: 'self', heal: a.heal }];
const drainSelf = (a) => ({ type: 'heal', target: 'self', heal: a.heal, when: 'attack_hits' });
// Buffs whose only mechanic was a roll: the effect auto-applies; the roll is shown for flavor.
const flavor = (a) => (a.roll ? [{ type: 'narrative', roll: a.roll }] : []);
const free = (extra = {}) => ({ actionCost: 0, usesPerPhase: 1, ...extra });

const TABLE = {
  // ---------- DPS ----------
  'inferno-surge': (a) => ({ effects: [atk(a, { damageType: 'fire' })] }),
  light: () => ({ actionCost: 0, range: 0, effects: [{ type: 'narrative' }] }),
  'cunning-action': () => free({ range: 0, effects: [{ type: 'grant_actions', target: 'self', amount: 1 }] }),
  backstab: (a) => ({ effects: [atk(a)] }),
  'hunters-mark': (a) => ({ range: 10, effects: [{ type: 'roll_to_apply', target: 'enemy', roll: a.roll, range: 10, onSuccess: [{ type: 'mark_target', target: 'checked_enemy', bonus: '1d6', label: "Hunter's Mark" }] }] }),
  'pinning-shot': (a) => ({ effects: [atk(a), { type: 'modify_movement', target: 'hit_enemies', amount: -2, when: 'attack_hits', label: 'Pinned', duration: 'next_dm_phase' }] }),
  'cone-of-cold': (a) => ({ range: 3, effects: [{ type: 'area_attack', target: 'enemies_in_area', center: 'target', radius: 1, range: 3, attack: a.attack, damage: a.damage, damageType: 'cold' }] }),
  'blink-step': () => free({ range: 4, effects: [{ type: 'teleport', target: 'cell', distance: 4 }] }),
  'chain-lightning': (a) => ({ effects: [{ type: 'chain_attack', target: 'enemy', attack: a.attack, damage: a.damage, range: a.range ?? 8, jumps: 1, jumpRange: 3, damageType: 'lightning' }] }),
  thunderclap: (a) => ({ range: 0, effects: [{ type: 'area_attack', target: 'enemies_in_area', center: 'self', radius: 2, attack: a.attack, damage: a.damage, damageType: 'thunder' }] }),
  'life-drain': (a) => ({ effects: [atk(a, { damageType: 'necrotic' }), drainSelf(a)] }),
  'curse-of-weakness': (a) => ({ range: 6, effects: [{ type: 'roll_to_apply', target: 'enemy', roll: a.roll, range: 6, onSuccess: [{ type: 'modify_damage_dealt', target: 'checked_enemy', multiplier: 0.5, label: 'Curse of Weakness', trigger: 'next_hit', duration: 'next_dm_phase' }] }] }),
  'flurry-of-blows': (a) => ({ effects: [{ type: 'multi_attack', target: 'enemy', count: 4, attack: a.attack, damage: a.damage, range: a.range ?? 1 }] }),
  'chi-dash': () => free({ range: 0, effects: [{ type: 'modify_movement', target: 'self', amount: 3, duration: 'current_turn', label: 'Chi Dash' }] }),
  'companion-strike': (a) => ({ effects: [atk(a)] }),
  'snare-trap': (a) => ({ range: 4, effects: [{ type: 'roll_to_apply', target: 'enemy', roll: a.roll, range: 4, onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'snared', duration: 'next_dm_phase' }] }] }),
  'quick-reload': () => free({ range: 0, effects: [{ type: 'grant_actions', target: 'self', amount: 1 }] }),
  'trick-shot': (a) => ({ effects: [atk(a, { defenseReduction: 2 })] }),
  'flame-lunge': (a) => ({ effects: [atk(a, { damageType: 'fire' })] }),
  'draconic-roar': (a) => ({ range: 0, effects: [{ type: 'roll_to_apply', target: 'enemies_in_area', radius: 3, roll: a.roll, onSuccess: [{ type: 'apply_status', target: 'checked_enemy', status: 'shaken', duration: 'next_dm_phase' }] }] }),

  // ---------- healers / support ----------
  'healing-word': (a) => ({ effects: healAlly(a) }),
  'cure-wounds': (a) => ({ effects: healAlly(a) }),
  goodberry: (a) => ({ effects: healAlly(a) }),
  'natures-mend': (a) => ({ effects: healAlly(a) }),
  'speak-with-animals': (a) => ({ range: 0, effects: flavor(a) }),
  'song-of-rest': (a) => ({ effects: healAlly(a) }),
  inspire: (a) => ({ range: 6, effects: [{ type: 'grant_roll_bonus', target: 'ally', bonus: a.roll ?? '1d6', range: 6, label: 'Inspired' }] }),
  'prayer-of-mending': (a) => ({ effects: healAlly(a) }),
  sanctuary: (a) => ({ range: 6, effects: [...flavor(a), { type: 'discourage_attacks', target: 'ally_or_self', penalty: 5, range: 6, label: 'Sanctuary', duration: 'next_dm_phase' }] }),
  'healing-surge': (a) => ({ effects: healAlly(a) }),
  'chain-heal': (a) => ({ effects: [{ type: 'chain_heal', target: 'ally_or_self', heal: a.heal, range: a.range ?? 6, jumps: 1, jumpRange: 3 }] }),
  'healing-totem': (a) => ({ range: 2, effects: [...flavor(a), { type: 'healing_aura', target: 'cell', range: 2, heal: '1d4+1', radius: 2, pulses: 2, name: 'Healing Totem' }] }),
  'soothing-mist': (a) => ({ effects: healAlly(a) }),
  'renewing-wave': (a) => ({ effects: healAlly(a) }),
  'serene-focus': (a) => ({ range: 0, effects: [...flavor(a), { type: 'defense_bonus', target: 'self', amount: 3, trigger: 'next_attack_against_self', duration: 'next_dm_phase', label: 'Serene Focus' }] }),
  'flash-of-light': (a) => ({ effects: healAlly(a) }),
  'beacon-of-grace': () => ({ actionCost: 0, range: 6, effects: [{ type: 'modify_healing', target: 'ally_or_self', amount: 3, range: 6, label: 'Beacon of Grace' }] }),
  'restorative-draught': (a) => ({ effects: healAlly(a) }),
  antidote: (a) => ({ effects: [...healAlly(a), { type: 'remove_status', target: 'ally_or_self', status: 'poisoned' }] }),
  'volatile-flask': (a) => ({ range: 5, effects: [{ type: 'area_attack', target: 'enemies_in_area', center: 'target', radius: 1, range: 5, attack: a.attack, damage: a.damage, damageType: 'poison' }, { type: 'apply_status', target: 'hit_enemies', status: 'poisoned', when: 'attack_hits', duration: 'next_dm_phase' }] }),
  'celestial-balm': (a) => ({ effects: healAlly(a) }),
  'warding-rune': (a) => ({ range: 4, effects: [...flavor(a), { type: 'absorb_next_hit', target: 'ally_or_self', range: 4, label: 'Warding Rune' }] }),
  foresight: (a) => ({ range: 6, effects: [{ type: 'grant_roll_bonus', target: 'ally_or_self', bonus: a.roll ?? '1d6', range: 6, label: 'Foresight' }] }),
  'ancestral-call': (a) => ({ effects: healAlly(a) }),
  'spirit-tether': (a) => ({ effects: healAlly(a) }),
  'veil-step': () => free({ range: 3, effects: [{ type: 'teleport', target: 'cell', distance: 3 }, { type: 'defense_bonus', target: 'self', amount: 2, duration: 'next_dm_phase', label: 'Veil Step' }] }),

  // ---------- tanks ----------
  'shield-wall': (a) => ({ range: 0, effects: [...flavor(a), { type: 'grant_protection', target: 'self', fraction: 0.5, label: 'Shield Wall' }] }),
  'second-wind': (a) => ({ range: 0, effects: healSelf(a) }),
  earthshaker: (a) => ({ range: 0, effects: [{ type: 'area_attack', target: 'enemies_in_area', center: 'self', radius: 2, attack: a.attack, damage: a.damage }] }),
  'stone-skin': (a) => ({ range: 0, effects: [...flavor(a), { type: 'grant_protection', target: 'self', fraction: 0.5, label: 'Stone Skin' }] }),
  ironbark: (a) => ({ range: 0, effects: [...flavor(a), { type: 'grant_protection', target: 'self', fraction: 0.5, label: 'Ironbark' }] }),
  regrowth: (a) => ({ range: 0, effects: healSelf(a) }),
  'blood-siphon': (a) => ({ effects: [atk(a, { damageType: 'necrotic' }), drainSelf(a)] }),
  'bone-armor': (a) => ({ range: 0, effects: [...flavor(a), { type: 'absorb_next_hit', target: 'self', label: 'Bone Armor' }] }),
  'reckless-cleave': (a) => ({ effects: [atk(a, { damageBonus: 3 }), { type: 'defense_bonus', target: 'self', amount: -2, duration: 'until_next_player_phase', label: 'Reckless' }] }),
  'unbreakable-rage': (a) => ({ range: 0, effects: [...flavor(a), { type: 'grant_protection', target: 'self', fraction: 0.5, label: 'Unbreakable Rage' }] }),
  spellguard: (a) => ({ range: 1, effects: [...flavor(a), { type: 'absorb_next_hit', target: 'ally_or_self', range: 1, magicalOnly: true, label: 'Spellguard' }] }),
  'silencing-strike': (a) => ({ effects: [atk(a), { type: 'reduce_actions', target: 'hit_enemies', amount: 1, when: 'attack_hits', label: 'Silenced', duration: 'next_dm_phase' }] }),
  intercept: (a) => ({ range: 1, effects: [...flavor(a), { type: 'redirect_next_hit', target: 'ally', range: 1, label: 'Intercept' }] }),
  'radiant-guard': (a) => ({ range: 0, effects: [...flavor(a), { type: 'defense_bonus', target: 'self', amount: 2, radius: 2, duration: 'until_next_player_phase', label: 'Radiant Guard' }] }),
  'frozen-bulwark': (a) => ({ range: 0, effects: [...flavor(a), { type: 'absorb_next_hit', target: 'self', label: 'Frozen Bulwark' }] }),
  'glacial-slam': (a) => ({ range: 0, effects: [{ type: 'area_attack', target: 'enemies_in_area', center: 'self', radius: 1, attack: a.attack, damage: a.damage, damageType: 'cold' }, { type: 'modify_movement', target: 'hit_enemies', amount: -2, when: 'attack_hits', label: 'Chilled', duration: 'next_dm_phase' }] }),
  'deploy-barrier': () => free({ range: 2, effects: [{ type: 'create_barrier', target: 'cell', range: 2, name: 'Barrier', duration: 'next_dm_phase' }] }),
  'magnetic-taunt': (a) => ({ range: 0, effects: [{ type: 'roll_to_apply', target: 'enemies_in_area', radius: 3, roll: a.roll, onSuccess: [{ type: 'taunt', target: 'checked_enemy', duration: 'next_dm_phase' }] }] }),
  // Already structured; only Seismic Slam's area wording is normalized (adjacent = radius 1).
  'seismic-slam': (a) => ({ effects: a.effects.map((e) => (e.type === 'area_attack' ? { type: e.type, target: e.target, center: 'self', radius: 1, attack: e.attack, damage: e.damage } : e)) }),
};

const LEGACY = ['attack', 'damage', 'heal', 'roll', 'free', 'grantsActions'];

// JSON with short objects/arrays kept on one line (like the hand-written files).
function flatJson(v) {
  if (Array.isArray(v)) return `[${v.map(flatJson).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${flatJson(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}

function pretty(v, indent = '') {
  const flat = flatJson(v);
  if (flat.length + indent.length <= 110 || v === null || typeof v !== 'object') return flat;
  const next = `${indent}  `;
  if (Array.isArray(v)) return `[\n${v.map((x) => next + pretty(x, next)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(v).map(([k, x]) => `${next}${JSON.stringify(k)}: ${pretty(x, next)}`).join(',\n')}\n${indent}}`;
}

function migrate(a) {
  const fn = TABLE[a.id];
  const base = fn ? { ...normalizeAbility(a), ...fn(a) } : normalizeAbility(a);
  const out = { id: a.id, name: a.name, actionCost: base.actionCost ?? 1, range: base.range ?? a.range ?? 0 };
  if (base.usesPerPhase) out.usesPerPhase = base.usesPerPhase;
  out.effects = base.effects;
  out.description = a.description;
  for (const [k, v] of Object.entries(a)) if (!(k in out) && !LEGACY.includes(k)) out[k] = v;
  return { out, mapped: !!fn };
}

let total = 0;
const unmapped = [];
const errors = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(dir, file);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of list) {
    c.abilities = (c.abilities ?? []).map((a) => {
      const { out, mapped } = migrate(a);
      total++;
      if (!mapped && !(Array.isArray(a.effects) && a.effects.length)) unmapped.push(`${c.id}/${a.id}`);
      errors.push(...validateAbility(out, `${file} › ${c.id} › ${a.id}`));
      return out;
    });
  }
  writeFileSync(path, `${pretty(Array.isArray(parsed) ? list : list[0])}\n`);
}
console.log(`migrated ${total} abilities in ${dir}`);
if (unmapped.length) console.log(`normalized generically (no table entry): ${unmapped.join(', ')}`);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
