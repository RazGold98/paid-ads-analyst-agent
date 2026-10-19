import type { AdsApiClient } from "./client.js";
import { cleanRows } from "./clean.js";
import { daysAgo, type Period } from "./dates.js";
import { compare, sampleSize, summarize, type Change, type ComparedMetric, type Summary } from "./metrics.js";
import type { AdSet, AdSetStatus, DailyRow, DataIssue, Source } from "./types.js";

// The API serves the last 30 days ending yesterday (UTC).
const AVAILABLE_DAYS = 30;
// comparePeriods needs two equal periods inside the available window.
const MAX_COMPARE_DAYS = AVAILABLE_DAYS / 2;

/** What every tool returns. Data problems end up in `issues`; only API errors throw. */
export interface ToolResult<T> {
  result: T;
  issues: DataIssue[];
  sources: Source[];
}

export interface Filter {
  adsetId?: string;
  campaignId?: string;
}

/** The last `days` days ending yesterday, e.g. days = 7 -> d=7..1. */
const lastDays = (days: number): Period => ({ since: daysAgo(days), until: daysAgo(1) });

/** Limits a period to the dates the API actually serves. */
function clampToAvailable(period: Period): Period {
  const available = lastDays(AVAILABLE_DAYS);
  return {
    since: period.since < available.since ? available.since : period.since,
    until: period.until > available.until ? available.until : period.until,
  };
}

// Rounding happens only here, on the way out; all calculations above use unrounded values.
function round(value: number, decimals: number): number;
function round(value: number | null, decimals: number): number | null;
function round(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Money to 2 decimals, ratios (ctr, roas) to 4.
const DECIMALS: Record<ComparedMetric, number> = { spend: 2, ctr: 4, cpa: 2, roas: 4, conversions: 0 };

function roundSummary(s: Summary): Summary {
  return {
    ...s,
    spend: round(s.spend, 2),
    conversionValue: round(s.conversionValue, 2),
    cpc: round(s.cpc, 2),
    cpm: round(s.cpm, 2),
    cpa: round(s.cpa, 2),
    ctr: round(s.ctr, 4),
    roas: round(s.roas, 4),
  };
}

function roundChanges(changes: Record<ComparedMetric, Change>): Record<ComparedMetric, Change> {
  const rounded = {} as Record<ComparedMetric, Change>;
  for (const metric of Object.keys(changes) as ComparedMetric[]) {
    const c = changes[metric];
    rounded[metric] = {
      current: round(c.current, DECIMALS[metric]),
      previous: round(c.previous, DECIMALS[metric]),
      changePct: round(c.changePct, 1),
    };
  }
  return rounded;
}

/**
 * Fetches and cleans insights for the whole account, then narrows to the filter.
 * Fetching everything matters: a tracking outage is only visible across all ad sets.
 */
async function fetchRows(
  client: AdsApiClient,
  period: Period,
  filter: Filter,
): Promise<{ rows: DailyRow[]; issues: DataIssue[]; outageDates: Set<string>; source: Source }> {
  const { data, source } = await client.getInsights(period);
  const { rows, issues } = cleanRows(data, period);

  const campaignOf = new Map(data.map((r) => [r.adset_id, r.campaign_id]));
  const matches = (adsetId: string) =>
    (!filter.adsetId || adsetId === filter.adsetId) &&
    (!filter.campaignId || campaignOf.get(adsetId) === filter.campaignId);

  return {
    rows: rows.filter((r) => matches(r.adsetId)),
    // Account-wide issues (no adsetId) always apply.
    issues: issues.filter((i) => i.adsetId === undefined || matches(i.adsetId)),
    // Dates whose conversions summarize() must ignore.
    outageDates: new Set(issues.filter((i) => i.type === "suspected_tracking_outage").map((i) => i.date)),
    source,
  };
}

export async function listAdSets(client: AdsApiClient): Promise<ToolResult<AdSet[]>> {
  const { data, source } = await client.listAdSets();
  return { result: data, issues: [], sources: [source] };
}

export async function getPerformance(
  client: AdsApiClient,
  args: Filter & { since?: string; until?: string } = {},
) {
  const period = clampToAvailable({
    since: args.since ?? daysAgo(AVAILABLE_DAYS),
    until: args.until ?? daysAgo(1),
  });
  const filter = { adsetId: args.adsetId, campaignId: args.campaignId };
  const { rows, issues, outageDates, source } = await fetchRows(client, period, filter);
  const summary = summarize(rows, outageDates);
  return {
    result: { period, filter, summary: roundSummary(summary), sampleSize: sampleSize(summary) },
    issues,
    sources: [source],
  } satisfies ToolResult<unknown>;
}

export async function comparePeriods(client: AdsApiClient, args: Filter & { days?: number } = {}) {
  // Capped so the previous period is never cut short (e.g. 20 days would compare 20 vs 10).
  const days = Math.min(Math.max(Math.round(args.days ?? 7), 1), MAX_COMPARE_DAYS);
  const current = lastDays(days);
  const previous = { since: daysAgo(2 * days), until: daysAgo(days + 1) };
  const filter = { adsetId: args.adsetId, campaignId: args.campaignId };

  // One fetch covering both periods, then split by date.
  const { rows, issues, outageDates, source } = await fetchRows(
    client,
    { since: previous.since, until: current.until },
    filter,
  );
  const inPeriod = (p: Period) => rows.filter((r) => r.date >= p.since && r.date <= p.until);
  const currentSummary = summarize(inPeriod(current), outageDates);
  const previousSummary = summarize(inPeriod(previous), outageDates);

  return {
    result: {
      filter,
      days,
      current: { period: current, summary: roundSummary(currentSummary), sampleSize: sampleSize(currentSummary) },
      previous: { period: previous, summary: roundSummary(previousSummary), sampleSize: sampleSize(previousSummary) },
      changes: roundChanges(compare(currentSummary, previousSummary)),
    },
    issues,
    sources: [source],
  } satisfies ToolResult<unknown>;
}

export interface AdSetOverview {
  adsetId: string;
  adsetName: string;
  campaignId: string;
  status: AdSetStatus;
  summary: Summary;
  sampleSize: ReturnType<typeof sampleSize>;
}

export async function accountOverview(client: AdsApiClient, args: { days?: number } = {}) {
  const period = clampToAvailable(lastDays(args.days ?? 7));
  const adsets = await client.listAdSets();
  const { rows, issues, outageDates, source } = await fetchRows(client, period, {});

  const overview: AdSetOverview[] = adsets.data
    .map((adset) => {
      const summary = summarize(
        rows.filter((r) => r.adsetId === adset.id),
        outageDates,
      );
      return {
        adsetId: adset.id,
        adsetName: adset.name,
        campaignId: adset.campaignId,
        status: adset.status,
        summary,
        sampleSize: sampleSize(summary),
      };
    })
    // Sort on unrounded spend, then round for output.
    .sort((a, b) => b.summary.spend - a.summary.spend)
    .map((o) => ({ ...o, summary: roundSummary(o.summary) }));

  return {
    result: { period, adsets: overview },
    issues,
    sources: [adsets.source, source],
  } satisfies ToolResult<unknown>;
}
