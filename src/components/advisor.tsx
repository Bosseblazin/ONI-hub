"use client";
import { useState } from "react";
import { useApp } from "./shell";

/** Minimal Markdown → React (headings, bold, lists, paragraphs). Never injects HTML. */
function inline(t: string, key: string) {
  const parts = t.split(/(\*\*[^*]+\*\*|\[(?:observed|derived|assumption)\]|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={`${key}-${i}`} className="text-ink">{p.slice(2, -2)}</strong>;
    if (/^\[(observed|derived|assumption)\]$/.test(p)) {
      const c = p === "[observed]" ? "var(--good)" : p === "[derived]" ? "var(--accent)" : "var(--warn)";
      return <span key={`${key}-${i}`} className="mx-0.5 rounded-sm border px-1 text-[9px] uppercase tracking-wider" style={{ color: c, borderColor: c }}>{p.slice(1, -1)}</span>;
    }
    if (p.startsWith("`") && p.endsWith("`")) return <code key={`${key}-${i}`} className="num text-[11px]">{p.slice(1, -1)}</code>;
    return p.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");
  });
}

export function Markdown({ src }: { src: string }) {
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ordered ? "ol" : "ul";
    out.push(<L key={`l${out.length}`} className={`ml-4 space-y-0.5 ${list.ordered ? "list-decimal" : "list-disc"}`}>{list.items.map((x, i) => <li key={i}>{inline(x, `li${out.length}-${i}`)}</li>)}</L>);
    list = null;
  };
  src.split("\n").forEach((raw, idx) => {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) { flush(); out.push(<h4 key={idx} className="mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink2">{h[2]!.replace(/\*\*/g, "")}</h4>); }
    else if (ol) { if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; } list.items.push(ol[1]!); }
    else if (ul) { if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; } list.items.push(ul[1]!); }
    else if (!line.trim()) flush();
    else { flush(); out.push(<p key={idx}>{inline(line, `p${idx}`)}</p>); }
  });
  flush();
  return <div className="space-y-1.5 text-xs leading-relaxed text-ink2">{out}</div>;
}

/**
 * Status briefings from Claude. Requests go through the command queue to the home agent (where Claude
 * runs); the panel shows the latest report and the request's real delivery state.
 */
export function AdvisorPanel() {
  const { live, send, outbox } = useApp();
  const [reqId, setReqId] = useState<string | null>(null);
  const ops = live.ops;
  const last = ops?.messages.filter((m) => m.kind === "report").pop() ?? null;
  const req = reqId ? live.relayCommands.find((c) => c.clientId === reqId) ?? null : null;
  const homeCmd = reqId ? ops?.commands.find((c) => c.clientId === reqId) ?? null : null;
  const pendingLocal = reqId ? outbox.some((o) => o.clientId === reqId && !o.ackedAt) : false;
  const state = homeCmd?.status === "completed" || homeCmd?.status === "failed" ? null
    : homeCmd ? "Claude is preparing the briefing on the home PC…"
    : req?.deliveredAt ? "Delivered to the home PC…"
    : req ? "Queued — waiting for the home PC to pick it up"
    : pendingLocal ? "Sending…" : null;
  const claude = ops?.agent.claudeAvailable;
  return (
    <section className="panel flex min-h-0 flex-col" aria-label="AI colony advisor">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="panel-title">AI Colony Advisor</h2>
        <button
          onClick={() => setReqId(send("report.request", {}))}
          disabled={!!state}
          className="rounded border border-accent/60 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-accent hover:bg-accent/10 disabled:opacity-40"
        >
          {state ? "WORKING…" : "REQUEST BRIEFING"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {state && <p className="mb-2 text-[11px] text-warn">● {state}</p>}
        {homeCmd?.status === "failed" && <p className="mb-2 text-[11px] text-crit">Request failed: {homeCmd.error}</p>}
        {!claude && !live.dashboard?.connection.simulated && (
          <p className="mb-2 text-xs text-muted">Claude is not configured on the home PC (ANTHROPIC_API_KEY). Requests will wait until it is.</p>
        )}
        {!last && !state && <p className="text-xs text-muted">No briefing yet. Claude briefs from a structured snapshot of the colony and has no ability to act on the game.</p>}
        {last && (
          <>
            <div className="mb-2 text-[10px] text-muted">
              {new Date(last.at).toLocaleString()} · {last.degraded ? <span className="text-[var(--s7)]">SIMULATED — not Claude</span> : "Claude"} · advisory only — no actions were taken
            </div>
            <Markdown src={last.text} />
          </>
        )}
      </div>
    </section>
  );
}
