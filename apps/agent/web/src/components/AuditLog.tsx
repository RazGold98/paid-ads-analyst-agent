import type { AuditEntry } from "../api";

const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });

export function AuditLog({ entries }: { entries: AuditEntry[] }) {
  return (
    <section className="card">
      <h2>Action log</h2>
      {entries.length === 0 && <p className="muted">Nothing logged yet.</p>}
      <ul className="audit">
        {entries.map((e, i) => (
          <li key={i}>
            <span className="muted small">{time(e.at)}</span>
            <span>
              <strong>{e.event}</strong>
              {e.requestId && ` #${e.requestId}`}
              {e.by && ` · ${e.by}`}
            </span>
            {e.detail && <span className="muted small">{e.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
