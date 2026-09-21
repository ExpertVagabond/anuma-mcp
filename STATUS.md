# STATUS

Last updated: 2026-09-21

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

1. ~~Implement `evaluate()`~~ **done.** Reads pass freely; `redeem_tokens` always
   escalates because it burns ZETA irreversibly; inference is allowed under a hard
   session ceiling rather than escalating every call, because the failure worth
   preventing is a runaway loop, not one deliberate completion.
2. ~~Fund an app so `anuma_respond` can be exercised end to end.~~ **done 9/21.**
   `tools/call anuma_respond` -> model returned "ok", balance 1000 -> 999,
   `credits_used: 1`. The error envelope was exercised on the same run.
3. Memory tools. Memory is documented at `docs.anuma.ai/memory` (engine and
   vault) but has no obvious client function in `sdk.gen.ts`. The usage numbers
   below now say it is not optional plumbing -- it is the product -- so this is
   worth a real read.
4. Report the four API findings below to Anuma. Each is a small, specific,
   reproducible bug report, which is a better opening than an introduction.

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
