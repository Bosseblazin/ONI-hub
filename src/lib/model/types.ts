/**
 * Normalized internal colony model. UI components and the alert engine only
 * consume these types; nothing outside src/lib/mcp and src/lib/collector knows
 * about OniMcp payload shapes.
 */

export type MetricGroup =
  | "vitals"
  | "workforce"
  | "power"
  | "inventory"
  | "food"
  | "thermal"
  | "atmosphere"
  | "liquid";

export const METRIC_GROUPS: MetricGroup[] = [
  "vitals",
  "workforce",
  "power",
  "inventory",
  "food",
  "thermal",
  "atmosphere",
  "liquid",
];

export interface MetricMeta {
  /** Wall-clock ms of the last successful read, or null if never read. */
  fetchedAt: number | null;
  /** Last error message, cleared on next success. */
  error: string | null;
}

export type ResourceKey =
  | "water"
  | "pollutedWater"
  | "coal"
  | "petroleum"
  | "crudeOil"
  | "naturalGas"
  | "oxygen"
  | "refinedMetal"
  | "metalOre"
  | "buildingStone"
  | "plastic";

export interface ResourceReading {
  key: ResourceKey;
  /** kg held as items/in storage (from resources/inventory, includeStored=true). null = unavailable. */
  stored: number | null;
  /** kg present as free cells on the visible map (liquid/gas scans). null = not applicable or unavailable. */
  free: number | null;
  /** stored + free where both known; otherwise whichever is known; null if neither. */
  total: number | null;
}

export interface DupeState {
  name: string;
  worldId: number;
  healthPct: number;
  stressPct: number;
  caloriesKcal: number;
  breathPct: number;
  /** Derived: HitPoints <= 0. OniMcp does not expose the Incapacitated status directly. */
  incapacitated: boolean;
  hungry: boolean;
  starving: boolean;
  lowBreath: boolean;
  highStress: boolean;
  /** From dupes/status-check, null when that read is unavailable. */
  risk: "ok" | "warning" | "critical" | null;
  idle: boolean | null;
  reasons: string[];
}

export interface PowerState {
  generatorCount: number;
  generatorOperational: number;
  generatorEmpty: number;
  /** Sum of generator wattage *ratings* — OniMcp does not expose live generator output. */
  generatorRatedW: number;
  consumerCount: number;
  consumerPowered: number;
  /** Live draw reported by consumers (EnergyConsumer.WattsUsed). */
  consumerUsedW: number;
  /** Draw if all consumers were active. */
  consumerNeededW: number;
  batteryCount: number;
  batteryCapacityJ: number;
  batteryStoredJ: number;
  batteryPct: number | null;
  /** generatorRatedW - consumerNeededW (upper-bound estimate). */
  netActiveW: number;
  unconnectedConsumers: number;
}

export interface ThermalState {
  avgC: number;
  minC: number;
  maxC: number;
  hotCells: number;
  scannedCells: number;
}

export interface AtmosphereState {
  oxygenKg: number;
  co2Kg: number;
  breathableCells: number;
  visibleCells: number;
}

export type WorldKind = "asteroid" | "rocket";

export interface WorldState {
  id: number;
  name: string;
  asteroidType: string | null;
  kind: WorldKind;
  isActive: boolean;
  /** Heuristic: has duplicants or any power infrastructure. */
  settled: boolean;
  population: number;
  dupes: DupeState[];
  power: PowerState | null;
  foodKcal: number | null;
  resources: Record<ResourceKey, ResourceReading>;
  thermal: ThermalState | null;
  atmosphere: AtmosphereState | null;
  meta: Record<MetricGroup, MetricMeta>;
}

export interface GameTime {
  cycle: number;
  /** Estimated fractional cycles elapsed (see GameClock). */
  estCycles: number;
  paused: boolean;
  speed: number;
}

export type ConnectionState = "connecting" | "connected" | "game-not-loaded" | "disconnected" | "error";

