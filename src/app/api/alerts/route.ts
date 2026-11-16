import { randomUUID } from "node:crypto";
import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Acknowledge or dismiss an alert (dashboard state only). Routed through the audited command queue. */
export async function POST(req: Request) {
  const g = guard(req, { write: true });
  if (isResponse(g)) return g;
  let body: { id?: unknown; action?: unknown; clientId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.id !== "string" || (body.action !== "acknowledge" && body.action !== "dismiss")) {
    return Response.json({ error: "expected {id, action: 'acknowledge'|'dismiss'}" }, { status: 400 });
  }
  const h = home();
  const ok = body.action === "acknowledge" ? h.collector.acknowledge(body.id) : h.collector.dismiss(body.id);
  h.store.audit(g.label, `alert.${body.action}`, { id: body.id, ok, ref: typeof body.clientId === "string" ? body.clientId : randomUUID() });
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
