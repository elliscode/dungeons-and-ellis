import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server/index.js';
import { imageSize } from '../server/preview.js';
import { FIXTURE_DATA, ROOT } from './helpers.js';

const pngOf = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const meta = (html, key) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`));
  return m ? m[1] : null;
};

test('imageSize reads PNG, GIF, WebP and JPEG headers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-img-'));
  try {
    writeFileSync(join(dir, 'a.png'), pngOf(800, 600));
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    writeFileSync(join(dir, 'a.gif'), gif);
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1'); vp8x.write('WEBPVP8X', 8, 'latin1'); vp8x.writeUIntLE(1919, 24, 3); vp8x.writeUIntLE(1079, 27, 3);
    writeFileSync(join(dir, 'a.webp'), vp8x);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0, 0, 0]);
    writeFileSync(join(dir, 'a.jpg'), jpg);
    assert.deepEqual(imageSize(join(dir, 'a.png')), { width: 800, height: 600 });
    assert.deepEqual(imageSize(join(dir, 'a.gif')), { width: 320, height: 240 });
    assert.deepEqual(imageSize(join(dir, 'a.webp')), { width: 1920, height: 1080 });
    assert.deepEqual(imageSize(join(dir, 'a.jpg')), { width: 800, height: 600 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('game share links carry per-game Open Graph metadata without JavaScript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-og-'));
  const staticDir = join(dir, 'static');
  mkdirSync(join(staticDir, 'backgrounds'), { recursive: true });
  writeFileSync(join(staticDir, 'backgrounds', 'swamp.png'), pngOf(1280, 896));
  writeFileSync(join(staticDir, 'backgrounds', 'tavern.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(staticDir, 'backgrounds', 'tavern.png'), pngOf(640, 480));
  writeFileSync(join(staticDir, 'backgrounds', 'cave.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  copyFileSync(join(ROOT, 'static', 'og-default.png'), join(staticDir, 'og-default.png'));
  const server = createServer({ dbFile: ':memory:', password: 'pw', staticDir, contentDir: FIXTURE_DATA, publicUrl: 'https://oneshot.elliscode.com/' });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { service } = server;
  const DM = { role: 'dm' };
  try {
    const game = service.createGame('SpEllis');
    // A player with a name, to prove it never leaks into the preview.
    service.dispatch(game.id, { role: 'join' }, { type: 'player.create', name: 'SecretPlayerName' });
    const page = async (token = game.joinToken) => {
      const res = await fetch(`${base}/g/${token}`);
      assert.equal(res.status, 200);
      return res.text();
    };

    let html = await page();
    assert.equal(meta(html, 'og:title'), 'SpEllis');
    assert.equal(meta(html, 'og:description'), 'Join my game on One &amp; Done!');
    assert.equal(meta(html, 'og:type'), 'website');
    assert.equal(meta(html, 'og:url'), `https://oneshot.elliscode.com/g/${game.joinToken}`);
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
    assert.equal(meta(html, 'twitter:title'), 'SpEllis');
    assert.equal(meta(html, 'twitter:description'), 'Join my game on One &amp; Done!');
    assert.match(meta(html, 'og:image'), /^https:\/\/oneshot\.elliscode\.com\/static\/og-default\.png\?v=default-\d+$/, 'fallback with no active scene');
    assert.equal(meta(html, 'og:image:width'), '1200');
    assert.equal(meta(html, 'twitter:image'), meta(html, 'og:image'));
    assert.match(html, /<title>SpEllis<\/title>/);
    assert.match(html, /<script type="module" src="\/js\/play\.js"><\/script>/, 'player app still served');
    for (const secret of ['SecretPlayerName', 'seatSecret', 'p_']) assert.ok(!html.includes(secret), secret);

    // Activating a scene switches the preview image to its map.
    const make = (name, background) => server.service.templates.create({ name, background, grid: { cols: 5, rows: 5 } });
    const swamp = service.dispatch(game.id, DM, { type: 'scene.add', templateId: make('Swamp', '/static/backgrounds/swamp.png').id }).result.sceneId;
    service.dispatch(game.id, DM, { type: 'scene.activate', sceneId: swamp });
    html = await page();
    assert.match(meta(html, 'og:image'), new RegExp(`^https://oneshot\\.elliscode\\.com/static/backgrounds/swamp\\.png\\?v=${swamp}-\\d+$`));
    assert.equal(meta(html, 'og:image:width'), '1280');
    assert.equal(meta(html, 'og:image:height'), '896');

    // SVG maps use a same-named raster sibling, or the fallback if there is none.
    const tavern = service.dispatch(game.id, DM, { type: 'scene.add', templateId: make('Tavern', '/static/backgrounds/tavern.svg').id }).result.sceneId;
    service.dispatch(game.id, DM, { type: 'scene.activate', sceneId: tavern });
    assert.match(meta(await page(), 'og:image'), /\/static\/backgrounds\/tavern\.png\?v=/);
    const cave = service.dispatch(game.id, DM, { type: 'scene.add', templateId: make('Cave', '/static/backgrounds/cave.svg').id }).result.sceneId;
    service.dispatch(game.id, DM, { type: 'scene.activate', sceneId: cave });
    assert.match(meta(await page(), 'og:image'), /\/static\/og-default\.png\?v=/);

    // Titles are escaped; unknown links get generic metadata.
    service.dispatch(game.id, DM, { type: 'dm.renameGame', name: '<script>alert(1)</script> & co' });
    html = await page();
    assert.equal(meta(html, 'og:title'), '&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    assert.ok(!html.includes('<script>alert(1)'));
    html = await page('not-a-real-token');
    assert.equal(meta(html, 'og:title'), 'One &amp; Done');
    assert.equal(meta(html, 'og:url'), 'https://oneshot.elliscode.com/');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
