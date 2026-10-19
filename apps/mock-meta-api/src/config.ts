import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    MOCK_API_TOKEN: z.string({ error: "Required" }).min(16),
    MONGODB_URI: z.string({ error: "Required" }).min(1),
    MONGODB_DB: z.string().min(1).default("mock_meta"),
    FAIL_PAUSE_ADSET_IDS: z.string().default(""),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    port: env.PORT,
    mockApiToken: env.MOCK_API_TOKEN,
    mongodbUri: env.MONGODB_URI,
    mongodbDb: env.MONGODB_DB,
    failPauseAdsetIds: new Set(
      env.FAIL_PAUSE_ADSET_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  }));

// Treat empty values (e.g. `FAIL_PAUSE_ADSET_IDS=` copied from .env.example) as unset.
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
