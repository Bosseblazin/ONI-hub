# Architecture

```
 Oxygen Not Included ──(Harmony mod)── OniMcp HTTP server :8788/mcp/
                                              ▲   JSON-RPC: initialize, resources/read (READ-ONLY)
                                              │
 ┌─────────────────────── Next.js server (Node) ───────────────────────────┐
 │  src/lib/mcp/        OniMcpClient ── method allowlist + URI allowlist    │
 │                      schemas.ts (zod) — validates every payload          │
 │  src/lib/collector/  Collector (singleton, starts with the server)       │
 │                      tiered polling → normalize → snapshot               │
 │  src/lib/model/      normalized colony model, thresholds                 │
 │  src/lib/calc/       GameClock (game-time), trends, runways              │
 │  src/lib/alerts/     rules (pure) + AlertEngine (hysteresis, ack/dismiss)│
 │  src/lib/store/      HistoryStore (JSONL per save per day), alert state  │
 │  src/lib/advisor/    Claude advisor (on demand, structured snapshot)     │
 │  src/app/api/*       /state  /stream (SSE)  /history  /alerts  /advisor  │
 └──────────────────────────────────────────────────────────────────────────┘
                                              │ Server-Sent Events
 Browser (React, Tailwind) ── src/app/page.tsx, src/app/asteroid/[id]/page.tsx, src/components/*
```

## Layers

The layering keeps OniMcp out of the UI. Only `src/lib/mcp` knows the wire format, and only `src/lib/collector`
knows which resources to read. Everything downstream (alert rules, projections, UI, advisor) consumes the normalized
types in `src/lib/model/types.ts`. A different data source (a save-file parser, a future OniMcp version, another
mod) can be added by writing a new collector that produces the same `ColonySnapshot`.

### MCP client (`src/lib/mcp`)

- Streamable-HTTP JSON-RPC client implementing the OniMcp handshake: `initialize` (protocol `2025-11-25`) →
  server-issued `Mcp-Session-Id` → `notifications/initialized` → session requests with `Mcp-Session-Id` and
  `Mcp-Protocol-Version` headers. Accepts both `application/json` and `text/event-stream` responses.
- Optional Bearer token (`ONI_MCP_TOKEN`) for OniMcp's `AuthEnabled` mode.
- Session loss (game restart, mod reload, 404) triggers transparent re-initialization.
- **Read-only enforcement:** `ALLOWED_METHODS` excludes `tools/call`; `assertReadOnlyUri` permits only the resources in
  `READONLY_RESOURCES` (each checked in the OniMcp source to be a pure read) and only filter query keys. OniMcp also strips `confirm`, `action`
  and `domain` from resource queries server-side.
- `resources/read` results are JSON text. OniMcp's TOON re-encoding only applies to `tools/call` results, so it does
  not affect resources.
- OniMcp resource errors come back as `{"error": true, "message": ...}` inside a successful result; the client turns
  those into `McpError`s.

### Collector (`src/lib/collector/collector.ts`)

One instance per Node process (`globalThis`), started from `src/instrumentation.ts` when the server boots.

Polling is **sequential** with a small gap between requests (`requestSpacingMs`, 120 ms), because OniMcp executes reads
on Unity's main thread and the heavier reads scan the entire cell grid. Tiers:

| Tier | Interval | Reads | Cost in game |
|---|---|---|---|
| core | 5 s | `colony/status`, `world/list`, `dupes/vitals` | trivial |
| workforce | 30 s | `dupes/status-check?radius=2&includeReachableSamples=false` | small (per-dupe nav scan) |
| medium | 15 s, per world | `power/summary`, `food/summary`, `resources/inventory` (`?worldId=N`) | small (component lists) |
| slow | 60 s, per settled world | `thermal/summary`, `atmosphere/breathability`, `atmosphere/summary`, `fluid/liquid/summary` | **full-grid scan each** |
| research | 60 s | `research/progress` | trivial |

Unsettled worlds (no duplicants, no power infrastructure) are only re-probed every 5 minutes and get no grid scans.

