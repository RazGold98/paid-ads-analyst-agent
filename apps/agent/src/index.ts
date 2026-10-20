import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { webhookCallback } from "grammy";
import { bot, budget, chat, notifyApprovers, proposeAndNotify, store, tools } from "./bot.js";
import { config } from "./config.js";
import { db, mongo } from "./db.js";
import { logger } from "./logger.js";
import { createMcpRouter } from "./mcp/server.js";
import { buildDailyReport } from "./report/daily.js";
import { MongoRunStore, startDailyReport } from "./report/schedule.js";
import { createApiRouter } from "./web/api.js";
import { app } from "./server.js";

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => (err ? reject(err) : resolve(server)));
  });
}

async function main(): Promise<void> {
  const { webhook } = config;

  // Connect before accepting traffic, so a bad MONGODB_URI stops the service with a clear error.
  await mongo.connect();
  logger.info({ db: config.mongo.db }, "MongoDB connected");

  if (webhook) {
    // grammY's express adapter reads the update from req.body, so parse JSON first.
    app.post(
      "/telegram/webhook",
      express.json(),
      webhookCallback(bot, "express", { secretToken: webhook.secret }),
    );
  }

  // MCP for other agents: read and propose only. Off unless MCP_API_KEYS is set.
  if (config.mcpClients.length > 0) {
    app.use(
      "/mcp",
      createMcpRouter({
        clients: config.mcpClients,
        ads: tools,
        chat,
        proposePause: proposeAndNotify,
        getRequest: (id) => store.get(id),
        onToolCall: (client, tool) => logger.info({ client, tool }, "MCP tool call"),
      }),
    );
  }

  // The GUI: a JSON API, and the React app built into dist/public (see web/vite.config.ts).
  app.use(
    "/api",
    createApiRouter({
      accessCode: config.approverCode,
      ads: tools,
      chat,
      proposePause: proposeAndNotify,
      store,
      budget: () => budget.status(),
      onError: (err) => logger.error({ err }, "GUI chat failed"),
    }),
  );
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
  if (existsSync(publicDir)) app.use(express.static(publicDir));

  const server = await listen(config.port);
  logger.info(
    { port: config.port, mode: webhook ? "webhook" : "polling", mcpClients: config.mcpClients.map((c) => c.name) },
    "HTTP server listening",
  );

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

  // The scheduled task: the morning report to the approvers, once per day.
  const stopReport = startDailyReport({
    ...config.report,
    runs: new MongoRunStore(db),
    send: async (date) => {
      await notifyApprovers(await buildDailyReport(tools, date));
      logger.info({ date }, "Daily report sent");
    },
    onError: (err) => logger.error({ err }, "Daily report failed"),
  });
  logger.info(config.report, "Daily report scheduled");

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    stopReport();
    await bot.stop();
    await mongo.close();
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
