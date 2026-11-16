export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Unauthenticated liveness probe. Reveals nothing about the colony. */
export function GET() {
  return Response.json({ ok: true, service: "interplanetary-command" }, { headers: { "Cache-Control": "no-store" } });
}
