// Ask the agent one question from the terminal: npm run ask -- "How is the account doing?"
import { createAdsTools } from "../ads/index.js";
import { runAgent } from "../agent/run.js";
import { config } from "../config.js";
import { createOpenRouterChat } from "../llm/openrouter.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}

const result = await runAgent({
  chat: createOpenRouterChat(config.llm),
  tools: createAdsTools(),
  history: [],
  question,
});

console.log(`\n${result.answer}\n`);
console.log(`Model: ${config.llm.model}`);
console.log(`Tools called: ${result.toolCalls.join(", ") || "none"}`);
console.log(
  `Tokens: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out, cost: ${
    result.usage.costUsd === null ? "unknown" : `$${result.usage.costUsd.toFixed(5)}`
  }`,
);
