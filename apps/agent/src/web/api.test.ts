import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdsTools } from "../ads/index.js";
import { BudgetExceededError } from "../budget/guard.js";
import type { ChatFn } from "../llm/openrouter.js";
import { createApiRouter } from "./api.js";

const CODE = "gui-access-code-123";
let chat: ChatFn = async () => ({ message: { content: "Account is fine." }, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } });
const recentRequests = vi.fn(async () => []);

let server: Server;
let base: string;

beforeAll(() => {
  const app = express();
  app.use(
    "/api",
    createApiRouter({
      accessCode: CODE,
      ads: {} as AdsTools,
      chat: (m, t) => chat(m, t),
      proposePause: async () => ({}),
      store: { recentRequests, recentAudit: async () => [] },
      budget: async () => ({ month: "2026-10", spentUsd: 1.5, budgetUsd: 40, fraction: 0.0375 }),
    }),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server.close();
});

const call = (path: string, init: RequestInit = {}, code = CODE) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${code}`, "content-type": "application/json" } });

describe("GUI API", () => {
  it("rejects requests without the access code", async () => {
    expect((await call("/budget", {}, "wrong")).status).toBe(401);
    expect(recentRequests).not.toHaveBeenCalled();
  });

  it("answers a chat question", async () => {
    const res = await call("/chat", { method: "POST", body: JSON.stringify({ question: "How is the account?" }) });
    expect(await res.json()).toEqual({ answer: "Account is fine.", toolCalls: [] });
  });

  it("rejects a malformed chat request", async () => {
    const res = await call("/chat", { method: "POST", body: JSON.stringify({ question: "" }) });
    expect(res.status).toBe(400);
  });

  it("says clearly when the budget is used up", async () => {
    chat = async () => {
      throw new BudgetExceededError(40.01, 40);
    };
    const res = await call("/chat", { method: "POST", body: JSON.stringify({ question: "How is the account?" }) });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("Monthly AI budget reached");
  });

  it("returns the budget status", async () => {
    expect(await (await call("/budget")).json()).toMatchObject({ spentUsd: 1.5, budgetUsd: 40 });
  });
});
