import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "@/lib/auth/auth";
import { authorize, confirmationPhrase } from "@/lib/ops/authorization";
import { Notifier, type Channel } from "@/lib/ops/notify";
import { COMPLETION_STREAK, createObjective, evaluateObjectives, metricValue, survivalRecommended } from "@/lib/ops/objectives";
import { OpsStore } from "@/lib/ops/store";
import type { NotificationRecord } from "@/lib/ops/types";
import { DEFAULT_THRESHOLDS as TH } from "@/lib/model/thresholds";
import { dupe, snap, world } from "./fixtures";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-ops-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("AuthService", () => {
  it("rejects short passphrases and never stores plain text", () => {
    const a = new AuthService(dir);
    expect(() => a.setPassphrase("short")).toThrow(/12/);
    a.setPassphrase("correct horse battery staple");
    const raw = fs.readFileSync(path.join(dir, "auth", "passphrase.json"), "utf8");
    expect(raw).not.toContain("horse");
  });
  it("issues sessions on the right passphrase only; tokens are stored hashed", () => {
    const a = new AuthService(dir);
    a.setPassphrase("correct horse battery staple");
    expect(a.login("wrong passphrase!!", "c1", "phone").ok).toBe(false);
    const r = a.login("correct horse battery staple", "c1", "phone");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(a.check(r.token)?.label).toBe("phone");
    expect(fs.readFileSync(path.join(dir, "auth", "sessions.json"), "utf8")).not.toContain(r.token);
    expect(new AuthService(dir).check(r.token)).not.toBeNull(); // survives restart
  });
  it("locks out after repeated failures", () => {
    const a = new AuthService(dir);
    a.setPassphrase("correct horse battery staple");
    for (let i = 0; i < 3; i++) a.login("nope nope nope", "attacker", "x");
    const r = a.login("correct horse battery staple", "attacker", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(a.login("correct horse battery staple", "someone-else", "x").ok).toBe(true);
  });
  it("revocation and passphrase change end sessions", () => {
    const a = new AuthService(dir);
    a.setPassphrase("correct horse battery staple");
    const r1 = a.login("correct horse battery staple", "c", "a");
    const r2 = a.login("correct horse battery staple", "c", "b");
    if (!r1.ok || !r2.ok) throw new Error("login");
    a.revoke(r1.session.id);
    expect(a.check(r1.token)).toBeNull();
    expect(a.check(r2.token)).not.toBeNull();
    a.setPassphrase("another long passphrase here");
    expect(a.check(r2.token)).toBeNull();
  });
});

describe("OpsStore", () => {
  it("is idempotent on clientId across restarts (no duplicate commands after reconnect)", () => {
    const s = new OpsStore(dir);
    const a = s.enqueue({ clientId: "abcdefgh1", type: "instruction", payload: { text: "hi" }, issuedBy: "phone", clientCreatedAt: 1 });
    const b = s.enqueue({ clientId: "abcdefgh1", type: "instruction", payload: { text: "hi" }, issuedBy: "phone", clientCreatedAt: 1 });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.command.seq).toBe(a.command.seq);
    s.updateCommand("abcdefgh1", { status: "completed", result: "ok" });
    const s2 = new OpsStore(dir);
    const c = s2.enqueue({ clientId: "abcdefgh1", type: "instruction", payload: { text: "hi" }, issuedBy: "phone", clientCreatedAt: 1 });
    expect(c.duplicate).toBe(true);
    expect(c.command.status).toBe("completed");
    expect(s2.pendingCommands()).toHaveLength(0);
    expect(s2.enqueue({ clientId: "zzzzzzzz2", type: "report.request", payload: {}, issuedBy: "p", clientCreatedAt: null }).command.seq).toBe(2);
  });
  it("keeps a tamper-evident audit chain", () => {
    const s = new OpsStore(dir);
    s.audit("a", "x", { n: 1 });
    s.audit("a", "y", { n: 2 });
    s.audit("a", "z", { n: 3 });
    expect(s.verifyAudit()).toBeNull();
    const f = path.join(dir, "ops", "audit.jsonl");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"n":2', '"n":99'));
    expect(s.verifyAudit()).toBe(2);
  });
  it("always starts at permission level 1", () => {
    const s = new OpsStore(dir);
    s.mutate((x) => ((x as { permissionLevel: number }).permissionLevel = 3));
    expect(new OpsStore(dir).state.permissionLevel).toBe(1);
  });
});

