/**
 * Branch tests for the policy gate.
 *
 * The ceiling is the one guarantee the README makes out loud, so it gets the
 * boundary cases rather than a single happy-path assertion. Run with:
 *   node --test --experimental-strip-types src/policy.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  sessionLimitFromEnv,
  toolCostLimitFromEnv,
  DEFAULT_TOOL_COST_LIMIT_MICRO_USD,
  type PolicyContext,
} from "./policy.ts";

/** A call that should sail through, so each test varies one field from sane. */
function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: "anuma_respond",
    keyMode: "live",
    estimatedCredits: 1,
    sessionSpend: 0,
    sessionLimit: 100,
    ...over,
  };
}

test("reads are allowed, and are allowed even with no key and no budget left", () => {
  for (const tool of ["anuma_health", "anuma_list_models", "anuma_credits_balance"]) {
    assert.deepEqual(evaluate(ctx({ tool, estimatedCredits: 0 })), { verdict: "allow" });
    // A read cannot spend, so neither an exhausted ceiling nor a missing key is
    // a reason to block it.
    const starved = evaluate(ctx({ tool, keyMode: "none", estimatedCredits: 0, sessionSpend: 999 }));
    assert.equal(starved.verdict, "allow");
  }
});

test("redeem_tokens always escalates, regardless of key mode or remaining budget", () => {
  for (const keyMode of ["live", "test", "none"] as const) {
    const d = evaluate(ctx({ tool: "anuma_redeem_tokens", keyMode, estimatedCredits: 0 }));
    assert.equal(d.verdict, "escalate", `keyMode=${keyMode} should still escalate`);
  }
});

test("spending with no key is refused rather than attempted", () => {
  const d = evaluate(ctx({ keyMode: "none" }));
  assert.equal(d.verdict, "refuse");
  assert.match((d as { reason: string }).reason, /ANUMA_API_KEY/);
});

test("the ceiling holds, and holds for test keys too so the limit is testable", () => {
  for (const keyMode of ["live", "test"] as const) {
    const over = evaluate(ctx({ keyMode, sessionSpend: 100, estimatedCredits: 1, sessionLimit: 100 }));
    assert.equal(over.verdict, "refuse", `keyMode=${keyMode} should refuse over the ceiling`);
  }
});

test("the ceiling boundary: landing exactly on the limit is allowed, one past is not", () => {
  // The rule is `spend + estimate > limit`, so exact equality must pass.
  assert.equal(evaluate(ctx({ sessionSpend: 99, estimatedCredits: 1, sessionLimit: 100 })).verdict, "allow");
  assert.equal(evaluate(ctx({ sessionSpend: 99, estimatedCredits: 2, sessionLimit: 100 })).verdict, "refuse");
});

test("a zero limit refuses every spend but still permits reads", () => {
  assert.equal(evaluate(ctx({ sessionLimit: 0 })).verdict, "refuse");
  assert.equal(evaluate(ctx({ tool: "anuma_usage", estimatedCredits: 0, sessionLimit: 0 })).verdict, "allow");
});

test("unknown tools are refused, not allowed by default", () => {
  // The regression that matters: an unclassified tool is scored at 0 credits, so
  // a fall-through `allow` would let it run free and unbudgeted forever.
  for (const tool of ["anuma_transfer_everything", "anuma_respond_v2", "typo_anuma_respnd"]) {
    const d = evaluate(ctx({ tool, estimatedCredits: 0 }));
    assert.equal(d.verdict, "refuse", `${tool} must not fall through to allow`);
    assert.match((d as { reason: string }).reason, /unknown tool/);
  }
});

test("a classified inference call under budget is allowed", () => {
  assert.deepEqual(evaluate(ctx()), { verdict: "allow" });
});

