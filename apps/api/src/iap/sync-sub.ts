import { prisma } from "../db.js";
import { HttpError } from "../auth/context.js";
import { ACTIVE_SUBSCRIPTION_STATUSES, tierForIapProductId } from "@fina/shared";
import type { AppleClient } from "./apple-client.js";
import type { GoogleClient } from "./google-client.js";
import type { IapConfig } from "./env-guard.js";

export type SyncArgsApple = {
  platform: "ios";
  receipt: string;
  userId: string;
  productId?: string;
  expectedAppAccountToken?: string;
  context?: "checkout" | "restore" | "assn";
};

export type SyncArgsGoogle = {
  platform: "android";
  receipt: string;
  userId: string;
  productId?: string;
  expectedObfuscatedAccountId?: string;
  context?: "checkout" | "restore" | "rtdn";
};

export type SyncArgs = SyncArgsApple | SyncArgsGoogle;

/** Per-platform deps. syncApple needs only appleClient; syncGoogle
 *  needs only googleClient. We accept either alone or both — callers
 *  that already know the platform (most routes) construct a stub for
 *  the opposite side, but typing both as optional lets a Google-only
 *  setup (no Apple env at all) call this without bogus Apple stubs. */
export type SyncDeps = {
  appleClient?: Pick<AppleClient, "verifyAndDecodeTransaction" | "getSubscriptionStatus">;
  googleClient?: Pick<GoogleClient, "fetchAndNormalize" | "acknowledgeIfPending">;
};

/** Partial IapConfig — neither half is dereferenced inside sync*,
 *  so a route that has only one platform's env validated can call
 *  this with just that half. Kept as `Partial<IapConfig>` instead of
 *  removing the param so the existing tests/webhook call sites that
 *  pass the full config keep working. */
export async function syncSubscriptionFromIAP(
  cfg: Partial<IapConfig>,
  args: SyncArgs,
  deps: SyncDeps,
): Promise<void> {
  if (args.platform === "ios") return syncApple(cfg, args, deps);
  return syncGoogle(cfg, args, deps);
}

const ACTIVE_IAP_STATUSES = new Set<string>(ACTIVE_SUBSCRIPTION_STATUSES);

function consumeTrialForActiveIapStatus(
  status: string,
): { trialEndsAt: Date; trialConsumed: true } | {} {
  if (!ACTIVE_IAP_STATUSES.has(status)) return {};
  return { trialEndsAt: new Date(), trialConsumed: true };
}

function fallbackAppleStatusFromTransaction(verified: {
  productId: string;
  raw: Record<string, unknown>;
}): {
  expiresDate: Date;
  productId: string;
  pendingProductId: string | null;
  pendingAt: Date | null;
  mapped: { status: "active" | "canceled"; cancelAtPeriodEnd: boolean };
} {
  const expiresMs = Number(verified.raw.expiresDate ?? 0);
  const expiresDate = new Date(expiresMs);
  const revoked = Number(verified.raw.revocationDate ?? 0) > 0;
  const active = Number.isFinite(expiresMs) && expiresMs > Date.now() && !revoked;
  return {
    expiresDate,
    productId: verified.productId,
    pendingProductId: null,
    pendingAt: null,
    mapped: { status: active ? "active" : "canceled", cancelAtPeriodEnd: false },
  };
}

function hasExplicitAppleExpiresDate(raw: Record<string, unknown>): boolean {
  const expiresMs = Number(raw.expiresDate ?? 0);
  return Number.isFinite(expiresMs) && expiresMs > 0;
}

function logAppleSyncDebug(event: string, payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") return;
  console.info(`[iap.apple.sync] ${event}`, JSON.stringify(payload));
}

