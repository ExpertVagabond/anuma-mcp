/**
 * Thin typed wrapper over the Anuma REST API.
 *
 * Base URL and auth scheme verified live on 2026-09-20:
 *   GET https://portal.anuma.ai/health        -> {"status":"ok","version":"0.154.0"}
 *   GET https://portal.anuma.ai/api/v1/models -> model catalogue, NO auth required
 *   GET /api/v1/zeta/credit-rate              -> 401 "missing authorization header"
 *
 * Auth (docs.anuma.ai/authentication):
 *   - Server-side API keys, prefix `anuma_live_` / `anuma_test_`, header `X-API-KEY`
 *   - Privy user tokens, header `Authorization: Bearer <token>`
 * The generated SDK sends `Authorization: Bearer` for API keys too, so we send
 * both headers and let the server pick. Verified against a real key in probe.ts.
 */

const DEFAULT_BASE_URL = "https://portal.anuma.ai";

export class AnumaError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;
  /** Present on 402. Anuma gates inference behind a minimum balance. */
  readonly billing?: { requiredMicroUsd: number; availableMicroUsd: number; gate: string };

  // Explicit assignment rather than parameter properties: those emit code, so
  // they break `node --experimental-strip-types`, which probe.ts relies on.
  constructor(
    status: number,
    code: string,
    message: string,
    traceId?: string,
    billing?: AnumaError["billing"],
  ) {
    super(message);
    this.name = "AnumaError";
    this.status = status;
    this.code = code;
    this.traceId = traceId;
    this.billing = billing;
  }
}

export interface AnumaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Abort any single request after this many ms. */
  timeoutMs?: number;
}

export interface DeveloperApp {
  app_uuid: string;
  name: string;
  /** Credits available in the app pool. */
  balance: number;
  /** Credits granted per new user. This is the dashboard's Per-User Limit, which defaults to 0. */
  default_user_credits: number;
  app_type: string;
  is_active: boolean;
  allowed_origins: string[];
  has_privy_config: boolean;
  created_at: string;
  updated_at: string;
}

export interface CuratedModel {
  id: string;
  name?: string;
  description?: string;
  provider?: string;
  category?: string;
  price_tier?: string;
  quality?: string;
  active?: boolean;
  featured?: boolean;
  max_input_tokens?: number;
  is_private?: boolean;
}

/** One turn. `content` parts use type "text"; "input_text"/"output_text" are rejected. */
export interface AnumaMessage {
  role: "user" | "assistant" | "system";
  content: Array<{ type: "text"; text: string }>;
}

/**
 * A tool offered to the model, FLAT. The nested OpenAI form
 * `{type:"function", function:{...}}` is rejected upstream with
 * "The upstream model provider rejected the request".
 */
export interface AnumaToolSchema {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

function timeoutFromEnv(): number {
  const raw = process.env.ANUMA_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

export class AnumaClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: AnumaClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANUMA_API_KEY;
    this.baseUrl = (opts.baseUrl ?? process.env.ANUMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    /*
     * 30s is too short for this API. Reasoning models think before they answer,
     * and a fan-out of concurrent calls makes the slowest slower still: a
     * six-model parallel call had two seats abort at 30s that each completed
     * fine on their own. The failure is indistinguishable from a dead model
     * unless you read the error, so the default is 120s and it is tunable.
     */
    this.timeoutMs = opts.timeoutMs ?? timeoutFromEnv();
  }

  /** True when a key is present. Some endpoints (models, health) work without one. */
  get authenticated(): boolean {
    return Boolean(this.apiKey);
  }

  /** `live` keys bill real credits. Used by the policy layer to decide what needs escalation. */
  get keyMode(): "live" | "test" | "none" {
    if (!this.apiKey) return "none";
    return this.apiKey.startsWith("anuma_live_") ? "live" : "test";
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["X-API-KEY"] = this.apiKey;
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      if (!res.ok) throw new AnumaError(res.status, "non_json_error", text.slice(0, 200));
      throw new AnumaError(res.status, "non_json_response", `Expected JSON from ${path}`);
    }

    if (!res.ok) {
      /*
       * Anuma returns at least two error envelopes, and the second has no
       * `code` at all:
       *
       *   {"error":"insufficient_balance","type":"billing_error",
       *    "code":"payment_required","required_micro_usd":100,...}
       *   {"error":"model_tier_required","model":"...","required_tier":"Starter"}
       *
       * In the second the `error` string IS the machine-readable code, so
       * falling back to "unknown" throws away the only useful discriminator
       * and every model routing failure arrives indistinguishable.
       */
      const e = parsed as {
        error?: string;
        code?: string;
        trace_id?: string;
        required_micro_usd?: number;
        available_micro_usd?: number;
        gate?: string;
        required_tier?: string;
      };
      const billing =
        typeof e?.required_micro_usd === "number"
          ? {
              requiredMicroUsd: e.required_micro_usd,
              availableMicroUsd: e.available_micro_usd ?? 0,
              gate: e.gate ?? "unknown",
            }
          : undefined;
      const message = e?.required_tier
        ? `${e.error} (requires the ${e.required_tier} tier)`
        : (e?.error ?? `HTTP ${res.status}`);
      throw new AnumaError(
        res.status,
        e?.code ?? e?.error ?? "unknown",
        message,
        e?.trace_id,
        billing,
      );
    }
    return parsed as T;
  }

