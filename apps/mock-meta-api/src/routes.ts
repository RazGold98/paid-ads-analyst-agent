import { createHash, timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { ACCOUNT, ADSETS, CAMPAIGNS, type AdSet, type AdSetDef } from "./data/entities.js";
import { generateInsights, getWindow } from "./data/generator.js";
import { logger } from "./logger.js";
import type { Store } from "./store.js";

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const expectedTokenHash = sha256(config.mockApiToken);

const requireAuth: RequestHandler = (req, res, next) => {
  const match = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
  // Hashing both sides gives timingSafeEqual equal-length inputs, so neither content nor length leaks.
  if (!match || !timingSafeEqual(sha256(match[1]), expectedTokenHash)) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid bearer token");
    return;
  }
  next();
};

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, "Not a valid calendar date");

const InsightsQuery = z
  .object({
    since: IsoDate.optional(),
    until: IsoDate.optional(),
    adset_id: z.string().optional(),
    campaign_id: z.string().optional(),
  })
  .refine((q) => !q.since || !q.until || q.since <= q.until, {
    message: "since must be on or before until",
    path: ["since"],
  });

const StatusBody = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });

export function createApp(store: Store): express.Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(requireAuth);
  app.use(express.json());

  app.param("accountId", (_req, res, next, accountId: string) => {
    if (accountId !== ACCOUNT.id) {
      sendError(res, 404, "NOT_FOUND", `Unknown account ${accountId}`);
      return;
    }
    next();
  });

  app.param("adsetId", (_req, res, next, adsetId: string) => {
    const adset = ADSETS.find((a) => a.id === adsetId);
    if (!adset) {
      sendError(res, 404, "NOT_FOUND", `Unknown ad set ${adsetId}`);
      return;
    }
    res.locals.adset = adset;
    next();
  });

  app.get("/v1/accounts/:accountId", (_req, res) => {
    res.json(ACCOUNT);
  });

  app.get("/v1/accounts/:accountId/campaigns", (_req, res) => {
    res.json({ data: CAMPAIGNS });
  });

  app.get("/v1/accounts/:accountId/adsets", async (req, res) => {
    const campaignId = typeof req.query.campaign_id === "string" ? req.query.campaign_id : undefined;
    const statuses = await store.getStatuses();
    const data: AdSet[] = ADSETS.filter((a) => !campaignId || a.campaign_id === campaignId).map((a) => ({
      ...a,
      status: statuses.get(a.id) ?? "ACTIVE",
    }));
    res.json({ data });
  });

  app.get("/v1/adsets/:adsetId", async (_req, res) => {
    const adset = res.locals.adset as AdSetDef;
    res.json({ ...adset, status: await store.getStatus(adset.id) } satisfies AdSet);
  });

  app.get("/v1/accounts/:accountId/insights", (req, res) => {
    const parsed = InsightsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_ERROR", describeIssues(parsed.error));
      return;
    }
    const query = parsed.data;
    const now = new Date();
    const window = getWindow(now);
    const warnings: string[] = [];

    let since = query.since ?? window.since;
    let until = query.until ?? window.until;
    if (since < window.since) {
      warnings.push(`since ${since} is before the available window; clamped to ${window.since}`);
      since = window.since;
    }
    if (until > window.until) {
      warnings.push(`until ${until} is after the available window; clamped to ${window.until}`);
      until = window.until;
    }

    // A range entirely outside the window clamps to since > until, which matches no rows.
    const data = generateInsights(now).filter(
      (row) =>
        row.date >= since &&
        row.date <= until &&
        (!query.adset_id || row.adset_id === query.adset_id) &&
        (!query.campaign_id || row.campaign_id === query.campaign_id),
    );
    res.json({ data, paging: { total: data.length }, ...(warnings.length > 0 && { warnings }) });
  });

  app.post("/v1/adsets/:adsetId/status", async (req, res) => {
    const adset = res.locals.adset as AdSetDef;
    const key = req.get("idempotency-key");
    if (!key) {
      sendError(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
      return;
    }

    const replay = await store.findIdempotent(key);
    if (replay) {
      res.status(replay.status).json(replay.body);
      return;
    }

    const body = StatusBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "VALIDATION_ERROR", describeIssues(body.error));
      return;
    }

    const { previous, updatedAt } = await store.setStatus(adset.id, body.data.status);
    const response = {
      id: adset.id,
      status: body.data.status,
      previous_status: previous,
      updated_at: updatedAt.toISOString(),
    };
    await store.saveIdempotent(key, adset.id, { status: 200, body: response });

    // FAILURE INJECTION: the write and the key are already saved, but the client sees an error.
    // Retrying with the same Idempotency-Key replays the stored 200 response.
    if (config.failPauseAdsetIds.has(adset.id)) {
      logger.warn({ adsetId: adset.id, key }, "Injected failure after status write");
      sendError(res, 500, "UPSTREAM_ERROR", "Simulated failure after write");
      return;
    }
    res.json(response);
  });

  app.post("/v1/admin/reset", async (_req, res) => {
    await store.reset();
    res.json({ status: "ok" });
  });

  app.use((_req, res) => {
    sendError(res, 404, "NOT_FOUND", "Route not found");
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      sendError(res, 400, "INVALID_JSON", "Request body is not valid JSON");
      return;
    }
    logger.error({ err }, "Unhandled error");
    sendError(res, 500, "INTERNAL", "Internal server error");
  };
  app.use(onError);

  return app;
}
