import Anthropic from "@anthropic-ai/sdk";
import type { DashboardState } from "../model/types";

export const ADVISOR_MODEL = process.env.ADVISOR_MODEL || "claude-opus-5-5";
const COOLDOWN_MS = 90_000;

/**
 * The advisor is strictly an analyst. It has no tools, so it physically cannot act on the
 * game; the prompt also forbids it from implying it did.
 */
export const ADVISOR_SYSTEM = `You are the Colony Advisor for "Interplanetary Command", a read-only monitoring dashboard for an Oxygen Not Included: Spaced Out! colony spread across several asteroids.

You receive a structured JSON snapshot produced by the dashboard. It has three kinds of content:
- "observed": values read directly from the game through the OniMcp mod (verified).
- "derived": trends, runways and projections computed by the dashboard, each with its assumptions and confidence.
- "alerts": the dashboard's rule-based alerts.

Write a concise operational briefing for the player, in Markdown, with these sections:
1. **Colony status** - one or two sentences: healthy, degrading, or in danger, and why.
2. **Priorities** - a numbered list, most urgent first. For each item name the asteroid, state the problem, explain the cascading-failure risk (e.g. power loss -> oxygen loss -> suffocation), and give 2-4 concrete actions the player should consider.
3. **Emerging risks** - problems that are not yet alerts but are trending the wrong way.
4. **Asteroid comparison** - a short comparison of how the settled asteroids are doing.
5. **Data gaps** - anything you could not assess because a metric is N/A, stale, or has insufficient history.

Rules:
- Clearly separate verified observations from inferences. Tag statements as [observed], [derived] or [assumption].
- Never invent numbers. Only use values present in the snapshot. If something is missing, say so.
- Never present a projection as certain; give its confidence and the assumption behind it.
- You cannot take any action in the game and nothing has been changed. Phrase everything as recommendations for the player ("consider...", "check..."). Never say or imply that you performed, scheduled, or confirmed an action.
- Use ONI terminology accurately; if you are unsure about a game mechanic, say so rather than guessing.
- Keep it under ~450 words. The player will read this at a glance on a second monitor.`;

const r = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(d)));

/** Compact, structured snapshot for the model. No raw MCP payloads. */
export function buildAdvisorPayload(s: DashboardState) {
  const snap = s.snapshot;
  return {
    generatedAt: new Date().toISOString(),
    dataSource: s.connection.simulated ? "SIMULATOR (demo data, not a real game)" : "OniMcp live game connection",
    connection: { state: s.connection.state, stale: s.stale, staleReason: s.staleReason, server: `${s.connection.serverName ?? "?"} ${s.connection.serverVersion ?? ""}` },
    colony: snap
      ? {
          save: snap.saveName,
          cycle: snap.time?.cycle ?? null,
          paused: snap.time?.paused ?? null,
          totalDuplicants: snap.totalPopulation,
          research: snap.research,
        }
      : null,
    asteroids: (snap?.worlds ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      kind: w.kind,
      settled: w.settled,
      observed: {
        population: w.population,
        duplicants: w.dupes.map((d) => ({ name: d.name, hpPct: r(d.healthPct, 0), stressPct: r(d.stressPct, 0), kcal: r(d.caloriesKcal, 0), breathPct: r(d.breathPct, 0), risk: d.risk, idle: d.idle })),
        foodKcal: r(w.foodKcal, 0),
        oxygenFreeKg: r(w.atmosphere?.oxygenKg, 0),
        co2FreeKg: r(w.atmosphere?.co2Kg, 0),
        power: w.power
          ? {
              generatorsOperational: `${w.power.generatorOperational}/${w.power.generatorCount}`,
              generatorsEmpty: w.power.generatorEmpty,
              ratedGenerationW: r(w.power.generatorRatedW, 0),
              liveConsumptionW: r(w.power.consumerUsedW, 0),
              peakDemandW: r(w.power.consumerNeededW, 0),
              consumersPowered: `${w.power.consumerPowered}/${w.power.consumerCount}`,
              batteryPct: r(w.power.batteryPct),
              batteryStoredKJ: r(w.power.batteryStoredJ / 1000, 0),
            }
          : null,
        resourcesKg: Object.fromEntries(Object.entries(w.resources).map(([k, v]) => [k, r(v.total, 0)])),
        temperatureC: w.thermal ? { avg: w.thermal.avgC, max: w.thermal.maxC } : null,
        dataAgeSeconds: Object.fromEntries(Object.entries(w.meta).map(([g, m]) => [g, m.fetchedAt ? Math.round((Date.now() - m.fetchedAt) / 1000) : null])),
      },
      derived: {
        trends: s.trends
          .filter((t) => t.worldId === w.id && t.reliable)
          .map((t) => ({ field: t.field, direction: t.direction, perCycle: r(t.slopePerCycle, 0), r2: r(t.r2, 2), spanCycles: r(t.spanCycles, 2) })),
        projections: s.projections
          .filter((p) => p.worldId === w.id)
          .map((p) => ({ label: p.label, cycles: r(p.cycles), confidence: p.confidence, method: p.method, assumptions: p.assumptions })),
      },
    })),
    alerts: s.alerts
      .filter((a) => a.status === "active")
      .map((a) => ({ severity: a.severity, asteroid: a.worldName, title: a.title, what: a.what, evidence: a.evidence, assumptions: a.assumptions ?? [] })),
    unavailableMetrics: s.capabilities.filter((c) => c.status !== "available").map((c) => `${c.feature}: ${c.note}`),
    thresholds: { kcalPerDupePerCycle: s.thresholds.kcalPerDupePerCycle },
  };
}

