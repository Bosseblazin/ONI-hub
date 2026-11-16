import { guard, isResponse } from "@/lib/server/guard";
import { getCollector } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const u = new URL(req.url);
  const world = Number(u.searchParams.get("world"));
  const since = u.searchParams.get("sinceCycles");
  if (!Number.isInteger(world)) return Response.json({ error: "world must be an integer" }, { status: 400 });
  const rows = getCollector().historyFor(world, since !== null ? Number(since) : undefined);
  const step = Math.max(1, Math.ceil(rows.length / 600));
  return Response.json(rows.filter((_, i) => i % step === 0 || i === rows.length - 1), { headers: { "Cache-Control": "no-store" } });
}
