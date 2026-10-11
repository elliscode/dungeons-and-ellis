import { EventEmitter } from 'node:events';
import { randomBytes, randomInt } from 'node:crypto';
import { transaction } from '../db.js';
import { handlers } from './commands.js';
import { GameError, DM_COLOR, newId, createGameState } from './state.js';
import { ensurePlaced } from './placement.js';
import { feedForRole } from './project.js';
import { stripMarkers } from './helpers.js';

const UNDO_LIMIT = 20;
const HISTORY_LIMIT = 300;
const CHAT_MAX = 500;

const allowed = (who, actor) =>
  who === actor.role || (who === 'any' && (actor.role === 'dm' || actor.role === 'player'));

// Owns all live games. Every state change goes through dispatch(): validate + mutate, then
// persist state, Game Feed events and undo snapshot in one transaction, then notify listeners.
export class GameService extends EventEmitter {
  constructor({ db, content, templates, now = Date.now, rng, graceMs = 60_000 }) {
    super();
    this.db = db;
    this.content = content;
    this.templates = templates;
    this.now = now;
    this.rng = rng ?? ((sides) => randomInt(1, sides + 1));
    this.graceMs = graceMs;
    this.games = new Map();
    this.timers = new Map();
    this.presence = new Map(); // gameId -> Map(playerId -> { sockets:Set, lastSeen })
    this.graceTimers = new Set();
  }

  // ---------- game lifecycle ----------

  listGames() {
    return this.db.prepare('SELECT id, name, join_token, state, created_at, updated_at FROM games ORDER BY updated_at DESC')
      .all().map((r) => {
        const s = this.games.get(r.id)?.state ?? JSON.parse(r.state);
        return {
          id: r.id, name: s.name, joinToken: r.join_token, createdAt: r.created_at, updatedAt: r.updated_at,
          players: Object.keys(s.players).length,
          scenes: s.sceneOrder.length,
          activeScene: s.activeSceneId ? s.scenes[s.activeSceneId]?.name : null,
          combat: s.combat.active,
        };
      });
  }

  createGame(name) {
    const clean = String(name ?? '').trim().slice(0, 60) || 'Untitled one-shot';
    const id = newId('g');
    const joinToken = randomBytes(9).toString('base64url');
    const state = createGameState({ id, name: clean, joinToken });
    const t = this.now();
    this.db.prepare('INSERT INTO games (id, name, join_token, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, clean, joinToken, JSON.stringify(state), t, t);
    return { id, joinToken, name: clean };
  }

  deleteGame(id) {
    const changes = transaction(this.db, () => {
      for (const table of ['feed_events', 'undo_snapshots']) {
        this.db.prepare(`DELETE FROM ${table} WHERE game_id = ?`).run(id);
      }
      return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes;
    });
    this.clearTimer(id);
    this.games.delete(id);
    this.presence.delete(id);
    if (changes) this.emit('change', id, { deleted: true });
    return changes > 0;
  }

  get(id) {
    if (typeof id !== 'string') return null;
    let game = this.games.get(id);
    if (game) return game;
    const row = this.db.prepare('SELECT state FROM games WHERE id = ?').get(id);
    if (!row) return null;
    game = { id, state: JSON.parse(row.state) };
    this.games.set(id, game);
    this.syncTimer(game);
    return game;
  }

  getByToken(token) {
    if (typeof token !== 'string') return null;
    const row = this.db.prepare('SELECT id FROM games WHERE join_token = ?').get(token);
    return row ? this.get(row.id) : null;
  }

  // Load every game with a running combat timer so expired phases advance after a restart.
  restoreAll() {
    for (const { id } of this.db.prepare('SELECT id FROM games').all()) this.get(id);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.graceTimers) clearTimeout(t);
    this.timers.clear();
    this.graceTimers.clear();
  }

  // ---------- commands ----------

