import { randomUUID } from 'node:crypto';
import { GameRoom } from './game.js';
import { CODE_ALPHABET } from './validation.js';

export const DISCONNECT_GRACE_MS = 60_000;
export const ROOM_EMPTY_TTL_MS = 15 * 60_000;

export function createRoomRegistry() {
  const rooms = new Map();      // code -> room
  const sessions = new Map();  // token -> {roomCode, sessionId}
  const emptySince = new Map(); // code -> ts
  let revealBroadcaster = () => {};

  function newCode() {
    let code;
    do {
      code = Array.from({ length: 4 },
        () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  const reg = {
    setRevealBroadcaster(fn) { revealBroadcaster = fn; },

    getRoom(code) { return rooms.get(code) ?? null; },

    createRoom(smSessionId, smName) {
      const code = newCode();
      const room = new GameRoom(code, {
        onCountdownEnd: (data) => revealBroadcaster(code, data),
      });
      room.addSm(smSessionId, smName);
      rooms.set(code, room);
      emptySince.delete(code);
      const token = randomUUID();
      sessions.set(token, { roomCode: code, sessionId: smSessionId });
      return { code, room, token };
    },

    joinRoom(code, sessionId, name) {
      const room = rooms.get(code);
      if (!room) throw new Error('Room not found');
      const player = room.addPlayer(sessionId, name);
      emptySince.delete(code);
      const token = randomUUID();
      sessions.set(token, { roomCode: code, sessionId });
      return { room, player, token };
    },

    getBySession(token) {
      const s = sessions.get(token);
      if (!s) return null;
      const room = rooms.get(s.roomCode);
      if (!room) { sessions.delete(token); return null; }
      const player = room.players.get(s.sessionId);
      if (!player) { sessions.delete(token); return null; }
      return { room, sessionId: s.sessionId, player };
    },

    removeSession(token) { sessions.delete(token); },

    leaveRoom(token) {
      const s = sessions.get(token);
      if (!s) return { ok: false };
      const room = rooms.get(s.roomCode);
      sessions.delete(token);
      if (!room) return { ok: true };
      room.removePlayer(s.sessionId); // recomputes countdown; drops vote
      return { ok: true, room };
    },

    sweep(now = Date.now()) {
      for (const [code, room] of rooms) {
        for (const [sid, p] of room.players) {
          if (p.role !== 'sm'
            && !p.connected
            && p.connectedAt
            && now - p.connectedAt > DISCONNECT_GRACE_MS) {
            room.removePlayer(sid); // recomputes countdown; drops vote
            for (const [t, s] of sessions) {
              if (s.roomCode === code && s.sessionId === sid) sessions.delete(t);
            }
          }
        }
        const anyConnected = [...room.players.values()].some((p) => p.connected);
        if (!anyConnected) {
          if (!emptySince.has(code)) emptySince.set(code, now);
          if (now - emptySince.get(code) > ROOM_EMPTY_TTL_MS) {
            rooms.delete(code);
            for (const [t, s] of sessions) if (s.roomCode === code) sessions.delete(t);
            emptySince.delete(code);
          }
        } else {
          emptySince.delete(code);
        }
      }
    },
  };
  return reg;
}