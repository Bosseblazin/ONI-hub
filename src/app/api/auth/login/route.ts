import { clientKey, sameOrigin, sessionCookie } from "@/lib/auth/auth";
import { backend } from "@/lib/server/backend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { passphrase?: unknown; label?: unknown };
  const b = backend();
  const key = clientKey(req);
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : (req.headers.get("user-agent") ?? "device").slice(0, 60);
  const r = await b.login(typeof body.passphrase === "string" ? body.passphrase : "", key, label);
  if (!r.ok) {
    await b.auditEvent(key, "auth.login_failed", { reason: r.error });
    return Response.json({ error: r.error, retryAfterMs: r.retryAfterMs ?? null }, { status: r.retryAfterMs ? 429 : 401 });
  }
  await b.auditEvent(r.session.label, "auth.login", { session: r.session.id, client: key });
  return Response.json({ ok: true, session: r.session }, { headers: { "Set-Cookie": sessionCookie(r.token, req) } });
}
