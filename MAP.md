# The map

What the Anuma API actually offers, what this server covers, and what is worth
building next. Written 2026-09-21 from `GET /api/v1/docs/swagger.json`
(Anuma Portal API 1.0, 181 paths / 211 operations) plus live probing with a
funded app key, not from the SDK or from notes.

## The shape of it

| Slice | Ops | Reachable with an app key | Worth our time |
|---|---|---|---|
| Admin + internal | 73 | no | no |
| Auth, MFA, OAuth, account, identity | 27 | n/a, these are user session flows | no |
| **Wired by this server** | **15 paths** | yes | done |
| **Everything else** | **97** | mostly yes | this is the decision |

So the real surface is not 211. It is roughly 97 operations, and most of them
cluster into six groups.

## What is already wired (18 tools)

Read: `anuma_health` · `anuma_list_models` · `anuma_list_tools` · `anuma_data` ·
`anuma_account` · `anuma_credits_balance` · `anuma_usage` · `anuma_zeta_rate` ·
`anuma_agent_grants` · `anuma_apps` · `anuma_permissions`

Spend: `anuma_respond` · `anuma_embed`

Local memory, no network: `anuma_remember` · `anuma_recall` · `anuma_forget`

Account control, always escalates: `anuma_app_configure` · `anuma_app_user_credits`

33 unit tests, live-verified, public.

## The six groups left, ranked

### 1. Developer app management (17 ops) — HIGH, and it embarrasses us

```
GET/POST/PATCH/DELETE  /api/v1/developer/apps[/{uuid}]
GET/POST/DELETE        /api/v1/developer/apps/{uuid}/api-keys
GET                    /api/v1/developer/apps/{uuid}/usage
GET                    /api/v1/developer/apps/{uuid}/users
PATCH                  /api/v1/developer/apps/{uuid}/users/{address}   "Update user limit"
POST                   /api/v1/developer/apps/{uuid}/users/{address}/top-up
GET                    /api/v1/developer/billing
```

All 200 with our app key. `GET /developer/apps` returns our app including its
`default_user_credits` field.

**This is the funding blocker, and it was automatable the whole time.** The
Per-User Limit that read as a dead payment for hours has a `PATCH` endpoint, and
allocating credits has a `top-up` endpoint. The claim that funding "must happen
in a logged-in dashboard session, a human action, not automatable" was wrong. It
was wrong because the conclusion was drawn from `/api/v1/credits/purchase`
returning 403 without checking whether another route existed.

Wiring this means an agent can provision an app, mint a key, set a spend limit
and top up a user without a browser. That is a better demo than anything else on
this list, because it is the thing that actually hurt.

### 2. Connectors (12 ops) — HIGH, and it is the real agent-safety surface

```
GET/PUT  /api/v1/connectors/{provider}/scopes   capability catalog + allow/disable
GET/PUT  /api/v1/connectors/{provider}/tools    batch ALLOW/DENY connector tools
POST     /api/v1/connectors/{provider}/proxy    proxy a connector API call
POST     /api/v1/connectors/import              import a refresh token into the vault
POST     /api/v1/connect-tickets                mint a connect-flow ticket
```

`GET /connectors` returns `{"connectors":[],"denied_tools":[]}` on our account,
so the surface is live but unpopulated.

This matters more than its size suggests. `PUT /connectors/{provider}/tools`
is a **server-side allow/deny list**, which is the missing half of the cost
problem: today the only working way to stop Anuma running an expensive tool is
`tool_choice: "none"` from the client. If deny lists work per connector, the
policy gate can enforce server-side as well as client-side. That is the
difference between a client that behaves and a limit that holds.

Needs a connected provider to test properly. Untested claim, flagged as such.

### 3. Agent consents and grants (8 ops) — HIGH for the pitch, partly blocked

```
GET/POST/DELETE  /api/v1/user/agent-consents      per-platform consent, with scopes
GET              /api/v1/user/agent-grants        401 missing service key
GET              /api/v1/agents, /api/v1/agents/{id}
PUT              /api/v1/agents/{id}/preference
```

`GET /user/agent-consents` is reachable and already returns live scopes like
`credits:spend`. This is Anuma's own permission model, and it is the server-side
mirror of the gate this repo implements. `agent-grants` remains 401 without a
service key, but consents alone are enough to demonstrate the pairing.

