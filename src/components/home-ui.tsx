"use client";
import { useEffect, useState } from "react";
import type { NotificationCategory, OpsState } from "@/lib/ops/types";
import { PERMISSION_LABELS } from "@/lib/ops/types";
import { age } from "@/lib/ui/format";
import { Section } from "./ops-ui";
import { useApp, watchState } from "./shell";

function Row({ label, value, ok, note }: { label: string; value: string; ok: boolean | null; note?: string }) {
  const color = ok === null ? "var(--muted)" : ok ? "var(--good)" : "var(--crit)";
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
      <div>
        <div className="text-ink2">{label}</div>
        {note && <div className="text-[10px] text-muted">{note}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 font-semibold" style={{ color }}>
        <span aria-hidden>{ok === null ? "◌" : ok ? "●" : "✕"}</span>
        {value}
      </div>
    </li>
  );
}

/** Every link in the chain between the phone and the colony, stated honestly. */
export function HomeStatusPanel() {
  const { live, now } = useApp();
  const h = live.ops?.home;
  const reachable = live.link === "live";
  const stale = !reachable;
  return (
    <Section title="Home PC & links" right={<span className="text-[10px]" style={{ color: watchState(live).color }}>{watchState(live).label}</span>}>
      <ul className="divide-y divide-line">
        <Row label="This device → home PC" value={reachable ? "connected" : live.link === "device-offline" ? "device offline" : "unreachable"} ok={reachable} note={`last sync ${age(live.lastSyncAt, now)}`} />
        <Row label="Home PC" value={reachable ? `online (${h?.hostname ?? "?"})` : "unknown"} ok={reachable ? true : null} note={h ? `agent up ${Math.round(h.uptimeSeconds / 60)} min${stale ? " (as of last sync)" : ""}` : undefined} />
        <Row label="Oxygen Not Included" value={h?.gameProcess ?? "unknown"} ok={h ? (h.gameProcess === "unknown" ? null : h.gameProcess === "running") : null} note="process check on the home PC" />
        <Row label="OniMcp" value={h?.oniMcp ?? "unknown"} ok={h ? h.oniMcp === "connected" : null} />
        <Row label="Colony loaded" value={h ? (h.colonyLoaded ? "yes" : "no") : "unknown"} ok={h ? h.colonyLoaded : null} note={live.dashboard?.snapshot?.saveName ?? undefined} />
        <Row label="Claude service" value={h?.claude ?? "unknown"} ok={h ? (h.claude === "available" ? true : h.claude === "unconfigured" ? null : false) : null} note={live.ops?.agent.lastClaudeError ?? (h?.claude === "unconfigured" ? "set ANTHROPIC_API_KEY on the home PC" : undefined)} />
        <Row label="Last successful observation" value={age(h?.lastObservationAt ?? null, now)} ok={h?.lastObservationAt ? now - h.lastObservationAt < 60_000 : false} />
        <Row label="Last synchronisation (this device)" value={age(live.lastSyncAt, now)} ok={live.lastSyncAt ? now - live.lastSyncAt < 30_000 : false} />
        <Row label="Offline watchdog (heartbeat)" value={h?.heartbeatConfigured ? `last ping ${age(h.lastHeartbeatAt, now)}` : "not configured"} ok={h?.heartbeatConfigured ? !!h.lastHeartbeatAt : null} note="alerts you if the home PC itself goes dark — see docs/REMOTE_ACCESS.md" />
      </ul>
    </Section>
  );
}

export function PermissionPanel({ ops }: { ops: OpsState }) {
  return (
    <Section title="Action authorization">
      <div className="space-y-2 p-3 text-xs">
        {([1, 2, 3] as const).map((l) => (
          <div key={l} className={`rounded border px-3 py-2 ${ops.permissionLevel === l ? "border-accent bg-accent/10" : "border-line opacity-60"}`}>
            <div className="font-semibold text-ink">Level {l} — {PERMISSION_LABELS[l]} {ops.permissionLevel === l && <span className="text-accent">(active)</span>}</div>
            <div className="text-[11px] text-ink2">
              {l === 1 && "Claude observes, analyses, recommends and proposes. Nothing is executed in the game."}
              {l === 2 && "Claude executes a proposed action only after you approve that specific action. Destructive actions also need a typed confirmation."}
              {l === 3 && "You grant categories of routine actions (e.g. priorities) that Claude may perform on its own. Destructive, rocketry and printing-pod actions always need approval."}
            </div>
            {l > 1 && <div className="mt-1 text-[10px] text-warn">Unavailable: the execution layer is not enabled in this version.</div>}
          </div>
        ))}
        <p className="text-[10px] text-muted">A strategic objective is never treated as permission to modify the game. Every decision is written to the audit log.</p>
      </div>
    </Section>
  );
}

