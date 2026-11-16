"use client";
import { AdvisorPanel } from "@/components/advisor";
import { MobileStatus } from "@/components/mobile";
import { AiSummary, Recommendations, Section } from "@/components/ops-ui";
import { AlertPanel, AsteroidCard, CapabilitiesPanel, DormantList, PowerPanel, ResourceMatrix, WorkforcePanel } from "@/components/panels";
import { useApp } from "@/components/shell";
import type { DashboardState, WorldState } from "@/lib/model/types";
import { useHistory } from "@/lib/ui/hooks";

function CardWithHistory({ w, s, now }: { w: WorldState; s: DashboardState; now: number }) {
  const h = useHistory(w.id);
  return <AsteroidCard w={w} s={s} history={h} now={now} />;
}

export default function Overview() {
  const { live, now } = useApp();
  const s = live.dashboard;
  const ops = live.ops;
  const worlds = s?.snapshot?.worlds ?? [];
  const settled = worlds.filter((w) => w.settled);
  const dormant = worlds.filter((w) => !w.settled);

  return (
    <>
      <MobileStatus />
      {!s?.snapshot ? (
        <main className="hidden flex-1 items-center justify-center p-8 lg:flex">
          <div className="panel max-w-xl p-6 text-center">
            <div className="panel-title mb-2">Awaiting telemetry</div>
            <p className="text-sm text-ink2">{s?.staleReason ?? "Connecting to the home PC…"}</p>
            <p className="mt-3 text-xs text-muted">
              Start Oxygen Not Included with the <b>ONI MCP Server</b> mod enabled and load a colony. The dashboard polls{" "}
              <span className="num">{s?.connection.url ?? "http://127.0.0.1:8788/mcp/"}</span> and never sends commands to the game.
            </p>
          </div>
        </main>
      ) : (
        <main className="hidden min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px] gap-3 p-3 lg:grid xl:h-[calc(100vh-150px)]">
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 2xl:grid-cols-3">
              {settled.map((w) => <CardWithHistory key={w.id} w={w} s={s} now={now} />)}
            </div>
            <DormantList worlds={dormant} />
            <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
              <ResourceMatrix s={s} worlds={settled} />
              <div className="flex flex-col gap-3">
                <PowerPanel s={s} worlds={settled.filter((w) => w.power && w.power.consumerCount + w.power.generatorCount > 0)} />
                <WorkforcePanel s={s} worlds={settled} />
              </div>
            </div>
            <CapabilitiesPanel s={s} />
          </div>
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            {ops && (
              <Section title="Claude — operations">
                <AiSummary ops={ops} />
                <Recommendations recs={ops.recommendations} />
              </Section>
            )}
            <div className="flex min-h-[300px] flex-[3] flex-col"><AlertPanel alerts={s.alerts} now={now} /></div>
            <div className="flex min-h-[220px] flex-[2] flex-col"><AdvisorPanel /></div>
          </aside>
        </main>
      )}
    </>
  );
}
