/**
 * OniMcp protocol simulator — SIMULATED DATA ONLY.
 *
 * Implements the same Streamable-HTTP handshake (initialize → Mcp-Session-Id),
 * JSON-RPC methods and resource payload shapes as OniMcp 0.2.6, so the real
 * client/collector path is exercised end to end. It identifies itself as
 * "OniMcp-Simulator" in serverInfo; the dashboard uses that to label every value
 * as simulated. It never pretends to be the game.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

export const SIM_NAME = "OniMcp-Simulator";

interface SimDupe {
  id: number;
  name: string;
  worldId: number;
  hp: number;
  stress: number;
  kcal: number;
  breath: number;
}

interface SimWorld {
  id: number;
  name: string;
  type: string;
  w: number;
  h: number;
  settled: boolean;
  foodKcal: number;
  foodDelta: number; // kcal per cycle net
  o2: number;
  o2Delta: number;
  co2: number;
  water: number;
  waterDelta: number;
  dirty: number;
  coal: number;
  coalDelta: number;
  petroleum: number;
  crude: number;
  methane: number;
  metal: number;
  stone: number;
  plastic: number;
  battCap: number;
  battStored: number;
  battDeltaPerCycle: number;
  gens: number;
  gensEmpty: number;
  genW: number;
  consumers: number;
  usedW: number;
  needW: number;
  avgT: number;
  tDelta: number;
}

export interface SimOptions {
  /** Game seconds per wall second (reported as gameSpeed). */
  accel?: number;
  startCycle?: number;
  saveName?: string;
  scenario?: "demo" | "healthy";
}

const NAMES = ["Ada", "Bram", "Cyra", "Dov", "Esme", "Fenn", "Gale", "Hollis", "Ivo", "Juno", "Kael", "Lark"];

export class OniSimulator {
  cycleSeconds: number;
  paused = false;
  accel: number;
  saveName: string;
  worlds: SimWorld[];
  dupes: SimDupe[];
  activeWorldId = 0;
  private lastWall = Date.now();
  sessions = new Set<string>();
  /** Every JSON-RPC method received — used by tests to prove the client is read-only. */
  methodLog: string[] = [];
  failNext = 0;

  constructor(opts: SimOptions = {}) {
    this.accel = opts.accel ?? 10;
    this.cycleSeconds = ((opts.startCycle ?? 142) - 1) * 600 + 120;
    this.saveName = opts.saveName ?? "Simulated Cluster";
    const healthy = opts.scenario === "healthy";
    const mk = (p: Partial<SimWorld> & Pick<SimWorld, "id" | "name" | "type">): SimWorld => ({
      w: 256, h: 384, settled: true, foodKcal: 0, foodDelta: 0, o2: 0, o2Delta: 0, co2: 0, water: 0, waterDelta: 0, dirty: 0,
      coal: 0, coalDelta: 0, petroleum: 0, crude: 0, methane: 0, metal: 0, stone: 0, plastic: 0, battCap: 0, battStored: 0,
      battDeltaPerCycle: 0, gens: 0, gensEmpty: 0, genW: 0, consumers: 0, usedW: 0, needW: 0, avgT: 22, tDelta: 0, ...p,
    });
    this.worlds = [
      mk({ id: 0, name: "Sim Terra Prime", type: "expansion1::worlds/SimTerra", foodKcal: 96_000, foodDelta: healthy ? 2_000 : 1_500,
        o2: 4_200, o2Delta: healthy ? 30 : 5, co2: 900, water: 48_000, waterDelta: -400, dirty: 21_000, coal: 6_500, coalDelta: healthy ? -200 : -1_400,
        petroleum: 1_200, crude: 9_000, methane: 380, metal: 8_400, stone: 52_000, plastic: 600, battCap: 160_000, battStored: 120_000,
        battDeltaPerCycle: healthy ? 0 : -6_000, gens: 4, genW: 2_600, consumers: 31, usedW: 1_850, needW: 2_900, avgT: 27.4, tDelta: 0.05 }),
      mk({ id: 1, name: "Sim Verdant Outpost", type: "expansion1::worlds/SimVerdant", w: 160, h: 274, foodKcal: healthy ? 30_000 : 11_500,
        foodDelta: healthy ? 500 : -2_600, o2: healthy ? 900 : 260, o2Delta: healthy ? 5 : -35, co2: 420, water: 9_000, waterDelta: -900, dirty: 2_400,
        coal: 0, metal: 1_100, stone: 7_800, battCap: 40_000, battStored: healthy ? 30_000 : 7_000, battDeltaPerCycle: healthy ? 0 : -9_000, gens: 2,
        gensEmpty: healthy ? 0 : 1, genW: 1_200, consumers: 9, usedW: 640, needW: 1_380, avgT: 31.2 }),
      mk({ id: 2, name: "Sim Rocket Habitat", type: "expansion1::worlds/RocketInteriorMedium", w: 32, h: 32, foodKcal: 4_800, o2: 80, co2: 6 }),
      mk({ id: 3, name: "Sim Frozen Moonlet", type: "expansion1::worlds/SimIce", w: 96, h: 96, settled: false, avgT: -38 }),
    ];
    const pops: [number, number][] = [[0, 8], [1, 3], [2, 1]];
    let i = 0;
    this.dupes = [];
    for (const [w, n] of pops) for (let k = 0; k < n; k++, i++) {
      this.dupes.push({ id: 1000 + i, name: NAMES[i % NAMES.length]!, worldId: w, hp: 100, stress: 18 + ((i * 13) % 40), kcal: 2200 + ((i * 377) % 1500), breath: 100 });
    }
    if (!healthy) {
      const outpost = this.dupes.filter((d) => d.worldId === 1);
      if (outpost[0]) { outpost[0].kcal = 650; outpost[0].stress = 71; }
      if (outpost[1]) outpost[1].stress = 88;
    }
  }

