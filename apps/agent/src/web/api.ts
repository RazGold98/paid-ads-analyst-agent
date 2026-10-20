import { createHash, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Router } from "express";
import { z } from "zod";
import type { ActionStore, Requester } from "../actions/store.js";
import type { AdsTools } from "../ads/index.js";
import { runAgent } from "../agent/run.js";
import { BudgetExceededError, type BudgetStatus } from "../budget/guard.js";
import type { ChatFn } from "../llm/openrouter.js";

export interface ApiDeps {
  // The GUI uses the approver code as its login: chat costs money, so it is not open to everyone.
  accessCode: string;
  ads: AdsTools;
  chat: ChatFn;
  proposePause: (args: { adsetId: string; reason: string }, requestedBy: Requester) => Promise<unknown>;
  store: Pick<ActionStore, "recentRequests" | "recentAudit">;
  budget: () => Promise<BudgetStatus>;
  onError?: (err: unknown) => void;
}

const ChatBody = z.object({
  question: z.string().trim().min(1).max(2000),
  // The browser keeps the conversation and sends the last few turns, so the server stays stateless.
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(6)
    .default([]),
});

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** JSON API for the React GUI, under /api. Read-only except chat; approving stays in Telegram. */
export function createApiRouter(deps: ApiDeps): Router {
  const router = express.Router();
  const expected = sha256(deps.accessCode);

  const auth: RequestHandler = (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (!match || !timingSafeEqual(sha256(match[1]), expected)) {
      res.status(401).json({ error: "Missing or wrong access code" });
      return;
    }
    next();
  };

  router.use(auth, express.json());

  router.post("/chat", async (req, res) => {
    const body = ChatBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Send { question, history? }" });
      return;
    }
    try {
      const result = await runAgent({
        chat: deps.chat,
        tools: deps.ads,
        // A pause proposed from the GUI goes to the Telegram approvers like any other.
        proposePause: (args) => deps.proposePause(args, { channel: "web", name: "GUI user" }),
        history: body.data.history,
        question: body.data.question,
      });
      res.json({ answer: result.answer, toolCalls: result.toolCalls });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        res.status(429).json({ error: `${err.message}. The agent will answer again next month.` });
        return;
      }
      deps.onError?.(err);
      res.status(500).json({ error: "Something went wrong while answering. Try again in a minute." });
    }
  });

  router.get("/requests", async (_req, res) => {
    res.json(await deps.store.recentRequests(20));
  });

  router.get("/audit", async (_req, res) => {
    res.json(await deps.store.recentAudit(50));
  });

  router.get("/budget", async (_req, res) => {
    res.json(await deps.budget());
  });

  return router;
}
