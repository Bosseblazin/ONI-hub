import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Collector } from "@/lib/collector/collector";
import { DEFAULT_THRESHOLDS } from "@/lib/model/thresholds";
import { OperationsAgent } from "@/lib/ops/agent";
import type { Analysis } from "@/lib/ops/analyst";
import type { Interpretation } from "@/lib/ops/interpreter";
import type { LlmCall, LlmResult, StructuredLlm } from "@/lib/ops/llm";
import { Notifier, type Channel } from "@/lib/ops/notify";
import { SimulatedLlm } from "@/lib/ops/simulated-llm";
import { OpsStore } from "@/lib/ops/store";
import type { NotificationRecord } from "@/lib/ops/types";
import { OniSimulator } from "@/lib/sim/simulator";

/** Scripted stand-in for Claude: returns canned structured outputs, records prompts. TEST DOUBLE, not Claude. */
class ScriptedLlm implements StructuredLlm {
  readonly name = "scripted-test-double";
  readonly simulated = false;
  prompts: Array<{ purpose: string; user: string }> = [];
  up = true;
  constructor(private interp: (user: string) => Interpretation, private analysis: Analysis) {}
  available() { return this.up; }
  async call<T>(c: LlmCall<T>): Promise<LlmResult<T>> {
    this.prompts.push({ purpose: c.purpose, user: c.user });
    const data = c.purpose === "interpret" ? this.interp(c.user) : this.analysis;
    return { data: c.schema.parse(data), servedBy: this.name, inputTokens: 0, outputTokens: 0 };
  }
}

class Mem implements Channel {
  name = "mem";
  sent: NotificationRecord[] = [];
  configured() { return true; }
  async send(n: NotificationRecord) { this.sent.push(n); }
}

