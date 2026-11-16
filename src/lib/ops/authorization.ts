import type { ActionCategory, ActionProposal, ActionRisk, PermissionLevel } from "./types";

/**
 * Action authorization policy.
 *
 * LEVEL 1 — OBSERVATION: Claude may observe, analyse, recommend and *propose*. Nothing executes.
 * LEVEL 2 — SUPERVISED EXECUTION: a proposal may execute only after explicit commander approval of
 *           that specific proposal.
 * LEVEL 3 — AUTHORIZED AUTONOMY: routine actions in categories the commander granted may execute
 *           without per-action approval. Elevated/destructive/critical actions always need approval;
 *           destructive and critical additionally need a typed confirmation.
 *
 * Invariants (all levels):
 *  - A strategic objective is never permission to act.
 *  - Execution requires the execution layer to be enabled. In this version it is not, so `decide`
 *    can never return `execute`.
 *  - Every decision is logged by the caller.
 */

export interface AuthorizationContext {
  level: PermissionLevel;
  executionLayerEnabled: boolean;
  /** Categories the commander granted for Level 3 autonomy. */
  grantedCategories: ActionCategory[];
  /** Commander approval for this exact proposal, if any. */
  approval: { proposalId: string; confirmationText?: string } | null;
}

export type AuthorizationDecision =
  | { verdict: "execute"; reason: string }
  | { verdict: "needs_approval"; reason: string; confirmationRequired: boolean }
  | { verdict: "deny"; reason: string };

export const CONFIRMATION_REQUIRED: ReadonlySet<ActionRisk> = new Set(["destructive", "critical"]);

/** Categories that can never be granted for autonomy, regardless of level. */
export const NEVER_AUTONOMOUS: ReadonlySet<ActionCategory> = new Set(["deconstruction", "rocketry", "printing_pod", "other"]);

export function confirmationPhrase(p: Pick<ActionProposal, "id">): string {
  return `CONFIRM ${p.id.slice(-6).toUpperCase()}`;
}

export function authorize(p: Pick<ActionProposal, "id" | "category" | "risk" | "status">, ctx: AuthorizationContext): AuthorizationDecision {
  if (p.status !== "proposed" && p.status !== "approved") return { verdict: "deny", reason: `Proposal is ${p.status}.` };
  if (ctx.level === 1) return { verdict: "deny", reason: "Permission level 1 (Observation): Claude may only recommend. Perform the action manually in-game." };
  if (!ctx.executionLayerEnabled) return { verdict: "deny", reason: "The execution layer is not enabled in this version. Perform the action manually in-game." };

  const needsConfirm = CONFIRMATION_REQUIRED.has(p.risk);
  const approved = ctx.approval?.proposalId === p.id;
  const confirmed = !needsConfirm || ctx.approval?.confirmationText === confirmationPhrase(p);

  if (approved && confirmed) return { verdict: "execute", reason: "Explicit commander approval for this proposal." };
  if (approved && !confirmed) return { verdict: "needs_approval", reason: `${p.risk} action: type "${confirmationPhrase(p)}" to confirm.`, confirmationRequired: true };

  if (ctx.level === 3 && p.risk === "routine" && !NEVER_AUTONOMOUS.has(p.category) && ctx.grantedCategories.includes(p.category)) {
    return { verdict: "execute", reason: `Routine ${p.category} action within a commander-granted autonomy category.` };
  }
  return { verdict: "needs_approval", reason: "Requires explicit commander approval.", confirmationRequired: needsConfirm };
}

/**
 * The execution layer. Deliberately unimplemented in v1: OniMcp writes go through `tools/call`, which
 * the read-only client refuses. A future implementation must: run OniMcp's dryRun, show the preview,
 * require the decision above to be `execute`, call with confirm=true, re-read state to verify, and
 * log every step.
 */
export async function executeProposal(): Promise<never> {
  throw new Error("Execution layer disabled: Interplanetary Command v1 is read-only.");
}
