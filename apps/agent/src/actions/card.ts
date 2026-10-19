import type { ActionRequest } from "./store.js";

const money = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);
const time = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

/** The approval card: everything an approver needs to decide, as plain text. */
export function cardText(r: ActionRequest): string {
  const s = r.snapshot;
  const lines = [
    `Pause request #${r._id}`,
    "",
    `Ad set: ${s.adsetName} (${r.adsetId})`,
    `Now: ${s.status}, budget $${s.dailyBudget}/day`,
    `Last 7 days (${s.period.since} to ${s.period.until}): spend ${money(s.spend)}, ${s.conversions} conversions, CPA ${money(s.cpa)}, ROAS ${s.roas ?? "n/a"}${s.lowSample ? " (low sample)" : ""}`,
    `Expected impact: stops spend of up to $${s.dailyBudget}/day; its conversions stop too.`,
    "",
    `Agent's reason: ${r.reason}`,
    `Requested by: ${r.requestedBy.name} (${r.requestedBy.channel})`,
    "",
    statusLine(r),
  ];
  return lines.join("\n");
}

function statusLine(r: ActionRequest): string {
  const by = r.decidedBy?.name ?? "someone";
  switch (r.status) {
    case "pending":
      return `Waiting for approval, expires ${time(r.expiresAt)}.`;
    case "executing":
      return `Approved by ${by}, pausing now...`;
    case "succeeded":
      return `PAUSED. Approved by ${by}. ${r.result ?? ""}`.trim();
    case "failed":
      return `FAILED (approved by ${by}): ${r.result ?? ""}`.trim();
    case "unknown":
      return `RESULT UNKNOWN (approved by ${by}): ${r.result ?? ""}`.trim();
    case "rejected":
      return `Rejected by ${by}. Nothing was changed.`;
    case "expired":
      return "Expired. Nothing was changed.";
  }
}

/** What the model gets back from propose_pause. It must not claim anything was paused. */
export function proposalForModel(r: ActionRequest, created: boolean, approversNotified: number) {
  return {
    requestId: r._id,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    note: [
      created ? "Request created." : "A pending request for this ad set already exists; no new one was created.",
      "Nothing has been paused. A human approver must approve it in Telegram.",
      approversNotified === 0 ? "No approvers are registered yet: someone must send /register <code> to the bot first." : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
