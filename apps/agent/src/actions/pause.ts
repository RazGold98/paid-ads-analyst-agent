import { randomBytes } from "node:crypto";
import { AdsApiError, type AdsApiClient } from "../ads/client.js";
import { daysAgo } from "../ads/dates.js";
import type { AdsTools } from "../ads/index.js";
import type { ActionRequest, ActionStore, Requester } from "./store.js";

// Long enough for the team to look and decide; after that the data may have changed, so ask again.
export const REQUEST_TTL_MS = 2 * 60 * 60 * 1000;

export interface PauseDeps {
  store: ActionStore;
  client: Pick<AdsApiClient, "getAdSet" | "setAdSetStatus">;
  ads: Pick<AdsTools, "getPerformance">;
  now?: () => Date;
}

type Approver = { userId: number; name: string };
export type Outcome = { ok: true; request: ActionRequest } | { ok: false; error: string };

const newId = () => randomBytes(3).toString("hex").toUpperCase(); // e.g. "4F9A1C"
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Creates a pending pause request. Nothing is changed in the ad account here.
 * The numbers on the approval card come from the API, read by this code, not from the model.
 */
export async function proposePause(
  deps: PauseDeps,
  args: { adsetId: string; reason: string; requestedBy: Requester },
): Promise<Outcome & { created?: boolean }> {
  const now = deps.now?.() ?? new Date();

  let adset;
  try {
    adset = (await deps.client.getAdSet(args.adsetId)).data;
  } catch (err) {
    if (err instanceof AdsApiError && err.code === "NOT_FOUND") return { ok: false, error: `Unknown ad set ${args.adsetId}` };
    return { ok: false, error: `Could not read the ad set: ${errorText(err)}` };
  }
  if (adset.status === "PAUSED") return { ok: false, error: `${adset.id} is already paused` };

  // One open request per ad set: asking twice returns the same request instead of a duplicate.
  const existing = await deps.store.findPending(adset.id, now);
  if (existing) return { ok: true, request: existing, created: false };

  const perf = await deps.ads.getPerformance({ adsetId: adset.id, since: daysAgo(7, now), until: daysAgo(1, now) });
  const { summary, sampleSize } = perf.result;

  const request: ActionRequest = {
    _id: newId(),
    type: "pause_adset",
    adsetId: adset.id,
    reason: args.reason,
    snapshot: {
      adsetName: adset.name,
      status: adset.status,
      dailyBudget: adset.dailyBudget,
      period: perf.result.period,
      spend: summary.spend,
      conversions: summary.conversions,
      cpa: summary.cpa,
      roas: summary.roas,
      lowSample: sampleSize.lowSample,
    },
    requestedBy: args.requestedBy,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    cards: [],
  };
  await deps.store.create(request);
  await deps.store.log({ requestId: request._id, event: "created", by: args.requestedBy.name, detail: args.reason, at: now });
  return { ok: true, request, created: true };
}

/** A human approved: re-check, pause, and confirm the real result by reading the status back. */
export async function approvePause(deps: PauseDeps, id: string, approver: Approver): Promise<Outcome> {
  const now = deps.now?.() ?? new Date();
  if (!(await deps.store.isApprover(approver.userId))) return { ok: false, error: "You are not registered as an approver." };

  const request = await deps.store.claim(id, approver, now);
  if (!request) return { ok: false, error: await whyNotPending(deps, id, now) };
  await deps.store.log({ requestId: id, event: "approved", by: approver.name, at: now });

  const finish = async (status: "succeeded" | "failed" | "unknown", result: string): Promise<Outcome> => {
    const done = await deps.store.finish(id, status, result, deps.now?.() ?? new Date());
    await deps.store.log({ requestId: id, event: status, detail: result, at: deps.now?.() ?? new Date() });
    return done ? { ok: true, request: done } : { ok: false, error: `Request ${id} disappeared` };
  };

  // Re-check right before acting: someone may have paused it by hand since the request was made.
  try {
    const current = (await deps.client.getAdSet(request.adsetId)).data;
    if (current.status === "PAUSED") return finish("succeeded", "The ad set was already paused; nothing to do.");
  } catch (err) {
    return finish("failed", `Could not check the current status, so nothing was changed: ${errorText(err)}`);
  }

  try {
    await deps.client.setAdSetStatus(request.adsetId, "PAUSED", `pause-${id}`);
  } catch (err) {
    // The API reported an error, but the change may still have been applied. Read the real state.
    return reconcile(deps, request, errorText(err), finish);
  }

  // Trust but verify: confirm the success response matches the real state.
  return reconcile(deps, request, null, finish);
}

async function reconcile(
  deps: PauseDeps,
  request: ActionRequest,
  apiError: string | null,
  finish: (status: "succeeded" | "failed" | "unknown", result: string) => Promise<Outcome>,
): Promise<Outcome> {
  try {
    const { status } = (await deps.client.getAdSet(request.adsetId)).data;
    if (status === "PAUSED") {
      return finish("succeeded", apiError ? `The API returned an error (${apiError}), but the ad set is paused.` : "Paused and confirmed.");
    }
    return finish("failed", apiError ? `Not paused: ${apiError}` : "The API reported success, but the ad set is still active.");
  } catch (err) {
    return finish("unknown", `Could not confirm the result (${errorText(err)}). Check the ad set in Ads Manager before retrying.`);
  }
}

export async function rejectPause(deps: PauseDeps, id: string, approver: Approver): Promise<Outcome> {
  const now = deps.now?.() ?? new Date();
  if (!(await deps.store.isApprover(approver.userId))) return { ok: false, error: "You are not registered as an approver." };

  const request = await deps.store.reject(id, approver, now);
  if (!request) return { ok: false, error: await whyNotPending(deps, id, now) };
  await deps.store.log({ requestId: id, event: "rejected", by: approver.name, at: now });
  return { ok: true, request };
}

/** Explains why a request can no longer be decided, and marks it expired if that is the reason. */
async function whyNotPending(deps: PauseDeps, id: string, now: Date): Promise<string> {
  const request = await deps.store.get(id);
  if (!request) return `Request ${id} not found.`;
  if (request.status === "pending" && request.expiresAt <= now) {
    await deps.store.expire(id);
    await deps.store.log({ requestId: id, event: "expired", at: now });
    return `Request ${id} expired. Ask the agent again if it is still needed.`;
  }
  return `Request ${id} was already handled (${request.status}).`;
}
