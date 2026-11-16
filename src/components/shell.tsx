"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";
import type { CommandType } from "@/lib/ops/types";
import { age, clock } from "@/lib/ui/format";
import { useNow } from "@/lib/ui/hooks";
import { type LiveData, type OutboxItem, useCommands, useLive } from "@/lib/ui/live";
import { Banners, Header, SevBadge } from "./panels";

interface Ctx {
  live: LiveData;
  send: (type: CommandType, payload?: Record<string, unknown>) => string;
  outbox: OutboxItem[];
  now: number;
}
const LiveCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(LiveCtx);
  if (!c) throw new Error("useApp outside LiveProvider");
  return c;
}

const TABS = [
  { href: "/", label: "Status", icon: "◉" },
  { href: "/command", label: "Command", icon: "✦" },
  { href: "/ops", label: "AI Ops", icon: "◈" },
  { href: "/alerts", label: "Alerts", icon: "▲" },
  { href: "/settings", label: "Home", icon: "⌂" },
] as const;

/** Is the colony being watched right now? Honest, combined view of every link in the chain. */
export function watchState(l: LiveData): { ok: boolean; label: string; detail: string; color: string } {
  if (l.link === "device-offline") return { ok: false, label: "THIS DEVICE IS OFFLINE", detail: "Showing the last state this device received.", color: "var(--warn)" };
  if (l.link === "home-unreachable") return { ok: false, label: "HOME PC UNREACHABLE", detail: "The home PC (or its network/Tailscale) is not answering. The colony is not being monitored from here; values are last known.", color: "var(--crit)" };
  if (l.link === "connecting" || !l.dashboard) return { ok: false, label: "CONNECTING", detail: "Reaching the home PC…", color: "var(--warn)" };
  const d = l.dashboard;
  if (d.connection.state === "disconnected") return { ok: false, label: "GAME LINK DOWN", detail: "The home PC is online but cannot reach OniMcp. Is the game running?", color: "var(--crit)" };
  if (d.connection.state === "game-not-loaded") return { ok: false, label: "NO COLONY LOADED", detail: "The game is at the main menu.", color: "var(--warn)" };
  if (d.stale) return { ok: false, label: "MONITORING INTERRUPTED", detail: d.staleReason ?? "No fresh data.", color: "var(--warn)" };
  return { ok: true, label: "MONITORING LIVE", detail: "Home PC, game and OniMcp connected.", color: "var(--good)" };
}

function LinkBanner({ live, now }: { live: LiveData; now: number }) {
  if (live.link !== "home-unreachable" && live.link !== "device-offline") return null;
  const w = watchState(live);
  return (
    <div role="alert" className="border-b px-4 py-2 text-center text-xs" style={{ borderColor: w.color, background: "#2a1214", color: w.color }}>
      <b className="tracking-[0.15em]">{w.label}</b> — {w.detail} Last sync {clock(live.lastSyncAt)} ({age(live.lastSyncAt, now)}).
      {live.link === "home-unreachable" && <span className="block text-[11px] text-ink2">If only this phone lost its connection, the home agent may still be running and monitoring.</span>}
    </div>
  );
}

function MobileTop({ live, now }: { live: LiveData; now: number }) {
  const w = watchState(live);
  const d = live.dashboard;
  const crit = d?.alerts.filter((a) => a.status === "active" && !a.dismissed && a.severity === "CRITICAL").length ?? 0;
  const warn = d?.alerts.filter((a) => a.status === "active" && !a.dismissed && a.severity === "WARNING").length ?? 0;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-panel/95 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur lg:hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold tracking-[0.22em]">INTERPLANETARY COMMAND</div>
          <div className="num truncate text-[10px] text-muted">
            {d?.snapshot ? `C${d.snapshot.time?.cycle ?? "?"} · ${d.snapshot.totalPopulation ?? "?"} dupes${d.snapshot.time?.paused ? " · PAUSED" : ""}` : "—"} · sync {age(live.lastSyncAt, now)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {crit > 0 && <SevBadge sev="CRITICAL" small />}
          {!crit && warn > 0 && <SevBadge sev="WARNING" small />}
          <span className={`h-2.5 w-2.5 rounded-full ${w.ok ? "pulse" : ""}`} style={{ background: w.color }} title={w.label} aria-label={w.label} />
        </div>
      </div>
    </header>
  );
}

function BottomNav({ alerts }: { alerts: number }) {
  const path = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Primary">
      <ul className="grid grid-cols-5">
        {TABS.map((t) => {
          const active = t.href === "/" ? path === "/" || path.startsWith("/asteroid") : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} className={`relative flex flex-col items-center gap-0.5 py-2 text-[10px] tracking-wider ${active ? "text-accent" : "text-muted"}`} aria-current={active ? "page" : undefined}>
                <span aria-hidden className="text-base leading-none">{t.icon}</span>
                {t.label}
                {t.href === "/alerts" && alerts > 0 && <span className="num absolute right-[22%] top-1 rounded-full bg-crit px-1 text-[9px] font-bold text-white">{alerts}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function DesktopTabs() {
  const path = usePathname();
  return (
    <nav className="hidden border-b border-line bg-panel px-5 lg:block" aria-label="Sections">
      <ul className="flex gap-1">
        {TABS.map((t) => {
          const active = t.href === "/" ? path === "/" || path.startsWith("/asteroid") : path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} className={`inline-block border-b-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] ${active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink2"}`}>
                {t.label === "Home" ? "Home PC & Settings" : t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const live = useLive();
  const { send, outbox } = useCommands();
  const now = useNow();
  const d = live.dashboard;
  const activeAlerts = d?.alerts.filter((a) => a.status === "active" && !a.dismissed && a.severity !== "INFO").length ?? 0;
  return (
    <LiveCtx.Provider value={{ live, send, outbox, now }}>
      <div className="flex min-h-screen flex-col">
        <div className="hidden lg:block">
          <Header s={d} now={now} linkUp={live.link === "live"} />
        </div>
        <MobileTop live={live} now={now} />
        <DesktopTabs />
        <LinkBanner live={live} now={now} />
        <Banners s={d} />
        <div className="flex min-h-0 flex-1 flex-col pb-20 lg:pb-0">{children}</div>
        <BottomNav alerts={activeAlerts} />
      </div>
    </LiveCtx.Provider>
  );
}
