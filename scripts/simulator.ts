/**
 * Start the OniMcp protocol simulator (SIMULATED DATA) on port 8789.
 *   npm run sim            # demo scenario with emerging problems
 *   SIM_SCENARIO=healthy npm run sim
 *   SIM_ACCEL=30 npm run sim   # game seconds per wall second
 * Press "p" + Enter to toggle pause.
 */
import { OniSimulator } from "../src/lib/sim/simulator";

const port = Number(process.env.SIM_PORT ?? 8789);
const sim = new OniSimulator({
  accel: Number(process.env.SIM_ACCEL ?? 6),
  scenario: process.env.SIM_SCENARIO === "healthy" ? "healthy" : "demo",
});
sim.listen(port).then(() => {
  console.log(`[simulator] SIMULATED OniMcp listening on http://127.0.0.1:${port}/mcp/  (accel ${sim.accel}x)`);
  console.log(`[simulator] type "p" + Enter to toggle pause`);
});
process.stdin.on("data", (d) => {
  if (d.toString().trim() === "p") {
    sim.advance();
    sim.paused = !sim.paused;
    console.log(`[simulator] ${sim.paused ? "PAUSED" : "RUNNING"} at cycle ${sim.cycle}`);
  }
});
