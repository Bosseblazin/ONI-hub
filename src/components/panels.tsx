"use client";
import Link from "next/link";
import { useState } from "react";
import { RESOURCE_LABELS } from "@/lib/model/normalize";
import type {
  AlertRecord,
  ConnectionInfo,
  DashboardState,
  HistoryField,
  HistorySample,
  Projection,
  ResourceKey,
  Severity,
  Trend,
  WorldState,
} from "@/lib/model/types";
import { age, clock, cycles, joules, kcal, kg, NA, pct, temp, watts, worldColor } from "@/lib/ui/format";
import { Sparkline } from "./charts";

/* ------------------------------------------------------------ primitives */

const SEV_STYLE: Record<Severity | "OK" | "STALE", { color: string; icon: string; label: string }> = {
  CRITICAL: { color: "var(--crit)", icon: "▲", label: "CRITICAL" },
  WARNING: { color: "var(--warn)", icon: "◆", label: "WARNING" },
  INFO: { color: "var(--accent)", icon: "●", label: "INFO" },
  OK: { color: "var(--good)", icon: "✓", label: "NOMINAL" },
  STALE: { color: "var(--muted)", icon: "◌", label: "STALE" },
};

export function SevBadge({ sev, small }: { sev: keyof typeof SEV_STYLE; small?: boolean }) {
  const s = SEV_STYLE[sev];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border font-semibold tracking-wider ${small ? "px-1 py-0 text-[9px]" : "px-1.5 py-0.5 text-[10px]"}`}
      style={{ color: s.color, borderColor: s.color }}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function TrendArrow({ t }: { t: Trend | undefined }) {
  if (!t || !t.reliable) return <span className="text-muted" title={t?.reason ?? "No trend data"}>·</span>;
  const m = { increasing: ["↑", "rising"], decreasing: ["↓", "falling"], stable: ["→", "stable"], unknown: ["·", "unknown"] }[t.direction];
  return (
    <span className="text-ink2" title={`${m[1]} — ${t.reason}`}>
      {m[0]}
    </span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="num truncate text-lg font-semibold leading-tight" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub && <div className="truncate text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function Bar({ value, max, color, label }: { value: number | null; max: number; color: string; label: string }) {
  const p = value === null || max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--grid)]" role="meter" aria-label={label} aria-valuenow={value ?? undefined} aria-valuemax={max}>
      <div className="h-full rounded-full" style={{ width: `${p * 100}%`, background: color }} />
    </div>
  );
}

export function worldSeverity(w: WorldState, alerts: AlertRecord[]): Severity | "OK" {
  const a = alerts.filter((x) => x.status === "active" && x.worldId === w.id && x.severity !== "INFO");
  if (a.some((x) => x.severity === "CRITICAL")) return "CRITICAL";
  if (a.length) return "WARNING";
  return "OK";
}

/* ---------------------------------------------------------------- header */

function ConnDot({ c, stale }: { c: ConnectionInfo; stale: boolean }) {
  const map: Record<ConnectionInfo["state"], [string, string]> = {
    connected: ["var(--good)", "LINK ESTABLISHED"],
    connecting: ["var(--warn)", "CONNECTING"],
    "game-not-loaded": ["var(--warn)", "NO COLONY LOADED"],
    disconnected: ["var(--crit)", "NO SIGNAL"],
    error: ["var(--crit)", "LINK ERROR"],
  };
  const [color, label] = stale && c.state === "connected" ? ["var(--warn)", "SIGNAL STALE"] : map[c.state];
  return (
    <div className="flex items-center gap-2.5 rounded border px-3 py-1.5" style={{ borderColor: color }}>
      <span className={`h-2.5 w-2.5 rounded-full ${c.state === "connected" && !stale ? "pulse" : ""}`} style={{ background: color }} />
      <div className="leading-tight">
        <div className="text-[11px] font-bold tracking-[0.16em]" style={{ color }}>
          ONIMCP · {label}
        </div>
        <div className="num text-[10px] text-muted">
          {c.serverName ? `${c.serverName} ${c.serverVersion ?? ""}` : c.url}
        </div>
      </div>
    </div>
  );
}

export function Header({ s, now, linkUp }: { s: DashboardState | null; now: number; linkUp: boolean }) {
  const snap = s?.snapshot;
  const active = s?.alerts.filter((a) => a.status === "active" && !a.dismissed) ?? [];
  const crit = active.filter((a) => a.severity === "CRITICAL").length;
  const warn = active.filter((a) => a.severity === "WARNING").length;
  const asteroids = snap?.worlds.filter((w) => w.kind === "asteroid" && w.settled).length ?? null;
  const overall: Severity | "OK" | "STALE" = !s || s.stale || !linkUp ? "STALE" : crit ? "CRITICAL" : warn ? "WARNING" : "OK";
  return (
    <header className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-line bg-panel px-5 py-3">
      <div className="mr-2">
        <h1 className="text-xl font-bold tracking-[0.28em] text-ink">INTERPLANETARY COMMAND</h1>
        <p className="text-[10px] tracking-[0.3em] text-muted">COLONY OPERATIONS AND INTELLIGENCE SYSTEM</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
        <Stat label="Cycle" value={snap?.time ? snap.time.cycle : NA} sub={snap?.time ? (snap.time.paused ? "GAME PAUSED" : `speed ×${snap.time.speed}`) : "—"} />
        <Stat label="Duplicants" value={snap?.totalPopulation ?? NA} sub={snap?.saveName ?? "—"} />
        <Stat label="Settled asteroids" value={asteroids ?? NA} sub={snap ? `${snap.worlds.length} worlds tracked` : "—"} />
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Colony status</div>
          <div className="mt-1"><SevBadge sev={overall} /></div>
        </div>
        <Stat label="Critical" value={crit} tone={crit ? "var(--crit)" : undefined} />
        <Stat label="Warnings" value={warn} tone={warn ? "var(--warn)" : undefined} />
        <Stat label="Last update" value={clock(s?.lastUpdate ?? null)} sub={age(s?.lastUpdate ?? null, now)} />
      </div>
      <div className="ml-auto flex items-center gap-3">
        {!linkUp && s && <span className="text-[10px] text-warn">no live link to the home PC — last known data</span>}
        {s && <ConnDot c={s.connection} stale={s.stale || !linkUp} />}
      </div>
    </header>
  );
}

export function Banners({ s }: { s: DashboardState | null }) {
  if (!s) return null;
  return (
    <>
      {s.connection.simulated && (
        <div className="border-b border-[var(--s7)] bg-[#1b1830] px-5 py-1.5 text-center text-xs font-semibold tracking-[0.2em] text-[var(--s7)]">
          DEMO MODE — ALL VALUES ARE SIMULATED BY THE BUNDLED OniMcp SIMULATOR, NOT YOUR GAME
        </div>
      )}
      {s.stale && (
        <div className="border-b border-warn/60 bg-[#2a2210] px-5 py-1.5 text-center text-xs text-warn" role="status">
          <b className="tracking-[0.15em]">LIVE MONITORING INTERRUPTED</b> — {s.staleReason}{" "}
          {s.snapshot ? "Values below are the last known state and may be out of date." : ""}
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------- asteroid card */

const fieldPts = (rows: HistorySample[], f: HistoryField) =>
  rows.flatMap((r) => (typeof r[f] === "number" ? [{ x: r.c, y: r[f] as number }] : []));

export function AsteroidCard({
  w,
  s,
  history,
  now,
}: {
  w: WorldState;
  s: DashboardState;
  history: HistorySample[];
  now: number;
}) {
  const sev = worldSeverity(w, s.alerts);
  const color = worldColor(w.id);
  const proj = (label: string) => s.projections.find((p) => p.worldId === w.id && p.label === label);
  const tr = (f: HistoryField) => s.trends.find((t) => t.worldId === w.id && t.field === f);
  const warnings = s.alerts.filter((a) => a.status === "active" && a.worldId === w.id && a.severity !== "INFO").length;
  const downs = w.dupes.filter((d) => d.incapacitated).length;
  const foodDemand = proj("Food (demand-based)");
  const p = w.power;
  const r = w.resources;
  const oldest = Math.min(...(["vitals", "power", "food"] as const).map((g) => w.meta[g].fetchedAt ?? 0));
  const isStale = s.stale || (w.settled && now - oldest > s.thresholds.staleAfterSeconds * 4 * 1000);

  return (
    <Link
      href={`/asteroid/${w.id}`}
      className="panel group block overflow-hidden transition-colors hover:border-[var(--ink-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ borderTop: `3px solid ${color}` }}
    >
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-bold tracking-wide">{w.name}</h3>
            {w.isActive && <span className="rounded-sm bg-[var(--panel-2)] px-1 text-[9px] tracking-wider text-ink2">ACTIVE VIEW</span>}
          </div>
          <div className="text-[10px] text-muted">
            {w.kind === "rocket" ? "Rocket interior" : "Asteroid"} · ID {w.id} · pop {w.population}
            {downs > 0 && <span className="text-crit"> · {downs} incapacitated</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <SevBadge sev={isStale ? "STALE" : sev} small />
          {warnings > 0 && <span className="text-[10px] text-muted">{warnings} alert{warnings > 1 ? "s" : ""}</span>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-2 px-3 py-2.5">
        <Stat label="Food" value={kcal(w.foodKcal)} sub={<>runway {cycles(foodDemand?.cycles)} <TrendArrow t={tr("kcal")} /></>} />
        <Stat label="Oxygen (free)" value={kg(w.atmosphere?.oxygenKg)} sub={<>CO₂ {kg(w.atmosphere?.co2Kg)} <TrendArrow t={tr("o2")} /></>} />
        <Stat label="Avg temp" value={temp(w.thermal?.avgC)} sub={w.thermal ? `max ${temp(w.thermal.maxC)}` : "—"} />
        <Stat label="Power used / rated" value={p ? `${watts(p.consumerUsedW)}` : NA} sub={p ? `rated gen ${watts(p.generatorRatedW)}` : "—"} />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Battery</div>
          <div className="num text-lg font-semibold leading-tight">{p && p.batteryCount ? pct(p.batteryPct) : NA}</div>
          <Bar value={p?.batteryPct ?? null} max={100} color={color} label="Battery charge" />
        </div>
        <Stat label="Water" value={kg(r.water.total)} sub={<>polluted {kg(r.pollutedWater.total)} <TrendArrow t={tr("water")} /></>} />
        <Stat label="Coal" value={kg(r.coal.total)} sub={<TrendArrow t={tr("coal")} />} />
        <Stat label="Petroleum" value={kg(r.petroleum.total)} sub={<TrendArrow t={tr("petroleum")} />} />
        <Stat label="Natural gas" value={kg(r.naturalGas.total)} sub={<TrendArrow t={tr("gas")} />} />
      </div>

      <div className="flex items-center justify-between border-t border-line px-3 py-1.5">
        <div className="flex items-center gap-2 text-[10px] text-muted">
          food <Sparkline points={fieldPts(history, "kcal")} color={color} width={90} height={20} label="Food" />
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted">
          battery <Sparkline points={fieldPts(history, "battJ")} color={color} width={90} height={20} label="Battery" />
        </div>
        <span className="text-[10px] text-muted group-hover:text-ink2">details →</span>
      </div>
    </Link>
  );
}

export function DormantList({ worlds }: { worlds: WorldState[] }) {
  if (!worlds.length) return null;
  return (
    <div className="panel px-3 py-2 text-[11px] text-muted">
      <span className="panel-title mr-2">Unsettled worlds</span>
      {worlds.map((w) => (
        <Link key={w.id} href={`/asteroid/${w.id}`} className="mr-3 hover:text-ink2">
          <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: worldColor(w.id) }} />
          {w.name}
        </Link>
      ))}
      <span className="ml-1">— no duplicants or power infrastructure detected; probed every 5 min.</span>
    </div>
  );
}

/* --------------------------------------------------------------- alerts */

async function alertAction(id: string, action: "acknowledge" | "dismiss") {
  await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
}

export function AlertPanel({ alerts, now }: { alerts: AlertRecord[]; now: number }) {
  const [showResolved, setShowResolved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const visible = alerts.filter((a) => (showResolved ? true : a.status === "active" && !a.dismissed));
  const hidden = alerts.filter((a) => a.status === "active" && a.dismissed).length;
  return (
    <section className="panel flex min-h-0 flex-col" aria-label="Alerts">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="panel-title">Alert & Warning Engine</h2>
        <label className="flex items-center gap-1.5 text-[10px] text-muted">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} className="accent-[var(--accent)]" />
          show resolved/dismissed {hidden ? `(${hidden} dismissed)` : ""}
        </label>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {visible.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">No active alerts. All monitored conditions within thresholds.</li>}
        {visible.map((a) => {
          const isOpen = open === a.id;
          return (
            <li key={a.id} className={`px-3 py-2 ${a.status === "resolved" || a.dismissed ? "opacity-50" : ""}`} style={{ borderLeft: `3px solid ${a.severity === "CRITICAL" ? "var(--crit)" : a.severity === "WARNING" ? "var(--warn)" : "var(--accent)"}` }}>
              <button className="w-full text-left" onClick={() => setOpen(isOpen ? null : a.id)} aria-expanded={isOpen}>
                <div className="flex items-center gap-2">
                  <SevBadge sev={a.severity} small />
                  <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink2">{a.worldName ?? "Colony"}</span>
                  {a.acknowledged && a.status === "active" && <span className="text-[9px] text-muted">ACK</span>}
                  {a.status === "resolved" && <span className="text-[9px] text-good">RESOLVED</span>}
                  <span className="num ml-auto shrink-0 text-[10px] text-muted">{age(a.firstSeen, now)}</span>
                </div>
                <div className="mt-0.5 text-[13px] font-semibold text-ink">{a.title}</div>
                <div className="text-xs text-ink2">{a.what}</div>
              </button>
              {isOpen && (
                <div className="mt-2 space-y-1.5 text-xs">
                  <p><span className="text-muted">Why it matters: </span>{a.why}</p>
                  <p><span className="text-muted">Urgency: </span>{a.urgency}</p>
                  {a.actions.length > 0 && (
                    <div>
                      <div className="text-muted">Consider:</div>
                      <ol className="ml-4 list-decimal text-ink2">{a.actions.map((x) => <li key={x}>{x}</li>)}</ol>
                    </div>
                  )}
                  <div className="num rounded bg-[var(--panel-2)] px-2 py-1 text-[10px] text-ink2">
                    <span className="text-muted">Observed: </span>
                    {Object.entries(a.evidence).map(([k, v]) => `${k}=${v}`).join(" · ")}
                  </div>
                  {a.assumptions && a.assumptions.length > 0 && (
                    <div className="text-[10px] text-muted">Assumptions: {a.assumptions.join(" · ")}</div>
                  )}
                </div>
              )}
              {a.status === "active" && (
                <div className="mt-1.5 flex gap-2">
                  {!a.acknowledged && <button onClick={() => void alertAction(a.id, "acknowledge")} className="rounded border border-line px-2 py-0.5 text-[10px] text-ink2 hover:border-ink2">Acknowledge</button>}
                  {!a.dismissed && <button onClick={() => void alertAction(a.id, "dismiss")} className="rounded border border-line px-2 py-0.5 text-[10px] text-ink2 hover:border-ink2">Dismiss</button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------ resource matrix */

const MATRIX: { key: string; label: string; get: (w: WorldState) => number | null; fmt: (n: number | null) => string; field?: HistoryField }[] = [
  { key: "food", label: "Food", get: (w) => w.foodKcal, fmt: kcal, field: "kcal" },
  { key: "o2", label: "Oxygen (free)", get: (w) => w.atmosphere?.oxygenKg ?? null, fmt: kg, field: "o2" },
  { key: "power", label: "Electricity (stored)", get: (w) => (w.power && w.power.batteryCount ? w.power.batteryStoredJ : null), fmt: joules, field: "battJ" },
  ...(["water", "pollutedWater", "coal", "petroleum", "crudeOil", "naturalGas", "refinedMetal", "metalOre", "buildingStone", "plastic"] as ResourceKey[]).map((k) => ({
    key: k,
    label: RESOURCE_LABELS[k],
    get: (w: WorldState) => w.resources[k].total,
    fmt: kg,
    field: ({ water: "water", pollutedWater: "dirtyWater", coal: "coal", petroleum: "petroleum", naturalGas: "gas", refinedMetal: "metal", buildingStone: "stone", plastic: "plastic" } as Partial<Record<ResourceKey, HistoryField>>)[k],
  })),
];

export function ResourceMatrix({ s, worlds }: { s: DashboardState; worlds: WorldState[] }) {
  const tr = (w: number, f?: HistoryField) => (f ? s.trends.find((t) => t.worldId === w && t.field === f) : undefined);
  return (
    <section className="panel overflow-hidden" aria-label="Critical resources">
      <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <h2 className="panel-title">Critical Resource Monitoring</h2>
        <span className="text-[10px] text-muted">storage + revealed map · ↑ rising ↓ falling → stable · not yet enough history</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted">
              <th className="px-3 py-1.5 text-left font-medium">Resource</th>
              {worlds.map((w) => (
                <th key={w.id} className="px-3 py-1.5 text-right font-medium">
                  <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: worldColor(w.id) }} />
                  {w.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {MATRIX.map((row) => (
              <tr key={row.key} className="hover:bg-[var(--panel-2)]">
                <td className="px-3 py-1 text-ink2">{row.label}</td>
                {worlds.map((w) => {
                  const v = row.get(w);
                  return (
                    <td key={w.id} className="num px-3 py-1 text-right">
                      <span className={v === null ? "text-muted" : ""}>{row.fmt(v)}</span> <TrendArrow t={tr(w.id, row.field)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ power */

export function PowerPanel({ s, worlds }: { s: DashboardState; worlds: WorldState[] }) {
  const proj = (w: number, l: string): Projection | undefined => s.projections.find((p) => p.worldId === w && p.label === l);
  return (
    <section className="panel" aria-label="Power management">
      <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <h2 className="panel-title">Power Management</h2>
        <span className="text-[10px] text-muted">generation = sum of generator ratings (live output not exposed)</span>
      </div>
      <div className="divide-y divide-line">
        {worlds.map((w) => {
          const p = w.power;
          if (!p) return <div key={w.id} className="px-3 py-2 text-xs text-muted">{w.name}: power data N/A {w.meta.power.error ? `(${w.meta.power.error})` : ""}</div>;
          const net = p.generatorRatedW - p.consumerUsedW;
          const batt = proj(w.id, "Battery charge");
          const fuels = (["Coal", "Petroleum", "Natural gas"] as const).map((l) => [l, proj(w.id, l)] as const).filter(([, x]) => x && x.cycles !== null);
          return (
            <div key={w.id} className="grid grid-cols-[minmax(0,1.3fr)_repeat(5,minmax(0,1fr))] items-center gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 truncate text-xs font-semibold">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: worldColor(w.id) }} /> {w.name}
                </div>
                <div className="text-[10px] text-muted">
                  gens {p.generatorOperational}/{p.generatorCount} operational{p.generatorEmpty ? ` · ${p.generatorEmpty} empty` : ""} · {p.consumerPowered}/{p.consumerCount} consumers powered
                </div>
              </div>
              <Stat label="Rated gen" value={watts(p.generatorRatedW)} />
              <Stat label="Live draw" value={watts(p.consumerUsedW)} sub={`peak ${watts(p.consumerNeededW)}`} />
              <Stat label="Net (rated−draw)" value={`${net >= 0 ? "+" : ""}${watts(net)}`} tone={net < 0 ? "var(--warn)" : undefined} sub={net < 0 ? "deficit" : "upper bound"} />
              <div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Battery</div>
                <div className="num text-sm font-semibold">{p.batteryCount ? pct(p.batteryPct) : "no batteries"}</div>
                {p.batteryCount > 0 && <div className="num text-[10px] text-muted">{joules(p.batteryStoredJ)} of {joules(p.batteryCapacityJ)}</div>}
                <Bar value={p.batteryPct} max={100} color={worldColor(w.id)} label={`${w.name} battery`} />
              </div>
              <div className="text-[10px] text-muted">
                {batt?.cycles != null ? <div className="text-warn">battery empty in ~{cycles(batt.cycles)}</div> : <div>battery runway: {batt ? (batt.confidence === "insufficient-data" ? "insufficient data" : "not draining") : NA}</div>}
                {fuels.length ? fuels.map(([l, x]) => <div key={l}>{l} exhausted in ~{cycles(x!.cycles)} <span className="text-muted">({x!.confidence})</span></div>) : <div>fuel runway: no declining fuel</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- workforce */

export function WorkforcePanel({ s, worlds }: { s: DashboardState; worlds: WorldState[] }) {
  const th = s.thresholds;
  return (
    <section className="panel" aria-label="Duplicant health and workforce">
      <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
        <h2 className="panel-title">Duplicant Health & Workforce</h2>
        <span className="text-[10px] text-muted">hungry &lt;{th.hungryKcal} kcal · low breath &lt;{th.lowBreathPct}% · stressed ≥{th.stressWarningPct}% · injured &lt;50% HP</span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted">
            {["World", "Total", "Able", "Hungry", "Low O₂", "Stressed", "Injured", "Incap.", "Idle"].map((h, i) => (
              <th key={h} className={`px-3 py-1.5 font-medium ${i ? "text-right" : "text-left"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {worlds.filter((w) => w.population > 0).map((w) => {
            const d = w.dupes;
            const able = d.filter((x) => !x.incapacitated && !x.starving && !x.lowBreath && x.risk !== "critical").length;
            const cells: [number | null, boolean][] = [
              [d.length, false],
              [able, able / Math.max(1, d.length) < 0.5],
              [d.filter((x) => x.hungry).length, false],
              [d.filter((x) => x.lowBreath).length, d.some((x) => x.lowBreath)],
              [d.filter((x) => x.highStress).length, false],
              [d.filter((x) => x.healthPct < 50 && !x.incapacitated).length, false],
              [d.filter((x) => x.incapacitated).length, d.some((x) => x.incapacitated)],
              [d.some((x) => x.idle === null) ? null : d.filter((x) => x.idle).length, false],
            ];
            return (
              <tr key={w.id}>
                <td className="px-3 py-1 text-ink2"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: worldColor(w.id) }} />{w.name}</td>
                {cells.map(([v, bad], i) => (
                  <td key={i} className="num px-3 py-1 text-right" style={bad ? { color: "var(--crit)", fontWeight: 600 } : undefined}>{v ?? NA}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* ---------------------------------------------------------- capabilities */

export function CapabilitiesPanel({ s }: { s: DashboardState }) {
  const [open, setOpen] = useState(false);
  const counts = { available: 0, partial: 0, unavailable: 0 };
  for (const c of s.capabilities) counts[c.status]++;
  return (
    <section className="panel text-xs">
      <button className="flex w-full items-center justify-between px-3 py-2" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h2 className="panel-title">Data availability</h2>
        <span className="text-[10px] text-muted">{counts.available} available · {counts.partial} partial · {counts.unavailable} unavailable {open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="divide-y divide-line border-t border-line">
          {s.capabilities.map((c) => (
            <li key={c.feature} className="grid grid-cols-[110px_1fr] gap-2 px-3 py-1.5">
              <span style={{ color: c.status === "available" ? "var(--good)" : c.status === "partial" ? "var(--warn)" : "var(--muted)" }} className="text-[10px] font-semibold uppercase tracking-wider">
                {c.status === "available" ? "✓ " : c.status === "partial" ? "◐ " : "✕ "}{c.status}
              </span>
              <span>
                <span className="text-ink">{c.feature}</span> <span className="num text-[10px] text-muted">{c.source}</span>
                <span className="block text-[10px] text-muted">{c.note}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
