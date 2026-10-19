// Smoke check against the configured mock API: `npm run check:data`.
import { createAdsTools } from "../ads/index.js";
import type { Change } from "../ads/metrics.js";
import type { DataIssue } from "../ads/types.js";

const money = (v: number | null) => (v === null ? "–" : `$${v.toFixed(2)}`);
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(2)}%`);
const num = (v: number | null) => (v === null ? "–" : v.toFixed(2));
const changePct = (c: Change) => (c.changePct === null ? "–" : `${c.changePct > 0 ? "+" : ""}${c.changePct.toFixed(1)}%`);

function printIssues(issues: DataIssue[]): void {
  if (issues.length === 0) return console.log("Issues: none\n");
  console.log(`Issues (${issues.length}):`);
  for (const i of issues) console.log(`  ${i.date} ${i.type} ${i.adsetId ?? "(account)"}: ${i.detail} -> ${i.action}`);
  console.log();
}

const tools = createAdsTools();

const overview = await tools.accountOverview({ days: 7 });
console.log(`\nAccount overview ${overview.result.period.since} .. ${overview.result.period.until}`);
console.table(
  overview.result.adsets.map(({ adsetId, status, summary: s, sampleSize }) => ({
    adset: adsetId,
    status,
    spend: money(s.spend),
    conv: s.conversions,
    cpa: money(s.cpa),
    roas: num(s.roas),
    ctr: pct(s.ctr),
    lowSample: sampleSize.lowSample,
    "excl spend/value/outage": `${s.excludedSpendDays}/${s.excludedValueDays}/${s.excludedOutageDays}`,
  })),
);
printIssues(overview.issues);

for (const adsetId of ["as_women_video", "as_broad_image"]) {
  const { result, issues } = await tools.comparePeriods({ adsetId, days: 7 });
  const fmt: Record<string, (v: number | null) => string> = { spend: money, ctr: pct, cpa: money, roas: num, conversions: (v) => (v === null ? "–" : String(v)) };
  console.log(
    `${adsetId}: ${result.current.period.since}..${result.current.period.until} vs ${result.previous.period.since}..${result.previous.period.until}`,
  );
  console.table(
    Object.entries(result.changes).map(([metric, c]) => ({
      metric,
      current: fmt[metric](c.current),
      previous: fmt[metric](c.previous),
      change: changePct(c),
    })),
  );
  printIssues(issues);
}
