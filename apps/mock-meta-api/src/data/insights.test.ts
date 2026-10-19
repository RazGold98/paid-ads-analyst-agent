import { describe, expect, it } from "vitest";
import { ADSETS } from "./entities.js";
import { dateDaysAgo, getInsights, getWindow } from "./insights.js";

const NOW = new Date("2026-06-15T13:45:00Z");
const rows = getInsights(NOW);

const day = (daysAgo: number) => dateDaysAgo(NOW, daysAgo);
/** Rows for one ad set from `fromDaysAgo` to `toDaysAgo` inclusive (from >= to). */
const rowsFor = (adsetId: string, fromDaysAgo: number, toDaysAgo: number) =>
  rows.filter((r) => r.adset_id === adsetId && r.date >= day(fromDaysAgo) && r.date <= day(toDaysAgo));
const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe("getInsights", () => {
  it("is deterministic for the same day", () => {
    expect(getInsights(new Date("2026-06-15T00:00:01Z"))).toEqual(rows);
    expect(getInsights(new Date(NOW))).toEqual(rows);
  });

  it("rolls the same fixture rows forward one date per day", () => {
    const nextDay = getInsights(new Date("2026-06-16T09:00:00Z"));
    expect(nextDay.map(({ date: _, ...rest }) => rest)).toEqual(rows.map(({ date: _, ...rest }) => rest));
    expect(nextDay.at(-1)?.date).toBe("2026-06-15");
  });

  it("covers the 30 days ending yesterday (UTC)", () => {
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe("2026-05-16");
    expect(dates.at(-1)).toBe("2026-06-14");
    expect(getWindow(NOW)).toEqual({ since: "2026-05-16", until: "2026-06-14" });
  });

  it("shows creative fatigue on as_women_video", () => {
    const before = rowsFor("as_women_video", 30, 8);
    const last7 = rowsFor("as_women_video", 7, 1);
    const ctr = (list: typeof rows) => avg(list.map((r) => r.clicks / r.impressions));
    const freq = (list: typeof rows) => avg(list.map((r) => r.frequency));
    expect(ctr(last7)).toBeLessThan(ctr(before));
    expect(freq(last7)).toBeGreaterThan(freq(before));
  });

  it("shows as_broad_image burning budget in the last 5 days", () => {
    const last5 = rowsFor("as_broad_image", 5, 1);
    expect(last5).toHaveLength(5);
    expect(last5.reduce((sum, r) => sum + r.conversions, 0)).toBeLessThanOrEqual(5);
    for (const r of last5) expect(Number(r.spend)).toBeGreaterThan(250);
  });

  it("has a tracking outage on d=10 for every ad set", () => {
    const outage = rows.filter((r) => r.date === day(10));
    expect(outage).toHaveLength(ADSETS.length);
    for (const r of outage) {
      expect(r.conversions).toBe(0);
      expect(r.conversion_value).toBe(0);
      expect(r.impressions).toBeGreaterThan(0);
    }
  });

  describe("data defects", () => {
    it("as_men_carousel is missing d=12", () => {
      expect(rowsFor("as_men_carousel", 12, 12)).toHaveLength(0);
      expect(rowsFor("as_men_carousel", 30, 1)).toHaveLength(29);
    });

    it("as_site_visitors has d=9 twice", () => {
      const dup = rowsFor("as_site_visitors", 9, 9);
      expect(dup).toHaveLength(2);
      expect(dup[0]).toEqual(dup[1]);
    });

    it("as_lookalike conversion_value is null on d=4", () => {
      expect(rowsFor("as_lookalike", 4, 4)[0].conversion_value).toBeNull();
    });

    it("as_broad_image spend is negative on d=20", () => {
      expect(rowsFor("as_broad_image", 20, 20)[0].spend).toBe(-12.5);
    });

    it("as_cart spend is a string on d=3", () => {
      const spend = rowsFor("as_cart", 3, 3)[0].spend;
      expect(typeof spend).toBe("string");
      expect(spend).toMatch(/^\d+\.\d{2}$/);
    });
  });
});
