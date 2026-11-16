import { confidenceFrom, foodDemandRunway, runwayFromTrend } from "../calc/trend";
import type {
  AlertCandidate,
  ColonySnapshot,
  HistoryField,
  MetricGroup,
  Severity,
  Thresholds,
  Trend,
  WorldState,
} from "../model/types";

export interface RuleContext {
  snap: ColonySnapshot;
  prev: ColonySnapshot | null;
  th: Thresholds;
  now: number;
  trend: (worldId: number, field: HistoryField) => Trend | undefined;
}

/** A rule reports, for every scope it could evaluate, the candidate (or null if clear). */
export interface RuleResult {
  scope: string;
  candidate: AlertCandidate | null;
}

export type Rule = (ctx: RuleContext) => RuleResult[];

const fmt = (n: number, d = 1) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(d));
const kg = (n: number) => (n >= 1000 ? `${fmt(n / 1000, 1)} t` : `${fmt(n, 0)} kg`);

export function fresh(w: WorldState, g: MetricGroup, ctx: RuleContext): boolean {
  const t = w.meta[g].fetchedAt;
  return t !== null && ctx.now - t <= ctx.th.staleAfterSeconds * 1000 * 4; // slow tiers poll every ~60s
}

function scope(rule: string, w: WorldState | null) {
  return `${rule}:${w ? w.id : "colony"}`;
}

function cand(
  rule: string,
  w: WorldState | null,
  severity: Severity,
  p: Omit<AlertCandidate, "id" | "rule" | "severity" | "worldId" | "worldName">,
): AlertCandidate {
  return { id: scope(rule, w), rule, severity, worldId: w?.id ?? null, worldName: w?.name ?? null, ...p };
}

const inhabited = (ctx: RuleContext) => ctx.snap.worlds.filter((w) => w.population > 0);

/* ---------------------------------------------------------------- FOOD */

export const foodRunwayRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "food", ctx) && w.foodKcal !== null)
    .map((w) => {
      const s = scope("food-runway", w);
      const demand = foodDemandRunway(w.foodKcal, w.population, ctx.th.kcalPerDupePerCycle)!;
      const t = ctx.trend(w.id, "kcal");
      if (t?.reliable && t.direction === "increasing") return { scope: s, candidate: null };
      const severity: Severity | null =
        demand < ctx.th.foodRunwayCriticalCycles ? "CRITICAL" : demand < ctx.th.foodRunwayWarningCycles ? "WARNING" : null;
      if (!severity) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("food-runway", w, severity, {
          title: severity === "CRITICAL" ? "Food reserves approaching exhaustion" : "Food reserves low",
          what: `Stored food covers about ${fmt(demand)} cycles of demand for ${w.population} duplicants.`,
          why: "Hungry duplicants lose productivity, then starve and become incapacitated. Food chains take several cycles to recover.",
          urgency: severity === "CRITICAL" ? `Act now: under ${ctx.th.foodRunwayCriticalCycles} cycles of food.` : "Plan food expansion within the next few cycles.",
          actions: [
            "Prioritise farm tending, harvesting and cooking errands.",
            "Check farm conditions (temperature, irrigation, atmosphere, light).",
            "Suspend non-essential construction to free labour.",
            "Do not accept more duplicants from the Printing Pod until food stabilises.",
          ],
          evidence: { foodKcal: Math.round(w.foodKcal!), population: w.population, demandRunwayCycles: Number(demand.toFixed(2)) },
          assumptions: [
            `Demand of ${ctx.th.kcalPerDupePerCycle} kcal per duplicant per cycle (standard; traits vary).`,
            "Assumes no new food is produced. Spoiling food is still counted.",
            t?.reliable ? `Food trend: ${t.direction} (${fmt(t.slopePerCycle ?? 0, 0)} kcal/cycle).` : "No reliable food trend yet.",
          ],
        }),
      };
    });