const CAT_LABELS: Record<NotificationCategory, string> = {
  food: "Food runway", starvation: "Starvation", oxygen: "Oxygen", power: "Power instability", water: "Water shortage", temperature: "Temperature",
  health: "Duplicant health", ai_unresolved: "AI unable to resolve emergency", game_disconnected: "Game / monitoring disconnected",
  instruction_received: "Instruction received", instruction_completed: "Objective completed", investigation: "Investigation results", status_report: "Status reports",
};

export function NotificationSettings({ ops }: { ops: OpsState }) {
  const { send } = useApp();
  const p = ops.notificationPrefs;
  const upd = (patch: Record<string, unknown>) => send("notifications.update", patch);
  return (
    <Section title="Notifications">
      <div className="space-y-3 p-3 text-xs">
        <label className="flex items-center justify-between gap-2">
          <span>Notifications enabled</span>
          <input type="checkbox" checked={p.enabled} onChange={(e) => upd({ enabled: e.target.checked })} className="h-5 w-5 accent-[var(--accent)]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Minimum alert severity</span>
          <select value={p.minSeverity} onChange={(e) => upd({ minSeverity: e.target.value })} className="rounded border border-line bg-panel2 px-2 py-1 text-ink">
            <option value="CRITICAL">Critical only</option>
            <option value="WARNING">Warning and above</option>
            <option value="INFO">Everything</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Repeat cooldown (minutes)</span>
          <input type="number" min={1} max={1440} defaultValue={p.cooldownMinutes} onBlur={(e) => upd({ cooldownMinutes: Number(e.target.value) })} className="w-20 rounded border border-line bg-panel2 px-2 py-1 text-right text-ink" />
        </label>
        <div className="flex items-center justify-between gap-2">
          <span>Quiet hours (critical still notifies)</span>
          <span className="flex items-center gap-1">
            <input type="time" defaultValue={p.quietStart ?? ""} onBlur={(e) => upd({ quietStart: e.target.value || null })} className="rounded border border-line bg-panel2 px-1 py-1 text-ink" aria-label="Quiet start" />
            –
            <input type="time" defaultValue={p.quietEnd ?? ""} onBlur={(e) => upd({ quietEnd: e.target.value || null })} className="rounded border border-line bg-panel2 px-1 py-1 text-ink" aria-label="Quiet end" />
          </span>
        </div>
        <fieldset className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <legend className="mb-1 text-[10px] uppercase tracking-wider text-muted">Categories</legend>
          {(Object.keys(CAT_LABELS) as NotificationCategory[]).map((c) => (
            <label key={c} className="flex items-center gap-2">
              <input type="checkbox" checked={p.categories[c]} onChange={(e) => upd({ categories: { [c]: e.target.checked } })} className="h-4 w-4 accent-[var(--accent)]" />
              {CAT_LABELS[c]}
            </label>
          ))}
        </fieldset>
        <p className="text-[10px] text-muted">Alerts notify only when they are raised or escalate — never for ordinary fluctuations. Push delivery uses ntfy or a webhook configured on the home PC (docs/REMOTE_ACCESS.md).</p>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Recent notifications</div>
          <ul className="max-h-48 divide-y divide-line overflow-y-auto">
            {ops.notifications.length === 0 && <li className="py-1 text-muted">None yet.</li>}
            {ops.notifications.slice(0, 20).map((n) => (
              <li key={n.id} className="py-1">
                <span style={{ color: n.severity === "CRITICAL" ? "var(--crit)" : n.severity === "WARNING" ? "var(--warn)" : "var(--accent)" }}>●</span> {n.title}
                <span className="ml-1 text-[10px] text-muted">{new Date(n.at).toLocaleString()} · {Object.entries(n.channels).map(([k, v]) => `${k}:${v}`).join(" ")}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

export function AgentSettingsPanel({ ops }: { ops: OpsState }) {
  const { send } = useApp();
  const a = ops.agentSettings;
  const num = (k: keyof typeof a, label: string, note: string) => (
    <label className="flex items-center justify-between gap-2">
      <span>{label}<span className="block text-[10px] text-muted">{note}</span></span>
      <input type="number" defaultValue={a[k] as number} onBlur={(e) => send("settings.update", { [k]: Number(e.target.value) })} className="w-20 rounded border border-line bg-panel2 px-2 py-1 text-right text-ink" />
    </label>
  );
  return (
    <Section title="Operations agent">
      <div className="space-y-3 p-3 text-xs">
        {num("analysisIntervalMinutes", "Background analysis every (min)", "only while alerts or objectives are active")}
        {num("maxClaudeCallsPerHour", "Claude calls per hour (cap)", "cost guard; your instructions get a small reserve")}
        {num("statusReportMinutes", "Status report every (min)", "when you asked to be kept updated")}
        {num("screenshotIntervalMinutes", "Desktop screenshot every (min)", "0 = off. Captures the whole home-PC screen")}
        <label className="flex items-center justify-between gap-2">
          <span>Keep me updated (periodic reports)</span>
          <input type="checkbox" checked={a.keepCommanderUpdated} onChange={(e) => send("settings.update", { keepCommanderUpdated: e.target.checked })} className="h-5 w-5 accent-[var(--accent)]" />
        </label>
        <button onClick={() => send("report.request", {})} className="w-full rounded border border-accent/70 py-2 text-[12px] font-semibold text-accent">Request a status report now</button>
        {a.screenshotIntervalMinutes > 0 && <ScreenshotView />}
      </div>
    </Section>
  );
}

function ScreenshotView() {
  const [t, setT] = useState(() => Date.now());
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] text-muted"><span>Latest home-PC screenshot</span><button onClick={() => setT(Date.now())} className="text-accent">refresh</button></div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/screenshot?t=${t}`} alt="Latest screenshot of the home PC" className="w-full rounded border border-line" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
    </div>
  );
}

interface SessionInfo { id: string; label: string; createdAt: number; lastSeenAt: number; current: boolean }

export function SessionsPanel() {
  const [list, setList] = useState<SessionInfo[]>([]);
  const load = async () => {
    const r = await fetch("/api/auth/sessions", { cache: "no-store" });
    if (r.ok) setList((await r.json()) as SessionInfo[]);
  };
  useEffect(() => {
    void load();
  }, []);
  const post = async (body: unknown) => {
    await fetch("/api/auth/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    void load();
  };
  return (
    <Section title="Signed-in devices">
      <ul className="divide-y divide-line text-xs">
        {list.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
            <div>
              <div className="text-ink">{s.label} {s.current && <span className="text-accent">(this device)</span>}</div>
              <div className="text-[10px] text-muted">signed in {new Date(s.createdAt).toLocaleDateString()} · last seen {new Date(s.lastSeenAt).toLocaleString()}</div>
            </div>
            {!s.current && <button onClick={() => void post({ revoke: s.id })} className="rounded border border-crit/60 px-2 py-1 text-[11px] text-crit">Revoke</button>}
          </li>
        ))}
      </ul>
      <div className="flex gap-2 border-t border-line p-2">
        <button onClick={() => void post({ revokeOthers: true })} className="rounded border border-line px-2 py-1 text-[11px] text-ink2">Sign out all other devices</button>
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
          className="ml-auto rounded border border-line px-2 py-1 text-[11px] text-ink2"
        >
          Sign out
        </button>
      </div>
    </Section>
  );
}

interface AuditEntry { seq: number; at: number; actor: string; event: string; detail: Record<string, unknown> }

export function AuditPanel() {
  const [d, setD] = useState<{ intact: boolean; brokenAt: number | null; entries: AuditEntry[] } | null>(null);
  useEffect(() => {
    void fetch("/api/audit", { cache: "no-store" }).then(async (r) => r.ok && setD(await r.json()));
  }, []);
  return (
    <Section title="Audit log" right={d && <span className="text-[10px]" style={{ color: d.intact ? "var(--good)" : "var(--crit)" }}>{d.intact ? "✓ hash chain intact" : `✕ chain broken at #${d.brokenAt}`}</span>}>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto text-[11px]">
        {d?.entries.slice(0, 80).map((e) => (
          <li key={e.seq} className="px-3 py-1">
            <span className="num text-muted">#{e.seq} {new Date(e.at).toLocaleString()}</span> <b className="text-ink2">{e.event}</b> <span className="text-muted">by {e.actor}</span>
            <div className="truncate text-[10px] text-muted">{JSON.stringify(e.detail)}</div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
