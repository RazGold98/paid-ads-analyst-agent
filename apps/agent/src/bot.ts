import { createHash, timingSafeEqual } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import type { User } from "grammy/types";
import { cardText, proposalForModel } from "./actions/card.js";
import { approvePause, proposePause, rejectPause, type Outcome, type PauseDeps } from "./actions/pause.js";
import { MongoActionStore, type ActionRequest, type Requester } from "./actions/store.js";
import { createAdsClient, createAdsTools } from "./ads/index.js";
import { runAgent } from "./agent/run.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { createOpenRouterChat, type ChatMessage } from "./llm/openrouter.js";
import { logger } from "./logger.js";

export const bot = new Bot(config.telegramBotToken);

const client = createAdsClient();
// Shared with the MCP server (index.ts), so both channels use the same tools, model and approvals.
export const tools = createAdsTools(client);
export const chat = createOpenRouterChat(config.llm);
export const store = new MongoActionStore(db);
const actions: PauseDeps = { store, client, ads: tools };

// Last few user/assistant messages per chat, so follow-ups ("and the men's ad set?") work.
// Kept in memory: lost on restart, which is fine for short follow-up context.
const HISTORY_MESSAGES = 6;
const histories = new Map<number, ChatMessage[]>();

// Telegram rejects messages longer than this.
const TELEGRAM_MAX_LENGTH = 4096;

const displayName = (user: User) => (user.username ? `${user.first_name} (@${user.username})` : user.first_name);

bot.command("start", (ctx) =>
  ctx.reply(
    "Hi! I'm the paid-ads analyst for Stride Footwear. I answer from the Meta ad account's data.\n\n" +
      'Try: "How is the account doing this week?" or "Why did CPA go up on as_women_video?"\n\n' +
      "I can also ask the team to approve pausing an ad set. Approvers register with /register <code>.",
  ),
);

// Compare hashes so the check takes the same time whatever the input (no timing hints about the code).
const sha256 = (value: string) => createHash("sha256").update(value).digest();
const isApproverCode = (code: string) => timingSafeEqual(sha256(code), sha256(config.approverCode));

bot.command("register", async (ctx) => {
  if (!ctx.from) return;
  if (!isApproverCode(ctx.match.trim())) {
    await store.log({ event: "register_failed", by: displayName(ctx.from), at: new Date() });
    await ctx.reply("That code is not valid.");
    return;
  }
  await store.addApprover({ _id: ctx.from.id, name: displayName(ctx.from), chatId: ctx.chat.id, registeredAt: new Date() });
  await store.log({ event: "approver_registered", by: displayName(ctx.from), at: new Date() });
  await ctx.reply("You are now an approver. You'll get a card with Approve / Reject buttons for every pause request.");
});

bot.on("message:text", (ctx) => {
  // Answer in the background: an agent run can take longer than Telegram's webhook timeout.
  void answer(ctx.chat.id, ctx.message.text, displayName(ctx.from));
});

async function answer(chatId: number, question: string, userName: string): Promise<void> {
  // Telegram shows "typing..." for about 5 seconds, so keep refreshing it until the answer is sent.
  const typing = () => bot.api.sendChatAction(chatId, "typing").catch(() => {});
  void typing();
  const typingTimer = setInterval(typing, 4000);

  // The pause tool, bound to this user.
  const proposePauseForUser = (args: { adsetId: string; reason: string }) =>
    proposeAndNotify(args, { channel: "telegram", name: userName, chatId });

  try {
    const history = histories.get(chatId) ?? [];
    const result = await runAgent({ chat, tools, proposePause: proposePauseForUser, history, question });
    logger.info({ chatId, toolCalls: result.toolCalls, usage: result.usage }, "Agent answered");

    const turn: ChatMessage[] = [
      { role: "user", content: question },
      { role: "assistant", content: result.answer },
    ];
    histories.set(chatId, [...history, ...turn].slice(-HISTORY_MESSAGES));

    await send(chatId, result.answer);
  } catch (err) {
    logger.error({ err, chatId }, "Agent failed");
    await bot.api
      .sendMessage(chatId, "Sorry, something went wrong while answering. Please try again in a minute.")
      .catch(() => {});
  } finally {
    clearInterval(typingTimer);
  }
}

/** Creates a pending pause request and sends its card to the approvers. Used by Telegram and MCP. */
export async function proposeAndNotify(args: { adsetId: string; reason: string }, requestedBy: Requester) {
  const outcome = await proposePause(actions, { ...args, requestedBy });
  if (!outcome.ok) return { error: outcome.error };
  const notified = outcome.created ? await sendCards(outcome.request) : outcome.request.cards.length;
  return proposalForModel(outcome.request, outcome.created === true, notified);
}

async function send(chatId: number, answerText: string): Promise<void> {
  // Telegram shows Markdown markers literally, and the model sometimes uses bold despite the prompt.
  const text = answerText.replaceAll("**", "");
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LENGTH) {
    await bot.api.sendMessage(chatId, text.slice(i, i + TELEGRAM_MAX_LENGTH));
  }
}

/** Sends the approval card to every registered approver. Returns how many received it. */
async function sendCards(request: ActionRequest): Promise<number> {
  const keyboard = new InlineKeyboard().text("Approve", `approve:${request._id}`).text("Reject", `reject:${request._id}`);
  let sent = 0;
  for (const approver of await store.listApprovers()) {
    try {
      const message = await bot.api.sendMessage(approver.chatId, cardText(request), { reply_markup: keyboard });
      await store.addCard(request._id, { chatId: approver.chatId, messageId: message.message_id });
      sent++;
    } catch (err) {
      logger.warn({ err, requestId: request._id, approver: approver._id }, "Could not send approval card");
    }
  }
  return sent;
}

/** Replaces every card of a request with its final state, removing the buttons. */
async function updateCards(request: ActionRequest): Promise<void> {
  for (const card of request.cards) {
    await bot.api.editMessageText(card.chatId, card.messageId, cardText(request)).catch(() => {});
  }
}

bot.callbackQuery(/^(approve|reject):([0-9A-F]+)$/, async (ctx) => {
  const [, decision, id] = ctx.match;
  // Answer the button press at once; the work itself runs in the background like agent answers.
  await ctx.answerCallbackQuery({ text: decision === "approve" ? "Approving..." : "Rejecting..." });
  const approver = { userId: ctx.from.id, name: displayName(ctx.from) };
  void decide(decision === "approve" ? approvePause : rejectPause, id, approver, ctx.from.id);
});

async function decide(
  action: typeof approvePause,
  id: string,
  approver: { userId: number; name: string },
  approverChatId: number,
): Promise<void> {
  try {
    const outcome: Outcome = await action(actions, id, approver);
    if (!outcome.ok) {
      await bot.api.sendMessage(approverChatId, outcome.error);
      return;
    }
    const request = outcome.request;
    logger.info({ requestId: id, status: request.status, by: approver.name }, "Pause request decided");
    await updateCards(request);

    // Tell the person who asked, unless they already see the result on their own card.
    const requesterChat = request.requestedBy.chatId;
    if (requesterChat !== undefined && !request.cards.some((c) => c.chatId === requesterChat)) {
      await bot.api.sendMessage(requesterChat, `Update on pause request #${id}:\n\n${cardText(request)}`);
    }
  } catch (err) {
    logger.error({ err, requestId: id }, "Pause decision failed");
    await bot.api.sendMessage(approverChatId, `Something went wrong with request #${id}. Check its status before retrying.`).catch(() => {});
  }
}

bot.catch((err) => {
  logger.error({ err: err.error, updateId: err.ctx.update.update_id }, "Error while handling update");
});
