import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter, createAttemptTracker } from '../server/ratelimit.js';

describe('createRateLimiter', () => {
  it('allows up to max in window then blocks', () => {
    const rl = createRateLimiter({ windowMs: 60000, max: 3 });
    expect(rl.check('1.1.1.1')).toBe(true);
    expect(rl.check('1.1.1.1')).toBe(true);
    expect(rl.check('1.1.1.1')).toBe(true);
    expect(rl.check('1.1.1.1')).toBe(false);
    expect(rl.check('2.2.2.2')).toBe(true);
  });
  it('window expires', () => {
    vi.useFakeTimers();
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.check('ip')).toBe(true);
    expect(rl.check('ip')).toBe(false);
    vi.advanceTimersByTime(1100);
    expect(rl.check('ip')).toBe(true);
    vi.useRealTimers();
  });
});

describe('createAttemptTracker', () => {
  it('locks out after max bad attempts', () => {
    const t = createAttemptTracker({ max: 2, lockoutMs: 1000 });
    expect(t.record('ip', false)).toEqual({ locked: false, remaining: 1 });
    expect(t.record('ip', false)).toEqual({ locked: true, remaining: 0 });
    expect(t.isLocked('ip')).toBe(true);
  });
  it('isLocked true during lockout even for good attempts', () => {
    const t = createAttemptTracker({ max: 1, lockoutMs: 5000 });
    t.record('ip', false);
    expect(t.isLocked('ip')).toBe(true);
    expect(t.record('ip', true).locked).toBe(true);
  });
  it('lockout expires', () => {
    vi.useFakeTimers();
    const t = createAttemptTracker({ max: 2, lockoutMs: 1000 });
    t.record('ip', false);
    t.record('ip', false);
    vi.advanceTimersByTime(1100);
    expect(t.isLocked('ip')).toBe(false);
    expect(t.record('ip', false).locked).toBe(false);
    vi.useRealTimers();
  });
  it('good attempt clears counter (not a lockout)', () => {
    const t = createAttemptTracker({ max: 2, lockoutMs: 1000 });
    t.record('ip', false);
    t.record('ip', true);
    expect(t.record('ip', false).locked).toBe(false);
  });
});