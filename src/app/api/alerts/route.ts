import { getCollector } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Acknowledge or dismiss an alert. This only changes dashboard state, never the game. */
export async function POST(req: Request) {
  let body: { id?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.id !== "string" || (body.action !== "acknowledge" && body.action !== "dismiss")) {
    return Response.json({ error: "expected {id, action: 'acknowledge'|'dismiss'}" }, { status: 400 });
  }
  const c = getCollector();
  const ok = body.action === "acknowledge" ? c.acknowledge(body.id) : c.dismiss(body.id);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