  dispatch(gameId, actor, cmd) {
    const game = this.get(gameId);
    if (!game) return { ok: false, error: 'Game not found' };
    if (!cmd || typeof cmd.type !== 'string') return { ok: false, error: 'Bad command' };
    if (cmd.type === 'undo') return this.undo(game, actor);
    const h = handlers[cmd.type];
    if (!h) return { ok: false, error: `Unknown command ${cmd.type}` };
    if (!allowed(h.who, actor)) return { ok: false, error: 'Not allowed' };

    const snapshot = structuredClone(game.state);
    const ctx = this.makeCtx(game, actor, cmd);
    let result;
    try {
      if (actor.role === 'player' && !ctx.player) throw new GameError('You are not in this game');
      result = h.run(ctx);
      if (game.state.activeSceneId) ensurePlaced(game.state, game.state.activeSceneId);
    } catch (err) {
      game.state = snapshot;
      if (err instanceof GameError) return { ok: false, error: err.message };
      throw err;
    }

    const rows = this.persist(game, ctx.events, {
      undo: h.undoable ? { label: h.undoable, state: snapshot } : null,
      clearUndo: !!h.clearsUndo,
    });
    this.syncTimer(game);
    this.emit('change', game.id, { feed: rows, fx: ctx.fxs });
    return { ok: true, result };
  }

  makeCtx(game, actor, cmd) {
    const state = game.state;
    const player = actor.role === 'player' ? state.players[actor.playerId] : null;
    const isDm = actor.role === 'dm';
    const ctx = {
      state, actor, cmd, player,
      content: this.content, templates: this.templates, rng: this.rng, now: this.now(),
      actorName: isDm ? 'DM' : player?.name ?? 'System',
      actorColor: isDm ? DM_COLOR : player?.color ?? null,
      events: [], fxs: [],
      log(type, text, opts = {}) {
        const color = opts.color ?? ctx.actorColor;
        const dmText = opts.dmText ?? null;
        const data = opts.data ?? null;
        ctx.events.push(opts.dmOnly
          ? { type, text: '', dmText: dmText ?? text, color, visibility: 'dm', data }
          : { type, text, dmText, color, visibility: 'all', data });
      },
      fx(f) { ctx.fxs.push(f); },
    };
    return ctx;
  }