export const foodTrendRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "food", ctx) && w.foodKcal !== null)
    .map((w) => {
      const s = scope("food-declining", w);
      const t = ctx.trend(w.id, "kcal");
      if (!t || !t.reliable || t.direction !== "decreasing") return { scope: s, candidate: null };
      const runway = runwayFromTrend(w.foodKcal, t);
      if (runway === null || runway > ctx.th.foodRunwayWarningCycles * 2) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("food-declining", w, "WARNING", {
          title: "Food production falling behind consumption",
          what: `Food stock is falling by ~${fmt(-t.slopePerCycle!, 0)} kcal per cycle; at this rate it runs out in ~${fmt(runway)} cycles.`,
          why: "A sustained net deficit means farms cannot keep up with the current population.",
          urgency: `Projected exhaustion in ~${fmt(runway)} cycles (${confidenceFrom(t)} confidence).`,
          actions: ["Add or expand farms.", "Check that farms are tended, irrigated and within temperature range.", "Review recent population growth."],
          evidence: { foodKcal: Math.round(w.foodKcal!), slopeKcalPerCycle: Math.round(t.slopePerCycle!), trendSamples: t.samples },
          assumptions: [t.reason, "Linear extrapolation; harvest timing makes food stock lumpy."],
        }),
      };
    });

/* ----------------------------------------------------------- DUPLICANTS */

export const starvationRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "vitals", ctx))
    .map((w) => {
      const s = scope("starving", w);
      const starving = w.dupes.filter((d) => d.starving);
      const hungry = w.dupes.filter((d) => d.hungry);
      if (starving.length > 0) {
        return {
          scope: s,
          candidate: cand("starving", w, "CRITICAL", {
            title: "Duplicants are starving",
            what: `${starving.length} duplicant(s) at or below ${ctx.th.starvingKcal} kcal: ${starving.map((d) => d.name).join(", ")}.`,
            why: "Starving duplicants take damage and will become incapacitated, then die.",
            urgency: "Immediate.",
            actions: ["Make sure edible food is reachable and allowed for these duplicants.", "Check mess table access and schedules.", "Prioritise cooking and food delivery."],
            evidence: { starving: starving.length, hungry: hungry.length, population: w.population },
          }),
        };
      }
      if (hungry.length >= Math.max(2, Math.ceil(w.population / 2))) {
        return {
          scope: s,
          candidate: cand("starving", w, "WARNING", {
            title: "Many duplicants are hungry",
            what: `${hungry.length} of ${w.population} duplicants are below ${ctx.th.hungryKcal} kcal.`,
            why: "Widespread hunger usually means food is unavailable or unreachable, not just that it is meal time.",
            urgency: "Investigate this cycle.",
            actions: ["Confirm food is stocked and reachable.", "Check that food restrictions (Consumables screen) allow available food."],
            evidence: { hungry: hungry.length, population: w.population },
          }),
        };
      }
      return { scope: s, candidate: null };
    });

export const incapacitatedRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "vitals", ctx))
    .map((w) => {
      const s = scope("incapacitated", w);
      const down = w.dupes.filter((d) => d.incapacitated);
      if (down.length === 0) return { scope: s, candidate: null };
      const sev: Severity = down.length >= ctx.th.incapacitatedCritical ? "CRITICAL" : "WARNING";
      return {
        scope: s,
        candidate: cand("incapacitated", w, sev, {
          title: down.length > 1 ? "Multiple duplicants incapacitated" : "Duplicant incapacitated",
          what: `${down.length} duplicant(s) at 0 HP: ${down.map((d) => d.name).join(", ")}.`,
          why: "Incapacitated duplicants die if they are not rescued to a medical bed in time.",
          urgency: "Immediate: rescue window is limited.",
          actions: ["Ensure a Triage Cot/Sick Bay is built and reachable.", "Remove the hazard that caused the injuries (combat, scalding, suffocation)."],
          evidence: { incapacitated: down.length, population: w.population },
          assumptions: ["Derived from HitPoints <= 0. OniMcp does not expose the Incapacitated status flag directly."],
        }),
      };
    });

export const suffocationRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "vitals", ctx))
    .map((w) => {
      const s = scope("suffocating", w);
      const low = w.dupes.filter((d) => d.lowBreath);
      if (low.length === 0) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("suffocating", w, "CRITICAL", {
          title: "Duplicants are suffocating",
          what: `${low.length} duplicant(s) below ${ctx.th.lowBreathPct}% breath: ${low.map((d) => d.name).join(", ")}.`,
          why: "Duplicants that run out of breath take damage and become incapacitated.",
          urgency: "Immediate.",
          actions: ["Check oxygen production and distribution in their area.", "Look for CO₂ pooling in low work areas.", "Consider an emergency oxygen source (Oxygen Diffuser on algae)."],
          evidence: { lowBreath: low.length, population: w.population },
        }),
      };
    });

