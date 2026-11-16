"use client";
import { useEffect, useRef, useState } from "react";
import type { HistorySample } from "../model/types";

export function useHistory(worldId: number | null, refreshMs = 30_000, sinceCycles?: number): HistorySample[] {
  const [rows, setRows] = useState<HistorySample[]>([]);
  const since = useRef(sinceCycles);
  since.current = sinceCycles;
  useEffect(() => {
    if (worldId === null) return;
    let alive = true;
    const load = async () => {
      try {
        const q = since.current !== undefined ? `&sinceCycles=${since.current}` : "";
        const r = await fetch(`/api/history?world=${worldId}${q}`, { cache: "no-store" });
        if (r.ok && alive) setRows((await r.json()) as HistorySample[]);
      } catch {
        /* keep last */
      }
    };
    void load();
    const t = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [worldId, refreshMs]);
  return rows;
}

/** Re-render every `ms` so relative ages ("12 s ago") stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
