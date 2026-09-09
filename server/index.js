import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { createRoomRegistry } from './rooms.js';
import { createRateLimiter, createAttemptTracker } from './ratelimit.js';
import { sanitizeName, normalizeCode, sanitizeDescription } from './validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export async function startServer({ port = 0 } = {}) {
  const reg = createRoomRegistry();
  const joinLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
  const badCodeTracker = createAttemptTracker({ max: 10, lockoutMs: 300_000 });

  const app = express();
  app.use(express.static(PUBLIC_DIR));
  app.get('/healthz', (_req, res) => res.send('ok'));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e6,
    perMessageDeflate: { threshold: 1024 },
    connectTimeout: 10_000,
  });

  function stateFor(room, sessionId) {
    const state = room.publicState;
    const out = {
      ...state,
      reveal: room.phase === 'reveal' ? room.revealData : null,
    };
    if (sessionId) {
      const you = room.players.get(sessionId);
      out.you = you
        ? { name: you.name, role: you.role, voted: you.voted, vote: you.vote }
        : null;
    }
    return out;
  }

  function broadcastRoom(room) {
    io.to(room.code).emit('room:update', stateFor(room));
  }

  reg.setRevealBroadcaster((code) => {
    const room = reg.getRoom(code);
    if (room) broadcastRoom(room);
  });

  // Trust X-Forwarded-For only when the connection comes from a known reverse
  // proxy; direct connections use their real address (prevents IP spoofing to
  // bypass rate limits when the Node port is reachable without the proxy).
  const TRUSTED_PROXIES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const ipOf = (socket) => {
    const direct = socket.handshake.address;
    if (TRUSTED_PROXIES.has(direct)) {
      return socket.request.headers['x-forwarded-for']?.split(',')[0].trim() ?? direct;
    }
    return direct;
  };

  const LOCKED_MSG = 'Too many attempts. Try again in a few minutes.';

  io.on('connection', (socket) => {
    const ip = ipOf(socket);
    const ackOr = (ack) => (typeof ack === 'function' ? ack : () => {});

    socket.on('room:create', (data, ack) => {
      ack = ackOr(ack);
      if (badCodeTracker.isLocked(ip)) return ack({ ok: false, error: LOCKED_MSG });
      if (!joinLimiter.check(ip)) return ack({ ok: false, error: LOCKED_MSG });
      if (socket.data.token) return ack({ ok: false, error: 'You already host a room' });
      const { ok, name, error } = sanitizeName(data?.name);
      if (!ok) return ack({ ok: false, error });
      const sessionId = randomUUID();
      let out;
      try {
        out = reg.createRoom(sessionId, name);
      } catch (e) {
        return ack({ ok: false, error: e.message });
      }
      socket.data.token = out.token;
      socket.join(out.code);
      ack({ ok: true, code: out.code, token: out.token, state: stateFor(out.room, sessionId) });
      socket.emit('room:state', stateFor(out.room, sessionId));
    });

    socket.on('room:join', (data, ack) => {
      ack = ackOr(ack);
      if (badCodeTracker.isLocked(ip)) return ack({ ok: false, error: LOCKED_MSG });
      if (!joinLimiter.check(ip)) return ack({ ok: false, error: LOCKED_MSG });
      if (socket.data.token) return ack({ ok: false, error: 'You already host a room' });
      const code = normalizeCode(data?.code);
      const { ok, name, error } = sanitizeName(data?.name);
      if (!ok) return ack({ ok: false, error });
      if (!code) return ack({ ok: false, error: 'Enter the 4-character room code' });
      const sessionId = randomUUID();
      let out;
      try {
        out = reg.joinRoom(code, sessionId, name);
      } catch (e) {
        if (e.message === 'Room not found') badCodeTracker.record(ip, false);
        return ack({ ok: false, error: e.message });
      }
      badCodeTracker.record(ip, true);
      socket.data.token = out.token;
      socket.join(code);
      ack({ ok: true, code, token: out.token, name: out.player.name, state: stateFor(out.room, sessionId) });
      socket.emit('room:state', stateFor(out.room, sessionId));
      broadcastRoom(out.room);
    });

    socket.on('session:resume', (data, ack) => {
      ack = ackOr(ack);
      const hit = data?.token ? reg.getBySession(data.token) : null;
      if (!hit) return ack({ ok: false, error: 'session expired' });
      socket.data.token = data.token;
      socket.join(hit.room.code);
      hit.room.reconnect(hit.sessionId);
      ack({ ok: true, state: stateFor(hit.room, hit.sessionId) });
      socket.emit('room:state', stateFor(hit.room, hit.sessionId));
      broadcastRoom(hit.room);
    });

    const withRoom = (fn) => (data, ack) => {
      ack = ackOr(ack);
      const token = socket.data.token;
      const hit = token ? reg.getBySession(token) : null;
      if (!hit) return ack({ ok: false, error: 'no session' });
      try {
        fn(hit, data);
        ack({ ok: true });
        broadcastRoom(hit.room);
      } catch (e) {
        ack({ ok: false, error: e.message });
      }
    };

    socket.on('round:start', withRoom(({ room, sessionId }, data) => {
      room.startRound(sessionId, sanitizeDescription(data?.description));
    }));
    socket.on('vote:cast', withRoom(({ room, sessionId }, data) => {
      room.castVote(sessionId, data?.value);
    }));
    socket.on('round:consensus', withRoom(({ room, sessionId }, data) => {
      room.consensus(sessionId, String(data?.points));
    }));
    socket.on('round:revote', withRoom(({ room, sessionId }) => {
      room.revote(sessionId);
    }));
    socket.on('round:new', withRoom(({ room, sessionId }) => {
      room.newRound(sessionId);
    }));
    socket.on('round:abandon', withRoom(({ room, sessionId }) => {
      room.abandonRound(sessionId);
    }));

    socket.on('room:leave', (_data, ack) => {
      ack = ackOr(ack);
      // Security: only the socket's own session token may be used — never a
      // client-supplied one (prevents forced eviction of other players).
      const token = socket.data.token;
      if (!token) return ack({ ok: false, error: 'no session' });
      const hit = reg.getBySession(token);
      if (!hit) return ack({ ok: false, error: 'session expired' });
      const room = hit.room;
      reg.leaveRoom(token); // removes player + session; recomputes countdown
      socket.leave(room.code);
      delete socket.data.token;
      broadcastRoom(room);
      ack({ ok: true });
    });

    socket.on('disconnect', () => {
      const token = socket.data.token;
      if (!token) return;
      const hit = reg.getBySession(token);
      if (hit) {
        hit.room.disconnect(hit.sessionId);
        broadcastRoom(hit.room);
      }
    });
  });

  const sweepTimer = setInterval(() => reg.sweep(), 15_000);
  sweepTimer.unref();

  await new Promise((resolve) => httpServer.listen(port, resolve));
  const actualPort = httpServer.address().port;

  return {
    httpServer, io, port: actualPort,
    close: () => new Promise((resolve) => {
      clearInterval(sweepTimer);
      io.close();
      httpServer.close(() => resolve());
    }),
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 3000;
  startServer({ port: PORT }).then(({ port }) =>
    console.log(`PIXEL POINTS listening on port ${port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      process.exit(0);
    });
  }
}