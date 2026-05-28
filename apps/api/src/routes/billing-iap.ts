import type { FastifyInstance } from "fastify";
import type { $Enums } from "@prisma/client";
import { IAPCheckoutBody, IAPRestoreBody, ACTIVE_SUBSCRIPTION_STATUSES } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { requireAppleIapEnv, requireGoogleIapEnv } from "../iap/env-guard.js";
import { syncSubscriptionFromIAP } from "../iap/sync-sub.js";
import { deriveAppleToken, deriveGoogleToken } from "../iap/binding.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";
import { buildMeBody } from "./billing.js";

export async function billingIapRoutes(app: FastifyInstance): Promise<void> {
  // Per-platform memoized cache. Splitting Apple and Google means a dev
  // running with only Google env (Apple Developer pending) can still
  // exercise the Android checkout/restore paths — the Apple cache stays
  // untouched and never reads APPLE_* until an iOS request arrives.
  let cachedApple: { client: AppleClient; runtimeEnv: "sandbox" | "production" } | null = null;
  let cachedGoogle: { client: GoogleClient } | null = null;

  const resolveApple = (): { client: AppleClient; runtimeEnv: "sandbox" | "production" } => {
    const injected = (app as any).fina?.iap?.appleClient as AppleClient | undefined;
    if (injected) {
      const cfg = requireAppleIapEnv(process.env);
      return { client: injected, runtimeEnv: cfg.env };
    }
    if (!cachedApple) {
      const cfg = requireAppleIapEnv(process.env);
      cachedApple = { client: new AppleClient(cfg), runtimeEnv: cfg.env };
    }
    return cachedApple;
  };

  const resolveGoogle = (): { client: GoogleClient } => {
    const injected = (app as any).fina?.iap?.googleClient as GoogleClient | undefined;
    if (injected) {
      requireGoogleIapEnv(process.env); // validate, discard result
      return { client: injected };
    }
    if (!cachedGoogle) {
      const cfg = requireGoogleIapEnv(process.env);
      cachedGoogle = { client: new GoogleClient(cfg) };
    }
    return cachedGoogle;
  };

  // The `me` response filters subscription rows by runtime environment
  // (sandbox vs production). When the request platform is Apple we have
  // a precise APPLE_ENV value; for Google we fall back to APPLE_ENV if
  // set, else "sandbox" — Google itself has no sandbox/prod env flag,
  // license-tester routing is invisible at the server boundary.
  const meRuntimeEnv = (): "sandbox" | "production" =>
    process.env.APPLE_ENV === "production" ? "production" : "sandbox";

  app.post("/billing/iap/checkout", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPCheckoutBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const userId = session.userId;

      const active = await prisma.subscription.findMany({
        where: {
          userId,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
        },
        select: { source: true },
      });
      const stripeActive = active.some((s) => s.source === "stripe");
      const iapActive = active.some((s) => s.source === "iap_apple" || s.source === "iap_google");
      if (stripeActive) return reply.code(409).send({ error: "already_subscribed_stripe" });
      if (iapActive) return reply.code(409).send({ error: "already_subscribed_iap" });

      if (parsed.data.platform === "ios") {
        const { client: appleClient } = resolveApple();
        await syncSubscriptionFromIAP({}, {
          platform: "ios",
          receipt: parsed.data.receipt,
          userId,
          productId: parsed.data.productId,
          expectedAppAccountToken: deriveAppleToken(userId),
          context: "checkout",
        }, { appleClient });
      } else {
        const { client: googleClient } = resolveGoogle();
        await syncSubscriptionFromIAP({}, {
          platform: "android",
          receipt: parsed.data.receipt,
          userId,
          productId: parsed.data.productId,
          expectedObfuscatedAccountId: deriveGoogleToken(userId),
          context: "checkout",
        }, { googleClient });
      }

      return await buildMeBody(userId, meRuntimeEnv());
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/iap/checkout" }, "iap_checkout_failed");
      return reply.code(500).send({ error: "iap_checkout_failed" });
    }
  });

  app.post("/billing/iap/restore", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPRestoreBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const userId = session.userId;

      // Resolve the platform's client ONCE, then iterate. If env is
      // missing this 503s up front rather than per-item.
      const platform = parsed.data.platform;
      const deps =
        platform === "ios"
          ? { appleClient: resolveApple().client }
          : { googleClient: resolveGoogle().client };

      for (const item of parsed.data.purchases) {
        try {
          if (platform === "ios") {
            await syncSubscriptionFromIAP({}, {
              platform: "ios",
              receipt: item.receipt,
              userId,
              productId: item.productId,
              expectedAppAccountToken: deriveAppleToken(userId),
              context: "restore",
            }, deps);
          } else {
            await syncSubscriptionFromIAP({}, {
              platform: "android",
              receipt: item.receipt,
              userId,
              productId: item.productId,
              expectedObfuscatedAccountId: deriveGoogleToken(userId),
              context: "restore",
            }, deps);
          }
        } catch (e) {
          // Spec §5.3 restore: "Skip (log + continue) on individual failures".
          app.log.warn({ err: e, productId: item.productId }, "iap_restore_item_failed");
        }
      }
      return await buildMeBody(userId, meRuntimeEnv());
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/iap/restore" }, "iap_restore_failed");
      return reply.code(500).send({ error: "iap_restore_failed" });
    }
  });
}
