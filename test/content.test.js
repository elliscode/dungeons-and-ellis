import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadContent } from '../server/content.js';
import { validateDefs } from '../core/content.js';
import { openDb } from '../server/db.js';
import { TemplateStore } from '../server/templates.js';
import { GameService } from '../server/games/service.js';
import { FIXTURE_DATA, fixedSettings } from './helpers.js';

function tempContent() {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-content-'));
  for (const sub of ['characters', 'monsters', 'npcs']) cpSync(join(FIXTURE_DATA, sub), join(dir, sub), { recursive: true });
  cpSync(join(FIXTURE_DATA, 'acts.json'), join(dir, 'acts.json'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const goodMonster = { id: 'slime', name: 'Slime', maxHp: 5, defense: 8, attacks: [{ id: 'ooze', name: 'Ooze', attack: '1d20+1', damage: '1d4', range: 1 }] };

test('validateDefs reports readable errors', () => {
  const { errors } = validateDefs('characters', [
    { file: 'a.json', defs: [{ id: 'hero', name: 'Hero', role: 'wizard', maxHp: 10, attacks: [{ id: 'x', name: 'X', attack: '1d7', damage: '1d6' }] }] },
    { file: 'b.json', defs: [{ id: 'hero', maxHp: 0 }] },
  ]);
  const all = errors.join('\n');
  assert.match(all, /a\.json › hero: role must be one of/);
  assert.match(all, /attacks\[0\]\.attack "1d7" is not valid dice/);
  assert.match(all, /b\.json › hero: duplicate id \(also in a\.json\)/);
  assert.match(all, /name is required/);
  assert.match(all, /maxHp must be a number/);
  assert.equal(validateDefs('monsters', [{ file: 'm.json', defs: [goodMonster] }]).errors.length, 0);
});

test('invalid writes are rejected and change nothing', () => {
  const { dir, cleanup } = tempContent();
  try {
    const c = loadContent(dir);
    const before = readFileSync(join(dir, 'monsters', 'monsters.json'), 'utf8');
    assert.throws(() => c.writeFile('monsters', 'monsters.json', '[{ nope'), (e) => /invalid JSON/.test(e.errors.join()));
    assert.throws(() => c.writeFile('monsters', 'monsters.json', JSON.stringify([{ ...goodMonster, id: 'goblin' }, { ...goodMonster, id: 'goblin' }])), (e) => /duplicate id/.test(e.errors.join()));
    assert.equal(readFileSync(join(dir, 'monsters', 'monsters.json'), 'utf8'), before);
    assert.ok(c.def('monster', 'dragon'), 'old content still loaded');
  } finally { cleanup(); }
});

test('valid writes reload live for the game service', () => {
  const { dir, cleanup } = tempContent();
  try {
    const c = loadContent(dir);
    const db = openDb(':memory:');
    const templates = new TemplateStore(db);
    const service = new GameService({ db, content: c, templates, settings: fixedSettings() });
    const game = service.createGame('Live');
    let changes = 0;
    c.on('change', () => changes++);
    c.writeFile('monsters', 'extra.json', JSON.stringify([goodMonster]), { create: true });
    assert.equal(changes, 1);
    assert.ok(c.monsters.some((m) => m.id === 'slime'));
    const tpl = templates.create({ name: 'R', grid: { cols: 5, rows: 5 } });
    const sid = service.dispatch(game.id, { role: 'dm' }, { type: 'scene.add', templateId: tpl.id }).result.sceneId;
    service.dispatch(game.id, { role: 'dm' }, { type: 'scene.activate', sceneId: sid });
    assert.equal(service.dispatch(game.id, { role: 'dm' }, { type: 'entity.spawn', kind: 'monster', defId: 'slime' }).ok, true);
    assert.throws(() => c.writeFile('monsters', 'extra.json', '[]', { create: true }), /already exists/);
    c.deleteFile('monsters', 'extra.json');
    assert.equal(c.def('monster', 'slime'), null);
    assert.equal(existsSync(join(dir, 'monsters', 'extra.json')), false);
    service.close();
  } finally { cleanup(); }
});

test('file names cannot escape the content folders', () => {
  const { dir, cleanup } = tempContent();
  try {
    const c = loadContent(dir);
    for (const bad of ['../x.json', 'foo/../../one-and-done.sqlite', 'x.txt', '.hidden.json', 'A.json']) {
      assert.throws(() => c.writeFile('monsters', bad, '[]'), /File names/, bad);
      assert.throws(() => c.readFile('monsters', bad), /File names/, bad);
    }
    assert.throws(() => c.readFile('secrets', 'x.json'), /Unknown category/);
    assert.throws(() => c.writeFile('acts', 'other.json', '[]'), /File names/);
    assert.throws(() => c.deleteFile('acts', 'acts.json'), /cannot be deleted/);
  } finally { cleanup(); }
});

test('edits on disk are picked up by the watcher; bad edits are ignored', async () => {
  const { dir, cleanup } = tempContent();
  const c = loadContent(dir, { watchFiles: true });
  try {
    writeFileSync(join(dir, 'npcs', 'more.json'), JSON.stringify([{ id: 'bard-npc', name: 'Wandering Bard', maxHp: 6 }]));
    // fs.watch delivery can lag when the machine is busy (tests run in parallel): poll.
    for (let i = 0; i < 80 && !c.def('npc', 'bard-npc'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(c.def('npc', 'bard-npc'), 'watcher reloaded the new file');
    writeFileSync(join(dir, 'npcs', 'more.json'), '[{ broken');
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(c.def('npc', 'bard-npc'), 'kept last good content');
  } finally { c.close(); cleanup(); }
});
