import { ACCOUNT, ADSETS, type AdSetDef } from "./entities.js";

export const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// TRACKING OUTAGE: on this day every ad set reports 0 conversions while delivery looks normal.
const OUTAGE_DAYS_AGO = 10;
// Single CPM for all ad sets keeps impressions a simple function of spend.
const BASE_CPM = 9;

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
  // A number, except for one deliberate defect (see applyDefects).
  spend: number | string;
  conversions: number;
  // A number, except for one deliberate defect (see applyDefects).
  conversion_value: number | null;
  currency: string;
}

/** UTC calendar date `daysAgo` days before `now` as YYYY-MM-DD (1 = yesterday). */
export function dateDaysAgo(now: Date, daysAgo: number): string {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayMs - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** The rolling data window: the last 30 days ending yesterday (UTC). */
export function getWindow(now = new Date()): { since: string; until: string } {
  return { since: dateDaysAgo(now, WINDOW_DAYS), until: dateDaysAgo(now, 1) };
}

// FNV-1a 32-bit string hash, used as the PRNG seed.
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type Rand = () => number;

// mulberry32: tiny seeded PRNG returning floats in [0, 1).
function mulberry32(seed: number): Rand {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `value` randomly moved by up to ±pct (0.1 = ±10%). */
const jitter = (rand: Rand, value: number, pct: number): number => value * (1 + (rand() * 2 - 1) * pct);
const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Targets for one ad set on one day; buildRow turns them into a consistent row. */
interface DayProfile {
  spend: number;
  ctr: number;
  frequency: number;
  conversions: number;
  // Average conversion value per conversion (drives ROAS).
  aov: number;
}

type Scenario = (daysAgo: number, rand: Rand) => DayProfile;

const SCENARIOS: Record<string, Scenario> = {
  // CREATIVE FATIGUE: stable through d=8, then over d=7..1 CTR falls 1.8% -> 0.8%,
  // frequency rises 1.6 -> 3.6 and CPA rises $22 -> $55 at roughly constant spend.
  as_women_video: (d, rand) => {
    const t = d >= 8 ? 0 : (8 - d) / 7;
    const spend = jitter(rand, 400, 0.05);
    return {
      spend,
      ctr: jitter(rand, lerp(0.018, 0.008, t), 0.05),
      frequency: jitter(rand, lerp(1.6, 3.6, t), 0.04),
      conversions: Math.round(spend / jitter(rand, lerp(22, 55, t), 0.08)),
      aov: 70,
    };
  },
  // HEALTHY WINNER: CPA ~$15 ±10%, ROAS ~4, ~$300/day.
  as_men_carousel: (_d, rand) => {
    const spend = jitter(rand, 300, 0.05);
    return {
      spend,
      ctr: jitter(rand, 0.015, 0.08),
      frequency: jitter(rand, 1.4, 0.05),
      conversions: Math.round(spend / jitter(rand, 15, 0.1)),
      aov: 60,
    };
  },
  // BUDGET BURNER: mediocre (CPA ~$35, ~$150/day) through d=6,
  // then d=5..1 spend jumps to ~$320/day with 0 or 1 conversion per day.
  as_broad_image: (d, rand) => {
    if (d <= 5) {
      return {
        spend: jitter(rand, 320, 0.05),
        ctr: jitter(rand, 0.009, 0.1),
        frequency: jitter(rand, 1.3, 0.05),
        conversions: rand() < 0.5 ? 0 : 1,
        aov: 60,
      };
    }
    const spend = jitter(rand, 150, 0.08);
    return {
      spend,
      ctr: jitter(rand, 0.01, 0.1),
      frequency: jitter(rand, 1.3, 0.05),
      conversions: Math.round(spend / jitter(rand, 35, 0.1)),
      aov: 60,
    };
  },
  // Healthy retargeting: CPA ~$12, ~$120/day.
  as_site_visitors: (_d, rand) => {
    const spend = jitter(rand, 120, 0.06);
    return {
      spend,
      ctr: jitter(rand, 0.025, 0.08),
      frequency: jitter(rand, 2.2, 0.05),
      conversions: Math.round(spend / jitter(rand, 12, 0.1)),
      aov: 65,
    };
  },
  // SMALL SAMPLE: $8-15/day and 0-2 random conversions, so CPA is pure noise.
  as_cart: (_d, rand) => ({
    spend: 8 + rand() * 7,
    ctr: jitter(rand, 0.03, 0.2),
    frequency: jitter(rand, 2.5, 0.1),
    conversions: Math.floor(rand() * 3),
    aov: 55,
  }),
  // Ordinary performance: CPA ~$28, ~$200/day. Its only special trait is the injected name.
  as_lookalike: (_d, rand) => {
    const spend = jitter(rand, 200, 0.06);
    return {
      spend,
      ctr: jitter(rand, 0.012, 0.08),
      frequency: jitter(rand, 1.3, 0.05),
      conversions: Math.round(spend / jitter(rand, 28, 0.1)),
      aov: 60,
    };
  },
};

function buildRow(adset: AdSetDef, date: string, daysAgo: number): InsightRow {
  // Seeded from adset + date, so a given (adset, date, days-ago) always yields the same numbers.
  const rand = mulberry32(hash(`${adset.id}|${date}`));
  const profile = SCENARIOS[adset.id](daysAgo, rand);

  const spend = round2(profile.spend);
  const impressions = Math.round((spend / jitter(rand, BASE_CPM, 0.1)) * 1000);
  const reach = Math.max(1, Math.round(impressions / profile.frequency));
  const clicks = Math.round(impressions * profile.ctr);
  const outage = daysAgo === OUTAGE_DAYS_AGO;
  const conversions = outage ? 0 : profile.conversions;
  const conversionValue = outage ? 0 : round2(conversions * jitter(rand, profile.aov, 0.15));

  return {
    date,
    account_id: ACCOUNT.id,
    campaign_id: adset.campaign_id,
    adset_id: adset.id,
    adset_name: adset.name,
    impressions,
    reach,
    frequency: round2(impressions / reach),
    clicks,
    spend,
    conversions,
    conversion_value: conversionValue,
    currency: ACCOUNT.currency,
  };
}

/**
 * Deliberate data defects, applied after generation so the agent has to notice and handle bad data.
 * Each one is keyed by ad set and days-ago, so they move with the rolling window.
 */
function applyDefects(rows: InsightRow[], now: Date): InsightRow[] {
  const is = (row: InsightRow, adsetId: string, daysAgo: number): boolean =>
    row.adset_id === adsetId && row.date === dateDaysAgo(now, daysAgo);

  const result: InsightRow[] = [];
  for (const row of rows) {
    // DEFECT: missing day — the as_men_carousel row for d=12 is dropped.
    if (is(row, "as_men_carousel", 12)) continue;
    // DEFECT: null metric — as_lookalike conversion_value is null on d=4.
    if (is(row, "as_lookalike", 4)) row.conversion_value = null;
    // DEFECT: impossible value — as_broad_image spend is negative on d=20.
    if (is(row, "as_broad_image", 20)) row.spend = -12.5;
    // DEFECT: wrong type — as_cart spend is a string (e.g. "11.40") on d=3.
    if (is(row, "as_cart", 3)) row.spend = (row.spend as number).toFixed(2);
    result.push(row);
    // DEFECT: duplicate — the as_site_visitors row for d=9 appears twice (exact copy).
    if (is(row, "as_site_visitors", 9)) result.push({ ...row });
  }
  return result;
}

/** All insight rows for the current window, ordered by date then ad set. */
export function generateInsights(now = new Date()): InsightRow[] {
  const rows: InsightRow[] = [];
  for (let daysAgo = WINDOW_DAYS; daysAgo >= 1; daysAgo--) {
    const date = dateDaysAgo(now, daysAgo);
    for (const adset of ADSETS) rows.push(buildRow(adset, date, daysAgo));
  }
  return applyDefects(rows, now);
}
