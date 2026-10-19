import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdsTools } from "../ads/index.js";
import type { ChatFn } from "../llm/openrouter.js";
import { parseMcpKeys } from "./keys.js";
import { createMcpRouter } from "./server.js";

const READ_KEY = "read-only-key-0123456789abcdef";
const PROPOSE_KEY = "planner-key-0123456789abcdef";

const ok = async () => ({ result: { ok: true }, issues: [], sources: [] });
const ads = { listAdSets: ok, getPerformance: ok, comparePeriods: ok, accountOverview: ok } as unknown as AdsTools;
const chat: ChatFn = async () => ({ message: { content: "Account is fine." }, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } });
const proposePause = vi.fn(async () => ({ requestId: "ABC123", status: "pending", note: "Nothing has been paused." }));

let server: Server;
let url: URL;

beforeAll(async () => {
  const app = express();
  app.use(
    "/mcp",
    createMcpRouter({
      clients: parseMcpKeys(`reports:${READ_KEY}:read,planner:${PROPOSE_KEY}:read+propose`),
      ads,
      chat,
      proposePause,
      getRequest: async () => null,
    }),
  );
  server = app.listen(0);
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

afterAll(() => {
  server.close();
});

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();

describe("MCP server", () => {
  it("rejects a request without a valid key", async () => {
    const res = await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong-key" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("gives a read-only client data tools but not propose_pause", async () => {
    const client = await connect(READ_KEY);
    expect(await toolNames(client)).toEqual(["account_overview", "ask_analyst", "compare_periods", "get_performance", "list_adsets"]);
  });

  it("gives a propose client propose_pause and get_request_status, and no client an approve tool", async () => {
    const names = await toolNames(await connect(PROPOSE_KEY));
    expect(names).toContain("propose_pause");
    expect(names).toContain("get_request_status");
    expect(names.some((n) => /approve|execute|set_status/.test(n))).toBe(false);
  });

  it("does not let a read-only client call propose_pause", async () => {
    const client = await connect(READ_KEY);
    const result = await client.callTool({ name: "propose_pause", arguments: { adsetId: "as_broad_image", reason: "CPA is 210" } });
    expect(result.isError).toBe(true);
    expect(proposePause).not.toHaveBeenCalled();
  });

  it("creates a pending request for a propose client, recorded as coming from MCP", async () => {
    const client = await connect(PROPOSE_KEY);
    const result = await client.callTool({ name: "propose_pause", arguments: { adsetId: "as_broad_image", reason: "CPA is 210 on 9 conversions" } });
    expect(result.isError).toBe(false);
    expect(proposePause).toHaveBeenCalledWith(
      { adsetId: "as_broad_image", reason: "CPA is 210 on 9 conversions" },
      { channel: "mcp", name: "planner (MCP)" },
    );
  });

  it("runs data tools and ask_analyst", async () => {
    const client = await connect(READ_KEY);
    const perf = await client.callTool({ name: "get_performance", arguments: { adsetId: "as_cart" } });
    expect(perf.content).toEqual([{ type: "text", text: expect.stringContaining('"ok":true') }]);
    const answer = await client.callTool({ name: "ask_analyst", arguments: { question: "How is the account?" } });
    expect(answer.content).toEqual([{ type: "text", text: "Account is fine." }]);
  });
});

describe("parseMcpKeys", () => {
  it("rejects unknown scopes and short keys", () => {
    expect(() => parseMcpKeys(`x:${READ_KEY}:approve`)).toThrow('unknown scope "approve"');
    expect(() => parseMcpKeys("x:short:read")).toThrow("at least 24 characters");
  });
});
