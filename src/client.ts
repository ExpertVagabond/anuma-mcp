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

export class AnumaClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: AnumaClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANUMA_API_KEY;
    this.baseUrl = (opts.baseUrl ?? process.env.ANUMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
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
      // Observed 402 shape, verified 2026-09-20:
      // {"error":"insufficient_balance","code":"payment_required",
      //  "required_micro_usd":100,"available_micro_usd":0,"gate":"minimum"}
      const e = parsed as {
        error?: string;
        code?: string;
        trace_id?: string;
        required_micro_usd?: number;
        available_micro_usd?: number;
        gate?: string;
      };
      const billing =
        typeof e?.required_micro_usd === "number"
          ? {
              requiredMicroUsd: e.required_micro_usd,
              availableMicroUsd: e.available_micro_usd ?? 0,
              gate: e.gate ?? "unknown",
            }
          : undefined;
      throw new AnumaError(
        res.status,
        e?.code ?? "unknown",
        e?.error ?? `HTTP ${res.status}`,
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
   * Verified live 2026-09-21: a `messages` array is accepted, billed and
   * answered, but its text never reaches the model -- the completion comes
   * back addressed to an empty prompt. Both the OpenAI chat shape
   * (`content: "text"`) and the content-part shape (`content: [{type,text}]`)
   * are dropped the same silent way. There is no error to catch, so the only
   * safe move is to never send that field.
   *
   * `model` must be `provider/model`; a bare id is rejected on format.
   */
  respond(body: { model: string; input: string; [k: string]: unknown }) {
    return this.request<unknown>("POST", "/api/v1/responses", body);
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
