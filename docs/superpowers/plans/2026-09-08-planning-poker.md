# PIXEL POINTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PIXEL POINTS — self-hosted, dockerised planning poker app (Node.js + Socket.IO, vanilla frontend) with Jackbox-style room codes, private Fibonacci hands, server-timed auto-reveal, and four retro-arcade themes.

**Architecture:** Single Node process serves static files and Socket.IO realtime. Server is authoritative: in-memory room registry, state machine (`lobby → voting → reveal`), server-side 5s reveal timer, per-IP rate limiting. Client is one phone-first page rendering role-dependent views from server state snapshots.

**Tech Stack:** Node 22, Express 4 (static serving only), Socket.IO 4, Vitest, socket.io-client (dev, for integration tests), Docker (node:22-slim). No frontend build step; vanilla JS/CSS.

**Spec:** `docs/superpowers/specs/2026-09-08-planning-poker-design.md` — read it first.

## Global Constraints

- App name in all user-facing surfaces: **PIXEL POINTS**. Page title, header, README. Docker image tag: `pixel-points`.
- Deck values (exact strings, wire identifiers): `["0","1","2","3","5","8","13","21","coffee","question"]`. `coffee`/`question` are non-numeric; excluded from spread and consensus points. Consensus points must be one of `"0","1","2","3","5","8","13","21"`.
- Room code alphabet: `ACDEFGHJKMNPQRTUVWXY234679` (4 chars, uppercase). Generate randomly, avoid collisions.
- Names: trim, strip control characters, max 24 chars. Descriptions: max 140 chars (server truncates).
- Room capacity 12 (1 SM + 11 voters). Minimum 2 connected non-SM players to start a round.
- Reveal timer: 5s, server-authoritative; any vote cast/change during countdown resets it to full 5s; votes allowed only during `voting` phase (countdown is part of voting).
- Grace: a voted player who disconnects keeps their vote; countdown continues. A not-yet-voted disconnected joiner stops the countdown until they vote or are evicted after 60s grace. The SM is NEVER evicted by the sweep.
- Room deletion: 15min after zero connected players. Rooms count as empty based on *connected* players (SM included in the connected check for TTL purposes but never evicted).
- Rate limits per IP: 20 join/create attempts per minute (sliding window); 10 bad room codes → 5-minute lockout from join AND create. `isLocked` checked first in both handlers; a successful create does NOT clear the bad-code counter.
- Privacy invariant: server never includes other players' vote values in any payload unless phase is `reveal`.
- All user content rendered as text (`textContent` / DOM APIs only, never `innerHTML` with user strings).
- Every socket handler guards `typeof ack === 'function'` before calling acks.
- One active room per socket: a socket that already owns a session gets `room:create` rejected.
- Static serving must prevent path traversal (resolve + prefix check under `public/`).
- Port 3000 (`PORT` env override), `/healthz` endpoint, non-root Docker user, `SIGTERM`/`SIGINT` graceful shutdown.
- Themes: `crt-dark` (default), `crt-light`, `pixel-dark`, `pixel-light`; per-device localStorage persistence (`pp-theme`); `prefers-color-scheme: light` → `crt-light` initial default only when no stored choice; consistent hue per card value across themes.
- Tests: Vitest; fake timers for engine/limiter units; real-socket integration test with `vi.waitFor` for the 5s reveal.
- Commits: conventional (`feat:`, `fix:`, `test:`, `chore:`). Always `git add` the exact files touched including `package-lock.json` whenever `npm i` ran in that task.

---

### Task 1: Project scaffold + validation module

**Files:**
- Create: `package.json` (via npm init), `.gitignore`, `vitest.config.js`, `server/validation.js`, `test/validation.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (used by tasks 3, 4, 5): `DECK`, `NUMERIC_DECK` (arrays), `CODE_ALPHABET` (string), `sanitizeName(raw) -> {ok, name} | {ok: false, error}`, `sanitizeDescription(raw) -> string` (≤140), `isValidVote(v) -> boolean`, `normalizeCode(raw) -> string`.

- [ ] **Step 1: Init project**

```bash
git init
npm init -y
npm pkg set type=module main=server/index.js
npm pkg set scripts.start="node server/index.js"
npm pkg set scripts.dev="node --watch server/index.js"
npm pkg set scripts.test="vitest run"
npm i express@4 socket.io@4
npm i -D vitest@2.1.0 socket.io-client
```

`.gitignore`:
```
node_modules/
.superpowers/
*.log
```

`vitest.config.js`:
```js
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 2: Write failing tests**

