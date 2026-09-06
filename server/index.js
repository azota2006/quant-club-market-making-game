'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { SessionStore, GameError, normalizeConfig, normalizeName } = require('./session');
const engine = require('./engine');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // A phone that walks out of WiFi range and back should resume, not re-join.
  pingTimeout: 25000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e5,
});

const store = new SessionStore();
setInterval(() => store.sweep(), 10 * 60 * 1000).unref();

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

/** Every non-internal IPv4 the host is reachable on, for the join URL / QR. */
function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ iface: name, address: net.address });
    }
  }
  return out;
}

app.get('/api/network', async (req, res) => {
  const addresses = localAddresses();
  const primary = addresses.length ? addresses[0].address : 'localhost';
  const url = `http://${primary}:${PORT}`;
  let qr = null;
  try {
    qr = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  } catch (err) {
    qr = null;
  }
  res.json({ port: PORT, addresses, url, qr });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sessions: store.sessions.size, uptime: process.uptime() });
});

// --------------------------------------------------------------- socket glue

function fail(socket, message) {
  socket.emit('error', { message });
}

function broadcastState(session) {
  io.to(session.code).emit('session:state', session.publicState());
}

function sendPrivate(session, playerId) {
  const player = session.playerById(playerId);
  if (!player || !player.socketId) return;
  const priv = session.privateStateFor(playerId);
  io.to(player.socketId).emit('hand:yours', {
    cards: priv.hand,
    subtotals: priv.handSubtotals,
    round: session.round,
  });
  io.to(player.socketId).emit('position:yours', { position: priv.position });
}

function sendPrivateToAll(session) {
  for (const p of session.players) sendPrivate(session, p.id);
}

function clearRoundTimer(session) {
  if (session.roundTimer) {
    clearTimeout(session.roundTimer);
    session.roundTimer = null;
  }
}

function scheduleRoundEnd(session) {
  clearRoundTimer(session);
  const ms = Math.max(0, session.roundEndTime - Date.now());
  session.roundTimer = setTimeout(() => {
    session.roundTimer = null;
    if (session.phase !== 'trading') return;
    try {
      session.endRound();
    } catch (err) {
      return;
    }
    io.to(session.code).emit('phase:changed', { phase: session.phase, reason: 'timer' });
    broadcastState(session);
  }, ms);
  if (session.roundTimer.unref) session.roundTimer.unref();
}

/** Resolve the socket's session + player, or throw something showable. */
function context(socket) {
  const { code, playerId } = socket.data || {};
  const session = store.get(code);
  if (!session) throw new GameError('That game is no longer running. Refresh to start over.');
  const player = session.playerById(playerId);
  if (!player) throw new GameError('You are not in this game. Refresh to rejoin.');
  return { session, player };
}

function requireHost(socket) {
  const ctx = context(socket);
  if (!ctx.player.isHost) throw new GameError('Only the host can do that.');
  return ctx;
}

/** Cheap throttle so a mashed Lift button can't flood the room. */
function allowAction(socket, cost = 1) {
  const now = Date.now();
  const bucket = socket.data.bucket || { tokens: 40, ts: now };
  const elapsed = (now - bucket.ts) / 1000;
  bucket.tokens = Math.min(40, bucket.tokens + elapsed * 20);
  bucket.ts = now;
  if (bucket.tokens < cost) {
    socket.data.bucket = bucket;
    return false;
  }
  bucket.tokens -= cost;
  socket.data.bucket = bucket;
  return true;
}

