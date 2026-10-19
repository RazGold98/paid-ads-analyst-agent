import type { Server } from "node:http";
import type { Express } from "express";
import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./routes.js";
import { Store } from "./store.js";

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => (err ? reject(err) : resolve(server)));
  });
}

async function main(): Promise<void> {
  const client = new MongoClient(config.mongodbUri);
  await client.connect();
  const store = new Store(client.db(config.mongodbDb));
  await store.ensureIndexes();
  logger.info({ db: config.mongodbDb }, "Connected to MongoDB");

  const server = await listen(createApp(store), config.port);
  logger.info(
    { port: config.port, failPauseAdsetIds: [...config.failPauseAdsetIds] },
    "HTTP server listening",
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Shutting down");
    server.close(async (err) => {
      if (err) logger.error({ err }, "Error while closing HTTP server");
      await client.close();
      process.exit(err ? 1 : 0);
    });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
