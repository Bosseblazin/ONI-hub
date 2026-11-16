"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardState } from "../model/types";
import type { CommandType, OpsState } from "../ops/types";
import type { RelayCommandStatus, RelayStatus } from "../relay/protocol";

/**
 * - live: fresh data from the home agent
 * - home-offline: the service answers but the home agent has stopped syncing (PC off, asleep, agent stopped, home internet down)
 * - service-unreachable: this device cannot reach the dashboard service (Vercel or the local server)
 * - device-offline: this device has no network
 */
export type LinkState = "connecting" | "live" | "home-offline" | "service-unreachable" | "device-offline";

export interface LiveData {
  dashboard: DashboardState | null;
  ops: OpsState | null;
  relay: RelayStatus | null;
  relayCommands: RelayCommandStatus[];
  link: LinkState;
  /** When this device last received a response from the service. */
  lastSyncAt: number | null;
  /** True when showing a cached copy because the service can't be reached. */
  fromCache: boolean;
}

interface StatePayload {
  dashboard: DashboardState | null;
  ops: OpsState | null;
  relay: RelayStatus;
  relayCommands: RelayCommandStatus[];
}

const CACHE_KEY = "ic:last-state";

function loadCache(): ({ at: number } & StatePayload) | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as { at: number } & StatePayload) : null;
  } catch {
    return null;
  }
}

function saveCache(p: StatePayload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ...p }));
  } catch {
    /* storage full / private mode — non-essential */
  }
}

function toLogin() {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
}

const VISIBLE_MS = 3000;
const HIDDEN_MS = 20_000;

/**
 * Live state by polling /api/state (works identically on Vercel and on the home server, and survives
 * iOS Safari suspending background tabs). Redirects to /login on 401. Keeps showing the last known state,
 * clearly flagged, when the service or the home PC is unreachable.
 */
export function useLive(): LiveData {
  const [d, setD] = useState<LiveData>({ dashboard: null, ops: null, relay: null, relayCommands: [], link: "connecting", lastSyncAt: null, fromCache: false });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    const cached = loadCache();
    if (cached) setD({ dashboard: cached.dashboard, ops: cached.ops, relay: cached.relay, relayCommands: cached.relayCommands ?? [], link: "connecting", lastSyncAt: cached.at, fromCache: true });

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, document.visibilityState === "visible" ? VISIBLE_MS : HIDDEN_MS);
    };

    const poll = async () => {
      if (stopped || inflight) return;
      inflight = true;
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        if (r.status === 401) return toLogin();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const p = (await r.json()) as StatePayload;
        saveCache(p);
        setD({
          dashboard: p.dashboard,
          ops: p.ops,
          relay: p.relay,
          relayCommands: p.relayCommands ?? [],
          link: p.relay.agentOnline && p.dashboard ? "live" : "home-offline",
          lastSyncAt: Date.now(),
          fromCache: false,
        });
      } catch {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        setD((x) => ({ ...x, link: offline ? "device-offline" : "service-unreachable", fromCache: true }));
      } finally {
        inflight = false;
        schedule();
      }
    };

    void poll();
    const wake = () => {
      if (document.visibilityState === "visible") void poll();
      else schedule();
    };
    const offline = () => setD((x) => ({ ...x, link: "device-offline", fromCache: true }));
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", wake);
    };
  }, []);
  return d;
}


/* ------------------------------------------------------------- command outbox */

export interface OutboxItem {
  clientId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  clientCreatedAt: number;
  attempts: number;
  lastError: string | null;
  /** Set once the home PC acknowledged receipt. */
  ackedAt: number | null;
}

const OUTBOX_KEY = "ic:outbox";

function readOutbox(): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as OutboxItem[];
  } catch {
    return [];
  }
}
function writeOutbox(items: OutboxItem[]) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-100)));
  } catch {
    /* ignore */
  }
}

export function newClientId(): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `c-${rnd.replace(/[^A-Za-z0-9-]/g, "")}`;
}

/**
 * Durable, idempotent command sender. A command is written to the device's outbox first, then sent;
 * on network failure it stays queued and is retried with the SAME clientId, so the home PC can
 * never process it twice. Acknowledged items leave the outbox.
 */
export function useCommands() {
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      let items = readOutbox();
      for (const it of items.filter((x) => !x.ackedAt)) {
        try {
          const r = await fetch("/api/commands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientId: it.clientId, type: it.type, payload: it.payload, clientCreatedAt: it.clientCreatedAt }),
          });
          if (r.status === 401) {
            it.lastError = "Signed out — sign in to send";
            continue;
          }
          if (r.status >= 400 && r.status < 500) {
            // Permanent rejection: drop it, but surface the reason once.
            const b = (await r.json().catch(() => ({}))) as { error?: string };
            it.lastError = `Rejected: ${b.error ?? r.status}`;
            it.ackedAt = Date.now();
            continue;
          }
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          it.ackedAt = Date.now();
          it.lastError = null;
        } catch (e) {
          it.attempts++;
          it.lastError = (e as Error).message;
        }
      }
      // Keep acknowledged items briefly so the UI can show "delivered", then drop them.
      items = items.filter((x) => !x.ackedAt || Date.now() - x.ackedAt < 30_000);
      writeOutbox(items);
      setOutbox(items);
    } finally {
      flushing.current = false;
    }
  }, []);

  useEffect(() => {
    setOutbox(readOutbox());
    void flush();
    const t = setInterval(() => void flush(), 5000);
    const on = () => void flush();
    window.addEventListener("online", on);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", on);
    };
  }, [flush]);

  const send = useCallback(
    (type: CommandType, payload: Record<string, unknown> = {}): string => {
      const item: OutboxItem = { clientId: newClientId(), type, payload, clientCreatedAt: Date.now(), attempts: 0, lastError: null, ackedAt: null };
      const items = [...readOutbox(), item];
      writeOutbox(items);
      setOutbox(items);
      void flush();
      return item.clientId;
    },
    [flush],
  );

  return { send, outbox, pending: outbox.filter((x) => !x.ackedAt) };
}
