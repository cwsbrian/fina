import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_NATIVE_CLIENT_IDS: z.string().optional(),
  // Sign in with Apple (OAuth) — distinct from the IAP-scoped APPLE_* keys.
  // APPLE_CLIENT_ID = Services ID (web flow audience). APPLE_CLIENT_SECRET =
  // .p8-derived JWT (static; Apple caps at ≤6mo, operator regenerates).
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  WEB_APP_URL: z.string().url(),
  EMAIL_FROM: z.string().default("Fina <no-reply@buildingintent.com>"),
  SUPPORT_EMAIL_TO: z.string().default("building.intent@gmail.com"),
  // Comma-separated extra origins allowed in dev (CORS + Better Auth trustedOrigins).
  // Default empty; baseline allowlist still includes localhost:3000 and :3100.
  // Use this to add LAN/Tailscale IPs when smoke-testing from another device.
  DEV_ORIGINS: z.string().optional(),
  // Stripe
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_PRICE_PRO_MONTHLY: z.string(),
  STRIPE_PRICE_MAX_MONTHLY: z.string(),
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
  PLAID_WEBHOOK_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // AES-256-GCM key for at-rest encryption (Plaid access_token).
  // Must base64-decode to exactly 32 bytes. Validation happens lazily inside
  // the crypto helper so tests can use a fixed value without re-running zod.
  ENCRYPTION_KEY: z.string(),
  // LLM providers
  OPENAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  // Private receipt storage in Cloudflare R2. US uses the R2 US jurisdiction;
  // CA uses an Eastern North America location-hinted bucket.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_RECEIPTS_CA_BUCKET: z.string().optional(),
  R2_RECEIPTS_US_BUCKET: z.string().optional(),
  RECEIPTS_CA_QUEUE_URL: z.string().url().optional(),
  RECEIPTS_US_QUEUE_URL: z.string().url().optional(),
  // OpenAI receipt extraction. Change this value to promote the same worker
  // from the cheap baseline to Luna after running the receipt eval set.
  RECEIPT_OCR_MODEL: z.enum(["gpt-5-nano", "gpt-5.6-luna"]).optional(),
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
  // Optional global override for the tier-based weekly LLM spend caps
  // (Pro/trial $1 CAD/wk, Max $3 CAD/wk). Sum of every LlmCallLog row in the
  // last 7 days. When reached, POST /chat/threads/:tid/messages is blocked
  // with 429 llm_weekly_budget_exceeded; system-initiated LLM keeps running.
  WEEKLY_LLM_BUDGET_CAD_PER_USER: z.coerce.number().positive().optional(),
  // Model pricing is stored in USD; tier limits are CAD because Fina pricing
  // is CAD. This static conversion avoids runtime FX calls.
  LLM_BUDGET_USD_TO_CAD_RATE: z.coerce.number().positive().default(1.4),
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
  ADMIN_TOKEN_PUBLIC_KEYS: z.string().optional(),
  ADMIN_TOKEN_ISSUER: z.string().url().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
});

const ParsedSchema = Schema.refine(
  (e) => {
    if (e.NODE_ENV !== "production") return true;
    if (!e.RESEND_API_KEY) return false;
    return e.RESEND_API_KEY.startsWith("re_") && e.RESEND_API_KEY.length >= 24;
  },
  { message: "RESEND_API_KEY must be a real Resend key in production", path: ["RESEND_API_KEY"] },
).refine(
  (e) =>
    e.NODE_ENV !== "production" ||
    Boolean(e.ADMIN_TOKEN_PUBLIC_KEYS && e.ADMIN_TOKEN_ISSUER && e.ADMIN_EMAIL),
  {
    message:
      "ADMIN_TOKEN_PUBLIC_KEYS, ADMIN_TOKEN_ISSUER, and ADMIN_EMAIL are required in production",
    path: ["ADMIN_TOKEN_PUBLIC_KEYS"],
  },
).superRefine((e, ctx) => {
  if (e.NODE_ENV !== "production") return;
  const model = e.CHAT_MODEL ?? "gpt-5-nano";
  if (model.startsWith("gpt-") && !e.OPENAI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OPENAI_API_KEY is required for the configured OpenAI model",
      path: ["OPENAI_API_KEY"],
    });
  }
  if (model.startsWith("deepseek-") && !e.DEEPSEEK_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "DEEPSEEK_API_KEY is required for the configured DeepSeek model",
      path: ["DEEPSEEK_API_KEY"],
    });
  }
  if (!model.startsWith("gpt-") && !model.startsWith("deepseek-")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported CHAT_MODEL: ${model}`,
      path: ["CHAT_MODEL"],
    });
  }
});

export type Env = z.infer<typeof ParsedSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = ParsedSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export function parseAdminTokenPublicKeys(value: string | undefined): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (entries.length === 0) throw new Error();
    for (const [kid, encoded] of entries) {
      if (
        kid.length === 0 ||
        typeof encoded !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
        !Buffer.from(encoded, "base64").toString("utf8").includes("BEGIN PUBLIC KEY")
      ) {
        throw new Error();
      }
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    throw new Error("ADMIN_TOKEN_PUBLIC_KEYS is invalid");
  }
}