export interface ConnectionInfo {
  state: ConnectionState;
  url: string;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  /** True when talking to the bundled simulator. All values are then simulated. */
  simulated: boolean;
  consecutiveFailures: number;
}

export interface ColonySnapshot {
  takenAt: number;
  saveName: string | null;
  time: GameTime | null;
  activeWorldId: number | null;
  totalPopulation: number | null;
  worlds: WorldState[];
  research: { activeTech: string; completed: number; total: number } | null;
}

/** Compact per-world history row persisted to disk. */
export interface HistorySample {
  t: number;
  c: number;
  w: number;
  pop: number;
  kcal: number | null;
  o2: number | null;
  co2: number | null;
  water: number | null;
  dirtyWater: number | null;
  coal: number | null;
  petroleum: number | null;
  crude: number | null;
  gas: number | null;
  metal: number | null;
  stone: number | null;
  plastic: number | null;
  battPct: number | null;
  battJ: number | null;
  genW: number | null;
  useW: number | null;
  needW: number | null;
  avgT: number | null;
  maxT: number | null;
}

export type HistoryField = Exclude<keyof HistorySample, "t" | "c" | "w">;

export type Severity = "CRITICAL" | "WARNING" | "INFO";

export interface AlertCandidate {
  /** Stable key, e.g. "food-runway:2". The same condition keeps the same id. */
  id: string;
  rule: string;
  severity: Severity;
  worldId: number | null;
  worldName: string | null;
  title: string;
  what: string;
  why: string;
  urgency: string;
  actions: string[];
  /** Verified observations backing the alert. */
  evidence: Record<string, string | number>;
  /** Assumptions behind any projection used. */
  assumptions?: string[];
  /** INFO events are one-shot and don't need hysteresis. */
  oneShot?: boolean;
}

export interface AlertRecord extends AlertCandidate {
  status: "active" | "resolved";
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  acknowledged: boolean;
  dismissed: boolean;
}

export interface Trend {
  field: HistoryField;
  worldId: number;
  /** Units of the field per game cycle. */
  slopePerCycle: number | null;
  direction: "increasing" | "decreasing" | "stable" | "unknown";
  samples: number;
  spanCycles: number;
  r2: number | null;
  reliable: boolean;
  reason: string;
}

export interface Projection {
  label: string;
  worldId: number;
  cycles: number | null;
  method: string;
  assumptions: string[];
  confidence: "low" | "medium" | "high" | "insufficient-data";
}

export interface DashboardState {
  connection: ConnectionInfo;
  snapshot: ColonySnapshot | null;
  /** Wall-clock ms of the last snapshot that had fresh core data. */
  lastUpdate: number | null;
  stale: boolean;
  staleReason: string | null;
  alerts: AlertRecord[];
  trends: Trend[];
  projections: Projection[];
  thresholds: Thresholds;
  capabilities: CapabilityReport[];
}

export interface CapabilityReport {
  feature: string;
  status: "available" | "partial" | "unavailable";
  source: string;
  note: string;
}

export interface Thresholds {
  foodRunwayCriticalCycles: number;
  foodRunwayWarningCycles: number;
  kcalPerDupePerCycle: number;
  oxygenKgPerDupeCritical: number;
  oxygenKgPerDupeWarning: number;
  batteryCriticalPct: number;
  batteryWarningPct: number;
  waterRunwayWarningCycles: number;
  waterMinimumKg: number;
  fuelRunwayWarningCycles: number;
  temperatureWarningC: number;
  temperatureCriticalC: number;
  stressWarningPct: number;
  stressCriticalPct: number;
  hungryKcal: number;
  starvingKcal: number;
  lowBreathPct: number;
  incapacitatedCritical: number;
  /** Consecutive evaluations a condition must hold before it alerts. */
  persistEvaluations: number;
  /** Consecutive clear evaluations before an alert resolves. */
  clearEvaluations: number;
  /** Trend requirements. */
  trendMinSamples: number;
  trendMinSpanCycles: number;
  trendWindowCycles: number;
  /** Seconds without a successful core read before data is considered stale. */
  staleAfterSeconds: number;
}
