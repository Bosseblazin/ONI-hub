/**
 * Minimal, READ-ONLY MCP Streamable-HTTP client for OniMcp.
 *
 * Safety model (Version 1 is strictly read-only):
 *  - Only the JSON-RPC methods in ALLOWED_METHODS can ever be sent. `tools/call`
 *    (the only path through which OniMcp mutates the game) is rejected locally
 *    before any network I/O happens.
 *  - `resources/read` is further restricted to the read-only URI allowlist in
 *    ./readonly.ts. Query parameters are filters only; OniMcp itself strips
 *    `confirm`, `force`, `domain` and `action` from resource query strings, and
 *    we reject them here too as defence in depth.
 */
import { assertReadOnlyUri } from "./readonly";
import { McpError } from "./errors";
export { McpError } from "./errors";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export const ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface McpClientOptions {
  url: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Extract JSON-RPC messages from either application/json or text/event-stream bodies. */
export function parseRpcBody(contentType: string, body: string): JsonRpcResponse[] {
  if (contentType.includes("text/event-stream")) {
    const out: JsonRpcResponse[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        out.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        /* ignore keep-alive / malformed frames */
      }
    }
    return out;
  }
  if (!body.trim()) return [];
  const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class OniMcpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private info: ServerInfo | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: McpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get serverInfo(): ServerInfo | null {
    return this.info;
  }

  get connected(): boolean {
    return this.sessionId !== null;
  }

  reset(): void {
    this.sessionId = null;
    this.info = null;
  }

  private async post(method: string, params: unknown, isNotification = false): Promise<JsonRpcResponse | null> {
    if (!ALLOWED_METHODS.has(method)) {
      throw new McpError(`Blocked: method "${method}" is not permitted in read-only mode`, "blocked");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (method !== "initialize") {
      if (!this.sessionId) throw new McpError("No MCP session", "session");
      headers["Mcp-Session-Id"] = this.sessionId;
      headers["Mcp-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    }
    if (this.opts.token) headers["Authorization"] = `Bearer ${this.opts.token}`;

    const id = isNotification ? undefined : this.nextId++;
    const payload = isNotification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        cache: "no-store",
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      throw new McpError(
        aborted ? `Timed out after ${this.timeoutMs} ms (${method})` : `Cannot reach OniMcp: ${(e as Error).message}`,
        aborted ? "timeout" : "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new McpError("OniMcp rejected the token (check ONI_MCP_TOKEN / AuthEnabled)", "auth", res.status);
    }
    if (method === "initialize") {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }
    const text = await res.text();
    if (res.status === 404 && method !== "initialize") {
      // Session expired or game restarted the server.
      this.reset();
      throw new McpError("MCP session expired", "session", 404);
    }
    if (isNotification) return null;
    let messages: JsonRpcResponse[];
    try {
      messages = parseRpcBody(res.headers.get("content-type") ?? "", text);
    } catch {
      throw new McpError(`Invalid JSON from OniMcp (HTTP ${res.status})`, "protocol", res.status);
    }
    const msg = messages.find((m) => m.id === id) ?? messages[0];
    if (!msg) throw new McpError(`Empty response (HTTP ${res.status})`, "protocol", res.status);
    if (msg.error) {
      if (/session/i.test(msg.error.message) && method !== "initialize") this.reset();
      throw new McpError(`${msg.error.message} (code ${msg.error.code})`, "rpc", res.status);
    }
    if (!res.ok) throw new McpError(`HTTP ${res.status}`, "http", res.status);
    return msg;
  }

  async connect(): Promise<ServerInfo> {
    this.reset();
    const msg = await this.post("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "interplanetary-command", version: "0.1.0" },
    });
    const r = (msg?.result ?? {}) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
    if (!this.sessionId) throw new McpError("OniMcp did not issue an Mcp-Session-Id", "protocol");
    this.info = {
      name: r.serverInfo?.name ?? "unknown",
      version: r.serverInfo?.version ?? "unknown",
      protocolVersion: r.protocolVersion ?? "unknown",
    };
    await this.post("notifications/initialized", {}, true);
    return this.info;
  }

  async ensureConnected(): Promise<void> {
    if (!this.sessionId) await this.connect();
  }

  /** Read a resource and return its parsed JSON text. Throws McpError on failure. */
  async readJson(uri: string): Promise<unknown> {
    assertReadOnlyUri(uri);
    await this.ensureConnected();
    let msg: JsonRpcResponse | null;
    try {
      msg = await this.post("resources/read", { uri });
    } catch (e) {
      if (e instanceof McpError && e.kind === "session") {
        await this.connect();
        msg = await this.post("resources/read", { uri });
      } else throw e;
    }
    const contents = (msg?.result as { contents?: Array<{ text?: string }> } | undefined)?.contents;
    const text = contents?.[0]?.text;
    if (typeof text !== "string") throw new McpError(`Resource ${uri} returned no text content`, "protocol");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new McpError(`Resource ${uri} did not return JSON`, "protocol");
    }
    if (data && typeof data === "object" && !Array.isArray(data) && (data as { error?: unknown }).error === true) {
      const m = String((data as { message?: unknown }).message ?? "unknown error");
      throw new McpError(`${uri}: ${m}`, "rpc");
    }
    return data;
  }

  async listResources(): Promise<Array<{ uri: string; name?: string }>> {
    await this.ensureConnected();
    const msg = await this.post("resources/list", {});
    return ((msg?.result as { resources?: Array<{ uri: string; name?: string }> })?.resources ?? []).slice();
  }

  async listTemplates(): Promise<Array<{ uriTemplate: string; name?: string }>> {
    await this.ensureConnected();
    const msg = await this.post("resources/templates/list", {});
    return ((msg?.result as { resourceTemplates?: Array<{ uriTemplate: string }> })?.resourceTemplates ?? []).slice();
  }
}
