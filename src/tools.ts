/**
 * Anuma's tool registry, made usable.
 *
 * `GET /api/v1/tools` returns 42 tools and **1.78 MB** of JSON, because every
 * entry carries a 4096-dimension embedding that Anuma uses for its own
 * semantic tool search. Handing that to an agent is roughly 450k tokens and
 * blows any context window. Stripping the embeddings leaves ~6 KB: a 294x
 * reduction for no loss of anything a caller can act on.
 *
 * The registry also carries the one number the policy layer needs. Tool costs
 * span 0 to 2,400,000 micro-USD -- a single `anuma_create_video` call is
 * $2.40, roughly 240x what a plain completion costs. Any gate that prices
 * inference at a flat rate is wrong by that factor the moment tools are on.
 */

import type { AnumaClient, AnumaToolSchema } from "./client.js";

export interface RegistryTool {
  name: string;
  description: string;
  /** Cost in micro-USD. 1_000_000 = $1.00. */
  costMicroUsd: number;
  parameters: Record<string, unknown>;
}

interface RawRegistry {
  checksum?: string;
  tools: Record<
    string,
    { name: string; cost?: number; schema: { name: string; description?: string; parameters?: Record<string, unknown> } }
  >;
}

/**
 * Cached for the process lifetime. The registry is keyed by a checksum Anuma
 * publishes, it is 1.78 MB on the wire, and a long-lived MCP server would
 * otherwise re-download it on every call.
 */
let cache: { checksum: string; tools: RegistryTool[] } | null = null;

export async function loadRegistry(client: AnumaClient): Promise<RegistryTool[]> {
  if (cache) return cache.tools;
  const raw = (await client.listTools()) as RawRegistry;
  const tools = Object.values(raw.tools ?? {}).map((t) => ({
    name: t.schema?.name ?? t.name,
    description: t.schema?.description ?? "",
    costMicroUsd: t.cost ?? 0,
    parameters: t.schema?.parameters ?? { type: "object", properties: {} },
  }));
  cache = { checksum: raw.checksum ?? "", tools };
  return tools;
}

/** The flat schema shape the API accepts. The nested `function` wrapper is rejected. */
export function toSchema(t: RegistryTool): AnumaToolSchema {
  return { type: "function", name: t.name, description: t.description, parameters: t.parameters };
}

/**
 * Worst-case cost of a call, in micro-USD, ignoring token cost.
 *
 * With an explicit allowlist this is exact: the model can only reach those
 * tools. With `auto` it is the most expensive tool in the registry, because
 * Anuma selects server-side and the caller gets no say -- see the note in
 * policy.ts about why that is not paranoia.
 */
export function worstCaseToolCost(tools: RegistryTool[], allow: string[] | "auto" | "none"): number {
  if (allow === "none") return 0;
  const reachable = allow === "auto" ? tools : tools.filter((t) => allow.includes(t.name));
  return reachable.reduce((max, t) => Math.max(max, t.costMicroUsd), 0);
}

export function resolve(tools: RegistryTool[], names: string[]): { found: RegistryTool[]; missing: string[] } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const found: RegistryTool[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const t = byName.get(n);
    if (t) found.push(t);
    else missing.push(n);
  }
  return { found, missing };
}
