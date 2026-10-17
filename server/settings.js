import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ROLE_STRENGTH, ROLE_STRENGTHS, isValidRoleStrength } from '../core/roles.js';

// Global game settings, stored in <dataDir>/settings.json and changed from the DM home page.
// Currently just the role strength (1–5). A missing or invalid file falls back to the defaults.
export class SettingsError extends Error {}

export function loadSettings(dataDir) {
  const file = join(dataDir, 'settings.json');
  const store = new EventEmitter();
  let roleStrength = DEFAULT_ROLE_STRENGTH;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (isValidRoleStrength(parsed.roleStrength)) roleStrength = parsed.roleStrength;
      else console.warn(`settings.json: roleStrength must be one of ${ROLE_STRENGTHS.join(', ')}; using ${DEFAULT_ROLE_STRENGTH}`);
    } catch (e) {
      console.warn(`settings.json is not valid JSON (${e.message}); using defaults`);
    }
  }
  store.get = () => ({ roleStrength });
  store.setRoleStrength = (n) => {
    const value = typeof n === 'string' && n.trim() ? Number(n) : n;
    if (!isValidRoleStrength(value)) throw new SettingsError(`Role strength must be one of ${ROLE_STRENGTHS.join(', ')}`);
    if (value === roleStrength) return store.get();
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ roleStrength: value }, null, 2)}\n`);
    renameSync(tmp, file);
    const before = roleStrength;
    roleStrength = value;
    store.emit('change', { before, after: value });
    return store.get();
  };
  return store;
}
