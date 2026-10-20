import type { ActionRequest } from "../api";

const money = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);
const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

export function Requests({ requests }: { requests: ActionRequest[] }) {
  const pending = requests.filter((r) => r.status === "pending");
  const done = requests.filter((r) => r.status !== "pending");

  return (
    <section className="card">
      <h2>Pause requests</h2>
      <p className="muted small">Approving happens in Telegram, by a registered approver. This page only shows the state.</p>
      {requests.length === 0 && <p className="muted">No requests yet. Ask the analyst to pause an ad set.</p>}
      {[...pending, ...done].map((r) => (
        <article key={r._id} className="request">
          <div className="request-head">
            <strong>
              #{r._id} · {r.snapshot.adsetName}
            </strong>
            <span className={`badge ${r.status}`}>{r.status}</span>
          </div>
          <p className="small">
            7 days: spend {money(r.snapshot.spend)}, {r.snapshot.conversions} conv., CPA {money(r.snapshot.cpa)}, ROAS {r.snapshot.roas ?? "n/a"}
          </p>
          <p className="small">Reason: {r.reason}</p>
          <p className="muted small">
            Asked by {r.requestedBy.name} · {time(r.createdAt)}
            {r.decidedBy && ` · decided by ${r.decidedBy.name}`}
            {r.status === "pending" && ` · expires ${time(r.expiresAt)}`}
          </p>
          {r.result && <p className="small">{r.result}</p>}
        </article>
      ))}
    </section>
  );
}
