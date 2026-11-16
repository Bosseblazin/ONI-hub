import { backend } from "@/lib/server/backend";
import { guard, isResponse, noStore } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const g = await guard(req);
  if (isResponse(g)) return g;
  return Response.json({ mode: backend().mode, ...(await backend().audit()) }, { headers: noStore });
}
