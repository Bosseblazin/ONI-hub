import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../store/history";
import type {
  ActionProposal,
  AgentSettings,
  Command,
  CommandType,
  Decision,
  Investigation,
  Message,
  ModeState,
  NotificationPrefs,
  NotificationRecord,
  Objective,
  PermissionLevel,
  Recommendation,
} from "./types";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  minSeverity: "WARNING",
  categories: {
    food: true,
    starvation: true,
    oxygen: true,
    power: true,
    water: true,
    temperature: true,
    health: true,
    ai_unresolved: true,
    game_disconnected: true,
    instruction_received: false,
    instruction_completed: true,
    investigation: true,
    status_report: true,
  },
  cooldownMinutes: 30,
  quietStart: null,
  quietEnd: null,
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  analysisIntervalMinutes: 20,
  maxClaudeCallsPerHour: 20,
  statusReportMinutes: 60,
  keepCommanderUpdated: false,
  screenshotIntervalMinutes: 0,
};

interface PersistedState {
  version: 1;
  mode: ModeState;
  permissionLevel: PermissionLevel;
  objectives: Objective[];
  investigations: Investigation[];
  recommendations: Recommendation[];
  proposals: ActionProposal[];
  decisions: Decision[];
  notificationPrefs: NotificationPrefs;
  agentSettings: AgentSettings;
}

export interface AuditEntry {
  seq: number;
  at: number;
  actor: string;
  event: string;
  detail: Record<string, unknown>;
  prev: string;
  hash: string;
}

const MAX_MESSAGES = 500;
const MAX_DECISIONS = 200;
const MAX_NOTIFICATIONS = 300;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/**
 * Durable operations state for the home agent.
 *  - state.json: objectives, mode, recommendations, proposals, settings (atomic rewrite)
 *  - commands.jsonl: append-only command log; each line is a full Command snapshot, last one wins
 *  - messages.jsonl / notifications.jsonl: append-only
 *  - audit.jsonl: append-only, SHA-256 hash-chained (tamper-evident)
 */
