import { describe, expect, it } from "vitest";
import { cleanRows } from "./clean.js";
import type { RawInsightRow } from "./types.js";

const raw = (overrides: Partial<RawInsightRow> = {}): RawInsightRow => ({
  date: "2026-06-01",
  campaign_id: "cmp_a",
  adset_id: "as_a",
  adset_name: "A",
  impressions: 1000,
  reach: 600,
  clicks: 20,
  spend: 50,
  conversions: 2,
  conversion_value: 120,
  ...overrides,
});

const oneDay = { since: "2026-06-01", until: "2026-06-01" };

describe("cleanRows", () => {
  it("passes a clean row through without issues", () => {
    const { rows, issues } = cleanRows([raw()], oneDay);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        date: "2026-06-01",
        campaignId: "cmp_a",
        adsetId: "as_a",
        adsetName: "A",
        impressions: 1000,
        reach: 600,
        clicks: 20,
        spend: 50,
        conversions: 2,
        conversionValue: 120,
      },
    ]);
  });

  it("keeps the first of duplicate rows", () => {
    const { rows, issues } = cleanRows([raw({ spend: 50 }), raw({ spend: 99 })], oneDay);
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBe(50);
    expect(issues).toMatchObject([{ type: "duplicate_row", adsetId: "as_a", date: "2026-06-01" }]);
  });

  it("reports a missing day without fabricating a row", () => {
    const period = { since: "2026-06-01", until: "2026-06-03" };
    const { rows, issues } = cleanRows([raw({ date: "2026-06-01" }), raw({ date: "2026-06-03" })], period);
    expect(rows.map((r) => r.date)).toEqual(["2026-06-01", "2026-06-03"]);
    expect(issues).toMatchObject([{ type: "missing_day", adsetId: "as_a", date: "2026-06-02" }]);
  });

  it("parses numeric strings and reports them", () => {
    const { rows, issues } = cleanRows([raw({ spend: "11.40" })], oneDay);
    expect(rows[0].spend).toBe(11.4);
    expect(issues).toMatchObject([{ type: "string_number", adsetId: "as_a" }]);
  });

  it("keeps a row with null conversion_value as unknown", () => {
    const { rows, issues } = cleanRows([raw({ conversion_value: null })], oneDay);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversionValue).toBeNull();
    expect(issues).toMatchObject([{ type: "null_value", adsetId: "as_a" }]);
  });

  it("turns negative spend into null, not 0", () => {
    const { rows, issues } = cleanRows([raw({ spend: -12.5 })], oneDay);
    expect(rows[0].spend).toBeNull();
    expect(issues).toMatchObject([{ type: "negative_value", adsetId: "as_a" }]);
  });

  it("flags a date where every ad set has 0 conversions but clicks", () => {
    const { issues } = cleanRows(
      [raw({ conversions: 0, conversion_value: 0 }), raw({ adset_id: "as_b", conversions: 0, conversion_value: 0 })],
      oneDay,
    );
    expect(issues).toEqual([expect.objectContaining({ type: "suspected_tracking_outage", date: "2026-06-01" })]);
    expect(issues[0].adsetId).toBeUndefined();
  });

  it("does not flag an outage when one ad set still converts, or only one ad set is present", () => {
    const zero = { conversions: 0, conversion_value: 0 };
    expect(cleanRows([raw(zero), raw({ adset_id: "as_b" })], oneDay).issues).toEqual([]);
    expect(cleanRows([raw(zero)], oneDay).issues).toEqual([]);
  });

  it("never fabricates rows", () => {
    const period = { since: "2026-06-01", until: "2026-06-10" };
    const input = [raw(), raw(), raw({ date: "2026-06-05", spend: -1 }), raw({ date: "2026-06-09", conversion_value: null })];
    const { rows } = cleanRows(input, period);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-06-01", "2026-06-05", "2026-06-09"]));
  });
});
