import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server/index.js';
import { FIXTURE_DATA } from './helpers.js';

test('role strength setting over HTTP: DM only, presets only, live for tiles and feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-settings-api-'));
  cpSync(FIXTURE_DATA, dir, { recursive: true });
  const server = createServer({ dbFile: ':memory:', password: 'pw', contentDir: dir });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  try {
    const put = (body, cookie) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await put({ roleStrength: 3 })).status, 401, 'needs DM');
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const current = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
    assert.equal(current.roleStrength, 4);
    assert.deepEqual(current.options.map((o) => o.value), [1, 2, 3, 4, 5]);
    assert.match(current.options[2].label, /3 — Tank ⅓ · DPS 3× · Heal 3×/);

    for (const bad of [0, 6, 2.5, 'x']) assert.equal((await put({ roleStrength: bad }, cookie)).status, 400, String(bad));

    const game = server.service.createGame('Live');
    server.service.get(game.id); // loaded, like an open game
    const r = await put({ roleStrength: 3 }, cookie);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).roleStrength, 3);
    assert.ok(existsSync(join(dir, 'settings.json')));
    const roles = (await (await fetch(`${base}/api/content/public`)).json()).roles;
    assert.equal(roles.dps.blurb, 'Deals 3× damage');
    const dmFeed = server.service.history(game.id, 'dm').feed.at(-1);
    assert.equal(dmFeed.dmOnly, true);
    assert.match(dmFeed.text, /Role strength changed from 4 to 3/);
    assert.ok(!server.service.history(game.id, 'player').feed.some((f) => /Role strength/.test(f.text)), 'players do not see it');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
