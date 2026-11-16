import { foodDemandRunway } from "../calc/trend";
import type { AlertRecord, ColonySnapshot, Thresholds } from "../model/types";
import { newId } from "./ids";
import type { Criterion, CriterionMetric, Objective, ObjectiveStatus, OperatingMode, PriorityLevel } from "./types";

export const CRITERION_METRICS: Record<CriterionMetric, { label: string; unit: string }> = {
  foodRunwayCycles: { label: "Food runway", unit: "cycles" },
  oxygenKgPerDupe: { label: "Free O₂ per duplicant", unit: "kg" },
  batteryPct: { label: "Battery charge", unit: "%" },
  powerHeadroomW: { label: "Rated generation − live draw", unit: "W" },
  waterKg: { label: "Water", unit: "kg" },
  coalKg: { label: "Coal", unit: "kg" },
  incapacitated: { label: "Incapacitated duplicants", unit: "" },
  starving: { label: "Starving duplicants", unit: "" },
  maxStressPct: { label: "Highest stress", unit: "%" },
  generatorsOperational: { label: "Operational generators", unit: "" },
  population: { label: "Population", unit: "" },
  activeCriticalAlerts: { label: "Active CRITICAL alerts", unit: "" },
};

/** Current value of a criterion metric, or null if not measurable right now. */
export function metricValue(
  m: CriterionMetric,
  worldId: number | null,
  snap: ColonySnapshot,
  alerts: AlertRecord[],
  th: Thresholds,
): number | null {
  const worlds = worldId === null ? snap.worlds.filter((w) => w.settled) : snap.worlds.filter((w) => w.id === worldId);
  if (!worlds.length) return null;
  const sum = (f: (w: (typeof worlds)[number]) => number | null) => {
    const v = worlds.map(f);
    return v.some((x) => x === null) ? null : (v as number[]).reduce((a, b) => a + b, 0);
  };
  const min = (f: (w: (typeof worlds)[number]) => number | null) => {
    const v = worlds.map(f).filter((x): x is number => x !== null);
    return v.length ? Math.min(...v) : null;
  };
  switch (m) {
    case "foodRunwayCycles":
      return min((w) => (w.population > 0 ? foodDemandRunway(w.foodKcal, w.population, th.kcalPerDupePerCycle) : null));
    case "oxygenKgPerDupe":
      return min((w) => (w.population > 0 && w.atmosphere ? w.atmosphere.oxygenKg / w.population : null));
    case "batteryPct":
      return min((w) => (w.power && w.power.batteryCount > 0 ? w.power.batteryPct : null));
    case "powerHeadroomW":
      return min((w) => (w.power && w.power.consumerCount > 0 ? w.power.generatorRatedW - w.power.consumerUsedW : null));
    case "waterKg":
      return sum((w) => w.resources.water.total);
    case "coalKg":
      return sum((w) => w.resources.coal.total);
    case "incapacitated":
      return sum((w) => w.dupes.filter((d) => d.incapacitated).length);
    case "starving":
      return sum((w) => w.dupes.filter((d) => d.starving).length);
    case "maxStressPct": {
      const s = worlds.flatMap((w) => w.dupes.map((d) => d.stressPct));
      return s.length ? Math.max(...s) : null;
    }
    case "generatorsOperational":
      return sum((w) => w.power?.generatorOperational ?? null);
    case "population":
      return sum((w) => w.population);
    case "activeCriticalAlerts":
      return alerts.filter((a) => a.status === "active" && a.severity === "CRITICAL" && (worldId === null || a.worldId === worldId)).length;
  }
}

export function criterionMet(c: Criterion, v: number | null): boolean | null {
  if (v === null) return null;
  return c.op === ">=" ? v >= c.value : v <= c.value;
}

/** 0–100 closeness for one criterion; unknown → null. Conservative: a met criterion is 100. */
function closeness(c: Criterion, v: number | null): number | null {
  if (v === null) return null;
  if (criterionMet(c, v)) return 100;
  if (c.op === ">=") return c.value <= 0 ? 0 : Math.max(0, Math.min(99, (v / c.value) * 100));
  // "<=" target: e.g. incapacitated <= 0. Distance relative to (value + 1) keeps it bounded.
  return Math.max(0, Math.min(99, 100 - ((v - c.value) / (Math.abs(c.value) + Math.max(1, v))) * 100));
}

export const COMPLETION_STREAK = 3;

/**
 * Update progress for active objectives with machine-checkable criteria. Completion requires all
 * criteria to hold for COMPLETION_STREAK consecutive evaluations. Returns objectives that just completed.
 */
