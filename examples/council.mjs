// Council mode: one question, several models, one synthesis.
//
//   node examples/council.mjs          (needs ANUMA_API_KEY and a build)
//
// This is an example rather than a tool in the server, deliberately. It only
// composes anuma_respond, adds no API surface, and the seat list and synthesis
// prompt are editorial choices that belong to whoever is asking. Anything that
// can call anuma_respond in a loop already has this.
//
// Three things learned the hard way and encoded here:
//  1. Never cap max_output_tokens on a reasoning model. Its thinking length
//     varies per run, so a fixed cap silently returns an empty answer.
//  2. Avoid recency cues ("just voted") in the prompt. Models that want a
//     search tool will narrate reaching for one instead of answering.
//  3. Synthesise with a non-reasoning model for a predictable single pass.
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn("node", ["dist/index.js"], {
  cwd: "/Users/matthewkarsten/projects/anuma-mcp",
  stdio: ["pipe", "pipe", "inherit"], env: process.env,
});
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
rl.on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; }
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
let id = 0;
const send = (me, pa) => new Promise((r) => { const n = ++id; pending.set(n, r);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method: me, params: pa }) + "\n"); });
const call = (n, a) => send("tools/call", { name: n, arguments: a });
const J = (r) => { try { return JSON.parse(r.result.content[0].text); } catch { return {}; } };

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "council", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// Seats. Two models are deliberately absent: glm/glm-5.3 intermittently returns
// no text even uncapped, and inclusionai/ling-3.0-flash emits raw <tool_call>
// markup as visible prose when tools are off. Both are fine alone and bad on a
// panel, where one blank row reads as the whole thing being broken.
const COUNCIL = [
  "deepseek/deepseek-v4-flash",
  "minimax/minimax-m2.7",
  "qwen/qwen-3-235b",
  "qwen/qwen-3.6-max-preview",
  "openrouter/amazon/nova-2-lite-v1",
];
const Q =
  "Consider a layer-1 blockchain whose holders vote by 99.4% to shut down their own chain " +
  "and migrate the token onto a larger competitor's network. In ONE sentence: is abandoning " +
  "your own chain a sign of strength or of weakness? Begin with the single word STRENGTH or WEAKNESS.";

const verdict = (t) => /\b(STRENGTH|WEAKNESS)\b/i.exec(t || "")?.[1]?.toUpperCase() ?? "—";

const t0 = Date.now();
const seats = await Promise.all(COUNCIL.map(async (model) => {
  // A seat that errors must never render as an empty opinion. Retry once on a
  // transient, then report the failure as a failure.
  let res = await call("anuma_respond", { model, prompt: Q });
  let body = J(res);
  if (res.result?.isError && body.isRetryable) {
    res = await call("anuma_respond", { model, prompt: Q });
    body = J(res);
  }
  if (res.result?.isError) return { model, text: "", tokens: 0, error: body.message ?? "failed" };
  const text = (body.text || "").replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, "").replace(/\s+/g, " ").trim();
  return { model, text, tokens: body.usage?.total_tokens ?? 0, note: body.note };
}));
const fanout = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n=== COUNCIL: ${seats.length} models in parallel, ${fanout}s wall clock ===\n`);
for (const s of seats) {
  const flag = s.text ? "" : ` [${s.error ? "ERROR: " + s.error.slice(0, 44) : "empty: " + (s.note || "no text").slice(0, 30)}]`;
  console.log(`${verdict(s.text).padEnd(9)} ${s.model.padEnd(28)} ${s.text.slice(0, 104)}${flag}`);
}
const tally = seats.map((s) => verdict(s.text)).filter((v) => v !== "—")
  .reduce((a, v) => ((a[v] = (a[v] || 0) + 1), a), {});
console.log(`\nTALLY: ${JSON.stringify(tally)}   (${seats.filter((s) => s.text).length}/${seats.length} seats answered)`);

const brief = seats.filter((s) => s.text).map((s, i) => `Model ${i + 1} (${s.model}): ${s.text}`).join("\n");
const syn = J(await call("anuma_respond", {
  model: "openrouter/amazon/nova-2-lite-v1",
  prompt: `Independent models answered the same question. Say where they agree, where they split, and give the single strongest verdict. Under 70 words.\n\n${brief}`,
}));
console.log(`\n=== SYNTHESIS (openrouter/amazon/nova-2-lite-v1) ===\n${(syn.text || "").trim()}\n`);
console.log(`total tokens across ${seats.length + 1} calls: ${seats.reduce((n, s) => n + s.tokens, 0) + (syn.usage?.total_tokens ?? 0)}`);
child.kill();
