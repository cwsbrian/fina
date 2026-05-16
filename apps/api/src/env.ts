import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  WEB_APP_URL: z.string().url(),
  EMAIL_FROM: z.string().default("Fina <noreply@fina.app>"),
  // Comma-separated extra origins allowed in dev (CORS + Better Auth trustedOrigins).
  // Default empty; baseline allowlist still includes localhost:3000 and :3100.
  // Use this to add LAN/Tailscale IPs when smoke-testing from another device.
  DEV_ORIGINS: z.string().optional(),
  // Plaid
  PLAID_CLIENT_ID: z.string(),
  PLAID_SECRET: z.string(),
  PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  // Soft deadline for the initial sync inside POST /plaid/exchange. Tests
  // override to a small value so the timeout path is exercised with real
  // timers (vi.useFakeTimers + fastify.inject is racy and brittle).
  PLAID_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Plaid webhook delivery URL (Tailscale Funnel in dev, prod URL in prod).
  // Optional — unit tests + local dev without Funnel omit it. linkTokenCreate
  // and the startup backfill task skip when absent.
  // z.preprocess converts blank string ("PLAID_WEBHOOK_URL=" in .env) → undefined,
  // so dotenv-loaded empty values don't fail the url() validator.
  PLAID_WEBHOOK_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  // AES-256-GCM key for at-rest encryption (Plaid access_token).
  // Must base64-decode to exactly 32 bytes. Validation happens lazily inside
  // the crypto helper so tests can use a fixed value without re-running zod.
  ENCRYPTION_KEY: z.string(),
  // Gemini (categorize)
  GEMINI_API_KEY: z.string(),
  // OPTIONAL — keeps test literals clean. Use `env.CATEGORIZE_BATCH_MAX ?? 50`
  // in service code. z.default() would make the inferred Env type non-optional.
  CATEGORIZE_BATCH_MAX: z.coerce.number().int().positive().optional(),
  // Scheduler — off by default so dev/test never fire cron jobs.
  // Use "true" or "1" to enable (env vars are always strings).
  // .optional() keeps test env literals clean (same convention as CATEGORIZE_BATCH_MAX).
  CRON_ENABLED: z.preprocess(
    (v) => (v === "true" || v === "1" ? true : v === "false" ? false : v),
    z.boolean().optional(),
  ),
  // TTL for plaid_webhook_events rows in days. Default 30 applied at use site with ?? 30.
  CRON_EVENT_TTL_DAYS: z.coerce.number().int().positive().optional(),
  // Chat — all .optional() (test-env friendly); use-site applies defaults via `?? N`.
  CHAT_MODEL: z.string().optional(),
  CHAT_HISTORY_LIMIT_MESSAGES: z.coerce.number().int().positive().optional(),
  CHAT_HISTORY_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
  CHAT_MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
