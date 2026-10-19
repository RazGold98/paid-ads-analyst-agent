import { describe, expect, it, vi } from "vitest";
import { AdsApiError } from "../ads/client.js";
import type { AdSet, AdSetStatus } from "../ads/types.js";
import { approvePause, proposePause, rejectPause, REQUEST_TTL_MS, type PauseDeps } from "./pause.js";
import type { ActionRequest, ActionStore, Approver, AuditEntry } from "./store.js";

/** In-memory ActionStore with the same conditional updates as the Mongo one. */
function memoryStore(): ActionStore & { audit: AuditEntry[] } {
  const requests = new Map<string, ActionRequest>();
  const approvers = new Map<number, Approver>();
  const audit: AuditEntry[] = [];
  const update = (id: string, when: (r: ActionRequest) => boolean, change: Partial<ActionRequest>) => {
    const r = requests.get(id);
    if (!r || !when(r)) return null;
    const next = { ...r, ...change };
    requests.set(id, next);
    return next;
  };
  return {
    audit,
    create: async (r) => void requests.set(r._id, r),
    get: async (id) => requests.get(id) ?? null,
    findPending: async (adsetId, now) =>
      [...requests.values()].find((r) => r.adsetId === adsetId && r.status === "pending" && r.expiresAt > now) ?? null,
    claim: async (id, by, now) =>
      update(id, (r) => r.status === "pending" && r.expiresAt > now, { status: "executing", decidedBy: by, decidedAt: now }),
    reject: async (id, by, now) => update(id, (r) => r.status === "pending", { status: "rejected", decidedBy: by, decidedAt: now }),
    expire: async (id) => void update(id, (r) => r.status === "pending", { status: "expired" }),
    finish: async (id, status, result, now) => update(id, () => true, { status, result, finishedAt: now }),
    addCard: async (id, card) => void update(id, () => true, { cards: [...(requests.get(id)?.cards ?? []), card] }),
    log: async (entry) => void audit.push(entry),
    addApprover: async (a) => void approvers.set(a._id, a),
    isApprover: async (userId) => approvers.has(userId),
    listApprovers: async () => [...approvers.values()],
  };
}

const source = { endpoint: "/fake", params: {}, fetchedAt: "" };
const adset = (status: AdSetStatus): AdSet => ({ id: "as_broad_image", campaignId: "cmp", name: "Broad", dailyBudget: 350, status });

/** A fake Ads API: `statuses` are returned by successive getAdSet calls; `pause` decides what the POST does. */
function fakeClient(statuses: (AdSetStatus | Error)[], pause: () => Promise<unknown> = async () => ({})) {
  const queue = [...statuses];
  return {
    getAdSet: vi.fn(async () => {
      const next = queue.shift() ?? "ACTIVE";
      if (next instanceof Error) throw next;
      return { data: adset(next), source };
    }),
    setAdSetStatus: vi.fn(async () => {
      await pause();
      return { data: { status: "PAUSED" as const, previousStatus: "ACTIVE" as const }, source };
    }),
  };
}

const perf = {
  getPerformance: async () => ({
    result: {
      period: { since: "2026-10-12", until: "2026-10-18" },
      summary: { spend: 1896.81, conversions: 9, cpa: 210.76, roas: 0.28 },
      sampleSize: { lowSample: true },
    },
  }),
} as unknown as PauseDeps["ads"];

const approver = { userId: 1, name: "Dana" };
const requester = { channel: "telegram" as const, name: "Raz", chatId: 99 };
const now = new Date("2026-10-19T12:00:00Z");

async function setup(statuses: (AdSetStatus | Error)[], pause?: () => Promise<unknown>) {
  const store = memoryStore();
  await store.addApprover({ _id: approver.userId, name: approver.name, chatId: 1, registeredAt: now });
  const client = fakeClient(statuses, pause);
  const deps: PauseDeps = { store, client, ads: perf, now: () => now };
  const proposed = await proposePause(deps, { adsetId: "as_broad_image", reason: "CPA 210, 9 conversions", requestedBy: requester });
  if (!proposed.ok) throw new Error(proposed.error);
  return { store, client, deps, id: proposed.request._id, request: proposed.request };
}

describe("proposePause", () => {
  it("creates a pending request with numbers read from the API, and pauses nothing", async () => {
    const { client, request } = await setup(["ACTIVE"]);
    expect(request).toMatchObject({ status: "pending", adsetId: "as_broad_image", snapshot: { cpa: 210.76, dailyBudget: 350 } });
    expect(request.expiresAt.getTime() - now.getTime()).toBe(REQUEST_TTL_MS);
    expect(client.setAdSetStatus).not.toHaveBeenCalled();
  });

  it("returns the existing request instead of creating a duplicate", async () => {
    const { deps, id } = await setup(["ACTIVE", "ACTIVE"]);
    const again = await proposePause(deps, { adsetId: "as_broad_image", reason: "again please", requestedBy: requester });
    expect(again).toMatchObject({ ok: true, created: false, request: { _id: id } });
  });

  it("refuses an ad set that is already paused", async () => {
    const store = memoryStore();
    const deps: PauseDeps = { store, client: fakeClient(["PAUSED"]), ads: perf, now: () => now };
    const out = await proposePause(deps, { adsetId: "as_broad_image", reason: "CPA 210, 9 conversions", requestedBy: requester });
    expect(out).toEqual({ ok: false, error: "as_broad_image is already paused" });
  });
});

