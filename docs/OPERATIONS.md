# Colony operations — commander and Claude

You are the **Colony Commander**: you set objectives, change strategic priorities, approve actions and review
performance. **Claude is the Colony Operations Manager**: it monitors continuously, keeps the objective list
current, investigates problems and reports. It runs inside the **Colony Operations Agent** on the home PC.

## Commander instruction processing

Every message you send goes through the same pipeline (`src/lib/ops/agent.ts`):

1. **Receive.** The phone stores the command in its outbox with a client-generated idempotency key, then POSTs it. The
   home PC appends it to `data/ops/commands.jsonl`, writes an audit entry and replies **202 + sequence number**
   (acknowledgement). A resend with the same key returns the original command and is never processed twice, even
   after a reconnect or a server restart.
2. **Parse intent.** Claude receives the message, a compact colony snapshot, the current objectives and mode, and the
   recent conversation. It returns a schema-validated interpretation (structured outputs).
3. **Classify:** `strategic_instruction`, `information_request`, `recommendation_request`, `action_permission`,
   `mode_change`, `acknowledgement` or `unclear` (in which case it asks you a question).
4. **Identify affected asteroids** against the live world list ("the second asteroid" resolves to a world ID).
5. **Check conflicts** with existing objectives, constraints and live CRITICAL alerts. Conflicts are reported along with
   a recommended revised plan; they are never resolved silently.
6. **Advisory vs authorisation.** A strategic instruction is never permission to act. Explicit permission for a
   specific action is recorded, but nothing executes at Level 1.
7. **Update objectives** as targeted operations: create, update, pause, resume, complete or cancel, by objective ID.
   Unrelated objectives are left alone. The agent validates every operation: unknown worlds or objectives are
   rejected, priorities are clamped, and unknown dependencies are dropped.
8. **Confirm** the interpretation back to you in the thread.
9. **Track** the work: objectives with machine-checkable criteria update their progress on every observation, and
   complete after the criteria hold for 3 consecutive checks. You're notified when that happens.

If Claude is unavailable (no key, API error, or the hourly budget is spent), the instruction is **queued** and the
thread says so; it's retried automatically. Mode, objective, approval and setting changes don't need Claude.

### The headline example

> "Forget expansion for now. Our second asteroid is becoming unstable. Focus on food, oxygen, and power. Keep me updated."

Expected handling:
- Classified as a strategic instruction for world *N* (the second settled asteroid).
- Expansion-related objectives are **paused** (not deleted).
- Critical-priority objectives are created for food, oxygen and power on that asteroid, with measurable criteria (food
  runway ≥ 10 cycles, O₂ per duplicant ≥ 50 kg, battery ≥ 50%).
- A **Stabilization** (or **Survival**) mode change is *recommended*: one tap to accept, never applied silently.
- An investigation is opened on that asteroid.
- Periodic status reports are switched on.

`tests/agent.test.ts` exercises exactly this flow.

## Objectives

| Field | Notes |
|---|---|
| description, target asteroid | `worldId` (null = colony-wide) |
| priority | 1 Emergency · 2 Critical · 3 High · 4 Normal · 5 Deferred |
| status | active · blocked · paused · completed · cancelled |
| completion criteria | text, plus optional machine-checkable criteria (`foodRunwayCycles`, `oxygenKgPerDupe`, `batteryPct`, `powerHeadroomW`, `waterKg`, `coalKg`, `incapacitated`, `starving`, `maxStressPct`, `generatorsOperational`, `population`, `activeCriticalAlerts`) |
| dependencies, constraints | constraints such as "do not accept new duplicants" |
| progress | from the criteria when present, otherwise Claude's last assessment |
| created / updated / history | full change history, with who changed what |

You can edit priority and status directly from the Command or AI Ops screens.

## Operating modes

| Mode | Focus | Defers |
|---|---|---|
| Survival | food, oxygen, water, power, health | expansion, new industries, rockets, printing new duplicants |
| Stabilization | repair fragile infrastructure, build reserves | large new projects |
| Expansion | new industries, infrastructure, outposts | — |
| Exploration | rockets, space, remote resources | non-essential base projects |
| Commander-Directed (default) | your explicit objectives | — |

Claude may **recommend** a mode, for example Survival when life-support alerts are CRITICAL. The recommendation
explains the conflict with your current mode and lists the objectives it would defer. Only you can accept it.

## Monitoring, investigations and reports

- Every CRITICAL alert opens an investigation automatically. The agent gathers read-only evidence (alerts, projections,
  duplicant status, crops, detailed power) and Claude analyses it, tagging each finding *observed*, *derived* or
  *assumption*.
- Background reviews run at most every *N* minutes (default 20), and only while there are active alerts or objectives.
- "Keep me updated" turns on status reports (default hourly), sent to the thread and as notifications.
- **Cost guard:** a hard cap on Claude calls per hour (default 20); your instructions get a small reserve above it.
- **Honesty:** when monitoring is stale (game closed, OniMcp down, colony not loaded), the agent doesn't evaluate
  objectives, open investigations or write reports, and the UI says "Claude is not observing the colony right now".

## Action authorization

| Level | Meaning | Status |
|---|---|---|
| 1 — Observation | Observe, analyse, recommend, *propose* actions with manual steps. | **Active (enforced)** |
| 2 — Supervised execution | Execute a proposed action only after you approve that exact proposal. Destructive/critical actions also need a typed confirmation phrase. | Designed and policy-tested, **not enabled** |
| 3 — Authorized autonomy | Routine actions in categories you grant run without per-action approval. Deconstruction, rocketry and printing-pod actions are never autonomous; elevated or destructive risks always need approval. | Designed and policy-tested, **not enabled** |

The policy is `src/lib/ops/authorization.ts`, unit-tested in `tests/ops.test.ts`. `executeProposal()` deliberately
throws, and the MCP client refuses `tools/call`, so v1 cannot change the game by construction. Approving a proposal
records your decision in the audit log and shows the manual steps.

A future execution layer must, for every action:
1. run OniMcp's `dryRun`;
2. show you the preview;
3. require an `execute` verdict from the policy;
4. call with `confirm=true`;
5. re-read game state to verify the result;
6. audit-log every step.

## Notifications

See [REMOTE_ACCESS.md](REMOTE_ACCESS.md#notifications). Categories: food, starvation, oxygen, power, water,
temperature, duplicant health, AI unable to resolve an emergency (CRITICAL for 30+ minutes with no resolution),
monitoring disconnected (after 2 minutes) and restored, instruction received, objective completed, investigation
results, status reports.
