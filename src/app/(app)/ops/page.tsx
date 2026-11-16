"use client";
import { AiSummary, CommandLog, DecisionList, InvestigationList, ObjectiveList, ProposalList, Recommendations, Section } from "@/components/ops-ui";
import { useApp } from "@/components/shell";

export default function OpsPage() {
  const { live } = useApp();
  const ops = live.ops;
  if (!ops) return <p className="p-6 text-sm text-muted">Connecting to the home PC…</p>;
  const blocked = ops.objectives.filter((o) => o.status === "blocked");
  const blockedInv = ops.investigations.filter((i) => i.status === "blocked" || (i.status === "open" && i.blockedReason));
  return (
    <main className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-3">
      <div className="space-y-3 xl:col-span-2">
        <Section title="AI operations status"><AiSummary ops={ops} /><Recommendations recs={ops.recommendations} /></Section>
        <Section title="Investigations"><InvestigationList items={ops.investigations} /></Section>
        <Section title="Pending & completed actions"><ProposalList items={ops.proposals} level={ops.permissionLevel} /></Section>
      </div>
      <div className="space-y-3">
        {(blocked.length > 0 || blockedInv.length > 0) && (
          <Section title="Blocked">
            <ul className="divide-y divide-line text-xs">
              {blocked.map((o) => <li key={o.id} className="px-3 py-1.5"><b>{o.title}</b> <span className="text-muted">{o.history[o.history.length - 1]?.note}</span></li>)}
              {blockedInv.map((i) => <li key={i.id} className="px-3 py-1.5"><b>{i.topic}</b> <span className="text-muted">{i.blockedReason}</span></li>)}
            </ul>
          </Section>
        )}
        <Section title="Objectives (incl. completed)"><ObjectiveList objectives={ops.objectives} showDone /></Section>
        <Section title="Recent decisions & reasoning"><DecisionList ops={ops} /></Section>
        <Section title="Command queue" right={<span className="text-[10px] text-muted">{ops.agent.queueDepth} pending</span>}><CommandLog commands={ops.commands} /></Section>
      </div>
    </main>
  );
}
