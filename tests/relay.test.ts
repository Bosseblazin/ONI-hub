/**
 * End-to-end relay test: real RelayClient (home side) ⇄ real /api/agent/sync route handler (cloud side) over
 * PGlite, with the OniMcp simulator as the game. Simulated data is allowed explicitly (IC_ALLOW_SIMULATED=1)
 * except in the refusal test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassphrase } from "@/lib/auth/crypto";
import { Collector } from "@/lib/collector/collector";
import { DEFAULT_THRESHOLDS } from "@/lib/model/thresholds";
import { OperationsAgent } from "@/lib/ops/agent";
import { Notifier } from "@/lib/ops/notify";
import { SimulatedLlm } from "@/lib/ops/simulated-llm";
import { OpsStore } from "@/lib/ops/store";
import { RelayClient } from "@/lib/relay/client";
import { OniSimulator } from "@/lib/sim/simulator";

const SECRET = "s".repeat(64);
process.env.IC_MODE = "cloud";
process.env.IC_CLOUD_DB = "pglite:memory";
process.env.IC_AGENT_SECRET = SECRET;
process.env.IC_PASSPHRASE_HASH = hashPassphrase("correct horse battery staple");
process.env.IC_ALLOW_SIMULATED = "1";

let sim: OniSimulator;
let server: http.Server;
let mcpUrl: string;
let dir: string;
let syncRoute: typeof import("@/app/api/agent/sync/route");
let backendMod: typeof import("@/lib/server/backend");

beforeAll(async () => {
  sim = new OniSimulator({ accel: 60 });
  server = await sim.listen(0);
  const a = server.address();
  if (typeof a !== "object" || !a) throw new Error("port");
  mcpUrl = `http://127.0.0.1:${a.port}/mcp/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-relay-"));
  syncRoute = await import("@/app/api/agent/sync/route");
  backendMod = await import("@/lib/server/backend");
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** fetch() that dispatches straight into the Next route handler (no HTTP server needed). */
const routeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/api/agent/sync")) return new Response("not found", { status: 404 });
  return syncRoute.POST(new Request(url, init));
}) as typeof fetch;

async function homeSide(secret = SECRET) {
  const collector = new Collector({ url: mcpUrl, dataDir: dir, coreIntervalMs: 50, mediumIntervalMs: 0, slowIntervalMs: 0, historyIntervalMs: 0, requestSpacingMs: 0, thresholds: { ...DEFAULT_THRESHOLDS } });
  const store = new OpsStore(path.join(dir, `h-${Math.random()}`));
  const agent = new OperationsAgent({ collector, store, llm: null, simulatedLlm: new SimulatedLlm(), notifier: new Notifier(store, []), tickMs: 1_000_000 });
  const relay = new RelayClient({ url: "https://ic.example", secret, agentId: "test-home", agentVersion: "t", collector, agent, store, fetchImpl: routeFetch });
  await collector.tick();
  await collector.tick();
  return { collector, store, agent, relay };
}

describe("cloud relay (home agent ⇄ Vercel route)", () => {
  it("syncs state, delivers commands, and reports home-confirmed completion", async () => {
    const { relay, agent, store } = await homeSide();
    const cloud = backendMod.cloudStore();
    expect(await relay.syncOnce()).toBe(true);
    const st = await backendMod.backend().state();
    expect(st.relay.agentOnline).toBe(true);
    expect(st.relay.agentId).toBe("test-home");
    expect(st.dashboard?.snapshot?.worlds.length).toBe(4);

    // Commander (via cloud) issues an instruction; it waits in the queue until the agent syncs.
    const q = await cloud.enqueue({ clientId: "c-relay-instr-1", type: "instruction", payload: { text: "Focus on food on the second asteroid" }, issuedBy: "phone", clientCreatedAt: Date.now() });
    expect(q.status.homeStatus).toBeNull();
    expect((await cloud.getCommand("c-relay-instr-1"))!.deliveredAt).toBeNull();

    await relay.syncOnce(); // delivered + handed to the local agent
    expect(store.getCommand("c-relay-instr-1")).not.toBeNull();
    expect((await cloud.getCommand("c-relay-instr-1"))!.deliveredAt).not.toBeNull();
    await agent.tick(); // processed locally (simulated interpreter)
    expect(store.getCommand("c-relay-instr-1")!.status).toBe("completed");
    expect((await cloud.getCommand("c-relay-instr-1"))!.homeStatus).not.toBe("completed"); // not until the home reports it

    await relay.syncOnce(); // confirms receipt + reports completion
    const done = (await cloud.getCommand("c-relay-instr-1"))!;
    expect(done.homeStatus).toBe("completed");
    expect(await cloud.queuedCount()).toBe(0);

    // A redelivery (e.g. after a crash) is ignored by the agent: same clientId, processed once.
    agent.submit({ clientId: "c-relay-instr-1", type: "instruction", payload: { text: "Focus on food on the second asteroid" }, issuedBy: "phone", clientCreatedAt: null });
    await agent.tick();
    expect(store.recentMessages().filter((m) => m.from === "commander")).toHaveLength(1);

    // History flows incrementally.
    await relay.syncOnce();
    expect((await backendMod.backend().history(1)).length).toBeGreaterThan(0);
  });

  it("rejects a wrong secret and never delivers commands to an impostor", async () => {
    const { relay } = await homeSide("x".repeat(64));
    const cloud = backendMod.cloudStore();
    await cloud.enqueue({ clientId: "c-relay-secret-1", type: "report.request", payload: {}, issuedBy: "phone", clientCreatedAt: null });
    expect(await relay.syncOnce()).toBe(false);
    expect(relay.status().lastError).toMatch(/signature/);
    expect((await cloud.getCommand("c-relay-secret-1"))!.deliveredAt).toBeNull();
  });

  it("production refuses simulated sources entirely (heartbeats included)", async () => {
    delete process.env.IC_ALLOW_SIMULATED;
    try {
      const { relay } = await homeSide();
      expect(await relay.syncOnce()).toBe(false);
      expect(relay.status().lastError).toMatch(/SIMULATED/);
    } finally {
      process.env.IC_ALLOW_SIMULATED = "1";
    }
  });

  it("keeps monitoring locally while the relay is unreachable, and catches up afterwards", async () => {
    const { relay, collector } = await homeSide();
    let down = true;
    (relay as unknown as { f: typeof fetch }).f = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (down) throw new TypeError("fetch failed");
      return routeFetch(i, init);
    }) as typeof fetch;
    expect(await relay.syncOnce()).toBe(false);
    expect(relay.status().consecutiveFailures).toBe(1);
    const before = collector.getState().lastUpdate!;
    await new Promise((r) => setTimeout(r, 20));
    await collector.tick();
    expect(collector.getState().lastUpdate!).toBeGreaterThan(before); // monitoring unaffected
    down = false;
    expect(await relay.syncOnce()).toBe(true);
    expect(relay.status().connected).toBe(true);
  });
});
