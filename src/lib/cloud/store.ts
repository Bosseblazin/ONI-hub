import { lockoutMs, newPublicId, newToken, sha256hex, verifyPassphrase } from "../auth/crypto";
import type { DashboardState, HistorySample } from "../model/types";
import type { CommandType, OpsState } from "../ops/types";
import { AGENT_OFFLINE_AFTER_MS, type CommandReport, type RelayCommand, type RelayCommandStatus, type RelayStatus } from "../relay/protocol";
import { migrate, type Db } from "./db";

const SESSION_TTL_MS = 30 * 86400_000;
const REDELIVER_AFTER_MS = 30_000;
const HISTORY_RETENTION_MS = 14 * 86400_000;

export interface CloudSession {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface CommandRow {
  client_id: string;
  type: CommandType;
  payload: Record<string, unknown>;
  issued_by: string;
  client_created_at: number | null;
  queued_at: number;
  delivered_at: number | null;
  home_status: RelayCommandStatus["homeStatus"];
  home_seq: number | null;
  result: string | null;
  error: string | null;
  processed_at: number | null;
}

const toStatus = (r: CommandRow): RelayCommandStatus => ({
  clientId: r.client_id,
  type: r.type,
  payload: r.payload,
  issuedBy: r.issued_by,
  queuedAt: Number(r.queued_at),
  deliveredAt: r.delivered_at === null ? null : Number(r.delivered_at),
  homeStatus: r.home_status,
  result: r.result,
  error: r.error,
});

/**
 * Durable relay state in Postgres. Vercel functions are stateless; everything that must outlive a request
 * — the command queue, the latest colony snapshot, sessions, login throttling, history — lives here.
 */
export class CloudStore {
  constructor(readonly db: Db) {}

  private async ready() {
    await migrate(this.db);
  }

  /* --------------------------------------------------------------------- meta */

  private async getMeta<T>(key: string): Promise<{ value: T; updatedAt: number } | null> {
    const r = await this.db.query<{ value: T; updated_at: number }>(`SELECT value, updated_at FROM ic_meta WHERE key = $1`, [key]);
    return r[0] ? { value: r[0].value, updatedAt: Number(r[0].updated_at) } : null;
  }

  private async setMeta(key: string, value: unknown, now = Date.now()) {
    await this.db.query(
      `INSERT INTO ic_meta (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), now],
    );
  }

  /* ------------------------------------------------------------------ auth */

  async login(pass: string, passphraseHash: string | undefined, clientKey: string, label: string, now = Date.now()): Promise<{ ok: true; token: string; session: CloudSession } | { ok: false; error: string; retryAfterMs?: number }> {
    await this.ready();
    if (!passphraseHash) return { ok: false, error: "Sign-in is not configured on this deployment (IC_PASSPHRASE_HASH is missing)." };
    const f = (await this.db.query<{ count: number; locked_until: number }>(`SELECT count, locked_until FROM ic_login_failures WHERE client_key = $1`, [clientKey]))[0];
    const global = (await this.db.query<{ n: number }>(`SELECT COALESCE(SUM(count),0)::int AS n FROM ic_login_failures WHERE updated_at > $1`, [now - 3600_000]))[0]?.n ?? 0;
    const locked = Math.max(f ? Number(f.locked_until) - now : 0, global >= 50 ? 15 * 60_000 : 0);
    if (locked > 0) return { ok: false, error: "Too many attempts. Try again later.", retryAfterMs: locked };
    if (!verifyPassphrase(pass, passphraseHash)) {
      const count = (f?.count ?? 0) + 1;
      await this.db.query(
        `INSERT INTO ic_login_failures (client_key, count, locked_until, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_key) DO UPDATE SET count = EXCLUDED.count, locked_until = EXCLUDED.locked_until, updated_at = EXCLUDED.updated_at`,
        [clientKey, count, now + lockoutMs(count), now],
      );
      return { ok: false, error: "Incorrect passphrase." };
    }
    await this.db.query(`DELETE FROM ic_login_failures WHERE client_key = $1`, [clientKey]);
    const token = newToken();
    const s: CloudSession = { id: newPublicId(), label: label.slice(0, 80) || "device", createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS };
    await this.db.query(`INSERT INTO ic_sessions (id, token_hash, label, created_at, last_seen_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [s.id, sha256hex(token), s.label, now, now, s.expiresAt]);
    return { ok: true, token, session: s };
  }

  /** Validate a session token (sliding expiry, refreshed at most once a minute). */
  async checkSession(token: string | null | undefined, now = Date.now()): Promise<CloudSession | null> {
    if (!token || token.length > 200) return null;
    await this.ready();
    const r = (await this.db.query<{ id: string; label: string; created_at: number; last_seen_at: number; expires_at: number }>(
      `SELECT id, label, created_at, last_seen_at, expires_at FROM ic_sessions WHERE token_hash = $1 AND expires_at > $2`,
      [sha256hex(token), now],
    ))[0];
    if (!r) return null;
    if (now - Number(r.last_seen_at) > 60_000) {
      await this.db.query(`UPDATE ic_sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1`, [r.id, now, now + SESSION_TTL_MS]);
    }
    return { id: r.id, label: r.label, createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at), expiresAt: Number(r.expires_at) };
  }

