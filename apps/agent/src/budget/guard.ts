import type { Collection, Db } from "mongodb";
import type { ChatFn } from "../llm/openrouter.js";

// Warn the team as spend crosses each of these fractions of the monthly budget.
export const THRESHOLDS = [0.7, 0.85, 1] as const;

// Used only when OpenRouter does not report a cost: claude-haiku-5.5 list prices (USD per token),
// so an unknown cost is still counted instead of silently treated as 0.
const FALLBACK_PRICE = { prompt: 0.1 / 1_000_000, completion: 0.5 / 1_000_000 };

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly budgetUsd: number) {
    super(`Monthly AI budget reached: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

export interface UsageEntry {
  month: string; // "2026-10", UTC
  at: Date;
  costUsd: number;
  // True when OpenRouter gave no cost and it was estimated from tokens.
  estimated: boolean;
  promptTokens: number;
  completionTokens: number;
}

export interface BudgetStore {
  record(entry: UsageEntry): Promise<void>;
  spent(month: string): Promise<number>;
  /** Returns true only the first time it is called for this month and threshold. */
  markAlert(month: string, threshold: number): Promise<boolean>;
}

export interface BudgetStatus {
  month: string;
  spentUsd: number;
  budgetUsd: number;
  fraction: number;
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

export class BudgetGuard {
  constructor(
    private readonly store: BudgetStore,
    readonly budgetUsd: number,
    // Tells the team about a crossed threshold, e.g. a Telegram message to the approvers.
    private readonly notify: (text: string) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(): Promise<BudgetStatus> {
    const month = monthOf(this.now());
    const spentUsd = await this.store.spent(month);
    return { month, spentUsd, budgetUsd: this.budgetUsd, fraction: spentUsd / this.budgetUsd };
  }

  /**
   * The model function with the budget enforced: every channel (Telegram, MCP, the scheduled report)
   * calls the model through this, so no caller can skip the check.
   */
  wrap(chat: ChatFn): ChatFn {
    return async (messages, tools) => {
      const before = await this.status();
      if (before.spentUsd >= this.budgetUsd) throw new BudgetExceededError(before.spentUsd, this.budgetUsd);

      const response = await chat(messages, tools);

      const { promptTokens, completionTokens, costUsd } = response.usage;
      const estimated = costUsd === null;
      const cost = costUsd ?? promptTokens * FALLBACK_PRICE.prompt + completionTokens * FALLBACK_PRICE.completion;
      await this.store.record({ month: before.month, at: this.now(), costUsd: cost, estimated, promptTokens, completionTokens });
      await this.alertOnCrossing(before.month, before.spentUsd, before.spentUsd + cost);
      return response;
    };
  }

  private async alertOnCrossing(month: string, before: number, after: number): Promise<void> {
    for (const t of THRESHOLDS) {
      const line = t * this.budgetUsd;
      if (before < line && after >= line && (await this.store.markAlert(month, t))) {
        const pct = Math.round(t * 100);
        const tail = t === 1 ? "The agent will stop answering until next month; approvals still work." : "";
        await this.notify(`AI budget alert: ${pct}% of the $${this.budgetUsd} monthly budget used ($${after.toFixed(2)}). ${tail}`.trim());
      }
    }
  }
}

export class MongoBudgetStore implements BudgetStore {
  private readonly usage: Collection<UsageEntry>;
  private readonly alerts: Collection<{ _id: string; at: Date }>;

  constructor(db: Db) {
    this.usage = db.collection<UsageEntry>("llm_usage");
    this.alerts = db.collection<{ _id: string; at: Date }>("budget_alerts");
  }

  async record(entry: UsageEntry): Promise<void> {
    await this.usage.insertOne(entry);
  }

  async spent(month: string): Promise<number> {
    const [row] = await this.usage.aggregate<{ total: number }>([
      { $match: { month } },
      { $group: { _id: null, total: { $sum: "$costUsd" } } },
    ]).toArray();
    return row?.total ?? 0;
  }

  // The alert id is unique per month and threshold, so a second insert fails and no alert is repeated.
  async markAlert(month: string, threshold: number): Promise<boolean> {
    try {
      await this.alerts.insertOne({ _id: `${month}:${threshold}`, at: new Date() });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }
}
