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

// ---- trusted-proxy helpers -------------------------------------------------

// Normalize an IP string: strip IPv6-mapped IPv4 prefix, lowercase, trim.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  let v = ip.trim().toLowerCase();
  if (v.startsWith('::ffff:') && v.includes('.')) v = v.slice(7);
  return v || null;
}

// Parse "a.b.c.d" / CIDR entries into a list of {ip, prefixLen} where
// prefixLen 32/128 means exact match. Returns null on empty input.
function parseProxyList(raw) {
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  return entries.map((entry) => {
    if (entry.includes('/')) {
      const [base, bits] = entry.split('/');
      return { base: normalizeIp(base), bits: Number(bits) };
    }
    return { base: normalizeIp(entry), bits: null };
  }).filter((e) => e.base !== null);
}

function isTrustedProxy(ip, list) {
  const v = normalizeIp(ip);
  if (v === null) return false;
  return list.some(({ base, bits }) => {
    if (bits === null) return v === base;
    return ipInCidr(v, base, bits);
  });
}

function ipToBigInt(ip) {
  if (ip.includes(':')) {
    // Expand :: and parse 8 x 16-bit groups into a 128-bit BigInt.
    let head = ip, tail = '';
    if (ip.includes('::')) [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== '' || ip.endsWith('::') ? (tail ? tail.split(':') : []) : [];
    const hParts = h.filter(Boolean).map((g) => BigInt(parseInt(g || '0', 16)));
    const tParts = t.filter(Boolean).map((g) => BigInt(parseInt(g || '0', 16)));
    const missing = 8 - hParts.length - tParts.length;
    const groups = [...hParts, ...Array(Math.max(0, missing)).fill(0n), ...tParts];
    return groups.reduce((acc, g) => (acc << 16n) | (g & 0xffffn), 0n);
  }
  return ip.split('.').reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
}

function ipBitsFor(ip) {
  return ip.includes(':') ? 128 : 32;
}

function ipInCidr(ip, base, bits) {
  if (ip.includes(':') !== base.includes(':')) return false;
  const width = BigInt(ipBitsFor(ip));
  const b = BigInt(bits);
  if (b < 0n || b > width) return false;
  const shift = width - b;
  return (ipToBigInt(ip) >> shift) === (ipToBigInt(base) >> shift);
}

export const _internal = { normalizeIp, parseProxyList, isTrustedProxy, ipToBigInt, ipInCidr };

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
  // TRUSTED_PROXIES env: comma-separated IPs/CIDRs (e.g. "127.0.0.1,::1,172.16.0.0/12").
  // Empty/unset → loopback only. Invalid entries are dropped by parseProxyList.
  const trustedProxies = parseProxyList(process.env.TRUSTED_PROXIES ?? '')
    ?? parseProxyList('127.0.0.1,::1,::ffff:127.0.0.1');
  const ipOf = (socket) => {
    const direct = normalizeIp(socket.handshake.address);
    if (isTrustedProxy(direct, trustedProxies)) {
      const xff = socket.request.headers['x-forwarded-for']?.split(',')[0].trim();
      return (xff && normalizeIp(xff)) ?? direct;
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