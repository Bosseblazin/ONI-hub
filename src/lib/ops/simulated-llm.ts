import type { Analysis } from "./analyst";
import type { Interpretation } from "./interpreter";
import type { LlmCall, LlmResult, StructuredLlm } from "./llm";

/**
 * SIMULATED stand-in for Claude, used only in demo mode (connected to the OniMcp simulator) and tests.
 * Deterministic keyword rules, not AI. Every message it produces is labelled as simulated by the agent.
 */
export class SimulatedLlm implements StructuredLlm {
  readonly name = "simulated-interpreter";
  readonly simulated = true;
  calls: string[] = [];

  available(): boolean {
    return true;
  }

  async call<T>(c: LlmCall<T>): Promise<LlmResult<T>> {
    this.calls.push(c.purpose);
    const ctx = extract(c.user, "colony_state") as SimContext | null;
    const data = c.purpose === "interpret" ? interpret(extractText(c.user, "commander_message") ?? "", ctx) : analyse(c.purpose, ctx, extractText(c.user, "task") ?? "");
    return { data: c.schema.parse(data), servedBy: this.name, inputTokens: 0, outputTokens: 0 };
  }
}

interface SimWorld {
  id: number;
  name: string;
  settled: boolean;
  population: number;
  foodRunwayCycles: number | null;
  oxygenFreeKg: number | null;
  batteryPct: number | null;
  dupes: { incapacitated: number; starving: number };
}
interface SimContext {
  worlds: SimWorld[];
  objectives: Array<{ id: string; title: string; worldId: number | null; status: string; priority: string }>;
  activeAlerts: Array<{ severity: string; worldId: number | null; title: string }>;
  operatingMode: { mode: string };
}

function extractText(s: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(s);
  return m ? m[1]!.trim() : null;
}
function extract(s: string, tag: string): unknown {
  const t = extractText(s, tag);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const ORD: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, home: 0, main: 0 };

function resolveWorlds(text: string, ctx: SimContext | null): number[] {
  const settled = (ctx?.worlds ?? []).filter((w) => w.settled);
  const out = new Set<number>();
  const t = text.toLowerCase();
  for (const w of ctx?.worlds ?? []) if (t.includes(w.name.toLowerCase()) || w.name.toLowerCase().split(" ").some((p) => p.length > 4 && t.includes(p))) out.add(w.id);
  for (const [word, idx] of Object.entries(ORD)) if (new RegExp(`\\b${word}\\b`).test(t) && settled[idx]) out.add(settled[idx]!.id);
  return [...out];
}