export interface AdvisorReport {
  createdAt: number;
  model: string;
  servedBy: string | null;
  markdown: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  snapshotCycle: number | null;
  simulated: boolean;
}

export type AdvisorStatus =
  | { available: false; reason: string; last: AdvisorReport | null }
  | { available: true; model: string; running: boolean; cooldownRemainingS: number; last: AdvisorReport | null; lastError: string | null };

export class Advisor {
  private client: Anthropic | null = null;
  private last: AdvisorReport | null = null;
  private lastError: string | null = null;
  private running: Promise<AdvisorReport> | null = null;

  private hasCredentials(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  }

  status(): AdvisorStatus {
    if (!this.hasCredentials()) {
      return { available: false, reason: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile via ANTHROPIC_PROFILE) to enable the Claude advisor.", last: this.last };
    }
    const cd = this.last ? Math.max(0, Math.ceil((this.last.createdAt + COOLDOWN_MS - Date.now()) / 1000)) : 0;
    return { available: true, model: ADVISOR_MODEL, running: !!this.running, cooldownRemainingS: cd, last: this.last, lastError: this.lastError };
  }

  async run(state: DashboardState): Promise<AdvisorReport> {
    if (this.running) return this.running;
    if (this.last && Date.now() - this.last.createdAt < COOLDOWN_MS) return this.last;
    if (!state.snapshot) throw new Error("No colony data yet; the advisor needs at least one successful snapshot.");
    this.running = this.call(state).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async call(state: DashboardState): Promise<AdvisorReport> {
    this.client ??= new Anthropic();
    const payload = buildAdvisorPayload(state);
    try {
      const stream = this.client.beta.messages.stream({
        model: ADVISOR_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        // Server-side refusal fallback: on a policy decline the API re-runs on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: ADVISOR_SYSTEM,
        messages: [{ role: "user", content: `Colony snapshot (JSON):\n\n${JSON.stringify(payload)}` }],
      });
      const msg = await stream.finalMessage();
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      const refused = msg.stop_reason === "refusal";
      const report: AdvisorReport = {
        createdAt: Date.now(),
        model: ADVISOR_MODEL,
        servedBy: msg.model ?? null,
        markdown: refused ? "_The advisor declined to produce a briefing for this snapshot._" : text || "_Empty response._",
        stopReason: msg.stop_reason ?? null,
        inputTokens: msg.usage?.input_tokens ?? null,
        outputTokens: msg.usage?.output_tokens ?? null,
        snapshotCycle: state.snapshot?.time?.cycle ?? null,
        simulated: state.connection.simulated,
      };
      this.last = report;
      this.lastError = null;
      return report;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) this.lastError = "Anthropic API rejected the credentials.";
      else if (e instanceof Anthropic.RateLimitError) this.lastError = "Rate limited by the Anthropic API — try again shortly.";
      else if (e instanceof Anthropic.APIConnectionError) this.lastError = "Cannot reach the Anthropic API.";
      else if (e instanceof Anthropic.APIError) this.lastError = `Anthropic API error ${e.status ?? ""}: ${e.message}`;
      else this.lastError = (e as Error).message;
      throw new Error(this.lastError);
    }
  }
}
