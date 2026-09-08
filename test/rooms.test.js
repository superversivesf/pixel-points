import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoomRegistry, DISCONNECT_GRACE_MS, ROOM_EMPTY_TTL_MS } from '../server/rooms.js';

afterEach(() => vi.useRealTimers());

let n = 0;
function make() {
  const reg = createRoomRegistry();
  const { code } = reg.createRoom(`sm${++n}`, 'Boss');
  reg.joinRoom(code, `pa${++n}`, 'Alice');
  reg.joinRoom(code, `pb${++n}`, 'Bob');
  return { reg, code };
}

describe('registry', () => {
  it('creates a 4-char code from the alphabet', () => {
    const reg = createRoomRegistry();
    const { code } = reg.createRoom('sm', 'Boss');
    expect(code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY234679]{4}$/);
  });
  it('unique codes on collision-prone runs', () => {
    const reg = createRoomRegistry();
    const codes = new Set();
    for (let i = 0; i < 50; i++) codes.add(reg.createRoom(`s${i}`, 'B').code);
    expect(codes.size).toBe(50);
  });
  it('join returns room + token; token resolves back', () => {
    const { reg, code } = make();
    const r = reg.joinRoom(code, 'px', 'Carol');
    expect(r.room.code).toBe(code);
    const hit = reg.getBySession(r.token);
    expect(hit.room.code).toBe(code);
    expect(hit.sessionId).toBe('px');
  });
  it('unknown code throws', () => {
    const reg = createRoomRegistry();
    expect(() => reg.joinRoom('ZZZZ', 's', 'A')).toThrow('Room not found');
  });
  it('removeSession invalidates token', () => {
    const { reg, code } = make();
    const { token } = reg.joinRoom(code, 'px', 'Carol');
    reg.removeSession(token);
    expect(reg.getBySession(token)).toBeNull();
  });
  it('sweep evicts players (not SM) disconnected beyond grace', () => {
    vi.useFakeTimers();
    const { reg, code } = make();
    const room = reg.getBySession(reg.joinRoom(code, 'pz', 'Zed').token).room;
    const smSession = [...room.players.entries()].find(([, p]) => p.role === 'sm')[0];
    room.disconnect(smSession);
    room.disconnect('pz');
    reg.sweep(Date.now());
    expect(room.players.has('pz')).toBe(true); // grace not elapsed
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 1000);
    reg.sweep(Date.now());
    expect(room.players.has('pz')).toBe(false); // evicted
    expect(room.players.has(smSession)).toBe(true); // SM never evicted
    vi.useRealTimers();
  });
  it('sweep deletes rooms empty past TTL', () => {
    vi.useFakeTimers();
    const reg = createRoomRegistry();
    const { code } = reg.createRoom('smX', 'Boss');
    const room = reg.getRoom(code);
    reg.joinRoom(code, 'p1', 'A');
    // disconnect everyone through the API (sets connectedAt)
    for (const sid of [...room.players.keys()]) room.disconnect(sid);
    reg.sweep(); // first observation of empty
    expect(reg.getRoom(code)).not.toBeNull(); // still alive mid-window
    vi.advanceTimersByTime(ROOM_EMPTY_TTL_MS + 1000);
    reg.sweep();
    expect(() => reg.joinRoom(code, 'px', 'X')).toThrow('Room not found');
    vi.useRealTimers();
  });
  it('eviction drops vote and recomputes countdown', () => {
    vi.useFakeTimers();
    const reg = createRoomRegistry();
    const { code } = reg.createRoom('smZ', 'Boss');
    const room = reg.getRoom(code);
    reg.joinRoom(code, 'p1', 'A');
    reg.joinRoom(code, 'p2', 'B');
    room.startRound('smZ', 'd');
    room.castVote('p1', '5'); room.castVote('p2', '8');
    expect(room.publicState.countdownRemaining).not.toBe(null);
    room.disconnect('p2'); // grace: countdown continues
    expect(room.publicState.countdownRemaining).not.toBe(null);
    const t0 = Date.now();
    // explicit now: no fake-timer fire, so no reveal can happen — the eviction
    // path itself (removePlayer -> allVotersVoted false -> _clearCountdown)
    // must drop the vote and null the countdown
    reg.sweep(t0 + DISCONNECT_GRACE_MS + 1000);
    expect(room.publicState.countdownRemaining).toBe(null); // vote dropped by eviction
    expect(room.publicState.phase).toBe('voting'); // no reveal — removePlayer did the work
    vi.useRealTimers();
  });
  it('joinRoom propagates Room full at capacity', () => {
    const reg = createRoomRegistry();
    const { code } = reg.createRoom('smF', 'Boss'); // SM + 12 = capacity
    for (let i = 1; i <= 11; i++) reg.joinRoom(code, `pf${i}`, `F${i}`); // 11 players -> full
    expect(() => reg.joinRoom(code, 'pf12', 'F12')).toThrow('Room full');
  });
  it('reveal broadcaster installed via setRevealBroadcaster fires on engine reveal', () => {
    vi.useFakeTimers();
    const reg = createRoomRegistry();
    const seen = [];
    reg.setRevealBroadcaster((code, data) => seen.push({ code, data }));
    const { code, room } = reg.createRoom('smE', 'Boss');
    reg.joinRoom(code, 'p1', 'A');
    reg.joinRoom(code, 'p2', 'B');
    room.startRound('smE', 'd');
    room.castVote('p1', '5'); room.castVote('p2', '8');
    vi.advanceTimersByTime(5000);
    expect(seen.length).toBe(1);
    expect(seen[0].code).toBe(code);
    expect(seen[0].data.spread).toEqual({ min: 5, max: 8 });
    vi.useRealTimers();
  });
});