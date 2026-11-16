import { readCookie, SESSION_COOKIE } from "@/lib/auth/auth";
import { backend } from "@/lib/server/backend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const b = backend();
  const p = await b.session(readCookie(req, SESSION_COOKIE));
  return Response.json({ authenticated: !!p, setupRequired: await b.setupRequired(), mode: b.mode, session: p }, { headers: { "Cache-Control": "no-store" } });
}
