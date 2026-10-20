import { z } from "zod";

// OpenRouter speaks the OpenAI chat-completions format, so these types follow it.
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  // USD as reported by OpenRouter; null if it did not report a cost.
  costUsd: number | null;
}

export interface ChatResponse {
  message: { content: string | null; tool_calls?: ToolCall[] };
  usage: Usage;
}

/** One model call. The agent depends on this type, so tests can pass a fake. */
export type ChatFn = (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatResponse>;

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number(), cost: z.number().optional() })
    .optional(),
});

const URL = "https://openrouter.ai/api/v1/chat/completions";

// Caps each reply, so one call can never cost more than a few tenths of a cent. Without it OpenRouter
// reserves credit for the model's maximum output (65k tokens). Answers use ~400-3,000 tokens.
const MAX_TOKENS = 4096;

export function createOpenRouterChat(opts: { apiKey: string; model: string; timeoutMs?: number }): ChatFn {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return async (messages, tools) => {
    let res: Response;
    try {
      res = await fetch(URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
          "x-title": "Paid Ads Analyst Agent",
        },
        // usage.include asks OpenRouter to report the cost of this call (used by the budget guard).
        body: JSON.stringify({ model: opts.model, messages, tools, max_tokens: MAX_TOKENS, usage: { include: true } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LlmError(`Model request failed: ${(err as Error).message}`);
    }

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
      throw new LlmError(`Model returned HTTP ${res.status}: ${message.success ? message.data.error.message : "no details"}`);
    }

    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success) throw new LlmError("Unexpected response format from the model");

    const { message } = parsed.data.choices[0];
    const usage = parsed.data.usage;
    return {
      message: { content: message.content ?? null, tool_calls: message.tool_calls ?? undefined },
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        costUsd: usage?.cost ?? null,
      },
    };
  };
}
