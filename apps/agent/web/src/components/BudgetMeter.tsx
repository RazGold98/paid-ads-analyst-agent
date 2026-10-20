import type { BudgetStatus } from "../api";

// Same thresholds as the server's budget alerts (src/budget/guard.ts).
const level = (f: number) => (f >= 1 ? "over" : f >= 0.85 ? "high" : f >= 0.7 ? "warn" : "ok");

export function BudgetMeter({ budget }: { budget: BudgetStatus }) {
  const pct = Math.min(budget.fraction, 1) * 100;
  return (
    <div className="budget" title="Model spend this month; the agent stops answering at 100%">
      <div className="budget-label small">
        AI budget {budget.month}: ${budget.spentUsd.toFixed(2)} of ${budget.budgetUsd.toFixed(2)}
      </div>
      <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className={`fill ${level(budget.fraction)}`} style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
    </div>
  );
}
