import { z } from "zod";
import type { AdSet, AdSetStatus, Campaign, RawInsightRow, Source } from "./types.js";

export type AdsApiErrorCode = "UNAUTHORIZED" | "NOT_FOUND" | "TIMEOUT" | "NETWORK" | "UPSTREAM" | "BAD_REQUEST";

export class AdsApiError extends Error {
  readonly code: AdsApiErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(opts: { code: AdsApiErrorCode; message: string; status?: number; retryable: boolean }) {
    super(opts.message);
    this.name = "AdsApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

export interface AdsApiClientOptions {
  baseUrl: string;
  token: string;
  accountId: string;
  timeoutMs?: number;
  // One entry per retry; tests pass zeros to run fast.
  retryDelaysMs?: number[];
}

export interface Fetched<T> {
  data: T;
  source: Source;
}

// Permissive on purpose: bad values are reported by cleanRows, not rejected here.
const NumberLike = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);

const CampaignSchema = z.object({ id: z.string(), name: z.string() });

const AdSetSchema = z
  .object({
    id: z.string(),
    campaign_id: z.string(),
    name: z.string(),
    daily_budget: z.number(),
    status: z.enum(["ACTIVE", "PAUSED"]),
  })
  .transform(
    (a): AdSet => ({
      id: a.id,
      campaignId: a.campaign_id,
      name: a.name,
      dailyBudget: a.daily_budget,
      status: a.status,
    }),
  );

const RawInsightRowSchema: z.ZodType<RawInsightRow> = z.object({
  date: z.string(),
  campaign_id: z.string(),
  adset_id: z.string(),
  adset_name: z.string(),
  impressions: NumberLike,
  reach: NumberLike,
  clicks: NumberLike,
  spend: NumberLike,
  conversions: NumberLike,
  conversion_value: NumberLike.nullable(),
});

const StatusResponseSchema = z.object({
  id: z.string(),
  status: z.enum(["ACTIVE", "PAUSED"]),
  previous_status: z.enum(["ACTIVE", "PAUSED"]),
});

const listOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorFromStatus(status: number, message: string): AdsApiError {
  if (status === 401 || status === 403) return new AdsApiError({ code: "UNAUTHORIZED", status, message, retryable: false });
  if (status === 404) return new AdsApiError({ code: "NOT_FOUND", status, message, retryable: false });
  if (status >= 500) return new AdsApiError({ code: "UPSTREAM", status, message, retryable: true });
  return new AdsApiError({ code: "BAD_REQUEST", status, message, retryable: false });
}

/** Read-only client for the (mock) Meta Ads API. */
export class AdsApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly accountId: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];

  constructor(opts: AdsApiClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.accountId = opts.accountId;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [300, 900];
  }

  async listCampaigns(): Promise<Fetched<Campaign[]>> {
    const { data, source } = await this.get(`/v1/accounts/${this.accountId}/campaigns`, {}, listOf(CampaignSchema));
    return { data: data.data, source };
  }

  async listAdSets(campaignId?: string): Promise<Fetched<AdSet[]>> {
    const { data, source } = await this.get(
      `/v1/accounts/${this.accountId}/adsets`,
      { campaign_id: campaignId },
      listOf(AdSetSchema),
    );
    return { data: data.data, source };
  }

  getAdSet(id: string): Promise<Fetched<AdSet>> {
    return this.get(`/v1/adsets/${encodeURIComponent(id)}`, {}, AdSetSchema);
  }

  async getInsights(params: {
    since?: string;
    until?: string;
    adsetId?: string;
    campaignId?: string;
  }): Promise<Fetched<RawInsightRow[]>> {
    const { data, source } = await this.get(
      `/v1/accounts/${this.accountId}/insights`,
      { since: params.since, until: params.until, adset_id: params.adsetId, campaign_id: params.campaignId },
      listOf(RawInsightRowSchema),
    );
    return { data: data.data, source };
  }

  /**
   * Changes an ad set's status. Sent once, never retried here: after an error the caller reads the
   * real status instead (see actions/pause.ts). The idempotency key makes an accidental resend harmless.
   */
  async setAdSetStatus(
    id: string,
    status: AdSetStatus,
    idempotencyKey: string,
  ): Promise<Fetched<{ status: AdSetStatus; previousStatus: AdSetStatus }>> {
    const endpoint = `/v1/adsets/${encodeURIComponent(id)}/status`;
    const body = await this.request(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ status }),
    });
    const parsed = StatusResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AdsApiError({ code: "UPSTREAM", message: `Unexpected response from ${endpoint}`, retryable: false });
    }
    return {
      data: { status: parsed.data.status, previousStatus: parsed.data.previous_status },
      source: { endpoint, params: { status }, fetchedAt: new Date().toISOString() },
    };
  }

  /** GET with retries on network errors, timeouts and 5xx (never on 4xx). */
  private async get<S extends z.ZodType>(
    endpoint: string,
    rawParams: Record<string, string | undefined>,
    schema: S,
  ): Promise<Fetched<z.output<S>>> {
    const params = Object.fromEntries(
      Object.entries(rawParams).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const query = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${endpoint}${query ? `?${query}` : ""}`;

    for (let attempt = 0; ; attempt++) {
      try {
        const body = await this.request(url);
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new AdsApiError({
            code: "UPSTREAM",
            message: `Unexpected response from ${endpoint}: ${issue.path.join(".")}: ${issue.message}`,
            retryable: false,
          });
        }
        return { data: parsed.data, source: { endpoint, params, fetchedAt: new Date().toISOString() } };
      } catch (err) {
        const delay = this.retryDelaysMs[attempt];
        if (!(err instanceof AdsApiError) || !err.retryable || delay === undefined) throw err;
        await sleep(delay);
      }
    }
  }

  /** One HTTP attempt with a timeout; returns the parsed JSON body or throws AdsApiError. */
  private async request(
    url: string,
    init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: init.method ?? "GET",
          headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...init.headers },
          body: init.body,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AdsApiError({ code: "TIMEOUT", message: `No response within ${this.timeoutMs}ms`, retryable: true });
        }
        throw new AdsApiError({ code: "NETWORK", message: `Network error: ${(err as Error).message}`, retryable: true });
      }

      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
        throw errorFromStatus(res.status, message.success ? message.data.error.message : `HTTP ${res.status}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
