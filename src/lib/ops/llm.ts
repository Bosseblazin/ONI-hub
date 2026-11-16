import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export const OPS_MODEL = process.env.OPS_MODEL || process.env.ADVISOR_MODEL || "claude-opus-5-5";

export function claudeConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

export interface LlmCall<T> {
  purpose: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Commander-initiated calls may exceed the hourly cap by a small reserve so instructions are never starved by background analysis. */
  priority: "commander" | "background";
}

export interface LlmResult<T> {
  data: T;
  servedBy: string;
  inputTokens: number;
  outputTokens: number;
}

/** Anything that can answer a structured prompt — Claude in production, a fake in tests. */
export interface StructuredLlm {
  readonly name: string;
  readonly simulated: boolean;
  available(): boolean;
  call<T>(c: LlmCall<T>): Promise<LlmResult<T>>;
}

export class RateLimitedError extends Error {}

/**
 * Claude via the official SDK: structured outputs (zod), adaptive thinking, server-side refusal fallback.
 * Enforces an hourly call budget so continuous monitoring can't run up an unbounded bill.
 */
export class ClaudeGateway implements StructuredLlm {
  readonly name = OPS_MODEL;
  readonly simulated = false;
  private client: Anthropic | null = null;
  private calls: number[] = [];
  lastSuccessAt: number | null = null;
  lastError: string | null = null;

  constructor(private maxPerHour: () => number) {}

  available(): boolean {
    return claudeConfigured();
  }

  callsLastHour(now = Date.now()): number {
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    return this.calls.length;
  }

  async call<T>(c: LlmCall<T>): Promise<LlmResult<T>> {
    if (!this.available()) throw new Error("Claude is not configured (set ANTHROPIC_API_KEY on the home PC).");
    const cap = this.maxPerHour() + (c.priority === "commander" ? 10 : 0);
    if (this.callsLastHour() >= cap) throw new RateLimitedError(`Hourly Claude budget reached (${cap} calls); ${c.purpose} postponed.`);
    this.calls.push(Date.now());
    this.client ??= new Anthropic();
    try {
      const msg = await this.client.beta.messages.parse({
        model: OPS_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: betaZodOutputFormat(c.schema) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: c.system,
        messages: [{ role: "user", content: c.user }],
      });
      if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
      if (msg.stop_reason === "max_tokens") throw new Error("Claude's response was truncated.");
      const data = msg.parsed_output as T | null;
      if (data === null || data === undefined) throw new Error("Claude returned output that did not match the expected structure.");
      this.lastSuccessAt = Date.now();
      this.lastError = null;
      return { data, servedBy: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
    } catch (e) {
      let m: string;
      if (e instanceof Anthropic.AuthenticationError) m = "Anthropic API rejected the credentials.";
      else if (e instanceof Anthropic.RateLimitError) m = "Rate limited by the Anthropic API.";
      else if (e instanceof Anthropic.APIConnectionError) m = "Cannot reach the Anthropic API from the home PC.";
      else if (e instanceof Anthropic.APIError) m = `Anthropic API error ${e.status ?? ""}: ${e.message}`;
      else m = (e as Error).message;
      this.lastError = m;
      throw new Error(m);
    }
  }
}
