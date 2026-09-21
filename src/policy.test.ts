/**
 * Branch tests for the policy gate.
 *
 * The ceiling is the one guarantee the README makes out loud, so it gets the
 * boundary cases rather than a single happy-path assertion. Run with:
 *   node --test --experimental-strip-types src/policy.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, sessionLimitFromEnv, type PolicyContext } from "./policy.ts";

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
