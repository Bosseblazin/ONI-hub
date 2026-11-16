import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const h = home();
  return Response.json({ dashboard: h.collector.getState(), ops: h.agent.getState() }, { headers: { "Cache-Control": "no-store" } });
}
