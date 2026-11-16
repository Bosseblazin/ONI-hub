import { describe, expect, it } from "vitest";
import { GameClock } from "@/lib/calc/clock";
import { computeTrend, foodDemandRunway, linearRegression, runwayFromTrend, confidenceFrom } from "@/lib/calc/trend";
import type { HistorySample } from "@/lib/model/types";
import { DEFAULT_THRESHOLDS as TH } from "@/lib/model/thresholds";

const sample = (c: number, kcal: number | null, w = 0): HistorySample => ({
  t: c * 1000, c, w, pop: 4, kcal, o2: null, co2: null, water: null, dirtyWater: null, coal: null, petroleum: null, crude: null, gas: null,
  metal: null, stone: null, plastic: null, battPct: null, battJ: null, genW: null, useW: null, needW: null, avgT: null, maxT: null,
});

describe("linearRegression", () => {
  it("fits an exact line", () => {
    const r = linearRegression([{ c: 0, v: 10 }, { c: 1, v: 8 }, { c: 2, v: 6 }])!;
    expect(r.slope).toBeCloseTo(-2);
    expect(r.intercept).toBeCloseTo(10);
    expect(r.r2).toBeCloseTo(1);
  });
  it("returns null for degenerate input", () => {
    expect(linearRegression([{ c: 1, v: 1 }])).toBeNull();
    expect(linearRegression([{ c: 1, v: 1 }, { c: 1, v: 2 }])).toBeNull();
  });
});

describe("computeTrend", () => {
  it("refuses to trend with too few samples", () => {
    const t = computeTrend([sample(1, 100), sample(1.1, 90)], "kcal", 0, TH);
    expect(t.reliable).toBe(false);
    expect(t.direction).toBe("unknown");
    expect(t.reason).toMatch(/Need 6 samples/);
  });
  it("refuses to trend over too little game time (e.g. paused game)", () => {
    const s = Array.from({ length: 10 }, (_, i) => sample(5 + i * 0.01, 1000 - i));
    const t = computeTrend(s, "kcal", 0, TH);
    expect(t.reliable).toBe(false);
    expect(t.reason).toMatch(/cycles of unpaused game time/);
  });
  it("detects a decreasing trend and a runway", () => {
    const s = Array.from({ length: 12 }, (_, i) => sample(10 + i * 0.1, 10_000 - i * 0.1 * 2000));
    const t = computeTrend(s, "kcal", 0, TH);
    expect(t.reliable).toBe(true);
    expect(t.direction).toBe("decreasing");
    expect(t.slopePerCycle).toBeCloseTo(-2000, 0);
    const last = s[s.length - 1]!.kcal!;
    expect(runwayFromTrend(last, t)).toBeCloseTo(last / 2000, 1);
    expect(confidenceFrom(t)).toBe("medium");
  });
  it("calls a flat series stable and gives no runway", () => {
    const s = Array.from({ length: 12 }, (_, i) => sample(10 + i * 0.1, 5000 + (i % 2)));
    const t = computeTrend(s, "kcal", 0, TH);
    expect(t.direction).toBe("stable");
    expect(runwayFromTrend(5000, t)).toBeNull();
  });
  it("ignores other worlds and null values", () => {
    const s = [...Array.from({ length: 8 }, (_, i) => sample(i * 0.1, null)), ...Array.from({ length: 8 }, (_, i) => sample(i * 0.1, 50, 1))];
    expect(computeTrend(s, "kcal", 0, TH).samples).toBe(0);
  });
});

describe("foodDemandRunway", () => {
  it("divides stock by population demand", () => {
    expect(foodDemandRunway(8000, 4, 1000)).toBe(2);
  });
  it("is null with no population or unknown stock", () => {
    expect(foodDemandRunway(8000, 0, 1000)).toBeNull();
    expect(foodDemandRunway(null, 3, 1000)).toBeNull();
  });
});

describe("GameClock", () => {
  it("integrates wall time × speed and clamps to the reported cycle", () => {
    const c = new GameClock();
    expect(c.update({ cycle: 10, speed: 1, paused: false, wallMs: 0 }).estCycles).toBe(10);
    // 60 wall-seconds at speed 1 = 0.1 cycle
    expect(c.update({ cycle: 10, speed: 1, paused: false, wallMs: 60_000 }).estCycles).toBeCloseTo(10.1);
    // paused: speed 0 recorded, so the next interval adds nothing
    c.update({ cycle: 10, speed: 0, paused: true, wallMs: 90_000 });
    expect(c.update({ cycle: 10, speed: 0, paused: true, wallMs: 120_000 }).estCycles).toBeCloseTo(10.15);
  });
  it("snaps forward when the integer cycle advances", () => {
    const c = new GameClock();
    c.update({ cycle: 3, speed: 1, paused: false, wallMs: 0 });
    expect(c.update({ cycle: 4, speed: 1, paused: false, wallMs: 1000 }).estCycles).toBe(4);
  });
  it("flags a discontinuity when the cycle goes backwards (save reload)", () => {
    const c = new GameClock();
    c.update({ cycle: 50, speed: 1, paused: false, wallMs: 0 });
    const r = c.update({ cycle: 40, speed: 1, paused: false, wallMs: 5000 });
    expect(r.discontinuity).toBe(true);
    expect(r.estCycles).toBe(40);
  });
});