  // --- endpoints used by the MCP tools. Paths copied from anuma-ai/sdk src/client/sdk.gen.ts ---

  health() {
    return this.request<{ status: string; version: string; timestamp: number }>("GET", "/health");
  }

  /** Public. Full catalogue across every provider Anuma fronts. */
  listModels() {
    return this.request<{ data: Array<{ id: string; owned_by: string; modalities: string[] }> }>(
      "GET",
      "/api/v1/models",
    );
  }

  /** The shortlist Anuma surfaces in-product. */
  listCuratedModels() {
    return this.request<unknown>("GET", "/api/v1/curated-models");
  }

  /** Non-streaming inference. Spends credits from the app balance. */
  /**
   * Inference. The prompt field is `input`, NOT `messages`.
   *
   * Verified live 2026-09-21. `input` is a union with custom unmarshalling:
   * a bare string for one turn, or a top-level ARRAY of messages for
   * multi-turn. A top-level `messages` key is accepted, billed and answered,
   * but its text never reaches the model -- the completion comes back
   * addressed to an empty prompt. `{ input: { messages: [...] } }` is rejected
   * outright as `Invalid request body`. Only the two forms below work.
   *
   * `model` must be `provider/model`; a bare id is rejected on format.
   */
  respond(body: {
    model: string;
    input: string | AnumaMessage[];
    tools?: AnumaToolSchema[];
    tool_choice?: "none" | "auto";
    temperature?: number;
    max_output_tokens?: number;
    /** Groups requests for observability only. Explicitly NOT forwarded to the provider, so it is not memory. */
    conversation_id?: string;
    reasoning?: { effort?: "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" };
    thinking?: { type?: "enabled" | "disabled"; budget_tokens?: number };
    [k: string]: unknown;
  }) {
    return this.request<unknown>("POST", "/api/v1/responses", body);
  }

  /**
   * The 53 models Anuma actually curates, with tier and category metadata.
   *
   * This, not `/api/v1/models`, is the list worth showing an agent. Membership
   * here predicts routability: a curated id either works or fails with
   * `model_tier_required`, while an id that exists only in the 1007-entry
   * catalogue fails with `model_not_found`.
   */
  curatedModels() {
    return this.request<{ models: CuratedModel[] }>("GET", "/api/v1/curated-models");
  }

  /**
   * Preprocessors: structured data from a natural-language question, with no
   * model in the loop.
   *
   * Verified free 2026-09-21: three calls moved request_count, cost_usd and
   * the credit balance by exactly zero. They do not even register as requests.
   * The equivalent registry tools cost 1,000 to 5,000 micro-USD each AND need
   * an inference call to drive them, so for weather, prices and search this is
   * strictly the cheaper route.
   */
  preprocess(kind: "weather" | "crypto-prices" | "stock-prices" | "search", q: string, limit?: number) {
    const body: { q: string; limit?: number } = { q };
    if (typeof limit === "number") body.limit = limit;
    return this.request<unknown>("POST", `/api/v1/preprocessors/${kind}`, body);
  }

  /** Embeddings. Returns an `inference_id` alongside the vectors. */
  embed(body: { model: string; input: string | string[]; dimensions?: number }) {
    return this.request<unknown>("POST", "/api/v1/embeddings", body);
  }