export const stressRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "vitals", ctx))
    .map((w) => {
      const s = scope("stress", w);
      const crit = w.dupes.filter((d) => d.stressPct >= ctx.th.stressCriticalPct);
      const warn = w.dupes.filter((d) => d.stressPct >= ctx.th.stressWarningPct);
      if (crit.length === 0 && warn.length < Math.max(2, Math.ceil(w.population / 2))) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("stress", w, "WARNING", {
          title: crit.length ? "Stress response imminent" : "Colony-wide stress rising",
          what: crit.length
            ? `${crit.length} duplicant(s) at or above ${ctx.th.stressCriticalPct}% stress: ${crit.map((d) => `${d.name} (${fmt(d.stressPct, 0)}%)`).join(", ")}.`
            : `${warn.length} of ${w.population} duplicants above ${ctx.th.stressWarningPct}% stress.`,
          why: "At 100% stress duplicants have a stress reaction (vomiting, destruction, binge eating, crying) that disrupts operations.",
          urgency: crit.length ? "Within the next cycle." : "Address over the next few cycles.",
          actions: ["Check morale versus expectations (better food, rooms, recreation).", "Give downtime in the schedule.", "Remove stressors such as polluted air or long commutes."],
          evidence: { atOrAboveCritical: crit.length, atOrAboveWarning: warn.length, population: w.population },
        }),
      };
    });

export const workforceRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "vitals", ctx) && w.population >= 2)
    .map((w) => {
      const s = scope("workforce", w);
      const unavailable = w.dupes.filter((d) => d.incapacitated || d.risk === "critical" || d.starving || d.lowBreath);
      const available = w.population - unavailable.length;
      if (available / w.population >= 0.5) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("workforce", w, "CRITICAL", {
          title: "Insufficient labour for essential operations",
          what: `Only ${available} of ${w.population} duplicants are able to work.`,
          why: "With half the colony out of action, food, oxygen and power maintenance fall behind and problems compound.",
          urgency: "Immediate.",
          actions: ["Resolve the underlying emergencies first (food, breath, injuries).", "Restrict errands to life support until labour recovers."],
          evidence: { available, unavailable: unavailable.length, population: w.population },
          assumptions: ["Unavailable = incapacitated, starving, suffocating, or flagged critical by OniMcp status-check."],
        }),
      };
    });

/* ---------------------------------------------------------------- OXYGEN */

export const oxygenRule: Rule = (ctx) =>
  inhabited(ctx)
    .filter((w) => fresh(w, "atmosphere", ctx) && w.atmosphere)
    .map((w) => {
      const s = scope("oxygen", w);
      const a = w.atmosphere!;
      const perDupe = a.oxygenKg / w.population;
      const t = ctx.trend(w.id, "o2");
      const runway = t ? runwayFromTrend(a.oxygenKg, t) : null;
      let sev: Severity | null = null;
      if (perDupe < ctx.th.oxygenKgPerDupeCritical) sev = "CRITICAL";
      else if (runway !== null && runway < 2) sev = "CRITICAL";
      else if (perDupe < ctx.th.oxygenKgPerDupeWarning) sev = "WARNING";
      else if (runway !== null && runway < 5) sev = "WARNING";
      if (!sev) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("oxygen", w, sev, {
          title: runway !== null && runway < 5 ? "Oxygen production is insufficient" : "Breathable oxygen is scarce",
          what:
            `${kg(a.oxygenKg)} of free oxygen visible (${fmt(perDupe)} kg per duplicant)` +
            (runway !== null ? `, falling; projected depletion in ~${fmt(runway)} cycles.` : "."),
          why: "Duplicants each consume roughly 60 kg of oxygen per cycle. Running out leads to suffocation colony-wide.",
          urgency: sev === "CRITICAL" ? "Immediate." : "Expand oxygen production soon.",
          actions: ["Check electrolyzers/diffusers are powered and supplied.", "Look for CO₂ accumulation displacing oxygen.", "Add oxygen production before adding duplicants."],
          evidence: { oxygenKg: Math.round(a.oxygenKg), co2Kg: Math.round(a.co2Kg), perDupeKg: Number(perDupe.toFixed(1)), population: w.population },
          assumptions: [
            "Free oxygen in revealed gas cells only (OniMcp atmosphere/breathability). Includes polluted oxygen; excludes bottled/stored oxygen.",
            "OniMcp does not expose oxygen production or consumption rates; the trend is derived from stock changes.",
            ...(t ? [t.reason] : []),
          ],
        }),
      };
    });

