// Validates character JSON against schemas/character.schema.json and the server's own content
// rules (the same checks the Data page runs), so generated characters can be checked before use.
//
//   npm run validate:characters                  # the whole data/characters roster
//   npm run validate:characters -- new-hero.json # one or more files (a character object or an array)
//
// Exits 1 if anything fails.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateDefs } from '../server/content.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER = join(ROOT, 'data', 'characters');
export const SCHEMA_PATH = join(ROOT, 'schemas', 'character.schema.json');

export function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: true, strictTypes: false, strictRequired: false });
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
}

// Readable "path: message" lines for one character.
export function schemaErrors(validate, def) {
  if (validate(def)) return [];
  return validate.errors.map((e) => {
    const extra = e.keyword === 'additionalProperties' ? ` "${e.params.additionalProperty}"`
      : e.keyword === 'enum' ? `: ${e.params.allowedValues.join(', ')}` : '';
    return `${e.instancePath || '/'} ${e.message}${extra}`;
  });
}

// Checks JSON Schema can't express: ids unique within a character.
export function extraErrors(def) {
  const errors = [];
  for (const k of ['attacks', 'abilities']) {
    const ids = (def?.[k] ?? []).map((x) => x?.id);
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`/${k} duplicate id "${id}"`);
  }
  return errors;
}

function readDefs(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function main(args) {
  const targets = args.length ? args.map((a) => resolve(a)) : readdirSync(ROSTER).filter((f) => f.endsWith('.json')).map((f) => join(ROSTER, f));
  const validate = compileSchema();
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

  // Server rules, checked alongside the existing roster so id clashes are caught too.
  const given = new Set(files.map((f) => f.path));
  const roster = readdirSync(ROSTER).filter((f) => f.endsWith('.json') && !given.has(join(ROSTER, f)))
    .map((f) => ({ file: f, defs: readDefs(join(ROSTER, f)) }));
  const staticDir = join(ROOT, 'static');
  const { errors, warnings } = validateDefs('characters', [...roster, ...files], {
    imageExists: (p) => existsSync(join(staticDir, p.slice('/static/'.length))),
  });
  for (const w of warnings) console.warn(`! ${w}`);
  if (errors.length) {
    failed = true;
    console.error(`✗ server content rules:\n    ${errors.join('\n    ')}`);
  }
  if (failed) process.exit(1);
  console.log('All characters valid.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
