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
