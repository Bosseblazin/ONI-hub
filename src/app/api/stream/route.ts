import { readCookie, SESSION_COOKIE } from "@/lib/auth/auth";
import { guard, isResponse } from "@/lib/server/guard";
import { home } from "@/lib/server/singleton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events: {dashboard, ops} after every poll and every 5 s. Requires a session. */
export function GET(req: Request) {
  const g = guard(req);
  if (isResponse(g)) return g;
  const h = home();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let last = 0;
      const send = () => {
        const now = Date.now();
        if (now - last < 400) return; // coalesce bursts
        last = now;
        try {
          // Re-check the session so a revoked device stops receiving data.
          if (!h.auth.check(readCookie(req, SESSION_COOKIE))) {
            ctrl.enqueue(enc.encode(`event: auth\ndata: {"error":"unauthorized"}\n\n`));
            cleanup();
            ctrl.close();
            return;
          }
          ctrl.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify({ dashboard: h.collector.getState(), ops: h.agent.getState() })}\n\n`));
        } catch {
          cleanup();
        }
      };
      send();
      h.collector.on("state", send);
      const ka = setInterval(send, 5000);
      cleanup = () => {
        clearInterval(ka);
        h.collector.off("state", send);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try { ctrl.close(); } catch { /* closed */ }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
