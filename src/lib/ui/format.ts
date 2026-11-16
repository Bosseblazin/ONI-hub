export const NA = "N/A";

export function kg(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} kt`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)} t`;
  return `${Math.round(n)} kg`;
}

export function kcal(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M kcal`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k kcal`;
  return `${Math.round(n)} kcal`;
}

export function watts(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(2)} kW`;
  return `${Math.round(n)} W`;
}

export function joules(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} MJ`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)} kJ`;
  return `${Math.round(n)} J`;
}

export function pct(n: number | null | undefined, d = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  return `${n.toFixed(d)}%`;
}

export function temp(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  return `${n.toFixed(1)} °C`;
}

export function cycles(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (n >= 100) return "100+ cy";
  return `${n.toFixed(n < 10 ? 1 : 0)} cy`;
}

export function age(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

export function clock(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Stable identity colour per world (fixed categorical order by world id, never by rank). */
export function worldColor(worldId: number): string {
  return `var(--s${(((worldId % 8) + 8) % 8) + 1})`;
}
