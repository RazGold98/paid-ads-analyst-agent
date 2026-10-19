import { z } from "zod";
import { AdsApiError } from "../ads/client.js";
import type { AdsTools } from "../ads/index.js";
import type { ToolDefinition } from "../llm/openrouter.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD (UTC)");
const filter = {
  adsetId: z.string().optional().describe("Only this ad set, e.g. as_women_video"),
  campaignId: z.string().optional().describe("Only ad sets in this campaign"),
};

interface Tool {
  description: string;
  args: z.ZodType;
  run: (tools: AdsTools, args: unknown) => Promise<unknown>;
}

// Typed per tool: `run` receives arguments that already passed the `args` schema.
function defineTool<S extends z.ZodType>(def: {
  description: string;
  args: S;
  run: (tools: AdsTools, args: z.output<S>) => Promise<unknown>;
}): Tool {
  return { ...def, run: (tools, args) => def.run(tools, args as z.output<S>) };
}

// The tools the model may call, by name.
const TOOLS: Record<string, Tool> = {
  list_adsets: defineTool({
    description: "List all ad sets in the account with campaign, daily budget and status (ACTIVE/PAUSED).",
    args: z.object({}),
    run: (tools) => tools.listAdSets(),
  }),
  get_performance: defineTool({
    description:
      "Totals and ratios (spend, conversions, CTR, CPC, CPM, CPA, ROAS) for a date range. Defaults to the last 30 days. Optional filter by ad set or campaign.",
    args: z.object({ ...filter, since: date.optional(), until: date.optional() }),
    run: (tools, args) => tools.getPerformance(args),
  }),
  compare_periods: defineTool({
    description:
      "Compare the last N days with the N days before (e.g. this week vs last week), with % change per metric. Use this for 'what changed' questions.",
    args: z.object({ ...filter, days: z.number().int().min(1).max(15).optional().describe("Period length, default 7") }),
    run: (tools, args) => tools.comparePeriods(args),
  }),
  account_overview: defineTool({
    description: "Every ad set's metrics for the last N days, sorted by spend. Use for 'how is the account doing' questions.",
    args: z.object({ days: z.number().int().min(1).max(30).optional().describe("Period length, default 7") }),
    run: (tools, args) => tools.accountOverview(args),
  }),
};

export const toolDefinitions: ToolDefinition[] = Object.entries(TOOLS).map(([name, tool]) => {
  // z.toJSONSchema adds a "$schema" key the model does not need.
  const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.args);
  return { type: "function", function: { name, description: tool.description, parameters } };
});

/**
 * Runs one tool call from the model and returns the text to send back to it.
 * Bad arguments and Ads API errors go back to the model so it can explain them; only bugs throw.
 */
export async function executeTool(tools: AdsTools, name: string, rawArgs: string): Promise<string> {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });

  let json: unknown;
  try {
    json = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
  } catch {
    return JSON.stringify({ error: "Arguments were not valid JSON" });
  }
  const args = tool.args.safeParse(json);
  if (!args.success) {
    return JSON.stringify({ error: "Invalid arguments", details: args.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }

  try {
    return JSON.stringify(await tool.run(tools, args.data));
  } catch (err) {
    if (err instanceof AdsApiError) {
      return JSON.stringify({ error: "Ads API unavailable", code: err.code, message: err.message });
    }
    throw err;
  }
}
