import type {
  AtmosphereSummary,
  Breathability,
  DupesStatusCheck,
  DupesVitals,
  Inventory,
  LiquidSummary,
  PowerSummary,
  ThermalSummary,
  WorldList,
} from "../mcp/schemas";
import type {
  AtmosphereState,
  DupeState,
  HistorySample,
  MetricGroup,
  MetricMeta,
  PowerState,
  ResourceKey,
  ResourceReading,
  Thresholds,
  ThermalState,
  WorldKind,
  WorldState,
} from "./types";
import { METRIC_GROUPS } from "./types";

/** ONI element IDs (SimHashes names) / prefab IDs grouped into dashboard resources. */
export const RESOURCE_ELEMENTS: Record<ResourceKey, readonly string[]> = {
  water: ["Water"],
  pollutedWater: ["DirtyWater"],
  coal: ["Carbon"],
  petroleum: ["Petroleum"],
  crudeOil: ["CrudeOil"],
  naturalGas: ["Methane"],
  oxygen: ["Oxygen"],
  refinedMetal: ["Copper", "Iron", "Gold", "Aluminum", "Steel", "Tungsten", "Lead", "Cobalt", "Nickel", "Niobium", "TempConductorSolid"],
  metalOre: ["Cuprite", "IronOre", "GoldAmalgam", "AluminumOre", "Wolframite", "Electrum", "Cobaltite", "FoolsGold", "NickelOre", "Rust"],
  buildingStone: ["SandStone", "Granite", "IgneousRock", "SedimentaryRock", "Obsidian", "MaficRock", "Shale"],
  plastic: ["Polypropylene"],
};

export const RESOURCE_LABELS: Record<ResourceKey, string> = {
  water: "Water",
  pollutedWater: "Polluted Water",
  coal: "Coal",
  petroleum: "Petroleum",
  crudeOil: "Crude Oil",
  naturalGas: "Natural Gas",
  oxygen: "Oxygen (stored)",
  refinedMetal: "Refined Metal",
  metalOre: "Metal Ore",
  buildingStone: "Building Stone",
  plastic: "Plastic",
};

/** Resources that also exist as free cells on the map, and which scan they come from. */
const FREE_SOURCE: Partial<Record<ResourceKey, "liquid" | "gas">> = {
  water: "liquid",
  pollutedWater: "liquid",
  petroleum: "liquid",
  crudeOil: "liquid",
  naturalGas: "gas",
};

const ELEMENT_TO_KEY = new Map<string, ResourceKey>();
for (const [k, ids] of Object.entries(RESOURCE_ELEMENTS) as [ResourceKey, readonly string[]][]) {
  for (const id of ids) ELEMENT_TO_KEY.set(id, k);
}

export function emptyMeta(): Record<MetricGroup, MetricMeta> {
  const m = {} as Record<MetricGroup, MetricMeta>;
  for (const g of METRIC_GROUPS) m[g] = { fetchedAt: null, error: null };
  return m;
}

export function classifyWorld(asteroidType: string | null | undefined, name: string): WorldKind {
  const t = `${asteroidType ?? ""} ${name}`.toLowerCase();
  // Spaced Out rocket interiors are WorldContainers; their worldName references the interior template.
  return /rocketinterior|rocket interior|habitat module/.test(t) ? "rocket" : "asteroid";
}

export function normalizeDupes(vitals: DupesVitals, th: Thresholds, status?: DupesStatusCheck | null): DupeState[] {
  const byName = new Map<string, DupesStatusCheck["items"][number]>();
  for (const it of status?.items ?? []) byName.set(`${it.dupe.name}|${it.dupe.worldId}`, it);
  return vitals.dupes.map((d) => {
    const st = byName.get(`${d.name}|${d.worldId}`);
    return {
      name: d.name,
      worldId: d.worldId,
      healthPct: d.healthPct,
      stressPct: d.stressPct,
      caloriesKcal: d.caloriesKcal,
      breathPct: d.breathPct,
      incapacitated: d.healthPct <= 0,
      hungry: d.caloriesKcal < th.hungryKcal,
      starving: d.caloriesKcal <= th.starvingKcal,
      lowBreath: d.breathPct < th.lowBreathPct,
      highStress: d.stressPct >= th.stressWarningPct,
      risk: st ? st.risk : null,
      idle: st ? st.idle !== null && st.idle !== undefined : null,
      reasons: st ? st.reasons : [],
    };
  });
}

