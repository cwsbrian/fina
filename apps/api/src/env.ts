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
  // AES-256-GCM key for at-rest encryption (Plaid access_token).
  // Must base64-decode to exactly 32 bytes. Validation happens lazily inside
  // the crypto helper so tests can use a fixed value without re-running zod.
  ENCRYPTION_KEY: z.string(),
  // Gemini (categorize)
  GEMINI_API_KEY: z.string(),
  // OPTIONAL — keeps test literals clean. Use `env.CATEGORIZE_BATCH_MAX ?? 50`
  // in service code. z.default() would make the inferred Env type non-optional.
  CATEGORIZE_BATCH_MAX: z.coerce.number().int().positive().optional(),
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
