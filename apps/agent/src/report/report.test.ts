import { describe, expect, it, vi } from "vitest";
import type { AdSet, DataIssue } from "../ads/types.js";
import { findAnomalies, formatReport } from "./daily.js";
import { isDue, localClock, startDailyReport, type RunStore } from "./schedule.js";

const adset = (id: string): AdSet => ({ id, campaignId: "cmp", name: id, dailyBudget: 100, status: "ACTIVE" });

/** A comparison with just the fields the rules read. */
function comparison(now: { spend: number; conversions: number; roas: number | null }, cpaChangePct: number | null = null) {
  return {
    current: { summary: now },
    changes: { cpa: { current: 38.28, previous: 22.45, changePct: cpaChangePct } },
  } as unknown as Parameters<typeof findAnomalies>[0][number]["comparison"];
}

describe("findAnomalies", () => {
  it("flags the planted scenarios and leaves healthy ad sets alone", () => {
    const findings = findAnomalies(
      [
        { adset: adset("as_broad_image"), comparison: comparison({ spend: 1896.81, conversions: 9, roas: 0.28 }) },
        { adset: adset("as_women_video"), comparison: comparison({ spend: 2794.62, conversions: 73, roas: 1.79 }, 70.5) },
        { adset: adset("as_men_carousel"), comparison: comparison({ spend: 2094.38, conversions: 145, roas: 4.17 }, -2.2) },
        // Small sample: a CPA jump on 5 conversions is noise, not a finding.
        { adset: adset("as_cart"), comparison: comparison({ spend: 81, conversions: 5, roas: 3.47 }, 50) },
      ],
      [],
    );
    expect(findings.map((f) => [f.severity, f.adsetId])).toEqual([
      ["high", "as_broad_image"],
      ["medium", "as_women_video"],
    ]);
    expect(findings[1].text).toContain("CPA +70.5% ($22.45 → $38.28)");
  });

  it("reports a tracking outage once, and skips harmless data issues", () => {
    const outage: DataIssue = { type: "suspected_tracking_outage", date: "2026-10-09", detail: "", action: "" };
    const harmless: DataIssue = { type: "string_number", adsetId: "as_cart", date: "2026-10-16", detail: "", action: "" };
    const findings = findAnomalies([], [outage, outage, harmless]);
    expect(findings).toEqual([{ severity: "data", text: expect.stringContaining("tracking outage on 2026-10-09") }]);
  });
});

describe("formatReport", () => {
  it("says so when nothing needs attention", () => {
    const text = formatReport({ date: "2026-10-20", period: "p", findings: [], okAdsets: ["as_cart"], paused: ["as_lookalike"] });
    expect(text).toContain("Nothing needs attention today.");
    expect(text).toContain("✅ No issues: as_cart");
    expect(text).toContain("⏸️ Paused: as_lookalike");
  });
});

describe("schedule", () => {
  // 05:30 UTC is 08:30 in Israel (UTC+3 in October).
  const at = (iso: string) => new Date(iso);

  it("uses the team's local time, not UTC", () => {
    expect(localClock(at("2026-10-20T05:30:00Z"), "Asia/Jerusalem")).toEqual({ date: "2026-10-20", time: "08:30" });
    expect(localClock(at("2026-10-19T22:30:00Z"), "Asia/Jerusalem").date).toBe("2026-10-20");
  });

  it("is due from the report time onwards", () => {
    expect(isDue(at("2026-10-20T04:59:00Z"), "08:00", "Asia/Jerusalem").due).toBe(false);
    expect(isDue(at("2026-10-20T05:00:00Z"), "08:00", "Asia/Jerusalem").due).toBe(true);
    expect(isDue(at("2026-10-20T15:00:00Z"), "08:00", "Asia/Jerusalem").due).toBe(true);
  });

  function memoryRuns(): RunStore {
    const claimed = new Set<string>();
    return {
      claim: async (d) => (claimed.has(d) ? false : (claimed.add(d), true)),
      release: async (d) => void claimed.delete(d),
    };
  }

  it("sends once per day, even if started again (a deploy) after it was sent", async () => {
    const runs = memoryRuns();
    const send = vi.fn(async () => {});
    const now = () => at("2026-10-20T06:00:00Z");
    for (let i = 0; i < 3; i++) startDailyReport({ time: "08:00", timeZone: "Asia/Jerusalem", runs, send, onError: () => {}, now })();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith("2026-10-20");
  });

  it("does not send before the report time", async () => {
    const send = vi.fn(async () => {});
    const stop = startDailyReport({ time: "08:00", timeZone: "Asia/Jerusalem", runs: memoryRuns(), send, onError: () => {}, now: () => at("2026-10-20T03:00:00Z") });
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it("retries after a failed send instead of losing the day", async () => {
    const runs = memoryRuns();
    const onError = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error("Telegram down");
    });
    const now = () => at("2026-10-20T06:00:00Z");
    startDailyReport({ time: "08:00", timeZone: "Asia/Jerusalem", runs, send: failing, onError, now })();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());

    const send = vi.fn(async () => {});
    startDailyReport({ time: "08:00", timeZone: "Asia/Jerusalem", runs, send, onError, now })();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});
