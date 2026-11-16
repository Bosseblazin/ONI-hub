import { backend } from "@/lib/server/backend";
import { guard, isResponse } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const g = await guard(req);
  if (isResponse(g)) return g;
  const s = await backend().screenshot();
  if (!s) return Response.json({ error: "No screenshot yet. Enable screenshots in Settings (captures the home PC desktop)." }, { status: 404 });
  return new Response(new Uint8Array(s.data), { headers: { "Content-Type": s.mime, "Cache-Control": "no-store", "X-Captured": new Date(s.at).toISOString() } });
}
