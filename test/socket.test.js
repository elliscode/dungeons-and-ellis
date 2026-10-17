import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { io as connect } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { FIXTURE_DATA } from './helpers.js';

async function start(dbFile) {
  const server = createServer({ dbFile, password: 'pw', graceMs: 100, contentDir: FIXTURE_DATA });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { server, base };
}

const once = (sock, ev) => new Promise((r) => sock.once(ev, r));
const emit = (sock, ev, data) => new Promise((r) => sock.emit(ev, data, r));
// Resolve with the next state matching a predicate.
const waitState = (sock, pred) => new Promise((resolve) => {
  const h = (s) => { if (pred(s)) { sock.off('state', h); resolve(s); } };
  sock.on('state', h);
});

test('multiplayer flow over sockets, auth boundaries, and restart recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-sock-'));
  const dbFile = join(dir, 'db.sqlite');
  const sockets = [];
  const open = (base, ns, opts) => { const s = connect(`${base}${ns}`, { transports: ['websocket'], forceNew: true, ...opts }); sockets.push(s); return s; };
  let srv;
  try {
    srv = await start(dbFile);
    const { base } = srv;

    // DM login: wrong password rejected, right one sets cookie.
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"nope"}' })).status, 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"pw"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const dmFetch = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    }).then((r) => r.json());
    assert.equal((await fetch(`${base}/api/games`)).status, 401, 'games list needs DM');

    const game = await dmFetch('/api/games', 'POST', { name: 'Socket Test' });
    const tpl = await dmFetch('/api/scenes', 'POST', { name: 'Hall', grid: { cols: 8, rows: 6 } });

    // A player socket cannot reach the DM namespace.
    const sneaky = open(base, '/dm', { auth: { gameId: game.id } });
    const err = await once(sneaky, 'connect_error');
    assert.equal(err.message, 'unauthorized');

    const dm = open(base, '/dm', { auth: { gameId: game.id }, extraHeaders: { cookie } });
    await once(dm, 'state');

    // Two players join without the DM doing anything.
    const p1 = open(base, '/play', { auth: { joinToken: game.joinToken } });
    const p2 = open(base, '/play', { auth: { joinToken: game.joinToken } });
    await Promise.all([once(p1, 'state'), once(p2, 'state')]);
    const j1 = await emit(p1, 'join', { name: 'Ana' });
    const j2 = await emit(p2, 'join', { name: 'Bo' });
    assert.ok(j1.ok && j2.ok);
    assert.equal((await emit(p1, 'cmd', { type: 'player.selectCharacter', characterId: 'paladin' })).ok, true);
    assert.equal((await emit(p2, 'cmd', { type: 'player.selectCharacter', characterId: 'paladin' })).ok, false);
    assert.equal((await emit(p2, 'cmd', { type: 'player.selectCharacter', characterId: 'bard' })).ok, true);
    assert.equal((await emit(p1, 'cmd', { type: 'combat.start' })).error, 'Not allowed');

    // DM sets up the scene; players are moved in and see it.
    const add = await emit(dm, 'cmd', { type: 'scene.add', templateId: tpl.id });
    const seen = waitState(p2, (s) => s.scene);
    await emit(dm, 'cmd', { type: 'scene.activate', sceneId: add.result.sceneId });
    const s2 = await seen;
    assert.equal(s2.entities.length, 2);
    const gob = await emit(dm, 'cmd', { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 4, y: 4 });

    // Movement broadcasts to the other player; hostile HP never reaches players.
    const me1 = s2.entities.find((e) => e.ownerPlayerId === j1.playerId);
    const moved = waitState(p2, (s) => s.entities.find((e) => e.id === me1.id)?.position.x === 3);
    assert.equal((await emit(p1, 'cmd', { type: 'move', entityId: me1.id, x: 3, y: 5 })).ok, true);
    const s3 = await moved;
    const g = s3.entities.find((e) => e.id === gob.result.entityId);
    assert.ok(g && !('hp' in g));

    // Chat reaches everyone with the sender's color.
    const chatSeen = new Promise((r) => dm.on('feed', (rows) => { const m = rows.find((x) => x.kind === 'chat'); if (m) r(m); }));
    await emit(p2, 'chat', 'hi all');
    const msg = await chatSeen;
    assert.equal(msg.name, 'Bo');
    assert.ok(msg.color);

    // Reconnecting with stored credentials resumes the same seat; a forged secret does not.
    p1.disconnect();
    const p1b = open(base, '/play', { auth: { joinToken: game.joinToken, playerId: j1.playerId, seatSecret: j1.seatSecret } });
    const resumed = await once(p1b, 'state');
    assert.equal(resumed.me.id, j1.playerId);
    assert.equal(resumed.me.characterId, 'paladin');
    const forged = open(base, '/play', { auth: { joinToken: game.joinToken, playerId: j1.playerId, seatSecret: 'x' } });
    await once(forged, 'seatInvalid');
    const fs = await once(forged, 'state');
    assert.equal(fs.me, null);

    // Removing a seat kicks that browser back to the join screen.
    const kicked = once(p2, 'seatInvalid');
    await emit(dm, 'cmd', { type: 'dm.removePlayer', playerId: j2.playerId });
    await kicked;

    // Restart the server on the same DB and resume.
    for (const s of sockets) s.disconnect();
    await srv.server.close();
    srv = await start(dbFile);
    const p1c = open(srv.base, '/play', { auth: { joinToken: game.joinToken, playerId: j1.playerId, seatSecret: j1.seatSecret } });
    const histP = once(p1c, 'history');
    const after = await once(p1c, 'state');
    assert.equal(after.me.characterId, 'paladin');
    assert.deepEqual(after.entities.find((e) => e.id === me1.id).position, { x: 3, y: 5 });
    const hist = await histP;
    assert.ok(hist.feed.some((m) => m.kind === 'chat' && m.text === 'hi all'));
  } finally {
    for (const s of sockets) s.disconnect();
    await srv?.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
