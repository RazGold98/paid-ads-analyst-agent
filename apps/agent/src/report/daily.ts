import type { AdsTools } from "../ads/index.js";
import type { AdSet, DataIssue } from "../ads/types.js";

type Comparison = Awaited<ReturnType<AdsTools["comparePeriods"]>>["result"];

// Fixed, explainable rules: a report nobody reviews before it is sent must be predictable and exact.
// The model is not used here; people ask the agent "why?" afterwards.
const BURN_MIN_SPEND = 300; // 7-day spend that should have produced results
const MIN_CONVERSIONS = 10; // same threshold as lowSample in metrics.ts
const CPA_RISE_PCT = 30;

export interface Finding {
  severity: "high" | "medium" | "data";
  adsetId?: string;
  text: string;
}

const money = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);

/** Applies the rules to each active ad set's week-over-week comparison, plus the data issues. */
export function findAnomalies(rows: { adset: AdSet; comparison: Comparison }[], issues: DataIssue[]): Finding[] {
  const findings: Finding[] = [];

  for (const { adset, comparison } of rows) {
    const now = comparison.current.summary;
    const cpa = comparison.changes.cpa;

    if (now.spend >= BURN_MIN_SPEND && now.conversions < MIN_CONVERSIONS) {
      findings.push({
        severity: "high",
        adsetId: adset.id,
        text: `${adset.id}: spent ${money(now.spend)} for ${now.conversions} conversions (ROAS ${now.roas ?? "n/a"})`,
      });
    } else if (now.roas !== null && now.roas < 1 && now.conversions >= MIN_CONVERSIONS) {
      findings.push({ severity: "high", adsetId: adset.id, text: `${adset.id}: ROAS ${now.roas} (spends more than it brings in)` });
    }

    if (cpa.changePct !== null && cpa.changePct >= CPA_RISE_PCT && now.conversions >= MIN_CONVERSIONS) {
      findings.push({
        severity: "medium",
        adsetId: adset.id,
        text: `${adset.id}: CPA +${cpa.changePct}% (${money(cpa.previous)} → ${money(cpa.current)})`,
      });
    }
  }

  // Only issues that change how the numbers should be read; the same issue can come from several ad sets.
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.type !== "suspected_tracking_outage" && issue.type !== "missing_day") continue;
    const text =
      issue.type === "suspected_tracking_outage"
        ? `Data: suspected tracking outage on ${issue.date} (excluded from conversions, CPA and ROAS)`
        : `Data: no row for ${issue.adsetId} on ${issue.date} (totals cover one day less)`;
    if (seen.has(text)) continue;
    seen.add(text);
    findings.push({ severity: "data", text });
  }

  const order = { high: 0, medium: 1, data: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

const ICON = { high: "🔴", medium: "🟠", data: "🟡" };

export function formatReport(opts: { date: string; period: string; findings: Finding[]; okAdsets: string[]; paused: string[] }): string {
  const lines = [`☀️ Morning report, ${opts.date} (${opts.period})`, ""];
  if (opts.findings.length === 0) lines.push("Nothing needs attention today.");
  for (const f of opts.findings) lines.push(`${ICON[f.severity]} ${f.text}`);
  lines.push("");
  if (opts.okAdsets.length > 0) lines.push(`✅ No issues: ${opts.okAdsets.join(", ")}`);
  if (opts.paused.length > 0) lines.push(`⏸️ Paused: ${opts.paused.join(", ")}`);
  lines.push('Ask me "why did CPA rise on <ad set>?" for details.');
  return lines.join("\n");
}

/** Fetches last 7 days vs the 7 before for every active ad set and builds the report text. */
export async function buildDailyReport(ads: AdsTools, date: string): Promise<string> {
  const { result: adsets } = await ads.listAdSets();
  const active = adsets.filter((a) => a.status === "ACTIVE");

  const rows: { adset: AdSet; comparison: Comparison }[] = [];
  const issues: DataIssue[] = [];
  for (const adset of active) {
    const { result, issues: adsetIssues } = await ads.comparePeriods({ adsetId: adset.id, days: 7 });
    rows.push({ adset, comparison: result });
    issues.push(...adsetIssues);
  }

  const findings = findAnomalies(rows, issues);
  const flagged = new Set(findings.map((f) => f.adsetId).filter(Boolean));
  const first = rows[0]?.comparison;
  const period = first
    ? `${first.current.period.since} to ${first.current.period.until} vs the 7 days before`
    : "no active ad sets";

  return formatReport({
    date,
    period,
    findings,
    okAdsets: active.map((a) => a.id).filter((id) => !flagged.has(id)),
    paused: adsets.filter((a) => a.status === "PAUSED").map((a) => a.id),
  });
}
