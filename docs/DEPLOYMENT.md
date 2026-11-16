# Deployment — one permanent Vercel URL

The goal is one permanent URL (e.g. `https://interplanetary-command.vercel.app`, or your own domain) that any
authenticated device can open to monitor and command the AI-managed colony.

```
 Any device (iPhone Safari / PWA, laptop)                       Vercel (stateless, public HTTPS)
 ─────────────────────────────────────────                      ─────────────────────────────────────
  dashboard UI ── polls /api/state (3 s) ───────────────────▶  Next.js app  (IC_MODE=cloud)
  commands ─── POST /api/commands (idempotent clientId) ───▶    • passphrase auth, sessions, CSRF checks
                                                               • NEVER runs monitoring or Claude
                                                                         │ SQL over HTTPS
                                                               Neon Postgres (Vercel Marketplace)
                                                                 command queue · latest snapshot · history
                                                                 sessions · login throttling · audit
                                                                         ▲
                                     outbound HTTPS only, HMAC-signed    │  POST /api/agent/sync every 2–10 s
 Home PC ─────────────────────────────────────────────────────────────────┘  (state + history + command
  npm run agent  →  OniMcp (localhost:8788, never exposed) → Oxygen Not Included      statuses ⇄ new commands)
                    Colony Operations Agent + Claude (ANTHROPIC_API_KEY stays on the PC)
                    notifications (ntfy/webhook) · heartbeat · screenshots
```

## Why a database relay, not WebSockets

