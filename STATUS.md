# STATUS

Last updated: 2026-09-20

The server runs, the policy gate is implemented, and every branch is verified
against the live API. Inference needs a funded app before it can do more than
return a well-formed 402.

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
   preventing is a runaway loop, not one deliberate completion. Verified: reads
   return live data, redeem escalates, and a live-key completion passes the gate
   and surfaces Anuma's real 402 as "Needs $0.000100, has $0.000000".
2. Fund an app so `anuma_respond` can be exercised end to end.
3. Memory tools. Memory is documented at `docs.anuma.ai/memory` (engine and
   vault) but has no obvious client function in `sdk.gen.ts`, so it may be
   implicit in `/api/v1/responses`. Needs a read before any tool is added.

## Open questions

- `agent-grants` requires a "service key", a tier above the app key issued by
  the dashboard. Unclear how a third-party integration obtains one.
- Account wallets are reported as `0x` addresses by `credits/balance`. How
  those map onto Solana after the announced migration is not documented.
