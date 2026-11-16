import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  return Response.json(home().auth.list(g.sessionId), { headers: { "Cache-Control": "no-store" } });
}

/** {revoke: sessionId} or {revokeOthers: true} */
export async function POST(req: Request) {
  const g = guard(req, { write: true });
  if (isResponse(g)) return g;
  const body = (await req.json().catch(() => ({}))) as { revoke?: unknown; revokeOthers?: unknown };
  const h = home();
  if (typeof body.revoke === "string") {
    const ok = h.auth.revoke(body.revoke);
    h.store.audit(g.label, "auth.revoke", { session: body.revoke, ok });
    return Response.json({ ok });
  }
  if (body.revokeOthers === true) {
    for (const s of h.auth.list(g.sessionId)) if (!s.current) h.auth.revoke(s.id);
    h.store.audit(g.label, "auth.revoke_others", {});
    return Response.json({ ok: true });
  }
  return Response.json({ error: "expected {revoke} or {revokeOthers:true}" }, { status: 400 });
}
