import os from "node:os";
import path from "node:path";
import type { Collector } from "../collector/collector";
import { withQuery } from "../mcp/readonly";
import type { AlertRecord, DashboardState } from "../model/types";
import { ANALYST_SYSTEM, AnalysisSchema, buildAnalysisPrompt, type Analysis } from "./analyst";
import { authorize } from "./authorization";
import { detectGameProcess, ScreenshotService } from "./home";
import { buildInterpreterPrompt, buildOpsContext, INTERPRETER_SYSTEM, InterpretationSchema, type Interpretation } from "./interpreter";
import { RateLimitedError, type StructuredLlm } from "./llm";
import { Heartbeat, Notifier } from "./notify";
import { createObjective, evaluateObjectives, MODES, survivalRecommended, updateObjective } from "./objectives";
import { newId, type OpsStore } from "./store";
import type {
  ActionProposal,
  AgentStatus,
  Command,
  CommandType,
  HomeStatus,
  Investigation,
  NotificationPrefs,
  Objective,
  OperatingMode,
  OpsState,
  PriorityLevel,
  Recommendation,
} from "./types";
import { PRIORITY_LABELS } from "./types";

const MODES_LIST: OperatingMode[] = ["survival", "stabilization", "expansion", "exploration", "commander"];
const clampPriority = (n: unknown): PriorityLevel => (Math.min(5, Math.max(1, Math.round(Number(n) || 4))) as PriorityLevel);
const MAX_DEFER_ATTEMPTS = 5;

export interface AgentDeps {
  collector: Collector;
  store: OpsStore;
  /** Claude in production; null when not configured. */
  llm: StructuredLlm | null;
  /** Used only while the collector is connected to the simulator. */
  simulatedLlm?: StructuredLlm | null;
  notifier: Notifier;
  heartbeat?: Heartbeat;
  screenshots?: ScreenshotService;
  authInfo?: () => { passphraseSet: boolean; sessions: number };
  tickMs?: number;
}

export class OperationsAgent {
  private readonly startedAt = Date.now();
  private lastTickAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastReviewAt = 0;
  private lastReportAt = 0;
  private lastHeartbeat = 0;
  private lastScreenshot = 0;
  private lastProcessCheck = 0;
  private gameProcess: HomeStatus["gameProcess"] = "unknown";
  private alertLevels = new Map<string, "CRITICAL" | "WARNING" | "INFO">();
  private alertsPrimed = false;
  private investigatedAlerts = new Set<string>();
  private unresolvedNotified = new Set<string>();
  private disconnectedSince: number | null = null;
  private disconnectNotified = false;
  private deferAttempts = new Map<string, { n: number; nextAt: number }>();
  private currentInvestigationId: string | null = null;
  private lastClaudeSuccessAt: number | null = null;
  private lastClaudeError: string | null = null;
  private readonly d: Required<Omit<AgentDeps, "simulatedLlm" | "heartbeat" | "screenshots" | "authInfo">> & Pick<AgentDeps, "simulatedLlm" | "heartbeat" | "screenshots" | "authInfo">;
  private onState = (s: DashboardState) => void this.observe(s);

  constructor(deps: AgentDeps) {
    this.d = { tickMs: 2000, ...deps } as typeof this.d;
  }

  start(): void {
    if (this.timer) return;
    this.d.collector.on("state", this.onState);
    this.timer = setInterval(() => void this.tick(), this.d.tickMs);
    this.d.store.audit("agent", "agent.started", { pid: process.pid, host: os.hostname() });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.d.collector.off("state", this.onState);
  }

  /* ------------------------------------------------------------ LLM choice */

  /** Claude if configured; the simulated interpreter only while monitoring the simulator. */
  private llm(): StructuredLlm | null {
    if (this.d.llm?.available()) return this.d.llm;
    const dash = this.d.collector.getState();
    if (dash.connection.simulated && this.d.simulatedLlm) return this.d.simulatedLlm;
    return null;
  }

  private llmUnavailableReason(): string {
    return this.d.llm ? this.d.llm.available() ? (this.lastClaudeError ?? "unknown error") : "Claude is not configured on the home PC (ANTHROPIC_API_KEY)." : "Claude is not configured on the home PC (ANTHROPIC_API_KEY).";
  }

  private async ask<T>(purpose: string, system: string, user: string, schema: import("zod").ZodType<T>, priority: "commander" | "background"): Promise<{ data: T; simulated: boolean }> {
    const llm = this.llm();
    if (!llm) throw new Error(this.llmUnavailableReason());
    try {
      const r = await llm.call({ purpose, system, user, schema, priority });
      if (!llm.simulated) this.lastClaudeSuccessAt = Date.now();
      return { data: r.data, simulated: llm.simulated };
    } catch (e) {
      if (!llm.simulated) this.lastClaudeError = (e as Error).message;
      throw e;
    }
  }

  /* ---------------------------------------------------------- commands API */