function handler(socket, fn) {
  return (payload, ack) => {
    try {
      const result = fn(payload || {}, typeof ack === 'function' ? ack : null);
      if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
    } catch (err) {
      const message = err instanceof GameError ? err.message : 'Something went wrong.';
      if (!(err instanceof GameError)) console.error('[handler]', err);
      if (typeof ack === 'function') ack({ ok: false, error: message });
      else fail(socket, message);
    }
  };
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on(
    'create_session',
    handler(socket, ({ hostName, config }) => {
      const { session, host } = store.create(normalizeName(hostName) || 'Host', config);
      host.socketId = socket.id;
      socket.data.code = session.code;
      socket.data.playerId = host.id;
      socket.join(session.code);
      broadcastState(session);
      return {
        sessionCode: session.code,
        playerId: host.id,
        token: host.token,
        name: host.name,
        isHost: true,
        seenRules: host.seenRules,
        state: session.publicState(),
      };
    }),
  );

  socket.on(
    'join_session',
    handler(socket, ({ sessionCode, playerName, token }) => {
      const session = store.get(sessionCode);
      if (!session) throw new GameError(`No game found with code "${String(sessionCode || '').toUpperCase()}".`);
      if (session.phase === 'ended') throw new GameError('That game has finished.');

      // A stored token means "this is the same person coming back", which wins
      // over the name field — a refresh must not create a second player.
      let player = session.playerByToken(token);
      if (player) {
        if (player.socketId && player.socketId !== socket.id) {
          const old = io.sockets.sockets.get(player.socketId);
          if (old) old.emit('error', { message: 'You opened this game in another tab or device.' });
        }
      } else {
        player = session.addPlayer(playerName);
      }

      player.socketId = socket.id;
      player.connected = true;
      player.lastSeen = Date.now();

      socket.data.code = session.code;
      socket.data.playerId = player.id;
      socket.join(session.code);

      broadcastState(session);
      // Private payloads go out after the ack so the client has identity first.
      setImmediate(() => sendPrivate(session, player.id));

      return {
        sessionCode: session.code,
        playerId: player.id,
        token: player.token,
        name: player.name,
        isHost: player.isHost,
        seenRules: player.seenRules,
        state: session.publicState(),
      };
    }),
  );

  socket.on(
    'player:seen_rules',
    handler(socket, () => {
      const { player } = context(socket);
      player.seenRules = true;
    }),
  );

  // ------------------------------------------------------------- host events

  socket.on(
    'host:configure_round',
    handler(socket, ({ config }) => {
      const { session } = requireHost(socket);
      if (session.phase !== 'lobby' && session.phase !== 'revealed') {
        throw new GameError('Settings can only change between rounds.');
      }
      session.config = normalizeConfig(config, session.config);
      broadcastState(session);
    }),
  );

  socket.on(
    'host:deal',
    handler(socket, () => {
      const { session } = requireHost(socket);
      clearRoundTimer(session);
      session.dealRound();
      io.to(session.code).emit('phase:changed', { phase: session.phase });
      broadcastState(session);
      sendPrivateToAll(session);
    }),
  );

  socket.on(
    'host:start_trading',
    handler(socket, () => {
      const { session } = requireHost(socket);
      session.startTrading();
      scheduleRoundEnd(session);
      io.to(session.code).emit('phase:changed', {
        phase: session.phase,
        roundStartTime: session.roundStartTime,
        roundEndTime: session.roundEndTime,
      });
      broadcastState(session);
    }),
  );

  socket.on(
    'host:end_round',
    handler(socket, () => {
      const { session } = requireHost(socket);
      clearRoundTimer(session);
      session.endRound();
      io.to(session.code).emit('phase:changed', { phase: session.phase });
      broadcastState(session);
    }),
  );

  socket.on(
    'host:reveal',
    handler(socket, () => {
      const { session } = requireHost(socket);
      clearRoundTimer(session);
      session.reveal();
      io.to(session.code).emit('round:revealed', {
        trueValues: session.trueValues,
        valueBreakdown: session.valueBreakdown,
        roundResults: session.roundResultsPublic(),
        cumulativeLeaderboard: session.leaderboard(),
      });
      broadcastState(session);
    }),
  );

  socket.on(
    'host:next_round',
    handler(socket, () => {
      const { session } = requireHost(socket);
      clearRoundTimer(session);
      session.nextRound();
      io.to(session.code).emit('phase:changed', { phase: session.phase });
      broadcastState(session);
      sendPrivateToAll(session);
    }),
  );

  socket.on(
    'host:end_session',
    handler(socket, () => {
      const { session } = requireHost(socket);
      clearRoundTimer(session);
      session.endSession();
      io.to(session.code).emit('phase:changed', { phase: session.phase });
      broadcastState(session);
    }),
  );

  socket.on(
    'host:kick_player',
    handler(socket, ({ playerId }) => {
      const { session } = requireHost(socket);
      const target = session.playerById(playerId);
      if (!target || target.isHost) throw new GameError('Cannot remove that player.');
      session.clearAllQuotesFor(target.id);
      session.players = session.players.filter((p) => p.id !== target.id);
      delete session.positions[target.id];
      delete session.hands[target.id];
      if (target.socketId) {
        const s = io.sockets.sockets.get(target.socketId);
        if (s) {
          // Removal is roster tidying, not a ban — they can rejoin with the
          // code. Reset them to the landing screen so they aren't left staring
          // at a game they are no longer part of.
          s.emit('session:removed', {
            message: 'The host removed you from the game. You can join again with the code.',
          });
          s.leave(session.code);
          s.data = {};
        }
      }
      broadcastState(session);
    }),
  );

  // ----------------------------------------------------------- player events

  socket.on(
    'player:update_quote',
    handler(socket, ({ commodityId, bid, ask }) => {
      if (!allowAction(socket)) throw new GameError('Slow down a moment.');
      const { session, player } = context(socket);
      const book = session.updateQuote(player.id, commodityId, bid, ask);
      io.to(session.code).emit('book:updated', { commodityId, quotes: book });
    }),
  );

  socket.on(
    'player:clear_quote',
    handler(socket, ({ commodityId }) => {
      if (!allowAction(socket)) throw new GameError('Slow down a moment.');
      const { session, player } = context(socket);
      const book = session.updateQuote(player.id, commodityId, null, null);
      io.to(session.code).emit('book:updated', { commodityId, quotes: book });
    }),
  );

  function trade(side) {
    return handler(socket, ({ commodityId, counterpartyId, expectedPrice }) => {
      if (!allowAction(socket)) throw new GameError('Slow down a moment.');
      const { session, player } = context(socket);
      const result = session.executeTrade(player.id, commodityId, counterpartyId, side, expectedPrice);

      io.to(session.code).emit('trade:executed', {
        trade: result.trade,
        marks: session.marks(),
      });
      if (result.bookChanged) {
        io.to(session.code).emit('book:updated', {
          commodityId,
          quotes: session.quotes[commodityId],
        });
      }
      sendPrivate(session, result.actorId);
      sendPrivate(session, result.counterpartyId);
      return { trade: result.trade };
    });
  }

  socket.on('player:lift_ask', trade('lift'));
  socket.on('player:hit_bid', trade('hit'));

  socket.on('disconnect', () => {
    const { code, playerId } = socket.data || {};
    const session = store.get(code);
    if (!session) return;
    const player = session.playerById(playerId);
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    player.lastSeen = Date.now();
    player.socketId = null;
    // Quotes stay live: a phone that briefly drops WiFi should not silently
    // pull the player's market. Sessions are never torn down on disconnect.
    if (player.isHost) session.hostDisconnectedAt = Date.now();
    broadcastState(session);
  });
});

server.listen(PORT, HOST, () => {
  const addresses = localAddresses();
  const lines = [
    '',
    '  Market Making Game',
    '  ------------------',
    `  Host dashboard:  http://localhost:${PORT}`,
  ];
  for (const a of addresses) {
    lines.push(`  Players join at: http://${a.address}:${PORT}   (${a.iface})`);
  }
  if (!addresses.length) {
    lines.push('  No local network address found — players must be on this machine.');
  }
  lines.push('');
  lines.push('  Everyone must be on the same WiFi. Ctrl+C to stop.');
  lines.push('');
  console.log(lines.join('\n'));
});

module.exports = { app, server, io, store, engine };