  get cycle(): number {
    return Math.floor(this.cycleSeconds / 600) + 1;
  }

  /** Advance simulated game time to the current wall clock. */
  advance(now = Date.now()): void {
    const dtWall = (now - this.lastWall) / 1000;
    this.lastWall = now;
    if (this.paused || dtWall <= 0) return;
    const dtGame = dtWall * this.accel;
    this.cycleSeconds += dtGame;
    const f = dtGame / 600; // fraction of a cycle
    const jitter = () => 1 + (Math.random() - 0.5) * 0.15;
    for (const w of this.worlds) {
      if (!w.settled) continue;
      w.foodKcal = Math.max(0, w.foodKcal + w.foodDelta * f * jitter());
      w.o2 = Math.max(0, w.o2 + w.o2Delta * f * jitter());
      w.water = Math.max(0, w.water + w.waterDelta * f * jitter());
      w.coal = Math.max(0, w.coal + w.coalDelta * f * jitter());
      w.battStored = Math.min(w.battCap, Math.max(0, w.battStored + w.battDeltaPerCycle * f * jitter()));
      w.avgT += w.tDelta * f;
    }
    for (const d of this.dupes) {
      const w = this.worlds.find((x) => x.id === d.worldId)!;
      const hungry = w.foodKcal <= 0;
      d.kcal = Math.max(0, Math.min(4000, d.kcal + (hungry ? -1000 : 0) * f));
      if (w.o2 <= 0) d.breath = Math.max(0, d.breath - 400 * f);
      else d.breath = Math.min(100, d.breath + 400 * f);
      if (d.kcal <= 0 || d.breath <= 0) d.hp = Math.max(0, d.hp - 50 * f);
    }
  }

  private worldsFor(worldId: number | null): SimWorld[] {
    return worldId === null || worldId < 0 ? this.worlds : this.worlds.filter((w) => w.id === worldId);
  }