export class OpsStore {
  readonly dir: string;
  private s: PersistedState;
  private commands = new Map<string, Command>(); // by clientId
  private seq = 0;
  private messages: Message[] = [];
  private notifications: NotificationRecord[] = [];
  private auditSeq = 0;
  private auditHead = "genesis";

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "ops");
    fs.mkdirSync(this.dir, { recursive: true });
    const saved = readJsonFile<PersistedState>(this.file("state.json"));
    this.s = {
      version: 1,
      mode: saved?.mode ?? { mode: "commander", setBy: "default", setAt: Date.now(), note: null },
      permissionLevel: 1, // v1: always Observation, regardless of what was saved
      objectives: saved?.objectives ?? [],
      investigations: saved?.investigations ?? [],
      recommendations: saved?.recommendations ?? [],
      proposals: saved?.proposals ?? [],
      decisions: saved?.decisions ?? [],
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...(saved?.notificationPrefs ?? {}), categories: { ...DEFAULT_NOTIFICATION_PREFS.categories, ...(saved?.notificationPrefs?.categories ?? {}) } },
      agentSettings: { ...DEFAULT_AGENT_SETTINGS, ...(saved?.agentSettings ?? {}) },
    };
    for (const c of this.readJsonl<Command>("commands.jsonl")) {
      this.commands.set(c.clientId, c);
      this.seq = Math.max(this.seq, c.seq);
    }
    this.messages = this.readJsonl<Message>("messages.jsonl").slice(-MAX_MESSAGES);
    this.notifications = this.readJsonl<NotificationRecord>("notifications.jsonl").slice(-MAX_NOTIFICATIONS);
    const audit = this.readJsonl<AuditEntry>("audit.jsonl");
    const last = audit[audit.length - 1];
    if (last) {
      this.auditSeq = last.seq;
      this.auditHead = last.hash;
    }
  }

  private file(name: string) {
    return path.join(this.dir, name);
  }

  private readJsonl<T>(name: string): T[] {
    try {
      return fs
        .readFileSync(this.file(name), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as T];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  /** Disk problems must never take the agent down: recreate the directory once, then degrade to memory. */
  private append(name: string, obj: unknown) {
    const line = JSON.stringify(obj) + "\n";
    try {
      fs.appendFileSync(this.file(name), line);
    } catch {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(this.file(name), line);
      } catch (e) {
        console.error(`[ops] could not persist ${name}: ${(e as Error).message}`);
      }
    }
  }

  save(): void {
    writeJsonFileAtomic(this.file("state.json"), this.s);
  }

  /* --------------------------------------------------------------- audit */

  audit(actor: string, event: string, detail: Record<string, unknown> = {}): AuditEntry {
    const at = Date.now();
    const seq = ++this.auditSeq;
    const prev = this.auditHead;
    const hash = createHash("sha256").update(JSON.stringify({ seq, at, actor, event, detail, prev })).digest("hex");
    const e: AuditEntry = { seq, at, actor, event, detail, prev, hash };
    this.auditHead = hash;
    this.append("audit.jsonl", e);
    return e;
  }

  readAudit(limit = 200): AuditEntry[] {
    return this.readJsonl<AuditEntry>("audit.jsonl").slice(-limit);
  }

  /** Recompute the hash chain. Returns the first broken seq, or null if intact. */
  verifyAudit(): number | null {
    let prev = "genesis";
    for (const e of this.readJsonl<AuditEntry>("audit.jsonl")) {
      const h = createHash("sha256").update(JSON.stringify({ seq: e.seq, at: e.at, actor: e.actor, event: e.event, detail: e.detail, prev })).digest("hex");
      if (e.prev !== prev || e.hash !== h) return e.seq;
      prev = e.hash;
    }
    return null;
  }

  /* ------------------------------------------------------------ commands */

  /**
   * Enqueue a command idempotently. Returns `{command, duplicate}`; a repeated clientId returns the
   * original command unchanged (no second processing, no second audit entry).
   */
  enqueue(input: { clientId: string; type: CommandType; payload: Record<string, unknown>; issuedBy: string; clientCreatedAt: number | null }): { command: Command; duplicate: boolean } {
    const existing = this.commands.get(input.clientId);
    if (existing) return { command: existing, duplicate: true };
    const c: Command = {
      seq: ++this.seq,
      clientId: input.clientId,
      type: input.type,
      payload: input.payload,
      issuedBy: input.issuedBy,
      clientCreatedAt: input.clientCreatedAt,
      receivedAt: Date.now(),
      processedAt: null,
      status: "received",
      result: null,
      error: null,
    };
    this.commands.set(c.clientId, c);
    this.append("commands.jsonl", c);
    this.audit(input.issuedBy, "command.received", { seq: c.seq, clientId: c.clientId, type: c.type, payload: c.payload });
    return { command: c, duplicate: false };
  }

  updateCommand(clientId: string, patch: Partial<Pick<Command, "status" | "result" | "error" | "processedAt">>): Command | null {
    const c = this.commands.get(clientId);
    if (!c) return null;
    Object.assign(c, patch);
    this.append("commands.jsonl", c);
    if (patch.status === "completed" || patch.status === "failed") {
      this.audit("agent", `command.${patch.status}`, { seq: c.seq, clientId, result: c.result, error: c.error });
    }
    return c;
  }

  getCommand(clientId: string): Command | null {
    return this.commands.get(clientId) ?? null;
  }

  pendingCommands(): Command[] {
    return [...this.commands.values()].filter((c) => c.status === "received" || c.status === "processing").sort((a, b) => a.seq - b.seq);
  }

  recentCommands(n = 50): Command[] {
    return [...this.commands.values()].sort((a, b) => b.seq - a.seq).slice(0, n);
  }

  /* ------------------------------------------------------------ messages */

  addMessage(m: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const msg: Message = { id: newId("msg"), at: m.at ?? Date.now(), ...m };
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.append("messages.jsonl", msg);
    return msg;
  }

  recentMessages(n = 100): Message[] {
    return this.messages.slice(-n);
  }

  /* ------------------------------------------------------- notifications */

  addNotification(n: NotificationRecord): void {
    this.notifications.push(n);
    if (this.notifications.length > MAX_NOTIFICATIONS) this.notifications.splice(0, this.notifications.length - MAX_NOTIFICATIONS);
    this.append("notifications.jsonl", n);
  }

  recentNotifications(n = 50): NotificationRecord[] {
    return this.notifications.slice(-n).reverse();
  }

  /* ---------------------------------------------------------------- state */

  get state(): Readonly<PersistedState> {
    return this.s;
  }

  mutate(fn: (s: PersistedState) => void): void {
    fn(this.s);
    if (this.s.decisions.length > MAX_DECISIONS) this.s.decisions.splice(0, this.s.decisions.length - MAX_DECISIONS);
    // Keep the investigation list bounded: drop concluded ones older than 7 days.
    const cutoff = Date.now() - 7 * 86400_000;
    this.s.investigations = this.s.investigations.filter((i) => i.status === "open" || i.status === "analyzing" || i.updatedAt > cutoff);
    this.save();
  }

  decide(d: Omit<Decision, "at">): void {
    this.mutate((s) => s.decisions.push({ at: Date.now(), ...d }));
  }
}
