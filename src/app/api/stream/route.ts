import { getCollector } from "@/lib/server/singleton";
import type { DashboardState } from "@/lib/model/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events: pushes the full DashboardState after every poll. */
export function GET(req: Request) {
  const collector = getCollector();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (s: DashboardState) => {
        try {
          ctrl.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(s)}\n\n`));
        } catch {
          cleanup();
        }
      };
      send(collector.getState());
      collector.on("state", send);
      // Re-send every 5s even without a poll so the client sees staleness age move.
      const ka = setInterval(() => send(collector.getState()), 5000);
      cleanup = () => {
        clearInterval(ka);
        collector.off("state", send);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try { ctrl.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive" },
  });
}
