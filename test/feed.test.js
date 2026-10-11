import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { io as connect } from 'socket.io-client';
import { openDb } from '../server/db.js';
import { createServer } from '../server/index.js';
import { setup, ok, DM, FIXTURE_DATA } from './helpers.js';

test('only real outcomes carry badge markers; player-typed text cannot fake one', () => {
  const s = setup();
  const fake = '\uE000HIT\uE001';
  const a = s.join(`${fake} Ana`);
  ok(s.run(a, { type: 'player.setName', name: `MISS ${fake}` }));
  ok(s.run(a, { type: 'player.selectCharacter', characterId: 'shadow-rogue' }));
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const ea = s.state().players[a.playerId].entityId;
  ok(s.run(a, { type: 'act', entityId: ea, text: `I ${fake} the lever` }));
  s.service.chat(s.game.id, a, `nice ${fake}`);
  const gob = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 1, y: 7 })).entityId;
  ok(s.run(DM, { type: 'combat.start' }));
  s.rng.push(1); // natural 1: a real MISS
  ok(s.run(a, { type: 'attack', entityId: ea, attackId: 'twin-daggers', targetId: gob }));
  const texts = s.service.history(s.game.id, 'player').feed.map((f) => f.text);
  const marked = texts.filter((t) => /[\uE000\uE001]/.test(t));
  assert.equal(marked.length, 1, 'only the attack line is marked');
  assert.match(marked[0], /\uE000MISS\uE001/);
  assert.ok(texts.some((t) => t.includes('I HIT the lever')), 'typed HIT stays plain text');
  assert.equal(s.state().players[a.playerId].name, 'MISS HIT');
});

test('chat and game events share one chronological feed with stable ids', () => {
  const s = setup();
  const a = s.join('Ana');
  s.service.chat(s.game.id, a, 'hello');
  ok(s.run(DM, { type: 'roll', expr: '1d6' }));
  s.service.chat(s.game.id, DM, 'welcome');
  ok(s.service.chat(s.game.id, a, '/roll 2d6'));
  const feed = s.service.history(s.game.id, 'player').feed;
  assert.deepEqual(feed.map((f) => f.kind), ['event', 'chat', 'event', 'chat', 'event']);
  assert.match(feed[0].text, /joined/);
  assert.equal(feed[1].name, 'Ana');
  assert.equal(feed[1].color, s.state().players[a.playerId].color, 'player color on chat');
  assert.match(feed[4].text, /Ana rolls 2d6/);
  const ids = feed.map((f) => f.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'ids increase');
  assert.deepEqual(s.service.history(s.game.id, 'player').feed.map((f) => f.id), ids, 'same ids on reload');
});

test('player history starts when the player joined', () => {
  const s = setup();
  ok(s.run(DM, { type: 'roll', expr: '1d20' }));
  s.service.chat(s.game.id, DM, 'testing testing');
  s.clock.t += 1000;
  const a = s.join('Ana');
  ok(s.run(DM, { type: 'roll', expr: '1d6' }));
  const since = s.state().players[a.playerId].joinedAt;
  const texts = s.service.history(s.game.id, 'player', { since }).feed.map((f) => f.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /Ana joined/);
  assert.match(texts[1], /DM rolls 1d6/);
  assert.equal(s.service.history(s.game.id, 'dm').feed.length, 4, 'the DM still sees everything');
});

test('DM-only events and hidden HP never reach players', () => {
  const s = setup();
  const tpl = s.templates.create({ name: 'R', grid: { cols: 6, rows: 6 } });
  ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })); // DM-only feed row
  ok(s.run(DM, { type: 'roll', expr: '1d20', secret: true }));
  const sid = s.state().sceneOrder[0];
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const gob = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin' })).entityId;
  ok(s.run(DM, { type: 'entity.damage', entityId: gob, amount: 3 }));
  const player = s.service.history(s.game.id, 'player').feed;
  const dm = s.service.history(s.game.id, 'dm').feed;
  assert.ok(dm.length > player.length);
  assert.ok(dm.some((f) => f.dmOnly && /added scene/.test(f.text)));
  assert.ok(!player.some((f) => /added scene|DM rolls/.test(f.text)));
  assert.ok(!player.some((f) => /6\/9/.test(f.text)));
  assert.ok(dm.some((f) => /Goblin 6\/9/.test(f.text)));
});

test('one feed row per ability activation, even with several effects', () => {
  const s = setup();
  const tpl = s.templates.create({ name: 'R', grid: { cols: 8, rows: 8 } });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const p = s.join('Juno');
  ok(s.run(p, { type: 'player.selectCharacter', characterId: 'x-wind-monk' }));
  const monk = s.state().players[p.playerId].entityId;
  ok(s.run(DM, { type: 'move', entityId: monk, x: 0, y: 0, force: true }));
  const dummy = ok(s.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'training-dummy', x: 1, y: 0 })).entityId;
  ok(s.run(DM, { type: 'combat.start' }));
  const before = s.service.history(s.game.id, 'player').feed.length;
  ok(s.run(p, { type: 'ability', entityId: monk, abilityId: 'flurry-of-blows', targetId: dummy }));
  const after = s.service.history(s.game.id, 'player').feed;
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).type, 'ability');
  assert.equal(after.at(-1).data.strikes.length, 4);
  assert.doesNotMatch(after.at(-1).text, /slain|DIED/);
});