  persist(game, events, { undo = null, clearUndo = false } = {}) {
    const t = this.now();
    return transaction(this.db, () => {
      this.db.prepare('UPDATE games SET state = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(game.state), game.state.name, t, game.id);
      const rows = events.map((e) => this.insertFeed(game.id, { kind: 'event', ts: t, ...e }));
      if (clearUndo) this.db.prepare('DELETE FROM undo_snapshots WHERE game_id = ?').run(game.id);
      if (undo) {
        this.db.prepare('INSERT INTO undo_snapshots (game_id, label, state, ts) VALUES (?, ?, ?, ?)')
          .run(game.id, undo.label, JSON.stringify(undo.state), t);
        this.db.prepare(`DELETE FROM undo_snapshots WHERE game_id = ? AND id NOT IN
          (SELECT id FROM undo_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT ${UNDO_LIMIT})`).run(game.id, game.id);
      }
      return rows;
    });
  }

  // Appends one Game Feed row and returns it (internal shape; see feedForRole for what viewers get).
  insertFeed(gameId, e) {
    const row = {
      kind: e.kind, type: e.type, text: e.text ?? '', dmText: e.dmText ?? null, visibility: e.visibility ?? 'all',
      color: e.color ?? null, name: e.name ?? null, playerId: e.playerId ?? null, data: e.data ?? null, ts: e.ts ?? this.now(),
    };
    const r = this.db.prepare(`INSERT INTO feed_events (game_id, kind, type, text, dm_text, visibility, color, name, player_id, data, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(gameId, row.kind, row.type, row.text, row.dmText, row.visibility, row.color,
      row.name, row.playerId, row.data ? JSON.stringify(row.data) : null, row.ts);
    return { id: Number(r.lastInsertRowid), ...row };
  }

  // A DM-only Game Feed note in every game that is currently loaded (e.g. a settings change).
  noteToLoadedGames(text) {
    for (const game of this.games.values()) {
      const row = this.insertFeed(game.id, { kind: 'event', type: 'settings', text: '', dmText: text, visibility: 'dm', color: DM_COLOR });
      this.emit('change', game.id, { feed: [row] });
    }
  }

  undoInfo(gameId) {
    const r = this.db.prepare('SELECT label FROM undo_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(gameId);
    return r ? r.label : null;
  }

  // Restores token/HP/turn state from before the last undoable action. Player seats, scenes and
  // combat phase are left alone; commands that change those clear the undo stack.
  undo(game, actor) {
    if (actor.role !== 'dm') return { ok: false, error: 'Not allowed' };
    const row = this.db.prepare('SELECT id, label, state FROM undo_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(game.id);
    if (!row) return { ok: false, error: 'Nothing to undo' };
    const snap = JSON.parse(row.state);
    const s = game.state;
    s.entities = snap.entities;
    s.turn = snap.turn;
    s.pendingChecks = snap.pendingChecks ?? [];
    s.zCounter = Math.max(s.zCounter, snap.zCounter);
    if (s.activeSceneId) ensurePlaced(s, s.activeSceneId);
    this.db.prepare('DELETE FROM undo_snapshots WHERE id = ?').run(row.id);
    const rows = this.persist(game, [{ type: 'undo', text: `DM undid the last ${row.label}`, dmText: null, color: DM_COLOR }]);
    this.emit('change', game.id, { feed: rows, fx: [] });
    return { ok: true, result: { undone: row.label } };
  }

  // ---------- combat timer ----------

  clearTimer(id) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  syncTimer(game) {
    this.clearTimer(game.id);
    const c = game.state.combat;
    if (!c.active || !c.phaseEndsAt) return;
    const endsAt = c.phaseEndsAt;
    const delay = Math.max(0, endsAt - this.now());
    this.timers.set(game.id, setTimeout(() => {
      this.timers.delete(game.id);
      this.dispatch(game.id, { role: 'system' }, { type: 'combat.timerExpired', phaseEndsAt: endsAt });
    }, delay));
  }

  // ---------- chat & history ----------

  chat(gameId, actor, text) {
    const game = this.get(gameId);
    if (!game) return { ok: false, error: 'Game not found' };
    const msg = stripMarkers(String(text ?? '')).trim().slice(0, CHAT_MAX);
    if (!msg) return { ok: false, error: 'Empty message' };
    const roll = msg.match(/^\/r(?:oll)?\s+(.+)$/i);
    if (roll) return this.dispatch(gameId, actor, { type: 'roll', expr: roll[1] });
    let name, color, playerId = null;
    if (actor.role === 'dm') {
      name = 'DM';
      color = DM_COLOR;
    } else {
      const p = game.state.players[actor.playerId];
      if (!p) return { ok: false, error: 'You are not in this game' };
      ({ name, color } = p);
      playerId = p.id;
    }
    const row = this.insertFeed(gameId, { kind: 'chat', type: 'chat', text: msg, name, color, playerId });
    this.emit('change', gameId, { feed: [row] });
    return { ok: true };
  }

  // The most recent Game Feed rows, oldest first, filtered for the viewer's role.
  history(gameId, role) {
    const rows = this.db.prepare(`SELECT * FROM (SELECT id, kind, type, text, dm_text AS dmText, visibility, color, name,
      player_id AS playerId, data, ts FROM feed_events WHERE game_id = ? ORDER BY id DESC LIMIT ${HISTORY_LIMIT}) ORDER BY id`).all(gameId);
    const feed = rows.map((r) => feedForRole({ ...r, data: r.data ? JSON.parse(r.data) : null }, role)).filter(Boolean);
    return { feed };
  }

  // ---------- presence (not persisted) ----------

  presenceOf(gameId) {
    const map = this.presence.get(gameId);
    return (playerId) => {
      const p = map?.get(playerId);
      if (!p) return 'offline';
      if (p.sockets.size) return 'online';
      return this.now() - p.lastSeen < this.graceMs ? 'reconnecting' : 'offline';
    };
  }

  connect(gameId, playerId, socketId) {
    if (!this.presence.has(gameId)) this.presence.set(gameId, new Map());
    const map = this.presence.get(gameId);
    if (!map.has(playerId)) map.set(playerId, { sockets: new Set(), lastSeen: this.now() });
    map.get(playerId).sockets.add(socketId);
    this.emit('change', gameId, { presence: true });
  }

  disconnect(gameId, playerId, socketId) {
    const p = this.presence.get(gameId)?.get(playerId);
    if (!p) return;
    p.sockets.delete(socketId);
    p.lastSeen = this.now();
    this.emit('change', gameId, { presence: true });
    if (!p.sockets.size) {
      const t = setTimeout(() => {
        this.graceTimers.delete(t);
        this.emit('change', gameId, { presence: true });
      }, this.graceMs + 50);
      t.unref?.();
      this.graceTimers.add(t);
    }
  }
}
