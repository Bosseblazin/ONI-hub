import type { CapabilityReport } from "../model/types";

/**
 * What the dashboard can and cannot show, based on the OniMcp 0.2.6 resource
 * surface. `failed` marks live read failures so the panel reflects reality.
 */
const BASE: CapabilityReport[] = [
  { feature: "Cycle, population, pause/speed", status: "available", source: "oni://colony/status", note: "Integer cycle only; fractional time is estimated from wall time × game speed." },
  { feature: "Multi-asteroid list (incl. rocket interiors)", status: "available", source: "oni://world/list", note: "All world containers are listed and polled per-world. 'Settled' is inferred from duplicants or power infrastructure." },
  { feature: "Duplicant vitals (HP, stress, calories, breath)", status: "available", source: "oni://dupes/vitals", note: "Per duplicant with worldId." },
  { feature: "Incapacitation", status: "partial", source: "oni://dupes/vitals", note: "Derived from HP ≤ 0. The Incapacitated status itself is not exposed." },
  { feature: "Workforce: idle / stuck duplicants", status: "available", source: "oni://dupes/status-check", note: "Polled every ~30 s with a small reachability radius to limit cost." },
  { feature: "Food reserves per asteroid", status: "available", source: "oni://food/summary?worldId", note: "Uses totalKcal only — OniMcp's daysRemaining divides by the global population, so runway is recomputed per asteroid." },
  { feature: "Food production / consumption rates", status: "partial", source: "derived", note: "Not exposed. Net rate is derived from the stock trend once enough game time has elapsed." },
  { feature: "Oxygen production / consumption", status: "partial", source: "oni://atmosphere/breathability?worldId", note: "Only free O₂ mass in revealed cells. Production and consumption rates are not exposed; net change is derived from the trend." },
  { feature: "Power: rated generation, live consumption, batteries", status: "available", source: "oni://power/summary?worldId", note: "Generation is the sum of wattage *ratings*, not live output." },
  { feature: "Live generator output", status: "unavailable", source: "—", note: "Would need OniMcp to expose Generator.WattageRating × activity or circuit ‘joules produced’ statistics." },
  { feature: "Generator activity / empty fuel", status: "available", source: "oni://power/summary?worldId", note: "Operational and IsEmpty counts." },
  { feature: "Water, polluted water, petroleum, crude oil", status: "available", source: "oni://resources/inventory + oni://fluid/liquid/summary", note: "Storage/tanks + free liquid on the revealed map. Liquid inside pipes and unrevealed cells is not counted." },
  { feature: "Coal, metals, stone, plastic", status: "available", source: "oni://resources/inventory?worldId", note: "Stored and loose items on revealed cells." },
  { feature: "Natural gas", status: "partial", source: "oni://resources/inventory + oni://atmosphere/summary", note: "Free methane counted only if it is among the top 10 gases by mass on that asteroid." },
  { feature: "Average temperature", status: "available", source: "oni://thermal/summary?worldId", note: "Average of all revealed cells (whole asteroid, not just the base)." },
  { feature: "Building overheat risk", status: "unavailable", source: "oni://thermal/overheat-risk", note: "Exists in OniMcp but is not yet integrated (heavier read; candidate for v2)." },
  { feature: "Resource stockpile categories", status: "unavailable", source: "oni://resources/stockpile", note: "OniMcp 0.2.6 returns a placeholder with no data." },
  { feature: "Native game notifications/alerts", status: "unavailable", source: "oni://colony/alerts", note: "OniMcp's alerts are its own fixed heuristics on the active world, not the game's notification list; this dashboard runs its own alert engine instead." },
  { feature: "Game version / mod list", status: "unavailable", source: "—", note: "Not exposed through read-only resources. OniMcp server version is shown from initialize." },
  { feature: "Game control (any write)", status: "unavailable", source: "tools/call", note: "Deliberately blocked in v1. The client refuses tools/call before any network I/O." },
];

export function buildCapabilities(failed: Map<string, string>): CapabilityReport[] {
  return BASE.map((c) => {
    const uri = c.source.split(/[ ?+]/)[0]!;
    const err = failed.get(uri);
    if (err && c.status !== "unavailable") return { ...c, status: "partial", note: `${c.note} Live read currently failing: ${err}` };
    return c;
  });
}
