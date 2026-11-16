"use client";
import Link from "next/link";
import { use, useState } from "react";
import { LineChart, type Series } from "@/components/charts";
import { AlertPanel, Banners, Header, SevBadge, TrendArrow, worldSeverity } from "@/components/panels";
import { RESOURCE_LABELS } from "@/lib/model/normalize";
import type { HistoryField, HistorySample, ResourceKey } from "@/lib/model/types";
import { METRIC_GROUPS } from "@/lib/model/types";
import { age, cycles, joules, kcal, kg, NA, pct, temp, watts, worldColor } from "@/lib/ui/format";
import { useDashboard, useHistory, useNow } from "@/lib/ui/hooks";

const SLOT = ["var(--s1)", "var(--s2)", "var(--s3)"];
const pts = (rows: HistorySample[], f: HistoryField) => rows.flatMap((r) => (typeof r[f] === "number" ? [{ x: r.c, y: r[f] as number }] : []));
const ser = (rows: HistorySample[], defs: [HistoryField, string][]): Series[] => defs.map(([f, l], i) => ({ key: f, label: l, color: SLOT[i]!, points: pts(rows, f) }));
const RANGES = [{ l: "3 cy", v: 3 }, { l: "10 cy", v: 10 }, { l: "30 cy", v: 30 }, { l: "All", v: undefined }] as const;

