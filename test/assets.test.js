import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server/index.js';
import { sanitizeAssetName } from '../server/assets.js';
import { FIXTURE_DATA } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('sanitizes names', () => {
  assert.equal(sanitizeAssetName('My Map (v2).PNG'), 'my-map-v2.png');
  assert.equal(sanitizeAssetName('C:\\\\pics\\\\Cave.jpg'), 'cave.jpg');
  for (const bad of ['evil.html', '..', '.png', 'x.exe', '']) assert.throws(() => sanitizeAssetName(bad), bad);
});

test('asset upload, replace, list, delete over HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-assets-'));
  const server = createServer({ dbFile: ':memory:', password: 'pw', staticDir: join(dir, 'static'), contentDir: FIXTURE_DATA });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  try {
    const up = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } });
    assert.equal((await up('/api/assets/backgrounds?name=a.png', PNG)).status, 401, 'needs DM');

    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const dmUp = (path, body) => up(path, body, { cookie });

    let r = await dmUp('/api/assets/backgrounds?name=Big%20Cave.png', PNG);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { name: 'big-cave.png', path: '/static/backgrounds/big-cave.png', replaced: false });
    assert.ok(existsSync(join(dir, 'static', 'backgrounds', 'big-cave.png')));

    assert.equal((await dmUp('/api/assets/backgrounds?name=big-cave.png', PNG)).status, 409);
    const PNG2 = Buffer.concat([PNG, Buffer.from('more')]);
    r = await dmUp('/api/assets/backgrounds?name=big-cave.png&overwrite=1', PNG2);
    assert.equal((await r.json()).replaced, true);
    assert.equal(readFileSync(join(dir, 'static', 'backgrounds', 'big-cave.png')).length, PNG2.length);

    assert.equal((await dmUp('/api/assets/backgrounds?name=fake.png', Buffer.from('<html>'))).status, 400, 'magic bytes');
    assert.equal((await dmUp('/api/assets/backgrounds?name=x.html', PNG)).status, 400, 'extension');
    assert.equal((await dmUp('/api/assets/secrets?name=x.png', PNG)).status, 404, 'folder');
    assert.equal((await dmUp('/api/assets/tokens?name=t.svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).status, 200);

    const list = await (await fetch(`${base}/api/assets/files`, { headers: { cookie } })).json();
    assert.equal(list.backgrounds[0].name, 'big-cave.png');
    assert.equal(list.tokens[0].name, 't.svg');

    const served = await fetch(`${base}/static/tokens/t.svg`);
    assert.match(served.headers.get('content-security-policy'), /default-src 'none'/);

    const del = (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await del('/api/assets/backgrounds/..%2F..%2Fpackage.json')).status, 400);
    assert.equal((await del('/api/assets/backgrounds/big-cave.png')).status, 200);
    assert.equal(existsSync(join(dir, 'static', 'backgrounds', 'big-cave.png')), false);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