| Option | Verdict |
|---|---|
| WebSocket server on Vercel | **Not possible.** Vercel functions are request/response and can't hold long-lived sockets. |
| Self-hosted WebSocket relay (Fly.io, Render, Cloudflare Durable Objects) | Works, but adds a second always-on service to operate and secure. Commands would *still* need durable storage to survive outages. |
| Managed pub/sub (Ably, Pusher, Upstash) | Low-latency push, but an extra vendor and extra keys, and you still need durable state for the queue, snapshots and sessions. |
| Tailscale (previous design) | Excellent privacy, but every viewing device needs the Tailscale app. Kept as an alternative ([REMOTE_ACCESS.md](REMOTE_ACCESS.md)). |
| **Postgres relay + outbound HTTPS polling (chosen)** | One managed dependency (Neon via Vercel's one-click integration, free tier). Durable by construction, so commands survive any outage. The home PC only makes outbound requests. Latency of 2–3 s is fine for colony command. |

Cost: with someone watching, the agent syncs every 2 s and each browser polls every 3 s; when nobody is watching the
agent syncs every 10 s. That's roughly 9k–45k function invocations a day — comfortably inside Vercel and Neon free
tiers for a single commander. Snapshots are gzip-compressed (~10–30 KB).

## Reliability guarantees

| Requirement | How |
|---|---|
| Monitoring continues if the browser closes | Monitoring runs only in `npm run agent` on the home PC. Vercel never runs it. |
| Commands survive network interruptions | The phone keeps an outbox (localStorage) and retries with the same `clientId`. The cloud queue is durable, and unconfirmed deliveries are re-sent after 30 s. The agent de-duplicates by `clientId`. |
| No duplicates | Unique `clientId` in both the cloud (`ON CONFLICT DO NOTHING`) and the home store. Verified by tests and by killing the cloud and the agent mid-flow. |
| Home PC / game online status | The cloud records each agent sync; no sync for 45 s means **HOME PC OFFLINE**. Game state comes from the agent's snapshot. |
| Stale data | Shown explicitly: HOME PC OFFLINE / SERVICE UNREACHABLE / DEVICE OFFLINE / MONITORING INTERRUPTED. Colony status becomes UNKNOWN and badges STALE. |
| No false success | A command shows "queued in the cloud" → "delivered" → "received by home PC" → "processed". Only the home agent's report can mark it processed. The cloud never sets that status. |
| Demo kept separate | Every sync declares `simulated`. Production refuses simulated syncs (HTTP 409) unless `IC_ALLOW_SIMULATED=1`, which you set only on a separate demo deployment. |

## Required infrastructure

1. **Vercel project** (Hobby is fine) connected to this GitHub repository.
2. **Neon Postgres** via the Vercel Marketplace integration; it injects `DATABASE_URL` automatically. Any Postgres
   reachable over HTTPS with Neon's driver also works.
3. **Home PC** (Windows) with Node.js ≥ 20.12, the game, OniMcp + Jlib, and this repository.
4. Optional: an Anthropic API key (Claude), ntfy (push notifications), healthchecks.io (dead-man's switch), and a
   custom domain.

## Stage 1 — Generate secrets (home PC)

```
npm install
npm run cloud:secrets
```
It prints `IC_PASSPHRASE_HASH` (scrypt hash; the passphrase itself is never stored) and a fresh `IC_AGENT_SECRET`.

## Stage 2 — Create the Vercel project

1. vercel.com → **Add New → Project** → import this repository. Framework is detected as Next.js; keep the defaults.
2. **Storage → Marketplace → Neon → Create** and connect it to the project (all environments, or Production only).
   This adds `DATABASE_URL`.
3. **Settings → Environment Variables**, **Production** scope, all marked *Sensitive*:

   | Name | Value |
   |---|---|
   | `IC_MODE` | `cloud` |
   | `IC_PASSPHRASE_HASH` | from Stage 1 |
   | `IC_AGENT_SECRET` | from Stage 1 |

   Do **not** set `IC_ALLOW_SIMULATED`, `ANTHROPIC_API_KEY` or anything OniMcp-related on Vercel.
4. **Deploy.** The schema is created automatically on first use.
5. **Domain:** the project gets a permanent `https://<project>.vercel.app`. To use your own, add it under
   **Settings → Domains**. Optionally enable **Deployment Protection** for preview deployments only; production is
   protected by the passphrase.

## Stage 3 — Connect the home PC

Add to `.env.local` on the home PC:
```
IC_RELAY_URL=https://<project>.vercel.app
IC_AGENT_SECRET=<same value as on Vercel>
ANTHROPIC_API_KEY=<optional, enables Claude>
NTFY_URL=<optional>  IC_HEARTBEAT_URL=<optional>
```
Then run **`npm run agent`**. Within a few seconds the log shows `relay=ok`. Run either `npm run agent` (cloud
deployments) or `npm start` (local-only mode), never both against the same data directory.

**Keep it running (Windows):** Task Scheduler → *Create Task* → trigger *At log on* → action
`cmd /c cd /d C:\path\to\ONI-hub && npm run agent`, with "Restart on failure" enabled. Alternatively, `pm2 start npm
--name ic-agent -- run agent && pm2 save` with `pm2-windows-startup`. Set Windows sleep to *Never*.

## Stage 4 — Verify from any device

```
IC_VERIFY_PASSPHRASE='…' npm run verify:remote -- --url https://<project>.vercel.app
```
This checks:
- the site is reachable, and unauthenticated or cross-origin requests are refused;
- the home agent is online;
- a command is queued, then confirmed received, then processed — all confirmed by the home PC;
- a duplicate resend is suppressed;
- monitoring continues with no browser open.

Then on your iPhone: open the URL in Safari → sign in → Share → **Add to Home Screen**.

## Demo deployment (optional, separate)

Create a **second** Vercel project with its own Neon database and `IC_ALLOW_SIMULATED=1`, then point a home agent
running against the simulator at it. Production never accepts simulated data. For a purely local demo, use
`npm run demo` (local mode) or `npm run cloud:dev` (cloud mode on embedded PGlite).

## Local development of cloud mode

```
npm run sim                                                          # simulator on :8789
IC_PASSPHRASE_HASH=… IC_AGENT_SECRET=… IC_ALLOW_SIMULATED=1 npm run cloud:dev   # cloud mode on PGlite, :3000
IC_RELAY_URL=http://127.0.0.1:3000 IC_AGENT_SECRET=… ONI_MCP_URL=http://127.0.0.1:8789/mcp/ npm run agent
```

## Security model (cloud)

- **Public surface:** the dashboard and its authenticated API, plus `/api/health` (reveals nothing) and the
  HMAC-protected `/api/agent/*`.
- **Commander auth:**
  - scrypt passphrase hash in an env var;
  - sessions stored hashed in Postgres;
  - HttpOnly + Secure + SameSite=Strict cookie with 30-day sliding expiry, revocable per device;
  - per-client exponential lockout plus a global cap;
  - same-origin check on every state-changing request.
- **Agent auth:** HMAC-SHA256 over timestamp, method, path and SHA-256(body), with a ±5-minute replay window. A wrong
  secret gets nothing: no state accepted and no commands delivered.
- **The home PC accepts no inbound connections.** OniMcp stays on localhost. The Claude key, ntfy and heartbeat live
  only on the home PC.
- **Data stored in the cloud:** colony telemetry, objectives and messages, command history, hashed sessions and an
  event log. The tamper-evident hash-chained audit log stays on the home PC.
- **Rotation:**
  - New passphrase → rerun `npm run cloud:secrets`, update `IC_PASSPHRASE_HASH`, redeploy.
  - Agent secret → update it in both places.
  - Revoke devices under Home → *Signed-in devices*.
- Headers: HSTS, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store` on all API responses.
