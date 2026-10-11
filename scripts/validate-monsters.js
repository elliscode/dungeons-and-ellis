// Validates monster JSON against schemas/monster.schema.json and the server's own content rules
// (the same checks the Data page runs), so generated monsters can be checked before use.
//
//   npm run validate:monsters                    # the whole data/monsters bank
//   npm run validate:monsters -- new-monster.json  # one or more files (a monster object or an array)
//
// Exits 1 if anything fails.
import { fileURLToPath } from 'node:url';
import { validateBank } from './validate-bank.js';
import { MONSTER_SCHEMA } from './build-monster-schema.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateBank({ category: 'monsters', schemaPath: MONSTER_SCHEMA, noun: 'monsters' }, process.argv.slice(2));
}
