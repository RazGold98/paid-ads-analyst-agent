import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type RequestHandler, type Router } from "express";
import { z } from "zod";
import type { ActionRequest, Requester } from "../actions/store.js";
import type { AdsTools } from "../ads/index.js";
import { runAgent } from "../agent/run.js";
import { executeTool, toolSpecs, type ToolContext } from "../agent/toolDefs.js";
import type { ChatFn } from "../llm/openrouter.js";
import { findClient, type McpClient, type Scope } from "./keys.js";

export interface McpDeps {
  clients: McpClient[];
  ads: AdsTools;
  chat: ChatFn;
  // Creates a pending request and notifies the human approvers in Telegram.
  proposePause: (args: { adsetId: string; reason: string }, requestedBy: Requester) => Promise<unknown>;
  getRequest: (id: string) => Promise<ActionRequest | null>;
  onToolCall?: (client: string, tool: string) => void;
}

// Which scope each shared agent tool needs. There is deliberately no approve or execute tool.
const TOOL_SCOPE: Record<string, Scope> = {
  list_adsets: "read",
  get_performance: "read",
  compare_periods: "read",
  account_overview: "read",
  propose_pause: "propose",
};

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

/** An MCP server with only the tools this client's scopes allow: a read-only client never sees propose_pause. */
function buildServer(deps: McpDeps, client: McpClient): McpServer {
  const server = new McpServer({ name: "paid-ads-analyst", version: "0.1.0" });
  const allowed = (scope: Scope) => client.scopes.includes(scope);
  const requestedBy: Requester = { channel: "mcp", name: `${client.name} (MCP)` };
  const ctx: ToolContext = { ads: deps.ads, proposePause: (args) => deps.proposePause(args, requestedBy) };

  for (const tool of toolSpecs) {
    if (!allowed(TOOL_SCOPE[tool.name])) continue;
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.args }, async (args: unknown) => {
      deps.onToolCall?.(client.name, tool.name);
      const result = await executeTool(ctx, tool.name, JSON.stringify(args));
      return text(result, "error" in JSON.parse(result));
    });
  }

  if (allowed("read")) {
    server.registerTool(
      "ask_analyst",
      {
        description: "Ask the paid-ads analyst a question in plain language; it answers from the ad account's data with sources and confidence.",
        inputSchema: z.object({ question: z.string().min(3).max(1000) }),
      },
      async ({ question }) => {
        deps.onToolCall?.(client.name, "ask_analyst");
        // No proposePause here: asking a question can never create a pause request, whatever the question says.
        const result = await runAgent({ chat: deps.chat, tools: deps.ads, history: [], question });
        return text(result.answer);
      },
    );
  }

  if (allowed("propose")) {
    server.registerTool(
      "get_request_status",
      {
        description: "Status of a pause request created with propose_pause: pending, succeeded, failed, unknown, rejected or expired.",
        inputSchema: z.object({ requestId: z.string() }),
      },
      async ({ requestId }) => {
        deps.onToolCall?.(client.name, "get_request_status");
        const r = await deps.getRequest(requestId);
        if (!r) return text(JSON.stringify({ error: `Request ${requestId} not found` }), true);
        return text(
          JSON.stringify({ requestId: r._id, adsetId: r.adsetId, status: r.status, result: r.result, decidedBy: r.decidedBy?.name, expiresAt: r.expiresAt }),
        );
      },
    );
  }

  return server;
}

/** POST /mcp with "Authorization: Bearer <key>". Stateless: every request gets a fresh server. */
export function createMcpRouter(deps: McpDeps): Router {
  const router = express.Router();

  const auth: RequestHandler = (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    const client = match ? findClient(deps.clients, match[1]) : undefined;
    if (!client) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid API key" }, id: null });
      return;
    }
    res.locals.client = client;
    next();
  };

  router.post("/", auth, express.json(), async (req, res) => {
    const server = buildServer(deps, res.locals.client as McpClient);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  // Stateless server: there are no sessions to resume or delete.
  router.all("/", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return router;
}
