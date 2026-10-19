import fixture from "./insights.fixture.json" with { type: "json" };
import { ACCOUNT, ADSETS } from "./entities.js";

export const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One row of insights.fixture.json. Rows are keyed by days_ago (1 = yesterday) instead of a date,
 * so the data always ends yesterday. The fixture deliberately contains defects (missing day,
 * duplicate row, null conversion_value, negative spend, spend as a string); see SCENARIOS.md.
 */
interface FixtureRow {
  days_ago: number;
  adset_id: string;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  spend: number | string;
  conversions: number;
  conversion_value: number | null;
}

export interface InsightRow {
  date: string;
  account_id: string;
  campaign_id: string;
  adset_id: string;
  adset_name: string;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  spend: number | string;
  conversions: number;
  conversion_value: number | null;
  currency: string;
}

const FIXTURE_ROWS: FixtureRow[] = fixture.rows;

/** UTC calendar date `daysAgo` days before `now` as YYYY-MM-DD (1 = yesterday). */
export function dateDaysAgo(now: Date, daysAgo: number): string {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayMs - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** The rolling data window: the last 30 days ending yesterday (UTC). */
export function getWindow(now = new Date()): { since: string; until: string } {
  return { since: dateDaysAgo(now, WINDOW_DAYS), until: dateDaysAgo(now, 1) };
}

/** All fixture rows with days_ago mapped to real dates relative to `now`, ordered by date. */
export function getInsights(now = new Date()): InsightRow[] {
  return FIXTURE_ROWS.map((row) => {
    const adset = ADSETS.find((a) => a.id === row.adset_id);
    if (!adset) throw new Error(`Fixture references unknown ad set ${row.adset_id}`);
    return {
      date: dateDaysAgo(now, row.days_ago),
      account_id: ACCOUNT.id,
      campaign_id: adset.campaign_id,
      adset_id: adset.id,
      adset_name: adset.name,
      impressions: row.impressions,
      reach: row.reach,
      frequency: row.frequency,
      clicks: row.clicks,
      spend: row.spend,
      conversions: row.conversions,
      conversion_value: row.conversion_value,
      currency: ACCOUNT.currency,
    };
  });
}
