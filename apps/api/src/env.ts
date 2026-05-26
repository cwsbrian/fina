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
  // Stripe
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_PRICE_LITE_MONTHLY: z.string(),
  STRIPE_PRICE_PRO_MONTHLY: z.string(),
  // Per-app Stripe Portal configuration ID (cfg_...). Optional — when
  // set, /billing/portal sessions use this configuration for branding,
  // allowed products, and return URLs. Each app under the same Stripe
  // account gets its own configuration so users see app-specific UI.
  // Omit (or leave blank) to fall back to Stripe's Default configuration.
  STRIPE_PORTAL_CONFIGURATION: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),
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
  // TTL for resolved ScheduledSpend rows in days. Default 90 applied at use
  // site with ?? 90. "Resolved" = dismissedAt set OR matchedTxId set.
  SCHEDULED_SPEND_TTL_DAYS: z.coerce.number().int().positive().optional(),
  // Chat — all .optional() (test-env friendly); use-site applies defaults via `?? N`.
  CHAT_MODEL: z.string().optional(),
  CHAT_HISTORY_LIMIT_MESSAGES: z.coerce.number().int().positive().optional(),
  CHAT_HISTORY_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
  CHAT_MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().positive().optional(),
  // Prisma connection pool size. Default 10 covers cron + webhook + a
  // few request handlers without pool starvation under singleFork tests.
  PRISMA_CONNECTION_LIMIT: z.coerce.number().int().min(1).default(10),
  // Strict opt-in (Plan 1J Task 2): no default — production deployments
  // must explicitly state whether they're behind a CDN/LB that strips
  // client-set X-Forwarded-For. Setting true without that infrastructure
  // lets attackers spoof X-Forwarded-For to rotate rate-limit buckets and
  // pollute audit IPs.
  TRUST_PROXY: z.preprocess(
    (v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v),
    z.boolean(),
  ),
  // Opt-in for rate-limit integration tests. When NODE_ENV=test and
  // this is unset, the rate-limit plugin skips registration entirely.
  RATE_LIMIT_TEST: z.string().optional(),
  // Plan 2C: optional. Expo Push works without auth on free tier; setting
  // this raises rate limits and unlocks receipt polling (v1.5+).
  EXPO_ACCESS_TOKEN: z.string().optional(),
  // Apple IAP
  APPLE_BUNDLE_ID: z.string().optional(),
  APPLE_ASC_ISSUER_ID: z.string().optional(),
  APPLE_ASC_KEY_ID: z.string().optional(),
  // App Store Connect numeric "App Apple ID" — required for production
  // ASSN V2 notification verification (Apple's SDK validates this
  // against the JWT payload). Find it in App Store Connect →
  // your app → App Information → General Information → "Apple ID".
  // Optional in dev/sandbox; required at requireIapEnv() boundary in prod.
  APPLE_APP_APPLE_ID: z.coerce.number().int().positive().optional(),
  // PEM-encoded .p8 — accept raw OR base64. The IAP env-guard verifies
  // shape ("BEGIN PRIVATE KEY") without ever including the value in
  // an error message.
  APPLE_ASC_PRIVATE_KEY: z.string().optional(),
  APPLE_ENV: z.enum(["sandbox", "production"]).optional(),
  // Google IAP
  GOOGLE_PACKAGE_NAME: z.string().optional(),
  // JSON service-account key. Accept raw OR base64 (base64 preferred
  // for Vercel's 4 KB per-var cap). Loader tries raw first, falls back
  // to base64 when the value doesn't start with '{'.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PUBSUB_VERIFY_AUDIENCE: z.string().optional(),
  GOOGLE_PUBSUB_VERIFY_EMAIL: z.string().optional(),
  GOOGLE_PUBSUB_SUBSCRIPTION_NAME: z.string().optional(),
});

const ParsedSchema = Schema.refine(
  (e) => {
    if (e.NODE_ENV !== "production") return true;
    if (!e.RESEND_API_KEY) return false;
    return e.RESEND_API_KEY.startsWith("re_") && e.RESEND_API_KEY.length >= 24;
  },
  { message: "RESEND_API_KEY must be a real Resend key in production", path: ["RESEND_API_KEY"] },
);

export type Env = z.infer<typeof ParsedSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = ParsedSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
