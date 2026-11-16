import { clearCookie, readCookie, SESSION_COOKIE, sameOrigin } from "@/lib/auth/auth";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const tok = readCookie(req, SESSION_COOKIE);
  const h = home();
  const rec = h.auth.check(tok);
  if (tok) h.auth.logout(tok);
  if (rec) h.store.audit(rec.label, "auth.logout", { session: rec.id });
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie(req) } });
}
