import { buildAdvisorPayload } from "@/lib/advisor/advisor";
import { guard, isResponse } from "@/lib/server/guard";
import { getAdvisor, getCollector } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const u = new URL(req.url);
  const body: Record<string, unknown> = { ...getAdvisor().status() };
  if (u.searchParams.get("payload")) body.payload = buildAdvisorPayload(getCollector().getState());
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const g = guard(req, { write: true });
  if (isResponse(g)) return g;
  const adv = getAdvisor();
  const st = adv.status();
  if (!st.available) return Response.json(st, { status: 503 });
  try {
    const report = await adv.run(getCollector().getState());
    return Response.json({ ...adv.status(), last: report });
  } catch (e) {
    return Response.json({ ...adv.status(), error: (e as Error).message }, { status: 502 });
  }
}
