import { backend } from "@/lib/server/backend";
import { guard, isResponse, noStore } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const g = await guard(req);
  if (isResponse(g)) return g;
  return Response.json(await backend().listSessions(g.sessionId), { headers: noStore });
}

/** {revoke: sessionId} or {revokeOthers: true} */
export async function POST(req: Request) {
  const g = await guard(req, { write: true });
  if (isResponse(g)) return g;
  const body = (await req.json().catch(() => ({}))) as { revoke?: unknown; revokeOthers?: unknown };
  const b = backend();
  if (typeof body.revoke === "string") {
    const ok = await b.revokeSession(body.revoke);
    await b.auditEvent(g.label, "auth.revoke", { session: body.revoke, ok });
    return Response.json({ ok });
  }
  if (body.revokeOthers === true) {
    for (const s of await b.listSessions(g.sessionId)) if (!s.current) await b.revokeSession(s.id);
    await b.auditEvent(g.label, "auth.revoke_others", {});
    return Response.json({ ok: true });
  }
  return Response.json({ error: "expected {revoke} or {revokeOthers:true}" }, { status: 400 });
}
