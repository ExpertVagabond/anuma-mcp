/**
 * Policy layer: decides what an outside agent may do against a user's Anuma
 * account without a human in the loop.
 *
 * This is the part that makes anuma-mcp different from a thin API wrapper, and
 * it is the same thesis as the policy-gated signer: the agent operates inside
 * enforced limits and never holds the unconstrained credential. Anuma already
 * has the server-side half of this (`/api/v1/user/agent-grants`,
 * `/api/v1/user/agent-consents`). This is the client-side half, so the limit
 * holds even when the agent is the one composing the calls.
 *
 * Three outcomes, borrowed from the signer:
 *   allow     run it now
 *   escalate  return a confirmation prompt to the human, run only on approval
 *   refuse    never, regardless of approval
 */

export type Decision =
  | { verdict: "allow" }
  | { verdict: "escalate"; prompt: string }
  | { verdict: "refuse"; reason: string };

export interface PolicyContext {
  /** MCP tool being invoked, e.g. "anuma_respond". */
  tool: string;
  /** `live` keys bill real credits, `test` keys do not. */
  keyMode: "live" | "test" | "none";
  /** Credits this call is estimated to spend. 0 for reads. */
  estimatedCredits: number;
  /** Credits already spent by this MCP session. */
  sessionSpend: number;
  /** Hard ceiling for one session, from ANUMA_SESSION_CREDIT_LIMIT. */
  sessionLimit: number;
}

/** Tools that only read. Never spend, never mutate. */
export const READ_ONLY_TOOLS = new Set([
  "anuma_health",
  "anuma_list_models",
  "anuma_credits_balance",
  "anuma_zeta_rate",
  "anuma_list_tools",
  "anuma_agent_grants",
  "anuma_usage",
]);

/** Tools that move value or change account state. */
export const MUTATING_TOOLS = new Set(["anuma_respond", "anuma_redeem_tokens"]);

/**
 * TODO(matthew): implement the decision rule. This is the design call that
 * shapes how the whole server feels, so I have left it to you rather than
 * picking a default.
 *
 * The trade-off, concretely:
 *
 *   Permissive  every read allowed, inference allowed up to the session limit,
 *               only `anuma_redeem_tokens` escalates. The demo flows: an agent
 *               genuinely runs on Anuma memory with no babysitting. But a
 *               runaway loop burns real credits against a `live` key, and that
 *               is the exact failure mode the signer work exists to prevent.
 *
 *   Strict      anything spending on a `live` key escalates. Safe, and it
 *               demos the guarantee clearly, but a human is tapped on the
 *               shoulder for every single inference call, which reads as
 *               friction rather than as a feature.
 *
 * Things worth weighing: `keyMode === "test"` spends nothing, so it can
 * probably be permissive regardless. `redeem_tokens` converts ZETA and is
 * irreversible. `sessionSpend + estimatedCredits > sessionLimit` is the
 * backstop that has to hold no matter what else is decided.
 *
 * Roughly 5 to 10 lines. Return one of the three Decision shapes above.
 */
export function evaluate(ctx: PolicyContext): Decision {
  throw new Error("policy.evaluate not implemented, see TODO above");
}

/** Reads the session ceiling. Defaults low on purpose: a demo should not be able to run up a bill. */
export function sessionLimitFromEnv(): number {
  const raw = process.env.ANUMA_SESSION_CREDIT_LIMIT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 100;
}
