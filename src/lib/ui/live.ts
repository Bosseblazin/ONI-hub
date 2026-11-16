"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardState } from "../model/types";
import type { CommandType, OpsState } from "../ops/types";

export type LinkState = "connecting" | "live" | "home-unreachable" | "device-offline";

export interface LiveData {
  dashboard: DashboardState | null;
  ops: OpsState | null;
  link: LinkState;
  /** Wall-clock ms of the last message received from the home PC (this device's view). */
  lastSyncAt: number | null;
  /** True when showing a cached copy because the home PC can't be reached. */
  fromCache: boolean;
}

const CACHE_KEY = "ic:last-state";

function loadCache(): { at: number; dashboard: DashboardState; ops: OpsState } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as { at: number; dashboard: DashboardState; ops: OpsState }) : null;
  } catch {
    return null;
  }
}

function saveCache(dashboard: DashboardState, ops: OpsState) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), dashboard, ops }));
  } catch {
    /* storage full / private mode — non-essential */
  }
}

function toLogin() {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
}

/**
 * Live state from the home PC over SSE. Redirects to /login when the session is missing or revoked.
 * If the home PC becomes unreachable, keeps showing the last known state, clearly flagged as such.
 */
export function useLive(): LiveData {
  const [d, setD] = useState<LiveData>({ dashboard: null, ops: null, link: "connecting", lastSyncAt: null, fromCache: false });
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const cached = loadCache();
    if (cached) setD({ dashboard: cached.dashboard, ops: cached.ops, link: "connecting", lastSyncAt: cached.at, fromCache: true });

    const lost = async () => {
      if (stopped) return;
      let link: LinkState = "home-unreachable";
      if (typeof navigator !== "undefined" && navigator.onLine === false) link = "device-offline";
      else {
        try {
          const r = await fetch("/api/auth/session", { cache: "no-store" });
          if (r.ok) {
            const s = (await r.json()) as { authenticated: boolean };
            if (!s.authenticated) return toLogin();
            link = "connecting"; // server reachable; the stream will reopen
          }
        } catch {
          /* unreachable */
        }
      }
      setD((p) => ({ ...p, link, fromCache: link !== "connecting" ? true : p.fromCache }));
      retry = setTimeout(open, link === "connecting" ? 1000 : 5000);
    };

    const open = async () => {
      if (stopped) return;
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store" });
        const s = (await r.json()) as { authenticated: boolean };
        if (!s.authenticated) return toLogin();
      } catch {
        return lost();
      }
      es = new EventSource("/api/stream");
      es.addEventListener("state", (e) => {
        try {
          const { dashboard, ops } = JSON.parse((e as MessageEvent<string>).data) as { dashboard: DashboardState; ops: OpsState };
          saveCache(dashboard, ops);
          setD({ dashboard, ops, link: "live", lastSyncAt: Date.now(), fromCache: false });
        } catch {
          /* malformed frame */
        }
      });
      es.addEventListener("auth", () => toLogin());
      es.onerror = () => {
        es?.close();
        void lost();
      };
    };
    void open();
    const onOnline = () => {
      if (retry) clearTimeout(retry);
      es?.close();
      void open();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", () => setD((p) => ({ ...p, link: "device-offline", fromCache: true })));
    return () => {
      stopped = true;
      es?.close();
      if (retry) clearTimeout(retry);
      window.removeEventListener("online", onOnline);
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
