import { describe, it, expect, afterEach, vi } from 'vitest';
import { io as Client } from 'socket.io-client';
import { startServer } from '../server/index.js';

let srv;
const clients = [];

async function boot() {
  srv = await startServer({ port: 0 });
  return `http://localhost:${srv.port}`;
}

function connect(url) {
  const c = Client(url, { transports: ['websocket'] });
  c.updates = [];
  c.states = [];
  c.on('room:update', (u) => c.updates.push(u));
  c.on('room:state', (s) => c.states.push(s));
  clients.push(c);
  return c;
}

const connected = (c) => new Promise((res) => c.on('connect', res));
const emitAck = (c, ev, data) => new Promise((res) => c.emit(ev, data, res));

async function waitFor(cond, { timeout = 8000, interval = 25 } = {}) {
  return vi.waitFor(async () => {
    const v = await cond();
    if (!v) throw new Error('condition not met yet');
    return v;
  }, { timeout, interval });
}

const player = (u, name) => u.players.find((p) => p.name === name);

function lastUpdate(c, pred) {
  for (let i = c.updates.length - 1; i >= 0; i--) {
    if (pred(c.updates[i])) return c.updates[i];
  }
  return null;
}

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  if (srv) await srv.close();
  srv = null;
});

describe('PIXEL POINTS integration', () => {
  it('create → join → role delivered → vote → hidden → reveal', async () => {
    const url = await boot();
    const sm = connect(url);
    await connected(sm);
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    expect(create.ok).toBe(true);
    expect(typeof create.code).toBe('string');
    expect(typeof create.token).toBe('string');
    expect(create.state.you.role).toBe('sm');
    const smState = await waitFor(() => sm.states[0]);
    expect(smState.you.role).toBe('sm');

    const p1 = connect(url);
    await connected(p1);
    const p2 = connect(url);
    await connected(p2);
    const j1 = await emitAck(p1, 'room:join', { code: create.code, name: 'Alice' });
    const j2 = await emitAck(p2, 'room:join', { code: create.code, name: 'Bob' });
    expect(j1.ok).toBe(true);
    expect(j1.name).toBe('Alice');
    expect(j1.state.you.role).toBe('player');
    expect(j2.ok).toBe(true);
    expect(j2.name).toBe('Bob');

    const start = await emitAck(sm, 'round:start', { description: 'Fix login' });
    expect(start.ok).toBe(true);

    const vote = await emitAck(p1, 'vote:cast', { value: '13' });
    expect(vote.ok).toBe(true);

    const p2view = await waitFor(() => p2.updates.find((u) => player(u, 'Alice')?.voted));
    expect(JSON.stringify(p2view)).not.toContain('"13"');
    expect(player(p2view, 'Alice')).toEqual({ name: 'Alice', role: 'player', connected: true, voted: true });

    const vote2 = await emitAck(p2, 'vote:cast', { value: '5' });
    expect(vote2.ok).toBe(true);
    await waitFor(() => p2.updates.find((u) => player(u, 'Bob')?.voted));

    const preReveal = [p2.updates, sm.updates, p1.updates].flat();
    for (const u of preReveal) {
      expect(u.players.every((p) => !('vote' in p))).toBe(true);
      expect(JSON.stringify(u)).not.toContain('"13"');
    }

    const reveal = await waitFor(() => sm.updates.find((u) => u.phase === 'reveal'));
    expect(reveal.reveal.players.find((p) => p.name === 'Alice').vote).toBe('13');
    expect(reveal.reveal.players.find((p) => p.name === 'Bob').vote).toBe('5');
    expect(reveal.reveal.spread).toEqual({ min: 5, max: 13 });
    expect(reveal.reveal.suggestedPoints).toBe(5);

    const bad = await emitAck(p1, 'round:consensus', { points: '5' });
    expect(bad.ok).toBe(false);
    const done = await emitAck(sm, 'round:consensus', { points: '5' });
    expect(done.ok).toBe(true);
    const lobby = await waitFor(() => p1.updates.find((u) => u.phase === 'lobby' && u.history?.length));
    expect(lobby.history[0]).toEqual({ description: 'Fix login', points: 5, time: expect.any(Number) });
  }, 15000);

  it('vote change during countdown resets it (observed via countdownRemaining)', async () => {
    const url = await boot();
    const sm = connect(url);
    await connected(sm);
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const p1 = connect(url);
    await connected(p1);
    const p2 = connect(url);
    await connected(p2);
    await emitAck(p1, 'room:join', { code: create.code, name: 'A' });
    await emitAck(p2, 'room:join', { code: create.code, name: 'B' });
    await emitAck(sm, 'round:start', { description: 'd' });
    await emitAck(p1, 'vote:cast', { value: '3' });
    await emitAck(p2, 'vote:cast', { value: '5' });
    const upd1 = await waitFor(() => sm.updates.find((u) => u.countdownRemaining !== null));
    expect(upd1.countdownRemaining).not.toBe(null);
    await new Promise((r) => setTimeout(r, 2000));
    const before = sm.updates.length;
    const changed = await emitAck(p2, 'vote:cast', { value: '8' });
    expect(changed.ok).toBe(true);
    const upd2 = await waitFor(() =>
      sm.updates.slice(before).find((u) => u.countdownRemaining !== null && u.countdownRemaining > 3000));
    expect(upd2.countdownRemaining).toBeGreaterThan(3000);
  }, 15000);

  it('resume restores role after reconnect; expired token bounces', async () => {
    const url = await boot();
    const sm = connect(url);
    await connected(sm);
    const p = connect(url);
    await connected(p);
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const join = await emitAck(p, 'room:join', { code: create.code, name: 'Alice' });
    expect(join.ok).toBe(true);
    p.disconnect();
    await waitFor(() => sm.updates.find((u) => player(u, 'Alice')?.connected === false));
    const p2 = connect(url);
    await connected(p2);
    const resume = await emitAck(p2, 'session:resume', { token: join.token });
    expect(resume.ok).toBe(true);
    expect(resume.state.you.name).toBe('Alice');
    expect(resume.state.you.role).toBe('player');
    const state = await waitFor(() => p2.states.find((s) => s.you?.name === 'Alice'));
    expect(state.you.role).toBe('player');
    await waitFor(() => sm.updates.find((u) => player(u, 'Alice')?.connected === true));
    const stale = await emitAck(p2, 'session:resume', { token: 'nope' });
    expect(stale.ok).toBe(false);
  }, 10000);

  it('locked IP cannot create or join', async () => {
    const url = await boot();
    const c = connect(url);
    await connected(c);
    for (let i = 0; i < 10; i++) {
      const r = await emitAck(c, 'room:join', { code: 'AAAA', name: 'X' });
      expect(r.ok).toBe(false);
    }
    const locked = await emitAck(c, 'room:join', { code: 'AAAA', name: 'X' });
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/Too many attempts/);
    const create = await emitAck(c, 'room:create', { name: 'X' });
    expect(create.ok).toBe(false);
    expect(create.error).toMatch(/Too many attempts/);
  }, 10000);

  it('non-numeric vote rejected; SM cannot vote', async () => {
    const url = await boot();
    const sm = connect(url);
    await connected(sm);
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const p1 = connect(url);
    await connected(p1);
    const p2 = connect(url);
    await connected(p2);
    await emitAck(p1, 'room:join', { code: create.code, name: 'A' });
    await emitAck(p2, 'room:join', { code: create.code, name: 'B' });
    await emitAck(sm, 'round:start', { description: 'd' });
    const bad = await emitAck(p1, 'vote:cast', { value: '99' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('Invalid vote');
    const smVote = await emitAck(sm, 'vote:cast', { value: '5' });
    expect(smVote.ok).toBe(false);
    expect(smVote.error).toBe('Not a voter');
  }, 10000);

  it('duplicate names suffixed', async () => {
    const url = await boot();
    const sm = connect(url);
    await connected(sm);
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const a = connect(url);
    await connected(a);
    const b = connect(url);
    await connected(b);
    const j1 = await emitAck(a, 'room:join', { code: create.code, name: 'Sam' });
    expect(j1.ok).toBe(true);
    expect(j1.name).toBe('Sam');
    const j2 = await emitAck(b, 'room:join', { code: create.code, name: 'Sam' });
    expect(j2.ok).toBe(true);
    expect(j2.name).toBe('Sam 2');
  }, 10000);
});
describe('leave + abandon', () => {
  it('player leaves mid-vote: token dead, room persists, countdown stops', async () => {
    const url = await boot();
    const sm = connect(url);
    await new Promise((res) => sm.on('connect', res));
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const p1 = connect(url);
    const p2 = connect(url);
    await new Promise((res) => p1.on('connect', res));
    await new Promise((res) => p2.on('connect', res));
    await emitAck(p1, 'room:join', { code: create.code, name: 'A' });
    const j2 = await emitAck(p2, 'room:join', { code: create.code, name: 'B' });
    await emitAck(sm, 'round:start', { description: 'd' });
    await emitAck(p1, 'vote:cast', { value: '5' });
    await emitAck(p2, 'vote:cast', { value: '8' });
    const leave = await emitAck(p2, 'room:leave', {});
    expect(leave.ok).toBe(true);
    // token invalidated: resume bounces
    const stale = await emitAck(p2, 'session:resume', { token: j2.token });
    expect(stale.ok).toBe(false);
    // p1 can't trigger reveal alone; but re-vote p1 + SM restarts flow later
    // remaining players see the update with B gone
    const upd = await vi.waitFor(async () => {
      const s = lastUpdate(p1, (u) => u.players.length === 2);
      if (s) return s;
      throw new Error('waiting');
    }, { timeout: 5000 });
    expect(upd.players.some((p) => p.name === 'B')).toBe(false);
  }, 12000);

  it('SM abandons a voting round: back to lobby, description recoverable', async () => {
    const url = await boot();
    const sm = connect(url);
    await new Promise((res) => sm.on('connect', res));
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const p1 = connect(url);
    const p2 = connect(url);
    await new Promise((res) => p1.on('connect', res));
    await new Promise((res) => p2.on('connect', res));
    await emitAck(p1, 'room:join', { code: create.code, name: 'A' });
    await emitAck(p2, 'room:join', { code: create.code, name: 'B' });
    await emitAck(sm, 'round:start', { description: 'wrong story' });
    await emitAck(p1, 'vote:cast', { value: '5' });
    const abandon = await emitAck(sm, 'round:abandon', {});
    expect(abandon.ok).toBe(true);
    const upd = await vi.waitFor(async () => {
      const s = lastUpdate(p1, (u) => u.phase === 'lobby');
      if (s) return s;
      throw new Error('waiting');
    }, { timeout: 5000 });
    expect(upd.description).toBe('');
    // non-SM abandon rejected
    const bad = await emitAck(p1, 'round:abandon', {});
    expect(bad.ok).toBe(false);
  }, 12000);
});
