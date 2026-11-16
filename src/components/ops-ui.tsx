"use client";
import { useEffect, useRef, useState } from "react";
import { MODES } from "@/lib/ops/objectives";
import type { ActionProposal, Command, Investigation, Message, Objective, OperatingMode, OpsState, PriorityLevel, Recommendation } from "@/lib/ops/types";
import type { RelayCommandStatus } from "@/lib/relay/protocol";
import { PERMISSION_LABELS, PRIORITY_LABELS } from "@/lib/ops/types";
import { age } from "@/lib/ui/format";
import { useApp } from "./shell";

/* ------------------------------------------------------------------ bits */

const PRIO_COLOR: Record<PriorityLevel, string> = { 1: "var(--crit)", 2: "var(--serious)", 3: "var(--warn)", 4: "var(--accent)", 5: "var(--muted)" };

export function PriorityChip({ p }: { p: PriorityLevel }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border px-1 text-[9px] font-semibold uppercase tracking-wider" style={{ color: PRIO_COLOR[p], borderColor: PRIO_COLOR[p] }}>
      P{p} {PRIORITY_LABELS[p]}
    </span>
  );
}

export function Section({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="panel-title">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const Btn = ({ children, onClick, tone = "default", disabled }: { children: React.ReactNode; onClick: () => void; tone?: "default" | "accent" | "danger"; disabled?: boolean }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`min-h-[32px] rounded border px-2.5 py-1 text-[11px] font-semibold tracking-wide disabled:opacity-40 ${
      tone === "accent" ? "border-accent/70 text-accent hover:bg-accent/10" : tone === "danger" ? "border-crit/70 text-crit hover:bg-crit/10" : "border-line text-ink2 hover:border-ink2"
    }`}
  >
    {children}
  </button>
);

/* ----------------------------------------------------------- AI summary */

/** What Claude is trying to accomplish right now, plus whether it can actually see the colony. */
export function AiSummary({ ops, compact }: { ops: OpsState; compact?: boolean }) {
  const { live, now } = useApp();
  const active = ops.objectives.filter((o) => o.status === "active" || o.status === "blocked");
  const primary = active[0];
  const inv = ops.investigations.find((i) => i.id === ops.agent.currentInvestigationId) ?? ops.investigations.find((i) => i.status === "open" || i.status === "analyzing");
  const watching = live.link === "live" && !live.dashboard?.stale;
  const pendingRecs = ops.recommendations.filter((r) => r.status === "pending").length;
  return (
    <div className="space-y-2 px-3 py-2.5 text-xs">
      {!watching && (
        <div className="rounded border border-warn/60 bg-[#2a2210] px-2 py-1.5 text-[11px] text-warn">
          Claude is <b>not observing the colony right now</b> — {live.link === "home-offline" ? "the home agent is offline." : live.link !== "live" ? "this device cannot reach the service." : live.dashboard?.staleReason}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span><span className="text-muted">Mode </span><b className="text-ink">{MODES[ops.mode.mode].label}</b>{ops.mode.setBy === "commander" ? <span className="text-muted"> (set by you)</span> : null}</span>
        <span><span className="text-muted">Permission </span><b className="text-ink">L{ops.permissionLevel} {PERMISSION_LABELS[ops.permissionLevel]}</b></span>
        {!compact && <span className="text-muted">Claude: {ops.agent.claudeAvailable ? `available · ${ops.agent.claudeCallsLastHour} calls/h` : "not configured"}</span>}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Primary objective</div>
        {primary ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <PriorityChip p={primary.priority} />
            <span className="font-semibold text-ink">{primary.title}</span>
            {primary.progress !== null && <span className="num text-muted">{primary.progress}%</span>}
            {primary.status === "blocked" && <span className="text-[10px] text-crit">BLOCKED</span>}
          </div>
        ) : (
          <div className="text-muted">No active objectives. Send an instruction to set one.</div>
        )}
        {active.length > 1 && <div className="mt-0.5 text-[11px] text-muted">+ {active.length - 1} secondary: {active.slice(1, 4).map((o) => o.title).join(" · ")}</div>}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Current investigation</div>
        <div className="text-ink2">{inv ? <>{inv.topic} <span className="text-muted">— {inv.status}{inv.blockedReason ? `: ${inv.blockedReason}` : ""}</span></> : <span className="text-muted">None</span>}</div>
      </div>
      <div className="flex flex-wrap gap-x-4 text-[10px] text-muted">
        <span>last observation {age(live.dashboard?.lastUpdate ?? null, now)}</span>
        <span>last Claude analysis {age(ops.agent.lastClaudeSuccessAt, now)}</span>
        {pendingRecs > 0 && <span className="text-warn">{pendingRecs} recommendation(s) awaiting you</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ mode */

export function ModeSelector({ ops }: { ops: OpsState }) {
  const { send } = useApp();
  return (
    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-5">
      {(Object.keys(MODES) as OperatingMode[]).map((m) => {
        const on = ops.mode.mode === m;
        return (
          <button
            key={m}
            onClick={() => !on && confirm(`Switch operating mode to ${MODES[m].label}?`) && send("mode.set", { mode: m })}
            className={`rounded border px-2 py-2 text-left ${on ? "border-accent bg-accent/10" : "border-line hover:border-ink2"}`}
            aria-pressed={on}
          >
            <div className={`text-[11px] font-bold uppercase tracking-wider ${on ? "text-accent" : "text-ink"}`}>{MODES[m].label}</div>
            <div className="mt-0.5 text-[10px] leading-snug text-muted">{MODES[m].summary}</div>
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- recommendations */

export function Recommendations({ recs }: { recs: Recommendation[] }) {
  const { send } = useApp();
  const pending = recs.filter((r) => r.status === "pending");
  if (!pending.length) return null;
  return (
    <ul className="divide-y divide-line">
      {pending.map((r) => (
        <li key={r.id} className="space-y-1.5 px-3 py-2.5 text-xs" style={{ borderLeft: "3px solid var(--warn)" }}>
          <div className="font-semibold text-ink">{r.title}</div>
          {r.conflict && <div className="text-[11px] text-warn">Conflict: {r.conflict}</div>}
          <div className="text-ink2">{r.rationale}</div>
          {r.objectiveChanges && r.objectiveChanges.length > 0 && <div className="text-[10px] text-muted">Would defer {r.objectiveChanges.length} objective(s).</div>}
          <div className="flex gap-2">
            <Btn tone="accent" onClick={() => send("recommendation.decide", { id: r.id, decision: "accept" })}>Accept</Btn>
            <Btn onClick={() => send("recommendation.decide", { id: r.id, decision: "decline" })}>Decline</Btn>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- objectives */

export function ObjectiveList({ objectives, showDone = false }: { objectives: Objective[]; showDone?: boolean }) {
  const { send } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const list = objectives.filter((o) => showDone || (o.status !== "completed" && o.status !== "cancelled"));
  if (!list.length) return <p className="px-3 py-4 text-xs text-muted">No objectives yet. Tell Claude what to focus on.</p>;
  return (
    <ul className="divide-y divide-line">
      {list.map((o) => {
        const isOpen = open === o.id;
        return (
          <li key={o.id} className={`px-3 py-2 text-xs ${o.status === "paused" || o.status === "completed" || o.status === "cancelled" ? "opacity-60" : ""}`}>
            <button className="w-full text-left" onClick={() => setOpen(isOpen ? null : o.id)} aria-expanded={isOpen}>
              <div className="flex flex-wrap items-center gap-2">
                <PriorityChip p={o.priority} />
                <span className="text-[10px] uppercase tracking-wider text-muted">{o.status}</span>
                <span className="text-[10px] text-muted">{o.worldName ?? "Colony-wide"}</span>
              </div>
              <div className="mt-0.5 font-semibold text-ink">{o.title}</div>
              {o.progress !== null && (
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--grid)]" role="progressbar" aria-valuenow={o.progress} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${o.progress}%` }} />
                  </div>
                  <span className="num text-[10px] text-muted">{o.progress}%</span>
                </div>
              )}
              {o.progressNote && <div className="mt-0.5 text-[10px] text-muted">{o.progressNote}</div>}
            </button>
            {isOpen && (
              <div className="mt-2 space-y-1.5 text-[11px]">
                {o.description && <p className="text-ink2">{o.description}</p>}
                <p><span className="text-muted">Done when: </span>{o.completionCriteria}</p>
                {o.constraints.length > 0 && <p><span className="text-muted">Constraints: </span>{o.constraints.join("; ")}</p>}
                {o.dependencies.length > 0 && <p><span className="text-muted">Depends on: </span>{o.dependencies.join(", ")}</p>}
                <p className="text-[10px] text-muted">Created {new Date(o.createdAt).toLocaleString()} by {o.createdBy} · updated {new Date(o.updatedAt).toLocaleString()}</p>
                <ul className="max-h-28 overflow-y-auto text-[10px] text-muted">{o.history.slice(-6).reverse().map((h, i) => <li key={i}>{new Date(h.at).toLocaleTimeString()} · {h.by}: {h.note}</li>)}</ul>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <label className="flex items-center gap-1 text-[10px] text-muted">
                    Priority
                    <select value={o.priority} onChange={(e) => send("objective.update", { id: o.id, priority: Number(e.target.value) })} className="rounded border border-line bg-panel2 px-1 py-1 text-[11px] text-ink">
                      {([1, 2, 3, 4, 5] as PriorityLevel[]).map((p) => <option key={p} value={p}>{p} {PRIORITY_LABELS[p]}</option>)}
                    </select>
                  </label>
                  {o.status === "active" && <Btn onClick={() => send("objective.update", { id: o.id, status: "paused" })}>Pause</Btn>}
                  {(o.status === "paused" || o.status === "blocked") && <Btn onClick={() => send("objective.update", { id: o.id, status: "active" })}>Resume</Btn>}
                  {o.status !== "completed" && <Btn onClick={() => send("objective.update", { id: o.id, status: "completed" })}>Mark done</Btn>}
                  {o.status !== "cancelled" && <Btn tone="danger" onClick={() => confirm(`Cancel objective "${o.title}"?`) && send("objective.update", { id: o.id, status: "cancelled" })}>Cancel</Btn>}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------- chat */

const SUGGESTIONS = [
  "Forget expansion for now. Our second asteroid is becoming unstable. Focus on food, oxygen, and power. Keep me updated.",
  "Investigate why oxygen production is declining on the home asteroid.",
  "Don't accept any additional duplicants until food reserves improve.",
  "How is the colony doing?",
];

/**
 * Honest delivery state across the whole chain: this device → service (cloud queue) → home PC → processed.
 * "processed" only ever comes from the home agent's own report.
 */
function deliveryLabel(clientId: string | null, cmds: Command[], outbox: ReturnType<typeof useApp>["outbox"], relay: RelayCommandStatus[]): { text: string; color: string } | null {
  if (!clientId) return null;
  const c = cmds.find((x) => x.clientId === clientId);
  const r = relay.find((x) => x.clientId === clientId);
  if (!c && r) {
    if (r.homeStatus && r.homeStatus !== "received") return { text: r.homeStatus === "completed" ? "processed (confirmed by home PC)" : r.homeStatus === "failed" ? `failed: ${r.error ?? ""}` : r.homeStatus, color: r.homeStatus === "completed" ? "var(--good)" : r.homeStatus === "failed" ? "var(--crit)" : "var(--warn)" };
    if (r.homeStatus === "received") return { text: "received by home PC", color: "var(--muted)" };
    if (r.deliveredAt) return { text: "delivered to home PC — awaiting confirmation", color: "var(--warn)" };
    return { text: "queued in the cloud — waiting for the home PC", color: "var(--warn)" };
  }
  if (c) {
    const m: Record<Command["status"], [string, string]> = {
      received: ["received by home PC", "var(--muted)"],
      processing: ["Claude is interpreting…", "var(--accent)"],
      completed: ["processed", "var(--good)"],
      failed: [`failed: ${c.error ?? ""}`, "var(--crit)"],
      deferred: ["queued on home PC — waiting for Claude", "var(--warn)"],
    };
    return { text: m[c.status][0], color: m[c.status][1] };
  }
  const o = outbox.find((x) => x.clientId === clientId);
  if (o && !o.ackedAt) return { text: o.attempts ? `not delivered yet — retrying (${o.lastError ?? ""})` : "sending…", color: "var(--warn)" };
  return null;
}

export function ChatThread({ messages, commands }: { messages: Message[]; commands: Command[] }) {
  const { outbox, send, live } = useApp();
  const relay = live.relayCommands;
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  // Instructions not yet in the home agent's thread: still in this device's outbox, or waiting in the cloud queue
  // (possibly sent from another device). Shown with their real delivery state.
  const inThread = (id: string) => messages.some((m) => m.commandClientId === id);
  const pending = [
    ...outbox.filter((o) => o.type === "instruction" && !inThread(o.clientId) && !relay.some((r) => r.clientId === o.clientId)).map((o) => ({ clientId: o.clientId, text: String(o.payload.text ?? "") })),
    ...relay.filter((r) => r.type === "instruction" && !inThread(r.clientId) && r.homeStatus === null).map((r) => ({ clientId: r.clientId, text: String(r.payload?.text ?? "") })),
  ];
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending.length]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send("instruction", { text: t });
    setText("");
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
        {messages.length === 0 && pending.length === 0 && <p className="py-6 text-center text-xs text-muted">No messages yet. You are the commander — tell Claude what matters.</p>}
        {messages.map((m) => {
          const mine = m.from === "commander";
          const dl = mine ? deliveryLabel(m.commandClientId, commands, outbox, relay) : null;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[88%] rounded-lg px-3 py-2 text-[13px] leading-snug ${mine ? "bg-accent/15 text-ink" : m.from === "system" ? "border border-dashed border-line text-ink2" : "bg-panel2 text-ink"}`}>
                <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
                  <span>{mine ? "Commander" : m.from === "claude" ? (m.degraded ? "Simulated interpreter" : "Claude · Operations") : "System"}</span>
                  {m.kind && !mine && <span>{m.kind.replace(/_/g, " ")}</span>}
                  <span className="num">{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className="whitespace-pre-wrap">{m.text}</div>
                {dl && <div className="mt-1 text-[10px]" style={{ color: dl.color }}>● {dl.text}</div>}
              </div>
            </div>
          );
        })}
        {pending.map((o) => {
          const ob = outbox.find((x) => x.clientId === o.clientId);
          const dl = deliveryLabel(o.clientId, commands, outbox, relay) ?? (ob && !ob.ackedAt ? { text: ob.attempts ? `not sent yet — retrying (${ob.lastError ?? ""})` : "sending…", color: "var(--warn)" } : { text: "sent", color: "var(--muted)" });
          return (
            <div key={o.clientId} className="flex justify-end">
              <div className="max-w-[88%] rounded-lg bg-accent/10 px-3 py-2 text-[13px] text-ink2">
                <div className="whitespace-pre-wrap">{o.text}</div>
                <div className="mt-1 text-[10px]" style={{ color: dl.color }}>● {dl.text}</div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <div className="border-t border-line p-2">
        <div className="mb-1.5 flex gap-1.5 overflow-x-auto pb-1">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => setText(s)} className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[10px] text-ink2 hover:border-ink2">
              {s.length > 42 ? s.slice(0, 40) + "…" : s}
            </button>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder="Instruction for Claude…"
            aria-label="Instruction for Claude"
            className="min-h-[44px] flex-1 resize-none rounded border border-line bg-panel2 px-3 py-2 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button type="submit" disabled={!text.trim()} className="min-h-[44px] rounded bg-accent px-4 text-[12px] font-bold tracking-wider text-[#06121f] disabled:opacity-40">SEND</button>
        </form>
        <p className="mt-1 text-[10px] text-muted">Instructions set strategy; they never authorise game actions. Claude cannot act in the game at Level 1.</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- investigations */

export function InvestigationList({ items }: { items: Investigation[] }) {
  const { send } = useApp();
  const [topic, setTopic] = useState("");
  return (
    <div>
      {items.length === 0 && <p className="px-3 py-3 text-xs text-muted">No investigations. CRITICAL alerts open one automatically.</p>}
      <ul className="divide-y divide-line">
        {items.slice(0, 12).map((i) => (
          <li key={i.id} className="px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: i.status === "concluded" ? "var(--good)" : i.status === "blocked" ? "var(--crit)" : "var(--accent)" }}>{i.status}</span>
              <span className="text-[10px] text-muted">{i.trigger} · {i.worldName ?? "colony"} · {new Date(i.updatedAt).toLocaleTimeString()}</span>
            </div>
            <div className="font-semibold text-ink">{i.topic}</div>
            {i.blockedReason && <div className="text-[11px] text-warn">{i.blockedReason}</div>}
            {i.summary && <div className="mt-0.5 text-ink2">{i.summary}</div>}
            {i.findings.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {i.findings.slice(0, 5).map((f, k) => (
                  <li key={k}><span className="mr-1 rounded-sm border px-1 text-[9px] uppercase" style={{ color: f.basis === "observed" ? "var(--good)" : f.basis === "derived" ? "var(--accent)" : "var(--warn)", borderColor: "currentColor" }}>{f.basis}</span>{f.statement}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2 border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (topic.trim()) send("investigation.request", { topic: topic.trim(), worldId: null });
          setTopic("");
        }}
      >
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Ask Claude to investigate…" className="min-h-[36px] flex-1 rounded border border-line bg-panel2 px-2 text-[13px] text-ink placeholder:text-muted" />
        <Btn tone="accent" onClick={() => {}} disabled={!topic.trim()}>Open</Btn>
      </form>
    </div>
  );
}

/* --------------------------------------------------------------- proposals */

export function ProposalList({ items, level }: { items: ActionProposal[]; level: number }) {
  const { send } = useApp();
  const pending = items.filter((p) => p.status === "proposed");
  const decided = items.filter((p) => p.status !== "proposed");
  return (
    <div className="text-xs">
      <div className="border-b border-line bg-[#14181f] px-3 py-1.5 text-[10px] text-muted">
        Level {level} — Observation. Approving records your decision; nothing is executed in the game. Follow the manual steps yourself.
      </div>
      {pending.length === 0 && <p className="px-3 py-3 text-muted">No pending actions.</p>}
      <ul className="divide-y divide-line">
        {pending.map((p) => (
          <li key={p.id} className="space-y-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-sm border border-line px-1 text-[9px] uppercase tracking-wider text-ink2">{p.category}</span>
              <span className="text-[9px] uppercase tracking-wider" style={{ color: p.risk === "routine" ? "var(--good)" : p.risk === "elevated" ? "var(--warn)" : "var(--crit)" }}>{p.risk}</span>
            </div>
            <div className="font-semibold text-ink">{p.title}</div>
            <div className="text-ink2">{p.rationale}</div>
            {p.manualSteps.length > 0 && <ol className="ml-4 list-decimal text-[11px] text-ink2">{p.manualSteps.map((s) => <li key={s}>{s}</li>)}</ol>}
            <div className="flex gap-2 pt-1">
              <Btn tone="accent" onClick={() => send("proposal.decide", { id: p.id, decision: "approve" })}>Approve (record)</Btn>
              <Btn onClick={() => send("proposal.decide", { id: p.id, decision: "reject" })}>Reject</Btn>
            </div>
          </li>
        ))}
      </ul>
      {decided.length > 0 && (
        <details className="border-t border-line px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-muted">Decided ({decided.length}) · executed actions: 0 (execution disabled)</summary>
          <ul className="mt-1 space-y-1 text-[11px]">{decided.slice(0, 15).map((p) => <li key={p.id}><span className="text-muted">{p.status}</span> — {p.title} <span className="text-muted">{p.executionNote}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function DecisionList({ ops }: { ops: OpsState }) {
  if (!ops.decisions.length) return <p className="px-3 py-3 text-xs text-muted">No decisions yet.</p>;
  return (
    <ul className="max-h-80 divide-y divide-line overflow-y-auto text-xs">
      {ops.decisions.slice(0, 25).map((d, i) => (
        <li key={i} className="px-3 py-1.5">
          <div className="flex justify-between gap-2"><span className="font-semibold text-ink">{d.summary}</span><span className="num shrink-0 text-[10px] text-muted">{new Date(d.at).toLocaleTimeString()}</span></div>
          <div className="text-[11px] text-ink2">{d.reasoning}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted">basis: {d.basis}</div>
        </li>
      ))}
    </ul>
  );
}

export function CommandLog({ commands }: { commands: Command[] }) {
  return (
    <ul className="max-h-72 divide-y divide-line overflow-y-auto text-[11px]">
      {commands.slice(0, 30).map((c) => (
        <li key={c.clientId} className="flex items-start justify-between gap-2 px-3 py-1.5">
          <div className="min-w-0">
            <span className="num text-muted">#{c.seq}</span> <b className="text-ink2">{c.type}</b> <span className="text-muted">by {c.issuedBy}</span>
            <div className="truncate text-muted">{c.result ?? c.error ?? ""}</div>
          </div>
          <div className="shrink-0 text-right">
            <div style={{ color: c.status === "completed" ? "var(--good)" : c.status === "failed" ? "var(--crit)" : "var(--warn)" }}>{c.status}</div>
            <div className="num text-[10px] text-muted">{new Date(c.receivedAt).toLocaleTimeString()}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
