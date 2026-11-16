# Interplanetary Command

**Colony Operations and Intelligence System** — a read-only, second-monitor mission-control dashboard for an
active *Oxygen Not Included: Spaced Out!* colony, fed live by the [OniMcp](https://github.com/LIghtJUNction/OniMods/tree/main/mods/OniMcp)
mod ("ONI MCP Server", Steam Workshop item 3807166922).

Leave the game running, glance at the second monitor, and know whether every asteroid is healthy or heading for disaster.

- Live per-asteroid monitoring of every world in the cluster (asteroids **and** rocket interiors) — not just the one you are viewing.
- Food, oxygen, power, water, fuel and material reserves, with game-time trends and runway projections that state their assumptions.
- Duplicant health and workforce availability.
- An alert engine (CRITICAL / WARNING / INFO) with hysteresis, acknowledge / dismiss, and an explanation, urgency and suggested actions for every alert.
- Historical charts per asteroid, stored locally as JSON lines.
- An optional Claude-powered **Colony Advisor** that briefs you from a structured snapshot.
- **Remote Commander** — use it from any device through **one permanent Vercel URL**:
  - a phone-first status screen that shows colony health at a glance;
  - a message thread with Claude, your Colony Operations Manager;
  - strategic objectives with priorities 1–5, and operating modes;
  - an AI operations panel, notifications (ntfy/webhook), and an honest home-PC / link status.
  The home PC connects *outbound* to the deployment; OniMcp is never exposed.
  See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).
- **Version 1 is strictly read-only.** The client cannot send `tools/call`, the only way OniMcp changes the game.

> Screenshots in `docs/` show **demo mode** (the bundled simulator). Demo data is always labelled on screen.

---

## Requirements

| | |
|---|---|
| Game | Oxygen Not Included with the *Spaced Out!* DLC (base game also works; you'll just see one world) |
| Mods | **ONI MCP Server** (OniMcp) ≥ 0.2.6, plus its prerequisite **Jlib** (keep Jlib above OniMcp in the mod list) |
| Runtime | Node.js ≥ 20.12 (tested on 22) |

The dashboard was built against OniMcp **0.2.6** (protocol `2025-11-25`). OniMcp is pre-1.0 and may change its payloads;
run `npm run probe` after updating the mod (see below).

## Deployment modes

| Mode | Where the dashboard runs | Home PC runs | Use when |
|---|---|---|---|
| **Cloud (recommended)** | Vercel (`IC_MODE=cloud`) + Neon Postgres | `npm run agent` | One permanent URL, from any device. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Local | the home PC (`npm start`) | the same process | Second monitor at home; optionally reached privately over Tailscale ([docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md)) |

## Quick start (local mode)

```bash
npm install
cp .env.example .env.local      # optional: edit settings
npm run setup                   # choose the commander passphrase (required to sign in)
npm run build && npm start      # → http://localhost:3000 (bound to 127.0.0.1)
```

For the cloud deployment, follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): `npm run cloud:secrets` → import the repo into
Vercel with the Neon integration → `npm run agent` on the home PC.

1. Launch the game with the **ONI MCP Server** mod enabled and load a colony. OniMcp listens on `http://localhost:8788/mcp/` by default.
2. Open <http://localhost:3000> on your second monitor (1920×1080 is the design target; any size works). Use the browser's fullscreen (F11).
3. The dashboard starts polling when the server starts — history accumulates even with no browser open.

For development: `npm run dev`.

### Verify your installation (recommended)

With the game running and a colony loaded:

```bash
npm run probe
```

This connects to your real OniMcp and validates every resource the dashboard depends on, for every world, using only
read methods. Lines marked `OK` are good. `SHAPE` means the mod changed a payload, and `FAIL` means a read failed.
Please report either one; the dashboard will show that metric as N/A instead of guessing.

### Demo mode (no game needed)

```bash
npm run setup:demo  # once: passphrase for the demo data directory
npm run demo        # simulator on :8789 + dashboard on :3000
```

In demo mode, commander instructions are handled by a deterministic **simulated interpreter** when no Claude key is
set. Every reply it writes is labelled "SIMULATED interpreter — not Claude".

The simulator speaks the same protocol as OniMcp and identifies itself as `OniMcp-Simulator`. Whenever the dashboard
is connected to it, a purple **DEMO MODE — ALL VALUES ARE SIMULATED** banner is shown and the AI advisor is told the
data is simulated. The demo scenario includes a healthy home asteroid with declining coal, and an outpost sliding into a
food/oxygen/power crisis. `SIM_SCENARIO=healthy` and `SIM_ACCEL=<game-seconds per second>` adjust it.
Type `p` + Enter in the simulator terminal to toggle pause.

## Configuration

Environment variables (`.env.local`):

| Variable | Default | Purpose |
|---|---|---|
| `ONI_MCP_URL` | `http://127.0.0.1:8788/mcp/` | OniMcp endpoint (change if you changed the mod's port) |
| `ONI_MCP_TOKEN` | — | Only if you enabled `AuthEnabled` in `OniMcpConfig.json` |
| `ANTHROPIC_API_KEY` | — | Enables the AI Colony Advisor. Without it the advisor panel stays offline. |
| `ADVISOR_MODEL` | `claude-opus-5-5` | Advisor model override |
| `NTFY_URL`, `NTFY_TOKEN`, `IC_PUBLIC_URL` | — | Push notifications via ntfy (see REMOTE_ACCESS.md) |
| `IC_WEBHOOK_URL` | — | Generic JSON webhook for notifications |
| `IC_HEARTBEAT_URL` | — | Dead-man's-switch ping (e.g. healthchecks.io) so you're told when the home PC goes dark |
| `OPS_MODEL` | `claude-opus-5-5` | Model for instruction interpretation and investigations |
| `IC_DATA_DIR` | `./data` | History (`history/<save>/<date>.jsonl`) and alert state (`alerts.json`) |
| `IC_HISTORY_INTERVAL_MS` | `30000` | How often a history sample is recorded while the game is unpaused |

Alert thresholds: copy `config/thresholds.example.json` to `config/thresholds.json` and edit; restart to apply.
Every key is optional; unknown keys are ignored. See [docs/ALERTS.md](docs/ALERTS.md).

## Tests

```bash
npm test           # unit + integration (integration runs the real HTTP client against the simulator)
npm run typecheck
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data flow, polling, safety model, extension points.
- [docs/ONIMCP_CAPABILITIES.md](docs/ONIMCP_CAPABILITIES.md) — what OniMcp exposes, which resources are used, and how the multi-asteroid question was answered.
- [docs/ALERTS.md](docs/ALERTS.md) — every rule, threshold and the hysteresis model.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — limitations, unsupported metrics, and future work (v2–v4).
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Vercel + Neon deployment, relay design and evaluation, home agent, security.
- [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) — notifications, watchdog, and the Tailscale alternative for local mode.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — commander/Claude model, instruction pipeline, objectives, modes, authorization levels.

## Safety

The dashboard never issues game commands — remote commander instructions change *strategy* (objectives, mode), never the game. In code, `src/lib/mcp/client.ts` permits only `initialize`,
`notifications/initialized`, `ping`, `resources/list`, `resources/templates/list` and `resources/read`, and
`src/lib/mcp/readonly.ts` restricts reads to an allowlist of verified read-only resources and filter-only query
parameters. A test asserts that `tools/call` is rejected before any network I/O, and the integration test asserts the
simulator only ever saw read methods. Acknowledging or dismissing an alert changes dashboard state only.