  async logout(token: string) {
    await this.ready();
    await this.db.query(`DELETE FROM ic_sessions WHERE token_hash = $1`, [sha256hex(token)]);
  }

  async listSessions(currentId?: string) {
    await this.ready();
    const rows = await this.db.query<{ id: string; label: string; created_at: number; last_seen_at: number; expires_at: number }>(
      `SELECT id, label, created_at, last_seen_at, expires_at FROM ic_sessions WHERE expires_at > $1 ORDER BY last_seen_at DESC`,
      [Date.now()],
    );
    return rows.map((r) => ({ id: r.id, label: r.label, createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at), expiresAt: Number(r.expires_at), current: r.id === currentId }));
  }

  async revokeSession(id: string): Promise<boolean> {
    await this.ready();
    return (await this.db.query(`DELETE FROM ic_sessions WHERE id = $1 RETURNING id`, [id])).length > 0;
  }

  async sessionCount(): Promise<number> {
    await this.ready();
    return (await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ic_sessions WHERE expires_at > $1`, [Date.now()]))[0]?.n ?? 0;
  }

  /* -------------------------------------------------------------- commands */

  /** Idempotent enqueue: the same clientId always maps to one row. */
  async enqueue(c: { clientId: string; type: CommandType; payload: Record<string, unknown>; issuedBy: string; clientCreatedAt: number | null }, now = Date.now()): Promise<{ status: RelayCommandStatus; duplicate: boolean }> {
    await this.ready();
    const ins = await this.db.query<CommandRow>(
      `INSERT INTO ic_commands (client_id, type, payload, issued_by, client_created_at, queued_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6) ON CONFLICT (client_id) DO NOTHING RETURNING *`,
      [c.clientId, c.type, JSON.stringify(c.payload), c.issuedBy, c.clientCreatedAt, now],
    );
    if (ins[0]) return { status: toStatus(ins[0]), duplicate: false };
    const ex = (await this.db.query<CommandRow>(`SELECT * FROM ic_commands WHERE client_id = $1`, [c.clientId]))[0]!;
    return { status: toStatus(ex), duplicate: true };
  }

  async getCommand(clientId: string): Promise<RelayCommandStatus | null> {
    await this.ready();
    const r = (await this.db.query<CommandRow>(`SELECT * FROM ic_commands WHERE client_id = $1`, [clientId]))[0];
    return r ? toStatus(r) : null;
  }

  async recentCommands(limit = 50): Promise<RelayCommandStatus[]> {
    await this.ready();
    return (await this.db.query<CommandRow>(`SELECT * FROM ic_commands ORDER BY queued_at DESC LIMIT $1`, [limit])).map(toStatus);
  }

  /**
   * Hand pending commands to the home agent: never delivered, or delivered > 30 s ago without the agent
   * confirming receipt (it may have crashed). The agent de-duplicates by clientId, so redelivery is safe.
   */
  async takeForDelivery(now = Date.now(), limit = 50): Promise<RelayCommand[]> {
    await this.ready();
    const rows = await this.db.query<CommandRow>(
      `UPDATE ic_commands SET delivered_at = $1, delivery_count = delivery_count + 1, updated_at = $1
       WHERE client_id IN (
         SELECT client_id FROM ic_commands
         WHERE home_status IS NULL AND (delivered_at IS NULL OR delivered_at < $2)
         ORDER BY queued_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [now, now - REDELIVER_AFTER_MS, limit],
    );
    return rows
      .sort((a, b) => Number(a.queued_at) - Number(b.queued_at))
      .map((r) => ({ clientId: r.client_id, type: r.type, payload: r.payload, issuedBy: r.issued_by, clientCreatedAt: r.client_created_at === null ? null : Number(r.client_created_at), queuedAt: Number(r.queued_at) }));
  }

  /** Apply the home agent's authoritative statuses. The cloud never sets a terminal status itself. */
  async applyReports(received: string[], reports: CommandReport[], now = Date.now()) {
    await this.ready();
    if (received.length) {
      await this.db.query(`UPDATE ic_commands SET home_status = 'received', updated_at = $2 WHERE client_id = ANY($1::text[]) AND home_status IS NULL`, [received, now]);
    }
    for (const r of reports.slice(0, 200)) {
      await this.db.query(
        `UPDATE ic_commands SET home_status = $2, home_seq = $3, result = $4, error = $5, processed_at = $6, updated_at = $7
         WHERE client_id = $1 AND (home_status IS DISTINCT FROM $2 OR result IS DISTINCT FROM $4 OR error IS DISTINCT FROM $5)`,
        [r.clientId, r.status, r.homeSeq, r.result, r.error, r.processedAt, now],
      );
    }
  }

  async queuedCount(): Promise<number> {
    await this.ready();
    return (await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ic_commands WHERE home_status IS NULL`))[0]?.n ?? 0;
  }

  /* --------------------------------------------------------- agent & state */

  async recordAgentSync(agentId: string, agentVersion: string, now = Date.now()) {
    await this.ready();
    await this.setMeta("agent", { agentId, agentVersion, lastSeenAt: now }, now);
  }

  async saveSnapshot(snapshot: { dashboard: DashboardState; ops: OpsState }, now = Date.now()) {
    await this.ready();
    await this.setMeta("snapshot", snapshot, now);
  }

  async getSnapshot(): Promise<{ dashboard: DashboardState; ops: OpsState; at: number } | null> {
    await this.ready();
    const m = await this.getMeta<{ dashboard: DashboardState; ops: OpsState }>("snapshot");
    return m ? { ...m.value, at: m.updatedAt } : null;
  }

  async markViewer(now = Date.now()) {
    await this.ready();
    await this.db.query(
      `INSERT INTO ic_meta (key, value, updated_at) VALUES ('viewer', '{}'::jsonb, $1)
       ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at WHERE ic_meta.updated_at < $1 - 5000`,
      [now],
    );
  }

  async viewerActive(now = Date.now()): Promise<boolean> {
    const m = await this.getMeta("viewer");
    return !!m && now - m.updatedAt < 60_000;
  }

  async relayStatus(now = Date.now()): Promise<RelayStatus> {
    await this.ready();
    const agent = await this.getMeta<{ agentId: string; agentVersion: string; lastSeenAt: number }>("agent");
    const snap = (await this.db.query<{ updated_at: number }>(`SELECT updated_at FROM ic_meta WHERE key = 'snapshot'`))[0];
    const last = agent?.value.lastSeenAt ?? null;
    return {
      mode: "cloud",
      agentId: agent?.value.agentId ?? null,
      agentVersion: agent?.value.agentVersion ?? null,
      agentLastSeenAt: last,
      agentOnline: last !== null && now - last < AGENT_OFFLINE_AFTER_MS,
      snapshotAt: snap ? Number(snap.updated_at) : null,
      queued: await this.queuedCount(),
      serverTime: now,
    };
  }

  /* --------------------------------------------------------------- history */

  async appendHistory(colony: string, rows: HistorySample[]): Promise<number> {
    await this.ready();
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const vals: unknown[] = [];
      const tuples = chunk.map((r, k) => {
        vals.push(colony, r.w, r.t, r.c, JSON.stringify(r));
        const b = k * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb)`;
      });
      await this.db.query(`INSERT INTO ic_history (colony, w, t, c, row) VALUES ${tuples.join(",")} ON CONFLICT DO NOTHING`, vals);
    }
    await this.db.query(`DELETE FROM ic_history WHERE t < $1`, [Date.now() - HISTORY_RETENTION_MS]);
    return this.historyCursor(colony);
  }

  async historyCursor(colony: string): Promise<number> {
    await this.ready();
    return Number((await this.db.query<{ t: number | null }>(`SELECT MAX(t) AS t FROM ic_history WHERE colony = $1`, [colony]))[0]?.t ?? 0);
  }

  async history(colony: string, worldId: number, sinceCycles?: number): Promise<HistorySample[]> {
    await this.ready();
    const rows = await this.db.query<{ row: HistorySample }>(
      `SELECT row FROM ic_history WHERE colony = $1 AND w = $2 AND ($3::double precision IS NULL OR c >= $3) ORDER BY t`,
      [colony, worldId, sinceCycles ?? null],
    );
    return rows.map((r) => r.row);
  }

  /* ----------------------------------------------------------------- audit */

  async audit(actor: string, event: string, detail: Record<string, unknown> = {}) {
    await this.ready();
    await this.db.query(`INSERT INTO ic_audit (at, actor, event, detail) VALUES ($1, $2, $3, $4::jsonb)`, [Date.now(), actor.slice(0, 120), event, JSON.stringify(detail)]);
  }

  async readAudit(limit = 200) {
    await this.ready();
    const rows = await this.db.query<{ seq: number; at: number; actor: string; event: string; detail: Record<string, unknown> }>(
      `SELECT seq, at, actor, event, detail FROM ic_audit ORDER BY seq DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ ...r, seq: Number(r.seq), at: Number(r.at) }));
  }

  /* ------------------------------------------------------------ screenshot */

  async saveScreenshot(mime: string, data: Buffer) {
    await this.ready();
    await this.db.query(
      `INSERT INTO ic_screenshot (id, at, mime, data_b64) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at, mime = EXCLUDED.mime, data_b64 = EXCLUDED.data_b64`,
      [Date.now(), mime, data.toString("base64")],
    );
  }

  async getScreenshot(): Promise<{ at: number; mime: string; data: Buffer } | null> {
    await this.ready();
    const r = (await this.db.query<{ at: number; mime: string; data_b64: string }>(`SELECT at, mime, data_b64 FROM ic_screenshot WHERE id = 1`))[0];
    return r ? { at: Number(r.at), mime: r.mime, data: Buffer.from(r.data_b64, "base64") } : null;
  }
}