  /** Returns resource JSON with the same field names as OniMcp 0.2.6. */
  readResource(uri: string): unknown {
    const u = new URL(uri);
    const route = `${u.host}${u.pathname}`.replace(/\/$/, "");
    const widRaw = u.searchParams.get("worldId");
    const wid = widRaw === null ? null : Number(widRaw);
    const one = (wid === null ? this.worlds.find((w) => w.id === this.activeWorldId) : this.worlds.find((w) => w.id === wid)) ?? null;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const popOf = (id: number) => this.dupes.filter((d) => d.worldId === id).length;

    switch (route) {
      case "colony/status":
        return { cycle: this.cycle, duplicantCount: this.dupes.length, worldCount: this.worlds.length, activeWorldId: this.activeWorldId,
          gameSpeed: this.paused ? 0 : this.accel, isPaused: this.paused, saveName: this.saveName };
      case "world/list":
        return this.worlds.map((w) => ({ id: w.id, name: w.name, isActive: w.id === this.activeWorldId, width: w.w, height: w.h, asteroidType: w.type }));
      case "dupes/vitals":
        return { dupeCount: this.dupes.length, dupes: this.dupes.map((d) => ({ name: d.name, worldId: d.worldId, healthPct: r1(d.hp), stressPct: r1(d.stress),
          caloriesKcal: r1(d.kcal), breathPct: r1(d.breath), bladderPct: 40 })) };
      case "dupes/status-check": {
        const items = this.dupes.map((d, i) => {
          const reasons: string[] = [];
          if (d.kcal > 0 && d.kcal < 1000) reasons.push("low_calories");
          if (d.breath < 35) reasons.push("low_breath");
          const idle = i % 5 === 4;
          if (idle) reasons.push("idle_no_errands");
          const risk = reasons.includes("low_breath") ? "critical" : reasons.length ? "warning" : "ok";
          return { dupe: { id: d.id, name: d.name, worldId: d.worldId }, risk, reasons, currentChore: idle ? null : { type: "Dig" }, idle: idle ? { reasonCode: "no_errands" } : null };
        });
        return { v: 1, readOnly: true, count: items.length, flagged: items.filter((x) => x.risk !== "ok").length, items };
      }
      case "power/summary": {
        const ws = this.worldsFor(wid ?? this.activeWorldId);
        const s = (k: keyof SimWorld) => ws.reduce((a, w) => a + (w[k] as number), 0);
        const cap = s("battCap"), stored = s("battStored");
        const powered = ws.reduce((a, w) => a + (w.battStored <= 0 && w.battDeltaPerCycle < 0 ? Math.floor(w.consumers / 2) : w.consumers), 0);
        return { worldId: wid ?? this.activeWorldId, summary: {
          batteryCount: ws.reduce((a, w) => a + (w.battCap > 0 ? Math.ceil(w.battCap / 20000) : 0), 0), batteryCapacityJ: cap, batteryStoredJ: r1(stored),
          batteryStoredPercent: cap > 0 ? Math.round((stored / cap) * 10000) / 100 : 0, generatorCount: s("gens"), generatorOperational: s("gens") - s("gensEmpty"),
          generatorEmpty: s("gensEmpty"), generatorWatts: s("genW"), generatorStoredJ: 0, consumerCount: s("consumers"), consumerOperational: s("consumers"),
          consumerPowered: powered, consumerBaseWatts: s("needW"), consumerNeededWatts: s("needW"), consumerUsedWatts: s("usedW"),
          netRatedWatts: s("genW") - s("needW"), netActiveWatts: s("genW") - s("needW"), batteryWattsUsed: 0 },
          circuits: [], diagnostics: { issueCount: 0, items: [], next: "No unconnected consumers detected in this summary." } };
      }
      case "food/summary": {
        const ws = this.worldsFor(wid);
        const kcal = ws.reduce((a, w) => a + w.foodKcal, 0);
        const days = this.dupes.length ? kcal / (this.dupes.length * 1000) : 999; // mirrors OniMcp's global-population quirk
        return { worldId: wid ?? this.activeWorldId, totalKcal: r1(kcal), dupeCount: this.dupes.length, daysRemaining: r1(days),
          status: days < 2 ? "critical" : days < 5 ? "warning" : "nominal" };
      }
      case "resources/inventory": {
        const ws = this.worldsFor(wid);
        const items: unknown[] = [];
        const add = (name: string, prefabId: string, elementId: string, mass: number, worldIds: number[]) => {
          if (mass > 0) items.push({ name, prefabId, elementId, count: Math.max(1, Math.round(mass / 200)), storedCount: 1, looseCount: 0,
            totalMassKg: Math.round(mass * 1000) / 1000, totalUnits: mass, worldIds });
        };
        for (const w of ws) {
          add("Coal", "Carbon", "Carbon", w.coal, [w.id]);
          add("Water", "Water", "Water", w.water * 0.6, [w.id]); // 60% in tanks, 40% free
          add("Polluted Water", "DirtyWater", "DirtyWater", w.dirty * 0.5, [w.id]);
          add("Petroleum", "Petroleum", "Petroleum", w.petroleum, [w.id]);
          add("Natural Gas", "Methane", "Methane", w.methane * 0.5, [w.id]);
          add("Copper", "Copper", "Copper", w.metal * 0.7, [w.id]);
          add("Iron", "Iron", "Iron", w.metal * 0.3, [w.id]);
          add("Sandstone", "SandStone", "SandStone", w.stone, [w.id]);
          add("Plastic", "Polypropylene", "Polypropylene", w.plastic, [w.id]);
          add("Algae", "Algae", "Algae", 400, [w.id]);
        }
        return { scannedPickupables: items.length * 7, visibleOnly: true, totalGroups: items.length, returned: items.length, items };
      }
      case "thermal/summary":
        if (!one) return { error: true, message: "World not found" };
        return { worldId: one.id, scannedCells: one.w * one.h, avgTempC: r1(one.avgT), minTempC: r1(one.avgT - 60), maxTempC: r1(one.avgT + 300),
          hotCellsOver70C: Math.round(one.w * one.h * 0.04), coldCellsBelow0C: Math.round(one.w * one.h * 0.1) };
      case "atmosphere/breathability":
        if (!one) return { error: true, message: "World not found" };
        return { worldId: one.id, dupeCount: this.dupes.length, breathableCells: Math.round(one.o2 / 1.8), totalVisibleCells: one.w * one.h,
          oxygenMassKg: r1(one.o2), carbonDioxideMassKg: r1(one.co2), oxygenPerDupeKg: r1(one.o2 / Math.max(1, popOf(one.id))), suffocationRisk: "nominal", airQuality: "good" };
      case "atmosphere/summary":
        if (!one) return { error: true, message: "World not found" };
        return { worldId: one.id, totalGasMassKg: r1(one.o2 + one.co2 + one.methane), totalGasCells: Math.round((one.o2 + one.co2) / 1.5), breathableCells: Math.round(one.o2 / 1.8),
          breathablePercentage: 70, dominantGases: [
            { element: "Oxygen", massKg: r1(one.o2), cellCount: Math.round(one.o2 / 1.8), avgTempC: r1(one.avgT) },
            { element: "CarbonDioxide", massKg: r1(one.co2), cellCount: Math.round(one.co2 / 2), avgTempC: r1(one.avgT) },
            ...(one.methane > 0 ? [{ element: "Methane", massKg: r1(one.methane * 0.5), cellCount: 40, avgTempC: r1(one.avgT) }] : []),
          ] };
      case "fluid/liquid/summary":
        if (!one) return { error: true, message: "World not found" };
        return { worldId: one.id, totalLiquidMassKg: r1(one.water * 0.4 + one.dirty * 0.5 + one.crude), liquids: [
          { element: "Water", massKg: r1(one.water * 0.4), cellCount: 90, avgTempC: 24 },
          { element: "DirtyWater", massKg: r1(one.dirty * 0.5), cellCount: 40, avgTempC: 28 },
          ...(one.crude > 0 ? [{ element: "CrudeOil", massKg: r1(one.crude), cellCount: 20, avgTempC: 90 }] : []),
        ] };
      case "research/progress":
        return { activeTech: "Sim: Advanced Power Regulation", completedTechCount: 47, totalTechCount: 103 };
      default:
        return null;
    }
  }

