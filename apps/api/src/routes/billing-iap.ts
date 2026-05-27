import type { FastifyInstance } from "fastify";
import type { $Enums } from "@prisma/client";
import { IAPCheckoutBody, IAPRestoreBody, ACTIVE_SUBSCRIPTION_STATUSES } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { requireIapEnv } from "../iap/env-guard.js";
import { syncSubscriptionFromIAP } from "../iap/sync-sub.js";
import { deriveAppleToken, deriveGoogleToken } from "../iap/binding.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";
import { buildMeBody } from "./billing.js";

export async function billingIapRoutes(app: FastifyInstance): Promise<void> {
  // Memoized production cache. Only used when the test-injection seam
  // is absent. We cache (cfg + clients) together so we don't re-parse
  // env or rebuild the SignedDataVerifier per request.
  let cached: {
    cfg: ReturnType<typeof requireIapEnv>;
    appleClient: AppleClient;
    googleClient: GoogleClient;
  } | null = null;

  const resolveCtx = (): {
    cfg: ReturnType<typeof requireIapEnv>;
    appleClient: AppleClient;
    googleClient: GoogleClient;
  } => {
    const injected = (app as any).fina?.iap as
      | { appleClient: AppleClient; googleClient: GoogleClient }
      | undefined;
    // Tests bypass the cache so each test can swap mocks freely.
    if (injected) {
      const cfg = requireIapEnv(process.env);
      return { cfg, appleClient: injected.appleClient, googleClient: injected.googleClient };
    }
    if (!cached) {
      const cfg = requireIapEnv(process.env);
      cached = {
        cfg,
        appleClient: new AppleClient(cfg.apple),
        googleClient: new GoogleClient(cfg.google),
      };
    }
    return cached;
  };

  app.post("/billing/iap/checkout", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPCheckoutBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const { cfg, appleClient, googleClient } = resolveCtx();
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
        await syncSubscriptionFromIAP(cfg, {
          platform: "ios",
          receipt: parsed.data.receipt,
          userId,
          productId: parsed.data.productId,
          expectedAppAccountToken: deriveAppleToken(userId),
          context: "checkout",
        }, { appleClient, googleClient });
      } else {
        await syncSubscriptionFromIAP(cfg, {
          platform: "android",
          receipt: parsed.data.receipt,
          userId,
          productId: parsed.data.productId,
          expectedObfuscatedAccountId: deriveGoogleToken(userId),
          context: "checkout",
        }, { appleClient, googleClient });
      }

      return await buildMeBody(userId, cfg.apple.env);
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

      const { cfg, appleClient, googleClient } = resolveCtx();
      const userId = session.userId;

      for (const item of parsed.data.purchases) {
        try {
          if (parsed.data.platform === "ios") {
            await syncSubscriptionFromIAP(cfg, {
              platform: "ios",
              receipt: item.receipt,
              userId,
              productId: item.productId,
              expectedAppAccountToken: deriveAppleToken(userId),
              context: "restore",
            }, { appleClient, googleClient });
          } else {
            await syncSubscriptionFromIAP(cfg, {
              platform: "android",
              receipt: item.receipt,
              userId,
              productId: item.productId,
              expectedObfuscatedAccountId: deriveGoogleToken(userId),
              context: "restore",
            }, { appleClient, googleClient });
          }
        } catch (e) {
          // Spec §5.3 restore: "Skip (log + continue) on individual failures".
          app.log.warn({ err: e, productId: item.productId }, "iap_restore_item_failed");
        }
      }
      return await buildMeBody(userId, cfg.apple.env);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/iap/restore" }, "iap_restore_failed");
      return reply.code(500).send({ error: "iap_restore_failed" });
    }
  });
}