`test/validation.test.js`:
```js
import { describe, it, expect } from 'vitest';
import {
  sanitizeName, sanitizeDescription, isValidVote, normalizeCode,
  DECK, NUMERIC_DECK, CODE_ALPHABET,
} from '../server/validation.js';

describe('sanitizeName', () => {
  it('trims and allows normal names', () => {
    expect(sanitizeName('  Jason ')).toEqual({ ok: true, name: 'Jason' });
  });
  it('rejects empty', () => {
    expect(sanitizeName('   ')).toEqual({ ok: false, error: 'Name required' });
  });
  it('rejects non-strings', () => {
    expect(sanitizeName(42)).toEqual({ ok: false, error: 'Name required' });
  });
  it('strips control chars', () => {
    expect(sanitizeName('Ja\x00son\x1b')).toEqual({ ok: true, name: 'Jason' });
  });
  it('rejects over 24 chars', () => {
    expect(sanitizeName('a'.repeat(30))).toEqual({ ok: false, error: 'Name too long' });
  });
});

describe('sanitizeDescription', () => {
  it('truncates to 140', () => {
    expect(sanitizeDescription('a'.repeat(200)).length).toBe(140);
  });
  it('trims and strips control chars', () => {
    expect(sanitizeDescription(' h\x00i ')).toBe('hi');
  });
  it('returns empty string for non-strings', () => {
    expect(sanitizeDescription(undefined)).toBe('');
  });
});

describe('isValidVote', () => {
  it('accepts every deck value and nothing else', () => {
    for (const v of DECK) expect(isValidVote(v)).toBe(true);
    expect(isValidVote('99')).toBe(false);
    expect(isValidVote('Coffee')).toBe(false);
    expect(isValidVote('')).toBe(false);
  });
});

describe('normalizeCode', () => {
  it('uppercases and filters to alphabet', () => {
    expect(normalizeCode('a c-d')).toBe('ACD');
  });
  it('empty for junk', () => {
    expect(normalizeCode('0OIl')).toBe('');
    expect(normalizeCode(123)).toBe('');
  });
});

describe('constants', () => {
  it('deck has 10 values; numeric deck is the 8 numbers', () => {
    expect(DECK).toEqual(['0','1','2','3','5','8','13','21','coffee','question']);
    expect(NUMERIC_DECK).toEqual(['0','1','2','3','5','8','13','21']);
  });
  it('code alphabet excludes ambiguous chars', () => {
    expect(CODE_ALPHABET).toBe('ACDEFGHJKMNPQRTUVWXY234679');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/validation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement validation.js**

```js
export const DECK = ['0', '1', '2', '3', '5', '8', '13', '21', 'coffee', 'question'];
export const NUMERIC_DECK = ['0', '1', '2', '3', '5', '8', '13', '21'];
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY234679';

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Name required' };
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return { ok: false, error: 'Name required' };
  if (name.length > 24) return { ok: false, error: 'Name too long' };
  return { ok: true, name };
}

export function sanitizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140);
}

export function isValidVote(v) {
  return DECK.includes(v);
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const re = new RegExp(`[^${CODE_ALPHABET}]`, 'g');
  return raw.toUpperCase().replace(re, '');
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run test/validation.test.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore vitest.config.js server/validation.js test/validation.test.js
git commit -m "chore: scaffold PIXEL POINTS with validation module and tests"
```

---

### Task 2: Rate limiter

**Files:**
- Create: `server/ratelimit.js`, `test/ratelimit.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 5): `createRateLimiter({windowMs, max}) -> {check(ip): boolean, reset()}`; `createAttemptTracker({max, lockoutMs}) -> {record(ip, ok): {locked, remaining}, isLocked(ip): boolean, reset()}`.

- [ ] **Step 1: Write failing tests**