export function evaluateObjectives(objs: Objective[], snap: ColonySnapshot, alerts: AlertRecord[], th: Thresholds, now: number): Objective[] {
  const done: Objective[] = [];
  for (const o of objs) {
    if (o.status !== "active" || o.criteria.length === 0) continue;
    const vals = o.criteria.map((c) => metricValue(c.metric, c.worldId, snap, alerts, th));
    const met = o.criteria.map((c, i) => criterionMet(c, vals[i]!));
    const cl = o.criteria.map((c, i) => closeness(c, vals[i]!));
    if (cl.every((x) => x !== null)) {
      o.progress = Math.round((cl as number[]).reduce((a, b) => a + b, 0) / cl.length);
      o.progressNote = o.criteria
        .map((c, i) => `${CRITERION_METRICS[c.metric].label} ${fmtNum(vals[i]!)} ${c.op} ${c.value}${CRITERION_METRICS[c.metric].unit ? " " + CRITERION_METRICS[c.metric].unit : ""} ${met[i] ? "✓" : "✗"}`)
        .join(" · ");
    }
    if (met.every((x) => x === true)) {
      o.metStreak++;
      if (o.metStreak >= COMPLETION_STREAK) {
        o.status = "completed";
        o.updatedAt = now;
        o.history.push({ at: now, by: "agent", note: `Completion criteria met for ${COMPLETION_STREAK} consecutive checks: ${o.progressNote}` });
        done.push(o);
      }
    } else o.metStreak = 0;
  }
  return done;
}

const fmtNum = (v: number | null) => (v === null ? "N/A" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1));

export interface ObjectiveDraft {
  title: string;
  description: string;
  worldId: number | null;
  priority: PriorityLevel;
  completionCriteria: string;
  criteria: Criterion[];
  dependencies: string[];
  constraints: string[];
}

export function createObjective(d: ObjectiveDraft, by: Objective["createdBy"], worldName: string | null, sourceCommandId: string | null, now = Date.now()): Objective {
  return {
    id: newId("obj"),
    title: d.title.slice(0, 160),
    description: d.description.slice(0, 1200),
    worldId: d.worldId,
    worldName,
    priority: d.priority,
    status: "active",
    createdAt: now,
    updatedAt: now,
    createdBy: by,
    completionCriteria: d.completionCriteria.slice(0, 600),
    criteria: d.criteria.slice(0, 6),
    dependencies: d.dependencies,
    constraints: d.constraints.slice(0, 10),
    progress: null,
    progressNote: null,
    metStreak: 0,
    sourceCommandId,
    history: [{ at: now, by: by === "commander" ? "commander" : "claude", note: "Created" }],
  };
}

export function updateObjective(
  o: Objective,
  patch: Partial<{ priority: PriorityLevel; status: ObjectiveStatus; description: string; constraints: string[]; completionCriteria: string; criteria: Criterion[]; title: string }>,
  by: "commander" | "claude" | "agent",
  note: string,
  now = Date.now(),
): void {
  const changes: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const before = (o as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(before) === JSON.stringify(v)) continue;
    (o as unknown as Record<string, unknown>)[k] = v;
    changes.push(k === "priority" || k === "status" ? `${k}: ${String(before)} → ${String(v)}` : k);
  }
  if (!changes.length) return;
  if (patch.criteria) o.metStreak = 0;
  o.updatedAt = now;
  o.history.push({ at: now, by, note: `${note}${note ? " — " : ""}${changes.join(", ")}` });
  if (o.history.length > 50) o.history.splice(0, o.history.length - 50);
}

/** Active objectives sorted by priority, then age. */
export function rankObjectives(objs: Objective[]): Objective[] {
  return objs
    .filter((o) => o.status === "active" || o.status === "blocked" || o.status === "proposed")
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

/* --------------------------------------------------------------------- modes */

export const MODES: Record<OperatingMode, { label: string; focus: string[]; defer: string[]; summary: string }> = {
  survival: {
    label: "Survival",
    focus: ["food", "oxygen", "water", "power", "duplicant health"],
    defer: ["expansion", "new industries", "rocketry", "non-essential construction", "printing new duplicants"],
    summary: "Keep duplicants alive. Life support first; defer expansion and non-essential construction.",
  },
  stabilization: {
    label: "Stabilization",
    focus: ["repair unreliable infrastructure", "build reserves (food, water, power, fuel)", "temperature control"],
    defer: ["large new projects", "rocketry"],
    summary: "Fix what is fragile and build buffers before growing.",
  },
  expansion: {
    label: "Expansion",
    focus: ["new infrastructure and industries", "outposts on other asteroids", "production chains"],
    defer: [],
    summary: "Grow the colony: new industries, infrastructure and outposts.",
  },
  exploration: {
    label: "Exploration",
    focus: ["rockets", "space exploration", "remote resource acquisition"],
    defer: ["non-essential base projects"],
    summary: "Rockets, exploration and acquiring resources from space.",
  },
  commander: {
    label: "Commander-Directed",
    focus: ["the commander's explicit objectives"],
    defer: [],
    summary: "Follow the commander's explicit strategic instructions; recommend, never override.",
  },
};

/**
 * Should Claude recommend Survival mode? Only on sustained life-threatening alerts, and never
 * when the commander already chose Survival.
 */
export function survivalRecommended(mode: OperatingMode, alerts: AlertRecord[]): { recommend: boolean; reason: string } {
  if (mode === "survival") return { recommend: false, reason: "" };
  const life = new Set(["starving", "suffocating", "incapacitated", "oxygen", "food-runway", "workforce", "battery"]);
  const crit = alerts.filter((a) => a.status === "active" && a.severity === "CRITICAL" && life.has(a.rule));
  if (crit.length === 0) return { recommend: false, reason: "" };
  return {
    recommend: true,
    reason: `${crit.length} life-support CRITICAL alert(s): ${crit.slice(0, 4).map((a) => `${a.title} (${a.worldName ?? "colony"})`).join("; ")}.`,
  };
}
