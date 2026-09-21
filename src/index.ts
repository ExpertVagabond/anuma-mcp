#!/usr/bin/env node
/**
 * anuma-mcp: Model Context Protocol server for Anuma.
 *
 * Gives any MCP-capable agent (Claude Code, Cursor, an SDK agent) access to
 * Anuma's model catalogue, inference, memory-backed responses, tool registry,
 * agent grants and ZETA credit rail, behind a client-side policy gate.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AnumaClient, AnumaError } from "./client.js";
import { mcpError, categoryForStatus } from "./errors.js";
import { evaluate, sessionLimitFromEnv, READ_ONLY_TOOLS } from "./policy.js";

const client = new AnumaClient();
let sessionSpend = 0;
const sessionLimit = sessionLimitFromEnv();

const TOOLS = [
  {
    name: "anuma_health",
    description: "Anuma API health and deployed version. No auth required.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_list_models",
    description:
      "List every model Anuma fronts, across all providers. Returns id, owner and modalities. No auth required.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Case-insensitive substring match on model id." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "anuma_respond",
    description:
      "Run inference through Anuma against any catalogued model, with the user's private memory in context. Spends credits.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id from anuma_list_models." },
        prompt: { type: "string", description: "User message text." },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "anuma_credits_balance",
    description: "Current credit balance for the authenticated app or user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_zeta_rate",
    description: "ZETA to credits conversion rate and ZETA market stats. The token leg of the Solana migration.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_list_tools",
    description: "Tools registered in Anuma's own tool registry, server-side and client-side.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_agent_grants",
    description: "Which agents the user has granted access to their memory, and with what scope.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_usage",
    description: "Usage grouped by modality: text, image, video, audio.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

const server = new Server(
  { name: "anuma-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as typeof TOOLS[number][] }));

/** Rough pre-call cost estimate. Reads are free; inference is charged on real usage afterwards. */
function estimateCredits(tool: string): number {
  if (READ_ONLY_TOOLS.has(tool)) return 0;
  if (tool === "anuma_respond") return 1;
  return 0;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  const decision = evaluate({
    tool,
    keyMode: client.keyMode,
    estimatedCredits: estimateCredits(tool),
    sessionSpend,
    sessionLimit,
  });

  if (decision.verdict === "refuse") {
    return mcpError("permission", `Refused by policy: ${decision.reason}`, { policy: "refuse" });
  }
  if (decision.verdict === "escalate") {
    return mcpError("permission", `Needs human approval: ${decision.prompt}`, {
      policy: "escalate",
      requiresHumanApproval: true,
    });
  }

  try {
    const result = await run(tool, args);
    sessionSpend += estimateCredits(tool);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof AnumaError) {
      const category = categoryForStatus(err.status);
      let message = `Anuma ${err.status} ${err.code}: ${err.message}.`;
      const extra: Record<string, unknown> = { httpStatus: err.status, anumaCode: err.code };
      if (err.traceId) extra.traceId = err.traceId;
      if (err.status === 401) {
        message += " Set ANUMA_API_KEY from an app created at https://dashboard.anuma.ai";
      } else if (err.billing) {
        const usd = (n: number) => `$${(n / 1_000_000).toFixed(6)}`;
        message +=
          ` Needs ${usd(err.billing.requiredMicroUsd)}, has ${usd(err.billing.availableMicroUsd)}` +
          ` (gate: ${err.billing.gate}). Fund the app or lock ZETA for credits.`;
        extra.billing = err.billing;
      }
      return mcpError(category, message, extra);
    }
    // Network-level failures (DNS, socket, abort) are worth retrying.
    return mcpError("transient", `Request failed: ${(err as Error).message}`);
  }
});

async function run(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "anuma_health":
      return client.health();
    case "anuma_list_models": {
      const { data } = await client.listModels();
      const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : null;
      const models = filter ? data.filter((m) => m.id.toLowerCase().includes(filter)) : data;
      return { count: models.length, models };
    }
    case "anuma_respond":
      return client.respond({
        model: String(args.model),
        messages: [{ role: "user", content: [{ type: "text", text: String(args.prompt) }] }],
      });
    case "anuma_credits_balance":
      return client.creditsBalance();
    case "anuma_zeta_rate":
      return { rate: await client.zetaCreditRate(), market: await client.zetaMarket() };
    case "anuma_list_tools":
      return client.listTools();
    case "anuma_agent_grants":
      return client.agentGrants();
    case "anuma_usage":
      return client.usageByModality();
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `anuma-mcp ready. key=${client.keyMode} limit=${sessionLimit} credits/session`,
);
