import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adoptLegacyDb } from '../server/index.js';

test('a database from before the rename is moved to the new default name, WAL files included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-rename-'));
  try {
    const legacyFile = join(dir, 'd-and-e.sqlite');
    const defaultFile = join(dir, 'one-and-done.sqlite');
    for (const ext of ['', '-wal', '-shm']) writeFileSync(legacyFile + ext, `old${ext}`);
    assert.equal(adoptLegacyDb(join(dir, 'custom.sqlite'), { defaultFile, legacyFile }), false, 'an explicit DB_FILE is left alone');
    assert.equal(adoptLegacyDb(defaultFile, { defaultFile, legacyFile }), true);
    for (const ext of ['', '-wal', '-shm']) {
      assert.equal(readFileSync(defaultFile + ext, 'utf8'), `old${ext}`);
      assert.ok(!existsSync(legacyFile + ext));
    }
    writeFileSync(legacyFile, 'stale');
    assert.equal(adoptLegacyDb(defaultFile, { defaultFile, legacyFile }), false, 'never overwrites an existing database');
    assert.equal(readFileSync(defaultFile, 'utf8'), 'old');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