let sim: OniSimulator;
let server: http.Server;
let url: string;
const dirs: string[] = [];
const mkdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ic-agent-"));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  sim = new OniSimulator({ accel: 60 });
  server = await sim.listen(0);
  const a = server.address();
  if (typeof a !== "object" || !a) throw new Error("port");
  url = `http://127.0.0.1:${a.port}/mcp/`;
});
const agents: OperationsAgent[] = [];
afterAll(() => {
  for (const a of agents) a.stop();
  server.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const ANALYSIS: Analysis = {
  summary: "Outpost food and power are failing; farms are under-tended.",
  findings: [{ statement: "Outpost food 11k kcal for 3 duplicants", basis: "observed" }],
  recommendations: ["Raise farming priority on the outpost"],
  proposedActions: [{ title: "Raise farming priority on Sim Verdant Outpost", rationale: "Food runway < 4 cycles", category: "priorities", risk: "routine", worldId: 1, objectiveId: null, manualSteps: ["Priorities screen → Farming 9"] }],
  objectiveNotes: [],
  modeRecommendation: { mode: null, reason: null },
  conclusion: "needs_commander",
};

/** What Claude is expected to return for the commander's headline instruction. */
const headline = (user: string): Interpretation => {
  const expansion = /"id":"(obj_[a-z0-9]+)","title":"Expand petroleum/.exec(user)?.[1] ?? null;
  return {
    kind: "strategic_instruction",
    intentSummary: "Pause expansion; stabilise food, oxygen and power on the second asteroid; send updates.",
    affectedWorldIds: [1],
    explicitModeChange: null,
    recommendedMode: "stabilization",
    recommendedModeReason: "Commander paused expansion to stabilise the outpost.",
    objectiveOps: [
      ...(expansion ? [{ op: "pause" as const, objectiveId: expansion, title: null, description: null, worldId: null, priority: null, completionCriteria: null, criteria: null, constraints: null, dependencies: null, reason: "Expansion paused by commander" }] : []),
      { op: "create", objectiveId: null, title: "Stabilize food on Sim Verdant Outpost", description: "Restore food reserves", worldId: 1, priority: 2, completionCriteria: "Food runway ≥ 10 cycles", criteria: [{ metric: "foodRunwayCycles", worldId: 1, op: ">=", value: 10 }], constraints: [], dependencies: [], reason: "Commander focus" },
      { op: "create", objectiveId: null, title: "Stabilize power on Sim Verdant Outpost", description: "Restore battery charge", worldId: 1, priority: 2, completionCriteria: "Battery ≥ 50%", criteria: [{ metric: "batteryPct", worldId: 1, op: ">=", value: 50 }], constraints: [], dependencies: [], reason: "Commander focus" },
      { op: "create", objectiveId: null, title: "Bogus world objective", description: "", worldId: 999, priority: 9, completionCriteria: null, criteria: null, constraints: null, dependencies: ["obj_doesnotexist"], reason: "validation test" },
    ],
    conflicts: [],
    investigations: [{ topic: "Why is the outpost unstable?", worldId: 1 }],
    actionPermission: { granted: false, scope: null },
    keepCommanderUpdated: true,
    reply: "Understood. Expansion is paused; I'm prioritising food, oxygen and power on Sim Verdant Outpost and will report progress.",
  };
};

async function setup(llm: StructuredLlm | null, simulatedLlm: StructuredLlm | null = null) {
  const dir = mkdir();
  const collector = new Collector({ url, dataDir: dir, coreIntervalMs: 50, mediumIntervalMs: 0, slowIntervalMs: 0, historyIntervalMs: 0, requestSpacingMs: 0, thresholds: { ...DEFAULT_THRESHOLDS, persistEvaluations: 1 } });
  const store = new OpsStore(dir);
  const mem = new Mem();
  const agent = new OperationsAgent({ collector, store, llm, simulatedLlm, notifier: new Notifier(store, [mem]), tickMs: 1_000_000 });
  agents.push(agent);
  await collector.tick();
  await agent.observe(collector.getState()); // prime alert state
  return { dir, collector, store, agent, mem };
}

describe("Commander instruction pipeline (scripted Claude test double)", () => {
  it("receives, interprets, updates objectives without discarding unrelated ones, and replies", async () => {
    const llm = new ScriptedLlm(headline, ANALYSIS);
    const { store, agent, collector } = await setup(llm);
    // Pre-existing objectives: one related (expansion) and one unrelated.
    store.mutate((s) => {
      s.objectives.push({ id: "obj_aaaaaaaaaaaaaaaa", title: "Expand petroleum industry", description: "", worldId: 0, worldName: "Sim Terra Prime", priority: 4, status: "active", createdAt: 1, updatedAt: 1, createdBy: "commander", completionCriteria: "", criteria: [], dependencies: [], constraints: [], progress: null, progressNote: null, metStreak: 0, sourceCommandId: null, history: [] });
      s.objectives.push({ id: "obj_bbbbbbbbbbbbbbbb", title: "Research advanced power", description: "", worldId: null, worldName: null, priority: 4, status: "active", createdAt: 1, updatedAt: 1, createdBy: "commander", completionCriteria: "", criteria: [], dependencies: [], constraints: [], progress: null, progressNote: null, metStreak: 0, sourceCommandId: null, history: [] });
    });
    const text = "Forget expansion for now. Our second asteroid is becoming unstable. Focus on food, oxygen, and power. Keep me updated.";
    const r = agent.submit({ clientId: "cmd-headline-1", type: "instruction", payload: { text }, issuedBy: "phone", clientCreatedAt: Date.now() });
    expect(r.duplicate).toBe(false);
    expect(r.command.status).toBe("received"); // acknowledged immediately
    await agent.tick();

    const cmd = store.getCommand("cmd-headline-1")!;
    expect(cmd.status).toBe("completed");
    const prompt = llm.prompts.find((p) => p.purpose === "interpret")!.user;
    expect(prompt).toContain(text);
    expect(prompt).toContain("Sim Verdant Outpost"); // world list for resolving "second asteroid"
    expect(prompt).toContain("obj_aaaaaaaaaaaaaaaa"); // existing objectives offered for update

    const st = agent.getState();
    expect(st.objectives.find((o) => o.id === "obj_aaaaaaaaaaaaaaaa")!.status).toBe("paused");
    expect(st.objectives.find((o) => o.id === "obj_bbbbbbbbbbbbbbbb")!.status).toBe("active"); // unrelated: untouched
    const food = st.objectives.find((o) => o.title.startsWith("Stabilize food"))!;
    expect(food.priority).toBe(2);
    expect(food.worldId).toBe(1);
    expect(food.criteria[0]!.metric).toBe("foodRunwayCycles");
    const bogus = st.objectives.find((o) => o.title === "Bogus world objective")!;
    expect(bogus.worldId).toBeNull(); // invalid world rejected
    expect(bogus.priority).toBe(5); // clamped
    expect(bogus.dependencies).toEqual([]); // unknown dependency dropped
    expect(st.recommendations.some((x) => x.kind === "mode_change" && x.mode === "stabilization" && x.status === "pending")).toBe(true);
    expect(st.mode.mode).toBe("commander"); // not silently changed
    expect(st.agentSettings.keepCommanderUpdated).toBe(true);
    expect(st.investigations.some((i) => i.topic.includes("outpost") && i.worldId === 1)).toBe(true);
    const reply = st.messages.find((m) => m.from === "claude" && m.commandClientId === "cmd-headline-1")!;
    expect(reply.text).toMatch(/Expansion is paused/);
    // "Keep me updated" → an immediate status report follows the confirmation.
    expect(st.messages.some((m) => m.kind === "report")).toBe(true);
    expect(reply.degraded).toBeFalsy();

    // Investigation runs on the next tick with read-only evidence, producing a proposal (never executed).
    await agent.tick();
    const inv = agent.getState().investigations.find((i) => i.trigger === "commander")!;
    expect(inv.status).toBe("concluded");
    const prop = agent.getState().proposals[0]!;
    expect(prop.status).toBe("proposed");

    // Approving it records approval but does not execute (Level 1).
    agent.submit({ clientId: "cmd-approve-1", type: "proposal.decide", payload: { id: prop.id, decision: "approve" }, issuedBy: "phone", clientCreatedAt: null });
    await agent.tick();
    const after = agent.getState().proposals.find((p) => p.id === prop.id)!;
    expect(after.status).toBe("approved");
    expect(after.executionNote).toMatch(/not executed/i);
    expect(store.readAudit().some((e) => e.event === "proposal.approved")).toBe(true);
    void collector;
  });

  it("never processes a re-sent command twice", async () => {
    const llm = new ScriptedLlm(headline, ANALYSIS);
    const { agent, store } = await setup(llm);
    for (let i = 0; i < 3; i++) agent.submit({ clientId: "cmd-dup-1234", type: "instruction", payload: { text: "Focus on food" }, issuedBy: "phone", clientCreatedAt: 1 });
    await agent.tick();
    agent.submit({ clientId: "cmd-dup-1234", type: "instruction", payload: { text: "Focus on food" }, issuedBy: "phone", clientCreatedAt: 1 });
    await agent.tick();
    expect(llm.prompts.filter((p) => p.purpose === "interpret")).toHaveLength(1);
    expect(store.recentMessages().filter((m) => m.from === "commander")).toHaveLength(1);
  });

  it("defers instructions while Claude is unavailable and processes them when it returns", async () => {
    const llm = new ScriptedLlm(headline, ANALYSIS);
    llm.up = false;
    const { agent, store } = await setup(llm);
    agent.submit({ clientId: "cmd-defer-1", type: "instruction", payload: { text: "Focus on food" }, issuedBy: "phone", clientCreatedAt: 1 });
    await agent.tick();
    expect(store.getCommand("cmd-defer-1")!.status).toBe("deferred");
    expect(store.recentMessages().some((m) => m.from === "system" && /queued/.test(m.text))).toBe(true);
    llm.up = true;
    await agent.tick(Date.now() + 120_000);
    expect(store.getCommand("cmd-defer-1")!.status).toBe("completed");
  });

  it("rejects permission levels 2/3 and keeps the system at Observation", async () => {
    const { agent, store } = await setup(null);
    agent.submit({ clientId: "cmd-perm-3", type: "permission.set", payload: { level: 3 }, issuedBy: "phone", clientCreatedAt: null });
    await agent.tick();
    expect(store.getCommand("cmd-perm-3")!.status).toBe("failed");
    expect(agent.getState().permissionLevel).toBe(1);
  });

  it("applies commander mode changes and controls without Claude", async () => {
    const { agent } = await setup(null);
    agent.submit({ clientId: "cmd-mode-1", type: "mode.set", payload: { mode: "survival" }, issuedBy: "phone", clientCreatedAt: null });
    await agent.tick();
    expect(agent.getState().mode).toMatchObject({ mode: "survival", setBy: "commander" });
  });

  it("recommends Survival on life-support emergencies but never switches by itself", async () => {
    const { agent, collector } = await setup(null);
    const dash = collector.getState();
    const starving = { id: "starving:1", rule: "starving", severity: "CRITICAL", status: "active", title: "Duplicants are starving", worldId: 1, worldName: "Sim Verdant Outpost", what: "", why: "", urgency: "", actions: [], evidence: {}, firstSeen: Date.now(), lastSeen: Date.now(), resolvedAt: null, acknowledged: false, dismissed: false } as const;
    await agent.observe({ ...dash, alerts: [...dash.alerts, { ...starving, actions: [] }] });
    const st = agent.getState();
    expect(st.mode.mode).toBe("commander");
    const rec = st.recommendations.find((r) => r.mode === "survival" && r.status === "pending");
    expect(rec).toBeTruthy();
    expect(rec!.conflict).toBeTruthy();
    agent.submit({ clientId: "cmd-accept-1", type: "recommendation.decide", payload: { id: rec!.id, decision: "accept" }, issuedBy: "phone", clientCreatedAt: null });
    await agent.tick();
    expect(agent.getState().mode.mode).toBe("survival");
  });

  it("labels the simulated interpreter as simulated (demo mode only)", async () => {
    const { agent, store } = await setup(null, new SimulatedLlm());
    agent.submit({ clientId: "cmd-sim-1", type: "instruction", payload: { text: "Forget expansion for now. Focus on food, oxygen, and power on the second asteroid. Keep me updated." }, issuedBy: "phone", clientCreatedAt: null });
    await agent.tick();
    const reply = store.recentMessages().filter((m) => m.from === "claude").pop()!;
    expect(reply.degraded).toBe(true);
    expect(reply.text).toMatch(/SIMULATED/);
    expect(agent.getState().objectives.some((o) => o.worldId === 1 && /food/i.test(o.title))).toBe(true);
  });

  it("does not observe or investigate on stale data, and says so", async () => {
    const { agent, collector, mem } = await setup(null);
    const dead = new Collector({ url: "http://127.0.0.1:1/mcp/", dataDir: mkdir(), requestSpacingMs: 0 });
    const st = dead.getState();
    await agent.observe(st, Date.now());
    await agent.observe(st, Date.now() + 200_000);
    expect(mem.sent.some((n) => n.category === "game_disconnected")).toBe(true);
    agent.submit({ clientId: "cmd-report-x", type: "report.request", payload: {}, issuedBy: "p", clientCreatedAt: null });
    void collector;
  });
});
