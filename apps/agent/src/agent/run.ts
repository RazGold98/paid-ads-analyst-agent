import type { AdsTools } from "../ads/index.js";
import type { ChatFn, ChatMessage, Usage } from "../llm/openrouter.js";
import { systemPrompt } from "./prompt.js";
import { executeTool, toolDefinitions, type ToolContext } from "./toolDefs.js";

// Upper bound on model calls per question, so a confused model cannot loop (and spend) forever.
export const MAX_STEPS = 5;
// Enforced in code, not only in the prompt: one question can never flood the approvers with requests.
export const MAX_PROPOSALS_PER_QUESTION = 1;

export interface AgentResult {
  answer: string;
  // Names of the tools called, in order; logged so every answer can be traced to its data.
  toolCalls: string[];
  usage: Usage;
}

export async function runAgent(opts: {
  chat: ChatFn;
  tools: AdsTools;
  // Creates a pending pause request for this conversation's user; omitted where no one can approve.
  proposePause?: ToolContext["proposePause"];
  // Earlier user/assistant turns of this conversation.
  history: ChatMessage[];
  question: string;
  now?: Date;
}): Promise<AgentResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(opts.now) },
    ...opts.history,
    { role: "user", content: opts.question },
  ];
  let proposals = 0;
  const proposePause = opts.proposePause;
  const context: ToolContext = {
    ads: opts.tools,
    proposePause: proposePause
      ? (args) => {
          if (proposals >= MAX_PROPOSALS_PER_QUESTION) {
            return Promise.resolve({ error: "Only one pause request per question. Ask the user which ad set to pause." });
          }
          proposals++;
          return proposePause(args);
        }
      : undefined,
  };
  const toolCalls: string[] = [];
  const usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await opts.chat(messages, toolDefinitions);
    usage.promptTokens += response.usage.promptTokens;
    usage.completionTokens += response.usage.completionTokens;
    // If any call has an unknown cost, the total is unknown too.
    usage.costUsd = usage.costUsd === null || response.usage.costUsd === null ? null : usage.costUsd + response.usage.costUsd;

    const calls = response.message.tool_calls ?? [];
    if (calls.length === 0) {
      const answer = response.message.content?.trim() || "Sorry, I could not produce an answer. Please rephrase the question.";
      return { answer, toolCalls, usage };
    }

    // The model asked for data: run each tool and send the results back in the next call.
    messages.push({ role: "assistant", content: response.message.content, tool_calls: calls });
    for (const call of calls) {
      toolCalls.push(call.function.name);
      const content = await executeTool(context, call.function.name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  return {
    answer: "Sorry, this question needed more steps than I allow. Please ask something narrower (one ad set or one period).",
    toolCalls,
    usage,
  };
}
