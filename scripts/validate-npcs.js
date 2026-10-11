// Validates NPC JSON against schemas/npc.schema.json and the server's own content rules
// (the same checks the Data page runs), so generated NPCs can be checked before use.
//
//   npm run validate:npcs                 # the whole data/npcs bank
//   npm run validate:npcs -- new-npc.json # one or more files (an NPC object or an array)
//
// Exits 1 if anything fails.
import { fileURLToPath } from 'node:url';
import { validateBank } from './validate-bank.js';
import { NPC_SCHEMA } from './build-npc-schema.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateBank({ category: 'npcs', schemaPath: NPC_SCHEMA, noun: 'NPCs' }, process.argv.slice(2));
}
