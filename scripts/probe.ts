/**
 * Verify the live OniMcp surface against what Interplanetary Command expects.
 * Read-only: uses initialize, resources/list, resources/templates/list and resources/read only.
 *
 *   npm run probe                       # default http://127.0.0.1:8788/mcp/
 *   ONI_MCP_URL=http://host:8788/mcp/ ONI_MCP_TOKEN=... npm run probe
 */
import { OniMcpClient } from "../src/lib/mcp/client";
import { withQuery } from "../src/lib/mcp/readonly";
import * as S from "../src/lib/mcp/schemas";
import type { z } from "zod";

const url = process.env.ONI_MCP_URL ?? "http://127.0.0.1:8788/mcp/";
const client = new OniMcpClient({ url, token: process.env.ONI_MCP_TOKEN || undefined, timeoutMs: 20_000 });

async function check(label: string, uri: string, schema: z.ZodType<unknown>): Promise<unknown> {
  try {
    const raw = await client.readJson(uri);
    const r = schema.safeParse(raw);
    console.log(`${r.success ? "  OK  " : " SHAPE"} ${label.padEnd(34)} ${uri}${r.success ? "" : "  → " + S.formatZodError(r.error)}`);
    return r.success ? r.data : raw;
  } catch (e) {
    console.log(`  FAIL ${label.padEnd(34)} ${uri}  → ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  console.log(`Probing ${url}`);
  const info = await client.connect();
  console.log(`Server: ${info.name} ${info.version}, protocol ${info.protocolVersion}\n`);
  const res = await client.listResources();
  const tpl = await client.listTemplates();
  console.log(`resources/list: ${res.length} resources, ${tpl.length} templates`);
  const want = ["oni://colony/status", "oni://world/list", "oni://dupes/vitals", "oni://power/summary", "oni://food/summary", "oni://resources/inventory",
    "oni://thermal/summary", "oni://atmosphere/breathability", "oni://atmosphere/summary", "oni://fluid/liquid/summary", "oni://dupes/status-check", "oni://research/progress"];
  const listed = new Set(res.map((r) => r.uri));
  for (const u of want) if (!listed.has(u)) console.log(`  note: ${u} not in resources/list (may still be readable)`);
  console.log("");

  const status = (await check("colony status", "oni://colony/status", S.ColonyStatusSchema)) as S.ColonyStatus | null;
  const worlds = ((await check("world list", "oni://world/list", S.WorldListSchema)) as S.WorldList | null) ?? [];
  await check("dupe vitals", "oni://dupes/vitals", S.DupesVitalsSchema);
  await check("dupe status-check", withQuery("oni://dupes/status-check", { radius: 2, includeReachableSamples: false, limit: 100 }), S.DupesStatusCheckSchema);
  await check("research", "oni://research/progress", S.ResearchProgressSchema);
  for (const w of worlds) {
    console.log(`\n  World ${w.id}: ${w.name} (${w.asteroidType ?? "?"})${w.isActive ? " [active]" : ""}`);
    await check("  power", withQuery("oni://power/summary", { worldId: w.id }), S.PowerSummarySchema);
    await check("  food", withQuery("oni://food/summary", { worldId: w.id }), S.FoodSummarySchema);
    await check("  inventory", withQuery("oni://resources/inventory", { worldId: w.id, includeStored: true, limit: 500 }), S.InventorySchema);
    await check("  thermal", withQuery("oni://thermal/summary", { worldId: w.id }), S.ThermalSummarySchema);
    await check("  breathability", withQuery("oni://atmosphere/breathability", { worldId: w.id }), S.BreathabilitySchema);
    await check("  atmosphere", withQuery("oni://atmosphere/summary", { worldId: w.id }), S.AtmosphereSummarySchema);
    await check("  liquids", withQuery("oni://fluid/liquid/summary", { worldId: w.id }), S.LiquidSummarySchema);
  }
  if (status) console.log(`\nCycle ${status.cycle}, ${status.duplicantCount} duplicants, ${status.worldCount} worlds, paused=${status.isPaused}, save="${status.saveName ?? "?"}"`);
}

main().catch((e) => {
  console.error(`Probe failed: ${(e as Error).message}`);
  process.exit(1);
});
