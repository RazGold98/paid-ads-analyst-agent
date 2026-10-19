import { afterEach, describe, expect, it, vi } from "vitest";
import { AdsApiClient, AdsApiError } from "./client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const campaigns = { data: [{ id: "cmp_a", name: "A" }] };

function makeClient(timeoutMs = 1000) {
  return new AdsApiClient({
    baseUrl: "http://mock.test",
    token: "test-token-1234567890",
    accountId: "act_1",
    timeoutMs,
    retryDelaysMs: [0, 0],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdsApiClient", () => {
  it("sends the bearer token and returns data with its source", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, campaigns));
    vi.stubGlobal("fetch", fetchMock);

    const { data, source } = await makeClient().listCampaigns();

    expect(data).toEqual(campaigns.data);
    expect(source.endpoint).toBe("/v1/accounts/act_1/campaigns");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://mock.test/v1/accounts/act_1/campaigns");
    expect(init.headers.authorization).toBe("Bearer test-token-1234567890");
  });

  it("retries a GET on 500 and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(500, { error: { code: "INTERNAL", message: "boom" } }))
      .mockResolvedValueOnce(json(200, campaigns));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().listCampaigns()).resolves.toMatchObject({ data: campaigns.data });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { error: { code: "UNAUTHORIZED", message: "bad token" } }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await makeClient().listCampaigns().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsApiError);
    expect(err).toMatchObject({ code: "UNAUTHORIZED", status: 401, retryable: false, message: "bad token" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports TIMEOUT when the server does not answer in time", async () => {
    // Never resolves; rejects only when the client aborts the request.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient(20).listCampaigns()).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    // Timeouts are retryable: 1 attempt + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
