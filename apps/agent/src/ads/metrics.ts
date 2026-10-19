import type { DailyRow } from "./types.js";

// Below this many conversions, CPA and ROAS are too noisy to draw conclusions from.
const MIN_CONVERSIONS = 10;

export interface Summary {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  // Ratios are null when the denominator is 0. ctr is a fraction (0.018 = 1.8%).
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
  days: number;
  // Rows whose spend was unknown, left out of spend-based metrics.
  excludedSpendDays: number;
  // Rows whose conversion value was unknown, left out of ROAS.
  excludedValueDays: number;
  // Rows on suspected tracking-outage dates, left out of conversions, conversion value, CPA and ROAS.
  excludedOutageDays: number;
}

export type ComparedMetric = "spend" | "ctr" | "cpa" | "roas" | "conversions";

export interface Change {
  current: number | null;
  previous: number | null;
  // Percent change, e.g. 25 = +25%. null when there is nothing to compare against.
  changePct: number | null;
}

const sum = (rows: DailyRow[], pick: (row: DailyRow) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0);

/** a / b, or null when b is 0 (never Infinity or NaN). */
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/**
 * Totals and ratios for a set of rows. Rows on `outageDates` (suspected tracking outages) still count
 * toward spend, impressions and clicks, but not toward conversions, conversion value, CPA or ROAS.
 */
export function summarize(rows: DailyRow[], outageDates: ReadonlySet<string> = new Set()): Summary {
  // Spend-based metrics only use rows where spend is known, for numerator and denominator alike.
  const withSpend = rows.filter((r) => r.spend !== null);
  // Conversion-based metrics skip outage dates, where conversions were not measured.
  const tracked = rows.filter((r) => !outageDates.has(r.date));
  const trackedWithSpend = withSpend.filter((r) => !outageDates.has(r.date));
  // ROAS additionally needs a known conversion value.
  const withValue = trackedWithSpend.filter((r) => r.conversionValue !== null);

  const spend = sum(withSpend, (r) => r.spend ?? 0);
  const impressions = sum(rows, (r) => r.impressions);
  const clicks = sum(rows, (r) => r.clicks);

  return {
    spend,
    impressions,
    clicks,
    conversions: sum(tracked, (r) => r.conversions),
    conversionValue: sum(tracked, (r) => r.conversionValue ?? 0),
    ctr: ratio(clicks, impressions),
    cpc: ratio(spend, sum(withSpend, (r) => r.clicks)),
    cpm: ratio(spend * 1000, sum(withSpend, (r) => r.impressions)),
    cpa: ratio(sum(trackedWithSpend, (r) => r.spend ?? 0), sum(trackedWithSpend, (r) => r.conversions)),
    roas: ratio(sum(withValue, (r) => r.conversionValue ?? 0), sum(withValue, (r) => r.spend ?? 0)),
    days: new Set(rows.map((r) => r.date)).size,
    excludedSpendDays: rows.length - withSpend.length,
    excludedValueDays: rows.filter((r) => r.conversionValue === null).length,
    excludedOutageDays: rows.length - tracked.length,
  };
}

export function compare(current: Summary, previous: Summary): Record<ComparedMetric, Change> {
  const change = (metric: ComparedMetric): Change => {
    const cur = current[metric];
    const prev = previous[metric];
    const changePct = cur === null || prev === null || prev === 0 ? null : ((cur - prev) / prev) * 100;
    return { current: cur, previous: prev, changePct };
  };
  return {
    spend: change("spend"),
    ctr: change("ctr"),
    cpa: change("cpa"),
    roas: change("roas"),
    conversions: change("conversions"),
  };
}

export function sampleSize(summary: Summary): { clicks: number; conversions: number; lowSample: boolean } {
  return {
    clicks: summary.clicks,
    conversions: summary.conversions,
    lowSample: summary.conversions < MIN_CONVERSIONS,
  };
}
