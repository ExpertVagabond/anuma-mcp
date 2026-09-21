# STATUS

Last updated: 2026-09-21 (second pass)

The server runs, the policy gate is implemented, and every branch is verified
against the live API -- including inference, end to end over stdio, against a
funded app.

## Working

- `src/client.ts` — typed REST wrapper. Base URL, auth scheme and error shapes
  all verified against `portal.anuma.ai` rather than assumed.
- `src/index.ts` — MCP server, 8 tools over stdio. `initialize` and
  `tools/list` both verified.
- `src/probe.ts` — live dry-run harness. Green on every endpoint the app key
  reaches.

## Verified against the live API, 2026-09-20 (`portal.anuma.ai` 0.154.0)

| Endpoint | Auth | Result |
|---|---|---|
| `/health` | none | ok |
| `/api/v1/models` | none | 1005 models |
| `/api/v1/tools` | none | 42 tools, 9 MCP servers |
| `/api/v1/credits/balance` | app key | ok |
| `/api/v1/zeta/credit-rate` | app key | ok |
| `/api/v1/zeta/market` | app key | ok |
| `/api/v1/usage/by-modality` | app key | ok |
| `/api/v1/responses` | app key | 402 when unfunded, see below |
| `/api/v1/user/agent-grants` | app key | 401 `missing service key` |

### Credit model

```
/api/v1/zeta/credit-rate   apy 4%, staking apr 9.3%,
                           credits_per_zeta_per_year 0.15444
/api/v1/credits/packs      200cr/$3 · 400cr/$5 · 1000cr/$10 · 1500cr/$15 · 2200cr/$20
```

Credits are yield on locked ZETA rather than burned ZETA, which matches the
published description of the mechanism.

### Inference is gated on a minimum balance

```json
{"error":"insufficient_balance","type":"billing_error","code":"payment_required",
 "required_micro_usd":100,"available_micro_usd":0,"gate":"minimum"}
```

A `gate` field implies more than one refusal reason, so the client keeps the
billing detail on the error instead of collapsing it to "payment required".

## Next

1. ~~Implement `evaluate()`~~ **done.**
2. ~~Fund an app so `anuma_respond` can be exercised end to end.~~ **done 9/21.**
3. ~~Memory tools.~~ **Closed: there is nothing to wire.** The public SDK has 171
   endpoints and not one memory or vault path; the `*MemoryOp` names in the repo
   are server-side ops, not HTTP routes. `conversation_id` is documented
   "pass-through only, not forwarded to the LLM provider". Tested directly:
   state a fact, ask in a fresh request, and the model has never heard it.
   Continuity is the client's job, so `anuma_respond` now takes `messages`.
4. ~~Explicit tool invocation.~~ **done 9/21.** `tools` accepts `"none"`
   (default), `"auto"`, or exact registry names.
5. Ask Anuma for a service key. `agent-grants` still 401s, and that endpoint is
   the server-side half of the same permission story this gate implements
   client-side. It is the most interesting thing still out of reach.
6. Streaming (`stream: true`) and `background: true` are in the request schema
   and untouched here. Streaming would matter for a live demo.

## What the second and third passes changed

- **`anuma_list_tools` was returning 1.78 MB.** Every registry entry carries a
  4096-dimension embedding for Anuma's tool search. That is ~450k tokens into an
  agent's context, i.e. the tool was unusable by the thing it exists for. Now
  58 KB of name, description and cost.
- **The gate now prices what a call can reach.** Tool costs span $0.00 to $2.40.
  Pricing every `anuma_respond` at a flat 1 credit under-counted the video tool
  by 240x. `ANUMA_MAX_TOOL_COST_MICRO_USD` (default $0.02) escalates anything
  dearer, which cleanly separates the read-shaped tools from the media ones.
- **Validation errors were reported as retryable.** A bad tool name or a missing
  prompt fell to the generic catch and came back `transient, isRetryable: true`,
  inviting an agent to loop on a call that can never succeed. Now `validation`.
- **Multi-turn works**, via `input` as a top-level array.
- **Curated models.** `/api/v1/curated-models` returns 53 models with tier and
  category metadata, and membership predicts routability where nothing on a
  catalogue entry did. `anuma_list_models` now defaults to it.
- **`anuma_account`** surfaces identity, scopes and subscription tier, which is
  what a `model_tier_required` error actually needs you to know.
- **Cost is reconciled, not guessed.** Responses carry `tool_call_events`,
  `client_injected_tools` and `portal_injected_tools`. An allowlist turns out to
  be a floor rather than a ceiling -- Anuma injects its own tools on top -- so
  the server now reads real cost off each response and enforces a session budget
  (`ANUMA_SESSION_TOOL_BUDGET_MICRO_USD`, default $1.00).
- **Error codes recovered.** A second envelope shape carries no `code` at all;
  reading only `.code` turned every routing failure into `unknown`.
- **Empty reasoning responses explain themselves** instead of returning "".

## Funding, resolved 2026-09-21

Billing is two-tier and the tiers fail identically in the UI:

- Stripe funds the **app** balance (`dashboard.anuma.ai` -> app -> Add Funds).
- A **user** -- which is what an API key spends as -- draws on that balance only
  up to its **Per-User Limit**. At the default `$0.00` a key is authorised to
  spend nothing no matter how full the app balance is, and the API reports it as
  `available_micro_usd: 0, gate: "minimum"`, indistinguishable from an unfunded
  app.

`$10` -> `1000` credits, expiring in 30 days. `lifetime_credits` vs
`available_credits` is the cheap way to tell "never funded" from "funded and
drained".

## Findings worth reporting

0. **Three request fields are accepted, billed and silently ignored**: top-level
   `messages`, `tools: []`, and `tool_choice: {"type":"none"}`. The last two
   matter most -- a caller trying to disable server-side tools by the obvious
   routes gets no error and still pays for the tools. Only the string
   `tool_choice: "none"` works.

1. **`messages` is accepted, billed, and silently dropped.** `POST
   /api/v1/responses` takes `input`. Send `messages` instead -- either the plain
   OpenAI shape or the content-part shape -- and the request is charged and
   answered, but the model receives an empty prompt and replies asking what you
   meant. No error, HTTP 200, well-formed response. Cost one live credit to find.
2. **The model catalogue is not the routable set.** `/api/v1/models` returns 1007
   ids. `openai/*` and `anthropic/*` ids from that list return `model_not_found`;
   `alibaba/*` returns `model not available`; `openrouter/*` works. Three
   different error strings for one condition, and no field on the catalogue entry
   says which apply.
3. **`POST /api/v1/credits/redeem-tokens` is 404.** The path is in
   `anuma-ai/sdk`. `credits/redeem`, `credits/redeem_tokens`, `tokens/redeem` and
   `zeta/redeem` are all 404 too, so there is currently no working crypto ->
   credits route despite the ZETA credit rail being documented.
4. **The dashboard renders API errors as `[object Object]`.** The frontend
   stringifies the error object rather than reading `.error`. Both funding
   failures surface this way, which is why a $0 balance and a $0 per-user limit
   are impossible to tell apart without DevTools.

## Open questions

- `agent-grants` requires a "service key", a tier above the app key issued by
  the dashboard. Unclear how a third-party integration obtains one.
- Account wallets are reported as `0x` addresses by `credits/balance`. How
  those map onto Solana after the announced migration is not documented.
