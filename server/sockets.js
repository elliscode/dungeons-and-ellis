import { safeEqual } from './auth.js';
import { projectForDm, projectForPlayer, feedForRole } from './games/project.js';

const reply = (ack, result) => { if (typeof ack === 'function') ack(result); };

export function attachSockets(io, { service, auth }) {
  const play = io.of('/play');
  const dm = io.of('/dm');

  function socketsFor(gameId) {
    const out = [];
    for (const ns of [play, dm]) for (const s of ns.sockets.values()) if (s.data.gameId === gameId) out.push(s);
    return out;
  }

  function stateFor(socket) {
    const game = service.get(socket.data.gameId);
    if (!game) return null;
    const presence = service.presenceOf(game.id);
    if (socket.data.role === 'dm') {
      return { ...projectForDm(game.state, presence), undo: service.undoInfo(game.id), serverNow: Date.now() };
    }
    return { ...projectForPlayer(game.state, socket.data.playerId, presence), serverNow: Date.now() };
  }

  service.on('change', (gameId, payload) => {
    const game = service.get(gameId);
    if (!game && !payload.deleted) return;
    for (const s of socketsFor(gameId)) {
      if (payload.deleted) {
        s.emit('fatal', 'This game has been deleted');
        s.disconnect(true);
        continue;
      }
      // A removed seat can no longer act; send the browser back to the join screen.
      if (s.data.role === 'player' && s.data.playerId && !game.state.players[s.data.playerId]) {
        const gone = s.data.playerId;
        s.data.playerId = null; // clear first: disconnect() below emits another change synchronously
        s.emit('seatInvalid');
        service.disconnect(gameId, gone, s.id);
        continue;
      }
      s.emit('state', stateFor(s));
      // Players still on the join screen get no feed until they join.
      if (payload.feed?.length && (s.data.role === 'dm' || s.data.playerId)) {
        const role = s.data.role === 'dm' ? 'dm' : 'player';
        const rows = payload.feed.map((r) => feedForRole(r, role)).filter(Boolean);
        if (rows.length) s.emit('feed', rows);
      }
      if (payload.fx?.length) s.emit('fx', payload.fx);
    }
  });

  // Pings go to everyone who has joined (and the DM); nothing is stored.
  service.on('ping', (gameId, ping) => {
    for (const s of socketsFor(gameId)) if (s.data.role === 'dm' || s.data.playerId) s.emit('ping', ping);
  });

  dm.use((socket, next) => {
    if (!auth.isDmCookieHeader(socket.handshake.headers.cookie)) return next(new Error('unauthorized'));
    next();
  });

  dm.on('connection', (socket) => {
    const game = service.get(socket.handshake.auth?.gameId);
    if (!game) {
      socket.emit('fatal', 'Game not found');
      return socket.disconnect(true);
    }
    socket.data = { role: 'dm', gameId: game.id };
    const actor = { role: 'dm' };
    socket.emit('state', stateFor(socket));
    socket.emit('history', service.history(game.id, 'dm'));
    socket.on('cmd', (cmd, ack) => reply(ack, service.dispatch(game.id, actor, cmd)));
    socket.on('chat', (text, ack) => reply(ack, service.chat(game.id, actor, text)));
    socket.on('ping', (pos, ack) => reply(ack, service.ping(game.id, actor, pos)));
  });

  play.on('connection', (socket) => {
    const { joinToken, playerId, seatSecret } = socket.handshake.auth ?? {};
    const game = service.getByToken(joinToken);
    if (!game) {
      socket.emit('fatal', 'This game link is not valid');
      return socket.disconnect(true);
    }
    socket.data = { role: 'player', gameId: game.id, playerId: null };

    const bind = (id) => {
      socket.data.playerId = id;
      service.connect(game.id, id, socket.id);
    };

    if (playerId) {
      const p = game.state.players[playerId];
      if (p && safeEqual(p.seatSecret, seatSecret)) bind(playerId);
      else socket.emit('seatInvalid');
    }
    // Feed history starts when this seat joined (nothing before joining). A seat without a join
    // time (older games) only sees what happens from now on.
    const history = () => {
      const p = service.get(game.id)?.state.players[socket.data.playerId];
      if (!p) return { feed: [] };
      return service.history(game.id, 'player', { since: p.joinedAt ?? service.now() });
    };
    socket.emit('state', stateFor(socket));
    socket.emit('history', history());

    socket.on('join', (data, ack) => {
      if (socket.data.playerId) return reply(ack, { ok: false, error: 'Already joined' });
      const r = service.dispatch(game.id, { role: 'join' }, { type: 'player.create', name: data?.name });
      if (!r.ok) return reply(ack, r);
      bind(r.result.playerId);
      socket.emit('state', stateFor(socket));
      socket.emit('history', history());
      reply(ack, { ok: true, playerId: r.result.playerId, seatSecret: r.result.seatSecret });
    });

    const actor = () => ({ role: 'player', playerId: socket.data.playerId });
    socket.on('cmd', (cmd, ack) => {
      if (!socket.data.playerId) return reply(ack, { ok: false, error: 'Join the game first' });
      if (cmd?.type === 'player.create') return reply(ack, { ok: false, error: 'Not allowed' });
      reply(ack, service.dispatch(game.id, actor(), cmd));
    });
    socket.on('chat', (text, ack) => {
      if (!socket.data.playerId) return reply(ack, { ok: false, error: 'Join the game first' });
      reply(ack, service.chat(game.id, actor(), text));
    });
    socket.on('ping', (pos, ack) => {
      if (!socket.data.playerId) return reply(ack, { ok: false, error: 'Join the game first' });
      reply(ack, service.ping(game.id, actor(), pos));
    });
    socket.on('disconnect', () => {
      if (socket.data.playerId) service.disconnect(game.id, socket.data.playerId, socket.id);
    });
  });
}
