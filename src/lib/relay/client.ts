import fs from "node:fs";
import { gzipSync } from "node:zlib";
import type { Collector } from "../collector/collector";
import type { OperationsAgent } from "../ops/agent";
import type { ScreenshotService } from "../ops/home";
import type { OpsStore } from "../ops/store";
import { RELAY_PROTOCOL, signRequest, type CommandReport, type SyncRequest, type SyncResponse } from "./protocol";

export interface RelayClientOptions {
  /** Base URL of the cloud deployment, e.g. https://interplanetary-command.vercel.app */
  url: string;
  secret: string;
  agentId: string;
  agentVersion: string;
  collector: Collector;
  agent: OperationsAgent;
  store: OpsStore;
  screenshots?: ScreenshotService;
  fetchImpl?: typeof fetch;
  /** Sync cadence while someone is watching or commands are flowing. */
  fastMs?: number;
  /** Sync cadence when idle. */
  idleMs?: number;
  /** Full snapshot at least this often even when nobody is watching. */
  idleSnapshotMs?: number;
}

export interface RelayLinkStatus {
  url: string;
  connected: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  viewerActive: boolean;
}

const TERMINAL = new Set(["completed", "failed"]);

/**
 * Outbound-only link from the home PC to the cloud relay. The home PC never accepts inbound connections;
 * it polls the relay over HTTPS, signing every request with IC_AGENT_SECRET.
 * Monitoring and the Operations Agent keep running locally whatever happens to this link.
 */
export class RelayClient {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private syncing = false;
  private lastSyncAt: number | null = null;
  private lastSnapshotAt = 0;
  private lastError: string | null = null;
  private failures = 0;
  private viewerActive = false;
  private wantSnapshot = true;
  private historyCursor: number | null = null;
  private lastCommandAt = 0;
  private toConfirm = new Set<string>();
  /** Last status we successfully reported per clientId; only changes are sent. */
  private reported = new Map<string, string>();
  private lastScreenshotUploaded = 0;
  private readonly f: typeof fetch;
  private readonly o: Required<Omit<RelayClientOptions, "screenshots" | "fetchImpl">> & Pick<RelayClientOptions, "screenshots">;

  constructor(opts: RelayClientOptions) {
    this.f = opts.fetchImpl ?? fetch;
    this.o = { fastMs: 2000, idleMs: 10_000, idleSnapshotMs: 30_000, ...opts, url: opts.url.replace(/\/$/, "") };
  }

  status(): RelayLinkStatus {
    return { url: this.o.url, connected: this.failures === 0 && this.lastSyncAt !== null, lastSyncAt: this.lastSyncAt, lastError: this.lastError, consecutiveFailures: this.failures, viewerActive: this.viewerActive };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.o.store.audit("agent", "relay.started", { url: this.o.url, agentId: this.o.agentId });
    void this.loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop() {
    if (!this.running) return;
    await this.syncOnce();
    const busy = this.viewerActive || Date.now() - this.lastCommandAt < 60_000 || this.o.store.pendingCommands().length > 0;
    const base = busy ? this.o.fastMs : this.o.idleMs;
    const delay = this.failures ? Math.min(30_000, 2000 * 2 ** Math.min(this.failures - 1, 4)) : base;
    this.timer = setTimeout(() => void this.loop(), delay);
  }

  private reports(): CommandReport[] {
    const out: CommandReport[] = [];
    for (const c of this.o.store.recentCommands(200)) {
      const key = `${c.status}|${c.result ?? ""}|${c.error ?? ""}`;
      if (this.reported.get(c.clientId) === key) continue;
      out.push({ clientId: c.clientId, status: c.status, homeSeq: c.seq, result: c.result, error: c.error, processedAt: c.processedAt });
    }
    return out;
  }

  /** One signed round trip. Public for tests. */
  async syncOnce(now = Date.now()): Promise<boolean> {
    if (this.syncing) return false;
    // Don't report until the collector has tried the game once: we must know whether the source is simulated.
    if (this.o.collector.getState().connection.lastAttemptAt === null) return false;
    this.syncing = true;
    try {
      const dash = this.o.collector.getState();
      const sendSnapshot = this.wantSnapshot || this.viewerActive || now - this.lastSnapshotAt >= this.o.idleSnapshotMs;
      const reports = this.reports();
      const confirm = [...this.toConfirm];
      const history = this.historyCursor === null ? [] : this.o.collector.historySince(this.historyCursor, 2000);
      const req: SyncRequest = {
        protocol: RELAY_PROTOCOL,
        agentId: this.o.agentId,
        agentVersion: this.o.agentVersion,
        sentAt: now,
        simulated: dash.connection.simulated,
        snapshot: sendSnapshot ? { dashboard: dash, ops: this.o.agent.getState(now) } : null,
        history,
        reports,
        receivedClientIds: confirm,
      };
      const body = gzipSync(Buffer.from(JSON.stringify(req)));
      const r = await this.f(`${this.o.url}/api/agent/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-IC-Body-Encoding": "gzip", "X-IC-Agent": this.o.agentId, ...signRequest(this.o.secret, "POST", "/api/agent/sync", body, now) },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          msg = (JSON.parse(text) as { error?: string }).error ?? msg;
        } catch {
          /* not json */
        }
        throw new Error(msg);
      }
      const res = JSON.parse(text) as SyncResponse;

      // The cloud stored everything we sent: commit local bookkeeping.
      for (const id of confirm) this.toConfirm.delete(id);
      for (const rep of reports) this.reported.set(rep.clientId, `${rep.status}|${rep.result ?? ""}|${rep.error ?? ""}`);
      for (const [id] of this.reported) if (this.reported.size > 1000) this.reported.delete(id);
      if (sendSnapshot) this.lastSnapshotAt = now;
      this.historyCursor = res.historyCursor;
      this.viewerActive = res.viewerActive;
      this.wantSnapshot = res.wantSnapshot;
      if (this.failures > 0) this.o.store.audit("agent", "relay.restored", { after: this.failures });
      this.failures = 0;
      this.lastError = null;
      this.lastSyncAt = Date.now();

      // Hand new commands to the local agent (idempotent by clientId), then confirm receipt promptly.
      for (const c of res.commands) {
        this.o.agent.submit({ clientId: c.clientId, type: c.type, payload: c.payload, issuedBy: c.issuedBy, clientCreatedAt: c.clientCreatedAt });
        this.toConfirm.add(c.clientId);
        this.lastCommandAt = Date.now();
      }
      if (res.commands.length) setTimeout(() => void this.syncOnce(), 50);
      await this.maybeUploadScreenshot();
      return true;
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message;
      if (this.failures === 1 || this.failures % 20 === 0) this.o.store.audit("agent", "relay.error", { message: this.lastError, failures: this.failures });
      return false;
    } finally {
      this.syncing = false;
    }
  }

  private async maybeUploadScreenshot() {
    const s = this.o.screenshots;
    if (!s?.lastCaptureAt || s.lastCaptureAt <= this.lastScreenshotUploaded) return;
    const f = s.latest();
    if (!f) return;
    const data = fs.readFileSync(f);
    this.lastScreenshotUploaded = s.lastCaptureAt;
    if (data.length > 3_000_000) return;
    const ts = Date.now();
    await this.f(`${this.o.url}/api/agent/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-IC-Agent": this.o.agentId, ...signRequest(this.o.secret, "POST", "/api/agent/screenshot", data, ts) },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  }
}

export { TERMINAL };