  /** Called by the HTTP layer. Idempotent on clientId. */
  submit(input: { clientId: string; type: CommandType; payload: Record<string, unknown>; issuedBy: string; clientCreatedAt: number | null }) {
    const r = this.d.store.enqueue(input);
    if (!r.duplicate && input.type === "instruction") {
      this.d.store.addMessage({ from: "commander", text: String(input.payload.text ?? ""), commandClientId: input.clientId, kind: null });
      void this.d.notifier.notify({ category: "instruction_received", severity: "INFO", key: `cmd:${input.clientId}`, title: "Instruction received", body: String(input.payload.text ?? "").slice(0, 200) });
    }
    if (this.timer) setTimeout(() => void this.tick(), 0);
    return r;
  }

  /* ------------------------------------------------------------------ loop */

  async tick(now = Date.now()): Promise<void> {
    this.lastTickAt = now;
    if (this.busy) return;
    this.busy = true;
    try {
      await this.processCommands(now);
      await this.processInvestigations(now);
      await this.maybeReview(now);
      await this.housekeeping(now);
    } catch (e) {
      this.d.store.audit("agent", "agent.error", { message: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  private async processCommands(now: number) {
    for (const c of this.d.store.pendingCommands()) {
      await this.handle(c, now);
    }
    // Retry deferred instructions once Claude is available again.
    for (const c of this.d.store.recentCommands(200).filter((x) => x.status === "deferred").reverse()) {
      const a = this.deferAttempts.get(c.clientId) ?? { n: 0, nextAt: 0 };
      if (now < a.nextAt || !this.llm()) continue;
      await this.handle(c, now);
    }
  }

  private async handle(c: Command, now: number): Promise<void> {
    const st = this.d.store;
    st.updateCommand(c.clientId, { status: "processing" });
    const done = (result: string) => st.updateCommand(c.clientId, { status: "completed", result, processedAt: Date.now() });
    const fail = (error: string) => st.updateCommand(c.clientId, { status: "failed", error, processedAt: Date.now() });
    const p = c.payload;
    try {
      switch (c.type) {
        case "instruction":
          return await this.handleInstruction(c, now);
        case "mode.set": {
          const mode = String(p.mode) as OperatingMode;
          if (!MODES_LIST.includes(mode)) return void fail("Unknown mode");
          const before = st.state.mode.mode;
          st.mutate((s) => {
            s.mode = { mode, setBy: "commander", setAt: Date.now(), note: typeof p.note === "string" ? p.note.slice(0, 300) : null };
            for (const r of s.recommendations) if (r.kind === "mode_change" && r.status === "pending") r.status = "superseded";
          });
          st.decide({ summary: `Operating mode set to ${MODES[mode].label} by the commander`, reasoning: `Changed from ${MODES[before].label}. ${MODES[mode].summary}`, basis: "commander" });
          st.addMessage({ from: "system", text: `Operating mode: ${MODES[before].label} → ${MODES[mode].label}. ${MODES[mode].summary}`, commandClientId: c.clientId, kind: "notice" });
          return void done(`Mode ${mode}`);
        }
        case "objective.update": {
          const o = st.state.objectives.find((x) => x.id === p.id);
          if (!o) return void fail("Objective not found");
          const patch: Parameters<typeof updateObjective>[1] = {};
          if (p.priority !== undefined) patch.priority = clampPriority(p.priority);
          if (typeof p.status === "string" && ["active", "paused", "completed", "cancelled", "blocked"].includes(p.status)) patch.status = p.status as Objective["status"];
          st.mutate(() => updateObjective(o, patch, "commander", "Commander edit"));
          return void done("Objective updated");
        }
        case "objective.create": {
          const title = String(p.title ?? "").trim();
          if (!title) return void fail("Title required");
          const wid = typeof p.worldId === "number" ? p.worldId : null;
          const o = createObjective(
            { title, description: String(p.description ?? ""), worldId: wid, priority: clampPriority(p.priority), completionCriteria: String(p.completionCriteria ?? "Commander confirms completion"), criteria: [], dependencies: [], constraints: Array.isArray(p.constraints) ? p.constraints.map(String) : [] },
            "commander",
            this.worldName(wid),
            c.clientId,
          );
          st.mutate((s) => s.objectives.push(o));
          return void done(`Created ${o.id}`);
        }
        case "recommendation.decide":
          return void this.decideRecommendation(String(p.id), p.decision === "accept", c, done, fail);
        case "proposal.decide":
          return void this.decideProposal(String(p.id), p.decision === "approve", c, done, fail);
        case "permission.set": {
          const level = Number(p.level);
          if (level !== 1) return void fail("Levels 2 and 3 require the execution layer, which is not enabled in this version. Permission stays at Level 1 (Observation).");
          return void done("Permission level 1 (Observation)");
        }
        case "notifications.update": {
          const prefs = sanitizePrefs(p, st.state.notificationPrefs);
          st.mutate((s) => (s.notificationPrefs = prefs));
          return void done("Notification preferences updated");
        }
        case "settings.update": {
          st.mutate((s) => {
            const a = s.agentSettings;
            const num = (k: keyof typeof a, min: number, max: number) => {
              if (typeof p[k] === "number" && Number.isFinite(p[k])) (a[k] as number) = Math.min(max, Math.max(min, p[k] as number));
            };
            num("analysisIntervalMinutes", 5, 720);
            num("maxClaudeCallsPerHour", 0, 120);
            num("statusReportMinutes", 15, 1440);
            num("screenshotIntervalMinutes", 0, 1440);
            if (typeof p.keepCommanderUpdated === "boolean") a.keepCommanderUpdated = p.keepCommanderUpdated;
          });
          return void done("Agent settings updated");
        }
        case "investigation.request": {
          const inv = this.openInvestigation(String(p.topic ?? "Commander request").slice(0, 200), typeof p.worldId === "number" ? p.worldId : null, "commander", c.clientId);
          return void done(`Investigation ${inv.id} opened`);
        }
        case "report.request": {
          await this.review(now, "commander");
          return void done("Report delivered");
        }
        case "alert.ack":
          return void (this.d.collector.acknowledge(String(p.id)) ? done("Acknowledged") : fail("Alert not found"));
        case "alert.dismiss":
          return void (this.d.collector.dismiss(String(p.id)) ? done("Dismissed") : fail("Alert not found"));
        default:
          return void fail(`Unknown command type ${String(c.type)}`);
      }
    } catch (e) {
      fail((e as Error).message);
    }
  }

  /* -------------------------------------------------------- instructions */

  private async handleInstruction(c: Command, now: number) {
    const st = this.d.store;
    const text = String(c.payload.text ?? "").trim().slice(0, 4000);
    if (!text) return void st.updateCommand(c.clientId, { status: "failed", error: "Empty instruction", processedAt: now });
    if (!this.llm()) {
      const a = this.deferAttempts.get(c.clientId) ?? { n: 0, nextAt: 0 };
      if (a.n === 0) {
        st.addMessage({ from: "system", text: `Instruction received and queued on the home PC. ${this.llmUnavailableReason()} It will be interpreted as soon as Claude is available. Use the controls (mode, objectives) for changes that don't need interpretation.`, commandClientId: c.clientId, kind: "notice" });
      }
      this.deferAttempts.set(c.clientId, { n: a.n + 1, nextAt: now + 60_000 });
      return void st.updateCommand(c.clientId, { status: "deferred", result: "Awaiting Claude" });
    }
    const dash = this.d.collector.getState();
    const ctx = { dashboard: dash, mode: st.state.mode, permissionLevel: st.state.permissionLevel, objectives: st.state.objectives, recentMessages: st.recentMessages(12).filter((m) => m.commandClientId !== c.clientId) };
    let interp: Interpretation, simulated: boolean;
    try {
      ({ data: interp, simulated } = await this.ask("interpret", INTERPRETER_SYSTEM, buildInterpreterPrompt(text, ctx), InterpretationSchema, "commander"));
    } catch (e) {
      const a = this.deferAttempts.get(c.clientId) ?? { n: 0, nextAt: 0 };
      if (a.n + 1 >= MAX_DEFER_ATTEMPTS) {
        st.addMessage({ from: "system", text: `Could not interpret your instruction after ${MAX_DEFER_ATTEMPTS} attempts: ${(e as Error).message}`, commandClientId: c.clientId, kind: "notice" });
        return void st.updateCommand(c.clientId, { status: "failed", error: (e as Error).message, processedAt: Date.now() });
      }
      this.deferAttempts.set(c.clientId, { n: a.n + 1, nextAt: now + (e instanceof RateLimitedError ? 300_000 : 60_000 * (a.n + 1)) });
      if (a.n === 0) st.addMessage({ from: "system", text: `Instruction queued — Claude call failed (${(e as Error).message}). Retrying automatically.`, commandClientId: c.clientId, kind: "notice" });
      return void st.updateCommand(c.clientId, { status: "deferred", error: (e as Error).message });
    }
    const applied = this.applyInterpretation(interp, c, simulated);
    st.addMessage({ from: "claude", text: interp.reply + (applied.notes.length ? `\n\n${applied.notes.join("\n")}` : ""), commandClientId: c.clientId, kind: interp.kind, degraded: simulated, objectiveIds: applied.objectiveIds });
    st.decide({ summary: `Interpreted commander instruction as ${interp.kind.replace(/_/g, " ")}`, reasoning: interp.intentSummary, basis: "commander" });
    st.updateCommand(c.clientId, { status: "completed", result: `${interp.kind}: ${applied.objectiveIds.length} objective change(s)`, processedAt: Date.now() });
  }

  /** Validate and apply Claude's structured interpretation. Returns notes about anything rejected. */
  applyInterpretation(i: Interpretation, c: Command, simulated: boolean): { objectiveIds: string[]; notes: string[] } {
    const st = this.d.store;
    const dash = this.d.collector.getState();
    const worldIds = new Set((dash.snapshot?.worlds ?? []).map((w) => w.id));
    const validWorld = (w: number | null) => (w === null || worldIds.has(w) ? w : null);
    const notes: string[] = [];
    const ids: string[] = [];
    const by = simulated ? "agent" : "claude";
    st.mutate((s) => {
      for (const op of i.objectiveOps) {
        if (op.op === "create") {
          if (!op.title) continue;
          const wid = validWorld(op.worldId);
          const o = createObjective(
            {
              title: op.title,
              description: op.description ?? "",
              worldId: wid,
              priority: clampPriority(op.priority ?? 4),
              completionCriteria: op.completionCriteria ?? "Commander confirms completion",
              criteria: (op.criteria ?? []).map((k) => ({ ...k, worldId: validWorld(k.worldId) })),
              dependencies: (op.dependencies ?? []).filter((d) => s.objectives.some((x) => x.id === d)),
              constraints: op.constraints ?? [],
            },
            "commander", // created on the commander's instruction
            this.worldName(wid),
            c.clientId,
          );
          o.history[0] = { at: o.createdAt, by: by === "claude" ? "claude" : "agent", note: `Created from commander instruction: ${op.reason}` };
          s.objectives.push(o);
          ids.push(o.id);
          continue;
        }
        const o = s.objectives.find((x) => x.id === op.objectiveId);
        if (!o) {
          notes.push(`(Skipped a change to unknown objective ${op.objectiveId ?? "?"}.)`);
          continue;
        }
        const status: Record<string, Objective["status"]> = { pause: "paused", resume: "active", complete: "completed", cancel: "cancelled" };
        updateObjective(
          o,
          {
            status: status[op.op],
            priority: op.priority != null ? clampPriority(op.priority) : undefined,
            description: op.description ?? undefined,
            constraints: op.constraints ?? undefined,
            completionCriteria: op.completionCriteria ?? undefined,
            criteria: op.criteria ? op.criteria.map((k) => ({ ...k, worldId: validWorld(k.worldId) })) : undefined,
            title: op.title ?? undefined,
          },
          by === "claude" ? "claude" : "agent",
          `Commander instruction: ${op.reason}`,
        );
        ids.push(o.id);
      }
      if (i.explicitModeChange && i.explicitModeChange !== s.mode.mode) {
        const before = s.mode.mode;
        s.mode = { mode: i.explicitModeChange, setBy: "commander", setAt: Date.now(), note: i.intentSummary };
        s.decisions.push({ at: Date.now(), summary: `Mode ${MODES[before].label} → ${MODES[i.explicitModeChange].label} (commander instruction)`, reasoning: i.intentSummary, basis: "commander" });
      }
      if (i.recommendedMode && i.recommendedMode !== s.mode.mode && !i.explicitModeChange) {
        for (const r of s.recommendations) if (r.kind === "mode_change" && r.status === "pending") r.status = "superseded";
        s.recommendations.push({ id: newId("rec"), at: Date.now(), kind: "mode_change", title: `Switch to ${MODES[i.recommendedMode].label} mode`, rationale: i.recommendedModeReason ?? "", conflict: null, mode: i.recommendedMode, status: "pending", decidedAt: null });
      }
      for (const cf of i.conflicts) {
        s.recommendations.push({ id: newId("rec"), at: Date.now(), kind: "plan_revision", title: "Conflict with existing plan", rationale: cf.recommendation, conflict: cf.description, status: "pending", decidedAt: null });
      }
      if (i.keepCommanderUpdated !== null) s.agentSettings.keepCommanderUpdated = i.keepCommanderUpdated;
    });
    for (const inv of i.investigations) this.openInvestigation(inv.topic, validWorld(inv.worldId), "commander", c.clientId);
    if (i.actionPermission.granted) {
      st.audit("claude", "permission.noted", { scope: i.actionPermission.scope, clientId: c.clientId });
      notes.push("Note: action permission recorded, but execution is disabled at Level 1 (Observation). Nothing was or will be changed in the game.");
    }
    if (simulated) notes.push("⚠ Interpreted by the SIMULATED interpreter (demo mode), not Claude.");
    return { objectiveIds: ids, notes };
  }

  private decideRecommendation(id: string, accept: boolean, c: Command, done: (r: string) => void, fail: (e: string) => void) {
    const st = this.d.store;
    const r = st.state.recommendations.find((x) => x.id === id);
    if (!r || r.status !== "pending") return fail("Recommendation not pending");
    st.mutate((s) => {
      r.status = accept ? "accepted" : "declined";
      r.decidedAt = Date.now();
      if (accept && r.kind === "mode_change" && r.mode) {
        s.mode = { mode: r.mode, setBy: "commander", setAt: Date.now(), note: `Accepted recommendation: ${r.rationale}` };
      }
      if (accept && r.objectiveChanges) {
        for (const ch of r.objectiveChanges) {
          const o = s.objectives.find((x) => x.id === ch.id);
          if (o) updateObjective(o, { priority: ch.priority, status: ch.status }, "commander", "Accepted recommendation");
        }
      }
    });
    st.decide({ summary: `Commander ${accept ? "accepted" : "declined"}: ${r.title}`, reasoning: r.rationale, basis: "commander" });
    st.addMessage({ from: "system", text: `${accept ? "Accepted" : "Declined"}: ${r.title}`, commandClientId: c.clientId, kind: "notice" });
    done(accept ? "Accepted" : "Declined");
  }

  private decideProposal(id: string, approve: boolean, c: Command, done: (r: string) => void, fail: (e: string) => void) {
    const st = this.d.store;
    const p = st.state.proposals.find((x) => x.id === id);
    if (!p || p.status !== "proposed") return fail("Proposal not awaiting a decision");
    const decision = authorize(p, { level: st.state.permissionLevel, executionLayerEnabled: false, grantedCategories: [], approval: approve ? { proposalId: p.id } : null });
    st.mutate(() => {
      p.status = approve ? "approved" : "rejected";
      p.decidedAt = Date.now();
      p.decidedBy = c.issuedBy;
      p.executionNote = approve ? `Approved, not executed: ${decision.reason}` : "Rejected by commander.";
    });
    st.audit(c.issuedBy, approve ? "proposal.approved" : "proposal.rejected", { id: p.id, title: p.title, authorization: decision });
    done(p.executionNote ?? "");
  }

  /* ------------------------------------------------------- investigations */

  openInvestigation(topic: string, worldId: number | null, trigger: Investigation["trigger"], ref: string | null): Investigation {
    const inv: Investigation = {
      id: newId("inv"),
      topic,
      worldId,
      worldName: this.worldName(worldId),
      trigger,
      triggerRef: ref,
      status: "open",
      openedAt: Date.now(),
      updatedAt: Date.now(),
      summary: null,
      findings: [],
      recommendations: [],
      evidence: {},
      blockedReason: null,
    };
    this.d.store.mutate((s) => s.investigations.push(inv));
    this.d.store.audit("agent", "investigation.opened", { id: inv.id, topic, worldId, trigger });
    return inv;
  }

  private async gatherEvidence(inv: Investigation) {
    const dash = this.d.collector.getState();
    const w = dash.snapshot?.worlds.find((x) => x.id === inv.worldId);
    const ev: Record<string, unknown> = {
      worldAlerts: dash.alerts.filter((a) => a.status === "active" && (inv.worldId === null || a.worldId === inv.worldId)).map((a) => ({ severity: a.severity, title: a.title, what: a.what, evidence: a.evidence })),
      projections: dash.projections.filter((p) => inv.worldId === null || p.worldId === inv.worldId).map((p) => ({ label: p.label, worldId: p.worldId, cycles: p.cycles, confidence: p.confidence })),
      duplicants: w?.dupes.map((d) => ({ name: d.name, hp: d.healthPct, stress: d.stressPct, kcal: d.caloriesKcal, breath: d.breathPct, risk: d.risk, reasons: d.reasons })),
    };
    if (inv.worldId !== null && !dash.stale) {
      // Extra read-only evidence straight from OniMcp.
      for (const [k, uri] of [
        ["crops", withQuery("oni://farming/crops", { worldId: inv.worldId })],
        ["powerDetail", withQuery("oni://power/summary", { worldId: inv.worldId, includeDetails: true, limit: 25 })],
      ] as const) {
        try {
          ev[k] = await this.d.collector.client.readJson(uri);
        } catch (e) {
          ev[k] = { unavailable: (e as Error).message };
        }
      }
    }
    return ev;
  }

  private async processInvestigations(now: number) {
    const open = this.d.store.state.investigations.filter((i) => i.status === "open").sort((a, b) => (a.trigger === "commander" ? -1 : 0) - (b.trigger === "commander" ? -1 : 0) || a.openedAt - b.openedAt);
    const inv = open[0];
    if (!inv) return;
    const dash = this.d.collector.getState();
    if (dash.stale) return; // never investigate on stale data
    if (!this.llm()) {
      if (!inv.blockedReason) this.d.store.mutate(() => (inv.blockedReason = `Awaiting analysis: ${this.llmUnavailableReason()}`));
      return;
    }
    this.currentInvestigationId = inv.id;
    this.d.store.mutate(() => {
      inv.status = "analyzing";
      inv.updatedAt = now;
      inv.blockedReason = null;
    });
    try {
      inv.evidence = await this.gatherEvidence(inv);
      const ctx = this.contextFor(dash);
      const { data, simulated } = await this.ask("investigate", ANALYST_SYSTEM, buildAnalysisPrompt("investigation", ctx, `${inv.topic}${inv.worldName ? ` (world ${inv.worldId}: ${inv.worldName})` : ""}`, inv.evidence), AnalysisSchema, inv.trigger === "commander" ? "commander" : "background");
      this.applyAnalysis(data, simulated, inv);
    } catch (e) {
      this.d.store.mutate(() => {
        inv.status = "open";
        inv.blockedReason = `Analysis postponed: ${(e as Error).message}`;
        inv.updatedAt = Date.now();
      });
    } finally {
      this.currentInvestigationId = null;
    }
  }

  private applyAnalysis(a: Analysis, simulated: boolean, inv: Investigation | null) {
    const st = this.d.store;
    const tag = simulated ? " [SIMULATED]" : "";
    st.mutate((s) => {
      if (inv) {
        inv.summary = a.summary;
        inv.findings = a.findings;
        inv.recommendations = a.recommendations;
        inv.status = a.conclusion === "unable_to_resolve" ? "blocked" : "concluded";
        inv.blockedReason = a.conclusion === "unable_to_resolve" ? a.summary : null;
        inv.updatedAt = Date.now();
        inv.evidence = {}; // keep the persisted state small; findings carry the conclusions
      }
      for (const pa of a.proposedActions.slice(0, 5)) {
        if (s.proposals.some((x) => x.status === "proposed" && x.title === pa.title)) continue;
        const prop: ActionProposal = { id: newId("act"), at: Date.now(), ...pa, status: "proposed", decidedAt: null, decidedBy: null, executionNote: null };
        s.proposals.push(prop);
      }
      for (const n of a.objectiveNotes) {
        const o = s.objectives.find((x) => x.id === n.objectiveId);
        if (!o || o.status === "completed" || o.status === "cancelled") continue;
        if (o.criteria.length === 0 && n.progress !== null) o.progress = Math.max(0, Math.min(100, Math.round(n.progress)));
        if (o.criteria.length === 0) o.progressNote = n.progressNote;
        if (n.blocked && o.status === "active") updateObjective(o, { status: "blocked" }, "claude", n.blockedReason ?? "Blocked");
        else if (!n.blocked && o.status === "blocked") updateObjective(o, { status: "active" }, "claude", "Unblocked");
      }
      const m = a.modeRecommendation;
      if (m.mode && m.mode !== s.mode.mode && !s.recommendations.some((r) => r.kind === "mode_change" && r.status === "pending" && r.mode === m.mode)) {
        for (const r of s.recommendations) if (r.kind === "mode_change" && r.status === "pending") r.status = "superseded";
        s.recommendations.push({ id: newId("rec"), at: Date.now(), kind: "mode_change", title: `Switch to ${MODES[m.mode].label} mode`, rationale: m.reason ?? "", conflict: s.mode.setBy === "commander" ? `You selected ${MODES[s.mode.mode].label} mode; Claude will not change it without your approval.` : null, mode: m.mode, status: "pending", decidedAt: null });
      }
      s.decisions.push({ at: Date.now(), summary: inv ? `Investigation concluded (${a.conclusion}): ${inv.topic}` : `Operational review (${a.conclusion})`, reasoning: a.summary, basis: inv ? (inv.trigger === "commander" ? "commander" : "alert") : "periodic" });
    });
    if (inv) {
      st.addMessage({ from: "claude", text: `Investigation${tag}: ${inv.topic}\n${a.summary}${a.recommendations.length ? `\n\nRecommended:\n${a.recommendations.slice(0, 4).map((r, i) => `${i + 1}. ${r}`).join("\n")}` : ""}`, commandClientId: inv.triggerRef, kind: "investigation", degraded: simulated });
      if (inv.trigger === "commander" || a.conclusion !== "ongoing") {
        void this.d.notifier.notify({ category: a.conclusion === "unable_to_resolve" ? "ai_unresolved" : "investigation", severity: a.conclusion === "unable_to_resolve" ? "CRITICAL" : "INFO", key: `inv:${inv.id}`, title: `${a.conclusion === "unable_to_resolve" ? "Claude cannot resolve" : "Investigation"}: ${inv.topic.slice(0, 60)}`, body: a.summary });
      }
    }
  }

  /* -------------------------------------------------------------- reviews */

  private contextFor(dash: DashboardState) {
    const st = this.d.store;
    return buildOpsContext({ dashboard: dash, mode: st.state.mode, permissionLevel: st.state.permissionLevel, objectives: st.state.objectives, recentMessages: [] });
  }

  private async maybeReview(now: number) {
    const set = this.d.store.state.agentSettings;
    const dash = this.d.collector.getState();
    if (dash.stale || !dash.snapshot || dash.snapshot.time?.paused) return;
    const reportDue = set.keepCommanderUpdated && now - this.lastReportAt >= set.statusReportMinutes * 60_000;
    const reviewDue = now - this.lastReviewAt >= set.analysisIntervalMinutes * 60_000 && (dash.alerts.some((a) => a.status === "active" && a.severity !== "INFO") || this.d.store.state.objectives.some((o) => o.status === "active"));
    if (!reportDue && !reviewDue) return;
    if (!this.llm()) return;
    await this.review(now, reportDue ? "report" : "background");
  }

  private async review(now: number, why: "commander" | "report" | "background") {
    const dash = this.d.collector.getState();
    if (dash.stale) {
      this.d.store.addMessage({ from: "system", text: `Cannot produce a status report: live monitoring is interrupted (${dash.staleReason ?? "stale data"}). Claude is not observing the colony right now.`, commandClientId: null, kind: "notice" });
      return;
    }
    this.lastReviewAt = now;
    try {
      const { data, simulated } = await this.ask("review", ANALYST_SYSTEM, buildAnalysisPrompt("review", this.contextFor(dash), null, null), AnalysisSchema, why === "commander" ? "commander" : "background");
      this.applyAnalysis(data, simulated, null);
      if (why !== "background") {
        this.lastReportAt = now;
        this.d.store.addMessage({ from: "claude", text: `Status report${simulated ? " [SIMULATED]" : ""} — cycle ${dash.snapshot?.time?.cycle ?? "?"}\n${data.summary}${data.recommendations.length ? `\n\nNext:\n${data.recommendations.slice(0, 3).map((r, i) => `${i + 1}. ${r}`).join("\n")}` : ""}`, commandClientId: null, kind: "report", degraded: simulated });
        await this.d.notifier.notify({ category: "status_report", severity: "INFO", key: `report:${now}`, title: `Status report — cycle ${dash.snapshot?.time?.cycle ?? "?"}`, body: data.summary });
      }
    } catch (e) {
      if (why === "commander") this.d.store.addMessage({ from: "system", text: `Report unavailable: ${(e as Error).message}`, commandClientId: null, kind: "notice" });
    }
  }

  /* ------------------------------------------------------- observation */

  /** Called on every collector update. Cheap, deterministic, no LLM. */
  async observe(dash: DashboardState, now = Date.now()): Promise<void> {
    const st = this.d.store;
    // Connection loss / recovery notifications (only after 2 minutes, to ignore blips).
    if (dash.stale) {
      this.disconnectedSince ??= now;
      if (!this.disconnectNotified && now - this.disconnectedSince > 120_000) {
        this.disconnectNotified = true;
        st.audit("agent", "monitoring.interrupted", { reason: dash.staleReason });
        await this.d.notifier.notify({ category: "game_disconnected", severity: "WARNING", key: "monitoring", title: "Colony monitoring interrupted", body: `${dash.staleReason ?? "No data"}. Claude is not observing the colony until the connection returns.` });
      }
      return; // never evaluate objectives or alerts on stale data
    }
    if (this.disconnectNotified) {
      st.audit("agent", "monitoring.restored", {});
      await this.d.notifier.notify({ category: "game_disconnected", severity: "INFO", key: "monitoring-restored", title: "Colony monitoring restored", body: "Live data from OniMcp is flowing again." });
    }
    this.disconnectedSince = null;
    this.disconnectNotified = false;
    if (!dash.snapshot) return;

    // Alert notifications: only on raise/escalation. The first observation after start primes state silently.
    if (this.alertsPrimed) await this.d.notifier.fromAlerts(this.alertLevels, dash.alerts);
    this.alertLevels = new Map(dash.alerts.filter((a) => a.status === "active").map((a) => [a.id, a.severity]));
    this.alertsPrimed = true;

    // Objective progress & completion.
    const completed: Objective[] = [];
    st.mutate((s) => completed.push(...evaluateObjectives(s.objectives, dash.snapshot!, dash.alerts, dash.thresholds, now)));
    for (const o of completed) {
      st.addMessage({ from: "system", text: `Objective completed: ${o.title}. ${o.progressNote ?? ""}`, commandClientId: o.sourceCommandId, kind: "notice", objectiveIds: [o.id] });
      st.audit("agent", "objective.completed", { id: o.id, title: o.title });
      await this.d.notifier.notify({ category: "instruction_completed", severity: "INFO", key: `obj:${o.id}`, title: `Objective completed: ${o.title}`, body: o.progressNote ?? "" });
    }

    // New CRITICAL alerts → automatic investigation (one per alert).
    for (const a of dash.alerts.filter((x) => x.status === "active" && x.severity === "CRITICAL")) {
      if (this.investigatedAlerts.has(a.id)) continue;
      this.investigatedAlerts.add(a.id);
      if (st.state.investigations.some((i) => i.triggerRef === a.id && (i.status === "open" || i.status === "analyzing"))) continue;
      this.openInvestigation(`${a.title}${a.worldName ? ` on ${a.worldName}` : ""}`, a.worldId, "alert", a.id);
    }
    for (const id of [...this.investigatedAlerts]) if (!dash.alerts.some((a) => a.id === id && a.status === "active")) this.investigatedAlerts.delete(id);

    // Emergency vs commander's mode: recommend, never override.
    const surv = survivalRecommended(st.state.mode.mode, dash.alerts);
    if (surv.recommend && !st.state.recommendations.some((r) => r.kind === "mode_change" && r.status === "pending" && r.mode === "survival")) {
      st.mutate((s) => {
        for (const r of s.recommendations) if (r.kind === "mode_change" && r.status === "pending") r.status = "superseded";
        const conflicting = s.objectives.filter((o) => o.status === "active" && o.priority >= 3).slice(0, 5);
        const rec: Recommendation = {
          id: newId("rec"),
          at: now,
          kind: "mode_change",
          title: "Switch to Survival mode",
          rationale: surv.reason,
          conflict: `${MODES[s.mode.mode].label} mode${s.mode.setBy === "commander" ? " was chosen by you" : ""}${conflicting.length ? `; ${conflicting.length} lower-priority objective(s) would be deferred: ${conflicting.map((o) => o.title).join(", ")}` : ""}.`,
          mode: "survival",
          objectiveChanges: conflicting.map((o) => ({ id: o.id, priority: 5 as PriorityLevel })),
          status: "pending",
          decidedAt: null,
        };
        s.recommendations.push(rec);
        s.decisions.push({ at: now, summary: "Recommended Survival mode (awaiting commander)", reasoning: surv.reason, basis: "alert" });
      });
    }

    // Emergencies Claude could not resolve: CRITICAL for 30+ minutes with a blocked investigation, or no analysis possible.
    for (const a of dash.alerts.filter((x) => x.status === "active" && x.severity === "CRITICAL" && now - x.firstSeen > 30 * 60_000)) {
      if (this.unresolvedNotified.has(a.id)) continue;
      const inv = st.state.investigations.find((i) => i.triggerRef === a.id);
      if (inv && inv.status !== "blocked" && inv.status !== "open") continue;
      this.unresolvedNotified.add(a.id);
      await this.d.notifier.notify({ category: "ai_unresolved", severity: "CRITICAL", key: `unresolved:${a.id}`, title: `Unresolved emergency: ${a.title}`, body: `${a.worldName ?? "Colony"}: critical for over 30 minutes. ${inv?.blockedReason ?? "Commander action is needed — Claude cannot act in the game at Observation level."}` });
    }
  }

  private async housekeeping(now: number) {
    if (this.d.heartbeat?.configured() && now - this.lastHeartbeat >= 60_000) {
      this.lastHeartbeat = now;
      await this.d.heartbeat.beat();
    }
    if (now - this.lastProcessCheck >= 30_000) {
      this.lastProcessCheck = now;
      this.gameProcess = await detectGameProcess();
    }
    const iv = this.d.store.state.agentSettings.screenshotIntervalMinutes;
    if (iv > 0 && this.d.screenshots && now - this.lastScreenshot >= iv * 60_000) {
      this.lastScreenshot = now;
      await this.d.screenshots.capture();
    }
  }

  /* -------------------------------------------------------------- state */

  private worldName(id: number | null): string | null {
    if (id === null) return null;
    return this.d.collector.getState().snapshot?.worlds.find((w) => w.id === id)?.name ?? null;
  }

  status(now = Date.now()): AgentStatus {
    const llm = this.d.llm as (StructuredLlm & { callsLastHour?: (now?: number) => number; lastSuccessAt?: number | null; lastError?: string | null }) | null;
    return {
      running: this.timer !== null,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastClaudeSuccessAt: llm?.lastSuccessAt ?? this.lastClaudeSuccessAt,
      lastClaudeError: llm?.lastError ?? this.lastClaudeError,
      claudeAvailable: !!llm?.available(),
      claudeCallsLastHour: llm?.callsLastHour?.(now) ?? 0,
      currentInvestigationId: this.currentInvestigationId,
      queueDepth: this.d.store.pendingCommands().length + this.d.store.recentCommands(200).filter((c) => c.status === "deferred").length,
    };
  }

  home(now = Date.now()): HomeStatus {
    const dash = this.d.collector.getState();
    const auth = this.d.authInfo?.() ?? { passphraseSet: false, sessions: 0 };
    const llm = this.d.llm;
    return {
      pcOnline: true,
      hostname: os.hostname(),
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      gameProcess: this.gameProcess,
      colonyLoaded: !!dash.snapshot && dash.connection.state === "connected",
      oniMcp: dash.connection.state,
      claude: !llm?.available() ? "unconfigured" : this.status(now).lastClaudeError && !this.status(now).lastClaudeSuccessAt ? "error" : "available",
      lastObservationAt: dash.lastUpdate,
      lastHeartbeatAt: this.d.heartbeat?.lastOkAt ?? null,
      heartbeatConfigured: !!this.d.heartbeat?.configured(),
      remoteAccess: auth,
      serverTime: now,
    };
  }

  getState(now = Date.now()): OpsState {
    const st = this.d.store;
    return {
      mode: st.state.mode,
      permissionLevel: st.state.permissionLevel,
      executionLayerEnabled: false,
      objectives: [...st.state.objectives].sort((a, b) => statusRank(a) - statusRank(b) || a.priority - b.priority || b.updatedAt - a.updatedAt).slice(0, 100),
      messages: st.recentMessages(100),
      investigations: [...st.state.investigations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
      recommendations: st.state.recommendations.filter((r) => r.status === "pending" || now - r.at < 86400_000).slice(-30),
      proposals: [...st.state.proposals].sort((a, b) => b.at - a.at).slice(0, 40),
      decisions: st.state.decisions.slice(-40).reverse(),
      commands: st.recentCommands(40),
      notifications: st.recentNotifications(40),
      notificationPrefs: st.state.notificationPrefs,
      agentSettings: st.state.agentSettings,
      agent: this.status(now),
      home: this.home(now),
    };
  }

  screenshotsDir(dataDir: string) {
    return path.join(dataDir, "screenshots");
  }
}

function statusRank(o: Objective): number {
  return { active: 0, blocked: 1, proposed: 2, paused: 3, completed: 4, cancelled: 5 }[o.status];
}

function sanitizePrefs(p: Record<string, unknown>, cur: NotificationPrefs): NotificationPrefs {
  const out: NotificationPrefs = { ...cur, categories: { ...cur.categories } };
  if (typeof p.enabled === "boolean") out.enabled = p.enabled;
  if (p.minSeverity === "CRITICAL" || p.minSeverity === "WARNING" || p.minSeverity === "INFO") out.minSeverity = p.minSeverity;
  if (typeof p.cooldownMinutes === "number" && Number.isFinite(p.cooldownMinutes)) out.cooldownMinutes = Math.min(1440, Math.max(1, p.cooldownMinutes));
  const hhmm = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : v === null ? null : undefined);
  const qs = hhmm(p.quietStart), qe = hhmm(p.quietEnd);
  if (qs !== undefined) out.quietStart = qs;
  if (qe !== undefined) out.quietEnd = qe;
  if (p.categories && typeof p.categories === "object") {
    for (const [k, v] of Object.entries(p.categories as Record<string, unknown>)) if (k in out.categories && typeof v === "boolean") (out.categories as Record<string, boolean>)[k] = v;
  }
  return out;
}

export { PRIORITY_LABELS };
export type { AlertRecord };