On connection failure the loop backs off exponentially (2 s → 30 s). `oni://...` errors such as "Game not initialized"
mark the state as `game-not-loaded` (main menu) rather than disconnected.

### Game time (`src/lib/calc/clock.ts`)

OniMcp exposes only the integer cycle plus `Time.timeScale`. Rates must be in *game* time. Otherwise a paused game looks
stable and 3× speed triples apparent consumption. `GameClock` integrates wall-time × timeScale between polls, clamps
the estimate inside the reported integer cycle, snaps forward on a cycle change, and flags discontinuities:
- a cycle going backwards (an earlier save was loaded), or
- a gap of more than 60 s.

History is **not recorded while paused**.

### Colony identity, restarts and reloads

- The save name (`colony/status.saveName`) identifies a colony. A different save → alerts reset, world caches cleared,
  history switches to that colony's folder.
- Same save but the cycle went backwards → in-memory history after that point is discarded so trends don't mix timelines.
- World list changes are reconciled every tick; vanished worlds are dropped and new ones raise an INFO event.

### Staleness

- Per world, per metric group (`vitals`, `power`, `food`, `inventory`, `thermal`, `atmosphere`, `liquid`, `workforce`),
  the collector records `fetchedAt` and the last error. The detail page shows these ages.
- The dashboard is **stale** if the connection is not `connected` or no core read succeeded within
  `staleAfterSeconds` (45 s). A banner explains why, and all values are labelled as last-known.
- Alert rules skip metrics older than 4 × `staleAfterSeconds`. Missing data neither raises nor resolves an alert.

### Trends and projections (`src/lib/calc/trend.ts`)

Least-squares fit over the trailing `trendWindowCycles` (3) of game time, extended back (up to 4× the window) to include at least 12 real readings for slowly refreshed metrics. A trend is only "reliable" with ≥ 6 samples
spanning ≥ 0.25 unpaused cycles; otherwise it is reported as `unknown` with the reason. "Stable" = projected change per
cycle within 2 % of the mean level. Runway = current ÷ −slope, only for a reliable decreasing trend. Confidence:
`high` (≥ 1.5 cycles, R² ≥ 0.8), `medium` (≥ 0.5, R² ≥ 0.5), else `low`.

Food has a second, deterministic projection: stock ÷ (population × 1,000 kcal/cycle), the standard duplicant demand,
labelled as assuming zero production.

### Alerts (`src/lib/alerts`)

See [ALERTS.md](ALERTS.md). Rules are pure functions `(snapshot, trends, thresholds) → per-scope candidate | null`.
`AlertEngine` adds persistence (2 consecutive hits to raise, 3 clears to resolve), escalation (a severity increase
un-dismisses), one-shot INFO events, 24 h retention of resolved alerts, and JSON persistence across restarts.

### History (`src/lib/store/history.ts`)

Append-only JSON lines at `data/history/<save-slug>/<YYYY-MM-DD>.jsonl`, one compact row per settled world every 30 s
of unpaused play. On startup the last 3 days are loaded into memory (cap 50 k rows). Files older than 14 days are
deleted. No native dependencies, human-readable, trivially importable elsewhere.

### Delivery to the browser

`/api/stream` pushes the full `DashboardState` over SSE after every poll and every 5 s (so ages keep moving even when the
game is unreachable). The client reconnects automatically and shows a separate notice if the *dashboard server*
itself is unreachable. `/api/history?world=N&sinceCycles=C` serves chart data, downsampled to ≤ 600 points.

### AI advisor (`src/lib/advisor`)

On-demand only (button), 90 s server-side cooldown, no tools. `buildAdvisorPayload` produces a compact snapshot split
into `observed` (verified game values, with data ages), `derived` (trends and projections with assumptions and
confidence), `alerts` and `unavailableMetrics`. The system prompt requires `[observed]`/`[derived]`/`[assumption]` tags,
forbids invented numbers, and forbids claiming any action was taken. Uses `@anthropic-ai/sdk`, model `claude-opus-5-5`,
adaptive thinking at `medium` effort, streaming `finalMessage()`, and server-side refusal fallback
(`fallbacks: "default"`). `GET /api/advisor?payload=1` shows exactly what would be sent.

