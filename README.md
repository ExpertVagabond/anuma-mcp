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

## The policy gate

Anuma already has the server-side half of agent permissions
(`/api/v1/user/agent-grants`, `/api/v1/user/agent-consents`). This server adds
the client-side half, so the limit holds even when an agent is the one
composing the calls. Every tool call is evaluated to `allow`, `escalate` or
`refuse` before it reaches the network, and a session credit ceiling
(`ANUMA_SESSION_CREDIT_LIMIT`, default 100) backstops the whole thing.

Same shape as a policy-gated transaction signer: the agent works inside
enforced limits and never holds the unconstrained credential.

## Choosing a model

`anuma_list_models` returns 1007 ids. Most of them will not run, and the API
reports that three different ways:

| Prefix | Result |
|---|---|
| `openrouter/*` | works |
| `openai/*`, `anthropic/*` | `model_not_found` |
| `alibaba/*` | `model not available` |

Nothing on a catalogue entry (`id`, `created`, `owned_by`, `modalities`)
predicts which. The id must also be `provider/model`; a bare `gpt-4o` is
rejected on format. Start from an `openrouter/*` id.

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

The prompt field on `/api/v1/responses` is `input`. A `messages` array is
accepted and billed, but its text never reaches the model, which answers an
empty prompt with HTTP 200 and a well-formed body. This server never sends it.

Endpoint paths are taken from
[`anuma-ai/sdk`](https://github.com/anuma-ai/sdk) `src/client/sdk.gen.ts`, MIT.

## License

MIT
