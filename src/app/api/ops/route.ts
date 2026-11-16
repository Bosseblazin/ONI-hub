import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  return Response.json(home().agent.getState(), { headers: { "Cache-Control": "no-store" } });
}
