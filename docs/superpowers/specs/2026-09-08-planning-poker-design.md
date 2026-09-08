# PIXEL POINTS — Design Spec

Date: 2026-09-08
Status: Approved design, pending implementation plan
Name: **PIXEL POINTS** (working folder/repo `planning-poker`)

## Purpose

PIXEL POINTS: a self-hosted, dockerised planning poker app for a work team. Jackbox-style access: create a room, get a code; players join with a name. Phone-friendly voting with a private hand of Fibonacci cards, server-timed auto-reveal, and a big shared screen board the Scrum Master (SM) shares on Teams. Retro arcade styling with four selectable themes.

## Non-goals

- No user accounts, no databases, no persistence across server restarts (in-memory only).
- No TLS termination in-app (runs behind the user's nginx reverse proxy).
- No Jira/Azure DevOps integration.
- No chat, avatars upload, or spectator mode.

## Tech approach (chosen: Option A)

Single Node.js process (Express + Socket.IO) serving a build-free vanilla HTML/CSS/JS frontend. One Docker image. All game state in server memory. Socket.IO gives auto-reconnect (important for phone WiFi) and rooms.

Rejected alternative: Vite + React SPA — build step and framework overhead not justified for ~4 screens of small state.

## Cards

Deck (10 cards): `0, 1, 2, 3, 5, 8, 13, 21` plus Coffee (`☕` — "too complex / need a break") and Question (`❓` — "need more info"). Coffee and Question count as votes but are non-numeric and never participate in any consensus calculation.

## Access and identity

- Home screen: "Create room" (you become Scrum Master) or "Join room" (enter 4-char code + display name).
- Room codes: 4 uppercase chars from an unambiguous alphabet (no `O/0`, `I/1/L`, `S/5`, `B/8` — alphabet: `ACDEFGHJKMNPQRTUVWXY234679`). Randomly generated.
- Joining returns a **session token** (random UUID, per player, stored server-side and in the client's localStorage). Token restores name + role on reconnect/refresh. Tokens are invalidated when a player leaves or is evicted after grace.
- Duplicate display names auto-suffixed ("Jason 2").
- Room capacity: max 12 players (1 SM + 11 voters).
- Rooms auto-delete after being empty (no connected players) for 15 minutes. Server restart wipes all rooms; clients gracefully fall back to the home screen.
- The SM is **never evicted** by the disconnect-grace sweep and never blocks room-empty deletion; the room waits for the SM's token to reconnect (spec line: "SM role is tied to the session token and returns with them"). Players see an "SM reconnecting…" indicator while the SM is disconnected.

### Public-internet protections

Since the server is exposed via nginx on the public internet:

- Per-IP rate limit on join/create attempts (e.g. 20/min, small lockout on breach).
- Unknown room code attempts throttled; per-IP cap of 10 bad attempts then 5-minute lockout for join/create (prevents code brute-force).
- Names sanitised (strip control chars, max 24 chars) and rendered as text (never HTML).
- No other auth — room code + name is the whole model, Jackbox-style.

## Room state machine

Phases: `lobby → voting → reveal → (voting | lobby)` plus a persistent-per-room **history** list.

- **lobby**: SM sees a "Start round" input (one-sentence story description, max 140 chars). Players see "waiting for SM".
- **voting**: description shown at top of every screen. Each non-SM player has a private hand; SM's screen shows the vote board (player tiles, voted = tile flips to `?`, not their value). Server tracks votes; when every connected non-SM player has a vote, a 5-second countdown starts. **Any vote change during the countdown resets the timer to 5s.** At 0 the server broadcasts all votes and moves to `reveal`.
- **reveal**: all cards face-up in a colourful grid; coffee/question show emoji. Highest/lowest numeric spread shown (e.g. "spread: 3–13"). SM sees three actions:
  - **Consensus** → records `{description, finalPoints, timestamp}` to history. The SM picks/edits the agreed points value (default: the median numeric vote; coffee/question excluded). → back to lobby.
  - **Revote** → same description, phase returns to `voting`, all votes cleared.
  - **New round** → back to lobby with the description input cleared (no history entry).
- **history**: panel (collapsible) on all screens: list of `{description, points, time}` newest-first. Per-room, in-memory only.

### Timing rules

- The 5s reveal timer is server-authoritative; clients animate locally from the broadcast `countdownRemaining` (ms since server start of countdown). No per-second server ticks.
- Timer starts only when *all connected* non-SM players have voted; a player who joins mid-voting must vote (timer starts/restarts accordingly — a mid-vote join stops an in-flight countdown until the joiner votes).
- **Grace (dodge-voting protection):** a player who has voted and then disconnects during voting/countdown **keeps their vote** — the "all voted" condition stays satisfied and the countdown continues to reveal. A player who disconnects *without ever voting* blocks nothing, but the countdown stays stopped until everyone connected has voted. Vote removal on disconnect happens only implicitly: a disconnected player's vote is dropped when the registry evicts them after the 60s grace window (then the countdown recomputes).
- Edge case: if the countdown reaches 0 while the "all voted" condition is somehow no longer true (race is impossible on a single thread, but defensively), the server aborts the reveal and nulls the countdown state.
- Minimum 2 voters (non-SM players) required to start a round; SM sees a hint if fewer.

## Events (Socket.IO)

Server → client:

- `room:state` — full state snapshot sent *individually* on create/join/reconnect, including `you: {name, role, voted, vote}` (the client's own role and current vote, so refresh restores the selected card). NEVER includes other players' vote values except during `reveal`.
- `room:update` — broadcast to the room on every change (joins/leaves, phase change, vote flags, countdown start/reset/stop, reveal data, history). Per-player `you` data rides only on `room:state`; clients merge.
- `room:error` — reserved; in practice client-action errors are returned via event acks (`{ok: false, error}`).

Client → server (all use ack callbacks):

- `room:create` `{name}` → ack `{ok, code, token, state}` → server also emits `room:state` to the creator
- `room:join` `{code, name}` → ack `{ok, code, token, name, state}` → server also emits `room:state` to the joiner
- `session:resume` `{token}` → ack `{ok, state}` → server also emits `room:state`
- `round:start` (SM) `{description}`
- `vote:cast` `{value}` (player; allowed any time during voting + countdown)
- `round:consensus` (SM) `{points}` → history + lobby
- `round:revote` (SM) → voting
- `round:new` (SM) → lobby (only valid in `reveal` phase)

Validation server-side: role checks on every SM event, phase checks on every transition, vote value must be in deck. Malformed/unauthorised events ignored (and logged at debug level).

## Frontend

- Phone-first single page (`/`), responsive. Desktop = same UI scaled up (the SM board is the same page with the `sm` role view — designed to look good on a shared 1080p Teams screen).
- **Four themes** (CSS custom properties, `[data-theme]` on `<html>`, persisted in localStorage per device, default: CRT Neon dark):
  1. `crt-dark` — CRT Neon (dark): near-black background, neon per-value card colours with glow, scanline overlay effect.
  2. `crt-light` — CRT Neon (light): cream/ivory background, same neon hues deepened for contrast.
  3. `pixel-dark` — Pixel Pop (dark): flat bright fills, chunky 3px borders, hard offset shadows.
  4. `pixel-light` — Pixel Pop (light): pastel fills, same chunky borders.
- Each card value keeps a consistent hue across all four themes (e.g. 8 = orange in every theme).
- Theme picker: small dropdown/palette button in the header.
- Monospace pixel font for headers via web-font (bundled locally, e.g. a free OFL pixel font like "Press Start 2P" for titles and a readable mono for body) — no CDN dependency at runtime.
- Cards: big tap targets (min 64px), tap = select+cast (highlighted + cast indicator), tap another = change vote. Selected card lifts/glows. During reveal, phone shows "hand revealed" summary rather than duplicating the big board.
- Accessibility basics: prefers-color-scheme respected for initial theme only if no explicit choice; buttons/inputs labelled; contrast checked for the two light themes.

## Server architecture (single container)

```
server/
  index.js         — Express static + Socket.IO wiring
  rooms.js         — Room registry, create/join/resume, codes, rate limiting
  game.js          — state machine, votes, 5s timer, transitions, history
  validation.js    — input sanitising (names, descriptions, vote values)
  ratelimit.js     — per-IP limiter (join/create + bad-code attempts)
public/            — index.html, app.js, themes.css, style.css
test/              — Vitest unit tests for rooms/game/timer logic
Dockerfile, README.md
```

- Node 22 slim base, `npm ci --omit=dev` install, non-root user, `HEALTHCHECK` via HTTP `/healthz`, `CMD ["node","server/index.js"]`. Port 3000 (`EXPOSE`).
- Server-side timer uses `setTimeout` with monotonic bookkeeping; tests fake timers.
- 60s disconnect grace before a player is evicted from a room (longer than typical phone reconnect).
- `SIGTERM` handled → close server, exit cleanly (Docker stop friendly).

## Error handling

- Client: socket disconnects show a "reconnecting…" overlay (Socket.IO auto-retry); after resume, state resyncs via `room:state`.
- Stale token/missing room: clean bounce to home with a friendly message.
- Rate-limited requests get a friendly error ("too many attempts, wait a bit") via the event ack.
- Static file serving must prevent path traversal (resolve and verify the path stays under `public/`).
- Lockout check (`isLocked(ip)`) is enforced **before** any join/create processing; a successful `room:create` must **not** clear the bad-code counter.
- Malformed or missing ack callbacks must never crash the server — every socket handler guards `typeof ack === 'function'`.
- One active room per session: a socket that already owns a room gets `room:create` acks rejected.
- App title/name everywhere: **PIXEL POINTS** (page `<title>`, header, README; Docker image name `pixel-points`).
- Server emits `room:update` on player disconnect so remaining players see it immediately.
- Vote values outside deck rejected with ack error; description >140 chars truncated server-side.
- If SM disconnects: room stays, players see "SM reconnecting…". SM role is tied to the session token and returns with them; the SM is never evicted by the grace sweep. (No SM transfer in v1 — noted as future option.)

## Testing

- **Unit (Vitest)**: room create/join/resume; duplicate name suffixing; vote cast/change; timer start when all voted; timer reset on change; timer continues when a voted player disconnects (grace); timer stops when a not-yet-voted joiner appears; reveal payload contains votes only in reveal phase; consensus records history; revote clears votes; rate limiting and lockout; code generation alphabet. **Integration (Vitest + socket.io-client)**: create/join via real sockets, role delivered in `room:state`, votes hidden pre-reveal, reveal broadcast fires on timer, ack errors on invalid actions.
- **Manual E2E**: two browser tabs + phone: create/join, full round, revote, consensus, theme switching, refresh mid-vote (auto-rejoin), server restart (clean home-screen fallback). README documents this checklist.

## Deployment (user's environment)

- `docker build -t pixel-points .` → `docker run -p 3000:3000 pixel-points`.
- README covers nginx websocket proxy config (`proxy_set_header Upgrade/Connection`, `proxy_read_timeout`) since Socket.IO long-polls/WebSockets behind a proxy need it.
- No volumes needed (in-memory).