export function normalizePower(p: PowerSummary): PowerState {
  const s = p.summary;
  return {
    generatorCount: s.generatorCount,
    generatorOperational: s.generatorOperational,
    generatorEmpty: s.generatorEmpty,
    generatorRatedW: s.generatorWatts,
    consumerCount: s.consumerCount,
    consumerPowered: s.consumerPowered,
    consumerUsedW: s.consumerUsedWatts,
    consumerNeededW: s.consumerNeededWatts,
    batteryCount: s.batteryCount,
    batteryCapacityJ: s.batteryCapacityJ,
    batteryStoredJ: s.batteryStoredJ,
    batteryPct: s.batteryCapacityJ > 0 ? s.batteryStoredPercent : null,
    netActiveW: s.netActiveWatts,
    unconnectedConsumers: p.diagnostics?.issueCount ?? 0,
  };
}

export function normalizeThermal(t: ThermalSummary): ThermalState | null {
  if (t.scannedCells <= 0) return null;
  return { avgC: t.avgTempC, minC: t.minTempC, maxC: t.maxTempC, hotCells: t.hotCellsOver70C, scannedCells: t.scannedCells };
}

export function normalizeAtmosphere(b: Breathability): AtmosphereState {
  return {
    oxygenKg: b.oxygenMassKg,
    co2Kg: b.carbonDioxideMassKg,
    breathableCells: b.breathableCells,
    visibleCells: b.totalVisibleCells,
  };
}

/** Sum stored-item mass per dashboard resource for a single world. */
export function storedByResource(inv: Inventory): Partial<Record<ResourceKey, number>> {
  const out: Partial<Record<ResourceKey, number>> = {};
  for (const it of inv.items) {
    const key = ELEMENT_TO_KEY.get(it.elementId) ?? ELEMENT_TO_KEY.get(it.prefabId);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + it.totalMassKg;
  }
  return out;
}

export function freeByResource(liquid: LiquidSummary | null, gas: AtmosphereSummary | null): Partial<Record<ResourceKey, number>> {
  const out: Partial<Record<ResourceKey, number>> = {};
  for (const l of liquid?.liquids ?? []) {
    const key = ELEMENT_TO_KEY.get(l.element);
    if (key && FREE_SOURCE[key] === "liquid") out[key] = (out[key] ?? 0) + l.massKg;
  }
  for (const g of gas?.dominantGases ?? []) {
    const key = ELEMENT_TO_KEY.get(g.element);
    if (key && FREE_SOURCE[key] === "gas") out[key] = (out[key] ?? 0) + g.massKg;
  }
  return out;
}

export function buildResources(
  stored: Partial<Record<ResourceKey, number>> | null,
  free: Partial<Record<ResourceKey, number>> | null,
  freeAvailable: { liquid: boolean; gas: boolean },
): Record<ResourceKey, ResourceReading> {
  const out = {} as Record<ResourceKey, ResourceReading>;
  for (const key of Object.keys(RESOURCE_ELEMENTS) as ResourceKey[]) {
    const s = stored ? stored[key] ?? 0 : null;
    const src = FREE_SOURCE[key];
    const f = src ? (freeAvailable[src] && free ? free[key] ?? 0 : null) : null;
    const total = s === null && f === null ? null : (s ?? 0) + (f ?? 0);
    out[key] = { key, stored: s, free: f, total };
  }
  return out;
}

export function baseWorld(w: WorldList[number]): WorldState {
  return {
    id: w.id,
    name: w.name,
    asteroidType: w.asteroidType ?? null,
    kind: classifyWorld(w.asteroidType, w.name),
    isActive: w.isActive,
    settled: false,
    population: 0,
    dupes: [],
    power: null,
    foodKcal: null,
    resources: buildResources(null, null, { liquid: false, gas: false }),
    thermal: null,
    atmosphere: null,
    meta: emptyMeta(),
  };
}

export function isSettled(w: Pick<WorldState, "population" | "power">): boolean {
  if (w.population > 0) return true;
  const p = w.power;
  return !!p && p.generatorCount + p.batteryCount + p.consumerCount > 0;
}

export function toHistorySample(w: WorldState, t: number, c: number): HistorySample {
  const r = w.resources;
  return {
    t,
    c,
    w: w.id,
    pop: w.population,
    kcal: w.foodKcal,
    o2: w.atmosphere?.oxygenKg ?? null,
    co2: w.atmosphere?.co2Kg ?? null,
    water: r.water.total,
    dirtyWater: r.pollutedWater.total,
    coal: r.coal.total,
    petroleum: r.petroleum.total,
    crude: r.crudeOil.total,
    gas: r.naturalGas.total,
    metal: r.refinedMetal.total,
    stone: r.buildingStone.total,
    plastic: r.plastic.total,
    battPct: w.power?.batteryPct ?? null,
    battJ: w.power ? w.power.batteryStoredJ : null,
    genW: w.power?.generatorRatedW ?? null,
    useW: w.power?.consumerUsedW ?? null,
    needW: w.power?.consumerNeededW ?? null,
    avgT: w.thermal?.avgC ?? null,
    maxT: w.thermal?.maxC ?? null,
  };
}
