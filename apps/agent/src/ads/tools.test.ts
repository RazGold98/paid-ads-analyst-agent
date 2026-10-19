import { describe, expect, it } from "vitest";
import type { AdsApiClient } from "./client.js";
import { datesBetween } from "./dates.js";
import { comparePeriods } from "./tools.js";

// Only getInsights is called by comparePeriods; no rows is enough to check the periods.
const fakeClient = {
  getInsights: async () => ({ data: [], source: { endpoint: "/fake", params: {}, fetchedAt: "" } }),
} as unknown as AdsApiClient;

describe("comparePeriods", () => {
  it("caps days so both periods fit in the 30 available days and have equal length", async () => {
    const { result } = await comparePeriods(fakeClient, { days: 20 });
    expect(result.days).toBe(15);
    expect(datesBetween(result.current.period)).toHaveLength(15);
    expect(datesBetween(result.previous.period)).toHaveLength(15);
  });
});