function interpret(text: string, ctx: SimContext | null): Interpretation {
  const t = text.toLowerCase();
  const worlds = resolveWorlds(text, ctx);
  const wid = worlds[0] ?? null;
  const wname = ctx?.worlds.find((w) => w.id === wid)?.name ?? "the colony";
  const ops: Interpretation["objectiveOps"] = [];
  const base = { objectiveId: null, title: null, description: null, worldId: wid, priority: null, completionCriteria: null, criteria: null, constraints: null, dependencies: null };
  const isQuestion = /\?\s*$/.test(text.trim()) || /^(how|what|why|is|are|when|which)\b/.test(t);
  const investigate = /\binvestigat|find out why|look into\b/.test(t);
  const stopExpansion = /(forget|stop|pause|halt).{0,20}(expan|petroleum|industr)/.test(t);
  const focus = /\b(focus|prioriti[sz]e|stabili[sz]e)\b/.test(t);
  const explicitMode = (["survival", "stabilization", "expansion", "exploration"] as const).find((m) => new RegExp(`\\b${m}\\s+mode\\b`).test(t)) ?? null;

  if (stopExpansion) {
    for (const o of ctx?.objectives ?? []) {
      if (o.status === "active" && /expan|petroleum|industr|rocket/i.test(o.title)) ops.push({ ...base, op: "pause", objectiveId: o.id, worldId: o.worldId, reason: "Commander paused expansion" });
    }
  }
  if (focus) {
    const add = (title: string, metric: "foodRunwayCycles" | "oxygenKgPerDupe" | "batteryPct", value: number, crit: string) =>
      ops.push({ ...base, op: "create", title: `${title} — ${wname}`, description: `Commander directive: ${text}`, priority: 2, completionCriteria: crit, criteria: [{ metric, worldId: wid, op: ">=", value }], constraints: [], dependencies: [], reason: "Commander focus" });
    if (/food/.test(t)) add("Stabilize food production", "foodRunwayCycles", 10, "Food runway of at least 10 cycles");
    if (/oxygen|o2/.test(t)) add("Stabilize oxygen supply", "oxygenKgPerDupe", 50, "At least 50 kg free oxygen per duplicant");
    if (/power|electric/.test(t)) add("Stabilize power", "batteryPct", 50, "Batteries at least 50% charged");
  }
  if (/(don.?t|do not|no).{0,30}(duplicant|printing pod|print)/.test(t)) {
    ops.push({ ...base, op: "create", worldId: null, title: "Population hold", description: text, priority: 3, completionCriteria: "Commander lifts the hold", criteria: [], constraints: ["Do not accept new duplicants from the Printing Pod"], dependencies: [], reason: "Commander constraint" });
  }
  const kind: Interpretation["kind"] = explicitMode ? "mode_change" : ops.length ? "strategic_instruction" : investigate ? "strategic_instruction" : isQuestion ? "information_request" : /recommend|suggest|should i|what would you/.test(t) ? "recommendation_request" : "unclear";
  const survivalRisk = (ctx?.activeAlerts ?? []).some((a) => a.severity === "CRITICAL");
  const recommendedMode = !explicitMode && (stopExpansion || focus) ? (survivalRisk ? "survival" : "stabilization") : null;
  const w = ctx?.worlds.find((x) => x.id === wid);
  const lines = [
    `[SIMULATED interpreter — not Claude] Understood: ${kind.replace(/_/g, " ")}.`,
    ops.length ? `Objective changes: ${ops.map((o) => `${o.op} ${o.title ?? o.objectiveId}`).join("; ")}.` : "",
    recommendedMode ? `I recommend switching to ${recommendedMode} mode — awaiting your approval.` : "",
    investigate || focus ? `Opening an investigation on ${wname}.` : "",
    kind === "information_request" && w ? `${w.name}: pop ${w.population}, food runway ${w.foodRunwayCycles ?? "N/A"} cycles, free O₂ ${w.oxygenFreeKg ?? "N/A"} kg, battery ${w.batteryPct ?? "N/A"}%.` : "",
    "No game actions were taken (Observation level).",
  ].filter(Boolean);
  return {
    kind,
    intentSummary: text.slice(0, 200),
    affectedWorldIds: worlds,
    explicitModeChange: explicitMode,
    recommendedMode,
    recommendedModeReason: recommendedMode ? (survivalRisk ? "Life-support CRITICAL alerts are active." : "Commander asked to pause expansion and stabilise.") : null,
    objectiveOps: ops,
    conflicts: [],
    investigations: investigate || focus ? [{ topic: text.slice(0, 160), worldId: wid }] : [],
    actionPermission: { granted: false, scope: null },
    keepCommanderUpdated: /keep me (updated|posted|informed)/.test(t) ? true : /stop (updating|reporting)/.test(t) ? false : null,
    reply: lines.join("\n"),
  };
}

function analyse(purpose: string, ctx: SimContext | null, task: string): Analysis {
  const crit = (ctx?.activeAlerts ?? []).filter((a) => a.severity === "CRITICAL");
  const worlds = (ctx?.worlds ?? []).filter((w) => w.settled);
  return {
    summary: `[SIMULATED analysis — not Claude] ${purpose === "investigate" ? task.replace(/^Investigate:\s*/, "Investigated: ") + ". " : ""}${crit.length} critical alert(s) active across ${worlds.length} settled worlds.`,
    findings: [
      ...crit.slice(0, 4).map((a) => ({ statement: `${a.title} (world ${a.worldId ?? "colony"})`, basis: "observed" as const })),
      ...worlds.slice(0, 3).map((w) => ({ statement: `${w.name}: food runway ${w.foodRunwayCycles ?? "N/A"} cycles, battery ${w.batteryPct ?? "N/A"}%`, basis: "derived" as const })),
    ],
    recommendations: crit.length ? ["Address the CRITICAL alerts first, starting with food and oxygen."] : ["No critical issues; continue current objectives."],
    proposedActions: crit.length
      ? [{ title: "Raise priority of food-related errands", rationale: "Food reserves are critically low.", category: "priorities", risk: "routine", worldId: crit[0]!.worldId, objectiveId: null, manualSteps: ["Open the Priorities screen", "Set Farming and Cooking to the highest priority for all duplicants"] }]
      : [],
    objectiveNotes: [],
    modeRecommendation: { mode: null, reason: null },
    conclusion: crit.length ? "needs_commander" : "ongoing",
  };
}
