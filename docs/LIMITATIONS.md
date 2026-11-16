# Limitations and future work

## Verification status

| Item | Status |
|---|---|
| OniMcp protocol + payload shapes | Verified against OniMcp **0.2.6 source**; exercised end-to-end against a protocol-faithful simulator (integration tests). |
| Live game connection | **Not verified from the build environment.** The game runs on the player's PC, which was not reachable. Run `npm run probe` with the game running to confirm. |
| Game version / mod compatibility | Not exposed by OniMcp's read surface; the dashboard shows the OniMcp server name/version from `initialize`. OniMcp 0.2.6 targets the current ONI release (U-series) with Spaced Out!. |

## Remote Commander (cloud deployment) — acceptance status

"Cloud architecture, here" means: production builds, the cloud server in `IC_MODE=cloud` on PGlite (the same SQL as
Neon), `npm run agent` connected over signed outbound HTTP, the simulator as the game, and an emulated iPhone 13.

| # | Criterion | Cloud architecture, here | Real Vercel + home PC |
|---|---|---|---|
| 1 | Reachable from any device | ✅ via the network address + emulated iPhone | ⏳ deploy, then `npm run verify:remote -- --url https://…vercel.app` |
| 2 | Submit an instruction remotely | ✅ HTTP + phone UI | ⏳ |
| 3 | Home PC receives it | ✅ queued → delivered → home-confirmed | ⏳ |
| 4 | Claude interprets and acknowledges | ✅ pipeline, via the **scripted test double** and the labelled **simulated interpreter**. ❌ Not against the real Claude API (no key here) | ⏳ needs `ANTHROPIC_API_KEY` on the PC |
| 5–6 | Objectives update and display | ✅ | ⏳ |
| 7 | Monitoring continues with the browser closed | ✅ (and during a cloud outage) | ⏳ |
| 8 | Online/offline and stale clearly reported | ✅ agent killed → HOME PC OFFLINE / UNKNOWN / STALE; cloud killed → SERVICE UNREACHABLE | ⏳ |
| 9 | No duplicates after reconnect | ✅ order sent while the home PC was down, and while the cloud was down → each processed exactly once | ⏳ |
| 10 | Unauthorised users can't submit; impostor agents rejected | ✅ 401 / 403 / lockout; wrong HMAC secret → nothing delivered | ⏳ |
| 11 | Existing monitoring, alerts and local mode still work | ✅ 90 tests; local-mode acceptance rerun after the refactor | ⏳ |
| — | Production refuses demo data | ✅ simulated syncs → HTTP 409 unless `IC_ALLOW_SIMULATED=1` | ⏳ |

**Not yet verified, because they need your accounts or your PC:**
- the actual Vercel deployment;
- Neon over the network (the SQL was exercised on PGlite);
- the Windows home agent, process detection and screenshots;
- ntfy delivery;
- real Claude calls.

The architecture is not declared complete until the right-hand column passes.

## Known limitations

1. **Generation is rated, not live.** OniMcp reports the sum of generator wattage ratings, so "net" power is an upper
   bound. A real deficit is detected from the battery-energy trend.
2. **No production/consumption rates** for oxygen or food. Net rates come from stock trends, which need a few minutes of
   unpaused play before they're reliable, and are noisy around harvests.
3. **Only revealed cells are counted.** Free liquids and gases in unrevealed areas and liquid inside pipes aren't
   counted. Stored items, bottles and tanks are counted.
4. **Free natural gas** is only counted when methane is in that world's top-10 gases by mass.
5. **Average temperature is per asteroid**, over all revealed cells, not just the base. It can be skewed by hot or cold
   biomes. Building-level overheat (`oni://thermal/overheat-risk`) is not yet integrated.
6. **Incapacitation is inferred** from HP ≤ 0.
7. **Fractional game time is estimated** (integer cycle + time scale). Very slow polling or long stalls reduce accuracy.
   Gaps over 60 s are treated as discontinuities.
8. **"Settled"** is a heuristic: has duplicants or power buildings.
9. **Main-thread cost.** Four full-grid scans per settled world per minute. On very large clusters with many settled
   worlds you can raise `slowIntervalMs` (constructor option in `src/lib/server/singleton.ts`).
10. **Single colony at a time.** History is kept per save name. Two different saves with the same name share a folder.
11. **Dark theme only**, by design for a mission-control display.
12. **Next.js 15 bundles PostCSS 8.4.x**, which has open advisories. It only processes this project's own CSS at build
    time, so the risk is accepted until upgrading to Next 16.
13. **Remote:** "home PC unavailable" can only be pushed to you by an external watchdog (`IC_HEARTBEAT_URL`). The
    phone can show it only while the app is open, and it can't distinguish a dead PC from a broken tailnet path.
14. **Service worker** offline launch only works over HTTPS (`tailscale serve`) or on localhost, as browsers require.
15. **Screenshots** capture the whole home-PC desktop via OS tools and are off by default. OniMcp's own screenshot
    resource is not used, because it moves the camera and draws overlays in the game.
16. **The simulated interpreter** is keyword-based and only for demo mode. Real interpretation needs Claude.
17. **Single commander:** there's one passphrase for all devices; per-user roles aren't implemented.

## Future work

### Version 2 — intelligence
- Scheduled automatic advisor briefings (e.g. every N cycles), with a daily colony report written to `data/reports/`.
- An in-app threshold editor (the thresholds are already configurable via JSON).
- Historical performance analysis: per-cycle aggregates, cycle-over-cycle comparisons and asteroid league tables.
- Integrate `oni://thermal/overheat-risk`, `oni://farming/crops` (harvest readiness) and `oni://dupes/morale`.
- Upstream requests to OniMcp, which would remove most of the limitations above:
  - `ReportManager` daily reports (O₂ / food / power produced and consumed);
  - the native notification list;
  - an `Incapacitated` flag;
  - `IsDiscovered` and `IsModuleInterior` on worlds;
  - game version and mod list;
  - resource subscriptions (push instead of poll).
- Desktop notifications (browser Notification API) for new CRITICAL alerts.

### Version 3 — approved actions
- A separate write client, disabled by default, with per-action allowlists (e.g. priorities and schedules only).
- Every action as *proposal → OniMcp `dryRun` preview → explicit human approval in the UI → `confirm` → re-read to
  verify*, with an append-only audit log.
- The advisor may *propose* actions as structured data; it never executes them.

### Version 4 — autonomy
- Cross-asteroid logistics recommendations, predictive maintenance and emergency playbooks. These would come only after
  v3 has a proven audit trail, with hard safety limits and an always-available kill switch.
