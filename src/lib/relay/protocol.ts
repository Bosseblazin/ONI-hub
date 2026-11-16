import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DashboardState, HistorySample } from "../model/types";
import type { Command, CommandType, OpsState } from "../ops/types";

/**
 * Home agent ⇄ cloud relay protocol.
 *
 * The HOME PC always initiates (outbound HTTPS to the Vercel deployment). Every request is signed:
 *   X-IC-Agent:     agent id (informational)
 *   X-IC-Timestamp: unix ms
 *   X-IC-Signature: hex HMAC-SHA256(secret, `${ts}\n${METHOD}\n${path}\n${sha256hex(body)}`)
 * The cloud rejects bad signatures and timestamps outside ±5 minutes (replay window). The shared secret
 * (IC_AGENT_SECRET, ≥ 32 random bytes) lives only in Vercel's encrypted env and on the home PC.
 */

export const RELAY_PROTOCOL = 1;
export const MAX_SKEW_MS = 5 * 60_000;
/** The cloud considers the home agent offline after this long without a sync. */
export const AGENT_OFFLINE_AFTER_MS = 45_000;

export const sha256hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

export function signRequest(secret: string, method: string, path: string, body: string | Buffer, ts = Date.now()) {
  const sig = createHmac("sha256", secret).update(`${ts}\n${method.toUpperCase()}\n${path}\n${sha256hex(body)}`).digest("hex");
  return { "X-IC-Timestamp": String(ts), "X-IC-Signature": sig };
}

export function verifyRequest(
  secret: string | undefined,
  headers: { get(name: string): string | null },
  method: string,
  path: string,
  body: string | Buffer,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!secret || secret.length < 32) return { ok: false, reason: "relay not configured (IC_AGENT_SECRET missing or too short)" };
  const ts = Number(headers.get("x-ic-timestamp"));
  const sig = headers.get("x-ic-signature") ?? "";
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "timestamp outside allowed window (check the home PC clock)" };
  const want = createHmac("sha256", secret).update(`${ts}\n${method.toUpperCase()}\n${path}\n${sha256hex(body)}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, "hex");
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

/** A command as handed from the cloud queue to the home agent. */
export interface RelayCommand {
  clientId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  issuedBy: string;
  clientCreatedAt: number | null;
  queuedAt: number;
}

/** Home agent's authoritative status for a command (the cloud never invents these). */
export interface CommandReport {
  clientId: string;
  status: Command["status"];
  homeSeq: number;
  result: string | null;
  error: string | null;
  processedAt: number | null;
}

export interface SyncRequest {
  protocol: number;
  agentId: string;
  agentVersion: string;
  sentAt: number;
  /** True when the agent's game connection is the bundled simulator. Sent on EVERY sync, heartbeats included. */
  simulated: boolean;
  /** Full state, included when it changed or the cloud asked for it; omitted on heartbeat-only syncs. */
  snapshot: { dashboard: DashboardState; ops: OpsState } | null;
  /** New history rows since the cloud's last confirmed cursor. */
  history: HistorySample[];
  /** Status of every command the home agent has received from the relay (recent window). */
  reports: CommandReport[];
  /** Commands the agent has persisted locally (so the cloud can mark them delivered). */
  receivedClientIds: string[];
}

export interface SyncResponse {
  ok: true;
  serverTime: number;
  commands: RelayCommand[];
  /** Highest history `t` the cloud has stored; the agent sends rows after this next time. */
  historyCursor: number;
  /** True when a browser polled recently: the agent then syncs faster and always sends full snapshots. */
  viewerActive: boolean;
  /** Ask for a full snapshot on the next sync (e.g. after cloud DB reset). */
  wantSnapshot: boolean;
}

/** What the cloud tells browsers about the relay link. */
export interface RelayStatus {
  mode: "cloud" | "local";
  agentId: string | null;
  agentVersion: string | null;
  agentLastSeenAt: number | null;
  agentOnline: boolean;
  snapshotAt: number | null;
  /** Commands accepted by the cloud but not yet picked up by the home agent. */
  queued: number;
  serverTime: number;
}

/** Cloud-side delivery state of a command, separate from the home agent's processing status. */
export interface RelayCommandStatus {
  clientId: string;
  type: CommandType;
  payload?: Record<string, unknown>;
  issuedBy?: string;
  queuedAt: number;
  deliveredAt: number | null;
  /** Home-confirmed status (null until the home agent reports). */
  homeStatus: Command["status"] | null;
  result: string | null;
  error: string | null;
}
