import { backend } from "@/lib/server/backend";
import { guard, isResponse, noStore } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const g = await guard(req);
  if (isResponse(g)) return g;
  const u = new URL(req.url);
  const world = Number(u.searchParams.get("world"));
  const since = u.searchParams.get("sinceCycles");
  if (!Number.isInteger(world)) return Response.json({ error: "world must be an integer" }, { status: 400 });
  const rows = await backend().history(world, since !== null && since !== "" ? Number(since) : undefined);
  const step = Math.max(1, Math.ceil(rows.length / 600));
  return Response.json(rows.filter((_, i) => i % step === 0 || i === rows.length - 1), { headers: noStore });
}
