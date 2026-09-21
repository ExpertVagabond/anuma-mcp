# anuma-mcp

A Model Context Protocol server for [Anuma](https://anuma.ai), the private AI
memory layer built by ZetaChain. It lets any MCP-capable agent use Anuma's
model catalogue, inference, tool registry, agent grants and ZETA credit rail,
behind a client-side policy gate.

Anuma runs 42 registered tools and every one of them is an MCP server
(`OpenMeteoMCP`, `AnumaJinaMCP`, `AnumaPaymentsMCP`, `PredictionsMCP`,
`AnumaVisionMCP`, and so on). Anuma consumes MCP throughout. It does not
publish one. This is that server.

## Status

Working, end to end. All 8 tools run against the live API, the policy gate is
implemented and tested, and inference is verified through the server over stdio
against a funded app. No unverified paths remain. See `STATUS.md`.

## Tools

| Tool | Auth | Spends |
|---|---|---|
| `anuma_health` | none | no |
| `anuma_list_models` | none | no |
| `anuma_list_tools` | none | no |
| `anuma_credits_balance` | API key | no |
| `anuma_zeta_rate` | API key | no |
| `anuma_usage` | API key | no |
| `anuma_account` | API key | no |
| `anuma_agent_grants` | service key | no |
| `anuma_respond` | API key | **yes** |

## Setup

```bash
npm install
cp .env.example .env     # then paste a key from dashboard.anuma.ai
npm run build
```

Get a key: create an app at [dashboard.anuma.ai](https://dashboard.anuma.ai),
open the Auth tab, add an API key. It is shown once. `anuma_test_` keys spend
nothing, so start there.

Check connectivity before wiring it into an agent:

```bash
node --experimental-strip-types src/probe.ts

# and, to spend one credit proving inference actually works:
ANUMA_PROBE_SPEND=1 node --experimental-strip-types src/probe.ts
```

Note that `--experimental-strip-types` cannot run `src/index.ts` directly: it
does not rewrite the `.js` import specifiers that `NodeNext` resolution
requires. Build first and run `dist/index.js`.

### Funding an app

Billing is two-tier, and the tiers fail identically in the dashboard:

1. Stripe funds the **app** balance (app -> Add Funds).
2. A **user** -- which is what an API key spends as -- draws on that balance
   only up to its **Per-User Limit**, which defaults to `$0.00`.

At a `$0.00` limit the key is authorised to spend nothing however full the app
balance is, and the API reports it as `available_micro_usd: 0, gate: "minimum"`
-- indistinguishable from an app that was never funded. Raise the limit in
Settings, then Top Up the user. `lifetime_credits` tells the two apart: `0`
means never funded, non-zero means funded and drained.

### Register with Claude Code

```bash
claude mcp add anuma -- node ~/projects/anuma-mcp/dist/index.js
```

## Server-side tools

Anuma does not just complete text. It searches its own registry of 42 MCP-backed
tools, picks one, **executes it server-side**, and bills you. Ask for the weather
and you get a real number, from a real call you never made:

```
prompt "say ok"                   3,173 prompt tokens   (tool-search harness)
prompt "weather in Tulum"        13,325 prompt tokens   (harness + search + execution)
```

That is the product. It is also the problem, because the registry spans **$0.00
to $2.40 a call**:

| Tool | Cost |
|---|---|
| `AnumaMediaMCP-anuma_create_video` | $2.40 |
| `AnumaMediaMCP-anuma_create_music` | $2.00 |
| `AnumaPaymentsMCP-anuma_paid_web_search` | $0.02 |
| `OpenMeteoMCP-*`, `AnumaJinaMCP-search_web` | $0.001 |
| `AnumaVisionMCP-anuma_analyze_image`, `PredictionsMCP-market_detail` | free |

An agent can reach the $2.40 one by asking in English. So `anuma_respond`
defaults `tools` to `"none"`, and you opt in per call:

```jsonc
{ "model": "openrouter/amazon/nova-2-lite-v1", "prompt": "..." }                      // no tools, cheapest
{ "model": "...", "prompt": "...", "tools": ["OpenMeteoMCP-weather_forecast"] }       // named, gated on cost
{ "model": "...", "prompt": "...", "tools": "auto" }                                  // all 42 -> escalates
```

Naming tools is also **cheaper than `auto`**: handing Anuma the schema skips its
own tool search (13,325 → 8,234 prompt tokens for the same answer).

An allowlist is a floor, not a ceiling. A call naming only the weather tool came
back with `portal_injected_tools: ["AnumaSearchMCP-anuma_text_search"]` -- Anuma
adds its own tools on top of yours. Only `"none"` is a true ceiling.

Because the estimate cannot be trusted, every response is reconciled against its
receipt. `anuma_respond` returns what actually ran, and the session accrues real
spend rather than a flat per-call fiction:

```jsonc
{ "text": "31",
  "toolsInvoked": [{ "name": "OpenMeteoMCP-weather_forecast",
                     "costMicroUsd": 1000, "injectedBy": "client" }],
  "toolCostMicroUsd": 1000 }
```

`injectedBy` is `"client"` if you allowed it and `"portal"` if Anuma added it.
When accrued tool spend reaches `ANUMA_SESSION_TOOL_BUDGET_MICRO_USD` (default
$1.00) further calls are refused.

`anuma_list_tools` returns name, description and `costMicroUsd`, filterable by
`filter` and `maxCostMicroUsd`. It strips the embeddings Anuma ships: the raw
registry is **1.78 MB** of 4096-dimension vectors, about 450k tokens, and would
blow the context window of anything that asked for it. Slimmed, it is 58 KB.

## Statelessness

Anuma is stateless between requests via this API. Tell it your codename in one
call and it does not know in the next -- the ~3,173 baseline tokens are the tool
harness, not your history. `conversation_id` exists but the schema says
"pass-through only, not forwarded to the LLM provider": observability, not
memory. There are no memory or vault endpoints in the public SDK's 171 paths.

Continuity is therefore the client's job, which `anuma_respond` supports by
resending turns:

```jsonc
{ "model": "...", "messages": [
  { "role": "user", "text": "My project codename is Kestrel." },
  { "role": "assistant", "text": "Noted, Kestrel." },
  { "role": "user", "text": "What is my project codename?" } ] }
```

## The policy gate

Anuma already has the server-side half of agent permissions
(`/api/v1/user/agent-grants`, `/api/v1/user/agent-consents`). This server adds
the client-side half, so the limit holds even when an agent is the one
composing the calls. Every tool call is evaluated to `allow`, `escalate` or
`refuse` before it reaches the network, and a session credit ceiling
(`ANUMA_SESSION_CREDIT_LIMIT`, default 100) backstops the whole thing.

Because Anuma runs tools itself, the gate also prices what a call can *reach*:
if the worst-case tool costs more than `ANUMA_MAX_TOOL_COST_MICRO_USD` (default
20,000, i.e. $0.02) the call escalates for human approval rather than running.
That threshold clears every search, weather, market-data and prediction tool and
stops all six media tools. This is the only place such a limit can be enforced:
`tools: []` and `tool_choice: {"type":"none"}` are both accepted and silently
ignored by the API, and the string `tool_choice: "none"` -- the one form that
works -- is a client-side decision.

Same shape as a policy-gated transaction signer: the agent works inside
enforced limits and never holds the unconstrained credential.

## Choosing a model

There are two model lists, and the big one is mostly a trap.
`GET /api/v1/models` returns 1007 ids of which most will not run.
`GET /api/v1/curated-models` returns **53** with real metadata -- provider,
category, price tier, quality, context window -- and membership there is what
predicts routability:

| Model | Curated? | Result |
|---|---|---|
| `glm/glm-5.3` | yes | works |
| `anthropic/claude-opus-5` | yes | `model_tier_required` (real, above your plan) |
| `openai/gpt-4o-mini` | catalogue only | `model_not_found` |

So `anuma_list_models` returns the curated list by default, filterable by
`category`; pass `source: "catalogue"` for the raw 1007. The `active` flag on a
curated model does **not** predict anything -- `active: false` models route
fine. Ids must be `provider/model`; a bare `gpt-4o` is rejected on format.
After a `model_tier_required`, `anuma_account` tells you which tier you are on.

Expect a large fixed prompt cost: a seven-word prompt bills ~3,170 prompt
tokens, because Anuma injects retrieved memory server-side before the model
sees it. That context *is* the product, but it means token math against a
provider's list price will undercount.

## Verified against the live API

Checked 2026-09-21 against `https://portal.anuma.ai`, version `0.154.0` as
reported by `/health`:

- `GET /health` → `{"status":"ok"}`
- `GET /api/v1/models` → 1007 models, no auth required
- `GET /api/v1/tools` → 42 tools, all MCP-named
- `GET /api/v1/credits/balance`, `/api/v1/usage/by-modality` → live with an app key
- `GET /api/v1/zeta/credit-rate`, `/api/v1/zeta/market` → 401 without a key
- `GET /api/v1/user/agent-grants` → 401 `missing service key` (a separate auth tier)
- `POST /api/v1/responses` → completion returned, `credits_used: 1`
- `POST /api/v1/credits/purchase` → 403 for an app key; funding is dashboard-only
- `POST /api/v1/credits/redeem-tokens` → **404**, though it is published in the
  SDK. No working crypto → credits route exists today, so this server does not
  ship a method that posts to it.

Three request fields are accepted, billed and silently ignored. None errors:

| Sent | Intent | What happens |
|---|---|---|
| top-level `messages` | multi-turn | billed, model sees an empty prompt |
| `tools: []` | disable tools | ignored, tools still run |
| `tool_choice: {"type":"none"}` | disable tools | ignored, tools still run |
| `tool_choice: "none"` *(string)* | disable tools | **works** |

Two more shapes worth knowing. Error envelopes are not uniform: alongside
`{error, type, code, trace_id}` there is a bare
`{error, model, required_tier}` where the `error` string *is* the code, so a
client that reads only `.code` loses the one useful discriminator. And a
response's `output` can lead with a `reasoning` item, or be `null` outright when
a reasoning model spends `max_output_tokens` before it starts answering -- a
billed call with no answer and no error.

`input` is a union: a bare string, or a top-level array of messages.
`{ input: { messages: [...] } }` is rejected as `Invalid request body`. Tool
schemas must be flat (`{type, name, description, parameters}`); the nested
OpenAI form `{type, function:{...}}` is rejected upstream.

Endpoint paths are taken from
[`anuma-ai/sdk`](https://github.com/anuma-ai/sdk) `src/client/sdk.gen.ts`, MIT.

## License

MIT