test('old chat + activity tables migrate into the feed in time order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dne-mig-'));
  try {
    const file = join(dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, player_id TEXT, name TEXT, color TEXT, text TEXT, ts INTEGER);
      CREATE TABLE activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, type TEXT, text TEXT, dm_text TEXT, color TEXT, ts INTEGER);
      INSERT INTO activity_events (game_id, type, text, dm_text, color, ts) VALUES ('g', 'join', 'Ana joined', NULL, '#f00', 100);
      INSERT INTO chat_messages (game_id, player_id, name, color, text, ts) VALUES ('g', 'p1', 'Ana', '#f00', 'hi', 200);
      INSERT INTO activity_events (game_id, type, text, dm_text, color, ts) VALUES ('g', 'scene', '', 'DM added scene', '#d4af37', 300);
      INSERT INTO chat_messages (game_id, player_id, name, color, text, ts) VALUES ('g', 'p1', 'Ana', '#f00', 'bye', 400);`);
    old.close();
    const db = openDb(file);
    const rows = db.prepare('SELECT kind, text, dm_text, visibility, name FROM feed_events ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows.map((r) => r.text || r.dm_text), ['Ana joined', 'hi', 'DM added scene', 'bye']);
    assert.deepEqual(rows.map((r) => r.visibility), ['all', 'all', 'dm', 'all']);
    assert.equal(rows[1].name, 'Ana');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('chat_messages','activity_events')").get().n, 0);
    db.close();
    const again = openDb(file); // idempotent
    assert.equal(again.prepare('SELECT count(*) AS n FROM feed_events').get().n, 4);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('over sockets, players see nothing from before they joined', async () => {
  const server = createServer({ dbFile: ':memory:', password: 'pw', contentDir: FIXTURE_DATA });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
  try {
    const game = server.service.createGame('Setup');
    const dmRoll = (expr) => assert.equal(server.service.dispatch(game.id, DM, { type: 'roll', expr }).ok, true);
    dmRoll('1d4'); // DM testing before anyone joins
    await wait(5);
    const a = connect(`${base}/play`, { transports: ['websocket'], forceNew: true, auth: { joinToken: game.joinToken } });
    sockets.push(a);
    const live = [];
    a.on('feed', (rows) => live.push(...rows));
    assert.deepEqual((await new Promise((r) => a.once('history', r))).feed, [], 'join screen: no history');
    dmRoll('1d8');
    await wait(50);
    assert.equal(live.length, 0, 'join screen: no live events');
    const historyAfterJoin = new Promise((r) => a.once('history', r));
    const ja = await emit(a, 'join', { name: 'Ana' });
    const joined = (await historyAfterJoin).feed.map((f) => f.text);
    assert.equal(joined.length, 1);
    assert.match(joined[0], /Ana joined/);
    dmRoll('1d12');
    await wait(50);
    assert.ok(live.some((f) => /1d12/.test(f.text)), 'live events after joining');
    a.disconnect();
    const a2 = connect(`${base}/play`, { transports: ['websocket'], forceNew: true, auth: { joinToken: game.joinToken, playerId: ja.playerId, seatSecret: ja.seatSecret } });
    sockets.push(a2);
    const texts = (await new Promise((r) => a2.once('history', r))).feed.map((f) => f.text).join('\n');
    assert.match(texts, /Ana joined[\s\S]*1d12/, 'reconnect: everything since joining');
    assert.doesNotMatch(texts, /1d4|1d8/, 'reconnect: nothing from before');
  } finally {
    for (const s of sockets) s.disconnect();
    await server.close();
  }
});

test('feed events arrive live over sockets and reconnects load history without duplicates', async () => {
  const server = createServer({ dbFile: ':memory:', password: 'pw', contentDir: FIXTURE_DATA });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  const open = (opts) => { const s = connect(`${base}/play`, { transports: ['websocket'], forceNew: true, ...opts }); sockets.push(s); return s; };
  const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
  try {
    const game = server.service.createGame('Live');
    const a = open({ auth: { joinToken: game.joinToken } });
    const b = open({ auth: { joinToken: game.joinToken } });
    await Promise.all([new Promise((r) => a.once('history', r)), new Promise((r) => b.once('history', r))]);
    const ja = await emit(a, 'join', { name: 'Ana' });
    await emit(b, 'join', { name: 'Bo' });
    const got = new Promise((r) => b.on('feed', (rows) => { const m = rows.find((x) => x.kind === 'chat'); if (m) r(m); }));
    await emit(a, 'chat', 'ping');
    const msg = await got;
    assert.equal(msg.text, 'ping');
    a.disconnect();
    const a2 = open({ auth: { joinToken: game.joinToken, playerId: ja.playerId, seatSecret: ja.seatSecret } });
    const { feed } = await new Promise((r) => a2.once('history', r));
    const ids = feed.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    assert.equal(feed.filter((f) => f.kind === 'chat' && f.text === 'ping').length, 1);
  } finally {
    for (const s of sockets) s.disconnect();
    await server.close();
  }
});
