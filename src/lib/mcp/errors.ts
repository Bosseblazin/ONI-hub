export class McpError extends Error {
  constructor(
    message: string,
    public readonly kind: "network" | "http" | "protocol" | "rpc" | "auth" | "session" | "blocked" | "timeout",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}
