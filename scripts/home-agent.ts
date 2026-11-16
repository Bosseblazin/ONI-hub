/**
 * Interplanetary Command — HOME AGENT (cloud deployments).
 *
 * Runs on the PC that plays Oxygen Not Included. Starts the read-only OniMcp collector, the Colony
 * Operations Agent (Claude) and the outbound relay link to your Vercel deployment. Keep it running
 * (see docs/DEPLOYMENT.md for Windows auto-start). Do not also run `npm start` against the same data dir.
 *
 *   npm run agent
 *
 * Reads .env.local / .env: IC_RELAY_URL, IC_AGENT_SECRET, ONI_MCP_URL, ANTHROPIC_API_KEY, NTFY_URL, ...
 */
import os from "node:os";

for (const f of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(f);
  } catch {
    /* file absent */
  }
}

async function main() {
  const url = process.env.IC_RELAY_URL;
  const secret = process.env.IC_AGENT_SECRET;
  if (!url || !secret || secret.length < 32) {
    console.error("IC_RELAY_URL and IC_AGENT_SECRET (>= 32 chars) are required. Run `npm run cloud:secrets` and see docs/DEPLOYMENT.md.");
    process.exit(2);
  }
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
    console.error("IC_RELAY_URL must be https:// (plain http is only allowed for localhost testing).");
    process.exit(2);
  }
  const { home } = await import("../src/lib/server/singleton");
  const { RelayClient } = await import("../src/lib/relay/client");
  const h = home();
  const agentId = process.env.IC_AGENT_ID || os.hostname();
  const relay = new RelayClient({ url, secret, agentId, agentVersion: "1.2.0", collector: h.collector, agent: h.agent, store: h.store, screenshots: h.screenshots });
  h.agent.setRelayInfo(() => relay.status());
  relay.start();
  console.log(`[home-agent] monitoring ${process.env.ONI_MCP_URL || "http://127.0.0.1:8788/mcp/"} → relay ${url} as "${agentId}"`);
  console.log(`[home-agent] Claude: ${process.env.ANTHROPIC_API_KEY ? "configured" : "NOT configured (instructions will queue)"} · data: ${h.dataDir}`);

  const report = () => {
    const d = h.collector.getState();
    const r = relay.status();
    console.log(
      `[home-agent] ${new Date().toLocaleTimeString()} game=${d.connection.state}${d.snapshot?.time ? ` cycle=${d.snapshot.time.cycle}` : ""} relay=${r.connected ? "ok" : `DOWN (${r.lastError ?? "connecting"})`} viewer=${r.viewerActive ? "yes" : "no"} queue=${h.store.pendingCommands().length}`,
    );
  };
  setTimeout(report, 5000);
  setInterval(report, 60_000);

  const shutdown = () => {
    console.log("[home-agent] shutting down");
    relay.stop();
    h.agent.stop();
    void h.collector.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(`[home-agent] fatal: ${(e as Error).message}`);
  process.exit(1);
});
