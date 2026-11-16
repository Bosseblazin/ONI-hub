import { randomUUID } from "node:crypto";
import { backend } from "@/lib/server/backend";
import { guard, isResponse } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Acknowledge/dismiss an alert — routed through the command queue so it reaches the home agent. */
export async function POST(req: Request) {
  const g = await guard(req, { write: true });
  if (isResponse(g)) return g;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown; clientId?: unknown };
  if (typeof body.id !== "string" || (body.action !== "acknowledge" && body.action !== "dismiss")) {
    return Response.json({ error: "expected {id, action: 'acknowledge'|'dismiss'}" }, { status: 400 });
  }
  const clientId = typeof body.clientId === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientId) ? body.clientId : `c-alert-${randomUUID()}`;
  const r = await backend().submit({ clientId, type: body.action === "acknowledge" ? "alert.ack" : "alert.dismiss", payload: { id: body.id }, issuedBy: g.label, clientCreatedAt: Date.now() });
  return Response.json({ ok: true, queued: true, clientId, status: r.status }, { status: 202 });
}
