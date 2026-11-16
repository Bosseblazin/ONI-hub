# OniMcp capability survey

How this was established: the repository was empty, and OniMcp runs inside the game on the player's PC, so it could
not be reached from the build environment. The survey below therefore comes from reading the **OniMcp source**
(`LIghtJUNction/OniMods`, `mods/OniMcp`, version **0.2.6**, 2026-10-22) — the resource registry, each resource's C#
serializer, and the HTTP transport. Every payload schema in `src/lib/mcp/schemas.ts` mirrors a specific C# method
(noted in comments).

**To verify against your live install, run `npm run probe`.** It reads every resource the dashboard uses, for every
world, and validates the shapes.

## Transport

| Item | Value |
|---|---|
| Endpoint | `http://localhost:8788/mcp/` (port configurable in the mod's options) |
| Protocol | MCP `2025-11-25`; `initialize` without a session → `Mcp-Session-Id` header; later requests send it plus `Mcp-Protocol-Version` |
| Auth | Off by default; Bearer token when `AuthEnabled` is on |
| Read surface | MCP **resources** (`resources/read` on `oni://…`) |
| Write surface | MCP **tools** (`world_editor`, `game_control`, `building_control`, `orders_control`, `navigation_control`, `server_control`, `benchmark`) — **never used** |
| Resource query strings | Passed as filter arguments; `confirm`, `force`, `action`, `domain` are stripped by OniMcp |
| Errors | Resource failures return `{"error": true, "message": …}` as the content text |

## Multi-asteroid support — answered

**OniMcp can report every world simultaneously, not just the active one.**

- `oni://world/list` enumerates every `WorldContainer` (asteroids and rocket interiors) with `id`, `name`,
  `isActive`, size and `asteroidType`.
- `oni://dupes/vitals` and `oni://dupes/status-check` include `worldId` per duplicant.
- These accept `?worldId=N` and filter by world:
  - `oni://power/summary`
  - `oni://food/summary`
  - `oni://resources/inventory`
  - `oni://thermal/summary`
  - `oni://atmosphere/summary`
  - `oni://atmosphere/breathability`
  - `oni://fluid/liquid/summary`

The dashboard therefore monitors all worlds live. Caveats:
- `food/summary`'s `daysRemaining` divides by the **colony-wide** duplicant count even when filtered to one world, so
  the dashboard recomputes runway per world from `totalKcal`.
- Map scans only count **revealed** cells.
- There is no explicit "discovered" or "rocket" flag. The dashboard infers *rocket* from the `RocketInterior` world type,
  and *settled* from having duplicants or power infrastructure.

## Resources used

| Resource | Used for |
|---|---|
| `oni://colony/status` | cycle (integer), duplicant count, world count, active world, `timeScale`, paused, save name |
| `oni://world/list` | world discovery |
| `oni://dupes/vitals` | HP, stress, calories (kcal), breath, bladder, worldId per duplicant |
| `oni://dupes/status-check` | per-duplicant risk (ok/warning/critical), reasons, idle |
| `oni://power/summary?worldId` | generator count/operational/empty, **rated** W, consumer used/needed W, powered count, battery J/% |
| `oni://food/summary?worldId` | total kcal of edibles on that world |
| `oni://resources/inventory?worldId&includeStored=true&limit=500` | stored/loose item mass by element (coal, metals, stone, plastic, bottled/tanked liquids & gases) |
| `oni://fluid/liquid/summary?worldId` | free liquid mass by element on revealed cells |
| `oni://atmosphere/summary?worldId` | top-10 gases by mass (for free natural gas) |
| `oni://atmosphere/breathability?worldId` | free O₂ and CO₂ mass, breathable cells |
| `oni://thermal/summary?worldId` | avg/min/max °C over revealed cells, cells > 70 °C |
| `oni://research/progress` | active tech, completed/total |

## Not available (or not usable) from OniMcp 0.2.6

| Wanted | Status | What would be needed |
|---|---|---|
| Live generator output (W) | Only ratings are exposed | Expose `Generator` current output or `CircuitManager` joules-produced stats |
| O₂ production / consumption rates | Not exposed | Expose `ReportManager` daily report entries (OxygenCreated, etc.) — the game already tracks these |
| Food produced / consumed per cycle | Not exposed | Same — `ReportManager` CaloriesCreated / consumed |
| Incapacitated status | Not a field | Expose the `Incapacitated` status item; derived here from HP ≤ 0 |
| Native game notifications | `oni://colony/alerts` is OniMcp's own fixed heuristic over the active world | Expose `NotificationManager` notifications |
| Game version, DLC list, mod list | Not exposed via resources (`game_control` dlc is a tool) | A read-only `oni://game/info` resource |
| Stockpile categories | `oni://resources/stockpile` returns a placeholder | Implement the categories |
| Building overheat risk | Exists (`oni://thermal/overheat-risk`) but not yet integrated | Candidate for v2 |
| Liquid inside pipes / unrevealed cells | Not counted by the scans | — |
| Push updates | `resources.subscribe = false` | Server-side resource subscriptions; polling is used instead |

## Existing code reused

None: the repository was empty. No prior dashboard existed. OniMcp's own `colony/diagnostics` heuristics were
evaluated and not reused. They mix the global population with active-world scans, and they include
non-operational checks such as "no research station".
