/**
 * Dry-run against the real API before wiring anything into an agent.
 * Runs without a key (health, models) and exercises the authed endpoints
 * if ANUMA_API_KEY is set.
 *
 *   node --experimental-strip-types src/probe.ts
 *
 * Inference is the one call that costs money, so it is opt-in rather than
 * default: a harness called "probe" that quietly spends credits every time it
 * runs is a harness people stop running. Enable it deliberately.
 *
 *   ANUMA_PROBE_SPEND=1 node --experimental-strip-types src/probe.ts
 */

import { AnumaClient, AnumaError } from "./client.ts";

const client = new AnumaClient();

async function check(label: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    const s = JSON.stringify(out);
    console.log(`  ok    ${label.padEnd(22)} ${s.length > 110 ? s.slice(0, 110) + "..." : s}`);
  } catch (err) {
    if (err instanceof AnumaError) {
      console.log(`  ${err.status}   ${label.padEnd(22)} ${err.code}: ${err.message}`);
    } else {
      console.log(`  FAIL  ${label.padEnd(22)} ${(err as Error).message}`);
    }
  }
}

console.log(`anuma-mcp probe  key=${client.keyMode}\n`);

console.log("public:");
await check("health", () => client.health());
await check("models", async () => {
  const { data } = await client.listModels();
  return { count: data.length, sample: data.slice(0, 2).map((m) => m.id) };
});

console.log("\nauthenticated:");
await check("credits/balance", () => client.creditsBalance());
await check("zeta/credit-rate", () => client.zetaCreditRate());
await check("zeta/market", () => client.zetaMarket());
await check("tools", () => client.listTools());
await check("user/agent-grants", () => client.agentGrants());
await check("usage/by-modality", () => client.usageByModality());

// Opt-in, because it spends. One credit, roughly $0.001.
if (process.env.ANUMA_PROBE_SPEND === "1" && client.keyMode !== "none") {
  const model = process.env.ANUMA_PROBE_MODEL ?? "openrouter/amazon/nova-2-lite-v1";
  console.log(`\ninference (spends credits, model=${model}):`);
  await check("responses", async () => {
    const out = (await client.respond({
      model,
      input: "Reply with exactly the word: ok",
    })) as { output?: Array<{ content?: Array<{ text?: string }> }>; usage?: unknown };
    // Assert on what the model actually said. A 200 with a well-formed body is
    // not evidence the prompt arrived -- sending `messages` instead of `input`
    // returns exactly that, addressed to an empty prompt.
    const said = out.output?.[0]?.content?.[0]?.text ?? "";
    if (!said.toLowerCase().includes("ok")) {
      throw new Error(`prompt did not reach the model, got: ${JSON.stringify(said).slice(0, 80)}`);
    }
    return { said, usage: out.usage };
  });
} else if (client.keyMode !== "none") {
  console.log("\ninference: skipped. Set ANUMA_PROBE_SPEND=1 to spend one credit on it.");
}

if (client.keyMode === "none") {
  console.log("\nNo ANUMA_API_KEY set, so the 401s above are expected.");
  console.log("Create an app at https://dashboard.anuma.ai, Auth tab, add an API key.");
}
