import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Collector, SIMULATOR_SERVER_NAME } from "@/lib/collector/collector";
import { OniMcpClient } from "@/lib/mcp/client";
import { DEFAULT_THRESHOLDS } from "@/lib/model/thresholds";
import { OniSimulator } from "@/lib/sim/simulator";

let sim: OniSimulator;
let server: http.Server;
let url: string;
let dataDir: string;

beforeAll(async () => {
  sim = new OniSimulator({ accel: 600 }); // 1 game cycle per wall second
  server = await sim.listen(0);
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no port");
  url = `http://127.0.0.1:${addr.port}/mcp/`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-test-"));
});
afterAll(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const fast = () =>
  new Collector({
    url, dataDir, coreIntervalMs: 50, mediumIntervalMs: 0, slowIntervalMs: 0, historyIntervalMs: 0, requestSpacingMs: 0,
    thresholds: { ...DEFAULT_THRESHOLDS, persistEvaluations: 1, trendMinSamples: 4, trendMinSpanCycles: 0.2 },
  });

describe("MCP client ↔ simulator", () => {
  it("performs the initialize handshake and reads JSON resources", async () => {
    const c = new OniMcpClient({ url });
    const info = await c.connect();
    expect(info.name).toBe(SIMULATOR_SERVER_NAME);
    expect(info.protocolVersion).toBe("2025-11-25");
    const status = (await c.readJson("oni://colony/status")) as { cycle: number };
    expect(status.cycle).toBeGreaterThan(0);
  });
  it("re-initializes transparently after the session is lost (game restart)", async () => {
    const c = new OniMcpClient({ url });
    await c.connect();
    sim.sessions.clear();
    await expect(c.readJson("oni://world/list")).resolves.toBeInstanceOf(Array);
  });
});

describe("Collector end-to-end", () => {
  it("builds a multi-asteroid snapshot labelled as simulated, and only uses read methods", async () => {
    sim.methodLog = [];
    const col = fast();
    await col.tick();
    const st = col.getState();
    expect(st.connection.state).toBe("connected");
    expect(st.connection.simulated).toBe(true);
    const s = st.snapshot!;
    expect(s.worlds.length).toBe(4);
    const terra = s.worlds.find((w) => w.id === 0)!;
    expect(terra.population).toBe(8);
    expect(terra.power?.generatorRatedW).toBeGreaterThan(0);
    expect(terra.resources.coal.total).toBeGreaterThan(0);
    expect(terra.resources.water.free).toBeGreaterThan(0);
    expect(terra.resources.water.stored).toBeGreaterThan(0);
    expect(s.worlds.find((w) => w.id === 2)!.kind).toBe("rocket");
    expect(s.worlds.find((w) => w.id === 3)!.settled).toBe(false);
    // Per-asteroid food runway must not use OniMcp's global-population figure
    const outpost = s.worlds.find((w) => w.id === 1)!;
    expect(outpost.population).toBe(3);
    expect(new Set(sim.methodLog)).toEqual(new Set(["initialize", "notifications/initialized", "resources/read"]));
    expect(sim.methodLog).not.toContain("tools/call");
  });

  it("accumulates history, computes trends and raises alerts over game time", async () => {
    const col = fast();
    for (let i = 0; i < 8; i++) {
      await col.tick(Date.now());
      await new Promise((r) => setTimeout(r, 120));
    }
    const st = col.getState();
    const coal = st.trends.find((t) => t.worldId === 0 && t.field === "coal")!;
    expect(coal.reliable).toBe(true);
    expect(coal.direction).toBe("decreasing");
    const rules = st.alerts.filter((a) => a.status === "active").map((a) => `${a.rule}:${a.worldId}`);
    expect(rules).toContain("food-runway:1");
    expect(rules).toContain("stress:1");
    expect(st.projections.some((p) => p.label === "Coal" && p.worldId === 0 && p.cycles !== null)).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, "history")).length).toBeGreaterThan(0);
  });

  it("does not record history while paused", async () => {
    const col = fast();
    await col.tick();
    sim.paused = true;
    const before = col.historyFor(0).length;
    await col.tick();
    await col.tick();
    expect(col.historyFor(0).length).toBe(before);
    expect(col.getState().snapshot!.time!.paused).toBe(true);
    sim.paused = false;
  });

  it("reports disconnection and stale data when OniMcp goes away", async () => {
    const col = new Collector({ url: "http://127.0.0.1:1/mcp/", dataDir, requestSpacingMs: 0 });
    await col.tick().catch((e) => (col as unknown as { onFailure(e: unknown): void }).onFailure(e));
    const st = col.getState();
    expect(st.connection.state).toBe("disconnected");
    expect(st.stale).toBe(true);
    expect(st.staleReason).toMatch(/Cannot reach OniMcp/);
    expect(st.snapshot).toBeNull();
  });
});
