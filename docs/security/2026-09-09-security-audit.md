# PIXEL POINTS — Security Audit Report

**Date:** 2026-09-09
**Method:** Three independent auditors (claude on application logic, codex on input validation/injection, pi on infrastructure/deps/DoS) ran in parallel (Herdr grid), then cross-critiqued each other's findings in a second round. This report merges the results. Disputed findings were settled by verification against the code — two of codex's findings (prototype pollution, missing ack guard) were withdrawn as false positives during critique, and several severities were adjusted up/down by consensus.

**Deployment context (affects severities):** public internet, behind the user's own nginx with TLS at the proxy and `X-Forwarded-For $remote_addr`; Docker container as non-root `node`; no user accounts (room code + display name); in-memory state.

---

## Verdict

**No Critical production vulnerabilities found.** The application core (vote privacy, role checks, DOM rendering, input validation basics, rate limiting) is solid. The confirmed issues are hardening gaps and supply-chain concerns — several are one-line fixes, all have concrete remediation below.

## Confirmed findings (post-critique severity)

### HIGH

| # | Finding | Where | Fix |
|---|---------|-------|-----|
| H1 | **Docker build: `npm ci` runs as root** — dependency postinstall scripts execute as root during image build; a compromised package = root-level build-time takeover | `Dockerfile:5` (`RUN npm ci` before `USER node` at :9) | Move `USER node` before `npm ci` (chown workdir first), or use `npm ci --ignore-scripts` |
| H2 | **express 4.22.2 → qs 6.15.3 CVEs in production runtime** — qs DoS (GHSA-4mjr-xmp4-gh2g) + array-limit bypass (GHSA-x5fp-wj9c-mxmx), reachable via Socket.IO handshake query parsing, unauthenticated | `package-lock.json` | Upgrade express (or `npm overrides` → `qs >= 6.16.0`); rerun `npm audit` |

### MEDIUM

