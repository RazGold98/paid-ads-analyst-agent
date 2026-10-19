import { describe, expect, it, vi } from "vitest";
import type { ChatFn } from "../llm/openrouter.js";
import { BudgetExceededError, BudgetGuard, type BudgetStore, type UsageEntry } from "./guard.js";

function memoryStore(startSpent = 0): BudgetStore & { entries: UsageEntry[] } {
  const entries: UsageEntry[] = [];
  const alerts = new Set<string>();
  return {
    entries,
    record: async (e) => void entries.push(e),
    spent: async (month) => startSpent + entries.filter((e) => e.month === month).reduce((s, e) => s + e.costUsd, 0),
    markAlert: async (month, t) => (alerts.has(`${month}:${t}`) ? false : (alerts.add(`${month}:${t}`), true)),
  };
}

const callCosting = (costUsd: number | null): ChatFn =>
  vi.fn<ChatFn>(async () => ({ message: { content: "ok" }, usage: { promptTokens: 1000, completionTokens: 200, costUsd } }));

const now = () => new Date("2026-10-19T12:00:00Z");

describe("BudgetGuard", () => {
  it("records the cost of every call", async () => {
    const store = memoryStore();
    const guard = new BudgetGuard(store, 40, async () => {}, now);
    await guard.wrap(callCosting(0.002))([], []);
    expect(store.entries).toEqual([expect.objectContaining({ month: "2026-10", costUsd: 0.002, estimated: false })]);
  });

  it("estimates an unknown cost from tokens instead of counting it as 0", async () => {
    const store = memoryStore();
    await new BudgetGuard(store, 40, async () => {}, now).wrap(callCosting(null))([], []);
    expect(store.entries[0].estimated).toBe(true);
    expect(store.entries[0].costUsd).toBeCloseTo(1000 * 0.1e-6 + 200 * 0.5e-6);
  });

  it("alerts once at each threshold as spend crosses it", async () => {
    const notify = vi.fn(async () => {});
    const guard = new BudgetGuard(memoryStore(27.9), 40, notify, now);
    const chat = guard.wrap(callCosting(0.2)); // 27.9 -> 28.1 crosses 70% ($28)
    await chat([], []);
    await chat([], []); // still above 70%: no repeat
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("70%"));
  });

  it("blocks calls once the budget is used up, and says so", async () => {
    const notify = vi.fn(async () => {});
    const inner = callCosting(0.5);
    const chat = new BudgetGuard(memoryStore(39.8), 40, notify, now).wrap(inner);

    await chat([], []); // 39.8 -> 40.3: allowed, crosses 100%, alert sent
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("100%"));
    await expect(chat([], [])).rejects.toBeInstanceOf(BudgetExceededError);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
