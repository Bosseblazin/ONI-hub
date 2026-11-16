/**
 * Validation schemas for OniMcp resource payloads.
 *
 * Each schema mirrors the C# serializer in OniMcp 0.2.6 (file noted per schema).
 * Fields are validated for type; unknown fields are dropped. If OniMcp changes a
 * shape, validation fails loudly and the metric is reported as unavailable rather
 * than silently mis-read.
 */
import { z } from "zod";

const num = z.number().refine(Number.isFinite, "non-finite number");

/** Tools/Impl/Colony/ColonyTools.cs GetColonyInfo */
export const ColonyStatusSchema = z.object({
  cycle: z.number().int(),
  duplicantCount: z.number().int().nonnegative(),
  worldCount: z.number().int().nonnegative(),
  activeWorldId: z.number().int(),
  gameSpeed: num,
  isPaused: z.boolean(),
  saveName: z.string().optional(),
});
export type ColonyStatus = z.infer<typeof ColonyStatusSchema>;

/** ColonyTools.cs GetWorlds */
export const WorldListSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    isActive: z.boolean(),
    width: z.number().int(),
    height: z.number().int(),
    asteroidType: z.string().nullable().optional(),
  }),
);
export type WorldList = z.infer<typeof WorldListSchema>;

/** Tools/Impl/Colony/ColonyStateDataCollector.cs BuildDupesVitals */
export const DupesVitalsSchema = z.object({
  dupeCount: z.number().int(),
  dupes: z.array(
    z.object({
      name: z.string(),
      worldId: z.number().int(),
      healthPct: num,
      stressPct: num,
      caloriesKcal: num,
      breathPct: num,
      bladderPct: num,
    }),
  ),
});
export type DupesVitals = z.infer<typeof DupesVitalsSchema>;

/** Tools/Impl/Dupes/DuplicantInfoTools.cs status_check (subset we use) */
export const DupesStatusCheckSchema = z.object({
  count: z.number().int(),
  items: z.array(
    z.object({
      dupe: z.object({ id: z.number().int(), name: z.string(), worldId: z.number().int() }),
      risk: z.enum(["ok", "warning", "critical"]),
      reasons: z.array(z.string()),
      idle: z.unknown().nullable().optional(),
      currentChore: z.unknown().nullable().optional(),
    }),
  ),
});
export type DupesStatusCheck = z.infer<typeof DupesStatusCheckSchema>;

/** Tools/Impl/Build/PowerSummaryTools.cs GetPowerSummary */
export const PowerSummarySchema = z.object({
  worldId: z.number().int(),
  summary: z.object({
    batteryCount: z.number().int(),
    batteryCapacityJ: num,
    batteryStoredJ: num,
    batteryStoredPercent: num,
    generatorCount: z.number().int(),
    generatorOperational: z.number().int(),
    generatorEmpty: z.number().int(),
    generatorWatts: num,
    consumerCount: z.number().int(),
    consumerOperational: z.number().int(),
    consumerPowered: z.number().int(),
    consumerBaseWatts: num,
    consumerNeededWatts: num,
    consumerUsedWatts: num,
    netRatedWatts: num,
    netActiveWatts: num,
    batteryWattsUsed: num,
  }),
  diagnostics: z.object({ issueCount: z.number().int() }).optional(),
});
export type PowerSummary = z.infer<typeof PowerSummarySchema>;

/** Tools/Impl/Colony/InventoryTools.cs + InventoryAggregateModels.cs */
export const InventorySchema = z.object({
  scannedPickupables: z.number().int(),
  totalGroups: z.number().int(),
  returned: z.number().int(),
  items: z.array(
    z.object({
      name: z.string(),
      prefabId: z.string(),
      elementId: z.string(),
      count: z.number().int(),
      storedCount: z.number().int(),
      looseCount: z.number().int(),
      totalMassKg: num,
      totalCaloriesKcal: num.optional(),
      worldIds: z.array(z.number().int()),
    }),
  ),
});
export type Inventory = z.infer<typeof InventorySchema>;

/** ColonyStateDataCollector.cs BuildFoodSummary (we only trust totalKcal per world). */
export const FoodSummarySchema = z.object({
  worldId: z.number().int(),
  totalKcal: num,
  dupeCount: z.number().int(),
  daysRemaining: num,
  status: z.string(),
});
export type FoodSummary = z.infer<typeof FoodSummarySchema>;

/** ColonyStateDataCollector.cs BuildThermalSummary */
export const ThermalSummarySchema = z.object({
  worldId: z.number().int(),
  scannedCells: z.number().int(),
  avgTempC: num,
  minTempC: num,
  maxTempC: num,
  hotCellsOver70C: z.number().int(),
  coldCellsBelow0C: z.number().int(),
});
export type ThermalSummary = z.infer<typeof ThermalSummarySchema>;

/** ColonyStateDataCollector.cs BuildBreathabilityAnalysis */
export const BreathabilitySchema = z.object({
  worldId: z.number().int(),
  breathableCells: z.number().int(),
  totalVisibleCells: z.number().int(),
  oxygenMassKg: num,
  carbonDioxideMassKg: num,
});
export type Breathability = z.infer<typeof BreathabilitySchema>;

const elementStat = z.object({ element: z.string(), massKg: num, cellCount: z.number().int(), avgTempC: num });

/** ColonyStateDataCollector.cs BuildLiquidSummary */
export const LiquidSummarySchema = z.object({
  worldId: z.number().int(),
  totalLiquidMassKg: num,
  liquids: z.array(elementStat),
});
export type LiquidSummary = z.infer<typeof LiquidSummarySchema>;

/** ColonyStateDataCollector.cs BuildAtmosphereSummary (top 10 gases only) */
export const AtmosphereSummarySchema = z.object({
  worldId: z.number().int(),
  totalGasMassKg: num,
  totalGasCells: z.number().int(),
  dominantGases: z.array(elementStat),
});
export type AtmosphereSummary = z.infer<typeof AtmosphereSummarySchema>;

/** ColonyStateDataCollector.cs BuildResearchProgress */
export const ResearchProgressSchema = z.object({
  activeTech: z.string(),
  completedTechCount: z.number().int(),
  totalTechCount: z.number().int(),
});
export type ResearchProgress = z.infer<typeof ResearchProgressSchema>;

export function formatZodError(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
