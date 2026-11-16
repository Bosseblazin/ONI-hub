import { describe, expect, it } from "vitest";
import { AlertEngine } from "@/lib/alerts/engine";
import * as R from "@/lib/alerts/rules";
import type { RuleContext } from "@/lib/alerts/rules";
import { DEFAULT_THRESHOLDS as TH } from "@/lib/model/thresholds";
import type { Trend } from "@/lib/model/types";
import { dupe, NOW, snap, world } from "./fixtures";

const ctx = (s = snap([world()]), trends: Record<string, Partial<Trend>> = {}, prev: RuleContext["prev"] = null): RuleContext => ({
  snap: s, prev, th: TH, now: NOW,
  trend: (w, f) => (trends[`${w}|${f}`] ? ({ field: f, worldId: w, slopePerCycle: null, direction: "unknown", samples: 10, spanCycles: 1, r2: 0.9, reliable: true, reason: "test", ...trends[`${w}|${f}`] } as Trend) : undefined),
});
const only = (r: R.RuleResult[]) => r.map((x) => x.candidate).filter(Boolean);

describe("food rules", () => {
  it("is CRITICAL below the critical runway", () => {
    const c = only(R.foodRunwayRule(ctx(snap([world({ foodKcal: 8000 })])))); // 4 dupes → 2 cycles
    expect(c[0]?.severity).toBe("CRITICAL");
    expect(c[0]?.evidence.demandRunwayCycles).toBe(2);
    expect(c[0]?.assumptions?.join(" ")).toMatch(/1000 kcal/);
  });
  it("is WARNING between thresholds and silent above", () => {
    expect(only(R.foodRunwayRule(ctx(snap([world({ foodKcal: 20_000 })]))))[0]?.severity).toBe("WARNING");
    expect(only(R.foodRunwayRule(ctx(snap([world({ foodKcal: 50_000 })]))))).toHaveLength(0);
  });
  it("does not alarm when food is reliably increasing (avoid false alarms)", () => {
    expect(only(R.foodRunwayRule(ctx(snap([world({ foodKcal: 8000 })]), { "0|kcal": { direction: "increasing", slopePerCycle: 3000 } })))).toHaveLength(0);
  });
  it("skips stale food data entirely (no scope reported)", () => {
    const w = world({ foodKcal: 1000 });
    w.meta.food = { fetchedAt: NOW - 3600_000, error: null };
    expect(R.foodRunwayRule(ctx(snap([w])))).toHaveLength(0);
  });
  it("warns when production falls behind consumption", () => {
    const c = only(R.foodTrendRule(ctx(snap([world({ foodKcal: 30_000 })]), { "0|kcal": { direction: "decreasing", slopePerCycle: -5000 } })));
    expect(c[0]?.title).toMatch(/falling behind/);
  });
  it("ignores uninhabited worlds", () => {
    expect(R.foodRunwayRule(ctx(snap([world({ dupes: [], population: 0, foodKcal: 0 })])))).toHaveLength(0);
  });
});

describe("duplicant rules", () => {
  it("flags starving duplicants as CRITICAL", () => {
    const w = world({ dupes: [dupe({ name: "S", starving: true, hungry: true, caloriesKcal: 50 }), dupe(), dupe()] });
    expect(only(R.starvationRule(ctx(snap([w]))))[0]?.severity).toBe("CRITICAL");
  });
  it("flags multiple incapacitated as CRITICAL, one as WARNING", () => {
    const two = world({ dupes: [dupe({ incapacitated: true }), dupe({ incapacitated: true }), dupe()] });
    const one = world({ dupes: [dupe({ incapacitated: true }), dupe(), dupe()] });
    expect(only(R.incapacitatedRule(ctx(snap([two]))))[0]?.severity).toBe("CRITICAL");
    expect(only(R.incapacitatedRule(ctx(snap([one]))))[0]?.severity).toBe("WARNING");
  });
  it("detects insufficient labour", () => {
    const w = world({ dupes: [dupe({ incapacitated: true }), dupe({ starving: true }), dupe({ risk: "critical" }), dupe()] });
    expect(only(R.workforceRule(ctx(snap([w]))))[0]?.evidence.available).toBe(1);
  });
});

describe("oxygen and power rules", () => {
  it("oxygen CRITICAL when per-dupe O2 is tiny", () => {
    const w = world({ atmosphere: { oxygenKg: 20, co2Kg: 500, breathableCells: 10, visibleCells: 1000 } });
    expect(only(R.oxygenRule(ctx(snap([w]))))[0]?.severity).toBe("CRITICAL");
  });
  it("oxygen production insufficient when the trend projects depletion", () => {
    const w = world({ atmosphere: { oxygenKg: 1000, co2Kg: 50, breathableCells: 500, visibleCells: 1000 } }); // 250 kg/dupe: fine on level
    const c = only(R.oxygenRule(ctx(snap([w]), { "0|o2": { direction: "decreasing", slopePerCycle: -300 } })));
    expect(c[0]?.title).toMatch(/insufficient/);
  });
  const power = (p: Partial<NonNullable<ReturnType<typeof world>["power"]>>) => ({
    generatorCount: 2, generatorOperational: 2, generatorEmpty: 0, generatorRatedW: 1600, consumerCount: 10, consumerPowered: 10, consumerUsedW: 900,
    consumerNeededW: 1200, batteryCount: 2, batteryCapacityJ: 40000, batteryStoredJ: 20000, batteryPct: 50, netActiveW: 400, unconnectedConsumers: 0, ...p,
  });
  it("battery: no alert for a low but stable battery", () => {
    expect(only(R.batteryRule(ctx(snap([world({ power: power({ batteryPct: 15 }) })]))))).toHaveLength(0);
  });
  it("battery: WARNING when low and draining, CRITICAL when nearly empty with brownouts", () => {
    const tr = { "0|battJ": { direction: "decreasing" as const, slopePerCycle: -10_000 } };
    expect(only(R.batteryRule(ctx(snap([world({ power: power({ batteryPct: 15 }) })]), tr)))[0]?.severity).toBe("WARNING");
    expect(only(R.batteryRule(ctx(snap([world({ power: power({ batteryPct: 2, consumerPowered: 4 }) })]))))[0]?.severity).toBe("CRITICAL");
  });
  it("power deficit when generators are all down", () => {
    expect(only(R.powerDeficitRule(ctx(snap([world({ power: power({ generatorOperational: 0 }) })]))))[0]?.title).toMatch(/exceeds/);
  });
});

