import path from "node:path";
import { Advisor } from "../advisor/advisor";
import { AuthService } from "../auth/auth";
import { Collector } from "../collector/collector";
import { OperationsAgent } from "../ops/agent";
import { ScreenshotService } from "../ops/home";
import { ClaudeGateway } from "../ops/llm";
import { Heartbeat, Notifier } from "../ops/notify";
import { SimulatedLlm } from "../ops/simulated-llm";
import { OpsStore } from "../ops/store";

interface HomeServices {
  collector: Collector;
  advisor: Advisor;
  auth: AuthService;
  store: OpsStore;
  agent: OperationsAgent;
  screenshots: ScreenshotService;
  dataDir: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __icHome: HomeServices | undefined;
}

export const dataDir = () => process.env.IC_DATA_DIR || path.join(process.cwd(), "data");

/**
 * The home-PC service graph, one per Node process (survives Next.js dev hot reloads via globalThis).
 * Started at server boot by src/instrumentation.ts, so monitoring and the Operations Agent run whether
 * or not any browser is connected.
 */
export function home(): HomeServices {
  if (!globalThis.__icHome) {
    const dir = dataDir();
    const collector = new Collector({
      url: process.env.ONI_MCP_URL || "http://127.0.0.1:8788/mcp/",
      token: process.env.ONI_MCP_TOKEN || undefined,
      dataDir: dir,
      historyIntervalMs: Number(process.env.IC_HISTORY_INTERVAL_MS) || 30_000,
    });
    const store = new OpsStore(dir);
    const auth = new AuthService(dir);
    const screenshots = new ScreenshotService(path.join(dir, "screenshots"));
    const agent = new OperationsAgent({
      collector,
      store,
      llm: new ClaudeGateway(() => store.state.agentSettings.maxClaudeCallsPerHour),
      simulatedLlm: new SimulatedLlm(),
      notifier: new Notifier(store),
      heartbeat: new Heartbeat(),
      screenshots,
      authInfo: () => ({ passphraseSet: auth.passphraseSet(), sessions: auth.count() }),
    });
    collector.start();
    agent.start();
    globalThis.__icHome = { collector, advisor: new Advisor(), auth, store, agent, screenshots, dataDir: dir };
  }
  return globalThis.__icHome;
}

export const getCollector = () => home().collector;
export const getAdvisor = () => home().advisor;