describe("objectives", () => {
  const s = snap([world({ id: 0, foodKcal: 4000 }), world({ id: 1, name: "Outpost", foodKcal: 40_000 })]);
  it("measures metrics per world and colony-wide (worst case)", () => {
    expect(metricValue("foodRunwayCycles", 1, s, [], TH)).toBe(10);
    expect(metricValue("foodRunwayCycles", null, s, [], TH)).toBe(1);
  });
  it("completes only after the criteria hold for consecutive checks", () => {
    const o = createObjective({ title: "Food", description: "", worldId: 1, priority: 2, completionCriteria: "", criteria: [{ metric: "foodRunwayCycles", worldId: 1, op: ">=", value: 8 }], dependencies: [], constraints: [] }, "commander", "Outpost", null);
    for (let i = 1; i < COMPLETION_STREAK; i++) {
      expect(evaluateObjectives([o], s, [], TH, 1)).toHaveLength(0);
      expect(o.progress).toBe(100);
    }
    expect(evaluateObjectives([o], s, [], TH, 1)).toHaveLength(1);
    expect(o.status).toBe("completed");
  });
  it("reports partial progress and resets the streak on regression", () => {
    const o = createObjective({ title: "Food", description: "", worldId: 0, priority: 2, completionCriteria: "", criteria: [{ metric: "foodRunwayCycles", worldId: 0, op: ">=", value: 4 }], dependencies: [], constraints: [] }, "commander", null, null);
    evaluateObjectives([o], s, [], TH, 1);
    expect(o.progress).toBe(25);
    expect(o.progressNote).toMatch(/✗/);
  });
  it("recommends Survival only on life-support CRITICAL alerts", () => {
    const a = { status: "active", severity: "CRITICAL", rule: "starving", title: "Starving", worldName: "X" } as never;
    expect(survivalRecommended("expansion", [a]).recommend).toBe(true);
    expect(survivalRecommended("survival", [a]).recommend).toBe(false);
    expect(survivalRecommended("expansion", [{ ...(a as object), rule: "temperature" } as never]).recommend).toBe(false);
  });
});

describe("authorization policy", () => {
  const p = { id: "act_1234567890abcdef", category: "priorities" as const, risk: "routine" as const, status: "proposed" as const };
  it("Level 1 never executes, even with approval", () => {
    expect(authorize(p, { level: 1, executionLayerEnabled: true, grantedCategories: ["priorities"], approval: { proposalId: p.id } }).verdict).toBe("deny");
  });
  it("never executes while the execution layer is disabled", () => {
    expect(authorize(p, { level: 3, executionLayerEnabled: false, grantedCategories: ["priorities"], approval: { proposalId: p.id } }).verdict).toBe("deny");
  });
  it("Level 2 requires approval of that exact proposal", () => {
    const ctx = { level: 2 as const, executionLayerEnabled: true, grantedCategories: [] };
    expect(authorize(p, { ...ctx, approval: null }).verdict).toBe("needs_approval");
    expect(authorize(p, { ...ctx, approval: { proposalId: "other" } }).verdict).toBe("needs_approval");
    expect(authorize(p, { ...ctx, approval: { proposalId: p.id } }).verdict).toBe("execute");
  });
  it("Level 3 auto-executes only routine actions in granted categories", () => {
    const ctx = { level: 3 as const, executionLayerEnabled: true, approval: null };
    expect(authorize(p, { ...ctx, grantedCategories: ["priorities"] }).verdict).toBe("execute");
    expect(authorize(p, { ...ctx, grantedCategories: ["schedules"] }).verdict).toBe("needs_approval");
    expect(authorize({ ...p, risk: "elevated" }, { ...ctx, grantedCategories: ["priorities"] }).verdict).toBe("needs_approval");
    expect(authorize({ ...p, category: "deconstruction" }, { ...ctx, grantedCategories: ["deconstruction"] }).verdict).toBe("needs_approval");
  });
  it("destructive actions need a typed confirmation on top of approval", () => {
    const d = { ...p, risk: "destructive" as const, category: "dig" as const };
    const ctx = { level: 2 as const, executionLayerEnabled: true, grantedCategories: [] };
    expect(authorize(d, { ...ctx, approval: { proposalId: d.id } }).verdict).toBe("needs_approval");
    expect(authorize(d, { ...ctx, approval: { proposalId: d.id, confirmationText: confirmationPhrase(d) } }).verdict).toBe("execute");
  });
});

describe("Notifier", () => {
  class Mem implements Channel {
    name = "mem";
    sent: NotificationRecord[] = [];
    configured() { return true; }
    async send(n: NotificationRecord) { this.sent.push(n); }
  }
  it("respects severity floor, cooldown, escalation and category toggles", async () => {
    const st = new OpsStore(dir);
    const ch = new Mem();
    const n = new Notifier(st, [ch]);
    const base = { category: "food" as const, title: "Food", body: "b", key: "k" };
    expect(await n.notify({ ...base, severity: "INFO" }, 0)).toBeNull(); // below WARNING floor
    expect(await n.notify({ ...base, severity: "WARNING" }, 0)).not.toBeNull();
    expect(await n.notify({ ...base, severity: "WARNING" }, 60_000)).toBeNull(); // cooldown
    expect(await n.notify({ ...base, severity: "CRITICAL" }, 120_000)).not.toBeNull(); // escalation bypasses
    st.mutate((s) => (s.notificationPrefs.categories.food = false));
    expect(await n.notify({ ...base, severity: "CRITICAL", key: "k2" }, 0)).toBeNull();
    expect(ch.sent).toHaveLength(2);
  });
  it("notifies on raised/escalated alerts, never on unchanged ones", async () => {
    const st = new OpsStore(dir);
    const ch = new Mem();
    const n = new Notifier(st, [ch]);
    const alert = (sev: "WARNING" | "CRITICAL") => ({ id: "food-runway:1", rule: "food-runway", severity: sev, status: "active", title: "Food low", what: "w", urgency: "u", worldName: "Outpost" }) as never;
    await n.fromAlerts(new Map(), [alert("WARNING")]);
    await n.fromAlerts(new Map([["food-runway:1", "WARNING"]]), [alert("WARNING")]);
    await n.fromAlerts(new Map([["food-runway:1", "WARNING"]]), [alert("CRITICAL")]);
    expect(ch.sent.map((x) => x.severity)).toEqual(["WARNING", "CRITICAL"]);
  });
});

void dupe;
