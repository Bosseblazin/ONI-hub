import { buildResources, emptyMeta } from "@/lib/model/normalize";
import type { ColonySnapshot, DupeState, WorldState } from "@/lib/model/types";

export const NOW = 1_800_000_000_000;

export function dupe(p: Partial<DupeState> = {}): DupeState {
  return { name: "D", worldId: 0, healthPct: 100, stressPct: 10, caloriesKcal: 3000, breathPct: 100, incapacitated: false, hungry: false,
    starving: false, lowBreath: false, highStress: false, risk: "ok", idle: false, reasons: [], ...p };
}

export function world(p: Partial<WorldState> = {}): WorldState {
  const meta = emptyMeta();
  for (const k of Object.keys(meta) as (keyof typeof meta)[]) meta[k] = { fetchedAt: NOW, error: null };
  const dupes = p.dupes ?? [dupe({ name: "A" }), dupe({ name: "B" }), dupe({ name: "C" }), dupe({ name: "E" })];
  return {
    id: 0, name: "Test Rock", asteroidType: "x", kind: "asteroid", isActive: true, settled: true,
    population: dupes.length, dupes, power: null, foodKcal: 50_000,
    resources: buildResources({}, {}, { liquid: true, gas: true }), thermal: null, atmosphere: { oxygenKg: 5000, co2Kg: 100, breathableCells: 3000, visibleCells: 10000 },
    meta, ...p,
  };
}

export function snap(worlds: WorldState[], p: Partial<ColonySnapshot> = {}): ColonySnapshot {
  return { takenAt: NOW, saveName: "Test", time: { cycle: 100, estCycles: 100.5, paused: false, speed: 1 }, activeWorldId: 0,
    totalPopulation: worlds.reduce((a, w) => a + w.population, 0), worlds, research: null, ...p };
}
