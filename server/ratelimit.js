export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> timestamps
  return {
    check(ip) {
      const now = Date.now();
      const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
      if (arr.length === 0) {
        hits.delete(ip); // prune: no live entries left for this key
        arr.push(now);
        hits.set(ip, arr);
        return true;
      }
      if (arr.length >= max) {
        hits.set(ip, arr);
        return false;
      }
      arr.push(now);
      hits.set(ip, arr);
      return true;
    },
    reset() { hits.clear(); },
  };
}

export function createAttemptTracker({ max, lockoutMs }) {
  const bad = new Map();         // ip -> count
  const lockedUntil = new Map(); // ip -> ts
  return {
    record(ip, ok) {
      const now = Date.now();
      const until = lockedUntil.get(ip) ?? 0;
      if (until > now) return { locked: true, remaining: 0 };
      if (until !== 0) lockedUntil.delete(ip); // prune expired lockout
      if (ok) {
        bad.delete(ip);
        return { locked: false, remaining: max };
      }
      const count = (bad.get(ip) ?? 0) + 1;
      bad.set(ip, count);
      if (count >= max) {
        lockedUntil.set(ip, now + lockoutMs);
        bad.delete(ip);
        return { locked: true, remaining: 0 };
      }
      return { locked: false, remaining: max - count };
    },
    isLocked(ip) {
      const until = lockedUntil.get(ip) ?? 0;
      if (until > Date.now()) return true;
      if (until !== 0) lockedUntil.delete(ip); // prune on read
      return false;
    },
    reset() { bad.clear(); lockedUntil.clear(); },
  };
}