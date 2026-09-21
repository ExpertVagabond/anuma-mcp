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
import { mcpError, categoryForStatus, ValidationError } from "./errors.js";
import {
  evaluate,
  sessionLimitFromEnv,
  toolCostLimitFromEnv,
  sessionToolBudgetFromEnv,
  READ_ONLY_TOOLS,
} from "./policy.js";
import { loadRegistry, reconcile, resolve, toSchema, worstCaseToolCost } from "./tools.js";

const client = new AnumaClient();
let sessionSpend = 0;
/** Real server-side tool spend this session, in micro-USD, read off responses. */
let toolSpendMicroUsd = 0;
const sessionLimit = sessionLimitFromEnv();
const toolCostLimit = toolCostLimitFromEnv();
const sessionToolBudget = sessionToolBudgetFromEnv();

const TOOLS = [
  {
    name: "anuma_health",
    description: "Anuma API health and deployed version. No auth required.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_list_models",
    description:
      "Models you can actually use. Defaults to Anuma's 53 curated models, with provider, category, " +
      "price tier and context window. Membership predicts routability: a curated id works or returns " +
      'model_tier_required, while a catalogue-only id returns model_not_found. Pass source="catalogue" ' +
      "for the raw 1007-entry list, most of which will not run.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Case-insensitive substring match on model id." },
        source: {
          type: "string",
          enum: ["curated", "catalogue"],
          description: 'Default "curated". Use "catalogue" only to see everything Anuma fronts.',
        },
        category: { type: "string", description: 'Curated only, e.g. "text", "vision", "image".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: "anuma_respond",
    description:
      "Run inference through Anuma. Spends credits. `model` must be a routable `provider/model` id " +
      "(the anuma_list_models catalogue is wider than what an app can route to; openrouter/* works). " +
      "Anuma can execute its own tools server-side and bill for them, so `tools` defaults to \"none\": " +
      "set it to a list of names from anuma_list_tools, or \"auto\", to let it.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id from anuma_list_models." },
        prompt: { type: "string", description: "Single-turn user message. Use this or `messages`, not both." },
        messages: {
          type: "array",
          description:
            "Multi-turn conversation, oldest first. Anuma is stateless between requests, so continuity means resending the turns.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant", "system"] },
              text: { type: "string" },
            },
            required: ["role", "text"],
            additionalProperties: false,
          },
        },
        temperature: { type: "number", description: "0.0 to 2.0. Omit for the model default." },
        max_output_tokens: { type: "number", description: "Cap on generated tokens." },
        conversation_id: {
          type: "string",
          description:
            "Groups requests for observability. NOT memory -- Anuma does not forward it to the model; resend `messages` for continuity.",
        },
        tools: {
          description:
            'Server-side tools this call may reach. "none" (default) disables them, "auto" lets Anuma pick from all 42, ' +
            "or give exact names from anuma_list_tools. Naming them is cheaper than \"auto\": it skips Anuma's tool search.",
          oneOf: [
            { type: "string", enum: ["none", "auto"] },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      required: ["model"],
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
    description:
      "Anuma's server-side tool registry: name, description and cost in micro-USD. " +
      "Pass these names to anuma_respond's `tools`. Embeddings are stripped.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Case-insensitive substring match on tool name." },
        maxCostMicroUsd: { type: "number", description: "Only tools at or below this cost. 1000000 = $1.00." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "anuma_agent_grants",
    description: "Which agents the user has granted access to their memory, and with what scope.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "anuma_account",
    description:
      "Who this credential is, what scopes it holds, and which subscription tier it is on. " +
      "The tier determines which curated models are reachable, so check here after a model_tier_required error.",
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

/** Normalises the `tools` argument into the three shapes the policy understands. */
function requestedTools(args: Record<string, unknown>): string[] | "auto" | "none" {
  const t = args.tools;
  if (t === "auto") return "auto";
  if (Array.isArray(t)) return t.map(String);
  return "none";
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  // Price the call before deciding on it. Only anuma_respond can reach a
  // server-side tool, and only it needs the registry to know what that costs.
  let worstCaseToolMicroUsd = 0;
  if (tool === "anuma_respond" && client.keyMode !== "none") {
    try {
      worstCaseToolMicroUsd = worstCaseToolCost(await loadRegistry(client), requestedTools(args));
    } catch {
      // The registry is a public endpoint, but if it is unreachable the safe
      // reading of "unknown cost" is the expensive one, not the free one.
      worstCaseToolMicroUsd = requestedTools(args) === "none" ? 0 : Number.MAX_SAFE_INTEGER;
    }
  }

  const decision = evaluate({
    tool,
    keyMode: client.keyMode,
    estimatedCredits: estimateCredits(tool),
    sessionSpend,
    sessionLimit,
    worstCaseToolMicroUsd,
    toolCostLimitMicroUsd: toolCostLimit,
    sessionToolSpendMicroUsd: toolSpendMicroUsd,
    sessionToolBudgetMicroUsd: sessionToolBudget,
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
      } else if (err.code === "model_tier_required") {
        message += " The model is real but above this plan's tier. Check anuma_account, or pick another from anuma_list_models.";
      } else if (err.code === "model_not_found") {
        message += " Not routable. anuma_list_models defaults to the curated list, which is the one that works.";
      } else if (err.billing) {
        const usd = (n: number) => `$${(n / 1_000_000).toFixed(6)}`;
        message +=
          ` Needs ${usd(err.billing.requiredMicroUsd)}, has ${usd(err.billing.availableMicroUsd)}` +
          ` (gate: ${err.billing.gate}). Fund the app or lock ZETA for credits.`;
        extra.billing = err.billing;
      }
      return mcpError(category, message, extra);
    }
    // A caller mistake will fail identically on every retry, so it must not be
    // reported as transient however convenient the catch-all is.
    if (err instanceof ValidationError) {
      return mcpError("validation", (err as Error).message);
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
      const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : null;

      if (args.source === "catalogue") {
        const { data } = await client.listModels();
        const models = filter ? data.filter((m) => m.id.toLowerCase().includes(filter)) : data;
        return {
          count: models.length,
          note: "Raw catalogue. Most of these return model_not_found; prefer the curated list.",
          models,
        };
      }

      const { models: curated } = await client.curatedModels();
      let models = curated;
      if (filter) models = models.filter((m) => m.id.toLowerCase().includes(filter));
      if (typeof args.category === "string") {
        models = models.filter((m) => m.category === args.category);
      }
      return {
        count: models.length,
        note: "Curated models. A model_tier_required error here means the model is real but above your plan -- see anuma_account.",
        models,
      };
    }
    case "anuma_respond": {
      if (args.prompt === undefined && args.messages === undefined) {
        throw new ValidationError("anuma_respond needs either `prompt` or `messages`.");
      }
      // `input` is a union: a bare string, or a top-level array of messages.
      // A top-level `messages` key is billed and silently ignored.
      const input = Array.isArray(args.messages)
        ? (args.messages as Array<{ role: string; text: string }>).map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            content: [{ type: "text" as const, text: String(m.text) }],
          }))
        : String(args.prompt);

      const want = requestedTools(args);
      const body: Parameters<typeof client.respond>[0] = { model: String(args.model), input };
      if (typeof args.temperature === "number") body.temperature = args.temperature;
      if (typeof args.max_output_tokens === "number") body.max_output_tokens = args.max_output_tokens;
      if (typeof args.conversation_id === "string") body.conversation_id = args.conversation_id;

      if (want === "none") {
        // The string form. `tools: []` and `tool_choice: {"type":"none"}` are
        // both accepted and ignored; only this actually disables tools.
        body.tool_choice = "none";
      } else if (want !== "auto") {
        const { found, missing } = resolve(await loadRegistry(client), want);
        if (missing.length) {
          throw new ValidationError(
            `Unknown tool(s): ${missing.join(", ")}. List them with anuma_list_tools.`,
          );
        }
        body.tools = found.map(toSchema);
      }
      const raw = await client.respond(body);

      /*
       * Reconcile. The estimate above is a guess -- Anuma picks and injects
       * tools itself -- but the response carries the receipt, so charge the
       * session what the call actually cost rather than a flat 1 per call.
       */
      const { invoked, toolMicroUsd } = reconcile(await loadRegistry(client), raw);
      toolSpendMicroUsd += toolMicroUsd;

      const r = raw as {
        output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
        usage?: Record<string, unknown>;
      };
      // `output` can lead with a `reasoning` item, so the message is not
      // reliably output[0]. Pull every text part in order instead.
      const text = (r.output ?? [])
        .filter((o) => o.type !== "reasoning")
        .flatMap((o) => o.content ?? [])
        .map((c) => c.text ?? "")
        .join("")
        .trim();

      /*
       * A billed call can legitimately produce no text: a reasoning model
       * whose `max_output_tokens` is spent on reasoning returns `output: null`
       * with a usage record and no error. That is an empty result, not a
       * failure, so it stays a success -- but returning a bare "" would leave
       * the caller guessing, so say what happened.
       */
      const empty = !text;
      return {
        text,
        ...(empty
          ? {
              note:
                "No text was returned. The call still cost credits. With a reasoning model this " +
                "usually means max_output_tokens was consumed before the message began -- raise it or omit it.",
            }
          : {}),
        toolsInvoked: invoked,
        toolCostMicroUsd: toolMicroUsd,
        usage: r.usage,
        output: r.output ?? null,
      };
    }
    case "anuma_credits_balance":
      return client.creditsBalance();
    case "anuma_zeta_rate":
      return { rate: await client.zetaCreditRate(), market: await client.zetaMarket() };
    case "anuma_list_tools": {
      // Never return the raw registry: it is 1.78 MB of 4096-dim embeddings.
      let tools = await loadRegistry(client);
      const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : null;
      if (filter) tools = tools.filter((t) => t.name.toLowerCase().includes(filter));
      if (typeof args.maxCostMicroUsd === "number") {
        tools = tools.filter((t) => t.costMicroUsd <= (args.maxCostMicroUsd as number));
      }
      return {
        count: tools.length,
        note: "costMicroUsd: 1000000 = $1.00. Pass these names to anuma_respond's `tools`.",
        tools: tools
          .slice()
          .sort((a, b) => a.costMicroUsd - b.costMicroUsd || a.name.localeCompare(b.name)),
      };
    }
    case "anuma_agent_grants":
      return client.agentGrants();
    case "anuma_account": {
      // Two reads, because "who am I" and "what may I use" are separate
      // endpoints and an agent hitting model_tier_required needs both.
      const [identity, subscription] = await Promise.all([client.me(), client.subscriptionStatus()]);
      return { identity, subscription };
    }
    case "anuma_usage":
      return client.usageByModality();
    default:
      throw new ValidationError(`Unknown tool: ${tool}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `anuma-mcp ready. key=${client.keyMode} limit=${sessionLimit} credits/session, ` +
    `tools<=$${(toolCostLimit / 1_000_000).toFixed(4)}/call, ` +
    `$${(sessionToolBudget / 1_000_000).toFixed(2)}/session`,
);
