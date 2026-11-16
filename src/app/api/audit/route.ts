import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const s = home().store;
  const broken = s.verifyAudit();
  return Response.json({ intact: broken === null, brokenAt: broken, entries: s.readAudit(200).reverse() }, { headers: { "Cache-Control": "no-store" } });
}
