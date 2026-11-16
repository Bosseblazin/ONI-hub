/**
 * Remote acceptance check — run from ANOTHER device against the deployment (Vercel URL) or a local server:
 *
 *   IC_VERIFY_PASSPHRASE='your passphrase' npm run verify:remote -- --url https://<your-project>.vercel.app
 *
 * Sends one harmless information request ("verification ping") unless --instruction "..." is given.
 * Uses only the public HTTP API, exactly like the phone does.
 */
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (arg("--url") ?? process.env.IC_VERIFY_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const pass = process.env.IC_VERIFY_PASSPHRASE ?? "";
const text = arg("--instruction") ?? "Verification ping from a remote device: briefly, how is the colony doing? Do not change any objectives.";
const origin = new URL(base).origin;

let cookie = "";
let failures = 0;
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const req = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(20_000) });
const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  req(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...extra }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Interplanetary Command — remote acceptance check against ${base}\n`);
  if (!pass) {
    console.error("Set IC_VERIFY_PASSPHRASE to the commander passphrase.");
    process.exit(2);
  }

  // 1. Reachability
  let h: Response;
  try {
    h = await req("/api/health");
  } catch (e) {
    check("1. Dashboard reachable from this device", false, (e as Error).message);
    return finish();
  }
  check("1. Dashboard reachable from this device", h.ok, `HTTP ${h.status}`);

  // 10. Unauthorised access is refused
  check("10a. State refused without a session", (await req("/api/state")).status === 401);
  check("10b. Commands refused without a session", (await post("/api/commands", { clientId: `c-${randomUUID()}`, type: "instruction", payload: { text: "x" } })).status === 401);
  check("10c. Wrong passphrase refused", (await post("/api/auth/login", { passphrase: "definitely-not-the-passphrase", label: "verify" })).status !== 200);

  // Sign in
  const lr = await post("/api/auth/login", { passphrase: pass, label: "verify-remote script" });
  const set = lr.headers.get("set-cookie") ?? "";
  cookie = set.split(";")[0] ?? "";
  check("Sign in with the commander passphrase", lr.ok && cookie.startsWith("ic_session="), lr.ok ? "" : `HTTP ${lr.status} ${(await lr.text()).slice(0, 120)}`);
  if (!lr.ok) return finish();
  check("Session cookie is HttpOnly + SameSite=Strict", /HttpOnly/i.test(set) && /SameSite=Strict/i.test(set), base.startsWith("https") ? (/Secure/i.test(set) ? "Secure" : "MISSING Secure on HTTPS") : "plain HTTP (local test only)");
  check("10d. Cross-origin command refused", (await post("/api/commands", { clientId: `c-${randomUUID()}`, type: "report.request", payload: {} }, { Origin: "https://evil.example" })).status === 403);

  // Relay / home-agent link
  type Relay = { mode: string; agentOnline: boolean; agentId: string | null; agentLastSeenAt: number | null; queued: number };
  const st0 = (await (await req("/api/state")).json()) as { relay: Relay; dashboard: { connection: { simulated: boolean } } | null };
  const cloud = st0.relay.mode === "cloud";
  console.log(`        mode: ${st0.relay.mode}${cloud ? `, home agent ${st0.relay.agentId ?? "?"}` : ""}${st0.dashboard?.connection.simulated ? " — SIMULATED DATA (demo)" : ""}`);
  check("11a. Home agent online", st0.relay.agentOnline, cloud ? `last sync ${st0.relay.agentLastSeenAt ? Math.round((Date.now() - st0.relay.agentLastSeenAt) / 1000) + " s ago" : "never"}` : "local mode");

  // 2-4. Submit, acknowledge, interpret
  const clientId = `c-verify-${randomUUID()}`;
  const s1 = await post("/api/commands", { clientId, type: "instruction", payload: { text }, clientCreatedAt: Date.now() });
  const b1 = (await s1.json()) as { ack?: boolean; duplicate?: boolean; seq?: number | null; command?: { queuedAt: number } };
  check(`2. Instruction accepted by the ${cloud ? "cloud relay" : "home PC"}`, s1.status === 202 && b1.ack === true && !b1.duplicate, b1.command ? `queued ${new Date(b1.command.queuedAt).toISOString()}` : "");

  // 9. Duplicate prevention (a retry after reconnect)
  const s2 = await post("/api/commands", { clientId, type: "instruction", payload: { text } });
  const b2 = (await s2.json()) as { duplicate?: boolean; command?: { queuedAt: number } };
  check("9. Re-sent command recognised as duplicate", b2.duplicate === true && b2.command?.queuedAt === b1.command?.queuedAt);

  type Cmd = { homeStatus: string | null; deliveredAt: number | null; result: string | null; error: string | null };
  let cmd = null as Cmd | null;
  let receivedAt: number | null = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const r = await req(`/api/commands?clientId=${clientId}`);
    if (!r.ok) continue;
    const c = (await r.json()) as Cmd;
    cmd = c;
    if (c.homeStatus && !receivedAt) receivedAt = Date.now();
    if (c.homeStatus === "completed" || c.homeStatus === "failed" || c.homeStatus === "deferred") break;
  }
  check("3. Home PC confirmed receipt", !!cmd?.homeStatus, cmd?.homeStatus ? `confirmed by the home agent${cloud && cmd.deliveredAt ? ` (delivered ${new Date(cmd.deliveredAt).toISOString()})` : ""}` : "not picked up — is `npm run agent` running?");
  check(
    "4. Instruction processed by the Operations Agent (home-confirmed)",
    cmd?.homeStatus === "completed" || cmd?.homeStatus === "deferred",
    cmd?.homeStatus === "deferred" ? "queued at home: Claude is not configured/available on the home PC" : `${cmd?.homeStatus ?? "none"} ${cmd?.result ?? cmd?.error ?? ""}`,
  );

  // The reply arrives with the next snapshot from the home agent.
  type Ops = {
    messages: Array<{ from: string; text: string; commandClientId: string | null; degraded?: boolean }>;
    objectives: unknown[];
    home: { lastObservationAt: number | null; gameProcess: string; oniMcp: string; claude: string };
    agent: { running: boolean };
  };
  let ops: Ops | null = null;
  let reply: Ops["messages"][number] | undefined;
  for (let i = 0; i < 20 && !reply; i++) {
    const r = await req("/api/ops");
    if (r.ok) {
      ops = (await r.json()) as Ops;
      reply = ops.messages.find((m) => m.commandClientId === clientId && m.from !== "commander");
    }
    if (!reply) await sleep(1500);
  }
  check("4b. Claude/agent replied to the commander", !!reply, reply ? `${reply.from}${reply.degraded ? " (SIMULATED interpreter)" : ""}: ${reply.text.slice(0, 100).replace(/\n/g, " ")}…` : "no reply yet");
  if (!ops) return finish();
  check("5/6. Objectives visible to the dashboard", Array.isArray(ops.objectives), `${ops.objectives.length} objective(s)`);
  check("11b. Operations Agent running", ops.agent.running, `OniMcp ${ops.home.oniMcp}, game process ${ops.home.gameProcess}, Claude ${ops.home.claude}`);

  // 7. Monitoring continues with no browser connected (this script is not a browser; nothing streams)
  const t0 = ops.home.lastObservationAt;
  await sleep(cloud ? 25_000 : 15_000);
  const ops2 = (await (await req("/api/ops")).json()) as Ops;
  check("7. Monitoring continues with no browser open", !!t0 && !!ops2.home.lastObservationAt && ops2.home.lastObservationAt > t0, t0 ? "" : "no observations — is the game running with OniMcp?");

  await post("/api/auth/logout", {});
  return finish();
}

function finish() {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`verify-remote aborted: ${(e as Error).message}`);
  process.exit(1);
});
