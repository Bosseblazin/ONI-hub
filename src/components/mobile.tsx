"use client";
import Link from "next/link";
import { foodDemandRunway } from "@/lib/calc/trend";
import type { DashboardState, WorldState } from "@/lib/model/types";
import type { OpsState } from "@/lib/ops/types";
import { age, cycles, kg, pct, watts, worldColor } from "@/lib/ui/format";
import { AiSummary, Section } from "./ops-ui";
import { SevBadge, worldSeverity } from "./panels";
import { useApp, watchState } from "./shell";

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className="num truncate text-[13px] font-semibold" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

function WorldRow({ w, d }: { w: WorldState; d: DashboardState }) {
  const { live } = useApp();
  const sev = d.stale || live.link !== "live" ? "STALE" : worldSeverity(w, d.alerts);
  const run = w.population > 0 ? foodDemandRunway(w.foodKcal, w.population, d.thresholds.kcalPerDupePerCycle) : null;
  const p = w.power;
  const o2pd = w.atmosphere && w.population > 0 ? w.atmosphere.oxygenKg / w.population : null;
  const sick = w.dupes.filter((x) => x.incapacitated || x.starving || x.lowBreath).length;
  const th = d.thresholds;
  return (
    <Link href={`/asteroid/${w.id}`} className="block px-3 py-2.5 active:bg-panel2" style={{ borderLeft: `3px solid ${worldColor(w.id)}` }}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="truncate text-[13px] font-bold">{w.name}</span>
          <span className="ml-2 text-[10px] text-muted">{w.kind === "rocket" ? "rocket" : "asteroid"} · {w.population} dupes</span>
        </div>
        <SevBadge sev={sev} small />
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-2">
        <Metric label="Food" value={cycles(run)} tone={run !== null && run < th.foodRunwayCriticalCycles ? "var(--crit)" : run !== null && run < th.foodRunwayWarningCycles ? "var(--warn)" : undefined} />
        <Metric label="O₂/dupe" value={o2pd === null ? "N/A" : `${o2pd.toFixed(0)}kg`} tone={o2pd !== null && o2pd < th.oxygenKgPerDupeCritical ? "var(--crit)" : o2pd !== null && o2pd < th.oxygenKgPerDupeWarning ? "var(--warn)" : undefined} />
        <Metric label="Battery" value={p && p.batteryCount ? pct(p.batteryPct) : "N/A"} tone={p?.batteryPct !== null && p?.batteryPct !== undefined && p.batteryCount > 0 && p.batteryPct <= th.batteryWarningPct ? "var(--warn)" : undefined} />
        <Metric label="Water" value={kg(w.resources.water.total)} />
        <Metric label="Health" value={w.population ? (sick ? `${sick} ✕` : "OK") : "—"} tone={sick ? "var(--crit)" : undefined} />
      </div>
      {p && p.consumerCount > 0 && <div className="mt-1 text-[10px] text-muted">power: draw {watts(p.consumerUsedW)} / rated gen {watts(p.generatorRatedW)}{p.generatorEmpty ? ` · ${p.generatorEmpty} gen empty` : ""}</div>}
    </Link>
  );
}

