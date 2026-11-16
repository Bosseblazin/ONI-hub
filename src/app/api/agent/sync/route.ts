import { gunzipSync } from "node:zlib";
import { backend, cloudStore, colonyKey, isCloud } from "@/lib/server/backend";
import { RELAY_PROTOCOL, verifyRequest, type SyncRequest, type SyncResponse } from "@/lib/relay/protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 20;

const MAX_BODY = 4_000_000;

/**
 * The home agent's only inbound door into the cloud — called BY the home PC (outbound from its side).
 * HMAC-signed; pushes state/history/command statuses and receives pending commands in the response.
 */
export async function POST(req: Request) {
  if (!isCloud()) return Response.json({ error: "relay endpoints are only active in cloud mode" }, { status: 404 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
  const v = verifyRequest(process.env.IC_AGENT_SECRET, req.headers, "POST", "/api/agent/sync", raw);
  if (!v.ok) {
    await backend().auditEvent(req.headers.get("x-ic-agent") ?? "unknown", "relay.rejected", { reason: v.reason }).catch(() => {});
    return Response.json({ error: v.reason }, { status: 401 });
  }
  let body: SyncRequest;
  try {
    const json = req.headers.get("x-ic-body-encoding") === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    body = JSON.parse(json) as SyncRequest;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (body.protocol !== RELAY_PROTOCOL) return Response.json({ error: `protocol ${body.protocol} not supported (expected ${RELAY_PROTOCOL}); update the home agent or the deployment` }, { status: 426 });

  // Demo data must never masquerade as the production colony.
  // Checked on every sync (heartbeats too), so a simulator-backed agent never even appears "online" here.
  if ((body.simulated === true || body.snapshot?.dashboard.connection.simulated) && process.env.IC_ALLOW_SIMULATED !== "1") {
    return Response.json({ error: "This deployment refuses SIMULATED data. Use a separate demo deployment (IC_ALLOW_SIMULATED=1) or local demo mode." }, { status: 409 });
  }

  const store = cloudStore();
  const now = Date.now();
  await store.recordAgentSync(String(body.agentId).slice(0, 80), String(body.agentVersion).slice(0, 40), now);
  if (body.snapshot) await store.saveSnapshot(body.snapshot, now);
  await store.applyReports(Array.isArray(body.receivedClientIds) ? body.receivedClientIds.slice(0, 500) : [], Array.isArray(body.reports) ? body.reports : [], now);
  const colony = colonyKey(body.snapshot?.dashboard.snapshot?.saveName ?? (await store.getSnapshot())?.dashboard.snapshot?.saveName ?? null);
  const historyCursor = body.history?.length ? await store.appendHistory(colony, body.history.slice(0, 5000)) : await store.historyCursor(colony);
  const commands = await store.takeForDelivery(now);
  const res: SyncResponse = { ok: true, serverTime: now, commands, historyCursor, viewerActive: await store.viewerActive(now), wantSnapshot: !(await store.getSnapshot()) };
  return Response.json(res, { headers: { "Cache-Control": "no-store" } });
}
