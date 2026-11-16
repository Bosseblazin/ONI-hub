import { EventEmitter } from "node:events";
import path from "node:path";
import type { z } from "zod";
import { AlertEngine, type AlertEngineState } from "../alerts/engine";
import { GameClock } from "../calc/clock";
import { computeTrend, confidenceFrom, foodDemandRunway, runwayFromTrend } from "../calc/trend";
import { McpError, OniMcpClient } from "../mcp/client";
import { withQuery } from "../mcp/readonly";
import {
  AtmosphereSummarySchema,
  BreathabilitySchema,
  ColonyStatusSchema,
  DupesStatusCheckSchema,
  DupesVitalsSchema,
  FoodSummarySchema,
  formatZodError,
  InventorySchema,
  LiquidSummarySchema,
  PowerSummarySchema,
  ResearchProgressSchema,
  ThermalSummarySchema,
  WorldListSchema,
  type AtmosphereSummary,
  type DupesStatusCheck,
  type LiquidSummary,
} from "../mcp/schemas";
import {
  baseWorld,
  buildResources,
  freeByResource,
  isSettled,
  normalizeAtmosphere,
  normalizeDupes,
  normalizePower,
  normalizeThermal,
  storedByResource,
  toHistorySample,
} from "../model/normalize";
import { loadThresholds } from "../model/thresholds";
import type {
  ColonySnapshot,
  ConnectionInfo,
  DashboardState,
  HistoryField,
  MetricGroup,
  Projection,
  ResourceKey,
  Thresholds,
  Trend,
  WorldState,
} from "../model/types";
import { HistoryStore, readJsonFile, writeJsonFileAtomic } from "../store/history";
import { buildCapabilities } from "./capabilities";

export const SIMULATOR_SERVER_NAME = "OniMcp-Simulator";

export interface CollectorOptions {
  url: string;
  token?: string;
  dataDir: string;
  coreIntervalMs?: number;
  mediumIntervalMs?: number;
  slowIntervalMs?: number;
  historyIntervalMs?: number;
  /** Delay between consecutive resource reads, to spread main-thread load in the game. */
  requestSpacingMs?: number;
  thresholds?: Thresholds;
  client?: OniMcpClient;
}

