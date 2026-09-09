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
    // GRACE: disconnected players keep votes that count here;
    // a disconnected player who never voted blocks the countdown.
    const voters = [...this.players.values()].filter((p) => p.role === 'player');
    return voters.length >= MIN_VOTERS
      && voters.every((p) => p.voted);
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

  abandonRound(sessionId) {
    this._requireSm(sessionId);
    if (this.phase !== 'voting') throw new Error('Only during voting');
    this._clearCountdown();
    this.lastDescription = this.description;
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