async function syncApple(
  _cfg: Partial<IapConfig>,
  args: SyncArgsApple,
  deps: SyncDeps,
): Promise<void> {
  const context =
    args.context === "assn" ? "assn" : args.context === "restore" ? "restore" : "checkout";
  const verified = await deps.appleClient!.verifyAndDecodeTransaction(args.receipt, { context });

  const isRestore = context === "restore";
  const appAccountTokenMismatch = Boolean(
    args.expectedAppAccountToken &&
    verified.appAccountToken &&
    args.expectedAppAccountToken !== verified.appAccountToken,
  );
  const verifiedTier = tierForIapProductId(verified.productId);
  if (!verifiedTier)
    throw new HttpError(400, "product_mismatch", `unknown productId ${verified.productId}`);
  let status: Awaited<ReturnType<NonNullable<SyncDeps["appleClient"]>["getSubscriptionStatus"]>>;
  try {
    status = await deps.appleClient!.getSubscriptionStatus(verified.originalTransactionId);
  } catch (e) {
    if (e instanceof HttpError && e.code === "platform_unavailable") {
      status = fallbackAppleStatusFromTransaction(verified);
    } else {
      throw e;
    }
  }
  const transactionStatus = fallbackAppleStatusFromTransaction(verified);
  const checkoutTransactionMatchesRequest =
    !args.productId || args.productId === verified.productId;
  logAppleSyncDebug("status_candidates", {
    context,
    requestedProductId: args.productId ?? null,
    verifiedProductId: verified.productId,
    transactionId: verified.transactionId,
    originalTransactionId: verified.originalTransactionId,
    transactionExpiresDate: transactionStatus.expiresDate.toISOString(),
    transactionStatus: transactionStatus.mapped.status,
    ascProductId: status.productId,
    ascExpiresDate: status.expiresDate.toISOString(),
    ascStatus: status.mapped.status,
    ascPendingProductId: status.pendingProductId,
    checkoutTransactionMatchesRequest,
  });
  if (
    context === "checkout" &&
    checkoutTransactionMatchesRequest &&
    hasExplicitAppleExpiresDate(verified.raw) &&
    !ACTIVE_IAP_STATUSES.has(transactionStatus.mapped.status)
  ) {
    throw new HttpError(400, "expired_receipt", "checkout transaction is not active");
  }
  if (
    context === "checkout" &&
    checkoutTransactionMatchesRequest &&
    ACTIVE_IAP_STATUSES.has(transactionStatus.mapped.status) &&
    (!ACTIVE_IAP_STATUSES.has(status.mapped.status) || status.productId !== verified.productId)
  ) {
    status = transactionStatus;
  }
  logAppleSyncDebug("status_selected", {
    context,
    selectedProductId: status.productId,
    selectedStatus: status.mapped.status,
    selectedExpiresDate: status.expiresDate.toISOString(),
    selectedPendingProductId: status.pendingProductId,
  });
  const allowUnboundNativeRestore = isRestore && !verified.appAccountToken;
  // Restore/already-owned paths can hand us an older transaction JWS. ASC is
  // the source of truth for the subscription group's current product.
  const tier = tierForIapProductId(status.productId);
  if (!tier) throw new HttpError(400, "product_mismatch", `unknown productId ${status.productId}`);
  const pendingTier = status.pendingProductId ? tierForIapProductId(status.pendingProductId) : null;
  const pendingTierAt = pendingTier ? (status.pendingAt ?? status.expiresDate) : null;

  await prisma.$transaction(async (tx) => {
    if (appAccountTokenMismatch && verified.appAccountToken) {
      const boundUser = await tx.user.findUnique({
        where: { iapAppleAccountToken: verified.appAccountToken },
        select: { id: true },
      });
      if (boundUser && boundUser.id !== args.userId) {
        throw new HttpError(403, "user_mismatch", "appAccountToken belongs to another user");
      }
    }
    const existingSub = await tx.subscription.findUnique({
      where: {
        source_sourceSubscriptionId: {
          source: "iap_apple",
          sourceSubscriptionId: verified.originalTransactionId,
        },
      },
      select: { userId: true },
    });
    if (existingSub && existingSub.userId !== args.userId) {
      throw new HttpError(403, "user_mismatch", "subscription belongs to another user");
    }
    const sameUserExistingSubscription = Boolean(existingSub && existingSub.userId === args.userId);
    if (
      args.expectedAppAccountToken &&
      args.expectedAppAccountToken !== verified.appAccountToken &&
      !allowUnboundNativeRestore &&
      !isRestore &&
      !sameUserExistingSubscription
    ) {
      if (!ACTIVE_IAP_STATUSES.has(status.mapped.status)) {
        throw new HttpError(400, "expired_receipt", "inactive transaction appAccountToken mismatch");
      }
      throw new HttpError(403, "user_mismatch", "appAccountToken mismatch");
    }
    await tx.subscription.upsert({
      where: {
        source_sourceSubscriptionId: {
          source: "iap_apple",
          sourceSubscriptionId: verified.originalTransactionId,
        },
      },
      create: {
        userId: args.userId,
        tier,
        source: "iap_apple",
        sourceSubscriptionId: verified.originalTransactionId,
        sourceCustomerId: verified.appAccountToken,
        status: status.mapped.status,
        currentPeriodEnd: status.expiresDate,
        cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
        billingPeriod: "monthly",
        pendingTier,
        pendingTierAt,
        environment: verified.environment,
      },
      update: {
        tier,
        ...(verified.appAccountToken ? { sourceCustomerId: verified.appAccountToken } : {}),
        status: status.mapped.status,
        currentPeriodEnd: status.expiresDate,
        cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
        pendingTier,
        pendingTierAt,
        environment: verified.environment,
      },
    });
    const userData: {
      iapAppleAccountToken?: string;
      trialEndsAt?: Date;
      trialConsumed?: true;
    } = {
      ...consumeTrialForActiveIapStatus(status.mapped.status),
    };
    if (verified.appAccountToken) userData.iapAppleAccountToken = verified.appAccountToken;
    await tx.user.updateMany({
      where: { id: args.userId },
      data: userData,
    });
  });
}

