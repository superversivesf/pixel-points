import { describe, it, expect, vi, afterEach } from 'vitest';
import { GameRoom, REVEAL_DELAY_MS } from '../server/game.js';

afterEach(() => vi.useRealTimers());

function roomWithVoters(n = 2) {
  const room = new GameRoom('TEST');
  room.addSm('sm', 'Boss');
  for (let i = 0; i < n; i++) room.addPlayer(`p${i}`, `P${i}`);
  room.startRound('sm', 'Fix the login bug');
  return room;
}

describe('players', () => {
  it('adds SM and players with roles', () => {
    const room = new GameRoom('TEST');
    room.addSm('sm', 'Boss');
    room.addPlayer('p1', 'Alice');
    expect(room.getPlayer('sm').role).toBe('sm');
    expect(room.getPlayer('p1').role).toBe('player');
  });
  it('duplicate names get suffix', () => {
    const room = new GameRoom('TEST');
    room.addSm('sm', 'Boss');
    room.addPlayer('p1', 'Alice');
    room.addPlayer('p2', 'Alice');
    expect(room.getPlayer('p2').name).toBe('Alice 2');
  });
});

describe('round start', () => {
  it('SM starts a round from lobby with description', () => {
    const room = roomWithVoters(2);
    expect(room.publicState.phase).toBe('voting');
    expect(room.publicState.description).toBe('Fix the login bug');
  });
  it('rejects start with < 2 voters', () => {
    const room = new GameRoom('TEST');
    room.addSm('sm', 'Boss');
    room.addPlayer('p1', 'Alice');
    expect(() => room.startRound('sm', 'x')).toThrow();
  });
  it('rejects empty description', () => {
    const room = new GameRoom('TEST');
    room.addSm('sm', 'Boss');
    room.addPlayer('p1', 'Alice');
    room.addPlayer('p2', 'Bob');
    expect(() => room.startRound('sm', '   ')).toThrow();
  });
  it('rejects start by non-SM', () => {
    const room = new GameRoom('TEST');
    room.addSm('sm', 'Boss');
    room.addPlayer('p1', 'Alice');
    room.addPlayer('p2', 'Bob');
    expect(() => room.startRound('p1', 'x')).toThrow();
  });
});

describe('voting + countdown', () => {
  it('countdown starts when all voted', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5');
    expect(room.publicState.countdownRemaining).toBe(null);
    room.castVote('p1', '8');
    expect(room.publicState.countdownRemaining).toBe(REVEAL_DELAY_MS);
  });
  it('vote change resets countdown to full 5s', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5');
    room.castVote('p1', '8');
    vi.advanceTimersByTime(3000);
    room.castVote('p1', '13');
    expect(room.publicState.countdownRemaining).toBe(REVEAL_DELAY_MS);
  });
  it('reveal fires at 0 via onCountdownEnd', () => {
    vi.useFakeTimers();
    let revealed = null;
    const room = new GameRoom('TEST', { onCountdownEnd: (d) => (revealed = d) });
    room.addSm('sm', 'Boss');
    room.addPlayer('p1', 'A'); room.addPlayer('p2', 'B');
    room.startRound('sm', 'd');
    room.castVote('p1', '5'); room.castVote('p2', '8');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(room.publicState.phase).toBe('reveal');
    expect(revealed.spread).toEqual({ min: 5, max: 8 });
  });
  it('GRACE: voted player disconnecting keeps countdown running to reveal', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5');
    room.castVote('p1', '8');
    room.disconnect('p1');
    expect(room.publicState.countdownRemaining).not.toBe(null); // still counting
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(room.publicState.phase).toBe('reveal');
    expect(room.revealData.players.find((p) => p.name === 'P1').vote).toBe('8');
  });
  it('mid-vote join stops in-flight countdown until joiner votes', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5');
    room.castVote('p1', '8');
    const joiner = room.addPlayer('px', 'Joiner');
    expect(joiner.voted).toBe(false);
    expect(room.publicState.countdownRemaining).toBe(null);
    room.castVote('px', '3');
    expect(room.publicState.countdownRemaining).toBe(REVEAL_DELAY_MS);
  });
  it('abort guard: not-all-voted at 0 nulls countdown instead of revealing', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5');
    room.castVote('p1', '8');
    // joiner arrives after countdown armed; countdown must already be stopped
    room.addPlayer('px', 'Joiner');
    vi.advanceTimersByTime(REVEAL_DELAY_MS * 2);
    expect(room.publicState.phase).toBe('voting');
    expect(room.publicState.countdownRemaining).toBe(null);
  });
  it('vote values hidden in publicState until reveal', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '13');
    const s = JSON.stringify(room.publicState);
    expect(s.includes('13')).toBe(false);
    room.castVote('p1', '5');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(JSON.stringify(room.publicState.reveal ?? room.revealData).includes('13')).toBe(true);
  });
  it('rejects vote by SM or in wrong phase', () => {
    const room = roomWithVoters(2);
    expect(() => room.castVote('sm', '5')).toThrow();
    expect(() => room.castVote('p0', '99')).toThrow();
    expect(() => room.newRound('sm')).toThrow(); // voting phase — newRound only from reveal
  });
});

