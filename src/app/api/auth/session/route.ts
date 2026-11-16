import { readCookie, SESSION_COOKIE } from "@/lib/auth/auth";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const h = home();
  const rec = h.auth.check(readCookie(req, SESSION_COOKIE));
  return Response.json(
    { authenticated: !!rec, setupRequired: !h.auth.passphraseSet(), session: rec ? { id: rec.id, label: rec.label, expiresAt: rec.expiresAt } : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