const TREND_FIELDS: HistoryField[] = ["kcal", "o2", "co2", "water", "dirtyWater", "coal", "petroleum", "gas", "battJ", "metal", "stone", "plastic", "avgT", "pop"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Collector extends EventEmitter {
  readonly client: OniMcpClient;
  private readonly th: Thresholds;
  private readonly history: HistoryStore;
  private readonly alerts: AlertEngine;
  private readonly clock = new GameClock();
  private readonly alertFile: string;

  private worlds = new Map<number, WorldState>();
  /** Raw per-world reads that feed combined resource figures. */
  private caches = new Map<number, { stored?: Partial<Record<ResourceKey, number>>; liquid?: LiquidSummary; gas?: AtmosphereSummary }>();
  private snapshot: ColonySnapshot | null = null;
  private prevSnapshot: ColonySnapshot | null = null;
  private trends: Trend[] = [];
  private projections: Projection[] = [];
  private lastUpdate: number | null = null;
  private lastMedium = 0;
  private lastSlow = 0;
  private lastHistory = 0;
  private lastWorkforce = 0;
  private lastResearch = 0;
  private research: ColonySnapshot["research"] = null;
  private failedUris = new Map<string, string>();
  private running = false;
  private loopPromise: Promise<void> | null = null;

  readonly conn: ConnectionInfo;
  private readonly o: Required<Omit<CollectorOptions, "token" | "thresholds" | "client">>;

  constructor(opts: CollectorOptions) {
    super();
    this.setMaxListeners(100);
    this.o = {
      url: opts.url,
      dataDir: opts.dataDir,
      coreIntervalMs: opts.coreIntervalMs ?? 5_000,
      mediumIntervalMs: opts.mediumIntervalMs ?? 15_000,
      slowIntervalMs: opts.slowIntervalMs ?? 60_000,
      historyIntervalMs: opts.historyIntervalMs ?? 30_000,
      requestSpacingMs: opts.requestSpacingMs ?? 120,
    };
    this.th = opts.thresholds ?? loadThresholds();
    this.client = opts.client ?? new OniMcpClient({ url: opts.url, token: opts.token, timeoutMs: 15_000 });
    this.history = new HistoryStore(opts.dataDir);
    this.alertFile = path.join(opts.dataDir, "alerts.json");
    const saved = readJsonFile<AlertEngineState & { colony?: string }>(this.alertFile);
    this.alerts = new AlertEngine(undefined, saved ?? undefined);
    this.conn = {
      state: "connecting",
      url: opts.url,
      serverName: null,
      serverVersion: null,
      protocolVersion: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      simulated: false,
      consecutiveFailures: 0,
    };
  }

  /* ------------------------------------------------------------ lifecycle */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const started = Date.now();
      try {
        await this.tick();
      } catch (e) {
        this.onFailure(e);
      }
      this.publish();
      const backoff = this.conn.consecutiveFailures > 0 ? Math.min(30_000, 2_000 * 2 ** Math.min(this.conn.consecutiveFailures - 1, 4)) : 0;
      const wait = Math.max(250, (backoff || this.o.coreIntervalMs) - (Date.now() - started));
      await sleep(wait);
    }
  }

  /** One full polling pass. Public for tests. */
  async tick(now = Date.now()): Promise<void> {
    this.conn.lastAttemptAt = now;
    if (!this.client.connected) {
      this.conn.state = "connecting";
      const info = await this.client.connect();
      this.conn.serverName = info.name;
      this.conn.serverVersion = info.version;
      this.conn.protocolVersion = info.protocolVersion;
      this.conn.simulated = info.name === SIMULATOR_SERVER_NAME;
    }

    const status = await this.read("oni://colony/status", ColonyStatusSchema);
    const worldList = await this.read("oni://world/list", WorldListSchema);

    // Colony identity / reload handling
    const saveName = status.saveName ?? null;
    const newColony = this.snapshot !== null && this.snapshot.saveName !== saveName;
    if (newColony || this.snapshot === null) {
      this.history.open(saveName);
      if (newColony) {
        this.alerts.resetForNewColony();
        this.worlds.clear();
        this.caches.clear();
        this.clock.reset();
        this.prevSnapshot = null;
      }
    }
    const clock = this.clock.update({ cycle: status.cycle, speed: status.gameSpeed, paused: status.isPaused, wallMs: now });
    if (clock.discontinuity && this.snapshot?.time && status.cycle < this.snapshot.time.cycle) {
      this.history.rewindTo(clock.estCycles);
    }

    // Reconcile world list
    const seen = new Set<number>();
    for (const w of worldList) {
      seen.add(w.id);
      const existing = this.worlds.get(w.id);
      if (existing) {
        existing.name = w.name;
        existing.isActive = w.isActive;
        existing.asteroidType = w.asteroidType ?? null;
      } else this.worlds.set(w.id, baseWorld(w));
    }
    for (const id of [...this.worlds.keys()]) if (!seen.has(id)) {
      this.worlds.delete(id);
      this.caches.delete(id);
    }

    // Vitals (all dupes, one call) — plus status-check on its own cadence.
    let statusCheck: DupesStatusCheck | null = null;
    if (now - this.lastWorkforce >= this.o.mediumIntervalMs * 2) {
      statusCheck = await this.tryRead(
        withQuery("oni://dupes/status-check", { radius: 2, includeReachableSamples: false, limit: 100 }),
        DupesStatusCheckSchema,
      );
      if (statusCheck) {
        this.lastWorkforce = now;
        for (const w of this.worlds.values()) this.mark(w, "workforce", now);
      }
    }
    const vitals = await this.tryRead("oni://dupes/vitals", DupesVitalsSchema);
    if (vitals) {
      const prevStatus = new Map<string, { risk: WorldState["dupes"][number]["risk"]; idle: boolean | null; reasons: string[] }>();
      for (const w of this.worlds.values()) for (const d of w.dupes) prevStatus.set(`${d.name}|${d.worldId}`, d);
      const dupes = normalizeDupes(vitals, this.th, statusCheck);
      for (const w of this.worlds.values()) {
        w.dupes = dupes.filter((d) => d.worldId === w.id).map((d) => {
          if (statusCheck) return d;
          const p = prevStatus.get(`${d.name}|${d.worldId}`);
          return p ? { ...d, risk: p.risk, idle: p.idle, reasons: p.reasons } : d;
        });
        w.population = w.dupes.length;
        this.mark(w, "vitals", now);
      }
    } else for (const w of this.worlds.values()) this.fail(w, "vitals", this.failedUris.get("oni://dupes/vitals") ?? "unavailable");

    for (const w of this.worlds.values()) w.settled = isSettled(w);
    // Medium tier: power, food, inventory for each world we care about.
    if (now - this.lastMedium >= this.o.mediumIntervalMs) {
      this.lastMedium = now;
      for (const w of this.monitoredWorlds(now)) {
        await this.readMedium(w, now);
        w.settled = isSettled(w);
      }
    }
    // Slow tier: full-grid scans (thermal, atmosphere, liquids). These are the expensive reads in-game.
    // A newly settled world gets its first slow read immediately rather than waiting a full interval.
    const slowDue = now - this.lastSlow >= this.o.slowIntervalMs;
    if (slowDue) this.lastSlow = now;
    for (const w of this.worlds.values()) {
      if (w.settled && (slowDue || w.meta.thermal.fetchedAt === null)) await this.readSlow(w, now);
    }
    if (now - this.lastResearch >= this.o.slowIntervalMs) {
      const r = await this.tryRead("oni://research/progress", ResearchProgressSchema);
      if (r) {
        this.research = { activeTech: r.activeTech, completed: r.completedTechCount, total: r.totalTechCount };
        this.lastResearch = now;
      }
    }

    for (const w of this.worlds.values()) w.settled = isSettled(w);

    const worlds = [...this.worlds.values()].sort((a, b) => Number(b.settled) - Number(a.settled) || a.id - b.id);
    this.prevSnapshot = this.snapshot;
    this.snapshot = {
      takenAt: now,
      saveName,
      time: { cycle: status.cycle, estCycles: clock.estCycles, paused: status.isPaused, speed: status.gameSpeed },
      activeWorldId: status.activeWorldId,
      totalPopulation: status.duplicantCount,
      worlds: structuredClone(worlds),
      research: this.research,
    };
    this.lastUpdate = now;
    this.conn.state = "connected";
    this.conn.lastSuccessAt = now;
    this.conn.lastError = null;
    this.conn.consecutiveFailures = 0;

    // History: only while the game clock is running, so pauses don't flatten trends.
    if (!status.isPaused && now - this.lastHistory >= this.o.historyIntervalMs) {
      this.lastHistory = now;
      this.history.append(this.snapshot.worlds.filter((w) => w.settled).map((w) => toHistorySample(w, now, clock.estCycles)));
    }
    this.recompute(now);
  }

  /* ------------------------------------------------------------- reading */

  private monitoredWorlds(now = Date.now()): WorldState[] {
    // Every world is read at least once (to learn whether it's settled); afterwards unsettled
    // worlds are only re-probed on the slow cadence via readMedium's power read.
    return [...this.worlds.values()].filter((w) => isSettled(w) || w.isActive || w.meta.power.fetchedAt === null || now - (w.meta.power.fetchedAt ?? 0) > 5 * 60_000);
  }

  private async readMedium(w: WorldState, now: number): Promise<void> {
    const power = await this.tryRead(withQuery("oni://power/summary", { worldId: w.id }), PowerSummarySchema);
    if (power) {
      w.power = normalizePower(power);
      this.mark(w, "power", now);
    } else this.fail(w, "power");
    if (!isSettled(w)) return;

    const food = await this.tryRead(withQuery("oni://food/summary", { worldId: w.id }), FoodSummarySchema);
    if (food) {
      // Use totalKcal only: OniMcp's daysRemaining divides by the *global* duplicant count.
      w.foodKcal = food.totalKcal;
      this.mark(w, "food", now);
    } else this.fail(w, "food");

    const inv = await this.tryRead(withQuery("oni://resources/inventory", { worldId: w.id, includeStored: true, limit: 500 }), InventorySchema);
    if (inv) {
      this.cache(w).stored = storedByResource(inv);
      this.mark(w, "inventory", now);
    } else this.fail(w, "inventory");
    this.rebuildResources(w);
  }

  private async readSlow(w: WorldState, now: number): Promise<void> {
    if (!isSettled(w)) return;
    const thermal = await this.tryRead(withQuery("oni://thermal/summary", { worldId: w.id }), ThermalSummarySchema);
    if (thermal) {
      w.thermal = normalizeThermal(thermal);
      this.mark(w, "thermal", now);
    } else this.fail(w, "thermal");

    const breath = await this.tryRead(withQuery("oni://atmosphere/breathability", { worldId: w.id }), BreathabilitySchema);
    const gas = await this.tryRead(withQuery("oni://atmosphere/summary", { worldId: w.id }), AtmosphereSummarySchema);
    if (breath) {
      w.atmosphere = normalizeAtmosphere(breath);
      this.mark(w, "atmosphere", now);
    } else this.fail(w, "atmosphere");

    const liquid = await this.tryRead(withQuery("oni://fluid/liquid/summary", { worldId: w.id }), LiquidSummarySchema);
    if (liquid) this.mark(w, "liquid", now);
    else this.fail(w, "liquid");
    if (liquid) this.cache(w).liquid = liquid;
    if (gas) this.cache(w).gas = gas;
    this.rebuildResources(w);
  }

  private cache(w: WorldState) {
    let c = this.caches.get(w.id);
    if (!c) this.caches.set(w.id, (c = {}));
    return c;
  }

  private rebuildResources(w: WorldState): void {
    const c = this.cache(w);
    w.resources = buildResources(c.stored ?? null, freeByResource(c.liquid ?? null, c.gas ?? null), {
      liquid: !!c.liquid,
      gas: !!c.gas,
    });
  }

  private async read<T>(uri: string, schema: z.ZodType<T>): Promise<T> {
    await sleep(this.o.requestSpacingMs);
    const raw = await this.client.readJson(uri);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new McpError(`Unexpected shape from ${uri}: ${formatZodError(parsed.error)}`, "protocol");
    this.failedUris.delete(uri.split("?")[0]!);
    return parsed.data;
  }

  private async tryRead<T>(uri: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return await this.read(uri, schema);
    } catch (e) {
      if (e instanceof McpError && (e.kind === "network" || e.kind === "auth" || e.kind === "timeout")) throw e;
      this.failedUris.set(uri.split("?")[0]!, (e as Error).message);
      return null;
    }
  }

  private mark(w: WorldState, g: MetricGroup, now: number) {
    w.meta[g] = { fetchedAt: now, error: null };
  }

  private fail(w: WorldState, g: MetricGroup, msg?: string) {
    w.meta[g] = { fetchedAt: w.meta[g].fetchedAt, error: msg ?? "read failed" };
  }

  private onFailure(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.conn.consecutiveFailures++;
    this.conn.lastError = msg;
    if (e instanceof McpError && (e.kind === "network" || e.kind === "timeout")) {
      this.conn.state = "disconnected";
      this.client.reset();
    } else if (/not initialized|ClusterManager|Game not/i.test(msg)) {
      this.conn.state = "game-not-loaded";
    } else {
      this.conn.state = "error";
    }
  }

  /* ---------------------------------------------------------- analysis */

  private recompute(now: number): void {
    if (!this.snapshot) return;
    const samples = [...this.history.all()];
    const trends: Trend[] = [];
    const tmap = new Map<string, Trend>();
    for (const w of this.snapshot.worlds.filter((x) => x.settled)) {
      for (const f of TREND_FIELDS) {
        const t = computeTrend(samples, f, w.id, this.th);
        trends.push(t);
        tmap.set(`${w.id}|${f}`, t);
      }
    }
    this.trends = trends;
    this.projections = this.buildProjections(this.snapshot, tmap);

    this.alerts.evaluate({
      snap: this.snapshot,
      prev: this.prevSnapshot,
      th: this.th,
      now,
      trend: (worldId, field) => tmap.get(`${worldId}|${field}`),
    });
    writeJsonFileAtomic(this.alertFile, this.alerts.toState());
  }

  private buildProjections(s: ColonySnapshot, t: Map<string, Trend>): Projection[] {
    const out: Projection[] = [];
    for (const w of s.worlds.filter((x) => x.settled)) {
      if (w.population > 0 && w.foodKcal !== null) {
        out.push({
          label: "Food (demand-based)",
          worldId: w.id,
          cycles: foodDemandRunway(w.foodKcal, w.population, this.th.kcalPerDupePerCycle),
          method: "stock ÷ (population × kcal per duplicant per cycle)",
          assumptions: [`${this.th.kcalPerDupePerCycle} kcal/duplicant/cycle`, "No new food produced", "All stored food is reachable and edible"],
          confidence: "medium",
        });
      }
      const add = (label: string, field: HistoryField, current: number | null, unit: string) => {
        const tr = t.get(`${w.id}|${field}`);
        if (!tr || current === null) return;
        out.push({
          label,
          worldId: w.id,
          cycles: runwayFromTrend(current, tr),
          method: tr.reliable
            ? `linear trend ${tr.slopePerCycle! >= 0 ? "+" : ""}${Math.round(tr.slopePerCycle!)} ${unit}/cycle`
            : "trend not yet reliable",
          assumptions: [tr.reason, "Current net rate continues unchanged", "Counts revealed map + storage only"],
          confidence: confidenceFrom(tr),
        });
      };
      add("Food (trend)", "kcal", w.foodKcal, "kcal");
      add("Oxygen", "o2", w.atmosphere?.oxygenKg ?? null, "kg");
      add("Battery charge", "battJ", w.power && w.power.batteryCount > 0 ? w.power.batteryStoredJ : null, "J");
      add("Water", "water", w.resources.water.total, "kg");
      add("Coal", "coal", w.resources.coal.total, "kg");
      add("Petroleum", "petroleum", w.resources.petroleum.total, "kg");
      add("Natural gas", "gas", w.resources.naturalGas.total, "kg");
    }
    return out;
  }

  /* ---------------------------------------------------------- public API */

  getState(now = Date.now()): DashboardState {
    const ageS = this.lastUpdate === null ? null : (now - this.lastUpdate) / 1000;
    const stale = ageS === null || ageS > this.th.staleAfterSeconds || this.conn.state !== "connected";
    let staleReason: string | null = null;
    if (stale) {
      if (this.conn.state === "game-not-loaded") staleReason = "OniMcp is running but no colony is loaded.";
      else if (this.conn.state === "disconnected") staleReason = `Cannot reach OniMcp at ${this.conn.url}. Is the game running with the ONI MCP Server mod enabled?`;
      else if (this.conn.state === "error") staleReason = `OniMcp error: ${this.conn.lastError ?? "unknown"}`;
      else if (this.conn.state === "connecting") staleReason = "Connecting to OniMcp…";
      else staleReason = `No successful update for ${Math.round(ageS ?? 0)} s.`;
    }
    return {
      connection: { ...this.conn },
      snapshot: this.snapshot,
      lastUpdate: this.lastUpdate,
      stale,
      staleReason,
      alerts: this.alerts.list(),
      trends: this.trends,
      projections: this.projections,
      thresholds: this.th,
      capabilities: buildCapabilities(this.failedUris),
    };
  }

  historyFor(worldId: number, sinceCycles?: number) {
    return this.history.forWorld(worldId, sinceCycles);
  }

  acknowledge(id: string): boolean {
    const ok = this.alerts.acknowledge(id);
    if (ok) this.persistAndPublish();
    return ok;
  }

  dismiss(id: string): boolean {
    const ok = this.alerts.dismiss(id);
    if (ok) this.persistAndPublish();
    return ok;
  }

  private persistAndPublish() {
    writeJsonFileAtomic(this.alertFile, this.alerts.toState());
    this.publish();
  }

  private publish(): void {
    this.emit("state", this.getState());
  }
}
