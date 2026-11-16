import fs from "node:fs";
import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const f = home().screenshots.latest();
  if (!f) return Response.json({ error: "No screenshot yet. Enable screenshots in Settings (captures the home PC desktop)." }, { status: 404 });
  return new Response(fs.readFileSync(f), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Captured": fs.statSync(f).mtime.toISOString() } });
}
