import { betterAuth, APIError } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { magicLink, emailOTP } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
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
  const socialProviders: Record<
    string,
    { clientId: string; clientSecret: string; appBundleIdentifier?: string }
  > = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET) {
    socialProviders.apple = {
      clientId: env.APPLE_CLIENT_ID, // Services ID (web flow audience)
      clientSecret: env.APPLE_CLIENT_SECRET, // .p8-derived JWT, ≤6mo (operator regenerates)
      appBundleIdentifier: "com.withfina.app", // native iOS idToken audience
    };
  }

  const devOrigins = parseDevOrigins(env.DEV_ORIGINS);

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Production: the deployed web origin + mobile native scheme.
    // expo() plugin below also injects "fina://" automatically, but listing
    // it here is defensive — if the plugin chain ever changes, Better Auth
    // still rejects unsigned origins instead of silently accepting them.
    trustedOrigins:
      env.NODE_ENV === "production"
        ? [env.WEB_APP_URL, "fina://"]
        : ["http://localhost:3000", "http://localhost:3100", "fina://", ...devOrigins],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailVerification: {
      // After /email-otp/verify-email succeeds, mint a session and set the
      // cookie in the same response so the client doesn't have to re-sign-in
      // with the password they just typed. Default Better Auth would leave the
      // user verified-but-signed-out, and our /home would 401.
      autoSignInAfterVerification: true,
    },
    emailAndPassword: {
      enabled: true,
      // Anti-enumeration off so duplicate sign-ups get an explicit
      // USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL error (Better Auth otherwise
      // returns a synthetic "success" when requireEmailVerification is on,
      // which made our UX show "Check your email" for already-registered
      // emails). Sign-in for unverified users is blocked manually below via
      // hooks.before.
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(env.RESEND_API_KEY, env.EMAIL_FROM, {
          to: user.email,
          subject: "Reset your Fina password",
          text: `Hi,\n\nWe got a request to reset your Fina password. Tap the link below to pick a new one:\n\n${url}\n\nThis link expires in 1 hour. If you didn't ask for this, you can safely ignore this email.`,
        });
      },
    },
    socialProviders,
    // Link a social sign-in to a pre-existing user by email. Default semantics
    // (NOT trustedProviders, which would skip the provider email-verified check
    // and risk takeover): link only when BOTH the provider email_verified AND
    // the local account are verified.
    account: { accountLinking: { enabled: true } },
    plugins: [
      // Expo plugin enables mobile native scheme (e.g. `fina://`) as a
      // trusted origin and stops Better Auth from rejecting requests with
      // "missing or null origin" — React Native fetch doesn't send Origin
      // headers the same way browsers do. Must be paired with the same
      // expoClient() plugin on the mobile client (already configured).
      expo(),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(env.RESEND_API_KEY, env.EMAIL_FROM, {
            to: email,
            subject: "Your Fina sign-in link",
            text: `Click to sign in: ${url}\n\nThis link expires in 10 minutes.`,
          });
        },
      }),
      emailOTP({
        sendVerificationOnSignUp: true,
        expiresIn: 600, // 10 minutes — matches the verify screen copy
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "email-verification") return;
          await sendEmail(env.RESEND_API_KEY, env.EMAIL_FROM, {
            to: email,
            subject: "Your Fina verification code",
            text: `Your Fina verification code:\n\n${otp}\n\nIt expires in 10 minutes. If you didn't ask for this, you can safely ignore this email.`,
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
    hooks: {
      // Replaces emailAndPassword.requireEmailVerification (which we turned
      // off so duplicate signups throw an explicit error instead of returning
      // a synthetic success). Manually reject sign-in for unverified users.
      // signUp itself doesn't autoSignIn for unverified accounts because the
      // email-otp plugin owns the verify-then-session handoff.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = (ctx.body as { email?: unknown })?.email;
        if (typeof email !== "string") return;
        const found = await ctx.context.internalAdapter.findUserByEmail(
          email.toLowerCase(),
        );
        if (found?.user && !found.user.emailVerified) {
          throw new APIError("FORBIDDEN", {
            code: "EMAIL_NOT_VERIFIED",
            message:
              "Email not verified. Check your inbox for the verification code.",
          });
        }
      }),
    },
  });
}
