import { buildAdvisorPayload } from "@/lib/advisor/advisor";
import { getAdvisor, getCollector } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Advisor status, last report, and (with ?payload=1) the exact snapshot that would be sent. */
export function GET(req: Request) {
  const u = new URL(req.url);
  const body: Record<string, unknown> = { ...getAdvisor().status() };
  if (u.searchParams.get("payload")) body.payload = buildAdvisorPayload(getCollector().getState());
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Request a new briefing. Rate-limited server-side (90 s cooldown). */
export async function POST() {
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
