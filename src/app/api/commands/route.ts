import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";
import type { CommandType } from "@/lib/ops/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES = new Set<CommandType>([
  "instruction", "mode.set", "objective.update", "objective.create", "recommendation.decide", "proposal.decide",
  "permission.set", "notifications.update", "settings.update", "investigation.request", "report.request", "alert.ack", "alert.dismiss",
]);

/**
 * Submit a command to the home agent. Idempotent: the client generates `clientId` once and re-sends it
 * on every retry; a repeated id returns the original command (HTTP 200, duplicate: true) and is never
 * processed twice.
 */
export async function POST(req: Request) {
  const g = guard(req, { write: true });
  if (isResponse(g)) return g;
  const raw = await req.text();
  if (raw.length > 16_384) return Response.json({ error: "payload too large" }, { status: 413 });
  let body: { clientId?: unknown; type?: unknown; payload?: unknown; clientCreatedAt?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(body.clientId)) return Response.json({ error: "clientId must be 8-100 chars [A-Za-z0-9_-]" }, { status: 400 });
  if (typeof body.type !== "string" || !TYPES.has(body.type as CommandType)) return Response.json({ error: "unknown command type" }, { status: 400 });
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
  if (body.type === "instruction" && (typeof payload.text !== "string" || !payload.text.trim())) return Response.json({ error: "instruction text required" }, { status: 400 });
  const r = home().agent.submit({
    clientId: body.clientId,
    type: body.type as CommandType,
    payload,
    issuedBy: g.label,
    clientCreatedAt: typeof body.clientCreatedAt === "number" ? body.clientCreatedAt : null,
  });
  return Response.json({ ack: true, duplicate: r.duplicate, command: r.command }, { status: r.duplicate ? 200 : 202 });
}

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const id = new URL(req.url).searchParams.get("clientId");
  const h = home();
  if (id) {
    const c = h.store.getCommand(id);
    return c ? Response.json(c) : Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json(h.store.recentCommands(100), { headers: { "Cache-Control": "no-store" } });
}
