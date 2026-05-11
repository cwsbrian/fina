import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { magicLink } from "better-auth/plugins";
import { prisma } from "./db.js";
import type { Env } from "./env.js";
import { sendEmail } from "./email/send.js";
import { startTrialAndBootstrapWorkspace } from "./workspaces/bootstrap.js";

export type FinaAuth = ReturnType<typeof createAuth>;

export function parseDevOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function createAuth(env: Env) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  const devOrigins = parseDevOrigins(env.DEV_ORIGINS);

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins:
      env.NODE_ENV === "production"
        ? []
        : ["http://localhost:3000", "http://localhost:3100", "fina://", ...devOrigins],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    socialProviders,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(env.RESEND_API_KEY, env.EMAIL_FROM, {
            to: email,
            subject: "Your Fina sign-in link",
            text: `Click to sign in: ${url}\n\nThis link expires in 10 minutes.`,
          });
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await startTrialAndBootstrapWorkspace({ userId: user.id });
          },
        },
      },
    },
  });
}
