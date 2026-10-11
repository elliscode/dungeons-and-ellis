// Shared by validate-monsters.js and validate-npcs.js: checks bank JSON against its schema and
// the server's own content rules (the same checks the Data page runs). Exits 1 if anything fails.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDefs } from '../server/content.js';
import { compileSchema, schemaErrors, extraErrors } from './validate-characters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const readDefs = (path) => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
};

// category: 'monsters' or 'npcs' (the data/ folder and the server's content category).
export function validateBank({ category, schemaPath, noun }, args) {
  const bankDir = join(ROOT, 'data', category);
  const targets = args.length ? args.map((a) => resolve(a)) : readdirSync(bankDir).filter((f) => f.endsWith('.json')).map((f) => join(bankDir, f));
  const validate = compileSchema(schemaPath);
  let failed = false;
  const files = [];
  for (const path of targets) {
    let defs;
    try {
      defs = readDefs(path);
    } catch (e) {
      console.error(`✗ ${path}: ${e.message}`);
      failed = true;
      continue;
    }
    files.push({ file: basename(path), path, defs });
    for (const [i, def] of defs.entries()) {
      const errs = [...schemaErrors(validate, def), ...extraErrors(def)];
      const name = def?.id ?? `#${i + 1}`;
      if (errs.length) {
        failed = true;
        console.error(`✗ ${basename(path)} › ${name}\n    ${errs.join('\n    ')}`);
      } else {
        console.log(`✓ ${basename(path)} › ${name}`);
      }
    }
  }
  // Server rules, checked alongside the rest of the bank so id clashes are caught too.
  const given = new Set(files.map((f) => f.path));
  const bank = readdirSync(bankDir).filter((f) => f.endsWith('.json') && !given.has(join(bankDir, f)))
    .map((f) => ({ file: f, defs: readDefs(join(bankDir, f)) }));
  const staticDir = join(ROOT, 'static');
  const { errors, warnings } = validateDefs(category, [...bank, ...files], {
    imageExists: (p) => existsSync(join(staticDir, p.slice('/static/'.length))),
  });
  for (const w of warnings) console.warn(`! ${w}`);
  if (errors.length) {
    failed = true;
    console.error(`✗ server content rules:\n    ${errors.join('\n    ')}`);
  }
  if (failed) process.exit(1);
  console.log(`All ${noun} valid.`);
}

