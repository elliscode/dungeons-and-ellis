import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import { openDb } from './db.js';
import { loadContent } from './content.js';
import { createAuth, DM_COOKIE } from './auth.js';
import { TemplateStore } from './templates.js';
import { GameService } from './games/service.js';
import { GameError } from './games/state.js';
import { attachSockets } from './sockets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function createServer({
  dbFile = join(ROOT, 'data', 'd-and-e.sqlite'),
  contentDir = join(ROOT, 'data'),
  staticDir = join(ROOT, 'static'),
  clientDir = join(ROOT, 'client'),
  password,
  secret,
  graceMs = 60_000,
  secureCookies = false,
} = {}) {
  const db = openDb(dbFile);
  const content = loadContent(contentDir);
  const auth = createAuth({ password, secret });
  const templates = new TemplateStore(db);
  const service = new GameService({ db, content, templates, graceMs });
  service.restoreAll();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));

  const requireDm = (req, res, next) => (auth.isDmCookieHeader(req.headers.cookie) ? next() : res.status(401).json({ error: 'DM login required' }));
  const handle = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      if (err instanceof GameError) return res.status(400).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  };

  // ---- auth ----
  app.post('/api/login', async (req, res) => {
    if (!auth.checkPassword(req.body?.password)) {
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ error: 'Wrong password' });
    }
    res.cookie(DM_COOKIE, auth.issueToken(), {
      httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: auth.cookieMaxAgeMs, path: '/',
    });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    res.clearCookie(DM_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => res.json({ dm: auth.isDmCookieHeader(req.headers.cookie) }));

  // ---- content ----
  app.get('/api/content/public', (req, res) => res.json(content.publicContent()));
  app.get('/api/content', requireDm, (req, res) => res.json(content.dmContent()));
  app.get('/api/assets', requireDm, (req, res) => {
    const list = (sub) => {
      const dir = join(staticDir, sub);
      return existsSync(dir) ? readdirSync(dir).filter((f) => IMAGE_EXT.test(f)).sort().map((f) => `/static/${sub}/${f}`) : [];
    };
    res.json({ backgrounds: list('backgrounds'), tokens: list('tokens'), images: list('images') });
  });

  // ---- scene templates ----
  app.get('/api/scenes', requireDm, handle(() => templates.list()));
  app.post('/api/scenes', requireDm, handle((req) => templates.create(req.body)));
  app.get('/api/scenes/:id', requireDm, (req, res) => {
    const t = templates.get(req.params.id);
    if (t) res.json(t);
    else res.status(404).json({ error: 'Scene not found' });
  });
  app.put('/api/scenes/:id', requireDm, handle((req) => templates.update(req.params.id, req.body)));
  app.delete('/api/scenes/:id', requireDm, handle((req) => ({ ok: templates.delete(req.params.id) })));

  // ---- games ----
  app.get('/api/games', requireDm, handle(() => service.listGames()));
  app.post('/api/games', requireDm, handle((req) => service.createGame(req.body?.name)));
  app.delete('/api/games/:id', requireDm, handle((req) => ({ ok: service.deleteGame(req.params.id) })));

  // ---- pages ----
  const page = (file) => (req, res) => res.sendFile(join(clientDir, file));
  app.get('/', page('index.html'));
  app.get('/login', page('login.html'));
  app.get('/scenes/:id', page('scene-editor.html'));
  app.get('/games/:id', page('dm-game.html'));
  app.get('/g/:token', page('play.html'));
  app.use('/static', express.static(staticDir, { maxAge: '1h' }));
  app.use(express.static(clientDir, { index: false }));

  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, { serveClient: true });
  attachSockets(io, { service, auth });

  return {
    app, httpServer, io, service, db,
    close() {
      service.close();
      return new Promise((r) => io.close(() => { db.close(); r(); }));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = process.env.DM_PASSWORD;
  if (!password) {
    console.error('DM_PASSWORD is not set. Copy .env.example to .env and set it.');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({
    dbFile: process.env.DB_FILE || undefined,
    password,
    secret: process.env.SESSION_SECRET,
    graceMs: Number(process.env.RECONNECT_GRACE_MS) || 60_000,
    secureCookies: process.env.SECURE_COOKIES === 'true',
  });
  server.httpServer.listen(port, host, () => console.log(`D&E listening on http://${host}:${port}`));
  const shutdown = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
