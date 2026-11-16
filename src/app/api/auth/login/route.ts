import { clientKey, sameOrigin, sessionCookie } from "@/lib/auth/auth";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403 });
  let body: { passphrase?: unknown; label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const h = home();
  const key = clientKey(req);
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : (req.headers.get("user-agent") ?? "device").slice(0, 60);
  const r = h.auth.login(typeof body.passphrase === "string" ? body.passphrase : "", key, label);
  if (!r.ok) {
    h.store.audit(key, "auth.login_failed", { reason: r.error });
    return Response.json({ error: r.error, retryAfterMs: r.retryAfterMs ?? null }, { status: r.retryAfterMs ? 429 : 401 });
  }
  h.store.audit(r.session.label, "auth.login", { session: r.session.id, client: key });
  return Response.json({ ok: true, session: r.session }, { headers: { "Set-Cookie": sessionCookie(r.token, req) } });
}
