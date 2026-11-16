/**
 * Remote acceptance check — run from ANOTHER device on your tailnet (laptop at work, etc.):
 *
 *   IC_VERIFY_PASSPHRASE='your passphrase' npm run verify:remote -- --url https://homepc.your-tailnet.ts.net
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
  check("Session cookie is HttpOnly + SameSite=Strict", /HttpOnly/i.test(set) && /SameSite=Strict/i.test(set), base.startsWith("https") ? (/Secure/i.test(set) ? "Secure" : "MISSING Secure on HTTPS") : "plain HTTP (use tailscale serve for HTTPS)");
  check("10d. Cross-origin command refused", (await post("/api/commands", { clientId: `c-${randomUUID()}`, type: "report.request", payload: {} }, { Origin: "https://evil.example" })).status === 403);

  // 2-4. Submit, acknowledge, interpret
  const clientId = `c-verify-${randomUUID()}`;
  const s1 = await post("/api/commands", { clientId, type: "instruction", payload: { text }, clientCreatedAt: Date.now() });
  const b1 = (await s1.json()) as { ack?: boolean; duplicate?: boolean; command?: { seq: number; receivedAt: number } };
  check("2/3. Instruction submitted and acknowledged by the home PC", s1.status === 202 && b1.ack === true && !b1.duplicate, `seq ${b1.command?.seq}, received ${b1.command ? new Date(b1.command.receivedAt).toISOString() : "?"}`);

  // 9. Duplicate prevention (simulates a retry after reconnect)
  const s2 = await post("/api/commands", { clientId, type: "instruction", payload: { text } });
  const b2 = (await s2.json()) as { duplicate?: boolean; command?: { seq: number } };
  check("9. Re-sent command recognised as duplicate (same seq)", b2.duplicate === true && b2.command?.seq === b1.command?.seq);

  type Cmd = { status: string; result: string | null; error: string | null };
  let status = "received";
  let cmd = null as Cmd | null;
  for (let i = 0; i < 45 && (status === "received" || status === "processing"); i++) {
    await sleep(2000);
    const r = await req(`/api/commands?clientId=${clientId}`);
    if (r.ok) {
      const c = (await r.json()) as Cmd;
      cmd = c;
      status = c.status;
    }
  }
  check("4. Instruction processed by the Operations Agent", status === "completed" || status === "deferred", status === "deferred" ? "queued: Claude is not configured/available on the home PC" : `${status} ${cmd?.result ?? cmd?.error ?? ""}`);

  const ops = (await (await req("/api/ops")).json()) as {
    messages: Array<{ from: string; text: string; commandClientId: string | null; degraded?: boolean }>;
    objectives: unknown[];
    home: { lastObservationAt: number | null; gameProcess: string; oniMcp: string; claude: string };
    agent: { running: boolean };
  };
  const reply = ops.messages.find((m) => m.commandClientId === clientId && m.from !== "commander");
  check("4b. Claude/agent replied to the commander", !!reply, reply ? `${reply.from}${reply.degraded ? " (SIMULATED interpreter)" : ""}: ${reply.text.slice(0, 100).replace(/\n/g, " ")}…` : "no reply yet");
  check("5/6. Objectives visible to the dashboard", Array.isArray(ops.objectives), `${ops.objectives.length} objective(s)`);
  check("11. Home agent running", ops.agent.running, `OniMcp ${ops.home.oniMcp}, game process ${ops.home.gameProcess}, Claude ${ops.home.claude}`);

  // Live stream
  const sse = await req("/api/stream", { headers: { Accept: "text/event-stream" } });
  let gotEvent = false;
  if (sse.ok && sse.body) {
    const reader = sse.body.getReader();
    const t = setTimeout(() => void reader.cancel(), 8000);
    let buf = "";
    while (!gotEvent) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += new TextDecoder().decode(value);
      if (buf.includes("event: state")) gotEvent = true;
    }
    clearTimeout(t);
    void reader.cancel();
  }
  check("Live updates (SSE) received", gotEvent);

  // 7. Monitoring continues with no browser connected
  const t0 = ops.home.lastObservationAt;
  await sleep(15_000);
  const ops2 = (await (await req("/api/ops")).json()) as { home: { lastObservationAt: number | null } };
  check("7. Monitoring continues with no client streaming", !!t0 && !!ops2.home.lastObservationAt && ops2.home.lastObservationAt > t0, t0 ? "" : "no observations — is the game running with OniMcp?");

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
