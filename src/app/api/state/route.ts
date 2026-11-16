import { backend } from "@/lib/server/backend";
import { guard, isResponse, noStore } from "@/lib/server/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

/** Live state: {dashboard, ops, relay, relayCommands}. Polled by the browser. */
export async function GET(req: Request) {
  const g = await guard(req);
  if (isResponse(g)) return g;
  return Response.json(await backend().state(), { headers: noStore });
}