  handleRpc(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }, sessionId: string | null): { body: unknown; session?: string; status: number } {
    const method = msg.method ?? "";
    this.methodLog.push(method);
    const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id ?? null, result } });
    const err = (code: number, message: string, status = 200) => ({ status, body: { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } } });
    if (method === "initialize") {
      if (sessionId) return err(-32600, "initialize must start a new session without Mcp-Session-Id", 400);
      const sid = randomUUID();
      this.sessions.add(sid);
      return { ...ok({ protocolVersion: "2025-11-25", capabilities: { resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: SIM_NAME, version: "0.0.0-sim" } }), session: sid };
    }
    if (!sessionId) return err(-32600, "Missing Mcp-Session-Id header", 400);
    if (!this.sessions.has(sessionId)) return err(-32600, "Unknown session", 404);
    if (method === "notifications/initialized") return { status: 202, body: null };
    if (method === "ping") return ok({});
    if (method === "tools/call") return err(-32601, "Simulator does not implement tools", 200);
    if (method === "resources/list") return ok({ resources: [] });
    if (method === "resources/templates/list") return ok({ resourceTemplates: [] });
    if (method === "resources/read") {
      const uri = String(msg.params?.uri ?? "");
      this.advance();
      const data = this.readResource(uri);
      if (data === null) return err(-32002, `Resource not found: ${uri}`);
      return ok({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }] });
    }
    return err(-32601, `Method not found: ${method}`);
  }

  listen(port: number, host = "127.0.0.1"): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        if (this.failNext > 0) {
          this.failNext--;
          req.socket.destroy();
          return;
        }
        let msg: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
          return;
        }
        const sid = (req.headers["mcp-session-id"] as string | undefined) ?? null;
        const out = this.handleRpc(msg, sid);
        const headers: Record<string, string> = { "Mcp-Protocol-Version": "2025-11-25" };
        if (out.session) headers["Mcp-Session-Id"] = out.session;
        if (out.body === null) {
          res.writeHead(out.status, headers).end();
          return;
        }
        headers["Content-Type"] = "application/json";
        res.writeHead(out.status, headers).end(JSON.stringify(out.body));
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}
