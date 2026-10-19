/** Where a piece of data came from, so every number the agent reports can be traced back. */
export interface Source {
  endpoint: string;
  params: Record<string, string>;
  fetchedAt: string;
}

export type AdSetStatus = "ACTIVE" | "PAUSED";

export interface Campaign {
  id: string;
  name: string;
}

export interface AdSet {
  id: string;
  campaignId: string;
  name: string;
  dailyBudget: number;
  status: AdSetStatus;
}

/** An insights row as the API sends it (validated, not yet cleaned). */
export interface RawInsightRow {
  date: string;
  campaign_id: string;
  adset_id: string;
  adset_name: string;
  impressions: number | string;
  reach: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string | null;
}

/** A cleaned daily row. null means "unknown", never 0. */
export interface DailyRow {
  date: string;
  campaignId: string;
  adsetId: string;
  adsetName: string;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number | null;
  conversions: number;
  conversionValue: number | null;
}

export type DataIssueType =
  | "duplicate_row"
  | "missing_day"
  | "null_value"
  | "negative_value"
  | "string_number"
  | "suspected_tracking_outage";

export interface DataIssue {
  type: DataIssueType;
  // Absent for account-wide issues (e.g. a tracking outage).
  adsetId?: string;
  date: string;
  detail: string;
  action: string;
}
