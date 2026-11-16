import path from "node:path";
import { Advisor } from "../advisor/advisor";
import { Collector } from "../collector/collector";

declare global {
  // eslint-disable-next-line no-var
  var __icCollector: Collector | undefined;
  // eslint-disable-next-line no-var
  var __icAdvisor: Advisor | undefined;
}

/** One collector per Node process (survives Next.js dev hot reloads via globalThis). */
export function getCollector(): Collector {
  if (!globalThis.__icCollector) {
    const c = new Collector({
      url: process.env.ONI_MCP_URL || "http://127.0.0.1:8788/mcp/",
      token: process.env.ONI_MCP_TOKEN || undefined,
      dataDir: process.env.IC_DATA_DIR || path.join(process.cwd(), "data"),
      historyIntervalMs: Number(process.env.IC_HISTORY_INTERVAL_MS) || 30_000,
    });
    c.start();
    globalThis.__icCollector = c;
  }
  return globalThis.__icCollector;
}

export function getAdvisor(): Advisor {
  globalThis.__icAdvisor ??= new Advisor();
  return globalThis.__icAdvisor;
}
