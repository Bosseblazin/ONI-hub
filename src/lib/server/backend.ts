import { randomUUID } from "node:crypto";
import { createDb } from "../cloud/db";
import { CloudStore } from "../cloud/store";
import type { DashboardState, HistorySample } from "../model/types";
import type { CommandType, OpsState } from "../ops/types";
import type { RelayCommandStatus, RelayStatus } from "../relay/protocol";
import { home } from "./singleton";

export interface Principal {
  sessionId: string;
  label: string;
}

export interface SessionView {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

export interface LiveState {
  dashboard: DashboardState | null;
  ops: OpsState | null;
  relay: RelayStatus;
  /** Cloud-side delivery state of recent commands (cloud mode only). */
  relayCommands: RelayCommandStatus[];
}

export interface SubmitInput {
  clientId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  issuedBy: string;
  clientCreatedAt: number | null;
}

export interface AuditView {
  intact: boolean | null;
  brokenAt: number | null;
  entries: Array<{ seq: number; at: number; actor: string; event: string; detail: Record<string, unknown> }>;
}

/**
 * Everything the HTTP layer needs, independent of where the colony actually runs.
 *  - local: this process IS the home PC (collector + agent in-process). Original architecture.
 *  - cloud: this process is a stateless Vercel function; state lives in Postgres, fed by the home agent.
 */
export interface Backend {
  readonly mode: "local" | "cloud";
  setupRequired(): Promise<boolean>;
  login(pass: string, clientKey: string, label: string): Promise<{ ok: true; token: string; session: SessionView } | { ok: false; error: string; retryAfterMs?: number }>;
  session(token: string | null): Promise<Principal | null>;
  logout(token: string): Promise<void>;
  listSessions(currentId: string): Promise<SessionView[]>;
  revokeSession(id: string): Promise<boolean>;
  state(): Promise<LiveState>;
  submit(c: SubmitInput): Promise<{ duplicate: boolean; seq: number | null; status: RelayCommandStatus }>;
  command(clientId: string): Promise<RelayCommandStatus | null>;
  history(worldId: number, sinceCycles?: number): Promise<HistorySample[]>;
  audit(): Promise<AuditView>;
  auditEvent(actor: string, event: string, detail?: Record<string, unknown>): Promise<void>;
  screenshot(): Promise<{ at: number; mime: string; data: Buffer } | null>;
}

/* ------------------------------------------------------------------------ local */

class LocalBackend implements Backend {
  readonly mode = "local" as const;
  /** The home service graph is only ever started in local mode (importing it has no side effects). */
  private h() {
    return home();
  }
  async setupRequired() {
    return !this.h().auth.passphraseSet();
  }
  async login(pass: string, clientKey: string, label: string) {
    const r = this.h().auth.login(pass, clientKey, label);
    return r.ok ? { ok: true as const, token: r.token, session: r.session } : r;
  }
  async session(token: string | null) {
    const r = this.h().auth.check(token);
    return r ? { sessionId: r.id, label: r.label } : null;
  }
  async logout(token: string) {
    this.h().auth.logout(token);
  }
  async listSessions(currentId: string) {
    return this.h().auth.list(currentId);
  }
  async revokeSession(id: string) {
    return this.h().auth.revoke(id);
  }
  async state(): Promise<LiveState> {
    const h = this.h();
    const now = Date.now();
    return {
      dashboard: h.collector.getState(),
      ops: h.agent.getState(),
      relay: { mode: "local", agentId: null, agentVersion: null, agentLastSeenAt: now, agentOnline: true, snapshotAt: now, queued: 0, serverTime: now },
      relayCommands: [],
    };
  }
  async submit(c: SubmitInput) {
    const r = this.h().agent.submit(c);
    return { duplicate: r.duplicate, seq: r.command.seq, status: localStatus(r.command) };
  }
  async command(clientId: string) {
    const c = this.h().store.getCommand(clientId);
    return c ? localStatus(c) : null;
  }
  async history(worldId: number, sinceCycles?: number) {
    return this.h().collector.historyFor(worldId, sinceCycles);
  }
  async audit(): Promise<AuditView> {
    const s = this.h().store;
    const broken = s.verifyAudit();
    return { intact: broken === null, brokenAt: broken, entries: s.readAudit(200).reverse() };
  }
  async auditEvent(actor: string, event: string, detail: Record<string, unknown> = {}) {
    this.h().store.audit(actor, event, detail);
  }
  async screenshot() {
    const fs = await import("node:fs");
    const f = this.h().screenshots.latest();
    return f ? { at: fs.statSync(f).mtimeMs, mime: "image/png", data: fs.readFileSync(f) } : null;
  }
}

function localStatus(c: import("../ops/types").Command): RelayCommandStatus {
  return { clientId: c.clientId, type: c.type, queuedAt: c.receivedAt, deliveredAt: c.receivedAt, homeStatus: c.status, result: c.result, error: c.error };
}

/* ------------------------------------------------------------------------ cloud */

class CloudBackend implements Backend {
  readonly mode = "cloud" as const;
  constructor(readonly store: CloudStore) {}
  async setupRequired() {
    return !process.env.IC_PASSPHRASE_HASH;
  }
  async login(pass: string, clientKey: string, label: string) {
    const r = await this.store.login(pass, process.env.IC_PASSPHRASE_HASH, clientKey, label);
    return r.ok ? { ok: true as const, token: r.token, session: { ...r.session, current: true } } : r;
  }
  async session(token: string | null) {
    const s = await this.store.checkSession(token);
    return s ? { sessionId: s.id, label: s.label } : null;
  }
  async logout(token: string) {
    await this.store.logout(token);
  }
  listSessions(currentId: string) {
    return this.store.listSessions(currentId);
  }
  revokeSession(id: string) {
    return this.store.revokeSession(id);
  }
  async state(): Promise<LiveState> {
    const [snap, relay, relayCommands] = await Promise.all([this.store.getSnapshot(), this.store.relayStatus(), this.store.recentCommands(40)]);
    void this.store.markViewer().catch(() => {});
    return { dashboard: snap?.dashboard ?? null, ops: snap?.ops ?? null, relay, relayCommands };
  }
  async submit(c: SubmitInput) {
    const r = await this.store.enqueue(c);
    if (!r.duplicate) await this.store.audit(c.issuedBy, "command.queued", { clientId: c.clientId, type: c.type });
    return { duplicate: r.duplicate, seq: null, status: r.status };
  }
  command(clientId: string) {
    return this.store.getCommand(clientId);
  }
  async history(worldId: number, sinceCycles?: number) {
    const snap = await this.store.getSnapshot();
    return this.store.history(colonyKey(snap?.dashboard.snapshot?.saveName ?? null), worldId, sinceCycles);
  }
  async audit(): Promise<AuditView> {
    // The tamper-evident chain lives on the home PC; the cloud log records sign-ins and relay events.
    return { intact: null, brokenAt: null, entries: await this.store.readAudit(200) };
  }
  async auditEvent(actor: string, event: string, detail: Record<string, unknown> = {}) {
    await this.store.audit(actor, event, detail);
  }
  screenshot() {
    return this.store.getScreenshot();
  }
}

export const colonyKey = (saveName: string | null) => (saveName ?? "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || "unknown";

declare global {
  // eslint-disable-next-line no-var
  var __icBackend: Backend | undefined;
}

export const isCloud = () => process.env.IC_MODE === "cloud";

export function backend(): Backend {
  if (!globalThis.__icBackend) {
    if (isCloud()) {
      const spec = process.env.IC_CLOUD_DB || process.env.DATABASE_URL || process.env.POSTGRES_URL;
      if (!spec) throw new Error("Cloud mode needs DATABASE_URL (Vercel ⇄ Neon integration) or IC_CLOUD_DB.");
      globalThis.__icBackend = new CloudBackend(new CloudStore(createDb(spec)));
    } else {
      globalThis.__icBackend = new LocalBackend();
    }
  }
  return globalThis.__icBackend;
}

export function cloudStore(): CloudStore {
  const b = backend();
  if (!(b instanceof CloudBackend)) throw new Error("not in cloud mode");
  return b.store;
}

export const newRequestId = () => randomUUID();
