import type { HistoryField, HistorySample, Projection, Thresholds, Trend } from "../model/types";

export interface Point {
  c: number;
  v: number;
}

export function linearRegression(pts: Point[]): { slope: number; intercept: number; r2: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    sx += p.c; sy += p.v; sxx += p.c * p.c; sxy += p.c * p.v; syy += p.v * p.v;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  let ssRes = 0;
  for (const p of pts) ssRes += (p.v - (slope * p.c + intercept)) ** 2;
  const r2 = ssTot <= 1e-12 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/**
 * Trend over the trailing `trendWindowCycles` of game time. "stable" means the
 * projected change across one cycle is within `stableFraction` of the mean level.
 */
export function computeTrend(
  samples: HistorySample[],
  field: HistoryField,
  worldId: number,
  th: Pick<Thresholds, "trendMinSamples" | "trendMinSpanCycles" | "trendWindowCycles">,
  stableFraction = 0.02,
): Trend {
  const base: Omit<Trend, "slopePerCycle" | "direction" | "r2" | "reliable" | "reason"> = {
    field, worldId, samples: 0, spanCycles: 0,
  };
  const ws = samples.filter((s) => s.w === worldId);
  const latest = ws.length ? ws[ws.length - 1]!.c : 0;
  const all: Point[] = [];
  for (const s of ws) {
    const v = s[field];
    if (typeof v === "number" && Number.isFinite(v) && s.c >= latest - th.trendWindowCycles * 4) all.push({ c: s.c, v });
  }
  // Use the trailing window; if a slowly-refreshed metric has too few readings in it, extend back
  // (up to 4x the window) to include at least 2 x trendMinSamples real readings.
  let pts = all.filter((p) => p.c >= latest - th.trendWindowCycles);
  if (pts.length < th.trendMinSamples * 2) pts = all.slice(-th.trendMinSamples * 2);
  const span = pts.length ? pts[pts.length - 1]!.c - pts[0]!.c : 0;
  const out = { ...base, samples: pts.length, spanCycles: span };
  if (pts.length < th.trendMinSamples) {
    return { ...out, slopePerCycle: null, direction: "unknown", r2: null, reliable: false,
      reason: `Need ${th.trendMinSamples} samples, have ${pts.length}` };
  }
  if (span < th.trendMinSpanCycles) {
    return { ...out, slopePerCycle: null, direction: "unknown", r2: null, reliable: false,
      reason: `Need ${th.trendMinSpanCycles} cycles of unpaused game time, have ${span.toFixed(2)}` };
  }
  const reg = linearRegression(pts);
  if (!reg) {
    return { ...out, slopePerCycle: null, direction: "unknown", r2: null, reliable: false, reason: "Degenerate data" };
  }
  const mean = pts.reduce((a, p) => a + p.v, 0) / pts.length;
  const scale = Math.max(Math.abs(mean), 1e-9);
  const rel = Math.abs(reg.slope) / scale;
  const direction = rel <= stableFraction ? "stable" : reg.slope > 0 ? "increasing" : "decreasing";
  return {
    ...out,
    slopePerCycle: reg.slope,
    direction,
    r2: reg.r2,
    reliable: true,
    reason: `Linear fit over ${span.toFixed(2)} cycles, ${pts.length} samples, R²=${reg.r2.toFixed(2)}`,
  };
}

export function confidenceFrom(t: Trend): Projection["confidence"] {
  if (!t.reliable || t.r2 === null) return "insufficient-data";
  if (t.spanCycles >= 1.5 && t.r2 >= 0.8) return "high";
  if (t.spanCycles >= 0.5 && t.r2 >= 0.5) return "medium";
  return "low";
}

/** Cycles until `current` reaches zero at the trend slope. null if not declining. */
export function runwayFromTrend(current: number | null, t: Trend): number | null {
  if (current === null || !t.reliable || t.slopePerCycle === null) return null;
  if (t.direction !== "decreasing" || t.slopePerCycle >= 0) return null;
  return Math.max(0, current / -t.slopePerCycle);
}

/** Demand-based food runway: stock / (population x kcal per dupe per cycle). Ignores production. */
export function foodDemandRunway(kcal: number | null, population: number, kcalPerDupe: number): number | null {
  if (kcal === null || population <= 0 || kcalPerDupe <= 0) return null;
  return kcal / (population * kcalPerDupe);
}
