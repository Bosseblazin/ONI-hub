"use client";
import { ChatThread, ModeSelector, ObjectiveList, Recommendations, Section } from "@/components/ops-ui";
import { useApp } from "@/components/shell";

export default function CommandPage() {
  const { live } = useApp();
  const ops = live.ops;
  if (!ops) return <p className="p-6 text-sm text-muted">Connecting to the home PC…</p>;
  const pendingRecs = ops.recommendations.filter((r) => r.status === "pending").length;
  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:h-[calc(100vh-150px)] lg:grid-cols-[minmax(0,1fr)_440px]">
      <section className="panel flex h-[calc(100dvh-170px)] min-h-[420px] flex-col lg:h-auto">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="panel-title">Commander ↔ Claude</h2>
          <span className="text-[10px] text-muted">{ops.agent.claudeAvailable ? "Claude online" : live.dashboard?.connection.simulated ? "simulated interpreter (demo)" : "Claude not configured — instructions queue"}</span>
        </div>
        <ChatThread messages={ops.messages} commands={ops.commands} />
      </section>
      <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
        {pendingRecs > 0 && <Section title={`Awaiting your decision (${pendingRecs})`}><Recommendations recs={ops.recommendations} /></Section>}
        <Section title="Strategic objectives"><ObjectiveList objectives={ops.objectives} /></Section>
        <Section title="Operating mode"><ModeSelector ops={ops} /></Section>
      </div>
    </main>
  );
}
