import { datesBetween, type Period } from "./dates.js";
import type { DailyRow, DataIssue, RawInsightRow } from "./types.js";

/**
 * Turns raw API rows into DailyRows and reports every data problem found.
 * It never invents data: unknown values become null and missing days stay missing.
 */
export function cleanRows(rawRows: RawInsightRow[], period: Period): { rows: DailyRow[]; issues: DataIssue[] } {
  const issues: DataIssue[] = [];
  const rows: DailyRow[] = [];
  const seen = new Set<string>();

  for (const raw of rawRows) {
    const key = `${raw.adset_id}|${raw.date}`;
    // Duplicate (same ad set + date): keep the first row, drop the rest.
    if (seen.has(key)) {
      issues.push({
        type: "duplicate_row",
        adsetId: raw.adset_id,
        date: raw.date,
        detail: "The API returned more than one row for this ad set and date",
        action: "Kept the first row, dropped the duplicate",
      });
      continue;
    }
    seen.add(key);
    rows.push(cleanRow(raw, issues));
  }

  issues.push(...findMissingDays(rows, period), ...findTrackingOutages(rows));
  return { rows, issues };
}

function cleanRow(raw: RawInsightRow, issues: DataIssue[]): DailyRow {
  const issue = (type: DataIssue["type"], detail: string, action: string) =>
    issues.push({ type, adsetId: raw.adset_id, date: raw.date, detail, action });

  // Numeric string (e.g. "11.40"): parse it, and report that the API sent the wrong type.
  const toNumber = (field: string, value: number | string): number => {
    if (typeof value === "number") return value;
    const parsed = Number(value);
    issue("string_number", `${field} was the string "${value}"`, `Parsed as ${parsed}`);
    return parsed;
  };

  let spend: number | null = toNumber("spend", raw.spend);
  // Negative spend is impossible: mark it unknown (null), never treat it as 0.
  if (spend < 0) {
    issue("negative_value", `spend was ${spend}`, "Set to unknown and excluded from spend-based metrics");
    spend = null;
  }

  let conversionValue: number | null = null;
  // Null conversion_value: keep the row, but the value stays unknown (not 0).
  if (raw.conversion_value === null) {
    issue("null_value", "conversion_value was null", "Kept the row; excluded from ROAS");
  } else {
    conversionValue = toNumber("conversion_value", raw.conversion_value);
  }

  return {
    date: raw.date,
    campaignId: raw.campaign_id,
    adsetId: raw.adset_id,
    adsetName: raw.adset_name,
    impressions: toNumber("impressions", raw.impressions),
    reach: toNumber("reach", raw.reach),
    clicks: toNumber("clicks", raw.clicks),
    spend,
    conversions: toNumber("conversions", raw.conversions),
    conversionValue,
  };
}

// Missing day: an ad set that appears in the data has no row for a date in the period. Never fabricate one.
// (An ad set with no rows at all in the period cannot be detected here.)
function findMissingDays(rows: DailyRow[], period: Period): DataIssue[] {
  const datesByAdset = new Map<string, Set<string>>();
  for (const row of rows) {
    const dates = datesByAdset.get(row.adsetId) ?? new Set<string>();
    dates.add(row.date);
    datesByAdset.set(row.adsetId, dates);
  }

  const issues: DataIssue[] = [];
  for (const [adsetId, dates] of datesByAdset) {
    for (const date of datesBetween(period)) {
      if (dates.has(date)) continue;
      issues.push({
        type: "missing_day",
        adsetId,
        date,
        detail: "No row for this ad set on this date",
        action: "Not filled in; totals cover one day less",
      });
    }
  }
  return issues;
}

// Tracking outage: on a date with at least 2 ad sets, every ad set has 0 conversions but there were clicks.
// One ad set with zero conversions is just a bad day, so a single ad set is never enough evidence.
function findTrackingOutages(rows: DailyRow[]): DataIssue[] {
  const rowsByDate = new Map<string, DailyRow[]>();
  for (const row of rows) rowsByDate.set(row.date, [...(rowsByDate.get(row.date) ?? []), row]);

  const issues: DataIssue[] = [];
  for (const [date, dayRows] of rowsByDate) {
    const clicks = dayRows.reduce((sum, r) => sum + r.clicks, 0);
    if (dayRows.length < 2 || clicks === 0 || dayRows.some((r) => r.conversions !== 0)) continue;
    issues.push({
      type: "suspected_tracking_outage",
      date,
      detail: `All ${dayRows.length} ad sets report 0 conversions despite ${clicks} clicks`,
      action: "Likely a tracking problem, not performance; excluded from conversions, CPA and ROAS",
    });
  }
  return issues;
}
