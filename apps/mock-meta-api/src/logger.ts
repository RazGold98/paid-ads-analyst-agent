import { pino } from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: "info",
  // pino-pretty is a dev dependency, so it is only loaded outside production.
  transport: config.isProduction ? undefined : { target: "pino-pretty" },
});
