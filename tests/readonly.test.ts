import { describe, expect, it } from "vitest";
import { assertReadOnlyUri, withQuery } from "@/lib/mcp/readonly";
import { OniMcpClient, parseRpcBody } from "@/lib/mcp/client";

describe("read-only guard", () => {
  it("allows allowlisted resources with filter params", () => {
    expect(() => assertReadOnlyUri(withQuery("oni://power/summary", { worldId: 2 }))).not.toThrow();
    expect(() => assertReadOnlyUri("oni://colony/status")).not.toThrow();
  });
  it("blocks unknown resources", () => {
    expect(() => assertReadOnlyUri("oni://tasks/list")).toThrow(/allowlist/);
    expect(() => assertReadOnlyUri("http://evil/x")).toThrow(/non-oni/);
  });
  it("blocks operation selectors and confirmations in the query", () => {
    expect(() => assertReadOnlyUri("oni://power/summary?confirm=true")).toThrow(/confirm/);
    expect(() => assertReadOnlyUri("oni://colony/status?action=set")).toThrow(/action/);
    expect(() => assertReadOnlyUri("oni://colony/status?domain=x")).toThrow(/domain/);
  });
  it("never sends tools/call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const c = new OniMcpClient({ url: "http://x/mcp/", fetchImpl });
    // @ts-expect-error -- deliberately calling the private transport with a forbidden method
    await expect(c.post("tools/call", { name: "game_control" })).rejects.toThrow(/Blocked/);
    expect(calls).toBe(0);
  });
});

describe("parseRpcBody", () => {
  it("parses plain JSON", () => {
    expect(parseRpcBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}')[0]!.id).toBe(1);
  });
  it("parses SSE frames", () => {
    const body = ': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
    expect(parseRpcBody("text/event-stream", body)[0]!.id).toBe(7);
  });
});