describe("approvePause", () => {
  it("pauses with an idempotency key and confirms by reading the status back", async () => {
    // getAdSet: propose, re-check before acting, confirm after.
    const { client, deps, id } = await setup(["ACTIVE", "ACTIVE", "PAUSED"]);
    const out = await approvePause(deps, id, approver);
    expect(out).toMatchObject({ ok: true, request: { status: "succeeded", result: "Paused and confirmed." } });
    expect(client.setAdSetStatus).toHaveBeenCalledWith("as_broad_image", "PAUSED", `pause-${id}`);
  });

  it("reports success when the API fails halfway but the ad set is actually paused", async () => {
    const halfway = async () => {
      throw new AdsApiError({ code: "UPSTREAM", status: 500, message: "Simulated failure after write", retryable: true });
    };
    const { deps, id } = await setup(["ACTIVE", "ACTIVE", "PAUSED"], halfway);
    const out = await approvePause(deps, id, approver);
    expect(out).toMatchObject({ ok: true, request: { status: "succeeded" } });
    if (out.ok) expect(out.request.result).toContain("returned an error");
  });

  it("reports failure when the API fails and the ad set is still active", async () => {
    const fails = async () => {
      throw new AdsApiError({ code: "UPSTREAM", status: 500, message: "boom", retryable: true });
    };
    const { deps, id } = await setup(["ACTIVE", "ACTIVE", "ACTIVE"], fails);
    expect(await approvePause(deps, id, approver)).toMatchObject({ ok: true, request: { status: "failed" } });
  });

  it("reports unknown when the result cannot be confirmed", async () => {
    const timeout = new AdsApiError({ code: "TIMEOUT", message: "No response", retryable: true });
    const { deps, id } = await setup(["ACTIVE", "ACTIVE", timeout], async () => {
      throw timeout;
    });
    expect(await approvePause(deps, id, approver)).toMatchObject({ ok: true, request: { status: "unknown" } });
  });

  it("does nothing if someone already paused it by hand", async () => {
    const { client, deps, id } = await setup(["ACTIVE", "PAUSED"]);
    expect(await approvePause(deps, id, approver)).toMatchObject({ ok: true, request: { status: "succeeded" } });
    expect(client.setAdSetStatus).not.toHaveBeenCalled();
  });

  it("runs the action only once when approved twice", async () => {
    const { client, deps, id } = await setup(["ACTIVE", "ACTIVE", "PAUSED"]);
    await approvePause(deps, id, approver);
    const second = await approvePause(deps, id, approver);
    expect(second).toEqual({ ok: false, error: `Request ${id} was already handled (succeeded).` });
    expect(client.setAdSetStatus).toHaveBeenCalledTimes(1);
  });

  it("refuses someone who is not a registered approver", async () => {
    const { client, deps, id } = await setup(["ACTIVE"]);
    const out = await approvePause(deps, id, { userId: 2, name: "Stranger" });
    expect(out).toEqual({ ok: false, error: "You are not registered as an approver." });
    expect(client.setAdSetStatus).not.toHaveBeenCalled();
  });

  it("refuses an expired request and marks it expired", async () => {
    const { client, deps, store, id } = await setup(["ACTIVE"]);
    const later = new Date(now.getTime() + REQUEST_TTL_MS + 1);
    const out = await approvePause({ ...deps, now: () => later }, id, approver);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect((await store.get(id))?.status).toBe("expired");
    expect(client.setAdSetStatus).not.toHaveBeenCalled();
  });

  it("writes every step to the audit log", async () => {
    const { deps, store, id } = await setup(["ACTIVE", "ACTIVE", "PAUSED"]);
    await approvePause(deps, id, approver);
    expect(store.audit.map((e) => e.event)).toEqual(["created", "approved", "succeeded"]);
  });
});

describe("rejectPause", () => {
  it("rejects without touching the ad set, and cannot be approved afterwards", async () => {
    const { client, deps, id } = await setup(["ACTIVE"]);
    expect(await rejectPause(deps, id, approver)).toMatchObject({ ok: true, request: { status: "rejected" } });
    expect(await approvePause(deps, id, approver)).toMatchObject({ ok: false });
    expect(client.setAdSetStatus).not.toHaveBeenCalled();
  });
});
