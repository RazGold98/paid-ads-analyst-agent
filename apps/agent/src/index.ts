import type { Server } from "node:http";
import express from "express";
import { webhookCallback } from "grammy";
import { bot } from "./bot.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { app } from "./server.js";

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => (err ? reject(err) : resolve(server)));
  });
}

async function main(): Promise<void> {
  const { webhook } = config;

  if (webhook) {
    // grammY's express adapter reads the update from req.body, so parse JSON first.
    app.post(
      "/telegram/webhook",
      express.json(),
      webhookCallback(bot, "express", { secretToken: webhook.secret }),
    );
  }

  const server = await listen(config.port);
  logger.info({ port: config.port, mode: webhook ? "webhook" : "polling" }, "HTTP server listening");

  if (webhook) {
    const ok = await bot.api.setWebhook(webhook.url, { secret_token: webhook.secret });
    logger.info({ url: webhook.url, ok }, "Telegram webhook set");
  } else {
    // Polling fails while a webhook is registered, so remove any leftover one.
    await bot.api.deleteWebhook();
    // bot.start() resolves only when polling stops, so don't await it here.
    bot
      .start({ onStart: (me) => logger.info({ username: me.username }, "Bot polling started") })
      .catch((err) => {
        logger.fatal({ err }, "Polling stopped with an error");
        process.exit(1);
      });
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    await bot.stop();
    server.close((err) => {
      if (err) {
        logger.error({ err }, "Error while closing HTTP server");
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
