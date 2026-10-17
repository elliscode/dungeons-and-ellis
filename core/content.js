import { isValidDice } from './dice.js';
import { validateAbility, normalizeAbility, targetingOf } from './effects.js';

// Definition categories. characters/monsters/npcs are folders of *.json files (each an array or
// a single object); acts and items are single files (acts.json, items.json). items.json is
// optional: without it there are simply no item definitions.
export const CATEGORIES = ['characters', 'monsters', 'npcs', 'acts', 'items'];
export const FOLDER_CATEGORIES = ['characters', 'monsters', 'npcs'];
export const SINGLE_FILES = { acts: 'acts.json', items: 'items.json' };
export const FILE_RE = /^[a-z0-9][a-z0-9_-]*\.json$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ROLES = ['tank', 'dps', 'heal'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// files: [{ file, defs }] for one category. Returns { errors, warnings } with readable paths.
export function validateDefs(category, files, { imageExists } = {}) {
  const errors = [], warnings = [];
  const seen = new Map();
  for (const { file, defs } of files) {
    if (!Array.isArray(defs)) {
      errors.push(`${category}/${file}: must be a JSON array${SINGLE_FILES[category] ? '' : ' or a single object'}`);
      continue;
    }
    defs.forEach((d, i) => {
      const at = `${category}/${file} › ${typeof d?.id === 'string' && d.id ? d.id : `#${i + 1}`}`;
      const err = (msg) => errors.push(`${at}: ${msg}`);
      if (!d || typeof d !== 'object' || Array.isArray(d)) return err('must be an object');
      if (typeof d.id !== 'string' || !ID_RE.test(d.id)) err('id must be lowercase letters, digits and dashes (e.g. "fire-mage")');
      else if (seen.has(d.id)) err(`duplicate id (also in ${seen.get(d.id)})`);
      else seen.set(d.id, file);
      if (typeof d.name !== 'string' || !d.name.trim()) err('name is required');
      if (category === 'acts') {
        if (d.roll != null && d.roll !== '' && !isValidDice(d.roll)) err(`roll "${d.roll}" is not valid dice`);
        return;
      }
      if (category === 'items') {
        if (d.description !== undefined && typeof d.description !== 'string') err('description must be text');
        if (d.ability !== undefined) {
          if (!d.ability || typeof d.ability !== 'object' || Array.isArray(d.ability)) err('ability must be an object');
          else for (const m of validateAbility(d.ability, 'ability')) err(m);
        }
        return;
      }
      if (d.immortal !== undefined && typeof d.immortal !== 'boolean') err('immortal must be true or false');
      if (d.immortal === true) {
        if (category === 'characters') err('heroes cannot be immortal');
        if (d.maxHp !== undefined && d.maxHp !== null) err('immortal entities (training dummies) have no maxHp; remove it');
      } else if (!isNum(d.maxHp) || d.maxHp < 1) err('maxHp must be a number ≥ 1');
      for (const k of ['defense', 'movement']) if (d[k] !== undefined && !isNum(d[k])) err(`${k} must be a number`);
      if (d.actions !== undefined && !(Number.isInteger(d.actions) && d.actions >= 0 && d.actions <= 10)) err('actions must be a whole number from 0 to 10');
      if (category === 'characters' && !ROLES.includes(d.role)) err(`role must be one of ${ROLES.join(', ')}`);
      if (d.size !== undefined) {
        const ok = d.size && Number.isInteger(d.size.w) && Number.isInteger(d.size.h) && d.size.w >= 1 && d.size.h >= 1 && d.size.w <= 10 && d.size.h <= 10;
        if (!ok) err('size must be { "w": 1-10, "h": 1-10 }');
      }
      if (d.image !== undefined && d.image !== null) {
        if (typeof d.image !== 'string' || !d.image.startsWith('/static/')) err('image must be a path like /static/tokens/goblin.png');
        else if (imageExists && !imageExists(d.image)) warnings.push(`${at}: image ${d.image} does not exist (upload it on the Assets page)`);
      }
      if (d.attacks !== undefined && !Array.isArray(d.attacks)) err('attacks must be an array');
      (Array.isArray(d.attacks) ? d.attacks : []).forEach((a, j) => {
        const p = `attacks[${j}]`;
        if (!a || typeof a !== 'object') return err(`${p} must be an object`);
        if (typeof a.id !== 'string' || !a.id) err(`${p}.id is required`);
        if (typeof a.name !== 'string' || !a.name) err(`${p}.name is required`);
        for (const k of ['attack', 'damage']) if (!isValidDice(a[k])) err(`${p}.${k} "${a[k] ?? ''}" is not valid dice (e.g. 1d20+5)`);
        if (a.range !== undefined && !(Number.isInteger(a.range) && a.range >= 0)) err(`${p}.range must be a whole number of squares`);
      });
      if (d.abilities !== undefined && !Array.isArray(d.abilities)) err('abilities must be an array');
      (Array.isArray(d.abilities) ? d.abilities : []).forEach((a, j) => {
        const p = `abilities[${j}]`;
        if (!a || typeof a !== 'object') return err(`${p} must be an object`);
        if (typeof a.id !== 'string' || !a.id) err(`${p}.id is required`);
        if (typeof a.name !== 'string' || !a.name) err(`${p}.name is required`);
        for (const k of ['heal', 'roll']) if (a[k] != null && !isValidDice(a[k])) err(`${p}.${k} "${a[k]}" is not valid dice`);
        for (const m of validateAbility(a, `${p} (${a.id ?? '?'})`)) err(m);
      });
      if (d.inventory !== undefined && !(Array.isArray(d.inventory) && d.inventory.every((x) => typeof x === 'string' || typeof x?.name === 'string'))) {
        err('inventory must be an array of item names');
      }
    });
  }
  return { errors, warnings };
}

// Item catalog lookup shared by the server and (mirrored) the client: defId first, then name.
export function findItem(items, inv) {
  if (!inv) return null;
  const name = String(inv.name ?? '').trim().toLowerCase();
  return (inv.defId && items.find((d) => d.id === inv.defId)) || items.find((d) => d.name.trim().toLowerCase() === name) || null;
}

// An item definition as clients see it: the ability in canonical form plus its targeting.
export const itemView = (d) => (d.ability
  ? { ...d, ability: { ...normalizeAbility(d.ability), id: d.id, name: d.name, targeting: targetingOf(d.ability) } }
  : d);