describe('reveal outcomes', () => {
  it('spread shows min-max of numeric votes; coffee/question excluded', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(3);
    room.castVote('p0', '5'); room.castVote('p1', 'coffee'); room.castVote('p2', '13');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(room.revealData.spread).toEqual({ min: 5, max: 13 });
  });
  it('suggestedPoints is median of numeric votes', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(3);
    room.castVote('p0', '3'); room.castVote('p1', '8'); room.castVote('p2', '13');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(room.revealData.suggestedPoints).toBe(8);
  });
  it('consensus records history and returns to lobby', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(3);
    room.castVote('p0', '5'); room.castVote('p1', '8'); room.castVote('p2', '13');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    room.consensus('sm', '8');
    expect(room.publicState.phase).toBe('lobby');
    expect(room.publicState.history).toEqual([
      { description: 'Fix the login bug', points: 8, time: expect.any(Number) },
    ]);
  });
  it('consensus rejects non-numeric points', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5'); room.castVote('p1', '8');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(() => room.consensus('sm', 'coffee')).toThrow();
  });
  it('revote keeps description, clears votes', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5'); room.castVote('p1', '8');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    room.revote('sm');
    expect(room.publicState.phase).toBe('voting');
    expect(room.publicState.description).toBe('Fix the login bug');
    expect(room.publicState.players.every((p) => !p.voted || p.role === 'sm')).toBe(true);
  });
  it('new round only from reveal; clears description', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5'); room.castVote('p1', '8');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    room.newRound('sm');
    expect(room.publicState.phase).toBe('lobby');
    expect(room.publicState.description).toBe('');
  });
  it('new round rejected from voting phase', () => {
    const room = roomWithVoters(2);
    expect(() => room.newRound('sm')).toThrow();
  });
  it('non-SM cannot call consensus/revote/new', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5'); room.castVote('p1', '8');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(() => room.consensus('p0', 5)).toThrow();
    expect(() => room.revote('p0')).toThrow();
    expect(() => room.newRound('p0')).toThrow();
  });
});

describe('abandon round', () => {
  it('SM can abandon a voting round: votes wiped, countdown stopped, back to lobby', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(3);
    room.castVote('p0', '5'); room.castVote('p1', '8'); room.castVote('p2', '13');
    expect(room.publicState.countdownRemaining).not.toBe(null);
    room.abandonRound('sm');
    expect(room.publicState.phase).toBe('lobby');
    expect(room.publicState.countdownRemaining).toBe(null);
    expect(room.publicState.players.every((p) => !p.voted || p.role === 'sm')).toBe(true);
    vi.advanceTimersByTime(REVEAL_DELAY_MS * 3);
    expect(room.publicState.phase).toBe('lobby'); // no pending timer fires a reveal
  });
  it('abandoned description is recoverable via lastDescription', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5'); room.castVote('p1', '8');
    room.abandonRound('sm');
    expect(room.lastDescription).toBe('Fix the login bug');
    expect(room.publicState.description).toBe('');
  });
  it('abandon rejected from reveal phase', () => {
    vi.useFakeTimers();
    const room = roomWithVoters(2);
    room.castVote('p0', '5'); room.castVote('p1', '8');
    vi.advanceTimersByTime(REVEAL_DELAY_MS);
    expect(() => room.abandonRound('sm')).toThrow();
  });
  it('abandon rejected from lobby', () => {
    const room = roomWithVoters(2);
    room.abandonRound('sm'); // first abandon lands in lobby
    expect(() => room.abandonRound('sm')).toThrow();
  });
  it('non-SM cannot abandon', () => {
    const room = roomWithVoters(2);
    expect(() => room.abandonRound('p0')).toThrow();
  });
});