import { cloudStore, isCloud } from "@/lib/server/backend";
import { verifyRequest } from "@/lib/relay/protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Home agent uploads its latest (opt-in) desktop screenshot. HMAC-signed; ≤ 3 MB. */
export async function POST(req: Request) {
  if (!isCloud()) return Response.json({ error: "relay endpoints are only active in cloud mode" }, { status: 404 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > 3_000_000) return Response.json({ error: "screenshot too large (max 3 MB)" }, { status: 413 });
  const v = verifyRequest(process.env.IC_AGENT_SECRET, req.headers, "POST", "/api/agent/screenshot", raw);
  if (!v.ok) return Response.json({ error: v.reason }, { status: 401 });
  const mime = req.headers.get("content-type") === "image/jpeg" ? "image/jpeg" : "image/png";
  await cloudStore().saveScreenshot(mime, raw);
  return Response.json({ ok: true });
}
