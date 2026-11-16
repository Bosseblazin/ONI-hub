import type { AlertRecord } from "../model/types";
import { newId, type OpsStore } from "./store";
import type { NotificationCategory, NotificationPrefs, NotificationRecord } from "./types";

type Sev = NotificationRecord["severity"];
const RANK: Record<Sev, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export interface Channel {
  name: string;
  configured(): boolean;
  send(n: NotificationRecord): Promise<void>;
}

/**
 * ntfy (https://ntfy.sh or self-hosted): the home PC POSTs outbound; the ntfy phone app receives the push.
 * Use a long random topic name (it acts as a shared secret) or an access token.
 */
export class NtfyChannel implements Channel {
  readonly name = "ntfy";
  constructor(private url = process.env.NTFY_URL, private token = process.env.NTFY_TOKEN, private clickUrl = process.env.IC_PUBLIC_URL) {}
  configured() {
    return !!this.url;
  }
  async send(n: NotificationRecord) {
    const headers: Record<string, string> = {
      Title: `Interplanetary Command: ${n.title}`.replace(/[^\x20-\x7e]/g, ""),
      Priority: n.severity === "CRITICAL" ? "5" : n.severity === "WARNING" ? "4" : "3",
      Tags: n.severity === "CRITICAL" ? "rotating_light" : n.severity === "WARNING" ? "warning" : "satellite",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.clickUrl) headers.Click = this.clickUrl;
    const r = await fetch(this.url!, { method: "POST", headers, body: n.body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
  }
}

/** Generic JSON webhook (Home Assistant, n8n, a Discord/Slack bridge, ...). */
export class WebhookChannel implements Channel {
  readonly name = "webhook";
  constructor(private url = process.env.IC_WEBHOOK_URL) {}
  configured() {
    return !!this.url;
  }
  async send(n: NotificationRecord) {
    const r = await fetch(this.url!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "interplanetary-command", ...n, content: `**${n.severity}** ${n.title}\n${n.body}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`webhook HTTP ${r.status}`);
  }
}

/** Map alert rules to notification categories. Rules not listed never notify (e.g. INFO population events). */
export const RULE_CATEGORY: Record<string, NotificationCategory> = {
  "food-runway": "food",
  "food-declining": "food",
  starving: "starvation",
  suffocating: "oxygen",
  oxygen: "oxygen",
  battery: "power",
  "power-deficit": "power",
  "generator-empty": "power",
  "coal-runway": "power",
  "petroleum-runway": "power",
  "gas-runway": "power",
  "water-runway": "water",
  temperature: "temperature",
  incapacitated: "health",
  workforce: "health",
  stress: "health",
};

function inQuiet(p: NotificationPrefs, now: Date): boolean {
  if (!p.quietStart || !p.quietEnd) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(p.quietStart), b = toMin(p.quietEnd);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

export class Notifier {
  private lastSent = new Map<string, { at: number; severity: Sev }>();
  readonly channels: Channel[];

  constructor(private store: OpsStore, channels?: Channel[]) {
    this.channels = channels ?? [new NtfyChannel(), new WebhookChannel()];
  }

  configuredChannels(): string[] {
    return this.channels.filter((c) => c.configured()).map((c) => c.name);
  }

  /**
   * Decide and deliver. `key` identifies the condition (e.g. an alert id) for cooldown/de-duplication.
   * An escalation (higher severity than last time for the same key) bypasses the cooldown.
   */
  async notify(input: { category: NotificationCategory; severity: Sev; title: string; body: string; key: string }, now = Date.now()): Promise<NotificationRecord | null> {
    const p = this.store.state.notificationPrefs;
    if (!p.enabled || !p.categories[input.category]) return null;
    if (RANK[input.severity] < RANK[p.minSeverity] && !["instruction_completed", "instruction_received", "status_report", "investigation"].includes(input.category)) return null;
    const last = this.lastSent.get(input.key);
    const escalated = last && RANK[input.severity] > RANK[last.severity];
    if (last && !escalated && now - last.at < p.cooldownMinutes * 60_000) return null;
    const quiet = inQuiet(p, new Date(now)) && input.severity !== "CRITICAL";

    const rec: NotificationRecord = { id: newId("ntf"), at: now, category: input.category, severity: input.severity, title: input.title, body: input.body, key: input.key, channels: { inapp: "sent" } };
    for (const ch of this.channels) {
      if (!ch.configured() || quiet) {
        rec.channels[ch.name] = "skipped";
        continue;
      }
      try {
        await ch.send(rec);
        rec.channels[ch.name] = "sent";
      } catch {
        rec.channels[ch.name] = "failed";
      }
    }
    this.lastSent.set(input.key, { at: now, severity: input.severity });
    this.store.addNotification(rec);
    this.store.audit("agent", "notification.sent", { id: rec.id, category: rec.category, severity: rec.severity, title: rec.title, channels: rec.channels });
    return rec;
  }

  /** Notify for newly raised or escalated alerts only — never for ordinary fluctuations. */
  async fromAlerts(prev: Map<string, Sev>, alerts: AlertRecord[]): Promise<void> {
    for (const a of alerts) {
      if (a.status !== "active" || a.oneShot) continue;
      const cat = RULE_CATEGORY[a.rule];
      if (!cat) continue;
      const before = prev.get(a.id);
      if (before && RANK[a.severity] <= RANK[before]) continue; // already notified at this level
      await this.notify({ category: cat, severity: a.severity, key: `alert:${a.id}`, title: `${a.severity === "CRITICAL" ? "CRITICAL: " : ""}${a.title}${a.worldName ? ` — ${a.worldName}` : ""}`, body: `${a.what}\n${a.urgency}` });
    }
  }
}

/**
 * Dead-man's switch. The home PC pings IC_HEARTBEAT_URL (e.g. a healthchecks.io check) every minute.
 * If the PC, its network or this service dies, the external service stops receiving pings and alerts
 * the commander — the only way to learn "home PC unavailable" when the home PC itself cannot speak.
 */
export class Heartbeat {
  lastOkAt: number | null = null;
  lastError: string | null = null;
  constructor(private url = process.env.IC_HEARTBEAT_URL) {}
  configured() {
    return !!this.url;
  }
  async beat(): Promise<void> {
    if (!this.url) return;
    try {
      const r = await fetch(this.url, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.lastOkAt = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }
}
