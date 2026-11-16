import fs from "node:fs";
import path from "node:path";
import type { Thresholds } from "./types";

/**
 * Defaults. Game constants used here:
 *  - A standard duplicant burns 1,000 kcal per cycle (traits change this).
 *  - A duplicant breathes ~100 g/s of oxygen = ~60 kg per 600 s cycle.
 *  - Dupes become "Hungry" around 1,000 kcal of stomach calories (OniMcp uses the same cut-off).
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  foodRunwayCriticalCycles: 3,
  foodRunwayWarningCycles: 6,
  kcalPerDupePerCycle: 1000,
  oxygenKgPerDupeCritical: 10,
  oxygenKgPerDupeWarning: 40,
  batteryCriticalPct: 5,
  batteryWarningPct: 20,
  waterRunwayWarningCycles: 10,
  waterMinimumKg: 2000,
  fuelRunwayWarningCycles: 5,
  temperatureWarningC: 60,
  temperatureCriticalC: 75,
  stressWarningPct: 60,
  stressCriticalPct: 85,
  hungryKcal: 1000,
  starvingKcal: 200,
  lowBreathPct: 35,
  incapacitatedCritical: 2,
  persistEvaluations: 2,
  clearEvaluations: 3,
  trendMinSamples: 6,
  trendMinSpanCycles: 0.25,
  trendWindowCycles: 3,
  staleAfterSeconds: 45,
};

/** Merge config/thresholds.json (if present) over defaults. Invalid keys are ignored. */
export function loadThresholds(configDir = path.join(process.cwd(), "config")): Thresholds {
  const file = path.join(configDir, "thresholds.json");
  const out: Thresholds = { ...DEFAULT_THRESHOLDS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (k in out && typeof v === "number" && Number.isFinite(v)) (out as unknown as Record<string, number>)[k] = v;
    }
  } catch {
    /* no override file */
  }
  return out;
}