  /*
   * Developer app management.
   *
   * This is the group that makes the funding story automatable. The per-user
   * limit that reads as a dead payment in the dashboard is a PATCH, and
   * allocating credits from the app pool is a POST. Both work with an ordinary
   * app key. `credits/purchase` returning 403 says only that credit PACKS
   * cannot be bought from the API; it says nothing about moving credits that
   * the app already holds.
   *
   * Throughout, 1 credit = $0.01.
   */
  listApps() {
    return this.request<{ apps: DeveloperApp[] }>("GET", "/api/v1/developer/apps");
  }

  listAppUsers(appUuid: string) {
    return this.request<unknown>("GET", `/api/v1/developer/apps/${encodeURIComponent(appUuid)}/users`);
  }

  appUsage(appUuid: string) {
    return this.request<unknown>("GET", `/api/v1/developer/apps/${encodeURIComponent(appUuid)}/usage`);
  }

  /** `default_user_credits` is the Per-User Limit the dashboard defaults to 0. */
  updateApp(appUuid: string, body: { name?: string; default_user_credits?: number; allowed_origins?: string[] }) {
    return this.request<unknown>("PATCH", `/api/v1/developer/apps/${encodeURIComponent(appUuid)}`, body);
  }

  /** Sets one user's spending ceiling. Does not move credits. */
  setUserLimit(appUuid: string, address: string, credits: number) {
    return this.request<unknown>(
      "PATCH",
      `/api/v1/developer/apps/${encodeURIComponent(appUuid)}/users/${encodeURIComponent(address)}`,
      { credits },
    );
  }

  /** Moves credits from the app pool to one user. This spends the app balance. */
  topUpUser(appUuid: string, address: string, credits: number) {
    return this.request<unknown>(
      "POST",
      `/api/v1/developer/apps/${encodeURIComponent(appUuid)}/users/${encodeURIComponent(address)}/top-up`,
      { credits },
    );
  }

  billingHistory() {
    return this.request<unknown>("GET", "/api/v1/developer/billing");
  }

  /** Anuma's own per-platform agent permission model. The mirror of this server's gate. */
  agentConsents() {
    return this.request<unknown>("GET", "/api/v1/user/agent-consents");
  }

  listAgents() {
    return this.request<unknown>("GET", "/api/v1/agents");
  }

  /** Connected third-party connectors, and the tools denied on them. */
  listConnectors() {
    return this.request<unknown>("GET", "/api/v1/connectors");
  }

  /** Server-side allow/deny for a connector's tools. The half of cost control the client cannot enforce. */
  connectorTools(provider: string) {
    return this.request<unknown>("GET", `/api/v1/connectors/${encodeURIComponent(provider)}/tools`);
  }

  /** Identity and scopes for the current credential. */
  me() {
    return this.request<unknown>("GET", "/api/v1/me");
  }

  /** Subscription tier, which determines which curated models are reachable. */
  subscriptionStatus() {
    return this.request<unknown>("GET", "/api/v1/subscriptions/status");
  }

  creditsBalance() {
    return this.request<unknown>("GET", "/api/v1/credits/balance");
  }

  /** ZETA -> credits conversion rate. The token leg of the Solana migration. */
  zetaCreditRate() {
    return this.request<unknown>("GET", "/api/v1/zeta/credit-rate");
  }

  zetaMarket() {
    return this.request<unknown>("GET", "/api/v1/zeta/market");
  }

  listTools() {
    return this.request<unknown>("GET", "/api/v1/tools");
  }

  /** Which agents the user has granted access, and to what. */
  agentGrants() {
    return this.request<unknown>("GET", "/api/v1/user/agent-grants");
  }

  usageByModality() {
    return this.request<unknown>("GET", "/api/v1/usage/by-modality");
  }

  /*
   * There is deliberately no redeemTokens() here.
   *
   * `anuma-ai/sdk` publishes `POST /api/v1/credits/redeem-tokens`, and the ZETA
   * credit rail is documented, but the path 404s on the live API as of 0.155.0.
   * `credits/redeem`, `credits/redeem_tokens`, `tokens/redeem` and `zeta/redeem`
   * 404 too, so there is currently no working crypto -> credits route. The
   * `0x` address on the balance response is an identifier, not a deposit
   * address; sending ZETA to it funds nothing.
   *
   * Shipping a method that posts to a dead path would turn a missing feature
   * into a runtime error at the worst moment, so the policy branch for
   * `anuma_redeem_tokens` stays in policy.ts (pre-classified, always escalates)
   * and the tool stays unregistered until the endpoint exists.
   */
}