/* ----------------------------------------------------------------- POWER */

export const batteryRule: Rule = (ctx) =>
  ctx.snap.worlds
    .filter((w) => fresh(w, "power", ctx) && w.power && w.power.batteryCount > 0 && w.power.consumerCount > 0)
    .map((w) => {
      const s = scope("battery", w);
      const p = w.power!;
      const pct = p.batteryPct ?? 0;
      const t = ctx.trend(w.id, "battJ");
      const declining = !!t?.reliable && t.direction === "decreasing";
      let sev: Severity | null = null;
      if (pct <= ctx.th.batteryCriticalPct && (declining || p.consumerPowered < p.consumerCount)) sev = "CRITICAL";
      else if (pct <= ctx.th.batteryWarningPct && declining) sev = "WARNING";
      if (!sev) return { scope: s, candidate: null };
      const runway = t ? runwayFromTrend(p.batteryStoredJ, t) : null;
      return {
        scope: s,
        candidate: cand("battery", w, sev, {
          title: sev === "CRITICAL" ? "Colony power critically low" : "Battery reserves draining",
          what: `Batteries at ${fmt(pct)}%${runway !== null ? `, projected empty in ~${fmt(runway, 2)} cycles` : ""}. ${p.consumerCount - p.consumerPowered} of ${p.consumerCount} consumers currently unpowered.`,
          why: "When batteries empty, oxygen production, pumps and refrigeration stop.",
          urgency: sev === "CRITICAL" ? "Immediate." : "Within the next cycle.",
          actions: ["Check generator fuel and that generators are not disabled.", "Put non-essential consumers on a Smart Battery / automation cut-off.", "Add generation capacity."],
          evidence: { batteryPct: Number(pct.toFixed(1)), storedKJ: Math.round(p.batteryStoredJ / 1000), unpowered: p.consumerCount - p.consumerPowered },
          assumptions: t ? [t.reason] : [],
        }),
      };
    });

export const powerDeficitRule: Rule = (ctx) =>
  ctx.snap.worlds
    .filter((w) => fresh(w, "power", ctx) && w.power && w.power.consumerCount > 0)
    .map((w) => {
      const s = scope("power-deficit", w);
      const p = w.power!;
      const t = ctx.trend(w.id, "battJ");
      const draining = p.batteryCount > 0 && !!t?.reliable && t.direction === "decreasing" && (t.r2 ?? 0) >= 0.5;
      const noGen = p.generatorCount === 0 || p.generatorOperational === 0;
      if (!draining && !(noGen && p.consumerUsedW > 0)) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("power-deficit", w, "WARNING", {
          title: "Power consumption exceeds generation",
          what: draining
            ? `Stored energy is falling by ~${fmt(-(t!.slopePerCycle ?? 0) / 1000, 0)} kJ per cycle. Consumers draw ${fmt(p.consumerUsedW, 0)} W; rated generation ${fmt(p.generatorRatedW, 0)} W.`
            : `No operational generators while consumers draw ${fmt(p.consumerUsedW, 0)} W.`,
          why: "A sustained deficit eventually empties batteries and blacks out life support.",
          urgency: "Address within the next cycle or two.",
          actions: ["Check fuel supply to generators.", "Add generation or shed load.", "Inspect circuits for overloads or disconnected wires."],
          evidence: { generatorRatedW: Math.round(p.generatorRatedW), consumerUsedW: Math.round(p.consumerUsedW), generatorsOperational: p.generatorOperational },
          assumptions: ["Generation is the sum of generator *ratings*; OniMcp does not expose live generator output.", ...(t ? [t.reason] : [])],
        }),
      };
    });

export const generatorFuelRule: Rule = (ctx) =>
  ctx.snap.worlds
    .filter((w) => fresh(w, "power", ctx) && w.power && w.power.generatorCount > 0)
    .map((w) => {
      const s = scope("generator-empty", w);
      const p = w.power!;
      if (p.generatorEmpty === 0) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("generator-empty", w, "WARNING", {
          title: "Generators without fuel or charge",
          what: `${p.generatorEmpty} of ${p.generatorCount} generators report empty.`,
          why: "Idle generators reduce available power and drain batteries.",
          urgency: "Check this cycle.",
          actions: ["Check fuel delivery (coal, natural gas, petroleum, hydrogen).", "Check manual generators have an operator."],
          evidence: { generatorEmpty: p.generatorEmpty, generatorCount: p.generatorCount },
          assumptions: ["'Empty' is Generator.IsEmpty as reported by OniMcp; some generators report empty when idle by design."],
        }),
      };
    });

