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

Working. All 8 tools run, the policy gate is implemented and verified, and the
read path is confirmed against the live API. Inference additionally needs a
funded app. See `STATUS.md`.

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
```

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

## Verified against the live API

Checked 2026-09-20 against `https://portal.anuma.ai`, version `0.154.0`:

- `GET /health` → `{"status":"ok"}`
- `GET /api/v1/models` → 1005 models, no auth required
- `GET /api/v1/tools` → 42 tools, all MCP-named
- `GET /api/v1/zeta/credit-rate`, `/api/v1/zeta/market` → 401 without a key
- `GET /api/v1/user/agent-grants` → 401 `missing service key` (a separate auth tier)

Endpoint paths are taken from
[`anuma-ai/sdk`](https://github.com/anuma-ai/sdk) `src/client/sdk.gen.ts`, MIT.

## License

MIT
