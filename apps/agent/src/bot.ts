import { Bot } from "grammy";
import { createAdsTools } from "./ads/index.js";
import { runAgent } from "./agent/run.js";
import { config } from "./config.js";
import { createOpenRouterChat, type ChatMessage } from "./llm/openrouter.js";
import { logger } from "./logger.js";

export const bot = new Bot(config.telegramBotToken);

const tools = createAdsTools();
const chat = createOpenRouterChat(config.llm);

// Last few user/assistant messages per chat, so follow-ups ("and the men's ad set?") work.
// Kept in memory: lost on restart, which is fine for short follow-up context.
const HISTORY_MESSAGES = 6;
const histories = new Map<number, ChatMessage[]>();

// Telegram rejects messages longer than this.
const TELEGRAM_MAX_LENGTH = 4096;

bot.command("start", (ctx) =>
  ctx.reply(
    "Hi! I'm the paid-ads analyst for Stride Footwear. I answer from the Meta ad account's data.\n\n" +
      'Try: "How is the account doing this week?" or "Why did CPA go up on as_women_video?"',
  ),
);

bot.on("message:text", (ctx) => {
  // Answer in the background: an agent run can take longer than Telegram's webhook timeout.
  void answer(ctx.chat.id, ctx.message.text);
});

async function answer(chatId: number, question: string): Promise<void> {
  // Telegram shows "typing..." for about 5 seconds, so keep refreshing it until the answer is sent.
  const typing = () => bot.api.sendChatAction(chatId, "typing").catch(() => {});
  void typing();
  const typingTimer = setInterval(typing, 4000);

  try {
    const history = histories.get(chatId) ?? [];
    const result = await runAgent({ chat, tools, history, question });
    logger.info({ chatId, toolCalls: result.toolCalls, usage: result.usage }, "Agent answered");

    const turn: ChatMessage[] = [
      { role: "user", content: question },
      { role: "assistant", content: result.answer },
    ];
    histories.set(chatId, [...history, ...turn].slice(-HISTORY_MESSAGES));

    // Telegram shows Markdown markers literally, and the model sometimes uses bold despite the prompt.
    const text = result.answer.replaceAll("**", "");
    for (let i = 0; i < text.length; i += TELEGRAM_MAX_LENGTH) {
      await bot.api.sendMessage(chatId, text.slice(i, i + TELEGRAM_MAX_LENGTH));
    }
  } catch (err) {
    logger.error({ err, chatId }, "Agent failed");
    await bot.api
      .sendMessage(chatId, "Sorry, something went wrong while answering. Please try again in a minute.")
      .catch(() => {});
  } finally {
    clearInterval(typingTimer);
  }
}

bot.catch((err) => {
  logger.error({ err: err.error, updateId: err.ctx.update.update_id }, "Error while handling update");
});