describe("stock rules", () => {
  it("coal declining rapidly", () => {
    const w = world();
    w.resources.coal = { key: "coal", stored: 2000, free: null, total: 2000 };
    const c = only(R.coalRule(ctx(snap([w]), { "0|coal": { direction: "decreasing", slopePerCycle: -1000 } })));
    expect(c[0]?.title).toMatch(/Coal reserves declining/);
  });
  it("coal stable → no alert", () => {
    const w = world();
    w.resources.coal = { key: "coal", stored: 2000, free: null, total: 2000 };
    expect(only(R.coalRule(ctx(snap([w]), { "0|coal": { direction: "stable", slopePerCycle: -1 } })))).toHaveLength(0);
  });
  it("water below minimum even without a trend decline", () => {
    const w = world();
    w.resources.water = { key: "water", stored: 500, free: 100, total: 600 };
    const c = only(R.waterRule(ctx(snap([w]), { "0|water": { direction: "stable", slopePerCycle: 0 } })));
    expect(c[0]?.title).toMatch(/below configured minimum/);
  });
});

describe("rocket interiors", () => {
  it("do not get the asteroid water-minimum warning", () => {
    const w = world({ kind: "rocket" });
    w.resources.water = { key: "water", stored: 0, free: 0, total: 0 };
    expect(only(R.waterRule(ctx(snap([w]), { "0|water": { direction: "stable", slopePerCycle: 0 } })))).toHaveLength(0);
  });
});

describe("informational events", () => {
  it("reports new worlds and generators only relative to a previous snapshot", () => {
    const prev = snap([world({ power: { generatorOperational: 1, generatorCount: 2 } as never })]);
    const cur = snap([
      world({ power: { generatorOperational: 2, generatorCount: 2 } as never }),
      world({ id: 5, name: "New Rock", dupes: [], population: 0, settled: false }),
    ]);
    const ids = only(R.infoEventsRule(ctx(cur, {}, prev))).map((c) => c!.rule);
    expect(ids).toContain("generator-online");
    expect(ids).toContain("world-discovered");
    expect(R.infoEventsRule(ctx(cur, {}, null))).toHaveLength(0);
  });
});

describe("AlertEngine hysteresis", () => {
  const lowFood = snap([world({ foodKcal: 8000 })]);
  const okFood = snap([world({ foodKcal: 80_000 })]);
  it("requires persistence before raising and clear streak before resolving", () => {
    const e = new AlertEngine([R.foodRunwayRule]);
    expect(e.evaluate(ctx(lowFood)).filter((a) => a.status === "active")).toHaveLength(0);
    expect(e.evaluate(ctx(lowFood)).filter((a) => a.status === "active")).toHaveLength(1);
    e.evaluate(ctx(okFood));
    e.evaluate(ctx(okFood));
    expect(e.list()[0]!.status).toBe("active");
    e.evaluate(ctx(okFood));
    expect(e.list()[0]!.status).toBe("resolved");
  });
  it("stale data neither raises nor resolves", () => {
    const e = new AlertEngine([R.foodRunwayRule]);
    e.evaluate(ctx(lowFood));
    e.evaluate(ctx(lowFood));
    const stale = world({ foodKcal: 80_000 });
    stale.meta.food = { fetchedAt: NOW - 3600_000, error: "x" };
    for (let i = 0; i < 5; i++) e.evaluate(ctx(snap([stale])));
    expect(e.list()[0]!.status).toBe("active");
  });
  it("dismiss hides until severity escalates", () => {
    const e = new AlertEngine([R.foodRunwayRule]);
    const warn = snap([world({ foodKcal: 20_000 })]);
    e.evaluate(ctx(warn));
    e.evaluate(ctx(warn));
    const id = e.list()[0]!.id;
    e.dismiss(id);
    e.evaluate(ctx(warn));
    expect(e.list()[0]!.dismissed).toBe(true);
    e.evaluate(ctx(lowFood));
    expect(e.list()[0]!.severity).toBe("CRITICAL");
    expect(e.list()[0]!.dismissed).toBe(false);
  });
  it("survives a throwing rule", () => {
    const e = new AlertEngine([() => { throw new Error("boom"); }, R.foodRunwayRule]);
    e.evaluate(ctx(lowFood));
    expect(() => e.evaluate(ctx(lowFood))).not.toThrow();
    expect(e.list()).toHaveLength(1);
  });
  it("round-trips state", () => {
    const e = new AlertEngine([R.foodRunwayRule]);
    e.evaluate(ctx(lowFood));
    e.evaluate(ctx(lowFood));
    e.acknowledge(e.list()[0]!.id);
    const e2 = new AlertEngine([R.foodRunwayRule], e.toState());
    expect(e2.list()[0]!.acknowledged).toBe(true);
  });
});
