/**
 * Dry-run against the real API before wiring anything into an agent.
 * Runs without a key (health, models) and exercises the authed endpoints
 * if ANUMA_API_KEY is set.
 *
 *   node --experimental-strip-types src/probe.ts
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

if (client.keyMode === "none") {
  console.log("\nNo ANUMA_API_KEY set, so the 401s above are expected.");
  console.log("Create an app at https://dashboard.anuma.ai, Auth tab, add an API key.");
}