test("sessionLimitFromEnv defaults to 100 and rejects junk", () => {
  const original = process.env.ANUMA_SESSION_CREDIT_LIMIT;
  try {
    delete process.env.ANUMA_SESSION_CREDIT_LIMIT;
    assert.equal(sessionLimitFromEnv(), 100);

    process.env.ANUMA_SESSION_CREDIT_LIMIT = "250";
    assert.equal(sessionLimitFromEnv(), 250);

    // Zero is a meaningful choice (refuse all spend), not junk.
    process.env.ANUMA_SESSION_CREDIT_LIMIT = "0";
    assert.equal(sessionLimitFromEnv(), 0);

    for (const junk of ["banana", "-5", ""]) {
      process.env.ANUMA_SESSION_CREDIT_LIMIT = junk;
      assert.equal(sessionLimitFromEnv(), 100, `"${junk}" should fall back to the default`);
    }
  } finally {
    if (original === undefined) delete process.env.ANUMA_SESSION_CREDIT_LIMIT;
    else process.env.ANUMA_SESSION_CREDIT_LIMIT = original;
  }
});

test("a call that can reach an expensive server-side tool escalates", () => {
  // anuma_create_video is 2,400,000 micro-USD. $2.40, from one English sentence.
  const d = evaluate(ctx({ worstCaseToolMicroUsd: 2_400_000 }));
  assert.equal(d.verdict, "escalate");
  assert.match(d.prompt, /\$2\.4000/);
});

test("cheap tools run unattended, and the boundary is inclusive", () => {
  // Search, weather, market data and predictions all sit at or under the limit.
  for (const cost of [0, 1_000, 5_000, 20_000]) {
    assert.equal(evaluate(ctx({ worstCaseToolMicroUsd: cost })).verdict, "allow", `cost ${cost}`);
  }
  assert.equal(evaluate(ctx({ worstCaseToolMicroUsd: 20_001 })).verdict, "escalate");
});

test("tools off is always allowed, however expensive the registry gets", () => {
  assert.equal(evaluate(ctx({ worstCaseToolMicroUsd: 0 })).verdict, "allow");
  // Omitting the field entirely must mean the same thing as zero, not "unknown".
  const bare = { ...ctx() };
  delete (bare as Partial<PolicyContext>).worstCaseToolMicroUsd;
  assert.equal(evaluate(bare).verdict, "allow");
});

test("an explicit tool-cost limit overrides the default in both directions", () => {
  // Raised: the video tool becomes routine.
  assert.equal(
    evaluate(ctx({ worstCaseToolMicroUsd: 2_400_000, toolCostLimitMicroUsd: 3_000_000 })).verdict,
    "allow",
  );
  // Zeroed: every tool with any cost needs a human.
  assert.equal(
    evaluate(ctx({ worstCaseToolMicroUsd: 1, toolCostLimitMicroUsd: 0 })).verdict,
    "escalate",
  );
});

test("the tool-cost gate sits ahead of the session ceiling, so the reason names the real cause", () => {
  // Both limits are blown. The expensive-tool escalation is the more
  // actionable answer, and an escalation can be approved where a refusal
  // cannot, so it must win.
  const d = evaluate(ctx({ worstCaseToolMicroUsd: 2_400_000, sessionSpend: 999, sessionLimit: 1 }));
  assert.equal(d.verdict, "escalate");
});

test("toolCostLimitFromEnv defaults to $0.02 and rejects junk", () => {
  const prev = process.env.ANUMA_MAX_TOOL_COST_MICRO_USD;
  delete process.env.ANUMA_MAX_TOOL_COST_MICRO_USD;
  assert.equal(toolCostLimitFromEnv(), DEFAULT_TOOL_COST_LIMIT_MICRO_USD);
  assert.equal(DEFAULT_TOOL_COST_LIMIT_MICRO_USD, 20_000);
  process.env.ANUMA_MAX_TOOL_COST_MICRO_USD = "not-a-number";
  assert.equal(toolCostLimitFromEnv(), DEFAULT_TOOL_COST_LIMIT_MICRO_USD);
  process.env.ANUMA_MAX_TOOL_COST_MICRO_USD = "0";
  assert.equal(toolCostLimitFromEnv(), 0, "an explicit zero is a real limit, not junk");
  if (prev === undefined) delete process.env.ANUMA_MAX_TOOL_COST_MICRO_USD;
  else process.env.ANUMA_MAX_TOOL_COST_MICRO_USD = prev;
});