### 4. Wallets (4 ops) — MEDIUM now, HIGH after the migration

```
GET/POST/DELETE  /api/v1/wallets/binding[/{address}]
POST             /api/v1/wallets/binding/nonce
```

Returns `staked_zeta`, `ai_credits`, `zeta_rewards`, and a `pro.qualified` flag.
This is the stake-to-credits rail, and it is the one place the Solana migration
touches the API directly. Worth wiring when the second governance proposal lands,
not before, because the shape will likely change.

### 5. Shares and media (6 ops) — MEDIUM, and it is the content play

```
GET/POST/DELETE  /api/v1/shares[/{slug}]     publish an artifact to a public link
GET              /api/v1/media/shared/{slug}
```

`POST /shares` publishes an artifact to a public URL. For demo videos this is
the difference between showing a terminal and showing a link anyone can open.

### 6. Chat completions (7 ops) — LOW, deliberately

```
POST  /api/v1/chat/completions          OpenAI-compatible
GET   /api/v1/chat/streams/{id}         resume a buffered stream
POST  /api/v1/chat/streams/{id}/cancel
```

An OpenAI-shaped alternative to `/responses`, which we already use and which is
the richer endpoint. The streaming pair is the interesting part: a resumable,
cancellable buffered stream is unusual and would matter for a live demo. But
streaming over MCP stdio is real work for a cosmetic gain. Skip unless a video
needs it.

Also present and skipped: personas (2, read-only, empty), notifications (4,
device push), referral (5), nearby (3, geo beta), phone calls (2),
subscriptions (10, mutations are billing changes we should not automate),
webhooks (3, inbound from RevenueCat), user API keys (3, overlaps developer).

## What not to build

- **Memory as an API call.** There is no memory or vault path in the spec's 181,
  and there will not be: the engine is client-side in `anuma-ai/sdk`
  (`src/lib/memory/`, over a local encrypted vault), and
  `assembleMemoryContext()` builds the prompt before the request is sent. So
  **BUILT 2026-09-21** as `src/memory.ts`: a local vault with typed facts, decay
  measured from last use, overlap-first recall and de-duplication, wired into
  `anuma_respond` via `memory: true`. Not a port of the SDK's engine, a
  reimplementation of its shape. Still missing from the original: embeddings
  rather than term overlap, entity extraction, and consolidation.
- **`redeem_tokens`.** The endpoint 404s. The policy branch stays pre-classified
  for when it exists.
- **Anything under admin or internal.** 73 operations we cannot reach.
- **Subscription mutations.** Upgrade, downgrade and cancel change real billing.
  A human does that in a dashboard.

## The council question

`anuma_council` would fan one prompt across N models, tally the verdicts and
synthesise. It works today as a 70-line script against the existing
`anuma_respond`, proven live: 6 models, 50s, $0.0199, a 4-1 split.

**It should not be a tool in this server.** It composes existing tools and adds
no API surface, the seat list and synthesis prompt are editorial choices that
belong to the caller, and an agent that can call `anuma_respond` in a loop
already has it. Ship it as an example script in the repo instead, which is
honest about what it is and still films exactly the same.

## Decisions outstanding

| # | Decision | Recommendation |
|---|---|---|
| 1 | Wire developer app management | **DONE** `0c35c43`. Reads plus two writes that always escalate. |
| 2 | Wire connector allow/deny | **READ ONLY**, in `anuma_permissions`. The write is not wired: no provider is connected here, and an untested write to a permission surface is worse than none. |
| 3 | Wire agent consents | **DONE**, in `anuma_permissions`. |
| 4 | `anuma_council` as a tool | **DONE as an example**, `examples/council.mjs`. |
| 5 | Wallets | **Waiting** on the second governance proposal. |
| 6 | Streaming | Not built. |
| 7 | Scrub the leaked finding from the `21a3320` tree | **BLOCKED.** The local sandbox refuses the rewrite command, so Matthew has to run it. |
| 8 | Send the two drafts | Still unsent. |

## Ground truth, 2026-09-21

- Spec: `GET /api/v1/docs/swagger.json`, 200, 417,988 bytes, Anuma Portal API 1.0
- Live version per `/health`: 0.154.0
- Credits: 985 of 1000, $10.00 funded, app `Demo`
- Repo: `github.com/ExpertVagabond/anuma-mcp`, HEAD `6a3099b`, public, 11 tools,
  19 unit tests passing
