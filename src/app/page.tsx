"use client";
import { AdvisorPanel } from "@/components/advisor";
import { AlertPanel, AsteroidCard, Banners, CapabilitiesPanel, DormantList, Header, PowerPanel, ResourceMatrix, WorkforcePanel } from "@/components/panels";
import type { DashboardState, WorldState } from "@/lib/model/types";
import { useDashboard, useHistory, useNow } from "@/lib/ui/hooks";

function CardWithHistory({ w, s, now }: { w: WorldState; s: DashboardState; now: number }) {
  const h = useHistory(w.id);
  return <AsteroidCard w={w} s={s} history={h} now={now} />;
}

export default function Page() {
  const { state: s, linkUp } = useDashboard();
  const now = useNow();
  const worlds = s?.snapshot?.worlds ?? [];
  const settled = worlds.filter((w) => w.settled);
  const dormant = worlds.filter((w) => !w.settled);

  return (
    <div className="flex min-h-screen flex-col xl:h-screen">
      <Header s={s} now={now} linkUp={linkUp} />
      <Banners s={s} />
      {!s?.snapshot ? (
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="panel max-w-xl p-6 text-center">
            <div className="panel-title mb-2">Awaiting telemetry</div>
            <p className="text-sm text-ink2">{s?.staleReason ?? "Connecting to the dashboard server…"}</p>
            <p className="mt-3 text-xs text-muted">
              Start Oxygen Not Included with the <b>ONI MCP Server</b> mod enabled and load a colony. The dashboard polls{" "}
              <span className="num">{s?.connection.url ?? "http://127.0.0.1:8788/mcp/"}</span> and never sends commands to the game.
              No values are shown until real data arrives.
            </p>
          </div>
        </main>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
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
          <aside className="flex min-h-0 flex-col gap-3">
            <div className="flex min-h-[320px] flex-[3] flex-col"><AlertPanel alerts={s.alerts} now={now} /></div>
            <div className="flex min-h-[260px] flex-[2] flex-col"><AdvisorPanel /></div>
          </aside>
        </main>
      )}
    </div>
  );
}