/* ----------------------------------------------------- FUEL / WATER STOCK */

function stockRule(rule: string, field: HistoryField, key: "coal" | "petroleum" | "naturalGas" | "water", label: string): Rule {
  return (ctx) =>
    ctx.snap.worlds
      .filter((w) => w.settled && fresh(w, "inventory", ctx))
      .map((w) => {
        const s = scope(rule, w);
        const cur = w.resources[key].total;
        const t = ctx.trend(w.id, field);
        if (cur === null || !t) return { scope: s, candidate: null };
        const runway = runwayFromTrend(cur, t);
        const isWater = key === "water";
        const limit = isWater ? ctx.th.waterRunwayWarningCycles : ctx.th.fuelRunwayWarningCycles;
        const belowMin = isWater && w.population > 0 && cur < ctx.th.waterMinimumKg;
        if ((runway === null || runway > limit) && !belowMin) return { scope: s, candidate: null };
        if (cur <= 0 && !belowMin) return { scope: s, candidate: null };
        return {
          scope: s,
          candidate: cand(rule, w, "WARNING", {
            title: runway !== null && runway <= limit ? `${label} reserves declining rapidly` : `${label} below configured minimum`,
            what:
              `${label}: ${kg(cur)}` +
              (runway !== null ? `, falling ~${kg(-(t.slopePerCycle ?? 0))} per cycle (~${fmt(runway)} cycles left).` : ` (minimum ${kg(ctx.th.waterMinimumKg)}).`),
            why: isWater
              ? "Water feeds oxygen production, farms and showers; shortages cascade into oxygen and food."
              : `${label} fuels power generation; running dry causes blackouts.`,
            urgency: runway !== null ? `Projected exhaustion in ~${fmt(runway)} cycles (${confidenceFrom(t)} confidence).` : "Not yet urgent.",
            actions: isWater
              ? ["Locate a renewable water source (geyser, polluted water purification).", "Reduce waste (showers, wet farms)."]
              : [`Secure more ${label.toLowerCase()} supply or switch generators to another fuel.`, "Reduce non-essential power draw."],
            evidence: { currentKg: Math.round(cur), slopeKgPerCycle: Math.round(t.slopePerCycle ?? 0), samples: t.samples },
            assumptions: [
              "Stock = stored items (incl. tanks) + free cells on revealed map. Unrevealed areas are not counted.",
              t.reason,
            ],
          }),
        };
      });
}

export const coalRule = stockRule("coal-runway", "coal", "coal", "Coal");
export const petroleumRule = stockRule("petroleum-runway", "petroleum", "petroleum", "Petroleum");
export const naturalGasRule = stockRule("gas-runway", "gas", "naturalGas", "Natural gas");
export const waterRule = stockRule("water-runway", "water", "water", "Water");

/* ----------------------------------------------------------- TEMPERATURE */

export const temperatureRule: Rule = (ctx) =>
  ctx.snap.worlds
    .filter((w) => w.settled && fresh(w, "thermal", ctx) && w.thermal)
    .map((w) => {
      const s = scope("temperature", w);
      const t = w.thermal!;
      const sev: Severity | null = t.avgC >= ctx.th.temperatureCriticalC ? "CRITICAL" : t.avgC >= ctx.th.temperatureWarningC ? "WARNING" : null;
      if (!sev) return { scope: s, candidate: null };
      return {
        scope: s,
        candidate: cand("temperature", w, sev, {
          title: "Temperature approaching machinery limits",
          what: `Average revealed-cell temperature is ${fmt(t.avgC)} °C (max ${fmt(t.maxC)} °C, ${t.hotCells.toLocaleString("en-US")} cells over 70 °C).`,
          why: "Many buildings overheat around 75 °C (lower for some materials) and crops stop growing well before that.",
          urgency: sev === "CRITICAL" ? "Immediate." : "Plan cooling.",
          actions: ["Build or extend cooling (Aquatuner + Steam Turbine, Ice-E fans, wheezeworts).", "Insulate hot biomes from the base."],
          evidence: { avgC: t.avgC, maxC: t.maxC, hotCells: t.hotCells },
          assumptions: ["Average over all revealed cells of the asteroid, not just the base; OniMcp does not report building temperatures in this summary."],
        }),
      };
    });