### UI

- `src/app/page.tsx`, the overview: header with the global stats and the OniMcp link indicator, the demo and stale
  banners, one card per settled world (fixed identity colour by world id), the unsettled list, the resource matrix, the
  power panel, the workforce panel, data availability, the alert panel and the advisor.
- `src/app/asteroid/[id]/page.tsx`, the detail view: KPIs, eight history charts with a range selector (3/10/30 cycles/all), that
  world's alerts, projections with their assumptions, the duplicant roster and per-metric data freshness.
- Charts are hand-rolled SVG (`src/components/charts.tsx`): one y-axis, crosshair + tooltip, a legend for more than one
  series, and end labels when there are 3 series or fewer. The categorical palette was validated for colour-vision
  deficiency on the panel surface. Status colours are reserved for alerts and always paired with an icon and a label.

## Extension points (v2+)

- **New data source:** implement another collector producing `ColonySnapshot`; the rest is unchanged.
- **New metric:** add the URI to `READONLY_RESOURCES` (after verifying it is a pure read), a zod schema, normalization,
  and a capability entry.
- **New rule:** add a `Rule` to `ALL_RULES`; unit-test it with `tests/fixtures.ts`.
- **Actions (v3):** would require a separate, explicitly enabled write client with per-action allowlists, dry-run →
  confirm → verify (OniMcp supports `dryRun` / `confirm`), human approval in the UI and an audit log. Deliberately
  absent from v1.

## Remote Commander layer (v1.1)

```
 Phone / any tailnet device ──HTTPS (tailscale serve)──▶ Next.js server on the home PC (127.0.0.1:3000)
   PWA shell, outbox (localStorage)                     ├─ auth (src/lib/auth): passphrase + sessions + guard
   SSE /api/stream {dashboard, ops}                     ├─ /api/commands ──▶ OpsStore (idempotent queue, audit chain)
                                                        └─ OperationsAgent (src/lib/ops/agent.ts)
                                                             ├─ observes Collector state (no LLM): alert notifications,
                                                             │  objective progress, auto-investigations, mode recommendations
                                                             ├─ processes commands in order (instruction → Claude interpreter)
                                                             ├─ investigations / reviews (Claude analyst, structured output)
                                                             ├─ Notifier → in-app, ntfy, webhook;  Heartbeat → watchdog
                                                             └─ home status: game process, OniMcp, Claude, heartbeat
```

- **Service graph:** `src/lib/server/singleton.ts` builds collector, store, auth, agent and notifier once per process,
  started from `src/instrumentation.ts`. Monitoring, the agent and the command queue run regardless of connected browsers.
- **Persistence (`data/ops/`):** `state.json` (objectives, mode, recommendations, proposals, decisions, settings),
  `commands.jsonl`, `messages.jsonl`, `notifications.jsonl`, `audit.jsonl` (SHA-256 chained). `data/auth/` holds the
  passphrase hash and hashed sessions.
- **Claude:** `src/lib/ops/llm.ts` uses `client.beta.messages.parse` with zod structured outputs
  (`betaZodOutputFormat`), adaptive thinking at medium effort, and server-side refusal fallback, under an hourly call
  budget. `StructuredLlm` is an interface, so tests inject a scripted double and demo mode uses `SimulatedLlm`.
  The simulated interpreter is only ever selected while connected to the simulator, and its output is always labelled.
- **Client:** `src/lib/ui/live.ts` (SSE with auth redirect, last-known cache, link-state detection, durable outbox
  with retries) and `src/components/shell.tsx` (desktop header and tabs; mobile top bar and bottom nav). Pages live in
  the `src/app/(app)/` route group.
- **Never pretend:** the server skips evaluation on stale data. The client separately reports "home PC unreachable",
  "device offline", "game link down" and "monitoring interrupted"; while any of these holds, colony status is UNKNOWN
  and badges are STALE.
