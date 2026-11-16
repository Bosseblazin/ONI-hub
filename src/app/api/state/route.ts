import { getCollector } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(getCollector().getState(), { headers: { "Cache-Control": "no-store" } });
}