/* --------------------------------------------------------- INFORMATIONAL */

export const infoEventsRule: Rule = (ctx) => {
  if (!ctx.prev || ctx.prev.saveName !== ctx.snap.saveName) return [];
  const out: RuleResult[] = [];
  const prevById = new Map(ctx.prev.worlds.map((w) => [w.id, w]));
  for (const w of ctx.snap.worlds) {
    const pw = prevById.get(w.id);
    if (!pw) {
      out.push({
        scope: `world-discovered:${w.id}`,
        candidate: {
          ...cand("world-discovered", w, "INFO", {
            title: `New ${w.kind === "rocket" ? "rocket interior" : "asteroid"} detected`,
            what: `${w.name} appeared in the world list.`,
            why: "The dashboard now monitors it automatically.",
            urgency: "None.",
            actions: [],
            evidence: { worldId: w.id },
          }),
          id: `world-discovered:${w.id}:${ctx.now}`,
          oneShot: true,
        },
      });
      continue;
    }
    if (!pw.settled && w.settled && w.population > 0) {
      out.push({
        scope: `world-settled:${w.id}`,
        candidate: {
          ...cand("world-settled", w, "INFO", {
            title: "Asteroid settled",
            what: `${w.name} now has ${w.population} duplicant(s).`,
            why: "It is now included in colony-wide monitoring.",
            urgency: "None.",
            actions: [],
            evidence: { population: w.population },
          }),
          id: `world-settled:${w.id}:${ctx.now}`,
          oneShot: true,
        },
      });
    }
    if (pw.power && w.power && w.power.generatorOperational > pw.power.generatorOperational) {
      const n = w.power.generatorOperational - pw.power.generatorOperational;
      out.push({
        scope: `generator-online:${w.id}`,
        candidate: {
          ...cand("generator-online", w, "INFO", {
            title: "Generator operational",
            what: `${n} more generator(s) became operational on ${w.name} (${w.power.generatorOperational}/${w.power.generatorCount}).`,
            why: "Increases available generation.",
            urgency: "None.",
            actions: [],
            evidence: { operational: w.power.generatorOperational },
          }),
          id: `generator-online:${w.id}:${ctx.now}`,
          oneShot: true,
        },
      });
    }
  }
  const pc = ctx.prev.time?.cycle, c = ctx.snap.time?.cycle;
  if (pc !== undefined && c !== undefined && Math.floor(c / 100) > Math.floor(pc / 100)) {
    out.push({
      scope: "cycle-milestone:colony",
      candidate: {
        ...cand("cycle-milestone", null, "INFO", {
          title: `Cycle ${Math.floor(c / 100) * 100} reached`,
          what: `The colony has survived ${Math.floor(c / 100) * 100} cycles.`,
          why: "Milestone.",
          urgency: "None.",
          actions: [],
          evidence: { cycle: c },
        }),
        id: `cycle-milestone:${c}`,
        oneShot: true,
      },
    });
  }
  const pp = ctx.prev.totalPopulation, p = ctx.snap.totalPopulation;
  if (pp !== null && p !== null && p > pp) {
    out.push({
      scope: "population:colony",
      candidate: {
        ...cand("population", null, "INFO", {
          title: "Population increased",
          what: `Population grew from ${pp} to ${p}.`,
          why: "More duplicants increase food and oxygen demand; projections will adjust.",
          urgency: "None.",
          actions: [],
          evidence: { from: pp, to: p },
        }),
        id: `population:${ctx.now}`,
        oneShot: true,
      },
    });
  }
  return out;
};

export const ALL_RULES: Rule[] = [
  foodRunwayRule,
  foodTrendRule,
  starvationRule,
  incapacitatedRule,
  suffocationRule,
  stressRule,
  workforceRule,
  oxygenRule,
  batteryRule,
  powerDeficitRule,
  generatorFuelRule,
  coalRule,
  petroleumRule,
  naturalGasRule,
  waterRule,
  temperatureRule,
  infoEventsRule,
];