function Hero({ d, ops }: { d: DashboardState | null; ops: OpsState | null }) {
  const { live } = useApp();
  const w = watchState(live);
  const active = d?.alerts.filter((a) => a.status === "active" && !a.dismissed && a.severity !== "INFO") ?? [];
  const crit = active.filter((a) => a.severity === "CRITICAL");
  const top = crit[0] ?? active[0];
  const status = !w.ok ? "UNKNOWN" : crit.length ? "IN DANGER" : active.length ? "DEGRADED" : "HEALTHY";
  const color = !w.ok ? "var(--muted)" : crit.length ? "var(--crit)" : active.length ? "var(--warn)" : "var(--good)";
  return (
    <section className="panel overflow-hidden" style={{ borderTop: `3px solid ${color}` }}>
      <div className="px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Civilization status</div>
        <div className="text-2xl font-bold tracking-[0.12em]" style={{ color }}>{status}</div>
        <div className="mt-0.5 text-[13px] text-ink2">
          {!w.ok ? w.detail : top ? <><b className="text-ink">{top.title}</b> — {top.worldName ?? "colony"}</> : "All monitored conditions within thresholds."}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span style={{ color: w.color }}>● {w.label}</span>
          {crit.length > 0 && <span className="text-crit">{crit.length} critical</span>}
          {active.length - crit.length > 0 && <span className="text-warn">{active.length - crit.length} warnings</span>}
          {ops && <span className="text-muted">mode: {ops.mode.mode}</span>}
        </div>
      </div>
    </section>
  );
}

function Events({ d, ops }: { d: DashboardState; ops: OpsState }) {
  const { now } = useApp();
  const ev = [
    ...ops.notifications.map((n) => ({ at: n.at, sev: n.severity, text: n.title })),
    ...ops.decisions.map((x) => ({ at: x.at, sev: "INFO" as const, text: x.summary })),
    ...d.alerts.filter((a) => a.oneShot).map((a) => ({ at: a.firstSeen, sev: "INFO" as const, text: `${a.title}: ${a.what}` })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);
  if (!ev.length) return <p className="px-3 py-3 text-xs text-muted">No events yet.</p>;
  return (
    <ul className="divide-y divide-line text-xs">
      {ev.map((e, i) => (
        <li key={i} className="flex gap-2 px-3 py-1.5">
          <span className="mt-0.5" style={{ color: e.sev === "CRITICAL" ? "var(--crit)" : e.sev === "WARNING" ? "var(--warn)" : "var(--accent)" }}>●</span>
          <span className="flex-1 text-ink2">{e.text}</span>
          <span className="num shrink-0 text-[10px] text-muted">{age(e.at, now)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Phone overview: everything needed to judge colony health in a few seconds. */
export function MobileStatus() {
  const { live } = useApp();
  const d = live.dashboard;
  const ops = live.ops;
  const worlds = d?.snapshot?.worlds.filter((w) => w.settled) ?? [];
  const crit = d?.alerts.filter((a) => a.status === "active" && !a.dismissed && a.severity === "CRITICAL") ?? [];
  return (
    <div className="space-y-3 p-3 lg:hidden">
      <Hero d={d} ops={ops} />
      {d?.snapshot && (
        <Section title="Asteroids" right={<span className="text-[10px] text-muted">tap for detail</span>}>
          <div className="divide-y divide-line">{worlds.map((w) => <WorldRow key={w.id} w={w} d={d} />)}</div>
        </Section>
      )}
      {crit.length > 0 && (
        <Section title="Critical warnings" right={<Link href="/alerts" className="text-[11px] text-accent">all alerts →</Link>}>
          <ul className="divide-y divide-line">
            {crit.slice(0, 5).map((a) => (
              <li key={a.id} className="px-3 py-2 text-xs" style={{ borderLeft: "3px solid var(--crit)" }}>
                <div className="font-semibold text-ink">{a.title} <span className="font-normal text-muted">· {a.worldName ?? "colony"}</span></div>
                <div className="text-ink2">{a.what}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {ops && (
        <Section title="Claude — operations" right={<Link href="/ops" className="text-[11px] text-accent">details →</Link>}>
          <AiSummary ops={ops} compact />
        </Section>
      )}
      <Link href="/command" className="panel flex items-center justify-between px-4 py-3 text-sm active:bg-panel2">
        <span><b className="text-accent">✦ Message Claude</b> <span className="text-muted">— give an order</span></span>
        <span className="text-muted">→</span>
      </Link>
      {d && ops && <Section title="Recent events"><Events d={d} ops={ops} /></Section>}
    </div>
  );
}
