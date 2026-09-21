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
 * The rule below is deliberately not "writes are scary". It draws the line where
 * Anuma's own API draws it:
 *
 *   Reads are free. Nothing in the read set can spend or mutate, so an agent
 *   should be able to explore the model catalogue, tool registry, ZETA rate and
 *   usage history without asking anyone.
 *
 *   Test keys spend nothing, so inference on a `test` key is allowed up to the
 *   session ceiling. That is what makes the server usable for development.
 *
 *   Inference on a `live` key is allowed, but only under a hard ceiling. The
 *   failure this prevents is a runaway loop, not a single deliberate call, and
 *   escalating every completion would make the gate read as friction rather
 *   than as a guarantee.
 *
 *   `redeem_tokens` always escalates. It converts ZETA into credits and cannot
 *   be undone, so a human confirms regardless of key mode or remaining budget.
 *
 * The ceiling is the part that has to hold no matter what else is decided.
 */
export function evaluate(ctx: PolicyContext): Decision {
  if (READ_ONLY_TOOLS.has(ctx.tool)) return { verdict: "allow" };

  // Irreversible: burns ZETA. Always a human.
  if (ctx.tool === "anuma_redeem_tokens") {
    return {
      verdict: "escalate",
      prompt: "Redeeming converts ZETA into credits and cannot be reversed. Confirm the amount explicitly.",
    };
  }

  if (ctx.keyMode === "none") {
    return { verdict: "refuse", reason: "no ANUMA_API_KEY set, refusing to attempt a spend" };
  }

  // The backstop. Holds for live and test alike so the limit is testable.
  if (ctx.sessionSpend + ctx.estimatedCredits > ctx.sessionLimit) {
    return {
      verdict: "refuse",
      reason:
        `session credit ceiling reached: ${ctx.sessionSpend} spent, ` +
        `this call needs ${ctx.estimatedCredits}, limit ${ctx.sessionLimit}. ` +
        `Raise ANUMA_SESSION_CREDIT_LIMIT deliberately if that is intended.`,
    };
  }

  // Default-deny. A tool in neither set is one nobody has classified, and an
  // unclassified tool is exactly the one worth refusing: `estimateCredits`
  // scores it 0, so the ceiling above would wave it through for free.
  if (!MUTATING_TOOLS.has(ctx.tool)) {
    return {
      verdict: "refuse",
      reason: `unknown tool ${ctx.tool}: not in the policy's read or mutate set, so its cost is unknown. Classify it before allowing it.`,
    };
  }

  return { verdict: "allow" };
}

/** Reads the session ceiling. Defaults low on purpose: a demo should not be able to run up a bill. */
export function sessionLimitFromEnv(): number {
  const raw = process.env.ANUMA_SESSION_CREDIT_LIMIT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 100;
}
