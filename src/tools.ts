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
 * An explicit allowlist is a floor, NOT a ceiling. Verified 2026-09-21: a call
 * naming only `OpenMeteoMCP-weather_forecast` came back with
 * `portal_injected_tools: ["AnumaSearchMCP-anuma_text_search"]` -- Anuma adds
 * its own tools on top of whatever the caller allows. So an allowlist is
 * priced as the dearest named tool or the dearest tool Anuma is known to
 * inject, whichever is higher.
 *
 * With `auto` it is simply the dearest tool in the registry: Anuma selects
 * server-side and the caller gets no say.
 *
 * Only `none` is a true ceiling, because then no tool runs at all. This is why
 * reconcile() exists: the estimate cannot be trusted, so the real cost is read
 * back off the response.
 */
/** Tools Anuma has been observed adding to a call on its own initiative. */
export const PORTAL_INJECTED = ["AnumaSearchMCP-anuma_text_search"];

export function worstCaseToolCost(tools: RegistryTool[], allow: string[] | "auto" | "none"): number {
  if (allow === "none") return 0;
  const names = allow === "auto" ? tools.map((t) => t.name) : [...allow, ...PORTAL_INJECTED];
  return tools
    .filter((t) => names.includes(t.name))
    .reduce((max, t) => Math.max(max, t.costMicroUsd), 0);
}

export interface ToolCallEvent {
  name?: string;
  arguments?: string;
  output?: string;
}

export interface Invoked {
  name: string;
  costMicroUsd: number;
  /** "client" if we allowed it, "portal" if Anuma added it, "unknown" if absent from the registry. */
  injectedBy: "client" | "portal" | "unknown";
}

/**
 * What a call ACTUALLY cost in tools, read off the response.
 *
 * The estimate is a guess by construction -- Anuma picks and injects tools
 * server-side. `tool_call_events` is the receipt, so the ceiling accrues real
 * spend instead of a flat per-call fiction.
 */
export function reconcile(
  tools: RegistryTool[],
  response: unknown,
): { invoked: Invoked[]; toolMicroUsd: number } {
  const r = (response ?? {}) as {
    tool_call_events?: ToolCallEvent[];
    client_injected_tools?: string[];
    portal_injected_tools?: string[];
  };
  const byName = new Map(tools.map((t) => [t.name, t]));
  const client = new Set(r.client_injected_tools ?? []);
  const portal = new Set(r.portal_injected_tools ?? []);

  const invoked: Invoked[] = [];
  for (const ev of r.tool_call_events ?? []) {
    if (!ev?.name) continue;
    invoked.push({
      name: ev.name,
      costMicroUsd: byName.get(ev.name)?.costMicroUsd ?? 0,
      injectedBy: client.has(ev.name) ? "client" : portal.has(ev.name) ? "portal" : "unknown",
    });
  }
  return { invoked, toolMicroUsd: invoked.reduce((sum, i) => sum + i.costMicroUsd, 0) };
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
