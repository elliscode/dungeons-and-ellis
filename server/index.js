import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import { openDb } from './db.js';
import { loadContent, ContentError } from './content.js';
import { createAssetStore, AssetError, MAX_ASSET_BYTES } from './assets.js';
import { createAuth, DM_COOKIE } from './auth.js';
import { TemplateStore } from './templates.js';
import { GameService } from './games/service.js';
import { GameError } from './games/state.js';
import { attachSockets } from './sockets.js';
import { previewMeta, renderPlayPage } from './preview.js';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createServer({
  dbFile = join(ROOT, 'data', 'd-and-e.sqlite'),
  contentDir = join(ROOT, 'data'),
  staticDir = join(ROOT, 'static'),
  clientDir = join(ROOT, 'client'),
  password,
  secret,
  graceMs = 60_000,
  secureCookies = false,
  watchContent = false,
  publicUrl = null,
} = {}) {
  const db = openDb(dbFile);
  const content = loadContent(contentDir, { staticDir, watchFiles: watchContent });
  const assets = createAssetStore(staticDir);
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
      if (err instanceof ContentError) return res.status(err.status).json({ error: err.message, errors: err.errors, warnings: err.warnings });
      if (err instanceof AssetError) return res.status(err.status).json({ error: err.message });
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

  // ---- assets (static art) ----
  const assetUsage = () => {
    const counts = templates.imageRefs();
    for (const d of [...content.characters, ...content.monsters, ...content.npcs]) {
      if (d.image) counts.set(d.image, (counts.get(d.image) ?? 0) + 1);
    }
    return (path) => counts.get(path) ?? 0;
  };
  // Plain path lists (used by the scene editor palettes).
  app.get('/api/assets', requireDm, handle(() => assets.paths()));
  app.get('/api/assets/files', requireDm, handle(() => assets.list(assetUsage())));
  app.post('/api/assets/:folder', requireDm, express.raw({ type: () => true, limit: MAX_ASSET_BYTES }), handle((req) => {
    const r = assets.save(req.params.folder, req.query.name, req.body, { overwrite: req.query.overwrite === '1' });
    notifyContent();
    return r;
  }));
  app.delete('/api/assets/:folder/:name', requireDm, handle((req) => {
    assets.remove(req.params.folder, req.params.name);
    notifyContent();
    return { ok: true };
  }));

  // ---- data (definition JSON files) ----
  const textBody = express.text({ type: () => true, limit: '2mb' });
  app.get('/api/data', requireDm, handle(() => content.listFiles()));
  app.get('/api/data/:category/:file', requireDm, handle((req) => ({ text: content.readFile(req.params.category, req.params.file) })));
  app.put('/api/data/:category/:file', requireDm, textBody, handle((req) => ({ ok: true, ...content.writeFile(req.params.category, req.params.file, req.body) })));
  app.post('/api/data/:category', requireDm, textBody, handle((req) => {
    const text = typeof req.body === 'string' && req.body.trim() ? req.body : '[]';
    return { ok: true, ...content.writeFile(req.params.category, req.query.name, text, { create: true }) };
  }));
  app.delete('/api/data/:category/:file', requireDm, handle((req) => {
    content.deleteFile(req.params.category, req.params.file);
    return { ok: true };
  }));

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
  // Player page, with per-game link-preview metadata rendered into the HTML for crawlers.
  app.get('/g/:token', (req, res) => {
    const base = (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const game = service.getByToken(req.params.token);
    const html = renderPlayPage(readFileSync(join(clientDir, 'play.html'), 'utf8'), previewMeta({ game, base, staticDir }));
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  app.get('/assets', page('assets.html'));
  app.get('/data', page('data.html'));
  // No caching so replaced uploads show up immediately (ETags still avoid re-downloads). The CSP
  // keeps an uploaded SVG from running scripts if someone opens it directly.
  app.use('/static', (req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(staticDir, { maxAge: 0 }));
  app.use(express.static(clientDir, { index: false }));

  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, { serveClient: true });
  attachSockets(io, { service, auth });

  // Tell every open page that definitions or art changed so it can refetch.
  let notifyTimer = null;
  function notifyContent() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      io.of('/play').emit('contentChanged');
      io.of('/dm').emit('contentChanged');
    }, 50);
  }
  content.on('change', notifyContent);

  return {
    app, httpServer, io, service, db, content,
    close() {
      service.close();
      content.close();
      clearTimeout(notifyTimer);
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
    watchContent: true,
    publicUrl: process.env.PUBLIC_URL || null,
  });
  server.httpServer.listen(port, host, () => console.log(`One & Done listening on http://${host}:${port}`));
  const shutdown = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
