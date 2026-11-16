import { McpError } from "./errors";

/**
 * Resources this dashboard is permitted to read. Every entry was verified in the
 * OniMcp 0.2.6 source to be a pure read (no game state mutation).
 */
export const READONLY_RESOURCES = [
  "oni://colony/status",
  "oni://world/list",
  "oni://dupes",
  "oni://dupes/vitals",
  "oni://dupes/morale",
  "oni://dupes/status-check",
  "oni://power/summary",
  "oni://food/summary",
  "oni://resources/inventory",
  "oni://resources/food",
  "oni://thermal/summary",
  "oni://atmosphere/summary",
  "oni://atmosphere/breathability",
  "oni://fluid/liquid/summary",
  "oni://research/progress",
  "oni://colony/diagnostics",
  "oni://farming/crops",
] as const;

const ALLOWED = new Set<string>(READONLY_RESOURCES);
/** Query keys we allow (filters only). */
const ALLOWED_QUERY = new Set([
  "worldId",
  "limit",
  "includeStored",
  "visibleOnly",
  "includeDetails",
  "radius",
  "includeReachableSamples",
  "resource",
]);

export function assertReadOnlyUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new McpError(`Blocked: invalid resource URI ${uri}`, "blocked");
  }
  if (parsed.protocol !== "oni:") throw new McpError(`Blocked: non-oni URI ${uri}`, "blocked");
  const base = `oni://${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  if (!ALLOWED.has(base)) throw new McpError(`Blocked: ${base} is not on the read-only allowlist`, "blocked");
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key)) throw new McpError(`Blocked: query parameter "${key}" is not permitted`, "blocked");
  }
}

export function withQuery(base: string, q: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `${base}?${parts.join("&")}` : base;
}
