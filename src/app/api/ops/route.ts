import { backend } from "@/lib/server/backend";
import { guard, isResponse, noStore } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const g = await guard(req);
  if (isResponse(g)) return g;
  const s = await backend().state();
  return Response.json(s.ops ? { ...s.ops, relay: s.relay } : { error: "no data from the home agent yet", relay: s.relay }, { status: s.ops ? 200 : 503, headers: noStore });
}
