import { describe, expect, it } from "vitest";
import { compare, sampleSize, summarize } from "./metrics.js";
import type { DailyRow } from "./types.js";

const row = (overrides: Partial<DailyRow> = {}): DailyRow => ({
  date: "2026-06-01",
  campaignId: "cmp_a",
  adsetId: "as_a",
  adsetName: "A",
  impressions: 1000,
  reach: 600,
  clicks: 20,
  spend: 100,
  conversions: 4,
  conversionValue: 400,
  ...overrides,
});

describe("summarize", () => {
  it("returns null instead of Infinity/NaN when dividing by zero", () => {
    const s = summarize([row({ impressions: 0, clicks: 0, conversions: 0, spend: 0, conversionValue: 0 })]);
    expect(s).toMatchObject({ ctr: null, cpc: null, cpm: null, cpa: null, roas: null });
    expect(summarize([])).toMatchObject({ spend: 0, ctr: null, cpa: null, roas: null, days: 0 });
  });

  it("computes ratios from totals", () => {
    const s = summarize([row(), row({ date: "2026-06-02" })]);
    expect(s).toMatchObject({ spend: 200, conversions: 8, cpa: 25, roas: 4, ctr: 0.02, cpc: 5, cpm: 100, days: 2 });
  });

  it("counts rows with unknown spend as excluded instead of treating them as 0", () => {
    const s = summarize([row(), row({ date: "2026-06-02", spend: null, conversions: 6 })]);
    expect(s.excludedSpendDays).toBe(1);
    expect(s.spend).toBe(100);
    // CPA uses only the row with known spend: 100 / 4, not 100 / 10.
    expect(s.cpa).toBe(25);
  });

  it("counts rows with unknown conversion value as excluded from ROAS", () => {
    const s = summarize([row(), row({ date: "2026-06-02", conversionValue: null })]);
    expect(s.excludedValueDays).toBe(1);
    // ROAS uses only the row with a known value: 400 / 100, not 400 / 200.
    expect(s.roas).toBe(4);
  });
});

describe("summarize frequency", () => {
  it("is total impressions over total daily reach, and null without reach", () => {
    // 1000/500 = 2.0 and 3000/1000 = 3.0 give (1000 + 3000) / (500 + 1000) = 2.67, weighted by reach.
    const s = summarize([row({ impressions: 1000, reach: 500 }), row({ date: "2026-06-02", impressions: 3000, reach: 1000 })]);
    expect(s.frequency).toBeCloseTo(2.667, 3);
    expect(summarize([]).frequency).toBeNull();
  });

  it("is compared between periods, so a rise can be reported", () => {
    const changes = compare(summarize([row({ reach: 300 })]), summarize([row({ reach: 600 })]));
    expect(changes.frequency.changePct).toBeCloseTo(100);
  });
});

describe("summarize with a tracking outage", () => {
  const normal = row({ date: "2026-06-01" });
  const outage = row({ date: "2026-06-02", conversions: 0, conversionValue: 0 });
  const outageDates = new Set(["2026-06-02"]);

  it("excludes outage days from conversions, CPA and ROAS", () => {
    const s = summarize([normal, outage], outageDates);
    // Without the exclusion CPA would be 200 / 4 = 50 and ROAS 400 / 200 = 2.
    expect(s).toMatchObject({ conversions: 4, conversionValue: 400, cpa: 25, roas: 4, excludedOutageDays: 1 });
  });

  it("still counts outage days toward spend, impressions and clicks", () => {
    const s = summarize([normal, outage], outageDates);
    expect(s).toMatchObject({ spend: 200, impressions: 2000, clicks: 40, ctr: 0.02, excludedOutageDays: 1 });
  });

  it("counts nothing as an outage when no outage dates are given", () => {
    expect(summarize([normal, outage]).excludedOutageDays).toBe(0);
  });
});

describe("compare", () => {
  it("computes percent change and null when previous is 0 or null", () => {
    const current = summarize([row({ spend: 150, conversions: 3 })]);
    const previous = summarize([row({ spend: 100, conversions: 4 })]);
    const changes = compare(current, previous);
    expect(changes.spend).toEqual({ current: 150, previous: 100, changePct: 50 });
    expect(changes.cpa.changePct).toBe(100);
    expect(changes.conversions.changePct).toBe(-25);

    const empty = summarize([]);
    expect(compare(current, empty).spend.changePct).toBeNull();
    expect(compare(current, empty).cpa.changePct).toBeNull();
  });
});

describe("sampleSize", () => {
  it("marks fewer than 10 conversions as a low sample", () => {
    expect(sampleSize(summarize([row({ conversions: 9 })]))).toEqual({ clicks: 20, conversions: 9, lowSample: true });
    expect(sampleSize(summarize([row({ conversions: 10 })])).lowSample).toBe(false);
  });
});
