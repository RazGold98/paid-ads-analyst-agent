import { Bot } from "grammy";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const bot = new Bot(config.telegramBotToken);

bot.command("start", (ctx) => ctx.reply('Hi! Send me "ping" and I\'ll answer "pong".'));

bot.hears(/^ping$/i, (ctx) => ctx.reply("pong"));

bot.catch((err) => {
  logger.error({ err: err.error, updateId: err.ctx.update.update_id }, "Error while handling update");
});
