import { clearCookie, readCookie, SESSION_COOKIE, sameOrigin } from "@/lib/auth/auth";
import { backend } from "@/lib/server/backend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const tok = readCookie(req, SESSION_COOKIE);
  const b = backend();
  const p = await b.session(tok);
  if (tok) await b.logout(tok);
  if (p) await b.auditEvent(p.label, "auth.logout", { session: p.sessionId });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie(req) } });
}
