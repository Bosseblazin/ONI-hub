"use client";
import { useCallback, useEffect, useState } from "react";
import type { AdvisorStatus } from "@/lib/advisor/advisor";

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

export function AdvisorPanel() {
  const [st, setSt] = useState<(AdvisorStatus & { error?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/advisor", { cache: "no-store" });
      setSt((await r.json()) as AdvisorStatus);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  const run = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/advisor", { method: "POST" });
      setSt((await r.json()) as AdvisorStatus & { error?: string });
    } finally {
      setBusy(false);
    }
  };
  const last = st?.last ?? null;
  return (
    <section className="panel flex min-h-0 flex-col" aria-label="AI colony advisor">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="panel-title">AI Colony Advisor</h2>
        {st?.available ? (
          <button
            onClick={() => void run()}
            disabled={busy || st.running || st.cooldownRemainingS > 0}
            className="rounded border border-accent/60 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            {busy || st.running ? "ANALYSING…" : st.cooldownRemainingS > 0 ? `READY IN ${st.cooldownRemainingS}s` : "REQUEST BRIEFING"}
          </button>
        ) : (
          <span className="text-[10px] text-muted">offline</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!st && <p className="text-xs text-muted">Loading…</p>}
        {st && !st.available && (
          <div className="space-y-2 text-xs text-muted">
            <p>{st.reason}</p>
            <p>The advisor receives a compact structured snapshot (no raw game data), runs only when you press the button, and is advisory only — it has no ability to act on the game. <a className="text-accent underline" href="/api/advisor?payload=1" target="_blank" rel="noreferrer">Preview the snapshot it would receive</a>.</p>
          </div>
        )}
        {st?.available && "lastError" in st && st.lastError && <p className="mb-2 text-xs text-crit">{st.lastError}</p>}
        {st?.available && !last && !busy && <p className="text-xs text-muted">No briefing yet. Briefings are generated on request from the current snapshot ({st.model}).</p>}
        {last && (
          <>
            <div className="mb-2 text-[10px] text-muted">
              Briefing for cycle {last.snapshotCycle ?? "?"} · {new Date(last.createdAt).toLocaleTimeString()} · {last.servedBy ?? last.model}
              {last.simulated && <span className="text-[var(--s7)]"> · SIMULATED DATA</span>} · advisory only — no actions were taken
            </div>
            <Markdown src={last.markdown} />
          </>
        )}
      </div>
    </section>
  );
}
