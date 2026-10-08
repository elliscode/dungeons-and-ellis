import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readDefs(dir) {
  if (!existsSync(dir)) return [];
  const defs = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    defs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  const seen = new Set();
  for (const d of defs) {
    if (!d.id) throw new Error(`Definition without id in ${dir}`);
    if (seen.has(d.id)) throw new Error(`Duplicate definition id "${d.id}" in ${dir}`);
    seen.add(d.id);
  }
  return defs;
}

export function loadContent(dir) {
  const characters = readDefs(join(dir, 'characters'));
  const monsters = readDefs(join(dir, 'monsters'));
  const npcs = readDefs(join(dir, 'npcs'));
  const actsFile = join(dir, 'acts.json');
  const acts = existsSync(actsFile) ? JSON.parse(readFileSync(actsFile, 'utf8')) : [];
  const index = (list) => new Map(list.map((d) => [d.id, d]));
  const maps = { character: index(characters), monster: index(monsters), npc: index(npcs) };
  return {
    characters, monsters, npcs, acts,
    def(kind, id) { return maps[kind]?.get(id) ?? null; },
    act(id) { return acts.find((a) => a.id === id) ?? null; },
    publicContent() { return { characters, acts }; },
    dmContent() { return { characters, monsters, npcs, acts }; },
  };
}