| # | Finding | Where | Fix |
|---|---------|-------|-----|
| M1 | **`room:leave` accepts a client-supplied token** — anyone holding another player's token can evict them. (Requires token theft; 122-bit UUIDs aren't brute-forceable. Nothing legit uses the `data?.token` branch.) | `server/index.js` `room:leave` handler | Delete the `data?.token \|\|` branch; use only `socket.data.token` |
| M2 | **Unicode bidi/zero-width chars not stripped from names/descriptions** — `"Boss\u200B"` bypasses name-dedup (`_uniqueName` exact-match), enabling visually identical names / RTL visual spoofing (social engineering, not auth bypass — SM auth is server-side role-checked) | `server/validation.js:5-16` | Extend strip regex: `\u200b-\u200f\u2028-\u202e\u2060-\u206f` (+ optional `\ufeff`), `normalize('NFC')`; add tests |
| M3 | **Rate-limiter Maps leak entries** — `hits` keeps aged-out keys; `lockedUntil` never prunes expired entries; unbounded per-IP growth (bounded behind nginx, but slow leak; acute if port ever exposed directly) | `server/ratelimit.js:6-14, 29-41` | Delete keys when empty/expired (prune-on-read); both fixes are a few lines |
| M4 | **Room history unbounded** — `consensus` unshifts with no cap; full history broadcast to every client on every `room:update` (memory + bandwidth amplifier over very long sessions) | `server/game.js` `consensus()` | `MAX_HISTORY = 500`, `pop()` when exceeded |
| M5 | **`X-Forwarded-For` trusted unconditionally** — direct connection to the Node port (bypassing nginx) lets an attacker rotate fake IPs, defeating rate limiting/lockout | `server/index.js:50-52` | Trust XFF only when `socket.handshake.address` is a known proxy (loopback set), else use direct address |
| M6 | **No proxy-level rate limiting / no security headers** — nginx forwards everything unthrottled; no `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP | README nginx block | `limit_req_zone` + `limit_req burst` + `add_header` block in README's nginx config |
| M7 | **vitest 2.1.0 critical advisories (dev-only)** — RCE via Vitest API/UI server (CVSS 9.6/9.8); NOT in the production image (`--omit=dev`), risk is to dev machines running tests | `package-lock.json` | Upgrade vitest `^3.2.6`; the repo already has a Dependabot PR open for this |

### LOW / INFO (abridged)

- **L1** `base image not digest-pinned` (`node:22-slim` floating tag) — pin `@sha256:...` (Dockerfile:1)
- **L2** `.dockerignore` lacks `.env`/`.npmrc`/secret patterns — append them
- **L3** nginx block missing `Host` header (app doesn't consume hostname; cosmetic) — add `proxy_set_header Host $host;`
- **L4** `normalizeCode` no input length cap — harmless (O(n), Socket.IO 1MB cap) but slice input for defense-in-depth
- **L5** broadcast/`room:state` ordering: joining socket briefly sees `you == null` — emit `room:state` before `broadcastRoom`
- **L6** Socket.IO: no explicit `maxHttpBufferSize`/connection-limit options — defaults acceptable; set explicit limits + per-IP connection counter for defense-in-depth
- **L7** `lastDescription` dead state (abandonRound) — wire it up or delete
- **L8** HEALTHCHECK lacks `--start-period=10s` — cosmetic, avoids cold-start false unhealthy
- **I1** No Socket.IO `origin` allowlist — bearer tokens are the only auth boundary; add `cors.origin` if the app is ever served cross-origin
- **I2** `isValidVote` type check is implicit (strict `includes`) — safe today; explicit `typeof` check is cheap defense-in-depth
- **I3** `CODE_ALPHABET` = 26 chars → 26⁴ ≈ 457k codes (codex's "331k/24 chars" was a miscount, settled in critique) — adequate with the lockout; longer codes only if you want them

### Withdrawn during cross-critique (false positives)

- **codex "Critical: prototype pollution via `vote:cast` value"** — `DECK.includes()` is SameValueZero strict equality; objects never match; no merge/clone sinks exist downstream. Withdrawn by consensus (codex agreed).
- **codex "High: missing ack guard"** — `ackOr()` guards every handler including all `withRoom` wrappers. Withdrawn by codex after re-reading.
- **codex "High: express.static needs traversal guards"** — express 4.22 `serve-static`/`send` defaults (`dotfiles: 'ignore'`, `UP_PATH_REGEXP` `..` rejection) are safe; verified by two auditors against the installed `node_modules` source. Downgraded to Info (make defaults explicit if you like).

## Verified-solid (explicitly checked by auditors)

- Vote privacy: `publicState` never carries vote values pre-reveal; `you` data is per-socket only; integration-tested.
- DOM safety: zero `innerHTML`/`document.write`/eval sinks in `public/`; all user content via `textContent`; external links have `rel="noopener"` and constant hrefs.
- Role checks: every SM action goes through `_requireSm`; SM can't vote; players can't decide.
- Ack guards on all 8 socket handlers; malformed events can't crash the process.
- Room-code generation collision-free; empty-room GC prunes sessions; SM never evicted by grace sweep.
- `express.static` traversal/dotfile handling safe under defaults.
- Rate limiting + bad-code lockout function as designed (20/min/IP; 10 bad codes → 5-min lockout covering join AND create).

## Recommended fix order

1. **H2 + M7 (dependency upgrades)** — one `npm audit fix` + lockfile commit; closes the only production-runtime CVE and the dev-side vitest RCE.
2. **H1 (Dockerfile USER order)** — one-line reorder + rebuild.
3. **M1 (room:leave token branch)** — delete one expression.
4. **M2 (Unicode strip)** — regex + NFC normalize + tests.
5. **M3 + M4 (prune Maps, cap history)** — few lines each.
6. **M5 + M6 (XFF trust, nginx hardening)** — README + small `ipOf` change.
7. Lows/Infos opportunistically (digest pin, dockerignore, ordering swap).

---

*Round-1 reports: `/tmp/audit-report-{claude,codex,pi}.md`; round-2 critiques: `/tmp/audit-critique-{claude,codex,pi}.md` (transcripts). This merged report: `docs/security/2026-09-09-security-audit.md`.*