export default function AsteroidPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const wid = Number(id);
  const { state: s, linkUp } = useDashboard();
  const now = useNow();
  const [range, setRange] = useState<number | undefined>(10);
  const cur = s?.snapshot?.time?.estCycles;
  const rows = useHistory(Number.isInteger(wid) ? wid : null, 30_000, range !== undefined && cur !== undefined ? Math.floor(cur - range) : undefined);
  const w = s?.snapshot?.worlds.find((x) => x.id === wid);

  if (!s) return <div className="p-8 text-sm text-muted">Connecting…</div>;
  if (!w) {
    return (
      <div className="min-h-screen">
        <Header s={s} now={now} linkUp={linkUp} />
        <div className="p-8 text-sm text-ink2">World {id} is not in the current world list. <Link href="/" className="text-accent underline">Back to overview</Link></div>
      </div>
    );
  }
  const tr = (f: HistoryField) => s.trends.find((t) => t.worldId === w.id && t.field === f);
  const proj = s.projections.filter((p) => p.worldId === w.id);
  const alerts = s.alerts.filter((a) => a.worldId === w.id);
  const p = w.power;

  return (
    <div className="min-h-screen">
      <Header s={s} now={now} linkUp={linkUp} />
      <Banners s={s} />
      <main className="space-y-3 p-3">
        <div className="panel flex flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3" style={{ borderTop: `3px solid ${worldColor(w.id)}` }}>
          <Link href="/" className="text-xs text-muted hover:text-ink2">← Overview</Link>
          <div>
            <h2 className="text-lg font-bold tracking-wide">{w.name}</h2>
            <div className="text-[11px] text-muted">{w.kind === "rocket" ? "Rocket interior" : "Asteroid"} · world {w.id} · {w.asteroidType ?? "type unknown"} {w.isActive ? "· currently viewed in game" : ""}</div>
          </div>
          <SevBadge sev={s.stale ? "STALE" : worldSeverity(w, s.alerts)} />
          {!w.settled && <span className="text-xs text-muted">Unsettled: only power is probed (every 5 min). No live monitoring of food, atmosphere or temperature.</span>}
          <div className="ml-auto flex gap-1" role="group" aria-label="History range">
            {RANGES.map((r) => (
              <button key={r.l} onClick={() => setRange(r.v)} className={`rounded border px-2 py-0.5 text-[11px] ${range === r.v ? "border-accent text-accent" : "border-line text-ink2 hover:border-ink2"}`}>{r.l}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          {[
            ["Population", String(w.population), null],
            ["Food", kcal(w.foodKcal), tr("kcal")],
            ["O₂ (free)", kg(w.atmosphere?.oxygenKg), tr("o2")],
            ["Battery", p && p.batteryCount ? pct(p.batteryPct) : NA, tr("battJ")],
            ["Live draw", watts(p?.consumerUsedW), null],
            ["Rated gen", watts(p?.generatorRatedW), null],
            ["Water", kg(w.resources.water.total), tr("water")],
            ["Avg temp", temp(w.thermal?.avgC), tr("avgT")],
          ].map(([l, v, t]) => (
            <div key={l as string} className="panel px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.12em] text-muted">{l as string}</div>
              <div className="num text-lg font-semibold">{v as string} <TrendArrow t={t as never} /></div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="panel p-3"><LineChart title="Food reserves" series={ser(rows, [["kcal", "Food"]])} format={(v) => kcal(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Power: rated generation vs consumption" series={ser(rows, [["genW", "Rated gen"], ["useW", "Live draw"], ["needW", "Peak demand"]])} format={(v) => watts(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Battery charge" series={ser(rows, [["battJ", "Stored"]])} format={(v) => joules(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Oxygen & CO₂ (free, revealed cells)" series={ser(rows, [["o2", "Oxygen"], ["co2", "CO₂"]])} format={(v) => kg(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Water reserves" series={ser(rows, [["water", "Water"], ["dirtyWater", "Polluted water"]])} format={(v) => kg(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Fuel reserves" series={ser(rows, [["coal", "Coal"], ["petroleum", "Petroleum"], ["gas", "Natural gas"]])} format={(v) => kg(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Materials" series={ser(rows, [["metal", "Refined metal"], ["stone", "Building stone"], ["plastic", "Plastic"]])} format={(v) => kg(v)} yMin={0} /></div>
            <div className="panel p-3"><LineChart title="Population" series={ser(rows, [["pop", "Duplicants"]])} format={(v) => v.toFixed(0)} yMin={0} /></div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex max-h-[520px] flex-col"><AlertPanel alerts={alerts} now={now} /></div>
            <section className="panel">
              <h3 className="panel-title border-b border-line px-3 py-2">Projections</h3>
              <ul className="divide-y divide-line text-xs">
                {proj.length === 0 && <li className="px-3 py-3 text-muted">No projections — need settled population and history.</li>}
                {proj.map((x) => (
                  <li key={x.label} className="px-3 py-1.5">
                    <div className="flex justify-between">
                      <span className="text-ink2">{x.label}</span>
                      <span className="num">{x.cycles === null ? (x.confidence === "insufficient-data" ? "insufficient data" : "not declining") : `~${cycles(x.cycles)}`}</span>
                    </div>
                    <div className="text-[10px] text-muted">{x.method} · confidence: {x.confidence}</div>
                    <div className="text-[10px] text-muted">Assumes: {x.assumptions.join("; ")}</div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="panel overflow-x-auto">
            <h3 className="panel-title border-b border-line px-3 py-2">Duplicants ({w.dupes.length})</h3>
            <table className="w-full text-xs">
              <thead><tr className="text-[10px] uppercase tracking-wider text-muted">{["Name", "HP", "Stress", "Calories", "Breath", "Status", "Notes"].map((h, i) => <th key={h} className={`px-3 py-1.5 font-medium ${i && i < 5 ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {w.dupes.map((d) => (
                  <tr key={d.name}>
                    <td className="px-3 py-1">{d.name}</td>
                    <td className="num px-3 py-1 text-right" style={d.incapacitated ? { color: "var(--crit)" } : undefined}>{d.healthPct.toFixed(0)}</td>
                    <td className="num px-3 py-1 text-right" style={d.highStress ? { color: "var(--warn)" } : undefined}>{pct(d.stressPct)}</td>
                    <td className="num px-3 py-1 text-right" style={d.hungry ? { color: "var(--warn)" } : undefined}>{kcal(d.caloriesKcal)}</td>
                    <td className="num px-3 py-1 text-right" style={d.lowBreath ? { color: "var(--crit)" } : undefined}>{pct(d.breathPct)}</td>
                    <td className="px-3 py-1">{d.incapacitated ? <SevBadge sev="CRITICAL" small /> : d.risk === "critical" ? <SevBadge sev="CRITICAL" small /> : d.risk === "warning" ? <SevBadge sev="WARNING" small /> : d.risk === "ok" ? <SevBadge sev="OK" small /> : <span className="text-muted">{NA}</span>}</td>
                    <td className="px-3 py-1 text-[10px] text-muted">{[d.incapacitated && "incapacitated (HP 0)", d.starving && "starving", d.idle && "idle", ...d.reasons.filter((r) => !r.startsWith("idle_"))].filter(Boolean).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel text-xs">
            <h3 className="panel-title border-b border-line px-3 py-2">Resources & data freshness</h3>
            <table className="w-full">
              <tbody className="divide-y divide-line">
                {(Object.keys(RESOURCE_LABELS) as ResourceKey[]).map((k) => {
                  const r = w.resources[k];
                  return (
                    <tr key={k}>
                      <td className="px-3 py-1 text-ink2">{RESOURCE_LABELS[k]}</td>
                      <td className="num px-3 py-1 text-right">{kg(r.total)}</td>
                      <td className="num px-3 py-1 text-right text-[10px] text-muted">{r.free !== null ? `${kg(r.stored)} stored · ${kg(r.free)} free` : r.stored !== null ? "stored/loose" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ul className="mt-2 border-t border-line px-3 py-2">
              {METRIC_GROUPS.map((g) => (
                <li key={g} className="flex justify-between py-0.5 text-[11px]">
                  <span className="text-muted">{g}</span>
                  <span className="num" style={w.meta[g].error ? { color: "var(--warn)" } : undefined}>{w.meta[g].error ? `error: ${w.meta[g].error}` : age(w.meta[g].fetchedAt, now)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
