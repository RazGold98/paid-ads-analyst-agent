import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    TELEGRAM_BOT_TOKEN: z.string({ error: "Required" }).min(1),
    PUBLIC_URL: z.url().optional(),
    // Telegram only accepts these characters in a webhook secret token.
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,256}$/, "Must be 1-256 chars of A-Z, a-z, 0-9, _ or -")
      .optional(),
    MOCK_API_URL: z.url({ error: "Required, must be a URL" }),
    MOCK_API_TOKEN: z.string({ error: "Required" }).min(16),
    AD_ACCOUNT_ID: z.string().min(1).default("act_1001"),
    // Checked at startup so a mis-pasted value (quotes, "Bearer ", a whole .env line) fails fast.
    OPENROUTER_API_KEY: z.string({ error: "Required" }).trim().startsWith("sk-or-", "Must be the key itself, starting with sk-or-"),
    OPENROUTER_MODEL: z.string().min(1).default("anthropic/claude-haiku-5.5"),
    MONGODB_URI: z.string({ error: "Required" }).trim().startsWith("mongodb", "Must be a MongoDB connection string"),
    MONGODB_DB: z.string().min(1).default("agent"),
    // Shared with testers so they can /register as approvers. Long enough not to be guessed.
    APPROVER_CODE: z.string({ error: "Required" }).trim().min(12, "Must be at least 12 characters"),
  })
  .transform((env, ctx) => {
    let webhook: { url: string; secret: string } | undefined;

    if (env.PUBLIC_URL) {
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["TELEGRAM_WEBHOOK_SECRET"],
          message: "Required when PUBLIC_URL is set",
        });
        return z.NEVER;
      }
      webhook = {
        url: `${env.PUBLIC_URL.replace(/\/+$/, "")}/telegram/webhook`,
        secret: env.TELEGRAM_WEBHOOK_SECRET,
      };
    }

    return {
      nodeEnv: env.NODE_ENV,
      isProduction: env.NODE_ENV === "production",
      port: env.PORT,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      webhook,
      adsApi: {
        baseUrl: env.MOCK_API_URL.replace(/\/+$/, ""),
        token: env.MOCK_API_TOKEN,
        accountId: env.AD_ACCOUNT_ID,
      },
      llm: {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
      },
      mongo: {
        uri: env.MONGODB_URI,
        db: env.MONGODB_DB,
      },
      approverCode: env.APPROVER_CODE,
    };
  });

// Treat empty values (e.g. `PUBLIC_URL=` copied from .env.example) as unset.
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ""),
);

const parsed = EnvSchema.safeParse(rawEnv);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
