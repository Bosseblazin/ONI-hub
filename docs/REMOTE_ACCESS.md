# Remote access — commanding the colony from your phone

The home PC runs the game, OniMcp and Interplanetary Command (dashboard + Colony Operations Agent). Your phone talks to
that home server over a **private Tailscale network**. Nothing is exposed to the public internet, no router port
forwarding is needed, and OniMcp is never reachable from outside the PC.

```
 Phone (Tailscale app) ──WireGuard──▶ Tailscale ◀──outbound── Home PC
   browser / installed PWA            (coordination,           tailscale serve :443 (HTTPS, tailnet only)
   passphrase session                  DERP relay if needed)        └─▶ 127.0.0.1:3000  Interplanetary Command
                                                                         └─▶ 127.0.0.1:8788  OniMcp (local only)
 ntfy / webhook ◀── outbound HTTPS ── home agent (notifications)
 healthchecks.io ◀── outbound ping ── home agent (dead-man's switch)
```

## Why Tailscale

| Requirement | How it is met |
|---|---|
| No inbound public ports | The Tailscale daemon on the PC only makes **outbound** connections (to Tailscale's coordination servers, and to DERP relays if a direct path isn't possible). |
| No public OniMcp endpoint | OniMcp listens on localhost. Interplanetary Command binds to `127.0.0.1` (`npm start`) and only `tailscale serve` forwards to it. |
| Encryption | WireGuard end to end, plus HTTPS with a real certificate from `tailscale serve`. |
| Strong authentication | Two layers: the device must be in **your** tailnet (Tailscale login, optionally with MFA and ACLs), **and** the commander passphrase (scrypt hash, session cookies, lockout). |
| Works from work / mobile data | Tailscale traverses NAT and firewalls; it falls back to relays automatically. |

An authenticated outbound relay (the home agent connecting to a cloud service you host) is a valid alternative. The
command layer is transport-agnostic: idempotency keys, acknowledgements, the queue and the audit log all live in the
app, not in Tailscale. A relay was not built because it would add a public internet-facing service to secure and run.

> **Never use `tailscale funnel`** for this. Funnel publishes the service to the whole internet.

## One-time setup (Windows home PC)

1. **Install the dashboard** (see the main README): `npm install`, `npm run build`.
2. **Set the commander passphrase:** `npm run setup`. At least 12 characters; a few random words is ideal. Changing it later signs out every device.
3. **Optional — enable Claude:** add `ANTHROPIC_API_KEY=...` to `.env.local`. Without it, instructions are queued (and
   say so) until Claude is configured; mode, objective and approval controls still work.
4. **Start the server:** `npm start`. It binds to `127.0.0.1:3000` only.
5. **Install Tailscale** on the PC (<https://tailscale.com/download/windows>) and sign in.
6. **Publish to your tailnet only:** in an admin terminal run
   ```
   tailscale serve --bg 3000
   ```
   `tailscale serve status` shows the URL, e.g. `https://homepc.your-tailnet.ts.net`. The first time, Tailscale may ask
   you to enable HTTPS certificates for your tailnet in the admin console. Do that.
7. **Install Tailscale on your phone**, sign in with the same account, then open the URL. Sign in with the passphrase.
   Use "Add to Home Screen" to install it as an app.
8. **Verify from a second device** (a laptop on the tailnet):
   ```
   IC_VERIFY_PASSPHRASE='…' npm run verify:remote -- --url https://homepc.your-tailnet.ts.net
   ```
   It checks the acceptance criteria end to end. Run it with the game loaded to also confirm live monitoring.

### Keep it running while you're away

The agent runs inside the Interplanetary Command server process, independently of any browser. Make that process
start with Windows:

- **Task Scheduler:** create a task "At log on" (or "At startup") that runs `cmd /c cd /d C:\path\to\ONI-hub && npm start`,
  with "Restart if the task fails" enabled. Or
- **pm2:** `npm i -g pm2 pm2-windows-startup && pm2-startup install && pm2 start npm --name ic -- start && pm2 save`.

Also set Windows so the PC doesn't sleep while you're away (Settings → Power → Sleep: Never). Tailscale runs as a
service and reconnects on its own.

### Harden further (recommended)

- Tailscale admin console: enable MFA on your identity provider, and use **ACLs** so only your phone/laptop may reach
  the PC on port 443.
- Settings → *Signed-in devices*: revoke anything you don't recognise.
- `data/` contains your passphrase hash, sessions and audit log. Keep it private.

## Notifications

All notifications are sent **outbound** from the home PC. Configure on the PC in `.env.local`:

| Variable | Purpose |
|---|---|
| `NTFY_URL` | e.g. `https://ntfy.sh/ic-<long-random-string>`. Install the ntfy app on your phone and subscribe to the same topic. The topic name works like a password, so make it long and random — or self-host ntfy and set `NTFY_TOKEN`. |
| `NTFY_TOKEN` | Optional access token for protected topics. |
| `IC_PUBLIC_URL` | Your tailnet URL; tapping a notification opens the dashboard. |
| `IC_WEBHOOK_URL` | Optional generic JSON webhook (Home Assistant, n8n, a chat bridge…). |
| `IC_HEARTBEAT_URL` | Dead-man's switch, e.g. a <https://healthchecks.io> check URL (period 1 min, grace 5 min). The PC pings it every minute; if the PC, its internet or this service dies, healthchecks.io alerts you (it can push to ntfy, email, etc.). This is the only way to learn "home PC unavailable" — a dead PC can't send that message itself. |

What notifies, and when, is configured in the app (Home → Notifications): enable/disable, minimum severity,
categories, cooldown and quiet hours. Alerts notify only when raised or escalated, never on ordinary fluctuations.
Escalation bypasses the cooldown. CRITICAL ignores quiet hours.

## Without Tailscale (same Wi-Fi only)

`npm run start:lan` binds to all interfaces, so any device on your home network can reach `http://<pc-ip>:3000`. The
passphrase still applies, but traffic is unencrypted HTTP on your LAN, so don't use this over untrusted networks.

## Security model summary

- Every API route except `/api/health` (which reveals nothing) and `/api/auth/*` requires a session.
- Sessions: 256-bit random tokens; only their SHA-256 is stored. HttpOnly, SameSite=Strict, and Secure over HTTPS.
  Sliding 30-day expiry. Listable and revocable.
- Login throttling: 3 free attempts per client, then exponential lockout up to 1 h, plus a global cap.
- State-changing requests must carry a same-origin `Origin` header (CSRF).
- Security headers: `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- All commands, logins, approvals and notifications go to a SHA-256 **hash-chained audit log**. The Home screen shows
  whether the chain is intact.
- The game itself cannot be modified from the dashboard. See [OPERATIONS.md](OPERATIONS.md#action-authorization).