async function syncGoogle(
  _cfg: Partial<IapConfig>,
  args: SyncArgsGoogle,
  deps: SyncDeps,
): Promise<void> {
  const v2 = await deps.googleClient!.fetchAndNormalize(args.receipt);

  if (
    args.expectedObfuscatedAccountId &&
    args.expectedObfuscatedAccountId !== v2.obfuscatedExternalAccountId
  ) {
    throw new HttpError(403, "user_mismatch", "obfuscatedExternalAccountId mismatch");
  }

  const tier = tierForIapProductId(v2.productId);
  if (!tier) throw new HttpError(400, "product_mismatch", `unknown productId ${v2.productId}`);
  const pendingTier = v2.pendingProductId ? tierForIapProductId(v2.pendingProductId) : null;
  const pendingTierAt = pendingTier ? (v2.pendingAt ?? v2.expiryTime) : null;

  await prisma.$transaction(async (tx) => {
    if (v2.linkedPurchaseToken) {
      const updated = await tx.subscription.updateMany({
        where: { source: "iap_google", sourceSubscriptionId: v2.linkedPurchaseToken },
        data: {
          sourceSubscriptionId: args.receipt,
          tier,
          status: v2.mapped.status,
          currentPeriodEnd: v2.expiryTime,
          cancelAtPeriodEnd: v2.mapped.cancelAtPeriodEnd,
          pendingTier,
          pendingTierAt,
          environment: v2.environment,
        },
      });
      if (updated.count > 0) {
        await tx.user.updateMany({
          where: { id: args.userId },
          data: {
            iapGoogleObfuscatedId: v2.obfuscatedExternalAccountId,
            ...consumeTrialForActiveIapStatus(v2.mapped.status),
          },
        });
        return;
      }
    }
    await tx.subscription.upsert({
      where: {
        source_sourceSubscriptionId: {
          source: "iap_google",
          sourceSubscriptionId: args.receipt,
        },
      },
      create: {
        userId: args.userId,
        tier,
        source: "iap_google",
        sourceSubscriptionId: args.receipt,
        sourceCustomerId: v2.obfuscatedExternalAccountId,
        status: v2.mapped.status,
        currentPeriodEnd: v2.expiryTime,
        cancelAtPeriodEnd: v2.mapped.cancelAtPeriodEnd,
        billingPeriod: "monthly",
        pendingTier,
        pendingTierAt,
        environment: v2.environment,
      },
      update: {
        tier,
        status: v2.mapped.status,
        currentPeriodEnd: v2.expiryTime,
        cancelAtPeriodEnd: v2.mapped.cancelAtPeriodEnd,
        pendingTier,
        pendingTierAt,
        environment: v2.environment,
      },
    });
    await tx.user.updateMany({
      where: { id: args.userId },
      data: {
        iapGoogleObfuscatedId: v2.obfuscatedExternalAccountId,
        ...consumeTrialForActiveIapStatus(v2.mapped.status),
      },
    });
  });

  // AFTER upsert lands. Pass already-fetched state.
  await deps.googleClient!.acknowledgeIfPending({
    purchaseToken: args.receipt,
    productId: v2.productId,
    acknowledgementState: v2.acknowledgementState,
  });
}
