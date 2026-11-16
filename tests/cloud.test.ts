import { describe, expect, it } from "vitest";
import { hashPassphrase } from "@/lib/auth/crypto";
import { createDb } from "@/lib/cloud/db";
import { CloudStore } from "@/lib/cloud/store";
import { signRequest, verifyRequest } from "@/lib/relay/protocol";

const SECRET = "x".repeat(48);
const hdrs = (h: Record<string, string>) => ({ get: (k: string) => h[Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase()) ?? ""] ?? null });

describe("relay request signing", () => {
  it("accepts a correctly signed request", () => {
    const body = JSON.stringify({ a: 1 });
    const h = signRequest(SECRET, "POST", "/api/agent/sync", body);
    expect(verifyRequest(SECRET, hdrs(h), "POST", "/api/agent/sync", body)).toEqual({ ok: true });
  });
  it("rejects tampering, wrong path, wrong secret and replays outside the window", () => {
    const body = JSON.stringify({ a: 1 });
    const h = signRequest(SECRET, "POST", "/api/agent/sync", body);
    expect(verifyRequest(SECRET, hdrs(h), "POST", "/api/agent/sync", body.replace("1", "2")).ok).toBe(false);
    expect(verifyRequest(SECRET, hdrs(h), "POST", "/api/agent/other", body).ok).toBe(false);
    expect(verifyRequest("y".repeat(48), hdrs(h), "POST", "/api/agent/sync", body).ok).toBe(false);
    const old = signRequest(SECRET, "POST", "/api/agent/sync", body, Date.now() - 10 * 60_000);
    expect(verifyRequest(SECRET, hdrs(old), "POST", "/api/agent/sync", body)).toMatchObject({ ok: false, reason: /window/ });
  });
  it("refuses to run with a missing or weak secret", () => {
    const h = signRequest("short", "POST", "/p", "");
    expect(verifyRequest("short", hdrs(h), "POST", "/p", "").ok).toBe(false);
    expect(verifyRequest(undefined, hdrs(h), "POST", "/p", "").ok).toBe(false);
  });
});

describe("CloudStore (Postgres via PGlite)", () => {
  const mk = () => new CloudStore(createDb("pglite:memory"));

  it("enqueues idempotently and only home reports can complete a command", async () => {
    const s = mk();
    const a = await s.enqueue({ clientId: "c-aaaaaaaa", type: "instruction", payload: { text: "hi" }, issuedBy: "phone", clientCreatedAt: 1 });
    const b = await s.enqueue({ clientId: "c-aaaaaaaa", type: "instruction", payload: { text: "hi" }, issuedBy: "phone", clientCreatedAt: 1 });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.status.homeStatus).toBeNull();
    expect(await s.queuedCount()).toBe(1);

    const t0 = Date.now();
    const d1 = await s.takeForDelivery(t0);
    expect(d1.map((x) => x.clientId)).toEqual(["c-aaaaaaaa"]);
    expect(await s.takeForDelivery(t0 + 1000)).toHaveLength(0); // in flight, not redelivered yet
    expect(await s.takeForDelivery(t0 + 31_000)).toHaveLength(1); // agent never confirmed → redelivered

    await s.applyReports(["c-aaaaaaaa"], []);
    expect((await s.getCommand("c-aaaaaaaa"))!.homeStatus).toBe("received");
    expect(await s.takeForDelivery(t0 + 120_000)).toHaveLength(0); // received → never redelivered

    await s.applyReports([], [{ clientId: "c-aaaaaaaa", status: "completed", homeSeq: 7, result: "ok", error: null, processedAt: t0 }]);
    const c = (await s.getCommand("c-aaaaaaaa"))!;
    expect(c.homeStatus).toBe("completed");
    expect(c.result).toBe("ok");
    expect(await s.queuedCount()).toBe(0);
  });

  it("delivers in queue order", async () => {
    const s = mk();
    for (const [i, id] of ["c-111111111", "c-222222222", "c-333333333"].entries()) {
      await s.enqueue({ clientId: id, type: "report.request", payload: {}, issuedBy: "p", clientCreatedAt: null }, 1000 + i);
    }
    expect((await s.takeForDelivery()).map((x) => x.clientId)).toEqual(["c-111111111", "c-222222222", "c-333333333"]);
  });

  it("authenticates against the configured hash, throttles, and manages sessions", async () => {
    const s = mk();
    const hash = hashPassphrase("correct horse battery staple");
    expect((await s.login("whatever passphrase", undefined, "k", "x")).ok).toBe(false); // not configured
    expect((await s.login("wrong wrong wrong", hash, "k1", "x")).ok).toBe(false);
    const ok = await s.login("correct horse battery staple", hash, "k1", "phone");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect((await s.checkSession(ok.token))?.label).toBe("phone");
    expect(await s.checkSession("forged-token")).toBeNull();
    for (let i = 0; i < 3; i++) await s.login("nope nope nope", hash, "attacker", "x");
    const blocked = await s.login("correct horse battery staple", hash, "attacker", "x");
    expect(blocked.ok).toBe(false);
    expect(await s.revokeSession(ok.session.id)).toBe(true);
    expect(await s.checkSession(ok.token)).toBeNull();
  });

  it("stores snapshots, agent heartbeat and history per colony", async () => {
    const s = mk();
    const now = Date.now();
    expect((await s.relayStatus(now)).agentOnline).toBe(false);
    await s.recordAgentSync("homepc", "1.0", now);
    expect((await s.relayStatus(now + 1000)).agentOnline).toBe(true);
    expect((await s.relayStatus(now + 60_000)).agentOnline).toBe(false);
    await s.saveSnapshot({ dashboard: { lastUpdate: 5 } as never, ops: {} as never });
    expect((await s.getSnapshot())!.dashboard.lastUpdate).toBe(5);
    const row = (t: number, c: number) => ({ t, c, w: 1, pop: 3 }) as never;
    const cur = await s.appendHistory("my-save", [row(now, 10), row(now + 1, 10.1), row(now + 1, 10.1)]);
    expect(cur).toBe(now + 1);
    expect(await s.history("my-save", 1)).toHaveLength(2);
    expect(await s.history("other-save", 1)).toHaveLength(0);
    expect(await s.history("my-save", 1, 10.05)).toHaveLength(1);
  });
});
