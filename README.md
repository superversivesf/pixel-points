# PIXEL POINTS

A scrum-planning-poker app for the phone in your pocket — pixel-art themes, story points, coffee breaks, zero accounts.

## Quick start

```bash
docker build -t pixel-points .
docker run -p 3000:3000 pixel-points
```

Then open `http://localhost:3000/` (host port mapping is free to change via `-p <hostport>:3000`; the container's internal `PORT` is fixed by the Dockerfile `HEALTHCHECK` at 3000, so changing it requires editing the healthcheck too). The image is a single Node 22 container — no database, no volumes, nothing else to run.

## How it works

1. One person creates a room and becomes the **Scrum Master (SM)**.
2. Everyone else joins with the **4-character room code** (unambiguous alphabet — no O/0 or I/1 mix-ups).
3. The SM types a **one-sentence story description** to start the round.
4. Each player votes from their **private hand**: 0, 1, 2, 3, 5, 8, 13, 21, ☕ coffee, or ❓ question. Nobody sees anyone else's card until reveal.
5. When **all connected players** have voted, a **5-second countdown** to reveal starts — any vote change resets it back to 5s.
6. Reveal shows every player's card plus the **spread** (the gap between the highest and lowest vote).
7. The SM then picks one of:
   - **Consensus** — locks in the story + points and saves them to the room's **history**.
   - **Revote** — clears the cards and votes again on the same story.
   - **New Round** — moves on to the next story.

### Grace rules

- **Refresh mid-vote?** You auto-rejoin with your card still selected (60-second reconnect grace).
- **Voted player drops connection?** Their vote still counts through the reveal — no dodging the reveal by bailing.
- **Scrum Master drops?** Players see an indicator until the SM returns; the SM role follows their session token, so they reclaim it on reconnect.
- Rooms die after **15 minutes with everyone gone**.

## Themes

Four retro looks, auto-switchable and manually selectable:

- `crt-dark` — dark CRT terminal
- `crt-light` — light CRT terminal
- `pixel-dark` — dark pixel theme
- `pixel-light` — light pixel theme

Respects `prefers-color-scheme` on first visit; toggle persists for future rounds.

## Manual E2E checklist

- [ ] Create room → SM; join from a second browser/tab with the code
- [ ] Full round: SM description → all vote → 5s countdown → reveal with cards + spread
- [ ] Revote: cards clear, votes recast, reveal again
- [ ] Consensus: story + points recorded; visible in history panel
- [ ] All 4 themes render and switch cleanly (`crt-dark`, `crt-light`, `pixel-dark`, `pixel-light`)
- [ ] Refresh mid-vote → auto-rejoin with card still selected
- [ ] SM disconnects → players see indicator; SM returns and reclaims control
- [ ] Server restart mid-round → clean home-screen fallback (rooms don't survive restarts)

## Production proxy (nginx)

PIXEL POINTS is built to sit behind an nginx reverse proxy that handles TLS and proxies Socket.IO's WebSocket upgrade. The app uses root-absolute paths (`/themes.css`, `/app.js`, `/socket.io/`), so it expects to be served at the root of whatever hostname fronts it — use a dedicated vhost or subdomain (e.g. `points.example.com`), not a subpath. Use this block verbatim in that vhost's server context:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_read_timeout 300s;
}
```

`X-Forwarded-For` is required — the server uses it to attribute join/create attempts to client IPs for rate limiting. We use `$remote_addr` rather than `$proxy_add_x_forwarded_for` because the latter appends the client-supplied XFF value, letting an attacker spoof the first entry the app trusts and rotate their rate-limit identity.

## Rate limits

- **20 join/create attempts per minute per IP**
- **10 bad room codes → 5-minute lockout** (from both join *and* create)

## Font

The pixel font (**Press Start 2P**, SIL OFL-licensed — see `public/fonts/OFL.txt`) and the readable mono themes' font (**JetBrains Mono**, OFL-licensed — see `public/fonts/OFL-JetBrainsMono.txt`) are bundled locally in the image. No CDN, no Google Fonts request — the app renders offline and behind air-gapped proxies.

## How to play

An in-app guide lives at **`/help.html`** (linked as "HOW TO PLAY" in every footer). It walks through rooms, the card deck, the 5-second auto-reveal, and the Consensus / Re-vote / New Round flow.

## Attribution

PIXEL POINTS is a homage to the card game [Planning Poker](https://planningpoker.com/). It is not affiliated with or endorsed by the original creators — if you want the original professional kit, [get it here](https://planningpoker.com/).

Source: [github.com/superversivesf/pixel-points](https://github.com/superversivesf/pixel-points)

## License

Released under the [MIT License](LICENSE). The bundled fonts are under their own SIL Open Font License 1.1 terms (see `public/fonts/`).

## Data disclaimer

All state is **in-memory** — no database, no persistence. Restarting the container **wipes every room**; browsers fall back to the clean home screen. This is by design: rooms are ephemeral, planning sessions are not records.