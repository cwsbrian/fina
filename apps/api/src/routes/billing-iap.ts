import type { FastifyInstance } from "fastify";
import type { $Enums } from "@prisma/client";
import {
  IAPCheckoutBody,
  IAPIntegrityCheckBody,
  IAPRestoreBody,
  ACTIVE_SUBSCRIPTION_STATUSES,
  tierForIapProductId,
} from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { requireAppleIapEnv, requireGoogleReceiptIapEnv } from "../iap/env-guard.js";
import { syncSubscriptionFromIAP } from "../iap/sync-sub.js";
import { deriveAppleToken, deriveGoogleToken } from "../iap/binding.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";
import { buildMeBody } from "./billing.js";
import { reconcilePlaidItemsForUser } from "../plaid/reconcile.js";
import { filterEnvironmentRows, pickPrimarySub } from "../billing/precedence.js";
import { maskBillingRecoveryEmail } from "../billing/recovery.js";
import {
  readNativeIapClient,
  recordIapIntegrityResult,
} from "../iap/integrity.js";

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
      requireGoogleReceiptIapEnv(process.env); // validate, discard result
      return { client: injected };
    }
    if (!cachedGoogle) {
      const cfg = requireGoogleReceiptIapEnv(process.env);
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

  function boundAccountEmailFromError(e: unknown): string | null {
    if (!(e instanceof HttpError)) return null;
    const value = e.details?.boundAccountEmailMasked;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  const findAppleBoundAccountEmail = async (
    originalTransactionId: string,
    appAccountToken: string | null | undefined,
    currentUserId: string,
  ): Promise<string | null> => {
    const sub = await prisma.subscription.findUnique({
      where: {
        source_sourceSubscriptionId: {
          source: "iap_apple",
          sourceSubscriptionId: originalTransactionId,
        },
      },
      select: { userId: true, user: { select: { email: true } } },
    });
    if (sub && sub.userId !== currentUserId) return maskBillingRecoveryEmail(sub.user.email);
    if (!appAccountToken) return null;
    const user = await prisma.user.findUnique({
      where: { iapAppleAccountToken: appAccountToken },
      select: { id: true, email: true },
    });
    return user && user.id !== currentUserId ? maskBillingRecoveryEmail(user.email) : null;
  };

  const findGoogleBoundAccountEmail = async (
    purchaseToken: string,
    linkedPurchaseToken: string | null | undefined,
    obfuscatedAccountId: string | null | undefined,
    currentUserId: string,
  ): Promise<string | null> => {
    const tokens = [purchaseToken, linkedPurchaseToken].filter(
      (token): token is string => typeof token === "string" && token.length > 0,
    );
    const sub = tokens.length
      ? await prisma.subscription.findFirst({
          where: { source: "iap_google", sourceSubscriptionId: { in: tokens } },
          select: { userId: true, user: { select: { email: true } } },
        })
      : null;
    if (sub && sub.userId !== currentUserId) return maskBillingRecoveryEmail(sub.user.email);
    if (!obfuscatedAccountId) return null;
    const user = await prisma.user.findUnique({
      where: { iapGoogleObfuscatedId: obfuscatedAccountId },
      select: { id: true, email: true },
    });
    return user && user.id !== currentUserId ? maskBillingRecoveryEmail(user.email) : null;
  };

  const authoritativeNativeState = async (
    platform: "ios" | "android",
    receipt: string | null | undefined,
    currentUserId: string,
  ): Promise<{
    tier: ReturnType<typeof tierForIapProductId> | null;
    boundAccountEmailMasked: string | null;
  } | null> => {
    if (!receipt) return null;
    if (platform === "ios") {
      const { client: appleClient } = resolveApple();
      const tx = await appleClient.verifyAndDecodeTransaction(receipt, { context: "restore" });
      const status = await appleClient.getSubscriptionStatus(tx.originalTransactionId);
      return {
        tier: tierForIapProductId(status.productId),
        boundAccountEmailMasked: await findAppleBoundAccountEmail(
          tx.originalTransactionId,
          tx.appAccountToken,
          currentUserId,
        ),
      };
    }

    const { client: googleClient } = resolveGoogle();
    const purchase = await googleClient.fetchAndNormalize(receipt);
    return {
      tier: tierForIapProductId(purchase.productId),
      boundAccountEmailMasked: await findGoogleBoundAccountEmail(
        receipt,
        purchase.linkedPurchaseToken,
        purchase.obfuscatedExternalAccountId,
        currentUserId,
      ),
    };
  };

  app.post("/billing/iap/checkout", async (req, reply) => {
    let userId: string | null = null;
    try {
      const session = await requireSession(req, app);
      userId = session.userId;
      const parsed = IAPCheckoutBody.safeParse(req.body);
      if (!parsed.success) {
        const body = req.body as { platform?: unknown; productId?: unknown; receipt?: unknown };
        app.log.warn(
          {
            route: "/billing/iap/checkout",
            platform: body?.platform,
            productId: body?.productId,
            receiptLength: typeof body?.receipt === "string" ? body.receipt.length : null,
            issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code })),
          },
          "iap_checkout_invalid_body",
        );
        return reply.code(400).send({ error: "invalid_body" });
      }

      const active = await prisma.subscription.findMany({
        where: {
          userId,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
        },
        select: { source: true },
      });
      const stripeActive = active.some((s) => s.source === "stripe");
      if (stripeActive) return reply.code(409).send({ error: "already_subscribed_stripe" });

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

      await prisma.user.update({
        where: { id: userId },
        data: { isPlanMismatch: false, planMismatchAccountEmailMasked: null },
      });
      await reconcilePlaidItemsForUser(app.fina.env, userId);
      return await buildMeBody(userId, meRuntimeEnv());
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.code === "user_mismatch" && userId) {
          await prisma.user
            .update({
              where: { id: userId },
              data: {
                isPlanMismatch: true,
                planMismatchAccountEmailMasked: boundAccountEmailFromError(e),
              },
            })
            .catch((err) => {
              app.log.error({ err, userId }, "iap_checkout_mark_mismatch_failed");
            });
        }
        app.log.warn(
          { err: e, route: "/billing/iap/checkout", code: e.code },
          "iap_checkout_rejected",
        );
        return reply.code(e.statusCode).send({ error: e.code });
      }
      app.log.error({ err: e, route: "/billing/iap/checkout" }, "iap_checkout_failed");
      return reply.code(500).send({ error: "iap_checkout_failed" });
    }
  });

  app.post("/billing/iap/restore", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPRestoreBody.safeParse(req.body);
      if (!parsed.success) {
        const body = req.body as {
          platform?: unknown;
          purchases?: Array<{ productId?: unknown; receipt?: unknown }>;
        };
        app.log.warn(
          {
            route: "/billing/iap/restore",
            platform: body?.platform,
            purchases: Array.isArray(body?.purchases)
              ? body.purchases.map((p) => ({
                  productId: p?.productId,
                  receiptLength: typeof p?.receipt === "string" ? p.receipt.length : null,
                }))
              : null,
            issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code })),
          },
          "iap_restore_invalid_body",
        );
        return reply.code(400).send({ error: "invalid_body" });
      }

      const userId = session.userId;

      // Resolve the platform's client ONCE, then iterate. If env is
      // missing this 503s up front rather than per-item.
      const platform = parsed.data.platform;
      const deps =
        platform === "ios"
          ? { appleClient: resolveApple().client }
          : { googleClient: resolveGoogle().client };

      let syncedAny = false;
      let firstRestoreError: unknown;
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
          syncedAny = true;
        } catch (e) {
          firstRestoreError ??= e;
          // Spec §5.3 restore: "Skip (log + continue) on individual failures".
          app.log.warn({ err: e, productId: item.productId }, "iap_restore_item_failed");
        }
      }
      if (!syncedAny) {
        if (firstRestoreError instanceof HttpError) throw firstRestoreError;
        throw new HttpError(400, "invalid_receipt", "No restorable purchases synced");
      }
      if (syncedAny) {
        await prisma.user.update({
          where: { id: userId },
          data: { isPlanMismatch: false, planMismatchAccountEmailMasked: null },
        });
        await reconcilePlaidItemsForUser(app.fina.env, userId);
      }
      return await buildMeBody(userId, meRuntimeEnv());
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.code === "user_mismatch") {
          const session = await requireSession(req, app).catch(() => null);
          if (session) {
            await prisma.user
              .update({
                where: { id: session.userId },
                data: {
                  isPlanMismatch: true,
                  planMismatchAccountEmailMasked: boundAccountEmailFromError(e),
                },
              })
              .catch((err) => {
                app.log.error({ err, userId: session.userId }, "iap_restore_mark_mismatch_failed");
              });
          }
        }
        app.log.warn(
          { err: e, route: "/billing/iap/restore", code: e.code },
          "iap_restore_rejected",
        );
        return reply.code(e.statusCode).send({ error: e.code });
      }
      app.log.error({ err: e, route: "/billing/iap/restore" }, "iap_restore_failed");
      return reply.code(500).send({ error: "iap_restore_failed" });
    }
  });

  app.post("/billing/iap/integrity-check", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPIntegrityCheckBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const client = readNativeIapClient(req);
      if (!client) return reply.code(400).send({ error: "missing_device" });
      if (client.platform !== parsed.data.platform) {
        return reply.code(400).send({ error: "platform_mismatch" });
      }

      const activeSubs = await prisma.subscription.findMany({
        where: {
          userId: session.userId,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
        },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const primary = pickPrimarySub(filterEnvironmentRows(activeSubs, meRuntimeEnv()));
      const clientNativeTier = parsed.data.nativeProductId
        ? tierForIapProductId(parsed.data.nativeProductId)
        : null;
      let verifiedNativeTier = clientNativeTier;
      let boundAccountEmailMasked: string | null = null;
      if (parsed.data.receipt) {
        try {
          const nativeState = await authoritativeNativeState(
            parsed.data.platform,
            parsed.data.receipt,
            session.userId,
          );
          verifiedNativeTier = nativeState?.tier ?? clientNativeTier;
          boundAccountEmailMasked = nativeState?.boundAccountEmailMasked ?? null;
        } catch (e) {
          app.log.warn(
            {
              err: e,
              route: "/billing/iap/integrity-check",
              platform: parsed.data.platform,
              nativeProductId: parsed.data.nativeProductId,
            },
            "iap_integrity_receipt_verification_failed_using_client_product",
          );
        }
      }
      const result =
        primary && verifiedNativeTier && primary.tier === verifiedNativeTier
          ? "matched"
          : "mismatched";

      if (parsed.data.result !== result) {
        app.log.warn(
          {
            userId: session.userId,
            clientResult: parsed.data.result,
            serverResult: result,
            nativeProductId: parsed.data.nativeProductId,
            verifiedNativeTier,
            primaryTier: primary?.tier ?? null,
          },
          "iap_integrity_result_corrected",
        );
      }

      await recordIapIntegrityResult({
        userId: session.userId,
        client,
        result,
        primary,
        boundAccountEmailMasked,
      });
      return await buildMeBody(session.userId, meRuntimeEnv(), client.platform);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/iap/integrity-check" }, "iap_integrity_failed");
      return reply.code(500).send({ error: "iap_integrity_failed" });
    }
  });
}