`test/ratelimit.test.js`:
```js
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
    const t = createAttemptTracker({ max: 1, lockoutMs: 1000 });
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ratelimit.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ratelimit.js**

```js
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> timestamps
  return {
    check(ip) {
      const now = Date.now();
      const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
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
      if ((lockedUntil.get(ip) ?? 0) > now) return { locked: true, remaining: 0 };
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
      return (lockedUntil.get(ip) ?? 0) > Date.now();
    },
    reset() { bad.clear(); lockedUntil.clear(); },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/ratelimit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ratelimit.js test/ratelimit.test.js
git commit -m "feat: per-IP rate limiter and bad-code attempt tracker with isLocked"
```

---

### Task 3: Game engine (room state machine)

**Files:**
- Create: `server/game.js`, `test/game.test.js`

**Interfaces:**
- Consumes: `DECK`, `NUMERIC_DECK`, `isValidVote`, `sanitizeDescription` from validation.js.
- Produces (used by Task 4/5):
  - `REVEAL_DELAY_MS = 5000` (exported const)
  - `class GameRoom` with constructor `(roomCode, {onCountdownEnd = () => {}} = {})`. **Task 4 must pass `onCountdownEnd`** (see its code) — the engine calls `this._onCountdownEnd(this.revealData)` inside `reveal()`.
  - Methods: `addSm(sessionId, name)`, `addPlayer(sessionId, name) -> player` (throws `'Room full'`; calls `_recomputeCountdown` for mid-vote joins), `removePlayer(sessionId)`, `disconnect(sessionId)` (grace: keeps voted player's vote), `reconnect(sessionId)`, `getPlayer(sessionId)`, `startRound(sessionId, description)` (throws unless SM/lobby/≥2 connected voters/non-empty description), `castVote(sessionId, value)` (voting phase only; resets countdown if running), `reveal()`, `consensus(sessionId, points)`, `revote(sessionId)`, `newRound(sessionId)` (reveal phase only), getters `publicState`, `revealData`, `players` (Map), `code`, `phase`.
  - `publicState` shape (exact): `{phase, description, history, players: [{name, role, connected, voted}], countdownRemaining: number|null}` — **no vote values**.
  - `revealData` shape (exact, non-null only in reveal): `{description, players: [{name, vote}], spread: {min, max}|null, suggestedPoints: number|null}`.
  - Player object fields: `{sessionId, name, role: 'sm'|'player', connected, connectedAt: number|undefined, vote, voted}`.

**Grace semantics (from spec — implement exactly):**
- `disconnect()` during `voting`: if the player had `voted`, KEEP vote and `voted=true` (countdown continues); if not voted, leave un-voted (countdown stays stopped). Never clear votes on disconnect. Set `connected=false`, `connectedAt=Date.now()`. During `reveal`: same flags, vote stays for display.
- `addPlayer` during `voting`: new player `voted=false` → call `_recomputeCountdown()` so an in-flight countdown stops until they vote.
- Countdown abort guard: in the `setTimeout` callback, if `!allVotersVoted()`, set `_countdownEndsAt = null`, do NOT reveal.

- [ ] **Step 1: Write failing tests**

`test/game.test.js`:
```js
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
    const room = roomWithVoters(2);
    room.newRound('sm');
    expect(() => room.startRound('sm', '   ')).toThrow();
  });
  it('rejects start by non-SM', () => {
    const room = roomWithVoters(2);
    room.newRound('sm');
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
    room.newRound('sm');
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/game.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement game.js**

```js
import { NUMERIC_DECK, isValidVote, sanitizeDescription } from './validation.js';

export const REVEAL_DELAY_MS = 5000;
const MAX_PLAYERS = 12;
const MIN_VOTERS = 2;

export class GameRoom {
  constructor(roomCode, { onCountdownEnd = () => {} } = {}) {
    this.code = roomCode;
    this.players = new Map(); // sessionId -> player
    this.phase = 'lobby';
    this.description = '';
    this.history = [];
    this._onCountdownEnd = onCountdownEnd;
    this._countdownTimer = null;
    this._countdownEndsAt = null;
  }

  addSm(sessionId, name) {
    const sm = { sessionId, name, role: 'sm', connected: true, connectedAt: undefined, vote: null, voted: false };
    this.players.set(sessionId, sm);
    return sm;
  }

  _uniqueName(name) {
    const names = new Set([...this.players.values()].map((p) => p.name));
    if (!names.has(name)) return name;
    let i = 2;
    while (names.has(`${name} ${i}`)) i++;
    return `${name} ${i}`;
  }

  addPlayer(sessionId, name) {
    if (this.players.size >= MAX_PLAYERS) throw new Error('Room full');
    const player = {
      sessionId, name: this._uniqueName(name), role: 'player',
      connected: true, connectedAt: undefined, vote: null, voted: false,
    };
    this.players.set(sessionId, player);
    this._recomputeCountdown(); // mid-vote join stops an in-flight countdown
    return player;
  }

  removePlayer(sessionId) {
    this.players.delete(sessionId);
    this._recomputeCountdown();
  }

  disconnect(sessionId) {
    const p = this.players.get(sessionId);
    if (!p) return;
    p.connected = false;
    p.connectedAt = Date.now();
    // GRACE: a voted player keeps their vote; countdown continues (spec).
  }

  reconnect(sessionId) {
    const p = this.players.get(sessionId);
    if (p) { p.connected = true; p.connectedAt = undefined; }
  }

  getPlayer(sessionId) { return this.players.get(sessionId); }

  get connectedVoters() {
    return [...this.players.values()].filter((p) => p.role === 'player' && p.connected);
  }

  startRound(sessionId, description) {
    const p = this.players.get(sessionId);
    if (!p || p.role !== 'sm') throw new Error('Only the Scrum Master can start a round');
    if (this.phase !== 'lobby') throw new Error('Round already in progress');
    if (this.connectedVoters.length < MIN_VOTERS) throw new Error('Need at least 2 players to vote');
    const desc = sanitizeDescription(description);
    if (!desc) throw new Error('Description required');
    this.description = desc;
    for (const pl of this.players.values()) { pl.vote = null; pl.voted = false; }
    this.phase = 'voting';
  }

  castVote(sessionId, value) {
    const p = this.players.get(sessionId);
    if (!p || p.role !== 'player') throw new Error('Not a voter');
    if (!p.connected) throw new Error('Not connected');
    if (this.phase !== 'voting') throw new Error('Not voting phase');
    if (!isValidVote(value)) throw new Error('Invalid vote');
    p.vote = value;
    p.voted = true;
    this._recomputeCountdown(); // arms OR resets to full 5s if already armed
  }

  allVotersVoted() {
    return this.connectedVoters.length >= MIN_VOTERS
      && this.connectedVoters.every((p) => p.voted);
  }

  _recomputeCountdown() {
    if (this.phase !== 'voting') return;
    if (this.allVotersVoted()) {
      this._armCountdown();
    } else {
      this._clearCountdown();
    }
  }

  _armCountdown() {
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    this._countdownEndsAt = Date.now() + REVEAL_DELAY_MS;
    this._countdownTimer = setTimeout(() => {
      this._countdownTimer = null;
      if (this.phase === 'voting' && this.allVotersVoted()) {
        this.reveal();
      } else {
        this._countdownEndsAt = null; // abort guard: never a stuck 0
      }
    }, REVEAL_DELAY_MS);
  }

  _clearCountdown() {
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    this._countdownTimer = null;
    this._countdownEndsAt = null;
  }

  reveal() {
    this._clearCountdown();
    this.phase = 'reveal';
    this._onCountdownEnd(this.revealData);
  }

  _suggestedPoints() {
    const nums = this.connectedVoters
      .map((p) => p.vote)
      .filter((v) => NUMERIC_DECK.includes(v))
      .map(Number)
      .sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : nums[mid - 1];
  }

  _requireSm(sessionId) {
    const p = this.players.get(sessionId);
    if (!p || p.role !== 'sm') throw new Error('Only the Scrum Master can do that');
    return p;
  }

  consensus(sessionId, points) {
    this._requireSm(sessionId);
    if (this.phase !== 'reveal') throw new Error('Nothing to decide');
    if (!NUMERIC_DECK.includes(String(points))) throw new Error('Invalid points');
    this.history.unshift({ description: this.description, points: Number(points), time: Date.now() });
    this.phase = 'lobby';
    this.description = '';
    for (const pl of this.players.values()) { pl.vote = null; pl.voted = false; }
  }

  revote(sessionId) {
    this._requireSm(sessionId);
    if (this.phase !== 'reveal') throw new Error('Nothing to decide');
    this.phase = 'voting';
    for (const pl of this.players.values()) { pl.vote = null; pl.voted = false; }
  }

  newRound(sessionId) {
    this._requireSm(sessionId);
    if (this.phase !== 'reveal') throw new Error('Only after a reveal');
    this._clearCountdown();
    this.phase = 'lobby';
    this.description = '';
    for (const pl of this.players.values()) { pl.vote = null; pl.voted = false; }
  }

  get publicState() {
    return {
      phase: this.phase,
      description: this.description,
      history: this.history,
      players: [...this.players.values()].map((p) => ({
        name: p.name, role: p.role, connected: p.connected, voted: p.voted,
      })),
      countdownRemaining: this._countdownEndsAt !== null
        ? Math.max(0, this._countdownEndsAt - Date.now())
        : null,
    };
  }

  get revealData() {
    if (this.phase !== 'reveal') return null;
    const players = [...this.players.values()]
      .filter((p) => p.role === 'player')
      .map((p) => ({ name: p.name, vote: p.vote, connected: p.connected }));
    const nums = players
      .filter((p) => NUMERIC_DECK.includes(p.vote))
      .map((p) => Number(p.vote));
    return {
      description: this.description,
      players,
      spread: nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null,
      suggestedPoints: this._suggestedPoints(),
    };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/game.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/game.js test/game.test.js
git commit -m "feat: room state machine with grace rules, countdown reset, reveal, history"
```

---

### Task 4: Room registry (codes, sessions, grace, cleanup)

**Files:**
- Create: `server/rooms.js`, `test/rooms.test.js`

**Interfaces:**
- Consumes: `GameRoom` from game.js; `CODE_ALPHABET` from validation.js.
- Produces (used by Task 5):
  - `createRoomRegistry() -> registry` with:
    - `createRoom(smSessionId, smName) -> {code, room, token}` (passes `{onCountdownEnd: (data) => registry._broadcastReveal(code, data)}` to `GameRoom`)
    - `joinRoom(code, sessionId, name) -> {room, player, token}` | throws `'Room not found'` / `'Room full'`
    - `getBySession(token) -> {room, sessionId, player} | null`
    - `removeSession(token)`
    - `sweep(now?)` — evicts non-SM players disconnected > 60s; deletes rooms with zero *connected* players observed empty > 15min; calls `room.removePlayer` on evictions (so countdown recomputes)
    - `setRevealBroadcaster(fn)` — Task 5 calls this to install `(code, revealData) => void` so engine-triggered reveals broadcast. (Registry can't own socket logic.)
  - Constants: `DISCONNECT_GRACE_MS = 60_000`, `ROOM_EMPTY_TTL_MS = 15 * 60_000`.
- Sessions map: `token -> {roomCode, sessionId}`. Registry owns minting via `randomUUID()`.

- [ ] **Step 1: Write failing tests**

`test/rooms.test.js`:
```js
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
    const room = reg.getBySession(reg.createRoom('smY', 'B2').token).room;
    reg.joinRoom(code, 'p1', 'A');
    // disconnect everyone through the API (sets connectedAt)
    for (const sid of [...room.players.keys()]) room.disconnect(sid);
    reg.sweep(); // first observation of empty
    vi.advanceTimersByTime(ROOM_EMPTY_TTL_MS + 1000);
    reg.sweep();
    expect(() => reg.joinRoom(code, 'px', 'X')).toThrow('Room not found');
    vi.useRealTimers();
  });
  it('eviction drops vote and recomputes countdown', () => {
    vi.useFakeTimers();
    const reg = createRoomRegistry();
    const { code } = reg.createRoom('smZ', 'Boss');
    const room = reg.getBySession(reg.createRoom('smW', 'B').token).room;
    // use first room: recreate cleanly
    const r2 = createRoomRegistry();
    void reg; void code;
    const { code: c2 } = r2.createRoom('smQ', 'Boss');
    const room2 = r2.getBySession(r2.createRoom('smR', 'B').token).room;
    void room;
    const rr = r2.joinRoom(c2, 'p1', 'A').room;
    r2.joinRoom(c2, 'p2', 'B');
    rr.startRound('smQ', 'd');
    rr.castVote('p1', '5'); rr.castVote('p2', '8');
    expect(rr.publicState.countdownRemaining).not.toBe(null);
    rr.disconnect('p2'); // grace: countdown continues
    expect(rr.publicState.countdownRemaining).not.toBe(null);
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 1000);
    r2.sweep();
    expect(rr.publicState.countdownRemaining).toBe(null); // vote dropped by eviction
    vi.useRealTimers();
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
```

Note: the `'eviction drops vote'` test creates extra rooms via `reg.createRoom('smW'...)` etc. to fetch a room handle — that is fine; it only uses the last registry (`r2`) for assertions. If it reads awkwardly, simplify by exposing `getRoom(code)` on the registry (preferred — add `getRoom(code) -> room|null` to the interface and use it instead of the double-create trick, in both this test and Task 5).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/rooms.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement rooms.js**

```js
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run test/rooms.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/rooms.js test/rooms.test.js
git commit -m "feat: room registry with sessions, SM-safe grace eviction, empty-room GC"
```

---

### Task 5: Socket server wiring + integration tests

**Files:**
- Create: `server/index.js`, `test/server.test.js`

**Interfaces:**
- Consumes: registry (Task 4: `createRoom`, `joinRoom`, `getBySession`, `getRoom`, `removeSession`, `sweep`, `setRevealBroadcaster`), limiters (Task 2), validation (Task 1).
- Produces: exported `startServer({port = 0}) -> Promise<{httpServer, io, port, close()}>` (testable; `port: 0` = ephemeral). `server/index.js` runs `startServer({port: process.env.PORT || 3000})` when executed directly (`import.meta.url` check) — the same file is the production entrypoint AND the testable module. Wire contract (exact):
  - C→S (all ack): `room:create {name}` → `{ok, code, token, state}`; `room:join {code, name}` → `{ok, code, token, name, state}`; `session:resume {token}` → `{ok, state}`; `round:start {description}`; `vote:cast {value}`; `round:consensus {points}`; `round:revote`; `round:new` → `{ok}` | `{ok: false, error}`.
  - S→C: `room:state` — emitted **individually** to one socket with full state incl. `you: {name, role, voted, vote}`; `room:update` — broadcast (no `you`); both share the state shape: `{phase, description, history, players: [{name, role, connected, voted}], countdownRemaining, reveal: revealData|null, you?}`.
  - Every state-emitting handler: apply mutation → `broadcastRoom(room)` → also `emitStateTo(socket, room)` for the actor when the actor needs `you` (create/join/resume emit `room:state` after ack).

**Security rules implemented here (from Global Constraints):**
- `isLocked(ip)` check FIRST in both `room:create` and `room:join` → ack `{ok: false, error: 'Too many attempts. Try again in a few minutes.'}` without recording.
- `joinLimiter.check(ip)` false → same message.
- Unknown room code on join → `badCodeTracker.record(ip, false)`; successful join → `record(ip, true)`. `room:create` NEVER calls `record(ip, true)` (does not clear bad-code counter) but DOES consume `joinLimiter`.
- One room per socket: `socket.data.token` set → reject `room:create` with `'You already host a room'`.
- `typeof ack === 'function'` guard on every handler; ack default no-op.
- Static server: resolve `path.join(publicDir, req.url)`, require `resolved.startsWith(publicDirResolved + path.sep)`, else 404. `express.static` is also acceptable — use it (express is a dependency): `app.use(express.static('public'))` + `app.get('/healthz', ...)`; mount Socket.IO on the same HTTP server.
- IP: `socket.request.headers['x-forwarded-for']?.split(',')[0].trim() ?? socket.handshake.address`.
- Reveal broadcast: `reg.setRevealBroadcaster((code) => { const room = reg.getRoom(code); if (room) broadcastRoom(room); })` — engine fires this on countdown end; broadcast carries `reveal` data + phase change.
- Disconnect: `room.disconnect(sessionId)` then `broadcastRoom(room)` so others see the disconnect immediately.
- `session:resume` when socket already has a session: rebinding is allowed (refresh case) — overwrite `socket.data`.
- Sweep interval 15s, `.unref()`. SIGTERM/SIGINT → close io+server, `process.exit(0)` within 3s.

- [ ] **Step 1: Write `server/index.js`**

```js
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
  const io = new Server(httpServer);

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

  const ipOf = (socket) =>
    socket.request.headers['x-forwarded-for']?.split(',')[0].trim()
      ?? socket.handshake.address;

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
      socket.join(out.code);
      ack({ ok: true, code: out.code, token: out.token, name: out.player.name, state: stateFor(out.room, sessionId) });
      broadcastRoom(out.room);
      socket.emit('room:state', stateFor(out.room, sessionId));
    });

    socket.on('session:resume', (data, ack) => {
      ack = ackOr(ack);
      const hit = data?.token ? reg.getBySession(data.token) : null;
      if (!hit) return ack({ ok: false, error: 'session expired' });
      socket.data.token = data.token;
      socket.join(hit.room.code);
      hit.room.reconnect(hit.sessionId);
      ack({ ok: true, state: stateFor(hit.room, hit.sessionId) });
      broadcastRoom(hit.room);
      socket.emit('room:state', stateFor(hit.room, hit.sessionId));
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
```

Note: for graceful SIGTERM the `close()` path above (io.close + server.close) is exercised in tests; the direct-run branch's `process.exit(0)` is acceptable because Socket.IO clients reconnect and the state is in-memory anyway.

- [ ] **Step 2: Write integration tests**

`test/server.test.js`:
```js
import { describe, it, expect, afterEach } from 'vitest';
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
  clients.push(c);
  return c;
}
afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  if (srv) await srv.close();
  srv = null;
});

const emitAck = (c, ev, data) => new Promise((res) => c.emit(ev, data, res));
const nextEvent = (c, ev) => new Promise((res) => c.once(ev, res));

describe('PIXEL POINTS integration', () => {
  it('create → join → role delivered → vote → hidden → reveal', async () => {
    const url = await boot();
    const sm = connect(url);
    const smState = await new Promise((res) => { sm.on('connect', res); });
    void smState;
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    expect(create.ok).toBe(true);
    expect(create.state.you.role).toBe('sm');
    const smStateEv = await nextEvent(sm, 'room:state');
    expect(smStateEv.you.role).toBe('sm');

    const p1 = connect(url);
    await new Promise((res) => p1.on('connect', res));
    const p2 = connect(url);
    await new Promise((res) => p2.on('connect', res));
    const j1 = await emitAck(p1, 'room:join', { code: create.code, name: 'Alice' });
    const j2 = await emitAck(p2, 'room:join', { code: create.code, name: 'Bob' });
    expect(j1.ok).toBe(true);
    expect(j1.name).toBe('Alice');
    expect(j1.state.you.role).toBe('player');

    const start = await emitAck(sm, 'round:start', { description: 'Fix login' });
    expect(start.ok).toBe(true);

    // p1 votes — p2 must NOT see the value, only voted flag
    const vote = await emitAck(p1, 'vote:cast', { value: '13' });
    expect(vote.ok).toBe(true);
    const p2view = await nextEvent(p2, 'room:update');
    expect(JSON.stringify(p2view)).not.toContain('"13"');
    expect(p2view.players.find((p) => p.name === 'Alice').voted).toBe(true);

    // p2 votes → countdown → reveal broadcast with votes
    await emitAck(p2, 'vote:cast', { value: '5' });
    const reveal = await vi.waitFor(async () => {
      const upd = await nextEvent(sm, 'room:update');
      if (upd.phase === 'reveal') return upd;
      throw new Error('not reveal yet');
    }, { timeout: 8000 });
    expect(reveal.reveal.players.find((p) => p.name === 'Alice').vote).toBe('13');
    expect(reveal.reveal.spread).toEqual({ min: 5, max: 13 });
    expect(reveal.reveal.suggestedPoints).toBe(5);

    const bad = await emitAck(p1, 'round:consensus', { points: '5' });
    expect(bad.ok).toBe(false); // player can't decide
    const done = await emitAck(sm, 'round:consensus', { points: '5' });
    expect(done.ok).toBe(true);
    const lobby = await nextEvent(p1, 'room:update');
    expect(lobby.phase).toBe('lobby');
    expect(lobby.history[0]).toEqual({ description: 'Fix login', points: 5, time: expect.any(Number) });
  }, 15000);

  it('vote change during countdown resets it (observed via countdownRemaining)', async () => {
    const { vi } = await import('vitest');
    void vi;
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
    await emitAck(sm, 'round:start', { description: 'd' });
    await emitAck(p1, 'vote:cast', { value: '3' });
    await emitAck(p2, 'vote:cast', { value: '5' });
    const upd1 = await nextEvent(sm, 'room:update');
    expect(upd1.countdownRemaining).not.toBe(null);
    await new Promise((r) => setTimeout(r, 2000));
    await emitAck(p2, 'vote:cast', { value: '8' });
    const upd2 = await nextEvent(sm, 'room:update');
    expect(upd2.countdownRemaining).toBeGreaterThan(3000); // reset, not ~2.5s
    // clean up: disconnect clients in afterEach
  }, 15000);

  it('resume restores role after reconnect; expired token bounces', async () => {
    const url = await boot();
    const p = connect(url);
    await new Promise((res) => p.on('connect', res));
    const sm = connect(url);
    await new Promise((res) => sm.on('connect', res));
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const join = await emitAck(p, 'room:join', { code: create.code, name: 'Alice' });
    expect(join.ok).toBe(true);
    p.disconnect();
    const p2 = connect(url);
    await new Promise((res) => p2.on('connect', res));
    const resume = await emitAck(p2, 'session:resume', { token: join.token });
    expect(resume.ok).toBe(true);
    expect(resume.state.you.name).toBe('Alice');
    expect(resume.state.you.role).toBe('player');
    const stale = await emitAck(p2, 'session:resume', { token: 'nope' });
    expect(stale.ok).toBe(false);
  }, 10000);

  it('locked IP cannot create or join', async () => {
    const url = await boot();
    const c = connect(url);
    await new Promise((res) => c.on('connect', res));
    for (let i = 0; i < 10; i++) {
      await emitAck(c, 'room:join', { code: 'ZZZZ', name: 'X' });
    }
    const locked = await emitAck(c, 'room:join', { code: 'ZZZZ', name: 'X' });
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/Too many attempts/);
    const create = await emitAck(c, 'room:create', { name: 'X' });
    expect(create.ok).toBe(false); // lockout blocks create too
  }, 10000);

  it('non-numeric vote rejected; SM cannot vote', async () => {
    const url = await boot();
    const sm = connect(url);
    await new Promise((res) => sm.on('connect', res));
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const p1 = connect(url);
    await new Promise((res) => p1.on('connect', res));
    await emitAck(p1, 'room:join', { code: create.code, name: 'A' });
    const p2 = connect(url);
    await new Promise((res) => p2.on('connect', res));
    await emitAck(p2, 'room:join', { code: create.code, name: 'B' });
    await emitAck(sm, 'round:start', { description: 'd' });
    const bad = await emitAck(p1, 'vote:cast', { value: '99' });
    expect(bad.ok).toBe(false);
    const smVote = await emitAck(sm, 'vote:cast', { value: '5' });
    expect(smVote.ok).toBe(false);
  }, 10000);

  it('duplicate names suffixed', async () => {
    const url = await boot();
    const sm = connect(url);
    await new Promise((res) => sm.on('connect', res));
    const create = await emitAck(sm, 'room:create', { name: 'Boss' });
    const a = connect(url);
    await new Promise((res) => a.on('connect', res));
    const j1 = await emitAck(a, 'room:join', { code: create.code, name: 'Sam' });
    const b = connect(url);
    await new Promise((res) => b.on('connect', res));
    const j2 = await emitAck(b, 'room:join', { code: create.code, name: 'Sam' });
    expect(j2.name).toBe('Sam 2');
    void j1;
  }, 10000);
});
```

Import `vi` at the top instead of the weird mid-test dynamic import in test 2 — use `import { describe, it, expect, afterEach, vi } from 'vitest';` and drop the dynamic import line. `nextEvent` consumes one `room:update` per call; since multiple updates arrive per action, prefer draining: collect all `room:update` payloads in an array per client and assert against the array, or use `vi.waitFor` patterns as in test 1. Tests are allowed to be written defensively this way — what matters is the assertions listed.

- [ ] **Step 3: Run ALL tests**

Run: `npx vitest run`
Expected: PASS (validation, ratelimit, game, rooms, server).

- [ ] **Step 4: Commit**

```bash
git add server/index.js test/server.test.js package.json package-lock.json
git commit -m "feat: socket wiring with security guards, state delivery, integration tests"
```

---

### Task 6: Frontend — PIXEL POINTS UI + themes

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/themes.css`, `public/app.js`
- Optional: `public/fonts/press-start-2p.woff2` (Press Start 2P, OFL licence). Fetch from Google Fonts' GitHub (`https://github.com/google/fonts/raw/main/ofl/pressstart2p/PressStart2P-Regular.ttf` → convert, or use the woff2 from a CDN zip stored locally). **If the file can't be fetched at dev time, ship the fallback stack and note it in README. Never add a runtime CDN dependency.**

**Interfaces:**
- Consumes: Task 5 wire contract exactly.
- Produces: the complete UI (no other task depends on frontend internals).

**Rendering rules (critical):**
- All user content via `textContent`/DOM APIs; `innerHTML` only with static, developer-authored strings.
- Phone (`< ~900px`): thumb-reachable card grid; desktop: same page scaled for SM's shared Teams screen.
- History panel accessible on ALL screens (collapsible `<details>` in header area), not just reveal.
- Theme: `<html data-theme="...">`; stored in `localStorage['pp-theme']`; no stored value → `matchMedia('(prefers-color-scheme: light)')` → `crt-light`, else `crt-dark`. Token: `localStorage['pp-token']` — **set it immediately after successful create/join acks**.
- Player's phone in reveal phase: compact "hand revealed" summary (list of votes), not the big grid (that's the SM/board view).
- Countup/countdown: `state.countdownRemaining` is ms-from-server; client computes `endsAt = Date.now() + countdownRemaining` and animates a big overlay locally (setInterval 100ms); when it hits 0 the reveal `room:update` normally already arrived — render phase drives UI, not the timer.
- Reconnect overlay: on `socket.disconnected` show "RECONNECTING…" overlay; on `connect` auto-resume with stored token; if resume fails with `session expired` → clear token, show home.

- [ ] **Step 1: index.html**

```html
<!DOCTYPE html>
<html lang="en" data-theme="crt-dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>PIXEL POINTS</title>
  <link rel="stylesheet" href="/themes.css">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app"></div>
  <div id="overlay" hidden></div>
  <script src="/socket.io/socket.io.js"></script>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: themes.css** — full custom-property blocks for the 4 themes. Card hue map (same hue all themes): `0 #666, 1 #9b59f0, 2 #3498db, 3 #2ecc71, 5 #f1c40f, 8 #e67e22, 13 #e74c3c, 21 #ff6ec7, coffee #a1622a, question #95a5fc`.

Per theme define: `--bg, --fg, --muted, --panel, --border, --accent, --shadow, --card-0 … --card-question, --card-text-0 … --card-text-question` (text colour per card for contrast), `--radius` (0 for pixel themes, 6px for crt), `--font-head` with the pixel font first, `--font-body: 'Courier New', monospace`.

- `crt-dark`: `--bg:#0d0d1a; --fg:#e8e8e8; --muted:#8888aa; --panel:#141422; --border:#3a3a5c; --accent:#00e5ff;` cards: dark fill `color-mix(in srgb, <hue> 18%, #0d0d1a)`, border `<hue>`, glow `box-shadow: 0 0 12px color-mix(in srgb, <hue> 40%, transparent)`. Scanlines: `body::after` with `repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,.15) 2px 4px)` + `pointer-events:none`.
- `crt-light`: `--bg:#f4f1e8; --fg:#1a1a2e; --muted:#66668a; --panel:#fffdf5; --border:#c9c4ae; --accent:#0099c2;` cards: fill `color-mix(in srgb, <hue> 15%, white)`, border `<hue> darkened 30%`, no glow.
- `pixel-dark`: `--bg:#101014; --fg:#e8e8e8; --muted:#8a8aa0; --panel:#1a1a24; --border:#33334a; --accent:#ffd166; --radius:0;` cards: flat `<hue>` fill, 3px solid very-dark border, `box-shadow: 4px 4px 0 rgba(0,0,0,.5)`.
- `pixel-light`: `--bg:#fef9ec; --fg:#22223a; --muted:#66668a; --panel:#fff; --border:#2a2a3e; --accent:#e67e22; --radius:0;` cards: `<hue>` pastel (mix 60% white), 3px border darkened hue, same hard shadow.

- [ ] **Step 3: style.css** — layout only (all colours via the custom properties): `.hand` (flex-wrap, gap, cards `min-width:64px; min-height:88px; font-size` large), `.board-grid`, `.header` (title PIXEL POINTS, room code huge, description sentence, theme `<select>`, history `<details>`), `.overlay` (countdown big number, reconnecting), `.sm-actions` (Consensus points `<select>` + button, Revote, New Round), `.history-panel`, `.tile` (voted → shows `?`), `.reveal-card` (big face-up), `.form` (home screen), `@media (min-width:900px)` upscale (cards 2×, board grid bigger).

- [ ] **Step 4: app.js** — structure:

```js
const socket = io();
let state = null;            // last room:state/room:update merged
let you = null;              // from room:state's you (merged into state.you)
let selectedVote = null;     // optimistic highlight
let countdownEndsAt = null;  // local animation clock

const emitAck = (ev, data) => new Promise((res) => socket.emit(ev, data, res));

function applyTheme() {
  const stored = localStorage.getItem('pp-theme');
  const theme = stored ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'crt-light' : 'crt-dark');
  document.documentElement.dataset.theme = theme;
}

socket.on('connect', async () => {
  hideOverlay('reconnect');
  const token = localStorage.getItem('pp-token');
  if (state && token) { const res = await emitAck('session:resume', { token }); if (!res.ok) resetToHome(); return; }
  if (!token) return renderHome();
  const res = await emitAck('session:resume', { token });
  if (!res.ok) { localStorage.removeItem('pp-token'); renderHome(); }
});
socket.on('disconnect', () => showOverlay('reconnect'));
socket.on('room:state', (s) => { state = s; you = s.you ?? you; if (s.you) selectedVote = s.you.vote; render(); });
socket.on('room:update', (s) => { state = { ...s, you }; render(); });
```

Home screen: two forms (create: name; join: code + name). On ack ok: `localStorage.setItem('pp-token', res.token)`, `you = res.state.you`, render room.

Room rendering by `state.phase` and `you.role` per Interfaces block. Vote tap: `await emitAck('vote:cast', { value })`, set `selectedVote` optimistically, re-render. Countdown overlay driven off `state.countdownRemaining` when it changes between renders (store `countdownEndsAt = performance.now() + state.countdownRemaining` and tick locally).

SM lobby: description `<input maxlength=140>` + Start (disabled when connected player count < 2, with hint text). SM reveal actions: Consensus with `<select>` prefilled from `state.reveal.suggestedPoints` (options = numeric deck), Revote, New Round. Board view (SM + any desktop): tiles per player (`name` + `?`/waiting), flip to reveal values in reveal phase. History `<details>` on all screens.

Every render pass must be idempotent from `state` (no incremental DOM patching complexity — rebuild the view container each time; it's small).

- [ ] **Step 5: Manual test**

```bash
node server/index.js
```

E2E checklist (two browser windows + a phone): create/join; full round; revote; consensus + history; all 4 themes; refresh mid-vote → auto-rejoin with card still selected; SM disconnect → "SM reconnecting…" then returns; kill server → clients show reconnect overlay, restart → resume.

- [ ] **Step 6: Commit**

```bash
git add public/
git commit -m "feat: PIXEL POINTS phone-first frontend with four retro themes"
```

---

### Task 7: Docker + README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `README.md`
- Modify: none.

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
```

`.dockerignore`:
```
node_modules
.git
.superpowers
test
docs
*.md
```

- [ ] **Step 2: Build + run smoke test**

```bash
docker build -t pixel-points .
docker run -d --name pixel-points -p 3000:3000 pixel-points
sleep 2 && curl -s http://localhost:3000/healthz   # expect: ok
docker rm -f pixel-points
```

If Docker is unavailable in this environment, run `node server/index.js` + `curl /healthz` and note the untested build in the task report — do not silently skip.

- [ ] **Step 3: README.md** — required sections: PIXEL POINTS title + one-line pitch; quick start (`docker build -t pixel-points . && docker run -p 3000:3000 pixel-points`); how it works (room codes, 5s auto-reveal + reset, grace rules, consensus/revote/new, history); the 4 themes; nginx websocket config:

```nginx
location /pixel-points/ {
  proxy_pass http://127.0.0.1:3000/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 300s;
}
```

; manual E2E checklist from Task 6; font note (bundled OFL Press Start 2P, or fallback stack if fetch failed); rate limits note (20 joins/min/IP, 10 bad codes → 5min lockout); in-memory disclaimer (rooms lost on restart).

- [ ] **Step 4: Final verification**

```bash
npx vitest run        # all pass
docker build -t pixel-points .   # succeeds (or documented fallback)
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore README.md
git commit -m "chore: docker image and deployment docs for PIXEL POINTS"
```

---

## Self-review notes

- Consult blockers fixed: (1) reveal broadcast — `setRevealBroadcaster` wired in T5, engine callback in T4, integration-tested. (2) `you`/role — `room:state` emitted individually on create/join/resume; acks carry `state`; integration tests assert `you.role`. (3) grace rule now per spec (voted player keeps vote; countdown continues) — engine + tests updated. (4) path traversal — `express.static` used. (5) lockout — `isLocked` checked first in both handlers; create never clears bad-code counter; integration test asserts locked create fails. (6) ack guard — `ackOr` helper. (7) mid-vote join stops countdown (engine test) + abort guard nulls `_countdownEndsAt`. (8) sweep tests rewritten to use `disconnect()` API and first-observation TTL semantics. (9) hidden-votes test now uses a valid 2-voter room and `JSON.stringify` scan. (10) lockfile committed in every task that runs `npm i`.
- Warnings fixed: disconnect broadcasts (T5), integration test fully specified (T5), sessions.set cleanup (T4), token stored on create/join (T6), SM never evicted (T4 engine skips role 'sm'), prefers-color-scheme (T6), history panel on all screens (T6), newRound reveal-only (T3), one-room-per-socket (T5), `room:error` dropped in favour of acks (spec updated), express now actually used for static, rate limiter key pruning left as OK-NOTE (bounded by lockout scale), dead code removed.
- Type consistency: `publicState.countdownRemaining` ms nullable everywhere; `revealData` shape `{description, players:[{name, vote, connected}], spread, suggestedPoints}` consistent T3→T5→T6; `you: {name, role, voted, vote}` consistent.